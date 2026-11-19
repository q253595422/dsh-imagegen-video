/**
 * 分镜体检：把「这一镜发出去会出问题」变成一串可数的问题，而不是等成片
 * 出来才发现。
 *
 * 为什么要这一层：分镜板能拦住的两类错完全不是一类。
 *  - `shotProblem` 管「发不出去」（空提示词、时长非法），它拦得住；
 *  - 剩下的错会**正常提交、正常出片**，只是片子和用户以为的不一样——
 *    参考图没随行、分段加起来比镜长还长、同一秒里既要固定机位又要推镜头。
 *    这类错没有任何报错，只能靠回头看片发现，而那时已经付过钱了。
 *
 * 所以这里只做一件事：读已经存在的分镜数据，算出问题清单。不新增节点类
 * 型、不改持久化格式、不碰网络——整份文件是纯函数，能离线测。
 *
 * 分级只有两档，且**都不阻止运行**：
 *  - `block` 是「按现在的设置，这一镜一定拿不到你要的东西」（参考图没带上），
 *  - `warn` 是「大概率不对，但用户可能就是要这样」。
 * 不阻止是有意的：4.5 字/秒这类经验值会误伤，把好默认变成一堵墙比不提醒更糟。
 */

import type { CanvasNode, CanvasShot, CanvasStoryboard } from '../protocol.ts'
import type { ImageGenKey } from './locales.ts'
import { castMembers } from './cast.ts'
import { MAX_SHOT_REFERENCES, shotVideoPlan } from './storyboard.ts'

/**
 * 一条体检结论的类别。
 *
 * 用稳定的字符串而不是序号：反向用例按名字断言，序号会随规则增删漂移。
 */
export type StoryboardRule =
  /** 提示词点名了某个钉住的身份，但按这个板的模式，这一镜不会带它的图。 */
  | 'castMentionedButDropped'
  /** 钉住的身份比参考图名额多，排在后面的永远送不进去。 */
  | 'castOverflow'
  /** 两个钉住的身份同名，第二个会被去重丢掉，用户看不出来。 */
  | 'castDuplicate'
  /** 标秒分段加起来不等于镜长。 */
  | 'segmentTotal'
  /** 同一分段里既写了固定机位又写了移动运镜。 */
  | 'motionConflict'
  /** 分段之间有重叠，或没有从 0 秒开始。 */
  | 'segmentCoverage'

export interface StoryboardFinding {
  /** 0 基的镜序，用来把结论钉回具体那一行。 */
  shotIndex: number
  rule: StoryboardRule
  /**
   * `block` = 按现在的设置这一镜拿不到你要的东西；`warn` = 大概率不对。
   * 两档都只是提示，运行按钮不因此变灰。
   */
  level: 'block' | 'warn'
  /** 界面文案；参数由 {@link params} 填。 */
  key: ImageGenKey
  params?: Record<string, string | number>
}

/** 一段精确标秒的区间，单位秒。 */
export interface ShotSegment {
  start: number
  end: number
}

/**
 * 提示词里的精确标秒分段。
 *
 * 认两种写法，因为模型和人都这么写：
 *  - 方括号包起来的 `[0:03–0:06]` / `[00:03-00:06]`（他们那套文档的写法），
 *  - 裸写的 `0:03–0:06`（有人不习惯加括号）。
 *
 * 只认「起–止」成对的区间。单独一个时间点（「第 3 秒切」）无法判断它属于
 * 哪一段，硬猜出来的总时长只会让体检本身变成噪音。
 *
 * 分隔符认半角连字符、全角破折号、en dash 与波浪号——这四种在中英文稿子里
 * 都出现过，且都不会出现在 `3:05` 这种时刻里。
 *
 * 用**工厂**而不是共享的模块级常量：带 `g` 的正则是有状态的，`test()` 与
 * `exec()` 会移动它的 `lastIndex`，而 `matchAll()` 也从那里开始扫。一份共享
 * 常量下，`shotHasSegments` 里的一次 `test()` 成功就会把 `lastIndex` 留在末尾，
 * 紧接着的 `shotSegments` 就从头找不到任何分段——体检静默少报，且只在特定的
 * 调用顺序下出现。每次调用新建一个，这类跨调用状态就不存在了。
 */
const segmentPattern = (): RegExp => /(\d{1,3}):([0-5]\d)\s*[-–—~]\s*(\d{1,3}):([0-5]\d)/g

function toSeconds(minutes: string, seconds: string): number {
  return Number(minutes) * 60 + Number(seconds)
}

/**
 * 一镜里所有标秒区间，按出现顺序。
 *
 * 不排序、不去重：顺序和重复本身也是信息（用户可能写反了起止）。
 */
export function shotSegments(prompt: string): ShotSegment[] {
  const out: ShotSegment[] = []
  for (const match of prompt.matchAll(segmentPattern())) {
    out.push({ start: toSeconds(match[1]!, match[2]!), end: toSeconds(match[3]!, match[4]!) })
  }
  return out
}

/** 固定机位的说法。都是「这一镜不动机位」的同义表述。 */
const STATIC_CAMERA = ['固定机位', '机位固定', '固定镜头', '镜头固定', '静止镜头', '机位不动', '不动机位']

/**
 * 移动运镜的说法。
 *
 * 单字「推」「拉」「摇」「移」不列：它们几乎在每个句子里都出现（推门、拉
 * 开、摇头），拿它们当信号会把九成的镜头标成冲突。只认成词的说法。
 */
const MOVING_CAMERA = [
  '推近', '推进', '推镜', '拉远', '拉出', '拉开镜头', '摇镜', '摇过', '横移', '平移',
  '跟拍', '跟随镜头', '升镜', '降镜', '环绕', '绕拍', '手持', '变焦', '甩镜', '升降镜头',
]

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some(word => text.includes(word))
}

/**
 * 一段文字里的机位指令是否自相矛盾。
 *
 * 只在一段**内部**判：整镜先写「固定机位」再写「然后推近」是合法的（那是
 * 先后两段），同一段里同时出现才是真的矛盾。
 */
export function motionConflict(text: string): boolean {
  return hasAny(text, STATIC_CAMERA) && hasAny(text, MOVING_CAMERA)
}

/**
 * 把提示词切成「有标秒的段」与「段外的整体描述」。
 *
 * 段外文字不参与静动冲突判定：那通常是整镜的总述（「固定机位，缓慢推进」
 * 这类本来就是病句，但把它算进每一段会重复报错），体检只按用户自己划的
 * 段来判。
 */
function segmentsWithText(prompt: string): { segment: ShotSegment; text: string }[] {
  const out: { segment: ShotSegment; text: string }[] = []
  const matches = [...prompt.matchAll(segmentPattern())]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? prompt.length) : prompt.length
    out.push({
      segment: { start: toSeconds(match[1]!, match[2]!), end: toSeconds(match[3]!, match[4]!) },
      text: prompt.slice(start, end),
    })
  }
  return out
}

/**
 * 提示词里点到了某个钉住身份没有。
 *
 * 只认长度 ≥ 2 的名字：单字名字（「禾」「她」）在中文里到处都是，拿它做
 * 子串匹配会把每一镜都标成「提到了她」。宁可漏报一条，不要满屏假警报——
 * 一份总在喊狼来了的体检，用户三天就学会无视。
 */
export function mentionsName(prompt: string, name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2) return false
  return prompt.includes(trimmed)
}

/**
 * 一块分镜板的全部体检结论。
 *
 * 顺序是「先按镜序、再按严重度」：用户是竖着读镜头的，先看到第 1 镜的
 * block，比先看到全板所有 block 再回头找是哪一镜有用。
 */
export function storyboardFindings(
  board: CanvasStoryboard,
  nodes: readonly CanvasNode[],
): StoryboardFinding[] {
  const findings: StoryboardFinding[] = []
  const members = castMembers(nodes)
  const castCount = members.length

  // ---------------------------------------------------------- 全板级参考图问题
  //
  // 这两条不属于某一镜，但必须挂在某一镜上才点得动，所以挂第 1 镜：
  // 「你的第 5 个参考图永远送不进去」在整块板上的表现就是每一镜都少带一个，
  // 挂第一镜是让用户有地方点。

  if (castCount > MAX_SHOT_REFERENCES) {
    findings.push({
      shotIndex: 0,
      rule: 'castOverflow',
      level: 'warn',
      key: 'canvas.storyboard.lintCastOverflow',
      params: { count: castCount, max: MAX_SHOT_REFERENCES, dropped: castCount - MAX_SHOT_REFERENCES },
    })
  }

  // 同名去重发生在 cast.ts；这里只负责把「你钉了两个同名的人，第二个被丢了」
  // 说出来。不报的话，用户会以为两个人都在参考图里。
  const namesSeen = new Set<string>()
  const duplicated: string[] = []
  for (const member of members) {
    if (member.name === '') continue
    if (namesSeen.has(member.name)) {
      if (!duplicated.includes(member.name)) duplicated.push(member.name)
      continue
    }
    namesSeen.add(member.name)
  }
  if (duplicated.length > 0) {
    findings.push({
      shotIndex: 0,
      rule: 'castDuplicate',
      level: 'warn',
      key: 'canvas.storyboard.lintCastDuplicate',
      params: { names: duplicated.join('、') },
    })
  }

  // ---------------------------------------------------------------- 逐镜
  for (let index = 0; index < board.shots.length; index += 1) {
    const shot = board.shots[index]!
    const prompt = shot.prompt
    if (prompt.trim() === '') continue
    const plan = shotVideoPlan({ continuity: board.continuity, index, castCount })
    const seconds = Number.isFinite(shot.seconds) ? shot.seconds : 0

    // 参考图没随行，但提示词点名了它。
    //
    // 这是 `shotsWithoutCast` 的精确版：那个函数只能告诉你「这一镜丢参考图」，
    // 说不出「而且你这一镜真的写了她的名字」。`carry` 板上第 2 镜起全都丢，
    // 但只有真的提到「阿禾」的那几镜才是问题——其余镜本来就没她。
    if (plan.castSlots === 0) {
      const mentioned = members.filter(member => mentionsName(prompt, member.name))
      if (mentioned.length > 0) {
        findings.push({
          shotIndex: index,
          rule: 'castMentionedButDropped',
          level: 'block',
          key: 'canvas.storyboard.lintCastDropped',
          params: { names: mentioned.map(member => member.name).join('、') },
        })
      }
    }

    // ---------------------------------------------------------- 标秒分段
    const segments = shotSegments(prompt)
    if (segments.length === 0) continue

    const outOfOrder = segments.some(segment => segment.end <= segment.start)
    const startsAtZero = segments[0]!.start === 0
    const previousEnd = segments.reduce((furthest, segment) => Math.max(furthest, segment.end), 0)
    // 重叠按「合并覆盖区间」算，与他们的 VID-04 同一口径：两段都覆盖 2–3 秒
    // 不该被算成 2 秒的内容。
    const covered = mergeSegments(segments)

    if (outOfOrder) {
      findings.push({ shotIndex: index, rule: 'segmentCoverage', level: 'warn', key: 'canvas.storyboard.lintSegmentOrder' })
    } else if (!startsAtZero) {
      findings.push({ shotIndex: index, rule: 'segmentCoverage', level: 'warn', key: 'canvas.storyboard.lintSegmentStart' })
    } else if (previousEnd > seconds + 1e-9) {
      findings.push({
        shotIndex: index,
        rule: 'segmentTotal',
        level: 'warn',
        key: 'canvas.storyboard.lintSegmentOver',
        params: { covered: trimSeconds(covered), seconds: trimSeconds(seconds) },
      })
    } else if (covered < seconds - 1e-9) {
      // 短了不算错，但要说：空出来的几秒会被模型自己填，通常填成拖沓。
      findings.push({
        shotIndex: index,
        rule: 'segmentTotal',
        level: 'warn',
        key: 'canvas.storyboard.lintSegmentUnder',
        params: { covered: trimSeconds(covered), seconds: trimSeconds(seconds), left: trimSeconds(seconds - covered) },
      })
    }

    // 同一段里静动冲突。
    const conflicting = segmentsWithText(prompt).filter(part => motionConflict(part.text))
    if (conflicting.length > 0) {
      findings.push({
        shotIndex: index,
        rule: 'motionConflict',
        level: 'warn',
        key: 'canvas.storyboard.lintMotionConflict',
        params: { count: conflicting.length },
      })
    }
  }

  const levelRank = (level: StoryboardFinding['level']): number => (level === 'block' ? 0 : 1)
  return findings.sort((left, right) => left.shotIndex - right.shotIndex || levelRank(left.level) - levelRank(right.level))
}

/**
 * 合并重叠区间后的总覆盖秒数。
 *
 * 起止写成 [start, end) 的语义：0–3 与 3–6 首尾相接**不算**重叠，覆盖 6 秒。
 * 端点的 1e-9 容差是给 `12.000000001` 这类浮点尾数留的。
 */
export function mergeSegments(segments: readonly ShotSegment[]): number {
  if (segments.length === 0) return 0
  const sorted = [...segments].sort((left, right) => left.start - right.start)
  let total = 0
  let currentStart = sorted[0]!.start
  let currentEnd = sorted[0]!.end
  for (const segment of sorted.slice(1)) {
    if (segment.start <= currentEnd + 1e-9) {
      currentEnd = Math.max(currentEnd, segment.end)
    } else {
      total += currentEnd - currentStart
      currentStart = segment.start
      currentEnd = segment.end
    }
  }
  return total + (currentEnd - currentStart)
}

/** 秒数显示：整数不带小数点，其余保留一位。 */
function trimSeconds(value: number): number {
  return Math.round(value * 10) / 10
}

/** 一镜自己的问题，已按严重度排好；板按镜序渲染时直接取。 */
export function findingsByShot(findings: readonly StoryboardFinding[], index: number): StoryboardFinding[] {
  return findings.filter(finding => finding.shotIndex === index)
}

/** 一块板上最重的级别；没问题时是 `undefined`。 */
export function worstLevel(findings: readonly StoryboardFinding[]): 'block' | 'warn' | undefined {
  if (findings.some(finding => finding.level === 'block')) return 'block'
  if (findings.length > 0) return 'warn'
  return undefined
}

/** 一块板上有问题的镜数（不重复计数全板级问题）。 */
export function shotsWithFindings(findings: readonly StoryboardFinding[]): number {
  return new Set(findings.map(finding => finding.shotIndex)).size
}

/**
 * 一镜的提示词有没有写精确标秒。
 *
 * 给界面上的「按秒分段」提示用：一块板里有的镜写了、有的没写，比全都没写
 * 更值得说一句——那是同一块板里两套写法混在一起。
 */
export function shotHasSegments(shot: CanvasShot): boolean {
  return segmentPattern().test(shot.prompt)
}

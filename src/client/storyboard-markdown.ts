/**
 * 把 oh-story 风格的短剧文档读成画布分镜，纯函数。
 *
 * 为什么单独一个模块：这是唯一一处「别人的文档格式」与「我们的分镜模型」
 * 相遇的地方。格式是别人的（`分镜.md` / `图片提示词.md` / `视频提示词.md`
 * 三份 Markdown，全角标点、中点、中文分号都是格式的一部分），而分镜模型
 * 是我们的（`CanvasStoryboard`）。放在 UI 里会让「哪个字段没读出来」变成
 * 一个渲染问题；独立成纯函数的解析器，就能用真实样例文档在 smoke 里跑。
 *
 * 三条边界，都是刻意的：
 *
 *  - **只读。** 不回写文档、不改用户项目里的任何字节。解析失败时返回警告
 *    而不是抛错，因为一份文档里十个镜头坏掉一个，另外九个仍然值得铺。
 *  - **不猜。** 缺字段就是缺，写进 `warnings` 交给界面显示。唯一允许的
 *    补全是时长：文档写 `3s`，而视频模型只认 4 秒起，这里取最近的合法值
 *    并明确报告「3s → 4s」，不静默改。
 *  - **不认「大概像」。** 条目头必须是 `## SHOT-…`，必须用全角冒号 `- 时长：`。
 *    宽松匹配会让一份写坏的文档铺出一块看似正常、实则错位的板子，用户要
 *    到生成之后才发现错的是第几镜。
 */

import { SHOT_SECONDS } from './storyboard.ts'
/** 一条 `输入参考图` 里的图位。 */
export interface ParsedReference {
  /**
   * 槽位编号，如 `REF-XUTANG-LOOK` / `PLAN-SHOT-EP001-002`。
   *
   * 两种前缀都出现：`REF-` 是磁盘上真有图，`PLAN-` 是给外部工具预留的
   * 图位。铺板时两者的处理不同——前者能导入成图片节点，后者只能留一条
   * 提示，所以它必须原样留住，不能只记路径。
   */
  slot: string
  /** `（顺序：n）` 里的 n；文档没写时按出现顺序补 1 起。 */
  order: number
  /** 项目相对路径。`PLAN-` 槽位指向 `IMG-…` 时这里可能为空。 */
  path: string
  /** 《…》里的名称。 */
  name: string
  /** `用途：` 的取值，十项固定枚举之一。 */
  purpose: string
  control: string
  notControl: string
}

/** `出场设定` 里的一项。 */
export interface ParsedCastEntry {
  /** `人物` / `造型` / `地点` / `道具`。 */
  kind: string
  /** 「…」里的名称。 */
  name: string
  control: string
  /** 这一项写在 `；画外：` 之后——点了名但本镜不入画。 */
  offscreen: boolean
}

/** 解析出来的一镜。 */
export interface ParsedShot {
  /** `SHOT-EP001-002` 原文，跨文档对应关系的钥匙。 */
  shotId: string
  name: string
  source: string
  /** 文档写的秒数，逐字保留（`3`，不是取整后的值）。 */
  seconds: number
  purpose: string
  framing: string
  movement: string
  from: string
  action: string
  to: string
  screenText: string
  sound: string
  /** `图片提示词项` 里点到的 `IMG-…` 编号。 */
  imagePromptIds: string[]
  references: ParsedReference[]
  cast: ParsedCastEntry[]
  /** `### 首帧提示词` 的引用块正文，空串表示没有。 */
  firstFrame: string
  /** `### 尾帧提示词` 的引用块正文，空串表示没有。 */
  lastFrame: string
}

/** 一份 `分镜.md` 的解析结果。 */
export interface ParsedStoryboard {
  /** 文档一级标题，如 `EP001 分镜`；没有时为默认标题。 */
  title: string
  shots: ParsedShot[]
  /** 读到了但没用上的东西：坏条目、缺字段、被跳过的段落。 */
  warnings: string[]
}

/** 一条 `IMG-…` 图片提示词。 */
export interface ParsedImagePrompt {
  /** `IMG-JIANGCHEN-SHEET`，跨文档对应关系的钥匙。 */
  imageId: string
  name: string
  usage: string
  reference: string
  /** `### 可复制提示词` 的引用块正文。 */
  prompt: string
}

/** 一份 `图片提示词.md` 的解析结果。 */
export interface ParsedImagePrompts {
  title: string
  items: ParsedImagePrompt[]
  warnings: string[]
}

/** 一条 `MOTION-…` 视频提示词。 */
export interface ParsedMotionPrompt {
  motionId: string
  name: string
  /** `- 分镜：SHOT-EP001-001`，把它接回分镜的那一条。 */
  shotId: string
  seconds: number
  /** `- 生成方式：` 的原文（`图生视频` / `文生视频`）。 */
  mode: string
  /** `### 可复制提示词` 的引用块正文。 */
  prompt: string
}

/** 一份 `视频提示词.md` 的解析结果。 */
export interface ParsedMotionPrompts {
  title: string
  items: ParsedMotionPrompt[]
  warnings: string[]
}

/** 全角冒号。文档格式的一部分，不用半角。 */
const COLON = '：'

/**
 * 按行切开并去掉行尾 `\r`。
 *
 * 文档由 Agent 写、可能跨平台编辑过，CRLF 混进 Markdown 会让每条 `^## `
 * 判断都落空，而症状是「一条镜头都没读到」——最难定位的那种。
 */
function lines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
}

/** `## SHOT-EP001-002 · 攥紧的茶杯` → 编号与名称；不是镜头条目时 undefined。 */
export function shotHeadingOf(line: string): { shotId: string, name: string } | undefined {
  const match = /^##[ \t]+(SHOT-[A-Z0-9-]+)[ \t]*·[ \t]*(.*)$/.exec(line)
  if (match !== null) return { shotId: match[1]!, name: match[2]!.trim() }
  // 没有 `· 名称` 的条目头也认——名称是给人看的，编号才是钥匙。
  const bare = /^##[ \t]+(SHOT-[A-Z0-9-]+)[ \t]*$/.exec(line)
  return bare === null ? undefined : { shotId: bare[1]!, name: '' }
}

/** `## IMG-A-B · 名称` → 编号与名称。 */
export function imageHeadingOf(line: string): { imageId: string, name: string } | undefined {
  const match = /^##[ \t]+(IMG-[A-Z0-9-]+)[ \t]*·[ \t]*(.*)$/.exec(line)
  if (match !== null) return { imageId: match[1]!, name: match[2]!.trim() }
  const bare = /^##[ \t]+(IMG-[A-Z0-9-]+)[ \t]*$/.exec(line)
  return bare === null ? undefined : { imageId: bare[1]!, name: '' }
}

/** `## MOTION-A-B · 名称` → 编号与名称。 */
export function motionHeadingOf(line: string): { motionId: string, name: string } | undefined {
  const match = /^##[ \t]+(MOTION-[A-Z0-9-]+)[ \t]*·[ \t]*(.*)$/.exec(line)
  if (match !== null) return { motionId: match[1]!, name: match[2]!.trim() }
  const bare = /^##[ \t]+(MOTION-[A-Z0-9-]+)[ \t]*$/.exec(line)
  return bare === null ? undefined : { motionId: bare[1]!, name: '' }
}

/**
 * `- 时长：3s` → 3。
 *
 * 也认 `3 秒`、`3秒`、`3.5s`，但只返回有限正数；文档写了个看不懂的值时
 * 返回 undefined，让调用方去报，而不是当成 0 秒铺进板子。
 */
export function secondsOf(text: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)[ \t]*(?:s|秒|sec|secs|second|seconds)?/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 文档写的秒数落到分镜选择器的合法值上——**只用于给用户看的提示**，不改文档原值。
 *
 * WHY 不改：`submitShot` 把 `shot.seconds` 原样发给提供方
 * （`CanvasWorkspace.tsx:4227`），而选择器只提供 `SHOT_SECONDS`。也就是说
 * 2s / 3s 这类值「界面选不出来、但确实能发出去」。文档按剪辑节奏写 2 秒，
 * 那是导演的决定；把它静默改成 4 秒会让每一镜都变长，成片节奏全错。所以
 * 这里只算出「如果要在这个界面上重新选，最接近的是哪个」交给界面提示。
 *
 * 恰好等于某个合法值时不改；两个合法值一样近时取小的。
 */
export function nearestShotSeconds(seconds: number, allowed: readonly number[] = SHOT_SECONDS): number {
  const pool = allowed.length === 0 ? [...SHOT_SECONDS] : allowed
  let best = pool[0]!
  let bestDistance = Math.abs(best - seconds)
  for (const candidate of pool) {
    const distance = Math.abs(candidate - seconds)
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * 一条 `出场设定` 拆成若干项。
 *
 * 输入：`《视觉设定.md》·人物「周薄森」（控制：手型）；地点「办公室」（控制：窗光）；画外：道具「茶杯」`
 * 输出：人物 / 地点两项 `offscreen: false`，茶杯一项 `offscreen: true`。
 *
 * 名称里可以含 `/` 和空格（`文工团办公区 / 江晨工位`），所以用「」切而不是
 * 按空白切。项与项之间只用中文分号 `；`，用英文 `;` 的文档在这里会被当成
 * 一项——这是故意的：那种文档本来就不合规范，宁可少读也不要读歪。
 */
export function castEntriesOf(text: string): ParsedCastEntry[] {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '无') return []
  const out: ParsedCastEntry[] = []
  let offscreen = false
  for (const rawPart of trimmed.split('；')) {
    const part = rawPart.trim()
    if (part === '') continue
    // `画外：` 是个标记而不是一项，它之后的每一项都算不入画。
    const offscreenMatch = /^画外[：:][ \t]*(.*)$/.exec(part)
    const body = offscreenMatch === null ? part : offscreenMatch[1]!.trim()
    if (offscreenMatch !== null) offscreen = true
    if (body === '') continue
    const match = /(人物|造型|地点|道具)[ \t]*「([^」]*)」[ \t]*(?:（控制[：:][ \t]*([^）]*)）)?/.exec(body)
    if (match === null) continue
    out.push({ kind: match[1]!, name: match[2]!.trim(), control: (match[3] ?? '').trim(), offscreen })
  }
  return out
}

/**
 * 一条 `输入参考图` 拆成图位。
 *
 * 输入：`REF-A（顺序：1）· 输入/参考图/许棠定妆.png《许棠定妆照》（用途：外貌；控制：脸型；不得控制：构图）；REF-B（顺序：2）· …`
 *
 * 三个坑，每一个都来自文档格式本身：
 *  - 项内的 `；` 分隔 `用途 / 控制 / 不得控制`，项间的 `；` 分隔图位。靠
 *    「以 `REF-` 或 `PLAN-` 开头」判断一个新项开始，而不是靠分号切。
 *  - 路径与《名称》之间是中点 `·`，路径里可以有空格（`输入/参考图/…`）。
 *  - `无（文生视频）。` / `无（待补参考图：…）` 都是「没有图」，但后者是
 *    「还没放图」而不是「决定不用图」，这个区别要留给调用方，所以两者都
 *    返回空数组，由调用方看原文。
 */
export function referenceEntriesOf(text: string): ParsedReference[] {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('无')) return []
  const out: ParsedReference[] = []
  // 用槽位前缀切项：每个 `REF-` / `PLAN-` 到下一个前缀之间是一个图位。
  const starts = [...trimmed.matchAll(/(?:^|；)[ \t]*((?:REF|PLAN)-[A-Z0-9-]+)/g)]
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!
    const slot = match[1]!
    const from = match.index! + match[0].length
    const to = index + 1 < starts.length ? starts[index + 1]!.index! : trimmed.length
    const body = trimmed.slice(from, to)
    const orderMatch = /（顺序[：:][ \t]*(\d+)）/.exec(body)
    // 路径到《名称》之间；没有《名称》时整段都可能是路径。
    const nameMatch = /《([^》]*)》/.exec(body)
    const head = nameMatch === null ? body : body.slice(0, nameMatch.index)
    const pathMatch = /·[ \t]*([^·（《]*)/.exec(head)
    const purposeMatch = /用途[：:][ \t]*([^；）]*)/.exec(body)
    // `控制：` 前面可能是 `（` 也可能是 `；`（第二项之后），而 `不得控制：` 里
    // 同样含「控制：」——不排除它，第一张图的「控制」会被读成空串。
    const controlMatch = /(?<!不得)控制[：:][ \t]*([^；）]*)/.exec(body)
    const notControlMatch = /不得控制[：:][ \t]*([^；）]*)/.exec(body)
    out.push({
      slot,
      order: orderMatch === null ? out.length + 1 : Number(orderMatch[1]),
      path: (pathMatch?.[1] ?? '').trim(),
      name: (nameMatch?.[1] ?? '').trim(),
      purpose: (purposeMatch?.[1] ?? '').trim(),
      control: (controlMatch?.[1] ?? '').trim(),
      notControl: (notControlMatch?.[1] ?? '').trim(),
    })
  }
  return out
}

/**
 * 读 `### 首帧提示词` / `### 尾帧提示词` 小节里的引用块。
 *
 * 规范要求小节内**只**放顶格 `>` 开头的行；这里按规范读，遇到第一个非
 * 引用、非空行就停（那是下一镜的字段，不该并进来）。多段 `>` 按空行分段
 * 时用空行连成一段——引用块内部的空 `>` 也是同一段的换行。
 */
function quotedBlock(body: readonly string[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of body) {
    const quote = /^>[ \t]?(.*)$/.exec(line)
    if (quote !== null) {
      current.push(quote[1]!.trimEnd())
      continue
    }
    if (line.trim() === '') {
      if (current.length > 0) { paragraphs.push(current.join('\n').trim()); current = [] }
      continue
    }
    // 引用块之后的第一行不是引用，也不是空行：这一小节读完了。
    break
  }
  if (current.length > 0) paragraphs.push(current.join('\n').trim())
  return paragraphs.filter(part => part !== '').join('\n\n')
}

/** `- 字段：值` → 字段名与值；不是字段行时 undefined。 */
export function fieldOf(line: string): { name: string, value: string } | undefined {
  const match = /^-[ \t]+([^：]{1,20})：[ \t]*(.*)$/.exec(line)
  return match === null ? undefined : { name: match[1]!.trim(), value: match[2]!.trim() }
}

/**
 * 读一份 `分镜.md`。
 *
 * 结构上只认三件事：`## SHOT-…` 开一个新镜头，`### 首帧/尾帧提示词` 切进
 * 提示词小节，`- 字段：值` 填字段。其余二级标题（`## 场景站位 · …`、
 * `## 整集汇总`）一律跳过——它们不是镜头，读进来会让板子上多出一条空行。
 */
export function parseStoryboardMarkdown(text: string): ParsedStoryboard {
  const all = lines(text)
  const warnings: string[] = []
  const shots: ParsedShot[] = []
  let title = ''
  for (const line of all) {
    if (line.startsWith('# ') && !line.startsWith('##')) { title = line.slice(2).trim(); break }
  }
  let current: ParsedShot | undefined
  /** 当前所在的小节：`fields` 是字段区，`first` / `last` 是提示词区。 */
  let section: 'fields' | 'first' | 'last' = 'fields'
  let quoted: string[] = []

  const flushQuoted = (): void => {
    if (current === undefined) return
    if (section === 'first') current.firstFrame = quotedBlock(quoted)
    else if (section === 'last') current.lastFrame = quotedBlock(quoted)
    quoted = []
  }
  const push = (): void => {
    if (current === undefined) return
    flushQuoted()
    shots.push(current)
    current = undefined
  }

  for (const line of all) {
    const heading = shotHeadingOf(line)
    if (heading !== undefined) {
      push()
      current = {
        shotId: heading.shotId,
        name: heading.name,
        source: '',
        seconds: 0,
        purpose: '',
        framing: '',
        movement: '',
        from: '',
        action: '',
        to: '',
        screenText: '',
        sound: '',
        imagePromptIds: [],
        references: [],
        cast: [],
        firstFrame: '',
        lastFrame: '',
      }
      section = 'fields'
      continue
    }
    if (current === undefined) continue
    // 别的二级标题：这个镜头结束了。
    if (/^##[ \t]/.test(line) && !line.startsWith('###')) { push(); continue }
    if (/^###[ \t]/.test(line)) {
      flushQuoted()
      const name = line.replace(/^###[ \t]*/, '').trim()
      section = name.startsWith('首帧') ? 'first' : name.startsWith('尾帧') ? 'last' : 'fields'
      continue
    }
    if (section === 'first' || section === 'last') { quoted.push(line); continue }
    const field = fieldOf(line)
    if (field === undefined) continue
    switch (field.name) {
      case '来源': current.source = field.value; break
      case '时长': current.seconds = secondsOf(field.value) ?? 0; break
      case '目的': current.purpose = field.value; break
      case '景别/机位': current.framing = field.value; break
      case '运镜': current.movement = field.value; break
      case '起点': current.from = field.value; break
      case '动作': current.action = field.value; break
      case '终点': current.to = field.value; break
      case '画面文字': current.screenText = field.value; break
      case '声音': current.sound = field.value; break
      case '图片提示词项': {
        // `IMG-A《名称》（控制：…）；IMG-B《名称》（控制：…）`
        for (const hit of field.value.matchAll(/(IMG-[A-Z0-9-]+)/g)) current.imagePromptIds.push(hit[1]!)
        break
      }
      case '输入参考图': current.references = referenceEntriesOf(field.value); break
      case '出场设定': current.cast = castEntriesOf(field.value); break
      default: break
    }
  }
  push()

  for (const shot of shots) {
    if (shot.seconds === 0) warnings.push(`${shot.shotId} 没有可读的时长，按 0 秒铺上，运行前需要手填。`)
    if (shot.firstFrame === '') warnings.push(`${shot.shotId} 没有首帧提示词。`)
  }
  if (shots.length === 0) warnings.push('没有读到任何 `## SHOT-…` 条目：这份文档可能不是《分镜.md》，或者条目头格式不同。')
  return { title: title === '' ? '分镜' : title, shots, warnings }
}

/** 读一份 `图片提示词.md`。 */
export function parseImagePromptsMarkdown(text: string): ParsedImagePrompts {
  const all = lines(text)
  const warnings: string[] = []
  const items: ParsedImagePrompt[] = []
  let title = ''
  for (const line of all) {
    if (line.startsWith('# ') && !line.startsWith('##')) { title = line.slice(2).trim(); break }
  }
  let current: ParsedImagePrompt | undefined
  let inPrompt = false
  let quoted: string[] = []
  const push = (): void => {
    if (current === undefined) return
    current.prompt = quotedBlock(quoted)
    items.push(current)
    current = undefined
    quoted = []
  }
  for (const line of all) {
    const heading = imageHeadingOf(line)
    if (heading !== undefined) {
      push()
      current = { imageId: heading.imageId, name: heading.name, usage: '', reference: '', prompt: '' }
      inPrompt = false
      continue
    }
    if (current === undefined) continue
    if (/^##[ \t]/.test(line) && !line.startsWith('###')) { push(); continue }
    if (/^###[ \t]/.test(line)) { inPrompt = line.replace(/^###[ \t]*/, '').trim().startsWith('可复制提示词'); continue }
    if (inPrompt) { quoted.push(line); continue }
    const field = fieldOf(line)
    if (field === undefined) continue
    if (field.name === '用途') current.usage = field.value
    else if (field.name === '参考') current.reference = field.value
  }
  push()
  for (const item of items) if (item.prompt === '') warnings.push(`${item.imageId} 没有可复制提示词。`)
  if (items.length === 0) warnings.push('没有读到任何 `## IMG-…` 条目。')
  return { title: title === '' ? '图片提示词' : title, items, warnings }
}

/** 读一份 `视频提示词.md`。 */
export function parseMotionPromptsMarkdown(text: string): ParsedMotionPrompts {
  const all = lines(text)
  const warnings: string[] = []
  const items: ParsedMotionPrompt[] = []
  let title = ''
  for (const line of all) {
    if (line.startsWith('# ') && !line.startsWith('##')) { title = line.slice(2).trim(); break }
  }
  let current: ParsedMotionPrompt | undefined
  let inPrompt = false
  let quoted: string[] = []
  const push = (): void => {
    if (current === undefined) return
    current.prompt = quotedBlock(quoted)
    items.push(current)
    current = undefined
    quoted = []
  }
  for (const line of all) {
    const heading = motionHeadingOf(line)
    if (heading !== undefined) {
      push()
      current = { motionId: heading.motionId, name: heading.name, shotId: '', seconds: 0, mode: '', prompt: '' }
      inPrompt = false
      continue
    }
    if (current === undefined) continue
    if (/^##[ \t]/.test(line) && !line.startsWith('###')) { push(); continue }
    if (/^###[ \t]/.test(line)) { inPrompt = line.replace(/^###[ \t]*/, '').trim().startsWith('可复制提示词'); continue }
    if (inPrompt) { quoted.push(line); continue }
    const field = fieldOf(line)
    if (field === undefined) continue
    if (field.name === '分镜') current.shotId = (/(SHOT-[A-Z0-9-]+)/.exec(field.value)?.[1] ?? '').trim()
    else if (field.name === '时长') current.seconds = secondsOf(field.value) ?? 0
    else if (field.name === '生成方式') current.mode = field.value
  }
  push()
  for (const item of items) {
    if (item.shotId === '') warnings.push(`${item.motionId} 没有「- 分镜：」行，接不回任何一镜。`)
    if (item.prompt === '') warnings.push(`${item.motionId} 没有可复制提示词。`)
  }
  if (items.length === 0) warnings.push('没有读到任何 `## MOTION-…` 条目。')
  return { title: title === '' ? '视频提示词' : title, items, warnings }
}

/** 一镜最终要写进 `CanvasShot.prompt` 的文本，以及它是从哪儿来的。 */
export interface ShotPromptSource {
  prompt: string
  /**
   * `motion` 是《视频提示词.md》的成片提示词，`firstFrame` 只是退而求其次
   * 的静帧描述。两者都能跑，但效果差得很远，界面必须把这件事说出来。
   */
  from: 'motion' | 'firstFrame' | 'fields' | 'none'
}

/**
 * 挑出这一镜该发出去的提示词。
 *
 * WHY 有优先级：`### 首帧提示词` 描述的是**一张静图**（构图、光线、材质），
 * `MOTION-…` 的 `### 可复制提示词` 描述的是**一段时间**（动作、表演、运镜、
 * 声音）。拿前者去生视频，得到的是一个几乎不动的镜头。文档里两份都写了，
 * 那就必须用后者；只有在没有《视频提示词.md》时才退回首帧，并明确标注。
 *
 * 最后的兜底是把分镜自己的字段拼成一段——比空提示词强，但同样要标注，因为
 * 它没有经过任何模型适配，只是把中文分镜字段连起来。
 */
export function shotPromptOf(shot: ParsedShot, motion: ParsedMotionPrompt | undefined): ShotPromptSource {
  if (motion !== undefined && motion.prompt.trim() !== '') return { prompt: motion.prompt.trim(), from: 'motion' }
  if (shot.firstFrame.trim() !== '') return { prompt: shot.firstFrame.trim(), from: 'firstFrame' }
  const parts = [shot.framing, shot.movement, shot.from, shot.action, shot.to, shot.sound]
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length > 0) return { prompt: parts.join('\n'), from: 'fields' }
  return { prompt: '', from: 'none' }
}

/**
 * 把一条 `出场设定` 收成要在画布上钉住的身份名。
 *
 * 只取 `人物` 与 `造型`：`地点` 和 `道具` 不是身份锚定的对象——把「副团长
 * 办公室」钉成一个 cast，会让每一镜都附带一张办公室图片当人物参考。`画外`
 * 的项不算，因为它本镜不入画。
 *
 * `造型` 排在 `人物` 之后：一个角色换装时会有 `人物「江晨」；造型「军装」`，
 * 真正决定画面的是那套衣服，但板子上认人的是名字——名字先取到才不会出现
 * 一个叫「军装」的人物。
 */
export function castNamesOf(shot: ParsedShot): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of shot.cast) {
    if (entry.offscreen) continue
    if (entry.kind !== '人物' && entry.kind !== '造型') continue
    if (entry.name === '' || seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry.name)
  }
  return out
}

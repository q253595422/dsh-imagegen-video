/**
 * 把解析出来的短剧文档铺成画布上的节点与连线，纯函数。
 *
 * 与 `storyboard-markdown.ts` 分开的理由：那个模块只回答「文档说了什么」，
 * 这个模块回答「那些话变成画布上的什么」。分开之后，格式变化只动前者、
 * 布局与身份锚定规则变化只动后者，而两边都能用真实样例在 smoke 里跑。
 *
 * 三条设计决定，都会影响用户在画布上看到的东西：
 *
 *  - **一块板 + 若干参考节点**，不是每镜一个节点。`CanvasStoryboard` 的
 *    全部意义就是「一个镜头列表、一个共享设置」；铺成 N 个独立分镜节点，
 *    用户就得逐块调模型和画幅。
 *  - **`输入参考图` 变成被钉住的图片节点，不是连线。** `submitShot` 用
 *    `castRefsFor(current, [])` 取参考图——分镜不接受上游连线，它只认
 *    `metadata.cast`。连一条线过去，画布上看得见，生成时一点用都没有；
 *    那比不铺更糟，因为用户会以为它生效了。
 *  - **`图片提示词.md` 的 `IMG-…` 铺成待填的普通图片节点。** 它们是设定板，
 *    不是成片；铺出来是为了让用户照着跑图，跑完再钉成 cast。所以不预填
 *    「已生成」，只把提示词和标题放好。
 */

import type { CanvasConnection, CanvasNode, CanvasShot, CanvasStoryboard, CanvasStoryboardSource } from '../protocol.ts'
import { STORYBOARD_NODE_SIZE, IMAGE_NODE_SIZE } from './canvas/constants.ts'
import {
  castNamesOf,
  nearestShotSeconds,
  shotPromptOf,
  type ParsedImagePrompt,
  type ParsedMotionPrompt,
  type ParsedShot,
  type ParsedStoryboard,
  type ShotPromptSource,
} from './storyboard-markdown.ts'
import { MAX_SHOTS } from './storyboard.ts'

/** 一镜在铺板后该有的样子，附带它是怎么来的，供界面解释。 */
export interface PlacedShot {
  /** 写进 `CanvasShot` 的那一条（`nodeId` 留空——还没有片段）。 */
  shot: CanvasShot
  /** `SHOT-EP001-002` 原文；`CanvasShot.id` 用它，好让铺板幂等。 */
  shotId: string
  name: string
  /** 这一镜的提示词来自哪里。`firstFrame` / `fields` 都要在界面上标出来。 */
  promptFrom: ShotPromptSource['from']
  /** 文档写的秒数，与 `shot.seconds` 可能不同（后者只在不合法时被夹住）。 */
  documentSeconds: number
  /** 要钉成 cast 的身份名。 */
  castNames: string[]
  /** `REF-…` 里能在磁盘上找到的图，铺板时要导入成图片节点。 */
  referencePaths: ReferenceEntry[]
  /** 文档里该有但没读到的东西，逐条给人看。 */
  notes: string[]
}

/** 一块待铺的板子。 */
export interface CanvasLayoutPlan {
  /** 分镜节点的标题。 */
  title: string
  board: CanvasStoryboard
  /** 这版板来自哪份剧集文档；没有就是「不是文档铺的」。 */
  source?: CanvasStoryboardSource
  shots: PlacedShot[]
  /** `图片提示词.md` 的条目，铺成待填的图片节点。 */
  imagePrompts: ParsedImagePrompt[]
  /** 铺板整体要注意的事（截断、去重、缺失）。 */
  warnings: string[]
}

/** 铺板时可调的几件事。 */
export interface LayoutOptions {
  /** 分镜节点标题；缺省用文档一级标题。 */
  title?: string
  /** 共享画幅；缺省 `9:16`——短剧文档写的制作形态基本都是竖屏。 */
  aspectRatio?: string
  /** 共享分辨率；缺省 `720P`。 */
  resolution?: string
  /** 视频模型覆盖；缺省交给画布默认。 */
  model?: string
  /** 来源标记；铺板时带上，重铺才能找回同一块板。 */
  source?: CanvasStoryboardSource
  /**
   * 每秒最多铺多少镜。`CanvasStoryboard` 的上限是 40（`MAX_SHOTS`），而
   * 一集短剧常有 60–100 镜——超出的部分不静默丢掉，而是明确告诉用户
   * 「这次铺了前 40 镜」。
   */
  maxShots?: number
}

/**
 * 一镜的秒数怎么定。
 *
 * 文档写 2s / 3s 是剪辑节奏，`submitShot` 会把它原样发给提供方，所以这里
 * **照抄文档值**。只有文档没写、或写了个读不懂的值（解析成 0）时，才落到
 * 最接近的合法档并留一条说明——因为 `isShot` 不允许 0 秒的镜头落盘，硬铺
 * 上去会让整份画布存不下来。
 */
function shotSecondsFor(shot: ParsedShot): { seconds: number, note?: string } {
  if (Number.isFinite(shot.seconds) && shot.seconds > 0) {
    const nearest = nearestShotSeconds(shot.seconds)
    if (nearest === shot.seconds) return { seconds: shot.seconds }
    // 文档值合法但不在选择器里：照抄，并说明「想改的话最近的是几秒」。
    return {
      seconds: shot.seconds,
      note: `文档写 ${shot.seconds}s，分镜的选择器里最接近的是 ${nearest}s；已按文档原值铺上，要改在镜头行上改。`,
    }
  }
  const fallback = nearestShotSeconds(5)
  return { seconds: fallback, note: '文档没有可读的时长，按 5s 铺上，运行前请手填。' }
}

/**
 * `输入参考图` 里哪些能真的导入。
 *
 * `PLAN-…` 是给外部工具预留的图位，没有路径可导；指向 `IMG-…` / `SHOT-…`
 * 的槽位指向的是「另一张图」，也不在这里解析——那是跨文档引用，铺板时无从
 * 得知那张图生成了没有。只认有真实路径的 `REF-…`，其余交给提示。
 */
/** 一张要从项目导入的参考图，连同文档给它的名字。 */
export interface ReferenceEntry {
  /** 项目相对路径，与文档里写的一致。 */
  path: string
  /** 文档里的《名称》；空串表示没写。钉成 cast 后它就是提示词里的称呼。 */
  name: string
  /** 图槽位（`REF-A1`），用于说明哪一镜缺图。 */
  slot: string
}

function importableReferences(shot: ParsedShot): { paths: ReferenceEntry[], notes: string[] } {
  const paths: ReferenceEntry[] = []
  const notes: string[] = []
  for (const reference of shot.references) {
    if (reference.slot.startsWith('PLAN-')) {
      notes.push(`${reference.slot} 是预留图位，没有实图可导入。`)
      continue
    }
    if (reference.path === '') {
      notes.push(`${reference.slot} 没有路径，只记了名称${reference.name === '' ? '' : `「${reference.name}」`}。`)
      continue
    }
    paths.push({ path: reference.path, name: reference.name, slot: reference.slot })
  }
  return { paths, notes }
}

/**
 * 把一份分镜（外加两份额外文档）铺成一块板。
 *
 * `motion` 与 `images` 都是可选的：只有《分镜.md》时也能铺，只是每镜的
 * 提示词退回首帧，并且这件事会写进 `notes`——用户必须知道手里这份板子
 * 用的是静帧描述而不是成片提示词。
 */
export function planCanvasLayout(input: {
  storyboard: ParsedStoryboard
  motions?: readonly ParsedMotionPrompt[]
  images?: readonly ParsedImagePrompt[]
  options?: LayoutOptions
}): CanvasLayoutPlan {
  const options = input.options ?? {}
  const warnings: string[] = [...input.storyboard.warnings]
  const maxShots = Math.min(options.maxShots ?? MAX_SHOTS, MAX_SHOTS)
  const motionByShot = new Map<string, ParsedMotionPrompt>()
  for (const motion of input.motions ?? []) {
    if (motion.shotId !== '' && !motionByShot.has(motion.shotId)) motionByShot.set(motion.shotId, motion)
  }
  const parsedShots = input.storyboard.shots
  if (parsedShots.length > maxShots) {
    warnings.push(`文档有 ${parsedShots.length} 镜，一块板最多 ${maxShots} 镜；这次铺前 ${maxShots} 镜。`)
  }
  const kept = parsedShots.slice(0, maxShots)
  const seenIds = new Set<string>()
  const shots: PlacedShot[] = []
  for (const parsed of kept) {
    // `CanvasShot.id` 直接沿用 `SHOT-EP001-002`：铺板是幂等的，同一份文档
    // 铺两次得到同样的 id，用户的片段才对得回原来的镜头。重复编号是文档
    // 错误，跳过第二个而不是让两个镜头抢同一个 id。
    if (seenIds.has(parsed.shotId)) {
      warnings.push(`${parsed.shotId} 重复出现，只铺第一次。`)
      continue
    }
    seenIds.add(parsed.shotId)
    const prompt = shotPromptOf(parsed, motionByShot.get(parsed.shotId))
    const notes: string[] = []
    if (prompt.from === 'firstFrame') notes.push('没有找到对应的《视频提示词.md》条目，这一镜用的是首帧静帧描述。')
    else if (prompt.from === 'fields') notes.push('既没有视频提示词也没有首帧提示词，这一镜按分镜字段拼出一段。')
    else if (prompt.from === 'none') notes.push('这一镜没有任何可用的提示词，运行前必须补。')
    const seconds = shotSecondsFor(parsed)
    if (seconds.note !== undefined) notes.push(seconds.note)
    const references = importableReferences(parsed)
    notes.push(...references.notes)
    const motion = motionByShot.get(parsed.shotId)
    if (motion !== undefined && motion.seconds > 0 && motion.seconds !== parsed.seconds) {
      notes.push(`《视频提示词.md》写 ${motion.seconds}s，分镜写 ${parsed.seconds}s，这里按分镜。`)
    }
    shots.push({
      shot: { id: parsed.shotId, prompt: prompt.prompt, seconds: seconds.seconds },
      shotId: parsed.shotId,
      name: parsed.name,
      promptFrom: prompt.from,
      documentSeconds: parsed.seconds,
      castNames: castNamesOf(parsed),
      referencePaths: references.paths,
      notes,
    })
  }
  const board: CanvasStoryboard = {
    // 一镜都没有时给一条空镜头：`isShot` 要求至少有可渲染的行，而一个
    // `shots: []` 的板子读回来会被 `storyboardOf` 换成默认的一条——那样
    // 用户会看到一条凭空的空白镜头，不如现在就放明。
    shots: shots.length === 0 ? [{ id: 'shot-1', prompt: '', seconds: 5 }] : shots.map(placed => placed.shot),
    aspectRatio: options.aspectRatio ?? '9:16',
    resolution: options.resolution ?? '720P',
    // 铺出来的板子默认 `cut`：文档没有承诺首尾帧接缝，擅自 `carry` 会让
    // 第二镜起全部变成关键帧模式，而且第一镜跑完之前每一镜都跑不了。
    continuity: 'cut',
    ...options.model === undefined || options.model === '' ? {} : { model: options.model },
    ...options.source === undefined ? {} : { source: options.source },
  }
  if (shots.length === 0) warnings.push('没有铺出任何镜头。')
  return {
    title: options.title ?? input.storyboard.title,
    board,
    ...options.source === undefined ? {} : { source: options.source },
    shots,
    imagePrompts: [...(input.images ?? [])],
    warnings,
  }
}

/** 铺板后的节点与连线，以及需要界面上报的事。 */
export interface LayoutNodes {
  boardNode: CanvasNode
  /** `IMG-…` 设定板节点，横排在分镜下方。 */
  imageNodes: CanvasNode[]
  connections: CanvasConnection[]
  warnings: string[]
}

/**
 * 把一版铺板结果落成真正的节点与连线。
 *
 * 节点位置决定了用户打开画布时看到什么，所以规则写死在这里而不是散在
 * 调用方：
 *  - 分镜板放在 `at` 处，尺寸用 `STORYBOARD_NODE_SIZE`（与手工新建一致）。
 *  - `IMG-…` 设定板排成分镜板下方一行，每行最多 6 个——它们是「照着跑图」
 *    的备料，不该和分镜板抢视线。
 *  - 连线只连「分镜板 → 设定板」这一种，方向是「板子依赖这张图」的反向：
 *    画布的 `from` 是上游。参考图节点的角色由用户决定（`cast`），连线只
 *    表示它们属于同一块板，不是数据通路。
 *
 * 这个函数不碰身份锚定：`metadata.cast` 要等图真的导入成节点之后才能打，
 * 那一步需要先有资产，所以由调用方在图就位后补。
 */
export function layoutNodes(input: {
  plan: CanvasLayoutPlan
  at: { x: number, y: number }
  newId: (kind: 'node' | 'edge') => string
  /**
   * 重铺时板节点的 id。
   *
   * 单独给而不是从 `newId` 里分：板必须是旧 id，否则画布上会多出一块板；
   * 而 `newId` 还要继续给图片节点发新 id。
   */
  boardId?: string
  /** 重铺时按 `IMG-…` 编号登记的旧节点 id（沿用它们才能留住已跑的图）。 */
  imageNodeIds?: Map<string, string>
}): LayoutNodes {
  const { plan, at, newId, boardId, imageNodeIds } = input
  const warnings: string[] = [...plan.warnings]
  const boardNode: CanvasNode = {
    id: boardId ?? newId('node'),
    type: 'storyboard',
    title: plan.title,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: STORYBOARD_NODE_SIZE.width,
    height: STORYBOARD_NODE_SIZE.height,
    metadata: { storyboard: plan.board, status: 'idle' },
  }
  const imageNodes: CanvasNode[] = []
  const connections: CanvasConnection[] = []
  const perRow = 6
  const gapX = 24
  const gapY = 24
  for (let index = 0; index < plan.imagePrompts.length; index += 1) {
    const item = plan.imagePrompts[index]!
    if (item.prompt === '') {
      warnings.push(`${item.imageId} 没有提示词，没有铺成节点。`)
      continue
    }
    const column = index % perRow
    const row = Math.floor(index / perRow)
    const node: CanvasNode = {
      id: imageNodeIds?.get(item.imageId) ?? newId('node'),
      type: 'image',
      title: item.name === '' ? item.imageId : `${item.imageId} · ${item.name}`,
      x: Math.round(at.x + column * (IMAGE_NODE_SIZE.width + gapX)),
      y: Math.round(at.y + STORYBOARD_NODE_SIZE.height + gapY + row * (IMAGE_NODE_SIZE.height + gapY)),
      width: IMAGE_NODE_SIZE.width,
      height: IMAGE_NODE_SIZE.height,
      // 图片来源：一个还没跑过的设定板。留着 `prompt` 让人一键生成，
      // 而不是先在宿主上生成好——什么时候跑图是用户的事，铺板不该花钱。
      metadata: { prompt: item.prompt, status: 'idle' },
    }
    imageNodes.push(node)
    connections.push({ id: newId('edge'), fromNodeId: node.id, toNodeId: boardNode.id })
  }
  return { boardNode, imageNodes, connections, warnings }
}

/**
 * 铺板后要在界面上说的一句话。
 *
 * 单独一个函数是因为它有分寸问题：一集 22 镜、每镜 3 条说明，逐条念会
 * 变成一堵墙。这里只挑「用户必须知道、否则会做错事」的那几类，其余留在
 * 单镜的行上。
 */
export function layoutSummary(plan: CanvasLayoutPlan): string[] {
  const out: string[] = []
  const fromMotion = plan.shots.filter(placed => placed.promptFrom === 'motion').length
  const fromFirstFrame = plan.shots.filter(placed => placed.promptFrom === 'firstFrame').length
  const missing = plan.shots.filter(placed => placed.promptFrom === 'none').length
  if (fromMotion > 0) out.push(`${fromMotion} 镜用了《视频提示词.md》的成片提示词。`)
  if (fromFirstFrame > 0) out.push(`${fromFirstFrame} 镜没有视频提示词，退回首帧静帧描述——生出来会偏「几乎不动」。`)
  if (missing > 0) out.push(`${missing} 镜连提示词都没有，运行前必须补。`)
  const cast = new Set<string>()
  for (const placed of plan.shots) for (const name of placed.castNames) cast.add(name)
  if (cast.size > 0) out.push(`文档点名了 ${cast.size} 个身份：${[...cast].join('、')}。先把它们生成成图片节点并钉住，参考才会生效。`)
  const refs = plan.shots.reduce((total, placed) => total + placed.referencePaths.length, 0)
  if (refs > 0) out.push(`${refs} 张输入参考图需要从项目里导入并钉住。`)
  return out
}

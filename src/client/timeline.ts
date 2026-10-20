/**
 * 时间线模型：把「几段视频拼起来」从一次性动作变成可反复编辑的素材表。
 *
 * 拼接原来只认顺序——选中哪几段，就按画布位置接到一起。真的做片子时，
 * 每段还要挑得出来的那几秒、段与段之间要过渡而不是硬切，所以这里补上
 * 入点、出点和转场。
 *
 * 全部是纯函数，不碰 ffmpeg、不碰 DOM：规则本身要能离线测，合成器那边只
 * 照着算出来的结果生成滤镜。
 */

/** 一段素材在时间线上的位置与裁剪。 */
export interface TimelineSegment {
  /** 稳定的段 id，拖拽重排时用它而不是下标。 */
  id: string
  /** 画布视频节点的 id，用来找回它的 URL 与时长。 */
  nodeId: string
  /** 入点，秒；0 表示从头开始。 */
  inPoint: number
  /**
   * 出点，秒。`undefined` 表示用到素材结尾——这是默认值，因为大多数段落
   * 是要完整用的，剪短才是例外。
   */
  outPoint?: number
}

/**
 * 段与段之间的转场。
 *
 * 只给三种：硬切不需要额外参数，淡入淡出与叠化要一个时长。转场列的长度
 * 比段落少一（第 i 个转场接在第 i 段与第 i+1 段之间），这是时间线编辑器
 * 里最不容易搞错的一种表达。
 */
export type TimelineTransitionKind = 'cut' | 'fade' | 'dissolve'

export interface TimelineTransition {
  kind: TimelineTransitionKind
  /** 转场时长，秒。`cut` 忽略它。 */
  seconds: number
}

/** 一整条时间线：段的顺序就是成片顺序，外加每条接缝上的转场。 */
export interface Timeline {
  segments: TimelineSegment[]
  /** 长度应为 `max(0, segments.length - 1)`；缺的按硬切处理。 */
  transitions: TimelineTransition[]
  /** 音频轨：每段是否保留自己的声音。 */
  keepAudio: boolean
}

/** 转场时长的合理范围：太短看不出，太长会吃掉半段素材。 */
export const MIN_TRANSITION_SECONDS = 0.2
export const MAX_TRANSITION_SECONDS = 3

export const DEFAULT_TRANSITION: TimelineTransition = { kind: 'cut', seconds: 0.5 }

/**
 * 一段素材在时间线上占多长。
 *
 * 出点越界时按素材真实长度算——时间线存的是用户的分意图，而素材长度是
 * 事实，两者冲突时事实赢，否则 ffmpeg 会读到不存在的帧。
 *
 * @param segment - 这一段。
 * @param clipSeconds - 素材的真实时长；未知时返回 `undefined`，因为长度
 *   不可知的段落没法参与总时长与转场上限的计算。
 */
export function segmentSeconds(segment: TimelineSegment, clipSeconds: number | undefined): number | undefined {
  if (clipSeconds === undefined || !Number.isFinite(clipSeconds) || clipSeconds <= 0) return undefined
  const start = Math.max(0, Math.min(segment.inPoint, clipSeconds))
  const end = segment.outPoint === undefined
    ? clipSeconds
    : Math.max(start, Math.min(segment.outPoint, clipSeconds))
  return Math.max(0, end - start)
}

/**
 * 一条时间线的总时长（含转场重叠）。
 *
 * 转场是把两段的重叠区叠起来，所以每加一个转场总长要减掉一个时长的量；
 * 硬切不减。这是编辑器显示的总时长，也是用户唯一能看到的时间感。
 *
 * @param timeline - 时间线。
 * @param clipSecondsOf - 按段取素材真实时长。
 */
export function timelineSeconds(
  timeline: Timeline,
  clipSecondsOf: (segment: TimelineSegment) => number | undefined,
): number {
  let total = 0
  let known = false
  for (const segment of timeline.segments) {
    const seconds = segmentSeconds(segment, clipSecondsOf(segment))
    if (seconds === undefined) continue
    total += seconds
    known = true
  }
  for (let index = 0; index < timeline.segments.length - 1; index += 1) {
    total -= transitionOverlap(timeline, index, clipSecondsOf)
  }
  return known ? Math.max(0, total) : 0
}

/**
 * 第 index 条接缝实际重叠多少秒。
 *
 * 转场不能长过它两侧任何一段的一半：否则 ffmpeg 的 xfade 会拿到一个比
 * 素材还长的偏移，输出直接失败。这里在**计算期**就夹住，而不是等合成时
 * 报一个看不懂的错。
 */
export function transitionOverlap(
  timeline: Timeline,
  index: number,
  clipSecondsOf: (segment: TimelineSegment) => number | undefined,
): number {
  const transition = timeline.transitions[index]
  if (transition === undefined || transition.kind === 'cut') return 0
  const left = timeline.segments[index]
  const right = timeline.segments[index + 1]
  if (left === undefined || right === undefined) return 0
  const leftSeconds = segmentSeconds(left, clipSecondsOf(left))
  const rightSeconds = segmentSeconds(right, clipSecondsOf(right))
  if (leftSeconds === undefined || rightSeconds === undefined) return 0
  const wanted = Math.max(MIN_TRANSITION_SECONDS, Math.min(transition.seconds, MAX_TRANSITION_SECONDS))
  // 两侧各让一半；留下 0.05 秒余量，避免浮点误差让 xfade 恰好等于素材长度。
  return Math.max(0, Math.min(wanted, leftSeconds / 2 - 0.05, rightSeconds / 2 - 0.05))
}

/**
 * 把转场列表调整到与段落数匹配。
 *
 * 增删/重排段落之后转场列表很容易错位：删掉一段时，原本属于它两侧的两个
 * 转场会变成「接缝上多了一个」。与其在编辑器里到处修，不如每次结构变化后
 * 归一化一次。
 *
 * @param segments - 当前段数。
 * @param transitions - 用户已有的转场（可能长也可能短）。
 */
export function normalizeTransitions(segments: number, transitions: readonly TimelineTransition[]): TimelineTransition[] {
  const needed = Math.max(0, segments - 1)
  const out: TimelineTransition[] = []
  for (let index = 0; index < needed; index += 1) {
    out.push(transitions[index] ?? DEFAULT_TRANSITION)
  }
  return out
}

/** 新建一条空时间线。 */
export function emptyTimeline(): Timeline {
  return { segments: [], transitions: [], keepAudio: true }
}

/** 从一个节点列表造初始时间线（按给定顺序，整段使用，硬切）。 */
export function timelineFromNodeIds(nodeIds: readonly string[]): Timeline {
  const segments = nodeIds.map((nodeId, index) => ({
    id: `seg-${index + 1}-${nodeId.slice(-6)}`,
    nodeId,
    inPoint: 0,
  }))
  return { segments, transitions: normalizeTransitions(segments.length, []), keepAudio: true }
}

/**
 * 走一遍时间线，算出每段在成片里的起止时间。
 *
 * 合成器要的正是这个：每段的裁剪区间 + 转场把下一段往前拉多少。放在这里
 * 而不是合成器内部，是因为编辑器要拿它画时间条。
 */
export interface TimelinePlacement {
  segment: TimelineSegment
  /** 在成片里的起点（秒）。 */
  start: number
  /** 这一段实际取用的长度（秒）。 */
  seconds: number
  /** 与PREVIOUS段的重叠时长；第一段为 0。 */
  overlap: number
}

export function placeTimeline(
  timeline: Timeline,
  clipSecondsOf: (segment: TimelineSegment) => number | undefined,
): TimelinePlacement[] {
  const out: TimelinePlacement[] = []
  let cursor = 0
  timeline.segments.forEach((segment, index) => {
    const seconds = segmentSeconds(segment, clipSecondsOf(segment)) ?? 0
    const overlap = transitionOverlap(timeline, index - 1, clipSecondsOf)
    if (index > 0) cursor -= overlap
    out.push({ segment, start: Math.max(0, cursor), seconds, overlap })
    cursor += seconds
  })
  return out
}

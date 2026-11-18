/**
 * 画布几何：拖拽吸附与「节点被完全盖住」的判定。
 *
 * 从 CanvasWorkspace.tsx 原样搬出：纯函数，只吃节点坐标，不碰视图状态、
 * 不碰 DOM，所以能单独验证。逻辑与注释一字未改。
 */

import type { CanvasNode } from '../../protocol.ts'

export type Point = { x: number; y: number }

/** How close (in screen pixels) an edge must come before a drag snaps to it. */
export const SNAP_SCREEN_PX = 8

/**
 * Snap correction for a drag in progress.
 *
 * Tests the moved node's left/centre/right (and top/middle/bottom) against the
 * same three lines of every node that is not being dragged, and returns the
 * smallest shift that brings a pair within `threshold` world pixels. Edges
 * against edges covers both alignment and edge-to-edge adjacency.
 */
export function snapOffset(
  primary: CanvasNode,
  others: readonly CanvasNode[],
  dx: number,
  dy: number,
  threshold: number,
): Point {
  const left = primary.x + dx
  const top = primary.y + dy
  const xs = [left, left + primary.width / 2, left + primary.width]
  const ys = [top, top + primary.height / 2, top + primary.height]
  let bestX = 0
  let bestY = 0
  let nearestX = threshold + 1
  let nearestY = threshold + 1
  for (const other of others) {
    for (const target of [other.x, other.x + other.width / 2, other.x + other.width]) {
      for (const edge of xs) {
        const delta = target - edge
        if (Math.abs(delta) <= nearestX) { nearestX = Math.abs(delta); bestX = delta }
      }
    }
    for (const target of [other.y, other.y + other.height / 2, other.y + other.height]) {
      for (const edge of ys) {
        const delta = target - edge
        if (Math.abs(delta) <= nearestY) { nearestY = Math.abs(delta); bestY = delta }
      }
    }
  }
  return { x: Math.abs(bestX) > threshold ? 0 : bestX, y: Math.abs(bestY) > threshold ? 0 : bestY }
}

/** 一个被完全盖住的节点，以及盖住它的那个节点。 */
export interface OverlapPair {
  coveredId: string
  coverId: string
}

/**
 * 找出被另一个节点完全盖住的节点，只在涉及 `moving` 时报告。
 *
 * WHY 只报「完全被盖住」：部分重叠在画布上是常态（节点挨着摆、标注卡片压住图片
 * 边缘），提示它只会变成噪音。真正让人卡住的是被完全罩住的那一个——屏幕上看不见
 * 它，框选也选不到，用户会以为节点丢了。
 *
 * WHY 必须按绘制顺序判断「谁盖住谁」：数组顺序就是绘制顺序，末尾在最上面。只看
 * 几何包含会把压在上面、明明看得见的小卡报成被盖住；更糟的是用户按「置顶」把它
 * 拿到最上层之后提示仍然不消失——这条提示的全部价值就是指出「该把谁拿到前面」，
 * 方向反了、或者照做也没用，它就从向导变成了干扰。所以只有下标更大（更靠上）
 * 的那张包含住下标更小的那张，才算一次遮盖。
 *
 * WHY 要求涉及 `moving`：两块静止的节点重叠是历史数据，每次载入都描红会变成甩不
 * 掉的报错；而用户正拖着的那一个，才是他此刻需要知道的。
 *
 * 尺寸完全相同时两边互相包含，方向由下标唯一决定：下标小的在下面、被上面的盖住。
 * 不需要再拿 id 兜底，否则 id 较大的那张会被漏报。
 */
export function coveredNodes(nodes: readonly CanvasNode[], moving: ReadonlySet<string>): OverlapPair[] {
  const pairs: OverlapPair[] = []
  for (let upper = 1; upper < nodes.length; upper += 1) {
    const cover = nodes[upper]!
    for (let lower = 0; lower < upper; lower += 1) {
      const node = nodes[lower]!
      const inside = cover.x <= node.x
        && cover.y <= node.y
        && cover.x + cover.width >= node.x + node.width
        && cover.y + cover.height >= node.y + node.height
      if (!inside) continue
      if (!moving.has(node.id) && !moving.has(cover.id)) continue
      pairs.push({ coveredId: node.id, coverId: cover.id })
    }
  }
  return pairs
}

/**
 * 吸附参考线：拖动时那几条让用户「看见自己为什么停在这里」的线。
 *
 * WHY 需要它：吸附本身早就有了（`snapOffset`），但它只改坐标、不留痕迹。用户在
 * 一张 240px 的卡上拖到离邻居只有 3px 时，卡片自己「跳」到贴边——他看到的是一
 * 次无法解释的位移。Figma / Sketch / Figma 系所有工具都用一条线解释这件事：线
 * 出现 = 我吸到了，线消失 = 我自由了。没有这条线，吸附的经验是「画布有点黏」；
 * 有了它，用户学会主动去找对齐。
 *
 * **几何完全独立于 `snapOffset` 的返回值**：这个函数拿的是「已经落位之后」的位置，
 * 只问「哪些边现在重合」。把两者写成一个函数会让「吸附算错了」和「线画错了」两
 * 种缺陷混在同一个返回值里，而它们的症状完全不同（前者卡在错的地方，后者卡在对
 * 的地方但画错线）。
 *
 * 容差是**世界像素**且很小（半个像素）：位置在拖动里被 `Math.round` 成整数，所以
 * 「重合」在世界坐标里就是精确相等；留半像素是为了吸收缩放带来的浮点误差，而不
 * 是给用户一个「差不多算对齐」的模糊带——那会让线在一堆不相干的卡之间乱闪。
 *
 * 同一条坐标上的多根线会**合并成一个区间**：三张卡的左边缘都在 x=100 时，画三条
 * 重叠的线段在视觉上是一条，但 DOM 里是三层；而用户拖过一片整齐的卡时这种情况
 * 是常态。
 */
export interface SnapGuide {
  axis: 'x' | 'y'
  /** 世界坐标：竖直线的 x，或水平线的 y。 */
  at: number
  /** 线段在世界坐标里的起止（另一根轴）。 */
  from: number
  to: number
}

/** 判定「两条边重合」的容差，世界像素。见函数头的说明。 */
const GUIDE_EPSILON = 0.5

export function snapGuides(
  primary: CanvasNode,
  others: readonly CanvasNode[],
): SnapGuide[] {
  const xs = [primary.x, primary.x + primary.width / 2, primary.x + primary.width]
  const ys = [primary.y, primary.y + primary.height / 2, primary.y + primary.height]
  // 坐标 → 区间。用 Map 而不是先收集再两两比对：合并本来就是「同一把钥匙的
  // 区间取并集」，而那正是 Map 的语义。
  const vertical = new Map<number, { from: number; to: number }>()
  const horizontal = new Map<number, { from: number; to: number }>()

  const add = (map: Map<number, { from: number; to: number }>, at: number, from: number, to: number): void => {
    // 先按容差找一把已存在的钥匙，避免 99.9996 与 100 各自成为一条线。
    for (const [key, existing] of map) {
      if (Math.abs(key - at) > GUIDE_EPSILON) continue
      map.set(key, { from: Math.min(existing.from, from), to: Math.max(existing.to, to) })
      return
    }
    map.set(at, { from, to })
  }

  for (const other of others) {
    // 只画「这条边真的对上了」的线。三对三全试而不是只试左边对左边：用户拖一张
    // 卡去贴另一张卡的右边（左对齐右）时，那根线同样成立，而他按视觉判断的就是
    // 「两条边在同一条竖线上」。
    for (const target of [other.x, other.x + other.width / 2, other.x + other.width]) {
      if (!xs.some(edge => Math.abs(edge - target) <= GUIDE_EPSILON)) continue
      add(vertical, target, Math.min(primary.y, other.y), Math.max(primary.y + primary.height, other.y + other.height))
    }
    for (const target of [other.y, other.y + other.height / 2, other.y + other.height]) {
      if (!ys.some(edge => Math.abs(edge - target) <= GUIDE_EPSILON)) continue
      add(horizontal, target, Math.min(primary.x, other.x), Math.max(primary.x + primary.width, other.x + other.width))
    }
  }

  const guides: SnapGuide[] = []
  for (const [at, span] of vertical) guides.push({ axis: 'x', at, ...span })
  for (const [at, span] of horizontal) guides.push({ axis: 'y', at, ...span })
  // 固定顺序：竖直在前、坐标升序。渲染是纯函数，但顺序不稳定会让「这一帧画了
  // 几条」在两次相同拖动之间变化，而快照比对会被这种抖动误判成回归。
  return guides.sort((first, second) => first.axis === second.axis ? first.at - second.at : first.axis === 'x' ? -1 : 1)
}

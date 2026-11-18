/**
 * 整理画布：把一张有向图排成从左到右的列。
 *
 * WHY 需要它：画布上东西一多，节点位置就是「随手放的」——同一层的两张图偏了
 * 三十像素、一条上下游被斜着拉出去半屏、生成出来的新节点叠在旧节点上。用户能
 * 读懂这张图，但**读不快**，而且每次新增节点都要重新找地方放。这是一个工作流
 * 画布的日常动作，不是锦上添花。
 *
 * 分层规则不在这里重新发明：`workflow-graph.ts` 的 `planLayers` 已经实现了
 * Kahn 分层与环检测，执行器用的就是它。整理画布用同一份，好处是「整理出来的
 * 形状」与「运行时的执行顺序」天然一致——横向第 N 列就是第 N 层，用户看图的
 * 直觉和机器跑的顺序不会打架。两份分层逻辑迟早会分叉成「看着是先跑 A，实际
 * 先跑 B」。
 *
 * 四条硬约束：
 *
 * 1. **环不整理。** 有环时列的顺序不可信（环上的节点没有「第几层」），照排
 *    只会得到一张看起来井然有序、实际跑不起来的图。直接拒绝，让调用方把
 *    `workflow.cycle` 那条现成的错误说出来。
 * 2. **没连线的节点不混进第一层。** 它们不是「流程的起点」，是「还没接线」。
 *    塞进第 0 列会让真正的源头节点淹没在一堆散卡里，而这些散卡恰好是最不
 *    需要被注意的东西。它们落在流程下方的一条停放带里，保持彼此原有的
 *    左右/上下顺序——像把桌上的散纸扫到一边，不动流程。
 * 3. **锚点是当前包围盒的左上角。** 整理到世界原点会把人已经放到远处的整块
 *    内容瞬移到别处，用户看到的是一块空白画布。原地整理，视野不动。
 * 4. **幂等。** 连按两次的结果必须一模一样（坐标取整、列宽由内容决定、层内
 *    按当前 y 排序），否则「整理」这个动作在第二次点击时会自己变形。
 */

import type { CanvasConnection, CanvasNode } from '../../protocol.ts'
import { planLayers } from '../workflow-graph.ts'

/**
 * 列间距与行间距（世界像素）。
 *
 * 96 是「连线看得出是一段、而不是两个卡片贴在一起」的最小值：连线层画的是
 * 两端中点的三次贝塞尔，水平间距小于约 72 时曲线会在卡片边缘处几乎垂直，
 * 读起来像一条缝而不是一条关系。48 与 `node-model.ts` 的 `NODE_GAP` 一致，
 * 那是画布上放新列时用的间距，两处相同才不会出现「自动摆的比自己摆的挤」。
 */
export const ARRANGE_GAP = { x: 96, y: 48 } as const

/**
 * 没有流程（一个连线都没有）时，停放带每行放几列。
 *
 * 三列是「一眼扫完、又不用横向拖」的量级；再多就变成一条长龙，用户还得
 * 自己找第二行从哪开始。
 */
const PARKED_COLUMNS = 3

export interface ArrangePlacement {
  x: number
  y: number
}

export type ArrangeResult =
  | {
    ok: true
    /** 节点 id → 新坐标。每个节点都有一条，调用方直接按 id 覆盖即可。 */
    positions: Map<string, ArrangePlacement>
    /** 位置真的变了的节点数；为 0 说明这张图本来就是整理好的。 */
    moved: number
    /** 流程占了几列（不含停放带）。 */
    columns: number
    /** 被放进停放带的散卡数量。 */
    parked: number
  }
  | { ok: false; cycle: string[] }

/**
 * 算出整理后的坐标。**不改画布**：纯函数，返回一份 id → 坐标。
 *
 * 层内的顺序用当前的 `y`（相同再用 `x`、再按 id）排。这样「整理」只在用户
 * 没打算改变的地方动：他手动把 B 放在 A 上面，整理之后 B 还在上面。按 id 排
 * 会得到一份稳定但每次都不认人的结果，等于把用户之前的取舍全部作废。
 */
export function arrangePositions(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
): ArrangeResult {
  if (nodes.length === 0) {
    return { ok: true, positions: new Map(), moved: 0, columns: 0, parked: 0 }
  }

  const byId = new Map(nodes.map(node => [node.id, node]))
  const visualOrder = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // 两端都在画布上的连线才算「这张图里真的有一根线」。指向已删除节点的残线
  // 不参与分层，也不让一个孤立节点因为一根残线被当成流程的一部分。
  const wired = new Set<string>()
  const liveEdges: CanvasConnection[] = []
  for (const connection of connections) {
    if (!byId.has(connection.fromNodeId) || !byId.has(connection.toNodeId)) continue
    liveEdges.push(connection)
    wired.add(connection.fromNodeId)
    wired.add(connection.toNodeId)
  }
  const flow = visualOrder.filter(node => wired.has(node.id))
  const loose = visualOrder.filter(node => !wired.has(node.id))

  const plan = planLayers(flow.map(node => node.id), liveEdges)
  // 环上的节点画不到「第几列」，而半个流程排好、半个流程留在原处比不整理
  // 更难看懂。整张图一起拒绝。
  if (plan.cycle.length > 0) return { ok: false, cycle: plan.cycle }

  // 锚点：当前内容包围盒的左上角。世界坐标可能为负，Math.min 照常适用。
  const originX = Math.round(Math.min(...nodes.map(node => node.x)))
  const originY = Math.round(Math.min(...nodes.map(node => node.y)))

  const positions = new Map<string, ArrangePlacement>()
  // 层内顺序按视觉顺序（原来的 y，再 x，再 id）重排一次。`planLayers` 的层内
  // 顺序来自「谁先被解放」，也就是边的插入顺序——那是画布历史上谁先被连的
  // 顺序，与用户看到的上下关系无关。不重排的话，整理会把用户有意摆在上面的
  // 那张卡挪到下面，而这一步是他最不该被代劳的判断。
  const visualRank = new Map(visualOrder.map((node, index) => [node.id, index]))
  let columnX = originX
  let flowBottom = originY

  for (const planned of plan.layers) {
    const layer = [...planned].sort((a, b) => (visualRank.get(a) ?? 0) - (visualRank.get(b) ?? 0))
    let cursorY = originY
    let columnWidth = 0
    for (const id of layer) {
      const node = byId.get(id)
      if (node === undefined) continue
      positions.set(id, { x: Math.round(columnX), y: Math.round(cursorY) })
      cursorY += Math.max(1, node.height) + ARRANGE_GAP.y
      columnWidth = Math.max(columnWidth, Math.max(1, node.width))
    }
    if (layer.length === 0) continue
    flowBottom = Math.max(flowBottom, cursorY - ARRANGE_GAP.y)
    columnX += columnWidth + ARRANGE_GAP.x
  }

  if (loose.length > 0) {
    // 停放带的宽度对齐流程的宽度：散卡与流程占同一块横向领地，看起来是同一
    // 张画布上的两段，而不是两堆各自为政的东西。没有流程时按固定列数铺开。
    const flowWidth = plan.layers.length > 0 ? columnX - ARRANGE_GAP.x - originX : 0
    const parkedWidth = flowWidth > 0
      ? flowWidth
      : loose.slice(0, PARKED_COLUMNS).reduce((sum, node, index) => sum + Math.max(1, node.width) + (index > 0 ? ARRANGE_GAP.x : 0), 0)
    // 停放带与流程之间留两倍行距：一倍是「同一层里两张卡的距离」，两倍才读得
    // 出「这里换了一件事」。
    let cursorY = plan.layers.length > 0 ? flowBottom + ARRANGE_GAP.y * 2 : originY
    let cursorX = originX
    let rowHeight = 0
    for (const node of loose) {
      const width = Math.max(1, node.width)
      // 只有已经摆过东西的行才换行：否则一个比整条带还宽的节点会被换到下一
      // 行、再因为「自己就超宽」立刻又换一次，每张宽图白涨一行空位。
      if (cursorX > originX && cursorX + width > originX + parkedWidth) {
        cursorX = originX
        cursorY += rowHeight + ARRANGE_GAP.y
        rowHeight = 0
      }
      positions.set(node.id, { x: Math.round(cursorX), y: Math.round(cursorY) })
      cursorX += width + ARRANGE_GAP.x
      rowHeight = Math.max(rowHeight, Math.max(1, node.height))
    }
  }

  let moved = 0
  for (const node of nodes) {
    const next = positions.get(node.id)
    if (next === undefined) continue
    if (next.x !== node.x || next.y !== node.y) moved += 1
  }

  return { ok: true, positions, moved, columns: plan.layers.length, parked: loose.length }
}

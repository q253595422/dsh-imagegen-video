/**
 * 生成前把「就在旁边、但还没连过来的图片」补成连线。
 *
 * 为什么要有：用户把一张图拖到配置节点旁边，看起来显然是「要用这张」，但画布
 * 的语义只认连线，于是生成时那张图完全不参与，人还得再拉一次线。这是画布上
 * 最常见的「我以为它懂了」。
 *
 * 三条硬约束，改这个文件之前先读完：
 *
 * 1. **只在提交生成的那一刻补，不在拖拽时猜。** 拖到附近就自己长出一条线，
 *    用户不接受也没法拒绝；提交是明确的意图表达，补上的线看得见、删得掉、
 *    一步就能撤销。
 * 2. **只补「近」的，不全画布智能匹配。** 阈值是边缘到边缘 1.5 个目标节点
 *    短边。AutoLink 式的全画布匹配会让用户在远处的图莫名参与生成，且看不出
 *    是哪张。宁可少补，让人自己拉线。
 * 3. **补边不夺角色。** 只有 keyframe 模式才标 first / last（那正是角色的
 *    意义所在），其余模式补出来的是普通输入，与手拉的线完全一样。
 *
 * 纯函数：不碰 React、不碰 DOM，Node 可直接 strip-types 跑。
 */

import type { CanvasConnection, CanvasConnectionRole, CanvasNode } from '../../protocol.ts'

/** 补出来的连线候选：连哪张、占什么角色。 */
export interface AutoLinkCandidate {
  nodeId: string
  role?: CanvasConnectionRole
}

/** 「近」的判定倍数：边缘间距不超过目标节点短边的这么多倍。 */
export const AUTO_LINK_REACH = 1.5

/** 一次生成最多补几张：与引擎侧参考图上限一致，多补也送不进去。 */
export const AUTO_LINK_LIMIT = 4

/** 两个矩形之间的边缘间距；重叠或相切记 0。 */
function rectGap(a: CanvasNode, b: CanvasNode): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)))
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)))
  return Math.hypot(dx, dy)
}

/**
 * 该自动连到 `target` 的图片节点，按「离得近的优先」排序。
 *
 * `usable` 由调用方给（画布那边是「有 asset 且 url 非空」），这个模块不认识
 * asset 的形状。已经连到 target 的不算候选——补的是缺口，不是重连。
 */
export function autoLinkCandidates(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  target: CanvasNode,
  usable: (node: CanvasNode) => boolean,
  limit: number = AUTO_LINK_LIMIT,
): CanvasNode[] {
  const wired = new Set(connections.filter(connection => connection.toNodeId === target.id).map(connection => connection.fromNodeId))
  const reach = AUTO_LINK_REACH * Math.min(target.width, target.height)
  return nodes
    .filter(node => node.type === 'image' && node.id !== target.id && !wired.has(node.id) && usable(node))
    .map(node => ({ node, gap: rectGap(node, target) }))
    .filter(entry => entry.gap <= reach)
    .sort((a, b) => a.gap - b.gap || a.node.id.localeCompare(b.node.id))
    .slice(0, Math.max(0, limit))
    .map(entry => entry.node)
}

/**
 * 首尾帧模式下的角色分配：前两张当首帧/尾帧，其余是素材。
 *
 * 传进来的顺序就是生成时用的顺序，所以这里不改顺序——排序是
 * `orderedUpstream` 的事，这里只负责说「谁是什么」。
 */
export function keyframeRoles(count: number): AutoLinkCandidate['role'][] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    if (index === 0) return 'first' as const
    if (index === 1) return 'last' as const
    return 'reference' as const
  })
}

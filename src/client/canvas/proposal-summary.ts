/**
 * 把一条提案的 `counts` 翻成一句话。
 *
 * WHY 放在客户端而不是服务端：Agent 的写工具跑在宿主里，不认识界面语言。
 * 改造前那句话是服务端用中文拼好后写进提案文件的（「添加 2 个节点、连接
 * 1 条线」），英文与俄文用户于是看到中文——提案条上其余每一行文案都走
 * `tt()`，只有这一行不受语言表管辖。
 *
 * 现在服务端只记数量，这句话在这里按当前语言渲染。旧提案（已落在磁盘上的）
 * 没有 `counts`，退回它自己的 `summary`：那句话至少是对的，只是语言不可选。
 */

import type { CanvasProposal, CanvasProposalCounts } from '../../protocol.ts'
import { tt } from '../helpers.ts'

/**
 * 一句话描述这条提案要做什么；没有任何可说的数量时返回 `undefined`。
 *
 * 顺序固定（加 / 改 / 删 / 连 / 改角色 / 断 / 改名），与 `summarise` 一致：两个实现
 * 输出同一句话，只是语言不同。
 */
export function describeProposal(counts: CanvasProposalCounts | undefined): string | undefined {
  if (counts === undefined) return undefined
  const parts: string[] = []
  if ((counts.addedNodes ?? 0) > 0) parts.push(tt('canvas.proposal.summary.added', { count: counts.addedNodes ?? 0 }))
  if ((counts.updatedNodes ?? 0) > 0) parts.push(tt('canvas.proposal.summary.updated', { count: counts.updatedNodes ?? 0 }))
  if ((counts.removedNodes ?? 0) > 0) parts.push(tt('canvas.proposal.summary.removed', { count: counts.removedNodes ?? 0 }))
  if ((counts.addedConnections ?? 0) > 0) parts.push(tt('canvas.proposal.summary.wired', { count: counts.addedConnections ?? 0 }))
  if ((counts.updatedConnections ?? 0) > 0) parts.push(tt('canvas.proposal.summary.rewired', { count: counts.updatedConnections ?? 0 }))
  if ((counts.removedConnections ?? 0) > 0) parts.push(tt('canvas.proposal.summary.unwired', { count: counts.removedConnections ?? 0 }))
  if (counts.title !== undefined) parts.push(tt('canvas.proposal.summary.renamed', { title: counts.title }))
  return parts.length === 0 ? undefined : parts.join(tt('canvas.proposal.summary.separator'))
}

/**
 * 提案条上显示的那一句：优先按当前语言渲染，旧提案退回它自带的那句。
 *
 * 兜底不能是空的：提案条的全部意义是「告诉用户 Agent 想做什么」，一句空
 * 文案比一句中文更糟。
 */
export function proposalSummaryText(proposal: CanvasProposal): string {
  return describeProposal(proposal.counts) ?? proposal.summary
}

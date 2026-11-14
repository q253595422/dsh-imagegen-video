/**
 * 提案条：Agent 想改画布时，改动先在这里等用户点头。
 *
 * 与 `overlays.tsx` 同一约定——只画，不做决定。什么时候拉取、接受后怎么
 * 更新画布，都在 `CanvasWorkspace` 里。
 *
 * 三条必须做到的：
 *
 *  1. **说清楚「还没改」。** 用户看到画布上多出东西，第一反应是「已经改了
 *     吗」。所以标题是「Agent 提议的改动」，不是「Agent 的改动」，并且常驻
 *     一句「接受之前画布不会变化」。
 *  2. **一次只看一条，但告诉他还有几条。** 提案是先后算出来的（第 2 条建立
 *     在第 1 条之上），所以必须按顺序接受：跳过第 1 条直接接受第 2 条会得到
 *     一条指向不存在节点的改动。这里只给「接受这一条」，不接受任意一条。
 *  3. **过期要说人话。** 用户在提议之后自己动过画布时，接受会失败。把后端的
 *     错误码翻成「画布在这次提议之后改过，让 Agent 重新提议」，而不是把
 *     `proposal-stale` 原样丢出来。
 */

import type { CanvasProposal } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import css from '../canvas-workspace.module.css'

export interface CanvasProposalBarProps {
  /** 该画布上待确认的提案，按提议顺序；空数组时不渲染。 */
  proposals: readonly CanvasProposal[]
  /** 正在处理（接受/丢弃请求已发出）。按钮全部禁用，避免连点两次。 */
  busy: boolean
  /** 上一次失败的原因，已经翻成用户能读的句子；成功时为 null。 */
  error: string | null
  /**
   * 画布自己的错误提示正在显示。
   *
   * 两者会同时出现：接受一条提案失败时，提案条上写着原因，画布还挂着自己的
   * 错误提示。它们曾经都定在 top: 14px，必然叠在一起。
   *
   * 为什么是一个 props 而不是 CSS `:has()`：项目契约（docs/native-ui-contract
   * .md §4.3）明确不允许用 `:has()` 表达「包含某节点」——jsdom 既解析不了也
   * 没有判别力，等于把规则排除在测试之外。调用方本来就知 error 是不是非空。
   */
  stacked?: boolean
  onAccept: (proposalId: string) => void
  onDiscard: (proposalId: string) => void
  onDiscardAll: () => void
}

/**
 * 提案条。
 *
 * 只显示第一条：后面的建立在它之上，先接受前面的才轮得到后面的。把整串
 * 列出来会诱使用户点第二条。
 */
export function CanvasProposalBar({
  proposals = [],
  busy = false,
  error = null,
  stacked = false,
  onAccept,
  onDiscard,
  onDiscardAll,
}: Partial<CanvasProposalBarProps> = {}): React.JSX.Element | null {
  if (proposals.length === 0) return null
  const first = proposals[0]!
  const remaining = proposals.length - 1

  return <div
    className={css.proposalBar}
    role="status"
    data-canvas-proposal-bar=""
    data-stacked={stacked ? '' : undefined}
  >
    <div className={css.proposalHead}>
      <span className={css.proposalTitle}>{tt('canvas.proposal.title')}</span>
      {remaining > 0
        ? <span className={css.proposalCount}>{tt('canvas.proposal.more', { count: remaining })}</span>
        : null}
    </div>
    <div className={css.proposalSummary}>{first.summary}</div>
    <div className={css.proposalHint}>{tt('canvas.proposal.notApplied')}</div>
    {error === null ? null : <div className={css.proposalError} role="alert">{error}</div>}
    <div className={css.proposalActions}>
      <button
        type="button"
        className={css.proposalAccept}
        disabled={busy}
        onClick={() => { onAccept?.(first.id) }}
      >{tt('canvas.proposal.accept')}</button>
      <button
        type="button"
        className={css.proposalDiscard}
        disabled={busy}
        onClick={() => { onDiscard?.(first.id) }}
      >{tt('canvas.proposal.discard')}</button>
      {remaining > 0
        ? <button
          type="button"
          className={css.proposalDiscard}
          disabled={busy}
          onClick={() => { onDiscardAll?.() }}
        >{tt('canvas.proposal.discardAll')}</button>
        : null}
    </div>
  </div>
}

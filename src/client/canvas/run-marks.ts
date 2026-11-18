/**
 * 一次运行结束后，画布上该留下什么痕迹。
 *
 * WHY：「节点「X」失败，它下游的 3 个节点没有执行」这句 toast 说完就消失了。
 * 用户回头看这张画布时，看得见的是**一堆卡片**——失败的节点那张和成功的长得
 * 一样（都有产物，因为失败的是这次重跑，旧图还在），被跳过的下游和「还没跑」
 * 长得也一样。于是他要回答「哪些结果不能用」只能去回忆刚才那句提示。
 *
 * 这是工作流画布最该有的东西：**结果的可信度是画布的一部分**，不是一条通知。
 *
 * 三条规矩：
 *
 * 1. **失败的节点和被跳过的节点是两件事。** 前者要重试，后者要等上游好了才
 *    有意义。用同一个红色会把「去点重试」和「这个先别碰」混成一件事。
 * 2. **标记不写进文档。** 它是「刚刚这次运行」的结论，不是画布的持久属性；
 *    存进 `CanvasDocument` 会让它跟着导出、跟着同步、还得有人负责清理。放在
 *    组件状态里，刷新就没了——那正是它该有的寿命。
 * 3. **下一次运行开始时全部清掉。** 留着上一轮的痕迹，新一轮的结论会叠在旧
 *    痕迹上，用户分不清哪个节点是这一轮坏的。
 */

/**
 * 只取需要的那几个字段，不 import `workflow-runner.ts`。
 *
 * WHY：`run-marks.ts` 会在 `node-body.tsx` 里被引用，而那里是客户端渲染路径；
 * 执行器带着 AbortController / 计划 / 并发这些只有运行时才需要的东西。两处
 * 结构上兼容（`WorkflowRunResult` 直接可传），但依赖方向必须保持「渲染 ← 结果」，
 * 不能变成「渲染 → 执行器」。
 */
export interface RunResultShape {
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'cycle'
  failedNodeId?: string
  failedNodeIds: readonly string[]
  blocked: readonly string[]
}

/** 一个节点在最近一次运行里的处境。 */
export type RunMark = 'failed' | 'blocked'

export interface RunMarks {
  /** 这次失败的节点。它们的产物是旧的或没有，需要重试。 */
  failed: ReadonlySet<string>
  /** 这次因为上游失败而没提交的节点。它们连尝试都没有，产物同样不可信。 */
  blocked: ReadonlySet<string>
}

export const EMPTY_RUN_MARKS: RunMarks = { failed: new Set(), blocked: new Set() }

/**
 * 从运行结果算出该标哪些节点。
 *
 * 标记的判据**只有一个**：这个节点的产物还能不能信。
 *
 * 因此 `cancelled` 也留痕——它的 `failedNodeIds` 里装的是「用户在按停之前就
 * 已经失败」的节点，那些失败是真的，产物也不可信。把它们一起抹掉，等于因为
 * 一次取消就把已知的坏结果洗成好的。
 *
 * 不留痕的是另外两种：`completed`（没有失败的）与 `cycle`（一个节点都没提交，
 * 画布上什么都没变——那时该说的是「这张图有问题」，而不是给每张卡挂一个它
 * 没参与过的结论）。
 */
export function runMarksFrom(result: RunResultShape): RunMarks {
  if (result.status === 'completed' || result.status === 'cycle') return EMPTY_RUN_MARKS
  const failed = new Set(result.failedNodeIds)
  // 第一个失败的节点在 `failedNodeId`，它一定也在 `failedNodeIds` 里；这里
  // 兜一手是为了「执行器某个分支只填了前一个字段」这种半成品状态不至于让
  // 画布上一个标记都不出现。
  if (result.failedNodeId !== undefined && result.failedNodeId !== '') failed.add(result.failedNodeId)
  // 一个节点不可能既失败又被跳过：`blocked` 的定义是「没提交」，和「提交了
  // 但失败」互斥。真出现重叠时按 failed 算——失败信息更具体，也更需要动作。
  const blocked = new Set(result.blocked.filter(id => !failed.has(id)))
  return { failed, blocked }
}

/** 某个节点该挂哪种标记；没有就是 null。 */
export function markOf(marks: RunMarks, nodeId: string): RunMark | null {
  if (marks.failed.has(nodeId)) return 'failed'
  if (marks.blocked.has(nodeId)) return 'blocked'
  return null
}

/** 还有没有任何标记——决定要不要渲染「清除标记」这类入口。 */
export function hasMarks(marks: RunMarks): boolean {
  return marks.failed.size > 0 || marks.blocked.size > 0
}

/**
 * 摘掉一个节点的标记。
 *
 * 用途：用户单独重试了那个失败节点，并且它成功了。这时红色还挂着就是在说
 * 「它还是坏的」——而屏幕上明明刚出了一张新图。整轮重跑会清空全部标记，
 * 但单节点重试不该被逼着重跑整张图。
 *
 * 被跳过的下游不跟着消失：上游恢复了不等于下游跑过了，它们仍然没有产物。
 * 那是下一次运行要解决的事。
 */
export function withoutFailed(marks: RunMarks, nodeId: string): RunMarks {
  if (!marks.failed.has(nodeId)) return marks
  const failed = new Set(marks.failed)
  failed.delete(nodeId)
  return { failed, blocked: marks.blocked }
}

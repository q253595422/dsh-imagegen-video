/**
 * 画布工作流执行器：把一张连好的节点图按依赖顺序跑完。
 *
 * 它自己不生成任何东西——生成仍然是 `CanvasWorkspace` 里那条「提交任务 →
 * 轮询回填」的既有链路。执行器只负责**顺序**：哪些节点先跑、哪些可以同时
 * 跑、什么时候停。
 *
 * 这样拆开的原因是复用：分镜已经在跑多镜、单节点已经有重试，执行器不该
 * 再实现第二套生成逻辑，否则视频队列的并发、失败重试和任务找回都会分叉。
 */

import { planWorkflow, type WorkflowEdge } from './workflow-graph.ts'

/** 一个节点的执行结局。 */
export type NodeOutcome =
  /** 跑完了，产出了结果。 */
  | 'done'
  /** 已经有可用的结果，这次复用了它（冻结/缓存）。 */
  | 'cached'
  /** 这个节点本身没法跑（配置不全、输入缺失），但不算整体失败。 */
  | 'skipped'
  /** 失败了；整张图就此停下。 */
  | 'failed'

/** 执行器看到的一步进度，用来更新界面上的运行卡片。 */
export interface WorkflowProgress {
  /** 已跑到第几层（从 0 开始）。 */
  layer: number
  /** 总层数。 */
  total: number
  /** 这一层正在执行的节点。 */
  running: string[]
  /** 整次运行内已经完成的节点数。 */
  done: number
  /** 参与本次运行的节点总数。 */
  count: number
}

export interface WorkflowRunOptions {
  /** 起点：从这些节点开始，只往下游走。 */
  roots: readonly string[]
  /** 画布上的全部节点 id。 */
  nodeIds: readonly string[]
  /** 画布连线。 */
  edges: readonly WorkflowEdge[]
  /**
   * 跑一个节点。实现方负责「提交 + 等到终态」，执行器串行/并行地调它。
   * 抛异常等价于返回 `'failed'`。
   */
  run: (nodeId: string) => Promise<NodeOutcome>
  /** 每一步的进度回调；省略即不关心。 */
  onProgress?: (progress: WorkflowProgress) => void
  /** 用户中断。执行器在层与层之间检查它，不打断已经在跑的节点。 */
  signal?: AbortSignal
}

export interface WorkflowRunResult {
  /** `completed`：全部跑完（可能有 cached/skipped）；`failed`：某一层失败；
   *  `cancelled`：被 signal 中断；`cycle`：图里有环，什么都没跑。 */
  status: 'completed' | 'failed' | 'cancelled' | 'cycle'
  /** 出错的节点，或空。 */
  failedNodeId?: string
  error?: string
  /** 实际跑过（含 cached/skipped）的节点数。 */
  done: number
  /** 环上的节点；只有 status 为 `cycle` 时非空。 */
  cycle: string[]
}

/**
 * 按依赖分层执行一张图。
 *
 * 语义上有四条规矩，都来自「一次运行该付多少代价」这个问题：
 *
 * 1. **层内并行**：同一层的节点互不依赖，一起提交；链越宽跑得越快。
 *    真正的并发上限由生成队列决定（视频是 1），这里不再限流。
 * 2. **层间串行**：下一层要用上一层的产物当输入，必须等整层有结论。
 * 3. **失败即停**：一个节点失败，后面的节点拿不到输入，继续跑只会产生一串
 *    看起来像系统坏了的下游失败。停下来并把失败的节点报回去。
 * 4. **环不算跑过**：图里有环时直接返回 `cycle`，一个节点都不提交——半张
 *    图跑过再报错，用户要自己判断哪些结果是这次产生的。
 */
export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const plan = planWorkflow(options.roots, options.nodeIds, options.edges)
  if (plan.cycle.length > 0) {
    return { status: 'cycle', done: 0, cycle: plan.cycle }
  }
  if (plan.layers.length === 0) return { status: 'completed', done: 0, cycle: [] }

  const total = plan.layers.length
  const count = plan.layers.reduce((sum, layer) => sum + layer.length, 0)
  let done = 0

  for (let index = 0; index < plan.layers.length; index += 1) {
    if (options.signal?.aborted === true) return { status: 'cancelled', done, cycle: [] }
    const layer = plan.layers[index]!
    options.onProgress?.({ layer: index, total, running: layer, done, count })

    // `Promise.all` 而不是 `allSettled`：任一节点失败就该停下，同时其余并行
    // 节点仍然会把它们的请求跑完（生成一旦提交就收不回），所以用 allSettled
    // 收齐，再判断有没有 failed。
    const outcomes = await Promise.allSettled(layer.map(async nodeId => await options.run(nodeId)))
    for (let at = 0; at < outcomes.length; at += 1) {
      const nodeId = layer[at]!
      const outcome = outcomes[at]!
      if (outcome.status === 'rejected') {
        return {
          status: 'failed',
          failedNodeId: nodeId,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          done,
          cycle: [],
        }
      }
      if (outcome.value === 'failed') {
        return { status: 'failed', failedNodeId: nodeId, done, cycle: [] }
      }
      done += 1
    }
    options.onProgress?.({ layer: index, total, running: [], done, count })
  }

  return { status: 'completed', done, cycle: [] }
}

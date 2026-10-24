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

import { downstreamClosure, planWorkflow, upstreamClosure, type WorkflowEdge } from './workflow-graph.ts'

/** 一个节点的执行结局。 */
export type NodeOutcome =
  /** 跑完了，产出了结果。 */
  | 'done'
  /** 已经有可用的结果，这次复用了它（冻结/缓存）。 */
  | 'cached'
  /** 这个节点本身没法跑（配置不全、输入缺失），但不算整体失败。 */
  | 'skipped'
  /** 失败了；它自己的下游就此停下，别的分支照常。 */
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
  /**
   * `completed`：全部跑完（可能有 cached/skipped）；
   * `partial`：有节点失败，但与它无依赖的分支跑完了——不能报成完成，
   *   也不该让调用方以为整张图白跑；
   * `failed`：有节点失败，且没有任何独立分支跑出结果；
   * `cancelled`：被 signal 中断；`cycle`：图里有环，什么都没跑。
   */
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'cycle'
  /** 第一个失败的节点（层内画布顺序），或空。 */
  failedNodeId?: string
  error?: string
  /** 本次失败的全部节点；`failedNodeId` 是其中第一个，两者不会矛盾。 */
  failedNodeIds: string[]
  /** 因为上游失败而没提交的节点：输入永远不会到，跑了只会产生假失败。 */
  blocked: string[]
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
 * 3. **失败只停下游**：一个节点失败，它自己下游的节点拿不到输入，继续跑只会
 *    产生一串看起来像系统坏了的下游失败，所以那些节点不提交；但图上与它无
 *    依赖关系的分支不受牵连——把另一条能跑完的管线一起掐掉，是把一次局部
 *    故障报成了整张图白跑。
 * 4. **环不算跑过**：图里有环时直接返回 `cycle`，一个节点都不提交——半张
 *    图跑过再报错，用户要自己判断哪些结果是这次产生的。
 */
export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const plan = planWorkflow(options.roots, options.nodeIds, options.edges)
  if (plan.cycle.length > 0) {
    return { status: 'cycle', failedNodeIds: [], blocked: [], done: 0, cycle: plan.cycle }
  }
  if (plan.layers.length === 0) return { status: 'completed', failedNodeIds: [], blocked: [], done: 0, cycle: [] }

  const members = plan.layers.flat()
  const total = plan.layers.length
  const count = members.length
  let done = 0
  /** 被上游失败挡住、永远不会提交的节点。 */
  const blocked = new Set<string>()
  /** 真的跑出结果的节点；用来区分「独立分支完成了」和「只是失败节点的上游跑过了」。 */
  const produced = new Set<string>()
  const failed: { nodeId: string; error?: string }[] = []

  for (let index = 0; index < plan.layers.length; index += 1) {
    if (options.signal?.aborted === true) {
      return { status: 'cancelled', failedNodeIds: failed.map(item => item.nodeId), blocked: [...blocked], done, cycle: [] }
    }
    const layer = plan.layers[index]!
    const runnable = layer.filter(nodeId => !blocked.has(nodeId))
    options.onProgress?.({ layer: index, total, running: runnable, done, count })

    // 用 allSettled 而不是 all：同层里一个节点失败，其余节点也已经提交出去
    // （生成一旦发出就收不回），要等它们收齐才能统计这一层真正完成了什么。
    const outcomes = await Promise.allSettled(runnable.map(async nodeId => await options.run(nodeId)))
    // 同层的其他节点不可能是它的下游（层内互不依赖），所以挡住的范围只落在
    // 后面的层。闭包是传递的，下游的下游一并挡住。
    const blockDownstreamOf = (nodeId: string): void => {
      for (const id of downstreamClosure([nodeId], members, options.edges)) {
        if (id !== nodeId) blocked.add(id)
      }
    }
    for (let at = 0; at < outcomes.length; at += 1) {
      const nodeId = runnable[at]!
      const outcome = outcomes[at]!
      if (outcome.status === 'rejected') {
        failed.push({
          nodeId,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
        blockDownstreamOf(nodeId)
        continue
      }
      if (outcome.value === 'failed') {
        failed.push({ nodeId })
        blockDownstreamOf(nodeId)
        continue
      }
      done += 1
      // skipped 是「这个节点本来就不产生调用」（提示词/配置节点），算有结论，
      // 但不算一条分支跑出了东西：拿它当部分成功的依据，等于告诉用户「有结果
      // 了」却拿不出任何产物。
      if (outcome.value !== 'skipped') produced.add(nodeId)
    }
    options.onProgress?.({ layer: index, total, running: [], done, count })
  }

  if (failed.length === 0) return { status: 'completed', failedNodeIds: [], blocked: [], done, cycle: [] }

  // 失败节点的上游是它的输入：上游跑成功也救不回这条链，拿它们证明「有分支
  // 跑完」会把一条断链报成部分成功。只有落在所有失败节点上游闭包之外的完成
  // 节点，才真的是另一条独立管线跑出来了。
  const failedUpstream = new Set<string>()
  for (const item of failed) {
    for (const id of upstreamClosure([item.nodeId], members, options.edges)) failedUpstream.add(id)
  }
  const independentDone = members.some(id => produced.has(id) && !failedUpstream.has(id))

  return {
    status: independentDone ? 'partial' : 'failed',
    failedNodeId: failed[0]!.nodeId,
    error: failed[0]!.error,
    failedNodeIds: failed.map(item => item.nodeId),
    blocked: members.filter(id => blocked.has(id)),
    done,
    cycle: [],
  }
}

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

/** 传给 `run` 的每次调用上下文。 */
export interface RunContext {
  /** 这次是强制重跑：调用方不要复用已有结果。 */
  force: boolean
}

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
   *
   * `context.force` 为真表示这次是**强制重跑**（见 `rerun`）：调用方该跳过
   * 自己的结果复用，重新提交。省略这个参数的对象字面量实现照样能用。
   */
  run: (nodeId: string, context: RunContext) => Promise<NodeOutcome>
  /** 每一步的进度回调；省略即不关心。 */
  onProgress?: (progress: WorkflowProgress) => void
  /** 用户中断。执行器在层与层之间检查它，不打断已经在跑的节点。 */
  signal?: AbortSignal
  /**
   * 新一轮里可以直接复用的节点：不调用 `run`，按 `cached` 计。
   *
   * 典型来源是上一轮的 `done` / `cached` 结论——续跑时它们已经有产物了，
   * 再提交一次既慢又费钱。落在 `rerun` 下游闭包里的节点优先按强制重跑处理，
   * 复用让位。
   */
  reuse?: readonly string[]
  /**
   * 必须重跑的节点：这些节点**以及它们的下游**会以 `context.force = true`
   * 提交，且不会被 `reuse` 跳过。
   *
   * 为什么要带上下游：改了上游的输入，下游拿到的是旧产物，复用它们等于把
   * 一次修改报成「没变化」。
   */
  rerun?: readonly string[]
  /**
   * 层内并发上限。默认不限（跟以前一样整层一起提交）。
   *
   * 层内本来就是并行提交的，真正的排队由生成队列决定；这里给的是「我想
   * 少触发几次上游」时的闸门，比如整层二十个图节点、只想同时发三个。
   * 小于 1 或非整数按 1 处理。
   */
  maxParallel?: number
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
 * 并发上限版的 `Promise.allSettled`：结果顺序与输入一一对应。
 *
 * 自己写而不是引依赖：这里需要的语义很窄——按序取任务、最多 `width` 个在飞、
 * 失败不打断其余。`width` 不小于任务数时，行为与一次性全提交完全一致。
 */
async function settleLimited<T>(
  tasks: readonly (() => Promise<T>)[],
  width: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const at = next
      next += 1
      if (at >= tasks.length) return
      try {
        results[at] = { status: 'fulfilled', value: await tasks[at]!() }
      } catch (reason) {
        results[at] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker))
  return results
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
  // 复用集与强制重跑集：前者不提交，后者带 force 提交。重跑的中下游闭包
  // 在同一张 members 上算，图外的起点不产生影响。
  const reuse = new Set(options.reuse ?? [])
  const forced = new Set<string>()
  for (const root of options.rerun ?? []) {
    for (const id of downstreamClosure([root], members, options.edges)) forced.add(id)
  }
  /** 这一轮真正要提交的节点；复用的节点直接算有结论。 */
  const isReused = (nodeId: string): boolean => reuse.has(nodeId) && !forced.has(nodeId)
  const width = Math.max(1, Math.floor(options.maxParallel ?? Infinity) || 1)
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
    // 被上游挡住的先剔除；没被挡住又在复用集里的，直接记 cached，不提交。
    const pending = layer.filter(nodeId => !blocked.has(nodeId))
    const runnable: string[] = []
    for (const nodeId of pending) {
      if (!isReused(nodeId)) {
        runnable.push(nodeId)
        continue
      }
      done += 1
      produced.add(nodeId)
    }
    options.onProgress?.({ layer: index, total, running: runnable, done, count })

    // 用 allSettled 而不是 all：同层里一个节点失败，其余节点也已经提交出去
    // （生成一旦发出就收不回），要等它们收齐才能统计这一层真正完成了什么。
    const outcomes = await settleLimited(
      runnable.map(nodeId => async () => await options.run(nodeId, { force: forced.has(nodeId) })),
      width,
    )
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

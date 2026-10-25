/**
 * 工作流图的调度规划：把画布上的一张有向图排成可以逐层执行的顺序。
 *
 * 这里只做图论，不碰生成、不碰画布状态——它要能被离线脚本直接调用，
 * 所以不 import 任何 client 模块。
 *
 * 分层（而不是排成一条直线）是有意的：同一层里的节点互相不依赖，执行器
 * 可以把它们一起提交，链路越宽跑得越快。
 */

/** 一条连线的最小形状；与 `CanvasConnection` 结构兼容，但不依赖它。 */
export interface WorkflowEdge {
  fromNodeId: string
  toNodeId: string
}

export interface WorkflowPlan {
  /** 逐层可执行的节点 id；层内顺序即画布顺序，便于稳定复现。 */
  layers: string[][]
  /** 被调用者要求执行、但排在环里的节点 id；非空说明这张图跑不通。 */
  cycle: string[]
}

/**
 * 把连线整理成邻接表。
 *
 * `direction` 决定沿哪个方向走：`down` 是下游（产物往哪流），`up` 是上游
 * （输入从哪来）。自环直接丢掉——它属于环，执行器不会跑它，遍历时把它当成
 * 一条边只会让「可达」多出几个本来跑不起来的节点。
 *
 * @param known - 参与本次遍历的节点集合；两端有一端不在里面的连线一律忽略。
 * @param edges - 画布连线。
 * @param direction - 沿产物方向（down）还是沿输入方向（up）走。
 */
function adjacencyOf(
  known: ReadonlySet<string>,
  edges: readonly WorkflowEdge[],
  direction: 'down' | 'up',
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of edges) {
    if (!known.has(edge.fromNodeId) || !known.has(edge.toNodeId)) continue
    if (edge.fromNodeId === edge.toNodeId) continue
    const key = direction === 'down' ? edge.fromNodeId : edge.toNodeId
    const next = direction === 'down' ? edge.toNodeId : edge.fromNodeId
    const list = map.get(key)
    if (list === undefined) map.set(key, [next])
    else if (!list.includes(next)) list.push(next)
  }
  return map
}

/**
 * 从起点沿邻接表做一次广度优先遍历。
 *
 * 结果按 `order` 排序：调用方传的是画布顺序或分层顺序，遍历顺序不影响结论，
 * 但输出稳定才能让断言和界面提示对得上。
 */
function reachableFrom(
  roots: readonly string[],
  known: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, string[]>,
  order: readonly string[],
): string[] {
  const seen = new Set<string>()
  const queue: string[] = []
  for (const root of roots) {
    if (!known.has(root) || seen.has(root)) continue
    seen.add(root)
    queue.push(root)
  }
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  // 按画布顺序返回，让执行顺序与眼睛看到的排列一致。
  return order.filter(id => seen.has(id))
}

/**
 * 收集起点节点在图上能到达的全部节点（含起点自己）。
 *
 * 只沿连线方向走下游：工作流执行器的语义是「从改动点往下重跑」，上游是
 * 输入，不该被这次运行连带重生成。
 *
 * @param roots - 起点节点 id；不在 `nodeIds` 里的会被忽略。
 * @param nodeIds - 画布当前存在的全部节点 id。
 * @param edges - 画布连线。
 */
export function downstreamClosure(
  roots: readonly string[],
  nodeIds: readonly string[],
  edges: readonly WorkflowEdge[],
): string[] {
  const known = new Set(nodeIds)
  return reachableFrom(roots, known, adjacencyOf(known, edges, 'down'), nodeIds)
}

/**
 * 收集这些节点在图上依赖的全部节点（含它们自己）。
 *
 * 执行器需要它来判断「这次失败到底废掉了什么」：一个失败节点的上游是它
 * 的输入，跑成功了也救不了它，不能拿上游的成功来证明整张图没全废。
 *
 * @param roots - 起点节点 id；不在 `nodeIds` 里的会被忽略。
 * @param nodeIds - 参与判断的节点 id。
 * @param edges - 画布连线。
 */
export function upstreamClosure(
  roots: readonly string[],
  nodeIds: readonly string[],
  edges: readonly WorkflowEdge[],
): string[] {
  const known = new Set(nodeIds)
  return reachableFrom(roots, known, adjacencyOf(known, edges, 'up'), nodeIds)
}

/**
 * 把一组节点按依赖关系分层。
 *
 * 每一层里的节点互不依赖。`cycle` 非空时，那些节点永远不会出现在 `layers`
 * 里——调用者必须把环当成错误报出去，而不是跑一半。
 *
 * 重复的连线（同一对节点之间连了两根）会被合并：依赖只需要满足一次。
 *
 * @param nodeIds - 参与本次执行的节点；集合外的连线一律忽略。
 * @param edges - 画布连线。
 */
export function planLayers(nodeIds: readonly string[], edges: readonly WorkflowEdge[]): WorkflowPlan {
  const members = new Set(nodeIds)
  const dependencies = new Map<string, Set<string>>()
  const children = new Map<string, Set<string>>()
  for (const id of nodeIds) {
    dependencies.set(id, new Set())
    children.set(id, new Set())
  }
  for (const edge of edges) {
    if (!members.has(edge.fromNodeId) || !members.has(edge.toNodeId)) continue
    // 自环不跳过：它意味着「这个节点依赖自己的产物」，第一次运行永远等不到
    // 输入，属于环的一种。跳过它会让执行器把节点当成无依赖直接跑掉。
    dependencies.get(edge.toNodeId)!.add(edge.fromNodeId)
    children.get(edge.fromNodeId)!.add(edge.toNodeId)
  }
  // Kahn 分层，但一次取走「当前整层」而不是单个节点，这样不需要额外的
  // 深度标记就能得到分层结果。
  const remaining = new Map<string, number>()
  for (const id of nodeIds) remaining.set(id, dependencies.get(id)!.size)
  const ready = nodeIds.filter(id => remaining.get(id) === 0)
  const layers: string[][] = []
  const done = new Set<string>()
  while (ready.length > 0) {
    const layer = ready.splice(0, ready.length)
    layers.push(layer)
    for (const id of layer) done.add(id)
    for (const id of layer) {
      for (const child of children.get(id)!) {
        if (done.has(child)) continue
        const left = (remaining.get(child) ?? 0) - 1
        remaining.set(child, left)
        if (left === 0) ready.push(child)
      }
    }
  }
  const cycle = nodeIds.filter(id => !done.has(id))
  return { layers, cycle }
}

/**
 * 一次执行的整体计划：起点 + 下游闭包 + 分层。
 *
 * 闭包为空（起点都不在画布上）时返回空计划，`cycle` 也为空——「没有可跑的
 * 东西」和「图里有个环」是两种不同的失败，调用者要分别给不同的提示。
 */
export function planWorkflow(
  roots: readonly string[],
  nodeIds: readonly string[],
  edges: readonly WorkflowEdge[],
): WorkflowPlan {
  const members = downstreamClosure(roots, nodeIds, edges)
  if (members.length === 0) return { layers: [], cycle: [] }
  return planLayers(members, edges)
}

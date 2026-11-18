/**
 * 画布体检：在按下「运行工作流」之前/之后，把这张图**结构上**会在哪里跑不动
 * 一次算清楚。
 *
 * WHY 需要它：执行器的报错是「跑到哪一步才说哪一步坏了」，而用户面对的是一整
 * 张图。同一张图里既有环、又有一根指向已删除节点的残线时，逐个报错意味着改一
 * 个、再跑一次、再撞下一个——体检要把这些一次全列出来。
 *
 * 三条边界（与执行器、`arrange-model.ts` 保持同一口径）：
 *
 * - 环的判定直接复用 `planLayers`，不另写一份。执行器把哪些节点排不进层，
 *   这里就报哪些节点跑不起来；两份图论逻辑迟早会分叉成「体检说能跑、按下却
 *   失败」。
 * - **残线不算流程。** 一端指向已删除节点的连线单独报 `danglingEdge`，但绝
 *   不因为它把某个节点算成「有上下游」。否则删掉一个节点之后，留在原地的图
 *   片会被当成还接着线，孤立产物就再也不会被提醒。
 * - 这里只产出**文案 key 和参数**，不产出中文。文案要进三语表、要能跟着界面
 *   语言切换，而中文一旦写死在这个纯模块里，三语就会有一路永远是英文/中文。
 *   同理：不 import 任何 `.tsx`、不碰 DOM，这个文件要能在 Node 里直接跑。
 */

import type { CanvasConnection, CanvasNode } from '../../protocol.ts'
import { planLayers } from '../workflow-graph.ts'

export type GraphIssueKind =
  | 'cycle'
  | 'danglingEdge'
  | 'blockedConfig'
  | 'orphanImage'
  | 'emptyConfig'

/**
 * 这条问题的说明文案 key。
 *
 * 只有这五个 key：调用方负责往三语表里加对应句子，参数由 `detailValues` 给。
 */
export type GraphIssueDetailKey =
  | 'graph.issue.cycle'
  | 'graph.issue.danglingEdge'
  | 'graph.issue.emptyConfig'
  | 'graph.issue.blockedConfig'
  | 'graph.issue.orphanImage'

export interface GraphIssue {
  kind: GraphIssueKind
  /** 涉及哪些节点；`cycle` / `danglingEdge` 可能多于一端。 */
  nodeIds: readonly string[]
  /** 严重度：`blocking` = 按下运行就会失败或白跑；`advisory` = 能跑但可能是笔误。 */
  severity: 'blocking' | 'advisory'
  /** 这条问题**为什么**存在的一句话说明用的 key（不是我该拼中文的地方，见下）。 */
  detailKey: GraphIssueDetailKey
  /** 给 detailKey 填的参数，例如 { count: 3 }、{ title: '节点名' }。 */
  detailValues?: Record<string, string | number>
}

export interface GraphHealth {
  issues: GraphIssue[]
  /** 阻断项数量。0 = 结构上可以放心按运行。 */
  blocking: number
  /** 体检过多少配置节点（用来区分「全绿」和「没有可体检的东西」）。 */
  checkedConfigs: number
}

/**
 * 严重度排序：阻断项永远在前。
 *
 * 用户打开体检面板时先看到的是第一屏；一条「这张图有环」如果排在「有张图没人
 * 用」后面，他可能根本滚不到那条真正不能跑的。
 */
const SEVERITY_RANK: Record<GraphIssue['severity'], number> = { blocking: 0, advisory: 1 }

/**
 * 同类严重度里的展示顺序：从「整张图跑不了」到「可能只是没收尾」。
 *
 * 这个顺序同时是**输出稳定**的一部分：同一张图两次体检必须逐字节相同，否则
 * 界面会无意义地重排、快照测试也会闪。所以排序键必须覆盖所有类别，而不是
 * 依赖问题的生成顺序。
 */
const KIND_RANK: Record<GraphIssueKind, number> = {
  cycle: 0,
  danglingEdge: 1,
  emptyConfig: 2,
  blockedConfig: 3,
  orphanImage: 4,
}

/**
 * 字符串比较。
 *
 * 不用 `localeCompare`：它的结果依赖运行时 locale，同一张图在不同机器上可能
 * 排出不同顺序，而这里要的是跨环境逐字节一致。
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareIssues(a: GraphIssue, b: GraphIssue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    // 同类里按第一个涉及节点的 id 排；两端都不存在的残线用空串，稳定地排在最前。
    || KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || compareText(a.nodeIds[0] ?? '', b.nodeIds[0] ?? '')
    // 第一个 id 相同时再看整串，防止「同一个节点上的多条残线」互相比大小。
    || compareText(a.nodeIds.join('\u0000'), b.nodeIds.join('\u0000'))
  )
}

/**
 * 从 `planLayers` 报出的「排不进层」的节点里，摘出**真正在环上**的那些。
 *
 * `planLayers().cycle` 是「Kahn 结束后还没被取走的全部节点」，它同时包含环上
 * 节点和挂在环后面的下游——后者自身不在环里，只是永远等不到入边。界面给这些
 * 节点描红时说的是「这几个连成了环」，把下游也描上等于指错了人；用户顺着高亮
 * 去找那根首尾相接的线时会找不到。
 *
 * 判定很直接：只在环候选集内部连边，一个节点能沿出边走回自己就在环上。
 * 自环天然满足（第一步就回到自己）。
 */
function nodesOnCycle(cycleIds: readonly string[], edges: readonly CanvasConnection[]): string[] {
  const stuck = new Set(cycleIds)
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!stuck.has(edge.fromNodeId) || !stuck.has(edge.toNodeId)) continue
    const list = outgoing.get(edge.fromNodeId)
    if (list === undefined) outgoing.set(edge.fromNodeId, [edge.toNodeId])
    else list.push(edge.toNodeId)
  }

  const onCycle: string[] = []
  for (const start of cycleIds) {
    const seen = new Set<string>()
    const queue = [...(outgoing.get(start) ?? [])]
    let closes = false
    while (queue.length > 0) {
      const id = queue.shift()!
      if (id === start) {
        closes = true
        break
      }
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(outgoing.get(id) ?? []))
    }
    if (closes) onCycle.push(start)
  }
  return onCycle
}

/**
 * 只做结构检查（环、残线、孤立图片、空配置），不需要模型/渠道信息。
 *
 * `checkedConfigs` 数的是**画布上的配置节点**，不是「有就绪结果的那些」：
 * 全绿（配置都能跑）和没有可体检的东西（一张配置都没有）在界面上是两句话，
 * 这个数字就是用来分开它们的。
 */
export function structuralHealth(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
): GraphHealth {
  // 空画布不是「一张有问题的图」：没有节点就没有流程可跑，报什么都只是噪声。
  // 这里也顺带保证 `checkedConfigs` 是 0，调用方可以据此显示「先加点东西」。
  if (nodes.length === 0) return { issues: [], blocking: 0, checkedConfigs: 0 }

  const byId = new Set(nodes.map(node => node.id))
  const issues: GraphIssue[] = []
  // 两端都在画布上的连线。`planLayers` 自己也会过滤残线，但这里需要同一份
  // 「有效连线」来判断入边/出边，过滤一次、两处共用，避免口径分叉。
  const live: CanvasConnection[] = []
  const incoming = new Set<string>()
  const outgoing = new Set<string>()

  for (const connection of connections) {
    const hasFrom = byId.has(connection.fromNodeId)
    const hasTo = byId.has(connection.toNodeId)
    if (!hasFrom || !hasTo) {
      // 每一条残线单独一条问题：两条残线可能删的是两个不同节点，合成一条会让
      // 用户只修好其中一个。`nodeIds` 只放**还在画布上的那一端**；两端都没了
      // 就放空数组——那个节点已经没有卡片可以高亮了，但连线本身仍要能被删掉。
      issues.push({
        kind: 'danglingEdge',
        nodeIds: hasFrom ? [connection.fromNodeId] : hasTo ? [connection.toNodeId] : [],
        severity: 'blocking',
        detailKey: 'graph.issue.danglingEdge',
      })
      continue
    }
    live.push(connection)
    outgoing.add(connection.fromNodeId)
    incoming.add(connection.toNodeId)
  }

  const plan = planLayers(nodes.map(node => node.id), live)
  if (plan.cycle.length > 0) {
    // `planLayers` 说这些节点排不进任何一层。正常情况下 `nodesOnCycle` 一定
    // 找得到至少一个环；万一将来分层实现变了、返回了一个非空的「卡住集合」却
    // 没有闭合边，退回到整份集合也比静默吞掉一条 blocking 更安全。
    const ring = nodesOnCycle(plan.cycle, live)
    const nodeIds = (ring.length > 0 ? ring : plan.cycle).slice().sort(compareText)
    issues.push({
      kind: 'cycle',
      nodeIds,
      severity: 'blocking',
      detailKey: 'graph.issue.cycle',
      // 环的条数是文案里唯一能变的数字（`{count} 个节点互相绕成了环`）。
      // 由这里填而不是让调用方按 kind 自己数：调用方数的是 `nodeIds.length`，
      // 与文案说的「几个节点」是同一件事，两处各算一次迟早会分叉。
      detailValues: { count: nodeIds.length },
    })
    // 有环时**继续**往下检查：用户要一次看全，而不是修好环、再跑一次、再撞上
    // 一根残线。这也是「体检」和「执行器报错」的区别。
  }

  let checkedConfigs = 0
  for (const node of nodes) {
    if (node.type === 'config') {
      checkedConfigs += 1
      if (!incoming.has(node.id)) {
        // 取舍：配置节点自己在 `metadata.text` 里写了提示词，**仍然**报
        // emptyConfig。这条问题的措辞是「没有上游输入」，不是「没有提示词」。
        // 没有上游就拿不到上游文本、拿不到参考图；而一张孤零零摆在画布上的
        // 配置节点，十有八九是线还没连，不是用户故意要文生图。报出来是让他
        // 确认，不是断言他少写了字——文案必须按「缺上游」来写。
        issues.push({
          kind: 'emptyConfig',
          nodeIds: [node.id],
          severity: 'blocking',
          detailKey: 'graph.issue.emptyConfig',
        })
      }
    } else if (node.type === 'image') {
      // 只有真有 asset 的图片才可能成为孤立产物。空图片节点是「还没填」的占位，
      // 新拖一张卡进来就会触发一条灰字提示，全是噪声。
      const assetUrl = node.metadata?.asset?.url ?? ''
      if (assetUrl !== '' && !incoming.has(node.id) && !outgoing.has(node.id)) {
        issues.push({
          kind: 'orphanImage',
          nodeIds: [node.id],
          severity: 'advisory',
          detailKey: 'graph.issue.orphanImage',
        })
      }
    }
  }

  issues.sort(compareIssues)
  return {
    issues,
    blocking: issues.filter(issue => issue.severity === 'blocking').length,
    checkedConfigs,
  }
}

/**
 * 结构检查 + 就绪检查。readiness 由调用方用 `scanConfigReadiness` 算好传进来。
 *
 * WHY 分开传：判断「能不能生成」需要模型、渠道、当前选中的编辑框，那些都在
 * 画布上下文里；这个文件只接一个已经算好的 `Map`，所以它仍然能在 Node 里被
 * 单测，也不会把渠道探测拖进体检模块。
 *
 * 就绪结果里没有这条配置节点时**不算** blocked：`structuralHealth` 本来就
 * 不知道模型/渠道，而调用方传一份不完整的 map 时，把「没查过」当成「坏了」
 * 会凭空多出一堆红点。
 */
export function fullHealth(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  readiness: ReadonlyMap<string, { ready: boolean; blockers: readonly string[] }>,
): GraphHealth {
  const base = structuralHealth(nodes, connections)
  if (nodes.length === 0) return base

  const issues = base.issues.slice()
  for (const node of nodes) {
    if (node.type !== 'config') continue
    const state = readiness.get(node.id)
    if (state === undefined || state.ready) continue
    issues.push({
      kind: 'blockedConfig',
      nodeIds: [node.id],
      severity: 'blocking',
      detailKey: 'graph.issue.blockedConfig',
      // 用逗号拼成一个字符串而不是数组：`detailValues` 只收字符串/数字，
      // 文案里是「缺 {blockers}」这样一个洞，调用方不必为每个阻塞项各写一句。
      detailValues: { blockers: state.blockers.join(',') },
    })
  }

  issues.sort(compareIssues)
  return {
    issues,
    blocking: issues.filter(issue => issue.severity === 'blocking').length,
    checkedConfigs: base.checkedConfigs,
  }
}

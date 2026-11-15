/**
 * Agent-facing canvas tools: let the Agent read and shape a canvas graph.
 *
 * Deliberately **read + structure only**. There is no tool here that starts a
 * render. Generation costs the user money, and a model that can悄悄 spend it on
 * its own is a product decision no one has made: the Agent may lay out a graph,
 * write prompts into it and wire the nodes, and then the user presses run in the
 * canvas. Anything that submits a task belongs to `agent-image-tools.ts` /
 * `agent-video-tools.ts`, where the user asked for it explicitly.
 *
 * ## Writes are proposals
 *
 * A write tool does NOT touch the user's canvas. It records what it would
 * change in `canvas/proposals/` and reports back; the canvas window shows the
 * pending changes and the user accepts or discards them. The reason is not
 * politeness: the Agent runs while the user is away, and an edit that only
 * needs an optimistic lock is still an edit the user never agreed to.
 *
 * `DSH_CANVAS_AGENT_AUTO_APPLY=1` opts out and restores the old direct-write
 * behaviour, for scripted use where nobody is there to press accept. It is an
 * environment variable rather than a tool argument on purpose: a model must
 * not be able to grant itself the permission.
 *
 * When a proposal is accepted, the client applies it through
 * `CanvasStore.save(document, expectedRevision)` — the same optimistic lock
 * that protects the canvas window, so an edit the user made in between fails
 * loudly instead of being overwritten.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { canvasStore, CanvasConflictError } from './canvas-store.ts'
import { ProposalStore, proposalStore, type CanvasProposalChange } from './canvas-proposal-store.ts'
import { CONNECTION_ROLES, roleOf, withRole } from './client/canvas/connection-role.ts'
import type {
  CanvasConnectionRole,
  CanvasDocument,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasNodeType,
  CanvasProposalCounts,
  CanvasProposalNodeUpdate,
  CanvasSummary,
} from './protocol.ts'

/** Node types an Agent may create. `config` is included: a config node is how a
 *  prompt + model pair waits for the user to press run. */
const NODE_TYPES: readonly CanvasNodeType[] = ['image', 'text', 'file', 'config', 'video', 'storyboard']

/**
 * Default node footprints, mirroring the client's constants
 * (`src/client/CanvasWorkspace.tsx`: IMAGE_NODE_SIZE and friends).
 *
 * Duplicated rather than imported because the client module pulls in React and
 * the whole canvas renderer; a host-side tool must stay importable on its own.
 * If a size changes there, change it here too — the canvas clamps to these when
 * a node arrives without explicit dimensions.
 */
const DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  image: { width: 240, height: 240 },
  text: { width: 280, height: 150 },
  file: { width: 300, height: 170 },
  config: { width: 320, height: 190 },
  video: { width: 272, height: 153 },
  storyboard: { width: 380, height: 420 },
}

/**
 * 自动摆放新节点时的列间距。与画布自己的 `NODE_GAP`（CanvasWorkspace.tsx）
 * 取同一个值：同一张画布上，Agent 加的节点和用户手动加的节点应当看起来是
 * 同一个东西摆出来的。
 */
const NODE_COLUMN_GAP = 90

/**
 * 新节点该放的 x：现有节点最右边再留一列间距。
 *
 * 空画布从 0 开始；有节点就接在最右那个后面。只算 x 是因为「省略 x/y」的
 * 承诺是「放到右边的一列」，纵向从 0 起就够——真要让多个新节点上下排开，那是
 * 布局问题，不该由这个工具猜。
 */
function nextColumnX(document: CanvasDocument): number {
  if (document.nodes.length === 0) return 0
  return Math.max(...document.nodes.map(node => node.x + node.width)) + NODE_COLUMN_GAP
}

/**
 * One node as the Agent sees it: ids to wire with, metadata to reason about.
 *
 * `type` is plain `string` rather than `CanvasNodeType` because the tool's
 * output schema is what the render callback receives, and the schema can only
 * say "string". Stored nodes still carry the narrow union.
 */
interface AgentNode {
  id: string
  type: string
  title: string
  x: number
  y: number
  width: number
  height: number
  prompt?: string
  model?: string
  text?: string
  status?: string
  /** config 节点：它会产出什么（image / video / text）。 */
  mode?: string
}

interface AgentEdge {
  id: string
  from: string
  to: string
  /**
   * Absent means the historical 「just an input」 meaning. Only video
   * generation reads it: `first` / `last` decide which two pictures the
   * interpolation uses, so a graph can finally say that out loud instead of
   * relying on the order of the connections array.
   */
  role?: CanvasConnectionRole
}

interface AgentCanvasView {
  id: string
  title: string
  revision: number
  nodes: AgentNode[]
  connections: AgentEdge[]
  /** Actionable note when the graph cannot run as laid out, or that this is a
   *  pending proposal rather than a saved change. */
  note?: string
  /** Present when the call produced a proposal; the canvas shows it for accept. */
  proposalId?: string
}

const nodeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    type: { type: 'string', required: true },
    title: { type: 'string', required: true },
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    prompt: { type: 'string' },
    model: { type: 'string' },
    text: { type: 'string' },
    status: { type: 'string' },
    mode: { type: 'string' },
  },
} as const

const canvasViewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    nodes: { type: 'array', required: true, items: nodeSchema },
    connections: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          role: { type: 'string' },
        },
      },
    },
    note: { type: 'string' },
    /** Set when this call produced a pending change instead of saving one. */
    proposalId: { type: 'string' },
  },
} as const

const canvasSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    nodeCount: { type: 'integer', required: true },
    /** 待用户接受的改动条数。0 表示没有。 */
    pending: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
  },
} as const

/** Project one stored node into the Agent's view. */
function projectNode(node: CanvasNode): AgentNode {
  const metadata = node.metadata ?? {}
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...metadata.prompt === undefined ? {} : { prompt: metadata.prompt },
    ...metadata.model === undefined ? {} : { model: metadata.model },
    ...metadata.text === undefined ? {} : { text: metadata.text },
    ...metadata.status === undefined ? {} : { status: metadata.status },
    // config 节点靠 `mode` 决定它产出什么（出图 / 出视频 / 纯写作）。不投影
    // 它，模型只看到「这是个 config」，判断不出按 run 会得到图片还是视频——
    // 而这正是它接下来要不要连线、要不要写 prompt 的依据。
    ...metadata.mode === undefined ? {} : { mode: metadata.mode },
  }
}

/**
 * A note the Agent can act on rather than a bare graph dump: an unconnected
 * config node will never produce anything, and a cycle cannot run at all.
 */
function noteFor(nodes: readonly CanvasNode[], connections: readonly { fromNodeId: string; toNodeId: string }[]): string | undefined {
  if (nodes.length === 0) return 'This canvas is empty. Create nodes, wire them, then tell the user to press run.'
  const targets = new Set(connections.map(edge => edge.toNodeId))
  const sources = new Set(connections.map(edge => edge.fromNodeId))
  const terminals = nodes.filter(node => !sources.has(node.id) && node.type !== 'file' && node.type !== 'text')
  const orphans = nodes.filter(node => !targets.has(node.id) && !sources.has(node.id))
  const parts: string[] = []
  if (terminals.length > 0) {
    parts.push(`${terminals.length} node(s) have no downstream connection: ${terminals.map(node => `${node.id} (${node.type})`).join(', ')}.`)
  }
  if (orphans.length > 0) {
    parts.push(`${orphans.length} node(s) are not wired to anything: ${orphans.map(node => node.id).join(', ')}.`)
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

/**
 * 直接写回的兼容开关。
 *
 * 默认**关**：Agent 的改动一律先成提案。把它设成 1 的只有一种场景——脚本
 * 或 CI 里跑、没有人能点「接受」。刻意不给工具参数：模型不该能自己给自己
 * 发这个权限。
 */
const AUTO_APPLY = process.env.DSH_CANVAS_AGENT_AUTO_APPLY === '1'

/**
 * 算出草稿相对原稿的差异。没有差异返回 `undefined`。
 *
 * 比的是节点 id 集合与每个节点的**内容**，不是引用：`edit` 可能重建了整个
 * 数组，只要内容一样就不该算一次改动。排序稳定，免得同一份内容因为数组顺序
 * 不同被判成变了。
 *
 * ## 改过的节点记成字段补丁，不是整份节点
 *
 * 这是本轮修掉的一个真实缺陷：整份节点意味着接受时用「起草那一刻的完整
 * 节点」替换文档里的节点，用户在这之后拖过的坐标会被一起回退。探针实测过：
 * 节点被拖到 1234,567，接受一条「改标题」的提案后回到 100,100——静默发生，
 * 而界面还写着「接受之前画布不会有任何变化」。
 *
 * 补丁只点名 Agent 真正改过的键。`metadata` 也逐键比：整份 `metadata` 会把
 * 用户之后写上去的其它字段（换过的模型、刚点上的 cast）抹掉。
 */
function diffOf(before: CanvasDocument, after: CanvasDocument): CanvasProposalChange | undefined {
  const beforeById = new Map(before.nodes.map(node => [node.id, node]))
  const afterById = new Map(after.nodes.map(node => [node.id, node]))

  const addedNodes = after.nodes.filter(node => !beforeById.has(node.id))
  const updatedNodes = after.nodes.flatMap(node => {
    const original = beforeById.get(node.id)
    if (original === undefined) return []
    const patch = nodePatchOf(original, node)
    return patch === undefined ? [] : [patch]
  })
  const removedNodeIds = before.nodes.filter(node => !afterById.has(node.id)).map(node => node.id)

  const beforeEdges = new Map(before.connections.map(edge => [edge.id, edge]))
  const afterEdges = new Map(after.connections.map(edge => [edge.id, edge]))
  const addedConnections = after.connections.filter(edge => !beforeEdges.has(edge.id))
  // 连线**改了内容**（今天只有角色）此前完全不算改动：`diffOf` 只比 id 集合，
  // 于是「把这条边设成首帧」在 `mutate` 眼里什么都没发生，工具回一句
  // 「This call changed nothing」，而视频插帧读的正是 role。角色按
  // `withRole` 的语义比：`'input'` 与「没有 role」等价，其余逐个比。
  const updatedConnections = after.connections.flatMap(edge => {
    const original = beforeEdges.get(edge.id)
    if (original === undefined) return []
    const role = roleOf(edge) === roleOf(original) ? undefined : roleOf(edge)
    return role === undefined ? [] : [{ id: edge.id, role }]
  })
  // 连线消失有两种原因：用户明确断开，或者它的某一端被删了。后者 `apply`
  // 在删节点时本来就会连带过滤掉，列出来只会让提案条多出一句「断开 N 条
  // 线」——用户看到「删除 1 个节点、断开 1 条线」会以为自己漏了一条改动。
  // 只报「两端都还在、却没了」的那些。
  const goneNodes = new Set(removedNodeIds)
  const removedConnectionIds = before.connections
    .filter(edge => !afterEdges.has(edge.id))
    .filter(edge => !goneNodes.has(edge.fromNodeId) && !goneNodes.has(edge.toNodeId))
    .map(edge => edge.id)

  const title = before.title === after.title ? undefined : after.title

  if (addedNodes.length === 0 && updatedNodes.length === 0 && removedNodeIds.length === 0
    && addedConnections.length === 0 && updatedConnections.length === 0
    && removedConnectionIds.length === 0 && title === undefined) {
    return undefined
  }
  return {
    ...addedNodes.length === 0 ? {} : { addedNodes },
    ...updatedNodes.length === 0 ? {} : { updatedNodes },
    ...removedNodeIds.length === 0 ? {} : { removedNodeIds },
    ...addedConnections.length === 0 ? {} : { addedConnections },
    ...updatedConnections.length === 0 ? {} : { updatedConnections },
    ...removedConnectionIds.length === 0 ? {} : { removedConnectionIds },
    ...title === undefined ? {} : { title },
  }
}

/**
 * 两个节点之间的字段补丁；没有差异返回 `undefined`。
 *
 * `metadata` 逐键比，不整体比：把整个对象塞进补丁等于让「改一个 prompt」
 * 顺带覆盖用户之后在这个节点上写的所有其它元数据。
 */
function nodePatchOf(before: CanvasNode, after: CanvasNode): CanvasProposalNodeUpdate | undefined {
  const fields: NonNullable<CanvasProposalNodeUpdate['fields']> = {}
  for (const key of ['title', 'x', 'y', 'width', 'height'] as const) {
    if (before[key] !== after[key]) (fields as Record<string, unknown>)[key] = after[key]
  }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after.metadata ?? {})) {
    const previous = (before.metadata ?? {})[key as never] as unknown
    if (JSON.stringify(previous) !== JSON.stringify(value)) metadata[key] = value
  }
  const removedMetadataKeys = Object.keys(before.metadata ?? {}).filter(key => !(key in (after.metadata ?? {})))

  if (Object.keys(fields).length === 0 && Object.keys(metadata).length === 0 && removedMetadataKeys.length === 0) return undefined
  return {
    id: after.id,
    ...Object.keys(fields).length === 0 ? {} : { fields },
    ...Object.keys(metadata).length === 0 ? {} : { metadata: metadata as CanvasNodeMetadata },
    ...removedMetadataKeys.length === 0 ? {} : { removedMetadataKeys },
  }
}

/**
 * 一句话告诉用户这条提案要做什么，例如「添加 2 个节点、连接 1 条线」。
 *
 * 这是用户在提案条上唯一会读的东西，所以写具体的数量与最常见的动作，
 * 不写「Agent 修改了画布」这种等于没说的句子。
 */
function summarise(tool: string, change: CanvasProposalChange): { summary: string; counts: CanvasProposalCounts } {
  const parts: string[] = []
  const added = change.addedNodes?.length ?? 0
  const updated = change.updatedNodes?.length ?? 0
  const removed = change.removedNodeIds?.length ?? 0
  const wired = change.addedConnections?.length ?? 0
  const rewired = change.updatedConnections?.length ?? 0
  const unwired = change.removedConnectionIds?.length ?? 0
  if (added > 0) parts.push(`添加 ${added} 个节点`)
  if (updated > 0) parts.push(`修改 ${updated} 个节点`)
  if (removed > 0) parts.push(`删除 ${removed} 个节点`)
  if (wired > 0) parts.push(`连接 ${wired} 条线`)
  if (rewired > 0) parts.push(`调整 ${rewired} 条线的角色`)
  if (unwired > 0) parts.push(`断开 ${unwired} 条线`)
  if (change.title !== undefined) parts.push(`改名为「${change.title}」`)
  // `summary` 是给旧客户端 / 旧提案兜底的中文句子；`counts` 才是界面用的。
  // 两者一起写：只写 counts，则升级前的画布窗口（还是旧前端）会显示工具名；
  // 只写 summary，则英文用户永远看到中文。
  return {
    summary: parts.length === 0 ? tool : parts.join('、'),
    counts: {
      ...added === 0 ? {} : { addedNodes: added },
      ...updated === 0 ? {} : { updatedNodes: updated },
      ...removed === 0 ? {} : { removedNodes: removed },
      ...wired === 0 ? {} : { addedConnections: wired },
      ...rewired === 0 ? {} : { updatedConnections: rewired },
      ...unwired === 0 ? {} : { removedConnections: unwired },
      ...change.title === undefined ? {} : { title: change.title },
    },
  }
}

function viewOf(document: CanvasDocument): AgentCanvasView {
  const note = noteFor(document.nodes, document.connections)
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    nodes: document.nodes.map(projectNode),
    connections: document.connections.map((edge): AgentEdge => {
      const role = roleOf(edge)
      const projected: AgentEdge = { id: edge.id, from: edge.fromNodeId, to: edge.toNodeId }
      // Only echo a role that was actually written: a canvas with no roles
      // must come back identical, and `input` is what absence already means.
      return role === 'input' ? projected : { ...projected, role }
    }),
    ...note === undefined ? {} : { note },
  }
}

function renderCanvasView(value: AgentCanvasView): Array<{ type: 'text'; text: string }> {
  const lines = [`Canvas ${value.id}「${value.title}」 revision ${value.revision}: ${value.nodes.length} node(s), ${value.connections.length} connection(s).`]
  for (const node of value.nodes) {
    // config 节点把 mode 并进标签：`[config:video]` 比 `[config]` 多说的是
    // 「这个节点会产出视频」，而模型正是靠它判断该不该往这里连图片。
    const label = node.type === 'config' ? (node.mode === undefined ? 'config' : `config:${node.mode}`) : node.type
    const detail = node.prompt !== undefined ? ` — prompt: ${node.prompt}` : node.text !== undefined ? ` — text: ${node.text}` : ''
    lines.push(`- ${node.id} [${label}] ${node.title} @ (${node.x}, ${node.y})${detail}`)
  }
  for (const edge of value.connections) {
    lines.push(`- ${edge.from} → ${edge.to}${edge.role === undefined ? '' : ` (${edge.role})`}`)
  }
  if (value.note !== undefined) lines.push(value.note)
  lines.push('Nothing here starts a render: open the canvas and press run when you are happy with the graph.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderSummaryList(values: readonly (CanvasSummary & { pending?: number })[]): string {
  if (values.length === 0) return 'There are no canvases yet.'
  return values.map(value => `- ${value.id}「${value.title}」 (${value.nodeCount} nodes, revision ${value.revision}${value.pending === undefined || value.pending === 0 ? '' : `, ${value.pending} change(s) awaiting the user's accept`})`).join('\n')
}

/** Turn a store conflict into copy the model can act on. */
function rethrowConflict(error: unknown): never {
  if (error instanceof CanvasConflictError) {
    throw new Error('The canvas changed since it was read (someone edited it in the canvas window). Read it again and retry the edit.')
  }
  throw error instanceof Error ? error : new Error(String(error))
}

/**
 * Validate a config mode that arrived from the model.
 *
 * 与下面的 `parseRole` 同一个理由：JSON Schema 的 enum 会挡住拼写错误，但不是
 * 每条宿主路径都保证按 schema 校验过参数，而把一个未知字符串写进文档，会让
 * 那份画布在别的机器上变得读不出来。
 */
function parseMode(value: string): 'image' | 'video' | 'text' {
  if (value === 'image' || value === 'video' || value === 'text') return value
  throw new Error(`Unknown config mode "${value}". Use one of: image, video, text.`)
}

/**
 * Validate a role that arrived from the model.
 *
 * The JSON Schema enum already rejects typos, but a tool call is not guaranteed
 * to be schema-checked by every host path, and writing an unknown string into
 * the document would make that canvas unreadable only on machines that later
 * tighten the parser. Reject it here, with the allowed values in the message.
 */
function parseRole(value: string): CanvasConnectionRole {
  const role = (CONNECTION_ROLES as readonly string[]).find(candidate => candidate === value)
  if (role === undefined) {
    throw new Error(`Unknown connection role "${value}". Use one of: ${CONNECTION_ROLES.join(', ')}.`)
  }
  return role as CanvasConnectionRole
}

/**
 * Register the canvas tools.
 *
 * @param ctx - host context whose tool registry receives the definitions.
 * @param config - `enabled` follows the plugin master switch; the tools only
 *   mount when the user has not turned the plugin off.
 * @returns a disposer that unregisters every tool added here.
 */
export function registerAgentCanvasTools(ctx: Context, config: () => { enabled: boolean }): () => void {
  const ensureEnabled = (): void => {
    if (!config().enabled) throw new Error('The image/video plugin is disabled in settings; canvas tools are unavailable.')
  }

  const load = async (canvasId: string): Promise<CanvasDocument> => {
    const document = await canvasStore.read(canvasId)
    if (document === undefined) throw new Error(`Canvas ${canvasId} was not found. Use list_canvases to see the ids.`)
    return document
  }

  /**
   * 真实文档 + 本画布待确认提案 = Agent 应当看到的那份画布。
   *
   * 读与写必须用同一个起点。`mutate` 早就在这份叠加后的草稿上算（否则连着
   * 两步操作里第二步会报「节点不存在」，因为它要连的节点还在提案里），但
   * `read_canvas` 当时走的是只读真实文档的 `load()`——于是 Agent 刚刚提议加了
   * 一个节点，回头一读却是「This canvas is empty」的空白画布，很可能再添加
   * 一遍。探针实测：add → read（0 个节点）→ 再 add，同一个标题落进两条提案。
   *
   * 过期提案（`apply` 返回 undefined：它点名的节点/连线已经不在了）一律跳过
   * 并**移除**，读、写共用这一个行为。
   *
   * 此前写路径是抛错的，理由是「起点不确定时继续算，会把坏掉的差异固化进新
   * 提案里」。但这么做的代价是整张画布对 Agent 失效：探针实测，用户随手删掉
   * 一个提案点名的节点之后，`add_canvas_node` / `update_canvas_node` /
   * `connect_canvas_nodes` **全部**失败，只有用户碰巧去点「接受」才能恢复。
   * 而 `acceptOne` 对同一条提案的判断是：它不可能再生效（`apply` 是纯函数，
   * 只要文档还缺那个节点，以后每一次都会失败），留着只会挡住队列，所以直接
   * 移除。两边对同一件事有两种判断，没有道理——按 `acceptOne` 那条来。
   *
   * 移除是安全的：这条提案在任何后续状态下都不会再应用成功，而用户界面本来
   * 也只让它自己消失（点「接受」→ `proposal-stale` + 移除）。
   */
  const draftOf = async (
    canvasId: string,
  ): Promise<{ document: CanvasDocument; draft: CanvasDocument; pending: number; stale: number }> => {
    const document = await load(canvasId)
    const pending = await proposalStore.list(canvasId)
    let draft: CanvasDocument = document
    let stale = 0
    for (const proposal of pending) {
      const applied = ProposalStore.apply(draft, proposal.change)
      if (applied === undefined) {
        stale += 1
        await proposalStore.remove(proposal.id)
        continue
      }
      draft = applied
    }
    return { document, draft, pending: pending.length, stale }
  }

  /**
   * 让写操作在「真实文档 + 本画布已有提案」之上跑，然后把它带来的变化记成
   * 一条新提案。
   *
   * 为什么要先叠加已有提案：Agent 一次任务里通常连着几步——先
   * `add_canvas_node`，再 `connect_canvas_nodes`。第二步要连的那个节点 id
   * 还不存在于真实文档里（它只在提案里），不叠加就会报「节点不存在」，一整
   * 串操作只有第一步能成立。
   *
   * `edit` 拿到的是一份**可以随便改的草稿**：它改完，这里比对出差异。只要
   * 差异为空（模型让它改的字段本来就是这个值），就不产生提案——用户不该被
   * 一条「什么都没改」的待确认项打断。
   */
  const mutate = async (canvasId: string, tool: string, edit: (document: CanvasDocument) => void): Promise<AgentCanvasView> => {
    const { document, draft, pending, stale } = await draftOf(canvasId)
    // 关键：先**深拷贝**一份再交给 edit。
    //
    // `edit` 是原地改的（`document.nodes.push(...)`），如果 `before` 和它指向
    // 同一个对象，改完之后两边一模一样，`diffOf` 永远算出「没有差异」——工具
    // 报告成功、实际上什么都没记下来。这个错很安静：类型对、测试跑得动、界面
    // 上只是那条提案不出现。
    const before = structuredClone(draft)
    edit(draft)
    const change = diffOf(before, draft)

    if (AUTO_APPLY) {
      // 兼容通道：没有人值守的脚本场景，直接写回，行为与改造前一致。
      try {
        return viewOf(await canvasStore.save(draft, document.revision))
      } catch (error) {
        rethrowConflict(error)
      }
    }

    // 这次调用可能顺手移除过几条过期提案。不说的话，用户会在界面上发现少
    // 了一条自己原本看着的待确认改动，而模型以为它还在。
    const staleNote = stale === 0
      ? undefined
      : `${stale} previously proposed change(s) had been invalidated and were discarded.`

    if (change === undefined) {
      // 没有差异：返回当前视图，并说明这次调用没有产生待确认项，免得模型
      // 以为自己在等一个永远不会出现的确认。
      return { ...viewOf(draft), note: ['This call changed nothing, so there is no pending change to accept.', staleNote].filter((part): part is string => part !== undefined).join(' ') }
    }

    const described = summarise(tool, change)
    const proposal = await proposalStore.add({
      canvasId,
      tool,
      summary: described.summary,
      counts: described.counts,
      // 钉住真实文档的 revision，不是草稿的：用户接受时要比对的是他手上
      // 那份文档，而草稿只存在于这次调用里。
      baseRevision: document.revision,
      change,
    })

    return {
      ...viewOf(draft),
      // `pending` 是读磁盘时的总数，里面还算着已经过期并被移掉的那几条；
      // 报给用户的应该是「真的在等他接受的」，再加上这一条新的。
      note: [`This is a PROPOSAL (${pending - stale + 1} pending on this canvas), not a change to the user's canvas yet. Tell the user what you proposed and that they need to accept it in the canvas window. Nothing was saved.`, staleNote].filter((part): part is string => part !== undefined).join(' '),
      proposalId: proposal.id,
    }
  }

  const createNode = (args: Record<string, unknown>): CanvasNode => {
    const rawType = typeof args.type === 'string' ? args.type : 'image'
    if (!(NODE_TYPES as readonly string[]).includes(rawType)) {
      throw new Error(`Unknown node type "${rawType}". Use one of: ${NODE_TYPES.join(', ')}.`)
    }
    const type = rawType as CanvasNodeType
    const size = DEFAULT_SIZE[type]
    const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const metadata: CanvasNodeMetadata = {}
    if (typeof args.prompt === 'string') metadata.prompt = args.prompt
    if (typeof args.model === 'string') metadata.model = args.model
    if (typeof args.text === 'string') metadata.text = args.text
    if (type === 'config') {
      // `metadata.mode` 此前从来没被赋过值，所以原来那句
      // `if (metadata.mode === undefined) metadata.mode = 'image'` 恒为真：
      // Agent 造不出视频配置节点，而视频配置正是「往这里连两张图做插帧」的
      // 那个节点。传了就用传的，没传才默认出图。
      metadata.mode = typeof args.mode === 'string' ? parseMode(args.mode) : 'image'
    }
    return {
      id,
      type,
      title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : (type === 'config' ? '生成配置' : type === 'text' ? '文本' : type),
      x: typeof args.x === 'number' ? args.x : 0,
      y: typeof args.y === 'number' ? args.y : 0,
      width: typeof args.width === 'number' ? args.width : size.width,
      height: typeof args.height === 'number' ? args.height : size.height,
      ...Object.keys(metadata).length === 0 ? {} : { metadata },
    }
  }

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'list_canvases',
      description: 'List the user\'s infinite-canvas projects with their ids, node counts and revision. Use this to find the canvas to read or edit.',
      parameters: {},
      output: {
        schema: { type: 'array', items: canvasSummarySchema },
        render: (_args, value) => {
          const lines = Array.isArray(value) ? renderSummaryList(value as unknown as CanvasSummary[]) : 'There are no canvases yet.'
          return [{ type: 'text', text: lines }]
        },
      },
      async execute() {
        ensureEnabled()
        const values = await canvasStore.list()
        // `nodeCount` 只数已保存的节点。Agent 刚提议的节点不在里面，而
        // `read_canvas` 看得到——两个数字打架，模型会以为自己提议失败，再提
        // 一遍（探针实测：list 说 1 个、read 说 2 个）。所以这里一并带出待确认
        // 条数，让模型一眼看出「那个画布上还有我说了但用户没点头的东西」。
        // 一次遍历拿到每份画布的待确认条数：`countByCanvas` 就是下拉的
        // 「待确认」标记用的那个，不必为每份画布各扫一遍目录。
        const counts = await proposalStore.countByCanvas()
        return values.map(value => ({
          id: value.id,
          title: value.title,
          revision: value.revision,
          nodeCount: value.nodeCount,
          pending: counts[value.id] ?? 0,
          updatedAt: value.updatedAt,
        }))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'read_canvas',
      description: 'Read one canvas as a node graph: every node\'s id, type, title, position, prompt/model/text, plus the connections between them. Use the returned ids with the other canvas tools. Includes the changes you proposed that the user has not accepted yet (the same starting point the write tools use), so read it again after proposing instead of assuming your proposal is already on the canvas. This never starts a render.',
      parameters: { canvas_id: { type: 'string', required: true, description: 'Canvas id from list_canvases.' } },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        const { draft, pending, stale } = await draftOf(args.canvas_id)
        const view = viewOf(draft)
        // `viewOf` 的 note 说的是「这张图能不能跑」，这里说的是「你读到的这份
        // 还不等于用户看到的」。两个都要，所以拼接而不是覆盖。
        //
        // 不会出现「This canvas is empty」与「有提案」并存的自相矛盾：那句话
        // 只在 `draft.nodes.length === 0` 时说，而待确认提案一旦加过节点，草稿
        // 里就有了。只剩改名提案时它仍然是对的。
        //
        // 数的是**真正叠进这份草稿**的条数（`pending - stale`）：磁盘上那些
        // 过期的已经被 `draftOf` 移掉了，但 `pending` 是先读的，里面还算着它们。
        const shown = pending - stale
        const unaccepted = shown === 0
          ? undefined
          : `${shown} change(s) here are only proposed: the user has not accepted them, and the canvas they see does not have them yet.`
        // 过期提案已经被移掉了（那几个节点/连线在提议之后被改过），读到的内容
        // 与它们还在时的情形不等价，必须说出来；否则用户会在界面上找不到一条
        // Agent 以为待确认的改动。
        const staleNote = stale === 0
          ? undefined
          : `${stale} proposed change(s) had been invalidated (the canvas was edited after they were made) and were discarded, so they are not in what you see.`
        const note = [unaccepted, staleNote, view.note].filter((part): part is string => part !== undefined).join(' ')
        return { ...view, ...note === '' ? {} : { note } }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'create_canvas',
      description: 'Create a new empty canvas project. Returns its id; add nodes to it with add_canvas_node.',
      parameters: { title: { type: 'string', description: 'Canvas title. Defaults to a generic name.' } },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return viewOf(await canvasStore.create(args.title))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'add_canvas_node',
      description: 'Add one node to a canvas. A config node holds a prompt and model and waits for the user to press run — adding a node never spends money. Omit x/y to place it in a free column to the right of the existing nodes.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        type: { type: 'string', required: true, description: 'One of image, text, file, config, video, storyboard.' },
        title: { type: 'string', description: 'Node title shown on the canvas.' },
        prompt: { type: 'string', description: 'Prompt to store on the node (config/image nodes).' },
        model: { type: 'string', description: 'Model id to preselect on the node; the canvas default is used when omitted.' },
        text: { type: 'string', description: 'Body text for a text node.' },
        mode: { type: 'string', enum: ['image', 'video', 'text'], description: 'config nodes only: what pressing run should produce. Default `image`.' },
        x: { type: 'number', description: 'Canvas x. Defaults to a free spot.' },
        y: { type: 'number', description: 'Canvas y. Defaults to a free spot.' },
        // `createNode` 一直在读这两个键，但 schema 里没声明——模型无从得知能设，
        // 而声明与不声明在这里的差别是「猜到的能用」与「文档上写着的能用」。
        width: { type: 'number', description: 'Node width in canvas units. Defaults per type.' },
        height: { type: 'number', description: 'Node height in canvas units. Defaults per type.' },
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, 'add_canvas_node', document => {
          const node = createNode(args as Record<string, unknown>)
          if (document.nodes.some(existing => existing.id === node.id)) throw new Error(`A node with id ${node.id} already exists on this canvas.`)
          // 说明写着「省略 x/y 就放到现有节点右边」，而 `createNode` 的缺省是
          // 0,0——于是 Agent 连着加三个节点，三个都叠在原点，用户打开画布只
          // 看到最上面那一个。探针实测过：A/B/C 的坐标都是 (0,0)。
          // `createNode` 已经照抄了模型给的两个轴，这里只补它没给的那一个。
          if (typeof args.x !== 'number') node.x = nextColumnX(document)
          if (typeof args.y !== 'number') node.y = 0
          document.nodes.push(node)
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'update_canvas_node',
      description: 'Change one node\'s title, prompt, model, plain text, position, size, or (config nodes only) what pressing run should produce. Only the fields you pass are touched.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        node_id: { type: 'string', required: true, description: 'Node id from read_canvas.' },
        title: { type: 'string', description: 'New title.' },
        prompt: { type: 'string', description: 'New prompt.' },
        model: { type: 'string', description: 'New model id.' },
        text: { type: 'string', description: 'New body text (text nodes).' },
        x: { type: 'number', description: 'New x position.' },
        y: { type: 'number', description: 'New y position.' },
        // 与 `add_canvas_node` 对齐：它三个都收，这里原先一个都不收，于是
        // 「加的时候选错了」只能删了重建——而重建会换掉节点 id、坐标和已经
        // 连好的线。探针实测：update 传 mode/width/height 全部被静默忽略，
        // 工具还回一句「This call changed nothing」。
        width: { type: 'number', description: 'New node width in canvas units.' },
        height: { type: 'number', description: 'New node height in canvas units.' },
        mode: { type: 'string', enum: ['image', 'video', 'text'], description: 'config nodes only: what pressing run should produce.' },
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, 'update_canvas_node', document => {
          const node = document.nodes.find(candidate => candidate.id === args.node_id)
          if (node === undefined) throw new Error(`Node ${args.node_id} was not found. Read the canvas again for current ids.`)
          if (typeof args.title === 'string') node.title = args.title
          if (typeof args.x === 'number') node.x = args.x
          if (typeof args.y === 'number') node.y = args.y
          if (typeof args.width === 'number') node.width = args.width
          if (typeof args.height === 'number') node.height = args.height
          const metadata: CanvasNodeMetadata = { ...node.metadata }
          if (typeof args.prompt === 'string') metadata.prompt = args.prompt
          if (typeof args.model === 'string') metadata.model = args.model
          if (typeof args.text === 'string') metadata.text = args.text
          // `mode` 只对 config 有意义。静默写到别的类型上是让文档里长出一个
          // 谁也不读的键；直说更省事，模型也不会以为自己改成了。
          if (typeof args.mode === 'string') {
            if (node.type !== 'config') throw new Error(`Node ${node.id} is a ${node.type} node; only config nodes carry a mode.`)
            metadata.mode = parseMode(args.mode)
          }
          if (Object.keys(metadata).length > 0) node.metadata = metadata
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'remove_canvas_node',
      description: 'Remove one node and every connection touching it.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        node_id: { type: 'string', required: true, description: 'Node id from read_canvas.' },
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, 'remove_canvas_node', document => {
          const before = document.nodes.length
          document.nodes = document.nodes.filter(node => node.id !== args.node_id)
          if (document.nodes.length === before) throw new Error(`Node ${args.node_id} was not found. Read the canvas again for current ids.`)
          document.connections = document.connections.filter(edge => edge.fromNodeId !== args.node_id && edge.toNodeId !== args.node_id)
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'connect_canvas_nodes',
      description: 'Connect one node\'s output to another node\'s input. This is what makes a canvas a runnable chain: the downstream node receives the upstream node\'s product as input.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        from_node_id: { type: 'string', required: true, description: 'Upstream node id (the producer).' },
        to_node_id: { type: 'string', required: true, description: 'Downstream node id (the consumer).' },
        role: {
          type: 'string',
          enum: CONNECTION_ROLES,
          description: 'What this connection carries. Default `input`, the plain 「feed this downstream」 meaning. `first` / `last` only matter when the downstream node is a video config: they pick which two pictures the interpolation runs between, instead of relying on the order the connections happen to sit in. `reference` means the picture is material, never a frame slot.',
        },
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        if (args.from_node_id === args.to_node_id) throw new Error('A node cannot connect to itself.')
        return await mutate(args.canvas_id, 'connect_canvas_nodes', document => {
          const ids = new Set(document.nodes.map(node => node.id))
          if (!ids.has(args.from_node_id)) throw new Error(`Node ${args.from_node_id} was not found.`)
          if (!ids.has(args.to_node_id)) throw new Error(`Node ${args.to_node_id} was not found.`)
          const role = args.role === undefined ? 'input' : parseRole(args.role)
          const existing = document.connections.find(edge => edge.fromNodeId === args.from_node_id && edge.toNodeId === args.to_node_id)
          if (existing !== undefined) {
            // 边已经在，但**角色可能不同**：Agent 先 connect（默认 input），
            // 之后又说「把这张设成首帧」时会再调一次。此前这里无条件 return，
            // 第二次调用被当成「什么都没改」——而且工具还回一句
            // 「This call changed nothing」，模型于是以为自己设好了。视频插帧
            // 读的就是 role，用户看到的会是首尾帧用错了图。
            //
            // `withRole` 是幂等的：角色相同返回同一个对象（`diffOf` 算出无差异、
            // 不产生空提案），不同则改掉那一条边。
            const updated = withRole(existing, role)
            if (updated === existing) return
            document.connections = document.connections.map(edge => edge === existing ? updated : edge)
            return
          }
          document.connections.push(withRole({
            id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            fromNodeId: args.from_node_id,
            toNodeId: args.to_node_id,
          }, role))
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'disconnect_canvas_nodes',
      description: 'Remove the connection between two nodes, if one exists.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        from_node_id: { type: 'string', required: true, description: 'Upstream node id.' },
        to_node_id: { type: 'string', required: true, description: 'Downstream node id.' },
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, 'disconnect_canvas_nodes', document => {
          document.connections = document.connections.filter(edge => !(edge.fromNodeId === args.from_node_id && edge.toNodeId === args.to_node_id))
        })
      },
    })),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}

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

/** One node as the Agent sees it: ids to wire with, metadata to reason about.
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
 */
function diffOf(before: CanvasDocument, after: CanvasDocument): CanvasProposalChange | undefined {
  const sameNode = (left: CanvasNode, right: CanvasNode): boolean => JSON.stringify(left) === JSON.stringify(right)

  const beforeById = new Map(before.nodes.map(node => [node.id, node]))
  const afterById = new Map(after.nodes.map(node => [node.id, node]))

  const addedNodes = after.nodes.filter(node => !beforeById.has(node.id))
  const updatedNodes = after.nodes.filter(node => {
    const original = beforeById.get(node.id)
    return original !== undefined && !sameNode(original, node)
  })
  const removedNodeIds = before.nodes.filter(node => !afterById.has(node.id)).map(node => node.id)

  const beforeEdges = new Map(before.connections.map(edge => [edge.id, edge]))
  const afterEdges = new Map(after.connections.map(edge => [edge.id, edge]))
  const addedConnections = after.connections.filter(edge => !beforeEdges.has(edge.id))
  const removedConnectionIds = before.connections.filter(edge => !afterEdges.has(edge.id)).map(edge => edge.id)

  const title = before.title === after.title ? undefined : after.title

  if (addedNodes.length === 0 && updatedNodes.length === 0 && removedNodeIds.length === 0
    && addedConnections.length === 0 && removedConnectionIds.length === 0 && title === undefined) {
    return undefined
  }
  return {
    ...addedNodes.length === 0 ? {} : { addedNodes },
    ...updatedNodes.length === 0 ? {} : { updatedNodes },
    ...removedNodeIds.length === 0 ? {} : { removedNodeIds },
    ...addedConnections.length === 0 ? {} : { addedConnections },
    ...removedConnectionIds.length === 0 ? {} : { removedConnectionIds },
    ...title === undefined ? {} : { title },
  }
}

/**
 * 一句话告诉用户这条提案要做什么，例如「添加 2 个节点、连接 1 条线」。
 *
 * 这是用户在提案条上唯一会读的东西，所以写具体的数量与最常见的动作，
 * 不写「Agent 修改了画布」这种等于没说的句子。
 */
function summarise(tool: string, change: CanvasProposalChange): string {
  const parts: string[] = []
  const added = change.addedNodes?.length ?? 0
  const updated = change.updatedNodes?.length ?? 0
  const removed = change.removedNodeIds?.length ?? 0
  const wired = change.addedConnections?.length ?? 0
  const unwired = change.removedConnectionIds?.length ?? 0
  if (added > 0) parts.push(`添加 ${added} 个节点`)
  if (updated > 0) parts.push(`修改 ${updated} 个节点`)
  if (removed > 0) parts.push(`删除 ${removed} 个节点`)
  if (wired > 0) parts.push(`连接 ${wired} 条线`)
  if (unwired > 0) parts.push(`断开 ${unwired} 条线`)
  if (change.title !== undefined) parts.push(`改名为「${change.title}」`)
  return parts.length === 0 ? tool : parts.join('、')
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
    const label = node.type === 'config' ? 'config' : node.type
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

function renderSummaryList(values: readonly CanvasSummary[]): string {
  if (values.length === 0) return 'There are no canvases yet.'
  return values.map(value => `- ${value.id}「${value.title}」 (${value.nodeCount} nodes, revision ${value.revision})`).join('\n')
}

/** Turn a store conflict into copy the model can act on. */
function rethrowConflict(error: unknown): never {
  if (error instanceof CanvasConflictError) {
    throw new Error('The canvas changed since it was read (someone edited it in the canvas window). Read it again and retry the edit.')
  }
  throw error instanceof Error ? error : new Error(String(error))
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
    const document = await load(canvasId)
    const pending = await proposalStore.list(canvasId)

    // 草稿：真实文档 → 应用已有提案 → 交给 edit。
    let draft: CanvasDocument = document
    for (const proposal of pending) {
      const applied = ProposalStore.apply(draft, proposal.change)
      // 已有提案里有一步已经对不上当前文档（例如用户手改过）：不能拿错误的
      // 起点继续算，否则新提案会把那条坏掉的差异固化下来。
      if (applied === undefined) {
        throw new Error('A pending change on this canvas no longer applies to the current document (the canvas was edited after it was proposed). Ask the user to accept or discard the pending changes first, then retry.')
      }
      draft = applied
    }

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

    if (change === undefined) {
      // 没有差异：返回当前视图，并说明这次调用没有产生待确认项，免得模型
      // 以为自己在等一个永远不会出现的确认。
      return { ...viewOf(draft), note: 'This call changed nothing, so there is no pending change to accept.' }
    }

    const proposal = await proposalStore.add({
      canvasId,
      tool,
      summary: summarise(tool, change),
      // 钉住真实文档的 revision，不是草稿的：用户接受时要比对的是他手上
      // 那份文档，而草稿只存在于这次调用里。
      baseRevision: document.revision,
      change,
    })

    return {
      ...viewOf(draft),
      note: `This is a PROPOSAL (${pending.length + 1} pending on this canvas), not a change to the user's canvas yet. Tell the user what you proposed and that they need to accept it in the canvas window. Nothing was saved.`,
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
    if (type === 'config' && metadata.mode === undefined) metadata.mode = 'image'
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
        return values.map(value => ({ id: value.id, title: value.title, revision: value.revision, nodeCount: value.nodeCount, updatedAt: value.updatedAt }))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'read_canvas',
      description: 'Read one canvas as a node graph: every node\'s id, type, title, position, prompt/model/text, plus the connections between them. Use the returned ids with the other canvas tools. This never starts a render.',
      parameters: { canvas_id: { type: 'string', required: true, description: 'Canvas id from list_canvases.' } },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value as unknown as AgentCanvasView),
      },
      async execute(args) {
        ensureEnabled()
        return viewOf(await load(args.canvas_id))
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
        x: { type: 'number', description: 'Canvas x. Defaults to a free spot.' },
        y: { type: 'number', description: 'Canvas y. Defaults to a free spot.' },
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
          document.nodes.push(node)
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: 'update_canvas_node',
      description: 'Change one node\'s title, prompt, model, plain text or position. Only the fields you pass are touched.',
      parameters: {
        canvas_id: { type: 'string', required: true, description: 'Canvas id.' },
        node_id: { type: 'string', required: true, description: 'Node id from read_canvas.' },
        title: { type: 'string', description: 'New title.' },
        prompt: { type: 'string', description: 'New prompt.' },
        model: { type: 'string', description: 'New model id.' },
        text: { type: 'string', description: 'New body text (text nodes).' },
        x: { type: 'number', description: 'New x position.' },
        y: { type: 'number', description: 'New y position.' },
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
          const metadata: CanvasNodeMetadata = { ...node.metadata }
          if (typeof args.prompt === 'string') metadata.prompt = args.prompt
          if (typeof args.model === 'string') metadata.model = args.model
          if (typeof args.text === 'string') metadata.text = args.text
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
          if (document.connections.some(edge => edge.fromNodeId === args.from_node_id && edge.toNodeId === args.to_node_id)) return
          const role = args.role === undefined ? 'input' : parseRole(args.role)
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

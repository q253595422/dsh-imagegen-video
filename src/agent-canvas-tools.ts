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
 * Every write goes through `CanvasStore.save(document, expectedRevision)`, so
 * the same optimistic lock that protects the canvas window protects the Agent:
 * a stale read fails with `CanvasConflictError` instead of overwriting edits the
 * user made in the meantime.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { canvasStore, CanvasConflictError } from './canvas-store.ts'
import type {
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
}

interface AgentCanvasView {
  id: string
  title: string
  revision: number
  nodes: AgentNode[]
  connections: AgentEdge[]
  /** Actionable note when the graph cannot run as laid out. */
  note?: string
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
        },
      },
    },
    note: { type: 'string' },
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

function viewOf(document: CanvasDocument): AgentCanvasView {
  const note = noteFor(document.nodes, document.connections)
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    nodes: document.nodes.map(projectNode),
    connections: document.connections.map(edge => ({ id: edge.id, from: edge.fromNodeId, to: edge.toNodeId })),
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
  for (const edge of value.connections) lines.push(`- ${edge.from} → ${edge.to}`)
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

  /** Read, mutate, save under the revision that was read. */
  const mutate = async (canvasId: string, edit: (document: CanvasDocument) => void): Promise<AgentCanvasView> => {
    const document = await load(canvasId)
    const revision = document.revision
    edit(document)
    try {
      return viewOf(await canvasStore.save(document, revision))
    } catch (error) {
      rethrowConflict(error)
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
        render: (_args, value) => renderCanvasView(value),
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
        render: (_args, value) => renderCanvasView(value),
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
        render: (_args, value) => renderCanvasView(value),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, document => {
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
        render: (_args, value) => renderCanvasView(value),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, document => {
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
        render: (_args, value) => renderCanvasView(value),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, document => {
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
      },
      output: {
        schema: canvasViewSchema,
        render: (_args, value) => renderCanvasView(value),
      },
      async execute(args) {
        ensureEnabled()
        if (args.from_node_id === args.to_node_id) throw new Error('A node cannot connect to itself.')
        return await mutate(args.canvas_id, document => {
          const ids = new Set(document.nodes.map(node => node.id))
          if (!ids.has(args.from_node_id)) throw new Error(`Node ${args.from_node_id} was not found.`)
          if (!ids.has(args.to_node_id)) throw new Error(`Node ${args.to_node_id} was not found.`)
          if (document.connections.some(edge => edge.fromNodeId === args.from_node_id && edge.toNodeId === args.to_node_id)) return
          document.connections.push({
            id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            fromNodeId: args.from_node_id,
            toNodeId: args.to_node_id,
          })
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
        render: (_args, value) => renderCanvasView(value),
      },
      async execute(args) {
        ensureEnabled()
        return await mutate(args.canvas_id, document => {
          document.connections = document.connections.filter(edge => !(edge.fromNodeId === args.from_node_id && edge.toNodeId === args.to_node_id))
        })
      },
    })),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}

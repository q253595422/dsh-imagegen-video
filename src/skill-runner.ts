/**
 * Canvas skill runner.
 *
 * Runs one skill for one set of canvas nodes and hands node/connection drafts
 * back to the browser (the browser stays the single writer of canvas documents,
 * so undo, autosave and revision conflict handling are untouched).
 *
 * Two execution tiers, chosen by the catalog:
 *
 *  - **light** — assemble the node contents plus the skill body into one chat
 *    completion against the configured OpenAI-compatible endpoint. Used for
 *    polish, description, extraction and summarization.
 *  - **heavy** — create a headless DSH agent (`ctx.agents`) whose scoped system
 *    prompt carries the skill body, materialize the input files into a run
 *    directory, and let the agent execute the skill for real (files, CLI, child
 *    agents). Used for `image-to-editable-ppt` and similar pipelines.
 *
 * Everything the host cannot do for itself is injected through narrow backends
 * ({@link SkillRunnerBackend}) so the smoke suite can run the whole thing with
 * stubs and the plugin keeps its "no runtime dependency on DSH packages" rule.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CanvasAssetRef,
  CanvasConnection,
  CanvasDocument,
  CanvasNode,
  CanvasSkillCatalog,
  CanvasSkillDescriptor,
  CanvasSkillOutput,
  CanvasSkillRunRequest,
  CanvasSkillTask,
  ClipComposer,
  PptRunRequest,
} from './protocol.ts'
import { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
import { redactDiagnosticText } from './diagnostics-store.ts'
import {
  BUILTIN_COMPOSE,
  BUILTIN_DESCRIBE,
  BUILTIN_EXTRACT,
  BUILTIN_POLISH,
  BUILTIN_PPT,
  canvasSkillCatalog,
  EDITABLE_PPT_SKILL,
  isEditablePptSkill,
  type CatalogTranslate,
  type ExternalSkillSummary,
} from './skills-catalog.ts'
import { orderByPosition } from './clip-order.ts'
import { readZipDirectory, readZipEntry } from './zip.ts'
import { fileKindOf } from './canvas-store.ts'

// ---------------------------------------------------------------- contracts

/** One multimodal chat part, mirroring the OpenAI wire shape. */
export type SkillChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** Chat completion seam (the real one wraps {@link chatComplete}). */
export interface SkillChatBackend {
  complete: (options: {
    system: string
    content: string | SkillChatPart[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }) => Promise<string>
}

/** Skill registry seam: catalog summaries plus bodies loaded on demand. */
export interface SkillRegistryBackend {
  list: () => Promise<readonly ExternalSkillSummary[]>
  get: (name: string) => Promise<{ name: string; content: string } | undefined>
}

/** The renderer face of a live agent, narrowed to what a skill run drives. */
export interface SkillAgentSession {
  readonly seq?: number
  eventAt?: (seq: number) => unknown
  deriveMessages: () => readonly unknown[]
}

/** A live headless agent owned by one skill run. */
export interface SkillAgentHandle {
  session: SkillAgentSession
  followup: (text: string) => void
  whenIdle: () => Promise<void>
  cancel: () => void
  dispose: () => Promise<void>
}

/** Agent-runtime seam; `create` returns undefined when the runtime cannot
 *  compose a headless agent (missing factory, missing model, …). */
export interface SkillAgentBackend {
  available: () => boolean
  create: (options: {
    sessionId: string
    cwd: string
    systemPrompt: string
    signal?: AbortSignal
    /** Resolve one copy key in the run's language, for a composition failure. */
    fail: (key: string) => string
  }) => Promise<SkillAgentHandle | undefined>
}

/** Canvas storage seam (the real one is the CanvasStore). */
export interface SkillCanvasBackend {
  read: (id: string) => Promise<CanvasDocument | undefined>
  readAsset: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  readAssets: (refs: readonly CanvasAssetRef[]) => Promise<Map<string, { data: Buffer; mime: string }>>
  materialize: (ref: CanvasAssetRef, targetPath: string) => Promise<void>
  putFile: (input: {
    data: Uint8Array
    mime: string
    name: string
    origin: CanvasAssetRef['origin']
    originId?: string
  }) => Promise<CanvasAssetRef>
}

/**
 * Skill-configuration seam. The host owns declarations and values
 * (`docs/skill-config.md`); the runner only needs to know which required fields
 * are still unset, and what an exposable value set looks like in a prompt.
 */
export interface SkillConfigBackend {
  /** Labels of unset required fields, per skill name (absent = configured). */
  missing: (names: readonly string[]) => Promise<Map<string, string[]>>
  /** Non-secret "configured values" block for one skill, when it exposes any. */
  note: (name: string) => Promise<string | undefined>
}

/** Everything one runner needs, injected so tests can replace any layer. */
export interface SkillRunnerBackend {
  chat?: SkillChatBackend
  registry?: SkillRegistryBackend
  agents?: SkillAgentBackend
  /** Per-skill configuration, when the host has a declaration store. */
  skillConfig?: SkillConfigBackend
  canvas: SkillCanvasBackend
}

export interface SkillRunnerOptions {
  backend: SkillRunnerBackend
  /** Whether the canvas feature is enabled at all (settings master switch). */
  enabled: () => boolean
  /** Whether long agent runs are permitted (settings switch). */
  heavyEnabled: () => boolean
  /** External-skill allowlist; empty means every registered skill. */
  allowlist: () => string[]
  /** Run directory root for heavy skills; empty uses the canvas data root. */
  runRoot: () => string
  /** Heavy-skill timeout in milliseconds. */
  heavyTimeoutMs: () => number
  /** Data root (the same one the canvas store uses). */
  dataRoot: () => string
  /** Upstream home of the deck pipeline, surfaced as a one-click install. */
  pptInstallUrl?: string
  /** The isolated editppt CLI this host installed, when it has one. */
  pptCommand?: () => Promise<string>
  /**
   * Local clip stitcher (ffmpeg) for the `local` tier. Optional so every other
   * path — and the smoke suites — can run without ffmpeg installed; a compose
   * run without one fails with an actionable message instead of guessing.
   */
  composer?: ClipComposer
}

// ---------------------------------------------------------------- constants

/** Hard cap on input nodes per run: more than this is a mis-click, not a task. */
export const MAX_SKILL_INPUT_NODES = 12

/** Cap on the text handed to the light tier from text nodes. */
const MAX_INLINE_TEXT = 40_000

/** Cap on the images handed to one vision call. */
const MAX_VISION_IMAGES = 6

/** Completed tasks are kept for the poll window, then evicted. */
const MAX_TRACKED_TASKS = 200

/** Output node footprints (world units), matching the client's node sizes. */
const TEXT_NODE_SIZE = { width: 320, height: 260 }
const FILE_NODE_SIZE = { width: 300, height: 170 }
/** Video-node footprint, matching the client's 16:9 video nodes. */
const VIDEO_NODE_SIZE = { width: 240, height: 160 }
const NODE_GAP = 96
const STACK_GAP = 48

/** Minimum clips one compose run needs: stitching one clip is a no-op. */
const MIN_COMPOSE_SOURCES = 2

/**
 * A timeline as the compose run receives it.
 *
 * Travels inside `params.timeline` as a JSON string: the skill-run request's
 * `params` is already a `Record<string, string>` validated by the route, so a
 * structured field would have needed a second parse path for one caller.
 */
interface ComposeTimeline {
  segments: Array<{ nodeId: string; inPoint: number; outPoint?: number }>
  transitions: Array<{ kind: 'cut' | 'fade' | 'dissolve'; seconds: number }>
  keepAudio: boolean
}

/**
 * Parse the timeline parameter, refusing anything that would silently change
 * the film.
 *
 * A malformed timeline is NOT ignored: falling back to a plain stitch would
 * hand the user a video that ignores the trims they set and look like the
 * editor did nothing. Returning undefined is reserved for "no timeline sent",
 * which is the ordinary stitch path.
 */
function parseTimelineParam(raw: string | undefined): ComposeTimeline | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('the timeline parameter is not valid JSON') }
  if (value === null || typeof value !== 'object') throw new Error('the timeline parameter is not an object')
  const record = value as Record<string, unknown>
  const segments = Array.isArray(record.segments)
    ? record.segments.flatMap(item => {
        if (item === null || typeof item !== 'object') return []
        const segment = item as Record<string, unknown>
        if (typeof segment.nodeId !== 'string' || segment.nodeId === '') return []
        const inPoint = typeof segment.inPoint === 'number' && Number.isFinite(segment.inPoint) ? Math.max(0, segment.inPoint) : 0
        const outPoint = typeof segment.outPoint === 'number' && Number.isFinite(segment.outPoint) ? segment.outPoint : undefined
        return [{ nodeId: segment.nodeId, inPoint, ...outPoint === undefined || outPoint <= inPoint ? {} : { outPoint } }]
      })
    : []
  if (segments.length === 0) throw new Error('the timeline parameter carries no usable segment')
  const transitions: ComposeTimeline['transitions'] = Array.isArray(record.transitions)
    ? record.transitions.flatMap(item => {
        if (item === null || typeof item !== 'object') return []
        const transition = item as Record<string, unknown>
        const kind: ComposeTimeline['transitions'][number]['kind'] = transition.kind === 'fade' || transition.kind === 'dissolve' ? transition.kind : 'cut'
        const seconds = typeof transition.seconds === 'number' && Number.isFinite(transition.seconds) ? transition.seconds : 0.5
        return [{ kind, seconds: Math.max(0, seconds) }]
      })
    : []
  return { segments, transitions, keepAudio: record.keepAudio !== false }
}

/** Chat-model instructions per built-in light action. */
const POLISH_DIRECTIVES: Record<string, { zh: string; en: string }> = {
  formal: {
    zh: '改写得更正式、专业、书面化，保留原意与信息量，不要添加新事实。',
    en: 'Rewrite it in a more formal, professional register. Preserve meaning and facts; add nothing.',
  },
  casual: {
    zh: '改写得更口语、轻松、自然，保留原意与信息量。',
    en: 'Rewrite it in a casual, conversational, natural voice. Preserve meaning and facts.',
  },
  shorter: {
    zh: '压缩到原文 60% 以内的篇幅，只保留关键信息，语句通顺。',
    en: 'Compress it to at most 60% of the original length, keeping only the key information.',
  },
  expand: {
    zh: '在保留原意的前提下扩写，补充必要的细节、例子或过渡，让内容更充实。',
    en: 'Expand it with necessary detail, examples or transitions while preserving the original intent.',
  },
}

const DESCRIBE_SYSTEM = '你是图像理解引擎。请用简洁、具体的语言描述这张图片：主体、场景、构图、光线、色彩风格、文字与关键元素。只输出描述正文，不要客套话，不要 markdown 标题。'

function describeSystem(language: string): string {
  return language.startsWith('zh') || language === ''
    ? DESCRIBE_SYSTEM
    : 'You are an image-understanding engine. Describe this image concretely: subject, scene, composition, lighting, color and style, text and key elements. Output the description only — no preface, no markdown headings.'
}

// ---------------------------------------------------------------- helpers

/** Deterministic id generator, injectable for tests. */
let idFactory: (prefix: string) => string = prefix => `${prefix}-${randomUUID()}`
/** Override the id generator (host integration tests only). */
export function setIdFactory(factory: (prefix: string) => string): void {
  idFactory = factory
}

function newId(prefix: string): string {
  return idFactory(prefix)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

function isImageAsset(asset: CanvasAssetRef): boolean {
  return asset.kind !== 'file' && baseMime(asset.mime).startsWith('image/')
}

/** One input node plus its loaded asset, resolved once per run. */
interface RunInput {
  node: CanvasNode
  asset?: CanvasAssetRef
  data?: Buffer
}

function nodeText(node: CanvasNode): string {
  return typeof node.metadata?.text === 'string' ? node.metadata.text.trim() : ''
}

function nodeTitle(node: CanvasNode): string {
  return node.title.trim() === '' ? node.type : node.title.trim()
}

/** Union of explicit ids and every node connected into them. */
function resolveInputIds(document: CanvasDocument, request: CanvasSkillRunRequest): string[] {
  const explicit = request.nodeIds.filter(id => id.trim() !== '')
  const targets = explicit.length > 0 ? explicit : []
  const ids = new Set<string>(targets)
  for (const connection of document.connections) {
    if (targets.includes(connection.toNodeId)) ids.add(connection.fromNodeId)
  }
  return [...ids]
}

/** Place a stack of produced nodes beside (or under) the source node. */
function placeOutputs(
  produced: CanvasNode[],
  source: CanvasNode | undefined,
  nodes: readonly CanvasNode[],
  placement: 'right' | 'below',
): CanvasNode[] {
  if (produced.length === 0) return produced
  const anchor = source ?? nodes[nodes.length - 1]
  if (anchor === undefined) return produced
  const height = produced.reduce((total, node) => total + node.height + STACK_GAP, 0)
  if (placement === 'below') {
    let y = anchor.y + anchor.height + STACK_GAP
    const x = anchor.x
    return produced.map(node => {
      const placed = { ...node, x: Math.round(x), y: Math.round(y) }
      y += node.height + STACK_GAP
      return placed
    })
  }
  const width = Math.max(...produced.map(node => node.width))
  let x = anchor.x + anchor.width + NODE_GAP
  for (let guard = 0; guard < 24; guard += 1) {
    const clash = nodes.filter(node => node.id !== anchor.id
      && x < node.x + node.width + 24 && x + width > node.x - 24
      && anchor.y < node.y + node.height + 24 && anchor.y + height > node.y - 24)
    if (clash.length === 0) break
    x = Math.max(...clash.map(node => node.x + node.width)) + 48
  }
  let y = anchor.y
  return produced.map(node => {
    const placed = { ...node, x: Math.round(x), y: Math.round(y) }
    y += node.height + STACK_GAP
    return placed
  })
}

function textOutputNode(source: CanvasNode, title: string, text: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  const metadata = source.metadata ?? {}
  return {
    id: newId('node'),
    type: 'text',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width: TEXT_NODE_SIZE.width,
    height: TEXT_NODE_SIZE.height,
    metadata: {
      text,
      fontSize: typeof metadata.fontSize === 'number' ? metadata.fontSize : 14,
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

function fileOutputNode(source: CanvasNode, asset: CanvasAssetRef, title: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  return {
    id: newId('node'),
    type: 'file',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width: FILE_NODE_SIZE.width,
    height: FILE_NODE_SIZE.height,
    metadata: {
      asset,
      fileKind: fileKindOf(asset.mime, asset.name ?? ''),
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

function imageOutputNode(source: CanvasNode, asset: CanvasAssetRef, title: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  const width = asset.width > 0 ? Math.min(512, asset.width) : 320
  const height = asset.width > 0 && asset.height > 0 ? Math.round(width * (asset.height / asset.width)) : 320
  return {
    id: newId('node'),
    type: 'image',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width,
    height,
    metadata: {
      asset,
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

/** Wrap produced nodes into the wire output (drafts only — no ids rewritten). */
function outputOf(nodes: CanvasNode[], connections: CanvasConnection[], warnings: string[] = []): CanvasSkillOutput {
  return { nodes, connections, warnings }
}

/**
 * A produced clip node: a 16:9 video node REFERENCING the stitched clip in the
 * video store — never a canvas asset, so no bytes are copied and the node
 * behaves exactly like a clip added from the history.
 */
function videoOutputNode(
  source: CanvasNode,
  clip: { url: string; mime: string; duration?: number; entryId?: string },
  title: string,
  skillId: string,
  label: string,
  sourceIds: string[],
): CanvasNode {
  return {
    id: newId('node'),
    type: 'video',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width: VIDEO_NODE_SIZE.width,
    height: VIDEO_NODE_SIZE.height,
    metadata: {
      video: {
        url: clip.url,
        mime: clip.mime,
        // The canvas favorite button is gated on `video.entryId` ALONE
        // (CanvasWorkspace.tsx:4183 disabled=, :2404 early return), so a clip
        // that omits it renders a gray, unclickable 收藏 button while 加入对话 /
        // 下载 / 抓帧 / 预览 all keep working — a defect that is easy to miss.
        ...clip.entryId === undefined ? {} : { entryId: clip.entryId },
        ...clip.duration === undefined ? {} : { duration: clip.duration },
      },
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

/** whenIdle contains driver errors; inspect its durable turn ending instead. */
export function agentSessionFailure(session: SkillAgentSession): string | undefined {
  if (session.eventAt === undefined || !Number.isSafeInteger(session.seq)) return undefined
  for (let index = session.seq! - 1; index >= Math.max(0, session.seq! - 1000); index -= 1) {
    const raw = session.eventAt(index) as { type?: string; data?: { reason?: { kind?: string; error?: { code?: string; message?: string }; reason?: { kind?: string } } } } | undefined
    if (raw?.type !== 'turn/end') continue
    const reason = raw.data?.reason
    if (reason?.kind === 'error') return redactDiagnosticText([reason.error?.code, reason.error?.message].filter(Boolean).join(': ') || 'Agent execution failed')
    if (reason?.kind === 'aborted') return `Agent stopped (${reason.reason?.kind ?? 'aborted'})`
    return undefined
  }
  return undefined
}

/** Find the last assistant text in a session message list (structural). */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'assistant' || !Array.isArray(record.content)) continue
    const text = record.content.flatMap(block => {
      if (block === null || typeof block !== 'object') return []
      const entry = block as { type?: unknown; text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    }).join('\n').trim()
    if (text !== '') return text
  }
  return undefined
}

// ---------------------------------------------------------------- runner

export class SkillRunner {
  private readonly tasks = new Map<string, CanvasSkillTask>()
  private readonly cancellers = new Map<string, { dispose: () => Promise<void> }>()
  private tail: Promise<void> = Promise.resolve()
  private backend: SkillRunnerBackend

  constructor(private readonly options: SkillRunnerOptions) {
    this.backend = { ...options.backend }
  }

  /**
   * Attach or replace the optional host seams (skill registry, agent runtime).
   * Called from the plugin's soft injection once those services exist, and with
   * an empty object when they unload. The chat and canvas seams are never
   * replaced here.
   * @param parts - the seams to adopt; omitted keys are cleared.
   */
  attach(parts: { registry?: SkillRegistryBackend; agents?: SkillAgentBackend; skillConfig?: SkillConfigBackend }): void {
    this.backend.registry = parts.registry
    this.backend.agents = parts.agents
    this.backend.skillConfig = parts.skillConfig
  }

  /**
   * The catalog offered to the canvas (built-ins + allowlisted host skills).
   * @param language - UI language for the catalog copy (falls back to the
   *   installed resolver, then to the runner default).
   */
  async list(language?: string): Promise<CanvasSkillCatalog> {
    const t = this.translate(language)
    const registry = this.backend.registry
    const agentAvailable = this.backend.agents?.available() === true && this.options.heavyEnabled()
    if (!this.options.enabled()) {
      return { skills: [], agentAvailable, registryAvailable: registry !== undefined, installed: [], reason: t('canvas.skills.disabled') }
    }
    let external: readonly ExternalSkillSummary[] = []
    let registryAvailable = false
    let reason: string | undefined
    if (registry === undefined) {
      reason = t('canvas.skills.noRegistry')
    } else {
      try {
        const listed = await registry.list()
        const allow = this.options.allowlist().map(item => item.trim()).filter(item => item !== '')
        external = allow.length === 0 ? listed : listed.filter(skill => allow.includes(skill.name))
        registryAvailable = true
      } catch (error) {
        reason = t('canvas.skills.registryFailed', { message: messageOf(error) })
      }
    }
    // Required configuration that is still unset: the picker shows it with a
    // "go configure" affordance instead of letting the run fail halfway.
    const missing = this.backend.skillConfig === undefined
      ? undefined
      : await this.backend.skillConfig.missing(external.map(skill => skill.name)).catch(() => undefined)
    return {
      skills: canvasSkillCatalog(external, t, {
        agentAvailable,
        ...this.options.pptInstallUrl === undefined ? {} : { pptInstallUrl: this.options.pptInstallUrl },
        ...missing === undefined ? {} : { configMissing: name => missing.get(name) },
      }),
      agentAvailable,
      registryAvailable,
      installed: external.map(skill => skill.name),
      ...reason === undefined ? {} : { reason },
      ...agentAvailable ? {} : { reason: reason ?? t('canvas.skills.needAgent') },
    }
  }

  /** Queue one run and return its task immediately (the client polls it). */
  async run(request: CanvasSkillRunRequest): Promise<CanvasSkillTask> {
    const t = this.translate(request.language)
    const catalog = await this.list(request.language)
    const skill = catalog.skills.find(item => item.id === request.skillId)
    if (skill === undefined) throw new Error(t('canvas.skills.unknown'))
    // Clip stitching reads nodes of its own shape (video refs, not assets), so
    // it branches out before the shared input construction below — which only
    // understands `metadata.asset` and feeds four other skills.
    if (skill.id === BUILTIN_COMPOSE) return this.runCompose(skill, request)
    const document = await this.backend.canvas.read(request.canvasId)
    if (document === undefined) throw new Error(t('canvas.skills.canvasMissing'))
    const ids = resolveInputIds(document, request).slice(0, MAX_SKILL_INPUT_NODES)
    const byId = new Map(document.nodes.map(node => [node.id, node]))
    const inputs: RunInput[] = ids.flatMap(id => {
      const node = byId.get(id)
      if (node === undefined || node.type === 'config') return []
      const asset = node.metadata?.asset
      return [{ node, ...asset === undefined ? {} : { asset } }]
    })
    if (inputs.length === 0) throw new Error(t('canvas.skills.noInput'))
    // A skill the target node cannot feed is a mis-click, not a run.
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    if (!skill.accepts.includes(target.node.type)) throw new Error(t('canvas.skills.incompatible'))
    if (skill.tier === 'heavy' && !catalog.agentAvailable) throw new Error(t('canvas.skills.needAgent'))

    const language = request.language
    return this.startTask(request, skill, inputs)
  }

  /**
   * Create, track and queue one task.
   *
   * Split out of {@link run} because a standalone conversion builds its inputs
   * itself: it has no canvas to resolve them from, and its task has to carry
   * the slide list so a reloaded panel can still show what was submitted.
   * @param ppt - true for a standalone conversion, which persists its task.
   */
  private async startTask(
    request: CanvasSkillRunRequest,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    ppt = false,
  ): Promise<CanvasSkillTask> {
    const language = request.language
    const task: CanvasSkillTask = {
      id: newId('skillrun'),
      canvasId: request.canvasId,
      skillId: skill.id,
      label: skill.name,
      tier: skill.tier,
      status: 'queued',
      stage: this.translate(language)('canvas.skills.stageQueued'),
      phase: 'queued',
      nodeIds: [...request.nodeIds],
      startedAt: Date.now(),
      ...language === undefined || language === '' ? {} : { language },
      ...ppt ? { pptImages: inputs.flatMap(input => input.asset === undefined ? [] : [input.asset]) } : {},
    }
    this.tasks.set(task.id, task)
    // A conversion the user cannot see in the list is a run they cannot recover
    // after a reload, so failing to record it fails the run instead.
    try { await this.persistPpt(task) } catch (error) { this.tasks.delete(task.id); throw error }
    this.pruneTasks()
    const job = this.enqueue(task, skill, inputs, request)
    // The caller polls the task; the job never rejects outward.
    job.catch(error => {
      task.status = 'failed'
      task.error = messageOf(error)
      task.finishedAt = Date.now()
    })
    return task
  }

  /** One task snapshot, or undefined once evicted. */
  task(id: string): CanvasSkillTask | undefined {
    return this.tasks.get(id)
  }

  /** Unfinished runs of one canvas, so a reopened canvas can rebuild its live
   *  run cards after a reload (the browser holds no run state itself). */
  tasksOfCanvas(canvasId: string): CanvasSkillTask[] {
    return [...this.tasks.values()].filter(task => task.canvasId === canvasId
      && (task.status === 'queued' || task.status === 'running'))
  }

  /** Cancel a queued or running task. */
  async cancel(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
    task.status = 'cancelled'
    task.stage = this.translate(task.language)('canvas.skills.stageCancelled')
    task.finishedAt = Date.now()
    const canceller = this.cancellers.get(id)
    this.cancellers.delete(id)
    if (canceller !== undefined) await canceller.dispose().catch(() => { /* best effort */ })
    await this.persistPpt(task)
    return true
  }

  // ------------------------------------------------------------- ppt

  /**
   * Standalone image-to-PPT conversion: the same installed skill the canvas
   * uses, run without creating a canvas.
   *
   * The run is keyed by `canvasId: 'ppt'`, which is what marks it as a
   * conversion everywhere else (prompt, deck validation, persistence) rather
   * than threading a flag through every method.
   */
  async runPpt(request: PptRunRequest): Promise<CanvasSkillTask> {
    const t = this.translate(request.language)
    const catalog = await this.list(request.language)
    const skill = catalog.skills.find(item => item.id === BUILTIN_PPT)
    if (skill === undefined || !catalog.agentAvailable) throw new Error(t('canvas.skills.needAgent'))
    if (!catalog.installed.includes(EDITABLE_PPT_SKILL)) throw new Error(t('canvas.skills.skillMissing', { name: EDITABLE_PPT_SKILL }))
    if (request.images.length === 0 || request.images.length > MAX_SKILL_INPUT_NODES) throw new Error(t('ppt.inputLimit'))
    const inputs: RunInput[] = []
    for (const [index, asset] of request.images.entries()) {
      const found = await this.backend.canvas.readAsset(asset.assetId)
      if (found === undefined || !/^image\/(png|jpeg|webp)$/.test(found.mime)) throw new Error(t('ppt.invalidImage'))
      // The slide name is derived from the position, so the deck's page order is
      // the order the user arranged, not whatever the upload happened to be.
      const safeAsset: CanvasAssetRef = {
        ...asset,
        mime: found.mime,
        name: `slide-${index + 1}.${found.mime === 'image/jpeg' ? 'jpg' : found.mime.split('/')[1]}`,
      }
      inputs.push({
        asset: safeAsset,
        node: {
          id: newId('ppt-input'), type: 'image', title: safeAsset.name!, x: 0, y: 0, width: 320, height: 240,
          metadata: { asset: safeAsset },
        },
      })
    }
    return this.startTask({
      canvasId: 'ppt',
      skillId: BUILTIN_PPT,
      nodeIds: inputs.map(input => input.node.id),
      language: request.language,
      instruction: request.offlineOcr
        ? 'The user explicitly chose offline text detection for this run. Use upstream editppt prepare --no-text-hints, then editppt page hints for each page to generate offline hints before reconstruction. Do not call PaddleOCR for this run or ask about a token again. All other upstream steps remain required.'
        : 'Use the configured PaddleOCR token. Follow the upstream skill if OCR fails; do not silently downgrade quality.',
    }, skill, inputs, true)
  }

  /** Conversion history, so a panel reload or a host restart does not lose it. */
  async pptTasks(): Promise<CanvasSkillTask[]> {
    const dir = path.join(this.options.dataRoot(), 'ppt-tasks')
    const files = await fs.readdir(dir).catch(() => [])
    const persisted: CanvasSkillTask[] = []
    for (const name of files.filter(entry => /^skillrun-[\w-]+\.json$/.test(entry))) {
      const task = await fs.readFile(path.join(dir, name), 'utf8')
        .then(raw => JSON.parse(raw) as CanvasSkillTask)
        .catch(() => undefined)
      if (task === undefined || task.canvasId !== 'ppt' || task.id !== name.slice(0, -5)) continue
      const live = this.tasks.get(task.id)
      if (live !== undefined) { persisted.push(live); continue }
      // A run that was in flight when the host stopped is not still working;
      // saying so is the only honest state for it.
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'failed'
        task.error = this.translate(task.language)('ppt.interrupted')
        task.finishedAt = Date.now()
        await this.persistPpt(task)
      }
      persisted.push(task)
    }
    for (const task of this.tasks.values()) {
      if (task.canvasId === 'ppt' && !persisted.some(item => item.id === task.id)) persisted.push(task)
    }
    return persisted.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Write one conversion task to disk; a no-op for canvas runs. */
  private async persistPpt(task: CanvasSkillTask): Promise<void> {
    if (task.canvasId !== 'ppt') return
    const dir = path.join(this.options.dataRoot(), 'ppt-tasks')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${task.id}.json`)
    const temporary = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(task), 'utf8')
    await fs.rename(temporary, file)
  }

  // ------------------------------------------------------------- compose

  /**
   * Queue one clip-stitch run and return its task immediately.
   *
   * Separate from {@link run} for one reason: the shared input construction only
   * understands `metadata.asset`, while a clip node carries a *reference*
   * (`metadata.video.url`) whose bytes live in the video store. Building the
   * inputs here keeps the four existing skills on their untouched path.
   * @param skill - the compose catalog entry.
   * @param request - the run request (its `nodeIds` are the user's selection).
   */
  private async runCompose(skill: CanvasSkillDescriptor, request: CanvasSkillRunRequest): Promise<CanvasSkillTask> {
    const t = this.translate(request.language)
    const composer = this.options.composer
    if (composer === undefined) throw new Error(t('canvas.skills.composeNoFfmpeg', { detail: 'no local composer is wired into this host' }))
    const document = await this.backend.canvas.read(request.canvasId)
    if (document === undefined) throw new Error(t('canvas.skills.canvasMissing'))
    const byId = new Map(document.nodes.map(node => [node.id, node]))
    const clips: CanvasNode[] = []
    const seen = new Set<string>()
    for (const id of request.nodeIds) {
      if (seen.has(id)) continue
      const node = byId.get(id)
      // Only real clips with bytes to stitch; a stray image/text in the
      // selection is a multi-select artifact, not a source.
      if (node === undefined || node.type !== 'video') continue
      if ((node.metadata?.video?.url ?? '') === '') continue
      seen.add(id)
      clips.push(node)
    }
    // The host is the authority on order: the client sends its own list, but
    // documents, undo and multi-window edits can drift it, and the user cannot
    // see the difference. Re-sort by canvas position — the same function the
    // browser labels its ①②③ badges with.
    const ordered = orderByPosition(clips)
    if (ordered.length < MIN_COMPOSE_SOURCES) throw new Error(t('canvas.skills.composeTooFew'))

    const language = request.language
    const task: CanvasSkillTask = {
      id: newId('skillrun'),
      canvasId: request.canvasId,
      skillId: skill.id,
      label: skill.name,
      tier: skill.tier,
      status: 'queued',
      stage: this.translate(language)('canvas.skills.stageQueued'),
      phase: 'queued',
      nodeIds: ordered.map(node => node.id),
      startedAt: Date.now(),
      ...language === undefined || language === '' ? {} : { language },
    }
    this.tasks.set(task.id, task)
    this.pruneTasks()
    const timeline = parseTimelineParam(request.params?.timeline)
    const job = this.enqueue(task, skill, [], request, () => this.stitchClips(task, skill, ordered, composer, timeline))
    job.catch(error => {
      task.status = 'failed'
      task.error = messageOf(error)
      task.finishedAt = Date.now()
    })
    return task
  }

  /**
   * The `local` tier: one ffmpeg invocation on this machine through the
   * injected {@link ClipComposer}. No model, no agent, no network.
   */
  private async stitchClips(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    clips: readonly CanvasNode[],
    composer: ClipComposer,
    timeline?: ComposeTimeline,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    // Both probes are needed: ffmpeg alone cannot tell an input's length, and a
    // silent track bounded by a guessed length is how the run would hang.
    if (!composer.available()) throw new Error(t('canvas.skills.composeNoFfmpeg', { detail: composer.describe() }))
    const sources: string[] = []
    for (let index = 0; index < clips.length; index += 1) {
      const node = clips[index]!
      const url = node.metadata?.video?.url ?? ''
      const local = await composer.resolve(url)
      // Never skip a clip that cannot be read: the badges counted it, so a
      // silent drop would hand the user a shorter video than promised.
      if (local === undefined) {
        throw new Error(t('canvas.skills.composeFailed', {
          message: `${t('canvas.composeBadge', { index: index + 1 })}：${nodeTitle(node)}`,
        }))
      }
      sources.push(local)
    }

    const controller = new AbortController()
    this.cancellers.set(task.id, { dispose: async () => { controller.abort() } })
    task.stage = t('canvas.skills.composeStageProbe')
    task.phase = 'running'
    // A timeline is addressed by SEGMENT, not by the order the host re-sorted
    // the clips into: the user may have reordered segments on the timeline and
    // the canvas positions then disagree. Each segment carries its own node id,
    // so its trim is resolved by that id and handed to ffmpeg in play order.
    const trims = timeline === undefined
      ? undefined
      : timeline.segments.map(segment => {
          const index = clips.findIndex(node => node.id === segment.nodeId)
          return { start: Math.max(0, segment.inPoint), ...segment.outPoint === undefined ? {} : { seconds: Math.max(0, segment.outPoint - segment.inPoint) } }
        })
    // The timeline's own segment order is the play order, so it overrides the
    // canvas-position sort — but only when it actually mentions every clip.
    const playOrder = timeline === undefined || trims === undefined ? sources : (() => {
      const ordered: string[] = []
      for (const segment of timeline.segments) {
        const index = clips.findIndex(node => node.id === segment.nodeId)
        const source = index < 0 ? undefined : sources[index]
        if (source !== undefined) ordered.push(source)
      }
      return ordered.length === sources.length ? ordered : sources
    })()
    const orderedTrims = timeline === undefined || trims === undefined
      ? trims
      : playOrder.map(source => {
          const index = sources.indexOf(source)
          return trims[index] ?? { start: 0 }
        })
    let stitched: Awaited<ReturnType<ClipComposer['stitch']>>
    try {
      stitched = await composer.stitch({
        sources: playOrder,
        ...orderedTrims === undefined ? {} : { trims: orderedTrims },
        ...timeline === undefined ? {} : { transitions: timeline.transitions },
        ...timeline === undefined ? {} : { keepAudio: timeline.keepAudio },
        signal: controller.signal,
        onStage: stage => {
          task.stage = stage === 'probe'
            ? t('canvas.skills.composeStageProbe')
            : t('canvas.skills.composeStageEncode')
        },
      })
    } catch (error) {
      throw new Error(t('canvas.skills.composeFailed', { message: messageOf(error) }))
    }

    task.stage = t('canvas.skills.composeStageEncode')
    // The id is minted here rather than by the composer because it must survive
    // into the produced NODE: `metadata.video.entryId` is what enables 收藏, and
    // the history entry uses this same id (appendVideoHistory stores `id: input.id`).
    const entryId = newId('compose')
    const clip = await composer.publish({
      id: entryId,
      bytes: stitched.bytes,
      mime: stitched.mime,
      ...stitched.duration === undefined ? {} : { duration: stitched.duration },
      prompt: this.composePrompt(clips),
    })
    task.stage = t('canvas.skills.composeDone', { count: clips.length })

    const anchor = clips[clips.length - 1]!
    const node = videoOutputNode(anchor, { ...clip, entryId }, t('canvas.skills.composeNode'), skill.id, skill.name, clips.map(item => item.id))
    const connections: CanvasConnection[] = clips.map(source => ({ id: newId('edge'), fromNodeId: source.id, toNodeId: node.id }))
    return outputOf([node], connections)
  }

  /**
   * Provenance for the history entry ("stitched from N clips: …").
   *
   * Deliberately NOT localized: this string is persisted into the video index and
   * re-read later, possibly after the user switches language, so a translated
   * prefix would leave a Chinese entry labelled in Chinese inside an English UI.
   * The per-clip parts are the user's own prompts/titles, which are their content.
   */
  private composePrompt(clips: readonly CanvasNode[]): string {
    const list = clips.map((node, index) => {
      const prompt = typeof node.metadata?.prompt === 'string' ? node.metadata.prompt.trim() : ''
      return `${index + 1}. ${prompt === '' ? nodeTitle(node) : prompt}`
    }).join(' · ')
    return `stitched from ${clips.length} clips: ${list}`
  }

  /**
   * The `local` tier: work that runs on this machine and never calls a model.
   * The caller owns the shape of the inputs, so it hands in the job itself.
   */
  private async runLocal(
    task: CanvasSkillTask,
    local: (() => Promise<CanvasSkillOutput>) | undefined,
  ): Promise<CanvasSkillOutput> {
    // A local skill with no local job is a host wiring bug, not a user mistake.
    if (local === undefined) throw new Error(`${this.translate(task.language)('canvas.skills.unknown')} (${task.skillId})`)
    return local()
  }

  /**
   * Serialize one job on the shared tail.
   * @param local - the work of a `local`-tier skill, supplied by the caller that
   *   knows the shape of its inputs (see {@link runCompose}).
   */
  private enqueue(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
    local?: () => Promise<CanvasSkillOutput>,
  ): Promise<void> {
    const cancelled = (): boolean => this.tasks.get(task.id)?.status === 'cancelled'
    const run = async (): Promise<void> => {
      if (cancelled()) return
      task.status = 'running'
      task.phase = 'running'
      try {
        // Three tiers, not two. `local` is a subprocess on this machine and must
        // never fall through to `runLight`, whose chat completion would answer a
        // stitch request with a text node.
        task.output = skill.tier === 'heavy'
          ? await this.runHeavy(task, skill, inputs, request)
          : skill.tier === 'local'
            ? await this.runLocal(task, local)
            : await this.runLight(task, skill, inputs, request)
        if (!cancelled()) {
          task.status = 'completed'
          task.stage = this.translate(task.language)('canvas.skills.stageDone')
          task.phase = undefined
        }
      } catch (error) {
        if (!cancelled()) {
          task.status = 'failed'
          task.error = messageOf(error)
          task.phase = undefined
        }
      } finally {
        task.finishedAt = Date.now()
        this.cancellers.delete(task.id)
        // Best effort: a run that finished is already reported to the caller,
        // so a disk error here must not turn it into a failure.
        await this.persistPpt(task).catch(() => { /* the in-memory task stands */ })
      }
    }
    const next = this.tail.then(run, run)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private pruneTasks(): void {
    if (this.tasks.size <= MAX_TRACKED_TASKS) return
    const finished = [...this.tasks.values()]
      .filter(task => task.finishedAt !== undefined)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    for (const task of finished.slice(0, this.tasks.size - MAX_TRACKED_TASKS)) this.tasks.delete(task.id)
  }

  // ------------------------------------------------------------- light tier

  private async runLight(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    const chat = this.backend.chat
    if (chat === undefined) throw new Error(t('canvas.skills.noChat'))
    task.stage = t('canvas.skills.stageReading')
    task.phase = 'running'
    await this.loadAssets(inputs)
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    // Extraction reads the file itself; every other built-in asks the model.
    if (skill.id === BUILTIN_EXTRACT && target.node.type === 'file') {
      return this.runBuiltinExtract(target, skill, t)
    }
    // Extraction from an image (or from several selected nodes) has no text
    // decoder to rely on, so it degrades to handing the collected content to
    // the model — same path an external light skill takes.
    if (skill.id === BUILTIN_EXTRACT) {
      return this.runCollectedLight(target, inputs, skill, t)
    }
    if (skill.id === BUILTIN_DESCRIBE) return this.runBuiltinDescribe(target, inputs, skill, chat, t)
    if (skill.id === BUILTIN_POLISH) return this.runBuiltinPolish(target, skill, request, chat, t)
    return this.runExternalLight(target, inputs, skill, request, chat, t)
  }

  /** Read the asset bytes for every image/file input once. */
  private async loadAssets(inputs: RunInput[]): Promise<void> {
    const canvas = this.backend.canvas
    const pending = inputs.filter(input => input.asset !== undefined && input.data === undefined)
    if (pending.length === 0) return
    const refs = pending.map(input => input.asset!).filter(ref => ref.assetId !== '')
    const found = await canvas.readAssets(refs)
    for (const input of pending) {
      const asset = input.asset!
      const hit = found.get(asset.assetId)
      if (hit !== undefined) input.data = hit.data
    }
  }

  private runBuiltinExtract(target: RunInput, skill: CanvasSkillDescriptor, t: CatalogTranslate): CanvasSkillOutput {
    const asset = target.asset
    if (asset === undefined || target.data === undefined) throw new Error(t('canvas.skills.fileMissing'))
    const name = asset.name ?? asset.assetId
    const extracted = extractFileText(target.data, name, asset.mime)
    const warnings = [
      ...extracted.warning === undefined ? [] : [extracted.warning],
      ...extracted.truncated ? [t('canvas.skills.truncated', { count: MAX_EXTRACTED_CHARS })] : [],
    ]
    if (!extracted.supported) throw new Error(extracted.warning ?? t('canvas.skills.extractFailed'))
    const sourceIds = [target.node.id]
    const node = textOutputNode(
      target.node,
      t('canvas.skills.extractNodeTitle', { name }),
      extracted.text,
      skill.id,
      skill.name,
      sourceIds,
    )
    const connection: CanvasConnection = { id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }
    return outputOf([node], [connection], warnings)
  }

  /** Collect text from every input and hand it to the model in one shot. Used
   *  when a built-in cannot decode the input itself (image extraction). */
  private runCollectedLight(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    t: CatalogTranslate,
  ): CanvasSkillOutput {
    const subject = inputs.find(input => input.node.id === target.node.id) ?? inputs[0]!
    const pieces: string[] = []
    const warnings: string[] = []
    for (const input of inputs) {
      const text = nodeText(input.node)
      if (text !== '') { pieces.push(text); continue }
      const asset = input.asset
      if (asset === undefined || input.data === undefined) continue
      const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime)
      if (extracted.supported && extracted.text !== '') pieces.push(extracted.text)
      else if (extracted.warning !== undefined) warnings.push(extracted.warning)
    }
    if (pieces.length === 0) throw new Error(t('canvas.skills.nothingToRead'))
    const joined = pieces.join('\n\n---\n\n')
    const head = t('canvas.skills.summaryHead', { count: pieces.length })
    const text = `${head}\n\n${joined.slice(0, MAX_EXTRACTED_CHARS)}`
    const node = textOutputNode(subject.node, skill.name, text, skill.id, skill.name, [subject.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: subject.node.id, toNodeId: node.id }], warnings)
  }

  private async runBuiltinDescribe(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const images = inputs.filter(input => input.node.type === 'image' && input.asset !== undefined && isImageAsset(input.asset!))
    if (images.length === 0) throw new Error(t('canvas.skills.needImage'))
    const parts: SkillChatPart[] = [{ type: 'text', text: t('canvas.skills.describeAsk', { count: images.length }) }]
    for (const input of images.slice(0, MAX_VISION_IMAGES)) {
      if (input.data === undefined) continue
      parts.push({ type: 'image_url', image_url: { url: `data:${baseMime(input.asset!.mime)};base64,${input.data.toString('base64')}` } })
    }
    const answer = await chat.complete({ system: describeSystem(currentSkillLanguage()), content: parts, temperature: 0.3 })
    const warnings = images.length > MAX_VISION_IMAGES ? [t('canvas.skills.tooManyImages', { count: MAX_VISION_IMAGES })] : []
    const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }], warnings)
  }

  private async runBuiltinPolish(
    target: RunInput,
    skill: CanvasSkillDescriptor,
    request: CanvasSkillRunRequest,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const original = nodeText(target.node)
    if (original === '') throw new Error(t('canvas.skills.needText'))
    const style = (request.params?.style ?? 'formal').trim()
    const language = currentSkillLanguage()
    const english = !(language.startsWith('zh') || language === '')
    const directive = style === 'custom'
      ? (request.instruction ?? '').trim()
      : (POLISH_DIRECTIVES[style] ?? POLISH_DIRECTIVES.formal!)[english ? 'en' : 'zh']
    if (directive === '') throw new Error(t('canvas.skills.needInstruction'))
    const system = english
      ? 'You are a text editor. Rewrite the user text following the instruction exactly. Preserve the original language and every fact. Return only the rewritten text — no preface, no quotes, no markdown fences.'
      : '你是文字编辑。请严格按指令改写用户提供的文本，保持原语言与全部事实不变。只输出改写后的正文，不要任何说明、引号或 markdown 代码块。'
    const answer = await chat.complete({ system, content: `${directive}\n\n---\n${original}`, temperature: 0.4 })
    const node = textOutputNode(target.node, t('canvas.skills.polishNodeTitle', { style: t(`canvas.polish.${style}`) }), answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }])
  }

  /** External skill through the light tier: skill body in, answer out. */
  private async runExternalLight(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    request: CanvasSkillRunRequest,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const registry = this.backend.registry
    const name = skill.id.startsWith('skill:') ? skill.id.slice('skill:'.length) : skill.id
    const definition = registry === undefined ? undefined : await registry.get(name)
    const warnings: string[] = []
    const sections: string[] = []
    if (definition !== undefined && definition.content.trim() !== '') sections.push(definition.content.trim())
    // Values the skill's declaration marks exposable ride the prompt; secrets
    // never do (the host filters them out before handing the block over).
    const configNote = await this.backend.skillConfig?.note(name).catch(() => undefined)
    if (configNote !== undefined && configNote !== '') sections.push(`${t('canvas.skills.configHeader')}\n${configNote}`)
    for (const input of inputs) {
      const text = nodeText(input.node)
      if (text !== '') {
        sections.push(`### ${nodeTitle(input.node)}\n${text.slice(0, MAX_INLINE_TEXT)}`)
        continue
      }
      const asset = input.asset
      if (asset === undefined || input.data === undefined) continue
      const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime)
      if (extracted.supported && extracted.text !== '') sections.push(`### ${asset.name ?? nodeTitle(input.node)}\n${extracted.text.slice(0, MAX_INLINE_TEXT)}`)
      else if (extracted.warning !== undefined) warnings.push(extracted.warning)
    }
    const parts: SkillChatPart[] = [{ type: 'text', text: this.externalUserPrompt(skill, sections, request, t) }]
    for (const input of inputs) {
      const asset = input.asset
      if (asset === undefined || input.data === undefined || !isImageAsset(asset)) continue
      if (parts.length > MAX_VISION_IMAGES) { warnings.push(t('canvas.skills.tooManyImages', { count: MAX_VISION_IMAGES })); break }
      parts.push({ type: 'image_url', image_url: { url: `data:${baseMime(asset.mime)};base64,${input.data.toString('base64')}` } })
    }
    const answer = await chat.complete({
      system: t('canvas.skills.externalSystem', { name: skill.name }),
      content: parts,
      temperature: 0.35,
    })
    const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }], warnings)
  }

  private externalUserPrompt(
    skill: CanvasSkillDescriptor,
    sections: string[],
    request: CanvasSkillRunRequest,
    t: CatalogTranslate,
  ): string {
    const header = t('canvas.skills.externalHeader', { name: skill.name })
    const instruction = (request.instruction ?? '').trim()
    return [
      header,
      ...instruction === '' ? [] : ['', t('canvas.skills.extraInstruction'), instruction],
      '',
      t('canvas.skills.inputsHeader'),
      ...sections.length === 0 ? [t('canvas.skills.inputsEmpty')] : sections,
    ].join('\n')
  }

  // ------------------------------------------------------------- heavy tier

  private async runHeavy(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const runRoot = this.options.runRoot().trim() === '' ? path.join(this.options.dataRoot(), 'canvas', 'runs') : this.options.runRoot().trim()
    const runDir = path.join(runRoot, request.canvasId, task.id)
    if (task.canvasId === 'ppt') task.runDirectory = runDir
    // The run directory is scratch space for one run: inputs are copied in and
    // the agent writes its products there, which can be tens of MiB per run. It
    // is deleted as soon as the run reaches a terminal state — successful,
    // failed or cancelled — because by then the bytes are no longer needed:
    // `collectHeavyOutput` has already read every produced file into the canvas
    // asset store (`canvas.putFile`) before it returns, so nothing downstream
    // holds a path into `runDir`. Without this, running the same canvas again
    // and again accumulates dead directories forever.
    try {
      return await this.runHeavyIn(runDir, task, skill, inputs, request)
    } finally {
      await this.discardRunDir(runDir)
    }
  }

  /**
   * Delete a finished run's scratch directory.
   *
   * Cleanup is strictly best effort: a failure here (a locked file, a
   * permission problem, a directory the agent removed itself) must never change
   * the outcome of the run that just finished, so every error is swallowed and
   * the worst case is a leftover directory the next sweep can ignore.
   */
  private async discardRunDir(runDir: string): Promise<void> {
    try {
      await fs.rm(runDir, { recursive: true, force: true })
    } catch {
      // Best effort: leftover scratch space is not a run failure.
    }
  }

  /** The heavy tier's work, with the run directory handed in by its caller so
   *  one place owns the directory's whole lifetime (create and delete). */
  private async runHeavyIn(
    runDir: string,
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    const agents = this.backend.agents
    if (agents === undefined || !agents.available()) throw new Error(t('canvas.skills.needAgent'))
    const canvas = this.backend.canvas
    const document = await canvas.read(request.canvasId)
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    const inputDir = path.join(runDir, 'input')
    const outputDir = path.join(runDir, 'output')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.mkdir(outputDir, { recursive: true })

    task.stage = t('canvas.skills.stagePreparing')
    task.phase = 'preparing'
    // Materialize every input that resolves to a real asset, so the agent works
    // on ordinary files (its tools read paths, not canvas asset ids).
    const fileLines: string[] = []
    const warnings: string[] = []
    let index = 0
    for (const input of inputs) {
      index += 1
      const asset = input.asset
      if (asset === undefined || asset.assetId === '') {
        const text = nodeText(input.node)
        if (text !== '') {
          const name = `${String(index).padStart(2, '0')}_${input.node.type}-${input.node.id}.md`
          await fs.writeFile(path.join(inputDir, name), text, 'utf8')
          fileLines.push(`- ${path.join(inputDir, name)}（文本节点内容）`)
        }
        continue
      }
      const original = asset.name ?? `${asset.assetId}`
      const safe = original.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'input'
      const name = `${String(index).padStart(2, '0')}_${safe}`
      const target2 = path.join(inputDir, name)
      await canvas.materialize(asset, target2)
      fileLines.push(`- ${target2}`)
    }
    if (fileLines.length === 0) throw new Error(t('canvas.skills.noInput'))
    task.stage = t('canvas.skills.stagePrepared', { count: fileLines.length })

    const skillName = this.heavySkillName(skill)
    const body = await this.loadSkillBody(skillName)
    // A heavy built-in without its host skill cannot run at all: fail with an
    // actionable message instead of starting an agent that has nothing to do.
    if (body === undefined) throw new Error(t('canvas.skills.skillMissing', { name: skillName }))
    // Exposable declared values (secrets filtered host-side) tell the agent what
    // is already configured, so it does not hunt for settings it already has.
    const configNote = await this.backend.skillConfig?.note(skillName).catch(() => undefined)
    // A conversion runs the installed skill as-is. The extra lines pin the
    // things that go wrong when an agent improvises: a replaced pipeline, a
    // rasterised deck passed off as editable, or an intermediate page deck
    // reported as the result.
    const definition = await this.backend.registry?.list()
      .then(items => items.find(item => item.name === skillName))
      .catch(() => undefined)
    const command = task.canvasId === 'ppt' ? await this.options.pptCommand?.() : undefined
    const systemPrompt = [
      this.heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote),
      ...definition?.path === undefined ? [] : [`Skill entry path: ${JSON.stringify(definition.path)}. Resolve every skill-local reference, prompt builder and CLI source relative to its directory.`],
      ...task.canvasId !== 'ppt' ? [] : [
        'This is an image-to-editable-PPT conversion explicitly requested by the user. Follow the installed upstream skill unchanged; do not design a replacement pipeline.',
        'The input order is the slide order. Use the original images as source slides. Copy ONLY the validated final deck, final previews and validation report to the output directory. Do not copy intermediate page decks as final decks. If finalize cannot pass, report failure; never substitute a full-slide raster.',
        `Runtime CLI: ${JSON.stringify(command ?? 'editppt')}. Use this executable for editppt commands; add its parent directory to your shell PATH for upstream helpers.`,
        request.instruction ?? '',
      ],
    ].join('\n\n')
    task.stage = t('canvas.skills.stageRunning')
    task.phase = 'running'
    const controller = new AbortController()
    const timeout = this.options.heavyTimeoutMs()
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined
    timer?.unref?.()
    let handle: SkillAgentHandle | undefined
    // A cancel can land while the run is still preparing. Without this check the
    // agent is created anyway and works for minutes on a task the user already
    // stopped, with the run card saying it is cancelled.
    const cancelled = (): boolean => task.status === 'cancelled'
    try {
      if (cancelled()) throw new Error(t('canvas.skills.stageCancelled'))
      const sessionId = newId('skillagent')
      if (task.canvasId === 'ppt') { task.agentSessionId = sessionId; await this.persistPpt(task) }
      handle = await agents.create({
        sessionId,
        cwd: runDir,
        systemPrompt,
        signal: controller.signal,
        fail: key => t(key),
      })
      if (handle === undefined) throw new Error(t('canvas.skills.agentFailed'))
      if (cancelled()) { handle.cancel(); throw new Error(t('canvas.skills.stageCancelled')) }
      this.cancellers.set(task.id, {
        dispose: async () => {
          controller.abort()
          handle?.cancel()
          await handle?.dispose().catch(() => { /* best effort */ })
        },
      })
      handle.followup(this.heavyUserPrompt(skill, skillName, inputDir, outputDir, body !== undefined, t))
      // The agent thinks for minutes on a deck pipeline; the only honest live
      // signal is what it has already written into the output directory.
      const watch = this.watchOutputDir(task, outputDir, t)
      try {
        await handle.whenIdle()
      } finally {
        watch.stop()
      }
      // Nothing collected after a cancel is a result the user asked for.
      controller.signal.throwIfAborted()
      if (cancelled()) throw new Error(t('canvas.skills.stageCancelled'))
      task.stage = t('canvas.skills.stageCollecting')
      task.phase = 'collecting'
      const failure = agentSessionFailure(handle.session)
      if (failure !== undefined) throw new Error(t('ppt.agentFailed', { error: failure }))
      const answer = lastAssistantText(handle.session.deriveMessages())
      if (task.canvasId === 'ppt') await this.recoverFinalizedPpt(runDir, outputDir, task.pptImages?.length ?? 0)
      return await this.collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      await handle?.dispose().catch(() => { /* best effort */ })
    }
  }

  /** Report newly produced output files on the task while the agent works, so
   *  the canvas run card shows "已产出 N 个文件" instead of a silent spinner. */
  private watchOutputDir(task: CanvasSkillTask, outputDir: string, t: CatalogTranslate): { stop: () => void } {
    let seen = -1
    const timer = setInterval(() => {
      void fs.readdir(outputDir, { recursive: true, withFileTypes: true }).then(entries => {
        const count = entries.filter(entry => entry.isFile()).length
        if (count === 0 || count === seen) return
        seen = count
        task.stage = t('canvas.skills.stageArtifacts', { count })
      }).catch(() => { /* the directory outlives the run; nothing to report */ })
    }, 2_000)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  }

  /** The host skill name a heavy built-in maps to (the deck pipeline). */
  private heavySkillName(skill: CanvasSkillDescriptor): string {
    if (skill.id.startsWith('skill:')) return skill.id.slice('skill:'.length)
    if (skill.id === BUILTIN_PPT) return EDITABLE_PPT_SKILL
    return skill.name
  }

  /** Where an installed skill lives on disk, for callers that run its CLI. */
  async skillDefinition(name: string): Promise<{ name: string; path?: string } | undefined> {
    return this.backend.registry?.list()
      .then(items => items.find(item => item.name === name))
      .catch(() => undefined)
  }

  private async loadSkillBody(name: string): Promise<string | undefined> {
    const registry = this.backend.registry
    if (registry === undefined) return undefined
    const definition = await registry.get(name).catch(() => undefined)
    if (definition === undefined || definition.content.trim() === '') return undefined
    return definition.content
  }

  private heavySystemPrompt(
    skill: CanvasSkillDescriptor,
    body: string | undefined,
    fileLines: string[],
    outputDir: string,
    t: CatalogTranslate,
    configNote?: string,
  ): string {
    return [
      t('canvas.skills.heavyIntro', { name: skill.name }),
      ...body === undefined ? [] : ['', t('canvas.skills.heavyBodyHeader'), body],
      ...configNote === undefined || configNote === '' ? [] : ['', t('canvas.skills.configHeader'), configNote],
      '',
      t('canvas.skills.heavyInputsHeader'),
      ...fileLines,
      '',
      t('canvas.skills.heavyOutputHeader', { dir: outputDir }),
      t('canvas.skills.heavyRules'),
    ].join('\n')
  }

  private heavyUserPrompt(
    skill: CanvasSkillDescriptor,
    skillName: string,
    inputDir: string,
    outputDir: string,
    hasBody: boolean,
    t: CatalogTranslate,
  ): string {
    return [
      t('canvas.skills.heavyAsk', { name: skill.name }),
      '',
      t('canvas.skills.heavyAskInputs', { dir: inputDir }),
      t('canvas.skills.heavyAskOutput', { dir: outputDir }),
      ...hasBody ? [] : ['', t('canvas.skills.heavyAskLoadSkill', { name: skillName })],
    ].join('\n')
  }

  /**
   * The editppt skill finalizes into its own `final/` directory, outside the
   * output folder this runner hands it. Collect only a completed, validated
   * final deck — never an intermediate page — and only when this run produced
   * no deck of its own.
   */
  private async recoverFinalizedPpt(runDir: string, outputDir: string, pageCount: number): Promise<void> {
    const root = await fs.realpath(runDir)
    const inside = (file: string): boolean => file.startsWith(root + path.sep)
    const resolveFile = async (raw: string, base: string): Promise<string | undefined> => {
      const file = await fs.realpath(path.resolve(base, raw)).catch(() => undefined)
      return file !== undefined && inside(file) ? file : undefined
    }
    const boundedJson = async (file: string): Promise<Record<string, unknown> | undefined> => {
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return undefined
      const value = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw)).catch(() => undefined)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    }
    let inspected = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 7 || inspected > 2000) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (++inspected > 2000) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !['input', 'pages', 'node_modules', '.venv'].includes(entry.name)) { await walk(full, depth + 1); continue }
        if (!entry.isFile() || entry.name !== 'run_summary.json') continue
        const summary = await boundedJson(full)
        if (summary?.status !== 'complete' || summary.page_count !== pageCount || typeof summary.output !== 'string' || typeof summary.validation !== 'string') continue
        const deck = await resolveFile(summary.output, dir)
        const report = await resolveFile(summary.validation, dir)
        if (deck === undefined || report === undefined || !deck.toLowerCase().endsWith('.pptx')) continue
        const validation = await boundedJson(report)
        if (validation?.passed !== true) continue
        const size = await fs.stat(deck)
        if (!size.isFile() || size.size === 0 || size.size > 64 * 1024 * 1024) continue
        const target = path.join(outputDir, path.basename(deck))
        // A deck already delivered explicitly is authoritative; don't overwrite it.
        if (!(await fs.stat(target).then(() => true, () => false))) await fs.copyFile(deck, target)
        await fs.copyFile(report, path.join(outputDir, 'validation.json'))
        await fs.copyFile(full, path.join(outputDir, 'run_summary.json'))
      }
    }
    const delivered = await fs.readdir(outputDir).then(names => names.some(name => name.toLowerCase().endsWith('.pptx')))
    if (!delivered) await walk(runDir, 0)
  }

  private async collectHeavyOutput(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    target: RunInput,
    outputDir: string,
    answer: string | undefined,
    warnings: string[],
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const canvas = this.backend.canvas
    const files: Array<{ file: string; size: number }> = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (task.canvasId !== 'ppt') await walk(full, depth + 1); continue }
        if (!entry.isFile()) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (stat === undefined || stat.size === 0) continue
        files.push({ file: full, size: stat.size })
      }
    }
    await walk(outputDir, 0)
    const nodes: CanvasNode[] = []
    const connections: CanvasConnection[] = []
    for (const found of files.sort((a, b) => a.file.localeCompare(b.file))) {
      const data = await fs.readFile(found.file).catch(() => undefined)
      if (data === undefined) continue
      const name = path.basename(found.file)
      // A conversion must hand back a real deck. A .pptx that is not a valid
      // OOXML package, or whose slide count does not match the images the user
      // submitted, is a broken result however plausible it looks in the list.
      if (task.canvasId === 'ppt' && name.toLowerCase().endsWith('.pptx')) {
        const entries = readZipDirectory(data)
        const presentation = entries.find(entry => entry.name === 'ppt/presentation.xml')
        const slides = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
        if (presentation === undefined || readZipEntry(data, presentation) === undefined
          || slides.length !== task.pptImages?.length
          || slides.some(entry => readZipEntry(data, entry) === undefined)) {
          throw new Error(t('ppt.invalidDeck'))
        }
      }
      // WHY per-file: `putFile` refuses a blocked extension (.html/.js/.svg/…),
      // a file over 50 MB and a few malformed names. Without this catch a single
      // such artifact unwound the whole run — every node and connection collected
      // so far was discarded (they are only local arrays until the final return),
      // the task was marked failed and `runHeavy`'s finally deleted the run
      // directory, so the user got nothing and had to re-run a task that may have
      // cost ten minutes. One skipped file is a warning, not a lost run.
      let asset
      try {
        asset = await canvas.putFile({
          data,
          mime: mimeFromName(name),
          name,
          origin: 'generated',
          originId: task.id,
        })
      } catch (caught) {
        warnings.push(t('canvas.skills.skippedOutput', { name, message: messageOf(caught) }))
        continue
      }
      const node = fileOutputNode(target.node, asset, name, skill.id, skill.name, [target.node.id])
      nodes.push(node)
      connections.push({ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id })
    }
    if (task.canvasId === 'ppt' && !nodes.some(node => node.metadata?.asset?.name?.toLowerCase().endsWith('.pptx'))) {
      // Falling back to the agent's prose here would report a conversion that
      // produced no deck as a success with a note attached.
      throw new Error([t('ppt.noDeck'), answer?.trim() || t('ppt.noAgentReply')].filter(Boolean).join('\n'))
    }
    if (nodes.length === 0) {
      // The skill finished without a file: keep the agent's answer so the run
      // is not a silent no-op.
      const text = answer ?? ''
      if (text !== '') {
        const node = textOutputNode(target.node, skill.name, text, skill.id, skill.name, [target.node.id])
        nodes.push(node)
        connections.push({ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id })
      }
      warnings.push(t('canvas.skills.noOutputFile'))
    }
    return outputOf(nodes, connections, warnings)
  }

  /**
   * Resolve copy for one run's language, falling back to the host-installed
   * resolver when the caller sent none.
   * @param language - the caller's UI language, when it sent one.
   */
  private translate(language?: string): CatalogTranslate {
    return canvasSkillCopy(language)
  }
}

/** Minimal extension→MIME map for produced files (the store validates again). */
function mimeFromName(name: string): string {
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  switch (extension) {
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'pdf': return 'application/pdf'
    case 'json': return 'application/json'
    case 'csv': return 'text/csv'
    case 'md': return 'text/markdown'
    case 'txt': return 'text/plain'
    case 'zip': return 'application/zip'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

/** Copy resolver shared with the browser bundle (see locale-tables.ts). */
let translateHook: (key: string, params: Record<string, string | number> | undefined, language: string) => string = key => key
/** Install the real copy resolver (host half wires the locale dictionaries). */
export function setSkillTranslate(hook: typeof translateHook): void {
  translateHook = hook
}
function translateCanvasSkill(key: string, params: Record<string, string | number> | undefined, language: string): string {
  return translateHook(key, params, language)
}

/**
 * Active UI language for host-rendered copy. A run request carries no locale, so
 * the host half installs a resolver here; without one the host answers in
 * English (the browser half always renders its own copy through `tt`).
 */
let languageHook: () => string = () => 'en'
/** Install the active-language resolver. */
export function setSkillLanguage(hook: () => string): void {
  languageHook = hook
}
function currentSkillLanguage(): string {
  try { return languageHook() } catch { return 'zh' }
}

/**
 * Copy resolver for host-rendered canvas copy outside a run (the skill library
 * panel): the caller's language wins, the installed language resolver backs it
 * up, exactly as {@link SkillRunner.translate} does for runs.
 * @param language - the caller's UI language, when it sent one.
 */
export function canvasSkillCopy(language?: string): CatalogTranslate {
  const preferred = language !== undefined && language !== '' ? language : undefined
  return (key, params) => translateCanvasSkill(key, params, preferred ?? currentSkillLanguage())
}

export { isEditablePptSkill }

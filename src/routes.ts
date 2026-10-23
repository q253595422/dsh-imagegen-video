/**
 * The /api/dsh-imagegen route family: a loopback-only settings bridge for the
 * plugin's own namespace (describe/mutate, mirroring the dsh-web-ui family
 * bridge wire) and the generate proxy that forwards to the configured
 * OpenAI-compatible endpoint with the API key held host-side.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir as fsMkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type { SubscriptionManager } from './subscription/manager.ts'
import type { UpstreamConfig } from './engine.ts'
import { enhancePrompt, listImageModels, listPromptModels, polishPrompt, type PromptModelConfig } from './prompt-enhancer.ts'
import { analyzeLayers, MAX_LAYER_IMAGE_BYTES } from './layer-analyzer.ts'
import { normalizeImageModels } from './image-models.ts'
import { ImageGenerationRuntime, type ChannelsView } from './generation-runtime.ts'
import { appendHistory, clearHistory, listHistory, readHistoryImage, removeHistory } from './history-store.ts'
import { clearVideoHistory, drainVideoPosters, listVideoHistory, readVideoFile, removeVideoHistory } from './video-store.ts'
import { appendGallery, appendGalleryVideo, clearGallery, listGallery, listGalleryTrash, purgeGallery, readGalleryImage, readGalleryVideo, removeGallery, restoreGallery, updateGalleryTags } from './gallery-store.ts'
import { baseMime, canvasStore, CanvasConflictError, MAX_CANVAS_FILE_BYTES, mimeFromFileName, safeFileName, type CanvasFileInput, type CanvasImageInput, type CanvasStore } from './canvas-store.ts'
import { buildFilePreview } from './file-preview.ts'
import { imageDataRoot } from './image-storage-path.ts'
import { listTemplates, readTemplateImage, refreshTemplates, sampleTemplates } from './templates-store.ts'
import { addTemplateFavorite, listTemplateFavorites, removeTemplateFavorite } from './template-favorites.ts'
import { testStorage, type StorageSyncConfig } from './storage-sync.ts'
import { checkForUpdate, CURRENT_VERSION, installUpdate, ManualUpdateRequiredError, updateInstallTarget, type UpdateHostContext } from './updater.ts'
import { IMAGE_PRESETS } from './presets.ts'
import { clearDiagnostics, listDiagnostics } from './diagnostics-store.ts'
import { AGENT_IMAGE_API, CANVAS_API, CANVAS_SKILL_API, CODE_RENDER_API, CONVERSATION_IMAGE_API, DATA_FOLDER_API, DEFAULT_TEMPLATE_SOURCE_ID, DIAGNOSTICS_API, GALLERY_API, GENERATE_API, HISTORY_API, IMAGEGEN_SETTINGS_NAMESPACE, IMAGE_MODEL_API, PRESETS_API, PROMPT_ENHANCE_API, SETTINGS_API, STORAGE_API, SUBSCRIPTION_API, SUBSCRIPTION_PROVIDERS, TASK_API, TEMPLATE_FAVORITES_API, TEMPLATES_API, UPDATE_API, USAGE_API, VIDEO_API, isChannelProtocolPreference, isTemplateSourceId, type CanvasAssetRef, type CanvasDocument, type VideoDirectorPlan, type CanvasSkillCatalog, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type CanvasSkillRunRequest, type CanvasSkillTask, type PptRunRequest, type PptRuntimeStatus, type GeneratedImage, type GenerateRequest, type HistoryEntry, type HistoryEntryInput, type ModelMapping, type PresetProviderView, type TemplateFavorite, type TemplateListResult, type TemplateRefreshResult, type TemplateSample, type CanvasVideoTaskMeta, type VideoGenerateRequest, type VideoHistoryEntry } from './protocol.ts'
import { probeCodeRender } from './code-render-runtime.ts'

/** Cap on JSON request bodies (settings ops and generate payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024

/** Cap on history append bodies (base64 result images can be much larger). */
const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024

/** Image types the asset route always serves inline (they cannot execute). */
const CANVAS_INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/

/**
 * The only non-image types `?inline=1` will serve with their real content type:
 * the browser's own renderers for documents and media. Anything not listed here
 * (HTML, SVG, XML, unknown binaries) keeps coming back as an attachment.
 */
const CANVAS_INLINE_MIME = /^(application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/

/**
 * Parse one `bytes=a-b` range header. Three outcomes, because the route has to
 * tell them apart: no range (or a form we do not serve, such as a multi-range
 * list) means "send the whole body", while a syntactically valid range that
 * falls outside the file is unsatisfiable and must answer 416 with a
 * `content-range` naming the real size (RFC 7233). Collapsing the two into one
 * `undefined` used to answer 200 to a seek past the end.
 */
type ByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }

function parseByteRange(header: string | string[] | undefined, size: number): ByteRange {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (match === null) return { kind: 'none' }
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'none' }
  // A zero-byte file cannot satisfy any range at all.
  if (size <= 0) return { kind: 'unsatisfiable' }
  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: the last N bytes. `bytes=-0` asks for nothing.
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'unsatisfiable' }
    if (start >= size) return { kind: 'unsatisfiable' }
    end = Math.min(end, size - 1)
  }
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end }
}

/** Answer 416 for a range that cannot be satisfied, naming the real size. */
function writeUnsatisfiable(res: ServerResponse, size: number): void {
  res.writeHead(416, { 'content-range': `bytes */${size}` })
  res.end()
}

/**
 * Pipe a clip's read stream into the response, absorbing a read error.
 *
 * WHY the listener is not optional: `readVideoFile` / `readGalleryVideo` return
 * the path after `await fs.stat`, and the stream is opened later, so a clip
 * deleted in that window (removing a history entry, or the 30-entry cap evicting
 * the oldest while the browser still has the clip preloading) makes the stream
 * emit `error` with ENOENT. `pipe()` forwards errors to the *destination*, never
 * the source, and the host installs no `uncaughtException` handler, so an
 * unhandled `error` event takes the whole dsh web process down. Destroying the
 * response ends that one request instead.
 */
function pipeClip(stream: ReadStream, res: ServerResponse): void {
  stream.on('error', () => { res.destroy() })
  stream.pipe(res)
}

/** Settings seam face the bridge needs (the host settings provider). */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: unknown, ops: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
}

/** Route dependencies. */
export interface ImageGenRoutesDeps {
  /** The settings seam (namespace storage). */
  settings: SettingsSeam
  /** Internal namespace when the host entry differs from the bridge alias. */
  settingsNamespace?: string
  /** Resolve the current upstream config (legacy single-endpoint path). */
  resolve: () => UpstreamConfig
  /** Resolve the current channel view (the channel-aware path). */
  resolveChannels?: () => ChannelsView
  /** Resolve the optional chat-model configuration for prompt enhancement. */
  resolvePrompt?: () => PromptModelConfig
  /** Models explicitly selected for this image API endpoint (legacy path). */
  resolveImageModels?: () => string[]
  /** Host attachment storage used by Agent tool-result previews. */
  attachments?: {
    readImage: (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
    saveImage?: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>
  }
  /** Latest composer image staged for the direct edit_image command. */
  pendingConversationImages?: {
    set: (sessionId: string, ref: ImageAttachmentRef) => void
  }
  /** Overrideable history backend, primarily for host integration tests. */
  history?: {
    list: () => Promise<HistoryEntry[]>
    append: (entry: HistoryEntryInput) => Promise<HistoryEntry[]>
    remove: (id: string) => Promise<HistoryEntry[]>
    clear: () => Promise<HistoryEntry[]>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
  /** Overrideable gallery backend, primarily for host integration tests. */
  gallery?: {
    list: () => Promise<HistoryEntry[]>
    /** Soft-deleted entries, for the client's trash section. Optional so a
     *  harness written before the trash existed keeps compiling. */
    listTrash?: () => Promise<HistoryEntry[]>
    append: (entry: HistoryEntryInput) => Promise<{ entries: HistoryEntry[]; added: boolean }>
    /** Soft delete: returns the full list (live + trash); the route splits it. */
    remove: (id: string) => Promise<HistoryEntry[]>
    /** Undo a soft delete. */
    restore?: (id: string) => Promise<HistoryEntry[]>
    /** Permanently delete every trashed entry and its files. */
    purge?: () => Promise<HistoryEntry[]>
    clear: () => Promise<HistoryEntry[]>
    updateTags?: (id: string, tags: string[]) => Promise<HistoryEntry[]>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
    /** Favorite one finished clip by copying it out of the video store. */
    appendVideo?: (input: Parameters<typeof appendGalleryVideo>[0]) => Promise<{ entries: HistoryEntry[]; added: boolean }>
    /** Serve one favorited clip with Range support. */
    readVideo?: (file: string) => Promise<{ path: string; size: number; mime: string } | undefined>
  }
  /** Overrideable canvas backend, primarily for host integration tests. */
  canvas?: CanvasBackend
  /** Overrideable template-library backend, primarily for host integration tests. */
  templates?: {
    list: (sourceId: string) => Promise<TemplateListResult>
    refresh: (sourceId: string) => Promise<TemplateRefreshResult>
    sample: (count: number) => Promise<TemplateSample[]>
    readImage: (sourceId: string, file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
  /** Overrideable template-favorites backend, primarily for host integration tests. */
  favorites?: {
    list: () => Promise<TemplateFavorite[]>
    add: (sourceId: string, item: TemplateFavorite['case']) => Promise<TemplateFavorite[]>
    remove: (key: string) => Promise<TemplateFavorite[]>
  }
  /** Resolve the object-storage sync settings (with the real secret). */
  resolveStorage?: () => StorageSyncConfig
  /**
   * Launcher facts for the update routes: whether this host can install a bundle
   * itself, and the profile it booted. Hosts that predate the install hook omit
   * it, and the updater then falls back to argv/env probing and its CLI path.
   */
  resolveUpdateContext?: () => UpdateHostContext
  /** Shared host queue, used by Agent tools and browser task endpoints. */
  runtime?: ImageGenerationRuntime
  /**
   * Overrideable video backend, primarily for host integration tests. The
   * route layer drives the same code path in production; only the store is
   * injectable so a test can assert persisted shapes without touching disk.
   */
  video?: {
    list: () => Promise<VideoHistoryEntry[]>
    remove: (id: string) => Promise<VideoHistoryEntry[]>
    clear: () => Promise<VideoHistoryEntry[]>
    readFile: (file: string) => Promise<{ path: string; size: number; mime: string } | undefined>
  }
  /** Subscription login/status manager; absent on hosts without Credentials. */
  subscriptions?: SubscriptionManager
  /**
   * Canvas skill runner. Absent when the host skill registry or agent runtime
   * never mounted (deployments without them): the canvas then offers its
   * built-in text actions only and says why.
   */
  pptRuntime?: { check: () => Promise<PptRuntimeStatus>; install: () => Promise<PptRuntimeStatus> }
  skills?: {
    list: (language?: string) => Promise<CanvasSkillCatalog>
    run: (request: CanvasSkillRunRequest) => Promise<CanvasSkillTask>
    /** Standalone image-to-PPT conversion (no canvas involved). */
    runPpt?: (request: PptRunRequest) => Promise<CanvasSkillTask>
    /** Conversion history, including runs that outlived a reload. */
    pptTasks?: () => Promise<CanvasSkillTask[]>
    task: (id: string) => CanvasSkillTask | undefined
    tasksOfCanvas: (canvasId: string) => CanvasSkillTask[]
    cancel: (id: string) => Promise<boolean>
  }
  /**
   * Local skill library (`~/.dsh/skills`). Absent on hosts that cannot write to
   * the user's skill root: the browser then hides the install affordances.
   */
  skillLibrary?: {
    list: (options?: { language?: string }) => Promise<CanvasSkillLibrary>
    install: (request: CanvasSkillInstallRequest) => Promise<CanvasSkillInstallResult>
    remove: (name: string, options?: { language?: string }) => Promise<CanvasSkillRemoveResult>
    /** Save the values a skill's own declaration asked for. */
    configSave?: (request: CanvasSkillConfigSaveRequest) => Promise<CanvasSkillConfigSaveResult>
    /** Run the declaration's `apply` steps (commands / files). */
    configApply?: (request: CanvasSkillConfigApplyRequest) => Promise<CanvasSkillConfigApplyResult>
  }
}

/** Minimal canvas store contract so hosts can inject an isolated test backend. */
export interface CanvasBackend {
  list: () => Promise<Awaited<ReturnType<CanvasStore['list']>>>
  create: (title?: string) => Promise<Awaited<ReturnType<CanvasStore['create']>>>
  read: (id: string) => Promise<Awaited<ReturnType<CanvasStore['read']>>>
  save: (document: CanvasDocument, expectedRevision?: number) => Promise<Awaited<ReturnType<CanvasStore['save']>>>
  remove: (id: string) => Promise<Awaited<ReturnType<CanvasStore['remove']>>>
  setFavorite?: (id: string, favorite: boolean) => Promise<Awaited<ReturnType<CanvasStore['setFavorite']>>>
  putImage: (input: CanvasImageInput) => Promise<Awaited<ReturnType<CanvasStore['putImage']>>>
  readAsset: (file: string) => Promise<Awaited<ReturnType<CanvasStore['readAsset']>>>
  /** File assets (the canvas file node). Optional so older test backends work. */
  putFile?: (input: CanvasFileInput) => Promise<Awaited<ReturnType<CanvasStore['putFile']>>>
  /** Batch asset read, used by skill runs. Optional for the same reason. */
  readAssets?: (refs: readonly CanvasAssetRef[]) => Promise<Map<string, { data: Buffer; mime: string }>>
  /** Copy one asset to a real path for a heavy skill run. */
  materialize?: (ref: CanvasAssetRef, targetPath: string) => Promise<void>
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read a raw request body (the canvas file upload path; no base64 inflation). */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate the { source } body of a template-library request. */
function templateSourceOf(body: Record<string, unknown> | undefined): string | undefined {
  const raw = body?.source
  if (raw === undefined || raw === '') return DEFAULT_TEMPLATE_SOURCE_ID
  return typeof raw === 'string' && isTemplateSourceId(raw) ? raw : undefined
}

/** Validate the body of a canvas skill run (projected from the browser). */
function parseSkillRunRequest(body: Record<string, unknown> | undefined): CanvasSkillRunRequest | undefined {
  const canvasId = typeof body?.canvasId === 'string' ? body.canvasId.trim() : ''
  const skillId = typeof body?.skillId === 'string' ? body.skillId.trim() : ''
  if (canvasId === '' || skillId === '') return undefined
  const nodeIds = Array.isArray(body?.nodeIds)
    ? [...new Set(body.nodeIds.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== ''))]
    : []
  const instruction = typeof body?.instruction === 'string' ? body.instruction : undefined
  const params: Record<string, string> = {}
  if (body?.params !== null && typeof body?.params === 'object' && !Array.isArray(body.params)) {
    for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value
    }
  }
  return {
    canvasId,
    skillId,
    nodeIds,
    ...instruction === undefined ? {} : { instruction },
    ...Object.keys(params).length === 0 ? {} : { params },
    placement: body?.placement === 'below' ? 'below' : 'right',
    ...parseSkillLanguage(body),
  }
}

/** The UI language hint every skill route accepts (copy stays translated). */
function parseSkillLanguage(body: Record<string, unknown> | undefined): { language?: string } {
  const raw = typeof body?.language === 'string' ? body.language.trim().toLowerCase() : ''
  // Only the shipped dictionaries are accepted: the value reaches a lookup.
  return raw === 'zh' || raw === 'en' || raw === 'ru' ? { language: raw } : {}
}

/**
 * Normalize one skill-library install request: sources are trimmed, de-duped
 * URLs, and the uploaded archive is taken from an asset reference the canvas
 * upload route already stored (the host never sees raw browser bytes twice).
 */
function parseSkillInstallRequest(body: Record<string, unknown> | undefined): CanvasSkillInstallRequest | undefined {
  const raw = Array.isArray(body?.sources) ? body.sources : []
  const sources = [...new Set(raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item !== ''))].slice(0, 10)
  const asset = body?.asset !== null && typeof body?.asset === 'object' && !Array.isArray(body.asset)
    ? body.asset as CanvasAssetRef
    : undefined
  if (sources.length === 0 && asset === undefined) return undefined
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  return {
    ...sources.length === 0 ? {} : { sources },
    ...asset === undefined ? {} : { asset },
    ...name === '' ? {} : { name },
    force: body?.force === true,
    ...parseSkillLanguage(body),
  }
}

function parseGenerateRequest(body: Record<string, unknown>): GenerateRequest | undefined {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return undefined
  const comparisonModels = Array.isArray(body.comparisonModels)
    ? [...new Set(body.comparisonModels.filter((model): model is string => typeof model === 'string').map(model => model.trim()).filter(Boolean))]
    : []
  const canvas = parseCanvasMeta(body.canvas)
  return {
    mode: body.mode === 'edit' ? 'edit' : 'text',
    model: typeof body.model === 'string' ? body.model : '',
    prompt,
    size: typeof body.size === 'string' ? body.size : 'auto',
    quality: typeof body.quality === 'string' ? body.quality : 'auto',
    n: typeof body.n === 'number' ? body.n : 1,
    detail: typeof body.detail === 'string' ? body.detail : '',
    ...typeof body.image === 'string' && body.image !== '' ? { image: body.image } : {},
    ...Array.isArray(body.images)
      ? { images: body.images.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 4) }
      : {},
    ...typeof body.refName === 'string' && body.refName !== '' ? { refName: body.refName } : {},
    ...typeof body.channelId === 'string' && body.channelId !== '' ? { channelId: body.channelId } : {},
    ...typeof body.comparisonId === 'string' && body.comparisonId !== '' ? { comparisonId: body.comparisonId } : {},
    ...comparisonModels.length > 1 ? { comparisonModels } : {},
    ...canvas === undefined ? {} : { canvas },
    ...body.workflow === 'ecommerce' ? { workflow: 'ecommerce' as const } : {},
    ...typeof body.projectId === 'string' && body.projectId !== '' ? { projectId: body.projectId } : {},
    ...typeof body.projectName === 'string' && body.projectName !== '' ? { projectName: body.projectName } : {},
    ...typeof body.slotKey === 'string' && body.slotKey !== '' ? { slotKey: body.slotKey } : {},
    ...typeof body.slotLabel === 'string' && body.slotLabel !== '' ? { slotLabel: body.slotLabel } : {},
    // Same opt-in as the video route: absent means the image model path.
    ...body.renderer === 'code' ? { renderer: 'code' as const } : {},
    ...typeof body.renderSource === 'string' && body.renderSource.trim() !== '' ? { renderSource: body.renderSource } : {},
  }
}

function parseCanvasMeta(value: unknown): GenerateRequest['canvas'] {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.canvasId !== 'string' || raw.canvasId.trim() === '') return undefined
  return {
    canvasId: raw.canvasId.trim(),
    ...typeof raw.sourceNodeId === 'string' && raw.sourceNodeId.trim() !== '' ? { sourceNodeId: raw.sourceNodeId.trim() } : {},
    ...typeof raw.annotationNodeId === 'string' && raw.annotationNodeId.trim() !== '' ? { annotationNodeId: raw.annotationNodeId.trim() } : {},
    ...typeof raw.parentNodeId === 'string' && raw.parentNodeId.trim() !== '' ? { parentNodeId: raw.parentNodeId.trim() } : {},
    ...raw.placement === 'right' || raw.placement === 'below' ? { placement: raw.placement } : {},
  }
}

/** Stable wire code for a thrown video error. */
function videoCodeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'video-failed'
}

/**
 * Validate a submitted video request.
 *
 * The model alias is resolved against the configured video catalogs here, at
 * the wire boundary, so the engine only ever sees a model it can classify.
 * The channel id is filled in for the history snapshot the same way the image
 * path does it.
 */
function parseVideoRequest(
  body: Record<string, unknown>,
  view: ChannelsView,
  deps: ImageGenRoutesDeps,
): VideoGenerateRequest | undefined {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return undefined
  const mode = body.mode === 'image' || body.mode === 'keyframe' || body.mode === 'reference' ? body.mode : 'text'
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const seconds = typeof body.seconds === 'number' ? body.seconds : Number(body.seconds ?? 5)
  const resolution = typeof body.resolution === 'string' && body.resolution.trim() !== '' ? body.resolution.trim() : '720P'
  const images = Array.isArray(body.images)
    ? body.images.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 4)
    : []
  // Name the channel that owns the alias, so usage/status views can group it
  // even when the user later deletes the channel.
  const channel = deps.resolveChannels === undefined
    ? undefined
    : view.channels.find(candidate => (candidate.videoModels ?? []).some(row => row.alias === model))
  // Canvas lineage MUST survive this parser: the canvas matches a finished
  // render to its placeholder node by task id + canvasId. Dropping it here left
  // every canvas-started run unmatched, so the node sat at "generating" until
  // the orphan detector declared it failed -- while the render had in fact
  // succeeded and been persisted.
  const canvas = parseCanvasVideoMeta(body.canvas)
  return {
    mode,
    model,
    prompt,
    aspectRatio: typeof body.aspectRatio === 'string' && body.aspectRatio.trim() !== '' ? body.aspectRatio.trim() : '16:9',
    resolution: (resolution === '480P' || resolution === '720P' || resolution === '1080P' ? resolution : '720P'),
    seconds: Number.isFinite(seconds) ? seconds : 5,
    ...canvas === undefined ? {} : { canvas },
    ...typeof body.image === 'string' && body.image !== '' ? { image: body.image } : {},
    ...images.length > 0 ? { images } : {},
    ...typeof body.firstFrame === 'string' && body.firstFrame !== '' ? { firstFrame: body.firstFrame } : {},
    ...typeof body.lastFrame === 'string' && body.lastFrame !== '' ? { lastFrame: body.lastFrame } : {},
    ...typeof body.refName === 'string' && body.refName !== '' ? { refName: body.refName } : {},
    ...typeof body.channelId === 'string' && body.channelId !== '' ? { channelId: body.channelId } : {},
    ...channel === undefined ? {} : { channel: channel.name },
    ...typeof body.seed === 'number' && Number.isFinite(body.seed) ? { seed: body.seed } : {},
    // Explicit opt-in: an absent flag keeps the historical "send as typed"
    // behaviour for every existing caller (canvas, storyboard, Agent tools).
    ...body.plan === true ? { plan: true } : {},
    ...parsePlanPreview(body.planPreview) === undefined ? {} : { planPreview: parsePlanPreview(body.planPreview)! },
    // Second production path: a chat model writes the drawing code and this
    // host renders it. Absent keeps the historical model-provider behaviour.
    ...body.renderer === 'code' ? { renderer: 'code' as const } : {},
    ...typeof body.renderSource === 'string' && body.renderSource.trim() !== '' ? { renderSource: body.renderSource } : {},
  }
}

/**
 * Validate a client-supplied plan the user previewed.
 *
 * Structural check only: the semantic clamps (duration ceiling, family aspect
 * and resolution) run in the director when the plan is adopted, because that
 * is where the resolved model is known.
 */
function parsePlanPreview(value: unknown): VideoDirectorPlan | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') return undefined
  const params = raw.params !== null && typeof raw.params === 'object' ? raw.params as Record<string, unknown> : {}
  const style = raw.style !== null && typeof raw.style === 'object' ? raw.style as Record<string, unknown> : {}
  const shots = Array.isArray(raw.shots)
    ? raw.shots.flatMap((item, index) => {
      if (item === null || typeof item !== 'object') return []
      const shot = item as Record<string, unknown>
      const text = (key: string): string => typeof shot[key] === 'string' ? shot[key] as string : ''
      return [{
        index,
        shot: text('shot'),
        action: text('action'),
        camera: text('camera'),
        seconds: typeof shot.seconds === 'number' && Number.isFinite(shot.seconds) ? shot.seconds : 0,
      }]
    }).slice(0, 8)
    : []
  return {
    source: raw.source === 'chat' ? 'chat' : 'heuristic',
    style: {
      shotLanguage: typeof style.shotLanguage === 'string' ? style.shotLanguage : '',
      look: typeof style.look === 'string' ? style.look : '',
      pacing: typeof style.pacing === 'number' && Number.isFinite(style.pacing) ? style.pacing : 0.5,
    },
    shots,
    prompt: raw.prompt,
    params: {
      seconds: typeof params.seconds === 'number' && Number.isFinite(params.seconds) ? params.seconds : 5,
      aspectRatio: typeof params.aspectRatio === 'string' ? params.aspectRatio : '16:9',
      resolution: typeof params.resolution === 'string' ? params.resolution : '720P',
    },
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note): note is string => typeof note === 'string') : [],
    degraded: raw.degraded === true,
    ...typeof raw.degradedReason === 'string' ? { degradedReason: raw.degradedReason } : {},
  }
}

/** Validate the canvas lineage a video request may carry. */
function parseCanvasVideoMeta(value: unknown): CanvasVideoTaskMeta | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.canvasId !== 'string' || raw.canvasId.trim() === '') return undefined
  const references = Array.isArray(raw.referenceNodeIds)
    ? raw.referenceNodeIds.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 4)
    : []
  return {
    canvasId: raw.canvasId.trim(),
    ...typeof raw.sourceNodeId === 'string' && raw.sourceNodeId.trim() !== '' ? { sourceNodeId: raw.sourceNodeId.trim() } : {},
    ...typeof raw.nodeId === 'string' && raw.nodeId.trim() !== '' ? { nodeId: raw.nodeId.trim() } : {},
    ...references.length === 0 ? {} : { referenceNodeIds: references },
  }
}

/** Validate a submitted history entry (images carry base64). */
function parseHistoryEntryInput(body: Record<string, unknown>): HistoryEntryInput | undefined {
  const raw = body.entry
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.createdAt !== 'number') return undefined
  if (entry.mode !== 'text' && entry.mode !== 'edit') return undefined
  if (typeof entry.model !== 'string' || typeof entry.prompt !== 'string') return undefined
  if (typeof entry.size !== 'string' || typeof entry.quality !== 'string' || typeof entry.detail !== 'string') return undefined
  if (typeof entry.n !== 'number') return undefined
  if (!Array.isArray(entry.images)) return undefined
  const images: GeneratedImage[] = []
  for (const item of entry.images) {
    if (item === null || typeof item !== 'object') return undefined
    const image = item as Record<string, unknown>
    if (typeof image.b64 !== 'string' || typeof image.mime !== 'string') return undefined
    images.push({
      b64: image.b64,
      mime: image.mime,
      ...typeof image.revisedPrompt === 'string' ? { revisedPrompt: image.revisedPrompt } : {},
    })
  }
  const comparisonModels = Array.isArray(entry.comparisonModels)
    ? [...new Set(entry.comparisonModels.filter((model): model is string => typeof model === 'string').map(model => model.trim()).filter(Boolean))]
    : []
  const canvas = parseCanvasMeta(entry.canvas)
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    size: entry.size,
    quality: entry.quality,
    detail: entry.detail,
    n: entry.n,
    images,
    ...typeof entry.refName === 'string' ? { refName: entry.refName } : {},
    ...typeof entry.channelId === 'string' ? { channelId: entry.channelId } : {},
    ...typeof entry.channel === 'string' ? { channel: entry.channel } : {},
    ...typeof entry.comparisonId === 'string' ? { comparisonId: entry.comparisonId } : {},
    ...comparisonModels.length > 1 ? { comparisonModels } : {},
    ...canvas === undefined ? {} : { canvas },
    ...entry.workflow === 'ecommerce' ? { workflow: 'ecommerce' as const } : {},
    ...typeof entry.projectId === 'string' ? { projectId: entry.projectId } : {},
    ...typeof entry.projectName === 'string' ? { projectName: entry.projectName } : {},
    ...typeof entry.slotKey === 'string' ? { slotKey: entry.slotKey } : {},
    ...typeof entry.slotLabel === 'string' ? { slotLabel: entry.slotLabel } : {},
  }
}

/** Extract the image file name from a history-image request URL. */
function imageFileFrom(rawUrl: string | undefined, basePath: string): string | undefined {
  if (rawUrl === undefined) return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${basePath}/`)) return undefined
  return decodeURIComponent(pathname.slice(basePath.length + 1))
}

/** Parse the durable image reference carried by an Agent tool-result view. */
function agentImageRefFrom(rawUrl: string | undefined): ImageAttachmentRef | undefined {
  if (rawUrl === undefined) return undefined
  let url: URL
  try {
    url = new URL(rawUrl, 'http://localhost')
  } catch {
    return undefined
  }
  if (url.pathname !== AGENT_IMAGE_API) return undefined
  const attachmentId = url.searchParams.get('attachment_id') ?? ''
  const mediaType = url.searchParams.get('media_type') ?? ''
  const bytes = Number(url.searchParams.get('bytes'))
  const width = Number(url.searchParams.get('width'))
  const height = Number(url.searchParams.get('height'))
  if (attachmentId === '' || !isImageMediaType(mediaType)
    || !Number.isSafeInteger(bytes) || bytes < 1
    || !Number.isSafeInteger(width) || width < 1
    || !Number.isSafeInteger(height) || height < 1) return undefined
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
  }
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function imageDataUrl(value: string): { mediaType: ImageMediaType; data: Uint8Array } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const data = Buffer.from(match[2], 'base64')
  return data.byteLength === 0 ? undefined : { mediaType: match[1] as ImageMediaType, data }
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor: SettingsDescriptor, namespace = String(descriptor.ns)): Record<string, unknown> {
  return {
    ns: namespace,
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    ...descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })),
    },
    revision: descriptor.revision,
  }
}

/** Map a subscription provider to its manager vendor id. */
function vendorOfSubscription(provider: typeof SUBSCRIPTION_PROVIDERS[number]): 'codex' | 'grok' | 'antigravity' | 'openrouter' {
  if (provider === 'chatgpt-sub') return 'codex'
  if (provider === 'google-sub') return 'antigravity'
  if (provider === 'openrouter-sub') return 'openrouter'
  return 'grok'
}

/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'settings-rejected', message }
}

/**
 * Build every /api/dsh-imagegen route.
 * @param deps - settings seam + config resolver.
 * @returns the route registrations.
 */
export function makeRoutes(deps: ImageGenRoutesDeps): WebRoute[] {
  const history = deps.history ?? {
    list: listHistory,
    append: appendHistory,
    remove: removeHistory,
    clear: clearHistory,
    readImage: readHistoryImage,
  }
  const gallery: NonNullable<ImageGenRoutesDeps['gallery']> = deps.gallery ?? {
    list: listGallery,
    listTrash: listGalleryTrash,
    append: appendGallery,
    remove: removeGallery,
    restore: restoreGallery,
    purge: purgeGallery,
    clear: clearGallery,
    updateTags: updateGalleryTags,
    readImage: readGalleryImage,
    appendVideo: appendGalleryVideo,
    readVideo: readGalleryVideo,
  }
  const canvas = deps.canvas ?? canvasStore
  const templates = deps.templates ?? {
    list: listTemplates,
    refresh: refreshTemplates,
    sample: sampleTemplates,
    readImage: readTemplateImage,
  }
  const favorites = deps.favorites ?? {
    list: listTemplateFavorites,
    add: addTemplateFavorite,
    remove: removeTemplateFavorite,
  }
  const video: NonNullable<ImageGenRoutesDeps['video']> = deps.video ?? {
    list: listVideoHistory,
    remove: removeVideoHistory,
    clear: clearVideoHistory,
    readFile: readVideoFile,
  }
  const resolvePrompt = deps.resolvePrompt ?? (() => ({ apiUrl: '', apiKey: '', model: '' }))
  // Every gallery mutation answers with the same pair: what the user may see on
  // the shelf, and what sits in the trash. The stores return one combined list
  // (a soft delete only flips a flag), so the split lives here, once.
  const splitGallery = (entries: HistoryEntry[]): { entries: HistoryEntry[]; trash: HistoryEntry[] } => ({
    entries: entries.filter(entry => entry.deletedAt === undefined),
    trash: entries.filter(entry => entry.deletedAt !== undefined),
  })
  // Shared by the two clip-serving prefix routes (video store + gallery).
  const serveClip = async (
    req: IncomingMessage,
    res: ServerResponse,
    basePath: string,
    read: (file: string) => Promise<{ path: string; size: number; mime: string } | undefined>,
  ): Promise<void> => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return
    }
    const file = imageFileFrom(req.url, basePath)
    const found = file === undefined ? undefined : await read(file)
    if (found === undefined) { writeJson(res, 404, { error: 'not found' }); return }
    const headers: Record<string, string | number> = {
      'content-type': found.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    }
    // Media elements ask for byte ranges; answering 200 for every request would
    // break seeking in the clip player.
    const range = parseByteRange(req.headers.range, found.size)
    if (range.kind === 'unsatisfiable') { writeUnsatisfiable(res, found.size); return }
    if (range.kind === 'range') {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${found.size}`,
        'content-length': range.end - range.start + 1,
      })
      if (req.method === 'HEAD') { res.end(); return }
      pipeClip(createReadStream(found.path, { start: range.start, end: range.end }), res)
      return
    }
    res.writeHead(200, { ...headers, 'content-length': found.size })
    if (req.method === 'HEAD') { res.end(); return }
    pipeClip(createReadStream(found.path), res)
  }
  const resolveImageModels = deps.resolveImageModels ?? (() => normalizeImageModels(undefined))
  const settingsNamespace = deps.settingsNamespace ?? IMAGEGEN_SETTINGS_NAMESPACE

  /** The current channel view: the channel-aware resolver, or a synthesized
   *  single default channel from the legacy flat upstream config (tests and
   *  older hosts). */
  const channelViewOf = (): ChannelsView => {
    if (deps.resolveChannels !== undefined) return deps.resolveChannels()
    const upstream = deps.resolve()
    const models: ModelMapping[] = normalizeImageModels(resolveImageModels()).map(id => ({ alias: id, id }))
    if (upstream.apiUrl.trim() === '' && models.length === 0) return { channels: [], defaultChannelId: '' }
    return {
      channels: [{ id: 'default', preset: '', name: '默认渠道', apiUrl: upstream.apiUrl, apiUrlFull: false, apiKey: upstream.apiKey, models }],
      defaultChannelId: 'default',
    }
  }
  const runtime = deps.runtime ?? new ImageGenerationRuntime(channelViewOf, history)

  /** Resolve an alias (or the channel fallback) into a concrete generation
   *  request: picks the channel (explicit then default), maps alias → upstream
   *  id, and fills the channel snapshot kept on history entries. */
  const resolveChannelRequest = (request: GenerateRequest): { ok: true; request: GenerateRequest } | { ok: false; code: string; message: string } => {
    const view = channelViewOf()
    if (view.channels.length === 0) {
      return { ok: false, code: 'no-channels', message: '尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥' }
    }
    const explicit = view.channels.find(candidate => candidate.id === request.channelId)
    const defaults = view.channels.find(candidate => candidate.id === view.defaultChannelId) ?? view.channels[0]
    const target = explicit ?? defaults
    const asked = request.model.trim()
    if (asked === '') {
      const alias = target?.models[0]?.alias ?? ''
      if (alias === '') {
        return { ok: false, code: 'no-models', message: `渠道「${target?.name ?? ''}」尚未配置模型，请先在设置中添加` }
      }
      const mapping = target!.models.find(model => model.alias === alias)!
      return { ok: true, request: { ...request, model: alias, upstream: mapping.id, channelId: target!.id, channel: target!.name } }
    }
    const hosting = view.channels.filter(channel => channel.models.some(model => model.alias === asked))
    if (hosting.length === 0) {
      const available = [...new Set(view.channels.flatMap(channel => channel.models.map(model => model.alias)))]
      return { ok: false, code: 'image-model-not-configured', message: `模型「${asked}」未在任一渠道配置；可用模型：${available.join('、') || '（无）'}` }
    }
    const picked = target !== undefined && target.models.some(model => model.alias === asked) ? target : hosting[0]!
    const mapping = picked.models.find(model => model.alias === asked)!
    return { ok: true, request: { ...request, model: asked, upstream: mapping.id, channelId: picked.id, channel: picked.name } }
  }
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  return [
    // ---------------------------- composer image for /edit_image (exact)
    ...(deps.attachments?.saveImage === undefined || deps.pendingConversationImages === undefined ? [] : [{
      kind: 'exact' as const,
      path: CONVERSATION_IMAGE_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        const dataUrl = typeof body?.dataUrl === 'string' ? imageDataUrl(body.dataUrl) : undefined
        if (sessionId === '' || dataUrl === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'sessionId and image data are required' })
          return
        }
        try {
          const ref = await deps.attachments!.saveImage!({
            data: dataUrl.data,
            mediaType: dataUrl.mediaType,
            ...typeof body?.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {},
          })
          deps.pendingConversationImages!.set(sessionId, ref)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'image-save-failed', message: messageOf(error) })
        }
      },
    } satisfies WebRoute]),
    // ------------------------------------ Agent tool-result image (prefix)
    ...(deps.attachments === undefined ? [] : [{
      kind: 'prefix' as const,
      path: AGENT_IMAGE_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const ref = agentImageRefFrom(req.url)
        if (ref === undefined) {
          writeJson(res, 400, { error: 'invalid image reference' })
          return
        }
        try {
          const stored = await deps.attachments!.readImage(ref)
          res.writeHead(200, {
            'content-type': stored.ref.mediaType,
            'content-length': stored.data.byteLength,
            'cache-control': 'private, max-age=3600',
          })
          res.end(Buffer.from(stored.data))
        } catch {
          // Do not expose attachment-store details through the browser route.
          writeJson(res, 404, { error: 'image attachment not found' })
        }
      },
    } satisfies WebRoute]),
    // -------------------------------------------- image model discovery
    // Accepts optional temporary per-channel credentials so the settings card
    // can probe the endpoint the user is *typing* without saving first:
    //   { channelId?, apiUrl?, apiKey? } — the channel's stored values are the
    //   fallback, and the body's apiUrl/apiKey override them for this call.
    {
      kind: 'exact',
      path: IMAGE_MODEL_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const view = channelViewOf()
        const stored = view.channels.find(candidate => candidate.id === (typeof body?.channelId === 'string' ? body.channelId : undefined))
          ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
          ?? view.channels[0]
        const protocol = isChannelProtocolPreference(body?.protocol)
          ? body.protocol
          : stored?.protocol
        const upstream: UpstreamConfig = {
          apiUrl: typeof body?.apiUrl === 'string' && body.apiUrl.trim() !== '' ? body.apiUrl.trim() : (stored?.apiUrl ?? ''),
          apiKey: typeof body?.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : (stored?.apiKey ?? ''),
          apiUrlFull: typeof body?.apiUrlFull === 'boolean' ? body.apiUrlFull : stored?.apiUrlFull === true,
          ...protocol === undefined ? {} : { protocol },
        }
        try {
          writeJson(res, 200, { ok: true, models: await listImageModels(upstream) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'image-models-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------------- presets
    {
      kind: 'exact',
      path: PRESETS_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const presets: PresetProviderView[] = IMAGE_PRESETS.map(preset => ({
          id: preset.id,
          name: preset.name,
          apiUrl: preset.apiUrl,
          hint: preset.hint,
          models: preset.models,
          ...preset.videoModels === undefined ? {} : { videoModels: preset.videoModels },
          ...preset.subscription === undefined ? {} : { subscription: preset.subscription },
          ...preset.experimental === undefined ? {} : { experimental: preset.experimental },
        }))
        writeJson(res, 200, { ok: true, presets })
      },
    },
    // ----------------------------------------------------------- usage
    {
      kind: 'exact',
      path: USAGE_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const entries = [...await history.list(), ...await gallery.list()]
          // byChannel[channelId | 'name:<name>' | ''] → { alias: count }.
          const byChannel: Record<string, Record<string, number>> = {}
          const totals: Record<string, number> = {}
          for (const entry of entries) {
            const channelKey = entry.channelId !== undefined ? entry.channelId : (entry.channel !== undefined ? `name:${entry.channel}` : '')
            const alias = entry.model
            const bucket = byChannel[channelKey] ?? (byChannel[channelKey] = {})
            bucket[alias] = (bucket[alias] ?? 0) + 1
            totals[alias] = (totals[alias] ?? 0) + 1
          }
          writeJson(res, 200, { ok: true, usage: { byChannel, totals } })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'usage-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------- prompt enhancement
    {
      kind: 'exact',
      path: PROMPT_ENHANCE_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, models: await listPromptModels(resolvePrompt()) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'prompt-models-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: PROMPT_ENHANCE_API.enhance,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        try {
          const polished = body?.mode === 'polish'
          writeJson(res, 200, { ok: true, prompt: polished ? await polishPrompt(resolvePrompt(), prompt) : await enhancePrompt(resolvePrompt(), prompt) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'prompt-enhance-failed', message: messageOf(error) })
        }
      },
    },
    // -------------------------------------------------- settings describe
    {
      kind: 'exact',
      path: SETTINGS_API.describe,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === settingsNamespace)
        writeJson(res, 200, {
          ok: true,
          value: {
            namespaces: descriptor === undefined ? [] : [toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE)],
            writable: deps.settings.writable !== false,
          },
        })
      },
    },
    // ----------------------------------------------------- settings mutate
    {
      kind: 'exact',
      path: SETTINGS_API.mutate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const ns = typeof body.ns === 'string' ? body.ns : ''
        if (ns !== IMAGEGEN_SETTINGS_NAMESPACE || !Array.isArray(body.ops)) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
          return
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
        try {
          // The bridge accepts its stable public alias; managed-form hosts
          // map that alias to their profile entry id for the actual write.
          await deps.settings.mutate(settingsNamespace, body.ops, expectedRevision)
        } catch (error) {
          writeJson(res, 200, failureOf(error))
          return
        }
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === settingsNamespace)
        if (descriptor === undefined) {
          writeJson(res, 200, { ok: false, code: 'internal', message: `settings namespace "${settingsNamespace}" was disposed after the mutate` })
          return
        }
        writeJson(res, 200, { ok: true, value: toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE) })
      },
    },
    // ----------------------------------------------------------- generate
    {
      kind: 'exact',
      path: GENERATE_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseGenerateRequest(body)
        if (parsed === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        // A code render needs no image provider at all, so the channel gate must
        // not run for it: with zero channels configured the runtime still has a
        // chat model (the host's) and a local renderer, and refusing here would
        // reintroduce exactly the dependency this path exists to remove.
        const resolved = parsed.renderer === 'code'
          ? { ok: true as const, request: parsed }
          : resolveChannelRequest(parsed)
        if (!resolved.ok) {
          writeJson(res, 200, { ok: false, code: resolved.code, message: resolved.message })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...await runtime.run(resolved.request) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'generate-failed'
          writeJson(res, 200, { ok: false, code, message })
        }
      },
    },
    // ------------------------------------------------ generation task queue
    {
      kind: 'exact', path: TASK_API.submit,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseGenerateRequest(body)
        if (parsed === undefined) { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' }); return }
        // Same opt-out as GENERATE_API: the code path resolves no channel.
        const resolved = parsed.renderer === 'code'
          ? { ok: true as const, request: parsed }
          : resolveChannelRequest(parsed)
        if (!resolved.ok) {
          writeJson(res, 200, { ok: false, code: resolved.code, message: resolved.message })
          return
        }
        writeJson(res, 200, { ok: true, task: runtime.queue.submit(resolved.request) })
      },
    },
    {
      kind: 'exact', path: TASK_API.list,
      handler: async (req, res) => { if (!guard(req, res, 'POST')) return; writeJson(res, 200, { ok: true, tasks: runtime.queue.summaries() }) },
    },
    // ------------------------------------------------ generation diagnostics
    // Every upstream attempt is retained host-side so a failure can be
    // explained after the fact (#38). The entries are already redacted when
    // recorded; this route only reads them back.
    {
      kind: 'exact', path: DIAGNOSTICS_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        writeJson(res, 200, { ok: true, entries: listDiagnostics() })
      },
    },
    {
      kind: 'exact', path: DIAGNOSTICS_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        clearDiagnostics()
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact', path: TASK_API.get,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? runtime.queue.get(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact', path: TASK_API.cancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? runtime.queue.cancel(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact', path: TASK_API.retry,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? runtime.queue.retry(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    // ----------------------------------------------- update check
    {
      kind: 'exact',
      path: UPDATE_API.check,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, update: { ...await checkForUpdate(), ...updateInstallTarget(undefined, undefined, deps.resolveUpdateContext?.()) } })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'update-check-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------- update apply
    {
      kind: 'exact',
      path: UPDATE_API.apply,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const version = body !== undefined && typeof body.version === 'string' ? body.version.trim() : ''
        if (version === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'update version is required' })
          return
        }
        try {
          const latest = await checkForUpdate()
          if (!latest.updateAvailable || latest.latestVersion !== version) {
            writeJson(res, 200, { ok: false, code: 'update-not-available', message: `version ${version} is not the latest available release` })
            return
          }
          await installUpdate(version, undefined, undefined, undefined, undefined, deps.resolveUpdateContext?.())
          writeJson(res, 200, { ok: true, currentVersion: CURRENT_VERSION, updatedVersion: version, restartRequired: true })
        } catch (error) {
          // DSH Desktop locks its profile away from the CLI, so "update online"
          // cannot work there. That is not a failure to retry — it is a
          // different route to the same file, and the response has to carry the
          // archive URL so the panel can offer it instead of "update failed".
          if (error instanceof ManualUpdateRequiredError) {
            writeJson(res, 200, {
              ok: false,
              code: error.code,
              message: error.message,
              profile: error.profile,
              tarballUrl: error.tarballUrl,
              updatedVersion: version,
            })
            return
          }
          writeJson(res, 200, { ok: false, code: 'update-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------ subscription status
    ...(deps.subscriptions === undefined ? [] : [{
      kind: 'exact' as const,
      path: SUBSCRIPTION_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const statuses: Record<string, { state: string; email?: string }> = {}
        for (const provider of SUBSCRIPTION_PROVIDERS) {
          const vendor = vendorOfSubscription(provider)
          const status = await deps.subscriptions!.loginStatus(vendor)
          const error = deps.subscriptions!.lastLoginError(vendor)
          statuses[provider] = status.state === 'logged-in'
            ? { state: status.state, email: status.email }
            : { state: status.state, ...error === undefined ? {} : { error } }
        }
        writeJson(res, 200, { ok: true, statuses })
      },
    }, {
      kind: 'exact' as const,
      path: SUBSCRIPTION_API.login,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const provider = typeof body?.provider === 'string' ? body.provider : ''
        if (!(SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)) {
          writeJson(res, 200, { ok: false, code: 'invalid-provider', message: 'unknown subscription provider' })
          return
        }
        const vendor = vendorOfSubscription(provider as typeof SUBSCRIPTION_PROVIDERS[number])
        try {
          if (body?.action === 'logout') {
            await deps.subscriptions!.logout(vendor)
            writeJson(res, 200, { ok: true })
            return
          }
          if (body?.action === 'complete') {
            const input = typeof body.input === 'string' ? body.input : ''
            await deps.subscriptions!.completeLogin(vendor, input)
            writeJson(res, 200, { ok: true })
            return
          }
          writeJson(res, 200, { ok: true, ...await deps.subscriptions!.beginLogin(vendor) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'subscription-login-failed', message: messageOf(error) })
        }
      },
    }] ),
    // ----------------------------------------------------- history list
    {
      kind: 'exact',
      path: HISTORY_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.list() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- history append
    {
      kind: 'exact',
      path: HISTORY_API.append,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const entry = parseHistoryEntryInput(body)
        if (entry === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'malformed history entry' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.append(entry) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- history remove
    {
      kind: 'exact',
      path: HISTORY_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'history id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.remove(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------- history clear
    {
      kind: 'exact',
      path: HISTORY_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.clear() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------ history image (prefix)
    {
      kind: 'prefix',
      path: HISTORY_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, HISTORY_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await history.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(found.data)
      },
    },
    // ----------------------------------------------------- gallery list
    {
      kind: 'exact',
      path: GALLERY_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const [entries, trash] = await Promise.all([
            gallery.list(),
            gallery.listTrash === undefined ? Promise.resolve([]) : gallery.listTrash(),
          ])
          writeJson(res, 200, { ok: true, entries, trash })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- gallery append
    {
      kind: 'exact',
      path: GALLERY_API.append,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const entry = parseHistoryEntryInput(body)
        if (entry === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'malformed gallery entry' })
          return
        }
        try {
          // The host owns gallery ids: a fresh id per append keeps retries and
          // duplicate submissions from ever reusing a stale filename prefix.
          const result = await gallery.append({ ...entry, id: randomUUID() })
          writeJson(res, 200, { ok: true, entries: result.entries, added: result.added })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- gallery remove
    {
      kind: 'exact',
      path: GALLERY_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'gallery id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...splitGallery(await gallery.remove(id)) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------- gallery restore
    {
      kind: 'exact',
      path: GALLERY_API.restore,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '' || gallery.restore === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'gallery id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...splitGallery(await gallery.restore(id)) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // -------------------------------------------------- gallery purge
    {
      kind: 'exact',
      path: GALLERY_API.purge,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (gallery.purge === undefined) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: '宿主不支持清空回收站' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...splitGallery(await gallery.purge()) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------------- gallery tags
    {
      kind: 'exact',
      path: GALLERY_API.tags,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const tags = Array.isArray(body?.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
        if (id === '' || tags === undefined || gallery.updateTags === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'gallery id and tags are required' })
          return
        }
        try { writeJson(res, 200, { ok: true, ...splitGallery(await gallery.updateTags(id, tags)) }) } catch (error) { writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- gallery clear
    {
      kind: 'exact',
      path: GALLERY_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, ...splitGallery(await gallery.clear()) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------ gallery image (prefix)
    {
      kind: 'prefix',
      path: GALLERY_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, GALLERY_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await gallery.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(found.data)
      },
    },
    // ------------------------------------------- gallery: favorite a clip
    //
    // The client names a clip by its video-history entry; the host resolves the
    // file itself and COPIES it, so no video bytes travel over this route and a
    // favorite survives the video history's size cap.
    {
      kind: 'exact',
      path: GALLERY_API.video,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (gallery.appendVideo === undefined) {
          writeJson(res, 200, { ok: false, code: 'gallery-video-unsupported', message: '当前宿主不支持收藏视频' })
          return
        }
        const body = await readJsonBody(req)
        const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : ''
        if (entryId === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'entryId is required' })
          return
        }
        try {
          const entries = await video.list()
          const entry = entries.find(candidate => candidate.id === entryId)
          const clip = entry?.videos[0]
          if (entry === undefined || clip === undefined) {
            writeJson(res, 200, { ok: false, code: 'not-found', message: '视频不存在或已被清理' })
            return
          }
          // Resolve the stored file from its served URL, then copy it.
          const file = imageFileFrom(clip.url, VIDEO_API.file)
          const found = file === undefined ? undefined : await video.readFile(file)
          if (found === undefined) {
            writeJson(res, 200, { ok: false, code: 'not-found', message: '视频文件已不存在' })
            return
          }
          const result = await gallery.appendVideo({
            id: randomUUID(),
            createdAt: Date.now(),
            model: entry.model,
            prompt: entry.prompt,
            aspectRatio: entry.aspectRatio,
            seconds: entry.seconds,
            sourcePath: found.path,
            mime: found.mime,
            ...clip.duration === undefined ? {} : { duration: clip.duration },
            ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
            ...entry.channel === undefined ? {} : { channel: entry.channel },
            ...Array.isArray(body?.tags)
              ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '').slice(0, 20) }
              : {},
          })
          writeJson(res, 200, { ok: true, entries: result.entries, added: result.added })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------- gallery clip (prefix)
    {
      kind: 'prefix',
      path: GALLERY_API.videoFile,
      handler: (req, res) => gallery.readVideo === undefined
        ? Promise.resolve(writeJson(res, 404, { error: 'not found' }))
        : serveClip(req, res, GALLERY_API.videoFile, gallery.readVideo),
    },
    // ------------------------------------------------------ canvas list
    {
      kind: 'exact',
      path: CANVAS_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try { writeJson(res, 200, { ok: true, projects: await canvas.list() }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- canvas create
    {
      kind: 'exact',
      path: CANVAS_API.create,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const title = typeof body?.title === 'string' ? body.title : '未命名画布'
        try { writeJson(res, 200, { ok: true, document: await canvas.create(title) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------------ canvas read
    {
      kind: 'exact',
      path: CANVAS_API.read,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const document = id === '' ? undefined : await canvas.read(id)
        if (document === undefined) writeJson(res, 200, { ok: false, code: 'not-found', message: '画布不存在' })
        else writeJson(res, 200, { ok: true, document })
      },
    },
    // ------------------------------------------------------ canvas save
    {
      kind: 'exact',
      path: CANVAS_API.save,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const document = body?.document as CanvasDocument | undefined
        const expectedRevision = typeof body?.expectedRevision === 'number' ? body.expectedRevision : undefined
        if (document === undefined || typeof document !== 'object') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvas document is required' })
          return
        }
        try { writeJson(res, 200, { ok: true, document: await canvas.save(document, expectedRevision) }) }
        catch (error) {
          const code = error instanceof CanvasConflictError ? error.code : 'canvas-failed'
          writeJson(res, 200, { ok: false, code, message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------- canvas remove
    {
      kind: 'exact',
      path: CANVAS_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvas id is required' }); return }
        try { writeJson(res, 200, { ok: true, projects: await canvas.remove(id) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-failed', message: messageOf(error) }) }
      },
    },
    // -------------------------------------------------- canvas favorite
    {
      kind: 'exact',
      path: CANVAS_API.favorite,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        const favorite = body?.favorite === true
        if (id === '') { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvas id is required' }); return }
        if (canvas.setFavorite === undefined) {
          writeJson(res, 200, { ok: false, code: 'canvas-favorite-unsupported', message: '当前画布后端不支持收藏' })
          return
        }
        try { writeJson(res, 200, { ok: true, projects: await canvas.setFavorite(id, favorite) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-favorite-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------ canvas asset upload
    {
      kind: 'exact',
      path: CANVAS_API.assetUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        const parsed = typeof body?.dataUrl === 'string' ? imageDataUrl(body.dataUrl) : undefined
        const width = Number(body?.width)
        const height = Number(body?.height)
        if (parsed === undefined || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'image data and dimensions are required' })
          return
        }
        try {
          const asset = await canvas.putImage({
            data: parsed.data,
            mime: parsed.mediaType,
            width,
            height,
            origin: body?.origin === 'history' || body?.origin === 'gallery' || body?.origin === 'generated' ? body.origin : 'upload',
            ...typeof body?.originId === 'string' ? { originId: body.originId } : {},
            ...typeof body?.entryId === 'string' ? { entryId: body.entryId } : {},
            ...Number.isSafeInteger(Number(body?.imageIndex)) ? { imageIndex: Number(body?.imageIndex) } : {},
          })
          writeJson(res, 200, { ok: true, asset })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-asset-failed', message: messageOf(error) }) }
      },
    },
    // ----------------------------------------------- canvas asset import
    {
      kind: 'exact',
      path: CANVAS_API.assetImport,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const source = body?.source === 'history' || body?.source === 'gallery' ? body.source : undefined
        const entryId = typeof body?.entryId === 'string' ? body.entryId : ''
        const imageIndex = Number(body?.imageIndex)
        const width = Number(body?.width)
        const height = Number(body?.height)
        if (source === undefined || entryId === '' || !Number.isSafeInteger(imageIndex) || imageIndex < 0
          || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'source, entryId, imageIndex and dimensions are required' })
          return
        }
        try {
          const backend = source === 'history' ? history : gallery
          const entry = (await backend.list()).find(item => item.id === entryId)
          const image = entry?.images[imageIndex]
          if (image === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'image not found' }); return }
          const base = source === 'history' ? HISTORY_API.image : GALLERY_API.image
          const file = imageFileFrom(image.url, base)
          const found = file === undefined ? undefined : await backend.readImage(file)
          if (found === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'image not found' }); return }
          const asset = await canvas.putImage({ data: found.data, mime: found.mime, width, height, origin: source, originId: entryId, entryId, imageIndex })
          writeJson(res, 200, { ok: true, asset })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-asset-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------- canvas layer decomposition
    // The browser sends one image data URL; the host asks the configured chat
    // model (the prompt-enhancement endpoint) for a strict JSON layer plan.
    {
      kind: 'exact',
      path: CANVAS_API.layers,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const raw = typeof body?.image === 'string' ? body.image.trim() : ''
        const image = raw === '' ? undefined : imageDataUrl(raw)
        if (image === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'image data URL is required' })
          return
        }
        if (image.data.byteLength > MAX_LAYER_IMAGE_BYTES) {
          writeJson(res, 200, { ok: false, code: 'image-too-large', message: '图片超过 12MB 上限，请先压缩后再拆分图层' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, plan: await analyzeLayers(resolvePrompt(), raw) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'layer-analysis-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------- canvas asset (prefix)
    {
      kind: 'prefix',
      path: CANVAS_API.asset,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if (req.method !== 'GET') { writeJson(res, 405, { error: `method not allowed: ${req.method}` }); return }
        const file = imageFileFrom(req.url, CANVAS_API.asset)
        const found = file === undefined ? undefined : await canvas.readAsset(file)
        if (found === undefined) { writeJson(res, 404, { error: 'not found' }); return }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        // Image assets stay inline (the canvas renders them). Only an explicit
        // `?inline=1` unlocks the other previewable types (pdf / audio / video),
        // and only from a fixed allow-list: everything else — including any
        // HTML/SVG-shaped payload that slipped past the upload name check — is
        // forced into a download with a neutral content type, so it can never
        // execute in the app's origin.
        const image = CANVAS_INLINE_IMAGE_MIME.test(found.mime)
        const wantsInline = url.searchParams.get('inline') === '1'
        const downloadRequested = url.searchParams.get('download') === '0'
        const inline = (image && !downloadRequested) || (wantsInline && CANVAS_INLINE_MIME.test(found.mime))
        if (!inline) {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': found.data.length,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-disposition': `attachment; filename="${file ?? 'asset'}"`,
          })
          res.end(found.data)
          return
        }
        const headers: Record<string, string | number> = {
          'content-type': found.mime,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename="${file ?? 'asset'}"`,
          'accept-ranges': 'bytes',
        }
        // Media elements ask for byte ranges; answering 200 for every request
        // would break seeking in audio/video previews.
        const range = parseByteRange(req.headers.range, found.data.length)
        if (range.kind === 'unsatisfiable') { writeUnsatisfiable(res, found.data.length); return }
        if (range.kind === 'range') {
          const slice = found.data.subarray(range.start, range.end + 1)
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${range.start}-${range.end}/${found.data.length}`,
            'content-length': slice.length,
          })
          res.end(slice)
          return
        }
        res.writeHead(200, { ...headers, 'content-length': found.data.length })
        res.end(found.data)
      },
    },
    // ------------------------------------------------- canvas file upload
    // Raw binary (the browser sends the File object directly), so large files
    // never pay the base64 + JSON round trip the image path uses. Note that
    // this path also prefix-matches CANVAS_API.asset; the host router resolves
    // exact routes first, exactly as it already does for `/canvas/layers`.
    {
      kind: 'exact',
      path: CANVAS_API.fileUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (canvas.putFile === undefined) {
          writeJson(res, 200, { ok: false, code: 'canvas-files-unsupported', message: '当前画布后端不支持文件资产' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const name = safeFileName(url.searchParams.get('name') ?? 'file')
        const header = req.headers['content-type']
        const declared = typeof header === 'string' ? header : ''
        const mime = declared.trim() === '' ? mimeFromFileName(name) : declared
        const data = await readRawBody(req, MAX_CANVAS_FILE_BYTES)
        if (data === undefined || data.byteLength === 0) {
          writeJson(res, 200, { ok: false, code: 'file-too-large', message: `文件为空或超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限` })
          return
        }
        try {
          const asset = await canvas.putFile({ data, mime, name, origin: 'upload' })
          writeJson(res, 200, { ok: true, asset })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'canvas-file-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------------------ canvas file preview
    // One canvas file node asks for its readable content: text / table /
    // office text / archive listing / inline-media descriptor. The bytes stay
    // host-side; the browser only ever receives decoded, bounded content.
    {
      kind: 'exact',
      path: CANVAS_API.filePreview,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const assetId = typeof body?.assetId === 'string' ? body.assetId : ''
        if (assetId === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'assetId 是必填项' })
          return
        }
        const found = await canvas.readAsset(assetId)
        if (found === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '画布资产不存在，可能已被清理。' })
          return
        }
        try {
          // The browser's node metadata knows the original file name and MIME
          // type; the content-addressed store only kept an extension-derived
          // pair, so the hints make the format decision more accurate. They are
          // hints only: the bytes always come from the host-side asset.
          const hintName = typeof body?.name === 'string' ? safeFileName(body.name) : ''
          const rawMime = typeof body?.mime === 'string' && body.mime.length <= 160 ? baseMime(body.mime) : ''
          const mime = rawMime === '' || rawMime === 'application/octet-stream' ? found.mime : rawMime
          writeJson(res, 200, {
            ok: true,
            preview: buildFilePreview({
              data: found.data,
              mime,
              name: hintName === '' ? assetId : hintName,
              url: `${CANVAS_API.asset}/${encodeURIComponent(assetId)}?inline=1`,
            }),
          })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'preview-failed', message: messageOf(error) }) }
      },
    },
    // Standalone PPT conversion shares the skill runtime and asset store.
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.pptRuntime,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.pptRuntime === undefined) { writeJson(res, 200, { ok: false, message: 'PPT runtime unavailable' }); return }
        try {
          const runtime = body?.install === true ? await deps.pptRuntime.install() : await deps.pptRuntime.check()
          writeJson(res, 200, { ok: true, runtime })
        } catch (error) { writeJson(res, 200, { ok: false, message: messageOf(error) }) }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.pptTasks,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (deps.skills?.pptTasks === undefined) { writeJson(res, 200, { ok: false, message: 'PPT runtime unavailable' }); return }
        try { writeJson(res, 200, { ok: true, tasks: await deps.skills.pptTasks() }) }
        catch (error) { writeJson(res, 200, { ok: false, message: messageOf(error) }) }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.pptRun,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (!Array.isArray(body?.images) || body.images.length < 1 || body.images.length > 12
          || typeof body.offlineOcr !== 'boolean') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请选择1–12张图片和OCR方式' }); return
        }
        // The client sends asset ids only; the URL is rebuilt here so a caller
        // cannot point the conversion at an arbitrary address.
        const images: CanvasAssetRef[] = []
        for (const raw of body.images) {
          if (raw === null || typeof raw !== 'object' || typeof raw.assetId !== 'string' || !/^[\w.-]+$/.test(raw.assetId)) {
            writeJson(res, 200, { ok: false, code: 'bad-request', message: '图片资产无效' }); return
          }
          images.push({ assetId: raw.assetId, url: `${CANVAS_API.asset}/${encodeURIComponent(raw.assetId)}`, mime: '', width: 0, height: 0, bytes: 0, origin: 'upload' })
        }
        if (deps.skills?.runPpt === undefined) { writeJson(res, 200, { ok: false, message: 'PPT runtime unavailable' }); return }
        try {
          const runtime = await deps.pptRuntime?.check()
          if (runtime !== undefined && !runtime.available) throw new Error(`editppt 尚未就绪，请在生图配置中检查或安装运行环境。${runtime.message}`)
          writeJson(res, 200, { ok: true, task: await deps.skills.runPpt({ images, offlineOcr: body.offlineOcr, ...parseSkillLanguage(body) }) })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'ppt-run-failed', message: messageOf(error) }) }
      },
    },
    // --------------------------------------------------- canvas skills list
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skills === undefined) {
          writeJson(res, 200, {
            ok: true,
            skills: [],
            agentAvailable: false,
            registryAvailable: false,
            reason: '本宿主未挂载技能注册表（ctx.skills），画布技能不可用。',
          })
          return
        }
        try { writeJson(res, 200, { ok: true, ...await deps.skills.list(parseSkillLanguage(body).language) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skills-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- canvas skills run
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.run,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const request = parseSkillRunRequest(body)
        if (request === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'canvasId、skillId 与 nodeIds 是必填项' })
          return
        }
        if (deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'skills-unavailable', message: '本宿主未挂载技能运行时，画布技能不可用。' })
          return
        }
        try { writeJson(res, 200, { ok: true, task: await deps.skills.run(request) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skill-run-failed', message: messageOf(error) }) }
      },
    },
    // --------------------------------------------------- canvas skills task
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.task,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        // A canvas id without a task id lists the canvas's unfinished runs:
        // a reopened canvas rebuilds its live run cards from this.
        const canvasId = typeof body?.canvasId === 'string' ? body.canvasId.trim() : ''
        if (canvasId !== '') {
          writeJson(res, 200, { ok: true, tasks: deps.skills.tasksOfCanvas(canvasId) })
          return
        }
        const id = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        const task = deps.skills.task(id)
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    // ------------------------------------------------- canvas skills cancel
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.cancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
        if (id === '' || deps.skills === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在' })
          return
        }
        try { writeJson(res, 200, { ok: true, cancelled: await deps.skills.cancel(id) }) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'skill-cancel-failed', message: messageOf(error) }) }
      },
    },
    // -------------------------------------------------- skill library (local)
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.library,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持管理本机技能库。' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, library: await deps.skillLibrary.list(parseSkillLanguage(body)) })
        } catch (error) { writeJson(res, 200, { ok: false, code: 'library-failed', message: messageOf(error) }) }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.install,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持安装技能。' })
          return
        }
        const request = parseSkillInstallRequest(body)
        if (request === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请提供技能来源链接或上传压缩包。' })
          return
        }
        try { writeJson(res, 200, await deps.skillLibrary.install(request)) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'install-failed', message: messageOf(error) }) }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持卸载技能。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        try { writeJson(res, 200, await deps.skillLibrary.remove(name, parseSkillLanguage(body))) }
        catch (error) { writeJson(res, 200, { ok: false, code: 'remove-failed', message: messageOf(error) }) }
      },
    },
    // ------------------------------------ skill configuration (declared per skill)
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.configSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary?.configSave === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持保存技能配置。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        const values = (Array.isArray(body?.values) ? body.values : [])
          .map(item => {
            if (item === null || typeof item !== 'object') return undefined
            const record = item as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id === '' || typeof record.value !== 'string') return undefined
            return { id, value: record.value }
          })
          .filter((item): item is { id: string; value: string } => item !== undefined)
          .slice(0, 64)
        try {
          writeJson(res, 200, await deps.skillLibrary.configSave({ name, values, ...parseSkillLanguage(body) }))
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'config-save-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: CANVAS_SKILL_API.configApply,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (deps.skillLibrary?.configApply === undefined) {
          writeJson(res, 200, { ok: false, code: 'library-unavailable', message: '本宿主不支持应用技能配置。' })
          return
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少技能名。' })
          return
        }
        try {
          writeJson(res, 200, await deps.skillLibrary.configApply({ name, ...parseSkillLanguage(body) }))
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'config-apply-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- templates list
    {
      kind: 'exact',
      path: TEMPLATES_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const sourceId = templateSourceOf(body)
        if (sourceId === undefined) {
          writeJson(res, 200, { ok: false, code: 'templates-source-unknown', message: `未知的模板库来源：${String(body?.source ?? '')}` })
          return
        }
        try {
          const result = await templates.list(sourceId)
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'templates-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------- templates refresh
    {
      kind: 'exact',
      path: TEMPLATES_API.refresh,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const sourceId = templateSourceOf(body)
        if (sourceId === undefined) {
          writeJson(res, 200, { ok: false, code: 'templates-source-unknown', message: `未知的模板库来源：${String(body?.source ?? '')}` })
          return
        }
        try {
          const result = await templates.refresh(sourceId)
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'templates-refresh-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------- templates random sample
    {
      kind: 'exact',
      path: TEMPLATES_API.sample,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const requested = Number(body?.count)
        const count = Number.isFinite(requested) ? requested : 9
        try {
          writeJson(res, 200, { ok: true, samples: await templates.sample(count) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'templates-sample-failed', message: messageOf(error) })
        }
      },
    },
    // -------------------------------------- templates image (prefix, proxied)
    {
      kind: 'prefix',
      path: TEMPLATES_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        // Source-scoped: /image/<sourceId>/<file> (file names collide across
        // sources, so the pool on disk is per source).
        const raw = imageFileFrom(req.url, TEMPLATES_API.image)
        const slash = raw?.indexOf('/') ?? -1
        const sourceId = slash > 0 ? raw!.slice(0, slash) : ''
        const file = slash > 0 ? raw!.slice(slash + 1) : ''
        if (sourceId === '' || !isTemplateSourceId(sourceId) || file === '') {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await templates.readImage(sourceId, file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          // Cached on disk by the host; reference images are immutable per name.
          'cache-control': 'private, max-age=86400',
        })
        res.end(found.data)
      },
    },
    // ------------------------------------------ template favorites: list
    {
      kind: 'exact',
      path: TEMPLATE_FAVORITES_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, favorites: await favorites.list() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'template-favorites-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------- template favorites: add
    {
      kind: 'exact',
      path: TEMPLATE_FAVORITES_API.add,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const sourceId = templateSourceOf(body)
        const rawCase = body?.case
        if (sourceId === undefined || rawCase === null || typeof rawCase !== 'object') {
          writeJson(res, 200, { ok: false, code: 'template-favorite-invalid', message: '收藏请求缺少有效的来源或模板数据' })
          return
        }
        const record = rawCase as Record<string, unknown>
        const id = typeof record.id === 'number' && Number.isFinite(record.id)
          ? String(record.id)
          : typeof record.id === 'string'
            ? record.id.trim()
            : ''
        const title = typeof record.title === 'string' ? record.title.trim() : ''
        const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
        if (id === '' || title === '' || prompt === '') {
          writeJson(res, 200, { ok: false, code: 'template-favorite-invalid', message: '收藏请求缺少有效的模板数据' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, favorites: await favorites.add(sourceId, rawCase as TemplateFavorite['case']) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'template-favorites-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------- template favorites: remove
    {
      kind: 'exact',
      path: TEMPLATE_FAVORITES_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const key = typeof body?.key === 'string' ? body.key : ''
        if (key === '') {
          writeJson(res, 200, { ok: false, code: 'template-favorite-invalid', message: '取消收藏请求缺少模板标识' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, favorites: await favorites.remove(key) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'template-favorites-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------- data folder: reveal in OS
    {
      kind: 'exact',
      path: DATA_FOLDER_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const dir = imageDataRoot()
        try {
          await fsMkdir(dir, { recursive: true })
        } catch { /* reveal still works when the directory already exists */ }
        if (body?.open === false) {
          // Wiring probe for tests: resolve the path without spawning a shell.
          writeJson(res, 200, { ok: true, path: dir })
          return
        }
        try {
          const command = process.platform === 'win32'
            ? 'explorer.exe'
            : process.platform === 'darwin'
              ? 'open'
              : 'xdg-open'
          const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
          child.unref()
          writeJson(res, 200, { ok: true, path: dir })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'data-folder-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ video family
    //
    // Video is asynchronous upstream (submit → poll → download), so it keeps
    // its own endpoints instead of the synchronous image generate route. The
    // finished clip is persisted host-side and served from `VIDEO_API.file`;
    // no response in this family ever carries video bytes.
    {
      kind: 'exact',
      path: VIDEO_API.generate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseVideoRequest(body, channelViewOf(), deps)
        if (parsed === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        const runtime = deps.runtime
        if (runtime === undefined) {
          writeJson(res, 200, { ok: false, code: 'video-unavailable', message: '当前宿主未挂载生成运行时' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...await runtime.runVideo(parsed) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: videoCodeOf(error), message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact', path: VIDEO_API.submit,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseVideoRequest(body, channelViewOf(), deps)
        if (parsed === undefined) { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' }); return }
        const runtime = deps.runtime
        if (runtime === undefined) { writeJson(res, 200, { ok: false, code: 'video-unavailable', message: '当前宿主未挂载生成运行时' }); return }
        // VideoTaskSummary omits `result`; submit returns the queued summary.
        writeJson(res, 200, { ok: true, task: runtime.videoQueue.submit(parsed) })
      },
    },
    {
      /**
       * Preview the director plan without rendering.
       *
       * Submit already plans when `plan: true`, but a render costs minutes: the
       * user must be able to inspect the shot list and the parameters the
       * planner chose before spending them. This route runs exactly the same
       * planning code and returns its output, and nothing else.
       */
      kind: 'exact', path: VIDEO_API.plan,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseVideoRequest(body, channelViewOf(), deps)
        if (parsed === undefined) {
          writeJson(res, 200, { ok: false, code: 'video-prompt-empty', message: 'prompt is required' })
          return
        }
        const runtime = deps.runtime
        if (runtime === undefined) {
          writeJson(res, 200, { ok: false, code: 'video-unavailable', message: '当前宿主未挂载生成运行时' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, plan: await runtime.planVideoRequest(parsed) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: videoCodeOf(error), message: messageOf(error) })
        }
      },
    },
    {
      /**
       * Preview a code render: pixel size, frame count, and whether this
       * machine can encode a video.
       *
       * Read-only by design — no model call, no frame rendered. It exists so
       * the composer can tell the user "1080x1920, 150 frames" and can warn
       * about a missing ffmpeg BEFORE a chat model is paid to write code.
       */
      kind: 'exact', path: CODE_RENDER_API.probe,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const kind = body?.kind === 'image' ? 'image' : 'video'
        const resolution = body?.resolution === '480P' || body?.resolution === '1080P' ? body.resolution : '720P'
        const aspectRatio = typeof body?.aspectRatio === 'string' && body.aspectRatio.trim() !== '' ? body.aspectRatio.trim() : '16:9'
        const seconds = typeof body?.seconds === 'number' && Number.isFinite(body.seconds) ? body.seconds : 5
        const fps = typeof body?.fps === 'number' && Number.isFinite(body.fps) ? body.fps : undefined
        try {
          writeJson(res, 200, {
            ok: true,
            probe: probeCodeRender({
              kind,
              resolution,
              aspectRatio,
              ...kind === 'video' ? { seconds, ...fps === undefined ? {} : { fps } } : {},
            }),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: videoCodeOf(error), message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact', path: VIDEO_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const runtime = deps.runtime
        if (runtime === undefined) { writeJson(res, 200, { ok: true, tasks: [] }); return }
        writeJson(res, 200, { ok: true, tasks: runtime.videoQueue.summaries() })
      },
    },
    {
      kind: 'exact', path: VIDEO_API.get,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? deps.runtime?.videoQueue.get(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact', path: VIDEO_API.cancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? deps.runtime?.videoQueue.cancel(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact', path: VIDEO_API.retry,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? deps.runtime?.videoQueue.retry(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    // ------------------------------------------------ video history (metadata)
    {
      kind: 'exact',
      path: VIDEO_API.historyList,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const entries = await video.list()
          // Posters for entries saved before posters existed. Deliberately not
          // awaited: this shells out to ffmpeg (one clip at a time, ~130ms
          // each), and the user asked for their history, not for a rebuild.
          // The first response therefore shows the rows as they are, and the
          // thumbnails land a moment later — the drain keeps running after the
          // response, so the whole backlog is covered by this one request
          // rather than by a second request that never comes.
          //
          // The `.catch` is not optional: an unawaited rejection lands on the
          // process-level `unhandledRejection`, and the host's fail-loud
          // handler turns that into `proc.exit(1)` — one unwritable index
          // would take the whole host down over a decoration.
          void drainVideoPosters().catch(() => { /* decoration only: a failed backfill must never reach the host's fail-loud handler */ })
          writeJson(res, 200, { ok: true, entries })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'video-history-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: VIDEO_API.historyRemove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (typeof body?.id !== 'string' || body.id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await video.remove(body.id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'video-history-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: VIDEO_API.historyClear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await video.clear() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'video-history-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- video file (prefix)
    //
    // Serves one stored clip. Range responses are mandatory here rather than a
    // nicety: without 206 the <video> element cannot seek, and a long clip
    // would have to be downloaded twice to scrub.
    {
      kind: 'prefix',
      path: VIDEO_API.file,
      handler: (req, res) => serveClip(req, res, VIDEO_API.file, video.readFile),
    },
    // ------------------------------------------------- storage: probe upload
    {
      kind: 'exact',
      path: STORAGE_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const storage = deps.resolveStorage?.()
        if (storage === undefined) {
          writeJson(res, 200, { ok: false, code: 'storage-unavailable', message: '存储配置不可用' })
          return
        }
        try {
          const result = await testStorage(storage)
          writeJson(res, 200, { ok: true, ms: result.ms, key: result.key })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'storage-test-failed', message: messageOf(error) })
        }
      },
    },
  ]
}

/**
 * Browser-side API client for the /api/dsh-imagegen route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */

import { MODEL_API, CANVAS_API, CANVAS_SKILL_API, CODE_RENDER_API, CONVERSATION_IMAGE_API, DATA_FOLDER_API, DIAGNOSTICS_API, GALLERY_API, GENERATE_API, HISTORY_API, LISTING_COPY_API, PROMPT_ENHANCE_API, STORAGE_API, TASK_API, TEMPLATE_FAVORITES_API, TEMPLATES_API, UPDATE_API, VIDEO_API, type CanvasAssetRef, type CanvasDocument, type CanvasFilePreview, type CanvasLayerPlan, type CanvasSkillCatalog, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type CanvasSkillRunRequest, type CanvasSkillTask, type CanvasSummary, type CodeRenderResponse, type CodeTarget, type DiagnosticEntry, type GenerateRequest, type GenerateResult, type ListingCopyRequest, type ListingCopyResult, type GenerationTask, type GenerationTaskSummary, type HistoryEntry, type HistoryEntryInput, type PptRunRequest, type PptRuntimeStatus, type TemplateCase, type TemplateFavorite, type TemplateListResult, type TemplateRefreshResult, type TemplateSample, type UpdateInfo, type VideoDirectorPlan, type VideoGenerateRequest, type VideoGenerateResult, type VideoHistoryEntry, type VideoTask, type VideoTaskSummary } from '../protocol.ts'
import { activeImageGenLanguage } from './helpers.ts'

/** Error carrying the route's JSON error message. */
export class ImageGenApiError extends Error {
  /** Stable wire code from the host. */
  readonly code: string
  /**
   * The rest of the route's envelope. Kept because some failures are actionable
   * only with a field the message alone drops — `update-manual-required` carries
   * the archive URL the user has to install by hand, and a message string is not
   * somewhere to put it without making the copy unreadable.
   */
  readonly details: Record<string, unknown>

  constructor(message: string, code = 'generate-failed', details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ImageGenApiError'
    this.code = code
    this.details = details
  }
}

/** Parse the { ok, ... } envelope or throw an ImageGenApiError. */
async function readEnvelope<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ImageGenApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (body === null || typeof body !== 'object') {
    throw new ImageGenApiError(`HTTP ${response.status}: malformed response`)
  }
  const record = body as { ok?: unknown; message?: unknown; code?: unknown }
  if (record.ok !== true) {
    const { ok: _ok, message: _message, code: _code, ...details } = body as Record<string, unknown>
    throw new ImageGenApiError(
      typeof record.message === 'string' ? record.message : `HTTP ${response.status}`,
      typeof record.code === 'string' ? record.code : 'generate-failed',
      details,
    )
  }
  return body as T
}

/** The browser half's data entry point. */
export class ImageGenApi {
  /** Submit a standalone image-to-PPT conversion. */
  async pptRun(request: Omit<PptRunRequest, 'language'>): Promise<CanvasSkillTask> {
    const response = await fetch(CANVAS_SKILL_API.pptRun, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; task: CanvasSkillTask }>(response)).task
  }

  /** Conversion history, including runs from before a reload. */
  async pptTasks(): Promise<CanvasSkillTask[]> {
    return (await readEnvelope<{ ok: true; tasks: CanvasSkillTask[] }>(
      await fetch(CANVAS_SKILL_API.pptTasks, { method: 'POST' }),
    )).tasks
  }

  /** Check (or install) the isolated editppt runtime. */
  async pptRuntime(install = false): Promise<PptRuntimeStatus> {
    const response = await fetch(CANVAS_SKILL_API.pptRuntime, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ install }),
    })
    return (await readEnvelope<{ ok: true; runtime: PptRuntimeStatus }>(response)).runtime
  }
  /**
   * Ask the host to check the latest stable GitHub Release.
   *
   * Every failure mode leaves as the same {@link ImageGenApiError} shape: the
   * route answers `update-check-failed` when GitHub is unreachable, and fetch
   * itself rejects with a bare `TypeError: Failed to fetch` when the host is
   * down. Callers used to `.catch(() => {})` — one shape of failure and one
   * silent outcome, so a permanently offline check looked identical to "no
   * update". `code` is what the settings card maps to a readable sentence.
   */
  async updateCheck(): Promise<UpdateInfo> {
    let response: Response
    try {
      response = await fetch(UPDATE_API.check, { method: 'POST' })
    } catch (error) {
      throw new ImageGenApiError(
        error instanceof Error ? error.message : String(error),
        'update-check-unreachable',
      )
    }
    const body = await readEnvelope<{ ok: true; update: UpdateInfo }>(response)
    return body.update
  }

  /** Ask the host to install a previously discovered Release. */
  async updateApply(version: string): Promise<{ updatedVersion: string; restartRequired: boolean }> {
    const response = await fetch(UPDATE_API.apply, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    })
    const body = await readEnvelope<{ ok: true; updatedVersion: string; restartRequired: boolean }>(response)
    return { updatedVersion: body.updatedVersion, restartRequired: body.restartRequired }
  }

  /** Forward one generate request to the host proxy. */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await fetch(GENERATE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await readEnvelope<{ ok: true; images: GenerateResult['images']; history?: HistoryEntry[]; historyError?: string; renderer?: 'model' | 'code'; renderSource?: string; degraded?: boolean; degradedReason?: string }>(response)
    return {
      images: body.images,
      ...body.history === undefined ? {} : { history: body.history },
      ...body.historyError === undefined ? {} : { historyError: body.historyError },
      ...body.renderer === undefined ? {} : { renderer: body.renderer },
      ...body.renderSource === undefined ? {} : { renderSource: body.renderSource },
      ...body.degraded === undefined ? {} : { degraded: body.degraded },
      ...body.degradedReason === undefined ? {} : { degradedReason: body.degradedReason },
    }
  }

  /**
   * Submit one video generation and wait for the finished clip.
   *
   * Unlike `generate`, the response carries no bytes: the host persisted the
   * clip and answers with servable URLs. Video rendering takes minutes, so the
   * panel normally uses `videoTaskSubmit` + polling instead of blocking here.
   */
  async videoGenerate(request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    const response = await fetch(VIDEO_API.generate, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await readEnvelope<{ ok: true; videos: VideoGenerateResult['videos']; history?: VideoHistoryEntry[]; historyError?: string }>(response)
    return {
      videos: body.videos,
      ...body.history === undefined ? {} : { history: body.history },
      ...body.historyError === undefined ? {} : { historyError: body.historyError },
    }
  }

  /**
   * Preview a code render: pixel size, frame count, and whether this machine
   * has an ffmpeg to encode with.
   *
   * Read-only and free: no model call, no frame drawn. The composer uses it to
   * warn about a missing dependency BEFORE a chat model is asked to write code
   * that then cannot be encoded.
   */
  async codeProbe(input: { kind: CodeTarget; resolution?: string; aspectRatio?: string; seconds?: number; fps?: number }): Promise<CodeRenderResponse> {
    const response = await fetch(CODE_RENDER_API.probe, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    return (await readEnvelope<{ ok: true; probe: CodeRenderResponse }>(response)).probe
  }

  async videoTaskSubmit(request: VideoGenerateRequest): Promise<VideoTask> {
    const response = await fetch(VIDEO_API.submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    return (await readEnvelope<{ ok: true; task: VideoTask }>(response)).task
  }

  async videoTaskList(): Promise<VideoTaskSummary[]> {
    const response = await fetch(VIDEO_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; tasks: VideoTaskSummary[] }>(response)).tasks
  }

  async videoTaskGet(id: string): Promise<VideoTask> {
    const response = await fetch(VIDEO_API.get, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: VideoTask }>(response)).task
  }

  async videoTaskCancel(id: string): Promise<VideoTask> {
    const response = await fetch(VIDEO_API.cancel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: VideoTask }>(response)).task
  }

  async videoTaskRetry(id: string): Promise<VideoTask> {
    const response = await fetch(VIDEO_API.retry, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: VideoTask }>(response)).task
  }

  /**
   * Favorite one finished clip into the gallery.
   *
   * Names the video-history entry, never the bytes: the host resolves and
   * copies the file itself, so this stays a small JSON call regardless of clip
   * size.
   */
  async galleryAppendVideo(input: { entryId: string; tags?: string[] }): Promise<HistoryEntry[]> {
    const response = await fetch(GALLERY_API.video, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; added: boolean }>(response)
    return body.entries
  }

  async videoHistoryList(): Promise<VideoHistoryEntry[]> {
    const response = await fetch(VIDEO_API.historyList, { method: 'POST' })
    return (await readEnvelope<{ ok: true; entries: VideoHistoryEntry[] }>(response)).entries
  }

  async videoHistoryRemove(id: string): Promise<VideoHistoryEntry[]> {
    const response = await fetch(VIDEO_API.historyRemove, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; entries: VideoHistoryEntry[] }>(response)).entries
  }

  async videoHistoryClear(): Promise<VideoHistoryEntry[]> {
    const response = await fetch(VIDEO_API.historyClear, { method: 'POST' })
    return (await readEnvelope<{ ok: true; entries: VideoHistoryEntry[] }>(response)).entries
  }

  /**
   * Preview the director plan for a request without rendering it.
   *
   * Runs the same planning code the submit path runs, so what the user sees
   * here is exactly what a submit with `plan: true` will send.
   */
  async videoPlan(request: VideoGenerateRequest): Promise<VideoDirectorPlan> {
    const response = await fetch(VIDEO_API.plan, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return (await readEnvelope<{ ok: true; plan: VideoDirectorPlan }>(response)).plan
  }

  /** Ask the configured chat model to expand a concise image prompt. */
  async enhancePrompt(prompt: string): Promise<string> {
    const response = await fetch(PROMPT_ENHANCE_API.enhance, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const body = await readEnvelope<{ ok: true; prompt: string }>(response)
    return body.prompt
  }

  /** Polish one existing generation prompt through the configured chat model. */
  async polishPrompt(prompt: string): Promise<string> {
    const response = await fetch(PROMPT_ENHANCE_API.enhance, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'polish' }),
    })
    const body = await readEnvelope<{ ok: true; prompt: string }>(response)
    return body.prompt
  }

  /** Generate marketplace listing copy from the product draft (task-20). */
  async listingCopy(request: ListingCopyRequest): Promise<ListingCopyResult> {
    const response = await fetch(LISTING_COPY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return (await readEnvelope<ListingCopyResult>(response))
  }

  /** Stage a generated image as a durable reference for `/edit_image`. */
  async attachConversationImage(sessionId: string, dataUrl: string, name: string): Promise<void> {
    const response = await fetch(CONVERSATION_IMAGE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, dataUrl, name }),
    })
    await readEnvelope<{ ok: true }>(response)
  }

  async taskSubmit(request: GenerateRequest): Promise<GenerationTask> {
    const response = await fetch(TASK_API.submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  async taskList(): Promise<GenerationTaskSummary[]> {
    const response = await fetch(TASK_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; tasks: GenerationTaskSummary[] }>(response)).tasks
  }

  /** Fetch one task with its reference image and completed result payload. */
  async taskGet(id: string): Promise<GenerationTask> {
    const response = await fetch(TASK_API.get, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  async taskCancel(id: string): Promise<GenerationTask> {
    const response = await fetch(TASK_API.cancel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  async taskRetry(id: string): Promise<GenerationTask> {
    const response = await fetch(TASK_API.retry, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  /**
   * The retained record of upstream attempts (#38). Read after a failure to
   * see which address was called, what came back, and how long it took.
   */
  async diagnosticsList(): Promise<DiagnosticEntry[]> {
    const response = await fetch(DIAGNOSTICS_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; entries: DiagnosticEntry[] }>(response)).entries
  }

  /** Drop the retained attempts. */
  async diagnosticsClear(): Promise<void> {
    const response = await fetch(DIAGNOSTICS_API.clear, { method: 'POST' })
    await readEnvelope<{ ok: true }>(response)
  }

  /** List the host-persisted history (newest first). */
  async historyList(): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.list, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Remove one history entry by id. */
  async historyRemove(id: string): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Clear the entire history. */
  async historyClear(): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.clear, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  async modelList(): Promise<Array<{ id: string; name: string; createdAt: number; file: string; mime: string }>> { return (await readEnvelope<{ ok: true; models: Array<{ id: string; name: string; createdAt: number; file: string; mime: string }> }>(await fetch(MODEL_API.list, { method: 'POST' }))).models }
  /** Read one saved model back as a data URL, for an edit request's reference. */
  async modelImage(id: string): Promise<string> {
    const response = await fetch(`${MODEL_API.image}/${encodeURIComponent(id)}`)
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  async modelSave(input: { name: string; data: string; mime: string }): Promise<{ id: string; name: string; createdAt: number; file: string; mime: string }> { return (await readEnvelope<{ ok: true; model: { id: string; name: string; createdAt: number; file: string; mime: string } }>(await fetch(MODEL_API.save, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))).model }

  /** List the host-persisted gallery (newest first) plus its trash. */
  async galleryList(): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.list, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  /** Append one image to the gallery. The host assigns the id and skips the
   *  append when a content-identical image is already in the gallery. */
  async galleryAppend(entry: HistoryEntryInput): Promise<{ entries: HistoryEntry[]; added: boolean }> {
    const response = await fetch(GALLERY_API.append, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; added: boolean }>(response)
    return { entries: body.entries, added: body.added }
  }

  /** Move one gallery entry to the trash (soft delete: its files stay). */
  async galleryRemove(id: string): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  /** Bring one trashed entry back into the gallery. */
  async galleryRestore(id: string): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.restore, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  /** Empty the trash: permanently deletes the files of every trashed entry. */
  async galleryPurge(): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.purge, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  /** Move every gallery entry to the trash (recoverable for the retention window). */
  async galleryClear(): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.clear, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  async gallerySetTags(id: string, tags: string[]): Promise<{ entries: HistoryEntry[]; trash: HistoryEntry[] }> {
    const response = await fetch(GALLERY_API.tags, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, tags }) })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; trash?: HistoryEntry[] }>(response)
    return { entries: body.entries, trash: body.trash ?? [] }
  }

  async canvasList(): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasCreate(title?: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.create, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRead(id: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.read, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasSave(document: CanvasDocument, expectedRevision: number): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.save, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document, expectedRevision }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRemove(id: string): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.remove, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasFavorite(id: string, favorite: boolean): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.favorite, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, favorite }) })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasUpload(dataUrl: string, width: number, height: number, meta: { origin?: string; originId?: string; entryId?: string; imageIndex?: number } = {}): Promise<CanvasAssetRef> {
    const response = await fetch(CANVAS_API.assetUpload, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, width, height, ...meta }) })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  async canvasImport(source: 'history' | 'gallery', entryId: string, imageIndex: number, width: number, height: number): Promise<CanvasAssetRef> {
    const response = await fetch(CANVAS_API.assetImport, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, entryId, imageIndex, width, height }) })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  /** Ask the host's chat model to decompose one image into editable layers. */
  async canvasLayers(image: string): Promise<CanvasLayerPlan> {
    const response = await fetch(CANVAS_API.layers, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) })
    return (await readEnvelope<{ ok: true; plan: CanvasLayerPlan }>(response)).plan
  }

  /**
   * Upload one arbitrary file for a canvas file node. The File object travels
   * as the raw request body (no base64 inflation) with its name in the query
   * and its type in the content-type header.
   */
  async canvasFileUpload(file: File): Promise<CanvasAssetRef> {
    const response = await fetch(`${CANVAS_API.fileUpload}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
    })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  /**
   * Ask the host for one canvas file node's readable content. Media types come
   * back as an inline URL; text, spreadsheets, office documents and archives
   * come back decoded and bounded.
   */
  async canvasFilePreview(asset: { assetId: string; name?: string; mime?: string }): Promise<CanvasFilePreview> {
    const response = await fetch(CANVAS_API.filePreview, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    })
    return (await readEnvelope<{ ok: true; preview: CanvasFilePreview }>(response)).preview
  }

  /** Read the skill catalog offered to canvas nodes. */
  async canvasSkillsList(): Promise<CanvasSkillCatalog> {
    const response = await fetch(CANVAS_SKILL_API.list, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: activeImageGenLanguage() }),
    })
    const body = await readEnvelope<{ ok: true } & CanvasSkillCatalog>(response)
    return {
      skills: body.skills,
      agentAvailable: body.agentAvailable,
      registryAvailable: body.registryAvailable,
      installed: body.installed ?? [],
      ...body.reason === undefined ? {} : { reason: body.reason },
    }
  }

  /** Inspect the local skill library (`~/.dsh/skills`). */
  async canvasSkillLibrary(): Promise<CanvasSkillLibrary> {
    const response = await fetch(CANVAS_SKILL_API.library, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; library: CanvasSkillLibrary }>(response)).library
  }

  /** Install skills from URLs and/or an archive asset uploaded to the canvas. */
  async canvasSkillInstall(request: CanvasSkillInstallRequest): Promise<CanvasSkillInstallResult> {
    const response = await fetch(CANVAS_SKILL_API.install, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillInstallResult>(response)
  }

  /** Remove one installed skill. */
  async canvasSkillRemove(name: string): Promise<CanvasSkillRemoveResult> {
    const response = await fetch(CANVAS_SKILL_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillRemoveResult>(response)
  }

  /** Save the values one skill's own declaration asked for. */
  async canvasSkillConfigSave(request: CanvasSkillConfigSaveRequest): Promise<CanvasSkillConfigSaveResult> {
    const response = await fetch(CANVAS_SKILL_API.configSave, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillConfigSaveResult>(response)
  }

  /** Run a skill declaration's `apply` steps (its CLI or a config file). */
  async canvasSkillConfigApply(request: CanvasSkillConfigApplyRequest): Promise<CanvasSkillConfigApplyResult> {
    const response = await fetch(CANVAS_SKILL_API.configApply, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return await readEnvelope<CanvasSkillConfigApplyResult>(response)
  }

  /** Queue one skill run; the task is polled through {@link canvasSkillTask}. */
  async canvasSkillRun(request: CanvasSkillRunRequest): Promise<CanvasSkillTask> {
    const response = await fetch(CANVAS_SKILL_API.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; task: CanvasSkillTask }>(response)).task
  }

  /** One skill-run snapshot. */
  async canvasSkillTask(taskId: string): Promise<CanvasSkillTask> {
    const response = await fetch(CANVAS_SKILL_API.task, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; task: CanvasSkillTask }>(response)).task
  }

  /** Unfinished skill runs of one canvas (rebuilds run cards after a reload). */
  async canvasSkillTasks(canvasId: string): Promise<CanvasSkillTask[]> {
    const response = await fetch(CANVAS_SKILL_API.task, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; tasks: CanvasSkillTask[] }>(response)).tasks
  }

  /** Ask the host to cancel a queued or running skill run. */
  async canvasSkillCancel(taskId: string): Promise<boolean> {
    const response = await fetch(CANVAS_SKILL_API.cancel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, language: activeImageGenLanguage() }),
    })
    return (await readEnvelope<{ ok: true; cancelled: boolean }>(response)).cancelled
  }

  /** Fetch one template source's list (bundled snapshot or refreshed copy). */
  async templatesList(sourceId: string): Promise<TemplateListResult> {
    const response = await fetch(TEMPLATES_API.list, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceId }) })
    const body = await readEnvelope<TemplateListResult & { ok: true }>(response)
    return {
      sourceId: body.sourceId,
      cases: body.cases,
      total: body.total,
      origin: body.origin,
      repository: body.repository,
      fetchedAt: body.fetchedAt,
    }
  }

  /** Re-download one template source's list from its upstream mirror (host-side). */
  async templatesRefresh(sourceId: string): Promise<TemplateRefreshResult> {
    const response = await fetch(TEMPLATES_API.refresh, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceId }) })
    const body = await readEnvelope<TemplateRefreshResult & { ok: true }>(response)
    return { sourceId: body.sourceId, total: body.total, fetchedAt: body.fetchedAt }
  }

  /** Draw random cases across every source (studio inspiration wall). */
  async templatesSample(count: number): Promise<TemplateSample[]> {
    const response = await fetch(TEMPLATES_API.sample, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }) })
    return (await readEnvelope<{ ok: true; samples: TemplateSample[] }>(response)).samples
  }

  /** List the host-persisted template favorites. */
  async favoritesList(): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }

  /** Reveal the host data directory (saved images) in the OS file manager. */
  async openDataFolder(): Promise<{ ok: boolean; path?: string; message?: string }> {
    const response = await fetch(DATA_FOLDER_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    return await readEnvelope<{ ok: true; path: string }>(response)
  }

  /** Probe the configured S3-compatible object storage with a small upload. */
  async storageTest(): Promise<{ ok: boolean; ms?: number; key?: string; message?: string }> {
    const response = await fetch(STORAGE_API.test, { method: 'POST' })
    return await readEnvelope<{ ok: true; ms: number; key: string }>(response)
  }

  /** Star one template (the host keeps a full case snapshot). */
  async favoritesAdd(sourceId: string, item: TemplateCase): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.add, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceId, case: item }),
    })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }

  /** Unstar one template by its favorites key. */
  async favoritesRemove(key: string): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }
}

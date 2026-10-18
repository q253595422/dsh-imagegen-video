/**
 * Video generation engine: the async submit → poll → download contract for
 * each supported video family.
 *
 * Video is fundamentally different from the synchronous image engine next to
 * this file:
 *  - the upstream call returns a *task id*, not pixels, so the engine polls
 *    until the provider reports a terminal state;
 *  - the finished asset is a clip served from a URL, so the engine downloads
 *    the bytes instead of returning base64 (a 5s clip base64-inflated would
 *    be far too large to keep in a JSON response).
 *
 * Family request/response shapes below are recorded from measured upstream
 * behavior, not from provider documentation — the docs are wrong in three
 * places that are noted inline at the code that compensates for them.
 *
 * Framework-free apart from the platform fetch/AbortSignal, so the host route
 * layer can drive it directly.
 */

import type { UpstreamConfig } from './engine.ts'
import {
  clampVideoSeconds,
  describeVideoModel,
  isComemoeVideoModel,
  normalizeVideoResolution,
  type VideoCatalogEntry,
} from './video-model-catalog.ts'
import {
  bodyByteLength,
  excerptOf,
  networkErrorFields,
  readResponseText,
  recordDiagnostic,
  type DiagnosticPhase,
} from './diagnostics-store.ts'
import type { VideoGenerateRequest, VideoMode } from './protocol.ts'

/** A video generation failure with a user-presentable message. */
export class VideoGenError extends Error {
  /** Stable wire code. */
  readonly code: string
  /**
   * Whether retrying the exact same request could plausibly succeed. Only the
   * poll loop reads this: a transient status (5xx / rate limit) is retried
   * against the same deadline, everything else is surfaced as-is.
   */
  readonly retryable: boolean
  /**
   * The HTTP status, when the failure came with one.
   *
   * Carried on the error because the poll loop only ever sees the error, never
   * the response: a retryable status that does NOT recover still has to be
   * recorded with its wire code, and "503 five times running" and "429 five
   * times running" are different conversations (#38, video parity).
   */
  readonly status?: number

  constructor(message: string, code = 'video-failed', retryable = false, status?: number) {
    super(message)
    this.name = 'VideoGenError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

/** Upstream credentials for one video request (mirrors the image upstream). */
export type VideoUpstreamConfig = UpstreamConfig

/** One downloaded clip, ready for the store to persist. */
export interface VideoBytes {
  bytes: Buffer
  mime: string
  /**
   * The provider's own result URL. Retained so a local persistence failure
   * still leaves the user a playable link for a render they already paid for.
   */
  sourceUrl: string
  duration?: number
  poster?: string
  revisedPrompt?: string
}

/** Successful engine outcome. */
export interface VideoEngineResult {
  videos: VideoBytes[]
}

/** Total budget for one submit call (submitting is fast; rendering is not). */
const SUBMIT_TIMEOUT_MS = 120_000

/** Budget for downloading one finished clip. */
const DOWNLOAD_TIMEOUT_MS = 300_000

/** Cap on one downloaded clip, in bytes (safety valve against a bad URL). */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024

/**
 * Status codes worth one more poll. Rendering takes minutes, and the status
 * endpoint is a third party: a 5xx or a rate limit there says "ask again",
 * not "this render failed". Everything else — notably 401/403/404 — is a
 * permanent answer and must reach the user unchanged.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Poll budgets per family. Rendering a short clip is slow: Agnes took several
 * minutes in testing and comemoe took ~9 minutes for a 5s clip, so the poll
 * deadline is generous and the interval is family-tuned rather than shared
 * with the image path.
 */
const POLL_POLICY: Record<string, { intervalMs: number; deadlineMs: number }> = {
  agnes: { intervalMs: 8_000, deadlineMs: 20 * 60_000 },
  // comemoe measured at ~522s for a 5s clip: allow a much longer deadline and
  // a slower poll so a long render does not hammer the status endpoint.
  comemoe: { intervalMs: 6_000, deadlineMs: 40 * 60_000 },
  'openai-video': { intervalMs: 5_000, deadlineMs: 20 * 60_000 },
  unknown: { intervalMs: 5_000, deadlineMs: 20 * 60_000 },
}

/** Whether a model id is a wired-up video family (the route/tool gate). */
export function isVideoModel(model: string): boolean {
  const family = describeVideoModel(model).family
  return family !== 'unknown'
}

/** Reference frames a request carries, decoded from data URLs. */
interface DecodedReferences {
  /** Single primary reference (image / first frame). */
  primary?: { mime: string; base64: string }
  /** All reference frames in order. */
  all: Array<{ mime: string; base64: string }>
}

/** Reject a data URL we cannot send upstream. */
function requireDataUrl(value: string, what: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(value.trim())
  if (match === null || match[2] === undefined || match[2] === '') {
    throw new VideoGenError(`${what}不是有效的 base64 图片数据`, 'video-bad-reference')
  }
  return { mime: match[1] ?? 'image/png', base64: match[2] }
}

/** Decode the reference frames this request's mode actually uses. */
function referencesOf(request: VideoGenerateRequest): DecodedReferences {
  const all: Array<{ mime: string; base64: string }> = []
  const push = (value: string | undefined, what: string): void => {
    if (value === undefined || value.trim() === '') return
    all.push(requireDataUrl(value, what))
  }
  switch (request.mode) {
    case 'image':
      push(request.image, '参考图片')
      break
    case 'keyframe':
      push(request.firstFrame, '首帧图片')
      push(request.lastFrame, '尾帧图片')
      break
    case 'reference':
      push(request.image, '参考图片')
      for (const extra of request.images ?? []) push(extra, '参考图片')
      break
    default:
      break
  }
  return { ...all.length > 0 ? { primary: all[0]! } : {}, all }
}

/** A data URL for one decoded reference (the wire form providers expect). */
function dataUrlOf(reference: { mime: string; base64: string }): string {
  return `data:${reference.mime};base64,${reference.base64}`
}

/** Map the panel's video mode onto a family's own mode vocabulary. */
function familyMode(family: string, mode: VideoMode): string {
  if (family === 'agnes') {
    // Agnes speaks 'text' | 'keyframe' | 'reference'; a single image-to-video
    // frame is sent as a one-element reference list.
    if (mode === 'text') return 'text'
    if (mode === 'keyframe') return 'keyframe'
    return 'reference'
  }
  return mode === 'text' ? 'text' : 'image'
}

/** Resolve the request URL: base URL + path, or the exact configured URL. */
function endpointUrl(upstream: VideoUpstreamConfig, baseUrl: string, path: string): string {
  return upstream.apiUrlFull === true && path === '/videos' ? baseUrl : `${baseUrl}${path}`
}

/** Whether a URL lives on the same origin as the configured API base. */
function isSameOriginAsApi(value: string, apiUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(apiUrl).origin
  } catch {
    return false
  }
}

/** One abort signal with a budget, disposed by the caller. */
function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = (): void => { controller.abort(source?.reason) }
  if (source?.aborted === true) abortFromSource()
  else source?.addEventListener('abort', abortFromSource, { once: true })
  const timeout = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      source?.removeEventListener('abort', abortFromSource)
    },
  }
}

/** Sleep that rejects immediately when the caller aborts. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(new VideoGenError('视频生成已取消', 'video-cancelled')); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new VideoGenError('视频生成已取消', 'video-cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Pull a human error string out of any provider error shape. */
function errorTextOf(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message !== '') return message
  }
  for (const key of ['message', 'msg', 'detail']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

/**
 * Read a JSON body AND keep its raw text for the diagnostics record.
 *
 * The body can only be consumed once, so the two consumers share one read:
 * parsing needs the RAW text, and the record needs a redacted excerpt of the
 * same text. Reading it twice would silently return an empty excerpt for every
 * non-2xx response, which is exactly the case the record exists for.
 */
async function readJsonWithText(response: Response): Promise<{ payload: Record<string, unknown>; text: string }> {
  const text = await readResponseText(response)
  if (text.trim() === '') return { payload: {}, text }
  try {
    const parsed: unknown = JSON.parse(text)
    return {
      payload: parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
      text,
    }
  } catch {
    return { payload: { message: text.slice(0, 300) }, text }
  }
}

/** The URL actually handed to fetch, with any query string dropped (#38). */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}

/**
 * One leg of the video pipeline, ready to be recorded.
 *
 * Video is submit → poll → download rather than a single call, so the phase is
 * what tells the reader WHICH leg failed: a render that never started looks
 * nothing like a status endpoint that stopped answering, and the panel has to
 * say which one happened (#38, video parity).
 */
interface VideoAttempt {
  phase: DiagnosticPhase
  channel: string
  model: string
  mode: string
  url: string
  method: string
  hadAuth: boolean
  apiUrlFull?: boolean
  requestBytes?: number
  startedAt: number
}

/** Build the attempt context for one video request. */
function videoAttempt(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  model: string,
  phase: DiagnosticPhase,
  url: string,
  method: string,
  body?: BodyInit,
): VideoAttempt {
  return {
    phase,
    channel: upstream.channelName?.trim() || '默认渠道',
    model,
    mode: request.mode,
    url: displayUrl(url),
    method,
    // Never the key itself, only whether one was sent -- the record is meant to
    // be pasted into a public issue.
    hadAuth: upstream.apiKey.trim() !== '',
    ...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
    ...body === undefined ? {} : { requestBytes: bodyByteLength(body) },
    startedAt: Date.now(),
  }
}

/**
 * Record one failed video attempt against the shared diagnostics buffer.
 *
 * The same buffer the image chain writes to: the panel is one surface, and a
 * user whose image call works and whose video call does not must be able to see
 * both in one place.
 */
function recordVideoFailure(attempt: VideoAttempt, error: VideoGenError, options: {
  status?: number
  bodyExcerpt?: string
  requestExcerpt?: string
  responseBytes?: number
} = {}): void {
  const network = networkErrorFields(error)
  recordDiagnostic({
    phase: attempt.phase,
    channel: attempt.channel,
    model: attempt.model,
    mode: attempt.mode,
    url: attempt.url,
    method: attempt.method,
    // The error carries its own status when the caller did not pass one, which
    // is how a retryable status recorded by the poll loop keeps its wire code.
    status: options.status ?? error.status,
    errorCode: network.errorCode,
    failureCode: error.code,
    message: error.message,
    bodyExcerpt: options.bodyExcerpt,
    requestExcerpt: options.requestExcerpt,
    requestBytes: attempt.requestBytes,
    responseBytes: options.responseBytes,
    durationMs: Date.now() - attempt.startedAt,
    hadAuth: attempt.hadAuth,
    apiUrlFull: attempt.apiUrlFull,
  })
}

/**
 * Record the poll loop giving up on a status endpoint that kept failing.
 *
 * Only the exhausted budget is recorded: one blip is not worth a row (writing
 * every one would bury the failure that matters), but an endpoint that failed
 * the whole budget is exactly the "it just sat there" report this buffer
 * exists to answer. It is recorded as `video-status-failed` -- the transient
 * reading is over by then -- while still naming the task and the retries.
 */
function recordPollExhausted(statusAttempt: VideoAttempt, error: unknown, taskId: string, family: string, retries: number): void {
  const network = networkErrorFields(error)
  recordVideoFailure(
    statusAttempt,
    new VideoGenError(
      error instanceof VideoGenError
        ? error.message
        : `视频状态查询连续失败：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${statusAttempt.url}`,
      'video-status-failed',
      false,
      error instanceof VideoGenError ? error.status : undefined,
    ),
    { requestExcerpt: excerptOf({ taskId, family, retries }) },
  )
}

/**
 * The submit body worth keeping. Reference frames are data URLs measured in
 * megabytes, so they are replaced by their count: the panel shows what was
 * asked for without shipping the payload into the buffer.
 */
function videoRequestExcerpt(request: VideoGenerateRequest, body: Record<string, unknown>): string {
  const shapes = ['image_url', 'image', 'images', 'first_frame', 'last_frame']
  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (shapes.includes(key)) {
      shape[`${key}<omitted>`] = Array.isArray(value) ? value.length : 1
    } else {
      shape[key] = value
    }
  }
  return excerptOf(shape) ?? ''
}

/** POST one submit request and return the parsed JSON body. */
async function postJson(attempt: VideoAttempt, request: VideoGenerateRequest, url: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const excerpt = videoRequestExcerpt(request, body)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    // A rejected fetch means the request never reached the provider: the URL
    // and the socket code are the only evidence, so both go into the message
    // AND the record. A cancellation is the caller's own decision and is not a
    // failure to explain, so it is passed through unrecorded.
    if (signal.aborted) throw error
    const network = networkErrorFields(error)
    const failure = new VideoGenError(
      `无法连接视频接口：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${attempt.url}`,
      'video-unreachable',
    )
    recordVideoFailure(attempt, failure, { requestExcerpt: excerpt })
    throw failure
  }
  const { payload, text } = await readJsonWithText(response)
  if (!response.ok) {
    const failure = new VideoGenError(
      `${errorTextOf(payload, `视频提交失败（HTTP ${response.status}）`)}（HTTP ${response.status} · ${attempt.url}）`,
      'video-submit-failed',
    )
    recordVideoFailure(attempt, failure, {
      status: response.status,
      requestExcerpt: excerpt,
      // The raw body is what says WHY the gateway refused, so it is kept.
      bodyExcerpt: excerptOf(text),
      responseBytes: Buffer.byteLength(text, 'utf8'),
    })
    throw failure
  }
  return payload
}

/**
 * GET one status request and return the parsed JSON body.
 *
 * A status code that is worth retrying is flagged on the error (see
 * `RETRYABLE_STATUS`) so the poll loop can swallow one blip instead of failing
 * a render the provider is still working on. Every other status keeps the wire
 * code the route layer already reported.
 */
async function getJson(attempt: VideoAttempt, url: string, apiKey: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  // A transport failure here is usually transient and the poll loop retries
  // it, so it is judged (and, if the retries run out, recorded) THERE rather
  // than here: recording every blip would bury the one failure that matters.
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  })
  const { payload, text } = await readJsonWithText(response)
  if (!response.ok) {
    const retryable = RETRYABLE_STATUS.has(response.status)
    const failure = new VideoGenError(
      errorTextOf(payload, `视频状态查询失败（HTTP ${response.status}）`),
      retryable ? 'video-status-transient' : 'video-status-failed',
      retryable,
      response.status,
    )
    // A permanent status is the end of the render: record it now. A transient
    // one is only recorded if the loop exhausts its retries.
    if (!retryable) {
      recordVideoFailure(attempt, failure, {
        status: response.status,
        bodyExcerpt: excerptOf(text),
        responseBytes: Buffer.byteLength(text, 'utf8'),
      })
    }
    throw failure
  }
  return payload
}

/** Extract the task id from any of the submit response shapes we have seen. */
function taskIdOf(payload: Record<string, unknown>): string {
  // The poll route is `GET <base>/videos/{id}`, so the id must be the RESOURCE
  // id, never the task id: comemoe returns both in one flat body, and polling
  // by its `task_id` would 404. Resource ids come first; `task_id` is only a
  // last resort for relays that return nothing else.
  //
  // comemoe returns a FLAT body ({"id","status","task_id"}), contradicting its
  // own documentation, which shows {"task":{"id":…}}. Agnes returns
  // video_id/task_id. Accept every shape rather than trusting one.
  const nested = payload.task
  const candidates = [
    payload.video_id,
    payload.id,
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>).id : undefined,
    payload.task_id,
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>).task_id : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number') return String(candidate)
  }
  return ''
}

/** Terminal state read from one poll response. */
type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'done'; url: string; duration?: number; poster?: string }
  | { kind: 'failed'; message: string }

/**
 * Interpret one poll response.
 *
 * Status vocabularies differ and are incomplete in the docs: Agnes reports
 * `completed`/`failed`, while comemoe adds a `processing` state its docs omit
 * (they claim `queued → running → succeeded`). Treat the union as canonical
 * and resolve the URL from either the nested metadata or the flat top level.
 */
function readPoll(payload: Record<string, unknown>): PollOutcome {
  const status = String(payload.status ?? '').toLowerCase().trim()
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { kind: 'failed', message: errorTextOf(payload, '视频生成失败') }
  }
  const metadata = payload.metadata !== null && typeof payload.metadata === 'object'
    ? payload.metadata as Record<string, unknown>
    : undefined
  // comemoe puts the result at the top level (`url`); Agnes nests it under
  // `metadata.url`. Accept both regardless of which family we are polling.
  const urlCandidates = [payload.url, payload.result_url, payload.video_url, metadata?.url]
  const url = urlCandidates.find(candidate => typeof candidate === 'string' && candidate.trim() !== '')
  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(status)) {
    if (typeof url !== 'string') {
      return { kind: 'failed', message: '视频任务已完成但未返回视频地址' }
    }
    const duration = typeof payload.duration === 'number' ? payload.duration
      : typeof metadata?.duration === 'number' ? metadata.duration as number
        : undefined
    const poster = typeof payload.poster === 'string' ? payload.poster
      : typeof metadata?.poster === 'string' ? metadata.poster as string
        : undefined
    return {
      kind: 'done',
      url,
      ...duration === undefined ? {} : { duration },
      ...poster === undefined ? {} : { poster },
    }
  }
  // Anything else (queued / processing / running / pending / in_progress) is
  // still in flight. A body that already carries a URL alongside a non-terminal
  // status is treated as done, because some relays only flip the status later.
  if (typeof url === 'string' && status === '') return { kind: 'done', url }
  return { kind: 'pending' }
}

/**
 * Delay before poll number `attempt` (0-based).
 *
 * Polling is quick-start then steady: the first few checks come fast so a fast
 * render (or an immediate rejection) surfaces in seconds, and the cadence then
 * settles into the family interval. A flat interval would make every user wait
 * the full 6-8s before even the first status, which is the worst case for the
 * common "provider rejected it instantly" path.
 */
function pollDelayMs(policy: { intervalMs: number }, attempt: number): number {
  if (attempt === 0) return 1_500
  if (attempt === 1) return 3_000
  return policy.intervalMs
}

/**
 * How many poll requests in a row may fail transiently before the loop gives
 * up. The retries share the family deadline, so a dead endpoint still ends in
 * `video-timeout` instead of retrying forever.
 */
const MAX_POLL_TRANSIENT_RETRIES = 4

/** Short backoff before re-asking a status endpoint that just failed. */
function pollRetryDelayMs(retry: number): number {
  const steps = [300, 700, 1_500, 3_000]
  return steps[Math.min(retry, steps.length) - 1] ?? 3_000
}

/** Poll one task until terminal or the family deadline passes. */
async function pollUntilDone(
  attempt: VideoAttempt,
  upstream: VideoUpstreamConfig,
  baseUrl: string,
  taskId: string,
  family: string,
  signal?: AbortSignal,
): Promise<{ url: string; duration?: number; poster?: string }> {
  const policy = POLL_POLICY[family] ?? POLL_POLICY.unknown!
  const deadline = Date.now() + policy.deadlineMs
  const statusUrl = `${baseUrl}/videos/${encodeURIComponent(taskId)}`
  const statusAttempt: VideoAttempt = {
    ...attempt,
    phase: 'video-poll',
    url: displayUrl(statusUrl),
    method: 'GET',
  }
  let attemptCount = 0
  // Consecutive transient poll failures. A render takes minutes, so one 5xx or
  // a dropped connection from the status endpoint must not fail a task the
  // provider is still working on; the retries stay inside the family deadline.
  let transientRetries = 0
  while (Date.now() < deadline) {
    await waitForPoll(pollDelayMs(policy, attemptCount), signal)
    attemptCount += 1
    const budget = requestSignal(signal, SUBMIT_TIMEOUT_MS)
    try {
      const payload = await getJson(statusAttempt, statusUrl, upstream.apiKey, budget.signal)
      transientRetries = 0
      const outcome = readPoll(payload)
      if (outcome.kind === 'done') return { url: outcome.url, ...outcome.duration === undefined ? {} : { duration: outcome.duration }, ...outcome.poster === undefined ? {} : { poster: outcome.poster } }
      if (outcome.kind === 'failed') {
        // The provider ran the render and reported it failed: record the task
        // id and its own words, which is the only place the cause exists.
        const failure = new VideoGenError(outcome.message, 'video-failed')
        recordVideoFailure(statusAttempt, failure, {
          requestExcerpt: excerptOf({ taskId, family, ...payload }),
        })
        throw failure
      }
    } catch (error) {
      // Cancellation is the caller's decision: pass it straight through.
      if (signal?.aborted === true) throw error
      // A transient poll error is one the same request could survive: a
      // retryable status, a per-request budget timeout (the budget aborts with
      // a TimeoutError DOMException), or a transport failure (which node's
      // fetch reports as a TypeError). A provider failure that `readPoll`
      // recognised is a VideoGenError and never retryable, so it is surfaced
      // immediately; so is anything else unexpected.
      const transient = error instanceof VideoGenError
        ? error.retryable
        : error instanceof TypeError
          || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      if (!transient) throw error
      transientRetries += 1
      if (transientRetries > MAX_POLL_TRANSIENT_RETRIES) {
        // The loop is giving up on a status endpoint that keeps failing. This
        // is the moment to record it: one transient blip is not worth a row,
        // an exhausted retry budget is exactly what the user needs to see.
        recordPollExhausted(statusAttempt, error, taskId, family, transientRetries)
        throw error
      }
      // Never spend the backoff past the family deadline: the retries are meant
      // to stay inside it, so a dead endpoint still ends in `video-timeout`
      // instead of running one more wait the deadline already passed.
      if (Date.now() + pollRetryDelayMs(transientRetries) >= deadline) break
      // Swallow the blip and ask the same endpoint again after a short backoff.
      await waitForPoll(pollRetryDelayMs(transientRetries), signal)
    } finally {
      budget.dispose()
    }
  }
  const timeout = new VideoGenError(`视频生成超时（已等待 ${Math.round(policy.deadlineMs / 60_000)} 分钟）`, 'video-timeout')
  // A timeout is the most common "it just sat there" report, so the record
  // carries which task was being polled and how far the polls got.
  recordVideoFailure(statusAttempt, timeout, {
    requestExcerpt: excerptOf({ taskId, family, polls: attemptCount, waitedMs: policy.deadlineMs }),
  })
  throw timeout
}

/** Download the finished clip, forwarding the key only to the API's origin. */
async function downloadVideo(attempt: VideoAttempt, upstream: VideoUpstreamConfig, url: string, signal?: AbortSignal): Promise<VideoBytes> {
  const budget = requestSignal(signal, DOWNLOAD_TIMEOUT_MS)
  try {
    // The upstream Bearer key is only attached for the provider's own origin;
    // a third-party CDN URL must not be able to harvest it.
    const headers: Record<string, string> = isSameOriginAsApi(url, upstream.apiUrl)
      ? { authorization: `Bearer ${upstream.apiKey}` }
      : {}
    let response: Response
    try {
      response = await fetch(url, { headers, signal: budget.signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const network = networkErrorFields(error)
      const failure = new VideoGenError(
        `无法下载生成的视频：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 视频地址 ${attempt.url}`,
        'video-download-failed',
      )
      recordVideoFailure(attempt, failure)
      throw failure
    }
    if (!response.ok) {
      const failure = new VideoGenError(`无法下载生成的视频（HTTP ${response.status} · ${attempt.url}）`, 'video-download-failed')
      recordVideoFailure(attempt, failure, { status: response.status })
      throw failure
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) {
      const failure = new VideoGenError('生成的视频内容为空', 'video-download-failed')
      recordVideoFailure(attempt, failure, { status: response.status, responseBytes: 0 })
      throw failure
    }
    if (buffer.byteLength > MAX_VIDEO_BYTES) {
      const failure = new VideoGenError('生成的视频超出了单文件体积上限', 'video-too-large')
      // The size is the whole point here: it is what says the URL returned
      // something other than the clip that was asked for.
      recordVideoFailure(attempt, failure, { status: response.status, responseBytes: buffer.byteLength })
      throw failure
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return { bytes: buffer, mime: videoMimeOf(contentType, url), sourceUrl: url }
  } finally {
    budget.dispose()
  }
}

/** Pick a video MIME type from the response header, falling back to the URL. */
function videoMimeOf(contentType: string | undefined, url: string): string {
  if (contentType !== undefined && /^video\/[a-z0-9.+-]+$/i.test(contentType)) return contentType
  const match = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url)
  switch (match?.[1]?.toLowerCase()) {
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mkv': return 'video/x-matroska'
    default: return 'video/mp4'
  }
}

/** Build the family-specific submit body. */
function submitBody(
  entry: VideoCatalogEntry,
  family: string,
  request: VideoGenerateRequest,
  references: DecodedReferences,
): Record<string, unknown> {
  const seconds = clampVideoSeconds(request.seconds)
  const resolution = normalizeVideoResolution(request.model, request.resolution)
  const familyName = entry.family

  if (familyName === 'comemoe') {
    // Measured contract: duration (seconds), aspect_ratio limited to
    // 16:9|9:16|1:1, resolution 'standard'|'720P'|'1080P'. wan2.2-t2v accepts
    // only 'standard'; the i2v-capable model takes a single image_url.
    const body: Record<string, unknown> = {
      model: request.upstream ?? request.model,
      prompt: request.prompt,
      duration: seconds,
      aspect_ratio: ['16:9', '9:16', '1:1'].includes(request.aspectRatio) ? request.aspectRatio : '16:9',
      resolution: entry.modes.includes('text') && entry.modes.length === 1 ? 'standard'
        : resolution === '1080P' ? '1080P' : '720P',
    }
    if (references.primary !== undefined && entry.modes.includes('image')) {
      body.image_url = dataUrlOf(references.primary)
    }
    return body
  }

  if (familyName === 'agnes') {
    const body: Record<string, unknown> = {
      model: request.upstream ?? request.model,
      prompt: request.prompt,
      mode: familyMode('agnes', request.mode),
      seconds: String(seconds),
      size: resolution,
    }
    if (entry.aspectRatios.includes(request.aspectRatio)) body.aspect_ratio = request.aspectRatio
    if (request.mode === 'keyframe') {
      if (references.all[0] !== undefined) body.first_frame = dataUrlOf(references.all[0])
      if (references.all[1] !== undefined) body.last_frame = dataUrlOf(references.all[1])
    } else if (request.mode === 'image' || request.mode === 'reference') {
      if (references.all.length > 0) body.images = references.all.map(dataUrlOf)
    }
    if (entry.supportsSeed && request.seed !== undefined && Number.isFinite(request.seed)) body.seed = request.seed
    return body
  }

  // Generic OpenAI-style video endpoint: best effort, widened parameters.
  const body: Record<string, unknown> = {
    model: request.upstream ?? request.model,
    prompt: request.prompt,
    seconds: String(seconds),
    size: resolution,
  }
  if (request.aspectRatio.trim() !== '') body.aspect_ratio = request.aspectRatio
  if (references.primary !== undefined) body.image = dataUrlOf(references.primary)
  return body
}

/**
 * Generate one video: submit, poll to a terminal state, download the clip.
 *
 * `family` may be forced by the caller (the runtime passes the resolved
 * upstream family), otherwise it is derived from the model alias.
 */
export async function generateVideo(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  options: { signal?: AbortSignal; family?: string } = {},
): Promise<VideoEngineResult> {
  const model = (request.upstream ?? request.model).trim()
  if (model === '') throw new VideoGenError('未指定视频模型', 'video-no-model')
  const entry = describeVideoModel(model)
  const family = options.family ?? entry.family
  if (entry.family === 'unknown' && options.family === undefined) {
    throw new VideoGenError(`无法识别视频模型「${model}」的协议族，请在渠道中改用已知的视频模型`, 'video-unknown-model')
  }
  if (family === 'unknown') {
    throw new VideoGenError(`视频模型「${model}」的协议族未知，无法生成`, 'video-unknown-model')
  }
  const references = referencesOf(request)
  if (request.mode === 'keyframe' && references.all.length === 0) {
    throw new VideoGenError('首尾帧模式至少需要一张首帧图片', 'video-bad-reference')
  }
  // Both image-bearing modes need at least one frame. `reference` used to slip
  // through: the panel only required a frame for `image`, so a reference-mode
  // submit with nothing attached reached the provider and came back as an
  // unexplained rejection instead of "this mode needs a reference image".
  if ((request.mode === 'image' || request.mode === 'reference') && references.primary === undefined) {
    throw new VideoGenError(
      request.mode === 'reference' ? '参考图模式至少需要一张参考图片' : '图生视频需要一张参考图片',
      'video-bad-reference',
    )
  }

  const baseUrl = upstream.apiUrl.replace(/\/+$/, '')
  const url = endpointUrl(upstream, baseUrl, '/videos')
  const body = submitBody(entry, family, request, references)
  // The submit leg's own context: every failure from here to the task id is a
  // "the render never started" report, which is a different problem from a
  // render that started and then failed.
  const submitAttempt = videoAttempt(upstream, request, model, 'video-submit', url, 'POST', JSON.stringify(body))

  const submitBudget = requestSignal(options.signal, SUBMIT_TIMEOUT_MS)
  let taskId = ''
  try {
    const payload = await postJson(submitAttempt, request, url, upstream.apiKey, body, submitBudget.signal)
    taskId = taskIdOf(payload)
    if (taskId === '') {
      // A 2xx that carries no task id is just as unrecoverable as a rejection,
      // and the body is the only place the provider explains itself.
      const failure = new VideoGenError(errorTextOf(payload, '视频接口未返回任务 ID'), 'video-submit-failed')
      recordVideoFailure(submitAttempt, failure, { requestExcerpt: excerptOf(payload) })
      throw failure
    }
  } finally {
    submitBudget.dispose()
  }

  const finished = await pollUntilDone(submitAttempt, upstream, baseUrl, taskId, family, options.signal)
  // The download leg gets its own phase and its own URL: the clip usually
  // comes from a CDN, so "the status worked but the bytes did not" is a
  // distinct failure the address alone makes obvious.
  const downloadAttempt: VideoAttempt = {
    ...submitAttempt,
    phase: 'video-download',
    url: displayUrl(finished.url),
    method: 'GET',
  }
  const downloaded = await downloadVideo(downloadAttempt, upstream, finished.url, options.signal)
  return {
    videos: [{
      ...downloaded,
      ...finished.duration === undefined ? {} : { duration: finished.duration },
      ...finished.poster === undefined ? {} : { poster: finished.poster },
    }],
  }
}

/** Whether a request would be routed to the comemoe family. */
export function isComemoeRequest(model: string): boolean {
  return isComemoeVideoModel(model)
}

/**
 * snapgen.ai video protocol primitives.
 *
 * snapgen.ai is NOT an OpenAI-compatible video endpoint, so none of the shared
 * transport in video-engine.ts applies: the submit is a multipart POST behind a
 * hand-rolled anti-bot header (x-guard-id), the answer is a history uuid rather
 * than a task id, progress is a NUMERIC status on GET /history/{uuid}
 * (1 running, 2 finished, 3 failed), and most submits additionally need a
 * single-use Cloudflare Turnstile token.
 *
 * This module owns exactly those wire details. Orchestration (diagnostics,
 * budget, download, resume) stays in video-engine.ts so a snapgen failure is
 * recorded in the same buffer and on the same phases as every other family.
 *
 * Framework-free: plain fetch + node:crypto, no cordis, no DOM.
 */

import { createHash } from 'node:crypto'

/** API root; every request path below is appended to this. */
export const SNAPGEN_API_BASE = 'https://api.snapgen.ai/api'

/** Path prefix the guard signs; the guard covers the mount point, the fetch does not. */
const SNAPGEN_API_MOUNT = '/api'
/** Where the browser talks to snapgen.ai; sent as origin/referer. */
export const SNAPGEN_WEB_ORIGIN = 'https://snapgen.ai'
/** Clock reference: the API reports its own time in the x-server-time header. */
export const SNAPGEN_TIME_HOST = 'https://api.geminigen.ai/health'
/** A public generation page; enough for the Turnstile widget to boot. */
export const SNAPGEN_WIDGET_PAGE = 'https://snapgen.ai/app/video-gen/grok-lite'
/** Turnstile site key baked into the shipped page config. */
export const SNAPGEN_TURNSTILE_SITEKEY = '0x4AAAAAACDBydnKT0zYzh2H'
/** Default CDP port of the Chrome that mints Turnstile tokens. */
export const SNAPGEN_DEFAULT_CDP_PORT = 9333
/** A desktop Chrome UA: the guard hashes it into the stable id and Turnstile
 *  scores it, so node-fetch's own agent string would look wrong. */
export const SNAPGEN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

/** The guard's secrets and constants, shipped in the page runtimeConfig. */
const SNAPGEN_SECRET_KEY = '45NPBH$&'
const SNAPGEN_SECRET_SALT = '&vTQm0&u'
/** The stable desktop fingerprint the guard carries (32 bytes, hex). */
const SNAPGEN_DOM_FP = '2c0b975f6586ba302c0b975f6586ba302bfdf81d6586ba115666822156668221'
const GUARD_WINDOW_MS = 60_000
const STABLE_ID_LEN = 22
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A snapgen protocol failure, carrying the upstream error code when there is one. */
export class SnapgenError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly status?: number
  /** Upstream error_code, when the body carried one. */
  readonly upstreamCode?: string
  readonly bodyExcerpt?: string

  constructor(message: string, code = 'snapgen-failed', retryable = false, status?: number, extra: { upstreamCode?: string; bodyExcerpt?: string } = {}) {
    super(message)
    this.name = 'SnapgenError'
    this.code = code
    this.retryable = retryable
    if (status !== undefined) this.status = status
    if (extra.upstreamCode !== undefined) this.upstreamCode = extra.upstreamCode
    if (extra.bodyExcerpt !== undefined) this.bodyExcerpt = extra.bodyExcerpt
  }
}

/** The credential bundle one snapgen channel carries. */
export interface SnapgenCredentials {
  /** Short-lived (about ten minutes) bearer token. */
  accessToken: string
  /** Long-lived token that mints a new access token. */
  refreshToken: string
  /** 22-character anti-bot device id; any valid-looking value is accepted. */
  stableId: string
  /** Port of the Chrome instance that mints Turnstile tokens. */
  cdpPort: number
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function deriveStableId(seed: string): string {
  return createHash('sha256').update(SNAPGEN_SECRET_SALT + ':' + seed, 'utf8').digest('base64url').slice(0, STABLE_ID_LEN)
}

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3 && value.length > 40
}

/**
 * Read a channel's secret into a credential bundle.
 *
 * The settings card stores one string per channel, so both shapes are accepted:
 * a bare token (a JWT is the access token, anything else the refresh token) or a
 * JSON object carrying the refresh token plus optional overrides. A refresh
 * token alone is enough, because the access token is minted on demand.
 */
export function parseSnapgenCredentials(raw: string): SnapgenCredentials {
  const text = raw.trim()
  if (text === '') {
    throw new SnapgenError(
      '渠道密钥为空：请填入 snapgen.ai 的 refresh_token（或 {"refresh_token":"…","cdp_port":9333} 形式的 JSON）',
      'snapgen-credentials',
    )
  }
  let accessToken = ''
  let refreshToken = ''
  let stableId = ''
  let cdpPort = SNAPGEN_DEFAULT_CDP_PORT
  if (text.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SnapgenError('渠道密钥看起来是 JSON 但无法解析：请检查引号与逗号', 'snapgen-credentials')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SnapgenError('渠道密钥的 JSON 必须是一个对象', 'snapgen-credentials')
    }
    const obj = parsed as Record<string, unknown>
    accessToken = pickString(obj, ['access_token', 'accessToken', 'token'])
    refreshToken = pickString(obj, ['refresh_token', 'refreshToken', 'refresh'])
    stableId = pickString(obj, ['stable_id', 'stableId', 'stable'])
    const port = obj.cdp_port ?? obj.cdpPort
    const portNumber = typeof port === 'number' ? port : typeof port === 'string' ? Number(port) : Number.NaN
    if (Number.isFinite(portNumber) && portNumber > 0) cdpPort = Math.trunc(portNumber)
  } else if (looksLikeJwt(text)) {
    accessToken = text
  } else {
    refreshToken = text
  }
  if (accessToken === '' && refreshToken === '') {
    throw new SnapgenError('渠道密钥里既没有 access_token 也没有 refresh_token', 'snapgen-credentials')
  }
  // Any 22-char url-safe id is accepted by the server, so when the user did not
  // pin one it is derived from the credential itself: deterministic across
  // restarts, and never identical between two accounts.
  if (!new RegExp('^[A-Za-z0-9_-]{' + STABLE_ID_LEN + '}$').test(stableId)) {
    stableId = deriveStableId(refreshToken !== '' ? refreshToken : accessToken)
  }
  return { accessToken, refreshToken, stableId, cdpPort }
}

let clockOffsetMs = 0
let clockSyncedAt = 0

/**
 * Calibrate the local clock against the API.
 *
 * The guard signs a one-minute time bucket, so a machine whose clock is minutes
 * off signs a bucket the server never sees. Failure is silent: an unsynchronised
 * clock is the normal case and must not break generation.
 */
async function syncClockOffset(): Promise<void> {
  if (Date.now() - clockSyncedAt < 600_000) return
  clockSyncedAt = Date.now()
  try {
    const startedAt = Date.now()
    const response = await fetch(SNAPGEN_TIME_HOST, { method: 'GET', signal: AbortSignal.timeout(2500) })
    const header = response.headers.get('x-server-time') ?? response.headers.get('date') ?? ''
    const numeric = Number(header)
    // Some deployments report seconds, others milliseconds; both are accepted.
    const serverMs = Number.isFinite(numeric) && numeric > 0
      ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric)
      : Date.parse(header)
    if (!Number.isFinite(serverMs)) return
    clockOffsetMs = Math.round(serverMs + (Date.now() - startedAt) / 2 - Date.now())
  } catch {
    // Keep whatever offset we had; local time is the fallback.
  }
}

function u32be(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

/**
 * Build the x-guard-id value for one request.
 *
 * Layout, byte for byte as the shipped bundle emits it: version byte, 16-byte
 * sha of the device id, 4-byte big-endian time bucket, 32-byte sha of the request
 * line, 32-byte device fingerprint -- 85 bytes, base64url, padding stripped.
 */
export function snapgenGuard(path: string, method: string, stableId: string, now = Date.now() + clockOffsetMs): string {
  const bucket = Math.floor(now / GUARD_WINDOW_MS)
  const deviceDigest = sha256hex(SNAPGEN_SECRET_KEY + ':' + stableId).slice(0, 32)
  const requestMac = sha256hex(path + ':' + method.toUpperCase() + ':' + deviceDigest + ':' + bucket + ':' + SNAPGEN_SECRET_KEY)
  const payload = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(deviceDigest, 'hex'),
    u32be(bucket),
    Buffer.from(requestMac, 'hex'),
    Buffer.from(SNAPGEN_DOM_FP, 'hex'),
  ])
  return payload.toString('base64url')
}

/** Every response body is read once as text so the diagnostics excerpt can share it. */
interface SnapgenReply { payload: unknown; text: string; status: number }

function upstreamError(payload: unknown): { code: string; message: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const detail = record.detail
  if (detail !== null && typeof detail === 'object') {
    const inner = detail as Record<string, unknown>
    const code = typeof inner.error_code === 'string' ? inner.error_code : ''
    const message = typeof inner.error_message === 'string' ? inner.error_message : ''
    if (code !== '' || message !== '') return { code, message }
  }
  if (typeof detail === 'string' && detail.trim() !== '') {
    // FastAPI returns a bare string or a list of field errors; either way the
    // text is the only useful part.
    return { code: '', message: detail }
  }
  const code = typeof record.error_code === 'string' ? record.error_code : ''
  const message = typeof record.error_message === 'string' ? record.error_message : ''
  if (code !== '' || message !== '') return { code, message }
  return undefined
}

function excerptOfText(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > 2000 ? trimmed.slice(0, 2000) : trimmed
}
/** What one snapgen model accepts on the wire. */
interface SnapgenModelWire {
  endpoint: string
  /** 'ratio' speaks 16:9 vocabulary on the wire, 'orientation' speaks landscape. */
  aspectStyle: 'ratio' | 'orientation'
  aspects: Record<string, string>
  resolutions: string[]
  durations: number[]
  /** grok models stream server-sent events; the others answer with plain JSON. */
  streaming: boolean
  /**
   * Whether the submit is refused without a Cloudflare Turnstile token.
   *
   * Measured per endpoint rather than per family: grok-* and muse answer
   * TURNSTILE_REQUIRED without one, while vela accepts the same submit with no
   * token at all. Minting costs a CDP round trip, so the two models that do not
   * need it must not be made to depend on a running browser.
   */
  turnstile: boolean
  defaultResolution: string
}

function ratio(value: string): string {
  return value
}

const SNAPGEN_WIRE: Record<string, SnapgenModelWire> = {
  'grok-video': {
    endpoint: '/video-gen/grok-stream',
    aspectStyle: 'ratio',
    aspects: { '16:9': ratio('16:9'), '9:16': ratio('9:16'), '1:1': ratio('1:1'), '4:3': ratio('4:3'), '3:4': ratio('3:4') },
    resolutions: ['480p', '720p', '1080p', '4k'],
    durations: [6, 10, 15],
    streaming: true,
    turnstile: true,
    defaultResolution: '720p',
  },
  'grok-lower': {
    endpoint: '/video-gen/grok-lower',
    aspectStyle: 'orientation',
    aspects: { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square', '4:3': '3:2', '3:4': '2:3' },
    resolutions: ['480p', '720p', '1080p'],
    durations: [6, 10, 15],
    streaming: true,
    turnstile: true,
    defaultResolution: '720p',
  },
  'grok-1.5-lite': {
    endpoint: '/video-gen/grok-1.5-lite',
    aspectStyle: 'orientation',
    aspects: { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square', '4:3': '3:2', '3:4': '2:3' },
    resolutions: ['480p', '720p', '1080p'],
    durations: [6, 10, 15],
    streaming: true,
    turnstile: true,
    defaultResolution: '720p',
  },
  'muse-ai-video': {
    endpoint: '/video-gen/meta',
    aspectStyle: 'orientation',
    aspects: { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' },
    resolutions: [],
    durations: [10],
    streaming: false,
    turnstile: true,
    defaultResolution: '',
  },
  'vela-ai-video': {
    endpoint: '/video-gen/vela',
    aspectStyle: 'orientation',
    aspects: { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' },
    resolutions: [],
    durations: [5],
    streaming: false,
    turnstile: false,
    defaultResolution: '',
  },
}

/** The wire description of one snapgen model, or undefined when it is unknown. */
export function snapgenWire(model: string): SnapgenModelWire | undefined {
  return SNAPGEN_WIRE[model]
}

/** True when the id names a snapgen video model this module can drive. */
export function isSnapgenModel(model: string): boolean {
  return SNAPGEN_WIRE[model] !== undefined
}

/** Everything the submit needs, already narrowed to one model. */
export interface SnapgenWireParams {
  aspectRatio: string
  resolution: string
  seconds: number
}

function nearestNumber(allowed: number[], wanted: number): number {
  let best = allowed[0]!
  let bestGap = Math.abs(best - wanted)
  for (const value of allowed) {
    const gap = Math.abs(value - wanted)
    if (gap < bestGap) {
      best = value
      bestGap = gap
    }
  }
  return best
}

/**
 * Narrow a generic request onto one model's wire vocabulary.
 *
 * The panel speaks in 16:9 / 480P / 5-second terms because that is what the
 * OpenAI-compatible families accept. snapgen splits into two dialects (ratios for
 * grok-video, orientations for everything else) and fixes the duration per model,
 * so the translation happens here and not in the UI.
 */
export function snapgenWireParams(model: string, params: SnapgenWireParams): SnapgenWireParams {
  const wire = SNAPGEN_WIRE[model]
  if (wire === undefined) {
    throw new SnapgenError('未知的 snapgen 视频模型：' + model, 'snapgen-model')
  }
  const wantedAspect = params.aspectRatio.trim()
  const aspect = wire.aspects[wantedAspect] ?? (Object.values(wire.aspects).includes(wantedAspect) ? wantedAspect : '')
  if (aspect === '') {
    throw new SnapgenError(
      '模型 ' + model + ' 不支持画幅 ' + wantedAspect + '（可用：' + Object.keys(wire.aspects).join(', ') + '）',
      'snapgen-aspect',
    )
  }
  const wantedResolution = params.resolution.trim().toLowerCase()
  const resolution = wire.resolutions.includes(wantedResolution)
    ? wantedResolution
    : wire.resolutions.length === 0
      ? ''
      : wire.defaultResolution
  const seconds = nearestNumber(wire.durations, params.seconds)
  return { aspectRatio: aspect, resolution, seconds }
}
/** Mutable auth state for one generation; the access token expires in minutes. */
export class SnapgenSession {
  readonly credentials: SnapgenCredentials
  accessToken: string
  refreshToken: string
  private refreshing: Promise<void> | undefined

  constructor(credentials: SnapgenCredentials) {
    this.credentials = credentials
    this.accessToken = credentials.accessToken
    this.refreshToken = credentials.refreshToken
  }

  /** Expiry in epoch milliseconds, or 0 when the token is opaque/unreadable. */
  private expiryMs(): number {
    const parts = this.accessToken.split('.')
    if (parts.length !== 3) return 0
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
      return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
    } catch {
      return 0
    }
  }

  private needsRefresh(): boolean {
    if (this.accessToken === '') return this.refreshToken !== ''
    const expiry = this.expiryMs()
    if (expiry === 0) return false
    // Sixty seconds of slack: a token that dies mid-flight is worse than an
    // extra refresh, and refresh is cheap and idempotent.
    return expiry - Date.now() < 60_000
  }

  /** Mint a fresh access token, collapsing concurrent callers onto one request. */
  async ensureFreshToken(): Promise<void> {
    if (!this.needsRefresh()) return
    if (this.refreshToken === '') {
      throw new SnapgenError('snapgen 的 access_token 已过期，且渠道密钥里没有 refresh_token 可供续期', 'snapgen-token-expired')
    }
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined
    })
    await this.refreshing
  }

  private async refreshNow(): Promise<void> {
    const response = await fetch(SNAPGEN_API_BASE + '/refresh-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': SNAPGEN_UA, origin: SNAPGEN_WEB_ORIGIN, referer: SNAPGEN_WEB_ORIGIN + '/' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let payload: unknown = undefined
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const failure = upstreamError(payload)
      throw new SnapgenError(
        'snapgen 令牌续期失败：' + (failure?.message || 'HTTP ' + response.status) + '（请重新登录 snapgen.ai 并更新渠道密钥里的 refresh_token）',
        'snapgen-token-expired',
        false,
        response.status,
        { upstreamCode: failure?.code, bodyExcerpt: excerptOfText(text) },
      )
    }
    const record = (payload ?? {}) as Record<string, unknown>
    const access = typeof record.access_token === 'string' ? record.access_token : ''
    if (access === '') {
      throw new SnapgenError('snapgen 令牌续期没有返回 access_token', 'snapgen-token-expired', false, response.status, { bodyExcerpt: excerptOfText(text) })
    }
    this.accessToken = access
    const rotated = typeof record.refresh_token === 'string' ? record.refresh_token : ''
    if (rotated !== '') this.refreshToken = rotated
  }

  /** The mobile-app bearer string and the anti-bot header, ready to spread into headers. */
  authHeaders(path: string, method: string): Record<string, string> {
    return {
      authorization: 'Bearer ' + this.accessToken,
      // The guard signs the path the server routes on, which includes the API
      // mount point: signing '/video-gen/meta' instead of '/api/video-gen/meta'
      // is answered with GUARD_INVALID, not with a 404.
      'x-guard-id': snapgenGuard(SNAPGEN_API_MOUNT + path, method, this.credentials.stableId),
    }
  }
}

interface SnapgenRequestOptions {
  method: string
  /** Path below the API root, e.g. '/history/abc'. */
  path: string
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Retry once after a token refresh; disabled for the refresh call itself. */
  retryOnExpiry?: boolean
}

async function snapgenFetch(session: SnapgenSession, options: SnapgenRequestOptions): Promise<SnapgenReply> {
  const path = options.path
  const method = options.method.toUpperCase()
  await syncClockOffset()
  await session.ensureFreshToken()
  const headers: Record<string, string> = {
    'user-agent': SNAPGEN_UA,
    origin: SNAPGEN_WEB_ORIGIN,
    referer: SNAPGEN_WEB_ORIGIN + '/',
    ...session.authHeaders(path, method),
    ...options.headers,
  }
  let response: Response
  try {
    response = await fetch(SNAPGEN_API_BASE + path, {
      method,
      headers,
      body: options.body ?? null,
      signal: options.signal ?? AbortSignal.timeout(120_000),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new SnapgenError('snapgen 请求超时：' + path, 'snapgen-unreachable', true)
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new SnapgenError('无法连接 snapgen 接口：' + reason, 'snapgen-unreachable', true)
  }
  const text = await response.text()
  let payload: unknown = undefined
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }
  const expiry = response.status === 401 || response.status === 403
    ? upstreamError(payload)
    : undefined
  const expired = expiry !== undefined && (expiry.code + ' ' + expiry.message).toUpperCase().includes('TOKEN')
  if (expired && options.retryOnExpiry !== false && session.refreshToken !== '') {
    // The access token died between the freshness check and the request; one
    // forced refresh plus one retry is all this loop ever does.
    session.accessToken = ''
    await session.ensureFreshToken()
    return await snapgenFetch(session, { ...options, retryOnExpiry: false })
  }
  if (!response.ok) {
    const failure = upstreamError(payload)
    const code = failure?.code ?? ''
    const message = failure?.message ?? ''
    throw new SnapgenError(
      'snapgen 请求失败：' + (message || 'HTTP ' + response.status) + (code === '' ? '' : ' [' + code + ']'),
      snapgenErrorCode(code, response.status),
      response.status === 429 || response.status >= 500,
      response.status,
      { upstreamCode: code === '' ? undefined : code, bodyExcerpt: excerptOfText(text) },
    )
  }
  return { payload, text, status: response.status }
}

/** Map an upstream error code onto the plugin's own failure vocabulary. */
export function snapgenErrorCode(code: string, status: number): string {
  const upper = code.toUpperCase()
  if (upper.includes('TURNSTILE')) return 'snapgen-turnstile'
  if (upper.includes('GUARD')) return 'snapgen-guard'
  if (upper.includes('DAILY_LIMIT') || upper.includes('QUOTA') || upper.includes('EXCEEDED')) return 'snapgen-quota'
  if (upper.includes('PREMIUM')) return 'snapgen-premium'
  if (upper.includes('CREDIT')) return 'snapgen-credit'
  if (upper.includes('TOKEN')) return 'snapgen-token-expired'
  if (upper.includes('RATE_LIMIT')) return 'snapgen-rate-limited'
  if (upper.includes('INVALID') || upper.includes('BAD_REQUEST')) return 'snapgen-bad-request'
  return status === 429 ? 'snapgen-rate-limited' : 'snapgen-failed'
}
interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

async function cdpList(port: number, timeoutMs = 4000): Promise<CdpTarget[]> {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new SnapgenError('CDP ' + port + ' 返回 HTTP ' + response.status, 'snapgen-turnstile')
  const payload = (await response.json()) as unknown
  if (!Array.isArray(payload)) throw new SnapgenError('CDP ' + port + ' 的目标列表不是数组', 'snapgen-turnstile')
  return payload as CdpTarget[]
}

/** Find a page target on a snapgen.ai URL, creating one when the browser has none. */
async function cdpSnapgenPage(port: number): Promise<CdpTarget> {
  const targets = await cdpList(port)
  const page = targets.find(target => target.type === 'page' && target.url.includes('snapgen.ai') && typeof target.webSocketDebuggerUrl === 'string')
  if (page !== undefined) return page
  // No snapgen tab: open one. The turnstile widget only needs the origin's
  // script, not a signed-in session, so a fresh tab is enough.
  const opened = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(SNAPGEN_WIDGET_PAGE), { method: 'PUT', signal: AbortSignal.timeout(6000) })
  if (!opened.ok) {
    const urls = targets.filter(item => item.type === 'page').map(item => item.url).join(' | ')
    throw new SnapgenError(
      'CDP ' + port + ' 上没有 snapgen.ai 页面，且无法新建（HTTP ' + opened.status + '）。现有页面：' + (urls === '' ? '无' : urls),
      'snapgen-turnstile',
    )
  }
  const created = (await opened.json()) as CdpTarget
  if (typeof created.webSocketDebuggerUrl !== 'string') {
    throw new SnapgenError('CDP ' + port + ' 新建的页面没有调试地址', 'snapgen-turnstile')
  }
  return created
}

interface CdpReply { id?: number; result?: Record<string, unknown>; error?: { message?: string } }

/** One short-lived CDP connection; every method call is request/response. */
class CdpConnection {
  private readonly socket: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', event => {
      const raw = typeof event.data === 'string' ? event.data : ''
      if (raw === '') return
      let reply: CdpReply
      try {
        reply = JSON.parse(raw) as CdpReply
      } catch {
        return
      }
      if (typeof reply.id !== 'number') return
      const slot = this.pending.get(reply.id)
      if (slot === undefined) return
      this.pending.delete(reply.id)
      if (reply.error !== undefined) slot.reject(new Error(reply.error.message ?? 'CDP 调用失败'))
      else slot.resolve(reply.result ?? {})
    })
  }

  static async open(url: string, timeoutMs: number): Promise<CdpConnection> {
    if (typeof WebSocket !== 'function') {
      throw new SnapgenError('当前运行时没有 WebSocket，无法通过 CDP 获取 Turnstile 令牌（需要 Node 22+）', 'snapgen-turnstile')
    }
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SnapgenError('连接 CDP 超时：' + url, 'snapgen-turnstile')), timeoutMs)
      timer.unref?.()
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new SnapgenError('无法连接 CDP：' + url, 'snapgen-turnstile'))
      })
    })
    return new CdpConnection(socket)
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // Already gone.
    }
  }
}

/**
 * The in-page script that renders an invisible Turnstile widget and executes it.
 *
 * Runs with awaitPromise, so the whole mint is one round trip. The widget is
 * bound to the site key and the page origin, which is why a plain HTTP solver
 * cannot stand in for it.
 */
function turnstileScript(sitekey: string, timeoutMs: number): string {
  const quote = (value: string) => JSON.stringify(value)
  return [
    '(async () => {',
    '  const sitekey = ' + quote(sitekey),
    '  const timeoutMs = ' + String(timeoutMs),
    '  if (!window.turnstile || typeof window.turnstile.render !== \'function\') {',
    '    return \'ERR:turnstile-not-loaded\'',
    '  }',
    '  const host = document.createElement(\'div\')',
    '  host.id = \'dsh-snapgen-ts-probe\'',
    '  host.style.display = \'none\'',
    '  document.body.appendChild(host)',
    '  try {',
    '    const token = await new Promise(resolve => {',
    '      let settled = false',
    '      const finish = value => { if (!settled) { settled = true; resolve(value) } }',
    '      const timer = setTimeout(() => finish(\'TIMEOUT\'), timeoutMs)',
    '      let widget',
    '      try {',
    '        widget = window.turnstile.render(\'#dsh-snapgen-ts-probe\', {',
    '          sitekey,',
    '          size: \'invisible\',',
    '          callback: value => { clearTimeout(timer); finish(value) },',
    '          \'error-callback\': reason => { clearTimeout(timer); finish(\'ERR:\' + String(reason)) },',
    '        })',
    '      } catch (error) {',
    '        clearTimeout(timer)',
    '        finish(\'RENDER:\' + String(error && error.message ? error.message : error))',
    '        return',
    '      }',
    '      setTimeout(() => {',
    '        try {',
    '          const running = window.turnstile.execute(widget)',
    '          if (running && typeof running.then === \'function\') running.catch(() => undefined)',
    '        } catch (error) {',
    '          clearTimeout(timer)',
    '          finish(\'EXEC:\' + String(error && error.message ? error.message : error))',
    '        }',
    '      }, 300)',
    '    })',
    '    return token',
    '  } finally {',
    '    host.remove()',
    '  }',
    '})()',
  ].join('\n')
}

/**
 * Mint a Turnstile token from the CDP browser.
 *
 * snapgen binds each token to the site key and accepts it exactly once, so one
 * mint happens per submit. The Chrome only has to be reachable and on a
 * snapgen.ai tab; it does not have to be the user's signed-in profile.
 */
export async function mintSnapgenTurnstile(options: { cdpPort?: number; sitekey?: string; timeoutMs?: number } = {}): Promise<string> {
  const port = options.cdpPort ?? SNAPGEN_DEFAULT_CDP_PORT
  const sitekey = options.sitekey ?? SNAPGEN_TURNSTILE_SITEKEY
  const timeoutMs = options.timeoutMs ?? 30_000
  let page: CdpTarget
  try {
    page = await cdpSnapgenPage(port)
  } catch (error) {
    if (error instanceof SnapgenError) throw error
    throw new SnapgenError(
      '无法访问 CDP ' + port + '：请先启动带 --remote-debugging-port=' + port + ' 的 Chrome 并打开 snapgen.ai（详见 README 的 Turnstile 一节）',
      'snapgen-turnstile',
    )
  }
  const connection = await CdpConnection.open(page.webSocketDebuggerUrl!, Math.min(timeoutMs, 10_000))
  try {
    await connection.call('Runtime.enable')
    const result = await connection.call('Runtime.evaluate', {
      expression: turnstileScript(sitekey, timeoutMs),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const remote = result.result as { value?: unknown } | undefined
    const token = typeof remote?.value === 'string' ? remote.value : ''
    if (token.startsWith('TIMEOUT')) {
      throw new SnapgenError('Turnstile 出票超时：请在 ' + port + ' 端口的 Chrome 里手动打开一次 snapgen.ai 页面', 'snapgen-turnstile', true)
    }
    if (token.startsWith('ERR:') || token.startsWith('RENDER:') || token.startsWith('EXEC:')) {
      throw new SnapgenError('Turnstile 出票失败：' + token, 'snapgen-turnstile')
    }
    if (token.length < 50) {
      throw new SnapgenError('Turnstile 出票结果异常（长度 ' + token.length + '）', 'snapgen-turnstile')
    }
    return token
  } finally {
    connection.close()
  }
}
/** One reference frame handed to the submit. */
export interface SnapgenFile {
  bytes: Buffer
  mime: string
  filename: string
}

/** Everything one submit needs, already narrowed onto the model's wire dialect. */
export interface SnapgenSubmitInput {
  /** Upstream model id, e.g. 'grok-1.5-lite'. */
  model: string
  prompt: string
  /** Already translated by snapgenWireParams. */
  aspectRatio: string
  resolution: string
  seconds: number
  /** Turnstile token minted for this very submit; omitted for vela. */
  turnstileToken?: string
  skipAudio?: boolean
  files?: SnapgenFile[]
  onProgress?: (progress: number) => void
}

export interface SnapgenSubmitResult {
  uuid: string
  /** Seconds the server said to wait before polling, when it said anything. */
  queueDelaySeconds?: number
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberAt(source: unknown, path: string[]): number | undefined {
  let cursor: unknown = source
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'number' ? cursor : undefined
}

/** Pull the first uuid that appears anywhere in a submit reply. */
function uuidOf(payload: unknown, text: string): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['uuid', 'history_uuid', 'id', 'history_id']) {
      const value = record[key]
      if (typeof value === 'string' && UUID_RE.test(value)) return value
      if (typeof value === 'number') continue
    }
    const history = record.history
    if (history !== null && typeof history === 'object') {
      const nested = uuidOf(history, '')
      if (nested !== '') return nested
    }
  }
  const match = UUID_RE.exec(text)
  return match === null ? '' : match[0]
}

/**
 * Submit one generation and return its history uuid.
 *
 * The grok models answer with a server-sent event stream that must be drained
 * (and carries the failure code when the submit is refused late), while muse and
 * vela answer with a plain JSON body. Both shapes end at a history uuid, which is
 * what the caller polls.
 */
export async function submitSnapgenVideo(session: SnapgenSession, input: SnapgenSubmitInput, options: { signal?: AbortSignal } = {}): Promise<SnapgenSubmitResult> {
  const wire = SNAPGEN_WIRE[input.model]
  if (wire === undefined) throw new SnapgenError('未知的 snapgen 视频模型：' + input.model, 'snapgen-model')
  const form = new FormData()
  form.append('prompt', input.prompt)
  form.append('model', input.model)
  if (wire.aspectStyle === 'ratio') {
    form.append('aspect_ratio', input.aspectRatio)
    form.append('resolution', input.resolution)
    form.append('duration', String(input.seconds))
  } else {
    form.append('duration', String(input.seconds))
    form.append('orientation', input.aspectRatio)
    if (wire.resolutions.length > 0 && input.resolution !== '') form.append('resolution', input.resolution)
  }
  if (wire.streaming) form.append('skip_audio', input.skipAudio === true ? 'true' : 'false')
  if (input.turnstileToken !== undefined && input.turnstileToken !== '') form.append('turnstile_token', input.turnstileToken)
  for (const file of input.files ?? []) {
    form.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename)
  }
  const reply = await snapgenFetch(session, {
    method: 'POST',
    path: wire.endpoint,
    body: form,
    headers: wire.streaming ? { accept: 'text/event-stream' } : { accept: 'application/json' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const streaming = reply.text.includes('event:')
  if (!streaming) {
    const uuid = uuidOf(reply.payload, reply.text)
    if (uuid === '') {
      throw new SnapgenError('snapgen 提交成功但没有返回历史 ID', 'snapgen-submit-failed', false, reply.status, { bodyExcerpt: excerptOfText(reply.text) })
    }
    const delay = numberAt(reply.payload, ['delay_seconds'])
    return delay === undefined ? { uuid } : { uuid, queueDelaySeconds: delay }
  }
  const parsed = parseSnapgenStream(reply.text, input.onProgress)
  const uuid = parsed.uuid
  if (uuid === '') {
    throw new SnapgenError('snapgen 的事件流里没有历史 ID', 'snapgen-submit-failed', false, reply.status, { bodyExcerpt: excerptOfText(reply.text) })
  }
  return parsed.queueDelaySeconds === undefined ? { uuid } : { uuid, queueDelaySeconds: parsed.queueDelaySeconds }
}

/** Drain the grok event stream; a late refusal surfaces here, not on the submit. */
function parseSnapgenStream(text: string, onProgress?: (progress: number) => void): SnapgenSubmitResult {
  let uuid = ''
  let queueDelaySeconds: number | undefined
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    const eventLine = trimmed.split('\n').find(line => line.startsWith('event:'))
    const dataLine = trimmed.split('\n').find(line => line.startsWith('data:'))
    const eventName = eventLine === undefined ? '' : eventLine.slice(6).trim()
    const raw = dataLine === undefined ? '' : dataLine.slice(5).trim()
    let payload: unknown = undefined
    if (raw !== '' && raw !== '[DONE]') {
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = undefined
      }
    }
    const found = uuidOf(payload, raw)
    if (found !== '' && uuid === '') uuid = found
    if (payload !== null && typeof payload === 'object') {
      const delay = numberAt(payload, ['delay_seconds'])
      if (delay !== undefined && queueDelaySeconds === undefined) queueDelaySeconds = delay
    }
    if (eventName === 'grok_video_generation') {
      const progress = numberAt(payload, ['data', 'result', 'response', 'streamingVideoGenerationResponse', 'progress'])
      if (progress !== undefined && onProgress !== undefined) onProgress(progress)
    }
    if (eventName === 'grok_generation_failure') {
      const record = (payload ?? {}) as Record<string, unknown>
      const detail = record.detail
      const source = detail !== null && typeof detail === 'object' ? (detail as Record<string, unknown>) : record
      const code = textOf(source.error_code) || textOf(source.code)
      const message = textOf(source.message) || textOf(source.error_message) || '视频生成失败'
      throw new SnapgenError(message, snapgenErrorCode(code, 500), false, 500, { upstreamCode: code === '' ? undefined : code })
    }
  }
  return queueDelaySeconds === undefined ? { uuid } : { uuid, queueDelaySeconds }
}
/** One history record as far as this module cares. */
export interface SnapgenHistoryState {
  uuid: string
  /** 1 running, 2 finished, 3 failed. */
  status: number
  progress: number
  model: string
  /** Pre-signed mp4 URL; the preferred download source. */
  videoUrl: string
  /** Worker-proxied URL; only used when no pre-signed URL came back. */
  fallbackUrl: string
  durationSeconds?: number
  poster?: string
  errorCode?: string
  errorMessage?: string
  queuePosition?: number
}

function firstVideo(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ['generated_video', 'generated_videos']) {
    const value = record[key]
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0]
      if (first !== null && typeof first === 'object') return first as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * Read a history record into the small shape the poll loop needs.
 *
 * snapgen reports status numerically, which is the one thing the shared poll
 * reader in video-engine.ts cannot interpret; everything else here mirrors the
 * fields the web app's own downloadHistoryItem() looks at.
 */
export function readSnapgenHistory(payload: unknown): SnapgenHistoryState {
  const root = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const record = root.data !== null && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root
  const video = firstVideo(record)
  const rawStatus = record.status
  const status = typeof rawStatus === 'number' ? rawStatus : typeof rawStatus === 'string' && rawStatus.trim() !== '' && Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : 1
  const uuid = textOf(record.uuid) || UUID_RE.exec(JSON.stringify(record.uuid ?? ''))?.[0] || ''
  const videoUrl = video === undefined ? '' : textOf(video.video_url) || textOf(video.video_uri)
  const fallbackUrl = video === undefined ? '' : textOf(video.file_download_url)
  const state: SnapgenHistoryState = {
    uuid: typeof record.uuid === 'string' ? record.uuid : uuid,
    status,
    progress: numberAt(record, ['status_percentage']) ?? (status === 2 ? 100 : 0),
    model: textOf(record.model_name),
    videoUrl,
    fallbackUrl,
  }
  const duration = video === undefined ? undefined : numberAt(video, ['duration'])
  if (duration !== undefined) state.durationSeconds = duration
  const poster = record.thumbnail_url !== undefined ? textOf(record.thumbnail_url) : video === undefined ? '' : textOf(video.thumbnail_url)
  if (poster !== '') state.poster = poster
  const queuePosition = numberAt(record, ['queue_position'])
  if (queuePosition !== undefined) state.queuePosition = queuePosition
  const errorCode = textOf(record.error_code)
  if (errorCode !== '') state.errorCode = errorCode
  const errorMessage = textOf(record.error_message)
  if (errorMessage !== '') state.errorMessage = errorMessage
  return state
}

/** Read one history record by uuid. */
export async function fetchSnapgenHistory(session: SnapgenSession, uuid: string, options: { signal?: AbortSignal } = {}): Promise<SnapgenHistoryState> {
  const reply = await snapgenFetch(session, {
    method: 'GET',
    path: '/history/' + encodeURIComponent(uuid),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return readSnapgenHistory(reply.payload)
}

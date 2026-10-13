/**
 * Google Antigravity (Nano Banana Pro) subscription image vendor.
 *
 * Protocol adapted from opencode-antigravity-auth-remix (MIT,
 * (c) 2026 Darkstarrd-dev, based on NoeFabris/opencode-antigravity-auth):
 * Google OAuth with the Antigravity CLI's public client credentials, managed
 * project discovery via loadCodeAssist, and image generation through the
 * v1internal:streamGenerateContent endpoint with the gemini-3-pro-image
 * model. Reference: dist/src/constants.js, dist/src/plugin/image.js,
 * dist/src/plugin/project.js.
 *
 * The dsh-subscriptions antigravity vendor left the OAuth client empty
 * (Google's is confidential); the remix package ships the Antigravity CLI's
 * own embedded client id/secret, which the community treats as public the
 * same way Codex CLI's and grok-cli's are.
 */
import { randomUUID } from 'node:crypto'
import { buildAuthorizeUrl, formTokenRequest, type Pkce } from '../oauth.js'
import type { SubscriptionBlob } from '../blob.js'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')

/** Antigravity OAuth is experimental and requires user-supplied client credentials. */
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

/**
 * Endpoint fallback order for generation, mirroring the reference (daily
 * sandbox first, then autopush, then prod).
 */
export const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const

/** loadCodeAssist is best supported on prod; discovery tries prod first. */
const LOAD_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
] as const

/** The image model served through this channel: Nano Banana Pro. */
export const ANTIGRAVITY_IMAGE_MODEL = 'gemini-3-pro-image'

/**
 * Antigravity client version carried in the browser User-Agent. Google's
 * backend routes by this: a non-Antigravity or outdated UA lands in the
 * enterprise-license check and fails with the misleading 403 #3501
 * "You do not have a valid license of this product". The official
 * auto-updater publishes the current version; changelog scrape and the
 * hardcoded fallback keep the header sane when the updater is unreachable
 * (same strategy as the reference implementation's version.js).
 */
const ANTIGRAVITY_VERSION_FALLBACK = '2.0.6'
const VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app'
const CHANGELOG_URL = 'https://antigravity.google/changelog'
const VERSION_FETCH_TIMEOUT_MS = 5_000
const CHANGELOG_SCAN_CHARS = 5_000
const VERSION_REGEX = /\d+\.\d+\.\d+/

let antigravityVersion: string | undefined

/** Current client version: the fetched one, or the fallback until fetched. */
export function getAntigravityVersion(): string {
  return antigravityVersion ?? ANTIGRAVITY_VERSION_FALLBACK
}

/** Test seam: pin the version so unit tests never depend on the network. */
export function setAntigravityVersionForTest(version: string | undefined): void {
  antigravityVersion = version
}

/** Fetch and cache the current version once; failures keep the fallback. */
export async function initAntigravityVersion(): Promise<void> {
  if (antigravityVersion !== undefined) return
  const parsed = await fetchVersionText(VERSION_URL)
    ?? await fetchVersionText(CHANGELOG_URL, CHANGELOG_SCAN_CHARS)
  if (parsed !== undefined) antigravityVersion = parsed
}

async function fetchVersionText(url: string, maxChars?: number): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    let text = await response.text()
    if (maxChars !== undefined) text = text.slice(0, maxChars)
    const match = text.match(VERSION_REGEX)
    return match === null ? undefined : match[0]
  } catch {
    return undefined
  }
}

/** Hardcoded fallback project when Antigravity returns none (workspace accounts). */
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc'

/** Generation timeout mirroring the reference implementation. */
const IMAGE_TIMEOUT_MS = 120_000

/** Aspect ratios the generationConfig.imageConfig accepts. */
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'] as const

/** Safety settings the image endpoint requires to not block benign prompts. */
const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
]

export interface AntigravityConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function antigravityConfig(): AntigravityConfig {
  const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim() ?? ''
  const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? ''
  if (clientId === '' || clientSecret === '') {
    throw new Error('Google 实验订阅需要设置 ANTIGRAVITY_CLIENT_ID 和 ANTIGRAVITY_CLIENT_SECRET 环境变量')
  }
  return { clientId, clientSecret, redirectUri: ANTIGRAVITY_REDIRECT_URI }
}

export function antigravityAuthorizeUrl(cfg: AntigravityConfig, pkce: Pkce): string {
  return buildAuthorizeUrl({
    authUrl: AUTH,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    challenge: pkce.challenge,
    state: pkce.state,
    scope: SCOPE,
    // offline_access equivalent for Google: force a refresh token each login.
    extra: { access_type: 'offline', prompt: 'consent' },
  })
}

/**
 * Headers for project discovery (loadCodeAssist): the reference keeps the
 * plain SDK identity here, mirroring its project.js loadHeaders.
 */
function loadHeaders(projectId: string): Record<string, string> {
  const platform = process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MACOS' : 'LINUX'
  return {
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform, pluginType: 'GEMINI', ...(projectId.length > 0 ? { duetProject: projectId } : {}) }),
  }
}

/**
 * Headers for content requests (image generation): the full Electron
 * browser User-Agent with the Antigravity client version, matching the
 * official IDE. This is the identity the license check keys on — the plain
 * SDK UA here is what produced 403 #3501 on personal accounts.
 */
function contentHeaders(projectId: string): Record<string, string> {
  const uaPlatform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'
  const platform = process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MACOS' : 'LINUX'
  return {
    'User-Agent': `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${getAntigravityVersion()} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform, pluginType: 'GEMINI', ...(projectId.length > 0 ? { duetProject: projectId } : {}) }),
  }
}

function tokenBlobFromOAuth(json: Record<string, unknown>): SubscriptionBlob {
  const access = json.access_token
  const refresh = json.refresh_token
  const idToken = typeof json.id_token === 'string' ? json.id_token : ''
  return {
    accessToken: typeof access === 'string' ? access : '',
    refreshToken: typeof refresh === 'string' ? refresh : '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    label: '',
    email: emailFromIdToken(idToken),
    accountId: '',
  }
}

/** Decode the id_token's JWT payload for the account email (identity only). */
function emailFromIdToken(idToken: string): string {
  const parts = idToken.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : ''
  } catch {
    return ''
  }
}

export async function antigravityExchangeCode(cfg: AntigravityConfig, pkce: Pkce, code: string): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(TOKEN, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: pkce.verifier,
  }, fetch)
  const blob = tokenBlobFromOAuth(json)
  if (blob.accessToken.length === 0) throw new Error('Antigravity token endpoint returned no access token')
  return blob
}

export async function antigravityRefresh(blob: SubscriptionBlob): Promise<SubscriptionBlob> {
  const cfg = antigravityConfig()
  const json = await formTokenRequest(TOKEN, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: blob.refreshToken,
  }, fetch)
  const next = tokenBlobFromOAuth(json)
  return {
    ...next,
    // Google does not always return a new refresh token; keep the old one.
    refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
    label: blob.label,
    email: blob.email.length > 0 ? blob.email : next.email,
    accountId: '',
  }
}

/**
 * Resolve the managed project id for the logged-in account. Most accounts
 * have one; when loadCodeAssist reports none, the hardcoded fallback keeps
 * generation working (mirrors the reference's ensureProjectContext).
 * Returns '' only when every endpoint fails, letting generate() throw then.
 */
export async function antigravityResolveProject(blob: SubscriptionBlob): Promise<string> {
  const metadata = { ideType: 'ANTIGRAVITY', platform: platformOf(), pluginType: 'GEMINI' }
  for (const base of LOAD_ENDPOINTS) {
    try {
      const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${blob.accessToken}`, ...loadHeaders('') },
        body: JSON.stringify({ metadata }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) continue
      const payload = await response.json().catch(() => null) as { cloudaicompanionProject?: unknown } | null
      if (payload === null) continue
      const project = payload.cloudaicompanionProject
      const id = typeof project === 'string' ? project
        : typeof project === 'object' && project !== null && typeof (project as { id?: unknown }).id === 'string' ? (project as { id: string }).id
        : ''
      if (id.length > 0) return id
    } catch {
      // try the next endpoint
    }
  }
  return DEFAULT_PROJECT_ID
}

function platformOf(): string {
  if (process.platform === 'win32') return 'WINDOWS'
  if (process.platform === 'darwin') return 'MACOS'
  return 'LINUX'
}

/**
 * Build the streamGenerateContent request body for one image generation.
 * Ported from the reference buildImageRequest + the wrapping envelope: no
 * tools, no systemInstruction, no thinkingConfig; responseModalities asks
 * for TEXT+IMAGE. Reference images (edits) ride along as inlineData parts
 * before the text part, mirroring the reference implementation.
 */
export function antigravityImageBody(options: {
  prompt: string
  aspectRatio?: string
  hd?: boolean
  referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }>
}): Record<string, unknown> {
  const ratio = options.aspectRatio !== undefined && (ASPECT_RATIOS as readonly string[]).includes(options.aspectRatio) ? options.aspectRatio : '1:1'
  const imageConfig: Record<string, unknown> = { aspectRatio: ratio }
  if (options.hd === true) imageConfig.imageSize = '4K'
  const parts: Array<Record<string, unknown>> = []
  for (const image of options.referenceImages ?? []) {
    parts.push({ inlineData: { mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64') } })
  }
  parts.push({ text: options.prompt })
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { candidateCount: 1, imageConfig, responseModalities: ['TEXT', 'IMAGE'] },
    safetySettings: SAFETY_SETTINGS_OFF,
  }
}

/** Wrap the inner request in the Antigravity agent envelope. */
export function antigravityEnvelope(projectId: string, request: Record<string, unknown>): Record<string, unknown> {
  return {
    project: projectId,
    model: ANTIGRAVITY_IMAGE_MODEL,
    userAgent: 'antigravity',
    requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    requestType: 'agent',
    request: { ...request, session_id: `sess-${randomUUID()}` },
  }
}

export interface AntigravityImageResult {
  b64: string
  mimeType: string
  text?: string
}

/**
 * Generate one image on the logged-in Antigravity account: resolve the
 * project, POST the wrapped body to each endpoint in fallback order, and
 * parse the SSE stream for the inlineData image part.
 */
export async function antigravityGenerateImage(options: {
  blob: SubscriptionBlob
  projectId: string
  prompt: string
  aspectRatio?: string
  hd?: boolean
  referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }>
  signal?: AbortSignal
}): Promise<AntigravityImageResult> {
  // Content requests carry the browser UA with the client version, which the
  // license check keys on; warm the fetched version before building headers.
  await initAntigravityVersion()
  const inner = antigravityImageBody({
    prompt: options.prompt,
    ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.hd !== undefined ? { hd: options.hd } : {}),
    ...(options.referenceImages !== undefined ? { referenceImages: options.referenceImages } : {}),
  })
  const body = antigravityEnvelope(options.projectId, inner)
  let lastError = 'no endpoint succeeded'
  for (const base of ANTIGRAVITY_ENDPOINTS) {
    const url = `${base}/v1internal:streamGenerateContent?alt=sse`
    const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...contentHeaders(options.projectId),
          Authorization: `Bearer ${options.blob.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        lastError = `HTTP ${String(response.status)}: ${text.slice(0, 200)}`
        // License/quota/network-class failures move on to the next endpoint.
        if (response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) continue
        throw new Error(`antigravity ${lastError}`)
      }
      const text = await response.text()
      const parsed = parseSseImage(text)
      if (parsed !== undefined) return parsed
      // Endpoint answered but with no image; remember why and try the next.
      const reason = parseSseError(text)
      lastError = reason !== undefined ? reason : 'response contained no image'
      continue
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      lastError = error instanceof Error ? error.message : String(error)
      continue
    }
  }
  throw new Error(`antigravity image generation failed: ${lastError}`)
}

/** Scan an SSE body for the first image part in any data: line. */
function parseSseImage(text: string): AntigravityImageResult | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice('data: '.length).trim()
    if (raw.length === 0 || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as { response?: { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> } }
      for (const candidate of data.response?.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const inline = part.inlineData
          if (typeof inline?.data === 'string' && inline.data.length > 0 && typeof inline.mimeType === 'string' && inline.mimeType.startsWith('image/')) {
            return { b64: inline.data, mimeType: inline.mimeType }
          }
        }
      }
    } catch {
      // skip unparseable lines
    }
  }
  return undefined
}

/** Pull the first error block an SSE body reports, for better messages. */
function parseSseError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice('data: '.length).trim()
    if (raw.length === 0 || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
      if (data.error !== undefined) {
        const code = typeof data.error.code === 'string' || typeof data.error.code === 'number' ? String(data.error.code) : ''
        const message = typeof data.error.message === 'string' ? data.error.message : ''
        const joined = `${code.length > 0 ? `${code}: ` : ''}${message}`.trim()
        if (joined.length > 0) return joined
      }
    } catch {
      // skip
    }
  }
  return undefined
}
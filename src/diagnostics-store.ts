/**
 * Host-side generation diagnostics: a bounded, in-memory ring buffer of the
 * request attempts behind every generation, so a failed call is explainable
 * after the fact (#38).
 *
 * The reporter of #38 reverse-engineered an image API, verified it against
 * new-api, and then watched every call from this plugin fail — while neither
 * side had a log entry, because the request never reached their gateway. The
 * plugin surfaced a single sentence ("无法连接上游接口") and kept no record, so
 * there was nothing to inspect: not the URL it actually called, not the HTTP
 * status, not the network error code, not the upstream body.
 *
 * Captures the facts that separate the usual causes:
 *   - the FINAL request URL (a missing /v1 or a stray "exact URL" toggle is the
 *     most common cause of "the request never arrived"),
 *   - HTTP status + a bounded, redacted body excerpt,
 *   - the network error code (ECONNREFUSED / ENOTFOUND / CERT_* / timeout),
 *   - elapsed time and the request body size (a huge multipart edit can be
 *     rejected before it reaches the application),
 *   - whether an Authorization header was sent, never its value.
 *
 * Secrets never enter this store: the API key is reduced to a boolean, and
 * every recorded string passes through redaction.
 */

import type { DiagnosticEntry, DiagnosticPhase } from './protocol.ts'

export type { DiagnosticEntry, DiagnosticPhase }

/** What the caller supplies when recording an attempt. */
export type DiagnosticInput = Omit<DiagnosticEntry, 'id' | 'at' | 'durationMs' | 'hadAuth'> & {
  durationMs?: number
  hadAuth?: boolean
}

/** How many attempts to retain. Bounded so a long session cannot grow. */
export const DIAGNOSTIC_MAX = 200

/** Cap on any recorded excerpt, in characters. */
export const DIAGNOSTIC_EXCERPT_MAX = 2000

/**
 * Mask anything that looks like a credential. The store is meant to be copied
 * into a public issue thread, so this runs on every string it keeps: Bearer
 * tokens, common key prefixes, query-string secrets and long base64 blobs
 * (image payloads would otherwise swamp the buffer).
 */
export function redactDiagnosticText(value: string, limit = DIAGNOSTIC_EXCERPT_MAX): string {
  let text = value
  // Authorization headers of every common shape.
  text = text.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
  text = text.replace(/\b(sk|rk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '<redacted-key>')
  // Query-string and JSON secrets.
  text = text.replace(/([?&](?:api[_-]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, '$1<redacted>')
  text = text.replace(/("(?:api[_-]?key|key|token|secret|authorization)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
  // Inline image data would dominate any excerpt; keep only its shape.
  text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (match) => {
    const header = match.slice(0, match.indexOf(','))
    return `${header},<${match.length} chars of base64 redacted>`
  })
  // A long unbroken base64 run outside a data URL (raw b64_json responses).
  text = text.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200,}(?![A-Za-z0-9+/=])/g, '<long-base64 redacted>')
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text
}

/** Bounded excerpt of a body value (object → JSON, string → as-is). */
function excerptOf(value: unknown, limit = DIAGNOSTIC_EXCERPT_MAX): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (Buffer.isBuffer(value)) return `<${value.byteLength} bytes of binary>`
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text === '') return undefined
  return redactDiagnosticText(text, limit)
}

/** Byte length of a request body without materialising it twice. */
export function bodyByteLength(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8')
  if (Buffer.isBuffer(body)) return body.byteLength
  // FormData / Blob / streams: the size is not cheaply known; skip rather than
  // force a conversion that would defeat the streaming upload.
  return undefined
}

/**
 * The process-wide diagnostics buffer. One instance per host: generation runs
 * in a single queue, so a module-level singleton keeps every entry reachable
 * from the routes without threading a dependency through the engine.
 */
class DiagnosticStore {
  private entries: DiagnosticEntry[] = []
  private sequence = 0

  /** Record one attempt and return the stored entry. */
  record(input: DiagnosticInput): DiagnosticEntry {
    this.sequence += 1
    const entry: DiagnosticEntry = {
      ...input,
      id: `diag-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      at: Date.now(),
      durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
      hadAuth: input.hadAuth ?? false,
      ...input.bodyExcerpt === undefined ? {} : { bodyExcerpt: redactDiagnosticText(input.bodyExcerpt) },
      ...input.requestExcerpt === undefined ? {} : { requestExcerpt: redactDiagnosticText(input.requestExcerpt) },
      message: redactDiagnosticText(input.message),
    }
    // Newest first: the panel reads top-down and the newest failure matters most.
    this.entries.unshift(entry)
    if (this.entries.length > DIAGNOSTIC_MAX) this.entries.length = DIAGNOSTIC_MAX
    return entry
  }

  list(): DiagnosticEntry[] {
    return this.entries.map(entry => ({ ...entry }))
  }

  /** Drop everything; the panel's Clear action. */
  clear(): void {
    this.entries = []
  }
}

const store = new DiagnosticStore()

/** Record one upstream attempt. */
export function recordDiagnostic(input: DiagnosticInput): DiagnosticEntry {
  return store.record(input)
}

/** Snapshot the retained attempts, newest first. */
export function listDiagnostics(): DiagnosticEntry[] {
  return store.list()
}

/** Clear the retained attempts. */
export function clearDiagnostics(): void {
  store.clear()
}

/**
 * Pull the most useful diagnostic fields out of a thrown value. Fetch rejects
 * with an AggregateError whose `cause`/`errors` carry the real network code,
 * so the code has to be dug out rather than read off the top-level error.
 */
export function networkErrorFields(error: unknown): { errorCode?: string; detail: string } {
  const codes: string[] = []
  const messages: string[] = []
  const seen = new Set<unknown>()

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4 || seen.has(value)) return
    if (typeof value === 'object') seen.add(value)
    if (typeof value === 'string') {
      if (value !== '') messages.push(value)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['code', 'errno', 'name'] as const) {
      const field = record[key]
      if (typeof field === 'string' && field !== '') codes.push(field)
    }
    if (typeof record.message === 'string' && record.message !== '') messages.push(record.message)
    // undici aggregates every address it tried under `errors`; the cause chain
    // holds the same story for single-address failures.
    if (Array.isArray(record.errors)) for (const item of record.errors) visit(item, depth + 1)
    visit(record.cause, depth + 1)
  }

  visit(error, 0)
  // Prefer a real socket code over generic labels like 'Error' / 'TypeError'.
  const preferred = codes.find(code => /^[A-Z]+_?[A-Z0-9_]*$/.test(code) && code !== 'Error')
  const detail = [...new Set(messages)].join(' | ')
  return {
    ...preferred === undefined ? {} : { errorCode: preferred },
    detail: detail === '' ? String(error) : detail,
  }
}

/**
 * Read a Response body as text without consuming the stream twice.
 *
 * Returns the RAW text: callers parse it, so it must never be redacted here.
 * Redaction is applied only when the text is stored (see `redactDiagnosticText`
 * and `DiagnosticStore.record`), which keeps generated image payloads intact.
 */
export async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.clone().text()
  } catch {
    return ''
  }
}

/**
 * Read a bounded, REDACTED excerpt of a Response body for the diagnostics
 * record. Only for recording: never feed the result back into parsing.
 */
export async function readResponseExcerpt(response: Response, limit = DIAGNOSTIC_EXCERPT_MAX): Promise<string | undefined> {
  const text = await readResponseText(response)
  if (text === '') return undefined
  return redactDiagnosticText(text, limit)
}

export { excerptOf }

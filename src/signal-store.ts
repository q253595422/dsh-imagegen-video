/**
 * Behaviour signals (self-evolution L0).
 *
 * The diagnostics buffer explains one failed request and then forgets it at
 * restart. That is the right shape for "why did this call fail" and the wrong
 * shape for "is this model getting worse" — the latter needs months, not the
 * last 200 attempts.
 *
 * More importantly, the most informative moments never reached the host at all:
 * the user hit retry, the user deleted the result, the user said "不像". Those
 * are judgements about output quality, and nothing recorded them.
 *
 * This store is that memory. It is deliberately narrow, because a signal log
 * that collects the wrong thing is worse than none:
 *
 *   WRITTEN   model · channel · mode · prompt LENGTH BUCKET · has-reference ·
 *             failure code · coarse reason · plugin version · timestamp
 *   NEVER     the prompt text, the image bytes, the API key, the URL, the
 *             response body
 *
 * The prompt text is excluded on purpose. It is the single most sensitive thing
 * this plugin handles, and a length bucket answers the only question a report
 * needs ("are long prompts more likely to be retried?") without it. Nothing
 * here is ever sent anywhere by the host; the report surface shows it and, if
 * the user clicks through, builds a GitHub issue draft in the browser.
 *
 * Layout: one append-only JSONL file per month under
 * `<data root>/signals/YYYY-MM.jsonl`. Monthly files keep a single file from
 * growing without bound while making "the last 90 days" a cheap read of three
 * files instead of a parse of everything ever recorded.
 *
 * Framework-free (node:fs only) so the route layer and tests drive it directly.
 */

import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { imageDataRoot } from './image-storage-path.ts'
import { PLUGIN_VERSION } from './protocol.ts'
import type {
  PromptBucket,
  SignalEntry,
  SignalKind,
  SignalPipeline,
  SignalReason,
  SignalSource,
} from './protocol.ts'

export type { PromptBucket, SignalEntry, SignalKind, SignalPipeline, SignalReason, SignalSource }

/** How many monthly files a read walks back. Six months covers a release or
 *  two; older files stay on disk (the user's data) but stop costing a parse. */
export const SIGNAL_MAX_MONTHS = 6

/** Cap on one monthly file, counted in bytes. A file past this is not parsed
 *  further: the report says so rather than silently reporting a partial month
 *  as a complete one. */
export const SIGNAL_MAX_FILE_BYTES = 8 * 1024 * 1024

/** Cap on one stored line. A signal is metadata; a line this long is not one,
 *  and reading it would only inflate the report. */
export const SIGNAL_MAX_LINE_BYTES = 2 * 1024

/** Prompt-length buckets live in protocol.ts: the report and the browser both
 *  need the same enum, and two declarations would drift. */
const PROMPT_BUCKET_LIMITS: ReadonlyArray<{ bucket: PromptBucket; max: number }> = [
  { bucket: 'none', max: 0 },
  { bucket: 'short', max: 120 },
  { bucket: 'medium', max: 400 },
  { bucket: 'long', max: 1200 },
  { bucket: 'huge', max: Number.POSITIVE_INFINITY },
]

/**
 * Map a prompt to its length bucket. Never returns the prompt, and never a
 * precise length: "short" cannot be correlated with a specific wording, which
 * is the point.
 */
export function promptBucketOf(prompt: string | undefined): PromptBucket {
  const length = prompt === undefined ? 0 : prompt.trim().length
  for (const limit of PROMPT_BUCKET_LIMITS) {
    if (length <= limit.max) return limit.bucket
  }
  return 'huge'
}

const KINDS: readonly SignalKind[] = ['retry', 'delete', 'failure', 'rating']
const PIPELINES: readonly SignalPipeline[] = ['image', 'video', 'canvas', 'skill']
const REASONS: readonly SignalReason[] = ['unlike', 'text', 'slow', 'misread']
const SOURCES: readonly SignalSource[] = ['auto', 'user']

/** Signals arriving from the browser are untrusted input: every enum is
 *  whitelisted and every string is length-capped before it is stored. */
export type SignalInput = {
  kind?: unknown
  pipeline?: unknown
  model?: unknown
  channel?: unknown
  mode?: unknown
  prompt?: unknown
  hasReference?: unknown
  failureCode?: unknown
  reason?: unknown
  source?: unknown
  /** Client-side idempotency key for a rating, so a double-click is one signal. */
  nonce?: unknown
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback
}

/** Trim + cap one string field. Empty is fine; overlong is truncated, not rejected. */
function capped(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/** A failure code is an identifier, not prose: keep its alphabet tight. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(trimmed)) return undefined
  return trimmed
}

function monthKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}`
}

function signalsDir(): string { return path.join(imageDataRoot(), 'signals') }

function fileOf(month: string): string { return path.join(signalsDir(), `${month}.jsonl`) }

// Writes are appends to a shared monthly file. Serialize them inside this
// process so two concurrent route calls cannot interleave a partial line; the
// append itself is a single write, so a crash mid-write costs one line, not the
// file (the reader skips unparseable lines rather than failing the month).
let pendingWrite: Promise<void> = Promise.resolve()

function mutateSignals<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingWrite.then(operation, operation)
  pendingWrite = next.then(() => undefined, () => undefined)
  return next
}

/**
 * Nonces seen recently, to collapse a double-clicked rating into one signal.
 * Bounded and in-process: this is a UX guard, not a correctness guarantee, and
 * a duplicate after a restart harms nothing but one row in a rate.
 *
 * Both numbers are UX-sized rather than measured: a double-click lands inside
 * a second, so ten minutes is far more time than a retry storm needs while
 * still letting a genuine second rating through. 200 entries is roughly one
 * rating per second for the whole window — a real session rates a handful of
 * results, so hitting the cap means the caller is looping, not that the bound
 * is too tight. Neither is a correctness limit; lowering them is safe.
 */
const seenNonces = new Map<string, number>()
const SEEN_NONCE_MAX = 200
const SEEN_NONCE_TTL_MS = 10 * 60_000

function nonceIsFresh(nonce: string, now: number): boolean {
  for (const [key, at] of seenNonces) {
    if (now - at > SEEN_NONCE_TTL_MS) seenNonces.delete(key)
  }
  if (seenNonces.has(nonce)) return false
  seenNonces.set(nonce, now)
  if (seenNonces.size > SEEN_NONCE_MAX) {
    const oldest = seenNonces.keys().next().value
    if (oldest !== undefined) seenNonces.delete(oldest)
  }
  return true
}

let sequence = 0

/**
 * Normalize one untrusted input into a storable entry.
 *
 * Returns undefined for input that is not a signal at all: an unknown `kind` is
 * a caller bug, and inventing one would put noise into every later rate.
 */
export function normalizeSignal(input: SignalInput, at = Date.now()): Omit<SignalEntry, 'id'> | undefined {
  const kind = oneOf(KINDS, input.kind, 'rating')
  if (typeof input.kind !== 'string' || !(KINDS as readonly string[]).includes(input.kind)) return undefined

  const source = oneOf(SOURCES, input.source, 'user')
  const pipeline = oneOf(PIPELINES, input.pipeline, 'image')

  // A rating without a reason is not a rating: the reason is the whole value,
  // and an unattributed thumbs-down cannot be acted on.
  const reason = kind === 'rating' ? oneOf(REASONS, input.reason, 'unlike') : undefined
  if (kind === 'rating' && typeof input.reason !== 'string') return undefined

  return {
    at,
    kind,
    pipeline,
    model: capped(input.model, 120),
    channel: capped(input.channel, 120),
    mode: capped(input.mode, 40),
    promptBucket: promptBucketOf(typeof input.prompt === 'string' ? input.prompt : undefined),
    ...input.hasReference === true || input.hasReference === false ? { hasReference: input.hasReference } : {},
    ...codeOf(input.failureCode) === undefined ? {} : { failureCode: codeOf(input.failureCode) },
    ...reason === undefined ? {} : { reason },
    source,
    version: PLUGIN_VERSION,
  }
}

/** Append one already-normalized signal. Returns the stored entry. */
export async function recordSignal(input: SignalInput, now = Date.now()): Promise<SignalEntry | undefined> {
  const normalized = normalizeSignal(input, now)
  if (normalized === undefined) return undefined

  const nonce = capped(input.nonce, 80)
  if (nonce !== '' && !nonceIsFresh(nonce, now)) return undefined

  sequence += 1
  const entry: SignalEntry = {
    ...normalized,
    id: `sig-${now.toString(36)}-${sequence.toString(36)}`,
  }

  await mutateSignals(async () => {
    const month = monthKey(entry.at)
    await fs.mkdir(signalsDir(), { recursive: true })
    // One line, one write. `\n` terminates it so a concurrent reader never
    // sees a half-written entry as a complete one.
    await fs.appendFile(fileOf(month), `${JSON.stringify(entry)}\n`, 'utf8')
  })

  return entry
}

/** One month's parse result, with the reason a month may be partial. */
export interface SignalMonth {
  month: string
  entries: SignalEntry[]
  /** Bytes actually read for this month. */
  bytes: number
  /** Set when the month was not read in full and the report must say so. */
  truncated?: 'size' | 'unreadable'
}

function isSignal(value: unknown): value is SignalEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.at === 'number'
    && (KINDS as readonly string[]).includes(String(record.kind))
    && typeof record.version === 'string'
}

/**
 * Read one monthly file. A file past `SIGNAL_MAX_FILE_BYTES` is read only up to
 * that budget and flagged: reporting a clipped month as complete would quietly
 * understate every rate in it.
 */
async function readMonth(month: string): Promise<SignalMonth> {
  let handle: FileHandle
  try {
    handle = await fs.open(fileOf(month), 'r')
  } catch {
    return { month, entries: [], bytes: 0, truncated: 'unreadable' }
  }
  try {
    const stat = await handle.stat()
    const budget = Math.min(stat.size, SIGNAL_MAX_FILE_BYTES)
    const buffer = Buffer.alloc(budget)
    const { bytesRead } = await handle.read(buffer, 0, budget, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const entries: SignalEntry[] = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      // A line cut off by the byte budget is not a signal; skipping it is
      // correct, and the month is flagged below so nothing reports it as whole.
      if (Buffer.byteLength(line, 'utf8') > SIGNAL_MAX_LINE_BYTES) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (isSignal(parsed)) entries.push(parsed)
    }
    return {
      month,
      entries,
      bytes: bytesRead,
      ...stat.size > budget ? { truncated: 'size' as const } : {},
    }
  } finally {
    await handle.close().catch(() => { /* reading already finished or failed */ })
  }
}

/**
 * Every month, oldest first, up to `SIGNAL_MAX_MONTHS` back from `now`.
 *
 * Oldest-first because the report walks forward in time (a trend line) and
 * because the caller that only wants recent rows can slice from the end.
 */
export async function listSignals(now = Date.now(), months = SIGNAL_MAX_MONTHS): Promise<SignalMonth[]> {
  const result: SignalMonth[] = []
  const cursor = new Date(now)
  cursor.setDate(1)
  for (let index = 0; index < months; index++) {
    result.push(await readMonth(monthKey(cursor.getTime())))
    cursor.setMonth(cursor.getMonth() - 1)
  }
  return result.reverse()
}

/** Flat list of every retained signal, oldest first. */
export async function allSignals(now = Date.now()): Promise<SignalEntry[]> {
  const months = await listSignals(now)
  return months.flatMap(month => month.entries).sort((left, right) => left.at - right.at)
}

/** How many signals are on disk right now (cheap: counts parsed entries only). */
export async function signalCount(now = Date.now()): Promise<number> {
  return (await allSignals(now)).length
}

/**
 * Delete every monthly file. The user's data, so this only runs on an explicit
 * request — there is no retention sweep that removes it behind their back.
 */
export async function clearSignals(): Promise<void> {
  await mutateSignals(async () => {
    const dir = signalsDir()
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) continue
      await fs.rm(path.join(dir, name), { force: true })
    }
  })
}

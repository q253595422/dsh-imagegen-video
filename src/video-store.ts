/**
 * Host-persisted video history: finished clips are stored as individual files
 * under ~/.dsh/dsh-imagegen/videos/ and an index.json keeps the metadata +
 * file names. This mirrors `history-store.ts`, which does the same for images.
 *
 * The split exists for one hard reason: a rendered clip is orders of magnitude
 * larger than a generated image, so video can never travel inline in a JSON
 * response the way image base64 does. The list route returns metadata only and
 * the browser pulls bytes lazily through the video file route, which also
 * supports Range so the <video> element can seek.
 *
 * Storage itself is still node:fs only; the one exception is poster extraction
 * (`video-poster.ts`), which shells out to a local ffmpeg because there is no
 * other way to decode an mp4. It is invoked only after the clip bytes are
 * already on disk, and it is allowed to fail silently — see the note on
 * {@link appendVideoHistory}.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VIDEO_API, type VideoDirectorPlan, type VideoHistoryEntry, type VideoHistoryEntryInput, type VideoMode } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'
import { extractPoster } from './video-poster.ts'

/** Cap on retained video entries (clips are large: keep the list short). */
export const VIDEO_HISTORY_MAX = 30

/**
 * Entries backfilled per call, so one request cannot spawn many ffmpegs.
 *
 * Three is the responsiveness half of a trade-off, not a correctness bound:
 * {@link drainVideoPosters} repeats the batch until the backlog is empty, so
 * the whole history gets posters from a single panel open. Do not raise this
 * to "solve" a slow backfill — it only decides how many spawns happen before
 * the first pause, and the drain already covers the rest.
 */
const BACKFILL_BATCH = 3

function videoRoot(): string { return path.join(imageDataRoot(), 'videos') }
function indexPath(): string { return path.join(videoRoot(), 'index.json') }
function filesDir(): string { return path.join(videoRoot(), 'files') }

// Mutations read and replace one shared index. Serialize them so overlapping
// requests cannot each read an old index and lose the other's row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateVideos<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** One stored clip's on-disk record (file name + mime, never bytes). */
interface StoredVideoFile {
  file: string
  mime: string
  duration?: number
  /** Upstream poster URL, when the provider supplied one. */
  poster?: string
  /** Locally extracted poster file name (e.g. `<id>-<n>-poster.jpg`). */
  posterFile?: string
  revisedPrompt?: string
}

/** One entry's on-disk record. */
interface StoredEntry {
  id: string
  createdAt: number
  mode: VideoMode
  model: string
  prompt: string
  aspectRatio: string
  resolution: string
  seconds: number
  videos: StoredVideoFile[]
  refName?: string
  channelId?: string
  channel?: string
  /** The director plan that shaped this clip, when planning ran. */
  plan?: VideoDirectorPlan
  /** `code` when a chat model wrote the drawing code (absent = model). */
  renderer?: 'model' | 'code'
}

/** The index.json shape. */
interface IndexFile {
  entries: StoredEntry[]
}

/** File extension for a video MIME type. */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim().toLowerCase()) {
    case 'video/webm': return 'webm'
    case 'video/quicktime': return 'mov'
    case 'video/x-matroska': return 'mkv'
    default: return 'mp4'
  }
}

/** MIME type for a stored clip file name. */
function mimeOfFile(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.mkv': return 'video/x-matroska'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    default: return 'video/mp4'
  }
}

/** Suffix marking a locally extracted poster (never a clip's own name). */
const POSTER_SUFFIX = '-poster.jpg'

/** The poster file name derived from one stored clip's name. */
function posterNameFor(file: string): string {
  return file.replace(/\.(mp4|webm|mov|mkv)$/i, `${POSTER_SUFFIX}`)
}

/** Sanitize an entry id for use as a file-name prefix. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-')
  return cleaned === '' ? 'video' : cleaned
}

/** Ensure the storage directories exist. */
async function ensureDirs(): Promise<void> {
  await fs.mkdir(filesDir(), { recursive: true })
}

/** Read the index, tolerating a missing/corrupt file. */
async function readIndex(): Promise<StoredEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return []
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return []
    return entries.filter(isStoredEntry)
  } catch {
    return []
  }
}

/** Persist the index. */
async function writeIndex(entries: StoredEntry[]): Promise<void> {
  await ensureDirs()
  const payload: IndexFile = { entries }
  const tmp = `${indexPath()}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
  await fs.rename(tmp, indexPath())
}

/** Structural guard for a stored entry. */
function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.videos)
    && entry.videos.every(video => {
      if (video === null || typeof video !== 'object') return false
      const record = video as Record<string, unknown>
      return typeof record.file === 'string' && typeof record.mime === 'string'
    })
}

/** Remove one entry's clip files (best effort). */
async function removeEntryFiles(entry: StoredEntry): Promise<void> {
  for (const video of entry.videos) {
    // The poster outlives a mistaken name only by accident: drop it with the
    // clip, or a re-saved entry would leave an orphan JPEG behind forever.
    try { await fs.rm(path.join(filesDir(), video.file), { force: true }) } catch { /* ignore */ }
    if (video.posterFile !== undefined) {
      try { await fs.rm(path.join(filesDir(), video.posterFile), { force: true }) } catch { /* ignore */ }
    }
  }
}

/** The same-origin URL for one stored clip. */
function fileUrl(file: string): string {
  return `${VIDEO_API.file}/${file}`
}

/** Project a stored entry onto the wire shape (served URLs, no bytes). */
function toWire(entry: StoredEntry): VideoHistoryEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    aspectRatio: entry.aspectRatio,
    resolution: entry.resolution,
    seconds: entry.seconds,
    videos: entry.videos.map(video => ({
      url: fileUrl(video.file),
      mime: video.mime,
      ...video.duration === undefined ? {} : { duration: video.duration },
      ...video.poster === undefined ? {} : { poster: video.poster },
      ...video.posterFile === undefined ? {} : { poster: fileUrl(video.posterFile) },
      ...video.revisedPrompt === undefined ? {} : { revisedPrompt: video.revisedPrompt },
    })),
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.plan === undefined ? {} : { plan: entry.plan },
    ...entry.renderer === undefined ? {} : { renderer: entry.renderer },
  }
}

/** List the persisted video history, newest first. */
export async function listVideoHistory(): Promise<VideoHistoryEntry[]> {
  const entries = await readIndex()
  return entries.map(toWire)
}

/**
 * Persist one generated clip.
 *
 * The engine has already downloaded the bytes, so the caller passes them here
 * rather than a URL: this keeps the store free of network access and means a
 * clip that never downloaded can never appear in the history.
 *
 * Extraction of the poster lives here rather than at the call sites because it
 * is a property of *storing* a clip, not of *making* one: every path that saves
 * a clip wants a thumbnail, and the bytes are already on disk by the time we
 * could ask for one. A failed extraction is not an error — see
 * {@link extractPoster}, which never throws.
 */
export async function appendVideoHistory(input: VideoHistoryEntryInput & { files: Array<{ bytes: Buffer; mime: string; duration?: number; poster?: string; revisedPrompt?: string }> }): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    await ensureDirs()
    const prefix = safeId(input.id)
    const stored: StoredVideoFile[] = []
    try {
      for (let index = 0; index < input.files.length; index++) {
        const file = input.files[index]!
        const name = `${prefix}-${index}.${extensionOf(file.mime)}`
        await fs.writeFile(path.join(filesDir(), name), file.bytes)
        const record: StoredVideoFile = {
          file: name,
          mime: file.mime,
          ...file.duration === undefined ? {} : { duration: file.duration },
          ...file.poster === undefined ? {} : { poster: file.poster },
          ...file.revisedPrompt === undefined ? {} : { revisedPrompt: file.revisedPrompt },
        }
        // An upstream poster wins: it is the frame the provider chose, and the
        // user may be on a channel where that frame is the correct branding.
        if (record.poster === undefined) {
          const posterFile = posterNameFor(name)
          const ok = await extractPoster({ input: path.join(filesDir(), name), output: path.join(filesDir(), posterFile) })
          if (ok) record.posterFile = posterFile
        }
        stored.push(record)
      }
    } catch (error) {
      await removeEntryFiles({ videos: stored } as StoredEntry)
      throw error
    }
    if (stored.length === 0) throw new Error('没有可保存的视频内容')
    const entry: StoredEntry = {
      id: input.id,
      createdAt: input.createdAt,
      mode: input.mode,
      model: input.model,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      seconds: input.seconds,
      videos: stored,
      ...input.refName === undefined ? {} : { refName: input.refName },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
      ...input.plan === undefined ? {} : { plan: input.plan },
      ...input.renderer === undefined ? {} : { renderer: input.renderer },
    }
    const merged = [entry, ...await readIndex()]
    const kept = merged.slice(0, VIDEO_HISTORY_MAX)
    for (const dropped of merged.slice(VIDEO_HISTORY_MAX)) await removeEntryFiles(dropped)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Remove one entry (and its clip files). */
export async function removeVideoHistory(id: string): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    if (target !== undefined) await removeEntryFiles(target)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Remove every entry (and all clip files). */
export async function clearVideoHistory(): Promise<VideoHistoryEntry[]> {
  return mutateVideos(async () => {
    const previous = await readIndex()
    for (const entry of previous) await removeEntryFiles(entry)
    await writeIndex([])
    return []
  })
}

/**
 * Read one stored clip by its (validated) file name.
 *
 * The pattern is exactly what this store writes — `<id>-<index>.<ext>` — so
 * the route can never escape the files directory through `..` or an absolute
 * path, and `size` is returned so the route can answer Range requests.
 *
 * A second, independent branch accepts the extracted poster
 * (`<id>-<index>-poster.jpg`). It is a separate alternation rather than an
 * optional group in the first one so the clip pattern stays as strict as it
 * was: a poster still cannot be named `<id>-poster.jpg`, cannot use another
 * index than its clip's, and still cannot carry a path.
 */
export async function readVideoFile(file: string): Promise<{ path: string; size: number; mime: string } | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$/.test(file)
    && !/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+-poster\.(jpg|jpeg)$/.test(file)) return undefined
  const absolute = path.join(filesDir(), file)
  try {
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return undefined
    return { path: absolute, size: stat.size, mime: mimeOfFile(file) }
  } catch {
    return undefined
  }
}

/**
 * Clip file names whose poster extraction already failed.
 *
 * Without this, head-of-line blocking is guaranteed rather than merely
 * possible: `pending` takes the first {@link BACKFILL_BATCH} entries that lack
 * a poster, so if the newest few clips are corrupt (or the machine lost its
 * ffmpeg, or the file was deleted but the index row remains) those entries sit
 * at the front of every call, fail again, and `filled` stays 0 — so the index
 * is never rewritten, and every healthy clip behind them never gets a poster.
 * Remembering the failure breaks that cycle at the cost of one retry.
 *
 * Keyed by clip file name, so it survives a repointed data directory without
 * needing any cleanup: a removed clip simply stops matching anything.
 */
const posterFailures = new Set<string>()

/**
 * Fill in posters for entries saved before posters existed. Idempotent.
 *
 * Two reasons this is not just "run it at startup": the data directory is
 * repointed at resolve time (`setImageDataRoot`), so at startup there is no
 * known history to fix; and the user may never open the history panel at all,
 * in which case ffmpeg should never be spawned on their behalf.
 *
 * Bounded to {@link BACKFILL_BATCH} entries per call so one batch cannot hold
 * the mutation queue for long. That alone would leave a backlog behind on a
 * machine where no further request ever arrives, which is why
 * {@link drainVideoPosters} exists: it repeats this until the backlog is gone.
 *
 * @returns how many entries gained a poster in this call.
 */
export async function backfillVideoPosters(): Promise<number> {
  const outcome = await backfillVideoPostersDetailed()
  return outcome.filled
}

/**
 * {@link backfillVideoPosters} with the two numbers a caller actually needs to
 * decide whether the backlog is gone.
 *
 * `filled` alone cannot answer that question, and the failure is not
 * theoretical: if the newest three clips are all unreadable, the first batch
 * selects exactly those three, fails all three, fills nothing — and a loop
 * keyed on `filled > 0` stops there, leaving every healthy clip behind them
 * coverless forever. `attempted` distinguishes "nothing left to try" (real
 * fixed point) from "this batch happened to select only unfillable entries"
 * (progress was made: each failure is remembered, so the next batch selects
 * different entries).
 *
 * Kept separate from {@link backfillVideoPosters} rather than widening its
 * return type: that function is part of the plugin's exported surface
 * (src/index.ts) and is used as a plain counter, and changing its signature
 * would break that contract for no gain.
 */
async function backfillVideoPostersDetailed(): Promise<{ filled: number; attempted: number }> {
  return mutateVideos(async () => {
    const entries = await readIndex()
    // Oldest-first among the missing ones is irrelevant here (the index is
    // newest-first), so take the first few: those are the most recent clips,
    // which are the ones the user is most likely to be looking at. Entries
    // whose extraction already failed are skipped — see `posterFailures`.
    const pending = entries
      .filter(entry => entry.videos.some(video => video.poster === undefined && video.posterFile === undefined && !posterFailures.has(video.file)))
      .slice(0, BACKFILL_BATCH)
    let filled = 0
    // Counts clips this batch actually ran ffmpeg on — including the ones that
    // failed, because a failure is what shrinks the set of candidates.
    let attempted = 0
    for (const entry of pending) {
      // One poster per entry: the first clip is the representative one, and
      // multi-clip entries are rare enough that the rest would be noise.
      const target = entry.videos.find(video => video.poster === undefined && video.posterFile === undefined && !posterFailures.has(video.file))
      if (target === undefined) continue
      const posterFile = posterNameFor(target.file)
      const ok = await extractPoster({
        input: path.join(filesDir(), target.file),
        output: path.join(filesDir(), posterFile),
      })
      attempted++
      if (!ok) {
        // Remember it, or this entry blocks everything behind it forever.
        posterFailures.add(target.file)
        continue
      }
      // The name was tried and succeeded: forget any earlier failure, in case
      // a future entry reuses this exact file name.
      posterFailures.delete(target.file)
      target.posterFile = posterFile
      filled++
    }
    // Only rewrite the index when something actually changed: a call that
    // found nothing to do should leave the file (and its mtime) alone.
    if (filled > 0) await writeIndex(entries)
    return { filled, attempted }
  })
}

/**
 * The in-flight drain, if any, so repeated requests share one run.
 *
 * `undefined` means "nothing is draining right now"; a promise means "a drain
 * is running (or just finished, until the next call)". Holding the finished
 * promise until the next call is what makes the dedup work: a request that
 * arrives while a drain is still walking the backlog joins that run instead of
 * queueing a second one behind it.
 */
let drain: Promise<void> | undefined

/**
 * Drain the whole poster backlog, one {@link BACKFILL_BATCH} at a time.
 *
 * {@link backfillVideoPosters} on its own is not enough, and the reason is
 * measured rather than theoretical: the panel's `initialDataRequestedRef`
 * (src/client/ImageGenPanel.tsx:919) only lets `loadInitialData()` through once
 * per component lifetime, and opening/closing the panel re-renders without
 * unmounting, so the ref never resets. "The next request picks up the rest"
 * therefore never happens — a restart with 10 old clips would fill 3 and leave
 * 7 permanently coverless.
 *
 * Convergence is by `attempted`, not by `filled`: a batch that ran ffmpeg at
 * all necessarily shrank the candidate set (every failure is remembered by
 * `posterFailures`, every success removed a row), so `attempted === 0` —
 * nothing selected at all — is the only real fixed point. Keying on `filled`
 * instead would stop early in exactly the case that matters: a batch whose
 * three slots were all taken by unreadable clips filled nothing, yet the
 * healthy clips behind them were never touched.
 *
 * Serialization is inherited, not added: every batch goes through
 * `mutateVideos()`, so a drain never spawns two ffmpegs at once and never races
 * a concurrent `appendVideoHistory` — it merely takes its turn. The cost is
 * that an append arriving mid-drain waits for the current batch (~130ms per
 * clip), which is why the caller must still not await this.
 */
export function drainVideoPosters(): Promise<void> {
  drain ??= (async () => {
    try {
      // `attempted === 0` and not `filled === 0`: see above. A batch of three
      // unreadable clips reports attempted=3/filled=0, and the drain must keep
      // going to reach the clips behind them.
      while ((await backfillVideoPostersDetailed()).attempted > 0) { /* keep going */ }
    } finally {
      // Clear even on rejection, or one failure would wedge the module and no
      // later request could ever retry.
      drain = undefined
    }
  })()
  return drain
}

// ---------------------------------------------------------------- in-flight renders
//
// Why a separate file instead of a column on `index.json`: that index is the
// finished-clip history. It is capped (`VIDEO_HISTORY_MAX`), evicted oldest
// first, and scanned by the poster backfill, so an in-flight render parked
// there would be trimmed away by retention rules that know nothing about it —
// and the user would lose the one record that can reattach a paid render
// (#10-1). This file is written at submit and deleted at the terminal state, so
// it normally holds zero or one row per running task.

/** One in-flight render, enough to reattach after a restart. */
export interface PendingVideoTask {
  /** The local queue id, so a restored record can be matched to the panel row. */
  localTaskId: string
  /** The provider's own task id: the only thing that reattaches the render. */
  remoteTaskId: string
  /**
   * When the submit succeeded. The poll deadline is counted from here, not from
   * the restart: a render that has already been running for 30 minutes must not
   * get a fresh 40-minute budget (comemoe's ceiling), and a resumed task that
   * already exceeded it still gets one poll so a finished clip is not thrown
   * away.
   */
  submittedAt: number
  /** Channel that owns the credentials, and its name for the failure copy. */
  channelId?: string
  channelName: string
  /** Protocol family: drives the status URL and the poll cadence. */
  family: string
  /** The alias the user picked (what the panel and the history record). */
  modelAlias: string
  /** The upstream id actually submitted. */
  upstream: string
  /**
   * The request summary that survives a restart.
   *
   * Reference frames are deliberately absent: they are base64 data URLs that
   * would push this index into megabytes, and they are not needed to resume —
   * polling and downloading only need the task id. The booleans are kept so the
   * error copy can still say which mode failed.
   */
  request: {
    mode: VideoMode
    aspectRatio: string
    resolution: string
    seconds: number
    /** Truncated: the panel shows it, nobody sends it anywhere on resume. */
    prompt: string
    refName?: string
    hasImage: boolean
    hasImages: number
    hasFirstFrame: boolean
    hasLastFrame: boolean
  }
}

/** Cap on the prompt kept in the pending index; keeps the file in the KB range. */
const PENDING_PROMPT_MAX = 400

function pendingPath(): string { return path.join(videoRoot(), `${PENDING_INDEX_NAME}.json`) }
const PENDING_INDEX_NAME = 'pending-tasks'

/**
 * The remote task ids of renders still in flight in THIS process.
 *
 * Maintained in memory because the queue needs it synchronously: `cancel()` is
 * synchronous by contract (two callers await `runtime.videoQueue.cancel(id)` as
 * a plain value), so it cannot await a file read just to learn which remote task
 * the user is trying to stop.
 */
const inflightRemote = new Map<string, string>()

/** The remote task id of one in-flight local task, when the submit already landed. */
export function remoteTaskIdOf(localTaskId: string): string | undefined {
  return inflightRemote.get(localTaskId)
}

/** Writes to the pending index are serialized: one shared file, read-modify-write. */
let pendingIndexMutation: Promise<void> = Promise.resolve()

function mutatePending<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingIndexMutation.then(operation, operation)
  pendingIndexMutation = next.then(() => undefined, () => undefined)
  return next
}

/** Structural guard for one stored in-flight record. */
function isPendingTask(value: unknown): value is PendingVideoTask {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.localTaskId === 'string'
    && typeof record.remoteTaskId === 'string'
    && typeof record.submittedAt === 'number'
    && typeof record.family === 'string'
    && typeof record.modelAlias === 'string'
    && record.request !== null
    && typeof record.request === 'object'
}

/**
 * Read the in-flight index, quarantining a corrupt file instead of ignoring it.
 *
 * Three states, deliberately distinct: the file is absent (nothing was running,
 * the normal case after a clean exit); the file parses (resume it); the file is
 * unreadable JSON or the wrong shape (a paid render may be sitting behind it, so
 * the bytes are preserved as `.corrupt-<ts>` and the caller is told, rather than
 * a silent `[]` that would look identical to "nothing was running").
 *
 * @returns the readable rows plus the reason the file was quarantined, if it was.
 */
export async function readPendingVideoTasks(): Promise<{ tasks: PendingVideoTask[]; corrupt?: string }> {
  let raw: string
  try {
    raw = await fs.readFile(pendingPath(), 'utf8')
  } catch {
    // Missing file is the healthy "nothing was in flight" state.
    return { tasks: [] }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const rows = (parsed as { tasks?: unknown })?.tasks
    if (!Array.isArray(rows)) throw new Error('pending-tasks.json has no tasks array')
    return { tasks: rows.filter(isPendingTask) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const quarantine = `${pendingPath()}.corrupt-${Date.now()}`
    try { await fs.rename(pendingPath(), quarantine) } catch { /* the reason still travels */ }
    return { tasks: [], corrupt: `${reason}（原文件已保留为 ${path.basename(quarantine)}）` }
  }
}

/**
 * Record one in-flight render so a restart can reattach it.
 *
 * Called by the engine after the submit returns a task id. A failure here must
 * never fail the render — the money is already spent, and the clip is still
 * downloadable in this process — so the caller swallows the rejection; the
 * absent row only costs the restart guarantee.
 */
export async function writePendingVideoTask(entry: PendingVideoTask): Promise<void> {
  inflightRemote.set(entry.localTaskId, entry.remoteTaskId)
  await mutatePending(async () => {
    await fs.mkdir(videoRoot(), { recursive: true })
    const current = await readPendingVideoTasks()
    const prompt = entry.request.prompt.length > PENDING_PROMPT_MAX
      ? `${entry.request.prompt.slice(0, PENDING_PROMPT_MAX)}…`
      : entry.request.prompt
    const record: PendingVideoTask = { ...entry, request: { ...entry.request, prompt } }
    const kept = [record, ...current.tasks.filter(task => task.localTaskId !== entry.localTaskId)]
    const tmp = `${pendingPath()}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, tasks: kept }), 'utf8')
    await fs.rename(tmp, pendingPath())
  })
}

/** Drop one in-flight record once its render reached a terminal state. */
export async function removePendingVideoTask(localTaskId: string): Promise<void> {
  inflightRemote.delete(localTaskId)
  await mutatePending(async () => {
    const current = await readPendingVideoTasks()
    if (current.tasks.length === 0) return
    const kept = current.tasks.filter(task => task.localTaskId !== localTaskId)
    if (kept.length === current.tasks.length) return
    await fs.mkdir(videoRoot(), { recursive: true })
    const tmp = `${pendingPath()}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, tasks: kept }), 'utf8')
    await fs.rename(tmp, pendingPath())
  })
}

/**
 * Abandon any drain that is still walking a data directory we no longer use.
 *
 * `setImageDataRoot()` repoints every subsequent read and write, so a drain
 * started under the old root would keep extracting into (and indexing) a
 * directory the user has left behind. The drain cannot be interrupted
 * mid-batch, so this waits for the batch it is in to finish and then lets the
 * loop exit on its own: `backfillVideoPosters` re-reads the index each batch,
 * and the new root's index has nothing to drain.
 */
export async function resetVideoStore(): Promise<void> {
  if (drain !== undefined) {
    // Swallow: the caller is wiping the store, and a drain that fails half way
    // (it may be writing into a directory that is about to be emptied) is not
    // the caller's problem.
    await drain.catch(() => { /* the store is being reset anyway */ })
  }
  const previous = await readIndex()
  for (const entry of previous) await removeEntryFiles(entry)
  await writeIndex([])
}

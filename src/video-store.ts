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
 * Framework-free (node:fs only) so the route layer can drive it directly.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VIDEO_API, type VideoDirectorPlan, type VideoHistoryEntry, type VideoHistoryEntryInput, type VideoMode } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'

/** Cap on retained video entries (clips are large: keep the list short). */
export const VIDEO_HISTORY_MAX = 30

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
  poster?: string
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
    default: return 'video/mp4'
  }
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
    try { await fs.rm(path.join(filesDir(), video.file), { force: true }) } catch { /* ignore */ }
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
      ...video.revisedPrompt === undefined ? {} : { revisedPrompt: video.revisedPrompt },
    })),
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.plan === undefined ? {} : { plan: entry.plan },
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
        stored.push({
          file: name,
          mime: file.mime,
          ...file.duration === undefined ? {} : { duration: file.duration },
          ...file.poster === undefined ? {} : { poster: file.poster },
          ...file.revisedPrompt === undefined ? {} : { revisedPrompt: file.revisedPrompt },
        })
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
 */
export async function readVideoFile(file: string): Promise<{ path: string; size: number; mime: string } | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$/.test(file)) return undefined
  const absolute = path.join(filesDir(), file)
  try {
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return undefined
    return { path: absolute, size: stat.size, mime: mimeOfFile(file) }
  } catch {
    return undefined
  }
}

/** Remove every stored clip (used when the data path is repointed). */
export async function resetVideoStore(): Promise<void> {
  const previous = await readIndex()
  for (const entry of previous) await removeEntryFiles(entry)
  await writeIndex([])
}

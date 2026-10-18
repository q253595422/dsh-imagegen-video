/**
 * Host-persisted gallery (user-curated favorites): mirrors the history store
 * (image files + an index.json under ~/.dsh/dsh-imagegen/gallery/) but with no
 * size cap — every entry is an explicit user choice. Appends are deduplicated
 * by image content so adding the same generated image twice is a no-op.
 *
 * Removal is a SOFT delete: the entry is flagged with `deletedAt` and moved to
 * the trash for `GALLERY_TRASH_RETENTION_MS`, while its files stay exactly
 * where they are. History rows, canvas nodes and open lightboxes hold URLs that
 * point straight at those files — unlinking them on delete would turn every
 * existing reference into a broken image, and restoring would hand back an
 * empty card. `restoreGallery` clears the flag; `purgeGallery` (and the
 * retention sweep) is the only thing that actually unlinks.
 *
 * Framework-free (node:fs + node:crypto only) so the route layer can drive it
 * directly.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { GALLERY_API, type HistoryEntry, type HistoryEntryInput, type StoredEntryMode } from './protocol.ts'

/** Prefix route serving one favorited clip. */
const GALLERY_VIDEO_FILE_ROUTE = GALLERY_API.videoFile
import { notifyImageSaved } from './storage-sync.ts'
import { imageDataRoot } from './image-storage-path.ts'

function historyDir(): string { return imageDataRoot() }
function galleryDir(): string { return path.join(imageDataRoot(), 'gallery') }
function indexPath(): string { return path.join(galleryDir(), 'index.json') }
function imagesDir(): string { return path.join(galleryDir(), 'images') }
function videosDir(): string { return path.join(galleryDir(), 'videos') }

/** How long a soft-deleted entry stays recoverable. */
export const GALLERY_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** One gallery entry carries the same wire shape as a history entry. */
export interface GalleryAppendResult {
  /** The full gallery list after the append (newest first). */
  entries: HistoryEntry[]
  /** Whether a new entry was added (false = a content-identical image was
   *  already in the gallery, so the append was skipped). */
  added: boolean
}

// Gallery mutations read and replace one shared index. Serialize them so
// overlapping requests cannot each read an old index and lose the other's row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateGallery<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** One image's on-disk record (file name + mime, never base64). */
interface StoredImage {
  file: string
  mime: string
  revisedPrompt?: string
}

/** One entry's on-disk record. `hash` fingerprints the first image so the
 *  store can refuse duplicate appends cheaply. */
interface StoredEntry {
  id: string
  createdAt: number
  mode: StoredEntryMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: StoredImage[]
  /** Favorited clip, stored as a copied file in gallery/videos/. */
  video?: StoredVideo
  hash?: string
  refName?: string
  tags?: string[]
  channelId?: string
  channel?: string
  workflow?: 'ecommerce'
  projectId?: string
  projectName?: string
  slotKey?: string
  slotLabel?: string
  canvas?: HistoryEntryInput['canvas']
  /** Set when the entry sits in the trash (soft delete). Absent = live.
   *  Written by newer hosts only, so a manifest from an older version simply
   *  reads back as all-live — no migration step is needed. */
  deletedAt?: number
}

/** One favorited clip's on-disk record. */
interface StoredVideo {
  file: string
  mime: string
  duration?: number
}

/** The index.json shape. */
interface IndexFile {
  entries: StoredEntry[]
}

/** File extension for a MIME type (image file names). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** File extension for a video MIME type. */
function videoExtensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim().toLowerCase()) {
    case 'video/webm': return 'webm'
    case 'video/quicktime': return 'mov'
    case 'video/x-matroska': return 'mkv'
    default: return 'mp4'
  }
}

/** MIME type for a stored clip file name. */
function videoMimeOfFile(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.mkv': return 'video/x-matroska'
    default: return 'video/mp4'
  }
}

/** MIME type for a stored image file name (image route responses). */
function mimeOfFile(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

/** Sanitize an entry id for use as a file-name prefix. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-')
  return cleaned === '' ? 'entry' : cleaned
}

/** Short content fingerprint of the entry's first image. */
function fingerprint(input: HistoryEntryInput): string | undefined {
  const first = input.images[0]
  if (first === undefined) return undefined
  return createHash('sha1').update(first.b64).digest('hex')
}

/** Ensure the storage directories exist. */
async function ensureDirs(): Promise<void> {
  await fs.mkdir(imagesDir(), { recursive: true })
  await fs.mkdir(videosDir(), { recursive: true })
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
    && (entry.mode === 'text' || entry.mode === 'edit' || entry.mode === 'video')
    && (entry.deletedAt === undefined || typeof entry.deletedAt === 'number')
    && (entry.workflow === undefined || entry.workflow === 'ecommerce')
    && (entry.projectId === undefined || typeof entry.projectId === 'string')
    && (entry.projectName === undefined || typeof entry.projectName === 'string')
    && (entry.slotKey === undefined || typeof entry.slotKey === 'string')
    && (entry.slotLabel === undefined || typeof entry.slotLabel === 'string')
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.images)
    && entry.images.every(image => {
      if (image === null || typeof image !== 'object') return false
      const record = image as Record<string, unknown>
      return typeof record.file === 'string' && typeof record.mime === 'string'
    })
}

/** Remove one entry's image files (best effort). */
async function removeEntryFiles(entry: StoredEntry): Promise<void> {
  for (const image of entry.images) {
    try { await fs.rm(path.join(imagesDir(), image.file), { force: true }) } catch { /* ignore */ }
  }
  if (entry.video !== undefined) {
    try { await fs.rm(path.join(videosDir(), entry.video.file), { force: true }) } catch { /* ignore */ }
  }
}

/** Project a stored entry onto the wire shape (image URLs). */
function toWire(entry: StoredEntry): HistoryEntry {
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
    images: entry.images.map(image => ({
      url: `/api/dsh-imagegen/gallery/image/${image.file}`,
      mime: image.mime,
      ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
    })),
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.tags === undefined ? {} : { tags: entry.tags },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
    ...entry.workflow === undefined ? {} : { workflow: entry.workflow },
    ...entry.projectId === undefined ? {} : { projectId: entry.projectId },
    ...entry.projectName === undefined ? {} : { projectName: entry.projectName },
    ...entry.slotKey === undefined ? {} : { slotKey: entry.slotKey },
    ...entry.slotLabel === undefined ? {} : { slotLabel: entry.slotLabel },
    ...entry.canvas === undefined ? {} : { canvas: entry.canvas },
    ...entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt },
    ...entry.video === undefined ? {} : {
      video: {
        url: `${GALLERY_VIDEO_FILE_ROUTE}/${entry.video.file}`,
        mime: entry.video.mime,
        ...entry.video.duration === undefined ? {} : { duration: entry.video.duration },
      },
    },
  }
}

/** Whether an entry is still part of the visible gallery (not in the trash). */
function isLiveEntry(entry: StoredEntry): boolean {
  return entry.deletedAt === undefined
}

/**
 * Unlink every trashed entry that is past the retention window.
 *
 * Called from inside `mutateGallery` only: it reads and rewrites the shared
 * index, so it must already hold the mutation queue. A fresh process gets its
 * cleanup for free on the first store call (list counts), which is the lazy
 * "next start" behaviour — no timer, nothing to shut down.
 */
async function purgeExpiredLocked(): Promise<void> {
  const entries = await readIndex()
  const now = Date.now()
  const expired = entries.filter(entry => entry.deletedAt !== undefined && now - entry.deletedAt >= GALLERY_TRASH_RETENTION_MS)
  if (expired.length === 0) return
  for (const entry of expired) await removeEntryFiles(entry)
  const expiredIds = new Set(expired.map(entry => entry.id))
  await writeIndex(entries.filter(entry => !expiredIds.has(entry.id)))
}

/** List the persisted gallery (live entries only), newest first, as wire entries. */
export async function listGallery(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    return entries.filter(isLiveEntry).map(toWire)
  })
}

/** List the trash (soft-deleted entries), newest deletion first. */
export async function listGalleryTrash(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    return entries
      .filter(entry => !isLiveEntry(entry))
      .sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
      .map(toWire)
  })
}

/** Append one image to the gallery. Deduplicates by first-image content —
 *  appending an image already in the gallery returns `added: false` with the
 *  list unchanged. No size cap: every entry is an explicit user choice. */
export async function appendGallery(input: HistoryEntryInput): Promise<GalleryAppendResult> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    await ensureDirs()
    const hash = fingerprint(input)
    if (hash !== undefined) {
      const existing = await readIndex()
      // Trashed entries do not block a re-add: the user removed that copy, so
      // adding the same image again must produce a visible entry.
      if (existing.some(entry => entry.hash === hash && isLiveEntry(entry))) {
        return { entries: existing.map(toWire), added: false }
      }
    }
    const prefix = safeId(input.id)
    const storedImages: StoredImage[] = []
    try {
      for (let index = 0; index < input.images.length; index++) {
        const image = input.images[index]!
        const file = `${prefix}-${index}.${extensionOf(image.mime)}`
        await fs.writeFile(path.join(imagesDir(), file), Buffer.from(image.b64, 'base64'))
        notifyImageSaved('gallery', path.join(imagesDir(), file))
        storedImages.push({
          file,
          mime: image.mime,
          ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
        })
      }
    } catch (error) {
      await removeEntryFiles({ images: storedImages } as StoredEntry)
      throw error
    }
    const entry: StoredEntry = {
      id: input.id,
      createdAt: input.createdAt,
      mode: input.mode,
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      detail: input.detail,
      n: input.n,
      images: storedImages,
      ...hash === undefined ? {} : { hash },
      ...input.refName === undefined ? {} : { refName: input.refName },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
      ...input.workflow === undefined ? {} : { workflow: input.workflow },
      ...input.projectId === undefined ? {} : { projectId: input.projectId },
      ...input.projectName === undefined ? {} : { projectName: input.projectName },
      ...input.slotKey === undefined ? {} : { slotKey: input.slotKey },
      ...input.slotLabel === undefined ? {} : { slotLabel: input.slotLabel },
      ...input.canvas === undefined ? {} : { canvas: input.canvas },
    }
    const merged = [entry, ...await readIndex()]
    await writeIndex(merged)
    return { entries: merged.map(toWire), added: true }
  })
}

/**
 * Move one entry to the trash (soft delete).
 *
 * The files are deliberately NOT unlinked: they stay readable through the
 * existing image/clip routes for the whole retention window, so `restore`
 * returns the real picture and every URL already held elsewhere keeps working.
 * Returns the full list (live + trash) — the route layer splits it.
 */
export async function removeGallery(id: string): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    const target = entries.find(entry => entry.id === id)
    if (target !== undefined && isLiveEntry(target)) target.deletedAt = Date.now()
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/**
 * Bring one trashed entry back into the gallery.
 *
 * Only the flag changes: tags, channel snapshot, canvas lineage and the
 * original `createdAt` were never touched, so the entry returns to its old
 * position in every sort.
 */
export async function restoreGallery(id: string): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    const target = entries.find(entry => entry.id === id)
    if (target !== undefined) delete target.deletedAt
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/**
 * Empty the trash: permanently delete every trashed entry and its files.
 *
 * This is the only unconditional unlink in the store — it backs the explicit
 * "empty trash" action, which the client guards with a confirmation.
 */
export async function purgeGallery(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    const trashed = entries.filter(entry => !isLiveEntry(entry))
    for (const entry of trashed) await removeEntryFiles(entry)
    const kept = entries.filter(isLiveEntry)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Replace the user-managed labels for one gallery entry. */
export async function updateGalleryTags(id: string, tags: string[]): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const normalized = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 20)
    const entries = await readIndex()
    const target = entries.find(entry => entry.id === id)
    if (target !== undefined) target.tags = normalized
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/**
 * Move every live entry to the trash.
 *
 * "Clear the gallery" used to unlink everything on the spot; under soft delete
 * it is the bulk form of `removeGallery`, so the whole cleared gallery is
 * recoverable for the retention window and only `purgeGallery` really deletes.
 */
export async function clearGallery(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    const entries = await readIndex()
    const now = Date.now()
    for (const entry of entries) if (isLiveEntry(entry)) entry.deletedAt = now
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/** Read one stored image file by its (validated) file name. */
/**
 * Favorite one finished clip.
 *
 * The bytes are COPIED out of the video store rather than referenced: the video
 * history is capped (oldest clips are evicted), so a reference would silently
 * rot. Copying is the same tradeoff the image path already makes, and it keeps
 * a favorite durable without the client ever sending video bytes.
 */
export async function appendGalleryVideo(input: {
  id: string
  createdAt: number
  model: string
  prompt: string
  aspectRatio: string
  seconds: number
  /** Absolute path of the source clip inside the video store. */
  sourcePath: string
  mime: string
  duration?: number
  tags?: string[]
  channelId?: string
  channel?: string
}): Promise<GalleryAppendResult> {
  return mutateGallery(async () => {
    await purgeExpiredLocked()
    await ensureDirs()
    const file = `${safeId(input.id)}-0.${videoExtensionOf(input.mime)}`
    const target = path.join(videosDir(), file)
    await fs.copyFile(input.sourcePath, target)
    const entry: StoredEntry = {
      id: input.id,
      createdAt: input.createdAt,
      mode: 'video',
      model: input.model,
      prompt: input.prompt,
      size: input.aspectRatio,
      quality: '',
      detail: '',
      n: 1,
      images: [],
      video: {
        file,
        mime: input.mime,
        ...input.duration === undefined ? {} : { duration: input.duration },
      },
      ...input.tags === undefined ? {} : { tags: input.tags },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
    }
    const merged = [entry, ...await readIndex()]
    await writeIndex(merged)
    return { entries: merged.map(toWire), added: true }
  })
}

/**
 * Read one favorited clip by name.
 *
 * The name pattern is exactly what this store writes, so the route can never
 * escape the videos directory; `size` supports Range responses (seeking).
 */
export async function readGalleryVideo(file: string): Promise<{ path: string; size: number; mime: string } | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$/.test(file)) return undefined
  const absolute = path.join(videosDir(), file)
  try {
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return undefined
    return { path: absolute, size: stat.size, mime: videoMimeOfFile(file) }
  } catch {
    return undefined
  }
}

export async function readGalleryImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  // Only accept <id>-<index>.<png|jpg|jpeg|webp|gif> — the exact names this
  // store writes — so the route can never escape the images directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return undefined
  try {
    const data = await fs.readFile(path.join(imagesDir(), file))
    return { data, mime: mimeOfFile(file) }
  } catch {
    return undefined
  }
}

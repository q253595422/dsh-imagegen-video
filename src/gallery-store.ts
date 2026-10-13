/**
 * Host-persisted gallery (user-curated favorites): mirrors the history store
 * (image files + an index.json under ~/.dsh/dsh-imagegen/gallery/) but with no
 * size cap — every entry is an explicit user choice. Appends are deduplicated
 * by image content so adding the same generated image twice is a no-op.
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
    ...entry.video === undefined ? {} : {
      video: {
        url: `${GALLERY_VIDEO_FILE_ROUTE}/${entry.video.file}`,
        mime: entry.video.mime,
        ...entry.video.duration === undefined ? {} : { duration: entry.video.duration },
      },
    },
  }
}

/** List the persisted gallery, newest first, as wire entries. */
export async function listGallery(): Promise<HistoryEntry[]> {
  const entries = await readIndex()
  return entries.map(toWire)
}

/** Append one image to the gallery. Deduplicates by first-image content —
 *  appending an image already in the gallery returns `added: false` with the
 *  list unchanged. No size cap: every entry is an explicit user choice. */
export async function appendGallery(input: HistoryEntryInput): Promise<GalleryAppendResult> {
  return mutateGallery(async () => {
    await ensureDirs()
    const hash = fingerprint(input)
    if (hash !== undefined) {
      const existing = await readIndex()
      if (existing.some(entry => entry.hash === hash)) {
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

/** Remove one entry (and its image files). */
export async function removeGallery(id: string): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    if (target !== undefined) await removeEntryFiles(target)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Replace the user-managed labels for one gallery entry. */
export async function updateGalleryTags(id: string, tags: string[]): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const normalized = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 20)
    const entries = await readIndex()
    const target = entries.find(entry => entry.id === id)
    if (target !== undefined) target.tags = normalized
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/** Remove every entry (and all image files). */
export async function clearGallery(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const previous = await readIndex()
    for (const entry of previous) await removeEntryFiles(entry)
    await writeIndex([])
    return []
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

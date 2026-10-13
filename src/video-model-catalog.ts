/**
 * Video model catalog: protocol-family detection and capability annotation for
 * the async video side of the plugin. Mirrors `model-catalog.ts`, but for the
 * submit/poll video contract rather than the synchronous image one.
 *
 * Families differ in far more than a URL path:
 *  - `agnes`      : POST /v1/videos → poll GET /v1/videos/{id} → metadata.url
 *  - `comemoe`    : POST /v1/videos → poll GET /v1/videos/{id} → flat top-level url
 *  - `openai-video`: best-effort OpenAI-style video endpoint
 *
 * Framework-free (pure data + regex), safe for the client bundle to inline.
 */

import type { ModelMapping, VideoModelFamily, VideoMode, VideoResolution } from './protocol.ts'

/** Capability/identity annotation for one video model id. */
export interface VideoCatalogEntry {
  /** Family the request is shaped for. */
  family: VideoModelFamily
  /** Short badge label (zh). */
  labelZh: string
  /** Short badge label (en). */
  label: string
  /** Whether the family is known (false = best-effort generic protocol). */
  known: boolean
  /** Video modes this family accepts. */
  modes: VideoMode[]
  /** Resolution tiers this family understands. */
  resolutions: VideoResolution[]
  /** Aspect ratios this family accepts (empty = send whatever the panel has). */
  aspectRatios: string[]
  /** Whether the family accepts a deterministic seed. */
  supportsSeed: boolean
  /** Whether the family requires at least one reference image in image mode. */
  requiresReference: boolean
}

/** Families whose request shape we know, keyed by family id. */
const ENTRIES: Record<Exclude<VideoModelFamily, 'unknown'>, Omit<VideoCatalogEntry, 'family'>> = {
  agnes: {
    label: 'agnes',
    labelZh: 'Agnes 视频',
    known: true,
    modes: ['text', 'image', 'keyframe', 'reference'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsSeed: true,
    requiresReference: false,
  },
  comemoe: {
    label: 'comemoe',
    labelZh: '算力萌',
    known: true,
    // zhimeng-h3-local takes a single image_url; wan2.2-t2v is text-only.
    // Both are narrowed per model id in `describeVideoModel`.
    modes: ['text', 'image'],
    resolutions: ['720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsSeed: false,
    requiresReference: false,
  },
  'openai-video': {
    label: 'openai-video',
    labelZh: '通用视频',
    known: true,
    modes: ['text', 'image'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: [],
    supportsSeed: false,
    requiresReference: false,
  },
}

/** comemoe model ids (they do not start with a vendor prefix). */
const COMEMOE_VIDEO_MODELS = new Set(['wan2.2-t2v', 'zhimeng-h3-local'])

/** Whether a model id belongs to the comemoe (算力萌) video family. */
export function isComemoeVideoModel(model: string): boolean {
  const id = model.trim()
  return COMEMOE_VIDEO_MODELS.has(id) || /^comemoe[-_/]/i.test(id)
}

/** Classify one upstream video model id into its request-shaping family. */
export function describeVideoModel(model: string): VideoCatalogEntry {
  const id = model.trim()
  if (id === '') return unknownEntry()
  if (/^agnes-video/i.test(id)) return { family: 'agnes', ...ENTRIES.agnes }
  if (isComemoeVideoModel(id)) {
    const base = ENTRIES.comemoe
    // `wan2.2-t2v` is text-only; the rest accept one reference image.
    return id === 'wan2.2-t2v' || /t2v/i.test(id)
      ? { family: 'comemoe', ...base, modes: ['text'] }
      : { family: 'comemoe', ...base }
  }
  // A well-known generic-video naming convention: anything that is clearly a
  // video model but not one of the families above still gets the generic
  // shape, flagged as known-but-generic so the UI can warn without blocking.
  if (isLikelyVideoModelId(id)) return { family: 'openai-video', ...ENTRIES['openai-video'] }
  return unknownEntry()
}

/** Most permissive classification for a model the user explicitly configured. */
function unknownEntry(): VideoCatalogEntry {
  return {
    family: 'unknown',
    label: 'unknown',
    labelZh: '未知协议',
    known: false,
    modes: ['text'],
    resolutions: ['720P'],
    aspectRatios: [],
    supportsSeed: false,
    requiresReference: false,
  }
}

/** The family a video model id routes its request through. */
export function videoModelFamily(model: string): VideoModelFamily {
  return describeVideoModel(model).family
}

/** Conservative fallback for providers whose /models response only has ids. */
export function isLikelyVideoModelId(model: string): boolean {
  return /(?:^|[-_.])(?:video|t2v|i2v|motion|animate|sora|veo|kling|runway|pika|luma|haiper|wan2|minimax-h3|seedance)(?:$|[-_.])/i.test(model.trim())
}

/** Default video model ids offered when a channel has no video catalog yet. */
export const DEFAULT_VIDEO_MODELS = ['agnes-video-2.5-flash', 'agnes-video-2.5'] as const

/** Normalize a user-entered video model list, dropping blanks and duplicates. */
export function normalizeVideoModels(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : []
  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const model = candidate.trim()
    if (model !== '') unique.add(model)
  }
  return [...unique]
}

/** Normalize a channel's video catalog (alias → upstream id), blanks dropped. */
export function normalizeVideoCatalog(value: unknown): ModelMapping[] {
  if (!Array.isArray(value)) return []
  const rows: ModelMapping[] = []
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue
    const raw = candidate as Record<string, unknown>
    const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
    if (alias === '') continue
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : alias
    rows.push({ alias, id })
  }
  return [...new Map(rows.map(row => [row.alias, row])).values()]
}

/** Clamp a requested duration into what the family accepts. */
export function clampVideoSeconds(seconds: number): number {
  const rounded = Math.round(seconds)
  if (!Number.isFinite(rounded) || rounded <= 0) return 5
  return Math.min(30, Math.max(1, rounded))
}

/** Clamp one resolution to what the family understands. */
export function normalizeVideoResolution(model: string, resolution: string): VideoResolution {
  const entry = describeVideoModel(model)
  const wanted = resolution.trim().toUpperCase()
  const hit = entry.resolutions.find(row => row === wanted)
  if (hit !== undefined) return hit
  return entry.resolutions[0] ?? '720P'
}

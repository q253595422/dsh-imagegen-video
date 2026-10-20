/**
 * Video model catalog: protocol-family detection and capability annotation for
 * the async video side of the plugin. Mirrors `model-catalog.ts`, but for the
 * submit/poll video contract rather than the synchronous image one.
 *
 * Families differ in far more than a URL path:
 *  - `agnes`      : POST /v1/videos → poll GET /v1/videos/{id} → metadata.url
 *  - `comemoe`    : POST /v1/videos → poll GET /v1/videos/{id} → flat top-level url
 *  - `xai`        : POST /v1/videos/generations → poll GET /v1/videos/{id} → video.url
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
  // Volcengine Ark's own task contract: POST /contents/generations/tasks with a
  // `content` array, poll GET /contents/generations/tasks/{id}, and the finished
  // clip at `content.video_url`. Durations are 4-15s on 2.x and 2-12s on 1.0,
  // resolutions are lowercase 480p/720p/1080p.
  seedance: {
    label: 'seedance',
    labelZh: '火山 Seedance',
    known: true,
    // `reference` (multi-image) exists on 2.x only; narrowed per model id below.
    modes: ['text', 'image', 'keyframe'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsSeed: true,
    requiresReference: false,
  },
  // xAI's own contract, verified against docs.x.ai/developers/rest-api-reference:
  // submit returns `request_id`, the poll carries `video.url` / `video.duration`.
  xai: {
    label: 'xAI Grok',
    labelZh: 'xAI Grok',
    known: true,
    // Reference frames are accepted by the API, but the panel's keyframe and
    // reference modes need a shape this engine has not measured yet; offering
    // them would produce a body the provider rejects.
    modes: ['text', 'image'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
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

/**
 * Whether a model id is Volcengine Ark's Seedance video contract.
 *
 * Both the official ids (`doubao-seedance-2-0-260128`) and the shorter gateway
 * aliases (`seedance-2-0`) are accepted: the family is decided by the request
 * SHAPE, and both spellings mean the same `/contents/generations/tasks` body.
 */
export function isArkSeedanceVideoModel(model: string): boolean {
  return /^(?:doubao-)?seedance(?:[-_.]|$)/i.test(model.trim())
}

/** Classify one upstream video model id into its request-shaping family. */
export function describeVideoModel(model: string): VideoCatalogEntry {
  const id = model.trim()
  if (id === '') return unknownEntry()
  if (/^agnes-video/i.test(id)) return { family: 'agnes', ...ENTRIES.agnes }
  // Before the generic `isLikelyVideoModelId` branch: `grok-imagine-video-*`
  // matches that regex too, and the generic family posts to `/videos`, which
  // xAI answers with 404 (it serves `/videos/generations`).
  if (/^grok-imagine-video/i.test(id)) return { family: 'xai', ...ENTRIES.xai }
  if (isArkSeedanceVideoModel(id)) {
    // `reference` takes several reference images, which Seedance 2.x supports
    // and 1.0 does not. Offering it on a 1.0 id would send a body the provider
    // rejects, so the panel is narrowed here instead.
    // The fast / mini ids also cap at 720p upstream: a 1080P pick on one of
    // those is a guaranteed 400, so the tier list is narrowed to match.
    const base = ENTRIES.seedance
    const seedance2 = /seedance[-_.]?2/i.test(id)
    // `doubao-seedance-2-0-fast-260128` carries a minor version between the
    // major and the tier word, so a bare `2-fast` pattern never matches.
    const light = /seedance[-_.]?2(?:[-_.]\d+)*[-_.](?:fast|mini)/i.test(id)
    const resolutions: VideoResolution[] = light ? ['480P', '720P'] : [...base.resolutions]
    // 1.0 pro fast supports text-to-video and a single first frame only: the
    // docs list `last_frame` for 1.0 pro and explicitly not for the fast id, so
    // offering keyframe mode there would produce a body the provider rejects.
    const proFast = /seedance[-_.]?1[-_.]?\d+[-_.]?pro[-_.]?fast/i.test(id)
    const modes: VideoMode[] = proFast ? ['text', 'image'] : [...base.modes]
    return seedance2
      ? { family: 'seedance', ...base, resolutions, modes: [...modes, 'reference'] }
      : { family: 'seedance', ...base, resolutions, modes }
  }
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

/**
 * The upstream id a channel alias actually resolves to.
 *
 * Capability checks (modes, resolutions, family) must describe the id the
 * provider RECEIVES, not the alias the user typed: a channel can map
 * `seedance-hd` → `doubao-seedance-2-0-fast-260128`, and only the latter is
 * capped at 720p. Describing the alias would offer a tier the id rejects.
 *
 * Falls back to the alias itself when no channel maps it (a request built
 * outside the panel, or a catalog edited after selection).
 */
export function resolveVideoModelId(
  alias: string,
  channels: ReadonlyArray<{ videoModels?: ReadonlyArray<{ alias: string; id?: string }> }> | undefined,
): string {
  const wanted = alias.trim()
  if (wanted === '') return ''
  for (const channel of channels ?? []) {
    for (const row of channel.videoModels ?? []) {
      if (row.alias !== wanted) continue
      const upstream = (row.id ?? '').trim()
      return upstream === '' ? wanted : upstream
    }
  }
  return wanted
}

/** Clamp a requested duration into what the family accepts. */
export function clampVideoSeconds(seconds: number): number {
  const rounded = Math.round(seconds)
  if (!Number.isFinite(rounded) || rounded <= 0) return 5
  return Math.min(30, Math.max(1, rounded))
}

/** Ordered clarity tiers, lowest first. */
const RESOLUTION_RANK: readonly VideoResolution[] = ['480P', '720P', '1080P']

/**
 * Clamp one resolution to what the family understands.
 *
 * A model whose tier list was narrowed (Seedance fast/mini cap at 720p) must
 * degrade a too-high request to the best tier it does support — falling back
 * to the FIRST entry would turn a 1080P ask into 480P and quietly throw away
 * most of the picture. Requests below the supported floor still snap up to it.
 */
export function normalizeVideoResolution(model: string, resolution: string): VideoResolution {
  const entry = describeVideoModel(model)
  const wanted = resolution.trim().toUpperCase()
  const hit = entry.resolutions.find(row => row === wanted)
  if (hit !== undefined) return hit
  const ceiling = RESOLUTION_RANK.indexOf(wanted as VideoResolution)
  if (ceiling >= 0) {
    const below = entry.resolutions.filter(row => RESOLUTION_RANK.indexOf(row) <= ceiling)
    if (below.length > 0) {
      return below.reduce((best, row) => (RESOLUTION_RANK.indexOf(row) > RESOLUTION_RANK.indexOf(best) ? row : best))
    }
    const above = entry.resolutions.filter(row => RESOLUTION_RANK.indexOf(row) > ceiling)
    if (above.length > 0) {
      return above.reduce((best, row) => (RESOLUTION_RANK.indexOf(row) < RESOLUTION_RANK.indexOf(best) ? row : best))
    }
  }
  return entry.resolutions[0] ?? '720P'
}

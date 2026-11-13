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
import { VIDEO_DURATIONS } from './protocol.ts'

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
  /**
   * Concrete durations (seconds) the family accepts, when its wire values are
   * not the panel's default list. Empty/omitted = the panel's VIDEO_DURATIONS.
   */
  durations?: number[]
  /** Display label per aspect value, when the wire word is not human readable. */
  aspectLabels?: Record<string, string>
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
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
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
  // Muse's own video contract on an upstream that speaks `/v1/videos`: the
  // body is {model, prompt, duration, resolution, aspect_ratio, image} -- note
  // `duration` as a NUMBER and lowercase resolutions, and note that `seconds`
  // and `size` are REJECTED ("invalid Muse video parameters; supported fields:
  // ..."). Any extra field fails the submit outright, so this family must not
  // fall through to the generic body. Measured: 720p/1080p accepted (480p and
  // any uppercase tier are not), aspect_ratio 16:9|9:16|1:1 only.
  muse: {
    label: 'muse',
    labelZh: 'Muse 视频',
    known: true,
    modes: ['text', 'image'],
    resolutions: ['720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsSeed: false,
    requiresReference: false,
  },
  // snapgen.ai is not an OpenAI-compatible endpoint: the submit is a multipart
  // POST behind a hand-rolled anti-bot guard header, it answers with a history
  // uuid instead of a task id, progress is a NUMERIC status on GET /history/{id}
  // (1 = running, 2 = finished, 3 = failed), and images are minted per request
  // through a Cloudflare Turnstile widget. `snapgen-engine.ts` owns all of it.
  // Duration and aspect vocabularies differ per model, so they are narrowed
  // per id in `describeVideoModel`.
  snapgen: {
    label: 'snapgen',
    labelZh: 'snapgen.ai',
    known: true,
    modes: ['text', 'image'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [6, 10, 15],
    supportsSeed: false,
    requiresReference: false,
  },
  // Nbility's MiniMax-H3 contract (nbility.ai/docs/api/videos/minimax-h3):
  // `POST /v1/videos` with a `content` array -- exactly one text item plus
  // 0-12 media items, each carrying a `role` -- polled at `GET /v1/videos/{id}`,
  // clip at the completed body's `url`. Output is fixed at 768P (720P/1080P are
  // a 400), duration is a 1..15 integer, ratio is the six standard values, and
  // `adaptive` additionally needs a visual input.
  //
  // The reason this is a family of its own rather than the generic shape:
  // every reference must be a PUBLIC HTTPS URL. The host only ever holds data
  // URLs, so a reference has to be uploaded to `POST /v1/media/uploads` first
  // and swapped for the returned (one-hour) URL with its role attached.
  minimax: {
    label: 'minimax',
    labelZh: 'MiniMax 视频',
    known: true,
    // `reference` rides a different role (`reference_image`) from `image`
    // (`first_frame`); both are wired. `keyframe` maps to first_frame +
    // last_frame, which the upstream allows one each of.
    modes: ['text', 'image', 'keyframe', 'reference'],
    resolutions: ['768P'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    supportsSeed: false,
    requiresReference: false,
  },
}

/**
 * snapgen.ai video ids this plugin can drive.
 *
 * Spelled out here rather than imported from `snapgen-engine.ts`: that module
 * pulls in node:crypto, and this catalog is inlined into the browser bundle.
 * The ids are the contract between the two, so they are also asserted by the
 * smoke test.
 */
const SNAPGEN_VIDEO_MODELS = new Set([
  'grok-video',
  'grok-lower',
  'grok-1.5-lite',
  'muse-ai-video',
  'vela-ai-video',
])

/** Whether a model id belongs to the snapgen.ai video family. */
export function isSnapgenVideoModel(model: string): boolean {
  return SNAPGEN_VIDEO_MODELS.has(model.trim())
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
  if (/^agnes-video/i.test(id)) {
    const base = ENTRIES.agnes
    // `agnes-video-2.5-flash` is documented as 720P-only: any other `size` is
    // rejected with `400 size must be 720P` BEFORE the task is created. Narrow
    // the tier list so the panel cannot offer a 1080P pick that is guaranteed
    // to fail; non-flash ids keep the full range.
    return /flash/i.test(id)
      ? { family: 'agnes', ...base, resolutions: ['720P'] }
      : { family: 'agnes', ...base }
  }
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
  // snapgen.ai: one family, five ids with different wire vocabularies. The guard
  // is the model LIST, not a prefix, so an unrelated `*-video` id still falls
  // through to the generic branch below.
  if (isSnapgenVideoModel(id)) {
    const base = ENTRIES.snapgen
    if (id === 'muse-ai-video') {
      // Muse takes no resolution at all and fixes the clip at ten seconds.
      return { family: 'snapgen', ...base, modes: ['text', 'image'], resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'], durations: [10] }
    }
    if (id === 'vela-ai-video') {
      // Vela is the five-second one; it is also the only id that needs no
      // Turnstile token, which the engine handles per endpoint.
      return { family: 'snapgen', ...base, modes: ['text', 'image'], resolutions: [], aspectRatios: ['16:9', '9:16', '1:1'], durations: [5] }
    }
    // The grok ids all take 6/10/15 seconds. `grok-video` alone reaches 4k,
    // which the panel has no tier for, so 1080P is the top it can offer.
    // The grok ids take the same `files` field, but whether the grok endpoints
    // honour it was never measured: the free daily cap was already spent.
    return { family: 'snapgen', ...base, modes: ['text'], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'], durations: [6, 10, 15] }
  }
  // Muse's own contract, matched EXACTLY: a bare `muse` prefix would also
  // capture snapgen's `muse-ai-video`, which is a completely different endpoint
  // and body (see above). Muse ids beyond `muse-video` are unmeasured, so they
  // stay on the generic branch where the failure is at least readable.
  if (/^muse-video$/i.test(id)) return { family: 'muse', ...ENTRIES.muse }
  // MiniMax-H3 through the Nbility gateway, matched by id: the gateway serves
  // other vendors' ids on the same `/v1/videos` path, and only this one speaks
  // the `content` array with per-item roles.
  //
  // Two capabilities are narrowed from the family default:
  //  - resolution: measured against api.nbility.ai, 720P and 1080P are both
  //    answered with 400 `MiniMax-H3 supports only 768P at normalizeRequest`.
  //    The upstream also takes `adaptive`, which needs a visual input to be
  //    meaningful, so it is not offered as a tier.
  //  - reference images: capped at 9 by the contract (the generic panel allows
  //    four; the cap is enforced when the body is built).
  // Durations are the upstream's real 1..15 seconds; the panel's 5/10 steps are
  // both inside that range, so the default list is kept.
  if (/^minimax[-_.]?h3(?:$|[-_.])/i.test(id)) {
    return {
      family: 'minimax',
      ...ENTRIES.minimax,
      label: 'MiniMax-H3',
      labelZh: 'MiniMax H3',
    }
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


/**
 * Durations one catalog entry offers, in seconds.
 *
 * Families whose wire values are not the panel's own list (snapgen speaks
 * 6/10/15, muse only 10, vela only 5) declare them on the entry; everything
 * else falls back to the shared list, so the pickers stay single-sourced here
 * instead of each rendering its own hardcoded copy.
 */
export function durationsOf(entry: VideoCatalogEntry): number[] {
  return entry.durations !== undefined && entry.durations.length > 0 ? [...entry.durations] : [...VIDEO_DURATIONS]
}

/** Durations the given model id offers (alias resolved by the caller). */
export function videoDurationsFor(model: string): number[] {
  return durationsOf(describeVideoModel(model))
}

/** Clamp a requested duration into what the family accepts. */
export function clampVideoSeconds(seconds: number): number {
  const rounded = Math.round(seconds)
  if (!Number.isFinite(rounded) || rounded <= 0) return 5
  return Math.min(30, Math.max(1, rounded))
}

/**
 * Ordered clarity tiers, lowest first.
 *
 * `768P` sits between 720P and 1080P: it is a real tier, not an alias, and it
 * must rank below 1080P so a model that only takes 768P degrades a 1080P ask
 * to it (and never up from 480P past a tier the caller asked for).
 */
const RESOLUTION_RANK: readonly VideoResolution[] = ['480P', '720P', '768P', '1080P']

/** Every tier the plugin can name on the wire, lowest first. */
export const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ['480P', '720P', '768P', '1080P']

/**
 * Read one resolution off an untrusted request body.
 *
 * The route handlers used to spell the three old tiers out inline, which meant
 * a new tier had to be added in four places and silently became 720P if one was
 * missed. Parsing is centralised here: an unknown word still falls back to the
 * default (the request is never sent with a tier the panel cannot display), but
 * every tier the plugin understands is accepted as written.
 */
export function parseVideoResolution(value: unknown, fallback: VideoResolution = '720P'): VideoResolution {
  if (typeof value !== 'string') return fallback
  const wanted = value.trim().toUpperCase()
  return VIDEO_RESOLUTIONS.find(row => row === wanted) ?? fallback
}

/**
 * Position of one tier in `RESOLUTION_RANK`, or -1 for a word we do not know.
 *
 * Exported so the planner compares tiers with the same order the panel sorts
 * them by: two private copies of the list drifted apart the moment a tier was
 * added, and the drift showed up as a plan that "raised" quality.
 */
export function resolutionRank(resolution: string): number {
  return RESOLUTION_RANK.indexOf(resolution.trim().toUpperCase() as VideoResolution)
}

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

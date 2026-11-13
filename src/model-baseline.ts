/**
 * Built-in model baseline: the one table that says which protocol family an
 * upstream model id belongs to and whether that id is still worth offering.
 *
 * Why this file exists, and why it is data rather than code:
 *
 *   Upstream image/video model ids are replaced on a monthly cadence, not a
 *   yearly one. When that happened before, the only way to fix a wrong
 *   classification was to edit the `describeModel` If-chain and ship a release
 *   anyway — so the chain grew a new branch per family, and every new id
 *   landed in `unknown` until somebody noticed.
 *
 *   Keeping the facts in a table means a stale id is a one-line edit here,
 *   reviewable in isolation from the request-shaping logic that reads it.
 *
 * Deliberate limits of what goes in this table:
 *
 *  1. **No scheduled shutdown dates.** They are the most volatile fact on the
 *     page and the one we cannot verify from the build environment, and a
 *     wrong date is worse than no date: it either talks a user out of a model
 *     that still works or promises support that already ended. `lifecycle`
 *     records only what has actually happened, with `source` naming where it
 *     was observed.
 *  2. **No pricing.** Prices change without a version bump and a stale number
 *     is indistinguishable from a correct one.
 *  3. **Nothing here blocks a request.** A retired id is a notice in the UI,
 *     never a refusal: the user may be pointed at a gateway that still serves
 *     it, and this plugin shapes requests per protocol family rather than
 *     owning the model catalogue upstream.
 *
 * Framework-free (pure data), safe for the client bundle to inline.
 */

/** Protocol family a request is shaped for. */
export type ModelFamily =
  | 'gpt-image'
  | 'dall-e'
  | 'grok'
  | 'nanobanana'
  | 'seedream'
  | 'agnes'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'unknown'

/** Whether an id is still the one to reach for. */
export type ModelLifecycle = 'active' | 'deprecated' | 'removed'

/** One exact upstream model id and what we know about it. */
export interface ModelBaselineEntry {
  /** Upstream id as written by the provider, lowercased, without a vendor
   *  prefix (`google/gemini-3-pro-image` is stored as `gemini-3-pro-image`). */
  id: string
  /** Request-shaping family. */
  family: Exclude<ModelFamily, 'unknown'>
  /** Where the id sits in its life. Absent means `active` — the common case,
   *  kept out of the data so an ordinary model costs one line, not four. */
  lifecycle?: ModelLifecycle
  /** Id to suggest instead, when this one is deprecated or removed. */
  replacement?: string
  /** Where the lifecycle claim came from, so the next person can re-check it
   *  rather than trust it. Required whenever `lifecycle` is set. */
  source?: string
}

/** Exact-id table. Lookups try this before any pattern, so a family whose
 *  naming convention changes can be pinned to the right entry without
 *  loosening a regex that other ids also match.
 *
 *  Vendor-prefixed ids from aggregator gateways (`google/…`, `openai/…`,
 *  `anthropic/…`) are stored here WITHOUT the prefix; `normalizeModelId`
 *  strips it before the lookup. */
export const MODEL_BASELINE: readonly ModelBaselineEntry[] = [
  // ---- OpenAI image -------------------------------------------------------
  // gpt-image-2.6 is the line that still takes GIF output; 2.5 and 2 remain
  // usable stills. `chatgpt-image-latest` is deliberately absent: it is a
  // moving alias, and pinning a lifecycle to an alias that upstream repoints
  // would mark whatever it resolves to today as fixed.
  { id: 'gpt-image-2.6-sunburst', family: 'gpt-image' },
  { id: 'gpt-image-2.6-flare', family: 'gpt-image' },
  { id: 'gpt-image-2.5-sunburst', family: 'gpt-image' },
  { id: 'gpt-image-2.5-flare', family: 'gpt-image' },
  { id: 'gpt-image-2.5', family: 'gpt-image' },
  { id: 'gpt-image-2', family: 'gpt-image' },

  // ---- Google -------------------------------------------------------------
  // These are served through the same Gemini image endpoint the plugin calls
  // under the `nanobanana` family, which is why they classify there and not as
  // a separate family.
  { id: 'gemini-3-pro-image', family: 'nanobanana' },
  { id: 'gemini-3-pro-image-preview', family: 'nanobanana' },
  { id: 'gemini-3.1-flash-image', family: 'nanobanana' },
  { id: 'gemini-3.1-flash-image-preview', family: 'nanobanana' },
  { id: 'gemini-3.1-flash-lite-image', family: 'nanobanana' },
  { id: 'gemini-2.5-flash-image', family: 'nanobanana' },
  { id: 'gemini-nano-banana-2.1', family: 'nanobanana' },

  // ---- Seedream -----------------------------------------------------------
  { id: 'seedream-5.5', family: 'seedream' },
  { id: 'seedream-5.0-pro', family: 'seedream' },
  { id: 'seedream-5.0', family: 'seedream' },
  { id: 'seedream-4.0', family: 'seedream' },

  // ---- Qwen ---------------------------------------------------------------
  { id: 'qwen-image-3.0-pro', family: 'qwen' },
  { id: 'qwen-image-3.0', family: 'qwen' },
]

/** Index built once at module load: a linear scan per describe() call would
 *  run on every keystroke in the model picker. */
const BY_ID = new Map<string, ModelBaselineEntry>(
  MODEL_BASELINE.map(entry => [entry.id, entry]),
)

/**
 * Strip the vendor prefix aggregator gateways put in front of a model id.
 *
 * `openrouter`, `one-api`, `new-api` and most resellers address models as
 * `vendor/model` (`google/gemini-3-pro-image`, `openai/gpt-image-2.5`). The
 * prefix names who publishes the model, not how to talk to it, and every
 * classifier in this repo keys off the model name — so an unprefixed lookup
 * leaves those ids in `unknown`, where the panel warns about losing reference
 * images and the engine falls back to the generic protocol.
 *
 * Only the first segment is removed, and only when something follows it: an
 * id such as `image-01` has no prefix to lose, and `a/b/c` keeps `b/c` rather
 * than collapsing to `c`.
 *
 * @param model - raw id as configured on the channel.
 * @returns the id with at most one leading `vendor/` segment removed.
 */
export function normalizeModelId(model: string): string {
  const id = model.trim()
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return id
  return id.slice(slash + 1)
}

/** Exact lookup, tolerant of case and a vendor prefix. */
export function baselineEntry(model: string): ModelBaselineEntry | undefined {
  const id = model.trim()
  return BY_ID.get(id.toLowerCase()) ?? BY_ID.get(normalizeModelId(id).toLowerCase())
}

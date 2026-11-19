/**
 * Storyboard state, as pure functions.
 *
 * A storyboard node is a shot list; every shot's clip is an ordinary video node
 * on the canvas. The reason this lives in its own module is that the rule
 * "which shot is done" then has exactly one definition, shared by the node's
 * renderer, the run button's enabled state and the stitch hand-off. If those
 * three each derived it themselves, the node could show a green shot that the
 * run button still calls empty, or hand a failed clip to ffmpeg.
 *
 * Nothing here touches React or the network: the caller passes the document's
 * nodes in, so every function is testable from the smoke suite without a DOM.
 */

import type { CanvasNode, CanvasShot, CanvasStoryboard } from '../protocol.ts'

/** Upper bound on shots per board; the host rejects documents beyond it. */
export const MAX_SHOTS = 40

/**
 * Editorial shot lengths, in seconds.
 *
 * This is the vocabulary the BOARD writes and the default list the composer
 * offers; it is not a claim about what any one model accepts. A shot is one
 * video task, and one task can hold a short beat or a twelve-second paragraph
 * with two cuts inside it — the old five-value list stopped at ten and could not
 * express the second case at all.
 *
 * What the picker actually SHOWS goes through {@link shotSecondsOptions}, which
 * narrows this list to the model's own wire values. Offering a number the
 * provider answers with a 400 is worse than offering fewer numbers.
 */
export const SHOT_SECONDS = [4, 5, 6, 8, 10, 12, 15] as const

/**
 * Seconds the picker should offer for one board.
 *
 * Families disagree on this: snapgen speaks 6 / 10 / 15, muse only 10, vela only
 * 5, and the generic list is 5 / 10. Intersecting keeps our editorial set as the
 * shape and the model's set as the truth.
 *
 * Two fallbacks, both deliberate:
 *  - no declared durations (the model is unknown, or the board names no model
 *    and the channel default decides) — keep our whole list;
 *  - the intersection is empty (a model that only speaks 7) — use the model's
 *    own values sorted, because one valid choice beats a list of invalid ones.
 */
export function shotSecondsOptions(modelDurations?: readonly number[]): number[] {
  const declared = (modelDurations ?? []).filter(value => Number.isFinite(value) && value > 0)
  if (declared.length === 0) return [...SHOT_SECONDS]
  const shared = SHOT_SECONDS.filter(value => declared.includes(value))
  return shared.length > 0 ? shared : [...new Set(declared)].sort((left, right) => left - right)
}

/**
 * Upper bound on identity references one shot may carry.
 *
 * Four is the ceiling the image and video composers already apply; a fifth
 * reference does not make the model more consistent, it dilutes the four that
 * matter and can be rejected outright by the provider.
 */
export const MAX_SHOT_REFERENCES = 4

/** How one shot is actually submitted: which mode, and whether the cast goes with it. */
export interface ShotVideoPlan {
  mode: 'text' | 'keyframe' | 'reference'
  /**
   * How many identity references ride along, in cast order.
   *
   * Zero in `carry` mode on purpose. A keyframe run carries exactly two frames
   * (first / last) and the provider contracts forbid mixing those with
   * `reference_image` entries — so on a carried shot the exact join wins and the
   * pinned identities do not travel. Saying "参考图 1 是她" without the image
   * would be the dishonest option, so the prompt never claims it either.
   */
  castSlots: number
}

/**
 * Decide a shot's mode from the board and the canvas.
 *
 * Pure on purpose: the rule "a pinned character makes a shot a reference run,
 * unless continuity already owns the frame slots" is exactly the sort of thing
 * that drifts when it lives inside a 3 000-line submit handler.
 */
export function shotVideoPlan(input: {
  continuity: CanvasStoryboard['continuity']
  index: number
  castCount: number
}): ShotVideoPlan {
  if (input.continuity === 'carry' && input.index > 0) return { mode: 'keyframe', castSlots: 0 }
  const castSlots = Math.max(0, Math.min(MAX_SHOT_REFERENCES, Math.floor(input.castCount)))
  return castSlots > 0 ? { mode: 'reference', castSlots } : { mode: 'text', castSlots: 0 }
}

/**
 * Shots on this board that will be submitted WITHOUT the pinned identities.
 *
 * WHY the board has to say this out loud: the user pins 「阿禾」 once and expects
 * every shot to look like her. On a `carry` board that expectation is true for
 * the first shot and false for all the rest, because a carried shot spends both
 * its frame slots on the join — and nothing in the picture explains why shot 1
 * has her face and shot 2 does not. Before this, the only way to learn it was to
 * run the board and notice the drift.
 *
 * Returns the indices (0-based) that lose the cast, so the caller can badge the
 * exact rows and the count in the hint matches the rows a user can see. Empty
 * when nobody is pinned (nothing is being lost) or when the board starts every
 * shot independently.
 */
export function shotsWithoutCast(board: CanvasStoryboard, castCount: number): number[] {
  if (castCount <= 0) return []
  const out: number[] = []
  for (let index = 0; index < board.shots.length; index += 1) {
    if (shotVideoPlan({ continuity: board.continuity, index, castCount }).castSlots === 0) out.push(index)
  }
  return out
}

// ------------------------------------------------------------ speech budget

/**
 * Speaking rates the duration rule is built on.
 *
 * 4.5 汉字/秒 is ordinary Mandarin delivery; 2.5 words/second is the same pace in
 * English (~150 wpm). Two seconds are then reserved for the performance itself —
 * a line that fits the clock exactly still needs a breath, an expression and a
 * reaction, and a shot cut to the bare speaking time is the single most common
 * way a generated clip ends up unusable.
 */
export const SPEECH_CJK_PER_SECOND = 4.5
export const SPEECH_WORDS_PER_SECOND = 2.5
export const SPEECH_MARGIN_SECONDS = 2

/**
 * The dialogue inside one shot prompt — the only part worth timing.
 *
 * A shot prompt mixes camera direction with speech ("缓慢推近，她抬头：「你来晚了。」"),
 * and there is no reliable way to tell a line of dialogue from a sentence of
 * stage direction without a convention. The convention is quotation marks:
 * 「…」、『…』、“…” and "…" all count, everything outside them does not. A prompt with
 * no quotes simply has no measurable speech, which is the honest answer rather
 * than a guess that would reject perfectly good visual-only shots.
 */
export function spokenText(prompt: string): string {
  const quoted = prompt.match(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g)
  return quoted === null ? '' : quoted.map(span => span.slice(1, -1)).join('')
}

/**
 * Seconds the given speech needs, before the performance margin.
 *
 * Measured in the script's own terms: every CJK ideograph is one 字 at 4.5/s,
 * and every run of Latin letters or digits is one word at 2.5/s. Punctuation,
 * spaces and stage directions carry no time — a comma is a pause the actor
 * takes inside the margin, not an extra syllable.
 */
export function speechSeconds(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk / SPEECH_CJK_PER_SECOND + words / SPEECH_WORDS_PER_SECOND
}

/** What one shot's dialogue needs, and whether the chosen length pays for it. */
export interface ShotSpeechFit {
  /** Measured speech, in seconds (no margin). */
  speech: number
  /** Shortest length that still leaves the performance margin. */
  required: number
  /** True when `shot.seconds` covers `required`. */
  fits: boolean
  /** The line being measured, empty when the prompt has no quoted speech. */
  line: string
}

/**
 * Whether a shot is long enough for the dialogue written into it.
 *
 * Advisory, not a gate. The board shows this as a hint on the row; the run is
 * never blocked by it, because the measured rate is a rule of thumb and the user
 * may well know that this character speaks fast. Blocking would turn a good
 * default into a wall.
 */
export function shotSpeechFit(shot: CanvasShot): ShotSpeechFit {
  const line = spokenText(shot.prompt)
  if (line === '') return { speech: 0, required: 0, fits: true, line }
  const speech = speechSeconds(line)
  const required = speech + SPEECH_MARGIN_SECONDS
  const seconds = Number.isFinite(shot.seconds) ? shot.seconds : 0
  return { speech, required, fits: seconds + 1e-9 >= required, line }
}

/** Shared defaults a freshly created board starts from. */
export function defaultStoryboard(): CanvasStoryboard {
  return {
    shots: [{ id: 'shot-1', prompt: '', seconds: 5 }],
    aspectRatio: '16:9',
    resolution: '720P',
    continuity: 'cut',
  }
}

/**
 * The board as the renderer should see it, with every optional field filled.
 *
 * Stored documents are deliberately permissive (see `isStoryboard` in
 * canvas-store.ts), so a board read back from disk may lack any single field.
 * Normalizing here rather than at each read site means a document saved by an
 * older build renders as a usable board instead of crashing a node.
 */
export function storyboardOf(node: CanvasNode): CanvasStoryboard {
  const stored = node.metadata?.storyboard
  const fallback = defaultStoryboard()
  if (stored === undefined) return fallback
  return {
    shots: stored.shots.length === 0 ? fallback.shots : stored.shots,
    aspectRatio: stored.aspectRatio === undefined || stored.aspectRatio === '' ? fallback.aspectRatio : stored.aspectRatio,
    resolution: stored.resolution === undefined || stored.resolution === '' ? fallback.resolution : stored.resolution,
    continuity: stored.continuity === 'carry' ? 'carry' : 'cut',
    ...stored.model === undefined || stored.model === '' ? {} : { model: stored.model },
    ...stored.channelId === undefined || stored.channelId === '' ? {} : { channelId: stored.channelId },
    // `source` 必须原样带出来：它是「这块板是从文档铺的」唯一的标记，回写
    // 按钮靠它决定出不出现。这里漏一次，所有板的 `source` 都读成 undefined，
    // 按钮就再也不渲染了。
    ...stored.source === undefined ? {} : { source: stored.source },
  }
}

/** A shot id nothing else in the list uses. */
export function nextShotId(shots: readonly CanvasShot[]): string {
  const used = new Set(shots.map(shot => shot.id))
  for (let index = 1; index <= MAX_SHOTS + 1; index += 1) {
    const id = `shot-${index}`
    if (!used.has(id)) return id
  }
  return `shot-${Date.now().toString(36)}`
}

/** Why this shot cannot run, as a translation key — undefined when it can. */
export function shotProblem(shot: CanvasShot): 'canvas.storyboard.shotEmpty' | 'canvas.storyboard.shotSeconds' | undefined {
  if (shot.prompt.trim() === '') return 'canvas.storyboard.shotEmpty'
  if (!Number.isFinite(shot.seconds) || shot.seconds <= 0) return 'canvas.storyboard.shotSeconds'
  return undefined
}

/** The video node one shot produced, if it is still on the canvas. */
export function shotNodeOf(shot: CanvasShot, nodes: readonly CanvasNode[]): CanvasNode | undefined {
  if (shot.nodeId === undefined) return undefined
  const found = nodes.find(node => node.id === shot.nodeId)
  return found !== undefined && found.type === 'video' ? found : undefined
}

/** What one shot's own clip is doing right now. */
export type ShotState = 'empty' | 'generating' | 'ready' | 'failed'

/**
 * One shot's state, read from its produced node.
 *
 * A shot whose node was deleted is `empty` again: the user removed the clip,
 * and re-running the shot must create a fresh node rather than point at a
 * node that no longer exists. A node with no clip but a recorded failure is
 * `failed`; a node that is merely a placeholder is `generating`, because that
 * is what its own spinner says.
 *
 * `stale` is checked BEFORE "a clip means ready": an invalidated shot still
 * carries its old clip (the file is kept on purpose), so the clip test would
 * otherwise report it finished forever and the broken join would never be
 * offered for a re-run.
 */
export function shotState(shot: CanvasShot, nodes: readonly CanvasNode[]): ShotState {
  const node = shotNodeOf(shot, nodes)
  if (node === undefined) return 'empty'
  if (shot.stale === true) return 'failed'
  const metadata = node.metadata ?? {}
  if ((metadata.video?.url ?? '') !== '') return 'ready'
  if (metadata.status === 'error') return 'failed'
  return 'generating'
}

/** How far along the whole board is. */
export interface StoryboardProgress {
  total: number
  ready: number
  generating: number
  failed: number
  /** Shots with no prompt are not runnable and are counted separately. */
  empty: number
}

export function storyboardProgress(board: CanvasStoryboard, nodes: readonly CanvasNode[]): StoryboardProgress {
  const progress: StoryboardProgress = { total: board.shots.length, ready: 0, generating: 0, failed: 0, empty: 0 }
  for (const shot of board.shots) {
    if (shot.prompt.trim() === '') { progress.empty += 1; continue }
    const state = shotState(shot, nodes)
    if (state === 'ready') progress.ready += 1
    else if (state === 'generating') progress.generating += 1
    else if (state === 'failed') progress.failed += 1
    else progress.empty += 1
  }
  return progress
}

/**
 * The index of the shot a run would submit next.
 *
 * Running a board is deliberately one shot at a time in `carry` mode — the
 * next shot's first frame is this shot's last, so it cannot be planned before
 * the frame exists — and the same rule is used in `cut` mode so one button
 * means one thing in both. `-1` means every runnable shot already has a clip.
 */
export function nextShotIndex(board: CanvasStoryboard, nodes: readonly CanvasNode[]): number {
  for (let index = 0; index < board.shots.length; index += 1) {
    const shot = board.shots[index]!
    if (shot.prompt.trim() === '') continue
    const state = shotState(shot, nodes)
    if (state === 'empty' || state === 'failed') {
      // In `carry` mode this shot's first frame is the previous shot's last
      // one, so a predecessor without a clip means THIS shot cannot be framed
      // yet either: stop here and let the predecessor run first. Returning the
      // index anyway would submit a run the UI has no frame to build.
      if (board.continuity === 'carry' && index > 0) {
        const previous = board.shots[index - 1]!
        const previousState = shotState(previous, nodes)
        if (previous.prompt.trim() !== '' && previousState !== 'ready') return -1
      }
      return index
    }
  }
  return -1
}

/**
 * The clip nodes a stitch should cover, in shot order.
 *
 * Only READY clips are returned: a shot still rendering or one that failed has
 * no bytes to concatenate, and the existing compose path fails the whole run
 * when a listed clip cannot be read. Leaving them out here means the stitch
 * button matches what the user can actually watch, and the caller reports the
 * shortfall rather than silently producing a shorter film.
 *
 * A STALE shot's file is still on disk and still playable, but it is not part
 * of the film any more — it was made from a tail frame that no longer exists,
 * so stitching it would splice in a break the user has already been told about.
 * It must be left out here even though its node has bytes.
 */
export function storyboardClipIds(board: CanvasStoryboard, nodes: readonly CanvasNode[]): string[] {
  return board.shots.flatMap(shot => {
    if (shot.stale === true) return []
    const node = shotNodeOf(shot, nodes)
    return node === undefined || (node.metadata?.video?.url ?? '') === '' ? [] : [node.id]
  })
}

/**
 * The board after shot `index` was re-submitted, with every already-produced
 * shot after it marked stale.
 *
 * This is the fix for the silent break in `carry` continuity: the re-submitted
 * shot gets a new tail frame, so every later shot was framed from a frame that
 * is about to stop existing. They are not deleted — the user may still want to
 * watch those takes — they are invalidated, which makes `shotState` report
 * them `failed` and `nextShotIndex` pick them up again in order.
 *
 * Only shots that actually have a clip are touched: a downstream shot that was
 * never produced has nothing to invalidate, and marking it would put a "this
 * was invalidated" badge on a row the user never ran.
 *
 * The caller only applies this in `carry` mode. In `cut` mode the shots are
 * independent by construction, so re-running one changes nothing about the
 * others and invalidating them would destroy work for no reason.
 */
export function withStaleDownstream(board: CanvasStoryboard, index: number, nodes: readonly CanvasNode[]): CanvasStoryboard {
  if (index < 0 || index >= board.shots.length) return board
  const shots = board.shots.map((shot, position) => {
    if (position <= index || shot.stale === true) return shot
    const node = shotNodeOf(shot, nodes)
    if (node === undefined || (node.metadata?.video?.url ?? '') === '') return shot
    return { ...shot, stale: true }
  })
  return shots.every((shot, position) => shot === board.shots[position]) ? board : { ...board, shots }
}

/** The board after one edit, with the shot list kept consistent. */
export function withShot(board: CanvasStoryboard, index: number, patch: Partial<CanvasShot>): CanvasStoryboard {
  if (index < 0 || index >= board.shots.length) return board
  return {
    ...board,
    shots: board.shots.map((shot, position) => position === index ? { ...shot, ...patch } : shot),
  }
}

/** Append one blank shot, unless the board is already at the cap. */
export function withAppendedShot(board: CanvasStoryboard): CanvasStoryboard {
  if (board.shots.length >= MAX_SHOTS) return board
  return {
    ...board,
    shots: [...board.shots, { id: nextShotId(board.shots), prompt: '', seconds: board.shots.at(-1)?.seconds ?? 5 }],
  }
}

/**
 * Remove one shot. The list never empties: a board with no rows has nothing to
 * type into, so the last removal leaves one blank shot behind.
 */
export function withRemovedShot(board: CanvasStoryboard, index: number): CanvasStoryboard {
  const shots = board.shots.filter((_shot, position) => position !== index)
  return { ...board, shots: shots.length === 0 ? [{ id: nextShotId([]), prompt: '', seconds: 5 }] : shots }
}

/**
 * Move one shot up or down (`delta` -1 / +1), clamped at the ends.
 *
 * Position IS the running order — it is what the stitch reads and what the
 * row numbers show — so this edit is the only way a user reorders the film.
 */
export function withMovedShot(board: CanvasStoryboard, index: number, delta: number): CanvasStoryboard {
  const target = index + delta
  if (index < 0 || index >= board.shots.length || target < 0 || target >= board.shots.length) return board
  const shots = [...board.shots]
  const [moved] = shots.splice(index, 1)
  if (moved === undefined) return board
  shots.splice(target, 0, moved)
  return { ...board, shots }
}

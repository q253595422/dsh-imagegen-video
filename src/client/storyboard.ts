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

/** Shot lengths offered by the composer, matching the video pipeline's own set. */
export const SHOT_SECONDS = [4, 5, 6, 8, 10] as const

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
 */
export function shotState(shot: CanvasShot, nodes: readonly CanvasNode[]): ShotState {
  const node = shotNodeOf(shot, nodes)
  if (node === undefined) return 'empty'
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
 */
export function storyboardClipIds(board: CanvasStoryboard, nodes: readonly CanvasNode[]): string[] {
  return board.shots.flatMap(shot => {
    const node = shotNodeOf(shot, nodes)
    return node === undefined || (node.metadata?.video?.url ?? '') === '' ? [] : [node.id]
  })
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

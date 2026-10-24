/**
 * A+ detail-page layout math.
 *
 * WHY this is its own module: the stitched long image is the one thing in this
 * workspace that has to be provably correct, and "correct" here is arithmetic
 * on y offsets and heights. Keeping it out of the React component means the
 * whole thing is assertable without a canvas (jsdom has none) and the drawing
 * path stays thin enough that the browser test is about pixels, not layout.
 *
 * The contract is deliberately boring:
 *   - blocks are stacked vertically, in the order given;
 *   - the first block starts at y = 0;
 *   - a gap is inserted BETWEEN blocks, never after the last one;
 *   - `height` is the real stitched height even when it exceeds the cap.
 *
 * `overflow` is a refusal signal for the caller, not a clamp. A layout that
 * overflows still reports its true height, so the UI can say how far over it is
 * instead of silently cropping or downscaling the result.
 */

/** One module's assumed frame, used when an image's real size is unknown. */
export interface AplusModuleSpec {
  key: string
  label: string
  /** Width / height. 16/9 for a landscape banner, 0.75 for a portrait shot. */
  aspect: number
}

/** One module's rectangle inside the stitched image. */
export interface AplusBlock {
  key: string
  y: number
  width: number
  height: number
}

export interface AplusLayout {
  blocks: AplusBlock[]
  height: number
  overflow: boolean
}

/**
 * The hard cap above which the export is refused. Chosen well above any real
 * detail page: Chromium refuses to allocate canvases past roughly this order of
 * magnitude, and a silently blank export is worse than a refusal.
 */
export const APLUS_MAX_HEIGHT = 16000

/**
 * Compute the vertical stack.
 *
 * Pure: no DOM, no rounding. Callers that need integer pixels (the canvas
 * backend) round at draw time, so the arithmetic here stays exact and the
 * assertions in the tests can compare against it directly.
 *
 * A module without a usable aspect falls back to a square, which is the least
 * surprising shape when nothing else is known.
 */
export function composeAplusLayout(input: {
  modules: Array<{ key: string; aspect?: number }>
  width: number
  gap: number
}): AplusLayout {
  const width = Number.isFinite(input.width) && input.width > 0 ? input.width : 0
  const gap = Number.isFinite(input.gap) && input.gap > 0 ? input.gap : 0
  const blocks: AplusBlock[] = []
  let y = 0
  for (const module of input.modules) {
    const aspect = module.aspect !== undefined && Number.isFinite(module.aspect) && module.aspect > 0
      ? module.aspect
      : 1
    const height = width / aspect
    blocks.push({ key: module.key, y, width, height })
    y += height
    // A gap separates blocks; there is nothing after the last one to separate
    // from, so it does not participate in the total height.
    if (blocks.length < input.modules.length) y += gap
  }
  const last = blocks.length === 0 ? undefined : blocks[blocks.length - 1]
  const height = last === undefined ? 0 : last.y + last.height
  return { blocks, height, overflow: height > APLUS_MAX_HEIGHT }
}

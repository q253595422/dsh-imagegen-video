/**
 * Clip stitching order — the one rule both halves must agree on.
 *
 * The browser draws ①②③ badges on the selected video nodes and the host builds
 * the ffmpeg concat list. If those two disagreed, the user would see one order
 * in the badges and get a different order in the file, with no way to tell. So
 * the rule lives here, as a pure function with no host or browser imports, and
 * both sides call it.
 *
 * The rule is reading order over the canvas: rows top to bottom, and inside a
 * row left to right.
 */

/** The subset of a canvas node the order depends on. */
export interface PositionedItem {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * How close two top edges must be, as a fraction of the shorter node's height,
 * for the two nodes to be plausibly in the same row. A knob, not a law — but it
 * only has to absorb hand-placed imprecision, so it is deliberately generous.
 */
const ROW_PROXIMITY = 0.5

/**
 * The most a top-edge difference may ever count for, in pixels.
 *
 * Without this ceiling the proximity window scales with the clip's own height,
 * so a tall clip reaches across a gap a short one could not: given a 700px clip
 * with a 240x160 clip to its right, a 700px clip below it, and no overlap
 * anywhere, the window is 350px and swallows the lower clip into the upper row
 * — leaving it to be ordered by x, so a clip sitting entirely above another
 * plays after it. The ceiling is one clip's own footprint (the default video
 * node is 240x160): more than that is a row gap, not raggedness.
 */
const ROW_PROXIMITY_LIMIT = 240

/**
 * The least the proximity window may shrink to, in pixels.
 *
 * The window is a fraction of the *shorter* node, so a clip resized down to the
 * minimum node height (64px) leaves a 32px window — tighter than ordinary
 * hand-placed imprecision, so a 64px clip sitting beside a taller one in the
 * same visual row is thrown onto a row of its own and the taller neighbour is
 * then read first. Flooring at one minimum node height keeps small clips
 * grouped. See {@link sharesRow} for the pairing that exposed it.
 */
const ROW_PROXIMITY_FLOOR = 64

/**
 * How much horizontal overlap, as a fraction of the narrower node's width,
 * means the two nodes may be stacked one under the other rather than side by
 * side. Combined with {@link STACK_OFFSET} it is the guard that keeps a column
 * from collapsing into a single row.
 */
const STACK_OVERLAP = 0.5

/**
 * How far apart the top edges must be, as a fraction of the shorter node's
 * height, before a horizontally-overlapping pair counts as a column.
 *
 * The offset matters as much as the overlap. Overlap alone vetoes clips that sit
 * level with each other and merely share some width — a hand-placed row — and
 * splits it into separate rows, so a clip one pixel lower jumps the queue.
 * Requiring a real vertical offset keeps the row intact while still refusing the
 * column.
 */
const STACK_OFFSET = 0.25

/** Top edge, then left edge, then id — the total order items are walked in. */
function byTopLeft(source: PositionedItem, other: PositionedItem): number {
  if (source.y !== other.y) return source.y - other.y
  if (source.x !== other.x) return source.x - other.x
  return source.id < other.id ? -1 : source.id > other.id ? 1 : 0
}

/** Left edge, then top edge, then id — the total order inside one row. */
function byLeftTop(source: PositionedItem, other: PositionedItem): number {
  if (source.x !== other.x) return source.x - other.x
  if (source.y !== other.y) return source.y - other.y
  return source.id < other.id ? -1 : source.id > other.id ? 1 : 0
}

/** Horizontal overlap of two nodes in pixels; negative when they are apart. */
function horizontalOverlap(source: PositionedItem, other: PositionedItem): number {
  const left = Math.max(source.x, other.x)
  const right = Math.min(source.x + source.width, other.x + other.width)
  return right - left
}

/** Is one node vertically inside the other? */
function nestedWithin(source: PositionedItem, other: PositionedItem): boolean {
  return source.y >= other.y && source.y + source.height <= other.y + other.height
}

/**
 * Do the two nodes sit in the same row?
 *
 * Three conditions, and each is needed.
 *
 * A node nested inside the *vertical* span of another while overlapping it
 * horizontally is part of the same visual group **when its top edge is level
 * with its host's**: a small clip dropped on the top of a tall one reads as one
 * cluster, and pushing it out leaves the small clip to start a row no one drew.
 * This is checked first, because the stacked-pair guard below would otherwise
 * fire on exactly this shape — the small clip overlaps its host's width and its
 * top edges differ.
 *
 * The level-top half of that condition is not decoration. Without it, any clip
 * merely *inside* a tall neighbour is welded to it, so a clip resting at the
 * bottom of a tall host is pulled up to the host's row and jumps ahead of a clip
 * that sits entirely above it to the right — a strict inversion, and a common
 * one: a 240x1000 host produced it in 24% of layouts. With it, the nesting
 * clause only fires on the top-aligned cluster it was written for.
 *
 * A pair that overlaps horizontally by at least {@link STACK_OVERLAP} of the
 * narrower node *and* whose top edges differ by at least {@link STACK_OFFSET} of
 * the shorter node is a column, not a ragged row. Dropping the offset half tears
 * apart clips that sit level and simply share width; dropping the overlap half
 * merges a vertical stack whose neighbours are closer than the window.
 *
 * Otherwise the pair shares a row when their top edges are within
 * {@link ROW_PROXIMITY} of the shorter node's height, floored at
 * {@link ROW_PROXIMITY_FLOOR} and capped at {@link ROW_PROXIMITY_LIMIT} pixels.
 * Comparing centers instead (an earlier attempt) pushes a clip twice the height
 * of its neighbours onto a row of its own, because a tall node's center sinks
 * below the short nodes beside it.
 */
function sharesRow(source: PositionedItem, other: PositionedItem): boolean {
  const offset = Math.abs(source.y - other.y)
  const shorter = Math.min(source.height, other.height)
  const narrower = Math.min(source.width, other.width)
  const overlap = horizontalOverlap(source, other)
  const window = Math.min(
    Math.max(ROW_PROXIMITY * shorter, ROW_PROXIMITY_FLOOR),
    ROW_PROXIMITY_LIMIT,
  )
  if (overlap > 0) {
    const inner = nestedWithin(source, other)
      ? source
      : nestedWithin(other, source)
        ? other
        : undefined
    if (inner !== undefined) {
      const host = inner === source ? other : source
      if (Math.abs(inner.y - host.y) < window) return true
    }
  }
  const stacked =
    overlap >= STACK_OVERLAP * narrower && offset >= STACK_OFFSET * shorter
  if (stacked) return false
  return offset < window
}

/**
 * Sort items into stitch order: top-to-bottom rows, left-to-right within a row.
 *
 * Items are walked in ascending top edge, and each joins the first existing row
 * it shares a row with every member of; if there is no such row it starts a new
 * one. Requiring every member rather than any one of them is what stops a chain
 * of pairwise-overlapping nodes from dragging distant items into the same row.
 * That also makes rows come out in top-edge order without a second sort.
 * Returned array is a new array; input is untouched.
 */
export function orderByPosition<T extends PositionedItem>(items: readonly T[]): T[] {
  const rows: T[][] = []
  for (const item of [...items].sort(byTopLeft)) {
    const row = rows.find(candidate => candidate.every(member => sharesRow(item, member)))
    if (row === undefined) rows.push([item])
    else row.push(item)
  }

  return rows.flatMap(row => [...row].sort(byLeftTop))
}

/**
 * Same order as {@link orderByPosition}, reduced to ids — the shape the host
 * needs to build a concat list and the browser needs to label badges.
 */
export function orderIdsByPosition(items: readonly PositionedItem[]): string[] {
  return orderByPosition(items).map(item => item.id)
}

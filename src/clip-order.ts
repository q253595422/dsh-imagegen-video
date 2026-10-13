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
 * row left to right. Wide nodes overlapping vertically count as one row, which
 * is what makes a hand-arranged strip behave.
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
 * Sort items into stitch order: top-to-bottom rows, left-to-right within a row.
 *
 * Two items share a row when their vertical centers both fall inside the band
 * the row already spans. Returned array is a new array; input is untouched.
 */
export function orderByPosition<T extends PositionedItem>(items: readonly T[]): T[] {
  // Vertical center first so a tall node sitting beside a short one still
  // starts its own row at the right place; `id` keeps ties deterministic.
  const sorted = [...items].sort((a, b) => {
    const center = a.y + a.height / 2 - (b.y + b.height / 2)
    if (center !== 0) return center
    if (a.x !== b.x) return a.x - b.x
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const rows: T[][] = []
  for (const item of sorted) {
    const row = rows[rows.length - 1]
    if (row === undefined) {
      rows.push([item])
      continue
    }
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const member of row) {
      top = Math.min(top, member.y)
      bottom = Math.max(bottom, member.y + member.height)
    }
    const center = item.y + item.height / 2
    if (center > top && center < bottom) {
      row.push(item)
    } else {
      rows.push([item])
    }
  }

  return rows.flatMap(row => row.sort((a, b) => (a.x === b.x ? (a.id < b.id ? -1 : 1) : a.x - b.x)))
}

/**
 * Same order as {@link orderByPosition}, reduced to ids — the shape the host
 * needs to build a concat list and the browser needs to label badges.
 */
export function orderIdsByPosition(items: readonly PositionedItem[]): string[] {
  return orderByPosition(items).map(item => item.id)
}

/**
 * Copy-band typography for the A+ detail page.
 *
 * WHY this is its own module and why `measure` is a parameter: this is the one
 * part of the long image that involves text, and text layout has to be
 * assertable without a canvas. jsdom has no 2d context, and the existing E1
 * assertions mount the workspace under jsdom — a single top-level
 * `measureText` call would break every one of them. So every function that
 * needs text metrics takes them as an argument:
 *
 *   wrapText(measure, text, maxWidth)
 *
 * The caller supplies `measure` (a canvas context, or a fake in a test), and
 * this file stays pure. Nothing at module scope touches the DOM, a canvas, or
 * `measureText`.
 *
 * The spec's constants (BAND_RATIO and friends below) exist because the layout
 * is a contract, not a taste: a band that silently grew past 40% of its block
 * would eat the picture it annotates, and a band that shrank by an unspecified
 * amount could not be reasoned about by anyone reading the export.
 */

/** The copy one module contributes to its band. */
export interface AplusCopy {
  title: string
  body: string
}

export type AplusCopyMap = Record<string, AplusCopy>

/** One laid-out line, ready for `fillText`. */
export interface AplusCopyLine {
  text: string
  /** The CSS font shorthand to assign before painting this line. */
  font: string
  size: number
  bold: boolean
  /** Baseline offset from the top of the band, in px. */
  y: number
}

export interface AplusCopyMeasurement {
  /** Total band height in px, padding included. */
  height: number
  lines: AplusCopyLine[]
  /** The scale actually applied, 1 when the copy fit at full size. */
  scale: number
}

/** A band may never take more than this fraction of its block. */
export const APLUS_BAND_MAX_RATIO = 0.4

/** Step by which type is shrunk before the band gives up. */
export const APLUS_BAND_SCALE_STEP = 0.9

/** Lowest scale the shrink loop may reach. */
export const APLUS_BAND_MIN_SCALE = 0.6

/** Font stack mandated by the spec: system fonts only, nothing downloaded. */
export const APLUS_FONT_STACK = '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'

/** The paper the band is painted on, then the band itself over the picture. */
export const APLUS_BAND_FILL = 'rgba(255,255,255,0.92)'
export const APLUS_BAND_RULE = 'rgba(0,0,0,0.08)'

const TITLE_RATIO = 0.042
const BODY_RATIO = 0.028
const TITLE_LEADING = 1.3
const BODY_LEADING = 1.55
const TITLE_GAP_RATIO = 0.018
const PAD_X_RATIO = 0.06
const PAD_Y_RATIO = 0.035
const TITLE_COLOUR = '#111111'
const BODY_COLOUR = '#333333'

/** A font string in the shorthand `fillText` expects. */
function fontFor(size: number, bold: boolean): string {
  return `${bold ? '700 ' : ''}${size}px ${APLUS_FONT_STACK}`
}

/**
 * Wrap `text` to `maxWidth`.
 *
 * The rule the spec asks for — Latin breaks at spaces, CJK breaks between
 * characters — comes from one observation: for CJK every character is its own
 * word, so "move the whole word down" degenerates into "move one character
 * down". So the loop is word-based, and a word is a maximal run of non-space
 * characters.
 *
 * A single unbreakable run longer than the line (a URL, a long identifier) is
 * hard-cut by character rather than allowed to overflow the canvas.
 *
 * Existing line breaks in the input are honoured, so a user's own paragraphing
 * survives; only wrapping beyond it is ours.
 */
export function wrapText(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return ['']
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    // A word is a maximal run of non-space characters; a run of whitespace
    // collapses, and the single space that joins two words on a line is
    // measured as part of the fit test below rather than accumulated here.
    const words: string[] = []
    let word = ''
    for (const char of paragraph) {
      if (/\s/.test(char)) {
        if (word !== '') { words.push(word); word = '' }
        continue
      }
      word += char
    }
    if (word !== '') words.push(word)

    let line = ''
    let lineWidth = 0
    const emit = (): void => {
      if (line !== '') { out.push(line); line = ''; lineWidth = 0 }
    }
    for (const candidate of words) {
      const candidateWidth = measure(candidate)
      const space = line === '' ? 0 : measure(' ')
      if (line !== '' && lineWidth + space + candidateWidth <= maxWidth) {
        line += ' ' + candidate
        lineWidth += space + candidateWidth
        continue
      }
      // The word does not fit after what is already on the line.
      emit()
      if (candidateWidth <= maxWidth) {
        line = candidate
        lineWidth = candidateWidth
        continue
      }
      // A single unbreakable run wider than the whole line: cut it by
      // character. Nothing may leave the band, so this is not optional.
      let cut = ''
      let cutWidth = 0
      for (const char of candidate) {
        const charWidth = measure(char)
        if (cut !== '' && cutWidth + charWidth > maxWidth) {
          out.push(cut)
          cut = ''
          cutWidth = 0
        }
        cut += char
        cutWidth += charWidth
      }
      if (cut !== '') { line = cut; lineWidth = cutWidth }
    }
    // An empty paragraph is a blank line the user typed; it is kept, unlike a
    // trailing one, which would only inflate the band.
    if (line !== '') out.push(line)
    else if (words.length === 0) out.push('')
  }
  // A trailing empty string would paint a blank line and inflate the band.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.length === 0 ? [''] : out
}

/**
 * The largest band height a block may carry, in px.
 *
 * `measureCopyBlock` does not know the block it belongs to, so it takes the
 * limit as an argument rather than reading `APLUS_BAND_MAX_RATIO` against a
 * height it was never given. This is the one place the ratio is applied.
 */
function maxHeight(blockHeight: number): number {
  return blockHeight * APLUS_BAND_MAX_RATIO
}

/**
 * Lay out one copy band, shrinking the type while it would take more than
 * `APLUS_BAND_MAX_RATIO` of the block.
 *
 * Returns the largest scale that fits. When even `APLUS_BAND_MIN_SCALE` is too
 * big, the full-size measurement is returned unchanged and the caller must
 * refuse the export — `bandHeightFor` reports that as `ok: false`.
 */
export function measureCopyBlock(
  copy: AplusCopy,
  width: number,
  blockHeight: number,
  measure: (text: string, font: string) => number,
): AplusCopyMeasurement {
  const padX = width * PAD_X_RATIO
  const padY = width * PAD_Y_RATIO
  const gap = width * TITLE_GAP_RATIO
  const usable = Math.max(1, width - padX * 2)
  const titleSize = width * TITLE_RATIO
  const bodySize = width * BODY_RATIO

  const build = (scale: number): AplusCopyMeasurement => {
    const tSize = titleSize * scale
    const bSize = bodySize * scale
    const tFont = fontFor(tSize, true)
    const bFont = fontFor(bSize, false)
    const lines: AplusCopyLine[] = []
    let y = padY
    const title = copy.title.trim()
    if (title !== '') {
      for (const text of wrapText(t => measure(t, tFont), title, usable)) {
        lines.push({ text, font: tFont, size: tSize, bold: true, y: y + tSize * TITLE_LEADING })
        y += tSize * TITLE_LEADING
      }
      y += gap * scale
    }
    const body = copy.body
    if (body.trim() !== '') {
      for (const text of wrapText(t => measure(t, bFont), body, usable)) {
        lines.push({ text, font: bFont, size: bSize, bold: false, y: y + bSize * BODY_LEADING })
        y += bSize * BODY_LEADING
      }
    }
    return { height: y + padY, lines, scale }
  }

  // Full size first: the common case must not pay for the shrink loop.
  const full = build(1)
  if (full.height <= maxHeight(blockHeight)) return full
  for (let scale = APLUS_BAND_SCALE_STEP; scale >= APLUS_BAND_MIN_SCALE - 1e-9; scale = +(scale * APLUS_BAND_SCALE_STEP).toFixed(6)) {
    const scaled = build(scale)
    if (scaled.height <= maxHeight(blockHeight)) return scaled
  }
  return full
}

/**
 * Decide whether a measured band is allowed inside its block.
 *
 * `ok` is false when the band would take more than `APLUS_BAND_MAX_RATIO` of
 * the block, which is the caller's signal to refuse the export. `measured` is
 * what `measureCopyBlock` returned, so its `scale` travels with the verdict and
 * a caller that paints anyway paints at the right size.
 */
export function bandHeightFor(blockHeight: number, measured: { height: number; scale: number }): { ok: boolean; scale: number } {
  const limit = blockHeight * APLUS_BAND_MAX_RATIO
  if (measured.height <= limit) return { ok: true, scale: measured.scale }
  return { ok: false, scale: measured.scale }
}

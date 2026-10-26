/**
 * WCAG 2.x relative-luminance contrast, one definition shared by every guard.
 *
 * Two guards need this and each had written its own copy: the studio preview
 * shot measured text against its painted backdrop, and the lightbox check
 * measured chrome against a translucent surface. A second copy is how the two
 * drifted — the older one only understood `rgb(a, b, c)` and silently returned
 * null for the `color(srgb 1 1 1 / 0.72)` form that `color-mix()` produces,
 * which reads as a black-on-black failure that does not exist.
 *
 * WHY a source string as well as live functions: both consumers run this inside
 * `page.evaluate()`, so the code has to travel into the page as TEXT. Rather
 * than maintain a string and a function that must agree, {@link WCAG_CONTRAST_SOURCE}
 * derives the string from these very functions — one definition, two ways to
 * use it.
 *
 * Every function here is deliberately free of regular expressions and
 * backslashes: the source is embedded in a template literal on the way to the
 * page, where a backslash is consumed and an escaped regex silently becomes a
 * different regex. That is a real bug this file exists to stop repeating.
 */

/**
 * Parse a CSS colour into 0-255 channels plus alpha.
 *
 * Understands the two serializations a computed style actually yields:
 * `rgb(r, g, b)` / `rgba(r, g, b, a)`, and `color(srgb r g b / a)` where the
 * channels are 0-1 and alpha follows a slash. Percentages and named colours are
 * not handled — computed values never carry them.
 * @param {string} value - a computed colour string.
 * @returns {{r: number, g: number, b: number, a: number} | null} null when unparseable.
 */
export function parseColour (value) {
  const text = String(value ?? '').trim()
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const body = text.slice(open + 1, close).trim()
  if (body === '') return null

  // `color(srgb r g b / a)`: the body starts with the colour space NAME, then
  // space separated 0-1 channels, then an optional `/ alpha`. Dropping the name
  // is what makes this parse: `parseFloat('srgb')` is NaN, and leaving it in
  // turned the whole colour into null.
  if (text.startsWith('color(')) {
    const slash = body.indexOf('/')
    const channelText = slash < 0 ? body : body.slice(0, slash)
    const alphaText = slash < 0 ? '' : body.slice(slash + 1).trim()
    const tokens = channelText.split(' ').filter(part => part !== '')
    // tokens[0] is the colour space (`srgb`, `display-p3`, …), never a channel.
    const parts = tokens.slice(1).map(part => parseFloat(part))
    if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return null
    const alpha = alphaText === '' ? 1 : parseFloat(alphaText)
    return {
      r: parts[0] * 255,
      g: parts[1] * 255,
      b: parts[2] * 255,
      a: Number.isFinite(alpha) ? alpha : 1,
    }
  }

  // `rgb(r, g, b)` / `rgba(r, g, b, a)`: comma separated, 0-255 channels.
  const parts = body.split(',').map(part => parseFloat(part))
  if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) return null
  const alpha = parts.length > 3 ? parts[3] : 1
  return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(alpha) ? alpha : 1 }
}

/**
 * Paint `top` over `bottom` (source-over).
 *
 * Needed because a translucent surface — a 16%-white pill, a mask overlay —
 * has no contrast of its own until it is blended onto what is behind it.
 * Comparing a translucent colour against text directly reports nonsense.
 * @param {{r: number, g: number, b: number, a: number}} top - the nearer layer.
 * @param {{r: number, g: number, b: number, a: number}} bottom - the layer below.
 * @returns {{r: number, g: number, b: number, a: number}} the composited colour, opaque.
 */
export function composite (top, bottom) {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  }
}

/**
 * WCAG relative luminance of an opaque colour.
 * @param {{r: number, g: number, b: number}} colour - 0-255 channels.
 * @returns {number} luminance in 0-1.
 */
export function relativeLuminance (colour) {
  const channel = value => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b)
}

/**
 * WCAG contrast ratio between two opaque colours.
 * @param {{r: number, g: number, b: number}} a - one colour.
 * @param {{r: number, g: number, b: number}} b - the other colour.
 * @returns {number} ratio from 1 (identical) to 21 (black on white).
 */
export function contrastRatio (a, b) {
  const one = relativeLuminance(a)
  const two = relativeLuminance(b)
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

/**
 * The same four functions as source text, for embedding in `page.evaluate()`.
 *
 * Derived from the definitions above, so the page and Node can never run
 * different maths.
 */
export const WCAG_CONTRAST_SOURCE = [parseColour, composite, relativeLuminance, contrastRatio]
  .map(fn => fn.toString())
  .join('\n')

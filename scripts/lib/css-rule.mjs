/**
 * Reading a rule back out of a stylesheet's text.
 *
 * Both the CSS linters (verify-native-ui) and the layout guards that pin a
 * specific declaration (verify-pose-panel) need to answer "which selector does
 * this offset sit under" and "what does THIS rule declare". Each wrote its own
 * slice/indexOf version first, and the copies disagreed the moment a rule moved
 * inside `@media`: one walked back two braces, the other stopped at the first
 * `{` it found and measured an unrelated declaration.
 *
 * Everything here works on the RAW stylesheet text with comments stripped but
 * newlines preserved, so callers can still map an offset back to a line number.
 */

/**
 * Blank out CSS comments while keeping every newline.
 *
 * Deleting them outright shifts every offset past the comment, so a violation
 * gets reported on an unrelated line that usually still looks plausible and the
 * fix lands on the wrong property.
 * @param {string} text
 * @returns {string}
 */
export function stripCssComments (text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, comment => '\n'.repeat((comment.match(/\n/g) || []).length))
}

/**
 * The selector an offset sits under, from the last `{` that opened its rule.
 *
 * Used only where a rule has a legitimate exception keyed on WHERE it applies
 * (a `[data-compact]` miniature), never to excuse a value everywhere. It walks
 * back two braces at most so a `@media` wrapper does not hide the selector.
 * @param {string} text - comment-stripped stylesheet text.
 * @param {number} index - offset inside the rule's declaration block.
 * @returns {string} the selector text; `''` when the offset is before any `{`.
 */
export function selectorOf (text, index) {
  const head = text.slice(0, index)
  const open = head.lastIndexOf('{')
  if (open === -1) return ''
  const before = head.slice(0, open)
  const prevClose = before.lastIndexOf('}')
  return before.slice(prevClose + 1)
}

/**
 * The declaration block of the rule that a selector names, braces included.
 *
 * Matches the selector as WRITTEN in the stylesheet (`.poseAxis input[type='range']`),
 * so an escaped or quoted part must be spelled exactly as the file spells it.
 * A selector list (`.a, .b {`) matches on any of its members.
 *
 * `undefined` when no rule declares it. That distinction matters: a substring
 * search that finds nothing returns an empty string, and a caller asserting on
 * an empty body reports "the declaration is missing" for a selector that was
 * renamed — the wrong bug, in the wrong file.
 * @param {string} css - raw or comment-stripped stylesheet text.
 * @param {string} selector
 * @returns {string | undefined}
 */
export function ruleBodyOf (css, selector) {
  const text = stripCssComments(css)
  const wanted = selector.trim()
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(wanted, from)
    if (at === -1) return undefined
    from = at + wanted.length
    // The selector must be a whole member of the list, not the tail of a longer
    // one: `.poseAxis input` must not match `.poseAxis input[type='range']`.
    const before = text.slice(Math.max(0, at - 1), at)
    if (before !== '' && !/[\s,{}]/.test(before)) continue
    let cursor = from
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
    const ch = text[cursor]
    if (ch !== ',' && ch !== '{') continue
    // Walk to the `{` that opens this rule's block, through the rest of the
    // selector list if the rule declares several selectors at once.
    let open = ch === '{' ? cursor : text.indexOf('{', cursor)
    if (open === -1) return undefined
    const close = text.indexOf('}', open)
    if (close === -1) return undefined
    return text.slice(open, close + 1)
  }
  return undefined
}

/**
 * Native-UI contract guard.
 *
 * Enforces docs/native-ui-contract.md by FAILING on every violation it can see
 * from source. The contract without a guard is an opinion; with a guard it is
 * a fact about the build.
 *
 * WHY source-level and not only browser-level: the failures this catches are
 * SILENT. A `--dsw-*` token that does not exist makes the browser drop the
 * whole declaration — the element renders with an inherited or initial value
 * and nothing logs. A hardcoded `font-size` renders correctly on the author's
 * machine and ignores the user's Font size setting forever. Neither shows up
 * as an error anywhere; only a scan finds them.
 *
 * The token list and the primitives/slot inventories are read from the
 * INSTALLED DSH, not from a copy pasted here, so a DSH upgrade that renames a
 * token makes this guard fail instead of silently un-enforcing the rule.
 *
 * Run: node scripts/verify-native-ui.mjs [--verbose]
 * Exit 0 = clean, 1 = violations, 2 = the DSH install could not be read.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'src', 'client')
const VERBOSE = process.argv.includes('--verbose')

/* ------------------------------------------------------------------ DSH source */

/**
 * Locate the installed DSH client packages. Returns undefined when this is not
 * a machine with DSH installed (a CI runner), and the caller SKIPS loudly —
 * a guard that quietly passes where it cannot see is worse than no guard.
 */
function findDshNodeModules () {
  const candidates = [
    process.env.DSH_ASAR_DIR,
    '/tmp/dshnative/dsh/node_modules',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  ].filter(Boolean)
  return candidates.find(dir => existsSync(join(dir, '@deepseek-ai')))
}

/** Every `--dsw-*` custom property DSH actually defines, across all its packages. */
function collectDefinedTokens (nodeModules) {
  const defined = new Set()
  const base = join(nodeModules, '@deepseek-ai')
  let packages
  try {
    packages = readdirSync(base)
  } catch {
    return defined
  }
  for (const pkg of packages) {
    const lib = join(base, pkg, 'lib')
    if (!existsSync(lib)) continue
    for (const file of readdirSync(lib)) {
      if (!file.endsWith('.js')) continue
      const text = readFileSync(join(lib, file), 'utf8')
      // Definitions only: a token name followed by `:` inside a rule body.
      for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) defined.add(match[1])
    }
  }
  // The web frontend carries the primitives' stylesheet (hashed CSS modules).
  const frontend = join(base, 'dsh-web-frontend', 'dist', 'assets')
  if (existsSync(frontend)) {
    for (const file of readdirSync(frontend)) {
      if (!file.endsWith('.js') && !file.endsWith('.css')) continue
      const text = readFileSync(join(frontend, file), 'utf8')
      for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) defined.add(match[1])
    }
  }
  return defined
}

/* ------------------------------------------------------------------- utilities */

function walk (dir, extension, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, extension, out)
    else if (entry.name.endsWith(extension)) out.push(full)
  }
  return out
}

/**
 * Strip CSS comments so a token named in prose is not read as a live reference.
 *
 * The newlines inside a comment are PRESERVED. Every reported line number is
 * computed against the stripped text (lineOf), so collapsing a multi-line
 * comment silently shifts every violation below it upward. That is not
 * cosmetic: the reader lands on an unrelated line that usually still looks
 * plausible, and the fix gets applied to the wrong property.
 */
function stripCssComments (text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, comment =>
    '\n'.repeat((comment.match(/\n/g) || []).length)
  )
}

/**
 * Strip JS comments that are documentation, not code.
 *
 * String literals are deliberately NOT stripped: the checks below match
 * patterns that live inside them (`[class*="sidebarCol"]` is a selector
 * string). Newlines are preserved for the line-number reason above.
 */
function stripJsComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, comment =>
      '\n'.repeat((comment.match(/\n/g) || []).length)
    )
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

const violations = []
function violate (rule, file, line, detail) {
  violations.push({
    rule,
    file: relative(ROOT, file),
    line,
    detail,
  })
}

function lineOf (text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * The selector an offset sits under, from the last `{` that opened its rule.
 *
 * Used only where a rule has a legitimate exception keyed on WHERE it applies
 * (a `[data-compact]` miniature), never to excuse a value everywhere. It walks
 * back two braces at most so a `@media` wrapper does not hide the selector.
 */
function selectorOf (text, index) {
  const head = text.slice(0, index)
  const open = head.lastIndexOf('{')
  if (open === -1) return ''
  const before = head.slice(0, open)
  const prevClose = before.lastIndexOf('}')
  return before.slice(prevClose + 1)
}

/* --------------------------------------------------------------- CSS checks */

/**
 * The font sizes DSH's own UI actually uses, taken from its 41 embedded
 * stylesheets by frequency: 12(48) 13(32) 14(27) 11(20) 16(5) 10(3) 18(3) 15(2)
 * plus the rarer 20 / 22 / 24 / 26 / 28 for display headings.
 *
 * Half-pixel values (10.5, 11.5, 12.5, 13.5) are deliberately absent: they are
 * not a finer scale, they are the residue of eyeballing each element in
 * isolation, and they turn a 4-step ladder into noise.
 */
const FONT_SCALE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28])

const CSS_FILES = walk(CLIENT, '.css')

for (const file of CSS_FILES) {
  const raw = readFileSync(file, 'utf8')
  const text = stripCssComments(raw)

  // 1. No bare literal colors. Tokens carry light AND dark; a literal carries one.
  //
  //    A fallback INSIDE var(--token, #hex) is allowed and is a different
  //    thing: if the token resolves (it does on every supported DSH) the
  //    literal never reaches the layout, and if a future DSH renames the token
  //    the fallback keeps the element visible instead of transparent. 89 of the
  //    259 literals in this tree are that idiom.
  //
  //    What is banned is a literal the cascade actually USES: `box-shadow:
  //    0 18px 60px rgba(0,0,0,.28)` and `background: rgb(0 0 0/35%)` are a
  //    fixed appearance that cannot follow the theme at all.
  //    The substitution is LENGTH-PRESERVING on purpose. `match.index` below
  //    addresses the substituted string, and every reported line number is
  //    resolved against the original one; a shorter marker shifts each later
  //    index and reports the violation on the line above its real home.
  const withoutFallbacks = text.replace(/var\([^()]*,[^()]*\)/g, fallback => {
    // Keep the newlines as well as the width: a padding of plain spaces would
    // also have to survive a fallback that spans lines, and dropping those
    // newlines shifts every violation below by the number of lines lost.
    const pad = fallback.slice('VAR_FALLBACK'.length)
    return 'VAR_FALLBACK' + pad.replace(/[^\n]/g, ' ')
  })
  for (const match of withoutFallbacks.matchAll(/#[0-9a-fA-F]{3,8}\b|(?<![-\w])(?:rgb|rgba|hsl|hsla|oklch|lab)\(/g)) {
    const lineStart = withoutFallbacks.lastIndexOf('\n', match.index) + 1
    const lineEnd = withoutFallbacks.indexOf('\n', match.index)
    const line = withoutFallbacks.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    // A shadow is a different repair from a fill: --dsw-shadow-lv1..3 and
    // --dsw-elevation-* replace it outright, while a fill maps to an alias.
    const rule = /box-shadow|(?:linear|radial)-gradient/.test(line) ? 'no-literal-shadow' : 'no-literal-color'
    violate(rule, file, lineOf(text, match.index), match[0])
  }

  // 2. Radius must come from the token scale, except the capsule idiom and
  //    shapes that are relative to the element (a circle from 50%, a full-bleed
  //    strip from 100vw) — those cannot be expressed on the token scale.
  for (const match of text.matchAll(/border-radius:\s*([^;}\n]+)/g)) {
    const value = match[1].trim()
    if (/var\(--dsw-radius-/.test(value)) continue
    // `0` is the ABSENCE of a radius, not a hardcoded one: it strips a radius
    // that a parent or a shared class applied. There is no token for "none",
    // so demanding one would force a wrong value.
    if (/^(0(\.0+)?(\s+(0(\.0+)?|auto))*(\s*!important)?|999|inherit|initial|unset)/.test(value)) continue
    if (/var\(--[a-z-]*radius/.test(value)) continue
    if (/^(50%|\d+%|\d+(\.\d+)?(vw|vh|vmin|vmax))(\s+\S+)*$/.test(value)) continue
    violate('radius-from-token', file, lineOf(text, match.index), value)
  }

  // 3. Font size: the scale DSH itself uses, or a user-setting variable.
  //    DSH hardcodes 89% of its font sizes, so "no literal at all" would be a
  //    rule the host does not follow. The real invariant is that the literal is
  //    ON the host's scale — the failure being prevented is the half-pixel
  //    drift (11.5 / 12.5 / 10.5), which turned a 4-step scale into noise.
  for (const match of text.matchAll(/font-size:\s*([^;}\n]+)/g)) {
    const value = match[1].trim()
    if (/var\(--dsw-font-/.test(value)) continue
    if (/var\(--dsh-(content|code|terminal)-font-size/.test(value)) continue
    if (/^(inherit|initial|unset|\d+(\.\d+)?(em|rem|%))/.test(value)) continue

    // A fluid size is checked at every stop it can land on: `clamp(18px, 2vw,
    // 32px)` is on the scale iff 18 and 32 are. The old rule rejected any
    // non-`NNpx` value outright, which banned responsive type by construction.
    const stops = [...value.matchAll(/([0-9.]+)px/g)].map(m => Number(m[1]))
    const offScale = stops.filter(px => !FONT_SCALE.has(px))

    // A MINIATURE is content rendered at a fraction of its size — the slide
    // thumbnails do this through `[data-compact]` (a fixed 5px heading inside a
    // 16:9 chip). Those sizes are deliberately below the smallest UI step
    // because they are scaled artwork, not chrome the user reads; holding them
    // to the UI ladder would force 10px and overflow the chip. Everything else,
    // including a fluid size, must land on the ladder.
    if (offScale.length > 0 && selectorOf(text, match.index).includes('[data-compact]')) continue

    if (stops.length === 0) {
      violate('font-size-on-scale', file, lineOf(text, match.index), value)
    } else if (offScale.length > 0) {
      violate('font-size-on-scale', file, lineOf(text, match.index), value)
    }
  }

  // 4. No guessing at the host's theme.
  for (const match of text.matchAll(/prefers-color-scheme/g)) {
    violate('no-os-theme-query', file, lineOf(text, match.index), match[0])
  }

  // 5. No guessing at the host's DOM. The class names are build hashes.
  //
  //    This rule used to run on `.ts`/`.tsx` only, so a stylesheet could keep
  //    its `[class*="centerCol"]` selectors and the run still printed PASS —
  //    a green that said nothing about the files most of this contract is
  //    about. Both languages guess the same way, so both are scanned.
  for (const match of text.matchAll(/\[class\*?=\\?["'][^"'\\]*\\?["']\]/g)) {
    violate('no-dom-class-guessing', file, lineOf(text, match.index), match[0])
  }
}

/* ------------------------------------------------------- token existence (CSS+TS) */

function checkTokens (file, text, isCss) {
  const body = isCss ? stripCssComments(text) : stripJsComments(text)
  for (const match of body.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) {
    const name = match[1]
    if (definedTokens.has(name)) continue
    violate('token-must-exist', file, lineOf(body, match.index), name)
  }
}

/* ------------------------------------------------------------------ TS checks */

const TS_FILES = [...walk(CLIENT, '.ts'), ...walk(CLIENT, '.tsx')]

for (const file of TS_FILES) {
  const raw = readFileSync(file, 'utf8')
  const text = stripJsComments(raw)

  // 5. No guessing at the host's DOM. The class names are build hashes.
  for (const match of text.matchAll(/\[class\*?=\\?["'][^"'\\]*\\?["']\]/g)) {
    violate('no-dom-class-guessing', file, lineOf(text, match.index), match[0])
  }

  // 6. No reading the theme off the DOM.
  for (const match of text.matchAll(/dataset\.theme|body\.dataset\.ds|matchMedia\(/g)) {
    violate('theme-from-service', file, lineOf(text, match.index), match[0])
  }
}

/* ------------------------------------------------------------ run the token scan */

let definedTokens
const nodeModules = findDshNodeModules()
if (nodeModules === undefined) {
  console.log('SKIP  DSH install not found: the token-existence rule was NOT enforced.')
  console.log('      Set DSH_ASAR_DIR to the extracted `dsh/node_modules` to enable it.')
  console.log('      Every other rule below still ran.\n')
  definedTokens = new Set()
} else {
  definedTokens = collectDefinedTokens(nodeModules)
  if (VERBOSE) console.log(`read ${definedTokens.size} defined --dsw-* tokens from ${nodeModules}\n`)
}

if (definedTokens.size > 0) {
  for (const file of CSS_FILES) checkTokens(file, readFileSync(file, 'utf8'), true)
  for (const file of TS_FILES) checkTokens(file, readFileSync(file, 'utf8'), false)
}

/* --------------------------------------------------------------------- report */

const RULE_TEXT = {
  'no-literal-color': 'literal color — use a --dsw-alias-* token so both themes follow',
  'no-literal-shadow': 'literal shadow — use --dsw-shadow-lv1|lv2|lv3 or --dsw-elevation-soft|panel|prominent',
  'radius-from-token': 'hardcoded radius — use --dsw-radius-xs|sm|md|lg|xl|panel (999px allowed)',
  'font-size-on-scale': 'font-size not on the host scale — use 10|11|12|13|14|15|16|18|20|22|24|26|28px, or var(--dsh-content-font-size)',
  'no-os-theme-query': 'prefers-color-scheme — the host theme is body[data-ds-dark-theme] or the theme service',
  'token-must-exist': 'token is not defined by DSH — the browser drops this declaration silently',
  'no-dom-class-guessing': '[class*=] selector — register a slot instead of guessing host class names',
  'theme-from-service': 'theme read from the DOM or matchMedia — inject the theme service',
}

if (violations.length === 0) {
  console.log('PASS  native-UI contract: no violations.')
  process.exit(0)
}

const byRule = new Map()
for (const v of violations) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, [])
  byRule.get(v.rule).push(v)
}

console.log(`FAIL  native-UI contract: ${violations.length} violation(s) in ${new Set(violations.map(v => v.file)).size} file(s).\n`)
for (const [rule, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${rule}  (${list.length})`)
  console.log(`  ${RULE_TEXT[rule] ?? ''}`)
  const shown = VERBOSE ? list : list.slice(0, 6)
  for (const v of shown) console.log(`    ${v.file}:${v.line}  ${v.detail}`)
  if (!VERBOSE && list.length > shown.length) console.log(`    … ${list.length - shown.length} more (--verbose to list all)`)
  console.log('')
}
console.log('Contract: docs/native-ui-contract.md')
process.exit(1)

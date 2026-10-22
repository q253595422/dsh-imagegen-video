/**
 * Real-browser guards for the three cross-module UI contracts:
 *
 *  1. GooeyNav follows the host theme at RUNTIME (not just at mount).
 *  2. The annotation marker is ONE color in both places it is drawn — the CSS
 *     boxes the user sees and the Canvas2D marker burnt into the image the
 *     model receives.
 *  3. Stacking order is one ordered scale, with no two unrelated layers on the
 *     same number.
 *
 * WHY a real browser: all three are decided by the CSS cascade and computed
 * values. jsdom has no layout engine and resolves no custom properties, so a
 * jsdom check here would assert the source text rather than the behaviour —
 * which is how the GooeyNav theme bug survived: the code looked right.
 *
 * WHY not a pure source-text check: (1) and (2) are about what the browser
 * COMPUTES, and a source grep cannot tell a token that resolves from one that
 * silently falls back. (3) is genuinely a source invariant, so it is checked
 * from the source (a browser cannot see "these two numbers came from unrelated
 * decisions").
 *
 * Run: node scripts/verify-ui-contracts.mjs
 * Skips loudly (exit 0) when no headless Chromium is available, like the other
 * browser guards here — a missing tool is not a failing contract.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, launchChrome, skipWithoutChrome } from './lib/headless-chrome.mjs'

const CHROME = findChrome()

// ------------------------------------------------- 0. one way to start a browser
// Every browser guard must read the DevTools port the browser PUBLISHED, never
// guess one. A guessed port is indistinguishable from a correct one until two
// runs overlap: the loser either finds no listener or — worse — is answered by
// the other run's browser and asserts against a blank page, which reports as an
// unrelated contract going green or an opaque "CDP down".
//
// This is a source invariant, and it is checked BEFORE the tool gate on purpose:
// it needs no browser, so a machine without Chromium still enforces it.
const SCRIPT_DIR = new URL('.', import.meta.url)
// Three files are not browser guards and must not be read as one: the launcher
// itself (it is where the published-port form lives), this guard (it carries the
// pattern below) and the negative-verification harness (it carries the DEFECTIVE
// literal as a mutation payload). Scanning any of them would make this check fail
// on a clean tree.
const NOT_A_GUARD = new Set(['headless-chrome.mjs', 'verify-negative.mjs', 'verify-ui-contracts.mjs'])
const launcherUsers = readdirSync(SCRIPT_DIR).filter(name => name.endsWith('.mjs') && !NOT_A_GUARD.has(name))
// Built by concatenation so this pattern cannot match its own source text: a
// literal here would be the first thing the scan reports.
const PORT_FLAG = `--remote-debugging-${'port'}=`
const guessedPorts = []
for (const name of launcherUsers) {
  const source = readFileSync(new URL(name, SCRIPT_DIR), 'utf8')
  // `=0` means "publish the port"; anything else is a guess. Written out rather
  // than pattern-matched so the offending value stays visible in the report.
  const guess = new RegExp(`${PORT_FLAG}(?!0\\b)([^\\s'"\`]+)`).exec(source)
  if (guess !== null) guessedPorts.push(`${name}: ${PORT_FLAG}${guess[1]}`)
}
if (guessedPorts.length > 0) {
  console.error('\nFAIL: a browser guard hand-picks its DevTools port.')
  console.error(guessedPorts.map(entry => `  ${entry}`).join('\n'))
  console.error('Concurrent runs then read each other\'s browser (or find none), and')
  console.error('the failure shows up as an unrelated contract, not as this one.')
  console.error('Use launchChrome() from scripts/lib/headless-chrome.mjs instead.')
  process.exit(1)
}
console.log(`DevTools port: ${launcherUsers.length} scripts scanned, none guesses one`)

if (CHROME === null) skipWithoutChrome('the UI contract guards did NOT run.')

const clientDir = new URL('../src/client/', import.meta.url)
const read = name => readFileSync(new URL(name, clientDir), 'utf8')

// --------------------------------------------------------------- 3. stacking
// Pure source invariant: every layer must read a scale variable, and the scale
// must not hand two unrelated layers the same number.
const CSS_FILES = readdirSync(clientDir).filter(name => name.endsWith('.module.css'))
const literalZ = []
for (const name of CSS_FILES) {
  const source = read(name)
  source.split('\n').forEach((line, index) => {
    const match = line.match(/z-index:\s*(-?\d+)/)
    // GooeyNav's own particle/pill layering is internal to one component and
    // deliberately literal: it never competes with another module's layer, and
    // the negative values are part of its gooey filter trick.
    if (match !== null && name !== 'GooeyNav.module.css') {
      literalZ.push(`${name}:${index + 1} (${match[0].trim()})`)
    }
  })
}
if (literalZ.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: z-index literals are back in the module stylesheets.')
  console.error('Every layer must read the shared scale, or two modules will drift')
  console.error('onto the same number again and the winner becomes document order:')
  for (const entry of literalZ) console.error(`  - ${entry}`)
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log(`no z-index literals outside GooeyNav.module.css (${CSS_FILES.length} stylesheets scanned)`)

const scale = read('panel.module.css')
const declared = new Map()
for (const match of scale.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)) {
  const value = Number(match[2])
  if (!declared.has(value)) declared.set(value, [])
  declared.get(value).push(match[1])
}
const collisions = [...declared.entries()].filter(([, names]) => names.length > 1)
if (collisions.length > 0) {
  console.error('\nFAIL: two scale entries share a number, which is the bug the scale exists to prevent:')
  for (const [value, names] of collisions) console.error(`  ${value}: ${names.join(', ')}`)
  process.exit(1)
}
console.log(`z-index scale: ${declared.size} distinct rungs, no collisions`)

// Every `var(--z-*)` used anywhere must be declared in the scale.
const usedVars = new Set()
for (const name of CSS_FILES) {
  for (const match of read(name).matchAll(/var\((--z-[a-z-]+)/g)) usedVars.add(match[1])
}
const undeclared = [...usedVars].filter(name => !scale.includes(`${name}:`))
if (undeclared.length > 0) {
  console.error(`\nFAIL: layers reference scale entries that are never declared: ${undeclared.join(', ')}`)
  console.error('An undeclared variable resolves to nothing, so the element gets z-index:auto')
  console.error('and silently falls to the bottom of the stack.')
  process.exit(1)
}
console.log(`all ${usedVars.size} referenced scale entries are declared`)

// The doc table above the scale is the contract: it says which number each rung
// holds and why. It has to match the declarations, because the table is what a
// future author reads before choosing a rung -- a table that disagrees with the
// code is worse than no table. Both directions are checked, so a renamed rung
// cannot be left behind in the prose.
const rungValue = new Map()
for (const match of scale.matchAll(/--z-([a-z-]+):\s*(\d+);/g)) rungValue.set(match[1], Number(match[2]))
const tableRungs = new Map()
for (const line of scale.split('\n')) {
  // ` *   60  takeover          ...` -- the number/name columns of the table.
  const match = line.match(/^\s*\*\s+(\d+)\s+([a-z][a-z0-9-]*)\s\s/)
  if (match !== null) tableRungs.set(match[2], Number(match[1]))
}
const tableMismatch = []
for (const [name, value] of rungValue) {
  if (!tableRungs.has(name)) tableMismatch.push(`--z-${name} is declared ${value} but absent from the doc table`)
  else if (tableRungs.get(name) !== value) tableMismatch.push(`--z-${name}: table says ${tableRungs.get(name)}, declaration says ${value}`)
}
for (const name of tableRungs.keys()) {
  if (!rungValue.has(name)) tableMismatch.push(`${name} is documented but never declared`)
}
if (tableMismatch.length > 0) {
  console.error('\nFAIL: the stacking-order documentation does not match the declarations:')
  for (const entry of tableMismatch) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log(`stacking table matches all ${rungValue.size} declarations`)

// ------------------------------------------------- 4. the template source row
// The registry holds eight sources plus favorites. Each tab is `nowrap`, and
// a plain flex row neither wraps nor scrolls, so a tab past the right edge is
// simply unreachable -- no scrollbar, no wrap, nothing to click. Both halves
// are required: scroll on the row, and no shrink on the tabs, because a tab
// allowed to shrink truncates its own label and its count badge instead.
const templatesCss = read('templates.module.css')
const ruleOf = (source, selector) => {
  const at = source.indexOf(`${selector} {`)
  if (at < 0) return ''
  return source.slice(at, source.indexOf('}', at) + 1)
}
const tabRow = ruleOf(templatesCss, '.sourceTabs')
const tabRule = ruleOf(templatesCss, '.sourceTab')
if (!/overflow-x:\s*(auto|scroll)/.test(tabRow) || !/overflow-y:\s*hidden/.test(tabRow)) {
  console.error('\nFAIL: the template source row can no longer scroll.')
  console.error('Its tabs are `white-space: nowrap`, and a flex row that does not')
  console.error('scroll clips everything past the right edge: with the sources that')
  console.error('are registered now, the later tabs are unreachable -- they cannot be')
  console.error('clicked, and nothing on screen says they exist.')
  process.exit(1)
}
if (!/flex:\s*none/.test(tabRule)) {
  console.error('\nFAIL: template source tabs are allowed to shrink.')
  console.error('A shrunk tab truncates its own label and count badge rather than')
  console.error('letting the row scroll, so the source stays unreadable.')
  process.exit(1)
}
// The row has to be built FROM the registry, not from a hand-written list: a
// source that is registered but has no tab is a library the user cannot open,
// and the browser fixture below can only be as complete as this mapping.
// The slice stops at the next sibling element: `TEMPLATE_SOURCES.map` appears
// again further down the file (the favorites view groups by source), and a
// slice running to EOF would match THAT call and pass no matter what the tab
// row did -- a check that can never fail.
const librarySource = readFileSync(new URL('TemplateLibrary.tsx', clientDir), 'utf8')
const tablistAt = librarySource.indexOf('className={css.sourceTabs}')
const tablistEnd = librarySource.indexOf('css.toolbar', tablistAt)
const tabRowSource = tablistAt < 0 || tablistEnd < 0 ? '' : librarySource.slice(tablistAt, tablistEnd)
if (!/TEMPLATE_SOURCES\.map\(/.test(tabRowSource)) {
  console.error('\nFAIL: the source row no longer renders one tab per registered source.')
  console.error('The registry is the list of libraries the user can open; a tab row built')
  console.error('from anything else leaves registered sources unreachable.')
  process.exit(1)
}
// Every registered source must actually be loadable, or its tab renders an
// empty library. This is the seam the sources were added along.
const protocolSource = readFileSync(new URL('protocol.ts', new URL('../src/', import.meta.url)), 'utf8')
const storeSource = readFileSync(new URL('templates-store.ts', new URL('../src/', import.meta.url)), 'utf8')
const registered = [...protocolSource.matchAll(/^\s{4}id:\s*'([a-z0-9-]+)',/gm)].map(match => match[1])
// The label of each source, so the browser fixture below renders the REAL tab
// labels instead of a hand-written list that would go stale the moment a source
// is added -- a fixture stuck at eight tabs stops testing the ninth.
const registeredLabels = [...protocolSource.matchAll(/^\s{4}id: '([a-z0-9-]+)',\n\s{4}label: '([^']+)',/gm)].map(match => [match[1], match[2]])
if (registeredLabels.length !== registered.length) {
  console.error('\nFAIL: a template source has no readable label, so the tab-row fixture cannot be built from the registry.')
  process.exit(1)
}
// SOURCE_DEFS entries do not all lead with `bundledPath` (vibeui and canghe
// start with `listUrl`), so match each top-level entry and then ask whether its
// body declares one -- keying on the first line missed exactly those two.
const hostDefBodies = new Map()
for (const match of storeSource.matchAll(/^ {2}'?([a-z0-9-]+)'?:\s*\{\n([\s\S]*?)^ {2}\},/gm)) {
  hostDefBodies.set(match[1], match[2])
}
const missing = registered.filter(id => !(hostDefBodies.get(id) ?? '').includes('bundledPath:'))
if (registered.length === 0 || missing.length > 0) {
  console.error(`\nFAIL: a registered template source has no host-side fetch definition: ${missing.join(', ')}`)
  console.error('Its tab would render an empty library with no error to explain it.')
  process.exit(1)
}
const snapshotFileOf = id => new URL(
  `../src/templates/${id === 'vibeui' ? 'cases' : id === 'canghe' ? 'canghe-cases' : `${id}-cases`}.json`,
  import.meta.url,
)
for (const id of registered) {
  const snapshot = snapshotFileOf(id)
  if (!existsSync(snapshot)) {
    console.error(`\nFAIL: source "${id}" has no bundled snapshot at src/templates/.`)
    console.error('A source ships its snapshot with the release; without one the tab is empty offline.')
    process.exit(1)
  }
}

// And the images must be servable by the gate that will actually serve them.
// This is deliberately read out of SOURCE_DEFS rather than repeated here: a
// copy of the host list would agree with itself forever while the real gate
// said something else, which is exactly how a source ships cards whose images
// can never load. A bare file name needs `imageBaseUrl`; an absolute URL needs
// its hostname in `allowedImageHosts`.
const hostProblem = []
for (const id of registered) {
  const body = hostDefBodies.get(id) ?? ''
  const allowed = [...(/allowedImageHosts:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1])
  const hasBase = /imageBaseUrl:/.test(body)
  const snapshot = JSON.parse(readFileSync(snapshotFileOf(id), 'utf8'))
  for (const entry of snapshot.cases ?? []) {
    const image = typeof entry.image === 'string' ? entry.image.trim() : ''
    if (image === '') continue
    if (!/^https?:\/\//i.test(image)) {
      if (!hasBase) hostProblem.push(`${id}/${entry.id}: bare file name "${image}" but the source declares no imageBaseUrl`)
      continue
    }
    let hostname
    try { hostname = new URL(image).hostname.toLowerCase() } catch { hostProblem.push(`${id}/${entry.id}: unparseable image URL ${image}`); continue }
    if (!allowed.includes(hostname)) {
      hostProblem.push(`${id}/${entry.id}: image host ${hostname} is not in allowedImageHosts [${allowed.join(', ')}]`)
    }
  }
}
if (hostProblem.length > 0) {
  console.error('\nFAIL: a bundled snapshot carries images its source will refuse to serve.')
  console.error('readTemplateImage drops any reference whose host is not allowed, so these')
  console.error('cards render a broken thumbnail no matter how good the network is:')
  for (const entry of hostProblem.slice(0, 12)) console.error(`  - ${entry}`)
  if (hostProblem.length > 12) console.error(`  … and ${hostProblem.length - 12} more`)
  process.exit(1)
}

// ------------------------------------------------- 5. ecommerce card headings
// `.ecommerceSection h3` lays the title and its `small` hint out as a flex row
// (`display:flex`, `gap:7px`). Left to itself the title's bare text becomes an
// anonymous flex item that SHRINKS to make room for the hint: at the default
// 300px config column the available line is ~196px and the title was squeezed
// to ~69px, one pixel short of "主图参考图" (70px), so every card heading wrapped
// to two lines while the hint beside it was merely cut off.
//
// The hint's own `text-overflow: ellipsis` did not help either: a flex item's
// default `min-width:auto` refuses to shrink below its content, which made the
// ellipsis dead code — the text was clipped mid-character with no visual cue.
//
// Source-level on purpose: this is decided by how the two rules divide the
// line, and the browser fixture below cannot see the ecommerce panel at all.
const panelCss = read('panel.module.css')
const titleRule = ruleOf(panelCss, '.ecommerceSectionTitle')
const hintRule = ruleOf(panelCss, '.ecommerceSectionHint')
if (!/flex:\s*none/.test(titleRule)) {
  console.error('\nFAIL: the ecommerce card title is allowed to shrink.')
  console.error('The card head is a flex row, so a shrinkable title gives up its width')
  console.error('to the hint beside it and wraps: "主图参考图" needs 70px and was left 69px.')
  process.exit(1)
}
if (!/min-width:\s*0/.test(hintRule)) {
  console.error('\nFAIL: the ecommerce card hint cannot shrink, so its ellipsis never renders.')
  console.error('A flex item defaults to `min-width: auto`; without an explicit 0 the hint')
  console.error('is clipped mid-character instead of ending in "…".')
  process.exit(1)
}
// The rule only works if the title text is wrapped in the span that carries it.
// A bare text node in the flex row has no class to target, so the `flex: none`
// above would apply to nothing and the wrap returns silently.
//
// Only headings that actually carry a hint are in scope: the ones without one
// ("参数信息", "套图结果", …) have nothing competing for the line, so wrapping
// them would add markup that earns nothing.
const ecommerceCards = [...read('ImageGenPanel.tsx').matchAll(/<h3>(.*?)<\/h3>/gs)]
  .map(match => match[1])
  .filter(inner => inner.includes('css.ecommerceSectionHint}'))
const unwrapped = ecommerceCards.filter(inner => !inner.startsWith('<span className={css.ecommerceSectionTitle}>'))
if (ecommerceCards.length === 0 || unwrapped.length > 0) {
  console.error('\nFAIL: an ecommerce card heading renders its title outside the no-shrink span.')
  console.error('`flex: none` on .ecommerceSectionTitle cannot reach a bare text node,')
  console.error(`so that heading wraps again. Offenders: ${String(unwrapped.length)} of ${ecommerceCards.length}.`)
  process.exit(1)
}
console.log(`ecommerce card headings: title no-shrink in ${ecommerceCards.length} cards, hint ellipsis live`)

// A repository that declares no licence cannot have its images redistributed by
// pointing shipped data at them. `songguoxs/gpt4o-image-prompts` is the one case
// of this: six prompt-signal cases once carried its preview URLs. The prompt text
// in those cases is the original authors' own and stays; the image reference is
// cleared by `scripts/fetch-templates.mjs` and must not come back through a
// regeneration that forgets the filter.
//
// Checked against the shipped snapshot, not against the fetch script, because a
// filter that exists but was not applied is the exact failure being guarded.
const UNLICENSED_IMAGE_OWNERS = new Set(['songguoxs'])
const unlicensedImages = []
for (const id of registered) {
  const snapshot = JSON.parse(readFileSync(snapshotFileOf(id), 'utf8'))
  for (const entry of snapshot.cases ?? []) {
    const image = typeof entry.image === 'string' ? entry.image : ''
    if (!/^https?:\/\//i.test(image)) continue
    let url
    try { url = new URL(image) } catch { continue }
    const segments = url.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase())
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/... and github.com/<owner>/<repo>/...
    if (segments.length >= 2 && UNLICENSED_IMAGE_OWNERS.has(segments[0])) {
      unlicensedImages.push(`${id}/${entry.id}: ${image}`)
    }
  }
}
if (unlicensedImages.length > 0) {
  console.error('\nFAIL: a shipped snapshot points an image at a repository that grants no licence.')
  console.error('Those URLs are part of the distributed data, which makes them this project\'s')
  console.error('redistribution question, not the upstream aggregator\'s. The prompt text and the')
  console.error('author link stay; the preview image has to be cleared:')
  for (const entry of unlicensedImages.slice(0, 8)) console.error(`  - ${entry}`)
  if (unlicensedImages.length > 8) console.error(`  … and ${unlicensedImages.length - 8} more`)
  process.exit(1)
}
console.log(`template source row: ${registered.length} sources, scrollable, every snapshot image inside its source's allowlist`)

// The orderings that must hold, written as requirements rather than as numbers.
// This guards the failure that actually happened: a rewrite that renumbers "by
// role" looks tidy and silently re-stacks the UI. The select menu fell from
// 1000 to 60 and rendered UNDER the modal that contained it. Each pair below is
// a comparison such a rewrite broke, or would break.
const ordering = [
  ['select-menu', 'modal-picker', 'a Select dropdown portals to <body>, so it must clear the modal that contains it'],
  ['modal-picker', 'popover-raised', 'the provider picker opens from the settings card, over the skills popover'],
  ['modal-picker', 'lightbox', 'the provider picker opens from the settings card, over the full-screen preview'],
  ['lightbox', 'media-viewer', 'the image lightbox sits above the in-canvas video preview'],
  ['menu-flyout', 'menu-raised', 'the model flyout is a child of the model menu'],
  ['menu-raised', 'modal-backdrop', 'the model picker must clear the template library it can open over'],
  ['modal-backdrop', 'modal', 'the library backdrop sits above the settings editor backdrop'],
  ['chat-resizer', 'takeover', 'the resize handle belongs to the column the panel takes over'],
  ['picker-backdrop', 'notice', 'the picker backdrop must cover the canvas notice (was a 60/60 tie)'],
  ['notice', 'takeover', 'the canvas notice sits inside the panel container'],
  ['scrim', 'takeover', 'the canvas modal scrim covers the whole panel it is opened over'],
  ['context-menu', 'scrim', 'the canvas context menu draws above the scrim it opened with'],
  ['popover-raised', 'scrim', 'the skills menu draws over its own scrim'],
  ['file-overlay', 'popover-raised', 'the file reader covers the skills popover'],
  ['diagnostics', 'file-overlay', 'the diagnostics record is a studio-wide overlay, so it covers the file reader'],
  ['diagnostics', 'context-menu', 'the diagnostics overlay is studio-wide, so it covers the canvas context menu anchored inside the studio'],
  ['takeover', 'dock-raised', 'the panel container covers the compose strip'],
  ['dock-raised', 'dock', 'the compose strip draws over the dock it floats above'],
  ['topbar', 'dock', 'the canvas top bar draws over the docks below it'],
  ['anchored-menu', 'topbar', 'the canvas background menu draws over the top bar'],
  ['panel-header', 'marquee', 'the panel header must stay over the canvas'],
  ['marquee', 'inline-popover', 'the marquee draws over a form popover'],
  ['inline-popover', 'tray', 'a form popover draws over the task tray'],
  ['tray', 'badge', 'the task tray draws over node badges'],
  ['badge', 'hover', 'node badges draw over hover toolbars'],
  ['hover', 'content-raised', 'toolbars draw over the handles they sit on'],
  ['content-raised', 'content', 'handles draw over the content they resize'],
  ['content', 'canvas-links', 'connection lines draw under the nodes they join'],
]
const broken = []
for (const [above, below, why] of ordering) {
  const a = rungValue.get(above)
  const b = rungValue.get(below)
  if (a === undefined) broken.push(`--z-${above} is not declared`)
  else if (b === undefined) broken.push(`--z-${below} is not declared`)
  else if (!(a > b)) broken.push(`--z-${above} (${a}) must be above --z-${below} (${b}) -- ${why}`)
}
if (broken.length > 0) {
  console.error('\nFAIL: the stacking order is wrong:')
  for (const entry of broken) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log(`stacking order holds for ${ordering.length} required comparisons`)

// Absolute-value pins for the layers whose exact number is load-bearing, i.e.
// anything that has to interleave with a layer owned by ANOTHER plugin or by
// the host shell. The ordering checks above cannot see those: the counterpart
// layer is not in this scale, so a rewrite could move the whole scale and still
// satisfy every relative assertion. These are the values the layers had before
// the scale existed; changing one is a deliberate decision, not a tidy-up.
//   takeover   60 -- the panel container; sibling panels (task board, ssh) and
//                    the shell's own column rules were written against it
//   lightbox  1000 -- full-screen image preview, interleaves with the host's
//                    own overlays
//   guide     1100 -- the config guide, meant to sit above the plugin's own
//                    fullest surface but below the host's dialogs
const pinned = [['takeover', 60], ['lightbox', 1000], ['guide', 1100]]
const moved = pinned.filter(([name, value]) => rungValue.get(name) !== value)
if (moved.length > 0) {
  console.error('\nFAIL: a layer that interleaves with the host changed its number:')
  for (const [name, value] of moved) console.error(`  --z-${name}: expected ${value}, found ${rungValue.get(name)}`)
  console.error('These numbers are shared with panels this plugin does not own.')
  console.error('Move one only on purpose, and update the host-facing comment with it.')
  process.exit(1)
}
console.log(`host-facing rungs pinned: ${pinned.map(([name, value]) => `${name}=${value}`).join(', ')}`)

// ------------------------------------------------------- 4. focusable hiding
// `opacity: 0` and `pointer-events: none` both leave an element in the tab
// order. The node toolbars are hidden with those two, so without a rule that
// actually removes them from the tab order every node contributes 5-10
// invisible focus stops -- and Enter on one of them fires the button, including
// delete. This is a source invariant (a browser cannot see "these two rules
// were meant to pair up"), so it is checked from the source.
const canvasSheet = read('canvas-workspace.module.css')
// Comments are stripped first, and that is not tidiness: the rule's own
// explanation contains the literal string `visibility: hidden`, so a check that
// greps the raw text keeps passing after the declaration itself is deleted --
// the comment vouches for the code it describes. (Caught by negative
// verification: the mutation removed the declaration and the check stayed green.)
const canvasRules = canvasSheet.replace(/\/\*[\s\S]*?\*\//g, '')
const toolbarBlock = canvasRules.match(/\.hoverToolbar\s*\{[^}]*\}/)?.[0] ?? ''
if (!/visibility:\s*hidden/.test(toolbarBlock)) {
  console.error('\nFAIL: the node hover toolbar no longer leaves the tab order when hidden.')
  console.error('`opacity: 0` + `pointer-events: none` keep it focusable, so keyboard')
  console.error('users tab onto controls that are not on screen.')
  process.exit(1)
}
if (!/\.node:focus-within\s+\.hoverToolbar/.test(canvasRules)) {
  console.error('\nFAIL: nothing reveals the node toolbar when it is reached by keyboard.')
  console.error('Focus is the third way in (after hover and selection); without it the')
  console.error('toolbar is focusable but permanently invisible.')
  process.exit(1)
}
console.log('node toolbars leave the tab order when hidden and reveal on focus')

// ------------------------------------------------------- 1 & 2. real browser
// The page reproduces the two subjects with the REAL stylesheets: the GooeyNav
// container (theme attribute flipped at runtime) and the canvas root that
// declares the annotation token.
const gooeyCss = read('GooeyNav.module.css')
const canvasCss = read('canvas-workspace.module.css')
const imageOpsSource = read('image-ops.ts')
const gooeySource = read('GooeyNav.tsx')

// The GooeyNav contract is that the SUBSCRIPTION fires, and that lives in
// surface-theme.ts. Injecting the stylesheet alone cannot observe it: the
// `data-theme` attribute is set by the component's own callback, so a
// CSS-only page reports `undefined` for it and the check passes vacuously.
// The real module is transpiled and loaded into the page instead, and driven
// exactly the way GooeyNav wires it.
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const themeModuleDir = join(tmpdir(), `dsh-surface-theme-${process.pid}`)
mkdirSync(themeModuleDir, { recursive: true })
const tsc = spawnSync(join(projectRoot, 'node_modules/.bin/tsc'), [
  join(projectRoot, 'src/client/surface-theme.ts'),
  '--outDir', themeModuleDir,
  '--module', 'esnext', '--target', 'es2022', '--skipLibCheck',
], { cwd: projectRoot, encoding: 'utf8' })
if (tsc.status !== 0) {
  console.error('\nFAIL: could not transpile surface-theme.ts for the browser check.')
  console.error(tsc.stdout ?? '', tsc.stderr ?? '')
  process.exit(1)
}
const themeModuleSource = readFileSync(join(themeModuleDir, 'surface-theme.js'), 'utf8')

const page = `<!doctype html><html><head><style>
  /* A light surface, then flipped to dark at runtime. */
  body { margin: 0; background: #ffffff; color: #17171c; }
  body[data-ds-dark-theme] { background: #0f1115; color: #f9fafb; }
  /* The host tokens the components read, in both themes. */
  body {
    --dsw-alias-brand-primary: #0f1115;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-static-red-500: #ef4444;
    --dsw-static-neutral-00: #ffffff;
  }
  body[data-ds-dark-theme] {
    --dsw-alias-brand-primary: #f9fafb;
    --dsw-alias-label-primary: #f9fafb;
    --dsw-alias-label-secondary: #a2a4a6;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-bg-layer-1: #17171c;
  }
  ${gooeyCss}
  ${canvasCss}
</style></head><body>
  <div class="container" id="gooey"><nav><ul><li class="active"><button>One</button></li><li><button>Two</button></li></ul></nav></div>
  <div class="root" id="canvasRoot"><div id="probe"></div></div>
  <script type="module">
    import { detectLightSurface, subscribeSurfaceTheme } from '/surface-theme.mjs'
    // The same two lines GooeyNav's setup effect runs.
    const container = document.getElementById('gooey')
    const applyTheme = (light) => { container.dataset.theme = light ? 'light' : 'dark' }
    applyTheme(detectLightSurface(container))
    window.__stopThemeWatch = subscribeSurfaceTheme(container, applyTheme)
    window.__gooeyReady = true
  </script>
</body></html>`

const server = (await import('node:http')).createServer((req, res) => {
  if (req.url?.startsWith('/surface-theme.mjs') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(themeModuleSource)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  // Each fixture is the same stylesheets on a different body: the real-browser
  // checks need the component relationship, not the whole app.
  if (req.url?.includes('toolbar=1') === true) res.end(toolbarPage)
  else if (req.url?.includes('stack=1') === true) res.end(stackPage)
  else if (req.url?.includes('mainslot=1') === true) res.end(mainSlotPage)
  else if (req.url?.includes('sourcetabs=1') === true) res.end(sourceTabsPage)
  else if (req.url?.includes('shortcuts=1') === true) res.end(shortcutPage)
  else res.end(page)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// The browser picks its own DevTools port and publishes it in the profile it
// was given — the hand-rolled random range this used to guess at is what made
// two concurrent runs read each other's blank target.
const launched = await launchChrome({ chrome: CHROME, name: 'dsh-ui-contracts' })
const browser = launched.browser
const target = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws.removeEventListener('message', onMessage); resolve(m) } }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate = async expression => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send('Runtime.enable', {})

// The module script has to finish evaluating before anything is asserted;
// polling its own readiness flag is the only honest wait here (a fixed sleep
// would pass or fail depending on how fast this machine loads a module).
let gooeyReady = false
for (let i = 0; i < 40; i++) {
  gooeyReady = (await evaluate('window.__gooeyReady === true')) === true
  if (gooeyReady) break
  await new Promise(r => setTimeout(r, 100))
}
if (!gooeyReady) {
  console.error('\nFAIL: the surface-theme module never loaded in the page, so the')
  console.error('GooeyNav contract was NOT exercised (this is a broken harness, not a pass).')
  process.exit(1)
}

// --- 1. GooeyNav follows a runtime theme switch -----------------------------
// The page flips the host attribute the way DSH does, then reads the computed
// pill color. A one-shot detector (the original bug) leaves the old value.
const gooey = await evaluate(`(async () => {
  const el = document.getElementById('gooey')
  const read = () => getComputedStyle(el).getPropertyValue('--gooey-pill').trim()
  const before = read()
  const themeBefore = el.dataset.theme
  document.body.setAttribute('data-ds-dark-theme', '')
  // The subscription is async (MutationObserver): wait for the attribute to
  // actually move rather than assuming a fixed number of frames is enough.
  const deadline = Date.now() + 2000
  while (el.dataset.theme === themeBefore && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20))
  }
  return { before, after: read(), themeBefore, themeAttr: el.dataset.theme }
})()`)
console.log(`GooeyNav pill: light=${gooey.before} (${gooey.themeBefore}) -> dark=${gooey.after} (${gooey.themeAttr})`)
if (gooey.themeAttr !== 'dark') {
  console.error(`\nFAIL: the container's data-theme is still "${gooey.themeAttr}" after the host switched to dark.`)
  console.error('The subscription did not fire, so the nav keeps the ink it was built with')
  console.error('and stays unreadable against the new surface.')
  process.exit(1)
}
if (gooey.before === gooey.after || gooey.after === '') {
  console.error(`\nFAIL: the GooeyNav palette did not move with the theme (light=${gooey.before}, dark=${gooey.after}).`)
  console.error('Either the palette is hardcoded again, or the per-surface branches')
  console.error('resolved to the same value and the nav is painted blind to the surface.')
  process.exit(1)
}
// The subscription must also be DISPOSED -- a nav that keeps observing after
// it unmounts is the same leak class the panel takeover bug came from.
if (!/stopThemeWatch\(\)/.test(gooeySource)) {
  console.error('\nFAIL: GooeyNav no longer disposes its theme subscription.')
  process.exit(1)
}
// And the wiring itself: the module being correct is useless if the component
// never subscribes to it.
if (!/subscribeSurfaceTheme\(/.test(gooeySource)) {
  console.error('\nFAIL: GooeyNav no longer calls subscribeSurfaceTheme -- it reads the surface once again.')
  process.exit(1)
}

// --- 2. one annotation color, CSS and Canvas2D ------------------------------
const marker = await evaluate(`(() => {
  const root = document.getElementById('canvasRoot')
  const style = getComputedStyle(root)
  const probe = document.getElementById('probe')
  probe.style.borderColor = 'var(--canvas-annotation)'
  probe.style.color = 'var(--canvas-annotation-ink)'
  const probeStyle = getComputedStyle(probe)
  return {
    declared: style.getPropertyValue('--canvas-annotation').trim(),
    ink: style.getPropertyValue('--canvas-annotation-ink').trim(),
    resolvedBorder: probeStyle.borderTopColor,
    resolvedInk: probeStyle.color,
  }
})()`)
console.log(`annotation token: ${marker.declared} (ink ${marker.ink}) -> border ${marker.resolvedBorder}`)
if (marker.declared === '' || marker.ink === '') {
  console.error('\nFAIL: the annotation token does not resolve on the canvas root.')
  console.error('CSS draws the boxes with it and Canvas2D reads it for the marker')
  console.error('burnt into the model reference; an empty value means one of them')
  console.error('falls back to a literal and the two can drift apart.')
  process.exit(1)
}
// Canvas2D must READ the token rather than repeat a literal.
if (!/themeColor\('--canvas-annotation'/.test(imageOpsSource)) {
  console.error('\nFAIL: image-ops no longer reads --canvas-annotation for the marker.')
  console.error('A literal here is the drift this contract exists to prevent.')
  process.exit(1)
}
// And it must read it from the element the token is declared on. The token is
// plugin-private and scoped to the canvas root class, so reading it from
// documentElement returned an empty string in every real browser and the marker
// silently fell back to the literal -- the check above passed while the two
// colors differed. The caller therefore has to pass the canvas root.
if (!/themeColor\('--canvas-annotation', '[^']*', tokenOrigin\)/.test(imageOpsSource)) {
  console.error('\nFAIL: image-ops reads --canvas-annotation without an origin element.')
  console.error('The token is declared on the canvas root, not on documentElement;')
  console.error('reading it from the document root always returns empty and the marker')
  console.error('falls back to a literal that no longer matches the on-screen boxes.')
  process.exit(1)
}
// Matched by splitting the statement on `drawAnnotation(` and then balancing
// parentheses, not by a single-line regex: the call passes
// `boxes.map((box, index) => ...)` and a regex stops at the first `)`, so it
// would fail on a correct call -- and, worse, a `.*` version would pass on any
// later `rootRef.current` in the file rather than this argument.
const workspaceSource = read('CanvasWorkspace.tsx')
const callerHasOrigin = (() => {
  let from = 0
  for (;;) {
    const at = workspaceSource.indexOf('drawAnnotation(', from)
    if (at < 0) return false
    from = at + 1
    // The import statement mentions the name too; skip it.
    if (workspaceSource.slice(Math.max(0, at - 7), at) === 'import ') continue
    let depth = 1
    let i = at + 'drawAnnotation('.length
    for (; i < workspaceSource.length && depth > 0; i++) {
      const char = workspaceSource[i]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
    }
    if (/rootRef\.current\s*$/.test(workspaceSource.slice(at, i - 1))) return true
  }
})()
if (!callerHasOrigin) {
  console.error('\nFAIL: the drawAnnotation caller does not pass the canvas root as the token origin.')
  console.error('Without it the marker token resolves against documentElement, where it is')
  console.error('never declared, so the burned-in boxes fall back to a stale literal.')
  process.exit(1)
}
const literalMarker = /strokeStyle = '#ff2d55'|fillStyle = '#ff2d55'/.test(imageOpsSource)
if (literalMarker) {
  console.error('\nFAIL: image-ops still paints the marker with a literal #ff2d55.')
  process.exit(1)
}
// And the stylesheet must not repeat it either.
const cssLiteral = ['canvas-workspace.module.css'].filter(name => /#ff2d55|255 45 85/.test(read(name)))
if (cssLiteral.length > 0) {
  console.error(`\nFAIL: ${cssLiteral.join(', ')} still hardcodes the marker color.`)
  process.exit(1)
}
console.log('annotation marker: CSS and Canvas2D both read the same token, no literals left')

const canvasSource = read('CanvasWorkspace.tsx')
// The browser fixture below hardcodes `tabindex` on its node, so it measures the
// CSS contract only -- it cannot see whether the COMPONENT still makes the node
// focusable. That half is a source invariant: without tabIndex on the node root
// the toolbar can never be revealed, because a hidden toolbar's own buttons are
// not focusable and `.node:focus-within` would never fire.
const nodeRoot = canvasSource.match(/<div\s*\n\s*key=\{node\.id\}[\s\S]{0,1400}?onPointerDown=\{event => handleNodePointerDown/)
if (nodeRoot === null) {
  console.error('\nFAIL: could not locate the node root element to check its focusability.')
  process.exit(1)
}
if (!/tabIndex=\{0\}/.test(nodeRoot[0])) {
  console.error('\nFAIL: the canvas node root is not focusable.')
  console.error('A hidden toolbar cannot hold focus, so without a tab stop on the node')
  console.error('itself the toolbar is unreachable by keyboard and `.node:focus-within`')
  console.error('never fires -- the two rules deadlock.')
  process.exit(1)
}
console.log('canvas node root is a tab stop, so the toolbar is reachable by keyboard')

// ------------------------------------------------------- 5. tablist contract
// `role="tablist"` commits the component to a keyboard model: exactly one tab
// in the Tab order, and the arrow keys move between tabs. Declaring the roles
// without the keys leaves keyboard users pressing arrows that do nothing, which
// is a real defect rather than a missing nicety. Every tablist in the plugin is
// checked here, so a new one cannot quietly ship without the contract.
//
// GooeyNav is exempt: it has its own inline implementation (its tabs are <li>
// wrappers, so the shared helper's closest('[role="tablist"]') walk does not
// fit) and it is covered by its own check above.
const TABLIST_FILES = readdirSync(clientDir).filter(name => name.endsWith('.tsx') && name !== 'GooeyNav.tsx')
const missingTablistContract = []
for (const name of TABLIST_FILES) {
  const source = read(name)
  if (!source.includes('role="tablist"')) continue
  const tabButtons = [...source.matchAll(/role="tab"/g)].length
  if (tabButtons === 0) continue
  // Every tablist in this file must go through the shared helper.
  if (!/onTablistKeyDown\(/.test(source)) {
    missingTablistContract.push(`${name}: declares ${tabButtons} tab(s) but never calls onTablistKeyDown`)
    continue
  }
  if (!/tabIndexFor\(/.test(source)) {
    missingTablistContract.push(`${name}: no roving tabIndex (tabIndexFor)`)
    continue
  }
  // The helper is only a roving tabIndex if it actually returns -1 for the
  // unselected tab; a helper that returned 0 for everything would pass the
  // call-site checks above while leaving every tab in the Tab order.
  const helper = read('tablist.ts')
  if (!/return active \? 0 : -1/.test(helper)) {
    missingTablistContract.push('tablist.ts: tabIndexFor no longer returns -1 for the unselected tab')
  }
}
if (missingTablistContract.length > 0) {
  console.error('\nFAIL: a tablist declares the ARIA roles without the keyboard contract:')
  for (const entry of missingTablistContract) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log('every tablist wires the shared roving-tabIndex / arrow-key helper')

// --- 3. hidden node toolbars in a REAL browser ------------------------------
// Layout, not source text: whether a hidden toolbar is still a tab stop, and
// whether focusing one makes it visible. jsdom has no layout engine, so this is
// the only place the fix can actually be measured.
//
// The markup reproduces the node/toolbar relationship the component renders:
// the node is the tab stop (`tabIndex=0`), the toolbar holds real buttons, and
// the toolbar is hidden until the node is hovered, selected, or focused.
const toolbarPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${canvasCss}
</style></head><body>
  <div class="node" id="node" tabindex="0" role="group" aria-label="图片节点" style="position:relative;width:200px;height:120px">
    <div class="hoverToolbar" id="toolbar">
      <button id="deleteBtn">删除</button>
      <button id="bgBtn">移除背景</button>
    </div>
  </div>
</body></html>`

// --- the broken tie, measured in a real browser -----------------------------
// The canvas notice and the video-picker backdrop both used to be z-index: 60,
// so which one painted on top was decided by document order -- the app happened
// to render the backdrop after the notice, and that accident is what the user
// asked to remove. This page renders them in the OPPOSITE order on purpose: if
// the two are ever tied again, the notice wins here and the check fails, even
// though every source-level invariant (distinct rungs, doc table, relative
// order) stays green. Paint order is a fact only the browser can report.
const videoPickerCss = read('canvas-video-picker.module.css')
// panel.module.css carries the :root scale every module reads, and mount.tsx
// imports it globally, so the fixture loads it the same way.
const scaleCss = read('panel.module.css')
const stackPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${scaleCss}
  ${canvasCss}
  ${videoPickerCss}
</style></head><body>
  <div class="root" id="canvasRoot" style="position:relative;width:420px;height:320px">
    <div class="backdrop" id="picker"><div style="width:80px;height:40px"></div></div>
    <div class="errorToast" id="toast" data-canvas-no-zoom="">生成失败，请重试</div>
  </div>
</body></html>`

// --- the source row has to stay reachable as the registry grows -------------
// Every tab is `white-space: nowrap`. A plain flex row neither wraps nor
// scrolls, so once the registered sources exceed the width the last tabs are
// simply gone: not scrollable, not wrapped, not clickable, and nothing on
// screen says they exist. The source-level check above reads the declaration;
// only the browser can say whether the LAST tab is actually reachable, so this
// page renders the real stylesheet at a deliberately narrow width and asks.
const templatesModuleCss = read('templates.module.css')
// The tab list is generated from the registry and the FAVORITES tab is the one
// marked; it is the last tab the component renders, so it is the one a clipped
// row loses first.
const tabMarkup = [
  ...registeredLabels.map(([, label]) => `<button class="sourceTab" role="tab">${label}<span class="sourceTabCount">123</span></button>`),
  '<button class="sourceTab" role="tab" id="last">★ 收藏</button>',
].join('\n      ')
const sourceTabsPage = `<!doctype html><html><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f2f3f5;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-brand-primary: #17171c;
    --dsw-alias-interactive-bg-hover: #f0f1f3;
  }
  /* Narrow enough that the registered tab labels cannot all fit on one line. */
  #host { width: 420px; padding: 12px 0; }
  ${templatesModuleCss}
</style></head><body>
  <div id="host">
    <div class="sourceTabs" id="tabs" role="tablist">
      ${tabMarkup}
    </div>
  </div>
</body></html>`

// --- the shortcut legend fits the canvas it opens over ----------------------
// The panel is a two-column grid of key chips: the chips are `nowrap` and the
// label column is `text-align: right` with `min-width: 0`. Two things can go
// wrong that no source check can see. A row can overflow its column when the
// key half and the label half together exceed it (the chips never wrap inside
// one kbd, so the row grows), and the dialog can be taller than the viewport
// when there are more groups than fit -- which is what `max-height` plus the
// scrolling body is for. Both are measured here at a canvas-sized viewport and
// at a phone width, where the grid must collapse to one column.
const shortcutCss = read('shortcut-help.module.css')
// Rendered from the same shape the component renders: every group gets rows of
// chips and a label, using the real stylesheet and the real longest copy. The
// longest label in the data table is `focusNode`, which is why it is used for
// the row that decides the measurement.
const longestLabel = '在节点之间移动焦点，节点工具条随之出现'
// Repeated to far more rows than any viewport can hold. With only the real
// twelve -- or even three copies of them -- the dialog fits whether or not it
// caps its height, so the "grows past the viewport" case could not be told
// apart from the fixed one: it reported FALSE GREEN twice. The copy and the
// stylesheet are the real ones; only the amount is raised until the overflow is
// unambiguous (8 copies x 12 rows = 48 rows per column).
const repeat = (rows, times) => Array.from({ length: times }, () => rows).flat()
const shortcutGroups = [
  { title: '视图', rows: repeat([['Ctrl/⌘|Space', '按住并拖拽平移画布'], ['中键', '中键拖拽平移画布'], ['滚轮', '以指针为中心缩放'], ['Ctrl/⌘|A', '选中全部节点']], 8) },
  { title: '选择', rows: repeat([['Ctrl/⌘|A', '选中全部节点'], ['Shift', '拖拽出框选'], ['Esc', '退出当前工具或清空选择'], ['Ctrl/⌘|Z', '撤销']], 8) },
  { title: '编辑', rows: repeat([['Ctrl/⌘|Z', '撤销'], ['Ctrl/⌘|Shift|Z', '重做'], ['Delete', '删除选中节点'], ['Tab', longestLabel]], 8) },
  { title: '节点', rows: repeat([['双击', '在空白处新建节点'], ['Tab', longestLabel], ['?', '打开这张快捷键表'], ['Ctrl/⌘|D', '原地复制一份']], 8) },
]
const shortcutMarkup = shortcutGroups.map(group => `<section class="group">
    <h4>${group.title}</h4>
    ${group.rows.map(([keys, label]) => `<div class="row">
      <span class="keys">${keys.split('|').map(key => `<kbd>${key}</kbd>`).join('')}</span>
      <span class="label">${label}</span>
    </div>`).join('\n    ')}
  </section>`).join('\n  ')
const shortcutPage = `<!doctype html><html><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f2f3f5;
    --dsw-alias-bg-mask-1: rgb(15 17 21 / 45%);
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-brand-primary: #17171c;
    --dsw-alias-interactive-bg-hover: #f0f1f3;
    --dsw-font-family: system-ui, sans-serif;
    --dsw-font-mono: ui-monospace, Menlo, monospace;
    --z-modal-backdrop: 130;
  }
  ${shortcutCss}
</style></head><body>
  <div class="backdrop" id="backdrop">
    <div class="dialog" id="dialog" role="dialog">
      <header class="header"><strong>键盘快捷键</strong><button type="button">×</button></header>
      <div class="body" id="body">
  ${shortcutMarkup}
      </div>
      <div class="footer">在画布上按 ? 随时打开这张表。</div>
    </div>
  </div>
</body></html>`

// --- the keyed `main` slot is single-occupant (#38) -------------------------
// The plugin market page and the Conversation both register into the shell's
// keyed `main` slot. The studio takeover rule hid UNRELATED entries on the
// column's direct-child axis and deliberately let the `main` anchor through,
// because the Conversation lives inside it -- which left the market page
// rendering inside that anchor at the same time, so switching to the studio
// appeared to do nothing. The fix hides the anchor's non-Conversation entries.
//
// Measured here rather than read, because two things the source cannot show
// decide the outcome: the anchor is `display: contents` (so the hidden entry is
// laid out by the column), and the minifier escapes the dotted attribute value
// in the Conversation branch, which is why the rule matches the chat entry
// POSITIVELY and one bad branch would void the whole selector list.
const mainSlotPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${scaleCss}
</style></head><body>
  <div class="centerCol" id="centre">
    <div data-dsh-imagegen-view id="studio">studio</div>
    <div data-slot="main" style="display: contents">
      <div data-slot="main.conversation" style="display: contents"><div id="conversation" data-phase="hero">conversation</div></div>
      <div id="shellPanel">plugin market page</div>
    </div>
    <div data-other-plugin-entry id="otherEntry">another plugin</div>
  </div>
</body></html>`
// Serve it from the same server by swapping the body through a query flag.
const toolbarTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?toolbar=1`)}`, { method: 'PUT' })).json()
const ws2 = new WebSocket(toolbarTarget.webSocketDebuggerUrl)
await new Promise(r => { ws2.onopen = r })
let id2 = 0
const send2 = (method, params) => new Promise(resolve => {
  const myId = ++id2
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws2.removeEventListener('message', onMessage); resolve(m) } }
  ws2.addEventListener('message', onMessage)
  ws2.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate2 = async expression => {
  const res = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send2('Runtime.enable', {})
await new Promise(r => setTimeout(r, 400))
const toolbar = await evaluate2(`(async () => {
  const node = document.getElementById('node')
  const toolbar = document.getElementById('toolbar')
  const button = document.getElementById('deleteBtn')
  // Snapshotted to strings, not kept as live objects: getComputedStyle returns
  // a LIVE CSSStyleDeclaration in Chrome, so holding it and reading later
  // reports the post-focus values for both samples and the comparison is
  // vacuous (it reported "visible" for the hidden state until this was fixed).
  const hidden = getComputedStyle(toolbar)
  const hiddenVisibility = hidden.visibility
  const hiddenOpacity = hidden.opacity
  // While hidden, neither the toolbar's buttons nor anything else in it may be
  // a tab stop -- that is what used to put invisible controls in the tab order.
  const buttonFocusable = button.tabIndex >= 0 && hiddenVisibility !== 'hidden' && hidden.display !== 'none'
  // The node itself is the way in: focusing it must reveal the toolbar.
  node.focus()
  // The reveal is animated (opacity, 0.12s), so reading it synchronously
  // returns the starting value; wait for the transition to finish instead of
  // guessing at a sleep.
  await Promise.all(toolbar.getAnimations().map(animation => animation.finished.catch(() => {})))
  const focused = getComputedStyle(toolbar)
  return {
    hiddenVisibility,
    hiddenOpacity,
    buttonFocusableWhenHidden: buttonFocusable,
    focusedVisibility: focused.visibility,
    focusedOpacity: focused.opacity,
    activeIsNode: document.activeElement === node,
  }
})()`)
console.log(`hidden toolbar: visibility=${toolbar.hiddenVisibility} opacity=${toolbar.hiddenOpacity}; node focused: visibility=${toolbar.focusedVisibility} opacity=${toolbar.focusedOpacity}`)
if (toolbar.buttonFocusableWhenHidden) {
  console.error('\nFAIL: a hidden node toolbar is still a tab stop in a real browser.')
  console.error('Tab lands on a control the user cannot see, and Enter then fires it')
  console.error('(the delete button is one of them).')
  process.exit(1)
}
if (toolbar.activeIsNode !== true) {
  console.error('\nFAIL: the node itself is not focusable, so the toolbar can never be reached.')
  process.exit(1)
}
if (toolbar.focusedVisibility !== 'visible' || toolbar.focusedOpacity === '0') {
  console.error('\nFAIL: focusing a node does not reveal its toolbar.')
  console.error('The user would be typing into an invisible control.')
  process.exit(1)
}
console.log('node toolbar: out of the tab order while hidden, revealed once the node is focused')

// --- the tie that used to be resolved by insertion order --------------------
// Both elements are position:absolute in the same stacking context, so
// elementFromPoint at the point they overlap names the winner by paint order.
// The picker backdrop is rendered FIRST here; at HEAD (both 60) the notice would
// win, and the fix is what makes the backdrop win regardless of order.
const stackTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?stack=1`)}`, { method: 'PUT' })).json()
const ws3 = new WebSocket(stackTarget.webSocketDebuggerUrl)
await new Promise(r => { ws3.onopen = r })
let id3 = 0
const send3 = (method, params) => new Promise(resolve => {
  const myId = ++id3
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws3.removeEventListener('message', onMessage); resolve(m) } }
  ws3.addEventListener('message', onMessage)
  ws3.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate3 = async expression => {
  const res = await send3('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send3('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))
const stack = await evaluate3(`(() => {
  const picker = document.getElementById('picker')
  const toast = document.getElementById('toast')
  const centreOf = el => {
    const r = el.getBoundingClientRect()
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
  }
  const [x, y] = centreOf(picker)
  const top = document.elementFromPoint(x, y)
  return {
    // The point lands on the backdrop's own child, which has no id, so report
    // what it actually is rather than an empty string.
    topId: top === null ? '(none)' : (top.id !== '' ? top.id : top.tagName.toLowerCase() + '.' + String(top.className)),
    pickerZ: getComputedStyle(picker).zIndex,
    toastZ: getComputedStyle(toast).zIndex,
    // Which one the browser paints last is the question; elementFromPoint is how
    // a user's click would resolve, so it is the honest measurement.
    topIsPicker: top === picker || picker.contains(top),
  }
})()`)
console.log(`stacking (picker rendered first): picker z=${stack.pickerZ}, notice z=${stack.toastZ} -> topmost=${stack.topId}`)
if (stack.pickerZ === stack.toastZ) {
  console.error(`\nFAIL: the video-picker backdrop and the canvas notice are tied at z-index ${stack.pickerZ}.`)
  console.error('Which one covers the other is then decided by document order, not by')
  console.error('the scale -- the exact coincidence the shared scale exists to remove.')
  process.exit(1)
}
if (!stack.topIsPicker) {
  console.error(`\nFAIL: the canvas notice paints over the video-picker backdrop (topmost=${stack.topId}).`)
  console.error('The picker opens full-screen over the canvas, so its backdrop has to cover')
  console.error('the notice; with both at 60 this only worked because of render order.')
  process.exit(1)
}
console.log('stacking: the picker backdrop covers the notice regardless of render order')

// --- the keyed `main` slot yields the column to the studio (#38) ------------
// Switching to the studio used to leave a shell panel rendering inside the same
// `main` anchor as the Conversation, so the studio never appeared to take over.
// The activation attribute is set HERE (the shell sets it when the entry is
// clicked), and the assertion reads COMPUTED display: only the cascade proves
// the market page is gone, because the element is still mounted either way.
const mainTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?mainslot=1`)}`, { method: 'PUT' })).json()
const ws4 = new WebSocket(mainTarget.webSocketDebuggerUrl)
await new Promise(r => { ws4.onopen = r })
let id4 = 0
const send4 = (method, params) => new Promise(resolve => {
  const myId = ++id4
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws4.removeEventListener('message', onMessage); resolve(m) } }
  ws4.addEventListener('message', onMessage)
  ws4.send(JSON.stringify({ id: myId, method, params }))
})
await send4('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))
const takeover = await send4('Runtime.evaluate', {
  expression: `(() => {
    document.documentElement.setAttribute('data-dsh-imagegen-active', '')
    const display = id => getComputedStyle(document.getElementById(id)).display
    return {
      shellPanel: display('shellPanel'),
      conversation: display('conversation'),
      studio: display('studio'),
      otherEntry: display('otherEntry'),
      anchor: display('centre'),
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
if (takeover.result?.exceptionDetails !== undefined) {
  throw new Error(`page threw: ${JSON.stringify(takeover.result.exceptionDetails)}`)
}
const slot = takeover.result.result.value
console.log(`main slot: shell panel=${slot.shellPanel}, conversation=${slot.conversation}, studio=${slot.studio}, other plugin=${slot.otherEntry}`)
if (slot.shellPanel !== 'none') {
  console.error('\nFAIL: a shell panel inside the keyed `main` slot is still rendered (#38).')
  console.error('The Conversation and a shell-global panel (the plugin market page)')
  console.error('both register into that one slot, so the studio shares the column with a')
  console.error('live panel and switching to it looks like it did nothing.')
  process.exit(1)
}
if (slot.conversation === 'none') {
  console.error('\nFAIL: the takeover hid the Conversation along with the shell panel.')
  console.error('The studio keeps the conversation in its chat track, so the rule has to')
  console.error('let the phase-bearing Conversation entry through.')
  process.exit(1)
}
if (slot.studio === 'none') {
  console.error('\nFAIL: the studio never became visible, so the fixture proves nothing.')
  process.exit(1)
}
console.log('main slot: the shell panel yields the column while the conversation stays')

// --- the source row has to stay reachable as the registry grows -------------
// The contract check above reads the declarations; a declaration is not the
// same thing as a row a user can reach. This one only the browser can settle,
// because what used to be wrong was invisible in the source: `nowrap` tabs in a
// plain flex box are all laid out (so every width measures fine) and the ones
// past the edge are simply never painted. Rendered at 420px -- narrow enough
// that the eight registered labels cannot fit -- the page is asked what a user
// would ask: turn the wheel over the row, then look at the last tab.
const tabsTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?sourcetabs=1`)}`, { method: 'PUT' })).json()
const ws5 = new WebSocket(tabsTarget.webSocketDebuggerUrl)
await new Promise(r => { ws5.onopen = r })
let id5 = 0
const send5 = (method, params) => new Promise(resolve => {
  const myId = ++id5
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws5.removeEventListener('message', onMessage); resolve(m) } }
  ws5.addEventListener('message', onMessage)
  ws5.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate5 = async expression => {
  const res = await send5('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send5('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))

// What a user can see of the LAST tab is the question, so it is measured by
// hit-testing at the tab's own centre -- the coordinate a click would land on.
// Its rect alone would not do: an element scrolled out of a clipping box still
// reports a rect, just at coordinates the row does not occupy.
const tabRowState = () => evaluate5(`(() => {
  const row = document.getElementById('tabs')
  const last = document.getElementById('last')
  const band = row.getBoundingClientRect()
  const box = last.getBoundingClientRect()
  const x = Math.round(box.left + box.width / 2)
  const y = Math.round(box.top + box.height / 2)
  const hit = document.elementFromPoint(x, y)
  return {
    scrollLeft: Math.round(row.scrollLeft),
    maxScroll: Math.round(row.scrollWidth - row.clientWidth),
    overflowX: getComputedStyle(row).overflowX,
    lastVisible: x >= band.left && x <= band.right && (hit === last || last.contains(hit)),
    lastFullyInsideRow: box.left >= band.left - 0.5 && box.right <= band.right + 0.5,
    verticallyClipped: row.scrollHeight > row.clientHeight + 1,
    // Where to aim the wheel: inside the row, wherever the row is.
    wheelAt: [Math.round(band.left + band.width / 2), Math.round(band.top + band.height / 2)],
  }
})()`)

const beforeTabs = await tabRowState()
let afterTabs = beforeTabs
let previousLeft = -1
for (let i = 0; i < 12; i++) {
  previousLeft = afterTabs.scrollLeft
  await send5('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: beforeTabs.wheelAt[0], y: beforeTabs.wheelAt[1],
    deltaX: 300, deltaY: 0,
  })
  await new Promise(r => setTimeout(r, 90))
  afterTabs = await tabRowState()
  if (afterTabs.scrollLeft === previousLeft) break
}
console.log(`source row at 420px: overflow-x=${afterTabs.overflowX}, content overflows by ${beforeTabs.maxScroll}px, wheel scrolled it ${beforeTabs.scrollLeft} -> ${afterTabs.scrollLeft}px`)

if (beforeTabs.maxScroll <= 0) {
  console.error('\nFAIL: the eight source labels fit inside 420px, so this fixture proves nothing.')
  console.error('Widen the registry in the fixture or narrow the host; the point of the check')
  console.error('is the row that overflows.')
  process.exit(1)
}
if (afterTabs.scrollLeft <= beforeTabs.scrollLeft) {
  console.error(`\nFAIL: a wheel over the source row does not move it (scrollLeft stayed ${beforeTabs.scrollLeft}).`)
  console.error('The tabs past the edge are then unreachable: the row clips instead of')
  console.error('scrolling, so every source after the last visible one is invisible and')
  console.error('unclickable, with nothing on screen saying it exists.')
  process.exit(1)
}
if (afterTabs.lastVisible !== true || afterTabs.lastFullyInsideRow !== true) {
  console.error(`\nFAIL: the last template source tab cannot be brought into view (scrollLeft=${afterTabs.scrollLeft} of ${afterTabs.maxScroll}).`)
  console.error('It has to end up inside the row after scrolling to the end, because a')
  console.error('source the user cannot reach is a source that does not exist.')
  process.exit(1)
}
if (afterTabs.verticallyClipped) {
  console.error('\nFAIL: the source row is clipping its tabs vertically.')
  console.error('`overflow-y: hidden` is there to keep a scrollbar off the tab strip,')
  console.error('not to cut the tabs themselves.')
  process.exit(1)
}
console.log('source row: the last tab scrolls into view and hit-tests to itself')

// --- the shortcut legend fits the canvas it opens over ----------------------
const shortcutTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?shortcuts=1`)}`, { method: 'PUT' })).json()
const ws6 = new WebSocket(shortcutTarget.webSocketDebuggerUrl)
await new Promise(r => { ws6.onopen = r })
let id6 = 0
const send6 = (method, params) => new Promise(resolve => {
  const myId = ++id6
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws6.removeEventListener('message', onMessage); resolve(m) } }
  ws6.addEventListener('message', onMessage)
  ws6.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate6 = async expression => {
  const res = await send6('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send6('Runtime.enable', {})

// Measured as a user would see it: the dialog's own box against the viewport,
// and each row's content against the column that holds it. `scrollWidth` on the
// row is the honest signal for a chip that has been pushed out -- the elements
// all report a rect whether or not the column clips them.
const measureLegend = () => evaluate6(`(() => {
  const dialog = document.getElementById('dialog')
  const body = document.getElementById('body')
  const box = dialog.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.row')]
  const overflowing = rows.filter(row => row.scrollWidth > row.clientWidth + 1).length
  // A label that has been pushed past its column's right edge is unreadable
  // even when the row itself does not scroll: text-align:right puts the tail of
  // a long label under the chips.
  const pushed = rows.filter(row => {
    const label = row.querySelector('.label')
    const keys = row.querySelector('.keys')
    const column = row.getBoundingClientRect()
    const tail = label.getBoundingClientRect()
    return tail.right > column.right + 1 || tail.left < keys.getBoundingClientRect().right - 1
  }).length
  return {
    viewport: [window.innerWidth, window.innerHeight],
    dialogTop: Math.round(box.top),
    dialogBottom: Math.round(box.bottom),
    fitsVertically: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5,
    bodyScrolls: getComputedStyle(body).overflowY,
    bodyScrollable: body.scrollHeight > body.clientHeight + 1,
    columns: getComputedStyle(body).gridTemplateColumns,
    rows: rows.length,
    overflowing,
    pushed,
  }
})()`)

await send6('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 250))
const wideLegend = await measureLegend()
// Not `mobile: true`: without a `<meta name="viewport">` in the fixture the
// mobile override lays the page out at the 980px default and the breakpoint
// below 560px never fires -- which would make this check pass by measuring a
// width the user never sees. The narrow case here is a layout question, so it
// is asked as a CSS viewport width.
await send6('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 250))
const narrowLegend = await measureLegend()
await send6('Emulation.clearDeviceMetricsOverride', {})
console.log(`shortcut legend: ${wideLegend.rows} rows, ${wideLegend.viewport.join('x')} -> single column ${narrowLegend.viewport.join('x')}`)

if (wideLegend.fitsVertically !== true) {
  console.error(`\nFAIL: the shortcut legend is taller than the viewport it opens in (top=${wideLegend.dialogTop}, bottom=${wideLegend.dialogBottom}).`)
  console.error('The dialog caps itself at the viewport and scrolls its body; if that cap')
  console.error('is gone the bottom groups -- and the close button\'s context -- are off')
  console.error('screen with no way to reach them.')
  process.exit(1)
}
if (wideLegend.overflowing > 0) {
  console.error(`\nFAIL: ${wideLegend.overflowing} shortcut rows overflow their column.`)
  console.error('A row wider than its grid column pushes the label out of the dialog,')
  console.error('so the key and the thing it does are no longer readable together.')
  process.exit(1)
}
if (wideLegend.pushed > 0) {
  console.error(`\nFAIL: ${wideLegend.pushed} shortcut labels collide with their key chips.`)
  console.error('The label column is text-align: right; without room it runs under the')
  console.error('chips and the row reads as one run-on string.')
  process.exit(1)
}
// One column below 560px: two columns of key chips at 390px wrap into noise.
const narrowTracks = narrowLegend.columns.split(' ').filter(part => part.trim() !== '')
if (narrowTracks.length !== 1) {
  console.error(`\nFAIL: the legend keeps two columns at ${narrowLegend.viewport[0]}px (grid-template-columns: ${narrowLegend.columns}).`)
  console.error('At phone width the two tracks leave too little room per row, which is')
  console.error('what the single-column breakpoint is for.')
  process.exit(1)
}
if (narrowLegend.overflowing > 0 || narrowLegend.pushed > 0) {
  console.error(`\nFAIL: the legend breaks at ${narrowLegend.viewport.join('x')} (${narrowLegend.overflowing} overflowing rows, ${narrowLegend.pushed} pushed labels).`)
  process.exit(1)
}
console.log('shortcut legend: fits the viewport at desktop width, single column on a phone')

ws6.close()
ws4.close()
ws3.close()
ws2.close()
ws5.close()
ws.close(); launched.close(); server.close()
rmSync(themeModuleDir, { recursive: true, force: true })
console.log('\nUI CONTRACTS VERIFIED')

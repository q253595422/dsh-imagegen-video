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

import { readFileSync, existsSync, globSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findChrome () {
  const explicit = process.argv[2] ?? process.env.CHROME_HEADLESS_SHELL
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : null
  const candidates = [
    ...globSync('/tmp/chromium/chrome-headless-shell/*/*/chrome-headless-shell').sort().reverse(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...globSync(`${process.env.HOME ?? ''}/.cache/puppeteer/**/chrome-headless-shell`).sort().reverse(),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

const CHROME = findChrome()
if (CHROME === null) {
  console.error('\n' + '='.repeat(72))
  console.error('SKIP: no headless Chromium found -- the UI contract guards did NOT run.')
  console.error('This is a MISSING TOOL, not a regression. Install chrome-headless-shell,')
  console.error('or point CHROME_HEADLESS_SHELL at a Chromium binary, to gate on these.')
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}

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
  else res.end(page)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const CDP_PORT = 9900 + Math.floor(Math.random() * 300)
const browser = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${tmpdir()}/dsh-ui-contracts-${process.pid}`, 'about:blank'], { stdio: 'ignore' })
const waitCdp = async () => {
  for (let i = 0; i < 60; i++) {
    // Deliberately swallowed: this is a readiness poll, and "connection
    // refused" is the expected answer until Chromium has finished booting.
    // The loop's own deadline is the real failure path (it throws below).
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('CDP down')
}
await waitCdp()
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
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
// Serve it from the same server by swapping the body through a query flag.
const toolbarTarget = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?toolbar=1`)}`, { method: 'PUT' })).json()
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
const stackTarget = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?stack=1`)}`, { method: 'PUT' })).json()
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

ws3.close()
ws2.close()
ws.close(); browser.kill(); server.close()
rmSync(themeModuleDir, { recursive: true, force: true })
console.log('\nUI CONTRACTS VERIFIED')

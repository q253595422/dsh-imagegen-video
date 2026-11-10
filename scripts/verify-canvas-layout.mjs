/**
 * Real-browser layout guard for the canvas's bottom chrome.
 *
 * WHY: the dock, the zoom dock and the minimap used to be three independently
 * positioned absolute layers (`left: 50%`, `left: 14px`, `left: 14px; bottom:
 * 62px`), so none of them knew the others' size. At the panel width the canvas
 * really gets in the three-column studio (about 1000px, not the window's
 * 1280px) the 711px job dock overlapped the 236px zoom dock by 107px and
 * covered its leftmost buttons (select / pan / add image / add text). No media
 * query can catch that: the overlap depends on the PANEL's width, and jsdom has
 * no layout engine at all, so the jsdom suites stayed green throughout.
 *
 * The fix puts all three in one wrapping flex row. This guard measures the
 * result at several panel widths and requires: no pairwise overlap, and every
 * piece inside the canvas.
 *
 * The fixture is hand-written HTML, so — like verify-video-layout.mjs — every
 * class it uses is resolved against the real component and stylesheet first. A
 * fixture that keeps rendering an old structure would measure a component that
 * no longer exists and stay green.
 *
 * Run: node scripts/verify-canvas-layout.mjs [path-to-chrome]
 * Skips loudly (exit 0) when no Chromium is available: a missing tool is not a
 * failing contract.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { assertFixtureClasses } from './lib/fixture-classes.mjs'
import { canvasSourceText } from './lib/canvas-source.mjs'

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the canvas chrome layout guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = canvasSourceText()

/**
 * Panel widths to measure.
 *
 * 997 is the canvas in the three-column studio inside a 1280px window — the
 * exact situation the overlap was reported in. The narrower ones are the
 * canvas alone in a small window, where the row has to wrap instead of
 * overflowing.
 */
const PANEL_WIDTHS = [997, 860, 720, 560, 420]

/** The 17 dock tiles, in the order the component renders them. */
const DOCK_TILES = [
  'select', 'pan', 'image', 'text', 'sketch', 'file', 'config', 'storyboard', 'template',
  'skill', 'workflow', 'timeline', 'background', 'help', 'undo', 'redo', 'trash',
]
/** Divider positions in that list (LibTV 式分组：工具 / 建节点 / 库 / 运行 / 撤销 / 删除). */
const DIVIDERS_AT = new Set([2, 8, 10, 13, 16])

// ------------------------------------------------- fixture vs. real component
// Validation runs on the fixture MARKUP below, not on a hand-kept list: a list
// can be edited to match a renamed class and quietly re-green the guard. The
// validator is shared with verify-video-layout.mjs, which had the only copy.

// The tokens the stylesheet reads, stood up with flat values. Layout does not
// depend on what they resolve to, only that they resolve.
const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

const dockMarkup = DOCK_TILES
  .map((name, index) => `${DIVIDERS_AT.has(index) ? '<span class="dockDivider"></span>' : ''}<div class="dockItem" data-dock-item=""><button class="iconButton" aria-label="${name}"></button></div>`)
  .join('')

const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #fff; --dsw-shadow-lv2: 0 2px 8px #0002; --dsw-shadow-lv3: 0 6px 20px #0003; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
${css}
</style></head><body>
<div class="root" id="root">
  <header class="topBar"><span class="topBarSpacer"></span></header>
  <div class="viewport" id="viewport">
    <div class="canvasChrome" id="chrome">
      <div class="chromeSide">
        <aside class="minimap" id="minimap"><div class="minimapCanvas"><div class="minimapViewport" style="left:12px;top:14px;width:120px;height:70px"></div></div></aside>
        <div class="zoomDock" id="zoomDock">
          <button class="iconButton"></button><button class="iconButton"></button>
          <button class="iconButton"></button><button class="iconButton"></button>
          <button class="zoomValue">100%</button>
        </div>
      </div>
      <div class="dockOuter" id="dockOuter"><div class="dock" id="dock" role="toolbar">${dockMarkup}</div></div>
    </div>
  </div>
</div></body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

assertFixtureClasses({
  page,
  componentSource,
  componentName: 'CanvasWorkspace.tsx',
  stylesheet: css,
  stylesheetName: 'canvas-workspace.module.css',
  // Names of its own, so this proves the validator rather than the fixture.
  selfTest: ['canvasThisClassDoesNotExist', 'dock'],
})

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-canvas-layout' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { send, evaluate } = session

const MEASURE = `JSON.stringify((() => {
  const box = id => document.getElementById(id).getBoundingClientRect()
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const viewport = box('viewport'), dock = box('dock'), zoom = box('zoomDock'), minimap = box('minimap')
  const inside = (r) => r.left >= viewport.left - 1 && r.right <= viewport.right + 1
    && r.top >= viewport.top - 1 && r.bottom <= viewport.bottom + 1
  return {
    dockZoom: overlap(dock, zoom),
    dockMinimap: overlap(dock, minimap),
    zoomMinimap: overlap(zoom, minimap),
    dockInside: inside(dock), zoomInside: inside(zoom), minimapInside: inside(minimap),
  }
})())`

const failures = []
for (const width of PANEL_WIDTHS) {
  // A real content column, not a window: `Emulation.setDeviceMetricsOverride`
  // is the only way to pin the width (chrome-headless-shell ignores window
  // flags), and the page is one column so the viewport IS the panel.
  await send('Emulation.setDeviceMetricsOverride', { width, height: 767, deviceScaleFactor: 1, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 250))
  const measured = JSON.parse(await evaluate(MEASURE))

  const overlaps = measured.dockZoom + measured.dockMinimap + measured.zoomMinimap
  const inside = measured.dockInside && measured.zoomInside && measured.minimapInside
  const problem = overlaps > 0
    ? `the bottom chrome overlaps itself (${measured.dockZoom + measured.dockMinimap + measured.zoomMinimap}px² of shared area)`
    : !inside ? 'a piece of the bottom chrome is outside the canvas'
      : null
  console.log(`panel ${String(width).padStart(4)}px  dock/zoom ${measured.dockZoom}px²  dock/minimap ${measured.dockMinimap}px²  inside ${inside}`)
  if (problem !== null) failures.push(`${width}px: ${problem}`)
}

session.close(); launched.close(); server.close()

if (failures.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: the canvas bottom chrome does not fit the canvas.')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('The dock, the zoom dock and the minimap share one wrapping flex row')
  console.error('(see `.canvasChrome`); they must never paint over each other.')
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log('CANVAS BOTTOM CHROME FITS AT EVERY PANEL WIDTH')

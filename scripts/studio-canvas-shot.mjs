/**
 * Shoot ONLY the canvas workspace's first-run screen.
 *
 * WHY a separate script from `studio-preview-shot.mjs`: that one is the full
 * visual-acceptance suite (both themes, contrast audit, drag probes, teardown),
 * so it takes a while and reports on the whole studio. This one exists to answer
 * a single question — what does a brand-new canvas look like — and to leave a
 * PNG behind that a person can look at. A brand-new canvas is empty: the
 * first-run screen is the quick-start row, and no canvas is written to disk
 * until the user puts something in it.
 *
 * The theme stylesheet is the one from the INSTALLED DSH, read through the same
 * helper the acceptance suite uses, so this picture is painted with the real
 * `--dsw-alias-*` tokens rather than a copy that drifts when the shell restyles.
 *
 * Run: node scripts/studio-canvas-shot.mjs [--out FILE]
 * Exit 0 = wrote the PNG. Skips loudly (exit 0) when no Chromium is available.
 */

import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshNodeModules, themeCss } from './lib/dsh-theme.mjs'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, '.studio-preview', 'preview.js')

/**
 * `--out FILE`, read without touching `process.argv[2]`'s meaning.
 *
 * `findChrome()` treats `argv[2]` as an explicit Chromium path (so a script can
 * be pointed at a specific binary). Reading `--out` with the same index made
 * every `--out` run look for a browser called `--out`: the shot skipped with
 * "no headless Chromium found", which reads as a missing tool rather than as
 * an argument the script itself had mis-parsed.
 */
function outputPath(argv) {
  const index = argv.indexOf('--out')
  return index > 0 && argv[index + 1] !== undefined
    ? argv[index + 1]
    : join(ROOT, '.studio-preview', 'canvas-first-run.png')
}
const OUT = outputPath(process.argv)

/**
 * The quietest host page that still lets the panel mount.
 *
 * Deliberately NOT the acceptance fixture: that one lays out a whole DSH shell
 * so it can audit the sidebar's colours, and the canvas only needs the mount
 * anchors. A minimal host also makes the screenshot about the canvas rather
 * than about the fake conversation beside it.
 *
 * The two anchors are not decoration — `mountPanel` looks for
 * `[data-slot="main"]` and walks to its nearest non-`display:contents`
 * ancestor, so a page without them mounts nothing and the probe would report
 * "never appeared" without saying why.
 */
const NODE_MODULES = dshNodeModules()
if (NODE_MODULES === null) {
  console.error('\nSKIP: no installed DSH found -- the canvas shot needs its theme tokens.')
  console.error('Set DSH_ASAR_DIR to a DSH `node_modules` directory, or install DSH through npx once.')
  process.exit(0)
}
const THEME = themeCss(NODE_MODULES)

const PAGE = `<!doctype html>
<html lang="zh-CN" data-platform="darwin"><head><meta charset="utf-8"><title>canvas first run</title>
<style>${THEME}</style>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font: 13px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif;
  }
  #shell { display: flex; height: 100%; }
  #column { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  #panel-slot { flex: 1 1 auto; min-height: 0; display: flex; }
</style></head>
<body>
  <div id="shell">
    <div id="column" data-pane="conversation">
      <div data-slot="main" style="display:contents">
        <div id="panel-slot"></div>
      </div>
    </div>
  </div>
  <script src="/preview.js"></script>
</body></html>`

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url.startsWith('/?')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
  }
  if (url.split('?')[0] === '/preview.js') {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': statSync(BUNDLE).size,
    })
    createReadStream(BUNDLE).pipe(response)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the canvas first-run screenshot was NOT taken.')

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-canvas-shot', args: ['--hide-scrollbars'] })
const page = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)

let failure
try {
  await page.send('Page.enable', {})
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: 820, deviceScaleFactor: 2, mobile: false,
  })

  /** Poll a predicate in the page; fail with a real message instead of sleeping. */
  const waitFor = async (expression, what, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if ((await page.evaluate(expression)) === true) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  /**
   * Wait for the mount the bundle performs on load — deliberately NOT
   * `__studioRemount()`.
   *
   * That hook tears down nothing: it calls `mountPanel` a second time, so the
   * page ends up with two fully separate React trees. The tab lives in the
   * first one and the workspace state it flips belongs to that tree, while the
   * screenshot shows whatever is painted last — the second tree's default
   * workspace. Clicking a tab in one tree and photographing the other reads as
   * "the canvas never opened".
   */
  await waitFor(
    `document.querySelector('[data-studio-workspace]') !== null
      || [...document.querySelectorAll('button')].some(node => (node.textContent ?? '').trim() === '无限画布')`,
    'the studio to mount',
  )

  // Switch to the canvas workspace through its tab, not by poking state: the tab
  // is what a first-run user actually clicks. The label is the workspace tab
  // ("无限画布"), not the key passed to `setWorkspace`.
  const clicked = await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('button, [role="tab"]')]
    const canvasTab = tabs.find(node => (node.textContent ?? '').trim() === '无限画布')
    if (canvasTab === undefined) return false
    canvasTab.click()
    return true
  })()`)
  if (clicked !== true) throw new Error('could not find the 无限画布 workspace tab')

  // A brand-new canvas is an EMPTY canvas with the quick-start row on it. It
  // used to open on a seeded example pair instead, and this script asserted
  // that — the assertion is now the opposite one, because creating that pair
  // (and the canvas it lived on) the moment the tab was opened is exactly what
  // the empty state was hiding.
  await waitFor(
    `document.querySelectorAll('[data-quick-card]').length === 6`,
    'the six quick-start cards to render',
  )
  // Nothing is written until the first edit, so "已保存" would be a lie here:
  // the status strip must say the canvas is a draft.
  await waitFor(
    `document.body.innerText.includes(${JSON.stringify('未保存')})`,
    'the draft state to show in the status strip',
  )

  await new Promise(resolve => setTimeout(resolve, 300))
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = shot.result?.data
  if (typeof data !== 'string' || data.length === 0) throw new Error('no screenshot data')

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, Buffer.from(data, 'base64'))

  /**
   * Read the quick cards and the empty-state copy.
   *
   * `[data-quick-card]` is the contract the smoke suite also uses, so this shot
   * and that check cannot drift into describing two different first screens.
   * `hasSeed` is asserted FALSE on purpose: a seeded node appearing here again
   * would mean the first-run canvas is being written to disk before the user
   * did anything.
   */
  const seen = await page.evaluate(`(() => ({
      cards: [...document.querySelectorAll('[data-quick-card]')].map(card => card.getAttribute('data-quick-card')),
      hasTitle: document.body.innerText.includes('示例提示词'),
      hasSeed: document.querySelectorAll('[data-node-id]').length > 0,
      hasLeaveHint: document.body.innerText.includes('开始你的创作'),
    }))()`)
  console.log(JSON.stringify({ out: OUT, ...seen }, null, 1))
  if (Array.isArray(seen.cards) !== true || seen.cards.length !== 6) {
    throw new Error(`the quick-start row did not render: ${JSON.stringify(seen)}`)
  }
  if (seen.hasSeed === true || seen.hasTitle === true) {
    throw new Error(`a new canvas should start empty, but nodes were rendered: ${JSON.stringify(seen)}`)
  }
} catch (error) {
  failure = error
} finally {
  await page.close()
  launched.close()
  server.close()
}

if (failure !== undefined) {
  console.error(String(failure.stack ?? failure))
  process.exit(1)
}
console.log(`canvas first-run screenshot written to ${OUT}`)

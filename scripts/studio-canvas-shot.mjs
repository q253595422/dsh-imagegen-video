/**
 * Shoot ONLY the canvas workspace's first-run screen.
 *
 * WHY a separate script from `studio-preview-shot.mjs`: that one is the full
 * visual-acceptance suite (both themes, contrast audit, drag probes, teardown),
 * so it takes a while and reports on the whole studio. This one exists to answer
 * a single question — what does a brand-new canvas look like — and to leave a
 * PNG behind that a person can look at.
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

  await waitFor(
    `document.body.innerText.includes(${JSON.stringify('示例提示词')})`,
    'the seed example node to render',
  )
  // The seed document is created unsaved and written after the 650 ms autosave
  // debounce. Shooting before that lands catches the "保存中…" state — a
  // screenshot of a first-run canvas that looks stuck is worth nothing.
  await waitFor(
    `document.body.innerText.includes(${JSON.stringify('已保存')})`,
    'the seed canvas to finish its first save',
  )

  await new Promise(resolve => setTimeout(resolve, 300))
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = shot.result?.data
  if (typeof data !== 'string' || data.length === 0) throw new Error('no screenshot data')

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, Buffer.from(data, 'base64'))

  /**
   * Read the prompt out of the textarea's `value`, not `innerText`.
   *
   * A text node's body is a `<textarea>`: its text is a property, not a child
   * node, so `innerText` never contains it. Asserting on `innerText` reported
   * the example as missing while it sat there filled in — a false negative that
   * would have looked like a broken seed to anyone reading the failure.
   */
  const seen = await page.evaluate(`(() => {
    const node = document.querySelector('[data-node-id]')
    const area = node === null ? null : node.querySelector('textarea')
    const text = document.body.innerText
    return {
      hasTitle: text.includes('示例提示词'),
      hasPrompt: area !== null && area.value.includes('柴犬'),
      promptFits: area !== null && area.scrollHeight <= area.clientHeight,
      hasConfig: text.includes('生成配置'),
    }
  })()`)
  console.log(JSON.stringify({ out: OUT, ...seen }, null, 1))
  if (seen.hasTitle !== true || seen.hasPrompt !== true || seen.hasConfig !== true) {
    throw new Error(`the seed example did not render: ${JSON.stringify(seen)}`)
  }
  if (seen.promptFits !== true) {
    console.error('WARN: the example prompt overflows its text node and will need scrolling to read.')
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

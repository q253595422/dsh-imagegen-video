/**
 * Real-browser layout guard for the video studio's width.
 *
 * WHY: jsdom has no layout engine, so the jsdom suites cannot catch a layout
 * regression. The studio lives in a NARROW CENTRE COLUMN INSIDE A WIDE WINDOW,
 * which is exactly the case a `@media (max-width: ...)` query cannot detect —
 * media queries measure the window, not the panel. That combination once left
 * the composer capped at 420px (42% of the panel) while an empty sibling column
 * took the rest, which is the "太窄了" report this guards against.
 *
 * The check renders the real panel stylesheet in headless Chrome at the width
 * the user actually has and asserts the composer spans the panel.
 *
 * Run: node scripts/verify-video-layout.mjs [path-to-chrome-headless-shell]
 */

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const CHROME = process.argv[2] ?? process.env.CHROME_HEADLESS_SHELL ?? '/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const css = readFileSync('./src/client/panel.module.css', 'utf8')

// Reproduce the structure VideoPanel renders: the studio body inside a narrow
// centre column inside a wide window (the user's real situation).
const page = `<!doctype html><html><head><style>
  /* Stand in for the DSH theme tokens the panel relies on. */
  :root { ${[...new Set((css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? []))].map(t => `${t.slice(4, -1)}: #888`).join('; ')} }
  * { box-sizing: border-box; }
  body { margin: 0; display: flex; }
  .sidebar { width: 480px; flex: none; background: #222; }
  .centre { width: 1010px; flex: none; background: #111; }
  .right { flex: 1; background: #eee; }
  ${css}
</style></head><body>
  <div class="sidebar"></div>
  <div class="centre" id="centre"><div class="videoWorkspace" id="ws">
    <div class="videoBody" id="body">
      <section class="videoComposer" id="composer">
        <textarea class="videoPrompt" rows="5"></textarea>
        <div class="videoParams">
          <div class="videoParam"><span class="videoLabel">视频模型</span></div>
          <div class="videoParam"><span class="videoLabel">画面比例</span></div>
        </div>
        <div class="videoActions"><button class="videoGenerate">生成视频</button></div>
      </section>
      <section class="videoResults" id="results"><header class="videoResultsHead"><h3>本次生成</h3></header>
        <ul class="videoTaskList" id="tasks">
          <li class="videoTask"><div class="videoTaskHead"><span class="videoTaskModel">agnes-video-2.5-flash</span></div><video class="videoPlayer" src="x.mp4"></video></li>
          <li class="videoTask"><div class="videoTaskHead"><span class="videoTaskModel">agnes-video-2.5-flash</span></div><video class="videoPlayer" src="y.mp4"></video></li>
        </ul>
      </section>
      <section class="videoGallery" id="gallery"><header class="videoResultsHead"><h3>视频历史</h3></header><ul class="videoHistoryList" id="hist"><li class="videoHistoryItem">a</li></ul></section>
    </div>
  </div></div>
  <div class="right"></div>
</body></html>`

const server = (await import('node:http')).createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9444',
  '--user-data-dir=/tmp/framegrab/layout-profile', 'about:blank'], { stdio: 'ignore' })
const waitCdp = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:9444/json/version'); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('CDP down')
}
await waitCdp()
const target = await (await fetch(`http://127.0.0.1:9444/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws.removeEventListener('message', onMessage); resolve(m) } }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 400))
const res = await send('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) } }
    return { body: r(document.getElementById('body')), composer: r(document.getElementById('composer')), gallery: r(document.getElementById('gallery')), results: r(document.getElementById('results')), tasks: r(document.getElementById('tasks')), centre: r(document.getElementById('centre')) }
  })())`,
  returnByValue: true,
})
ws.close(); browser.kill(); server.close()
const out = JSON.parse(res.result.result.value)
console.log(JSON.stringify(out, null, 1))
const centre = out.centre.w
const share = Math.round((out.composer.w / centre) * 100)
console.log(`centre=${centre}px composer=${out.composer.w}px -> composer uses ${share}% of the panel width`)
if (share < 90) { console.error('STILL TOO NARROW'); process.exit(1) }
console.log('COMPOSER TAKES THE FULL PANEL WIDTH')

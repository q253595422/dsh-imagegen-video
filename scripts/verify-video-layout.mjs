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

import { readFileSync, existsSync, globSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

/**
 * Find a headless Chromium to drive.
 *
 * WHY this is not a hardcoded path: this script is part of `pnpm test`, and the
 * binary it originally pointed at lives under /tmp, which macOS clears on
 * reboot. A hard gate on a path that can legitimately disappear turns a missing
 * tool into a FAILING TEST, which is worse than no gate -- it trains people to
 * ignore the suite. So: try real candidates, and if none exists, SKIP loudly
 * (exit 0 with an unmissable banner) instead of reporting a layout regression
 * that was never measured.
 *
 * Override with CHROME_HEADLESS_SHELL=<path> or `node script.mjs <path>`.
 */
function findChrome () {
  const explicit = process.argv[2] ?? process.env.CHROME_HEADLESS_SHELL
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : null
  const candidates = [
    // Bundled shells, newest revision first (the agent tooling's usual location).
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
  console.error('SKIP: no headless Chromium found -- the width guard did NOT run.')
  console.error('This is a MISSING TOOL, not a layout regression: the composer width')
  console.error('is unverified in this run. Install chrome-headless-shell, or point')
  console.error('CHROME_HEADLESS_SHELL at a Chromium binary, to actually gate on it.')
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}
// Resolved relative to this script, not an absolute checkout path: the guard is
// part of `pnpm test` now, so a hardcoded /Users/... path would make it a gate
// that only works on the machine it was written on.
const css = readFileSync(new URL('../src/client/panel.module.css', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../src/client/VideoPanel.tsx', import.meta.url), 'utf8')

// ------------------------------------------------- fixture vs. real component
/**
 * The fixture below is hand-written HTML, which is exactly the weakness of a
 * layout guard: if VideoPanel renames a class or drops a section, the fixture
 * keeps rendering the OLD structure and this check stays green while measuring
 * a component that no longer exists. So every class the fixture uses is
 * resolved against the two real sources first, and a mismatch fails the run
 * before Chrome is even launched.
 *
 * Both directions are checked because each catches a different drift:
 *  - the component no longer uses it (`css.videoComposer` gone from the TSX):
 *    the fixture is measuring markup the panel does not render any more;
 *  - the stylesheet no longer defines it (`.videoComposer` gone from the CSS):
 *    the width being measured is not the width the panel gets.
 */
const componentClasses = new Set(
  [...panelSource.matchAll(/\bcss\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map(match => match[1]),
)
const stylesheetClasses = new Set(
  [...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]),
)

/** The fixture's classes that the component or the stylesheet does not know. */
function missingFixtureClasses (names) {
  const unknown = []
  for (const name of names) {
    if (!componentClasses.has(name)) unknown.push(`${name} (not rendered by VideoPanel.tsx)`)
    else if (!stylesheetClasses.has(name)) unknown.push(`${name} (not defined in panel.module.css)`)
  }
  return unknown
}

// Reproduce the structure VideoPanel renders: the studio body inside a narrow
// centre column inside a wide window (the user's real situation). The clip
// history section is deliberately absent because VideoPanel does not render it
// either — the shell sidebar owns that list (see the comment in the component).
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
          <!-- A finished clip now carries three actions (expand / add-to-canvas /
               add-to-chat), so the fixture must include them: the widest row is
               what decides whether the results column still fits the panel. -->
          <li class="videoTask"><div class="videoTaskHead"><span class="videoTaskModel">agnes-video-2.5-flash</span></div><video class="videoPlayer" src="x.mp4"></video><button>放大预览</button><button>加入画布</button><button>加入对话</button></li>
          <li class="videoTask"><div class="videoTaskHead"><span class="videoTaskModel">agnes-video-2.5-flash</span></div><video class="videoPlayer" src="y.mp4"></video><button>放大预览</button><button>加入画布</button><button>加入对话</button></li>
        </ul>
      </section>
    </div>
  </div></div>
  <div class="right"></div>
</body></html>`

// Read the class list OUT of the fixture markup rather than keeping a second
// copy of it: a hand-maintained list can be edited to match a renamed class and
// quietly re-green the guard, while this one cannot drift from what Chrome gets.
// `sidebar` / `centre` / `right` are the page scaffolding around the panel (they
// stand in for the DSH shell and are styled by the inline block below), not
// panel classes, so they are excluded by name.
const SCAFFOLD_CLASSES = new Set(['sidebar', 'centre', 'right'])
const fixtureClasses = [...new Set(
  [...page.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].trim().split(/\s+/)),
)].filter(name => !SCAFFOLD_CLASSES.has(name))

// Self-test, on names of its own so it proves the validator rather than the
// fixture: an invented class must be reported and a real one must not. A
// validator that always returned [] would let every stale fixture through.
if (missingFixtureClasses(['videoThisClassDoesNotExist']).length !== 1
  || missingFixtureClasses(['videoWorkspace']).length !== 0) {
  console.error('STALE FIXTURE GUARD: the class validator does not discriminate')
  process.exit(1)
}
const unknownClasses = missingFixtureClasses(fixtureClasses)
if (unknownClasses.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: the layout fixture no longer matches the real component.')
  console.error('These fixture classes are gone from the source:')
  for (const entry of unknownClasses) console.error(`  - ${entry}`)
  console.error('Update the fixture to the classes VideoPanel really renders, or the')
  console.error('width measured here is not the panel\'s width.')
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log(`fixture classes verified against VideoPanel.tsx + panel.module.css: ${fixtureClasses.length}`)

const server = (await import('node:http')).createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// A random DevTools port: a fixed one collides with any other headless browser
// (this repo's other scripts included), and the symptom is an opaque "CDP down".
const CDP_PORT = 9500 + Math.floor(Math.random() * 400)
const browser = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${tmpdir()}/dsh-imagegen-layout-${process.pid}`, 'about:blank'], { stdio: 'ignore' })
const waitCdp = async () => {
  for (let i = 0; i < 60; i++) {
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
await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 400))
const res = await send('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) } }
    return { body: r(document.getElementById('body')), composer: r(document.getElementById('composer')), results: r(document.getElementById('results')), tasks: r(document.getElementById('tasks')), centre: r(document.getElementById('centre')) }
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

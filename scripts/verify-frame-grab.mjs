/**
 * Real-browser verification of the canvas frame-grab path.
 *
 * Why this is not part of the jsdom suites: jsdom cannot decode video at all
 * (no codecs, no videoWidth), so the seek + canvas-capture path that "抽取当前帧"
 * depends on simply cannot be exercised there. This script runs the exact
 * algorithm from CanvasWorkspace.grabVideoFrame inside headless Chrome against a
 * clip the plugin's own route serves (correct MIME + Range), so a passing run
 * proves the real thing:
 *
 *  - the clip loads and its metadata is read (duration 3s)
 *  - seeking to duration/2 lands mid-clip (green segment, not the first frame)
 *  - the captured pixels are the real decoded frame (320x240, green)
 *  - a PNG data URL is produced for the canvas upload
 *
 * It generates its own fixture with ffmpeg and needs chrome-headless-shell, so
 * it is NOT part of `pnpm test` (which must stay dependency-free and offline).
 * Both tools are discovered from a candidate list; when either is missing the
 * script SKIPs loudly and exits 0, so a machine without them never mistakes a
 * missing tool for a passing check (or for a regression).
 *
 * Run: node scripts/verify-frame-grab.mjs [path-to-chrome-headless-shell]
 * Override the tools with FFMPEG=<path> and CHROME_HEADLESS_SHELL=<path>.
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, accessSync, constants, globSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createProbeServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

/**
 * Tool discovery, not hardcoded personal paths. This script ships publicly, so
 * an absolute /Users/<someone> path would both leak the author's local layout
 * and make the script fail on every other machine. Override with FFMPEG=<path>.
 */
function findFfmpeg () {
  const explicit = process.env.FFMPEG
  const usable = candidate => {
    try { accessSync(candidate, constants.X_OK); return true } catch { return false }
  }
  if (explicit !== undefined && explicit !== '') return usable(explicit) ? explicit : null
  // The same directories the host's own clip composer searches (src/clip-compose.ts).
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  // A bare `ffmpeg` on PATH is deliberately NOT tried: the DSH host process runs
  // with a minimal PATH that excludes user bin directories, so a bare name would
  // resolve differently inside the plugin and outside it.
  return candidates.find(usable) ?? null
}

/** Bundled shells newest-first (the agent tooling's usual location), then real browsers. */
function findChrome () {
  const explicit = process.argv[2] ?? process.env.CHROME_HEADLESS_SHELL
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : null
  const candidates = [
    ...globSync(`${tmpdir()}/chromium/chrome-headless-shell/*/*/chrome-headless-shell`).sort().reverse(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...globSync(`${process.env.HOME ?? ''}/.cache/puppeteer/**/chrome-headless-shell`).sort().reverse(),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** Ask the OS for a free port: a fixed one collides with a leftover browser. */
function freePort () {
  return new Promise((resolve, reject) => {
    const probe = createProbeServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const FFMPEG = findFfmpeg()
const CHROME = findChrome()
if (FFMPEG === null || CHROME === null) {
  const missing = [FFMPEG === null ? 'ffmpeg' : null, CHROME === null ? 'chrome-headless-shell' : null]
    .filter(name => name !== null).join(' and ')
  console.error('\n' + '='.repeat(72))
  console.error(`SKIP: ${missing} not found -- the frame-grab path was NOT verified.`)
  console.error('This is a MISSING TOOL, not a regression. Install it, or point FFMPEG')
  console.error('and CHROME_HEADLESS_SHELL at usable binaries, to actually run this check.')
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}
const WORK_DIR = path.join(tmpdir(), 'framegrab')
// Build the fixture if it is missing, so the script is self-contained.
const FIXTURE = `${WORK_DIR}/test.mp4`
if (!existsSync(FIXTURE)) {
  mkdirSync(WORK_DIR, { recursive: true })
  // red (0-1s) -> green (1-2s) -> blue (2-3s): seeking to duration/2 must land
  // in the green segment, which is what makes the check meaningful.
  const made = spawnSync(FFMPEG, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', FIXTURE,
  ], { encoding: 'utf8' })
  if (made.status !== 0) {
    console.error('could not build the fixture with ffmpeg:', made.stderr)
    process.exit(1)
  }
}
const clip = readFileSync(FIXTURE)

// Serve the clip exactly like the plugin's video route: correct MIME,
// accept-ranges, and Range support (seeking depends on it).
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/') {
    // Same origin as the clip, exactly like the plugin's own served client.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  const range = req.headers.range
  if (range === undefined) {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(clip.length), 'accept-ranges': 'bytes' })
    res.end(clip)
    return
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  const start = m[1] === '' ? 0 : Number(m[1])
  const end = m[2] === '' ? clip.length - 1 : Math.min(Number(m[2]), clip.length - 1)
  const slice = clip.subarray(start, end + 1)
  res.writeHead(206, {
    'content-type': 'video/mp4',
    'content-range': `bytes ${start}-${end}/${clip.length}`,
    'content-length': String(slice.length),
    'accept-ranges': 'bytes',
  })
  res.end(slice)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const cdpPort = await freePort()

// The page runs the exact grab algorithm from CanvasWorkspace.grabVideoFrame.
const pageHtml = `<!doctype html><html><body><script>
window.grab = async (url) => {
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.preload = 'auto'
  await new Promise((resolve, reject) => {
    const fail = () => reject(new Error('load failed'))
    video.addEventListener('loadeddata', () => resolve(), { once: true })
    video.addEventListener('error', fail, { once: true })
    setTimeout(fail, 15000)
  })
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  const target = duration > 0 ? duration / 2 : 0
  if (target > 0) {
    await new Promise((resolve) => {
      video.addEventListener('seeked', () => resolve(), { once: true })
      video.currentTime = target
    })
  }
  const width = video.videoWidth, height = video.videoHeight
  const c = document.createElement('canvas')
  c.width = width; c.height = height
  const ctx = c.getContext('2d')
  ctx.drawImage(video, 0, 0, width, height)
  const data = ctx.getImageData(Math.floor(width/2), Math.floor(height/2), 1, 1).data
  return { duration, width, height, rgba: [data[0], data[1], data[2], data[3]], dataUrl: c.toDataURL('image/png').slice(0, 30) }
}
</script></body></html>`
const PAGE = pageHtml

const browser = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + String(cdpPort),
  `--user-data-dir=${WORK_DIR}/profile`, 'about:blank',
], { stdio: 'ignore' })

const waitForCdp = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      if (r.ok) return await r.json()
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('CDP did not come up')
}
const version = await waitForCdp()

const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  const onMessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === myId) { ws.removeEventListener('message', onMessage); resolve(msg) }
  }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 700))
const result = await send('Runtime.evaluate', {
  expression: `window.grab('http://127.0.0.1:${port}/clip.mp4')`,
  awaitPromise: true, returnByValue: true,
})
ws.close()
browser.kill()
server.close()

// Runtime.evaluate nests its payload: { id, result: { result: { value } } }.
const evaluation = result.result ?? {}
if (evaluation.exceptionDetails !== undefined || evaluation.result?.value === undefined) {
  console.error('RAW CDP RESULT:', JSON.stringify(result, null, 1).slice(0, 1200))
  process.exit(1)
}
const out = evaluation.result.value
console.log('browser result:', JSON.stringify(out))
assert.equal(out.width, 320, 'the frame keeps the clip width')
assert.equal(out.height, 240, 'the frame keeps the clip height')
assert.ok(Math.abs(out.duration - 3) < 0.2, `duration read as ~3s (got ${out.duration})`)
const [r, g, b] = out.rgba
// duration/2 = 1.5s, which is inside the green segment.
assert.ok(g > 100 && r < 60 && b < 60, `the grabbed frame is the green mid-clip frame, got rgba ${out.rgba}`)
assert.ok(out.dataUrl.startsWith('data:image/png'), 'a PNG data URL is produced for upload')
console.log('FRAME GRAB VERIFIED (real browser, real clip, real seek)')

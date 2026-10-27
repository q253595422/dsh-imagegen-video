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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { findTool } from '../src/clip-compose.ts'
import { findChrome, launchChrome } from './lib/headless-chrome.mjs'

/**
 * Tool discovery, not hardcoded personal paths. This script ships publicly, so
 * an absolute /Users/<someone> path would both leak the author's local layout
 * and make the script fail on every other machine.
 *
 * The candidate list used to be spelled out here, mirroring the host's own. That
 * copy is what made this guard lie on Windows: the host had already been taught
 * about `.exe` and PATH, and this file still only knew four POSIX directories,
 * so it reported "no ffmpeg" and skipped while the plugin worked. Resolving
 * through the host's own function means the guard cannot disagree with the code
 * it is guarding. `FFMPEG` still overrides, because `findTool` honours it.
 */
const FFMPEG = findTool('ffmpeg') ?? null
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
// A directory per run, not the fixed `tmpdir()/framegrab` this used to be: two
// concurrent runs shared it, so one run's fixture build or cleanup deleted the
// clip the other was still serving.
const WORK_DIR = mkdtempSync(path.join(tmpdir(), 'dsh-framegrab-'))
// Removed from the 'exit' hook rather than from a finally: this script also
// exits early on purpose further down, and process.exit() does not unwind a
// try/finally. The hook fires for the normal end, for a thrown assertion and for
// those explicit exits alike.
process.on('exit', () => rmSync(WORK_DIR, { recursive: true, force: true }))
// The directory is new every run, so the fixture is always built here; a stale
// clip from an earlier run can no longer be picked up instead.
const FIXTURE = `${WORK_DIR}/test.mp4`
{
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

// A fresh profile per launch is not tidiness: Chrome reuses a leftover `DevToolsActivePort`
// from an old profile and then listens on a port nobody is polling. The port itself is
// assigned BY the browser and read back from that file, so a parallel run cannot steal it.
const launched = await launchChrome({ chrome: CHROME, name: 'framegrab' })
const browser = launched.browser

const target = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
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
launched.close()
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

/**
 * Smoke suite for the CODE-GENERATION path: a chat model writes drawing code,
 * this host renders it locally into a real MP4 or PNG, and the result lands in
 * the SAME history the model paths write.
 *
 * The upstream provider is never contacted here — that is the point of the
 * path. What this proves, end to end and offline:
 *
 *  C1  a probe reports the pixels / frames the render will actually use
 *  C2  empty input is refused with a wire code before a model is called
 *  C3  a model answer that is prose degrades to a drawn title card, not a dead end
 *  C4  broken code fails legibly (syntax / runtime / timeout / missing ffmpeg)
 *  C5  `renderer: 'code'` produces a PLAYABLE clip, stored with renderer:'code'
 *  C6  `renderer: 'code'` produces a real PNG, stored with renderer:'code'
 *  C7  a code clip is accepted by the local stitcher (same store, same URLs)
 *  C8  a request without `renderer` still goes to the model provider untouched
 *
 * Run: node scripts/smoke-code-render.mjs   (from the package root, after a build)
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The data root is resolved when the host module loads, and it reads DSH_HOME
// at that moment. Set it BEFORE the dynamic import so the suite never touches
// the user's real ~/.dsh — the same pattern the other smoke suites use.
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-code-render-smoke-'))
process.env.DSH_HOME = dataRoot

const results = []

/** Run one check under a hard deadline (a hung render is a failure). */
async function check(name, fn, timeoutMs = 180_000) {
  process.stderr.write(`... ${name}\n`)
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error?.stack ?? error?.message ?? error}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

/** Measure a produced file with ffprobe; undefined when the tools are absent. */
function probeWithFfprobe(file) {
  const candidates = [join(process.env.HOME ?? '', '.local', 'bin', 'ffprobe'), '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
  const ffprobe = candidates.find(candidate => existsSync(candidate))
  if (ffprobe === undefined) return undefined
  const json = execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' })
  return JSON.parse(json)
}

/** A scripted chat: returns whatever the test wants the model to have said. */
function scriptedChat(reply) {
  const calls = []
  const complete = async options => {
    calls.push(options)
    return typeof reply === 'function' ? await reply(options) : reply
  }
  return { complete, calls }
}

/** A prompt-model config that looks configured (the host seam is not consulted). */
const CONFIG = { apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'scripted-chat' }

const BANNER = `
function render(ctx) {
  ctx.background('#0b1220')
  ctx.gradient(0, 0, ctx.width, ctx.height, [[0, '#0b1220'], [1, '#1d3a63']], 60)
  const p = ctx.ease(ctx.t)
  ctx.circle(ctx.width / 2, ctx.height / 2, ctx.height * 0.12 + ctx.height * 0.2 * p, '#38bdf8', 0.9)
  ctx.rect(ctx.width * 0.1, ctx.height * 0.8, ctx.width * 0.8 * p, 6, '#f8fafc')
  ctx.text('CODE RENDER', ctx.width / 2, ctx.height * 0.3, { size: Math.round(ctx.height / 10), color: '#ffffff', align: 'center' })
}
`

await check('C1 a probe reports the pixels and frames the render will use', async () => {
  const { probeCodeRender, codeRenderPlan } = await import('../lib/index.js')
  const plan = codeRenderPlan({ kind: 'video', resolution: '720P', aspectRatio: '16:9', seconds: 3, fps: 30 })
  assert.equal(plan.width, 1280, `expected 1280 wide, got ${plan.width}`)
  assert.equal(plan.height, 720, `expected 720 tall, got ${plan.height}`)
  assert.equal(plan.frames, 90, `expected 90 frames, got ${plan.frames}`)
  const probe = probeCodeRender({ kind: 'video', resolution: '720P', aspectRatio: '16:9', seconds: 3, fps: 30 })
  assert.equal(probe.frames, plan.frames)
  assert.equal(probe.width, plan.width)
  // The probe must be honest about the one dependency the user can install.
  assert.equal(typeof probe.ffmpegAvailable, 'boolean')
  if (probe.ffmpegAvailable) assert.ok(typeof probe.ffmpegPath === 'string' && probe.ffmpegPath !== '')
})

await check('C2 empty input is refused with a wire code before any model call', async () => {
  const { runCodeRender, CodeRenderError } = await import('../lib/index.js')
  const chat = scriptedChat(BANNER)
  let code
  try {
    await runCodeRender({ kind: 'video', prompt: '   ', resolution: '720P', aspectRatio: '16:9', seconds: 1, fps: 30 }, CONFIG, chat.complete)
  } catch (error) {
    code = error.code
    assert.ok(error instanceof CodeRenderError, `expected a CodeRenderError, got ${error?.constructor?.name}`)
  }
  assert.equal(code, 'code-prompt-empty', `expected code-prompt-empty, got ${code}`)
  assert.equal(chat.calls.length, 0, 'the model must not be called for an empty prompt')
})

await check('C3 a prose answer degrades to a drawn title card instead of failing', async () => {
  const { runCodeRender } = await import('../lib/index.js')
  const chat = scriptedChat('Sure! I would draw a nice blue circle with some text in the middle.')
  const outcome = await runCodeRender(
    { kind: 'image', prompt: 'a calm intro card', resolution: '720P', aspectRatio: '16:9' },
    CONFIG,
    chat.complete,
    { persist: false },
  )
  assert.equal(outcome.degraded, true, 'a non-code answer must be marked degraded')
  assert.ok((outcome.degradedReason ?? '').length > 0, 'a degraded render must say why')
  assert.ok(outcome.bytes.length > 0, 'the fallback must still produce bytes')
})

await check('C4a broken code fails as code-syntax, not as a crash', async () => {
  const { runCodeRender } = await import('../lib/index.js')
  const chat = scriptedChat('function render(ctx) { ctx.background( }')
  let code
  try {
    await runCodeRender({ kind: 'image', prompt: 'x', resolution: '480P', aspectRatio: '1:1' }, CONFIG, chat.complete, { persist: false })
  } catch (error) { code = error.code }
  assert.equal(code, 'code-syntax', `expected code-syntax, got ${code}`)
})

await check('C4b code calling an API that does not exist fails as code-runtime', async () => {
  const { runCodeRender } = await import('../lib/index.js')
  const chat = scriptedChat('function render(ctx) { ctx.background("#000"); ctx.drawTriangle(1,2,3) }')
  let code
  try {
    await runCodeRender({ kind: 'image', prompt: 'x', resolution: '480P', aspectRatio: '1:1' }, CONFIG, chat.complete, { persist: false })
  } catch (error) { code = error.code }
  assert.equal(code, 'code-runtime', `expected code-runtime, got ${code}`)
})

await check('C4c a slow renderer hits the deadline instead of hanging', async () => {
  const { renderCode } = await import('../lib/index.js')
  // An infinite loop cannot be interrupted inside a frame; the deadline is
  // checked between frames, so make each frame exceed it and use 2 frames.
  const slow = 'function render(ctx) { ctx.background("#000"); const until = Date.now() + 60; while (Date.now() < until) {} }'
  let code
  const started = Date.now()
  try {
    await renderCode({ kind: 'video', source: slow, width: 64, height: 64, fps: 30, seconds: 30, timeoutMs: 1 })
  } catch (error) { code = error.code }
  assert.equal(code, 'render-timeout', `expected render-timeout, got ${code}`)
  assert.ok(Date.now() - started < 60_000, 'the timeout must actually cut the render short')
})

await check('C4d a missing ffmpeg is reported by name', async () => {
  const { renderCode } = await import('../lib/index.js')
  let code
  try {
    await renderCode({ kind: 'video', source: BANNER, width: 64, height: 64, fps: 30, seconds: 1 }, { ffmpeg: '/nonexistent/ffmpeg' })
  } catch (error) { code = error.code }
  assert.equal(code, 'render-no-ffmpeg', `expected render-no-ffmpeg, got ${code}`)
})

/** A valid 1x1 PNG, so the engine's MIME sniff succeeds without a real render. */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** One scripted upstream that would answer a video render if it were called. */
function startUpstream() {
  const submits = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/videos')) {
        submits.push(JSON.parse(body))
        res.end(JSON.stringify({ id: 'video-1', status: 'completed', url: 'http://127.0.0.1:1/clip.mp4' }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        submits.push(JSON.parse(body))
        res.end(JSON.stringify({ choices: [{ message: { content: BANNER } }] }))
        return
      }
      // A one-pixel PNG: enough for the engine's MIME sniff and the history write.
      if (req.url?.includes('/images/generations') || req.url?.includes('/images/edits')) {
        submits.push(JSON.parse(body))
        res.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }))
        return
      }
      res.end('{}')
    })
  })
  return { server, submits }
}

await check('C5 renderer:code produces a PLAYABLE clip stored with renderer:code', async () => {
  const { ImageGenerationRuntime, listVideoHistory, locateFfmpeg } = await import('../lib/index.js')
  if (locateFfmpeg() === undefined) {
    process.stderr.write('      (skipping: no ffmpeg on this machine, C4d covers that path)\n')
    return
  }
  const chat = scriptedChat(BANNER)
  const runtime = new ImageGenerationRuntime(
    () => ({ channels: [], defaultChannelId: '' }),
    undefined,
    undefined,
    undefined,
    // The host conversation model, injected exactly like the plugin does.
    {
      available: () => true,
      label: () => 'host-model',
      complete: async options => await chat.complete(options),
    },
  )
  const result = await runtime.runVideo({
    mode: 'text',
    model: '',
    prompt: 'a blue circle rising with a progress bar',
    aspectRatio: '16:9',
    resolution: '720P',
    seconds: 3,
    renderer: 'code',
  })
  assert.equal(result.renderer, 'code')
  assert.equal(result.videos.length, 1, 'a code render must persist exactly one clip')
  const clip = result.videos[0]
  assert.ok(clip.url.startsWith('/api/dsh-imagegen/video/file/'), `unexpected clip url ${clip.url}`)
  // The stored entry must be indistinguishable from a model one except for the marker.
  const history = await listVideoHistory()
  const entry = history.find(item => item.id === result.history[0].id)
  assert.ok(entry !== undefined, 'the clip must appear in the video history')
  assert.equal(entry.renderer, 'code', `expected renderer code, got ${entry.renderer}`)
  assert.equal(entry.seconds, 3)
  assert.equal(entry.resolution, '720P')
  assert.equal(entry.aspectRatio, '16:9')
  // And the bytes must be a real, playable MP4.
  const file = join(dataRoot, 'dsh-imagegen', 'videos', 'files', decodeURIComponent(clip.url.split('/').pop()))
  assert.ok(existsSync(file), `the clip file is missing at ${file}`)
  assert.ok(statSync(file).size > 1_000, 'the clip is suspiciously small')
  const probe = probeWithFfprobe(file)
  if (probe !== undefined) {
    const stream = probe.streams.find(item => item.codec_type === 'video')
    assert.equal(Number(stream.width), 1280, `expected 1280px wide, got ${stream.width}`)
    assert.equal(Number(stream.height), 720, `expected 720px tall, got ${stream.height}`)
    assert.equal(stream.r_frame_rate, '30/1', `expected 30fps, got ${stream.r_frame_rate}`)
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2, `expected ~3s, got ${probe.format.duration}`)
  }
})

await check('C6 renderer:code produces a real PNG stored with renderer:code', async () => {
  const { ImageGenerationRuntime } = await import('../lib/index.js')
  const chat = scriptedChat(BANNER)
  const runtime = new ImageGenerationRuntime(
    () => ({ channels: [], defaultChannelId: '' }),
    undefined,
    undefined,
    undefined,
    {
      available: () => true,
      label: () => 'host-model',
      complete: async options => await chat.complete(options),
    },
  )
  const result = await runtime.run({
    mode: 'text',
    model: '',
    prompt: 'a title card',
    size: '1:1',
    quality: '2k',
    n: 1,
    detail: '',
    renderer: 'code',
  })
  assert.equal(result.images.length, 1)
  const image = result.images[0]
  assert.equal(image.mime, 'image/png')
  const bytes = Buffer.from(image.b64, 'base64')
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG signature')
  const history = JSON.parse(readFileSync(join(dataRoot, 'dsh-imagegen', 'index.json'), 'utf8')).entries
  const entry = history.find(item => item.id === result.history[0].id)
  assert.equal(entry.renderer, 'code', `expected renderer code, got ${entry.renderer}`)
  assert.equal(entry.size, '1080x1080', `unexpected size ${entry.size}`)
})

await check('C7 a code-rendered clip is stitchable by the local composer', async () => {
  const { ImageGenerationRuntime, createClipComposer, locateFfmpeg } = await import('../lib/index.js')
  if (locateFfmpeg() === undefined) {
    process.stderr.write('      (skipping: stitching needs ffmpeg)\n')
    return
  }
  const composer = createClipComposer()
  // `describe()` is a human-readable string, not a tool table — reading a
  // `ffprobe` field off it silently skipped this whole check on every machine.
  // `available()` is the real answer to "can this host stitch at all".
  if (!composer.available()) {
    process.stderr.write(`      (skipping: stitching needs ffmpeg and ffprobe; ${composer.describe()})\n`)
    return
  }
  const chat = scriptedChat(BANNER)
  const runtime = new ImageGenerationRuntime(
    () => ({ channels: [], defaultChannelId: '' }), undefined, undefined, undefined,
    { available: () => true, label: () => 'host-model', complete: async options => await chat.complete(options) },
  )
  const first = await runtime.runVideo({ mode: 'text', model: '', prompt: 'clip one', aspectRatio: '16:9', resolution: '480P', seconds: 1, renderer: 'code' })
  const second = await runtime.runVideo({ mode: 'text', model: '', prompt: 'clip two', aspectRatio: '16:9', resolution: '480P', seconds: 1, renderer: 'code' })
  // This is the whole "equal to the model path" claim: the stitcher resolves
  // these URLs through the same CLIP_SOURCES table as any model clip, with no
  // knowledge of code. `stitch` itself takes LOCAL paths, so the resolve step
  // is part of what is being proven — a code clip must be resolvable here too.
  const firstFile = await composer.resolve(first.videos[0].url)
  const secondFile = await composer.resolve(second.videos[0].url)
  assert.ok(firstFile !== undefined, 'the stitcher must resolve a code-rendered clip URL to a local file')
  assert.ok(secondFile !== undefined, 'the second code-rendered clip must resolve too')
  const stitched = await composer.stitch({ sources: [firstFile, secondFile] })
  // `stitch` answers with the encoded bytes (persisting is `publish`'s job), so
  // assert on those rather than on a video list that never existed.
  assert.ok(stitched.bytes.length > 10_000, `the stitched file is suspiciously small (${stitched.bytes.length} bytes)`)
  assert.equal(stitched.mime, 'video/mp4')
  // An MP4 starts with a box header; `ftyp` sits at offset 4. Checking the
  // bytes (not just their length) is what proves ffmpeg actually encoded.
  assert.equal(Buffer.from(stitched.bytes.subarray(4, 8)).toString('ascii'), 'ftyp', 'the stitched output is not an MP4')
  assert.ok((stitched.duration ?? 0) > 1.5, `expected a joined ~2s clip, got ${stitched.duration}s`)
})

await check('C8 a request without renderer still goes to the model provider', async () => {
  const { ImageGenerationRuntime } = await import('../lib/index.js')
  const upstream = startUpstream()
  await new Promise(resolve => upstream.server.listen(0, '127.0.0.1', resolve))
  const { port } = upstream.server.address()
  try {
    const runtime = new ImageGenerationRuntime(() => ({
      channels: [{
        id: 'default',
        name: 'default',
        apiUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test',
        protocol: 'openai',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
        videoModels: [],
      }],
      defaultChannelId: 'default',
    }))
    let failed = false
    try {
      await runtime.run({ mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '1k', n: 1, detail: '' })
    } catch {
      failed = true
    }
    assert.equal(upstream.submits.length > 0, true, 'the model provider must still be called when renderer is absent')
    assert.equal(failed, false, 'the image model path must not throw for a well-formed request')
  } finally {
    await new Promise(resolve => upstream.server.close(resolve))
  }
})

// ---------------------------------------------------------------- report

try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }

const failed = results.filter(line => line.startsWith('FAIL')).length
process.stdout.write(`${results.join('\n')}\n\n${'='.repeat(64)}\n`)
process.stdout.write(failed === 0 ? `${results.length}/${results.length} code-render checks pass\n` : `${failed} of ${results.length} FAILED\n`)
if (failed > 0) process.exitCode = 1
void readFileSync

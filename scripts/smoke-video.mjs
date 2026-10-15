/**
 * Smoke suite for the video half of @q253595422/dsh-imagegen-video, run against the
 * BUILT artifacts exactly like scripts/smoke.mjs.
 *
 * Everything here is offline: a local HTTP server plays the upstream video
 * provider and replays the response shapes measured from Agnes and comemoe, so
 * these checks cost nothing and never touch a real API. What they prove:
 *
 *  V1  the engine shapes and polls each family correctly, end to end
 *  V2  the host runtime persists a finished clip and serves it with Range
 *  V3  the video routes work over real HTTP (list / file / history / errors)
 *  V4  the Agent tools submit, wait, poll and cancel
 *  V5  per-mode reference handling and the unknown-family guard
 *
 * Run: node scripts/smoke-video.mjs   (from the package root)
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const results = []
/**
 * Run one check under a hard per-check deadline. Video polling needs real
 * waits, but nothing here should ever block for minutes, so a stalled check is
 * itself a failure rather than something that hangs the suite.
 */
async function check(name, fn, timeoutMs = 60_000) {
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
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

// The smallest valid-looking MP4 head; only the byte count and MIME matter here.
const MP4 = Buffer.from('00000018667479706d7034320000000069736f6d6d703431', 'hex')

/** A local upstream that speaks the measured submit/poll/download contract. */
function startUpstream() {
  const state = { submits: [], polls: [], downloads: [], script: null }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/v1/videos') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        state.submits.push({ body, authorization: req.headers.authorization })
        const script = state.script
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(script.submit))
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/videos/')) {
      state.polls.push({ id: url.pathname.slice('/v1/videos/'.length), authorization: req.headers.authorization })
      // `pollFailures[n]` makes poll request n+1 answer that HTTP status, so a
      // suite can simulate a status endpoint that hiccups before it recovers.
      const failures = state.script.pollFailures
      const failure = Array.isArray(failures) ? failures[state.polls.length - 1] : undefined
      if (typeof failure === 'number') {
        res.writeHead(failure, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream hiccup' } }))
        return
      }
      const list = state.script.polls
      const index = Math.min(state.polls.length - 1, list.length - 1)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list[index]))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('.mp4')) {
      state.downloads.push({ path: url.pathname, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) })
      res.end(MP4)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ state, port, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise(done => server.close(done)) })
    })
  })
}

/**
 * Point the plugin's data root at a scratch dir so the suite never touches the
 * real ~/.dsh. DSH_HOME is read when the module resolves its storage path, so
 * it must be set before the host half is imported.
 */
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-video-smoke-'))
process.env.DSH_HOME = dataRoot
const host = await import(new URL('lib/index.js', root).href)

// The engine is bundled into lib/index.js, so the host's own export is the
// artifact under test.
const generateVideo = host.generateVideo
assert.ok(typeof generateVideo === 'function', 'the built host must export generateVideo for tests')

// ---------------------------------------------------------------------- V1
await check('V1 the engine submits, polls and downloads one Agnes clip', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'vid_agnes_1', task_id: 'task_agnes_1', status: 'queued' },
    polls: [
      { status: 'running', progress: 20 },
      { status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.port}/out/clip.mp4`, duration: 5 } },
    ],
  }
  try {
    const result = await generateVideo(
      { apiUrl: upstream.base, apiKey: 'sk-video' },
      { mode: 'text', model: 'agnes-video-2.5-flash', prompt: 'a cat', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
      { family: 'agnes' },
    )
    assert.equal(result.videos.length, 1)
    assert.equal(result.videos[0].mime, 'video/mp4')
    assert.equal(result.videos[0].bytes.length, MP4.length, 'the downloaded clip bytes are returned')
    const submit = upstream.state.submits[0]
    assert.equal(submit.body.model, 'agnes-video-2.5-flash')
    assert.equal(submit.body.mode, 'text')
    assert.equal(submit.body.seconds, '5')
    assert.equal(submit.body.size, '720P')
    assert.equal(submit.authorization, 'Bearer sk-video', 'the submit carries the API key')
    assert.equal(upstream.state.polls[0].id, 'vid_agnes_1', 'polling uses the resource id, not the task id')
  } finally {
    await upstream.close()
  }
})

await check('V1b the engine handles the flat comemoe shape and its processing state', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    // Measured: flat body, contradicting the vendor's own docs.
    submit: { id: 'vid_flat_1', status: 'queued', task_id: 'task_flat_1' },
    polls: [
      // Measured: `processing` exists but is missing from the docs.
      { status: 'processing' },
      { status: 'succeeded', url: `http://127.0.0.1:${upstream.port}/files/r.mp4`, duration: 5 },
    ],
  }
  try {
    const result = await generateVideo(
      { apiUrl: upstream.base, apiKey: 'sk-comemoe' },
      { mode: 'text', model: 'zhimeng-h3-local', prompt: 'a dog', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
      { family: 'comemoe' },
    )
    assert.equal(result.videos[0].mime, 'video/mp4')
    assert.equal(result.videos[0].bytes.length, MP4.length)
    const body = upstream.state.submits[0].body
    assert.equal(body.duration, 5, 'comemoe takes duration, not seconds')
    assert.equal(body.resolution, '720P')
    assert.ok(!('mode' in body), 'comemoe has no mode field')
    assert.equal(upstream.state.polls[0].id, 'vid_flat_1', 'the flat body\'s resource id is polled')
  } finally {
    await upstream.close()
  }
})

await check('V1c wan2.2-t2v stays text-only and send standard resolution', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { id: 'vid_t2v', status: 'queued' },
    polls: [{ status: 'succeeded', url: `http://127.0.0.1:${upstream.port}/t.mp4` }],
  }
  try {
    await generateVideo(
      { apiUrl: upstream.base, apiKey: 'k' },
      { mode: 'image', model: 'wan2.2-t2v', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5, image: 'data:image/png;base64,QUJD' },
      { family: 'comemoe' },
    )
    const body = upstream.state.submits[0].body
    assert.equal(body.resolution, 'standard', 'wan2.2-t2v only accepts standard')
    assert.ok(!('image_url' in body), 'a text-only model must not receive a reference frame')
  } finally {
    await upstream.close()
  }
})

await check('V1d keyframe and reference modes send family-correct fields', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'v', status: 'queued' },
    polls: [{ status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.port}/k.mp4` } }],
  }
  const png = 'data:image/png;base64,QUJD'
  try {
    await generateVideo(
      { apiUrl: upstream.base, apiKey: 'k' },
      { mode: 'keyframe', model: 'agnes-video-2.5', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5, firstFrame: png, lastFrame: png },
      { family: 'agnes' },
    )
    const keyframe = upstream.state.submits[0].body
    assert.equal(keyframe.mode, 'keyframe')
    assert.equal(keyframe.first_frame, png)
    assert.equal(keyframe.last_frame, png)
    assert.ok(!('images' in keyframe), 'keyframe mode must not also send a reference array')

    upstream.state.submits.length = 0
    await generateVideo(
      { apiUrl: upstream.base, apiKey: 'k' },
      { mode: 'reference', model: 'agnes-video-2.5', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5, image: png, images: [png] },
      { family: 'agnes' },
    )
    const reference = upstream.state.submits[0].body
    assert.equal(reference.mode, 'reference')
    assert.deepEqual(reference.images, [png, png])
  } finally {
    await upstream.close()
  }
})

await check('V1e an unknown family fails loudly instead of guessing', async () => {
  await assert.rejects(
    () => generateVideo(
      { apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' },
      { mode: 'text', model: 'totally-unknown-model', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
      {},
    ),
    /无法识别视频模型|unknown/i,
  )
})

await check('V1f a provider failure surfaces its own message', async () => {
  const upstream = await startUpstream()
  upstream.state.script = { submit: { video_id: 'v' }, polls: [{ status: 'failed', error: { message: '内容审核未通过' } }] }
  try {
    await assert.rejects(
      () => generateVideo(
        { apiUrl: upstream.base, apiKey: 'k' },
        { mode: 'text', model: 'agnes-video-2.5-flash', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
        { family: 'agnes' },
      ),
      /内容审核未通过/,
    )
  } finally {
    await upstream.close()
  }
})

await check('V1g a transient status failure is retried, not failed', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'vid_blip', status: 'queued' },
    // The status endpoint answers 503 twice, then reports the finished clip:
    // one hiccup must not fail a render the provider is still working on.
    pollFailures: [503, 503],
    polls: [{ status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.port}/blip.mp4`, duration: 5 } }],
  }
  try {
    const result = await generateVideo(
      { apiUrl: upstream.base, apiKey: 'k' },
      { mode: 'text', model: 'agnes-video-2.5-flash', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
      { family: 'agnes' },
    )
    assert.equal(result.videos.length, 1, 'the clip is still produced after the blips')
    assert.ok(upstream.state.polls.length >= 3, 'the poll loop retried the failed status requests')
  } finally {
    await upstream.close()
  }
})

await check('V1h a status endpoint that keeps failing gives up with its own error', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'vid_dead', status: 'queued' },
    // Never recovers: the retry budget is bounded, so this rejects with the
    // provider's own message instead of looping until the family deadline.
    pollFailures: [503, 503, 503, 503, 503, 503, 503, 503, 503, 503],
    polls: [{ status: 'running' }],
  }
  try {
    await assert.rejects(
      () => generateVideo(
        { apiUrl: upstream.base, apiKey: 'k' },
        { mode: 'text', model: 'agnes-video-2.5-flash', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
        { family: 'agnes' },
      ),
      /upstream hiccup/,
      'the provider error text surfaces instead of a bare timeout',
    )
    assert.ok(upstream.state.polls.length <= 6, `the retry budget is bounded (saw ${upstream.state.polls.length} polls)`)
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- V2/V3
await check('V2 the runtime persists a clip and the store serves it', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'vid_store', status: 'queued' },
    polls: [{ status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.port}/stored.mp4`, duration: 7 } }],
  }
  try {
    const runtime = new host.ImageGenerationRuntime(() => ({
      channels: [{
        id: 'default',
        preset: '',
        name: 'VideoChannel',
        apiUrl: upstream.base,
        apiKey: 'sk-test',
        apiUrlFull: false,
        models: [],
        videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
      }],
      defaultChannelId: 'default',
    }))
    const result = await runtime.runVideo({
      mode: 'text',
      model: 'agnes-video-2.5-flash',
      prompt: 'stored clip',
      aspectRatio: '16:9',
      resolution: '720P',
      seconds: 5,
    })
    assert.equal(result.videos.length, 1, 'the finished clip is returned')
    assert.match(result.videos[0].url, /\/api\/dsh-imagegen\/video\/file\//, 'the result is a same-origin served URL, not raw bytes')
    assert.equal(result.historyError, undefined, 'persistence succeeded')

    const listed = await host.listVideoHistory()
    assert.equal(listed.length, 1, 'the clip is in the video history')
    assert.equal(listed[0].duration ?? undefined, undefined, 'history keeps its own shape')
    assert.equal(listed[0].seconds, 5)

    // The store reads the file back for the Range-capable route.
    const file = listed[0].videos[0].url.split('/').pop()
    const read = await host.readVideoFile(file)
    assert.ok(read !== undefined, 'the stored clip is readable by name')
    assert.equal(read.size, MP4.length)
    assert.equal(read.mime, 'video/mp4')

    // Path traversal must not resolve.
    assert.equal(await host.readVideoFile('../index.json'), undefined, 'a traversal name is rejected')
    assert.equal(await host.readVideoFile('nope.txt'), undefined, 'a non-video extension is rejected')
  } finally {
    await upstream.close()
  }
})

await check('V3 the video routes answer over real HTTP', async () => {
  // Drive the real route handlers through a real HTTP server. Building the
  // request/response pair by hand would test a fiction; a socket round trip
  // exercises the loopback guard, body reading and JSON envelope for real.
  const tasks = []
  const stored = []
  const routes = host.makeRoutes({
    settings: { describe: () => [], mutate: async () => ({}) },
    resolve: () => ({ apiUrl: '', apiKey: '' }),
    resolveChannels: () => ({ channels: [], defaultChannelId: '' }),
    runtime: {
      queue: { submit: () => ({ id: 'x' }), list: () => [], get: () => undefined, cancel: () => undefined, retry: () => undefined, summaries: () => [] },
      videoQueue: {
        submit: request => { const task = { id: `vt-${tasks.length + 1}`, request, status: 'queued', createdAt: Date.now() }; tasks.push(task); return task },
        summaries: () => tasks.map(task => ({ ...task, resultAvailable: false })),
        get: id => tasks.find(task => task.id === id),
        cancel: id => tasks.find(task => task.id === id),
        retry: id => tasks.find(task => task.id === id),
        list: () => tasks,
        subscribe: () => () => {},
      },
      runVideo: async () => ({ videos: [] }),
    },
    video: {
      list: async () => stored,
      remove: async () => stored,
      clear: async () => stored,
      // One served clip so the Range path can be exercised for real.
      readFile: async name => name === 'clip-0.mp4' ? { path: '', size: MP4.length, mime: 'video/mp4' } : undefined,
    },
  })
  assert.ok(routes.filter(route => String(route.path).includes('/video/')).length >= 10,
    'the video route family is registered')

  // Serve exactly the video routes, dispatching the way the host router does.
  const exact = new Map(routes.filter(r => r.kind !== 'prefix').map(r => [r.path, r.handler]))
  const prefixes = routes.filter(r => r.kind === 'prefix')
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = exact.get(pathname) ?? prefixes.find(r => pathname.startsWith(`${r.path}/`))?.handler
    if (handler === undefined) { res.writeHead(404); res.end('no route'); return }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    })
    return { status: response.status, json: await response.json() }
  }
  try {
    // A valid submit reaches the queue.
    const accepted = await post('/api/dsh-imagegen/video/tasks/submit', { prompt: 'p', model: 'agnes-video-2.5-flash', mode: 'text' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.ok, true, 'the submit route accepts a valid video request')
    assert.equal(tasks.length, 1, 'the request reached the video queue')

    // A request without a prompt is refused with copy, not a crash.
    const missing = await post('/api/dsh-imagegen/video/tasks/submit', { model: 'agnes-video-2.5-flash' })
    assert.equal(missing.json.ok, false)
    assert.match(missing.json.message, /prompt/)
    assert.equal(tasks.length, 1, 'the invalid request never reached the queue')

    // The queue list and history list both answer.
    const listed = await post('/api/dsh-imagegen/video/tasks/list')
    assert.equal(listed.json.ok, true)
    assert.equal(listed.json.tasks.length, 1)
    const history = await post('/api/dsh-imagegen/video/history/list')
    assert.equal(history.json.ok, true)

    // Canvas lineage must survive the route's request parser. It is how the
    // canvas matches a finished render to its placeholder node; dropping it made
    // every canvas run look failed while the render had actually succeeded.
    const canvasRun = await post('/api/dsh-imagegen/video/tasks/submit', {
      prompt: 'from the canvas',
      model: 'agnes-video-2.5-flash',
      mode: 'text',
      canvas: { canvasId: 'canvas-77', sourceNodeId: 'cfg-9', nodeId: 'ph-9', referenceNodeIds: ['img-1', 'img-2'] },
    })
    assert.equal(canvasRun.json.ok, true, 'a canvas-originated submit is accepted')
    const queued = tasks.at(-1)
    assert.equal(queued.request.canvas?.canvasId, 'canvas-77', 'the canvas id survives the request parser')
    assert.equal(queued.request.canvas?.nodeId, 'ph-9', 'the placeholder node id survives')
    assert.equal(queued.request.canvas?.sourceNodeId, 'cfg-9', 'the source config node survives')
    assert.deepEqual(queued.request.canvas?.referenceNodeIds, ['img-1', 'img-2'], 'the reference node ids survive')

    // A malformed canvas block is ignored rather than polluting the task.
    const badCanvas = await post('/api/dsh-imagegen/video/tasks/submit', {
      prompt: 'no canvas id', model: 'agnes-video-2.5-flash', mode: 'text', canvas: { sourceNodeId: 'x' },
    })
    assert.equal(badCanvas.json.ok, true, 'a submit without a usable canvas id is still accepted')
    assert.equal(tasks.at(-1).request.canvas, undefined, 'a canvas block without an id is dropped, not stored half-formed')

    // One queued id resolves; an unknown id reports not-found.
    const found = await post('/api/dsh-imagegen/video/tasks/get', { id: 'vt-1' })
    assert.equal(found.json.ok, true)
    const absent = await post('/api/dsh-imagegen/video/tasks/get', { id: 'nope' })
    assert.equal(absent.json.ok, false)
    assert.equal(absent.json.code, 'not-found')

    // Removal requires an id.
    const badRemove = await post('/api/dsh-imagegen/video/history/remove', {})
    assert.equal(badRemove.json.ok, false)

    // The file route: a traversal name and an unknown name both 404.
    const traversal = await fetch(`${origin}/api/dsh-imagegen/video/file/..%2Findex.json`)
    assert.equal(traversal.status, 404, 'a traversal name does not resolve')
    const unknown = await fetch(`${origin}/api/dsh-imagegen/video/file/absent-0.mp4`)
    assert.equal(unknown.status, 404, 'an unknown clip name does not resolve')
    // A GET method on a POST-only route is refused.
    const wrongMethod = await fetch(`${origin}/api/dsh-imagegen/video/tasks/list`)
    assert.equal(wrongMethod.status, 405, 'a POST-only route refuses GET')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

await check('V3b the clip route serves bytes and honors Range for seeking', async () => {
  // A real fixture on disk: the route streams from the file system, so a
  // fabricated buffer would not exercise the path that matters.
  const clipDir = join(dataRoot, 'dsh-imagegen', 'videos', 'files')
  mkdirSync(clipDir, { recursive: true })
  const clipPath = join(clipDir, 'seek-0.mp4')
  const body = Buffer.concat([MP4, Buffer.alloc(2048, 7)])
  writeFileSync(clipPath, body)

  const routes = host.makeRoutes({
    settings: { describe: () => [], mutate: async () => ({}) },
    resolve: () => ({ apiUrl: '', apiKey: '' }),
    resolveChannels: () => ({ channels: [], defaultChannelId: '' }),
    video: {
      list: async () => [],
      remove: async () => [],
      clear: async () => [],
      readFile: name => host.readVideoFile(name),
    },
  })
  const exact = new Map(routes.filter(r => r.kind !== 'prefix').map(r => [r.path, r.handler]))
  const prefixes = routes.filter(r => r.kind === 'prefix')
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = exact.get(pathname) ?? prefixes.find(r => pathname.startsWith(`${r.path}/`))?.handler
    if (handler === undefined) { res.writeHead(404); res.end('no route'); return }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const full = await fetch(`${origin}/api/dsh-imagegen/video/file/seek-0.mp4`)
    assert.equal(full.status, 200, 'the whole clip is served')
    assert.equal(full.headers.get('accept-ranges'), 'bytes', 'the route advertises range support')
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff')
    const fullBody = Buffer.from(await full.arrayBuffer())
    assert.equal(fullBody.length, body.length, 'the whole clip arrives')

    // A Range request must answer 206 with just the asked-for slice; without
    // this the <video> element cannot seek.
    const ranged = await fetch(`${origin}/api/dsh-imagegen/video/file/seek-0.mp4`, { headers: { range: 'bytes=100-199' } })
    assert.equal(ranged.status, 206, 'a range request answers 206')
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${body.length}`)
    assert.equal(ranged.headers.get('content-length'), '100')
    const slice = Buffer.from(await ranged.arrayBuffer())
    assert.equal(slice.length, 100, 'exactly the requested slice is returned')
    assert.deepEqual(slice, body.subarray(100, 200), 'the slice matches the file bytes')

    // An unsatisfiable range answers 416 with the real size (RFC 7233) rather
    // than silently sending the whole clip with a 200.
    const open = await fetch(`${origin}/api/dsh-imagegen/video/file/seek-0.mp4`, { headers: { range: 'bytes=999999-' } })
    assert.equal(open.status, 416, 'an unsatisfiable range answers 416')
    assert.equal(open.headers.get('content-range'), `bytes */${body.length}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(clipPath, { force: true })
  }
})


await check('V6 a freshly configured generic video model works through the runtime', async () => {
  // Proves the "generic channel" claim: an operator adds an arbitrary video
  // model to a channel and it routes without a code change, deriving its
  // family from the model id rather than from a hard-coded list.
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { id: 'vid_generic', status: 'queued' },
    polls: [{ status: 'completed', url: `http://127.0.0.1:${upstream.port}/generic.mp4` }],
  }
  try {
    const runtime = new host.ImageGenerationRuntime(() => ({
      channels: [{
        id: 'fresh',
        preset: '',
        name: 'FreshChannel',
        apiUrl: upstream.base,
        apiKey: 'sk-generic',
        apiUrlFull: false,
        models: [],
        // A model id the plugin has never seen wired before.
        videoModels: [{ alias: 'my-kling', id: 'kling-v2-master' }],
      }],
      defaultChannelId: 'fresh',
    }))
    const result = await runtime.runVideo({
      mode: 'text',
      model: 'my-kling',
      prompt: 'generic path',
      aspectRatio: '16:9',
      resolution: '720P',
      seconds: 5,
    })
    assert.equal(result.videos.length, 1, 'the generic family produced a clip')
    assert.equal(upstream.state.submits.length, 1, 'one submit reached the upstream')
    assert.equal(upstream.state.submits[0].body.model, 'kling-v2-master', 'the alias maps to the configured upstream id')
    assert.match(result.videos[0].url, /\/api\/dsh-imagegen\/video\/file\//, 'the clip was persisted and served')
    // A video-named id classifies as the generic family (not unknown), which is
    // what lets an operator wire an unwired provider without a code change.
    assert.equal(host.describeVideoModel('kling-v2-master').family, 'openai-video')
  } finally {
    await upstream.close()
  }
})

await check('V7 an unknown-family model configured in a channel fails with guidance', async () => {
  const runtime = new host.ImageGenerationRuntime(() => ({
    channels: [{
      id: 'fresh',
      preset: '',
      name: 'Fresh',
      apiUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'k',
      apiUrlFull: false,
      models: [],
      // No video-ish token at all: a chat model mistakenly pasted into the
      // video catalog must not be guessed at.
      videoModels: [{ alias: 'mystery', id: 'mystery-thing-9000' }],
    }],
    defaultChannelId: 'fresh',
  }))
  // Assert the stable wire code rather than the wording: the message is
  // localized, but the code is part of the contract.
  await assert.rejects(
    () => runtime.runVideo({ mode: 'text', model: 'mystery', prompt: 'p', aspectRatio: '16:9', resolution: '720P', seconds: 5 }),
    error => error?.code === 'video-unknown-model',
    'an unclassifiable model is refused with guidance rather than sent upstream',
  )
})


// ---------------------------------------------------------------------- V4
await check('V4 the Agent video tools submit, poll, cancel and enforce the allow switch', async () => {
  const upstream = await startUpstream()
  upstream.state.script = {
    submit: { video_id: 'vid_agent', status: 'queued' },
    polls: [{ status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.port}/agent.mp4`, duration: 5 } }],
  }
  const tools = new Map()
  let allowed = true
  try {
    const runtime = new host.ImageGenerationRuntime(() => ({
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: upstream.base,
        apiKey: 'sk-test',
        apiUrlFull: false,
        models: [],
        videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
      }],
      defaultChannelId: 'default',
    }), { append: async () => [] })
    const dispose = host.registerAgentVideoTools({
      tools: { register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
      attachments: { readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3]) }) },
    }, runtime, () => ({
      enabled: true,
      allowAgentVideoGeneration: allowed,
      defaultChannelId: 'default',
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: 'configured',
        apiKey: 'configured',
        models: [],
        videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
      }],
    }))
    try {
      assert.ok(tools.has('generate_video'), 'generate_video is registered')
      assert.ok(tools.has('generate_video_from_image'), 'generate_video_from_image is registered')
      assert.ok(tools.has('get_video_generation_task'), 'get_video_generation_task is registered')
      assert.ok(tools.has('cancel_video_generation_task'), 'cancel_video_generation_task is registered')

      const generated = await tools.get('generate_video').execute({ prompt: 'an agent cat', seconds: 5 }, {})
      assert.equal(generated.status, 'completed', 'the Agent tool waits for the render to finish')
      assert.equal(generated.videos.length, 1)
      assert.match(generated.videos[0].url, /\/api\/dsh-imagegen\/video\/file\//)
      assert.equal(generated.videos[0].mime, 'video/mp4')

      const rendered = tools.get('generate_video').output.render({ prompt: 'p' }, generated)
      assert.equal(rendered.length, 1)
      assert.equal(rendered[0].type, 'text', 'video results stay textual; a clip is never attached to the conversation')

      const polled = await tools.get('get_video_generation_task').execute({ task_id: generated.task_id }, {})
      assert.equal(polled.status, 'completed')

      // The allow switch is honored per call.
      allowed = false
      await assert.rejects(() => tools.get('generate_video').execute({ prompt: 'blocked' }, {}), /disabled/i)
      allowed = true

      // Cancelling a missing task reports it instead of throwing something opaque.
      await assert.rejects(() => tools.get('cancel_video_generation_task').execute({ task_id: 'nope' }, {}), /not found/i)
    } finally {
      dispose()
    }
  } finally {
    await upstream.close()
  }
})

await check('V5 an unconfigured video model list is refused with actionable copy', async () => {
  const tools = new Map()
  const runtime = new host.ImageGenerationRuntime(() => ({ channels: [], defaultChannelId: '' }))
  const dispose = host.registerAgentVideoTools({
    tools: { register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
    attachments: { readImage: async ref => ({ ref, data: new Uint8Array([1]) }) },
  }, runtime, () => ({ enabled: true, allowAgentVideoGeneration: true, defaultChannelId: '', channels: [] }))
  try {
    await assert.rejects(
      () => tools.get('generate_video').execute({ prompt: 'p' }, {}),
      /No video models are configured|Settings/i,
    )
  } finally {
    dispose()
  }
})

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nVIDEO SMOKE TEST FAILED' : '\nVIDEO SMOKE TEST OK')

// Clean up the scratch data root (the module caches the path, so this is last).
try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* best effort */ }

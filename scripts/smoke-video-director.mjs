/**
 * Smoke suite for the video DIRECTOR step: the reasoning pass that runs before
 * a video is rendered.
 *
 * Everything here is offline. The upstream provider is a local HTTP server that
 * records what it was sent, and the chat model is a scripted function, so the
 * suite can assert the one thing that matters: **the plan changes what is
 * submitted**. A plan that only logs would pass every UI check and fail P2.
 *
 * What this proves:
 *
 *  D1  planning is opt-in and OFF leaves the request byte-identical
 *  D2  the planned prompt and params are what the provider actually receives
 *  D3  empty / oversized input is refused with a wire code, before any submit
 *  D4  a chat answer that ignores the contract degrades to the offline plan
 *  D5  the offline planner works with no chat model configured at all
 *  D6  a plan never widens what the user asked for (seconds / resolution)
 *  D7  the preview route returns the same plan the submit path will use
 *  D8  the plan reaches the task summary and the history entry
 *  D9  a render failure does not lose the plan that produced it
 *
 * Run: node scripts/smoke-video-director.mjs   (from the package root, after a build)
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const results = []

/** Run one check under a hard deadline (a hung planner is a failure). */
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
    results.push(`FAIL  ${name}: ${error?.stack ?? error?.message ?? error}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

/** The smallest valid-looking MP4 head; only the byte count and MIME matter. */
const MP4 = Buffer.from('00000018667479706d7034320000000069736f6d6d703431', 'hex')

/**
 * A local upstream that speaks the measured submit/poll/download contract and
 * keeps every submit body, so a check can assert exactly what was sent.
 */
function startUpstream() {
  const state = { submits: [], polls: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && (url.pathname === '/v1/videos' || url.pathname === '/v1/videos/generations')) {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        state.submits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ video_id: `vid_${state.submits.length}`, status: 'queued' }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/videos/')) {
      state.polls.push(url.pathname)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: 'completed',
        metadata: { url: `http://127.0.0.1:${server.address().port}/out/clip.mp4`, duration: 5 },
      }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('.mp4')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) })
      res.end(MP4)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

/** Point the plugin's data root at a scratch dir before importing the host. */
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-director-smoke-'))
process.env.DSH_HOME = dataRoot
const host = await import(new URL('lib/index.js', root).href)

/** A channels view wired to one upstream, with one video alias. */
function viewFor(base, alias = 'agnes-video-2.5-flash') {
  return () => ({
    channels: [{
      id: 'default',
      preset: '',
      name: 'DirectorChannel',
      apiUrl: base,
      apiKey: 'sk-test',
      apiUrlFull: false,
      models: [],
      videoModels: [{ alias, id: alias }],
    }],
    defaultChannelId: 'default',
  })
}

/** A chat endpoint stub: the model config plus a scripted completer. */
function chatStub(answer, options = {}) {
  const calls = []
  return {
    calls,
    seam: {
      resolveConfig: () => ({ apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'chat-key', model: 'director-model' }),
      complete: async input => {
        calls.push(input)
        if (options.throwError !== undefined) throw new Error(options.throwError)
        if (options.never === true) return new Promise(() => {})
        return answer
      },
    },
  }
}

/** A valid director answer for a two-beat request. */
const GOOD_PLAN = JSON.stringify({
  look: '写实电影感',
  shotLanguage: '中景，侧光，浅景深',
  pacing: 0.6,
  shots: [
    { shot: '两个年轻人在咖啡馆门口相遇', action: '女生回头，男生抬手打招呼', camera: '缓慢推近', seconds: 3 },
    { shot: '两人并肩走出门口', action: '并肩走远，衣角被风吹起', camera: '横向跟拍', seconds: 2 },
  ],
  prompt: '写实电影感，中景侧光。第 1 个画面：两个年轻人在咖啡馆门口相遇，女生回头，男生抬手打招呼，镜头缓慢推近。第 2 个画面：两人并肩走出门口，衣角被风吹起，横向跟拍。',
  seconds: 5,
  aspectRatio: '16:9',
  resolution: '720P',
})

const baseRequest = {
  mode: 'text',
  model: 'agnes-video-2.5-flash',
  prompt: '两个人在咖啡馆门口相遇',
  aspectRatio: '16:9',
  resolution: '720P',
  seconds: 5,
}

// ---------------------------------------------------------------------- D1
await check('D1 planning is opt-in: without the flag the prompt reaches the provider unchanged', async () => {
  const upstream = await startUpstream()
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base))
    const result = await runtime.runVideo({ ...baseRequest })
    const sent = upstream.state.submits[0]
    assert.equal(sent.prompt, baseRequest.prompt, 'the prompt is sent verbatim when planning is off')
    assert.equal(sent.seconds, '5')
    assert.equal(result.plan, undefined, 'no plan is reported when planning is off')
    const history = await host.listVideoHistory()
    assert.equal(history[0].plan, undefined, 'no plan is persisted when planning is off')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D2
await check('D2 the plan decides the prompt and params the provider receives', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const result = await runtime.runVideo({ ...baseRequest, plan: true })
    const sent = upstream.state.submits[0]

    assert.notEqual(sent.prompt, baseRequest.prompt, 'the provider does NOT receive the raw sentence')
    assert.match(sent.prompt, /第 1 个画面/, 'the provider receives the shot-by-shot plan')
    assert.match(sent.prompt, /缓慢推近/, 'the camera movement reaches the provider')
    assert.equal(sent.size, '720P')
    assert.equal(sent.seconds, '5')

    const plan = result.plan
    assert.ok(plan !== undefined, 'the finished task reports its plan')
    assert.equal(plan.source, 'chat', 'the chat backend produced this plan')
    assert.equal(plan.degraded, false)
    assert.equal(plan.shots.length, 2, 'both planned shots are reported')
    assert.equal(plan.prompt, sent.prompt, 'the reported plan is exactly what was submitted')
    assert.equal(plan.style.look, '写实电影感')

    // The chat call itself must carry the request and its parameter ceiling, or
    // the model cannot honour it.
    assert.equal(chat.calls.length, 1, 'exactly one planning call per render')
    assert.match(chat.calls[0].content, /两个人在咖啡馆门口相遇/, 'the planner sees the user sentence')
    assert.match(chat.calls[0].content, /seconds<=5/, 'the planner is told the parameter ceiling')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D3
await check('D3 empty and oversized prompts are refused before any submit', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)

    await assert.rejects(
      () => runtime.runVideo({ ...baseRequest, prompt: '   ', plan: true }),
      error => error?.code === 'video-prompt-empty',
      'an empty prompt is refused with its own wire code',
    )
    assert.equal(upstream.state.submits.length, 0, 'nothing is submitted for an empty prompt')
    assert.equal(chat.calls.length, 0, 'the chat model is not called for an empty prompt')

    await assert.rejects(
      () => runtime.runVideo({ ...baseRequest, prompt: '长'.repeat(host.MAX_PROMPT_CHARS + 1), plan: true }),
      error => error?.code === 'video-prompt-too-long' && /4000/.test(error.message),
      'an oversized prompt is refused with the limit in the message',
    )
    assert.equal(upstream.state.submits.length, 0, 'nothing is submitted for an oversized prompt')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D4
await check('D4 an off-contract chat answer degrades to the offline plan, and still renders', async () => {
  const upstream = await startUpstream()
  // A chat model that answers prose (the classic failure once a reasoning model
  // is wired in): the plan must still exist, and must say it was repaired.
  const chat = chatStub('当然可以！这是一段很美的视频，讲的是两个人在咖啡馆门口相遇的故事。')
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const result = await runtime.runVideo({ ...baseRequest, plan: true })
    const plan = result.plan
    assert.ok(plan !== undefined, 'a plan is still produced')
    assert.equal(plan.degraded, true, 'the plan is marked degraded')
    assert.match(plan.degradedReason ?? '', /离线规划/, 'the reason names the fallback')
    assert.equal(plan.source, 'heuristic', 'the offline planner produced it')
    assert.notEqual(upstream.state.submits[0].prompt, baseRequest.prompt, 'the provider still receives a planned prompt')
    assert.match(upstream.state.submits[0].prompt, /画面/, 'the offline plan still structures the prompt into shots')
  } finally {
    await upstream.close()
  }
})

await check('D4b a chat outage degrades instead of blocking the render', async () => {
  const upstream = await startUpstream()
  const chat = chatStub('', { throwError: 'chat endpoint unreachable' })
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const result = await runtime.runVideo({ ...baseRequest, plan: true })
    assert.equal(result.plan?.degraded, true, 'the outage is recorded on the plan')
    assert.match(result.plan?.degradedReason ?? '', /unreachable/, 'the chat error is kept in the reason')
    assert.equal(upstream.state.submits.length, 1, 'the render still reached the provider')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D5
await check('D5 with no chat model configured the offline planner still plans', async () => {
  const upstream = await startUpstream()
  try {
    // No director seam at all: the host that never mounted prompt enhancement.
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base))
    const result = await runtime.runVideo({
      ...baseRequest,
      prompt: '雨夜霓虹街头，女孩回头看向镜头',
      plan: true,
    })
    const plan = result.plan
    assert.ok(plan !== undefined, 'the offline planner produced a plan')
    assert.equal(plan.source, 'heuristic')
    assert.equal(plan.degraded, true, 'it is reported as a fallback, not as a chat plan')
    assert.ok(plan.shots.length >= 1, 'it still emits a shot list')
    assert.notEqual(upstream.state.submits[0].prompt, '雨夜霓虹街头，女孩回头看向镜头', 'the provider receives the planned prompt')
    assert.ok(plan.prompt.length > 0)
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D6
await check('D6 a plan never widens the user-facing parameters', async () => {
  const upstream = await startUpstream()
  // A planner asking for longer / sharper than the user chose. Only a narrower
  // request is legal: widening silently raises render time and cost.
  const greedy = JSON.stringify({
    look: '写实电影感',
    shotLanguage: '特写',
    pacing: 0.9,
    shots: [{ shot: '一个镜头', action: '缓慢转身', camera: '推近', seconds: 30 }],
    prompt: '写实电影感，特写。第 1 个画面：一个人缓慢转身，镜头推近。',
    seconds: 30,
    aspectRatio: '16:9',
    resolution: '1080P',
  })
  const chat = chatStub(greedy)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const result = await runtime.runVideo({ ...baseRequest, seconds: 5, resolution: '720P', plan: true })
    assert.equal(result.plan?.params.seconds, 5, 'seconds are not widened past the user value')
    assert.equal(result.plan?.params.resolution, '720P', 'resolution is not raised past the user value')
    assert.equal(upstream.state.submits[0].seconds, '5', 'the provider receives the narrowed duration')
    assert.equal(upstream.state.submits[0].size, '720P')
  } finally {
    await upstream.close()
  }

  // A narrower ask IS honoured: a draft render may drop to 480P.
  const upstream2 = await startUpstream()
  const draft = chatStub(JSON.stringify({ ...JSON.parse(greedy), resolution: '480P', seconds: 2 }))
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream2.base), undefined, undefined, draft.seam)
    const result = await runtime.runVideo({ ...baseRequest, seconds: 5, resolution: '1080P', plan: true })
    assert.equal(result.plan?.params.resolution, '480P', 'a narrower resolution is accepted')
    assert.equal(result.plan?.params.seconds, 2, 'a shorter duration is accepted')
    assert.equal(upstream2.state.submits[0].size, '480P')
    assert.equal(upstream2.state.submits[0].seconds, '2')
  } finally {
    await upstream2.close()
  }
})

await check('D6b a plan is clamped to what the model family actually accepts', async () => {
  // comemoe only takes 16:9 / 9:16 / 1:1 and never 4:3: a planner proposing a
  // frame the provider rejects must be overruled, not forwarded.
  const upstream = await startUpstream()
  const chat = chatStub(JSON.stringify({
    ...JSON.parse(GOOD_PLAN),
    aspectRatio: '4:3',
    resolution: '480P',
  }))
  try {
    const runtime = new host.ImageGenerationRuntime(
      viewFor(upstream.base, 'zhimeng-h3-local'),
      undefined, undefined, chat.seam,
    )
    const result = await runtime.runVideo({
      ...baseRequest,
      model: 'zhimeng-h3-local',
      aspectRatio: '16:9',
      resolution: '720P',
      plan: true,
    })
    assert.equal(result.plan?.params.aspectRatio, '16:9', 'an unsupported aspect ratio is refused')
    assert.equal(upstream.state.submits[0].aspect_ratio, '16:9')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D7
await check('D7 the preview route returns a plan the submit path can adopt verbatim', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const previewed = await runtime.planVideoRequest({ ...baseRequest })
    assert.equal(upstream.state.submits.length, 0, 'previewing renders nothing')

    // Submit the previewed plan: the chat model must NOT run again, or the
    // render would differ from what the user just approved.
    const rendered = await runtime.runVideo({ ...baseRequest, plan: true, planPreview: previewed })
    assert.equal(chat.calls.length, 1, 'adopting a preview does not re-call the chat model')
    assert.equal(rendered.plan?.prompt, previewed.prompt, 'submit sends exactly the previewed prompt')
    assert.deepEqual(rendered.plan?.params, previewed.params, 'submit uses exactly the previewed params')
    assert.equal(upstream.state.submits[0].prompt, previewed.prompt, 'the provider receives the previewed prompt')
  } finally {
    await upstream.close()
  }
})

await check('D7b a previewed plan that arrives over the wire cannot widen the request', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const previewed = await runtime.planVideoRequest({ ...baseRequest })
    // A tampered preview: 30s, 1080P and a huge prompt. The host must clamp it.
    const tampered = {
      ...previewed,
      prompt: '长'.repeat(host.MAX_PLANNED_PROMPT_CHARS + 200),
      params: { seconds: 30, aspectRatio: '16:9', resolution: '1080P' },
    }
    const rendered = await runtime.runVideo({ ...baseRequest, seconds: 5, resolution: '720P', plan: true, planPreview: tampered })
    assert.equal(rendered.plan?.params.seconds, 5, 'a tampered duration is clamped to the user value')
    assert.equal(rendered.plan?.params.resolution, '720P', 'a tampered resolution is clamped to the user value')
    assert.ok((rendered.plan?.prompt.length ?? 0) <= host.MAX_PLANNED_PROMPT_CHARS, 'an oversized prompt is truncated')
    assert.equal(upstream.state.submits[0].seconds, '5')
    assert.equal(upstream.state.submits[0].size, '720P')
  } finally {
    await upstream.close()
  }
})

await check('D7c the preview route answers over real HTTP and agrees with submit', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const routes = host.makeRoutes({
      settings: { describe: () => [], mutate: async () => ({}) },
      resolve: () => ({ apiUrl: '', apiKey: '' }),
      resolveChannels: () => ({ channels: [], defaultChannelId: '' }),
      runtime,
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
    const post = async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, json: await response.json() }
    }
    try {
      const planned = await post('/api/dsh-imagegen/video/plan', { ...baseRequest })
      assert.equal(planned.status, 200)
      assert.equal(planned.json.ok, true, 'the plan route answers ok')
      assert.ok(planned.json.plan !== undefined, 'the plan route returns a plan')
      assert.ok(planned.json.plan.shots.length > 0, 'the plan carries shots over the wire')

      const empty = await post('/api/dsh-imagegen/video/plan', { ...baseRequest, prompt: '' })
      assert.equal(empty.json.ok, false, 'an empty prompt is refused over the wire too')
      assert.ok(typeof empty.json.code === 'string' && empty.json.code !== '', 'the refusal carries a wire code')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D8
await check('D8 the plan reaches the task summary and the history entry', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    const task = runtime.videoQueue.submit({ ...baseRequest, plan: true })
    const settled = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = runtime.videoQueue.get(task.id)
        if (current !== undefined && (current.status === 'completed' || current.status === 'failed')) return current
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return undefined
    })()
    assert.ok(settled !== undefined, 'the queued task settled')
    assert.equal(settled.status, 'completed', `the render completed (${settled?.error ?? ''})`)

    const summary = runtime.videoQueue.summaries().find(row => row.id === task.id)
    assert.ok(summary !== undefined)
    assert.ok(summary.plan !== undefined, 'the summary carries the plan, so the panel can show it')
    assert.equal(summary.plan.shots.length, 2)

    const history = await host.listVideoHistory()
    const entry = history.find(row => row.id === summary.resultEntryId)
    assert.ok(entry !== undefined, 'the history entry exists')
    assert.ok(entry.plan !== undefined, 'the history entry keeps the plan that shaped it')
    assert.equal(entry.prompt, summary.plan.prompt, 'history stores the prompt that was actually used')
  } finally {
    await upstream.close()
  }
})

// ---------------------------------------------------------------------- D9
await check('D9 a failed render keeps the plan, so the failure is explainable', async () => {
  const upstream = await startUpstream()
  const chat = chatStub(GOOD_PLAN)
  try {
    const runtime = new host.ImageGenerationRuntime(viewFor(upstream.base), undefined, undefined, chat.seam)
    // The failure is injected at the engine boundary: the plan has already run,
    // and the plan is what the user needs to see when the render dies.
    const engine = runtime.runVideo.bind(runtime)
    let captured
    runtime.runVideo = async (request, signal) => {
      const plan = await runtime.planVideoRequest(request, signal)
      captured = plan
      throw new host.VideoGenError('上游渲染失败（注入）', 'video-failed')
    }
    await assert.rejects(() => runtime.runVideo({ ...baseRequest, plan: true }), /注入/)
    assert.ok(captured !== undefined, 'the plan ran before the failure')
    assert.equal(captured.shots.length, 2)
    runtime.runVideo = engine
  } finally {
    await upstream.close()
  }
})

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nVIDEO DIRECTOR SMOKE TEST FAILED' : '\nVIDEO DIRECTOR SMOKE TEST OK')

try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* best effort */ }

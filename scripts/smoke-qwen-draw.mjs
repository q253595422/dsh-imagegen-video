// 千问生图 API 协议（自建 ComfyUI HTTP 封装）：请求拼装、异步轮询、结果下载、
// 模型发现与前置拒绝。全部用桩 fetch：断言「发给上游的 JSON / 路径长什么样」和
// 「不该发的时候直接报错」，不需要网络、不需要密钥，不产生任何付费调用。
// Run: node scripts/smoke-qwen-draw.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 诊断/信号落盘指到临时目录，别写进真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-qwen-draw-smoke-'))
process.env.DSH_HOME = home
const { generateImage, ImageGenError } = await import('../src/engine.ts')
const { listImageModels } = await import('../src/prompt-enhancer.ts')
const { qwenDrawBaseUrl } = await import('../src/protocol.ts')

// 引擎的轮询 sleep 用 unref 定时器（真实宿主有 HTTP server 保活）；离线套件
// 没有其他句柄，必须自己留一个，否则 Node 会在等待轮询时直接退出。
const keepAlive = setInterval(() => {}, 1000)

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const pngB64 = pngBytes.toString('base64')
const BASE_URL = 'http://127.0.0.1:8787'

const calls = []
let jobSeq = 0
let uploadSeq = 0
let jobs = new Map()
let handler = defaultHandler

function defaultHandler (url, init) {
  if (url === `${BASE_URL}/api/models`) {
    return {
      status: 200,
      body: {
        ok: true,
        defaultModel: 'krea2-turbo',
        models: [
          { id: 'qwen-turbo', label: '千问 2.1 Turbo', steps: 8, promptLang: 'multi' },
          { id: 'qwen-gguf', label: '千问 2.1 GGUF Q8', steps: 8, promptLang: 'multi' },
          { id: 'krea2-turbo', label: 'Krea2 Turbo', steps: 8, promptLang: 'multi' },
          { id: 'sdxl', label: 'SDXL 1.0', steps: 25, promptLang: 'en' },
        ],
      },
    }
  }
  if (url === `${BASE_URL}/api/upload` && init?.method === 'POST') {
    const bytes = init.body instanceof Uint8Array ? init.body.byteLength : 0
    const id = `upload-${++uploadSeq}`
    return { status: 200, body: { ok: true, id, bytes, url: `/api/images/${id}.png` } }
  }
  if (url === `${BASE_URL}/api/draw` && init?.method === 'POST') {
    const id = `job-${++jobSeq}`
    jobs.set(id, 0)
    return { status: 200, body: { ok: true, id, state: 'running', model: 'qwen-turbo', queuePosition: 0, elapsedSeconds: 0 } }
  }
  if (url.startsWith(`${BASE_URL}/api/jobs/`)) {
    const id = url.slice(`${BASE_URL}/api/jobs/`.length)
    const polls = (jobs.get(id) ?? 0) + 1
    jobs.set(id, polls)
    if (polls < 2) return { status: 200, body: { ok: true, id, state: 'running', queuePosition: 0, elapsedSeconds: 1.2 } }
    return {
      status: 200,
      body: {
        ok: true,
        id,
        state: 'done',
        model: 'qwen-turbo',
        result: { id, model: 'qwen-turbo', width: 1024, height: 1024, seed: 1, steps: 8, seconds: 1.2, bytes: pngBytes.byteLength, url: `/api/images/${id}.png`, createdAt: '2026-11-09T00:00:00.000Z' },
      },
    }
  }
  if (url.startsWith(`${BASE_URL}/api/images/`)) {
    return { status: 200, body: pngBytes, headers: { 'content-type': 'image/png' } }
  }
  if (url.endsWith('/images/generations')) {
    return { status: 200, body: { data: [{ b64_json: pngB64 }] } }
  }
  throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
}

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  const result = handler(String(url), init)
  const payload = result.body instanceof Uint8Array ? result.body : typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
  return new Response(payload, {
    status: result.status,
    headers: result.headers ?? { 'content-type': 'application/json' },
  })
}
const reset = next => {
  calls.length = 0
  jobSeq = 0
  uploadSeq = 0
  jobs = new Map()
  handler = next ?? defaultHandler
}

const upstream = { apiUrl: BASE_URL, apiKey: 'test-qwen-key', protocol: 'qwen-draw', channelName: '千问生图测试' }
const base = { mode: 'text', model: 'qwen-turbo', prompt: '一只猫', size: '16:9', quality: '2k', n: 1, detail: '' }
const expectCode = async (promise, code) => {
  await assert.rejects(promise, error => error instanceof ImageGenError && error.code === code, `应抛 ImageGenError(${code})`)
}

// 1) 提交请求形状：POST /api/draw、Bearer、prompt/model/size/megapixels，不带 n。
{
  reset()
  const result = await generateImage(upstream, { ...base })
  assert.equal(calls[0].url, `${BASE_URL}/api/draw`, 'submit must POST /api/draw')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-qwen-key')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { prompt: '一只猫', model: 'qwen-turbo', size: '16:9', megapixels: 2 }, 'qwen-draw must send the requested model; 2k → 2MP; size 直接使用面板比例')
  assert.equal(body.n, undefined, 'body 不带 n')
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngB64)
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(calls[1].url, `${BASE_URL}/api/jobs/job-1`)
  assert.equal(calls[1].init.headers.authorization, 'Bearer test-qwen-key')
  assert.equal(calls[2].url, `${BASE_URL}/api/jobs/job-1`)
  assert.equal(calls[3].url, `${BASE_URL}/api/images/job-1.png`)
}

// 2) auto/空参数省略；21:9 映射到 16:9；4k 走最高档。
{
  reset()
  await generateImage(upstream, { ...base, size: 'auto', quality: 'auto' })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.size, undefined, 'auto 时不发 size')
  assert.equal(body.megapixels, undefined, 'auto 时不发 megapixels')

  reset()
  await generateImage(upstream, { ...base, size: '21:9', quality: '4k' })
  const mapped = JSON.parse(calls[0].init.body)
  assert.equal(mapped.size, '16:9', '21:9 没有上游档位，按 16:9 发送')
  assert.equal(mapped.megapixels, 2, '4k 取 2MP 上限')
}

// 3) apiUrlFull 指向 /api/draw 时也能还原服务根并继续轮询。
{
  reset()
  assert.equal(qwenDrawBaseUrl(`${BASE_URL}/api/draw`), BASE_URL)
  assert.equal(qwenDrawBaseUrl(`${BASE_URL}/api/draw/sync`), BASE_URL)
  assert.equal(qwenDrawBaseUrl(`${BASE_URL}/api/models`), BASE_URL)
  await generateImage({ ...upstream, apiUrl: `${BASE_URL}/api/draw`, apiUrlFull: true }, { ...base })
  assert.equal(calls[0].url, `${BASE_URL}/api/draw`)
  assert.ok(calls.some(call => call.url === `${BASE_URL}/api/jobs/job-1`), '完整 URL 也能还原轮询根地址')
}

// 4) n 由并行单图任务满足，结果按序展平。
{
  reset()
  const many = await generateImage(upstream, { ...base, n: 3 })
  assert.equal(calls.filter(call => call.url === `${BASE_URL}/api/draw`).length, 3, 'n=3 提交三次')
  assert.equal(many.images.length, 3)
}

// 5) 图生图：先 POST /api/upload（原始字节、图片 content-type），再用 image_id 提交。
{
  reset()
  const edited = await generateImage(upstream, { ...base, mode: 'edit', image: 'data:image/png;base64,' + pngB64 })
  assert.equal(calls[0].url, `${BASE_URL}/api/upload`, 'edit uploads the reference first')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'image/png', 'upload sends the reference mime')
  assert.equal(calls[0].init.body.byteLength, pngBytes.byteLength, 'upload sends the raw bytes')
  assert.equal(calls[1].url, `${BASE_URL}/api/draw`)
  const editBody = JSON.parse(calls[1].init.body)
  assert.equal(editBody.image_id, 'upload-1', 'draw references the uploaded image id')
  assert.equal(edited.images.length, 1)

  reset()
  const multiRefs = await generateImage(upstream, { ...base, mode: 'edit', image: 'data:image/png;base64,' + pngB64, images: ['data:image/png;base64,' + pngB64] })
  assert.equal(calls.filter(call => call.url === `${BASE_URL}/api/upload`).length, 2, 'multi-reference edit uploads each reference')
  const multiBody = JSON.parse(calls[2].init.body)
  assert.deepEqual(multiBody.image_ids, ['upload-1', 'upload-2'], 'multi-reference draw sends image_ids')
  assert.equal(multiRefs.images.length, 1)

  reset()
  await expectCode(generateImage(upstream, { ...base, mode: 'edit' }), 'edit-image-missing')
  assert.equal(calls.length, 0, '缺参考图在网络调用之前拒绝')
  reset()
  await expectCode(generateImage(upstream, { ...base, mode: 'edit', image: 'not-a-data-url' }), 'edit-image-invalid')
  assert.equal(calls.length, 0, '坏参考图在网络调用之前拒绝')
}

// 6) 提交失败：ok:false / 非 JSON 都按上游错误处理。
{
  reset(() => ({ status: 200, body: { ok: false, error: '队列已满' } }))
  await assert.rejects(generateImage(upstream, { ...base }), error => error.code === 'upstream-rejected' && error.message.includes('队列已满'))
  reset(() => ({ status: 200, body: '<html>no json</html>' }))
  await expectCode(generateImage(upstream, { ...base }), 'upstream-invalid')
}

// 7) 轮询失败状态透传上游消息。
{
  reset((url, init) => {
    if (url === `${BASE_URL}/api/draw`) return { status: 200, body: { ok: true, id: 'job-bad', state: 'running' } }
    if (url === `${BASE_URL}/api/jobs/job-bad`) return { status: 200, body: { ok: true, id: 'job-bad', state: 'failed', error: 'ComfyUI 节点报错' } }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  })
  await assert.rejects(generateImage(upstream, { ...base }), error => error.code === 'upstream-rejected' && error.message.includes('ComfyUI 节点报错'))
}

// 8) 模型发现：GET /api/models、Bearer，返回全部图像模型（不按命名启发式丢弃）。
{
  reset()
  const models = await listImageModels({ apiUrl: BASE_URL, apiKey: 'test-qwen-key', protocol: 'qwen-draw' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE_URL}/api/models`)
  assert.equal(calls[0].init.method, undefined, '模型列表是 GET')
  assert.deepEqual(models, ['krea2-turbo', 'qwen-gguf', 'qwen-turbo', 'sdxl'])
}

// 9) 协议隔离：images 渠道仍走 /images/generations，不受 qwen-draw 分派影响。
{
  reset()
  await generateImage({ ...upstream, protocol: 'images' }, { ...base })
  assert.ok(calls[0].url.endsWith('/images/generations'), 'images 协议不受 qwen-draw 分派影响')
}

// 10) 无鉴权部署：qwen-draw 允许空 API Key，且不发送 Authorization。
{
  reset()
  await generateImage({ ...upstream, apiKey: '' }, { ...base })
  assert.equal(calls[0].init.headers.authorization, undefined, '空 Key 时不发送 Authorization')
}

// 11) GIF 前置拒绝：协议层与模型层两道闸都在网络调用之前。
{
  reset()
  await expectCode(generateImage(upstream, { ...base, model: 'gpt-image-2.6', outputFormat: 'gif' }), 'gif-protocol-unsupported')
  assert.equal(calls.length, 0, 'GIF capable 模型配 qwen-draw 也在协议层拒绝')
}

clearInterval(keepAlive)
rmSync(home, { recursive: true, force: true })
console.log('QWEN-DRAW SMOKE OK')

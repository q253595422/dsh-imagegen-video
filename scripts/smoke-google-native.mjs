// Google 原生渠道协议（issue #28）：:generateContent 的请求拼装、响应解析、
// 模型发现与前置拒绝。全部用桩 fetch：断言「发给上游的 JSON 长什么样」和
// 「不该发的时候直接报错」，不需要网络、不需要密钥，不产生任何付费调用。
// 直接 import src（Node 24 原生剥类型），无需构建。
// Run: node scripts/smoke-google-native.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 诊断/信号落盘指到临时目录，别写进真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-google-native-smoke-'))
process.env.DSH_HOME = home
const { generateImage, ImageGenError } = await import('../src/engine.ts')
const { googleNativeUrl, listImageModels } = await import('../src/prompt-enhancer.ts')

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const pngB64 = pngBytes.toString('base64')
const pngDataUrl = `data:image/png;base64,${pngB64}`
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const calls = []
const okImage = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngB64 } }] } }] } })
let handler = okImage
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  const { status, body } = handler(String(url), init)
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const reset = next => { calls.length = 0; handler = next ?? okImage }

const upstream = { apiUrl: BASE_URL, apiKey: 'test-google-key', protocol: 'google-native', channelName: 'Google 原生测试' }
const base = { mode: 'text', model: 'gemini-2.5-flash-image', prompt: '一只猫', size: '16:9', quality: '2k', n: 1, detail: '' }
const expectCode = async (promise, code) => {
  await assert.rejects(promise, error => error instanceof ImageGenError && error.code === code, `应抛 ImageGenError(${code})`)
}

// 1) URL 构造：剥已知后缀、拼 :generateContent、清 query/hash、models/ 前缀。
assert.equal(googleNativeUrl(BASE_URL, 'gemini-2.5-flash-image'), `${BASE_URL}/models/gemini-2.5-flash-image:generateContent`)
assert.equal(googleNativeUrl(`${BASE_URL}/models/gemini-2.5-flash-image:generateContent`, 'gemini-3-pro-image'), `${BASE_URL}/models/gemini-3-pro-image:generateContent`)
assert.equal(googleNativeUrl(`${BASE_URL}/models`, 'models/gemini-2.5-flash-image'), `${BASE_URL}/models/gemini-2.5-flash-image:generateContent`)
assert.equal(googleNativeUrl(`${BASE_URL}/interactions`, 'gemini-2.5-flash-image'), `${BASE_URL}/models/gemini-2.5-flash-image:generateContent`)
assert.equal(googleNativeUrl(`${BASE_URL}/?foo=bar#frag`), `${BASE_URL}/models`, '无模型时是 GET models 列表地址，query/hash 清掉')
assert.throws(() => googleNativeUrl('not a url', 'x'), /绝对 API URL/)

// 2) 文生图请求形状：x-goog-api-key、contents/parts、generationConfig、不带 n。
{
  reset()
  const result = await generateImage(upstream, { ...base })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE_URL}/models/gemini-2.5-flash-image:generateContent`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-google-key')
  assert.equal(calls[0].init.headers.authorization, undefined, 'google-native 不发 Bearer')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '一只猫' }] }])
  assert.equal(body.generationConfig.candidateCount, 1)
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE'])
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '2K' }, 'imageConfig 嵌套在 generationConfig 里')
  assert.equal(body.n, undefined, 'body 不带 n')
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngB64)
  assert.equal(result.images[0].mime, 'image/png')
}

// 3) auto/空参数省略，不向上游发默认值。
{
  reset()
  await generateImage(upstream, { ...base, size: 'auto', quality: 'auto' })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.generationConfig.imageConfig, undefined, 'auto 时不发 imageConfig')
}

// 4) 图生图：最多 5 张 inlineData 排在文本前；缺图/坏图/超 10MB 前置拒绝。
{
  reset()
  await generateImage(upstream, { ...base, mode: 'edit', image: pngDataUrl, images: [pngDataUrl, pngDataUrl, pngDataUrl, pngDataUrl, pngDataUrl] })
  const parts = JSON.parse(calls[0].init.body).contents[0].parts
  assert.equal(parts.length, 6, '5 张参考图 + 1 段文本，第 6 张被截掉')
  assert.deepEqual(parts[5], { text: '一只猫' })
  for (const part of parts.slice(0, 5)) assert.deepEqual(part, { inlineData: { mimeType: 'image/png', data: pngB64 } })

  reset()
  await expectCode(generateImage(upstream, { ...base, mode: 'edit' }), 'edit-image-missing')
  assert.equal(calls.length, 0, '缺参考图在网络调用之前拒绝')
  reset()
  await expectCode(generateImage(upstream, { ...base, mode: 'edit', image: 'not-a-data-url' }), 'edit-image-invalid')
  assert.equal(calls.length, 0)
  reset()
  const bigDataUrl = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`
  await expectCode(generateImage(upstream, { ...base, mode: 'edit', image: bigDataUrl }), 'edit-image-too-large')
  assert.equal(calls.length, 0)
}

// 5) 响应解析：thought 跳过、inline_data 别名、缺 mimeType 按字节嗅探、
//    空结果带 blockReason。
{
  reset(() => ({ status: 200, body: { candidates: [{ content: { parts: [
    { thought: true, inlineData: { mimeType: 'image/png', data: pngB64 } },
    { inline_data: { data: pngB64 } },
  ] } }] } }))
  const parsed = await generateImage(upstream, { ...base })
  assert.equal(parsed.images.length, 1, 'thought 部分应跳过')
  assert.equal(parsed.images[0].mime, 'image/png', '缺 mimeType 时按字节嗅探')

  reset(() => ({ status: 200, body: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } }))
  await assert.rejects(generateImage(upstream, { ...base }), error => error.code === 'upstream-empty' && error.message.includes('SAFETY'), '空结果应带 blockReason')
  reset(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: '没有图' }] } }] } }))
  await expectCode(generateImage(upstream, { ...base }), 'upstream-empty')
}

// 6) GIF 前置拒绝：协议层与模型层两道闸都在网络调用之前。
{
  reset()
  await expectCode(generateImage(upstream, { ...base, model: 'gpt-image-2.6', outputFormat: 'gif' }), 'gif-protocol-unsupported')
  assert.equal(calls.length, 0, 'GIF  capable 模型配 google-native 渠道也在协议层拒绝')
  reset()
  await expectCode(generateImage(upstream, { ...base, outputFormat: 'gif' }), 'gif-unsupported')
  assert.equal(calls.length, 0)
}

// 7) n 由并行单图请求满足，结果按序展平。
{
  reset()
  const many = await generateImage(upstream, { ...base, n: 3 })
  assert.equal(calls.length, 3, 'n=3 发三次单图请求')
  assert.equal(many.images.length, 3)
}

// 8) 上游错误：error.message 透传、非 JSON 归为 upstream-invalid。
{
  reset(() => ({ status: 400, body: { error: { message: 'API key not valid' } } }))
  await assert.rejects(generateImage(upstream, { ...base }), error => error.code === 'upstream-rejected' && error.message.includes('API key not valid'))
  reset(() => ({ status: 200, body: '<html>not json</html>' }))
  await expectCode(generateImage(upstream, { ...base }), 'upstream-invalid')
}

// 9) 模型发现：GET models 列表、x-goog-api-key、name 字段剥 models/ 前缀、
//    只留图像模型。
{
  reset(() => ({ status: 200, body: { models: [
    { name: 'models/gemini-2.5-flash-image' },
    { name: 'models/gemini-3-pro-image' },
    { name: 'models/gemini-2.5-pro' },
    { name: 'models/embedding-001' },
  ] } }))
  const models = await listImageModels({ apiUrl: BASE_URL, apiKey: 'test-google-key', protocol: 'google-native' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE_URL}/models`)
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-google-key')
  assert.equal(calls[0].init.method, undefined, '模型列表是 GET')
  assert.deepEqual(models, ['gemini-2.5-flash-image', 'gemini-3-pro-image'])
}

// 10) 协议隔离：images 渠道仍走 /images/generations，不受新分派影响。
{
  reset(() => ({ status: 200, body: { data: [{ b64_json: pngB64 }] } }))
  await generateImage({ ...upstream, protocol: 'images' }, { ...base })
  assert.ok(calls[0].url.endsWith('/images/generations'), 'images 协议不受 google-native 分派影响')
}

rmSync(home, { recursive: true, force: true })
console.log('GOOGLE-NATIVE SMOKE OK')
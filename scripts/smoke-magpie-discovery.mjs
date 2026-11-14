// Magpie 网关的图像模型发现（issue #47）：`GET /v1/models` 只返回聊天模型，
// 图像条目藏在 `?kind=image` 后面（老版本认 `X-Magpie-Drawers: 1` 头）。
// 全部用桩 fetch：断言「请求发去了哪个 URL、带了什么头」「最终列出哪些模型」，
// 不需要网络、不需要密钥。
// 直接 import src（Node 24 原生剥类型），无需构建。
// Run: node scripts/smoke-magpie-discovery.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-magpie-smoke-'))
process.env.DSH_HOME = home
const { listImageModels, listOpenAIModels } = await import('../src/prompt-enhancer.ts')

const BASE = 'https://magpie.test/v1'
const calls = []
let handler = () => ({ status: 200, body: { data: [] }, contentType: 'application/json' })

/**
 * @param next - `(url, init) => { status, body, contentType? }`; `body` may be
 *   a string (returned verbatim) or a JSON-serialisable value.
 */
const reset = next => { calls.length = 0; handler = next ?? (() => ({ status: 200, body: { data: [] } })) }

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init?.headers ?? {} })
  const { status, body, contentType = 'application/json' } = handler(String(url))
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  })
}

const chatOf = url => url.includes('kind=image')
  ? { data: [
      { id: 'acme/painter-v1', kind: 'image', modalities: { input: ['text'], output: ['image'] } },
      { id: 'acme/talker-v2', kind: 'chat', modalities: { input: ['text'], output: ['text'] } },
    ] }
  : { data: [
      { id: 'acme/talker-v2', kind: 'chat', modalities: { input: ['text'], output: ['text'] } },
      { id: 'acme/coder', kind: 'chat' },
    ] }

// 1) Magpie 真实形状：plain /models 只有聊天模型，?kind=image 才有图像条目。
//    这是 issue 的核心——旧实现第一个候选就返回到空图像列表，检测恒为 0。
{
  reset(url => ({ status: 200, body: chatOf(url) }))
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['acme/painter-v1'], 'Magpie 的 kind:image 条目应被发现')
}

// 2) 图像发现的第一枪必须是 ?kind=image，并带上 X-Magpie-Drawers: 1。
{
  reset(url => ({ status: 200, body: chatOf(url) }))
  await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.ok(calls.length >= 1)
  assert.equal(calls[0].url, `${BASE}/models?kind=image`, '图像发现先问图像作用域的列表')
  assert.equal(calls[0].headers['X-Magpie-Drawers'], '1', '老版本 Magpie 靠这个头返回图像条目')
  assert.equal(calls[0].headers.authorization, 'Bearer k', '鉴权头照旧')
}

// 3) 两种 Magpie 私有形状各自独立生效：只带 kind、只带嵌套 modalities。
//    真实条目两者都有，所以必须分别断言——否则任一判定失效时，另一条会把它
//    认出来，反向验证会绿得没意义。
{
  reset(() => ({ status: 200, body: { data: [{ id: 'acme/kind-only', kind: 'image' }] } }))
  assert.deepEqual(await listImageModels({ apiUrl: BASE, apiKey: 'k' }), ['acme/kind-only'], 'kind:"image" 单独就能识别')

  reset(() => ({ status: 200, body: { data: [
    { id: 'acme/draw-2', modalities: { input: ['text', 'image'], output: ['image'] } },
  ] } }))
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['acme/draw-2'], 'modalities.output 单独就能识别')
}

// 4) kind 不是 image 时不误判；同时保留标准形状与命名兜底。
{
  reset(() => ({ status: 200, body: { data: [
    { id: 'acme/talker', kind: 'chat' },
    { id: 'acme/embed', output_modalities: ['embedding'] },
    { id: 'acme/standard', output_modalities: ['image'] },
    { id: 'flux-pro' },
  ] } }))
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['acme/standard', 'flux-pro'], '标准字段与命名兜底都不回归')
}

// 5) `?kind=image` 被 404 拒掉时回退到普通候选，而不是整个失败。
{
  let scopedTried = false
  reset(url => {
    if (url.includes('kind=image')) { scopedTried = true; return { status: 404, body: { error: { message: 'unknown query' } } } }
    return { status: 200, body: { data: [{ id: 'flux-pro' }] } }
  })
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.ok(scopedTried, '确实试过图像作用域')
  assert.deepEqual(models, ['flux-pro'], '404 后回退到普通 /models')
}

// 6) 网关忽略未知查询参数（原样返回全量列表）：仍然列出图像模型，
//    且不会因为「作用域列表里没有图像模型」就把结果丢掉。
{
  reset(() => ({ status: 200, body: { data: [{ id: 'acme/talker' }, { id: 'flux-pro' }] } }))
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['flux-pro'], '网关忽略未知查询参数，仍要列出图像模型')
}

// 7) 作用域列表返回空数组时回退，拿回普通列表里的图像模型。
{
  reset(url => url.includes('kind=image')
    ? { status: 200, body: { data: [] } }
    : { status: 200, body: { data: [{ id: 'flux-pro' }] } })
  const models = await listImageModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['flux-pro'], '作用域列表返回空数组时回退到普通候选')
}

// 8) 聊天模型列表不受影响：不请求 kind=image，也不带 Magpie 头。
{
  reset(url => ({ status: 200, body: chatOf(url) }))
  const models = await listOpenAIModels({ apiUrl: BASE, apiKey: 'k' })
  assert.deepEqual(models, ['acme/coder', 'acme/talker-v2'], '聊天列表只返回聊天模型')
  assert.equal(calls.length, 1, '聊天列表不该多走一趟')
  assert.ok(!calls[0].url.includes('kind=image'), '聊天列表不请求图像作用域')
  assert.equal(calls[0].headers['X-Magpie-Drawers'], undefined, '聊天列表不带 Magpie 头')
}

// 9) 非 JSON 响应的报错走共享诊断：带地址、Content-Type 与「网页」判断。
{
  reset(() => ({ status: 404, body: '<!doctype html><html><body>404</body></html>', contentType: 'text/html' }))
  await assert.rejects(listImageModels({ apiUrl: BASE, apiKey: 'k' }), error => {
    assert.ok(error.message.includes(`${BASE}/models`), `报错应带请求地址：${error.message}`)
    assert.ok(error.message.includes('text/html'), '报错应带 Content-Type')
    assert.ok(error.message.includes('网页'), 'HTML 应被点名为网页而不是接口响应')
    return true
  })
}

// 10) google-native 只有单一候选，不该被加上 kind=image。
{
  reset(() => ({ status: 200, body: { models: [{ name: 'models/gemini-2.5-flash-image' }] } }))
  await listImageModels({
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'k',
    protocol: 'google-native',
  })
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models')
}

rmSync(home, { recursive: true, force: true })
console.log('MAGPIE DISCOVERY SMOKE OK')

// issue #48：上游返回非 JSON 时的报错必须能让人自助排查。
//
// 事发形态：网关把 `/models` 挂在根上（探测绿灯），但 `/images/generations`
// 只在 `/v1` 下，于是每次生成都拿到一页 HTML。旧文案只有一句
// `上游接口返回了非 JSON 响应（HTTP 404）`——既没有请求地址，也没说返回的是
// 网页，「检测模型通过、生图必失败」这件事无从推断。
//
// 这里钉住三件事：报错里必须有**实际请求的那个地址**、必须点出 HTML 这个
// 事实与「少了 /v1」这条常见原因、并且**不把 markup 本身贴进消息**（那会把
// 一句可读的诊断变成 300 字符的 `<meta charset>`）。
//
// 全部用桩 fetch：不联网、不需要密钥、不产生任何付费调用。
// 直接 import src（Node 原生剥类型），无需构建。
// Run: node scripts/smoke-upstream-diagnosis.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 诊断/信号落盘指到临时目录，别写进真实 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-upstream-diagnosis-smoke-'))
process.env.DSH_HOME = home
const { generateImage, ImageGenError } = await import('../src/engine.ts')
const { generateVideo, VideoGenError } = await import('../src/video-engine.ts')
const { bodyShapeOf, diagnoseNonJsonBody, requestAddress } = await import('../src/upstream-diagnosis.ts')

const calls = []
let handler = () => ({ status: 200, body: '{}', contentType: 'application/json' })
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  const reply = handler(String(url), init)
  const headers = { 'content-type': reply.contentType ?? 'application/json' }
  const body = reply.bytes ?? (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
  return new Response(body, { status: reply.status ?? 200, headers })
}
const reset = next => { calls.length = 0; handler = next ?? (() => ({ status: 200, body: '{}' })) }

const BASE = 'https://gw.example.com'
const HTML_404 = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>404</title></head><body>home</body></html>'

/** 一次 images 协议的生图，返回被抛出的 ImageGenError（断言它确实抛了）。 */
async function imagesFailure(reply, apiUrl = BASE) {
  reset(() => reply)
  try {
    await generateImage({ apiUrl, apiKey: 'test-key', protocol: 'images' }, {
      mode: 'text', model: 'gpt-image-2.6', prompt: '一只猫', size: '1024x1024', quality: 'high', n: 1, detail: '',
    })
  } catch (error) {
    assert.ok(error instanceof ImageGenError, `应抛 ImageGenError，实际是 ${error?.constructor?.name}`)
    return error
  }
  throw new Error('上游返回非 JSON，生图不应成功')
}

// 1) HTML 404：地址、Content-Type、成因三样都要在，且 markup 不进来。
{
  const error = await imagesFailure({ status: 404, contentType: 'text/html; charset=utf-8', body: HTML_404 })
  assert.equal(error.code, 'upstream-invalid', '错误码不变：这次只改文案')
  assert.ok(error.message.includes(`${BASE}/images/generations`), `消息要点名实际请求的地址：${error.message}`)
  assert.match(error.message, /text\/html/, '消息要带上游声明的 Content-Type')
  assert.match(error.message, /\/v1/, '要说出最常见的原因：地址少了 /v1')
  assert.match(error.message, /网页而不是接口响应/, '要点出返回的是网页')
  // `charset=` 不在被禁之列：它正是 Content-Type 头的内容（text/html; charset=utf-8），
  // 刻意保留。被禁的是页面标记本身。
  assert.ok(!/<meta|<html|<body|<!doctype/i.test(error.message), 'markup 本身不得贴进消息')
  assert.equal(calls.length, 1, '不自动重试：一次失败就是一次请求')
  assert.equal(calls[0].url, `${BASE}/images/generations`)
}

// 2) 纯文本非 JSON：带截断摘要，仍然不贴 markup，也不含旧文案。
{
  const error = await imagesFailure({ status: 502, contentType: 'text/plain', body: 'Bad Gateway: upstream connect error or disconnect/reset before headers. reset reason: connection failure, please retry later.' })
  assert.equal(error.code, 'upstream-invalid')
  assert.match(error.message, /502/)
  assert.match(error.message, /响应内容：Bad Gateway/, '纯文本要把内容摘要给出来')
  assert.ok(error.message.length < 400, `摘要必须截断，实际 ${error.message.length} 字符`)
  assert.ok(!error.message.includes('（HTTP 502）'), '旧文案被替换掉了，不留同一句里两套格式')
  assert.ok(!/<meta|<html/i.test(error.message))
}

// 3) 空响应体：只说「空了」，不编造内容。
{
  const error = await imagesFailure({ status: 500, contentType: 'application/json', body: '' })
  assert.equal(error.code, 'upstream-invalid')
  assert.match(error.message, /响应体是空的/, '空体单独一句，不能复用文本摘要分支')
  assert.ok(!error.message.includes('响应内容：'), '空体没有内容可摘')
}

// 4) 二进制响应体：出图流被当成接口响应时就是这种形状。
{
  const error = await imagesFailure({
    status: 200,
    contentType: 'image/png',
    bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]), Buffer.alloc(24)]),
  })
  assert.equal(error.code, 'upstream-invalid')
  assert.match(error.message, /二进制/, '要认出这是二进制而不是散文')
  assert.match(error.message, /image\/png/)
}

// 5) 两条生成路径各自报的是自己的地址，而不是一条写死的字符串。
{
  const imagesError = await imagesFailure({ status: 404, contentType: 'text/html', body: HTML_404 })
  const chatError = await (async () => {
    reset(() => ({ status: 404, contentType: 'text/html', body: HTML_404 }))
    try {
      await generateImage(
        { apiUrl: `${BASE}/v1/chat/completions`, apiKey: 'test-key', protocol: 'chat-completions' },
        { mode: 'text', model: 'gpt-image-2.6', prompt: '一只猫', size: '1024x1024', quality: 'high', n: 1, detail: '' },
      )
    } catch (error) {
      return error
    }
    throw new Error('上游返回非 JSON，chat-completions 不应成功')
  })()
  assert.ok(imagesError.message.includes(`${BASE}/images/generations`))
  assert.ok(chatError.message.includes(`${BASE}/v1/chat/completions`), `chat 路径要点名自己的地址：${chatError.message}`)
  assert.notEqual(imagesError.message, chatError.message, '两条路径的地址不同，文案不可能相同')
  assert.equal(chatError.code, 'upstream-invalid')
  assert.equal(calls[0].url, `${BASE}/v1/chat/completions`)
}

// 6) 视频引擎：提交返回 200 + HTML（网关把站点首页当接口应答）。
//    这条是「最像上游故障」的形状——没有状态码差异，只有 body 不对。
{
  reset(() => ({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML_404 }))
  const videoBase = 'https://api.nbility.ai/v1'
  let caught
  try {
    await generateVideo(
      { apiUrl: videoBase, apiKey: 'test-key', channelName: 'WrongBase' },
      { mode: 'text', model: 'MiniMax-H3', prompt: '海面日落', aspectRatio: '16:9', resolution: '768P', seconds: 5 },
    )
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof VideoGenError, `应抛 VideoGenError，实际是 ${caught?.constructor?.name}`)
  assert.equal(caught.code, 'video-submit-failed', '「渲染根本没开始」这个分类不变')
  assert.ok(caught.message.includes(`${videoBase}/videos`), `视频消息要点名提交地址：${caught.message}`)
  assert.match(caught.message, /text\/html/)
  assert.match(caught.message, /\/v1/)
  assert.ok(!/<meta|<html|<body|<!doctype/i.test(caught.message), 'markup 不得贴进视频的消息')
  assert.equal(calls.length, 1, '非 JSON 的提交不再多发一次请求')
}

// 7) 分类器与地址脱敏的纯函数边界（报错里绝不能出现 query 里的密钥）。
{
  assert.equal(bodyShapeOf('   <!DOCTYPE html><html>'), 'html')
  assert.equal(bodyShapeOf('<div>404</div>', 'text/html'), 'html', '没有 doctype 但声明了 text/html 也算网页')
  assert.equal(bodyShapeOf(''), 'empty')
  assert.equal(bodyShapeOf('   '), 'empty')
  assert.equal(bodyShapeOf('\u0000\u0001binary'), 'binary')
  assert.equal(bodyShapeOf('plain words'), 'text')
  assert.equal(requestAddress('https://gw.example.com/v1/images/generations?api_key=secret'), 'https://gw.example.com/v1/images/generations', 'query 里可能有密钥，报错不带')
  const built = diagnoseNonJsonBody({
    label: '上游接口', url: 'https://gw.example.com/images/generations?key=abc', status: 404, contentType: '', text: HTML_404,
  })
  assert.ok(!built.includes('key=abc'), '消息里不得出现 query')
  assert.match(built, /未声明 Content-Type/, '服务端没给 Content-Type 时要如实说，而不是显示空白')
}

rmSync(home, { recursive: true, force: true })
console.log('UPSTREAM-DIAGNOSIS SMOKE OK')

// GIF 输出（gpt-image-2.6）的请求体拼装与前置拒绝。
// 全部用桩 fetch：这里断言的是「发给上游的 JSON 长什么样」和「不该发的时候直接报错」，
// 不需要网络、不需要密钥，也不会产生任何付费调用。
import assert from 'node:assert/strict'
import { generateImage } from '../src/engine.ts'
import { supportsGifOutput } from '../src/model-catalog.ts'

const calls = []
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4])
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined })
  return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(gifBytes).toString('base64') }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

const upstream = { apiUrl: 'https://api.example.com/v1', apiKey: 'sk-test', channelName: '测试渠道' }
const base = {
  mode: 'text', model: 'gpt-image-2.6-sunburst', prompt: '一只猫抬爪招手，然后回到起始姿势，镜头不动',
  size: '1:1', quality: 'auto', n: 1, detail: '', outputFormat: 'gif', frameCount: 9, frameDurationMs: 200,
}
const textRequest = () => ({ ...base })
const reset = () => { calls.length = 0 }

// 1) 能力判定：只有 2.6 系（且非 vip）能出 GIF。
assert.equal(supportsGifOutput('gpt-image-2.6-sunburst'), true, '2.6 应支持 GIF')
assert.equal(supportsGifOutput('gpt-image-2.6-flare'), true, '2.6 flare 应支持 GIF')
assert.equal(supportsGifOutput('gpt-image-2.5'), false, '2.5 不支持 GIF')
assert.equal(supportsGifOutput('gpt-image-2'), false, '2 不支持 GIF')
assert.equal(supportsGifOutput('gpt-image-2.6-vip'), false, '2.6 的 vip 档不出 GIF')

// 2) 动图请求体：output_format / frame_count / frame_duration_ms，且走 generations 而不是 edits。
{
  reset()
  const result = await generateImage(upstream, textRequest())
  assert.equal(calls.length, 1, 'GIF 应只发一次请求（数量固定为 1）')
  assert.ok(calls[0].url.endsWith('/images/generations'), `GIF 应走 generations，实际 ${calls[0].url}`)
  const body = JSON.parse(calls[0].body)
  assert.equal(body.output_format, 'gif')
  assert.equal(body.frame_count, 9)
  assert.equal(body.frame_duration_ms, 200)
  assert.equal(body.size, '512x512', 'GIF 帧尺寸应取小尺寸表，避开 9 帧共享的像素预算')
  assert.equal(body.quality, undefined, 'quality=auto 时不应发 quality')
  // 返回体是 GIF 字节，宿主识别成 image/gif 才能落成 .gif
  assert.equal(result.images[0].mime, 'image/gif', 'GIF 结果应以 image/gif 归一化')
}

// 3) 帧数与每帧时长被夹紧到文档区间（2–16、≥20ms、按 10ms 取整）。
{
  reset()
  await generateImage(upstream, { ...textRequest(), frameCount: 99, frameDurationMs: 37 })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.frame_count, 16, '帧数上限 16')
  assert.equal(body.frame_duration_ms, 40, '每帧毫秒按 10ms 取整且不低于 20')
}
{
  reset()
  await generateImage(upstream, { ...textRequest(), frameCount: 1, frameDurationMs: 1 })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.frame_count, 2, '正数但低于下限时夹到 2')
  assert.equal(body.frame_duration_ms, 20, '每帧毫秒下限 20')
}
{
  // 清空输入框得到 0，那是「未设置」而不是用户选了 0 帧：必须和面板的时长提示
  // 走同一个夹紧函数，否则提示按 9 帧 / 200ms 算、请求却发 2 帧 / 20ms。
  reset()
  await generateImage(upstream, { ...textRequest(), frameCount: 0, frameDurationMs: 0 })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.frame_count, 9, '0 视为未设置，回落默认帧数')
  assert.equal(body.frame_duration_ms, 200, '0 视为未设置，回落默认帧时长')
}

// 4) 参数缺省时用文档默认值。
{
  reset()
  await generateImage(upstream, { ...base, frameCount: undefined, frameDurationMs: undefined })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.frame_count, 9)
  assert.equal(body.frame_duration_ms, 200)
}

// 5) 不支持的模型：直接拒绝，一个请求都不发。
{
  reset()
  await assert.rejects(
    () => generateImage(upstream, { ...textRequest(), model: 'gpt-image-2.5' }),
    error => error.code === 'gif-unsupported',
    '2.5 请求 GIF 应被拒绝',
  )
  assert.equal(calls.length, 0, '被拒绝的请求不得发出')
}

// 6) 图生图不出 GIF：官方指南写明 /images/edits 不支持。
{
  reset()
  await assert.rejects(
    () => generateImage(upstream, { ...textRequest(), mode: 'edit', image: 'data:image/png;base64,AAAA' }),
    error => error.code === 'gif-edit-unsupported',
    '图生图 GIF 应被拒绝',
  )
  assert.equal(calls.length, 0)
}

// 7) 非 GIF 请求完全不受影响（回归）：不带 output_format，尺寸走原有档位。
{
  reset()
  await generateImage(upstream, { ...base, outputFormat: undefined, frameCount: undefined, frameDurationMs: undefined })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.output_format, undefined, '静图不得带 output_format')
  assert.equal(body.frame_count, undefined, '静图不得带 frame_count')
  assert.equal(body.size, '1024x1024', '静图仍走原有尺寸表')
}

// 8) chat/completions 渠道：请求体只有 model/messages/stream，没有 output_format，
//    即使模型是 2.6 也只会产出静图。必须在任何网络调用前拒绝，不能让用户为
//    一张被历史标成 GIF 的静图付费。
{
  reset()
  await assert.rejects(
    () => generateImage({ ...upstream, protocol: 'chat-completions' }, textRequest()),
    error => error.code === 'gif-protocol-unsupported',
    'chat/completions 渠道请求 GIF 应被拒绝',
  )
  assert.equal(calls.length, 0, '被拒绝的 chat 协议请求不得发出')
}

// 9) Qwen 原生分支在 effectiveParams 之前就 return，前置校验必须挡住它。
{
  reset()
  await assert.rejects(
    () => generateImage(upstream, { ...textRequest(), model: 'qwen-image' }),
    error => error.code === 'gif-unsupported',
    'Qwen 原生分支请求 GIF 应被拒绝',
  )
  assert.equal(calls.length, 0, '被拒绝的 Qwen 请求不得发出')
}

// 10) MiniMax 原生分支同上。
{
  reset()
  await assert.rejects(
    () => generateImage(upstream, { ...textRequest(), model: 'image-01' }),
    error => error.code === 'gif-unsupported',
    'MiniMax 原生分支请求 GIF 应被拒绝',
  )
  assert.equal(calls.length, 0, '被拒绝的 MiniMax 请求不得发出')
}

console.log('PASS GIF 输出请求体、夹紧与前置拒绝 10/10')

/**
 * 导演台导出视频：宿主编码层的离线验收。
 *
 * 这一层是整条导出链上唯一"用户看不见、但错了就全废"的一段：客户端逐帧传
 * 上来的 PNG 由它落盘、排序、交给 ffmpeg、写进视频库。它的失败模式都很安静
 * （帧跳号、画幅奇数、临时目录残留），而一旦漏出去，用户看到的是"导出的视频
 * 少了两秒"或"磁盘越来越大"，没人能把这些现象和这里联系起来。
 *
 * 这里断言的是**规则**，不是像素：真实编码需要 ffmpeg，缺工具时明确跳过而
 * 不是伪装通过（仓库里 `verify-timeline-compose` 也是这个口径）。
 *
 * Run: node scripts/smoke-stage-encode.mjs
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createCheckHarness } from './lib/check-harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 把数据目录指到临时目录，**必须在任何 src/ 之前**。
 *
 * WHY 这条在这里而不是「以后再说」：`E9` 真的调 `stageEncodeSession()`，而它在
 * 编码成功后会把成片写进视频库（`appendVideoHistory`）。不设 `DSH_HOME`，
 * `image-storage-path.ts` 就解析成 `~/.dsh/dsh-imagegen` —— 用户真实的库。
 *
 * 后果不是多几条垃圾：条目 id 是固定的 `stage-e9-real`（由会话 id 派生），
 * 于是每跑一次 `pnpm test` 就往真实历史里**追加一条同 id 的 64×64 蓝帧**。
 * 用户看到的是「列表里三条一模一样的『3D 导演台导出』，点删除只少一条」——
 * 因为 store 的 `removeVideoHistory` 用 `filter(id !== x)` 一次就抹掉全部同 id
 * 条目，而 React 用 `video:${id}` 做 key，三条行撞在同一个 key 上。
 * 2026-11-18 用户就是这样遇到的。
 */
const home = mkdtempSync(join(tmpdir(), 'dsh-stage-encode-'))
process.env.DSH_HOME = home

const results = []
const check = createCheckHarness({ results })

/**
 * 造一张真的 PNG。
 *
 * 不用写死的最小 2×2 图：那张图能通过所有校验，但 ffmpeg 编 H.264 时会因为
 * 画面太小（x264 的宏块与 4:2:0 抽样都放不下）直接失败，于是「真编码」那两条
 * 断言验的是测试素材的缺陷，不是产品代码。这里自己压 zlib，不引入新依赖。
 */
function makePng (size, rgb) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = buffer => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // 位深
  ihdr[9] = 2   // truecolour
  // 每行：一个 filter 字节 + size×RGB
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = rgb[0]; raw[at + 1] = rgb[1]; raw[at + 2] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const TINY_PNG = makePng(64, [40, 90, 160])
const TINY_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`

const mod = await import(join(ROOT, 'src/stage-encode.ts'))

// ------------------------------------------------------------ 输入校验

await check('E1 a sessionId with path characters is rejected', async () => {
  for (const bad of ['../escape', 'a/b', '/abs', '', '   ', 'x'.repeat(65)]) {
    let threw = false
    try {
      await mod.stagePutFrame({ sessionId: bad, index: 0, total: 1, width: 2, height: 2, fps: 30, dataUrl: TINY_URL })
    } catch { threw = true }
    assert.ok(threw, `sessionId ${JSON.stringify(bad)} must be rejected — it becomes a directory name`)
  }
})

await check('E2 a non-PNG frame is rejected', async () => {
  let message = ''
  try {
    await mod.stagePutFrame({
      sessionId: 'e2', index: 0, total: 1, width: 2, height: 2, fps: 30,
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    })
  } catch (error) { message = String(error?.message ?? error) }
  assert.match(message, /PNG/, 'the error must name the expected format, not just fail')
})

await check('E3 an index outside the declared total is rejected', async () => {
  let threw = false
  try {
    await mod.stagePutFrame({ sessionId: 'e3', index: 5, total: 3, width: 2, height: 2, fps: 30, dataUrl: TINY_URL })
  } catch { threw = true }
  assert.ok(threw, 'index 5 of total 3 is a client bug, not a frame to store')
})

await check('E4 a frame count past the protocol ceiling is rejected', async () => {
  let threw = false
  try {
    await mod.stagePutFrame({
      sessionId: 'e4', index: 0, total: mod.STAGE_MAX_FRAMES + 1,
      width: 2, height: 2, fps: 30, dataUrl: TINY_URL,
    })
  } catch { threw = true }
  assert.ok(threw, `total above ${mod.STAGE_MAX_FRAMES} frames must be refused`)
})

await check('E5 the frame ceiling covers the 15s project limit at 30fps', async () => {
  assert.ok(
    mod.STAGE_MAX_FRAMES >= 15 * 30,
    `15s × 30fps = 450 frames must fit, ceiling is ${mod.STAGE_MAX_FRAMES}`,
  )
})

// ------------------------------------------------------------ 收帧与编排

await check('E6 accepting the same index twice overwrites instead of erroring', async () => {
  const base = { sessionId: 'e6', total: 2, width: 2, height: 2, fps: 30, dataUrl: TINY_URL }
  await mod.stagePutFrame({ ...base, index: 0 })
  const again = await mod.stagePutFrame({ ...base, index: 0 })
  assert.equal(again.received, 1, 'a retried frame must still count once')
  assert.equal(again.total, 2, 'progress must report the declared total')
})

await check('E7 encoding with a frame still missing says which ones', async () => {
  // e6 has frame 0 but not 1.
  let message = ''
  try { await mod.stageEncodeSession({ sessionId: 'e6' }) } catch (error) { message = String(error?.message ?? error) }
  assert.match(message, /1/, 'the error must name the missing index')
  assert.match(message, /帧|frame/i, 'the error must say these are frames')
})

await check('E8 encoding an unknown session fails with a readable reason', async () => {
  let message = ''
  try { await mod.stageEncodeSession({ sessionId: 'never-uploaded' }) } catch (error) { message = String(error?.message ?? error) }
  assert.match(message, /会话|session|找不到/i, 'an expired session must explain itself, not crash')
})

// ------------------------------------------------------------ 真编码（需 ffmpeg）

const hasFfmpeg = await (async () => {
  try {
    const { findTool } = await import(join(ROOT, 'src/video-tools.ts'))
    return findTool('ffmpeg') !== undefined
  } catch { return false }
})()

if (!hasFfmpeg) {
  process.stdout.write('stage encode: ffmpeg not found — the real-encode checks are skipped\n')
} else {
  await check('E9 a complete 6-frame session encodes to a real mp4', async () => {
    const sessionId = 'e9-real'
    const total = 6
    for (let index = 0; index < total; index += 1) {
      await mod.stagePutFrame({
        sessionId, index, total, width: 64, height: 64, fps: 30, dataUrl: TINY_URL,
      })
    }
    const result = await mod.stageEncodeSession({ sessionId })
    assert.equal(result.mime, 'video/mp4', 'the encoded file must be mp4')
    assert.ok(result.bytes > 0, 'an encoded mp4 must have bytes')
    assert.ok(
      Math.abs(result.duration - total / 30) < 1e-6,
      `duration must come from the real frame count (${total}/30), got ${result.duration}`,
    )
    assert.ok(typeof result.url === 'string' && result.url.length > 0, 'the result must carry a readable URL')
  })

  await check('E10 encoding the same session twice is idempotent', async () => {
    const first = await mod.stageEncodeSession({ sessionId: 'e9-real' })
    const second = await mod.stageEncodeSession({ sessionId: 'e9-real' })
    assert.deepEqual(second, first, 'a retried encode must return the first result, not encode again')
  })
}

await mod.resetStageEncode?.()
rmSync(home, { recursive: true, force: true })
process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nstage encode: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nstage encode: ${results.length} passed\n`)
}

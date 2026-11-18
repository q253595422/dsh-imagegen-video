/**
 * 导演台导出链路的离线验收：帧序号、进度、取消、结果归一。
 *
 * 这一层是用户唯一能**看见进度**的地方，也因此它的错误最像"卡住了"而不是
 * "坏了"：进度倒退一帧、取消没在上传前生效、宿主已经直接把结果带回来了却
 * 又去问一次——用户看到的都是"导出好像没反应"。这些规则都与像素无关，所以
 * 用注入的假渲染器在 Node 里就能验，不需要 WebGL。
 *
 * 通过 `render` 注入点把真渲染换掉；`renderStageToDataUrl` 需要 WebGL，在这里
 * 跑不起来（这正是那个注入点存在的理由）。
 *
 * Run: node scripts/smoke-stage-export.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []
const check = createCheckHarness({ results })

const { exportStageVideo, StageExportAborted } = await import(join(ROOT, 'src/client/canvas/stage-export.ts'))
const { emptyStageTimeline } = await import(join(ROOT, 'src/client/canvas/stage-timeline.ts'))

/** 一份最小的舞台：一个角色、一台机位、一条时间轴。 */
function stageWith (timeline) {
  return {
    actors: [{ id: 'actor-1', name: 'A', rig: { joints: {}, facing: 0 }, x: 0, z: 0 }],
    cameras: [{
      id: 'camera-1', name: '机位', x: 0, y: 1.6, z: 5,
      targetX: 0, targetY: 1, targetZ: 0, fov: 40,
    }],
    cameraId: 'camera-1',
    scene: { sky: '#1b2030', translate: [0, 0, 0], rotateY: 0, scale: 100, panoYaw: 0, panoRadius: 20, labels: false },
    ...(timeline === undefined ? {} : { timeline }),
  }
}

const FAKE_PNG = 'data:image/png;base64,iVBORw0KGgo='

/** 一个记账用的假宿主：记下每一帧的序号与声明的 total。 */
function fakeApi (options = {}) {
  const frames = []
  return {
    frames,
    calls: { encode: 0 },
    async stageFrame (payload) {
      frames.push(payload)
      if (options.failAt !== undefined && frames.length === options.failAt) {
        throw new Error('upstream said no')
      }
      // 默认只回 ok；`returnsResult` 打开时模拟"最后一帧顺手带回结果"。
      if (options.returnsResult === true && payload.index === payload.total - 1) {
        return { ok: true, url: '/videos/x.mp4', mime: 'video/mp4', duration: payload.total / payload.fps, bytes: 123 }
      }
      return { ok: true }
    },
    async stageEncode (sessionId) {
      this.calls.encode += 1
      returnedSessionIds.push(sessionId)
      return { url: '/videos/y.mp4', mime: 'video/mp4', duration: 0.2, bytes: 456 }
    },
  }
}
const returnedSessionIds = []

const render = () => FAKE_PNG

// ------------------------------------------------------------ 前置条件

await check('X1 a stage without a timeline refuses to export a video', async () => {
  let message = ''
  try {
    await exportStageVideo(fakeApi(), { stage: stageWith(undefined), width: 64, height: 64, render })
  } catch (error) { message = String(error?.message ?? error) }
  assert.match(message, /timeline/i, 'the error must name the missing timeline')
})

// ------------------------------------------------------------ 帧序号

await check('X2 a 1s timeline uploads 30 frames numbered 0..29', async () => {
  const api = fakeApi()
  const timeline = { ...emptyStageTimeline(), duration: 1 }
  await exportStageVideo(api, { stage: stageWith(timeline), width: 64, height: 64, render })
  assert.equal(api.frames.length, 30, `a 1s / 30fps timeline is 30 frames, got ${api.frames.length}`)
  assert.deepEqual(
    api.frames.map(frame => frame.index),
    Array.from({ length: 30 }, (_, index) => index),
    'frames must be uploaded in order starting at 0, with no gaps',
  )
})

await check('X3 every frame declares the same total and the timeline fps', async () => {
  const api = fakeApi()
  const timeline = { ...emptyStageTimeline(), duration: 2 }
  await exportStageVideo(api, { stage: stageWith(timeline), width: 64, height: 64, render })
  const totals = new Set(api.frames.map(frame => frame.total))
  const fps = new Set(api.frames.map(frame => frame.fps))
  assert.equal(totals.size, 1, 'every frame must carry the same total, or the host cannot detect a gap')
  assert.equal([...totals][0], 60, 'a 2s timeline is 60 frames')
  assert.deepEqual([...fps], [30], 'the fps must be the protocol 30, not a client invention')
})

await check('X4 the declared size reaches every frame', async () => {
  const api = fakeApi()
  const timeline = { ...emptyStageTimeline(), duration: 1 }
  await exportStageVideo(api, { stage: stageWith(timeline), width: 1280, height: 720, render })
  for (const frame of api.frames) {
    assert.equal(frame.width, 1280, 'the width must be the one asked for')
    assert.equal(frame.height, 720, 'the height must be the one asked for')
  }
})

// ------------------------------------------------------------ 进度

await check('X5 progress rises monotonically and ends at 1', async () => {
  const api = fakeApi()
  const seen = []
  const timeline = { ...emptyStageTimeline(), duration: 1 }
  await exportStageVideo(api, {
    stage: stageWith(timeline), width: 64, height: 64, render,
    onProgress: ratio => seen.push(ratio),
  })
  assert.equal(seen.length, 30, 'one progress tick per frame')
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index] >= seen[index - 1], `progress went backwards at ${index}: ${seen[index - 1]} -> ${seen[index]}`)
  }
  assert.equal(seen.at(-1), 1, 'progress must end at exactly 1')
})

// ------------------------------------------------------------ 取消

await check('X6 aborting stops before the next upload', async () => {
  const api = fakeApi()
  const controller = new AbortController()
  const timeline = { ...emptyStageTimeline(), duration: 2 }
  let threw = null
  try {
    await exportStageVideo(api, {
      stage: stageWith(timeline), width: 64, height: 64, render,
      signal: controller.signal,
      onProgress: ratio => { if (ratio >= 0.1) controller.abort() },
    })
  } catch (error) { threw = error }
  assert.ok(threw instanceof StageExportAborted, `aborting must throw StageExportAborted, got ${String(threw)}`)
  assert.ok(api.frames.length < 60, `it must stop early, uploaded ${api.frames.length} of 60`)
  assert.equal(api.calls.encode, 0, 'an aborted export must never ask the host to encode')
})

await check('X7 an already-aborted signal uploads nothing at all', async () => {
  const api = fakeApi()
  const controller = new AbortController()
  controller.abort()
  let threw = null
  try {
    await exportStageVideo(api, {
      stage: stageWith({ ...emptyStageTimeline(), duration: 1 }),
      width: 64, height: 64, render, signal: controller.signal,
    })
  } catch (error) { threw = error }
  assert.ok(threw instanceof StageExportAborted, 'an aborted signal must abort before the first frame')
  assert.equal(api.frames.length, 0, 'not a single frame may be uploaded')
})

// ------------------------------------------------------------ 结果归一

await check('X8 a result returned with the last frame avoids a second round trip', async () => {
  const api = fakeApi({ returnsResult: true })
  const result = await exportStageVideo(api, {
    stage: stageWith({ ...emptyStageTimeline(), duration: 1 }),
    width: 64, height: 64, render,
  })
  assert.equal(api.calls.encode, 0, 'when the host already answered, do not ask again')
  assert.equal(result.url, '/videos/x.mp4', 'the result must be the one the host returned')
})

await check('X9 a plain ok on the last frame falls through to an explicit encode', async () => {
  const api = fakeApi()
  returnedSessionIds.length = 0
  const result = await exportStageVideo(api, {
    stage: stageWith({ ...emptyStageTimeline(), duration: 1 }),
    width: 64, height: 64, render,
  })
  assert.equal(api.calls.encode, 1, 'without a result, exactly one encode call is expected')
  assert.equal(result.url, '/videos/y.mp4', 'the encode result is what gets used')
  assert.equal(returnedSessionIds.length, 1, 'the encode must be asked for a specific session')
  assert.match(returnedSessionIds[0], /^[0-9a-f-]{36}$/, 'the session id must be a UUID the host will accept')
})

await check('X10 one export uses one session id for every frame', async () => {
  const api = fakeApi()
  await exportStageVideo(api, {
    stage: stageWith({ ...emptyStageTimeline(), duration: 1 }),
    width: 64, height: 64, render,
  })
  const ids = new Set(api.frames.map(frame => frame.sessionId))
  assert.equal(ids.size, 1, 'frames of one export must share a session, or the host assembles two broken videos')
})

await check('X11 a mid-way upload failure propagates as the original error', async () => {
  const api = fakeApi({ failAt: 5 })
  let threw = null
  try {
    await exportStageVideo(api, {
      stage: stageWith({ ...emptyStageTimeline(), duration: 1 }),
      width: 64, height: 64, render,
    })
  } catch (error) { threw = error }
  assert.ok(threw !== null, 'a failed upload must not be swallowed')
  assert.ok(!(threw instanceof StageExportAborted), 'a host failure is not a user cancellation')
  assert.match(String(threw?.message), /upstream said no/, 'the original message must survive')
})

// ---------------------------------------------------------------------- 收尾

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nstage export: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nstage export: ${results.length} passed\n`)
}

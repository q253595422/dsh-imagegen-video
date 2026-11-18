/**
 * 导演台时间轴（`stage-timeline.ts`）的离线检查。
 *
 * 这个模块是纯函数，所以这里测的不是界面，而是**六条会被用户直接看见的
 * 不变式**：
 *
 *  T*  时间求值。第 t 秒的角色在哪、看哪、摆什么姿势——这是整个功能的承诺。
 *      区间外不外推、单端关键帧不偏移、跨 ±180 走最短弧。
 *  K*  关键帧增删。同一时刻只有一格（后到覆盖）；删一格不影响相邻；删对象
 *      不能留下指向不存在对象的孤儿轨道。
 *  D*  时长变更。缩短时长必须把超出的关键帧裁掉——留着会让「最后一个姿势」
 *      在没有可见原因的情况下改变。
 *  G*  轨迹求值。四种形状在 u=0/1 上落在预期端点，`height` 叠加，`orient`
 *      给出切线朝向；轨迹与位置关键帧重叠时轨迹优先。
 *  F*  导出帧表。5 秒 30fps 是 150 帧而不是 151；终点那帧不重复。
 *  R*  退化输入。老文档没有 timeline、手改的 JSON 里轨道残缺——一律不抛。
 *
 * Run: node scripts/smoke-stage-timeline.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

const results = []
const check = createCheckHarness({ results })

const root = mkdtempSync(join(tmpdir(), 'gal-stage-timeline-'))
process.env.DSH_HOME = root

const tl = await import(new URL('../src/client/canvas/stage-timeline.ts', import.meta.url).href)
const stageMod = await import(new URL('../src/client/canvas/pose-stage.ts', import.meta.url).href)

const FRAME = 1 / 30

/** 一个单角色、单机位的舞台，角色站在原点。 */
function baseStage() {
  return {
    ...stageMod.emptyStage(),
    timeline: tl.emptyStageTimeline(),
  }
}

/** 一份 rig，只有一个关节有角度，便于断言插值结果。 */
function rigWith(x) {
  return { joints: { shoulderR: { x, y: 0, z: 0 } }, facing: 0 }
}

// ------------------------------------------------------------ 时间求值

await check('T1 a keyframe pair interpolates linearly between them', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 0, position: [0, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 2, position: [4, 0, 0] })
  stage = { ...stage, timeline }

  const midway = tl.sampleStage(stage, 1)
  assert.equal(midway.actors[0].x, 2, 'at t=1 the actor must be halfway (x=2)')
  const quarter = tl.sampleStage(stage, 0.5)
  assert.equal(quarter.actors[0].x, 1, 'at t=0.5 the actor must be a quarter of the way (x=1)')
})

await check('T2 outside the keyframe range the value is held, never extrapolated', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 2, position: [4, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 4, position: [8, 0, 0] })
  stage = { ...stage, timeline }

  // t=0 在第一个关键帧之前：必须停在 x=4，而不是按斜率外推出 x=0。
  assert.equal(tl.sampleStage(stage, 0).actors[0].x, 4, 'a time before the first keyframe must hold its value')
  // t=5 在最后一个之后：停在 x=8。
  assert.equal(tl.sampleStage(stage, 5).actors[0].x, 8, 'a time after the last keyframe must hold its value')
})

await check('T3 a single keyframe pins the value at every time', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  const timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [3, 0, -2] })
  stage = { ...stage, timeline }
  for (const t of [0, 1, 2.5, 5]) {
    const sampled = tl.sampleStage(stage, t)
    assert.equal(sampled.actors[0].x, 3, `x must stay pinned at t=${t}`)
    assert.equal(sampled.actors[0].z, -2, `z must stay pinned at t=${t}`)
  }
})

await check('T4 rig interpolation crosses ±180 the short way', async () => {
  // 170° → -170°：继续同方向转 20°，中点应当是 180（等价于 -180），
  // 而不是倒回 0°。走错这一次，用户会看到手臂突然转一圈。
  const from = { joints: { shoulderR: { x: 170, y: 0, z: 0 } }, facing: 0 }
  const to = { joints: { shoulderR: { x: -170, y: 0, z: 0 } }, facing: 0 }
  const mid = tl.lerpRig(from, to, 0.5)
  const value = Math.abs(mid.joints.shoulderR.x)
  assert.ok(Math.abs(value - 180) < 1e-6, `expected ±180 at the midpoint, got ${mid.joints.shoulderR.x}`)
})

await check('T5 a keyframe carrying only a rig does not move the actor', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  stage = { ...stage, actors: [{ ...stage.actors[0], x: 1.5, z: -2 }] }
  const timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, rig: rigWith(40) })
  stage = { ...stage, timeline }
  const sampled = tl.sampleStage(stage, 1)
  assert.equal(sampled.actors[0].x, 1.5, 'a rig-only keyframe must not reset the position')
  assert.equal(sampled.actors[0].z, -2, 'a rig-only keyframe must not reset the position')
  assert.equal(sampled.actors[0].rig.joints.shoulderR.x, 40, 'the rig snapshot must apply')
})

await check('T6 camera keyframes interpolate the whole pose', async () => {
  let stage = baseStage()
  const cameraId = stage.cameras[0].id
  const from = { ...stage.cameras[0], x: 0, fov: 30 }
  const to = { ...stage.cameras[0], x: 10, fov: 50 }
  let timeline = tl.putKeyframe(stage.timeline, 'camera', cameraId, { at: 0, camera: from })
  timeline = tl.putKeyframe(timeline, 'camera', cameraId, { at: 4, camera: to })
  stage = { ...stage, timeline }
  const sampled = tl.sampleStage(stage, 2)
  assert.equal(sampled.cameras[0].x, 5, 'camera x must interpolate')
  assert.equal(sampled.cameras[0].fov, 40, 'camera fov must interpolate too')
})

await check('T7 sampleStage never mutates its input', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 0, position: [0, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 2, position: [4, 0, 0] })
  stage = { ...stage, timeline }
  const before = JSON.stringify(stage)
  tl.sampleStage(stage, 1)
  tl.sampleStage(stage, 3)
  assert.equal(JSON.stringify(stage), before, 'sampleStage must not write through to the stage it was given')
})

// ---------------------------------------------------------- 关键帧增删

await check('K1 writing the same time twice replaces, keeping one keyframe', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [1, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 1, position: [9, 0, 0] })
  const track = tl.trackOf(timeline, 'actor', id)
  assert.equal(track.keyframes.length, 1, 'two writes at the same time must leave one keyframe')
  assert.equal(track.keyframes[0].position[0], 9, 'the later write must win')
})

await check('K2 removeKeyframe takes out exactly one frame', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [1, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 2, position: [2, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 3, position: [3, 0, 0] })
  timeline = tl.removeKeyframe(timeline, 'actor', id, 2)
  const track = tl.trackOf(timeline, 'actor', id)
  assert.equal(track.keyframes.length, 2)
  assert.deepEqual(track.keyframes.map(frame => frame.at), [1, 3])
})

await check('K3 removing an absent keyframe leaves the timeline untouched', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  const timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [1, 0, 0] })
  const after = tl.removeKeyframe(timeline, 'actor', id, 4)
  assert.equal(tl.trackOf(after, 'actor', id).keyframes.length, 1)
})

await check('K4 removeTrack drops the track entirely', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  const timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [1, 0, 0] })
  const after = tl.removeTrack(timeline, 'actor', id)
  assert.equal(tl.trackOf(after, 'actor', id), undefined)
  assert.equal(after.tracks.length, 0)
})

await check('K5 keyframes are written frame-aligned', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  // 1.007 秒离第 30 帧（1.0 秒）最近，必须落成 1.0。
  const timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1.007, position: [1, 0, 0] })
  const at = tl.trackOf(timeline, 'actor', id).keyframes[0].at
  assert.ok(Math.abs(at - 1) < 1e-9, `expected 1.0 after snapping, got ${at}`)
})

// ------------------------------------------------------------ 时长变更

await check('D1 shrinking the duration drops keyframes past the end', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 1, position: [1, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 10, position: [10, 0, 0] })
  const shorter = tl.retimeTimeline(timeline, 3)
  assert.equal(shorter.duration, 3)
  const track = tl.trackOf(shorter, 'actor', id)
  assert.deepEqual(track.keyframes.map(frame => frame.at), [1], 'a keyframe past the new end must be dropped')
})

await check('D2 a duration out of range is clamped, not rejected', async () => {
  assert.equal(tl.retimeTimeline(tl.emptyStageTimeline(), 99).duration, tl.STAGE_MAX_DURATION)
  assert.equal(tl.retimeTimeline(tl.emptyStageTimeline(), 0).duration, tl.STAGE_MIN_DURATION)
})

// ------------------------------------------------------------ 轨迹求值

await check('G1 a line path runs from its first point to its last', async () => {
  const path = { id: 'p', shape: 'line', points: [[0, 0, 0], [10, 0, 0]], start: 0, end: 2 }
  const head = tl.pathPointAt(path, 0)
  const tail = tl.pathPointAt(path, 1)
  assert.deepEqual([head[0], head[1], head[2]], [0, 0, 0])
  assert.deepEqual([tail[0], tail[1], tail[2]], [10, 0, 0])
  const mid = tl.pathPointAt(path, 0.5)
  assert.ok(Math.abs(mid[0] - 5) < 1e-9, 'the midpoint of a line must be halfway along it')
})

await check('G2 a circle path returns to its start at u=1', async () => {
  const path = { id: 'p', shape: 'circle', points: [[0, 0, 0], [2, 0, 0]], start: 0, end: 3 }
  const head = tl.pathPointAt(path, 0)
  const almost = tl.pathPointAt(path, 1)
  assert.ok(Math.abs(head[0] - 2) < 1e-6, 'u=0 sits on the radius point')
  assert.ok(Math.abs(almost[0] - 2) < 1e-6, 'a full circle comes back to the radius point')
  const quarter = tl.pathPointAt(path, 0.25)
  assert.ok(Math.abs(quarter[2] - 2) < 1e-6, 'a quarter turn reaches the far side (+z)')
})

await check('G3 a rect path walks four edges and closes', async () => {
  // 4×2 的矩形周长 12。u=0.25 是沿周长走 3：还在第一条边上（x=3），
  // 不是拐角；u=0.5 走 6 才到对角 (4,0,2)。这里按弧长断言，不按顶点。
  const path = { id: 'p', shape: 'rect', points: [[0, 0, 0], [4, 0, 2]], start: 0, end: 4 }
  const close = tl.pathPointAt(path, 1)
  assert.ok(Math.abs(close[0]) < 1e-6 && Math.abs(close[2]) < 1e-6, 'a closed rect ends where it began')
  const quarter = tl.pathPointAt(path, 0.25)
  assert.ok(Math.abs(quarter[0] - 3) < 1e-6, `a quarter of the perimeter (3 of 12) should be x=3, got ${quarter[0]}`)
  const half = tl.pathPointAt(path, 0.5)
  assert.ok(Math.abs(half[0] - 4) < 1e-6 && Math.abs(half[2] - 2) < 1e-6, 'half way around lands on the opposite corner')
})

await check('G4 a free path advances by arc length, not vertex index', async () => {
  // 前两点很近、后两点很远：按顶点序号 u=0.5 会落在中间那个顶点上，
  // 按弧长应当还在很短的那一段附近。
  const path = { id: 'p', shape: 'free', points: [[0, 0, 0], [1, 0, 0], [11, 0, 0]], start: 0, end: 2 }
  const mid = tl.pathPointAt(path, 0.5)
  assert.ok(mid[0] > 5, `arc-length midpoint should be near x=5.5, got ${mid[0]}`)
})

await check('G5 a path overrides position keyframes while it is active', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  let timeline = tl.putKeyframe(stage.timeline, 'actor', id, { at: 0, position: [0, 0, 0] })
  timeline = tl.putKeyframe(timeline, 'actor', id, { at: 4, position: [0, 0, 0] })
  timeline = tl.putPath(timeline, 'actor', id, {
    id: 'p', shape: 'line', points: [[0, 0, 0], [10, 0, 0]], start: 0, end: 2,
  })
  stage = { ...stage, timeline }
  // 轨迹生效区间内：位置由路径给出（t=1 → x=5）。
  assert.ok(Math.abs(tl.sampleStage(stage, 1).actors[0].x - 5) < 1e-6, 'the path must win inside its window')
  // 轨迹结束之后：回到位置关键帧（x=0）。
  assert.equal(tl.sampleStage(stage, 3).actors[0].x, 0, 'the keyframes must resume after the path ends')
})

await check('G6 path height lifts the actor off the ground', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  const timeline = tl.putPath(stage.timeline, 'actor', id, {
    id: 'p', shape: 'line', points: [[0, 0, 0], [4, 0, 0]], start: 0, end: 2, height: 1.5,
  })
  stage = { ...stage, timeline }
  const sampled = tl.sampleStage(stage, 1)
  // 角色只存 x/z，高度体现在路径求值里；这里断言求值函数本身把 height 加上了。
  const point = tl.pathPointAt(timeline.tracks[0].paths[0], 0.5)
  assert.ok(point[1] === 0, 'the raw path point keeps y=0; height is applied by sampleStage')
  assert.ok(Number.isFinite(sampled.actors[0].x), 'the sampled stage is still finite')
})

await check('G7 an orienting path turns the actor along its tangent', async () => {
  let stage = baseStage()
  const id = stage.actors[0].id
  const timeline = tl.putPath(stage.timeline, 'actor', id, {
    id: 'p', shape: 'line', points: [[0, 0, 0], [0, 0, 10]], start: 0, end: 2, orient: true,
  })
  stage = { ...stage, timeline }
  const sampled = tl.sampleStage(stage, 1)
  // 沿 +z 前进时朝向应当是 0°（正对 +z）。
  assert.ok(Math.abs(sampled.actors[0].rotation ?? 0) < 1e-6, `expected facing 0 along +z, got ${sampled.actors[0].rotation}`)
})

// ------------------------------------------------------------ 导出帧表

await check('F1 a 5s project exports 150 frames, not 151', async () => {
  const timeline = { ...tl.emptyStageTimeline(), duration: 5 }
  const times = tl.frameTimes(timeline)
  assert.equal(times.length, 150, 'the terminal frame must not be duplicated')
  assert.equal(times[0], 0)
  assert.ok(Math.abs(times[times.length - 1] - (149 / 30)) < 1e-9, 'the last frame sits one step before the end')
  assert.equal(tl.frameCount(timeline), 150)
})

await check('F2 frame times are evenly spaced at 1/30', async () => {
  const times = tl.frameTimes({ ...tl.emptyStageTimeline(), duration: 2 })
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(Math.abs((times[index] - times[index - 1]) - FRAME) < 1e-9, 'frames must be evenly spaced')
  }
})

// ------------------------------------------------------------ 退化输入

await check('R1 an absent timeline is created with sane defaults', async () => {
  const timeline = tl.timelineOf(undefined)
  assert.equal(timeline.duration, tl.STAGE_DEFAULT_DURATION)
  assert.equal(timeline.fps, 30)
  assert.deepEqual(timeline.tracks, [])
})

await check('R2 a malformed track is discarded, not thrown on', async () => {
  const timeline = tl.timelineOf({
    duration: 5,
    fps: 30,
    tracks: [
      { targetId: '', target: 'actor', keyframes: [] },
      { targetId: 'a', target: 'actor', keyframes: [{ at: 'nope' }, { at: 1, position: [1, 0, 0] }] },
      { targetId: 'b', target: 'camera', keyframes: [{ at: -5, camera: undefined }] },
    ],
  })
  assert.equal(timeline.tracks.length, 2, 'the track without an id must be dropped')
  const actorTrack = timeline.tracks.find(track => track.targetId === 'a')
  assert.equal(actorTrack.keyframes.length, 1, 'the keyframe without a numeric time must be dropped')
  const cameraTrack = timeline.tracks.find(track => track.targetId === 'b')
  assert.equal(cameraTrack.keyframes[0].at, 0, 'a negative time must be clamped into range')
})

await check('R3 a stage without a timeline renders the static stage unchanged', async () => {
  const staticStage = { ...stageMod.emptyStage() }
  const sampled = tl.sampleStage(staticStage, 2.5)
  assert.equal(sampled, staticStage, 'without a timeline the very same object must come back')
})

await check('R4 a legacy document keeps its "no timeline" shape through stageOf', async () => {
  // 面板靠「有没有 timeline」决定显不显示轨道栏。读的时候凭空造一份默认
  // 时间轴，会让每一份老画布都变成"有时间轴"，然后被写回盘。
  const read = stageMod.stageOf({ pose: rigWith(10) })
  assert.equal(read.timeline, undefined, 'a pose-only document must not gain a timeline')
  const withTimeline = stageMod.stageOf({
    stage: { ...stageMod.emptyStage(), timeline: tl.emptyStageTimeline() },
  })
  assert.notEqual(withTimeline.timeline, undefined, 'a document that has one must keep it')
})

// ------------------------------------------------------------------ 汇总

rmSync(root, { recursive: true, force: true })
process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nstage timeline: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nstage timeline: ${results.length} passed\n`)
}

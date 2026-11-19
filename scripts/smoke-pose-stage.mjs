/**
 * 导演台舞台（`pose-stage.ts`）的离线检查：读得回来、写得下去、不会塌。
 *
 * 这个模块是纯函数，所以这里测的不是界面，而是**四条会被用户直接看见的
 * 不变式**：
 *
 *  L*  老文档。只有 `pose`、没有 `stage` 的画布遍地都是（这个节点在改成
 *      导演台之前已经发布过几版）。`stageOf` 必须把它读成一个单角色舞台，
 *      而且那个角色的姿势**就是**原文档里那份——读成空骨架等于把用户摆好
 *      的人偶一键抹平。
 *  M*  镜像。`stagePatch` 把 `actors[0].rig` 抄进 `pose`。这条规则一破，
 *      旧版本插件打开这份画布就只剩一张空白图片。
 *  A*  加法。新增角色/机位不能与已有的撞 id，也不能站在同一个点上——叠在
 *      一起时用户看不出「加成功了」，只会以为按钮没反应。
 *  S*  退化输入。`scale` 为 0 会让整个世界塌成一个点；`cameraId` 指不到
 *      任何机位时退回第一台而不是 undefined（后者会让渲染整块白掉）。
 *
 * Run: node scripts/smoke-pose-stage.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

// 共用的 runner，不是本地手写的一份：手写的那些在「检查超时」这件事上会把
// 一次跑得慢但结果正确的检查记成 FAIL，于是一个正确的套件在负载高的机器上
// 时绿时红，绿也就不再说明任何事。这份 harness 把超时当挂起守卫，settle 之后
// 按真实结果记账。
const results = []
const check = createCheckHarness({ results })

const root = mkdtempSync(join(tmpdir(), 'gal-pose-stage-'))
// 这个模块本身不碰磁盘，但保持与 smoke-pose 一样的隔离：将来它若间接引入
// 一个会写数据的模块，也不会落到用户的真实画布目录里。
process.env.DSH_HOME = root

const stage = await import(new URL('../src/client/canvas/pose-stage.ts', import.meta.url).href)
const rig = await import(new URL('../src/client/canvas/pose-rig.ts', import.meta.url).href)

/** 一个不在地面上的、能看出「有没有被抹平」的姿势。 */
const CUSTOM_POSE = {
  joints: { shoulderR: { x: -45, y: 0, z: 30 }, elbowR: { x: -100, y: 0, z: -40 }, hips: { x: 20, y: 0, z: 0 } },
  facing: 45,
}

/** 一个三人并排的舞台，供取景检查用。 */
function threeActorStage(spacing) {
  const base = stage.emptyStage()
  return {
    ...base,
    actors: [0, 1, 2].map(index => ({
      id: `actor-${index + 1}`,
      name: `角色${String.fromCharCode(65 + index)}`,
      rig: rig.emptyRig(),
      x: index * spacing,
      z: 0,
    })),
  }
}

// ------------------------------------------------------------- 老文档兼容

await check('L1 a pose-only document reads back as a one-actor stage', async () => {
  const read = stage.stageOf({ pose: CUSTOM_POSE })
  assert.equal(read.actors.length, 1, 'a pose-only document must produce exactly one actor')
  assert.equal(read.cameras.length, 1, 'a pose-only document must produce exactly one camera')
  // 这一条是核心：读成空骨架等于把用户摆好的人偶抹平。
  assert.deepEqual(read.actors[0].rig, CUSTOM_POSE, 'the actor did not inherit the document pose')
  assert.equal(read.actors[0].x, 0)
  assert.equal(read.actors[0].z, 0)
})

await check('L2 an empty metadata still yields a usable stage', async () => {
  const read = stage.stageOf({})
  assert.equal(read.actors.length, 1)
  assert.equal(read.cameras.length, 1)
  for (const value of [read.scene.scale, read.scene.rotateY, read.scene.panoYaw, read.scene.panoRadius]) {
    assert.ok(Number.isFinite(value), `scene carries a non-finite number (${value})`)
  }
  assert.ok(read.scene.translate.every(item => Number.isFinite(item)), 'scene translate is not finite')
  assert.equal(read.actors[0].id, 'actor-1')
  assert.equal(stage.currentCamera(read).id, read.cameras[0].id)
})

await check('L3 a stage with missing fields is completed, not rejected', async () => {
  // 存储校验对缺项一律放行，所以「字段缺失」是常态：读的那一刻必须补齐，
  // 否则渲染与面板各自 ?? 默认值，迟早出现预览有地面、导出没有。
  const read = stage.stageOf({ stage: { actors: [{ id: 'a', name: '甲', rig: CUSTOM_POSE, x: 1, z: 2 }] } })
  assert.equal(read.actors.length, 1)
  assert.equal(read.cameras.length >= 1, true, 'a stage without cameras must get a default camera')
  assert.ok(read.scene.sky.length > 0)
  assert.equal(read.cameraId, read.cameras[0].id, 'cameraId must resolve to a real camera')
})

// ------------------------------------------------------------------- 镜像

await check('M1 stagePatch mirrors actors[0].rig into pose', async () => {
  const source = threeActorStage(1.2)
  source.actors[0] = { ...source.actors[0], rig: CUSTOM_POSE }
  const patch = stage.stagePatch(source)
  assert.equal(patch.stage, source, 'stagePatch must hand back the stage it was given')
  // 严格相等：旧版本插件只认 `pose`，镜像一旦是另一份对象、少一个关节，
  // 那份画布在旧版本里就变成另一个人偶。
  assert.equal(patch.pose, source.actors[0].rig, 'pose is not the first actor\'s rig')
  assert.deepEqual(patch.pose, CUSTOM_POSE)
})

await check('M2 stagePatch survives an empty actor list', async () => {
  // 不是合法文档，但读路径必须不抛：一份手改坏的画布打开就崩，比缺一个人偶严重。
  const patch = stage.stagePatch({ ...stage.emptyStage(), actors: [] })
  assert.deepEqual(patch.pose, rig.emptyRig(), 'an actorless stage must mirror an empty rig, not undefined')
})

// ------------------------------------------------------------------- 加法

await check('A1 addActor appends a distinct actor that does not overlap', async () => {
  const before = stage.emptyStage()
  const after = stage.addActor(before)
  assert.equal(after.actors.length, before.actors.length + 1, 'addActor did not append')
  const ids = after.actors.map(actor => actor.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate actor ids: ${ids.join(', ')}`)
  const added = after.actors[after.actors.length - 1]
  // 站位重合 → 用户看不出「加成功了」，只会以为按钮没反应。
  for (const actor of before.actors) {
    assert.ok(Math.abs(added.x - actor.x) > 0.5 || Math.abs(added.z - actor.z) > 0.5,
      `the new actor sits on top of ${actor.id} at x=${added.x}`)
  }
  assert.notEqual(after.actors, before.actors, 'addActor must not mutate the original array in place')
  assert.equal(before.actors.length, 1, 'addActor mutated the stage it was given')
})

await check('A2 addActor keeps ids unique after several additions', async () => {
  let current = stage.emptyStage()
  for (let i = 0; i < 4; i += 1) current = stage.addActor(current)
  const ids = current.actors.map(actor => actor.id)
  assert.equal(ids.length, 5)
  assert.equal(new Set(ids).size, 5, `ids collided: ${ids.join(', ')}`)
})

// ------------------------------------------------------- 坐姿支撑 / 材质

const sitPreset = rig.POSE_PRESETS.find(preset => preset.id === 'sit')
const standPreset = rig.POSE_PRESETS.find(preset => preset.id === 'stand')

await check('R1 the sit preset adds a seat box whose top meets the pelvis', async () => {
  assert.ok(sitPreset !== undefined, 'missing sit preset')
  const before = stage.emptyStage()
  const seated = stage.withPosePreset(before, 'actor-1', sitPreset)
  assert.equal(seated.actors[0].rig, sitPreset.rig, 'the actor did not receive the sit rig')
  const seat = (seated.props ?? []).find(prop => prop.id === 'seat-actor-1')
  assert.ok(seat !== undefined, 'the sit preset did not add a seat')
  assert.equal(seat.kind, 'cube')
  const top = seat.y + (seat.scaleY ?? 1) / 2
  const wanted = rig.solveRig(sitPreset.rig).hips[1] - 0.06
  assert.ok(Math.abs(top - wanted) < 0.002,
    `seat top ${top.toFixed(3)} does not meet the pelvis at ${wanted.toFixed(3)}`)
})

await check('R2 applying the sit preset twice does not duplicate the seat', async () => {
  assert.ok(sitPreset !== undefined)
  const once = stage.withPosePreset(stage.emptyStage(), 'actor-1', sitPreset)
  const twice = stage.withPosePreset(once, 'actor-1', sitPreset)
  assert.equal((twice.props ?? []).filter(prop => prop.id === 'seat-actor-1').length, 1)
})

await check('R3 leaving the sit preset removes the auto-added seat', async () => {
  assert.ok(sitPreset !== undefined && standPreset !== undefined)
  const seated = stage.withPosePreset(stage.emptyStage(), 'actor-1', sitPreset)
  const standing = stage.withPosePreset(seated, 'actor-1', standPreset)
  assert.equal((standing.props ?? []).some(prop => prop.id === 'seat-actor-1'), false)
})

await check('R4 the seat scales with the actor', async () => {
  assert.ok(sitPreset !== undefined)
  const base = stage.emptyStage()
  const scaled = {
    ...base,
    actors: base.actors.map(actor => ({ ...actor, scale: 1.5 })),
  }
  const seated = stage.withPosePreset(scaled, 'actor-1', sitPreset)
  const seat = (seated.props ?? []).find(prop => prop.id === 'seat-actor-1')
  assert.ok(seat !== undefined)
  const wanted = (rig.solveRig(sitPreset.rig).hips[1] - 0.06) * 1.5
  const top = seat.y + (seat.scaleY ?? 1) / 2
  assert.ok(Math.abs(top - wanted) < 0.002, `scaled seat top ${top.toFixed(3)} != ${wanted.toFixed(3)}`)
  assert.ok(Math.abs((seat.scaleX ?? 1) - 0.55 * 1.5) < 1e-6)
})

await check('R4b the seat follows the actor position and rotation', async () => {
  assert.ok(sitPreset !== undefined)
  const actor = {
    ...stage.emptyStage().actors[0],
    rig: sitPreset.rig,
    x: 1.2,
    z: -0.4,
    rotation: 30,
    scale: 1.2,
  }
  const seat = stage.seatPropFor(actor)
  assert.equal(seat.x, 1.2)
  assert.equal(seat.z, -0.4)
  assert.equal(seat.rotateY, 30)
  const wanted = (rig.solveRig(sitPreset.rig).hips[1] - 0.06) * 1.2
  assert.ok(Math.abs((seat.y + (seat.scaleY ?? 1) / 2) - wanted) < 0.002)
})

await check('R5 figure material defaults to clay and round-trips wood', async () => {
  // 老文档没有这个字段时读回 undefined，渲染按 clay 处理；不能为了默认值
  // 在存盘时单方面写一条 figure。
  assert.equal(stage.stageOf({}).scene.figure, 'clay')
  const legacyScene = { ...stage.emptyStage().scene }
  delete legacyScene.figure
  const legacy = { ...stage.emptyStage(), scene: legacyScene }
  assert.equal(stage.stageOf({ stage: legacy }).scene.figure, undefined)
  assert.equal(stage.emptyStage().scene.figure, 'clay')
  const wood = {
    ...stage.emptyStage(),
    scene: { ...stage.emptyStage().scene, figure: 'wood' },
  }
  assert.equal(stage.stageOf({ stage: wood }).scene.figure, 'wood')
  assert.equal(stage.stagePatch(wood).stage.scene.figure, 'wood')
})

await check('R6 figure body defaults to standard and keeps an explicit mannequin opt-out', async () => {
  assert.equal(stage.emptyStage().scene.body, 'standard')
  assert.equal(stage.bodyOf(stage.emptyStage().scene), 'standard')
  const procedural = {
    ...stage.emptyStage(),
    scene: { ...stage.emptyStage().scene, body: 'procedural' },
  }
  assert.equal(stage.bodyOf(procedural.scene), 'procedural')
  assert.equal(stage.stageOf({ stage: procedural }).scene.body, 'procedural')
  const legacyScene = { ...stage.emptyStage().scene }
  delete legacyScene.body
  assert.equal(stage.stageOf({ stage: { ...stage.emptyStage(), scene: legacyScene } }).scene.body, undefined)
  assert.equal(stage.bodyOf(legacyScene), 'standard')
})

await check('A3 addCamera appends a distinct camera', async () => {
  const before = stage.emptyStage()
  const after = stage.addCamera(before)
  assert.equal(after.cameras.length, before.cameras.length + 1)
  const ids = after.cameras.map(camera => camera.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate camera ids: ${ids.join(', ')}`)
  const added = after.cameras[after.cameras.length - 1]
  const base = before.cameras[0]
  // 新机位压在原机位上的话，用户切过去画面完全不变，会以为切换没生效。
  assert.ok(Math.abs(added.x - base.x) + Math.abs(added.y - base.y) + Math.abs(added.z - base.z) > 0.3,
    'the new camera sits exactly on the first one')
  assert.equal(before.cameras.length, 1, 'addCamera mutated the stage it was given')
})

// --------------------------------------------------------------- 退化输入

await check('S1 a broken cameraId falls back to the first camera', async () => {
  const broken = { ...stage.emptyStage(), cameraId: 'camera-does-not-exist' }
  const resolved = stage.currentCamera(broken)
  assert.ok(resolved !== undefined && resolved !== null, 'currentCamera returned nothing for a stale cameraId')
  assert.equal(resolved.id, broken.cameras[0].id)
  // 渲染侧也要能拿到一台可用的环绕相机，否则整块画面白掉。
  const render = stage.currentRenderCamera(broken)
  assert.ok(Number.isFinite(render.distance) && render.distance > 0, `bad render camera distance ${render.distance}`)
  assert.ok(Number.isFinite(render.fov) && render.fov > 0)
})

await check('S2 scaleFactor never collapses the world', async () => {
  const base = stage.emptyStage().scene
  // 0 会让整个世界塌成一个点；负值把角色翻到地面以下；NaN 让所有坐标变成 NaN。
  for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
    const factor = stage.scaleFactor({ ...base, scale: bad })
    assert.ok(Number.isFinite(factor), `scale ${bad} produced a non-finite factor`)
    assert.ok(factor > 0, `scale ${bad} produced ${factor}, which collapses the scene`)
  }
  assert.equal(stage.scaleFactor({ ...base, scale: 100 }), 1)
  assert.equal(stage.scaleFactor({ ...base, scale: 300 }), 3)
})

await check('S3 a stage rebuilt from broken numbers keeps every value finite', async () => {
  // 手改过的文件里什么都可能出现。读路径的职责是给出一份能画的舞台，
  // 而不是把 NaN 一路带到投影里（那里每个坐标都会变成 NaN，画面全空）。
  const read = stage.stageOf({
    stage: {
      actors: [{ id: 'a', name: '', rig: undefined, x: Number.NaN, z: 3 }],
      cameras: [{ id: 'c', name: '', x: Number.NaN, y: 1, z: 2, targetX: 0, targetY: Number.NaN, targetZ: 0, fov: Number.NaN }],
      cameraId: 'c',
      scene: { sky: '', translate: [Number.NaN, 0, 0], rotateY: Number.NaN, scale: 0, panoYaw: Number.NaN, panoRadius: 0, labels: 'yes' },
    },
  })
  const numbers = [
    ...read.actors.flatMap(actor => [actor.x, actor.z]),
    ...read.cameras.flatMap(camera => [camera.x, camera.y, camera.z, camera.targetX, camera.targetY, camera.targetZ, camera.fov]),
    read.scene.rotateY, read.scene.scale, read.scene.panoYaw, read.scene.panoRadius, ...read.scene.translate,
  ]
  for (const value of numbers) assert.ok(Number.isFinite(value), `a broken field survived as ${value}`)
  assert.ok(read.scene.sky.length > 0, 'an empty sky colour was not replaced by the default')
})

// ------------------------------------------------------------------- 取景

await check('S4 framing pulls back for three actors standing side by side', async () => {
  // 单人机位框不下三个人：两侧会被裁掉，而「导出快照」正是这个功能的出口。
  const solo = stage.frameCameraSpec(stage.emptyStage(), stage.DEFAULT_CAMERA_SPEC)
  const trio = stage.frameCameraSpec(threeActorStage(1.2), stage.DEFAULT_CAMERA_SPEC)
  const distanceOf = camera => Math.hypot(camera.x - camera.targetX, camera.y - camera.targetY, camera.z - camera.targetZ)
  const soloDistance = distanceOf(solo)
  const trioDistance = distanceOf(trio)
  assert.ok(trioDistance > soloDistance,
    `three-actor framing (${trioDistance.toFixed(2)}) is not farther than the solo one (${soloDistance.toFixed(2)})`)
  // 三个人站得更开，相机还得再退——否则这条只证明了「固定加大一号距离」。
  const wider = stage.frameCameraSpec(threeActorStage(3), stage.DEFAULT_CAMERA_SPEC)
  assert.ok(distanceOf(wider) > trioDistance,
    `widening the group did not pull the camera back (${distanceOf(wider).toFixed(2)} vs ${trioDistance.toFixed(2)})`)
  // 取景要对着人群中心，不是原点：三个人整体右移之后还盯着原点的话，
  // 画面里只剩最左边那一个。
  assert.ok(trio.targetX > solo.targetX + 0.5, 'the framed camera still looks at the origin instead of the group')
})

await check('S5 framing points the camera at the group centre', async () => {
  const trio = threeActorStage(1.2)
  const spec = stage.frameCameraSpec(trio, stage.DEFAULT_CAMERA_SPEC)
  const bounds = stage.stageBounds(trio)
  assert.ok(Math.abs(spec.targetX - bounds.center[0]) < 1e-6, 'targetX is not the bounds centre')
  assert.ok(Math.abs(spec.targetZ - bounds.center[2]) < 1e-6, 'targetZ is not the bounds centre')
  assert.ok(spec.y > bounds.center[1], 'the camera ended up below the group it is framing')
})

await check('S6 the scene prompt survives a round trip', async () => {
  // 面板底部那行字是用户敲的。丢在一个不起作用的字段里比明说不支持更糟——
  // 他关掉面板再打开，字没了。
  const withPrompt = { ...stage.emptyStage(), prompt: '两个人在雨夜的街角对峙' }
  const read = stage.stageOf({ stage: withPrompt })
  assert.equal(read.prompt, '两个人在雨夜的街角对峙', 'the prompt did not come back out of stageOf')

  // 缺项合法：一份没有提示词的舞台读出来仍然是 undefined，不是空串占位。
  const bare = stage.stageOf({ stage: stage.emptyStage() })
  assert.equal(bare.prompt, undefined, 'a stage without a prompt must not gain one')

  // 类型错的值必须在存储层被拒：读写两侧对同一个字段只有一种理解。
  //
  // `CanvasStore` 用构造函数参数属性写的，Node 默认的 strip-only 模式跑不了；
  // 照 `smoke-pose.mjs` 的办法带 `--experimental-transform-types` 重跑一次本
  // 脚本。跳过它会让这条检查静默消失，那比失败更糟。
  let storeModule
  try {
    storeModule = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
  } catch (error) {
    if (!/parameter property is not supported/.test(String(error?.message))) throw error
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url)], { stdio: 'inherit' })
    process.exit(result.status ?? 0)
  }
  const store = new storeModule.CanvasStore(join(root, 'canvas-prompt'))
  const created = await store.create('导演台画布')
  await store.save({
    version: 2, id: created.id, title: '导演台画布', revision: 1,
    viewport: { x: 0, y: 0, k: 1 }, background: 'dots', connections: [], groups: [],
    nodes: [{
      id: 'stage-1', type: 'image', title: '导演台', x: 0, y: 0, width: 320, height: 360,
      metadata: { status: 'idle', pose: { joints: {}, facing: 0 }, stage: { ...withPrompt } },
    }],
  })
  const loaded = await store.read(created.id)
  assert.equal(loaded.nodes[0].metadata.stage.prompt, '两个人在雨夜的街角对峙', 'the prompt did not survive save+read')

  // 坏类型必须被拒，而不是被静默写成数字。
  await assert.rejects(
    () => store.save({
      version: 2, id: created.id, title: '导演台画布', revision: 1,
      viewport: { x: 0, y: 0, k: 1 }, background: 'dots', connections: [], groups: [],
      nodes: [{
        id: 'stage-1', type: 'image', title: '导演台', x: 0, y: 0, width: 320, height: 360,
        metadata: { status: 'idle', stage: { ...withPrompt, prompt: 42 } },
      }],
    }),
    /malformed canvas document/,
  )
})

await check('S7 actor position is editable in metres, not baked into the count', async () => {
  // 站位必须是一个可以改的数：早先右栏只暴露名字，于是「把人挪开一点」只能
  // 靠再加一个角色——角色的数量被当成了位置。
  let scene = stage.emptyStage()
  scene = stage.addActor(scene)
  scene.actors[0] = { ...scene.actors[0], x: -1.4, z: 0.8 }
  const bounds = stage.stageBounds(scene)
  // 首个角色在 -x 侧，包围盒中心就必须被拉向 -x——否则说明 x 根本没参与变换。
  assert.ok(bounds.center[0] < 0, `bounds centre x=${bounds.center[0].toFixed(2)} ignored the actor offset`)
})

await check('S8 framing moves the look-at point, not just the distance', async () => {
  // 三个人并排在 x=-1.2/0/1.2 时，只把相机拉远是**不够**的：注视点如果仍钉在
  // 原点，第三人就被裁在画外。这个错在真机走查里出现过——画面上只有两个人，
  // 而第三人其实站在画外，用户会以为「加角色」没生效。
  const trio = threeActorStage(1.2)
  const spec = stage.frameCameraSpec(trio, stage.DEFAULT_CAMERA_SPEC)
  // 夹具从 x=0 起排三个人，间距 1.2 → 人群中心在 1.2，不是 0。
  const trioCenter = stage.stageBounds(trio).center[0]
  assert.ok(Math.abs(spec.targetX - trioCenter) < 1e-6, `framed targetX=${spec.targetX} but the group centre is ${trioCenter}`)

  // 关键：换算成渲染相机之后，水平注视点必须还在。丢掉它就是那条 bug 的全部。
  const render = stage.cameraFromSpec(spec)
  assert.equal(typeof render.targetX, 'number', 'cameraFromSpec dropped the horizontal look-at point')
  assert.ok(Math.abs(render.targetX - trioCenter) < 1e-6, `render targetX=${render.targetX}, group centre ${trioCenter}`)

  // 对称摆放（-1.2/0/1.2）时中心必须落在原点——证明它跟的是人群而不是第一台机位。
  // `cameraFromSpec` 按「缺省不写盘」的约定在水平注视点为 0 时省略字段，
  // 所以要按 `?? 0` 读，不能断言字段一定存在。
  const symmetric = threeActorStage(1.2)
  symmetric.actors.forEach((actor, index) => { symmetric.actors[index] = { ...actor, x: (index - 1) * 1.2 } })
  const centered = stage.cameraFromSpec(stage.frameCameraSpec(symmetric, stage.DEFAULT_CAMERA_SPEC))
  assert.ok(Math.abs(centered.targetX ?? 0) < 0.2, `symmetric group framed at targetX=${centered.targetX}`)

  // 不对称的舞台才能证明它是真的在跟人群走，而不是恰好等于 0。
  const lopsided = threeActorStage(1.2)
  lopsided.actors[0] = { ...lopsided.actors[0], x: -3 }
  lopsided.actors[1] = { ...lopsided.actors[1], x: -1.8 }
  lopsided.actors[2] = { ...lopsided.actors[2], x: -0.6 }
  const shifted = stage.cameraFromSpec(stage.frameCameraSpec(lopsided, stage.DEFAULT_CAMERA_SPEC))
  assert.ok((shifted.targetX ?? 0) < -0.8, `render targetX=${shifted.targetX} ignored an off-centre group`)
})

await check('S9 every actor lands inside the framed view', async () => {
  // 真正要守住的是这条：取景之后，每个角色的每个关节都必须投影到画面内。
  // 单看 targetX 只能证明相机动了，证明不了「三个人都看得见」。
  const size = 900
  for (const spacing of [1.2, 2.0]) {
    const trio = threeActorStage(spacing)
    const spec = stage.frameCameraSpec(trio, stage.DEFAULT_CAMERA_SPEC)
    const camera = stage.cameraFromSpec(spec)
    for (const actor of trio.actors) {
      const transform = stage.actorTransform(trio, actor)
      const world = rig.solveRig(actor.rig)
      for (const joint of Object.keys(world)) {
        const point = world[joint]
        const placed = [
          (point[0] * Math.cos(transform.rotation * Math.PI / 180) + point[2] * Math.sin(transform.rotation * Math.PI / 180)) * transform.scale + transform.offset[0],
          point[1] * transform.scale + transform.offset[1],
          (-point[0] * Math.sin(transform.rotation * Math.PI / 180) + point[2] * Math.cos(transform.rotation * Math.PI / 180)) * transform.scale + transform.offset[2],
        ]
        const screen = rig.projectPoint(placed, camera, size)
        assert.notEqual(screen, null, `spacing ${spacing}: ${actor.name}.${joint} is behind the camera`)
        assert.ok(
          screen[0] > -1 && screen[0] < size + 1 && screen[1] > -1 && screen[1] < size + 1,
          `spacing ${spacing}: ${actor.name}.${joint} projects to (${screen.map(v => v.toFixed(0)).join(',')}), outside the frame`,
        )
      }
    }
  }
})

// ------------------------------------------------- 卡片预设条（真机缺陷回填）
//
// 2026-11-15 真机走查发现：卡片上的预设条直接把新姿势写进 `metadata.pose`，
// 而读取以 `stage` 为准（`stageOf`）。于是点「坐姿」什么都没发生——文件里
// 多了一份没人读的 `pose`，画面一动不动。断言模拟「按卡片那条路写一次」，
// 再按读取路径读回来：只写 `pose` 必须读不到，写 `stage` 必须读到。

await check('P1 writing only `pose` after a stage exists changes nothing on read', async () => {
  const base = stage.emptyStage()
  const seated = { joints: { shoulderR: { x: 0, y: 0, z: 20 } }, facing: 0 }
  // 这正是旧代码做的事：patchNode(id, { pose: next })。
  const metadata = { ...stage.stagePatch(base), pose: seated }
  const read = stage.stageOf(metadata)
  assert.notDeepEqual(
    read.actors[0].rig.joints, seated.joints,
    'a `pose`-only write must NOT be readable while `stage` exists — otherwise the preset bar would look like it works',
  )
  assert.deepEqual(
    read.actors[0].rig.joints, base.actors[0].rig.joints,
    'the stage rig stays the source of truth',
  )
})

await check('P2 writing the same pose through `stage` IS readable, and mirrors into `pose`', async () => {
  const base = stage.emptyStage()
  const seated = { joints: { shoulderR: { x: 0, y: 0, z: 20 } }, facing: 0 }
  const [first, ...rest] = base.actors
  const written = stage.stagePatch({ ...base, actors: [{ ...first, rig: seated }, ...rest] })
  const read = stage.stageOf(written)
  assert.deepEqual(read.actors[0].rig.joints, seated.joints, 'the preset must survive the round trip')
  assert.deepEqual(written.pose.joints, seated.joints, '`pose` mirrors actors[0].rig so old plugins still read a figure')
  assert.equal(read.actors.length, 1, 'editing one rig must not drop the other actors')
})

await check('P3 editing the first rig leaves the other actors untouched', async () => {
  const base = threeActorStage(1.2)
  const seated = { joints: { shoulderR: { x: 0, y: 0, z: 20 } }, facing: 0 }
  const [first, ...rest] = base.actors
  const read = stage.stageOf(stage.stagePatch({ ...base, actors: [{ ...first, rig: seated }, ...rest] }))
  assert.equal(read.actors.length, 3, 'all three actors survive')
  assert.deepEqual(read.actors[0].rig.joints, seated.joints)
  assert.deepEqual(read.actors[1].rig.joints, base.actors[1].rig.joints)
  assert.deepEqual(read.actors[2].rig.joints, base.actors[2].rig.joints)
})

// ------------------------------------------------------------------ 汇总

rmSync(root, { recursive: true, force: true })
process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\npose stage: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\npose stage: ${results.length} passed\n`)
}

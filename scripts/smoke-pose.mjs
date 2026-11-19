/**
 * 姿势节点：离线检查「存得住」与「算得对」。
 *
 * 这个节点不新增类型（它是 `type: 'image'` + `metadata.pose`），所以真正的
 * 风险不在渲染而在两处边界：
 *
 *  H*  存储。校验器在这里过严的代价不是「拒收这次请求」，而是**这份文档再也
 *      存不下去**——`coerceDocument` 变 undefined、`save()` 直接抛，用户手里
 *      的画布就此变成一个存一次报一次错的画布。所以既要证明合法姿势能往返，
 *      也要证明畸形姿势是被**拒收**而不是被静默写进去。
 *  P*  几何。人偶是算出来的，不是画出来的：脚踩空、左右手互换、坐姿的大腿朝
 *      后，这些错误在截图里不一定看得出来，但在坐标里是硬事实。这里把它们钉成
 *      不变量——每个预设都必须落地、左右对称必须成立、关节链必须单调。
 *
 * Run: node scripts/smoke-pose.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const results = []
const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

const root = mkdtempSync(join(tmpdir(), 'gal-pose-'))
process.env.DSH_HOME = root

/**
 * 从 SOURCE 加载 store 而不是包入口：`CanvasStore` 没有由 `lib/index.js`
 * 导出，而它是 TypeScript 写的、用了构造函数参数属性——Node 默认的
 * strip-only 模式拒绝这种写法，所以带 `--experimental-transform-types` 重跑
 * 一次本脚本。这样测的是真的那份 store，而不是照抄的一份规则。
 */
async function loadStoreClass() {
  try {
    const module = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
    return module.CanvasStore
  } catch (error) {
    if (!/parameter property is not supported/.test(String(error?.message))) throw error
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url)], { stdio: 'inherit' })
    process.exit(result.status ?? 0)
  }
}
const CanvasStore = await loadStoreClass()

const poseNode = (id, pose, extra = {}) => ({
  id, type: 'image', title: '姿势',
  x: 0, y: 0, width: 320, height: 470,
  metadata: { status: 'idle', pose, ...extra },
})

const doc = (id, nodes) => ({
  version: 2, id, title: '姿势画布', revision: 1,
  viewport: { x: 0, y: 0, k: 1 }, background: 'dots',
  nodes, connections: [], groups: [],
})

// ------------------------------------------------------------ host storage

await check('H1 a pose document saves and reads back intact', async () => {
  const store = new CanvasStore(join(root, 'canvas-h1'))
  const created = await store.create('姿势画布')
  const pose = { joints: { shoulderR: { x: -45, y: 0, z: 30 }, elbowR: { x: -100, y: 0, z: -40 } }, facing: 45 }
  await store.save(doc(created.id, [poseNode('pose-1', pose)]))
  const loaded = await store.read(created.id)
  assert.notEqual(loaded, undefined)
  const stored = loaded.nodes.find(node => node.id === 'pose-1')
  assert.notEqual(stored, undefined, 'the pose node disappeared on reload')
  assert.deepEqual(stored.metadata.pose, pose, 'the angles did not round-trip exactly')
})

await check('H2 a pose with missing joints is accepted (older documents)', async () => {
  const store = new CanvasStore(join(root, 'canvas-h2'))
  const created = await store.create('姿势画布')
  // 只有 facing、没有 joints：缺项是合法的（按 0 度渲染），拒掉它等于让一份老
  // 文档再也存不下去。
  await store.save(doc(created.id, [poseNode('pose-1', { facing: 90 })]))
  const loaded = await store.read(created.id)
  assert.equal(loaded.nodes[0].metadata.pose.facing, 90)
})

await check('H3 a malformed pose is refused instead of written', async () => {
  const store = new CanvasStore(join(root, 'canvas-h3'))
  const created = await store.create('姿势画布')
  // 未知关节名：多半是手改过的文件或另一个版本写的；写进去只会让渲染读到一份
  // 它不认识的数据。
  await assert.rejects(
    () => store.save(doc(created.id, [poseNode('pose-1', { joints: { tentacle: { x: 0, y: 0, z: 0 } }, facing: 0 })])),
    /malformed canvas document/,
  )
  // 角度不是有限数：NaN 一旦进文档，整副骨架的坐标都会变成 NaN，画面上什么
  // 都不剩，而且这种文档同样再也存不回去。
  await assert.rejects(
    () => store.save(doc(created.id, [poseNode('pose-1', { joints: { head: { x: Number.NaN, y: 0, z: 0 } }, facing: 0 })])),
    /malformed canvas document/,
  )
})

await check('H4 a node without a pose stays a plain image node', async () => {
  const store = new CanvasStore(join(root, 'canvas-h4'))
  const created = await store.create('姿势画布')
  // 删掉 `pose` 是合法的降级路径：节点退回一张普通图片，而不是一份读不懂的文档。
  await store.save(doc(created.id, [{
    id: 'img-1', type: 'image', title: '图片', x: 0, y: 0, width: 240, height: 240,
    metadata: { status: 'idle', asset: { assetId: 'a.png', url: '/a.png', mime: 'image/png', bytes: 1, width: 8, height: 8, origin: 'upload' } },
  }]))
  const loaded = await store.read(created.id)
  assert.equal(loaded.nodes[0].metadata.pose, undefined)
})

// ------------------------------------------------------------- geometry

const rig = await import(new URL('../src/client/canvas/pose-rig.ts', import.meta.url).href)

/**
 * 每副骨架的**形体**最低点，不是关节点的最低点。
 *
 * 只取关节 y 会把地面对齐到「脚踝球心」，半个脚就埋在地面以下——导出图上
 * 脚完全消失，只剩两根杆子戳进地里。所以要按每个关节自己的半径外扩一格再
 * 取最小值：形体的最低表面贴地才是对的。
 */
const lowest = world => {
  let low = Infinity
  for (const [joint, p] of Object.entries(world)) {
    // 脚掌不是球：它的最低点由脚底剖面决定，见下面的 footSolePoints。
    if (joint === 'footL' || joint === 'footR') continue
    low = Math.min(low, p[1] - (rig.JOINT_RADIUS[joint] ?? 0))
  }
  for (const side of ['L', 'R']) {
    for (const point of rig.footSolePoints(world[`foot${side}`], world[`knee${side}`])) {
      low = Math.min(low, point[1])
    }
  }
  return low
}

await check('P1 every preset stands on the ground', async () => {
  for (const preset of rig.POSE_PRESETS) {
    const world = rig.solveRig(preset.rig)
    const floor = lowest(world)
    // 2 cm 是地面常量本身；给 1 cm 的浮点余量。往上飘或沉进地面都是错的。
    assert.ok(Math.abs(floor - 0.02) < 0.011, `${preset.id}: lowest joint at y=${floor.toFixed(3)}, expected 0.02`)
  }
})

await check('P1b every foot sole touches the floor instead of the floor cutting through it', async () => {
  for (const preset of rig.POSE_PRESETS) {
    const world = rig.solveRig(preset.rig)
    const soles = ['L', 'R'].flatMap(side => rig.footSolePoints(
      world[`foot${side}`],
      world[`knee${side}`],
    ))
    const lowestSole = Math.min(...soles.map(point => point[1]))
    const lowestSurface = lowest(world)
    assert.ok(Math.abs(lowestSole - rig.POSE_GROUND_Y) < 0.002,
      `${preset.id}: lowest sole at y=${lowestSole.toFixed(3)}, expected ${rig.POSE_GROUND_Y}`)
    assert.ok(lowestSurface >= rig.POSE_GROUND_Y - 0.002,
      `${preset.id}: a surface point sank below the floor (${lowestSurface.toFixed(3)})`)
    // 至少有一只脚在地面上；跑步可以有腾空脚，但不能整个人悬空。
    assert.ok(lowestSurface < rig.POSE_GROUND_Y + 0.01,
      `${preset.id}: the figure floats above the floor`)
  }
})

await check('P2 every preset is a connected skeleton, head above hips', async () => {
  for (const preset of rig.POSE_PRESETS) {
    const world = rig.solveRig(preset.rig)
    for (const joint of Object.keys(rig.JOINT_PARENT)) {
      const p = world[joint]
      assert.ok(p !== undefined, `${preset.id}: ${joint} was not solved`)
      assert.ok(p.every(v => Number.isFinite(v)), `${preset.id}: ${joint} is not finite (${p.join(',')})`)
    }
    assert.ok(world.head[1] > world.hips[1], `${preset.id}: head is not above the hips`)
  }
})

await check('P3 a preset that does not turn around keeps left on the left', async () => {
  // 只有**朝前**的预设在世界坐标里才保证左手在 -x 侧。背身（facing 180）和侧身
  // （facing 45）整体转过之后，左右在世界上当然会换边——那是转身，不是骨骼错。
  // 曾经把这条写成对所有预设成立，结果它测到的是「预设不许转身」，与要防的错
  // （某一根轴的符号写反）不相干。
  for (const preset of rig.POSE_PRESETS) {
    if (preset.rig.facing !== 0) continue
    const world = rig.solveRig(preset.rig)
    assert.ok(world.handL[0] < world.handR[0], `${preset.id}: the left hand is on the +x side`)
    assert.ok(world.footL[0] < world.footR[0], `${preset.id}: the left foot is on the +x side`)
  }
})

await check('P3b turning the whole figure mirrors the sides', async () => {
  // 转身必须真的换边，否则 `facing` 就是个没接上的旋钮。
  const front = rig.solveRig({ joints: {}, facing: 0 })
  const back = rig.solveRig({ joints: {}, facing: 180 })
  assert.ok(front.handL[0] < 0 && front.handR[0] > 0, 'the front rig is not facing the camera')
  assert.ok(back.handL[0] > 0 && back.handR[0] < 0, 'facing 180 did not turn the figure around')
})

await check('P4 an emptied rig is a standing figure, not a collapsed one', async () => {
  const world = rig.solveRig(rig.emptyRig())
  // 空姿势是用户点「重置」后的状态，也是新建节点前的默认值。它必须是一副能看
  // 的骨架：约 1.5 m 高、双脚落地。
  // 身高要量到**头顶**，不是头心：`lowest` 已经包含各关节半径，头心再减
  // 地面得到的是「头心到地」，会比真实身高少一个头半径（0.1 m）。
  const height = world.head[1] + rig.JOINT_RADIUS.head - lowest(world)
  assert.ok(height > 1.4 && height < 1.7, `empty rig is ${height.toFixed(2)} m tall`)
  assert.ok(Math.abs(world.handL[0] - world.handR[0]) > 0.3, 'the arms are not apart in the empty rig')
})

await check('P5 an angle on the root actually tilts the torso', async () => {
  // 曾经 `joints.hips` 被根节点丢掉，于是蹲姿与跑步的「躯干前倾」完全不生效。
  // 绕 X 的正角把头甩向 +z（朝相机 = 前倾），负角向后；两个方向都必须动，
  // 只断言一侧的话，符号写反也照样绿。
  const upright = rig.solveRig({ joints: {}, facing: 0 })
  const forward = rig.solveRig({ joints: { hips: { x: 30, y: 0, z: 0 } }, facing: 0 })
  const backward = rig.solveRig({ joints: { hips: { x: -30, y: 0, z: 0 } }, facing: 0 })
  assert.ok(forward.head[2] > upright.head[2] + 0.1, 'a positive hips X did not lean the torso forward')
  assert.ok(backward.head[2] < upright.head[2] - 0.1, 'a negative hips X did not lean the torso back')
})

await check('P6 framing fits every preset inside the frame', async () => {
  for (const preset of rig.POSE_PRESETS) {
    const camera = rig.frameCamera(preset.rig, rig.DEFAULT_CAMERA)
    assert.ok(Number.isFinite(camera.distance) && camera.distance > 0.5, `${preset.id}: bad camera distance ${camera.distance}`)
    // 每个已求解的关节都必须投影到画面里（0..size），否则导出的参考图会裁掉肢体。
    const size = 512
    for (const point of Object.values(rig.solveRig(preset.rig))) {
      const screen = rig.projectPoint(point, camera, size)
      assert.ok(screen !== null, `${preset.id}: a joint is behind the camera`)
      assert.ok(screen[0] > -1 && screen[0] < size + 1 && screen[1] > -1 && screen[1] < size + 1,
        `${preset.id}: a joint projects to (${screen.map(v => v.toFixed(0)).join(',')}), outside the frame`)
    }
  }
})

await check('P7 framing tracks the subject instead of using one distance', async () => {
  // 蹲姿比站姿矮一大截，两者如果用同一个距离，蹲姿就会缩成画面中央一小团。
  const stand = rig.frameCamera(rig.POSE_PRESETS.find(p => p.id === 'stand').rig, rig.DEFAULT_CAMERA)
  const crouch = rig.frameCamera(rig.POSE_PRESETS.find(p => p.id === 'crouch').rig, rig.DEFAULT_CAMERA)
  assert.ok(crouch.distance < stand.distance - 0.3, `crouch ${crouch.distance.toFixed(2)} vs stand ${stand.distance.toFixed(2)}: framing did not adapt`)
})

// ------------------------------------------------------------------ runner

for (const { name, fn } of checks) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

rmSync(root, { recursive: true, force: true })
const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} pose checks passed`)
process.exit(failed === 0 ? 0 : 1)

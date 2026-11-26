/**
 * 人形几何的离线验收：剖面形状、关节球覆盖、放样朝向。
 *
 * WHY 单独一套：形体的毛病几乎都是「看不出来怎么错的」——头画成扁碟、胸廓
 * 前后只有宽度的一半、骨盆底面是个平切圆盘、关节球比相邻管口还小所以弯到
 * 极限就露缝。这些在整张场景截图里都不显眼，靠肉眼看图一次只能捞回一两条，
 * 而它们全部能直接从剖面数据上判死。
 *
 * 不碰 WebGL：`loft()` 只建 `BufferGeometry`，在 Node 里就能跑。
 *
 * Run: node scripts/smoke-stage-humanoid.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []
const check = createCheckHarness({ results })

const humanoid = await import(join(ROOT, 'src/client/canvas/stage-humanoid.ts'))
const {
  createHumanoidGeometry, loft, HUMANOID_HINGES, HUMANOID_JOINT_CAPS,
  HUMANOID_SLEEVES, HUMANOID_SPANS,
} = humanoid
const rig = await import(join(ROOT, 'src/client/canvas/pose-rig.ts'))
const { JOINT_REST, solveRig } = rig

/**
 * 世界尺寸换算。
 *
 * **剖面的 `t` 不是长度**：它是一整段骨长的比例系数，每段骨的 1.0 等于
 * `JOINT_REST` 里那个偏移的模长（头 0.100、颈 0.160、大腿 0.376…）。
 * 直接拿 `t` 当高度去和世界宽度比，等于量一个数字与一个米数谁大——
 * 上一版这个套子就是这么写的，所以把头画成扁碟也照样绿。
 */
const boneLength = {
  pelvis: Math.hypot(...JOINT_REST.spine),
  chest: Math.hypot(...JOINT_REST.chest),
  neck: Math.hypot(...JOINT_REST.neck),
  head: Math.hypot(...JOINT_REST.head),
}
const restWorld = solveRig({ joints: {}, facing: 0 })

/**
 * 从几何里读回每一环的横截面半径。
 *
 * 不能直接问几何要「剖面」：`loft` 出去的是三角形。这里按环序号取顶点——
 * 每环 `radial` 个顶点按角度排，第 0 个在 +X、第 `radial/4` 个在 +Z。
 */
function profiles (geometry) {
  const positions = geometry.getAttribute('position')
  const count = positions.count
  // 末两个是封口圆心，其余按环排。radial 由索引里环的数量反推不了，改用
  // 顶点里 y 的取值去分组——同一环的顶点 y 相等。
  const rings = new Map()
  for (let index = 0; index < count; index += 1) {
    const y = positions.getY(index)
    const key = y.toFixed(6)
    if (!rings.has(key)) rings.set(key, [])
    rings.get(key).push({ x: positions.getX(index), z: positions.getZ(index) })
  }
  const out = []
  for (const [key, points] of rings) {
    if (points.length < 8) continue // 封口圆心
    let rx = 0
    let rz = 0
    for (const point of points) {
      rx = Math.max(rx, Math.abs(point.x))
      rz = Math.max(rz, Math.abs(point.z))
    }
    out.push({ t: Number(key), rx, rz, n: points.length })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

const geometry = createHumanoidGeometry()

// ---------------------------------------------------------------- H1 头

await check('H1 the head is taller than it is wide, not a flat disc', () => {
  const rings = profiles(geometry.head)
  const height = (rings.at(-1).t - rings[0].t) * boneLength.head
  const width = Math.max(...rings.map(ring => ring.rx)) * 2
  // 上一版只画 t=0..1（= 骨长 0.100），于是头高 0.10、头宽 0.19——放大图里
  // 是一块横躺的扁碟。人头的宽高比在 0.7..0.9 之间，这里按「高度至少是宽度
  // 的 1.05 倍」守门，留出后续调形的余量。
  assert.ok(height > width * 1.05,
    `head height ${height.toFixed(3)} must exceed its width ${width.toFixed(3)}`)
})

await check('H11 the figure is 6.5 to 8 heads tall', () => {
  const rings = profiles(geometry.head)
  const headHeight = (rings.at(-1).t - rings[0].t) * boneLength.head
  const headTop = restWorld.neck[1] + rings.at(-1).t * boneLength.head
  // 地面在 y=0（脚掌落在舞台地面上），所以身高就是头顶的世界 y。
  const ratio = headTop / headHeight
  // 上一版头是 0.305 高、整体 1.68 → 5.5 头，侧面看是一颗向后歪的大鸡蛋。
  // 人的头身比 7..7.5，木偶人偶允许到 8，放宽下限到 6.5 但不再允许 5 字头。
  assert.ok(ratio >= 6.5 && ratio <= 8.2,
    `the figure is ${ratio.toFixed(1)} heads tall (head ${headHeight.toFixed(3)}, total ${headTop.toFixed(3)})`)
})

await check('H2 the head connects down to the neck (no floating gap)', () => {
  const rings = profiles(geometry.head)
  // 两段不在同一根骨上，必须各自换回世界高度再比。
  const headBottom = restWorld.neck[1] + rings[0].t * boneLength.head
  const neckRings = profiles(geometry.neck)
  const neckTop = restWorld.chest[1] + neckRings.at(-1).t * boneLength.neck
  assert.ok(headBottom < neckTop,
    `head starts at y=${headBottom.toFixed(3)}, above the neck top y=${neckTop.toFixed(3)}`)
})

// ---------------------------------------------------------------- H3 胸廓

await check('H3 every chest ring is wider than it is deep', () => {
  const rings = profiles(geometry.chest)
  for (const ring of rings) {
    assert.ok(ring.rx > ring.rz,
      `chest ring t=${ring.t.toFixed(2)}: rx ${ring.rx.toFixed(3)} must exceed rz ${ring.rz.toFixed(3)}`)
  }
})

await check('H4 the chest is at least 1.6x wider than deep at its widest', () => {
  const rings = profiles(geometry.chest)
  const widest = rings.reduce((best, ring) => (ring.rx > best.rx ? ring : best), rings[0])
  // 人在胸线处的宽/厚比约 1.7。原来前后厚度只给了 0.084（比 0.166 的一半还薄），
  // 侧面看是一块竖直的板——这一条就是那条的守门。
  assert.ok(widest.rx / widest.rz >= 1.6,
    `chest aspect ${(widest.rx / widest.rz).toFixed(2)} at t=${widest.t.toFixed(2)} must be at least 1.6`)
})

await check('H5 the chest reaches the shoulder joints', () => {
  const rings = profiles(geometry.chest)
  const widest = Math.max(...rings.map(ring => ring.rx))
  // 肩关节在 x=±0.170，手臂挂在上面。胸廓最宽处低于 0.150 时两边会各空出
  // 一道缝，远看就是两条手臂浮在身体旁边。
  assert.ok(widest >= 0.150,
    `the chest is ${widest.toFixed(3)} wide, too narrow for shoulders at 0.170`)
})

// ---------------------------------------------------------------- H6 骨盆

await check('H6 the pelvis tapers to a point instead of a flat cut', () => {
  const rings = profiles(geometry.pelvis)
  const bottom = rings[0]
  // 平切圆盘在腿转开时会露出来（走路姿势下就是胯下那块硬边）。
  assert.ok(bottom.rx <= 0.02 && bottom.rz <= 0.02,
    `the lowest pelvis ring is ${bottom.rx.toFixed(3)}x${bottom.rz.toFixed(3)}, not a point`)
})

await check('H7 the pelvis and chest are equally wide at the waist', () => {
  const pelvisTop = profiles(geometry.pelvis).at(-1)
  const chestBottom = profiles(geometry.chest)[0]
  // 两段在腰上不同宽就会露出一道台阶——正面看像单独套了一条尿布。
  assert.ok(Math.abs(pelvisTop.rx - chestBottom.rx) <= 0.006,
    `waist step: pelvis ${pelvisTop.rx.toFixed(3)} vs chest ${chestBottom.rx.toFixed(3)}`)
})

// ---------------------------------------------------------------- H8 关节球

await check('H8 every joint cap covers the pipe mouths it joins', () => {
  // 比的是**关节那一端**的半径，不是整段最粗处：大臂根部 0.054、到肘收到
  // 0.042，肘球只要盖住 0.042 那一端就够了。早先拿整段最粗值去比，肘球
  // 永远「太细」——那不是缺陷，是断言写错了。
  const byGeometry = {
    shoulder: [{ part: 'upperArm', end: 'start' }],
    elbow: [{ part: 'upperArm', end: 'end' }, { part: 'forearm', end: 'start' }],
    hand: [{ part: 'forearm', end: 'end' }],
    hip: [{ part: 'thigh', end: 'start' }],
    knee: [{ part: 'thigh', end: 'end' }, { part: 'shin', end: 'start' }],
    foot: [{ part: 'shin', end: 'end' }],
  }
  for (const cap of HUMANOID_JOINT_CAPS) {
    const kind = cap.joint.replace(/[LR]$/, '')
    const joints = byGeometry[kind]
    assert.ok(joints !== undefined, `${cap.joint}: no part mapping for kind ${kind}`)
    for (const joint of joints) {
      const rings = profiles(geometry[joint.part])
      const mouth = joint.end === 'start' ? rings[0].rx : rings.at(-1).rx
      assert.ok(cap.radius >= mouth * 0.98,
        `${cap.joint} cap ${cap.radius.toFixed(3)} is thinner than the ${joint.part} ${joint.end} mouth (${mouth.toFixed(3)})`)
    }
  }
})

// ---------------------------------------------------------------- H9 放样

await check('H9 the loft closes both ends and faces outward', () => {
  const probe = loft([
    { t: 0, rx: 0.10, rz: 0.05 },
    { t: 1, rx: 0.04, rz: 0.03 },
  ], 12)
  const positions = probe.getAttribute('position')
  const normals = probe.getAttribute('normal')
  const index = probe.getIndex()
  assert.ok(index !== null, 'the loft must be indexed')
  // 12 个环点 x 2 环 + 2 个封口圆心。
  assert.equal(positions.count, 12 * 2 + 2, 'the loft must cap both ends with a single fan centre')

  // 取环上 angle=0 那个顶点（+X 侧），法线必须有正的 X 分量：反了的话
  // 背面剔除会把整个人形剔掉，画面上什么都不剩。
  let found = false
  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    if (Math.abs(positions.getZ(vertex)) > 1e-6) continue
    if (positions.getX(vertex) <= 0) continue
    assert.ok(normals.getX(vertex) > 0.5,
      `outward normal expected at +X, got (${normals.getX(vertex).toFixed(2)}, ${normals.getY(vertex).toFixed(2)}, ${normals.getZ(vertex).toFixed(2)})`)
    found = true
    break
  }
  assert.ok(found, 'the loft has no vertex on the +X side')
})

await check('H10 every span names a geometry the palette provides', () => {
  for (const span of HUMANOID_SPANS) {
    assert.ok(geometry[span.geometry] !== undefined, `${span.key} wants a missing geometry ${span.geometry}`)
  }
  for (const sleeve of HUMANOID_SLEEVES) {
    assert.ok(geometry[sleeve.geometry] !== undefined, `${sleeve.key} wants a missing geometry ${sleeve.geometry}`)
  }
})

await check('H12 every hinge covers the pipe mouths it joins', () => {
  // 髋用大腿根、肘用大臂端 + 小臂根、膝用大腿端 + 小腿根。铰链的半径必须
  // 盖住这些管口，否则弯到极限时从两侧能看到空心管口。
  const byKind = {
    hip: [{ part: 'thigh', end: 'start' }],
    elbow: [{ part: 'upperArm', end: 'end' }, { part: 'forearm', end: 'start' }],
    knee: [{ part: 'thigh', end: 'end' }, { part: 'shin', end: 'start' }],
  }
  for (const hinge of HUMANOID_HINGES) {
    const kind = hinge.joint.replace(/[LR]$/, '')
    const parts = byKind[kind]
    assert.ok(parts !== undefined, `${hinge.key}: no part mapping for kind ${kind}`)
    for (const part of parts) {
      const rings = profiles(geometry[part.part])
      const mouth = part.end === 'start' ? rings[0].rx : rings.at(-1).rx
      assert.ok(hinge.radius >= mouth * 0.98,
        `${hinge.key} radius ${hinge.radius.toFixed(3)} is thinner than ${part.part} ${part.end} (${mouth.toFixed(3)})`)
    }
  }
})

await check('H13 the foot mesh and the sole solver share one profile', () => {
  const rings = profiles(geometry.foot)
  assert.equal(rings.length, rig.FOOT_PROFILE.length,
    `foot has ${rings.length} rings, the sole solver has ${rig.FOOT_PROFILE.length}`)
  rings.forEach((ring, index) => {
    const source = rig.FOOT_PROFILE[index]
    assert.ok(Math.abs(ring.t - source.t) < 1e-6, `foot ring ${index}: t drifted`)
    assert.ok(Math.abs(ring.rx - source.rx) < 1e-6, `foot ring ${index}: rx drifted`)
    // 环上的顶点按 14 等分取角度，+Z 轴不一定正好落在某个顶点上，所以
    // `max |z|` 会比解析半径小约 0.2%；这不是剖面漂移，是采样误差。
    assert.ok(Math.abs(ring.rz - source.rz) < 0.003, `foot ring ${index}: rz drifted`)
  })
})

await check('H14 the sleeves taper toward the limb instead of ending in a cuff', () => {
  for (const sleeve of HUMANOID_SLEEVES) {
    const rings = profiles(geometry[sleeve.geometry])
    const end = rings.at(-1)
    const widest = Math.max(...rings.map(ring => ring.rx))
    assert.ok(widest > end.rx + 0.002,
      `${sleeve.key} does not taper toward the limb (widest ${widest.toFixed(3)} end ${end.rx.toFixed(3)})`)
    assert.ok(end.rx >= 0.04, `${sleeve.key} ends too thin to meet the limb (${end.rx})`)
  }
})

// ---------------------------------------------------------------------- 收尾

for (const part of Object.values(geometry)) part.dispose()

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nstage humanoid: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nstage humanoid: ${results.length} passed\n`)
}

/**
 * 画布几何：拖拽吸附与「节点被完全盖住」的判定。
 *
 * 这两个函数从 CanvasWorkspace.tsx 搬到了 canvas/geometry.ts。搬动本身不改
 * 行为，但搬动之后原文件里就没人守着它们了——这个套件把它们的行为钉住，
 * 免得以后再次重构时静静改掉一个边界。
 *
 * 每条断言都用画布上真实会出现的坐标，不用抽象数字：吸附的阈值单位是
 * **世界像素**，调用方传的是 `SNAP_SCREEN_PX / scale`，写成具体坐标才看得出
 * 「阈值」到底是屏幕还是世界。
 *
 * Run: node scripts/smoke-canvas-geometry.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { coveredNodes, SNAP_SCREEN_PX, snapOffset } from '../src/client/canvas/geometry.ts'

/** 只给几何函数需要的字段，避免每个用例都写完整 CanvasNode。 */
const node = (id, x, y, width, height) => ({ id, x, y, width, height })

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// ------------------------------------------------------------------ 吸附

check('G1 边缘对齐时给出精确的修正量', () => {
  // a 的右边缘在 100，b 的左边缘在 108：差 8，正好等于阈值，应当吸附。
  assert.deepEqual(
    snapOffset(node('a', 0, 0, 100, 100), [node('b', 108, 0, 100, 100)], 0, 0, SNAP_SCREEN_PX),
    { x: 8, y: 0 },
  )
})

check('G2 超出阈值就不动，而不是吸到一半', () => {
  // 差 30 远大于阈值：返回 0/0，不能被「最近的线」拉过去。
  assert.deepEqual(
    snapOffset(node('a', 0, 0, 100, 100), [node('b', 130, 0, 100, 100)], 0, 0, SNAP_SCREEN_PX),
    { x: 0, y: 0 },
  )
})

check('G3 带位移拖拽时按拖后的位置判断，不是原位置', () => {
  // a 从 0 拖到 dx=50：右边缘变成 150，与 b 的左边缘 152 差 2，应吸。
  assert.deepEqual(
    snapOffset(node('a', 0, 0, 100, 100), [node('b', 152, 0, 100, 100)], 50, 0, SNAP_SCREEN_PX),
    { x: 2, y: 0 },
  )
})

check('G4 中线也对齐，不只是四条边', () => {
  // a 的中线在 50，b 的左边缘在 48：最近的一组是中线对左边缘（差 −2），
  // 比右边缘对左边缘（−52）和左边对左边（+48）都近。
  assert.deepEqual(
    snapOffset(node('a', 0, 0, 100, 100), [node('b', 48, 100, 100, 100)], 0, 0, SNAP_SCREEN_PX),
    { x: -2, y: 0 },
  )
})

check('G5 两个方向各自独立，可以只吸一个轴', () => {
  // x 方向能吸上，y 方向差太远：只修 x。
  assert.deepEqual(
    snapOffset(node('a', 0, 0, 100, 100), [node('b', 103, 400, 100, 100)], 0, 0, SNAP_SCREEN_PX),
    { x: 3, y: 0 },
  )
})

check('G6 没有其他节点时不动', () => {
  assert.deepEqual(snapOffset(node('a', 0, 0, 100, 100), [], 0, 0, SNAP_SCREEN_PX), { x: 0, y: 0 })
})

// -------------------------------------------------------------- 遮挡判定

check('G7 完全被盖住才算，部分重叠不算', () => {
  // a 整个落在 b 里面：报一对。
  assert.deepEqual(
    coveredNodes([node('a', 10, 10, 50, 50), node('b', 0, 0, 100, 100)], new Set(['a'])),
    [{ coveredId: 'a', coverId: 'b' }],
  )
  // 反过来：a 比 b 大且包住 b，而移动的是 a——被罩住的是 b，仍要报，
  // 因为「用户正在动的那一个」参与了这对重叠。
  assert.deepEqual(
    coveredNodes([node('a', 0, 0, 200, 200), node('b', 20, 20, 100, 100)], new Set(['a'])),
    [{ coveredId: 'b', coverId: 'a' }],
  )
  // 只是交叠、互不包含：两边都不算被盖住。
  assert.deepEqual(
    coveredNodes([node('a', 0, 0, 100, 100), node('b', 50, 50, 100, 100)], new Set(['a'])),
    [],
  )
})

check('G8 两块静止节点重叠不报，避免每次载入都描红', () => {
  assert.deepEqual(
    coveredNodes([node('a', 10, 10, 50, 50), node('b', 0, 0, 100, 100)], new Set()),
    [],
  )
  // 移动的是第三个无关节点，也不报。
  assert.deepEqual(
    coveredNodes([node('a', 10, 10, 50, 50), node('b', 0, 0, 100, 100), node('c', 500, 500, 10, 10)], new Set(['c'])),
    [],
  )
})

check('G9 同尺寸完全重合时只报一个方向，不会互为主从来回闪', () => {
  const pairs = coveredNodes([node('a', 0, 0, 100, 100), node('b', 0, 0, 100, 100)], new Set(['a', 'b']))
  assert.equal(pairs.length, 1, `应当只报一对，实际 ${JSON.stringify(pairs)}`)
  // 定的是 id 较小的那个当被盖住方，方向唯一。
  assert.deepEqual(pairs, [{ coveredId: 'a', coverId: 'b' }])
})

check('G10 一个节点被两个盖住时分两条报告', () => {
  const pairs = coveredNodes(
    [node('a', 10, 10, 20, 20), node('b', 0, 0, 100, 100), node('c', 5, 5, 200, 200)],
    new Set(['a']),
  )
  assert.equal(pairs.length, 2, `应当报两条，实际 ${JSON.stringify(pairs)}`)
  assert.deepEqual(pairs.map(pair => pair.coverId).sort(), ['b', 'c'])
})

// ------------------------------------------------------------------- 驱动

let passed = 0
let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
    passed += 1
  } catch (error) {
    results.push(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}
console.log(results.join('\n'))
if (failed > 0) {
  console.error(`\ncanvas geometry: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas geometry: ${passed} passed`)

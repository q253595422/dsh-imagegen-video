/**
 * 画布几何：拖拽吸附、「节点被完全盖住」的判定，以及缩略图的投影。
 *
 * 这些函数都从 CanvasWorkspace.tsx 搬到了 canvas/ 下（`geometry.ts`、
 * `minimap-model.ts`）。搬动本身不改行为，但搬动之后原文件里就没人守着它们
 * 了——这个套件把行为钉住，免得以后再次重构时静静改掉一个边界。
 *
 * 每条断言都用画布上真实会出现的坐标，不用抽象数字：吸附的阈值单位是
 * **世界像素**，调用方传的是 `SNAP_SCREEN_PX / scale`，写成具体坐标才看得出
 * 「阈值」到底是屏幕还是世界。
 *
 * 缩略图那组（M）盯的是「缩略图上的方块和节点真实位置一致」这件事：方块偏
 * 一点点，肉眼几乎看不出来，只能靠数字守。
 *
 * Run: node scripts/smoke-canvas-geometry.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { coveredNodes, SNAP_SCREEN_PX, snapOffset } from '../src/client/canvas/geometry.ts'
import { MINIMAP_SIZE, minimapProjection } from '../src/client/canvas/minimap-model.ts'

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

// -------------------------------------------------------------- 缩略图投影

/** 浮点比较：投影是一串乘除，不用精确相等卡自己。 */
const close = (actual, expected, what) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: 期望 ${expected}，实际 ${actual}`)
}
/** 空画布的默认视野下，缩略图里世界的原点。 */
const EMPTY_VIEWPORT = { k: 1, x: 0, y: 0 }
const CANVAS_SIZE = { width: 1200, height: 900 }

check('M1 空画布时视野居中，世界原点落在缩略图正中', () => {
  // 默认视野 -600..600 两边都装 1200；0.125 = 150/1200 是较小的那个比例，
  // 横向剩下的 70px 两边各留 35。这些是画布打开时的实际数字。
  const projection = minimapProjection([], EMPTY_VIEWPORT, CANVAS_SIZE)
  const origin = projection.toMap(0, 0)
  close(origin.x, MINIMAP_SIZE.width / 2, '原点的 x')
  close(origin.y, MINIMAP_SIZE.height / 2, '原点的 y')
})

check('M2 两个方向互为逆运算：点击换算回世界坐标不能有偏差', () => {
  // 缩略图点击就是把 toMap 的结果过一遍 toWorld。若两者不是严格逆运算，
  // 点哪跳哪都会偏，而且画布越远偏得越多。
  const nodes = [node('a', 120, -80, 300, 200), node('b', 900, 600, 100, 100)]
  const projection = minimapProjection(nodes, { k: 0.8, x: -140, y: 60 }, CANVAS_SIZE)
  for (const [x, y] of [[0, 0], [120, -80], [-2000, 2500], [640, 480]]) {
    const mapped = projection.toMap(x, y)
    const back = projection.toWorld(mapped.x, mapped.y)
    close(back.x, x, `世界点 (${x}, ${y}) 往返后的 x`)
    close(back.y, y, `世界点 (${x}, ${y}) 往返后的 y`)
  }
})

check('M3 内容四周留 500 世界边距，且整片内容都装进缩略图', () => {
  // 只有一个节点时，视野 = 节点范围 + 四周各 500。少了边距，节点方块会贴边
  // 甚至被裁掉，用户就看不见画布外面还有没有东西。
  const projection = minimapProjection([node('a', 0, 0, 100, 100)], EMPTY_VIEWPORT, CANVAS_SIZE)
  const box = projection.nodeBoxes[0]
  assert.ok(box.left > 0 && box.left + box.width < MINIMAP_SIZE.width, `节点方块横向越界：${JSON.stringify(box)}`)
  assert.ok(box.top > 0 && box.top + box.height < MINIMAP_SIZE.height, `节点方块纵向越界：${JSON.stringify(box)}`)
  // 单个 100×100 的节点在世界里占 100/1100 ≈ 9% 宽，方块宽度应当同比例。
  const scale = Math.min(MINIMAP_SIZE.width, MINIMAP_SIZE.height) / 1100
  close(box.width, 100 * scale, '节点方块宽度')
})

check('M4 视口矩形跟着平移走：挪画布，框也跟着挪', () => {
  // viewport.x = -100 表示世界向右平移了 100，看得见的世界左上角是 100。
  const projection = minimapProjection([], { k: 1, x: -100, y: -50 }, { width: 800, height: 600 })
  const rect = projection.viewportRect
  const scale = MINIMAP_SIZE.height / 1200
  close(rect.x, (100 + 600) * scale + (MINIMAP_SIZE.width - 1200 * scale) / 2, '视口矩形的 x')
  close(rect.y, (50 + 600) * scale, '视口矩形的 y')
  // 800×600 的世界范围按同一比例缩小，长宽比不变。
  close(rect.w, 800 * scale, '视口矩形的宽')
  close(rect.h, 600 * scale, '视口矩形的高')
})

check('M4b 视口大小按缩放换算成世界尺寸：k≠1 时是除以缩放，不是乘以它', () => {
  // 1200px 的画布在 k=2 时只看得到 600 个世界单位。写成乘的话会变成 2400——
  // 缩略图上那个框会大到盖住整片内容，而 k=1 时乘除同值，看不出区别。
  const projection = minimapProjection([], { k: 2, x: 0, y: 0 }, { width: 1200, height: 900 })
  const rect = projection.viewportRect
  const scale = MINIMAP_SIZE.height / 1200
  close(rect.w, 600 * scale, '视口矩形的宽')
  close(rect.h, 450 * scale, '视口矩形的高')
})

check('M5 放大到看不清时，视口矩形留着 4px 最小尺寸', () => {
  // k = 100 时 1200px 的视口只覆盖 12 个世界单位，投到缩略图上不到 2px——
  // 不兜底的话「现在看得见哪一块」会直接消失。
  const projection = minimapProjection([], { k: 100, x: 0, y: 0 }, CANVAS_SIZE)
  assert.ok(projection.viewportRect.w >= 4, `视口矩形宽度 ${projection.viewportRect.w} 小于 4px`)
  assert.ok(projection.viewportRect.h >= 4, `视口矩形高度 ${projection.viewportRect.h} 小于 4px`)
})

check('M6 每个节点一个方块，id 与类型原样带出（选中态和配色靠它）', () => {
  const nodes = [node('img', 0, 0, 100, 100), node('txt', 400, 0, 100, 100)]
  nodes[0].type = 'image'
  nodes[1].type = 'text'
  const projection = minimapProjection(nodes, EMPTY_VIEWPORT, CANVAS_SIZE)
  assert.deepEqual(projection.nodeBoxes.map(box => [box.id, box.type]), [['img', 'image'], ['txt', 'text']])
  // 两个节点大小相同，方块也应当一样大；位置不同，左边那个更靠左。
  close(projection.nodeBoxes[0].width, projection.nodeBoxes[1].width, '两个方块的宽度')
  assert.ok(projection.nodeBoxes[0].left < projection.nodeBoxes[1].left, '左边节点的方块没有更靠左')
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

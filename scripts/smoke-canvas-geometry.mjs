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
import { coveredNodes, SNAP_SCREEN_PX, snapGuides, snapOffset } from '../src/client/canvas/geometry.ts'
import { reorderLayers } from '../src/client/canvas/layer-order.ts'
import { MINIMAP_SIZE, minimapKindOf, minimapProjection, minimapStateOf } from '../src/client/canvas/minimap-model.ts'
import { gridStepFor, invScaleFor, GRID_MIN_SCREEN_PX, ZOOM_FAR, ZOOM_NEAR, zoomBandOf } from '../src/client/canvas/zoom-band.ts'
import { configReadiness, scanConfigReadiness, summarizeReadiness } from '../src/client/canvas/readiness.ts'
import { ARRANGE_GAP, arrangePositions } from '../src/client/canvas/arrange-model.ts'
import { EMPTY_RUN_MARKS, hasMarks, markOf, runMarksFrom, withoutFailed } from '../src/client/canvas/run-marks.ts'
import { CAPABILITIES, capabilitySections, runnableItems, CAPABILITY_GROUP_ORDER } from '../src/client/canvas/capability-catalog.ts'

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

// ------------------------------------------------------------ 吸附参考线（GG）

// 参考线是吸附的**解释**：坐标早就吸上了，但用户看到的是卡片自己跳了一下。
// 这组的每一条都在挡「线画在错的地方」——线错位比没有线更糟，它会让用户相信
// 一次并不存在的对齐。

check('GG1 上下摞着的两张同宽卡：三条竖线，每条都跨越两张卡的上下范围', () => {
  // 三对三的边比对里，左/中/右三对全部成立。这**不是**冗余：用户把卡上下摞
  // 起来时三条都真的对齐了，少画一条会让他以为中间那条没对齐。
  const guides = snapGuides(node('a', 100, 100, 200, 100), [node('b', 100, 300, 200, 100)])
  assert.deepEqual(guides, [
    { axis: 'x', at: 100, from: 100, to: 400 },
    { axis: 'x', at: 200, from: 100, to: 400 },
    { axis: 'x', at: 300, from: 100, to: 400 },
  ])
})

check('GG2 差超过半像素就不算对上（否则线会在一堆不相干的卡之间乱闪）', () => {
  assert.deepEqual(snapGuides(node('a', 100, 100, 200, 100), [node('b', 101, 300, 200, 100)]), [])
  // 半个像素正好落在容差上：拖动里位置被取整，浮点误差就是这一档。
  const half = snapGuides(node('a', 100, 100, 200, 100), [node('b', 100.5, 300, 200, 100)])
  assert.equal(half.length, 3, '三对边都在容差内')
  assert.equal(half[0].at, 100.5, '线画在**对方的**坐标上，不是自己那一侧')
})

check('GG3 中线、右边都算，且同一条坐标只出一条线', () => {
  // 同宽的两张卡：左/中/右三条边必然全部重合——这是「上下摞着摆」的常态，
  // 画三条重叠的线在视觉上是一条，但会多出三层 DOM。
  const guides = snapGuides(node('a', 100, 100, 200, 100), [node('b', 100, 300, 200, 100)])
  assert.deepEqual(guides.map(guide => guide.at), [100, 200, 300])
  // 右边对左边（100+200 = 300 = 另一张的左边缘）同样成立：用户按视觉判断的
  // 就是「两条边在同一条竖线上」，谁是谁的左边不重要。
})

check('GG4 横线与竖线可以同时出现，顺序固定（先竖后横、坐标升序）', () => {
  // b 正好接在 a 的下方：三条竖边全部重合，另有一条横线（a 的下边 = b 的上边）。
  // 顺序固定是为了让两次相同的拖动产出同一份 DOM——顺序抖动会被快照比对误判
  // 成回归，也会让「这一帧画了几条」变成一个不稳定的事实。
  const guides = snapGuides(node('a', 100, 100, 200, 100), [node('b', 100, 200, 200, 100)])
  assert.deepEqual(guides.map(guide => `${guide.axis}${guide.at}`), ['x100', 'x200', 'x300', 'y200'])
})

check('GG5 没有对齐就没有线，不返回空区间的幽灵线', () => {
  assert.deepEqual(snapGuides(node('a', 100, 100, 200, 100), [node('b', 0, 0, 50, 50)]), [])
  assert.deepEqual(snapGuides(node('a', 100, 100, 200, 100), []), [])
})

check('GG6 区间取并集：一列整齐的卡只画一条跨越全部的长线', () => {
  const guides = snapGuides(node('a', 100, 100, 200, 100), [
    node('b', 100, 0, 200, 50),
    node('c', 100, 400, 200, 50),
  ])
  const vertical = guides.find(guide => guide.axis === 'x' && guide.at === 100)
  assert.deepEqual(vertical, { axis: 'x', at: 100, from: 0, to: 450 })
})

// -------------------------------------------------------------- 遮挡判定

check('G7 完全被盖住才算，部分重叠不算', () => {
  // a 整个落在 b 里面：报一对。
  assert.deepEqual(
    coveredNodes([node('a', 10, 10, 50, 50), node('b', 0, 0, 100, 100)], new Set(['a'])),
    [{ coveredId: 'a', coverId: 'b' }],
  )
  // a(200x200) 在数组前面、b(100x100) 在后面：b 画在 a 上面，看得见，不算被盖住。
  assert.deepEqual(
    coveredNodes([node('a', 0, 0, 200, 200), node('b', 20, 20, 100, 100)], new Set(['a'])),
    [],
  )
  // 顺序反过来，同样的几何：小卡被大卡压住，这时才报。
  assert.deepEqual(
    coveredNodes([node('b', 20, 20, 100, 100), node('a', 0, 0, 200, 200)], new Set(['a'])),
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
  // 方向由数组下标唯一决定：下标小的 `a` 在下面，被上面的 `b` 盖住。
  assert.deepEqual(pairs, [{ coveredId: 'a', coverId: 'b' }])
  // 把 id 顺序也反过来：旧实现按 id 兜底时会漏掉这一对（被盖住方 id 较大），
  // 而尺寸相同时两边都互相包含，删掉兜底后仍然只有一条，方向跟着下标走。
  assert.deepEqual(
    coveredNodes([node('b', 0, 0, 100, 100), node('a', 0, 0, 100, 100)], new Set(['a', 'b'])),
    [{ coveredId: 'b', coverId: 'a' }],
  )
})

check('G10 层级决定方向：同一对几何，数组顺序一换，报告从「没有」变成「一对」', () => {
  // 测的是这次改动的核心：几何包含相同、只有绘制顺序不同，结论必须跟着顺序走。
  // 大卡在下时小卡看得见，报出来就是假的「被完全盖住」，用户照着提示按置顶也不会
  // 让提示消失——这条断言把那个反向报告钉死。
  assert.deepEqual(
    coveredNodes([node('big', 0, 0, 200, 200), node('small', 20, 20, 100, 100)], new Set(['small'])),
    [],
  )
  assert.deepEqual(
    coveredNodes([node('small', 20, 20, 100, 100), node('big', 0, 0, 200, 200)], new Set(['small'])),
    [{ coveredId: 'small', coverId: 'big' }],
  )
})

check('G11 把被压住的小卡置顶之后，遮盖提示必须消失', () => {
  // 测的是 layer-order 与 coveredNodes 的跨模块契约：两边各自对、合起来错，正是这
  // 类缺陷的形态。提示存在的意义是「把它拿到前面来」，所以照做之后它必须自己消失；
  // 否则用户点一次「置顶」看到提示还在，只会认为按钮坏了。
  const stacked = [node('small', 20, 20, 100, 100), node('big', 0, 0, 200, 200)]
  assert.deepEqual(
    coveredNodes(stacked, new Set(['small'])),
    [{ coveredId: 'small', coverId: 'big' }],
  )
  const { nodes: raised, moved } = reorderLayers(stacked, new Set(['small']), 'front')
  assert.equal(moved, true, '小卡本来在下面，置顶必须真的改变顺序')
  assert.deepEqual(coveredNodes(raised, new Set(['small'])), [], '置顶之后仍报被盖住：提示指的是一步没用的操作')
})

check('G12 三张同心嵌套：三条包含关系都成立，但只有被压住的那些才报', () => {
  // 测的是嵌套层级：a/b/c 同心、依次变小，单看几何三条包含关系都成立，差别只在
  // 数组顺序。第一种顺序里最大的 a 在最底下——a 包着 b、c 却压不住任何人，一条
  // 都不该报；否则整张图一拖就冒出一堆假的「被完全盖住」。
  assert.deepEqual(
    coveredNodes(
      [node('a', 0, 0, 300, 300), node('b', 50, 50, 200, 200), node('c', 100, 100, 100, 100)],
      new Set(['a', 'b', 'c']),
    ),
    [],
  )
  // 顺序翻过来（a 最上、c 最下），三条包含关系才都成立：c 被 b、a 压住，b 被 a 压住。
  // 已知取舍：调用方只取 `pairs[0]`，这里取到的是最近的 b←c。顺序并非按「距离」排序，
  // 只是循环从下往上扫时先遇到这一对；更外层的 a←c 就留给后续消费方全量使用。
  assert.deepEqual(
    coveredNodes(
      [node('c', 100, 100, 100, 100), node('b', 50, 50, 200, 200), node('a', 0, 0, 300, 300)],
      new Set(['a', 'b', 'c']),
    ),
    [
      { coveredId: 'c', coverId: 'b' },
      { coveredId: 'c', coverId: 'a' },
      { coveredId: 'b', coverId: 'a' },
    ],
  )
})

check('G13 一个节点被两个盖住时分两条报告', () => {
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

check('M6 每个节点一个方块，id 与种类原样带出（选中态和配色靠它）', () => {
  const nodes = [node('img', 0, 0, 100, 100), node('txt', 400, 0, 100, 100)]
  nodes[0].type = 'image'
  nodes[1].type = 'text'
  const projection = minimapProjection(nodes, EMPTY_VIEWPORT, CANVAS_SIZE)
  assert.deepEqual(projection.nodeBoxes.map(box => [box.id, box.kind]), [['img', 'image'], ['txt', 'text']])
  // 两个节点大小相同，方块也应当一样大；位置不同，左边那个更靠左。
  close(projection.nodeBoxes[0].width, projection.nodeBoxes[1].width, '两个方块的宽度')
  assert.ok(projection.nodeBoxes[0].left < projection.nodeBoxes[1].left, '左边节点的方块没有更靠左')
})

// -------------------------------------------------- 缩略图：语义与连线（N）

/** 带 metadata 的节点，只有缩略图那两个派生函数需要。 */
const metaNode = (id, type, metadata, x = 0, y = 0) => ({ ...node(id, x, y, 200, 150), type, metadata })

check('N1 画板 / 姿势人偶是 image 类型，但在缩略图上必须自成一类', () => {
  // 草图与姿势导出后就是普通图片（`type: 'image'`），可它们在版图上回答的是
  // 「我的输入在哪」而不是「我的产物在哪」。混成一类的话，用户在缩略图上找
  // 已生成的图会先撞上一堆画板。
  assert.equal(minimapKindOf(metaNode('s', 'image', { sketch: { strokes: [] } })), 'sketch')
  assert.equal(minimapKindOf(metaNode('p', 'image', { pose: { joints: {} } })), 'pose')
  assert.equal(minimapKindOf(metaNode('i', 'image', { asset: { assetId: '', url: 'x', mime: 'image/png', bytes: 1, width: 1, height: 1, origin: 'upload' } })), 'image')
})

check('N2 「空 / 有 / 在跑 / 失败」四态分得开，且不看产物是什么', () => {
  assert.equal(minimapStateOf(metaNode('a', 'image', { status: 'idle' })), 'empty')
  assert.equal(minimapStateOf(metaNode('b', 'image', { status: 'generating' })), 'running')
  assert.equal(minimapStateOf(metaNode('c', 'image', { status: 'error' })), 'error')
  assert.equal(minimapStateOf(metaNode('d', 'video', { status: 'success', video: { url: 'clip.mp4' } })), 'filled')
  // 一个 `success` 的配置节点没有任何产物 —— 这里必须仍然是 empty，否则缩略图
  // 会把「配置写完了」画成「产出了」。
  assert.equal(minimapStateOf(metaNode('e', 'config', { status: 'success', text: '' })), 'empty')
  assert.equal(minimapStateOf(metaNode('f', 'config', { status: 'success', text: '一只猫' })), 'filled')
})

check('N3 连线画成缩略图上的直线：两端落在方块中心，且跳过已删除的一端', () => {
  // 缩略图存在的理由就是回答「流程长什么样」。只有方块的时候，两列并排的节点
  // 和一条流水线在缩略图上长得一模一样。
  const nodes = [
    { ...node('a', 0, 0, 200, 100), type: 'text', metadata: { text: 'p' } },
    { ...node('b', 800, 0, 200, 100), type: 'image', metadata: {} },
  ]
  const projection = minimapProjection(nodes, EMPTY_VIEWPORT, CANVAS_SIZE, [
    { id: 'e1', fromNodeId: 'a', toNodeId: 'b' },
    // 一端已经不在 nodes 里：`connections` 可能短暂领先于 `nodes`，这一条不能
    // 变成一条不知通向哪的悬空线。
    { id: 'e2', fromNodeId: 'a', toNodeId: 'gone' },
  ])
  assert.equal(projection.edgeLines.length, 1)
  const line = projection.edgeLines[0]
  const boxA = projection.nodeBoxes.find(box => box.id === 'a')
  close(line.x1, boxA.left + boxA.width / 2, '连线起点 x')
  close(line.y1, boxA.top + boxA.height / 2, '连线起点 y')
  assert.ok(line.x2 > line.x1, '连线没有从 a 指向 b')
})

// ------------------------------------------------------------ 缩放分档（Z）

check('Z1 三档的边界：正好在阈值上归入「近」', () => {
  // 边界取「>=」而不是「>」：用户拖到 0.6 时不该刚好掉进概览模式，那是缩放手感
  // 上最容易感觉「怎么突然变样了」的那一格。
  assert.equal(zoomBandOf(ZOOM_NEAR), 'near')
  assert.equal(zoomBandOf(ZOOM_FAR), 'mid')
  assert.equal(zoomBandOf(ZOOM_FAR - 0.001), 'far')
  // 异常值不许把画布锁进概览：NaN / 0 都按近档。
  assert.equal(zoomBandOf(Number.NaN), 'near')
  assert.equal(zoomBandOf(0), 'near')
})

check('Z2 网格步长翻倍直到屏幕格距不低于下限，且 100% 时不动', () => {
  // 基准不许变：48 世界像素就是用户从第一个版本起看到的那张网格。
  assert.equal(gridStepFor(1, 48).step, 48)
  assert.equal(gridStepFor(1, 48).size, 48)
  // 17% 下 48*0.17 = 8.16 < 16，翻一倍到 96 → 16.32 够用。
  assert.equal(gridStepFor(0.17, 48).step, 96)
  assert.ok(gridStepFor(0.17, 48).size >= GRID_MIN_SCREEN_PX)
  // 每个档都要满足下限，且步长始终是基准的 2 的幂（否则格线对不齐世界原点）。
  for (const k of [0.9, 0.6, 0.4, 0.25, 0.17, 0.08, 0.05]) {
    const { step, size } = gridStepFor(k, 48)
    assert.ok(size >= GRID_MIN_SCREEN_PX - 1e-9, `k=${k} 的格距只有 ${size}px`)
    assert.equal(Math.log2(step / 48) % 1, 0, `k=${k} 的步长不是 2 的幂：${step}`)
  }
})

check('Z3 描边补偿是 1/k，且有上限', () => {
  assert.equal(invScaleFor(1), 1)
  assert.equal(invScaleFor(0.5), 2)
  // 上限 8：再往下补偿会让相邻卡片的轮廓互相咬住。
  assert.equal(invScaleFor(0.05), 8)
  // 放大时确实小于 1 —— 但调用方只会在 mid/far 两档用它（那条由 CSS 选择器守）。
  assert.ok(invScaleFor(2) < 1)
})

// -------------------------------------------------------- 配置节点就绪（R）

const readyInput = (patch = {}) => ({
  ownText: '',
  // 提交路径读的「活动编辑框」排在持久值之前；不传它，`configReadiness`
  // 会在 `.trim()` 上直接抛异常，而这套件当时没进 `pnpm test`，所以没红过。
  composerText: '',
  upstreamTexts: [],
  model: 'gpt-image-2',
  channelConnected: true,
  codeRenderer: false,
  referenceCount: 0,
  ...patch,
})

check('R1 提示词优先取自己的框，与提交路径同序', () => {
  // 顺序必须与 `submitComposer` 一致：自己的框里写了就用它，否则拼上游文本。
  // 两边顺序不同会出现「卡片说可以」而提交说「请输入生成描述」。
  const own = configReadiness(readyInput({ ownText: '一只猫', upstreamTexts: ['一只狗'] }))
  assert.equal(own.prompt, '一只猫')
  const upstream = configReadiness(readyInput({ upstreamTexts: ['第一行', '  ', '第二行'] }))
  assert.equal(upstream.prompt, '第一行\n第二行', '空白的上游文本必须被跳过，不能留下一个空行')
  assert.equal(upstream.ready, true)
})

check('R2 缺提示词只报 prompt，缺模型 / 缺渠道分开报', () => {
  // 三个阻塞项对应三个完全不同的动作：写框里的字 / 选模型 / 去设置填钥匙。
  // 合成一句「无法生成」会让人去翻设置页找答案。
  assert.deepEqual(configReadiness(readyInput()).blockers, ['prompt'])
  assert.deepEqual(configReadiness(readyInput({ ownText: 'x', model: '' })).blockers, ['model'])
  assert.deepEqual(configReadiness(readyInput({ ownText: 'x', channelConnected: false })).blockers, ['channel'])
  // 模型都没有时不该再报「渠道未配置」：那会把用户支去填一把还没有模型的钥匙。
  assert.deepEqual(configReadiness(readyInput({ ownText: 'x', model: '', channelConnected: false })).blockers, ['model'])
})

check('R3 code 渲染不需要模型与渠道，但仍需要提示词', () => {
  // 与 `submitComposer` 的 `if (!codeRenderer && ...)` 一致。code 路径由本机
  // 对话模型写绘图代码，没有图像供应商可言。
  assert.equal(configReadiness(readyInput({ ownText: 'x', model: '', channelConnected: false, codeRenderer: true })).ready, true)
  assert.deepEqual(configReadiness(readyInput({ model: '', channelConnected: false, codeRenderer: true })).blockers, ['prompt'])
})

check('R4 汇总数的是节点数，不是阻塞项数，且报得出第一个', () => {
  const items = [
    configReadiness(readyInput({ ownText: 'a' })),
    configReadiness(readyInput({ ownText: 'b', model: '' })),
    configReadiness(readyInput()),
  ]
  const summary = summarizeReadiness(items)
  assert.equal(summary.ready, 1)
  assert.equal(summary.blocked, 2)
  assert.equal(summary.first, 'model')
  assert.equal(summarizeReadiness([]).first, null)
})

// ------------------------------------------------- 全图扫描（运行前预告）
//
// S 组守的是「按一次运行之前就知道会卡在哪」这件事。它必须**与卡片上的徽标
// 同源**：两边各算一遍，就会有一天卡片说能跑、菜单说不能跑——而用户会相信
// 其中一个，然后在另一个上浪费一次运行。

/** 一张最小的画布：一个配置节点，可带上游。 */
const configScanFixture = ({ upstream = [], attrs = {}, connections = [] } = {}) => {
  const config = {
    id: 'cfg', type: 'config', title: 'cfg', x: 0, y: 0, width: 320, height: 190,
    metadata: { model: 'gpt-image-2', ...attrs },
  }
  const ctx = {
    composerTextFor: () => '',
    modelFor: node => node.metadata?.model ?? '',
    channelConnected: channelId => channelId !== 'unconfigured',
  }
  const nodes = [...upstream, config]
  return scanConfigReadiness(nodes, connections, ctx)
}
const textNode = (id, text) => ({ id, type: 'text', title: id, x: 0, y: 0, width: 280, height: 150, metadata: { text } })
const imageNode = (id, url) => ({ id, type: 'image', title: id, x: 0, y: 0, width: 240, height: 240, metadata: { asset: { assetId: id, url, mime: 'image/png', bytes: 1, width: 10, height: 10, origin: 'upload' } } })
const link = (from, to) => ({ id: `e-${from}-${to}`, fromNodeId: from, toNodeId: to })

check('S1 没连任何东西的配置节点：缺提示词', () => {
  const scanned = configScanFixture()
  assert.deepEqual(scanned.get('cfg').blockers, ['prompt'])
})

check('S2 连了有内容的文本节点：不再缺提示词，提示词就是那段文字', () => {
  const scanned = configScanFixture({ upstream: [textNode('t', '一只猫')], connections: [link('t', 'cfg')] })
  assert.deepEqual(scanned.get('cfg').blockers, [])
  assert.equal(scanned.get('cfg').prompt, '一只猫')
})

check('S3 标注卡不算上游提示词：它是给图上的某个局部写的备注', () => {
  // 标注卡也是 text 节点，但带 `metadata.annotation`。把它拼进提示词会变成
  // 一句莫名其妙的注释，而用户看不出来它是从哪来的。
  const card = textNode('card', '把这个盒子改成红色')
  card.metadata.annotation = { sourceNodeId: 'img', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }
  const scanned = configScanFixture({ upstream: [card], connections: [link('card', 'cfg')] })
  assert.deepEqual(scanned.get('cfg').blockers, ['prompt'])
})

check('S4 没连线的文本节点不参与：画布不猜「看起来在旁边」的意思', () => {
  const scanned = configScanFixture({ upstream: [textNode('t', '一只猫')] })
  assert.deepEqual(scanned.get('cfg').blockers, ['prompt'])
})

check('S5 连了图 → 认得出这是图生图（文案要用图生图）', () => {
  const scanned = configScanFixture({
    upstream: [textNode('t', '换成红色'), imageNode('img', 'data:image/png;base64,AA')],
    connections: [link('t', 'cfg'), link('img', 'cfg')],
  })
  assert.equal(scanned.get('cfg').hasReference, true)
  assert.deepEqual(scanned.get('cfg').blockers, [])
})

check('S6 空 asset 的图片节点不算参考图', () => {
  const scanned = configScanFixture({
    upstream: [textNode('t', '画点什么'), imageNode('img', '')],
    connections: [link('t', 'cfg'), link('img', 'cfg')],
  })
  assert.equal(scanned.get('cfg').hasReference, false)
})

check('S7 渠道未配置与模型缺失分开报，且渠道检查在模型之后', () => {
  const noModel = configScanFixture({ attrs: { model: '' } })
  assert.deepEqual(noModel.get('cfg').blockers, ['prompt', 'model'])
  const noChannel = configScanFixture({ attrs: { channelId: 'unconfigured' } })
  assert.deepEqual(noChannel.get('cfg').blockers, ['prompt', 'channel'])
  // 模型缺失时不再报渠道：先选模型，才知道该看哪个渠道的钥匙。
  const both = configScanFixture({ attrs: { model: '', channelId: 'unconfigured' } })
  assert.equal(both.get('cfg').blockers.includes('channel'), false)
})

check('S8 code 渲染不需要模型和渠道', () => {
  const scanned = configScanFixture({
    upstream: [textNode('t', '画一条线')],
    connections: [link('t', 'cfg')],
    attrs: { renderer: 'code', model: '', channelId: 'unconfigured' },
  })
  assert.deepEqual(scanned.get('cfg').blockers, [])
})

check('S9 活动编辑框里的字优先于上游文本，与提交路径同序', () => {
  const nodes = [textNode('t', '上游那句'), {
    id: 'cfg', type: 'config', title: 'cfg', x: 0, y: 0, width: 320, height: 190, metadata: { model: 'gpt-image-2' },
  }]
  const scanned = scanConfigReadiness(nodes, [link('t', 'cfg')], {
    composerTextFor: () => '正在写的那句',
    modelFor: () => 'gpt-image-2',
    channelConnected: () => true,
  })
  assert.equal(scanned.get('cfg').prompt, '正在写的那句')
})

check('S10 汇总：多个配置节点时给出可跑的、卡住的和第一个原因', () => {
  const nodes = [
    textNode('t', '有内容'),
    { id: 'ok', type: 'config', title: 'ok', x: 0, y: 0, width: 320, height: 190, metadata: { model: 'gpt-image-2' } },
    { id: 'bad', type: 'config', title: 'bad', x: 0, y: 0, width: 320, height: 190, metadata: { model: 'gpt-image-2' } },
    // 非配置节点不进汇总：它们不是「跑不跑得起来」的问题。
    { id: 'img', type: 'image', title: 'img', x: 0, y: 0, width: 240, height: 240 },
  ]
  const scanned = scanConfigReadiness(nodes, [link('t', 'ok')], {
    composerTextFor: () => '',
    modelFor: () => 'gpt-image-2',
    channelConnected: () => true,
  })
  assert.equal(scanned.size, 2, '只有配置节点进扫描结果')
  const summary = summarizeReadiness([...scanned.values()])
  assert.equal(summary.ready, 1)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.first, 'prompt')
})

// ------------------------------------------------------------ 整理画布
//
// A 组守的是「整理」这个动作的四条承诺：分层与执行器一致、环不排、散卡
// 单独停放、幂等。这四条里任何一条破了，用户按一下就会得到一张看起来更
// 整齐、实际更看不懂的图——而那种结果不会报错，只会让人不再用这个按钮。

/** 只给整理用的字段；宽高给默认值，个别用例自己覆盖。 */
const box = (id, x, y, width = 240, height = 240) => ({ id, type: 'image', title: id, x, y, width, height })
const wire = (from, to) => ({ id: `e-${from}-${to}`, fromNodeId: from, toNodeId: to })

check('A1 一条 A→B→C 的链整理成三列，列内只有一个节点', () => {
  const nodes = [box('c', 900, 700), box('a', 40, 30), box('b', 500, 400)]
  const result = arrangePositions(nodes, [wire('a', 'b'), wire('b', 'c')])
  assert.equal(result.ok, true)
  assert.equal(result.columns, 3)
  const at = id => result.positions.get(id)
  // 三列从左到右，且列与列之间的距离是列宽 + ARRANGE_GAP.x。
  assert.equal(at('a').x, 40, '第一列的左边缘应当就是原包围盒的左上角')
  assert.equal(at('b').x, 40 + 240 + ARRANGE_GAP.x)
  assert.equal(at('c').x, 40 + (240 + ARRANGE_GAP.x) * 2)
  // 每列只有一个节点，都在同一行（锚点 y）。
  assert.equal(at('a').y, 30)
  assert.equal(at('b').y, 30)
  assert.equal(at('c').y, 30)
})

check('A2 同一层的两个节点上下排开，按它们原来的上下顺序', () => {
  // b 与 c 都只依赖 a：同层。原来的 y：c 在上、b 在下。
  const nodes = [box('a', 0, 0), box('b', 300, 900), box('c', 300, 300)]
  const result = arrangePositions(nodes, [wire('a', 'b'), wire('a', 'c')])
  assert.equal(result.columns, 2)
  const at = id => result.positions.get(id)
  assert.equal(at('a').y, 0)
  assert.equal(at('c').y, 0, '原来在上面的那个整理后还在上面')
  assert.equal(at('b').y, 240 + ARRANGE_GAP.y)
  // 同层同列：x 一样。
  assert.equal(at('b').x, at('c').x)
})

check('A3 有环就整张图拒绝，并报出环上的节点', () => {
  const result = arrangePositions([box('a', 0, 0), box('b', 400, 0)], [wire('a', 'b'), wire('b', 'a')])
  assert.equal(result.ok, false)
  assert.deepEqual([...result.cycle].sort(), ['a', 'b'])
})

check('A4 没接线的卡片落在流程下方，不混进第一列', () => {
  const nodes = [box('a', 0, 0), box('b', 400, 0), box('loose', 800, 0)]
  const result = arrangePositions(nodes, [wire('a', 'b')])
  assert.equal(result.columns, 2)
  assert.equal(result.parked, 1)
  const flowBottom = Math.max(...['a', 'b'].map(id => result.positions.get(id).y + 240))
  const loose = result.positions.get('loose')
  assert.equal(loose.y, flowBottom + ARRANGE_GAP.y * 2, '停放带与流程之间留两倍行距')
  assert.equal(loose.x, 0, '停放带从同一个左边缘开始')
})

check('A5 一个连线都没有时全部进停放带，按原顺序铺开', () => {
  const nodes = [box('a', 0, 500), box('b', 300, 100), box('c', 600, 900)]
  const result = arrangePositions(nodes, [])
  assert.equal(result.columns, 0)
  assert.equal(result.parked, 3)
  // 原顺序按 y 排：b(100) → a(500) → c(900)。三列之内都在同一行。
  const ys = ['a', 'b', 'c'].map(id => result.positions.get(id).y)
  assert.equal(new Set(ys).size, 1, '三列之内应当在同一行')
  assert.equal(result.positions.get('b').x, 0)
  assert.equal(result.positions.get('a').x, 240 + ARRANGE_GAP.x)
})

check('A6 再整理一次，结果逐字节相同（幂等）', () => {
  const nodes = [box('a', 0, 0), box('b', 400, 300), box('c', 100, 700), box('loose', 900, 900)]
  const edges = [wire('a', 'b'), wire('b', 'c')]
  const first = arrangePositions(nodes, edges)
  const moved = nodes.map(node => ({ ...node, ...first.positions.get(node.id) }))
  const second = arrangePositions(moved, edges)
  assert.equal(second.ok, true)
  assert.equal(second.moved, 0, '已经是整理好的形状了，不该再动一次')
  for (const node of moved) {
    assert.deepEqual(second.positions.get(node.id), { x: node.x, y: node.y })
  }
})

check('A7 指向已删除节点的残线不参与分层，也不会把孤立节点拉进流程', () => {
  const nodes = [box('a', 0, 0), box('lonely', 0, 600)]
  // ghost 已经不在画布上了：这条线两端都不完整，不能算。
  const result = arrangePositions(nodes, [wire('a', 'ghost')])
  assert.equal(result.columns, 0)
  assert.equal(result.parked, 2)
})

check('A8 整理后的坐标是整数，且一个节点都不漏', () => {
  const nodes = [box('a', 3.7, -12.4), box('b', 410.2, 300.9)]
  const result = arrangePositions(nodes, [wire('a', 'b')])
  assert.equal(result.positions.size, 2)
  for (const placement of result.positions.values()) {
    assert.equal(Number.isInteger(placement.x), true)
    assert.equal(Number.isInteger(placement.y), true)
  }
  // 锚点是原包围盒左上角四舍五入：负坐标不能被裁到 0（-12.4 → -12）。
  assert.equal(result.positions.get('a').x, 4)
  assert.equal(result.positions.get('a').y, -12)
})

check('A9 空画布：什么都不做，也不报环', () => {
  const result = arrangePositions([], [])
  assert.equal(result.ok, true)
  assert.equal(result.moved, 0)
  assert.equal(result.positions.size, 0)
})

// ------------------------------------------------------- 运行痕迹（F 组）
//
// F 组守的是「跑完之后，画布自己说得出哪些结果不能用」。在这之前只有一条
// 会消失的 toast——用户回头看这张图时，失败节点和成功节点长得一样，被跳过
// 的下游和「还没跑」也长得一样。这是工作流画布最该有、却最容易被做成通知
// 的一件事。
//
// 三条不能破的规则：失败与被跳过分开、取消/成环不留痕、单节点重试只摘自己。

const runResult = (patch = {}) => ({
  status: 'failed',
  failedNodeIds: [],
  blocked: [],
  ...patch,
})

check('F1 失败与被跳过是两种标记，不能合并', () => {
  const marks = runMarksFrom(runResult({ status: 'partial', failedNodeId: 'a', failedNodeIds: ['a'], blocked: ['b', 'c'] }))
  assert.equal(markOf(marks, 'a'), 'failed')
  assert.equal(markOf(marks, 'b'), 'blocked')
  assert.equal(markOf(marks, 'c'), 'blocked')
  assert.equal(markOf(marks, 'd'), null)
  assert.equal(hasMarks(marks), true)
})

check('F2 两个字段永远不重叠：同时在两边时按失败算', () => {
  // `blocked` 的定义是「没提交」，与「提交了但失败」互斥。真出现交集时，
  // 失败的信息更具体、也更需要动作，所以它优先。
  const marks = runMarksFrom(runResult({ failedNodeIds: ['a'], blocked: ['a', 'b'] }))
  assert.equal(marks.failed.has('a'), true)
  assert.equal(marks.blocked.has('a'), false)
  assert.equal(marks.blocked.has('b'), true)
})

check('F3 只填了 failedNodeId 的半成品结果也要标出一个', () => {
  // 兜底：执行器某个分支只填了第一个字段时，整张画布不能一个标记都不出现。
  const marks = runMarksFrom(runResult({ failedNodeId: 'only', failedNodeIds: [] }))
  assert.equal(marks.failed.has('only'), true)
})

check('F4 完成与成环不留痕，但取消会保留按停之前的失败', () => {
  assert.equal(hasMarks(runMarksFrom(runResult({ status: 'completed' }))), false)
  // 成环时一个节点都没提交，画布上什么都没变；那该说「这张图有问题」，
  // 而不是给每张卡挂一个它没参与过的结论。
  assert.equal(hasMarks(runMarksFrom(runResult({ status: 'cycle' }))), false)
  // 取消**要**留痕：执行器把「按停之前就已经失败」的节点原样带在
  // `failedNodeIds` 里，那些失败是真的，产物也不可信。跟着取消一起抹掉，
  // 等于因为一次取消就把已知的坏结果洗成好的。
  const cancelled = runMarksFrom(runResult({ status: 'cancelled', failedNodeId: 'a', failedNodeIds: ['a'], blocked: ['b'] }))
  assert.equal(markOf(cancelled, 'a'), 'failed')
  assert.equal(markOf(cancelled, 'b'), 'blocked')
})

check('F5 单节点重试只摘掉自己的红标，被跳过的下游不动', () => {
  const before = runMarksFrom(runResult({ failedNodeIds: ['a'], blocked: ['b'] }))
  const after = withoutFailed(before, 'a')
  assert.equal(after.failed.has('a'), false, '重试过的节点不该还挂着红标')
  // 上游恢复了不等于下游跑过了：它仍然没有产物。
  assert.equal(after.blocked.has('b'), true)
  // 摘一个不存在的节点是空操作，且返回同一个引用（避免无意义的重渲染）。
  assert.equal(withoutFailed(after, 'zzz'), after)
})

check('F6 失败节点的下游标记在上游重试后仍然存在', () => {
  // 这条与 F5 是同一条规矩的另一半，单独钉住：一旦有人「顺手」把 blocked
  // 也一起清了，用户会看到一个刚从没跑过、却没有任何标记的节点。
  const before = runMarksFrom(runResult({ failedNodeIds: ['a', 'b'], blocked: ['c', 'd'] }))
  const after = withoutFailed(withoutFailed(before, 'a'), 'b')
  assert.equal(after.failed.size, 0)
  assert.deepEqual([...after.blocked].sort(), ['c', 'd'])
})

// ------------------------------------------------------- 全部功能目录（C 组）
//
// C 组守的是「一张能装下 30 个动作的表还找得到东西」。画布原来把能力分成三处
// （底栏 / 节点工具条 / 右键菜单），每一处只在自己那类动作里给得全——用户想不
// 起「拼接视频」在哪时没有任何地方能问。目录是那个地方，而它只有三件事会坏：
// 搜不到（同义词没写全）、分组乱了（顺序变成字母序）、不可用的项表现不对
// （藏起来 = 用户以为功能不存在）。
//
// 文案走 `translate` 注入：这个文件在 Node 里跑，没有语言环境，也没有 CSS。
// 桩函数把 key 原样返回，于是「搜到」与否只取决于目录数据本身，不取决于字典
// 是否正好翻成了某个词——那样的断言在换一遍翻译之后会无声失效。
const idText = key => key
/** 一张空画布：没有节点、没有选择、没有历史、还没落盘。 */
const blankCanvas = {
  nodeCount: 0, selectedCount: 0, clipboardFilled: false,
  canUndo: false, canRedo: false, savedCanvas: false, composeClips: 0,
}
const fullCanvas = {
  nodeCount: 3, selectedCount: 2, clipboardFilled: true,
  canUndo: true, canRedo: true, savedCanvas: true, composeClips: 2,
}

check('C1 每个动作都归在一个存在的分组里，且 id 不重复', () => {
  const ids = CAPABILITIES.map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length, '目录里有重复的 id，Record 会把其中一条动作覆盖掉')
  for (const entry of CAPABILITIES) {
    assert.ok(CAPABILITY_GROUP_ORDER.includes(entry.group), `${entry.id} 落在未知分组 ${entry.group}`)
  }
})

check('C2 空查询给出的分组顺序就是声明的顺序，且没有空组', () => {
  const sections = capabilitySections(CAPABILITIES, fullCanvas, '', idText)
  const order = sections.map(section => section.group)
  // 顺序比较用「是 CAPABILITY_GROUP_ORDER 的子序列」而不是相等：目录里允许
  // 暂时没有某个分组（比如将来把「帮助」并走），但不允许顺序被打乱。
  const expected = CAPABILITY_GROUP_ORDER.filter(group => order.includes(group))
  assert.deepEqual(order, expected, '分组顺序被打乱了：目录读起来应该按「先造、再跑、再改、再看」')
  assert.ok(sections.every(section => section.items.length > 0), '空分组不该出现在结果里')
})

check('C3 中文同义词能搜到标题里没有的词：接片 / 排版 / 缩略图', () => {
  const byCapability = (query) => capabilitySections(CAPABILITIES, fullCanvas, query, idText)
    .flatMap(section => section.items.map(item => item.entry.id))
  // 这三个词都不在任何标题里，只在 keywords / 说明里。它们是用户真会打的词，
  // 而「搜不到」的后果不是报错，是用户认定这个功能不存在。
  assert.deepEqual(byCapability('接片'), ['run.compose'], '「接片」搜不到拼接，说明同义词没有参与搜索')
  assert.deepEqual(byCapability('排版'), ['edit.arrange'], '「排版」搜不到整理画布')
  assert.deepEqual(byCapability('缩略图'), ['view.minimap'], '「缩略图」搜不到缩略图开关')
})

check('C4 英文与驼峰词也能搜到，且大小写无关', () => {
  const ids = (query) => capabilitySections(CAPABILITIES, fullCanvas, query, idText)
    .flatMap(section => section.items.map(item => item.entry.id))
  assert.deepEqual(ids('FULLSCREEN'), ['view.fullscreen'], '大写输入搜不到全屏：搜索没有统一大小写')
  assert.deepEqual(ids('storyboard'), ['create.storyboard'], '英文同义词搜不到分镜')
  assert.deepEqual(ids('ffmpeg'), ['run.compose'], '英文同义词搜不到拼接')
})

check('C5 多个词是「都要命中」，不是「有一个就行」', () => {
  const ids = (query) => capabilitySections(CAPABILITIES, fullCanvas, query, idText)
    .flatMap(section => section.items.map(item => item.entry.id))
  // 「添加」只在 create 组的标题里，但标题不参与搜索（那是分组头，不是行）。
  // 所以这里选两个真正同属一行的词：图片 + upload。
  assert.deepEqual(ids('图片 upload'), ['create.image'], '两个词都命中同一行时反而搜不到')
  // 一个词命中、另一个词谁都不命中 = 没有结果。这才是「缩小范围」的语义。
  assert.deepEqual(ids('图片 zzzz'), [], '有一个词不命中却仍返回结果：多词成了「或」而不是「与」')
})

check('C6 不可用的项留在结果里，只是排在可用项后面', () => {
  const items = capabilitySections(CAPABILITIES, blankCanvas, '撤销', idText).flatMap(section => section.items)
  assert.equal(items.length, 1, '空画布上搜「撤销」应该有一条灰行；没有就是把它藏起来了')
  assert.equal(items[0].entry.id, 'edit.undo', '搜「撤销」返回的不是撤销')
  // 空画布上「撤销」不可用，但用户必须能看见它、并读到原因。
  assert.equal(items[0].blockedBy, 'canvas.catalog.blockedNoUndo', '撤销在空画布上没说自己为什么不能点')

  // 排序：每个分组内「能点的」整体排在「不能点的」前面。用空画布看全表——它同时
  // 有可用的（添加、视图、帮助）和不可用的（运行、撤销、删除），是同组两种状态
  // 并存的真实场景。空查询比挑一个词更狠：它验证的是默认视图，用户第一眼看到的
  // 就是这一屏。
  const sections = capabilitySections(CAPABILITIES, blankCanvas, '', idText)
  for (const section of sections) {
    // 每组各自计数：排序是分组内的，跨组沿用同一个标志会让第二条分组的第一行
    // 被上一组的灰行污染——这条断言第一次跑起来就是栽在这个变量上。
    let sawBlocked = false
    for (const item of section.items) {
      if (item.blockedBy !== null) sawBlocked = true
      else assert.equal(sawBlocked, false, `${section.group} 组里可用的「${item.entry.id}」排在了灰行后面`)
    }
  }
  assert.ok(
    sections.some(section => section.items.some(item => item.blockedBy !== null)),
    '空画布上总该有不可用的项，否则这条断言什么都没测',
  )
  // 而且一条都不能少：藏起来等于告诉用户「没有这个功能」。
  assert.equal(
    sections.flatMap(section => section.items).length,
    CAPABILITIES.length,
    '不可用的项被藏起来了：用户会以为这个功能不存在',
  )
})

check('C7 ↑↓ 只在可用项之间走，不会停在灰行上', () => {
  // 空画布加一个已保存的画布：能点的只有「新建 / 导入 / 快捷键 / 技能 / 适应全部
  // 内容 / 最小化开关」这几类，而撤销、重做、删除、拼接全都灰。
  const runnable = runnableItems(capabilitySections(CAPABILITIES, { ...blankCanvas, savedCanvas: true }, '', idText))
  assert.ok(runnable.length > 0, '空画布上仍然要有能点的项，否则这个目录等于一块空白')
  assert.ok(runnable.every(item => item.blockedBy === null), '方向键的候选里混进了灰行：按回车会像「没反应」')
  assert.equal(runnable.some(item => item.entry.id === 'edit.undo'), false, '撤销是灰的，方向键不该停上去')
})

check('C8 拼接在只选一段时不可用，两段才亮', () => {
  const blocked = capabilitySections(CAPABILITIES, { ...fullCanvas, composeClips: 1 }, '拼接', idText)[0].items[0]
  assert.equal(blocked.blockedBy, 'canvas.catalog.blockedNeedTwoClips')
  const ready = capabilitySections(CAPABILITIES, fullCanvas, '拼接', idText)[0].items[0]
  assert.equal(ready.blockedBy, null)
})

check('C9 草稿画布上导出与收藏都说明自己要先落盘', () => {
  for (const id of ['canvas.export', 'canvas.favorite']) {
    const item = capabilitySections(CAPABILITIES, blankCanvas, '', idText)
      .flatMap(section => section.items).find(candidate => candidate.entry.id === id)
    assert.equal(item.blockedBy, 'canvas.catalog.blockedDraft', `${id} 在草稿上不该显示为可点`)
  }
})

check('C10 目录里每一行的文案 key 和图标都真的存在', () => {
  for (const entry of CAPABILITIES) {
    assert.ok(entry.labelKey.startsWith('canvas.') || entry.labelKey.startsWith('timeline.'), `${entry.id} 的标题 key 不像本仓库的 key：${entry.labelKey}`)
    assert.ok(entry.hintKey.startsWith('canvas.catalog.hint'), `${entry.id} 的说明必须有自己的 hintKey，复用别处文案会让两件事说同一句话`)
    assert.ok(entry.keywords.length > 0, `${entry.id} 没有同义词，搜不到它的人只能靠标题撞对`)
  }
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

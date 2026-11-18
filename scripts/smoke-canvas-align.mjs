/**
 * 画布「对齐 / 分布」的纯几何契约。
 *
 * WHY 单独一个套件：这些动作的错法都是「看起来差不多」——差三像素的左边、
 * 少算一段空气的等距、只被选中一张卡却被拉散的组。它们不会报错，画布照常
 * 生成，只有用户盯着两张卡觉得哪儿别扭。这里把每一条都钉成具体坐标。
 *
 * 三条最容易回归的：
 *
 *  1. 未选中的节点是**基准**，必须一个像素都不动（唯一的例外是分组的其余
 *     成员跟着整组平移）。
 *  2. 分布按边缘之间的**空隙**算，不是中心距——宽度不一时两者会差出可见的量。
 *  3. 幂等：对已经对齐的图再调一次必须 `moved === 0`，否则一个可以连按的
 *     按钮每按一次都会自己变形。
 *
 * 不测 UI：本模块不碰 React，所以脚本能直接在 Node 里 import `.ts`。
 *
 * Run: node scripts/smoke-canvas-align.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { alignNodes } from '../src/client/canvas/align-model.ts'

/** 几何函数只读这五个字段。 */
const node = (id, x, y, width, height) => ({ id, type: 'image', title: id, x, y, width, height })
const ids = (...values) => new Set(values)

/**
 * 把结果应用到一份副本上，得到「调用方写回画布之后」的完整视图。
 *
 * 断言未选中节点的坐标时看整张图，而不是只看 `positions`——后者本来就不该
 * 包含它们，用「不在表里」当「没动」会漏掉「函数顺手改了输入对象」这种错。
 */
const applied = (nodes, positions) => nodes.map(item => {
  const next = positions.get(item.id)
  return next === undefined ? { ...item } : { ...item, x: next.x, y: next.y }
})

const byId = (nodes, id) => {
  const found = nodes.find(item => item.id === id)
  assert.ok(found !== undefined, `找不到节点 ${id}，测试自己写错了`)
  return found
}

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// ------------------------------------------------------- A1 数量与拒绝条件

check('A1 零个/一个节点对齐返回 too-few；两个节点分布也返回 too-few', () => {
  const one = [node('a', 0, 0, 100, 100)]
  for (const mode of ['left', 'centerH', 'right', 'top', 'centerV', 'bottom']) {
    assert.deepEqual(alignNodes({ nodes: [], selectedIds: ids() }, mode), { ok: false, reason: 'too-few' }, `${mode} 在空画布上应拒绝`)
    assert.deepEqual(alignNodes({ nodes: one, selectedIds: ids('a') }, mode), { ok: false, reason: 'too-few' }, `${mode} 在一个节点上应拒绝`)
  }
  const two = [node('a', 0, 0, 100, 100), node('b', 200, 0, 100, 100)]
  assert.deepEqual(alignNodes({ nodes: two, selectedIds: ids('a', 'b') }, 'distributeH'), { ok: false, reason: 'too-few' }, '两个节点谈不上等间距，分布应拒绝')
  assert.deepEqual(alignNodes({ nodes: two, selectedIds: ids('a', 'b') }, 'distributeV'), { ok: false, reason: 'too-few' })
  assert.equal(alignNodes({ nodes: two, selectedIds: ids('a', 'b') }, 'left').ok, true, '两个节点对齐应当放行——拒绝条件别写反')
})

// --------------------------------------------------- A2 只动被选中的节点

check('A2 三个节点里只选两个：第三个（未选中）坐标逐字节不变', () => {
  const nodes = [node('a', 30, 10, 100, 60), node('b', 260, 80, 40, 20), node('c', -200, -120, 300, 200)]
  for (const mode of ['left', 'centerH', 'right', 'top', 'centerV', 'bottom']) {
    const result = alignNodes({ nodes, selectedIds: ids('a', 'b') }, mode)
    assert.equal(result.ok, true)
    const after = applied(nodes, result.positions)
    assert.deepEqual(byId(after, 'c'), byId(nodes, 'c'), `${mode} 动了未选中的 c`)
    assert.equal(result.positions.has('c'), false, `${mode} 的结果里出现了未选中的 c`)
  }
})

check('A3 未选中的节点同时是基准：它的边缘不决定对齐线', () => {
  // c 是左/上最靠外的那个，但没被选中。选中集合的基准只能是 a 与 b 的极值。
  const nodes = [node('a', 100, 100, 100, 100), node('b', 300, 220, 100, 100), node('c', -500, -400, 100, 100)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'left')
  assert.equal(result.ok, true)
  assert.deepEqual(result.positions.get('a'), { x: 100, y: 100 }, 'left 不该去够未选中的 c')
  assert.deepEqual(result.positions.get('b'), { x: 100, y: 220 })
})

// -------------------------------------------------------- A4 六个对齐语义

check('A4 left/right 对齐到选中集合的最小 x / 最大 x+width', () => {
  const nodes = [node('a', 0, 0, 100, 50), node('b', 50, 30, 200, 80)]
  const left = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'left')
  assert.deepEqual(left.positions.get('a'), { x: 0, y: 0 }, 'left 不应移动已经在基准上的节点')
  assert.deepEqual(left.positions.get('b'), { x: 0, y: 30 }, 'left 应把 b 的左边缘搬到 0')
  assert.equal(left.moved, 1)

  const right = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'right')
  // 最大右边缘 = 50 + 200 = 250；a 的左边缘 = 250 - 100 = 150。
  assert.deepEqual(right.positions.get('a'), { x: 150, y: 0 }, 'right 应按 x+width 对齐，不是按 x')
  assert.deepEqual(right.positions.get('b'), { x: 50, y: 30 })
  assert.equal(right.moved, 1)
})

check('A5 centerH/centerV 对齐节点中心，不是左边缘', () => {
  const nodes = [node('a', 0, 0, 100, 50), node('b', 50, 30, 200, 80)]
  // 包围盒 x ∈ [0, 250]，中心 125；y ∈ [0, 110]，中心 55。
  const centerH = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'centerH')
  assert.deepEqual(centerH.positions.get('a'), { x: 75, y: 0 }, 'a 中心应落在 125')
  assert.deepEqual(centerH.positions.get('b'), { x: 25, y: 30 }, 'b 中心应落在 125')

  const centerV = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'centerV')
  assert.deepEqual(centerV.positions.get('a'), { x: 0, y: 30 }, 'a 中心应落在 55')
  assert.deepEqual(centerV.positions.get('b'), { x: 50, y: 15 }, 'b 中心应落在 55')

  // 按左边缘对齐两者会落在同一个 x；中心对齐时两者必然不同，这条断言就是把
  // 两种实现分开的那一刀。
  assert.notEqual(centerH.positions.get('a').x, centerH.positions.get('b').x, '居中不是左边缘对齐')
})

check('A6 top/bottom 用 y 与 y+height，且不碰 x', () => {
  const nodes = [node('a', 0, 0, 100, 50), node('b', 700, 30, 200, 80)]
  const top = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'top')
  assert.deepEqual(top.positions.get('b'), { x: 700, y: 0 }, 'top 应把 b 的 y 搬到 0，x 原样')
  const bottom = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'bottom')
  // 最大下边缘 = 30 + 80 = 110；a 的 y = 110 - 50 = 60。
  assert.deepEqual(bottom.positions.get('a'), { x: 0, y: 60 }, 'bottom 应按 y+height 对齐')
  assert.deepEqual(bottom.positions.get('b'), { x: 700, y: 30 })
})

// ---------------------------------------------------- A7 分布按空隙、不按中心

check('A7 distributeH：两端不动，中间等间距（空隙相等，误差 0）', () => {
  // 0..100 | 空 120 | 220..320 | 空 120 | 440..540 | 空 120 | 660..760
  const nodes = [node('a', 0, 0, 100, 100), node('b', 60, 0, 100, 100), node('c', 300, 0, 100, 100), node('d', 660, 0, 100, 100)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c', 'd') }, 'distributeH')
  assert.equal(result.ok, true)
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 }, '最左的节点必须不动')
  assert.deepEqual(result.positions.get('d'), { x: 660, y: 0 }, '最右的节点必须不动')
  assert.deepEqual(result.positions.get('b'), { x: 220, y: 0 })
  assert.deepEqual(result.positions.get('c'), { x: 440, y: 0 })

  const after = applied(nodes, result.positions)
  const gap = (left, right) => byId(after, right).x - (byId(after, left).x + byId(after, left).width)
  assert.equal(gap('a', 'b'), 120)
  assert.equal(gap('b', 'c'), 120)
  assert.equal(gap('c', 'd'), 120)
})

check('A8 宽度不一时按空隙等距，而不是按中心等距', () => {
  // 0..40 | b 宽 200 | 400..460：跨度 460，占用 300，两段空隙各 80 → b.x = 120。
  const nodes = [node('a', 0, 0, 40, 40), node('b', 200, 0, 200, 40), node('c', 400, 0, 60, 40)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c') }, 'distributeH')
  assert.equal(result.ok, true)
  assert.deepEqual(result.positions.get('b'), { x: 120, y: 0 }, 'b 应落在 120（边缘贴住 40 与 320）')
  // 按中心等距会得到 x = 130，与空隙等距差 10px——正是这条断言盯的那 10px。
  assert.notEqual(result.positions.get('b').x, 130, '分布算成了中心距')

  const after = applied(nodes, result.positions)
  assert.equal(byId(after, 'b').x - 40, 80, '左段空隙')
  assert.equal(400 - (byId(after, 'b').x + 200), 80, '右段空隙')
})

check('A9 distributeV 同理：上下两端不动，中间等距，横坐标不动', () => {
  const nodes = [node('a', 10, 0, 50, 100), node('b', 10, 150, 50, 100), node('c', 10, 500, 50, 100)]
  // 跨度 600，占用 300，两段空隙各 150 → b.y = 250。
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c') }, 'distributeV')
  assert.deepEqual(result.positions.get('a'), { x: 10, y: 0 })
  assert.deepEqual(result.positions.get('c'), { x: 10, y: 500 })
  assert.deepEqual(result.positions.get('b'), { x: 10, y: 250 })
})

check('A10 分布只动选中的：未选中的节点不参与排序也不被移动', () => {
  const nodes = [node('a', 0, 0, 100, 100), node('b', 60, 0, 100, 100), node('c', 300, 0, 100, 100), node('d', 660, 0, 100, 100)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c') }, 'distributeH')
  // 选中集合是 0..100 / 60..160 / 300..400：跨度 400，占用 300，空隙 50。
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 })
  assert.deepEqual(result.positions.get('b'), { x: 150, y: 0 })
  assert.deepEqual(result.positions.get('c'), { x: 300, y: 0 })
  assert.equal(result.positions.has('d'), false, '未选中的 d 不该出现在结果里')
  assert.deepEqual(byId(applied(nodes, result.positions), 'd'), byId(nodes, 'd'))
})

check('A11 选中节点总宽超过跨度时不硬挤：一个都不动，且第二遍也不动', () => {
  // 三张 100 宽的卡挤在 0..200 里，等间距会是负数。硬挤的写法会把中间的卡推
  // 到最右边那张的左边甚至右边去，第二遍排序换人，按钮按第二次图会变形。
  const nodes = [node('a', 0, 0, 100, 100), node('b', 50, 0, 100, 100), node('c', 100, 0, 100, 100)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c') }, 'distributeH')
  assert.equal(result.ok, true)
  assert.equal(result.moved, 0, '摆不出等距时应保持原样，而不是把卡片叠得更乱')
  for (const [id, point] of result.positions) {
    assert.deepEqual(point, { x: byId(nodes, id).x, y: byId(nodes, id).y }, `${id} 被挪了`)
  }
  const again = alignNodes({ nodes: applied(nodes, result.positions), selectedIds: ids('a', 'b', 'c') }, 'distributeH')
  assert.equal(again.moved, 0)
})

// ------------------------------------------------------------ A12 分组刚体

check('A12 只选中组的一个成员：整组按同一个 delta 平移，组内相对位置逐字节不变', () => {
  const nodes = [
    node('a', 100, 0, 100, 100),
    node('b', 140, 60, 100, 100),
    node('c', 0, 0, 100, 100),
  ]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['a', 'b'] }]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'c'), groups }, 'left')
  assert.equal(result.ok, true)
  // 基准是选中集合的最小 x = 0（c），a 需要左移 100，b 跟着一起左移 100。
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 })
  assert.deepEqual(result.positions.get('b'), { x: 40, y: 60 }, '未选中的同组成员必须跟着动')
  assert.deepEqual(result.positions.get('c'), { x: 0, y: 0 })
  assert.equal(result.moved, 2, 'moved 只数真的变了的：a 与 b')

  const after = applied(nodes, result.positions)
  const dxBefore = byId(nodes, 'b').x - byId(nodes, 'a').x
  const dyBefore = byId(nodes, 'b').y - byId(nodes, 'a').y
  const dxAfter = byId(after, 'b').x - byId(after, 'a').x
  const dyAfter = byId(after, 'b').y - byId(after, 'a').y
  assert.equal(dxAfter, dxBefore, `组内 dx 变了：${dxBefore} → ${dxAfter}`)
  assert.equal(dyAfter, dyBefore, `组内 dy 变了：${dyBefore} → ${dyAfter}`)
})

check('A13 整组成员都被选中：按普通节点处理，各自去够目标', () => {
  const nodes = [node('a', 100, 0, 100, 100), node('b', 300, 60, 100, 100), node('c', 0, 0, 100, 100)]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['a', 'b', 'c'] }]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c'), groups }, 'left')
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 })
  assert.deepEqual(result.positions.get('b'), { x: 0, y: 60 }, '整组选中时 b 应独立对齐，而不是保持与 a 的 200px 间距')
  assert.deepEqual(result.positions.get('c'), { x: 0, y: 0 })
  assert.equal(result.moved, 2)
})

check('A14 只选一个成员时，组内未选中的成员不是对齐基准', () => {
  // b 在 a 左边，是组内最左；但只有 a 被选中，基准取 a 与 c 的极值。
  const nodes = [node('a', 100, 0, 100, 100), node('b', 0, 0, 100, 100), node('c', 300, 0, 100, 100)]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['a', 'b'] }]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'c'), groups }, 'left')
  assert.equal(result.ok, true)
  // 基准是 a 的左边缘 100。若把组里未选中的 b 也算进来，基准会变成 0，a 就
  // 得左移 100——这条断言正是把「组内未选中成员不是基准」钉死的地方。
  assert.deepEqual(result.positions.get('a'), { x: 100, y: 0 }, 'a 已在基准上，不该为了 b 的 0 而移动')
  assert.equal(result.positions.has('b'), false, '这一轮 a 的 delta 是 0，b 也不该出现在结果里')
  assert.deepEqual(result.positions.get('c'), { x: 100, y: 0 }, 'c 应去够 a 的左边缘')
  assert.equal(result.moved, 1)
})

check('A15 组内相对位置在「只选中一个成员」时保持不变（六种模式各一遍）', () => {
  const nodes = [node('a', 100, 40, 100, 100), node('b', 260, 160, 120, 60), node('c', 0, 0, 200, 200)]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['a', 'b'] }]
  for (const mode of ['left', 'centerH', 'right', 'top', 'centerV', 'bottom']) {
    const result = alignNodes({ nodes, selectedIds: ids('a', 'c'), groups }, mode)
    assert.equal(result.ok, true, mode)
    const after = applied(nodes, result.positions)
    assert.equal(
      byId(after, 'b').x - byId(after, 'a').x,
      byId(nodes, 'b').x - byId(nodes, 'a').x,
      `${mode}：组内 dx 被改动了`,
    )
    assert.equal(
      byId(after, 'b').y - byId(after, 'a').y,
      byId(nodes, 'b').y - byId(nodes, 'a').y,
      `${mode}：组内 dy 被改动了`,
    )
  }
})

check('A16 分布时组也是刚体：组内空隙与相对位置不变', () => {
  const nodes = [
    node('a', 0, 0, 100, 100),
    node('b', 300, 0, 100, 100),
    node('u', 420, 200, 80, 80),
    node('c', 800, 0, 100, 100),
  ]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['b', 'u'] }]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c'), groups }, 'distributeH')
  assert.equal(result.ok, true)
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 }, '最左端不动')
  assert.deepEqual(result.positions.get('c'), { x: 800, y: 0 }, '最右端不动')
  // 跨度 900，占用 300，两段空隙各 300 → b 落在 400。
  assert.deepEqual(result.positions.get('b'), { x: 400, y: 0 })
  assert.deepEqual(result.positions.get('u'), { x: 520, y: 200 }, '组内未选中的 u 跟着平移同一个 delta')
  assert.equal(result.moved, 2)
})

check('A17 分布时同组有两个成员被选中：整组仍然只按一个 delta 平移', () => {
  // g1、g2 同组，只有 g1 与另外两端被选中（g2 未被选中）。若把 g1、g2 当成
  // 两个独立的分布对象，g2 会被搬走而 g1 不动，组内 dx 立刻被改掉。
  const nodes = [
    node('a', 0, 0, 100, 100),
    node('b', 400, 0, 100, 100),
    node('g1', 600, 0, 100, 100),
    node('g2', 800, 0, 100, 100),
    node('c', 1200, 0, 100, 100),
  ]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['g1', 'g2'] }]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b', 'g1', 'c'), groups }, 'distributeH')
  assert.equal(result.ok, true)
  assert.deepEqual(result.positions.get('a'), { x: 0, y: 0 })
  assert.deepEqual(result.positions.get('c'), { x: 1200, y: 0 })
  // 三个 unit：0..100、400..500、600..700（g1 在组内，按它自己的盒子量）。
  // 跨度 700，占用 300，两段空隙各 200 → g1 落到 800，g2 跟着 +200 到 1000。
  assert.deepEqual(result.positions.get('g1'), { x: 800, y: 0 })
  assert.deepEqual(result.positions.get('g2'), { x: 1000, y: 0 }, '组内未选中的 g2 必须跟着同一个 delta')
  const after = applied(nodes, result.positions)
  assert.equal(byId(after, 'g2').x - byId(after, 'g1').x, 200, '组内 dx 被改掉了')
})

// ---------------------------------------------------------------- A18 幂等

check('A18 幂等：对已对齐的图再调一次 moved===0 且坐标逐字节相同', () => {
  const nodes = [
    node('a', 0, 0, 100, 50),
    node('b', 50, 30, 200, 80),
    node('c', -40, 90, 60, 40),
    node('d', 300, -70, 120, 30),
  ]
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['c', 'd'] }]
  for (const mode of ['left', 'centerH', 'right', 'top', 'centerV', 'bottom', 'distributeH', 'distributeV']) {
    const first = alignNodes({ nodes, selectedIds: ids('a', 'b', 'c', 'd'), groups }, mode)
    assert.equal(first.ok, true, mode)
    const after = applied(nodes, first.positions)
    const second = alignNodes({ nodes: after, selectedIds: ids('a', 'b', 'c', 'd'), groups }, mode)
    assert.equal(second.ok, true, mode)
    assert.equal(second.moved, 0, `${mode} 第二遍又动了 ${second.moved} 个节点`)
    for (const item of after) {
      assert.deepEqual(second.positions.get(item.id), { x: item.x, y: item.y }, `${mode} 第二遍给出的坐标和现状不同：${item.id}`)
    }
  }
})

// ---------------------------------------------------------------- A19 取整

check('A19 半像素输入：结果都是整数，且按 Math.round 取整', () => {
  const nodes = [node('a', 0.4, 0.6, 100.5, 50.5), node('b', 40.5, 30.5, 60, 40)]
  const result = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'left')
  assert.equal(result.ok, true)
  for (const [id, point] of result.positions) {
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y), `${id} 得到非整数坐标：(${point.x}, ${point.y})`)
  }
  assert.deepEqual(result.positions.get('b'), { x: 0, y: 31 }, '半像素应按 Math.round 归一（30.5 → 31）')
})

// ------------------------------------------------------------ A20 脏输入

check('A20 空选中、不存在的 id、空分组都不崩', () => {
  const nodes = [node('a', 0, 0, 100, 100), node('b', 200, 0, 100, 100)]
  assert.deepEqual(alignNodes({ nodes, selectedIds: ids() }, 'left'), { ok: false, reason: 'too-few' })
  assert.deepEqual(alignNodes({ nodes, selectedIds: ids('ghost') }, 'left'), { ok: false, reason: 'too-few' })
  // 两个真实节点 + 一个幽灵 id：幽灵不能把「两个」凑成「三个」，但真实的两个要能做对齐。
  const ghosted = alignNodes({ nodes, selectedIds: ids('a', 'b', 'ghost') }, 'left')
  assert.equal(ghosted.ok, true)
  assert.equal(ghosted.positions.has('ghost'), false, '不存在的 id 不该出现在结果里')
  assert.deepEqual(ghosted.positions.get('b'), { x: 0, y: 0 })
  assert.deepEqual(alignNodes({ nodes, selectedIds: ids('a', 'b', 'ghost') }, 'distributeH'), { ok: false, reason: 'too-few' }, '两个真实节点仍不足以分布')

  const empty = alignNodes({ nodes, selectedIds: ids('a', 'b'), groups: [] }, 'left')
  assert.equal(empty.ok, true, '空分组数组不该影响结果')
  const orphanGroup = alignNodes({ nodes, selectedIds: ids('a', 'b'), groups: [{ id: 'g', title: '空组', nodeIds: [] }] }, 'left')
  assert.equal(orphanGroup.ok, true, '成员全被删掉的组不该影响结果')
})

check('A21 moved 数的是坐标真的变了的节点（含被组带动的成员）', () => {
  const nodes = [node('a', 0, 0, 100, 100), node('b', 100, 0, 100, 100)]
  const direct = alignNodes({ nodes, selectedIds: ids('a', 'b') }, 'left')
  assert.equal(direct.ok, true)
  assert.equal(direct.moved, 1, 'a 已在 0 上，只有 b 动了')

  // a、b 同组但整组都被选中：两者按普通节点处理，仍然只有 b 需要动。
  const groups = [{ id: 'g', title: '组 1', nodeIds: ['a', 'b'] }]
  const grouped = alignNodes({ nodes, selectedIds: ids('a', 'b'), groups }, 'left')
  assert.equal(grouped.moved, 1, '整组选中时 b 动、a 不动')
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
  console.error(`\ncanvas align: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas align: ${passed} passed`)

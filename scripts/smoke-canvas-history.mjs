/**
 * 「一次撤销」摘要的纯数据契约。
 *
 * WHY 单独一个套件：撤销按钮的 title 是一句承诺——按下去会退掉什么。
 * 这句话错得最安静：界面照样能撤销，只是说错了，用户点下去才发现少了
 * 别的东西。这里逐条钉住判定顺序、nodeIds 的范围与顺序、标题截断，以及
 * 「同样的文档必须得到同样的句子」。
 *
 * 不测 UI：本模块不碰 React，脚本能直接在 Node 里 import `.ts`。
 *
 * Run: node scripts/smoke-canvas-history.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { describeStep, historyRows } from '../src/client/canvas/history-model.ts'

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

/** 最小可用文档；测试只关心 nodes / connections / groups 与少数文档字段。 */
function doc(overrides = {}) {
  return {
    version: 2,
    id: 'canvas-1',
    title: '画布',
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function node(id, overrides = {}) {
  return {
    id,
    type: 'image',
    title: id,
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    ...overrides,
  }
}

function line(id, fromNodeId, toNodeId) {
  return { id, fromNodeId, toNodeId }
}

const ids = step => [...step.nodeIds]
const kind = step => step.kind
const count = step => step.detailValues?.count
const titles = step => step.detailValues?.titles

// --------------------------------------------------------- 判定顺序与连带删除

check('H1 删节点连带删掉两根线：只出一条 remove，nodeIds 不含线 id', () => {
  const keep = node('keep', { x: 600 })
  const gone = node('gone', { x: 300 })
  const before = doc({
    nodes: [keep, gone],
    connections: [line('wire-in', 'keep', 'gone'), line('wire-out', 'gone', 'keep')],
  })
  const after = doc({ nodes: [keep] })
  const step = describeStep(before, after)

  assert.equal(kind(step), 'remove', `删节点应报 remove，实际 ${kind(step)}`)
  assert.equal(count(step), 1, `两条线是同一动作的连带结果，不算第二项；实际 count=${count(step)}`)
  assert.deepEqual(ids(step), ['gone'], `nodeIds 只该有被删的节点，实际 ${JSON.stringify(ids(step))}`)
  assert.ok(!ids(step).includes('wire-in') && !ids(step).includes('wire-out'), '连线 id 混进了 nodeIds')
  assert.equal(titles(step), 'gone', `titles 应是被删节点的标题，实际 ${titles(step)}`)
})

check('H2 新增节点自带一根自动连线：报 add，不报 connect', () => {
  const base = node('base')
  const fresh = node('fresh', { x: 400, title: '生成配置' })
  const step = describeStep(
    doc({ nodes: [base] }),
    doc({ nodes: [base, fresh], connections: [line('auto', 'base', 'fresh')] }),
  )

  assert.equal(kind(step), 'add', `新节点的自动连线不该把一步拆成 mixed；实际 ${kind(step)}`)
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), ['fresh'])
  assert.equal(titles(step), '生成配置')
})

check('H3 只连一根线（两端节点都在）：connect，count 1，nodeIds 为空', () => {
  const a = node('a')
  const b = node('b', { x: 400 })
  const step = describeStep(
    doc({ nodes: [a, b] }),
    doc({ nodes: [a, b], connections: [line('new-wire', 'a', 'b')] }),
  )

  assert.equal(kind(step), 'connect', `实际 ${kind(step)}`)
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), [], `连线的两端节点没有变，不该出现在 nodeIds；实际 ${JSON.stringify(ids(step))}`)
})

check('H4 只删一根线（两端节点都在）：disconnect，count 1，nodeIds 为空', () => {
  const a = node('a')
  const b = node('b', { x: 400 })
  const wire = line('old-wire', 'a', 'b')
  const step = describeStep(
    doc({ nodes: [a, b], connections: [wire] }),
    doc({ nodes: [a, b] }),
  )

  assert.equal(kind(step), 'disconnect', `实际 ${kind(step)}`)
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), [])
})

// ------------------------------------------------------------------- 移动

check('H5 六个节点改了五个坐标：move、count 5，titles 最多三个后接、……', () => {
  const names = ['图一', '图二', '图三', '图四', '图五', '图六']
  const nodes = names.map((title, index) => node(`n${index}`, { title, x: index * 400 }))
  const moved = nodes.map((item, index) => index < 5 ? { ...item, x: item.x + 20 } : item)
  const step = describeStep(doc({ nodes }), doc({ nodes: moved }))

  assert.equal(kind(step), 'move', `实际 ${kind(step)}`)
  assert.equal(count(step), 5, `实际 count=${count(step)}`)
  assert.deepEqual(ids(step), ['n0', 'n1', 'n2', 'n3', 'n4'], 'nodeIds 应按 before 的顺序，且不含没动的 n5')
  assert.equal(titles(step), '图一、图二、图三、……', `实际 ${titles(step)}`)
})

check('H6 只改 width：也算 move（尺寸变化是布局动作）', () => {
  const before = node('a', { width: 320 })
  const step = describeStep(doc({ nodes: [before] }), doc({ nodes: [{ ...before, width: 360 }] }))

  assert.equal(kind(step), 'move')
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), ['a'])
})

// ------------------------------------------------------------------- 编辑

check('H7 只改 metadata.poster：edit', () => {
  const before = node('a', { metadata: { status: 'success' } })
  const after = { ...before, metadata: { status: 'success', poster: { width: 512, height: 512, layers: [] } } }
  const step = describeStep(doc({ nodes: [before] }), doc({ nodes: [after] }))

  assert.equal(kind(step), 'edit', `实际 ${kind(step)}`)
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), ['a'])
})

check('H8 改节点标题算 edit，改画布标题才算 title', () => {
  const before = node('a', { title: '旧名字' })
  const nodeStep = describeStep(doc({ nodes: [before] }), doc({ nodes: [{ ...before, title: '新名字' }] }))
  const docStep = describeStep(doc({ title: '旧画布' }), doc({ title: '新画布' }))

  assert.equal(kind(nodeStep), 'edit', '节点改名是对节点内容的编辑，不是画布标题')
  assert.deepEqual(ids(nodeStep), ['a'])
  assert.equal(titles(nodeStep), '新名字', 'titles 应用用户此刻看到的新标题')
  assert.equal(kind(docStep), 'title', `实际 ${kind(docStep)}`)
  assert.deepEqual(ids(docStep), [])
})

check('H9 metadata 键顺序不同不算变化', () => {
  const before = node('a', { metadata: { prompt: '猫', status: 'idle' } })
  const after = node('a', { metadata: { status: 'idle', prompt: '猫' } })
  const step = describeStep(doc({ nodes: [before] }), doc({ nodes: [after] }))

  assert.equal(kind(step), 'mixed')
  assert.deepEqual(ids(step), [])
})

// ------------------------------------------------------- 背景 / 视口 / 空操作

check('H10 只改 background：background，nodeIds 为空', () => {
  const step = describeStep(doc({ background: 'dots' }), doc({ background: 'galaxy' }))

  assert.equal(kind(step), 'background', `实际 ${kind(step)}`)
  assert.deepEqual(ids(step), [])
})

check('H11 只改 viewport：mixed 且 nodeIds 为空（不说成改了节点）', () => {
  const step = describeStep(doc(), doc({ viewport: { x: 120, y: -40, k: 1.4 } }))

  assert.equal(kind(step), 'mixed', `实际 ${kind(step)}`)
  assert.deepEqual(ids(step), [], `视口变化不该带出节点 id；实际 ${JSON.stringify(ids(step))}`)
})

check('H12 前后完全相同：mixed + nodeIds []（调用方可拒绝压栈）', () => {
  const before = doc({ nodes: [node('a')], connections: [line('w', 'a', 'a')] })
  const step = describeStep(before, structuredClone(before))

  assert.equal(kind(step), 'mixed')
  assert.deepEqual(ids(step), [])
  assert.equal(count(step), 0)
})

// ------------------------------------------------------------- 多种变化合并

check('H13 移动一个节点 + 编辑另一个：mixed，nodeIds 两个、不重复', () => {
  const a = node('a', { title: '图片节点' })
  const b = node('b', { title: '生成配置', metadata: { status: 'idle' } })
  const step = describeStep(
    doc({ nodes: [a, b] }),
    doc({ nodes: [{ ...a, x: 40 }, { ...b, metadata: { status: 'success' } }] }),
  )

  assert.equal(kind(step), 'mixed', `实际 ${kind(step)}`)
  assert.deepEqual(ids(step), ['a', 'b'], '两个独立改动都要点名，且每个只出现一次')
  assert.equal(count(step), 2)
})

check('H14 同一个节点既移动又改 metadata：报 move，nodeIds 只出现一次', () => {
  const before = node('a', { metadata: { status: 'idle' } })
  const after = { ...before, x: 88, metadata: { status: 'success' } }
  const step = describeStep(doc({ nodes: [before] }), doc({ nodes: [after] }))

  assert.equal(kind(step), 'move', `拖动是主动作；实际 ${kind(step)}`)
  assert.deepEqual(ids(step), ['a'], `nodeIds 重复了：${JSON.stringify(ids(step))}`)
  assert.equal(count(step), 1)
})

check('H15 改画布标题 + 改背景：mixed、count 2', () => {
  const step = describeStep(doc({ title: '旧', background: 'dots' }), doc({ title: '新', background: 'lines' }))

  assert.equal(kind(step), 'mixed')
  assert.equal(count(step), 2, `两项独立的文档字段改动；实际 ${count(step)}`)
  assert.deepEqual(ids(step), [])
})

check('H16 新建分组：group，nodeIds 为空（节点本身没变）', () => {
  const a = node('a')
  const b = node('b', { x: 400 })
  const step = describeStep(
    doc({ nodes: [a, b] }),
    doc({ nodes: [a, b], groups: [{ id: 'g1', title: '一组', nodeIds: ['a', 'b'] }] }),
  )

  assert.equal(kind(step), 'group', `实际 ${kind(step)}`)
  assert.equal(count(step), 1)
  assert.deepEqual(ids(step), [])
})

// ----------------------------------------------------------------- 标题截断

check('H17 空标题退回 id 前 6 位；超长标题本身不截断', () => {
  const empty = node('abcdef-123', { title: '', x: 0 })
  const long = node('long-1', { title: '一个非常非常长的节点标题不会被腰斩', x: 400 })
  const step = describeStep(doc({ nodes: [empty, long] }), doc({ nodes: [{ ...empty, x: 10 }, { ...long, x: 410 }] }))

  assert.equal(titles(step), 'abcdef、一个非常非常长的节点标题不会被腰斩',
    `空标题应退回 id 前 6 位，长标题应完整保留；实际 ${titles(step)}`)
})

// --------------------------------------------------------------- 稳定性

check('H18 同一对文档调两次逐字节相同', () => {
  const before = doc({ nodes: [node('a'), node('b', { x: 400 })] })
  const after = doc({ nodes: [node('b', { x: 440 }), node('a', { title: '改过' })] })
  const first = JSON.stringify(describeStep(before, after))
  const second = JSON.stringify(describeStep(before, after))

  assert.equal(first, second, `两次结果不同：\n${first}\n${second}`)
})

check('H19 节点数组顺序不同、内容相同：结果与不重排一致', () => {
  const a = node('a')
  const b = node('b', { x: 400 })
  const c = node('c', { x: 800 })
  const straight = describeStep(doc({ nodes: [a, b, c] }), doc({ nodes: [a, b, c] }))
  const shuffled = describeStep(doc({ nodes: [c, a, b] }), doc({ nodes: [b, c, a] }))

  assert.equal(JSON.stringify(shuffled), JSON.stringify(straight),
    '按下标比较会把纯重排误报成改动')
  assert.deepEqual(ids(shuffled), [])
})

// --------------------------------------------------- H20 历史面板的数据

/** 把一叠文档折成快照栈：`past` 里每一条都是「那一步之前」的状态。 */
const stackOf = (...documents) => documents.map(item => JSON.stringify(item))

check('H20 historyRows：最新一步在最上面，stepsBack 从 1 递增', () => {
  const a = doc({ nodes: [node('a', { title: '图一' })] })
  const b = doc({ nodes: [node('a', { title: '图一' }), node('b', { title: '图二', x: 400 })] })
  const c = doc({ nodes: [node('a', { title: '图一', x: 50 }), node('b', { title: '图二', x: 400 })] })
  // 栈：a（加 b 之前）→ b（移动 a 之前）；当前是 c。
  const rows = historyRows(stackOf(a, b), c)

  assert.equal(rows.length, 2, `两步历史应给两行，实际 ${rows.length}`)
  assert.deepEqual(rows.map(row => row.stepsBack), [1, 2], 'stepsBack 应从最新一步的 1 开始递增')
  assert.equal(rows[0].kind, 'move', `最上面一行是最近一步（移动），实际 ${rows[0].kind}`)
  assert.equal(rows[1].kind, 'add', `再往下是加节点，实际 ${rows[1].kind}`)
  assert.deepEqual([...rows[0].nodeIds], ['a'])
  assert.deepEqual([...rows[1].nodeIds], ['b'])
})

check('H21 historyRows：空栈、null 文档、limit 都按约定', () => {
  assert.deepEqual(historyRows([], null), [], '没有文档时没有历史')
  assert.deepEqual(historyRows([], doc({ nodes: [node('a')] })), [], '没有快照时没有历史')
  const a = doc()
  const b = doc({ nodes: [node('x', { x: 10 })] })
  const c = doc({ nodes: [node('x', { x: 20 })] })
  const d = doc({ nodes: [node('x', { x: 30 })] })
  const rows = historyRows(stackOf(a, b, c), d, 2)
  assert.equal(rows.length, 2, 'limit 应截断，而不是被忽略')
  assert.deepEqual(rows.map(row => row.stepsBack), [1, 2], '截断取最近的几步，不是最旧的')
})

check('H22 historyRows：坏快照截断，不跳过一个继续往下数', () => {
  const a = doc({ nodes: [node('a')] })
  const b = doc({ nodes: [node('a'), node('b', { x: 400 })] })
  const rows = historyRows([JSON.stringify(a), '{ 这不是 JSON', JSON.stringify(b)], doc({ nodes: [node('a', { x: 90 })] }))

  // 坏的那条在中间：只能在它之前停下。若跳过它继续数，stepsBack 会比真实栈深
  // 少一格，点一行就退错步。
  assert.equal(rows.length, 1, `坏快照之后的行不能再数，实际给了 ${rows.length} 行`)
  assert.equal(rows[0].stepsBack, 1, `截断后保留的那一行仍应是「退一步」，实际 ${rows[0].stepsBack}`)
})

check('H23 historyRows：只动视口的一步不进列表', () => {
  const a = doc({ nodes: [node('a')] })
  const b = doc({ nodes: [node('a')], viewport: { x: 80, y: 0, k: 1 } })
  assert.deepEqual(historyRows(stackOf(a), b), [], '只有视口变化的一步不该显示成一行历史')
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
  console.error(`\ncanvas history model: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas history model: ${passed} passed`)

/**
 * 画布叠放顺序（`layer-order.ts`）的契约。
 *
 * WHY 单独一套：错法全是「看不出错」——置顶三张卡时它们的内部顺序被悄悄
 * 调转、选中的组上移一层时被打散成三个高度、已经最上面那张再置顶一次却
 * 在撤销栈里留一条空步骤。这三种都不是崩溃，只是用户每次叠放都觉得这个
 * 按钮「不太听话」，然后不再用它。
 *
 * 本模块不碰 React / DOM，直接从源码 import。
 *
 * Run: node scripts/smoke-canvas-layers.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { reorderLayers } from '../src/client/canvas/layer-order.ts'

/** 顺序测试只关心 id 与位置。 */
const node = id => ({ id, type: 'image', title: id, x: 0, y: 0, width: 100, height: 100 })
const ids = (...values) => new Set(values)
const order = nodes => nodes.map(item => item.id)

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// 数组末尾在最上面，这是整个模块的前提；写死在每个用例的期望里。
const STACK = ['a', 'b', 'c', 'd'].map(node)

// ------------------------------------------------------------ L1 置顶 / 置底

check('L1 置顶把整组搬到末尾，组内顺序保持不变', () => {
  const result = reorderLayers(STACK, ids('a', 'c'), 'front')
  assert.equal(result.moved, true)
  // a 与 c 的相对顺序必须是 a 在前：用户摆出来的前后关系不该被「置顶」改掉。
  assert.deepEqual(order(result.nodes), ['b', 'd', 'a', 'c'])
})

check('L2 置底把整组搬到开头，组内顺序保持不变', () => {
  const result = reorderLayers(STACK, ids('b', 'd'), 'back')
  assert.equal(result.moved, true)
  assert.deepEqual(order(result.nodes), ['b', 'd', 'a', 'c'])
})

check('L3 置顶一张已经在最上面的卡：不动，也不报变了', () => {
  const result = reorderLayers(STACK, ids('d'), 'front')
  assert.equal(result.moved, false, '已经在最上面，置顶不该留一条撤销')
  assert.equal(result.nodes, STACK, '没变时应原样返回入参，而不是造一份等值的新数组')
})

check('L4 置底一张已经在最底下的卡：不动', () => {
  const result = reorderLayers(STACK, ids('a'), 'back')
  assert.equal(result.moved, false)
})

// ------------------------------------------------------ L5 / L6 上移 / 下移一层

check('L5 上移一层：整组跨过紧邻上面的那一张，不是各自跨一张', () => {
  // 选 b、c（下标 1、2），紧贴在上面的是 d。整组应当移到 d 上面，
  // 顺序变成 a、d、b、c —— 而不是 b 跨过 c、c 跨过 d 那种散开的形态。
  const result = reorderLayers(STACK, ids('b', 'c'), 'forward')
  assert.equal(result.moved, true)
  assert.deepEqual(order(result.nodes), ['a', 'd', 'b', 'c'])
})

check('L6 下移一层：整组跨过紧邻下面的那一张', () => {
  const result = reorderLayers(STACK, ids('b', 'c'), 'backward')
  assert.equal(result.moved, true)
  assert.deepEqual(order(result.nodes), ['b', 'c', 'a', 'd'])
})

check('L7 已在最上面再上移、已在最下面再下移：不动', () => {
  assert.equal(reorderLayers(STACK, ids('d'), 'forward').moved, false, '最上面那张不能继续上移')
  assert.equal(reorderLayers(STACK, ids('a'), 'backward').moved, false, '最底下那张不能继续下移')
})

check('L8 选中的卡分散在两端时，上移仍按整组算', () => {
  // a 在最底、d 在最顶。整组槽位出现在 a 的位置（第一处），所以「上移一层」
  // 是跨过 b，得到 b、a、d、c 之外的形态——关键是 a 与 d 之间的相对顺序不变。
  const result = reorderLayers(STACK, ids('a', 'd'), 'forward')
  assert.equal(result.moved, true)
  assert.deepEqual(order(result.nodes), ['b', 'a', 'd', 'c'])
})

// --------------------------------------------------------------- L9 拒绝条件

check('L9 空选择、全选、零/一个节点都是空操作', () => {
  const none = reorderLayers(STACK, ids(), 'front')
  assert.equal(none.moved, false)
  assert.equal(none.nodes, STACK)
  for (const mode of ['front', 'back', 'forward', 'backward']) {
    const all = reorderLayers(STACK, ids('a', 'b', 'c', 'd'), mode)
    assert.equal(all.moved, false, `全选时 ${mode} 没有可跨过的对象，不该动`)
    assert.equal(all.nodes, STACK)
    assert.equal(reorderLayers([], ids('a'), mode).moved, false)
    assert.equal(reorderLayers([node('a')], ids('a'), mode).moved, false)
  }
})

// ------------------------------------------------------------ L10 幂等与稳定

check('L10 连续两次置顶与一次置顶结果相同', () => {
  const once = reorderLayers(STACK, ids('a', 'c'), 'front')
  const twice = reorderLayers(once.nodes, ids('a', 'c'), 'front')
  assert.deepEqual(order(twice.nodes), order(once.nodes))
  assert.equal(twice.moved, false, '第二次置顶什么都没改，不该再写一次文档')
})

check('L11 上移一层再下移一层回到原样', () => {
  const up = reorderLayers(STACK, ids('b', 'c'), 'forward')
  const down = reorderLayers(up.nodes, ids('b', 'c'), 'backward')
  assert.deepEqual(order(down.nodes), order(STACK))
})

check('L12 结果里的每一项都来自入参（不复制、不丢字段）', () => {
  const withMeta = [
    { ...node('a'), metadata: { prompt: '甲' } },
    { ...node('b'), metadata: { prompt: '乙' } },
    { ...node('c') },
  ]
  const result = reorderLayers(withMeta, ids('a'), 'front')
  // 引用相等：调用方按 id 建过 Map 的话，复制出的新对象会让那些 Map 失配。
  assert.equal(result.nodes[result.nodes.length - 1], withMeta[0], '移动过的节点应原样引用，不是浅拷贝')
  assert.deepEqual(result.nodes.find(item => item.id === 'a').metadata, { prompt: '甲' })
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
  console.error(`\ncanvas layers: ${failed} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\ncanvas layers: ${passed} passed`)
}

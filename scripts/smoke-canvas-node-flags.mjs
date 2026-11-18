/**
 * 画布「锁定 / 隐藏」（`node-flags.ts`）的契约。
 *
 * WHY 单独一套：这两个开关错起来全是「看不出错」——隐藏的卡还能被框选、
 * 锁定的卡被一次框选拖动悄悄挪了位置、删掉节点后留下一条通往空气的线。
 * 都不会抛异常，只会让用户觉得「这个开关有时候不灵」。所以这里钉的不是
 * 「大概过滤了」，而是引用相等、顺序、以及节点与连线**合起来**的结果。
 *
 * 本模块不碰 React / DOM，直接从源码 import。
 *
 * Run: node scripts/smoke-canvas-node-flags.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import {
  hiddenCount,
  isHidden,
  isLocked,
  unlockedIds,
  visibleConnections,
  visibleNodes,
  withoutFlags,
} from '../src/client/canvas/node-flags.ts'
import { cloneNodesWithCards } from '../src/client/canvas/node-model.ts'

/** 只给这些函数读的字段；画布默认尺寸，避免每处都写一遍。 */
const node = (id, metadata) => ({
  id,
  type: 'image',
  title: id,
  x: 0,
  y: 0,
  width: 240,
  height: 240,
  ...(metadata === undefined ? {} : { metadata }),
})
const ids = (...values) => new Set(values)
const order = nodes => nodes.map(item => item.id)
const link = (fromNodeId, toNodeId) => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId })

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// ------------------------------------------------------------------- F1 读取

check('F1 isLocked / isHidden 只认严格的 true：缺 metadata 与 false 都算「没开」', () => {
  // 老文档没有 metadata、导出工具可能写回 locked: false。这两种都必须是
  // 「没锁」——把它们读成锁定会让一批卡在打开后突然拖不动，且找不到地方解。
  for (const bare of [node('bare'), node('empty', {}), node('false', { locked: false, hidden: false })]) {
    assert.equal(isLocked(bare), false, `${bare.id} 被读成锁定了`)
    assert.equal(isHidden(bare), false, `${bare.id} 被读成隐藏了`)
  }
  const on = node('on', { locked: true, hidden: true })
  assert.equal(isLocked(on), true)
  assert.equal(isHidden(on), true)
})

// ------------------------------------------------------- F2 / F3 visibleNodes

check('F2 visibleNodes 全部可见时返回同一个数组引用，而不是长得像的新数组', () => {
  // 调用方靠引用相等跳过重算 / 跳过写文档；等值的新数组会让每次拖动都以为
  // 「画面变了」，撤销栈和 memo 都会跟着抖。
  const nodes = ['a', 'b', 'c'].map(id => node(id))
  assert.equal(visibleNodes(nodes), nodes, '没有隐藏项时应原样返回入参')
})

check('F3 visibleNodes 去掉隐藏的、保留顺序，未隐藏的节点对象引用不变', () => {
  // 顺序就是叠放顺序（末尾在最上面），过滤时必须保持；对象引用不变是因为
  // 调用方会按引用缓存测量结果 / 拿引用当 key。
  const a = node('a')
  const b = node('b', { hidden: true })
  const c = node('c')
  const d = node('d', { locked: true })
  const visible = visibleNodes([a, b, c, d])
  assert.deepEqual(order(visible), ['a', 'c', 'd'])
  assert.equal(visible[0], a)
  assert.equal(visible[1], c, '没隐藏的节点不能被浅拷贝')
  assert.equal(visible[2], d, '锁定不影响可见性')
})

// -------------------------------------------------------- F4 / F5 / F6 unlocked

const MIXED = [
  node('a'),
  node('b', { locked: true }),
  node('c'),
  node('d', { locked: true }),
]

check('F4 unlockedIds 在没有锁定项时返回入参本身', () => {
  // 原样返回让调用方能靠引用相等判断「这次拖动/删除不需要任何过滤」，
  // 也避免每一帧都分配一个新 Set。
  const selected = ids('a', 'c')
  assert.equal(unlockedIds([node('a'), node('c')], selected), selected)
})

check('F5 unlockedIds 剔除锁定的，且不修改入参 Set', () => {
  // 入参 Set 常常就是 React state 里的选中集；就地删掉会绕过 setState，
  // 界面上仍然显示「已选 4 项」，实际只剩 2 项。
  const selected = ids('a', 'b', 'c', 'd')
  const snapshot = [...selected]
  const allowed = unlockedIds(MIXED, selected)
  assert.deepEqual([...allowed].sort(), ['a', 'c'])
  assert.deepEqual([...selected].sort(), snapshot, '入参 Set 被改动了')
  assert.notEqual(allowed, selected)
})

check('F6 unlockedIds 对不存在的 id 宽容：不报错，也不凭空添加 id', () => {
  // 选中集里可能残留一张刚从别处删掉的卡。这里如果因为找不到节点而抛，
  // 一次删除就会连带动不了其它卡。这一层只做「剔除锁定」，既不该添加
  // 入参之外的 id（下面的 `extra`），也不该替调用方清理残留——入参里本来
  // 就有的 ghost 原样留着，由知道删除上下文的调用方决定何时清。
  assert.doesNotThrow(() => unlockedIds(MIXED, ids('ghost')), '不存在的 id 让过滤整条抛了')
  const withGhost = ids('a', 'ghost')
  assert.equal(unlockedIds(MIXED, withGhost), withGhost, '没有锁定项时仍应原样返回入参')

  const extra = [...unlockedIds(MIXED, ids('a'))].filter(id => id !== 'a')
  assert.deepEqual(extra, [], '入参之外的 id 被凭空加进了结果')
  // 走到真正的剔除分支时同样只删不加：b 被剔掉，ghost 与 a 都留着。
  assert.deepEqual([...unlockedIds(MIXED, ids('a', 'b', 'ghost'))].sort(), ['a', 'ghost'])
})

// -------------------------------------------------------------- F7 hiddenCount

check('F7 hiddenCount 数得对，包括全部隐藏与一张都没藏', () => {
  // 底部提示「N 张卡片已隐藏」是用户找回卡片的唯一线索，差一就找不到。
  assert.equal(hiddenCount([]), 0)
  assert.equal(hiddenCount(['a', 'b'].map(id => node(id))), 0)
  assert.equal(hiddenCount([node('a', { hidden: true }), node('b'), node('c', { hidden: true })]), 2)
  assert.equal(hiddenCount(['a', 'b', 'c'].map(id => node(id, { hidden: true }))), 3)
})

// ------------------------------------------------------- F8–F13 connections

const THREE = [node('a'), node('b'), node('c')]
const AB = link('a', 'b')

check('F8 visibleConnections 两端都可见时保留', () => {
  const links = [AB, link('b', 'c')]
  assert.deepEqual(visibleConnections(links, THREE), links)
})

check('F9 visibleConnections 起点隐藏 → 丢弃', () => {
  // 起点藏了，线的这一端就没有落点；保留它会在画布上画出一截悬空的线。
  const nodes = [node('a', { hidden: true }), node('b'), node('c')]
  assert.deepEqual(visibleConnections([AB, link('b', 'c')], nodes).map(item => item.id), ['b->c'])
})

check('F10 visibleConnections 终点隐藏 → 丢弃', () => {
  const nodes = [node('a'), node('b', { hidden: true }), node('c')]
  assert.deepEqual(visibleConnections([AB, link('b', 'c')], nodes), [])
})

check('F11 visibleConnections 两端都隐藏 → 丢弃', () => {
  const nodes = [node('a', { hidden: true }), node('b', { hidden: true }), node('c')]
  assert.deepEqual(visibleConnections([AB, link('c', 'b')], nodes), [])
})

check('F12 visibleConnections 指向已不存在的节点 → 丢弃（靶子没了也算不可见）', () => {
  // 删除总会经历「节点先没了、连线还没清理」的中间态。渲染这一层必须与
  // 隐藏同样对待，否则每次删除都会在画面上留一条通往空气的线。
  const nodes = [node('a')]
  assert.deepEqual(visibleConnections([AB, link('a', 'gone')], nodes), [])
})

check('F13 visibleConnections 没有变化时返回入参本身', () => {
  const links = [AB, link('b', 'c')]
  assert.equal(visibleConnections(links, THREE), links, '全部可画时应原样返回入参')
})

// ------------------------------------------------------------------- F14 组合

check('F14 隐藏一张卡后，节点与连线一起过滤：画布上既没有那张卡也没有通往它的线', () => {
  // 两个函数各自都对、合起来错，正是这类模块最坏的形态：卡片消失了，线还
  // 连着它原来的位置。这条把两者的契约钉在一起。
  const a = node('a')
  const b = node('b', { hidden: true })
  const c = node('c')
  const nodes = [a, b, c]
  const links = [link('a', 'b'), link('b', 'c'), link('a', 'c')]

  const visible = visibleNodes(nodes)
  const drawn = visibleConnections(links, visible)

  assert.deepEqual(order(visible), ['a', 'c'])
  assert.deepEqual(drawn.map(item => item.id), ['a->c'], '还有线连着被藏起来的 b')
  // 隐藏的节点仍在文档里：它只是不上画面，不是被删了。
  assert.equal(nodes.length, 3)
  assert.equal(hiddenCount(nodes), 1)
})

check('F15 复制粘贴时清掉锁定与隐藏，其余 metadata 一字不动', () => {
  // 复制一张锁住的卡，用户想要的是「再来一份能动的」；照抄会让新卡一出现就拖
  // 不动，而复制一张隐藏的卡更糟——粘贴完屏幕上什么都没有，像粘贴失败。
  const source = { ...node('a'), metadata: { locked: true, hidden: true, prompt: '樱花', fontSize: 14 } }
  const copied = withoutFlags(source.metadata)
  assert.deepEqual(copied, { prompt: '樱花', fontSize: 14 }, '两个标记必须消失，其余字段必须原样')
  // 没有任何标记时返回同一个对象：这条路径每次粘贴都要走一遍，多分配一份
  // 等值的对象只会让下游的引用比较失去意义。
  const plain = { prompt: '樱花' }
  assert.equal(withoutFlags(plain), plain, '没有标记时不该复制 metadata')
  assert.equal(withoutFlags(undefined), undefined, '没有 metadata 的节点粘贴出来也没有')
})

check('F16 真正的复制路径（cloneNodesWithCards）也清标记，且不动源节点', () => {
  // F15 只钉了 `withoutFlags` 这个函数本身。它写对了却没人调用，是最容易发生的
  // 事——所以这里走一遍生产路径，钉住「接线」而不只是「实现」。
  const source = { ...node('a'), metadata: { locked: true, hidden: true, prompt: '樱花' } }
  const { clones } = cloneNodesWithCards([source], [source], 40, 40)
  assert.equal(clones.length, 1)
  assert.deepEqual(clones[0].metadata, { prompt: '樱花' }, '副本不该继承锁定/隐藏')
  assert.equal(isLocked(clones[0]), false)
  assert.equal(isHidden(clones[0]), false)
  // 源卡一个字都不能变：清标记是给副本的，不是给原件的。
  assert.deepEqual(source.metadata, { locked: true, hidden: true, prompt: '樱花' })
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
  console.error(`\ncanvas node flags: ${failed} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\ncanvas node flags: ${passed} passed`)
}

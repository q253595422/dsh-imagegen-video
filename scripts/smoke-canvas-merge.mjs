/**
 * 多窗口同时编辑同一张画布时的合并。
 *
 * 这个模块的失败方式全都是「不报错的坏」：合并结果是可用的文档、保存也成功、
 * 界面显示「已保存」，只是另一个窗口那一笔改动没了。所以用例必须钉具体结果——
 * 哪个 id 还在、落在什么坐标、标题是谁的——而不是只断言「没抛异常」。
 *
 * 场景取自真实创作：两边各加一张卡、一边拖动一边改标题、一边删卡另一边连线、
 * 两边改同一张卡的同一个字段（这一条必须报冲突而不是挑一边）。
 *
 * Run: node scripts/smoke-canvas-merge.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import { mergeCanvasDocuments } from '../src/client/canvas/canvas-merge.ts'

const results = []
const check = createCheckHarness({ results })

const node = (id, x, y, title = id) => ({
  id, type: 'text', title, x, y, width: 240, height: 160,
})

/** 一张干净的三份文档，节点 id 依次是 a/b/c。 */
const base = () => ({
  version: 2,
  id: 'canvas-1',
  title: '橘猫短片',
  revision: 4,
  viewport: { x: 0, y: 0, k: 0.5 },
  background: 'dots',
  nodes: [node('a', 0, 0), node('b', 300, 0), node('c', 600, 0)],
  connections: [{ id: 'w1', fromNodeId: 'a', toNodeId: 'b' }],
  createdAt: 1,
  updatedAt: 1,
})

/** 基于 base 的一份副本，改哪写哪。 */
const copy = (overrides = {}) => ({ ...base(), ...overrides })

const ids = (document) => document.nodes.map(item => item.id)
const byId = (document, id) => document.nodes.find(item => item.id === id)

// ---------------------------------------------------------------- 无改动

await check('M1 两边都没动 → 结果和本地完全一致，并且不算「保留了对方的改动」', () => {
  const outcome = mergeCanvasDocuments(base(), base(), base())
  assert.equal(outcome.ok, true)
  assert.deepEqual(ids(outcome.document), ['a', 'b', 'c'])
  assert.deepEqual(outcome.applied.addedNodes, [])
  assert.deepEqual(outcome.applied.changedNodes, [])
  assert.equal(outcome.applied.adoptedTitle, false)
})

// ------------------------------------------------------------ 各自新增

await check('M2 两边各加一张卡 → 两张都在，顺序是本地的在前', () => {
  const ours = copy({ nodes: [...base().nodes, node('mine', 900, 0)] })
  const theirs = copy({ nodes: [...base().nodes, node('theirs', 1200, 0)] })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, true)
  assert.deepEqual(ids(outcome.document), ['a', 'b', 'c', 'mine', 'theirs'])
  assert.deepEqual(outcome.applied.addedNodes, ['theirs'])
  // 本地新增的不算「替用户保住了什么」——那张卡一直在他眼前。
  assert.equal(outcome.applied.addedNodes.includes('mine'), false)
})

// ---------------------------------------------------- 一方改、另一方没改

await check('M3 对方拖了一张卡、本地没碰 → 用对方的位置', () => {
  const theirs = copy({ nodes: [node('a', 0, 0), node('b', 640, 480), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.equal(byId(outcome.document, 'b').x, 640)
  assert.equal(byId(outcome.document, 'b').y, 480)
  assert.deepEqual(outcome.applied.changedNodes, ['b'])
})

await check('M4 本地拖了一张卡、对方没碰 → 保留本地位置，且不出现在「保留了对方改动」里', () => {
  const ours = copy({ nodes: [node('a', 0, 0), node('b', 120, 40), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), ours, base())
  assert.equal(outcome.ok, true)
  assert.equal(byId(outcome.document, 'b').x, 120)
  assert.deepEqual(outcome.applied.changedNodes, [])
})

await check('M5 两边把同一张卡拖到同一个位置 → 算一致，不报冲突', () => {
  const moved = [node('a', 0, 0), node('b', 500, 500), node('c', 600, 0)]
  const outcome = mergeCanvasDocuments(base(), copy({ nodes: moved }), copy({ nodes: moved }))
  assert.equal(outcome.ok, true)
  assert.equal(byId(outcome.document, 'b').x, 500)
})

// -------------------------------------------------------------- 删除

await check('M6 对方删掉一张卡、本地没碰 → 跟着删，并记下删了哪张', () => {
  const theirs = copy({ nodes: [node('a', 0, 0), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.deepEqual(ids(outcome.document), ['a', 'c'])
  assert.deepEqual(outcome.applied.removedNodes, ['b'])
})

await check('M7 本地删、对方没碰 → 保持删除，不因为对方那份还在就把它复活', () => {
  const ours = copy({ nodes: [node('a', 0, 0), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), ours, base())
  assert.equal(outcome.ok, true)
  assert.deepEqual(ids(outcome.document), ['a', 'c'])
})

await check('M8 本地删了、对方改了同一张 → 报冲突而不是猜', () => {
  const ours = copy({ nodes: [node('a', 0, 0), node('c', 600, 0)] })
  const theirs = copy({ nodes: [node('a', 0, 0), node('b', 999, 999), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.conflicts.length, 1)
  assert.equal(outcome.conflicts[0].id, 'b')
  assert.equal(outcome.conflicts[0].kind, 'node')
})

await check('M9 两边把同一张卡改成不同位置 → 报冲突，不静默挑一边', () => {
  const ours = copy({ nodes: [node('a', 0, 0), node('b', 100, 100), node('c', 600, 0)] })
  const theirs = copy({ nodes: [node('a', 0, 0), node('b', 200, 200), node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.conflicts[0].id, 'b')
  // 提示里要能点名：拿 title 给用户看，而不是拿 id。
  assert.equal(outcome.conflicts[0].subject, 'b')
})

// ---------------------------------------------------------------- 连线

await check('M10 两边各连一条线 → 两条都在', () => {
  const ours = copy({
    connections: [
      { id: 'w1', fromNodeId: 'a', toNodeId: 'b' },
      { id: 'w2', fromNodeId: 'b', toNodeId: 'c' },
    ],
  })
  const theirs = copy({
    connections: [
      { id: 'w1', fromNodeId: 'a', toNodeId: 'b' },
      { id: 'w3', fromNodeId: 'a', toNodeId: 'c' },
    ],
  })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, true)
  const ids = outcome.document.connections.map(item => item.id)
  assert.deepEqual(ids, ['w1', 'w2', 'w3'])
  assert.deepEqual(outcome.applied.addedConnections, ['w3'])
})

await check('M11 对方删了一条线、本地没碰 → 跟着删', () => {
  const theirs = copy({ connections: [] })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.document.connections, [])
  assert.deepEqual(outcome.applied.removedConnections, ['w1'])
})

await check('M12 同一张卡连着改了两处（位置 + 标题）仍算一次改动', () => {
  const retitled = { ...node('b', 300, 0), title: '主镜头' }
  const theirs = copy({ nodes: [node('a', 0, 0), retitled, node('c', 600, 0)] })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.equal(byId(outcome.document, 'b').title, '主镜头')
  assert.deepEqual(outcome.applied.changedNodes, ['b'])
})

// -------------------------------------------------------------- 文档级

await check('M13 对方改了标题、本地只动画布 → 采用对方标题', () => {
  const ours = copy({ viewport: { x: 10, y: 20, k: 0.8 } })
  const theirs = copy({ title: '橘猫短片 v2' })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.document.title, '橘猫短片 v2')
  assert.equal(outcome.applied.adoptedTitle, true)
  // 本地动的视口要保留，不能被对方的旧视口带回去。
  assert.deepEqual(outcome.document.viewport, { x: 10, y: 20, k: 0.8 })
  assert.equal(outcome.applied.adoptedViewport, false)
})

await check('M14 本地改了标题 → 保留本地标题', () => {
  const ours = copy({ title: '我的版本' })
  const outcome = mergeCanvasDocuments(base(), ours, base())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.document.title, '我的版本')
  assert.equal(outcome.applied.adoptedTitle, false)
})

await check('M15 老文档没有 groups 字段 → 合并后也不凭空长出 groups: []', () => {
  const outcome = mergeCanvasDocuments(base(), base(), base())
  assert.equal(outcome.ok, true)
  assert.equal('groups' in outcome.document, false)
})

await check('M16 对方建了分组 → 分组保留，本地节点的分组状态不被抹掉', () => {
  const theirs = copy({ groups: [{ id: 'g1', title: '镜头组', nodeIds: ['a', 'b'] }] })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.document.groups.map(item => item.id), ['g1'])
  assert.deepEqual(outcome.applied.addedGroups, ['g1'])
})

// ------------------------------------------------------------ 混合场景

await check('M17 真实并发：本地加卡+连线，对方拖卡+改标题 → 三件都保住，无冲突', () => {
  const ours = copy({
    nodes: [...base().nodes, node('outro', 900, 300, '结尾')],
    connections: [
      { id: 'w1', fromNodeId: 'a', toNodeId: 'b' },
      { id: 'w2', fromNodeId: 'b', toNodeId: 'outro' },
    ],
  })
  const theirs = copy({
    title: '橘猫短片 v2',
    nodes: [node('a', 0, 0), node('b', 340, 60), node('c', 600, 0)],
  })
  const outcome = mergeCanvasDocuments(base(), ours, theirs)
  assert.equal(outcome.ok, true)
  assert.deepEqual(ids(outcome.document), ['a', 'b', 'c', 'outro'])
  assert.equal(byId(outcome.document, 'b').x, 340)
  assert.equal(outcome.document.connections.length, 2)
  assert.equal(outcome.document.title, '橘猫短片 v2')
  // 摘要要能说清「对方的改动替他保住了什么」：拖动的那一张 + 标题。
  assert.deepEqual(outcome.applied.changedNodes, ['b'])
  assert.equal(outcome.applied.adoptedTitle, true)
})

await check('M18 结果里的 revision 取对方看到的那个，交给宿主递增', () => {
  const theirs = copy({ revision: 9 })
  const outcome = mergeCanvasDocuments(base(), base(), theirs)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.document.revision, 9)
})

await check('M19 合并出来的文档 id 不变，不会把内容写进另一张画布', () => {
  const outcome = mergeCanvasDocuments(base(), base(), base())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.document.id, 'canvas-1')
})

await check('M20 空画布（三份都没节点）也能合并，不抛异常', () => {
  const empty = copy({ nodes: [], connections: [] })
  const outcome = mergeCanvasDocuments(empty, empty, empty)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.document.nodes, [])
})

// ---------------------------------------------------------------- 汇总

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\ncanvas merge: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\ncanvas merge: ${results.length} passed\n`)
}

/**
 * 生成前自动连边：只补「近」的，不补远的，也不夺已有角色。
 *
 * 这套断言守的是那条容易越界的规则——AutoLink 式全画布匹配看着聪明，实际会
 * 让用户远处的一张图莫名参与生成，而且看不出是哪张。所以阈值、上限、去重、
 * 角色分配逐条钉住。
 *
 *  A1  只有图片节点是候选（文本/视频/配置不补）
 *  A2  已经连到目标的图不再是候选
 *  A3  超出 1.5 个目标节点短边的不补
 *  A4  重叠 / 紧贴（间距 0）算近
 *  A5  近的排前面
 *  A6  上限 4 张，多的一点不补
 *  A7  不可用的图（无 asset）不当候选
 *  A8  目标节点自己不在候选里
 *  A9  只按「到目标的距离」算，不受其他节点影响
 *  K1  keyframeRoles：第 1 张 first、第 2 张 last、其余 reference
 *  K2  keyframeRoles(0) / (1) 的边界
 *
 * Run: node scripts/smoke-canvas-auto-link.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { AUTO_LINK_LIMIT, AUTO_LINK_REACH, autoLinkCandidates, keyframeRoles } from '../src/client/canvas/auto-link.ts'

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

const IMG = { width: 240, height: 240 }
const image = (id, x, y, usable = true) => ({ id, type: 'image', x, y, ...IMG, __usable: usable })
const usable = node => node.__usable !== false
const link = (from, to) => ({ id: `e-${from}-${to}`, fromNodeId: from, toNodeId: to })

/** 目标节点：240×240 放在原点。阈值 = 1.5 × 240 = 360。 */
const target = { id: 'target', type: 'config', x: 0, y: 0, width: 240, height: 240 }

// ------------------------------------------------------------ 候选筛选

check('A1 只有图片节点是候选', () => {
  const nodes = [
    image('near', 260, 0),
    { id: 'text', type: 'text', x: 260, y: 0, ...IMG },
    { id: 'vid', type: 'video', x: 260, y: 0, ...IMG },
  ]
  assert.deepEqual(autoLinkCandidates(nodes, [], target, usable).map(n => n.id), ['near'])
})

check('A2 已经连到目标的图不再是候选', () => {
  const nodes = [image('wired', 260, 0), image('loose', 260, 300)]
  assert.deepEqual(autoLinkCandidates(nodes, [link('wired', 'target')], target, usable).map(n => n.id), ['loose'])
})

check('A3 超出 1.5 个目标短边的不补', () => {
  // 目标右边缘 x=240；图左边缘 = x。间距 = x - 240。
  const justInside = image('in', 240 + 359, 0)   // 间距 359
  const justOutside = image('out', 240 + 361, 0) // 间距 361
  assert.deepEqual(autoLinkCandidates([justInside, justOutside], [], target, usable).map(n => n.id), ['in'])
  assert.equal(AUTO_LINK_REACH, 1.5)
})

check('A4 重叠 / 紧贴（间距 0）算近', () => {
  const overlapping = image('overlap', 100, 100)
  const flush = image('flush', 240, 0)
  assert.deepEqual(autoLinkCandidates([overlapping, flush], [], target, usable).map(n => n.id).sort(), ['flush', 'overlap'])
})

check('A5 近的排前面', () => {
  const far = image('far', 240 + 300, 0)
  const near = image('near', 240 + 10, 0)
  assert.deepEqual(autoLinkCandidates([far, near], [], target, usable).map(n => n.id), ['near', 'far'])
})

check('A6 上限 4 张，多的一点不补', () => {
  const nodes = Array.from({ length: 7 }, (_, index) => image(`i${index}`, 240 + index * 10, 0))
  assert.equal(autoLinkCandidates(nodes, [], target, usable).length, AUTO_LINK_LIMIT)
  assert.equal(AUTO_LINK_LIMIT, 4)
})

check('A7 不可用的图不当候选', () => {
  const nodes = [image('usable', 260, 0), image('broken', 270, 0, false)]
  assert.deepEqual(autoLinkCandidates(nodes, [], target, usable).map(n => n.id), ['usable'])
})

check('A8 目标节点自己不在候选里', () => {
  // 目标若恰好也是图片节点，也不能把自己连给自己。
  const imageTarget = { ...image('target', 0, 0) }
  assert.deepEqual(autoLinkCandidates([imageTarget], [], imageTarget, usable), [])
})

check('A9 只按到目标的距离算，不受其他节点影响', () => {
  // 两张同样近的图，中间再塞一堆别的图，候选不变。
  const nodes = [image('a', 240 + 20, 0), image('b', 240 + 20, 260), ...Array.from({ length: 5 }, (_, i) => image(`f${i}`, 240 + 900 + i * 10, 0))]
  assert.deepEqual(autoLinkCandidates(nodes, [], target, usable).map(n => n.id).sort(), ['a', 'b'])
})

// ------------------------------------------------------------- 角色分配

check('K1 keyframeRoles：第 1 张 first、第 2 张 last、其余 reference', () => {
  assert.deepEqual(keyframeRoles(3), ['first', 'last', 'reference'])
  assert.deepEqual(keyframeRoles(4), ['first', 'last', 'reference', 'reference'])
})

check('K2 keyframeRoles 的边界', () => {
  assert.deepEqual(keyframeRoles(0), [])
  assert.deepEqual(keyframeRoles(1), ['first'])
  assert.deepEqual(keyframeRoles(2), ['first', 'last'])
  assert.deepEqual(keyframeRoles(-1), [])
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
  console.error(`\ncanvas auto link: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas auto link: ${passed} passed`)

/**
 * 连线角色：老画布兼容的最后一道闸。
 *
 * 这套断言守的不是「新功能好不好用」，而是**没设过角色的画布一个字都不许变**。
 * 1429 个真实画布全是无 role 形态，任何一处「顺手规范化成 role: 'input'」都会
 * 让它们在下次保存时被改写，而用户在画布上什么都看不出来。
 *
 *  R1  没有 role 的连线解析为 input
 *  R2  认不出的 role 值退回 input（手改过的 JSON 不能让整份画布读不出来）
 *  R3  设成 input = 删掉字段，不是写 'input'
 *  R4  设成 input 时若本来就没字段，返回同一个对象（不产生无意义的拷贝）
 *  R5  设成其他角色 → 写入；重复设同一个值 → 同一个对象
 *  R6  normalizeRoles 对无 role 的文档是恒等变换（逐条、包括字段缺失）
 *  R7  orderedUpstream：谁都没标角色时，顺序与文档数组逐条相同
 *  R8  orderedUpstream：标了之后 first → last → 其余，其余保持原相对顺序
 *  R9  orderedUpstream：只认目标节点的入边，别家的边不参与
 *  F1  framePair：全无标注时取前两张可用图片 = 今天的行为
 *  F2  framePair：显式 first/last 优先，与数组顺序无关
 *  F3  framePair：删边重连（数组顺序对调）后首尾帧不变 —— 这就是那个 bug
 *  F4  framePair：只标 first 不标 last，尾帧仍按老规则补上
 *  F5  framePair：first 指向的图不可用（无 asset）时退回老规则
 *  B1  roleBadgeKey：input 不显示徽标，其余各给自己的键
 *  B2  CONNECTION_ROLES 覆盖全部四个角色且无重复
 *
 * Run: node scripts/smoke-canvas-connection-role.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import {
  CONNECTION_ROLES,
  framePair,
  normalizeRoles,
  orderedUpstream,
  roleBadgeKey,
  roleOf,
  upstreamWithRole,
  withRole,
} from '../src/client/canvas/connection-role.ts'

// 检查器只用仓库那一份（scripts/lib/check-harness.mjs）：自己抄一份会把
// 「超时算失败」和 skip 这两个语义抄丢，而这套断言恰恰靠「settled 才算数」
// 才可信。判定规则见 verify-check-harness.mjs。
const results = []
const check = createCheckHarness({ results })

/** 只给角色层需要的字段。 */
const edge = (id, from, to, role) => role === undefined
  ? { id, fromNodeId: from, toNodeId: to }
  : { id, fromNodeId: from, toNodeId: to, role }

const node = (id, type = 'image', usable = true) => ({ id, type, __usable: usable })
const usable = candidate => candidate.__usable === true
const lookup = list => id => list.find(candidate => candidate.id === id)

// ------------------------------------------------------------------ roleOf

await check('R1 没有 role 的连线解析为 input', () => {
  assert.equal(roleOf(edge('e1', 'a', 'b')), 'input')
  assert.equal(roleOf({ id: 'e1' }), 'input')
})

await check('R2 认不出的 role 值退回 input', () => {
  assert.equal(roleOf({ id: 'e1', role: 'banana' }), 'input')
  assert.equal(roleOf({ id: 'e1', role: '' }), 'input')
  assert.equal(roleOf({ id: 'e1', role: 'FIRST' }), 'input')
  // 认得的照常认出
  assert.equal(roleOf({ id: 'e1', role: 'first' }), 'first')
})

// ------------------------------------------------------------------ withRole

await check('R3 设成 input = 删掉字段，不是写 input', () => {
  const result = withRole(edge('e1', 'a', 'b', 'first'), 'input')
  assert.deepEqual(result, { id: 'e1', fromNodeId: 'a', toNodeId: 'b' })
  assert.equal('role' in result, false, 'input 必须是「没有字段」，不是 role: input')
})

await check('R4 没有字段时设 input 返回同一个对象', () => {
  const original = edge('e1', 'a', 'b')
  assert.equal(withRole(original, 'input'), original)
})

await check('R5 设成其他角色写入；重复设同值返回同一个对象', () => {
  const original = edge('e1', 'a', 'b')
  const first = withRole(original, 'first')
  assert.equal(first.role, 'first')
  assert.equal(first.id, 'e1', '不许丢掉其他字段')
  assert.equal(withRole(first, 'first'), first, '同值不该产生新对象')
  const last = withRole(first, 'last')
  assert.equal(last.role, 'last')
  assert.equal(last, withRole(last, 'last'))
})

// ------------------------------------------------------------ normalizeRoles

await check('R6 normalizeRoles 对无 role 的文档是恒等变换', () => {
  const document = [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')]
  const normalized = normalizeRoles(document)
  assert.deepEqual(normalized, document)
  for (const connection of normalized) assert.equal('role' in connection, false, '不许凭空长出 role 字段')
})

// --------------------------------------------------------- orderedUpstream

await check('R7 谁都没标角色时顺序与文档数组逐条相同', () => {
  const connections = [edge('e1', 'x', 't'), edge('e2', 'y', 't'), edge('e3', 'z', 't')]
  assert.deepEqual(orderedUpstream(connections, 't').map(c => c.id), ['e1', 'e2', 'e3'])
})

await check('R8 标了之后 first → last → 其余，其余保持原相对顺序', () => {
  const connections = [
    edge('e1', 'x', 't'),
    edge('e2', 'y', 't', 'last'),
    edge('e3', 'z', 't', 'first'),
    edge('e4', 'w', 't', 'reference'),
    edge('e5', 'v', 't'),
  ]
  assert.deepEqual(orderedUpstream(connections, 't').map(c => c.id), ['e3', 'e2', 'e1', 'e4', 'e5'])
})

await check('R9 只认目标节点的入边', () => {
  const connections = [edge('e1', 't', 'x', 'first'), edge('e2', 'y', 't', 'last'), edge('e3', 'z', 'other', 'first')]
  assert.deepEqual(orderedUpstream(connections, 't').map(c => c.id), ['e2'])
  assert.equal(upstreamWithRole(connections, 't', 'first'), undefined, '目标节点的出边不算它的输入')
})

// --------------------------------------------------------------- framePair

await check('F1 全无标注时取前两张可用图片 = 今天的行为', () => {
  const nodes = [node('p'), node('q'), node('r')]
  const connections = [edge('e1', 'p', 't'), edge('e2', 'q', 't'), edge('e3', 'r', 't')]
  const frames = framePair(connections, lookup(nodes), 't', usable)
  assert.equal(frames.first.id, 'p')
  assert.equal(frames.last.id, 'q')
})

await check('F2 显式 first/last 优先，与数组顺序无关', () => {
  const nodes = [node('p'), node('q')]
  // 数组里 p 在前，但 q 被标成 first
  const connections = [edge('e1', 'p', 't', 'last'), edge('e2', 'q', 't', 'first')]
  const frames = framePair(connections, lookup(nodes), 't', usable)
  assert.equal(frames.first.id, 'q')
  assert.equal(frames.last.id, 'p')
})

await check('F3 删边重连、数组顺序对调后首尾帧不变', () => {
  const nodes = [node('p'), node('q')]
  const before = [edge('e1', 'p', 't', 'first'), edge('e2', 'q', 't', 'last')]
  // 模拟删掉两条边再按相反顺序重连：id 变了，role 和顺序都反过来
  const after = [edge('e9', 'q', 't', 'last'), edge('e8', 'p', 't', 'first')]
  const a = framePair(before, lookup(nodes), 't', usable)
  const b = framePair(after, lookup(nodes), 't', usable)
  assert.equal(a.first.id, 'p')
  assert.equal(b.first.id, 'p', '重连后首帧变了 —— 这正是要修的 bug')
  assert.equal(a.last.id, 'q')
  assert.equal(b.last.id, 'q', '重连后尾帧变了')
})

await check('F4 只标 first 不标 last，尾帧仍按老规则补上', () => {
  const nodes = [node('p'), node('q'), node('r')]
  const connections = [edge('e1', 'p', 't'), edge('e2', 'q', 't', 'first'), edge('e3', 'r', 't')]
  const frames = framePair(connections, lookup(nodes), 't', usable)
  assert.equal(frames.first.id, 'q')
  assert.equal(frames.last.id, 'p', '尾帧该从剩下可用图里按文档顺序取')
})

await check('F5 first 指向的图不可用时退回老规则', () => {
  const nodes = [node('p'), node('q', 'image', false)]
  const connections = [edge('e1', 'p', 't'), edge('e2', 'q', 't', 'first')]
  const frames = framePair(connections, lookup(nodes), 't', usable)
  assert.equal(frames.first.id, 'p', '标了 first 但图没 asset，不能让它占住帧位')
})

// ------------------------------------------------------------ roleBadgeKey

await check('B1 input 不显示徽标，其余各给自己的键', () => {
  assert.equal(roleBadgeKey('input'), undefined)
  assert.equal(roleBadgeKey('first'), 'canvas.connection.role.first')
  assert.equal(roleBadgeKey('last'), 'canvas.connection.role.last')
  assert.equal(roleBadgeKey('reference'), 'canvas.connection.role.reference')
})

await check('B2 CONNECTION_ROLES 覆盖全部四个角色且无重复', () => {
  assert.deepEqual([...CONNECTION_ROLES].sort(), ['first', 'input', 'last', 'reference'])
  assert.equal(new Set(CONNECTION_ROLES).size, 4)
})

// ---------------------------------------------------------------- 汇总

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\ncanvas connection role: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\ncanvas connection role: ${results.length} passed\n`)
}

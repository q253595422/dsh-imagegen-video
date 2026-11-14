/**
 * 画布分组：一个节点只属于一个组，框由成员算出来，空组自动消失。
 *
 * 这三条是本功能里唯一会「悄悄出错」的地方——出错时界面照样能用，只是
 * 拖一个节点带动了不该动的节点，或者右键菜单里留下一个点不动的空组。所以
 * 逐条钉住。
 *
 *  G1  groupsOf：老文档没有 groups 字段时读作空数组
 *  G2  groupFrame：成员包围盒外扩 GROUP_FRAME_PAD
 *  G3  groupFrame：单个小节点也至少有 GROUP_FRAME_MIN
 *  G4  groupFrame：成员全解析不到时返回 null（不画幽灵框）
 *  G5  groupFrame：成员里有一个解析不到，其余照常参与
 *  G6  groupOfNode：找到所属组 / 找不到返回 undefined
 *  G7  withGroup：不足 2 个成员不成组
 *  G8  withGroup：重复 id 只算一个
 *  G9  withGroup：把节点从原组摘出来（一个节点只属于一个组）
 *  G10 withGroup：原组被摘空后整个消失
 *  G11 withGroup：默认名取最小空位
 *  G12 withGroupTitle：改名；空标题落回默认名
 *  G13 withoutGroup：只删指定的那个组
 *  G14 pruneGroups：成员被删就从组里剔掉
 *  G15 pruneGroups：剔空的组整个消失
 *  G16 pruneGroups：没受影响的组返回原对象（保住引用相等）
 *  G17 siblingsInGroup：返回同组其余成员，不含自己
 *  G18 siblingsInGroup：已经在 existing 里的不重复返回
 *  G19 siblingsInGroup：不在任何组里返回空数组
 *  G20 nextGroupTitle：解散后重建拿到最小空位，不是 length+1
 *  G21 groupsField：缺失与空数组都落成 undefined（不凭空长字段）
 *  G22 pruneGroupsField：原文档没有 groups 时不会长出字段
 *  G23 pruneGroupsField：组被删光后落成 undefined，不是 []
 *  G24 pruneGroupsField：还剩成员时按 pruneGroups 剔成员
 *
 * Run: node scripts/smoke-canvas-group.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import {
  GROUP_FRAME_MIN,
  GROUP_FRAME_PAD,
  groupFrame,
  groupOfNode,
  groupsField,
  groupsOf,
  nextGroupTitle,
  pruneGroups,
  pruneGroupsField,
  siblingsInGroup,
  withGroup,
  withGroupTitle,
  withoutGroup,
} from '../src/client/canvas/group-model.ts'

const results = []
const check = createCheckHarness({ results })

const node = (id, x, y, width = 200, height = 120) => ({ id, type: 'image', title: id, x, y, width, height })
const lookup = nodes => new Map(nodes.map(item => [item.id, item]))
const group = (id, nodeIds, title = `组 ${id}`) => ({ id, title, nodeIds })

let seq = 0
const makeId = () => `g${++seq}`

// ------------------------------------------------------------- groupsOf

await check('G1 groupsOf：老文档没有 groups 字段时读作空数组', () => {
  assert.deepEqual(groupsOf({}), [])
  assert.deepEqual(groupsOf(null), [])
  assert.deepEqual(groupsOf(undefined), [])
  const existing = [group('a', ['n1', 'n2'])]
  assert.equal(groupsOf({ groups: existing }), existing, '有值时原样返回，不复制')
})

// ------------------------------------------------------------ groupFrame

await check('G2 groupFrame：成员包围盒外扩 GROUP_FRAME_PAD', () => {
  const nodes = lookup([node('n1', 100, 200), node('n2', 500, 400)])
  const frame = groupFrame(group('a', ['n1', 'n2']), nodes)
  // 包围盒：x 100..700，y 200..520
  assert.equal(frame.x, 100 - GROUP_FRAME_PAD)
  assert.equal(frame.y, 200 - GROUP_FRAME_PAD)
  assert.equal(frame.width, 600 + GROUP_FRAME_PAD * 2)
  assert.equal(frame.height, 320 + GROUP_FRAME_PAD * 2)
})

await check('G3 groupFrame：单个小节点也至少有 GROUP_FRAME_MIN', () => {
  const nodes = lookup([node('tiny', 0, 0, 10, 10)])
  const frame = groupFrame(group('a', ['tiny']), nodes)
  assert.equal(frame.width, GROUP_FRAME_MIN.width)
  assert.equal(frame.height, GROUP_FRAME_MIN.height)
})

await check('G4 groupFrame：成员全解析不到时返回 null', () => {
  assert.equal(groupFrame(group('a', ['gone1', 'gone2']), lookup([])), null)
})

await check('G5 groupFrame：成员里有一个解析不到，其余照常参与', () => {
  const nodes = lookup([node('n1', 0, 0)])
  const frame = groupFrame(group('a', ['n1', 'gone']), nodes)
  assert.notEqual(frame, null)
  assert.equal(frame.x, -GROUP_FRAME_PAD)
  // 两个节点都在 0,0 起步的话宽度会翻倍；这里只有一个真实成员，所以是 MIN
  assert.equal(frame.width, Math.max(GROUP_FRAME_MIN.width, 200 + GROUP_FRAME_PAD * 2))
})

// ----------------------------------------------------------- groupOfNode

await check('G6 groupOfNode：找到所属组 / 找不到返回 undefined', () => {
  const groups = [group('a', ['n1']), group('b', ['n2'])]
  assert.equal(groupOfNode(groups, 'n2').id, 'b')
  assert.equal(groupOfNode(groups, 'n9'), undefined)
})

// -------------------------------------------------------------- withGroup

await check('G7 withGroup：不足 2 个成员不成组', () => {
  assert.equal(withGroup([], [], makeId), undefined)
  assert.equal(withGroup([], ['n1'], makeId), undefined)
})

await check('G8 withGroup：重复 id 只算一个', () => {
  assert.equal(withGroup([], ['n1', 'n1'], makeId), undefined, '两个一样的 id 不算两个成员')
  const made = withGroup([], ['n1', 'n1', 'n2'], makeId)
  assert.deepEqual(made.group.nodeIds, ['n1', 'n2'])
})

await check('G9 withGroup：把节点从原组摘出来（一个节点只属于一个组）', () => {
  const before = [group('old', ['n1', 'n2'])]
  const made = withGroup(before, ['n2', 'n3'], makeId)
  assert.deepEqual(made.groups.find(g => g.id === 'old').nodeIds, ['n1'])
  assert.deepEqual(made.group.nodeIds, ['n2', 'n3'])
  for (const item of made.groups) {
    for (const id of item.nodeIds) {
      const owners = made.groups.filter(g => g.nodeIds.includes(id))
      assert.equal(owners.length, 1, `${id} 同时属于 ${owners.length} 个组`)
    }
  }
})

await check('G10 withGroup：原组被摘空后整个消失', () => {
  const before = [group('old', ['n1', 'n2'])]
  const made = withGroup(before, ['n1', 'n2'], makeId)
  assert.deepEqual(made.groups.map(g => g.id), [made.group.id])
})

await check('G11 withGroup：默认名取最小空位', () => {
  const before = [group('a', ['n1'], '组 1'), group('b', ['n2'], '组 3')]
  const made = withGroup(before, ['n3', 'n4'], makeId)
  assert.equal(made.group.title, '组 2')
})

await check('G12 withGroupTitle：改名；空标题落回默认名', () => {
  const before = [group('a', ['n1', 'n2'], '组 1')]
  assert.equal(withGroupTitle(before, 'a', '  场景 A  ')[0].title, '场景 A')
  const blanked = withGroupTitle(before, 'a', '   ')
  assert.equal(blanked[0].title, '组 1', '只有一个组时默认名仍是「组 1」')
  assert.equal(blanked[0].nodeIds.length, 2, '改名不许动成员')
})

await check('G13 withoutGroup：只删指定的那个组', () => {
  const before = [group('a', ['n1', 'n2']), group('b', ['n3'])]
  assert.deepEqual(withoutGroup(before, 'a').map(g => g.id), ['b'])
  assert.deepEqual(withoutGroup(before, 'zzz').map(g => g.id), ['a', 'b'])
})

// ----------------------------------------------------------- pruneGroups

await check('G14 pruneGroups：成员被删就从组里剔掉', () => {
  const before = [group('a', ['n1', 'n2', 'n3'])]
  const next = pruneGroups(before, new Set(['n1', 'n3']))
  assert.deepEqual(next[0].nodeIds, ['n1', 'n3'])
})

await check('G15 pruneGroups：剔空的组整个消失', () => {
  const before = [group('a', ['n1']), group('b', ['n2'])]
  const next = pruneGroups(before, new Set(['n2']))
  assert.deepEqual(next.map(g => g.id), ['b'])
})

await check('G16 pruneGroups：没受影响的组返回原对象（保住引用相等）', () => {
  const untouched = group('b', ['n2'])
  const before = [group('a', ['n1', 'n3']), untouched]
  const next = pruneGroups(before, new Set(['n1', 'n2', 'n3']))
  assert.equal(next[1], untouched, '没变过的组不该产生新对象，否则每次删除都让整个 groups 数组失效')
})

// ------------------------------------------------------ siblingsInGroup

await check('G17 siblingsInGroup：返回同组其余成员，不含自己', () => {
  const groups = [group('a', ['n1', 'n2', 'n3'])]
  assert.deepEqual(siblingsInGroup(groups, 'n1', new Set()), ['n2', 'n3'])
})

await check('G18 siblingsInGroup：已经在 existing 里的不重复返回', () => {
  const groups = [group('a', ['n1', 'n2', 'n3'])]
  assert.deepEqual(siblingsInGroup(groups, 'n1', new Set(['n2'])), ['n3'])
})

await check('G19 siblingsInGroup：不在任何组里返回空数组', () => {
  assert.deepEqual(siblingsInGroup([group('a', ['n1', 'n2'])], 'n9', new Set()), [])
  assert.deepEqual(siblingsInGroup([], 'n1', new Set()), [])
})

// -------------------------------------------------------- nextGroupTitle

await check('G20 nextGroupTitle：解散后重建拿到最小空位，不是 length+1', () => {
  // 组 1 和组 3 在，2 空着 → 应该拿 2
  assert.equal(nextGroupTitle([group('a', ['x'], '组 1'), group('b', ['y'], '组 3')]), '组 2')
  // 名字不是「组 N」格式的组不占号
  assert.equal(nextGroupTitle([group('a', ['x'], '场景 A'), group('b', ['y'], '组 1')]), '组 2')
  assert.equal(nextGroupTitle([]), '组 1')
})

// ------------------------------------------------- 写回：不许凭空长出字段
//
// 1429 个真实画布没有一个带 groups。任何在 groups 缺失时把它写成 `[]` 的路径
// 都等于本功能改写了每一份用户文档，所以这两个函数单独钉住。

await check('G21 groupsField：缺失与空数组都落成 undefined（= 删字段）', () => {
  assert.equal(groupsField(undefined), undefined)
  assert.equal(groupsField([]), undefined)
  const one = [group('a', ['n1', 'n2'])]
  assert.equal(groupsField(one), one, '有值时原样返回同一引用，不复制')
})

await check('G22 pruneGroupsField：原文档没有 groups 时不会长出字段', () => {
  assert.equal(pruneGroupsField(undefined, new Set(['n1'])), undefined)
  assert.equal(pruneGroupsField(undefined, new Set()), undefined)
})

await check('G23 pruneGroupsField：组被删光后落成 undefined，不是 []', () => {
  const before = [group('a', ['n1'])]
  assert.equal(pruneGroupsField(before, new Set()), undefined)
  assert.deepEqual(pruneGroupsField(before, new Set(['n1'])), before)
})

await check('G24 pruneGroupsField：还剩成员时按 pruneGroups 剔成员', () => {
  const before = [group('a', ['n1', 'n2'])]
  const next = pruneGroupsField(before, new Set(['n2']))
  assert.deepEqual(next[0].nodeIds, ['n2'])
})

// ---------------------------------------------------------------- 汇总

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\ncanvas group: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\ncanvas group: ${results.length} passed\n`)
}

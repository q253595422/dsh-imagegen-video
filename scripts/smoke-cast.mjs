/**
 * 身份锚定的离线验证：谁能进参考图、同一张图会不会被送两次、提示词里说了什么。
 *
 * 规则全是纯函数（src/client/cast.ts），所以这里不碰 DOM、不碰上传。真正
 * 的界面流程在 smoke.mjs 里另有一组断言。
 *
 * Run: node scripts/smoke-cast.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { castMembers, castPromptKey, castPromptLines, castReferenceIds } from '../src/client/cast.ts'

let count = 0
function ok(name, fn) {
  fn()
  count += 1
  console.log(`ok ${count} - ${name}`)
}

/** 一张可用的图片节点。 */
const image = (id, cast, extra = {}) => ({
  id,
  type: 'image',
  title: `节点 ${id}`,
  x: 0,
  y: 0,
  width: 240,
  height: 240,
  metadata: {
    status: 'success',
    asset: { assetId: `${id}.png`, url: `/assets/${id}.png`, mime: 'image/png', width: 512, height: 512, bytes: 1 },
    ...cast === undefined ? {} : { cast },
    ...extra,
  },
})

// ------------------------------------------------------------------ 收集

ok('只收被钉住的图片节点', () => {
  const nodes = [
    image('a', { role: 'character', name: '阿禾' }),
    image('b'),
    { id: 'c', type: 'text', title: '旁白', x: 0, y: 0, width: 1, height: 1, metadata: { text: '你好', cast: { role: 'character' } } },
    { id: 'd', type: 'video', title: '片段', x: 0, y: 0, width: 1, height: 1, metadata: { cast: { role: 'item' } } },
  ]
  assert.deepEqual(castMembers(nodes), [{ nodeId: 'a', name: '阿禾', role: 'character' }])
})

ok('没成图的节点不算：钉住的是「这张脸」，不是占位框', () => {
  const nodes = [
    image('empty', { role: 'character' }, { asset: { assetId: '', url: '', mime: 'image/png', width: 1, height: 1, bytes: 0 } }),
    image('generating', { role: 'character' }, { asset: { assetId: 'x', url: '', mime: 'image/png', width: 1, height: 1, bytes: 0 } }),
    image('ok', { role: 'item', name: '灯' }),
  ]
  assert.deepEqual(castMembers(nodes).map(member => member.nodeId), ['ok'], '没成图的节点不算')
})

ok('没填名字时退回节点标题，而不是把节点丢掉', () => {
  const nodes = [{ ...image('a', { role: 'style' }), title: '赛博霓虹' }]
  assert.deepEqual(castMembers(nodes), [{ nodeId: 'a', name: '赛博霓虹', role: 'style' }])
})

ok('名字只有空白时也退回标题', () => {
  const nodes = [{ ...image('a', { role: 'style', name: '   ' }), title: '水彩' }]
  assert.equal(castMembers(nodes)[0].name, '水彩')
})

ok('画布上没有钉住的人时返回空数组', () => {
  assert.deepEqual(castMembers([image('a'), image('b')]), [])
})

// ------------------------------------------------------------------ 去重

ok('连线里已经有的节点不再重复送', () => {
  const members = [
    { nodeId: 'a', name: '阿禾', role: 'character' },
    { nodeId: 'b', name: '灯', role: 'item' },
  ]
  assert.deepEqual(castReferenceIds(members, ['a']), ['b'], '连线里已经有的节点不再重复送')
})

ok('同名只送第一个：两张「阿禾」会让模型左右为难', () => {
  const members = [
    { nodeId: 'a', name: '阿禾', role: 'character' },
    { nodeId: 'b', name: '阿禾', role: 'character' },
  ]
  assert.deepEqual(castReferenceIds(members, []), ['a'])
})

ok('所有成员都已在连线里时返回空', () => {
  const members = [{ nodeId: 'a', name: '阿禾', role: 'character' }]
  assert.deepEqual(castReferenceIds(members, ['a']), [])
})

ok('没有成员时返回空数组，调用方不必判空', () => {
  assert.deepEqual(castReferenceIds([], ['a']), [])
})

// ------------------------------------------------------------------ 提示词

ok('角色各自对应一句说明', () => {
  assert.equal(castPromptKey('character'), 'canvas.cast.promptCharacter')
  assert.equal(castPromptKey('item'), 'canvas.cast.promptItem')
  assert.equal(castPromptKey('style'), 'canvas.cast.promptStyle')
})

ok('提示词逐条生成，序号从 1 开始并连续', () => {
  const lines = castPromptLines(
    [
      { nodeId: 'a', name: '阿禾', role: 'character' },
      { nodeId: 'b', name: '灯', role: 'item' },
    ],
    (member, index) => `${index + 1}:${member.role}:${member.name}`,
  )
  assert.deepEqual(lines, ['1:character:阿禾', '2:item:灯'])
})

ok('提示词里同名的只留一条', () => {
  const lines = castPromptLines(
    [
      { nodeId: 'a', name: '阿禾', role: 'character' },
      { nodeId: 'b', name: '阿禾', role: 'item' },
    ],
    (member, index) => `${index + 1}:${member.name}`,
  )
  assert.deepEqual(lines, ['1:阿禾'])
})

ok('没有成员时不产出任何行（调用方不该拼出一个空段落）', () => {
  assert.deepEqual(castPromptLines([], () => 'never'), [])
})

console.log(`\ncast: ${count} checks ok`)

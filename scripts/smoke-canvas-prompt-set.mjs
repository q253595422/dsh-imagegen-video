/**
 * 套图的离线验收：清理、兜底、上限、读写两侧的分工。
 *
 * WHY 单独一套：套图的三条边界（空条目、重复标题、条目上限）在组件里各写
 * 一遍就会各错一遍，症状是「点了没反应」或「多出一张空白」。在这里用纯函数
 * 把它们一次锁死，组件只负责把输入喂进来。
 *
 * Run: node scripts/smoke-canvas-prompt-set.mjs
 */

import assert from 'node:assert/strict'

import {
  MAX_PROMPT_SET_ITEMS,
  hasPromptSet,
  normalizePromptSet,
  promptSetJobs,
  promptSetJobsFromItems,
  promptSetOf,
} from '../src/client/canvas/prompt-set.ts'

/** 一个最小的 image 节点，只带 metadata，别的不参与断言。 */
function imageNode(metadata) {
  return { id: 'n', type: 'image', x: 0, y: 0, w: 240, h: 180, metadata }
}

const checks = []
function check(name, fn) { checks.push({ name, fn }) }

check('T1 · 空 / 非列表 metadata → 空套图', async () => {
  assert.equal(promptSetOf(imageNode(undefined)).length, 0)
  assert.equal(promptSetOf(imageNode({})).length, 0)
  assert.equal(promptSetOf(imageNode({ promptSet: null })).length, 0)
  assert.equal(promptSetOf(imageNode({ promptSet: 'nope' })).length, 0)
})

check('T2 · 空提示词条目被丢掉，不留一个白跑的任务', async () => {
  const node = imageNode({
    promptSet: [
      { id: 'a', title: '空的一条', prompt: '   ' },
      { id: 'b', title: '正常', prompt: 'a close-up of a cat' },
      { id: 'c', title: '也是空', prompt: '' },
    ],
})
  const result = promptSetOf(node)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'b')
})

check('T3 · 标题兜底走 `{index}`，index 从 1 起', async () => {
  const node = imageNode({
    promptSet: [
      { id: 'a', title: '', prompt: 'one' },
      { id: 'b', title: '  ', prompt: 'two' },
      { id: 'c', title: '写好的', prompt: 'three' },
    ],
})
  const result = promptSetOf(node, index => `第${index}条`)
  assert.deepStrictEqual(result.map(item => item.title), ['第1条', '第2条', '写好的'])
})

check('T4 · 没给 fallback 就返回空标题（不是 undefined）', async () => {
  const node = imageNode({ promptSet: [{ id: 'a', title: '', prompt: 'one' }] })
  assert.deepStrictEqual(promptSetOf(node), [{ id: 'a', title: '', prompt: 'one' }])
})

check('T5 · 超长标题截断到 24 字符', async () => {
  const long = '一'.repeat(60)
  const node = imageNode({ promptSet: [{ id: 'a', title: long, prompt: 'p' }] })
  const item = promptSetOf(node)[0]
  assert.equal(item?.title.length, 24)
  assert.equal(item?.title, '一'.repeat(24))
})

check('T6 · 24 字符刚好不截', async () => {
  const exactly = '正'.repeat(24)
  const item = promptSetOf(imageNode({ promptSet: [{ id: 'a', title: exactly, prompt: 'p' }] }))[0]
  assert.equal(item?.title, exactly)
})

check('T7 · 上限 12：超出截断，不报错', async () => {
  assert.equal(MAX_PROMPT_SET_ITEMS, 12)
  const raw = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    title: `第${i + 1}条`,
    prompt: `prompt ${i + 1}`,
  }))
  const result = promptSetOf(imageNode({ promptSet: raw }))
  assert.equal(result.length, 12)
  assert.equal(result[0]?.id, 'p0')
  assert.equal(result[11]?.id, 'p11')
})

check('T8 · normalize 保留空条目（用户正在打字，光标不能跳）', async () => {
  const items = [
    { id: 'a', title: '写好', prompt: 'one' },
    { id: 'b', title: '还在打', prompt: '' },
  ]
  const saved = normalizePromptSet(items)
  assert.equal(saved.length, 2)
  assert.deepStrictEqual(saved, items)
})

check('T9 · normalize 截断超限条目、补齐缺 id、截超长标题', async () => {
  const raw = Array.from({ length: MAX_PROMPT_SET_ITEMS + 3 }, (_, i) => ({
    id: i < 2 ? '' : `p${i}`,
    title: '标'.repeat(40),
    prompt: `p${i}`,
  }))
  const saved = normalizePromptSet(raw)
  assert.equal(saved.length, MAX_PROMPT_SET_ITEMS)
  assert.equal(saved[0]?.id, 'prompt-1')
  assert.equal(saved[1]?.id, 'prompt-2')
  assert.equal(saved[2]?.id, 'p2')
  assert.equal(saved[0]?.title.length, 24)
})

check('T10 · promptSetJobs：每条一个任务，空标题退到自己的 id', async () => {
  const node = imageNode({
    promptSet: [
      { id: 'front', title: '正面视图', prompt: 'front view' },
      { id: 'side', title: '', prompt: 'side view' },
      { id: 'back', title: '背面视图', prompt: 'back view' },
    ],
})
  const jobs = promptSetJobs(node)
  assert.equal(jobs.length, 3)
  assert.deepStrictEqual(jobs[0], { title: '正面视图', prompt: 'front view' })
  assert.equal(jobs[1]?.title, 'side')
  assert.deepStrictEqual(jobs[2], { title: '背面视图', prompt: 'back view' })
})

check('T11 · hasPromptSet 边界：非列表 / 全空 / 至少一条非空', async () => {
  assert.equal(hasPromptSet(imageNode(undefined)), false)
  assert.equal(hasPromptSet(imageNode({ promptSet: [] })), false)
  assert.equal(hasPromptSet(imageNode({ promptSet: [{ id: 'a', title: 'x', prompt: '   ' }] })), false)
  assert.equal(hasPromptSet(imageNode({ promptSet: [{ id: 'a', title: 'x', prompt: 'real' }] })), true)
})

check('T12 · 草稿里还没落盘的条目也要能跑（提交读草稿，不读文档）', async () => {
  // 用户刚在编辑器里敲完三条、还没保存到节点：这时按生成，跑的就是这三条。
  const draft = [
    { id: 'a', title: '正面', prompt: 'front' },
    { id: 'b', title: '', prompt: 'side' },
    { id: 'c', title: '空的', prompt: '   ' },
  ]
  const jobs = promptSetJobsFromItems(draft)
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs[0], { title: '正面', prompt: 'front' })
  assert.equal(jobs[1].title, 'b')
})

check('T13 · 全空草稿不产生任务（不能白跑一次）', async () => {
  assert.deepEqual(promptSetJobsFromItems([]), [])
  assert.deepEqual(promptSetJobsFromItems([{ id: 'a', title: 'x', prompt: '' }]), [])
})

check('T14 · 草稿路径同样受 12 条上限约束', async () => {
  const draft = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, title: `t${i}`, prompt: `v${i}` }))
  assert.equal(promptSetJobsFromItems(draft).length, MAX_PROMPT_SET_ITEMS)
})

// ------------------------------------------------------------------- 驱动

let passed = 0
let failed = 0
const results = []
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
  console.error(`\ncanvas prompt set: ${failed} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\ncanvas prompt set: ${passed} passed`)
}

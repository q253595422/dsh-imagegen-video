/**
 * 提案摘要的语言：服务端只记数量，句子由客户端按当前语言渲染。
 *
 * WHY 需要这一组：
 *
 *  - 改造前 `summary` 是服务端用中文拼好后写进提案文件的。提案条上其余每一行
 *    都走 `tt()`，只有这一行不受语言表管辖——英文、俄文用户看到的是中文。
 *  - 「服务端不生成文案」是一条**容易悄悄回退**的约定：往 `summarise()` 里
 *    再加一句中文，界面上一切照常，只有非中文用户会看到混排。所以这里直接
 *    跑真实工具，断言它产出的提案带结构化 `counts`。
 *  - 旧提案（已落在磁盘上、没有 `counts` 的）必须仍然显示一句话。退回它自带
 *    的 `summary` 是唯一选项；返回空字符串会让提案条只剩一排按钮。
 *
 * 这里导入 TS 源码而不是 `lib/`：一是客户端包在 Node 里跑不起来（它一进来就
 * 找 `window`），二是纯函数没必要绕构建产物。
 *
 *  S1  真实工具产出的提案带 counts，不只是句子
 *  S2  各类改动各自报自己的键，不凭空多报
 *  S3  同一份 counts 在 zh / en / ru 下渲染成三句不同的话
 *  S4  旧提案（无 counts）退回自己的 summary，而不是空字符串
 *  S5  退化的 counts（空对象、全零、NaN）什么都不渲染
 *
 * Run: node scripts/smoke-canvas-proposal-summary.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describeProposal, proposalSummaryText } from '../src/client/canvas/proposal-summary.ts'
import { applyHostLocale } from '../src/client/helpers.ts'

const home = mkdtempSync(join(tmpdir(), 'canvas-proposal-summary-'))
process.env.DSH_HOME = home

const { registerAgentCanvasTools, proposalStore, canvasStore } = await import('../lib/index.js')

const results = []
const checks = []
function check (name, fn) { checks.push({ name, fn }) }

function tools () {
  const registered = new Map()
  registerAgentCanvasTools(
    { tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } },
    () => ({ enabled: true }),
  )
  return registered
}

const run = async (registered, name, args) => registered.get(name).execute(args, {})

/** 建一个画布，并把每个节点的一条提案立即接受，让它真的落进 pages/。 */
async function seedAccepted (registered, title, nodeTitles) {
  const created = await run(registered, 'create_canvas', { title })
  for (const nodeTitle of nodeTitles) {
    const view = await run(registered, 'add_canvas_node', { canvas_id: created.id, type: 'text', title: nodeTitle })
    await proposalStore.acceptOne(created.id, view.proposalId)
  }
  return created
}

// ------------------------------------------------------------------- 服务端

check('S1 真实工具产出的提案带 counts，不只是句子', async () => {
  const registered = tools()
  const created = await run(registered, 'create_canvas', { title: '计数' })
  const added = await run(registered, 'add_canvas_node', { canvas_id: created.id, type: 'text', title: 'A' })
  const pending = (await proposalStore.list(created.id)).find(item => item.id === added.proposalId)
  // `summary` 仍然要写：旧客户端的画布窗口不认 counts，只认这一句。
  assert.equal(typeof pending.summary, 'string', '旧客户端要靠这句话兜底')
  assert.deepEqual(pending.counts, { addedNodes: 1 }, 'counts 必须是结构化的数量')
})

check('S2 各类改动各自报自己的键，不凭空多报', async () => {
  const registered = tools()
  const created = await seedAccepted(registered, '各类改动', ['A', 'B'])
  const nodes = (await canvasStore.read(created.id)).nodes
  const aId = nodes.find(node => node.title === 'A').id
  const bId = nodes.find(node => node.title === 'B').id

  const update = await run(registered, 'update_canvas_node', { canvas_id: created.id, node_id: aId, title: 'A2' })
  const updateProposal = (await proposalStore.list(created.id)).find(item => item.id === update.proposalId)
  assert.deepEqual(updateProposal.counts, { updatedNodes: 1 }, '一次改标题只报「改了一个」')

  const wire = await run(registered, 'connect_canvas_nodes', { canvas_id: created.id, from_node_id: aId, to_node_id: bId })
  const wireProposal = (await proposalStore.list(created.id)).find(item => item.id === wire.proposalId)
  assert.deepEqual(wireProposal.counts, { addedConnections: 1 }, '一次连线只报「连了一条」')

  const removal = await run(registered, 'remove_canvas_node', { canvas_id: created.id, node_id: bId })
  const removalProposal = (await proposalStore.list(created.id)).find(item => item.id === removal.proposalId)
  assert.equal(removalProposal.counts.removedNodes, 1)
  // 删节点连带删它是 `apply` 的语义；用户没有单独要求断线，界面就不该报一条
  // 「断开 1 条线」——那句话会让人以为是自己漏了一条改动。
  assert.equal(removalProposal.counts.removedConnections, undefined, '顺带删掉的线不算一条独立的改动')
})

// ------------------------------------------------------------------- 客户端

check('S3 同一份 counts 在三种语言下渲染成三句不同的话', async () => {
  // 真正的验收：不是「键在语言表里存在」，而是切到 en / ru 之后那句话确实变了。
  const counts = { addedNodes: 2, addedConnections: 1 }
  const render = (locale) => { applyHostLocale(locale); return describeProposal(counts) }
  const zh = render('zh')
  const en = render('en')
  const ru = render('ru')
  assert.equal(zh, '添加 2 个节点、连接 1 条线', `中文文案不对：${zh}`)
  assert.equal(en, 'add 2 node(s), connect 1 wire(s)', `英文文案不对：${en}`)
  assert.equal(ru, 'добавить узлов: 2, соединить связей: 1', `俄文文案不对：${ru}`)
  // 某份语言表漏了键时，`tt` 会原样返回键名，而键名三种语言一样——三者会撞成
  // 同一句话。上面三条各自先红，这一条是兜底。
  assert.equal(new Set([zh, en, ru]).size, 3, '三种语言必须各有各的文案')
  applyHostLocale('zh')
})

check('S4 旧提案退回自己的 summary，而不是空字符串', () => {
  // 改造前写进磁盘的提案没有 counts。提案条的全部意义是「告诉用户 Agent 想
  // 干什么」，一句空文案比一句中文更糟。
  const legacy = {
    id: 'legacy-1',
    canvasId: 'canvas-x',
    tool: 'add_canvas_node',
    summary: '添加 1 个节点',
    baseRevision: 1,
    createdAt: 0,
    change: { addedNodes: [] },
  }
  assert.equal(describeProposal(undefined), undefined, '没有 counts 就没有可渲染的东西')
  assert.equal(proposalSummaryText(legacy), '添加 1 个节点', '旧提案必须仍然显示一句话')
})

check('S5 退化的 counts 什么都不渲染', () => {
  assert.equal(describeProposal({}), undefined, '空对象没有要说的')
  assert.equal(describeProposal({ addedNodes: 0 }), undefined, '零不是改动')
  // 形状校验在 `coerceProposal` 里挡；渲染这层也不能把 NaN 拼进句子，
  // 否则提案条上出现「添加 NaN 个节点」。
  assert.equal(describeProposal({ addedNodes: Number.NaN }), undefined, 'NaN 不能进文案')
})

check('S6 改连线角色报自己的键，三种语言都说得清', async () => {
  // 角色是唯一会被「改」的连线字段（首帧 / 尾帧 / 素材）。它此前完全不算
  // 改动：`diffOf` 只比连线 id 集合，于是「把这条设成首帧」产出的提案在界面上
  // 什么都不说，而视频插帧读的正是 role。
  const registered = tools()
  const created = await seedAccepted(registered, '角色文案', ['A', 'B'])
  const nodes = (await canvasStore.read(created.id)).nodes
  const aId = nodes.find(node => node.title === 'A').id
  const bId = nodes.find(node => node.title === 'B').id
  const wire = await run(registered, 'connect_canvas_nodes', { canvas_id: created.id, from_node_id: aId, to_node_id: bId })
  await proposalStore.acceptOne(created.id, wire.proposalId)

  const rerole = await run(registered, 'connect_canvas_nodes', { canvas_id: created.id, from_node_id: aId, to_node_id: bId, role: 'first' })
  const counts = (await proposalStore.list(created.id)).find(item => item.id === rerole.proposalId).counts
  assert.deepEqual(counts, { updatedConnections: 1 }, '只报「改了一条线的角色」，不连带说「连了一条线」')

  const render = (locale) => { applyHostLocale(locale); return describeProposal(counts) }
  const zh = render('zh')
  const en = render('en')
  const ru = render('ru')
  applyHostLocale('zh')
  assert.equal(zh, '调整 1 条线的角色', `中文文案不对：${zh}`)
  assert.ok(en.includes('1') && !en.includes('canvas.proposal'), `英文文案不对：${en}`)
  assert.ok(ru.includes('1') && !ru.includes('canvas.proposal'), `俄文文案不对：${ru}`)
  assert.equal(new Set([zh, en, ru]).size, 3, '三种语言必须各有各的文案')
})

// ------------------------------------------------------------------- 驱动

let passed = 0
let failed = 0
try {
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
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(results.join('\n'))
if (failed > 0) {
  console.error(`\ncanvas proposal summary: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas proposal summary: ${passed} passed`)

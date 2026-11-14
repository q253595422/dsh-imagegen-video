/**
 * 提案三个端点的**路由级**验证。
 *
 * WHY 不能只测 store：`smoke-canvas-agent.mjs` 直接调 `proposalStore` 与
 * `ProposalStore.apply`，证明的是存储层与纯函数。真实用户走的是
 * `/canvas/proposals`、`/proposal/accept`、`/proposal/discard` 这三个 HTTP
 * 端点，中间还隔着：
 *
 *  - `guard()` 能不能挡住非 POST；
 *  - 画布 id / 提案 id 缺失时是不是明确报错而不是 500；
 *  - **接受时用户的编辑不会被回退**（覆盖用户编辑由 `apply` 的增量语义与
 *    `save` 的乐观锁分工保证，路由层不拿 baseRevision 当闸门）；
 *  - **接受一条不会让后面几条作废**（一批提案共享同一个 baseRevision，拿它
 *    比对会让第二三条全部失效）；
 *  - 接受成功后提案文件有没有被删掉（否则用户点一次「接受」，那条提案还会
 *    一直在条上挂着，再点一次就是重复写入）。
 *
 * 这一层用 `makeRoutes` 拿真实 handler，配一个最小的 req/res 替身，不启宿主。
 *
 * Run: node scripts/smoke-canvas-proposal-routes.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

// 数据根在 import 时求值，必须先指到临时目录。
const home = mkdtempSync(join(tmpdir(), 'gal-canvas-proposal-routes-'))
process.env.DSH_HOME = home

const { makeRoutes } = await import('../lib/index.js')
const { canvasStore, proposalStore, registerAgentCanvasTools } = await import('../lib/index.js')

/**
 * 找到某个路径的 handler。
 *
 * `makeRoutes` 返回的是一张表；这里只取我们要的三个。取不到就直接报错——
 * 一个悄悄跳过全部断言的测试比没有测试更糟。
 */
const routes = makeRoutes({})
const byPath = new Map()
for (const route of routes) {
  if (typeof route.path === 'string') byPath.set(route.path, route)
}

const LIST = '/api/dsh-imagegen/canvas/list'
const PROPOSALS = '/api/dsh-imagegen/canvas/proposals'
const ACCEPT = '/api/dsh-imagegen/canvas/proposal/accept'
const DISCARD = '/api/dsh-imagegen/canvas/proposal/discard'
for (const path of [PROPOSALS, ACCEPT, DISCARD]) {
  if (!byPath.has(path)) {
    console.error(`FAIL: 路由表里没有 ${path}——端点没挂上，画布拿不到待确认的改动`)
    process.exit(1)
  }
}

/**
 * 造一个够用的 req。
 *
 * `readJsonBody` 用 `for await (const chunk of req)` 读体，所以替身必须实现
 * `[Symbol.asyncIterator]`。第一版只实现了 `on('data')`，于是每条断言都失败在
 * `req is not async iterable` 上——那是替身的问题，不是被测代码的问题。
 */
function makeRequest (body, method = 'POST') {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    // 回环 Host：isLoopbackRequest 会解析它并据此做同源判定。
    headers: { host: '127.0.0.1:5173' },
    async * [Symbol.asyncIterator] () {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  return req
}

/** 造一个收集输出的 res。 */
function makeResponse () {
  const out = { status: 0, body: undefined, headers: {} }
  const res = {
    statusCode: 0,
    setHeader (name, value) { out.headers[name] = value },
    writeHead (status, headers) { out.status = status; Object.assign(out.headers, headers ?? {}); return res },
    end (chunk) {
      if (out.status === 0) out.status = res.statusCode
      if (typeof chunk === 'string' && chunk !== '') out.body = JSON.parse(chunk)
      return res
    },
  }
  return { res, out }
}

/** 调一个端点，返回解析后的 body。 */
async function post (path, body) {
  const route = byPath.get(path)
  const req = makeRequest(body)
  const { res, out } = makeResponse()
  await route.handler(req, res)
  return out.body ?? { ok: false, code: 'no-body', message: 'handler wrote nothing' }
}

/**
 * 判定用共享检查器，不手写驱动。
 *
 * 好处不是省几行：`check-harness.mjs` 的规则是「截止时间只抓卡死，不是判定」
 * ——手写驱动会把一个只是慢的检查记成 FAIL 并置退出码，负载高的机器上于是
 * 同一棵树连着跑先红后绿，绿也就不再说明任何事。这套用例里每条都只是同步
 * 的文件读写加内存调用，本来快；但那个错一旦复制进来就会跟着下一次复制走。
 */
const results = []
const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 拿一个真的空画布 + 一个真提案（走 Agent 工具，不手写 change 形状）。 */
async function seed (title) {
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title }, {})
  const view = await registered.get('add_canvas_node').execute({
    canvas_id: created.id, type: 'config', title: '出图', prompt: '凌晨的海面',
  }, {})
  return { canvasId: created.id, proposalId: view.proposalId, nodeId: view.nodes.find(node => node.title === '出图').id }
}

// --------------------------------------------------------------- 断言

check('R1 list returns the pending change and nothing has been written', async () => {
  const { canvasId, proposalId } = await seed('列表')
  const listed = await post(PROPOSALS, { canvasId })
  assert.equal(listed.ok, true, `list should succeed: ${JSON.stringify(listed)}`)
  assert.equal(listed.proposals.length, 1)
  assert.equal(listed.proposals[0].id, proposalId)
  assert.equal(listed.proposals[0].tool, 'add_canvas_node')
  assert.match(listed.proposals[0].summary, /节点/, 'the summary is user-facing copy, not a tool name')
  // 关键：列一次不该顺带落盘。
  assert.equal((await canvasStore.read(canvasId)).nodes.length, 0, 'listing must not touch the canvas')
})

check('R2 an empty canvas id yields only the counts, never someone else\'s proposals', async () => {
  // 曾经的断言是「空 id 报 bad-request」。改成允许它是为了一个具体场景：
  // 用户一份画布都没打开时，下拉仍要显示「有 N 条待确认」——那些计数跟当前
  // 打开的是哪一本无关。允许空 id 的代价必须钉住：不能顺便把别的画布的提案
  // 一起交出去。
  const { canvasId, proposalId } = await seed('空 id 对照')
  const empty = await post(PROPOSALS, {})
  assert.equal(empty.ok, true, `an empty id is allowed now: ${JSON.stringify(empty)}`)
  assert.equal(empty.proposals.length, 0, 'no proposals are returned for an empty id')
  assert.equal(empty.counts[canvasId], 1, 'but the per-canvas counts are still there')

  // 空 id 不能当通配符用：接受请求里的 id 对不上就什么都不该发生。
  const accepted = await post(ACCEPT, { canvasId: '', proposalId })
  assert.equal(accepted.ok, false, 'accepting with an empty canvas id must fail')
  assert.equal((await post(PROPOSALS, { canvasId })).proposals.length, 1, 'the proposal is untouched')
})

check('R3 accept writes the node, then the proposal is gone', async () => {
  const { canvasId, proposalId, nodeId } = await seed('接受')
  const accepted = await post(ACCEPT, { canvasId, proposalId })
  assert.equal(accepted.ok, true, `accept should succeed: ${JSON.stringify(accepted)}`)
  assert.equal(accepted.document.nodes.length, 1)
  assert.equal(accepted.document.nodes[0].id, nodeId)
  assert.equal(accepted.document.nodes[0].metadata.prompt, '凌晨的海面')

  // 落盘了
  const stored = await canvasStore.read(canvasId)
  assert.equal(stored.nodes.length, 1, 'accepting is the only path that writes')
  // 提案没了
  const after = await post(PROPOSALS, { canvasId })
  assert.equal(after.proposals.length, 0, 'an accepted proposal must not stay on the bar')
})

check('R4 accepting twice is refused instead of writing the node twice', async () => {
  const { canvasId, proposalId } = await seed('重复接受')
  const first = await post(ACCEPT, { canvasId, proposalId })
  assert.equal(first.ok, true)
  const second = await post(ACCEPT, { canvasId, proposalId })
  assert.equal(second.ok, false, 'the second accept must not run')
  assert.equal(second.code, 'not-found')
  assert.equal((await canvasStore.read(canvasId)).nodes.length, 1, 'still exactly one node')
})

check('R5 accepting one of several proposals does not invalidate the rest', async () => {
  // 这条断言替换掉了一条**错误的**断言。
  //
  // 我最初的设计让每条提案钉住 baseRevision，接受时严格比对。看起来像是
  // 「不覆盖用户编辑」，实际上砸在最常见的路径上：Agent 一次任务连着提议三条
  // （加节点、加配置节点、连线），三条的 baseRevision 都是 1。用户接受第一条后
  // revision 变成 2，第二三条全部被判过期——界面写着「还有 2 条在后面」，却
  // 一条都点不动。
  //
  // 正确的不变量是：**接受一条不该让后面的作废**。覆盖用户编辑这件事由
  // `apply` 的增量语义 + `save(next, current.revision)` 的乐观锁分别负责。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '三条' }, {})
  let view = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'A' }, {})
  const a = view.nodes.find(node => node.title === 'A').id
  view = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'config', title: 'C' }, {})
  const c = view.nodes.find(node => node.title === 'C').id
  await registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: c }, {})

  const pending = await post(PROPOSALS, { canvasId: created.id })
  assert.equal(pending.proposals.length, 3, 'three separate steps')
  assert.equal(pending.proposals[0].baseRevision, pending.proposals[2].baseRevision,
    'they all share the revision they were drafted on — which is exactly why comparing it cannot work')

  // 按顺序全接受。每一条都必须成功。
  for (const [index, proposal] of pending.proposals.entries()) {
    const accepted = await post(ACCEPT, { canvasId: created.id, proposalId: proposal.id })
    assert.equal(accepted.ok, true, `proposal #${index + 1} (${proposal.tool}) must still apply: ${JSON.stringify(accepted)}`)
  }

  const final = await canvasStore.read(created.id)
  assert.equal(final.nodes.length, 2, 'both nodes landed')
  assert.equal(final.connections.length, 1, 'the wire landed, so it could see the node from the earlier proposal')
  assert.equal(final.connections[0].fromNodeId, a)
  assert.equal(final.connections[0].toNodeId, c)
})

check('R5b a user edit made after the proposal is not reverted by accepting it', async () => {
  // baseRevision 不再被当作闸门，所以必须单独证明「用户的编辑不会被我回退」。
  // 这是去掉那道比较之后唯一真正的风险点。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '不覆盖' }, {})
  const view = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'Agent 想加的' }, {})
  const proposalId = view.proposalId

  // 用户在接受之前：改标题、并另加一个自己的节点。
  const before = await canvasStore.read(created.id)
  await canvasStore.save({
    ...before,
    title: '用户改的标题',
    nodes: [...before.nodes, { id: 'user-own', type: 'text', title: '用户自己加的', x: 0, y: 0, width: 200, height: 80 }],
  }, before.revision)

  const accepted = await post(ACCEPT, { canvasId: created.id, proposalId })
  assert.equal(accepted.ok, true, 'the proposal still applies onto the newer document')

  const after = await canvasStore.read(created.id)
  assert.equal(after.title, '用户改的标题', "the user's title survives")
  assert.ok(after.nodes.some(node => node.id === 'user-own'), "the user's own node survives")
  assert.ok(after.nodes.some(node => node.title === 'Agent 想加的'), 'and the proposed node landed alongside it')
  assert.equal(after.nodes.length, 2, 'nothing was duplicated or dropped')
})

check('R5c a proposal whose node was deleted is still refused', async () => {
  // 这是现在唯一还会被判「过期」的情形：提案点名的节点已经不在了。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '幽灵2' }, {})
  const before = await canvasStore.read(created.id)
  const seeded = await canvasStore.save({
    ...before,
    nodes: [{ id: 'gone', type: 'text', title: '会被删掉', x: 0, y: 0, width: 200, height: 80 }],
  }, before.revision)
  await registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: 'gone', title: '改过的' }, {})

  // 用户在接受之前把它删了。
  await canvasStore.save({ ...seeded, nodes: [] }, seeded.revision)

  const pending = await post(PROPOSALS, { canvasId: created.id })
  assert.equal(pending.proposals.length, 1)
  const accepted = await post(ACCEPT, { canvasId: created.id, proposalId: pending.proposals[0].id })
  assert.equal(accepted.ok, false)
  assert.equal(accepted.code, 'proposal-stale')
  assert.match(accepted.message, /不在画布上|被删掉/, 'the message must say what happened')
  assert.equal((await canvasStore.read(created.id)).nodes.length, 0)
})

check('R6 a proposal cannot be accepted onto another canvas', async () => {
  const a = await seed('画布A')
  const b = await seed('画布B')
  // 拿 A 的提案 id 去 B 上接受。
  const accepted = await post(ACCEPT, { canvasId: b.canvasId, proposalId: a.proposalId })
  assert.equal(accepted.ok, false, 'cross-canvas accept must be refused')
  assert.equal(accepted.code, 'not-found')
  assert.equal((await canvasStore.read(b.canvasId)).nodes.length, 0, 'canvas B is untouched')
  assert.equal((await canvasStore.read(a.canvasId)).nodes.length, 0, 'canvas A is untouched too')
})

check('R7 discard removes one, discard-all removes the rest, canvas never changes', async () => {
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '丢弃' }, {})
  await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '一' }, {})
  await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '二' }, {})
  await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '三' }, {})
  const before = await post(PROPOSALS, { canvasId: created.id })
  assert.equal(before.proposals.length, 3)

  const one = await post(DISCARD, { canvasId: created.id, proposalId: before.proposals[0].id })
  assert.equal(one.ok, true)
  assert.equal(one.discarded, 1)
  assert.equal((await post(PROPOSALS, { canvasId: created.id })).proposals.length, 2)

  // 不带 proposalId = 全部丢弃
  const all = await post(DISCARD, { canvasId: created.id })
  assert.equal(all.ok, true)
  assert.equal(all.discarded, 2)
  assert.equal((await post(PROPOSALS, { canvasId: created.id })).proposals.length, 0)
  assert.equal((await canvasStore.read(created.id)).nodes.length, 0, 'discarding never wrote a node')
})

check('R8 discarding an unknown proposal reports it instead of pretending', async () => {
  const { canvasId } = await seed('不存在')
  const result = await post(DISCARD, { canvasId, proposalId: 'not-a-real-id' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-found')
})

check('R9 a proposal from another canvas is invisible to this one', async () => {
  const a = await seed('隔离A')
  const b = await seed('隔离B')
  const listA = await post(PROPOSALS, { canvasId: a.canvasId })
  const listB = await post(PROPOSALS, { canvasId: b.canvasId })
  assert.equal(listA.proposals.length, 1)
  assert.equal(listB.proposals.length, 1)
  assert.notEqual(listA.proposals[0].id, listB.proposals[0].id)
  assert.equal(listA.proposals[0].canvasId, a.canvasId)
  assert.equal(listB.proposals[0].canvasId, b.canvasId)
})

check('R10 the project list carries how many changes are waiting per canvas', async () => {
  // 提案条只显示**当前打开**那本画布的待确认改动。Agent 在别的画布上提了改动、
  // 用户切走之后就再也看不见它们——列表接口把这个数带出来，下拉里才能标一句
  // 「有 N 条待确认」。计数必须来自一次 readdir，且不该把没提案的画布写上 0。
  const { canvasId } = await seed('待确认计数')
  // 对照组必须是**真的一点提案都没有**的画布。不能用 seed()：它为了拿到提案
  // 会先提一条，于是「安静」的画布自己就带着 1 条。用工具直接建一个空画布。
  const quietRegistered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { quietRegistered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const quiet = await quietRegistered.get('create_canvas').execute({ title: '安静的' }, {})

  const listed = await post(LIST, {})
  assert.equal(listed.ok, true, `list should succeed: ${JSON.stringify(listed)}`)
  const busy = listed.projects.find(project => project.id === canvasId)
  const calm = listed.projects.find(project => project.id === quiet.id)
  assert.ok(busy !== undefined && calm !== undefined, 'both canvases are in the list')
  assert.equal(busy.proposalCount, 1, 'the canvas with a pending change says so')
  assert.equal(calm.proposalCount, undefined, 'a canvas with nothing waiting carries no count at all')

  // 接受之后计数要回到「没有」——否则下拉会一直留着一个已经处理完的标记。
  const accepted = await post(ACCEPT, { canvasId, proposalId: busy.proposalCount === undefined ? '' : (await post(PROPOSALS, { canvasId })).proposals[0].id })
  assert.equal(accepted.ok, true, `accept should succeed: ${JSON.stringify(accepted)}`)
  const after = await post(LIST, {})
  const cleaned = after.projects.find(project => project.id === canvasId)
  assert.equal(cleaned.proposalCount, undefined, 'the count disappears once nothing is waiting')
})

// --------------------------------------------------------------- driver

try {
  const run = createCheckHarness({ results })
  for (const { name, fn } of checks) await run(name, fn)

  // 结果一次打完：harness 只往 `results` 里压行，打印与汇总归调用方。
  for (const line of results) (line.startsWith('FAIL') ? console.error : console.log)(line)
} finally {
  // 放在 finally：某条检查意外抛出（harness 之外的错误）时也不留临时目录。
  rmSync(home, { recursive: true, force: true })
}

const failed = results.filter(line => line.startsWith('FAIL')).length
const passed = results.length - failed
if (failed > 0) {
  console.error(`\ncanvas proposal routes: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas proposal routes: ${passed} passed`)

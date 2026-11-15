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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // 报完错还要把自己从队列里拿走：否则它永远卡在队首，而界面只让用户点队首
  // 那一条——后面本来能应用的提案全被它挡住，用户只能自己想到去点「丢弃」。
  const after = await post(PROPOSALS, { canvasId: created.id })
  assert.equal(after.proposals.length, 0, 'a stale proposal is removed so it stops blocking the queue')
})

check('R5d a stale proposal no longer blocks the ones queued behind it', async () => {
  // 探针实测过的死锁：过期提案在队首，用户连点三次「接受」都是同一条
  // proposal-stale，队列一动不动。R5c 钉住了「它会被移除」，这里钉住那个
  // 移除**换来**的东西：后面的提案立刻能应用。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '队首卡住' }, {})
  const before = await canvasStore.read(created.id)
  const seeded = await canvasStore.save({
    ...before,
    nodes: [{ id: 'doomed', type: 'text', title: '会被删掉', x: 0, y: 0, width: 200, height: 80 }],
  }, before.revision)

  // 第 1 条：改那个即将被删的节点。第 2 条：加一个新节点（本身没问题）。
  await registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: 'doomed', title: '改过的' }, {})
  await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '后来的' }, {})

  // 用户删掉 doomed，第 1 条于是永远对不上。
  await canvasStore.save({ ...seeded, nodes: [] }, seeded.revision)

  const queue = (await post(PROPOSALS, { canvasId: created.id })).proposals
  assert.equal(queue.length, 2)
  assert.equal(queue[0].tool, 'update_canvas_node', 'the stale one is at the head')

  const refused = await post(ACCEPT, { canvasId: created.id, proposalId: queue[0].id })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'proposal-stale')

  // 队列已经往前走了：第 2 条现在能接受，并且真的写进去了。
  const rest = (await post(PROPOSALS, { canvasId: created.id })).proposals
  assert.equal(rest.length, 1, 'the stale head is gone')
  const accepted = await post(ACCEPT, { canvasId: created.id, proposalId: rest[0].id })
  assert.equal(accepted.ok, true, `the proposal behind it must apply: ${JSON.stringify(accepted)}`)
  const final = await canvasStore.read(created.id)
  assert.equal(final.nodes.length, 1, 'the later proposal landed')
  assert.equal(final.nodes[0].title, '后来的')
})

check('R5f a proposal with a non-string title never reaches the queue', async () => {
  // 探针复现：一条 `change.title` 是数字的提案（老版本写的、或手工改过的），
  // 读得出来、排进队列，接受时 `apply` 成功返回，`store.save` 却抛
  // 「malformed canvas document」——所以「应用不了就自己出队」那条路走不到
  // 它。它永久占着队首，用户点多少次都是同一条错误，后面本来能用的提案全被
  // 挡住。现在读取时就按坏文件跳过。
  const { canvasId, proposalId } = await seed('坏标题')
  const dir = join(home, 'dsh-imagegen', 'canvas', 'proposals')
  const document = await canvasStore.read(canvasId)
  writeFileSync(join(dir, 'bad-title.json'), JSON.stringify({
    id: 'bad-title', canvasId, tool: 'update_canvas_node',
    summary: '改名为「3」', counts: { title: 3 },
    baseRevision: document.revision, createdAt: Date.now() - 1000,
    change: { title: 3 },
  }))

  const listed = await post(PROPOSALS, { canvasId })
  assert.equal(listed.proposals.length, 1, 'the malformed proposal must not be listed')
  assert.equal(listed.proposals[0].id, proposalId, 'only the healthy one is queued')
  assert.equal(listed.counts[canvasId], 1, 'nor counted in the dropdown badge')

  // 队首那条（健康的）照常能接受，写进画布。
  const accepted = await post(ACCEPT, { canvasId, proposalId })
  assert.equal(accepted.ok, true, `the healthy proposal must still apply: ${JSON.stringify(accepted)}`)
  assert.equal((await canvasStore.read(canvasId)).nodes.length, 1)
  // 坏文件留在磁盘上不动——读不懂就不动它，与 scan 的其余字段一致。
  assert.equal(readFileSync(join(dir, 'bad-title.json'), 'utf8').includes('"title":3'), true)
})

check('R5g a proposal whose result would be an invalid document is removed, not retried forever', async () => {
  // 读入时的校验只看形状，挡不住「补丁里字段类型是错的」：`isPatchShape` 只
  // 要求 `fields` 是对象，`fields.title` 是 3 一样能进来。它通过读取、排到
  // 队首，`apply` 成功返回，`store.save` 却因为节点标题不是字符串抛
  // 「malformed canvas document」——与那条坏 title 提案同一个死锁，只是这道
  // 门更靠后。所以接受路径自己也要用文档校验器验一遍，不合格按「永远应用
  // 不了」处理：移除、如实报错、把队首让给后面的。
  // 补丁要改的节点必须真的在画布上，否则 `apply` 会因为「节点不存在」先返回
  // undefined，第二道校验根本执行不到——那样这条用例测的就不是它要测的东西。
  const { canvasId, proposalId } = await seed('坏补丁')
  const dir = join(home, 'dsh-imagegen', 'canvas', 'proposals')
  const seeded = await canvasStore.read(canvasId)
  await canvasStore.save({
    ...seeded,
    nodes: [{ id: 'target', type: 'text', title: '原文', x: 0, y: 0, width: 200, height: 80 }],
  }, seeded.revision)
  const document = await canvasStore.read(canvasId)
  // 第 1 条提案添加的节点 id（健康那条要应用的就是它）。
  const addedNodeId = (await proposalStore.list(canvasId))[0].change.addedNodes[0].id
  // createdAt 更小 → 排在健康那条前面，正是会堵住队列的位置。
  writeFileSync(join(dir, 'bad-patch.json'), JSON.stringify({
    id: 'bad-patch', canvasId, tool: 'update_canvas_node',
    summary: '重命名节点', counts: { updatedNodes: 1 },
    baseRevision: document.revision, createdAt: Date.now() - 1000,
    change: { updatedNodes: [{ id: 'target', fields: { title: 3 } }] },
  }))

  const listed = await post(PROPOSALS, { canvasId })
  assert.equal(listed.proposals.length, 2, 'a well-formed patch is read in even if its values are not')
  assert.equal(listed.proposals[0].id, 'bad-patch', 'it sits at the head')

  const refused = await post(ACCEPT, { canvasId, proposalId: 'bad-patch' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'proposal-stale', `a document the store would reject can never apply: ${JSON.stringify(refused)}`)
  // 用户不需要自己想到去点「丢弃」：队首已经让出来了。
  const rest = (await post(PROPOSALS, { canvasId })).proposals
  assert.equal(rest.length, 1)
  assert.equal(rest[0].id, proposalId)
  const accepted = await post(ACCEPT, { canvasId, proposalId })
  assert.equal(accepted.ok, true, `the one behind it must apply: ${JSON.stringify(accepted)}`)
  const final = await canvasStore.read(canvasId)
  // 第 1 条提案加的是「出图」，第 2 条改成「原文」——两个节点都在。
  assert.equal(final.nodes.length, 2)
  const byId = new Map(final.nodes.map(node => [node.id, node]))
  assert.equal(byId.get('target').title, '原文', 'the bad patch never wrote its number into the node')
  assert.equal(byId.get(addedNodeId).title, '出图', 'the good node landed unchanged')
})

check('R5h a connection patch naming a role this build does not know is skipped as a bad file', async () => {
  // `updatedConnections` 是新字段，`role` 会经 `withRole` 原样写进文档。手改过
  // 的 JSON、或将来加了新角色又回退版本时，磁盘上可能出现本版本不认的角色。
  // 读入时就当坏文件跳过，而不是让它进队列、接受后把坏值写进连线——那时画布
  // 渲染只会把它当 `input`（`roleOf` 的兜底），用户看不到任何报错，却也没拿到
  // 自己设的角色。
  const { canvasId, proposalId } = await seed('坏角色')
  const dir = join(home, 'dsh-imagegen', 'canvas', 'proposals')
  const document = await canvasStore.read(canvasId)
  writeFileSync(join(dir, 'bad-role.json'), JSON.stringify({
    id: 'bad-role', canvasId, tool: 'connect_canvas_nodes',
    summary: '改角色', counts: { updatedConnections: 1 },
    baseRevision: document.revision, createdAt: Date.now() - 1000,
    change: { updatedConnections: [{ id: 'edge-x', role: 'middle' }] },
  }))

  const listed = await post(PROPOSALS, { canvasId })
  assert.equal(listed.proposals.length, 1, 'the unknown role must not reach the queue')
  assert.equal(listed.proposals[0].id, proposalId, 'only the healthy one is queued')
})

check('F17 removing a node also drops it from any group it belonged to', async () => {
  // 用户在画布上把几个节点框成一组，Agent 只认识节点与连线，删掉其中一个后
  // 组里就留下指向不存在节点的 id。探针实测过：`groups[0].nodeIds` 仍是
  // 两个 id，其中一个是死的。画布自己删节点走 `pruneGroupsField`，提案这条
  // 路径漏了它。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '分组' }, {})
  for (const title of ['A', 'B']) {
    const view = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title }, {})
    await proposalStore.acceptOne(created.id, view.proposalId)
  }
  const seeded = await canvasStore.read(created.id)
  const ids = seeded.nodes.map(node => node.id)
  await canvasStore.save({
    ...seeded,
    groups: [{ id: 'g1', title: '镜头一', nodeIds: ids }],
  }, seeded.revision)

  const removed = await registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: ids[0] }, {})
  assert.equal((await proposalStore.acceptOne(created.id, removed.proposalId)).ok, true)

  const after = await canvasStore.read(created.id)
  assert.deepEqual(after.groups?.[0]?.nodeIds, [ids[1]], 'the deleted node is gone from the group')

  // 组里最后一个成员也删掉时，整个组该消失（`pruneGroups` 的语义），而不是
  // 留下一个零成员的框。
  const last = await registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: ids[1] }, {})
  await proposalStore.acceptOne(created.id, last.proposalId)
  assert.equal((await canvasStore.read(created.id)).groups, undefined, 'an emptied group leaves no field behind')
})

check('F18 pruning groups never invents the field on a canvas that never had one', async () => {
  // 1429 份老画布都没有 `groups` 字段。第一次删节点就写出一个 `groups: []`
  // 等于改写了每一份用户文档——这与 `withRole(x, 'input')` 删字段同一策略。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '没分组' }, {})
  const added = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'A' }, {})
  await proposalStore.acceptOne(created.id, added.proposalId)
  const nodeId = (await canvasStore.read(created.id)).nodes[0].id
  assert.equal((await canvasStore.read(created.id)).groups, undefined)

  const removed = await registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: nodeId }, {})
  await proposalStore.acceptOne(created.id, removed.proposalId)
  const after = await canvasStore.read(created.id)
  assert.equal(after.groups, undefined, 'no groups key appeared')
  assert.equal(Object.hasOwn(after, 'groups'), false, 'nor a key holding undefined')
})

check('F19 omitting x/y puts the node in a new column instead of stacking at the origin', async () => {
  // 工具说明写着「Omit x/y to place it in a free column to the right of the
  // existing nodes」，实现却把缺省钉成 0,0——探针实测 A/B/C 三个节点坐标全
  // 是 (0,0)，Agent 加几个用户就只能看到最上面那一个。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '摆放' }, {})
  const first = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'A' }, {})
  await proposalStore.acceptOne(created.id, first.proposalId)
  assert.equal(first.nodes[0].x, 0, 'the first node starts at the origin')

  const second = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'B' }, {})
  const b = second.nodes.find(node => node.title === 'B')
  assert.ok(b.x > first.nodes[0].x + first.nodes[0].width, `B must land to the right of A, not on top of it: ${b.x}`)
  assert.equal(b.y, 0)

  // 模型给了坐标就照用，不能被自动摆放覆盖。
  const placed = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'C', x: -400, y: 250 }, {})
  const c = placed.nodes.find(node => node.title === 'C')
  assert.equal(c.x, -400)
  assert.equal(c.y, 250)
})

check('F20 the size arguments the node builder honours are declared in the schema', async () => {
  // `createNode` 一直在读 `width` / `height`，但 `add_canvas_node` 的 schema 里
  // 没有它们。这不是「能不能用」的问题——传了确实生效——而是模型只能靠猜。
  // 声明与实现的这一处偏差，测的是「模型读得到的契约」与「代码真正接受的
  // 参数」是同一份。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const properties = registered.get('add_canvas_node').parameters.properties
  assert.equal(properties.width?.type, 'number', 'width is honoured, so it must be declared')
  assert.equal(properties.height?.type, 'number', 'height is honoured, so it must be declared')

  const created = await registered.get('create_canvas').execute({ title: '尺寸' }, {})
  const view = await registered.get('add_canvas_node').execute({
    canvas_id: created.id, type: 'image', title: '宽一点', width: 900, height: 600,
  }, {})
  assert.equal(view.nodes[0].width, 900, 'the declared argument actually takes effect')
  assert.equal(view.nodes[0].height, 600)
})

check('F21 a config node says what it produces, and the Agent can make a video one', async () => {
  // config 节点的 `mode` 决定按 run 出什么（image / video / text）。两处缺口：
  // 投影不带给模型（它只看到「这是个 config」），以及 `createNode` 里那句
  // 「metadata.mode 没设就写成 image」——`metadata.mode` 此前从来没被赋过值，
  // 于是恒为真，Agent 根本造不出视频配置节点。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '模式' }, {})

  const plain = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'config', title: '出图', prompt: '灯塔' }, {})
  assert.equal(plain.nodes[0].mode, 'image', 'the default still reads as image')

  const video = await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'config', title: '插帧', mode: 'video' }, {})
  assert.equal(video.nodes.find(node => node.title === '插帧').mode, 'video', 'a video config node is expressible')
  assert.equal((await registered.get('read_canvas').execute({ canvas_id: created.id }, {})).nodes.find(node => node.title === '插帧').mode, 'video',
    'and read_canvas reports it back')

  // 非法值由参数 schema 的 enum 挡下（宿主在调用前就拒），比工具里再校验
  // 更早。这里断言的是「有东西挡住了」，具体措辞交给框架。
  await assert.rejects(
    async () => await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'config', title: '错的', mode: 'audio' }, {}),
    /mode.*(image|enum)|Unknown config mode/,
  )
})

check('R5e proposals made back to back come back in the order they were proposed', async () => {
  // 探针实测过的重排：Agent 一次任务连发几条提案，它们常落在同一毫秒里，
  // 而 `scan` 的 tie-break 是 `id.localeCompare`——uuid 是随机的，于是顺序
  // 也跟着随机（八次里两次被重排）。用户看到的是「先加节点、再连线」被翻成
  // 「先连线、后加节点」。
  const registered = new Map()
  registerAgentCanvasTools({ tools: { register (definition) { registered.set(definition.name, definition); return () => {} } } }, () => ({ enabled: true }))
  const created = await registered.get('create_canvas').execute({ title: '连续提案' }, {})
  const titles = ['第一步', '第二步', '第三步', '第四步', '第五步']
  for (const title of titles) {
    await registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title }, {})
  }
  const queue = (await post(PROPOSALS, { canvasId: created.id })).proposals
  assert.deepEqual(
    queue.map(proposal => proposal.change.addedNodes[0].title),
    titles,
    'proposals must arrive in the order they were made, ties in timestamp included',
  )
  // 时间戳本身必须严格递增：相等就说明还在靠 uuid 兜底。
  for (let index = 1; index < queue.length; index += 1) {
    assert.ok(queue[index].createdAt > queue[index - 1].createdAt,
      `proposal ${index} did not get a later timestamp than the one before it`)
  }
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

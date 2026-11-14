/**
 * Canvas Agent tools: the shape of what the Agent may and may not do.
 *
 * What this suite guards:
 *
 *  A*  the tools register and unregister — a disposer that leaves a tool behind
 *      keeps offering the model a verb after the plugin was turned off.
 *  B*  structure writes become **proposals**: the saved canvas is untouched, the
 *      draft the model sees has the change, and a no-op edit proposes nothing.
 *  C*  accepting is a separate act: only `proposalStore.acceptOne` writes, and a
 *      proposal whose nodes are gone is refused instead of applied.
 *  D*  **no tool can start a render.** This is the product boundary, asserted by
 *      scanning the registered names and schemas rather than by reminding people
 *      in a comment: an Agent that can spend money on its own is not a feature,
 *      it is an incident.
 *  E*  actionable failures — unknown node, unknown canvas, self-connection.
 *  F*  the proposal lifecycle, including the one that used to be broken: a run
 *      of proposals must be acceptable **one after another**, not just the first.
 *
 * Run: node scripts/smoke-canvas-agent.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// The data root is resolved when `canvas-store.ts` is first imported, and it
// reads DSH_HOME at that moment. Point it at a throwaway directory BEFORE any
// src/ import, or the suite would create canvases in the user's real library.
const home = mkdtempSync(join(tmpdir(), 'gal-canvas-agent-'))
process.env.DSH_HOME = home

// The canvas store uses TypeScript parameter properties, which Node's
// strip-only loader refuses. Import the built bundle instead — the same thing
// the other route-level suites do, and it means this exercises shipped bytes.
const { registerAgentCanvasTools } = await import('../lib/index.js')
const { canvasStore, proposalStore, ProposalStore } = await import('../lib/index.js')

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

/** A host context that records what the tools register. */
function stubContext() {
  const registered = new Map()
  const disposers = []
  return {
    ctx: {
      tools: {
        register(definition) {
          registered.set(definition.name, definition)
          const dispose = () => registered.delete(definition.name)
          disposers.push(dispose)
          return dispose
        },
      },
    },
    registered,
    disposers,
  }
}

const enabledConfig = () => ({ enabled: true })

// ------------------------------------------------------------ A registration

check('A1 the eight canvas tools register and the disposer removes them', async () => {
  const stub = stubContext()
  const dispose = registerAgentCanvasTools(stub.ctx, enabledConfig)
  const names = [...stub.registered.keys()].sort()
  assert.deepEqual(names, [
    'add_canvas_node',
    'connect_canvas_nodes',
    'create_canvas',
    'disconnect_canvas_nodes',
    'list_canvases',
    'read_canvas',
    'remove_canvas_node',
    'update_canvas_node',
  ])
  dispose()
  assert.equal(stub.registered.size, 0, 'disposing must unregister every tool')
})

// ------------------------------------------------------------ D no renders

check('D1 no canvas tool can start a render', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const forbidden = /^(generate|render|run|submit|cancel|retry)_|_generation|^generate_/
  for (const [name, definition] of stub.registered) {
    assert.ok(!forbidden.test(name), `tool ${name} looks like it starts or stops a render`)
    const blob = `${definition.description} ${JSON.stringify(definition.parameters ?? {})}`.toLowerCase()
    assert.ok(!blob.includes('wait_for_completion'), `${name} exposes wait_for_completion, which only render tools need`)
    assert.ok(!blob.includes('start a render'), `${name} claims to start a render`)
  }
  // The copy must actively say what does not happen, so the model does not try.
  const read = stub.registered.get('read_canvas')
  assert.match(read.description, /never starts a render/i)
  const add = stub.registered.get('add_canvas_node')
  assert.match(add.description, /never spends money/i, 'adding a node must say it is free')
})

check('D2 a disabled plugin refuses every tool with actionable copy', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, () => ({ enabled: false }))
  await assert.rejects(
    async () => await stub.registered.get('list_canvases').execute({}, {}),
    /plugin is disabled/i,
  )
})

// --------------------------------------------------------------- B writes

check('B1 writes become proposals; read_canvas still reports the saved canvas', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)

  const created = await stub.registered.get('create_canvas').execute({ title: 'Agent 测试画布' }, {})
  assert.equal(created.title, 'Agent 测试画布')
  assert.deepEqual(created.nodes, [], 'a new canvas starts empty')

  // 工具**回显**草稿（这样模型能看到自己刚提议的东西），但草稿不是画布。
  const afterText = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id,
    type: 'text',
    title: '脚本',
    text: '第一镜：雨夜街头',
    x: 10,
    y: 20,
  }, {})
  const textNode = afterText.nodes.find(node => node.title === '脚本')
  assert.ok(textNode !== undefined, 'the echoed draft should list the proposed node')
  assert.equal(textNode.text, '第一镜：雨夜街头', 'text travels into metadata')
  assert.equal(textNode.x, 10)
  assert.equal(textNode.y, 20)
  assert.ok(typeof afterText.proposalId === 'string' && afterText.proposalId !== '', 'the call must report a proposal id')
  assert.match(afterText.note, /PROPOSAL/i, 'the model must be told this is pending, not saved')
  assert.match(afterText.note, /Nothing was saved/i)

  // 这是本套件最要紧的一条：**磁盘上没有变**。
  const stored = await canvasStore.read(created.id)
  assert.equal(stored.nodes.length, 0, 'a proposal must never reach the saved canvas')

  // 第二条提案叠加在第一条之上：模型连着的两步才成立。
  const afterConfig = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id,
    type: 'config',
    title: '出图',
    prompt: '一只橘猫在窗台上，黄昏侧光',
    model: 'gpt-image-2',
  }, {})
  const config = afterConfig.nodes.find(node => node.title === '出图')
  assert.equal(config.prompt, '一只橘猫在窗台上，黄昏侧光')
  assert.equal(config.model, 'gpt-image-2')
  assert.equal(afterConfig.nodes.length, 2, 'the draft stacks every pending proposal')

  // 读工具读的是**真实文档**，所以它仍然说空——这正是「还没接受」该有的样子。
  const view = await stub.registered.get('read_canvas').execute({ canvas_id: created.id }, {})
  assert.equal(view.nodes.length, 0, 'read_canvas reports the saved canvas, not the proposals')
  assert.equal(view.revision, created.revision, 'reading does not bump the revision')
  assert.match(view.note, /empty/i, 'an empty saved canvas still says so')
})

check('B2 wires connect, duplicate safely, and removing a node drops its wires', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '连线' }, {})
  // 从**草稿**里取 id：节点还不存在于真实文档，但提案里已经有了。
  let view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'A' }, {})
  const a = view.nodes.find(node => node.title === 'A').id
  view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'B' }, {})
  const b = view.nodes.find(node => node.title === 'B').id

  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 1, 'one wire')

  // Connecting twice is idempotent rather than a second parallel wire. It also
  // must not produce a third empty proposal.
  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 1, 'a duplicate connection is a no-op')

  view = await stub.registered.get('disconnect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 0, 'disconnect removes the wire')

  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  view = await stub.registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: a }, {})
  assert.equal(view.nodes.length, 1, 'node removed from the draft')
  assert.equal(view.connections.length, 0, 'wires touching the removed node go with it')
  assert.equal((await canvasStore.read(created.id)).nodes.length, 0, 'still nothing on disk')
})

check('B3 update touches only the fields it was given', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '部分更新' }, {})
  let view = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id,
    type: 'config',
    title: '原题',
    prompt: '原提示词',
    model: 'seedream-5.0-pro',
  }, {})
  const id = view.nodes.find(node => node.title === '原题').id

  view = await stub.registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: id, prompt: '新提示词' }, {})
  const node = view.nodes.find(candidate => candidate.id === id)
  assert.equal(node.prompt, '新提示词')
  assert.equal(node.title, '原题', 'title untouched when not passed')
  assert.equal(node.model, 'seedream-5.0-pro', 'model untouched when not passed')
})

check('B4 an unwired canvas gets a note the model can act on', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '空图' }, {})
  const view = await stub.registered.get('read_canvas').execute({ canvas_id: created.id }, {})
  assert.match(view.note, /empty/i, 'an empty canvas should say so')
})

// ------------------------------------------------------- C optimistic lock

check('C1 a write that loses the race is refused as canvas-conflict, never silently applied', async () => {
  // 接受提案的写入走 `save(next, current.revision)`——和画布窗口同一把乐观
  // 锁。这条断言测的是那个分支**被正确分类**：两个窗口同时接受时，输的那一
  // 次必须报 `canvas-conflict`（客户端据此提示「再试一次」），而不是被当成
  // 成功，也不是被归进「提案过期」。
  //
  // 用桩注入冲突，而不是靠时序：acceptOne 读文档与写文档之间的窗口只有几
  // 微秒，靠 setTimeout 去抢会得到一条偶尔红的用例——那种用例最后总是被
  // 注释掉或加重试，等于没测。
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '并发' }, {})
  await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '提议的节点' }, {})
  const pending = await proposalStore.list(created.id)
  assert.equal(pending.length, 1)

  const real = await canvasStore.read(created.id)
  // 用真实的 store 制造冲突：先让文档往前走一个 revision，再把「读到的那一
  // 份」喂给 acceptOne——它内部 save 时会拿 current.revision 去比对，而对
  // 不上正是两个窗口同时接受时的情形。
  //
  // 这里不能只断言「revision 变了」：那是状态，不是行为。真正要钉住的是
  // acceptOne 把这个失败**归类成 canvas-conflict**，并保留提案。
  const racing = {
    read: async (id) => id === created.id ? real : undefined,
    save: async (document, expectedRevision) => {
      // 另一台窗口抢先写了一次，于是 expectedRevision 永远落后一格。
      return await canvasStore.save(document, (expectedRevision ?? 0) - 1)
    },
  }
  const result = await proposalStore.acceptOne(created.id, pending[0].id, racing)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'canvas-conflict', 'a lost race must be its own code, so the client can offer a retry')
  // 冲突时提案必须留在队列里：用户还能再点一次。
  assert.equal((await proposalStore.list(created.id)).length, 1, 'a refused write must not consume the proposal')
})

check('E1 unknown canvas, unknown node, self-connection and bad type are actionable', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '错误' }, {})

  await assert.rejects(
    async () => await stub.registered.get('read_canvas').execute({ canvas_id: 'no-such-canvas' }, {}),
    /was not found.*list_canvases/is,
  )
  await assert.rejects(
    async () => await stub.registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: 'nope', prompt: 'x' }, {}),
    /was not found/is,
  )
  await assert.rejects(
    async () => await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'nonsense' }, {}),
    /Unknown node type/,
  )
  const view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'solo' }, {})
  await assert.rejects(
    async () => await stub.registered.get('connect_canvas_nodes').execute({
      canvas_id: created.id,
      from_node_id: view.nodes[0].id,
      to_node_id: view.nodes[0].id,
    }, {}),
    /cannot connect to itself/,
  )
})

check('E2 list_canvases reports what was created, newest first', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  await stub.registered.get('create_canvas').execute({ title: '第一个' }, {})
  await stub.registered.get('create_canvas').execute({ title: '第二个' }, {})
  const list = await stub.registered.get('list_canvases').execute({}, {})
  const titles = list.map(item => item.title)
  assert.ok(titles.includes('第一个') && titles.includes('第二个'))
  assert.equal(titles[0], '第二个', 'newest canvas first, matching the canvas picker')
})

// ------------------------------------------------------- F proposal lifecycle

check('F1 a proposal applies onto the saved canvas only when accepted', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '接受' }, {})
  const view = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id, type: 'config', title: '出图', prompt: '海边的灯塔',
  }, {})
  const nodeId = view.nodes.find(node => node.title === '出图').id

  // 还没有落盘。
  assert.equal((await canvasStore.read(created.id)).nodes.length, 0)

  // 走接受路径：与路由用的是**同一个函数**（proposalStore.acceptOne）。
  //
  // WHY 不在这里自己拼一遍「读 → apply → save」：那正是这个缺陷曾经藏住的
  // 地方——测试拼的序列和路由拼的不是同一段代码，于是测试绿着、线上第二三条
  // 提案全部过期。测的必须是产品代码本身。
  const pending = await proposalStore.list(created.id)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].tool, 'add_canvas_node', 'the proposal records which tool produced it')
  assert.match(pending[0].summary, /1 个节点/, 'the summary says what it does in words')

  const accepted = await proposalStore.acceptOne(created.id, pending[0].id)
  assert.equal(accepted.ok, true, `accepting must succeed: ${accepted.ok ? '' : accepted.message}`)
  const saved = accepted.document

  assert.equal(saved.nodes.length, 1, 'accepting writes the node')
  assert.equal(saved.nodes[0].id, nodeId)
  assert.equal(saved.nodes[0].metadata.prompt, '海边的灯塔', 'the prompt survives the round trip')
  assert.equal((await proposalStore.list(created.id)).length, 0, 'an accepted proposal is gone')
})

check('F2 discarding a proposal leaves the canvas untouched', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '丢弃' }, {})
  await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '不想要' }, {})

  const discarded = await proposalStore.clear(created.id)
  assert.equal(discarded, 1)
  assert.equal((await proposalStore.list(created.id)).length, 0)
  assert.equal((await canvasStore.read(created.id)).nodes.length, 0, 'discarding never wrote anything')
})

check('F3 a proposal that references a deleted node cannot be applied', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '幽灵' }, {})
  // 先落一个真实节点，再提一个针对它的修改。
  const real = await canvasStore.read(created.id)
  const seeded = { ...real, nodes: [{ id: 'gone', type: 'text', title: '会被删掉', x: 0, y: 0, width: 200, height: 80 }] }
  const withNode = await canvasStore.save(seeded, real.revision)

  await stub.registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: 'gone', title: '改过的' }, {})
  const pending = await proposalStore.list(created.id)
  assert.equal(pending.length, 1)

  // 用户在接受之前把这个节点删了。
  await canvasStore.save({ ...withNode, nodes: [] }, withNode.revision)

  const current = await canvasStore.read(created.id)
  assert.equal(ProposalStore.apply(current, pending[0].change), undefined,
    'applying onto a document without the node must fail, not silently no-op')
})

check('F4 a no-op edit produces no proposal', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '空操作' }, {})
  const view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '已有' }, {})
  const nodeId = view.nodes.find(node => node.title === '已有').id
  const before = (await proposalStore.list(created.id)).length

  // 把标题改成它已经是的样子：不该再叠一条待确认项打断用户。
  const again = await stub.registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: nodeId, title: '已有' }, {})
  assert.equal(again.proposalId, undefined, 'a no-op must not report a proposal id')
  assert.match(again.note, /changed nothing/i)
  assert.equal((await proposalStore.list(created.id)).length, before, 'no new proposal was stored')
})

check('F5 removing a node in a proposal also drops its wires', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '连带删线' }, {})
  let view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'A' }, {})
  const a = view.nodes.find(node => node.title === 'A').id
  view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'B' }, {})
  const b = view.nodes.find(node => node.title === 'B').id
  await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  await stub.registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: a }, {})

  // 把所有提案依次应用到空文档上，结果应当只剩 B、没有线。
  const pending = await proposalStore.list(created.id)
  let doc = await canvasStore.read(created.id)
  for (const proposal of pending) {
    const next = ProposalStore.apply(doc, proposal.change)
    assert.ok(next !== undefined, `proposal ${proposal.tool} must apply in order`)
    doc = next
  }
  assert.equal(doc.nodes.length, 1)
  assert.equal(doc.nodes[0].id, b)
  assert.equal(doc.connections.length, 0, 'no wire may point at a removed node')
})

check('F5b apply itself drops wires that touch a removed node', async () => {
  // 单独测 ProposalStore.apply，不经过工具。
  //
  // WHY 需要这一条：`remove_canvas_node` 工具在草稿里**顺手**把连线也删了，
  // 所以它的提案里自带 removedConnectionIds——把 apply 的级联逻辑整段删掉，
  // 上面那条 F5 照样绿。级联在这里是第二道闸：提案文件是磁盘上的 JSON，
  // 可以被手工编辑、被旧版本写入、被将来的工具产生而不删连线。让 apply 自己
  // 兜住，才不依赖「每个工具都记得」。
  const canvas = {
    version: 2, id: 'f5b', title: 't', revision: 1,
    viewport: { x: 0, y: 0, k: 1 }, background: 'lines',
    nodes: [
      { id: 'A', type: 'text', title: 'A', x: 0, y: 0, width: 200, height: 80 },
      { id: 'B', type: 'image', title: 'B', x: 240, y: 0, width: 200, height: 200 },
    ],
    connections: [
      { id: 'e1', fromNodeId: 'A', toNodeId: 'B' },
      { id: 'e2', fromNodeId: 'B', toNodeId: 'A' },
    ],
    createdAt: 0, updatedAt: 0,
  }
  const next = ProposalStore.apply(canvas, { removedNodeIds: ['A'] })
  assert.ok(next !== undefined)
  assert.equal(next.nodes.length, 1, 'A is gone')
  assert.equal(next.connections.length, 0, 'every wire touching A must go with it, without the tool having to say so')
})

check('F7 a run of proposals is acceptable one after another, not just the first', async () => {
  // 这是本套件里最重要的一条回归：它描述的是 Agent 的**正常**用法，而不是
  // 边角情况。一次任务里模型连着三步——加文本节点、加配置节点、把两者连起
  // 来——三条提案的 baseRevision 都是提议那一刻的 revision。
  //
  // 这里曾经比 `current.revision === proposal.baseRevision` 来判过期，于是
  // 用户接受第一条后 revision +1，第二三条全部被判过期：界面写着「还有 2 条
  // 在后面」，实际一条都点不动，画布上留下一个孤零零的节点和一串点不动的
  // 提示。断言写成「整串都要能接受」，而不是「第一条能接受」——后者在缺陷
  // 存在时也是绿的。
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '连提三条' }, {})

  const v1 = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '脚本' }, {})
  const a = v1.nodes.find(node => node.title === '脚本').id
  const v2 = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'config', title: '出图', prompt: '海边灯塔' }, {})
  const b = v2.nodes.find(node => node.title === '出图').id
  await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})

  const queued = await proposalStore.list(created.id)
  assert.equal(queued.length, 3, 'three tool calls make three pending changes')
  assert.equal(new Set(queued.map(item => item.baseRevision)).size, 1,
    'they all pin the same base revision — which is exactly why comparing it would break')

  // 逐条接受，按提议顺序（界面只让点第一条，这正是它承诺的用法）。
  let revision = (await canvasStore.read(created.id)).revision
  for (const [index, proposal] of queued.entries()) {
    const result = await proposalStore.acceptOne(created.id, proposal.id)
    assert.equal(result.ok, true,
      `proposal ${index + 1}/${queued.length} (${proposal.tool}) must be acceptable, got: ${result.ok ? '' : `${result.code} — ${result.message}`}`)
    assert.ok(result.document.revision > revision, 'each acceptance advances the revision')
    revision = result.document.revision
  }

  const final = await canvasStore.read(created.id)
  assert.equal(final.nodes.length, 2, 'both proposed nodes are on the canvas')
  assert.equal(final.connections.length, 1, 'the proposed wire is there too')
  assert.equal((await proposalStore.list(created.id)).length, 0, 'the queue is drained')
})

check('F8 accepting onto a canvas the user edited keeps the user\'s edit', async () => {
  // 不比 revision 不等于允许覆盖用户的工作。用户在提议之后自己改标题、自己
  // 加了一个节点，接受提案必须把这两样都留着——这是 `apply` 的增量语义在
  // 兜底，而不是 baseRevision 比较。
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '用户也在改' }, {})
  await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '提案的' }, {})
  const pending = await proposalStore.list(created.id)

  // 用户在接受之前自己动过画布：改标题、并加了一个自己的节点。
  const mine = await canvasStore.read(created.id)
  const edited = await canvasStore.save({
    ...mine,
    title: '用户改过的标题',
    nodes: [...mine.nodes, { id: 'user-node', type: 'text', title: '用户的', x: 500, y: 0, width: 200, height: 80 }],
  }, mine.revision)

  const result = await proposalStore.acceptOne(created.id, pending[0].id)
  assert.equal(result.ok, true, `accepting must still work: ${result.ok ? '' : result.message}`)
  assert.equal(result.document.title, '用户改过的标题', 'the user\'s title survives')
  assert.ok(result.document.nodes.some(node => node.id === 'user-node'), 'the user\'s own node survives')
  assert.ok(result.document.nodes.some(node => node.title === '提案的'), 'the proposal landed too')
  assert.equal(result.document.revision, edited.revision + 1)
})

check('F6 the auto-apply escape hatch is not reachable from a tool argument', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  for (const [name, definition] of stub.registered) {
    const blob = JSON.stringify(definition.parameters ?? {})
    assert.ok(!/auto_?apply|autoApply|skip_?confirm/i.test(blob),
      `${name} exposes an auto-apply switch; a model must not be able to grant itself the permission`)
  }
})

// ------------------------------------------------------------------- driver

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
rmSync(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\ncanvas agent: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas agent: ${passed} passed`)

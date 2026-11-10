/**
 * Canvas Agent tools: the shape of what the Agent may and may not do.
 *
 * What this suite guards:
 *
 *  A*  the tools register and unregister — a disposer that leaves a tool behind
 *      keeps offering the model a verb after the plugin was turned off.
 *  B*  structure writes land in the real store: nodes, prompts, wires.
 *  C*  the optimistic lock: an edit based on a stale read fails instead of
 *      overwriting what the user just did in the canvas window.
 *  D*  **no tool can start a render.** This is the product boundary, asserted by
 *      scanning the registered names and schemas rather than by reminding people
 *      in a comment: an Agent that can spend money on its own is not a feature,
 *      it is an incident.
 *  E*  actionable failures — unknown node, unknown canvas, self-connection.
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
const { canvasStore } = await import('../lib/index.js')

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

check('B1 create, add nodes, read the graph back with prompts and positions', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)

  const created = await stub.registered.get('create_canvas').execute({ title: 'Agent 测试画布' }, {})
  assert.equal(created.title, 'Agent 测试画布')
  assert.deepEqual(created.nodes, [], 'a new canvas starts empty')

  const afterText = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id,
    type: 'text',
    title: '脚本',
    text: '第一镜：雨夜街头',
    x: 10,
    y: 20,
  }, {})
  const textNode = afterText.nodes.find(node => node.title === '脚本')
  assert.ok(textNode !== undefined, 'the text node should be listed')
  assert.equal(textNode.text, '第一镜：雨夜街头', 'text travels into metadata')
  assert.equal(textNode.x, 10)
  assert.equal(textNode.y, 20)

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

  const view = await stub.registered.get('read_canvas').execute({ canvas_id: created.id }, {})
  assert.equal(view.nodes.length, 2, 'both nodes are on the canvas')
  assert.equal(view.revision, afterConfig.revision, 'reading does not bump the revision')

  // Persisted, not just echoed: a fresh read through the store sees the same.
  const stored = await canvasStore.read(created.id)
  assert.equal(stored.nodes.length, 2)
  assert.equal(stored.nodes.find(node => node.title === '出图').metadata.prompt, '一只橘猫在窗台上，黄昏侧光')
})

check('B2 wires connect, duplicate safely, and removing a node drops its wires', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '连线' }, {})
  let view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'A' }, {})
  const a = view.nodes[0].id
  view = await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'image', title: 'B' }, {})
  const b = view.nodes.find(node => node.title === 'B').id

  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 1, 'one wire')

  // Connecting twice is idempotent rather than a second parallel wire.
  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 1, 'a duplicate connection is a no-op')

  view = await stub.registered.get('disconnect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  assert.equal(view.connections.length, 0, 'disconnect removes the wire')

  view = await stub.registered.get('connect_canvas_nodes').execute({ canvas_id: created.id, from_node_id: a, to_node_id: b }, {})
  view = await stub.registered.get('remove_canvas_node').execute({ canvas_id: created.id, node_id: a }, {})
  assert.equal(view.nodes.length, 1, 'node removed')
  assert.equal(view.connections.length, 0, 'wires touching the removed node go with it')
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
  const id = view.nodes[0].id

  view = await stub.registered.get('update_canvas_node').execute({ canvas_id: created.id, node_id: id, prompt: '新提示词' }, {})
  const node = view.nodes[0]
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

check('C1 an edit built on a stale read fails instead of overwriting', async () => {
  const stub = stubContext()
  registerAgentCanvasTools(stub.ctx, enabledConfig)
  const created = await stub.registered.get('create_canvas').execute({ title: '并发' }, {})
  await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: 'A' }, {})

  // Drive the tool's own read→save path and slip a write in between: the
  // `read_canvas` snapshot is taken first, then the user saves from the canvas
  // window, then the Agent's edit lands. Testing `store.save(document, revision)`
  // directly would pass even if the tool forgot to pass the revision at all —
  // which is exactly the defect this check exists for.
  const snapshot = await canvasStore.read(created.id)
  await canvasStore.save({ ...snapshot, title: '用户改过的标题' })

  // The tool reads fresh, so a plain edit still works (it is not permanently
  // wedged); the lock is about racing, not about refusing anything stale.
  const afterUserEdit = await stub.registered.get('add_canvas_node').execute({
    canvas_id: created.id,
    type: 'text',
    title: '用户改过之后再加的',
  }, {})
  assert.equal(afterUserEdit.title, '用户改过的标题', 'a fresh read still edits the user\'s version')
  assert.ok(afterUserEdit.nodes.some(node => node.title === '用户改过之后再加的'))

  // Now the race itself: patch the store so the revision moves between the
  // tool's read and its save, exactly as another window would.
  const realSave = canvasStore.save.bind(canvasStore)
  let injected = false
  canvasStore.save = async (document, expectedRevision) => {
    if (!injected) {
      injected = true
      const latest = await canvasStore.read(document.id)
      await realSave({ ...latest, title: '另一个窗口的改动' })
    }
    return await realSave(document, expectedRevision)
  }
  try {
    await assert.rejects(
      async () => await stub.registered.get('add_canvas_node').execute({ canvas_id: created.id, type: 'text', title: '会冲突' }, {}),
      error => /changed since it was read|画布已在其他窗口更新/i.test(error.message),
      'a write that raced another window must fail with actionable copy',
    )
  } finally {
    canvasStore.save = realSave
  }

  const after = await canvasStore.read(created.id)
  assert.equal(after.title, '另一个窗口的改动', 'the other window\'s edit survives')
  assert.ok(!after.nodes.some(node => node.title === '会冲突'), 'the losing write is not persisted')
})

// ------------------------------------------------------- E actionable errors

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

/**
 * History-group image folding (#49) — after a multi-model comparison, reopening it from history showed
 * only the prompt and "N 张": no picture at all.
 *
 * The data layer is not at fault (verified separately: `history/list` returns
 * every member with its `comparisonId`, and `history/image/<file>` answers 200
 * with real bytes). The defect was the aggregation in the panel:
 *
 *     const loaded = await Promise.all(group.entries.map(...))
 *
 * One unreadable member rejected the whole batch, so `setImages` never ran and
 * the board stayed blank. A single generation has one member; a comparison has
 * one per model, so its chance of showing nothing multiplied by the model count.
 *
 * This drives the real function through the built client bundle, not a copy:
 * `collectHistoryGroupImages` is exported from lib/client.js, so a future
 * refactor that reintroduces all-or-nothing folding turns this red.
 *
 * Run: node scripts/smoke-history-group-images.mjs
 */

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

// The bundle registers itself on `window.__ModuleLoader__`; it needs enough of a
// window to get that far and nothing more, because nothing here renders.
const load = registration => registration
const makeEl = () => ({ style: { setProperty() {}, removeProperty() {} }, dataset: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } })
const sandbox = {
  window: { __ModuleLoader__: { load } },
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: makeEl,
    head: makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
    addEventListener() {}, removeEventListener() {},
  },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: cb => setTimeout(cb, 0),
  cancelAnimationFrame: id => clearTimeout(id),
}
sandbox.window.window = sandbox.window

let handoff
sandbox.window.__ModuleLoader__ = { load: registration => { handoff = registration } }

const react = await import('react')
const moduleStubs = {
  'react': react,
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-dom': await import('react-dom'),
  'react-dom/client': await import('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
    get: () => () => react.createElement('div'),
  }),
  '@deepseek-ai/dsh-client-store': {},
}

vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' })
assert.ok(handoff !== undefined, 'the client bundle did not register with __ModuleLoader__')

const exportsOf = handoff.factory(spec => {
  if (spec in moduleStubs) return moduleStubs[spec]
  throw new Error(`unexpected require: ${spec}`)
})

const collect = exportsOf.collectHistoryGroupImages
assert.equal(typeof collect, 'function',
  'collectHistoryGroupImages must be exported by the client bundle (rebuild with tsdown)')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        <- ${detail}`}`)
}

const img = id => ({ b64: id, mime: 'image/png' })
const ok = (...ids) => ({ status: 'fulfilled', value: ids.map(img) })
const bad = () => ({ status: 'rejected', reason: new Error('HTTP 404') })

// --- the reported case: a comparison where one model's file is gone ----------
{
  const got = collect([ok('a'), bad(), ok('c')])
  check('对比组里一个成员读失败，其余成员照样出图',
    got.images.length === 2 && got.images.map(i => i.b64).join(',') === 'a,c',
    JSON.stringify(got))
  check('失败的那个成员被如实计数（不静默少一张）', got.failed === 1, JSON.stringify(got))
}

// --- all members intact: nothing is lost, order is preserved -----------------
{
  const got = collect([ok('a1', 'a2'), ok('b1'), ok('c1', 'c2', 'c3')])
  check('全部成员正常时，六张图一张不少且保持组内顺序',
    got.images.map(i => i.b64).join(',') === 'a1,a2,b1,c1,c2,c3' && got.failed === 0,
    JSON.stringify(got))
}

// --- single-generation history must keep working ----------------------------
{
  const got = collect([ok('solo')])
  check('单条历史（普通生成）照常出图', got.images.length === 1 && got.failed === 0, JSON.stringify(got))
}

// --- every member gone: an empty board, but honestly reported ---------------
{
  const got = collect([bad(), bad()])
  check('全部成员都读失败时返回空图并把两个都记成失败',
    got.images.length === 0 && got.failed === 2, JSON.stringify(got))
}

// --- reverse control: the OLD folding must fail these -----------------------
// Without this, "the new function returns images" would also pass if the
// assertions were too weak to notice the batch dying.
{
  const oldFold = async promises => (await Promise.all(promises)).flat()
  let oldFailed = false
  try {
    await oldFold([Promise.resolve([img('a')]), Promise.reject(new Error('HTTP 404')), Promise.resolve([img('c')])])
  } catch {
    oldFailed = true
  }
  check('反向对照：旧的 Promise.all 折叠在同样输入下整组失败（这就是 #49）', oldFailed,
    'Promise.all did not reject — the control no longer demonstrates the bug')
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1

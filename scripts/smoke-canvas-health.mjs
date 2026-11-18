/**
 * 画布体检：环、残线、孤立图片、空配置、配置未就绪。
 *
 * WHY 这块要单独钉：体检的结果会直接决定用户按不按「运行工作流」。多报一个，
 * 用户会去修一张本来没问题的图；少报一个，他会在跑到一半时撞上执行器报错。
 * 两种错都不抛异常，只会悄悄降低这个功能的可信度，所以边界必须用断言守住。
 *
 * 几处容易被「顺手优化」掉的取舍：
 * - 有环时仍然报其它问题：体检要一次看全，不是一次修一个。
 * - 残线不算连线：删过节点之后，一张图片不会因为指着它的那根残线而「不再孤立」。
 * - 配置节点自己写了 `metadata.text` 仍然报 emptyConfig：这条说的是「没有
 *   上游输入」，不是「没有提示词」。下面 E3 的失败信息会明确写这是有意的。
 * - 输出顺序固定：同一张图两次体检必须逐字节相同，否则界面会无意义地重排。
 *
 * Run: node scripts/smoke-canvas-health.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { fullHealth, structuralHealth } from '../src/client/canvas/graph-health.ts'

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// ---------------------------------------------------------------- 夹具

const node = (id, type, patch = {}) => ({
  id,
  type,
  title: id,
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  ...patch,
})
const wire = (from, to) => ({ id: `e-${from}-${to}`, fromNodeId: from, toNodeId: to })
const text = (id, body = '') => node(id, 'text', { metadata: { text: body } })
const config = (id, metadata = {}) => node(id, 'config', { metadata })
const image = (id, url = null) => node(id, 'image', {
  metadata: url === null
    ? {}
    : { asset: { assetId: id, url, mime: 'image/png', bytes: 1, width: 10, height: 10, origin: 'upload' } },
})
const kinds = health => health.issues.map(issue => issue.kind)

// ------------------------------------------------------------ 空 / 干净

check('H1 空画布什么都不报，也没有可体检的配置节点', () => {
  assert.deepEqual(structuralHealth([], []), { issues: [], blocking: 0, checkedConfigs: 0 })
  // fullHealth 在空画布上不能因为 readiness 为空就报点什么。
  assert.deepEqual(fullHealth([], [], new Map()), { issues: [], blocking: 0, checkedConfigs: 0 })
})

check('H2 一条干净的 text → config 链零问题', () => {
  const health = structuralHealth([text('t', '一只猫'), config('c', { model: 'gpt-image-2' })], [wire('t', 'c')])
  assert.deepEqual(health.issues, [], `干净链路被报了问题：${JSON.stringify(health.issues)}`)
  assert.equal(health.blocking, 0)
  assert.equal(health.checkedConfigs, 1, '体检数应当数到那条配置节点')
})

// ------------------------------------------------------------ 环

check('H3 三节点环报一条 blocking，且同图里的孤立图片也一起报出来', () => {
  const nodes = [text('a'), config('b'), text('c'), image('solo', 'solo.png')]
  const edges = [wire('a', 'b'), wire('b', 'c'), wire('c', 'a')]
  const health = structuralHealth(nodes, edges)
  assert.equal(health.blocking, 1, '环只该是一条问题，不是每个节点一条')
  assert.deepEqual(kinds(health), ['cycle', 'orphanImage'], '有环时不能提前返回：其它问题要同时报出来')
  assert.deepEqual(health.issues[0].nodeIds, ['a', 'b', 'c'], '环上三个节点都要在 nodeIds 里')
  assert.equal(health.issues[0].detailKey, 'graph.issue.cycle')
})

check('H3b 环后面的下游节点不算「环上节点」', () => {
  // tail 只是永远等不到入边，它不在环里。把它描红会让用户顺着高亮找不到那根
  // 首尾相接的线——报的是「谁成了环」，不是「谁被环连累」。
  const nodes = [text('a'), text('b'), text('tail')]
  const edges = [wire('a', 'b'), wire('b', 'a'), wire('a', 'tail')]
  const health = structuralHealth(nodes, edges)
  const cycle = health.issues.find(issue => issue.kind === 'cycle')
  assert.ok(cycle, '没有报环')
  assert.deepEqual(cycle.nodeIds, ['a', 'b'], `环上节点被下游污染了：${JSON.stringify(cycle.nodeIds)}`)
  assert.equal(health.issues.some(issue => issue.nodeIds.includes('tail')), false)
})

check('H3c 自环算环', () => {
  // 自环在 `planLayers` 里是有意保留的：它意味着「等自己的产物」，第一次运行
  // 永远等不到。漏报的话，用户按运行只会得到一张静默卡住的图。
  const health = structuralHealth([text('self')], [wire('self', 'self')])
  assert.deepEqual(kinds(health), ['cycle'])
  assert.deepEqual(health.issues[0].nodeIds, ['self'])
})

// ------------------------------------------------------------ 残线

check('H4 残线只报 danglingEdge，且不会把孤立节点算成有连线', () => {
  // img 有 asset，指向它的节点已经删了。残线要单独报，但 img 仍然没有任何
  // **有效**连线——否则删掉一个上游之后，这张图会安静地不再是「孤立产物」。
  const nodes = [text('a'), image('img', 'img.png')]
  const health = structuralHealth(nodes, [wire('ghost', 'img')])
  assert.deepEqual(kinds(health), ['danglingEdge', 'orphanImage'])
  assert.deepEqual(health.issues[0].nodeIds, ['img'], '残线要指出还在画布上的那一端')
  assert.equal(health.issues[0].detailKey, 'graph.issue.danglingEdge')
  assert.equal(health.blocking, 1, '残线是阻断项')
})

check('H4b 两端都不存在的残线也报，nodeIds 为空数组', () => {
  const health = structuralHealth([text('a')], [wire('gone-a', 'gone-b')])
  assert.deepEqual(kinds(health), ['danglingEdge'])
  assert.deepEqual(health.issues[0].nodeIds, [], '两端都没了，没有哪张卡可以高亮')
  assert.equal(health.blocking, 1)
})

check('H4c 两条残线各报一条，不能合并', () => {
  // 合成一条会让用户以为「删掉一根线就修好了」，实际还留着一根。
  const health = structuralHealth([text('a'), text('b')], [wire('a', 'ghost-1'), wire('ghost-2', 'b')])
  assert.equal(health.issues.length, 2)
  assert.deepEqual(health.issues.map(issue => [...issue.nodeIds]), [['a'], ['b']], '同类问题按 nodeIds[0] 字典序')
})

// ------------------------------------------------------------ 孤立图片

check('H5 只有带 asset 的图片才报 orphanImage，空占位不报', () => {
  const filled = structuralHealth([image('filled', 'filled.png')], [])
  assert.deepEqual(kinds(filled), ['orphanImage'])
  assert.equal(filled.issues[0].severity, 'advisory', '孤立图片只是提醒，不该拦住运行')
  assert.equal(filled.blocking, 0)

  // 还没有 asset 的图片节点是「刚拖进来、还没填」，报它就是噪声。
  assert.deepEqual(structuralHealth([image('empty')], []), { issues: [], blocking: 0, checkedConfigs: 0 })
})

check('H5b 有任一端的有效连线就不算孤立', () => {
  const hasIncoming = structuralHealth(
    [text('t'), image('img', 'img.png')],
    [wire('t', 'img')],
  )
  assert.deepEqual(hasIncoming.issues, [], '有入边的图片被当成了孤立产物')

  const hasOutgoing = structuralHealth(
    [image('img', 'img.png'), text('t')],
    [wire('img', 't')],
  )
  assert.deepEqual(hasOutgoing.issues, [], '有出边的图片被当成了孤立产物')
})

// ------------------------------------------------------------ 空配置

check('H6 空配置报 blocking，有上游的配置不报', () => {
  const alone = structuralHealth([config('c', { model: 'gpt-image-2' })], [])
  assert.deepEqual(kinds(alone), ['emptyConfig'])
  assert.equal(alone.issues[0].detailKey, 'graph.issue.emptyConfig')
  assert.equal(alone.blocking, 1)
  assert.equal(alone.checkedConfigs, 1)

  const wired = structuralHealth(
    [text('t', '一只猫'), config('c', { model: 'gpt-image-2' })],
    [wire('t', 'c')],
  )
  assert.deepEqual(wired.issues, [], '有上游文本的配置节点被当成了空配置')
})

check('H6b 配置自带 metadata.text 仍然报 emptyConfig（有意取舍）', () => {
  // 这不是 bug：这条问题说的是「没有上游输入」——拿不到上游文本、也拿不到参考
  // 图，而文案会按这个措辞写。用户看到提示去连一根线，不算被误导；反过来把
  // 它静默掉，真正忘了接线的人就永远收不到提醒。
  const health = structuralHealth([config('c', { text: '一只猫', model: 'gpt-image-2' })], [])
  assert.deepEqual(
    kinds(health),
    ['emptyConfig'],
    '有意的取舍：emptyConfig 判的是「没有上游」，不是「没有提示词」；不要把 metadata.text 当成上游输入',
  )
})

check('H6c 残线不算上游，配置仍然算空配置', () => {
  const health = structuralHealth([config('c', { model: 'gpt-image-2' })], [wire('ghost', 'c')])
  assert.deepEqual(kinds(health), ['danglingEdge', 'emptyConfig'])
})

// ------------------------------------------------------------ 就绪

check('H7 fullHealth 把未就绪的配置报成 blockedConfig，blockers 用逗号拼起来', () => {
  const nodes = [text('t', '一只猫'), config('c', { model: '' })]
  const edges = [wire('t', 'c')]
  const readiness = new Map([['c', { ready: false, blockers: ['prompt', 'model'] }]])

  const health = fullHealth(nodes, edges, readiness)
  assert.deepEqual(kinds(health), ['blockedConfig'])
  assert.deepEqual(health.issues[0].nodeIds, ['c'])
  assert.equal(health.issues[0].detailKey, 'graph.issue.blockedConfig')
  assert.deepEqual(health.issues[0].detailValues, { blockers: 'prompt,model' })
  assert.equal(health.blocking, 1)
  assert.equal(health.checkedConfigs, 1)

  // 同一张图、同一组就绪结果：ready 时不报，且 structuralHealth 不掺和这件事。
  assert.deepEqual(fullHealth(nodes, edges, new Map([['c', { ready: true, blockers: [] }]])).issues, [])
  assert.deepEqual(structuralHealth(nodes, edges).issues, [], 'structuralHealth 不该报 blockedConfig')
})

check('H7b readiness 里没有这条配置节点时不算坏，也不影响结构问题', () => {
  // 调用方传一份不完整的 map（比如还没扫到新加的节点）时，把「没查过」当成
  // 「坏了」会凭空多出一堆红点。
  const health = fullHealth([text('t'), config('c')], [wire('t', 'c')], new Map())
  assert.deepEqual(health.issues, [])
  assert.equal(health.checkedConfigs, 1, '体检过的配置节点仍要计数')
})

// ------------------------------------------------------------ 顺序 / 幂等

check('H8 五类问题同图时按固定顺序输出，且两次调用完全一致', () => {
  const nodes = [
    text('a'), text('b'),            // 环
    text('c'),                       // 残线的一端
    config('d'),                     // 空配置
    text('t'), config('e'),          // 未就绪配置 + 上游
    image('f', 'f.png'),             // 孤立图片
  ]
  const edges = [
    wire('a', 'b'), wire('b', 'a'),
    wire('c', 'gone'),
    wire('t', 'e'),
  ]
  const readiness = new Map([['e', { ready: false, blockers: ['prompt'] }]])

  const first = fullHealth(nodes, edges, readiness)
  assert.deepEqual(
    kinds(first),
    ['cycle', 'danglingEdge', 'emptyConfig', 'blockedConfig', 'orphanImage'],
    'kind 顺序不是 cycle → danglingEdge → emptyConfig → blockedConfig → orphanImage',
  )
  assert.equal(first.blocking, 4, '四类阻断项各一条；孤立图片只是 advisory')
  assert.equal(first.checkedConfigs, 2)

  const second = fullHealth(nodes, edges, readiness)
  assert.deepEqual(second, first, '同一张图两次体检结果不同：排序不稳定或带了隐藏状态')
})

check('H8b 同类问题按 nodeIds[0] 字典序，不与输入顺序挂钩', () => {
  const nodes = [config('z-empty'), config('a-empty'), image('z-img', 'z.png'), image('a-img', 'a.png')]
  const health = structuralHealth(nodes, [])
  assert.deepEqual(
    health.issues.map(issue => issue.nodeIds[0]),
    ['a-empty', 'z-empty', 'a-img', 'z-img'],
    '同类问题没有按 id 排：结果会随节点数组顺序漂移',
  )
})

check('H9 structuralHealth 连调两次逐字节相同', () => {
  const nodes = [
    text('a'), text('b'), config('c'), image('img', 'img.png'), image('blank'),
  ]
  const edges = [wire('a', 'b'), wire('b', 'a'), wire('c', 'gone')]
  const first = JSON.stringify(structuralHealth(nodes, edges))
  const second = JSON.stringify(structuralHealth(nodes, edges))
  assert.equal(first, second, '两次体检的 JSON 不同：输出不稳定，界面会无意义地重排')
})

// ------------------------------------------------------------------- 驱动

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
if (failed > 0) {
  console.error(`\ncanvas health: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas health: ${passed} passed`)

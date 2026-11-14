/**
 * 提案条的真机验收：真的画在画布上、不挡画布、按钮点得到。
 *
 * WHY 需要这一层而 jsdom 不够：
 *
 *  1. 提案条 `position: absolute` + `transform: translateX(-50%)` 贴顶居中。
 *     它到底落在画布内还是被推出可视区、会不会和顶部错误提示压在一起，只有
 *     布局引擎知道。
 *  2. 「出问题时一律返回 null」是本组件的核心承诺，而 jsdom 的渲染器在遇到
 *     props 缺失时**直接抛错整页白屏**（这一条本轮真踩过：缺省 proposals 让
 *     smoke-canvas-video 崩在 CanvasProposalBar 里）。这里放一份缺省 props 的
 *     实例，确保它安静地什么都不画。
 *  3. 按钮必须真的能点。提案是「等用户点头」的功能，按钮点不到等于没做。
 *
 * fixture 用的是**真实样式表原文**（`canvas-workspace.module.css` 里的提案
 * 规则），类名先对照真实组件源码校验过。
 *
 * Run: node scripts/verify-canvas-proposal-bar.mjs [path-to-chrome]
 * Skips loudly (exit 0) when no Chromium is available.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { assertFixtureClasses } from './lib/fixture-classes.mjs'

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the canvas proposal-bar guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = readFileSync(new URL('../src/client/canvas/proposal-bar.tsx', import.meta.url), 'utf8')
/**
 * 画布本身（不是提案条）。这里只读它的源码、不渲染它：要断言的是
 * `acceptProposal` 里那**两行的先后顺序**，而那件事浏览器量不出来——
 * 它取决于调用序列，不取决于布局。
 */
const workspaceSource = readFileSync(new URL('../src/client/CanvasWorkspace.tsx', import.meta.url), 'utf8')

/** 本组件拿到并渲染的类名；每一个都必须在真实组件源码里出现过。 */
const PROPOSAL_CLASSES = [
  'proposalBar', 'proposalHead', 'proposalTitle', 'proposalCount',
  'proposalSummary', 'proposalHint', 'proposalError', 'proposalActions',
  'proposalAccept', 'proposalDiscard',
]

// 这些 token 在验收页里用平值顶替：布局只关心它们解析得出来，不关心色值。
const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

/**
 * 场景：
 *  - 一份正常提案（带「还有 2 条」与一条错误）——全部元素都在；
 *  - 一份缺省 props 的实例（组件默认参数）——必须什么都不画。
 *
 * 外层 `.canvas` 就是画布容器的替身：`position: relative` + 一个固定尺寸，
 * 提案条相对它定位。
 */
const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-label-primary: #111111; --dsw-alias-label-tertiary: #888888;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-brand-primary: #3366ff; --dsw-alias-border-secondary: #d0d0d0;
  --dsw-alias-state-error-primary: #ec1313;
  --dsw-font-family: system-ui, sans-serif; --dsw-radius-sm: 6px; --dsw-radius-md: 10px;
  --dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,.12); --z-notice: 40; }
* { box-sizing: border-box; }
html, body { margin: 0; }
.canvas { position: relative; width: 1000px; height: 640px; background: #fafafa; overflow: hidden; }
/* 画布上的一个节点，用来验证提案条没有盖住它。 */
.node { position: absolute; left: 60px; top: 300px; width: 200px; height: 120px; background: #e8e8e8; border: 1px solid #bbb; }
</style>
<style>${css}</style></head><body>
<div class="canvas" id="canvas">
  <div class="node" id="node"></div>
  <!-- 画布顶栏：真实结构 + 真实样式。提案条在 52px，顶栏是 8px padding 加
       30px 内容（≈47px）——但窄屏下 topBar 会 flex-wrap 变成两行、长得更高。
       提案条的 z 档（--z-notice）高于顶栏（--z-topbar），所以它一旦压上去，
       压住的是标题按钮这类可点区域，而不是被顶栏盖住。这条只有真实布局能测。 -->
  <div class="topBar" id="topBar">
    <select class="projectSelect" id="topProject"><option>项目</option></select>
    <span class="iconButton"></span>
    <span class="iconButton"></span>
    <span class="iconButton"></span>
    <button type="button" class="titleButton" id="topTitle">画布标题</button>
    <span class="topBarSpacer"></span>
    <span class="iconButton"></span>
    <button type="button" class="iconButton" id="topDownload">⤓</button>
    <span class="iconButton"></span>
  </div>
  <!-- 画布自己的错误提示。它会和提案条同时出现：接受一条提案失败时，提案条上
       有失败原因，旁边可能还挂着这条。两者不能叠在一起。 -->
  <div class="errorToast" id="toast" role="alert">保存失败</div>
  <div class="proposalBar" id="bar" role="status">
    <div class="proposalHead">
      <span class="proposalTitle" id="title">Agent 提议的改动</span>
      <span class="proposalCount" id="count">还有 2 条在后面</span>
    </div>
    <div class="proposalSummary" id="summary">添加 2 个节点、连接 1 条线</div>
    <div class="proposalHint" id="hint">接受之前，画布不会有任何变化。</div>
    <div class="proposalError" id="error" role="alert">画布在这次提议之后被改动过。</div>
    <div class="proposalActions">
      <button type="button" class="proposalAccept" id="accept">接受</button>
      <button type="button" class="proposalDiscard" id="discard">丢弃</button>
      <button type="button" class="proposalDiscard" id="discardAll">全部丢弃</button>
    </div>
  </div>
</div>
<script>
  // 点了哪个按钮，供断言读取。
  window.__clicked = null
  for (const id of ['accept', 'discard', 'discardAll']) {
    document.getElementById(id).addEventListener('click', () => { window.__clicked = id })
  }
  // 缺省 props 的实例：真实组件（不在这个静态页里）用默认参数应当返回 null。
  // 这里放一个空的 .proposalBar，断言「什么都没画出来」等价于它在 DOM 上不存在。
  window.__defaultRenderMustBeAbsent = true
</script>
</body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-canvas-proposal-bar' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { send, evaluate } = session

// 类名先对一遍真实组件源码：组件改了类名而这里没改，量测就在量一个不存在的
// 结构，量出来的「通过」毫无意义。
assertFixtureClasses({
  page,
  componentSource,
  componentName: 'proposal-bar.tsx',
  stylesheet: css,
  stylesheetName: 'canvas-workspace.module.css',
  // `errorToast` 不是提案条渲染的——它是画布自己的错误提示，这里摆出来只是因为
  // 「两者不会叠在一起」这条断言需要它。`canvas` / `node` 同理。
  // `topBar` 那一组同样是脚手架：它们是画布自己的顶栏，来自
  // CanvasWorkspace.tsx 而不是提案条。断言用的是它们在真实样式表里的规则。
  //
  // 里面塞了选择器、标题和七个 30px 图标按钮，与真实顶栏同规模——只放两个
  // 按钮的话，探头量下来任何宽度都不换行，那条「窄屏换行后提案条压住顶栏」
  // 的断言就在测一个不会发生的场景。
  scaffold: new Set(['canvas', 'node', 'errorToast', 'topBar', 'projectSelect', 'iconButton',
    'titleButton', 'topBarSpacer',
    'bar', 'title', 'count', 'summary', 'hint', 'error', 'accept', 'discard', 'discardAll']),
  selfTest: ['proposalThisClassDoesNotExist', 'proposalBar'],
})
for (const name of PROPOSAL_CLASSES) {
  if (!componentSource.includes(`css.${name}`)) {
    console.error(`proposal-bar.tsx 里没有 css.${name}，组件与它的样式已经脱节`)
    process.exit(1)
  }
}

await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
await new Promise(resolve => setTimeout(resolve, 200))

const failures = []

/**
 * 在页面里量一遍。
 *
 * 关键的一条是**组件源码里有默认参数**：`proposals = []` 等。这不是这个静态页
 * 能测出来的（页里没有 React），所以改成对源码做断言——那条断言在下面用
 * `componentSource` 直接做。页面这边量的是布局与命中。
 */
const MEASURE_SOURCE = String.raw`JSON.stringify((() => {
  const box = id => document.getElementById(id).getBoundingClientRect()
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y)
    return el === null ? null : { tag: el.tagName, id: el.id || null }
  }
  const canvas = box('canvas'), bar = box('bar'), node = box('node')
  const topBar = box('topBar'), topTitle = box('topTitle'), topDownload = box('topDownload'), toast = box('toast')
  const accept = box('accept'), discard = box('discard'), discardAll = box('discardAll')
  return {
    canvas: { x: canvas.left, y: canvas.top, w: canvas.width, h: canvas.height },
    bar: { x: bar.left, y: bar.top, w: bar.width, h: bar.height },
    topBar: { x: topBar.left, y: topBar.top, w: topBar.width, h: topBar.height },
    // 顶栏里两个可点元素的命中：提案条压上来时，压住的正是这些。
    onTopTitle: hit(topTitle.left + topTitle.width / 2, topTitle.top + topTitle.height / 2),
    onTopDownload: hit(topDownload.left + topDownload.width / 2, topDownload.top + topDownload.height / 2),
    node: { x: node.left, y: node.top, w: node.width, h: node.height },
    toast: { x: toast.left, y: toast.top, w: toast.width, h: toast.height },
    accept: { x: accept.left, y: accept.top, w: accept.width, h: accept.height },
    discard: { x: discard.left, y: discard.top, w: discard.width, h: discard.height },
    discardAll: { x: discardAll.left, y: discardAll.top, w: discardAll.width, h: discardAll.height },
    // 按钮中心点各自的命中
    onAccept: hit(accept.left + accept.width / 2, accept.top + accept.height / 2),
    onDiscard: hit(discard.left + discard.width / 2, discard.top + discard.height / 2),
    onDiscardAll: hit(discardAll.left + discardAll.width / 2, discardAll.top + discardAll.height / 2),
    // 节点中心：提案条压在顶部，不该盖住下面 300px 处的节点
    onNode: hit(node.left + node.width / 2, node.top + node.height / 2),
    // 提案条正中心：必须命中提案条内部，说明它自己接得住（它不是 pointer-events:none）
    onBar: hit(bar.left + bar.width / 2, bar.top + bar.height / 2),
    pointerBar: getComputedStyle(document.getElementById('bar')).pointerEvents,
    zBar: getComputedStyle(document.getElementById('bar')).zIndex,
    positionBar: getComputedStyle(document.getElementById('bar')).position,
    // 文案一直在：这三行是用户判断「改了没有」的依据
    hasHint: document.getElementById('hint').textContent.includes('接受之前'),
    hasError: document.getElementById('error').textContent.length > 0,
    hasCount: document.getElementById('count').textContent.includes('2'),
  }
})())`

const measure = async () => JSON.parse(await evaluate(MEASURE_SOURCE))

/** 点一个按钮，读回它记录的 id。 */
const clickAndRead = async (id) => {
  await evaluate(`document.getElementById('${id}').click()`)
  return await evaluate('window.__clicked')
}

/**
 * 组件在运行时会把**量到的顶栏高度**写进 `--proposal-top-bar`（见
 * proposal-bar.tsx 的 `belowTopBar`）。静态页里没有 React，所以这里照做一遍：
 * 先量顶栏，再把它写成 inline 变量，然后重新量。少了这一步，量的就是样式表
 * 里那个 47px 的初始值，而那正是「窄屏顶栏换成两行」时会错的条件。
 */
const syncMeasuredTopBar = async () => {
  await evaluate(`(() => {
    const bar = document.getElementById('bar')
    const topBar = document.getElementById('topBar')
    const height = Math.round(topBar.getBoundingClientRect().height)
    if (height > 0) bar.style.setProperty('--proposal-top-bar', height + 'px')
  })()`)
  await new Promise(resolve => setTimeout(resolve, 60))
}

await syncMeasuredTopBar()
const m = await measure()

// 1. 真的画出来了，并且在自己的容器里
if (m.bar.w <= 0 || m.bar.h <= 0) failures.push(`提案条尺寸是 ${m.bar.w.toFixed(1)}x${m.bar.h.toFixed(1)}，没有画出来`)
if (m.bar.x < m.canvas.x || m.bar.x + m.bar.w > m.canvas.x + m.canvas.w) {
  failures.push(`提案条横向越出画布：bar ${m.bar.x.toFixed(1)}..${(m.bar.x + m.bar.w).toFixed(1)}，画布 ${m.canvas.x.toFixed(1)}..${(m.canvas.x + m.canvas.w).toFixed(1)}`)
}
if (m.bar.y < m.canvas.y || m.bar.y + m.bar.h > m.canvas.y + m.canvas.h) {
  failures.push('提案条纵向越出画布')
}
// 水平居中（translateX(-50%) 真的生效了）
const barCenter = m.bar.x + m.bar.w / 2
const canvasCenter = m.canvas.x + m.canvas.w / 2
if (Math.abs(barCenter - canvasCenter) > 2) {
  failures.push(`提案条没有水平居中：中心 ${barCenter.toFixed(1)} vs 画布中心 ${canvasCenter.toFixed(1)}`)
}

// 2. 它自己接得住指针（按钮要能点），但不是全屏遮挡
if (m.pointerBar !== 'auto') failures.push(`提案条 pointer-events 是 ${m.pointerBar}，必须是 auto，否则按钮点不到`)
if (m.positionBar !== 'absolute') failures.push(`提案条 position 是 ${m.positionBar}，应为 absolute`)
if (m.zBar === 'auto') failures.push('提案条没有 z-index，会被画布上的浮动元素盖住')

// 3. 三个按钮都命中自己，且点得动
for (const [name, target, id] of [['接受', m.onAccept, 'accept'], ['丢弃', m.onDiscard, 'discard'], ['全部丢弃', m.onDiscardAll, 'discardAll']]) {
  if (target === null || target.id !== id) failures.push(`${name}按钮的命中是 ${JSON.stringify(target)}，应为 #${id}`)
  const clicked = await clickAndRead(id)
  if (clicked !== id) failures.push(`点 ${name}按钮没有触发它自己的处理器（记录到 ${JSON.stringify(clicked)}）`)
}

// 4. 不挡画布：下面的节点仍然命中节点本身
if (m.onNode === null || m.onNode.id !== 'node') {
  failures.push(`画布节点上的命中是 ${JSON.stringify(m.onNode)}，提案条挡住了画布`)
}

// 4a. 不压顶栏。
//
// WHY：提案条 52px 起、z 档 --z-notice 高于顶栏 --z-topbar。顶栏平时是
// 8px padding + 30px 内容（≈47px），刚好让开；但窄屏下 `.topBar` 会
// `flex-wrap`，标题与按钮换成两行，顶栏长到 60px 以上——提案条就压住它的
// 下半部分。它压住的是标题、导出这些按钮，而不是被顶栏盖住：没量过就不知道
// 谁在上面，只能靠布局引擎。
for (const [what, hitPoint] of [['标题', m.onTopTitle], ['导出', m.onTopDownload]]) {
  if (hitPoint === null || hitPoint.id === null || !hitPoint.id.startsWith('top')) {
    failures.push(`提案条压住了顶栏的「${what}」按钮（该处命中 ${JSON.stringify(hitPoint)}）`)
  }
}
if (m.bar.y < m.topBar.y + m.topBar.h - 0.5) {
  failures.push(`提案条顶边 ${m.bar.y.toFixed(1)} 落在顶栏底边 ${(m.topBar.y + m.topBar.h).toFixed(1)} 之内`)
}

// 4b. 与错误提示不重叠。
//
// WHY 必须是量出来的：第一版给提案条写的注释是「位置刻意与 .errorToast 错开」，
// 而 CSS 里两者都是 `top: 14px`——注释描述的是意图，不是代码。于是接受一条提案
// 失败时，两条浮层必然叠在同一个位置，用户只能看到后画的那条。这条断言把两块
// DOM 真的一起量出来比对，是那段注释唯一站得住脚的凭据。
const overlapOf = (bar, toast) => ({
  x: Math.min(bar.x + bar.w, toast.x + toast.w) - Math.max(bar.x, toast.x),
  y: Math.min(bar.y + bar.h, toast.y + toast.h) - Math.max(bar.y, toast.y),
})
{
  const overlap = overlapOf(m.bar, m.toast)
  if (overlap.x > 0 && overlap.y > 0) {
    failures.push(`提案条与错误提示重叠 ${overlap.x.toFixed(0)}x${overlap.y.toFixed(0)}px：bar y=${m.bar.y.toFixed(0)}..${(m.bar.y + m.bar.h).toFixed(0)}，toast y=${m.toast.y.toFixed(0)}..${(m.toast.y + m.toast.h).toFixed(0)}`)
  }

  // 4c. 画布真的挂着错误提示时，组件会传 `stacked`。这条规则必须真的把提案条
  //     让开——否则 `stacked` 是个死 prop：接收了、写进 data 属性、没有任何规则
  //     读它，而调用方以为已经处理好了。这正是「注释/接口描述意图，代码没做」
  //     的另一种形态，必须由布局证明。
  await evaluate(`document.getElementById('bar').setAttribute('data-stacked', '')`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const stacked = await measure()
  const stackedOverlap = overlapOf(stacked.bar, stacked.toast)
  if (stackedOverlap.x > 0 && stackedOverlap.y > 0) {
    failures.push(`data-stacked 之后仍然重叠 ${stackedOverlap.x.toFixed(0)}x${stackedOverlap.y.toFixed(0)}px——规则没生效或数值不够`)
  }
  if (!(stacked.bar.y > m.bar.y)) {
    failures.push(`data-stacked 没有把提案条下移（仍是 y=${stacked.bar.y.toFixed(0)}）`)
  }
  // 收尾恢复，免得影响后面的窄视口断言。
  await evaluate(`document.getElementById('bar').removeAttribute('data-stacked')`)
  await new Promise(resolve => setTimeout(resolve, 80))
}

// 5. 三行关键文案都在
if (!m.hasHint) failures.push('「接受之前，画布不会有任何变化」没有显示——用户无法判断改没改')
if (!m.hasError) failures.push('错误文案没有渲染')
if (!m.hasCount) failures.push('「还有 N 条」没有显示——用户看不到后面还排着')

// 6. 窄视口下也不越界（max-width 是 min(520px, 84%)）
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 700, deviceScaleFactor: 1, mobile: false })
await new Promise(resolve => setTimeout(resolve, 150))
await evaluate(`document.getElementById('canvas').style.width = '400px'`)
await new Promise(resolve => setTimeout(resolve, 100))
await syncMeasuredTopBar()
const narrow = await measure()
if (narrow.bar.x < narrow.canvas.x - 0.5 || narrow.bar.x + narrow.bar.w > narrow.canvas.x + narrow.canvas.w + 0.5) {
  failures.push(`窄视口下提案条越出画布：bar ${narrow.bar.x.toFixed(1)}..${(narrow.bar.x + narrow.bar.w).toFixed(1)}，画布宽 ${narrow.canvas.w.toFixed(1)}`)
}
// 窄屏顶栏会 flex-wrap 换行变高（@media max-width:760px），这是提案条最可能
// 压住它的地方，宽屏那一遍永远测不到。同一组命中断言在这里再走一次。
if (narrow.bar.y < narrow.topBar.y + narrow.topBar.h - 0.5) {
  failures.push(`窄屏换行后提案条压住顶栏：bar 顶边 ${narrow.bar.y.toFixed(1)}，顶栏底边 ${(narrow.topBar.y + narrow.topBar.h).toFixed(1)}（顶栏高 ${narrow.topBar.h.toFixed(1)}）`)
}
for (const [what, hitPoint] of [['标题', narrow.onTopTitle], ['导出', narrow.onTopDownload]]) {
  if (hitPoint === null || hitPoint.id === null || !hitPoint.id.startsWith('top')) {
    failures.push(`窄屏下提案条压住了顶栏的「${what}」按钮（该处命中 ${JSON.stringify(hitPoint)}）`)
  }
}

// 7. 缺省 props 要有默认值：这是本轮真实踩过的白屏。
//    静态页里没有 React，只能对源码断言；但断言对象就是那条会崩的代码。
for (const fallback of ['proposals = []', 'busy = false', 'error = null']) {
  if (!componentSource.includes(fallback)) {
    failures.push(`组件缺少默认值 \`${fallback}\`——props 缺失时整页会崩（本轮已发生过）`)
  }
}
if (!/Partial<CanvasProposalBarProps>/.test(componentSource)) {
  failures.push('组件签名没有用 Partial，调用方只要漏传一个 props 就编译不过或运行崩')
}
// `stacked` 必须真的落到 DOM 上，否则样式没有挂靠点。
if (!componentSource.includes('data-stacked')) {
  failures.push('组件没有把 stacked 写进 data-stacked，那条样式规则永远不会生效')
}

// 8. 接受提案前必须先落盘本地未同步的编辑。
//
// 用户在拖动节点之后 650 ms 内点「接受」时，那笔拖动只在浏览器内存里。accept
// 接口只带 canvasId + proposalId，服务端基于**它自己**那份文档应用提案并返回
// 整份新文档；客户端直接拿它替换本地 document，拖动就被静默抹掉（且因为同时
// 推进了 syncedRef，autosave 也不会补写）。服务端那一半由 smoke-canvas-agent
// 的 F9 钉住，这里钉的是客户端的调用顺序。
//
// 断言的是顺序，不是「有没有调用」：两行都在、但顺序反了，一样会丢数据。
{
  const body = workspaceSource.slice(workspaceSource.indexOf('const acceptProposal'))
  const flushAt = body.indexOf('flushPendingRef.current()')
  const acceptAt = body.indexOf('api.canvasProposalAccept(')
  if (flushAt < 0) {
    failures.push('acceptProposal 没有先 flush 本地未同步的编辑——用户刚做的拖动会被服务端返回值覆盖')
  } else if (acceptAt < 0) {
    failures.push('找不到 acceptProposal 里的 canvasProposalAccept 调用，这条断言的前提已失效')
  } else if (flushAt > acceptAt) {
    failures.push('acceptProposal 里 flush 排在 accept 之后——等 accept 返回时本地编辑已经被覆盖，再写就是对着一份丢过数据的文档写')
  }
}

session.close()
// 必须显式关掉浏览器：只关 WebSocket 与 HTTP server 的话 Chrome 进程还活着，
// 它的事件循环会让这个脚本永远退不出去。
launched.close()
server.close()

if (failures.length > 0) {
  console.error(`\nFAIL: 提案条的真机验收未通过（${failures.length} 条）`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('提案条真机验收通过：居中不越界、按钮点得动、不挡画布、缺省 props 不崩')
}

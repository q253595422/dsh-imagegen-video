/**
 * 分组框的真机验收：框真的画出来了、能点中标题、不吃框内节点的指针。
 *
 * WHY 需要这一层而 jsdom 不够：分组层有三条断言只在真布局里才成立——
 *
 *  1. 框的位置来自 `groupFrame` 算出的世界坐标，而「算出来的坐标落到屏幕上
 *     对不对」要有布局引擎才看得见。纯函数断言证明了数值，证明不了它被用在
 *     了一个有 transform 的父元素里。
 *  2. 框体必须 `pointer-events: none`。jsdom 没有命中测试，`elementFromPoint`
 *     不存在，所以「框吃不吃指针」在那里永远测不出来——而这条正是本功能里
 *     最容易造成「节点拖不动了」的回归。
 *  3. 标题条必须能点中。它压在框线上（translateY(-50%)），一半在框外；若
 *     层容器的 `pointer-events: none` 没被正确覆盖回来，它就成了一个画得出来
 *     却点不中的标签，右键菜单和改名都进不去。
 *
 * fixture 用的是**真实的样式表原文**（`canvas-workspace.module.css` 里的
 * 分组规则），不是另抄一份；类名先对照真实组件源码校验过，所以组件改了类名
 * 这里会红，而不是继续量一个已经不存在的结构。
 *
 * Run: node scripts/verify-canvas-group-layer.mjs [path-to-chrome]
 * Skips loudly (exit 0) when no Chromium is available.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { assertFixtureClasses } from './lib/fixture-classes.mjs'

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the canvas group-layer guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = readFileSync(new URL('../src/client/canvas/group-layer.tsx', import.meta.url), 'utf8')

/**
 * 分组层用到的类名。先让校验器对一遍真实组件源码：组件要是把
 * `groupTitleBar` 改了名而这里没改，下面的量测就在量一个不存在的元素，
 * 量出来的「通过」毫无意义。
 */
const GROUP_CLASSES = ['groupLayer', 'groupFrame', 'groupFrameActive', 'groupTitleBar', 'groupTitleText', 'groupCount']

// 这些 token 在验收页里用平值顶替：布局只关心它们解析得出来，不关心色值。
const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

/**
 * 两个组，几何量是算好的：
 *
 *   组 A 成员 100,100 200x120 与 400,100 200x120
 *     → 包围盒 x 100..600, y 100..220
 *     → 外扩 20 后：x 80, y 80, w 520+40=560... 这里用真实 groupFrame 的值手算：
 *       minX=100 minY=100 maxX=600 maxY=220
 *       width = 600-100+40 = 540, height = 220-100+40 = 160
 *
 *   组 B 只有一个成员，且很小（20x20）→ 触发 GROUP_FRAME_MIN 120x80
 *
 * 两个框不重叠，便于分别命中。
 */
const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-label-primary: #111111; --dsw-alias-label-tertiary: #888888;
  --dsw-font-family: system-ui, sans-serif; --dsw-radius-lg: 12px; --dsw-radius-sm: 6px; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
.world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
/* 节点本身只为给「框里有没有东西」一个参照物；它们的指针行为不是本验收的对象。 */
.node { position: absolute; background: #e8e8e8; border: 1px solid #bbb; border-radius: 8px; }
</style>
<style>${css}</style></head><body>
<div class="world" id="world">
  <!-- 组 A：两个成员，框应是 540x160 @ (80,80) -->
  <div class="node" id="n1" style="left:100px;top:100px;width:200px;height:120px"></div>
  <div class="node" id="n2" style="left:400px;top:100px;width:200px;height:120px"></div>
  <!-- 组 B：一个 20x20 的小成员，框应被 GROUP_FRAME_MIN 抬到 120x80 -->
  <div class="node" id="n3" style="left:900px;top:400px;width:20px;height:20px"></div>

  <div class="groupLayer" id="groupLayer">
    <div class="groupFrame" id="frameA" role="group" aria-label="组 A"
         style="left:80px;top:80px;width:540px;height:160px" data-canvas-group="a">
      <div class="groupTitleBar" id="titleA">
        <span class="groupTitleText">组 A</span><span class="groupCount">2 个节点</span>
      </div>
    </div>
    <div class="groupFrame groupFrameActive" id="frameB" role="group" aria-label="组 B"
         style="left:880px;top:380px;width:120px;height:80px" data-canvas-group="b">
      <div class="groupTitleBar" id="titleB">
        <span class="groupTitleText">组 B</span><span class="groupCount">1 个节点</span>
      </div>
    </div>
  </div>
</div>
</body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-canvas-group-layer' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { send, evaluate } = session

// 先校验 fixture 用的类名在真实组件里确实存在。
assertFixtureClasses({
  page,
  componentSource,
  componentName: 'group-layer.tsx',
  stylesheet: css,
  stylesheetName: 'canvas-workspace.module.css',
  // `world` 与 `node` 是搭场景用的（顶替宿主外壳与节点卡片），不是分组层
  // 自己渲染的，所以列进白名单；其余类名必须真的由 group-layer.tsx 渲染。
  scaffold: new Set(['world', 'node']),
  // 一个自造的名字必须被报出来、一个真名字必须不被报，这一对证明校验器
  // 本身能分辨，而不是一个永远返回空的问题检查器。
  selfTest: ['groupThisClassDoesNotExist', 'groupFrame'],
})
// 上面校验的是 fixture 用到的全部类名；这里再确认分组自己的六个都在组件源码里
// 出现过——否则「类名存在于样式表」也可能是别的组件在用。
for (const name of GROUP_CLASSES) {
  if (!componentSource.includes(`css.${name}`)) {
    console.error(`group-layer.tsx 里没有 css.${name}，分组层与它的样式已经脱节`)
    process.exit(1)
  }
}

// 视口必须够大：`document.elementFromPoint` 对超出视口的点返回 null，
// 而默认视口（800x600）装不下组 B。这不是组件的问题，是量具的问题——
// 不设它，右半边的两条命中断言会永远假红。
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await new Promise(resolve => setTimeout(resolve, 200))

const failures = []
/**
 * 在页面里量一遍。返回的对象由下面的断言逐条吃。
 *
 * 脚本以字符串形式注入页面执行（`evaluate` 只收源码），所以这里用
 * String.raw 保住换行与缩进，末尾再交给 JSON.stringify。
 */
const MEASURE_SOURCE = String.raw`JSON.stringify((() => {
  const box = id => document.getElementById(id).getBoundingClientRect()
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y)
    if (el === null) return null
    const owner = el.closest('[data-canvas-group]')
    return { tag: el.tagName, id: el.id || null,
             group: owner === null ? null : owner.getAttribute('data-canvas-group') }
  }
  const frameA = box('frameA'), frameB = box('frameB')
  const titleA = box('titleA'), titleB = box('titleB')
  const node1 = box('n1')
  return {
    frameA: { x: frameA.left, y: frameA.top, w: frameA.width, h: frameA.height },
    frameB: { x: frameB.left, y: frameB.top, w: frameB.width, h: frameB.height },
    titleA: { x: titleA.left, y: titleA.top, w: titleA.width, h: titleA.height },
    // 框内部、避开标题条与任何节点的一处：应该是背景，不是框
    insideA: hit(frameA.left + frameA.width - 40, frameA.top + frameA.height - 30),
    // 压在 n1 上的点：必须命中节点本身
    overNode: hit(node1.left + node1.width / 2, node1.top + node1.height / 2),
    onTitleA: hit(titleA.left + titleA.width / 2, titleA.top + titleA.height / 2),
    onTitleB: hit(titleB.left + titleB.width / 2, titleB.top + titleB.height / 2),
    styleA: getComputedStyle(document.getElementById('frameA')).borderStyle,
    styleB: getComputedStyle(document.getElementById('frameB')).borderStyle,
    pointerA: getComputedStyle(document.getElementById('frameA')).pointerEvents,
    pointerTitleA: getComputedStyle(document.getElementById('titleA')).pointerEvents,
  }
})())`

const measure = async () => JSON.parse(await evaluate(MEASURE_SOURCE))

// 两种缩放：世界层带 transform 正是真实情况，缩放后的一切量测都要重新对。
for (const zoom of [1, 0.5]) {
  await evaluate(`document.getElementById('world').style.transform = 'scale(${zoom})'`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const m = await measure()
  const tag = `zoom ${zoom}`

  // 1. 框真的画出来了，且尺寸跟着缩放走
  if (Math.abs(m.frameA.w - 540 * zoom) > 1) failures.push(`${tag}: 组 A 框宽 ${m.frameA.w.toFixed(1)}，应为 ${540 * zoom}`)
  if (Math.abs(m.frameA.h - 160 * zoom) > 1) failures.push(`${tag}: 组 A 框高 ${m.frameA.h.toFixed(1)}，应为 ${160 * zoom}`)
  if (Math.abs(m.frameB.w - 120 * zoom) > 1) failures.push(`${tag}: 组 B 框宽 ${m.frameB.w.toFixed(1)}，应为 ${120 * zoom}（GROUP_FRAME_MIN）`)

  // 2. 框体不吃指针 —— 这一条只能靠命中测试
  if (m.pointerA !== 'none') failures.push(`${tag}: 框体 pointer-events 是 ${m.pointerA}，必须是 none（否则框内节点拖不动）`)
  if (m.pointerTitleA !== 'auto') failures.push(`${tag}: 标题条 pointer-events 是 ${m.pointerTitleA}，必须是 auto（否则右键与改名点不到）`)

  // 3. 压在节点上的点必须命中节点，不是框
  if (m.overNode === null || m.overNode.id !== 'n1') {
    failures.push(`${tag}: 节点上的命中是 ${JSON.stringify(m.overNode)}，应该命中 n1 —— 框把节点挡住了`)
  }

  // 4. 标题条能点中，并且归属正确的组
  if (m.onTitleA === null || m.onTitleA.group !== 'a') {
    failures.push(`${tag}: 标题条 A 的命中是 ${JSON.stringify(m.onTitleA)}，应归属组 a`)
  }
  if (m.onTitleB === null || m.onTitleB.group !== 'b') {
    failures.push(`${tag}: 标题条 B 的命中是 ${JSON.stringify(m.onTitleB)}，应归属组 b`)
  }

  // 5. 框内部的空白处不该被框接住
  if (m.insideA !== null && m.insideA.group === 'a') {
    failures.push(`${tag}: 框内空白处命中了框本身 —— 它会吞掉画布平移与框选`)
  }

  // 6. 激活态是实线，非激活是虚线
  if (m.styleA !== 'dashed') failures.push(`${tag}: 未激活组的描边是 ${m.styleA}，应为 dashed`)
  if (m.styleB !== 'solid') failures.push(`${tag}: 激活组的描边是 ${m.styleB}，应为 solid`)
}

session.close()
// 必须显式关掉浏览器：只关 WebSocket 与 HTTP server 的话，Chrome 进程本身
// 还活着，它的事件循环会让这个脚本永远退不出去（第一版就是这样挂住的）。
launched.close()
server.close()

if (failures.length > 0) {
  console.error(`\nFAIL: 分组框的真机验收未通过（${failures.length} 条）`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('分组框真机验收通过：尺寸随缩放、标题可点、框体不吃指针、激活态实线')
}

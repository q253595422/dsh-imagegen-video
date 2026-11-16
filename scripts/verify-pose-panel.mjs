/**
 * 导演台卡片（原姿势面板）的真浏览器布局守卫。
 *
 * WHY：这块面板的失败面全在布局上，而 jsdom 没有排版引擎——那里的断言全绿也
 * 不代表任何东西。只有真浏览器才测得出来：
 *
 *  1. 节点被拖到最小宽度时，机位行（机位名 + 打开导演台按钮）会不会把按钮挤
 *     出视野——那个按钮是这块卡片唯一的进阶入口；
 *  2. 「预览吃掉剩余高度」这条内联几何在矮节点里是否成立：预览必须收缩，
 *     而不是把预设条与导出按钮顶出卡片；
 *  3. 导出按钮必须始终可达，它是卡片唯一的出口；
 *  4. 预设条横向滚动时，最后一枚预设是否可达。
 *
 * 夹具是手写 HTML，所以先拿真实组件与样式表校验它用到的每个类名——一份还在
 * 渲染旧结构的夹具会去量一个已经不存在的组件，然后一直绿着。
 *
 * 2026-11 改版：卡片从「预览 + 17 关节滑杆」瘦身为「预览 + 机位行 + 预设条 +
 * 导出」。滑杆类（poseAxis / poseNumber / poseSelect / poseFacing /
 * poseFacingValue / poseControls）已不在组件里，夹具与自检一并换掉。
 *
 * Run: node scripts/verify-pose-panel.mjs [path-to-chrome]
 * 没有 Chromium 时明确跳过（exit 0）：缺工具不是违约。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { assertFixtureClasses } from './lib/fixture-classes.mjs'
import { canvasSourceText } from './lib/canvas-source.mjs'
import { ruleBodyOf } from './lib/css-rule.mjs'

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the pose card layout guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = canvasSourceText()
const poseBoard = readFileSync(new URL('../src/client/canvas/pose-board.tsx', import.meta.url), 'utf8')

/**
 * 实测点：[宽, 高]。高度必须跟着真实的 `POSE_NODE_SIZE`（320×360）走——
 * 早先夹具一律给 520 而创建节点用另一个数，夹具比真的高，于是它一边报
 * 「装不下」一边放过了一个真的装不下的面板。第二组是用户把卡片拖窄，
 * 第三组是拖矮（那时允许纵向滚动，但不许有控件被裁掉）。
 */
const NODE_SIZES = [[320, 360], [240, 360], [220, 300]]

const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

// 夹具按 pose-board.tsx 渲染出的结构手写：预览 → 机位行 → 预设条 → 底部导出。
// 机位行是「机位名 + 弹簧 + 打开按钮」，这一行的全部意义是按钮不被挤掉；
// 夹具照它写，才能量出最窄时按钮还剩多少。
const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #fff; --dsw-radius-md: 8px; --dsw-radius-sm: 4px; }
* { box-sizing: border-box; }
html, body { margin: 0; }
${css}
.nodeWrap { display: flex; }
</style></head><body>
<div class="nodeWrap" id="wrap">
  <div class="node poseNode" id="node">
    <header class="nodeHeader"><span class="nodeTitle">导演台</span></header>
    <div class="pose" id="pose">
      <div class="posePreview" id="preview" style="aspect-ratio: auto; flex: 1 1 auto; min-height: 96px"><canvas class="poseCanvas" id="canvas"></canvas></div>
      <div class="poseRow" id="cameraRow">
        <span id="cameraName" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">机位1</span>
        <span class="poseSpacer"></span>
        <button class="poseAction" id="open">导演台</button>
      </div>
      <div class="posePresets" id="presets">
        <button class="posePreset">站立</button><button class="posePreset">T 字</button><button class="posePreset">挥手</button>
        <button class="posePreset">举双手</button><button class="posePreset">侧身抬手</button><button class="posePreset">坐姿</button>
        <button class="posePreset">蹲姿</button><button class="posePreset">背身</button><button class="posePreset">摊手</button>
        <button class="posePreset">迈步</button><button class="posePreset">跑步</button>
      </div>
      <div class="poseFoot" id="foot">
        <button class="poseAction" id="export">生成参考图</button>
      </div>
    </div>
  </div>
</div></body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

// 夹具的每个类名都必须在真实组件与样式表里存在，并且校验器自己先被验一次。
assertFixtureClasses({
  page,
  // `nodeWrap` 是夹具自己的外壳（模拟宿主给节点定位的那一层），不属于组件；
  // `node` / `nodeHeader` / `nodeTitle` 来自 `.node` 卡片本身，pose-board 不渲染
  // 它们（它们包在节点体外面），一并登记为脚手架。
  scaffold: new Set(['nodeWrap', 'node', 'poseNode', 'nodeHeader', 'nodeTitle']),
  componentSource,
  componentName: 'pose-board.tsx',
  stylesheet: css,
  stylesheetName: 'canvas-workspace.module.css',
  // 自检必须一真一假：两个都「不存在」时校验器无法区分，会直接退出 1
  // （这正是上一版失效的方式——滑杆搬走后 poseAxis 也跟着没了）。
  selfTest: ['poseThisClassDoesNotExist', 'posePreview'],
})

// 组件的 JSX 里必须真的出现这些类，否则夹具量的是另一份结构。
for (const name of ['posePreview', 'poseCanvas', 'posePresets', 'posePreset', 'poseRow', 'poseSpacer', 'poseAction']) {
  assert(poseBoard.includes(`css.${name}`), `pose-board.tsx no longer renders .${name} — the fixture would measure a component that does not exist`)
}

// 卡片仍必须带 `data-canvas-no-zoom`：没有它，画布的框选分支会在 pointerdown
// 上 preventDefault 并抢走卡片里所有按钮的 click（这是踩过的真缺陷）。
assert(
  poseBoard.includes('data-canvas-no-zoom'),
  'pose-board.tsx lost data-canvas-no-zoom — canvas marquee selection would swallow the card\'s clicks',
)

// 导出按钮的配色不在这里量：它用的是宿主自己的按钮样式，没有按轴着色。
// 但样式表里卡片内的滑杆若将来又出现，必须写宿主强调色——这条断言保留，
// 只是改成「存在才检查」，避免把已经删掉的滑杆规则当成必须存在的契约。
for (const selector of ['.poseAxis input[type=\'range\']', '.poseFacing input[type=\'range\']']) {
  const body = ruleBodyOf(css, selector)
  if (body === undefined) continue
  assert(
    body.includes('accent-color: var(--dsw-alias-brand-primary)'),
    `${selector} must set accent-color to the host brand token — the host has exactly one accent, not one per axis`,
  )
}

// 卡片按钮的标签必须禁止折行。
//
// WHY 单独立一条：`open stage` 按钮的宽度靠内容撑开，而中文标签在窄行里会
// 按字断开。macOS 的 CJK 字体度量下量到 49px，Linux 的回退字体下折成两行后
// 只剩 41px——低于 44px 的可点最小尺寸。CI 在 ubuntu 上真的红了，本地跑
// 一万遍也看不见，所以这条不能只靠真浏览器量尺寸（量出来的是本机字体）。
for (const selector of ['.poseAction']) {
  const body = ruleBodyOf(css, selector)
  assert.notEqual(body, undefined, `${selector} must exist — the card's two action buttons depend on it`)
  assert(
    body.includes('white-space: nowrap'),
    `${selector} must set white-space: nowrap: without it a CJK label wraps in a narrow row and the button`,
  )
}

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-pose-card' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { evaluate } = session

// 等页面真的渲染完再量。`openPage` 把 target 建出来就返回，且不会等导航完成
// ——本地静态页通常已经就绪，但 CI 上（尤其并行跑整条测试链时）会抢在 DOM
// 建好之前求值，`document.getElementById('node')` 拿到 null，报的是
// 「Cannot read properties of null」，看起来像夹具坏了，其实是竞态。
for (let attempt = 0; attempt < 100; attempt += 1) {
  const ready = JSON.parse(await evaluate(`JSON.stringify(document.readyState === 'complete' && document.getElementById('node') !== null && document.getElementById('pose') !== null)`))
  if (ready) break
  if (attempt === 99) throw new Error('the pose card fixture never finished rendering')
  await new Promise(resolve => setTimeout(resolve, 50))
}

const MEASURE = `JSON.stringify((() => {
  const node = document.getElementById('node').getBoundingClientRect()
  const poseEl = document.getElementById('pose')
  const pose = poseEl.getBoundingClientRect()
  const preview = document.getElementById('preview').getBoundingClientRect()
  const presets = document.getElementById('presets')
  const openBtn = document.getElementById('open').getBoundingClientRect()
  const exportBtn = document.getElementById('export').getBoundingClientRect()
  const cameraName = document.getElementById('cameraName').getBoundingClientRect()
  const cameraRow = document.getElementById('cameraRow').getBoundingClientRect()

  const inside = (box) => box.left >= node.left - 1 && box.right <= node.right + 1
    && box.top >= node.top - 1 && box.bottom <= node.bottom + 1

  const overflowX = Number.isFinite(poseEl.clientWidth) && poseEl.clientWidth > 0
    ? Math.max(0, poseEl.scrollWidth - poseEl.clientWidth) : 0

  // 打开按钮的可用宽度：低于约 44px 时拇指按不住，而它是卡片唯一的进阶入口。
  const openWidth = Math.round(openBtn.width)
  // 机位名与打开按钮不许重叠——弹簧 .poseSpacer 失效时它们会压在一起，
  // 文案叠成一团，但两者的矩形都还在节点内，只靠「是否越界」发现不了。
  const overlap = Math.max(0, Math.min(cameraName.right, openBtn.right) - Math.max(cameraName.left, openBtn.left))

  return {
    nodeWidth: Math.round(node.width),
    nodeHeight: Math.round(node.height),
    poseInsideNodeX: inside(pose),
    poseInsideNodeY: pose.top >= node.top - 1 && pose.bottom <= node.bottom + 1,
    overflowX,
    previewInside: inside(preview),
    previewHeight: Math.round(preview.height),
    // 预览必须真的收缩：矮卡片里它若保持正方形，导出按钮就被顶出去了。
    previewShrunk: preview.height < preview.width,
    openInside: inside(openBtn),
    openWidth,
    openSharesRow: Math.abs(openBtn.top - cameraRow.top) < 40,
    nameButtonOverlap: Math.round(overlap),
    exportInside: inside(exportBtn),
    // 面板底部不得越过节点底部。允许 1px 的舍入；超出就是导出按钮被裁。
    poseBottom: Math.round(pose.bottom - node.bottom),
    bodyOverflowsY: poseEl.scrollHeight > poseEl.clientHeight + 1,
    presetsScrollable: presets.scrollWidth > presets.clientWidth,
  }
})())`

const failures = []
for (const [width, height] of NODE_SIZES) {
  await evaluate(`(() => {
    const node = document.getElementById('node')
    node.style.width = '${width}px'
    node.style.height = '${height}px'
    return true
  })()`)
  await new Promise(resolve => setTimeout(resolve, 200))
  const measured = JSON.parse(await evaluate(MEASURE))

  const problems = []
  if (!measured.poseInsideNodeX || !measured.poseInsideNodeY) problems.push('the body paints outside the node box')
  if (measured.overflowX > 0) problems.push(`the body overflows its own box by ${measured.overflowX}px`)
  if (!measured.previewInside) problems.push('the preview paints outside the node')
  if (!measured.openInside) problems.push('the "open stage" button is outside the node')
  if (measured.openWidth < 44) problems.push(`the "open stage" button shrank to ${measured.openWidth}px`)
  if (!measured.openSharesRow) problems.push('the "open stage" button left the camera row')
  if (measured.nameButtonOverlap > 1) problems.push(`the camera name overlaps the button by ${measured.nameButtonOverlap}px`)
  if (!measured.exportInside) problems.push('the export button is outside the node')
  if (measured.poseBottom > 1) problems.push(`the panel runs ${measured.poseBottom}px past the bottom of the node`)
  // 矮卡片（220×300）里预览必须让位；否则导出按钮一定被顶出去，只是这一条
  // 先报出来更好定位。
  if (height <= 300 && !measured.previewShrunk) problems.push('the preview did not shrink in a short node')

  console.log(`node ${width}x${height}  preview ${String(measured.previewHeight).padStart(3)}px tall`
    + `  overflowX ${measured.overflowX}px  bottom +${measured.poseBottom}px  overflowY ${measured.bodyOverflowsY ? 'yes' : 'no'}`
    + `  open ${measured.openWidth}px  overlap ${measured.nameButtonOverlap}px`
    + `  presets scroll ${measured.presetsScrollable ? 'yes' : 'no'}`)
  for (const problem of problems) failures.push(`${width}x${height}: ${problem}`)

  // 同一批尺寸，把按钮文字压窄再量一遍。
  //
  // WHY：这条断言在三次 CI 上都是红的（mac 上永远绿，量到 49px），根因是
  // 「导演台」三个字在 Linux 的回退字体里只有 mac 上的约 84% 宽，于是按钮从
  // 49px 落到 41px——低于 44px 的可点下限。只在本机跑就永远看不见它。
  //
  // 这里不去赌「哪个平台的哪种字体更窄」（那取决于跑在哪台机器上），而是
  // 直接把文字压到必然更窄：字号缩到 9px。任何平台上这一下都让文字比原来
  // 窄，于是「按钮宽度会不会跟着文字一起缩」这件事被稳定地测到。
  // 修好之后（`.poseAction` 有了 `min-width`）这里在任何平台都绿。
  await evaluate(`(() => {
    const open = document.getElementById('open')
    open.style.fontSize = '9px'
    return true
  })()`)
  await new Promise(resolve => setTimeout(resolve, 200))
  const narrow = JSON.parse(await evaluate(MEASURE))
  if (narrow.openWidth < 44) {
    failures.push(`${width}x${height}: the "open stage" button shrank to ${narrow.openWidth}px when its label got narrower`)
  }
  console.log(`node ${width}x${height}  narrow-label open ${narrow.openWidth}px`)
  await evaluate(`(() => { document.getElementById('open').style.removeProperty('font-size'); return true })()`)
}

// 预设条横向滚动之后，最后一枚必须真的滚进视野——否则排在末尾的预设等于不可达。
await evaluate(`(() => {
  const node = document.getElementById('node')
  node.style.width = '220px'
  node.style.height = '360px'
  const presets = document.getElementById('presets')
  presets.scrollLeft = presets.scrollWidth
  return true
})()`)
await new Promise(resolve => setTimeout(resolve, 150))
const lastReachable = await evaluate(`(() => {
  const presets = document.getElementById('presets')
  const last = presets.lastElementChild.getBoundingClientRect()
  const box = presets.getBoundingClientRect()
  return last.left >= box.left - 1 && last.right <= box.right + 1
})()`)
console.log(`last preset reachable after scrolling: ${lastReachable ? 'yes' : 'no'}`)
if (lastReachable !== true) failures.push('the last preset cannot be scrolled into view')

session.close(); launched.close(); server.close()

if (failures.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: the director-stage card does not fit a canvas node.')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('The card is a node body: it must stay inside the node box at the')
  console.error('narrowest width the canvas allows, both its "open stage" button and')
  console.error('its export button must remain reachable, and a short node must shrink')
  console.error('the preview instead of pushing the buttons out.')
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log('DIRECTOR-STAGE CARD FITS THE NODE AT EVERY WIDTH')

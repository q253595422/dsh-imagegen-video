/**
 * 姿势面板的真浏览器守卫。
 *
 * WHY：这块面板的失败面全在布局上，而 jsdom 没有排版引擎——那里的断言全绿也
 * 不代表任何东西。三件具体的事只有在真浏览器里才测得出来：
 *
 *  1. 节点被拖到最小宽度（60px 是节点的下限，但这里是 220px 的可用宽度）时，
 *     滑杆行会不会把面板撑出节点、把底部的「生成参考图」挤到看不见的地方；
 *  2. 一行三轴滑杆 + 数字框是否真的可点可拖——`overflow: hidden` 的祖先会把
 *     `input[type=range]` 的拇指裁掉，那在 jsdom 里是零信息；
 *  3. 预设条横向滚动时，最后一个预设是否可达；它不该把整块面板顶高。
 *
 * 夹具是手写 HTML，所以先拿真实组件与样式表校验它用到的每个类名——一份还在
 * 渲染旧结构的夹具会去量一个已经不存在的组件，然后一直绿着。
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

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the pose panel layout guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = canvasSourceText()
const poseBoard = readFileSync(new URL('../src/client/canvas/pose-board.tsx', import.meta.url), 'utf8')

/**
 * 实测点：[宽, 高]。高度必须跟着真实尺寸走——此前夹具一律给 470，而创建
 * 节点用的是 `POSE_NODE_SIZE`（520）：夹具比真的矮 50px，于是它一边报「预览
 * 不是正方形」一边放过了一个真的装不下的面板。这是夹具骗了自己的那种错。
 *
 * 第三组是「用户把节点拖得很矮」：那时允许纵向滚动，但不许有控件被裁掉。
 */
const NODE_SIZES = [[320, 520], [260, 520], [220, 420]]

const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

// 夹具按 pose-board.tsx 渲染出的结构手写：预览 → 预设条 → 关节控件 → 底部。
// 一行三轴 = 轴标 + 滑杆 + 数字框，滑杆吃掉剩余宽度，这是那条 `.poseAxis` 规则
// 的全部意义；夹具照它写，才能量出「最窄时还剩多少给滑杆」。
const axisRow = axis => `<label class="poseAxis"><span class="poseAxisLabel">${axis}</span>`
  + `<input type="range" min="-180" max="180" value="20"><input type="number" class="poseNumber" value="20"></label>`

const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #fff; --dsw-radius-md: 8px; --dsw-radius-sm: 4px; }
* { box-sizing: border-box; }
html, body { margin: 0; }
${css}
.nodeWrap { display: flex; }
</style></head><body>
<div class="nodeWrap" id="wrap">
  <div class="node poseNode" id="node">
    <header class="nodeHeader"><span class="nodeTitle">姿势</span></header>
    <div class="pose" id="pose">
      <div class="posePreview" id="preview"><canvas class="poseCanvas" id="canvas"></canvas></div>
      <div class="posePresets" id="presets">
        <button class="posePreset">站立</button><button class="posePreset">T 字</button><button class="posePreset">挥手</button>
        <button class="posePreset">举双手</button><button class="posePreset">侧身抬手</button><button class="posePreset">坐姿</button>
        <button class="posePreset">蹲姿</button><button class="posePreset">背身</button><button class="posePreset">摊手</button>
        <button class="posePreset">迈步</button><button class="posePreset">跑步</button>
      </div>
      <div class="poseControls">
        <div class="poseRow">
          <select class="poseSelect"><option>右肩</option></select>
          <span class="poseSpacer"></span>
          <button class="poseAction" id="export">生成参考图</button>
        </div>
        ${axisRow('X')}${axisRow('Y')}${axisRow('Z')}
      </div>
      <div class="poseFoot">
        <label class="poseFacing"><span>朝向</span><input type="range" min="-180" max="180" value="0"><span class="poseFacingValue">0°</span></label>
        <button class="poseAction">重置</button>
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
  selfTest: ['poseThisClassDoesNotExist', 'poseAxis'],
})

// 组件的 JSX 里必须真的出现这些类，否则夹具量的是另一份结构。
for (const name of ['posePreview', 'posePresets', 'poseAxis', 'poseNumber', 'poseAction']) {
  assert(poseBoard.includes(`css.${name}`), `pose-board.tsx no longer renders .${name} — the fixture would measure a component that does not exist`)
}

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-pose-panel' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { send, evaluate } = session

const MEASURE = `JSON.stringify((() => {
  const node = document.getElementById('node').getBoundingClientRect()
  const pose = document.getElementById('pose').getBoundingClientRect()
  const preview = document.getElementById('preview').getBoundingClientRect()
  const presets = document.getElementById('presets')
  const exportBtn = document.getElementById('export').getBoundingClientRect()
  const ranges = [...document.querySelectorAll('.poseAxis input[type=range]')]
  const numbers = [...document.querySelectorAll('.poseNumber')]
  // clientWidth / scrollWidth: a NaN would make the subtraction null and the
  // log would measure nothing, so guard before subtracting.

  const poseEl = document.getElementById('pose')
  const overflowX = Number.isFinite(poseEl.clientWidth) && poseEl.clientWidth > 0
    ? Math.max(0, poseEl.scrollWidth - poseEl.clientWidth) : 0
  // 滑杆的实际可用宽度：低于约 40px 时拇指几乎无法拖动，数字框是唯一退路，
  // 但滑杆本身仍应可点——这一项就是那条「不许被裁成 0」的底线。
  const sliderWidths = ranges.map(r => Math.round(r.getBoundingClientRect().width))
  const numberWidths = numbers.map(n => Math.round(n.getBoundingClientRect().width))
  return {
    nodeWidth: Math.round(node.width),
    nodeHeight: Math.round(node.height),
    poseInsideNodeX: pose.left >= node.left - 1 && pose.right <= node.right + 1,
    poseInsideNodeY: pose.top >= node.top - 1 && pose.bottom <= node.bottom + 1,
    overflowX,
    previewSquare: Math.abs(preview.width - preview.height) <= 1 ? 1 : 0,
    previewWidth: Math.round(preview.width),
    previewHeight: Math.round(preview.height),
    // 导出按钮必须完全在节点里：它是这块面板唯一的出口。
    exportInside: exportBtn.left >= node.left - 1 && exportBtn.right <= node.right + 1
      && exportBtn.top >= node.top - 1 && exportBtn.bottom <= node.bottom + 1,
    minSlider: Math.min(...sliderWidths),
    minNumber: Math.min(...numberWidths),
    presetsScrollable: presets.scrollWidth > presets.clientWidth,
    // 高度维度：面板是 flex 列，底部「重置」是最后一行。真机上它溢出了节点
    // 15px 被裁掉——宽度断言全绿也发现不了，因为溢出发生在纵向。
    poseBottom: Math.round(poseEl.getBoundingClientRect().bottom - node.bottom),
    bodyOverflowsY: poseEl.scrollHeight > poseEl.clientHeight + 1,
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
  if (measured.previewSquare === 0) problems.push(`the preview is not square (${measured.previewWidth}x${measured.previewHeight})`)
  if (!measured.exportInside) problems.push('the export button is outside the node')
  // 40px 是拇指还能被按住的宽度；再窄就只剩数字框，滑杆形同虚设。
  if (measured.minSlider < 40) problems.push(`a slider shrank to ${measured.minSlider}px`)
  if (measured.minNumber < 34) problems.push(`an angle field shrank to ${measured.minNumber}px`)
  // 面板底部不得越过节点底部。允许 1px 的舍入；超出就是「重置」被裁。
  if (measured.poseBottom > 1) problems.push(`the panel runs ${measured.poseBottom}px past the bottom of the node`)
  // 滚动本身是合法退路（拖得很矮时）；但底部被裁穿到节点外不行。
  // 面板内滚动时内容都在，用户滚得到——这一项因此只是提示不是失败。

  console.log(`node ${width}x${height}  preview ${String(measured.previewWidth).padStart(3)}px`
    + `  overflowX ${measured.overflowX}px  bottom +${measured.poseBottom}px  overflowY ${measured.bodyOverflowsY ? 'yes' : 'no'}`
    + `  slider ${measured.minSlider}px  number ${measured.minNumber}px`
    + `  presets scroll ${measured.presetsScrollable ? 'yes' : 'no'}`)
  for (const problem of problems) failures.push(`${width}x${height}: ${problem}`)
}

// 预设条横向滚动之后，最后一个预设必须真的滚进视野——否则「跑步」这类排在末尾
// 的预设等于不可达。
await evaluate(`(() => {
  const node = document.getElementById('node')
  node.style.width = '220px'
  node.style.height = '520px'
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
  console.error('FAIL: the pose panel does not fit a canvas node.')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('The panel is a node body: it must stay inside the node box at the')
  console.error('narrowest width the canvas allows, and its export button must remain')
  console.error('reachable at every width.')
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log('POSE PANEL FITS THE NODE AT EVERY WIDTH')

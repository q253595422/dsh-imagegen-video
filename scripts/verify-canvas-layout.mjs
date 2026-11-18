/**
 * Real-browser layout guard for the canvas's bottom chrome.
 *
 * WHY: the dock, the zoom dock and the minimap used to be three independently
 * positioned absolute layers (`left: 50%`, `left: 14px`, `left: 14px; bottom:
 * 62px`), so none of them knew the others' size. At the panel width the canvas
 * really gets in the three-column studio (about 1000px, not the window's
 * 1280px) the 711px job dock overlapped the 236px zoom dock by 107px and
 * covered its leftmost buttons (select / pan / add image / add text). No media
 * query can catch that: the overlap depends on the PANEL's width, and jsdom has
 * no layout engine at all, so the jsdom suites stayed green throughout.
 *
 * The fix puts all three in one wrapping flex row. This guard measures the
 * result at several panel widths and requires: no pairwise overlap, and every
 * piece inside the canvas.
 *
 * The fixture is hand-written HTML, so — like verify-video-layout.mjs — every
 * class it uses is resolved against the real component and stylesheet first. A
 * fixture that keeps rendering an old structure would measure a component that
 * no longer exists and stay green.
 *
 * Run: node scripts/verify-canvas-layout.mjs [path-to-chrome]
 * Skips loudly (exit 0) when no Chromium is available: a missing tool is not a
 * failing contract.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { assertFixtureClasses } from './lib/fixture-classes.mjs'
import { canvasSourceText } from './lib/canvas-source.mjs'

const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the canvas chrome layout guard did NOT run.')

const css = readFileSync(new URL('../src/client/canvas-workspace.module.css', import.meta.url), 'utf8')
const componentSource = canvasSourceText()

/**
 * 分镜设置条里那三个下拉的文案，按语言取。
 *
 * 这一组断言的是「标签 + 下拉」在 380px 卡片里放不放得下，而放不下的直接
 * 原因就是文案长度：中文 `接上一镜尾帧` 需要 94px，英文
 * `Carry from previous last frame` 需要 186px，俄文需要 203px。写死一份
 * 译文就等于测了一个界面里没有的字符串——改了译文守卫不会知道。
 *
 * 从 `locales.ts` 里读，按 `export const en` / `export const ru` 切成三段。
 * 这是源码文本而不是运行时导入：本文件是 `.mjs`，`locales.ts` 是 TSV/TS
 * 模块，为了三个字符串拉起一次构建不值得。
 */
function localeStrings() {
  const source = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  const blocks = {
    zh: source.slice(0, source.indexOf('export const en')),
    en: source.slice(source.indexOf('export const en'), source.indexOf('export const ru')),
    ru: source.slice(source.indexOf('export const ru')),
  }
  const pick = (block, key) => {
    const match = block.match(new RegExp(`'${key.replaceAll('.', '\\.')}':\\s*'([^']*)'`))
    return match === null ? null : match[1]
  }
  const out = {}
  for (const [name, block] of Object.entries(blocks)) {
    out[name] = {
      continuity: pick(block, 'canvas.storyboard.continuity'),
      cut: pick(block, 'canvas.storyboard.continuityCut'),
      carry: pick(block, 'canvas.storyboard.continuityCarry'),
      ratio: pick(block, 'canvas.videoAspect'),
      resolution: pick(block, 'canvas.videoResolution'),
    }
    const missing = Object.entries(out[name]).filter(([, value]) => value === null).map(([key]) => key)
    if (missing.length > 0) {
      console.error(`FAIL: locales.ts has no ${name} text for ${missing.join(', ')} — the settings-row guard cannot measure what it cannot read.`)
      process.exit(1)
    }
  }
  return out
}
const SETTINGS_TEXT = localeStrings()

/** 三个语言各一行「标签 + 下拉」，宽 380px——`STORYBOARD_NODE_SIZE.width`。 */
const settingsMarkup = (width) => Object.entries(SETTINGS_TEXT).map(([language, text]) => `
    <div id="settings-${language}" data-language="${language}" style="width:${width}px">
      <div class="storyboardBody" style="margin:0">
        <div class="storyboardSettings">
          <label class="storyboardField"><span>${text.continuity}</span>
            <select class="storyboardSelect" data-field="continuity"><option>${text.cut}</option><option selected>${text.carry}</option></select></label>
          <label class="storyboardField"><span>${text.ratio}</span>
            <select class="storyboardSelect" data-field="ratio"><option selected>16:9</option><option>9:16</option></select></label>
          <label class="storyboardField"><span>${text.resolution}</span>
            <select class="storyboardSelect" data-field="resolution"><option selected>720P</option><option>1080P</option></select></label>
        </div>
      </div>
    </div>`).join('')

/**
 * Panel widths to measure.
 *
 * 997 is the canvas in the three-column studio inside a 1280px window — the
 * exact situation the overlap was reported in. The narrower ones are the
 * canvas alone in a small window, where the row has to wrap instead of
 * overflowing.
 */
const PANEL_WIDTHS = [997, 860, 720, 560, 420]

/**
 * The 14 dock tiles, in the order the component renders them.
 *
 * Were 17, then 13. The five node-building icons (text / sketch / file /
 * config / storyboard) are entries of the solid `+` menu — one anchor instead
 * of five equally-weighted squares — and the run button became a single
 * labelled pill holding its own caret, so it is one tile here too, not two.
 * The 14th is 全部功能 (⌘K): the catalog is how the dock gets to stop growing
 * every time an action is added, so it has to be IN the row it protects.
 *
 * The pill is real, not a stand-in: it must measure as one item because the
 * whole point of the redesign is that the dock fits more easily at narrow
 * panel widths. It carries `data-dock-static` like the component's does.
 */
const DOCK_TILES = [
  'select', 'pan', 'addNode', 'image', 'template', 'skill', 'workflow',
  'timeline', 'background', 'help', 'catalog', 'undo', 'redo', 'trash',
]
/**
 * Gap positions in that list (LibTV 式分组：工具 / 建节点 / 库 / 运行+场景 /
 * 帮助+撤销 / 删除). These are blank space, not 1px rules — see `.dockGap`.
 *
 * These are the positions the COMPONENT actually renders, read off its JSX:
 * before addNode (2), template (4), workflow (6), help (9) and trash (13).
 * The old set {2,5,7,11} was off by one from the third gap on, which made the
 * fixture's row 12px wider than the real dock — a guard measuring a dock that
 * does not exist. It only showed up when a tile was added and the row started
 * wrapping at a width the shipping component still fits.
 */
const GAPS_AT = new Set([2, 4, 6, 9, 13])

// ------------------------------------------------- fixture vs. real component
// Validation runs on the fixture MARKUP below, not on a hand-kept list: a list
// can be edited to match a renamed class and quietly re-green the guard. The
// validator is shared with verify-video-layout.mjs, which had the only copy.

// The tokens the stylesheet reads, stood up with flat values. Layout does not
// depend on what they resolve to, only that they resolve.
const tokens = [...new Set(css.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')

const dockMarkup = DOCK_TILES
  .map((name, index) => {
    const gap = GAPS_AT.has(index) ? '<span class="dockGap"></span>' : ''
    if (name === 'workflow') {
      return `${gap}<div class="dockAction" data-dock-item data-dock-static><button aria-label="${name}">${name}</button><button class="dockCaret"></button></div>`
    }
    const primary = name === 'addNode' ? ' dockPrimary' : ''
    return `${gap}<div class="dockItem${primary}" data-dock-item><button class="iconButton" aria-label="${name}"></button></div>`
  })
  .join('')

const page = `<!doctype html><html><head><style>
:root { ${tokens}; --dsw-alias-bg-base: #fff; --dsw-shadow-lv2: 0 2px 8px #0002; --dsw-shadow-lv3: 0 6px 20px #0003;
  /* The colour contracts below need the REAL relationship between these two
     tokens, not the flat #8a8a8a the layout tokens are stubbed with: a primary
     button whose fill and ink are the same colour would make the ink check
     unfalsifiable. Light-theme values from the installed DSH. */
  --dsw-alias-button-primary-fill: #0f1115;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-label-primary: #0f1115;
  /* 同理：运行痕迹那两条契约读的是「错误色与警告色是不是同一个颜色」。把
     它们都 stub 成 #8a8a8a 会让断言永远为假——那不是「样式正确」，是「测了
     一把量不出差别的尺子」。取 DSH 浅色主题里的真实值。 */
  --dsw-alias-state-error-primary: #d92d20;
  --dsw-alias-state-warn-primary: #f59e0b;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
${css}
</style></head><body>
<div class="root" id="root" data-zoom-band="far">
  <header class="topBar"><span class="topBarSpacer"></span></header>
  <div class="viewport" id="viewport">
    <!-- One empty sketch card, so the paper-vs-desk check has something real to
         measure. Its markup mirrors node-body.tsx: the node wrapper, the header,
         then the board wrap with the canvas inside. -->
    <div class="node" id="sketchNode" style="left:24px;top:70px;width:260px;height:240px">
      <header class="nodeHeader"><span class="nodeTitle">画板节点</span></header>
      <div class="sketch">
        <div class="sketchBoardWrap">
          <canvas class="sketchBoard" id="sketchBoard"></canvas>
          <span class="sketchPlaceholder">在此自由绘制草图</span>
        </div>
      </div>
    </div>
    <!-- A SELECTED card next to it. The low-zoom outline must not repaint this
         one: "which node is selected" outranks "this is a card". -->
    <div class="node nodeSelected" id="selectedNode" style="left:320px;top:70px;width:200px;height:160px"></div>
    <!-- 上一次运行留下的两种痕迹。它们必须一眼分得开：实线红 = 去重试它，
         虚线橙 = 先修上游。用户要据此决定动哪个节点，两种颜色混成一色就等于
         没有这一步信息。 -->
    <div class="node nodeRunFailed" id="runFailedNode" style="left:24px;top:330px;width:200px;height:120px">
      <span class="runMark" id="runFailedMark" data-run-mark="failed">这次失败</span>
    </div>
    <div class="node nodeRunBlocked" id="runBlockedNode" style="left:320px;top:330px;width:200px;height:120px">
      <span class="runMark" id="runBlockedMark" data-run-mark="blocked">没有跑</span>
    </div>
    <aside class="minimap" id="edgeMinimap"><div class="minimapCanvas">
      <svg class="minimapEdges" width="220" height="150"><line class="minimapEdge" x1="10" y1="10" x2="90" y2="80"></line></svg>
      <div class="minimapNode minimapKindImage" id="kindImage" data-state="filled" style="left:10px;top:10px;width:20px;height:12px"></div>
      <div class="minimapNode minimapKindSketch" id="kindSketch" data-state="filled" style="left:40px;top:10px;width:20px;height:12px"></div>
      <!-- An empty one, side by side: "nothing produced yet" has to read
           differently from "produced", or a board full of placeholders looks
           finished on the minimap. -->
      <div class="minimapNode minimapKindImage" id="kindEmpty" data-state="empty" style="left:70px;top:10px;width:20px;height:12px"></div>
    </div></aside>
    <!-- 分镜设置条：三语各一份，宽 380px（新建分镜节点的默认宽度）。
         它测的是「标签 + 下拉」放不放得下——「接上一镜尾帧」需要 94px，而这
         张卡片里那一格原本只有 65px，被截成「接上一…」。真实缺陷不是「略有
         截断」：英文需 186px、俄文需 203px，那一格会缩到 27px，只剩箭头。 -->
    <div style="position:absolute;left:600px;top:470px;display:flex;gap:12px;align-items:flex-start">
    ${settingsMarkup(380)}
    </div>
    <div class="canvasChrome" id="chrome">
      <!-- 拼接条：与对齐条同一类「选中两个以上才出现」的整行药丸。它也必须
           在夹具里，否则对齐条出现时把它顶到哪儿、会不会被挤出画布，守卫都
           测不到。 -->
      <div class="composeBar" id="composeBar">
        <span class="composeBarIcon">⛓</span>
        <span>按画布位置拼接 · 2 段</span>
        <span class="composeBarOrder">①②</span>
        <button class="composeBarRun">开始拼接</button>
      </div>
      <!-- 有卡片被隐藏时的提示条。和拼接条、对齐条一样是「一整行 + 居中药丸」，
           而它第一版把行与药丸写成了同一个元素：flex-basis 100% 盖掉了
           width fit-content，药丸横贯整个画布。夹具里必须有一份，才能量到它
           到底多宽。（这一段是模板字符串里的一段，所以一个反引号都不能有。） -->
      <div class="hiddenRow" id="hiddenRow">
        <div class="hiddenBar" id="hiddenBar">
          <span class="hiddenBarIcon">◌</span>
          <span>2 张卡片已隐藏</span>
          <button class="hiddenBarShow">全部显示</button>
        </div>
      </div>
      <!-- 多选时的对齐条：底栏那条弹性行的第一个成员，独占一行。
           它在 fixture 里必须真的存在——它是这一行里唯一「只在多选时出现」的
           成员，而它出现时会把底栏整条往上顶。夹具少了它，守卫就测不到那次
           顶高会不会把底栏挤出画布。 -->
      <div class="alignRow" id="alignRow">
        <div class="alignBar" id="alignBar">
          <span class="alignBarLabel">对齐 2 个节点</span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><button class="alignBarButton"></button></span>
          <span class="alignBarSlot"><span class="alignBarDivider"></span><button class="alignBarButton" disabled></button></span>
          <span class="alignBarSlot"><button class="alignBarButton" disabled></button></span>
        </div>
      </div>
      <div class="chromeSide">
        <aside class="minimap" id="minimap"><div class="minimapCanvas"><div class="minimapViewport" style="left:12px;top:14px;width:120px;height:70px"></div></div></aside>
        <div class="zoomDock" id="zoomDock">
          <!-- 与组件一致：缩略图 / 找节点 / 适应 / 整理 / 连线 / 吸附 + 缩放读数。
               少画一个会让这条守卫以为侧栏比实际窄，等于把一次真实的横向挤压放过。 -->
          <button class="iconButton"></button><button class="iconButton"></button>
          <button class="iconButton"></button><button class="iconButton"></button>
          <button class="iconButton"></button><button class="iconButton"></button>
          <button class="zoomValue">100%</button>
        </div>
      </div>
      <div class="dockOuter" id="dockOuter"><div class="dock" id="dock" role="toolbar">${dockMarkup}</div></div>
    </div>
  </div>
</div></body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

assertFixtureClasses({
  page,
  componentSource,
  componentName: 'CanvasWorkspace.tsx',
  stylesheet: css,
  stylesheetName: 'canvas-workspace.module.css',
  // Names of its own, so this proves the validator rather than the fixture.
  selfTest: ['canvasThisClassDoesNotExist', 'dock'],
})

const launched = await launchChrome({ chrome: CHROME, name: 'dsh-canvas-layout' })
const session = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
const { send, evaluate } = session

// `openPage` 把 target 建出来就返回，不等导航完成。本地静态页通常已经就绪，
// 但 CI 上（并行跑整条测试链时尤甚）会抢在 DOM 建好之前求值，
// `document.getElementById(...)` 拿到 null，报的却是「Cannot read properties
// of null」——看起来像夹具坏了，其实是竞态。与 `verify-ui-contracts` 同一修法：
// 轮询就绪而不是睡一个固定值，后者在这台机器上过、在慢机器上一样会红。
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await evaluate(`document.readyState === 'complete' && document.getElementById('viewport') !== null`)) break
  if (attempt === 99) throw new Error('the canvas-layout fixture never finished rendering')
  await new Promise(resolve => setTimeout(resolve, 50))
}

const MEASURE = `JSON.stringify((() => {
  const box = id => document.getElementById(id).getBoundingClientRect()
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const viewport = box('viewport'), dock = box('dock'), zoom = box('zoomDock'), minimap = box('minimap')
  // 对齐条是第三个各自定位的浮层。它浮在底栏上方、和缩略图列几乎同一高度带，
  // 所以「两个左/中锚定的绝对定位层互相压住」这个老问题完全可能在它身上复发
  // ——而它只在多选时出现，人眼很难撞上。
  const align = box('alignBar')
  const compose = box('composeBar')
  // 变量不能叫 chrome：它在页面里是 window.chrome（一个对象，没有
  // getBoundingClientRect）。用这个名字会让整段测量抛错，而报的是「不是一个
  // 函数」——看起来像夹具少了一个 id，实际是被浏览器自带的全局名遮住了。
  const chromeRow = box('chrome')
  const hiddenRow = box('hiddenRow'), hiddenBar = box('hiddenBar')
  const inside = (r) => r.left >= viewport.left - 1 && r.right <= viewport.right + 1
    && r.top >= viewport.top - 1 && r.bottom <= viewport.bottom + 1
  // Row count, measured rather than assumed. The dock is allowed to wrap — that
  // is the fallback that keeps it inside a narrow panel — but a wrap that drops
  // ONE tile onto a row of its own looks like a missing button, and neither the
  // overlap nor the inside check can see it: the wrapped tile is still inside
  // the canvas and touches nothing.
  //
  // Counting distinct top values of the tiles is what the user sees. A
  // threshold would not do: at 420px two rows are correct and unavoidable.
  const rows = new Set([...document.querySelectorAll('#dock [data-dock-item]')]
    .map(el => Math.round(el.getBoundingClientRect().top))).size
  // 分镜设置条：每一格的下拉是不是装得下它最长的那个选项。
  //
  // 「装不装得下」不能只看 overflow：原生 select 不会撑破父元素，它会把
  // 文字裁掉并在右边留一个箭头——量出来的宽度永远「合规」，用户看到的是
  // 半句话。所以拿最长的选项做一次离屏测量，取它的文字宽 + 下拉自己的
  // padding 与 1px 边框（合计 14px）＋ 浏览器绘制的箭头所占的约 14px。
  const settingsFields = [...document.querySelectorAll('[data-language]')].map(wrap => {
    const language = wrap.dataset.language
    const selects = [...wrap.querySelectorAll('select')]
    const fields = selects.map(select => {
      const rect = select.getBoundingClientRect()
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(select).font
      probe.textContent = [...select.options].map(option => option.textContent)
        .sort((a, b) => b.length - a.length)[0]
      document.body.appendChild(probe)
      const textWidth = Math.ceil(probe.getBoundingClientRect().width)
      probe.remove()
      return {
        field: select.dataset.field,
        width: Math.round(rect.width),
        // The widest option needs this much room to be readable in full.
        need: textWidth + 28,
      }
    })
    const labels = [...wrap.querySelectorAll('label')]
    return {
      language,
      fields,
      // 换行本身是允许的（见 storyboardSettings 的注释），但要能说出换了
      // 几行：行数只能从真实布局量，不能从 CSS 推断。
      rows: new Set(labels.map(label => Math.round(label.getBoundingClientRect().top))).size,
    }
  })
  // Two things the dock has to say without a hover:
  //   - the labelled run pill must be the FILLED primary action, and
  //   - the sketch board's paper must differ from the desk it lies on.
  // Both are declared as tokens, so a source grep proves nothing: a token that
  // RESOLVES to the same colour as its neighbour is exactly the failure being
  // prevented. The pill used to be brand-primary at 14% — the NEUTRAL inverse,
  // so it painted as a pale grey block that read as disabled; the paper used
  // bg-layer-2, which is the same #ffffff as the canvas in a light theme, so an
  // empty board was invisible. Read the computed colours.
  const computed = (selector, property) => {
    const element = document.querySelector(selector)
    return element === null ? null : getComputedStyle(element)[property]
  }
  return {
    alignDock: overlap(align, dock),
    alignZoom: overlap(align, zoom),
    alignInside: inside(align),
    composeDock: overlap(compose, dock),
    composeZoom: overlap(compose, zoom),
    composeAlign: overlap(compose, align),
    composeInside: inside(compose),
    // 隐藏提示条：与对齐条同一类「多出来一整行」的成员，同样必须量它与
    // 底栏/缩放排/拼接条的重叠，以及它有没有横贯整块画布。
    hiddenDock: overlap(hiddenRow, dock),
    hiddenZoom: overlap(hiddenRow, zoom),
    hiddenCompose: overlap(hiddenRow, compose),
    hiddenAlign: overlap(hiddenRow, align),
    hiddenInside: inside(hiddenRow),
    hiddenBarWidth: Math.round(hiddenBar.width),
    chromeWidth: Math.round(chromeRow.width),
    dockZoom: overlap(dock, zoom),
    dockMinimap: overlap(dock, minimap),
    zoomMinimap: overlap(zoom, minimap),
    dockInside: inside(dock), zoomInside: inside(zoom), minimapInside: inside(minimap),
    rows,
    settingsFields,
    runPill: computed('#dock .dockAction', 'backgroundColor'),
    runInk: computed('#dock .dockAction', 'color'),
    paper: computed('#sketchBoard', 'backgroundColor'),
    desk: computed('#root', 'backgroundColor'),
    // 低缩放的卡片轮廓。box-shadow 是唯一允许的补偿通道（它不进布局，
    // 见 zoom-band.ts）；读它，而不是读 border-width —— 后者一被拿来补偿，
    // 卡片的世界外框就会变，连线锚点跟着错位。
    farShadow: computed('#sketchNode', 'boxShadow'),
    selectedShadow: computed('#selectedNode', 'boxShadow'),
    // 缩略图：连线层的存在与描边宽度，以及「草图 vs 已生成的图」是否真的
    // 分得开。两者都是「没有就只是一块装饰」的东西。
    edgeStroke: computed('#edgeMinimap .minimapEdge', 'strokeWidth'),
    edgeOpacity: computed('#edgeMinimap .minimapEdge', 'stroke'),
    imageFill: computed('#kindImage', 'backgroundColor'),
    sketchFill: computed('#kindSketch', 'backgroundColor'),
    emptyFill: computed('#kindEmpty', 'backgroundColor'),
    // 运行痕迹：两种标记的颜色、边框样式，以及节点本身的描边。分开读，
    // 因为「徽标分了色、节点还是一样的边框」也是一种失败——用户扫一眼画布
    // 靠的是卡片本身，不是右上角那颗小药丸。
    failedMarkFill: computed('#runFailedMark', 'backgroundColor'),
    blockedMarkFill: computed('#runBlockedMark', 'backgroundColor'),
    failedNodeBorder: computed('#runFailedNode', 'borderStyle'),
    blockedNodeBorder: computed('#runBlockedNode', 'borderStyle'),
    failedNodeEdge: computed('#runFailedNode', 'borderColor'),
    blockedNodeEdge: computed('#runBlockedNode', 'borderColor'),
  }
})())`

const failures = []
for (const width of PANEL_WIDTHS) {
  // A real content column, not a window: `Emulation.setDeviceMetricsOverride`
  // is the only way to pin the width (chrome-headless-shell ignores window
  // flags), and the page is one column so the viewport IS the panel.
  await send('Emulation.setDeviceMetricsOverride', { width, height: 767, deviceScaleFactor: 1, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 250))
  const measured = JSON.parse(await evaluate(MEASURE))

  const overlaps = measured.dockZoom + measured.dockMinimap + measured.zoomMinimap
    + measured.alignDock + measured.alignZoom
    + measured.composeDock + measured.composeZoom + measured.composeAlign
    + measured.hiddenDock + measured.hiddenZoom + measured.hiddenCompose + measured.hiddenAlign
  // 出问题时能一眼看出是哪两条压在一起，而不是只有一个总数。
  const pairs = [
    ['dock/zoom', measured.dockZoom], ['dock/minimap', measured.dockMinimap],
    ['zoom/minimap', measured.zoomMinimap], ['align/dock', measured.alignDock],
    ['align/zoom', measured.alignZoom], ['compose/dock', measured.composeDock],
    ['compose/zoom', measured.composeZoom], ['compose/align', measured.composeAlign],
    ['hidden/dock', measured.hiddenDock], ['hidden/zoom', measured.hiddenZoom],
    ['hidden/compose', measured.hiddenCompose], ['hidden/align', measured.hiddenAlign],
  ].filter(([, area]) => area > 0).map(([name, area]) => `${name} ${area}px²`).join(', ')
  const inside = measured.dockInside && measured.zoomInside && measured.minimapInside
    && measured.alignInside && measured.composeInside && measured.hiddenInside
  // Panels at 720px and wider must hold the dock on ONE row. Measured against
  // the real component at 900px the row needs ~800px; the 6px group gaps in
  // `.dockGap` are what keep it under that. Narrower panels wrap by design.
  const mustBeOneRow = width >= 720
  const problem = overlaps > 0
    ? `the bottom chrome overlaps itself (${overlaps}px² of shared area: ${pairs})`
    : !inside ? 'a piece of the bottom chrome (dock, zoom dock, minimap, the compose / hidden / align strips) is outside the canvas'
      // 药丸横贯整块画布是它第一版真实的样子（flex-basis 盖掉了 width: fit-content）：
      // 一条从左边接到右边、只有十来个字的虚线框，读起来像一条分隔线而不是提示。
      // 32px 是「比它自己那行窄一大截」的粗判：真机 189px vs 1338px。
      : measured.hiddenBarWidth > measured.chromeWidth * 0.6
        ? `the hidden-cards strip spans ${measured.hiddenBarWidth}px of a ${measured.chromeWidth}px row — flex-basis overrode its fit-content width`
      : mustBeOneRow && measured.rows > 1
        ? `the dock wraps to ${measured.rows} rows on a panel wide enough for one — a lone tile on the second row reads as a missing button`
        : null
  console.log(`panel ${String(width).padStart(4)}px  dock/zoom ${measured.dockZoom}px²  dock/minimap ${measured.dockMinimap}px²  inside ${inside}  rows ${measured.rows}`)
  if (problem !== null) failures.push(`${width}px: ${problem}`)

  // 分镜设置条的三个下拉必须读得出完整选项，三语都算。
  //
  // 这条与宽度无关：卡片固定 380px，所以量一次就够，但放进这个循环是为了
  // 让失败信息与其它布局缺陷一起报出来，而不是先修完底栏再撞上它。
  if (width === PANEL_WIDTHS[0]) {
    for (const { language, fields } of measured.settingsFields) {
      for (const field of fields) {
        if (field.width >= field.need) continue
        failures.push(`${language}: the storyboard "${field.field}" select is ${field.width}px wide but its longest option needs ${field.need}px — it renders a truncated label, and that label is what the shot is actually submitted under`)
      }
    }
    console.log(`storyboard settings: ${measured.settingsFields.map(({ language, fields, rows }) => `${language} rows ${rows} ${fields.map(f => `${f.field} ${f.width}/${f.need}`).join(' ')}`).join('  |  ')}`)
  }
}

// --- colour contracts, measured once (they do not depend on panel width) ------

/**
 * Parse a computed colour into three 0-255 channels.
 *
 * `getComputedStyle` is not required to return `rgb()`: Chrome returns
 * `color(srgb 0.54 0.54 0.54)` for a `color-mix()` declaration, and the naive
 * "grab the first three numbers" parse would then read 0.54 / 0.54 / 0.54 as
 * 0.54 of 255 — every colour within a rounding error of every other. That is a
 * guard that can never fail, so handle both serialisations explicitly.
 *
 * ALPHA IS PART OF THE COLOUR HERE. Half of what this file measures is expressed
 * as `color-mix(..., transparent)`: a 55% sketch block and a 100% product block
 * are the same ink at different coverage, and a comparison that ignores alpha
 * reads them as identical. Worse, an EMPTY block is `transparent` — rgba(0,0,0,0)
 * — which against a near-black product looks like "same colour, different
 * alpha" unless alpha is brought back in. So every value is composited onto the
 * surface it actually sits on before any distance is taken:
 * `alpha * channel + (1 - alpha) * backdrop`.
 */
const channelsOf = (value, backdrop = null) => {
  const text = value ?? ''
  const srgb = text.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/)
  let channels = null
  let alpha = 1
  if (srgb !== null) {
    channels = [srgb[1], srgb[2], srgb[3]].map(channel => Math.round(Number(channel) * 255))
    alpha = srgb[4] === undefined ? 1 : Number(srgb[4])
  } else {
    const legacy = text.match(/\d+(\.\d+)?/g)
    if (legacy === null) return null
    channels = legacy.slice(0, 3).map(Number)
    // `rgba(r, g, b, a)` carries the fourth number; `rgb()` does not.
    if (/^rgba\(/.test(text) && legacy.length >= 4) alpha = Number(legacy[3])
  }
  if (backdrop === null || alpha >= 1) return channels
  return channels.map((channel, index) => Math.round(alpha * channel + (1 - alpha) * backdrop[index]))
}
/**
 * Largest per-channel difference after compositing both colours onto `backdrop`.
 * 0 means the two look identical to a user looking at that surface.
 */
const colourDistance = (a, b, backdrop) => {
  const [first, second] = [channelsOf(a, backdrop), channelsOf(b, backdrop)]
  if (first === null || second === null || first.length < 3 || second.length < 3) return null
  return Math.max(...first.map((channel, index) => Math.abs(channel - second[index])))
}

{
  await send('Emulation.setDeviceMetricsOverride', { width: 997, height: 767, deviceScaleFactor: 1, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 200))
  const measured = JSON.parse(await evaluate(MEASURE))

  // 1. The paper must be a different material from the desk. Anything below ~4
  //    of 255 is invisible on a real display; the defect this prevents was 0.
  const paperDistance = colourDistance(measured.paper, measured.desk)
  if (paperDistance === null) {
    failures.push('the sketch board or the canvas has no resolvable background colour')
  } else if (paperDistance < 4) {
    failures.push(`the sketch paper is ${paperDistance}/255 away from the canvas — an empty board reads as nothing at all (paper ${measured.paper}, canvas ${measured.desk})`)
  } else {
    console.log(`sketch paper ${measured.paper} vs canvas ${measured.desk}  delta ${paperDistance}/255`)
  }

  // 2. The run pill must be a FILLED primary action with readable ink, not a
  //    tinted ghost that looks like a disabled tile.
  const inkDistance = colourDistance(measured.runPill, measured.runInk)
  if (inkDistance === null) {
    failures.push('the run pill has no resolvable fill or text colour')
  } else if (inkDistance < 120) {
    failures.push(`the run pill's label is only ${inkDistance}/255 from its own fill — it does not read as a filled button (fill ${measured.runPill}, ink ${measured.runInk})`)
  } else {
    console.log(`run pill fill ${measured.runPill}  ink ${measured.runInk}  delta ${inkDistance}/255`)
  }

  // 3. 低缩放的卡片轮廓。1.5px 的边在 17% 下只有 0.26px——浅色主题里那就是
  //    一张白卡片浮在白画布上，内容一糊，整块区域读成空白。补偿必须真的在。
  //    读 `box-shadow` 而不是 `border-width`：后者进布局，一补偿就会把卡片的
  //    世界外框撑大，而连线锚点、吸附、缩略图投影全按那个外框算。
  const hasInsetRing = value => typeof value === 'string' && value.includes('inset')
  if (!hasInsetRing(measured.farShadow)) {
    failures.push(`a card at the far zoom band has no compensating outline — it reads as empty canvas (box-shadow: ${measured.farShadow})`)
  } else {
    console.log(`far-band card outline: ${measured.farShadow}`)
  }

  // 反向：选中的卡片必须保留自己的描边。「哪一个被选中了」比「这是一张卡片」
  // 要紧，通用规则把它盖掉是优先级颠倒，不是样式细节。
  if (hasInsetRing(measured.selectedShadow)) {
    failures.push(`the low-zoom outline painted over a SELECTED card — selection lost to a generic rule (box-shadow: ${measured.selectedShadow})`)
  } else {
    console.log(`far-band selected card keeps its own shadow: ${measured.selectedShadow}`)
  }

  // 4. 缩略图的语义：连线画不画得出来，以及「我画的草稿」和「我生成的图」
  //    在 220×150 的版图上是不是两块分得开的方块。
  const edgeWidth = Number.parseFloat(measured.edgeStroke ?? '0')
  if (!(edgeWidth > 0)) {
    failures.push(`the minimap draws no connection lines (stroke-width ${measured.edgeStroke}) — it cannot show the graph's shape`)
  } else {
    console.log(`minimap edge stroke ${measured.edgeStroke}`)
  }
  // 合成到缩略图真正压着的那个底色上：半透明的方块在屏幕上「看起来是什么
  // 颜色」取决于它下面是什么，脱离底色算距离等于算了一个不存在的颜色。
  const kindDistance = colourDistance(measured.imageFill, measured.sketchFill, channelsOf(measured.desk))
  if (kindDistance === null) {
    failures.push('a minimap block has no resolvable fill')
  } else if (kindDistance < 40) {
    failures.push(`a product and a sketch resolve to the same block on the minimap (${measured.imageFill} vs ${measured.sketchFill}) — it cannot separate input from product`)
  } else {
    console.log(`minimap product ${measured.imageFill}  vs sketch ${measured.sketchFill}  delta ${kindDistance}/255`)
  }

  // 空节点必须是空心的。填实了的话，一版还没生成任何东西的画布在缩略图上会
  // 和「全都做完了」长得一样——而缩略图正是用户不在画布上时唯一的判断依据。
  const emptyDistance = colourDistance(measured.emptyFill, measured.imageFill, channelsOf(measured.desk))
  if (emptyDistance === null) {
    failures.push('an empty minimap block has no resolvable fill')
  } else if (emptyDistance < 40) {
    failures.push(`an EMPTY minimap block is filled like a produced one (${measured.emptyFill} vs ${measured.imageFill}) — a board of placeholders would look finished`)
  } else {
    console.log(`minimap empty ${measured.emptyFill}  vs produced ${measured.imageFill}  delta ${emptyDistance}/255`)
  }

  // 5. 上一次运行留下的两种痕迹。守两件事，缺一件这条信息就传不到：
  //    - 两颗徽标要真的不同色（都读 `state-error` 的话，用户看不出该动哪个）；
  //    - 卡片本身的描边也要分得开（只有徽标分色时，缩到 40% 就只剩一片红边）。
  const markDistance = colourDistance(measured.failedMarkFill, measured.blockedMarkFill)
  if (markDistance === null) {
    failures.push('a run mark has no resolvable background colour')
  } else if (markDistance < 40) {
    failures.push(`"failed" and "skipped" marks resolve to the same chip (${measured.failedMarkFill} vs ${measured.blockedMarkFill}) — the user cannot tell which node to retry`)
  } else {
    console.log(`run mark failed ${measured.failedMarkFill}  vs skipped ${measured.blockedMarkFill}  delta ${markDistance}/255`)
  }
  // 实线 vs 虚线：这是两种标记在缩小时仍分得开的东西，颜色会先糊掉。
  if (measured.failedNodeBorder !== 'solid' || measured.blockedNodeBorder !== 'dashed') {
    failures.push(`the two run marks do not use different border styles (failed ${measured.failedNodeBorder}, skipped ${measured.blockedNodeBorder}) — at low zoom the colour goes and only the line style is left`)
  } else {
    console.log(`run mark borders: failed ${measured.failedNodeBorder}, skipped ${measured.blockedNodeBorder}`)
  }
  // 节点描边也要不同色，而且是错误色 vs 警告色——不是同一个 token 的深浅。
  const edgeDistance = colourDistance(measured.failedNodeEdge, measured.blockedNodeEdge)
  if (edgeDistance === null) {
    failures.push('a run-marked node has no resolvable border colour')
  } else if (edgeDistance < 40) {
    failures.push(`a failed node and a skipped node get the same border colour (${measured.failedNodeEdge} vs ${measured.blockedNodeEdge})`)
  } else {
    console.log(`run mark node edge: failed ${measured.failedNodeEdge}  skipped ${measured.blockedNodeEdge}  delta ${edgeDistance}/255`)
  }
}

session.close(); launched.close(); server.close()

if (failures.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: the canvas bottom chrome does not fit the canvas.')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('The dock, the zoom dock and the minimap share one wrapping flex row')
  console.error('(see `.canvasChrome`); they must never paint over each other.')
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log('CANVAS BOTTOM CHROME FITS AT EVERY PANEL WIDTH')

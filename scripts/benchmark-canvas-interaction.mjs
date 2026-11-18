/**
 * 大图画布交互基准：200 / 1000 节点，量「缩放一次多久、平移一帧多久、搜索到命中多久」。
 *
 * WHY 单独一个脚本：这些数字是判断「画布到底卡不卡」的唯一证据。没有可复跑
 * 的数字，下一轮就分不清「改快了」和「这次机器刚好不忙」。固定数据、固定浏览器、
 * 固定动作序列，每轮跑同一份，把 JSON 落盘对比。
 *
 * 为什么用 `long-animation-frame` 而不是自己 rAF 计时：缩放卡顿发生在「脚本 +
 * 样式 + 布局 + 绘制」一整帧里，而 rAF 的间隔在后台标签页会被节流，量出来是假的。
 * `long-animation-frame` 由浏览器直接给出每帧各阶段耗时，是唯一不靠推断的分法。
 *
 * 用法：
 *   node scripts/benchmark-canvas-interaction.mjs --url http://127.0.0.1:4799/?token=… [--only 200] [--out FILE]
 *
 * 必须给 `--url`（一个真的跑着本插件的 DSH 宿主），并自己先把基准画布放上去——本脚本
 * 只**量**，不往任何宿主的画布目录写文件。没给 URL 时只做一次自检并说明用法。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'

function arg (name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}

const PERCENTILE = `
  const percentile = (values, p) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10
  }
`

/** 帧耗时采集：拿不到 long-animation-frame 就退回 longtask，并注明来源。 */
const OBSERVE = `
  const frames = []
  let source = 'long-animation-frame'
  let observer = null
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        frames.push({
          duration: entry.duration,
          styleAndLayout: entry.styleAndLayoutStart > 0
            ? entry.startTime + entry.duration - entry.styleAndLayoutStart
            : 0,
        })
      }
    })
    observer.observe({ type: 'long-animation-frame' })
  } catch (error) {
    source = 'longtask'
    frames.length = 0
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) frames.push({ duration: entry.duration, styleAndLayout: 0 })
    })
    observer.observe({ type: 'longtask' })
  }
`

function zoomSource () {
  return `(async () => {
    ${OBSERVE}
    ${PERCENTILE}
    const zoomIn = [...document.querySelectorAll('[data-canvas-workspace] button')]
      .find(button => /放大/.test((button.getAttribute('aria-label') || '') + (button.title || '')))
    if (zoomIn === undefined) throw new Error('zoom-in button not found')
    const clickToPaint = []
    for (let index = 0; index < 8; index += 1) {
      const started = performance.now()
      zoomIn.click()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      clickToPaint.push(performance.now() - started)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
    observer.disconnect()
    const durations = frames.map(frame => frame.duration)
    const styleLayout = frames.map(frame => frame.styleAndLayout)
    return {
      source,
      frames: frames.length,
      clickToPaint: { p50: percentile(clickToPaint, 0.5), p95: percentile(clickToPaint, 0.95), max: percentile(clickToPaint, 1) },
      frameDuration: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: percentile(durations, 1) },
      styleAndLayout: { p50: percentile(styleLayout, 0.5), p95: percentile(styleLayout, 0.95) },
      framesOver50ms: durations.filter(value => value > 50).length,
    }
  })()`
}

/**
 * 平移。
 *
 * **必须用 CDP 的真实鼠标事件**（`Input.dispatchMouseEvent`），不能用
 * `dispatchEvent(new PointerEvent(...))`：React Flow 的画布平移由 d3-zoom 驱动，
 * 它挂在 `mousedown` 上，而合成 `PointerEvent` 不会派发兼容的 `mousedown`。旧版
 * 本用合成事件，视口 transform 从头到尾都是 `translate(0px, 0px)`——量到的是一
 * 帧都没动过的画布，那个数字既不能证明快，也不能证明慢。
 *
 * 而且要先点「拖动画布」工具：选择工具下拖背景是框选，不是平移。
 */
const PAN_SETUP = `(async () => {
  const deadline = performance.now() + 20000
  let trigger = null
  while (performance.now() < deadline) {
    trigger = [...document.querySelectorAll('[data-canvas-workspace] button')]
      .find(button => (button.getAttribute('aria-label') || '').startsWith('拖动画布'))
    if (trigger !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (trigger === undefined) return { ok: false, reason: 'pan tool button not found' }
  const panRect = trigger.getBoundingClientRect()
  const pane = document.querySelector('.react-flow__pane')
  if (pane === null) return { ok: false, reason: 'canvas pane not found' }
  const box = pane.getBoundingClientRect()
  return {
    ok: true,
    panTool: { x: Math.round(panRect.left + panRect.width / 2), y: Math.round(panRect.top + panRect.height / 2) },
    from: { x: Math.round(box.left + box.width * 0.15), y: Math.round(box.top + box.height / 2) },
    step: 5,
    frames: 45,
  }
})()`

const PAN_START = `(() => {
  window.__panGaps = []
  window.__panLast = performance.now()
  window.__panObserved = []
  try {
    window.__panObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__panObserved.push({
          duration: Math.round(entry.duration),
          blocking: Math.round(entry.blockingDuration),
          styleAndLayout: entry.styleAndLayoutStart > 0
            ? Math.round(entry.startTime + entry.duration - entry.styleAndLayoutStart)
            : 0,
        })
      }
    })
    window.__panObserver.observe({ type: 'long-animation-frame' })
  } catch { window.__panObserver = null }
  const tick = () => {
    const now = performance.now()
    window.__panGaps.push(Math.round((now - window.__panLast) * 10) / 10)
    window.__panLast = now
    if (window.__panGaps.length < 400) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

const PAN_READ = `(() => {
  window.__panObserver?.disconnect()
  const pct = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10
  }
  // 丢掉开头被采集器自身和首帧初始化影响的几帧。
  const gaps = window.__panGaps.slice(3, 48)
  return {
    viewport: document.querySelector('.react-flow__viewport')?.style.transform ?? '',
    samples: gaps.length,
    frameGap: { p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), max: pct(gaps, 1) },
    framesOver33ms: gaps.filter(value => value > 33).length,
    longFrames: window.__panObserved,
  }
})()`

/**
 * 搜索定位。目标用**重名**节点 `重名节点 100`：它前面还有 `重名节点 0` 等，
 * 只输入名字会命中多张，必须靠结果条的命中数与回车后的视口位移一起判断，
 * 这样「搜到了但没跳过去」不会被算成通过。
 */
function searchSource () {
  return `(async () => {
    const target = '重名节点 100'
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))
    let input = null
    const openDeadline = performance.now() + 5000
    while (performance.now() < openDeadline) {
      // 认 [data-node-search] 而不是 [role="dialog"]：画布上同时可能有别的
      // 对话框（文件菜单、确认框），按 role 抓会量到错的那个，结果看起来
      // 「搜索 16 条命中但视口没动」——那是别的东西的按钮数。
      const dialog = document.querySelector('[data-node-search]')
      input = dialog === null ? null : dialog.querySelector('[data-node-search-input]')
      if (input !== null) break
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    if (input === null) return { error: 'node search did not open' }
    const openMs = performance.now() - started

    const typedAt = performance.now()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, target)
    input.dispatchEvent(new Event('input', { bubbles: true }))

    let hits = 0
    while (performance.now() - typedAt < 5000) {
      const dialog = document.querySelector('[data-node-search]')
      hits = dialog === null ? 0 : dialog.querySelectorAll('[data-node-hit]').length
      if (hits > 0) break
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    const resultsMs = performance.now() - typedAt

    const readViewport = () => document.querySelector('.react-flow__viewport')?.style.transform ?? ''
    const before = readViewport()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    const jumpAt = performance.now()
    let after = before
    while (performance.now() - jumpAt < 5000) {
      after = readViewport()
      if (after !== before) break
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    return {
      openMs: Math.round(openMs),
      resultsMs: Math.round(resultsMs),
      jumpMs: Math.round(performance.now() - jumpAt),
      hits,
      moved: after !== before,
      viewport: after,
    }
  })()`
}

/**
 * 打开画布页。
 *
 * 必须真的在**画布 tab** 里量：DSH 的其他 tab 也常驻，而这里的数字只对画布
 * 有意义。tab 找不到就报错——悄悄量了别的界面，比不量更糟。
 */
const OPEN_CANVAS = `(async () => {
  const waitFor = async (selector, timeout) => {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
      const element = document.querySelector(selector)
      if (element !== null) return element
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return null
  }
  const tab = async (label) => {
    const deadline = performance.now() + 20000
    while (performance.now() < deadline) {
      const found = [...document.querySelectorAll('[role="tab"], button')]
        .find(element => (element.textContent ?? '').trim() === label)
      if (found !== undefined) { found.click(); return true }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  }
  // 首启会弹「开始使用 / 登录」引导，挡住后面的 tab。
  const dismiss = [...document.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === '关闭')
  if (dismiss !== undefined) dismiss.click()
  await tab('生图')
  await new Promise(resolve => setTimeout(resolve, 600))
  if (!await tab('无限画布')) return { ok: false, reason: 'canvas tab not found' }
  const canvas = await waitFor('[data-canvas-workspace]', 20000)
  return canvas === null ? { ok: false, reason: 'canvas never mounted' } : { ok: true }
})()`

/**
 * 一档规模的画布包。
 *
 * 混合类型是刻意的：纯文本卡比视频卡轻得多，只测一种会把「大图卡」测成
 * 「文字多卡」。重名节点也是刻意留的——搜索要能靠 id 唯一定位，而不是
 * 靠名字恰好不重复。
 */
function bundleOf (count) {
  const nodes = []
  const connections = []
  for (let index = 0; index < count; index += 1) {
    const type = index % 3 === 0 ? 'text' : index % 3 === 1 ? 'config' : 'storyboard'
    nodes.push({
      id: `bench-${index}`,
      type,
      title: index % 25 === 0 ? `重名节点 ${index}` : `节点 ${index}`,
      x: (index % 20) * 420,
      y: Math.floor(index / 20) * 320,
      width: type === 'config' ? 320 : type === 'storyboard' ? 360 : 260,
      height: type === 'config' ? 190 : type === 'storyboard' ? 300 : 180,
      metadata: type === 'text'
        ? { text: `提示词 ${index}：一只橘猫在窗边晒太阳，柔和自然光` }
        : type === 'config' ? { status: 'idle' } : {},
    })
    if (index > 0 && index % 3 === 1) {
      connections.push({ id: `c-${index}`, fromNodeId: `bench-${index - 1}`, toNodeId: `bench-${index}` })
    }
  }
  return {
    format: 'dsh-imagegen-canvas-bundle',
    version: 1,
    exportedAt: Date.now(),
    title: `bench-${count}`,
    document: {
      version: 2,
      id: `bench-${count}`,
      title: `bench-${count}`,
      revision: 1,
      viewport: { x: 0, y: 0, k: 0.5 },
      background: 'lines',
      nodes,
      connections,
      createdAt: 1,
      updatedAt: 1,
    },
    assets: [],
    unresolved: [],
  }
}

async function measure (page, count) {
  const result = { count, steps: {} }

  const opened = await page.evaluate(OPEN_CANVAS)
  if (!opened.ok) throw new Error(`cannot open the canvas: ${opened.reason}`)

  /**
   * 把这一档的画布包导入成一份新画布。
   *
   * WHY 由脚本导入而不是让宿主上事先躺着一张：`bench-*` 会被反复导入，画布
   * 列表里越堆越多，下一次就分不清量的是哪一份。每次都新建、只按标题切换，
   * 同一档的负载因此完全一致。
   */
  result.steps.importMs = await page.evaluate(`(async () => {
    const input = document.querySelector('input[accept="application/json,.json"]')
    if (input === null) throw new Error('canvas import input not found')
    const transfer = new DataTransfer()
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(bundleOf(count)))}], ${JSON.stringify(`bench-${count}.json`)}, { type: 'application/json' }))
    input.files = transfer.files
    const started = performance.now()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const deadline = performance.now() + 120000
    while (performance.now() < deadline) {
      if (document.querySelectorAll('[data-node-id]').length >= ${count}) return Math.round(performance.now() - started)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return -1
  })()`)
  if (result.steps.importMs === -1) throw new Error(`import of bench-${count} never mounted ${count} nodes`)

  // steady state：卡片挂载数量到位之后才开始计时，否则量到的是导入耗时。
  const mounted = await (async () => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const value = await page.evaluate(`document.querySelectorAll('[data-node-id]').length`)
      if (typeof value === 'number' && value >= count) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return 0
  })()
  result.steps.mountedNodes = mounted
  // 等一帧再数 DOM：导入完成的那一刻 React 还没有提交，直接量会得到 0 个卡片，
  // 而「0 个卡片却量出了帧率」正是最容易被误读成「大图也不卡」的那种数字。
  result.steps.dom = await page.evaluate(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      mountedNodes: document.querySelectorAll('[data-node-id]').length,
      elements: document.querySelectorAll('[data-canvas-workspace] *').length,
    }
  })()`)
  if (result.steps.dom.mountedNodes < count) {
    throw new Error(`only ${result.steps.dom.mountedNodes} of ${count} cards are on screen: the frame numbers would measure a lighter canvas`)
  }

  // 首次交互会带上首帧/字体/图片解码，混进来就分不清「画布慢」和「第一次
  // 画这张图慢」。丢弃一轮，只留稳定态的分布。
  await page.evaluate(zoomSource())
  await new Promise(resolve => setTimeout(resolve, 400))

  result.steps.zoom = await page.evaluate(zoomSource())
  result.steps.pan = await measurePan(page)
  result.steps.search = await page.evaluate(searchSource())
  return result
}

/**
 * 真鼠标平移一档，返回帧间隔分布和浏览器自己的长帧记录。
 *
 * 视口没有真的动过就报错：一份「很快」的平移数字如果来自没有平移的负载，它
 * 比没有数字更糟——有人会拿它去证明已经达标。
 */
async function measurePan (page) {
  const setup = await page.evaluate(PAN_SETUP)
  if (!setup.ok) throw new Error(`cannot set up the pan: ${setup.reason}`)
  const before = await page.evaluate(`document.querySelector('.react-flow__viewport')?.style.transform ?? ''`)
  // 先用真鼠标点一下「拖动画布」：选择工具下拖背景是框选，不是平移。
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: setup.panTool.x, y: setup.panTool.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: setup.panTool.x, y: setup.panTool.y, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 250))

  // 平移前再确认一次：这一档的负载必须真的是 ${count} 张卡，否则「达标」只是
  // 量了一张更轻的画布。
  const beforeNodes = await page.evaluate(`document.querySelectorAll('[data-node-id]').length`)
  if (beforeNodes === 0) throw new Error('no cards on screen before the pan: the frame numbers would measure an empty canvas')
  await page.evaluate(PAN_START)
  const { x, y } = setup.from
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  for (let index = 1; index <= setup.frames; index += 1) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x + index * setup.step,
      y,
      button: 'left',
      buttons: 1,
    })
    await new Promise(resolve => setTimeout(resolve, 16))
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + setup.frames * setup.step, y, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 350))

  const result = await page.evaluate(PAN_READ)
  if (result.viewport === before) {
    throw new Error(`the pan never moved the viewport (still "${before}"): the frame numbers would measure a still canvas`)
  }
  return result
}

async function main () {
  const chromePath = findChrome()
  if (chromePath === null) return skipWithoutChrome('canvas-interaction benchmark')

  const target = arg('url', null)
  if (target === null) {
    process.stderr.write('需要一个跑着本插件的宿主地址：--url http://127.0.0.1:<port>/?token=…\n')
    process.stderr.write('基准画布请先导入，脚本只负责量，不写任何画布目录。\n')
    process.exitCode = 1
    return
  }
  const only = arg('only', null)
  const counts = only === null ? [200, 1000] : [Number(only)]

  const chrome = await launchChrome({ chrome: chromePath, name: 'canvas-benchmark' })
  const results = []
  try {
    for (const count of counts) {
      const page = await openPage(chrome.port, target)
      try {
        results.push(await measure(page, count))
      } finally {
        page.close()
      }
    }
  } finally {
    chrome.close()
  }

  const report = { measuredAt: new Date().toISOString(), target, results }
  const text = JSON.stringify(report, null, 2)
  const out = arg('out', null)
  if (out !== null) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, text)
  }
  process.stdout.write(`${text}\n`)
}

await main()

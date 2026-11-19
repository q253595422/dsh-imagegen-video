/**
 * 拍导演台全屏面板的验收截图。
 *
 * 真的是什么：真的 `PoseStagePanel`、真的 CSS Module、真的主题 token（从**已安装**
 * 的 DSH 主题包里抽出来，不是重打一遍）、真的时间轴数据。
 * 假的只有宿主：没有画布文档、没有宿主编码，写盘走内存 state。
 *
 * 为什么要单独一个脚本而不是并进 `studio-preview-shot.mjs`：那个脚本量的是生图
 * 面板的排版与配色；导演台是另一块全屏 UI，它的铺满方式、时间轴高度、三栏宽度
 * 都要按 1440×900 和窄屏各拍一次才能看出问题。
 *
 * Run: node scripts/stage-preview-shot.mjs [--out DIR]
 * Exit 0 = 两种主题都拍好了；没装 DSH 或没 Chromium 时明确跳过。
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { dshNodeModules, themeCss } from './lib/dsh-theme.mjs'
import { STAGE_CAPTURE_SIZE } from '../src/client/canvas/constants.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, '.studio-stage', 'stage.js')

const NODE_MODULES = dshNodeModules()
if (NODE_MODULES === null) {
  console.error('\nSKIP: no installed DSH found — the preview needs its theme tokens.')
  console.error('Point DSH_ASAR_DIR at a DSH `node_modules` directory to run this.')
  process.exit(0)
}
if (!existsSync(BUNDLE)) {
  console.error(`\nSKIP: ${BUNDLE} is missing. Run \`pnpm stage:preview\` first.`)
  process.exit(0)
}
const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the director-desk screenshots were NOT taken.')

const THEME = themeCss(NODE_MODULES)

/**
 * 页面外壳。
 *
 * 面板是 `position: fixed` 盖在 `container` 上的，所以外壳只要提供一块铺满的
 * 画布背景就够了——不要在这里伪造侧边栏与会话区，那张图会被误读成「面板嵌在
 * 会话里」，而我们验的是全屏面板本身。
 */
const PAGE = `<!DOCTYPE html>
<html lang="zh" data-theme="light">
<head>
<meta charset="utf-8">
<title>director desk preview</title>
<style>${THEME}</style>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: var(--dsw-alias-bg-base, #fff); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #root { min-height: 100vh; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/stage.js"></script>
</body>
</html>`

const assets = new Map([
  ['/stage.js', { type: 'text/javascript; charset=utf-8', size: statSync(BUNDLE).size }],
])
const STAGE_ASSETS = new Set([
  'base-body.glb',
  'clothing-tshirt.glb',
  'clothing-jeans.glb',
  'clothing-shoes.glb',
])

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url.startsWith('/?')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
  }
  if (url.startsWith('/api/dsh-imagegen/stage-assets/')) {
    const name = decodeURIComponent(url.slice('/api/dsh-imagegen/stage-assets/'.length).split('?')[0])
    const file = join(ROOT, 'assets/stage', name)
    if (STAGE_ASSETS.has(name) && existsSync(file)) {
      response.writeHead(200, { 'content-type': 'model/gltf-binary' })
      createReadStream(file).pipe(response)
      return
    }
  }
  const asset = assets.get(url.split('?')[0])
  if (asset !== undefined) {
    response.writeHead(200, { 'content-type': asset.type })
    createReadStream(BUNDLE).pipe(response)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

const shotIndex = process.argv.indexOf('--out')
const outDir = shotIndex > 0 ? process.argv[shotIndex + 1] : join(ROOT, '.studio-stage')
mkdirSync(outDir, { recursive: true })

const launched = await launchChrome({
  chrome: CHROME,
  name: 'dsh-stage-preview',
  // 这个面板现在默认走 three.js 渲染，`--disable-gpu` 会让它静默退回 2D——
  // 于是截图看起来「正常」，实际验的是早就不用了的那个渲染器。
  gpu: true,
  args: ['--window-size=1440,900', '--hide-scrollbars', '--force-device-scale-factor=2'],
})
const page = await openPage(launched.port, `http://127.0.0.1:${serverPort}/`)

let failure
try {
  await page.send('Page.enable', {})
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })

  const waitFor = async (expression, label, attempts = 100) => {
    for (let index = 0; index < attempts; index += 1) {
      if ((await page.evaluate(expression)) === true) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  await waitFor('document.readyState === "complete"', 'the page to load')
  // 时间轴条是这次改动新加的东西，它存在才说明面板真的按新结构渲染了。
  await waitFor(
    'document.querySelectorAll("[class*=timelineBar]").length > 0 && document.querySelectorAll("[class*=trackRow]").length > 0',
    'the timeline bar and its tracks',
  )
  // The standard body and its three clothing GLBs load asynchronously after the
  // panel mounts; the timeline is ready before they are. Give the first frame
  // that actually includes them time to arrive.
  await new Promise(resolve => setTimeout(resolve, 3000))
  // 舞台必须是**三维**画出来的一块 canvas，而不是 2D 回退。
  // 这条不能省：3D 在拿不到 WebGL 时会自己退回 2D，不报错、不报警——
  // 一张「看起来还行」的截图完全可能是 2D 画的，那样的验收等于没做。
  const viewport = await page.evaluate(`(() => {
    const canvas = document.querySelector('canvas')
    if (canvas === null) return { ok: false, why: 'no canvas in the panel' }
    // three 把 WebGLRenderer 的上下文挂在这两个属性之一上；两个都没有就是 2D。
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    return {
      ok: gl !== null,
      why: gl === null ? 'the viewport canvas has no WebGL context' : 'ok',
      renderer: gl === null ? null : gl.getParameter(gl.RENDERER),
    }
  })()`)
  if (viewport.ok !== true) throw new Error(`the stage is not rendering in 3D: ${viewport.why}`)
  console.log(`  webgl renderer: ${viewport.renderer}`)
  await waitFor('document.fonts.status === "loaded"', 'fonts to settle')
  await waitFor('document.getAnimations().every(a => a.playState !== "running")', 'transitions to settle')

  const shoot = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const data = shot.result?.data
    if (typeof data !== 'string' || data.length === 0) throw new Error(`${name}: no screenshot data`)
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  ${name.padEnd(18)} ${file}  ${(statSync(file).size / 1024).toFixed(0)} kB`)
    return file
  }

  /**
   * 面板是否真的铺满、时间轴是否占住自己那条高度、有没有东西被裁掉。
   *
   * 这些都是「看一眼就知道」的事，但我看不到图，所以量出来。
   */
  const audit = await page.evaluate(`(() => {
    const panel = document.querySelector('[class*=stage]')
    if (panel === null) return { error: 'the panel never rendered' }
    const rect = element => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
    }
    const timeline = document.querySelector('[class*=timelineBar]')
    const tracks = document.querySelectorAll('[class*=trackRow]')
    const keyDots = document.querySelectorAll('[class*=keyDot]')
    const buttons = [...document.querySelectorAll('button')]
    const exportButton = buttons.find(b => (b.textContent ?? '').includes('导出视频'))
    const overflow = []
    for (const element of document.querySelectorAll('*')) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible') {
        overflow.push({ tag: element.tagName, cls: element.className?.toString().slice(0, 40), by: element.scrollWidth - element.clientWidth })
      }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panel: rect(panel),
      timeline: timeline === null ? null : rect(timeline),
      trackCount: tracks.length,
      keyDotCount: keyDots.length,
      exportButton: exportButton === undefined ? null : { text: exportButton.textContent, disabled: exportButton.disabled, box: rect(exportButton) },
      buttonCount: buttons.length,
      overflow: overflow.slice(0, 8),
      timelineCoversContent: timeline === null ? null
        : Math.abs(rect(timeline).y + rect(timeline).h - window.innerHeight) <= 2,
    }
  })()`)

  console.log(JSON.stringify(audit, null, 2))

  const poseIndex = process.argv.indexOf('--pose')
  const pose = poseIndex > 0 ? process.argv[poseIndex + 1] : undefined
  if (pose === 'sit') {
    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(item => (item.textContent ?? '').trim() === '坐姿')
      button?.click()
      return button !== undefined
    })()`)
    if (clicked !== true) throw new Error('could not find the 坐姿 preset button')
    await new Promise(resolve => setTimeout(resolve, 1200))
    await shoot('stage-sit')
  }

  // 「机位截图」这条路必须真点一次。这条断言守的是**交付物本身**：交出来的
  // 是一张 1280×1280 的真图（38 个色块、约 190KB），不是空白、不是占位。
  // 它**不**区分这张是 3D 还是 2D 画的——两者都是合法 PNG；那条由面板里
  // 「3D 失败才退回 2D」的代码结构与 `verify-stage-3d` 的渲染断言分别守着。
  const capture = await page.evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('机位截图'))
    if (button === undefined) return { ok: false, why: 'no capture button' }
    window.__stageCapture = undefined
    button.click()
    for (let i = 0; i < 120; i += 1) {
      if (typeof window.__stageCapture === 'string') break
      await new Promise(r => setTimeout(r, 100))
    }
    const url = window.__stageCapture
    if (typeof url !== 'string') return { ok: false, why: 'onCapture never fired' }
    const image = new Image()
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data
    const buckets = new Set()
    for (let i = 0; i < data.length; i += 4 * 53) {
      buckets.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4))
    }
    return {
      ok: true,
      width: image.width,
      height: image.height,
      isPng: url.startsWith('data:image/png'),
      colours: buckets.size,
      bytes: Math.round(url.length * 0.75),
    }
  })()`)
  if (capture.ok !== true) throw new Error(`the capture button did not produce a usable frame: ${capture.why}`)
  if (capture.isPng !== true || capture.width !== STAGE_CAPTURE_SIZE || capture.height !== STAGE_CAPTURE_SIZE) {
    throw new Error(`capture must be a ${STAGE_CAPTURE_SIZE}x${STAGE_CAPTURE_SIZE} PNG, got ${capture.width}x${capture.height} png=${capture.isPng}`)
  }
  // 一张只有几个色块的图说明人形没画出来（天空 + 地面就是 2~3 色）。
  if (capture.colours < 8) throw new Error(`the captured frame looks empty (${capture.colours} colour buckets)`)
  console.log(`  capture          ${capture.width}x${capture.height} PNG, ${capture.colours} colour buckets, ${capture.bytes} bytes`)

  // 拖动视口必须真的转动画面。这条以前没有任何检查点过：面板把拖动写进自己的
  // `view` state，而那份 state 没有消费方，3D 场景的 `orbit()` 一个调用方都没有——
  // 用户报「导演台无法拖动」，测试全绿。断言方式是**逐字节对比拖动前后的画布**，
  // 因为「看起来转了」这种判断骗得过截图、骗不过像素。
  const orbit = await (async () => {
    const box = await page.evaluate(`(() => {
      const canvas = document.querySelector('canvas')
      if (canvas === null) return null
      const r = canvas.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (box === null) return { ok: false, why: 'no viewport canvas' }
    const readCanvasPng = () => page.evaluate('document.querySelector("canvas").toDataURL("image/png")')
    const before = await readCanvasPng()
    for (const step of ['down', 'move', 'up']) {
      await page.send('Input.dispatchMouseEvent', {
        type: step === 'down' ? 'mousePressed' : step === 'up' ? 'mouseReleased' : 'mouseMoved',
        x: step === 'move' ? box.x + 120 : box.x,
        y: box.y,
        button: 'left',
        buttons: step === 'up' ? 0 : 1,
        clickCount: 1,
      })
      await new Promise(resolve => setTimeout(resolve, 90))
    }
    await new Promise(resolve => setTimeout(resolve, 400))
    return { ok: true, changed: before !== await readCanvasPng() }
  })()
  if (orbit.ok !== true) throw new Error(`cannot drag the viewport: ${orbit.why}`)
  if (orbit.changed !== true) {
    throw new Error('dragging the viewport did not change the picture — the renderer never received the orbit gesture')
  }
  console.log('  orbit          dragging the viewport rotates the scene')

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await page.evaluate('document.body.removeAttribute("data-ds-dark-theme")')
  await new Promise(resolve => setTimeout(resolve, 250))
  await shoot('stage-light')

  // 主题靠 `body[data-ds-dark-theme]` 翻转，跟 DSH 自己的做法一致——不是
  // `documentElement.dataset.theme`，也不是 `prefers-color-scheme`。早先按
  // `<html data-theme>` 切，两张截图的字节完全一样（都是 574 kB），也就是
  // 我拍了两张浅色图却以为验过了深色。
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await page.evaluate('document.body.setAttribute("data-ds-dark-theme", "")')
  await new Promise(resolve => setTimeout(resolve, 250))
  await shoot('stage-dark')

  // 窄屏：面板是给画布上的节点开的全屏层，笔记本 1280 与半屏 900 都要撑得住。
  for (const width of [1280, 900]) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: 2, mobile: false,
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    const narrow = await page.evaluate(`(() => {
      const timeline = document.querySelector('[class*=timelineBar]')
      const tracks = document.querySelectorAll('[class*=trackRow]')
      const clipped = []
      for (const element of document.querySelectorAll('[class*=trackRow], [class*=timelineTop], [class*=playRow]')) {
        const box = element.getBoundingClientRect()
        if (box.right > window.innerWidth + 1) clipped.push({ cls: element.className?.toString().slice(0, 40), over: Math.round(box.right - window.innerWidth) })
      }
      return {
        viewport: window.innerWidth,
        timelineHeight: timeline === null ? null : Math.round(timeline.getBoundingClientRect().height),
        trackCount: tracks.length,
        clipped,
      }
    })()`)
    console.log(JSON.stringify(narrow))
    await shoot(`stage-${width}`)
  }
} catch (error) {
  failure = error
} finally {
  page.close()
  launched.close?.()
  server.close()
}

if (failure !== undefined) {
  console.error(`\nstage preview FAILED: ${failure.message}`)
  process.exit(1)
}
console.log(`\nstage preview: screenshots written to ${outDir}`)

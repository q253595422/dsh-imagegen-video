/**
 * Screenshot the real settings card at the host's settings-pane width.
 *
 * The HTML shell is a fixture; the card, interactions, CSS modules and host
 * theme tokens are real. Run `pnpm exec tsdown --config
 * scripts/settings-preview.config.ts` first.
 */

import { createReadStream, existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, launchChrome, skipWithoutChrome } from './lib/headless-chrome.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, '.settings-preview', 'preview.js')
const THEME_PACKAGE = 'dsh-client-ui-theme'

function dshNodeModules() {
  const candidates = [
    process.env.DSH_ASAR_DIR,
    '/tmp/dshnative/dsh/node_modules',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
    ...globSync(`${process.env.HOME ?? ''}/.npm/_npx/*/node_modules`).sort().reverse(),
  ].filter(Boolean)
  return candidates.find(dir => existsSync(join(dir, '@deepseek-ai', THEME_PACKAGE, 'lib', 'client.js'))) ?? null
}

function themeCss(nodeModules) {
  const file = join(nodeModules, '@deepseek-ai', THEME_PACKAGE, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  const blocks = []
  for (const pattern of [
    /^\s*var\s+(\w*_css_default)\s*=\s*("(?:[^"\\]|\\.)*");?\s*$/gm,
    /(?:const|var|let)\s+\w+\s*=\s*`((?:[^`\\]|\\.)*)`/g,
  ]) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const text = match[2] === undefined ? match[1] : JSON.parse(match[2])
      if (text.includes('--dsw-') || text.includes('@font-face')) blocks.push(text)
    }
  }
  if (blocks.length === 0) throw new Error('theme package: no inlined CSS constants')
  return blocks.join('\n')
}

const NODE_MODULES = dshNodeModules()
if (NODE_MODULES === null) {
  console.error('\nSKIP: no installed DSH found -- the settings preview needs its theme tokens.')
  process.exit(0)
}
if (!existsSync(BUNDLE)) {
  console.error('\nSKIP: .settings-preview/preview.js is missing; build the preview first.')
  process.exit(0)
}
const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the settings screenshots were NOT taken.')

const THEME = themeCss(NODE_MODULES)
const PRESETS = [
  {
    id: 'volc-ark-seedream',
    name: '字节 · 火山方舟（Seedream / Seedance）',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    hint: 'Seedream 文生图/图生图与 Seedance 文生视频/首尾帧，模型 ID 使用方舟控制台里的名称。',
    models: [
      { alias: 'doubao-seedream-5-0-pro-260628', id: 'doubao-seedream-5-0-pro-260628' },
      { alias: 'doubao-seedream-5-0-260128', id: 'doubao-seedream-5-0-260128' },
    ],
    videoModels: [
      { alias: 'doubao-seedance-2-0-260128', id: 'doubao-seedance-2-0-260128' },
      { alias: 'doubao-seedance-2-0-fast-260128', id: 'doubao-seedance-2-0-fast-260128' },
    ],
  },
  {
    id: 'qihang-aigc',
    name: '启航AIGC（Wan 3.0）',
    apiUrl: 'https://qh.token6688.com/v1',
    hint: 'Wan 3.0 视频，提交与轮询走启航的异步任务接口。',
    models: [],
    videoModels: [{ alias: 'wan-3-0', id: 'wan-3-0' }],
  },
  {
    id: 'openai-official',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    hint: 'OpenAI 官方图像生成接口。',
    models: [
      { alias: 'gpt-image-2.5', id: 'gpt-image-2.5' },
      { alias: 'gpt-image-2', id: 'gpt-image-2' },
    ],
  },
]
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>settings preview</title>
<script>
  window.__previewErrors = []
  addEventListener('error', event => window.__previewErrors.push(String(event.error?.stack || event.message)))
  addEventListener('unhandledrejection', event => window.__previewErrors.push(String(event.reason?.stack || event.reason)))
</script>
<style>${THEME}</style>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font-family: var(--dsh-font-family-text-default, -apple-system, sans-serif);
    -webkit-font-smoothing: antialiased;
  }
  .fixture {
    width: 850px;
    min-height: 1100px;
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr);
    background: var(--dsw-alias-bg-layer-1);
  }
  .nav {
    border-right: 1px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-layer-2);
    padding: 24px 12px;
  }
  .navTitle {
    padding: 0 10px 14px;
    color: var(--dsw-alias-label-primary);
    font-size: 15px;
    font-weight: 650;
  }
  .navRow {
    min-height: 34px;
    display: flex;
    align-items: center;
    border-radius: 8px;
    padding: 0 10px;
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
  }
  .navRow[data-active] {
    background: var(--dsw-alias-bg-layer-3);
    color: var(--dsw-alias-label-primary);
    font-weight: 560;
    box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2);
  }
  .pane {
    min-width: 0;
    padding: 18px 16px 40px;
  }
  #root { width: 100%; min-width: 0; }
</style>
</head>
<body>
  <div class="fixture">
    <aside class="nav">
      <div class="navTitle">设置</div>
      <div class="navRow">通用</div>
      <div class="navRow">连接器</div>
      <div class="navRow">能力</div>
      <div class="navRow" data-active>生图 / 生视频</div>
      <div class="navRow">Agent 预设</div>
    </aside>
    <main class="pane"><div id="root"></div></main>
  </div>
  <script src="/preview.js"></script>
</body>
</html>`

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url.startsWith('/?')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
  }
  if (url === '/preview.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': statSync(BUNDLE).size })
    createReadStream(BUNDLE).pipe(response)
    return
  }
  if (url === '/api/dsh-imagegen/presets') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, presets: PRESETS }))
    return
  }
  if (url.startsWith('/api/')) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, statuses: {}, usage: { byChannel: {}, totals: {} } }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const serverPort = server.address().port

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex > 0 ? process.argv[outIndex + 1] : join(ROOT, '.settings-preview')
mkdirSync(outDir, { recursive: true })

const launched = await launchChrome({
  chrome: CHROME,
  name: 'dsh-settings-preview',
  args: ['--window-size=850,1100', '--hide-scrollbars', '--force-device-scale-factor=2'],
})
const page = await (await import('./lib/headless-chrome.mjs')).openPage(launched.port, `http://127.0.0.1:${serverPort}/?state=configured`)

const waitFor = async (expression, label, attempts = 100) => {
  for (let i = 0; i < attempts; i++) {
    if ((await page.evaluate(expression)) === true) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.error('Preview errors:', await page.evaluate('window.__previewErrors'))
  console.error('Body:', await page.evaluate('document.body.innerText'))
  throw new Error(`timed out waiting for ${label}`)
}

const shoot = async name => {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 850, height: Math.max(900, await page.evaluate('Math.ceil(document.documentElement.scrollHeight)')),
    deviceScaleFactor: 2, mobile: false,
  })
  await new Promise(resolve => setTimeout(resolve, 150))
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
  const data = shot.result?.data
  if (typeof data !== 'string' || data.length === 0) throw new Error(`${name}: no screenshot data`)
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`  ${name.padEnd(24)} ${file}  ${(statSync(file).size / 1024).toFixed(0)} kB`)
}

try {
  await page.send('Page.enable', {})
  await waitFor('document.querySelector("[data-dsh-imagegen-settings-panel]") !== null', 'the settings card')
  await waitFor('document.fonts.status === "loaded"', 'fonts')

  const audit = await page.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-imagegen-settings-panel]')
    const pane = document.querySelector('.pane')
    const cr = card.getBoundingClientRect()
    const pr = pane.getBoundingClientRect()
    const wide = [...card.querySelectorAll('*')]
      .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto')
      .map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 50), delta: el.scrollWidth - el.clientWidth }))
      .slice(0, 8)
    return {
      card: { width: Math.round(cr.width), height: Math.round(cr.height) },
      pane: { width: Math.round(pr.width) },
      cardInside: cr.left >= pr.left - 0.5 && cr.right <= pr.right + 0.5,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      wide,
    }
  })()`)
  console.log('Layout audit:', JSON.stringify(audit, null, 2))

  await shoot('configured-light')
  await page.evaluate('document.body.setAttribute("data-ds-dark-theme", "")')
  await shoot('configured-dark')
  await page.evaluate('document.body.removeAttribute("data-ds-dark-theme")')

  const opened = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('配置图像模型'))
    button?.click()
    return button !== undefined
  })()`)
  if (!opened) throw new Error('the image-model setup action was not found')
  await waitFor('document.querySelector("[aria-modal=true][aria-label^=服务设置]") !== null', 'the service editor')
  await shoot('editor-image')

  const videoTab = await page.evaluate(`(() => {
    const editor = document.querySelector('[aria-modal=true][aria-label^=服务设置]')
    const tab = editor && [...editor.querySelectorAll('[role=tab]')][1]
    tab?.click()
    return tab !== undefined
  })()`)
  if (!videoTab) throw new Error('the video-model tab was not found')
  await shoot('editor-video')

  await page.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/?state=new` })
  await waitFor('document.querySelector("[data-dsh-imagegen-settings-panel]") !== null', 'the empty settings card')
  await waitFor('document.fonts.status === "loaded"', 'fonts after navigation')
  await shoot('new-user')
  const addService = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => (item.textContent ?? '').includes('添加服务'))
    button?.click()
    return button !== undefined
  })()`)
  if (!addService) throw new Error('the add-service action was not found')
  await waitFor('document.querySelector("[aria-label=添加服务商]") !== null', 'the provider picker')
  await shoot('provider-picker')
} finally {
  launched.close()
  server.close()
}

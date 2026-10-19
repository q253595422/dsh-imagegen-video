/**
 * Real-browser check for the PPT workspace: upload, reorder, convert, cancel,
 * result links, the configuration dialog, four viewports, inline slide
 * navigation, the two-pane desktop layout and the preview-retry path.
 *
 * Build first: `pnpm run ppt:preview` (emits `.ppt-preview/preview.js`).
 * Run: `pnpm run test:ppt-browser`.
 *
 * This is deliberately NOT part of `pnpm test`. It needs Playwright, which is
 * not a dependency of this repository, plus a Chromium binary. A missing tool
 * has to read as "skipped", never as a passing contract: the jsdom half of the
 * same surface lives in `scripts/smoke.mjs` (E1) and runs everywhere.
 *
 * Browser binary: `GENERATION_CHROMIUM_PATH` when set, otherwise the shared
 * `findChrome()` resolution the other browser guards use.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { findChrome } from './lib/headless-chrome.mjs'

/** Print the skip block and exit 0: a missing tool is not a regression. */
const skip = reason => {
  console.error('\n' + '='.repeat(72))
  console.error(`SKIP: ${reason}`)
  console.error('This is a MISSING TOOL, not a regression. The jsdom coverage in')
  console.error('scripts/smoke.mjs (E1) still runs; install Playwright and Chromium to gate on this.')
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}

let chromium
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  skip('playwright is not installed -- `npm i -D playwright && npx playwright install chromium`')
}
const executablePath = process.env.GENERATION_CHROMIUM_PATH ?? findChrome() ?? undefined
if (executablePath === undefined) skip('no Chromium binary (set GENERATION_CHROMIUM_PATH or CHROME_HEADLESS_SHELL)')
try {
  readFileSync(new URL('../.ppt-preview/preview.js', import.meta.url))
} catch {
  skip('.ppt-preview/preview.js is missing -- run `pnpm run ppt:preview` first')
}

const fieldValues = new Map()
const fields = [
  { id: 'image-api-key', label: '图像 API 密钥（可选）', type: 'secret', description: '已有 Codex OAuth 时可不填；需要 API 兜底时填写。' },
  { id: 'image-base-url', label: 'API 地址', type: 'string', default: 'https://api.openai.com/v1' },
  { id: 'image-model', label: '图像模型', type: 'string', default: 'gpt-image-2' },
  { id: 'paddle-ocr-token', label: 'PaddleOCR token（可选）', type: 'secret', description: '用于识别文字内容、文字框和字号。' },
]
const library = () => ({ entries: [{ name: 'image-to-editable-ppt', config: { fields, values: fields.map(field => ({ id: field.id, set: fieldValues.has(field.id), ...field.type !== 'secret' && fieldValues.has(field.id) ? { value: fieldValues.get(field.id) } : {} })), source: 'plugin', applicable: true, missing: [], note: '密钥只写入本机 ~/.editppt/config.yaml，不进入任务提示词。' } }] })
const slide = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#f7f9fd"/><rect x="70" y="72" width="10" height="78" rx="5" fill="#5669d8"/><text x="110" y="128" font-family="sans-serif" font-size="52" fill="#27304b">AI PLATFORM ROADMAP</text><text x="110" y="186" font-family="sans-serif" font-size="24" fill="#79839a">FROM KNOWLEDGE TO ACTION · 2026</text>${[0, 1, 2].map((i) => `<rect x="${110 + i * 470}" y="280" width="420" height="380" rx="24" fill="white" stroke="#dfe4ef"/><rect x="${140 + i * 470}" y="320" width="70" height="70" rx="16" fill="#e9edff"/><text x="${160 + i * 470}" y="368" font-family="sans-serif" font-size="32" fill="#5669d8">0${i + 1}</text><text x="${140 + i * 470}" y="457" font-family="sans-serif" font-size="32" fill="#27304b">${['KNOWLEDGE', 'WORKFLOW', 'INTELLIGENCE'][i]}</text><rect x="${140 + i * 470}" y="500" width="300" height="12" rx="6" fill="#e4e8f2"/><rect x="${140 + i * 470}" y="536" width="230" height="12" rx="6" fill="#edf0f7"/>`).join('')}<text x="110" y="810" font-family="sans-serif" font-size="20" fill="#8991a5">SAMPLE SLIDE · UI FIXTURE ONLY</text></svg>`
const tokens = `${process.env.GENERATION_FONT ? '@font-face{font-family:PreviewCJK;src:url(/font)}' : ''}:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#e6e8ef;--dsw-alias-label-primary:#252938;--dsw-alias-label-secondary:#6e7689;--dsw-alias-brand-primary:#5368d9}*{box-sizing:border-box}html,body,#root{margin:0;height:100%;font-family:PreviewCJK,system-ui,sans-serif}.fixture{height:100%;display:flex;flex-direction:column;padding:20px;gap:18px;background:#f5f6fa;color:#252938}.fixture>header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px}.fixture>header span{color:#8790a4}.fixture>header button{border:1px solid #e3e6ed;background:#fff;border-radius:8px;padding:6px;font:inherit}.fixture>main{flex:1;min-height:0}.fixture>main.settings{overflow:auto;padding:24px;border-radius:16px;background:white}.settings h2{font-size:18px}`
const server = createServer(async (req, res) => {
  if (req.url === '/font' && process.env.GENERATION_FONT) { res.end(readFileSync(process.env.GENERATION_FONT)); return }
  if (req.url === '/preview.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(new URL('../.ppt-preview/preview.js', import.meta.url))); return }
  if (req.url?.startsWith('/slide.png')) { res.setHeader('content-type', 'image/svg+xml'); res.end(slide); return }
  if (req.url?.startsWith('/api/')) {
    let body = ''
    for await (const chunk of req) body += chunk
    const input = body ? JSON.parse(body) : {}
    if (req.url.endsWith('/config/save')) for (const value of input.values ?? []) fieldValues.set(value.id, value.value)
    const value = req.url.endsWith('/runtime') ? { runtime: { available: true, message: 'editppt ready · Python 3.11 · dependencies installed' } } : req.url.endsWith('/config/apply') ? { library: library(), steps: [] } : { library: library() }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, ...value })); return
  }
  res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}</style><div id="root"></div><script src="/preview.js"></script></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const file = { name: 'slide-1.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('[data-ppt-upload-empty]').count(), 1)
  await page.locator('input[type=file]').setInputFiles([file, { ...file, name: 'slide-2.png' }])
  await page.waitForFunction(() => document.querySelectorAll('[data-ppt-input]').length === 2)
  assert.equal(await page.locator('[data-ppt-upload-empty]').count(), 0)
  assert.equal(await page.locator('[data-ppt-add]').count(), 1)
  await page.locator('[data-ppt-input] button[title="预览原图"]').first().click()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.locator('[data-ppt-open-settings]').click()
  await page.getByRole('dialog', { name: '图片转 PPT 配置', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('向前移动一页').nth(1).click()
  assert.ok((await page.locator('[data-ppt-input]').first().textContent()).includes('slide-2.png'))
  await page.getByRole('button', { name: '生成可编辑 PPT', exact: true }).click()
  await page.waitForSelector('[data-task-status=running]')
  await page.getByRole('button', { name: '取消转换', exact: true }).click()
  await page.waitForSelector('[data-task-status=cancelled]')
  await page.getByRole('button', { name: '示例完成', exact: true }).click()
  await page.waitForSelector('[data-task-status=completed] a[download="editable-deck.pptx"]')
  assert.equal(await page.locator('[data-ppt-task] img').count(), 0, 'results show only PPT files, no source or auxiliary images')
  assert.equal(await page.locator('[data-ppt-deck]').count(), 1)
  await page.locator('[data-ppt-slide="1"]').getByText('Editable presentation content', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.locator('[data-ppt-slide="2"]').getByText('NEXT STEPS', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true)
  await page.locator('[data-ppt-page="1"]').click()
  await page.locator('[data-ppt-slide="1"]').waitFor()
  await page.locator('[data-ppt-preview]').click()
  await page.getByRole('dialog', { name: 'editable-deck.pptx', exact: true }).waitFor()
  await page.getByRole('dialog').locator('[data-ppt-slide]').getByText('Editable presentation content', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  mkdirSync(new URL('../docs/images/', import.meta.url), { recursive: true })
  await page.locator('.fixture>main').screenshot({ path: new URL('../docs/images/ppt-mode.png', import.meta.url).pathname })
  for (const viewport of [{ width: 390, height: 780 }, { width: 800, height: 360 }, { width: 1280, height: 850 }, { width: 1920, height: 1000 }]) {
    await page.setViewportSize(viewport)
    assert.ok(await page.locator('[data-ppt-workspace]').isVisible())
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow: ${viewport.width}`)
  }
  await page.getByRole('button', { name: '示例预览重试', exact: true }).click()
  await page.getByText('预览失败：Preview temporarily unavailable', { exact: false }).waitFor()
  assert.ok(await page.locator('a[download="editable-deck.pptx"]').isVisible(), 'a preview error does not hide the deck download')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('[data-ppt-slide="1"]').waitFor()
  await page.getByRole('button', { name: '示例失败', exact: true }).click()
  await page.waitForSelector('[data-task-status=failed]')
  const layout = await page.locator('[data-ppt-workspace]').evaluate(el => { const results = el.querySelector('main'); const sidebar = el.querySelector('aside'); const box = x => { const r = x.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width } }; return { results: box(results), sidebar: box(sidebar) } })
  assert.ok(layout.results.left >= layout.sidebar.right, 'desktop results sit to the right of parameters')
  assert.ok(Math.abs(layout.results.top - layout.sidebar.top) < 2, 'desktop panes share their top edge')
  assert.ok(layout.results.width > layout.sidebar.width, 'preview receives the larger pane')
  await page.locator('[data-ppt-workspace]').screenshot({ path: new URL('../docs/images/ppt-mode-failed-wide.png', import.meta.url).pathname })
  await page.locator('[data-ppt-diagnostic]').click()
  const diagnostic = JSON.parse(await page.getByRole('textbox', { name: '任务诊断', exact: true }).inputValue())
  assert.equal(diagnostic.agentSessionId, 'skillagent-preview')
  assert.equal(diagnostic.error, 'Model API returned 401')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.locator('[data-ppt-open-settings]').click()
  await page.locator('[data-ppt-setup] input[type=password]').first().waitFor()
  await page.locator('[data-ppt-setup] input[type=password]').nth(1).fill('fixture-token-not-a-real-secret')
  await page.getByRole('button', { name: '保存并应用 PPT 配置', exact: true }).click()
  await page.getByText('PPT 配置已保存并应用。', { exact: true }).waitFor()
  assert.equal(fieldValues.get('paddle-ocr-token'), 'fixture-token-not-a-real-secret')
  assert.equal(await page.locator('[data-ppt-setup] input[type=password]').nth(1).inputValue(), '')
  await page.evaluate(() => document.fonts.ready)
  await page.getByRole('dialog', { name: '图片转 PPT 配置', exact: true }).screenshot({ path: new URL('../docs/images/ppt-settings.png', import.meta.url).pathname })
  assert.deepEqual(errors, [])
  console.log('PPT browser checks passed: upload, order, conversion, cancel, result links, configuration, four viewports, inline slide navigation and two-pane desktop layout.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}

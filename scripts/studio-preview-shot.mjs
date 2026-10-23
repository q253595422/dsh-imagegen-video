/**
 * Shoot the visual-acceptance screenshots for the image studio.
 *
 * What is REAL here:
 *  - the panel itself: the built `.studio-preview/preview.js` runs the same
 *    `mountSidebarEntry` + `mountPanel` calls the shipped plugin runs, renders
 *    the same `ImageGenPanel`, and uses the same `Button`/`Pill` primitives
 *    (bundled, not stubbed);
 *  - every colour, radius, shadow and font: the theme stylesheet is extracted
 *    from the INSTALLED DSH (`dsh-client-ui-theme`), not retyped;
 *  - the sidebar/layout chrome: likewise extracted from the installed
 *    `dsh-client-ui-sidebar` and `dsh-client-ui-layout` stylesheets, and the
 *    fixture DOM follows the slot anchors those packages emit.
 *
 * What is NOT real: the surrounding content (session rows, conversation text,
 * the shell's inline column widths). Those are fixture decoration; this page is
 * a harness, not a screenshot of a running GUI.
 *
 * Run: node scripts/studio-preview-shot.mjs [--out DIR]
 * Exit 0 = both themes written. Skips loudly when no headless Chromium exists.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, launchChrome, skipWithoutChrome } from './lib/headless-chrome.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, '.studio-preview', 'preview.js')
const THEME_PACKAGE = 'dsh-client-ui-theme'
const SIDEBAR_PACKAGE = 'dsh-client-ui-sidebar'
const LAYOUT_PACKAGE = 'dsh-client-ui-layout'

/** Where the installed DSH client packages live. */
function dshNodeModules() {
  const candidates = [
    process.env.DSH_ASAR_DIR,
    '/tmp/dshnative/dsh/node_modules',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  ].filter(Boolean)
  return candidates.find(dir => existsSync(join(dir, '@deepseek-ai'))) ?? null
}

/**
 * Pull one package's inlined CSS-module text out of its client bundle.
 *
 * DSH ships stylesheets as `const css = "…"` string constants next to the
 * `//#region \0dsh-css:` banner, then injects them as `<style>`. Reading that
 * constant is the only way to get the shell's real hashed class names — they
 * are not in any `.css` file on disk and they change every release.
 */
function inlineCss(nodeModules, packageName, needle) {
  const file = join(nodeModules, '@deepseek-ai', packageName, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  // The literal may contain escaped quotes (`content:"\2014"`), so the body
  // has to allow `\"` — a plain `[^"]*` stops at the first one.
  const pattern = /^\s*(?:const|var)\s+(\w+)\s*=\s*("(?:[^"\\]|\\.)*");?\s*$/gm
  const found = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    if (!match[2].includes(needle)) continue
    found.push(JSON.parse(match[2]))
  }
  if (found.length === 0) throw new Error(`${packageName}: no inlined CSS containing "${needle}"`)
  return found.join('\n')
}

/** Every theme stylesheet, in the order the theme package injects them. */
function themeCss(nodeModules) {
  const file = join(nodeModules, '@deepseek-ai', THEME_PACKAGE, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  const pattern = /^\s*var\s+(\w*_css_default)\s*=\s*("(?:[^"\\]|\\.)*");?\s*$/gm
  const blocks = []
  let match
  while ((match = pattern.exec(source)) !== null) blocks.push(JSON.parse(match[2]))
  if (blocks.length === 0) throw new Error('theme package: no inlined CSS constants')
  return blocks.join('\n')
}

const NODE_MODULES = dshNodeModules()
if (NODE_MODULES === null) {
  console.error('\nSKIP: no installed DSH found -- the visual preview needs its theme tokens.')
  console.error('Point DSH_ASAR_DIR at a DSH `node_modules` directory to run this.')
  process.exit(0)
}
if (!existsSync(BUNDLE)) {
  console.error(`\nSKIP: ${BUNDLE} is missing. Run \`pnpm studio:preview\` first.`)
  process.exit(0)
}
const CHROME = findChrome()
if (CHROME === null) skipWithoutChrome('the visual-acceptance screenshots were NOT taken.')

const THEME = themeCss(NODE_MODULES)
const SIDEBAR = inlineCss(NODE_MODULES, SIDEBAR_PACKAGE, '_3WPZCG_')
const LAYOUT = inlineCss(NODE_MODULES, LAYOUT_PACKAGE, '_6Qf49G_')

/** Class names the shell ships, resolved from the extracted stylesheets. */
function shellClass(stylesheet, name) {
  const found = new RegExp(`\\.([\\w-]+_${name})(?![\\w-])`).exec(stylesheet)
  if (found === null) throw new Error(`shell stylesheet has no ".…_${name}" class`)
  return found[1]
}

const S = name => shellClass(SIDEBAR, name)
const L = name => shellClass(LAYOUT, name)

/** One workspace row in the shell's own session tree. */
const workspaceRow = title => `<div style="display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:13px">
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/></svg>
  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>
</div>`

const PAGE = `<!doctype html>
<html lang="zh-CN" data-platform="darwin">
<head>
<meta charset="utf-8">
<title>studio preview</title>
<style>${THEME}</style>
<style>${SIDEBAR}</style>
<style>${LAYOUT}</style>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font-family: var(--dsh-font-family-text-default, -apple-system, sans-serif);
    -webkit-font-smoothing: antialiased;
  }
  /* The layout puts the two columns side by side through an inline style on
     the frame; this fixture picks the same 264px the app uses by default. */
  .fixture-frame { grid-template-columns: 264px minmax(0, 1fr); }
  .fixture-conversation {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; height: 100%; padding: 24px; box-sizing: border-box; text-align: center;
  }
  .fixture-hero { font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  .fixture-sub { font-size: 13px; color: var(--dsw-alias-label-secondary); }
</style>
</head>
<body>
<div class="${L('frame')} fixture-frame">

  <div class="${L('sidebarCol')}">
    <div class="${S('root')}">

      <div class="${S('logoRow')}" data-window-drag>
        <button class="${S('brand')}" aria-label="新建会话" style="background:none;border:none">
          <span class="${S('brandIdentity')}">
            <span class="${S('brandMark')}">
              <div data-slot="sidebar.brand.mark" style="display:contents">
                <svg viewBox="0 0 23.16 17.04" width="21" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M22.9 1.4c-.2-.1-.35.1-.5.25-.05.04-.09.09-.13.13-.36.38-.78.63-1.33.6-.8-.04-1.48.21-2.09.82-.13-.75-.55-1.2-1.2-1.49-.34-.15-.68-.3-.92-.63-.17-.23-.21-.49-.3-.75-.05-.15-.1-.31-.28-.34-.2-.03-.27.13-.35.27-.3.55-.42 1.16-.4 1.78.02 1.38.61 2.49 1.77 3.27.13.09.17.18.13.31-.08.27-.18.53-.26.8-.05.17-.13.21-.32.14-.64-.27-1.19-.66-1.68-1.14-.82-.8-1.57-1.68-2.5-2.37-.22-.16-.44-.31-.67-.45-.95-.92.13-1.68.38-1.77.26-.1.09-.42-.75-1.18" />
                </svg>
              </div>
            </span>
            <span class="${S('brandName')}">
              <div data-slot="sidebar.brand.name" style="display:contents">DeepSeek Harness</div>
            </span>
          </span>
        </button>
        <button class="${S('iconButton')} ${S('toggle')}" aria-label="收起侧栏">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6.5 2.5v11"/></svg>
        </button>
      </div>

      <button class="${S('newSession')}" aria-label="新建会话">
        <span class="${S('newSessionContent')}">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3v10M3 8h10"/></svg>
          <span class="${S('newSessionLabelMask')}"><span class="${S('newSessionLabel')}">新建会话</span></span>
        </span>
      </button>

      <div class="${S('regionArea')}">
        <div data-slot="sidebar.workspaces" style="display:contents">
          ${workspaceRow('重构安装脚本')}
          ${workspaceRow('图片生成插件')}
          ${workspaceRow('周报整理')}
        </div>
      </div>

      <div class="${S('footArea')}">
        <div data-slot="sidebar.footer.action" style="display:contents"></div>
        <div data-slot="sidebar.settings" style="display:contents">
          <div style="display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;font-size:13px;color:var(--dsw-alias-label-secondary)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.2"/><path d="M8 2v1.4M8 12.6V14M2 8h1.4M12.6 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1"/></svg>
            <span>设置</span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <div class="${L('centerCol')}">
    <div data-slot="main" style="display: contents">
      <div data-slot="main.conversation" style="display: contents">
        <div data-phase="hero" class="fixture-conversation">
          <div class="fixture-hero">今天想做点什么？</div>
          <div class="fixture-sub">对话内容为夹具占位，用于标定原生排版与配色</div>
        </div>
      </div>
    </div>
  </div>

</div>
<script src="/preview.js"></script>
</body>
</html>`

/* ------------------------------------------------------------------ serve */

const assets = new Map([
  ['/preview.js', { type: 'text/javascript; charset=utf-8', size: statSync(BUNDLE).size }],
])

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url.startsWith('/?')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
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

/* ------------------------------------------------------------------ shoot */

const shotIndex = process.argv.indexOf('--out')
const outDir = shotIndex > 0 ? process.argv[shotIndex + 1] : join(ROOT, '.studio-preview')
mkdirSync(outDir, { recursive: true })

const launched = await launchChrome({
  chrome: CHROME,
  name: 'dsh-studio-preview',
  args: ['--window-size=1440,900', '--hide-scrollbars', '--force-device-scale-factor=2'],
})
const page = await (async () => {
  const { openPage } = await import('./lib/headless-chrome.mjs')
  return openPage(launched.port, `http://127.0.0.1:${serverPort}/`)
})()

let failure
try {
  await page.send('Page.enable', {})
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })

  /** Wait for a predicate in the page, failing loudly instead of sleeping. */
  const waitFor = async (expression, label, attempts = 100) => {
    for (let i = 0; i < attempts; i++) {
      if ((await page.evaluate(expression)) === true) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  await waitFor('document.readyState === "complete"', 'the page to load')
  // The preview bundle renders the panel only after `mountPanel` resolves the
  // centre column from its slot anchor, so this is the honest readiness signal.
  await waitFor(
    `document.querySelector('[data-dsh-imagegen-view] [data-dsh-imagegen-history]') !== null
     || document.querySelectorAll('[data-dsh-imagegen-view] button').length > 5`,
    'the studio to render',
  )
  await waitFor('document.fonts.status === "loaded"', 'fonts to settle')
  // The component switcher reads its surface and then ANIMATES its ink over
  // 300ms (`GooeyNav.module.css` transitions `color`). Measuring before that
  // settles reads a colour that is neither the light nor the dark token, so a
  // transition would show up as a contrast failure that no user ever sees.
  await waitFor('document.getAnimations().every(animation => animation.playState !== "running")',
    'the mount transitions to settle')

  const shoot = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const data = shot.result?.data
    if (typeof data !== 'string' || data.length === 0) throw new Error(`${name}: no screenshot data`)
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    const bytes = statSync(file).size
    console.log(`  ${name.padEnd(10)} ${file}  ${(bytes / 1024).toFixed(0)} kB`)
    return file
  }

  // I cannot look at the PNGs, so the things a reviewer would judge by eye are
  // measured here instead: does the studio fill its column, does anything get
  // clipped, is the type on DSH's scale, and does the text sit on real tokens.
  const audit = await page.evaluate(`(() => {
    const view = document.querySelector('[data-dsh-imagegen-view]')
    if (view === null) return { error: 'the studio never rendered' }
    const box = element => {
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    }
    const viewRect = view.getBoundingClientRect()
    const fonts = new Map()
    const clipped = []
    const outside = []
    const palette = new Map()
    let elements = 0
    for (const element of view.querySelectorAll('*')) {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      elements += 1
      fonts.set(style.fontSize, (fonts.get(style.fontSize) ?? 0) + 1)
      if ((element.textContent ?? '').trim() !== '' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        const key = style.backgroundColor
        palette.set(key, (palette.get(key) ?? 0) + 1)
      }
      // Content taller/wider than its own box, with the overflow hidden, is
      // text the user cannot reach — the failure mode that shipped in #3.
      const hides = style.overflowX !== 'visible' || style.overflowY !== 'visible'
      if (hides && element.clientHeight > 0 && element.scrollHeight - element.clientHeight > 2) {
        clipped.push({ tag: element.tagName, cls: String(element.className).slice(0, 44),
          needs: element.scrollHeight, has: element.clientHeight,
          text: (element.textContent ?? '').trim().slice(0, 28) })
      }
      if (hides && element.clientWidth > 0 && element.scrollWidth - element.clientWidth > 2) {
        clipped.push({ tag: element.tagName, cls: String(element.className).slice(0, 44),
          needsW: element.scrollWidth, hasW: element.clientWidth,
          text: (element.textContent ?? '').trim().slice(0, 28) })
      }
      if (style.position !== 'fixed' && element !== view
          && (rect.right > viewRect.right + 1 || rect.bottom > viewRect.bottom + 1)) {
        outside.push({ tag: element.tagName, cls: String(element.className).slice(0, 44),
          box: box(element) })
      }
    }
    const ladder = [...fonts.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    const root = getComputedStyle(document.documentElement)
    return {
      view: box(view),
      column: box(view.parentElement),
      elements,
      fontLadder: ladder.map(([size, count]) => size + ' x' + count),
      offScaleFonts: ladder.map(([size]) => size).filter(size => !${JSON.stringify([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28])}.includes(parseFloat(size))),
      // A button that owns no text can sit at any size without showing; only
      // elements that paint their OWN text matter for "does the type look native".
      // The switcher is a flex child that refuses to shrink without a zero
      // min-width, and GooeyNav.module.css records that it once slid under the
      // chat toggle. Overlap is measured because a PNG at 2x is not something I
      // can look at, and "fits" is exactly what breaks on resize.
      headerOverlap: (() => {
        const header = view.querySelector('header')
        if (header === null) return null
        const nav = header.querySelector('nav')
        const actions = [...header.querySelectorAll('button, span')]
          .filter(node => node !== nav && !nav?.contains(node))
          .filter(node => /chatToggle|connectionStatus|githubLink/.test(String(node.className)))
        if (nav === null) return { nav: null }
        const box = nav.getBoundingClientRect()
        const clashes = actions
          .map(node => ({ cls: String(node.className).split(' ')[0], box: node.getBoundingClientRect() }))
          .filter(one => box.left < one.box.right && one.box.left < box.right)
          .map(one => one.cls)
        return {
          nav: { right: Math.round(box.right), width: Math.round(box.width) },
          actions: actions.map(node => Math.round(node.getBoundingClientRect().left)),
          clashes,
        }
      })(),
      strangers: ['15px', '16px'].flatMap(size => [...view.querySelectorAll('*')]
        .filter(element => getComputedStyle(element).fontSize === size
          && [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim() !== ''))
        .slice(0, 3)
        .map(element => size + '  ' + element.tagName + '.' + String(element.className).slice(0, 30)
          + '  "' + (element.textContent ?? '').trim().slice(0, 24) + '"')),
      offScaleMembers: [...view.querySelectorAll('*')]
        .filter(element => getComputedStyle(element).fontSize === '13.3333px')
        .slice(0, 30)
        .map(element => element.tagName + '.' + String(element.className).slice(0, 34)
          + (element.parentElement === null ? '' : ' < ' + String(element.parentElement.className).slice(0, 26))),
      offScaleOwners: [...view.querySelectorAll('*')].filter(element => {
        const size = parseFloat(getComputedStyle(element).fontSize)
        if (${JSON.stringify([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28])}.includes(size)) return false
        if (element.getBoundingClientRect().width === 0) return false
        return [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim() !== '')
      }).slice(0, 12).map(element => ({
        tag: element.tagName, size: getComputedStyle(element).fontSize,
        cls: String(element.className).slice(0, 40),
        text: (element.textContent ?? '').trim().slice(0, 24),
        parent: String(element.parentElement?.className ?? '').slice(0, 40),
      })),
      clipped: clipped.slice(0, 10),
      clippedTotal: clipped.length,
      outsideView: outside.slice(0, 10),
      outsideTotal: outside.length,
      // A near-black fill inside a LIGHT theme is the single most visible way a
      // plugin stops looking native, and a palette count cannot say which
      // element it is: rgb(15, 17, 21) x2 names no element at all.
      //
      // Parsed by hand, not with a regex: this function travels to the page as
      // a template literal, so a backslash written here arrives doubled or
      // eaten depending on where it sits, and an escaped regex silently becomes
      // a different regex that matches everything (the first attempt reported
      // zero matches for two visibly dark elements).
      darkInLight: (() => {
        const channels = value => {
          const open = value.indexOf('(')
          const close = value.indexOf(')')
          if (open < 0 || close < open) return null
          const parts = value.slice(open + 1, close).split(',').map(part => parseFloat(part))
          return parts.length < 3 ? null : parts
        }
        const found = []
        for (const element of view.querySelectorAll('*')) {
          const value = getComputedStyle(element).backgroundColor
          const parts = channels(value)
          if (parts === null) continue
          if (parts.length > 3 && parts[3] === 0) continue
          if ((parts[0] + parts[1] + parts[2]) / 3 >= 60) continue
          found.push(element.tagName + '.' + String(element.className).slice(0, 34)
            + ' ' + value + ' "' + (element.textContent ?? '').trim().slice(0, 18) + '"')
        }
        return { total: found.length, names: found.slice(0, 8) }
      })(),
      panelBackground: getComputedStyle(view.firstElementChild ?? view).backgroundColor,
      surfaces: [...palette.entries()].slice(0, 10).map(([color, count]) => color + ' x' + count),
      pageBackground: getComputedStyle(document.body).backgroundColor,
      contentFontSize: root.getPropertyValue('--dsh-content-font-size').trim(),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }
  })()`)
  console.log('\nAudit (light theme):', JSON.stringify(audit, null, 2))

  // The other half of "looks native" is the shell around the studio: the
  // plugin's own switcher must be there, the shell's chrome must survive, and
  // unrelated plugin entries must be gone. All three are injected/hidden by the
  // real code, so this measures the shipped behaviour rather than a mock of it.
  const sidebar = await page.evaluate(`(() => {
    const root = document.querySelector('[data-dsh-imagegen-sidebar-root]')
    const visible = element => {
      if (element === null) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none'
    }
    const tabs = document.querySelector('[data-dsh-imagegen-session-tabs]')
    const host = document.querySelector('[data-dsh-imagegen-history-host]')
    const history = document.querySelector('[data-dsh-imagegen-history]')
    const newSession = document.querySelector('[data-dsh-imagegen-new-session]')
    const blocks = [...document.querySelectorAll('[data-dsh-imagegen-sidebar-block]')]
    // A slot anchor is display:contents by contract, so it has no box of its
    // own; what must stay visible is whatever the shell renders INSIDE it.
    const spare = selector => {
      const anchor = document.querySelector(selector)
      if (anchor === null) return 'missing'
      if (visible(anchor)) return true
      return [...anchor.querySelectorAll('*')].some(visible)
    }
    return {
      sidebarRoot: visible(root),
      rooted: root === null ? null : root.getAttribute('data-dsh-imagegen-shell-blocks') !== null,
      tabs: visible(tabs),
      tabLabels: tabs === null ? [] : [...tabs.querySelectorAll('[data-dsh-imagegen-tab]')].map(tab => tab.textContent.trim()),
      newSessionSpared: newSession !== null && visible(newSession),
      brandSpared: spare('[data-slot="sidebar.brand.mark"]'),
      workspacesSpared: spare('[data-slot="sidebar.workspaces"]'),
      settingsSpared: spare('[data-slot="sidebar.settings"]'),
      historyHost: visible(host),
      historyPortalLanded: history !== null && host !== null && host.contains(history),
      historyRows: document.querySelectorAll('[data-dsh-imagegen-history-main]').length,
      markedBlocks: blocks.length,
      shellChromeHidden: blocks.filter(block => !visible(block)).length,
    }
  })()`)
  console.log('\nSidebar audit:', JSON.stringify(sidebar, null, 2))

  // Text contrast against its own background, computed from the ACTUAL painted
  // colours (including inherited transparency), so a token that resolves to a
  // low-contrast pair shows up here instead of needing an eye on the PNG.
  const contrastPass = () => page.evaluate(`(() => {
    // Parsed by hand rather than with a regex: this whole function is sent to
    // the page as a template literal, and every backslash in it is eaten on the
    // way out, which silently turned escaped regexes into different regexes.
    const parse = value => {
      const open = value.indexOf('(')
      const close = value.indexOf(')')
      if (open < 0 || close < open) return null
      const parts = value.slice(open + 1, close).split(',').map(part => parseFloat(part))
      if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    })
    // A painted ::after/::before sits BETWEEN an element and its own content,
    // and the selected pill in a segmented control is exactly that: opaque
    // pseudo-element, transparent element. Walking only element backgrounds
    // read the page behind the pill and reported white-on-white.
    const pseudoBackdrop = element => {
      for (const pseudo of ['::after', '::before']) {
        const style = getComputedStyle(element, pseudo)
        if (style.content === 'none' || style.content === 'normal') continue
        const colour = parse(style.backgroundColor)
        if (colour === null || colour.a === 0) continue
        if (parseFloat(style.opacity) === 0) continue
        return colour
      }
      return null
    }
    // The gooey switcher draws its selected pill as an absolutely positioned
    // SIBLING layer under a copy of the label, so an ancestor-only walk reads
    // the page behind the pill. Anything painted by an earlier sibling is below
    // the element in normal flow order, so those count as backdrop too.
    // A sibling only sits BELOW this element where the two actually overlap.
    // The segmented control paints its selected pill on the LI of the ACTIVE
    // tab, and the unselected tabs' labels overlap none of it: without this
    // test an unselected label was measured against the neighbouring pill's
    // fill and reported 1.36:1 in the dark theme.
    const overlaps = (a, b) => {
      const one = a.getBoundingClientRect()
      const two = b.getBoundingClientRect()
      return one.left < two.right && two.left < one.right
        && one.top < two.bottom && two.top < one.bottom
    }
    const siblingPaint = node => {
      let sibling = node.previousElementSibling
      while (sibling !== null) {
        if (overlaps(sibling, node)) {
          const style = getComputedStyle(sibling)
          const pseudo = pseudoBackdrop(sibling)
          if (pseudo !== null && pseudo.a > 0) return pseudo
          const colour = parse(style.backgroundColor)
          if (colour !== null && colour.a > 0) return colour
        }
        sibling = sibling.previousElementSibling
      }
      return null
    }
    const backdrop = element => {
      let node = element
      const stack = []
      const trace = []
      while (node !== null) {
        const pseudo = pseudoBackdrop(node)
        const own = parse(getComputedStyle(node).backgroundColor)
        const sibling = own !== null && own.a > 0 ? null : siblingPaint(node)
        if (pseudo !== null) stack.push(pseudo)
        if (own !== null && own.a > 0) stack.push(own)
        else if (sibling !== null) stack.push(sibling)
        const shape = value => value === null ? '-'
          : Math.round(value.r) + ',' + Math.round(value.g) + ',' + Math.round(value.b) + ',' + value.a
        trace.push(node.tagName + '.' + String(node.className).split(' ')[0].slice(0, 20)
          + ' own=' + shape(own) + ' pseudo=' + shape(pseudo) + ' sib=' + shape(sibling))
        node = node.parentElement
      }
      return {
        colour: stack.reverse().reduce((below, above) => over(above, below),
          { r: 255, g: 255, b: 255, a: 1 }),
        trace,
      }
    }
    const luminance = colour => {
      const channel = value => {
        const scaled = value / 255
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b)
    }
    const ratio = (a, b) => {
      const one = luminance(a)
      const two = luminance(b)
      return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
    }
    // Text that is not painted cannot be unreadable. Hover-only captions sit at
    // opacity 0 until the pointer arrives, so counting them would report a
    // contrast failure for something no user can see on this screenshot.
    const painted = element => {
      let node = element
      while (node !== null && node !== document.documentElement) {
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        if (parseFloat(style.opacity) === 0) return false
        // The gooey switcher paints a decorative COPY of each label above the
        // selected pill. Measuring that copy reads it against whatever is
        // behind the overlay rather than the pill it actually sits on, so it
        // would report a failure for a control that is readable in the PNG.
        // The real label lives inside the button and is measured on its own.
        if (style.pointerEvents === 'none' && style.position === 'absolute') return false
        const box = node.getBoundingClientRect()
        if (node !== element && (box.width === 0 || box.height === 0)) return false
        node = node.parentElement
      }
      return true
    }
    const view = document.querySelector('[data-dsh-imagegen-view]')
    const rows = []
    const skipped = []
    let worst = { ratio: Infinity }
    for (const element of view.querySelectorAll('*')) {
      const owns = [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim() !== '')
      if (!owns) continue
      if (!painted(element)) {
        skipped.push(element.textContent.trim().slice(0, 18))
        continue
      }
      const style = getComputedStyle(element)
      const text = parse(style.color)
      if (text === null) continue
      const below = backdrop(element).colour
      const value = ratio(over(text, below), below)
      const row = { text: element.textContent.trim().slice(0, 18), ratio: Math.round(value * 100) / 100,
        size: style.fontSize, colour: style.color,
        cls: String(element.className).slice(0, 40),
        parent: String(element.parentElement?.className ?? '').slice(0, 40) }
      // A failure row has to say WHERE it is: "素材库 1.36" names neither the
      // element nor its class, and guessing which copy of a label it is would
      // send the fix to the wrong file.
      if (value < 3) {
        row.html = element.outerHTML.slice(0, 150)
        row.backdrop = 'rgb(' + [below.r, below.g, below.b].map(n => Math.round(n)).join(', ') + ')'
        row.trace = backdrop(element).trace
      }
      rows.push(row)
      if (value < worst.ratio) worst = row
    }
    const tooLow = rows.filter(row => row.ratio < 3)
    return {
      sampled: rows.length,
      notPainted: skipped.length,
      worst,
      belowThreeToOne: tooLow.length,
      examples: tooLow.slice(0, 8),
    }
  })()`)
  const contrast = await contrastPass()
  console.log('\nContrast audit (light theme):', JSON.stringify(contrast, null, 2))

  // A drag that the system interrupts (touch scroll takeover, an OS dialog,
  // alt-tab) never delivers `pointerup`. Left unhandled, that pins `cursor:
  // col-resize` and `user-select: none` onto <html> forever — the page has to
  // be reloaded to get a normal cursor back. Driven with real trusted mouse
  // input so the handler runs exactly as it does under a user's finger.
  const dragCancel = await (async () => {
    const spot = await page.evaluate(`(() => {
      const handle = document.querySelector('[data-dsh-imagegen-view] [class*="configResizer"]')
      if (handle === null) return null
      const rect = handle.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    if (spot === null) return { error: 'no config resize handle in the panel' }
    const html = `document.documentElement.style`
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1, pointerType: 'mouse',
    })
    const whileDragging = await page.evaluate(
      `({ cursor: ${html}.getPropertyValue('cursor'), userSelect: ${html}.getPropertyValue('user-select') })`)
    // The interruption: the pointer goes away without a release.
    await page.evaluate(
      `window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'mouse' }))`)
    const afterCancel = await page.evaluate(
      `({ cursor: ${html}.getPropertyValue('cursor'), userSelect: ${html}.getPropertyValue('user-select') })`)
    if (whileDragging.cursor === 'col-resize' && afterCancel.cursor === '') {
      // Only release the button if the cancel left it logically down, otherwise
      // the next mousePressed would be swallowed as a double click.
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1, pointerType: 'mouse',
      })
    }
    return {
      whileDragging,
      afterCancel,
      cleared: afterCancel.cursor === '' && afterCancel.userSelect === '',
    }
  })()
  console.log('\nDrag-cancel probe:', JSON.stringify(dragCancel, null, 2))

  console.log('Shooting:')
  await shoot('light')
  // The theme flips on `body[data-ds-dark-theme]`, exactly as DSH does it.
  await page.evaluate(`document.body.setAttribute('data-ds-dark-theme', '')`)
  await new Promise(resolve => setTimeout(resolve, 250))

  // Half of "looks native" is the dark theme, and its tokens are a different
  // table: a pair that fails in dark can pass in light. Measured again rather
  // than assumed, because the PNG alone cannot tell me either way.
  const contrastDark = await contrastPass()
  console.log('\nContrast audit (dark theme):', JSON.stringify(contrastDark, null, 2))

  await shoot('dark')

  const report = await page.evaluate(`(() => {
    const view = document.querySelector('[data-dsh-imagegen-view]')
    const rect = view === null ? null : view.getBoundingClientRect()
    const body = getComputedStyle(document.body)
    return {
      view: rect === null ? null : { width: Math.round(rect.width), height: Math.round(rect.height) },
      bg: body.backgroundColor,
      tokens: ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l1']
        .map(name => name + '=' + body.getPropertyValue(name).trim()),
      primitives: Array.from(view?.querySelectorAll('button') ?? [])
        .map(button => button.className.split(' ')[0]).filter((name, index, all) => all.indexOf(name) === index),
    }
  })()`)
  console.log('\nMeasured:', JSON.stringify(report, null, 2))
  // Disabling a plugin must leave the host exactly as it was found. Everything
  // below is state this plugin wrote onto DSH's OWN elements: attributes, an
  // inline custom property, injected nodes, and html-level flags. Measured
  // after calling the real disposers, not by reading the source.
  const uninstall = await page.evaluate(`(() => {
    const count = selector => document.querySelectorAll(selector).length
    const htmlAttrs = () => Array.from(document.documentElement.attributes)
      .map(attribute => attribute.name).filter(name => name.startsWith('data-dsh-imagegen'))
    const htmlStyle = () => Array.from(document.documentElement.style)
      .filter(name => name.startsWith('--dsh-imagegen'))
    const widthVar = () => Array.from(document.querySelectorAll('*'))
      .filter(element => element.style.getPropertyValue('--dsh-imagegen-chat-width') !== '').length
    const snapshot = () => ({
      centerCol: count('[data-dsh-imagegen-center-col]'),
      view: count('[data-dsh-imagegen-view]'),
      resizer: count('[data-dsh-imagegen-chat-resizer]'),
      tabs: count('[data-dsh-imagegen-session-tabs]'),
      historyHost: count('[data-dsh-imagegen-history-host]'),
      sidebarRoot: count('[data-dsh-imagegen-sidebar-root]'),
      blocks: count('[data-dsh-imagegen-shell-blocks]'),
      blocksMarked: count('[data-dsh-imagegen-sidebar-block]'),
      newSessionMark: count('[data-dsh-imagegen-new-session]'),
      widthVar: widthVar(),
      htmlAttrs: htmlAttrs(),
      htmlStyle: htmlStyle(),
    })
    const before = snapshot()
    const disposers = window.__studioDispose
    if (disposers === undefined) return { error: 'the harness published no disposers' }
    // Exercise the width path first: the custom property is only written once a
    // drag (or an arrow key) has happened, so an untouched page cannot tell
    // whether uninstall clears it.
    document.documentElement.removeAttribute('data-dsh-imagegen-chat-collapsed')
    const handle = document.querySelector('[data-dsh-imagegen-chat-resizer]')
    if (handle !== null) {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    }
    const widthVarAfterNudge = widthVar()
    disposers.panel()
    disposers.sidebar()
    const after = snapshot()
    after.cursor = document.documentElement.style.getPropertyValue('cursor')
    after.userSelect = document.documentElement.style.getPropertyValue('user-select')
    const residue = Object.keys(after).filter(key => {
      const value = after[key]
      return Array.isArray(value) ? value.length > 0 : value !== 0 && value !== ''
    })
    return { before, widthVarAfterNudge, after, residue }
  })()`)
  console.log('\nUninstall probe:', JSON.stringify(uninstall, null, 2))

  // Same promise for the chat separator, but mid-gesture: its drag binds three
  // window listeners that only `pointerup` unbinds, so pulling the plugin out
  // while the pointer is down used to strand them and the <html> cursor. Driven
  // with real trusted input so the handler runs exactly as it does for a user.
  const midDrag = await (async () => {
    await page.evaluate(`window.__studioRemount()`)
    await waitFor('document.querySelector("[data-dsh-imagegen-chat-resizer]") !== null',
      'the separator to come back')
    // The chat column starts collapsed (`readChatOpen()` defaults to false), and
    // the separator is `display:none` in that state — pressing it would do
    // nothing and the probe would report a fake pass. Open it the way a user
    // does, then confirm the handle actually has a box to press.
    await page.evaluate(`(() => {
      const toggle = document.querySelector('[data-dsh-imagegen-view] [data-open]')
      if (toggle !== null && toggle.getAttribute('data-open') !== 'true') toggle.click()
    })()`)
    await waitFor(
      `(() => {
        const handle = document.querySelector('[data-dsh-imagegen-chat-resizer]')
        return handle !== null && handle.getBoundingClientRect().width > 0
      })()`,
      'the separator to become visible',
    )
    const spot = await page.evaluate(`(() => {
      const handle = document.querySelector('[data-dsh-imagegen-chat-resizer]')
      const rect = handle.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1, pointerType: 'mouse',
    })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: spot.x - 60, y: spot.y, button: 'left', pointerType: 'mouse',
    })
    const during = await page.evaluate(
      `({ cursor: document.documentElement.style.getPropertyValue('cursor') })`)
    // Uninstall with the button still logically down.
    const after = await page.evaluate(`(() => {
      window.__studioDispose.panel()
      return {
        cursor: document.documentElement.style.getPropertyValue('cursor'),
        userSelect: document.documentElement.style.getPropertyValue('user-select'),
        resizer: document.querySelectorAll('[data-dsh-imagegen-chat-resizer]').length,
      }
    })()`)
    return { during, after, cleared: after.cursor === '' && after.userSelect === '' }
  })()
  console.log('\nUninstall-mid-drag probe:', JSON.stringify(midDrag, null, 2))

} catch (error) {
  failure = error
} finally {
  page.close()
  launched.close()
  server.close()
}

if (failure !== undefined) {
  console.error(`\nFAIL: ${failure.message}`)
  process.exit(1)
}
console.log(`\nWrote light.png and dark.png to ${outDir}`)

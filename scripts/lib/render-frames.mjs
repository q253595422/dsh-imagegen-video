/**
 * One frame-render harness for every deterministic animation under docs/.
 *
 * Both the promo and the tutorial page expose `window.setTime(t)`, so rendering
 * either one is the same job: launch a headless Chromium, size it for the
 * layout, wait for the page's own `window.__ready`, then seek + screenshot each
 * frame. This module owns that loop so the two callers stay thin and cannot
 * drift apart (they already had: only one of them waited for decoded clips).
 *
 * Usage — a caller supplies what is actually page-specific:
 *
 *   await runRenderCli({
 *     pagePath: join(ROOT, 'promo.html'),
 *     duration: 30,
 *     stillTimes: [0.6, 4.2, 12.4],
 *     outDir: join(ROOT, 'frames'),
 *   })
 *
 * CLI shape, identical for both pages:
 *   node <script> stills                      key frames for review
 *   node <script> wide|tall [fps] [from] [to] full sequence, or a frame range
 *
 * A partial pass rewrites an existing sequence in place; a full pass starts
 * clean, so a stale frame from an older cut can never survive.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, findChrome, openPage } from './headless-chrome.mjs'

const DEFAULT_LAYOUTS = { wide: [1920, 1080], tall: [1080, 1920] }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for the page's own readiness promise, then report what it loaded. */
const DEFAULT_READY = `window.__ready.then(() => [
  document.images.length,
  document.querySelectorAll('video').length,
])`

async function openPageFor (layout, url, layouts) {
  const chrome = findChrome([], process.env)
  if (!chrome) {
    throw new Error('no headless Chromium found; install chrome-headless-shell or set CHROME_HEADLESS_SHELL')
  }
  const { port, close } = await launchChrome({ chrome, name: `render-${layout}` })
  const page = await openPage(port, 'about:blank')
  const [w, h] = layouts[layout]
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `${url}?layout=${layout}` })
  await sleep(3000)
  const ready = await page.evaluate(DEFAULT_READY)
  console.log(`  ${layout}: ${ready[0]} images, ${ready[1]} clips decoded`)
  return { page, close }
}

async function capture (page, file) {
  const res = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(res.result.data, 'base64'))
}

/**
 * Run one of the two CLI modes and exit.
 *
 * @param {object} options
 * @param {string} options.pagePath    absolute path of the animation page
 * @param {number} options.duration    total length in seconds
 * @param {number[]} options.stillTimes representative seconds for `stills`
 * @param {string} options.outDir      absolute frames directory
 * @param {Record<string, [number, number]>} [options.layouts]
 */
export async function runRenderCli ({ pagePath, duration, stillTimes, outDir, layouts = DEFAULT_LAYOUTS }) {
  const url = `file://${pagePath}`
  const mode = process.argv[2] ?? 'stills'
  const fps = Number(process.argv[3] ?? 30)
  const from = Number(process.argv[4] ?? 0)
  const to = Number(process.argv[5] ?? duration * fps)

  if (mode === 'stills') {
    const dir = join(outDir, 'stills')
    mkdirSync(dir, { recursive: true })
    for (const layout of Object.keys(layouts)) {
      const { page, close } = await openPageFor(layout, url, layouts)
      for (const t of stillTimes) {
        await page.evaluate(`window.setTime(${t})`)
        await sleep(120)
        await capture(page, join(dir, `${layout}-${String(t).replace('.', '_')}.jpg`))
      }
      console.log(`  ${layout}: ${stillTimes.length} stills`)
      page.close()
      close()
    }
    return
  }

  if (!(mode in layouts)) {
    throw new Error(`unknown layout "${mode}"; expected one of ${Object.keys(layouts).join(', ')} or "stills"`)
  }

  const dir = join(outDir, mode)
  const partial = from > 0 || to < duration * fps
  // A partial pass rewrites an existing sequence in place; a full pass starts clean.
  if (!partial) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const total = Math.round(to)
  const { page, close } = await openPageFor(mode, url, layouts)
  const t0 = Date.now()
  for (let i = Math.round(from); i < total; i++) {
    await page.evaluate(`window.setTime(${i / fps})`)
    await capture(page, join(dir, `f${String(i).padStart(5, '0')}.jpg`))
    if (i % 150 === 0) {
      const rate = (i + 1 - from) / ((Date.now() - t0) / 1000)
      console.log(`  ${mode} ${i}/${total} (${rate.toFixed(1)} fps)`)
    }
  }
  console.log(`  ${mode}: frames ${from}..${total - 1} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  page.close()
  close()
}

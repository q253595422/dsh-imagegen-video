/**
 * Render the promo animation to frame sequences.
 *
 * The page is fully deterministic: window.setTime(t) positions every element
 * for second t, so each frame is captured by seeking and screenshotting rather
 * than by letting CSS animate in real time. That keeps the two layouts in sync
 * and makes a re-render after a copy change cheap.
 *
 * Usage (from the repository root):
 *   node docs/promo/src/render.mjs stills          # key frames for review
 *   node docs/promo/src/render.mjs wide|tall [fps] [from] [to]  # full sequence,
 *     or only frames [from, to) after a copy change that touches one section
 *
 * Frames land in docs/promo/src/frames/; combine them with the ffmpeg command
 * in docs/promo/README.md.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchChrome, findChrome, openPage } from '../../../scripts/lib/headless-chrome.mjs'

const ROOT = resolve(import.meta.dirname)
const PAGE = `file://${join(ROOT, 'promo.html')}`
const OUT = join(ROOT, 'frames')
const DURATION = 30

const mode = process.argv[2] ?? 'stills'
const fps = Number(process.argv[3] ?? 30)
const from = Number(process.argv[4] ?? 0)
const to = Number(process.argv[5] ?? DURATION * fps)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function open (layout) {
  const { port, close } = await launchChrome({ chrome: findChrome([], process.env), name: `promo-${layout}` })
  const page = await openPage(port, 'about:blank')
  const [w, h] = layout === 'tall' ? [1080, 1920] : [1920, 1080]
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `${PAGE}?layout=${layout}` })
  await sleep(2500)
  const ready = await page.evaluate('window.__ready.then(() => document.images.length)')
  console.log(`  ${layout}: ${ready} images decoded`)
  return { page, close, w, h }
}

async function shot (page, file) {
  const res = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(res.result.data, 'base64'))
}

if (mode === 'stills') {
  const dir = join(OUT, 'stills')
  mkdirSync(dir, { recursive: true })
  const times = [0.6, 1.6, 4.2, 7.0, 10.4, 12.4, 16.4, 18.6, 22.4, 24.6, 27.6, 29.2]
  for (const layout of ['wide', 'tall']) {
    const { page, close } = await open(layout)
    for (const t of times) {
      await page.evaluate(`window.setTime(${t})`)
      await sleep(90)
      await shot(page, join(dir, `${layout}-${String(t).replace('.', '_')}.jpg`))
    }
    console.log(`  ${layout}: ${times.length} stills`)
    page.close(); close()
  }
} else {
  const layout = mode
  const dir = join(OUT, layout)
  const partial = from > 0 || to < DURATION * fps
  // A partial pass rewrites an existing sequence in place; a full pass starts clean.
  if (!partial) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const total = Math.round(to)
  const { page, close } = await open(layout)
  const t0 = Date.now()
  for (let i = Math.round(from); i < total; i++) {
    await page.evaluate(`window.setTime(${i / fps})`)
    await shot(page, join(dir, `f${String(i).padStart(5, '0')}.jpg`))
    if (i % 150 === 0) {
      const rate = (i + 1 - from) / ((Date.now() - t0) / 1000)
      console.log(`  ${layout} ${i}/${total} (${rate.toFixed(1)} fps)`)
    }
  }
  console.log(`  ${layout}: frames ${from}..${total - 1} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  page.close(); close()
}

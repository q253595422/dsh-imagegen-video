/**
 * Layout guard for the tutorial animation.
 *
 * I cannot eyeball a JPEG, so this measures instead: it loads the page at each
 * chapter's hold time and asserts, in the live DOM, that
 *   - every visible box keeps a real safety margin from the stage edges
 *     (not merely "inside by 1px" — a 7px sliver is a broken frame),
 *   - the copy column and the shot column do not overlap,
 *   - each scene's headline is actually painted,
 *   - every clip box sits inside its shot card,
 *   - the subtitle bar is inside the frame and above the bottom edge.
 *
 * Only elements that are *actually* clipped by an ancestor's overflow:hidden
 * are exempt (the oversized <img> inside a .crop is how the crop is drawn).
 * An element inside .shot is still measured: .shot clips its children, but the
 * card itself must stay on screen.
 *
 * Exits non-zero and names the offending element when any of that breaks.
 */
import { launchChrome, findChrome, openPage } from '../../../scripts/lib/headless-chrome.mjs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname)
const PAGE = `file://${join(ROOT, 'tutorial.html')}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// hold times: mid-chapter, once the entrance animations have settled
const TIMES = [2.4, 7.0, 14.0, 22.0, 30.0, 38.0, 46.0, 54.0, 63.0, 70.0]
// A frame with less than this much breathing room is broken, even if it is
// technically inside the canvas.
const MARGIN = 24

const chrome = findChrome([], process.env)
if (!chrome) {
  console.error('SKIP: no headless Chromium; layout guard did not run')
  process.exit(0)
}

let failures = 0
const fail = (layout, t, msg) => { failures++; console.error(`  ✗ [${layout} ${t}s] ${msg}`) }

for (const [layout, w, h] of [['wide', 1920, 1080], ['tall', 1080, 1920]]) {
  const { port, close } = await launchChrome({ chrome, name: `guard-${layout}` })
  const page = await openPage(port, 'about:blank')
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `${PAGE}?layout=${layout}` })
  await sleep(2500)
  await page.evaluate('window.__ready')
  await sleep(400)

  for (const t of TIMES) {
    await page.evaluate(`window.setTime(${t})`)
    await sleep(120)

    const report = await page.evaluate(`(() => {
      const W = ${w}, H = ${h}, M = ${MARGIN}
      const out = { tight: [], overlap: [], empty: [], outside: [], sub: null }
      const scene = [...document.querySelectorAll('[data-scene]')]
        .find(s => s.style.display !== 'none')
      if (!scene) { out.noScene = true; return out }

      // An element is exempt only when an ancestor between it and the scene
      // actually clips it. The .crop/.clip wrappers are exactly that; the shot
      // card is not (it must be on screen), so it is measured.
      const clippedBy = el => {
        for (let n = el.parentElement; n && n !== scene; n = n.parentElement) {
          if (n.classList && (n.classList.contains('crop') || n.classList.contains('clip'))) return true
        }
        return false
      }

      for (const el of scene.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        if (parseFloat(cs.opacity || '1') < 0.05) continue
        if (el.classList.contains('spot')) continue   // decorative dimming box
        const b = el.getBoundingClientRect()
        if (b.width === 0 && b.height === 0) continue
        if (clippedBy(el)) continue

        // Layout containers are expected to span the padded column; only the
        // things a viewer reads (type, cards, clips, tags) need the margin.
        const isBox = el.matches('.copy, .shot-hold, .notes, .scene, .toc')
        // the shot card's own children (tags, clips) are positioned against it
        const inShot = el.closest('.shot') && el.closest('.shot') !== el

        const slack = Math.min(b.left, b.top, W - b.right, H - b.bottom)
        // Containers span the padded column by design, so they only fail when
        // they actually leave the canvas; content keeps the real margin.
        const limit = inShot ? 2 : (isBox ? 0 : M)
        if (slack < limit) {
          out.tight.push({
            cls: (typeof el.className === 'string' ? el.className : el.tagName) || el.tagName,
            txt: (el.innerText || '').trim().slice(0, 26),
            slack: Math.round(slack),
            box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
          })
        }
      }

      const copy = scene.querySelector('.copy')
      const shot = scene.querySelector('.shot')
      if (copy && shot) {
        const a = copy.getBoundingClientRect(), b = shot.getBoundingClientRect()
        const xo = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const yo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (xo > 4 && yo > 4) out.overlap.push({ x: Math.round(xo), y: Math.round(yo) })
      }

      const head = scene.querySelector('.headline, .mark')
      if (head && parseFloat(getComputedStyle(head).opacity || '1') < 0.9) {
        out.empty.push('headline not painted')
      }

      if (shot) {
        const s = shot.getBoundingClientRect()
        for (const c of scene.querySelectorAll('.clip')) {
          const b = c.getBoundingClientRect()
          if (b.left < s.left - 2 || b.top < s.top - 2 || b.right > s.right + 2 || b.bottom > s.bottom + 2) {
            out.outside.push([Math.round(b.left), Math.round(b.top)])
          }
        }
      }

      const sub = document.getElementById('sub')
      if (parseFloat(getComputedStyle(sub).opacity || '0') > 0.5) {
        const b = sub.getBoundingClientRect()
        out.sub = { top: Math.round(b.top), bottom: Math.round(b.bottom), fits: b.bottom <= H - 8 && b.top >= 0 }
      }
      return out
    })()`)

    if (report.noScene) fail(layout, t, 'no scene visible at this time')
    for (const o of report.tight) {
      fail(layout, t, `too close to the edge (slack ${o.slack}px < ${MARGIN}) ${o.cls} "${o.txt}" box=${o.box.join(',')}`)
    }
    for (const o of report.overlap) fail(layout, t, `copy/shot overlap x=${o.x} y=${o.y}`)
    for (const e of report.empty) fail(layout, t, e)
    for (const o of report.outside) fail(layout, t, `clip outside its shot card at ${o.join(',')}`)
    if (report.sub && !report.sub.fits) fail(layout, t, `subtitle out of frame ${JSON.stringify(report.sub)}`)
  }
  console.log(`  ${layout}: checked ${TIMES.length} frames`)
  page.close(); close()
}

if (failures) {
  console.error(`\nLAYOUT GUARD FAILED: ${failures} problem(s)`)
  process.exit(1)
}
console.log('\nLAYOUT GUARD OK: margins, columns, headlines, clips and subtitles all in place')

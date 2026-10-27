/**
 * Deterministic timeline engine shared by the frame-rendered videos under docs/.
 *
 * A page declares scenes (`[data-scene]` with `data-in` / `data-out`), one crop
 * window per layout (`data-crop` / `data-crop-tall`), and elements carrying
 * `data-a` (effect) plus `data-d` / `data-dur` (delay / duration). Calling
 * `window.setTime(t)` then positions everything for second t.
 *
 * Nothing animates on its own: the renderer seeks, screenshots and repeats.
 * That keeps the two layouts in sync and makes a re-render after a copy change
 * cheap and byte-comparable.
 *
 * Classic script (not an ES module) on purpose: both pages are opened over
 * `file://`, where module imports are blocked by CORS but a plain `<script src>`
 * is not.
 *
 * Usage:
 *   <script src="../shared/timeline.js"></script>
 *   <script>
 *     window.createTimeline({ duration: 30, cues: CUES, hudTotal: 4,
 *       onFrame: t => applySprite(t - 8.7) })
 *   </script>
 */
(function () {
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
  const ease = {
    expo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    back: (x) => {
      const c = 1.70158
      const d = c + 1
      return 1 + d * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2)
    },
  }

  /**
   * Position one declared element for `lt` seconds into its scene.
   *
   * `hook` items (a sprite sheet, a <video>) are skipped here — the page drives
   * them from `onFrame`, because they need media access this module has no
   * business knowing about.
   */
  function applyItem (it, lt, sceneDur) {
    if (it.hook) return
    const n = it.n

    if (it.spot) {
      const p = ease.expo(clamp01((lt - it.start) / it.dur))
      const [x, y, w, h] = it.spot
      n.style.left = x + '%'
      n.style.top = y + '%'
      n.style.width = w + '%'
      n.style.height = h + '%'
      n.style.opacity = String(p)
      return
    }

    const p = clamp01((lt - it.start) / it.dur)
    const e = (it.kind === 'pop' ? ease.back : ease.expo)(p)
    n.style.opacity = String(clamp01(p * 1.7))

    let tf = ''
    switch (it.kind) {
      case 'rise': tf = `translate3d(0,${(1 - e) * 52}px,0)`; break
      case 'fade': tf = ''; break
      case 'slideL': tf = `translate3d(${(1 - e) * -84}px,0,0)`; break
      case 'slideR': tf = `translate3d(${(1 - e) * 84}px,0,0)`; break
      case 'pop': tf = `scale(${0.9 + 0.1 * e})`; break
      case 'zoomIn': tf = `scale(${1.055 - 0.055 * e})`; break
    }
    if (it.drift) {
      const s = 1 + (it.drift - 1) * clamp01(lt / sceneDur)
      tf = (tf ? tf + ' ' : '') + `scale(${s})`
    }
    n.style.transform = tf || 'none'
  }

  /**
   * Wire the page up and return `{ setTime }`.
   *
   * @param {object} options
   * @param {number} options.duration       total length in seconds
   * @param {Array} [options.cues]          `[from, to, text]` subtitle slots
   * @param {number} [options.hudTotal]     denominator in the "01 / N" counter
   * @param {number} [options.sourceWidth]  screenshot width the crops refer to
   * @param {number} [options.sourceHeight] screenshot height the crops refer to
   * @param {(t: number) => void} [options.onFrame] extra per-frame work
   */
  window.createTimeline = function createTimeline (options) {
    const {
      duration,
      cues = [],
      hudTotal = 4,
      sourceWidth = 2560,
      sourceHeight = 1440,
      onFrame = null,
    } = options

    // The layout must be settled BEFORE any crop is measured. Renderers pass
    // ?layout=tall; reading the attribute first would leave every portrait
    // scene on its landscape crop window — which is exactly the bug this
    // ordering prevents.
    const q = new URLSearchParams(location.search)
    if (q.has('layout')) document.documentElement.dataset.layout = q.get('layout')
    const tall = document.documentElement.dataset.layout === 'tall'

    const scenes = [...document.querySelectorAll('[data-scene]')].map((el) => {
      const spec = (tall && el.dataset.cropTall) || el.dataset.crop || '0,0,1,1'
      const crop = spec.split(',').map(Number)
      const [cx, cy, cw, ch] = crop
      // Source-percentage → visible-percentage, so a highlight lands on the same
      // UI element whichever crop window the layout uses.
      const toVis = ([sx, sy]) => [(sx - cx * 100) / cw, (sy - cy * 100) / ch]

      const shot = el.querySelector('.shot')
      if (shot) {
        const cropBox = shot.querySelector('.crop')
        cropBox.style.setProperty('--x', cx)
        cropBox.style.setProperty('--y', cy)
        cropBox.style.setProperty('--w', cw)
        cropBox.style.setProperty('--h', ch)
        const ar = (cw * sourceWidth) / (ch * sourceHeight)
        shot.style.aspectRatio = String(ar)
        // Pages cap the card by deriving a width limit from the stage height;
        // that needs this scene's own ratio.
        shot.style.setProperty('--ar', String(ar))
      }

      return {
        el,
        in: +el.dataset.in,
        out: +el.dataset.out,
        hud: el.dataset.hud !== 'off',
        items: [...el.querySelectorAll('[data-a]')].map((n) => {
          let spot = null
          if (n.dataset.spot) {
            const [sx, sy, sw, sh] = n.dataset.spot.split(',').map(Number)
            const [vx, vy] = toVis([sx, sy])
            spot = [vx, vy, sw / cw, sh / ch]
          }
          if (n.dataset.anchor) {
            const [vx, vy] = toVis(n.dataset.anchor.split(',').map(Number))
            n.style.left = vx + '%'
            n.style.top = vy + '%'
          }
          return {
            n,
            kind: n.dataset.a,
            start: +(n.dataset.d || 0),
            dur: +(n.dataset.dur || 0.6),
            drift: n.dataset.drift ? +n.dataset.drift : 0,
            spot,
            hook: n.dataset.hook || '',
          }
        }),
      }
    })

    const hud = document.getElementById('hud')
    const hudIdx = document.getElementById('hud-idx')
    const hudBar = document.getElementById('hud-bar')
    const subEl = document.getElementById('sub')
    const hudScenes = scenes.filter((s) => s.hud)

    function setTime (t) {
      let hudScene = null
      for (const s of scenes) {
        if (t < s.in || t >= s.out) { s.el.style.display = 'none'; continue }
        s.el.style.display = ''
        if (s.hud) hudScene = s
        const lt = t - s.in
        for (const it of s.items) applyItem(it, lt, s.out - s.in)
      }
      if (onFrame) onFrame(t)

      if (hudScene) {
        hud.style.opacity = '1'
        const i = hudScenes.indexOf(hudScene)
        hudIdx.textContent = String(i + 1).padStart(2, '0') + ' / ' + String(hudTotal).padStart(2, '0')
        hudBar.style.width = (t / duration * 100) + '%'
      } else {
        hud.style.opacity = '0'
      }

      const cue = cues.find(([a, b]) => t >= a && t < b)
      if (cue) {
        const local = t - cue[0]
        const span = cue[1] - cue[0]
        if (subEl.dataset.text !== cue[2]) {
          subEl.dataset.text = cue[2]
          subEl.innerHTML = '<span></span>'
          subEl.firstChild.textContent = cue[2]
        }
        // Fade the caption in/out at the edges of its slot.
        subEl.style.opacity = String(Math.min(clamp01(local / 0.35), clamp01((span - local) / 0.3)))
      } else {
        subEl.style.opacity = '0'
        subEl.dataset.text = ''
      }
    }

    window.setTime = setTime
    setTime(q.has('t') ? +q.get('t') : 0)
    return { setTime }
  }
})()

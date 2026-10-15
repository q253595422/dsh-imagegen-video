/**
 * UI smoke checks for the canvas 「添加视频」 picker (CanvasVideoPicker).
 *
 * Offline: the BUILT client bundle is driven in jsdom against a fetch stub.
 * Nothing here talks to a real provider or reads a real clip.
 *
 * What this proves:
 *
 *  C1  the dock's image menu offers 添加视频 and opens the picker, whose three
 *      tabs are upload / history / gallery IN THAT ORDER, with `history`
 *      selected by default
 *  C2  the history tab renders one card per clip the video store serves, each
 *      anchored on `data-clip-url` with a `<video>` playing that served URL
 *  C3  clicking a history card adds it through `onAddClip` (a REFERENCED node,
 *      never an asset copy) -- and never through `onAddAsset`
 *  C4  the gallery tab lists exactly the entries that carry a `.video`; an
 *      image-only entry is not turned into a clip card
 *  C5  clicking a gallery card adds its served clip through `onAddClip` too
 *  C6  the upload tab sends a local file to the canvas FILE upload route and
 *      hands the resulting asset to `onAddAsset` -- never to `onAddClip`. This
 *      is the parity contract §5.1 semantic: an uploaded file is a canvas
 *      asset, not a video-store clip, so it cannot be composed
 *  C7  a genuinely empty clip list shows the picker's empty state
 *  C8  the close button calls `onClose`
 *  C9  a FAILED listing is shown as a failure, and it must NOT masquerade as
 *      "no clips" (the empty copy would be a lie)
 *  C10 the discriminating case: with an empty gallery AND a failing history,
 *      the gallery tab still shows its own empty state and does NOT show the
 *      history error line -- a naive `empty && !error` gate would fail here
 *
 * HOW THE SUBJECT IS REACHED. `CanvasVideoPicker` is not one of the bundle's
 * exports (`src/client/index.ts` exports only `apply`/`inject` plus internals),
 * so there is no component to import and mount directly. The suite therefore
 * mounts the real panel -> canvas tree and opens the dialog the way a user
 * does (dock 「添加图片」 menu -> 添加视频). The picker's own props are supplied
 * through the `react/jsx-runtime` stub, which sees every element the workspace
 * creates; `picker.wired` records that the seam matched, so a seam that
 * silently stopped matching fails loudly instead of passing vacuously.
 *
 * ANCHORS. Selectors use `data-*` only: CSS Modules hashes class names at build
 * time, so a class-name selector is a silent no-op (parity contract §1.10). The
 * empty state is `data-video-picker-empty`; the unprefixed `data-video-empty`
 * belongs to the canvas video NODE placeholder and would match a different
 * element (parity contract §5.1).
 *
 * Run: node scripts/smoke-video-picker.mjs   (from the package root, after a
 *      build -- the suites drive `lib/`, not `src/`)
 */

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const results = []
/** Run one check; sequential so nothing races the shared React tree. */
async function check(name, fn, timeoutMs = 30_000) {
  // Progress goes to stderr so a hung check is identifiable from the log alone
  // (this suite drives a real React tree in jsdom, which can stall on a poll).
  process.stderr.write(`... ${name}\n`)
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

// --------------------------------------------------------------- fixtures

const VIDEO_FILE = '/api/dsh-imagegen/video/file'
const GALLERY_FILE = '/api/dsh-imagegen/gallery/video-file'
const CANVAS_ASSET = `/api/dsh-imagegen/canvas/asset/${'c'.repeat(64)}.mp4`

/** Two history entries holding three playable files between them. */
const HISTORY_FIXTURE = [
  {
    id: 'vh-1', createdAt: 1, mode: 'text', model: 'agnes-video-2.5-flash',
    prompt: 'a cat surfing', aspectRatio: '16:9', resolution: '720P', seconds: 5,
    videos: [
      { url: `${VIDEO_FILE}/entry-0.mp4`, mime: 'video/mp4', duration: 5.2 },
      { url: `${VIDEO_FILE}/entry-1.mp4`, mime: 'video/mp4' },
    ],
  },
  {
    id: 'vh-2', createdAt: 2, mode: 'image', model: 'agnes-video-2.5-flash',
    // No prompt and no requested length: the card must fall back rather than
    // render an empty title, and the per-file probe wins over `seconds`.
    prompt: '', aspectRatio: '16:9', resolution: '1080P', seconds: 0,
    videos: [
      { url: `${VIDEO_FILE}/entry-2.mp4`, mime: 'video/mp4', poster: `${VIDEO_FILE}/entry-2.jpg` },
    ],
  },
]

/** One favorited clip and one image-only entry the picker must skip. */
const GALLERY_FIXTURE = [
  {
    id: 'gal-clip-1', createdAt: 1, mode: 'video', model: 'agnes-video-2.5-flash',
    prompt: 'favorited clip', size: '16:9', quality: 'auto', detail: '', n: 1,
    images: [], video: { url: `${GALLERY_FILE}/fav-1.mp4`, mime: 'video/mp4', duration: 4 },
  },
  {
    id: 'gal-image-1', createdAt: 2, mode: 'text', model: 'gpt-image-2',
    prompt: 'a picture, not a clip', size: '1:1', quality: 'auto', detail: '', n: 1,
    images: [{ url: '/api/dsh-imagegen/gallery/image/pic.png', mime: 'image/png' }],
  },
  {
    id: 'gal-clip-2', createdAt: 3, mode: 'video', model: 'agnes-video-2.5-flash',
    prompt: '', size: '16:9', quality: 'auto', detail: '', n: 1,
    images: [], video: { url: `${GALLERY_FILE}/fav-2.webm`, mime: 'video/webm' },
  },
]

/**
 * The scenario each check installs before it opens the picker. `gallery` is the
 * prop the workspace passes down; `history`/`historyFailure` are answered by the
 * fetch stub, because the component fetches the clip list itself.
 */
const picker = {
  gallery: [],
  history: [],
  historyFailure: null,
  /** Set when the jsx-runtime seam matched the picker element at all. */
  wired: false,
}
const spies = { clips: [], assets: [], closes: 0 }
const requests = { paths: [], fileUploads: [], canvasSaves: [] }
const cleanups = []
const shared = {}

await check('C1 the dock menu offers 添加视频 and the picker opens with three tabs in order', async () => {

  const { JSDOM } = await import('jsdom')
  const vm = await import('node:vm')
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body>'
    + '<div data-pane="sidebar"><div class="logoRow"><button class="newSession">New session</button></div><div class="regionArea"></div></div>'
    + '<div data-pane="conversation"><div data-slot="conversation"><div data-conversation-scroll></div></div></div>'
    + '<div class="smoke_centerCol">'
    + '<div data-slot="main" style="display: contents">'
    + '<div data-slot="main.conversation" style="display: contents"><div class="smoke_root" data-phase="hero"></div></div>'
    + '</div>'
    + '</div>'
    + '</body></html>',
    { pretendToBeVisual: true },
  )
  const jsdomWindow = dom.window
  const jsdomDocument = jsdomWindow.document

  // jsdom ships no layout/observer machinery; the canvas measures itself.
  jsdomWindow.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  jsdomWindow.Element.prototype.setPointerCapture = function setPointerCapture() {}
  jsdomWindow.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  jsdomWindow.Element.prototype.hasPointerCapture = function hasPointerCapture() { return true }
  // The canvas raster helpers need a 2D context and a data URL. Neither is
  // exercised here; they must simply not throw on mount.
  jsdomWindow.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type !== '2d') return null
    return {
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      arc() {}, fill() {}, strokeRect() {}, fillText() {}, scale() {},
      measureText: () => ({ width: 8 }),
      strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', lineCap: '', lineJoin: '',
      fillStyle: '#000000', globalCompositeOperation: 'source-over',
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJD'

  const waitUntil = async (predicate, timeout = 4000) => {
    const deadline = Date.now() + timeout
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    return predicate()
  }
  const waitForSelector = async (scope, selector, timeout = 4000) => {
    const found = await waitUntil(() => scope.querySelector(selector) !== null, timeout)
    assert.ok(found, `selector did not render: ${selector}`)
  }
  const clickElement = element => {
    element.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const click = selector => {
    const el = jsdomDocument.querySelector(selector)
    assert.ok(el !== null, `clicked element is missing: ${selector}`)
    clickElement(el)
  }

  const canvasDocument = {
    version: 2, id: 'canvas-picker', title: 'Picker canvas', revision: 1,
    viewport: { x: 0, y: 0, k: 1 }, background: 'blank',
    nodes: [], connections: [], createdAt: 1, updatedAt: 1,
  }
  const configState = {
    enabled: true, announceToAgent: true,
    channels: [{
      id: 'default', preset: '', name: 'Default', apiUrl: 'https://example.test/v1',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
    }],
    defaultChannelId: 'default', defaultModel: 'gpt-image-2', defaultVideoModel: 'agnes-video-2.5-flash',
  }
  const json = value => ({ ok: true, status: 200, json: async () => value, blob: async () => new jsdomWindow.Blob([]) })

  const fetchStub = async (input, init) => {
    const path = String(input)
    requests.paths.push(path)
    if (path.endsWith('/settings/describe')) {
      return json({
        ok: true,
        value: {
          namespaces: [{ ns: 'dsh-imagegen', value: configState, revision: 0, secrets: [{ path: ['channelSecrets', 'default'], set: true }] }],
          writable: true,
        },
      })
    }
    if (path.endsWith('/video/tasks/list')) return json({ ok: true, tasks: [] })
    if (path.endsWith('/video/history/list')) {
      // The seam C9/C10 need: a failing listing must reject the API call the
      // component makes, exactly as a host error does.
      if (picker.historyFailure !== null) return json({ ok: false, message: picker.historyFailure, code: 'history-failed' })
      return json({ ok: true, entries: picker.history })
    }
    if (path.endsWith('/gallery/list')) return json({ ok: true, entries: picker.gallery })
    if (path.endsWith('/history/list')) return json({ ok: true, entries: [] })
    if (path.endsWith('/canvas/skills/list')) return json({ ok: true, skills: [], agentAvailable: false, registryAvailable: false, installed: [] })
    if (path.endsWith('/canvas/list')) {
      return json({ ok: true, projects: [{ id: canvasDocument.id, title: canvasDocument.title, revision: canvasDocument.revision, nodeCount: 0, createdAt: 1, updatedAt: 1 }] })
    }
    if (path.endsWith('/canvas/read')) return json({ ok: true, document: canvasDocument })
    if (path.endsWith('/canvas/save')) {
      const payload = JSON.parse(init.body)
      requests.canvasSaves.push(payload.document)
      return json({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } })
    }
    // C6's route: the picker's own upload. Checked before the generic fallback,
    // and it carries `?name=` so it is matched by substring.
    if (path.includes('/canvas/file/upload')) {
      requests.fileUploads.push(path)
      return json({
        ok: true,
        asset: {
          assetId: CANVAS_ASSET.split('/').pop(), url: CANVAS_ASSET, mime: 'video/mp4',
          bytes: 64, width: 0, height: 0, origin: 'upload', originId: 'clip.mp4', kind: 'file',
        },
      })
    }
    if (path.endsWith('/update/check')) return json({ ok: true, update: { current: '1.7.0', latest: '1.7.0', updateAvailable: false } })
    if (path.endsWith('/templates/sample')) return json({ ok: true, samples: [] })
    if (path.endsWith('/templates/list')) return json({ ok: true, sourceId: 'vibeui', cases: [], total: 0, origin: 'bundled', repository: '', fetchedAt: '' })
    if (path.endsWith('/templates/favorites/list')) return json({ ok: true, favorites: [] })
    if (path.endsWith('/settings/mutate')) return json({ ok: true, value: { ns: 'dsh-imagegen', value: configState, revision: 1, secrets: [] } })
    if (path.includes('/video/file/')) {
      return { ok: true, status: 200, blob: async () => new jsdomWindow.Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }) }
    }
    return json({ ok: true, entries: [], tasks: [], projects: [], models: [], cases: [], favorites: [] })
  }

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: jsdomWindow,
    document: jsdomDocument,
    MutationObserver: jsdomWindow.MutationObserver,
    ResizeObserver: jsdomWindow.ResizeObserver,
    CustomEvent: jsdomWindow.CustomEvent,
    HTMLElement: jsdomWindow.HTMLElement,
    FileReader: jsdomWindow.FileReader,
    // Playable-URL posters decode through `new Image()`; jsdom never loads
    // resources, so the stub resolves onload on the next tick.
    Image: class SmokeImage {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0 }
      set src(value) { this._src = value; setTimeout(() => { this.naturalWidth = 64; this.naturalHeight = 64; this.onload?.() }, 0) }
      get src() { return this._src }
    },
    fetch: fetchStub,
    console,
  }
  if (!('window' in sandbox.window)) sandbox.window.window = sandbox.window
  sandbox.window.__ModuleLoader__ = { load: h => { handoff = h } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'the client bundle registered via __ModuleLoader__')

  const conversationStub = {
    createDrafts: () => [], releaseDraftAttachments: () => {},
    input: { for: () => ({ addAttachments: () => true, removeAttachment: () => {}, state: { getSnapshot: () => ({ draft: '' }) }, setDraft: () => {} }) },
  }
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    get(name) {
      if (name === 'connection') return { isLoopback: true }
      if (name === 'conversation') return conversationStub
      if (name === 'sessions') return { list: { getSnapshot: () => ({ current: 'session-smoke' }), subscribe: () => () => {} }, scope: () => ({ sessionId: 'session-smoke' }) }
      return undefined
    },
    locale: {
      register() {}, addLanguage() { return () => {} },
      getLocale() { return { active: 'zh', locales: [], revision: 0 } },
      subscribe() { return () => {} },
    },
    slots: { inject(key, callback) { callback(); return () => {} }, register() { return () => {} } },
  }

  // react-dom (outer realm) reads the bare `window`/`document` globals at render
  // time, so expose the jsdom ones for the render.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = jsdomWindow
  globalThis.document = jsdomDocument
  // The panel owns poll timers and the tree outlives every check, so teardown is
  // deferred to the end of the file rather than a `finally` here.
  cleanups.push(async () => {
    // Drain pending React work BEFORE restoring the globals: React DOM reads
    // `window` during commit, so a flush that lands after the jsdom globals are
    // gone throws "window is not defined".
    await new Promise(resolve => setTimeout(resolve, 25))
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    dom.window.close()
  })

  const react = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')

  /**
   * The seam. `CanvasVideoPicker` is internal to the bundle, so the suite takes
   * its props from the element the workspace creates for it. The callbacks are
   * WRAPPED rather than replaced, so the real canvas wiring still runs and the
   * end-to-end effect can be asserted next to the counter. The element is
   * identified by its prop surface (`onAddClip` + `onAddAsset` + `gallery`),
   * which no other element in this tree carries -- not by a function name, which
   * a minifier may rewrite.
   */
  const spyOnPickerProps = props => {
    if (props === null || typeof props !== 'object') return props
    if (!('onAddClip' in props) || !('onAddAsset' in props) || !('gallery' in props) || !('api' in props)) return props
    picker.wired = true
    return {
      ...props,
      gallery: picker.gallery,
      onClose: () => { spies.closes += 1; props.onClose() },
      onAddClip: clip => { spies.clips.push(clip); props.onAddClip(clip) },
      onAddAsset: asset => { spies.assets.push(asset); props.onAddAsset(asset) },
    }
  }
  const moduleStubs = {
    'react': react,
    'react/jsx-runtime': {
      ...jsxRuntime,
      jsx: (type, props, key) => jsxRuntime.jsx(type, spyOnPickerProps(props), key),
      jsxs: (type, props, key) => jsxRuntime.jsxs(type, spyOnPickerProps(props), key),
    },
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: ({ variant, size, className, children, ...rest }) => react.createElement('button', { type: 'button', className, ...rest }, children),
      Pill: ({ active, className, children, onClick, ...rest }) => react.createElement(onClick ? 'button' : 'span', { type: 'button', className, ...(onClick !== undefined ? { onClick } : {}), ...rest }, children),
    },
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: (initial) => {
        let snapshot = initial
        const listeners = new Set()
        return {
          getSnapshot: () => snapshot,
          set: (next) => { snapshot = next; for (const fn of [...listeners]) fn() },
          update: (mutator) => { const draft = { ...snapshot }; mutator(draft); snapshot = draft; for (const fn of [...listeners]) fn() },
          subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        }
      },
    },
  }
  const exportsOf = handoff.factory(spec => {
    const stub = moduleStubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })

  exportsOf.apply(ctx)
  await waitForSelector(jsdomDocument, '[data-dsh-imagegen-session-tabs]')
  click('[data-dsh-imagegen-tab="image"]')
  await waitForSelector(jsdomDocument, '[data-dsh-imagegen-view]')
  const view = jsdomDocument.querySelector('[data-dsh-imagegen-view]')
  // The canvas is its own top-nav entry.
  const canvasSwitch = [...view.querySelectorAll('[role="tablist"] button')]
    .find(button => button.textContent?.includes('无限画布'))
  assert.ok(canvasSwitch !== undefined, 'the top nav offers 无限画布')
  canvasSwitch.click()
  await waitForSelector(view, '[data-canvas-workspace]')

  /** The open picker, or null. Scoped to the dialog's own anchor. */
  const pickerRoot = () => jsdomDocument.querySelector('[data-video-picker]')
  const tabButton = name => {
    const button = pickerRoot()?.querySelector(`[data-video-tab="${name}"]`)
    assert.ok(button !== null && button !== undefined, `the ${name} tab is rendered`)
    return button
  }
  const cardUrls = () => [...(pickerRoot()?.querySelectorAll('[data-video-card]') ?? [])]
    .map(card => card.getAttribute('data-clip-url'))

  /** Close any open picker, then open a fresh one through the real dock menu. */
  const openPicker = async () => {
    if (pickerRoot() !== null) {
      clickElement(pickerRoot().querySelector('[data-video-picker-close]'))
      assert.ok(await waitUntil(() => pickerRoot() === null), 'the picker closes before it is reopened')
    }
    const dockButton = view.querySelector('[data-dock-item][data-label="添加图片"] button')
    assert.ok(dockButton !== null, 'the canvas dock offers its 添加图片 menu')
    clickElement(dockButton)
    assert.ok(await waitUntil(() => view.querySelector('[data-image-menu-video]') !== null), 'the image menu offers 添加视频')
    clickElement(view.querySelector('[data-image-menu-video]'))
    assert.ok(await waitUntil(() => pickerRoot() !== null), 'the video picker opens')
    // A seam that quietly stopped matching would make every prop override below
    // a no-op and every gallery assertion meaningless, so it is asserted here.
    assert.equal(picker.wired, true, 'the picker element was reached through the jsx-runtime seam')
  }

  Object.assign(shared, {
    jsdomWindow, jsdomDocument, view, waitUntil, waitForSelector, click, clickElement,
    pickerRoot, tabButton, cardUrls, openPicker, requests,
  })

  // ---------------------------------------------------------------- C1
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await openPicker()

  const tabs = [...pickerRoot().querySelectorAll('[data-video-tab]')]
  assert.deepEqual(
    tabs.map(tab => tab.getAttribute('data-video-tab')),
    ['upload', 'history', 'gallery'],
    'C1: the tabs are upload / history / gallery in that order',
  )
  const active = tabs.filter(tab => tab.hasAttribute('data-active'))
  assert.equal(active.length, 1, 'C1: exactly one tab is active')
  assert.equal(active[0].getAttribute('data-video-tab'), 'history', 'C1: history is the default tab')
  assert.ok(pickerRoot().querySelector('[data-video-picker-close]') !== null, 'C1: the picker offers a close button')

})

await check('C2 the history tab renders one card per served clip', async () => {
  const { waitUntil, pickerRoot, cardUrls } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()

  const cards = [...pickerRoot().querySelectorAll('[data-video-card]')]
  assert.equal(cards.length, 3, 'C2: one card per file the store serves')

  const served = HISTORY_FIXTURE.flatMap(entry => entry.videos.map(video => video.url))
  const shown = cards.map(card => card.getAttribute('data-clip-url'))
  assert.deepEqual(shown, served, 'C2: data-clip-url carries the served clip URL, in host order')
  assert.ok(shown.every(url => url === undefined ? false : url.startsWith(`${VIDEO_FILE}/`)), 'C2: every card points at the video store, not at an asset')

  for (const card of cards) {
    const player = card.querySelector('video')
    assert.ok(player !== null, 'C2: each card renders a player')
    assert.equal(player.getAttribute('src'), card.getAttribute('data-clip-url'), 'C2: the player plays the card’s served clip URL')
    assert.equal(player.getAttribute('preload'), 'metadata', 'C2: the player only preloads metadata')
    assert.equal(player.muted, true, 'C2: the card player is muted (React sets this as a property)')
    assert.equal(player.hasAttribute('playsinline'), true, 'C2: the card player plays inline')
  }
  // The probe duration on the first file wins over the entry's requested length.
  assert.ok(cards[0].textContent.includes('5.2s') || cards[0].textContent.includes('5s'), `C2: the probed duration is shown: ${cards[0].textContent}`)
  // An empty prompt falls back to the untitled copy rather than rendering blank.
  assert.ok(cards[2].textContent.includes('未命名作品'), `C2: an untitled clip is labelled: ${cards[2].textContent}`)
  assert.equal(await waitUntil(() => cardUrls().length === 3), true, 'C2: the cards stay rendered')
})

await check('C3 clicking a history card adds a referenced clip through onAddClip', async () => {
  const { pickerRoot, waitUntil, requests } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()

  const before = { clips: spies.clips.length, assets: spies.assets.length, saves: requests.canvasSaves.length }
  const card = pickerRoot().querySelectorAll('[data-video-card]')[0]
  shared.clickElement(card)

  assert.equal(spies.clips.length, before.clips + 1, 'C3: the click adds exactly one clip')
  // Compared field by field rather than with `deepEqual`: the bundle's factory
  // runs in the vm realm, so its object literals carry a DIFFERENT
  // `Object.prototype` than this file's, and a strictly-deep comparison of two
  // structurally identical objects from two realms fails. The key list is
  // asserted too, so a stray/absent optional key cannot slip through.
  const payload = spies.clips.at(-1)
  assert.equal(payload.url, `${VIDEO_FILE}/entry-0.mp4`, 'C3: the payload carries the served clip URL')
  assert.equal(payload.mime, 'video/mp4', 'C3: the payload carries the clip mime')
  assert.equal(payload.duration, 5.2, 'C3: the payload carries the probed duration')
  assert.equal(payload.title, 'a cat surfing', 'C3: the payload carries the clip title')
  assert.deepEqual([...Object.keys(payload)].sort(), ['duration', 'mime', 'title', 'url'], 'C3: the payload has exactly those four keys')
  assert.equal(spies.assets.length, before.assets, 'C3: a history clip never goes through onAddAsset')

  // The wrapping proves the real canvas wiring ran, not just the counter: the
  // node references the URL (§1.7) and copies no bytes.
  const url = spies.clips.at(-1).url
  const landed = await waitUntil(
    () => (requests.canvasSaves.at(-1)?.nodes ?? []).some(node => node.type === 'video' && node.metadata?.video?.url === url),
    6000,
  )
  assert.ok(landed, 'C3: the canvas gained a video node referencing the served clip')
  const node = requests.canvasSaves.at(-1).nodes.find(candidate => candidate.metadata?.video?.url === url)
  assert.equal(node.metadata.asset, undefined, 'C3: the referenced node carries no canvas asset (no bytes were copied)')

  // The card's own 加入画布 action must not double-fire through the card's click.
  const clipsBefore = spies.clips.length
  shared.clickElement(pickerRoot().querySelector('[data-video-add]'))
  assert.equal(spies.clips.length, clipsBefore + 1, 'C3: 加入画布 adds exactly once (no double fire)')
})

await check('C4 the gallery tab lists only the entries that carry a video', async () => {
  const { pickerRoot, cardUrls, waitUntil } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()

  shared.clickElement(shared.tabButton('gallery'))
  assert.equal(await waitUntil(() => cardUrls().length === 2), true, 'C4: the two clip entries render')

  const shown = cardUrls()
  assert.deepEqual(shown, [`${GALLERY_FILE}/fav-1.mp4`, `${GALLERY_FILE}/fav-2.webm`],
    'C4: the gallery clip URLs are served by the gallery store')
  const titles = [...pickerRoot().querySelectorAll('[data-video-card]')].map(card => card.textContent)
  assert.ok(titles.some(text => text.includes('favorited clip')), 'C4: a clip keeps its entry prompt as its title')
  assert.equal(titles.some(text => text.includes('a picture, not a clip')), false,
    'C4: the image-only entry is not turned into a clip card')
  const players = [...pickerRoot().querySelectorAll('[data-video-card] video')]
  assert.deepEqual(players.map(player => player.getAttribute('src')), shown, 'C4: each gallery card plays its served clip')
})

await check('C5 clicking a gallery card adds its served clip through onAddClip', async () => {
  const { pickerRoot, cardUrls, waitUntil } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()
  shared.clickElement(shared.tabButton('gallery'))
  assert.equal(await waitUntil(() => cardUrls().length === 2), true, 'C5: the gallery cards render')

  const before = { clips: spies.clips.length, assets: spies.assets.length }
  shared.clickElement(pickerRoot().querySelectorAll('[data-video-card]')[1])

  assert.equal(spies.clips.length, before.clips + 1, 'C5: the gallery click adds exactly one clip')
  // Field by field for the same cross-realm reason as C3. The absent `duration`
  // key matters: the picker must not invent a length the store never reported.
  const payload = spies.clips.at(-1)
  assert.equal(payload.url, `${GALLERY_FILE}/fav-2.webm`, 'C5: the payload carries the gallery-store clip URL')
  assert.equal(payload.mime, 'video/webm', 'C5: the payload carries the stored mime')
  assert.equal(payload.title, '未命名作品', 'C5: a promptless clip is titled with the untitled copy')
  assert.deepEqual([...Object.keys(payload)].sort(), ['mime', 'title', 'url'], 'C5: no duration key is invented when the store reports none')
  assert.equal(spies.assets.length, before.assets, 'C5: a gallery clip never goes through onAddAsset')
})

await check('C6 the upload tab sends a local file to the asset path through onAddAsset', async () => {
  const { jsdomWindow, pickerRoot, waitUntil, requests, clickElement } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()
  clickElement(shared.tabButton('upload'))
  // The tab switch is a React state update; wait for the commit rather than
  // querying the tree synchronously behind it.
  assert.equal(await waitUntil(() => pickerRoot().querySelector('[data-video-upload]') !== null), true,
    'C6: the upload tab renders after the switch')

  const drop = pickerRoot().querySelector('[data-video-upload]')
  assert.ok(drop !== null, 'C6: the upload tab renders its drop target')
  const input = drop.querySelector('input[type="file"]')
  assert.ok(input !== null, 'C6: the upload tab renders a file input')
  assert.equal(input.getAttribute('accept'), 'video/*', 'C6: the input accepts video files')

  const before = { clips: spies.clips.length, assets: spies.assets.length, uploads: requests.fileUploads.length }
  const file = new jsdomWindow.File(['clip-bytes'], 'clip.mp4', { type: 'video/mp4' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))

  assert.equal(await waitUntil(() => spies.assets.length > before.assets), true, 'C6: picking a file hands an asset to onAddAsset')
  assert.equal(requests.fileUploads.length, before.uploads + 1, 'C6: the file went to the canvas file-upload route')
  assert.match(requests.fileUploads.at(-1), /\/canvas\/file\/upload\?name=clip\.mp4$/, 'C6: the route carries the picked file name')
  assert.equal(spies.assets.at(-1).url, CANVAS_ASSET, 'C6: onAddAsset receives the host’s CanvasAssetRef')
  assert.equal(spies.clips.length, before.clips, 'C6: the upload NEVER goes through onAddClip — an asset is not a storable clip (§5.1)')
  assert.equal(spies.assets.at(-1).origin, 'upload', 'C6: the asset records its upload origin')

  // The real wiring places a FILE node and dismisses the dialog.
  const placed = await waitUntil(
    () => (requests.canvasSaves.at(-1)?.nodes ?? []).some(node => node.type === 'file' && node.metadata?.asset?.url === CANVAS_ASSET),
    6000,
  )
  assert.ok(placed, 'C6: the canvas gained a file node holding the uploaded asset')
  const node = requests.canvasSaves.at(-1).nodes.find(candidate => candidate.metadata?.asset?.url === CANVAS_ASSET)
  assert.equal(node.metadata.fileKind, 'video', 'C6: the file node knows it is a video (§1.9: a file node, not a clip)')
  assert.equal(await waitUntil(() => pickerRoot() === null), true, 'C6: the dialog closes after the asset lands')

})

await check('C7 an empty clip list shows the picker empty state', async () => {
  const { pickerRoot, waitUntil, requests } = shared
  picker.gallery = []
  picker.history = []
  picker.historyFailure = null
  await shared.openPicker()

  const pathsBefore = requests.paths.length
  const empty = pickerRoot().querySelector('[data-video-picker-empty]')
  assert.ok(empty !== null, 'C7: the history tab shows the empty state when the store returns no clips')
  assert.equal(empty.textContent, '这里还没有可用的视频', 'C7: it uses the picker’s own empty copy')
  assert.equal(pickerRoot().querySelectorAll('[data-video-card]').length, 0, 'C7: no cards are faked')
  assert.equal(pickerRoot().querySelector('[data-video-load-error]') === null, true, 'C7: a successful empty read is not an error')
  assert.ok(pathsBefore > 0, 'C7: the picker did fetch the list itself')

  // The gallery tab has its own empty state for the same reason.
  shared.clickElement(shared.tabButton('gallery'))
  assert.equal(await waitUntil(() => pickerRoot().querySelector('[data-video-picker-empty]') !== null), true,
    'C7: the gallery tab shows the empty state when no entry carries a clip')
})

await check('C8 the close button calls onClose', async () => {
  const { pickerRoot, waitUntil, clickElement } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = null
  await shared.openPicker()

  const before = spies.closes
  clickElement(pickerRoot().querySelector('[data-video-picker-close]'))
  assert.equal(spies.closes, before + 1, 'C8: the close button calls onClose')
  assert.equal(await waitUntil(() => pickerRoot() === null), true, 'C8: the dialog is dismissed')
})

await check('C9 a failed listing is shown as a failure, not as an empty list', async () => {
  const { pickerRoot, waitUntil } = shared
  picker.gallery = GALLERY_FIXTURE
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = 'store offline'
  await shared.openPicker()
  assert.equal(await waitUntil(() => pickerRoot().querySelector('[data-video-load-error]') !== null), true,
    'C9: the failure is reported')

  const error = pickerRoot().querySelector('[data-video-load-error]')
  assert.equal(error.textContent, '读取视频列表失败：store offline', 'C9: the failure carries the localized copy and the host message')
  assert.equal(pickerRoot().querySelector('[data-video-picker-empty]') === null, true,
    'C9: a failed read must NOT claim there are no clips — that would be a lie')
  assert.equal(pickerRoot().querySelectorAll('[data-video-card]').length, 0, 'C9: no stale cards survive a failed read')
  assert.ok(pickerRoot().querySelector('[data-video-reload]') !== null, 'C9: the failure offers a retry')

  // The retry really re-asks the host, and recovers.
  picker.historyFailure = null
  shared.clickElement(pickerRoot().querySelector('[data-video-reload]'))
  assert.equal(await waitUntil(() => pickerRoot().querySelectorAll('[data-video-card]').length === 3), true,
    'C9: the retry re-reads the list and recovers')
  assert.equal(pickerRoot().querySelector('[data-video-load-error]') === null, true, 'C9: the error clears on success')
})

await check('C10 a failing history must not suppress the gallery empty state', async () => {
  const { pickerRoot, waitUntil } = shared
  // The discriminating case: the gallery is genuinely empty (its data comes from
  // props and cannot fail) while the history request fails. A gate written as
  // `empty && !error` would hide the gallery's own empty copy here.
  picker.gallery = []
  picker.history = HISTORY_FIXTURE
  picker.historyFailure = 'store offline'
  await shared.openPicker()

  shared.clickElement(shared.tabButton('gallery'))
  assert.equal(await waitUntil(() => pickerRoot().querySelector('[data-video-picker-empty]') !== null), true,
    'C10: an empty GALLERY still shows the empty copy while history is failing')
  assert.equal(pickerRoot().querySelector('[data-video-load-error]') === null, true,
    'C10: the history failure is not reported on a tab that cannot fail')
  assert.equal(pickerRoot().querySelectorAll('[data-video-card]').length, 0, 'C10: an empty gallery shows no cards')
})

for (const cleanup of cleanups.reverse()) await cleanup()

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nVIDEO PICKER SMOKE FAILED' : '\nVIDEO PICKER SMOKE OK')
process.exit(process.exitCode === 1 ? 1 : 0)

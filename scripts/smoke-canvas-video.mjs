/**
 * Host-side and UI-side smoke checks for the canvas video path.
 *
 * Offline: a local HTTP server plays the video provider, and the UI half drives
 * the BUILT client bundle in jsdom against a fetch stub. Nothing here ever
 * requests a real render.
 *
 * What this proves:
 *
 *  G1  a favorited clip is COPIED, so it survives video-history eviction
 *  G2  the favorited clip is served by name, with traversal/ext refusal
 *  G3  removing the favorite removes its clip; image entries still work
 *  L1  a canvas-started video task keeps its lineage into the queue summary
 *  L2  a completed task exposes the clip ref and its history entry id
 *  W1  a FINISHED clip on the studio's own surfaces offers 加入画布 -- both the
 *      「本次生成」 list row and the full-screen clip preview
 *  W2  clicking it lands a video node on the canvas BY REFERENCE: the node
 *      carries the served clip URL and NO canvas asset (`metadata.asset` stays
 *      undefined, and no bytes reach the asset store)
 *  W3  a canvas video node distinguishes "really rendering" from "really
 *      failed", and a failed node offers retry
 *
 * Run: node scripts/smoke-canvas-video.mjs   (from the package root)
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const results = []
/** Run one check; async-aware and sequential so nothing races the servers. */
async function check(name, fn, timeoutMs = 60_000) {
  // Progress goes to stderr so a hung check is identifiable from the log alone
  // (the suite drives a real React tree in jsdom, which can stall on a poll).
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

const root = mkdtempSync(join(tmpdir(), 'gal-video-'))
process.env.DSH_HOME = root
const host = await import(new URL('../lib/index.js', import.meta.url).href)

// Put a clip in the video store (simulating a finished render).
const videosFiles = join(root, 'dsh-imagegen', 'videos', 'files')
mkdirSync(videosFiles, { recursive: true })
const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(4096, 3)])
const srcClip = join(videosFiles, 'entry-0.mp4')
writeFileSync(srcClip, MP4)

await check('G1-G3 a favorited clip is copied, served, and cleaned up', async () => {
  const before = await host.listGallery()
  assert.equal(before.length, 0, 'gallery starts empty')

  const result = await host.appendGalleryVideo({
    id: 'fav-1', createdAt: Date.now(), model: 'agnes-video-2.5-flash',
    prompt: 'a favorited cat', aspectRatio: '16:9', seconds: 5,
    sourcePath: srcClip, mime: 'video/mp4', duration: 5, channel: 'Agnes',
  })
  assert.equal(result.added, true, 'the clip was added')
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.equal(entry.mode, 'video', 'the entry records video mode')
  assert.equal(entry.images.length, 0, 'an image list is not faked for a clip')
  assert.ok(entry.video !== undefined, 'the entry carries a video ref')
  assert.match(entry.video.url, /\/api\/dsh-imagegen\/gallery\/video-file\//)
  assert.equal(entry.video.duration, 5)
  assert.equal(entry.prompt, 'a favorited cat')

  // The copied file must exist independently of the source (eviction-safe).
  const name = entry.video.url.split('/').pop()
  const read = await host.readGalleryVideo(name)
  assert.ok(read !== undefined, 'the favorited clip is readable')
  assert.equal(read.size, MP4.length, 'the copy is complete')
  assert.equal(read.mime, 'video/mp4')

  // Traversal + wrong extension are refused.
  assert.equal(await host.readGalleryVideo('../../index.json'), undefined)
  assert.equal(await host.readGalleryVideo('fav-1-0.txt'), undefined)

  // Deleting the source (as video-history eviction would) must not break the favorite.
  rmSync(srcClip, { force: true })
  const stillThere = await host.readGalleryVideo(name)
  assert.ok(stillThere !== undefined, 'the favorite survives the source being evicted')

  // The clip survives a reload of the index.
  const reloaded = await host.listGallery()
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].mode, 'video')

  // Removing the gallery entry cleans up the copied clip.
  await host.removeGallery('fav-1')
  assert.equal(existsSync(join(root, 'dsh-imagegen', 'gallery', 'videos', name)), false, 'removing the favorite deletes its clip')

  // An image-only gallery entry still round-trips (no regression).
  await host.appendGallery({
    id: 'img-1', createdAt: Date.now(), mode: 'text', model: 'gpt-image-2', prompt: 'cat',
    size: '1:1', quality: 'auto', detail: '', n: 1,
    images: [{ b64: Buffer.from([137, 80, 78, 71]).toString('base64'), mime: 'image/png' }],
  })
  const mixed = await host.listGallery()
  assert.equal(mixed.length, 1)
  assert.equal(mixed[0].mode, 'text', 'image entries still work')
})

// ------------------------------------------------------------------- lineage
// A canvas run must keep its canvas lineage all the way into the queue summary,
// because that is how the canvas matches a finished render to its placeholder.

const { createServer } = await import('node:http')

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'POST') {
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ video_id: 'v1' })) })
    return
  }
  if (url.pathname.endsWith('.mp4')) {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.from('00000018667479706d70343200000000', 'hex'))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'completed', metadata: { url: `http://127.0.0.1:${upstream.address().port}/o.mp4`, duration: 5 } }))
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

const runtime = new host.ImageGenerationRuntime(() => ({
  channels: [{
    id: 'c1', preset: '', name: 'C', apiUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    apiKey: 'k', apiUrlFull: false, models: [],
    videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
  }],
  defaultChannelId: 'c1',
}))

await check('L1-L2 a canvas run keeps its lineage and exposes its clip ref', async () => {
  // A real keyframe run needs its frames; omitting them would (correctly) fail
  // validation and prove nothing about lineage.
  const PNG = 'data:image/png;base64,iVBORw0KGgo='
  const submitted = runtime.videoQueue.submit({
    mode: 'keyframe', model: 'agnes-video-2.5-flash', prompt: 'from canvas',
    aspectRatio: '16:9', resolution: '720P', seconds: 5,
    firstFrame: PNG, lastFrame: PNG,
    canvas: { canvasId: 'canvas-9', sourceNodeId: 'cfg-1', nodeId: 'ph-1', referenceNodeIds: ['img-1', 'img-2'] },
  })
  assert.equal(submitted.request.canvas.canvasId, 'canvas-9', 'L1: the submitted task keeps its canvas lineage')
  assert.equal(submitted.request.canvas.nodeId, 'ph-1', 'L1: the placeholder node id is retained')

  // Poll the summary the way the canvas does.
  let summary
  for (let attempt = 0; attempt < 40; attempt += 1) {
    summary = runtime.videoQueue.summaries().find(item => item.id === submitted.id)
    if (summary?.status === 'completed' || summary?.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(summary !== undefined, 'L1: the task appears in the summary list')
  assert.equal(summary.request.canvas.canvasId, 'canvas-9', 'L1: the summary exposes the canvas id so the canvas can match it')
  assert.deepEqual(summary.request.canvas.referenceNodeIds, ['img-1', 'img-2'], 'L1: reference node ids survive for retries')
  assert.equal(summary.status, 'completed', `L2: the render completed (got ${summary.status})`)
  assert.ok(summary.resultVideo !== undefined, 'L2: the completed task exposes its full clip ref')
  assert.equal(summary.resultVideo.mime, 'video/mp4', 'L2: the clip MIME travels with the summary')
  assert.match(summary.resultVideo.url, /video\/file\//, 'L2: the clip is referenced by its served URL')
  assert.ok(typeof summary.resultEntryId === 'string', 'L2: the history entry id travels with the summary (for gallery writes)')
  // The summary must never carry the base64 reference frames.
  assert.equal(summary.request.image, undefined, 'L1: the summary drops the reference frame payload')
  assert.equal(summary.request.firstFrame, undefined, 'L1: the summary drops the first frame payload')
  upstream.close()
})

// -------------------------------------------------------------- W. studio UI
// 加入画布 on the studio's own surfaces must land a REFERENCED video node: the
// node points at the clip the host already persists and serves, and the canvas
// asset store is never touched.

const CLIP_URL = '/api/dsh-imagegen/video/file/vt-1-0.mp4'
const CLIP_MIME = 'video/mp4'
const CLIP_PROMPT = 'a cat on a windowsill'
/** Two more served clips, for the stitch (compose) half: distinct URLs make a
 *  requested order identifiable from the request body alone. */
const CLIP_LEFT_URL = '/api/dsh-imagegen/video/file/clip-left.mp4'
const CLIP_RIGHT_URL = '/api/dsh-imagegen/video/file/clip-right.mp4'
/** The clip a stitch run produces (served by the video store, like any clip). */
const COMPOSED_URL = '/api/dsh-imagegen/video/file/composed.mp4'

await check('W1-W3 a finished studio clip lands a referenced node and states are honest', async () => {
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
  // exercised by this suite; they only must not throw on mount.
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
  const click = selector => {
    const el = jsdomDocument.querySelector(selector) ?? document.querySelector(selector)
    assert.ok(el !== null, `clicked element is missing: ${selector}`)
    el.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  /**
   * The queue the panel and the canvas both poll. `vt-1` is a finished render;
   * `vt-999` is still running, which is what the canvas must NOT paint as a
   * failure. A canvas-started node matches its task by id, so the lineage on
   * these summaries is what makes the states meaningful.
   */
  const videoTasks = [
    {
      id: 'vt-1', status: 'completed', createdAt: Date.now(),
      request: { mode: 'text', model: 'agnes-video-2.5-flash', prompt: CLIP_PROMPT, aspectRatio: '16:9', resolution: '720P', seconds: 5 },
    },
    {
      id: 'vt-999', status: 'running', createdAt: Date.now(),
      request: { mode: 'text', model: 'agnes-video-2.5-flash', prompt: 'still rendering', aspectRatio: '16:9', resolution: '720P', seconds: 5 },
    },
  ]
  /**
   * The canvas starts with two video nodes already on it, so the state a user
   * actually sees can be asserted on the first read of the document:
   *  - `node-rendering`: its task is still in the queue (vt-999), so it is
   *    genuinely mid-render and must NOT be painted as a failure.
   *  - `node-failed`: its task is gone from the queue with an error, so it is
   *    genuinely failed and must offer retry.
   */
  const canvasDocument = {
    version: 2, id: 'canvas-smoke', title: 'Smoke canvas', revision: 1,
    viewport: { x: 0, y: 0, k: 1 }, background: 'blank',
    nodes: [
      {
        id: 'node-rendering', type: 'video', title: '视频节点', x: 40, y: 40, width: 240, height: 240,
        metadata: { status: 'generating', taskId: 'vt-999', prompt: 'still rendering', model: 'agnes-video-2.5-flash', videoMode: 'text' },
      },
      {
        id: 'node-failed', type: 'video', title: '视频节点', x: 40, y: 340, width: 240, height: 240,
        metadata: { status: 'error', error: '上游拒绝了这个请求', taskId: 'vt-998', prompt: 'this one failed', model: 'agnes-video-2.5-flash', videoMode: 'text' },
      },
      // Three clips a stitch run can cover. The two that share a row are listed
      // here RIGHT before LEFT, i.e. in the reverse of their canvas order: an
      // implementation that numbered the badges by array position instead of by
      // canvas position would flip them, which is exactly the divergence between
      // the numbers the user sees and the order of the file these badges exist
      // to expose. Their x/y are chosen so the shared ordering rule puts the
      // left one first (same row, x ascending).
      {
        id: 'node-clip-right', type: 'video', title: '右段', x: 1000, y: 40, width: 240, height: 240,
        metadata: { status: 'success', video: { url: CLIP_RIGHT_URL, mime: CLIP_MIME, duration: 4, entryId: 'clip-entry-right' }, videoMode: 'text' },
      },
      {
        id: 'node-clip-left', type: 'video', title: '左段', x: 600, y: 40, width: 240, height: 240,
        metadata: { status: 'success', video: { url: CLIP_LEFT_URL, mime: CLIP_MIME, duration: 3, entryId: 'clip-entry-left' }, videoMode: 'text' },
      },
      // A clip with a servable URL but NO history entry: playable, downloadable,
      // previewable, and yet it has nothing to favorite. Nothing about its look
      // says so -- only the favorite control's disabled state does, which is why
      // the assertion below pins both halves.
      {
        id: 'node-clip-noentry', type: 'video', title: '无记录片段', x: 600, y: 340, width: 240, height: 240,
        metadata: { status: 'success', video: { url: CLIP_LEFT_URL, mime: CLIP_MIME, duration: 3 }, videoMode: 'text' },
      },
    ],
    connections: [], createdAt: 1, updatedAt: 1,
  }
  /** Node ids the canvas is seeded with, so an imported node is identifiable. */
  const FIXTURE_IDS = new Set(canvasDocument.nodes.map(node => node.id))
  /** Documents the canvas persisted through /canvas/save. */
  const canvasSaves = []
  /** Asset uploads the canvas made: a copied clip would show up here. */
  const canvasAssetUploads = []
  /** Video submissions the client made (the retry path resubmits one). */
  const videoSubmissions = []
  /** Every path the client fetched, for failure diagnostics. */
  const requestPaths = []
  /** Bodies the canvas sent to the skill-run route (the stitch request). */
  const skillRunRequests = []
  /** Clip entryIds the gallery favorite route was asked to copy. */
  const galleryVideoFavorites = []
  /** Polls of the stitched run so far: the first says "still working". */
  let composeTaskPolls = 0

  const configState = {
    enabled: true,
    announceToAgent: true,
    channels: [{
      id: 'default', preset: '', name: 'Default', apiUrl: 'https://example.test/v1',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
    }],
    defaultChannelId: 'default',
    defaultModel: 'gpt-image-2',
    defaultVideoModel: 'agnes-video-2.5-flash',
  }
  const json = value => ({ ok: true, status: 200, json: async () => value, blob: async () => new jsdomWindow.Blob([]) })

  const fetchStub = async (input, init) => {
    const path = String(input)
    requestPaths.push(path)
    if (path.endsWith('/settings/describe')) {
      return json({
        ok: true,
        value: {
          namespaces: [{
            ns: 'dsh-imagegen', value: configState, revision: 0,
            secrets: [{ path: ['channelSecrets', 'default'], set: true }],
          }],
          writable: true,
        },
      })
    }
    if (path.endsWith('/video/tasks/list')) {
      // Mirror the host summary: a completed task carries resultVideo (what the
      // studio needs for both the player and the clip's real mime/duration).
      const tasks = videoTasks.map(task => task.status === 'completed'
        ? { ...task, resultAvailable: true, resultUrl: CLIP_URL, resultVideo: { url: CLIP_URL, mime: CLIP_MIME, duration: 5 }, resultEntryId: 'video-entry-1' }
        : { ...task, resultAvailable: false })
      return json({ ok: true, tasks })
    }
    if (path.endsWith('/video/tasks/submit')) {
      const payload = JSON.parse(init.body)
      videoSubmissions.push(payload)
      const task = { id: `vt-retry-${videoSubmissions.length}`, request: payload, status: 'running', createdAt: Date.now() }
      // Land it in the queue so the canvas keeps the node in its rendering
      // state instead of orphaning it.
      videoTasks.push(task)
      return json({ ok: true, task })
    }
    if (path.endsWith('/canvas/skills/list')) {
      // The catalog the compose flow needs. `compose.videos` is the `local` tier:
      // no model, no agent, ffmpeg on this machine, and `accepts: ['video']` is
      // what the picker uses to grey it out on any other node type.
      return json({
        ok: true,
        skills: [
          {
            id: 'compose.videos', name: '拼接视频', description: '把选中的多段视频按画布位置拼成一条视频',
            origin: 'builtin', tier: 'local', accepts: ['video'], output: 'video',
            costHint: '在本机用 ffmpeg 拼接，不使用模型',
          },
          {
            id: 'polish.text', name: '润色文本', description: '改写选中的文本节点',
            origin: 'builtin', tier: 'light', accepts: ['text'], output: 'text',
          },
        ],
        agentAvailable: true, registryAvailable: true, installed: [],
      })
    }
    if (path.endsWith('/canvas/skills/run')) {
      const payload = JSON.parse(init.body)
      skillRunRequests.push(payload)
      return json({
        ok: true,
        task: {
          id: 'task-compose-1', canvasId: payload.canvasId, skillId: payload.skillId,
          label: '拼接视频', tier: 'local', status: 'queued',
          stage: '排队中', phase: 'queued', nodeIds: payload.nodeIds,
          startedAt: Date.now(),
        },
      })
    }
    if (path.endsWith('/canvas/skills/task')) {
      const payload = JSON.parse(init.body)
      // One route answers both readers: `canvasId` lists the runs a canvas owns
      // (empty here), `taskId` asks for one snapshot.
      if (payload.taskId === undefined) return json({ ok: true, tasks: [] })
      composeTaskPolls += 1
      if (composeTaskPolls < 2) {
        return json({
          ok: true,
          task: {
            id: payload.taskId, canvasId: canvasDocument.id, skillId: 'compose.videos',
            label: '拼接视频', tier: 'local', status: 'running',
            stage: '用 ffmpeg 合成中', phase: 'running', startedAt: Date.now(),
          },
        })
      }
      // The host's product, reproduced faithfully: a video node REFERENCING the
      // stitched clip in the video store (`metadata.video.url` + `entryId`),
      // NOT a canvas asset, and it carries the provenance the host writes.
      return json({
        ok: true,
        task: {
          id: payload.taskId, canvasId: canvasDocument.id, skillId: 'compose.videos',
          label: '拼接视频', tier: 'local', status: 'completed',
          stage: '已把 2 段视频拼成一条', phase: 'collecting', startedAt: Date.now(),
          output: {
            nodes: [{
              id: 'node-composed', type: 'video', title: '合成视频',
              x: 1000, y: 340, width: 240, height: 135,
              metadata: {
                video: { url: COMPOSED_URL, mime: CLIP_MIME, duration: 7, entryId: 'compose-entry-1' },
                status: 'success',
                skill: { id: 'compose.videos', label: '拼接视频', sourceNodeIds: ['node-clip-left', 'node-clip-right'], createdAt: Date.now() },
              },
            }],
            connections: [{ id: 'edge-1', fromNodeId: 'node-clip-left', toNodeId: 'node-composed' }],
            warnings: [],
          },
        },
      })
    }
    if (path.endsWith('/gallery/video')) {
      const payload = JSON.parse(init.body)
      galleryVideoFavorites.push(payload.entryId)
      return json({ ok: true, entries: [], added: true })
    }
    if (path.endsWith('/video/history/list')) return json({ ok: true, entries: [] })
    if (path.endsWith('/history/list')) return json({ ok: true, entries: [] })
    if (path.endsWith('/gallery/list')) return json({ ok: true, entries: [] })
    if (path.endsWith('/canvas/list')) {
      return json({ ok: true, projects: [{ id: canvasDocument.id, title: canvasDocument.title, revision: canvasDocument.revision, nodeCount: 0, createdAt: 1, updatedAt: 1 }] })
    }
    if (path.endsWith('/canvas/read')) return json({ ok: true, document: canvasDocument })
    if (path.endsWith('/canvas/save')) {
      const payload = JSON.parse(init.body)
      canvasSaves.push(payload.document)
      return json({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } })
    }
    if (path.endsWith('/canvas/asset/upload')) {
      canvasAssetUploads.push(JSON.parse(init.body))
      return json({ ok: true, asset: { assetId: `${'b'.repeat(64)}.mp4`, url: `/api/dsh-imagegen/canvas/asset/${'b'.repeat(64)}.mp4`, mime: 'video/mp4', bytes: 64, width: 0, height: 0, origin: 'upload' } })
    }
    if (path.endsWith('/update/check')) return json({ ok: true, update: { current: '1.6.8', latest: '1.6.8', updateAvailable: false } })
    // The empty-state inspiration wall deals 12 samples on mount; without an
    // explicit (empty) list its `setSamples(undefined)` crashes the render.
    if (path.endsWith('/templates/sample')) return json({ ok: true, samples: [] })
    if (path.endsWith('/templates/list')) return json({ ok: true, sourceId: 'vibeui', cases: [], total: 0, origin: 'bundled', repository: '', fetchedAt: '' })
    if (path.endsWith('/templates/favorites/list')) return json({ ok: true, favorites: [] })
    if (path.includes('/video/file/')) {
      return { ok: true, status: 200, blob: async () => new jsdomWindow.Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }) }
    }
    if (path.endsWith('/settings/mutate')) return json({ ok: true, value: { ns: 'dsh-imagegen', value: configState, revision: 1, secrets: [] } })
    // Everything else this suite does not care about: an empty, valid envelope.
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
    // image-ops decodes asset URLs through `new Image()`; jsdom never loads
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

  // react-dom (outer realm) reads the bare `window`/`document` globals at
  // render time, so expose the jsdom ones for the render.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = jsdomWindow
  globalThis.document = jsdomDocument
  const react = await import('react')
  const moduleStubs = {
    'react': react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
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

  try {
    exportsOf.apply(ctx)
    await waitForSelector(jsdomDocument, '[data-dsh-imagegen-session-tabs]')
    click('[data-dsh-imagegen-tab="image"]')
    await waitForSelector(jsdomDocument, '[data-dsh-imagegen-view]')
    const view = jsdomDocument.querySelector('[data-dsh-imagegen-view]')

    // ------------------------------------------------- W1 studio clip actions
    const videoTab = [...view.querySelectorAll('[role="tablist"] button')]
      .find(button => button.textContent?.includes('生视频'))
    assert.ok(videoTab !== undefined, 'the studio offers the video tab')
    videoTab.click()
    await waitForSelector(view, '[id="dsh-video-prompt"]')
    assert.ok(
      await waitUntil(() => view.querySelector('[data-video-add-canvas]') !== null),
      'W1: a finished clip in 本次生成 offers 加入画布',
    )
    const clipTask = view.querySelector('[data-video-add-canvas]').closest('[class*="videoTask"]')
    assert.ok(clipTask.querySelector('video') !== null, 'the finished clip renders its player')
    const expand = clipTask.querySelector('[data-video-expand]')
    assert.ok(expand !== null, 'W1: the clip offers the full-screen view')

    // ----------------------------------- W1b the full-screen preview offers it
    expand.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForSelector(jsdomDocument, '[data-video-clip-preview]')
    const preview = jsdomDocument.querySelector('[data-video-clip-preview]')
    const previewPlayer = preview.querySelector('video')
    assert.ok(previewPlayer !== null, 'the full-screen preview plays the clip')
    assert.equal(previewPlayer.getAttribute('src'), CLIP_URL, 'the preview uses the served clip URL')
    assert.ok(preview.querySelector('[data-video-preview-canvas]') !== null, 'W1: the full-screen preview offers 加入画布')
    assert.ok(preview.querySelector('[data-video-preview-conversation]') !== null, 'the full-screen preview offers add-to-chat too')
    // Dismiss it so the list-row click below is the one under test.
    preview.querySelector('[class*="lightboxClose"]')
      .dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => jsdomDocument.querySelector('[data-video-clip-preview]') === null), 'the preview dismisses')

    // --------------------------------------- W2 the click lands a canvas node
    // Re-query right before clicking: the list re-renders on every poll and a
    // stale reference silently swallows the click.
    const addToCanvas = view.querySelector('[data-video-add-canvas]')
    assert.ok(addToCanvas !== null, 'W2: the add-to-canvas action is present')
    addToCanvas.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForSelector(view, '[data-canvas-workspace]')
    // The two fixture nodes are video nodes too, so identify the imported one by
    // what it is NOT: an id that was not on the canvas before the click.
    const importedOf = document => (document?.nodes ?? []).find(node => node.type === 'video' && !FIXTURE_IDS.has(node.id))
    assert.ok(
      await waitUntil(() => importedOf(canvasSaves.at(-1)) !== undefined),
      'W2: clicking 加入画布 adds a video node to the canvas',
    )
    const added = importedOf(canvasSaves.at(-1))
    assert.equal(added.type, 'video', 'the added node is a video node')
    assert.ok(added.metadata.video !== undefined, 'W2: the node carries a `video` ref')
    assert.equal(added.metadata.video.url, CLIP_URL, 'W2: the video ref points at the served clip URL')
    assert.match(added.metadata.video.url, /video\/file\//, 'W2: the ref is the video store route, not a canvas asset')
    assert.equal(added.metadata.video.mime, CLIP_MIME, 'the ref carries the clip MIME')
    assert.equal(added.metadata.video.duration, 5, 'the ref carries the clip duration')
    assert.equal(added.metadata.status, 'success', 'a referenced clip is immediately playable')
    // The whole point: referencing, not copying.
    assert.equal(added.metadata.asset, undefined, 'W2: the node has NO canvas asset -- the clip is referenced, not copied')
    assert.equal(canvasAssetUploads.length, 0, 'W2: landing the clip uploaded no bytes into the asset store')
    assert.equal(added.title, CLIP_PROMPT, 'the node is titled with the clip prompt')

    const nodeEl = view.querySelector(`[data-node-id="${added.id}"]`)
    assert.ok(nodeEl !== null, 'the video node renders on the canvas')
    const nodePlayer = nodeEl.querySelector('video')
    assert.ok(nodePlayer !== null, 'the video node renders a player')
    assert.equal(nodePlayer.getAttribute('src'), CLIP_URL, 'the player points at the served clip')

    // The canvas-side full-screen player opens on the same clip.
    nodeEl.dispatchEvent(new jsdomWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-video-preview]') !== null), 'double-clicking the node opens the canvas full-screen player')

    // ------------------------------------------ W3 rendering vs failed states
    // Both fixtures are on the canvas already (they were seeded before it
    // loaded), so the states a user actually sees can be read straight off the
    // mounted tree.
    //
    // A node that is genuinely still rendering must read as rendering, never as
    // a failure. That was the second, independent cause of the "canvas video
    // looked failed while it was actually rendering" report.
    const renderingEl = view.querySelector('[data-node-id="node-rendering"]')
    assert.ok(renderingEl !== null, 'the mid-render video node renders')
    assert.ok(
      await waitUntil(() => renderingEl.querySelector('[data-video-generating]') !== null),
      'W3: a node that is really rendering shows the rendering state',
    )
    assert.equal(renderingEl.querySelector('[data-video-error]'), null, 'W3: a rendering node shows NO error state')
    assert.equal(
      (renderingEl.textContent ?? '').includes('生成失败'), false,
      'W3: a rendering node never paints 生成失败',
    )
    assert.ok(renderingEl.textContent?.includes('视频渲染中'), 'W3: the rendering copy is shown instead')

    // A node whose task really failed must read as failed AND offer retry.
    const failedEl = view.querySelector('[data-node-id="node-failed"]')
    assert.ok(failedEl !== null, 'the failed video node renders')
    assert.ok(
      await waitUntil(() => failedEl.querySelector('[data-video-error]') !== null),
      'W3: a failed video node shows the error state',
    )
    assert.ok(failedEl.textContent?.includes('上游拒绝了这个请求'), 'W3: the real failure message is shown, not a generic one')
    assert.equal(failedEl.querySelector('[data-video-generating]'), null, 'W3: a failed node shows no rendering state')
    const retryButton = failedEl.querySelector('[data-video-error] button')
    assert.ok(retryButton !== null, 'W3: the failed node offers a retry action')
    retryButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(
      await waitUntil(() => videoSubmissions.length > 0),
      'W3: clicking retry resubmits the stored run parameters',
    )
    assert.equal(videoSubmissions[0].model, 'agnes-video-2.5-flash', 'the retry reuses the stored model')
    assert.equal(videoSubmissions[0].prompt, 'this one failed', 'the retry reuses the stored prompt')
    assert.equal(videoSubmissions[0].canvas.canvasId, canvasDocument.id, 'the retry keeps its canvas lineage')
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === 'node-failed' && node.metadata?.status === 'generating')),
      'W3: the retried node returns to the rendering state',
    )

    // ================================================ C1-C6 stitching clips
    // The compose flow: multi-select clips, see the order the host will use,
    // confirm it, and get a composed video node back.
    //
    // jsdom has no PointerEvent constructor in this setup, so pointer events are
    // dispatched as MouseEvents of the same type; React keys its listeners by
    // event type, so the handlers fire (this is the idiom the other suites use).
    const pointerDown = (element, ctrlKey = false) => {
      element.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ctrlKey,
      }))
    }
    const nodeById = id => {
      const element = view.querySelector(`[data-node-id="${id}"]`)
      assert.ok(element !== null, `the node ${id} renders on the canvas`)
      return element
    }
    const badgesNow = () => [...view.querySelectorAll('[data-compose-badge]')]
    /** The open skill menu, found through its own row rather than a class name
     *  (CSS Modules hashes those). */
    const pickerMenu = () => {
      const row = [...jsdomDocument.body.querySelectorAll('button[role="menuitem"]')]
        .find(button => (button.textContent ?? '').includes('拼接视频'))
      return row === undefined ? null : row.closest('[role="menu"]')
    }
    const openComposeMenu = async id => {
      const skillButton = nodeById(id).querySelector('[data-toolbar] button[aria-label="技能"]')
      assert.ok(skillButton !== null, `the node ${id} offers the skill menu`)
      skillButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
      assert.ok(await waitUntil(() => pickerMenu() !== null), 'the skill menu opens with the catalog loaded')
    }
    const closeSkillMenu = async () => {
      const menu = pickerMenu()
      if (menu === null) return
      // The scrim is the menu's own sibling; clicking it is how a user dismisses.
      const scrim = menu.previousElementSibling
      assert.ok(scrim !== null, 'the skill menu renders a dismiss scrim')
      scrim.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
      assert.ok(await waitUntil(() => pickerMenu() === null), 'the skill menu closes')
    }

    // -------------------------------------------------- C1 the menu entry
    pointerDown(nodeById('node-clip-left'))
    // Selection is read off the resize handles, which only a selected node
    // renders -- a class check would depend on the hashed module class name.
    assert.ok(
      await waitUntil(() => nodeById('node-clip-left').querySelector('[data-corner]') !== null),
      'C1: a plain pointerdown selects the clip',
    )
    assert.equal(
      nodeById('node-clip-right').querySelector('[data-corner]'), null,
      'C1: the other clip is NOT selected -- the pointerdown was not additive',
    )
    await openComposeMenu('node-clip-left')
    const composeRow = [...jsdomDocument.body.querySelectorAll('button[role="menuitem"]')]
      .find(button => (button.textContent ?? '').includes('拼接视频'))
    const composeRowWrap = composeRow.closest('div')
    // A single clip cannot be stitched: the entry must be present but greyed.
    assert.equal(
      composeRow.disabled, true,
      'C1: with ONE clip selected the stitch entry is disabled, not silently wrong',
    )
    assert.equal(
      composeRowWrap.getAttribute('data-disabled'), '',
      'C1: the disabled row is marked for styling',
    )
    // A third tier is not "heavy or light": it has to say what it is.
    const localBadge = composeRowWrap.querySelector('[data-tier="local"]')
    assert.ok(localBadge !== null, 'C1: the stitch entry carries the `local` tier')
    assert.equal(localBadge.textContent, '本机执行', 'C1: the local tier reads 本机执行, not 轻量/重任务')

    // ------------------------------------------- C2 the order badges (the ask)
    // Additive selection keeps the menu's node in the set, so the run covers both.
    pointerDown(nodeById('node-clip-right'), true)
    assert.ok(await waitUntil(() => badgesNow().length === 2), 'C2: two selected clips get two order badges')
    assert.equal(
      nodeById('node-clip-left').querySelector('[data-compose-badge]').getAttribute('data-compose-badge'), '1',
      'C2: the LEFT clip is segment 1 -- the badges follow canvas order, and the document lists it second',
    )
    assert.equal(
      nodeById('node-clip-right').querySelector('[data-compose-badge]').getAttribute('data-compose-badge'), '2',
      'C2: the RIGHT clip is segment 2',
    )
    assert.equal(
      nodeById('node-clip-left').querySelector('[data-compose-badge]').textContent, '第 1 段',
      'C2: the badge uses the compose badge copy',
    )
    // The badge must not swallow the gesture that drags the node underneath it.
    assert.equal(
      jsdomWindow.getComputedStyle(nodeById('node-clip-left').querySelector('[data-compose-badge]')).pointerEvents, 'none',
      'C2: the badge does not take pointer events',
    )
    // A node the host would NOT stitch must not be numbered: no number is a
    // promise that it is not in the file.
    assert.equal(
      nodeById('node-clip-noentry').querySelector('[data-compose-badge]'), null,
      'C2: an unselected clip gets no badge',
    )

    // Dropping back to one clip must clear the numbering: a lone "1" claims a
    // sequence that has no second segment.
    pointerDown(nodeById('node-clip-right'), true)
    assert.ok(await waitUntil(() => badgesNow().length === 0), 'C2: the badges disappear below two selected clips')
    assert.equal(
      view.querySelector('[data-compose-bar]'), null,
      'C2: the multi-select strip disappears with them',
    )
    pointerDown(nodeById('node-clip-right'), true)
    assert.ok(await waitUntil(() => badgesNow().length === 2), 'C2: the badges come back with the second clip')

    // ------------------------------------------------- C3 the multi-select bar
    const composeBar = view.querySelector('[data-compose-bar]')
    assert.ok(composeBar !== null, 'C3: selecting two clips shows the stitch strip')
    assert.ok(composeBar.textContent.includes('按画布位置拼接 · 2 段'), 'C3: the strip states the count and the rule')

    // ------------------------------------------- C4/C5 the confirm card + run
    await openComposeMenu('node-clip-left')
    const enabledRow = [...jsdomDocument.body.querySelectorAll('button[role="menuitem"]')]
      .find(button => (button.textContent ?? '').includes('拼接视频'))
    assert.equal(enabledRow.disabled, false, 'C4: with two clips selected the stitch entry is enabled')
    enabledRow.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForSelector(jsdomDocument, '[data-compose-card]')
    const card = jsdomDocument.querySelector('[data-compose-card]')
    assert.ok(
      card.textContent.includes('把选中的 2 段视频拼成一条？'),
      'C4: the confirm card states what will happen',
    )
    assert.ok(
      card.textContent.includes('顺序按画布位置：①②'),
      'C4: the card spells out the ①② order the badges show',
    )
    const runButton = card.querySelector('[data-compose-run]')
    assert.ok(runButton !== null, 'C4: the card offers the confirm action')
    assert.equal(runButton.textContent, '开始拼接', 'C4: the confirm action is labelled 开始拼接')

    runButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => skillRunRequests.length > 0), 'C5: confirming starts the stitch run')
    assert.equal(skillRunRequests[0].skillId, 'compose.videos', 'C5: the run asks for the stitcher')
    assert.equal(skillRunRequests[0].canvasId, canvasDocument.id, 'C5: the run carries its canvas')
    assert.deepEqual(
      skillRunRequests[0].nodeIds, ['node-clip-left', 'node-clip-right'],
      'C5: the run sends the clips in CANVAS order -- the same order the badges numbered',
    )

    // ---------------------------------------------------- C6 the local run card
    await waitForSelector(view, '[data-skill-run]')
    const runCard = view.querySelector('[data-skill-run]')
    assert.equal(
      runCard.querySelector('[data-tier="local"]').textContent, '本机执行',
      'C6: the run card labels a `local` run as 本机执行',
    )

    // ------------------------------------ C6b the composed node lands and plays
    assert.ok(
      await waitUntil(() => view.querySelector('[data-node-id="node-composed"]') !== null, 12_000),
      'C6: the stitched clip lands on the canvas as a node',
    )
    const composedEl = nodeById('node-composed')
    // The canvas autosaves on a debounce, so the node is on screen before it is
    // in the saved document; read it the way the other checks do.
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === 'node-composed')),
      'C6: the composed node is persisted on the canvas',
    )
    const composed = (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === 'node-composed')
    assert.equal(composed.type, 'video', 'C6: the composed node is an ordinary video node')
    assert.equal(composed.title, '合成视频', 'C6: the composed node is titled 合成视频')
    assert.equal(composed.metadata.video.url, COMPOSED_URL, 'C6: it references the stitched clip')
    assert.equal(composed.metadata.video.entryId, 'compose-entry-1', 'C6: it carries its history entry id')
    assert.equal(composed.metadata.asset, undefined, 'C6: the composed node copies no bytes into the asset store')
    assert.equal(canvasAssetUploads.length, 0, 'C6: stitching uploaded no canvas asset')
    // The whole point of the node shape: it renders through the EXISTING video
    // body, with no compose-specific branch anywhere in the client.
    const composedPlayer = composedEl.querySelector('[data-video-body] video')
    assert.ok(composedPlayer !== null, 'C6: the composed node renders through the existing video body')
    assert.equal(composedPlayer.getAttribute('src'), COMPOSED_URL, 'C6: it plays the stitched clip')
    // The product is selected, so only one clip is selected now: no numbering.
    assert.equal(badgesNow().length, 0, 'C6: the badges clear once the selection moves to the product')

    // ------------------------------ C7 收藏 is gated on `video.entryId` alone
    // This is the defect that hides from an eyeball: without an entry id the
    // favorite button still RENDERS -- 加入对话 / 下载 / 抓帧 / 预览 all still
    // work -- and only its disabled state differs. So both halves are pinned.
    const composedFavorite = composedEl.querySelector('[data-toolbar] button[aria-label="收藏到画廊"]')
    assert.ok(composedFavorite !== null, 'C7: the composed node offers 收藏到画廊')
    assert.equal(
      composedFavorite.disabled, false,
      'C7: a composed clip CAN be favorited -- its video ref carries an entry id',
    )
    const noEntryFavorite = nodeById('node-clip-noentry').querySelector('[data-toolbar] button[aria-label="收藏到画廊"]')
    assert.ok(noEntryFavorite !== null, 'C7: a clip without a history entry still renders its favorite control')
    assert.equal(
      noEntryFavorite.disabled, true,
      'C7: the same control IS disabled when the clip ref has no entry id',
    )
    // ...and the enabled one really reaches the favorite path.
    composedFavorite.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(
      await waitUntil(() => galleryVideoFavorites.length > 0),
      'C7: clicking 收藏 on a composed clip favorites its history entry',
    )
    assert.equal(galleryVideoFavorites[0], 'compose-entry-1', 'C7: it favorites the composed entry, not another one')
  } finally {
    // Drain pending React work BEFORE restoring the globals. React DOM reads
    // `window` during commit, so a flush that lands after the jsdom globals are
    // gone throws "window is not defined" even though every assertion passed.
    await new Promise(resolve => setTimeout(resolve, 25))
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    // The mounted panel owns poll timers, so the event loop would never drain on
    // its own; closing the window tears them down.
    dom.window.close()
  }
})

console.log('GALLERY CHECKS OK')
console.log('LINEAGE CHECKS OK')
rmSync(root, { recursive: true, force: true })

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nCANVAS VIDEO SMOKE FAILED' : '\nCANVAS VIDEO SMOKE OK')
process.exit(process.exitCode === 1 ? 1 : 0)

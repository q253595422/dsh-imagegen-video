/**
 * Host-side smoke checks for the canvas video path and gallery clip favorites.
 *
 * Offline: a local HTTP server plays the video provider, so no real render is
 * requested. What this proves:
 *
 *  G1  a favorited clip is COPIED, so it survives video-history eviction
 *  G2  the favorited clip is served by name, with traversal/ext refusal
 *  G3  removing the favorite removes its clip; image entries still work
 *  L1  a canvas-started video task keeps its lineage into the queue summary
 *  L2  a completed task exposes the clip ref and its history entry id
 *
 * Run: node scripts/smoke-canvas-video.mjs   (from the package root)
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'gal-video-'))
process.env.DSH_HOME = root
const host = await import(new URL('../lib/index.js', import.meta.url).href)

// Put a clip in the video store (simulating a finished render).
const videosFiles = join(root, 'dsh-imagegen', 'videos', 'files')
mkdirSync(videosFiles, { recursive: true })
const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(4096, 3)])
const srcClip = join(videosFiles, 'entry-0.mp4')
writeFileSync(srcClip, MP4)

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

// ------------------------------------------------------------------- lineage
// A canvas run must keep its canvas lineage all the way into the queue summary,
// because that is how the canvas matches a finished render to its placeholder.

import { createServer } from 'node:http'

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
console.log('LINEAGE CHECKS OK')

console.log('GALLERY CHECKS OK')
console.log('CANVAS VIDEO SMOKE OK')
rmSync(root, { recursive: true, force: true })

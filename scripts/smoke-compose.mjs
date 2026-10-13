/**
 * Host-side smoke checks for the 「拼接视频」 (stitch clips) action.
 *
 * Offline by default: every check drives the REAL runner but an INJECTED FAKE
 * {@link ClipComposer}, so the whole compose path — ordering, probing stages,
 * publishing, the produced node — is proven with no ffmpeg and no network. Only
 * the last check touches real ffmpeg, and it skips loudly when it is absent.
 *
 * What this proves:
 *
 *  V1  the catalog offers `compose.videos` as a builtin `local` tier action
 *      accepting `video`, with copy from the compose locale keys — and WITHOUT
 *      a `requires` gate, so a host with no agent runtime still shows it
 *  V2  a selection of fewer than two real clips fails with the composeTooFew
 *      copy (a stray image in the selection does not count as a clip)
 *  V3  three clips reach ffmpeg in CANVAS-POSITION order, not the order the
 *      client sent — and the run spends ZERO chat calls (a `local` tier that
 *      fell into runLight would answer a stitch request with a text node)
 *  V4  the produced node is a clip REFERENCE: type `video`, metadata.video.url
 *      set, metadata.asset UNDEFINED (bytes stay in the video store, never
 *      copied into the canvas asset library), one connection per source clip
 *  V5  the task's stage text advances through the probe stage into the encode
 *      stage while the run is in flight
 *  E1  (real ffmpeg only) two synthetic clips — one with audio, one silent —
 *      stitch through the REAL ClipComposer and the result is ~2x as long
 *
 * Run: node scripts/smoke-compose.mjs   (from the package root, after a build)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, accessSync, constants as FS } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const results = []
/** Run one check; async-aware and sequential so nothing races the fake. */
async function check(name, fn, timeoutMs = 60_000) {
  // Progress goes to stderr so a hung check is identifiable from the log alone.
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
    if (error instanceof SkipSignal) {
      // A loud skip: a machine without ffmpeg must not look like a broken feature.
      results.push(`SKIP  ${name}: ${error.message}`)
      process.stderr.write(`\n!!! SKIP ${name}: ${error.message}\n!!! (this is not a failure; the offline checks above still ran)\n\n`)
      return
    }
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

/** Thrown by skip() so the check is recorded as SKIP, never as PASS or FAIL. */
class SkipSignal extends Error {}

function skip(why) {
  throw new SkipSignal(why)
}

const root = mkdtempSync(join(tmpdir(), 'gal-compose-'))
process.env.DSH_HOME = root
const host = await import(new URL('../lib/index.js', import.meta.url).href)
const hostLocale = await import(new URL('../lib/locale-tables.js', import.meta.url).href)
// The runner renders its stage text through the same dictionaries the browser
// ships; wire that resolver so the stage assertions compare real copy.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'en')
/** The copy one locale key resolves to, for the language the host uses here. */
const copy = (key, params) => hostLocale.interpolate(key, params, 'en')

/** The served-URL prefix the video store uses (`${VIDEO_API.file}/<file>`). */
const VIDEO_FILE_API = '/api/dsh-imagegen/video/file'

// ---------------------------------------------------------------- fixtures

/** Documents the fake canvas backend serves, by canvas id. */
const canvasDocuments = new Map()
const canvasBackend = {
  async read(id) { return canvasDocuments.get(id) },
}

/** One canvas clip node: a REFERENCE with no canvas asset (see protocol). */
function clipNode(id, x, y, prompt) {
  return {
    id, type: 'video', title: `clip ${id}`, x, y, width: 240, height: 160,
    metadata: {
      video: { url: `${VIDEO_FILE_API}/${id}-0.mp4`, mime: 'video/mp4', duration: 2 },
      status: 'success',
      prompt,
    },
  }
}
function imageNode(id, x, y) {
  return {
    id, type: 'image', title: `still ${id}`, x, y, width: 240, height: 240,
    metadata: { asset: { assetId: 'asset-1', name: 'a.png', mime: 'image/png', size: 4, origin: 'generated' }, status: 'success' },
  }
}

/** The three clips, deliberately laid out so ARRAY order ≠ canvas order. */
const CLIPS = [
  clipNode('clip-c', 0, 600, 'third prompt'),   // bottom row → last
  clipNode('clip-a', 0, 0, 'first prompt'),     // top row, left → first
  clipNode('clip-b', 900, 0, 'second prompt'),  // top row, right → second
]
/** The client sends them scrambled; the host must re-sort by position. */
const AS_SENT = ['clip-c', 'clip-b', 'clip-a']
const EXPECTED_ORDER = ['clip-a', 'clip-b', 'clip-c']

/** A fake composer: records every call, emits the two stages, never touches disk. */
function fakeComposer() {
  const record = {
    resolveCalls: [], stitchCalls: [], publishes: [], stageSamples: [], signals: [],
    available: 0, describe: 0,
  }
  let liveTask
  /** A macrotask boundary: every pending microtask (incl. the caller's task
   *  assignment) has run by the time this resolves. */
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const composer = {
    record,
    /** Hand the fake the task object the runner returned, to sample its stage. */
    observe: task => { liveTask = task },
    available: () => { record.available += 1; return true },
    describe: () => { record.describe += 1; return 'fake ffmpeg 6.0 / fake ffprobe 6.0' },
    resolve: async url => {
      record.resolveCalls.push(url)
      // A URL the store no longer serves resolves to nothing, exactly like the
      // real composer when the history entry was evicted.
      return url.includes('gone') ? undefined : `/fake/${basename(new URL(url, 'http://x').pathname)}`
    },
    stitch: async input => {
      record.stitchCalls.push([...input.sources])
      record.signals.push(input.signal)
      input.onStage?.('probe')
      await settle()
      record.stageSamples.push({ at: 'probe', text: liveTask?.stage })
      input.onStage?.('encode')
      await settle()
      record.stageSamples.push({ at: 'encode', text: liveTask?.stage })
      return { bytes: Buffer.from('stitched-bytes'), mime: 'video/mp4', duration: 4, width: 1280, height: 720 }
    },
    publish: async input => {
      record.publishes.push({ ...input, bytes: Buffer.from(input.bytes) })
      return { url: `${VIDEO_FILE_API}/${input.id}-0.mp4`, mime: input.mime, duration: input.duration }
    },
  }
  return composer
}

let chatCalls = 0
let liveRunner
/** One runner over the fake canvas + a chat stub that must stay untouched. */
function makeRunner(composer) {
  return new host.SkillRunner({
    backend: {
      canvas: canvasBackend,
      chat: { async complete() { chatCalls += 1; return 'this must never be used' } },
    },
    enabled: () => true,
    heavyEnabled: () => false,
    allowlist: () => [],
    runRoot: () => join(root, 'runs'),
    heavyTimeoutMs: () => 30_000,
    dataRoot: () => root,
    ...composer === undefined ? {} : { composer },
  })
}

/** Poll a task through the runner until it leaves queued/running. */
async function settleTask(taskId, attempts = 200) {
  let snapshot = liveRunner.task(taskId)
  for (let attempt = 0; attempt < attempts && snapshot !== undefined
    && (snapshot.status === 'queued' || snapshot.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    snapshot = liveRunner.task(taskId)
  }
  return snapshot
}

// ---------------------------------------------------------------- V1 catalog

await check('V1 compose.videos is a builtin local-tier action accepting video', async () => {
  liveRunner = makeRunner(fakeComposer())
  // No agent runtime is attached anywhere in this suite: a catalog entry gated
  // on `agentAvailable` would still list, but with a `requires` that blocks it.
  const catalog = await liveRunner.list('en')
  const compose = catalog.skills.find(skill => skill.id === 'compose.videos')
  assert.ok(compose !== undefined, `no compose.videos in the catalog: ${catalog.skills.map(s => s.id).join(', ')}`)
  assert.equal(compose.origin, 'builtin')
  assert.equal(compose.tier, 'local', 'stitching runs on this machine, never through a model')
  assert.deepEqual(compose.accepts, ['video'])
  assert.equal(compose.output, 'video')
  assert.equal(compose.name, copy('canvas.skills.compose'))
  assert.equal(compose.description, copy('canvas.skills.composeDesc'))
  assert.equal(compose.costHint, copy('canvas.skills.composeCost'))
  assert.notEqual(compose.name, 'canvas.skills.compose', 'the locale key resolved to real copy')
  assert.equal('requires' in compose, false, 'a local action must never be gated on the agent runtime')
  assert.equal(catalog.agentAvailable, false, 'this suite runs with no agent runtime at all')
  // The other built-ins are untouched by this change.
  assert.deepEqual(catalog.skills.filter(s => s.origin === 'builtin').map(s => s.id),
    ['polish.text', 'describe.image', 'extract.content', 'compose.videos', 'ppt.fromImages'])
})

// ------------------------------------------------------------- V2 too few

await check('V2 fewer than two real clips fails with the composeTooFew copy', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-thin', title: 'thin', nodes: [
    clipNode('clip-a', 0, 0, 'only one clip'),
    imageNode('still-1', 400, 0),
  ] }
  canvasDocuments.set(document.id, document)
  // One clip + one image: the image is a multi-select artifact, not a source.
  await assert.rejects(
    () => liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a', 'still-1'] }),
    error => error.message === copy('canvas.skills.composeTooFew'),
  )
  // A single clip is refused too, and nothing was ever handed to ffmpeg.
  await assert.rejects(
    () => liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a'] }),
    error => error.message === copy('canvas.skills.composeTooFew'),
  )
  assert.deepEqual(composer.record.stitchCalls, [], 'a refused run never reaches ffmpeg')
  assert.equal(chatCalls, 0, 'a refused run never reaches the chat model')
  // A missing canvas is still reported as such, not as a bad selection.
  await assert.rejects(
    () => liveRunner.run({ canvasId: 'canvas-none', skillId: 'compose.videos', nodeIds: ['clip-a', 'clip-b'] }),
    error => error.message === copy('canvas.skills.canvasMissing'),
  )
})

// ------------------------------------------------- V3/V4/V5 the real path

await check('V3-V5 three clips stitch in canvas order and land as a referenced video node', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-stitch', title: 'stitch', nodes: [...CLIPS, imageNode('still-9', 1200, 0)] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // Scrambled, and with a stray image thrown in: the host owns the order and
    // the membership of the source list.
    nodeIds: [...AS_SENT, 'still-9'],
  })
  composer.observe(task)
  assert.equal(task.tier, 'local')
  // The task records the RESOLVED order, so a reloaded run card shows the same
  // order the user will see in the produced clip.
  assert.deepEqual(task.nodeIds, EXPECTED_ORDER)

  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))

  // V3 — order, membership, and a run that never touched a model.
  assert.equal(composer.record.stitchCalls.length, 1, 'exactly one ffmpeg invocation')
  assert.deepEqual(composer.record.stitchCalls[0],
    EXPECTED_ORDER.map(id => `/fake/${id}-0.mp4`),
    'sources reached ffmpeg in canvas-position order (top row left→right, then the row below)')
  assert.deepEqual(composer.record.resolveCalls,
    EXPECTED_ORDER.map(id => `${VIDEO_FILE_API}/${id}-0.mp4`))
  assert.equal(composer.record.available, 1, 'the run asked the composer whether the tools exist')
  assert.ok(composer.record.signals[0] instanceof AbortSignal, 'the run hands ffmpeg an AbortSignal')
  assert.equal(chatCalls, before, 'a local-tier run spends ZERO chat calls')

  // V5 — the stage text advanced while the run was in flight.
  assert.deepEqual(composer.record.stageSamples, [
    { at: 'probe', text: copy('canvas.skills.composeStageProbe') },
    { at: 'encode', text: copy('canvas.skills.composeStageEncode') },
  ])
  assert.notEqual(copy('canvas.skills.composeStageProbe'), 'canvas.skills.composeStageProbe')

  // V4 — the produced node is a reference, never a copied asset.
  assert.equal(snapshot.output.nodes.length, 1)
  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'video')
  assert.equal(produced.metadata.video.url, `${VIDEO_FILE_API}/${composer.record.publishes[0].id}-0.mp4`)
  assert.match(produced.metadata.video.url, new RegExp(`^${VIDEO_FILE_API}/compose`))
  assert.equal(produced.metadata.video.mime, 'video/mp4')
  assert.equal(produced.metadata.video.duration, 4)
  assert.equal(produced.metadata.asset, undefined, 'the stitched clip is NOT copied into the canvas asset library')
  assert.equal('asset' in produced.metadata, false)
  assert.equal(produced.metadata.status, 'success')
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, EXPECTED_ORDER)
  assert.equal(produced.metadata.skill.id, 'compose.videos')
  // One edge per source clip, so the lineage is visible on the canvas.
  assert.deepEqual(snapshot.output.connections.map(edge => edge.fromNodeId), EXPECTED_ORDER)
  assert.deepEqual([...new Set(snapshot.output.connections.map(edge => edge.toNodeId))], [produced.id])
  assert.deepEqual(snapshot.output.warnings, [])

  // The publish call carried the human-readable provenance into the history.
  const publish = composer.record.publishes[0]
  assert.equal(publish.mime, 'video/mp4')
  assert.equal(publish.duration, 4)
  assert.equal(Buffer.from(publish.bytes).toString('utf8'), 'stitched-bytes')
  assert.match(publish.prompt, /first prompt/)
  assert.match(publish.prompt, /third prompt/)
  assert.equal(publish.prompt.indexOf('first prompt') < publish.prompt.indexOf('third prompt'), true,
    'the history prompt lists the clips in play order')
  assert.match(String(publish.id), /^compose/)

  // V6 — the node carries the SAME id as the history entry. The canvas 收藏
  // button is gated on `video.entryId` alone, so omitting it yields a gray
  // button while preview/download/frame-grab keep working; nothing else in this
  // suite would notice.
  assert.equal(produced.metadata.video.entryId, publish.id,
    'the produced node carries the history entryId — without it the canvas favorite button is disabled')

  // V7 — provenance is persisted into the video index, so it must NOT be
  // localized: a zh-composed entry re-read under an en UI would otherwise show
  // Chinese. Assert the stored string is language-independent.
  assert.match(publish.prompt, /^stitched from 3 clips:/)
  const zhPrompt = hostLocale.interpolate('canvas.skills.composeNode', undefined, 'zh')
  assert.equal(publish.prompt.includes(zhPrompt), false,
    'the persisted history prompt does not bake in a localized label')
})

// ------------------------------------------------------------ E1 real ffmpeg

await check('E1 (real ffmpeg) two synthetic clips stitch to roughly twice the length', async () => {
  const dirs = host.localVideoToolDirs()
  const findTool = name => dirs
    .map(dir => join(dir, name))
    .find(candidate => {
      try { accessSync(candidate, FS.X_OK); return statSync(candidate).isFile() } catch { return false }
    })
  const ffmpeg = findTool('ffmpeg')
  const ffprobe = findTool('ffprobe')
  if (ffmpeg === undefined || ffprobe === undefined) {
    skip(`no ffmpeg/ffprobe in ${dirs.join(', ')}`)
  }

  // Two synthetic clips in the video store: the first has real audio, the second
  // is SILENT — which is the branch where the pipeline must synthesize a
  // length-bounded silent track (an unbounded one would be OOM-killed).
  const filesDir = join(root, 'dsh-imagegen', 'videos', 'files')
  mkdirSync(filesDir, { recursive: true })
  const encode = (name, args) => {
    const target = join(filesDir, name)
    const run = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, target], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(run.status, 0, `building ${name} failed: ${run.stderr ?? run.error?.message ?? ''}`)
    return target
  }
  const clipA = encode('e2e-0.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ])
  const clipB = encode('e2e-1.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
  ])
  const durationOf = file => {
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr ?? ''}`)
    return Number.parseFloat(probe.stdout.trim())
  }
  const before = await host.listVideoHistory()
  assert.equal(before.length, 0, 'the video history starts empty')
  const totalInput = durationOf(clipA) + durationOf(clipB)

  liveRunner = makeRunner(host.createClipComposer())
  const document = { id: 'canvas-e2e', title: 'e2e', nodes: [
    { ...clipNode('e2e-b', 900, 0, 'silent second clip'), metadata: { video: { url: `${VIDEO_FILE_API}/e2e-1.mp4`, mime: 'video/mp4', duration: 2 }, status: 'success', prompt: 'silent second clip' } },
    { ...clipNode('e2e-a', 0, 0, 'clip with audio'), metadata: { video: { url: `${VIDEO_FILE_API}/e2e-0.mp4`, mime: 'video/mp4', duration: 2 }, status: 'success', prompt: 'clip with audio' } },
  ] }
  canvasDocuments.set(document.id, document)
  const task = await liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['e2e-b', 'e2e-a'] })
  const snapshot = await settleTask(task.id, 600)
  assert.equal(snapshot.status, 'completed', JSON.stringify({ error: snapshot.error, stage: snapshot.stage }))

  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'video')
  const served = String(produced.metadata.video.url).replace(`${VIDEO_FILE_API}/`, '')
  const onDisk = join(filesDir, served)
  assert.equal(statSync(onDisk).size > 0, true, 'the stitched clip exists on disk')
  const outSeconds = durationOf(onDisk)
  // Roughly 2x: the encode normalizes frame rate and pads to 1280x720, so allow
  // a generous window rather than demanding an exact sum.
  assert.equal(outSeconds > totalInput * 0.9 && outSeconds < totalInput * 1.1, true,
    `expected ~${totalInput.toFixed(2)}s, got ${outSeconds.toFixed(2)}s`)

  // It landed in the video history as a compose entry, not as a provider render.
  const history = await host.listVideoHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].mode, 'compose')
  assert.equal(history[0].model, 'ffmpeg')
  assert.equal(history[0].videos.length, 1)
  assert.equal(history[0].videos[0].url, produced.metadata.video.url)
  assert.equal(produced.metadata.asset, undefined, 'still a reference, even on the real path')
  assert.equal(chatCalls, 0, 'the real path spends zero chat calls too')

  rmSync(clipA, { force: true })
  rmSync(clipB, { force: true })
}, 300_000)

// ---------------------------------------------------------------- report

process.stderr.write(`\n${results.join('\n')}\n`)
rmSync(root, { recursive: true, force: true })

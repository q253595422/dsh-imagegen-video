/**
 * Storyboard node: offline checks for the parts that decide what gets saved,
 * what gets run and what gets stitched.
 *
 * The whole point of this node type is that a shot's clip is an ORDINARY video
 * node, so the checks here are about the edges that could break that promise:
 * a board that cannot be saved (which would lose the shot list on reload), a
 * board that counts a clip as ready when the canvas shows a spinner, and a
 * stitch that would hand ffmpeg a clip with no bytes.
 *
 * Two halves, both offline:
 *
 *  H*  the host store round-trips a document holding a storyboard node, refuses
 *      a malformed board instead of bricking the save, and accepts a board
 *      whose optional fields are missing (a document written by an older build).
 *  P*  the pure state functions the node renderer, the run button and the
 *      stitch all read, driven directly against the real module — no DOM, no
 *      server. The canvas has exactly one definition of "is this shot done",
 *      and these checks pin it.
 *
 * Run: node scripts/smoke-storyboard.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const results = []
const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

const root = mkdtempSync(join(tmpdir(), 'gal-storyboard-'))
process.env.DSH_HOME = root

/**
 * Load the store from SOURCE rather than the package entry.
 *
 * `CanvasStore` is not re-exported by `lib/index.js` (the plugin exposes a
 * singleton, not the class), and the store is written in TypeScript with a
 * constructor parameter property — which Node's default strip-only mode
 * refuses. Re-executing this script once with `--experimental-transform-types`
 * is what makes the real store testable here instead of a copy of its rules.
 */
async function loadStoreClass() {
  try {
    const module = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
    return module.CanvasStore
  } catch (error) {
    if (!/parameter property is not supported/.test(String(error?.message))) throw error
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.execArgv, new URL(import.meta.url).pathname], { stdio: 'inherit' })
    process.exit(result.status ?? 0)
  }
}
const CanvasStore = await loadStoreClass()

/** One canvas node of each shape the board talks about. */
const node = (overrides) => ({
  id: 'node', type: 'video', title: '视频节点',
  x: 0, y: 0, width: 240, height: 160,
  metadata: { status: 'success' },
  ...overrides,
})
const shot = (id, prompt, extra = {}) => ({ id, prompt, seconds: 5, ...extra })

/** A clip node that is playable. */
const clip = (id, extra = {}) => node({
  id,
  metadata: {
    status: 'success',
    video: { url: `/api/dsh-imagegen/videos/file/${id}.mp4`, mime: 'video/mp4', duration: 5, entryId: `entry-${id}` },
    ...extra,
  },
})

// ------------------------------------------------------------ host storage

await check('H1 a storyboard document saves and reads back intact', async () => {
  const { CanvasStore } = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
  const store = new CanvasStore(join(root, 'canvas-h1'))
  const created = await store.create('分镜')
  const board = {
    id: 'board-1', type: 'storyboard', title: '分镜',
    x: 10, y: 20, width: 380, height: 420,
    metadata: {
      storyboard: {
        shots: [shot('shot-1', 'a cat', { nodeId: 'clip-1' }), shot('shot-2', 'the same cat, closer', { seconds: 8 })],
        aspectRatio: '16:9', resolution: '720P', continuity: 'carry',
      },
    },
  }
  const produced = clip('clip-1', { shot: { storyboardId: 'board-1', shotId: 'shot-1', index: 1 } })
  const saved = await store.save({ ...created, nodes: [board, produced] }, created.revision)
  const read = await store.read(saved.id)
  assert.ok(read !== undefined, 'the canvas reads back')
  const storedBoard = read.nodes.find(item => item.id === 'board-1')
  assert.ok(storedBoard !== undefined, 'the storyboard node survived')
  assert.equal(storedBoard.metadata.storyboard.shots.length, 2, 'both shots survived')
  assert.equal(storedBoard.metadata.storyboard.continuity, 'carry', 'continuity survived')
  assert.equal(storedBoard.metadata.storyboard.shots[0].nodeId, 'clip-1', 'the shot -> clip link survived')
  assert.equal(read.nodes.find(item => item.id === 'clip-1').metadata.shot.shotId, 'shot-1', 'clip provenance survived')
})

await check('H2 a board with missing optional fields is still savable', async () => {
  const { CanvasStore } = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
  const store = new CanvasStore(join(root, 'canvas-h2'))
  const created = await store.create('旧文档')
  // What an older build would write: a shot list and nothing else.
  const board = {
    id: 'board-2', type: 'storyboard', title: '分镜',
    x: 0, y: 0, width: 380, height: 420,
    metadata: { storyboard: { shots: [shot('shot-1', '')] } },
  }
  const saved = await store.save({ ...created, nodes: [board] }, created.revision)
  const read = await store.read(saved.id)
  assert.ok(read !== undefined && read.nodes.length === 1, 'the minimal board saves')
})

await check('H3 a malformed board makes the save FAIL LOUDLY, not silently', async () => {
  const { CanvasStore } = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
  const store = new CanvasStore(join(root, 'canvas-h3'))
  const created = await store.create('坏文档')
  const broken = {
    id: 'board-3', type: 'storyboard', title: '分镜',
    x: 0, y: 0, width: 380, height: 420,
    // seconds is a string: not something the renderer can honour.
    metadata: { storyboard: { shots: [{ id: 'shot-1', prompt: 'x', seconds: '5' }] } },
  }
  let failed = false
  try {
    await store.save({ ...created, nodes: [broken] }, created.revision)
  } catch (error) {
    failed = true
    assert.match(String(error.message), /malformed canvas document/, 'the failure names the document')
  }
  assert.ok(failed, 'a half-valid board must not be written')
})

await check('H4 a shot count over the cap is refused, not silently truncated', async () => {
  const { CanvasStore } = await import(new URL('../src/canvas-store.ts', import.meta.url).href)
  const store = new CanvasStore(join(root, 'canvas-h4'))
  const created = await store.create('超长')
  const shots = Array.from({ length: 41 }, (_value, index) => shot(`shot-${index + 1}`, 'x'))
  const board = {
    id: 'board-4', type: 'storyboard', title: '分镜',
    x: 0, y: 0, width: 380, height: 420,
    metadata: { storyboard: { shots } },
  }
  let failed = false
  try {
    await store.save({ ...created, nodes: [board] }, created.revision)
  } catch { failed = true }
  assert.ok(failed, '41 shots is past the documented cap')
})

// ------------------------------------------------------------ pure state

const state = await import(new URL('../src/client/storyboard.ts', import.meta.url).href)

await check('P1 a fresh board has one blank row and normalizes every field', async () => {
  const fresh = state.defaultStoryboard()
  assert.equal(fresh.shots.length, 1, 'a new board opens with one row to type into')
  assert.equal(fresh.continuity, 'cut', 'shots are independent by default')
  const normalized = state.storyboardOf({ id: 'b', type: 'storyboard', title: '', x: 0, y: 0, width: 1, height: 1, metadata: { storyboard: { shots: [] } } })
  assert.equal(normalized.shots.length, 1, 'an empty stored list is replaced, not rendered as an empty board')
  assert.equal(normalized.aspectRatio, '16:9')
  assert.equal(normalized.resolution, '720P')
})

await check('P2 shot state follows the produced node, never a stored copy', async () => {
  const blank = shot('s1', 'a cat')
  assert.equal(state.shotState(blank, []), 'empty', 'no node means not produced')

  const generating = shot('s1', 'a cat', { nodeId: 'clip-1' })
  const pending = node({ id: 'clip-1', metadata: { status: 'generating', taskId: 't1' } })
  assert.equal(state.shotState(generating, [pending]), 'generating', 'a placeholder is still rendering')

  assert.equal(state.shotState(generating, [clip('clip-1')]), 'ready', 'a clip is ready')

  const failed = node({ id: 'clip-1', metadata: { status: 'error', error: '上游拒绝' } })
  assert.equal(state.shotState(generating, [failed]), 'failed', 'a failed node can be retried')

  // The user deleted the produced clip: the shot is unproduced again, and must
  // be re-runnable rather than pointing at a node that no longer exists.
  assert.equal(state.shotState(generating, []), 'empty', 'a deleted clip makes the shot empty again')
})

await check('P3 progress and the next shot agree with the shot states', async () => {
  const board = {
    shots: [shot('s1', 'one', { nodeId: 'c1' }), shot('s2', 'two'), shot('s3', '')],
    aspectRatio: '16:9', resolution: '720P', continuity: 'cut',
  }
  const nodes = [clip('c1')]
  const progress = state.storyboardProgress(board, nodes)
  assert.equal(progress.total, 3)
  assert.equal(progress.ready, 1)
  // `empty` counts every shot with nothing to run: the one with no prompt AND
  // the one with a prompt but no clip yet.
  assert.equal(progress.empty, 2, 'prompt-less and clip-less shots both count as unrun')
  assert.equal(state.nextShotIndex(board, nodes), 1, 'the next runnable shot is the one after the finished one')
  // A prompt-less row is skipped by the run, never submitted as an empty render.
  const onlyBlank = { ...board, shots: [shot('s1', ''), shot('s2', 'two')] }
  assert.equal(state.nextShotIndex(onlyBlank, []), 1, 'a row with no prompt is not the next shot')

  const allDone = { ...board, shots: [shot('s1', 'one', { nodeId: 'c1' })] }
  assert.equal(state.nextShotIndex(allDone, nodes), -1, 'nothing left to run')
})

await check('P4 only ready clips are handed to the stitch, in shot order', async () => {
  const board = {
    shots: [
      shot('s1', 'one', { nodeId: 'c1' }),
      shot('s2', 'two', { nodeId: 'c2' }),
      shot('s3', 'three', { nodeId: 'c3' }),
      shot('s4', 'four'),
    ],
    aspectRatio: '16:9', resolution: '720P', continuity: 'cut',
  }
  const nodes = [
    clip('c1'),
    // Still rendering: no bytes to concatenate.
    node({ id: 'c2', metadata: { status: 'generating', taskId: 't' } }),
    clip('c3'),
  ]
  assert.deepEqual(state.storyboardClipIds(board, nodes), ['c1', 'c3'], 'list order, ready clips only')
})

await check('P5 list edits keep the running order coherent', async () => {
  const board = { shots: [shot('a', '1'), shot('b', '2'), shot('c', '3')], aspectRatio: '16:9', resolution: '720P', continuity: 'cut' }
  assert.deepEqual(state.withMovedShot(board, 2, -1).shots.map(row => row.id), ['a', 'c', 'b'], 'moved up')
  assert.deepEqual(state.withMovedShot(board, 0, -1).shots.map(row => row.id), ['a', 'b', 'c'], 'clamped at the top')
  assert.deepEqual(state.withRemovedShot(board, 1).shots.map(row => row.id), ['a', 'c'], 'removed')
  assert.equal(state.withRemovedShot({ ...board, shots: [shot('only', 'x')] }, 0).shots.length, 1, 'never leaves an empty list to type into')
  assert.equal(state.withAppendedShot({ ...board, shots: Array.from({ length: state.MAX_SHOTS }, (_v, i) => shot(`s${i + 1}`, 'x')) }).shots.length, state.MAX_SHOTS, 'the cap holds')
  assert.equal(state.withShot(board, 1, { prompt: 'edited' }).shots[1].prompt, 'edited', 'per-row edits land on that row')
})

await check('P6 the built client bundle carries the board renderer', async () => {
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The rows and the two foot actions are what a user operates; if the bundler
  // dropped the component, none of these survive into the shipped bundle.
  assert.match(bundle, /storyboardBody/, 'the board body is in the bundle')
  assert.match(bundle, /storyboardShots/, 'the shot list is in the bundle')
  assert.match(bundle, /storyboardFoot/, 'the board actions are in the bundle')
})

// ------------------------------------------------------------ run

for (const { name, fn } of checks) {
  process.stderr.write(`... ${name}\n`)
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

rmSync(root, { recursive: true, force: true })
for (const line of results) console.log(line)

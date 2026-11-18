/**
 * 画布「成片认领」（`src/client/canvas/video-ledger.ts`）的契约。
 *
 * WHY 单独一套：这个模块的每一种错都**不会抛异常**——它要么把一条不属于这张
 * 卡的片段填进去（用户看到「成功」，但内容不是这次要的），要么该认领的不认领
 * （用户截图里那一类「视频已成功生成却显示丢失」）。两种都只能靠断言钉住。
 *
 * 本模块不碰 React / DOM / 网络，直接从源码 import。
 *
 * Run: node scripts/smoke-canvas-video-ledger.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import { claimableClips } from '../src/client/canvas/video-ledger.ts'

const LOST = '视频任务已丢失，可重试'

/** 一个画布节点；`metadata` 由调用方指定，模拟真实文档里的形状。 */
const videoNode = (id, metadata) => ({
  id,
  type: 'video',
  title: id,
  x: 0,
  y: 0,
  width: 240,
  height: 160,
  metadata,
})

/** 一条视频历史；默认形状与宿主写出来的一致。 */
const historyEntry = (id, overrides = {}) => ({
  id,
  createdAt: 1,
  mode: 'image',
  model: 'MiniMax-H3',
  prompt: '把中间人物换成图片上的 说尼玛的 妍妍 你就是个叼毛',
  aspectRatio: '16:9',
  resolution: '768P',
  seconds: 10,
  videos: [{ url: `/api/dsh-imagegen/video/file/${id}-0.mp4`, mime: 'video/mp4' }],
  ...overrides,
})

const doc = (nodes) => ({
  version: 2,
  id: 'canvas-1',
  title: '未命名画布',
  revision: 1,
  viewport: { k: 1, x: 0, y: 0 },
  background: 'lines',
  nodes,
  connections: [],
  createdAt: 1,
  updatedAt: 1,
})

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// --------------------------------------------------------------- L1 根因复现

check('L1 用户截图那一类：节点被判「丢失」但历史里有 lineaged 成片 → 认领', () => {
  // 真实数据：node-cda2d791 的 metadata.status = 'error'、error = 视频任务已丢失、
  // 没有 video 字段；而 videos/index.json 里有 6c9472d1（prompt 一字不差）。
  const document = doc([
    videoNode('node-lost', {
      status: 'error',
      taskId: '770bedd1-5543-47cb-a88d-1c2c683ea76d',
      prompt: '把中间人物换成图片上的 说尼玛的 妍妍 你就是个叼毛',
      model: 'MiniMax-H3',
      videoMode: 'image',
      seconds: 10,
      error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('6c9472d1', { canvas: { canvasId: 'canvas-1', nodeId: 'node-lost' } })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1, '有落盘归属的成片必须被认领')
  assert.equal(claims[0].nodeId, 'node-lost')
  assert.equal(claims[0].video.entryId, '6c9472d1')
  assert.equal(claims[0].video.url, '/api/dsh-imagegen/video/file/6c9472d1-0.mp4')
})

check('L2 lineage 认领不依赖 prompt/model 是否对得上：归属是写下来的事实', () => {
  // 旧节点可能被用户改过标题/提示词。归属字段还在，就必须认。
  const document = doc([
    videoNode('node-a', { status: 'generating', taskId: 't1', prompt: '改过的提示词', model: 'X', videoMode: 'text', seconds: 5 }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '原始提示词', model: 'Y', canvas: { canvasId: 'canvas-1', nodeId: 'node-a' } })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1)
  assert.equal(claims[0].nodeId, 'node-a')
})

// ------------------------------------------------------------- L3 老条目兜底

check('L3 老条目（无 lineage）字段全等且唯一 → 认领被判丢失的节点', () => {
  const document = doc([
    videoNode('node-old', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e-old', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1, '四字段全等的老条目应当救回这个节点')
  assert.equal(claims[0].video.entryId, 'e-old')
})

check('L4 老条目候选有两条 → 一律不认领（错配比丢失更难发现）', () => {
  const document = doc([
    videoNode('node-old', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const base = { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 }
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', base), historyEntry('e2', base)],
    lostError: LOST,
  })
  assert.deepEqual(claims, [], '两条同样的老片，不能猜哪条是它的')
})

check('L5 老条目差一个字段就不认领（秒数不同）', () => {
  const document = doc([
    videoNode('node-old', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 10 })],
    lostError: LOST,
  })
  assert.deepEqual(claims, [])
})

check('L6 兜底只对「被判丢失」生效：仍在 generating 的节点不拿老片填', () => {
  // 关键回归：还在渲染的节点如果被一条旧片填成成功，真正在跑的那次结果就
  // 没有节点可落了。
  const document = doc([
    videoNode('node-live', {
      status: 'generating', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e-old', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.deepEqual(claims, [], 'generating 的节点不该被老条目认领')
})

// ---------------------------------------------------------- L7 已认领不再动

check('L7 已经有片段的节点不被改写，它引用的历史也不再分给别人', () => {
  const document = doc([
    videoNode('node-done', {
      status: 'success',
      prompt: '嗨',
      model: 'MiniMax-H3',
      videoMode: 'text',
      seconds: 5,
      video: { url: '/api/dsh-imagegen/video/file/e1-0.mp4', mime: 'video/mp4', entryId: 'e1' },
    }),
    videoNode('node-lost', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.deepEqual(claims, [], '已被引用的历史不能二次分配')
})

check('L8 一条历史最多填一个节点（同一 entryId 两处会让删除/收藏语义变糊）', () => {
  const document = doc([
    videoNode('node-a', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
    videoNode('node-b', {
      status: 'error', taskId: 'u', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1, '唯一一条老片只能救一个节点')
})

// ------------------------------------------------------- L9 其它错误不覆盖

check('L9 上游真失败的节点保留自己的错误，不被认领', () => {
  // 只有「被判丢失」这一种错误可以被历史救回；渲染真失败了还显示成功，
  // 用户就再也不会去重试。
  const document = doc([
    videoNode('node-fail', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5,
      error: '上游返回 500：模型繁忙',
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.deepEqual(claims, [])
})

check('L10 同一节点有多条归属（重试过）时取最新的那条', () => {
  // 历史是新到旧：重试产生的第二条在最前。
  const document = doc([
    videoNode('node-retry', {
      status: 'generating', taskId: 't2', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5,
    }),
  ])
  const lineage = { canvasId: 'canvas-1', nodeId: 'node-retry' }
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e-new', { canvas: lineage }), historyEntry('e-old', { canvas: lineage })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1)
  assert.equal(claims[0].video.entryId, 'e-new', '重试后的新成片优先')
})

check('L11 切换语言后，已打 failure 标记的节点仍能被认领', () => {
  // 文案随语言变；标记不随。没有这条，用户切一次语言就永久救不回来。
  const document = doc([
    videoNode('node-lang', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5,
      error: 'The video task was lost; you can retry', failure: 'task-lost',
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { prompt: '嗨', model: 'MiniMax-H3', mode: 'text', seconds: 5 })],
    lostError: LOST,
  })
  assert.equal(claims.length, 1, '标记优先于文案比对')
})

check('L12 lineage 指向别的节点时不认领本节点', () => {
  const document = doc([
    videoNode('node-a', {
      status: 'error', taskId: 't', prompt: '嗨', model: 'MiniMax-H3', videoMode: 'text', seconds: 5, error: LOST,
    }),
  ])
  const claims = claimableClips({
    document,
    videoHistory: [historyEntry('e1', { canvas: { canvasId: 'canvas-1', nodeId: 'node-other' } })],
    lostError: LOST,
  })
  // 这条有归属，但没有落到本画布任何节点；它不能退化成老条目兜底。
  assert.deepEqual(claims, [], '有归属的条目不该被别的节点当老条目捡走')
})

check('L13 空历史 / 非视频节点 / 已删除的任务 id 都安全返回空', () => {
  const document = doc([
    videoNode('node-no-task', { status: 'error', error: LOST }),
    { id: 'img-1', type: 'image', title: '图', x: 0, y: 0, width: 200, height: 200, metadata: { status: 'error', error: LOST } },
  ])
  assert.deepEqual(claimableClips({ document, videoHistory: [], lostError: LOST }), [])
})

// ------------------------------------------------------------------ 执行
//
// 用共享的 check 跑器而不是手写 try/catch 循环：那套手写驱动会丢了卡死守卫
// （检查永远不返回时整组挂住），也没有 SKIP 这条遇到。结果行归调用方打印。
const results = []
const run = createCheckHarness({ results })
for (const { name, fn } of checks) await run(name, fn)
for (const line of results) (line.startsWith('FAIL') ? console.error : console.log)(line)

const failed = results.filter(line => line.startsWith('FAIL')).length
const passed = results.length - failed
console.log(`\n${passed}/${results.length} 通过`)
if (failed > 0) process.exit(1)

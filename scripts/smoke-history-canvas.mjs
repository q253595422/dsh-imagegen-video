/**
 * 历史记录里「画布」这一类行：产物不进列表、保存的画布进列表、点一下真的
 * 打开被点的那一张。
 *
 * WHY 单独一个套件：这个需求的三个要求全都**只错一半就很难发现**——
 *
 *  - 过滤写漏了：画布产物又冒出来，列表被同一份工作占两遍。看起来「有东西」，
 *    所以没人报错，只是越来越难用。
 *  - 缩略图没落盘：画布行还在，只是每一行都是同一个图标。功能上没错，认不出
 *    是哪张画布。
 *  - 来源没写进盘：重启之后那条成片就再也认不出属于谁了。当次会话里一切正常，
 *    下次打开才复现——这恰恰是最难在验收时抓到的一类。
 *
 * 这里跑的是**真实存储**（临时 DSH_HOME + 构建产物 lib/），不是假数据：
 * 上面第三条只有在「写盘 → 重新从盘里读」之后才现形。
 *
 * Run: node scripts/smoke-history-canvas.mjs   (from the package root)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

// 数据根目录在第一次 import store 时解析 DSH_HOME。必须在任何 src/ 之前设好，
// 否则这个套件会往用户真实的画布库里写东西。
const home = mkdtempSync(join(tmpdir(), 'gal-history-canvas-'))
process.env.DSH_HOME = home

const { appendVideoHistory, listVideoHistory, canvasStore } = await import('../lib/index.js')

// 判定规则（超时是挂起守卫而非结论、SKIP 不算失败、退出码只在真失败时置 1）
// 全仓只有 scripts/lib/check-harness.mjs 一份实现，这里不另写一个循环。
const results = []
const check = createCheckHarness({ results })

/** 一帧最小合法 mp4 头；这里只关心索引里的字段，不解码。 */
const clipBytes = () => Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])

function clipInput (overrides = {}) {
  return {
    id: `clip-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
    mode: 'video',
    model: 'seedance-1.0',
    prompt: '一个人走进雨里',
    aspectRatio: '16:9',
    resolution: '1280x720',
    seconds: 4,
    files: [{ bytes: clipBytes(), mime: 'video/mp4', duration: 4 }],
    ...overrides,
  }
}

function canvasDoc (id, overrides = {}) {
  return {
    version: 2,
    id,
    title: '画布',
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------- 来源落盘

await check('视频历史的画布来源写进盘、读回来还在', async () => {
  await appendVideoHistory(clipInput({
    id: 'clip-with-canvas',
    canvas: { canvasId: 'canvas-A', sourceNodeId: 'node-1' },
  }))
  // 从盘里重新读一遍：只断言返回值得不到任何保证——`appendVideoHistory`
  // 的返回值是内存里那一份，投影漏字段时它照样带着 `canvas`。
  const listed = await listVideoHistory()
  const entry = listed.find(item => item.id === 'clip-with-canvas')
  assert.ok(entry !== undefined, 'the clip it just wrote must be listed')
  assert.deepEqual(entry.canvas, { canvasId: 'canvas-A', sourceNodeId: 'node-1' },
    'the canvas lineage must survive a write + read, or a reopen cannot tell whose clip this is')
})

await check('没有画布来源的视频保持没有这个字段', async () => {
  await appendVideoHistory(clipInput({ id: 'clip-plain' }))
  const entry = (await listVideoHistory()).find(item => item.id === 'clip-plain')
  assert.ok(entry !== undefined)
  assert.ok(entry.canvas === undefined,
    'a clip made outside any canvas must not claim one — the list filters on this very field')
})

// ---------------------------------------------------------------- 画布缩略图

await check('保存画布时把第一张图片节点记成缩略图', async () => {
  const created = await canvasStore.create('有图的画布')
  const saved = await canvasStore.save({
    ...created,
    nodes: [
      // 顺序刻意让视频节点排在前面：缩略图那一格是 <img>，视频 URL 解不出来。
      { id: 'v1', type: 'video', title: '片', x: 0, y: 0, width: 10, height: 10, metadata: { video: { url: '/videos/v1.mp4', mime: 'video/mp4' } } },
      { id: 'i1', type: 'image', title: '图', x: 20, y: 0, width: 10, height: 10, metadata: { asset: { assetId: 'a1', url: '/canvas-assets/i1.png', mime: 'image/png', bytes: 1, width: 10, height: 10, origin: 'upload' } } },
      { id: 'i2', type: 'image', title: '图2', x: 40, y: 0, width: 10, height: 10, metadata: { asset: { assetId: 'a2', url: '/canvas-assets/i2.png', mime: 'image/png', bytes: 1, width: 10, height: 10, origin: 'upload' } } },
    ],
  }, created.revision)
  assert.ok(saved !== undefined)
  const summary = (await canvasStore.list()).find(item => item.id === created.id)
  assert.ok(summary !== undefined)
  assert.equal(summary.thumb, '/canvas-assets/i1.png',
    'the thumbnail must be the first IMAGE node, not the first node and not the last image')
})

await check('没有图片节点的画布不编一个假缩略图', async () => {
  const created = await canvasStore.create('空画布')
  const summary = (await canvasStore.list()).find(item => item.id === created.id)
  assert.ok(summary !== undefined)
  assert.ok(summary.thumb === undefined,
    'a canvas with no images must fall back to the glyph, not carry a bogus URL')
})

await check('老索引里没有 thumb 也读得出来', async () => {
  // 直接造一条「升级前」的索引：这条断言守的是向后兼容，而兼容只有拿旧形状
  // 的数据才测得出来。
  const { promises: fs } = await import('node:fs')
  const indexPath = join(home, 'dsh-imagegen', 'canvas', 'index.json')
  const raw = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  raw.projects = raw.projects.map(project => {
    const { thumb, ...rest } = project
    return rest
  })
  await fs.writeFile(indexPath, JSON.stringify(raw))
  const listed = await canvasStore.list()
  assert.ok(listed.length > 0, 'an index without thumb must still list')
  assert.ok(listed.every(project => project.thumb === undefined))
})

await check('同一个 id 再保存一次是覆盖，不是再加一条', async () => {
  // 这条守的是 2026-11-18 用户报的「删不掉」：导演台导出用固定 id
  // （`stage-<sessionId>`），而测试脚本没隔离数据目录，每跑一次 pnpm test 就
  // 往真实库里追加一条同 id 的条目。前端拿 `video:${id}` 当 React key，重复行
  // 撞在同一个 key 上；删除又用 `filter(id !== x)` 一次抹掉全部——用户看到的是
  // 「三条一样的，删一条还剩两条」。
  await appendVideoHistory(clipInput({ id: 'clip-same', prompt: '第一次' }))
  await appendVideoHistory(clipInput({ id: 'clip-same', prompt: '第二次' }))
  await appendVideoHistory(clipInput({ id: 'clip-same', prompt: '第三次' }))
  const listed = (await listVideoHistory()).filter(item => item.id === 'clip-same')
  assert.equal(listed.length, 1, 're-saving one id must leave exactly one row, or the sidebar renders duplicates under one React key')
  assert.equal(listed[0].prompt, '第三次', 'the newest save is the one that survives')
})

await check('删除一个 id 会连它名下所有旧文件一起清掉', async () => {
  // 旧索引里可能有同 id 的多条（去重之前写下的）。删除若只删第一条的文件，
  // 其余从索引里消失了、文件却永远留在磁盘上——这正是"删不干净"的另一半。
  const { promises: fs } = await import('node:fs')
  const indexPath = join(home, 'dsh-imagegen', 'videos', 'index.json')
  const raw = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  // 直接造出「去重之前」的形状：三条同 id，各自指向不同的文件。
  raw.entries = [
    { id: 'clip-dup', createdAt: 3, mode: 'compose', model: 'ffmpeg', prompt: 'x', aspectRatio: '1:1', resolution: '64x64', seconds: 1, videos: [{ file: 'clip-dup-0.mp4', mime: 'video/mp4' }] },
    { id: 'clip-dup', createdAt: 2, mode: 'compose', model: 'ffmpeg', prompt: 'x', aspectRatio: '1:1', resolution: '64x64', seconds: 1, videos: [{ file: 'clip-dup-old-0.mp4', mime: 'video/mp4' }] },
    { id: 'clip-dup', createdAt: 1, mode: 'compose', model: 'ffmpeg', prompt: 'x', aspectRatio: '1:1', resolution: '64x64', seconds: 1, videos: [{ file: 'clip-dup-older-0.mp4', mime: 'video/mp4' }] },
  ]
  await fs.writeFile(indexPath, JSON.stringify(raw))
  const filesDir = join(home, 'dsh-imagegen', 'videos', 'files')
  for (const name of ['clip-dup-0.mp4', 'clip-dup-old-0.mp4', 'clip-dup-older-0.mp4']) {
    await fs.writeFile(join(filesDir, name), clipBytes())
  }

  const { removeVideoHistory } = await import('../lib/index.js')
  const left = await removeVideoHistory('clip-dup')
  assert.equal(left.filter(item => item.id === 'clip-dup').length, 0, 'every row of that id must be gone')
  for (const name of ['clip-dup-0.mp4', 'clip-dup-old-0.mp4', 'clip-dup-older-0.mp4']) {
    const still = await fs.stat(join(filesDir, name)).then(() => true, () => false)
    assert.equal(still, false, `${name} must be unlinked: deleting only the first row's files orphans the rest`)
  }
})

// ------------------------------------------------------------------- 收尾

rmSync(home, { recursive: true, force: true })

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\nhistory-canvas: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nhistory-canvas: ${results.length} passed\n`)
}

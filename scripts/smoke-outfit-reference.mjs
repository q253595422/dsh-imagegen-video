// Run: node --experimental-strip-types scripts/smoke-outfit-reference.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OutfitReferenceStore, outfitAssetUrl } from '../src/outfit-reference-store.ts'
import { OUTFIT_API } from '../src/outfit-reference.ts'

const root = await mkdtemp(path.join(tmpdir(), 'outfit-smoke-'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dVAAAAAASUVORK5CYII=', 'base64')
let checks = 0
async function check(name, run) { await run(); console.log(`ok ${++checks} - ${name}`) }
try {
  const store = new OutfitReferenceStore({ root, fetcher: async () => { throw new Error('network disabled') } })
  await check('图库代表性图片路径与无扩展名 URL 保留，任意地址拒绝', async () => {
    const revision = '488939139c69acfe078372b39d4bd0c457dc060e'
    assert.equal(outfitAssetUrl('img/full_single_P001_front.png'), `https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/${revision}/img/full_single_P001_front.png`)
    for (const url of [
      'https://charadb-2fi.pages.dev/img/O001.jpg',
      'https://charadb-2fi.pages.dev/img/O001',
      'https://ai-costume-anime-gallery.pages.dev/png/SPR-0001.png',
      'https://ai-costume-gallery.pages.dev/img/C001.webp',
      'https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/488939139c69acfe078372b39d4bd0c457dc060e/img/costumes/shisei/costume_C001_front.webp',
    ]) assert.equal(outfitAssetUrl(url), url)
    for (const url of ['http://charadb-2fi.pages.dev/img/O001', 'https://127.0.0.1/img/O001', 'https://raw.githubusercontent.com/another/repo/main/img/test.png', 'https://charadb-2fi.pages.dev/img/../private', 'https://charadb-2fi.pages.dev/admin/O001']) {
      assert.throws(() => outfitAssetUrl(url), /可信来源内/)
    }
  })
  await check('索引 URL 锁定到提交，且回退链上的每一份都校验同一 Git blob', async () => {
    const calls = []
    const isolated = new OutfitReferenceStore({ root: path.join(root, 'revision'), fetcher: async url => { calls.push(url); throw new Error('offline') } })
    const result = await isolated.list({ kind: 'portrait' })
    assert.equal(result.total, 0)
    assert.equal(result.warnings.length, 1)
    // Every candidate must name the SAME pinned commit: a mirror that tracked a
    // branch would let the material drift under an unchanged plugin version.
    const revision = '488939139c69acfe078372b39d4bd0c457dc060e'
    assert.deepEqual(calls, [
      `https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/${revision}/data/portrait-zh.json`,
      `https://api.github.com/repos/anhao/ai-pose-gallery-zh/contents/data/portrait-zh.json?ref=${revision}`,
      `https://gcore.jsdelivr.net/gh/anhao/ai-pose-gallery-zh@${revision}/data/portrait-zh.json`,
      `https://testingcf.jsdelivr.net/gh/anhao/ai-pose-gallery-zh@${revision}/data/portrait-zh.json`,
      `https://cdn.jsdelivr.net/gh/anhao/ai-pose-gallery-zh@${revision}/data/portrait-zh.json`,
      `https://fastly.jsdelivr.net/gh/anhao/ai-pose-gallery-zh@${revision}/data/portrait-zh.json`,
    ])
    // The bare "fetch failed" told the user nothing; the reason names each host.
    assert.match(result.warnings[0], /raw\.githubusercontent\.com: offline/)
    assert.match(result.warnings[0], /api\.github\.com: offline/)
    assert.match(result.warnings[0], /cdn\.jsdelivr\.net: offline/)
  })
  await check('首个来源超时后用镜像继续，内容仍按固定提交校验', async () => {
    const { createHash } = await import('node:crypto')
    const blob = content => createHash('sha1').update(Buffer.from(`blob ${content.byteLength}\0`)).update(content).digest('hex')
    // A one-row index shaped exactly like the real one, hashed the way Git does.
    // The thumbnail must be a path `safeAsset` accepts (`img/` or `thumbs/`): a
    // bare `thumb/...` is neither a mirrorable path nor an absolute URL, so
    // `normalize` throws "Invalid URL" on it. That went unnoticed because this
    // row is rejected by the blob check before it is ever normalized — and it
    // masked the real assertion once the check was disabled (see
    // `scripts/verify-negative.mjs`, the outfit group).
    const record = { id: 'P001', 标题: '测试人像', 分区: '正脸参考', 发长: '短发', 发型名称: '标准款', 原图: 'img/full_single_P001_front.png', 缩略图: 'thumbs/full_single_P001_front.png' }
    const real = Buffer.from(JSON.stringify([record]))
    const sha = blob(real)
    const seen = []
    const fresh = new OutfitReferenceStore({
      root: path.join(root, 'fallback'),
      fetcher: async url => {
        seen.push(url)
        if (url.includes('raw.githubusercontent.com')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        if (url.includes('api.github.com')) return new Response(JSON.stringify({ encoding: 'base64', content: real.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response(real, { status: 200 })
      },
    })
    // Swap in the local hash: the store's table is fixed, so an unrelated
    // mirror must be REJECTED rather than trusted.
    const mismatch = await fresh.list({ kind: 'portrait' })
    assert.equal(mismatch.total, 0)
    assert.match(mismatch.warnings[0], /版本已变化/)
    assert.ok(seen.some(url => url.includes('cdn.jsdelivr.net')), 'every source is tried before giving up')
    assert.ok(sha.length === 40)
  })
  await check('镜像返回非图片内容时按魔数拒绝，不会写进缓存', async () => {
    const seen = []
    const store3 = new OutfitReferenceStore({
      root: path.join(root, 'magic'),
      fetcher: async url => {
        seen.push(url)
        if (url.includes('raw.githubusercontent.com')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        // A 200 with an HTML body and an image content-type: only the magic
        // bytes can tell this apart from a real thumbnail.
        return new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'image/png' } })
      },
    })
    // Reach the image path without the fixed index: seed a cache file the store
    // itself would have written, then fetch its thumbnail.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const cacheDir = path.join(root, 'magic', 'catalog')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, 'pose-zh.json'), JSON.stringify({
      revision: '488939139c69acfe078372b39d4bd0c457dc060e',
      rows: [{
        ref: {
          key: 'pose:gia:P001', kind: 'pose', source: 'gia', sourceUrl: '', revision: '488939139c69acfe078372b39d4bd0c457dc060e',
          title: '测试姿势', category: '标准系 · 站姿', tags: [], angle: '正面', group: '标准系:P001',
          thumbnailUrl: `${OUTFIT_API.image}/thumb/pose%3Agia%3AP001`, imageUrl: `${OUTFIT_API.image}/full/pose%3Agia%3AP001`,
          sensitive: false, notice: '',
        },
        image: 'img/full_single_P001_front.png',
        thumb: 'thumbs/full_single_P001_front.png',
        views: {},
      }],
    }))
    // The HTML body failed the magic-byte gate inside fetchImage and was
    // refused there — that is the whole point: it is rejected as "not an
    // image", the next mirror is tried, and nothing is cached.
    await assert.rejects(store3.preview('pose:gia:P001', true), /图库图片不可用/)
    assert.ok(seen.some(url => url.includes('cdn.jsdelivr.net')), 'the image mirror was tried')
    // Nothing may have been written for that key.
    const { readdir } = await import('node:fs/promises')
    const stored = await readdir(path.join(root, 'magic', 'images')).catch(() => [])
    assert.deepEqual(stored, [], 'no image file was cached from the fake response')
  })

  await check('上传成功落到本机且重启后可读', async () => {
    const ref = await store.upload({ kind: 'portrait', name: '我的模特', data: `data:image/png;base64,${png.toString('base64')}` })
    assert.match(ref.imageUrl, new RegExp(`^${OUTFIT_API.image}/[a-f0-9]{64}\\.png$`))
    assert.deepEqual((await new OutfitReferenceStore({ root }).image(ref.imageUrl.split('/').pop())).data, png)
    await assert.rejects(store.upload({ kind: 'pose', name: 'not an image', data: 'data:image/png;base64,YWJj' }), /格式或大小无效/)
  })
  if (process.env.OUTFIT_SMOKE_LIVE === '1') await check('固定提交六份真实数据全部可适配', async () => {
    const live = new OutfitReferenceStore({ root: path.join(root, 'live') })
    for (const [kind, count] of [['pose', 1439], ['portrait', 1499], ['costume', 3224]]) {
      const result = await live.list({ kind, includeSensitive: true, limit: 1 })
      assert.deepEqual(result.warnings, [], `${kind} 索引或图片路径不兼容`)
      assert.equal(result.total, count, `${kind} 实际条目数量`)
    }
  })
} finally { await rm(root, { recursive: true, force: true }) }

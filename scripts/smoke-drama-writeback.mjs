/**
 * 「画布 → 文档回写」的用例。
 *
 * 分两半：前半测纯函数（路径、槽位、改写），后半在临时目录里真写文件，
 * 测宿主那一层的安全边界（越界、覆盖、备份、并发改动）。
 *
 * WHY 用真磁盘而不是桩 `node:fs`：这一层最有价值的几件事——「写不进去
 * 别人的目录」「覆盖前留了备份」「改名成功但写入失败时原文件回得去」——
 * 全都只在真文件系统上成立。桩掉 fs 之后，这些用例会变成在测我自己写的
 * 假 fs。
 *
 * Run: node scripts/smoke-drama-writeback.mjs   (from the package root, no build)
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  outputDirectoryOf,
  outputFileOf,
  patchStoryboardReferences,
  planDramaWriteback,
  referenceLineOf,
  slotOfShot,
} from '../src/client/drama-writeback.ts'
import { writeDramaDocument, writeDramaOutput } from '../src/drama-write.ts'
import { writebackDrama } from '../src/client/drama-writeback-run.ts'
import { createCheckHarness } from './lib/check-harness.mjs'

// 判定规则只有一份：`scripts/lib/check-harness.mjs`。自写的那份曾把「超时」
// 当成失败判定，机器一忙就把正确的结果报成坏的；而且它同时是十几个套件里的
// 同一份副本。这里只保留调用，不再保留实现。
const results = []
const check = createCheckHarness({ results })

/** 一个 1×1 的 png，随便哪张都行——这里只关心字节流有没有原样落盘。 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 一段假的 mp4 字节；宿主只校验 MIME 前缀与体积，不解码。 */
const MP4 = `data:video/mp4;base64,${Buffer.from('not really an mp4, but bytes').toString('base64')}`

/** 一集的样例文档，格式与 oh-story 的产出一致。 */
const STORYBOARD = `# EP001 分镜

## 场景站位 · EP001-SC001 · 办公室
- 固定陈设：办公桌在房间中央

## SHOT-EP001-001 · 攥紧的茶杯

- 来源：EP001-SC001
- 时长：3s
- 输入参考图：无（文生视频）。

### 首帧提示词
> 输入参考图：无（这一行在引用块里，不该被当成字段）。

## SHOT-EP001-002 · 四个号

- 来源：EP001-SC001
- 时长：4s
- 输入参考图：无（文生视频）。

## 整集汇总
- 总时长 7s
`

function board (overrides = {}) {
  return {
    shots: [
      { id: 'SHOT-EP001-001', prompt: 'a', seconds: 3, nodeId: 'vid-1' },
      { id: 'SHOT-EP001-002', prompt: 'b', seconds: 4, nodeId: 'vid-2' },
    ],
    continuity: 'carry',
    ...overrides,
  }
}

function nodes (extra = []) {
  return [
    {
      id: 'vid-1', type: 'video', title: '第 1 镜视频', x: 0, y: 0, width: 100, height: 100,
      metadata: { video: { url: '/api/dsh-imagegen/video/file/a-1.mp4', mime: 'video/mp4' }, shot: { storyboardId: 'board-1', shotId: 'SHOT-EP001-001', index: 1 } },
    },
    {
      id: 'vid-2', type: 'video', title: '第 2 镜视频', x: 0, y: 0, width: 100, height: 100,
      metadata: { video: { url: '/api/dsh-imagegen/video/file/a-2.mp4', mime: 'video/mp4' }, shot: { storyboardId: 'board-1', shotId: 'SHOT-EP001-002', index: 2 } },
    },
    ...extra,
  ]
}

const SOURCE = { root: '/tmp/whatever', projectPath: '剧集/EP001', episode: 'EP001' }

// ---------------------------------------------------------------- 纯函数

await check('槽位从镜号派生，且只留 A-Z0-9-', () => {
  assert.equal(slotOfShot('SHOT-EP001-007'), 'EP001-007')
  assert.equal(slotOfShot('SHOT-X'), 'X')
})

await check('产出路径照上游契约：视频进 video/，图进 images/', () => {
  assert.equal(outputDirectoryOf('剧集/EP001', 'video'), '剧集/EP001/制作成果/video')
  assert.equal(outputDirectoryOf('剧集/EP001', 'image'), '剧集/EP001/制作成果/images')
  // 根目录就是那一集时不能拼出 `/制作成果`（那是绝对路径）。
  assert.equal(outputDirectoryOf('.', 'video'), '制作成果/video')
  assert.equal(outputFileOf({ shotId: 'SHOT-EP001-001', kind: 'video' }), 'SHOT-EP001-001.mp4')
  assert.equal(outputFileOf({ shotId: 'SHOT-EP001-001', kind: 'image' }), 'SHOT-EP001-001.png')
})

await check('参考图行照上游写法，路径前是中点不是斜杠', () => {
  const line = referenceLineOf([{
    slot: 'EP001-001', order: 1,
    path: '剧集/EP001/制作成果/images/SHOT-EP001-001.png',
    name: 'SHOT-EP001-001', purpose: '起始帧', control: '构图',
  }])
  // 先断言分隔符：写成 ` / ` 时上游解析器会把路径读成名称的一部分，而文档
  // 表面看着完全正常。断言顺序也有意义——它必须在这条用例里第一个说出
  // 「路径前必须是中点」，否则失败信息会被下面的整行比对盖掉。
  assert.ok(!line.includes(' / '), '路径前必须是中点 ·')
  assert.equal(line, 'REF-EP001-001（顺序：1）· 剧集/EP001/制作成果/images/SHOT-EP001-001.png《SHOT-EP001-001》（用途：起始帧；控制：构图）')
})

await check('一条参考图都没有时写「无（文生视频）。」', () => {
  assert.equal(referenceLineOf([]), '无（文生视频）。')
})

await check('改写只动镜头段内的字段行，不碰引用块里的同样字样', () => {
  const patched = patchStoryboardReferences(STORYBOARD, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· x.png《x》（用途：起始帧）']]))
  assert.equal(patched.changes.length, 1)
  assert.equal(patched.changes[0].shotId, 'SHOT-EP001-001')
  // 引用块里那行必须原样还在。
  assert.ok(patched.text.includes('> 输入参考图：无（这一行在引用块里，不该被当成字段）。'), '引用块里的行被改了')
  // 第二镜没在 updates 里，必须原样。
  assert.ok(patched.text.includes('## SHOT-EP001-002') && patched.text.split('无（文生视频）。').length === 2)
})

await check('别的二级标题段里的同名字段不会被当成镜头字段', () => {
  // 上面那条抓不到「没有按 `##` 切段」：那些引用块都在字段行之后。这里把
  // 一个同名字段放进**另一个二级标题**之下——不切段时它会顶替当前镜头的
  // 字段，把「整集汇总」里的东西改掉，而用户的分镜字段其实没动。
  const text = `## SHOT-EP001-001 · a

- 时长：3s

## 整集汇总

- 输入参考图：这是一句说明，不是字段。
`
  const patched = patchStoryboardReferences(text, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）']]))
  assert.equal(patched.changes.length, 0, '不该改动别的段落里的行')
  assert.ok(patched.text.includes('- 输入参考图：这是一句说明，不是字段。'))
  assert.deepEqual(patched.missing, ['SHOT-EP001-001'])
})

await check('字段行写在引用块之后也不会被抢走（按段落切）', () => {
  // 第一镜的字段行在引用块之前；第二镜的字段行前面是引用块。
  const text = `## SHOT-EP001-001 · a

### 首帧提示词
> 引用

- 输入参考图：无（文生视频）。

## SHOT-EP001-002 · b
- 输入参考图：无（文生视频）。
`
  const patched = patchStoryboardReferences(text, new Map([
    ['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）'],
    ['SHOT-EP001-002', 'REF-B（顺序：1）· b.png《b》（用途：起始帧）'],
  ]))
  assert.equal(patched.changes.length, 2)
  assert.ok(patched.text.includes('REF-A（顺序：1）· a.png《a》（用途：起始帧）'))
  assert.ok(patched.text.includes('REF-B（顺序：1）· b.png《b》（用途：起始帧）'))
})

await check('文档里没有这一行时报 missing，而不是替用户补一行', () => {
  const text = '## SHOT-EP001-001 · a\n\n- 时长：3s\n'
  const patched = patchStoryboardReferences(text, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）']]))
  assert.equal(patched.changes.length, 0)
  assert.deepEqual(patched.missing, ['SHOT-EP001-001'])
  assert.equal(patched.text, text, '没有改动就不该改文本')
})

await check('标题用共享的 shotHeadingOf：没有 `· 名称` 的裸标题也认', () => {
  // 回写与铺板读的是同一份文档格式。两边各自写正则时，一处认得的标题另一处
  // 不认得，症状是「板子上有这一镜，回写却报 missing」。
  const text = `## SHOT-EP001-001

- 输入参考图：无（文生视频）。
`
  const patched = patchStoryboardReferences(text, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）']]))
  assert.equal(patched.changes.length, 1)
  assert.deepEqual(patched.missing, [])
})

await check('标题连中点都没有时不算这一镜，报 missing 而不是改到别的行', () => {
  // `## SHOT-EP001-001 攥紧的茶杯`（空格分隔、没中点）不是一个合法标题：
  // 铺板那边也读不到它，所以回写也不该动它——两处认同一批标题。
  const text = `## SHOT-EP001-001 攥紧的茶杯

- 输入参考图：无（文生视频）。
`
  const patched = patchStoryboardReferences(text, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）']]))
  assert.equal(patched.changes.length, 0)
  assert.deepEqual(patched.missing, ['SHOT-EP001-001'])
  assert.equal(patched.text, text)
})

await check('CRLF 文档保持 CRLF，不产生整文件 diff', () => {
  const text = '## SHOT-EP001-001 · a\r\n\r\n- 输入参考图：无（文生视频）。\r\n'
  const patched = patchStoryboardReferences(text, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· a.png《a》（用途：起始帧）']]))
  assert.ok(patched.text.includes('\r\n'), 'CRLF 被丢掉了')
  assert.ok(!/[^\r]\n/.test(patched.text), '混进了裸 LF')
})

await check('内容没变时不报告改动', () => {
  const line = '无（文生视频）。'
  const patched = patchStoryboardReferences(STORYBOARD, new Map([['SHOT-EP001-001', line]]))
  assert.equal(patched.changes.length, 0)
})

await check('计划：片子按镜号命名，未跑完的进 skipped', () => {
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: false,
  })
  assert.deepEqual(plan.media.map(file => file.relativePath), [
    '剧集/EP001/制作成果/video/SHOT-EP001-001.mp4',
    '剧集/EP001/制作成果/video/SHOT-EP001-002.mp4',
  ])
  assert.equal(plan.frames.length, 0, '没勾选就不该抽帧')
  assert.equal(plan.skipped.length, 0)
})

await check('计划：没跑出片子的镜头进 skipped，不占文件名', () => {
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1',
    board: board({ shots: [{ id: 'SHOT-EP001-001', prompt: 'a', seconds: 3 }] }),
    nodes: [], useAsNextFrame: false,
  })
  assert.equal(plan.media.length, 0)
  assert.deepEqual(plan.skipped, [{ shotId: 'SHOT-EP001-001' }])
})

await check('计划：勾了起始帧才有抽帧，且写成 png 而不是 mp4', () => {
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: true,
  })
  assert.equal(plan.frames.length, 1, '最后一镜没有下一镜，不该抽帧')
  assert.equal(plan.frames[0].relativePath, '剧集/EP001/制作成果/images/SHOT-EP001-001.png')
  assert.equal(plan.frames[0].at, 'last')
  // 关键：REF- 不收 mp4，登记进去的必须是那张 png。
  const line = plan.referenceLines.get('SHOT-EP001-002')
  assert.ok(line.includes('SHOT-EP001-001.png'), '起始帧必须指向 png')
  assert.ok(!line.includes('.mp4'), '起始帧不能指向 mp4')
})

await check('计划：cut 板就算勾了也不改动别人那几行的参考图', () => {
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board({ continuity: 'cut' }), nodes: nodes(), useAsNextFrame: true,
  })
  assert.equal(plan.frames.length, 0)
  assert.equal(plan.referenceLines.size, 0, 'cut 板每镜独立，硬塞起始帧会改变创作意图')
})

await check('计划：设定板只收跑出图的，空位不写', () => {
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board({ shots: [] }),
    nodes: [
      { id: 'img-1', type: 'image', title: 'IMG-OFFICE-PLATE · 两处办公室场景板', x: 0, y: 0, width: 10, height: 10, metadata: { asset: { assetId: 'a'.repeat(64) + '.png', url: '/x', mime: 'image/png', width: 1, height: 1 }, status: 'success' } },
      { id: 'img-2', type: 'image', title: 'IMG-DESK-PROPS · 桌面道具板', x: 0, y: 0, width: 10, height: 10, metadata: { status: 'idle' } },
      { id: 'img-3', type: 'image', title: '随手画的一张', x: 0, y: 0, width: 10, height: 10, metadata: { status: 'idle' } },
    ],
    useAsNextFrame: false,
  })
  assert.deepEqual(plan.images.map(file => file.relativePath), ['剧集/EP001/制作成果/images/IMG-OFFICE-PLATE.png'])
})

// ---------------------------------------------------------------- 宿主写入

const roots = []
function makeRoot () {
  const root = mkdtempSync(join(tmpdir(), 'drama-write-'))
  roots.push(root)
  mkdirSync(join(root, '剧集', 'EP001'), { recursive: true })
  writeFileSync(join(root, '剧集', 'EP001', '分镜.md'), STORYBOARD, 'utf8')
  return root
}
function cleanup () {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

await check('写产出：落在制作成果下，字节原样', async () => {
  const root = makeRoot()
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP001/制作成果/video/SHOT-EP001-001.mp4',
    dataUrl: MP4,
  })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const written = readFileSync(join(root, '剧集/EP001/制作成果/video/SHOT-EP001-001.mp4'))
  assert.equal(written.toString(), 'not really an mp4, but bytes')
})

await check('写产出：拒绝写到制作成果之外', async () => {
  const root = makeRoot()
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP001/剧本.md',
    dataUrl: PNG,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'outside-project')
})

await check('写产出：拒绝别的剧集目录（不能借一集的空子写另一集）', async () => {
  const root = makeRoot()
  mkdirSync(join(root, '剧集', 'EP002'), { recursive: true })
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP002/制作成果/images/x.png',
    dataUrl: PNG,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'outside-project')
})

await check('写产出：拒绝 .. 逃逸', async () => {
  const root = makeRoot()
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP001/制作成果/../../../etc/passwd',
    dataUrl: PNG,
  })
  assert.equal(outcome.ok, false)
})

await check('写产出：扩展名与内容不一致时拒绝', async () => {
  const root = makeRoot()
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP001/制作成果/images/SHOT-EP001-001.png',
    dataUrl: MP4,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'bad-media')
})

await check('写产出：已存在时不覆盖，报 exists 而不是写坏', async () => {
  const root = makeRoot()
  const target = '剧集/EP001/制作成果/images/SHOT-EP001-001.png'
  const first = await writeDramaOutput({ root, projectPath: '剧集/EP001', relativePath: target, dataUrl: PNG })
  assert.equal(first.ok, true)
  const second = await writeDramaOutput({ root, projectPath: '剧集/EP001', relativePath: target, dataUrl: PNG })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'exists')
})

await check('写产出：明确要覆盖时先备份，旧字节还在', async () => {
  const root = makeRoot()
  const target = '剧集/EP001/制作成果/images/SHOT-EP001-001.png'
  await writeDramaOutput({ root, projectPath: '剧集/EP001', relativePath: target, dataUrl: PNG })
  const second = await writeDramaOutput({ root, projectPath: '剧集/EP001', relativePath: target, dataUrl: PNG, overwrite: true })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.overwrote, true)
  assert.ok(second.backup !== undefined && second.backup.includes('.bak-'), '覆盖前必须留备份')
  const backups = readdirSync(join(root, '剧集/EP001/制作成果/images')).filter(name => name.includes('.bak-'))
  assert.equal(backups.length, 1)
})

await check('写文档：内容没变时不写、不备份', async () => {
  const root = makeRoot()
  const outcome = await writeDramaDocument({ root, projectPath: '剧集/EP001', text: STORYBOARD })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, false)
  assert.equal(outcome.backup, '')
  const backups = readdirSync(join(root, '剧集/EP001')).filter(name => name.includes('.bak-'))
  assert.equal(backups.length, 0, '什么都没改，不该堆出备份')
})

await check('写文档：改了内容就写，原文件进备份', async () => {
  const root = makeRoot()
  const patched = patchStoryboardReferences(STORYBOARD, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· x.png《x》（用途：起始帧）']]))
  const outcome = await writeDramaDocument({ root, projectPath: '剧集/EP001', text: patched.text, expected: STORYBOARD })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(outcome.changed, true)
  assert.ok(readFileSync(join(root, '剧集/EP001', '分镜.md'), 'utf8').includes('REF-A（顺序：1）'))
  const backups = readdirSync(join(root, '剧集/EP001')).filter(name => name.includes('.bak-'))
  assert.equal(backups.length, 1)
  // 备份里是原文。
  assert.equal(readFileSync(join(root, '剧集/EP001', backups[0]), 'utf8'), STORYBOARD)
  // 回显给界面的必须是项目相对路径。`/var` → `/private/var` 这类符号链接
  // 一字之差就能让 `path.relative(字面 root, 真实路径)` 算出 `../../../..`，
  // 界面上一显示就像把文件写到了磁盘外面。
  assert.equal(outcome.backup, `剧集/EP001/${backups[0]}`, `备份回显应为项目相对路径，实际是 ${outcome.backup}`)
  assert.ok(!outcome.backup.includes('..'), '备份路径不该往回退')
})

await check('写文档：读完之后被别人改过就拒绝写（不覆盖刚写的内容）', async () => {
  const root = makeRoot()
  // 模拟 Agent 在回写过程中改了文档。
  writeFileSync(join(root, '剧集/EP001', '分镜.md'), `${STORYBOARD}\n## SHOT-EP001-003 · 新加的\n`, 'utf8')
  const patched = patchStoryboardReferences(STORYBOARD, new Map([['SHOT-EP001-001', 'REF-A（顺序：1）· x.png《x》（用途：起始帧）']]))
  const outcome = await writeDramaDocument({ root, projectPath: '剧集/EP001', text: patched.text, expected: STORYBOARD })
  assert.equal(outcome.ok, false)
  // 拒绝之后，别人写的内容必须还在。
  assert.ok(readFileSync(join(root, '剧集/EP001', '分镜.md'), 'utf8').includes('SHOT-EP001-003'))
})

await check('写文档：只认《分镜.md》，写不了别的创作文档', async () => {
  const root = makeRoot()
  // `projectPath` 里塞一个文件名，试图写到 剧本.md。
  const outcome = await writeDramaDocument({ root, projectPath: '剧集/EP001/../../..', text: 'evil' })
  assert.equal(outcome.ok, false)
})

await check('写产出：符号链接指到根目录之外时拒绝', async () => {
  const root = makeRoot()
  const outside = mkdtempSync(join(tmpdir(), 'drama-outside-'))
  roots.push(outside)
  // 制作成果 指向 /tmp 里的另一个目录。
  symlinkSync(outside, join(root, '剧集', 'EP001', '制作成果'))
  const outcome = await writeDramaOutput({
    root, projectPath: '剧集/EP001',
    relativePath: '剧集/EP001/制作成果/images/SHOT-EP001-001.png',
    dataUrl: PNG,
  })
  assert.equal(outcome.ok, false, '符号链接指到根目录之外必须拒绝')
})

// ---------------------------------------------------------------- 编排层

/**
 * 一个桩 API：只记下每次调用，把失败造出来。
 *
 * 之所以桩而不是连真路由：这一层要测的是「一个失败会不会带走整批」「文档
 * 是不是最后才写」这类顺序问题。真路由要起 HTTP 服务、要造 data URL 往返，
 * 反而把顺序掩盖在网络时序里。
 */
function stubApi (options = {}) {
  const writes = []
  const documents = []
  return {
    writes,
    documents,
    async dramaWriteFile (input) {
      writes.push(input)
      const fail = options.failOn?.(input.path)
      if (fail !== undefined) throw Object.assign(new Error(fail.message), { code: fail.code })
      return { relativePath: input.path, bytes: 12, overwrote: input.overwrite === true }
    },
    async dramaWriteDocument (input) {
      documents.push(input)
      if (options.failDocument !== undefined) throw new Error(options.failDocument)
      return { relativePath: '剧集/EP001/分镜.md', bytes: input.text.length, backup: '', changed: true }
    },
  }
}

/**
 * 把 `fetch` 换成「同源视频请求 → 一段字节」。
 *
 * WHY 要桩：片段住在视频库里、按 URL 引用，取字节走的是 `fetch` + `FileReader`。
 * Node 既没有相对 URL 的 base，也没有 `FileReader`。这两样在浏览器里都是现成
 * 的，桩掉它们不让用例失去意义——这一层要证明的是「按 URL 取到字节后写对了
 * 路径」，不是「浏览器能 fetch」。
 */
function stubClipFetch () {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => new Response(new Blob([String(url)], { type: 'video/mp4' }), { status: 200 })
  // Node 18+ 有 Blob 但没有 FileReader；补一个最小的，行为与浏览器一致。
  if (globalThis.FileReader === undefined) {
    globalThis.FileReader = class {
      constructor () { this.result = null; this.onload = null; this.onerror = null }
      readAsDataURL (blob) {
        blob.arrayBuffer().then(buffer => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
          this.onload?.()
        }).catch(error => this.onerror?.(error))
      }
    }
  }
  return () => { globalThis.fetch = realFetch }
}

/** 只把 fetch 换成桩，其余照常；失败时也要还原。 */
async function withClipFetch (name, fn) {
  const restore = stubClipFetch()
  try { await check(name, fn) } finally { restore() }
}

await withClipFetch('编排：逐条写，一条坏不带走其余', async () => {
  const api = stubApi({ failOn: path => path.includes('SHOT-EP001-001') ? { message: '磁盘满了', code: 'drama-write-failed' } : undefined })
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: false,
  })
  const report = await writebackDrama({ api, plan, nodes: nodes(), overwrite: false })
  assert.equal(report.files.length, 2)
  assert.equal(report.files.filter(file => file.ok).length, 1, '另一条必须照常写成')
  assert.equal(report.files.find(file => !file.ok).message, '磁盘满了')
})

await withClipFetch('编排：先写产出，最后才动文档', async () => {
  const api = stubApi()
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: true,
  })
  const report = await writebackDrama({
    api, plan, nodes: nodes(), storyboardText: STORYBOARD, overwrite: false,
  })
  assert.equal(report.files.filter(file => file.ok).length, 2, '产出要先落盘')
  assert.equal(api.documents.length, 1, '文档这一路只该有一次写')
  assert.ok(api.documents[0].text.includes('REF-EP001-001（顺序：1）'), '改写要进文档')
  // 抽帧在 Node 里必然失败（没有 DOM），要如实报成失败而不是静默丢掉。
  assert.equal(report.frames.length, 1)
  assert.equal(report.frames[0].ok, false)
})

await withClipFetch('编排：文档被别人改过时，整批产出照旧留下、文档不动', async () => {
  const api = stubApi({ failDocument: '文件在回写过程中被改过' })
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: true,
  })
  const report = await writebackDrama({
    api, plan, nodes: nodes(), storyboardText: STORYBOARD, overwrite: false,
  })
  assert.equal(report.files.filter(file => file.ok).length, 2)
  assert.equal(report.document, undefined, '文档没写成就不该报告成')
  // 失败要以一条「文件」形式出现在报告里，界面才能如实说出口。
  assert.ok(report.frames.some(entry => entry.relativePath === '分镜.md' && !entry.ok))
})

await withClipFetch('编排：不传文档原文就只写产出、不碰文档', async () => {
  // 关键前提：这份计划**本来要改文档**（勾了起始帧，`referenceLines` 非空）。
  // 否则这条用例恒绿——一条永远不会被调用的路径，不传原文当然也不会写。
  const api = stubApi()
  const plan = planDramaWriteback({
    source: SOURCE, boardId: 'board-1', board: board(), nodes: nodes(), useAsNextFrame: true,
  })
  assert.ok(plan.referenceLines.size > 0, '这条用例要求计划里本来就有要改的行')
  await writebackDrama({ api, plan, nodes: nodes(), overwrite: false })
  assert.equal(api.documents.length, 0, '没给原文就不能改文档')
})

cleanup()
console.log(results.join('\n'))
console.log(`\n${results.filter(row => row.startsWith('PASS')).length}/${results.length} PASS`)

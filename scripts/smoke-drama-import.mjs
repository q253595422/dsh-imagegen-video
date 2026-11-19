/**
 * 「读短剧文档 → 铺成画布节点」的编排层用例。
 *
 * WHY 与 storyboard-markdown 那组分开放：那组只测纯函数（文档解析、节点几何），
 * 输入是字符串，输出是纯数据。这一组测的是**接线**：宿主返回什么形状、参考图
 * 怎么变成 cast、一张图坏了会不会把整次铺板带塌。三件事的唯一证据是「喂一个
 * 桩 API，看它落了什么节点」——几何与解析在那边已经测过了。
 *
 * 不碰磁盘、不碰网络：`readDrama` 与 `placeDrama` 只认 `ImageGenApi`，桩一个就够。
 *
 * Run: node scripts/smoke-drama-import.mjs   (from the package root, no build)
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDrama, placeDrama } from '../src/client/drama-import.ts'

const results = []
function check (name, fn) {
  try {
    fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** 异步用例的版本：失败同样记进 results，不中断后面的用例。 */
async function checkAsync (name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// --------------------------------------------------------------- fixtures

const STORYBOARD = `# EP001 分镜

## SHOT-EP001-001 · 攥紧的茶杯

- 时长：3s
- 输入参考图：无（文生视频）。

### 首帧提示词
> close-up of a hand.

## SHOT-EP001-002 · 两个人

- 时长：4s
- 输入参考图：REF-A1（顺序：1）· 剧集/EP001/制作成果/首帧.png《周薄森定妆》（用途：外貌；控制：脸型）；REF-B2（顺序：2）· 剧集/EP001/输入/走廊.png《走廊》（用途：空间布局；控制：门窗方位）。

### 首帧提示词
> two people in an office.

## SHOT-EP001-003 · 还是他

- 时长：2s
- 输入参考图：REF-A1（顺序：1）· 剧集/EP001/制作成果/首帧.png《周薄森定妆》（用途：外貌；控制：脸型）。

### 首帧提示词
> the same man again.
`

const MOTIONS = `# EP001 视频提示词

## MOTION-EP001-001 · 攥紧的茶杯

- 分镜：SHOT-EP001-001
- 时长：3s
- 生成方式：文生视频

### 可复制提示词
> A hand tightens on the cup.
`

const IMAGES = `# EP001 图片提示词

## IMG-PROPS · 桌面道具板

- 用途：定好桌面道具。

### 可复制提示词
> Prop sheet.
`

/** 一份宿主会返回的读取结果。 */
function projectOf (overrides = {}) {
  return {
    projectPath: '剧集/EP001',
    episode: 'EP001',
    documents: [
      { key: 'storyboard', fileName: '分镜.md', relativePath: '剧集/EP001/分镜.md', text: STORYBOARD, bytes: STORYBOARD.length },
      { key: 'imagePrompts', fileName: '图片提示词.md', relativePath: '剧集/EP001/图片提示词.md', text: IMAGES, bytes: IMAGES.length },
      { key: 'motionPrompts', fileName: '视频提示词.md', relativePath: '剧集/EP001/视频提示词.md', text: MOTIONS, bytes: MOTIONS.length },
    ],
    images: [
      { relativePath: '剧集/EP001/制作成果/首帧.png', bytes: 100 },
      { relativePath: '剧集/EP001/输入/走廊.png', bytes: 200 },
    ],
    notes: [],
    ...overrides,
  }
}

/**
 * 一个只在内存里工作的 API 桩。
 *
 * 每个方法都记调用次数，因为有几条用例真正要问的是「这件事**没有**发生」：
 * 同一张图被两镜引用时不该上传两次，一张图坏掉时不该把整批停掉。
 */
function stubApi (options = {}) {
  const calls = { dramaProject: 0, dramaImage: [], canvasUpload: [] }
  const api = {
    async dramaProject (root, projectPath) {
      calls.dramaProject += 1
      calls.root = root
      calls.projectPath = projectPath
      return options.project ?? projectOf()
    },
    async dramaImage (root, path) {
      calls.dramaImage.push(path)
      const failure = options.failImages?.find(entry => entry === path)
      if (failure !== undefined) throw new Error('读不到这张图')
      // 1x1 PNG：只要 data URL 形状对，尺寸靠 imageSizeOf 解码读到。
      return { dataUrl: TINY_PNG, name: path.slice(path.lastIndexOf('/') + 1), bytes: 100 }
    },
    async canvasUpload (dataUrl, width, height, meta) {
      calls.canvasUpload.push({ dataUrl, width, height, meta })
      return { assetId: `asset-${calls.canvasUpload.length}`, url: `/asset/${calls.canvasUpload.length}`, mime: 'image/png', bytes: 100, width, height, origin: 'upload' }
    },
  }
  return { api, calls }
}

/** 一张真的 2x2 PNG（浏览器/Node 都能解码），用来量尺寸。 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACZgbYnAAAAF0lEQVR42mP8z8AARAwMjDAGAAA4AgH/9wObAAAAAElFTkSuQmCC'

/**
 * 浏览器的量尺寸那一步，在 Node 里用固定值替代。
 *
 * 真实实现要走 `new Image()` 解码；这里关心的不是那两个数字，而是「量完之后
 * 有没有把节点建出来」——所以固定成一个可辨认的尺寸，顺带能断言节点是按它
 * 摆的。
 */
const MEASURE = async () => ({ width: 400, height: 600 })

/** 单调递增的 id 发生器，与画布里的 `newId` 同形。 */
function ids () {
  let serial = 0
  return kind => `${kind}-${++serial}`
}

// ---------------------------------------------------------------- reading

await checkAsync('the read layer joins all three documents', async () => {
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  assert.equal(imported.plan.shots.length, 3)
  // 有《视频提示词.md》时用它，没有的那两镜退回首帧。
  assert.equal(imported.plan.shots[0].promptFrom, 'motion')
  assert.equal(imported.plan.shots[1].promptFrom, 'firstFrame')
  assert.equal(imported.plan.imagePrompts.length, 1)
})

await checkAsync('a reference the project does not have is named, not dropped', async () => {
  // 这是最需要说出口的一类：铺板照常完成，但那一镜的参考其实没生效；
  // 用户会以为已经带上了。
  const { api } = stubApi({
    project: projectOf({ images: [{ relativePath: '剧集/EP001/制作成果/首帧.png', bytes: 100 }] }),
  })
  const imported = await readDrama(api, { root: '/workspace' })
  assert.equal(imported.missingReferences.length, 1)
  assert.match(imported.missingReferences[0], /SHOT-EP001-002/)
  assert.match(imported.missingReferences[0], /走廊\.png/)
  // 说明也要跟着走，否则界面上没东西可显示。
  assert.ok(imported.notes.some(line => /走廊\.png/.test(line)))
})

await checkAsync('a missing motion document is stated, not silently downgraded', async () => {
  // 没有《视频提示词.md》时板子照样铺，但每一镜都在用静帧描述——这件事
  // 不写出来，用户要等成片才发现镜头几乎不动。
  const project = projectOf()
  project.documents = project.documents.filter(document => document.key !== 'motionPrompts')
  const { api } = stubApi({ project })
  const imported = await readDrama(api, { root: '/workspace' })
  assert.ok(imported.notes.some(line => /视频提示词/.test(line)))
  assert.ok(imported.plan.shots.every(shot => shot.promptFrom !== 'motion'))
})

await checkAsync('the read layer passes the workspace root straight through', async () => {
  const { api, calls } = stubApi()
  await readDrama(api, { root: '/some/workspace', projectPath: '剧集/EP002' })
  assert.equal(calls.root, '/some/workspace')
  assert.equal(calls.projectPath, '剧集/EP002')
})

// --------------------------------------------------------------- placing

await checkAsync('every board node and edge lands, and its ids are the document ones', async () => {
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids(), measure: MEASURE })
  assert.equal(placed.boardNode.type, 'storyboard')
  assert.deepEqual(
    placed.boardNode.metadata.storyboard.shots.map(shot => shot.id),
    ['SHOT-EP001-001', 'SHOT-EP001-002', 'SHOT-EP001-003'],
  )
  assert.equal(placed.imageNodes.length, 1)
  // 设定板连到分镜板：`from` 是上游。
  assert.ok(placed.connections.every(edge => edge.toNodeId === placed.boardNode.id))
})

await checkAsync('a reference becomes a pinned cast node named after the document', async () => {
  // cast 的 name 会原样出现在提示词里，所以它必须是文档里的《名称》，
  // 不是文件名（`首帧.png`）。
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids(), measure: MEASURE })
  const names = placed.castNodes.map(node => node.metadata.cast.name).sort()
  assert.deepEqual(names, ['周薄森定妆', '走廊'])
  assert.ok(placed.castNodes.every(node => node.metadata.cast.role === 'character'))
  // 钉住的前提是有资产：没有 url 的节点会被 castMembers 排除，等于没钉。
  assert.ok(placed.castNodes.every(node => (node.metadata.asset?.url ?? '') !== ''))
})

await checkAsync('a reference used by two shots is imported exactly once', async () => {
  // SHOT-001-002 与 -003 引用同一张脸。导两次会在画布上留下两张重复的
  // 参考图，而它们的 cast 名一样——用户分不出哪张该删。
  const { api, calls } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids(), measure: MEASURE })
  assert.equal(placed.castNodes.length, 2)
  assert.equal(calls.dramaImage.filter(path => /首帧\.png$/.test(path)).length, 1)
  assert.equal(calls.canvasUpload.length, 2)
})

await checkAsync('one broken reference does not take the board with it', async () => {
  // 一张图读不出来时，其余镜头仍然可用；失败的那张必须被点名。
  const { api } = stubApi({ failImages: ['剧集/EP001/输入/走廊.png'] })
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids(), measure: MEASURE })
  assert.equal(placed.boardNode.type, 'storyboard')
  assert.equal(placed.castNodes.length, 1)
  assert.equal(placed.skippedImages.length, 1)
  assert.match(placed.skippedImages[0].relativePath, /走廊\.png/)
  assert.ok(placed.warnings.some(line => /参考图没有导入成功/.test(line)))
})

await checkAsync('reference nodes are placed clear of the board and the plates', async () => {
  // 参考图压在分镜板上，用户第一眼看到的是「两块东西叠在一起」。位置由
  // 编排层决定，所以这里钉住它。
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 100, y: 200 }, newId: ids(), measure: MEASURE })
  const boardBottom = placed.boardNode.y + placed.boardNode.height
  assert.ok(placed.castNodes.every(node => node.y >= boardBottom), 'cast nodes must sit below the board')
  // 彼此不重叠。
  const xs = placed.castNodes.map(node => node.x).sort((left, right) => left - right)
  for (let index = 1; index < xs.length; index += 1) assert.ok(xs[index] > xs[index - 1], 'cast nodes must not stack on one x')
})

await checkAsync('a 3s shot stays 3s through the whole placement', async () => {
  // 端到端守一条：铺板不改文档的剪辑节奏。
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids(), measure: MEASURE })
  assert.deepEqual(placed.boardNode.metadata.storyboard.shots.map(shot => shot.seconds), [3, 4, 2])
})

await checkAsync('a reference still lands when the image size cannot be measured', async () => {
  // 宽高只影响节点多大；量不出来（解码失败 / 不在浏览器里）就丢掉这张图，
  // 等于钉住的参考少一张。这里不注入 measure，跑的就是默认那条：Node 里没有
  // `Image`，宽度只能是兜底值。
  const { api } = stubApi()
  const imported = await readDrama(api, { root: '/workspace' })
  const placed = await placeDrama({ api, root: '/workspace', imported, at: { x: 0, y: 0 }, newId: ids() })
  assert.equal(placed.castNodes.length, 2)
  assert.ok(placed.castNodes.every(node => node.width > 0 && node.height > 0))
})

/**
 * 目录入口的**真磁盘**用例。
 *
 * 上面所有用例都喂桩 API——测的是接线。这一条不同：它把用户会选的三种目录
 * （项目根 / `剧集/` / 某一集本身）真的喂给宿主的 `readDramaProject`，因为
 * 「选哪一层都能读到」不是接线问题，是路径拼接问题，桩永远测不出来。
 *
 * 曾经的缺陷：`findEpisodeDirectory` 返回「剧集目录 + 集名」两半，调用方又
 * 拼一次，用户直接选 `剧集/EP001` 时路径成了 `EP001/EP001/分镜.md`——三份
 * 文档全部读到 0 字节，界面只说「没找到」。而这个入口正是卡片的文案承诺的
 * （「或者直接选某一集」）。
 */
const dramaRoot = mkdtempSync(join(tmpdir(), 'gal-drama-entry-'))
const episodeDir = join(dramaRoot, '让你管账号', '剧集', 'EP001')
mkdirSync(episodeDir, { recursive: true })
writeFileSync(join(episodeDir, '分镜.md'), '## SHOT-EP001-001 · 3s\n\n### 首帧提示词\n\n> 一个人走进房间\n')
writeFileSync(join(episodeDir, '图片提示词.md'), '## REF-A1 · 林默\n')
writeFileSync(join(episodeDir, '视频提示词.md'), '## MOTION-EP001-001\n')
const { readDramaProject } = await import('../src/drama-project.ts')

for (const [label, root, requested] of [
  ['项目根', join(dramaRoot, '让你管账号'), undefined],
  ['剧集目录', join(dramaRoot, '让你管账号', '剧集'), undefined],
  ['某一集本身', join(dramaRoot, '让你管账号', '剧集', 'EP001'), undefined],
  ['相对 projectPath', join(dramaRoot, '让你管账号'), '剧集/EP001'],
]) {
  await checkAsync(`a drama reads from the ${label}, with real bytes`, async () => {
    const project = await readDramaProject(root, requested)
    assert.ok(project !== undefined, `${label}: 应当找到这一集`)
    // 关键断言：不是「找到了目录」，而是**文档真的读到了内容**。拼接错一层
    // 时目录照样找得到，只有 bytes 全是 0。
    const storyboard = project.documents.find(document => document.key === 'storyboard')
    assert.ok((storyboard?.bytes ?? 0) > 0, `${label}: 分镜.md 读成了空文件（projectPath=${project.projectPath}）`)
    assert.ok((storyboard?.text ?? '').includes('SHOT-EP001-001'))
    assert.equal(project.episode, 'EP001')
  })
}
rmSync(dramaRoot, { recursive: true, force: true })

console.log(results.join('\n'))

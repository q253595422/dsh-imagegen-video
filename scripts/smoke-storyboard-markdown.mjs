/**
 * 短剧文档 → 画布分镜的解析与铺板，全部是纯函数。
 *
 * WHY 单独一组：这套规则唯一的输入是**别人的文档格式**，唯一的输出是一块
 * 分镜板。它的失败模式与「板子状态」「写作规范」「体检」都不同：格式读歪
 * 了不会报错，只会铺出一块看起来正常、实则错位的板子——用户要到生成之后
 * 才发现第几镜的提示词其实是上一镜的。所以这里的用例盯的都是「静默读错」。
 *
 * 不读磁盘上的用户文档（那是用户数据），用的是本文件自带的两份最小样例，
 * 结构与 oh-story 的 `剧集/EP001/*.md` 一致，包括全角冒号、中点与中文分号。
 *
 * Run: node scripts/smoke-storyboard-markdown.mjs   (from the package root, no build)
 */

import assert from 'node:assert/strict'
import {
  castEntriesOf,
  castNamesOf,
  parseImagePromptsMarkdown,
  parseMotionPromptsMarkdown,
  parseStoryboardMarkdown,
  referenceEntriesOf,
  secondsOf,
  shotPromptOf,
} from '../src/client/storyboard-markdown.ts'
import { layoutNodes, layoutSummary, planCanvasLayout } from '../src/client/storyboard-layout.ts'

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

// --------------------------------------------------------------- fixtures

const STORYBOARD = `# EP001 分镜

## 场景站位 · EP001-SC001 · 副团长办公室
- 固定陈设：办公桌在房间中央

## SHOT-EP001-001 · 攥紧的茶杯

- 来源：EP001-SC001
- 时长：3s
- 目的：第一帧就是压力。
- 景别/机位：手与茶杯大特写。
- 运镜：固定。
- 起点：右手攥着茶杯。
- 动作：手又攥紧一分。
- 终点：指节攥到发白。
- 图片提示词项：IMG-ZHOUBOSEN-SHEET《周薄森角色板》（控制：手型）；IMG-DESK-PROPS《桌面道具板》（控制：茶杯外观）。
- 输入参考图：无（文生视频）。
- 出场设定：《视觉设定.md》·人物「周薄森」（控制：手型）；地点「副团长办公室」（控制：玻璃桌面）。
- 声音：一句带笑的挖苦。

### 首帧提示词
> extreme close-up of a heavy hand on a glass tumbler.

## SHOT-EP001-002 · 四个号

- 来源：EP001-SC001
- 时长：4s
- 目的：交代谁在挨笑。
- 景别/机位：竖屏双人中景。
- 运镜：缓推。
- 起点：周薄森坐得笔直。
- 动作：下颌收紧。
- 终点：停在绷紧的脸。
- 输入参考图：REF-A1（顺序：1）· 剧集/EP001/制作成果/首帧.png《首帧》（用途：外貌；控制：脸型、体态；不得控制：构图）。
- 出场设定：《视觉设定.md》·人物「江晨」（控制：外貌）；人物「周薄森」（控制：外貌）；画外：道具「茶杯」（控制：外观）。
- 声音：无对白。

### 首帧提示词
> two-person medium shot in an office.

### 尾帧提示词
> the same man's tight face lit by the screen.
`

const IMAGES = `# EP001 图片提示词

## IMG-ZHOUBOSEN-SHEET · 周薄森角色板

- 用途：定好中年上司的五官体态。
- 参考：无外部参考。

### 可复制提示词
> Full-body character sheet of a forty-five-year-old man.

## IMG-DESK-PROPS · 桌面道具板

- 用途：定好桌面道具。
- 参考：无外部参考。

### 可复制提示词
> Prop sheet of two objects on a plain surface.
`

const MOTIONS = `# EP001 视频提示词

## MOTION-EP001-001 · 攥紧的茶杯

- 分镜：SHOT-EP001-001
- 时长：3s
- 生成方式：文生视频
- 输入参考图：无（文生视频）。

### 可复制提示词
> A heavy hand grips a glass tumbler. As the laughter starts, the knuckles tighten. The camera does not move.
`

// ---------------------------------------------------------------- parsing

check('a shot heading is read with its id and name', () => {
  const parsed = parseStoryboardMarkdown(STORYBOARD)
  assert.equal(parsed.shots.length, 2)
  assert.equal(parsed.shots[0].shotId, 'SHOT-EP001-001')
  assert.equal(parsed.shots[0].name, '攥紧的茶杯')
})

check('场景站位 headings never become shots', () => {
  // 每条 `## ` 都当成镜头，是这份文档最容易踩的坑：它会让板子上多出一条
  // 空行，而空行在界面上和「用户还没写」长得一模一样。
  const parsed = parseStoryboardMarkdown(STORYBOARD)
  assert.ok(parsed.shots.every(shot => shot.shotId.startsWith('SHOT-')))
})

check('a shot keeps the seconds the document wrote', () => {
  // 3s 不在选择器的合法值里。改成 4s 会悄悄改掉剪辑节奏，所以必须原样留住。
  const parsed = parseStoryboardMarkdown(STORYBOARD)
  assert.equal(parsed.shots[0].seconds, 3)
  assert.equal(parsed.shots[1].seconds, 4)
})

check('field lines need the full-width colon', () => {
  // 半角冒号的文档本来就不合规范；宽松匹配会读出一堆半截值。
  assert.equal(secondsOf('3s'), 3)
  assert.equal(secondsOf('3 秒'), 3)
  const parsed = parseStoryboardMarkdown('## SHOT-A-1 · x\n\n- 时长: 9s\n')
  assert.equal(parsed.shots[0].seconds, 0)
})

check('the first-frame block is read as the quoted paragraph', () => {
  const parsed = parseStoryboardMarkdown(STORYBOARD)
  assert.equal(parsed.shots[0].firstFrame, 'extreme close-up of a heavy hand on a glass tumbler.')
  assert.equal(parsed.shots[1].lastFrame, "the same man's tight face lit by the screen.")
})

check('a trailing field after the quote block is not swallowed into it', () => {
  // 规范要求小节内只放引用块。真出现字段行时，它属于下一个镜头，不能并进
  // 这一镜的提示词——并进去提示词会带着「- 时长：3s」发给模型。
  const parsed = parseStoryboardMarkdown(
    '## SHOT-A-1 · x\n\n- 时长：3s\n\n### 首帧提示词\n> shot one.\n\n- 时长：4s\n\n## SHOT-A-2 · y\n\n- 时长：5s\n',
  )
  assert.equal(parsed.shots[0].firstFrame, 'shot one.')
  assert.equal(parsed.shots.length, 2)
})

check('出场设定 keeps 人物 and 造型, drops 地点 and 道具', () => {
  // 把「副团长办公室」钉成 cast，会让每一镜都带一张办公室当人物参考。
  const entries = castEntriesOf('《视觉设定.md》·人物「江晨」（控制：外貌）；地点「办公室」（控制：窗光）；道具「茶杯」（控制：外观）')
  assert.deepEqual(entries.map(entry => entry.kind), ['人物', '地点', '道具'])
  const shot = parseStoryboardMarkdown(STORYBOARD).shots[1]
  assert.deepEqual(castNamesOf(shot), ['江晨', '周薄森'])
})

check('a 画外 entry is named but not anchored', () => {
  const entries = castEntriesOf('《视觉设定.md》·人物「江晨」（控制：外貌）；画外：道具「茶杯」（控制：外观）')
  assert.equal(entries.find(entry => entry.name === '茶杯').offscreen, true)
  assert.equal(entries.find(entry => entry.name === '江晨').offscreen, false)
})

check('输入参考图 is split on the slot prefix, not on every semicolon', () => {
  // 项内的 `；` 分隔用途/控制，项间的 `；` 分隔图位。按分号切会把一张图
  // 切成三张，而每张都有一个 `REF-` 之外的空槽。
  const entries = referenceEntriesOf(
    'REF-A1（顺序：1）· 剧集/EP001/制作成果/首帧.png《首帧》（用途：外貌；控制：脸型、体态；不得控制：构图）；REF-B2（顺序：2）· 输入/参考图/走廊.png《走廊》（用途：空间布局；控制：门窗方位）',
  )
  assert.equal(entries.length, 2)
  assert.equal(entries[0].slot, 'REF-A1')
  assert.equal(entries[0].path, '剧集/EP001/制作成果/首帧.png')
  assert.equal(entries[0].name, '首帧')
  assert.equal(entries[0].purpose, '外貌')
  assert.equal(entries[0].control, '脸型、体态')
  assert.equal(entries[0].notControl, '构图')
  assert.equal(entries[1].order, 2)
})

check('无（文生视频） yields no reference slots', () => {
  for (const text of ['无（文生视频）。', '无', '无（待补参考图：许棠定妆）']) {
    assert.deepEqual(referenceEntriesOf(text), [])
  }
})

check('a PLAN slot is kept but does not pretend to have a path', () => {
  const entries = referenceEntriesOf('PLAN-SHOT-EP001-002（顺序：1）· IMG-ZHOUBOSEN-SHEET《周薄森角色板》（用途：起始帧）')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].slot, 'PLAN-SHOT-EP001-002')
})

check('图片提示词 and 视频提示词 are read by their own headings', () => {
  const images = parseImagePromptsMarkdown(IMAGES)
  assert.equal(images.items.length, 2)
  assert.equal(images.items[0].imageId, 'IMG-ZHOUBOSEN-SHEET')
  assert.match(images.items[0].prompt, /Full-body character sheet/)
  const motions = parseMotionPromptsMarkdown(MOTIONS)
  assert.equal(motions.items.length, 1)
  assert.equal(motions.items[0].shotId, 'SHOT-EP001-001')
  assert.equal(motions.items[0].mode, '文生视频')
})

// ------------------------------------------------------------- prompt pick

check('the video prompt wins over the first-frame still', () => {
  // 首帧提示词描述一张静图。拿它生视频，得到的是一个几乎不动的镜头，
  // 而用户完全看不出哪里配错了——所以这条必须由解析器自己保证。
  const shot = parseStoryboardMarkdown(STORYBOARD).shots[0]
  const motion = parseMotionPromptsMarkdown(MOTIONS).items[0]
  const chosen = shotPromptOf(shot, motion)
  assert.equal(chosen.from, 'motion')
  assert.match(chosen.prompt, /knuckles tighten/)
})

check('without a video prompt the first frame is used and labelled', () => {
  const shot = parseStoryboardMarkdown(STORYBOARD).shots[1]
  const chosen = shotPromptOf(shot, undefined)
  assert.equal(chosen.from, 'firstFrame')
  assert.match(chosen.prompt, /two-person medium shot/)
})

check('a shot with no prompt at all is reported, not faked', () => {
  const shot = parseStoryboardMarkdown('## SHOT-A-1 · x\n\n- 时长：5s\n').shots[0]
  assert.equal(shotPromptOf(shot, undefined).from, 'none')
})

// ----------------------------------------------------------------- layout

const PLAN_INPUT = {
  storyboard: parseStoryboardMarkdown(STORYBOARD),
  motions: parseMotionPromptsMarkdown(MOTIONS).items,
  images: parseImagePromptsMarkdown(IMAGES).items,
}

check('the board keeps document ids and never invents new ones', () => {
  // 同一份文档铺两次必须得到同样的 id，否则用户的片段对不回原来的镜头。
  const plan = planCanvasLayout(PLAN_INPUT)
  assert.deepEqual(plan.board.shots.map(shot => shot.id), ['SHOT-EP001-001', 'SHOT-EP001-002'])
})

check('a duplicate shot id keeps the first and says so', () => {
  const parsed = parseStoryboardMarkdown(
    '## SHOT-A-1 · first\n\n- 时长：5s\n\n### 首帧提示词\n> one.\n\n## SHOT-A-1 · second\n\n- 时长：5s\n\n### 首帧提示词\n> two.\n',
  )
  const plan = planCanvasLayout({ storyboard: parsed })
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].name, 'first')
  assert.ok(plan.warnings.some(line => /重复/.test(line)))
})

check('past the shot cap the rest is reported, never silently dropped', () => {
  const body = Array.from({ length: 45 }, (_, index) => {
    const id = String(index + 1).padStart(3, '0')
    return `## SHOT-A-${id} · s${index}\n\n- 时长：5s\n\n### 首帧提示词\n> shot ${index}.\n`
  }).join('\n')
  const plan = planCanvasLayout({ storyboard: parseStoryboardMarkdown(body) })
  assert.equal(plan.shots.length, 40)
  assert.ok(plan.warnings.some(line => /45/.test(line) && /40/.test(line)))
})

check('a zero-second shot falls back to a legal value instead of bricking the save', () => {
  // `isShot` 要求秒数 > 0；铺一条 0 秒的镜头进文档，整份画布会存不下来。
  const plan = planCanvasLayout({ storyboard: parseStoryboardMarkdown('## SHOT-A-1 · x\n\n### 首帧提示词\n> one.\n') })
  assert.ok(plan.board.shots[0].seconds > 0)
  assert.ok(plan.shots[0].notes.some(line => /时长/.test(line)))
})

check('a 3s document shot stays 3s and the note names the nearest picker value', () => {
  const plan = planCanvasLayout(PLAN_INPUT)
  assert.equal(plan.board.shots[0].seconds, 3)
  assert.ok(plan.shots[0].notes.some(line => /3s/.test(line) && /4s/.test(line)))
})

check('stacking keeps the board and puts the image plates below it', () => {
  let serial = 0
  const nodes = layoutNodes({ plan: planCanvasLayout(PLAN_INPUT), at: { x: 100, y: 200 }, newId: kind => `${kind}-${++serial}` })
  assert.equal(nodes.boardNode.type, 'storyboard')
  assert.equal(nodes.boardNode.x, 100)
  assert.equal(nodes.imageNodes.length, 2)
  assert.ok(nodes.imageNodes.every(node => node.y > nodes.boardNode.y))
  // 连线从设定板指向分镜板：`from` 是上游。
  assert.ok(nodes.connections.every(edge => edge.toNodeId === nodes.boardNode.id))
})

check('an image plate carries its prompt and spends nothing', () => {
  // 铺板只是把提示词放进节点；跑图要用户自己点。铺一次板不该产生费用。
  const nodes = layoutNodes({ plan: planCanvasLayout(PLAN_INPUT), at: { x: 0, y: 0 }, newId: kind => `${kind}-${Math.random()}` })
  assert.match(nodes.imageNodes[0].metadata.prompt, /Full-body character sheet/)
  assert.equal(nodes.imageNodes[0].metadata.status, 'idle')
})

check('the summary names what would be wrong downstream', () => {
  // 这两句是用户唯一会读到的解释：一镜用静帧描述、身份还没钉。
  const plan = planCanvasLayout(PLAN_INPUT)
  const lines = layoutSummary(plan)
  assert.ok(lines.some(line => /成片提示词/.test(line)))
  assert.ok(lines.some(line => /静帧/.test(line)))
  assert.ok(lines.some(line => /周薄森/.test(line)))
})

check('an empty document reports the format mismatch instead of an empty board', () => {
  const parsed = parseStoryboardMarkdown('# 随便什么\n\n没有镜头。\n')
  assert.equal(parsed.shots.length, 0)
  assert.ok(parsed.warnings.some(line => /SHOT-/.test(line)))
})

console.log(results.join('\n'))

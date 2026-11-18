/**
 * Real-browser guards for the three cross-module UI contracts:
 *
 *  1. GooeyNav follows the host theme at RUNTIME (not just at mount).
 *  2. The annotation marker is ONE color in both places it is drawn — the CSS
 *     boxes the user sees and the Canvas2D marker burnt into the image the
 *     model receives.
 *  3. Stacking order is one ordered scale, with no two unrelated layers on the
 *     same number.
 *
 * WHY a real browser: all three are decided by the CSS cascade and computed
 * values. jsdom has no layout engine and resolves no custom properties, so a
 * jsdom check here would assert the source text rather than the behaviour —
 * which is how the GooeyNav theme bug survived: the code looked right.
 *
 * WHY not a pure source-text check: (1) and (2) are about what the browser
 * COMPUTES, and a source grep cannot tell a token that resolves from one that
 * silently falls back. (3) is genuinely a source invariant, so it is checked
 * from the source (a browser cannot see "these two numbers came from unrelated
 * decisions").
 *
 * Run: node scripts/verify-ui-contracts.mjs
 * Skips loudly (exit 0) when no headless Chromium is available, like the other
 * browser guards here — a missing tool is not a failing contract.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { readSourceText } from './lib/source-text.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canvasSourceText, readModuleSource } from './lib/canvas-source.mjs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { findChrome, launchChrome, openPage, skipWithoutChrome } from './lib/headless-chrome.mjs'
import { WCAG_CONTRAST_SOURCE } from './lib/wcag-contrast.mjs'

const CHROME = findChrome()

// ------------------------------------------------- 0. one way to start a browser
// Every browser guard must read the DevTools port the browser PUBLISHED, never
// guess one. A guessed port is indistinguishable from a correct one until two
// runs overlap: the loser either finds no listener or — worse — is answered by
// the other run's browser and asserts against a blank page, which reports as an
// unrelated contract going green or an opaque "CDP down".
//
// This is a source invariant, and it is checked BEFORE the tool gate on purpose:
// it needs no browser, so a machine without Chromium still enforces it.
const SCRIPT_DIR = new URL('.', import.meta.url)
// Three files are not browser guards and must not be read as one: the launcher
// itself (it is where the published-port form lives), this guard (it carries the
// pattern below) and the negative-verification harness (it carries the DEFECTIVE
// literal as a mutation payload). Scanning any of them would make this check fail
// on a clean tree.
const NOT_A_GUARD = new Set(['headless-chrome.mjs', 'verify-negative.mjs', 'verify-ui-contracts.mjs'])
const launcherUsers = readdirSync(SCRIPT_DIR).filter(name => name.endsWith('.mjs') && !NOT_A_GUARD.has(name))
// Built by concatenation so this pattern cannot match its own source text: a
// literal here would be the first thing the scan reports.
const PORT_FLAG = `--remote-debugging-${'port'}=`
const guessedPorts = []
for (const name of launcherUsers) {
  const source = readSourceText(new URL(name, SCRIPT_DIR))
  // `=0` means "publish the port"; anything else is a guess. Written out rather
  // than pattern-matched so the offending value stays visible in the report.
  const guess = new RegExp(`${PORT_FLAG}(?!0\\b)([^\\s'"\`]+)`).exec(source)
  if (guess !== null) guessedPorts.push(`${name}: ${PORT_FLAG}${guess[1]}`)
}
if (guessedPorts.length > 0) {
  console.error('\nFAIL: a browser guard hand-picks its DevTools port.')
  console.error(guessedPorts.map(entry => `  ${entry}`).join('\n'))
  console.error('Concurrent runs then read each other\'s browser (or find none), and')
  console.error('the failure shows up as an unrelated contract, not as this one.')
  console.error('Use launchChrome() from scripts/lib/headless-chrome.mjs instead.')
  process.exit(1)
}
console.log(`DevTools port: ${launcherUsers.length} scripts scanned, none guesses one`)

// ------------------------------------------- flow adapter: lossless boundary
// CanvasDocument is the only source of truth and react-flow is a controlled
// view, so the adapter between them must round-trip EVERY field: a dropped
// metadata key is a silent rewrite of the user's saved canvas on the next
// autosave. Node 24 strips the module's type-only imports, so the real adapter
// runs here directly — no bundle, no browser, no copy of the logic.
const flowAdapter = await import(new URL('../src/client/canvas-flow-adapter.ts', import.meta.url))
const roundTripNodes = [
  { id: 'i1', type: 'image', title: 'img', x: 10, y: 20, width: 240, height: 240, metadata: { prompt: 'a cat', annotations: [{ sourceNodeId: 'x', rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }] } },
  { id: 't1', type: 'text', title: 'txt', x: 0, y: 0, width: 280, height: 150, metadata: { text: 'hello', bold: true } },
  { id: 'v1', type: 'video', title: 'vid', x: -5, y: 7, width: 320, height: 180, metadata: { videoMode: 'i2v', seconds: 5 } },
  // The absent-vs-empty metadata distinction is part of the document shape.
  { id: 'f1', type: 'file', title: 'file', x: 3, y: 4, width: 300, height: 170 },
  { id: 'c1', type: 'config', title: 'cfg', x: 9, y: 9, width: 320, height: 190, metadata: {} },
]
const adapterProblems = []
for (const node of roundTripNodes) {
  const back = flowAdapter.nodeFromFlow(flowAdapter.nodeToFlow(node))
  if (JSON.stringify(back) !== JSON.stringify(node)) adapterProblems.push(`node ${node.id} changed shape: ${JSON.stringify(back)}`)
}
if ('metadata' in flowAdapter.nodeFromFlow(flowAdapter.nodeToFlow(roundTripNodes[3]))) adapterProblems.push('a node without metadata grew one on the way back')
const roundTripConnection = { id: 'e1', fromNodeId: 'i1', toNodeId: 'v1' }
if (JSON.stringify(flowAdapter.edgeToConnection(flowAdapter.connectionToEdge(roundTripConnection))) !== JSON.stringify(roundTripConnection)) adapterProblems.push('the connection shape changed (workflow/compose read {fromNodeId,toNodeId} directly)')
// A connection role has to survive the same boundary. Every autosave crosses it,
// so a dropped role silently un-labels the user's first/last frame and the next
// video interpolates between two pictures they never picked.
for (const role of ['first', 'last', 'reference', 'input']) {
  const labelled = { id: `e-${role}`, fromNodeId: 'i1', toNodeId: 'v1', role }
  const back = flowAdapter.edgeToConnection(flowAdapter.connectionToEdge(labelled))
  if (JSON.stringify(back) !== JSON.stringify(labelled)) adapterProblems.push(`connection role "${role}" was lost on the way back: ${JSON.stringify(back)}`)
}
// Absent must stay absent: growing a field would rewrite all 1400+ old canvases.
for (const connection of [roundTripConnection, { id: 'e2', fromNodeId: 'i1', toNodeId: 'v1' }]) {
  if ('role' in flowAdapter.edgeToConnection(flowAdapter.connectionToEdge(connection))) adapterProblems.push('a connection without a role grew one on the way back')
}
// Garbage (hand-edited JSON, a role from a future version) must not reach the
// document: an unreadable string there is worse than a label that did not stick.
for (const junk of ['First', '', 42, null, {}, []]) {
  const edge = flowAdapter.connectionToEdge(roundTripConnection)
  edge.data = { role: junk }
  if ('role' in flowAdapter.edgeToConnection(edge)) adapterProblems.push(`a bogus role ${JSON.stringify(junk)} survived the boundary`)
}
for (const viewport of [{ x: 0, y: 0, k: 1 }, { x: -120, y: 88, k: 0.37 }]) {
  if (JSON.stringify(flowAdapter.viewportFromFlow(flowAdapter.viewportToFlow(viewport))) !== JSON.stringify(viewport)) adapterProblems.push(`viewport ${JSON.stringify(viewport)} changed`)
}
if (adapterProblems.length > 0) {
  console.error('\nFAIL: the flow adapter round-trip is lossy.')
  for (const entry of adapterProblems) console.error(`  - ${entry}`)
  console.error('Every autosave would rewrite the user\'s document through this boundary.')
  process.exit(1)
}
console.log('flow adapter: nodes / connections / viewport round-trip lossless')

// ------------------------------------------- viewport write-back stays finite
// react-flow reports NaN viewport geometry when there is no layout (jsdom,
// a detached pane); without the guard that NaN reaches document.viewport and
// every later coordinate math inherits it. No browser here reproduces a NaN
// viewport, so the guard is checked as the source invariant it is.
const workspaceText = canvasSourceText()
const viewportHandler = workspaceText.match(/const handleViewportChange = useCallback\(\(viewport: Viewport\): void => \{[\s\S]{0,500}?\}, \[setViewport\]\)/)
if (viewportHandler === null || !/Number\.isFinite\(viewport\.x\)[\s\S]*?Number\.isFinite\(viewport\.y\)[\s\S]*?Number\.isFinite\(viewport\.zoom\)/.test(viewportHandler[0])) {
  console.error('\nFAIL: the viewport write-back lost its finite guard.')
  console.error('react-flow can report NaN geometry without a layout; the document')
  console.error('must never inherit it.')
  process.exit(1)
}
console.log('viewport write-back: non-finite geometry never reaches the document')

// --------------------------------------- a config node has one prompt editor
//
// WHY this is a SOURCE invariant and not a rendered one: the defect it prevents
// is a textarea whose writes nobody reads. It renders fine, it types fine, and
// the value it stores (`metadata.text`) is not on any path the generator reads
// (`composerPrompt → upstream text → annotation cards`). The user's prompt is
// discarded in total silence — and a readiness badge next to it says "ready".
//
// It cannot be caught by "does the field exist": the field DID exist and worked
// as a field. What must hold is the structural claim "a config node renders no
// editable prompt input" — i.e. the config branch is a read-only preview. So the
// check looks for a `<textarea>` or `<input>` inside the config branch of the
// node body, and for the preview element that replaced it.
const nodeBodySource = readModuleSource('canvas/node-body.tsx')
const configBranch = nodeBodySource.match(/\{isConfig\s*\n\s*\?[\s\S]{0,1400}?: isTextual/)
if (configBranch === null) {
  console.error('\nFAIL: the config-node branch in node-body.tsx could not be located.')
  console.error('This guard is anchored on it; re-anchor rather than deleting the check.')
  process.exit(1)
}
if (/<(textarea|input)\b/.test(configBranch[0])) {
  console.error('\nFAIL: a config node renders an editable prompt input.')
  console.error('The generation path reads `composerPrompt → upstream text → annotation')
  console.error('cards`; it never reads `metadata.text`. Anything typed into a config')
  console.error("node's own field is discarded, and the readiness badge next to it")
  console.error('claims the opposite. The composer is the one place a prompt is edited.')
  process.exit(1)
}
if (!/data-config-prompt=/.test(configBranch[0])) {
  console.error('\nFAIL: a config node no longer previews the prompt that will be sent.')
  console.error('Removing the discarded editor without a read-only replacement leaves')
  console.error('the card as an empty shell: the one thing it should answer is what')
  console.error('this node will actually send.')
  process.exit(1)
}
console.log('config node: no second prompt editor, and it previews what will be sent')

// --------------------------------------- 套图与 count 是两个语义，不走同一条路
//
// WHY 源码级：套图与「生成数量」的区别在界面上很容易被做成同一个数字——填 3
// 想出一套三视图的人会拿到三张一样的正面。三条必须同时成立：
//   1. 提交路径按套图跑（每条独立任务），不是把 count 抬到 N；
//   2. 套图 UI 在 composer 里，不在卡片上——卡片只显示只读徽标，撞上面那条
//      「一个提示词只准有一个编辑入口」的守卫；
//   3. locales 三块的 `canvas.promptSet*` key 数量相等（少一个就是某个语言里
//      显示 `key.not.found`）。
const composerSource = readModuleSource('canvas/composer.tsx')
if (!/promptSetJobsFromItems\s*\(/.test(workspaceText)) {
  console.error('\nFAIL: the prompt-set submission path is missing from CanvasWorkspace.tsx.')
  console.error('A prompt set must run each item as its own task (own taskId, own')
  console.error('placeholder, own title). Falling back to `count` would give the user')
  console.error('N copies of the same prompt with the same placeholder pool.')
  process.exit(1)
}
// 提交路径必须读**草稿**而不是节点上已保存的那份：用户刚敲进编辑器、还没落盘的
// 条目才是这次要跑的东西。读节点的话，新输入要等下次改动才生效——「点了没反应」。
if (!/promptSetJobsFromItems\(composerPromptSet\)/.test(workspaceText)) {
  console.error('\nFAIL: the prompt-set path does not read the composer draft.')
  console.error('Reading `metadata.promptSet` here means the entries the user just typed')
  console.error('are ignored until some unrelated edit flushes them.')
  process.exit(1)
}
// 每次套图提交必须各自 taskSubmit：一条请求 + 一个共享 taskId 会让 N 条提示词
// 变成 N 张同一句话的图，标题也全丢。
{
  const setBranch = workspaceText.match(/if \(!codeRenderer && target !== null && setJobs\.length > 0\) \{[\s\S]*?\n      \}/)
  if (setBranch === null) {
    console.error('\nFAIL: the prompt-set branch in submitComposer could not be located.')
    process.exit(1)
  }
  if ((setBranch[0].match(/api\.taskSubmit\(/g) ?? []).length !== 1 || !/n: 1/.test(setBranch[0])) {
    console.error('\nFAIL: the prompt-set branch does not submit one request per item.')
    console.error('Each item needs its own taskSubmit with n: 1 so it gets its own taskId,')
    console.error('its own placeholder and its own title.')
    process.exit(1)
  }
}
if (!/composerPromptSet/.test(composerSource) || !/canvas\.promptSetMode\b/.test(composerSource)) {
  console.error('\nFAIL: the prompt-set editor is missing from the composer.')
  console.error('The one place a prompt is edited stays the composer; putting the set')
  console.error('editor on the card would be a second prompt editor for a config node.')
  process.exit(1)
}
if (/<(textarea|input)\b[^\n]*promptSet/.test(nodeBodySource)) {
  console.error('\nFAIL: node-body.tsx renders an editable prompt-set input.')
  console.error('The card may show a read-only badge (`canvas.promptSetBadge`) and nothing')
  console.error('more; editing stays in the composer.')
  process.exit(1)
}
{
  const localesSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/locales.ts'), 'utf8').replace(/\r\n?/g, '\n')
  const blocks = localesSource.split(/\nexport const (?:zh|en|ru)(?:: [^=]*)? = \{/).slice(1)
  if (blocks.length !== 3) {
    console.error('\nFAIL: locales.ts no longer has three blocks (zh/en/ru).')
    process.exit(1)
  }
  const counts = blocks.map(block => (block.match(/'canvas\.promptSet\w*'/g) ?? []).length)
  if (counts[0] !== counts[1] || counts[1] !== counts[2] || counts[0] === 0) {
    console.error(`\nFAIL: canvas.promptSet* keys differ across locales: ${counts.join(' / ')}.`)
    console.error('A missing key renders as the raw key name in that language.')
    process.exit(1)
  }
}
console.log('prompt set: own submission path, composer-side editor, locales agree')

// ------------------------------- 套图编辑器独占一行，参数行不许被它挤窄
//
// WHY 源码级：这条守的是**布局归属**，不是样式值。真机上犯过的错是
// 三段：编辑器塞进参数排（一排 flex 横排被压成一列，尺寸/清晰度只剩一两个字）、
// 单张/套图切换塞进参数排（三个下拉同时退成「模…」「自…」「清…」）、
// 提示词框被当成唯一输入（套图条目写满也不让按生成）。
// 三者都只在真机分辨率下显形，断言只能钉结构：编辑器是 `.composerControls`
// 的**兄弟**，切换按钮在元信息行，提交按钮把套图条目算作可用。
{
  const composerBody = composerSource
  // 逐个找**所有**参数排，而不是只找第一个。
  //
  // WHY：断言原先只取第一个 `.composerControls` 块再在里面找编辑器。注入
  // 「把编辑器塞回参数排」时，注入点在第一个块之后，检查读到的是注入前的
  // 那个块，于是缺陷明明回来了、检查照样绿（反向用例当场报 FALSE GREEN）。
  // 一条只看得见第一处的守卫，等于给第二处开了后门。
  //
  // 写法上必须按**标签配对**切块，不能按「到第一个 `\n  </div>` 为止」：注入
  // 的那一行是单行 `<div …>…</div>`，用换行锚定就永远切不出它，于是又回到
  // 「只看得见第一处」的老毛病。
  const divBlocks = []
  for (let start = composerBody.indexOf('<div'); start >= 0; start = composerBody.indexOf('<div', start + 1)) {
    const openEnd = composerBody.indexOf('>', start)
    if (openEnd < 0) break
    const openTag = composerBody.slice(start, openEnd + 1)
    if (!openTag.includes('css.composerControls')) continue
    let depth = 1
    let cursor = openEnd + 1
    while (depth > 0) {
      const nextOpen = composerBody.indexOf('<div', cursor)
      const nextClose = composerBody.indexOf('</div>', cursor)
      if (nextClose < 0) break
      if (nextOpen >= 0 && nextOpen < nextClose) {
        // 自闭合的 `<div … />` 不增加深度。
        const selfClose = composerBody.indexOf('/>', nextOpen)
        if (selfClose >= 0 && selfClose < composerBody.indexOf('>', nextOpen)) {
          cursor = selfClose + 2
          continue
        }
        depth += 1
        cursor = nextOpen + 4
      } else {
        depth -= 1
        cursor = nextClose + 6
      }
    }
    divBlocks.push(composerBody.slice(start, cursor))
  }
  if (divBlocks.length === 0) {
    console.error('\nFAIL: the composer parameter row could not be located.')
    process.exit(1)
  }
  if (divBlocks.some(block => /<textarea|ComposerPromptSetEditor/.test(block))) {
    console.error('\nFAIL: a multi-line prompt-set editor is rendered inside the parameter row.')
    console.error('That row is a single-line flex strip: a multi-line child squeezes every')
    console.error('select next to it down to one or two characters. The editor must be a')
    console.error('sibling of `.composerControls`, not a child.')
    process.exit(1)
  }
  if (!/<ComposerPromptSetEditor/.test(composerBody)) {
    console.error('\nFAIL: the prompt-set editor is not rendered at all.')
    process.exit(1)
  }
  if (!/composerPromptSet\.every\(item => item\.prompt\.trim\(\) === ''\)/.test(composerBody)) {
    console.error('\nFAIL: the send button ignores the prompt-set draft.')
    console.error('With three prompts typed and the main box empty, the button must be live;')
    console.error('otherwise the user fills a whole set and cannot send it.')
    process.exit(1)
  }
}
console.log('prompt set layout: editor owns its row, params stay readable, draft enables send')

// ------------------------------------------- 整理画布是一次动作，不是一串动作
//
// WHY 这是源码级断言：它守的两条都是「单次动作的原子性」，而这两条在界面上
// **看不出差别**——逐节点写坐标的结果和一次性写坐标的结果长得一模一样，
// 区别只在按 Ctrl+Z 的那一下（退一个节点 vs 退回整理前），以及视野有没有跟着
// 跳走。渲染测试抓不到，只有读调用形态。
//
// 被守的两条：
//   1. 必须走 `mutate`（= 一次撤销记录）。逐节点 `patchNode` 会把一次整理
//      变成 N 条历史，用户按十次撤销还在整理里打转。
//   2. 不许动视口。整理的是内容，视野是用户当下正在看的位置；把它一起挪走，
//      用户会先看到一片空白，再以为自己点错了按钮。
const arrangeBody = workspaceText.match(/const arrangeCanvas = useCallback\(\(\): void => \{[\s\S]*?\n {2}\}, \[mutate\]\)/)
if (arrangeBody === null) {
  console.error('\nFAIL: the arrange-canvas action could not be located.')
  console.error('This guard is anchored on it; re-anchor rather than deleting the check.')
  process.exit(1)
}
if (!/\bmutate\(/.test(arrangeBody[0])) {
  console.error('\nFAIL: 整理画布 no longer commits through `mutate`.')
  console.error('Without a single history entry the arrange is N separate edits, and')
  console.error('Ctrl+Z walks back one node at a time instead of undoing the arrange.')
  process.exit(1)
}
if (/\bpatchNode\(/.test(arrangeBody[0])) {
  console.error('\nFAIL: 整理画布 writes coordinates one node at a time.')
  console.error('Each `patchNode` is its own undo entry; the arrange becomes un-undoable')
  console.error('as a whole action.')
  process.exit(1)
}
if (/\bsetViewport\(/.test(arrangeBody[0])) {
  console.error('\nFAIL: 整理画布 moves the viewport as well.')
  console.error('The user is looking at this content when they press it; moving the')
  console.error('camera makes the canvas look empty and reads as a mis-click.')
  process.exit(1)
}
if (!/name="arrange"[\s\S]{0,200}?onClick=\{arrangeCanvas\}/.test(workspaceText)) {
  console.error('\nFAIL: the arrange-canvas button is gone from the chrome.')
  console.error('A button that exists but is not wired to `arrangeCanvas` is worse than')
  console.error('no button: it looks like the feature shipped.')
  process.exit(1)
}
console.log('arrange canvas: one history entry, one edit pass, viewport untouched')

// ------------------------------------------ 运行痕迹真的挂到了节点上
//
// WHY 源码级：一条完整的失败路径要等执行器轮询到节点出错（最长 30 分钟），
// jsdom 里造不出来。能造出来的是**接线**，而接线正是这条功能最容易断的地方
// ——纯函数算得再对，没人把结果交给节点渲染，画布上还是一片安静。
//
// 五处接线，缺一处这条功能就不成立：
//   1. 运行失败时把结论写进 state；
//   2. 新一轮开始时清掉上一轮；
//   3. 单节点重试摘掉自己的标记；
//   4. 节点体读 state 并画出徽标；
//   5. 节点的类名带上两种描边状态。
for (const [label, pattern, why] of [
  // 三处都会落痕：取消（按停之前的失败仍是真失败）、失败、部分成功。
  // 断言数出现次数而不是位置：任何一条分支漏了，这里就少一次。
  ['三种结局都落痕', /(setRunMarks\(runMarksFrom\(result\)\)[\s\S]*?){3}/, '有运行结局没有写进画布状态（取消 / 失败 / 部分成功）'],
  ['新运行清痕', /setRunMarks\(EMPTY_RUN_MARKS\)\n {4}setWorkflowProgress/, '上一轮的痕迹会叠在新一轮上'],
  ['重试摘标', /setRunMarks\(previous => withoutFailed\(previous, node\.id\)\)/, '重试过的节点还挂着红标'],
  ['节点体画徽标', /data-run-mark=\{runMark\}/, '节点体不画运行痕迹'],
  ['节点描边分两态', /isRunFailed \? css\.nodeRunFailed : ''[\s\S]{0,80}?isRunBlocked \? css\.nodeRunBlocked/, '节点本身的描边没有跟上运行痕迹'],
]) {
  if (!pattern.test(workspaceText + nodeBodySource)) {
    console.error(`\nFAIL: 运行痕迹的接线断了一处（${label}）：${why}。`)
    process.exit(1)
  }
}
console.log('run marks: written on failure, cleared on the next run and on retry, rendered on the node')

// ---------------------------------------------- 全部功能目录：每一行都接着活代码
//
// WHY 源码级：目录里有 30 行，逐个点一遍要 30 次渲染；而能让这条功能整块失效的
// 只有一件事——某一行没接上。那一行长得和别的一模一样，按下去什么都不发生，用户
// 会以为「这个功能不存在」，而不是「这里有个 bug」。`Record<CapabilityId, …>` 已
// 经在编译期挡住了缺项；这里挡住的是另一种坏法：接上了一个**空函数**或者接错了
// 动作（把「导出」接到「导入」上，两行都能点，但只有一行是对的）。
const catalogSource = readModuleSource('canvas/capability-catalog.ts')
const catalogIds = [...catalogSource.matchAll(/^ {4}id: '([a-z]+\.[A-Za-z]+)',/gm)].map(match => match[1])
if (catalogIds.length < 25) {
  console.error(`\nFAIL: the capability catalog lists only ${catalogIds.length} actions — the whole point is that it covers the surface.`)
  process.exit(1)
}
const actionsBlock = workspaceText.match(/const catalogActions = useMemo<Record<CapabilityId, \(\) => void>>\(\(\) => \(\{[\s\S]*?\n {2}\}\), \[/)
if (actionsBlock === null) {
  console.error('\nFAIL: the catalog action table could not be located.')
  console.error('It is the only place that ties a catalog row to real code; re-anchor rather than deleting the check.')
  process.exit(1)
}
const wiredIds = [...actionsBlock[0].matchAll(/'([a-z]+\.[A-Za-z]+)':/g)].map(match => match[1])
const unwired = catalogIds.filter(id => !wiredIds.includes(id))
if (unwired.length > 0) {
  console.error(`\nFAIL: ${unwired.length} catalog row(s) have no action: ${unwired.join(', ')}`)
  console.error('A row that renders but does nothing reads as "this feature does not exist".')
  process.exit(1)
}
const strayIds = wiredIds.filter(id => !catalogIds.includes(id))
if (strayIds.length > 0) {
  console.error(`\nFAIL: the action table wires ids the catalog does not list: ${strayIds.join(', ')}`)
  console.error('Dead wiring hides the fact that a row was renamed and its action left behind.')
  process.exit(1)
}
// 目录必须先关再执行。留在屏幕上的遮罩会盖住它刚做的事，用户读到的结果是
// 「点了，什么也没变」——即使那件事真的发生了。
if (!/const runCatalogItem = useCallback\(\(id: CapabilityId\): void => \{\s*setCatalogOpen\(false\)\s*catalogActions\[id\]\(\)/.test(workspaceText)) {
  console.error('\nFAIL: the catalog no longer closes before running the row.')
  console.error('The dialog covers the canvas, so the action it just ran is invisible')
  console.error('behind it — indistinguishable from a dead row.')
  process.exit(1)
}
console.log(`capability catalog: ${catalogIds.length} rows, every one wired, the dialog closes before it runs`)

// ------------------------------------------- 目录行尾的键位徽章
//
// WHY 源码级：这张表的键位不是它的数据，而是**另一张表**（CANVAS_SHORTCUTS）
// 的函数。能让它整块失效的坏法只有三种，每一种在截图上都看不出来：
//
//   1. 目录自己拼一份键位 → 改键位那天两处走散，用户照目录按、按不出来。
//   2. 灰行也挂徽章 → 一条按下去没反应的行旁边写着 Ctrl/⌘+Z，读起来是「能用」。
//   3. 没有键位的行也渲染空壳 → 右侧多出一列空白，每一行的标题都短一截。
const catalogComponent = readModuleSource('canvas/capability-catalog.tsx')

// (1) 键位只从那张表来。`shortcutKeysFor` 是唯一入口：它按 label/action 反查，
// 与撤销按钮的 tooltip、对齐条的 tooltip 读的是同一份数据。
if (!/shortcutKeysFor\(item\.entry\.labelKey\)/.test(catalogComponent)) {
  console.error('\nFAIL: 目录不再从 CANVAS_SHORTCUTS 取键位。')
  console.error('A second key table in the catalog drifts the day a binding changes:')
  console.error('the row goes on advertising a key that no longer does anything.')
  process.exit(1)
}
// 而且不能另起一份：目录里出现 `keys: [` 这种字面量，就是又抄了一张表。
if (/\bkeys:\s*\[/.test(catalogComponent)) {
  console.error('\nFAIL: 目录里出现了一份自己的键位表。')
  console.error('Every binding must come from shortcutKeysFor; a literal here is a')
  console.error('second source of truth that silently outlives the real one.')
  process.exit(1)
}

// (2) 灰行不挂徽章。守的是「同一个条件表达式」：分成两个地方写（先算 keys，
// 再在渲染里判 blocked）也能对，但只要有人把 `blockedBy === null ?` 摘掉，
// 灰行就会开始宣传它自己的快捷键——而它在按下时什么都不会发生。
if (!/item\.blockedBy === null \? shortcutKeysFor\(item\.entry\.labelKey\) : ''/.test(catalogComponent)) {
  console.error('\nFAIL: 不可用的目录行又挂上了键位徽章。')
  console.error('A dimmed row advertising Ctrl/⌘+Z reads as "this works"; the user')
  console.error('presses the key, nothing happens, and the dead row is now a dead')
  console.error('feature in their head.')
  process.exit(1)
}

// (3) 空键位不渲染空壳。`keys === '' ? null :` 这一支既省掉空白列，也让「没有
// 快捷键」与「有快捷键」在 DOM 上真的不同（截图核对与这里的断言才有意义）。
if (!/\{keys === '' \? null : <(kbd|span|div)\b/.test(catalogComponent)) {
  console.error('\nFAIL: 没有快捷键的行也渲染了空徽章。')
  console.error('An always-present column makes every title a little shorter and looks')
  console.error('like the label was truncated; absent bindings must render nothing.')
  process.exit(1)
}
// 徽章必须是 `<kbd>` 且带 data-quick-keys：前者让读屏与浏览器都把它当键位，
// 后者是截图核对与将来真机测试的抓手。
if (!/<kbd\b[^>]*\bdata-quick-keys=""[^>]*>\{keys\}<\/kbd>/.test(catalogComponent)) {
  console.error('\nFAIL: 键位徽章不再带 data-quick-keys 或不再是 <kbd>。')
  console.error('The hook is what lets a real-browser check find the badge; a plain')
  console.error('span also loses the "this is a key" semantics for assistive tech.')
  process.exit(1)
}
// 徽章样式必须真的存在且用 alias token：写死的颜色在切主题后留在旧配色里。
const catalogCss = readModuleSource('canvas/capability-catalog.module.css')
const keysRule = catalogCss.match(/\n\.keys \{[\s\S]*?\n\}/)
if (keysRule === null) {
  console.error('\nFAIL: 目录样式里没有 .keys 规则；徽章会退化成一行裸文本。')
  process.exit(1)
}
// 墨色：11px 的键位是这一行里要被读的信息。tertiary 在白底上实测 3.71:1，
// 低于小字所需的 4.5:1；真浏览器里量到的是 secondary 的 5.80:1 (light) /
// 9.25:1 (dark)。这里钉住 token，数值由 `verify-ui-contracts` 的对比度一节量。
if (/color:\s*var\(--dsw-alias-label-tertiary\)/.test(keysRule[0])) {
  console.error('\nFAIL: 键位徽章退回了 tertiary 墨色。')
  console.error('Measured on the real dialog: 3.71:1 in the light theme, below the 4.5:1')
  console.error('that an 11px label needs. Use label-secondary (5.80:1 / 9.25:1).')
  process.exit(1)
}
for (const needed of ['margin-left: auto', 'white-space: nowrap', 'flex: none', 'var(--dsw-alias-label-secondary)']) {
  if (!keysRule[0].includes(needed)) {
    console.error(`\nFAIL: .keys 少了 \`${needed}\`。`)
    console.error('Without it the badge wraps to a second line, or does not sit at the')
    console.error('row end, or keeps a literal colour across a theme switch.')
    process.exit(1)
  }
}
console.log('catalog keys: badges come from the one shortcut table, blocked rows show none, empty bindings render nothing')

// ------------------------------------------------- 顶栏是任务动词，不是文件管理
//
// WHY 源码级：这是信息架构问题，界面上画得出来、点得动，只是读起来不对——四枚
// 低频的文件动作（收藏 / 导出 / 导入 / 删除画布）与标题、保存状态并排占掉顶栏
// 一半宽度，760px 以下还把标题挤到第二行。真浏览器能测「换行了没有」，但测不出
// 「为什么换行」；把规则写成「这几枚不许直接出现在顶栏」才守得住下一次加按钮。
const headerBlock = workspaceText.match(/<header ref=\{topBarRef\} className=\{css\.topBar\}[\s\S]*?<\/header>/)
if (headerBlock === null) {
  console.error('\nFAIL: the canvas top bar could not be located; re-anchor this guard.')
  process.exit(1)
}
const forbiddenInHeader = ['favorite', 'favoriteFilled', 'download', 'upload', 'deleteProject']
  .filter(name => new RegExp(`name="${name}"`).test(headerBlock[0]))
if (forbiddenInHeader.length > 0) {
  console.error(`\nFAIL: file management is back in the top bar as loose buttons: ${forbiddenInHeader.join(', ')}`)
  console.error('These four act on the canvas as a FILE, not on what the user is doing')
  console.error('inside it, and the top bar is the one line that has to stay legible at')
  console.error('narrow panel widths. They belong in the 画布文件 menu (TopBarMenu).')
  process.exit(1)
}
if (!/name="more"[\s\S]{0,600}?setTopBarMenu\(/.test(headerBlock[0])) {
  console.error('\nFAIL: the 画布文件 menu entry is gone from the top bar.')
  console.error('Without it those four actions become unreachable, which is worse than')
  console.error('sitting in a row: the feature silently disappears.')
  process.exit(1)
}
// 保存状态必须**紧挨着**标题，中间没有 spacer：「叫什么」和「落盘了没有」是同
// 一个句子的两半；被推到顶栏另一头时，那条橙色的「未保存」就成了一个没人找的
// 孤词，而 760px 以下一换行，它还会单独落进第二行。
const titleAt = headerBlock[0].indexOf('className={css.titleButton}')
const stateAt = headerBlock[0].indexOf('className={css.saveState}')
const spacerBetween = titleAt === -1 || stateAt === -1 || stateAt < titleAt
  ? false
  : headerBlock[0].slice(titleAt, stateAt).includes('topBarSpacer')
if (titleAt === -1 || stateAt === -1 || stateAt < titleAt || spacerBetween) {
  console.error('\nFAIL: the save state drifted away from the canvas title.')
  console.error('They read as one sentence ("未命名画布，未保存"); split to opposite ends')
  console.error('of the bar, the state is a lone orange word nobody looks for.')
  process.exit(1)
}
console.log('canvas top bar: verbs only, file management lives in the 画布文件 menu, save state sits by the title')

// -------------------------------- 找节点 / 画布体检 / 载入示例：三处接线
//
// WHY 源码级：这三条功能的纯函数各自有单测（几何、体检、搜索），但那三层都
// 证明不了它们**接上了**。接错的表现和没做完全一样——点了没反应、菜单里没有
// 那一行、跳过去了但没选中——而界面上看得见的部分是对的。
//
// 每条断言都对着一个「长得对、作用错」的具体缺陷，反向验证逐条把它注回去。
{
  // (1) 找节点必须「先关弹窗再跳」。留着那张全屏遮罩，用户看不到自己刚跳过去
  // 的那张卡，只能读到「按了回车，屏幕没动」。
  if (!/onPick=\{\(hit: NodeHit\) => \{ setNodeSearchOpen\(false\); jumpToNode\(hit\.nodeId\) \}\}/.test(workspaceText)) {
    console.error('\nFAIL: 找节点不再「先关弹窗再跳过去」。')
    console.error('The overlay covers the canvas, so the card it just jumped to is invisible')
    console.error('behind it — indistinguishable from a dead result row.')
    process.exit(1)
  }
  // (2) 跳过去必须**选中**目标。只挪视野的话，用户看到的是一张普通卡片，不知道
  // 自己刚被带到哪一张。
  const jumpBlock = workspaceText.match(/const jumpToNode = useCallback\(\(nodeId: string\): void => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
  if (jumpBlock === null) {
    console.error('\nFAIL: the find-node jump handler could not be located; re-anchor this guard.')
    process.exit(1)
  }
  if (!/setSelectedIds\(new Set\(\[nodeId\]\)\)/.test(jumpBlock[0])) {
    console.error('\nFAIL: 找节点跳过去之后不再选中那张卡。')
    console.error('The user arrives at a card that looks like every other one, with no')
    console.error('indication of which one they were just brought to.')
    process.exit(1)
  }
  // (3) 视口计算必须走那个有单测的纯函数。自己在这里再写一遍缩放与居中，等于让
  // 「NaN 会把画布整块抹掉」这条已经守住的边界重新开口。
  if (!/focusViewport\(/.test(jumpBlock[0])) {
    console.error('\nFAIL: 找节点自己算视野，不再用 focusViewport。')
    console.error('That helper is the only place the zero-size / infinity / clamp cases are')
    console.error('tested; a second copy here can produce NaN and blank the whole canvas.')
    process.exit(1)
  }
  // (4) 体检清单里的每一行都要能点着跳过去。只报不带路的清单把最难的那半件事
  // （在上百张卡里找到它们）留给了用户。
  const healthBlock = workspaceText.match(/<div className=\{css\.healthList\}[\s\S]*?\n {4}<\/div>/)
  if (healthBlock === null) {
    console.error('\nFAIL: the run menu\'s health list could not be located; re-anchor this guard.')
    process.exit(1)
  }
  if (!/data-health-issue=\{issue\.kind\}/.test(healthBlock[0]) || !/onClick=\{\(\) => props\.onJumpIssue\(issue\)\}/.test(healthBlock[0])) {
    console.error('\nFAIL: 体检清单又变回「只报不带你去看」。')
    console.error('After being told which three nodes form a cycle, the user still has to')
    console.error('hunt for them across the canvas by hand.')
    process.exit(1)
  }
  // (5) 载入示例必须一次写完两个节点加一根线。分几次写会在撤销栈里留下几条
  // 记录，按一次 Ctrl+Z 只撤回半条示例，剩下的半条既跑不了也删不干净。
  const exampleBlock = workspaceText.match(/const loadExampleFlow = useCallback\([\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
  if (exampleBlock === null) {
    console.error('\nFAIL: the example loader could not be located; re-anchor this guard.')
    process.exit(1)
  }
  const mutateCalls = exampleBlock[0].match(/mutate\(/g)?.length ?? 0
  if (mutateCalls !== 1 || !/nodes: \[\.\.\.previous\.nodes, \.\.\.flow\.nodes\], connections: \[\.\.\.previous\.connections, \.\.\.flow\.connections\]/.test(exampleBlock[0])) {
    console.error('\nFAIL: 载入示例不再是一次写入。')
    console.error(`Found ${mutateCalls} mutate() call(s): a half-applied example leaves a node on the`)
    console.error('canvas that runs nothing and takes two undos to remove.')
    process.exit(1)
  }
  // (6) 空态必须有那张卡：它是空画布上唯一一条「不用先想清楚要放什么」的路。
  if (!/data-quick-card="example"/.test(workspaceText)) {
    console.error('\nFAIL: 空画布不再提供「载入示例」。')
    console.error('Every remaining card asks the user to already know what to add and how')
    console.error('to wire it — the exact thing a first-run canvas cannot know.')
    process.exit(1)
  }
  console.log('find node: closes before jumping, selects the target, reuses the tested viewport maths')
  console.log('canvas check-up: every problem row jumps to its card; the example lands in one edit')
}

// ------------------------------- 对齐 / 撤销摘要：两处接线
//
// 纯函数各自有单测（21 条对齐、19 条摘要），但那一层证明不了「接上了、接对了」。
// 这一层的断言都对着一个**长得对、作用错**的缺陷：对齐逐张写撤销、只有一张卡时
// 也出对齐条、撤销按钮退回报一句「撤销」。反向验证逐条把它注回去。
{
  // (1) 对齐必须走一次 `mutate`。逐节点 patch 会让撤销变成「按一次退一张卡」，
  // 而按到一半时画布既不是对齐前也不是对齐后的样子。
  const alignBlock = workspaceText.match(/const alignSelection = useCallback\(\(mode: AlignMode\): void => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
  if (alignBlock === null) {
    console.error('\nFAIL: the align handler could not be located; re-anchor this guard.')
    process.exit(1)
  }
  const alignMutates = alignBlock[0].match(/mutate\(/g)?.length ?? 0
  if (alignMutates !== 1) {
    console.error('\nFAIL: 对齐不再是「一次编辑」。')
    console.error(`Found ${alignMutates} mutate() call(s). One click must be one undo step: a`)
    console.error('per-card write turns Ctrl+Z into "put one card back", and the canvas half')
    console.error('way through is neither the old arrangement nor the new one.')
    process.exit(1)
  }
  // 规则必须来自那个有单测的模块。在这里自己再写一遍对齐的算术，等于让「分组是
  // 刚体」「取整」「幂等」这几条已经守住的边界重新开口。
  // 只对画面上的卡对齐：隐藏的卡不在画面上，把它们算进包围盒会把可见的那几张
  // 推到画外，而把它们挪到一条线上又会让「全部显示」时出现一群被悄悄挪过的卡。
  if (!/alignNodes\(\{ nodes: visibleNodes\(current\.nodes\), selectedIds: selectedIdsRef\.current, groups: groupsOf\(current\) \}, mode\)/.test(alignBlock[0])) {
    console.error('\nFAIL: 对齐不再调用 align-model 的 alignNodes。')
    console.error('That function is the only place grouping-as-rigid-body, integer')
    console.error('rounding and idempotence are tested; a second copy here drifts silently.')
    process.exit(1)
  }
  // `moved === 0` 必须提前返回：已经对齐的图按一下不该多出一条空撤销，
  // 否则下一次 Ctrl+Z 看起来什么都没做。
  if (!/if \(result\.moved === 0\)/.test(alignBlock[0])) {
    console.error('\nFAIL: 对齐在「一个都没动」时仍然写文档。')
    console.error('An already-aligned canvas then gets an empty undo step, and the next')
    console.error('Ctrl+Z appears to do nothing at all.')
    process.exit(1)
  }
  // (2) 对齐条只在 ≥2 张时出现。一枚只选中一张卡也出现的对齐条，点下去要么
  // 什么都不做（用户以为坏了），要么挪了唯一那张卡（用户以为画布乱跳）。
  if (!/\{selectedNodeCount >= 2 \? <AlignBar/.test(workspaceText)) {
    console.error('\nFAIL: 对齐条不再要求至少两个节点。')
    console.error('With one node selected there is nothing to align against; the button reads')
    console.error('as broken or moves the only card, and neither is something a user forgives.')
    process.exit(1)
  }
  // (3) 撤销/重做按钮的标签必须来自 `describeStep`。只写「撤销」时，连按三次
  // 之后用户不知道自己退掉了哪一步——那正是这条功能存在的理由。
  if (!/label=\{undoHint === null \? labelWithKeys\('canvas\.undo'\) : tt\('canvas\.undo\.step', \{ step: undoHint \}\)\}/.test(workspaceText)) {
    console.error('\nFAIL: 撤销按钮不再说明「这一步是什么」。')
    console.error('After three Ctrl+Z the user cannot tell which edit they just took back;')
    console.error('the tooltip is the only surface that can answer that before they act.')
    process.exit(1)
  }
  if (!/describeStep\(before, after\)/.test(workspaceText)) {
    console.error('\nFAIL: 摘要不再调用 history-model 的 describeStep。')
    console.error('The rules for what counts as one action (spill-over wires, mixed')
    console.error('changes, viewport-only steps) live there, with 19 tests.')
    process.exit(1)
  }
  console.log('align: one edit per click, rules come from the tested module, the bar needs two cards')
  console.log('undo/redo: the tooltip says which step it will take back')

  // --------------------------------------------------------- 层级顺序：接线
  //
  // 纯函数 `reorderLayers` 有 12 条单测，`coveredNodes` 与它的联合语义有 3 条，
  // 但那一层证明不了「接上了、接对了」。这一节挡的是三种长得对、作用错的写法：
  //
  //  1. 逐节点写文档 → 撤销变成「按一次退回一张卡的层级」，而按到一半时画布
  //     既不是调整前也不是调整后的样子，中间那一帧还会被 autosave 存下去。
  //  2. `moved === false` 仍然写 → 已经最上面那张再置顶一次，undo 栈里多一条
  //     什么都没改的步骤，下一次 ⌘Z 看起来没反应。
  //  3. 忘了关 react-flow 的「选中提权」→ 被置底的那张卡一被点中就用内联
  //     z-index 1000 跳回最上层，用户看到的是「置底没生效」，而且刷新后又是
  //     对的——最难复现的一类 bug。
  {
    const layerBlock = workspaceText.match(/const reorderSelection = useCallback\(\(mode: LayerMode\): void => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
    if (layerBlock === null) {
      console.error('\nFAIL: the layer-order handler could not be located; re-anchor this guard.')
      process.exit(1)
    }
    const layerMutates = layerBlock[0].match(/mutate\(/g)?.length ?? 0
    if (layerMutates !== 1) {
      console.error('\nFAIL: 层级调整不再是「一次编辑」。')
      console.error(`Found ${layerMutates} mutate() call(s). One click must be one undo step, and a`)
      console.error('half-applied stacking order is a document the user never asked for.')
      process.exit(1)
    }
    if (!/reorderLayers\(current\.nodes, selectedIdsRef\.current, mode\)/.test(layerBlock[0])) {
      console.error('\nFAIL: 层级调整不再调用 layer-order 的 reorderLayers。')
      console.error('That function is the only place "a multi-selection moves as one slot"')
      console.error('and idempotence are tested; a second copy here drifts silently.')
      process.exit(1)
    }
    if (!/if \(!result\.moved\)/.test(layerBlock[0])) {
      console.error('\nFAIL: 层级在「一个都没动」时仍然写文档。')
      console.error('Re-fronting the topmost card then leaves an empty undo step, and the next')
      console.error('Ctrl+Z appears to do nothing at all.')
      process.exit(1)
    }
    // 叠放顺序必须由数组下标表达。关掉选中提权是这条约定能被看见的前提：
    // 开着它时，任何一次点选都会把那张卡临时顶到 z-index 1000。
    if (!/elevateNodesOnSelect=\{false\}/.test(workspaceText)) {
      console.error('\nFAIL: react-flow 的选中提权又开着。')
      console.error('It stamps z-index 1000 on whatever the user clicks, so a card that was')
      console.error('just sent to the back jumps to the front the moment it is selected.')
      process.exit(1)
    }
    if (!/zIndex: index,/.test(workspaceText)) {
      console.error('\nFAIL: flow 节点不再按下标写 zIndex。')
      console.error('Without it the stacking order depends on the order react-flow happens to')
      console.error('render the wrappers, which is not the document order.')
      process.exit(1)
    }
    // 目录四行必须接到同一个 handler。接错方向（把「置顶」接到 back）在界面上
    // 完全看不出来：两行都能点，只是有一行做的是反的。
    const layerRows = [
      ['edit.layerFront', 'front'],
      ['edit.layerBack', 'back'],
      ['edit.layerForward', 'forward'],
      ['edit.layerBackward', 'backward'],
    ]
    for (const [id, mode] of layerRows) {
      if (!new RegExp(`'${id.replace(/\./g, '\\.')}': \\(\\) => reorderSelection\\('${mode}'\\)`).test(workspaceText)) {
        console.error(`\nFAIL: 目录行 ${id} 没有接到 reorderSelection('${mode}')。`)
        console.error('A row wired to the wrong direction looks identical until someone presses it.')
        process.exit(1)
      }
    }
    // 右键菜单也是入口之一，而且是最自然的那个（被压住时手指就在那张卡上）。
    const menuSource = readModuleSource('canvas/context-menu.tsx')
    for (const mode of ['front', 'forward', 'backward', 'back']) {
      if (!new RegExp(`A\\.reorderLayers\\('${mode}'\\)`).test(menuSource)) {
        console.error(`\nFAIL: 右键菜单少了 '${mode}' 这一个层级动作。`)
        console.error('The menu is where a user acts on the card that is being covered;')
        console.error('four of the four directions have to be there or the menu lies by omission.')
        process.exit(1)
      }
    }
    // 键位必须真的被读。`[]` / `BracketRight` 只有在处理函数里认了 code 才算数，
    // 而认 key 的写法在 macOS 上永远不成立（⌥] 的 key 是弯引号）。
    if (!/LAYER_SHORTCUTS_SHIFT\[event\.code\] \?\? LAYER_SHORTCUTS\[event\.code\]/.test(workspaceText)) {
      console.error('\nFAIL: 层级键位不再读 event.code。')
      console.error('Under Option, event.key is a composed character on macOS (⌥] is a curly')
      console.error('quote), so a key-based branch never fires on the platform we ship to.')
      process.exit(1)
    }
    // 遮盖提示必须画在画布覆盖层上，不能画进被盖住的那张卡里。挂进卡片时它
    // 和卡片一起被压住——以前只是因为 react-flow 给选中节点加 `z-index: 1000`
    // 才碰巧浮上来，选中提权一关（层级功能要求关掉）它就彻底消失。提示说的是
    // 画布层面的事实，所以要由画布这一层来画。
    const nodeBodySource = readModuleSource('canvas/node-body.tsx')
    if (/data-node-covered=/.test(nodeBodySource)) {
      console.error('\nFAIL: 遮盖提示又画回卡片里了。')
      console.error('The badge explains "you cannot see this card", so it must not live')
      console.error('inside that same card: it gets buried with it. Draw it in the .world')
      console.error('overlay, positioned from the covered node\'s bottom-right corner.')
      process.exit(1)
    }
    if (!/data-node-covered=\{covered\.id\}/.test(workspaceText)) {
      console.error('\nFAIL: 画布覆盖层里找不到遮盖提示。')
      console.error('Without it, a fully covered node is silently invisible: the yellow')
      console.error('outline is hidden under the covering card too.')
      process.exit(1)
    }
    console.log('layers: one edit per click, order comes from the tested module, four doors agree')
  }

  // ------------------------------------------------------ 锁定 / 隐藏：接线
  //
  // `node-flags.ts` 的 16 条单测证明的是「这几个函数算得对」；它们证明不了
  // 「有人调用它们」。这一层挡的正是那种最贵的缺陷形态——函数写得无可挑剔，
  // 但某个入口忘了调它：藏起来的卡还能被框选、锁住的卡被一次框选拖动悄悄挪了
  // 位置、复制出来的新卡一出生就拖不动。三种都不报错、不崩溃。
  {
    // (1) 渲染必须走 `visibleNodes`。react-flow 的 nodes 是画面本身，漏了这一
    // 层就是「藏了但还在」——而且因为它在画面里，用户还会以为自己没点中。
    if (!/nodesToFlow\(visibleNodesOf\)/.test(workspaceText)) {
      console.error('\nFAIL: 渲染不再用 visibleNodesOf。')
      console.error('Hidden cards then stay on screen: the menu says "hidden", the canvas')
      console.error('disagrees, and the card keeps eating clicks and marquee hits.')
      process.exit(1)
    }
    // (2) 连线必须与节点用**同一份**过滤结果。只过滤节点会留下通往空气的线，
    // 那比整条线不画更让人困惑：它看起来像一根还没接完的线。
    if (!/visibleConnections\(document\.connections, visibleNodesOf\)/.test(workspaceText)) {
      console.error('\nFAIL: 连线没有跟着节点一起过滤。')
      console.error('Filtering nodes alone leaves edges running to a card that is not there;')
      console.error('users read that as a broken connection and try to delete it.')
      process.exit(1)
    }
    // (3) 锁定 / 隐藏都是一次 `mutate`。逐节点写会让 ⌘Z 变成「一次放开一张卡」，
    // 而半放开的一批卡既不是操作前也不是操作后的状态。
    for (const [name, key] of [['toggleLock', 'locked'], ['toggleHidden', 'hidden'], ['showAllHidden', 'hidden']]) {
      const block = workspaceText.match(new RegExp(`const ${name} = useCallback\\(\\(\\): void => \\{[\\s\\S]*?\\n {2}\\}, \\[[^\\]]*\\]\\)`))
      if (block === null) {
        console.error(`\nFAIL: ${name} 的处理器找不到了；重新锚定这条守卫。`)
        process.exit(1)
      }
      const count = block[0].match(/mutate\(/g)?.length ?? 0
      if (count !== 1) {
        console.error(`\nFAIL: ${name} 不再是「一次编辑」（${count} 次 mutate）。`)
        console.error('Writing the flag card by card turns one Ctrl+Z into "unlock one card",')
        console.error('and a half-unlocked selection is a state the user never asked for.')
        process.exit(1)
      }
      if (!new RegExp(`${key}: (locking|hiding|false)`).test(block[0])) {
        console.error(`\nFAIL: ${name} 没有写 metadata.${key}。`)
        console.error('The flag has to land in the document, not in component state: a')
        console.error('reload would otherwise bring every card back unlocked and visible.')
        process.exit(1)
      }
    }
    // (4) 删除必须先剔掉锁定的那些。这是「锁定」这个功能存在的全部意义——
    // 一张锁不住 Delete 的卡等于没锁，而且用户会以为锁上了。
    const deleteBlock = workspaceText.match(/const deleteSelection = useCallback\(\(\): void => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
    if (deleteBlock === null) {
      console.error('\nFAIL: deleteSelection 找不到了；重新锚定这条守卫。')
      process.exit(1)
    }
    if (!/unlockedIds\(current\.nodes, ids\)/.test(deleteBlock[0])) {
      console.error('\nFAIL: 删除不再跳过锁定的节点。')
      console.error('A lock that Delete ignores is not a lock: the user locked the card')
      console.error('precisely so a stray keypress could not take it away.')
      process.exit(1)
    }
    if (!/canvas\.lock\.blockedDelete/.test(deleteBlock[0])) {
      console.error('\nFAIL: 删除跳过锁定项时不再说明原因。')
      console.error('Silently doing nothing is indistinguishable from a broken keyboard.')
      process.exit(1)
    }
    // (5) 拖动必须跳过锁定的卡。锁住的卡能被拖动时，用户会以为自己没锁上，
    // 而更糟的是他拖的是一批——同一次框选里没锁的几张也跟着走了。
    // 收尾写 `\n  }, [` 而不是 `\n  ], [`：这个回调用的是 `useCallback(() => {...}, [deps])`，
    // 一个更松的尾部会让正则提前停在前一个内部数组字面量上，断言就对着半截函数跑。
    const pointerBlock = workspaceText.match(/const handleNodePointerDown = useCallback\(\([\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
    if (pointerBlock === null) {
      console.error('\nFAIL: handleNodePointerDown 找不到了；重新锚定这条守卫。')
      process.exit(1)
    }
    // 断言的是**那一条 continue**，不是「函数里出现过 isLocked」。后者是个假守卫：
    // 同一个函数里还有分组兄弟与超链接入口两处 isLocked，把真正拦拖动的那行注掉
    // 之后它们仍然在，反向验证当场报 FALSE GREEN——守门绿着，锁却已经拖得动了。
    if (!/if \(isLocked\(item\)\) \{ lockedInSelection \+= 1; continue \}/.test(pointerBlock[0])) {
      console.error('\nFAIL: 拖动入口不再跳过锁定的卡片。')
      console.error('The origins map is what the pointer drag actually moves. If a locked')
      console.error('card still gets an entry in it, it follows the pointer -- the one thing')
      console.error('every user tests first, and it fails in the most literal way.')
      process.exit(1)
    }
    // (6) ⌥⇧L / ⌥⇧H 必须读 `event.code`，理由与层级键位完全相同：macOS 按住
    // Option 时 event.key 是组合字符，`key === 'l'` 永远不成立。
    // 同一条纪律：认的是**分发那一行**。`FLAG_SHORTCUTS[event.code]` 在守卫条件里
    // 也出现一次，只断言「文本里有」的话，把分发改成 `event.key` 仍会绿。
    if (!/if \(FLAG_SHORTCUTS\[event\.code\] === 'lock'\) toggleLock\(\)/.test(workspaceText)) {
      console.error('\nFAIL: 锁定 / 隐藏的键位不再读 event.code。')
      console.error('Under Option, event.key is a composed character on macOS (⌥L is not "l"),')
      console.error('so a key-based branch never fires on the platform we ship to.')
      process.exit(1)
    }
    if (!/FLAG_SHORTCUTS\[event\.code\] !== undefined/.test(workspaceText)) {
      console.error('\nFAIL: ⌥⇧ 这一档的守卫条件不再读 event.code。')
      console.error('The guard decides whether to preventDefault; reading event.key there')
      console.error('means the branch is never entered at all.')
      process.exit(1)
    }
    // (7) 藏起来的卡必须有回来的路。没有这条提示，隐藏就是「删除，但还占着导出」：
    // 卡片不在渲染里，框选和 ⌘A 都碰不到它。
    if (!/data-hidden-bar-show/.test(workspaceText)) {
      console.error('\nFAIL: 底栏没有「全部显示」的入口。')
      console.error('Hiding is a one-way door without it: a hidden card is out of the render,')
      console.error('out of the marquee and out of Cmd+A, so the user cannot get it back.')
      process.exit(1)
    }
    if (!/hiddenTotal > 0 \?/.test(workspaceText)) {
      console.error('\nFAIL: 隐藏提示不再按 hiddenCount 决定显不显示。')
      console.error('A permanent "0 cards hidden" strip on every canvas is noise that')
      console.error('teaches users to ignore the one time it matters.')
      process.exit(1)
    }
    // (8) 复制必须清标记（走 `withoutFlags`）。照抄会让新卡一出现就拖不动，或者
    // 粘贴完屏幕上什么都没有。
    const modelSource = readModuleSource('canvas/node-model.ts')
    if (!/metadata: withoutFlags\(/.test(modelSource)) {
      console.error('\nFAIL: 复制路径不再清掉 locked / hidden。')
      console.error('Duplicating a locked card must give a card the user can move;')
      console.error('duplicating a hidden one must not paste into apparent nothing.')
      process.exit(1)
    }
    // (9) 右键菜单也要有这两行：被锁住的那一刻，手指就在这张卡上。
    const menuSource2 = readModuleSource('canvas/context-menu.tsx')
    for (const key of ['setNodeLocked', 'setNodeHidden']) {
      if (!new RegExp(`A\\.${key}\\(`).test(menuSource2)) {
        console.error(`\nFAIL: 右键菜单缺了 ${key}。`)
        console.error('The card the user wants to lock is the card under the pointer;')
        console.error('the menu is the shortest path and the only one that does not need')
        console.error('a trip to the dock first.')
        process.exit(1)
      }
    }
    // 锁住的卡不该再提供「删除」：留一行按下去必然失败的菜单项，比少一行更糟。
    if (!/locked \? /.test(menuSource2) && !/isLocked\(/.test(menuSource2)) {
      console.error('\nFAIL: 右键菜单不再按锁定状态隐藏删除行。')
      console.error('A menu item that can only fail is worse than a missing one: the user')
      console.error('presses it, nothing happens, and the lock reads as broken.')
      process.exit(1)
    }
    console.log('lock/hide: one edit per click, render + marquee + delete + drag all agree, copies come back clean')
  }

  // ------------------------------------------------------ 吸附参考线：接线
  //
  // `snapGuides` 有 6 条单测钉住几何，但它们证明不了「画出来了」和「该消失时
  // 消失了」。参考线的两种坏法都很安静：
  //
  //  1. 线算出来了但没人渲染 → 吸附仍然生效，用户看到的还是「卡片自己跳了一下」，
  //     而这正是整件事要修的问题。
  //  2. 松手后线还留着 → 静止画布上一条红线会被读成一次真正的对齐结果，而它描述
  //     的只是上一帧的暂时状态。这比不画更坏。
  {
    if (!/renderSnapGuides\(\)/.test(workspaceText)) {
      console.error('\nFAIL: 画布不再渲染吸附参考线。')
      console.error('Without it snapping still works but stays invisible: the card jumps')
      console.error('by 3px and the user has no way to know why.')
      process.exit(1)
    }
    // 线按**落位之后**的位置算。拿未吸附的位置去算，会在吸附生效的那一帧漏掉
    // 线——而那恰好是用户唯一需要它的那一帧。
    if (!/snapGuides\(landed, others\)/.test(workspaceText)) {
      console.error('\nFAIL: 参考线不再按吸附后的位置计算。')
      console.error('Computing them from the un-snapped position drops the guide on the')
      console.error('exact frame the snap takes effect -- the only frame it matters.')
      process.exit(1)
    }
    // 只对着画面上的卡吸附与画线。藏起来的那张既不占视野，也不该产生一条指向
    // 空处的线。
    if (!/const others = visibleNodes\(documentRef\.current\?\.nodes \?\? \[\]\)\.filter/.test(workspaceText)) {
      console.error('\nFAIL: 吸附与参考线不再只看画面上的节点。')
      console.error('Snapping to a hidden card makes the dragged card stop at empty space;')
      console.error('and a guide to a card that is not drawn explains nothing.')
      process.exit(1)
    }
    // 松手必须清线。
    // 收尾锚在 `const connect = connectRef.current`（4 空格缩进）——它紧跟在拖动
    // 分支之后，所以这一段恰好是「松手时对拖动做的事」。不锚 `}, [deps])` 是因为
    // 中间还夹着连接、缩放、框选三个分支，那样会匹配到整个监听器。
    const upBlock = workspaceText.match(/const up = \(event: PointerEvent\): void => \{[\s\S]*?\n {6}const connect = connectRef\.current/)
    if (upBlock === null) {
      console.error('\nFAIL: 指针抬起分支找不到了；重新锚定这条守卫。')
      process.exit(1)
    }
    if (!/snapGuidesRef\.current = \[\]/.test(upBlock[0])) {
      console.error('\nFAIL: 松手之后吸附参考线还留在画布上。')
      console.error('A static red line reads as "these two edges are aligned", which is a')
      console.error('claim about the document -- but it only described the last frame.')
      process.exit(1)
    }
    console.log('snap guides: drawn from the snapped position, only against visible cards, cleared on release')
  }

  // ------------------------------------------------- 历史面板：跳转与键位
  //
  // (1) 点一行必须**先关面板再跳**。跳转会把选中清空、把文档换成另一版，而面板
  // 是浮在画布上的：留着它，用户看到的是「退回去了，但底下的画布还是刚才那张」，
  // 得再点一次关闭才知道自己退到哪了。找节点那条路径踩过同一个坑，规矩一样。
  if (!/onJump=\{\(stepsBack, nodeIds\) => \{ setHistoryOpen\(false\); jumpToHistoryStep\(stepsBack, nodeIds\) \}\}/.test(workspaceText)) {
    console.error('\nFAIL: 历史面板点一行时不再先关面板。')
    console.error('The jump replaces the document under an open overlay; leaving it up')
    console.error('means the user cannot see what they just went back to without')
    console.error('dismissing it first, and the next edit lands on the old map.')
    process.exit(1)
  }
  // (2) 一次回退 N 步必须是**一次**文档替换。逐帧调用 `undo()` 会让 React 在
  // 每一帧之后重渲染，而栈是同步变的、`document` state 不是——推演到第 3 帧时
  // `documentRef` 可能还是旧的，最后落下的文档就少退了几步。
  const jumpBlock = workspaceText.match(/const jumpToHistoryStep = useCallback\(\(stepsBack: number, nodeIds: readonly string\[\] = \[\]\): void => \{[\s\S]*?\n {2}\}, \[\]\)/)
  if (jumpBlock === null) {
    console.error('\nFAIL: jumpToHistoryStep 不见了；重新锚定这条守卫。')
    process.exit(1)
  }
  if ((jumpBlock[0].match(/setDocument\(/g)?.length ?? 0) !== 1) {
    console.error('\nFAIL: 回退多步不再是「一次文档替换」。')
    console.error('Calling undo() in a loop reads documentRef between frames, and that')
    console.error('ref lags the state it was set from — the last frame lands on the wrong')
    console.error('snapshot and the row the user clicked is not the row they get.')
    process.exit(1)
  }
  // 重做栈必须逐条回填：一次性丢一份「最终后态」会让 Ctrl+Shift+Z 直接跳回
  // 最新，中间那几步再也走不回来——而用户点历史行的目的往往只是「回到两步前
  // 看看」，不是「放弃后面全部」。
  if (!/for \(let index = past\.length - 1; index > past\.length - depth; index -= 1\) undone\.push/.test(jumpBlock[0])) {
    console.error('\nFAIL: 历史跳转不再逐条回填重做栈。')
    console.error('Redo must be able to walk back one step at a time; collapsing the')
    console.error('undone range into one entry turns "go back two steps" into "throw away')
    console.error('everything after that".')
    process.exit(1)
  }
  // (3) ⌥ 系列认 `event.code`。这条守的是一个**已经在线上死了整整一版**的分支：
  // macOS 按住 Option 时 `event.key` 是组合字符（⌥F 给 ƒ、⌥A 给 å、⌥H 给 ˙），
  // 所以 `altKey && key === 'f'` 永远不成立，按了没反应且没有任何报错。
  if (!/ALIGN_SHORTCUTS\[event\.code\]/.test(workspaceText)) {
    console.error('\nFAIL: 对齐快捷键不再按 event.code 判定。')
    console.error('On macOS Option turns the letter into a composed character (⌥F = ƒ),')
    console.error('so a key-based test silently never fires. Use the physical code.')
    process.exit(1)
  }
  if (/ALIGN_SHORTCUTS\[event\.key/.test(workspaceText)) {
    console.error('\nFAIL: 对齐快捷键又回到了 event.key。')
    console.error('See above: on macOS that branch is unreachable.')
    process.exit(1)
  }
  if (!/event\.altKey && event\.shiftKey && event\.code === 'KeyF'/.test(workspaceText)) {
    console.error('\nFAIL: ⌥⇧F 整理画布不再认 event.code。')
    console.error('This exact branch shipped dead once: it tested event.key === "f", which')
    console.error('macOS never produces while Option is held.')
    process.exit(1)
  }
  // (4) 坏快照必须截断而不是跳过。`stepsBack` 是「相对当前栈深」的偏移，跳过
  // 一格会让下面每一行的偏移都比真实步数小一——点一行退错步，比少几行危险。
  // historyRows 单独读这个模块，且**故意不走** readSourceText：行尾归一化本身就是
  // 另一条反向用例的靶子（把它改坏要让契约报「读不到文案」）。在这里复用它，那
  // 条用例会先撞上这条守卫，报出一个与行尾毫无关系的错——RED but wrong reason。
  const historyModel = readFileSync(new URL('../src/client/canvas/history-model.ts', SCRIPT_DIR), 'utf8')
  const rowsBlock = historyModel.match(/export function historyRows\([\s\S]*?\r?\n\}\r?\n/)
  if (rowsBlock === null) {
    console.error('\nFAIL: historyRows 不见了；重新锚定这条守卫。')
    process.exit(1)
  }
  if (!/catch \{\s*\n\s*break/.test(rowsBlock[0])) {
    console.error('\nFAIL: 历史列表遇到坏快照不再截断。')
    console.error('Skipping one frame shifts every row below it by one step, so a click')
    console.error('lands on the wrong snapshot — worse than showing fewer rows.')
    process.exit(1)
  }
  // (5) 退回去之后必须**选中这一步动过的卡**，且只能选中目标文档里还活着的那些。
  // 两个坏法各有一条：不选 —— 用户退回去看到一张不太一样的画布，得自己在上百
  // 张卡里找回刚被撤掉的是哪几张；不筛 —— 「删除」类步骤点名的节点在目标文档
  // 里已经不存在，selectedIds 里塞进幽灵 id 会让删除按钮亮着、画布上一张卡不亮。
  if (!/setSelectedIds\(new Set\(nodeIds\.filter\(id => alive\.has\(id\)\)\)\)/.test(jumpBlock[0])) {
    console.error('\nFAIL: 退回历史后不再选中这一步动过的卡，或没与目标文档求交。')
    console.error('Selection is the only thing that tells the user WHICH cards the step')
    console.error('they just took back was about; and ids from the snapshot may name nodes')
    console.error('that no longer exist in the restored document.')
    process.exit(1)
  }
  // (6) 悬停预览必须由面板说出来、由画布画出来，且**不改文档**。
  // 预览若走 `mutate`，一次悬停就会压进一条撤销记录——用户只是把鼠标划过那张
  // 表，撤销栈里就多出几十条什么都没改的步骤。
  if (!/onHover=\{setHistoryPreviewIds\}/.test(workspaceText)) {
    console.error('\nFAIL: 历史面板的悬停不再把这一步的节点告诉画布。')
    console.error('Without it the preview either does not exist, or the panel has to reach')
    console.error('into the canvas itself — and a panel that mutates the document on hover')
    console.error('pushes one undo step per pixel of mouse travel.')
    process.exit(1)
  }
  if (!/const \[historyPreviewIds, setHistoryPreviewIds\] = useState/.test(workspaceText) ||
      !/isHistoryPreview \? css\.nodeHistoryPreview/.test(workspaceText)) {
    console.error('\nFAIL: 悬停预览的 state 或类名接丢了。')
    console.error('The panel would announce a preview that nothing draws.')
    process.exit(1)
  }
  // 预览的样式必须是 outline：虚线描边若用 box-shadow / border，会改变节点的
  // 视觉边界甚至盒模型，悬停时画布会抖一下，而那正是「预览」最不该有的效果。
  const previewCss = readSourceText(new URL('../src/client/canvas-workspace.module.css', SCRIPT_DIR))
  const previewRule = previewCss.match(/\.nodeHistoryPreview \{[^}]*\}/)
  if (previewRule === null || !/outline: 2px dashed var\(--dsw-alias-brand-primary\)/.test(previewRule[0])) {
    console.error('\nFAIL: 历史预览的描边不再是一条 outline。')
    console.error('A border or box-shadow shifts or thickens the card while the pointer')
    console.error('moves across a table of rows — the canvas twitches on every hover.')
    process.exit(1)
  }
  // 两个出口都要清预览：Esc 关面板、点一行跳走。少一处，虚线圈就永远留在画布上。
  const previewClears = workspaceText.match(/setHistoryPreviewIds\(null\)/g)?.length ?? 0
  if (previewClears < 3) {
    console.error(`\nFAIL: 清掉历史预览的地方只剩 ${previewClears} 处（至少要 Esc、跳转、面板关闭三条路）。`)
    console.error('Every path that closes the panel has to clear it: the ring has no other')
    console.error('owner, so a missed path leaves it painted on the canvas for good.')
    process.exit(1)
  }
  console.log('history: the row closes the panel first, one document write, redo rebuilds one step at a time')
  console.log('history preview: the panel announces it, the canvas draws a dashed outline, nothing is written')
  // (7) 文案里不许写死键位。`canvas.duplicate` 曾经是「创建副本 (Ctrl+D)」——
  // 在 macOS 上用户按 ⌘D，读到的是 Ctrl+D；而目录按 labelKey 反查键位时也
  // 对不上（那里查的是 label/action，文案里的括号不是数据）。键位只有一处
  // 来源：快捷键表，由 `labelWithKeys` / 目录徽章补。
  const localesSource = readSourceText(new URL('../src/client/locales.ts', SCRIPT_DIR))
  // 只扫单键位文案（标题行里「(Ctrl+…)」这种形状）。错误提示里提到某个键是
  // 合理的，那种句子不会是一条例子的全部。
  const hardCodedKeys = [...localesSource.matchAll(/^\s*'[^']+': '([^']*\(Ctrl\+[A-Z][^']*)',$/gm)].map(match => match[1])
  if (hardCodedKeys.length > 0) {
    console.error(`\nFAIL: ${hardCodedKeys.length} 条文案把键位写死在了句子里：`)
    for (const line of hardCodedKeys) console.error(`  - ${line}`)
    console.error('On macOS the key is ⌘, not Ctrl, so the sentence is wrong there; and the')
    console.error('catalog looks the key up by label, which never reads the parenthesis.')
    process.exit(1)
  }
  // (8) 每一条被目录用到的动作，快捷键表里必须能按 label 或 action 反查到。
  // `canvas.paste` / `canvas.duplicate` 曾经只写在 label 上，目录拿 labelKey 去
  // 查，两行因此永远没有徽章——看起来像「这两个动作没有快捷键」。
  const shortcutSource = readModuleSource('ShortcutHelp.tsx')
  const shortcutEntries = [...shortcutSource.matchAll(/\{ keys: \[[^\]]*\], label: '([^']+)'(?:, action: '([^']+)')? \}/g)]
  const shortcutNames = new Set(shortcutEntries.flatMap(match => [match[1], match[2]].filter(Boolean)))
  const catalogLabelKeys = [...catalogSource.matchAll(/^ {4}labelKey: '([^']+)',$/gm)].map(match => match[1])
  const missingActions = ['canvas.paste', 'canvas.duplicate', 'canvas.delete', 'canvas.undo', 'canvas.redo']
    .filter(key => catalogLabelKeys.includes(key) && !shortcutNames.has(key))
  if (missingActions.length > 0) {
    console.error(`\nFAIL: 目录里这几行的键位查不到：${missingActions.join(', ')}`)
    console.error('The catalog asks shortcutKeysFor(labelKey); a binding that names only a')
    console.error('different label reads as "this action has no shortcut".')
    process.exit(1)
  }
  // (9) 右键菜单与节点工具条上的「创建副本」也必须走 labelWithKeys：它们与目录
  // 是同一个动作，键位却来自同一个函数——三处各写一遍必然有人漏，而漏掉的那处
  // 会显示一个过时的键位（或者没有）。
  for (const [file, pattern] of [
    ['canvas/context-menu.tsx', /label: S\.labelWithKeys\('canvas\.duplicate'\)/],
    ['canvas/node-body.tsx', /label=\{S\.labelWithKeys\('canvas\.duplicate'\)\}/],
  ]) {
    const source = readModuleSource(file)
    if (!pattern.test(source)) {
      console.error(`\nFAIL: ${file} 里的「创建副本」不再从快捷键表取键位。`)
      console.error('A literal key in the label goes stale the moment the binding moves,')
      console.error('and on macOS it was already the wrong modifier.')
      process.exit(1)
    }
  }
  console.log('shortcut keys: no literal key in any label; every catalog action resolves; the menus read the same table')
  console.log('keyboard: ⌥ shortcuts match on event.code (the key is a composed char on macOS)')
}

// ------------------------------- 生成输入条不能压住底栏那两条药丸
//
// 这一条来自真机截图：多选时对齐条渲染出来了，八枚按钮却全在生成输入条底下，
// 只露出左边半句「对齐 2 个节点」。原因是输入条决定「翻到节点上方还是留在
// 下方」时用了一个硬编码的 170px，而多选让底栏整行多出两条药丸的高度。
//
// jsdom 没有布局引擎（所有 rect 都是 0），真浏览器守卫里输入条又需要真实节点
// 位置才能复现，所以这里守的是那条**判据**：可用的纵向空间必须扣掉实测的底栏
// 高度，而不是一个常量。
{
  const composerSource = readModuleSource('canvas/composer.tsx')
  if (!/170 \+ S\.chromeHeight/.test(composerSource)) {
    console.error('\nFAIL: 生成输入条的翻转判据不再扣掉底栏的实测高度。')
    console.error('When the compose strip or the align bar appears, the chrome row grows')
    console.error('upward; a constant threshold then puts the composer on top of those')
    console.error('buttons and a click meant for 左对齐 lands in the prompt field.')
    process.exit(1)
  }
  // 那个高度必须是**量出来的**：`chromeHeight` 由 ResizeObserver 读
  // `.canvasChrome` 及其子元素得到。写死一个「够用的」数字迟早又不准。
  // 每一个子元素都要参与测量：`slice(-1)` / `filter` 这种「只看最后一格」的写法
  // 会让药丸出现时没人重新量（底栏是最后一个子元素，永远量得到，缺口永远看不见）。
  const everyChildMeasured = /const tops = \[\.\.\.chrome\.children\]\s*\n\s*\.map\(child => child\.getBoundingClientRect\(\)\)/.test(workspaceText)
  if (!everyChildMeasured || !/viewportBox\.bottom - Math\.min\(\.\.\.tops\)/.test(workspaceText)) {
    console.error('\nFAIL: chromeHeight 不再按底栏真正的最高成员测量。')
    console.error('It must cover the align bar / compose strip too, and those are')
    console.error('conditionally rendered, so a constant or a dock-only measurement')
    console.error('silently stops reserving the space the moment they appear.')
    process.exit(1)
  }
  // 两条药丸是条件渲染的，观测那一刻它们可能还不存在；出现时必须重新收集子元素。
  if (!/\}, \[selectedNodeCount, composeIds\.length\]\)/.test(workspaceText)) {
    console.error('\nFAIL: 底栏高度不再随两条药丸的出现重新测量。')
    console.error('ResizeObserver only watches the children that existed when it was')
    console.error('created; a strip that appears later is never observed, so the composer')
    console.error('goes on believing those 40px are free canvas.')
    process.exit(1)
  }
  console.log('composer: the flip threshold reserves the measured chrome height, strips included')
}

if (CHROME === null) skipWithoutChrome('the UI contract guards did NOT run.')

const clientDir = new URL('../src/client/', import.meta.url)
// Every source read below feeds a regex, so it goes through `readSourceText`:
// a Windows checkout is CRLF and the cross-line patterns here are written with
// `\n`. Normalising at the read is what makes a newly added pattern correct by
// default, instead of leaving each one to remember `\r?`.
// CanvasWorkspace.tsx 正在被拆成 canvas/ 下的模块，这两条断言问的是「这段代码
// 还在不在」，不是「它是否恰好在那个文件里」——所以走聚合读取，搬迁不用改测试。
const read = name => name === 'CanvasWorkspace.tsx' ? canvasSourceText() : readSourceText(new URL(name, clientDir))

// --------------------------------------------------------------- 3. stacking
// Pure source invariant: every layer must read a scale variable, and the scale
// must not hand two unrelated layers the same number.
const CSS_FILES = readdirSync(clientDir).filter(name => name.endsWith('.module.css'))
const literalZ = []
for (const name of CSS_FILES) {
  const source = read(name)
  source.split('\n').forEach((line, index) => {
    const match = line.match(/z-index:\s*(-?\d+)/)
    // GooeyNav's own particle/pill layering is internal to one component and
    // deliberately literal: it never competes with another module's layer, and
    // the negative values are part of its gooey filter trick.
    if (match !== null && name !== 'GooeyNav.module.css') {
      literalZ.push(`${name}:${index + 1} (${match[0].trim()})`)
    }
  })
}
if (literalZ.length > 0) {
  console.error('\n' + '='.repeat(72))
  console.error('FAIL: z-index literals are back in the module stylesheets.')
  console.error('Every layer must read the shared scale, or two modules will drift')
  console.error('onto the same number again and the winner becomes document order:')
  for (const entry of literalZ) console.error(`  - ${entry}`)
  console.error('='.repeat(72) + '\n')
  process.exit(1)
}
console.log(`no z-index literals outside GooeyNav.module.css (${CSS_FILES.length} stylesheets scanned)`)

const scale = read('panel.module.css')
const declared = new Map()
for (const match of scale.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)) {
  const value = Number(match[2])
  if (!declared.has(value)) declared.set(value, [])
  declared.get(value).push(match[1])
}
const collisions = [...declared.entries()].filter(([, names]) => names.length > 1)
if (collisions.length > 0) {
  console.error('\nFAIL: two scale entries share a number, which is the bug the scale exists to prevent:')
  for (const [value, names] of collisions) console.error(`  ${value}: ${names.join(', ')}`)
  process.exit(1)
}
console.log(`z-index scale: ${declared.size} distinct rungs, no collisions`)

// Every `var(--z-*)` used anywhere must be declared in the scale.
const usedVars = new Set()
for (const name of CSS_FILES) {
  for (const match of read(name).matchAll(/var\((--z-[a-z-]+)/g)) usedVars.add(match[1])
}
const undeclared = [...usedVars].filter(name => !scale.includes(`${name}:`))
if (undeclared.length > 0) {
  console.error(`\nFAIL: layers reference scale entries that are never declared: ${undeclared.join(', ')}`)
  console.error('An undeclared variable resolves to nothing, so the element gets z-index:auto')
  console.error('and silently falls to the bottom of the stack.')
  process.exit(1)
}
console.log(`all ${usedVars.size} referenced scale entries are declared`)

// The doc table above the scale is the contract: it says which number each rung
// holds and why. It has to match the declarations, because the table is what a
// future author reads before choosing a rung -- a table that disagrees with the
// code is worse than no table. Both directions are checked, so a renamed rung
// cannot be left behind in the prose.
const rungValue = new Map()
for (const match of scale.matchAll(/--z-([a-z-]+):\s*(\d+);/g)) rungValue.set(match[1], Number(match[2]))
const tableRungs = new Map()
for (const line of scale.split('\n')) {
  // ` *   60  takeover          ...` -- the number/name columns of the table.
  const match = line.match(/^\s*\*\s+(\d+)\s+([a-z][a-z0-9-]*)\s\s/)
  if (match !== null) tableRungs.set(match[2], Number(match[1]))
}
const tableMismatch = []
for (const [name, value] of rungValue) {
  if (!tableRungs.has(name)) tableMismatch.push(`--z-${name} is declared ${value} but absent from the doc table`)
  else if (tableRungs.get(name) !== value) tableMismatch.push(`--z-${name}: table says ${tableRungs.get(name)}, declaration says ${value}`)
}
for (const name of tableRungs.keys()) {
  if (!rungValue.has(name)) tableMismatch.push(`${name} is documented but never declared`)
}
if (tableMismatch.length > 0) {
  console.error('\nFAIL: the stacking-order documentation does not match the declarations:')
  for (const entry of tableMismatch) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log(`stacking table matches all ${rungValue.size} declarations`)

// ------------------------------------------------- 4. the template source row
// The registry holds eight sources plus favorites. Each tab is `nowrap`, and
// a plain flex row neither wraps nor scrolls, so a tab past the right edge is
// simply unreachable -- no scrollbar, no wrap, nothing to click. Both halves
// are required: scroll on the row, and no shrink on the tabs, because a tab
// allowed to shrink truncates its own label and its count badge instead.
const templatesCss = read('templates.module.css')
const ruleOf = (source, selector) => {
  const at = source.indexOf(`${selector} {`)
  if (at < 0) return ''
  return source.slice(at, source.indexOf('}', at) + 1)
}
const tabRow = ruleOf(templatesCss, '.sourceTabs')
const tabRule = ruleOf(templatesCss, '.sourceTab')
if (!/overflow-x:\s*(auto|scroll)/.test(tabRow) || !/overflow-y:\s*hidden/.test(tabRow)) {
  console.error('\nFAIL: the template source row can no longer scroll.')
  console.error('Its tabs are `white-space: nowrap`, and a flex row that does not')
  console.error('scroll clips everything past the right edge: with the sources that')
  console.error('are registered now, the later tabs are unreachable -- they cannot be')
  console.error('clicked, and nothing on screen says they exist.')
  process.exit(1)
}
if (!/flex:\s*none/.test(tabRule)) {
  console.error('\nFAIL: template source tabs are allowed to shrink.')
  console.error('A shrunk tab truncates its own label and count badge rather than')
  console.error('letting the row scroll, so the source stays unreadable.')
  process.exit(1)
}
// The row has to be built FROM the registry, not from a hand-written list: a
// source that is registered but has no tab is a library the user cannot open,
// and the browser fixture below can only be as complete as this mapping.
// The slice stops at the next sibling element: `TEMPLATE_SOURCES.map` appears
// again further down the file (the favorites view groups by source), and a
// slice running to EOF would match THAT call and pass no matter what the tab
// row did -- a check that can never fail.
const librarySource = readSourceText(new URL('TemplateLibrary.tsx', clientDir))
const tablistAt = librarySource.indexOf('className={css.sourceTabs}')
const tablistEnd = librarySource.indexOf('css.toolbar', tablistAt)
const tabRowSource = tablistAt < 0 || tablistEnd < 0 ? '' : librarySource.slice(tablistAt, tablistEnd)
if (!/TEMPLATE_SOURCES\.map\(/.test(tabRowSource)) {
  console.error('\nFAIL: the source row no longer renders one tab per registered source.')
  console.error('The registry is the list of libraries the user can open; a tab row built')
  console.error('from anything else leaves registered sources unreachable.')
  process.exit(1)
}
// Every registered source must actually be loadable, or its tab renders an
// empty library. This is the seam the sources were added along.
const protocolSource = readSourceText(new URL('protocol.ts', new URL('../src/', import.meta.url)))
const storeSource = readSourceText(new URL('templates-store.ts', new URL('../src/', import.meta.url)))
const registered = [...protocolSource.matchAll(/^\s{4}id:\s*'([a-z0-9-]+)',/gm)].map(match => match[1])
// The label of each source, so the browser fixture below renders the REAL tab
// labels instead of a hand-written list that would go stale the moment a source
// is added -- a fixture stuck at eight tabs stops testing the ninth.
const registeredLabels = [...protocolSource.matchAll(/^\s{4}id: '([a-z0-9-]+)',\n\s{4}label: '([^']+)',/gm)].map(match => [match[1], match[2]])
if (registeredLabels.length !== registered.length) {
  console.error('\nFAIL: a template source has no readable label, so the tab-row fixture cannot be built from the registry.')
  process.exit(1)
}
// SOURCE_DEFS entries do not all lead with `bundledPath` (vibeui and canghe
// start with `listUrl`), so match each top-level entry and then ask whether its
// body declares one -- keying on the first line missed exactly those two.
const hostDefBodies = new Map()
for (const match of storeSource.matchAll(/^ {2}'?([a-z0-9-]+)'?:\s*\{\n([\s\S]*?)^ {2}\},/gm)) {
  hostDefBodies.set(match[1], match[2])
}
const missing = registered.filter(id => !(hostDefBodies.get(id) ?? '').includes('bundledPath:'))
if (registered.length === 0 || missing.length > 0) {
  console.error(`\nFAIL: a registered template source has no host-side fetch definition: ${missing.join(', ')}`)
  console.error('Its tab would render an empty library with no error to explain it.')
  process.exit(1)
}
const snapshotFileOf = id => new URL(
  `../src/templates/${id === 'vibeui' ? 'cases' : id === 'canghe' ? 'canghe-cases' : `${id}-cases`}.json`,
  import.meta.url,
)
for (const id of registered) {
  const snapshot = snapshotFileOf(id)
  if (!existsSync(snapshot)) {
    console.error(`\nFAIL: source "${id}" has no bundled snapshot at src/templates/.`)
    console.error('A source ships its snapshot with the release; without one the tab is empty offline.')
    process.exit(1)
  }
}

// And the images must be servable by the gate that will actually serve them.
// This is deliberately read out of SOURCE_DEFS rather than repeated here: a
// copy of the host list would agree with itself forever while the real gate
// said something else, which is exactly how a source ships cards whose images
// can never load. A bare file name needs `imageBaseUrl`; an absolute URL needs
// its hostname in `allowedImageHosts`.
const hostProblem = []
for (const id of registered) {
  const body = hostDefBodies.get(id) ?? ''
  const allowed = [...(/allowedImageHosts:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1])
  const hasBase = /imageBaseUrl:/.test(body)
  const snapshot = JSON.parse(readFileSync(snapshotFileOf(id), 'utf8'))
  for (const entry of snapshot.cases ?? []) {
    const image = typeof entry.image === 'string' ? entry.image.trim() : ''
    if (image === '') continue
    if (!/^https?:\/\//i.test(image)) {
      if (!hasBase) hostProblem.push(`${id}/${entry.id}: bare file name "${image}" but the source declares no imageBaseUrl`)
      continue
    }
    let hostname
    try { hostname = new URL(image).hostname.toLowerCase() } catch { hostProblem.push(`${id}/${entry.id}: unparseable image URL ${image}`); continue }
    if (!allowed.includes(hostname)) {
      hostProblem.push(`${id}/${entry.id}: image host ${hostname} is not in allowedImageHosts [${allowed.join(', ')}]`)
    }
  }
}
if (hostProblem.length > 0) {
  console.error('\nFAIL: a bundled snapshot carries images its source will refuse to serve.')
  console.error('readTemplateImage drops any reference whose host is not allowed, so these')
  console.error('cards render a broken thumbnail no matter how good the network is:')
  for (const entry of hostProblem.slice(0, 12)) console.error(`  - ${entry}`)
  if (hostProblem.length > 12) console.error(`  … and ${hostProblem.length - 12} more`)
  process.exit(1)
}

// ------------------------------------------------- 5. ecommerce card headings
// `.ecommerceSection h3` lays the title and its `small` hint out as a flex row
// (`display:flex`, `gap:7px`). Left to itself the title's bare text becomes an
// anonymous flex item that SHRINKS to make room for the hint: at the default
// 300px config column the available line is ~196px and the title was squeezed
// to ~69px, one pixel short of "主图参考图" (70px), so every card heading wrapped
// to two lines while the hint beside it was merely cut off.
//
// The hint's own `text-overflow: ellipsis` did not help either: a flex item's
// default `min-width:auto` refuses to shrink below its content, which made the
// ellipsis dead code — the text was clipped mid-character with no visual cue.
//
// Source-level on purpose: this is decided by how the two rules divide the
// line, and the browser fixture below cannot see the ecommerce panel at all.
const panelCss = read('panel.module.css')
const titleRule = ruleOf(panelCss, '.ecommerceSectionTitle')
const hintRule = ruleOf(panelCss, '.ecommerceSectionHint')
if (!/flex:\s*none/.test(titleRule)) {
  console.error('\nFAIL: the ecommerce card title is allowed to shrink.')
  console.error('The card head is a flex row, so a shrinkable title gives up its width')
  console.error('to the hint beside it and wraps: "主图参考图" needs 70px and was left 69px.')
  process.exit(1)
}
if (!/min-width:\s*0/.test(hintRule)) {
  console.error('\nFAIL: the ecommerce card hint cannot shrink, so its ellipsis never renders.')
  console.error('A flex item defaults to `min-width: auto`; without an explicit 0 the hint')
  console.error('is clipped mid-character instead of ending in "…".')
  process.exit(1)
}
// The rule only works if the title text is wrapped in the span that carries it.
// A bare text node in the flex row has no class to target, so the `flex: none`
// above would apply to nothing and the wrap returns silently.
//
// Only headings that actually carry a hint are in scope: the ones without one
// ("参数信息", "套图结果", …) have nothing competing for the line, so wrapping
// them would add markup that earns nothing.
const ecommerceCards = [...read('ImageGenPanel.tsx').matchAll(/<h3>(.*?)<\/h3>/gs)]
  .map(match => match[1])
  .filter(inner => inner.includes('css.ecommerceSectionHint}'))
const unwrapped = ecommerceCards.filter(inner => !inner.startsWith('<span className={css.ecommerceSectionTitle}>'))
if (ecommerceCards.length === 0 || unwrapped.length > 0) {
  console.error('\nFAIL: an ecommerce card heading renders its title outside the no-shrink span.')
  console.error('`flex: none` on .ecommerceSectionTitle cannot reach a bare text node,')
  console.error(`so that heading wraps again. Offenders: ${String(unwrapped.length)} of ${ecommerceCards.length}.`)
  process.exit(1)
}
console.log(`ecommerce card headings: title no-shrink in ${ecommerceCards.length} cards, hint ellipsis live`)

// A repository that declares no licence cannot have its images redistributed by
// pointing shipped data at them. `songguoxs/gpt4o-image-prompts` is the one case
// of this: six prompt-signal cases once carried its preview URLs. The prompt text
// in those cases is the original authors' own and stays; the image reference is
// cleared by `scripts/fetch-templates.mjs` and must not come back through a
// regeneration that forgets the filter.
//
// Checked against the shipped snapshot, not against the fetch script, because a
// filter that exists but was not applied is the exact failure being guarded.
const UNLICENSED_IMAGE_OWNERS = new Set(['songguoxs'])
const unlicensedImages = []
for (const id of registered) {
  const snapshot = JSON.parse(readFileSync(snapshotFileOf(id), 'utf8'))
  for (const entry of snapshot.cases ?? []) {
    const image = typeof entry.image === 'string' ? entry.image : ''
    if (!/^https?:\/\//i.test(image)) continue
    let url
    try { url = new URL(image) } catch { continue }
    const segments = url.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase())
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/... and github.com/<owner>/<repo>/...
    if (segments.length >= 2 && UNLICENSED_IMAGE_OWNERS.has(segments[0])) {
      unlicensedImages.push(`${id}/${entry.id}: ${image}`)
    }
  }
}
if (unlicensedImages.length > 0) {
  console.error('\nFAIL: a shipped snapshot points an image at a repository that grants no licence.')
  console.error('Those URLs are part of the distributed data, which makes them this project\'s')
  console.error('redistribution question, not the upstream aggregator\'s. The prompt text and the')
  console.error('author link stay; the preview image has to be cleared:')
  for (const entry of unlicensedImages.slice(0, 8)) console.error(`  - ${entry}`)
  if (unlicensedImages.length > 8) console.error(`  … and ${unlicensedImages.length - 8} more`)
  process.exit(1)
}
console.log(`template source row: ${registered.length} sources, scrollable, every snapshot image inside its source's allowlist`)

// The orderings that must hold, written as requirements rather than as numbers.
// This guards the failure that actually happened: a rewrite that renumbers "by
// role" looks tidy and silently re-stacks the UI. The select menu fell from
// 1000 to 60 and rendered UNDER the modal that contained it. Each pair below is
// a comparison such a rewrite broke, or would break.
const ordering = [
  ['select-menu', 'modal-picker', 'a Select dropdown portals to <body>, so it must clear the modal that contains it'],
  ['modal-picker', 'popover-raised', 'the provider picker opens from the settings card, over the skills popover'],
  ['modal-picker', 'lightbox', 'the provider picker opens from the settings card, over the full-screen preview'],
  ['lightbox', 'media-viewer', 'the image lightbox sits above the in-canvas video preview'],
  ['menu-flyout', 'menu-raised', 'the model flyout is a child of the model menu'],
  ['menu-raised', 'modal-backdrop', 'the model picker must clear the template library it can open over'],
  ['modal-backdrop', 'modal', 'the library backdrop sits above the settings editor backdrop'],
  ['chat-resizer', 'takeover', 'the resize handle belongs to the column the panel takes over'],
  ['picker-backdrop', 'notice', 'the picker backdrop must cover the canvas notice (was a 60/60 tie)'],
  ['notice', 'takeover', 'the canvas notice sits inside the panel container'],
  ['scrim', 'takeover', 'the canvas modal scrim covers the whole panel it is opened over'],
  ['context-menu', 'scrim', 'the canvas context menu draws above the scrim it opened with'],
  ['popover-raised', 'scrim', 'the skills menu draws over its own scrim'],
  ['file-overlay', 'popover-raised', 'the file reader covers the skills popover'],
  ['diagnostics', 'file-overlay', 'the diagnostics record is a studio-wide overlay, so it covers the file reader'],
  ['diagnostics', 'context-menu', 'the diagnostics overlay is studio-wide, so it covers the canvas context menu anchored inside the studio'],
  ['takeover', 'dock-raised', 'the panel container covers the compose strip'],
  ['dock-raised', 'dock', 'the compose strip draws over the dock it floats above'],
  ['topbar', 'dock', 'the canvas top bar draws over the docks below it'],
  ['anchored-menu', 'topbar', 'the canvas background menu draws over the top bar'],
  ['panel-header', 'marquee', 'the panel header must stay over the canvas'],
  ['marquee', 'inline-popover', 'the marquee draws over a form popover'],
  ['inline-popover', 'tray', 'a form popover draws over the task tray'],
  ['tray', 'badge', 'the task tray draws over node badges'],
  ['badge', 'hover', 'node badges draw over hover toolbars'],
  ['hover', 'content-raised', 'toolbars draw over the handles they sit on'],
  ['content-raised', 'content', 'handles draw over the content they resize'],
  ['content', 'canvas-links', 'connection lines draw under the nodes they join'],
]
const broken = []
for (const [above, below, why] of ordering) {
  const a = rungValue.get(above)
  const b = rungValue.get(below)
  if (a === undefined) broken.push(`--z-${above} is not declared`)
  else if (b === undefined) broken.push(`--z-${below} is not declared`)
  else if (!(a > b)) broken.push(`--z-${above} (${a}) must be above --z-${below} (${b}) -- ${why}`)
}
if (broken.length > 0) {
  console.error('\nFAIL: the stacking order is wrong:')
  for (const entry of broken) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log(`stacking order holds for ${ordering.length} required comparisons`)

// Absolute-value pins for the layers whose exact number is load-bearing, i.e.
// anything that has to interleave with a layer owned by ANOTHER plugin or by
// the host shell. The ordering checks above cannot see those: the counterpart
// layer is not in this scale, so a rewrite could move the whole scale and still
// satisfy every relative assertion. These are the values the layers had before
// the scale existed; changing one is a deliberate decision, not a tidy-up.
//   takeover   60 -- the panel container; sibling panels (task board, ssh) and
//                    the shell's own column rules were written against it
//   lightbox  1000 -- full-screen image preview, interleaves with the host's
//                    own overlays
//   guide     1100 -- the config guide, meant to sit above the plugin's own
//                    fullest surface but below the host's dialogs
const pinned = [['takeover', 60], ['lightbox', 1000], ['guide', 1100]]
const moved = pinned.filter(([name, value]) => rungValue.get(name) !== value)
if (moved.length > 0) {
  console.error('\nFAIL: a layer that interleaves with the host changed its number:')
  for (const [name, value] of moved) console.error(`  --z-${name}: expected ${value}, found ${rungValue.get(name)}`)
  console.error('These numbers are shared with panels this plugin does not own.')
  console.error('Move one only on purpose, and update the host-facing comment with it.')
  process.exit(1)
}
console.log(`host-facing rungs pinned: ${pinned.map(([name, value]) => `${name}=${value}`).join(', ')}`)

// ------------------------------------------------- 3b. the host's window seat
// On macOS the shell mounts `[data-shell-leading]` at the frame's top-left when
// the sidebar is collapsed — it holds 打开侧边栏 and New Session. The shell draws
// it at z-index 15 and publishes no variable to change that, so the only way the
// studio (takeover 60) can avoid swallowing it is a rule of our own.
// This is the failure that happened: 会话 kept its reopen control because its
// view is `display: none`, and 生图 covered the same control, leaving no visible
// way back to a wide sidebar. Neither the ordering table nor the pins can see
// it — the seat is not in this scale at all — so it is asserted separately: the
// rule that lifts the seat, and the rung it points at.
const seatRule = /\[data-platform=['"]darwin['"]\]\s*\[data-shell-leading\]\s*\{\s*z-index:\s*var\(--z-shell-seat\)/
const seatRung = rungValue.get('shell-seat')
if (seatRung === undefined) {
  console.error('\nFAIL: --z-shell-seat is not declared: the shell window seat has no layer of its own.')
  process.exit(1)
}
if (!seatRule.test(read('panel.module.css'))) {
  console.error('\nFAIL: the shell window seat is not lifted above the studio takeover.')
  console.error('Without it, collapsing the sidebar in 生图 hides 打开侧边栏 behind the panel (z-index 15 vs 60).')
  process.exit(1)
}
const takeoverRung = rungValue.get('takeover')
if (!(seatRung > takeoverRung)) {
  console.error(`\nFAIL: --z-shell-seat is ${seatRung}, not above the studio takeover (${takeoverRung}).`)
  process.exit(1)
}
console.log(`shell window seat sits above the takeover: --z-shell-seat ${seatRung} > --z-takeover ${takeoverRung}`)

// ------------------------------------------------------- 4. focusable hiding
// `opacity: 0` and `pointer-events: none` both leave an element in the tab
// order. The node toolbars are hidden with those two, so without a rule that
// actually removes them from the tab order every node contributes 5-10
// invisible focus stops -- and Enter on one of them fires the button, including
// delete. This is a source invariant (a browser cannot see "these two rules
// were meant to pair up"), so it is checked from the source.
const canvasSheet = read('canvas-workspace.module.css')
// Comments are stripped first, and that is not tidiness: the rule's own
// explanation contains the literal string `visibility: hidden`, so a check that
// greps the raw text keeps passing after the declaration itself is deleted --
// the comment vouches for the code it describes. (Caught by negative
// verification: the mutation removed the declaration and the check stayed green.)
const canvasRules = canvasSheet.replace(/\/\*[\s\S]*?\*\//g, '')
const toolbarBlock = canvasRules.match(/\.hoverToolbar\s*\{[^}]*\}/)?.[0] ?? ''
if (!/visibility:\s*hidden/.test(toolbarBlock)) {
  console.error('\nFAIL: the node hover toolbar no longer leaves the tab order when hidden.')
  console.error('`opacity: 0` + `pointer-events: none` keep it focusable, so keyboard')
  console.error('users tab onto controls that are not on screen.')
  process.exit(1)
}
if (!/\.node:focus-within\s+\.hoverToolbar/.test(canvasRules)) {
  console.error('\nFAIL: nothing reveals the node toolbar when it is reached by keyboard.')
  console.error('Focus is the third way in (after hover and selection); without it the')
  console.error('toolbar is focusable but permanently invisible.')
  process.exit(1)
}
console.log('node toolbars leave the tab order when hidden and reveal on focus')

// ------------------------------------------------------- 1 & 2. real browser
// The page reproduces the two subjects with the REAL stylesheets: the GooeyNav
// container (theme attribute flipped at runtime) and the canvas root that
// declares the annotation token.
const gooeyCss = read('GooeyNav.module.css')
const canvasCss = read('canvas-workspace.module.css')
/**
 * The stylesheet as a BROWSER sees it.
 *
 * `.module.css` is not CSS: `:global(selector)` is a CSS Modules escape that the
 * build strips. Dropped into a `<style>` tag verbatim it is an invalid selector,
 * so the whole rule is discarded — silently, with no console error. A fixture
 * that embeds the raw file therefore measures a page missing every `:global`
 * rule, and a `:global(body[data-ds-dark-theme]) .root` override simply does not
 * exist: the dark theme renders the light values and the check reports a failure
 * that the real build does not have. Worse in the other direction too — a rule
 * that only works because of `:global` would look broken here and be "fixed"
 * into `:local`.
 */
const browserCss = css => css.replace(/:global\(([^)]*)\)/g, '$1')
const imageOpsSource = read('image-ops.ts')
const gooeySource = read('GooeyNav.tsx')

// The GooeyNav contract is that the SUBSCRIPTION fires, and that lives in
// surface-theme.ts. Injecting the stylesheet alone cannot observe it: the
// `data-theme` attribute is set by the component's own callback, so a
// CSS-only page reports `undefined` for it and the check passes vacuously.
// The real module is transpiled and loaded into the page instead, and driven
// exactly the way GooeyNav wires it.
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const themeModuleDir = join(tmpdir(), `dsh-surface-theme-${process.pid}`)
mkdirSync(themeModuleDir, { recursive: true })
// `node <tsc's own JS entry>`, never `node_modules/.bin/tsc`. On Windows that
// .bin entry is a POSIX shell script with `.CMD` and `.ps1` shims beside it, so
// spawnSync on the extensionless name fails with EACCES or ENOENT -- and the
// guard then reports "could not transpile surface-theme.ts", which reads like a
// fault in the source instead of in the way it was invoked.
const TSC = join(projectRoot, 'node_modules/typescript/bin/tsc')
const tsc = spawnSync(process.execPath, [TSC,
  join(projectRoot, 'src/client/surface-theme.ts'),
  '--outDir', themeModuleDir,
  '--module', 'esnext', '--target', 'es2022', '--skipLibCheck',
], { cwd: projectRoot, encoding: 'utf8' })
if (tsc.status !== 0) {
  console.error('\nFAIL: could not transpile surface-theme.ts for the browser check.')
  console.error(tsc.stdout ?? '', tsc.stderr ?? '')
  process.exit(1)
}
const themeModuleSource = readSourceText(join(themeModuleDir, 'surface-theme.js'))

// The REAL component, transpiled the same way, for the scroll-drift fixture
// below. Unlike the theme fixture (which re-implements two lines of the
// component) this one MOUNTS the component: the bug is in `updateEffectPosition`,
// which only the real code runs. `--noCheck` because the transpile is a loader,
// not a type gate -- `tsc --noEmit` above is the type gate. The transpile keeps
// the import specifiers verbatim (`./surface-theme.ts`, `./GooeyNav.module.css`),
// so the server below has to answer those two URLs as well as the React shims.
const navModuleDir = join(tmpdir(), `dsh-gooey-nav-${process.pid}`)
mkdirSync(navModuleDir, { recursive: true })
const navTsc = spawnSync(process.execPath, [TSC,
  join(projectRoot, 'src/client/GooeyNav.tsx'),
  '--outDir', navModuleDir,
  '--module', 'esnext', '--target', 'es2022', '--jsx', 'react-jsx',
  '--moduleResolution', 'bundler', '--skipLibCheck', '--noCheck',
], { cwd: projectRoot, encoding: 'utf8' })
if (navTsc.status !== 0) {
  console.error('\nFAIL: could not transpile GooeyNav.tsx for the scroll-drift check.')
  console.error(navTsc.stdout ?? '', navTsc.stderr ?? '')
  process.exit(1)
}
const navModuleSource = readSourceText(join(navModuleDir, 'GooeyNav.js'))

const page = `<!doctype html><html><head><style>
  /* A light surface, then flipped to dark at runtime. */
  body { margin: 0; background: #ffffff; color: #17171c; }
  body[data-ds-dark-theme] { background: #0f1115; color: #f9fafb; }
  /* The host tokens the components read, in both themes. */
  body {
    --dsw-alias-brand-primary: #0f1115;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-static-red-500: #ef4444;
    --dsw-static-neutral-00: #ffffff;
  }
  body[data-ds-dark-theme] {
    --dsw-alias-brand-primary: #f9fafb;
    --dsw-alias-label-primary: #f9fafb;
    --dsw-alias-label-secondary: #a2a4a6;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-bg-layer-1: #17171c;
  }
  ${gooeyCss}
  ${browserCss(canvasCss)}
</style></head><body>
  <div class="container" id="gooey"><nav><ul><li class="active"><button>One</button></li><li><button>Two</button></li></ul></nav></div>
  <div class="root" id="canvasRoot"><div id="probe"></div></div>
  <script type="module">
    import { detectLightSurface, subscribeSurfaceTheme } from '/surface-theme.mjs'
    // The same two lines GooeyNav's setup effect runs.
    const container = document.getElementById('gooey')
    const applyTheme = (light) => { container.dataset.theme = light ? 'light' : 'dark' }
    applyTheme(detectLightSurface(container))
    window.__stopThemeWatch = subscribeSurfaceTheme(container, applyTheme)
    window.__gooeyReady = true
  </script>
</body></html>`

// --- the nav row scrolls, and the pill has to follow it ---------------------
// The user's report: click "A+ 详情页" on the right-hand end of the row and
// EVERY title looks like two. There is only one `[role="tab"]` per label (the
// DOM does not double); the duplicate is the decoration layer
// (`span.effectText`, `z-index: 1`, `pointer-events: none`) plus the pill, which
// were positioned from VIEWPORT coordinates inside a container that is itself a
// scroll container (`overflow-x: auto`), so after the row scrolled they stayed
// at the pre-scroll offset. At 1440px the row does not overflow
// (`scrollWidth === clientWidth`), which is why it never reproduced there.
//
// Mounting the real component is not optional here: `updateEffectPosition` is
// component code, and the whole defect lives inside it. The scroll is not
// reported by any event the component listens to (no scroll listener, by
// design), so the only honest test is: scroll the container, then measure where
// the decoration is against the tab it belongs to.
const navScrollPage = `<!doctype html><html><head><style>
  body { margin: 0; background: #ffffff; color: #17171c; }
  /* The four tokens .container reads for its palette. They only affect color;
     the geometry does not depend on them, but a var() that never resolves is
     noise in the console, so they are supplied. */
  body {
    --dsw-alias-brand-primary: #17171c;
    --dsw-static-red-400: #f25a5a;
    --dsw-static-neutral-00: #ffffff;
    --dsw-static-blue-400: #60a5fa;
  }
  /* Narrow enough that the nine real labels cannot fit: without an overflow
     this fixture would measure nothing and pass vacuously. */
  #host { width: 520px; }
  ${gooeyCss}
</style>
<script type="importmap">
{ "imports": {
  "react": "/react.mjs",
  "react/jsx-runtime": "/jsx-runtime.mjs",
  "react-dom/client": "/react-dom-client.mjs"
} }
</script>
</head><body>
  <div id="host"></div>
  <!-- The UMD builds are classic scripts: they assign window.React /
       window.ReactDOM, which the three ESM shims above read. They have to load
       BEFORE the module script, or the shims find no globals. -->
  <script src="/react.js"></script>
  <script src="/react-dom.js"></script>
  <script type="module">
    import { createRoot } from 'react-dom/client'
    import { createElement } from 'react'
    import { GooeyNav } from '/GooeyNav.js'
    // The real nine workspace labels, in the order the panel renders them: the
    // overflow has to come from labels a user actually sees, because the widths
    // are what decides whether the row overflows.
    const items = ['普通生图','素材库','无限画布','电商模式预览','图片转 PPT','爆款复刻','服饰穿戴','带货图文','A+ 详情页'].map((label, index) => ({ key: String(index), label }))
    const host = document.getElementById('host')
    const root = createRoot(host)
    let activeIndex = 0
    // createElement, not a direct call to GooeyNav: a component invoked as a
    // plain function runs its hooks with no React dispatcher installed, which
    // fails as "Invalid hook call" -- the fixture would report a harness
    // failure and prove nothing about the drift.
    const render = () => root.render(createElement(GooeyNav, { items, activeIndex, onSelect: index => { activeIndex = index; render() }, ariaLabel: '工作区' }))
    render()
    // The mount effects run synchronously in React 18's createRoot, but the
    // ResizeObserver callback that positions the pill is a separate task: poll
    // for the decoration existing rather than assuming a number of frames.
    const ready = () => host.querySelector('.effectText') !== null && host.querySelector('.effectFilter') !== null
    const deadline = Date.now() + 2000
    const wait = () => { if (ready() || Date.now() > deadline) { window.__navReady = ready(); return }; requestAnimationFrame(wait) }
    requestAnimationFrame(wait)
  </script>
</body></html>`

const server = (await import('node:http')).createServer((req, res) => {
  if (req.url?.startsWith('/surface-theme.mjs') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(themeModuleSource)
    return
  }
  // The scroll-drift fixture mounts the real component, so it needs React
  // itself. The UMD development builds are served as plain scripts (they set
  // `window.React` / `window.ReactDOM`), and the three `.mjs` shims below turn
  // those globals into the ESM named exports the importmap points at. Serving
  // the ESM builds directly would need an import map per React internal
  // specifier, which is exactly what the shims avoid.
  if (req.url?.startsWith('/react.js') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(join(projectRoot, 'node_modules/react/umd/react.development.js')))
    return
  }
  if (req.url?.startsWith('/react-dom.js') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(join(projectRoot, 'node_modules/react-dom/umd/react-dom.development.js')))
    return
  }
  if (req.url?.startsWith('/react.mjs') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end('const R = window.React; export const useEffect = R.useEffect, useRef = R.useRef, useState = R.useState, useMemo = R.useMemo, useCallback = R.useCallback, createElement = R.createElement, Fragment = R.Fragment; export default R;')
    return
  }
  if (req.url?.startsWith('/jsx-runtime.mjs') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end('const R = window.React; export const jsx = (t, p) => { const { children, ...rest } = p || {}; return children === undefined ? R.createElement(t, rest) : R.createElement(t, rest, children) }; export const jsxs = jsx; export const Fragment = R.Fragment;')
    return
  }
  if (req.url?.startsWith('/react-dom-client.mjs') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end('export const createRoot = window.ReactDOM.createRoot; export default { createRoot };')
    return
  }
  if (req.url?.startsWith('/GooeyNav.module.css') === true) {
    // The transpiled component asks for its CSS module as a MODULE and gets a
    // runtime object back, so this route has to answer with JS, not CSS: the
    // real stylesheet is inlined in the page above. (No import-shape literal
    // here on purpose: verify-tracked.mjs reads this file as TEXT, and a
    // comment containing a relative specifier is indistinguishable from a real
    // broken import -- it reports the import path as missing from the repo.)
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end('export default new Proxy({}, { get: (_, key) => String(key) })')
    return
  }
  if (req.url?.startsWith('/GooeyNav.js') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(navModuleSource)
    return
  }
  if (req.url?.startsWith('/surface-theme.ts') === true) {
    // GooeyNav imports './surface-theme.ts' verbatim, so the transpiled module
    // asks for that exact URL. Same bytes as the .mjs route above.
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(themeModuleSource)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  // Each fixture is the same stylesheets on a different body: the real-browser
  // checks need the component relationship, not the whole app.
  if (req.url?.includes('toolbar=1') === true) res.end(toolbarPage)
  else if (req.url?.includes('stack=1') === true) res.end(stackPage)
  else if (req.url?.includes('mainslot=1') === true) res.end(mainSlotPage)
  else if (req.url?.includes('sourcetabs=1') === true) res.end(sourceTabsPage)
  else if (req.url?.includes('sidebartabs=1') === true) res.end(sidebarTabsPage)
  else if (req.url?.includes('shortcuts=1') === true) res.end(shortcutPage)
  else if (req.url?.includes('navscroll=1') === true) res.end(navScrollPage)
  else if (req.url?.includes('historyscroll=1') === true) res.end(historyScrollPage)
  else if (req.url?.includes('settings850=1') === true) res.end(settingsPage)
  else res.end(page)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// The browser picks its own DevTools port and publishes it in the profile it
// was given — the hand-rolled random range this used to guess at is what made
// two concurrent runs read each other's blank target.
const launched = await launchChrome({ chrome: CHROME, name: 'dsh-ui-contracts' })
const browser = launched.browser
const target = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const send = (method, params) => new Promise(resolve => {
  const myId = ++id
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws.removeEventListener('message', onMessage); resolve(m) } }
  ws.addEventListener('message', onMessage)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate = async expression => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send('Runtime.enable', {})

// The module script has to finish evaluating before anything is asserted;
// polling its own readiness flag is the only honest wait here (a fixed sleep
// would pass or fail depending on how fast this machine loads a module).
let gooeyReady = false
for (let i = 0; i < 40; i++) {
  gooeyReady = (await evaluate('window.__gooeyReady === true')) === true
  if (gooeyReady) break
  await new Promise(r => setTimeout(r, 100))
}
if (!gooeyReady) {
  console.error('\nFAIL: the surface-theme module never loaded in the page, so the')
  console.error('GooeyNav contract was NOT exercised (this is a broken harness, not a pass).')
  process.exit(1)
}

// --- 1. GooeyNav follows a runtime theme switch -----------------------------
// The page flips the host attribute the way DSH does, then reads the computed
// pill color. A one-shot detector (the original bug) leaves the old value.
const gooey = await evaluate(`(async () => {
  const el = document.getElementById('gooey')
  const read = () => getComputedStyle(el).getPropertyValue('--gooey-pill').trim()
  const before = read()
  const themeBefore = el.dataset.theme
  document.body.setAttribute('data-ds-dark-theme', '')
  // The subscription is async (MutationObserver): wait for the attribute to
  // actually move rather than assuming a fixed number of frames is enough.
  const deadline = Date.now() + 2000
  while (el.dataset.theme === themeBefore && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20))
  }
  return { before, after: read(), themeBefore, themeAttr: el.dataset.theme }
})()`)
console.log(`GooeyNav pill: light=${gooey.before} (${gooey.themeBefore}) -> dark=${gooey.after} (${gooey.themeAttr})`)
if (gooey.themeAttr !== 'dark') {
  console.error(`\nFAIL: the container's data-theme is still "${gooey.themeAttr}" after the host switched to dark.`)
  console.error('The subscription did not fire, so the nav keeps the ink it was built with')
  console.error('and stays unreadable against the new surface.')
  process.exit(1)
}
if (gooey.before === gooey.after || gooey.after === '') {
  console.error(`\nFAIL: the GooeyNav palette did not move with the theme (light=${gooey.before}, dark=${gooey.after}).`)
  console.error('Either the palette is hardcoded again, or the per-surface branches')
  console.error('resolved to the same value and the nav is painted blind to the surface.')
  process.exit(1)
}
// The subscription must also be DISPOSED -- a nav that keeps observing after
// it unmounts is the same leak class the panel takeover bug came from.
if (!/stopThemeWatch\(\)/.test(gooeySource)) {
  console.error('\nFAIL: GooeyNav no longer disposes its theme subscription.')
  process.exit(1)
}
// And the wiring itself: the module being correct is useless if the component
// never subscribes to it.
if (!/subscribeSurfaceTheme\(/.test(gooeySource)) {
  console.error('\nFAIL: GooeyNav no longer calls subscribeSurfaceTheme -- it reads the surface once again.')
  process.exit(1)
}

// --- 2. one annotation color, CSS and Canvas2D ------------------------------
const marker = await evaluate(`(() => {
  const root = document.getElementById('canvasRoot')
  const style = getComputedStyle(root)
  const probe = document.getElementById('probe')
  probe.style.borderColor = 'var(--canvas-annotation)'
  probe.style.color = 'var(--canvas-annotation-ink)'
  const probeStyle = getComputedStyle(probe)
  return {
    declared: style.getPropertyValue('--canvas-annotation').trim(),
    ink: style.getPropertyValue('--canvas-annotation-ink').trim(),
    resolvedBorder: probeStyle.borderTopColor,
    resolvedInk: probeStyle.color,
  }
})()`)
console.log(`annotation token: ${marker.declared} (ink ${marker.ink}) -> border ${marker.resolvedBorder}`)
if (marker.declared === '' || marker.ink === '') {
  console.error('\nFAIL: the annotation token does not resolve on the canvas root.')
  console.error('CSS draws the boxes with it and Canvas2D reads it for the marker')
  console.error('burnt into the model reference; an empty value means one of them')
  console.error('falls back to a literal and the two can drift apart.')
  process.exit(1)
}
// Canvas2D must READ the token rather than repeat a literal.
if (!/themeColor\('--canvas-annotation'/.test(imageOpsSource)) {
  console.error('\nFAIL: image-ops no longer reads --canvas-annotation for the marker.')
  console.error('A literal here is the drift this contract exists to prevent.')
  process.exit(1)
}
// And it must read it from the element the token is declared on. The token is
// plugin-private and scoped to the canvas root class, so reading it from
// documentElement returned an empty string in every real browser and the marker
// silently fell back to the literal -- the check above passed while the two
// colors differed. The caller therefore has to pass the canvas root.
if (!/themeColor\('--canvas-annotation', '[^']*', tokenOrigin\)/.test(imageOpsSource)) {
  console.error('\nFAIL: image-ops reads --canvas-annotation without an origin element.')
  console.error('The token is declared on the canvas root, not on documentElement;')
  console.error('reading it from the document root always returns empty and the marker')
  console.error('falls back to a literal that no longer matches the on-screen boxes.')
  process.exit(1)
}
// Matched by splitting the statement on `drawAnnotation(` and then balancing
// parentheses, not by a single-line regex: the call passes
// `boxes.map((box, index) => ...)` and a regex stops at the first `)`, so it
// would fail on a correct call -- and, worse, a `.*` version would pass on any
// later `rootRef.current` in the file rather than this argument.
const workspaceSource = read('CanvasWorkspace.tsx')
const callerHasOrigin = (() => {
  let from = 0
  for (;;) {
    const at = workspaceSource.indexOf('drawAnnotation(', from)
    if (at < 0) return false
    from = at + 1
    // The import statement mentions the name too; skip it.
    if (workspaceSource.slice(Math.max(0, at - 7), at) === 'import ') continue
    let depth = 1
    let i = at + 'drawAnnotation('.length
    for (; i < workspaceSource.length && depth > 0; i++) {
      const char = workspaceSource[i]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
    }
    if (/rootRef\.current\s*$/.test(workspaceSource.slice(at, i - 1))) return true
  }
})()
if (!callerHasOrigin) {
  console.error('\nFAIL: the drawAnnotation caller does not pass the canvas root as the token origin.')
  console.error('Without it the marker token resolves against documentElement, where it is')
  console.error('never declared, so the burned-in boxes fall back to a stale literal.')
  process.exit(1)
}
const literalMarker = /strokeStyle = '#ff2d55'|fillStyle = '#ff2d55'/.test(imageOpsSource)
if (literalMarker) {
  console.error('\nFAIL: image-ops still paints the marker with a literal #ff2d55.')
  process.exit(1)
}
// And the stylesheet must not repeat it either.
const cssLiteral = ['canvas-workspace.module.css'].filter(name => /#ff2d55|255 45 85/.test(read(name)))
if (cssLiteral.length > 0) {
  console.error(`\nFAIL: ${cssLiteral.join(', ')} still hardcodes the marker color.`)
  process.exit(1)
}
console.log('annotation marker: CSS and Canvas2D both read the same token, no literals left')

const canvasSource = read('canvas-flow-context.tsx')
// The browser fixture below hardcodes `tabindex` on its node, so it measures the
// CSS contract only -- it cannot see whether the COMPONENT still makes the node
// focusable. That half is a source invariant: without tabIndex on the node root
// the toolbar can never be revealed, because a hidden toolbar's own buttons are
// not focusable and `.node:focus-within` would never fire. The node root is the
// react-flow custom-node shell (CanvasNodeShell), which delegates the pointer
// gesture back to the workspace's handleNodePointerDown via context.
const nodeRoot = canvasSource.match(/<div\s*\n\s*data-node-id=\{node\.id\}[\s\S]{0,1400}?onPointerDown=\{event => ctx\.onNodePointerDown/)
if (nodeRoot === null) {
  console.error('\nFAIL: could not locate the node root element to check its focusability.')
  process.exit(1)
}
if (!/tabIndex=\{0\}/.test(nodeRoot[0])) {
  console.error('\nFAIL: the canvas node root is not focusable.')
  console.error('A hidden toolbar cannot hold focus, so without a tab stop on the node')
  console.error('itself the toolbar is unreachable by keyboard and `.node:focus-within`')
  console.error('never fires -- the two rules deadlock.')
  process.exit(1)
}
console.log('canvas node root is a tab stop, so the toolbar is reachable by keyboard')

// ------------------------------------------------------- 5. tablist contract
// `role="tablist"` commits the component to a keyboard model: exactly one tab
// in the Tab order, and the arrow keys move between tabs. Declaring the roles
// without the keys leaves keyboard users pressing arrows that do nothing, which
// is a real defect rather than a missing nicety. Every tablist in the plugin is
// checked here, so a new one cannot quietly ship without the contract.
//
// GooeyNav is exempt: it has its own inline implementation (its tabs are <li>
// wrappers, so the shared helper's closest('[role="tablist"]') walk does not
// fit) and it is covered by its own check above. `tablist.ts` is the helper
// itself, not a consumer.
//
// `.ts` is scanned too, and that is the point of this comment: the sidebar
// switcher is built imperatively (`sidebar-entry.ts`, no React), so it declares
// its roles with `setAttribute('role', …)` rather than a JSX attribute. While
// this list was `.tsx`-only, adding `role="tab"` there was invisible to the
// contract — issue #25's fix shipped two tabs with no arrow keys and no roving
// tabIndex, and every gate stayed green. A role declared imperatively is the
// same promise as one declared in JSX.
const TABLIST_FILES = readdirSync(clientDir)
  .filter(name => (name.endsWith('.tsx') || name.endsWith('.ts')) && name !== 'GooeyNav.tsx' && name !== 'tablist.ts')
/**
 * `role="tablist"` / `setAttribute('role', 'tablist')` — a DECLARATION.
 *
 * The `(?<!\[)` is load-bearing: `'[role="tablist"]'` inside a querySelector
 * call is a string that CONTAINS the same characters, so a plain substring test
 * counts a selector as a declaration. `index.ts` queries
 * `'[role="tablist"][data-dsh-imagegen-session-tabs]'` to relabel the switcher;
 * without the lookbehind that file looks like a tablist it never renders.
 */
const declaresTablist = source => /(?<!\[)role="tablist"/.test(source)
  || /setAttribute\(\s*'role'\s*,\s*'tablist'\s*\)/.test(source)
/** How many `role="tab"` / `setAttribute('role', 'tab')` the file declares. */
const countTabs = source => [...source.matchAll(/(?<!\[)role="tab"/g)].length
  + [...source.matchAll(/setAttribute\(\s*'role'\s*,\s*'tab'\s*\)/g)].length
const missingTablistContract = []
for (const name of TABLIST_FILES) {
  const source = read(name)
  if (!declaresTablist(source)) continue
  const tabButtons = countTabs(source)
  if (tabButtons === 0) continue
  // Every tablist in this file must go through the shared helper.
  if (!/onTablistKeyDown\(/.test(source)) {
    missingTablistContract.push(`${name}: declares ${tabButtons} tab(s) but never calls onTablistKeyDown`)
    continue
  }
  if (!/tabIndexFor\(/.test(source)) {
    missingTablistContract.push(`${name}: no roving tabIndex (tabIndexFor)`)
    continue
  }
  // The helper is only a roving tabIndex if it actually returns -1 for the
  // unselected tab; a helper that returned 0 for everything would pass the
  // call-site checks above while leaving every tab in the Tab order.
  const helper = read('tablist.ts')
  if (!/return active \? 0 : -1/.test(helper)) {
    missingTablistContract.push('tablist.ts: tabIndexFor no longer returns -1 for the unselected tab')
  }
}
if (missingTablistContract.length > 0) {
  console.error('\nFAIL: a tablist declares the ARIA roles without the keyboard contract:')
  for (const entry of missingTablistContract) console.error(`  - ${entry}`)
  process.exit(1)
}
console.log('every tablist wires the shared roving-tabIndex / arrow-key helper')

// --- 3. hidden node toolbars in a REAL browser ------------------------------
// Layout, not source text: whether a hidden toolbar is still a tab stop, and
// whether focusing one makes it visible. jsdom has no layout engine, so this is
// the only place the fix can actually be measured.
//
// The markup reproduces the node/toolbar relationship the component renders:
// the node is the tab stop (`tabIndex=0`), the toolbar holds real buttons, and
// the toolbar is hidden until the node is hovered, selected, or focused.
const toolbarPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${browserCss(canvasCss)}
</style></head><body>
  <div class="node" id="node" tabindex="0" role="group" aria-label="图片节点" style="position:relative;width:200px;height:120px">
    <div class="hoverToolbar" id="toolbar">
      <button id="deleteBtn">删除</button>
      <button id="bgBtn">移除背景</button>
    </div>
  </div>
</body></html>`

// --- the broken tie, measured in a real browser -----------------------------
// The canvas notice and the video-picker backdrop both used to be z-index: 60,
// so which one painted on top was decided by document order -- the app happened
// to render the backdrop after the notice, and that accident is what the user
// asked to remove. This page renders them in the OPPOSITE order on purpose: if
// the two are ever tied again, the notice wins here and the check fails, even
// though every source-level invariant (distinct rungs, doc table, relative
// order) stays green. Paint order is a fact only the browser can report.
const videoPickerCss = read('canvas-video-picker.module.css')
// panel.module.css carries the :root scale every module reads, and mount.tsx
// imports it globally, so the fixture loads it the same way.
const scaleCss = read('panel.module.css')
const stackPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${scaleCss}
  ${browserCss(canvasCss)}
  ${videoPickerCss}
</style></head><body>
  <div class="root" id="canvasRoot" style="position:relative;width:420px;height:320px">
    <div class="backdrop" id="picker"><div style="width:80px;height:40px"></div></div>
    <div class="errorToast" id="toast" data-canvas-no-zoom="">生成失败，请重试</div>
  </div>
</body></html>`

// --- the source row has to stay reachable as the registry grows -------------
// Every tab is `white-space: nowrap`. A plain flex row neither wraps nor
// scrolls, so once the registered sources exceed the width the last tabs are
// simply gone: not scrollable, not wrapped, not clickable, and nothing on
// screen says they exist. The source-level check above reads the declaration;
// only the browser can say whether the LAST tab is actually reachable, so this
// page renders the real stylesheet at a deliberately narrow width and asks.
const templatesModuleCss = read('templates.module.css')
// The tab list is generated from the registry and the FAVORITES tab is the one
// marked; it is the last tab the component renders, so it is the one a clipped
// row loses first.
const tabMarkup = [
  ...registeredLabels.map(([, label]) => `<button class="sourceTab" role="tab">${label}<span class="sourceTabCount">123</span></button>`),
  '<button class="sourceTab" role="tab" id="last">★ 收藏</button>',
].join('\n      ')
const sourceTabsPage = `<!doctype html><html><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f2f3f5;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-brand-primary: #17171c;
    --dsw-alias-interactive-bg-hover: #f0f1f3;
  }
  /* Narrow enough that the registered tab labels cannot all fit on one line. */
  #host { width: 420px; padding: 12px 0; }
  ${templatesModuleCss}
</style></head><body>
  <div id="host">
    <div class="sourceTabs" id="tabs" role="tablist">
      ${tabMarkup}
    </div>
  </div>
</body></html>`

/**
 * The real `alignToSeat` from `sidebar-entry.ts`, with its type annotations
 * stripped so a plain browser can evaluate it.
 *
 * Reading the function out of the source (rather than re-typing it here) is the
 * whole point: the check must fail when the shipped logic changes, not when a
 * copy of it drifts. If the function is renamed or removed this throws instead,
 * so the check cannot silently stop covering it.
 *
 * Its second parameter is the SEAT the switcher was inserted before, which is
 * the New Session button only in shells that do not wrap the action. This page
 * reproduces the unwrapped 0.2.1 arrangement, so it passes the button; the
 * wrapped 0.2.2-rc.3 arrangement is covered by smoke D3c, which mounts the real
 * entry instead of lifting one function out of it.
 */
const sidebarAlignScript = (() => {
  const source = read('sidebar-entry.ts')
  const match = source.match(/function alignToSeat\(tabs: HTMLElement, seat: HTMLElement\): void \{[\s\S]*?\n\}/)
  if (match === null) {
    console.error('\nFAIL: alignToSeat is gone from sidebar-entry.ts.')
    console.error('The sidebar alignment check lifts that function into the page; without it there is')
    console.error('nothing to exercise, and the check would pass by measuring a page it never aligned.')
    process.exit(1)
  }
  return match[0]
    .replace(/\(tabs: HTMLElement, seat: HTMLElement\): void/, '(tabs, seat)')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
})()

// --- the injected switcher lines up with the shell's New Session button -----
// Issue #25. The switcher is a SIBLING of the shell button, inserted with
// `insertBefore`, so it inherits that button's alignment contract or it does
// not line up at all. Two things decide it and neither is visible in a source
// review: `box-sizing` (content-box makes `width: 100%` overflow its parent by
// padding + border) and the horizontal inset.
//
// This fixture is reproduced from a LIVE shell (dsh 0.2.1-rc.5), and that is
// the point of the second half of issue #25. The first version of this page
// declared `--dsh-sidebar-paint-inset: 3px` on `body`, which matched the
// fallback in the stylesheet and therefore only agreed with itself. The real
// shell defines NO such property on any ancestor: its New Session button
// carries a hard-coded `margin: 2px`. So this page defines no inset variable at
// all, the button's margin is 2px, and the switcher has to measure it.
//
// The palette is the light theme on purpose. The defect was never about colour
// -- it measured pixels of horizontal drift and a wrong vertical gap -- so the
// fixture stays a light surface and the numbers are the whole assertion.
const sidebarTabsPage = `<!doctype html><html><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-radius-md: 8px;
    --dsw-radius-sm: 6px;
  }
  /* A block-level <button> with an auto width is fit-content, not fill: the
     column has to be a flex column so both children stretch and their shared
     margin — not a width declaration — decides where each edge lands. That is
     the arrangement the live shell has, and the only one where the two boxes
     can be compared at all. */
  #root { width: 280px; padding: 6px 8px; box-sizing: border-box; display: flex; flex-direction: column; }
  /* The shell's own button, as measured live: border-box, block, auto width,
     and a flat 2px inline margin with no custom property behind it. */
  .newSession {
    box-sizing: border-box;
    display: block;
    width: auto;
    height: 38px;
    margin: 0 2px 12px;
    padding: 0 12px;
    border: 1px solid #d9dade;
    border-radius: 8px;
    background: #ffffff;
    font: 13px/1.2 system-ui, sans-serif;
  }
  ${browserCss(read('panel.module.css'))}
</style></head><body>
  <div id="root">
    <div class="sessionTabs" id="tabs" data-dsh-imagegen-session-tabs role="tablist" aria-label="会话 / 生图">
      <button class="sessionTab" id="tabSession" role="tab" aria-selected="true" tabindex="0"><span class="sessionTabIcon"></span><span class="sessionTabLabel">会话</span></button>
      <button class="sessionTab" id="tabImage" role="tab" aria-selected="false" tabindex="-1"><span class="sessionTabIcon"></span><span class="sessionTabLabel">生图</span></button>
    </div>
    <button class="newSession" data-dsh-imagegen-new-session aria-label="新建会话">新建会话</button>
  </div>
  <script>
    // The REAL function, lifted out of sidebar-entry.ts and evaluated here. A
    // fixture that hard-codes the expected margins cannot notice the expected
    // answer changing -- and this very check passed the 4px-vs-2px defect it
    // exists to catch, precisely because it wrote the margins itself.
    ${sidebarAlignScript}
    alignToSeat(document.getElementById('tabs'), document.querySelector('.newSession'))
  </script>
</body></html>`

// --- the history surface owns its wheel events ------------------------------
// DSH 0.2.2's sidebar runs a scroll handoff: a `wheel` listener (`passive:
// false`) on `[data-sidebar-scrollport]` that, for every event NOT aimed at its
// own session tree, calls `preventDefault()` and scrolls that tree instead. The
// handed-off tree is an ANCESTOR-and-sibling arrangement around the region this
// plugin paints its history into, so in the studio the visible list froze while
// an invisible one scrolled behind it.
//
// The handoff below is copied from the 0.2.2 bundle (`createScrollHandoff`),
// because the host that ships it is not a dependency of this repository — the
// check needs its behaviour, not its package.
const historyHandoffScript = `
  const GESTURE_GAP_MS = 100
  function verticalWheelPixels (event, page) {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return undefined
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * page
    return event.deltaY
  }
  function scrollClamped (element, delta) { const before = element.scrollTop; element.scrollTop = before + delta; return element.scrollTop - before }
  function atEnd (viewport) { return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1 }
  function installHandoff (viewport, scroller) {
    let lastSplit = Number.NEGATIVE_INFINITY
    viewport.addEventListener('wheel', event => {
      if (scroller === null || event.defaultPrevented) return
      const delta = verticalWheelPixels(event, viewport.clientHeight)
      if (delta === undefined || delta === 0) return
      if (!(event.cancelable && event.timeStamp - lastSplit < GESTURE_GAP_MS)) {
        const native = atEnd(viewport) && scroller.contains(event.target)
        if (native && (delta > 0 || scroller.scrollTop + delta >= 0)) return
        if (!event.cancelable) { if (native) scrollClamped(viewport, delta + scroller.scrollTop); return }
      }
      event.preventDefault()
      lastSplit = event.timeStamp
      if (delta > 0) { const rest = delta - scrollClamped(viewport, delta); if (rest > 0) scrollClamped(scroller, rest); return }
      const rest = delta - scrollClamped(scroller, delta)
      if (rest < 0) scrollClamped(viewport, rest)
    }, { passive: false })
  }
`

/**
 * The real `containHistoryWheel` from `sidebar-entry.ts`, type annotations
 * stripped so a plain browser can evaluate it.
 *
 * Lifted from the source for the same reason as `alignToSeat` above: a copy
 * would keep passing after the shipped logic changed, which is the failure this
 * check exists to catch.
 */
const historyWheelScript = (() => {
  const source = read('sidebar-entry.ts')
  const match = source.match(/function containHistoryWheel\(host: HTMLElement\): void \{[\s\S]*?\n\}/)
  if (match === null) {
    console.error('\nFAIL: containHistoryWheel is gone from sidebar-entry.ts.')
    console.error('The history wheel check lifts that function into the page; without it there is')
    console.error('nothing to exercise, and the check would pass by measuring a page it never protected.')
    process.exit(1)
  }
  // The function reads the module-level attribute name, which is not in scope
  // once it is lifted out of the module. Taken from the source rather than
  // retyped, so renaming the attribute cannot leave the fixture silently
  // marking nothing.
  const attr = source.match(/const WHEEL_CONTAINER_ATTR = '([^']+)'/)
  if (attr === null) {
    console.error('\nFAIL: WHEEL_CONTAINER_ATTR is gone from sidebar-entry.ts.')
    process.exit(1)
  }
  return `const WHEEL_CONTAINER_ATTR = '${attr[1]}'\n` + match[0]
    .replace(/\(host: HTMLElement\): void/, '(host)')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
})()

// The DOM is the one 0.2.2 renders around the history host: a scroll viewport
// that owns the session tree, the region the tree sits in, and the plugin's
// absolutely-positioned host on top of it. The list is tall enough to scroll
// and the tree tall enough to prove it did not move instead.
const historyScrollPage = `<!doctype html><html data-dsh-imagegen-active><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-border-l2: #e6e7ea;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f7f7f8;
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #8a8d99;
    --dsw-radius-md: 8px;
    --dsw-radius-sm: 6px;
  }
  #column { width: 280px; height: 640px; display: flex; flex-direction: column; }
  /* The shell's scroll viewport. Overflow is hidden (it scrolls nothing
     itself), it owns the session tree and the region, and it is what carries
     the wheel listener. */
  #scrollport { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  #tree { flex: 0 0 auto; height: 120px; overflow: hidden; }
  #treeScroll { height: 100%; overflow-y: auto; }
  #treeScroll div { height: 40px; }
  #region { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  ${browserCss(read('panel.module.css'))}
</style></head><body>
<div id="column">
  <div id="scrollport" data-sidebar-scrollport>
    <div id="tree"><div id="treeScroll">${Array.from({ length: 60 }, (_, i) => `<div>session ${i}</div>`).join('')}</div></div>
    <div id="region">
      <div class="sidebarHistoryHost" id="host" data-dsh-imagegen-history-host>
        <aside class="history" data-dsh-imagegen-history>
          <header class="historyHeader"><span class="historyTitle">历史记录</span></header>
          <div class="historyList" id="list">${Array.from({ length: 40 }, (_, i) => `<div class="historyItem"><span class="historyPrompt">第 ${i} 条记录，用来把列表撑到可以滚动的高度</span></div>`).join('')}</div>
        </aside>
      </div>
    </div>
  </div>
</div>
<script>
  ${historyHandoffScript}
  ${historyWheelScript}
  // The tree is INSIDE the scroll viewport, as the shell's is; without the
  // containment every wheel over the list would be forwarded to it.
  installHandoff(document.getElementById('scrollport'), document.getElementById('treeScroll'))
  containHistoryWheel(document.getElementById('host'))
</script>
</body></html>`

// --- the shortcut legend fits the canvas it opens over ----------------------
// The panel is a two-column grid of key chips: the chips are `nowrap` and the
// label column is `text-align: right` with `min-width: 0`. Two things can go
// wrong that no source check can see. A row can overflow its column when the
// key half and the label half together exceed it (the chips never wrap inside
// one kbd, so the row grows), and the dialog can be taller than the viewport
// when there are more groups than fit -- which is what `max-height` plus the
// scrolling body is for. Both are measured here at a canvas-sized viewport and
// at a phone width, where the grid must collapse to one column.
const shortcutCss = read('shortcut-help.module.css')
// Rendered from the same shape the component renders: every group gets rows of
// chips and a label, using the real stylesheet and the real longest copy. The
// longest label in the data table is `focusNode`, which is why it is used for
// the row that decides the measurement.
const longestLabel = '在节点之间移动焦点，节点工具条随之出现'
// Repeated to far more rows than any viewport can hold. With only the real
// twelve -- or even three copies of them -- the dialog fits whether or not it
// caps its height, so the "grows past the viewport" case could not be told
// apart from the fixed one: it reported FALSE GREEN twice. The copy and the
// stylesheet are the real ones; only the amount is raised until the overflow is
// unambiguous (8 copies x 12 rows = 48 rows per column).
const repeat = (rows, times) => Array.from({ length: times }, () => rows).flat()
const shortcutGroups = [
  { title: '视图', rows: repeat([['Ctrl/⌘|Space', '按住并拖拽平移画布'], ['中键', '中键拖拽平移画布'], ['滚轮', '以指针为中心缩放'], ['Ctrl/⌘|A', '选中全部节点']], 8) },
  { title: '选择', rows: repeat([['Ctrl/⌘|A', '选中全部节点'], ['Shift', '拖拽出框选'], ['Esc', '退出当前工具或清空选择'], ['Ctrl/⌘|Z', '撤销']], 8) },
  { title: '编辑', rows: repeat([['Ctrl/⌘|Z', '撤销'], ['Ctrl/⌘|Shift|Z', '重做'], ['Delete', '删除选中节点'], ['Tab', longestLabel]], 8) },
  { title: '节点', rows: repeat([['双击', '在空白处新建节点'], ['Tab', longestLabel], ['?', '打开这张快捷键表'], ['Ctrl/⌘|D', '原地复制一份']], 8) },
]
const shortcutMarkup = shortcutGroups.map(group => `<section class="group">
    <h4>${group.title}</h4>
    ${group.rows.map(([keys, label]) => `<div class="row">
      <span class="keys">${keys.split('|').map(key => `<kbd>${key}</kbd>`).join('')}</span>
      <span class="label">${label}</span>
    </div>`).join('\n    ')}
  </section>`).join('\n  ')
const shortcutPage = `<!doctype html><html><head><style>
  body { margin: 0;
    --dsw-alias-border-l1: #d9dade;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f2f3f5;
    --dsw-alias-bg-mask-1: rgb(15 17 21 / 45%);
    --dsw-alias-label-primary: #17171c;
    --dsw-alias-label-secondary: #5b5e6b;
    --dsw-alias-label-tertiary: #7f8287;
    --dsw-alias-brand-primary: #17171c;
    --dsw-alias-interactive-bg-hover: #f0f1f3;
    --dsw-font-family: system-ui, sans-serif;
    --dsw-font-mono: ui-monospace, Menlo, monospace;
    --z-modal-backdrop: 130;
  }
  ${shortcutCss}
</style></head><body>
  <div class="backdrop" id="backdrop">
    <div class="dialog" id="dialog" role="dialog">
      <header class="header"><strong>键盘快捷键</strong><button type="button">×</button></header>
      <div class="body" id="body">
  ${shortcutMarkup}
      </div>
      <div class="footer">在画布上按 ? 随时打开这张表。</div>
    </div>
  </div>
</body></html>`

// --- the keyed `main` slot is single-occupant (#38) -------------------------
// The plugin market page and the Conversation both register into the shell's
// keyed `main` slot. The studio takeover rule hid UNRELATED entries on the
// column's direct-child axis and deliberately let the `main` anchor through,
// because the Conversation lives inside it -- which left the market page
// rendering inside that anchor at the same time, so switching to the studio
// appeared to do nothing. The fix hides the anchor's non-Conversation entries.
//
// Measured here rather than read, because two things the source cannot show
// decide the outcome: the anchor is `display: contents` (so the hidden entry is
// laid out by the column), and the minifier escapes the dotted attribute value
// in the Conversation branch, which is why the rule matches the chat entry
// POSITIVELY and one bad branch would void the whole selector list.
const mainSlotPage = `<!doctype html><html><head><style>
  body { margin: 0; }
  ${scaleCss}
</style></head><body>
  <div id="centre" data-dsh-imagegen-center-col>
    <div data-dsh-imagegen-view id="studio">studio</div>
    <div data-slot="main" style="display: contents">
      <div data-slot="main.conversation" style="display: contents"><div id="conversation" data-phase="hero">conversation</div></div>
      <div id="shellPanel">plugin market page</div>
    </div>
    <div data-other-plugin-entry id="otherEntry">another plugin</div>
  </div>
</body></html>`
// Serve it from the same server by swapping the body through a query flag.
const toolbarTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?toolbar=1`)}`, { method: 'PUT' })).json()
const ws2 = new WebSocket(toolbarTarget.webSocketDebuggerUrl)
await new Promise(r => { ws2.onopen = r })
let id2 = 0
const send2 = (method, params) => new Promise(resolve => {
  const myId = ++id2
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws2.removeEventListener('message', onMessage); resolve(m) } }
  ws2.addEventListener('message', onMessage)
  ws2.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate2 = async expression => {
  const res = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send2('Runtime.enable', {})
await new Promise(r => setTimeout(r, 400))
const toolbar = await evaluate2(`(async () => {
  const node = document.getElementById('node')
  const toolbar = document.getElementById('toolbar')
  const button = document.getElementById('deleteBtn')
  // Snapshotted to strings, not kept as live objects: getComputedStyle returns
  // a LIVE CSSStyleDeclaration in Chrome, so holding it and reading later
  // reports the post-focus values for both samples and the comparison is
  // vacuous (it reported "visible" for the hidden state until this was fixed).
  const hidden = getComputedStyle(toolbar)
  const hiddenVisibility = hidden.visibility
  const hiddenOpacity = hidden.opacity
  // While hidden, neither the toolbar's buttons nor anything else in it may be
  // a tab stop -- that is what used to put invisible controls in the tab order.
  const buttonFocusable = button.tabIndex >= 0 && hiddenVisibility !== 'hidden' && hidden.display !== 'none'
  // The node itself is the way in: focusing it must reveal the toolbar.
  node.focus()
  // The reveal is animated (opacity, 0.12s), so reading it synchronously
  // returns the starting value; wait for the transition to finish instead of
  // guessing at a sleep.
  await Promise.all(toolbar.getAnimations().map(animation => animation.finished.catch(() => {})))
  const focused = getComputedStyle(toolbar)
  return {
    hiddenVisibility,
    hiddenOpacity,
    buttonFocusableWhenHidden: buttonFocusable,
    focusedVisibility: focused.visibility,
    focusedOpacity: focused.opacity,
    activeIsNode: document.activeElement === node,
  }
})()`)
console.log(`hidden toolbar: visibility=${toolbar.hiddenVisibility} opacity=${toolbar.hiddenOpacity}; node focused: visibility=${toolbar.focusedVisibility} opacity=${toolbar.focusedOpacity}`)
if (toolbar.buttonFocusableWhenHidden) {
  console.error('\nFAIL: a hidden node toolbar is still a tab stop in a real browser.')
  console.error('Tab lands on a control the user cannot see, and Enter then fires it')
  console.error('(the delete button is one of them).')
  process.exit(1)
}
if (toolbar.activeIsNode !== true) {
  console.error('\nFAIL: the node itself is not focusable, so the toolbar can never be reached.')
  process.exit(1)
}
if (toolbar.focusedVisibility !== 'visible' || toolbar.focusedOpacity === '0') {
  console.error('\nFAIL: focusing a node does not reveal its toolbar.')
  console.error('The user would be typing into an invisible control.')
  process.exit(1)
}
console.log('node toolbar: out of the tab order while hidden, revealed once the node is focused')

// --- the tie that used to be resolved by insertion order --------------------
// Both elements are position:absolute in the same stacking context, so
// elementFromPoint at the point they overlap names the winner by paint order.
// The picker backdrop is rendered FIRST here; at HEAD (both 60) the notice would
// win, and the fix is what makes the backdrop win regardless of order.
const stackTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?stack=1`)}`, { method: 'PUT' })).json()
const ws3 = new WebSocket(stackTarget.webSocketDebuggerUrl)
await new Promise(r => { ws3.onopen = r })
let id3 = 0
const send3 = (method, params) => new Promise(resolve => {
  const myId = ++id3
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws3.removeEventListener('message', onMessage); resolve(m) } }
  ws3.addEventListener('message', onMessage)
  ws3.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate3 = async expression => {
  const res = await send3('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send3('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))
const stack = await evaluate3(`(() => {
  const picker = document.getElementById('picker')
  const toast = document.getElementById('toast')
  const centreOf = el => {
    const r = el.getBoundingClientRect()
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
  }
  const [x, y] = centreOf(picker)
  const top = document.elementFromPoint(x, y)
  return {
    // The point lands on the backdrop's own child, which has no id, so report
    // what it actually is rather than an empty string.
    topId: top === null ? '(none)' : (top.id !== '' ? top.id : top.tagName.toLowerCase() + '.' + String(top.className)),
    pickerZ: getComputedStyle(picker).zIndex,
    toastZ: getComputedStyle(toast).zIndex,
    // Which one the browser paints last is the question; elementFromPoint is how
    // a user's click would resolve, so it is the honest measurement.
    topIsPicker: top === picker || picker.contains(top),
  }
})()`)
console.log(`stacking (picker rendered first): picker z=${stack.pickerZ}, notice z=${stack.toastZ} -> topmost=${stack.topId}`)
if (stack.pickerZ === stack.toastZ) {
  console.error(`\nFAIL: the video-picker backdrop and the canvas notice are tied at z-index ${stack.pickerZ}.`)
  console.error('Which one covers the other is then decided by document order, not by')
  console.error('the scale -- the exact coincidence the shared scale exists to remove.')
  process.exit(1)
}
if (!stack.topIsPicker) {
  console.error(`\nFAIL: the canvas notice paints over the video-picker backdrop (topmost=${stack.topId}).`)
  console.error('The picker opens full-screen over the canvas, so its backdrop has to cover')
  console.error('the notice; with both at 60 this only worked because of render order.')
  process.exit(1)
}
console.log('stacking: the picker backdrop covers the notice regardless of render order')

// --- the keyed `main` slot yields the column to the studio (#38) ------------
// Switching to the studio used to leave a shell panel rendering inside the same
// `main` anchor as the Conversation, so the studio never appeared to take over.
// The activation attribute is set HERE (the shell sets it when the entry is
// clicked), and the assertion reads COMPUTED display: only the cascade proves
// the market page is gone, because the element is still mounted either way.
const mainTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?mainslot=1`)}`, { method: 'PUT' })).json()
const ws4 = new WebSocket(mainTarget.webSocketDebuggerUrl)
await new Promise(r => { ws4.onopen = r })
let id4 = 0
const send4 = (method, params) => new Promise(resolve => {
  const myId = ++id4
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws4.removeEventListener('message', onMessage); resolve(m) } }
  ws4.addEventListener('message', onMessage)
  ws4.send(JSON.stringify({ id: myId, method, params }))
})
await send4('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))
const takeover = await send4('Runtime.evaluate', {
  expression: `(() => {
    document.documentElement.setAttribute('data-dsh-imagegen-active', '')
    const display = id => getComputedStyle(document.getElementById(id)).display
    return {
      shellPanel: display('shellPanel'),
      conversation: display('conversation'),
      studio: display('studio'),
      otherEntry: display('otherEntry'),
      anchor: display('centre'),
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
if (takeover.result?.exceptionDetails !== undefined) {
  throw new Error(`page threw: ${JSON.stringify(takeover.result.exceptionDetails)}`)
}
const slot = takeover.result.result.value
console.log(`main slot: shell panel=${slot.shellPanel}, conversation=${slot.conversation}, studio=${slot.studio}, other plugin=${slot.otherEntry}`)
if (slot.shellPanel !== 'none') {
  console.error('\nFAIL: a shell panel inside the keyed `main` slot is still rendered (#38).')
  console.error('The Conversation and a shell-global panel (the plugin market page)')
  console.error('both register into that one slot, so the studio shares the column with a')
  console.error('live panel and switching to it looks like it did nothing.')
  process.exit(1)
}
if (slot.conversation === 'none') {
  console.error('\nFAIL: the takeover hid the Conversation along with the shell panel.')
  console.error('The studio keeps the conversation in its chat track, so the rule has to')
  console.error('let the phase-bearing Conversation entry through.')
  process.exit(1)
}
if (slot.studio === 'none') {
  console.error('\nFAIL: the studio never became visible, so the fixture proves nothing.')
  process.exit(1)
}
// The other half of the same takeover: an unrelated plugin entry that sits in
// the column is evicted. Without this assertion the rule could stop matching
// (as it did when the column was addressed by `[class*='centerCol']` and this
// fixture still spelled the class) and the check would stay green.
if (slot.otherEntry !== 'none') {
  console.error('\nFAIL: an unrelated center-column plugin entry is still rendered inside the studio.')
  console.error('The takeover is single-occupant: only the studio view, the keyed `main`')
  console.error('anchor and the chat resizer may stay, so everything else in the column')
  console.error('has to yield while the studio is active.')
  process.exit(1)
}
console.log('main slot: the shell panel yields the column while the conversation stays')

// --- the source row has to stay reachable as the registry grows -------------
// The contract check above reads the declarations; a declaration is not the
// same thing as a row a user can reach. This one only the browser can settle,
// because what used to be wrong was invisible in the source: `nowrap` tabs in a
// plain flex box are all laid out (so every width measures fine) and the ones
// past the edge are simply never painted. Rendered at 420px -- narrow enough
// that the eight registered labels cannot fit -- the page is asked what a user
// would ask: turn the wheel over the row, then look at the last tab.
const tabsTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?sourcetabs=1`)}`, { method: 'PUT' })).json()
const ws5 = new WebSocket(tabsTarget.webSocketDebuggerUrl)
await new Promise(r => { ws5.onopen = r })
let id5 = 0
const send5 = (method, params) => new Promise(resolve => {
  const myId = ++id5
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws5.removeEventListener('message', onMessage); resolve(m) } }
  ws5.addEventListener('message', onMessage)
  ws5.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate5 = async expression => {
  const res = await send5('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send5('Runtime.enable', {})
await new Promise(r => setTimeout(r, 300))

// What a user can see of the LAST tab is the question, so it is measured by
// hit-testing at the tab's own centre -- the coordinate a click would land on.
// Its rect alone would not do: an element scrolled out of a clipping box still
// reports a rect, just at coordinates the row does not occupy.
const tabRowState = () => evaluate5(`(() => {
  const row = document.getElementById('tabs')
  const last = document.getElementById('last')
  const band = row.getBoundingClientRect()
  const box = last.getBoundingClientRect()
  const x = Math.round(box.left + box.width / 2)
  const y = Math.round(box.top + box.height / 2)
  const hit = document.elementFromPoint(x, y)
  return {
    scrollLeft: Math.round(row.scrollLeft),
    maxScroll: Math.round(row.scrollWidth - row.clientWidth),
    overflowX: getComputedStyle(row).overflowX,
    lastVisible: x >= band.left && x <= band.right && (hit === last || last.contains(hit)),
    lastFullyInsideRow: box.left >= band.left - 0.5 && box.right <= band.right + 0.5,
    verticallyClipped: row.scrollHeight > row.clientHeight + 1,
    // Where to aim the wheel: inside the row, wherever the row is.
    wheelAt: [Math.round(band.left + band.width / 2), Math.round(band.top + band.height / 2)],
  }
})()`)

const beforeTabs = await tabRowState()
let afterTabs = beforeTabs
let previousLeft = -1
for (let i = 0; i < 12; i++) {
  previousLeft = afterTabs.scrollLeft
  await send5('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: beforeTabs.wheelAt[0], y: beforeTabs.wheelAt[1],
    deltaX: 300, deltaY: 0,
  })
  await new Promise(r => setTimeout(r, 90))
  afterTabs = await tabRowState()
  if (afterTabs.scrollLeft === previousLeft) break
}
console.log(`source row at 420px: overflow-x=${afterTabs.overflowX}, content overflows by ${beforeTabs.maxScroll}px, wheel scrolled it ${beforeTabs.scrollLeft} -> ${afterTabs.scrollLeft}px`)

if (beforeTabs.maxScroll <= 0) {
  console.error('\nFAIL: the eight source labels fit inside 420px, so this fixture proves nothing.')
  console.error('Widen the registry in the fixture or narrow the host; the point of the check')
  console.error('is the row that overflows.')
  process.exit(1)
}
if (afterTabs.scrollLeft <= beforeTabs.scrollLeft) {
  console.error(`\nFAIL: a wheel over the source row does not move it (scrollLeft stayed ${beforeTabs.scrollLeft}).`)
  console.error('The tabs past the edge are then unreachable: the row clips instead of')
  console.error('scrolling, so every source after the last visible one is invisible and')
  console.error('unclickable, with nothing on screen saying it exists.')
  process.exit(1)
}
if (afterTabs.lastVisible !== true || afterTabs.lastFullyInsideRow !== true) {
  console.error(`\nFAIL: the last template source tab cannot be brought into view (scrollLeft=${afterTabs.scrollLeft} of ${afterTabs.maxScroll}).`)
  console.error('It has to end up inside the row after scrolling to the end, because a')
  console.error('source the user cannot reach is a source that does not exist.')
  process.exit(1)
}
if (afterTabs.verticallyClipped) {
  console.error('\nFAIL: the source row is clipping its tabs vertically.')
  console.error('`overflow-y: hidden` is there to keep a scrollbar off the tab strip,')
  console.error('not to cut the tabs themselves.')
  process.exit(1)
}
console.log('source row: the last tab scrolls into view and hit-tests to itself')

// --- the injected switcher lines up with the shell button (issue #25) -------
// `openPage` from the shared launcher instead of a hand-rolled CDP session:
// this file already carries seven of them, all numbered, and a duplicate `ws7`
// is a syntax error rather than a bug you get to debug.
const sidebarPage = await openPage(launched.port, `http://127.0.0.1:${port}/?sidebartabs=1`)
// `openPage` returns as soon as the target exists, which can be before the
// navigation commits. Polling for the element is the honest wait: a fixed sleep
// would pass on this machine and fail on a slower one, and evaluating against a
// blank document reports `null.getBoundingClientRect` rather than a layout bug.
let sidebarReady = false
for (let i = 0; i < 60; i++) {
  sidebarReady = await sidebarPage.evaluate(`document.readyState === 'complete' && document.getElementById('tabs') !== null && document.querySelector('.newSession') !== null`)
  if (sidebarReady === true) break
  await new Promise(r => setTimeout(r, 50))
}
if (sidebarReady !== true) {
  console.error('\nFAIL: the sidebar fixture never rendered its switcher and New Session button.')
  console.error('That is a broken fixture, not a passing check: nothing was measured.')
  process.exit(1)
}

// Sub-pixel: 272 vs 256px is 16px of drift, but the two edges can disagree by
// a fraction after the browser rounds a calc() margin. A half-pixel is the
// tolerance; anything a person could see is far past it.
const sidebarGeometry = await sidebarPage.evaluate(`(() => {
  const r = e => { const q = e.getBoundingClientRect(); return { left: q.left, right: q.right, width: q.width, top: q.top, bottom: q.bottom } }
  const tabs = document.getElementById('tabs')
  const button = document.querySelector('.newSession')
  const t = r(tabs)
  const b = r(button)
  return {
    tabs: t,
    button: b,
    leftDrift: Math.abs(t.left - b.left),
    rightDrift: Math.abs(t.right - b.right),
    gap: b.top - t.bottom,
    boxSizing: getComputedStyle(tabs).boxSizing,
    marginLeft: getComputedStyle(tabs).marginLeft,
    marginRight: getComputedStyle(tabs).marginRight,
    marginBottom: getComputedStyle(tabs).marginBottom,
    columnWidth: document.getElementById('root').getBoundingClientRect().width,
  }
})()`)
const fmt = n => `${Math.round(n * 100) / 100}px`
console.log(`sidebar switcher: tabs ${fmt(sidebarGeometry.tabs.left)}..${fmt(sidebarGeometry.tabs.right)}, `
  + `button ${fmt(sidebarGeometry.button.left)}..${fmt(sidebarGeometry.button.right)}, `
  + `drift L/R ${fmt(sidebarGeometry.leftDrift)}/${fmt(sidebarGeometry.rightDrift)}, gap ${fmt(sidebarGeometry.gap)}, `
  + `box ${sidebarGeometry.boxSizing}`)

const sidebarProblems = []
if (sidebarGeometry.boxSizing !== 'border-box') {
  sidebarProblems.push(`the switcher computes box-sizing: ${sidebarGeometry.boxSizing}, so width:100% adds its padding and border on top`)
}
if (sidebarGeometry.leftDrift > 0.5) {
  sidebarProblems.push(`its left edge is ${fmt(sidebarGeometry.leftDrift)} off the New Session button's`)
}
if (sidebarGeometry.rightDrift > 0.5) {
  sidebarProblems.push(`its right edge is ${fmt(sidebarGeometry.rightDrift)} off the New Session button's — the left drift alone does not catch the width overflow`)
}
if (Math.abs(sidebarGeometry.gap - 8) > 0.5) {
  sidebarProblems.push(`the gap above New Session is ${fmt(sidebarGeometry.gap)}, not the 8px every seat now carries`)
}
if (sidebarProblems.length > 0) {
  console.error('\nFAIL: the injected session/image switcher does not line up with the shell button (issue #25):')
  for (const problem of sidebarProblems) console.error(`  - ${problem}`)
  console.error('It is a sibling of that button, so the two have to share one inset. Left drift,')
  console.error('right drift and the vertical gap are three separate consequences of the same')
  console.error('box model, and a source review can see none of them.')
  process.exit(1)
}
console.log('sidebar switcher: same inset and one 8px gap against the shell button')

// --- the history surface owns its wheel events ------------------------------
// Measured with real wheel input, because the defect is a real-browser one: the
// shell's handoff calls preventDefault() on the same bubble path, and nothing
// in jsdom can tell you whether the browser then scrolled the list or not.
const historyPage = await openPage(launched.port, `http://127.0.0.1:${port}/?historyscroll=1`)
let historyReady = false
for (let i = 0; i < 60; i++) {
  historyReady = await historyPage.evaluate(`document.readyState === 'complete' && document.getElementById('list') !== null && document.getElementById('host').hasAttribute('data-dsh-imagegen-wheel-owner')`)
  if (historyReady === true) break
  await new Promise(r => setTimeout(r, 50))
}
if (historyReady !== true) {
  console.error('\nFAIL: the history fixture never installed its wheel containment.')
  console.error('Either the page did not load or containHistoryWheel did not mark the host;')
  console.error('nothing was measured either way.')
  process.exit(1)
}
await historyPage.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
const historyGeometry = await historyPage.evaluate(`(() => {
  const list = document.getElementById('list')
  const tree = document.getElementById('treeScroll')
  list.scrollTop = 0
  tree.scrollTop = 0
  const r = list.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(100, r.height / 2)), listScrollable: list.scrollHeight - list.clientHeight, treeScrollable: tree.scrollHeight - tree.clientHeight }
})()`)
if (historyGeometry.listScrollable < 200 || historyGeometry.treeScrollable < 200) {
  console.error('\nFAIL: the history fixture cannot show the defect.')
  console.error(`list scrollable ${historyGeometry.listScrollable}px, tree scrollable ${historyGeometry.treeScrollable}px —`)
  console.error('both have to overflow, or "the list scrolled" and "the tree scrolled instead" are')
  console.error('indistinguishable from "there was nothing to scroll".')
  process.exit(1)
}
await historyPage.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: historyGeometry.x, y: historyGeometry.y })
await new Promise(r => setTimeout(r, 80))
for (let i = 0; i < 3; i++) {
  await historyPage.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: historyGeometry.x, y: historyGeometry.y, deltaX: 0, deltaY: 200 })
  await new Promise(r => setTimeout(r, 120))
}
await new Promise(r => setTimeout(r, 200))
const historyAfter = await historyPage.evaluate(`({ list: Math.round(document.getElementById('list').scrollTop), tree: Math.round(document.getElementById('treeScroll').scrollTop) })`)
historyPage.close()
if (historyAfter.list < 100) {
  console.error('\nFAIL: a wheel over the history surface does not scroll the history list.')
  console.error(`After three wheel steps the list is at ${historyAfter.list}px and the shell's session tree at ${historyAfter.tree}px.`)
  console.error('DSH 0.2.2 runs a scroll handoff on an ancestor of this host: for any event that is')
  console.error('not its own tree it calls preventDefault() and scrolls the tree instead, which in the')
  console.error('studio is painted over by the list. The host has to claim its own wheel events.')
  process.exit(1)
}
if (historyAfter.tree > 0) {
  console.error('\nFAIL: the wheel over the history list also scrolled the shell session tree.')
  console.error(`list ${historyAfter.list}px, tree ${historyAfter.tree}px — the handoff still received the event.`)
  process.exit(1)
}
console.log(`history list: wheel scrolled it ${historyAfter.list}px while the shell session tree stayed at ${historyAfter.tree}px`)

// --- the shortcut legend fits the canvas it opens over ----------------------
const shortcutTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?shortcuts=1`)}`, { method: 'PUT' })).json()
const ws6 = new WebSocket(shortcutTarget.webSocketDebuggerUrl)
await new Promise(r => { ws6.onopen = r })
let id6 = 0
const send6 = (method, params) => new Promise(resolve => {
  const myId = ++id6
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws6.removeEventListener('message', onMessage); resolve(m) } }
  ws6.addEventListener('message', onMessage)
  ws6.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate6 = async expression => {
  const res = await send6('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send6('Runtime.enable', {})

// Measured as a user would see it: the dialog's own box against the viewport,
// and each row's content against the column that holds it. `scrollWidth` on the
// row is the honest signal for a chip that has been pushed out -- the elements
// all report a rect whether or not the column clips them.
const measureLegend = () => evaluate6(`(() => {
  const dialog = document.getElementById('dialog')
  const body = document.getElementById('body')
  const box = dialog.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.row')]
  const overflowing = rows.filter(row => row.scrollWidth > row.clientWidth + 1).length
  // A label that has been pushed past its column's right edge is unreadable
  // even when the row itself does not scroll: text-align:right puts the tail of
  // a long label under the chips.
  const pushed = rows.filter(row => {
    const label = row.querySelector('.label')
    const keys = row.querySelector('.keys')
    const column = row.getBoundingClientRect()
    const tail = label.getBoundingClientRect()
    return tail.right > column.right + 1 || tail.left < keys.getBoundingClientRect().right - 1
  }).length
  return {
    viewport: [window.innerWidth, window.innerHeight],
    dialogTop: Math.round(box.top),
    dialogBottom: Math.round(box.bottom),
    fitsVertically: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5,
    bodyScrolls: getComputedStyle(body).overflowY,
    bodyScrollable: body.scrollHeight > body.clientHeight + 1,
    columns: getComputedStyle(body).gridTemplateColumns,
    rows: rows.length,
    overflowing,
    pushed,
  }
})()`)

await send6('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 250))
const wideLegend = await measureLegend()
// Not `mobile: true`: without a `<meta name="viewport">` in the fixture the
// mobile override lays the page out at the 980px default and the breakpoint
// below 560px never fires -- which would make this check pass by measuring a
// width the user never sees. The narrow case here is a layout question, so it
// is asked as a CSS viewport width.
await send6('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 250))
const narrowLegend = await measureLegend()
await send6('Emulation.clearDeviceMetricsOverride', {})
console.log(`shortcut legend: ${wideLegend.rows} rows, ${wideLegend.viewport.join('x')} -> single column ${narrowLegend.viewport.join('x')}`)

if (wideLegend.fitsVertically !== true) {
  console.error(`\nFAIL: the shortcut legend is taller than the viewport it opens in (top=${wideLegend.dialogTop}, bottom=${wideLegend.dialogBottom}).`)
  console.error('The dialog caps itself at the viewport and scrolls its body; if that cap')
  console.error('is gone the bottom groups -- and the close button\'s context -- are off')
  console.error('screen with no way to reach them.')
  process.exit(1)
}
if (wideLegend.overflowing > 0) {
  console.error(`\nFAIL: ${wideLegend.overflowing} shortcut rows overflow their column.`)
  console.error('A row wider than its grid column pushes the label out of the dialog,')
  console.error('so the key and the thing it does are no longer readable together.')
  process.exit(1)
}
if (wideLegend.pushed > 0) {
  console.error(`\nFAIL: ${wideLegend.pushed} shortcut labels collide with their key chips.`)
  console.error('The label column is text-align: right; without room it runs under the')
  console.error('chips and the row reads as one run-on string.')
  process.exit(1)
}
// One column below 560px: two columns of key chips at 390px wrap into noise.
const narrowTracks = narrowLegend.columns.split(' ').filter(part => part.trim() !== '')
if (narrowTracks.length !== 1) {
  console.error(`\nFAIL: the legend keeps two columns at ${narrowLegend.viewport[0]}px (grid-template-columns: ${narrowLegend.columns}).`)
  console.error('At phone width the two tracks leave too little room per row, which is')
  console.error('what the single-column breakpoint is for.')
  process.exit(1)
}
if (narrowLegend.overflowing > 0 || narrowLegend.pushed > 0) {
  console.error(`\nFAIL: the legend breaks at ${narrowLegend.viewport.join('x')} (${narrowLegend.overflowing} overflowing rows, ${narrowLegend.pushed} pushed labels).`)
  process.exit(1)
}
console.log('shortcut legend: fits the viewport at desktop width, single column on a phone')

// --- the nav pill must not drift when the row scrolls -----------------------
// A click is how the user reaches the far end of the row, and a click is what
// repositions the pill (`burstRef` -> `updateEffectPosition`). So the fixture
// drives a real mouse press on the last tab, at the tab's own centre, after
// scrolling the row to its end -- the same gesture that produced the report.
const navTarget = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?navscroll=1`)}`, { method: 'PUT' })).json()
const ws7 = new WebSocket(navTarget.webSocketDebuggerUrl)
await new Promise(r => { ws7.onopen = r })
let id7 = 0
const send7 = (method, params) => new Promise(resolve => {
  const myId = ++id7
  const onMessage = e => { const m = JSON.parse(e.data); if (m.id === myId) { ws7.removeEventListener('message', onMessage); resolve(m) } }
  ws7.addEventListener('message', onMessage)
  ws7.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate7 = async expression => {
  const res = await send7('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`)
  }
  return res.result.result.value
}
await send7('Runtime.enable', {})
let navReady = false
for (let i = 0; i < 40; i++) {
  navReady = (await evaluate7('window.__navReady === true')) === true
  if (navReady) break
  await new Promise(r => setTimeout(r, 100))
}
if (!navReady) {
  console.error('\nFAIL: the GooeyNav component never mounted in the scroll-drift fixture.')
  console.error('The decoration spans are what drift, so a page without them proves')
  console.error('nothing -- this is a broken harness, not a pass.')
  process.exit(1)
}

// Measured the way the user sees it: the decoration's own box against the
// active tab's box. Both are read in viewport coordinates, so a drift between
// them is visible on screen as two copies of the same label.
const navDrift = () => evaluate7(`(() => {
  const container = document.querySelector('.container')
  const tabs = [...container.querySelectorAll('li')]
  const active = tabs.find(li => li.classList.contains('active')) ?? tabs[0]
  const text = container.querySelector('.effectText')
  const pill = container.querySelector('.effectFilter')
  const box = active.getBoundingClientRect()
  const textBox = text.getBoundingClientRect()
  const pillBox = pill.getBoundingClientRect()
  const activeX = Math.round(box.left)
  return {
    scrollLeft: Math.round(container.scrollLeft),
    maxScroll: Math.round(container.scrollWidth - container.clientWidth),
    activeX,
    textX: Math.round(textBox.left),
    pillX: Math.round(pillBox.left),
    textDrift: Math.round(textBox.left) - activeX,
    pillDrift: Math.round(pillBox.left) - activeX,
    textWidth: Math.round(textBox.width),
    activeWidth: Math.round(box.width),
    tabCount: tabs.length,
  }
})()`)
const navDriftReport = state => `scrollLeft=${state.scrollLeft}/${state.maxScroll}, active li at x=${state.activeX}, effectText at x=${state.textX} (drift ${state.textDrift}px), pill at x=${state.pillX} (drift ${state.pillDrift}px)`

// First prove the fixture actually overflows. A row that fits measures a drift
// of 0 whether or not the fix is in, which would make every assertion below
// vacuous -- the same false green the 1440px window produced.
const overflow = await navDrift()
console.log(`nav row at 520px: ${overflow.tabCount} tabs, content overflows by ${overflow.maxScroll}px`)
if (overflow.maxScroll <= 0) {
  console.error('\nFAIL: the nine nav labels fit inside 520px, so this fixture proves nothing.')
  console.error('Narrow #host or add labels: the point of the check is the row that')
  console.error('overflows, because that is the only state where the drift is visible.')
  process.exit(1)
}

// State 1: scrolled to the end, then the last tab clicked -- the reported
// gesture. The click is a real mouse press at the tab's own centre, so it also
// exercises the burst path (which calls updateEffectPosition itself).
await evaluate7(`(() => {
  const container = document.querySelector('.container')
  container.scrollLeft = container.scrollWidth
  return container.scrollLeft
})()`)
const lastTab = await evaluate7(`(() => {
  const container = document.querySelector('.container')
  const li = [...container.querySelectorAll('li')].at(-1)
  const box = li.getBoundingClientRect()
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
})()`)
await send7('Input.dispatchMouseEvent', { type: 'mousePressed', x: lastTab.x, y: lastTab.y, button: 'left', clickCount: 1 })
await send7('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastTab.x, y: lastTab.y, button: 'left', clickCount: 1 })
// The pill animates over 300ms and the particle burst runs longer; waiting for
// the transition to settle is what keeps this from reading a mid-animation box.
await new Promise(r => setTimeout(r, 700))
const afterSelect = await navDrift()
console.log(`after selecting the last tab while scrolled right: ${navDriftReport(afterSelect)}`)

// State 2 and 3: the same row, scrolled elsewhere, with the selection held.
// These are the states that catch a fix that only works for one scroll offset
// (for instance one that caches the scroll amount at selection time).
const scrollStates = [0, 140]
const observed = [afterSelect]
for (const scrollLeft of scrollStates) {
  await evaluate7(`(() => { document.querySelector('.container').scrollLeft = ${scrollLeft} })()`)
  await new Promise(r => setTimeout(r, 250))
  const state = await navDrift()
  console.log(`after scrolling the row back to ${scrollLeft}: ${navDriftReport(state)}`)
  observed.push(state)
}

for (const state of observed) {
  if (Math.abs(state.textDrift) > 1 || Math.abs(state.pillDrift) > 1) {
    console.error(`\nFAIL: the GooeyNav decoration drifts off the active tab by ${state.textDrift}px (ink) / ${state.pillDrift}px (pill) at scrollLeft=${state.scrollLeft}.`)
    console.error(`  active li at x=${state.activeX}, effectText at x=${state.textX}, pill at x=${state.pillX}`)
    console.error('The pill and its ink are positioned in the container\'s CONTENT space')
    console.error('but computed from VIEWPORT coordinates, so after the row scrolls they')
    console.error('stay at the pre-scroll offset. The user then sees the active label twice:')
    console.error('once in the row, once painted under it by `span.effectText`.')
    console.error('Add container.scrollLeft / container.scrollTop to the offsets.')
    process.exit(1)
  }
}
// And the decoration has to be the same SIZE as the tab it covers, or it is a
// second, differently-shaped label rather than a copy of the same one.
for (const state of observed) {
  if (Math.abs(state.textWidth - state.activeWidth) > 1) {
    console.error(`\nFAIL: the effect ink is ${state.textWidth}px wide over a ${state.activeWidth}px tab.`)
    console.error('A decoration that does not cover its own tab reads as a second,')
    console.error('differently-sized label -- which is the defect this fixture is about.')
    process.exit(1)
  }
}
console.log('nav pill: follows the active tab at every scroll offset, no double label')

// --- #14: a long model-alias badge must not push the channel row out --------
// `.channelBadge` carried `white-space: nowrap` with no way to shrink, so a
// channel whose catalog is a long alias list set the row's min-content width.
// In the host's 850px settings window (≈640px of pane) the rows ran wider than
// the card, and `.settingsSection`'s `overflow: clip` swallowed the excess with
// no scrollbar -- the user saw a cut edge and had no way to know content was
// there. Measured in a real browser because this is entirely a layout outcome:
// jsdom has no layout engine and would report a width of 0 for everything.
const settingsCss = read('settings-card.module.css')
const longAliases = '已设置密钥 · qwen-image-3.0-pro · qwen-image-3.0 · qwen-vl-max-2025-08-13 · qwen-image-edit-plus · wan-2.5-i2v'
const settingsRow = name => `
  <li class="channelRow">
    <span class="channelDotReady" aria-hidden="true"></span>
    <button type="button" class="channelMain">
      <span class="channelName">★ ${name}</span>
      <span class="channelMeta"><span class="channelBadge">${longAliases}</span></span>
    </button>
    <button type="button" class="channelAction">编辑</button>
    <button type="button" class="channelAction" data-danger>删除</button>
  </li>`
const settingsPage = `<!doctype html><html><head><style>
  body { margin: 0; display: flex; }
  /* The host's settings window is 850px wide and its nav takes ~210px. */
  #nav { flex: none; width: 210px; }
  /* 'auto' is the hostile case: as a grid item the card's automatic minimum
     becomes min-content, so a wide child widens the track instead of wrapping. */
  #pane { flex: 1 1 auto; min-width: 0; padding: 12px; box-sizing: border-box; display: grid; grid-template-columns: auto; }
  ${settingsCss}
</style></head><body>
  <div id="nav"></div>
  <div id="pane">
    <section class="card">
      <div class="body">
        <section class="settingsSection" data-open>
          <ul class="channelList">
            ${settingsRow('即梦方舟 (Seedream / Seedance)')}
            ${settingsRow('清衍 API')}
          </ul>
        </section>
        <div class="footer"><button type="button" class="save">保存</button></div>
      </div>
    </section>
  </div>
</body></html>`

const settingsPageSession = await openPage(launched.port, `http://127.0.0.1:${port}/?settings850=1`)
await settingsPageSession.send('Emulation.setDeviceMetricsOverride', { width: 850, height: 800, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 400))

const settingsFit = await settingsPageSession.evaluate(`(() => {
  const pane = document.getElementById('pane')
  const pb = pane.getBoundingClientRect()
  const card = document.querySelector('.card')
  const cb = card.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.channelRow')]
  const doc = document.documentElement
  return {
    pane: Math.round(pb.width),
    cardWidth: Math.round(cb.width),
    cardInside: cb.left >= pb.left - 0.5 && cb.right <= pb.right + 0.5,
    rowOverflow: rows.map(r => r.scrollWidth - r.clientWidth),
    docOverflow: doc.scrollWidth > doc.clientWidth,
    sectionOverflowX: getComputedStyle(document.querySelector('.settingsSection')).overflowX,
  }
})()`)
console.log(`settings card at 850px: pane ${settingsFit.pane}px, card ${settingsFit.cardWidth}px, row overflow ${JSON.stringify(settingsFit.rowOverflow)}, section overflow-x=${settingsFit.sectionOverflowX}`)

if (!settingsFit.cardInside) {
  console.error('\nFAIL: at the host\'s default 850px settings window the card hangs outside its pane.')
  console.error(`  card is ${settingsFit.cardWidth}px in a ${settingsFit.pane}px pane (cardInside=${settingsFit.cardInside})`)
  console.error('A card that is a grid item takes its automatic minimum from min-content,')
  console.error('so one wide child widens the track and the card overhangs both edges —')
  console.error('which is what the user reported as "titles cut off on both sides".')
  console.error('Keep `min-width: 0` on .card / .body and let the badge shrink.')
  process.exit(1)
}
if (settingsFit.rowOverflow.some(delta => delta > 1)) {
  console.error('\nFAIL: a channel row is wider than its container, so its content is clipped.')
  console.error(`  row scrollWidth - clientWidth = ${JSON.stringify(settingsFit.rowOverflow)}`)
  console.error('The badge names the whole model catalog with `white-space: nowrap`;')
  console.error('without `min-width: 0; overflow: hidden` it sets the row\'s floor and')
  console.error('pushes the trailing 编辑/删除 buttons out of the visible card.')
  process.exit(1)
}
if (settingsFit.docOverflow) {
  console.error('\nFAIL: the settings page scrolls horizontally at 850px.')
  process.exit(1)
}
if (settingsFit.sectionOverflowX === 'clip') {
  console.error('\nFAIL: `.settingsSection` clips its overflow, so any excess is lost')
  console.error('silently — no scrollbar, no hint that content was reachable. That was')
  console.error('the third symptom in #14: the user could not tell the page overflowed.')
  process.exit(1)
}
console.log('settings card: fits the 850px pane, no row overflows, overflow stays reachable')

settingsPageSession.close()

// --- the lightbox chrome must not follow the theme's inversion --------------
// The full-screen preview is a FIXED dark surface (`.lightbox` paints a dark
// photo mask). Its buttons used `--dsw-alias-label-primary-inverted` for text
// and `--dsw-specific-input-major` for the pill, and in a LIGHT theme those
// resolve to white text on the theme's white input background: contrast 1.0,
// so every control was invisible until :hover swapped the background for the
// dark mask. Measured rather than read, because the failure is a computed
// colour pair, and composited rather than compared raw — the surface is
// translucent, so it has to be blended onto the mask before the ratio means
// anything.
const lightboxCss = read('panel.module.css')
// The two palettes DSH actually ships, read from dsh-client-ui-theme rather
// than invented here. The point of the pair is `label-primary-foreground`: it
// is #fff on `body` and #0f1115 on `body[data-ds-dark-theme]`. An early version
// of this fixture hardcoded it to #ffffff and only ever rendered the light
// theme, so the check stayed green while every control in the dark theme was
// the same colour as the mask it sat on.
const LIGHTBOX_PALETTES = [
  {
    name: 'light',
    bodyAttr: '',
    pageBackground: '#ffffff',
    tokens: `--dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-primary-inverted: #ffffff;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-static-neutral-00: #ffffff;
  --dsw-alias-label-dimmed: #6b7280;
  --dsw-alias-bg-mask-2: #0000001f;
  --dsw-alias-bg-mask-photo: #000000e0;
  --dsw-alias-border-l2: #0000001a;
  --dsw-specific-input-major: #ffffff;`,
  },
  {
    name: 'dark',
    bodyAttr: ' data-ds-dark-theme=""',
    pageBackground: '#151517',
    tokens: `--dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-primary-inverted: #353638;
  --dsw-alias-label-primary-foreground: #0f1115;
  --dsw-static-neutral-00: #ffffff;
  --dsw-alias-label-dimmed: #a2a4a6;
  --dsw-alias-bg-mask-2: #0003;
  --dsw-alias-bg-mask-photo: #000000e0;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-specific-input-major: #353638;`,
  },
]
const lightboxPage = palette => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { ${palette.tokens} }
  body { margin: 0; background: ${palette.pageBackground}; height: 3000px; }
/* The workbench the overlay covers is scrollable, which is what makes a
   scroll-chain observable: a notch that escapes the overlay moves this page. */
body::after { content: ''; display: block; height: 3000px; }
${lightboxCss}
</style></head><body${palette.bodyAttr}>
<div class="lightbox" data-preview-overlay="">
  <figure class="lightboxFigure">
    <div class="lightboxStage" data-preview-stage="">
      <div class="lightboxTools" role="group">
        <button type="button" class="lightboxTool" id="lbOut">−</button>
        <button type="button" class="lightboxZoomLevel" id="lbLevel">100%</button>
        <button type="button" class="lightboxTool" id="lbIn">+</button>
      </div>
      <div class="lightboxCaptionRow"><figcaption class="lightboxCaption" id="lbCap">prompt</figcaption>
        <button type="button" class="lightboxCopy" id="lbCopy">copy</button></div>
      <div class="lightboxMeta">
        <span class="lightboxIndex" id="lbIndex">1 / 4</span>
        <div class="lightboxActions">
          <a class="lightboxDownload" id="lbDl" href="#">download</a>
          <button type="button" class="lightboxEdit" id="lbEd">edit</button>
        </div>
      </div>
    </div>
  </figure>
  <button type="button" class="lightboxClose" id="lbClose">×</button>
</div>
</body></html>`

// Each palette is rendered and measured on its own page, reusing one tab.
// Rendering only the light one is what let a dark-theme regression ship: the
// fixture's tokens were plausible, the assertion was real, and the theme that
// breaks was never drawn.
const lightboxSession = await openPage(launched.port, 'about:blank')
for (const palette of LIGHTBOX_PALETTES) {
await lightboxSession.send('Page.setDocumentContent', {
  frameId: (await lightboxSession.send('Page.getFrameTree')).result.frameTree.frame.id,
  html: lightboxPage(palette),
})
await new Promise(r => setTimeout(r, 300))
const lightboxContrast = await lightboxSession.evaluate(`(() => {
  ${WCAG_CONTRAST_SOURCE}
  const white = { r:255,g:255,b:255,a:1 }
  const lb = document.querySelector('.lightbox')
  const maskBg = composite(parseColour(getComputedStyle(lb).backgroundColor), white)
  const out = []
  for (const id of ['lbOut','lbLevel','lbIn','lbCopy','lbDl','lbEd','lbClose','lbCap','lbIndex']) {
    const el = document.getElementById(id)
    if (el === null) continue
    const cs = getComputedStyle(el)
    const own = parseColour(cs.backgroundColor)
    const bg = own === null || own.a === 0 ? maskBg : composite(own, maskBg)
    // Two ratios per element, because they fail in different ways:
    //  - the ink has to be readable ON its own pill (1.4.3, text: 4.5)
    //  - the pill/border has to be findable against the mask (1.4.11: 3)
    out.push({
      id,
      ratio: Math.round(contrastRatio(parseColour(cs.color), bg) * 100) / 100,
      boundary: Math.round(contrastRatio(bg, maskBg) * 100) / 100,
      color: cs.color,
    })
  }
  return out
})()`)
const lightboxBad = lightboxContrast.filter(entry => entry.ratio < 4.5)
console.log(`lightbox chrome in a ${palette.name.toUpperCase()} theme: ${lightboxContrast.length} elements, lowest ink contrast ${Math.min(...lightboxContrast.map(e => e.ratio))}:1`)
if (lightboxBad.length > 0) {
  console.error(`\nFAIL: lightbox chrome is unreadable in a ${palette.name} theme.`)
  for (const entry of lightboxBad) console.error(`  ${entry.id}: ink contrast ${entry.ratio}:1 (color ${entry.color})`)
  console.error('The lightbox is a fixed DARK surface, so its text and pills must not')
  console.error('follow the theme\'s inversion. `--dsw-alias-label-primary-foreground`')
  console.error('LOOKS right — it is the "text on a solid colour" token — but it is')
  console.error('theme-coupled: #fff on `body`, #0f1115 on `body[data-ds-dark-theme]`.')
  console.error('Mixed into the chrome it made every control the same colour as the')
  console.error('mask (1.03-1.15:1) in a dark theme. Use a static palette step')
  console.error('(`--dsw-static-neutral-00`) for chrome that sits on artwork.')
  console.error('Keep the chrome on the --lightbox-ink / --lightbox-surface pair.')
  process.exit(1)
}

// --- every control has to be FINDABLE, not just readable --------------------
// Issue #22: the photo preview had a close button the reporter "could not find",
// and the check above was green throughout: it measured the glyph against its
// own pill, so a white icon on a 16%-white disc on an 82%-black mask scored
// perfectly. Issue #22's follow-up ("dark mode, those buttons are all invisible")
// was the same shape — the ink was fine relative to a pill that had itself
// dissolved into the mask.
//
// WCAG 1.4.11 asks the other question: is the component's own boundary
// distinguishable from what is behind it. The answer is the pill OR its ring
// against the mask, composited because both are translucent. Either may carry
// it — a filled disc and a strong ring are both legitimate, and demanding a
// specific one would dictate the design rather than the result.
const chromeBoundary = []
for (const id of ['lbOut','lbLevel','lbIn','lbCopy','lbDl','lbEd','lbClose']) {
  const measured = await lightboxSession.evaluate(`(() => {
    ${WCAG_CONTRAST_SOURCE}
    const white = { r:255,g:255,b:255,a:1 }
    const lb = document.querySelector('.lightbox')
    const mask = composite(parseColour(getComputedStyle(lb).backgroundColor), white)
    const el = document.getElementById(${JSON.stringify(id)})
    if (el === null) return JSON.stringify(null)
    const cs = getComputedStyle(el)
    const own = parseColour(cs.backgroundColor)
    const pill = own === null || own.a === 0 ? mask : composite(own, mask)
    const edge = parseColour(cs.borderTopColor)
    const ring = edge === null || edge.a === 0 ? mask : composite(edge, mask)
    const rect = el.getBoundingClientRect()
    // Rendered is not the same as reachable: a control painted under a sibling
    // looks exactly like one that is drawn, in source and in a screenshot.
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return JSON.stringify({
      id: ${JSON.stringify(id)},
      fill: Math.round(contrastRatio(pill, mask) * 100) / 100,
      edge: Math.round(contrastRatio(ring, mask) * 100) / 100,
      reachable: hit !== null && (hit === el || el.contains(hit)),
      hit: hit === null ? null : String(hit.id || hit.tagName || '').slice(0, 40),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  })()`)
  if (measured !== null && measured !== 'null') chromeBoundary.push(JSON.parse(measured))
}
const unfindable = chromeBoundary.filter(entry => Math.max(entry.fill, entry.edge) < 3)
const unreachable = chromeBoundary.filter(entry => !entry.reachable)
console.log(`lightbox controls in a ${palette.name.toUpperCase()} theme: ${chromeBoundary.length} measured, lowest boundary ${chromeBoundary.length === 0 ? 'n/a' : Math.min(...chromeBoundary.map(e => Math.max(e.fill, e.edge)))}:1`)
if (unfindable.length > 0 || unreachable.length > 0) {
  console.error(`\nFAIL: a lightbox control is not findable in a ${palette.name} theme (issue #22).`)
  for (const entry of unfindable) {
    console.error(`  ${entry.id}: fill ${entry.fill}:1, ring ${entry.edge}:1 (needs 3:1 from either)`)
  }
  for (const entry of unreachable) {
    console.error(`  ${entry.id}: centre hit-test resolves to ${String(entry.hit)}, not the control`)
  }
  console.error('A white glyph on a barely-lighter disc is legible and still invisible: the')
  console.error('user sees no button, only an icon floating on the photo. Raise the pill or')
  console.error('its ring against --dsw-alias-bg-mask-photo. `--lightbox-surface` (16%) and')
  console.error('`--lightbox-edge` (52%) are both below the bar.')
  process.exit(1)
}
}

// --- one wheel gesture must do one thing -----------------------------------
// The second half of issue #22: the preview scrolled AND zoomed on a single
// notch. `onWheel={e => { e.preventDefault(); … }}` cannot prevent anything —
// React 18 attaches wheel at the root as a PASSIVE listener, so preventDefault
// is a no-op with no warning, and the deck scrolls while the handler also
// changes the scale. A source invariant is the honest check here: headless
// Chromium cannot tell a passive listener from an active one without driving a
// real wheel against a mounted component, and the mounted component needs a
// React tree, a host and an image — three things that would make the check test
// the harness instead of the file.
/**
 * Comments stripped, string literals kept.
 *
 * Both directions of this check are fooled by prose. A comment that EXPLAINS the
 * defect — "the old `onWheel={e => { e.preventDefault(); … }}` prevented
 * nothing" — matches the search for the defect, and a comment that explains the
 * fix matches the search for the fix. Checks that read code have to read code.
 *
 * `transpileModule` rather than a hand-rolled scanner: `//` inside a regex
 * literal (`/https?:\/\//`) is not a comment, and telling those apart needs the
 * real lexer. typescript is already a devDependency (the typecheck runs on it),
 * and `jsx: Preserve` keeps the JSX markup intact so the attributes under test
 * are still there to match.
 * @param {string} source - the file's text.
 * @returns {string} the text with its comments removed.
 */
function stripComments (source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: true,
    },
    fileName: 'ImageGenPanel.tsx',
  }).outputText
}

const previewSource = stripComments(read('ImageGenPanel.tsx'))
const wheelProblems = []
if (!/data-preview-stage=""/.test(previewSource)) {
  wheelProblems.push('the preview stage no longer carries `data-preview-stage`, so the wheel contract is invisible to any test')
}
// The rule the fix has to state out loud: a user who does not know the modifier
// cannot discover it, and the reporter explicitly asked for one.
if (!/data-preview-zoom-hint=""/.test(previewSource)) {
  wheelProblems.push('nothing on screen says how to zoom (`data-preview-zoom-hint`)')
}
// Anchored to the STAGE listener: the overlay's containWheel binding further
// down also says `passive: false`, and an unanchored search let that one satisfy
// this check while the stage handler had gone passive (a negative case proved it).
if (!/stage\.addEventListener\(\s*'wheel'[\s\S]{0,120}?passive:\s*false/.test(previewSource)) {
  wheelProblems.push('no `addEventListener(\'wheel\', handler, { passive: false })` on the stage — without it preventDefault is dead code')
}
if (/onWheel=\{(?:(?!\}\}).){0,600}?preventDefault\(\)/s.test(previewSource)) {
  wheelProblems.push('a React `onWheel` still calls preventDefault(), which React 18 ignores')
}
// Both modifiers, because the reporter is on Windows (Ctrl) and the fix ships
// to macOS too (⌘). Gating on one key means half the users still get scroll+zoom.
for (const key of ['ctrlKey', 'metaKey']) {
  if (!new RegExp(`event\\.${key}`).test(previewSource)) wheelProblems.push(`the wheel gate ignores event.${key}`)
}
// The overlay has to contain the wheel, not just the stage inside it. Issue #22
// asked for it in as many words ("在预览层内操作时，不应同时带动底层工作台滚动"):
// the toolbar, the caption and the margin around the figure are all part of the
// preview the user is inside, and a notch landing there scrolls the workbench
// behind. Measured in a real browser below, not inferred from this string.
if (!previewSource.includes('data-preview-overlay=""')) {
  wheelProblems.push('the overlay no longer carries `data-preview-overlay`, so nothing can prove it contains the wheel')
}
if (wheelProblems.length > 0) {
  console.error('\nFAIL: a wheel notch over the preview still does two things (issue #22).')
  for (const entry of wheelProblems) console.error(`  - ${entry}`)
  console.error('Scroll is the default; zoom belongs behind Ctrl/⌘ and needs a non-passive')
  console.error('listener to suppress the scroll it replaces.')
  process.exit(1)
}
console.log('preview wheel: scroll is scroll, Ctrl/⌘ zooms through a non-passive listener')

// --- issue #31: a zoomed photo has to be draggable --------------------------
// The reporter's complaint was not "the gesture feels wrong" — there was no
// gesture. At 200% the image occupies real scrollable space, the stage is
// `overflow: auto`, and the ONLY way to reach the edges was the scrollbar in
// the margin. Nothing asserted panning, so nothing could fail: the wheel check
// above was green the whole time, because scroll-to-pan and drag-to-pan are
// different contracts that happened to share a container.
//
// Source invariants rather than a driven drag, and deliberately so: pointer
// capture, the pointerType gate and the click that follows a drag are decided
// by event ORDER inside a mounted React panel with a host and a real image —
// a fixture would have to re-implement the very listeners under test, and then
// it would only prove the fixture works.
const panProblems = []
if (!/PREVIEW_DRAG_THRESHOLD/.test(previewSource)) {
  panProblems.push('no drag threshold — every click would pan by its own jitter')
}
// Anchored to the STAGE: the panel has other pointerdown handlers (the config
// resizer, the canvas node drags), so an unanchored search proves nothing.
if (!/stage\.addEventListener\(\s*'pointerdown'/.test(previewSource)) {
  panProblems.push('the stage does not bind `pointerdown`, so there is no pan gesture at all')
}
if (!/stage\.addEventListener\(\s*'pointermove'/.test(previewSource)) {
  panProblems.push('`pointermove` is not bound to the stage — the press can never become a pan')
}
if (!/stage\.addEventListener\(\s*'pointerup'/.test(previewSource)) {
  panProblems.push('`pointerup` is not bound to the stage — the gesture would never end')
}
if (!/stage\.addEventListener\(\s*'pointercancel'/.test(previewSource)) {
  panProblems.push('`pointercancel` is not bound — a cancelled gesture leaves `data-dragging` stuck')
}
if (!/setPointerCapture\(/.test(previewSource)) {
  panProblems.push('no `setPointerCapture` — a pan that leaves the stage stops receiving moves')
}
if (!/pointerType\s*===\s*'touch'/.test(previewSource)) {
  panProblems.push('touch is not handed to the browser (pointerType gate missing) — capturing it fights native momentum panning')
}
if (!/button\s*!==\s*0/.test(previewSource)) {
  panProblems.push('the pan does not gate on the primary button — middle/right drags would move the photo')
}
for (const axis of ['scrollLeft', 'scrollTop']) {
  if (!new RegExp(`stage\\.${axis}\\s*=`).test(previewSource)) {
    panProblems.push(`the pan never writes \`stage.${axis}\`, so it moves nothing`)
  }
}
// The trap: `closePreview` is bound to the OVERLAY, and a pointer released
// outside the stage still resolves its click to that overlay. Without the
// suppressor every pan ends by closing the preview — the fix would look like a
// new bug. Capture phase on the dialog, because the click has to be stopped
// before it reaches the overlay's own handler.
if (!/dialog\.addEventListener\(\s*'click',\s*onClickCapture,\s*true\s*\)/.test(previewSource)) {
  panProblems.push('no capture-phase click suppressor on the dialog — the click that ends a pan would bubble to `closePreview` and close the preview')
}
if (panProblems.length > 0) {
  console.error('\nFAIL: a zoomed photo in the preview cannot be dragged (issue #31).')
  for (const entry of panProblems) console.error(`  - ${entry}`)
  console.error('`overflow: auto` is not a pan gesture. At 200% most of the image sits')
  console.error('outside the viewport, and the margin scrollbar is not an affordance.')
  console.error('Pan by moving `scrollLeft`/`scrollTop` against the pointer, and')
  console.error('swallow exactly one click per drag — the overlay underneath closes')
  console.error('the preview on click.')
  process.exit(1)
}
// The cursor is a computed value in the real cascade, so it is measured rather
// than grepped: `grab` has to win on the stage and lose to `grabbing` only
// while a drag is in progress.
const cursorStates = JSON.parse(await lightboxSession.evaluate(`(() => {
  const stage = document.querySelector('[data-preview-stage]')
  const out = { rest: getComputedStyle(stage).cursor }
  stage.setAttribute('data-dragging', '')
  out.dragging = getComputedStyle(stage).cursor
  stage.removeAttribute('data-dragging')
  out.restored = getComputedStyle(stage).cursor
  return JSON.stringify(out)
})()`))
const cursorBad = [
  ['rest', cursorStates.rest, 'grab'],
  ['dragging', cursorStates.dragging, 'grabbing'],
  ['restored', cursorStates.restored, 'grab'],
].filter(([, actual, want]) => actual !== want)
if (cursorBad.length > 0) {
  console.error('\nFAIL: the preview stage does not advertise that it can be dragged (issue #31).')
  for (const [state, actual, want] of cursorBad) console.error(`  ${state}: cursor is ${actual}, expected ${want}`)
  console.error('A pannable surface with a text cursor reads as "this does not move",')
  console.error('which is how the reporter concluded there was no gesture to find.')
  process.exit(1)
}
console.log(`preview pan: stage cursor ${cursorStates.rest} → ${cursorStates.dragging} while dragging`)

// --- a notch anywhere in the overlay stays in the overlay ------------------
// The string checks above prove the listener EXISTS; this proves it works.
// Issue #22's fourth bullet ("在预览层内操作时，不应同时带动底层工作台滚动") is about
// the whole overlay, not just the stage: the toolbar, the caption and the
// margin around the figure sit on the same fixed surface, and a notch landing
// there used to scroll the workbench underneath. Measured with real wheel
// events at real coordinates, because this is precisely the class of bug that
// source reading gets wrong — the stage had `overscroll-behavior: contain` and
// still leaked, since the leak was never in the stage.
// Whether the fixture reproduces the overlay listener is decided by the SOURCE,
// not by this file. That is the whole point of the measurement: if the panel
// stops binding `wheel` to the dialog, the fixture stops containing the wheel
// and the notch below reaches the page — which is the defect. Writing the
// listener into the fixture unconditionally would make the check green no
// matter what the panel does, and a negative case proved exactly that.
const overlayBindsWheel = previewSource.includes("dialog?.addEventListener('wheel', containWheel")
const wheelProbe = await lightboxSession.evaluate(`(() => {
  const overlay = document.querySelector('[data-preview-overlay]')
  if (${overlayBindsWheel}) {
    // The stage handler only acts on Ctrl/⌘; a plain notch must scroll the
    // stage, so it deliberately does NOT preventDefault. What stops a plain
    // notch from leaving the stage is the stage's own overflow, not a handler.
    overlay.addEventListener('wheel', (event) => { event.preventDefault() }, { passive: false })
  }
  return ${overlayBindsWheel}
})()`)
// Coordinates: one inside the stage, one on the toolbar BELOW the stage.
const wheelBoxes = await lightboxSession.evaluate(`(() => {
  const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
  return JSON.stringify({ stage: rect('[data-preview-stage]'), toolbar: rect('.lightboxTools'), margin: { x: 6, y: 6 } })
})()`)
const boxes = JSON.parse(wheelBoxes)
async function notch (x, y) {
  await lightboxSession.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await lightboxSession.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 240 })
  await new Promise(r => setTimeout(r, 120))
}
const scrollState = async () => JSON.parse(await lightboxSession.evaluate(
  `JSON.stringify({ page: Math.round(window.scrollY), stage: Math.round(document.querySelector('[data-preview-stage]').scrollTop) })`))
const leaks = []
for (const [label, point] of Object.entries(boxes)) {
  await lightboxSession.evaluate(`window.scrollTo(0,0); document.querySelector('[data-preview-stage]').scrollTop = 0`)
  await new Promise(r => setTimeout(r, 80))
  await notch(point.x, point.y)
  const after = await scrollState()
  if (after.page > 0) leaks.push(`${label} (${point.x},${point.y}) scrolled the workbench ${after.page}px`)
}
if (leaks.length > 0) {
  console.error('\nFAIL: a wheel notch inside the preview scrolls the workbench behind it (issue #22).')
  for (const entry of leaks) console.error(`  - ${entry}`)
  console.error('`overscroll-behavior: contain` only contains the element it is set on.')
  console.error('The overlay is fixed over a scrollable page, so it needs its own')
  console.error('non-passive wheel listener; the stage alone is not the preview.')
  process.exit(1)
}
console.log(`preview overlay: a notch at ${Object.keys(boxes).length} points (stage, toolbar, margin) never moved the page`)

// --- the canvas node has to sit ON the canvas, not IN it -------------------
// Issue #23: with a dark theme, a text node and a config node read as the same
// grey as the grid behind them. `.root` and `.node` both painted
// `--dsw-alias-bg-layer-1`, so the two surfaces were not merely similar — they
// were the same value, and `.gridScrim` laid another 60% of that same colour on
// top for good measure.
//
// The light theme was never broken and must not be "fixed". DSH resolves all
// three layers to #ffffff on `body`, so a white card on a white canvas is what
// the light theme looked like before the issue and what it has to look like
// after it. The first attempt mixed 12% of `--dsw-alias-label-primary` (near
// black in light) into the fill and dimmed a palette that had no defect —
// which is exactly what a guard measuring only the dark theme cannot catch.
// Both palettes are therefore measured here, and the light one is compared
// against the tokens the canvas shipped with rather than merely "not equal".
function ruleBlock (css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) return null
  const end = css.indexOf('\n}', start)
  return end < 0 ? null : css.slice(start, end)
}
const canvasRootBlock = ruleBlock(canvasCss, '.root')
const nodeBlock = ruleBlock(canvasCss, '.node')
const selectedBlock = ruleBlock(canvasCss, '.nodeSelected')
const backgroundOf = block => (block === null ? null : (/background:\s*([^;]+);/.exec(block)?.[1].trim() ?? null))
const borderOf = block => (block === null ? null : (/border:\s*[^;]*?\bsolid\s+([^;]+);/.exec(block)?.[1].trim() ?? null))
const canvasFill = backgroundOf(canvasRootBlock)
const nodeFill = backgroundOf(nodeBlock)
const nodeBorder = borderOf(nodeBlock)
const selectedBorder = selectedBlock === null ? null : (/border-color:\s*([^;]+);/.exec(selectedBlock)?.[1].trim() ?? null)
const nodeProblems = []
if (canvasFill === null || nodeFill === null) {
  nodeProblems.push('could not read `background` from `.root` or `.node` — the check below needs both')
} else if (nodeFill === canvasFill) {
  nodeProblems.push(`\`.node\` and \`.root\` both paint ${canvasFill}, so a node has no fill of its own`)
}
if (nodeBorder !== null && nodeBorder === canvasFill) {
  nodeProblems.push(`\`.node\`'s border is the canvas fill (${nodeBorder})`)
}
// react-flow 在三个开关全 false 时给 wrapper 设 pointer-events:none 且可继承；
// 外壳不恢复 auto，真指针就落不到卡片本体（拖拽死掉，jsdom dispatch 测不出）。
if (nodeBlock === null || !/pointer-events:\s*auto;/.test(nodeBlock)) {
  nodeProblems.push('`.node` must restore pointer-events:auto or real pointers never reach the card body (drag dead)')
}
// The resting values are variables now, so the literal string comparison above
// can no longer see them. The two assignments are the whole light-theme
// contract: `--canvas-node-surface` MUST be the canvas token and
// `--canvas-node-border` MUST be the resting border the cards shipped with.
const rootVars = canvasRootBlock === null ? new Map() : new Map(
  [...canvasRootBlock.matchAll(/(--[a-z-]+):\s*([^;\n]+);/g)].map(m => [m[1], m[2].trim()]))
if (rootVars.get('--canvas-node-surface') !== 'var(--dsw-alias-bg-layer-1)') {
  nodeProblems.push(`\`--canvas-node-surface\` is ${String(rootVars.get('--canvas-node-surface'))}, not the canvas token \`var(--dsw-alias-bg-layer-1)\` — the LIGHT theme has to keep its original white card`)
}
if (rootVars.get('--canvas-node-border') !== 'var(--dsw-alias-border-l1)') {
  nodeProblems.push(`\`--canvas-node-border\` is ${String(rootVars.get('--canvas-node-border'))}, not \`var(--dsw-alias-border-l1)\` — the LIGHT theme's resting ring has to stay what it shipped with`)
}
if (!/:global\(body\[data-ds-dark-theme\]\) \.root\s*\{[\s\S]{0,400}?--canvas-node-surface:/.test(canvasCss)) {
  nodeProblems.push('no `body[data-ds-dark-theme] .root { --canvas-node-surface }` override — the dark card would be the canvas colour again')
}
if (selectedBorder === null) {
  nodeProblems.push('`.nodeSelected` no longer sets its own border-color, so selection cannot read above the default')
} else if (nodeBorder !== null && selectedBorder === nodeBorder) {
  nodeProblems.push('`.nodeSelected` paints the same border as the resting node, so selecting one changes nothing')
}
if (nodeProblems.length > 0) {
  console.error('\nFAIL: a canvas node cannot be told apart from the canvas (issue #23).')
  for (const entry of nodeProblems) console.error(`  - ${entry}`)
  console.error('A dark card and the canvas it floats on must be two surfaces, and the light')
  console.error('theme must keep the one it had. Split the value at `.root` — the light theme')
  console.error('keeps `bg-layer-1` exactly, and `body[data-ds-dark-theme] .root` overrides it.')
  process.exit(1)
}

// The measurement, in both palettes, using the values DSH actually ships
// (dsh-client-ui-theme: all three layers are #ffffff on `body`; on
// `body[data-ds-dark-theme]` they are bluish-875 / -850 / -800).
const CANVAS_PALETTES = [
  {
    name: 'light',
    bodyAttr: '',
    tokens: `--dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-border-l1: #0000000a;
  --dsw-alias-border-l2: #0000001a;
  --dsw-alias-label-primary: #0f1115;`,
    // In light the card and the canvas ARE the same white. Nothing has to differ
    // here, so the only requirement is that it still is that white.
    expectStep: false,
  },
  {
    name: 'dark',
    bodyAttr: ' data-ds-dark-theme=""',
    tokens: `--dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-layer-3: #353638;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-label-primary: #f9fafb;`,
    expectStep: true,
  },
]
const canvasPaletteTokens = [...new Set(canvasCss.match(/var\(--dsw-[a-z0-9-]+\)/g) ?? [])]
  .map(token => `${token.slice(4, -1)}: #8a8a8a`).join('; ')
const canvasPage = palette => `<!doctype html><html><head><style>
:root { ${canvasPaletteTokens}; }
body { ${palette.tokens} }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
${browserCss(canvasCss)}
</style></head><body${palette.bodyAttr}>
<div class="root" id="probeRoot" style="height:320px">
  <div class="viewport" id="probeViewport">
    <div class="node" id="probeNode" style="left:40px;top:40px;width:200px;height:120px"></div>
  </div>
</div>
</body></html>`
// Reusing the session keeps one browser per run; the lightbox measurements
// above are already collected, so replacing the document now costs nothing.
for (const palette of CANVAS_PALETTES) {
await lightboxSession.send('Page.setDocumentContent', {
  frameId: (await lightboxSession.send('Page.getFrameTree')).result.frameTree.frame.id,
  html: canvasPage(palette),
})
await new Promise(r => setTimeout(r, 300))
const canvasMeasured = JSON.parse(await lightboxSession.evaluate(`(() => {
  ${WCAG_CONTRAST_SOURCE}
  const root = document.getElementById('probeRoot')
  const node = document.getElementById('probeNode')
  // The page behind the canvas: composite the .root fill onto it before any
  // ratio means anything (the root fill is opaque here, but the light theme's
  // white-on-white only reads as 1.00:1 when it is compared against the real
  // backdrop rather than against itself).
  const pageBackground = composite(parseColour(getComputedStyle(document.body).backgroundColor),
    { r:255,g:255,b:255,a:1 })
  const canvasSurface = composite(parseColour(getComputedStyle(root).backgroundColor), pageBackground)
  const cs = getComputedStyle(node)
  const fill = composite(parseColour(cs.backgroundColor), canvasSurface)
  const edge = composite(parseColour(cs.borderTopColor), canvasSurface)
  return JSON.stringify({
    page: [Math.round(pageBackground.r), Math.round(pageBackground.g), Math.round(pageBackground.b)],
    canvas: [Math.round(canvasSurface.r), Math.round(canvasSurface.g), Math.round(canvasSurface.b)],
    fillColor: [Math.round(fill.r), Math.round(fill.g), Math.round(fill.b)],
    fill: Math.round(contrastRatio(fill, canvasSurface) * 100) / 100,
    edge: Math.round(contrastRatio(edge, canvasSurface) * 100) / 100,
  })
})()`))
// A large flat area reads at a much lower ratio than a line of text does, so the
// fill bar is 1.25 while the thin border keeps the 3:1 that 1.4.11 asks of a
// component boundary. Either alone is enough — the issue's own wording is
// "清楚的明暗层次" OR "提高卡片边框的可辨识度", not both.
const canvasStep = canvasMeasured.fill >= 1.25 || canvasMeasured.edge >= 3
console.log(`canvas node in a ${palette.name.toUpperCase()} theme: canvas rgb(${canvasMeasured.canvas.join(',')}), node rgb(${canvasMeasured.fillColor.join(',')}), fill ${canvasMeasured.fill}:1, border ${canvasMeasured.edge}:1`)
if (palette.expectStep && !canvasStep) {
  console.error('\nFAIL: a resting canvas node is still invisible in a dark theme (issue #23).')
  console.error(`  its fill differs from the canvas by ${canvasMeasured.fill}:1 (needs 1.25) and its`)
  console.error(`  border by ${canvasMeasured.edge}:1 (needs 3). Measured with the token values the`)
  console.error('  installed DSH ships; the palette-independent requirement is checked above.')
  process.exit(1)
}
if (!palette.expectStep && canvasMeasured.fill !== 1) {
  console.error('\nFAIL: the LIGHT theme\'s canvas was changed while fixing a dark-theme defect.')
  console.error('  DSH resolves `--dsw-alias-bg-layer-1` and `--dsw-alias-bg-layer-3` to the SAME')
  console.error('  #ffffff in light, so the card measured 1.00:1 there before the issue and must')
  console.error(`  still measure 1.00:1 after it — this run measured ${canvasMeasured.fill}:1.`)
  console.error('  A card dimmed in a palette that had no complaint is a regression, not a fix:')
  console.error('  split the value at `.root` instead of mixing one value for both themes.')
  process.exit(1)
}
}

lightboxSession.close()

ws7.close()
ws6.close()
ws4.close()
ws3.close()
ws2.close()
ws5.close()
ws.close(); launched.close(); server.close()
rmSync(themeModuleDir, { recursive: true, force: true })
rmSync(navModuleDir, { recursive: true, force: true })
console.log('\nUI CONTRACTS VERIFIED')

/**
 * 画布源码的整洁守门：不留「孤儿注释」，不堆连续空行。
 *
 * WHY 需要这一条：`CanvasWorkspace.tsx` 一次重构里搬走了十几个函数，但每次只
 * 删了函数体，把它的 JSDoc 留在了原地。结果是一段 10 行注释在讲一个叫
 * `toolLabel` 的函数，而那个函数在**全仓库**里已经一次都不出现；接着是 22 行
 * 空行。这类东西 tsc 不会报、测试不会红、代码照样跑，只有人翻开文件才发现——
 * 而它恰恰是让人不敢动这个大文件的原因之一。
 *
 * 两条判据各自独立：
 *
 *  1. **孤儿 JSDoc**：一段 `/** … *\/` 之后，第一个非空行如果是文件末尾、一个
 *     闭合花括号，或另一段注释的开头，那么这段注释没有可以描述的代码。
 *  2. **连续空行**：3 行及以上连续空行。删除留下的洞正是这样长出来的。
 *
 * 检测器自己先跑一遍自检（一段人造的孤儿注释必须被报出来，一段正常的必须不被
 * 报），否则一个恒返回空列表的检测器会让这条守门永远绿——那是最糟的一种守门。
 *
 * Run: node scripts/verify-canvas-source-clean.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canvasSourceFiles } from './lib/canvas-source.mjs'

/**
 * 这段注释是不是**文件头**注释。
 *
 * 文件头的写法是「先总述这个文件是什么，再各写各的」：先是几段没有挂靠对象的
 * 页首说明，接着才是常量/函数的注释。两者之间是并列关系，不是「删了代码」。
 * 判据放宽到「第一段不描述具体标识符」——它通常讲整个模块，而不是某个函数。
 *
 * 排除只做这一件事，是为了不让一条整洁规则逼着人给文件头找一个假主体挂上去。
 * @param {readonly string[]} lines - 源文件按行拆开。
 * @param {number} start - 这段注释起始行（0-based）。
 */
function isFileHeader (lines, start) {
  // 文件头要么就是文件的第一段注释，要么前面只有**别的文件头**（罕见，一个模块
  // 先讲归属再讲用途）。判据必须比「前面全是注释」更严：文件开头连着两段孤儿
  // 注释同样满足那个宽判据，那正是这个守门要抓的东西，不能顺手放过。
  for (let index = start - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    return false
  }
  return true
}

/**
 * 找出一段 JSDoc 之后没有代码的情况。
 * @param {string} text - 源文件全文。
 * @returns {Array<{ line: number, summary: string }>} 每处孤儿注释的起始行（1-based）。
 */
export function findOrphanDocComments (text) {
  const lines = text.split('\n')
  const found = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trimStart().startsWith('/**')) { index += 1; continue }
    // 块注释的结束：第一行含 `*/` 的（单行注释块），或后续某行含 `*/`。
    let end = index
    while (end < lines.length && !lines[end].includes('*/')) end += 1
    if (end >= lines.length) break
    // 找块后第一个非空行
    let next = end + 1
    while (next < lines.length && lines[next].trim() === '') next += 1
    const following = next >= lines.length ? '' : lines[next].trim()
    // 后面是文件末尾、闭合括号，或者**另一段只有注释的块**（连续两段孤儿
    // 注释时，前一段的「下一个非空行」正是后一段的 `/**`）——这四种都说明
    // 这段 JSDoc 没有可以描述的代码。
    const orphan = following === ''
      || following.startsWith('}')
      || following.startsWith(')')
      || (following.startsWith('/**') && !isFileHeader(lines, index))
    if (orphan) {
      found.push({ line: index + 1, summary: lines[index + 1]?.trim().slice(0, 70) ?? '' })
    }
    index = end + 1
  }
  return found
}

/**
 * 连续空行（3 行及以上）的位置。2 行空行是正常的段落间隔，不报。
 * @param {string} text - 源文件全文。
 * @returns {Array<{ line: number, count: number }>}
 */
export function findBlankRuns (text) {
  const lines = text.split('\n')
  const found = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].trim() !== '') { index += 1; continue }
    let end = index
    while (end < lines.length && lines[end].trim() === '') end += 1
    if (end - index >= 3) found.push({ line: index + 1, count: end - index })
    index = end
  }
  return found
}

// ------------------------------------------------------------------ 自检
// 检测器必须能分辨。人造两段：一段是孤儿，一段正常挂着代码。任一处判错就退出，
// 因为一个判不准的守门比没有守门更危险——它给出的是虚假的安心。
const SELF_ORPHAN = '/**\n * 这段注释描述的代码已经被删掉了。\n */\n}\n'
const SELF_OK = '/**\n * 这段注释正常挂着下面的函数。\n */\nconst fn = () => 1\n'
if (findOrphanDocComments(SELF_OK).length !== 0) {
  console.error('SELF-CHECK FAILED: 正常的 JSDoc 被误报为孤儿')
  process.exit(1)
}
if (findOrphanDocComments(SELF_ORPHAN).length !== 1) {
  console.error('SELF-CHECK FAILED: 孤儿 JSDoc 没有被报出来，检测器分辨不了')
  process.exit(1)
}
// 三行空行才算：'a\n\n\n\nb' 是 a 后面 3 个空行（split 后 3 个空串）。
// 连续两段孤儿注释必须都被报出来；只报后一段说明前一段被「下一行是 /**」漏掉了。
// 放在一行代码**之后**：文件最开头那段无法与「文件头注释」区分，那是刻意放过的，
// 拿它当样例测的是歧义而不是检测器。
const SELF_TWO_ORPHANS = 'const x = 1\n/**\n * 第一段\n */\n/**\n * 第二段\n */\n}\n'
if (findOrphanDocComments(SELF_TWO_ORPHANS).length !== 2) {
  console.error('SELF-CHECK FAILED: 连续的孤儿 JSDoc 有漏报（只抓到后面那段）')
  process.exit(1)
}
if (findBlankRuns('a\n\n\n\nb\n').length !== 1 || findBlankRuns('a\n\nb\n').length !== 0) {
  console.error('SELF-CHECK FAILED: 连续空行的判定边界不对')
  process.exit(1)
}

// ------------------------------------------------------------------ 真文件
// 清单是相对于 `src/client/` 的，不是仓库根。
const roots = canvasSourceFiles().map(file =>
  file.startsWith('/') ? file : fileURLToPath(new URL(`../src/client/${file}`, import.meta.url)))
const problems = []
for (const file of roots) {
  const text = readFileSync(file, 'utf8')
  const rel = file.slice(file.indexOf('/src/') + 1)
  for (const orphan of findOrphanDocComments(text)) {
    problems.push(`${rel}:${orphan.line} 孤儿注释（后面没有任何代码）：${orphan.summary}`)
  }
  for (const run of findBlankRuns(text)) {
    problems.push(`${rel}:${run.line} 连续 ${run.count} 行空行`)
  }
}

if (problems.length > 0) {
  console.error(`\nFAIL: 画布源码里有 ${problems.length} 处遗留`)
  for (const line of problems) console.error(`  - ${line}`)
  console.error('\n孤儿注释是「删了函数、忘了删说明」的签名；连续空行是它留下的洞。')
  process.exit(1)
}
console.log(`canvas source clean: ${roots.length} files, no orphan doc comments, no blank runs`)

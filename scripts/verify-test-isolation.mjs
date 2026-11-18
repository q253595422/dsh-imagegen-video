/**
 * 守门：会真的写画布的脚本，必须先把数据目录指到临时目录。
 *
 * WHY 需要这一条：`~/.dsh/dsh-imagegen/canvas/` 是用户的真实数据目录，
 * 而它和测试用的目录**只差一个环境变量**——`image-storage-path.ts` 里写的是
 * `$DSH_HOME/dsh-imagegen`，不设 `DSH_HOME` 就等于指到家目录。一个脚本只要
 * 调了 `canvas/create` 或者直接用了 `canvasStore`，跑一次就在用户的下拉里多
 * 一条；跑一整个 `pnpm test` 就是十几条。2026-10-13 到 10-15 那三天这样攒下
 * 了 1408 条 `gone`/`deck`/`extract`/`polish`/`files`，用户的画布下拉从可用
 * 变成了 1425 条滚不完的列表。
 *
 * 那次是给 `smoke.mjs` 单独补的 `DSH_HOME`（c10cf07），但补的是**一个脚本**，
 * 不是一条规则：下一个写测试的人照样会踩进去，而且踩了以后 tsc 不报、测试不
 * 红——只有用户打开下拉才发现。
 *
 * ── 判据：看的不是「有没有赋值」，是「赋值成了什么」 ──
 *
 * 反向验证在这条上连挂三次，每次都是同一类错——只看赋值这个**动作**：
 *
 *   1. `// process.env.DSH_HOME = mkdtempSync(...)`（注释掉）算隔离；
 *   2. `process.env.DSH_HOME = '/custom/dsh'`（测别的东西的字面量）算隔离；
 *   3. `process.env.DSH_HOME = previousDshHome`（恢复原值）算隔离。
 *
 * 所以这里把每条未注释的赋值按右值分类，只有**运行时创建目录**的那种才算隔离
 * 证据。三种写法各自对应一类：
 *
 *   - `mkdtempSync(...)` / `mkdtemp(...)` —— 真隔离 ✅
 *   - `'...'` / `"..."` —— 固定路径，不是临时目录 ❌
 *   - 标识符（`previousDshHome`、`root`）—— 恢复原值或间接来源，不算证据 ❌
 *
 * 第三种刻意判成不算：`root` 可能是临时目录、也可能是字面量，静态看不出。
 * 宁可让一个用变量的脚本多写一行注释说明，也不让「恢复原值」蒙混过关——
 * 后者正是假绿出现过的地方。
 *
 * 检测器自己先跑自检，三条样例的判定都必须对。判不准的守门比没有守门更糟。
 *
 * Run: node scripts/verify-test-isolation.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 会往用户真实数据目录里写条目的动作。读操作（`canvas/list`、`canvasStore.list(`）
 *  不算：只读不会多出条目。
 *
 *  画布只是其中一类。`~/.dsh/dsh-imagegen/` 下还有三个库会被脚本写：图片历史
 *  (`appendHistory`)、视频历史 (`appendVideoHistory`)、画廊 (`appendGallery`)。
 *  2026-11-18 用户报「删不掉」的根因就是这个守门只管画布：`smoke-stage-encode`
 *  真的调 `stageEncodeSession()`，而它在编码成功后写视频历史，脚本却没设
 *  `DSH_HOME`，于是每跑一次 `pnpm test` 就往真实库里追加一条同 id 的测试片。
 *  守门看不见视频库，这个脚本就一直绿。 */
const WRITE_MARKERS = [
  /\/canvas\/create/,
  /\bcanvasStore\.(create|save|remove|importDocument)\s*\(/,
  // 视频历史：直接调 store，或调会内部写它的编码入口。
  /\bappendVideoHistory\s*\(/,
  /\bstageEncodeSession\s*\(/,
  /\/video\/history\/remove\b/,
  // 图片历史与画廊。
  /\bappendHistory\s*\(/,
  /\bappendGallery\s*\(/,
]

/** 把注释换成空格，保留行号。字符串里的 `//` 会被误伤，但脚本里的 URL 是
 *  `https://`，剥掉后半行不影响任何判据（下面几条正则都不看行尾）。 */
export function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 这个脚本会写画布吗。
 * @param {string} text - 脚本全文。
 */
export function writesCanvas (text) {
  const code = stripComments(text)
  return WRITE_MARKERS.some(marker => marker.test(code))
}

/**
 * 找出把数据目录指到临时目录的证据。
 *
 * 认三种写法，右值都必须**trace 到** `mkdtempSync(...)` / `mkdtemp(...)`：
 *
 *   1. `process.env.DSH_HOME = mkdtempSync(...)`        —— 直接
 *   2. `const home = mkdtempSync(...)` + `DSH_HOME = home` —— 存中间变量
 *   3. `setImageDataRoot(mkdtempSync(...))`              —— 走 setter
 *
 * 都要追一层变量：`smoke-canvas-agent.mjs` / `-proposal-routes.mjs` 用的正是
 * 第 2 种，只认字面 `mkdtempSync` 会把它们误报成没隔离（第一次跑就报了）。
 *
 * @param {string} text - 脚本全文。
 * @returns {string[]} 命中行（去掉首尾空白），空数组表示没找到隔离证据。
 */
export function isolationEvidence (text) {
  const code = stripComments(text)
  // 先收集「哪个变量被赋成了 mkdtemp 的结果」。
  const tempVars = new Set()
  for (const rawLine of code.split('\n')) {
    const decl = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*mkdtemp(Sync)?\s*\(/.exec(rawLine)
    if (decl !== null) tempVars.add(decl[1])
  }

  const hits = []
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const assign = /^process\.env\.DSH_HOME\s*=\s*(.+?)\s*;?$/.exec(line)
    if (assign !== null) {
      const value = assign[1]
      if (/^mkdtemp(Sync)?\s*\(/.test(value)) { hits.push(line); continue }
      // 右值是上面那个临时变量（允许 `home + '/x'` 这类拼接）。
      const ident = /^([A-Za-z_$][\w$]*)\b/.exec(value)
      if (ident !== null && tempVars.has(ident[1])) hits.push(line)
      continue
    }
    if (/\bsetImageDataRoot\s*\(\s*mkdtemp(Sync)?\s*\(/.test(line)) hits.push(line)
  }
  return hits
}

// ------------------------------------------------------------------ 自检
const SELF_WRITES = "await post('/api/dsh-imagegen/canvas/create', { title: 'x' })\n"
const SELF_READONLY = "const list = await post('/api/dsh-imagegen/canvas/list')\n"
const SELF_WRITES_COMMENTED = "// await post('/api/dsh-imagegen/canvas/create')\n"
const SELF_TEMP = "process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'x-'))\n"
const SELF_LITERAL = "process.env.DSH_HOME = '/custom/dsh'\n"
const SELF_RESTORE = "process.env.DSH_HOME = previousDshHome\n"
const SELF_COMMENTED_TEMP = "// process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'x-'))\n"
const SELF_ROOT_TEMP = "setImageDataRoot(mkdtempSync(join(tmpdir(), 'x-')))\n"

const selfChecks = [
  ['会写画布的脚本没被认出来', writesCanvas(SELF_WRITES)],
  ['只读脚本被误判成会写', writesCanvas(SELF_READONLY) === false],
  ['注释掉的写动作被当成真的', writesCanvas(SELF_WRITES_COMMENTED) === false],
  ['mkdtempSync 的赋值没被认成隔离', isolationEvidence(SELF_TEMP).length === 1],
  ['setImageDataRoot(mkdtempSync) 没被认成隔离', isolationEvidence(SELF_ROOT_TEMP).length === 1],
  ['字符串字面量被误认成隔离（反向验证第一坑）', isolationEvidence(SELF_LITERAL).length === 0],
  ['恢复原值被误认成隔离（反向验证第二坑）', isolationEvidence(SELF_RESTORE).length === 0],
  ['注释掉的隔离被误认（反向验证第三坑）', isolationEvidence(SELF_COMMENTED_TEMP).length === 0],
]
for (const [what, passed] of selfChecks) {
  if (!passed) {
    console.error(`SELF-CHECK FAILED: ${what}`)
    process.exit(1)
  }
}

// ------------------------------------------------------------------ 真文件
const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url))
const offenders = []
let scanned = 0
let writers = 0

for (const name of readdirSync(scriptsDir)) {
  if (!name.endsWith('.mjs')) continue
  // 本文件的自检样例里带着 `canvas/create` 和 `setImageDataRoot(mkdtempSync(...))`
  // 这些字面，不排除就会把自己当成写盘者，还给自己判「已隔离」——一条永远
  // 不会红的自我豁免。守门脚本不是被测对象。
  if (name === 'verify-test-isolation.mjs') continue
  const text = readFileSync(path.join(scriptsDir, name), 'utf8')
  scanned += 1
  if (!writesCanvas(text)) continue
  writers += 1
  if (isolationEvidence(text).length === 0) offenders.push(`scripts/${name}`)
}

if (offenders.length > 0) {
  console.error(`\nFAIL: ${offenders.length} 个脚本会写用户数据，却没有把数据目录指到临时目录`)
  for (const file of offenders) console.error(`  - ${file}`)
  console.error('\n这些脚本跑一次，就会在用户真实的画布 / 历史 / 视频库里多出条目。')
  console.error('在脚本最前面（任何 import 之前）加一行：')
  console.error("  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-<name>-'))")
  process.exit(1)
}

console.log(
  `test isolation ok: ${scanned} scripts scanned, ${writers} data writers all point at a temp data root`,
)

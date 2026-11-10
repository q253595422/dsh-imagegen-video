/**
 * 画布源码的「全量文本」：把 CanvasWorkspace.tsx 与它拆出去的模块拼起来。
 *
 * WHY 需要这个：好几条不变式断言的是**源码文本**而不是运行时行为
 * （jsdom 模拟不了 pointerdown 的默认行为、没有 top layer、没有真实布局）。
 * 这类断言的写法一直是「读 CanvasWorkspace.tsx 全文再跑正则」。
 *
 * 一旦把某个函数或组件从那个文件搬到 canvas/ 下，正则就悄悄失配了——
 * 而失配的结果不是报错，是 `assert.match` 失败或者更糟：`match(...)?.length`
 * 变成 0 而断言本身不严谨时直接放过。等于重构一次就悄悄撤掉一层安全网。
 *
 * 所以扫描一律走这里：它把主文件与 canvas/ 下的所有模块拼成一份文本。
 * 断言看到的是「这些代码还在仓库里」，而不是「这些代码还恰好在第 47 行」。
 * 搬迁因此不再需要同步改测试，也就不会漏改。
 *
 * 注意：拼接**只**用于「某段代码是否存在」这类断言。要断言「它不在主文件里」
 * 或者「它在某个特定模块里」，用 readModuleSource 单独读那个文件。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLIENT_DIR = dirname(fileURLToPath(new URL('../../src/client/CanvasWorkspace.tsx', import.meta.url)))
const CANVAS_DIR = join(CLIENT_DIR, 'canvas')

/**
 * 按固定顺序读一个文件；不存在就当作空串，让调用方的断言自己报错。
 *
 * 换行统一成 `\n`：这些文本最终都喂给跨行正则，而正则里写的是 `\n`。
 * Windows 检出是 CRLF，不在这里统一的话，每一条断言都要自己记得写 `\r?`。
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

/**
 * 画布相关的全部源码，用换行拼在一起。
 *
 * 顺序是：主文件在前，canvas/ 下的模块按文件名排序在后。顺序对正则断言不影响，
 * 但固定下来能让失败信息可复现。文件之间插分隔注释，避免两段代码被拼成一行
 * 而产生一个本来不存在的匹配。
 */
export function canvasSourceText() {
  const parts = []
  for (const relative of canvasSourceFiles()) {
    parts.push(`\n// ---- src/client/${relative} ----\n`)
    parts.push(readIfPresent(join(CLIENT_DIR, relative)))
  }
  return parts.join('\n')
}

/**
 * 画布相关的源文件清单，相对于 `src/client/`，主文件在前。
 *
 * 递归：`canvas/` 下现在只有一层，但组件本体再拆下去就会出现子目录。一个
 * 只认一层的扫描会在那次拆分里悄悄少读几个文件——而少了文件的表现是断言
 * 匹配不上，看起来和「代码被删了」一模一样。
 *
 * 导出这份清单是为了让反向验证的 `patch()` 也能按「画布源码组」定位锚点
 * 而不是钉死在某一个文件上。两处必须用同一份清单，否则「读得到」与
 * 「改得到」的范围会不一致。
 */
export function canvasSourceFiles() {
  let names = []
  try {
    // `recursive` 是 Node 内置的（20.1 起稳定；engines 与 CI 都在 20 以上）。
    // 它**不**保证顺序：内部只是把每一层 `readdir` 的结果拼起来，顺序来自
    // 文件系统本身（ext4 上取决于目录 hash，同一份代码在两台机器上可能不同）。
    // 所以显式 sort，保证 `canvasSourceText()` 的拼接顺序、以及反向验证
    // `locate()` 的命中顺序在不同机器上一致。
    names = readdirSync(CANVAS_DIR, { recursive: true, encoding: 'utf8' }).sort()
  } catch {
    // 目录还不存在（拆分刚开始时）：只扫主文件，行为与改造前一致。
    return ['CanvasWorkspace.tsx']
  }
  // 内置递归只返回路径，不区分文件与目录；用扩展名筛出源文件即可，因为
  // 这里还叫 ts/tsx 的条目必定是文件。分隔符统一成 `/`：Windows 上返回的是
  // 反斜杠，而这份清单同时被当作 `src/client/` 下的相对路径来拼。
  return [
    'CanvasWorkspace.tsx',
    ...names.filter(name => /\.(ts|tsx)$/.test(name)).map(name => `canvas/${name.replaceAll('\\', '/')}`),
  ]
}

/**
 * 单独读一个画布相关模块的源码，用于「这段代码必须在这一处」的断言。
 *
 * @param path - 相对于 `src/client/` 的路径，例如 `CanvasWorkspace.tsx`
 *   或 `canvas/geometry.ts`。
 */
export function readModuleSource(path) {
  return readIfPresent(join(CLIENT_DIR, path))
}

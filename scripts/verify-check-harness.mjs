// 共享 check 执行器的语义验收。跑法：node scripts/verify-check-harness.mjs
//
// 这几条覆盖的正是旧副本出错的地方：超时被当成结论。每条都单独一个 results
// 数组，避免互相污染；退出码按「有没有真的失败」判断。
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

const cases = []
const case_ = (name, fn) => cases.push([name, fn])

/** 跑一个 check，返回 { line, exitCode }，并复原 process.exitCode。 */
async function run (fn, timeoutMs, options = {}) {
  const results = []
  const check = createCheckHarness({ results, ...options })
  const before = process.exitCode
  process.exitCode = undefined
  // stderr 的进度行在验收里没有用，静音掉以免干扰输出。
  const write = process.stderr.write
  process.stderr.write = () => true
  try {
    await check('probe', fn, timeoutMs)
  } finally {
    process.stderr.write = write
  }
  const exitCode = process.exitCode
  process.exitCode = before
  return { line: results[0] ?? '(no verdict)', exitCode }
}

case_('a fast pass is a PASS and does not move the exit code', async () => {
  const { line, exitCode } = await run(async () => {}, 1000)
  assert.ok(line.startsWith('PASS  probe'), `expected PASS, got: ${line}`)
  assert.ok(!line.includes('slow:'), `a fast pass must not be annotated slow: ${line}`)
  assert.notEqual(exitCode, 1, 'a passing check must not set a failing exit code')
})

case_('a slow pass is a PASS annotated with the overrun, exit code stays clean', async () => {
  const { line, exitCode } = await run(async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
  }, 20)
  assert.ok(line.startsWith('PASS  probe (slow: overran 20ms'), `expected a slow PASS, got: ${line}`)
  assert.notEqual(exitCode, 1, 'a slow pass must not poison the exit code')
})

case_('a failure after the deadline is a FAIL carrying the real message', async () => {
  const { line, exitCode } = await run(async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    throw new Error('the real assertion broke')
  }, 20)
  assert.ok(line.startsWith('FAIL  probe: the real assertion broke'), `expected the real message, got: ${line}`)
  assert.equal(exitCode, 1, 'a real failure must set the exit code')
})

case_('an assertion whose message mimics a timeout is still a plain FAIL', async () => {
  // 旧副本靠 `startsWith('timed out after ')` 识别超时，一条恰好这样开头的
  // 真实断言错误会被当成超时、进而被降级成「慢但通过」。
  const { line, exitCode } = await run(async () => {
    throw new Error('timed out after 5ms — this is the assertion talking')
  }, 1000)
  assert.ok(line.startsWith('FAIL  probe: timed out after 5ms — this is the assertion talking'), `got: ${line}`)
  assert.ok(!line.includes('slow:'), `must not be treated as a slow pass: ${line}`)
  assert.equal(exitCode, 1)
})

case_('a skip is reported as SKIP and is not a failure', async () => {
  class SkipSignal extends Error {}
  const { line, exitCode } = await run(async () => { throw new SkipSignal('no ffmpeg here') }, 1000, {
    isSkip: error => error instanceof SkipSignal,
  })
  assert.ok(line.startsWith('SKIP  probe: no ffmpeg here'), `got: ${line}`)
  assert.notEqual(exitCode, 1, 'a skip must not be a failure')
})

let bad = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`ok    ${name}`)
  } catch (error) {
    bad += 1
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}
console.log(bad === 0 ? `\ncheck harness: ${cases.length} passed` : `\ncheck harness: ${bad} of ${cases.length} failed`)
process.exit(bad === 0 ? 0 : 1)

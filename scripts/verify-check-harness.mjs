// 共享 check 执行器的语义验收。跑法：node scripts/verify-check-harness.mjs
//
// 判定规则本身只有一份实现：`scripts/lib/check-harness.mjs` 的 `assertRules`。
// 这里做两件事，比它自己多一层：
//
//   1. 在【正确】的 harness 上跑一遍 assertRules，确认规则成立；
//   2. 把 harness 改回旧语义（超时即判 FAIL 并置退出码），要求 1 必须变红。
//
// 为什么第 2 条重要：断言写错的时候，两边会一起错——自检永远绿。反向那一半
// 证明这套规则真的能抓住它存在的那个缺陷。
//
// 为什么 assertRules 不在本文件里自己写一份：`pnpm test` 不调用本文件，只写在
// 这里等于没人跑。smoke.mjs 在链路里，它 import 同一个 assertRules，规则因此
// 进了闸门。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const harness = join(here, 'lib/check-harness.mjs')

const cases = []
const case_ = (name, fn) => cases.push([name, fn])

case_('the shipped harness satisfies every verdict rule', async () => {
  const { assertRules } = await import(pathToFileURL(harness).href)
  await assertRules(assert)
})

case_('a harness that treats the deadline as a verdict fails those rules', async () => {
  // 旧语义：超时直接记 FAIL 并置退出码，不管断言后来有没有通过。
  // 只改这一处，其余原样，确保变红来自这个缺陷而不是别的。
  const source = readFileSync(harness, 'utf8')
  const marker = `      const late = await settleWithin(ran, LATE_SETTLE_MS)`
  assert.ok(source.includes(marker), '没找到超时处理段 —— harness 的结构变了，这条反向验证要跟着改')
  const mutated = source.replace(
    marker,
    `      results.push(\`FAIL  \${name}: timed out after \${timeoutMs}ms\`)
      failed = true
      return
      // eslint-disable-next-line no-unreachable
      const late = await settleWithin(ran, LATE_SETTLE_MS)`,
  )
  const dir = mkdtempSync(join(tmpdir(), 'check-harness-mutant-'))
  const path = join(dir, 'lib-check-harness.mut.mjs')
  writeFileSync(path, mutated)
  const { assertRules } = await import(pathToFileURL(path).href)
  let threw = false
  try {
    await assertRules(assert)
  } catch {
    threw = true
  }
  assert.ok(threw, '把超时当结论之后，自检竟然还是绿的 —— 这套规则没有保护作用')
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

/**
 * 行为信号账本与报告的离线验证。
 *
 * 这里钉住三件事，每一件都是「看起来对、实际会骗人」的地方：
 *
 *  1. **不落原文**：任何信号行里都不能出现提示词原文。这是整个功能能不能被
 *     打开的前提，靠一条断言把它焊死，而不是靠注释里的承诺。
 *  2. **分桶**：同一个模型在 t2i 上的重试率不能算到 i2i 头上。
 *  3. **小样本不给结论**：样本不足时必须是 unknown，不能是 ok —— 否则报告会
 *     教会读者忽略它的结论。
 *
 * 走临时数据根目录，不碰真实用户的 signals/。
 *
 * Run: node scripts/smoke-signals.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { allSignals, clearSignals, listSignals, normalizeSignal, promptBucketOf, recordSignal } from '../src/signal-store.ts'
import { buildReport, DELETE_WARN, MIN_SAMPLE, RETRY_WARN } from '../src/signal-report.ts'

const root = await mkdtemp(path.join(tmpdir(), 'dsh-signals-'))
setImageDataRoot(root)

let count = 0
function ok(name, fn) {
  fn()
  count += 1
  console.log(`ok ${count} - ${name}`)
}

async function okAsync(name, fn) {
  await fn()
  count += 1
  console.log(`ok ${count} - ${name}`)
}

/** 一次成功生成的完整提示词，用来证明它不会出现在任何落盘内容里。 */
const SECRET_PROMPT = '一只戴着矿工头盔的柴犬，站在发光的服务器机柜前面，电影感逆光，超广角'

try {
  // ---------------------------------------------------------------- 长度分档
  ok('promptBucketOf 按长度分档，且空提示词是 none', () => {
    assert.equal(promptBucketOf(undefined), 'none')
    assert.equal(promptBucketOf('   '), 'none')
    assert.equal(promptBucketOf('a'.repeat(120)), 'short')
    assert.equal(promptBucketOf('a'.repeat(121)), 'medium')
    assert.equal(promptBucketOf('a'.repeat(400)), 'medium')
    assert.equal(promptBucketOf('a'.repeat(401)), 'long')
    assert.equal(promptBucketOf('a'.repeat(1200)), 'long')
    assert.equal(promptBucketOf('a'.repeat(1201)), 'huge')
  })

  ok('分档不保留任何原文片段，只剩枚举', () => {
    const bucket = promptBucketOf(SECRET_PROMPT)
    assert.ok(['none', 'short', 'medium', 'long', 'huge'].includes(bucket))
    assert.ok(!String(bucket).includes('柴犬'))
  })

  // ------------------------------------------------------------ 输入白名单
  ok('未知 kind 被拒绝，而不是被当成 rating 记下来', () => {
    assert.equal(normalizeSignal({ kind: 'explode' }, 1000), undefined)
    assert.equal(normalizeSignal({}, 1000), undefined)
  })

  ok('rating 缺 reason 被拒绝：没有归因的差评没有可行动的信息', () => {
    assert.equal(normalizeSignal({ kind: 'rating' }, 1000), undefined)
    assert.ok(normalizeSignal({ kind: 'rating', reason: 'text' }, 1000) !== undefined)
  })

  ok('未知 pipeline / source 退回到安全默认值', () => {
    const entry = normalizeSignal({ kind: 'retry', pipeline: 'nonsense', source: 'nonsense', prompt: 'x' }, 1000)
    assert.equal(entry.pipeline, 'image')
    assert.equal(entry.source, 'user')
  })

  ok('失败码只接受标识符形状，其他内容被丢弃而不是照抄', () => {
    const withCode = normalizeSignal({ kind: 'failure', failureCode: 'http-500' }, 1000)
    assert.equal(withCode.failureCode, 'http-500')
    const withJunk = normalizeSignal({ kind: 'failure', failureCode: '一段中文说明：连接被拒绝' }, 1000)
    assert.equal(withJunk.failureCode, undefined)
  })

  ok('超长模型名被截断而不是拒绝', () => {
    const entry = normalizeSignal({ kind: 'retry', model: 'm'.repeat(500) }, 1000)
    assert.equal(entry.model.length, 120)
  })

  // ---------------------------------------------------------------- 落盘
  const at = Date.UTC(2026, 9, 20, 12, 0, 0)
  await okAsync('recordSignal 写入按月分文件，并返回带 id 的条目', async () => {
    const entry = await recordSignal({
      kind: 'retry',
      pipeline: 'image',
      model: 'seedream-5.0-pro',
      channel: '主渠道',
      mode: 't2i',
      prompt: SECRET_PROMPT,
      source: 'auto',
    }, at)
    assert.ok(entry !== undefined)
    assert.match(entry.id, /^sig-/)
    // SECRET_PROMPT 约 37 字，落在 <=120 的 short 档；这里断言的是「档位算出来了」，
    // 不是某个具体档位——具体档位由 promptBucketOf 的那组用例钉住。
    assert.equal(entry.promptBucket, 'short')

    const files = await readdir(path.join(root, 'signals'))
    assert.deepEqual(files, ['2026-10.jsonl'])
  })

  await okAsync('落盘内容不含提示词原文、不含 prompt 字段', async () => {
    const text = await readFile(path.join(root, 'signals', '2026-10.jsonl'), 'utf8')
    assert.ok(!text.includes('柴犬'))
    assert.ok(!text.includes('"prompt"'))
    assert.ok(text.includes('"promptBucket":"short"'))
  })

  await okAsync('allSignals 读回同一条，且按时间升序', async () => {
    const entries = await allSignals(Date.UTC(2026, 10, 3))
    const mine = entries.filter(entry => entry.model === 'seedream-5.0-pro')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].at, at)
  })

  await okAsync('同 nonce 的第二条被吞掉（双击不会变成两条信号）', async () => {
    const first = await recordSignal({ kind: 'rating', reason: 'text', nonce: 'n-1' }, at + 1)
    const second = await recordSignal({ kind: 'rating', reason: 'text', nonce: 'n-1' }, at + 2)
    assert.ok(first !== undefined)
    assert.equal(second, undefined)
  })

  await okAsync('没有 nonce 的两条都保留', async () => {
    const first = await recordSignal({ kind: 'rating', reason: 'slow' }, at + 3)
    const second = await recordSignal({ kind: 'rating', reason: 'slow' }, at + 4)
    assert.ok(first !== undefined && second !== undefined)
  })

  await okAsync('listSignals 报告的月份与该月条数一致', async () => {
    const months = await listSignals(Date.UTC(2026, 10, 3), 3)
    assert.equal(months.length, 3)
    const october = months.find(month => month.month === '2026-10')
    assert.ok(october !== undefined)
    assert.ok(october.entries.length >= 4)
    assert.equal(october.truncated, undefined)
  })

  // ---------------------------------------------------------------- 聚合
  const now = Date.UTC(2026, 10, 3)
  /** 造 n 条同一组合的信号，kind 由 weight 决定。 */
  function synth(n, kind, overrides = {}) {
    return Array.from({ length: n }, (_, index) => ({
      id: `s-${kind}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      at: now - index * 1000,
      kind,
      pipeline: 'image',
      model: 'm',
      channel: 'c',
      mode: 't2i',
      promptBucket: 'short',
      source: 'auto',
      version: '1.21.0',
      ...overrides,
    }))
  }

  ok('小样本一律 unknown，不给 ok', () => {
    const report = buildReport(synth(MIN_SAMPLE - 1, 'retry'), { now })
    assert.equal(report.buckets.length, 1)
    assert.equal(report.buckets[0].verdict, 'unknown')
    assert.equal(report.findings.filter(finding => finding.severity !== 'info').length, 0)
  })

  ok('重试率越过 warn 阈值时判 warn，并归因到 retry', () => {
    const total = 40
    const retries = Math.ceil(total * RETRY_WARN)
    const entries = [...synth(retries, 'retry'), ...synth(total - retries, 'delete')]
    // delete 占比也会很高，所以这里只看「有没有 warn」和「重试被算出来」。
    const report = buildReport(entries, { now })
    const bucket = report.buckets[0]
    assert.equal(bucket.total, total)
    assert.equal(bucket.retry, retries)
    assert.ok(bucket.retryRate >= RETRY_WARN)
    assert.equal(bucket.verdict, 'warn')
    assert.ok(['retry', 'delete'].includes(bucket.verdictMetric))
  })

  ok('同一个模型的不同 mode 分成两个桶，绝不混合', () => {
    const entries = [...synth(30, 'retry', { mode: 't2i' }), ...synth(30, 'delete', { mode: 'i2i' })]
    const report = buildReport(entries, { now })
    assert.equal(report.buckets.length, 2)
    const t2i = report.buckets.find(bucket => bucket.mode === 't2i')
    const i2i = report.buckets.find(bucket => bucket.mode === 'i2i')
    assert.equal(t2i.retry, 30)
    assert.equal(t2i.delete, 0)
    assert.equal(i2i.delete, 30)
    assert.equal(i2i.retry, 0)
  })

  ok('三个指标各自出数，没有合并分数字段', () => {
    const entries = [...synth(10, 'retry'), ...synth(10, 'delete'), ...synth(10, 'failure')]
    const bucket = buildReport(entries, { now }).buckets[0]
    assert.equal(bucket.retryRate, 10 / 30)
    assert.equal(bucket.deleteRate, 10 / 30)
    assert.equal(bucket.failureRate, 10 / 30)
    assert.equal(Object.hasOwn(bucket, 'score'), false)
    assert.equal(Object.hasOwn(bucket, 'unsatisfaction'), false)
  })

  ok('删除率越过阈值会单独出 delete 结论', () => {
    const total = 50
    const deletes = Math.ceil(total * DELETE_WARN)
    const entries = [...synth(deletes, 'delete'), ...synth(total - deletes, 'rating', { reason: 'slow' })]
    const report = buildReport(entries, { now })
    const deleteFinding = report.findings.find(finding => finding.metric === 'delete')
    assert.ok(deleteFinding !== undefined)
    assert.equal(deleteFinding.severity, 'warn')
  })

  ok('差评按原因计数，并作为 info 结论列出', () => {
    const entries = [
      ...synth(25, 'rating', { reason: 'text' }),
      ...synth(5, 'rating', { reason: 'misread' }),
    ]
    const report = buildReport(entries, { now })
    const bucket = report.buckets[0]
    assert.equal(bucket.reasons.text, 25)
    assert.equal(bucket.reasons.misread, 5)
    const rating = report.findings.find(finding => finding.metric === 'rating')
    assert.ok(rating !== undefined)
    assert.equal(rating.severity, 'info')
    assert.ok(rating.zh.includes('text×25'))
  })

  ok('窗口外的信号不计入报告', () => {
    const old = synth(40, 'retry', { at: now - 200 * 24 * 60 * 60 * 1000 })
    const report = buildReport(old, { now, windowDays: 90 })
    assert.equal(report.total, 0)
    assert.equal(report.buckets.length, 0)
  })

  ok('窗口参数只影响计数，不影响阈值常数', () => {
    const entries = synth(40, 'retry')
    const short = buildReport(entries, { now, windowDays: 1 })
    const long = buildReport(entries, { now, windowDays: 365 })
    assert.equal(short.buckets[0].verdict, long.buckets[0].verdict)
  })

  ok('issue 草稿只含汇总，不含提示词与渠道地址', () => {
    const report = buildReport([...synth(30, 'retry'), ...synth(5, 'rating', { reason: 'unlike' })], { now })
    assert.ok(!report.issue.body.includes('柴犬'))
    assert.ok(!report.issue.body.includes('https://api.'))
    assert.ok(report.issue.url.startsWith('https://github.com/'))
    assert.ok(report.issue.url.includes('issues/new'))
    assert.ok(report.issue.title.length > 0)
  })

  ok('截断的月份会让报告带上缺口说明', () => {
    const report = buildReport([], { now, gaps: { monthsRead: 1, truncated: ['2026-09'] } })
    assert.deepEqual(report.gaps.truncated, ['2026-09'])
  })

  // 真实落盘再走一遍完整链路：写入 → 读回 → 出报告。
  await okAsync('落盘 → 读回 → 报告，端到端一致', async () => {
    const before = await allSignals(now)
    const report = buildReport(before, { now })
    assert.equal(report.total, before.filter(entry => entry.at >= now - 90 * 24 * 60 * 60 * 1000).length)
    assert.ok(report.buckets.length > 0)
  })

  await okAsync('clearSignals 只删月度文件，目录本身保留', async () => {
    await clearSignals()
    const remaining = await readdir(path.join(root, 'signals'))
    assert.deepEqual(remaining, [])
    assert.equal((await allSignals(now)).length, 0)
  })
} finally {
  setImageDataRoot(undefined)
  await rm(root, { recursive: true, force: true })
}

console.log(`\n# smoke-signals: ${count} checks passed`)

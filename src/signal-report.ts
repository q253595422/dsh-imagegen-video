/**
 * Signal aggregation (self-evolution L0).
 *
 * Pure functions over `SignalEntry[]`. Nothing here reads the disk: the caller
 * hands in entries and gets a report, so every threshold below is testable by
 * feeding a fixture — which is the only way a rate-based claim can be trusted.
 *
 * Three decisions shape this file, and each one is a correction of the obvious
 * approach:
 *
 * 1. BUCKET BY model × mode, never by model alone. "seedream retried 40% of the
 *    time" is meaningless if the user only ever runs their hardest prompts on
 *    it. A model that leads on t2i and is never chosen for i2i must not inherit
 *    i2i's numbers, so modes never mix inside one bucket.
 *
 * 2. THREE METRICS, never one score. `retry` is a quality judgement, `delete`
 *    is wasted spend, `failure` is the pipeline's own fault, and a negative
 *    `rating` is the only signal that says WHY. Adding them into an
 *    "unsatisfaction score" makes two very different problems look alike and
 *    produces advice that fixes neither. They are reported side by side.
 *
 * 3. SMALL SAMPLES SAY NOTHING. Every bucket under `MIN_SAMPLE` is listed with
 *    its counts and no verdict at all — not a green verdict. A report that
 *    rates a 3-sample bucket teaches the reader to ignore the rating.
 */

import type { SignalEntry, SignalKind, SignalPipeline, SignalReason } from './protocol.ts'
import type {
  PromptBucket,
  SignalBucketSummary as SignalBucket,
  SignalFindingSummary as SignalFinding,
  SignalReportGaps,
  SignalVerdict as Verdict,
} from './protocol.ts'

/** Below this many signals a bucket gets counts but no verdict. */
export const MIN_SAMPLE = 20

/** A retry rate that is worth a look, and one that is worth changing defaults for. */
export const RETRY_WATCH = 0.3
export const RETRY_WARN = 0.5

/** Deleting a result is a stronger statement than retrying it. */
export const DELETE_WATCH = 0.2
export const DELETE_WARN = 0.35

/** The pipeline failing on its own, before the user judged anything. */
export const FAILURE_WATCH = 0.15
export const FAILURE_WARN = 0.3

/** Default reporting window. Long enough to survive a release, short enough
 *  that a stale model still in the log does not dominate. */
export const DEFAULT_WINDOW_DAYS = 90

/** Per-bucket counts. `total` counts signals, not generations: one generation
 *  can produce a delete and a rating, and both are real statements about it.
 *
 * `SignalBucket`, `SignalFinding`, `SignalReportGaps` and `Verdict` are the
 * protocol's wire types, imported above under these names: the browser renders
 * the same objects this module returns, and two declarations would drift. */

export interface IssueDraft {
  title: string
  /** Markdown, ready to paste. Contains aggregates only — no prompt text, no
   *  image, no channel address. */
  body: string
  /** Prefilled GitHub "new issue" URL, opened in the user's browser on click. */
  url: string
}

export interface SignalReport {
  generatedAt: number
  windowDays: number
  /** Signals inside the window. */
  total: number
  byKind: Record<SignalKind, number>
  byPipeline: Record<SignalPipeline, number>
  buckets: SignalBucket[]
  findings: SignalFinding[]
  gaps: SignalReportGaps
  issue: IssueDraft
}

const ISSUE_REPO = 'https://github.com/q253595422/dsh-imagegen-video'

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function emptyReasons(): Record<SignalReason, number> {
  return { unlike: 0, text: 0, slow: 0, misread: 0 }
}

function bucketKey(entry: SignalEntry): string {
  return [
    entry.pipeline,
    entry.model,
    entry.mode,
    entry.promptBucket ?? '',
    entry.hasReference === undefined ? '' : entry.hasReference ? 'ref' : 'noref',
  ].join('\u0000')
}

/**
 * Turn one bucket's counts into a verdict. The three rates are compared against
 * their own thresholds and the worst verdict wins; this is deliberately NOT a
 * weighted sum, because a formula that lets a 0.9 failure rate be diluted by a
 * 0.05 retry rate would hide exactly the case that needs acting on.
 */
function verdictOf(bucket: Omit<SignalBucket, 'verdict' | 'verdictMetric'>): {
  verdict: Verdict
  verdictMetric: SignalBucket['verdictMetric']
} {
  if (bucket.total < MIN_SAMPLE) return { verdict: 'unknown', verdictMetric: '' }
  const candidates: Array<{ verdict: Verdict; metric: SignalBucket['verdictMetric']; rank: number }> = [
    { verdict: tier(bucket.failureRate, FAILURE_WATCH, FAILURE_WARN), metric: 'failure', rank: 3 },
    { verdict: tier(bucket.deleteRate, DELETE_WATCH, DELETE_WARN), metric: 'delete', rank: 2 },
    { verdict: tier(bucket.retryRate, RETRY_WATCH, RETRY_WARN), metric: 'retry', rank: 1 },
  ]
  const worst = candidates.reduce((left, right) => {
    const order = { unknown: 0, ok: 1, watch: 2, warn: 3 } as const
    if (order[right.verdict] !== order[left.verdict]) {
      return order[right.verdict] > order[left.verdict] ? right : left
    }
    return right.rank > left.rank ? right : left
  })
  if (worst.verdict === 'watch' || worst.verdict === 'warn') {
    return { verdict: worst.verdict, verdictMetric: worst.metric }
  }
  return { verdict: 'ok', verdictMetric: '' }
}

function tier(value: number, watch: number, warn: number): Verdict {
  if (value >= warn) return 'warn'
  if (value >= watch) return 'watch'
  return 'ok'
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`
}

function scopeOf(bucket: SignalBucket): string {
  const parts = [bucket.model === '' ? '(unknown model)' : bucket.model, bucket.mode]
  if (bucket.promptBucket !== '' && bucket.promptBucket !== 'none') parts.push(`prompt:${bucket.promptBucket}`)
  if (bucket.hasReference !== undefined) parts.push(bucket.hasReference ? 'ref' : 'no-ref')
  return parts.filter(part => part !== '').join(' · ')
}

/** Interpret the buckets. Only `watch`/`warn` buckets with a sample large
 *  enough to be worth acting on produce a finding. */
function findingsOf(buckets: SignalBucket[]): SignalFinding[] {
  const findings: SignalFinding[] = []
  for (const bucket of buckets) {
    if (bucket.verdict === 'ok' || bucket.verdict === 'unknown') continue
    const severity = bucket.verdict === 'warn' ? 'warn' : 'watch'
    const scope = scopeOf(bucket)
    if (bucket.verdictMetric === 'failure') {
      findings.push({
        id: `${bucket.pipeline}:${bucket.model}:${bucket.mode}:failure`,
        severity,
        metric: 'failure',
        scope,
        value: bucket.failureRate,
        sample: bucket.total,
        zh: `${scope}：失败率 ${percent(bucket.failureRate)}（${bucket.failure}/${bucket.total}），先查渠道与协议族，再看模型。`,
        en: `${scope}: failure rate ${percent(bucket.failureRate)} (${bucket.failure}/${bucket.total}). Check the channel and protocol family before the model.`,
      })
      continue
    }
    if (bucket.verdictMetric === 'delete') {
      findings.push({
        id: `${bucket.pipeline}:${bucket.model}:${bucket.mode}:delete`,
        severity,
        metric: 'delete',
        scope,
        value: bucket.deleteRate,
        sample: bucket.total,
        zh: `${scope}：删除率 ${percent(bucket.deleteRate)}（${bucket.delete}/${bucket.total}），说明结果白出了。`,
        en: `${scope}: delete rate ${percent(bucket.deleteRate)} (${bucket.delete}/${bucket.total}) — results are being thrown away.`,
      })
      continue
    }
    findings.push({
      id: `${bucket.pipeline}:${bucket.model}:${bucket.mode}:retry`,
      severity,
      metric: 'retry',
      scope,
      value: bucket.retryRate,
      sample: bucket.total,
      zh: `${scope}：重试率 ${percent(bucket.retryRate)}（${bucket.retry}/${bucket.total}），结果需要重做才能用。`,
      en: `${scope}: retry rate ${percent(bucket.retryRate)} (${bucket.retry}/${bucket.total}) — a second attempt was needed.`,
    })
  }
  // Explicit ratings are the only signal that says why, so they surface first
  // even when their rate is below a threshold: three "字错" in a week is a
  // sharper lead than any percentage over a small sample.
  for (const bucket of buckets) {
    if (bucket.rating === 0) continue
    const reasons = (Object.entries(bucket.reasons) as Array<[SignalReason, number]>)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(', ')
    findings.push({
      id: `${bucket.pipeline}:${bucket.model}:${bucket.mode}:rating`,
      severity: 'info',
      metric: 'rating',
      scope: scopeOf(bucket),
      value: bucket.ratingRate,
      sample: bucket.rating,
      zh: `${scopeOf(bucket)}：${bucket.rating} 条明确差评（${reasons}）。`,
      en: `${scopeOf(bucket)}: ${bucket.rating} explicit negative rating(s) (${reasons}).`,
    })
  }
  const order = { warn: 0, watch: 1, info: 2 } as const
  return findings.sort((left, right) => order[left.severity] - order[right.severity] || right.value - left.value)
}

/**
 * Build the issue draft. This is the "send it back upstream" path, and it is a
 * DRAFT: the host writes the markdown and the prefilled URL, and the browser
 * opens it. Nothing is posted behind the user's back, because the signal log
 * lives on their machine and uploading it silently would make every later
 * consent question meaningless.
 */
function issueOf(report: Omit<SignalReport, 'issue'>, language: 'zh' | 'en'): IssueDraft {
  const actionable = report.findings.filter(finding => finding.severity !== 'info')
  const rated = report.findings.filter(finding => finding.severity === 'info')
  const title = language === 'zh'
    ? `[signal] ${actionable.length} 个模型/模式组合需要关注（${report.windowDays} 天）`
    : `[signal] ${actionable.length} model/mode combination(s) need attention (${report.windowDays}d)`
  const lines: string[] = []
  if (language === 'zh') {
    lines.push(
      '### 自动汇总（本机信号，无提示词、无图片）',
      '',
      `- 窗口：最近 ${report.windowDays} 天`,
      `- 信号总数：${report.total}`,
      `- 读取月份：${report.gaps.monthsRead}${report.gaps.truncated.length > 0 ? `（${report.gaps.truncated.join(', ')} 未读全）` : ''}`,
      '',
      '### 需要关注',
      '',
      ...(actionable.length === 0 ? ['（无）'] : actionable.map(finding => `- **${finding.severity}** ${finding.zh}`)),
      '',
      '### 明确差评',
      '',
      ...(rated.length === 0 ? ['（无）'] : rated.map(finding => `- ${finding.zh}`)),
      '',
      '### 指标口径',
      '',
      '- `重试`：同一节点再次生成；`删除`：生成结果被丢弃；`失败`：链路自身报错；`差评`：用户主动选择原因。',
      '- 三者分开统计，不合并成单一分数：它们指向不同的修法。',
      '- 样本少于 20 的组合不给结论。',
    )
  } else {
    lines.push(
      '### Automatic summary (local signals only — no prompts, no images)',
      '',
      `- Window: last ${report.windowDays} days`,
      `- Signals: ${report.total}`,
      `- Months read: ${report.gaps.monthsRead}${report.gaps.truncated.length > 0 ? ` (${report.gaps.truncated.join(', ')} partially read)` : ''}`,
      '',
      '### Needs attention',
      '',
      ...(actionable.length === 0 ? ['(none)'] : actionable.map(finding => `- **${finding.severity}** ${finding.en}`)),
      '',
      '### Explicit negative ratings',
      '',
      ...(rated.length === 0 ? ['(none)'] : rated.map(finding => `- ${finding.en}`)),
      '',
      '### Definitions',
      '',
      '- `retry`: regenerated on the same node; `delete`: result discarded; `failure`: the pipeline itself failed; `rating`: the user picked a reason.',
      '- They are reported separately, never summed into one score: they point at different fixes.',
      '- Combinations with fewer than 20 signals get no verdict.',
    )
  }
  const body = lines.join('\n')
  const params = new URLSearchParams({ title, body, labels: 'signal' })
  return { title, body, url: `${ISSUE_REPO}/issues/new?${params.toString()}` }
}

/**
 * Build a report from entries. `now` is injected so the window and the issue
 * stamp are testable without freezing the clock.
 */
export function buildReport(
  entries: readonly SignalEntry[],
  options: {
    now?: number
    windowDays?: number
    gaps?: SignalReportGaps
    language?: 'zh' | 'en'
  } = {},
): SignalReport {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const since = now - windowDays * 24 * 60 * 60 * 1000
  const inWindow = entries.filter(entry => entry.at >= since && entry.at <= now)

  const byKind: Record<SignalKind, number> = { retry: 0, delete: 0, failure: 0, rating: 0 }
  const byPipeline: Record<SignalPipeline, number> = { image: 0, video: 0, canvas: 0, skill: 0 }

  const grouped = new Map<string, SignalBucket>()
  for (const entry of inWindow) {
    byKind[entry.kind] += 1
    byPipeline[entry.pipeline] += 1
    const key = bucketKey(entry)
    if (!grouped.has(key)) {
      grouped.set(key, {
        pipeline: entry.pipeline,
        model: entry.model,
        mode: entry.mode,
        promptBucket: entry.promptBucket ?? '',
        hasReference: entry.hasReference,
        total: 0,
        retry: 0,
        delete: 0,
        failure: 0,
        rating: 0,
        reasons: emptyReasons(),
        retryRate: 0,
        deleteRate: 0,
        failureRate: 0,
        ratingRate: 0,
        verdict: 'unknown',
        verdictMetric: '',
      })
    }
    // Re-read rather than reuse a local: `set` then `get` is what narrows the
    // type, and the map is the single source of truth for the bucket.
    const bucket = grouped.get(key)
    if (bucket === undefined) continue
    bucket.total += 1
    if (entry.kind === 'retry') bucket.retry += 1
    if (entry.kind === 'delete') bucket.delete += 1
    if (entry.kind === 'failure') bucket.failure += 1
    if (entry.kind === 'rating') {
      bucket.rating += 1
      if (entry.reason !== undefined) bucket.reasons[entry.reason] += 1
    }
  }

  const buckets = [...grouped.values()].map(bucket => {
    const withRates: Omit<SignalBucket, 'verdict' | 'verdictMetric'> = {
      ...bucket,
      retryRate: rate(bucket.retry, bucket.total),
      deleteRate: rate(bucket.delete, bucket.total),
      failureRate: rate(bucket.failure, bucket.total),
      ratingRate: rate(bucket.rating, bucket.total),
    }
    return { ...withRates, ...verdictOf(withRates) }
  })
  // Most-flagged first, then by sample size: a bucket you can act on should not
  // be buried under a long tail of one-off combinations.
  const verdictRank = { warn: 0, watch: 1, unknown: 2, ok: 3 } as const
  buckets.sort((left, right) => verdictRank[left.verdict] - verdictRank[right.verdict] || right.total - left.total)

  const gaps: SignalReportGaps = options.gaps ?? { monthsRead: 0, truncated: [] }
  const base = {
    generatedAt: now,
    windowDays,
    total: inWindow.length,
    byKind,
    byPipeline,
    buckets,
    findings: findingsOf(buckets),
    gaps,
  }
  return { ...base, issue: issueOf(base, options.language ?? 'zh') }
}

/**
 * Behaviour signal report (self-evolution L0).
 *
 * READ-ONLY on purpose. This surface shows what the plugin noticed, and the
 * one action it offers is "hand this upstream" — it never changes a model, a
 * threshold or a default. Self-tuning before the numbers have been read is how
 * a report starts lying: the first bad week would quietly pick a different
 * default and every later comparison would be against a moving baseline.
 *
 * Three things this panel refuses to do, each for a reason visible in the code
 * below:
 *
 *  - It never shows a combined "score". Retry, delete and failure answer
 *    different questions, and a single number would make a broken channel and a
 *    weak model look identical.
 *  - It never gives a verdict on a small sample. Under `MIN_SAMPLE` the row
 *    says how many signals it has and stops.
 *  - It never uploads. The "open issue" button opens a prefilled GitHub form in
 *    the user's own browser, where they can read and edit every line before
 *    submitting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageGenApi } from './api.ts'
import { useModalFocus } from './DiagnosticsPanel.tsx'
import { tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import type { SignalBucketSummary, SignalReportSummary, SignalVerdict } from '../protocol.ts'
import css from './panel.module.css'

/** Preset windows. A month is the shortest range that can carry a rate; a year
 *  is only useful once a user has updated through a major version. */
const WINDOWS: ReadonlyArray<{ days: number; key: string }> = [
  { days: 30, key: 'signals.window30' },
  { days: 90, key: 'signals.window90' },
  { days: 365, key: 'signals.window365' },
]

/** Verdict → the CSS attribute the stylesheet colours by. `unknown` is a real
 *  state, not "ok": a small sample is not evidence of health. */
function verdictTone(verdict: SignalVerdict): string {
  if (verdict === 'warn') return 'warn'
  if (verdict === 'watch') return 'watch'
  if (verdict === 'ok') return 'ok'
  return 'unknown'
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function scopeLabel(bucket: SignalBucketSummary): string {
  const parts = [bucket.model === '' ? '—' : bucket.model, bucket.mode]
  if (bucket.promptBucket !== '' && bucket.promptBucket !== 'none') parts.push(`prompt:${bucket.promptBucket}`)
  if (bucket.hasReference !== undefined) parts.push(bucket.hasReference ? 'ref' : 'no-ref')
  return parts.filter(part => part !== '').join(' · ')
}

/**
 * The entry point. It sits beside the diagnostics button because they answer
 * the same question one level apart: diagnostics is "what happened to this
 * call", this is "what keeps happening to this model".
 */
export function SignalsButton(props: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  useImageGenLanguageTick()
  return (
    <button
      type="button"
      className={css.taskTrayDiagnostics}
      data-signals-button=""
      aria-pressed={props.open}
      aria-expanded={props.open}
      title={tt('signals.hint')}
      onClick={props.onToggle}
    >
      {tt('signals.open')}
    </button>
  )
}

/** The report itself, as a full-panel overlay. */
export function SignalsPanel(props: {
  api: ImageGenApi
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  useImageGenLanguageTick()
  const [report, setReport] = useState<SignalReportSummary | null>(null)
  const [windowDays, setWindowDays] = useState(90)
  const [loading, setLoading] = useState(false)
  /** A failed read must not look like "no signals": the two are exactly what
   *  this panel exists to distinguish. */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  useModalFocus(props.open, panelRef, props.onClose)

  const reload = useCallback(async (days: number) => {
    setLoading(true)
    try {
      setReport(await props.api.signalReport(days))
      setLoadError(null)
    } catch (error) {
      setReport(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [props.api])

  useEffect(() => {
    if (!props.open) return
    void reload(windowDays)
  }, [props.open, reload, windowDays])

  const copyMarkdown = useCallback(async () => {
    if (report === null) return
    try {
      await navigator.clipboard.writeText(report.issue.body)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1600)
    } catch {
      // Clipboard unavailable: leave the panel as the source of truth rather
      // than claiming a copy that did not happen.
      setCopied(false)
    }
  }, [report])

  /**
   * Open the prefilled issue form. A plain anchor would be simpler, but the URL
   * carries the whole report body and is often over a browser's length limit;
   * the host's export route is the authority, so it is fetched here, then the
   * window is opened by the click itself (not on a timer, which popup blockers
   * drop).
   */
  const openIssue = useCallback(async () => {
    try {
      const draft = await props.api.signalExport()
      const opened = window.open(draft.url, '_blank', 'noopener,noreferrer')
      if (opened === null) {
        // Popup blocked: copy the body so the click produced something usable.
        await navigator.clipboard.writeText(draft.markdown)
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1600)
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [props.api])

  if (!props.open) return null

  const language = tt('signals.langMark') === 'en' ? 'en' : 'zh'

  return (
    <section
      ref={panelRef}
      className={css.diagnosticsPanel}
      data-signals-panel=""
      role="dialog"
      aria-modal="true"
      aria-label={tt('signals.title')}
      tabIndex={-1}
    >
      <header className={css.diagnosticsHeader}>
        <div>
          <strong>{tt('signals.title')}</strong>
          <span>{report === null ? '' : tt('signals.count', { count: report.total })}</span>
        </div>
        <div className={css.diagnosticsActions}>
          {WINDOWS.map(entry => (
            <button
              key={entry.days}
              type="button"
              aria-pressed={windowDays === entry.days}
              data-signals-window={entry.days}
              onClick={() => { setWindowDays(entry.days) }}
            >{tt(entry.key as never)}</button>
          ))}
          <button type="button" onClick={() => { void reload(windowDays) }} disabled={loading}>{loading ? tt('signals.loading') : tt('signals.refresh')}</button>
          <button type="button" onClick={() => { void copyMarkdown() }} disabled={report === null}>{copied ? tt('signals.copied') : tt('signals.copy')}</button>
          <button type="button" data-signals-issue="" onClick={() => { void openIssue() }} disabled={report === null}>{tt('signals.issue')}</button>
          <button type="button" aria-label={tt('preview.close')} title={tt('preview.close')} onClick={props.onClose}>×</button>
        </div>
      </header>
      <p className={css.diagnosticsHint}>{tt('signals.hint')}</p>
      {loadError !== null ? (
        <p className={css.diagnosticsEmpty} role="alert" data-signals-error="">{tt('signals.loadFailed', { reason: loadError })}</p>
      ) : null}
      {report !== null && report.gaps.truncated.length > 0 ? (
        // Every rate below is a lower bound when a month could not be read in
        // full; saying so is the difference between a report and a guess.
        <p className={css.diagnosticsHint} role="status" data-signals-gap="">{tt('signals.truncated', { months: report.gaps.truncated.join(', ') })}</p>
      ) : null}
      {report === null ? (
        loadError === null ? <p className={css.diagnosticsEmpty}>{loading ? tt('signals.loading') : tt('signals.empty')}</p> : null
      ) : report.total === 0 ? (
        <p className={css.diagnosticsEmpty}>{tt('signals.empty')}</p>
      ) : (
        <div className={css.diagnosticsRows}>
          <p className={css.diagnosticsHint}>{tt('signals.kindTotals', {
            retry: report.byKind.retry,
            deleted: report.byKind.delete,
            failure: report.byKind.failure,
            rating: report.byKind.rating,
          })}</p>
          {report.findings.length > 0 ? (
            <div className={css.signalsFindings}>
              {report.findings.map(finding => (
                <p key={finding.id} className={css.signalsFinding} data-severity={finding.severity}>
                  {language === 'en' ? finding.en : finding.zh}
                </p>
              ))}
            </div>
          ) : (
            <p className={css.diagnosticsEmpty}>{tt('signals.noFindings')}</p>
          )}
          {report.buckets.map(bucket => (
            <article
              key={`${bucket.pipeline}:${bucket.model}:${bucket.mode}:${bucket.promptBucket}:${String(bucket.hasReference)}`}
              className={css.diagnosticsRow}
              data-verdict={verdictTone(bucket.verdict)}
            >
              <div className={css.diagnosticsMeta}>
                <span className={css.diagnosticsPhase}>{bucket.pipeline}</span>
                <span>{scopeLabel(bucket)}</span>
                <span data-sample={bucket.total}>{tt('signals.sample', { count: bucket.total })}</span>
                {bucket.verdict === 'unknown' ? <span>{tt('signals.unknown')}</span> : null}
              </div>
              <div className={css.signalsRates}>
                <span data-metric="retry">{tt('signals.retryRate')} {percent(bucket.retryRate)} <b>{bucket.retry}/{bucket.total}</b></span>
                <span data-metric="delete">{tt('signals.deleteRate')} {percent(bucket.deleteRate)} <b>{bucket.delete}/{bucket.total}</b></span>
                <span data-metric="failure">{tt('signals.failureRate')} {percent(bucket.failureRate)} <b>{bucket.failure}/{bucket.total}</b></span>
                {bucket.rating > 0 ? <span data-metric="rating">{tt('signals.ratingRate')} <b>{bucket.rating}</b></span> : null}
              </div>
              {bucket.rating > 0 ? (
                <p className={css.diagnosticsMessage}>
                  {(['unlike', 'text', 'slow', 'misread'] as const)
                    .filter(reason => bucket.reasons[reason] > 0)
                    .map(reason => `${tt(`signals.reason.${reason}`)} ×${bucket.reasons[reason]}`)
                    .join(' · ')}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

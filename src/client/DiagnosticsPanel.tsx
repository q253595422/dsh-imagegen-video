/**
 * Retained upstream attempts (#38).
 *
 * The reporter of that issue reverse-engineered an image API, verified it
 * against new-api, and then watched every plugin call fail while neither side
 * had a log entry — the request never reached their gateway. The plugin showed
 * one sentence and kept nothing, so the address it actually called, the status
 * it got and the socket error behind it were all unrecoverable.
 *
 * This surface is the missing record: every attempt, newest first, with the
 * facts that separate a wrong URL from a refused connection, plus a one-click
 * copy that is safe to paste into a public issue.
 *
 * It is its own module because the record is not image-specific. The host
 * buffer holds the video pipeline's attempts too (submit → poll → download,
 * each under its own phase), and a user whose image calls work while their
 * video calls do not has to be able to reach this from where they actually
 * are: the image studio's task tray OR the video studio's run list.
 */

import { useCallback, useEffect, useState } from 'react'
import { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import type { DiagnosticEntry } from '../protocol.ts'
import css from './panel.module.css'

/**
 * The entry point that opens the record. Both studios render it in their own
 * header so the panel is never more than one click from a failed run.
 */
export function DiagnosticsButton(props: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  useImageGenLanguageTick()
  return (
    <button
      type="button"
      className={css.taskTrayDiagnostics}
      data-diagnostics-button=""
      aria-pressed={props.open}
      aria-expanded={props.open}
      title={tt('diagnostics.hint')}
      onClick={props.onToggle}
    >
      {tt('diagnostics.open')}
    </button>
  )
}

/** The retained attempts themselves, as a full-panel overlay. */
export function DiagnosticsPanel(props: {
  api: ImageGenApi
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  // Re-render on locale change, matching the rest of the panel.
  useImageGenLanguageTick()
  const [entries, setEntries] = useState<DiagnosticEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  // A read failure must not masquerade as "no attempts": an empty buffer and an
  // unreachable host look identical on screen, and that is exactly the
  // confusion this surface exists to remove.
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await props.api.diagnosticsList())
      setLoadError(null)
    } catch (error) {
      setEntries([])
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [props.api])

  // Load whenever the panel opens, so the record is never stale.
  useEffect(() => {
    if (!props.open) return
    void reload()
  }, [props.open, reload])

  /** Human-readable rendering of one attempt, in the caller's language. */
  const describe = useCallback((entry: DiagnosticEntry): string => {
    const parts: string[] = [`[${new Date(entry.at).toLocaleTimeString()}] ${entry.phase} · ${entry.channel}`]
    if (entry.model !== '') parts.push(entry.model)
    parts.push(`${entry.method} ${entry.url}`)
    if (entry.status !== undefined) parts.push(`HTTP ${entry.status}`)
    if (entry.errorCode !== undefined && entry.errorCode !== '') parts.push(entry.errorCode)
    if (entry.failureCode !== undefined && entry.failureCode !== '') parts.push(entry.failureCode)
    parts.push(`${entry.durationMs}ms`)
    if (entry.requestBytes !== undefined) parts.push(`req ${entry.requestBytes}B`)
    parts.push(entry.hadAuth ? 'auth=yes' : 'auth=no')
    if (entry.apiUrlFull === true) parts.push('exact-url')
    parts.push(`\n  ${entry.message}`)
    if (entry.bodyExcerpt !== undefined && entry.bodyExcerpt !== '') parts.push(`\n  <- ${entry.bodyExcerpt}`)
    if (entry.requestExcerpt !== undefined && entry.requestExcerpt !== '') parts.push(`\n  -> ${entry.requestExcerpt}`)
    return parts.join(' ')
  }, [])

  const copyAll = useCallback(async () => {
    const text = entries.map(describe).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1600)
    } catch {
      // Clipboard unavailable (permissions / insecure context): leave the panel
      // as the source of truth rather than pretending the copy worked.
      setCopied(false)
    }
  }, [entries, describe])

  const clearAll = useCallback(async () => {
    try {
      await props.api.diagnosticsClear()
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    await reload()
  }, [props.api, reload])

  if (!props.open) return null

  return (
    <section className={css.diagnosticsPanel} data-diagnostics-panel="" aria-label={tt('diagnostics.title')}>
      <header className={css.diagnosticsHeader}>
        <div>
          <strong>{tt('diagnostics.title')}</strong>
          <span>{tt('diagnostics.count', { count: entries.length })}</span>
        </div>
        <div className={css.diagnosticsActions}>
          <button type="button" onClick={() => { void reload() }} disabled={loading}>{loading ? tt('diagnostics.loading') : tt('diagnostics.refresh')}</button>
          <button type="button" onClick={() => { void copyAll() }} disabled={entries.length === 0}>{copied ? tt('diagnostics.copied') : tt('diagnostics.copy')}</button>
          <button type="button" onClick={() => { void clearAll() }} disabled={entries.length === 0}>{tt('diagnostics.clear')}</button>
          <button type="button" aria-label={tt('preview.close')} onClick={props.onClose}>×</button>
        </div>
      </header>
      <p className={css.diagnosticsHint}>{tt('diagnostics.hint')}</p>
      {loadError !== null ? (
        <p className={css.diagnosticsEmpty} role="alert" data-diagnostics-error="">{tt('diagnostics.loadFailed', { reason: loadError })}</p>
      ) : null}
      {entries.length === 0 ? (
        loadError === null ? <p className={css.diagnosticsEmpty}>{tt('diagnostics.empty')}</p> : null
      ) : (
        <div className={css.diagnosticsRows}>
          {entries.map(entry => (
            <article key={entry.id} className={css.diagnosticsRow} data-phase={entry.phase}>
              <div className={css.diagnosticsMeta}>
                <span className={css.diagnosticsPhase}>{entry.phase}</span>
                <span>{new Date(entry.at).toLocaleTimeString()}</span>
                <span>{entry.channel}</span>
                {entry.model !== '' ? <span>{entry.model}</span> : null}
                {entry.status !== undefined ? <span data-status={entry.status}>HTTP {entry.status}</span> : null}
                {entry.errorCode !== undefined && entry.errorCode !== '' ? <span data-error-code="">{entry.errorCode}</span> : null}
                <span>{entry.durationMs}ms</span>
                {entry.requestBytes !== undefined ? <span>req {entry.requestBytes}B</span> : null}
                <span>{entry.hadAuth ? 'auth' : 'no-auth'}</span>
                {entry.apiUrlFull === true ? <span>{tt('diagnostics.exactUrl')}</span> : null}
              </div>
              {/* The address actually called: the single most useful fact when
                  a request never reached the reporter's gateway. */}
              <code className={css.diagnosticsUrl}>{entry.method} {entry.url}</code>
              <p className={css.diagnosticsMessage}>{entry.message}</p>
              {entry.bodyExcerpt !== undefined && entry.bodyExcerpt !== '' ? (
                <details className={css.diagnosticsDetail}>
                  <summary>{tt('diagnostics.response')}</summary>
                  <pre>{entry.bodyExcerpt}</pre>
                </details>
              ) : null}
              {entry.requestExcerpt !== undefined && entry.requestExcerpt !== '' ? (
                <details className={css.diagnosticsDetail}>
                  <summary>{tt('diagnostics.requestLabel')}</summary>
                  <pre>{entry.requestExcerpt}</pre>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

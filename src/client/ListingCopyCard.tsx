/**
 * ListingCopyCard (task-20): generate marketplace listing copy (title /
 * selling points / description / keywords / specs) from the product-set draft
 * and render it with per-platform character limits. Failures are actionable:
 * a prose (unstructured) model answer is shown as a retry error, never as
 * listing copy; over-limit titles show the overage instead of silent success.
 */

import { useState } from 'react'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'
import type { ListingCopy, ListingCopyRequest, ListingCopyResult } from '../protocol.ts'

/** Per-platform title limits, mirrored host-side in listing-copy.ts. */
function titleLimit(platform: string): number {
  if (/amazon|亚马逊/i.test(platform)) return 200
  if (/淘宝|京东|taobao|jd\b/i.test(platform)) return 60
  return 60
}

/** Clamp a possibly-missing copy field to an array for rendering. */
function linesOf(value: string[] | undefined): string[] {
  return value ?? []
}

export function ListingCopyCard(props: {
  api: ImageGenApi
  /** The current product-set draft; only its stated facts reach the model. */
  draft: ListingCopyRequest
}) {
  const { api, draft } = props
  const [busy, setBusy] = useState(false)
  const [copy, setCopy] = useState<ListingCopy | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const canRun = draft.productName.trim() !== '' && !busy

  const run = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    setCopied(null)
    try {
      const result: ListingCopyResult = await api.listingCopy(draft)
      if (result.ok) {
        setCopy(result.copy)
        if (result.copy.title === undefined && result.copy.sellingPoints === undefined && result.copy.description === undefined && result.copy.keywords === undefined && result.copy.specs === undefined) {
          setNotice(tt('listing.empty'))
        }
      } else {
        setCopy(null)
        setNotice(result.message)
      }
    } catch (error) {
      setCopy(null)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
    } catch { /* clipboard unavailable; user can select manually */ }
  }

  const limit = titleLimit(draft.platform)
  const titleLength = copy?.title?.length ?? 0
  const titleOver = titleLength > limit
  const fullText = copy === null ? '' : [
    copy.title ?? '',
    ...linesOf(copy.sellingPoints),
    copy.description ?? '',
    ...linesOf(copy.keywords),
    ...linesOf(copy.specs?.map(spec => `${spec.name}: ${spec.value}`)),
  ].filter(line => line !== '').join('\n')

  return (
    <div className={css.ecommerceSection} data-listing-copy="">
      <header className={css.ecommerceCardHead}>
        <h3><span className={css.ecommerceSectionTitle}>{tt('listing.title')}</span><small className={css.ecommerceSectionHint}>{tt('listing.hint')}</small></h3>
        <button
          type="button"
          className={css.ecommerceAiButton}
          disabled={!canRun}
          title={draft.productName.trim() === '' ? tt('listing.needsName') : tt('listing.runHint')}
          onClick={() => { void run() }}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.4 3.6L13 6.5l-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z"/></svg>
          {busy ? tt('listing.running') : tt('listing.run')}
        </button>
      </header>
      {notice !== null ? (
        <p className={css.ecommerceCardNotice} role="alert" data-listing-notice="">{notice}</p>
      ) : null}
      {copy !== null ? (
        <div className={css.ecommerceStructureGrid} data-listing-copy-result="">
          {copy.title !== undefined ? (
            <div className={css.ecommerceSection}>
              <div className={css.ecommerceCardHead}>
                <strong>{tt('listing.copyTitle')}</strong>
                <span role="status" data-listing-title-count="" style={titleOver ? { color: 'var(--dsw-alias-label-danger, #e5484d)' } : undefined}>
                  {titleLength}/{limit}{titleOver ? ` ${tt('listing.over', { count: titleLength - limit })}` : ''}
                </span>
              </div>
              <textarea readOnly value={copy.title} rows={2} data-listing-copy-title="" />
              <button type="button" className={css.ecommerceAssetAdd} onClick={() => { void copyText('title', copy.title ?? '') }}>
                {copied === 'title' ? tt('listing.copied') : tt('listing.copy')}
              </button>
            </div>
          ) : null}
          {linesOf(copy.sellingPoints).length > 0 ? (
            <div className={css.ecommerceSection}>
              <div className={css.ecommerceCardHead}>
                <strong>{tt('listing.copyPoints')}</strong>
                <button type="button" className={css.ecommerceAssetAdd} onClick={() => { void copyText('points', linesOf(copy.sellingPoints).join('\n')) }}>
                  {copied === 'points' ? tt('listing.copied') : tt('listing.copy')}
                </button>
              </div>
              <ul>
                {linesOf(copy.sellingPoints).map((point, index) => <li key={index}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          {copy.description !== undefined ? (
            <div className={css.ecommerceSection}>
              <div className={css.ecommerceCardHead}>
                <strong>{tt('listing.copyDescription')}</strong>
                <button type="button" className={css.ecommerceAssetAdd} onClick={() => { void copyText('description', copy.description ?? '') }}>
                  {copied === 'description' ? tt('listing.copied') : tt('listing.copy')}
                </button>
              </div>
              <textarea readOnly value={copy.description} rows={6} data-listing-copy-description="" />
            </div>
          ) : null}
          {linesOf(copy.keywords).length > 0 ? (
            <div className={css.ecommerceSection}>
              <div className={css.ecommerceCardHead}>
                <strong>{tt('listing.copyKeywords')}</strong>
                <button type="button" className={css.ecommerceAssetAdd} onClick={() => { void copyText('keywords', linesOf(copy.keywords).join(', ')) }}>
                  {copied === 'keywords' ? tt('listing.copied') : tt('listing.copy')}
                </button>
              </div>
              <p>{linesOf(copy.keywords).join('、')}</p>
            </div>
          ) : null}
          {linesOf(copy.specs?.map(spec => `${spec.name}: ${spec.value}`)).length > 0 ? (
            <div className={css.ecommerceSection}>
              <div className={css.ecommerceCardHead}>
                <strong>{tt('listing.copySpecs')}</strong>
                <button type="button" className={css.ecommerceAssetAdd} onClick={() => { void copyText('specs', linesOf(copy.specs?.map(spec => `${spec.name}: ${spec.value}`)).join('\n')) }}>
                  {copied === 'specs' ? tt('listing.copied') : tt('listing.copy')}
                </button>
              </div>
              <ul>
                {(copy.specs ?? []).map((spec, index) => <li key={index}>{spec.name}: {spec.value}</li>)}
              </ul>
            </div>
          ) : null}
          {fullText !== '' ? (
            <button type="button" className={css.ecommerceAssetAdd} data-listing-copy-all="" onClick={() => { void copyText('all', fullText) }}>
              {copied === 'all' ? tt('listing.copied') : tt('listing.copyAll')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

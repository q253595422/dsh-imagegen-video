import { useEffect, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import type { CanvasAssetRef, CanvasSlidePreview } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { useFilePreview } from './CanvasFilePreview.tsx'
import { tt } from './helpers.ts'
import css from './ppt-workspace.module.css'

function SlideContent({ slide, compact = false }: { slide: CanvasSlidePreview; compact?: boolean }) {
  return <div className={css.slideContent} data-compact={compact || undefined}>
    {slide.title ? <h2>{slide.title}</h2> : null}
    {slide.images.length ? <div className={css.slideImages}>{slide.images.map((image, index) => <img key={index} src={image.data} alt="" loading="lazy" />)}</div> : null}
    <div className={css.slideLines}>{(compact ? slide.lines.slice(0, 4) : slide.lines).map((line, index) => <p key={index}>{line}</p>)}</div>
  </div>
}

/** Read the generated PPTX itself, never use its input images as slide previews. */
export function PptDeckPreview({ api, asset, onExpand }: { api: ImageGenApi; asset: CanvasAssetRef; onExpand?: () => void }) {
  const { preview, error, reload } = useFilePreview(api, asset, true)
  const [page, setPage] = useState(0)
  const slides = preview?.kind === 'slides' ? preview.slides : []
  const index = Math.min(page, Math.max(0, slides.length - 1))
  const slide = slides[index]
  useEffect(() => { setPage(0) }, [asset.assetId])
  return <div className={css.deckViewer} data-ppt-deck="">
    <header className={css.viewerHeader}>
      <span className={css.pptBadge}>P</span><div className={css.viewerTitle}><strong title={asset.name}>{asset.name || 'PowerPoint'}</strong><small>{slides.length ? tt('ppt.pages', { count: slides.length }) : 'PPTX'}</small></div>
      <a className={css.download} href={asset.url} download={asset.name}>{tt('ppt.downloadDeck')}</a>
      {onExpand ? <button type="button" data-ppt-preview="" aria-label={tt('ppt.expand')} title={tt('ppt.expand')} onClick={onExpand}><Maximize2 size={16} aria-hidden="true" /></button> : null}
    </header>
    {slide ? <>
      <div className={css.viewerBody}>
        <nav className={css.filmstrip} aria-label={tt('ppt.pageNavigation')}>
          {slides.map((item, at) => <button type="button" key={at} data-ppt-page={at + 1} aria-label={tt('ppt.goToPage', { page: at + 1 })} aria-current={at === index ? 'page' : undefined} onClick={() => setPage(at)}>
            <div className={css.miniSlide}><SlideContent slide={item} compact /></div><span>{at + 1}</span>
          </button>)}
        </nav>
        <div className={css.slideStage} data-ppt-slide={index + 1}><div className={css.slidePaper}><SlideContent slide={slide} /></div></div>
      </div>
      <footer className={css.viewerFooter}><small>{tt('ppt.contentPreview')}</small><div className={css.pageControls}>
        <button type="button" aria-label={tt('ppt.previousPage')} disabled={index === 0} onClick={() => setPage(index - 1)}>‹</button>
        <span aria-live="polite">{index + 1} / {slides.length}</span>
        <button type="button" aria-label={tt('ppt.nextPage')} disabled={index >= slides.length - 1} onClick={() => setPage(index + 1)}>›</button>
      </div><span className={css.fitLabel}>{tt('ppt.fitWindow')}</span></footer>
      {preview?.kind === 'slides' && preview.truncated ? <p className={css.previewNotice}>{tt('canvas.preview.slidesTruncated', { count: slides.length })}</p> : null}
    </> : <div className={css.viewerPlaceholder} role="status"><span className={css.fileIcon}>PPTX</span><p>{error ? tt('canvas.preview.failed', { message: error }) : preview ? tt('canvas.preview.empty') : tt('canvas.skills.filePreviewLoading')}</p>{error ? <button type="button" onClick={reload}>{tt('canvas.preview.retry')}</button> : null}</div>}
  </div>
}

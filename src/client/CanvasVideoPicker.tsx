/**
 * Canvas 「添加视频」 picker — the video counterpart of {@link ImagePicker}.
 *
 * Images can be added to the canvas from the dock menu (local upload / asset
 * library / history / AI generate). Video could only be added from the sidebar
 * panel, so a user working on the canvas had no way to put a clip in front of
 * them: the dock had no video entry at all. This dialog is that entry point.
 *
 * It deliberately has no generate tab — the canvas composer already generates
 * video (wire an image into a config node, switch the composer to 视频).
 *
 * FROZEN SURFACE (both the wiring and the suites depend on it):
 *   [data-video-picker]        root element of the dialog
 *   [data-video-picker-close]  close button
 *   [data-video-tab="upload"|"history"|"gallery"]
 *   [data-video-card]          one clip card, with data-clip-url on the card
 *   [data-video-add]           "add to canvas" action
 *
 * This file is owned by one team member; the wiring that mounts it lives in
 * `CanvasWorkspace.tsx` and is owned by another. Keep the props signature
 * byte-stable — the wiring compiles against it.
 */

import { useState } from 'react'
import type { CanvasAssetRef, HistoryEntry } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import css from './canvas-video-picker.module.css'

export interface CanvasVideoPickerProps {
  api: ImageGenApi
  /** Gallery entries from the panel; the ones with a `video` are clips. */
  gallery: HistoryEntry[]
  onClose: () => void
  /**
   * Add one *served clip* to the canvas (video store or gallery store URL).
   * The node references the URL; no bytes are copied.
   */
  onAddClip: (clip: { url: string; mime: string; duration?: number; title?: string }) => void
  /**
   * Add one uploaded *canvas asset* (a local file the browser just sent to the
   * host). This is a file-node path, NOT a clip: a canvas asset lives in the
   * asset store, which the stitcher cannot read, so it cannot be composed.
   * Kept separate from `onAddClip` on purpose — see the parity contract §5.1.
   */
  onAddAsset: (asset: CanvasAssetRef) => void
}

/**
 * PLACEHOLDER SHELL — replaced by the real dialog in this same file.
 *
 * It already renders a closable, correctly-attributed dialog so the wiring and
 * its smoke case can land in parallel without waiting for the full picker.
 */
export function CanvasVideoPicker(props: CanvasVideoPickerProps): React.JSX.Element {
  const [tab, setTab] = useState<'upload' | 'history' | 'gallery'>('history')
  void props.api
  void props.gallery
  void props.onAddClip
  return <div className={css.backdrop} role="dialog" aria-modal="true" data-canvas-no-zoom="" data-video-picker="">
    <section className={css.dialog}>
      <header className={css.header}>
        <strong>{tt('canvas.videoPicker')}</strong>
        <button type="button" data-video-picker-close="" aria-label={tt('canvas.close')} title={tt('canvas.close')} onClick={props.onClose}>×</button>
      </header>
      <nav className={css.tabs} role="tablist">
        {(['upload', 'history', 'gallery'] as const).map(item => <button
          key={item}
          type="button"
          role="tab"
          data-video-tab={item}
          aria-selected={tab === item}
          data-active={tab === item ? '' : undefined}
          onClick={() => { setTab(item) }}
        >{item === 'upload' ? tt('canvas.videoPickerUpload') : item === 'history' ? tt('canvas.videoPickerHistory') : tt('canvas.videoPickerGallery')}</button>)}
      </nav>
      <div className={css.body}>
        <p className={css.empty}>{tt('canvas.videoPickerEmpty')}</p>
      </div>
    </section>
  </div>
}

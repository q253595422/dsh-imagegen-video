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
 *   [data-video-picker-empty]  empty state of the clip tabs. The `picker`
 *                              prefix is load-bearing: `CanvasWorkspace.tsx`
 *                              already owns this anchor WITHOUT the prefix, for
 *                              the video NODE placeholder, and it mounts first —
 *                              the unprefixed name would silently match that
 *                              element instead (parity contract §5.1)
 *
 * THREE TABS, IN THIS ORDER:
 *
 *   upload   local file (`accept="video/*"`) + drag-and-drop. The file goes to
 *            `api.canvasFileUpload()` and the resulting CanvasAssetRef is handed
 *            to `onAddAsset` — see the note on that prop.
 *   history  clips of the video store; the component fetches them itself with
 *            `api.videoHistoryList()`, the caller does not pass them.
 *   gallery  `props.gallery` entries that carry a `.video` reference.
 *
 * `history` and `gallery` add *served clips* through `onAddClip`, so the canvas
 * gets a referenced video node (no bytes copied). Clicking a card adds it right
 * away — the dialog has no multi-select confirm step, so there is no selection
 * state to synchronise with the caller.
 *
 * This file is owned by one team member; the wiring that mounts it lives in
 * `CanvasWorkspace.tsx` and is owned by another. Keep the props signature
 * byte-stable — the wiring compiles against it.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CanvasAssetRef, HistoryEntry, VideoHistoryEntry } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
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

type VideoPickerTab = 'upload' | 'history' | 'gallery'

/** One clip row, normalised across the two stores that can serve clips. */
interface PickerClip {
  key: string
  url: string
  mime: string
  duration?: number
  title: string
  meta: string
  poster?: string
}

/** `12s` for a positive, finite duration; empty when there is nothing to say. */
function durationText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  return `${Math.round(seconds)}s`
}

/** Clips referenced by the gallery entries (one per favorited clip). */
function galleryClips(entries: HistoryEntry[]): PickerClip[] {
  const clips: PickerClip[] = []
  for (const entry of entries) {
    const video = entry.video
    if (video === undefined) continue
    clips.push({
      key: `gallery:${entry.id}`,
      url: video.url,
      mime: video.mime,
      ...video.duration === undefined ? {} : { duration: video.duration },
      title: entry.prompt !== '' ? entry.prompt : tt('canvas.untitledWork'),
      meta: [entry.model, durationText(video.duration)].filter(part => part !== '').join(' · '),
    })
  }
  return clips
}

/** Clips of the video store, one row per rendered file (host order kept). */
function historyClips(entries: VideoHistoryEntry[]): PickerClip[] {
  const clips: PickerClip[] = []
  for (const entry of entries) {
    entry.videos.forEach((video, index) => {
      // The per-file duration is what was probed; `seconds` is the requested
      // length, used only as a fallback when the probe found nothing.
      const duration = video.duration ?? (entry.seconds > 0 ? entry.seconds : undefined)
      clips.push({
        key: `history:${entry.id}:${index}`,
        url: video.url,
        mime: video.mime,
        ...duration === undefined ? {} : { duration },
        title: entry.prompt !== '' ? entry.prompt : tt('canvas.untitledWork'),
        meta: [entry.model, entry.resolution, durationText(duration)].filter(part => part !== '').join(' · '),
        ...video.poster === undefined ? {} : { poster: video.poster },
      })
    })
  }
  return clips
}

/** The `onAddClip` payload for one row (no undefined-valued keys). */
function clipPayload(clip: PickerClip): { url: string; mime: string; duration?: number; title?: string } {
  return {
    url: clip.url,
    mime: clip.mime,
    ...clip.duration === undefined ? {} : { duration: clip.duration },
    title: clip.title,
  }
}

/** A dropped or picked file that a video node could plausibly play. */
function isVideoFile(file: File): boolean {
  // `type` is authoritative when the browser knows it; some containers arrive
  // with an empty type, so fall back to the extension rather than dropping the
  // file on the floor.
  return file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv)$/i.test(file.name)
}

/**
 * The three-tab 「添加视频」 dialog.
 *
 * `upload` hands a `CanvasAssetRef` to `onAddAsset` instead of a clip: an
 * uploaded file lands in the canvas asset store, which is not the video store,
 * so it becomes a file node and cannot be composed (parity contract §5.1).
 * `history` and `gallery` both hand served clip URLs to `onAddClip`.
 */
export function CanvasVideoPicker(props: CanvasVideoPickerProps): React.JSX.Element {
  const { api, gallery, onClose, onAddClip, onAddAsset } = props
  // `history` is the default tab: the clips a user most often wants are the
  // ones they just generated, and it needs no file dialog to reach.
  const [tab, setTab] = useState<VideoPickerTab>('history')
  const [history, setHistory] = useState<VideoHistoryEntry[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)

  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      setHistory(await api.videoHistoryList())
      setHistoryError(null)
    } catch (caught) {
      setHistory([])
      setHistoryError(errorMessage(caught))
    }
  }, [api])

  // Fetched on mount rather than on first visit to the tab: `history` is the
  // default tab, so a lazy fetch would only push the first paint later.
  useEffect(() => { void loadHistory() }, [loadHistory])

  const clips = tab === 'gallery' ? galleryClips(gallery) : historyClips(history)

  const addClip = useCallback((clip: PickerClip): void => {
    onAddClip(clipPayload(clip))
    setAdded(previous => previous + 1)
  }, [onAddClip])

  const uploadFile = useCallback((file: File): void => {
    setUploading(true)
    setUploadError(null)
    void (async () => {
      try {
        // The asset is NOT a clip: it goes out through `onAddAsset`, never
        // through `onAddClip` (parity contract §5.1).
        onAddAsset(await api.canvasFileUpload(file))
      } catch (caught) {
        setUploadError(errorMessage(caught))
      } finally {
        setUploading(false)
      }
    })()
  }, [api, onAddAsset])

  const takeFile = useCallback((candidate: File | undefined): void => {
    if (candidate === undefined || !isVideoFile(candidate)) return
    uploadFile(candidate)
  }, [uploadFile])

  const empty = clips.length === 0
  // A FAILED listing is not an empty one: `loadHistory` clears `history` on
  // error, so `empty` alone cannot tell "there are no clips" from "we do not
  // know whether there are any". Printing the empty copy in the second case
  // asserts something false, so it is gated on the absence of an error; the
  // error line and its retry button render on their own.
  const showEmptyCopy = empty && !(tab === 'history' && historyError !== null)

  return <div className={css.backdrop} role="dialog" aria-modal="true" data-canvas-no-zoom="" data-video-picker="">
    <section className={css.dialog}>
      <header className={css.header}>
        <strong>{tt('canvas.videoPicker')}</strong>
        <button type="button" className={css.close} data-video-picker-close="" aria-label={tt('canvas.close')} title={tt('canvas.close')} onClick={onClose}>×</button>
      </header>
      <nav className={css.tabs} role="tablist">
        {(['upload', 'history', 'gallery'] as const).map(item => <button
          key={item}
          type="button"
          role="tab"
          className={css.tab}
          data-video-tab={item}
          aria-selected={tab === item}
          data-active={tab === item ? '' : undefined}
          onClick={() => { setTab(item) }}
        >{item === 'upload' ? tt('canvas.videoPickerUpload') : item === 'history' ? tt('canvas.videoPickerHistory') : tt('canvas.videoPickerGallery')}</button>)}
      </nav>
      <div className={css.body}>
        {tab === 'upload' ? <>
          <label
            className={css.drop}
            data-video-upload=""
            onDragOver={event => { event.preventDefault() }}
            onDrop={event => {
              event.preventDefault()
              if (uploading) return
              // One file per pick: `onAddAsset` takes a single asset, and the
              // caller adds then dismisses the dialog, so a batch would lose all
              // but the first file.
              takeFile([...(event.dataTransfer.files ?? [])].find(isVideoFile))
            }}
          >
            <input
              type="file"
              accept="video/*"
              disabled={uploading}
              onChange={event => {
                const file = [...(event.target.files ?? [])].find(isVideoFile)
                // Cleared so re-picking the same file fires `change` again.
                event.target.value = ''
                takeFile(file)
              }}
            />
            <strong>{uploading ? `${tt('canvas.videoPickerUpload')}…` : tt('canvas.videoPickerUpload')}</strong>
          </label>
          {uploadError !== null ? <p className={css.errorLine} data-video-upload-error="">{tt('canvas.videoUploadFailed', { message: uploadError })}</p> : null}
        </> : null}
        {tab !== 'upload' && !empty ? <div className={css.grid} role="list">
          {clips.map(clip => <div
            key={clip.key}
            className={css.card}
            role="listitem"
            data-video-card=""
            data-clip-url={clip.url}
            onClick={() => { addClip(clip) }}
          >
            <video src={clip.url} preload="metadata" muted playsInline poster={clip.poster} />
            <span className={css.cardTitle}>{clip.title}</span>
            {clip.meta !== '' ? <span className={css.cardMeta}>{clip.meta}</span> : null}
            <button
              type="button"
              className={css.cardAdd}
              data-video-add=""
              onClick={event => { event.stopPropagation(); addClip(clip) }}
            >{tt('canvas.videoPickerAdd')}</button>
          </div>)}
        </div> : null}
        {tab !== 'upload' && showEmptyCopy ? <>
          <p className={css.empty} data-video-picker-empty="">{tt('canvas.videoPickerEmpty')}</p>
        </> : null}
        {/* A failed listing must be visible, and it must NOT masquerade as "no
            clips": the copy above asserts there are none, which a failed read
            does not establish. Rendered on its own, not nested under `empty`. */}
        {tab === 'history' && historyError !== null ? <>
          <p className={css.errorLine} data-video-load-error="">{tt('canvas.videoLoadFailed', { message: historyError })}</p>
          <p className={css.empty}><button type="button" className={css.primary} data-video-reload="" onClick={() => { void loadHistory() }}>{tt('canvas.videoRetry')}</button></p>
        </> : null}
        {added > 0 ? <footer className={css.footer}><span data-video-count="">{tt('canvas.videoPicked', { count: added })}</span></footer> : null}
      </div>
    </section>
  </div>
}

/**
 * Video studio tab: text-to-video, image-to-video, first/last-frame and
 * multi-reference generation.
 *
 * Kept as its own module rather than folded into `ImageGenPanel.tsx`: video
 * differs from image generation in ways that would tangle the existing panel —
 * it is asynchronous (submit → poll for minutes), its result is a served file
 * rather than inline base64, and it has its own mode/parameter vocabulary. The
 * panel owns this subtree and passes the same `api` + `config` it already has.
 *
 * Polling policy: the host queue keeps running after the page closes, so the
 * tab resumes any in-flight task it finds on mount and otherwise polls only
 * while something is actually running.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ImageGenApi, ImageGenApiError } from './api.ts'
import { tt } from './helpers.ts'
import { videoModelOptions, type ImageGenConfig, type ImageGenScope } from './settings-scope.ts'
import type { VideoGenerateRequest, VideoHistoryEntry, VideoMode, VideoTask, VideoTaskSummary } from '../protocol.ts'
import { VIDEO_ASPECT_RATIOS, VIDEO_DURATIONS, type VideoResolution } from '../protocol.ts'
import { describeVideoModel, isLikelyVideoModelId } from '../video-model-catalog.ts'
import { Select } from './Select.tsx'
import { DiagnosticsButton, DiagnosticsPanel } from './DiagnosticsPanel.tsx'
import type { ImageGenKey } from './locales.ts'
import { onTablistKeyDown, tabIndexFor } from './tablist.ts'
import css from './panel.module.css'

/** How often the tab asks the host for task state while something runs. */
const POLL_INTERVAL_MS = 5_000

/** Restrict an extension to the image formats the host accepts as a frame. */
const FRAME_ACCEPT = 'image/png,image/jpeg,image/webp'

/** Resolution tiers offered in the UI (narrowed per model by the engine). */
const RESOLUTIONS: VideoResolution[] = ['480P', '720P', '1080P']

/** One picked reference frame staged in the panel. */
interface FrameDraft {
  dataUrl: string
  name: string
}

/** Read one file into a data URL, rejecting anything the host cannot send. */
function readFrame(file: File): Promise<FrameDraft> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      reject(new Error(tt('video.requiredImage')))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => { reject(new Error(tt('image.readFailed'))) }
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (result === '') { reject(new Error(tt('image.readFailed'))); return }
      resolve({ dataUrl: result, name: file.name })
    }
    reader.readAsDataURL(file)
  })
}

/** Human elapsed time for a running render. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export interface VideoPanelProps {
  api: ImageGenApi
  scope: ImageGenScope
  config: ImageGenConfig | undefined
  /** The panel is visible; polling pauses while hidden. */
  active?: boolean
  /**
   * Video queue summaries from the parent's single polling loop. Passed in so
   * the studio tab and the canvas never run two competing pollers and always
   * agree on task state.
   */
  tasks?: VideoTaskSummary[]
  /**
   * Re-read the queue after this tab mutates it (submit / cancel / retry).
   * Required in controlled mode: when the parent supplies `tasks` it also owns
   * the single poller, so the request has to travel up instead of starting a
   * second loop here. Without it a render the user just submitted stays
   * invisible for a whole poll cycle.
   */
  onRefreshTasks?: () => void
  /**
   * Attach one finished clip to the current chat draft. Supplied by the parent
   * because it owns the conversation/session seams.
   */
  onAddToConversation?: (url: string, actionKey: string) => Promise<void>
  /** Which clip is mid-attachment, so the button can show progress. */
  conversationBusyKey?: string | null
  /**
   * Drop one finished clip onto the infinite canvas. Supplied by the parent
   * because it owns the workspace switch and the canvas import request.
   *
   * The clip is taken BY REFERENCE (the host already persists and serves it),
   * never copied into the canvas asset store -- the same contract the result
   * board and the history sidebar use.
   */
  onAddToCanvas?: (url: string, mime?: string, duration?: number, title?: string) => void
}

export function VideoPanel(props: VideoPanelProps) {
  const { api, config, active = true } = props
  const options = useMemo(() => videoModelOptions(config), [config])
  const videoModels = options.models
  const [mode, setMode] = useState<VideoMode>('text')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [resolution, setResolution] = useState<VideoResolution>('720P')
  const [seconds, setSeconds] = useState<number>(5)
  const [reference, setReference] = useState<FrameDraft | null>(null)
  const [firstFrame, setFirstFrame] = useState<FrameDraft | null>(null)
  const [lastFrame, setLastFrame] = useState<FrameDraft | null>(null)
  // Task state is owned either by this tab (standalone) or by the parent (a
  // single shared poller). `refreshTasks` is the one way mutations push a new
  // list, so neither owner can end up with a stale fork of the other's state.
  const [localTasks, setLocalTasks] = useState<VideoTaskSummary[]>([])
  const controlled = props.tasks !== undefined
  const tasks = props.tasks ?? localTasks
  const refreshTasks = useCallback((): void => {
    // Controlled: the parent owns the list, so ask it to re-read rather than
    // fetching here -- a fetch here would be a second poller, and the two
    // lists could drift apart.
    if (controlled) { props.onRefreshTasks?.(); return }
    void api.videoTaskList().then(setLocalTasks).catch(() => { /* transient */ })
  }, [api, controlled, props.onRefreshTasks])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** #38 video parity: the retained record of upstream attempts. */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** The clip (and the run that made it) shown in the full-screen player. */
  const [previewClip, setPreviewClip] = useState<{ url: string; mime: string; duration?: number; title: string } | null>(null)

  const referenceInput = useRef<HTMLInputElement | null>(null)
  const firstInput = useRef<HTMLInputElement | null>(null)
  const lastInput = useRef<HTMLInputElement | null>(null)

  // Keep the selected model valid as channels change (a channel may be removed
  // or its video catalog emptied while the panel stays open).
  useEffect(() => {
    if (videoModels.length === 0) { setModel(''); return }
    if (!videoModels.includes(model)) setModel(videoModels[0]!)
  }, [videoModels, model])

  const family = model === '' ? 'unknown' : describeVideoModel(model).family
  const unknownModel = model !== '' && describeVideoModel(model).family === 'unknown'
  const catalog = describeVideoModel(model)

  // Modes this model actually supports, so the picker cannot offer a mode the
  // provider will reject (e.g. wan2.2-t2v is text-only).
  const availableModes = useMemo<VideoMode[]>(() => {
    if (model === '') return ['text']
    const supported = catalog.modes
    return supported.length === 0 ? ['text'] : supported
  }, [model, catalog.modes])

  useEffect(() => {
    if (!availableModes.includes(mode)) setMode(availableModes[0] ?? 'text')
  }, [availableModes, mode])

  // Aspect ratios the family accepts; fall back to the panel's full list.
  const ratios = catalog.aspectRatios.length > 0 ? catalog.aspectRatios : [...VIDEO_ASPECT_RATIOS]
  useEffect(() => {
    if (!ratios.includes(aspectRatio)) setAspectRatio(ratios[0] ?? '16:9')
  }, [ratios, aspectRatio])

  useEffect(() => {
    if (catalog.resolutions.length > 0 && !catalog.resolutions.includes(resolution)) {
      setResolution(catalog.resolutions[0]!)
    }
  }, [catalog.resolutions, resolution])

  // Poll the host queue. The task lives host-side, so this also picks up a
  // render started before the page was reloaded.
  useEffect(() => {
    // When the parent owns polling, this tab must not start a second loop.
    if (!active || props.tasks !== undefined) return
    let disposed = false
    const tick = (): void => {
      void api.videoTaskList().then(next => { if (!disposed) setLocalTasks(next) }).catch(() => { /* transient */ })
    }
    tick()
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [api, active, props.tasks])

  // Keyboard dismissal for the full-screen clip. The studio's other overlay
  // gestures (double-click a row, the expand button) are pointer-only, so
  // without this the only way out was the × — and Esc, which the panel around
  // it treats as "close the topmost thing", did nothing here at all.
  useEffect(() => {
    if (previewClip === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setPreviewClip(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [previewClip])

  // A seconds counter for running renders only.
  const anyRunning = tasks.some(task => task.status === 'running' || task.status === 'queued')
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [anyRunning])

  // Every image-bearing mode needs its frame before submit. `reference` was
  // missing from this guard while the hint text already told the user it needed
  // one, so the button stayed enabled and the provider rejected the call.
  const canGenerate = model !== '' && !unknownModel && prompt.trim() !== '' && !busy
    && (mode !== 'image' || reference !== null)
    && (mode !== 'reference' || reference !== null)
    && (mode !== 'keyframe' || firstFrame !== null)

  const buildRequest = (): VideoGenerateRequest => ({
    mode,
    model,
    prompt: prompt.trim(),
    aspectRatio,
    resolution,
    seconds,
    ...mode === 'image' && reference !== null ? { image: reference.dataUrl, refName: reference.name } : {},
    ...mode === 'reference' && reference !== null ? { image: reference.dataUrl, refName: reference.name } : {},
    ...mode === 'keyframe' && firstFrame !== null ? { firstFrame: firstFrame.dataUrl } : {},
    ...mode === 'keyframe' && lastFrame !== null ? { lastFrame: lastFrame.dataUrl } : {},
  })

  const generate = (): void => {
    if (!canGenerate) return
    setBusy(true)
    setError(null)
    // Fire-and-poll: the host queue owns the render, so a slow upstream never
    // blocks the tab and the browser can close without losing the job.
    void api.videoTaskSubmit(buildRequest())
      .then(() => { refreshTasks() })
      .catch(err => { setError(err instanceof ImageGenApiError ? err.message : String(err)) })
      .finally(() => { setBusy(false) })
  }

  const pickFrame = (target: 'reference' | 'first' | 'last', file: File | undefined): void => {
    if (file === undefined) return
    void readFrame(file).then(draft => {
      if (target === 'reference') setReference(draft)
      else if (target === 'first') setFirstFrame(draft)
      else setLastFrame(draft)
      setError(null)
    }).catch(err => { setError(err instanceof Error ? err.message : String(err)) })
  }

  const cancel = (id: string): void => {
    // A failed cancel/retry used to be swallowed entirely, so the row simply
    // did not change and the user pressed the button again. The composer
    // reports its own failures through `error`; these are the same class of
    // failure and belong in the same place.
    void api.videoTaskCancel(id).then(() => { refreshTasks() })
      .catch(err => { setError(err instanceof ImageGenApiError ? err.message : String(err)) })
  }

  const retry = (id: string): void => {
    void api.videoTaskRetry(id).then(() => { refreshTasks() })
      .catch(err => { setError(err instanceof ImageGenApiError ? err.message : String(err)) })
  }

  /**
   * The finished clip's shape, taken from the queue summary. `resultVideo` is
   * what the host sends for a completed render (url + mime + duration); a bare
   * `resultUrl` is the fallback for a task the host has already evicted from
   * its richer list, so the actions still work with sensible defaults.
   *
   * Returns undefined for an empty url as well as a missing one: a task the
   * host has finished but not yet given a served url must not render a player
   * with an empty src, nor actions that would push an empty url downstream.
   */
  const clipMetaOf = (task: VideoTaskSummary): { url: string; mime: string; duration?: number } | undefined => {
    const url = task.resultVideo?.url ?? task.resultUrl
    if (url === undefined || url === '') return undefined
    const duration = task.resultVideo?.duration
    return { url, mime: task.resultVideo?.mime ?? 'video/mp4', ...duration === undefined ? {} : { duration } }
  }

  const frameHint = mode === 'image' || mode === 'reference' ? tt('video.requiredImage')
    : mode === 'keyframe' ? tt('video.requiredFirstFrame') : ''

  if (videoModels.length === 0) {
    return (
      <div className={css.videoWorkspace}>
        <div className={css.videoEmpty}>
          <h3>{tt('video.noModel')}</h3>
          <p>{tt('video.noModelHint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={css.videoWorkspace}>
      <header className={css.videoToolbar}>
        <div className={css.videoModes} role="tablist" aria-label={tt('mode.video')}>
          {availableModes.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              className={css.videoModeButton}
              data-active={mode === candidate ? '' : undefined}
              tabIndex={tabIndexFor(mode === candidate)}
              onKeyDown={event => { onTablistKeyDown(event, { count: availableModes.length, index, select: next => { setMode(availableModes[next]!) } }) }}
              onClick={() => { setMode(candidate) }}
            >
              {tt(`video.mode.${candidate}`)}
            </button>
          ))}
        </div>
      </header>

      {/* #38 video parity: the retained upstream attempts are the same record
          the image studio opens. The entry rides the ALWAYS-rendered toolbar
          rather than the run list, because a submit that never reached the
          provider leaves no task row at all -- which is exactly the report
          this panel exists to answer. */}
      <div className={css.videoDiagnosticsRow}>
        <DiagnosticsButton open={diagnosticsOpen} onToggle={() => { setDiagnosticsOpen(open => !open) }} />
      </div>

      <div className={css.videoBody}>
        <section className={css.videoComposer}>
          <label className={css.videoLabel} htmlFor="dsh-video-prompt">{tt('video.promptTitle')}</label>
          <textarea
            id="dsh-video-prompt"
            className={css.videoPrompt}
            value={prompt}
            onChange={event => { setPrompt(event.target.value) }}
            placeholder={tt('video.promptPlaceholder')}
            rows={5}
          />

          {mode !== 'text' ? (
            <div className={css.videoFrames}>
              <div className={css.videoFrameSlot}>
                <span className={css.videoLabel}>
                  {mode === 'keyframe' ? tt('video.firstFrame') : tt('video.reference')}
                </span>
                {mode === 'keyframe' ? (
                  firstFrame === null
                    ? <button type="button" className={css.videoPick} onClick={() => { firstInput.current?.click() }}>{tt('video.pickImage')}</button>
                    : (
                      <div className={css.videoFramePreview}>
                        <img src={firstFrame.dataUrl} alt={firstFrame.name} />
                        <button type="button" onClick={() => { setFirstFrame(null) }}>{tt('video.clearImage')}</button>
                      </div>
                    )
                ) : (
                  reference === null
                    ? <button type="button" className={css.videoPick} onClick={() => { referenceInput.current?.click() }}>{tt('video.pickImage')}</button>
                    : (
                      <div className={css.videoFramePreview}>
                        <img src={reference.dataUrl} alt={reference.name} />
                        <button type="button" onClick={() => { setReference(null) }}>{tt('video.clearImage')}</button>
                      </div>
                    )
                )}
                <input
                  ref={mode === 'keyframe' ? firstInput : referenceInput}
                  type="file"
                  accept={FRAME_ACCEPT}
                  hidden
                  onChange={event => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    pickFrame(mode === 'keyframe' ? 'first' : 'reference', file)
                  }}
                />
              </div>

              {mode === 'keyframe' ? (
                <div className={css.videoFrameSlot}>
                  <span className={css.videoLabel}>{tt('video.lastFrame')}</span>
                  {lastFrame === null
                    ? <button type="button" className={css.videoPick} onClick={() => { lastInput.current?.click() }}>{tt('video.pickImage')}</button>
                    : (
                      <div className={css.videoFramePreview}>
                        <img src={lastFrame.dataUrl} alt={lastFrame.name} />
                        <button type="button" onClick={() => { setLastFrame(null) }}>{tt('video.clearImage')}</button>
                      </div>
                    )}
                  <input
                    ref={lastInput}
                    type="file"
                    accept={FRAME_ACCEPT}
                    hidden
                    onChange={event => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      pickFrame('last', file)
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {frameHint !== '' ? <p className={css.videoHint}>{frameHint}</p> : null}

          <div className={css.videoParams}>
            <div className={css.videoParam}>
              <span className={css.videoLabel}>{tt('video.model')}</span>
              <Select className={css.videoSelect} value={model} onChange={setModel} aria-label={tt('video.model')}>
                {options.groups.map(group => (
                  group.models.length === 0 ? null : (
                    <optgroup key={group.id || 'default'} label={group.name}>
                      {group.models.map(alias => <option key={`${group.id}:${alias}`} value={alias}>{alias}</option>)}
                    </optgroup>
                  )
                ))}
              </Select>
              {unknownModel ? <span className={css.videoWarn}>{tt('video.unsupportedModel')}</span> : null}
            </div>

            <div className={css.videoParam}>
              <span className={css.videoLabel}>{tt('video.aspectRatio')}</span>
              <div className={css.videoPills}>
                {ratios.map(ratio => (
                  <button key={ratio} type="button" data-active={aspectRatio === ratio ? '' : undefined} onClick={() => { setAspectRatio(ratio) }}>{ratio}</button>
                ))}
              </div>
            </div>

            <div className={css.videoParam}>
              <span className={css.videoLabel}>{tt('video.resolution')}</span>
              <div className={css.videoPills}>
                {catalog.resolutions.map(tier => (
                  <button key={tier} type="button" data-active={resolution === tier ? '' : undefined} onClick={() => { setResolution(tier) }}>{tier}</button>
                ))}
              </div>
            </div>

            <div className={css.videoParam}>
              <span className={css.videoLabel}>{tt('video.seconds')}</span>
              <div className={css.videoPills}>
                {VIDEO_DURATIONS.map(value => (
                  <button key={value} type="button" data-active={seconds === value ? '' : undefined} onClick={() => { setSeconds(value) }}>{value}</button>
                ))}
              </div>
            </div>
          </div>

          {error !== null ? <p className={css.videoError} role="alert">{error}</p> : null}

          <div className={css.videoActions}>
            <button type="button" className={css.videoGenerate} disabled={!canGenerate} onClick={generate}>
              {busy ? tt('video.generating') : tt('video.generate')}
            </button>
            <span className={css.videoHint}>{tt('video.pollNote')}</span>
          </div>
        </section>

        {tasks.length === 0 ? null : (
        <section className={css.videoResults}>
          <header className={css.videoResultsHead}>
            <h3>{tt('video.tasksTitle')}</h3>
          </header>
          <ul className={css.videoTaskList}>
              {tasks.map(task => (
                <li key={task.id} className={css.videoTask} data-status={task.status}>
                  <div className={css.videoTaskHead}>
                    <span className={css.videoTaskModel}>{task.request.model}</span>
                    <span className={css.videoTaskStatus}>
                      {tt(`video.status.${task.status}` as ImageGenKey)}
                    </span>
                    {task.status === 'running' || task.status === 'queued' ? (
                      <>
                        <span className={css.videoTaskElapsed}>{tt('video.elapsed', { time: formatElapsed(now - (task.startedAt ?? task.createdAt)) })}</span>
                        <button type="button" onClick={() => { cancel(task.id) }}>{tt('video.cancel')}</button>
                      </>
                    ) : null}
                    {task.status === 'failed' || task.status === 'cancelled' ? (
                      <button type="button" onClick={() => { retry(task.id) }}>{tt('video.retry')}</button>
                    ) : null}
                  </div>
                  <p className={css.videoTaskPrompt} title={task.request.prompt}>{task.request.prompt}</p>
                  {task.status === 'failed' && task.error !== undefined ? <p className={css.videoError}>{task.error}</p> : null}
                  {(() => {
                    // One clip shape drives the player and every action, so an
                    // empty url can never show a player without working actions
                    // (or the reverse).
                    const clip = clipMetaOf(task)
                    // A completed task with no servable url is not "nothing to
                    // show": the row used to collapse to a bare status pill, so
                    // the user could not tell whether the clip was still coming,
                    // had been evicted from the host's 30-entry history, or had
                    // simply failed to attach. Say which it is and offer the
                    // refresh, instead of an empty card.
                    if (clip === undefined) {
                      return task.status === 'completed' && task.resultAvailable
                        ? <p className={css.videoHint} data-video-result-missing="">{tt('video.resultMissing')}</p>
                        : null
                    }
                    const title = task.request.prompt
                    return <>
                      <video
                        className={css.videoPlayer}
                        controls
                        preload="metadata"
                        src={clip.url}
                        // Double-click opens the clip large, the same gesture the
                        // canvas uses on a video node.
                        onDoubleClick={() => { setPreviewClip({ ...clip, title }) }}
                      />
                      <button
                        type="button"
                        data-video-expand=""
                        title={tt('canvas.videoPreview')}
                        onClick={() => { setPreviewClip({ ...clip, title }) }}
                      >
                        {tt('canvas.videoPreview')}
                      </button>
                      {props.onAddToCanvas !== undefined ? <button
                        type="button"
                        data-video-add-canvas=""
                        title={tt('canvas.addToCanvas')}
                        onClick={() => { props.onAddToCanvas!(clip.url, clip.mime, clip.duration, title) }}
                      >
                        {tt('canvas.addToCanvas')}
                      </button> : null}
                      {props.onAddToConversation !== undefined ? <button
                        type="button"
                        data-video-add-conversation=""
                        disabled={props.conversationBusyKey !== undefined && props.conversationBusyKey !== null}
                        onClick={() => { void props.onAddToConversation!(clip.url, `video-task:${task.id}`) }}
                      >
                        {props.conversationBusyKey === `video-task:${task.id}` ? tt('conversation.adding') : tt('conversation.add')}
                      </button> : null}
                    </>
                  })()}
                </li>
              ))}
          </ul>
        </section>
        )}

        {/* Clip history is NOT repeated here: the shell sidebar shows images and
            clips in one list, so rendering it again would present two different
            histories of the same store. */}
      </div>

      {/* Full-screen player for one finished clip. The studio is a narrower
          column than the result board, so a clip worth watching deserves the
          same large view the canvas node's expand action gives. It reuses the
          panel's existing lightbox classes (no new stylesheet rules) and keeps
          the same "add to canvas / add to chat" actions reachable while the
          clip is being watched. */}
      {previewClip !== null ? (
        <div
          className={css.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={tt('canvas.videoPreview')}
          data-video-clip-preview=""
          onClick={() => { setPreviewClip(null) }}
        >
          <figure className={css.lightboxFigure} onClick={event => { event.stopPropagation() }}>
            <video
              className={css.galleryClipPlayer}
              src={previewClip.url}
              controls
              autoPlay
              preload="metadata"
            />
            <figcaption className={css.lightboxActions}>
              {props.onAddToCanvas !== undefined ? <button
                type="button"
                className={css.lightboxDownload}
                data-video-preview-canvas=""
                title={tt('canvas.addToCanvas')}
                onClick={() => { props.onAddToCanvas!(previewClip.url, previewClip.mime, previewClip.duration, previewClip.title) }}
              >
                {tt('canvas.addToCanvas')}
              </button> : null}
              {props.onAddToConversation !== undefined ? <button
                type="button"
                className={css.lightboxDownload}
                data-video-preview-conversation=""
                disabled={props.conversationBusyKey !== undefined && props.conversationBusyKey !== null}
                onClick={() => { void props.onAddToConversation!(previewClip.url, `video-preview:${previewClip.url}`) }}
              >
                {props.conversationBusyKey === `video-preview:${previewClip.url}` ? tt('conversation.adding') : tt('conversation.add')}
              </button> : null}
              <a className={css.lightboxDownload} href={previewClip.url} download onClick={event => event.stopPropagation()}>{tt('download')}</a>
            </figcaption>
          </figure>
          <button
            type="button"
            className={css.lightboxClose}
            aria-label={tt('canvas.videoPreviewClose')}
            title={tt('canvas.videoPreviewClose')}
            onClick={() => { setPreviewClip(null) }}
          >×</button>
        </div>
      ) : null}
      <DiagnosticsPanel api={api} open={diagnosticsOpen} onClose={() => { setDiagnosticsOpen(false) }} />
    </div>
  )
}

/** Whether a model alias looks like a video model (used by the settings card). */
export function looksLikeVideoModel(alias: string): boolean {
  return isLikelyVideoModelId(alias)
}

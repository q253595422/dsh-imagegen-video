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
    reader.onerror = () => { reject(new Error('读取图片失败')) }
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (result === '') { reject(new Error('读取图片失败')); return }
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
  const [tasks, setTasks] = useState<VideoTaskSummary[]>([])
  const [history, setHistory] = useState<VideoHistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

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

  const refreshHistory = useCallback((): void => {
    void api.videoHistoryList().then(setHistory).catch(() => { /* the list is optional */ })
  }, [api])

  useEffect(() => { refreshHistory() }, [refreshHistory])

  // Poll the host queue. The task lives host-side, so this also picks up a
  // render started before the page was reloaded.
  useEffect(() => {
    if (!active) return
    let disposed = false
    const tick = (): void => {
      void api.videoTaskList().then(next => { if (!disposed) setTasks(next) }).catch(() => { /* transient */ })
    }
    tick()
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [api, active])

  // Refresh the history whenever a render finishes.
  const completedIds = tasks.filter(task => task.status === 'completed').map(task => task.id).join(',')
  const seenCompleted = useRef('')
  useEffect(() => {
    if (completedIds === '' || completedIds === seenCompleted.current) return
    seenCompleted.current = completedIds
    refreshHistory()
  }, [completedIds, refreshHistory])

  // A seconds counter for running renders only.
  const anyRunning = tasks.some(task => task.status === 'running' || task.status === 'queued')
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [anyRunning])

  const canGenerate = model !== '' && !unknownModel && prompt.trim() !== '' && !busy
    && (mode !== 'image' || reference !== null)
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
      .then(() => api.videoTaskList())
      .then(setTasks)
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
    void api.videoTaskCancel(id).then(() => api.videoTaskList()).then(setTasks).catch(() => { /* ignore */ })
  }

  const retry = (id: string): void => {
    void api.videoTaskRetry(id).then(() => api.videoTaskList()).then(setTasks).catch(() => { /* ignore */ })
  }

  const removeHistory = (id: string): void => {
    void api.videoHistoryRemove(id).then(setHistory).catch(() => { /* ignore */ })
  }

  const clearHistory = (): void => {
    void api.videoHistoryClear().then(setHistory).catch(() => { /* ignore */ })
  }

  /** The served clip URL for a finished task summary. */
  const clipOf = (task: VideoTaskSummary): string | undefined => task.resultUrl

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
          {availableModes.map(candidate => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              className={css.videoModeButton}
              data-active={mode === candidate ? '' : undefined}
              onClick={() => { setMode(candidate) }}
            >
              {tt(`video.mode.${candidate}`)}
            </button>
          ))}
        </div>
      </header>

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

        <section className={css.videoResults}>
          <header className={css.videoResultsHead}>
            <h3>{tt('video.running')}</h3>
          </header>
          {tasks.length === 0 ? null : (
            <ul className={css.videoTaskList}>
              {tasks.map(task => (
                <li key={task.id} className={css.videoTask} data-status={task.status}>
                  <div className={css.videoTaskHead}>
                    <span className={css.videoTaskModel}>{task.request.model}</span>
                    <span className={css.videoTaskStatus}>
                      {tt(`video.${task.status === 'running' ? 'running' : task.status === 'queued' ? 'queued' : task.status === 'completed' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'failed'}`)}
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
                  {clipOf(task) !== undefined ? (
                    <video className={css.videoPlayer} controls preload="metadata" src={clipOf(task)} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={css.videoGallery}>
          <header className={css.videoResultsHead}>
            <h3>{tt('video.history')}</h3>
            {history.length > 0 ? <button type="button" onClick={clearHistory}>{tt('video.historyClear')}</button> : null}
          </header>
          {history.length === 0
            ? <p className={css.videoHint}>{tt('video.historyEmpty')}</p>
            : (
              <ul className={css.videoHistoryList}>
                {history.map(entry => (
                  <li key={entry.id} className={css.videoHistoryItem}>
                    {entry.videos.map(video => (
                      <div key={video.url} className={css.videoHistoryClip}>
                        <video className={css.videoPlayer} controls preload="metadata" src={video.url} />
                        <div className={css.videoHistoryMeta}>
                          <span>{entry.model}</span>
                          <span>{entry.aspectRatio} · {entry.resolution} · {entry.seconds}s</span>
                          <a href={video.url} download>{tt('video.download')}</a>
                          <button type="button" onClick={() => { removeHistory(entry.id) }}>{tt('video.historyRemove')}</button>
                        </div>
                      </div>
                    ))}
                    <p className={css.videoTaskPrompt} title={entry.prompt}>{entry.prompt}</p>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </div>
  )
}

/** Whether a model alias looks like a video model (used by the settings card). */
export function looksLikeVideoModel(alias: string): boolean {
  return isLikelyVideoModelId(alias)
}

/**
 * 画布上的两个自足交互件：草图板和图片选择器。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。两者都只接 props、回回调——草图板把
 * 归一化笔画交回去，选择器把文件交给上层去读；它们不读画布 document、
 * 不发请求，所以搬出来不需要画布上下文。
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Eraser, Image as ImageIcon, Trash2, Undo2, X } from 'lucide-react'
import type { CanvasAssetRef, CanvasNode, CanvasSketchStroke, GenerationTask, HistoryEntry } from '../../protocol.ts'
import type { ImageGenApi } from '../api.ts'
import { ModelPicker, resolveModelChoice } from '../ModelPicker.tsx'
import { ComposerSelect } from './dock-controls.tsx'
import type { ImageModelGroup } from '../settings-scope.ts'
import { onTablistKeyDown, tabIndexFor } from '../tablist.ts'
import { errorMessage, tt } from '../helpers.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import type { Point } from './geometry.ts'
import {
  PICKER_TABS, SKETCH_COLORS, SKETCH_ERASER_RADIUS, SKETCH_NODE_SIZE, SKETCH_WIDTH_DOTS, SKETCH_WIDTHS,
} from './constants.ts'
import { drawSketchStroke, rasterizeSketch } from './sketch-raster.ts'
import css from '../canvas-workspace.module.css'

/** 读一张图片的自然尺寸；失败时抛出可读文案而不是 NaN。 */
export function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 })
    image.onerror = () => reject(new Error(tt('image.sizeReadFailed')))
    image.src = src
  })
}

/** Free-hand drawing surface for sketch nodes. Strokes live in node metadata
 *  (normalized 0..1 board space, so the frame is fixed-size and never rescaled);
 *  after a short idle the board rasterizes to a white-background PNG and stores
 *  it as the node asset, which makes the sketch usable as a generation
 *  reference exactly like any uploaded image node. */
export function SketchBoard(props: {
  api: ImageGenApi
  node: CanvasNode
  /** Current viewport zoom; only used to keep the backing store crisp. */
  zoom: number
  strokes: CanvasSketchStroke[]
  onStrokesChange: (strokes: CanvasSketchStroke[]) => void
  onAssetChange: (asset: CanvasAssetRef | undefined) => void
}): React.JSX.Element {
  const { node, strokes } = props
  const [color, setColor] = useState(SKETCH_COLORS[0]!)
  const [widthIndex, setWidthIndex] = useState(1)
  const [erasing, setErasing] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const zoomRef = useRef(props.zoom)
  zoomRef.current = props.zoom
  const liveStrokeRef = useRef<CanvasSketchStroke | null>(null)
  const eraserDragRef = useRef(false)
  const apiRef = useRef(props.api)
  apiRef.current = props.api
  const callbacksRef = useRef({ onStrokesChange: props.onStrokesChange, onAssetChange: props.onAssetChange })
  callbacksRef.current = { onStrokesChange: props.onStrokesChange, onAssetChange: props.onAssetChange }

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width < 2 || height < 2) return
    const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)
      * Math.min(3, Math.max(1, zoomRef.current))
    const backingWidth = Math.round(width * dpr)
    const backingHeight = Math.round(height * dpr)
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth
      canvas.height = backingHeight
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(backingWidth / width, 0, 0, backingHeight / height, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    for (const stroke of strokesRef.current) drawSketchStroke(ctx, stroke, width, height)
    const live = liveStrokeRef.current
    if (live !== null) drawSketchStroke(ctx, live, width, height)
  }, [])

  // Debounced raster sync: every committed stroke state lands as the node's
  // PNG asset (or clears it when the board is emptied). Token-guarded against
  // burst edits; a synced-strokes key dedupes re-runs that only happen because
  // a canvas save round-trip handed React a fresh (but identical) strokes
  // array — without it every save would trigger a redundant re-upload.
  const syncTokenRef = useRef(0)
  const syncedStrokesRef = useRef<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const token = ++syncTokenRef.current
    const strokesKey = JSON.stringify(strokes)
    if (syncedStrokesRef.current === strokesKey) return
    const timer = window.setTimeout(() => {
      if (syncTokenRef.current !== token) return
      if (strokes.length === 0) {
        syncedStrokesRef.current = strokesKey
        callbacksRef.current.onAssetChange(undefined)
        return
      }
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width < 2 || height < 2) return
      let raster: { dataUrl: string; width: number; height: number }
      try {
        raster = rasterizeSketch(strokes, width, height)
      } catch { return }
      void apiRef.current.canvasUpload(raster.dataUrl, raster.width, raster.height, { origin: 'upload', originId: `sketch-${node.id}` })
        .then(asset => {
          if (syncTokenRef.current !== token) return
          syncedStrokesRef.current = strokesKey
          callbacksRef.current.onAssetChange(asset)
        })
        .catch(() => { /* board stays usable without the synced reference */ })
    }, strokes.length === 0 ? 150 : 600)
    return () => window.clearTimeout(timer)
  }, [node.id, strokes])

  useEffect(() => { redraw() }, [redraw, strokes, drawing, Math.round(props.zoom * 50)])

  const boardPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current
    if (canvas === null) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const eraseAt = (point: Point): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    const radiusX = SKETCH_ERASER_RADIUS / rect.width
    const radiusY = SKETCH_ERASER_RADIUS / rect.height
    const kept = strokesRef.current.filter(stroke => !stroke.points.some(candidate =>
      Math.abs(candidate.x - point.x) < radiusX && Math.abs(candidate.y - point.y) < radiusY))
    if (kept.length !== strokesRef.current.length) callbacksRef.current.onStrokesChange(kept)
  }

  const onBoardPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    // Keep the stroke off the node-drag / marquee gesture stack.
    event.stopPropagation()
    event.preventDefault()
    const point = boardPoint(event)
    if (point === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (erasing) {
      eraserDragRef.current = true
      eraseAt(point)
      return
    }
    liveStrokeRef.current = { color, width: SKETCH_WIDTHS[widthIndex]!, points: [point] }
    setDrawing(true)
    redraw()
  }

  const onBoardPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (eraserDragRef.current) {
      const point = boardPoint(event)
      if (point !== null) eraseAt(point)
      return
    }
    const live = liveStrokeRef.current
    if (live === null) return
    const point = boardPoint(event)
    if (point === null) return
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const last = live.points[live.points.length - 1]!
    if (rect !== undefined && Math.hypot((point.x - last.x) * rect.width, (point.y - last.y) * rect.height) < 1.5) return
    live.points.push({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 })
    redraw()
  }

  const onBoardPointerUp = (): void => {
    if (eraserDragRef.current) {
      eraserDragRef.current = false
      return
    }
    const live = liveStrokeRef.current
    if (live === null) return
    liveStrokeRef.current = null
    setDrawing(false)
    callbacksRef.current.onStrokesChange([...strokesRef.current, live])
  }

  return <div className={css.sketch} data-canvas-no-zoom="">
    <div className={css.sketchBoardWrap}>
      <canvas
        ref={canvasRef}
        className={css.sketchBoard}
        data-erasing={erasing ? '' : undefined}
        onPointerDown={onBoardPointerDown}
        onPointerMove={onBoardPointerMove}
        onPointerUp={onBoardPointerUp}
        onPointerCancel={onBoardPointerUp}
      />
      {strokes.length === 0 && !drawing ? <span className={css.sketchPlaceholder}>{tt('canvas.sketchPlaceholder')}</span> : null}
    </div>
    <div className={css.sketchToolbar} onPointerDown={event => event.stopPropagation()}>
      <div className={css.sketchColors} role="radiogroup" aria-label={tt('canvas.sketchBrush')}>
        {SKETCH_COLORS.map(item => <button
          key={item}
          type="button"
          role="radio"
          aria-checked={item === color && !erasing}
          data-active={item === color && !erasing ? '' : undefined}
          className={css.sketchSwatch}
          style={{ background: item }}
          // A swatch's only visible cue is its fill, which never reaches the
          // accessibility tree: without a name all eight read as the same
          // "brush colour" radio and the colour cannot be chosen by keyboard.
          aria-label={`${tt('canvas.sketchColor')} ${item}`}
          title={tt('canvas.sketchBrush')}
          onClick={() => { setColor(item); setErasing(false) }}
        />)}
      </div>
      <div className={css.sketchTools}>
        {SKETCH_WIDTHS.map((item, index) => <button
          key={item}
          type="button"
          className={css.sketchWidth}
          data-active={!erasing && index === widthIndex ? '' : undefined}
          title={tt('canvas.sketchWidth')}
          aria-label={`${tt('canvas.sketchWidth')} ${index + 1}`}
          onClick={() => { setWidthIndex(index); setErasing(false) }}
        ><span style={{ width: SKETCH_WIDTH_DOTS[index], height: SKETCH_WIDTH_DOTS[index] }} /></button>)}
        <span className={css.sketchToolDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.sketchToolBtn}
          data-active={erasing ? '' : undefined}
          title={tt('canvas.sketchEraser')}
          aria-label={tt('canvas.sketchEraser')}
          onClick={() => setErasing(previous => !previous)}
        ><ToolbarIcon name="eraser" size={14} /></button>
        <button
          type="button"
          className={css.sketchToolBtn}
          title={tt('canvas.sketchUndo')}
          aria-label={tt('canvas.sketchUndo')}
          disabled={strokes.length === 0}
          onClick={() => callbacksRef.current.onStrokesChange(strokes.slice(0, -1))}
        ><ToolbarIcon name="undo" size={14} /></button>
        <button
          type="button"
          className={css.sketchToolBtn}
          title={tt('canvas.sketchClear')}
          aria-label={tt('canvas.sketchClear')}
          disabled={strokes.length === 0}
          onClick={() => callbacksRef.current.onStrokesChange([])}
        ><ToolbarIcon name="trash" size={14} /></button>
      </div>
    </div>
  </div>
}

export function ImagePicker(props: {
  api: ImageGenApi
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  modelGroups: ImageModelGroup[]
  defaultChannelId?: string
  canvasId: string
  connected: boolean
  connectedChannelIds?: ReadonlySet<string>
  initialTab?: 'upload' | 'history' | 'gallery' | 'generate'
  onClose: () => void
  onAssets: (assets: CanvasAssetRef[]) => void
  /** Report an upload failure to the canvas banner the dialog sits over. */
  onError: (message: string) => void
  onTask: (task: GenerationTask) => void
}): React.JSX.Element {
  const { api, history, gallery, modelGroups, defaultChannelId, canvasId, connected, connectedChannelIds, onClose, onAssets, onError } = props
  const [tab, setTab] = useState<'upload' | 'history' | 'gallery' | 'generate'>(props.initialTab ?? 'upload')
  const [selected, setSelected] = useState<string[]>([])
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [prompt, setPrompt] = useState('')
  const initialChoice = resolveModelChoice(modelGroups, undefined, defaultChannelId)
  const [model, setModel] = useState(initialChoice.model)
  const [channelId, setChannelId] = useState(initialChoice.channelId)
  const pickerGroupsKey = modelGroups.map(group => `${group.id}:${group.models.join(',')}`).join('|')
  useEffect(() => {
    const next = resolveModelChoice(modelGroups, { channelId, model }, defaultChannelId)
    setChannelId(next.channelId)
    setModel(next.model)
  }, [pickerGroupsKey, defaultChannelId])

  const [size, setSize] = useState('auto')
  const [quality, setQuality] = useState('auto')
  const [busy, setBusy] = useState(false)
  const toggle = (key: string): void => setSelected(previous => previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key])
  const items = (tab === 'history' ? history : gallery).flatMap(entry => entry.images.map((image, index) => ({ key: `${entry.id}:${index}`, entry, image, index })))
  const uploadFiles = (files: File[]): void => {
    setBusy(true)
    void Promise.all(files.map(async file => {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('image.readFailed'))); reader.readAsDataURL(file) })
      const sizeOf = await readImageSize(dataUrl)
      return api.canvasUpload(dataUrl, sizeOf.width, sizeOf.height, { origin: 'upload', originId: file.name })
    })).then(assets => { onAssets(assets) })
      // Every other upload path in this file reports through the canvas error
      // banner; swallowing it here left the dialog open with nothing added and
      // no explanation, which reads as "the button is broken".
      .catch(caught => { onError(errorMessage(caught)) })
      .finally(() => setBusy(false))
  }
  const addSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      const assets: CanvasAssetRef[] = []
      for (const key of selected) {
        const [entryId, indexText] = key.split(':'); const index = Number(indexText); const item = items.find(candidate => candidate.key === key)
        if (entryId === undefined || item === undefined) continue
        const sizeOf = dimensions[key] ?? await readImageSize(item.image.url).catch(() => ({ width: 1024, height: 1024 }))
        assets.push(await api.canvasImport(tab === 'history' ? 'history' : 'gallery', entryId, index, sizeOf.width, sizeOf.height))
      }
      if (assets.length > 0) onAssets(assets)
    } finally { setBusy(false) }
  }
  const generate = async (): Promise<void> => {
    if (!(connectedChannelIds?.has(channelId) ?? connected) || prompt.trim() === '') return
    setBusy(true)
    try {
      const choice = resolveModelChoice(modelGroups, { channelId, model }, defaultChannelId)
      const task = await api.taskSubmit({ mode: 'text', model: choice.model, prompt: prompt.trim(), size, quality, n: 1, detail: '', ...(choice.channelId === '' ? {} : { channelId: choice.channelId }), canvas: { canvasId } })
      props.onTask(task)
    } finally { setBusy(false) }
  }
  return <div className={css.modalBackdrop} role="dialog" aria-modal="true" data-canvas-no-zoom=""><section className={css.picker}>
    <header className={css.pickerHeader}><strong>{tt('canvas.addImage')}</strong><button type="button" aria-label={tt('canvas.close')} title={tt('canvas.close')} onClick={onClose}>×</button></header>
    <nav className={css.pickerTabs} role="tablist">{PICKER_TABS.map((item, index) => <button key={item} type="button" role="tab" aria-selected={tab === item} data-active={tab === item ? '' : undefined} tabIndex={tabIndexFor(tab === item)} onKeyDown={event => { onTablistKeyDown(event, { count: PICKER_TABS.length, index, select: next => { setTab(PICKER_TABS[next]!); setSelected([]) } }) }} onClick={() => { setTab(item); setSelected([]) }}>{item === 'upload' ? tt('canvas.tabUpload') : item === 'history' ? tt('canvas.tabHistory') : item === 'gallery' ? tt('canvas.tabGallery') : tt('canvas.tabGenerate')}</button>)}</nav>
    <div className={css.pickerBody}>
      {tab === 'upload' ? <label className={css.uploadBox} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const files = [...(event.dataTransfer.files ?? [])].filter(file => file.type.startsWith('image/')); if (files.length === 0) return; uploadFiles(files) }}><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={busy} onChange={event => {
        const files = [...(event.target.files ?? [])]
        // Cleared so re-picking the same file fires change again: a failed
        // upload leaves the dialog open, and retrying it means the same file.
        event.target.value = ''
        if (files.length > 0) uploadFiles(files)
      }} /><span className={css.uploadIcon}><ToolbarIcon name="image" /></span><strong>{tt('canvas.dropHint')}</strong><small>{tt('canvas.dropSub')}</small></label> : null}
      {(tab === 'history' || tab === 'gallery') ? <><div className={css.pickerGrid} role="listbox" aria-multiselectable="true" aria-label={tt(tab === 'history' ? 'canvas.tabHistory' : 'canvas.tabGallery')}>{items.map(item => <button key={item.key} type="button" role="option" aria-selected={selected.includes(item.key)} aria-label={`${item.entry.prompt || tt('canvas.untitledWork')} · ${item.entry.model} · ${item.index + 1}/${item.entry.images.length}`} className={css.pickerCard} data-selected={selected.includes(item.key) ? '' : undefined} onClick={() => toggle(item.key)}><img draggable={false} src={item.image.url} alt="" onLoad={event => { const image = event.currentTarget; setDimensions(previous => ({ ...previous, [item.key]: { width: image.naturalWidth || 1, height: image.naturalHeight || 1 } })) }} /><span className={css.pickerCardPrompt}>{item.entry.prompt || tt('canvas.untitledWork')}</span><small>{item.entry.model} · {item.index + 1}/{item.entry.images.length}</small></button>)}</div><footer className={css.pickerFooter}><span>{tt('canvas.picked', { count: selected.length })}</span><button type="button" disabled={busy || selected.length === 0} onClick={() => { void addSelected() }}>{tt('canvas.addToCanvas')}</button></footer></> : null}
      {tab === 'generate' ? <div className={css.generateForm}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('canvas.composerPlaceholder')} /><ModelPicker groups={modelGroups} value={{ channelId, model }} channelLabel={tt('model.channel')} modelLabel={tt('model.label')} channelPlaceholder={tt('model.channelPlaceholder')} emptyLabel={tt('canvas.modelPlaceholder')} ariaLabel={tt('canvas.model')} onChange={choice => { setChannelId(choice.channelId); setModel(choice.model) }} /><div className={css.inspectorRow}><ComposerSelect value={size} options={[{ value: 'auto', label: tt('canvas.sizeAuto') }, { value: '1:1', label: '1:1' }, { value: '3:4', label: '3:4' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }]} ariaLabel={tt('canvas.size')} onChange={setSize} /><ComposerSelect value={quality} options={[{ value: 'auto', label: tt('canvas.qualityAuto') }, { value: '1k', label: '1K' }, { value: '2k', label: '2K' }, { value: '4k', label: '4K' }]} ariaLabel={tt('canvas.quality')} onChange={setQuality} /></div><button type="button" disabled={!(connectedChannelIds?.has(channelId) ?? connected) || busy || prompt.trim() === ''} onClick={() => { void generate() }}><ToolbarIcon name="sparkle" />{tt('canvas.generateAndAdd')}</button>{!(connectedChannelIds?.has(channelId) ?? connected) ? <small>{tt('canvas.needApi')}</small> : null}</div> : null}
    </div>
  </section></div>
}

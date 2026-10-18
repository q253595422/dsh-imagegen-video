/** Local, reversible poster overlays. Never rewrites the source image or calls a model. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { MAX_POSTER_LAYERS, MAX_POSTER_SIDE, isPosterDocument, type PosterDocument, type PosterLayer, type PosterTextLayer } from '../poster.ts'
import type { CanvasAssetRef } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import { loadPosterImage, paintPoster, renderPoster } from './poster-render.ts'
import css from './poster-editor.module.css'

interface Props {
  api: ImageGenApi
  asset: CanvasAssetRef
  recipe?: PosterDocument
  onSave: (poster: PosterDocument, dataUrl: string) => Promise<void>
  onClose: () => void
}

const id = (): string => globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const clone = (poster: PosterDocument): PosterDocument => JSON.parse(JSON.stringify(poster)) as PosterDocument

export function PosterEditor({ api, asset, recipe, onSave, onClose }: Props): React.JSX.Element {
  const [poster, setPoster] = useState<PosterDocument>(() => {
    if (isPosterDocument(recipe)) return clone(recipe)
    const scale = Math.min(1, MAX_POSTER_SIDE / Math.max(asset.width, asset.height, 1))
    return { version: 1, width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)), background: asset, layers: [] }
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [, refreshHistory] = useState(0)
  const history = useRef<PosterDocument[]>([])
  const future = useRef<PosterDocument[]>([])
  const current = useRef(poster)
  current.current = poster
  const initial = useRef(JSON.stringify(poster))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const images = useRef(new Map<string, HTMLImageElement>())
  const drag = useRef<{ pointerId: number; id: string; clientX: number; clientY: number; x: number; y: number; snapshot: PosterDocument } | null>(null)
  const mounted = useRef(true)
  const selected = poster.layers.find(layer => layer.id === selectedId)
  const changed = (next: PosterDocument): void => {
    setPoster(next)
    setDirty(JSON.stringify(next) !== initial.current)
    setConfirmClose(false)
  }
  const commit = (next: PosterDocument): void => {
    history.current = [...history.current.slice(-39), clone(current.current)]
    future.current = []
    changed(next)
  }
  const patch = (layer: PosterLayer): void => commit({ ...poster, layers: poster.layers.map(item => item.id === layer.id ? layer : item) })
  const undo = (): void => {
    const previous = history.current.pop()
    if (previous === undefined) return
    future.current.push(clone(current.current)); changed(previous); refreshHistory(value => value + 1)
  }
  const redo = (): void => {
    const next = future.current.pop()
    if (next === undefined) return
    history.current.push(clone(current.current)); changed(next); refreshHistory(value => value + 1)
  }
  const close = (): void => {
    if (busy) return
    if (dirty) { setConfirmClose(true); return }
    onClose()
  }

  useEffect(() => {
    mounted.current = true
    const previous = globalThis.document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus() }
  }, [])

  const assetKey = [poster.background, ...poster.layers.flatMap(layer => layer.type === 'image' ? [layer.asset] : [])].map(item => item.assetId).join('|')
  useEffect(() => {
    let disposed = false
    setReady(false); setError('')
    const assets = [poster.background, ...poster.layers.flatMap(layer => layer.type === 'image' ? [layer.asset] : [])]
    void Promise.all([...new Map(assets.map(item => [item.assetId, item])).values()].map(async item => {
      if (!images.current.has(item.assetId)) images.current.set(item.assetId, await loadPosterImage(item))
    })).then(async () => {
      await globalThis.document.fonts?.ready
      if (!disposed) setReady(true)
    }).catch(caught => { if (!disposed) setError(String(caught instanceof Error ? caught.message : caught)) })
    return () => { disposed = true }
  }, [assetKey])

  useEffect(() => {
    if (!ready || canvasRef.current === null) return
    try { paintPoster(canvasRef.current, poster, images.current) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [poster, ready])

  const addText = (): void => {
    if (poster.layers.length >= MAX_POSTER_LAYERS) return
    const fontSize = clamp(Math.round(poster.width * 0.055), 8, 512)
    const layer: PosterTextLayer = { id: id(), type: 'text', text: tt('poster.sampleText'), x: Math.round(poster.width * 0.08), y: Math.round(poster.height * 0.08), width: Math.max(1, Math.round(poster.width * 0.84)), fontSize, fontFamily: 'sans-serif', color: '#ffffff', bold: true, align: 'left' }
    commit({ ...poster, layers: [...poster.layers, layer] }); setSelectedId(layer.id)
  }
  const uploadLogo = async (file: File): Promise<void> => {
    if (poster.layers.length >= MAX_POSTER_LAYERS || busy) return
    setBusy(true); setError('')
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error(tt('poster.logoLimit'))
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('poster.logoFailed'))); reader.readAsDataURL(file)
      })
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error(tt('poster.logoFailed'))); image.src = dataUrl
      })
      if (size.width <= 0 || size.height <= 0 || size.width * size.height > 40_000_000) throw new Error(tt('poster.logoLimit'))
      const uploaded = await api.canvasUpload(dataUrl, size.width, size.height, { origin: 'upload', originId: file.name })
      if (!mounted.current) return
      const latest = current.current
      const ratio = Math.min(latest.width * 0.25 / size.width, latest.height * 0.25 / size.height)
      const layer: PosterLayer = { id: id(), type: 'image', asset: uploaded, x: Math.round(latest.width * 0.05), y: Math.round(latest.height * 0.05), width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)) }
      commit({ ...latest, layers: [...latest.layers, layer] }); setSelectedId(layer.id)
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const output = async (save: boolean): Promise<void> => {
    if (busy || !ready) return
    setBusy(true); setError('')
    try {
      const snapshot = clone(current.current)
      const canvas = await renderPoster(snapshot)
      if (save) {
        await onSave(snapshot, canvas.toDataURL('image/png'))
        if (mounted.current) onClose()
      } else {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value === null ? reject(new Error(tt('poster.exportFailed'))) : resolve(value), 'image/png'))
        const url = URL.createObjectURL(blob)
        const anchor = globalThis.document.createElement('a')
        anchor.href = url; anchor.download = `poster-${Date.now()}.png`
        globalThis.document.body.appendChild(anchor); anchor.click(); anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, layer: PosterLayer): void => {
    if (event.button !== 0 || busy) return
    event.preventDefault(); event.stopPropagation(); setSelectedId(layer.id)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointerId: event.pointerId, id: layer.id, clientX: event.clientX, clientY: event.clientY, x: layer.x, y: layer.y, snapshot: clone(poster) }
  }
  const finishDrag = (): void => {
    if (drag.current === null) return
    if (JSON.stringify(current.current) !== JSON.stringify(drag.current.snapshot)) {
      history.current = [...history.current.slice(-39), drag.current.snapshot]; future.current = []; refreshHistory(value => value + 1)
    }
    drag.current = null
  }
  const move = (event: ReactPointerEvent): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId || stageRef.current === null) return
    const rect = stageRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const x = clamp(Math.round(state.x + (event.clientX - state.clientX) * poster.width / rect.width), 0, poster.width - 1)
    const y = clamp(Math.round(state.y + (event.clientY - state.clientY) * poster.height / rect.height), 0, poster.height - 1)
    changed({ ...current.current, layers: current.current.layers.map(layer => layer.id === state.id ? { ...layer, x, y } : layer) })
  }
  const numberField = (label: string, value: number, min: number, max: number, change: (value: number) => void): React.JSX.Element => <label>{label}<input aria-label={label} type="number" min={min} max={max} value={value} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) change(clamp(Math.round(value), min, max)) }} /></label>

  return createPortal(<div className={css.backdrop} data-poster-editor="" data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
      const first = items[0], last = items[items.length - 1], active = globalThis.document.activeElement
      if (event.shiftKey && (active === first || active === dialogRef.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (active === last || active === dialogRef.current)) { event.preventDefault(); first?.focus() }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target as HTMLElement).matches('input, textarea')) { event.preventDefault(); if (!busy) { if (event.shiftKey) redo(); else undo() } }
  }}><section ref={dialogRef} className={css.dialog} role="dialog" aria-modal="true" aria-label={tt('poster.title')} tabIndex={-1}>
    <header className={css.header}><div><strong>{tt('poster.title')}</strong><small>{tt('poster.hint')}</small></div><button type="button" disabled={busy} onClick={close} aria-label={tt('canvas.close')}>×</button></header>
    <div className={css.toolbar}>
      <button type="button" disabled={busy || poster.layers.length >= MAX_POSTER_LAYERS} onClick={addText}>{tt('poster.addText')}</button>
      <button type="button" disabled={busy || poster.layers.length >= MAX_POSTER_LAYERS} onClick={() => inputRef.current?.click()}>{tt('poster.addLogo')}</button>
      <button type="button" disabled={busy || history.current.length === 0} onClick={undo}>{tt('poster.undo')}</button>
      <button type="button" disabled={busy || future.current.length === 0} onClick={redo}>{tt('poster.redo')}</button>
      <span>{poster.width} × {poster.height} · {poster.layers.length}/{MAX_POSTER_LAYERS}</span>
      <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadLogo(file) }} />
    </div>
    <div className={css.body}>
      <div className={css.preview}>
        <div ref={stageRef} className={css.stage} style={{ aspectRatio: `${poster.width}/${poster.height}`, width: `min(100%, ${Math.round(560 * poster.width / poster.height)}px)` }}>
          <canvas ref={canvasRef} width={poster.width} height={poster.height} aria-label={tt('poster.preview')} />
          {poster.layers.map(layer => <button key={layer.id} type="button" className={css.layerHandle} data-selected={layer.id === selectedId ? '' : undefined} aria-label={layer.type === 'text' ? layer.text || tt('poster.addText') : tt('poster.logo')} style={{ left: `${layer.x / poster.width * 100}%`, top: `${layer.y / poster.height * 100}%`, width: `${layer.width / poster.width * 100}%`, height: `${(layer.type === 'image' ? layer.height : Math.max(layer.fontSize * 1.25, layer.fontSize * 1.25 * layer.text.split('\n').length)) / poster.height * 100}%` }} disabled={busy} onClick={() => setSelectedId(layer.id)} onPointerDown={event => startDrag(event, layer)} onPointerMove={move} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} />)}
        </div>
        {!ready ? <p role="status">{tt('poster.loading')}</p> : null}
      </div>
      <aside className={css.inspector}>
        <strong>{tt('poster.layers')}</strong>
        <div className={css.layerList}>{[...poster.layers].reverse().map(layer => <button key={layer.id} type="button" data-active={layer.id === selectedId ? '' : undefined} disabled={busy} onClick={() => setSelectedId(layer.id)}>{layer.type === 'text' ? layer.text.slice(0, 40) || tt('poster.addText') : tt('poster.logo')}</button>)}</div>
        <small>{tt('poster.backgroundFixed')}</small>
        {selected ? <fieldset className={css.controls} disabled={busy}>
          {selected.type === 'text' ? <>
            <label>{tt('poster.text')}<textarea aria-label={tt('poster.text')} maxLength={4000} value={selected.text} onChange={event => patch({ ...selected, text: event.target.value })} /></label>
            <label>{tt('poster.font')}<select aria-label={tt('poster.font')} value={selected.fontFamily} onChange={event => patch({ ...selected, fontFamily: event.target.value as PosterTextLayer['fontFamily'] })}><option value="sans-serif">{tt('poster.sans')}</option><option value="serif">{tt('poster.serif')}</option><option value="monospace">{tt('poster.mono')}</option></select></label>
            {numberField(tt('poster.fontSize'), selected.fontSize, 8, 512, value => patch({ ...selected, fontSize: value }))}
            <label>{tt('poster.color')}<input aria-label={tt('poster.color')} type="color" value={selected.color} onChange={event => patch({ ...selected, color: event.target.value })} /></label>
            <label className={css.check}><input aria-label={tt('poster.bold')} type="checkbox" checked={selected.bold} onChange={event => patch({ ...selected, bold: event.target.checked })} />{tt('poster.bold')}</label>
            <label>{tt('poster.align')}<select aria-label={tt('poster.align')} value={selected.align} onChange={event => patch({ ...selected, align: event.target.value as PosterTextLayer['align'] })}><option value="left">{tt('poster.left')}</option><option value="center">{tt('poster.center')}</option><option value="right">{tt('poster.right')}</option></select></label>
          </> : null}
          <div className={css.row}>
            {numberField('X', selected.x, 0, poster.width - 1, value => patch({ ...selected, x: value }))}
            {numberField('Y', selected.y, 0, poster.height - 1, value => patch({ ...selected, y: value }))}
          </div>
          {numberField(tt('poster.width'), selected.width, 1, selected.type === 'image' ? Math.min(poster.width, Math.floor(poster.height * selected.width / selected.height)) : poster.width, value => {
            if (selected.type === 'image') patch({ ...selected, width: value, height: clamp(Math.round(selected.height * value / selected.width), 1, poster.height) })
            else patch({ ...selected, width: value })
          })}
          <div className={css.row}><button type="button" disabled={poster.layers[poster.layers.length - 1]?.id === selected.id} onClick={() => commit({ ...poster, layers: [...poster.layers.filter(layer => layer.id !== selected.id), selected] })}>{tt('poster.front')}</button><button type="button" disabled={poster.layers[0]?.id === selected.id} onClick={() => commit({ ...poster, layers: [selected, ...poster.layers.filter(layer => layer.id !== selected.id)] })}>{tt('poster.back')}</button></div>
          <button type="button" onClick={() => { commit({ ...poster, layers: poster.layers.filter(layer => layer.id !== selected.id) }); setSelectedId(null) }}>{tt('poster.delete')}</button>
        </fieldset> : <p>{tt('poster.selectHint')}</p>}
      </aside>
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <footer className={css.footer}>
      {confirmClose ? <span role="alert">{tt('poster.discardHint')} <button type="button" onClick={onClose}>{tt('poster.discard')}</button><button type="button" onClick={() => setConfirmClose(false)}>{tt('poster.keepEditing')}</button></span> : <small>{tt('poster.saveHint')}</small>}
      <button type="button" disabled={busy || !ready} onClick={() => { void output(false) }}>{tt('poster.export')}</button>
      <button type="button" className={css.primary} disabled={busy || !ready} onClick={() => { void output(true) }}>{busy ? tt('poster.working') : tt('poster.save')}</button>
    </footer>
  </section></div>, globalThis.document.body)
}

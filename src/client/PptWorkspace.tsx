import { useEffect, useRef, useState } from 'react'
import type { CanvasAssetRef, CanvasSkillCatalog, CanvasSkillTask } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { openImageGenConfig } from './config-entry.tsx'
import { useImageGenLanguageTick } from './use-language.ts'
import { PPT_SKILL_NAME } from './PptSetup.tsx'
import css from './ppt-workspace.module.css'

export interface PptImport { id: number; file: File }
const running = (task: CanvasSkillTask): boolean => task.status === 'queued' || task.status === 'running'

export function PptWorkspace({ api, active, importRequest, onImported }: { api: ImageGenApi; active: boolean; importRequest?: PptImport; onImported: () => void }) {
  useImageGenLanguageTick()
  const [images, setImages] = useState<CanvasAssetRef[]>([])
  const current = useRef(images)
  const [tasks, setTasks] = useState<CanvasSkillTask[]>([])
  const [catalog, setCatalog] = useState<CanvasSkillCatalog>()
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [offline, setOffline] = useState(true)
  const ocrChosen = useRef(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadQueue = useRef(Promise.resolve())
  const uploadingCount = useRef(0)
  const mounted = useRef(true)
  const consumed = useRef<number>()
  const [clock, setClock] = useState(Date.now())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const commit = (next: CanvasAssetRef[]): void => { current.current = next; setImages(next) }
  const accept = (files: File[]): void => {
    if (files.length === 0) return
    uploadingCount.current += 1; setUploading(true); setError('')
    uploadQueue.current = uploadQueue.current.then(async () => {
      for (const file of files) {
        if (!mounted.current) return
        if (current.current.length >= 12) { setError(tt('ppt.inputLimit')); break }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 20 * 1024 * 1024) {
          setError(tt('ppt.invalidImage')); continue
        }
        try {
          const asset = await api.canvasFileUpload(file)
          if (mounted.current) commit([...current.current, asset])
        } catch (error) { if (mounted.current) setError(errorMessage(error)) }
      }
    }).finally(() => {
      uploadingCount.current -= 1
      if (mounted.current) setUploading(uploadingCount.current > 0)
    })
  }
  useEffect(() => {
    if (importRequest === undefined || consumed.current === importRequest.id) return
    consumed.current = importRequest.id
    accept([importRequest.file]); onImported()
  }, [importRequest])
  useEffect(() => {
    if (!active) return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [nextTasks, nextCatalog] = await Promise.all([api.pptTasks(), api.canvasSkillsList()])
        if (alive) { setTasks(nextTasks); setCatalog(nextCatalog); setClock(Date.now()) }
      } catch (error) { if (alive) setError(errorMessage(error)) }
    }
    void api.canvasSkillLibrary().then(library => {
      const token = library.entries.find(entry => entry.name === PPT_SKILL_NAME)?.config?.values.find(field => field.id === 'paddle-ocr-token')
      if (alive && !ocrChosen.current && token?.set) setOffline(false)
    }).catch(() => { /* The catalog reports any setup problem. */ })
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [active, api])
  const ready = catalog?.agentAvailable && catalog.installed.includes(PPT_SKILL_NAME)
  const focused = tasks.find(task => task.id === selected) ?? tasks[0]
  const submit = async (): Promise<void> => {
    if (busy || uploading || images.length === 0) return
    setBusy(true); setError('')
    try {
      const task = await api.pptRun({ images: current.current, offlineOcr: offline })
      setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)])
      setSelected(task.id)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  return <div className={css.workspace} hidden={!active} data-ppt-workspace="">
    <aside className={css.sidebar}>
      <header><span className={css.eyebrow}>IMAGE → PPTX</span><h2>{tt('ppt.title')}</h2><p>{tt('ppt.description')}</p></header>
      <button type="button" className={css.upload} disabled={uploading || busy} onClick={() => fileInput.current?.click()}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) accept(Array.from(event.dataTransfer.files)) }}>
        <span aria-hidden="true">＋</span><strong>{tt(uploading ? 'ppt.uploading' : 'ppt.upload')}</strong><small>{tt('ppt.uploadHint')}</small>
      </button>
      <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => { accept(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <ol className={css.inputs}>
        {images.map((image, index) => <li key={`${image.assetId}-${index}`} data-ppt-input="">
          <img src={image.url} alt={image.name || `Slide ${index + 1}`} /><span>{index + 1}. {image.name}</span>
          <div className={css.inputActions}>
            <button type="button" disabled={busy || uploading || index === 0} aria-label={tt('ppt.moveUp')} onClick={() => { const next = [...current.current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; commit(next) }}>↑</button>
            <button type="button" disabled={busy || uploading || index === images.length - 1} aria-label={tt('ppt.moveDown')} onClick={() => { const next = [...current.current]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; commit(next) }}>↓</button>
            <button type="button" disabled={busy || uploading} aria-label={tt('edit.remove')} onClick={() => commit(current.current.filter((_, at) => at !== index))}>×</button>
          </div>
        </li>)}
      </ol>
      <fieldset className={css.ocr} disabled={busy}>
        <legend>{tt('ppt.ocrTitle')}</legend>
        <label><input type="radio" name="ppt-ocr" checked={!offline} onChange={() => { ocrChosen.current = true; setOffline(false) }} />{tt('ppt.ocrPaddle')}</label>
        <label><input type="radio" name="ppt-ocr" checked={offline} onChange={() => { ocrChosen.current = true; setOffline(true) }} />{tt('ppt.ocrOffline')}</label>
        <small>{tt('ppt.ocrHint')}</small>
      </fieldset>
      <p className={css.note}>{tt('ppt.processingHint')}</p>
      {!ready ? <p className={css.note}>{catalog?.reason || tt('ppt.setupRequired')}</p> : null}
      <button type="button" className={css.primary} data-ppt-convert="" disabled={!ready || busy || uploading || images.length === 0} onClick={() => { void submit() }}>{tt(busy ? 'ppt.submitting' : 'ppt.convert')}</button>
      <button type="button" onClick={() => openImageGenConfig('ppt')}>{tt('ppt.openSettings')}</button>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </aside>
    <main className={css.results}>
      <header className={css.resultHeader}><h3>{tt('ppt.results')}</h3><span>{tt('ppt.resultCount', { count: tasks.length })}</span></header>
      {tasks.length === 0 ? <div className={css.empty}><span className={css.fileIcon}>PPTX</span><h3>{tt('ppt.empty')}</h3><p>{tt('ppt.emptyHint')}</p></div> : <>
        <div className={css.taskTabs}>{tasks.map(task => <button type="button" key={task.id} data-active={focused?.id === task.id ? '' : undefined} onClick={() => setSelected(task.id)}>{new Date(task.startedAt).toLocaleString()} · {tt(`tasks.${task.status}` as never)}</button>)}</div>
        {focused ? <section className={css.result} data-ppt-task={focused.id} data-task-status={focused.status}>
          <div className={css.resultHeader}><h3>{tt(`tasks.${focused.status}` as never)}</h3>
            {running(focused) ? <button type="button" onClick={() => { void api.canvasSkillCancel(focused.id).then(async () => setTasks(await api.pptTasks())).catch(error => setError(errorMessage(error))) }}>{tt('ppt.cancel')}</button> : null}
          </div>
          <p role="status">{running(focused) ? `${focused.stage || tt('ppt.working')} · ${tt('canvas.elapsed', { seconds: Math.max(0, Math.floor((clock - focused.startedAt) / 1000)) })}` : focused.error || focused.stage}</p>
          <button type="button" disabled={busy || uploading} onClick={() => { commit(focused.pptImages ?? []); setError('') }}>{tt('ppt.reuseImages')}</button>
          <div className={css.sourceStrip}>{focused.pptImages?.map((image, index) => <img key={index} src={image.url} alt={`Slide ${index + 1}`} />)}</div>
          {focused.output?.warnings.map((warning, index) => <p key={index} className={css.note}>{warning}</p>)}
          <div className={css.outputs}>{focused.output?.nodes.map(node => {
            const asset = node.metadata?.asset
            if (!asset) return null
            return <article key={node.id}>
              {asset.mime.startsWith('image/') ? <img src={`${asset.url}?inline=1`} alt={asset.name || node.title} /> : <span className={css.fileIcon}>{asset.name?.toLowerCase().endsWith('.pptx') ? 'PPTX' : 'FILE'}</span>}
              <strong>{asset.name || node.title}</strong><a href={asset.url} download={asset.name}>{tt('download')}</a>
            </article>
          })}</div>
        </section> : null}
      </>}
    </main>
  </div>
}

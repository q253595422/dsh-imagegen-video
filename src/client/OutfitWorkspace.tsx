import React, { useEffect, useRef, useState } from 'react'
import { ImageGenApi } from './api.ts'
import { MODEL_API } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { imageModelOptions } from './settings-scope.ts'
import { tt } from './helpers.ts'
import styles from './outfit-workspace.module.css'

export interface OutfitWorkspaceProps { api?: ImageGenApi; config?: ImageGenConfig; scope?: ImageGenScope }
const SCENES = ['纯色棚拍', '都市街头', '街角咖啡', '自然草坪', '度假海滩', '温馨居家', '艺术展馆', '自定义', 'AI推荐']
const MAX_BYTES = 20 * 1024 * 1024
export default function OutfitWorkspace({ api = new ImageGenApi(), config }: OutfitWorkspaceProps): JSX.Element {
  const [clothes, setClothes] = useState<string[]>([]); const [models, setModels] = useState<Array<{ id: string; name: string; file: string; mime: string }>>([])
  const [selected, setSelected] = useState(''); const [source, setSource] = useState<'library' | 'ai' | 'upload'>('library'); const [prompt, setPrompt] = useState('')
  const [scene, setScene] = useState(SCENES[0]); const [ratio, setRatio] = useState('3:4'); const [resolution, setResolution] = useState('1K'); const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Array<{ b64?: string; mime?: string; url?: string }>>([])
  const [error, setError] = useState('')
  const model = imageModelOptions(config).defaultModel || imageModelOptions(config).models[0] || ''
  const modelMissing = model.trim() === ''
  const clothesInput = useRef<HTMLInputElement>(null); const modelInput = useRef<HTMLInputElement>(null)
  const refresh = () => { void api.modelList().then(setModels).catch(() => undefined) }; useEffect(refresh, [api])
  const read = (file: File, callback: (data: string) => void) => { if (file.size > MAX_BYTES) return; const r = new FileReader(); r.onload = () => callback(String(r.result)); r.readAsDataURL(file) }
  const uploadClothes = (files: FileList | null) => { if (!files) return; Array.from(files).slice(0, 6 - clothes.length).forEach(f => read(f, x => setClothes(v => [...v, x].slice(0, 6)))) }
  const uploadModel = (file: File | undefined) => { if (!file) return; read(file, data => void api.modelSave({ name: file.name, data, mime: file.type || 'image/png' }).then(x => { setModels(v => [x, ...v]); setSelected(x.id); setSource('library') })) }
  const submitOutfit = async () => { if (modelMissing || !selected || clothes.length === 0) return; setBusy(true); setError(''); try { const modelData = await api.modelImage(selected); const result = await api.generate({ mode: 'edit', prompt: `服饰穿戴，场景：${scene}，比例：${ratio}，分辨率：${resolution}`, model, size: ratio, quality: resolution === '2K' ? 'high' : 'medium', detail: 'auto', n: 1, image: modelData, images: clothes.slice(0, 4), refName: 'outfit-model' }); setResults(result.images ?? []) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const generateModel = async () => { if (!prompt.trim()) return; setBusy(true); setError(''); try { const result = await api.generate({ mode: 'text', prompt, model, size: ratio, quality: resolution, detail: 'auto', n: 1 }); const image = result.images?.[0]; if (image?.b64) { const saved = await api.modelSave({ name: prompt.slice(0, 24), data: `data:${image.mime};base64,${image.b64}`, mime: image.mime }); setModels(v => [saved, ...v]); setSelected(saved.id); setSource('library') } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  return <section className={styles.root}>
    <h2>{tt('outfit.title')}</h2><p className={styles.muted}>{tt('outfit.hint')}</p>
    <div className={styles.actions}><button type="button" onClick={() => clothesInput.current?.click()}>{tt('outfit.uploadClothes', { count: clothes.length })}</button><input ref={clothesInput} hidden type="file" accept="image/*" multiple onChange={e => uploadClothes(e.target.files)} /></div>
    <div className={styles.grid}>{clothes.map((x, i) => <div className={styles.card} key={`${x.slice(-12)}-${i}`}><img className={styles.thumb} src={x} alt={tt('outfit.clothingImage', { count: i + 1 })} /><button type="button" onClick={() => setClothes(v => v.filter((_, n) => n !== i))}>{tt('outfit.remove')}</button></div>)}</div>
    <div className={styles.actions}>{(['library', 'ai', 'upload'] as const).map(x => <button type="button" key={x} aria-pressed={source === x} onClick={() => setSource(x)}>{x === 'library' ? tt('outfit.sourceLibrary') : x === 'ai' ? tt('outfit.sourceAi') : tt('outfit.sourceUpload')}</button>)}</div>
    {source === 'library' && models.length === 0 ? <p className={styles.muted}>{tt('outfit.emptyLibrary')}</p> : null}
    {source === 'library' && <div className={styles.grid}>{models.map(x => <button className={`${styles.card} ${selected === x.id ? styles.selected : ''}`} type="button" key={x.id} onClick={() => setSelected(x.id)}><img className={styles.thumb} src={`${MODEL_API.image}/${encodeURIComponent(x.file)}`} alt={x.name} /><span>{x.name}</span></button>)}</div>}
    {source === 'ai' && <div className={styles.actions}><input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={tt('outfit.modelPrompt')} /><button type="button" disabled={busy} onClick={() => void generateModel()}>{busy ? tt('outfit.generating') : tt('outfit.generateModel')}</button></div>}
    {source === 'upload' && <><button type="button" onClick={() => modelInput.current?.click()}>{tt('outfit.selectModel')}</button><input ref={modelInput} hidden type="file" accept="image/*" onChange={e => uploadModel(e.target.files?.[0])} /></>}
    <label>{tt('outfit.scene')} <select value={scene} onChange={e => setScene(e.target.value)}>{SCENES.map(x => <option key={x}>{x}</option>)}</select></label>
    <div className={styles.actions}>{tt('outfit.ratio')} {['3:4', '1:1', '9:16'].map(x => <button type="button" key={x} aria-pressed={ratio === x} onClick={() => setRatio(x)}>{x}</button>)} {tt('outfit.resolution')} {['1K', '2K'].map(x => <button type="button" key={x} aria-pressed={resolution === x} onClick={() => setResolution(x)}>{x}</button>)}</div>
    {modelMissing ? <p role="status" className={styles.muted}>{tt('outfit.modelMissing')}</p> : null}
    <button type="button" disabled={modelMissing || busy || clothes.length === 0 || !selected} onClick={() => void submitOutfit()}>{busy ? tt('outfit.generating') : tt('outfit.generate')}</button>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {results.length > 0 ? <div className={styles.results}>{results.map((image, index) => { const src = image.url ?? (image.b64 ? `data:${image.mime ?? 'image/png'};base64,${image.b64}` : ''); return src ? <img key={`${src}-${index}`} className={styles.result} src={src} alt={tt('outfit.resultAlt', { count: index + 1 })} /> : null })}</div> : null}
    <small className={styles.muted}>{tt('outfit.consistency')}</small>
  </section>
}

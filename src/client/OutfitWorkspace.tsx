import React, { useEffect, useRef, useState } from 'react'
import { ImageGenApi } from './api.ts'

export interface OutfitWorkspaceProps { api?: ImageGenApi }
const SCENES = ['纯色棚拍', '都市街头', '街角咖啡', '自然草坪', '度假海滩', '温馨居家', '艺术展馆', '自定义', 'AI 推荐']
export default function OutfitWorkspace({ api = new ImageGenApi() }: OutfitWorkspaceProps): JSX.Element {
  const [clothes, setClothes] = useState<string[]>([])
  const [models, setModels] = useState<Array<{ id: string; name: string; file: string; mime: string }>>([])
  const [model, setModel] = useState<string>('')
  const [scene, setScene] = useState(SCENES[0]); const [ratio, setRatio] = useState('3:4'); const [resolution, setResolution] = useState('1K')
  const input = useRef<HTMLInputElement>(null); const modelInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void api.modelList().then(setModels).catch(() => undefined) }, [api])
  const readFiles = (files: FileList | null, target: 'clothes' | 'model') => { if (!files) return; for (const file of Array.from(files).slice(0, target === 'clothes' ? 6 : 1)) { const reader = new FileReader(); reader.onload = () => { const value = String(reader.result); if (target === 'clothes') setClothes(x => [...x, value].slice(0, 6)); else void api.modelSave({ name: file.name, data: value, mime: file.type || 'image/png' }).then(saved => { setModels(x => [saved, ...x]); setModel(saved.id) }) }; reader.readAsDataURL(file) } }
  return <section style={{ padding: 24, display: 'grid', gap: 16 }}>
    <h2>服饰穿戴</h2><p>最多选择 6 张服装图；当前引擎实际发送 1 张主图 + 最多 4 张附图。Grok / Nano Banana 仅支持 1 张。</p>
    <button type="button" onClick={() => input.current?.click()}>上传服装图（{clothes.length}/6）</button><input ref={input} hidden type="file" accept="image/*" multiple onChange={e => readFiles(e.target.files, 'clothes')} />
    <select value={model} onChange={e => setModel(e.target.value)}><option value="">选择模特</option>{models.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
    <button type="button" onClick={() => modelInput.current?.click()}>上传新模特</button><input ref={modelInput} hidden type="file" accept="image/*" onChange={e => readFiles(e.target.files, 'model')} />
    <label>场景 <select value={scene} onChange={e => setScene(e.target.value)}>{SCENES.map(x => <option key={x}>{x}</option>)}</select></label>
    <label>比例 {['3:4', '1:1', '9:16'].map(x => <button type="button" key={x} onClick={() => setRatio(x)} aria-pressed={ratio === x}>{x}</button>)}</label>
    <label>分辨率 {['1K', '2K'].map(x => <button type="button" key={x} onClick={() => setResolution(x)} aria-pressed={resolution === x}>{x}</button>)}</label>
    <small>AI 生成模特每次可能不同；本界面不承诺跨生成保持同一外观。</small>
  </section>
}

/**
 * 服饰穿戴 (virtual try-on) workspace.
 *
 * WHY this file exists at all: the surface used to be a stack of bare controls
 * because (a) the stylesheet had no layout, and (b) the host kept the classic
 * 300px config sidebar laid out beside it, squeezing `.root` into a ~2px
 * column. The second half is fixed by the two `:global([data-workspace=...])`
 * rules in `outfit-workspace.module.css`; this file's job is the first half.
 *
 * FUNCTION IS UNCHANGED from the 45-line version this replaces: the same four
 * garment cap, the same 20 MiB per-file check, the same `api.modelSave` /
 * `api.modelImage` / `api.generate` arguments, the same `modelMissing` gate and
 * the same consistency disclaimer. What changed is structure only — the
 * controls are grouped into `.field` blocks with a label above each, the
 * ratio/resolution chips are separate pill groups instead of one mixed flex,
 * and the results moved into their own scrollable column.
 *
 * Two things a reader should not have to reverse-engineer:
 *
 * 1. THE MODEL SHOT COUNTS AS A REFERENCE. `outfit.hint` says the engine takes
 *    the model image plus four garments, which is the real five-reference
 *    ceiling — that is why the picker stops at 4 and not at 6.
 * 2. THE AI-GENERATED MODEL IS SAVED, NOT JUST SHOWN. `generateModel` posts the
 *    result straight into the model library and selects it, so a model the
 *    user likes survives the next visit. Keeping it in component state only
 *    would lose it on reload.
 */
import React, { useEffect, useRef, useState } from 'react'
import { ImageGenApi } from './api.ts'
import { MODEL_API } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { imageModelOptions } from './settings-scope.ts'
import { tt } from './helpers.ts'
import css from './outfit-workspace.module.css'

export interface OutfitWorkspaceProps { api?: ImageGenApi; config?: ImageGenConfig; scope?: ImageGenScope }
const SCENES = ['纯色棚拍', '都市街头', '街角咖啡', '自然草坪', '度假海滩', '温馨居家', '艺术展馆', '自定义', 'AI推荐']
const RATIOS = ['3:4', '1:1', '9:16']
const RESOLUTIONS = ['1K', '2K']
const MAX_BYTES = 20 * 1024 * 1024
const MAX_CLOTHES = 4


export default function OutfitWorkspace({ api = new ImageGenApi(), config }: OutfitWorkspaceProps): JSX.Element {
  const [clothes, setClothes] = useState<string[]>([]); const [models, setModels] = useState<Array<{ id: string; name: string; file: string; mime: string }>>([])
  const [selected, setSelected] = useState(''); const [source, setSource] = useState<'library' | 'ai' | 'upload'>('library'); const [prompt, setPrompt] = useState('')
  const [scene, setScene] = useState(SCENES[0]); const [ratio, setRatio] = useState('3:4'); const [resolution, setResolution] = useState('1K'); const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Array<{ b64?: string; mime?: string; url?: string }>>([])
  const [error, setError] = useState('')
  const allowedUploadMime = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  const model = imageModelOptions(config).defaultModel || imageModelOptions(config).models[0] || ''
  const modelMissing = model.trim() === ''
  const clothesInput = useRef<HTMLInputElement>(null); const modelInput = useRef<HTMLInputElement>(null)
  const refresh = () => { void api.modelList().then(setModels).catch(() => undefined) }; useEffect(refresh, [api])
  const read = (file: File, callback: (data: string) => void) => { if (file.size > MAX_BYTES) { setError(tt('outfit.fileTooLarge')); return }; const r = new FileReader(); r.onload = () => callback(String(r.result)); r.onerror = () => setError(tt('outfit.readFailed')); r.readAsDataURL(file) }
  const uploadClothes = (files: FileList | null) => { if (!files) return; Array.from(files).slice(0, MAX_CLOTHES - clothes.length).forEach(f => { if (!allowedUploadMime.has(f.type)) { setError(tt('outfit.invalidImageType')); return }; read(f, x => setClothes(v => [...v, x].slice(0, MAX_CLOTHES))) }) }
  const uploadModel = (file: File | undefined) => { if (!file) return; if (!allowedUploadMime.has(file.type)) { setError(tt('outfit.invalidImageType')); return }; read(file, data => void api.modelSave({ name: file.name, data, mime: file.type }).then(x => { setModels(v => [x, ...v]); setSelected(x.id); setSource('library') }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))) }
  const submitOutfit = async () => { if (modelMissing || !selected || clothes.length === 0) return; setBusy(true); setError(''); try { const modelData = await api.modelImage(selected); const result = await api.generate({ mode: 'edit', prompt: `服饰穿戴，场景：${scene}，比例：${ratio}，分辨率：${resolution}`, model, size: ratio, quality: resolution === '2K' ? 'high' : 'medium', detail: 'auto', n: 1, image: modelData, images: clothes.slice(0, MAX_CLOTHES), refName: 'outfit-model' }); setResults(result.images ?? []) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const generateModel = async () => { if (!prompt.trim()) return; setBusy(true); setError(''); try { const result = await api.generate({ mode: 'text', prompt, model, size: ratio, quality: resolution, detail: 'auto', n: 1 }); const image = result.images?.[0]; if (image?.b64) { const saved = await api.modelSave({ name: prompt.slice(0, 24), data: `data:${image.mime};base64,${image.b64}`, mime: image.mime }); setModels(v => [saved, ...v]); setSelected(saved.id); setSource('library') } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const SOURCES = [
    { value: 'library' as const, label: tt('outfit.sourceLibrary') },
    { value: 'ai' as const, label: tt('outfit.sourceAi') },
    { value: 'upload' as const, label: tt('outfit.sourceUpload') },
  ]
  const ready = !modelMissing && !busy && clothes.length > 0 && selected !== ''
  return <section className={css.root} data-outfit="true">
    <header className={css.intro}>
      <div>
        <h2>{tt('outfit.title')}</h2>
        <p>{tt('outfit.hint')}</p>
      </div>
      <div className={css.aside}>
        <span className={css.badge}>{tt('outfit.uploadClothes', { count: clothes.length })}</span>
      </div>
    </header>

    <div className={css.body}>
      <form className={css.form} onSubmit={event => { event.preventDefault(); void submitOutfit() }}>
        {/* ------------------------------------------------------ clothing */}
        <div className={css.field}>
          <div className={css.fieldHead}>
            <span className={css.fieldLabel}>{tt('outfit.section.clothes')}</span>
            <span className={css.fieldNote}>{tt('outfit.uploadClothes', { count: clothes.length })}</span>
          </div>
          {clothes.length > 0 ? (
            <ul className={css.thumbs}>
              {clothes.map((x, i) => <li className={css.thumb} key={`${x.slice(-12)}-${i}`}>
                <img src={x} alt={tt('outfit.clothingImage', { count: i + 1 })} />
                <span className={css.thumbIndex}>{i + 1}</span>
                <button type="button" className={css.thumbRemove} aria-label={tt('outfit.remove')} onClick={() => setClothes(v => v.filter((_, n) => n !== i))}>×</button>
              </li>)}
            </ul>
          ) : null}
          <button type="button" className={css.drop} disabled={clothes.length >= MAX_CLOTHES} onClick={() => clothesInput.current?.click()}>
            {clothes.length >= MAX_CLOTHES ? tt('outfit.clothesFull') : tt('outfit.uploadClothes', { count: clothes.length })}
          </button>
          <input ref={clothesInput} hidden type="file" accept="image/*" multiple onChange={e => { uploadClothes(e.target.files); e.target.value = '' }} />
        </div>

        {/* --------------------------------------------------------- model */}
        <div className={css.field}>
          <div className={css.fieldHead}>
            <span className={css.fieldLabel}>{tt('outfit.section.model')}</span>
            <span className={css.fieldNote}>{tt('outfit.section.modelNote')}</span>
          </div>
          <div className={css.pills} role="radiogroup" aria-label={tt('outfit.section.model')}>
            {SOURCES.map(option => (
              <button key={option.value} type="button" className={css.pill} role="radio" aria-checked={source === option.value} onClick={() => setSource(option.value)}>{option.label}</button>
            ))}
          </div>
          {source === 'library' ? (
            models.length === 0
              ? <p className={css.muted}>{tt('outfit.emptyLibrary')}</p>
              : <div className={css.grid}>{models.map(x => (
                <button className={css.card} type="button" key={x.id} aria-pressed={selected === x.id} onClick={() => setSelected(x.id)}>
                  <img src={`${MODEL_API.image}/${encodeURIComponent(x.file)}`} alt={x.name} />
                  <span>{x.name}</span>
                </button>
              ))}</div>
          ) : null}
          {source === 'ai' ? (
            <div className={css.field}>
              <textarea className={css.textarea} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={tt('outfit.modelPrompt')} />
              <button type="button" className={css.button} disabled={busy || prompt.trim() === ''} onClick={() => void generateModel()}>{busy ? tt('outfit.generating') : tt('outfit.generateModel')}</button>
            </div>
          ) : null}
          {source === 'upload' ? (
            <>
              <button type="button" className={css.drop} onClick={() => modelInput.current?.click()}>{tt('outfit.selectModel')}</button>
              <input ref={modelInput} hidden type="file" accept="image/*" onChange={e => { uploadModel(e.target.files?.[0]); e.target.value = '' }} />
            </>
          ) : null}
        </div>

        {/* --------------------------------------------------------- scene */}
        <div className={css.field}>
          <div className={css.fieldHead}>
            <span className={css.fieldLabel}>{tt('outfit.scene')}</span>
            <span className={css.fieldNote}>{tt('outfit.section.sceneNote')}</span>
          </div>
          <select className={css.select} value={scene} onChange={e => setScene(e.target.value)}>{SCENES.map(x => <option key={x}>{x}</option>)}</select>
        </div>

        {/* ------------------------------------------------------ parameters */}
        <div className={css.field}>
          <span className={css.fieldLabel}>{tt('outfit.ratio')}</span>
          <div className={css.pills} role="radiogroup" aria-label={tt('outfit.ratio')}>
            {RATIOS.map(x => (
              <button key={x} type="button" className={css.pill} role="radio" aria-checked={ratio === x} onClick={() => setRatio(x)}>{x}</button>
            ))}
          </div>
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>{tt('outfit.resolution')}</span>
          <div className={css.pills} role="radiogroup" aria-label={tt('outfit.resolution')}>
            {RESOLUTIONS.map(x => (
              <button key={x} type="button" className={css.pill} role="radio" aria-checked={resolution === x} onClick={() => setResolution(x)}>{x}</button>
            ))}
          </div>
        </div>

        {modelMissing ? <p role="status" className={css.error}>{tt('outfit.modelMissing')}</p> : null}
        <div className={css.submitBar}>
          <div className={css.submitRow}>
            <button type="submit" className={css.primary} disabled={!ready}>{busy ? tt('outfit.generating') : tt('outfit.generate')}</button>
          </div>
          {/* Restored after the relayout dropped it: this is the only place the
              surface says an AI-generated model is not stable across runs. */}
          <small className={css.muted}>{tt('outfit.consistency')}</small>
          {error ? <p role="alert" className={css.error}>{error}</p> : null}
        </div>
      </form>

      <section className={css.results}>
        {results.length > 0 ? (
          <div className={css.outputs}>{results.map((image, index) => { const src = image.url ?? (image.b64 ? `data:${image.mime ?? 'image/png'};base64,${image.b64}` : ''); return src ? <img key={`${src}-${index}`} className={css.output} src={src} alt={tt('outfit.resultAlt', { count: index + 1 })} /> : null })}</div>
        ) : (
          <div className={css.empty}>
            <span>{tt('outfit.emptyResults')}</span>
          </div>
        )}
      </section>
    </div>
  </section>
}

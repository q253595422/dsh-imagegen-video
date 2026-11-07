/**
 * 服饰穿戴保留商品试穿的模特库，并让同一生成链路接收图库人物／服装／姿势。
 * 配方先预览、再提交相同的 prepared 图像与提示词；任何编辑都会使预览失效。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ImageGenApi } from './api.ts'
import type { GenerateRequest, GenerationTaskSummary } from '../protocol.ts'
import { describeModel } from '../model-catalog.ts'
import type { OutfitReference, OutfitReferenceKind, OutfitRecipe, OutfitPreparedGeneration } from '../outfit-reference.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { imageModelOptions } from './settings-scope.ts'
import { editReferenceLimit } from './reference-images.ts'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from './ModelPicker.tsx'
import { OutfitReferencePicker } from './OutfitReferencePicker.tsx'
import { outfitReferenceApi } from './outfit-reference-api.ts'
import { defaultOutfitRecipe, prepareOutfitGeneration } from './outfit-generation.ts'
import { tt } from './helpers.ts'
import css from './outfit-workspace.module.css'

export interface OutfitWorkspaceProps { api?: ImageGenApi; config?: ImageGenConfig; scope?: ImageGenScope }
const SCENES = ['纯色棚拍', '都市街头', '街角咖啡', '自然草坪', '度假海滩', '温馨居家', '艺术展馆', 'AI推荐']
const RATIOS = ['3:4', '1:1', '9:16']
const RESOLUTIONS = ['1K', '2K']
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_CLOTHES = 4
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const defaultApi = new ImageGenApi()
/** 上传图像转成后端接收的 Data URL；本地文件是受信任边界的输入，先查 MIME 与大小。
 *  10 MiB 是调用方（生成渠道与图库 store）共用的单张上限，超出就会在请求处被拒。 */
function readImage(file: File, maxBytes = MAX_REFERENCE_BYTES): Promise<string> {
  if (!IMAGE_TYPES.has(file.type)) return Promise.reject(new Error(tt('outfit.invalidImageType')))
  if (file.size === 0 || file.size > maxBytes) return Promise.reject(new Error(tt('outfit.fileTooLarge')))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(tt('outfit.readFailed')))
    reader.onerror = reader.onabort = () => reject(new Error(tt('outfit.readFailed')))
    reader.readAsDataURL(file)
  })
}

export default function OutfitWorkspace({ api = defaultApi, config }: OutfitWorkspaceProps): JSX.Element {
  const [recipe, setRecipe] = useState<OutfitRecipe>(defaultOutfitRecipe)
  const [picker, setPicker] = useState<OutfitReferenceKind | null>(null)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState<OutfitPreparedGeneration | null>(null)
  const [tasks, setTasks] = useState<GenerationTaskSummary[]>([])
  const [hydrated, setHydrated] = useState<Record<string, Array<{ b64?: string; mime?: string; url?: string }>>>({})
  const [error, setError] = useState('')
  const [draftError, setDraftError] = useState('')
  const clothesInput = useRef<HTMLInputElement>(null)
  const poseInput = useRef<HTMLInputElement>(null)
  const generationEpoch = useRef(0)
  const previewRecipeKey = useRef('')
  const active = useRef(true)
  const savingQueue = useRef(Promise.resolve())
  const latestDraft = useRef<OutfitRecipe | null>(null)
  const working = useRef(false)
  const latestTasks = useRef<GenerationTaskSummary[]>([])
  const hydratedIds = useRef(new Set<string>())
  /** 草稿读失败期间用户仍可编辑（否则读不到旧草稿就等于整个面板点不动）。
   *  这时重试成功必须保留用户眼前的编辑，而不是拿旧草稿覆盖掉它。 */
  const editedWhileUnloaded = useRef(false)

  const options = imageModelOptions(config)
  const initialChoice = { model: options.defaultModel ?? options.models[0] ?? '', channelId: options.defaultChannelId ?? options.groups[0]?.id ?? '' }
  const selectedChoice = resolveModelChoice(options.groups, { model: recipe.model, channelId: recipe.channelId }, options.defaultChannelId)
  const choice: ModelPickerValue = recipe.model ? selectedChoice : resolveModelChoice(options.groups, initialChoice, options.defaultChannelId)
  const selectedChannel = config?.channels?.find(channel => channel.id === choice.channelId)
  const upstream = selectedChannel?.models.find(entry => entry.alias === choice.model)?.id ?? choice.model
  const supportsEdit = describeModel(upstream).supportsEdit
  const referenceLimit = editReferenceLimit(choice.model, selectedChannel)
  const modelMissing = choice.model.trim() === ''
  const fullRecipe: OutfitRecipe = { ...recipe, channelId: choice.channelId, model: choice.model }
  latestDraft.current = draftLoaded ? fullRecipe : null
  const scenePreset = SCENES.includes(recipe.scene) ? recipe.scene : '自定义'
  const hasReference = recipe.portrait !== null || recipe.costumes.length > 0 || recipe.pose !== null
  const hasRequired = recipe.mode === 'try-on' ? recipe.portrait !== null && recipe.costumes.length > 0 : hasReference
  /** 只有「正在读草稿」这一小段窗口需要锁表单：那时到达的草稿会覆盖编辑。
   *  读失败不再算窗口——一只失败的请求把整张表单永久禁用，用户看到的就是
   *  「按钮点不动」，而错误提示里并没有说这一点。保存另有 `draftLoaded` 闸，
   *  所以放开编辑不会盲覆盖磁盘上的旧草稿。 */
  const formLocked = !draftLoaded && draftError === ''

  useEffect(() => {
    active.current = true
    let cancelled = false
    void outfitReferenceApi.loadDraft().then(draft => {
      if (cancelled) return
      if (!editedWhileUnloaded.current && draft?.version === 1) setRecipe({ ...draft, costumes: draft.costumes.slice(0, MAX_CLOTHES) })
      editedWhileUnloaded.current = false
      setDraftLoaded(true)
    }).catch(cause => {
      if (cancelled) return
      // Save remains blocked until the old draft is successfully read: no blind overwrite.
      setDraftError(`无法读取搭配草稿：${cause instanceof Error ? cause.message : String(cause)}。请重试加载。`)
    })
    return () => { cancelled = true; active.current = false; generationEpoch.current++ }
  }, [api])

  /** 切出工作台时冲刷最后一次尚未到防抖时间的编辑。 */
  useEffect(() => () => {
    const snapshot = latestDraft.current
    if (!snapshot) return
    savingQueue.current = savingQueue.current.catch(() => undefined).then(() => outfitReferenceApi.saveDraft(snapshot))
    void savingQueue.current.catch(() => undefined)
  }, [])

  /** 串行写草稿，防止快速编辑时旧请求晚到覆盖新状态。 */
  useEffect(() => {
    if (!draftLoaded) return
    const timer = window.setTimeout(() => {
      const snapshot = fullRecipe
      setSaving(true)
      savingQueue.current = savingQueue.current.catch(() => undefined).then(() => outfitReferenceApi.saveDraft(snapshot))
      void savingQueue.current.then(() => { if (active.current) { setSaving(false); setDraftError('') } }).catch(cause => {
        if (active.current) { setSaving(false); setDraftError(`保存草稿失败：${cause instanceof Error ? cause.message : String(cause)}`) }
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [draftLoaded, recipe, choice.channelId, choice.model])

  /** 配方、渠道或模型有变化必须重新预览；过期的准备结果也不能覆盖新画面。 */
  useEffect(() => { generationEpoch.current++; setPrepared(null) }, [recipe, choice.channelId, choice.model])

  /** 一次拉取服饰穿戴的任务；进行中/完成的任务都展示在任务卡里。
   *  生成过什么由宿主的左侧历史列表负责，面板里不再重复一份。 */
  const refreshTasks = async (): Promise<void> => {
    try {
      const allTasks = await api.taskList()
      const outfitTasks = allTasks.filter(task => task.request.refName?.startsWith('outfit-'))
      latestTasks.current = outfitTasks
      setTasks(outfitTasks)
      // 完成任务结果量小、含图，只在第一次拿到时取一次；轮询列表永远只拿摘要。
      const pendingHydrate = outfitTasks.filter(task => task.status === 'completed' && task.resultAvailable && !hydratedIds.current.has(task.id))
      if (pendingHydrate.length > 0) {
        const filled = await Promise.all(pendingHydrate.map(async task => {
          hydratedIds.current.add(task.id)
          const full = await api.taskGet(task.id)
          return [task.id, full.result?.images ?? []] as const
        }))
        setHydrated(previous => Object.assign({}, previous, Object.fromEntries(filled)))
      }
    } catch { /* 宿主暂时不可达时保留已有列表，不打断编辑 */ }
  }

  /** 面板挂载与重挂载时立即恢复进行中任务与历史；只有存在活跃任务才继续轮询。 */
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      if (cancelled) return
      await refreshTasks()
      if (cancelled) return
      const active = latestTasks.current.some(task => task.status === 'queued' || task.status === 'running')
      if (active) timer = window.setTimeout(() => void tick(), 2000)
    }
    void tick()
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [api])

  const update = (patch: Partial<OutfitRecipe>): void => {
    if (!draftLoaded) editedWhileUnloaded.current = true
    generationEpoch.current++
    previewRecipeKey.current = ''
    setPrepared(null)
    setRecipe(current => ({ ...current, ...patch }))
    setError('')
  }
  const chooseReference = (item: OutfitReference): void => {
    if (!draftLoaded) editedWhileUnloaded.current = true
    generationEpoch.current++
    previewRecipeKey.current = ''
    setPrepared(null)
    setRecipe(current => item.kind === 'portrait' ? { ...current, portrait: item }
      : item.kind === 'pose' ? { ...current, pose: item }
        : { ...current, costumes: [...current.costumes, item].slice(0, MAX_CLOTHES) })
    setPicker(null)
  }

  /** 将上传素材经宿主落盘并保存配方；排除 base64 草稿及重启后失效的 blob URL。 */
  const uploadReference = async (kind: 'costume' | 'pose', files: FileList | null): Promise<void> => {
    if (!files || working.current) return
    working.current = true; setBusy(true); setError('')
    try {
      const chosen = kind === 'costume' ? Array.from(files).slice(0, MAX_CLOTHES - recipe.costumes.length) : Array.from(files).slice(0, 1)
      for (const file of chosen) {
        const data = await readImage(file)
        const saved = await outfitReferenceApi.upload({ kind, name: file.name, data })
        if (active.current) chooseReference(saved)
      }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { working.current = false; if (active.current) setBusy(false) }
  }

  /** 刷新草稿：模特库现在归人物图库管，草稿刷新不再连带拉模特列表。 */
  const reloadDraft = async (): Promise<void> => {
    setDraftError('')
    try {
      const draft = await outfitReferenceApi.loadDraft()
      if (!active.current) return
      // 用户在读失败期间已经改过配方：保留眼前的编辑，只解除保存闸。
      if (!editedWhileUnloaded.current && draft?.version === 1) setRecipe({ ...draft, costumes: draft.costumes.slice(0, MAX_CLOTHES) })
      editedWhileUnloaded.current = false
      setDraftLoaded(true)
    } catch (cause) { if (active.current) setDraftError(`无法读取搭配草稿：${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  /** 人物图库的“AI 生成模特”走这里：图库负责界面，渠道与模型只有工作台知道。
   *  生成走阻塞式请求而不是任务队列，因为模特必须先落盘才能在图库里被选中。 */
  const generateModel = async (prompt: string): Promise<{ id: string; name: string; file: string }> => {
    const result = await api.generate({ mode: 'text', prompt, model: choice.model, channelId: choice.channelId, size: recipe.size, quality: recipe.quality.toLowerCase(), detail: '', n: 1 })
    const image = result.images?.[0]
    if (!image?.b64) throw new Error('生成人像没有返回图片')
    return api.modelSave({ name: prompt.slice(0, 24), data: `data:${image.mime};base64,${image.b64}`, mime: image.mime })
  }
  const preview = async (): Promise<void> => {
    // 草稿没读回来不挡预览：这一步只在本机下载并排版参考图，既不写草稿也不
    // 调模型。以前它要求 `draftLoaded`，于是草稿读失败时提交按钮看着能点、
    // 点下去却什么都不发生——和锁死整张表单是同一类缺陷。
    if (!hasRequired || !supportsEdit || modelMissing || working.current) return
    const epoch = generationEpoch.current
    working.current = true; setBusy(true); setError(''); setPrepared(null)
    try {
      const result = await prepareOutfitGeneration(fullRecipe, referenceLimit)
      if (active.current && generationEpoch.current === epoch) {
        previewRecipeKey.current = JSON.stringify(fullRecipe)
        setPrepared(result)
      }
    } catch (cause) { if (active.current && generationEpoch.current === epoch) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { working.current = false; if (active.current) setBusy(false) }
  }
  /** 取消排队/进行中的生成任务。 */
  const cancelTask = async (id: string): Promise<void> => {
    try { await api.taskCancel(id); await refreshTasks() } catch { /* 列表下次轮询仍会反映实际状态 */ }
  }
  /** 失败/取消的任务重新入队，复用原请求。 */
  const retryTask = async (id: string): Promise<void> => {
    try { await api.taskRetry(id); await refreshTasks() } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  /** 提交改走宿主异步任务队列：立即返回任务卡，面板切走再回来也能恢复进行中状态。 */
  const submitOutfit = async (): Promise<void> => {
    if (!prepared || modelMissing || !supportsEdit || working.current || previewRecipeKey.current !== JSON.stringify(fullRecipe)) return
    working.current = true; setBusy(true); setError('')
    try {
      // 不在提交时再次拼图或重写提示词：付费请求与预览必须逐字逐图相同。
      const request: GenerateRequest = { mode: 'edit', prompt: prepared.prompt, model: choice.model, channelId: choice.channelId,
        size: recipe.size, quality: recipe.quality.toLowerCase(), detail: '', n: 1, image: prepared.image, images: prepared.images,
        refName: recipe.mode === 'try-on' ? 'outfit-try-on' : 'outfit-character' }
      await api.taskSubmit(request)
      if (active.current) {
        await refreshTasks()
        setPrepared(null)
      }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { working.current = false; if (active.current) setBusy(false) }
  }
  const timeOf = (ms: number): string => {
    const date = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const renderTask = (task: GenerationTaskSummary): JSX.Element => {
    const label = task.request.refName === 'outfit-try-on' ? '商品试穿' : '角色搭配'
    if (task.status === 'queued' || task.status === 'running') {
      return <div className={css.taskCard} role="status">
        <span className={css.spinner} aria-hidden="true" />
        <div className={css.taskMain}>
          <strong>{task.status === 'queued' ? '排队中…' : '正在生成…'}</strong>
          <p className={css.muted}>{label} · {task.request.model} · {timeOf(task.createdAt)} 提交</p>
        </div>
        {task.status === 'running' ? <button type="button" className={css.button} onClick={() => void cancelTask(task.id)}>取消</button> : null}
      </div>
    }
    if (task.status === 'completed') {
      const images = hydrated[task.id] ?? []
      return <div className={css.taskCard}>
        {images.length > 0
          ? <div className={css.outputs}>{images.map((image, index) => { const src = image.url ?? (image.b64 ? `data:${image.mime ?? 'image/png'};base64,${image.b64}` : ''); return src ? <img key={`${src.slice(-30)}-${index}`} className={css.output} src={src} alt="" /> : null })}</div>
          : <p className={css.muted}>生成完成。</p>}
        <p className={css.muted}>生成完成 · {label} · {timeOf(task.finishedAt ?? task.createdAt)}</p>
      </div>
    }
    if (task.status === 'failed') {
      return <div className={css.taskCard}>
        <p role="alert" className={css.error}>生成失败：{task.error ?? '未知错误'}</p>
        <p className={css.muted}>{label} · {timeOf(task.createdAt)} 提交</p>
        <button type="button" className={css.button} onClick={() => void retryTask(task.id)}>重试</button>
      </div>
    }
    return <div className={css.taskCard}><p className={css.muted}>已取消 · {label}</p><button type="button" className={css.button} onClick={() => void retryTask(task.id)}>重新生成</button></div>
  }
  return <section className={css.root} data-outfit="true">
    <header className={css.intro}><div><h2>{tt('outfit.title')}</h2><p>{tt('outfit.hint')}</p></div><span className={css.badge}>{tt('outfit.uploadClothes', { count: recipe.costumes.length })}</span></header>
    <div className={css.body}>
      <form className={css.form} onSubmit={event => { event.preventDefault(); void (prepared ? submitOutfit() : preview()) }}>
        <fieldset className={css.formFields} disabled={formLocked}>
        <div className={css.pills} role="radiogroup" aria-label="搭配模式">
          <button type="button" className={css.pill} role="radio" aria-checked={recipe.mode === 'try-on'} onClick={() => update({ mode: 'try-on' })}>商品试穿</button>
          <button type="button" className={css.pill} role="radio" aria-checked={recipe.mode === 'character'} onClick={() => update({ mode: 'character' })}>角色搭配</button>
        </div>
        <p className={css.muted}>{recipe.mode === 'try-on' ? '保留真实商品图的款式、图案与配色，人物和服装为必选。' : '从图库挑人物、服装与姿势，也可混合自己的图片。'}</p>
        <div className={css.field}>
          <div className={css.fieldHead}><span className={css.fieldLabel}>人物参考</span><span className={css.fieldNote}>{tt('outfit.section.modelNote')}</span></div>
          {recipe.portrait ? <div className={css.selection}><img src={recipe.portrait.thumbnailUrl} alt={recipe.portrait.title} /><span>{recipe.portrait.title}</span><button type="button" className={css.button} onClick={() => update({ portrait: null })}>移除</button></div> : <p className={css.muted}>{tt('outfit.section.modelNote')}</p>}
          <button type="button" className={css.button} disabled={busy} onClick={() => setPicker('portrait')}>浏览人物图库</button>
        </div>
        <div className={css.field}>
          <div className={css.fieldHead}><span className={css.fieldLabel}>{tt('outfit.section.clothes')}</span><span className={css.fieldNote}>{tt('outfit.uploadClothes', { count: recipe.costumes.length })}</span></div>
          {recipe.costumes.length > 0 ? <ul className={css.thumbs}>{recipe.costumes.map((item, index) => <li className={css.thumb} key={`${item.key}-${index}`}><img src={item.thumbnailUrl} alt={item.title} /><span className={css.thumbIndex}>{index + 1}</span><button type="button" className={css.thumbRemove} aria-label={`${tt('outfit.remove')} ${item.title}`} onClick={() => update({ costumes: recipe.costumes.filter((_, n) => n !== index) })}>×</button></li>)}</ul> : <p className={css.muted}>尚未添加服装。商品试穿请上传真实商品图。</p>}
          <div className={css.inline}><button type="button" className={css.drop} disabled={busy || recipe.costumes.length >= MAX_CLOTHES} onClick={() => clothesInput.current?.click()}>{recipe.costumes.length >= MAX_CLOTHES ? tt('outfit.clothesFull') : '上传服装 / 商品图'}</button><button type="button" className={css.button} disabled={busy || recipe.costumes.length >= MAX_CLOTHES} onClick={() => setPicker('costume')}>浏览服装图库</button></div>
          <input ref={clothesInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { void uploadReference('costume', event.target.files); event.target.value = '' }} />
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>姿势参考（可选）</span>
          {recipe.pose ? <div className={css.selection}><img src={recipe.pose.thumbnailUrl} alt={recipe.pose.title} /><span>{recipe.pose.title}{recipe.pose.angle ? ` · ${recipe.pose.angle}` : ''}{recipe.pose.useDepth ? ' · Depth' : ''}</span><button type="button" className={css.button} onClick={() => update({ pose: null })}>移除</button></div> : <p className={css.muted}>不选则沿用人物原图的姿势。</p>}
          <div className={css.inline}><button type="button" className={css.button} disabled={busy} onClick={() => poseInput.current?.click()}>上传姿势</button><button type="button" className={css.button} disabled={busy} onClick={() => setPicker('pose')}>浏览姿势图库</button></div>
          <input ref={poseInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { void uploadReference('pose', event.target.files); event.target.value = '' }} />
        </div>
        <div className={css.field}><label className={css.fieldLabel} htmlFor="outfit-scene">{tt('outfit.scene')}</label><select id="outfit-scene" className={css.select} value={scenePreset} onChange={event => update({ scene: event.target.value === '自定义' ? '' : event.target.value })}>{SCENES.map(item => <option key={item}>{item}</option>)}<option>自定义</option></select>{scenePreset === '自定义' ? <input className={css.input} aria-label="自定义场景" placeholder="描述场景" value={recipe.scene} onChange={event => update({ scene: event.target.value })} /> : null}</div>
        <div className={css.field}><label className={css.fieldLabel} htmlFor="outfit-extra">补充要求</label><textarea id="outfit-extra" className={css.textarea} value={recipe.extraPrompt} placeholder="如光线、背景、画风与要保留的细节" onChange={event => update({ extraPrompt: event.target.value })} /></div>
        <div className={css.field}><span className={css.fieldLabel}>生成渠道和模型</span><ModelPicker groups={options.groups} value={choice} onChange={value => update({ channelId: value.channelId, model: value.model })} channelLabel="渠道" modelLabel="模型" emptyLabel="请先配置图像模型" channelPlaceholder="默认渠道" ariaLabel="穿戴生成模型" /></div>
        <div className={css.field}><span className={css.fieldLabel}>{tt('outfit.ratio')}</span><div className={css.pills} role="radiogroup" aria-label={tt('outfit.ratio')}>{RATIOS.map(value => <button key={value} type="button" className={css.pill} role="radio" aria-checked={recipe.size === value} onClick={() => update({ size: value })}>{value}</button>)}</div></div>
        <div className={css.field}><span className={css.fieldLabel}>{tt('outfit.resolution')}</span><div className={css.pills} role="radiogroup" aria-label={tt('outfit.resolution')}>{RESOLUTIONS.map(value => <button key={value} type="button" className={css.pill} role="radio" aria-checked={recipe.quality === value} onClick={() => update({ quality: value })}>{value}</button>)}</div></div>
        </fieldset>
        {/* 读失败时表单是解锁的，所以提示里必须说清「现在能改、但还存不下来」，
            否则用户改完以为保存了，切回来发现全没了。 */}
        {!draftLoaded ? <div className={css.field}><p role={draftError ? 'alert' : 'status'} className={draftError ? css.error : css.muted}>{draftError ? `${draftError} 现在仍可继续编辑，但草稿要等重新加载成功才会保存。` : '正在加载搭配草稿…'}</p>{draftError ? <button type="button" className={css.button} onClick={() => void reloadDraft()}>重试加载</button> : null}</div> : null}
        {draftLoaded && (saving || draftError) ? <p role={draftError ? 'alert' : 'status'} className={draftError ? css.error : css.muted}>{draftError || '正在保存搭配草稿…'}</p> : null}
        {modelMissing ? <p role="status" className={css.error}>{tt('outfit.modelMissing')}</p> : null}
        {!modelMissing && !supportsEdit ? <p role="status" className={css.error}>当前模型不支持参考图编辑，请切换生图模型。</p> : null}
        {recipe.mode === 'try-on' && !hasRequired ? <p className={css.muted}>请先选择人物和至少一张服装图。</p> : null}
        <div className={css.submitBar}><div className={css.submitRow}><button type="submit" className={css.primary} disabled={formLocked || !hasRequired || !supportsEdit || modelMissing || busy}>{busy ? tt('outfit.generating') : prepared ? '确认生成（使用以上预览）' : '准备参考图预览'}</button>{prepared ? <button type="button" className={css.button} disabled={busy} onClick={() => setPrepared(null)}>重新预览</button> : null}</div><small className={css.muted}>{tt('outfit.consistency')}</small>{error ? <p role="alert" className={css.error}>{error}</p> : null}</div>
      </form>
      <section className={css.results} aria-label="生成预览与结果">
        {prepared ? <div className={css.preview}><h3>提交前预览</h3><p className={css.muted}>本次共 {prepared.referenceCount} 张素材，实际发送 {prepared.sheet ? '一张编号参考拼图' : `${1 + prepared.images.length} 张参考图`}。点击“确认生成”才会调用模型。</p><div className={css.previewImages}>{[prepared.image, ...prepared.images].map((url, index) => <figure key={index}><img src={url} alt={prepared.sheet ? '实际发送的编号参考拼图' : `实际发送的参考图 ${index + 1}`} /><figcaption>{prepared.sheet ? '编号拼图' : `参考图 ${index + 1}`}</figcaption></figure>)}</div><details><summary>查看实际发送的提示词</summary><pre className={css.promptPreview}>{prepared.prompt}</pre></details></div> : null}
        {tasks.length > 0 ? <div className={css.taskList}>
          <h3>生成任务</h3>
          {tasks.slice(0, 20).map(task => <div key={task.id}>{renderTask(task)}</div>)}
        </div> : null}
        {tasks.length === 0 && !prepared ? <div className={css.empty}><span>{tt('outfit.emptyResults')}</span></div> : null}
      </section>
    </div>
    {picker ? <OutfitReferencePicker kind={picker} onSelect={chooseReference} onClose={() => setPicker(null)}
      {...(modelMissing ? {} : { generateModel })} /> : null}
  </section>
}

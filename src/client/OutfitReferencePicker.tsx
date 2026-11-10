/** 人物、服装、姿势图库共用选图器；原图只由宿主缓存并以同源地址交给生成流程。 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { modelReference, type OutfitReference, type OutfitReferenceApi, type OutfitReferenceKind, type OutfitListResult } from '../outfit-reference.ts'
import { outfitReferenceApi } from './outfit-reference-api.ts'
import css from './outfit-reference-picker.module.css'

const PAGE_SIZE = 24
const TITLES: Record<OutfitReferenceKind, string> = { portrait: '参考人像', costume: '参考服装', pose: '参考姿势' }
interface PickerProps {
  kind: OutfitReferenceKind
  api?: OutfitReferenceApi
  onSelect: (reference: OutfitReference) => void
  onClose: () => void
  /** 由工作台注入：用当前字渠道生成一张人像并直接存进模特库。
   *  图库本身不知道渠道与模型配置，也不应该知道。 */
  generateModel?: (prompt: string) => Promise<{ id: string; name: string; file: string }>
}

/** 禁止不可信数据让“查看来源”变成可执行或本机协议链接。 */
function safeSourceUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}

/** 缩略图可能来自未缓存的来源站；失败时保留可选的文字卡。 */
function PickerThumbnail({ item }: { item: OutfitReference }): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [item.thumbnailUrl])
  return failed || !item.thumbnailUrl
    ? <span className={css.missingThumbnail}>预览图不可用</span>
    : <img src={item.thumbnailUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
}

/** 将远程图库项先物化成已缓存的同源原图，再把选择交给工作台。 */
export function OutfitReferencePicker({ kind, api = outfitReferenceApi, onSelect, onClose, generateModel }: PickerProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const queryInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const closeHandler = useRef(onClose)
  closeHandler.current = onClose
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [source, setSource] = useState('')
  const [angle, setAngle] = useState('')
  const [offset, setOffset] = useState(0)
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [reload, setReload] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const lastRefresh = useRef(0)
  const [listing, setListing] = useState<OutfitListResult | null>(null)
  const [facets, setFacets] = useState<Pick<OutfitListResult, 'categories' | 'sources' | 'angles'>>({ categories: [], sources: [], angles: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<{ item: OutfitReference; viewId?: string; useDepth: boolean } | null>(null)
  /* Mobile back gesture (no extra button): on a phone the stacked detail pane
   * covers most of the dialog once an item is picked, so tapping the
   * still-visible upper level — title, search/filters, status bar — is the
   * natural way back to the grid; clearing the selection collapses the pane
   * (the CSS then lets the grid fill the dialog again). On the desktop
   * two-column layout the pane sits beside the grid, so header interactions
   * must NOT clear the selection — the handler no-ops above 680px. This is a
   * viewport query, not a theme read; it follows the optional-chaining form
   * the contract expects (see CanvasBackgrounds' reduced-motion checks). */
  const dismissSelectionOnUpperLevel = (): void => {
    if (globalThis.matchMedia?.('(max-width: 680px)').matches === true) setSelection(null)
  }
  const [preview, setPreview] = useState<{ selection: NonNullable<typeof selection>; reference: OutfitReference } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewImageFailed, setPreviewImageFailed] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [modelName, setModelName] = useState('')
  const [modelData, setModelData] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const [modelMessage, setModelMessage] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const modelInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    alive.current = true
    const node = dialog.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node?.showModal()
    queryInput.current?.focus()
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeHandler.current()
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      alive.current = false
      window.removeEventListener('keydown', escape, true)
      node?.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { setOffset(0); setQuery(input.trim()) }, 250)
    return () => window.clearTimeout(timer)
  }, [input])

  useEffect(() => {
    let ignore = false
    const force = refresh !== lastRefresh.current
    lastRefresh.current = refresh
    setLoading(true)
    setListing(null)
    setSelection(null)
    setError('')
    void api.list({ kind, query, category, source, angle, offset, limit: PAGE_SIZE, includeSensitive, refresh: force })
      .then(result => {
        if (ignore) return
        setListing(result)
        setFacets({ categories: result.categories, sources: result.sources, angles: result.angles })
      })
      .catch(cause => { if (!ignore) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [api, kind, query, category, source, angle, offset, includeSensitive, refresh, reload])

  useEffect(() => {
    if (!selection) { setPreview(null); setPreviewLoading(false); return }
    let ignore = false
    setPreview(null)
    setPreviewError('')
    setPreviewImageFailed(false)
    setPreviewLoading(true)
    void api.materialize({ key: selection.item.key, viewId: selection.viewId, useDepth: selection.useDepth })
      .then(materialized => { if (!ignore) setPreview({ selection, reference: materialized }) })
      .catch(cause => { if (!ignore) setPreviewError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!ignore) setPreviewLoading(false) })
    return () => { ignore = true }
  }, [api, selection])

  const readyPreview = preview?.selection === selection ? preview.reference : null
  const choose = (): void => {
    if (!readyPreview || previewLoading || importing || !alive.current) return
    alive.current = false
    onSelect(readyPreview)
  }

  const importDirectory = async (): Promise<void> => {
    if (!importPath.trim() || importing) return
    setImporting(true)
    setImportMessage('')
    try {
      const result = await api.importDirectory(importPath.trim())
      if (!alive.current) return
      setImportMessage(`已导入 ${result.count} 条素材，正在刷新图库。`)
      setOffset(0)
      setReload(value => value + 1)
    } catch (cause) {
      if (alive.current) setImportMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setImporting(false)
    }
  }

  /** 人物图库同时是模特库：选一张图存进宿主模特库，存好即可直接选中使用。 */
  const pickModelFile = async (file: File | undefined): Promise<void> => {
    if (!file || !alive.current) return
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setModelMessage('仅支持 PNG、JPEG、WebP 或 GIF 图片'); return }
    if (file.size === 0 || file.size > 20 * 1024 * 1024) { setModelMessage('文件不能超过 20 MiB'); return }
    setModelMessage('')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取文件失败'))
      reader.onerror = reader.onabort = () => reject(new Error('读取文件失败'))
      reader.readAsDataURL(file)
    }).catch(cause => { if (alive.current) setModelMessage(cause instanceof Error ? cause.message : String(cause)); return '' })
    if (!data || !alive.current) return
    setModelData(data)
    setModelName(file.name.replace(/\.[^.]+$/, '').slice(0, 60))
  }
  const saveModel = async (): Promise<void> => {
    if (!api.saveModel || !modelData || modelBusy || !alive.current) return
    setModelBusy(true); setModelMessage('')
    try {
      const saved = await api.saveModel({ name: modelName.trim() || '我的模特', data: modelData, mime: /^data:(image\/[a-z]+);/.exec(modelData)?.[1] ?? 'image/png' })
      if (!alive.current) return
      setModelData(''); setModelName(''); setOffset(0); setReload(value => value + 1)
      // 存完就选中它：用户来这里就是要用这个人，不该再去列表里翻一遍。
      setSelection({ item: modelReference(saved), useDepth: false })
    } catch (cause) { if (alive.current) setModelMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setModelBusy(false) }
  }

  const generateAiModel = async (): Promise<void> => {
    if (!generateModel || !aiPrompt.trim() || aiBusy || !alive.current) return
    setAiBusy(true); setModelMessage('')
    try {
      const saved = await generateModel(aiPrompt.trim())
      if (!alive.current) return
      setAiPrompt(''); setOffset(0); setReload(value => value + 1)
      setSelection({ item: modelReference(saved), useDepth: false })
    } catch (cause) { if (alive.current) setModelMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setAiBusy(false) }
  }

  const pageCount = listing ? Math.ceil(listing.total / PAGE_SIZE) : 0
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const sourceUrl = selection ? safeSourceUrl(selection.item.sourceUrl) : undefined
  if (typeof document === 'undefined') return <></>
  return createPortal(<dialog ref={dialog} className={css.dialog} aria-label={`选择${TITLES[kind]}`} data-outfit-reference-picker=""
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className={css.panel}>
      <header className={css.header} onClick={dismissSelectionOnUpperLevel}>
        <div><h2>选择{TITLES[kind]}</h2><p>选中后保存到本机，再交给当前图像模型作为参考。</p></div>
        <button className={css.close} type="button" onClick={onClose} aria-label="关闭素材选择器">×</button>
      </header>
      <div className={css.toolbar} onClick={dismissSelectionOnUpperLevel}>
        <label className={css.search}>搜索名称或标签
          <input ref={queryInput} type="search" value={input} placeholder={`搜索${TITLES[kind]}…`} onChange={event => setInput(event.target.value)} />
        </label>
        <label>分类
          <select value={category} onChange={event => { setCategory(event.target.value); setOffset(0) }}>
            <option value="">全部分类</option>
            {category && !facets.categories.includes(category) ? <option value={category}>{category}</option> : null}
            {facets.categories.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>来源
          <select value={source} onChange={event => { setSource(event.target.value); setOffset(0) }}>
            <option value="">全部来源</option>
            {source && !facets.sources.some(value => value.id === source) ? <option value={source}>{source}</option> : null}
            {facets.sources.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select>
        </label>
        {kind === 'pose' ? <label>视角
          <select value={angle} onChange={event => { setAngle(event.target.value); setOffset(0) }}>
            <option value="">全部视角</option>
            {angle && !facets.angles.includes(angle) ? <option value={angle}>{angle}</option> : null}
            {facets.angles.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label> : null}
        <label className={css.check}><input type="checkbox" checked={includeSensitive} onChange={event => { setIncludeSensitive(event.target.checked); setOffset(0) }} />显示敏感素材（18+）</label>
      </div>
      <div className={css.statusBar} onClick={dismissSelectionOnUpperLevel}>
        <span role="status">{loading ? '正在加载图库…' : error ? '加载失败' : `${listing?.total ?? 0} 条素材 · 第 ${currentPage} 页${pageCount ? ` / ${pageCount} 页` : ''}`}</span>
        <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>更新索引</button>
        <span className={css.revision}>{listing?.revision ? `数据版本 ${listing.revision.slice(0, 10)}` : ''}</span>
      </div>
      {listing?.warnings.map((warning, index) => <p key={`${warning}-${index}`} className={css.warning} role="status">{warning}</p>)}
      {kind === 'portrait' && (api.saveModel || generateModel) ? <div className={css.modelRow} data-outfit-model-add="">
        <span className={css.modelRowLabel}>我的模特</span>
        {modelData
          ? <>
            <img className={css.modelPick} src={modelData} alt="待保存的模特预览" />
            <input type="text" value={modelName} aria-label="模特名称" placeholder="模特名称" onChange={event => setModelName(event.target.value)} />
            <button type="button" disabled={modelBusy} onClick={() => void saveModel()}>{modelBusy ? '保存中…' : '保存到模特库'}</button>
            <button type="button" disabled={modelBusy} onClick={() => { setModelData(''); setModelName(''); setModelMessage('') }}>取消</button>
          </>
          : <><span className={css.modelRowNote}>把常用人物存进模特库，下次直接在人物图库里挑。</span>
            {api.saveModel ? <button type="button" onClick={() => modelInput.current?.click()}>添加模特照片</button> : null}</>}
        {generateModel && !modelData ? <>
          <input type="text" value={aiPrompt} aria-label="描述模特" placeholder="描述模特，如：短发亚洲女性，正面半身照" onChange={event => setAiPrompt(event.target.value)} />
          <button type="button" disabled={aiBusy || !aiPrompt.trim()} onClick={() => void generateAiModel()}>{aiBusy ? '生成中…' : 'AI 生成模特'}</button>
        </> : null}
        <input ref={modelInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { void pickModelFile(event.target.files?.[0]); event.target.value = '' }} />
        {modelMessage ? <span role="alert" className={css.modelRowError}>{modelMessage}</span> : null}
      </div> : null}
      <div className={css.content}>
        <section className={css.browser} aria-label={`${TITLES[kind]}列表`}>
          {error ? <div className={css.notice} role="alert">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重试加载</button></div> : null}
          {loading ? <p className={css.notice} role="status">正在获取素材索引…</p> : null}
          {!loading && !error && listing?.total === 0 ? <p className={css.notice}>没有符合条件的素材。试试清除搜索词或调整筛选。</p> : null}
          {!loading && !error && listing ? <ul className={css.grid}>
            {listing.items.map(item => <li key={item.key}>
              <button type="button" className={css.card} aria-pressed={selection?.item.key === item.key}
                onClick={() => setSelection({ item, viewId: item.viewId || item.views?.[0]?.id, useDepth: false })}>
                <span className={css.thumbnail}><PickerThumbnail item={item} /></span>
                <span className={css.cardName}>{item.title}</span>
                <span className={css.cardMeta}>{item.category}{item.angle ? ` · ${item.angle}` : ''}</span>
                {item.sensitive ? <span className={css.sensitive}>18+</span> : null}
              </button>
            </li>)}
          </ul> : null}
          {!loading && !error && pageCount > 1 ? <nav className={css.pagination} aria-label="素材分页">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>上一页</button>
            <span>{currentPage} / {pageCount}</span>
            <button type="button" disabled={offset + PAGE_SIZE >= (listing?.total ?? 0)} onClick={() => setOffset(value => value + PAGE_SIZE)}>下一页</button>
          </nav> : null}
        </section>
        <aside className={css.detail} aria-label="素材详情与预览">
          {selection ? <>
            <h3>{selection.item.title}</h3>
            <p className={css.meta}>{selection.item.category}{selection.item.angle ? ` · ${selection.item.angle}` : ''}</p>
            <p className={css.meta}>{facets.sources.find(value => value.id === selection.item.source)?.label ?? selection.item.source}</p>
            {selection.item.tags.length > 0 ? <p className={css.tags}>{selection.item.tags.slice(0, 8).join(' · ')}</p> : null}
            {selection.item.views && selection.item.views.length > 0 ? <label className={css.viewSelect}>服装视角
              <select value={selection.viewId ?? ''} onChange={event => setSelection({ ...selection, viewId: event.target.value })}>
                {selection.item.views.map(view => <option key={view.id} value={view.id}>{view.label}</option>)}
              </select>
            </label> : null}
            {kind === 'pose' ? <label className={css.check}><input type="checkbox" checked={selection.useDepth} onChange={event => setSelection({ ...selection, useDepth: event.target.checked })} />使用深度图参考（非 ControlNet 控制）</label> : null}
            {previewLoading ? <p role="status">正在下载并缓存原图…</p> : null}
            {previewError ? <p className={css.error} role="alert">原图获取失败：{previewError}<button type="button" onClick={() => setSelection({ ...selection })}>重试原图</button></p> : null}
            {readyPreview && !previewLoading && !previewError ? <figure className={css.preview}>
              {previewImageFailed ? <div className={css.previewFailed} role="alert">本地图像预览失败，暂不能选择此素材。<button type="button" onClick={() => setSelection({ ...selection })}>重试原图</button></div> : <img src={readyPreview.imageUrl} alt={`${readyPreview.title} 原图预览`} onError={() => setPreviewImageFailed(true)} />}
              {!previewImageFailed ? <figcaption>生成时使用这张已缓存的原图。</figcaption> : null}
            </figure> : null}
          </> : <p className={css.notice}>点选左侧素材，查看原图与使用说明。</p>}
        </aside>
      </div>
      <footer className={css.footer}>
        <div className={css.sourceNote}>
          <p>{selection?.item.notice ?? '素材归各来源原作者所有，部分素材不允许商用；请确认来源许可后使用。'}</p>
          {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a> : <a href="https://github.com/anhao/ai-pose-gallery-zh" target="_blank" rel="noopener noreferrer">图库项目及来源说明 ↗</a>}
        </div>
        <button type="button" className={css.primary} disabled={!readyPreview || previewLoading || previewImageFailed || importing || loading || !!error} onClick={choose}>使用这张参考图</button>
      </footer>
      <form className={css.importRow} onSubmit={event => { event.preventDefault(); void importDirectory() }}>
        <label htmlFor="outfit-reference-directory">已有本地图库？导入其目录</label>
        <input id="outfit-reference-directory" type="text" value={importPath} onChange={event => setImportPath(event.target.value)} placeholder="完整路径（如 ~/Downloads/ai-pose-gallery-zh）" />
        <button type="submit" disabled={!importPath.trim() || importing}>{importing ? '导入中…' : '导入离线图库'}</button>
        {importMessage ? <span role="status" className={css.importMessage}>{importMessage}</span> : null}
      </form>
    </div>
  </dialog>, document.body)
}

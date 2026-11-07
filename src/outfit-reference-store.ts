/** 姿势、服装、人像的固定版本索引与按需落盘素材。 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { imageDataRoot } from './image-storage-path.ts'
import { listModels, type ModelEntry } from './model-store.ts'
import { MODEL_API } from './protocol.ts'
import { OUTFIT_API, modelReference, type OutfitListRequest, type OutfitListResult, type OutfitMaterializeRequest, type OutfitReference, type OutfitReferenceKind, type OutfitRecipe, type OutfitUploadRequest } from './outfit-reference.ts'

const REVISION = '488939139c69acfe078372b39d4bd0c457dc060e'
const SOURCES = [
  { file: 'pose-zh', kind: 'pose', source: 'gia', sha: '4a7c9db1ecde0a922a8b052b34b1f538c73b1333' },
  { file: 'portrait-zh', kind: 'portrait', source: 'gia', sha: '388b8dfc4b82032029a510f134c09bd709f2205f' },
  { file: 'costume-zh', kind: 'costume', source: 'gia', sha: '250e3b9584205f22360944661788d05243f482fe' },
  { file: 'costume-anime-zh', kind: 'costume', source: 'charadb', sha: 'bf9995580eb6a518f81306b45176b4fce0c19b50' },
  { file: 'costume-gia-anime-zh', kind: 'costume', source: 'gia-anime', sha: 'e34459b96bfa01bc10cc1db44e71422d3e109553' },
  { file: 'costume-shisei-zh', kind: 'costume', source: 'shisei', sha: '4a4104398eca8a864d9890924e407bde5cb32f0e' },
] as const
const ORIGINS: Record<string, { label: string; origin: string; notice: string }> = {
  gia: { label: 'ギア · 写实', origin: 'https://ai-costume-gallery.pages.dev/', notice: '原作者ギア；图片不适用本插件代码许可证，请遵守原站使用条款。' },
  charadb: { label: 'たき AI · CharaDB', origin: 'https://charadb-2fi.pages.dev/', notice: '来源 CharaDB；图片权利归原作者，须遵守原站条款。' },
  'gia-anime': { label: 'ギア · 动漫', origin: 'https://ai-costume-anime-gallery.pages.dev/', notice: '动漫参考图片由ギア站点托管，请遵守原站条款。' },
  shisei: { label: 'Shisei · 中国历代', origin: 'https://github.com/wquguru/shisei', notice: 'Shisei 参考图，非历史服饰考据复原。' },
  upload: { label: '我的上传', origin: '', notice: '' },
  // 模特库不是远程图库，而是宿主已经落盘的本机图片；放在人物图库里一起浏览，
  // 不再让工作台为它维护第二套选择界面。
  model: { label: '我的模特', origin: '', notice: '' },
}
const IMAGE_HOSTS = new Set(['raw.githubusercontent.com', 'ai-pose-gallery.anhao.app', 'ai-pose-gallery.pages.dev', 'ai-costume-gallery.pages.dev', 'ai-portrait-gallery.pages.dev', 'charadb-2fi.pages.dev', 'ai-costume-anime-gallery.pages.dev'])
const MAX_IMAGE = 10 * 1024 * 1024
const MAX_INDEX = 5 * 1024 * 1024
const imageType = (data: Buffer): { mime: string; ext: string } | null => {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { mime: 'image/jpeg', ext: 'jpg' }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (data.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' }
  return null
}
type Source = typeof SOURCES[number]
type Raw = Record<string, unknown>
type Item = { ref: OutfitReference; image: string; thumb: string; views: Record<string, { image: string; thumb: string }> }
type Catalog = { revision: string; rows: Item[] }
const text = (x: unknown): string => typeof x === 'string' ? x : ''
const digest = (x: string): string => createHash('sha256').update(x).digest('hex')
const safeAsset = (x: string): boolean => /^(img|thumbs)\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif)$/.test(x) && !x.split('/').includes('..')

/** 目录数据只能指向来源白名单；重定向、任意站点和协议均不可信。 */
export function outfitAssetUrl(src: string): string {
  if (safeAsset(src)) return `https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/${REVISION}/${src}`
  const url = new URL(src)
  const githubPrefix = `/anhao/ai-pose-gallery-zh/${REVISION}`
  const expectedPath = url.hostname === 'raw.githubusercontent.com' ? url.pathname.startsWith(`${githubPrefix}/`) ? url.pathname.slice(githubPrefix.length) : '' : url.pathname
  // 可信站点有的图片不带扩展名；落盘前再按图片魔数校验 MIME。
  const imagePath = /^\/(?:img|png|thumb|thumbs)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.(?:png|jpe?g|webp|gif))?$/
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !imagePath.test(expectedPath)) throw new Error('图库图片地址不在可信来源内')
  return url.toString()
}

/** 字段顺序不参与键；姿势每个角度为独立项目，服装 views 共用服装键。 */
function normalize(raw: Raw, source: Source): Item {
  const id = text(raw.id)
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('图库条目 ID 无效')
  const kind = source.kind
  const actualSource = source.source
  const key = `${kind}:${actualSource}:${id}`
  const images: Item['views'] = {}
  if (Array.isArray(raw.views)) for (const view of raw.views) {
    if (!view || typeof view !== 'object') continue
    const v = view as Raw
    const viewId = text(v.id)
    if (/^[a-zA-Z0-9_-]{1,40}$/.test(viewId)) images[viewId] = { image: text(v.原图), thumb: text(v.缩略图) }
  }
  const image = text(raw.原图)
  const thumb = text(raw.缩略图) || image
  outfitAssetUrl(image); outfitAssetUrl(thumb)
  for (const view of Object.values(images)) { outfitAssetUrl(view.image); outfitAssetUrl(view.thumb) }
  const category = kind === 'pose' ? `${text(raw.体系)} · ${text(raw.分类)}` : kind === 'portrait' ? `${text(raw.分区)} · ${text(raw.发长)}` : text(raw.分类)
  const sensitive = raw.敏感 === true || (kind === 'pose' && /性感|缠绵/.test(text(raw.体系))) || (kind === 'costume' && /内衣|性感/.test(category))
  const origin = ORIGINS[actualSource]
  const ref: OutfitReference = {
    key, kind, source: actualSource, sourceUrl: text(raw.来源地址) || origin.origin, revision: REVISION,
    title: kind === 'pose' ? text(raw.姿势名称) : kind === 'portrait' ? text(raw.标题) : text(raw.服装名称), category,
    tags: Array.isArray(raw.标签) ? raw.标签.filter((s): s is string => typeof s === 'string') : kind === 'portrait' ? [text(raw.发型名称)] : [],
    thumbnailUrl: `${OUTFIT_API.image}/thumb/${encodeURIComponent(key)}`,
    imageUrl: `${OUTFIT_API.image}/full/${encodeURIComponent(key)}`,
    ...kind === 'pose' ? { angle: text(raw.角度), group: `${text(raw.体系)}:${text(raw.姿势编号)}` } : {},
    ...Object.keys(images).length ? { views: Object.keys(images).map(viewId => ({ id: viewId, label: text((raw.views as Raw[]).find(v => v.id === viewId)?.label) || viewId })) } : {},
    ...typeof raw.selectedView === 'string' ? { viewId: raw.selectedView } : {},
    sensitive, notice: origin.notice,
  }
  return { ref, image, thumb, views: images }
}

/**
 * Mirror candidates for one image.
 *
 * Only repo-relative paths (what the pinned index actually contains) can be
 * mirrored by commit. A third-party absolute URL from the index keeps its own
 * single host — rewriting it onto a mirror would silently fetch different
 * bytes. The caller re-checks magic bytes, so a wrong answer is a failed source
 * rather than a corrupt cache entry.
 */
function imageUrls(src: string): string[] {
  if (!safeAsset(src)) return [outfitAssetUrl(src)]
  // jsDelivr 各全球节点：raw.githubusercontent.com 在本网络间歇不可达，
  // cdn 主节点对图片回源到 raw，而 gcore/testingcf 等节点直连返回。
  const mirror = (host: string) => `https://${host}/gh/anhao/ai-pose-gallery-zh@${REVISION}/${src}`
  return [
    outfitAssetUrl(src),
    mirror('gcore.jsdelivr.net'),
    mirror('testingcf.jsdelivr.net'),
    mirror('cdn.jsdelivr.net'),
    mirror('fastly.jsdelivr.net'),
  ]
}

/**
 * Ordered places a fixed-commit index can be read from.
 *
 * `raw.githubusercontent.com` is the canonical source but is regularly
 * unreachable from this network (measured: three 18s timeouts in a row while
 * both mirrors answered in 2-8s). A single source therefore meant "one flaky
 * host = that whole category permanently empty", which is what a real user hit
 * on the pose tab. Every candidate serves the SAME pinned commit and is checked
 * against the same Git blob SHA below, so a mirror cannot smuggle in different
 * material — it either matches or is discarded.
 */
function indexUrls(source: Source): string[] {
  const file = `data/${source.file}.json`
  const mirror = (host: string) => `https://${host}/gh/anhao/ai-pose-gallery-zh@${REVISION}/${file}`
  return [
    `https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/${REVISION}/${file}`,
    // The GitHub API returns the blob base64-inlined, which needs its own
    // decode; see `fetchIndex` below.
    `https://api.github.com/repos/anhao/ai-pose-gallery-zh/contents/${file}?ref=${REVISION}`,
    mirror('gcore.jsdelivr.net'),
    mirror('testingcf.jsdelivr.net'),
    mirror('cdn.jsdelivr.net'),
    mirror('fastly.jsdelivr.net'),
  ]
}

/** 图片和索引分别限制读取字节。跟随重定向以兼容回源 CDN（实测
 *  jsDelivr 对图片返回 301 到 raw.githubusercontent.com）；最终内容仍由 Git
 *  blob / 魔数校验兜底，即使被跳转到任意站点也只会取不到合法内容，
 *  不会写进缓存。 */
async function boundedFetch(url: string, maximum: number, fetcher: typeof fetch, timeoutMs = 18_000): Promise<Buffer> {
  const result = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!result.ok || !result.body || result.redirected || result.status >= 300) throw new Error(`图库资源请求失败（HTTP ${result.status}）`)
  if (Number(result.headers.get('content-length')) > maximum) {
    await result.body.cancel().catch(() => undefined)
    throw new Error('图库资源超过大小限制')
  }
  const reader = result.body.getReader()
  const parts: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new Error('图库资源超过大小限制')
      }
      parts.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts)
}

/** 索引 sha 对应 Git blob，而不是 HTTP ETag，避免镜像返回非固定版本。 */
function verifyGitBlob(content: Buffer, expected: string): void {
  const header = Buffer.from(`blob ${content.byteLength}\0`)
  if (createHash('sha1').update(header).update(content).digest('hex') !== expected) throw new Error('远端图库索引版本已变化，请等待插件更新固定版本')
}

/**
 * Read one pinned index, trying each source in order.
 *
 * Each attempt is independently time-boxed and verified; a source that answers
 * with something that does not hash to the pinned commit is treated as a failed
 * source, not as a fatal error, so the next one still gets its turn. The
 * per-source reason is kept so the user sees WHY the category is empty instead
 * of a bare "fetch failed".
 */
async function fetchIndex(source: Source, maximum: number, fetcher: typeof fetch): Promise<Buffer> {
  const reasons: string[] = []
  for (const url of indexUrls(source)) {
    try {
      // The GitHub API wrapper is JSON, not the raw blob, and is larger than
      // the blob itself. Everything is checked after the decode below anyway.
      const fromApi = url.startsWith('https://api.github.com/')
      const body = await boundedFetch(url, fromApi ? maximum * 3 : maximum, fetcher, 25_000)
      let content = body
      if (fromApi) {
        const envelope = JSON.parse(body.toString('utf8')) as { content?: string; encoding?: string }
        if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string') throw new Error('镜像返回的索引结构不可识别')
        content = Buffer.from(envelope.content, 'base64')
        if (content.byteLength > maximum) throw new Error('图库索引超出限制')
      }
      verifyGitBlob(content, source.sha)
      return content
    } catch (error) {
      reasons.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`所有索引来源都失败（${reasons.join('；')}）`)
}

async function atomic(file: string, value: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(tmp, value); await fs.rename(tmp, file) } finally { await fs.rm(tmp, { force: true }).catch(() => undefined) }
}

function sourceFor(kind: OutfitReferenceKind): readonly Source[] { return SOURCES.filter(s => s.kind === kind) }
const isKind = (kind: unknown): kind is OutfitReferenceKind => kind === 'portrait' || kind === 'costume' || kind === 'pose'
/** 用户上传和目录导入只复制图片到插件的数据目录，不从任意文件路径实时提供。 */
function importedPath(src: string, root: string): string {
  if (!safeAsset(src)) throw new Error('素材相对路径无效')
  const absolute = path.resolve(root, src)
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('素材路径越界')
  return absolute
}

/** 单进程写队列保护导入/上传与草稿的原子替换。 */
export class OutfitReferenceStore {
  private readonly root: string
  private readonly fetcher: typeof fetch
  private readonly inflight = new Map<string, Promise<Catalog>>()
  private readonly staleWarnings = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private importedRoot: string | null = null
  constructor(options: { root?: string; fetcher?: typeof fetch } = {}) {
    this.root = options.root ?? path.join(imageDataRoot(), 'outfit')
    this.fetcher = options.fetcher ?? fetch
  }
  private file(...parts: string[]): string { return path.join(this.root, ...parts) }
  private async storedRoot(): Promise<string | null> {
    if (this.importedRoot !== null) return this.importedRoot
    try { const found = (await fs.readFile(this.file('import-root.txt'), 'utf8')).trim(); return found || null } catch { return null }
  }
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const job = this.queue.then(task, task)
    this.queue = job.catch(() => undefined)
    return job
  }
  private async catalog(source: Source, refresh = false): Promise<Catalog> {
    const key = source.file
    if (this.inflight.has(key)) return this.inflight.get(key)!
    const job = this.getCatalog(source, refresh).finally(() => { this.inflight.delete(key) })
    this.inflight.set(key, job)
    return job
  }
  private async getCatalog(source: Source, refresh: boolean): Promise<Catalog> {
    const cache = this.file('catalog', `${source.file}.json`)
    let existing: Catalog | null = null
    try { const parsed = JSON.parse(await fs.readFile(cache, 'utf8')) as Catalog; if (parsed.revision === REVISION && Array.isArray(parsed.rows)) existing = parsed } catch { /* no cached index */ }
    if (existing && !refresh) return existing
    try {
      const local = await this.storedRoot()
      let data: Buffer
      if (local) data = await fs.readFile(path.join(local, 'data', `${source.file}.json`))
      else data = await fetchIndex(source, MAX_INDEX, this.fetcher)
      if (data.byteLength > MAX_INDEX) throw new Error('图库索引超出限制')
      if (!local) verifyGitBlob(data, source.sha)
      const raw: unknown = JSON.parse(data.toString('utf8'))
      if (!Array.isArray(raw)) throw new Error('图库索引格式不正确')
      const rows = raw.map(row => normalize(row as Raw, source))
      const catalog = { revision: REVISION, rows }
      await atomic(cache, JSON.stringify(catalog))
      this.staleWarnings.delete(source.file)
      return catalog
    } catch (error) {
      if (existing) { this.staleWarnings.set(source.file, `${source.file} 更新失败，正在使用已有离线索引：${error instanceof Error ? error.message : String(error)}`); return existing }
      throw error
    }
  }
  /** 搜索不做全站下载：单类索引小于 5MiB，页内容只有预览路径。 */
  async list(request: OutfitListRequest): Promise<OutfitListResult> {
    if (!isKind(request.kind)) throw new Error('图库类型无效')
    const warnings: string[] = []
    const chunks = await Promise.all(sourceFor(request.kind).map(async source => {
      try { return (await this.catalog(source, Boolean(request.refresh))).rows } catch (error) { warnings.push(`${source.file}：${error instanceof Error ? error.message : String(error)}`); return [] as Item[] }
    }))
    for (const source of sourceFor(request.kind)) { const warning = this.staleWarnings.get(source.file); if (warning) warnings.push(warning) }
    // 人物图库把本机模特库当作一种来源：模特条目排在最前，因为它们通常是
    // 用户自己攒下的固定人物，而不是要挑的内置素材。
    const models = request.kind === 'portrait' ? (await listModels()).map(modelReference) : []
    const visible = [...models, ...chunks.flat().map(x => x.ref), ...(await this.readUploads()).filter(x => x.kind === request.kind)]
      .filter(x => request.includeSensitive === true || !x.sensitive)
    const query = (request.query ?? '').trim().toLocaleLowerCase()
    const category = request.category ?? ''
    const source = request.source ?? ''
    const angle = request.angle ?? ''
    const filtered = visible.filter(x => (!category || x.category === category) && (!source || x.source === source) && (!angle || x.angle === angle) && (!query || [x.title, x.category, x.key, x.group, x.angle, ...x.tags].join(' ').toLocaleLowerCase().includes(query)))
    const offset = Math.min(100_000, Math.max(0, Math.floor(request.offset ?? 0)))
    const limit = Math.min(100, Math.max(1, Math.floor(request.limit ?? 24)))
    return {
      items: filtered.slice(offset, offset + limit), total: filtered.length, categories: [...new Set(visible.map(x => x.category))].sort(),
      sources: [...new Set(visible.map(x => x.source))].map(id => ({ id, label: ORIGINS[id]?.label ?? id })),
      angles: [...new Set(visible.map(x => x.angle).filter((x): x is string => Boolean(x)))], revision: REVISION, warnings,
    }
  }
  private async find(key: string): Promise<Item> {
    const [kind, sourceName] = key.split(':')
    if (!isKind(kind) || !sourceName) throw new Error('素材标识无效')
    const source = sourceFor(kind).find(s => s.source === sourceName)
    if (!source) throw new Error('素材来源无效')
    const item = (await this.catalog(source)).rows.find(row => row.ref.key === key)
    if (!item) throw new Error('素材不存在')
    return item
  }
  private variant(item: Item, viewId: string | undefined, useDepth: boolean, thumb: boolean): string {
    const selected = viewId ? item.views[viewId] : item.views[item.ref.viewId || '']
    if (viewId && !selected) throw new Error('该服装没有所选视角')
    let src = selected ? (thumb ? selected.thumb : selected.image) : (thumb ? item.thumb : item.image)
    if (useDepth) {
      if (item.ref.kind !== 'pose') throw new Error('只有姿势素材支持深度图')
      if (!/^(img|thumbs)\//.test(src)) throw new Error('深度图路径无效')
      src = src.replace(/^(img|thumbs)\//, '$1/depth/').replace(/\.(png|jpe?g)$/i, '.webp')
    }
    outfitAssetUrl(src)
    return src
  }
  private async fetchImage(src: string): Promise<Buffer> {
    const local = await this.storedRoot()
    if (local && safeAsset(src)) {
      const file = importedPath(src, local)
      const real = await fs.realpath(file)
      const root = await fs.realpath(local)
      if (!real.startsWith(root + path.sep)) throw new Error('本地素材不能是目录外的符号链接')
      return fs.readFile(real)
    }
    // The same reason the index needs mirrors, but worse: when raw.github is
    // unreachable EVERY card renders "预览图不可用" (measured: 18 of 18 on the
    // pose tab). A mirror that answers with an HTML error page is skipped as
    // "not an image" and the next candidate gets its turn, so one bad mirror
    // cannot starve the rest; only a real image returns.
    const reasons: string[] = []
    for (const url of imageUrls(src)) {
      try {
        const data = await boundedFetch(url, MAX_IMAGE, this.fetcher)
        if (imageType(data)) return data
        reasons.push(`${new URL(url).hostname}: 返回的不是图片内容`)
      } catch (error) { reasons.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    throw new Error(`图库图片不可用（${reasons.join('；')}）`)
  }
  private imageName(key: string, viewId: string | undefined, useDepth: boolean, thumb: boolean): string {
    return digest([REVISION, key, viewId ?? '', useDepth ? 'depth' : 'white', thumb ? 'thumb' : 'full'].join('|'))
  }
  private async persistImage(key: string, viewId: string | undefined, useDepth: boolean, thumb: boolean): Promise<{ file: string; mime: string }> {
    const stem = this.imageName(key, viewId, useDepth, thumb)
    const directory = this.file('images')
    const existing = (await fs.readdir(directory).catch(() => [] as string[])).find(name => name.startsWith(`${stem}.`) && /\.(png|jpg|webp|gif)$/.test(name))
    if (existing) {
      const bytes = await fs.readFile(this.file('images', existing))
      const detected = imageType(bytes)
      if (detected && bytes.byteLength <= MAX_IMAGE) return { file: existing, mime: detected.mime }
    }
    const item = await this.find(key)
    const data = await this.fetchImage(this.variant(item, viewId, useDepth, thumb))
    const detected = imageType(data)
    if (!detected || !data.length || data.byteLength > MAX_IMAGE) throw new Error('图库素材不是有效的 10MB 以内图片')
    const file = `${stem}.${detected.ext}`
    await atomic(this.file('images', file), data)
    return { file, mime: detected.mime }
  }
  /** 原图复制进插件数据目录后才返回选择结果，避免随后第三方链接失效。 */
  async materialize(request: OutfitMaterializeRequest): Promise<OutfitReference> {
    // 模特条目本来就已落盘在宿主模特库，不需要再下载或复制一份。
    if (request.key.startsWith('model:')) {
      const model = (await listModels()).find(entry => `model:${entry.id}` === request.key)
      if (!model || request.viewId || request.useDepth) throw new Error('草稿模特未在模特库中')
      return modelReference(model)
    }
    if (request.key.includes(':upload:')) {
      const uploaded = (await this.readUploads()).find(entry => entry.key === request.key)
      if (!uploaded || request.viewId || request.useDepth) throw new Error('上传素材没有可选视角或深度图')
      return uploaded
    }
    const item = await this.find(request.key)
    const viewId = request.viewId || item.ref.viewId
    const useDepth = request.useDepth === true
    const saved = await this.persistImage(item.ref.key, viewId, useDepth, false)
    return { ...item.ref, imageUrl: `${OUTFIT_API.image}/${saved.file}`, ...(viewId ? { viewId } : {}), ...(useDepth ? { useDepth: true } : {}) }
  }
  /** 缩略图在 HTTP GET 时按需缓存在插件目录；不会提前下载整个图包。 */
  async preview(key: string, thumb: boolean): Promise<{ mime: string; data: Buffer }> {
    const item = await this.find(key)
    const saved = await this.persistImage(key, item.ref.viewId, false, thumb)
    return { mime: saved.mime, data: await fs.readFile(this.file('images', saved.file)) }
  }
  async image(file: string): Promise<{ mime: string; data: Buffer } | null> {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(file)) return null
    const data = await fs.readFile(this.file('images', file)).catch(() => null)
    const type = data && imageType(data)
    return data && type && data.byteLength <= MAX_IMAGE ? { mime: type.mime, data } : null
  }
  /** 上传图片完成后生成专属本机素材键；服务端以魔数而非扩展名作准。 */
  async upload(input: OutfitUploadRequest): Promise<OutfitReference> {
    if (!isKind(input.kind) || typeof input.name !== 'string' || typeof input.data !== 'string') throw new Error('上传参数无效')
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(input.data)
    if (!match || match[2]!.length > Math.ceil(MAX_IMAGE * 4 / 3) + 4) throw new Error('上传图片必须是 10MB 以内 PNG/JPEG/WebP/GIF')
    const data = Buffer.from(match[2]!, 'base64')
    const type = imageType(data)
    if (!type || type.mime !== match[1] || data.length === 0 || data.length > MAX_IMAGE) throw new Error('上传文件格式或大小无效')
    return this.serialized(async () => {
      const key = `${input.kind}:upload:${randomUUID()}`
      const file = `${digest(key)}.${type.ext}`
      await atomic(this.file('images', file), data)
      const ref: OutfitReference = {
        key, kind: input.kind, source: 'upload', sourceUrl: '', revision: 'local', title: input.name.trim().slice(0, 120) || '我的图片',
        category: '我的上传', tags: [], thumbnailUrl: `${OUTFIT_API.image}/${file}`, imageUrl: `${OUTFIT_API.image}/${file}`,
      }
      const old = await this.readUploads()
      await atomic(this.file('uploads.json'), JSON.stringify([ref, ...old]))
      return ref
    })
  }
  private async readUploads(): Promise<OutfitReference[]> {
    try { const value = JSON.parse(await fs.readFile(this.file('uploads.json'), 'utf8')) as unknown; return Array.isArray(value) ? value as OutfitReference[] : [] } catch { return [] }
  }
  /** 路径输入只影响目录内的仓库镜像，不暴露本机其他文件给 HTTP 请求。 */
  async importDirectory(directory: string): Promise<{ count: number }> {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('请填写图库目录')
    const candidate = directory.startsWith('~/') ? path.join(process.env.HOME ?? '', directory.slice(2)) : directory
    const root = await fs.realpath(candidate)
    if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择图库根目录')
    return this.serialized(async () => {
      const parsed = await Promise.all(SOURCES.map(async source => {
        const data = await fs.readFile(path.join(root, 'data', `${source.file}.json`))
        if (data.length > MAX_INDEX) throw new Error('本地图库索引过大')
        verifyGitBlob(data, source.sha)
        const records: unknown = JSON.parse(data.toString('utf8'))
        if (!Array.isArray(records)) throw new Error('本地图库索引格式有误')
        return { source, catalog: { revision: REVISION, rows: records.map(raw => normalize(raw, source)) } }
      }))
      await atomic(this.file('import-root.txt'), root)
      this.importedRoot = root
      for (const { source, catalog } of parsed) await atomic(this.file('catalog', `${source.file}.json`), JSON.stringify(catalog))
      return { count: parsed.reduce((n, entry) => n + entry.catalog.rows.length, 0) }
    })
  }
  /** 草稿中的图库字段必须重新从索引核对；不能让客户端草稿伪造 URL。 */
  private async checkedReference(candidate: OutfitReference | null, kind: OutfitReferenceKind): Promise<OutfitReference | null> {
    if (candidate === null) return null
    if (!candidate || typeof candidate !== 'object' || candidate.kind !== kind || typeof candidate.key !== 'string' || typeof candidate.imageUrl !== 'string') throw new Error('搭配草稿素材不正确')
    if (candidate.key.startsWith('model:')) {
      if (kind !== 'portrait' || !/^model:[0-9a-f-]{36}$/.test(candidate.key)) throw new Error('草稿模特无效')
      const model = (await listModels()).find(entry => `model:${entry.id}` === candidate.key)
      if (!model || ![`${MODEL_API.image}/${encodeURIComponent(model.file)}`, `${MODEL_API.image}/${encodeURIComponent(model.id)}`].includes(candidate.imageUrl)) throw new Error('草稿模特未在模特库中')
      return { ...candidate, imageUrl: `${MODEL_API.image}/${encodeURIComponent(model.file)}`, thumbnailUrl: `${MODEL_API.image}/${encodeURIComponent(model.file)}`, source: 'model', sourceUrl: '', revision: 'local' }
    }
    if (candidate.source === 'upload') {
      const upload = (await this.readUploads()).find(entry => entry.key === candidate.key && entry.kind === kind)
      if (!upload || candidate.imageUrl !== upload.imageUrl || !(await this.image(upload.imageUrl.slice(OUTFIT_API.image.length + 1)))) throw new Error('草稿上传素材不存在')
      return upload
    }
    const item = await this.find(candidate.key)
    if (item.ref.kind !== kind || candidate.source !== item.ref.source || candidate.revision !== REVISION) throw new Error('草稿素材版本不匹配')
    const viewId = candidate.viewId || item.ref.viewId
    const useDepth = candidate.useDepth === true
    this.variant(item, viewId, useDepth, false)
    const basename = candidate.imageUrl.slice(OUTFIT_API.image.length + 1)
    if (!candidate.imageUrl.startsWith(`${OUTFIT_API.image}/`) || !basename.startsWith(`${this.imageName(candidate.key, viewId, useDepth, false)}.`) || !(await this.image(basename))) throw new Error('草稿选中原图尚未缓存在本机')
    return { ...item.ref, imageUrl: candidate.imageUrl, ...(viewId ? { viewId } : {}), ...(useDepth ? { useDepth } : {}) }
  }
  async loadDraft(): Promise<OutfitRecipe | null> {
    try {
      const record = JSON.parse(await fs.readFile(this.file('draft.json'), 'utf8')) as OutfitRecipe
      return this.validateDraft(record)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  private async validateDraft(value: OutfitRecipe): Promise<OutfitRecipe> {
    if (!value || value.version !== 1 || !['try-on', 'character'].includes(value.mode) || !Array.isArray(value.costumes) || value.costumes.length > 4 || !['scene', 'extraPrompt', 'size', 'quality', 'channelId', 'model'].every(field => typeof value[field as keyof OutfitRecipe] === 'string')) throw new Error('草稿格式无效')
    const portrait = await this.checkedReference(value.portrait, 'portrait')
    const pose = await this.checkedReference(value.pose, 'pose')
    const costumes = await Promise.all(value.costumes.map(entry => this.checkedReference(entry, 'costume')))
    return { ...value, portrait, pose, costumes: costumes.filter((entry): entry is OutfitReference => entry !== null) }
  }
  async saveDraft(value: OutfitRecipe): Promise<void> {
    await this.serialized(async () => { const cleaned = await this.validateDraft(value); await atomic(this.file('draft.json'), JSON.stringify(cleaned)) })
  }
}
/** 懒加载目录路径：配置了图像存储根目录后，每次取当前目录。 */
export function createOutfitReferenceStore(options?: { root?: string; fetcher?: typeof fetch }): OutfitReferenceStore {
  return new OutfitReferenceStore(options)
}

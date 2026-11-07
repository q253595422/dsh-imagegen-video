/** 服饰穿戴的共享契约：图库只提供参考素材，生成仍走现有渠道。 */
import { MODEL_API } from './protocol.ts'
export type OutfitReferenceKind = 'portrait' | 'costume' | 'pose'
export type OutfitMode = 'try-on' | 'character'
export interface OutfitReferenceView { id: string; label: string }
export interface OutfitReference {
  /** 来源、类别、原始 ID 组成的稳定键；切换视角不改变键。 */
  key: string
  kind: OutfitReferenceKind
  source: string
  sourceUrl: string
  revision: string
  title: string
  category: string
  tags: string[]
  thumbnailUrl: string
  imageUrl: string
  angle?: string
  group?: string
  views?: OutfitReferenceView[]
  viewId?: string
  useDepth?: boolean
  sensitive?: boolean
  notice?: string
}
/** 本机模特库与图库共用同一种引用：人物图库把模特条目和内置人像放在一起浏览，
 *  路径只指向宿主模特接口，草稿校验与提交都只认这一条受控来源。 */
export function modelReference(model: { id: string; name: string; file: string }): OutfitReference {
  const imageUrl = `${MODEL_API.image}/${encodeURIComponent(model.file)}`
  return {
    key: `model:${model.id}`, kind: 'portrait', source: 'model', sourceUrl: '', revision: 'local',
    title: model.name, category: '我的模特', tags: [], thumbnailUrl: imageUrl, imageUrl,
  }
}

export interface OutfitListRequest {
  kind: OutfitReferenceKind
  query?: string
  category?: string
  source?: string
  angle?: string
  offset?: number
  limit?: number
  refresh?: boolean
  includeSensitive?: boolean
}
export interface OutfitListResult {
  items: OutfitReference[]
  total: number
  categories: string[]
  sources: Array<{ id: string; label: string }>
  angles: string[]
  revision: string
  warnings: string[]
}
export interface OutfitMaterializeRequest { key: string; viewId?: string; useDepth?: boolean }
export interface OutfitUploadRequest { kind: OutfitReferenceKind; name: string; data: string }
/** 草稿只保存本机素材引用，不把大图或密钥写入浏览器存储。 */
export interface OutfitRecipe {
  version: 1
  mode: OutfitMode
  portrait: OutfitReference | null
  costumes: OutfitReference[]
  pose: OutfitReference | null
  scene: string
  extraPrompt: string
  size: string
  quality: string
  channelId: string
  model: string
}
export interface OutfitPreparedGeneration {
  prompt: string
  image: string
  images: string[]
  /** 单图渠道或容量不足时为带编号的拼图，其余情况为 null。 */
  sheet: string | null
  referenceCount: number
}
export const OUTFIT_API = {
  list: '/api/dsh-imagegen/outfit/list',
  materialize: '/api/dsh-imagegen/outfit/materialize',
  upload: '/api/dsh-imagegen/outfit/upload',
  image: '/api/dsh-imagegen/outfit/image',
  draft: '/api/dsh-imagegen/outfit/draft',
  import: '/api/dsh-imagegen/outfit/import',
} as const
/** 前端接口独立于 ImageGenApi，方便三个并行模块共享。响应沿用宿主错误信封。 */
export interface OutfitReferenceApi {
  list(request: OutfitListRequest): Promise<OutfitListResult>
  materialize(request: OutfitMaterializeRequest): Promise<OutfitReference>
  upload(request: OutfitUploadRequest): Promise<OutfitReference>
  loadDraft(): Promise<OutfitRecipe | null>
  saveDraft(recipe: OutfitRecipe): Promise<void>
  importDirectory(directory: string): Promise<{ count: number }>
  /** 人物图库同时是模特库的入口：上传的模特落进宿主模特目录。 */
  saveModel?(input: { name: string; data: string; mime: string }): Promise<{ id: string; name: string; file: string; mime: string }>
}

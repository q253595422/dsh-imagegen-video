/** 参考图库走宿主同源路由，浏览器不直接跨域下载第三方大图。 */
import { OUTFIT_API, type OutfitReferenceApi, type OutfitListRequest, type OutfitListResult, type OutfitMaterializeRequest, type OutfitReference, type OutfitUploadRequest, type OutfitRecipe } from '../outfit-reference.ts'

/** 解开与宿主一致的信封，并保留可读错误供面板重试。 */
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const envelope = await response.json() as { ok: boolean; value?: T; message?: string }
  if (!response.ok || !envelope.ok) throw new Error(envelope.message || `参考图库请求失败（${response.status}）`)
  return envelope.value as T
}
export const outfitReferenceApi: OutfitReferenceApi = {
  list: (input: OutfitListRequest) => request<OutfitListResult>(OUTFIT_API.list, input),
  materialize: (input: OutfitMaterializeRequest) => request<OutfitReference>(OUTFIT_API.materialize, input),
  upload: (input: OutfitUploadRequest) => request<OutfitReference>(OUTFIT_API.upload, input),
  loadDraft: () => request<OutfitRecipe | null>(OUTFIT_API.draft),
  saveDraft: async (recipe: OutfitRecipe) => { await request(OUTFIT_API.draft, recipe) },
  importDirectory: (directory: string) => request<{ count: number }>(OUTFIT_API.import, { directory }),
}

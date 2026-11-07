/** 参考图库走宿主同源路由，浏览器不直接跨域下载第三方大图。 */
import { OUTFIT_API, type OutfitReferenceApi, type OutfitListRequest, type OutfitListResult, type OutfitMaterializeRequest, type OutfitReference, type OutfitUploadRequest, type OutfitRecipe } from '../outfit-reference.ts'
import { MODEL_API } from '../protocol.ts'

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
  // 模特库既然并进了人物图库，添加模特也只能在这里发生；写的是宿主原有的模特接口，
  // 落盘位置与旧路径一致，已有模特不会因为入口搬家而失效。
  saveModel: async input => {
    const response = await fetch(MODEL_API.save, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const envelope = await response.json() as { ok?: boolean; model?: { id: string; name: string; file: string; mime: string }; message?: string }
    if (!response.ok || !envelope.ok || !envelope.model) throw new Error(envelope.message || `保存模特失败（${response.status}）`)
    return envelope.model
  },
}

/** 服饰参考图库的同源路由；沿用宿主的 loopback-only guard。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { OUTFIT_API, type OutfitListRequest, type OutfitRecipe } from './outfit-reference.ts'
import { createOutfitReferenceStore } from './outfit-reference-store.ts'

interface RouteSupport {
  guard: (req: IncomingMessage, res: ServerResponse, method: string) => boolean
  readJsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown> | undefined>
  writeJson: (res: ServerResponse, status: number, body: unknown) => void
}

/** POST 体不完整时直接报错；不得把未解析的输入交给存储服务。 */
export function makeOutfitRoutes(support: RouteSupport): WebRoute[] {
  const store = createOutfitReferenceStore()
  const { guard, readJsonBody, writeJson } = support
  const reply = async (req: IncomingMessage, res: ServerResponse, work: (body: Record<string, unknown>) => Promise<unknown>, maximum = 256 * 1024): Promise<void> => {
    if (!guard(req, res, 'POST')) return
    try {
      const body = await readJsonBody(req, maximum)
      if (!body || Array.isArray(body)) { writeJson(res, 400, { ok: false, code: 'invalid-json', message: '请求 JSON 无效或过大' }); return }
      writeJson(res, 200, { ok: true, value: await work(body) })
    } catch (error) { writeJson(res, 400, { ok: false, code: 'outfit-reference-failed', message: error instanceof Error ? error.message : String(error) }) }
  }
  return [
    { kind: 'exact', path: OUTFIT_API.list, handler: (req, res) => reply(req, res, async body => store.list(body as unknown as OutfitListRequest)) },
    { kind: 'exact', path: OUTFIT_API.materialize, handler: (req, res) => reply(req, res, async body => {
      if (typeof body.key !== 'string') throw new Error('素材标识缺失')
      return store.materialize({ key: body.key, ...(typeof body.viewId === 'string' ? { viewId: body.viewId } : {}), useDepth: body.useDepth === true })
    }) },
    { kind: 'exact', path: OUTFIT_API.upload, handler: (req, res) => reply(req, res, async body => {
      if (typeof body.name !== 'string' || typeof body.data !== 'string') throw new Error('上传缺少文件名或图片')
      return store.upload({ kind: body.kind as 'pose' | 'portrait' | 'costume', name: body.name, data: body.data })
    }, 14 * 1024 * 1024) },
    { kind: 'exact', path: OUTFIT_API.import, handler: (req, res) => reply(req, res, async body => store.importDirectory(body.directory as string)) },
    { kind: 'exact', path: OUTFIT_API.draft, handler: async (req, res) => {
      if (req.method === 'POST') { await reply(req, res, async body => { await store.saveDraft(body as unknown as OutfitRecipe); return null }); return }
      if (!guard(req, res, 'GET')) return
      try { writeJson(res, 200, { ok: true, value: await store.loadDraft() }) }
      catch (error) { writeJson(res, 400, { ok: false, code: 'draft-read-failed', message: error instanceof Error ? error.message : String(error) }) }
    } },
    { kind: 'prefix', path: OUTFIT_API.image, handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      try {
        const pathname = new URL(req.url ?? '', 'http://localhost').pathname
        const suffix = pathname.slice(OUTFIT_API.image.length + 1)
        const preview = /^\/(thumb|full)\/(.+)$/.exec(pathname.slice(OUTFIT_API.image.length))
        const value = preview ? await store.preview(decodeURIComponent(preview[2]!), preview[1] === 'thumb') : await store.image(suffix)
        if (!value) { writeJson(res, 404, { ok: false, code: 'image-not-found', message: '图片不存在' }); return }
        res.writeHead(200, { 'content-type': value.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
        res.end(value.data)
      } catch (error) { writeJson(res, 404, { ok: false, code: 'image-unavailable', message: error instanceof Error ? error.message : String(error) }) }
    } },
  ]
}

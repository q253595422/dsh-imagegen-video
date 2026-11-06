/** 将人物、服装和姿势编成可预览且可原样提交的编辑请求，不从浏览器跨域抓取图库图片。 */
import type { OutfitPreparedGeneration, OutfitRecipe, OutfitReference } from '../outfit-reference.ts'

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
interface Part { reference: OutfitReference; role: string }

/** 新配方不包含图片或凭据，用户先选择一个模式和参考素材。 */
export function defaultOutfitRecipe(): OutfitRecipe {
  return { version: 1, mode: 'try-on', portrait: null, costumes: [], pose: null, scene: '纯色棚拍', extraPrompt: '', size: '3:4', quality: '1K', channelId: '', model: '' }
}

/** 配方顺序也是请求图片顺序；拼图的格子编号沿用相同顺序。 */
function partsOf(recipe: OutfitRecipe): Part[] {
  return [
    ...(recipe.portrait ? [{ reference: recipe.portrait, role: '人物面容与身份' }] : []),
    ...recipe.costumes.map((reference, index) => ({ reference, role: `服装${index + 1}的款式、颜色和材质` })),
    ...(recipe.pose ? [{ reference: recipe.pose, role: '仅用于身体动作和镜头角度' }] : []),
  ]
}

/** 将每张图的用途写入提示词，避免人物、商品和动作互相串用。 */
export function buildOutfitPrompt(recipe: OutfitRecipe, sheet = false): string {
  const parts = partsOf(recipe)
  const intro = recipe.mode === 'try-on'
    ? '生成一张完整的商品试穿照片。严格保留参考服装的版型、颜色、图案、商标和材质，不臆造不存在的文字、标志或细节；人物外观参考人物图。'
    : '生成一张完整的角色搭配图片。将参考服装设计穿到人物身上，保持明确的人物外观及服装设计细节，不生成拼图或设定板。'
  const source = sheet ? '唯一输入图片是带编号的参考拼图；每格只用于标注的角色，不要把编号文字或拼图边框画进最终成片。' : '以下编号依次对应输入的独立参考图；只借用各图所标注的用途。'
  const assignments = parts.map(({ reference, role }, index) => `图${index + 1}：${role}；${reference.title}${reference.viewId ? `，视角${reference.viewId}` : ''}${reference.angle ? `，${reference.angle}视角` : ''}。`)
  const pose = recipe.pose?.useDepth ? '姿势图使用深度视图，仅作视觉参考，不保证精确的深度或骨骼控制。' : ''
  return [intro, source, ...assignments, pose, recipe.scene.trim() ? `场景：${recipe.scene.trim()}。` : '', recipe.extraPrompt.trim() ? `补充要求：${recipe.extraPrompt.trim()}。` : ''].filter(Boolean).join('\n')
}

/** 只读取本机同源缓存；限制流量而非信任 Content-Length，外域链接先拒绝再 fetch。 */
async function loadReference(reference: OutfitReference): Promise<Blob> {
  const input = reference.imageUrl
  let target: string
  if (input.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(input)
    if (!match || Math.floor(match[2].length * 3 / 4) > MAX_REFERENCE_BYTES + 2) throw new Error(`“${reference.title}”不是有效的本地图片或超过 10 MiB`)
    target = input
  } else {
    let url: URL
    try { url = new URL(input, globalThis.location?.href) } catch { throw new Error(`“${reference.title}”的本地图片路径无效，请重新选取素材`) }
    if (!/^https?:$/.test(url.protocol) || url.origin !== globalThis.location?.origin) throw new Error(`“${reference.title}”不是本机缓存图片，请重新选取素材`)
    target = url.href
  }
  let response: Response
  try { response = await fetch(target, { redirect: 'manual' }) } catch { throw new Error(`无法读取“${reference.title}”，请检查本地图库缓存`) }
  if (!response.ok) throw new Error(`无法读取“${reference.title}”（HTTP ${response.status}），请重新选取素材`)
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim()
  if (!IMAGE_TYPES.has(mime)) { await response.body?.cancel(); throw new Error(`“${reference.title}”不是支持的图片格式`) }
  const announcedSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(announcedSize) && announcedSize > MAX_REFERENCE_BYTES) { await response.body?.cancel(); throw new Error(`“${reference.title}”超过单张 10 MiB 限制`) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`“${reference.title}”的图片数据不可读取`)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_REFERENCE_BYTES) { await reader.cancel(); throw new Error(`“${reference.title}”超过单张 10 MiB 限制`) }
      chunks.push(result.value)
    }
  } finally { reader.releaseLock() }
  if (size === 0) throw new Error(`“${reference.title}”的图片内容为空`)
  return new Blob(chunks, { type: mime })
}

/** FileReader 负责把真实缓存图片变成已有 generate API 所接受的 data URI。 */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取参考图'))
    reader.onerror = reader.onabort = () => reject(new Error('无法读取参考图'))
    reader.readAsDataURL(blob)
  })
}

/** 渲染前等图片解码完成，避免 Canvas 把加载中的图片画成空白。 */
function decodeImage(blob: Blob): Promise<{ image: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) { URL.revokeObjectURL(url); reject(new Error('参考图没有有效尺寸')); return }
      resolve({ image, release: () => URL.revokeObjectURL(url) })
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('参考图无法解码，请更换图片')) }
    image.src = url
  })
}

/** 对超容量渠道生成带编号的单图，留白适配不同画幅而不裁切服装或姿势。 */
async function composeSheet(parts: Part[], blobs: Blob[]): Promise<string> {
  const decoded: Array<{ image: HTMLImageElement; release: () => void }> = []
  try {
    for (const blob of blobs) decoded.push(await decodeImage(blob))
    const cols = Math.min(parts.length, 3)
    const rows = Math.ceil(parts.length / cols)
    const cellW = 480
    const cellH = 540
    const canvas = document.createElement('canvas')
    canvas.width = cols * cellW
    canvas.height = rows * cellH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器无法生成参考拼图')
    ctx.fillStyle = '#f1f1f3'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (let index = 0; index < parts.length; index++) {
      const { image } = decoded[index]
      const x = (index % cols) * cellW; const y = Math.floor(index / cols) * cellH
      const availableW = cellW - 24; const availableH = cellH - 64
      const ratio = Math.min(availableW / image.naturalWidth, availableH / image.naturalHeight)
      ctx.drawImage(image, x + 12 + (availableW - ratio * image.naturalWidth) / 2, y + 50 + (availableH - ratio * image.naturalHeight) / 2, ratio * image.naturalWidth, ratio * image.naturalHeight)
      ctx.fillStyle = '#202027'; ctx.font = 'bold 18px sans-serif'
      ctx.fillText(`图${index + 1} ${parts[index].role}`, x + 14, y + 32, cellW - 28)
    }
    const output = canvas.toDataURL('image/jpeg', 0.86)
    if (!/^data:image\/jpeg;base64,/.test(output)) throw new Error('浏览器无法导出参考拼图')
    if (Math.floor((output.length - output.indexOf(',') - 1) * 3 / 4) > MAX_REFERENCE_BYTES) throw new Error('参考拼图超过单张 10 MiB 限制，请减少参考素材')
    return output
  } finally { for (const item of decoded) item.release() }
}

/** 一次准备同时产出预览与提交的完整输入；调用方必须复用返回值，不能提交时再下载一遍。 */
export async function prepareOutfitGeneration(recipe: OutfitRecipe, referenceLimit: number): Promise<OutfitPreparedGeneration> {
  if (recipe.costumes.length > 4) throw new Error('服装参考最多选择 4 张')
  if (recipe.mode === 'try-on' && (!recipe.portrait || recipe.costumes.length === 0)) throw new Error('商品试穿需要人物和至少一张服装参考图')
  const parts = partsOf(recipe)
  if (parts.length === 0) throw new Error('请先选择至少一张人物、服装或姿势参考图')
  if (!Number.isInteger(referenceLimit) || referenceLimit < 1) throw new Error('当前模型不支持参考图编辑，请切换模型')
  const blobs: Blob[] = []
  let total = 0
  for (const { reference } of parts) {
    const blob = await loadReference(reference)
    total += blob.size
    if (total > MAX_TOTAL_BYTES) throw new Error('参考图总大小超过 16 MiB，请减少或压缩素材')
    blobs.push(blob)
  }
  if (parts.length > referenceLimit) {
    const sheet = await composeSheet(parts, blobs)
    return { prompt: buildOutfitPrompt(recipe, true), image: sheet, images: [], sheet, referenceCount: parts.length }
  }
  const images = await Promise.all(blobs.map(toDataUrl))
  return { prompt: buildOutfitPrompt(recipe), image: images[0], images: images.slice(1), sheet: null, referenceCount: parts.length }
}

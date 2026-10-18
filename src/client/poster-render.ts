/** A single Canvas renderer drives both the live preview and the exported PNG. */
import { isPosterDocument, wrapPosterText, type PosterDocument } from '../poster.ts'
import type { CanvasAssetRef } from '../protocol.ts'

export async function loadPosterImage(asset: CanvasAssetRef): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load poster image'))
    image.src = asset.url
  })
}

export function paintPoster(canvas: HTMLCanvasElement, poster: PosterDocument, images: ReadonlyMap<string, HTMLImageElement>): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Canvas 2D is unavailable')
  if (canvas.width !== poster.width) canvas.width = poster.width
  if (canvas.height !== poster.height) canvas.height = poster.height
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const background = images.get(poster.background.assetId)
  if (background === undefined) throw new Error('Poster background is not loaded')
  ctx.drawImage(background, 0, 0, poster.width, poster.height)
  for (const layer of poster.layers) {
    ctx.save()
    if (layer.type === 'image') {
      const image = images.get(layer.asset.assetId)
      if (image === undefined) throw new Error('Poster logo is not loaded')
      ctx.drawImage(image, layer.x, layer.y, layer.width, layer.height)
    } else {
      ctx.beginPath()
      ctx.rect(layer.x, layer.y, layer.width, Math.max(0, poster.height - layer.y))
      ctx.clip()
      ctx.font = `${layer.bold ? 700 : 400} ${layer.fontSize}px ${layer.fontFamily}`
      ctx.fillStyle = layer.color
      ctx.textBaseline = 'top'
      ctx.textAlign = layer.align
      const x = layer.x + (layer.align === 'center' ? layer.width / 2 : layer.align === 'right' ? layer.width : 0)
      wrapPosterText(layer.text, layer.width, text => ctx.measureText(text).width).forEach((line, index) => {
        ctx.fillText(line, x, layer.y + index * layer.fontSize * 1.25)
      })
    }
    ctx.restore()
  }
}

export async function renderPoster(poster: PosterDocument): Promise<HTMLCanvasElement> {
  if (!isPosterDocument(poster)) throw new Error('Invalid poster recipe')
  await globalThis.document.fonts?.ready
  const assets = [poster.background, ...poster.layers.flatMap(layer => layer.type === 'image' ? [layer.asset] : [])]
  const unique = [...new Map(assets.map(asset => [asset.assetId, asset])).values()]
  const images = new Map(await Promise.all(unique.map(async asset => [asset.assetId, await loadPosterImage(asset)] as const)))
  const canvas = globalThis.document.createElement('canvas')
  paintPoster(canvas, poster, images)
  return canvas
}

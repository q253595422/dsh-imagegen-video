/** Versioned, additive poster recipe. Coordinates and font sizes are output pixels. */
import type { CanvasAssetRef } from './protocol.ts'

export interface PosterTextLayer {
  id: string
  type: 'text'
  x: number
  y: number
  width: number
  text: string
  fontSize: number
  fontFamily: 'sans-serif' | 'serif' | 'monospace'
  color: string
  bold: boolean
  align: 'left' | 'center' | 'right'
}

export interface PosterImageLayer {
  id: string
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  asset: CanvasAssetRef
}

export type PosterLayer = PosterTextLayer | PosterImageLayer
export interface PosterDocument {
  version: 1
  width: number
  height: number
  background: CanvasAssetRef
  /** Back to front; the original background is always kept separately. */
  layers: PosterLayer[]
}

export const MAX_POSTER_LAYERS = 40
export const MAX_POSTER_SIDE = 4096
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const positive = (value: unknown): value is number => finite(value) && value > 0 && value <= MAX_POSTER_SIDE
const assetRef = (value: unknown): value is CanvasAssetRef => {
  if (value === null || typeof value !== 'object') return false
  const asset = value as CanvasAssetRef
  // Recipes may only point at immutable host canvas assets, never inline bytes or remote URLs.
  return typeof asset.assetId === 'string' && /^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(asset.assetId)
    && asset.url === `/api/dsh-imagegen/canvas/asset/${asset.assetId}`
    && /^image\/(png|jpeg|webp|gif)$/.test(asset.mime) && finite(asset.bytes) && asset.bytes >= 0
    && finite(asset.width) && asset.width > 0 && finite(asset.height) && asset.height > 0
}

export function isPosterDocument(value: unknown): value is PosterDocument {
  if (value === null || typeof value !== 'object') return false
  const poster = value as PosterDocument
  if (poster.version !== 1 || !positive(poster.width) || !positive(poster.height)
    || !Number.isInteger(poster.width) || !Number.isInteger(poster.height)
    || !assetRef(poster.background) || !Array.isArray(poster.layers) || poster.layers.length > MAX_POSTER_LAYERS) return false
  const ids = new Set<string>()
  return poster.layers.every(layer => {
    if (layer === null || typeof layer !== 'object' || typeof layer.id !== 'string' || layer.id.length === 0 || layer.id.length > 100 || ids.has(layer.id)) return false
    ids.add(layer.id)
    if (!finite(layer.x) || !finite(layer.y) || layer.x < 0 || layer.y < 0 || layer.x >= poster.width || layer.y >= poster.height || !positive(layer.width) || layer.width > poster.width) return false
    if (layer.type === 'image') return positive(layer.height) && layer.height <= poster.height && assetRef(layer.asset)
    return layer.type === 'text' && typeof layer.text === 'string' && layer.text.length <= 4000
      && finite(layer.fontSize) && layer.fontSize >= 8 && layer.fontSize <= 512
      && ['sans-serif', 'serif', 'monospace'].includes(layer.fontFamily)
      && /^#[a-f0-9]{6}$/i.test(layer.color) && typeof layer.bold === 'boolean'
      && ['left', 'center', 'right'].includes(layer.align)
  })
}

/** Wrap using actual glyph metrics; explicit newlines and blank lines survive. */
export function wrapPosterText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const glyph of Array.from(paragraph)) {
      if (line !== '' && measure(line + glyph) > width) { lines.push(line); line = '' }
      line += glyph
    }
    lines.push(line)
  }
  return lines
}

/**
 * Canvas painting and PNG export for the A+ detail page.
 *
 * Separate from `aplus-layout.ts` because the two have different test surfaces:
 * layout is pure and runs under jsdom, this file needs a real 2d context and
 * runs under Chromium. Nothing here decides geometry — it consumes an
 * `AplusLayout` computed by the pure module.
 *
 * The literal colours in this file are the paper white under the blocks and the
 * copy band's own fill. `ctx.fillStyle` cannot resolve a CSS custom property
 * (the canvas API parses colour strings, not the cascade), so "transparent
 * where no image exists" would leak the previous canvas contents. A named
 * literal is the only correct call here, and it is confined to the canvas
 * backend, not the DOM stylesheet.
 */

import type { AplusLayout } from './aplus-layout.ts'
import type { AplusCopy, AplusCopyMap } from './aplus-text.ts'
import {
  APLUS_BAND_FILL,
  APLUS_BAND_RULE,
  bandHeightFor,
  measureCopyBlock,
} from './aplus-text.ts'

/** White paper behind the blocks and in every gap. */
const PAPER = '#ffffff'

/** Load one image and resolve once its intrinsic size is known. */
export function loadAplusImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Only http(s) sources need this; a data: URL is same-origin by definition.
    if (crossOrigin) image.crossOrigin = 'anonymous'
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('image load failed')) }
    image.src = src
  })
}

/** The real width/height ratio, or the assumed one when the image is blank. */
export function aspectOfImage(image: HTMLImageElement, fallback: number): number {
  if (image.naturalWidth > 0 && image.naturalHeight > 0) return image.naturalWidth / image.naturalHeight
  return fallback
}

export interface AplusDrawResult {
  width: number
  height: number
  /** Keys whose image was missing and therefore left blank. */
  skipped: string[]
  /** Keys whose copy band was refused for taking too much of its block. */
  bandOverflow: string[]
}

/** One module's copy band, measured and painted. */
function paintCopyBand(
  context: CanvasRenderingContext2D,
  block: { key: string; y: number; width: number; height: number },
  copy: AplusCopy,
): void {
  const measured = measureCopyBlock(copy, block.width, block.height, (text, font) => {
    context.font = font
    return context.measureText(text).width
  })
  // The verdict is enforced here, not upstream: `drawAplusBlocks` is the only
  // place that knows both the band and the block it belongs to, so a caller
  // that forgets the guard still cannot silently eat the picture.
  const verdict = bandHeightFor(block.height, measured)
  if (!verdict.ok) {
    // Refuse this band rather than truncate it. The row keeps its picture and
    // the export is not aborted; the UI reports the offending module.
    throw new AplusBandOverflow(block.key)
  }
  const bandHeight = measured.height
  const top = Math.round(block.y + block.height) - Math.round(bandHeight)
  // One translucent fill only: painting opaque paper underneath would hide the
  // picture completely and turn the band into a white box.
  context.fillStyle = APLUS_BAND_FILL
  context.fillRect(0, top, Math.round(block.width), Math.round(bandHeight))
  // 1px rule along the top edge, per the spec.
  context.fillStyle = APLUS_BAND_RULE
  context.fillRect(0, top, Math.round(block.width), 1)
  context.textBaseline = 'alphabetic'
  for (const line of measured.lines) {
    context.font = line.font
    context.fillStyle = line.bold ? '#111111' : '#333333'
    context.fillText(line.text, block.width * 0.06, top + line.y)
  }
}

/** Thrown when one module's copy will not fit in its band. */
export class AplusBandOverflow extends Error {
  constructor(readonly key: string) {
    super(`copy band too tall for module ${key}`)
    this.name = 'AplusBandOverflow'
  }
}

/**
 * Paint measured blocks at 1:1 device pixels.
 *
 * Each block spans `[round(y), round(y + height))` so two adjacent blocks share
 * an integer edge and the gap between them stays pure paper instead of showing
 * a one-pixel seam from rounding y and height independently.
 *
 * `copies` is the whole copy feature and it is optional: when it is omitted —
 * or holds nothing for a given block — this function draws exactly what it drew
 * before the bands existed, pixel for pixel. That is what keeps every existing
 * export unchanged, and it is asserted by hash in the Chromium test.
 */
export function drawAplusBlocks(
  canvas: HTMLCanvasElement,
  layout: AplusLayout,
  images: Map<string, HTMLImageElement>,
  copies?: AplusCopyMap,
): AplusDrawResult {
  const first = layout.blocks[0]
  const width = Math.max(0, Math.round(first === undefined ? 0 : first.width))
  const height = Math.max(0, Math.round(layout.height))
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('2d context unavailable')
  context.fillStyle = PAPER
  context.fillRect(0, 0, width, height)
  const skipped: string[] = []
  const bandOverflow: string[] = []
  for (const block of layout.blocks) {
    const image = images.get(block.key)
    if (image === undefined) {
      skipped.push(block.key)
      continue
    }
    const top = Math.round(block.y)
    const bottom = Math.round(block.y + block.height)
    context.drawImage(image, 0, top, width, bottom - top)
    const copy = copies?.[block.key]
    if (copy === undefined) continue
    if (copy.title.trim() === '' && copy.body.trim() === '') continue
    try {
      paintCopyBand(context, { key: block.key, y: top, width: block.width, height: bottom - top }, copy)
    } catch (caught) {
      if (caught instanceof AplusBandOverflow) bandOverflow.push(caught.key)
      else throw caught
    }
  }
  return { width, height, skipped, bandOverflow }
}

/** PNG bytes for the stitched canvas. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob === null) reject(new Error('toBlob failed'))
      else resolve(blob)
    }, 'image/png')
  })
}

/** `aplus-<yyyyMMdd-HHmmss>.png`, in local time. */
export function aplusExportName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `aplus-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
}

/** A source the canvas can draw without tainting it. */
export function isCanvasSafeSource(src: string): boolean {
  return src.startsWith('data:') || src.startsWith('blob:')
}

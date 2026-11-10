/**
 * 草图栅格化：把归一化笔画摊到一张不透明白底 PNG 上。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。逻辑一字未改——它决定草图导出成参考图
 * 长什么样，任何变化都是可见回归。
 */

import type { CanvasSketchStroke } from '../../protocol.ts'
import { SKETCH_EXPORT_WIDTH } from './constants.ts'

/** Draw one normalized stroke onto a 2d context already sized to the board. */
export function drawSketchStroke(
  ctx: CanvasRenderingContext2D,
  stroke: CanvasSketchStroke,
  boardWidth: number,
  boardHeight: number,
): void {
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const points = stroke.points
  if (points.length === 0) return
  if (points.length === 1) {
    const only = points[0]!
    ctx.beginPath()
    ctx.arc(only.x * boardWidth, only.y * boardHeight, stroke.width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  points.forEach((point, index) => {
    const x = point.x * boardWidth
    const y = point.y * boardHeight
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

/** Flatten strokes onto an opaque white PNG sized for gpt-image edits (the
 *  models treat the sketch as a plain reference image). */
export function rasterizeSketch(
  strokes: CanvasSketchStroke[],
  boardWidth: number,
  boardHeight: number,
): { dataUrl: string; width: number; height: number } {
  const scale = SKETCH_EXPORT_WIDTH / Math.max(1, boardWidth)
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(boardWidth * scale))
  canvas.height = Math.max(1, Math.round(boardHeight * scale))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('canvas 2d context unavailable')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  for (const stroke of strokes) drawSketchStroke(ctx, stroke, boardWidth, boardHeight)
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

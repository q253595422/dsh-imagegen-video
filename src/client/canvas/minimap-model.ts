/**
 * 缩略图的几何：世界坐标 ↔ 缩略图坐标。
 *
 * 从 CanvasWorkspace.tsx 的 `renderMinimap` 内联实现里搬出，再从视图
 * （`minimap.tsx`）里分出来。分出来的理由和 `geometry.ts` 一样：这几个数字
 * 错一个，缩略图上的方块就和节点的实际位置对不上，而那种偏差在视觉上极难被
 * 发现——所以它必须能脱离 React 和 CSS 被单独钉住
 * （`smoke-canvas-geometry.mjs` 的 M 组）。
 *
 * 这个文件只认 `CanvasNode` 的形状，不 import React、不碰 DOM、不 import CSS：
 * 能直接 `import('./minimap-model.ts')` 跑。
 */

import type { CanvasNode } from '../../protocol.ts'
import type { Point } from './geometry.ts'
import { nodesBounds } from './node-model.ts'

/** 缩略图自己的像素尺寸。CSS 里 `.minimap` 按这个比例留位。 */
export const MINIMAP_SIZE = { width: 220, height: 150 } as const

/** 空画布时的默认世界视野，以及内容四周留出的世界边距。 */
const EMPTY_WORLD_BOUNDS = { x: -600, y: -600, w: 1200, h: 1200 }
const CONTENT_MARGIN = 500

/** 视口矩形的最小可见尺寸：再小就完全看不见了。 */
const MIN_VIEWPORT_PX = 4

/** 节点方块的最小可见尺寸，同上。 */
const MIN_NODE_BOX_PX = 2

export interface MinimapProjection {
  /** 世界坐标 → 缩略图像素。 */
  toMap: (worldX: number, worldY: number) => Point
  /** 缩略图像素 → 世界坐标。 */
  toWorld: (mapX: number, mapY: number) => Point
  /** 每个节点在缩略图上的方块。 */
  nodeBoxes: Array<{ id: string; type: CanvasNode['type']; left: number; top: number; width: number; height: number }>
  /** 当前视口在缩略图上占的矩形。 */
  viewportRect: { x: number; y: number; w: number; h: number }
}

/**
 * 把世界坐标投影到缩略图上。
 *
 * `viewport` 是画布的 `document.viewport`（`k` 是缩放、`x`/`y` 是平移），
 * `size` 是画布视口的像素尺寸——两者一起决定「现在看得见哪一块世界」。
 *
 * 缩略图自身的像素尺寸固定为 `MINIMAP_SIZE`；`size` 是画布视口的尺寸，不是
 * 缩略图的尺寸，别混。
 */
export function minimapProjection(
  nodes: readonly CanvasNode[],
  viewport: { k: number; x: number; y: number },
  size: { width: number; height: number },
): MinimapProjection {
  const { width, height } = MINIMAP_SIZE

  let worldBounds: { x: number; y: number; w: number; h: number } = EMPTY_WORLD_BOUNDS
  if (nodes.length > 0) {
    const content = nodesBounds([...nodes])
    worldBounds = {
      x: content.minX - CONTENT_MARGIN,
      y: content.minY - CONTENT_MARGIN,
      w: content.maxX - content.minX + CONTENT_MARGIN * 2,
      h: content.maxY - content.minY + CONTENT_MARGIN * 2,
    }
  }
  // 取两个方向里更小的那个比例：整片内容都要装下，不能只装下一个方向。
  const scale = Math.min(width / worldBounds.w, height / worldBounds.h)
  // 比例定了之后，把内容在缩略图里居中。
  const offset = {
    x: (width - worldBounds.w * scale) / 2,
    y: (height - worldBounds.h * scale) / 2,
  }

  const toMap = (worldX: number, worldY: number): Point => ({
    x: (worldX - worldBounds.x) * scale + offset.x,
    y: (worldY - worldBounds.y) * scale + offset.y,
  })
  const toWorld = (mapX: number, mapY: number): Point => ({
    x: (mapX - offset.x) / scale + worldBounds.x,
    y: (mapY - offset.y) / scale + worldBounds.y,
  })

  // 视口在世界里的左上角 = 平移的负数除以缩放。画布视口大小换算成世界尺寸后
  // 再投到缩略图，就是「现在框住哪一块」。
  const vx = -viewport.x / viewport.k
  const vy = -viewport.y / viewport.k
  const p1 = toMap(vx, vy)
  const p2 = toMap(vx + size.width / viewport.k, vy + size.height / viewport.k)
  const viewportRect = {
    x: p1.x,
    y: p1.y,
    w: Math.max(p2.x - p1.x, MIN_VIEWPORT_PX),
    h: Math.max(p2.y - p1.y, MIN_VIEWPORT_PX),
  }

  const nodeBoxes = nodes.map(node => {
    const position = toMap(node.x, node.y)
    return {
      id: node.id,
      type: node.type,
      left: position.x,
      top: position.y,
      width: Math.max(node.width * scale, MIN_NODE_BOX_PX),
      height: Math.max(node.height * scale, MIN_NODE_BOX_PX),
    }
  })

  return { toMap, toWorld, nodeBoxes, viewportRect }
}

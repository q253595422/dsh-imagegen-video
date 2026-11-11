/**
 * 画布右下角的缩略图（minimap）视图。
 *
 * 从 CanvasWorkspace.tsx 搬出。几何（世界坐标 ↔ 缩略图坐标）在
 * `minimap-model.ts` 里，那个文件不 import React、不碰 DOM，因此能被
 * `smoke-canvas-geometry.mjs` 的 M 组直接钉住；这里只负责画。
 *
 * WHY 分开：这段几何之前内联在组件里，边界（空画布给 1200×1200 的默认视野、
 * 内容四周留 500 的世界边距、视口矩形最小 4px 才看得见）只能靠读代码确认。
 * 这些数字一个都不能错——错一个，缩略图上的方块就和节点的实际位置对不上，而
 * 那种偏差在视觉上极难被发现。
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { tt } from '../helpers.ts'
import css from '../canvas-workspace.module.css'
import type { CanvasNode } from '../../protocol.ts'
import { minimapProjection } from './minimap-model.ts'

export interface CanvasMinimapProps {
  nodes: readonly CanvasNode[]
  viewport: { k: number; x: number; y: number }
  size: { width: number; height: number }
  selectedIds: ReadonlySet<string>
  onViewport: (viewport: { k: number; x: number; y: number }) => void
}

/**
 * 缩略图视图。点击或拖动时把缩略图上的位置换算成世界坐标，再把画布视口移到
 * 那里、让那个世界点落在画布正中。
 *
 * 点在点击与按下拖动都走同一条 `jump`：先按下再拖的第一次也立刻生效，不需要
 * 先松手再点一次。
 */
export function CanvasMinimap({ nodes, viewport, size, selectedIds, onViewport }: CanvasMinimapProps): React.JSX.Element | null {
  // 视口还没量出宽度时缩略图没有意义：投影要靠它算「看得见哪一块」。
  if (size.width === 0) return null
  const projection = minimapProjection(nodes, viewport, size)

  const jump = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const world = projection.toWorld(event.clientX - bounds.left, event.clientY - bounds.top)
    onViewport({
      k: viewport.k,
      x: size.width / 2 - world.x * viewport.k,
      y: size.height / 2 - world.y * viewport.k,
    })
  }

  return <aside className={css.minimap} data-canvas-no-zoom="" aria-label={tt('canvas.minimap')}>
    <div className={css.minimapCanvas} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); jump(event) }}
      onPointerMove={event => { if (event.buttons === 1) jump(event) }}>
      {projection.nodeBoxes.map(box => (
        <div key={box.id} className={`${css.minimapNode} ${box.type === 'image' ? css.minimapImage : css.minimapText} ${selectedIds.has(box.id) ? css.minimapSelected : ''}`}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
      ))}
      <div className={css.minimapViewport} style={{ left: projection.viewportRect.x, top: projection.viewportRect.y, width: projection.viewportRect.w, height: projection.viewportRect.h }} />
    </div>
  </aside>
}

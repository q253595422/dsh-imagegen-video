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
import type { CanvasConnection, CanvasNode } from '../../protocol.ts'
import { MINIMAP_SIZE, minimapProjection, type MinimapKind, type MinimapState } from './minimap-model.ts'

export interface CanvasMinimapProps {
  nodes: readonly CanvasNode[]
  connections: readonly CanvasConnection[]
  viewport: { k: number; x: number; y: number }
  size: { width: number; height: number }
  selectedIds: ReadonlySet<string>
  onViewport: (viewport: { k: number; x: number; y: number }) => void
}

/**
 * 种类 → 填充强度。
 *
 * 只用一个色（主题墨色）而不是五种颜色：缩略图是**版图**，不是图例。深浅
 * 已经足够分开「生成的图 / 我要写的字 / 流程的骨架」，五种色相在 220×150
 * 里只会变成一堆难以归因的色块，而且每加一种颜色都要在两种主题里各验一遍
 * 对比度。
 */
// 值直接取 `css.x` 而不是类名字符串：字符串拼接出来的类名（`css[name]`）在
// 静态检查里是不可见的——布局守卫靠扫 `css.xxx` 判断「这个类组件真的在用」，
// 拼出来的名字会被判成「组件不再渲染它」，从而把一份正确的夹具报成过期。
const KIND_FILL: Record<MinimapKind, string> = {
  image: css.minimapKindImage,
  video: css.minimapKindVideo,
  file: css.minimapKindFile,
  storyboard: css.minimapKindStoryboard,
  sketch: css.minimapKindSketch,
  pose: css.minimapKindPose,
  config: css.minimapKindConfig,
  text: css.minimapKindText,
}

const STATE_ATTR: Record<MinimapState, string> = {
  empty: 'empty',
  filled: 'filled',
  running: 'running',
  error: 'error',
}

/**
 * 缩略图视图。点击或拖动时把缩略图上的位置换算成世界坐标，再把画布视口移到
 * 那里、让那个世界点落在画布正中。
 *
 * 点在点击与按下拖动都走同一条 `jump`：先按下再拖的第一次也立刻生效，不需要
 * 先松手再点一次。
 */
export function CanvasMinimap({ nodes, connections, viewport, size, selectedIds, onViewport }: CanvasMinimapProps): React.JSX.Element | null {
  // 视口还没量出宽度时缩略图没有意义：投影要靠它算「看得见哪一块」。
  if (size.width === 0) return null
  const projection = minimapProjection(nodes, viewport, size, connections)

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
      {/* 连线画在方块下面：让方块盖住线的两头，缩略图读起来是「一串卡片被线
          串起来」，而不是「一堆线穿过卡片」。 */}
      {projection.edgeLines.length > 0 ? <svg
        className={css.minimapEdges}
        width={MINIMAP_SIZE.width}
        height={MINIMAP_SIZE.height}
        viewBox={`0 0 ${MINIMAP_SIZE.width} ${MINIMAP_SIZE.height}`}
        aria-hidden="true"
      >
        {projection.edgeLines.map(line => <line
          key={line.id}
          className={css.minimapEdge}
          x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
        />)}
      </svg> : null}
      {projection.nodeBoxes.map(box => (
        <div
          key={box.id}
          className={`${css.minimapNode} ${KIND_FILL[box.kind]} ${selectedIds.has(box.id) ? css.minimapSelected : ''}`}
          data-kind={box.kind}
          data-state={STATE_ATTR[box.state]}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
      <div className={css.minimapViewport} style={{ left: projection.viewportRect.x, top: projection.viewportRect.y, width: projection.viewportRect.w, height: projection.viewportRect.h }} />
    </div>
  </aside>
}

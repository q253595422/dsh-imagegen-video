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

import type { CanvasConnection, CanvasNode } from '../../protocol.ts'
import type { Point } from './geometry.ts'
import { nodeMetadata, nodesBounds } from './node-model.ts'

/** 缩略图自己的像素尺寸。CSS 里 `.minimap` 按这个比例留位。 */
export const MINIMAP_SIZE = { width: 220, height: 150 } as const

/** 空画布时的默认世界视野，以及内容四周留出的世界边距。 */
const EMPTY_WORLD_BOUNDS = { x: -600, y: -600, w: 1200, h: 1200 }
const CONTENT_MARGIN = 500

/** 视口矩形的最小可见尺寸：再小就完全看不见了。 */
const MIN_VIEWPORT_PX = 4

/** 节点方块的最小可见尺寸，同上。 */
const MIN_NODE_BOX_PX = 2

/**
 * 缩略图上该怎么描一个节点。
 *
 * WHY 不能只用 `type`：画板与姿势人偶都是 `type: 'image'`（它们导出后就是
 * 普通图片），但在一张图的版图里「我画的草图」和「模型生成的图」是两件事，
 * 用户扫一眼缩略图是在找后者的位置。文本 / 配置节点同理：配置节点是流程的
 * 骨架，和纯文本的提示词卡不是一回事。
 */
export type MinimapKind = 'image' | 'text' | 'config' | 'video' | 'file' | 'storyboard' | 'sketch' | 'pose'

/** 缩略图上方的状态：空 / 有产物 / 在跑 / 失败。 */
export type MinimapState = 'empty' | 'filled' | 'running' | 'error'

export interface MinimapNodeBox {
  id: string
  kind: MinimapKind
  state: MinimapState
  left: number
  top: number
  width: number
  height: number
}

/** 一条连线的两端在缩略图上的落点。 */
export interface MinimapEdgeLine {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 节点 → 缩略图语义。
 *
 * 判定顺序照着 `node-body.tsx` 渲染分支的那一套来（草图与姿势先于普通图片），
 * 否则一个画板节点会在缩略图上冒充「已生成的图」，而那正是用户要找的东西的
 * 反面。
 */
export function minimapKindOf(node: CanvasNode): MinimapKind {
  if (node.type === 'image') {
    const metadata = nodeMetadata(node)
    if (metadata.sketch !== undefined) return 'sketch'
    if (metadata.pose !== undefined) return 'pose'
    return 'image'
  }
  return node.type
}

/**
 * 节点 → 缩略图状态。
 *
 * 只看「有没有东西」和「是不是在跑」，不看产物类型：一张图有 asset、一段
 * 视频有 video、分镜有一镜以上，都算 `filled`。缩略图不需要知道它是什么，
 * 只回答「这格是不是空的」。
 */
export function minimapStateOf(node: CanvasNode): MinimapState {
  const metadata = nodeMetadata(node)
  if (metadata.status === 'generating') return 'running'
  if (metadata.status === 'error') return 'error'
  if (node.type === 'image') return (metadata.asset?.url ?? '') !== '' ? 'filled' : 'empty'
  if (node.type === 'video') return (metadata.video?.url ?? '') !== '' ? 'filled' : 'empty'
  if (node.type === 'file') return (metadata.asset?.url ?? '') !== '' ? 'filled' : 'empty'
  if (node.type === 'storyboard') return (metadata.storyboard?.shots.length ?? 0) > 0 ? 'filled' : 'empty'
  if (node.type === 'config') return (metadata.text ?? '').trim() !== '' ? 'filled' : 'empty'
  return (metadata.text ?? '').trim() !== '' ? 'filled' : 'empty'
}

export interface MinimapProjection {
  /** 世界坐标 → 缩略图像素。 */
  toMap: (worldX: number, worldY: number) => Point
  /** 缩略图像素 → 世界坐标。 */
  toWorld: (mapX: number, mapY: number) => Point
  /** 每个节点在缩略图上的方块。 */
  nodeBoxes: MinimapNodeBox[]
  /**
   * 每条连线的两端落点。
   *
   * WHY 要画：缩略图存在的理由就是回答「这张图的流程长什么样」。只有方块
   * 的时候，两列节点并排和一条流水线在缩略图上长得一模一样——用户得回到
   * 画布上放大才能分辨，而那正是他打开缩略图想避免的动作。
   */
  edgeLines: MinimapEdgeLine[]
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
  connections: readonly CanvasConnection[] = [],
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
      kind: minimapKindOf(node),
      state: minimapStateOf(node),
      left: position.x,
      top: position.y,
      width: Math.max(node.width * scale, MIN_NODE_BOX_PX),
      height: Math.max(node.height * scale, MIN_NODE_BOX_PX),
    }
  })

  // 连线在缩略图上走直线，不画贝塞尔：这一层的任务是「谁接着谁」，一条弧线在
  // 220×150 里和一条直线读起来没有区别，却要多算四个控制点。两端各留一格方块
  // 的边，线才不会从方块中心穿出来看起来像穿过了卡片。
  const byId = new Map(nodes.map(node => [node.id, node]))
  const centerOf = (id: string): Point | undefined => {
    const source = byId.get(id)
    if (source === undefined) return undefined
    const map = toMap(source.x, source.y)
    return { x: map.x + (source.width * scale) / 2, y: map.y + (source.height * scale) / 2 }
  }
  const edgeLines: MinimapEdgeLine[] = []
  for (const connection of connections) {
    // 两端都已删除的连线不画：`connections` 可能短暂领先于 `nodes`，把一条
    // 指着空处的线画出来，会让缩略图上出现一条不知通向哪的悬空线。
    const from = centerOf(connection.fromNodeId)
    const to = centerOf(connection.toNodeId)
    if (from === undefined || to === undefined) continue
    edgeLines.push({ id: connection.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  }

  return { toMap, toWorld, nodeBoxes, edgeLines, viewportRect }
}

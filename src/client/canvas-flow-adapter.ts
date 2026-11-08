/** 边界适配：CanvasDocument（唯一真源）↔ react-flow 受控视图。
 *
 * 为什么持久化不改成 react-flow 的 {source,target}：workflow/compose/storyboard
 * 的纯函数契约直接读 connections 的 {fromNodeId,toNodeId}，宿主 canvas-store 也
 * 校验这个形状。所以只在视图层转成 Edge{source,target}，回写仍存原形状，用户磁盘
 * 数据与全套免构建测试因此零破坏。viewport 仅 k↔zoom 改名。
 *
 * 本模块只做无损映射，不含任何 react-flow 运行时调用（type-only 导入），便于
 * Node 直接 strip-types 跑 round-trip 不变式。 */

import type { Edge, Node, Viewport } from '@xyflow/react'
import type { CanvasConnection, CanvasNode, CanvasNodeMetadata, CanvasNodeType, CanvasViewport } from '../protocol.ts'

/** 自定义节点 data：标题 + 原始 metadata + 画布类型（子形态靠 metadata 判定，
 *  不拆新 node type，回写时用 canvasType 还原合法 type）。 */
export interface CanvasFlowNodeData extends Record<string, unknown> {
  title: string
  canvasType: CanvasNodeType
  metadata?: CanvasNodeMetadata
}

export type CanvasFlowNode = Node<CanvasFlowNodeData>
export type CanvasFlowEdge = Edge

/** 文档节点 → flow 节点。width/height 显式带上：jsdom 无 layout 时 react-flow
 *  仍能据此渲染（不必等 ResizeObserver 测量）。 */
export function nodeToFlow(node: CanvasNode): CanvasFlowNode {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    data: { title: node.title, canvasType: node.type, metadata: node.metadata },
  }
}

/** flow 节点 → 文档节点。type 取 data.canvasType（而非 flow.type，后者可能被子
 *  形态渲染改写）；width/height 取显式值，缺失才退回 measured，再缺省 0。
 *  metadata 仅在原本存在时写回，保住「无 metadata」与「空 metadata」的区别。 */
export function nodeFromFlow(flow: CanvasFlowNode): CanvasNode {
  const width = flow.width ?? flow.measured?.width ?? 0
  const height = flow.height ?? flow.measured?.height ?? 0
  return {
    id: flow.id,
    type: flow.data.canvasType,
    title: flow.data.title,
    x: flow.position.x,
    y: flow.position.y,
    width,
    height,
    ...(flow.data.metadata !== undefined ? { metadata: flow.data.metadata } : {}),
  }
}

/** 文档连线 → flow 边。sourceHandle/targetHandle 固定常量（自定义节点左 target右
 *  source 两个 Handle），回写时丢弃，因为文档连线无端口概念。 */
export const CANVAS_SOURCE_HANDLE = 'out'
export const CANVAS_TARGET_HANDLE = 'in'

export function connectionToEdge(connection: CanvasConnection): CanvasFlowEdge {
  return {
    id: connection.id,
    source: connection.fromNodeId,
    target: connection.toNodeId,
    sourceHandle: CANVAS_SOURCE_HANDLE,
    targetHandle: CANVAS_TARGET_HANDLE,
    type: 'canvas',
  }
}

export function edgeToConnection(edge: CanvasFlowEdge): CanvasConnection {
  return { id: edge.id, fromNodeId: edge.source, toNodeId: edge.target }
}

/** 文档视口 {x,y,k} → flow {x,y,zoom}。 */
export function viewportToFlow(viewport: CanvasViewport): Viewport {
  return { x: viewport.x, y: viewport.y, zoom: viewport.k }
}

export function viewportFromFlow(viewport: Viewport): CanvasViewport {
  return { x: viewport.x, y: viewport.y, k: viewport.zoom }
}

export function nodesToFlow(nodes: readonly CanvasNode[]): CanvasFlowNode[] {
  return nodes.map(nodeToFlow)
}

export function connectionsToEdges(connections: readonly CanvasConnection[]): CanvasFlowEdge[] {
  return connections.map(connectionToEdge)
}
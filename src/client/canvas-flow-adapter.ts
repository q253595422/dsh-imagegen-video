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
import type { CanvasConnection, CanvasConnectionRole, CanvasNode, CanvasNodeMetadata, CanvasNodeType, CanvasViewport } from '../protocol.ts'
// 只有 `CONNECTION_ROLES` 是值导入：合法角色的名单只应有一个来源，适配层不
// 自己抄一份字符串数组。
import { CONNECTION_ROLES } from './canvas/connection-role.ts'

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
 *  source 两个 Handle），回写时丢弃，因为文档连线无端口概念。
 *
 *  role 走 `data`：Edge 的 source/target 已经在装两端 id，再塞第三个语义字段只会
 *  让边界更难读；data 本来就是给使用者挂自定义数据的地方。react-flow 自己不会
 *  解读它，只在渲染时把它交给自定义边组件（这里连边组件都没注册，见
 *  canvas/connection-layer.tsx 自己按 document.connections 画线）。 */
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
    ...(connection.role === undefined ? {} : { data: { role: connection.role } }),
  }
}

/**
 * flow 边 → 文档连线。
 *
 * role 必须从 data 读回来：这里是每次自动保存都要穿过的边界，少读一个字段就是
 * 把用户标好的首帧/尾帧悄悄抹掉。
 *
 * 合法角色**原样保留**，包括 `'input'`。这一点是刻意的：`'input'` 与「没有这个
 * 字段」在语义上同义，但在这里做「归一」会让 adapter 变成有损边界——一份磁盘上
 * 写着 `role: 'input'` 的文档（别的工具写的、将来 Agent 显式设的）会被 autosave
 * 悄悄改字节。归一放在写入意图那一侧（connection-role.ts 的 `withRole`，它把
 * `'input'` 落成删字段），adapter 只负责一字不差地搬运。
 *
 * 认不出的值退回缺省（不写字段）而不是原样带出去：将来的角色、手改过的 JSON 都
 * 不该让一份画布存不下。
 */
export function edgeToConnection(edge: CanvasFlowEdge): CanvasConnection {
  // edge.data 是 react-flow 给使用者挂自定义数据的自由容器，里面装什么都由运行时
  // 决定（包括磁盘上被人手改过的值），所以按 unknown 处理。
  const raw: unknown = edge.data?.role
  const valid = typeof raw === 'string' && (CONNECTION_ROLES as readonly string[]).includes(raw)
  return {
    id: edge.id,
    fromNodeId: edge.source,
    toNodeId: edge.target,
    ...(valid ? { role: raw as CanvasConnectionRole } : {}),
  }
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
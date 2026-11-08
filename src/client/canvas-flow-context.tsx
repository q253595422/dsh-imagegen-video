/** react-flow 受控视图与现有画布功能逻辑之间的契约。
 *
 * 为什么用 context 而不是把功能逻辑搬进节点组件：CanvasWorkspace 里约 4000 行
 * 功能逻辑（生成/技能/分镜/视频/拼接/标注…）只通过 document/mutate/patchNode/
 * screenToWorld/canvasCenter 五个接口触达引擎。节点外壳必须在模块级定义（react-flow
 * 要求 nodeTypes 引用稳定，否则每次渲染都重挂载节点），所以把这些接口 + 卡片渲染
 * 委托收进 context：外壳身份稳定，内容随 context 更新而重渲染，功能代码基本不动。
 *
 * 全局样式只在这里导入一次（构建时内联注入，见 tsdown.config.ts）；主题化在
 * canvas-workspace.module.css 用 dsw token 覆写 react-flow 变量，把源样式拷进
 * src/client/ 会触 native-UI 守卫。 */

import { createContext, useContext, type ReactNode } from 'react'
import { type NodeProps } from '@xyflow/react'
import type { CanvasDocument, CanvasNode, CanvasNodeMetadata } from '../protocol.ts'
import { type CanvasFlowNode } from './canvas-flow-adapter.ts'

// react-flow 全局样式由 tsdown.config.ts 在 client intro 里构建时内联注入
// （不走 JS import：rolldown 会把 .css 副作用导入提升成宿主无法解析的 require）。
// 主题化在 canvas-workspace.module.css 用 dsw token 覆写 react-flow 变量。

export interface CanvasPoint { x: number; y: number }

/** 节点 patch：metadata 字段 + 几何/标题（与 CanvasWorkspace.patchNode 同形）。 */
export type CanvasNodePatch = Partial<CanvasNodeMetadata> & Partial<Pick<CanvasNode, 'title' | 'width' | 'height' | 'x' | 'y'>>

export interface CanvasFlowContextValue {
  document: CanvasDocument
  selectedIds: ReadonlySet<string>
  colorMode: 'dark' | 'light' | 'system'
  annotatingNodeId: string | null
  nodeById: (id: string) => CanvasNode | undefined
  /** 卡片外壳类名（选中/关联/连线目标/重叠/类型），由现有逻辑派生。 */
  nodeClassName: (node: CanvasNode) => string
  /** 卡片内容（徽标/头部/主体/页脚/悬浮工具条）——现有 renderNode 去掉外壳与连接桩。 */
  renderNodeBody: (node: CanvasNode) => ReactNode
  onNodeDoubleClick: (event: React.MouseEvent, node: CanvasNode) => void
  onNodeContextMenu: (event: React.MouseEvent, node: CanvasNode) => void
  onNodePointerDown: (event: React.PointerEvent<HTMLDivElement>, id: string) => void
  screenToWorld: (clientX: number, clientY: number) => CanvasPoint
  canvasCenter: () => CanvasPoint
  mutate: (updater: (previous: CanvasDocument) => CanvasDocument) => void
  patchNode: (nodeId: string, patch: CanvasNodePatch) => void
}

const CanvasFlowContext = createContext<CanvasFlowContextValue | null>(null)

export function CanvasFlowProvider({ value, children }: { value: CanvasFlowContextValue; children: ReactNode }): React.JSX.Element {
  return <CanvasFlowContext.Provider value={value}>{children}</CanvasFlowContext.Provider>
}

export function useCanvasFlow(): CanvasFlowContextValue {
  const value = useContext(CanvasFlowContext)
  if (value === null) throw new Error('useCanvasFlow 必须在 CanvasFlowProvider 内使用')
  return value
}

/** 模块级稳定外壳：react-flow 负责定位（transform），这里渲染卡片 + 左右连接桩。
 *  data-node-id/tabIndex/role 探针保留，smoke 与事件路由（closestOf）继续可用。 */
export function CanvasNodeShell({ id }: NodeProps<CanvasFlowNode>): React.JSX.Element | null {
  const ctx = useCanvasFlow()
  const node = ctx.nodeById(id)
  if (node === undefined) return null
  return (
    <div
      data-node-id={node.id}
      data-annotating={ctx.annotatingNodeId === node.id ? '' : undefined}
      tabIndex={0}
      role="group"
      aria-label={node.title}
      className={ctx.nodeClassName(node)}
      style={{ width: node.width, height: node.height }}
      onPointerDown={event => ctx.onNodePointerDown(event, node.id)}
      onDoubleClick={event => ctx.onNodeDoubleClick(event, node)}
      onContextMenu={event => ctx.onNodeContextMenu(event, node)}
    >
      {ctx.renderNodeBody(node)}
    </div>
  )
}

/** 6 个合法 type 共用一个外壳（子形态靠 metadata 在 renderNodeBody 内分支）。 */
export const canvasNodeTypes = {
  image: CanvasNodeShell,
  text: CanvasNodeShell,
  file: CanvasNodeShell,
  config: CanvasNodeShell,
  video: CanvasNodeShell,
  storyboard: CanvasNodeShell,
}
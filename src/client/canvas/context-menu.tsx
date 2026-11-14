/**
 * 画布的两种浮动菜单：节点/连线/空白处的右键菜单，以及空白处双击后的「新建」菜单。
 *
 * 从 CanvasWorkspace.tsx 的 `renderContextMenu` 原样搬出。只接 props，
 * 不读组件状态、不发请求——与 `node-body.tsx`、`composer.tsx` 同一约定。
 *
 * WHY 值得单独一个文件：菜单项是按节点类型动态拼的，图像/文件/视频各有自己
 * 一组，再叠上「配置节点不给技能菜单」「标注卡不给润色和复制」这类例外。
 * 抽出来才看得清某一类节点到底有哪些操作。
 *
 * 两种菜单共用 `css.contextMenu` 外观但不共用构建逻辑：右键菜单的项来自一个
 * 数组（每项带图标与 danger 标记），新建菜单是七个写死的按钮，各自带 onClick。
 * 刻意不合并——合并只会得到一堆带可选字段的项，比现在更难读。
 */

import type { ReactNode } from 'react'
import { tt } from '../helpers.ts'
import type { CanvasDocument, CanvasNode, CanvasAssetRef, CanvasConnection, CanvasConnectionRole, CanvasGroup } from '../../protocol.ts'
import { CONNECTION_ROLE_LABELS, CONNECTION_ROLES, roleOf } from './connection-role.ts'
import type { Point } from './geometry.ts'
import { ToolbarIcon, type ToolbarIconName } from './dock-controls.tsx'
import css from '../canvas-workspace.module.css'

/** 右键菜单开在哪：某个节点、某条连线、某个分组框，或者空白处。 */
export type CanvasContextMenuTarget =
  | { type: 'canvas'; screen: Point; world: Point }
  | { type: 'node'; screen: Point; nodeId: string }
  | { type: 'connection'; screen: Point; connectionId: string }
  | { type: 'group'; screen: Point; groupId: string }

/** 双击空白处弹出的「新建」菜单。 */
export interface CanvasCreateMenuTarget {
  screen: Point
  world: Point
}

/** 菜单要读的画布状态（含纯函数——它们不随渲染变化，与 node-body 同约定）。 */
export interface CanvasContextMenuState {
  canvasDocument: { id: string } | null
  contextMenu: CanvasContextMenuTarget | null
  createMenu: CanvasCreateMenuTarget | null
  nodeById: Map<string, CanvasNode>
  /** 右键菜单要读某条连线当前的用途。 */
  connectionById: Map<string, CanvasConnection>
  /** 右键分组框时要读它的名字与成员。 */
  groupById: Map<string, CanvasGroup>
  /** 空白处右键是否给「成组」：不足两个节点时这个动作没有意义。 */
  selectedCount: number
  fileUploadRef: { current: { click: () => void } | null }
  assetOf: (node: CanvasNode) => CanvasAssetRef | undefined
  videoOf: (node: CanvasNode) => { url: string } | undefined
  nodeMetadata: (node: CanvasNode) => { cast?: unknown }
  isAnnotationCard: (node: CanvasNode) => boolean
  createTextNode: (world: Point) => CanvasNode
  createSketchNode: (world: Point) => CanvasNode
  createStoryboardNode: (world: Point) => CanvasNode
  createImageNode: (asset: { assetId: string; url: string; mime: string; bytes: number; width: number; height: number; origin: 'upload' }, world: Point) => CanvasNode
  createEmptyFileNode: (world: Point) => CanvasNode
  createConfigNode: (world: Point) => CanvasNode
}

/** 菜单会触发的动作。 */
export interface CanvasContextMenuActions {
  setContextMenu: (value: CanvasContextMenuTarget | null) => void
  setCreateMenu: (value: CanvasCreateMenuTarget | null) => void
  setFileTargetNodeId: (value: string | null) => void
  setPickerOpen: (value: boolean) => void
  setSelectedConnectionId: (value: string | null) => void
  setVideoPreviewNodeId: (value: string | null) => void
  setPosterTarget: (value: { canvasId: string; nodeId: string } | null) => void
  setCastTarget: (value: string | null) => void
  /** 设置连线用途；`'input'` 即「清除用途」（不写字段）。 */
  setConnectionRole: (connectionId: string, role: CanvasConnectionRole) => void
  /** 把当前选中的节点圈成一个新组；不足两个成员时调用方自己会拒绝。 */
  createGroup: () => void
  /** 双击组标题、或菜单里选「重命名组」。 */
  renameGroup: (groupId: string) => void
  /** 解散一个组：成员节点原地不动，只是不再被圈着。 */
  ungroup: (groupId: string) => void
  setPolishNode: (value: { screen: Point; nodeId: string } | null) => void
  setNotice: (message: string) => void
  openImageNode: (node: CanvasNode) => void
  openFileNode: (node: CanvasNode) => void
  openSkillMenu: (node: CanvasNode, anchor: Point) => void
  downloadNode: (node: CanvasNode) => void
  downloadFileNode: (node: CanvasNode) => void
  downloadVideoNode: (node: CanvasNode) => void
  continueFromClip: (node: CanvasNode) => void
  duplicateNode: (nodeId: string) => void
  deleteNode: (nodeId: string) => void
  patchNode: (nodeId: string, patch: Record<string, unknown>) => void
  placeNewNode: (node: CanvasNode) => void
  pasteClipboard: (world: Point) => void
  fitView: () => void
  mutate: (updater: (previous: CanvasDocument) => CanvasDocument) => void
}

/**
 * 右键菜单或「新建」菜单；两个都没开时返回 `null`（右键菜单优先）。
 */
export function CanvasContextMenu(props: { S: CanvasContextMenuState; A: CanvasContextMenuActions }): ReactNode {
  const { S, A } = props
  // 这几个在原代码里是 const 变量，类型缩窄因此能带进 onClick 的闭包；
  // 挂到 S.xxx 上就不再成立（属性缩窄不过闭包边界），所以照样锚成局部 const。
  // `document` 是画布文档，不是 DOM 的 document——名字照搬原文件，别改。
  const contextMenu = S.contextMenu
  const createMenu = S.createMenu
  const document = S.canvasDocument
if (contextMenu !== null) {
  const close = (): void => A.setContextMenu(null)
  const items: Array<{ label: string; action: () => void; danger?: boolean; icon: ToolbarIconName }> = []
  if (contextMenu.type === 'node') {
    const node = S.nodeById.get(contextMenu.nodeId)
    if (node !== undefined && node.type === 'image' && (S.assetOf(node)?.url.length ?? 0) > 0) {
      items.push({ label: tt('canvas.preview.expand'), icon: 'expand', action: () => A.openImageNode(node) })
      items.push({ label: tt('poster.title'), icon: 'text', action: () => { if (document !== null) A.setPosterTarget({ canvasId: document.id, nodeId: node.id }) } })
      items.push({ label: tt('canvas.download'), icon: 'download', action: () => A.downloadNode(node) })
      // 身份锚定：同一张图定一次，之后每次生成自动带着它。
      items.push({
        label: S.nodeMetadata(node).cast === undefined ? tt('canvas.cast.pin') : tt('canvas.cast.unpin'),
        icon: 'favorite',
        action: S.nodeMetadata(node).cast === undefined
          ? () => { A.setCastTarget(node.id) }
          : () => { A.patchNode(node.id, { cast: undefined }); A.setNotice(tt('canvas.cast.unpinned')) },
      })
    }
    if (node !== undefined && node.type === 'file' && (S.assetOf(node)?.url.length ?? 0) > 0) {
      items.push({ label: tt('canvas.skills.fileDownload'), icon: 'download', action: () => A.downloadFileNode(node) })
      items.push({ label: tt('canvas.preview.expand'), icon: 'expand', action: () => A.openFileNode(node) })
    }
    if (node !== undefined && node.type === 'video' && (S.videoOf(node)?.url ?? '') !== '') {
      items.push({ label: tt('canvas.videoPreview'), icon: 'expand', action: () => { A.setVideoPreviewNodeId(node.id) } })
      items.push({ label: tt('canvas.videoDownload'), icon: 'download', action: () => { A.downloadVideoNode(node) } })
      items.push({ label: tt('canvas.storyboard.grabLastFrame'), icon: 'layers', action: () => { void A.continueFromClip(node) } })
    }
    if (node !== undefined && node.type !== 'config') {
      items.push({ label: tt('canvas.skills.button'), icon: 'skill', action: () => A.openSkillMenu(node, { x: contextMenu.screen.x, y: contextMenu.screen.y }) })
    }
    if (node !== undefined && node.type === 'text' && !S.isAnnotationCard(node)) {
      items.push({ label: tt('canvas.polish.button'), icon: 'sparkle', action: () => A.setPolishNode({ screen: { x: contextMenu.screen.x, y: contextMenu.screen.y }, nodeId: node.id }) })
    }
    if (node === undefined || !S.isAnnotationCard(node)) items.push({ label: tt('canvas.duplicate'), icon: 'duplicate', action: () => A.duplicateNode(contextMenu.nodeId) })
    items.push({ label: tt('canvas.delete'), icon: 'trash', action: () => A.deleteNode(contextMenu.nodeId), danger: true })
  } else if (contextMenu.type === 'connection') {
    // 连线的用途。首帧/尾帧只对视频有意义，但这里不按下游节点类型过滤：
    // 用户先标好再改节点类型是常态，藏起来反而让人以为这个功能不存在。
    const connection = document === null ? undefined : S.connectionById.get(contextMenu.connectionId)
    const currentRole = connection === undefined ? 'input' as const : roleOf(connection)
    for (const role of CONNECTION_ROLES) {
      if (role === 'input') continue
      items.push({
        label: currentRole === role
          ? tt('canvas.connection.clearRole')
          : tt('canvas.connection.setRole', { role: tt(CONNECTION_ROLE_LABELS[role]) }),
        icon: role === 'reference' ? 'image' : 'layers',
        action: () => A.setConnectionRole(contextMenu.connectionId, currentRole === role ? 'input' : role),
      })
    }
    items.push({
      label: tt('canvas.deleteConnection'), icon: 'close', danger: true,
      action: () => {
        A.mutate(previous => ({ ...previous, connections: previous.connections.filter(connection => connection.id !== contextMenu.connectionId) }))
        A.setSelectedConnectionId(null)
      },
    })
  } else if (contextMenu.type === 'group') {
    // 分组自己的两项。组名不进菜单：名字可能很长，而菜单是窄的一列；
    // 名字就写在框上，用户的视线已经在那一带了。
    const group = S.groupById.get(contextMenu.groupId)
    if (group !== undefined) {
      items.push({ label: tt('canvas.group.rename'), icon: 'text', action: () => A.renameGroup(group.id) })
      items.push({ label: tt('canvas.group.ungroup'), icon: 'layers', action: () => A.ungroup(group.id), danger: true })
    }
  } else {
    // 不足两个节点时不给「成组」：一个节点的组和没成组看不出区别，却多出
    // 一个要管理的对象。这里只由数量决定，是否已组过由调用方的 createGroup
    // 自己处理（withGroup 会把成员从旧组里摘出来）。
    if (S.selectedCount >= 2) {
      items.push({ label: tt('canvas.group.create'), icon: 'layers', action: A.createGroup })
    }
    items.push({ label: tt('canvas.addImage'), icon: 'image', action: () => A.setPickerOpen(true) })
    items.push({ label: tt('canvas.addTextNode'), icon: 'text', action: () => A.placeNewNode(S.createTextNode(contextMenu.world)) })
    items.push({ label: tt('canvas.addSketchNode'), icon: 'sketch', action: () => A.placeNewNode(S.createSketchNode(contextMenu.world)) })
    items.push({ label: tt('canvas.storyboardNode'), icon: 'layers', action: () => A.placeNewNode(S.createStoryboardNode(contextMenu.world)) })
    items.push({ label: tt('canvas.paste'), icon: 'duplicate', action: () => A.pasteClipboard(contextMenu.world) })
    items.push({ label: tt('canvas.fitView'), icon: 'fit', action: A.fitView })
  }
  return <div className={css.contextMenu} style={{ left: contextMenu.screen.x, top: contextMenu.screen.y }} data-canvas-no-zoom="" role="menu">
    {items.map(item => <button key={item.label} type="button" role="menuitem" data-danger={item.danger ? '' : undefined} onClick={() => { item.action(); close() }}><ToolbarIcon name={item.icon} />{item.label}</button>)}
  </div>
}
if (createMenu !== null) {
  return <div className={css.contextMenu} style={{ left: createMenu.screen.x, top: createMenu.screen.y }} data-canvas-no-zoom="" role="menu">
    <button type="button" role="menuitem" onClick={() => { A.placeNewNode(S.createTextNode(createMenu.world)); A.setCreateMenu(null) }}><ToolbarIcon name="text" size={16} />{tt('canvas.addTextNode')}</button>
    <button type="button" role="menuitem" onClick={() => { A.placeNewNode(S.createSketchNode(createMenu.world)); A.setCreateMenu(null) }}><ToolbarIcon name="sketch" size={16} />{tt('canvas.addSketchNode')}</button>
    <button type="button" role="menuitem" data-add-storyboard="" onClick={() => { A.placeNewNode(S.createStoryboardNode(createMenu.world)); A.setCreateMenu(null) }}><ToolbarIcon name="layers" size={16} />{tt('canvas.storyboardNode')}</button>
    <button type="button" role="menuitem" onClick={() => { A.placeNewNode(S.createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }, createMenu.world)); A.setCreateMenu(null) }}><ToolbarIcon name="image" size={16} />{tt('canvas.addImageNode')}</button>
    <button type="button" role="menuitem" onClick={() => { A.placeNewNode(S.createEmptyFileNode(createMenu.world)); A.setFileTargetNodeId(null); A.setCreateMenu(null) }}><ToolbarIcon name="file" size={16} />{tt('canvas.skills.addFileNode')}</button>
    <button type="button" role="menuitem" onClick={() => { A.setFileTargetNodeId(null); S.fileUploadRef.current?.click(); A.setCreateMenu(null) }}><ToolbarIcon name="upload" size={16} />{tt('canvas.skills.fileMenuUpload')}</button>
    <button type="button" role="menuitem" onClick={() => { A.placeNewNode(S.createConfigNode(createMenu.world)); A.setCreateMenu(null) }}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button>
  </div>
}
return null
}

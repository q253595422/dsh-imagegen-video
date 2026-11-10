/**
 * 画布上的三个浮动菜单：图片菜单（dock 的「图片」）、背景菜单、节点连接菜单。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。三个都只接 props：位置、当前选中值、
 * 以及每个条目背后的回调。它们不读画布 document，也不自己决定「什么时候
 * 打开」——那是上层 hover 计时器的事（openDockMenu / scheduleMenuClose）。
 *
 * 留下来的两处指针约定，改动时别丢：
 *
 * 1. `onMouseEnter` / `onMouseLeave` 是必需的 props，不是可选的。dock 上的
 *    按钮用 hover 计时器关菜单，鼠标从上移到菜单上时得由菜单自己把计时器
 *    取消、离开时再重新排。少传一个，菜单会在鼠标还没到就自己关掉。
 * 2. 三个菜单都带 `data-canvas-no-zoom=""`：画布把该属性当作「这块不是
 *    空白」，否则框选与缩放的手势会把菜单上的点击抢走。
 *
 * 隐藏的 <input type="file"> 没有一起搬过来：图片上传那个 ref 还被画布上
 * 空图片节点的按钮用着（点空节点也能选图），放在这里就得多绕一层 ref
 * 转发。输入框留在使用它的地方，菜单只发「用户点上传了」这个信号。
 */

import { tt } from '../helpers.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import css from '../canvas-workspace.module.css'

/** 屏幕坐标：菜单锚在指针/按钮附近。 */
export interface MenuAnchor { x: number; y: number }

const menuPointerHandlers = {
  'data-canvas-no-zoom': '',
} as const

export type CanvasBackgroundMode =
  | 'blank' | 'dots' | 'lines' | 'waves' | 'shapeGrid' | 'dotField' | 'dotGrid'
  | 'floatingLines' | 'flow' | 'liquid' | 'faultyTerminal' | 'silk' | 'galaxy' | 'image'

/**
 * 背景菜单里列出的图案，顺序就是菜单里的顺序。
 *
 * `blank` 与 `image` 是单独的条目（它们不在这组里），所以类型上分开写。
 */
export const BACKGROUND_PATTERN_MODES = [
  'dots', 'lines', 'waves', 'shapeGrid', 'dotField', 'dotGrid',
  'floatingLines', 'flow', 'liquid', 'faultyTerminal', 'silk', 'galaxy',
] as const

const BACKGROUND_LABELS = {
  dots: 'canvas.backgroundDots',
  lines: 'canvas.backgroundLines',
  waves: 'canvas.backgroundWaves',
  shapeGrid: 'canvas.backgroundShapeGrid',
  dotField: 'canvas.backgroundDotField',
  dotGrid: 'canvas.backgroundDotGrid',
  floatingLines: 'canvas.backgroundFloatingLines',
  flow: 'canvas.backgroundFlow',
  liquid: 'canvas.backgroundLiquid',
  faultyTerminal: 'canvas.backgroundFaultyTerminal',
  silk: 'canvas.backgroundSilk',
  galaxy: 'canvas.backgroundGalaxy',
} as const satisfies Record<(typeof BACKGROUND_PATTERN_MODES)[number], string>

export interface ImageDockMenuProps {
  anchor: MenuAnchor
  onEnter: () => void
  onLeave: () => void
  onUpload: () => void
  onOpenGallery: () => void
  onOpenHistory: () => void
  onOpenGenerate: () => void
  onAddVideo: () => void
}

export function ImageDockMenu({ anchor, onEnter, onLeave, onUpload, onOpenGallery, onOpenHistory, onOpenGenerate, onAddVideo }: ImageDockMenuProps): React.JSX.Element {
  return <div
    className={css.backgroundMenu}
    style={{ left: anchor.x, top: anchor.y - 10 }}
    {...menuPointerHandlers}
    role="menu"
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
  >
    <button type="button" role="menuitem" onClick={onUpload}>{tt('canvas.imageMenuUpload')}</button>
    <button type="button" role="menuitem" onClick={onOpenGallery}>{tt('canvas.imageMenuAssets')}</button>
    <button type="button" role="menuitem" onClick={onOpenHistory}>{tt('canvas.imageMenuHistory')}</button>
    <button type="button" role="menuitem" onClick={onOpenGenerate}>{tt('canvas.imageMenuGenerate')}</button>
    <button type="button" role="menuitem" data-image-menu-video="" onClick={onAddVideo}>{tt('canvas.addVideo')}</button>
  </div>
}

export interface BackgroundDockMenuProps {
  anchor: MenuAnchor
  /** 当前背景模式，用来给条目加 `data-active`。 */
  mode: CanvasBackgroundMode
  /** 已经有一张背景图时，才显示「移除背景图」。 */
  hasBackgroundImage: boolean
  onEnter: () => void
  onLeave: () => void
  onPickMode: (mode: CanvasBackgroundMode) => void
  onUpload: () => void
  onRemoveImage: () => void
}

export function BackgroundDockMenu({ anchor, mode, hasBackgroundImage, onEnter, onLeave, onPickMode, onUpload, onRemoveImage }: BackgroundDockMenuProps): React.JSX.Element {
  return <div
    className={css.backgroundMenu}
    style={{ left: anchor.x, top: anchor.y - 10 }}
    {...menuPointerHandlers}
    role="menu"
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
  >
    <button type="button" role="menuitem" data-active={mode === 'blank' ? '' : undefined} onClick={() => onPickMode('blank')}>{tt('canvas.backgroundBlank')}</button>
    <span className={css.backgroundMenuDivider} />
    {BACKGROUND_PATTERN_MODES.map(pattern => <button
      key={pattern}
      type="button"
      role="menuitem"
      data-active={mode === pattern ? '' : undefined}
      onClick={() => onPickMode(pattern)}
    >{tt(BACKGROUND_LABELS[pattern])}</button>)}
    <span className={css.backgroundMenuDivider} />
    <button type="button" role="menuitem" data-active={mode === 'image' ? '' : undefined} onClick={onUpload}>{tt('canvas.backgroundUpload')}</button>
    {mode === 'image' && hasBackgroundImage ? <button type="button" role="menuitem" onClick={onRemoveImage}>{tt('canvas.backgroundRemove')}</button> : null}
  </div>
}

/** 节点连线上「从这里再接一个」的候选类型。 */
export type NodeAddKind = 'text' | 'sketch' | 'storyboard' | 'image' | 'config'

export interface NodeAddMenuProps {
  /** 锚点：屏幕坐标，菜单出现在指针右侧。 */
  anchor: MenuAnchor
  /** 源节点的类型；`config` 节点不再给「再接一个配置卡」这个选项。 */
  sourceNodeType: string
  onEnter: () => void
  onLeave: () => void
  onAdd: (kind: NodeAddKind) => void
}

export function NodeAddMenu({ anchor, sourceNodeType, onEnter, onLeave, onAdd }: NodeAddMenuProps): React.JSX.Element {
  return <div
    className={css.contextMenu}
    style={{ left: anchor.x + 12, top: anchor.y, transform: 'translateY(-50%)' }}
    {...menuPointerHandlers}
    role="menu"
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
  >
    <button type="button" role="menuitem" onClick={() => onAdd('text')}><ToolbarIcon name="text" size={16} />{tt('canvas.addTextNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('sketch')}><ToolbarIcon name="sketch" size={16} />{tt('canvas.addSketchNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('storyboard')}><ToolbarIcon name="layers" size={16} />{tt('canvas.storyboardNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('image')}><ToolbarIcon name="image" size={16} />{tt('canvas.addImageNode')}</button>
    {sourceNodeType !== 'config' ? <button type="button" role="menuitem" onClick={() => onAdd('config')}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button> : null}
  </div>
}

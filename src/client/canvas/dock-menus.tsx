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
export type NodeAddKind = 'text' | 'sketch' | 'pose' | 'storyboard' | 'image' | 'config'

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
    <button type="button" role="menuitem" onClick={() => onAdd('pose')}><ToolbarIcon name="expand" size={16} />{tt('canvas.addPoseNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('storyboard')}><ToolbarIcon name="layers" size={16} />{tt('canvas.storyboardNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('image')}><ToolbarIcon name="image" size={16} />{tt('canvas.addImageNode')}</button>
    {sourceNodeType !== 'config' ? <button type="button" role="menuitem" onClick={() => onAdd('config')}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button> : null}
  </div>
}

/** 底栏 `+` 菜单能建的东西，除了图片——图片有自己的按钮和菜单（上传 / 素材库
 *  / 历史 / 生成 / 视频），并进这里会让两个入口做同一件事而各说各话。 */
export type DockAddKind = 'text' | 'sketch' | 'pose' | 'storyboard' | 'file' | 'config' | 'drama'

export interface DockAddMenuProps {
  anchor: MenuAnchor
  onEnter: () => void
  onLeave: () => void
  onAdd: (kind: DockAddKind) => void
}

/**
 * 底栏实底 `+` 的菜单。
 *
 * WHY 合并：停靠栏原来把 6 个建节点的图标平铺在中间（文本 / 画板 / 文件 /
 * 配置卡 / 分镜 / 姿势），和选择、平移、素材库、撤销、删除一样是 40px 方块。
 * 一排 18 个同权重的图标里没有一个读得出「从这里开始」——每个都得悬停看名字。
 * 收进一个实底 `+` 之后，数量减半，而且「新建」这件事在哪个画布应用里都是 `+`。
 *
 * 保留各自独立的入口（图片不在这个菜单里）是有意的：图片菜单已经承载了
 * 上传/素材库/历史/生成/视频五条路径，再把这五条换成「先点 + 再选图片」
 * 只是把一步变成两步。
 */
export function DockAddMenu({ anchor, onEnter, onLeave, onAdd }: DockAddMenuProps): React.JSX.Element {
  return <div
    className={css.backgroundMenu}
    style={{ left: anchor.x, top: anchor.y - 10 }}
    {...menuPointerHandlers}
    role="menu"
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
  >
    <button type="button" role="menuitem" onClick={() => onAdd('text')}><ToolbarIcon name="text" size={16} />{tt('canvas.addTextNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('sketch')}><ToolbarIcon name="sketch" size={16} />{tt('canvas.addSketchNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('pose')}><ToolbarIcon name="expand" size={16} />{tt('canvas.addPoseNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('storyboard')}><ToolbarIcon name="layers" size={16} />{tt('canvas.storyboardNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('drama')}><ToolbarIcon name="layers" size={16} />{tt('canvas.drama.menu')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('file')}><ToolbarIcon name="file" size={16} />{tt('canvas.skills.addFileNode')}</button>
    <button type="button" role="menuitem" onClick={() => onAdd('config')}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button>
  </div>
}

export interface TopBarMenuProps {
  anchor: MenuAnchor
  onEnter: () => void
  onLeave: () => void
  favorite: boolean
  /** 草稿（还没落盘）上没有可收藏/导出的对象；菜单项原地禁用并说明。 */
  saved: boolean
  favoriteLabel: string
  exportLabel: string
  importLabel: string
  deleteLabel: string
  /** 删除的二次确认进行中：同一项变红、文案改问句。 */
  confirmingDelete: boolean
  onFavorite: () => void
  onExport: () => void
  onImport: () => void
  onDelete: () => void
}

/**
 * 顶栏右侧的「这份画布自己的事」菜单。
 *
 * WHY 收进一个菜单而不是继续平铺图标：顶栏原来并排 5 枚等价图标——新建、
 * 收藏、删除画布、全屏、导出、导入。其中四枚是**文件管理**（收藏/删除/导出/
 * 导入），它们与画布上正在做的事没有关系，却和标题、保存状态挤在同一条线上，
 * 而这条线的宽度在 760px 以下会换行，换行后标题就被挤到第二行。
 *
 * 收起来之后顶栏读起来是一个句子：「切换画布 / 画布名 / 全屏 / ⋯」，前面是
 * 你在哪、这块叫什么、怎么看，最后一枚才是「对这份文件做什么」——而后者正是
 * 低频、需要想一下才点的动作，藏一层不损失任何常用路径。
 *
 * 新建与全屏留在外面：新建是频率最高的一条（每次开工），全屏是纯视图动作、
 * 试用时会被反复按；把它们塞进菜单等于给最常用的事加一次点击。
 */
export function TopBarMenu(props: TopBarMenuProps): React.JSX.Element {
  return <div
    className={css.topBarMenu}
    /* `translateX(-100%)` 让菜单的**右**边缘贴住锚点：锚点是顶栏最右一枚按钮
       的右边缘，而这块画布的右边界就在那里。按左上角对齐会让整张菜单伸到画布
       之外，被 `.root` 裁掉——截图里表现为「点了 ⋯，什么都没出现，只多了一条
       滚动条」。 */
    style={{ left: props.anchor.x, top: props.anchor.y + 8, transform: 'translateX(-100%)' }}
    {...menuPointerHandlers}
    role="menu"
    onMouseEnter={props.onEnter}
    onMouseLeave={props.onLeave}
  >
    <button type="button" role="menuitem" disabled={!props.saved} title={props.saved ? undefined : tt('canvas.catalog.blockedDraft')} onClick={props.onFavorite}>
      <ToolbarIcon name={props.favorite ? 'favoriteFilled' : 'favorite'} size={16} />{props.favoriteLabel}
    </button>
    <button type="button" role="menuitem" disabled={!props.saved} title={props.saved ? undefined : tt('canvas.catalog.blockedDraft')} onClick={props.onExport}>
      <ToolbarIcon name="download" size={16} />{props.exportLabel}
    </button>
    <button type="button" role="menuitem" onClick={props.onImport}>
      <ToolbarIcon name="upload" size={16} />{props.importLabel}
    </button>
    <span className={css.backgroundMenuDivider} />
    {/* 删除画布永远最后一行，且自带 danger 色。它是这条菜单里唯一不可撤销的
        动作——放进同一个列表里、不给颜色，误点一次就是一份画布没了。 */}
    <button type="button" role="menuitem" data-danger={props.confirmingDelete ? '' : undefined} disabled={!props.saved} title={props.saved ? undefined : tt('canvas.catalog.blockedDraft')} onClick={props.onDelete}>
      <ToolbarIcon name="deleteProject" size={16} />{props.deleteLabel}
    </button>
  </div>
}

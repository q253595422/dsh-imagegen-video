/**
 * 画布停靠栏与通用控件。
 *
 * 从 CanvasWorkspace.tsx 原样搬出——纯展示组件，不读画布状态、不发请求，
 * 所以能独立成型。ToolbarIcon 是全部停靠栏图标的唯一来源（同一套 Lucide
 * 线宽），IconButton 与 ComposerSelect 是它们的两种外壳。
 */

import type React from 'react'
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround,
  ArrowDownToLine, ArrowUpToLine,
  Bold, BookOpen, BringToFront, ChevronDown, Copy, Download, Eraser, Eye, EyeOff, Expand, FileText as FileTextIcon, Film, FolderX, Hand, Image as ImageIcon,
  Ellipsis, GitBranch, History, Keyboard, Layers, LayoutGrid, ListChecks, Lock, LockOpen, Magnet, Map as MapIcon, Maximize, Maximize2, MousePointer2, Palette, Pencil, Plus, Redo2, Scissors, Search, SendHorizonal, SendToBack, Share2, Sparkles, Star, TextSearch,
  Shrink, SquareDashedMousePointer, Trash2, Type, Undo2, Upload, Video, Wand2, Wallpaper, X,
} from 'lucide-react'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { Select } from '../Select.tsx'
import { shortcutKeysFor } from '../ShortcutHelp.tsx'
import css from '../canvas-workspace.module.css'


export type ToolbarIconName = 'new' | 'select' | 'pan' | 'image' | 'text' | 'file' | 'sketch' | 'eraser' | 'trash' | 'undo' | 'redo' | 'fit' | 'arrange' | 'minimap' | 'background' | 'template' | 'download' | 'duplicate' | 'sparkle' | 'send' | 'close' | 'deleteProject' | 'annotate' | 'removeBg' | 'layers' | 'bold' | 'color' | 'skill' | 'upload' | 'expand' | 'favorite' | 'favoriteFilled' | 'help' | 'workflow' | 'timeline' | 'fullscreen' | 'exitFullscreen' | 'video' | 'snap' | 'connections' | 'catalog' | 'search' | 'health' | 'more' | 'chevronDown' | 'history' | 'alignLeft' | 'alignCenterH' | 'alignRight' | 'alignTop' | 'alignCenterV' | 'alignBottom' | 'distributeH' | 'distributeV' | 'layerFront' | 'layerBack' | 'layerForward' | 'layerBackward' | 'lock' | 'unlock' | 'hide' | 'show'

/** Lucide icons (stroke matches the DSH line style); one shared component so
 *  every dock/toolbar icon comes from the same well-drawn set. */
export function ToolbarIcon({ name, size = 16 }: { name: ToolbarIconName; size?: number }): React.JSX.Element {
  const common = { size, strokeWidth: 1.6, 'aria-hidden': true as const }
  switch (name) {
    case 'new': return <Plus {...common} />
    case 'select': return <MousePointer2 {...common} />
    case 'pan': return <Hand {...common} />
    case 'image': return <ImageIcon {...common} />
    case 'text': return <Type {...common} />
    case 'file': return <FileTextIcon {...common} />
    case 'sketch': return <Pencil {...common} />
    case 'eraser': return <Eraser {...common} />
    case 'trash': return <Trash2 {...common} />
    case 'undo': return <Undo2 {...common} />
    case 'redo': return <Redo2 {...common} />
    case 'fit': return <Maximize {...common} />
    // 整理画布：四宫格。不用「箭头」或「魔法棒」——那两枚在这排里已经分别
    // 是「移动」与「技能」，一眼扫过去会读成同一件事。
    case 'arrange': return <LayoutGrid {...common} />
    case 'minimap': return <MapIcon {...common} />
    case 'background': return <Wallpaper {...common} />
    case 'template': return <BookOpen {...common} />
    case 'download': return <Download {...common} />
    case 'duplicate': return <Copy {...common} />
    case 'sparkle': return <Sparkles {...common} />
    case 'send': return <SendHorizonal {...common} />
    case 'close': return <X {...common} />
    case 'deleteProject': return <FolderX {...common} />
    case 'annotate': return <SquareDashedMousePointer {...common} />
    case 'removeBg': return <Scissors {...common} />
    case 'layers': return <Layers {...common} />
    case 'bold': return <Bold {...common} />
    case 'color': return <Palette {...common} />
    case 'skill': return <Wand2 {...common} />
    case 'upload': return <Upload {...common} />
    case 'expand': return <Maximize2 {...common} />
    case 'favorite': return <Star {...common} />
    case 'favoriteFilled': return <Star {...common} fill="currentColor" />
    // A keyboard, not a question mark: the button opens a key list, and
    // "help" as a bare `?` reads as unknown/unimplemented in a dock that is
    // otherwise all verbs.
    case 'help': return <Keyboard {...common} />
    // 一条连线分叉成三支：这是「整张图按依赖跑」这个动作最短的形状。
    case 'workflow': return <GitBranch {...common} />
    // 几段胶片并排：时间线是「把已成片的几段排成一条」这个动作。
    case 'timeline': return <Film {...common} />
    case 'fullscreen': return <Expand {...common} />
    case 'exitFullscreen': return <Shrink {...common} />
    // 空态快捷卡与左下工具排：视频节点入口、网格吸附、连线显隐。
    case 'video': return <Video {...common} />
    case 'snap': return <Magnet {...common} />
    case 'connections': return <Share2 {...common} />
    // 一个「展开还有别的」的箭头，挂在主按钮旁边：主按钮做主动作，箭头只开菜单。
    case 'chevronDown': return <ChevronDown {...common} />
    // 放大镜 = 「查找某个动作」。这是唯一一枚不代表某个具体动作的图标：它代表
    // 「我不知道动作在哪」。用在这排里是对的，因为按下它什么都不会被改动。
    case 'catalog': return <Search {...common} />
    // 「找一张卡」与「找一个动作」是两件事，图标也必须分开：一个是方框里的
    // 文字，一个是裸放大镜。互换的后果是用户在两枚入口之间反复点错。
    case 'search': return <TextSearch {...common} />
    // 体检：一列带勾的条目。不是听诊器/心跳——那是「健康监测」，而这里做的是
    // 「按清单逐条核一遍」，勾选框才是这个动作的形状。
    case 'health': return <ListChecks {...common} />
    // 顶栏「这块画布自己的事」：收藏 / 导入 / 导出 / 删除。三枚横点，不是齿轮——
    // 齿轮承诺的是「设置」，而这里一个设置项都没有，全是作用于整份画布的动作。
    case 'more': return <Ellipsis {...common} />
    // 历史面板：一圈带箭头的钟。不是单向箭头——那已经是撤销/重做，而这里是
    // 「整条时间线摊开来看」，要能和那两枚一眼分开。
    case 'history': return <History {...common} />
    // 八枚对齐图标与多选对齐条共用同一套 Lucide（`align-bar.tsx` 里已经按
    // 「线画在哪一侧」选过一次），这里逐个照抄，避免同一个动作在目录里和在
    // 对齐条上长得不一样。
    case 'alignLeft': return <AlignStartVertical {...common} />
    case 'alignCenterH': return <AlignCenterVertical {...common} />
    case 'alignRight': return <AlignEndVertical {...common} />
    case 'alignTop': return <AlignStartHorizontal {...common} />
    case 'alignCenterV': return <AlignCenterHorizontal {...common} />
    case 'alignBottom': return <AlignEndHorizontal {...common} />
    case 'distributeH': return <AlignHorizontalSpaceAround {...common} />
    case 'distributeV': return <AlignVerticalSpaceAround {...common} />
    // 置顶/置底是「整盒搬到某一端」，用带端线的方盒；上移/下移是「跨过一位」，
    // 用箭头。两组都画成盒子会分不出是搬到头还是挪一格，都画成箭头又分不出
    // 是跳到头还是走一步。
    case 'layerFront': return <BringToFront {...common} />
    case 'layerBack': return <SendToBack {...common} />
    case 'layerForward': return <ArrowUpToLine {...common} />
    case 'layerBackward': return <ArrowDownToLine {...common} />
    // 锁定/隐藏分两套符号：锁是「锁上/打开」，眼睛是「收起/露出」。不复用
    // `favorite`——那颗星是身份锚定（收藏这张画布），借来表达「锁住」会让
    // 同一枚星在顶栏与节点上表示两件不同的事。
    case 'lock': return <Lock {...common} />
    case 'unlock': return <LockOpen {...common} />
    case 'hide': return <EyeOff {...common} />
    case 'show': return <Eye {...common} />
  }
}

export function labelWithKeys(key: ImageGenKey): string {
  const text = tt(key)
  const keys = shortcutKeysFor(key)
  return keys === '' ? text : `${text} (${keys})`
}

export function IconButton(props: {
  name: ToolbarIconName
  label: string
  active?: boolean
  /** Toggle semantics: unlike `active` (visual only), this exposes state to AT. */
  pressed?: boolean
  disabled?: boolean
  size?: number
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** 「这一枚还有第二种用法」时用：右键不再弹系统菜单，而是走它。 */
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseLeave?: () => void
}): React.JSX.Element {
  return <button
    type="button"
    className={css.iconButton}
    data-active={props.active ? '' : undefined}
    aria-pressed={props.pressed}
    aria-label={props.label}
    title={props.label}
    disabled={props.disabled}
    onClick={props.onClick}
    onContextMenu={props.onContextMenu}
    onMouseEnter={props.onMouseEnter}
    onMouseLeave={props.onMouseLeave}
  ><ToolbarIcon name={props.name} size={props.size} /></button>
}

/** Styled dropdown standing in for a native <select> so the composer and the
 *  picker match the canvas visual language instead of the OS popup. The menu
 *  portals to <body>: ancestors styled with backdrop-filter (the composer's
 *  glass panel) become containing blocks for position:fixed, which used to
 *  push the menu off-screen by re-anchoring its viewport coordinates. */
export function ComposerSelect(props: {
  value: string
  options: Array<{ value: string; label: string }>
  ariaLabel: string
  /** 'toolbar' renders the compact variant used by node hover toolbars. */
  variant?: 'composer' | 'toolbar'
  onChange: (value: string) => void
}): React.JSX.Element {
  return <Select
    value={props.value}
    options={props.options}
    aria-label={props.ariaLabel}
    variant={props.variant ?? 'composer'}
    onPointerDown={event => { event.stopPropagation() }}
    onChange={props.onChange}
  />
}

/**
 * 画布停靠栏与通用控件。
 *
 * 从 CanvasWorkspace.tsx 原样搬出——纯展示组件，不读画布状态、不发请求，
 * 所以能独立成型。ToolbarIcon 是全部停靠栏图标的唯一来源（同一套 Lucide
 * 线宽），IconButton 与 ComposerSelect 是它们的两种外壳。
 */

import type React from 'react'
import {
  Bold, BookOpen, ChevronDown, Copy, Download, Eraser, Expand, FileText as FileTextIcon, Film, FolderX, Hand, Image as ImageIcon,
  GitBranch, Keyboard, Layers, Magnet, Map as MapIcon, Maximize, Maximize2, MousePointer2, Palette, Pencil, Plus, Redo2, Scissors, SendHorizonal, Share2, Sparkles, Star,
  Shrink, SquareDashedMousePointer, Trash2, Type, Undo2, Upload, Video, Wand2, Wallpaper, X,
} from 'lucide-react'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { Select } from '../Select.tsx'
import { shortcutKeysFor } from '../ShortcutHelp.tsx'
import css from '../canvas-workspace.module.css'


export type ToolbarIconName = 'new' | 'select' | 'pan' | 'image' | 'text' | 'file' | 'sketch' | 'eraser' | 'trash' | 'undo' | 'redo' | 'fit' | 'minimap' | 'background' | 'template' | 'download' | 'duplicate' | 'sparkle' | 'send' | 'close' | 'deleteProject' | 'annotate' | 'removeBg' | 'layers' | 'bold' | 'color' | 'skill' | 'upload' | 'expand' | 'favorite' | 'favoriteFilled' | 'help' | 'workflow' | 'timeline' | 'fullscreen' | 'exitFullscreen' | 'video' | 'snap' | 'connections' | 'chevronDown'

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

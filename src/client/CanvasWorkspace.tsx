/** Infinite canvas workspace, rebuilt after the node-graph model of
 * basketikun/infinite-canvas: free nodes (image/text), drag-to-connect edges,
 * marquee + multi selection, context menus, minimap, undo/redo and a floating
 * generation composer. Selecting a node pops the composer: the prompt is typed
 * there (or supplied by connected text nodes), every upstream image node joins
 * as a reference, and results land as new image nodes on the right. */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Bold, BookOpen, ChevronDown, Copy, Download, Eraser, Expand, FileText as FileTextIcon, Film, FolderX, Hand, Image as ImageIcon,
  GitBranch, Keyboard, Layers, Magnet, Map as MapIcon, Maximize, Maximize2, MousePointer2, Palette, Pencil, Plus, Redo2, Scissors, SendHorizonal, Share2, Sparkles, Star,
  Shrink, SquareDashedMousePointer, Trash2, Type, Undo2, Upload, Video, Wand2, Wallpaper,
} from 'lucide-react'
import type { CanvasAnnotation, CanvasAssetRef, CanvasConnection, CanvasConnectionRole, CanvasDocument, CanvasProposal, CanvasFileKind, CanvasLayerInfo, CanvasLayerPlanItem, CanvasNode, CanvasRect, CanvasStoryboard, CanvasVideoRef, CanvasSkillConfigApplyResult, CanvasSkillConfigField, CanvasSkillConfigSaveResult, CanvasSkillConfigStep, CanvasSkillConfigView, CanvasSkillDescriptor, CanvasSkillLibrary, CanvasSkillOutput, CanvasSkillRunRequest, CanvasSkillTask, CanvasSketchStroke, GenerateRequest, GenerationTask, HistoryEntry, VideoGenerateRequest, VideoTaskSummary, VideoMode, VideoResolution } from '../protocol.ts'
import type { CanvasBundleUnresolved } from '../canvas-bundle.ts'
import { describeVideoModel, durationsOf, VIDEO_RESOLUTIONS } from '../video-model-catalog.ts'
// The stitch order is a SHARED rule: the host builds its ffmpeg concat list with
// the same function, so the numbers on the badges are the order of the file.
import { TimelinePanel, type TimelineClipView } from './TimelinePanel.tsx'
import { framePair, orderedUpstream, roleOf, withRole } from './canvas/connection-role.ts'
import { autoLinkCandidates, keyframeRoles } from './canvas/auto-link.ts'
import type { Timeline } from './timeline.ts'
import { CastDialog, castLine } from './CastDialog.tsx'
import { castMembers, castPromptLines, castReferenceIds, ROLE_LABELS } from './cast.ts'
import { orderByPosition, orderIdsByPosition } from '../clip-order.ts'
import { defaultStoryboard, MAX_SHOTS, SHOT_SECONDS, nextShotId, shotNodeOf, shotProblem, shotState, storyboardClipIds, storyboardOf, storyboardProgress, nextShotIndex, withAppendedShot, withMovedShot, withRemovedShot, withShot, withStaleDownstream, type ShotState } from './storyboard.ts'
import { ImageGenApiError, type ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import type { ImageGenKey } from './locales.ts'
import { autoRemoveBackground, canvasToDataUrl, compositeAnnotatedResult, containRect, cropRaster, drawAnnotation, loadRaster, rectBetween, transparencyRatio } from './image-ops.ts'
import { PosterEditor } from './PosterEditor.tsx'
// 工作流执行器：分层调度在 workflow-graph.ts（纯函数），执行循环在 workflow-runner.ts。
import { runWorkflow } from './workflow-runner.ts'
import type { WorkflowProgress } from './workflow-runner.ts'
import { ShortcutHelp, shortcutKeysFor } from './ShortcutHelp.tsx'
import { TemplateLibrary } from './TemplateLibrary.tsx'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from './ModelPicker.tsx'
import type { ImageModelGroup } from './settings-scope.ts'
import { CanvasFileBody, CanvasFileOverlay, fileKindLabel, fileKindOfAsset, fileSizeLabel } from './CanvasFilePreview.tsx'
import { DotFieldBackground, DotGridBackground, FaultyTerminalBackground, FloatingLinesBackground, FlowBackground, GalaxyBackground, LiquidEtherBackground, ShapeGridBackground, SilkBackground, WavesBackground } from './CanvasBackgrounds.tsx'
import { Select } from './Select.tsx'
import { CanvasVideoPicker } from './CanvasVideoPicker.tsx'
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, NodeResizer, type NodeChange, type EdgeChange, type Connection, type Viewport, type NodeProps } from '@xyflow/react'
import { CanvasFlowProvider, canvasNodeTypes, useCanvasFlow, type CanvasFlowContextValue } from './canvas-flow-context.tsx'
import { nodesToFlow, viewportToFlow, viewportFromFlow, type CanvasFlowNode } from './canvas-flow-adapter.ts'
import { onTablistKeyDown, tabIndexFor } from './tablist.ts'
import css from './canvas-workspace.module.css'
import { drawSketchStroke, rasterizeSketch } from './canvas/sketch-raster.ts'
import { coveredNodes, SNAP_SCREEN_PX, snapOffset, type OverlapPair, type Point } from './canvas/geometry.ts'
import { ComposerSelect, IconButton, labelWithKeys, ToolbarIcon, type ToolbarIconName } from './canvas/dock-controls.tsx'
import { COMPOSE_SKILL_ID, composeGlyphs, PolishMenu, SkillConfigForm, SkillConfirmDialog, SkillLibraryDialog, SkillPicker, tierLabel } from './canvas/skill-dialogs.tsx'
import { StoryboardBody } from './canvas/storyboard-board.tsx'
import { CanvasMinimap } from './canvas/minimap.tsx'
import { ConnectionLayer } from './canvas/connection-layer.tsx'
import { GroupLayer } from './canvas/group-layer.tsx'
import {
  groupFrame, groupOfNode, groupsField, groupsOf, pruneGroupsField, siblingsInGroup, withGroup, withGroupTitle, withoutGroup,
} from './canvas/group-model.ts'
import { NodeBody, type NodeBodyActions, type NodeBodyState } from './canvas/node-body.tsx'
import { CanvasComposer, type ComposerActions, type ComposerState } from './canvas/composer.tsx'
import { CanvasContextMenu, type CanvasContextMenuActions, type CanvasContextMenuState, type CanvasContextMenuTarget } from './canvas/context-menu.tsx'
import { ImagePicker, readImageSize, SketchBoard } from './canvas/sketch-and-picker.tsx'
import { RUN_NODE_SIZE, runRectOf, SkillRunCard, type SkillRunTrace } from './canvas/run-card.tsx'
import { CanvasErrorToast, CanvasNoticeToast, CanvasVideoPreviewOverlay, CanvasWorkflowProgressBar } from './canvas/overlays.tsx'
import { CanvasProposalBar } from './canvas/proposal-bar.tsx'
import { BackgroundDockMenu, ImageDockMenu, NodeAddMenu } from './canvas/dock-menus.tsx'
import {
  annotationAnchor, assetOf, assetToDataUrl, attachedCards, bezierPath, clamp01, clampScale, cloneNodesWithCards, freeColumnX, imageDataUrl, isAnnotationCard, isSketchNode, layerKindLabel, liveAnnotations, newId, nodeAnchor, nodeMetadata, nodeSizeFromRatio, nodesBounds, normalizeConfigNodeSizes, pruneAnnotations, removeNodesAndCards, resizedRect, sizeForAsset, textStyleOf, usableAsset, videoOf,
} from './canvas/node-model.ts'
import { CONFIG_NODE_SIZE, DROP_IMAGE_MAX_BYTES, WORLD_PAD, SKETCH_ERASER_RADIUS, SKETCH_WIDTH_DOTS, FILE_NODE_SIZE, GRID_SIZE, IMAGE_NODE_SIZE, LEGACY_CONFIG_NODE_SIZE, MAX_SCALE, MIN_SCALE, PICKER_TABS, SKETCH_COLORS, SKETCH_EXPORT_WIDTH, SKETCH_NODE_SIZE, SKETCH_WIDTHS, STORYBOARD_NODE_SIZE, TEXT_NODE_SIZE } from './canvas/constants.ts'

type CanvasTool = 'select' | 'pan'
type BackgroundMode = CanvasDocument['background']

const HISTORY_LIMIT = 60
/**
 * How long to wait before the autosave retries after a rejected write.
 *
 * WHY not "stop until the user clicks": the toast's × only clears the message,
 * so a plain stop left the document unsaved forever with no visible way back —
 * worse than the retry storm it replaced. WHY not 650 ms: that was the storm
 * (a failed host meant a request 1.5 times a second). A slow, quiet retry keeps
 * the edit on its way to disk while staying out of the user's way; the toast's
 * explicit retry is still there for an immediate attempt.
 */
const SAVE_RETRY_BACKOFF_MS = 15_000
/** Footprint of the prompt card the 标注 tool drops next to a boxed image. */
const ANNOTATION_TEXT_SIZE = { width: 268, height: 132 }
/** Horizontal gap used when new nodes are laid out beside their source. */
const NODE_GAP = 90
/** Smallest normalized box the annotation tool accepts (area fraction). */
const MIN_ANNOTATION_AREA = 0.0004
/** Text colors offered by the text-node palette (first entry = theme default). */
const TEXT_COLORS = ['', '#1f2328', '#ffffff', '#e03131', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5']
/** Layer-split output column: node width and vertical gap (the gap also keeps
 *  a hover toolbar, which hangs below each image node, off its neighbour). */
const LAYER_COLUMN_WIDTH = 280
const LAYER_COLUMN_GAP = 48
/** Smallest footprint a node can be resized to. */
const MIN_NODE_WIDTH = 96
const MIN_NODE_HEIGHT = 64
/** Upper bound on the nodes one menu action may cover (mirrors the host cap). */
const MAX_BATCH_SKILL_NODES = 12
/**
 * The clips one stitch run can cover: selected video nodes that carry a
 * servable URL, in canvas order.
 *
 * Deliberately a subset, not "every selected video node": the host drops any
 * node without a URL from its concat list, so badging such a node would promise
 * a segment the file will not contain — the one divergence this order rule and
 * these badges exist to make visible. The same list feeds the badges, the
 * multi-select bar, the confirm card and `request.nodeIds`.
 */
function composeClipIds(nodes: readonly CanvasNode[], selected: ReadonlySet<string>): string[] {
  return orderIdsByPosition(nodes.filter(node => selected.has(node.id)
    && node.type === 'video'
    && (nodeMetadata(node).video?.url ?? '') !== ''))
}

interface CanvasWorkspaceProps {
  api: ImageGenApi
  modelGroups: ImageModelGroup[]
  defaultChannelId?: string
  connected: boolean
  /** Channels whose credentials are currently usable. */
  connectedChannelIds?: ReadonlySet<string>
  /** Whether the chat model used by canvas light actions is configured. */
  promptReady?: boolean
  /**
   * The workspace is on screen. Required rather than defaulted: every consumer
   * of it is a listener bound OUTSIDE this subtree, so a caller that forgets it
   * would silently restore the old behaviour (the canvas claiming Ctrl+A /
   * Ctrl+Z / Delete from the whole document while it is hidden). Making it
   * mandatory lets the type checker catch that instead of a user.
   *
   * The panel container stays mounted (hidden by a stylesheet rule) so node
   * state survives a tab or panel switch.
   */
  active: boolean
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  tasks: GenerationTask[]
  /** Video model choices per channel (empty when no channel has video models). */
  videoGroups?: ImageModelGroup[]
  /** Video queue summaries, so video nodes can resolve their pending renders. */
  videoTasks?: VideoTaskSummary[]
  /**
   * An import the parent asked for. A clip is imported BY REFERENCE (its served
   * URL), never copied into the canvas asset store — the same rule the
   * generated-clip nodes follow.
   */
  importRequest?: (
    | { source: 'history' | 'gallery'; entryId: string; imageIndex: number }
    | { source: 'video'; url: string; mime: string; duration?: number; title?: string }
  )
  onImportRequestHandled?: () => void
  /**
   * A skill run just persisted a clip into the video history. The panel reads
   * that list once per app session, so without this the sidebar keeps showing a
   * stitched clip only after a full reload. Fired for clip-producing output
   * only — a polish/describe run must not trigger a history refetch.
   */
  onClipStored?: () => void
  onOpenSettings?: (kind?: 'generation' | 'enhancement') => void
}

interface NodeDragState {
  pointerId: number
  startX: number
  startY: number
  moved: boolean
  snapshot: string | null
  origins: Map<string, Point>
  /** The node under the pointer. Only it decides the snap, so a multi-node
   *  drag cannot be pulled apart by two of its members snapping elsewhere. */
  primaryId: string
}

interface PanState {
  startX: number
  startY: number
  viewportX: number
  viewportY: number
  hasMoved: boolean
  startedOnBackground: boolean
}

interface MarqueeState {
  start: Point
  current: Point
  additive: boolean
  initialIds: string[]
}

/**
 * A live two-finger zoom.
 *
 * `base` is the viewport as it stood when the second finger landed; the
 * gesture is expressed relative to it so the transform cannot accumulate
 * rounding drift across a long pinch. The anchor is the world point under the
 * fingers' starting centroid, kept pinned there for the whole gesture -- that
 * is what makes a pinch feel attached to the canvas instead of to its corner.
 */
interface PinchState {
  base: CanvasDocument['viewport']
  startDistance: number
  startCenter: Point
}

interface ConnectState {
  nodeId: string
  handleType: 'source' | 'target'
  mouse: Point
  targetId: string | null
  /** False for a plain click on the handle (opens the add-node menu), true
   *  once the pointer travels far enough that this is a drag-to-connect. */
  moved: boolean
  startClient: Point
}

/** Which corner the pointer grabbed. */
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

interface ResizeState {
  nodeId: string
  corner: ResizeCorner
  startX: number
  startY: number
  width: number
  height: number
  x: number
  y: number
  ratio: number | null
}

/**
 * 右键菜单开在哪。**类型只有一份**，在 `canvas/context-menu.tsx` 里。
 *
 * 这里原本手抄了一份三选一的 union，于是 context-menu 那边加第四种目标
 * （分组框）时，这个文件悄悄地不认——报的还是「缺 connectionId」这种像是
 * 写错了字段的错，指不到真正的原因。类型必须有单一来源，否则每加一种菜单
 * 目标都要记得改两处，而忘记的那次只会以一个误导性的错误出现。
 */
type ContextMenuState = CanvasContextMenuTarget

type ProjectSummary = Awaited<ReturnType<ImageGenApi['canvasList']>>[number]

/**
 * `target.closest(selector)` without an `instanceof` check.
 *
 * Duck-typed for the same reason `matchesSelector` in the keyboard handler is:
 * this code also runs inside the jsdom smoke sandbox, which exposes a
 * `document` but no `Element` constructor on its global. `x instanceof Element`
 * therefore throws a ReferenceError there, which aborted the whole
 * `onViewportPointerDown` / `onWheel` handler before it did anything -- so the
 * suite could not exercise the viewport at all, and a broken gesture would have
 * looked green. A real browser and jsdom agree on the duck-typed form.
 */
function closestOf(target: EventTarget | null, selector: string): Element | null {
  const element = target as { closest?: unknown } | null
  if (element === null || typeof element !== 'object' || typeof element.closest !== 'function') return null
  return (element.closest as (value: string) => Element | null)(selector)
}

/**
 * Snapshot the two-finger gesture from the live pointer positions.
 *
 * Returns null unless exactly two fingers are down: a pinch is defined by a
 * pair, and a third finger must not silently re-anchor the gesture that the
 * first two already started.
 */
function pinchStateFrom(
  pointers: Map<number, Point>,
  viewport: CanvasDocument['viewport'],
): PinchState | null {
  const [first, second] = [...pointers.values()]
  if (first === undefined || second === undefined) return null
  return {
    base: viewport,
    startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    startCenter: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
  }
}

/**
 * A file name the browser and the three target OSes all accept, derived from
 * the canvas title.
 *
 * Titles are free text and routinely contain the separators a path cannot
 * carry (`/`, `\`, `:`), quotes, or a trailing dot — on Windows `a.` and `a`
 * name the same file and the trailing dot is silently dropped, which turns an
 * obviously-wrong name into a quietly-wrong one. Control characters are
 * stripped too rather than escaped: they cannot be typed back into a picker to
 * re-select the file.
 *
 * A title that reduces to nothing (all separators, or empty) falls back to a
 * fixed stem instead of producing `.json`, which every OS refuses to open.
 */
function bundleFileName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  return `${cleaned === '' ? 'canvas' : cleaned}.json`
}

/**
 * Count what a bundle could not carry, split by what it means to the reader.
 *
 * The two kinds are separate on purpose: a clip left behind is a reference to
 * a video that still plays on the machine it came from, while an asset with no
 * bytes was already gone at export time and is lost for good. Adding them into
 * one number would tell the user "3 things went wrong" without saying whether
 * anything is actually unrecoverable.
 */
function countUnresolved(unresolved: readonly CanvasBundleUnresolved[]): { video: number; asset: number } {
  let video = 0
  let asset = 0
  for (const entry of unresolved) {
    if (entry.kind === 'video') video += 1
    else asset += 1
  }
  return { video, asset }
}

/**
 * 下拉里的一行项目：标题，外加「有 N 条待确认」。
 *
 * 为什么需要这一行：提案条只显示**当前打开**那本画布的待确认改动（提案按
 * canvasId 拉取）。Agent 在别的画布上提了改动、用户切走之后，界面就再没有
 * 任何地方能看见它们——那些提案只能等着用户自己想起来切回去。下拉里标一下
 * 就补上了这个洞，而计数来自列表接口那次 readdir，不额外读盘。
 */
function projectLabel(project: ProjectSummary): string {
  const count = project.proposalCount ?? 0
  return count > 0 ? `${project.title} · ${tt('canvas.proposal.pending', { count })}` : project.title
}

function summaryOf(document: CanvasDocument, favorite = false): ProjectSummary {
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    nodeCount: document.nodes.length,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    ...favorite ? { favorite: true } : {},
  }
}

/**
 * 运行工作流前的三个开关。
 *
 * 放在这里而不是 `canvas/dock-menus.tsx`：那个文件是与画布状态无关的纯展示
 * 菜单，而这一份的三个值都属于「这一次怎么跑」的会话状态，跟随画布组件走
 * 更近，也不会为三个布尔props再加一层转发。
 *
 * 关掉「复用」是这里唯一有代价的操作：整条链路重新提交，按节点数计费。
 * 提示写在每一项下面而不是做成确认弹窗——选项菜单本来就该在点之前看清。
 */
function WorkflowOptionsMenu(props: {
  anchor: Point
  reuse: boolean
  rerunSelected: boolean
  parallel: boolean
  /** 选中节点数；0 时「强制重跑」没有作用对象，提示而不是静默无效。 */
  selectionCount: number
  onEnter: () => void
  onLeave: () => void
  onToggleReuse: () => void
  onToggleRerun: () => void
  onToggleParallel: () => void
  onRun: () => void
}): React.JSX.Element {
  /** 三项长得一样，只有文案与状态不同；抽出来避免四处各写一遍。 */
  const item = (label: string, hint: string, checked: boolean, onToggle: () => void, disabled = false): React.JSX.Element =>
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-active={checked ? '' : undefined}
      disabled={disabled}
      onClick={onToggle}
      className={css.workflowOption}
    >
      <span className={css.workflowOptionLabel}>
        <span className={css.workflowOptionCheck} aria-hidden="true">{checked ? '✓' : ''}</span>
        {label}
      </span>
      <span className={css.workflowOptionHint}>{hint}</span>
    </button>
  return <div
    className={css.backgroundMenu}
    style={{ left: props.anchor.x, top: props.anchor.y - 10 }}
    data-canvas-no-zoom=""
    role="menu"
    aria-label={tt('canvas.workflow.options')}
    onMouseEnter={props.onEnter}
    onMouseLeave={props.onLeave}
  >
    {item(tt('canvas.workflow.reuse'), tt('canvas.workflow.reuseHint'), props.reuse, props.onToggleReuse)}
    {item(
      tt('canvas.workflow.rerun'),
      props.selectionCount === 0 ? tt('canvas.workflow.rerunNoSelection') : tt('canvas.workflow.rerunHint'),
      props.rerunSelected,
      props.onToggleRerun,
      props.selectionCount === 0,
    )}
    {item(tt('canvas.workflow.parallel'), tt('canvas.workflow.parallelHint'), props.parallel, props.onToggleParallel)}
    <span className={css.backgroundMenuDivider} />
    <button type="button" role="menuitem" onClick={props.onRun}>{tt('canvas.workflow.run')}</button>
  </div>
}

/** Extensions the file picker refuses before a byte leaves the browser; the
 *  host refuses them again, so this is only a fast, friendly guard. */
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'dll', 'sys', 'bat', 'cmd',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'apk', 'app', 'sh', 'bash', 'command', 'reg', 'lnk', 'url', 'html', 'htm', 'xhtml', 'svg',
])

/** Cap mirroring MAX_CANVAS_FILE_BYTES on the host. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Caps for a canvas drop of images: how many per drop, and how large each may be.
 *
 * Images take the base64 data-URL path (they double as generation references),
 * so every file is read fully into memory and then re-encoded ~33% larger for
 * the JSON upload. Reading them all at once on a large drop is what made the
 * page seize: a Finder multi-selection of a dozen 20 MB photos queued a dozen
 * concurrent FileReaders plus their data URLs. Both caps exist in the sibling
 * drop paths already (ecommerce: 10 MB / 4 files; file nodes: 50 MB) — the
 * canvas was the one entry that had neither.
 *
 * Anything past the count cap is reported, not silently discarded.
 */
const DROP_IMAGE_MAX_COUNT = 20

export function CanvasWorkspace(props: CanvasWorkspaceProps): React.JSX.Element {
  const { api, modelGroups, defaultChannelId, connected, connectedChannelIds, promptReady = connected, history, gallery, tasks, videoGroups, videoTasks, importRequest, onImportRequestHandled, onClipStored, onOpenSettings, active } = props
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [document, setDocument] = useState<CanvasDocument | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [spacePressed, setSpacePressed] = useState(false)
  const [ctrlPressed, setCtrlPressed] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  /**
   * The shortcut legend. Every binding below was already implemented and none of
   * them was discoverable, so the legend has to be reachable from the dock and
   * from `?` — one of those two is what a user actually reaches for.
   */
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  /**
   * The latest `active` for the window-level listeners below.
   *
   * They are registered once, but the flag they must consult changes: reading
   * it through a ref keeps the keyboard effect's dependency list stable while
   * still letting a handler that fires while the panel is closed bail out.
   */
  const activeRef = useRef(active)
  activeRef.current = active
  /**
   * True once the backoff after a rejected save has elapsed. Gates the autosave
   * effect so a failure does not re-arm the 650 ms debounce (a retry storm) and
   * does not stop saving for good either (see SAVE_RETRY_BACKOFF_MS).
   */
  const [failedSaveRetryDue, setFailedSaveRetryDue] = useState(false)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [connecting, setConnecting] = useState<ConnectState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [createMenu, setCreateMenu] = useState<{ screen: Point; world: Point } | null>(null)
  const [nodeAddMenu, setNodeAddMenu] = useState<{ nodeId: string; nodeType: CanvasNode['type']; screen: Point } | null>(null)
  const [minimapOpen, setMinimapOpen] = useState(true)
  // 缩放预设菜单与视图开关。snapEnabledRef 给全局 move 监听器读：那个
  // useEffect 不随状态重建，ref 是唯一不会过期的读法。
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const snapEnabledRef = useRef(true)
  const [connectionsHidden, setConnectionsHidden] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  /**
   * Which image node the poster overlay editor is open on. Carries the canvas id
   * as well, so a canvas switch closes the editor instead of leaving it editing
   * a node that belongs to another document.
   */
  const [posterTarget, setPosterTarget] = useState<{ canvasId: string; nodeId: string } | null>(null)
  // Read by the key and paste handlers, which are registered once and would
  // otherwise capture the first render's `null` and keep acting on the canvas
  // underneath the open editor.
  const posterOpenRef = useRef(false)
  posterOpenRef.current = posterTarget !== null
  const [videoPickerOpen, setVideoPickerOpen] = useState(false)
  const [backgroundMenu, setBackgroundMenu] = useState<Point | null>(null)
  const [imageMenu, setImageMenu] = useState<Point | null>(null)
  // 工作流选项菜单的锚点。放在这三个 dock 菜单旁边而不是跟三个开关一起：
  // 它是**同一类东西**（挂靠一个底栏按钮的临时浮层），必须和它们共用关闭
  // 逻辑——状态各自独立时，Escape / 点画布 / 悬停离开每一条都只清自己认识
  // 的那两个，新加的这个就被漏下来，一直挂在底栏上面关不掉。
  const [workflowMenu, setWorkflowMenu] = useState<Point | null>(null)
  const menuCloseTimer = useRef<number | null>(null)
  const clearMenuCloseTimer = (): void => {
    if (menuCloseTimer.current !== null) { window.clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null }
  }
  /** 关掉全部底栏浮层。**每一条关闭路径都必须走这里**，不要再各自手写一遍
   *  把前两个 state 置空的语句。
   *
   *  工作流选项菜单当初就是被漏在这张名单外面：Escape、点画布、悬停离开
   *  每一条都只清前两个，于是它成了画布上唯一关不掉的浮层，用户只能用
   *  点「运行工作流」把它带走——而那一次运行是会真花钱的。清单只写一份，
   *  下次再加浮层就不会再漏。 */
  const closeDockMenus = useCallback((): void => {
    setBackgroundMenu(null); setImageMenu(null); setWorkflowMenu(null)
  }, [])
  const scheduleMenuClose = useCallback((): void => {
    clearMenuCloseTimer()
    menuCloseTimer.current = window.setTimeout(closeDockMenus, 280)
  }, [])
  /** Open one dock menu anchored to its button (root-relative) and close the
   *  other: the three menus are mutually exclusive. */
  const openDockMenu = useCallback((kind: 'image' | 'background', button: HTMLElement): void => {
    clearMenuCloseTimer()
    const bounds = button.getBoundingClientRect()
    const rootRect = rootRef.current?.getBoundingClientRect()
    const screen: Point = { x: bounds.left + bounds.width / 2 - (rootRect?.left ?? 0), y: bounds.top - (rootRect?.top ?? 0) }
    closeDockMenus()
    if (kind === 'image') setImageMenu(screen)
    else setBackgroundMenu(screen)
  }, [closeDockMenus])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [pickerTab, setPickerTab] = useState<'upload' | 'history' | 'gallery' | 'generate'>('upload')
  /** Canvas file nodes: the hidden file input plus the skill catalog overlay. */
  const fileUploadRef = useRef<HTMLInputElement>(null)
  const [fileTargetNodeId, setFileTargetNodeId] = useState<string | null>(null)
  /** File node whose full-screen preview reader is open (null = closed). */
  const [filePreviewNodeId, setFilePreviewNodeId] = useState<string | null>(null)
  /** The video node whose full-screen player is open. Clips get their own
   *  overlay rather than reusing the file one: the file overlay resolves an
   *  asset through the canvas store, which a clip deliberately does not have. */
  const [videoPreviewNodeId, setVideoPreviewNodeId] = useState<string | null>(null)
  /**
   * Agent 提议的改动。这些**不是**画布的一部分——它们住在
   * canvas/proposals/，只有用户点接受才会经 canvasSave 写进文档。
   *
   * 轮询而不是推送：提案由宿主侧的 Agent 进程写入，与浏览器之间没有通道。
   * 5 秒一次、只在画布打开时跑，代价是一次很小的 JSON 请求。
   */
  const [proposals, setProposals] = useState<CanvasProposal[]>([])
  const [proposalsBusy, setProposalsBusy] = useState(false)
  const [proposalError, setProposalError] = useState<string | null>(null)
  /** Video nodes whose clip the browser refused to load. The canvas stores a
   *  served URL, not bytes, so clearing the video history (or evicting past
   *  VIDEO_HISTORY_MAX) deletes the file under a node that still points at it.
   *  Without this the node renders as a dead player with no explanation. */
  const [brokenVideoIds, setBrokenVideoIds] = useState<Set<string>>(() => new Set())
  /** Drop the unloadable marker for one node. Used by the node's reload button,
   *  by delete (so an undone node does not come back claiming its clip is gone),
   *  and by a regenerate (which produces a new clip that may load fine). */
  const clearBrokenVideo = useCallback((id: string): void => {
    setBrokenVideoIds(previous => {
      if (!previous.has(id)) return previous
      const next = new Set(previous)
      next.delete(id)
      return next
    })
  }, [])
  const [skillMenu, setSkillMenu] = useState<{ screen: Point; nodeId: string } | null>(null)
  const [skillCatalog, setSkillCatalog] = useState<{ skills: CanvasSkillDescriptor[]; installed: string[]; reason?: string } | null>(null)
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false)
  /** Skill library manager (dock entry): contents, in-flight work, prefill. */
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false)
  const [skillLibrary, setSkillLibrary] = useState<CanvasSkillLibrary | null>(null)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryPresetUrl, setLibraryPresetUrl] = useState('')
  /** Skill whose configuration form the library dialog should open. */
  const [libraryFocusSkill, setLibraryFocusSkill] = useState('')
  /** Toast action for a specific message: a missing skill the user can install. */
  const [errorAction, setErrorAction] = useState<{ label: string; run: () => void; forError: string } | null>(null)
  const [pendingSkill, setPendingSkill] = useState<{ skill: CanvasSkillDescriptor; nodeIds: string[]; instruction: string } | null>(null)
  // 时间线编辑面板：打开时带一份初值（选中的视频按画布顺序排好）。
  const [timelineOpen, setTimelineOpen] = useState(false)
  /** 打开时间线时选定的片段，按画布顺序。面板只认这一份列表：框选两段就
   *  是两段，不会把画布上其它成片也拖进来。 */
  const [timelineNodeIds, setTimelineNodeIds] = useState<string[]>([])
  const [timelineBusy, setTimelineBusy] = useState(false)
  /** 正在设置身份参考的图片节点；面板关掉时清空。 */
  const [castTarget, setCastTarget] = useState<string | null>(null)
  /** Live skill runs: task id -> the target node's toolbar label/id. */
  const [skillRuns, setSkillRuns] = useState<Record<string, SkillRunTrace>>({})
  const [polishBusy, setPolishBusy] = useState<string | null>(null)
  const [polishNode, setPolishNode] = useState<{ screen: Point; nodeId: string } | null>(null)
  const skillRunsRef = useRef<Record<string, SkillRunTrace>>({})
  const backgroundFileRef = useRef<HTMLInputElement>(null)

  /** reactbits.dev "Dock" port: each tile spring-scales by its distance to the
   *  pointer (width/height, so neighbours part like the macOS dock) and the
   *  panel breathes taller while hovered to make room for the labels. */
  const dockOuterRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const topBarRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const outer = dockOuterRef.current
    const dock = dockRef.current
    if (outer === null || dock === null) return
    if (typeof window.requestAnimationFrame !== 'function') return
    const clockNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const BASE = 40
    const MAGNIFIED = 50
    const DISTANCE = 150
    const REST_HEIGHT = 42
    const HOVER_HEIGHT = MAGNIFIED + MAGNIFIED / 2 + 4
    const STIFFNESS = 170
    const DAMPING = 16
    const MASS = 0.5
    const MAX_FRAME_SECONDS = 0.034
    const MAX_TILE_VELOCITY = 420
    const MAX_OUTER_VELOCITY = 320
    // Capture resting centers once. Reading an item's live center while its
    // width is animating creates a layout feedback loop that can run away on
    // slow frames; the resting anchor keeps the pointer target deterministic.
    const tiles = [...dock.querySelectorAll<HTMLElement>('[data-dock-item]')].map(el => {
      const rect = el.getBoundingClientRect()
      return { el, size: BASE, velocity: 0, centerX: rect.left + Math.min(rect.width, BASE) / 2 }
    })
    let outerSize = REST_HEIGHT
    let outerVelocity = 0
    let mouseX = Number.POSITIVE_INFINITY
    let hovered = false
    let raf = 0
    let running = false
    let last = clockNow()
    const step = (now: number): void => {
      const dt = Math.max(0, Math.min(MAX_FRAME_SECONDS, (now - last) / 1000))
      last = now
      let settled = true
      for (const tile of tiles) {
        let target = BASE
        if (hovered) {
          const distance = Math.abs(mouseX - tile.centerX)
          target = BASE + (MAGNIFIED - BASE) * Math.max(0, 1 - distance / DISTANCE)
        }
        tile.velocity += ((STIFFNESS * (target - tile.size) - DAMPING * tile.velocity) / MASS) * dt
        tile.velocity = Math.max(-MAX_TILE_VELOCITY, Math.min(MAX_TILE_VELOCITY, tile.velocity))
        tile.size = Math.max(BASE, Math.min(MAGNIFIED, tile.size + tile.velocity * dt))
        if (Math.abs(target - tile.size) > 0.15 || Math.abs(tile.velocity) > 2) settled = false
        else {
          tile.size = target
          tile.velocity = 0
        }
        tile.el.style.width = `${tile.size.toFixed(2)}px`
        tile.el.style.height = `${tile.size.toFixed(2)}px`
      }
      const outerTarget = hovered ? HOVER_HEIGHT : REST_HEIGHT
      outerVelocity += ((STIFFNESS * (outerTarget - outerSize) - DAMPING * outerVelocity) / MASS) * dt
      outerVelocity = Math.max(-MAX_OUTER_VELOCITY, Math.min(MAX_OUTER_VELOCITY, outerVelocity))
      outerSize = Math.max(REST_HEIGHT, Math.min(HOVER_HEIGHT, outerSize + outerVelocity * dt))
      if (Math.abs(outerTarget - outerSize) > 0.25 || Math.abs(outerVelocity) > 3) settled = false
      else {
        outerSize = outerTarget
        outerVelocity = 0
      }
      // `minHeight`, not `height`: the dock wraps to a second row on a narrow
      // panel, and a hard height would clip/overflow it back over the zoom row.
      outer.style.minHeight = `${outerSize.toFixed(2)}px`
      outer.style.height = 'auto'
      if (settled) {
        running = false
        return
      }
      raf = window.requestAnimationFrame(step)
    }
    const wake = (): void => {
      if (running) return
      running = true
      last = clockNow()
      raf = window.requestAnimationFrame(step)
    }
    const onPointerMove = (event: PointerEvent): void => {
      mouseX = event.clientX
      hovered = true
      wake()
    }
    const onPointerLeave = (): void => {
      hovered = false
      mouseX = Number.POSITIVE_INFINITY
      wake()
    }
    dock.addEventListener('pointermove', onPointerMove)
    dock.addEventListener('pointerleave', onPointerLeave)
    wake()
    return () => {
      window.cancelAnimationFrame(raf)
      dock.removeEventListener('pointermove', onPointerMove)
      dock.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])
  const imageFileRef = useRef<HTMLInputElement>(null)
  /** The hidden picker behind the top bar's import button. One input for the
   *  whole workspace: a second one would have to be kept in sync with this
   *  one's `value` reset, and the reset is what lets the same file be picked
   *  twice in a row. */
  const bundleFileRef = useRef<HTMLInputElement>(null)
  /** A whole bundle is document + every referenced image's bytes, so both
   *  directions can take a while on a big canvas. The flags exist to disable
   *  the buttons (a second export of a canvas being exported allocates the
   *  bundle twice) and to say something is happening. */
  const [bundleExporting, setBundleExporting] = useState(false)
  const [bundleImporting, setBundleImporting] = useState(false)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false)
  const [saveState, setSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 当前这次拖动正在移动的节点 id。拖动之外为空。
   *
   * 重叠提示是文档的纯函数（见渲染层的 `liveOverlap`），不另存一份「哪两个
   * 被盖住了」——删节点、撤销、换画布都会让那种快照过期。这里只记住「谁在动」。
   * 用 ref：拖动每帧都在改位置，真正触发渲染的是文档更新，不需要在
   * pointermove 里额外 setState（那是每像素一次的无谓渲染）。 */
  const dragMovingIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [historyVersion, setHistoryVersion] = useState(0)

  // Image-node tools: 标注 (box -> prompt card), 移除背景 (local matting) and
  // 图层拆分 (vision layer plan -> editable nodes).
  const [annotateNodeId, setAnnotateNodeId] = useState<string | null>(null)
  const [annotationDraft, setAnnotationDraft] = useState<{ nodeId: string; rect: CanvasRect } | null>(null)
  const [busyNodes, setBusyNodes] = useState<Record<string, string>>({})
  // 工作流运行：`null` 表示没在跑；中断控制器放在 ref 里，因为它不是渲染数据。
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [workflowProgress, setWorkflowProgress] = useState<WorkflowProgress | null>(null)
  const workflowAbort = useRef<AbortController | null>(null)
  // 防重入读 ref 而不是 state：`runWorkflowFrom` 的闭包会捕获创建时的
  // `workflowBusy`，连点两下时第二次看到的仍是 false。
  const workflowBusyRef = useRef(false)
  /**
   * 工作流运行选项。三项都是「这一次怎么跑」的参数，不是画布内容，所以放
   * 组件 state 而不是写进 `CanvasDocument`——后者有 v2 契约与 revision 锁，
   * 为一个开关去动它，等于给每个用户的数据加一个他们从没用过的字段。
   *
   * 默认值就是此前写死的行为（复用开、强制重跑关、层内并发开），所以不做
   * 任何选择时，跑出来的结果与升级前完全一致。
   */
  const [workflowReuse, setWorkflowReuse] = useState(true)
  const [workflowRerunSelected, setWorkflowRerunSelected] = useState(false)
  const [workflowParallel, setWorkflowParallel] = useState(true)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [colorPickerNodeId, setColorPickerNodeId] = useState<string | null>(null)
  const annotationDragRef = useRef<{ nodeId: string; pointerId: number; start: Point; box: { left: number; top: number; width: number; height: number } } | null>(null)

  // Floating generation composer state.
  const [composerPrompt, setComposerPrompt] = useState('')
  const initialComposerChoice = resolveModelChoice(modelGroups, undefined, defaultChannelId)
  const [composerModel, setComposerModel] = useState(initialComposerChoice.model)
  const [composerChannelId, setComposerChannelId] = useState(initialComposerChoice.channelId)
  const modelGroupsKey = modelGroups.map(group => `${group.id}:${group.models.join(',')}`).join('|')
  useEffect(() => {
    const next = resolveModelChoice(modelGroups, { channelId: composerChannelId, model: composerModel }, defaultChannelId)
    setComposerChannelId(next.channelId)
    setComposerModel(next.model)
  }, [modelGroupsKey, defaultChannelId])

  const [composerSize, setComposerSize] = useState('auto')
  const [composerQuality, setComposerQuality] = useState('auto')
  const [composerCount, setComposerCount] = useState(1)
  const [composerBusy, setComposerBusy] = useState(false)
  // Video composer: the canvas shares one composer between images and clips, so
  // these hold the clip-side choices while `composerKind` picks which path the
  // send button takes.
  const [composerKind, setComposerKind] = useState<'image' | 'video'>('image')
  /**
   * Which renderer the NEXT submit uses, per task.
   *
   * `model` is the historical path and stays the default. `code` has the
   * conversation model write drawing code that this host renders — it needs no
   * image or video provider, which is why every model/channel guard below is
   * skipped in that mode rather than left to fail at the wire.
   */
  const [composerRenderer, setComposerRenderer] = useState<'model' | 'code'>('model')
  const [composerVideoModel, setComposerVideoModel] = useState('')
  const [composerVideoChannelId, setComposerVideoChannelId] = useState('')
  const [composerVideoMode, setComposerVideoMode] = useState<'auto' | VideoMode>('auto')
  const [composerAspect, setComposerAspect] = useState('16:9')
  const [composerSeconds, setComposerSeconds] = useState(5)
  const [composerResolution, setComposerResolution] = useState<VideoResolution>('720P')
  // The composer offers the same per-family choices the studio panel does:
  // snapgen speaks 6/10/15 and only some aspect words, so a shared constant
  // would show values the selected model rejects.
  const composerVideoCatalog = useMemo(() => describeVideoModel(composerVideoModel), [composerVideoModel])
  const composerAspectOptions = useMemo(() => (
    composerVideoCatalog.aspectRatios.length > 0 ? composerVideoCatalog.aspectRatios : ['16:9', '9:16', '1:1']
  ), [composerVideoCatalog])
  const composerDurationOptions = useMemo(() => durationsOf(composerVideoCatalog), [composerVideoCatalog])
  const composerResolutionOptions = useMemo<VideoResolution[]>(() => (
    composerVideoCatalog.resolutions.length > 0 ? composerVideoCatalog.resolutions : [...VIDEO_RESOLUTIONS]
  ), [composerVideoCatalog])
  useEffect(() => {
    if (!composerAspectOptions.includes(composerAspect)) setComposerAspect(composerAspectOptions[0] ?? '16:9')
  }, [composerAspectOptions, composerAspect])
  useEffect(() => {
    if (!composerDurationOptions.includes(composerSeconds)) setComposerSeconds(composerDurationOptions[0] ?? 5)
  }, [composerDurationOptions, composerSeconds])
  useEffect(() => {
    if (!composerResolutionOptions.includes(composerResolution)) setComposerResolution(composerResolutionOptions[0] ?? '720P')
  }, [composerResolutionOptions, composerResolution])
  /**
   * 拉一次提案。失败静默：提案是旁路功能，网络抖一下不该在画布上弹错误，
   * 也不该让下一次成功的轮询之后还挂着一条旧错误。
   *
   * 用 `documentRef` 读当前画布而不是闭包里的 `document`：轮询的回调可能在
   * 用户切换画布之后才回来，拿闭包会读到他刚离开的那一份。
   */
  const refreshProposals = useCallback(async (): Promise<void> => {
    const canvasId = documentRef.current?.id
    try {
      // 没有打开的画布时不能直接返回：`counts` 覆盖全部画布，而下拉在「一份
      // 都没打开」的时候同样需要那些标记。空 id 让服务端只算计数、不返回任
      // 何提案。
      const answer = await api.canvasProposals(canvasId ?? '')
      const next = answer.proposals ?? []
      // A host that predates the counts field (or a stub in a test) answers with
      // just `proposals`. Treating that as "no counts" leaves the dropdown
      // unmarked instead of throwing on the first `counts[id]`.
      const counts = answer.counts ?? {}
      if (canvasId === undefined) { setProposals([]) }
      else {
        // 再确认一次画布没换：这一段 await 期间用户可能已经点了别的画布。
        if (documentRef.current?.id !== canvasId) return
        setProposals(next)
      }
      // 下拉里的「有 N 条待确认」也在这里刷新。只靠切画布时刷是不够的：用户
      // 停在画布 B 上，Agent 在画布 A 上提了改动，不刷新就永远看不到那条提示，
      // 而提案条只显示当前这本画布。计数跟提案来自同一次目录遍历，不额外读盘。
      setProjects(previous => {
        let changed = false
        const nextProjects = previous.map(project => {
          const count = counts[project.id] ?? 0
          const current = project.proposalCount ?? 0
          if (count === current) return project
          changed = true
          if (count === 0) { const { proposalCount: _drop, ...rest } = project; return rest }
          return { ...project, proposalCount: count }
        })
        // 没变就返回原数组：每 5 秒换一个新数组会让整份下拉重渲染。
        return changed ? nextProjects : previous
      })
    } catch { /* 旁路功能，静默 */ }
  }, [api])

  // 打开画布时拉一次，之后每 5 秒一次。`document?.id` 作为依赖而不是
  // `document`：拖节点会不停地换 document 对象，用它当依赖会让定时器
  // 每帧重建。
  //
  // 一份画布都没打开时也照常轮询：提案条没有内容可显示，但下拉里的「有 N 条
  // 待确认」不依赖当前打开的是哪一本。
  useEffect(() => {
    setProposals([])
    if (document?.id !== undefined) setProposalError(null)
    void refreshProposals()
    const timer = window.setInterval(() => { void refreshProposals() }, 5000)
    return () => { window.clearInterval(timer) }
  }, [document?.id, refreshProposals])

  /**
   * 接受一条提案。
   *
   * ## 先把本地未同步的编辑写出去，再接受
   *
   * 用户在拖动节点之后 650 ms 内点了「接受」时，那一笔拖动只在浏览器内存里，
   * 服务端一无所知。accept 接口只带 canvasId + proposalId，服务端基于**它
   * 自己**那份文档应用提案，返回整份新文档——里面那个节点还在旧坐标。
   * 若客户端直接拿它替换本地 document，用户刚拖的位置被静默抹掉，而且因为
   * `syncedRef` 同时被推进，autosave 也不会再补写一次。
   *
   * 两条断言各钉一端：`scripts/smoke-canvas-agent.mjs` 的 F9 证明「先写、再
   * 接受」之后文档里两样都在；`scripts/verify-canvas-proposal-bar.mjs` 断言这
   * 里两行的先后顺序（顺序反了，写得再对也没用）。缺陷本身是先写一个探针实测
   * 出来的——不先写就接受时，服务端返回的节点仍停在 0,0 而不是 1234,567。
   *
   * `flushPendingCanvas` 会走与 autosave 同一条写入路径（含冲突读回重试），
   * 所以这里等它完成再接受，服务端就有了用户最新的编辑。
   *
   * ## 服务端会拒绝的两种情况
   *
   *  - 画布在其他窗口被改过（乐观锁）→ `canvas-conflict`，让用户重试；
   *  - 提案要引用的节点已经不在 → `proposal-stale`，这条提案不可能再生效。
   *
   * 两者都不简化成「失败了」：用户需要知道下一步做什么。
   */
  const acceptProposal = useCallback(async (proposalId: string): Promise<void> => {
    const canvasId = documentRef.current?.id
    if (canvasId === undefined || proposalsBusy) return
    setProposalsBusy(true); setProposalError(null)
    try {
      // 见上：不先把这笔写出去，下面那份返回值会带走用户的编辑。
      await flushPendingRef.current()
      const saved = await api.canvasProposalAccept(canvasId, proposalId)
      // 服务端返回的就是落盘后的文档，直接用它换掉本地视图，不再多跑一次读取。
      //
      // 但必须同时把 `syncedRef` 推进到这里，并且把保存状态标成 saved：
      // autosave 的判据是「本地文档 ≠ 最后一次同步成功的内容」，不同步这一笔
      // 的话，上面这行 setDocument 会被当成一次**用户编辑**，650 ms 后原样再
      // 写一遍服务端（revision 只多不少，白写一次），写失败还会弹一条用户
      // 根本没动手却看到的保存错误。
      documentRef.current = saved
      syncedRef.current = JSON.stringify(saved)
      setDocument(saved)
      setSaveState('saved')
      setSelectedIds(new Set()); setSelectedConnectionId(null)
      await refreshProposals()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      // 过期是一句具体的指路，其余错误原样显示。
      setProposalError(message)
      // 过期之后这条提案已经不可能再被接受，直接从列表里去掉，免得用户反复点。
      await refreshProposals()
    } finally {
      setProposalsBusy(false)
    }
  }, [api, proposalsBusy, refreshProposals])

  const discardProposal = useCallback(async (proposalId: string): Promise<void> => {
    const canvasId = documentRef.current?.id
    if (canvasId === undefined || proposalsBusy) return
    setProposalsBusy(true); setProposalError(null)
    try {
      await api.canvasProposalDiscard(canvasId, proposalId)
      await refreshProposals()
    } catch (caught) {
      setProposalError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setProposalsBusy(false)
    }
  }, [api, proposalsBusy, refreshProposals])

  const discardAllProposals = useCallback(async (): Promise<void> => {
    const canvasId = documentRef.current?.id
    if (canvasId === undefined || proposalsBusy) return
    setProposalsBusy(true); setProposalError(null)
    try {
      await api.canvasProposalDiscard(canvasId)
      await refreshProposals()
    } catch (caught) {
      setProposalError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setProposalsBusy(false)
    }
  }, [api, proposalsBusy, refreshProposals])

  const channelIsConnected = useCallback((channelId: string): boolean => {
    if (connectedChannelIds !== undefined && channelId !== '') return connectedChannelIds.has(channelId)
    return connected
  }, [connected, connectedChannelIds])
  const composerChannelConnected = channelIsConnected(composerChannelId)
  const composerVideoConnected = composerVideoChannelId === '' || channelIsConnected(composerVideoChannelId)
  const videoModelCount = (videoGroups ?? []).reduce((total, group) => total + group.models.length, 0)
  /**
   * A pre-flight warning for the code path (today: no ffmpeg).
   *
   * Checked when the shape changes rather than at submit time, because the
   * point is to warn before the user spends a chat call — not to fail after it.
   */
  const [composerProbeWarning, setComposerProbeWarning] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (composerRenderer !== 'code') { setComposerProbeWarning(undefined); return }
    let disposed = false
    void api.codeProbe({
      kind: composerKind === 'video' ? 'video' : 'image',
      resolution: composerKind === 'video' ? composerResolution : composerQuality === '1k' ? '720P' : '1080P',
      aspectRatio: composerKind === 'video' ? composerAspect : composerSize === 'auto' ? '1:1' : composerSize,
      ...composerKind === 'video' ? { seconds: composerSeconds } : {},
    }).then(probe => {
      if (disposed) return
      // Stills render with the built-in PNG encoder, so a missing ffmpeg only
      // blocks clips. Saying "it will fail" for an image would be wrong.
      setComposerProbeWarning(composerKind === 'video' && !probe.ffmpegAvailable ? tt('canvas.rendererNoFfmpeg') : undefined)
    }).catch(() => { if (!disposed) setComposerProbeWarning(undefined) })
    return () => { disposed = true }
  }, [api, composerAspect, composerKind, composerQuality, composerRenderer, composerResolution, composerSeconds, composerSize])
  // Keep the video model valid as channels change (a catalog can be emptied
  // while the canvas stays open).
  const videoGroupsKey = (videoGroups ?? []).map(group => `${group.id}:${group.models.join(',')}`).join('|')
  useEffect(() => {
    const groups = videoGroups ?? []
    if (groups.length === 0) { if (composerVideoModel !== '') setComposerVideoModel(''); return }
    const choice = resolveModelChoice(groups, { channelId: composerVideoChannelId, model: composerVideoModel }, defaultChannelId)
    if (choice.model !== composerVideoModel || choice.channelId !== composerVideoChannelId) {
      setComposerVideoChannelId(choice.channelId)
      setComposerVideoModel(choice.model)
    }
  }, [videoGroupsKey, defaultChannelId])

  const rootRef = useRef<HTMLElement>(null)
  /**
   * Fullscreen is the browser Fullscreen API on the workspace root, not a
   * z-index trick. The panel lives inside the host conversation grid, so a
   * fixed overlay would still sit inside that grid item — `position: fixed`
   * is bound to the nearest ancestor that creates a containing block, and the
   * host sets `position: relative` on the center column. The API promotes the
   * element out of that tree entirely and gives the real viewport size.
   *
   * Tracked in state (not read off document.fullscreenElement during render)
   * so the button label follows Esc and every other exit path.
   */
  const [fullscreen, setFullscreen] = useState(false)

  /**
   * The state above is a MIRROR of the browser, never its own truth: Esc, the
   * browser's own exit affordance and the API call all end in the same
   * event. Subscribing (instead of only setting state where we call the API)
   * is what keeps the button from showing 'Exit fullscreen' over a
   * window that already left fullscreen.
   */
  useEffect(() => {
    const sync = (): void => {
      setFullscreen(globalThis.document !== undefined && globalThis.document.fullscreenElement === rootRef.current && rootRef.current !== null)
    }
    globalThis.document?.addEventListener('fullscreenchange', sync)
    sync()
    return () => { globalThis.document?.removeEventListener('fullscreenchange', sync) }
  }, [])

  const toggleFullscreen = useCallback((): void => {
    const root = rootRef.current
    if (root === null) return
    // Both branches swallow their rejection: a browser can refuse the request
    // (an 'allowfullscreen'-less iframe, a permissions policy), and an
    // unhandled rejection would surface as a console error with no user-facing
    // meaning. The button simply stays in its un-fullscreened state.
    if (globalThis.document?.fullscreenElement === root) {
      void globalThis.document.exitFullscreen?.().catch(() => {})
      return
    }
    void root.requestFullscreen?.().catch(() => {})
  }, [])
  const viewportRef = useRef<HTMLDivElement>(null)
  /**
   * How much of the canvas's bottom edge the chrome covers, in pixels.
   *
   * The bottom chrome (minimap + zoom dock + job dock) floats OVER the canvas
   * instead of taking layout space from it, so "the centre of the viewport" is
   * behind the docks on a narrow panel. Measured rather than assumed: the dock
   * is one row on a wide panel and two on the three-column studio.
   */
  const [chromeHeight, setChromeHeight] = useState(0)
  /**
   * How tall the floating top bar currently is, in pixels.
   *
   * The proposal bar sits directly under it, and the bar's height is not a
   * constant: on a panel narrower than 760px `.topBar` switches to
   * `flex-wrap`, so the title and the seven icon buttons take two rows and the
   * bar grows from ~47px to ~83px. A fixed `top` therefore covers the top
   * bar's second row on exactly the narrow panels where the buttons are
   * smallest and easiest to hit by accident.
   *
   * Measured, not assumed, for the same reason as `chromeHeight` below: the
   * row count depends on the host's width, which the stylesheet cannot know.
   */
  const [topBarHeight, setTopBarHeight] = useState(0)
  /**
   * 把「写入本地未同步的编辑」这件事转给下面的 `flushPendingCanvas`。
   *
   * 为什么是一个 ref：接受提案（本函数上方）必须在调用接口前先把用户那笔
   * 还没 autosave 的编辑写出去，否则服务端返回的文档会把它抹掉。但
   * `flushPendingCanvas` 要等 `writeCanvas` 先定义，而那一段在四千行以下—
   * —直接把函数写进依赖数组，等于让上面这个回调依赖下面整条链。ref 是这里
   * 唯一不需要搬家就能表达的依赖：它在挂载后总是最新的那个闭包。
   */
  const flushPendingRef = useRef<() => Promise<void>>(async () => {})
  /**
   * Where every canvas-owned overlay mounts. See the host div in the render:
   * portals to <body> are invisible while the canvas is fullscreen, because the
   * promoted element is in the top layer and paints above the document.
   */
  const overlayHostRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<CanvasDocument | null>(null)
  const selectedIdsRef = useRef<Set<string>>(selectedIds)
  const dragRef = useRef<NodeDragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const connectRef = useRef<ConnectState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)
  const panFrameRef = useRef<number | null>(null)
  const syncedRef = useRef('')
  /** Sequence of the newest canvas write. A response carrying an older number
   *  belongs to a superseded edit and must not reach the screen. */
  const saveSeqRef = useRef(0)
  /** True while `flushPendingCanvas` owns the write: the autosave effect must
   *  not schedule a second write of the same snapshot behind it. */
  const flushRef = useRef(false)
  const processedTasks = useRef(new Set<string>())
  const processedImport = useRef('')
  const localTaskIds = useRef(new Set<string>())
  /** Video tasks this canvas submitted (so a stale poll cannot claim them). */
  const localVideoTaskIds = useRef(new Set<string>())
  /** Video tasks this canvas already resolved into a node. */
  const processedVideoTasks = useRef(new Set<string>())
  const mountedAtRef = useRef(Date.now())
  const internalClipboard = useRef<{ nodes: CanvasNode[]; connections: Array<{ fromNodeId: string; toNodeId: string; role?: CanvasConnectionRole }> } | null>(null)
  const pastRef = useRef<string[]>([])
  const futureRef = useRef<string[]>([])
  const composerTargetRef = useRef<string | null>(null)

  documentRef.current = document
  selectedIdsRef.current = selectedIds

  // ------------------------------------------------------------ utilities

  const screenToWorld = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    const current = documentRef.current
    if (bounds === undefined || current === null) return { x: clientX, y: clientY }
    return {
      x: (clientX - bounds.left - current.viewport.x) / current.viewport.k,
      y: (clientY - bounds.top - current.viewport.y) / current.viewport.k,
    }
  }, [])

  /**
   * The middle of the canvas area that is NOT covered by the bottom chrome.
   *
   * Every "where does the new node go" path lands here, and the chrome (minimap
   * + zoom dock + job dock) floats over the canvas rather than taking layout
   * space from it, so the geometric centre of the viewport sits behind the
   * docks. On the three-column studio that is exactly how a new node appeared
   * with its title row under the job dock.
   */
  const canvasCenter = useCallback((): Point => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    const current = documentRef.current
    if (bounds === undefined || current === null) return { x: 0, y: 0 }
    const freeHeight = Math.max(80, bounds.height - chromeHeight - 26)
    return screenToWorld(bounds.left + bounds.width / 2, bounds.top + freeHeight / 2)
  }, [screenToWorld, chromeHeight])

  const beginHistory = useCallback((): string | null => {
    const current = documentRef.current
    if (current === null) return null
    const snapshot = JSON.stringify(current)
    if (pastRef.current[pastRef.current.length - 1] === snapshot) return snapshot
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), snapshot]
    futureRef.current = []
    setHistoryVersion(version => version + 1)
    return snapshot
  }, [])

  const commitSnapshot = useCallback((snapshot: string | null): void => {
    if (snapshot === null) return
    const current = documentRef.current
    if (current === null || JSON.stringify(current) === snapshot) return
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), snapshot]
    futureRef.current = []
    setHistoryVersion(version => version + 1)
  }, [])

  const updateDocument = useCallback((updater: (previous: CanvasDocument) => CanvasDocument): void => {
    setDocument(previous => previous === null ? previous : updater(previous))
  }, [])

  const mutate = useCallback((updater: (previous: CanvasDocument) => CanvasDocument): void => {
    beginHistory()
    updateDocument(updater)
  }, [beginHistory, updateDocument])

  const undo = useCallback((): void => {
    const snapshot = pastRef.current[pastRef.current.length - 1]
    const current = documentRef.current
    if (snapshot === undefined || current === null) return
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = [...futureRef.current, JSON.stringify(current)]
    setDocument(JSON.parse(snapshot) as CanvasDocument)
    setHistoryVersion(version => version + 1)
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [])

  const redo = useCallback((): void => {
    const snapshot = futureRef.current[futureRef.current.length - 1]
    const current = documentRef.current
    if (snapshot === undefined || current === null) return
    futureRef.current = futureRef.current.slice(0, -1)
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), JSON.stringify(current)]
    setDocument(JSON.parse(snapshot) as CanvasDocument)
    setHistoryVersion(version => version + 1)
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [])

  const setViewport = useCallback((viewport: CanvasDocument['viewport']): void => {
    updateDocument(previous => ({ ...previous, viewport }))
  }, [updateDocument])

  // ------------------------------------------------------- node operations

  const placeNewNode = useCallback((node: CanvasNode): void => {
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, node] }))
    setSelectedIds(new Set([node.id])); setSelectedConnectionId(null)
  }, [mutate])

  const createImageNode = useCallback((asset: CanvasAssetRef, position?: Point): CanvasNode => {
    const size = sizeForAsset(asset)
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'image', title: asset.origin === 'gallery' ? tt('canvas.fromGallery') : asset.origin === 'history' ? tt('canvas.fromHistory') : tt('canvas.imageNode'),
      x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2),
      width: size.width, height: size.height,
      metadata: { asset, status: 'success' },
    }
  }, [canvasCenter])

  /** A file node with no bytes yet — clicking it opens the picker. */
  const createEmptyFileNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'file', title: tt('canvas.skills.fileNode'),
      x: Math.round(center.x - FILE_NODE_SIZE.width / 2), y: Math.round(center.y - FILE_NODE_SIZE.height / 2),
      width: FILE_NODE_SIZE.width, height: FILE_NODE_SIZE.height,
      metadata: {
        asset: { assetId: '', url: '', mime: 'application/octet-stream', bytes: 0, width: 1, height: 1, origin: 'upload', kind: 'file', name: '' },
        fileKind: 'other',
        status: 'idle',
      },
    }
  }, [canvasCenter])

  const createTextNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'text', title: tt('canvas.textNode'),
      x: Math.round(center.x - TEXT_NODE_SIZE.width / 2), y: Math.round(center.y - TEXT_NODE_SIZE.height / 2),
      width: TEXT_NODE_SIZE.width, height: TEXT_NODE_SIZE.height,
      metadata: { text: '', fontSize: 14 },
    }
  }, [canvasCenter])

  const createConfigNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'config', title: tt('canvas.configNode'),
      x: Math.round(center.x - CONFIG_NODE_SIZE.width / 2), y: Math.round(center.y - CONFIG_NODE_SIZE.height / 2),
      width: CONFIG_NODE_SIZE.width, height: CONFIG_NODE_SIZE.height,
      metadata: { status: 'idle' },
    }
  }, [canvasCenter])

  /** Sketch boards are image nodes carrying live stroke data; the rasterized
   *  PNG lands in `metadata.asset` (see SketchBoard) so they join generation
   *  as ordinary reference images. */
  const createSketchNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'image', title: tt('canvas.sketchNode'),
      x: Math.round(center.x - SKETCH_NODE_SIZE.width / 2), y: Math.round(center.y - SKETCH_NODE_SIZE.height / 2),
      width: SKETCH_NODE_SIZE.width, height: SKETCH_NODE_SIZE.height,
      metadata: { sketch: { strokes: [] }, status: 'idle' },
    }
  }, [canvasCenter])

  /** A shot list that produces one clip per shot, in list order.
   *
   * Deliberately a node type of its own rather than a text node with a magic
   * format: its rows are editable controls, its state is the produced video
   * nodes it points at, and the canvas needs to tell it apart when it decides
   * what can be stitched. */
  const createStoryboardNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'storyboard', title: tt('canvas.storyboardNode'),
      x: Math.round(center.x - STORYBOARD_NODE_SIZE.width / 2), y: Math.round(center.y - STORYBOARD_NODE_SIZE.height / 2),
      width: STORYBOARD_NODE_SIZE.width, height: STORYBOARD_NODE_SIZE.height,
      metadata: { storyboard: defaultStoryboard(), status: 'idle' },
    }
  }, [canvasCenter])

  /** A brand-new canvas starts with one text node wired into one config node,
   *  laid out around the visible viewport center so the workflow is obvious. */
  const seedDocument = useCallback((created: CanvasDocument): CanvasDocument => {
    if (created.nodes.length > 0) return created
    const bounds = viewportRef.current?.getBoundingClientRect()
    const viewport = created.viewport
    // Same reservation as `canvasCenter`: the seed pair is the FIRST thing a
    // user sees, and centring it behind the bottom dock is how a brand-new
    // canvas opens with both nodes half-covered.
    const freeHeight = bounds !== undefined ? Math.max(80, bounds.height - chromeHeight - 26) : 0
    const center = bounds !== undefined && bounds.width > 0 && bounds.height > 0
      ? { x: (bounds.width / 2 - viewport.x) / viewport.k, y: (freeHeight / 2 - viewport.y) / viewport.k }
      : { x: 480, y: 320 }
    const config = createConfigNode(center)
    const text: CanvasNode = {
      ...createTextNode(),
      x: Math.round(config.x - TEXT_NODE_SIZE.width - 80),
      y: Math.round(config.y + (CONFIG_NODE_SIZE.height - TEXT_NODE_SIZE.height) / 2),
    }
    return {
      ...created,
      nodes: [text, config],
      connections: [{ id: newId('edge'), fromNodeId: text.id, toNodeId: config.id }],
    }
  }, [createConfigNode, createTextNode, chromeHeight])

  const updateNodes = useCallback((updater: (nodes: CanvasNode[]) => CanvasNode[]): void => {
    updateDocument(previous => ({ ...previous, nodes: updater(previous.nodes) }))
  }, [updateDocument])

  const patchNode = useCallback((nodeId: string, patch: Partial<NonNullable<CanvasNode['metadata']>> & Partial<Pick<CanvasNode, 'title' | 'width' | 'height' | 'x' | 'y'>>): void => {
    updateNodes(nodes => nodes.map(node => node.id === nodeId
      ? { ...node, ...('title' in patch ? { title: patch.title ?? node.title } : {}), ...('x' in patch || 'y' in patch || 'width' in patch || 'height' in patch ? { x: patch.x ?? node.x, y: patch.y ?? node.y, width: patch.width ?? node.width, height: patch.height ?? node.height } : {}), metadata: { ...nodeMetadata(node), ...patch } }
      : node))
  }, [updateNodes])

  /** Sketch board write-backs. Stroke edits bypass history (the board has its
   *  own stroke-level undo); asset sync happens inside SketchBoard. */
  const patchSketchStrokes = useCallback((nodeId: string, strokes: CanvasSketchStroke[]): void => {
    patchNode(nodeId, { sketch: { strokes } })
  }, [patchNode])

  const patchSketchAsset = useCallback((nodeId: string, asset: CanvasAssetRef | undefined): void => {
    patchNode(nodeId, { asset, status: asset === undefined ? 'idle' : 'success' })
  }, [patchNode])

  const deleteSelection = useCallback((): void => {
    const ids = selectedIdsRef.current
    const connectionId = selectedConnectionId
    if (ids.size === 0 && connectionId === null) return
    const current = documentRef.current
    if (current === null) return
    const { removed } = removeNodesAndCards(current.nodes, ids)
    mutate(previous => {
      const result = removeNodesAndCards(previous.nodes, removed)
      return {
        ...previous,
        nodes: result.nodes,
        connections: previous.connections.filter(connection => !result.removed.has(connection.fromNodeId) && !result.removed.has(connection.toNodeId) && connection.id !== connectionId),
        // 分组按「还剩谁」重建，而不是按「删了谁」逐个剔除：删除路径有好几条
        // （这里、deleteNode、react-flow 的 remove 变更），每条都维护一份删除
        // 清单迟早在某条上漏掉一个 id，而按剩余集合重算在每条路径上都是同一个
        // 表达式。成员被删光的组顺带消失——留着只会在菜单里变成点不动的条目。
        groups: pruneGroupsField(previous.groups, new Set(result.nodes.map(node => node.id))),
      }
    })
    // Bulk delete must clear the dead-clip marks too, exactly like deleteNode:
    // an undo would otherwise restore nodes that still claim their clip is gone.
    setBrokenVideoIds(previous => {
      if (previous.size === 0) return previous
      const next = new Set(previous)
      for (const id of removed) next.delete(id)
      return next
    })
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [mutate, selectedConnectionId])

  /** Delete one specific node. The hover toolbar acts on the node under the
   *  pointer, never on whatever happens to be selected — clicking a button on a
   *  node that was not selected used to delete the wrong node (or nothing). */
  const deleteNode = useCallback((nodeId: string): void => {
    const current = documentRef.current
    if (current === null || !current.nodes.some(node => node.id === nodeId)) return
    const { removed } = removeNodesAndCards(current.nodes, new Set([nodeId]))
    mutate(previous => {
      const result = removeNodesAndCards(previous.nodes, removed)
      return {
        ...previous,
        nodes: result.nodes,
        connections: previous.connections.filter(connection => !result.removed.has(connection.fromNodeId) && !result.removed.has(connection.toNodeId)),
        // 与 deleteSelection 同一表达式、同一个理由（见那里的注释）。
        groups: pruneGroupsField(previous.groups, new Set(result.nodes.map(node => node.id))),
      }
    })
    setSelectedIds(previous => {
      if (!previous.has(nodeId)) return previous
      const next = new Set(previous)
      next.delete(nodeId)
      return next
    })
    // Drop the node's dead-clip mark with it, so an undo does not restore a
    // node that still claims its clip is missing.
    clearBrokenVideo(nodeId)
  }, [clearBrokenVideo, mutate])

  /** Duplicate one specific node (same rule as {@link deleteNode}). */
  const duplicateNode = useCallback((nodeId: string): void => {
    const current = documentRef.current
    if (current === null) return
    const source = current.nodes.find(node => node.id === nodeId)
    if (source === undefined) return
    const { clones } = cloneNodesWithCards([source], current.nodes, 40, 40)
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [mutate])

  const duplicateSelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    const source = current.nodes.filter(node => selectedIdsRef.current.has(node.id))
    const { clones, idMap } = cloneNodesWithCards(source, current.nodes, 40, 40)
    if (clones.length === 0) return
    const connections = current.connections
      .filter(connection => idMap.has(connection.fromNodeId) && idMap.has(connection.toNodeId))
      .map(connection => ({ id: newId('edge'), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)!, ...(connection.role === undefined ? {} : { role: connection.role }) }))
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones], connections: [...previous.connections, ...connections] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [mutate])

  const copySelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    const selected = current.nodes.filter(node => selectedIdsRef.current.has(node.id))
    // Attached 标注 cards travel with the copied image nodes.
    const cards = selected.flatMap(node => node.type === 'image' ? attachedCards(node, current.nodes) : [])
    const nodes = [...selected, ...cards.filter(card => !selectedIdsRef.current.has(card.id))]
    internalClipboard.current = {
      nodes: nodes.map(node => ({ ...node, metadata: { ...nodeMetadata(node) } })),
      // 角色跟着走：复制一个标了首帧的画布片段，粘出来还该是同一条语义，
      // 而不是默默降级成普通输入。
      connections: current.connections.filter(connection => selectedIdsRef.current.has(connection.fromNodeId) && selectedIdsRef.current.has(connection.toNodeId)).map(connection => ({ fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId, ...(connection.role === undefined ? {} : { role: connection.role }) })),
    }
  }, [])

  const pasteClipboard = useCallback((position?: Point): void => {
    const clipboard = internalClipboard.current
    if (clipboard === null || clipboard.nodes.length === 0) return
    const bounds = nodesBounds(clipboard.nodes)
    const target = position ?? canvasCenter()
    const dx = target.x - (bounds.minX + (bounds.maxX - bounds.minX) / 2)
    const dy = target.y - (bounds.minY + (bounds.maxY - bounds.minY) / 2)
    const { clones, idMap } = cloneNodesWithCards(clipboard.nodes, clipboard.nodes, dx, dy)
    const connections = clipboard.connections.map(connection => ({ id: newId('edge'), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)!, ...(connection.role === undefined ? {} : { role: connection.role }) }))
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones], connections: [...previous.connections, ...connections] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [canvasCenter, mutate])

  const connectNodes = useCallback((fromNodeId: string, toNodeId: string, role?: CanvasConnectionRole): void => {
    if (fromNodeId === toNodeId) return
    const current = documentRef.current
    if (current === null) return
    if (current.connections.some(connection => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)) return
    // 拖线的手势不猜角色：新边就是普通输入。角色要么由用户从菜单里设，
    // 要么由生成前的补边按「首帧/尾帧/参考」自己标。
    mutate(previous => ({ ...previous, connections: [...previous.connections, { id: newId('edge'), fromNodeId, toNodeId, ...(role === undefined || role === 'input' ? {} : { role }) }] }))
  }, [mutate])

  /** Dify-style quick add: create a node to the right of `sourceId`, vertically
   *  centered against it, and wire source -> new node in one history step. The
   *  target spot walks right past any node already occupying it, and the
   *  viewport pans just enough to keep the new node visible. */
  const addConnectedNode = useCallback((sourceId: string, factory: (position: Point) => CanvasNode): void => {
    const current = documentRef.current
    if (current === null) return
    const source = current.nodes.find(item => item.id === sourceId)
    if (source === undefined) return
    const draft = factory({ x: 0, y: 0 })
    const y = Math.round(source.y + (source.height - draft.height) / 2)
    let x = source.x + source.width + 90
    for (let guard = 0; guard < 24; guard += 1) {
      const clash = current.nodes.find(node =>
        Math.abs((y + draft.height / 2) - (node.y + node.height / 2)) < (draft.height + node.height) / 2 + 20
        && x < node.x + node.width + 48
        && x + draft.width > node.x - 48)
      if (clash === undefined) break
      x = clash.x + clash.width + 88
    }
    const node: CanvasNode = { ...draft, x, y }
    mutate(previous => ({
      ...previous,
      nodes: [...previous.nodes, node],
      connections: [...previous.connections, { id: newId('edge'), fromNodeId: sourceId, toNodeId: node.id }],
    }))
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const viewport = current.viewport
    const k = viewport.k
    const left = viewport.x + x * k
    const right = viewport.x + (x + draft.width) * k
    const top = viewport.y + y * k
    const bottom = viewport.y + (y + draft.height) * k
    let dx = 0
    let dy = 0
    if (right > bounds.width - 24) dx = right - (bounds.width - 24)
    if (bottom > bounds.height - 24) dy = bottom - (bounds.height - 24)
    if (dx !== 0 || dy !== 0) setViewport({ x: viewport.x - dx, y: viewport.y - dy, k })
  }, [mutate, setViewport])

  /** Anchor the add-node menu at the source handle's on-screen position. The
   *  menu opens on hover (no click needed) and lingers briefly on leave. */
  const nodeAddMenuTimer = useRef<number | null>(null)
  const clearNodeAddMenuTimer = useCallback((): void => {
    if (nodeAddMenuTimer.current !== null) { window.clearTimeout(nodeAddMenuTimer.current); nodeAddMenuTimer.current = null }
  }, [])
  const scheduleNodeAddMenuClose = useCallback((): void => {
    clearNodeAddMenuTimer()
    nodeAddMenuTimer.current = window.setTimeout(() => setNodeAddMenu(null), 260)
  }, [clearNodeAddMenuTimer])
  const openNodeAddMenu = useCallback((node: CanvasNode): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    clearNodeAddMenuTimer()
    const viewport = current.viewport
    setNodeAddMenu({
      nodeId: node.id,
      nodeType: node.type,
      screen: {
        x: bounds.left + viewport.x + (node.x + node.width) * viewport.k,
        y: bounds.top + viewport.y + (node.y + node.height / 2) * viewport.k,
      },
    })
  }, [clearNodeAddMenuTimer])

  const downloadNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.url === '') return
    const link = globalThis.document.createElement('a')
    link.href = asset.url
    link.download = `${node.title || 'canvas-image'}.${asset.assetId.split('.').pop() ?? 'png'}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.click()
  }, [])

  const upstreamNodes = useCallback((canvasDocument: CanvasDocument, nodeId: string): CanvasNode[] => {
    const byId = new Map(canvasDocument.nodes.map(node => [node.id, node]))
    return canvasDocument.connections
      .filter(connection => connection.toNodeId === nodeId)
      .map(connection => byId.get(connection.fromNodeId))
      .filter((node): node is CanvasNode => node !== undefined)
  }, [])

  /**
   * 这次生成要额外带上的身份参考节点。
   *
   * 连线是「这一张的输入」，身份锚定是「这部片子的设定」：即使某个角色这一
   * 次没有连线，只要它在画布上被钉住，生成就应该带上它。两者的去重规则在
   * cast.ts 里，与界面无关。
   */
  const castRefsFor = useCallback((canvasDocument: CanvasDocument, already: readonly string[]): CanvasNode[] => {
    const members = castMembers(canvasDocument.nodes)
    const byId = new Map(canvasDocument.nodes.map(node => [node.id, node]))
    return castReferenceIds(members, already).flatMap(nodeId => {
      const node = byId.get(nodeId)
      return node === undefined ? [] : [node]
    })
  }, [])

  /** 身份参考在提示词里的那几句话；没有参考就不加，免得留一行空话。 */
  const castPromptOf = useCallback((canvasDocument: CanvasDocument, ids: readonly string[]): string => {
    if (ids.length === 0) return ''
    const members = castMembers(canvasDocument.nodes)
    return castPromptLines(members.filter(member => ids.includes(member.nodeId)), castLine).join('\n')
  }, [])

  // --------------------------------------------------------- skills / files

  /** Create a file node for an uploaded or produced asset. */
  const createFileNode = useCallback((asset: CanvasAssetRef, position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'),
      type: 'file',
      title: asset.name ?? tt('canvas.skills.fileNode'),
      x: Math.round(center.x - FILE_NODE_SIZE.width / 2),
      y: Math.round(center.y - FILE_NODE_SIZE.height / 2),
      width: FILE_NODE_SIZE.width,
      height: FILE_NODE_SIZE.height,
      metadata: { asset, fileKind: fileKindOfAsset(asset), status: 'success' },
    }
  }, [canvasCenter])

  /** Upload one file and place it as a node (or fill the empty placeholder). */
  const uploadCanvasFile = useCallback(async (file: File, targetNodeId?: string | null, position?: Point): Promise<void> => {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
    if (BLOCKED_UPLOAD_EXTENSIONS.has(extension)) {
      setError(tt('canvas.skills.fileTypeBlocked', { ext: `.${extension}` }))
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(tt('canvas.skills.fileTooLarge', { size: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) }))
      return
    }
    try {
      const asset = await api.canvasFileUpload(file)
      const nodeId = targetNodeId ?? null
      if (nodeId !== null) {
        // An empty file node adopts the asset instead of growing a sibling.
        patchNode(nodeId, { asset, fileKind: fileKindOfAsset(asset), status: 'success' })
        mutate(previous => ({
          ...previous,
          nodes: previous.nodes.map(node => node.id === nodeId ? { ...node, title: asset.name ?? node.title } : node),
        }))
        return
      }
      placeNewNode(createFileNode(asset, position))
    } catch (caught) {
      setError(tt('canvas.skills.fileUploadFailed', { message: errorMessage(caught) }))
    }
  }, [api, createFileNode, mutate, patchNode, placeNewNode])

  /** Lazy skill catalog; failures land in the picker's reason line. */
  const loadSkillCatalog = useCallback(async (): Promise<void> => {
    if (skillCatalogLoading) return
    setSkillCatalogLoading(true)
    try {
      const catalog = await api.canvasSkillsList()
      setSkillCatalog({
        skills: catalog.skills,
        installed: catalog.installed ?? [],
        ...catalog.reason === undefined ? {} : { reason: catalog.reason },
      })
    } catch (caught) {
      setSkillCatalog({ skills: [], installed: [], reason: errorMessage(caught) })
    } finally {
      setSkillCatalogLoading(false)
    }
  }, [api, skillCatalogLoading])

  /** Reload the skill library listing (dock dialog and post-install refresh). */
  const loadSkillLibrary = useCallback(async (): Promise<void> => {
    setLibraryLoading(true)
    try {
      setSkillLibrary(await api.canvasSkillLibrary())
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryLoading(false)
    }
  }, [api])

  /** Open the library manager, optionally prefilled with one upstream. */
  const openSkillLibrary = useCallback((presetUrl = ''): void => {
    setLibraryPresetUrl(presetUrl)
    setLibraryFocusSkill('')
    setSkillLibraryOpen(true)
    void loadSkillLibrary()
  }, [loadSkillLibrary])

  /** Open the library focused on one skill's declared configuration. */
  const openSkillConfig = useCallback((skillName: string): void => {
    setLibraryPresetUrl('')
    setLibraryFocusSkill(skillName)
    setSkillLibraryOpen(true)
    void loadSkillLibrary()
  }, [loadSkillLibrary])

  /** Save one skill's declared configuration values. */
  const saveSkillValues = useCallback(async (name: string, values: Array<{ id: string; value: string }>): Promise<CanvasSkillConfigSaveResult> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillConfigSave({ name, values })
      if (result.library !== undefined) setSkillLibrary(result.library)
      await loadSkillCatalog()
      return result
    } catch (caught) {
      return { ok: false, library: skillLibrary ?? { root: '', entries: [], catalog: [], networkAvailable: false }, message: errorMessage(caught) }
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog, skillLibrary])

  /** Run a skill declaration's `apply` steps with the saved values. */
  const applySkillValues = useCallback(async (name: string): Promise<CanvasSkillConfigApplyResult> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillConfigApply({ name })
      if (result.library !== undefined) setSkillLibrary(result.library)
      await loadSkillCatalog()
      return result
    } catch (caught) {
      return { ok: false, library: skillLibrary ?? { root: '', entries: [], catalog: [], networkAvailable: false }, steps: [], message: errorMessage(caught) }
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog, skillLibrary])

  /** Install one archive the user picked in the library dialog. */
  const installSkillArchive = useCallback(async (file: File, force: boolean): Promise<void> => {
    setLibraryBusy(true)
    try {
      const asset = await api.canvasFileUpload(file)
      const result = await api.canvasSkillInstall({ asset, force, name: file.name.replace(/\.zip$/i, '') })
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.installed.length > 0) setNotice(tt('canvas.skills.libraryInstalledToast', { names: result.installed.join('、') }))
      else setError(tt('canvas.skills.installArchiveFailed', { message: result.message ?? '' }))
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  /** Install skills from one or more URLs. */
  const installSkillUrls = useCallback(async (sources: string[], force: boolean): Promise<void> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillInstall({ sources, force })
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.installed.length > 0) {
        setNotice(tt('canvas.skills.libraryInstalledToast', { names: result.installed.join('、') }))
        setLibraryPresetUrl('')
      }
      const failure = result.failed[0]
      if (failure !== undefined) setError(tt('canvas.skills.libraryFailedToast', { message: failure.message }))
      else if (result.installed.length === 0 && result.message !== undefined) setError(result.message)
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  /** Uninstall one skill. */
  const removeSkillEntry = useCallback(async (name: string): Promise<void> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillRemove(name)
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.ok) setNotice(tt('canvas.skills.libraryRemovedToast', { name }))
      else setError(result.message ?? '')
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  const openSkillMenu = useCallback((node: CanvasNode, anchor: { x: number; y: number }): void => {
    if (!selectedIdsRef.current.has(node.id)) setSelectedIds(new Set([node.id]))
    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null)
    closeDockMenus()
    setSkillMenu({ screen: anchor, nodeId: node.id })
    void loadSkillCatalog()
  }, [closeDockMenus, loadSkillCatalog])

  /** Queue one skill run through the host, grow a run card out of the source
   *  node (connected with an animated edge), and track its task. */
  const startSkillRun = useCallback(async (
    skill: CanvasSkillDescriptor,
    nodeIds: string[],
    instruction?: string,
    extraParams?: Record<string, string>,
  ): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    const focus = nodeIds.find(id => current.nodes.some(node => node.id === id)) ?? nodeIds[0]
    if (focus === undefined) return
    const request: CanvasSkillRunRequest = {
      canvasId: current.id,
      skillId: skill.id,
      nodeIds,
      ...instruction === undefined || instruction.trim() === '' ? {} : { instruction: instruction.trim() },
      ...skill.id === 'polish.text' ? { params: { style: (instruction ?? '').trim() === '' ? 'formal' : 'custom' } } : {},
      // A timeline rides along as a JSON string; the host parses it and refuses
      // a malformed one rather than silently stitching without the trims.
      ...extraParams === undefined ? {} : { params: extraParams },
    }
    try {
      const task = await api.canvasSkillRun(request)
      setSkillRuns(previous => {
        // Several runs on one node stack their cards instead of overlapping.
        const stack = Object.values(previous).filter(trace => trace.nodeId === focus).length
        const source = current.nodes.find(node => node.id === focus)
        const rect = source === undefined
          ? { x: 0, y: 0, width: RUN_NODE_SIZE.width, height: RUN_NODE_SIZE.height }
          : runRectOf(source, stack)
        return {
          ...previous,
          [task.id]: {
            canvasId: current.id,
            nodeId: focus,
            ids: [...nodeIds],
            skillId: skill.id,
            label: skill.name,
            tier: skill.tier,
            stage: task.stage ?? tt('canvas.skills.stageQueued'),
            phase: task.phase ?? 'queued',
            status: 'queued',
            startedAt: task.startedAt,
            rect,
          },
        }
      })
      setNotice(tt('canvas.skills.runStarted', { name: skill.name }))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [api])

  /** Node set one skill run should cover: the acting node plus the compatible
   *  siblings when several nodes are selected (batch mode). */
  const skillTargets = useCallback((skill: CanvasSkillDescriptor, node: CanvasNode): string[] => {
    const current = documentRef.current
    if (current === null) return [node.id]
    const selected = current.nodes.filter(candidate => selectedIdsRef.current.has(candidate.id))
    if (selected.length <= 1) return [node.id]
    const compatible = selected.filter(candidate => candidate.type !== 'config' && skill.accepts.includes(candidate.type))
    if (compatible.length <= 1) return [node.id]
    return compatible.slice(0, MAX_BATCH_SKILL_NODES).map(candidate => candidate.id)
  }, [])

  /** How many selected nodes a run would cover, for the picker's note line. */
  const skillBatchCount = useCallback((nodeId: string): number => {
    const current = documentRef.current
    if (current === null) return 1
    const selected = current.nodes.filter(node => selectedIdsRef.current.has(node.id) && node.type !== 'config')
    return Math.max(1, Math.min(selected.length, MAX_BATCH_SKILL_NODES, current.nodes.length))
  }, [])

  /** Menu pick: a light skill runs at once; heavy and local ones ask first. */
  const pickSkill = useCallback((skill: CanvasSkillDescriptor, node: CanvasNode): void => {
    setSkillMenu(null)
    // Stitching branches before the batch helper on purpose: that helper is
    // ordered by document insertion, and a run whose membership was decided by
    // array position would stitch a different set of clips than the badges
    // number. One list — canvas order — feeds badges, bar, confirm and request.
    if (skill.id === COMPOSE_SKILL_ID) {
      const current = documentRef.current
      const composeIds = current === null ? [] : composeClipIds(current.nodes, selectedIdsRef.current)
      if (composeIds.length < 2) {
        setError(tt('canvas.skills.composeTooFew'))
        return
      }
      setPendingSkill({ skill, nodeIds: composeIds, instruction: '' })
      return
    }
    const nodeIds = skillTargets(skill, node)
    if (skill.tier === 'heavy' || skill.tier === 'local') {
      setPendingSkill({ skill, nodeIds, instruction: '' })
      return
    }
    if (nodeIds.length > MAX_BATCH_SKILL_NODES) {
      setError(tt('canvas.skills.batchTooMany', { count: MAX_BATCH_SKILL_NODES }))
      return
    }
    void startSkillRun(skill, nodeIds)
  }, [skillTargets, startSkillRun])

  /** Cancel one running skill (the host aborts a heavy agent run). */
  const cancelSkillRun = useCallback(async (taskId: string): Promise<void> => {
    try {
      await api.canvasSkillCancel(taskId)
      setSkillRuns(previous => {
        const next = { ...previous }
        delete next[taskId]
        return next
      })
      setNotice(tt('canvas.skills.runCancelled'))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [api])

  /** Download one file node's asset through the browser. */
  const downloadFileNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.assetId === '') return
    const anchor = globalThis.document.createElement('a')
    anchor.href = asset.url
    anchor.download = asset.name ?? node.title
    anchor.rel = 'noopener'
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, [])

  /** Open a file asset in the in-app reader (system programs stay one click
   *  away through the reader's own download / open-in-tab actions). */
  const openFileNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.assetId === '') return
    setFilePreviewNodeId(node.id)
  }, [])

  /** Open one image node in the full-screen reader. */
  const openImageNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (node.type !== 'image' || asset === undefined || asset.url === '') return
    setFilePreviewNodeId(node.id)
  }, [])

  /** One-click AI polish for a text node (light tier, replaces the text). */
  const polishTextNode = useCallback(async (node: CanvasNode, style: string, instruction?: string): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    setPolishBusy(node.id)
    setBusyNodes(previous => ({ ...previous, [node.id]: tt('canvas.skills.polish') }))
    try {
      const task = await api.canvasSkillRun({
        canvasId: current.id,
        skillId: 'polish.text',
        nodeIds: [node.id],
        ...style === 'custom' ? { instruction: instruction ?? '', params: { style: 'custom' } } : { params: { style } },
      })
      const snapshot = await new Promise<CanvasSkillTask>((resolve, reject) => {
        const started = Date.now()
        const tick = (): void => {
          void api.canvasSkillTask(task.id).then(current => {
            if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') { resolve(current); return }
            if (Date.now() - started > 300_000) { reject(new Error(tt('canvas.skills.runFailed', { message: 'timeout' }))); return }
            window.setTimeout(tick, 1200)
          }, reject)
        }
        tick()
      })
      if (snapshot.status !== 'completed') throw new Error(snapshot.error ?? tt('canvas.skills.runCancelled'))
      const produced = (snapshot.output?.nodes ?? []).find(candidate => candidate.type === 'text')
      const text = produced?.metadata?.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error(tt('canvas.skills.runFailed', { message: 'empty' }))
      // Write the result into the node itself: one click, undoable with Ctrl+Z.
      patchNode(node.id, { text })
      setNotice(tt('canvas.polish.applied'))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPolishBusy(null)
      setBusyNodes(previous => {
        const next = { ...previous }
        delete next[node.id]
        return next
      })
    }
  }, [api, patchNode])

  /** Apply one polish style to the acting node (or every selected text node). */
  const runPolish = useCallback((nodeId: string, style: string, instruction?: string): void => {
    const current = documentRef.current
    setPolishNode(null)
    if (current === null) return
    const selected = current.nodes.filter(node => node.type === 'text' && selectedIdsRef.current.has(node.id))
    const targets = selected.length > 1 && selected.some(node => node.id === nodeId)
      ? selected.slice(0, MAX_BATCH_SKILL_NODES)
      : [current.nodes.find(node => node.id === nodeId)].filter((node): node is CanvasNode => node !== undefined)
    // Sequential: the host serializes runs anyway, and each pass reads the
    // previous text only from its own node.
    void targets.reduce<Promise<void>>(
      (chain, node) => chain.then(() => polishTextNode(node, style, instruction)),
      Promise.resolve(),
    )
  }, [polishTextNode])

  /** Mutation applier for one finished skill run: the produced nodes and edges
   *  land in the current document, and the source nodes keep a provenance tag. */
  const applySkillOutput = useCallback((task: CanvasSkillTask, sourceNodeIds: string[]): number => {
    const output = task.output
    if (output === undefined) return 0
    const nodes = output.nodes ?? []
    const connections = output.connections ?? []
    if (nodes.length === 0) return 0
    const ids = new Set(nodes.map(node => node.id))
    mutate(previous => {
      // 输出节点按 id 幂等落盘：同一次运行的结果可能被两条路径各应用一次
      // （轮询的 tick 在 await 之后用的是 ref 里的旧快照，而“切回原画布再落地”
      // 那条 effect 只看 state，两者之间存在窗口），连线那边早就有这种去重，
      // 节点这边原来没有——于是同一个 id 会在一份文档里出现两次。以 id 为准
      // 判定“已落地”，比在调用侧加锁更稳：两条路径谁后到都不会重复。
      const landed = new Set(previous.nodes.map(node => node.id))
      const fresh = nodes.filter(node => !landed.has(node.id))
      return {
        ...previous,
        nodes: [
          ...previous.nodes.map(node => sourceNodeIds.includes(node.id)
            ? {
                ...node,
                metadata: {
                  ...node.metadata,
                  skill: {
                    id: task.skillId,
                    label: task.label ?? task.skillId,
                    sourceNodeIds: [...sourceNodeIds],
                    createdAt: Date.now(),
                  },
                },
              }
            : node),
          ...fresh,
        ],
        connections: [
          ...previous.connections,
          ...connections.filter(connection => ids.has(connection.toNodeId)
            && !previous.connections.some(existing => existing.fromNodeId === connection.fromNodeId && existing.toNodeId === connection.toNodeId)),
        ],
      }
    })
    setSelectedIds(new Set(nodes.map(node => node.id)))
    // A clip-producing run has just persisted its clip into the video history,
    // which the panel reads only once: tell it to refresh that list. Kept out of
    // the mutate updater above, which has to stay pure, and fired for video
    // output only so a polish/describe run cannot trigger a history refetch.
    if (nodes.some(node => node.type === 'video')) onClipStored?.()
    // 报输出节点数而不是“实际新增数”：mutate 的 updater 要到 React 渲染阶段
    // 才执行，这里同步读不到它算出的数量。
    return nodes.length
  }, [mutate, onClipStored])

  /** Poll the host while runs are alive; runs are serialized host-side, so a
   *  single interval keeps every run card honest without a request storm. The
   *  live map is read through a ref, so only the live count drives the effect. */
  const activeSkillRunCount = Object.values(skillRuns).filter(trace => trace.status === 'queued' || trace.status === 'running').length
  useEffect(() => {
    skillRunsRef.current = skillRuns
  }, [skillRuns])
  useEffect(() => {
    if (activeSkillRunCount === 0) return undefined
    let disposed = false
    // The interval fires every 1.5s but a snapshot request is a network round
    // trip: when the host is slow, a tick is still inside `await` when the next
    // one starts. Overlapping ticks re-request every snapshot and each may fire
    // its own notice for the same transition. The outputs themselves are
    // id-keyed in `applySkillOutput`, so a second apply cannot duplicate a
    // node -- this guard is about not repeating the work, not about D1.
    let ticking = false
    const tick = async (): Promise<void> => {
      if (ticking) return
      ticking = true
      try { await pollOnce() } finally { ticking = false }
    }
    const pollOnce = async (): Promise<void> => {
      const ids = Object.keys(skillRunsRef.current)
      for (const taskId of ids) {
        const entry = skillRunsRef.current[taskId]
        if (entry === undefined || disposed || entry.status === 'failed' || entry.status === 'pending') continue
        let snapshot: CanvasSkillTask
        try {
          snapshot = await api.canvasSkillTask(taskId)
        } catch {
          // A dropped task (host restart) must not spin forever.
          setSkillRuns(previous => {
            const next = { ...previous }
            delete next[taskId]
            return next
          })
          continue
        }
        if (disposed) return
        if (snapshot.status === 'completed') {
          if (documentRef.current?.id === entry.canvasId) {
            const added = applySkillOutput(snapshot, entry.ids)
            setNotice(tt('canvas.skills.runDone', { count: added }))
            setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
          } else {
            // The user switched canvases mid-run: hold the result on the card
            // and graft it when the origin canvas is open again.
            setSkillRuns(previous => previous[taskId] === undefined
              ? previous
              : { ...previous, [taskId]: { ...previous[taskId]!, status: 'pending', output: snapshot.output } })
          }
          continue
        }
        if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
          if (snapshot.status === 'cancelled') {
            setNotice(tt('canvas.skills.runCancelled'))
            setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
            continue
          }
          const failed = skillCatalog?.skills.find(skill => skill.id === snapshot.skillId)
          const missing = failed?.skillName !== undefined
            && skillCatalog !== null
            && !skillCatalog.installed.includes(failed.skillName)
          const text = snapshot.error ?? tt('canvas.skills.runFailed', { message: '' })
          setError(text)
          // A missing skill is the one failure the canvas can fix itself:
          // offer the install right in the toast instead of a dead-end error.
          // The action is bound to this exact message so a later, unrelated
          // error never inherits a stale button.
          setErrorAction(missing && failed !== undefined
            ? { label: tt('canvas.skills.installNow'), run: () => openSkillLibrary(failed.installUrl ?? ''), forError: text }
            : null)
          // The run card stays on the canvas with the error + retry actions.
          setSkillRuns(previous => previous[taskId] === undefined
            ? previous
            : { ...previous, [taskId]: { ...previous[taskId]!, status: 'failed', error: text, phase: previous[taskId]!.phase } })
          continue
        }
        const stage = snapshot.stage ?? ''
        const phase = snapshot.phase ?? 'running'
        if (stage !== entry.stage || phase !== entry.phase) {
          setSkillRuns(previous => previous[taskId] === undefined
            ? previous
            : { ...previous, [taskId]: { ...previous[taskId]!, stage, phase, status: snapshot.status === 'running' ? 'running' : previous[taskId]!.status } })
        }
      }
    }
    const timer = window.setInterval(() => { void tick() }, 1500)
    void tick()
    return () => { disposed = true; window.clearInterval(timer) }
  }, [activeSkillRunCount, api, applySkillOutput, skillCatalog])

  /** A run that finished while another canvas was open lands as soon as its
   *  own canvas is shown again. */
  const pendingSkillOutputs = Object.entries(skillRuns).filter(([, trace]) => trace.status === 'pending' && trace.canvasId === document?.id)
  // Keyed by WHICH runs are pending, not how many. The poll tick skips
  // `status === 'pending'` outright, so this effect is the only thing that ever
  // applies a held back output; if it does not re-run, that output never lands
  // and its card stays on the canvas forever. The count is not enough because
  // React batches: when one held output is deleted here and another run turns
  // pending in the same commit, the length is 1 before and 1 after, the deps
  // compare equal, and the newcomer is never applied. Joining the ids tells
  // those two situations apart while staying a primitive; the sort keeps the
  // key stable against entry order.
  const pendingSkillOutputKey = pendingSkillOutputs.map(([taskId]) => taskId).sort().join(',')
  useEffect(() => {
    if (pendingSkillOutputKey === '') return
    for (const [taskId, trace] of pendingSkillOutputs) {
      if (trace.output !== undefined) {
        const added = applySkillOutput({ skillId: trace.skillId, label: trace.label, output: trace.output } as CanvasSkillTask, trace.ids)
        setNotice(tt('canvas.skills.runDone', { count: added }))
      }
      setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSkillOutputKey, document?.id, applySkillOutput])

  /** Reopen recovery: a canvas with live host-side runs rebuilds its run cards
   *  (page reload or canvas switch loses the browser-side traces). */
  const seedSkillRuns = useCallback(async (canvasId: string): Promise<void> => {
    let tasks: CanvasSkillTask[]
    try {
      tasks = await api.canvasSkillTasks(canvasId)
    } catch {
      return
    }
    setSkillRuns(previous => {
      const next: Record<string, SkillRunTrace> = {}
      for (const [taskId, trace] of Object.entries(previous)) {
        // Keep every trace that is not this canvas's settled business:
        //  - another canvas's trace belongs to a different document, and the
        //    poll that watches it keeps running globally, so dropping it here
        //    loses the run the moment the user looks at another canvas;
        //  - a `pending` trace is the ONLY copy of a held output (the tick skips
        //    `pending` outright), so nothing would ever re-fetch it.
        // What DOES stay behind is this canvas's own live work: the host is the
        // authority on that after a reopen, which is what the tasks below
        // rebuild. Measured cause, not symmetry: with the old filter, switching
        // canvases mid-run deleted the trace, `activeSkillRunCount` fell to
        // zero, the poll effect tore down and never re-armed -- the run was
        // simply gone.
        if (trace.canvasId !== canvasId || trace.status === 'pending') next[taskId] = trace
      }
      const current = documentRef.current
      for (const task of tasks) {
        if (next[task.id] !== undefined) continue
        const sourceId = task.nodeIds?.find(id => current?.nodes.some(node => node.id === id)) ?? task.nodeIds?.[0]
        const source = current?.nodes.find(node => node.id === sourceId)
        if (source === undefined) continue
        next[task.id] = {
          canvasId,
          nodeId: source.id,
          ids: task.nodeIds ?? [source.id],
          skillId: task.skillId,
          label: task.label,
          tier: task.tier,
          stage: task.stage ?? tt('canvas.skills.stageRunning'),
          phase: task.phase ?? 'running',
          status: task.status === 'queued' ? 'queued' : 'running',
          startedAt: task.startedAt,
          rect: runRectOf(source, Object.values(next).filter(trace => trace.nodeId === source.id).length),
        }
      }
      return next
    })
  }, [api])

  useEffect(() => {
    if (document?.id === undefined || document.id === '') return
    void seedSkillRuns(document.id)
  }, [document?.id, seedSkillRuns])

  /** Drop a failed run card the user closed. */
  const dismissSkillRun = useCallback((taskId: string): void => {
    setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
  }, [])

  /** Re-run a failed skill with the same inputs. */
  const retrySkillRun = useCallback((taskId: string, trace: SkillRunTrace): void => {
    setSkillRuns(previous => {
      const next = { ...previous }
      delete next[taskId]
      return next
    })
    const skill = skillCatalog?.skills.find(item => item.id === trace.skillId)
    if (skill === undefined) {
      setError(tt('canvas.skills.empty'))
      return
    }
    void startSkillRun(skill, trace.ids)
  }, [skillCatalog, startSkillRun])

  // --------------------------------------------------------- node tools

  /** Run one long node-local operation while its toolbar shows a spinner. */
  const withNodeBusy = useCallback(async (nodeId: string, label: string, task: () => Promise<void>): Promise<void> => {
    setBusyNodes(previous => ({ ...previous, [nodeId]: label }))
    try {
      await task()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyNodes(previous => {
        const next = { ...previous }
        delete next[nodeId]
        return next
      })
    }
  }, [])

  /** Download one clip (the served URL is same-origin and complete). */
  const downloadVideoNode = useCallback((node: CanvasNode): void => {
    const clip = videoOf(node)
    if (clip === undefined || clip.url === '') return
    const extension = clip.mime.split('/')[1] ?? 'mp4'
    const link = globalThis.document.createElement('a')
    link.href = clip.url
    link.download = `${node.title || 'canvas-video'}.${extension}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.click()
  }, [])

  /**
   * Favorite one clip into the gallery.
   *
   * The host copies the bytes (by naming the video-history entry), so no video
   * ever crosses this call and the favorite survives the video history's size
   * cap.
   */
  const favoriteVideoNode = useCallback((node: CanvasNode): void => {
    const clip = videoOf(node)
    if (clip === undefined || clip.entryId === undefined) return
    void withNodeBusy(node.id, tt('canvas.videoFavorite'), async () => {
      await api.galleryAppendVideo({ entryId: clip.entryId! })
      setNotice(tt('canvas.videoFavorited'))
    }).catch(() => { setError(tt('canvas.videoFavoriteFailed')) })
  }, [api, withNodeBusy])

  /**
   * Grab the clip's current frame as a new image node.
   *
   * Runs in the browser: the clip is same-origin and already Range-served, so
   * seeking it to a timestamp and reading the pixels costs nothing upstream and
   * needs no new host route. The frame lands as an ordinary image node, which
   * means it can immediately feed an image edit or a video keyframe run.
   */
  const grabVideoFrame = useCallback(async (node: CanvasNode): Promise<void> => {
    const clip = videoOf(node)
    if (clip === undefined || clip.url === '') return
    await withNodeBusy(node.id, tt('canvas.videoGrabFrame'), async () => {
      const video = globalThis.document.createElement('video')
      // `crossOrigin` is unnecessary (same-origin) and would add a preflight for
      // no benefit; the served clip already carries no credentials requirement.
      video.src = clip.url
      video.muted = true
      video.preload = 'auto'
      await new Promise<void>((resolve, reject) => {
        const fail = (): void => { reject(new Error(tt('canvas.videoGrabFailed'))) }
        video.addEventListener('loadeddata', () => { resolve() }, { once: true })
        video.addEventListener('error', fail, { once: true })
        // A clip whose metadata never arrives must not hang the node forever.
        window.setTimeout(fail, 15_000)
      })
      // Prefer the middle of the clip: the first frame of a generated shot is
      // often still settling, and the middle is the most representative frame.
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      const target = duration > 0 ? duration / 2 : 0
      if (target > 0) {
        await new Promise<void>((resolve) => {
          video.addEventListener('seeked', () => { resolve() }, { once: true })
          video.currentTime = target
        })
      }
      const width = video.videoWidth
      const height = video.videoHeight
      if (width === 0 || height === 0) throw new Error(tt('canvas.videoGrabFailed'))
      const bitmapCanvas = globalThis.document.createElement('canvas')
      bitmapCanvas.width = width
      bitmapCanvas.height = height
      const context = bitmapCanvas.getContext('2d')
      if (context === null) throw new Error(tt('canvas.videoGrabFailed'))
      context.drawImage(video, 0, 0, width, height)
      const dataUrl = bitmapCanvas.toDataURL('image/png')
      const uploaded = await api.canvasUpload(dataUrl, width, height, { origin: 'generated', originId: node.id })
      const footprint = nodeSizeFromRatio(`${width}:${height}`, IMAGE_NODE_SIZE)
      mutate(previous => {
        const id = newId('node')
        return {
          ...previous,
          nodes: [...previous.nodes, {
            id, type: 'image', title: tt('canvas.videoFrameNode'),
            x: Math.round(node.x + node.width + 80), y: Math.round(node.y),
            width: footprint.width, height: footprint.height,
            metadata: { asset: uploaded, status: 'success', sourceNodeId: node.id },
          }],
          connections: [...previous.connections, { id: newId('edge'), fromNodeId: node.id, toNodeId: id }],
        }
      })
      setNotice(tt('canvas.videoGrabFrame'))
    })
  }, [api, mutate, withNodeBusy])

  /** Compose the 标注 edit reference: the source image plus numbered boxes,
   *  together with the constraint text that pins the edit to those boxes. */
  const annotatedReference = useCallback(async (
    source: CanvasNode,
    boxes: Array<{ rect: CanvasRect; text: string }>,
  ): Promise<{ image: string; prompt: string } | undefined> => {
    const asset = usableAsset(source)
    if (asset === undefined || boxes.length === 0) return undefined
    const raster = await loadRaster(asset.url)
    const composite = drawAnnotation(raster, boxes.map((box, index) => ({ rect: box.rect, index })), rootRef.current)
    const percent = (value: number): string => `${Math.round(clamp01(value) * 100)}%`
    const lines = boxes.map((box, index) => {
      const rect = box.rect
      return `- 框 ${index + 1}（左 ${percent(rect.x)}，上 ${percent(rect.y)}，右 ${percent(rect.x + rect.width)}，下 ${percent(rect.y + rect.height)}）：${box.text}`
    })
    return {
      image: canvasToDataUrl(composite),
      prompt: [
        '【局部修改约束】只修改参考图中红色方框标记的区域，方框之外的内容必须与原图完全一致（构图、人物、文字、颜色与光影都不要变化）。',
        '红色方框和编号只是给你定位用的标记：结果图片里绝对不能出现方框、边框、编号或任何标注痕迹。',
        '标记区域说明：',
        ...lines,
      ].join('\n'),
    }
  }, [])

  /** Annotation plan for one generation: read the boxes (and their attached
   *  prompt cards) straight off the image nodes feeding the config node. The
   *  cards are never wired into the graph, so the canvas stays readable. */
  const annotationPlanOf = useCallback(async (
    canvasDocument: CanvasDocument,
    inputs: CanvasNode[],
  ): Promise<{ image: string; prompt: string; sourceNodeId: string; texts: string[]; boxes: CanvasRect[] } | undefined> => {
    for (const image of inputs) {
      if (image.type !== 'image' || usableAsset(image) === undefined) continue
      const boxes = liveAnnotations(image, canvasDocument.nodes).flatMap(annotation => {
        const card = annotation.nodeId === undefined ? undefined : canvasDocument.nodes.find(node => node.id === annotation.nodeId)
        const text = (card === undefined ? '' : nodeMetadata(card).text ?? '').trim()
        return text === '' ? [] : [{ rect: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }, text }]
      })
      if (boxes.length === 0) continue
      try {
        const reference = await annotatedReference(image, boxes)
        if (reference !== undefined) return { ...reference, sourceNodeId: image.id, texts: boxes.map(box => box.text), boxes: boxes.map(box => box.rect) }
      } catch { /* unreadable source: fall back to the plain reference path */ }
    }
    return undefined
  }, [annotatedReference])

  /** 标注: hang a prompt card off one drawn box. The card is attached to the
   *  image (recorded in `metadata.annotations`), not wired into the graph — the
   *  generation step reads the boxes from the image node itself, so the canvas
   *  stays free of annotation edges. */
  const addAnnotationPrompt = useCallback((source: CanvasNode, rect: CanvasRect): void => {
    const current = documentRef.current
    if (current === null) return
    const existing = liveAnnotations(source, current.nodes)
    const draft: CanvasNode = {
      id: newId('node'), type: 'text', title: tt('canvas.annotationNode'),
      x: 0, y: 0, width: ANNOTATION_TEXT_SIZE.width, height: ANNOTATION_TEXT_SIZE.height,
      metadata: { text: '', fontSize: 13, annotation: { sourceNodeId: source.id, rect } },
    }
    const y = Math.round(source.y + existing.length * (ANNOTATION_TEXT_SIZE.height + 24))
    let x = source.x + source.width + NODE_GAP
    for (let guard = 0; guard < 24; guard += 1) {
      const clash = current.nodes.find(node => x < node.x + node.width + 24 && x + draft.width > node.x - 24
        && y < node.y + node.height + 24 && y + draft.height > node.y - 24)
      if (clash === undefined) break
      x = clash.x + clash.width + 40
    }
    const node: CanvasNode = { ...draft, x: Math.round(x), y }
    const annotation: CanvasAnnotation = { id: newId('ann'), ...rect, nodeId: node.id }
    mutate(previous => ({
      ...previous,
      nodes: [
        ...previous.nodes.map(item => item.id === source.id
          ? { ...item, metadata: { ...nodeMetadata(item), annotations: [...(nodeMetadata(item).annotations ?? []), annotation] } }
          : item),
        node,
      ],
    }))
    setSelectedIds(new Set([node.id]))
    setSelectedConnectionId(null)
    setFocusNodeId(node.id)
    setError(null)
  }, [mutate])

  const toggleAnnotate = useCallback((node: CanvasNode): void => {
    setAnnotateNodeId(previous => previous === node.id ? null : node.id)
    setAnnotationDraft(null)
    setColorPickerNodeId(null)
    setSelectedConnectionId(null)
  }, [])

  /** Pointer handlers of the annotation overlay (client coords -> image space). */
  const beginAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const asset = assetOf(node)
    const bounds = event.currentTarget.getBoundingClientRect()
    const box = containRect(bounds.width, bounds.height, asset?.width ?? 1, asset?.height ?? 1)
    annotationDragRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      start: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      box,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setAnnotationDraft({ nodeId: node.id, rect: { x: 0, y: 0, width: 0, height: 0 } })
  }, [])

  const moveAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = annotationDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    setAnnotationDraft({ nodeId: drag.nodeId, rect: rectBetween(drag.start, current, drag.box) })
  }, [])

  const endAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode): void => {
    const drag = annotationDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    annotationDragRef.current = null
    setAnnotationDraft(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const bounds = event.currentTarget.getBoundingClientRect()
    const rect = rectBetween(drag.start, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, drag.box)
    if (rect.width * rect.height < MIN_ANNOTATION_AREA) return
    addAnnotationPrompt(node, rect)
  }, [addAnnotationPrompt])

  /** 移除背景: local alpha matting, no upstream call and no API cost. */
  const removeNodeBackground = useCallback(async (node: CanvasNode): Promise<void> => {
    const asset = usableAsset(node)
    if (asset === undefined) return
    setError(null)
    await withNodeBusy(node.id, tt('canvas.removingBackground'), async () => {
      const raster = await loadRaster(asset.url)
      if (transparencyRatio(raster) > 0.05) {
        setNotice(tt('canvas.alreadyTransparent'))
        return
      }
      const result = autoRemoveBackground(raster)
      if (result.removedRatio < 0.015) throw new Error(tt('canvas.removeBgFailed'))
      const uploaded = await api.canvasUpload(canvasToDataUrl(result.canvas), result.canvas.width, result.canvas.height, { origin: 'upload', originId: `matte-${node.id}` })
      const size = sizeForAsset(uploaded)
      addConnectedNode(node.id, () => ({
        id: newId('node'), type: 'image', title: tt('canvas.noBackgroundNode'),
        x: 0, y: 0, width: size.width, height: size.height,
        metadata: { asset: uploaded, status: 'success', transparent: true, sourceNodeId: node.id, model: nodeMetadata(node).model },
      }))
      setNotice(tt('canvas.removeBgDone', { percent: Math.round(result.removedRatio * 100) }))
    })
  }, [addConnectedNode, api, withNodeBusy])

  /** 图层拆分: ask the host chat model for a layer plan, then materialize it as
   *  editable canvas nodes (text cards, matted object stickers, background). */
  const splitLayers = useCallback(async (node: CanvasNode): Promise<void> => {
    const asset = usableAsset(node)
    if (asset === undefined) return
    if (!promptReady) { setError(tt('canvas.skills.noChat')); onOpenSettings?.('enhancement'); return }
    setError(null)
    await withNodeBusy(node.id, tt('canvas.splittingLayers'), async () => {
      const dataUrl = await assetToDataUrl(asset)
      const plan = await api.canvasLayers(dataUrl)
      const layers: CanvasLayerPlanItem[] = plan.layers
      if (layers.length === 0) throw new Error(tt('canvas.layerSplitEmpty'))
      const sourceRaster = await loadRaster(asset.url)
      const created: CanvasNode[] = []
      const connections: CanvasConnection[] = []
      const connect = (id: string): void => { connections.push({ id: newId('edge'), fromNodeId: node.id, toNodeId: id }) }
      const layerInfo = (layer: CanvasLayerPlanItem): CanvasLayerInfo => ({ kind: layer.kind, label: layer.label, sourceNodeId: node.id })
      const sourceAspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1
      // Layers land in a tidy column beside the source: mirroring the original
      // geometry stacked every layer on top of its neighbours inside one small
      // footprint, which made them impossible to grab or delete one by one.
      const planned = layers.map(layer => {
        if (layer.kind === 'background') {
          return { layer, width: LAYER_COLUMN_WIDTH, height: Math.max(120, Math.round(LAYER_COLUMN_WIDTH / sourceAspect)) }
        }
        const rect = layer.rect
        if (rect === undefined) return { layer, width: 0, height: 0 }
        const boxAspect = sourceAspect * (rect.width / Math.max(rect.height, 0.001))
        if (layer.kind === 'text') {
          const width = Math.max(180, Math.min(LAYER_COLUMN_WIDTH, Math.round(LAYER_COLUMN_WIDTH * rect.width)))
          return { layer, width, height: Math.max(64, Math.round(Math.min(160, (width / Math.max(boxAspect, 0.05)) * 1.6))) }
        }
        const width = Math.max(96, Math.min(LAYER_COLUMN_WIDTH, Math.round(LAYER_COLUMN_WIDTH * Math.max(rect.width, 0.14))))
        return { layer, width, height: Math.max(72, Math.round(width / Math.max(boxAspect, 0.05))) }
      }).filter(item => item.width > 0)
      const columnHeight = planned.reduce((sum, item) => sum + item.height + LAYER_COLUMN_GAP, 0)
      const originX = freeColumnX(node, documentRef.current?.nodes ?? [], columnHeight, LAYER_COLUMN_WIDTH)
      let cursorY = node.y
      for (const item of planned) {
        const layer = item.layer
        const id = newId('node')
        if (layer.kind === 'background') {
          created.push({
            id, type: 'image', title: tt('canvas.layerBackground', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: { asset, status: 'success', layer: layerInfo(layer), model: nodeMetadata(node).model },
          })
          connect(id)
        } else if (layer.kind === 'text') {
          const fontSize = Math.max(10, Math.min(72, Math.round(item.height * 0.5)))
          created.push({
            id, type: 'text', title: tt('canvas.layerText', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: {
              text: layer.text ?? '', fontSize, layer: layerInfo(layer),
              ...layer.color === undefined ? {} : { color: layer.color },
            },
          })
          connect(id)
        } else {
          const crop = cropRaster(sourceRaster, layer.rect!)
          const matted = autoRemoveBackground(crop)
          const cut = matted.removedRatio >= 0.06 ? matted.canvas : crop
          const uploaded = await api.canvasUpload(canvasToDataUrl(cut), cut.width, cut.height, { origin: 'upload', originId: `layer-${node.id}` })
          created.push({
            id, type: 'image', title: tt('canvas.layerObject', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: { asset: uploaded, status: 'success', layer: layerInfo(layer), transparent: matted.removedRatio >= 0.06, model: nodeMetadata(node).model },
          })
          connect(id)
        }
        cursorY += item.height + LAYER_COLUMN_GAP
      }
      mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...created], connections: [...previous.connections, ...connections] }))
      setNotice(tt('canvas.layerSplitDone', { count: created.length }))
    })
  }, [api, mutate, onOpenSettings, promptReady, withNodeBusy])

  // ------------------------------------------------------------- video runs

  /**
   * Submit one video generation for the composer's target config node.
   *
   * The clip is produced by the host (async render) and referenced by URL, so
   * this only creates a *placeholder* video node carrying the task id; the
   * polling effect below fills it once the render settles.
   */
  const submitVideoComposer = useCallback(async (target: CanvasNode | null): Promise<void> => {
    const current = documentRef.current
    if (current === null || composerBusy) return
    // The code path needs no provider, so neither guard applies to it. Leaving
    // them in place would make the new path unusable on exactly the machines
    // it exists for: a canvas with no video model configured.
    const codeRenderer = composerRenderer === 'code'
    if (!codeRenderer && !composerChannelConnected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const groups = videoGroups ?? []
    if (!codeRenderer && groups.length === 0) { setError(tt('canvas.videoNoModel')); onOpenSettings?.(); return }
    const inputs = target === null ? [] : upstreamNodes(current, target.id)
    const usableImage = (node: CanvasNode): boolean => node.type === 'image' && usableAsset(node) !== undefined
    // 连线语义角色：首帧/尾帧由连线上的 role 决定，不再靠 connections 数组
    // 恰好排成什么样——删一条边再重连顺序就变了，画布上却看不出来。
    // 没标过角色的画布 orderedUpstream 保持原数组顺序，行为与今天逐条一致。
    const wiredImages = target === null
      ? []
      : orderedUpstream(current.connections, target.id)
        .map(connection => current.nodes.find(node => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNode => node !== undefined && usableImage(node))
    // 拖到节点旁边却没连过来的图：提交这一刻补上。看得见、删得掉、一步能撤销；
    // 拖拽过程中不猜，那是替用户做决定而用户没法拒绝。
    const nearbyImages = target === null
      ? []
      : autoLinkCandidates(current.nodes, current.connections, target, usableImage)
    const referenceImages = [...wiredImages, ...nearbyImages]
    const upstreamText = inputs
      .filter(node => node.type === 'text' && nodeMetadata(node).annotation === undefined && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerBusy(true)
    try {
      const basePrompt = composerPrompt.trim() !== '' ? composerPrompt.trim() : upstreamText.join('\n')
      if (basePrompt === '') { setError(tt('canvas.videoNeedPrompt')); return }
      // Resolve the video model against the video catalogs (not the image ones):
      // a video alias only exists in `videoModels`.
      const choice = codeRenderer
        ? { channelId: '', model: '' }
        : resolveModelChoice(groups, { channelId: composerVideoChannelId, model: composerVideoModel }, defaultChannelId)
      const model = choice.model
      if (!codeRenderer && model === '') { setError(tt('canvas.videoNeedModel')); return }
      // The mode comes from the graph unless the user overrode it: 'auto' maps
      // the connected references onto text / image / keyframe, which is the
      // natural canvas behavior (wire an image in and you get image-to-video).
      // Identity references widen that: a pinned character does not have to be
      // wired into every shot, so when nothing is wired but somebody is pinned,
      // the run becomes reference-mode instead of degrading to text-to-video.
      const castNodes = castRefsFor(current, referenceImages.map(node => node.id))
      // 一次最多四张参考图（引擎侧与图像链路一致）：连线的排前面，剩下的名额
      // 给身份参考。
      const referencePool = [...referenceImages, ...castNodes].slice(0, 4)
      const derived: VideoMode = referencePool.length === 0
        ? 'text'
        : referenceImages.length === 0
          ? 'reference'
          : referenceImages.length >= 2
            ? 'keyframe'
            : 'image'
      // A code render draws every frame itself, so the graph's references are
      // not frames for a provider: text mode is the honest request shape. The
      // connected prompt text still travels, above.
      const effective: VideoMode = codeRenderer ? 'text' : composerVideoMode === 'auto' ? derived : composerVideoMode
      // An explicit mode still has to be satisfiable by the graph.
      if (effective === 'image' && referenceImages.length === 0) { setError(tt('canvas.videoNeedReference')); return }
      if (effective === 'keyframe' && referenceImages.length === 0) { setError(tt('canvas.videoNeedKeyframes')); return }
      if (effective === 'text' && referenceImages.length > 0) {
        // Explicit text mode with references wired: that is a deliberate choice
        // (the frames are ignored), so no error.
      }
      // 身份参考只在真的被送进去时进提示词：说了“参考图 1 是她”却没附图，
      // 只会让模型凭空发挥。
      const usedCast = effective === 'reference' ? referencePool : referenceImages
      const castPrompt = effective === 'reference' ? castPromptOf(current, referencePool.map(node => node.id)) : ''
      const prompt = castPrompt === '' ? basePrompt : `${basePrompt}\n\n${castPrompt}`
      const frames: { image?: string; firstFrame?: string; lastFrame?: string; images?: string[]; refName?: string } = {}
      if (effective === 'keyframe') {
        const first = referenceImages[0] !== undefined ? usableAsset(referenceImages[0]!) : undefined
        const last = referenceImages[1] !== undefined ? usableAsset(referenceImages[1]!) : undefined
        if (first === undefined) { setError(tt('canvas.videoNeedKeyframes')); return }
        frames.firstFrame = await assetToDataUrl(first)
        if (last !== undefined) frames.lastFrame = await assetToDataUrl(last)
      } else if (effective === 'image') {
        const base = referenceImages[0] !== undefined ? usableAsset(referenceImages[0]!) : undefined
        if (base === undefined) { setError(tt('canvas.videoNeedReference')); return }
        frames.image = await assetToDataUrl(base)
        frames.refName = 'canvas-reference.png'
      } else if (effective === 'reference') {
        const first = referencePool[0] !== undefined ? usableAsset(referencePool[0]!) : undefined
        if (first === undefined) { setError(tt('canvas.videoNeedReference')); return }
        frames.image = await assetToDataUrl(first)
        frames.refName = 'canvas-reference.png'
        const extras: string[] = []
        for (const reference of referencePool.slice(1, 4)) {
          const asset = usableAsset(reference)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) frames.images = extras
      }
      const footprint = nodeSizeFromRatio(composerAspect === '9:16' ? '9:16' : composerAspect === '1:1' ? '1:1' : '16:9', IMAGE_NODE_SIZE)
      const placeholderId = newId('node')
      const request: VideoGenerateRequest = {
        mode: effective,
        model,
        prompt,
        aspectRatio: composerAspect,
        resolution: composerResolution,
        seconds: composerSeconds,
        ...(choice.channelId === '' ? {} : { channelId: choice.channelId }),
        ...codeRenderer ? { renderer: 'code' as const } : {},
        ...frames,
        canvas: {
          canvasId: current.id,
          ...(target === null ? {} : { sourceNodeId: target.id }),
          nodeId: placeholderId,
          ...(usedCast.length === 0 ? {} : { referenceNodeIds: usedCast.map(node => node.id) }),
        },
      }
      const task = await api.videoTaskSubmit(request)
      localVideoTaskIds.current.add(task.id)
      mutate(previous => {
        const nodes = [...previous.nodes]
        const connections = [...previous.connections]
        const anchor = target !== null ? previous.nodes.find(node => node.id === target.id) : undefined
        const originX = anchor !== undefined ? anchor.x + anchor.width + 80 : Math.round(canvasCenter().x - footprint.width / 2)
        const originY = anchor !== undefined ? anchor.y : Math.round(canvasCenter().y - footprint.height / 2)
        nodes.push({
          id: placeholderId, type: 'video', title: tt('canvas.videoNode'),
          x: Math.round(originX), y: Math.round(originY),
          width: footprint.width, height: footprint.height,
          metadata: {
            status: 'generating', taskId: task.id,
            prompt, model, videoMode: effective,
            aspectRatio: composerAspect, seconds: composerSeconds, resolution: composerResolution,
            ...codeRenderer ? { renderer: 'code' as const } : {},
            ...(choice.channelId === '' ? {} : { channelId: choice.channelId }),
            ...(referenceImages.length === 0 ? {} : { sourceNodeId: referenceImages[0]!.id }),
          },
        })
        if (anchor !== undefined) connections.push({ id: newId('edge'), fromNodeId: anchor.id, toNodeId: placeholderId })
        // 补边在这里做，与占位节点同一个 mutate：一次进历史，撤销一次就回到
        // 生成前的画布。keyframe 模式下按 first/last/reference 标角色，让画布
        // 上看得见哪张当了首帧、哪张当了尾帧；其余模式补的就是普通输入。
        // 角色只在没人占的时候才给：连线上已经有人标了 first，再给近邻图一个
        // first 就会出现两个首帧，生成时按文档顺序取谁都不对。
        const takenRoles = new Set(previous.connections.filter(connection => connection.toNodeId === placeholderId || connection.toNodeId === target?.id).map(connection => roleOf(connection)))
        const freeRoles = effective === 'keyframe'
          ? keyframeRoles(nearbyImages.length + takenRoles.size).filter(role => role !== undefined && !takenRoles.has(role))
          : []
        nearbyImages.forEach((node, index) => {
          const role = freeRoles[index]
          connections.push({ id: newId('edge'), fromNodeId: node.id, toNodeId: placeholderId, ...(role === undefined || role === 'input' ? {} : { role }) })
        })
        return { ...previous, nodes, connections }
      })
      setComposerPrompt('')
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setComposerBusy(false)
    }
  }, [api, canvasCenter, castPromptOf, castRefsFor, composerAspect, composerBusy, composerChannelConnected, composerPrompt, composerRenderer, composerResolution, composerSeconds, composerVideoChannelId, composerVideoMode, composerVideoModel, defaultChannelId, mutate, onOpenSettings, upstreamNodes, videoGroups])

  // ----------------------------------------------------------- generation

  const submitComposer = useCallback(async (target: CanvasNode | null): Promise<void> => {
    const current = documentRef.current
    if (current === null || composerBusy) return
    const codeRenderer = composerRenderer === 'code'
    if (!codeRenderer && !composerChannelConnected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const inputs = target === null ? [] : upstreamNodes(current, target.id)
    const referenceImages = inputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined)
    const upstreamText = inputs
      .filter(node => node.type === 'text' && nodeMetadata(node).annotation === undefined && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerBusy(true)
    try {
      // Attached 标注 cards supply both the boxed reference and, when the
      // composer box is empty, the prompt itself.
      const annotationPlan = await annotationPlanOf(current, inputs).catch(() => undefined)
      const prompt = composerPrompt.trim() !== ''
        ? composerPrompt.trim()
        : (upstreamText.length > 0 ? upstreamText.join('\n') : (annotationPlan?.texts ?? []).join('\n'))
      if (prompt === '') { setError(tt('canvas.needPrompt')); setComposerBusy(false); return }
      const composerChoice = codeRenderer
        ? { channelId: '', model: '' }
        : resolveModelChoice(modelGroups, { channelId: composerChannelId, model: composerModel }, defaultChannelId)
      const model = composerChoice.model
      if (!codeRenderer && model === '') { setError(tt('canvas.needModel')); setComposerBusy(false); return }
      // One chat answer draws one still, so the code path always produces one
      // node — a count above one would leave placeholders that never fill.
      const count = codeRenderer ? 1 : Math.min(4, Math.max(1, Math.round(composerCount)))
      // 身份参考：连线是这次输入，钉住的是整部片子的设定。两者合并成一张参考
      // 池，连线排前面（它仍然是编辑的底图），再按 cast.ts 的规则去重。
      const castNodes = castRefsFor(current, referenceImages.map(node => node.id))
      const castPrompt = castPromptOf(current, castNodes.map(node => node.id))
      const referencePool = [...referenceImages, ...castNodes]
      const baseAsset = referencePool[0] !== undefined ? usableAsset(referencePool[0]!) : undefined
      const finalPrompt = [annotationPlan === undefined ? prompt : `${prompt}\n\n${annotationPlan.prompt}`, castPrompt]
        .filter(part => part !== '')
        .join('\n\n')
      let image: string | undefined
      let images: string[] | undefined
      let refName: string | undefined
      // The code path has no provider to hand a reference image to: the model
      // writes a drawing program, it does not edit the wired picture. Sending
      // one would only make the request look like an edit it cannot perform.
      if (codeRenderer) {
        image = undefined
      } else if (annotationPlan !== undefined) {
        image = annotationPlan.image
        refName = 'canvas-annotated.png'
        // 标注底图已经占掉一张参考图；身份参考接在后面，最多凑满四张。
        const extras: string[] = []
        for (const node of castNodes) {
          const asset = usableAsset(node)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) images = extras.slice(0, 3)
      } else if (baseAsset !== undefined) {
        image = await assetToDataUrl(baseAsset)
        refName = 'canvas-reference.png'
        const extras: string[] = []
        for (const reference of referencePool.slice(1, 4)) {
          const asset = usableAsset(reference)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) images = extras
      }
      const footprint = nodeSizeFromRatio(composerSize, IMAGE_NODE_SIZE)
      const request: GenerateRequest = {
        mode: image === undefined ? 'text' : 'edit', model, prompt: finalPrompt, size: composerSize, quality: composerQuality, n: count, detail: '',
        ...(composerChoice.channelId === '' ? {} : { channelId: composerChoice.channelId }),
        ...codeRenderer ? { renderer: 'code' as const } : {},
        ...(image === undefined ? {} : { image, refName }),
        ...(images === undefined ? {} : { images }),
        canvas: {
          canvasId: current.id,
          ...(target === null ? {} : {
            sourceNodeId: annotationPlan?.sourceNodeId ?? referenceImages[0]?.id ?? target.id,
            parentNodeId: target.id,
            placement: 'right' as const,
          }),
        },
      }
      const task = await api.taskSubmit(request)
      localTaskIds.current.add(task.id)
      mutate(previous => {
        const nodes = [...previous.nodes]
        const connections = [...previous.connections]
        const anchor = target !== null ? previous.nodes.find(node => node.id === target.id) : undefined
        const originX = anchor !== undefined ? anchor.x + anchor.width + 80 : Math.round(canvasCenter().x - footprint.width / 2)
        const originY = anchor !== undefined ? anchor.y : Math.round(canvasCenter().y - footprint.height / 2)
        for (let index = 0; index < count; index += 1) {
          const id = newId('node')
          nodes.push({
            id, type: 'image', title: tt('canvas.imageNode'),
            x: Math.round(originX), y: Math.round(originY + index * (footprint.height + 48)),
            width: footprint.width, height: footprint.height,
            metadata: {
              status: 'generating', taskId: task.id,
              ...(anchor !== undefined ? { sourceNodeId: anchor.id } : {}),
              ...(annotationPlan === undefined ? {} : { annotationEdit: { sourceNodeId: annotationPlan.sourceNodeId, boxes: annotationPlan.boxes } }),
              prompt: finalPrompt, model,
              ...codeRenderer ? { renderer: 'code' as const } : {},
              ...(composerChoice.channelId === '' ? {} : { channelId: composerChoice.channelId }),
            },
          })
          if (anchor !== undefined) connections.push({ id: newId('edge'), fromNodeId: anchor.id, toNodeId: id })
        }
        return { ...previous, nodes, connections }
      })
      setComposerPrompt('')
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setComposerBusy(false)
    }
  }, [annotationPlanOf, api, canvasCenter, castPromptOf, castRefsFor, composerBusy, composerChannelConnected, composerChannelId, composerCount, composerModel, composerPrompt, composerQuality, composerRenderer, composerSize, defaultChannelId, modelGroups, mutate, onOpenSettings, upstreamNodes])

  // ---------------------------------------------------------- task intake

  /** Retry one failed video node by resubmitting its stored run parameters. */
  const retryVideoGeneration = useCallback(async (node: CanvasNode): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    const metadata = nodeMetadata(node)
    const prompt = (metadata.prompt ?? '').trim()
    if (prompt === '') { setError(tt('canvas.videoNeedPrompt')); return }
    // A node remembers how it was made, so a retry stays on that path instead
    // of quietly falling back to a provider the user may not even have.
    const codeRenderer = metadata.renderer === 'code'
    const groups = videoGroups ?? []
    const choice = codeRenderer
      ? { channelId: '', model: '' }
      : resolveModelChoice(groups, { channelId: metadata.channelId, model: metadata.model }, defaultChannelId)
    if (!codeRenderer && choice.model === '') { setError(tt('canvas.videoNeedModel')); return }
    if (!codeRenderer && !(choice.channelId === '' || channelIsConnected(choice.channelId))) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    // Re-send the references the node was built from, so a retry reproduces the
    // same run rather than silently degrading to text-only.
    const frame = metadata.sourceNodeId === undefined
      ? undefined
      : current.nodes.find(item => item.id === metadata.sourceNodeId)
    // 首尾帧重试：sourceNodeId 只记得住「当时的第一张」，标成 last 的那张重试时
    // 会丢，两条不同成片被当成同一次运行重放。所以按连线上的角色重新解析一遍
    // ——连线还在就照角色取，连线被删了才退回 sourceNodeId。
    const retryPair = (codeRenderer ? 'text' : metadata.videoMode ?? 'text') === 'keyframe'
      ? framePair(current.connections, id => current.nodes.find(item => item.id === id), node.id, item => item.type === 'image' && usableAsset(item) !== undefined)
      : {}
    try {
      const frames: { image?: string; firstFrame?: string; lastFrame?: string; refName?: string } = {}
      const mode: VideoMode = codeRenderer ? 'text' : metadata.videoMode ?? 'text'
      if (mode === 'keyframe') {
        const firstNode = retryPair.first ?? (frame?.type === 'image' ? frame : undefined)
        const lastNode = retryPair.last
        const firstAsset = firstNode === undefined ? undefined : usableAsset(firstNode)
        if (firstAsset !== undefined) frames.firstFrame = await assetToDataUrl(firstAsset)
        const lastAsset = lastNode === undefined ? undefined : usableAsset(lastNode)
        if (lastAsset !== undefined) frames.lastFrame = await assetToDataUrl(lastAsset)
      } else if (mode === 'image' && frame !== undefined && frame.type === 'image') {
        const asset = usableAsset(frame)
        if (asset !== undefined) { frames.image = await assetToDataUrl(asset); frames.refName = 'canvas-reference.png' }
      }
      const request: VideoGenerateRequest = {
        mode,
        model: choice.model,
        prompt,
        aspectRatio: metadata.aspectRatio ?? '16:9',
        resolution: (metadata.resolution ?? '720P') as VideoResolution,
        seconds: metadata.seconds ?? 5,
        ...(choice.channelId === '' ? {} : { channelId: choice.channelId }),
        ...codeRenderer ? { renderer: 'code' as const } : {},
        // Reuse the drawing source the first run produced: the same pixels, no
        // second chat call. Without one (the render itself failed) the host
        // asks the model again, which is the only way to get a new answer.
        ...codeRenderer && metadata.renderSource !== undefined ? { renderSource: metadata.renderSource } : {},
        ...frames,
        canvas: {
          canvasId: current.id,
          ...(metadata.sourceNodeId === undefined ? {} : { sourceNodeId: metadata.sourceNodeId }),
          nodeId: node.id,
        },
      }
      const task = await api.videoTaskSubmit(request)
      localVideoTaskIds.current.add(task.id)
      processedVideoTasks.current.delete(task.id)
      patchNode(node.id, { status: 'generating', error: undefined, taskId: task.id, model: choice.model, ...codeRenderer ? { renderer: 'code' as const } : {} })
      // A retry produces a NEW clip, so whatever made the old one unloadable no
      // longer applies. Clearing the marker here is what lets the node show the
      // fresh clip when the task lands — without it the node would sit on
      // "the clip is gone" until the user found the reload button.
      clearBrokenVideo(node.id)
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [api, channelIsConnected, clearBrokenVideo, defaultChannelId, onOpenSettings, patchNode, videoGroups])

  // ---------------------------------------------------------- storyboard

  /**
   * Decode one frame out of a served clip, in the browser.
   *
   * The canvas already grabs a clip's MIDDLE frame as a still; continuity needs
   * the LAST frame instead, and it has to be an image the video provider
   * accepts as a first frame — so this returns the same data URL shape the
   * image picker hands to the generator. Seeking to the exact end often lands
   * on a frame the decoder has not flushed, hence the small inset.
   * @param url - same-origin clip URL.
   * @param at - 'first' for the opening frame, 'last' for the closing one.
   */
  const frameFromClip = useCallback(async (url: string, at: 'first' | 'last'): Promise<string> => {
    const video = globalThis.document.createElement('video')
    video.src = url
    video.muted = true
    video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => { reject(new Error(tt('canvas.videoGrabFailed'))) }
      video.addEventListener('loadeddata', () => { resolve() }, { once: true })
      video.addEventListener('error', fail, { once: true })
      window.setTimeout(fail, 15_000)
    })
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
    const target = at === 'last' && duration > 0 ? Math.max(0, duration - 0.06) : 0
    if (target > 0) {
      await new Promise<void>((resolve) => {
        video.addEventListener('seeked', () => { resolve() }, { once: true })
        video.currentTime = target
      })
    }
    const width = video.videoWidth
    const height = video.videoHeight
    if (width === 0 || height === 0) throw new Error(tt('canvas.videoGrabFailed'))
    const bitmap = globalThis.document.createElement('canvas')
    bitmap.width = width
    bitmap.height = height
    const context = bitmap.getContext('2d')
    if (context === null) throw new Error(tt('canvas.videoGrabFailed'))
    context.drawImage(video, 0, 0, width, height)
    return bitmap.toDataURL('image/png')
  }, [])

  /**
   * Continue from a clip: take its LAST frame as a new image node wired into a
   * fresh video config, so the user can type the next shot's direction and
   * generate a take that starts exactly where this one ended.
   *
   * This is the manual half of storyboard continuity, and it is deliberately
   * built from the pieces the canvas already has — a frame grab, an image node,
   * a config node and one edge — rather than a second generation path. The
   * generated clip therefore behaves like any other: same queue, same
   * placeholder, same retry.
   */
  const continueFromClip = useCallback(async (node: CanvasNode): Promise<void> => {
    const clip = videoOf(node)
    if (clip === undefined || clip.url === '') return
    await withNodeBusy(node.id, tt('canvas.storyboard.grabLastFrame'), async () => {
      try {
        const dataUrl = await frameFromClip(clip.url, 'last')
        const dimensions = await readImageSize(dataUrl)
        const uploaded = await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'generated', originId: node.id })
        const frameFootprint = nodeSizeFromRatio(`${dimensions.width}:${dimensions.height}`, IMAGE_NODE_SIZE)
        const config = createConfigNode()
        mutate(previous => {
          const frameId = newId('node')
          const frame: CanvasNode = {
            id: frameId, type: 'image', title: tt('canvas.storyboard.lastFrameNode'),
            x: Math.round(node.x + node.width + 80), y: Math.round(node.y),
            width: frameFootprint.width, height: frameFootprint.height,
            metadata: { asset: uploaded, status: 'success', sourceNodeId: node.id },
          }
          // The config node sits to the right of the frame, ready to type into:
          // the frame is wired in as its reference, so the next generate run is
          // already an image-to-video on this exact last frame.
          const placed: CanvasNode = {
            ...config,
            x: Math.round(frame.x + frame.width + 80),
            y: Math.round(node.y + (node.height - config.height) / 2),
            metadata: { status: 'idle', videoMode: 'image' },
          }
          return {
            ...previous,
            nodes: [...previous.nodes, frame, placed],
            connections: [
              ...previous.connections,
              { id: newId('edge'), fromNodeId: node.id, toNodeId: frameId },
              { id: newId('edge'), fromNodeId: frameId, toNodeId: placed.id },
            ],
          }
        })
        setSelectedIds(new Set())
        setComposerKind('video')
        setComposerPrompt('')
        setNotice(tt('canvas.storyboard.grabLastFrameDone'))
      } catch (caught) {
        setError(tt('canvas.storyboard.grabLastFrameFailed', { message: errorMessage(caught) }))
      }
    })
  }, [api, createConfigNode, frameFromClip, mutate, withNodeBusy])

  /**
   * Where one shot's clip node goes: a column to the RIGHT of the board, one
   * row per shot, so the produced clips read top-to-bottom in shot order —
   * which is also the stitch order. A shot that already has a node keeps it,
   * and the column simply grows past it.
   */
  const shotPlacement = useCallback((board: CanvasNode, index: number): { x: number; y: number } => {
    const size = nodeSizeFromRatio('16:9', IMAGE_NODE_SIZE)
    return {
      x: Math.round(board.x + board.width + 96),
      y: Math.round(board.y + index * (size.height + 48)),
    }
  }, [])

  /**
   * Submit one shot of a storyboard.
   *
   * Everything after the submit reuses the ordinary video pipeline: the task is
   * tracked by `localVideoTaskIds`, the shared poller fills the placeholder
   * node on completion, and the clip is a plain video node from then on —
   * previewable, favoritable, downloadable and stitchable with no extra code.
   *
   * In `carry` continuity the shot is submitted as a first/last-keyframe run
   * whose first frame is the previous shot's LAST frame. That frame comes from
   * the previous clip, so the previous shot must already have one; the caller
   * picks the next shot with that in mind.
   * @returns true when a task was submitted.
   */
  const submitShot = useCallback(async (board: CanvasNode, index: number): Promise<boolean> => {
    const current = documentRef.current
    if (current === null) return false
    const state = storyboardOf(board)
    const shot = state.shots[index]
    if (shot === undefined) return false
    const problem = shotProblem(shot)
    if (problem !== undefined) { setError(tt(problem)); return false }
    const groups = videoGroups ?? []
    const choice = resolveModelChoice(groups, { channelId: state.channelId, model: state.model }, defaultChannelId)
    if (choice.model === '') { setError(tt('canvas.videoNoModel')); onOpenSettings?.(); return false }
    if (!(choice.channelId === '' || channelIsConnected(choice.channelId))) { setError(tt('canvas.needApi')); onOpenSettings?.(); return false }

    let frames: { image?: string; firstFrame?: string; lastFrame?: string; refName?: string } = {}
    let mode: VideoMode = 'text'
    if (state.continuity === 'carry' && index > 0) {
      const previous = state.shots[index - 1]
      const previousNode = previous === undefined ? undefined : shotNodeOf(previous, current.nodes)
      const previousClip = previousNode?.metadata?.video
      // A carry shot whose predecessor has no clip cannot be framed. Say so
      // instead of submitting a text-only run that would break the join the
      // user asked for.
      if (previousClip === undefined || previousClip.url === '') {
        setError(tt('canvas.storyboard.carryNeedsPrevious'))
        return false
      }
      try {
        frames = { firstFrame: await frameFromClip(previousClip.url, 'last'), refName: 'storyboard-carry.png' }
        mode = 'keyframe'
      } catch (caught) {
        setError(errorMessage(caught))
        return false
      }
    }

    const existing = shotNodeOf(shot, current.nodes)
    // Reusing the existing node (a retry) keeps the canvas from collecting a
    // second clip for the same shot; a fresh shot gets a placeholder placed in
    // the shot column.
    const nodeId = existing?.id ?? newId('node')
    const size = nodeSizeFromRatio(state.aspectRatio, IMAGE_NODE_SIZE)
    const origin = existing ?? { ...shotPlacement(board, index), ...size }
    try {
      const request: VideoGenerateRequest = {
        mode,
        model: choice.model,
        prompt: shot.prompt.trim(),
        aspectRatio: state.aspectRatio,
        resolution: state.resolution as VideoResolution,
        seconds: shot.seconds,
        ...(choice.channelId === '' ? {} : { channelId: choice.channelId }),
        ...frames,
        canvas: {
          canvasId: current.id,
          sourceNodeId: board.id,
          nodeId,
        },
      }
      const task = await api.videoTaskSubmit(request)
      localVideoTaskIds.current.add(task.id)
      processedVideoTasks.current.delete(task.id)
      mutate(previous => {
        const nodes = [...previous.nodes]
        const connections = [...previous.connections]
        const placeholder: CanvasNode = {
          id: nodeId, type: 'video',
          title: tt('canvas.storyboard.shotNode', { index: index + 1 }),
          x: Math.round(origin.x), y: Math.round(origin.y), width: size.width, height: size.height,
          metadata: {
            status: 'generating', taskId: task.id,
            prompt: shot.prompt.trim(), model: choice.model, videoMode: mode,
            aspectRatio: state.aspectRatio, seconds: shot.seconds, resolution: state.resolution,
            ...(choice.channelId === '' ? {} : { channelId: choice.channelId }),
            sourceNodeId: board.id,
            shot: { storyboardId: board.id, shotId: shot.id, index: index + 1 },
          },
        }
        const at = nodes.findIndex(node => node.id === nodeId)
        if (at >= 0) nodes[at] = placeholder
        else nodes.push(placeholder)
        if (!connections.some(edge => edge.fromNodeId === board.id && edge.toNodeId === nodeId)) {
          connections.push({ id: newId('edge'), fromNodeId: board.id, toNodeId: nodeId })
        }
        // Record the shot -> node link on the board itself, so the row can show
        // its own clip's state without scanning the whole canvas.
        const boardIndex = nodes.findIndex(node => node.id === board.id)
        if (boardIndex >= 0) {
          const boardNode = nodes[boardIndex]!
          const previousBoard = storyboardOf(boardNode)
          // 重跑这一镜自己先解锁（旧片仍然是旧片，但它已经不再是「作废」状态），
          // 随后由它在 carry 模式下作废下游：新的尾帧一旦落地，接在旧尾帧上的
          // 那些成片就都不成立了。作废放在这里——真正提交成功之后——是因为
          // 提交失败或被拒时尾帧不会变，此时作废下游等于白白毁掉用户的工作。
          const restarted = withShot(previousBoard, index, { nodeId, stale: undefined })
          const nextBoard = previousBoard.continuity === 'carry'
            ? withStaleDownstream(restarted, index, nodes)
            : restarted
          nodes[boardIndex] = {
            ...boardNode,
            metadata: {
              ...nodeMetadata(boardNode),
              storyboard: nextBoard,
              status: 'success',
            },
          }
        }
        return { ...previous, nodes, connections }
      })
      clearBrokenVideo(nodeId)
      setError(null)
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    }
  }, [api, channelIsConnected, clearBrokenVideo, defaultChannelId, frameFromClip, mutate, onOpenSettings, shotPlacement, videoGroups])

  /**
   * Run the board's next shot, or — in `cut` continuity — every shot that has
   * no clip yet, in one press.
   *
   * The two modes differ for a real reason: a `carry` shot cannot be submitted
   * before its predecessor's last frame exists, so it is one at a time by
   * construction. A `cut` board has no such dependency, and making the user
   * press a button per shot would be a worse workflow than the one they had.
   */
  const runStoryboard = useCallback(async (node: CanvasNode): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    const state = storyboardOf(node)
    if (state.shots.length === 0) { setError(tt('canvas.storyboard.empty')); return }
    const pending = state.shots
      .map((shot, index) => ({ shot, index }))
      .filter((entry) => {
        if (entry.shot.prompt.trim() === '') return false
        const shotStateNow = shotState(entry.shot, current.nodes)
        return shotStateNow === 'empty' || shotStateNow === 'failed'
      })
    if (pending.length === 0) {
      const progress = storyboardProgress(state, current.nodes)
      if (progress.generating > 0) setNotice(tt('canvas.storyboard.alreadyRunning'))
      else setError(tt('canvas.storyboard.allDone'))
      return
    }
    const targets = state.continuity === 'carry'
      ? [pending[0]!.index]
      : pending.map(entry => entry.index)
    let submitted = 0
    for (const index of targets) {
      if (!(await submitShot(node, index))) break
      submitted += 1
    }
    if (submitted > 0) setNotice(tt('canvas.storyboard.started', { count: submitted }))
  }, [submitShot])

  /**
   * Hand a board's finished clips to the SAME stitch the rest of the canvas
   * uses: the confirm card, the ①②③ order review, the ffmpeg run and the
   * produced node all come from the existing compose path, so a storyboard
   * film is stitched exactly like a hand-picked one.
   *
   * Only ready clips are handed over. A shot still rendering has no bytes, and
   * the compose run fails loudly on an unreadable clip — so a partial stitch
   * says how many shots it is leaving out instead of submitting a list that
   * would fail.
   */
  const startStoryboardStitch = useCallback((ids: string[]): void => {
    const current = documentRef.current
    if (current === null) return
    if (ids.length < 2) { setError(tt('canvas.storyboard.stitchTooFew')); return }
    const skill = skillCatalog?.skills.find(item => item.id === COMPOSE_SKILL_ID)
    if (skill === undefined) {
      setError(skillCatalog === null ? tt('canvas.skills.loading') : (skillCatalog.reason ?? tt('canvas.skills.unknown')))
      return
    }
    const boards = current.nodes.filter(node => node.type === 'storyboard')
    const missing = boards.flatMap(node => storyboardOf(node).shots).filter(shot => {
      if (shot.prompt.trim() === '') return false
      const state = shotState(shot, current.nodes)
      return state !== 'ready'
    }).length
    setSkillMenu(null)
    setPendingSkill({ skill, nodeIds: ids, instruction: '' })
    if (missing > 0) setNotice(tt('canvas.storyboard.stitchPartial', { count: missing }))
  }, [skillCatalog])

  const retryGeneration = useCallback(async (node: CanvasNode): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    if (node.type === 'video') { await retryVideoGeneration(node); return }
    const metadata = nodeMetadata(node)
    const prompt = (metadata.prompt ?? '').trim()
    if (prompt === '') { setError(tt('canvas.needPrompt')); return }
    // Same rule as the clip retry: the node remembers its renderer, and a code
    // node must not start demanding a provider its user never had.
    const codeRenderer = metadata.renderer === 'code'
    const retryChoice = codeRenderer
      ? { channelId: '', model: '' }
      : resolveModelChoice(modelGroups, { channelId: metadata.channelId, model: metadata.model }, defaultChannelId)
    const model = retryChoice.model
    if (!codeRenderer && model === '') { setError(tt('canvas.needModel')); return }
    if (!codeRenderer && !channelIsConnected(retryChoice.channelId)) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const sourceId = metadata.sourceNodeId
    const sourceNode = sourceId === undefined ? undefined : current.nodes.find(item => item.id === sourceId)
    const directAsset = sourceNode !== undefined && sourceNode.type === 'image' ? usableAsset(sourceNode) : undefined
    const references = sourceId === undefined ? [] : upstreamNodes(current, sourceId).filter(item => item.type === 'image' && usableAsset(item) !== undefined)
    const baseAsset = directAsset ?? (references[0] !== undefined ? usableAsset(references[0]!) : undefined)
    try {
      let image: string | undefined
      let images: string[] | undefined
      let refName: string | undefined
      // A 标注 edit rebuilds its marked reference so the retry stays boxed.
      const boxes = sourceNode === undefined || sourceNode.type !== 'image' ? [] : liveAnnotations(sourceNode, current.nodes).flatMap(annotation => {
        const textNode = current.nodes.find(item => item.id === annotation.nodeId)
        const text = (textNode === undefined ? '' : nodeMetadata(textNode).text ?? '').trim()
        return text === '' ? [] : [{ rect: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }, text }]
      })
      const annotated = sourceNode !== undefined && baseAsset !== undefined && boxes.length > 0
        ? await annotatedReference(sourceNode, boxes).catch(() => undefined)
        : undefined
      if (codeRenderer) {
        // A drawing program does not edit the wired picture; see submitComposer.
        image = undefined
      } else if (annotated !== undefined) {
        image = annotated.image
        refName = 'canvas-annotated.png'
      } else if (baseAsset !== undefined) {
        image = await assetToDataUrl(baseAsset)
        refName = 'canvas-reference.png'
        const extras: string[] = []
        for (const reference of references.slice(1, 4)) {
          const asset = usableAsset(reference)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) images = extras
      }
      const request: GenerateRequest = {
        mode: image === undefined ? 'text' : 'edit', model, prompt, size: metadata.size ?? 'auto', quality: metadata.quality ?? 'auto', n: 1, detail: '',
        ...(retryChoice.channelId === '' ? {} : { channelId: retryChoice.channelId }),
        ...codeRenderer ? { renderer: 'code' as const } : {},
        // Re-render the stored drawing source when there is one; without it
        // (e.g. the chat call itself failed) the host asks the model again.
        ...codeRenderer && metadata.renderSource !== undefined ? { renderSource: metadata.renderSource } : {},
        ...(image === undefined ? {} : { image, refName }),
        ...(images === undefined ? {} : { images }),
        canvas: { canvasId: current.id, sourceNodeId: sourceId ?? references[0]?.id, parentNodeId: node.id, placement: 'right' as const },
      }
      const task = await api.taskSubmit(request)
      localTaskIds.current.add(task.id)
      patchNode(node.id, {
        status: 'generating', error: undefined, taskId: task.id,
        ...codeRenderer ? { renderer: 'code' as const } : {},
        // Remember the boxes so the finished image can be composited back onto
        // the clean original (the marker must not survive into the result).
        ...(annotated !== undefined && sourceNode !== undefined && !codeRenderer
          ? { annotationEdit: { sourceNodeId: sourceNode.id, boxes: boxes.map(box => box.rect) } }
          : {}),
      })
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [annotatedReference, api, channelIsConnected, defaultChannelId, modelGroups, onOpenSettings, patchNode, retryVideoGeneration, upstreamNodes])

  // --------------------------------------------------------------- workflow

  /**
   * 判断一个节点是不是「已经有可用产物」。
   *
   * 产物按节点类型各有一处存放点（图像的 asset、视频的 video），所以这里
   * 按类型分别看，而不是只看 `status`：一个 `success` 的配置节点没有任何
   * 产物，不该被当成跑过。
   */
  const hasProduce = useCallback((node: CanvasNode): boolean => {
    const metadata = nodeMetadata(node)
    if (node.type === 'image') return metadata.status === 'success' && usableAsset(node) !== undefined
    if (node.type === 'video') {
      const video = metadata.video
      return metadata.status === 'success' && video !== undefined && video.url !== ''
    }
    return false
  }, [])

  /**
   * 等一个节点从 `generating` 走到 `success` / `error`。
   *
   * 轮询而不是事件：回填发生在几个不同的 effect 里（图像、视频各一条），
   * 统一等一个终态比在每条链路上挂回调更不容易漏。
   *
   * @param settleMs - 最多等多久；到点仍停在 `generating` 视为失败，避免一次
   *   丢了的任务让整条链路永远挂着。
   */
  const waitForNodeSettled = useCallback(async (
    nodeId: string,
    signal: AbortSignal,
    settleMs = 30 * 60 * 1000,
  ): Promise<'success' | 'error' | 'gone' | 'cancelled'> => {
    const deadline = Date.now() + settleMs
    for (;;) {
      if (signal.aborted) return 'cancelled'
      const node = documentRef.current?.nodes.find(item => item.id === nodeId)
      if (node === undefined) return 'gone'
      const status = nodeMetadata(node).status
      if (status === 'success') return 'success'
      if (status === 'error') return 'error'
      if (status !== 'generating') return 'gone'
      if (Date.now() > deadline) return 'error'
      await new Promise<void>(resolve => { window.setTimeout(resolve, 700) })
    }
  }, [])

  /**
   * 等一次提交真正落地。
   *
   * `retryGeneration` 内部的 `patchNode` 只是排进 React 的更新队列，而
   * `documentRef` 要等渲染才刷新——调用后立刻读状态会读到提交前的旧值，把
   * 一次成功的提交误判成失败。所以这里轮询等状态离开原值，而不是同步读。
   *
   * @returns `generating` 表示已提交；`error` 表示提交失败或节点已经出错。
   */
  const waitForSubmission = useCallback(async (nodeId: string, signal: AbortSignal): Promise<'generating' | 'error' | 'gone' | 'cancelled'> => {
    // 提交是本地的一次请求往返：正常几百毫秒就有结论。给 8 秒已经宽裕，
    // 再长只会让一次注定失败的提交把整条链路挂住。
    const deadline = Date.now() + 8_000
    for (;;) {
      if (signal.aborted) return 'cancelled'
      const node = documentRef.current?.nodes.find(item => item.id === nodeId)
      if (node === undefined) return 'gone'
      const status = nodeMetadata(node).status
      if (status === 'generating') return 'generating'
      // 提交后立刻成功（例如走了本地缓存）也算落地了。
      if (status === 'success') return 'generating'
      if (status === 'error') return 'error'
      if (Date.now() > deadline) return 'error'
      await new Promise<void>(resolve => { window.setTimeout(resolve, 120) })
    }
  }, [])

  /**
   * 跑一个节点并等到它出结果。
   *
   * 生成复用既有链路：`retryGeneration` 从节点 metadata 里的 prompt/model
   * 重新提交，图像和视频各自走自己的队列。执行器只加「等」和「判断」。
   * 已经有产物的节点直接复用，这就是冻结/缓存语义：跑过一次的链路不会再
   * 花一次钱。
   */
  const runWorkflowNode = useCallback(async (
    nodeId: string,
    options: { signal: AbortSignal; reuse: boolean },
  ): Promise<'done' | 'cached' | 'skipped' | 'failed'> => {
    const node = documentRef.current?.nodes.find(item => item.id === nodeId)
    if (node === undefined) return 'skipped'
    if (options.reuse && hasProduce(node)) return 'cached'
    // 没有提示词的配置/文本节点不产生调用：它们是输入，跑完原样留在原处。
    if (node.type !== 'image' && node.type !== 'video') return 'skipped'
    const prompt = (nodeMetadata(node).prompt ?? '').trim()
    if (prompt === '') return 'skipped'
    if (options.signal.aborted) return 'failed'
    // 这个节点已经在跑了：接管它，而不是再提交一次。重跑一次等于再付一次钱，
    // 而且两个任务会抢着回填同一个节点。
    if (nodeMetadata(node).status === 'generating') {
      const settledNow = await waitForNodeSettled(nodeId, options.signal)
      return settledNow === 'success' ? 'done' : 'failed'
    }
    await retryGeneration(node)
    // 提交是否落地要看状态真的变了，不能同步读：`patchNode` 只是排进 React
    // 的更新队列，`documentRef` 还没刷新。
    const submitted = await waitForSubmission(nodeId, options.signal)
    if (submitted !== 'generating') return 'failed'
    const settled = await waitForNodeSettled(nodeId, options.signal)
    return settled === 'success' ? 'done' : 'failed'
  }, [hasProduce, retryGeneration, waitForNodeSettled, waitForSubmission])

  /**
   * 从选中的起点往下游跑完整张图。
   *
   * 起点是选区：没选东西时以「失败/未跑过」的节点为起点，等于「把这板上
   * 该跑的补完」。只往下游走，因为上游是输入，不是这次要重做的东西。
   */
  const runWorkflowFrom = useCallback(async (roots: string[]): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    if (workflowBusyRef.current) return
    if (current.nodes.length === 0) { setError(tt('canvas.workflow.empty')); return }
    const starts = roots.length > 0
      ? roots
      : current.nodes.filter(node => {
          if (node.type !== 'image' && node.type !== 'video') return false
          if (!hasProduce(node)) return true
          return nodeMetadata(node).status === 'error'
        }).map(node => node.id)
    if (starts.length === 0) { setError(tt('canvas.workflow.allDone')); return }
    const controller = new AbortController()
    workflowAbort.current = controller
    workflowBusyRef.current = true
    setWorkflowBusy(true)
    setWorkflowProgress({ layer: 0, total: 0, running: [], done: 0, count: 0 })
    try {
      const result = await runWorkflow({
        roots: starts,
        nodeIds: current.nodes.map(node => node.id),
        edges: current.connections,
        signal: controller.signal,
        onProgress: progress => setWorkflowProgress(progress),
        // 两处 `reuse` 是两回事，关掉复用必须同时作用：这一层的数组决定
        // 执行器是否跳过节点，`runWorkflowNode` 里的布尔决定单节点是否在
        // `hasProduce` 时短路成 cached。只关一处等于关一半——节点仍会被
        // 上游那层拦下来，用户看到「已关闭复用」却什么都没重跑。
        ...workflowReuse ? { reuse: current.nodes.filter(node => hasProduce(node)).map(node => node.id) } : {},
        // 闭包由执行器自己算（`downstreamClosure`），这里只交出起点：
        // 在 UI 侧再算一遍，两处的成员集迟早会不一致。
        ...workflowRerunSelected && selectedIds.size > 0 ? { rerun: [...selectedIds] } : {},
        ...workflowParallel ? {} : { maxParallel: 1 },
        run: async nodeId => {
          const outcome = await runWorkflowNode(nodeId, { signal: controller.signal, reuse: workflowReuse })
          return outcome === 'cached' ? 'cached' : outcome
        },
      })
      if (result.status === 'cycle') {
        setError(tt('canvas.workflow.cycle', { count: result.cycle.length }))
        return
      }
      if (result.status === 'cancelled') { setNotice(tt('canvas.workflow.cancelled')); return }
      if (result.status === 'failed') {
        const failed = current.nodes.find(node => node.id === result.failedNodeId)
        setError(tt('canvas.workflow.failed', {
          node: failed?.title ?? (result.failedNodeId ?? ''),
          message: result.error ?? '',
        }))
        return
      }
      // `partial`: another branch failed while this one finished. Reporting it
      // as plain success would swallow the failure; reporting it as `failed`
      // would claim nothing ran. Say both halves.
      if (result.status === 'partial') {
        const failed = current.nodes.find(node => node.id === result.failedNodeId)
        setError(tt('canvas.workflow.partial', {
          node: failed?.title ?? (result.failedNodeId ?? ''),
          blocked: result.blocked.length,
          done: result.done,
        }))
        return
      }
      setNotice(tt('canvas.workflow.done', { count: result.done }))
      setError(null)
    } finally {
      workflowAbort.current = null
      workflowBusyRef.current = false
      setWorkflowBusy(false)
      setWorkflowProgress(null)
    }
  }, [hasProduce, runWorkflowNode, selectedIds, workflowParallel, workflowRerunSelected, workflowReuse])

  const cancelWorkflow = useCallback((): void => {
    workflowAbort.current?.abort()
  }, [])

  /** 打开时间线：把选中的视频按画布位置排好，作为初值。 */
  const openTimeline = useCallback((): void => {
    const current = documentRef.current
    if (current === null) return
    const clips = current.nodes.filter(node => node.type === 'video'
      && (nodeMetadata(node).video?.url ?? '') !== ''
      && (selectedIds.size === 0 || selectedIds.has(node.id)))
    // 少于两段时按画布顺序自动取全部已成片的视频：拼接本来就至少两段，
    // 逼用户先框选一次才能用这个功能没有必要。
    const pool = clips.length >= 2 ? clips : current.nodes.filter(node => node.type === 'video' && (nodeMetadata(node).video?.url ?? '') !== '')
    if (pool.length < 2) { setError(tt('canvas.storyboard.stitchTooFew')); return }
    setTimelineNodeIds(orderIdsByPosition(pool))
    setTimelineOpen(true)
  }, [selectedIds])

  const timelineClips = useMemo<TimelineClipView[]>(() => {
    const current = documentRef.current
    if (current === null || !timelineOpen) return []
    const byId = new Map(current.nodes.map(node => [node.id, node]))
    return timelineNodeIds.flatMap(nodeId => {
      const node = byId.get(nodeId)
      const video = node === undefined ? undefined : nodeMetadata(node).video
      // 节点在这期间被删了或成片没了：跳过，而不是渲染一条点不开的空白。
      if (node === undefined || video === undefined || video.url === '') return []
      return [{
        nodeId: node.id,
        title: node.title,
        seconds: video.duration ?? 0,
        src: video.url,
      }]
    })
  }, [document?.revision, timelineOpen, timelineNodeIds])

  /** 时间线提交：转成 params.timeline，走既有拼接链路。 */
  const submitTimeline = useCallback((timeline: Timeline): void => {
    const skill = skillCatalog?.skills.find(item => item.id === COMPOSE_SKILL_ID)
    if (skill === undefined) {
      setError(skillCatalog === null ? tt('canvas.skills.loading') : (skillCatalog.reason ?? tt('canvas.skills.unknown')))
      return
    }
    setTimelineBusy(true)
    void startSkillRun(skill, timeline.segments.map(segment => segment.nodeId), undefined, {
      timeline: JSON.stringify({
        segments: timeline.segments.map(segment => ({
          nodeId: segment.nodeId,
          inPoint: segment.inPoint,
          ...segment.outPoint === undefined ? {} : { outPoint: segment.outPoint },
        })),
        transitions: timeline.transitions,
        keepAudio: timeline.keepAudio,
      }),
    }).finally(() => {
      setTimelineBusy(false)
      setTimelineOpen(false)
    })
  }, [skillCatalog, startSkillRun])

  // Orphan reconciliation: a generating placeholder whose task no longer exists
  // in the host feed (e.g. the host restarted) can never complete on its own.
  useEffect(() => {
    if (document === null) return
    const feedFresh = tasks.length > 0 || Date.now() - mountedAtRef.current > 8000
    if (!feedFresh) return
    const feedIds = new Set(tasks.map(task => task.id))
    // Video placeholders are reconciled against the video feed, not the image
    // one: they are separate queues, so the image feed never contains them.
    const videoFeedFresh = (videoTasks?.length ?? 0) > 0 || Date.now() - mountedAtRef.current > 8000
    const videoFeedIds = new Set((videoTasks ?? []).map(task => task.id))
    const orphans = document.nodes.filter(node => {
      if (nodeMetadata(node).status !== 'generating') return false
      const taskId = nodeMetadata(node).taskId
      if (taskId === undefined) return false
      if (node.type === 'video') return videoFeedFresh && !videoFeedIds.has(taskId) && !localVideoTaskIds.current.has(taskId)
      if (node.type !== 'image') return false
      return !feedIds.has(taskId) && !localTaskIds.current.has(taskId)
    })
    if (orphans.length === 0) return
    updateNodes(nodes => nodes.map(node => {
      if (nodeMetadata(node).status !== 'generating') return node
      const taskId = nodeMetadata(node).taskId
      if (taskId === undefined) return node
      if (node.type === 'video') {
        if (!videoFeedFresh || videoFeedIds.has(taskId) || localVideoTaskIds.current.has(taskId)) return node
        return { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: tt('canvas.videoTaskLost') } }
      }
      if (node.type !== 'image' || feedIds.has(taskId) || localTaskIds.current.has(taskId)) return node
      return { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: tt('canvas.taskLost') } }
    }))
  }, [document, tasks, videoTasks, updateNodes])

  // Fill placeholder video nodes from the video queue.
  //
  // A clip is referenced, never copied: the host persisted it and the node just
  // records the served URL, so there is no upload step here (the one thing that
  // would make this expensive).
  useEffect(() => {
    if (document === null || videoTasks === undefined) return
    const mine = videoTasks.filter(task => (task.request.canvas as { canvasId?: string } | undefined)?.canvasId === document.id)
    if (mine.length === 0) return
    for (const task of mine) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') continue
      if (processedVideoTasks.current.has(task.id)) continue
      const targets = document.nodes.filter(node =>
        node.type === 'video' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating')
      if (targets.length === 0) continue
      processedVideoTasks.current.add(task.id)
      if (task.status === 'cancelled') {
        updateNodes(nodes => nodes.map(node => node.type === 'video' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating'
          ? { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: tt('canvas.videoRetry') } }
          : node))
        continue
      }
      const clip = task.resultVideo
      if (task.status !== 'completed' || clip === undefined || clip.url === '') {
        const message = task.error ?? tt('canvas.generateFailed')
        updateNodes(nodes => nodes.map(node => node.type === 'video' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating'
          ? { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: message } }
          : node))
        continue
      }
      updateNodes(nodes => nodes.map(node => node.type === 'video' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating'
        ? {
            ...node,
            metadata: {
              ...nodeMetadata(node),
              status: 'success' as const,
              error: undefined,
              // Remember what drew it, so a later retry can re-render the same
              // pixels without paying for another chat answer.
              ...task.renderSource === undefined ? {} : { renderSource: task.renderSource },
              video: {
                url: clip.url,
                mime: clip.mime,
                ...clip.duration === undefined ? {} : { duration: clip.duration },
                ...task.resultEntryId === undefined ? {} : { entryId: task.resultEntryId },
              },
            },
          }
        : node))
    }
  }, [document, videoTasks, updateNodes])

  useEffect(() => {
    if (document === null) return
    const canvasTasks = tasks.filter(task => task.request.canvas?.canvasId === document.id)
    for (const task of canvasTasks) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') continue
      if (processedTasks.current.has(task.id)) continue
      const targets = document.nodes.filter(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating')
      if (targets.length === 0) continue
      processedTasks.current.add(task.id)
      const sourceId = nodeMetadata(targets[0]!).sourceNodeId
      const fail = (message: string): void => {
        updateNodes(nodes => nodes.map(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating'
          ? { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: message } }
          : node))
      }
      if (task.status !== 'completed' || task.result === undefined || task.result.images.length === 0) {
        fail(task.error ?? tt('canvas.generateFailed'))
        continue
      }
      void (async () => {
        const assets: CanvasAssetRef[] = []
        const annotationEdit = nodeMetadata(targets[0]!).annotationEdit
        const originalAsset = annotationEdit === undefined
          ? undefined
          : usableAsset(document.nodes.find(node => node.id === annotationEdit.sourceNodeId) ?? targets[0]!)
        for (const image of task.result!.images) {
          let dataUrl = imageDataUrl(image)
          // A 标注 edit: keep the generated pixels only inside the boxes and
          // restore the clean original everywhere else, so the red marker the
          // model may have echoed never reaches the finished image.
          if (annotationEdit !== undefined && originalAsset !== undefined) {
            try {
              const result = await loadRaster(dataUrl, 4096)
              const original = await loadRaster(originalAsset.url, 4096)
              const inset = Math.max(2, Math.round(Math.min(result.width, result.height) * 0.01))
              dataUrl = canvasToDataUrl(compositeAnnotatedResult(result, original, annotationEdit.boxes, inset))
            } catch { /* keep the raw result if the composite cannot be built */ }
          }
          const dimensions = await readImageSize(dataUrl)
          assets.push(await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'generated', originId: task.id }))
        }
        updateDocument(previous => {
          const ordered = previous.nodes.filter(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating')
          if (ordered.length === 0) return previous
          const last = ordered[ordered.length - 1]!
          const nodes = previous.nodes.map(node => {
            const index = ordered.indexOf(node)
            if (index < 0) return node
            const asset = assets[index]
            return asset === undefined
              ? { ...node, metadata: { ...nodeMetadata(node), status: 'error' as const, error: tt('canvas.generateFailed') } }
              : { ...node, metadata: { ...nodeMetadata(node), asset, status: 'success' as const, error: undefined,
                  ...task.result?.renderSource === undefined ? {} : { renderSource: task.result.renderSource } } }
          })
          // More results than placeholders: append sibling nodes below the last one.
          const siblings: CanvasNode[] = []
          const connections: CanvasConnection[] = []
          assets.slice(ordered.length).forEach((asset, offset) => {
            const id = newId('node')
            siblings.push({
              id, type: 'image', title: tt('canvas.imageNode'),
              x: Math.round(last.x), y: Math.round(last.y + (ordered.length + offset) * (last.height + 48)),
              width: last.width, height: last.height,
              metadata: { status: 'success', asset, taskId: task.id, ...(sourceId === undefined ? {} : { sourceNodeId: sourceId }) },
            })
            if (sourceId !== undefined) connections.push({ id: newId('edge'), fromNodeId: sourceId, toNodeId: id })
          })
          return { ...previous, nodes: [...nodes, ...siblings], connections: [...previous.connections, ...connections] }
        })
      })().catch(caught => fail(caught instanceof Error ? caught.message : String(caught)))
    }
  }, [api, document, tasks, updateDocument, updateNodes])

  // ------------------------------------------------------- import intake

  const addAssets = useCallback((assets: CanvasAssetRef[], position?: Point): void => {
    if (assets.length === 0) return
    const center = position ?? canvasCenter()
    mutate(previous => {
      const nodes = assets.map((asset, index) => {
        const node = createImageNode(asset)
        return { ...node, x: node.x + (index % 3) * (IMAGE_NODE_SIZE.width + 40), y: node.y + Math.floor(index / 3) * (IMAGE_NODE_SIZE.height + 40) }
      })
      return { ...previous, nodes: [...previous.nodes, ...nodes] }
    })
    setSelectedIds(new Set())
  }, [canvasCenter, createImageNode, mutate])

  /**
   * Lands a reference clip on the canvas: a video node pointing at the served
   * URL, with no bytes copied, so adding the same clip twice stays cheap.
   * Shared by the sidebar hand-off effect and the in-canvas video picker, so
   * the two entry points cannot drift apart.
   */
  const addClipNode = useCallback((clip: { url: string; mime: string; duration?: number; title?: string }): void => {
    const footprint = nodeSizeFromRatio('16:9', IMAGE_NODE_SIZE)
    const center = canvasCenter()
    const id = newId('node')
    mutate(previous => ({
      ...previous,
      nodes: [...previous.nodes, {
        id, type: 'video', title: clip.title !== undefined && clip.title !== '' ? clip.title : tt('canvas.videoNode'),
        x: Math.round(center.x - footprint.width / 2), y: Math.round(center.y - footprint.height / 2),
        width: footprint.width, height: footprint.height,
        metadata: {
          status: 'success',
          video: {
            url: clip.url,
            mime: clip.mime,
            ...clip.duration === undefined ? {} : { duration: clip.duration },
          },
        },
      }],
    }))
    setNotice(tt('canvas.videoAdded'))
  }, [canvasCenter, mutate])

  useEffect(() => {
    if (importRequest === undefined) {
      processedImport.current = ''
      return
    }
    if (document === null) return
    if (importRequest.source === 'video') {
      const key = `video:${importRequest.url}`
      if (processedImport.current === key) return
      processedImport.current = key
      // Reference the clip: build a video node pointing at the served URL. No
      // bytes are copied, so adding the same clip twice is cheap.
      addClipNode({
        url: importRequest.url,
        mime: importRequest.mime,
        ...importRequest.duration === undefined ? {} : { duration: importRequest.duration },
        ...importRequest.title === undefined || importRequest.title === '' ? {} : { title: importRequest.title },
      })
      onImportRequestHandled?.()
      return
    }
    const requestKey = `${importRequest.source}:${importRequest.entryId}:${importRequest.imageIndex}`
    if (processedImport.current === requestKey) return
    const sourceEntries = importRequest.source === 'history' ? history : gallery
    const entry = sourceEntries.find(item => item.id === importRequest.entryId)
    const image = entry?.images[importRequest.imageIndex]
    if (entry === undefined || image === undefined) {
      processedImport.current = requestKey
      onImportRequestHandled?.()
      return
    }
    processedImport.current = requestKey
    void (async () => {
      const dimensions = await readImageSize(image.url)
      const asset = await api.canvasImport(importRequest.source, importRequest.entryId, importRequest.imageIndex, dimensions.width, dimensions.height)
      addAssets([asset])
      onImportRequestHandled?.()
    })().catch(caught => {
      setError(caught instanceof Error ? caught.message : String(caught))
      onImportRequestHandled?.()
    })
  }, [addAssets, addClipNode, api, document, gallery, history, importRequest, onImportRequestHandled])

  // -------------------------------------------------------------- loading

  useEffect(() => {
    let disposed = false
    void api.canvasList().then(async list => {
      if (disposed) return
      const created = list[0] === undefined ? await api.canvasCreate(tt('canvas.untitled')) : null
      const first = created === null ? await api.canvasRead(list[0]!.id) : seedDocument(created)
      if (disposed) return
      setProjects(created === null ? list : [summaryOf(first)])
      setDocument(normalizeConfigNodeSizes(first))
      syncedRef.current = JSON.stringify(created ?? first)
      setSaveState('saved')
    }).catch(caught => { if (!disposed) { setError(caught instanceof Error ? caught.message : String(caught)); setSaveState('error') } })
    return () => { disposed = true }
  }, [api, seedDocument])

  /**
   * Persist one canvas snapshot and reconcile the answer with the screen.
   *
   * WHY the sequence number: the 650 ms debounce lets a second write start
   * before the first answers, and the user can leave the canvas inside that
   * window. A late answer for a superseded write — or for a canvas the user has
   * already left — must never reach `setDocument`: it used to put the previous
   * canvas back on screen while the project selector still showed the new one,
   * and that document's stale `revision` then rode along on the next save.
   */
  const writeCanvas = useCallback(async (snapshot: CanvasDocument): Promise<boolean> => {
    const seq = saveSeqRef.current + 1
    saveSeqRef.current = seq
    const key = JSON.stringify(snapshot)
    const saveWithRetry = async (): Promise<CanvasDocument> => {
      try {
        return await api.canvasSave(snapshot, snapshot.revision)
      } catch (caught) {
        // Another window saved the same canvas meanwhile: rebase on the server
        // revision and retry once so concurrent editing self-heals. The
        // conflict is recognised by the host's stable wire code, never by
        // matching the message: that copy is translated and may be reworded.
        if (!(caught instanceof ImageGenApiError) || caught.code !== 'canvas-conflict') throw caught
        const server = await api.canvasRead(snapshot.id)
        return await api.canvasSave(snapshot, server.revision)
      }
    }
    try {
      const next = await saveWithRetry()
      // A newer write has been issued since this one: its own answer carries the
      // truth, so this one stays off the screen and out of `syncedRef`.
      if (seq !== saveSeqRef.current) return true
      const live = documentRef.current
      if (live === null || live.id !== next.id) return true
      syncedRef.current = JSON.stringify(next)
      // A newer edit is waiting (the live document is no longer the snapshot we
      // wrote): keep the user's work on screen and let the debounce write it
      // next, instead of overwriting it with the server's older copy.
      if (key === JSON.stringify(live)) {
        setDocument(next)
        setProjects(previous => {
          const favorite = previous.find(item => item.id === next.id)?.favorite === true
          return [summaryOf(next, favorite), ...previous.filter(item => item.id !== next.id)]
        })
      }
      setSaveState('saved')
      // A successful write clears the backoff so the next edit saves promptly.
      setFailedSaveRetryDue(false)
      return true
    } catch (caught) {
      if (seq === saveSeqRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
        // WHY the action and not just the message: `syncedRef` only advances on
        // a SUCCESSFUL write, so while an edit stays unsynced the autosave
        // effect below re-ran on every `saveState` change and re-armed its
        // 650 ms timer -- an offline host meant one failing request 1.5 times a
        // second, forever, with the toast re-set on each round (which is also
        // why dismissing it looked broken: the next tick put it straight back).
        // Failing stops the loop; the user decides when to try again.
        setErrorAction({
          label: tt('canvas.saveRetry'),
          forError: caught instanceof Error ? caught.message : String(caught),
          run: () => {
            const live = documentRef.current
            if (live !== null) void writeCanvas(live)
          },
        })
        // Arm the quiet retry: dismissing the toast must not mean "never saved".
        setFailedSaveRetryDue(false)
        window.setTimeout(() => { setFailedSaveRetryDue(true) }, SAVE_RETRY_BACKOFF_MS)
        setSaveState('error')
      }
      return false
    }
  }, [api])

  /**
   * Write the pending debounced edit before the canvas is replaced.
   *
   * WHY: switching projects, creating a canvas or deleting the current one
   * swaps `document` immediately, and the autosave effect's cleanup cancels the
   * 650 ms timer — so an edit made just before the click was never sent. The
   * write goes through the same conflict read-back path as the debounce.
   */
  const flushPendingCanvas = useCallback(async (): Promise<void> => {
    const live = documentRef.current
    if (live === null || JSON.stringify(live) === syncedRef.current) return
    flushRef.current = true
    try { await writeCanvas(live) } finally { flushRef.current = false }
  }, [writeCanvas])

  // 接受提案前要用到它（见 `acceptProposal`）。在这里接上：这一行运行的
  // 时候 `flushPendingCanvas` 已经有值，而 ref 的读取总是发生在那之后。
  flushPendingRef.current = flushPendingCanvas

  useEffect(() => {
    if (document === null || saveState === 'loading') return
    // A failed write leaves the document unsynced, so the plain 650 ms debounce
    // must not re-arm: that was a request every 650 ms for as long as the host
    // stayed unreachable. Retry on a slow backoff instead of stopping outright
    // -- stopping lost the edit for good as soon as the user dismissed the
    // toast, since its × only clears the message.
    if (saveState === 'error' && !failedSaveRetryDue) return
    // A flush owns the write right now; it reconciles `syncedRef` itself and
    // this effect re-runs when it sets the save state, so nothing is lost.
    if (flushRef.current) return
    const key = JSON.stringify(document)
    if (key === syncedRef.current) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      // Read the live document when the debounce fires: it may have outlived a
      // canvas switch, a delete or further edits, and the newest snapshot is
      // the one that must be written.
      const live = documentRef.current
      if (live === null || JSON.stringify(live) === syncedRef.current) return
      void writeCanvas(live)
    }, saveState === 'error' ? SAVE_RETRY_BACKOFF_MS : 650)
    return () => window.clearTimeout(timer)
  }, [api, document, saveState, writeCanvas, failedSaveRetryDue])

  // ------------------------------------------------------- compose (stitch)

  /**
   * The clips a stitch run would cover, in canvas order — the single list the
   * badges, the multi-select bar, the confirm card and `request.nodeIds` all
   * read. Derived from the document rather than from a click handler so it can
   * never disagree with what the canvas is currently showing.
   */
  const composeIds = useMemo(
    () => document === null ? [] : composeClipIds(document.nodes, selectedIds),
    [document, selectedIds],
  )

  /**
   * The descriptor behind the multi-select bar's stitch button — the same
   * skill the node menu offers, found by id so the bar and the menu cannot
   * disagree about what a stitch is.
   */
  const composeSkill = useMemo(
    () => skillCatalog?.skills.find(skill => skill.id === COMPOSE_SKILL_ID) ?? null,
    [skillCatalog],
  )

  /** Why the bar's stitch button cannot run — said out loud, never silently inert. */
  const composeUnavailableReason = skillCatalog === null
    ? tt('canvas.skills.loading')
    : skillCatalog.reason ?? tt('canvas.skills.unknown')

  useEffect(() => {
    // The catalog is otherwise fetched only when a skill menu opens, which
    // would leave this button without a descriptor to run on a fresh canvas.
    // Load it as soon as a stitch has actually become possible -- not on mount,
    // because a canvas that never selects two clips should not pay for it.
    if (composeIds.length < 2 || skillCatalog !== null) return
    void loadSkillCatalog()
  }, [composeIds.length, loadSkillCatalog, skillCatalog])

  /**
   * Bar click: opens the SAME confirm card the node menu opens, and never
   * starts the run itself. That card is the user's only chance to check the
   * ①②③ order before ffmpeg commits to it.
   */
  const startComposeFromBar = useCallback((): void => {
    if (composeSkill === null) return
    if (composeIds.length < 2) {
      setError(tt('canvas.skills.composeTooFew'))
      return
    }
    setSkillMenu(null)
    setPendingSkill({ skill: composeSkill, nodeIds: composeIds, instruction: '' })
  }, [composeIds, composeSkill])

  // ---------------------------------------------------------- composer sync

  const singleSelectedId = selectedIds.size === 1 ? [...selectedIds][0]! : null
  const singleSelected = useMemo(() => document?.nodes.find(node => node.id === singleSelectedId) ?? null, [document, singleSelectedId])
  // The composer follows the selected config node — including when other nodes
  // are selected alongside it, so using an image node's tools no longer makes
  // the generation bar vanish.
  const composerTarget = useMemo(() => {
    const selected = (document?.nodes ?? []).filter(node => selectedIds.has(node.id))
    const configs = selected.filter(node => node.type === 'config')
    return configs.length === 1 ? configs[0]! : null
  }, [document, selectedIds])
  const composerInputs = useMemo(
    () => composerTarget === null || document === null ? [] : upstreamNodes(document, composerTarget.id),
    [composerTarget, document, upstreamNodes],
  )
  const composerReferenceCount = composerInputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined).length
  // 就在旁边、提交时会被自动连进来的图。先让人看见「还会带上这几张」，
  // 而不是生成完才发现多用了图——预告和实际用的是同一个函数算出来的。
  const composerAutoLinkCount = useMemo(() => {
    if (composerTarget === null || document === null) return 0
    return autoLinkCandidates(document.nodes, document.connections, composerTarget, node => node.type === 'image' && usableAsset(node) !== undefined).length
  }, [composerTarget, document])
  const composerTextCount = composerInputs.filter(node => node.type === 'text' && (nodeMetadata(node).text ?? '').trim() !== '').length
  // Prompt cards hanging off the upstream images count as prompt input too, so
  // the send button is live once a box carries a prompt (no graph edge needed).
  const composerAnnotationTexts = useMemo(() => composerTarget === null || document === null
    ? []
    : composerInputs
      .filter(node => node.type === 'image')
      .flatMap(image => attachedCards(image, document.nodes))
      .map(card => (nodeMetadata(card).text ?? '').trim())
      .filter(text => text !== ''), [composerInputs, composerTarget, document])
  const composerVisible = composerTarget !== null

  // Prefill the prompt from connected text nodes whenever the target changes.
  useEffect(() => {
    const targetId = composerTarget?.id ?? null
    if (targetId === composerTargetRef.current) return
    composerTargetRef.current = targetId
    if (composerTarget === null) return
    const upstream = (document?.connections ?? [])
      .filter(connection => connection.toNodeId === composerTarget.id)
      .map(connection => document?.nodes.find(node => node.id === connection.fromNodeId))
      .filter((node): node is CanvasNode => node !== undefined)
    const texts = upstream
      .filter(node => node.type === 'text' && nodeMetadata(node).annotation === undefined && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerPrompt(texts.join('\n'))
    // Adopt the model chosen on a connected image node, so the node-level model
    // selector drives the generation it feeds.
    const upstreamChoice = upstream
      .filter(node => node.type === 'image')
      .map(node => resolveModelChoice(modelGroups, { channelId: nodeMetadata(node).channelId, model: nodeMetadata(node).model }, defaultChannelId))
      .find(choice => modelGroups.some(group => group.id === choice.channelId && group.models.includes(choice.model)))
    if (upstreamChoice !== undefined) {
      setComposerChannelId(upstreamChoice.channelId)
      setComposerModel(upstreamChoice.model)
    }
  }, [composerTarget, document, defaultChannelId, modelGroups])

  // Transient success notices (background removal / layer split).
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  // The 标注 tool hands the keyboard to the prompt card it just created.
  useEffect(() => {
    if (focusNodeId === null) return
    const element = rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-node-id="${focusNodeId}"] textarea`)
    element?.focus()
    setFocusNodeId(null)
  }, [focusNodeId])

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    // Duck-typed (no `instanceof Element`): the same code must run inside the
    // jsdom smoke sandbox, which has no DOM constructors on its global.
    const matchesSelector = (target: EventTarget | null, selector: string): boolean => {
      const element = target as { matches?: unknown } | null
      if (element === null || typeof element !== 'object' || typeof element.matches !== 'function') return false
      return (element.matches as (value: string) => boolean)(selector)
    }
    const isEditingTarget = (target: EventTarget | null): boolean => matchesSelector(target, 'input, textarea, select, [data-dsh-select], [data-dsh-select-menu], [data-model-picker-menu], [contenteditable="true"]')
    /**
     * True when the focused element activates on Space by itself.
     *
     * `isEditingTarget` answers "is the user typing text", which is a different
     * question: a native <button> is not an editing target, yet Space is its
     * standard activation key. Treating it as a canvas gesture meant the
     * preventDefault below ate that keypress, so every button in the panel —
     * the dock, the node toolbars, the zoom controls — lost half of its
     * keyboard activation while the canvas was on screen.
     */
    const isActivatableTarget = (target: EventTarget | null): boolean => matchesSelector(target, 'button, [role="button"], [role="menuitem"], [role="radio"], [role="option"], a[href], summary, label')

    const onKeyDown = (event: KeyboardEvent): void => {
      // The poster editor is a modal over the canvas: Ctrl+Z there must undo a
      // poster layer, not a canvas node (and Delete must not remove a node while
      // the caret sits in the poster's text field).
      if (posterOpenRef.current) return
      // The panel container is hidden by a stylesheet rule rather than being
      // unmounted, so this listener stays live while the user is in the chat
      // beside it. Claiming Ctrl+A / Ctrl+Z / Delete there would eat the
      // browser's own shortcuts in a surface the canvas is not even showing.
      if (!activeRef.current) return
      if (event.key === 'Control') setCtrlPressed(true)
      if (event.code === 'Space' && !isEditingTarget(event.target) && !isActivatableTarget(event.target)) {
        event.preventDefault()
        setSpacePressed(true)
      }
      if (documentRef.current === null) return
      const mod = event.ctrlKey || event.metaKey
      if (event.key === 'Escape') {
        setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null); setZoomMenuOpen(false)
        setColorPickerNodeId(null)
        // 工作流选项菜单和那几个底栏菜单是同一类浮层，Esc 必须一视同仁地清掉。
        // 漏掉它的话，它就成了画布上唯一「Esc 关不掉」的东西，用户只能点
        // 「运行工作流」把它带走——而那一次运行是要花钱的。
        closeDockMenus()
        // The legend is the topmost surface whenever it is open, so Esc closes it
        // before anything behind it (the selection it would otherwise clear is
        // what the user expects to survive).
        if (shortcutHelpOpen) { setShortcutHelpOpen(false); return }
        // Esc leaves the 标注 tool first, then clears the selection.
        if (annotateNodeId !== null) { setAnnotateNodeId(null); setAnnotationDraft(null); return }
        // The in-canvas overlays come next, topmost first. They are rendered by
        // this component rather than portalled, so they cannot register their
        // own listener the way CanvasVideoPicker / CanvasFilePreview do --
        // without these branches Esc fell through to the selection reset below,
        // which read as "Esc did something invisible and left what I wanted
        // closed still open".
        if (videoPreviewNodeId !== null) { setVideoPreviewNodeId(null); return }
        // 时间线面板在最上层，Esc 先收它，别顺手把选区清掉。
        if (timelineOpen) { setTimelineOpen(false); return }
        // 身份面板同理：它是浮在画布上的设定，收起时不该动画布状态。
        if (castTarget !== null) { setCastTarget(null); return }
        if (pendingSkill !== null) { setPendingSkill(null); return }
        if (skillMenu !== null) { setSkillMenu(null); return }
        if (polishNode !== null) { setPolishNode(null); return }
        if (skillLibraryOpen) { setSkillLibraryOpen(false); return }
        if (pickerOpen) { setPickerOpen(false); return }
        if (!isEditingTarget(event.target)) { setSelectedIds(new Set()); setSelectedConnectionId(null) }
        return
      }
      if (isEditingTarget(event.target)) {
        // An empty text card has nothing to erase, so Delete/Backspace means
        // "remove this node" there — otherwise the key looks broken while the
        // caret sits in a freshly created (empty) card.
        const target = event.target as { tagName?: unknown; value?: unknown; closest?: unknown } | null
        const editing = target !== null && typeof target === 'object' && target.tagName === 'TEXTAREA' ? target : null
        const host = editing === null || typeof editing.closest !== 'function'
          ? null
          : (editing.closest as (selector: string) => { getAttribute(name: string): string | null } | null)('[data-node-id]')
        const hostId = host === null ? null : host.getAttribute('data-node-id')
        if (editing !== null && editing.value === '' && hostId !== null && selectedIdsRef.current.has(hostId)
          && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault()
          deleteNode(hostId)
        }
        return
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo(); else undo()
      } else if (event.key === '?' || (event.key === 'F1')) {
        // `?` is Shift+/ on most layouts, so the key itself is already the
        // right test. Neither Shift+/ nor F1 is a canvas gesture, so this
        // claims a key nothing else wanted.
        event.preventDefault()
        setShortcutHelpOpen(open => !open)
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault(); redo()
      } else if (mod && event.key.toLowerCase() === 'c') {
        copySelection()
      } else if (mod && event.key.toLowerCase() === 'v') {
        pasteClipboard()
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault(); duplicateSelection()
      } else if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        const nodes = documentRef.current?.nodes ?? []
        setSelectedIds(new Set(nodes.map(node => node.id)))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); deleteSelection()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpacePressed(false)
      if (event.key === 'Control') setCtrlPressed(false)
    }
    const onBlur = (): void => { setSpacePressed(false); setCtrlPressed(false) }
    const onPaste = (event: ClipboardEvent): void => {
      if (posterOpenRef.current) return
      // Same rule as the keyboard handler: a hidden canvas must not consume a
      // paste aimed at the chat.
      if (!activeRef.current) return
      if (isEditingTarget(event.target)) return
      const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
      if (files.length > 0) {
        event.preventDefault()
        void Promise.all(files.map(async file => {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('image.readFailed'))); reader.readAsDataURL(file) })
          const dimensions = await readImageSize(dataUrl)
          return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
        })).then(assets => addAssets(assets, canvasCenter())).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
        return
      }
      pasteClipboard()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('paste', onPaste)
    }
  }, [addAssets, annotateNodeId, api, canvasCenter, closeDockMenus, copySelection, deleteNode, deleteSelection, duplicateSelection, pasteClipboard, pickerOpen, polishNode, redo, shortcutHelpOpen, skillLibraryOpen, skillMenu, undo, videoPreviewNodeId, pendingSkill, timelineOpen, castTarget])

  // ------------------------------------------------------ viewport events

  useEffect(() => {
    const container = viewportRef.current
    if (container === null) return
    const measure = (): void => setViewportSize({ width: container.clientWidth, height: container.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    const preventWheel = (event: WheelEvent): void => {
      // The scroll-lock is only honest while the canvas is on screen; a hidden
      // container that still swallows wheel events blocks the page underneath.
      if (!activeRef.current) return
      if (closestOf(event.target, '[data-canvas-no-zoom]') !== null) return
      event.preventDefault()
    }
    container.addEventListener('wheel', preventWheel, { passive: false })
    return () => { observer.disconnect(); container.removeEventListener('wheel', preventWheel) }
  }, [])

  /**
   * How much of the canvas's bottom edge the chrome actually covers.
   *
   * Not the chrome's own height: the minimap is 220px wide at the left and does
   * not cover the middle, so reserving its full 150px would waste most of the
   * canvas on a wide panel. What a centred node can collide with is the job
   * dock, so the number is `viewport bottom - dock top`. It is measured rather
   * than assumed because the row wraps to a second line on a narrow panel.
   */
  useEffect(() => {
    const viewport = viewportRef.current
    // `.dock`, not `.dockOuter`: the outer box has a height the spring engine
    // animates, and the wrapped dock can be taller than it. The dock is what
    // the user sees, so it is what the canvas reserves.
    const dock = dockRef.current
    if (viewport === null || dock === null) return
    const measure = (): void => {
      const viewportBox = viewport.getBoundingClientRect()
      const dockBox = dock.getBoundingClientRect()
      setChromeHeight(Math.max(0, Math.round(viewportBox.bottom - dockBox.top)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(dock)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const bar = topBarRef.current
    if (bar === null) return
    // 内容是按钮与标题，换行只改变高度——按行量，不按行数猜。
    const measure = (): void => { setTopBarHeight(Math.round(bar.getBoundingClientRect().height)) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => { observer.disconnect() }
  }, [])

  const temporaryPanTool = spacePressed || ctrlPressed

  /**
   * Pointers currently down on the viewport, in insertion order.
   *
   * A touch device never sends a wheel event, so pinch is the only way to zoom
   * there. The map is the pinch's whole state: two entries means a pinch is in
   * progress, and the centroid/distance between them drive the transform.
   */
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<PinchState | null>(null)

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null
    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null); setZoomMenuOpen(false)
    if (closestOf(target, '[data-canvas-no-zoom]') === null) closeDockMenus()
    // 捏合缩放保留自定义引擎（jsdom 合成触摸可驱动；react-flow 的 d3-zoom
    // 触摸捏合在 jsdom 里不生效），故 ReactFlow 设 zoomOnPinch=false 避免双重缩放。
    if (event.pointerType === 'touch') {
      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (activePointersRef.current.size === 2) {
        panRef.current = null
        marqueeRef.current = null
        setMarquee(null)
        event.preventDefault()
        pinchRef.current = pinchStateFrom(activePointersRef.current, documentRef.current?.viewport ?? { x: 0, y: 0, k: 1 })
        return
      }
      if (activePointersRef.current.size > 2) return
    }
    // pan/zoom（滚轮/拖拽）由 react-flow 的 d3-zoom 接管；这里只保留选择工具下的框选。
    // no-zoom 面（空态快捷卡等可点控件）不算空白：否则框选会 preventDefault +
    // 抓取指针，把控件的 click 抢走（真机实测卡片点不动）。
    const isBackground = closestOf(target, '[data-node-id],[data-connection-hit],[data-canvas-no-zoom]') === null
    // 临时平移（空格 / Control）期间这块地属于 d3-zoom，框选必须让路。
    // 它对 pointerdown 的 preventDefault 会掐掉浏览器随后派发的兼容 mousedown，
    // 而 d3-zoom 正是靠 mousedown 起拖动（真 Chromium 实测：有 preventDefault
    // 时祖先收不到 mousedown）；setPointerCapture 还会把指针从 d3 手里夺走。
    // 节点拖动与框选走自定义指针引擎，所以这条竞争只打断平移——正是
    // 「节点能拖、框选能用，画布拖不动」的形状。
    if (event.button === 0 && isBackground && tool === 'select' && !temporaryPanTool && event.pointerType !== 'touch') {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const world = screenToWorld(event.clientX, event.clientY)
      const next: MarqueeState = { start: world, current: world, additive: event.shiftKey, initialIds: event.shiftKey ? [...selectedIdsRef.current] : [] }
      marqueeRef.current = next
      setMarquee(next)
      if (!event.shiftKey) { setSelectedIds(new Set()); setSelectedConnectionId(null) }
    }
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const current = documentRef.current
    if (current === null) return
    if (closestOf(event.target, '[data-canvas-no-zoom]') !== null) return
    event.preventDefault()
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const mouseX = event.clientX - bounds.left
    const mouseY = event.clientY - bounds.top
    const scale = clampScale(current.viewport.k * Math.pow(1.1, -event.deltaY / 100))
    const worldX = (mouseX - current.viewport.x) / current.viewport.k
    const worldY = (mouseY - current.viewport.y) / current.viewport.k
    setViewport({ x: mouseX - worldX * scale, y: mouseY - worldY * scale, k: scale })
  }

  const setZoomAtCenter = useCallback((scale: number): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    const next = clampScale(scale)
    const centerX = bounds.width / 2
    const centerY = bounds.height / 2
    const worldX = (centerX - current.viewport.x) / current.viewport.k
    const worldY = (centerY - current.viewport.y) / current.viewport.k
    setViewport({ x: centerX - worldX * next, y: centerY - worldY * next, k: next })
  }, [setViewport])

  const fitView = useCallback((): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    if (current.nodes.length === 0) {
      setViewport({ x: 0, y: 0, k: 1 })
      return
    }
    const content = nodesBounds(current.nodes)
    const padding = 80
    // The bottom chrome (minimap + zoom dock + job dock) floats OVER the canvas,
    // so padding alone lets a fitted node land underneath it. Reserve its real
    // height instead of a guess: it is one row on a wide panel and two on the
    // three-column studio, which is exactly where "fitted" still looked cramped.
    const bottomInset = chromeHeight + 22
    const contentWidth = Math.max(1, content.maxX - content.minX)
    const contentHeight = Math.max(1, content.maxY - content.minY)
    const scale = clampScale(Math.min(
      (bounds.width - padding * 2) / contentWidth,
      Math.max(1, bounds.height - padding - bottomInset) / contentHeight,
    ))
    setViewport({
      k: scale,
      x: (bounds.width - contentWidth * scale) / 2 - content.minX * scale,
      y: (bounds.height - bottomInset - contentHeight * scale) / 2 - content.minY * scale,
    })
  }, [setViewport, chromeHeight])

  // -------------------------------------------------- global move / up

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const pinch = pinchRef.current
      if (pinch !== null && activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        const [first, second] = [...activePointersRef.current.values()]
        if (first !== undefined && second !== undefined) {
          const bounds = viewportRef.current?.getBoundingClientRect()
          const left = bounds?.left ?? 0
          const top = bounds?.top ?? 0
          const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
          const nextScale = clampScale(pinch.base.k * (distance / pinch.startDistance))
          const worldX = (pinch.startCenter.x - left - pinch.base.x) / pinch.base.k
          const worldY = (pinch.startCenter.y - top - pinch.base.y) / pinch.base.k
          setViewport({
            x: (first.x + second.x) / 2 - left - worldX * nextScale,
            y: (first.y + second.y) / 2 - top - worldY * nextScale,
            k: nextScale,
          })
        }
        return
      }
      const drag = dragRef.current
      if (drag !== null) {
        const scale = documentRef.current?.viewport.k ?? 1
        const dx = (event.clientX - drag.startX) / scale
        const dy = (event.clientY - drag.startY) / scale
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
          drag.moved = true
          commitSnapshot(drag.snapshot)
          // 告诉渲染层「这次拖动在动这些节点」：重叠提示完全由它 + 文档位置派生，
          // 拖动每帧只更新位置，提示自然跟着变，不用另一份会过期的快照。
          dragMovingIdsRef.current = new Set(drag.origins.keys())
        }
        if (drag.moved) {
          // 8 screen pixels regardless of zoom: at 25% a world-space threshold
          // would drag the node across a quarter of the canvas before snapping.
          // The base position is the drag ORIGIN: `primary` has already been
          // moved by the previous frame, so adding dx to it double-counts.
          const primary = documentRef.current?.nodes.find(node => node.id === drag.primaryId)
          const origin = drag.origins.get(drag.primaryId)
          let snap = { x: 0, y: 0 }
          if (snapEnabledRef.current && primary !== undefined && origin !== undefined) {
            const moving = new Set(drag.origins.keys())
            const others = (documentRef.current?.nodes ?? []).filter(node => !moving.has(node.id))
            snap = snapOffset({ ...primary, x: origin.x, y: origin.y }, others, dx, dy, SNAP_SCREEN_PX / scale)
          }
          const place = (nodes: readonly CanvasNode[]): CanvasNode[] => nodes.map(node => {
            const nodeOrigin = drag.origins.get(node.id)
            return nodeOrigin === undefined ? node : { ...node, x: Math.round(nodeOrigin.x + dx + snap.x), y: Math.round(nodeOrigin.y + dy + snap.y) }
          })
          updateNodes(nodes => place(nodes))
        }
        return
      }
      const connect = connectRef.current
      if (connect !== null) {
        const world = screenToWorld(event.clientX, event.clientY)
        if (!connect.moved && Math.hypot(event.clientX - connect.startClient.x, event.clientY - connect.startClient.y) > 4) {
          connect.moved = true
          setNodeAddMenu(null)
        }
        const nodes = documentRef.current?.nodes ?? []
        let targetId: string | null = null
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index]!
          if (node.id === connect.nodeId) continue
          if (world.x >= node.x && world.x <= node.x + node.width && world.y >= node.y && world.y <= node.y + node.height) {
            targetId = node.id
            break
          }
        }
        const next = { ...connect, mouse: world, targetId }
        connectRef.current = next
        setConnecting(next)
        return
      }
      const resize = resizeRef.current
      if (resize !== null) {
        const scale = documentRef.current?.viewport.k ?? 1
        const next = resizedRect(resize, event.clientX - resize.startX, event.clientY - resize.startY, scale)
        updateNodes(nodes => nodes.map(node => node.id === resize.nodeId ? { ...node, ...next } : node))
        return
      }
      const activeMarquee = marqueeRef.current
      if (activeMarquee !== null) {
        const next = { ...activeMarquee, current: screenToWorld(event.clientX, event.clientY) }
        marqueeRef.current = next
        setMarquee(next)
        return
      }
      const pan = panRef.current
      if (pan !== null) {
        const dx = event.clientX - pan.startX
        const dy = event.clientY - pan.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.hasMoved = true
        const next = { x: pan.viewportX + dx, y: pan.viewportY + dy }
        if (panFrameRef.current !== null) return
        panFrameRef.current = requestAnimationFrame(() => {
          panFrameRef.current = null
          updateDocument(previous => ({ ...previous, viewport: { ...previous.viewport, x: next.x, y: next.y } }))
        })
      }
    }

    const up = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        activePointersRef.current.delete(event.pointerId)
        if (pinchRef.current !== null && activePointersRef.current.size < 2) {
          // Lifting one finger ends the pinch. The finger still down does NOT
          // become a pan: its pan state was discarded when the pinch started,
          // so resuming one would jump the canvas by the gap between the
          // gesture's start point and wherever that finger now is.
          pinchRef.current = null
          return
        }
      }
      const drag = dragRef.current
      if (drag !== null) {
        dragRef.current = null
        // 刻意**不**在这里清 dragMovingIds：松手之后那个节点依然被盖着、依然
        // 看不见，正是它需要提示的时候。提示本来就在「下一次拖动」时重算，
        // 用户把节点删掉或拖开也会立刻消失；留到那时候比在松手这一秒抹掉更对。
        return
      }
      const connect = connectRef.current
      if (connect !== null) {
        connectRef.current = null
        setConnecting(null)
        if (connect.targetId !== null) {
          if (connect.handleType === 'source') connectNodes(connect.nodeId, connect.targetId)
          else connectNodes(connect.targetId, connect.nodeId)
        }
        return
      }
      const resize = resizeRef.current
      if (resize !== null) {
        resizeRef.current = null
        return
      }
      const activeMarquee = marqueeRef.current
      if (activeMarquee !== null) {
        marqueeRef.current = null
        setMarquee(null)
        const minX = Math.min(activeMarquee.start.x, activeMarquee.current.x)
        const minY = Math.min(activeMarquee.start.y, activeMarquee.current.y)
        const maxX = Math.max(activeMarquee.start.x, activeMarquee.current.x)
        const maxY = Math.max(activeMarquee.start.y, activeMarquee.current.y)
        const nodes = documentRef.current?.nodes ?? []
        const hits = nodes.filter(node => node.x < maxX && node.x + node.width > minX && node.y < maxY && node.y + node.height > minY).map(node => node.id)
        if (Math.abs(activeMarquee.current.x - activeMarquee.start.x) < 4 && Math.abs(activeMarquee.current.y - activeMarquee.start.y) < 4) {
          setSelectedConnectionId(null)
          return
        }
        const next = activeMarquee.additive
          ? new Set([...activeMarquee.initialIds, ...hits])
          : new Set(hits)
        setSelectedIds(next)
        setSelectedConnectionId(null)
        return
      }
      const pan = panRef.current
      if (pan !== null) {
        panRef.current = null
        if (!pan.hasMoved && pan.startedOnBackground) {
          setSelectedIds(new Set()); setSelectedConnectionId(null)
        }
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [commitSnapshot, connectNodes, screenToWorld, setViewport, updateDocument, updateNodes])

  // --------------------------------------------------------- node events

  const handleNodePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string): void => {
    if (event.button !== 0 || tool === 'pan' || temporaryPanTool) return
    const current = documentRef.current
    if (current === null) return
    const node = current.nodes.find(item => item.id === nodeId)
    if (node === undefined) return
    event.stopPropagation()
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    setNodeAddMenu(null)
    let nextSelection = selectedIdsRef.current
    if (additive) {
      nextSelection = new Set(selectedIdsRef.current)
      if (nextSelection.has(nodeId)) nextSelection.delete(nodeId)
      else nextSelection.add(nodeId)
    } else if (!nextSelection.has(nodeId)) {
      nextSelection = new Set([nodeId])
    }
    setSelectedIds(nextSelection)
    setSelectedConnectionId(null)
    const origins = new Map<string, Point>()
    for (const id of nextSelection) {
      const item = current.nodes.find(candidate => candidate.id === id)
      if (item !== undefined) origins.set(id, { x: item.x, y: item.y })
    }
    // Annotation prompt cards are attached to their image node: they ride along
    // with it without joining the selection (which would hide the composer).
    for (const id of nextSelection) {
      const item = current.nodes.find(candidate => candidate.id === id)
      if (item === undefined || item.type !== 'image') continue
      for (const card of attachedCards(item, current.nodes)) origins.set(card.id, { x: card.x, y: card.y })
    }
    // 分组：拖任何一个成员，整组一起走。它们**不进 selectedIds**——选择集是
    // 用户的意思表达（composer 显示什么、成组时圈哪些都看它），让拖拽顺手
    // 往里塞人会让「拖一下」变成「改了选择」。这里只让它们跟着位移。
    for (const siblingId of siblingsInGroup(groupsOf(current), nodeId, new Set(origins.keys()))) {
      const sibling = current.nodes.find(candidate => candidate.id === siblingId)
      if (sibling === undefined) continue
      origins.set(sibling.id, { x: sibling.x, y: sibling.y })
      // 被带动的成员自己的标注卡也得跟上，否则整组一拖，卡片全留在原地
      // 漂成一堆不知属于谁的便签。
      if (sibling.type !== 'image') continue
      for (const card of attachedCards(sibling, current.nodes)) origins.set(card.id, { x: card.x, y: card.y })
    }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, snapshot: JSON.stringify(current), origins, primaryId: nodeId }
  }, [temporaryPanTool, tool])

  const handleConnectStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string, handleType: 'source' | 'target'): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    clearNodeAddMenuTimer(); setNodeAddMenu(null)
    const world = screenToWorld(event.clientX, event.clientY)
    const next: ConnectState = { nodeId, handleType, mouse: world, targetId: null, moved: false, startClient: { x: event.clientX, y: event.clientY } }
    connectRef.current = next
    setConnecting(next)
    setSelectedConnectionId(null)
  }, [clearNodeAddMenuTimer, screenToWorld])

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: ResizeCorner): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const asset = assetOf(node)
    const ratio = node.type === 'image' && asset !== undefined && asset.width > 0 && asset.height > 0 ? asset.height / asset.width : null
    resizeRef.current = { nodeId: node.id, corner, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, x: node.x, y: node.y, ratio }
    beginHistory()
  }, [beginHistory])

  const handleConnectionSelect = useCallback((connectionId: string): void => {
    setSelectedConnectionId(connectionId)
    setSelectedIds(new Set())
  }, [])

  // -------------------------------------------------------- file dropping

  /** Dropped files: images keep the fast data-URL path (they can also become
   *  generation references), everything else uploads as a file node at the
   *  pointer, one node per file. */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const dropped = [...(event.dataTransfer.files ?? [])]
    if (dropped.length === 0) return
    const world = screenToWorld(event.clientX, event.clientY)
    const allImages = dropped.filter(file => file.type.startsWith('image/'))
    // Both caps are checked BEFORE any FileReader runs. Reading first and
    // discarding later is the freeze this guards against: the data URLs are
    // already in memory by then, and there are as many of them as the user
    // dragged in.
    const oversized = allImages.filter(file => file.size > DROP_IMAGE_MAX_BYTES)
    const withinSize = allImages.filter(file => file.size <= DROP_IMAGE_MAX_BYTES)
    const images = withinSize.slice(0, DROP_IMAGE_MAX_COUNT)
    const overflowCount = withinSize.length - images.length
    const others = dropped.filter(file => !file.type.startsWith('image/'))
    if (oversized.length > 0 || overflowCount > 0) {
      setError(tt('canvas.dropLimit', {
        max: Math.round(DROP_IMAGE_MAX_BYTES / (1024 * 1024)),
        count: DROP_IMAGE_MAX_COUNT,
        skipped: oversized.length + overflowCount,
      }))
    }
    if (images.length > 0) {
      // Sequential, not Promise.all: N concurrent FileReaders each hold a full
      // copy of their file plus the base64 string, and a drop of many large
      // photos exhausted memory before the first upload even started.
      void (async () => {
        const assets: CanvasAssetRef[] = []
        for (const file of images) {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('image.readFailed'))); reader.readAsDataURL(file) })
          const dimensions = await readImageSize(dataUrl)
          assets.push(await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name }))
        }
        return assets
      })().then(assets => addAssets(assets, world)).catch(caught => setError(errorMessage(caught)))
    }
    let cascade = 0
    for (const file of others) {
      const point = { x: world.x + cascade * 26, y: world.y + cascade * 26 }
      cascade += 1
      void uploadCanvasFile(file, null, point).then(() => undefined)
    }
  }, [addAssets, api, screenToWorld, uploadCanvasFile])

  // ------------------------------------------------------------ projects

  const newCanvas = useCallback(async (): Promise<void> => {
    try {
      await flushPendingCanvas()
      const created = await api.canvasCreate(tt('canvas.untitled'))
      const next = seedDocument(created)
      setProjects(previous => [summaryOf(next), ...previous])
      setDocument(next); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(created); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, seedDocument, flushPendingCanvas])

  const selectProject = useCallback(async (id: string): Promise<void> => {
    try {
      await flushPendingCanvas()
      const next = await api.canvasRead(id)
      setDocument(normalizeConfigNodeSizes(next)); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(next); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
      // 下拉里那份「有 N 条待确认」是拉列表那一刻的快照。用户切一次画布正好
      // 是 Agent 最可能刚提过改动的时刻，所以在这里刷新一次；失败静默——
      // 计数是提示，不该让切换本身报错。
      void api.canvasList().then(setProjects).catch(() => {})
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, flushPendingCanvas])

  /**
   * Package the current canvas and hand it to the browser as a download.
   *
   * Clips are referenced rather than copied (a bundle would have to carry whole
   * videos), so a canvas with clips always exports with `unresolved` entries.
   * That is a success, not a failure: the document and every still image are
   * complete. What the notice adds is which half of them the user will lose on
   * the other machine, because "exported" on its own would read as "everything
   * came along".
   */
  const exportBundle = useCallback(async (): Promise<void> => {
    const current = documentRef.current
    if (current === null || bundleExporting) return
    setBundleExporting(true)
    try {
      const bundle = await api.canvasBundleExport(current.id)
      const json = JSON.stringify(bundle)
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      try {
        const link = globalThis.document.createElement('a')
        link.href = url
        link.download = bundleFileName(current.title)
        link.rel = 'noopener'
        link.click()
      } finally {
        // The click has already started the download; holding the object URL
        // alive past this point keeps the whole (possibly hundreds of MB) blob
        // resident for the life of the document.
        URL.revokeObjectURL(url)
      }
      const { video, asset } = countUnresolved(bundle.unresolved)
      const parts = [tt('canvas.bundle.exported', { title: current.title })]
      if (video > 0) parts.push(tt('canvas.bundle.droppedVideo', { count: video }))
      if (asset > 0) parts.push(tt('canvas.bundle.droppedAsset', { count: asset }))
      setNotice(parts.join(' '))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBundleExporting(false)
    }
  }, [api, bundleExporting])

  /**
   * Import a bundle as a brand new canvas.
   *
   * Deliberately not `selectProject`: the route already returned the whole
   * document, so re-reading it would be a second round trip for bytes we are
   * holding. Everything else `selectProject` does still has to happen — most
   * importantly `flushPendingCanvas()`, or the edits still buffered from the
   * canvas we are leaving get written into the one we just imported.
   */
  const importBundle = useCallback(async (file: File): Promise<void> => {
    if (bundleImporting) return
    setBundleImporting(true)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        // A JSON parse error names a character offset in a file the user never
        // opened — useless as advice. The actionable fact is which two things
        // could have produced it.
        setError(tt('canvas.bundle.importNotJson'))
        return
      }
      await flushPendingCanvas()
      const { document: imported, unresolved } = await api.canvasBundleImport(parsed)
      // Deliberately NOT `seedDocument`: an import restores what was exported,
      // and a bundle of an empty canvas must come back empty. `seedDocument`
      // adds a text + config pair to any canvas with no nodes — right for a
      // canvas the user just created, wrong for one they shipped between
      // machines.
      const next = normalizeConfigNodeSizes(imported)
      // The route does not return the project list, but the select above is
      // driven by `projects`: without this insert the new canvas is not in the
      // dropdown, and `currentProject` — which finds by `document.id` — comes
      // back undefined, leaving the favourite/delete buttons in a wrong state
      // for a canvas that does exist.
      setProjects(previous => [summaryOf(next), ...previous.filter(project => project.id !== next.id)])
      setDocument(next); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(next); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
      const { video, asset } = countUnresolved(unresolved)
      const parts = [tt('canvas.bundle.importDone', { title: next.title })]
      if (video > 0) parts.push(tt('canvas.bundle.importMissingVideo', { count: video }))
      if (asset > 0) parts.push(tt('canvas.bundle.importMissingAsset', { count: asset }))
      setNotice(parts.join(' '))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBundleImporting(false)
    }
  }, [api, bundleImporting, flushPendingCanvas])

  const currentProject = projects.find(project => project.id === document?.id)
  const favoriteProjects = projects.filter(project => project.favorite === true)
  const otherProjects = projects.filter(project => project.favorite !== true)
  const currentFavorite = currentProject?.favorite === true

  const toggleCurrentFavorite = useCallback(async (): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    try {
      setProjects(await api.canvasFavorite(current.id, !currentFavorite))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api, currentFavorite])

  const removeCurrentProject = useCallback(async (): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    try {
      const remaining = await api.canvasRemove(current.id)
      // The canvas is gone, so a pending edit has nothing left to write to:
      // record the live document as reconciled BEFORE the follow-up project
      // switch, whose flush would otherwise save it straight back onto the
      // deleted canvas.
      syncedRef.current = JSON.stringify(documentRef.current ?? current)
      setConfirmDeleteProject(false)
      const nextId = remaining[0]?.id
      if (nextId === undefined) {
        const created = await api.canvasCreate(tt('canvas.untitled'))
        const created2 = seedDocument(created)
        setProjects([summaryOf(created2)]); setDocument(created2)
        syncedRef.current = JSON.stringify(created); setSaveState('saved')
      } else {
        setProjects(remaining)
        await selectProject(nextId)
      }
      setSelectedIds(new Set()); setSelectedConnectionId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, selectProject, seedDocument])

  // -------------------------------------------------------------- derived

  const nodeById = useMemo(() => new Map((document?.nodes ?? []).map(node => [node.id, node])), [document])
  // 右键菜单要在连线上显示/切换用途，与 nodeById 同一套读法。
  const connectionById = useMemo(() => new Map((document?.connections ?? []).map(connection => [connection.id, connection])), [document])
  /** 分组：老画布没有这个字段，`groupsOf` 读作空数组，这里无需额外判空。 */
  const groups = useMemo(() => groupsOf(document), [document])
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups])
  /** 正在设置身份参考的节点；节点被删掉时面板自然消失，不留一个悬空面板。 */
  const castNode = useMemo(() => castTarget === null ? undefined : nodeById.get(castTarget), [castTarget, nodeById])
  /** The file node whose full-screen reader is open, with its asset resolved. */
  const filePreviewNode = useMemo(() => {
    if (filePreviewNodeId === null) return undefined
    const node = nodeById.get(filePreviewNodeId)
    const asset = node === undefined ? undefined : assetOf(node)
    return node === undefined || asset === undefined || asset.assetId === '' ? undefined : { node, asset }
  }, [filePreviewNodeId, nodeById])
  const videoPreviewNode = useMemo(() => {
    if (videoPreviewNodeId === null) return undefined
    const node = nodeById.get(videoPreviewNodeId)
    if (node === undefined) return undefined
    const clip = videoOf(node)
    return clip === undefined || clip.url === '' ? undefined : { node, clip }
  }, [videoPreviewNodeId, nodeById])
  const relatedIds = useMemo(() => {
    const related = new Set<string>()
    if (document === null) return related
    for (const connection of document.connections) {
      if (selectedIds.has(connection.fromNodeId)) related.add(connection.toNodeId)
      if (selectedIds.has(connection.toNodeId)) related.add(connection.fromNodeId)
    }
    return related
  }, [document, selectedIds])

  const isSpaceOrCtrl = temporaryPanTool
  const cursorClass = tool === 'pan' || isSpaceOrCtrl ? css.panCursor : css.selectCursor

  const backgroundMode = document?.background ?? 'lines'
  const setBackgroundMode = useCallback((mode: BackgroundMode): void => {
    mutate(previous => ({
      ...previous,
      background: mode,
      ...(mode === 'image' ? {} : { backgroundImage: undefined }),
    }))
    setBackgroundMenu(null)
  }, [mutate])

  const uploadBackgroundImage = useCallback(async (file: File): Promise<void> => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('image.readFailed'))); reader.readAsDataURL(file) })
      const dimensions = await readImageSize(dataUrl)
      const asset = await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: 'canvas-background' })
      mutate(previous => ({ ...previous, background: 'image', backgroundImage: asset.url }))
      setBackgroundMenu(null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api, mutate])

  const removeBackgroundImage = useCallback((): void => {
    mutate(previous => ({ ...previous, background: 'lines', backgroundImage: undefined }))
    setBackgroundMenu(null)
  }, [mutate])

  const applyTemplate = useCallback((prompt: string): void => {
    const center = canvasCenter()
    const config = createConfigNode(center)
    const text = createTextNode()
    const placed: CanvasNode = {
      ...text,
      x: Math.round(config.x - TEXT_NODE_SIZE.width - 80),
      y: Math.round(config.y + (config.height - TEXT_NODE_SIZE.height) / 2),
      metadata: { text: prompt, fontSize: 14 },
    }
    mutate(previous => ({
      ...previous,
      nodes: [...previous.nodes, placed, config],
      connections: [...previous.connections, { id: newId('edge'), fromNodeId: placed.id, toNodeId: config.id }],
    }))
    setSelectedIds(new Set([config.id])); setSelectedConnectionId(null)
    setSkillLibraryOpen(false)
  }, [canvasCenter, createConfigNode, createTextNode, mutate])

  const gridSize = GRID_SIZE * (document?.viewport.k ?? 1)
  const gridOffsetX = (document?.viewport.x ?? 0) % gridSize
  const gridOffsetY = (document?.viewport.y ?? 0) % gridSize

  // ------------------------------------------------------------- render

  /**
   * 被完全盖住的节点：文档的纯函数，不是另一份要维护的状态。
   *
   * WHY 只在拖动时算：两块静止的节点重叠是历史数据，每次载入都描红会变成
   * 用户甩不掉的报错；WHY 只算「完全盖住」：部分重叠在画布上是常态，提示它只会
   * 变成噪音。真正卡住人的是被完全罩住——屏幕上看不见它，框选也选不到。
   *
   * WHY 不存下来：删除、撤销、换画布都会让上一帧的结论失效，而在每个出口记得
   * 清一遍是漏一处就留一个指着空处的出口。每次渲染重算最便宜也最不会错。
   */
  const liveOverlap = (() => {
    if (document === null || dragMovingIdsRef.current.size === 0) return null
    const pairs = coveredNodes(document.nodes, dragMovingIdsRef.current)
    const hit = pairs[0]
    if (hit === undefined) return null
    const coverTitle = document.nodes.find(node => node.id === hit.coverId)?.title ?? ''
    return { ids: new Set([hit.coveredId, hit.coverId]), coveredId: hit.coveredId, coverTitle }
  })()

  const nodeClassName = (node: CanvasNode): string => {
    const isSketch = isSketchNode(node)
    const isStoryboard = node.type === 'storyboard'
    const isConfig = node.type === 'config'
    const isTextual = node.type === 'text' || isConfig
    const isSelected = selectedIds.has(node.id)
    const isRelated = relatedIds.has(node.id)
    const isConnectTarget = connecting?.targetId === node.id
    const isOverlapping = liveOverlap !== null && liveOverlap.ids.has(node.id)
    return `${css.node} ${isSketch ? css.sketchNode : isStoryboard ? css.storyboardNode : isConfig ? css.configNode : isTextual ? css.textNode : css.imageNode} ${isSelected ? css.nodeSelected : ''} ${isRelated ? css.nodeRelated : ''} ${isConnectTarget ? css.nodeConnectTarget : ''} ${isOverlapping ? css.nodeOverlap : ''}`
  }

  const handleNodeDoubleClick = (event: React.MouseEvent, node: CanvasNode): void => {
    if (closestOf(event.target, 'button, input, select, textarea, [data-toolbar]') !== null) return
    const video = videoOf(node)
    if (node.type === 'video' && video !== undefined && video.url !== '') {
      event.preventDefault(); event.stopPropagation(); setVideoPreviewNodeId(node.id); return
    }
    const asset = assetOf(node)
    if (node.type !== 'image' || asset === undefined || asset.url === '') return
    event.preventDefault(); event.stopPropagation(); openImageNode(node)
  }

  const handleNodeContextMenu = (event: React.MouseEvent, node: CanvasNode): void => {
    if (closestOf(event.target, 'textarea, input, select') !== null) return
    event.preventDefault(); event.stopPropagation()
    if (!selectedIds.has(node.id)) setSelectedIds(new Set([node.id]))
    setContextMenu({ type: 'node', screen: { x: event.clientX, y: event.clientY }, nodeId: node.id })
  }

  const handleNodeClick = (event: React.MouseEvent, node: CanvasNode): void => {
    if (closestOf(event.target, 'button, input, select, textarea, [data-toolbar]') !== null) return
    event.stopPropagation()
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    setNodeAddMenu(null)
    setSelectedIds(previous => {
      if (additive) {
        const next = new Set(previous)
        if (next.has(node.id)) next.delete(node.id); else next.add(node.id)
        return next
      }
      return previous.has(node.id) ? previous : new Set([node.id])
    })
    setSelectedConnectionId(null)
  }

  const nodeBodyState: NodeBodyState = useMemo(() => ({
    canvasDocument: document,
    selectedIds, relatedIds, connecting, liveOverlap, skillRuns, composeIds,
    annotateNodeId, busyNodes, annotationDraft, annotationDragRef,
    colorPickerNodeId, brokenVideoIds, polishBusy,
    api, modelGroups, videoGroups, defaultChannelId,
    fileUploadRef, imageFileRef, connectRef,
    IconButton, ToolbarIcon, ModelPicker, SketchBoard, StoryboardBody, CanvasFileBody,
    ROLE_LABELS, TEXT_COLORS,
    nodeMetadata, assetOf, videoOf, isSketchNode, isAnnotationCard, layerKindLabel,
    liveAnnotations, fileKindOfAsset, fileKindLabel, fileSizeLabel,
    storyboardOf, storyboardProgress, resolveModelChoice, textStyleOf,
  }), [document, selectedIds, relatedIds, connecting, liveOverlap, skillRuns, composeIds,
    annotateNodeId, busyNodes, annotationDraft, colorPickerNodeId, brokenVideoIds, polishBusy,
    api, modelGroups, videoGroups, defaultChannelId])

  const nodeBodyActions: NodeBodyActions = useMemo(() => ({
    patchNode, deleteNode, duplicateNode, downloadNode, downloadFileNode, downloadVideoNode,
    openImageNode, openFileNode, openSkillMenu, openNodeAddMenu, scheduleNodeAddMenuClose,
    handleConnectStart, handleResizeStart, beginAnnotationDrag, moveAnnotationDrag, endAnnotationDrag,
    toggleAnnotate, removeNodeBackground, splitLayers, retryGeneration, retryVideoGeneration,
    grabVideoFrame, continueFromClip, favoriteVideoNode, runStoryboard, submitShot,
    startStoryboardStitch, clearBrokenVideo, patchSketchStrokes, patchSketchAsset,
    setColorPickerNodeId, setVideoPreviewNodeId, setFilePreviewNodeId, setFileTargetNodeId,
    setPosterTarget, setPolishNode, setBrokenVideoIds, setAnnotationDraft,
  }), [patchNode, deleteNode, duplicateNode, downloadNode, downloadFileNode, downloadVideoNode,
    openImageNode, openFileNode, openSkillMenu, openNodeAddMenu, scheduleNodeAddMenuClose,
    handleConnectStart, handleResizeStart, beginAnnotationDrag, moveAnnotationDrag, endAnnotationDrag,
    toggleAnnotate, removeNodeBackground, splitLayers, retryGeneration, retryVideoGeneration,
    grabVideoFrame, continueFromClip, favoriteVideoNode, runStoryboard, submitShot,
    startStoryboardStitch, clearBrokenVideo, patchSketchStrokes, patchSketchAsset])

  const renderNodeBody = (node: CanvasNode): React.JSX.Element =>
    <NodeBody node={node} S={nodeBodyState} A={nodeBodyActions} />

  // 输入条与右键菜单：与 NodeBody 同法，用 useMemo 固定 S/A——摊平的话每次
  // 渲染都会重建几十个箭头函数，这些 props 会被下游整体当成新值。
  const composerState: ComposerState = useMemo(() => ({
    canvasDocument: document,
    viewportSize, viewportRef,
    modelGroups, videoGroups,
    composerVisible, composerTarget, composerKind, composerPrompt, composerRenderer,
    composerBusy, composerReferenceCount, composerTextCount, composerAnnotationTexts, composerAutoLinkCount,
    composerChannelConnected, composerChannelId, composerModel,
    composerVideoChannelId, composerVideoModel, composerVideoConnected, composerVideoMode,
    composerAspect, composerAspectOptions, composerSeconds, composerDurationOptions,
    composerResolution, composerResolutionOptions, composerSize, composerQuality, composerCount,
    composerProbeWarning, composerVideoCatalog, videoModelCount,
  }), [
    document, viewportSize, viewportRef, modelGroups, videoGroups,
    composerVisible, composerTarget, composerKind, composerPrompt, composerRenderer,
    composerBusy, composerReferenceCount, composerTextCount, composerAnnotationTexts, composerAutoLinkCount,
    composerChannelConnected, composerChannelId, composerModel,
    composerVideoChannelId, composerVideoModel, composerVideoConnected, composerVideoMode,
    composerAspect, composerAspectOptions, composerSeconds, composerDurationOptions,
    composerResolution, composerResolutionOptions, composerSize, composerQuality, composerCount,
    composerProbeWarning, composerVideoCatalog, videoModelCount,
  ])

  const composerActions: ComposerActions = useMemo(() => ({
    submitComposer, submitVideoComposer,
    setComposerPrompt, setComposerKind, setComposerRenderer,
    setComposerChannelId, setComposerModel,
    setComposerVideoChannelId, setComposerVideoModel, setComposerVideoMode,
    setComposerAspect, setComposerSeconds, setComposerResolution,
    setComposerSize, setComposerQuality, setComposerCount,
  }), [
    submitComposer, submitVideoComposer,
    setComposerPrompt, setComposerKind, setComposerRenderer,
    setComposerChannelId, setComposerModel,
    setComposerVideoChannelId, setComposerVideoModel, setComposerVideoMode,
    setComposerAspect, setComposerSeconds, setComposerResolution,
    setComposerSize, setComposerQuality, setComposerCount,
  ])

  const renderComposer = (): ReactNode =>
    <CanvasComposer S={composerState} A={composerActions} />

  const contextMenuState: CanvasContextMenuState = useMemo(() => ({
    canvasDocument: document,
    contextMenu, createMenu, nodeById, connectionById, groupById, fileUploadRef,
    selectedCount: selectedIds.size,
    assetOf, videoOf, nodeMetadata, isAnnotationCard,
    createTextNode, createSketchNode, createStoryboardNode,
    createImageNode, createEmptyFileNode, createConfigNode,
  }), [
    document, contextMenu, createMenu, nodeById, connectionById, groupById, fileUploadRef,
    selectedIds,
    assetOf, videoOf, nodeMetadata, isAnnotationCard,
    createTextNode, createSketchNode, createStoryboardNode,
    createImageNode, createEmptyFileNode, createConfigNode,
  ])

  /**
   * 给一条连线设角色。`input` 走 `withRole` 会删字段，等于「清除用途」，
   * 所以菜单里那两项其实是同一个动作的两个入口。
   */
  const setConnectionRole = useCallback((connectionId: string, role: CanvasConnectionRole): void => {
    mutate(previous => ({
      ...previous,
      connections: previous.connections.map(connection => connection.id === connectionId ? withRole(connection, role) : connection),
    }))
  }, [mutate])

  // ------------------------------------------------------------------ 分组

  /**
   * 把当前选择圈成一个新组。
   *
   * 不足两个成员时什么都不做：一个节点的组与没成组看不出区别，却会多出一个
   * 要管理的对象。这里也不弹提示——「成组」在只选了一个时本来就没有意义，
   * 安静地不生效比跳一个解释框更少打扰。
   */
  const createGroup = useCallback((): void => {
    // Set 本身已去重，所以「够不够成组」等价于成员数 >= 2。
    if (selectedIdsRef.current.size < 2) return
    const memberIds = [...selectedIdsRef.current]
    mutate(previous => {
      const result = withGroup(groupsOf(previous), memberIds, () => newId('group'))
      // groupsField：解散光/不足两个都不会走到这里，但它保证「没有任何组」
      // 落盘时是「没这个字段」而不是 `groups: []`。
      return result === undefined ? previous : { ...previous, groups: groupsField(result.groups) }
    })
  }, [mutate])

  const ungroup = useCallback((groupId: string): void => {
    mutate(previous => ({ ...previous, groups: groupsField(withoutGroup(groupsOf(previous), groupId)) }))
  }, [mutate])

  /**
   * 重命名输入态。不复用画布标题那套 `renamingTitle`：那一份直接改
   * `document.title`，是「边打边存」；组的名字挂在数组元素上，边打边存会让
   * 每个按键都进一次 undo 历史，撤销一次只退一个字符。这里攒到提交再写。
   */
  const [groupRename, setGroupRename] = useState<{ groupId: string; value: string } | null>(null)

  /**
   * 重命名是否还「在场」的权威判据。
   *
   * 不能靠闭包里的 `groupRename`：`setGroupRename(null)` 之后 React 才会重渲染，
   * 而在同一次事件处理里紧接着触发的 blur（Enter → 提交 → 输入框消失 → blur）
   * 读到的还是**旧的、非 null** 的 `groupRename`。于是：
   *
   *  - Esc 取消后，blur 仍然照旧提交一次 —— 用户明确按了「什么都不改」，
   *    却把改动写了进去，这是最难接受的一种。
   *  - Enter 提交后，blur 又提交一次 —— 同样的值写两遍，undo 要按两次才退回去。
   *
   * ref 在 `setGroupRename` 的同一个同步代码段里更新，所以它读到的永远是
   * 「现在真正该不该写」。
   */
  const groupRenameRef = useRef<{ groupId: string; value: string } | null>(null)

  /** 开/关重命名：ref 与 state 一起改，两者不会脱节。 */
  const setGroupRenameBoth = useCallback((next: { groupId: string; value: string } | null): void => {
    groupRenameRef.current = next
    setGroupRename(next)
  }, [])

  const commitGroupRename = useCallback((): void => {
    const target = groupRenameRef.current
    // 先清再写：既让重复调用（Enter 后紧跟 blur）落空，也让「取消」这条路上
    // 的 blur 看到的是 null。
    setGroupRenameBoth(null)
    if (target === null) return
    mutate(previous => ({ ...previous, groups: groupsField(withGroupTitle(groupsOf(previous), target.groupId, target.value)) }))
  }, [mutate, setGroupRenameBoth])

  /** 双击组标题时开重命名：把当前名字填进输入框，而不是留空让用户重打。 */
  const beginGroupRename = useCallback((groupId: string): void => {
    const group = groupsOf(documentRef.current).find(candidate => candidate.id === groupId)
    setGroupRenameBoth({ groupId, value: group?.title ?? '' })
  }, [setGroupRenameBoth])

  const contextMenuActions: CanvasContextMenuActions = useMemo(() => ({
    setContextMenu, setCreateMenu, setFileTargetNodeId, setPickerOpen, setSelectedConnectionId,
    setVideoPreviewNodeId, setPosterTarget, setCastTarget, setPolishNode, setNotice,
    openImageNode, openFileNode, openSkillMenu,
    downloadNode, downloadFileNode, downloadVideoNode, continueFromClip,
    duplicateNode, deleteNode, patchNode, placeNewNode, pasteClipboard, fitView, mutate,
    setConnectionRole, createGroup, renameGroup: beginGroupRename, ungroup,
  }), [
    setContextMenu, setCreateMenu, setFileTargetNodeId, setPickerOpen, setSelectedConnectionId,
    setVideoPreviewNodeId, setPosterTarget, setCastTarget, setPolishNode, setNotice,
    openImageNode, openFileNode, openSkillMenu,
    downloadNode, downloadFileNode, downloadVideoNode, continueFromClip,
    duplicateNode, deleteNode, patchNode, placeNewNode, pasteClipboard, fitView, mutate,
    setConnectionRole, createGroup, beginGroupRename, ungroup,
  ])

  const renderContextMenu = (): ReactNode =>
    <CanvasContextMenu S={contextMenuState} A={contextMenuActions} />

  // ------------------------------------------------------ react-flow 受控视图
  // document 是唯一真源；flow 节点/边/视口都由它派生，变更回写 document。
  // screenToWorld/canvasCenter/fitView 仍读写 document.viewport（经 onViewportChange
  // 同步），所以原样可用。拖拽历史走 onNodeDragStart/Stop（保 3px 阈值语义）。
  const flowNodes = useMemo(
    () => nodesToFlow(document?.nodes ?? []).map(node => ({ ...node, selected: selectedIds.has(node.id) })),
    [document, selectedIds],
  )
  // 这里不再派生 flow 边：react-flow 的 `edges` 传的是空数组，连线由
  // `ConnectionLayer` 自己按 document.connections 画，「两端都在且都不是标注卡」
  // 这条过滤也在那边（canvas/connection-layer.tsx）。曾经这里还有一份
  // connectionsToEdges 的 useMemo，算完没有任何读者，已随 react-flow 迁移的尾账
  // 一并删掉——留着会让同一份过滤在两处各自漂移而没人发现。
  const flowViewport = viewportToFlow(document?.viewport ?? { x: 0, y: 0, k: 1 })
  const dragSnapshotRef = useRef<string | null>(null)

  const handleNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]): void => {
    const positions = changes.filter((change): change is Extract<NodeChange<CanvasFlowNode>, { type: 'position' }> => change.type === 'position')
    const selects = changes.filter((change): change is Extract<NodeChange<CanvasFlowNode>, { type: 'select' }> => change.type === 'select')
    const removes = changes.filter((change): change is Extract<NodeChange<CanvasFlowNode>, { type: 'remove' }> => change.type === 'remove')
    if (positions.length > 0) {
      updateNodes(nodes => nodes.map(node => {
        const change = positions.find(item => item.id === node.id)
        return change !== undefined && change.position !== undefined ? { ...node, x: change.position.x, y: change.position.y } : node
      }))
    }
    if (selects.length > 0) {
      setSelectedIds(previous => {
        const next = new Set(previous)
        for (const change of selects) { if (change.selected) next.add(change.id); else next.delete(change.id) }
        return next
      })
    }
    if (removes.length > 0) {
      const ids = new Set(removes.map(change => change.id))
      mutate(previous => {
        const nodes = previous.nodes.filter(node => !ids.has(node.id))
        return {
          ...previous,
          nodes,
          connections: previous.connections.filter(connection => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId)),
          // 第三条删除路径，同样按「还剩谁」重算（理由见 deleteSelection）。
          groups: pruneGroupsField(previous.groups, new Set(nodes.map(node => node.id))),
        }
      })
    }
  }, [updateNodes, mutate])

  const handleEdgesChange = useCallback((changes: EdgeChange[]): void => {
    const removes = changes.filter(change => change.type === 'remove')
    if (removes.length === 0) return
    const ids = new Set(removes.map(change => change.id))
    mutate(previous => ({ ...previous, connections: previous.connections.filter(connection => !ids.has(connection.id)) }))
  }, [mutate])

  const handleConnect = useCallback((connection: Connection): void => {
    if (connection.source !== null && connection.target !== null) connectNodes(connection.source, connection.target)
  }, [connectNodes])

  const handleViewportChange = useCallback((viewport: Viewport): void => {
    // jsdom 无 layout（rect 恒 0）时 react-flow 可能回 NaN 视口；守住边界，
    // 不让它污染 document.viewport（真浏览器里视口始终有限）。
    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom)) return
    setViewport(viewportFromFlow(viewport))
  }, [setViewport])

  const handleNodeDragStart = useCallback((): void => {
    dragSnapshotRef.current = beginHistory()
    dragMovingIdsRef.current = new Set(selectedIdsRef.current)
  }, [beginHistory])

  const handleNodeDragStop = useCallback((): void => {
    commitSnapshot(dragSnapshotRef.current)
    dragSnapshotRef.current = null
  }, [commitSnapshot])

  const handlePaneClick = useCallback((): void => {
    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null)
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [])

  /** Leader lines from each annotation box to the prompt card hanging off it.
   *  Rendered in its own layer above the nodes so the line is visible where it
   *  leaves the box, instead of disappearing under the picture. */
  const renderAnnotationLinks = (): React.JSX.Element | null => {
    if (document === null) return null
    const links = document.nodes.flatMap(image => image.type !== 'image' ? [] : liveAnnotations(image, document.nodes).flatMap(annotation => {
      const card = annotation.nodeId === undefined ? undefined : nodeById.get(annotation.nodeId)
      return card === undefined ? [] : [{ id: annotation.id, from: annotationAnchor(image, annotation), to: nodeAnchor(card, 'left') }]
    }))
    if (links.length === 0) return null
    return <svg
      className={css.annotationLinkLayer}
      data-annotation-links=""
      width={WORLD_PAD * 2}
      height={WORLD_PAD * 2}
      style={{ left: -WORLD_PAD, top: -WORLD_PAD }}
      aria-hidden="true"
    >
      <g transform={`translate(${WORLD_PAD},${WORLD_PAD})`}>
        {links.map(link => <g key={link.id}>
          <path data-annotation-link={link.id} d={bezierPath(link.from, link.to)} className={css.annotationLink} />
          <circle cx={link.from.x} cy={link.from.y} r={4} className={css.annotationLinkDot} />
        </g>)}
      </g>
    </svg>
  }

  // ---- renderComposer 已搬出：见 canvas/composer.tsx / canvas/context-menu.tsx

  const renderMinimap = (): React.JSX.Element | null => {
    if (document === null || viewportSize.width === 0) return null
    return <CanvasMinimap
      nodes={document.nodes}
      viewport={document.viewport}
      size={viewportSize}
      selectedIds={selectedIds}
      onViewport={setViewport}
    />
  }

  // ---- renderContextMenu 已搬出：见 canvas/composer.tsx / canvas/context-menu.tsx

  const emptyState = document !== null && document.nodes.length === 0
    ? <div className={css.emptyHint} data-canvas-no-zoom="">
        <strong>{tt('canvas.emptyTitle')}</strong>
        <span>{tt('canvas.emptyHint')}</span>
        {/* LibTV 空态：一排快捷卡，点一下=现有 add 动作落在画布中心。
            不造新入口：视频走现有 video picker，其余走现有创建函数。 */}
        <div className={css.quickRow} role="group" aria-label={tt('canvas.quickStart')}>
          <button type="button" className={css.quickCard} data-quick-card="image" onClick={() => placeNewNode(createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }))}>
            <span className={css.quickIcon}><ToolbarIcon name="image" size={18} /></span>{tt('canvas.quickImage')}
          </button>
          <button type="button" className={css.quickCard} data-quick-card="video" onClick={() => setVideoPickerOpen(true)}>
            <span className={css.quickIcon}><ToolbarIcon name="video" size={18} /></span>{tt('canvas.quickVideo')}
          </button>
          <button type="button" className={css.quickCard} data-quick-card="text" onClick={() => placeNewNode(createTextNode())}>
            <span className={css.quickIcon}><ToolbarIcon name="text" size={18} /></span>{tt('canvas.quickText')}
          </button>
          <button type="button" className={css.quickCard} data-quick-card="storyboard" onClick={() => placeNewNode(createStoryboardNode())}>
            <span className={css.quickIcon}><ToolbarIcon name="layers" size={18} /></span>{tt('canvas.quickStoryboard')}
          </button>
          <button type="button" className={css.quickCard} data-quick-card="file" onClick={() => placeNewNode(createEmptyFileNode())}>
            <span className={css.quickIcon}><ToolbarIcon name="file" size={18} /></span>{tt('canvas.quickFile')}
          </button>
        </div>
      </div>
    : null

  const marqueeRect = marquee === null ? null : (() => {
    const x1 = (Math.min(marquee.start.x, marquee.current.x) * (document?.viewport.k ?? 1)) + (document?.viewport.x ?? 0)
    const y1 = (Math.min(marquee.start.y, marquee.current.y) * (document?.viewport.k ?? 1)) + (document?.viewport.y ?? 0)
    const x2 = (Math.max(marquee.start.x, marquee.current.x) * (document?.viewport.k ?? 1)) + (document?.viewport.x ?? 0)
    const y2 = (Math.max(marquee.start.y, marquee.current.y) * (document?.viewport.k ?? 1)) + (document?.viewport.y ?? 0)
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
  })()

  return <section ref={rootRef} className={css.root} data-canvas-workspace="">
    {/* Overlays that used to portal to <body> render here instead.
        A fullscreen element is promoted to the browser's TOP LAYER, which
        paints above the whole document — so a menu appended to <body> is
        behind the canvas no matter how high its z-index. Keeping them inside
        the root means they ride into the top layer with it. */}
    <div ref={overlayHostRef} className={css.overlayHost} data-canvas-overlay-host="" />
    <CanvasProposalBar
      proposals={proposals}
      busy={proposalsBusy}
      error={proposalError}
      stacked={error !== null}
      belowTopBar={topBarHeight}
      onAccept={proposalId => { void acceptProposal(proposalId) }}
      onDiscard={proposalId => { void discardProposal(proposalId) }}
      onDiscardAll={() => { void discardAllProposals() }}
    />
    <header ref={topBarRef} className={css.topBar} data-canvas-no-zoom="">
      <Select
        className={css.projectSelect}
        value={document?.id ?? ''}
        searchable
        aria-label={tt('canvas.project')}
        searchPlaceholder={tt('canvas.projectSearch')}
        emptyText={tt('canvas.projectEmpty')}
        optionHint={option => {
          const project = projects.find(entry => entry.id === option.value)
          if (project === undefined) return undefined
          return tt('canvas.projectMeta', { count: project.nodeCount, time: new Date(project.updatedAt).toLocaleString() })
        }}
        onChange={value => { void selectProject(value) }}
      >
        {favoriteProjects.length > 0 ? <optgroup label={tt('canvas.favoriteProjects', { count: favoriteProjects.length })}>
          {favoriteProjects.map(project => <option key={project.id} value={project.id}>★ {projectLabel(project)}</option>)}
        </optgroup> : null}
        {otherProjects.length > 0 ? <optgroup label={tt('canvas.allProjects', { count: otherProjects.length })}>
          {otherProjects.map(project => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
        </optgroup> : null}
      </Select>
      <IconButton name="new" label={tt('canvas.newCanvas')} onClick={() => { void newCanvas() }} />
      <IconButton
        name={currentFavorite ? 'favoriteFilled' : 'favorite'}
        label={currentFavorite ? tt('canvas.unfavoriteCanvas') : tt('canvas.favoriteCanvas')}
        active={currentFavorite}
        disabled={document === null}
        onClick={() => { void toggleCurrentFavorite() }}
      />
      <IconButton name="deleteProject" label={confirmDeleteProject ? tt('canvas.deleteCanvasConfirm') : tt('canvas.deleteCanvas')} active={confirmDeleteProject} disabled={document === null} onClick={() => {
        if (confirmDeleteProject) { void removeCurrentProject() } else { setConfirmDeleteProject(true); window.setTimeout(() => setConfirmDeleteProject(false), 3000) }
      }} />
      {renamingTitle && document !== null
        ? <input
            className={css.titleInput}
            value={document.title}
            autoFocus
            aria-label={tt('canvas.rename')}
            onChange={event => updateDocument(previous => ({ ...previous, title: event.target.value }))}
            onBlur={() => setRenamingTitle(false)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') setRenamingTitle(false) }}
          />
        : <button type="button" className={css.titleButton} onDoubleClick={() => setRenamingTitle(true)} title={tt('canvas.renameHint')}>{document?.title ?? ''}</button>}
      {/* Beside the title, not in the bottom dock: the dock is the canvas's
          object-building verbs, while this changes the surface itself. */}
      <IconButton
        name={fullscreen ? 'exitFullscreen' : 'fullscreen'}
        label={fullscreen ? tt('canvas.fullscreen.exit') : tt('canvas.fullscreen.enter')}
        active={fullscreen}
        onClick={toggleFullscreen}
      />
      {/* Same row as fullscreen: both operate on the canvas as a whole rather
          than on an object inside it, which is the line the bottom dock draws.
          No `data-dock-item` on these — that attribute marks dock tiles and the
          layout guard measures every one of them. */}
      <IconButton
        name="download"
        label={bundleExporting ? tt('canvas.bundle.exporting') : tt('canvas.bundle.export')}
        disabled={document === null || bundleExporting}
        onClick={() => { void exportBundle() }}
      />
      <IconButton
        name="upload"
        label={bundleImporting ? tt('canvas.bundle.importing') : tt('canvas.bundle.import')}
        disabled={bundleImporting}
        onClick={() => { bundleFileRef.current?.click() }}
      />
      <input
        ref={bundleFileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={event => {
          const file = event.target.files?.[0]
          // Cleared before the async work: the same file chosen twice in a row
          // fires no change event otherwise, and the second attempt looks dead.
          event.target.value = ''
          if (file !== undefined) void importBundle(file)
        }}
      />
      <span className={css.topBarSpacer} />
      <span className={css.saveState} data-state={saveState}>{saveState === 'saving' ? tt('canvas.saving') : saveState === 'saved' ? tt('canvas.saved') : saveState === 'error' ? tt('canvas.saveFailed') : tt('canvas.loading')}</span>
    </header>

    <div
      ref={viewportRef}
      className={`${css.viewport} ${cursorClass}`}
      onPointerDown={onViewportPointerDown}
      onDoubleClick={event => {
        const target = event.target as Element | null
        if (closestOf(target, '[data-node-id],[data-canvas-no-zoom]') !== null) return
        setCreateMenu({ screen: { x: event.clientX, y: event.clientY }, world: screenToWorld(event.clientX, event.clientY) })
      }}
      onContextMenu={event => {
        const target = event.target as Element | null
        if (closestOf(target, '[data-node-id],[data-connection-hit],[data-canvas-no-zoom]') !== null) return
        event.preventDefault()
        setContextMenu({ type: 'canvas', screen: { x: event.clientX, y: event.clientY }, world: screenToWorld(event.clientX, event.clientY) })
      }}
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      <div
        className={css.grid}
        style={backgroundMode === 'image' && document?.backgroundImage
          ? { backgroundImage: `url(${document.backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : backgroundMode === 'liquid' || backgroundMode === 'floatingLines' || backgroundMode === 'galaxy' || backgroundMode === 'silk' || backgroundMode === 'waves' || backgroundMode === 'faultyTerminal' || backgroundMode === 'dotField' || backgroundMode === 'dotGrid' || backgroundMode === 'shapeGrid'
            ? undefined
            : { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px` }}
        data-mode={backgroundMode}
        aria-hidden="true"
      >
        {backgroundMode === 'image' ? <div className={css.gridScrim} /> : null}
        {backgroundMode === 'flow' ? <FlowBackground /> : null}
        {backgroundMode === 'liquid' ? <LiquidEtherBackground /> : null}
        {backgroundMode === 'floatingLines' ? <FloatingLinesBackground /> : null}
        {backgroundMode === 'galaxy' ? <GalaxyBackground /> : null}
        {backgroundMode === 'silk' ? <SilkBackground /> : null}
        {backgroundMode === 'waves' ? <WavesBackground /> : null}
        {backgroundMode === 'faultyTerminal' ? <FaultyTerminalBackground /> : null}
        {backgroundMode === 'dotField' ? <DotFieldBackground /> : null}
        {backgroundMode === 'dotGrid' ? <DotGridBackground /> : null}
        {backgroundMode === 'shapeGrid' ? <ShapeGridBackground /> : null}
      </div>
      {document !== null ? (
        <div className={css.flowRoot}>
          <ReactFlowProvider>
            <CanvasFlowProvider value={{
              document, selectedIds, colorMode: 'system', annotatingNodeId: annotateNodeId,
              nodeById: id => nodeById.get(id), nodeClassName, renderNodeBody,
              onNodeDoubleClick: handleNodeDoubleClick, onNodeContextMenu: handleNodeContextMenu,
              onNodePointerDown: handleNodePointerDown,
              screenToWorld, canvasCenter, mutate, patchNode,
            }}>
              <ReactFlow
                nodes={flowNodes}
                edges={[]}
                nodeTypes={canvasNodeTypes}
                viewport={flowViewport}
                onViewportChange={handleViewportChange}
                onPaneClick={handlePaneClick}
                minZoom={MIN_SCALE}
                maxZoom={MAX_SCALE}
                panOnDrag={tool === 'pan'}
                selectionOnDrag={false}
                elementsSelectable={false}
                nodesDraggable={false}
                nodesConnectable={false}
                // 空格是主路径；Ctrl 是快捷键表里「Ctrl/⌘ + Space」那条的第二枚键。
                // 必须显式列出 Ctrl：d3-zoom 默认拒绝带 ctrlKey 的拖拽（它把
                // Ctrl+拖当成捏合缩放），只有 panActivationKeyPressed 为真才放行。
                // 故意不收 Meta：在 macOS 上 ⌘ 已是「拖节点 = 移动并加减选」的
                // 修饰键，再当作平移激活键会让 ⌘+拖节点直接失效；而按住 ⌘ 再按
                // 空格本来就能平移，表里那个组合照旧成立。
                panActivationKeyCode={['Space', 'Control']}
                zoomOnDoubleClick={false}
                zoomOnPinch={false}
                deleteKeyCode={null}
                proOptions={{ hideAttribution: true }}
                colorMode="system"
              />
            </CanvasFlowProvider>
          </ReactFlowProvider>
        </div>
      ) : null}
      <div className={css.world} style={{ transform: `translate(${document?.viewport.x ?? 0}px, ${document?.viewport.y ?? 0}px) scale(${document?.viewport.k ?? 1})`, pointerEvents: 'none' }}>
        {/* 框必须在连线之前：`.world` 里按 DOM 顺序叠，框画在线之后会盖住线
            的中段，而连线恰恰是用户要看清「这张图接到了哪」的东西。 */}
        <GroupLayer
          groups={groups}
          nodeById={nodeById}
          activeGroupId={(() => {
            // 只在「选中的节点全部属于同一个组」时高亮。选中集合为空、或跨了
            // 两个组时不高亮任何一个：那种状态下用户做的是跨组的事（对比、
            // 一起删），把其中某个组点亮会误导成「当前动作只作用于它」。
            if (selectedIds.size === 0) return null
            let found: string | null = null
            for (const id of selectedIds) {
              const group = groupOfNode(groups, id)
              if (group === undefined) return null
              if (found === null) found = group.id
              else if (found !== group.id) return null
            }
            return found
          })()}
          onRename={beginGroupRename}
          onContextMenu={(groupId, screen) => setContextMenu({ type: 'group', screen, groupId })}
        />
        {groupRename === null ? null : (() => {
          // 输入框挂在 `.world` 里，所以直接用世界坐标：框给的就是世界坐标，
          // 不必再为「视图已经平移缩放过」做第二次换算。缩放由 `.world` 的
          // transform 一并带上，输入框跟着画布缩放——这是刻意的，它标的是画布
          // 上的一个对象，不是屏幕上的一个弹窗。
          const group = groupById.get(groupRename.groupId)
          const frame = group === undefined ? null : groupFrame(group, nodeById)
          // 组在这一瞬间被删掉/解散（撤销、别的窗口保存）时直接不画：
          // 画一个飘在原地的输入框比什么都不画更让人困惑。
          if (frame === null) return null
          return <input
            className={css.groupRenameInput}
            style={{ left: frame.x + 8, top: frame.y - 12, pointerEvents: 'auto' }}
            value={groupRename.value}
            autoFocus
            aria-label={tt('canvas.group.title')}
            onChange={event => setGroupRenameBoth({ groupId: groupRename.groupId, value: event.target.value })}
            // Enter 与 blur 都提交：用户改完名字最可能的两个动作就是回车和
            // 点别处，只认其中一个会让他在另一半情况下以为没生效。
            onBlur={commitGroupRename}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); commitGroupRename() }
              // Esc 是唯一「什么都不改」的出口，所以它必须绕开 blur 的提交。
              // 先把状态清掉再 let blur 走一遍：那时 groupRename 已是 null，
              // commitGroupRename 读到 null 会直接返回。
              else if (event.key === 'Escape') { event.preventDefault(); setGroupRenameBoth(null) }
            }}
          />
        })()}
        <div style={{ pointerEvents: 'auto' }}><ConnectionLayer
          connections={document?.connections ?? null}
          nodeById={nodeById}
          hidden={connectionsHidden}
          selectedConnectionId={selectedConnectionId}
          draft={connecting}
          skillRuns={skillRuns}
          onSelect={handleConnectionSelect}
          onContextMenu={(connectionId, screen) => setContextMenu({ type: 'connection', screen, connectionId })}
        /></div>
        {Object.entries(skillRuns).map(([taskId, trace]) => <div key={taskId} style={{ pointerEvents: 'auto' }}><SkillRunCard
          taskId={taskId}
          trace={trace}
          onCancel={taskId => { void cancelSkillRun(taskId) }}
          onDismiss={dismissSkillRun}
          onRetry={retrySkillRun}
        /></div>)}
        {renderAnnotationLinks()}
      </div>
      {marqueeRect !== null ? <div className={css.marquee} style={marqueeRect} aria-hidden="true" /> : null}
      {emptyState}
    </div>

    {composeIds.length >= 2 ? <div className={css.composeBar} data-compose-bar="" data-canvas-no-zoom="" aria-live="polite">
      <span className={css.composeBarIcon} aria-hidden="true">⛓</span>
      <span>{tt('canvas.composeBar', { count: composeIds.length })}</span>
      <span className={css.composeBarOrder}>{composeGlyphs(composeIds.length)}</span>
      <button
        type="button"
        className={css.composeBarRun}
        data-compose-bar-run=""
        disabled={composeSkill === null}
        title={composeSkill === null
          ? tt('canvas.composeUnavailable', { reason: composeUnavailableReason })
          : tt('canvas.composeStart', { count: composeIds.length })}
        onClick={startComposeFromBar}
      >{tt('canvas.composeStart', { count: composeIds.length })}</button>
    </div> : null}

    <div className={css.canvasChrome} data-canvas-no-zoom="">
      <div className={css.chromeSide}>
        {minimapOpen ? renderMinimap() : null}
        <div className={css.zoomDock}>
          <IconButton name="minimap" label={minimapOpen ? tt('canvas.minimapClose') : tt('canvas.minimapOpen')} active={minimapOpen} onClick={() => setMinimapOpen(previous => !previous)} />
          <IconButton name="fit" label={tt('canvas.fitView')} onClick={fitView} />
          {/* LibTV 式左下工具排：吸附与连线显隐从缩放菜单里铺平出来，
              状态一眼可见（aria-pressed + 高亮），不用先开菜单找。 */}
          <IconButton name="connections" label={tt('canvas.showConnections')} pressed={!connectionsHidden} active={!connectionsHidden} onClick={() => setConnectionsHidden(hidden => !hidden)} />
          <IconButton name="snap" label={tt('canvas.snapAlign')} pressed={snapEnabled} active={snapEnabled} onClick={() => { snapEnabledRef.current = !snapEnabledRef.current; setSnapEnabled(snapEnabledRef.current) }} />
          <button
            type="button"
            className={css.zoomValue}
            aria-haspopup="menu"
            aria-expanded={zoomMenuOpen}
            aria-label={tt('canvas.zoom')}
            onClick={() => setZoomMenuOpen(open => !open)}
          >{Math.round((document?.viewport.k ?? 1) * 100)}%</button>
          {zoomMenuOpen ? <div className={css.zoomMenu} role="menu" data-canvas-no-zoom="">
            <button type="button" role="menuitem" onClick={() => { setZoomAtCenter((document?.viewport.k ?? 1) * 1.25); setZoomMenuOpen(false) }}>{tt('canvas.zoomIn')}</button>
            <button type="button" role="menuitem" onClick={() => { setZoomAtCenter((document?.viewport.k ?? 1) * 0.8); setZoomMenuOpen(false) }}>{tt('canvas.zoomOut')}</button>
            <button type="button" role="menuitem" onClick={() => { fitView(); setZoomMenuOpen(false) }}>{tt('canvas.fitView')}</button>
            <span className={css.zoomMenuDivider} aria-hidden="true" />
            {[0.5, 1, 2, 4, 8].map(scale => (
              <button
                key={scale}
                type="button"
                role="menuitem"
                data-active={Math.abs((document?.viewport.k ?? 1) - scale) < 0.005 ? '' : undefined}
                onClick={() => { setZoomAtCenter(scale); setZoomMenuOpen(false) }}
              >{scale * 100}%</button>
            ))}
            <span className={css.zoomMenuDivider} aria-hidden="true" />
            <form
              className={css.zoomCustom}
              onSubmit={event => {
                event.preventDefault()
                const value = Number(new FormData(event.currentTarget).get('zoom'))
                if (Number.isFinite(value) && value > 0) { setZoomAtCenter(value / 100); setZoomMenuOpen(false) }
              }}
            >
              <input name="zoom" type="number" min={5} max={800} defaultValue={Math.round((document?.viewport.k ?? 1) * 100)} aria-label={tt('canvas.zoomCustom')} />
              <button type="submit">%</button>
            </form>
          </div> : null}
        </div>
      </div>
      <div className={css.dockOuter} ref={dockOuterRef}>
        <div className={`${css.dock} ${cursorClass}`} ref={dockRef} data-canvas-no-zoom="" role="toolbar">
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.toolSelect')}>
          <IconButton name="select" size={18} label={tt('canvas.toolSelect')} active={tool === 'select'} onClick={() => setTool('select')} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.toolPan')}>
          <IconButton name="pan" size={18} label={tt('canvas.toolPan')} active={tool === 'pan'} onClick={() => setTool('pan')} />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addImage')}>
          <IconButton
            name="image"
            size={18}
            label={tt('canvas.addImage')}
            active={imageMenu !== null}
            onClick={event => openDockMenu('image', event.currentTarget)}
            onMouseEnter={event => openDockMenu('image', event.currentTarget)}
            onMouseLeave={scheduleMenuClose}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addText')}>
          <IconButton name="text" size={18} label={tt('canvas.addText')} onClick={() => placeNewNode(createTextNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addSketch')}>
          <IconButton name="sketch" size={18} label={tt('canvas.addSketch')} onClick={() => placeNewNode(createSketchNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.skills.addFileNode')}>
          <IconButton
            name="file"
            size={18}
            label={tt('canvas.skills.addFileNode')}
            onClick={() => { setFileTargetNodeId(null); fileUploadRef.current?.click() }}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addConfigNode')}>
          <IconButton name="sparkle" size={18} label={tt('canvas.addConfigNode')} onClick={() => placeNewNode(createConfigNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.storyboardNode')}>
          <IconButton name="layers" size={18} label={tt('canvas.storyboardNode')} onClick={() => placeNewNode(createStoryboardNode())} />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.templateLibrary')}>
          <IconButton name="template" size={18} label={tt('canvas.templateLibrary')} active={libraryOpen} onClick={() => setLibraryOpen(previous => !previous)} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.skills.libraryButton')}>
          <IconButton
            name="skill"
            size={18}
            label={tt('canvas.skills.libraryButton')}
            active={skillLibraryOpen}
            onClick={() => { if (skillLibraryOpen) setSkillLibraryOpen(false); else openSkillLibrary() }}
          />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.workflow.run')}>
          {/* 运行是主动作，不能被「怎么跑」的选项挡住。三项默认值就是升级前
              写死的行为，所以直接跑与旧版完全一致；想看选项的人点旁边那个
              箭头。把运行塞进菜单会让常用路径每次都多点一下，换来的只是
              「先看见复用是开着的」——而默认值已经保证了这一点。 */}
          <IconButton
            name="workflow"
            size={18}
            label={tt('canvas.workflow.run')}
            active={workflowBusy}
            disabled={document === null || document.nodes.length === 0}
            onClick={() => { void runWorkflowFrom([...selectedIds]) }}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.workflow.options')}>
          <IconButton
            name="chevronDown"
            size={14}
            label={tt('canvas.workflow.options')}
            active={workflowMenu !== null}
            disabled={document === null || document.nodes.length === 0}
            onClick={event => {
              clearMenuCloseTimer()
              // 再点一次收起。此前这里无条件 set，等于「点了没反应」——
              // 菜单开着时唯一的收起办法是点里面的「运行工作流」，而那一次
              // 运行是要真花钱的，等于用一个付费动作当关闭按钮。
              if (workflowMenu !== null) { setWorkflowMenu(null); return }
              const bounds = event.currentTarget.getBoundingClientRect()
              const rootRect = rootRef.current?.getBoundingClientRect()
              setWorkflowMenu({ x: bounds.left + bounds.width / 2 - (rootRect?.left ?? 0), y: bounds.top - (rootRect?.top ?? 0) })
            }}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('timeline.open')}>
          <IconButton
            name="timeline"
            size={18}
            label={tt('timeline.open')}
            active={timelineOpen}
            disabled={document === null}
            onClick={openTimeline}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.background')}>
          <IconButton
            name="background"
            size={18}
            label={tt('canvas.background')}
            active={backgroundMenu !== null}
            onClick={event => openDockMenu('background', event.currentTarget)}
            onMouseEnter={event => openDockMenu('background', event.currentTarget)}
            onMouseLeave={scheduleMenuClose}
          />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.shortcuts.button')}>
          <IconButton name="help" size={18} label={tt('canvas.shortcuts.button')} active={shortcutHelpOpen} onClick={() => setShortcutHelpOpen(open => !open)} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.undo')}>
          <IconButton name="undo" size={18} label={labelWithKeys('canvas.undo')} disabled={pastRef.current.length === 0} onClick={undo} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.redo')}>
          <IconButton name="redo" size={18} label={labelWithKeys('canvas.redo')} disabled={futureRef.current.length === 0} onClick={redo} />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.delete')}>
          <IconButton name="trash" size={18} label={labelWithKeys('canvas.delete')} disabled={selectedIds.size === 0 && selectedConnectionId === null} onClick={deleteSelection} />
        </div>
      </div>
    </div>
    </div>

    {imageMenu !== null ? <ImageDockMenu
      anchor={imageMenu}
      onEnter={clearMenuCloseTimer}
      onLeave={scheduleMenuClose}
      onUpload={() => { imageFileRef.current?.click(); setImageMenu(null) }}
      onOpenGallery={() => { setPickerTab('gallery'); setPickerOpen(true); setImageMenu(null) }}
      onOpenHistory={() => { setPickerTab('history'); setPickerOpen(true); setImageMenu(null) }}
      onOpenGenerate={() => { setPickerTab('generate'); setPickerOpen(true); setImageMenu(null) }}
      onAddVideo={() => { setPickerOpen(false); setImageMenu(null); setVideoPickerOpen(true) }}
    /> : null}
    <input
      ref={imageFileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      hidden
      onChange={event => {
        const files = [...(event.target.files ?? [])].filter(file => file.type.startsWith('image/'))
        event.target.value = ''
        if (files.length === 0) return
        const world = canvasCenter()
        void Promise.all(files.map(async file => {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tt('image.readFailed'))); reader.readAsDataURL(file) })
          const dimensions = await readImageSize(dataUrl)
          return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
        })).then(assets => {
          const current = documentRef.current
          const selectedId = selectedIdsRef.current.size === 1 ? [...selectedIdsRef.current][0] : undefined
          const selectedNode = current?.nodes.find(node => node.id === selectedId)
          if (selectedNode?.type === 'image' && usableAsset(selectedNode) === undefined && assets[0] !== undefined) {
            mutate(previous => ({ ...previous, nodes: previous.nodes.map(node => node.id === selectedNode.id ? { ...node, width: sizeForAsset(assets[0]!).width, height: sizeForAsset(assets[0]!).height, metadata: { ...nodeMetadata(node), asset: assets[0], status: 'success' as const, error: undefined } } : node) }))
            if (assets.length > 1) addAssets(assets.slice(1), world)
          } else addAssets(assets, world)
        }).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
      }}
    />
    <input
      ref={fileUploadRef}
      type="file"
      hidden
      onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file !== undefined) void uploadCanvasFile(file, fileTargetNodeId)
        setFileTargetNodeId(null)
      }}
    />
    {skillMenu !== null ? (() => {
      const target = nodeById.get(skillMenu.nodeId)
      return target === undefined ? null : <SkillPicker
        anchor={skillMenu.screen}
        nodeType={target.type}
        targetTitle={target.title ?? ''}
        catalog={skillCatalog}
        loading={skillCatalogLoading}
        batchCount={skillBatchCount(target.id)}
        composeCount={composeIds.length}
        installed={skillCatalog === null ? undefined : new Set(skillCatalog.installed)}
        onPick={skill => pickSkill(skill, target)}
        onInstall={skill => {
          setSkillMenu(null)
          openSkillLibrary(skill.installUrl ?? '')
        }}
        onConfigure={skill => {
          setSkillMenu(null)
          openSkillConfig(skill.id.startsWith('skill:') ? skill.id.slice('skill:'.length) : (skill.skillName ?? skill.name))
        }}
        onClose={() => setSkillMenu(null)}
        container={overlayHostRef.current}
      />
    })() : null}
    {pendingSkill !== null ? <SkillConfirmDialog
      skill={pendingSkill.skill}
      // Only a stitch shows the order: it is the one run whose result depends
      // on the sequence of its inputs, and this card is the user's last chance
      // to see that sequence before ffmpeg commits to it.
      {...pendingSkill.skill.id === COMPOSE_SKILL_ID ? { composeIds: pendingSkill.nodeIds } : {}}
      onConfirm={instruction => {
        const pending = pendingSkill
        setPendingSkill(null)
        void startSkillRun(pending.skill, pending.nodeIds, instruction)
      }}
      onClose={() => setPendingSkill(null)}
      container={overlayHostRef.current}
    /> : null}
    {polishNode !== null ? <PolishMenu
      anchor={polishNode.screen}
      batchCount={(document?.nodes ?? []).filter(node => node.type === 'text' && selectedIds.has(node.id)).length || 1}
      busy={polishBusy !== null}
      onPick={(style, instruction) => runPolish(polishNode.nodeId, style, instruction)}
      onClose={() => setPolishNode(null)}
      container={overlayHostRef.current}
    /> : null}
    {backgroundMenu !== null ? <BackgroundDockMenu
      anchor={backgroundMenu}
      mode={backgroundMode}
      hasBackgroundImage={Boolean(document?.backgroundImage)}
      onEnter={clearMenuCloseTimer}
      onLeave={scheduleMenuClose}
      onPickMode={mode => setBackgroundMode(mode)}
      onUpload={() => { backgroundFileRef.current?.click() }}
      onRemoveImage={removeBackgroundImage}
    /> : null}
    {/* 背景图上传用：菜单只发「用户点了上传」的信号，输入框留在画布这里。
        与图片上传那个同理——同一份 ref 还被别处（菜单外）触发。 */}
    <input
      ref={backgroundFileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={event => {
        const file = event.target.files?.[0]
        if (file !== undefined) void uploadBackgroundImage(file)
        event.target.value = ''
      }}
    />

    {nodeAddMenu !== null ? <NodeAddMenu
      anchor={nodeAddMenu.screen}
      sourceNodeType={nodeAddMenu.nodeType}
      onEnter={clearNodeAddMenuTimer}
      onLeave={scheduleNodeAddMenuClose}
      onAdd={kind => {
        addConnectedNode(nodeAddMenu.nodeId, position => kind === 'text' ? createTextNode(position)
          : kind === 'sketch' ? createSketchNode(position)
            : kind === 'storyboard' ? createStoryboardNode(position)
              : kind === 'config' ? createConfigNode(position)
                : createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }, position))
        setNodeAddMenu(null)
      }}
    /> : null}

    {renderComposer()}
    {renderContextMenu()}
    {filePreviewNode !== undefined ? <CanvasFileOverlay
      api={api}
      asset={filePreviewNode.asset}
      fileKind={fileKindOfAsset(filePreviewNode.asset)}
      title={filePreviewNode.node.title}
      onClose={() => setFilePreviewNodeId(null)}
    /> : null}
    {videoPreviewNode !== undefined ? <CanvasVideoPreviewOverlay
      preview={videoPreviewNode}
      onClose={() => { setVideoPreviewNodeId(null) }}
      onClipBroken={nodeId => setBrokenVideoIds(previous => previous.has(nodeId) ? previous : new Set(previous).add(nodeId))}
    /> : null}
    {libraryOpen ? <TemplateLibrary api={api} container={overlayHostRef.current} onClose={() => setLibraryOpen(false)} onUse={prompt => { applyTemplate(prompt); setLibraryOpen(false) }} /> : null}
    {skillLibraryOpen ? <SkillLibraryDialog
      library={skillLibrary}
      loading={libraryLoading}
      busy={libraryBusy}
      presetUrl={libraryPresetUrl}
      focusSkill={libraryFocusSkill}
      onReload={() => { void loadSkillLibrary() }}
      onInstallUrls={(sources, force) => { void installSkillUrls(sources, force) }}
      onInstallArchive={(file, force) => { void installSkillArchive(file, force) }}
      onRemove={name => { void removeSkillEntry(name) }}
      onSaveConfig={saveSkillValues}
      onApplyConfig={applySkillValues}
      onClose={() => { setSkillLibraryOpen(false); setLibraryFocusSkill('') }}
      container={overlayHostRef.current}
    /> : null}

    {error !== null ? <CanvasErrorToast
      error={error}
      action={errorAction}
      onDismiss={() => { setError(null); setErrorAction(null) }}
    /> : null}
    {notice !== null ? <CanvasNoticeToast notice={notice} onDismiss={() => setNotice(null)} /> : null}
    {workflowMenu !== null ? <WorkflowOptionsMenu
      anchor={workflowMenu}
      reuse={workflowReuse}
      rerunSelected={workflowRerunSelected}
      parallel={workflowParallel}
      selectionCount={selectedIds.size}
      onEnter={clearMenuCloseTimer}
      onLeave={scheduleMenuClose}
      onToggleReuse={() => setWorkflowReuse(value => !value)}
      onToggleRerun={() => setWorkflowRerunSelected(value => !value)}
      onToggleParallel={() => setWorkflowParallel(value => !value)}
      onRun={() => { setWorkflowMenu(null); void runWorkflowFrom([...selectedIds]) }}
    /> : null}
    {workflowProgress !== null ? <CanvasWorkflowProgressBar progress={workflowProgress} onCancel={cancelWorkflow} /> : null}
    {/* 时间线：排序/裁剪/转场都在这里改，提交时把整条时间线交给既有拼接链路。 */}
    {timelineOpen ? <TimelinePanel
      clips={timelineClips}
      busy={timelineBusy}
      onCancel={() => setTimelineOpen(false)}
      onSubmit={submitTimeline}
    /> : null}
    {/* 身份锚定：给一张图起名字、定角色，钉住它。 */}
    {castTarget !== null && castNode !== undefined ? <CastDialog
      title={castNode.title}
      current={castNode.metadata?.cast}
      onCancel={() => setCastTarget(null)}
      onSave={member => {
        patchNode(castNode.id, { cast: member })
        setNotice(member === undefined
          ? tt('canvas.cast.unpinned')
          : tt('canvas.cast.pinned', {
              role: tt(ROLE_LABELS[member.role]),
              name: (member.name ?? '').trim() !== '' ? member.name! : castNode.title,
            }))
        setCastTarget(null)
      }}
    /> : null}

    {posterTarget !== null && document?.id === posterTarget.canvasId ? (() => {
      const source = document.nodes.find(node => node.id === posterTarget.nodeId)
      const asset = source === undefined ? undefined : usableAsset(source)
      if (source === undefined || asset === undefined) return null
      return <PosterEditor
        api={api}
        asset={asset}
        recipe={nodeMetadata(source).poster}
        onClose={() => setPosterTarget(null)}
        onSave={async (poster, dataUrl) => {
          const canvasId = posterTarget.canvasId
          const uploaded = await api.canvasUpload(dataUrl, poster.width, poster.height, { origin: 'upload', originId: `poster-${source.id}` })
          // The upload is async, so the user may have switched canvases or
          // deleted the source node while it ran. Adding the result anyway would
          // attach a poster to a node that no longer exists.
          if (documentRef.current?.id !== canvasId || !documentRef.current.nodes.some(node => node.id === source.id)) throw new Error(tt('poster.sourceChanged'))
          const resultId = newId('node')
          const dimensions = sizeForAsset(uploaded)
          const result: CanvasNode = {
            id: resultId, type: 'image', title: tt('poster.resultTitle'),
            x: source.x + source.width + NODE_GAP, y: source.y,
            ...dimensions,
            metadata: { asset: uploaded, status: 'success', sourceNodeId: source.id, poster },
          }
          mutate(previous => ({ ...previous, nodes: [...previous.nodes, result], connections: [...previous.connections, { id: newId('edge'), fromNodeId: source.id, toNodeId: resultId }] }))
          setSelectedIds(new Set([resultId]))
          setNotice(tt('poster.saved'))
        }}
      />
    })() : null}

    {pickerOpen ? <ImagePicker
      api={api}
      history={history}
      gallery={gallery}
      modelGroups={modelGroups}
      defaultChannelId={defaultChannelId}
      canvasId={document?.id ?? ''}
      connected={connected}
      connectedChannelIds={connectedChannelIds}
      initialTab={pickerTab}
      onClose={() => setPickerOpen(false)}
      onAssets={assets => { addAssets(assets); setPickerOpen(false) }}
      onError={setError}
      onTask={task => {
        if (document === null) return
        const center = canvasCenter()
        const size = nodeSizeFromRatio(task.request.size, IMAGE_NODE_SIZE)
        const node: CanvasNode = {
          id: newId('node'), type: 'image', title: tt('canvas.imageNode'),
          x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2),
          width: size.width, height: size.height,
          metadata: { status: 'generating', prompt: task.request.prompt, model: task.request.model, ...(task.request.channelId === undefined ? {} : { channelId: task.request.channelId }), size: task.request.size, quality: task.request.quality, taskId: task.id, sourceNodeId: task.request.canvas?.sourceNodeId },
        }
        placeNewNode(node)
        setPickerOpen(false)
      }}
    /> : null}
    {videoPickerOpen ? <CanvasVideoPicker
      api={api}
      gallery={gallery}
      onClose={() => setVideoPickerOpen(false)}
      onAddClip={clip => { addClipNode(clip) }}
      onAddAsset={asset => { placeNewNode(createFileNode(asset)); setVideoPickerOpen(false) }}
    /> : null}
    {shortcutHelpOpen ? <ShortcutHelp onClose={() => setShortcutHelpOpen(false)} /> : null}
  </section>
}


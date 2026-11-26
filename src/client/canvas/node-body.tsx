/**
 * 画布节点的内容体：一个节点里除了外壳以外的全部东西。
 *
 * 从 CanvasWorkspace.tsx 的 `renderNodeBody` 原样搬出（379 行）。它只接 props
 * （节点本身、画布状态快照 `S`、动作集合 `A`），不读组件状态、不发请求——
 * 与 `run-card.tsx`、`storyboard-board.tsx` 同一约定。
 *
 * WHY 值得搬：这段 JSX 有 8 种形态（图片/视频/文件/文本/config/草图/分镜/
 * 标注卡）× 各自的状态（空/生成中/出错/有内容），挤在 5796 行的组件里既读不出
 * 全貌，也没法单独推敲。
 *
 * 搬动时按形态就地拆成了小部件（见文件下半部分）：外层的 `NodeBody` 只负责算
 * 公共的派生状态和画公共件（徽标、页脚、缩放角、连接桩、悬停工具条），各形态
 * 的正文交给 `ImageBody` / `VideoBody` / `FileBody` / `TextBody` / ... 这些只吃
 * 自己需要的几项的函数。
 *
 * ⚠️ 一个必须知道的坑：原函数里的 `document?.nodes` 指的是**画布文档**，不是
 * DOM 的 `document`。搬出组件后裸写 `document` 会解析成 DOM document，类型上
 * 通不过，但若某处用了 `document?.connections` 之类就可能静默变成 undefined。
 * 所以这里统一叫 `S.canvasDocument`。
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { X } from 'lucide-react'
import type { CanvasAssetRef, CanvasDocument, CanvasLayerKind, CanvasNode, CanvasPoseRig, CanvasPromptSetItem, CanvasRect, CanvasSketchStroke } from '../../protocol.ts'
import type { ImageGenApi } from '../api.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import type { ImageModelGroup } from '../settings-scope.ts'
import { CanvasFileBody, fileKindLabel, fileKindOfAsset, fileSizeLabel } from '../CanvasFilePreview.tsx'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from '../ModelPicker.tsx'
import { IconButton, ToolbarIcon } from './dock-controls.tsx'
import { ROLE_LABELS } from '../cast.ts'
import { isAnnotationCard, isPoseNode, isSketchNode, liveAnnotations, nodeMetadata, textStyleOf, usableAsset, videoOf, bezierPath as _bezierPath } from './node-model.ts'
import { isLocked } from './node-flags.ts'
import { promptSetOf } from './prompt-set.ts'
import { storyboardOf, storyboardProgress } from '../storyboard.ts'
import { SketchBoard } from './sketch-and-picker.tsx'
import { PoseBoard, poseOf } from './pose-board.tsx'
import { StoryboardBody } from './storyboard-board.tsx'
import type { Point } from './geometry.ts'
import { configReadiness } from './readiness.ts'
import { markOf, type RunMarks } from './run-marks.ts'
import css from '../canvas-workspace.module.css'

/** 缩放角的四个方向。 */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

/** 重叠提示：谁被谁盖住了。`coveredId` 决定徽标挂在哪个节点上。 */
export interface LiveOverlap {
  /** 这一对涉及的两个节点 id。 */
  ids: Set<string>
  /** 被完全盖住的那一方。 */
  coveredId: string
  /** 盖住人的那个节点的标题，用于徽标文案。 */
  coverTitle: string
}

/** 拖拽连线中的临时状态（与 CanvasWorkspace 里那份 `ConnectState` 同形）。 */
export interface ConnectDraft {
  nodeId: string
  targetId: string | null
}

/** 一次技能运行，只要这两项就够了：判「这个节点在跑」和取运行 id。 */
export interface NodeSkillRun {
  nodeId: string
  status: string
}

/**
 * 画布状态的只读快照。搬过来的 JSX 直接引用这些名字，所以保持原样命名
 * （`document` 除外，见文件头说明）。
 */
export interface NodeBodyState {
  canvasDocument: CanvasDocument | null
  selectedIds: ReadonlySet<string>
  relatedIds: ReadonlySet<string>
  connecting: ConnectDraft | null
  liveOverlap: LiveOverlap | null
  skillRuns: Readonly<Record<string, NodeSkillRun>>
  composeIds: readonly string[]
  annotateNodeId: string | null
  busyNodes: Readonly<Record<string, string>>
  annotationDraft: { nodeId: string; rect: CanvasRect } | null
  annotationDragRef: { current: unknown }
  colorPickerNodeId: string | null
  brokenVideoIds: ReadonlySet<string>
  polishBusy: string | null
  api: ImageGenApi
  modelGroups: ImageModelGroup[]
  videoGroups: ImageModelGroup[] | undefined
  defaultChannelId: string | undefined
  /**
   * The video model the composer resolved as "the one a run would use".
   *
   * A storyboard that names no model of its own submits with this same
   * resolution. Passing it down is what lets the board show the effective
   * model and offer only the lengths and tiers it accepts; without it the
   * board is guessing at a model it cannot see.
   */
  effectiveVideoModel: string
  /** The composer's video channel; paired with `effectiveVideoModel`. */
  effectiveVideoChannelId: string
  fileUploadRef: { current: HTMLInputElement | null }
  imageFileRef: { current: HTMLInputElement | null }
  connectRef: { current: unknown }
  // 子组件与常量（原来是主文件的 import）
  IconButton: typeof IconButton
  ToolbarIcon: typeof ToolbarIcon
  /**
   * 「标题 + 键位」。节点工具条上的按钮要给键位，但键位属于快捷键表，不能
   * 写进文案——写死的 `(Ctrl+D)` 在 macOS 上是错的，而且它与那张表会走散。
   */
  labelWithKeys: (key: ImageGenKey) => string
  ModelPicker: typeof ModelPicker
  SketchBoard: typeof SketchBoard
  PoseBoard: typeof PoseBoard
  StoryboardBody: typeof StoryboardBody
  CanvasFileBody: typeof CanvasFileBody
  ROLE_LABELS: typeof ROLE_LABELS
  TEXT_COLORS: readonly string[]
  // 纯函数
  nodeMetadata: typeof nodeMetadata
  assetOf: (node: CanvasNode) => CanvasAssetRef | undefined
  usableAsset: typeof usableAsset
  videoOf: typeof videoOf
  isSketchNode: typeof isSketchNode
  isPoseNode: typeof isPoseNode
  poseOf: typeof poseOf
  isAnnotationCard: typeof isAnnotationCard
  layerKindLabel: (kind: CanvasLayerKind) => string
  liveAnnotations: typeof liveAnnotations
  fileKindOfAsset: typeof fileKindOfAsset
  fileKindLabel: typeof fileKindLabel
  fileSizeLabel: typeof fileSizeLabel
  storyboardOf: typeof storyboardOf
  storyboardProgress: typeof storyboardProgress
  resolveModelChoice: (groups: ImageModelGroup[], choice: { channelId?: string; model?: string }, fallback?: string) => ModelPickerValue
  textStyleOf: typeof textStyleOf
  /** 某个渠道是否已配置好密钥。配置节点的就绪徽标要靠它说话。 */
  channelIsConnected: (channelId: string) => boolean
  /**
   * 悬浮生成器里正在编辑的提示词。
   *
   * 配置节点卡片上那块只读预览与就绪徽标都读它——**同一份值**，因为提交路径
   * 也只读它。卡片显示的与按下去发出去的必须是同一句话。
   */
  composerPrompt: string
  /** 生成器里正在编辑的套图草稿；只对选中的那张卡有意义。 */
  composerPromptSet: readonly CanvasPromptSetItem[]
  /**
   * 最近一次工作流运行在这个节点上留下的处境：失败 / 被上游跳过。
   *
   * 只活在组件状态里（见 `run-marks.ts`），不进文档；所以导出画布不会带走
   * 它，换一台机器打开也不会有。
   */
  runMarks: RunMarks
}

/** 节点体里会触发的动作，全部由上层提供。 */
export interface NodeBodyActions {
  patchNode: (nodeId: string, patch: Record<string, unknown>) => void
  /** 单张卡的锁定开关。锁定之后拖不动、改不了大小、删不掉。 */
  setNodeLocked: (nodeId: string, locked: boolean) => void
  /** 单张卡的隐藏开关。隐藏只是「暂时别看」，卡片仍在文档里。 */
  setNodeHidden: (nodeId: string, hidden: boolean) => void
  deleteNode: (nodeId: string) => void
  duplicateNode: (nodeId: string) => void
  downloadNode: (node: CanvasNode) => void
  downloadFileNode: (node: CanvasNode) => void
  downloadVideoNode: (node: CanvasNode) => void
  openImageNode: (node: CanvasNode) => void
  openFileNode: (node: CanvasNode) => void
  openSkillMenu: (node: CanvasNode, anchor: Point) => void
  openNodeAddMenu: (node: CanvasNode) => void
  scheduleNodeAddMenuClose: () => void
  handleConnectStart: (event: ReactPointerEvent<HTMLDivElement>, nodeId: string, handleType: 'source' | 'target') => void
  handleResizeStart: (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: ResizeCorner) => void
  beginAnnotationDrag: (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => void
  moveAnnotationDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
  endAnnotationDrag: (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => void
  toggleAnnotate: (node: CanvasNode) => void
  removeNodeBackground: (node: CanvasNode) => void
  splitLayers: (node: CanvasNode) => void
  retryGeneration: (node: CanvasNode) => void
  retryVideoGeneration: (node: CanvasNode) => void
  grabVideoFrame: (node: CanvasNode) => void
  continueFromClip: (node: CanvasNode) => void
  favoriteVideoNode: (node: CanvasNode) => void
  runStoryboard: (node: CanvasNode) => void
  submitShot: (node: CanvasNode, index: number) => void
  startStoryboardStitch: (ids: string[]) => void
  /**
   * 打开「写回文档」卡片。
   *
   * 只对有 `storyboard.source` 的板有意义；`StoryboardBody` 用这件事判断
   * 要不要画出那个按钮。
   */
  openStoryboardWriteback: (node: CanvasNode) => void
  clearBrokenVideo: (nodeId: string) => void
  patchSketchStrokes: (nodeId: string, strokes: CanvasSketchStroke[]) => void
  patchSketchAsset: (nodeId: string, asset: CanvasAssetRef | undefined) => void
  /** 卡片预设条改第一个角色的姿势：必须写进 `stage`，只写 `pose` 会被读取路径忽略。 */
  patchStageRig: (nodeId: string, rig: CanvasPoseRig) => void
  /** 打开该节点的全屏导演台。父组件负责选中与挂载面板。 */
  openStage: (nodeId: string) => void
  /** 画布的错误横幅：节点体自己弹不了提示，所有失败都往这里报。 */
  reportError: (message: string) => void
  setColorPickerNodeId: (nodeId: string | null) => void
  setVideoPreviewNodeId: (nodeId: string | null) => void
  setFilePreviewNodeId: (nodeId: string | null) => void
  setFileTargetNodeId: (nodeId: string | null) => void
  setPosterTarget: (target: { canvasId: string; nodeId: string }) => void
  setPolishNode: (target: { screen: Point; nodeId: string } | null) => void
  setBrokenVideoIds: (update: (previous: Set<string>) => Set<string>) => void
  setAnnotationDraft: (draft: { nodeId: string; rect: CanvasRect } | null) => void
}

/**
 * 一个节点的内容体。
 *
 * `S` 与 `A` 分开传而不是摊平成几十个 props：两者都是**稳定引用**（上层用
 * `useMemo`/对象字面量持有），摊平会让每次渲染都重建一遍这些箭头函数。
 */
export function NodeBody(props: { node: CanvasNode; S: NodeBodyState; A: NodeBodyActions }): React.JSX.Element {
  const { node, S, A } = props
const metadata = S.nodeMetadata(node)
const isSelected = S.selectedIds.has(node.id)
const isRelated = S.relatedIds.has(node.id)
const asset = S.assetOf(node)
// Image and video nodes both run asynchronously, so both have a generating
// and an error state. Keeping these image-only was a real bug, not a
// style slip: a video placeholder fell through to the "no clip yet" branch
// and painted 生成失败 on its first frame while it was still rendering.
const isGenerating = (node.type === 'image' || node.type === 'video') && metadata.status === 'generating'
const isError = (node.type === 'image' || node.type === 'video') && metadata.status === 'error'
const isConnectTarget = S.connecting?.targetId === node.id
/*
 * 重叠徽标**不在这里**画。它原来挂在被盖住卡片的右下角，而这恰好是它最不能
 * 待的地方：它要说明的正是「这张卡看不见」，却和那张卡一起被压在下面。以前
 * 只是因为 react-flow 会给选中的节点加 `z-index: 1000`，用户一拖（拖动会选中
 * 它）徽标才碰巧浮上来；关掉选中提权之后它彻底消失，截图里只剩一圈黄边。
 * 现在它由 `CanvasWorkspace` 画在 `.world` 覆盖层上（见那边的注释）。
 */
const hasImage = asset !== undefined && asset.url !== ''
const isConfig = node.type === 'config'
const isFile = node.type === 'file'
const isVideo = node.type === 'video'
const isStoryboard = node.type === 'storyboard'
const video = S.videoOf(node)
const hasVideo = video !== undefined && video.url !== ''
const isSketch = S.isSketchNode(node)
const isPose = S.isPoseNode(node)
const fileKind = isFile ? (metadata.fileKind ?? S.fileKindOfAsset(asset ?? { assetId: '', url: '', mime: 'application/octet-stream', bytes: 0, width: 0, height: 0, origin: 'upload' })) : 'other'
const hasFile = isFile && asset !== undefined && asset.url !== ''
/** Only config nodes are excluded: every content node can feed a skill. */
const skillable = !isConfig
const skillRun = Object.entries(S.skillRuns).find(([, entry]) => entry.nodeId === node.id)
/**
 * Compose order badge. Only while this canvas really offers a stitch (two
 * or more selected clips): a lone number on one clip would claim an order
 * that has no second segment to be relative to. The digit is the index in
 * `S.composeIds` — the very same canvas-ordered list that becomes
 * `request.nodeIds` — so a numbered node is a node the file will carry.
 */
const composeIndex = S.composeIds.length >= 2 ? S.composeIds.indexOf(node.id) : -1
/**
 * 这个节点在最近一次运行里的处境。
 *
 * 与 `nodeOverlap` 那类「此刻的交互状态」不同，它是**上一次结论**留下的痕迹：
 * 交互状态消失了就等于没问题，而这个必须一直挂着，直到用户真的处理掉它。
 */
const runMark = markOf(S.runMarks, node.id)
const isTextual = node.type === 'text' || isConfig
const isTextNode = node.type === 'text'
/**
 * 连进这个配置节点的上游节点。
 *
 * 之前这里只数了个数。现在要把「上游文本」和「上游图片」分开看：前者决定
 * 提示词从哪来，后者决定这次是文生图还是图生图。数一遍再回头按 id 找节点的
 * 写法有两个真相来源，所以这里直接拿节点。
 */
const configUpstream: CanvasNode[] = !isConfig
  ? []
  : (S.canvasDocument?.connections ?? [])
      .filter(connection => connection.toNodeId === node.id)
      .map(connection => S.canvasDocument?.nodes.find(candidate => candidate.id === connection.fromNodeId))
      .filter((candidate): candidate is CanvasNode => candidate !== undefined)
const configInputCount = configUpstream.length
/**
 * 卡片上「套图 · N 条」的读数。
 *
 * 当前这张卡被选中时读**草稿**（用户正在编辑器里加条目、还没提交），否则读
 * 节点上已保存的那份。只读文档会让徽标在编辑期间一直显示旧数字，用户加完三条
 * 抬头一看还是「2 条」，会以为没加上。
 */
const promptSetCount = promptSetOf(node).length
const draftPromptSetCount = S.selectedIds.has(node.id)
  ? S.composerPromptSet.filter(item => item.prompt.trim() !== '').length
  : 0
const promptSetBadgeCount = S.selectedIds.has(node.id) ? draftPromptSetCount : promptSetCount
/**
 * 「这张卡片现在能不能跑」。
 *
 * 只在配置节点上算。判定逻辑在 `readiness.ts`，与提交路径读同一组事实
 * （自己的提示词优先、否则用上游文本；code 渲染不需要模型和渠道），所以卡片
 * 上说什么，按下去就真会发生什么。
 */
const configReady = isConfig
  ? configReadiness({
      ownText: metadata.text ?? '',
      // 悬浮生成器只在「这一张配置节点被选中」时存在；它才是提交路径读的那
      // 个值。不传它的话，卡片会对着一个空框说「缺提示词」，而用户刚刚在下面
      // 的生成器里写完。
      composerText: S.selectedIds.has(node.id) ? S.composerPrompt : '',
      upstreamTexts: configUpstream
        .filter(candidate => candidate.type === 'text' && !S.isAnnotationCard(candidate))
        .map(candidate => S.nodeMetadata(candidate).text ?? ''),
      model: metadata.renderer === 'code'
        ? ''
        : S.resolveModelChoice(S.modelGroups, { channelId: metadata.channelId, model: metadata.model }, S.defaultChannelId).model,
      channelConnected: metadata.renderer === 'code'
        ? true
        : S.channelIsConnected(metadata.channelId ?? ''),
      codeRenderer: metadata.renderer === 'code',
      referenceCount: configUpstream.filter(candidate => candidate.type === 'image' && S.usableAsset(candidate) !== undefined).length,
    })
  : null
const annotating = S.annotateNodeId === node.id && hasImage && !isSketch && !isPose
const busyLabel = S.busyNodes[node.id]
const annotations = node.type === 'image' ? S.liveAnnotations(node, S.canvasDocument?.nodes ?? []) : []
const draftRect = S.annotationDraft !== null && S.annotationDraft.nodeId === node.id ? S.annotationDraft.rect : null
const boxStyle = (rect: CanvasRect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
})
return <>
  <div className={css.nodeGlow} aria-hidden="true" />
  {composeIndex >= 0
    ? <span className={css.composeBadge} data-compose-badge={String(composeIndex + 1)} aria-hidden="true">
        {tt('canvas.composeBadge', { index: composeIndex + 1 })}
      </span>
    : null}
  {/* 上一次运行的处境。挂在这里而不是塞进各形态的正文里：正文有八种，
      每种都要重新记得加一遍；而这条标记跟「这个节点是什么形态」无关。

      文案分两句而不是一句：失败要「重试这个」，被跳过要「先修上游」——
      两个完全不同的动作。用同一个「出错」会把它们混成一个。 */}
  {runMark !== null
    ? <span
        className={css.runMark}
        data-run-mark={runMark}
        role="status"
        title={runMark === 'failed' ? tt('canvas.runMark.failedHint') : tt('canvas.runMark.blockedHint')}
      >
        {runMark === 'failed' ? tt('canvas.runMark.failed') : tt('canvas.runMark.blocked')}
      </span>
    : null}
  {isVideo ? <header className={css.nodeHeader}>
    <span className={css.nodeTitle}>{node.title}</span>
    {metadata.videoMode !== undefined ? <span className={css.nodeTag}>{tt(`video.mode.${metadata.videoMode}` as ImageGenKey)}</span> : null}
  </header> : null}
  {node.type === 'image' && metadata.cast !== undefined ? <span className={css.castBadge} data-cast-badge="">
    {tt('canvas.cast.badge', {
      role: tt(S.ROLE_LABELS[metadata.cast.role]),
      name: (metadata.cast.name ?? '').trim() !== '' ? metadata.cast.name! : node.title,
    })}
  </span> : null}
  {/* 锁定标记。WHY 画在卡片上而不是只在悬停条里：锁的意义是「你以为能拖，其实
      拖不动」，而用户伸手去拖的时候卡片通常是静止的、悬停条还没出来。一个看不见
      的锁，在体验上等于没有锁——他会先拖两下、以为画布卡了，然后来报 bug。
      位置放右上角：左上角被身份锚定徽标占着，右下角是遮盖提示。 */}
  {isLocked(node) ? <span className={css.lockedBadge} data-node-locked={node.id} aria-label={tt('canvas.lock.lock')}>
    <S.ToolbarIcon name="lock" size={12} />
  </span> : null}
  {isStoryboard ? (() => {
    const board = S.storyboardOf(node)
    const progress = S.storyboardProgress(board, S.canvasDocument?.nodes ?? [])
    return <header className={css.nodeHeader}>
      <span className={css.nodeTitle}>{node.title}</span>
      <span className={css.nodeTag} data-storyboard-count="">{tt('canvas.storyboard.shotCount', { count: progress.total })}</span>
      {progress.generating > 0 ? <span className={css.nodeTag} data-storyboard-running="">{tt('canvas.storyboard.running', { count: progress.generating })}</span> : null}
    </header>
  })() : null}
  {isTextual || isSketch || isPose ? <header className={css.nodeHeader}>
    <span className={css.nodeTitle}>{node.title}</span>
    {metadata.annotation !== undefined ? <span className={css.nodeTag}>{tt('canvas.annotationTag')}</span> : null}
    {metadata.layer !== undefined ? <span className={css.nodeTag}>{S.layerKindLabel(metadata.layer.kind)}</span> : null}
    {isTextNode && !S.isAnnotationCard(node) ? <div className={css.textTools} onPointerDown={event => event.stopPropagation()}>
      <button
        type="button"
        className={css.textTool}
        aria-label={tt('canvas.fontSmaller')}
        title={tt('canvas.fontSmaller')}
        onClick={() => A.patchNode(node.id, { fontSize: Math.max(8, (metadata.fontSize ?? 13) - 2) })}
      >A-</button>
      <span className={css.textToolValue}>{Math.round(metadata.fontSize ?? 13)}</span>
      <button
        type="button"
        className={css.textTool}
        aria-label={tt('canvas.fontLarger')}
        title={tt('canvas.fontLarger')}
        onClick={() => A.patchNode(node.id, { fontSize: Math.min(96, (metadata.fontSize ?? 13) + 2) })}
      >A+</button>
      <button
        type="button"
        className={css.textTool}
        data-active={(metadata.bold ?? false) ? '' : undefined}
        aria-label={tt('canvas.bold')}
        title={tt('canvas.bold')}
        onClick={() => A.patchNode(node.id, { bold: metadata.bold !== true })}
      ><S.ToolbarIcon name="bold" size={13} /></button>
      <button
        type="button"
        className={css.textTool}
        data-active={S.colorPickerNodeId === node.id ? '' : undefined}
        aria-label={tt('canvas.textColor')}
        title={tt('canvas.textColor')}
        onClick={() => A.setColorPickerNodeId(S.colorPickerNodeId === node.id ? null : node.id)}
      ><span className={css.colorDot} style={{ background: metadata.color ?? 'currentColor' }} /></button>
    </div> : null}
  </header> : null}
  {isTextNode && !S.isAnnotationCard(node) && S.colorPickerNodeId === node.id ? <div className={css.colorRow} onPointerDown={event => event.stopPropagation()}>
    {S.TEXT_COLORS.map(color => <button
      key={color === '' ? 'default' : color}
      type="button"
      className={css.colorSwatch}
      data-active={(metadata.color ?? '') === color ? '' : undefined}
      style={color === '' ? undefined : { background: color }}
      title={color === '' ? tt('canvas.colorDefault') : color}
      aria-label={color === '' ? tt('canvas.colorDefault') : color}
      onClick={() => { A.patchNode(node.id, { color: color === '' ? undefined : color }); A.setColorPickerNodeId(null) }}
    >{color === '' ? <X size={11} strokeWidth={2.4} aria-hidden="true" /> : null}</button>)}
  </div> : null}
  {isConfig && configReady !== null ? <div className={css.configLinks} data-config-links={node.id}>
    <span className={css.composerChip}>{tt('canvas.composerLinked', { count: configInputCount })}</span>
    {/*
      就绪徽标。这是整张画布上唯一一处「按下去之前就告诉你会发生什么」的地方。

      放在连线小条旁边而不是标题栏：它说的是这一次运行的条件，而条件由输入
      决定（有没有提示词、有没有图）。放在标题旁边会被读成节点的属性。

      三态而不是两态：`ready` 之外还要分开「缺提示词」和「缺配置」。合成一句
      「无法生成」会让人去翻设置却不知道翻哪一页——缺提示词要去写框里那段字，
      缺配置要去设置页填钥匙，是两个完全不同的动作。
    */}
    <span
      className={css.configReady}
      data-config-ready={configReady.ready ? '' : undefined}
      data-config-blocker={configReady.blockers[0] ?? undefined}
      role="status"
      title={configReady.ready
        ? tt('canvas.configReadyHint')
        : tt(`canvas.configBlocked.${configReady.blockers[0]!}` as ImageGenKey)}
    >
      {configReady.ready
        ? tt(configReady.hasReference ? 'canvas.configReadyEdit' : 'canvas.configReadyText')
        : tt(`canvas.configBlocked.${configReady.blockers[0]!}` as ImageGenKey)}
    </span>
  </div> : null}
  {/*
     * The hint is an EMPTY-STATE, not a caption.
     *
     * It used to render on every config node for the node's whole life, so a
     * canvas with six config nodes carried the same three grey lines six times
     * — and on an empty canvas those lines were the only substantial text, which
     * made "unwritten instructions" the most prominent thing on screen. Once a
     * node has an input, the chip above already says how many; repeating the
     * tutorial next to it is noise the user has to read past every single time.
     *
     * ⚠️ 这里曾经还有一个 `textarea`（写 `metadata.text`），已删除。它不是
     * 「多一个输入框」而是**一个假输入框**：生成的取值链是
     * `composerPrompt → 上游文本 → 标注卡`，从头到尾不读 `metadata.text`。
     * 于是用户在里面写的提示词会被静默丢弃，还带着一个「可生成」的徽标。
     * 配置节点的提示词编辑由悬浮生成器承担（选中即出现，见 composer.tsx），
     * 那里才是提交路径真正读的那一个框。一个提示词只准有一个编辑入口。
     */}
  {isConfig
    ? configInputCount === 0
      ? <p className={css.configHint}>{tt('canvas.configHint')}</p>
      : /*
         * 有输入时显示**将要发出去的那段提示词**，只读。
         *
         * 这一块替代了此前那个写 `metadata.text` 的 textarea——那个框的写入
         * 根本没人读（生成取的是生成器里的值），是「看起来能编辑、实际被丢弃」
         * 的假入口。但直接把正文留空也不行：卡片会变成一块空壳。
         *
         * 只读预览正好补上缺口，而且比编辑框更有用：用户能在一张一张卡片上
         * 核对「这一格到底会发什么」，而不必逐个选中、在底部生成器里比对。
         * 真正的编辑仍然只有生成器一处。
         */
        <>
        {/* 套图徽标：这张卡跑一次会出 N 张，每张一个标题。只读——编辑入口在
            composer 那一侧；卡片上再多一个写入口会撞 verify-ui-contracts 的
            「一个提示词只准有一个编辑入口」那条守卫。 */}
        {promptSetBadgeCount > 0
          ? <span className={css.promptSetBadge} data-prompt-set-badge={node.id}>
              {tt('canvas.promptSetBadge', { count: promptSetBadgeCount })}
            </span>
          : null}
        <p className={css.configPrompt} data-config-prompt={node.id}>
          {configReady !== null && configReady.prompt !== ''
            ? configReady.prompt
            : tt('canvas.configPromptElsewhere')}
        </p>
        </>
    : isTextual
    ? <textarea
        className={css.textArea}
        style={S.textStyleOf(node)}
        value={metadata.text ?? ''}
        placeholder={metadata.annotation !== undefined ? tt('canvas.annotationPlaceholder') : tt('canvas.textPlaceholder')}
        onPointerDown={event => event.stopPropagation()}
        onChange={event => A.patchNode(node.id, { text: event.target.value })}
      />
    : isPose
    ? <S.PoseBoard
        api={S.api}
        node={node}
        rig={S.poseOf(node)}
        onRigChange={next => A.patchStageRig(node.id, next)}
        onAssetChange={asset => A.patchSketchAsset(node.id, asset)}
        onOpenStage={() => A.openStage(node.id)}
        onError={A.reportError}
      />
    : isSketch
    ? <S.SketchBoard
        api={S.api}
        node={node}
        zoom={S.canvasDocument?.viewport.k ?? 1}
        strokes={metadata.sketch?.strokes ?? []}
        onStrokesChange={strokes => A.patchSketchStrokes(node.id, strokes)}
        onAssetChange={asset => A.patchSketchAsset(node.id, asset)}
      />
    : isStoryboard
    ? <S.StoryboardBody
        node={node}
        nodes={S.canvasDocument?.nodes ?? []}
        videoGroups={S.videoGroups ?? []}
        defaultChannelId={S.defaultChannelId}
        defaultVideoChannelId={S.effectiveVideoChannelId}
        defaultVideoModel={S.effectiveVideoModel}
        busy={busyLabel !== undefined}
        onChange={next => A.patchNode(node.id, { storyboard: next })}
        onRun={() => { void A.runStoryboard(node) }}
        onRunShot={index => { void A.submitShot(node, index) }}
        onPreview={nodeId => A.setVideoPreviewNodeId(nodeId)}
        onStitch={ids => A.startStoryboardStitch(ids)}
        // 只有从文档铺出来的板才有去向；手画的板 `source` 是 undefined，
        // 这里就不传回调，按钮也就不出现。
        onWriteback={S.storyboardOf(node).source === undefined ? undefined : () => { void A.openStoryboardWriteback(node) }}
      />
    : isVideo
    ? <div className={css.fileBody} data-video-body="">
        {hasVideo
          ? S.brokenVideoIds.has(node.id)
            ? <div className={css.nodeStateError} data-video-missing="">
                <span>{tt('canvas.videoMissing')}</span>
                <span>{tt('canvas.videoMissingHint')}</span>
                <button
                  type="button"
                  onClick={() => A.clearBrokenVideo(node.id)}
                >{tt('canvas.videoReload')}</button>
                <button type="button" onClick={() => A.deleteNode(node.id)}>{tt('canvas.delete')}</button>
              </div>
            : <video
                className={css.fileVideo}
                controls
                preload="metadata"
                // The clip is served from the video store with Range support,
                // so pointing the element straight at that route lets the user
                // seek without any asset copy inside the canvas.
                src={video.url}
                onPointerDown={event => event.stopPropagation()}
                onError={() => A.setBrokenVideoIds(previous => previous.has(node.id) ? previous : new Set(previous).add(node.id))}
              />
          : isGenerating || metadata.status === 'idle'
            ? <div className={css.nodeState} data-video-generating=""><span className={css.nodeSpinner} aria-hidden="true" /><span>{tt('canvas.videoGeneratingNode')}</span></div>
            : isError
              ? <div className={css.nodeStateError} data-video-error="">{metadata.error ?? tt('canvas.generateFailed')}{metadata.renderer === 'code' ? <span className={css.nodeStateHint}>{tt('canvas.rendererFailedHint')}</span> : null}<button type="button" onClick={() => { void A.retryVideoGeneration(node) }}>{tt('canvas.retry')}</button></div>
              : <div className={css.nodeState} data-video-empty=""><span>{tt('canvas.videoEmptyNode')}</span></div>}
      </div>
    : isFile
    ? hasFile
      ? <S.CanvasFileBody
          api={S.api}
          asset={asset}
          fileKind={fileKind}
          title={node.title}
          hint={tt('canvas.preview.doubleClick')}
          onExpand={() => { A.setFilePreviewNodeId(node.id) }}
        />
      : <div className={css.fileBody}>
          <button
            type="button"
            className={css.nodeEmpty}
            onClick={() => { A.setFileTargetNodeId(node.id); S.fileUploadRef.current?.click() }}
          ><S.ToolbarIcon name="upload" /><span>{tt('canvas.skills.emptyFileNode')}</span></button>
        </div>
    : <div className={css.nodeBody} data-node-body="image">
        {isGenerating
          ? <div className={css.nodeState}><span className={css.nodeSpinner} aria-hidden="true" /><span>{tt('canvas.generatingNode')}</span></div>
          : isError
            ? <div className={css.nodeStateError}>{metadata.error ?? tt('canvas.generateFailed')}{metadata.renderer === 'code' ? <span className={css.nodeStateHint}>{tt('canvas.rendererFailedHint')}</span> : null}<button type="button" onClick={() => { void A.retryGeneration(node) }}>{tt('canvas.retry')}</button></div>
            : hasImage
              ? <img src={asset.url} alt={node.title} title={tt('canvas.preview.doubleClick')} draggable={false} onDragStart={event => event.preventDefault()} />
              : <button type="button" className={css.nodeEmpty} onClick={() => S.imageFileRef.current?.click()}><S.ToolbarIcon name="image" /><span>{tt('canvas.emptyImageNode')}</span></button>}
        {hasImage && annotations.length > 0 ? <div className={css.annotationLayer} aria-hidden="true">
          {annotations.map((annotation, index) => <div key={annotation.id} className={css.annotationBox} style={boxStyle(annotation)}>
            <span className={css.annotationBadge}>{index + 1}</span>
          </div>)}
        </div> : null}
        {annotating ? <div
          className={css.annotationLayer}
          data-active=""
          title={tt('canvas.annotationDrawHint')}
          onPointerDown={event => A.beginAnnotationDrag(event, node)}
          onPointerMove={A.moveAnnotationDrag}
          onPointerUp={event => A.endAnnotationDrag(event, node)}
          onPointerCancel={() => { S.annotationDragRef.current = null; A.setAnnotationDraft(null) }}
        >
          {annotations.map((annotation, index) => <div key={annotation.id} className={css.annotationBox} style={boxStyle(annotation)}>
            <span className={css.annotationBadge}>{index + 1}</span>
          </div>)}
          {draftRect !== null ? <div className={`${css.annotationBox} ${css.annotationDraft}`} style={boxStyle(draftRect)} /> : null}
        </div> : null}
        {busyLabel !== undefined ? <div className={css.nodeBusy}><span className={css.nodeSpinner} aria-hidden="true" /><span>{busyLabel}</span></div> : null}
      </div>}
  {node.type === 'image' && !isSketch && !isPose && hasImage ? <div className={css.imageFooter} data-image-footer="">
    <span className={css.imageFooterLabel}>
      {metadata.layer !== undefined
        ? `${S.layerKindLabel(metadata.layer.kind)} · ${metadata.layer.label}`
        : metadata.model !== undefined && metadata.model !== ''
          ? metadata.model
          : asset.origin === 'gallery' || asset.origin === 'history'
            ? (asset.origin === 'gallery' ? tt('canvas.fromGallery') : tt('canvas.fromHistory'))
            : ''}
    </span>
    {asset.width > 1 ? <span className={css.imageFooterSize}>{asset.width}×{asset.height}</span> : null}
  </div> : null}
  {isVideo ? <div className={css.imageFooter} data-video-footer="">
    <span className={css.imageFooterLabel}>
      {hasVideo
        ? `${metadata.model ?? tt('canvas.videoSourceBadge')}${metadata.videoMode === undefined ? '' : ` · ${tt(`video.mode.${metadata.videoMode}` as ImageGenKey)}`}`
        : tt('canvas.videoEmptyNode')}
    </span>
    {hasVideo && metadata.seconds !== undefined
      ? <span className={css.imageFooterSize}>{tt('canvas.videoDuration', { seconds: metadata.seconds })}</span>
      : null}
  </div> : null}
  {isFile ? <div className={css.imageFooter} data-file-footer="">
    <span className={css.imageFooterLabel}>
      {hasFile
        ? `${asset.name !== undefined && asset.name !== '' ? asset.name : S.fileKindLabel(fileKind)}${metadata.skill !== undefined ? ` · ${tt('canvas.skills.sourceBadge')}` : ''}`
        : S.fileKindLabel(fileKind)}
    </span>
    {hasFile && asset.bytes > 0 ? <span className={css.imageFooterSize}>{S.fileSizeLabel(asset.bytes)}</span> : null}
  </div> : null}
  {isSelected && !isSketch && !isPose
    ? (['nw', 'ne', 'sw', 'se'] as const).map(corner => <div
        key={corner}
        className={css.resizeHandle}
        data-corner={corner}
        onPointerDown={event => A.handleResizeStart(event, node, corner)}
        title={tt('canvas.resizeHint')}
      />)
    : null}
  {S.isAnnotationCard(node)
    ? null
    : <>
        <div className={`${css.handle} ${css.handleLeft}`} title={tt('canvas.connectHint')} onPointerDown={event => A.handleConnectStart(event, node.id, 'target')} />
        <div
          className={`${css.handle} ${css.handleRight}`}
          title={tt('canvas.connectAddHint')}
          onPointerDown={event => A.handleConnectStart(event, node.id, 'source')}
          onMouseEnter={() => { window.setTimeout(() => { if (S.connectRef.current === null) A.openNodeAddMenu(node) }, 120) }}
          onMouseLeave={A.scheduleNodeAddMenuClose}
        />
      </>}
  <div className={`${css.hoverToolbar} ${node.type === 'image' && hasImage ? css.hoverToolbarBottom : ''}`} data-toolbar={node.type === 'image' && hasImage ? 'bottom' : 'top'} onPointerDown={event => event.stopPropagation()}>
    {isVideo && hasVideo ? <>
      <S.ModelPicker
        groups={S.videoGroups ?? []}
        value={S.resolveModelChoice(S.videoGroups ?? [], { channelId: metadata.channelId, model: metadata.model }, S.defaultChannelId)}
        variant="toolbar"
        channelLabel={tt('model.channel')}
        modelLabel={tt('video.model')}
        channelPlaceholder={tt('model.channelPlaceholder')}
        emptyLabel={tt('canvas.videoNoModel')}
        ariaLabel={tt('canvas.videoNodeModel')}
        disabled={busyLabel !== undefined}
        onChange={choice => A.patchNode(node.id, {
          model: choice.model === '' ? undefined : choice.model,
          channelId: choice.channelId === '' ? undefined : choice.channelId,
        })}
      />
      <S.IconButton
        name="redo"
        label={tt('canvas.videoRegenerate')}
        disabled={busyLabel !== undefined || (metadata.prompt ?? '') === ''}
        onClick={() => { void A.retryVideoGeneration(node) }}
      />
      <span className={css.toolbarDivider} aria-hidden="true" />
      <S.IconButton name="download" label={tt('canvas.videoDownload')} onClick={() => A.downloadVideoNode(node)} />
      <S.IconButton name="sparkle" label={tt('canvas.videoGrabFrame')} disabled={busyLabel !== undefined} onClick={() => { void A.grabVideoFrame(node) }} />
      <S.IconButton name="layers" label={tt('canvas.storyboard.grabLastFrame')} disabled={busyLabel !== undefined} onClick={() => { void A.continueFromClip(node) }} />
      <S.IconButton name="favorite" label={tt('canvas.videoFavorite')} disabled={busyLabel !== undefined || video.entryId === undefined} onClick={() => { A.favoriteVideoNode(node) }} />
      <S.IconButton name="expand" label={tt('canvas.videoPreview')} onClick={() => { A.setVideoPreviewNodeId(node.id) }} />
    </> : null}
    {node.type === 'image' && hasImage ? <>
      <S.IconButton name="annotate" label={tt('canvas.annotate')} active={annotating} onClick={() => A.toggleAnnotate(node)} />
      <S.IconButton name="removeBg" label={tt('canvas.removeBackground')} disabled={busyLabel !== undefined} onClick={() => { void A.removeNodeBackground(node) }} />
      <S.IconButton name="text" label={tt('poster.title')} disabled={busyLabel !== undefined} onClick={() => { if (S.canvasDocument !== null) A.setPosterTarget({ canvasId: S.canvasDocument.id, nodeId: node.id }) }} />
      <S.IconButton name="layers" label={tt('canvas.splitLayers')} disabled={busyLabel !== undefined} onClick={() => { void A.splitLayers(node) }} />
      <span className={css.toolbarDivider} aria-hidden="true" />
      <S.ModelPicker
        groups={S.modelGroups}
        value={S.resolveModelChoice(S.modelGroups, { channelId: metadata.channelId, model: metadata.model }, S.defaultChannelId)}
        variant="toolbar"
        channelLabel={tt('model.channel')}
        modelLabel={tt('model.label')}
        channelPlaceholder={tt('model.channelPlaceholder')}
        emptyLabel={tt('canvas.modelPlaceholder')}
        ariaLabel={tt('canvas.nodeModel')}
        disabled={busyLabel !== undefined}
        onChange={choice => A.patchNode(node.id, {
          model: choice.model === '' ? undefined : choice.model,
          channelId: choice.channelId === '' ? undefined : choice.channelId,
        })}
      />
      <span className={css.toolbarDivider} aria-hidden="true" />
      <S.IconButton name="expand" label={tt('canvas.preview.expand')} onClick={() => { A.openImageNode(node) }} />
      <S.IconButton name="download" label={tt('canvas.download')} onClick={() => A.downloadNode(node)} />
    </> : null}
    {skillable ? <>
      <S.IconButton
        name="skill"
        label={tt('canvas.skills.button')}
        active={skillRun !== undefined}
        onClick={event => A.openSkillMenu(node, { x: event.clientX, y: event.clientY + 10 })}
      />
      {isTextNode && !S.isAnnotationCard(node) ? <S.IconButton
        name="sparkle"
        label={tt('canvas.polish.button')}
        disabled={S.polishBusy === node.id}
        onClick={event => {
          event.stopPropagation()
          A.setPolishNode({ screen: { x: event.clientX, y: event.clientY + 10 }, nodeId: node.id })
        }}
      /> : null}
      <span className={css.toolbarDivider} aria-hidden="true" />
    </> : null}
    {isFile && hasFile ? <>
      <S.IconButton name="download" label={tt('canvas.skills.fileDownload')} onClick={() => A.downloadFileNode(node)} />
      <S.IconButton name="expand" label={tt('canvas.preview.expand')} onClick={() => A.openFileNode(node)} />
      <span className={css.toolbarDivider} aria-hidden="true" />
    </> : null}
    {S.isAnnotationCard(node) ? null : <S.IconButton name="duplicate" label={S.labelWithKeys('canvas.duplicate')} onClick={() => A.duplicateNode(node.id)} />}
    {/* 锁定 / 隐藏挂在悬停条上，而不是只放进右键菜单：菜单是「我想对这个对象做
        点什么」的地方，而这两个开关更常是在「我马上就要拖它」的那一刻按下的，
        那时手已经在卡片上了。 */}
    <S.IconButton
      name={isLocked(node) ? 'unlock' : 'lock'}
      label={S.labelWithKeys(isLocked(node) ? 'canvas.lock.unlock' : 'canvas.lock.lock')}
      active={isLocked(node)}
      onClick={() => A.setNodeLocked(node.id, !isLocked(node))}
    />
    <S.IconButton
      name="hide"
      label={S.labelWithKeys('canvas.lock.hide')}
      onClick={() => A.setNodeHidden(node.id, true)}
    />
    <S.IconButton name="trash" label={tt('canvas.delete')} onClick={() => A.deleteNode(node.id)} />
  </div>
</>
}

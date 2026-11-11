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
import type { CanvasAssetRef, CanvasDocument, CanvasLayerKind, CanvasNode, CanvasRect, CanvasSketchStroke } from '../../protocol.ts'
import type { ImageGenApi } from '../api.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import type { ImageModelGroup } from '../settings-scope.ts'
import { CanvasFileBody, fileKindLabel, fileKindOfAsset, fileSizeLabel } from '../CanvasFilePreview.tsx'
import { ModelPicker, resolveModelChoice, type ModelPickerValue } from '../ModelPicker.tsx'
import { IconButton, ToolbarIcon } from './dock-controls.tsx'
import { ROLE_LABELS } from '../cast.ts'
import { isAnnotationCard, isSketchNode, liveAnnotations, nodeMetadata, textStyleOf, videoOf, bezierPath as _bezierPath } from './node-model.ts'
import { storyboardOf, storyboardProgress } from '../storyboard.ts'
import { SketchBoard } from './sketch-and-picker.tsx'
import { StoryboardBody } from './storyboard-board.tsx'
import type { Point } from './geometry.ts'
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
  fileUploadRef: { current: HTMLInputElement | null }
  imageFileRef: { current: HTMLInputElement | null }
  connectRef: { current: unknown }
  // 子组件与常量（原来是主文件的 import）
  IconButton: typeof IconButton
  ToolbarIcon: typeof ToolbarIcon
  ModelPicker: typeof ModelPicker
  SketchBoard: typeof SketchBoard
  StoryboardBody: typeof StoryboardBody
  CanvasFileBody: typeof CanvasFileBody
  ROLE_LABELS: typeof ROLE_LABELS
  TEXT_COLORS: readonly string[]
  // 纯函数
  nodeMetadata: typeof nodeMetadata
  assetOf: (node: CanvasNode) => CanvasAssetRef | undefined
  videoOf: typeof videoOf
  isSketchNode: typeof isSketchNode
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
}

/** 节点体里会触发的动作，全部由上层提供。 */
export interface NodeBodyActions {
  patchNode: (nodeId: string, patch: Record<string, unknown>) => void
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
  clearBrokenVideo: (nodeId: string) => void
  patchSketchStrokes: (nodeId: string, strokes: CanvasSketchStroke[]) => void
  patchSketchAsset: (nodeId: string, asset: CanvasAssetRef | undefined) => void
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
/** 被完全盖住的那一方（或盖住别人的那一方）：拖动中出现，松手后保留。 */
const isOverlapping = S.liveOverlap !== null && S.liveOverlap.ids.has(node.id)
/** 只有被盖住的那个才挂徽标——盖住别人的那个本身看得见，不需要解释。 */
const coverNote = S.liveOverlap !== null && S.liveOverlap.coveredId === node.id ? S.liveOverlap : null
const hasImage = asset !== undefined && asset.url !== ''
const isConfig = node.type === 'config'
const isFile = node.type === 'file'
const isVideo = node.type === 'video'
const isStoryboard = node.type === 'storyboard'
const video = S.videoOf(node)
const hasVideo = video !== undefined && video.url !== ''
const isSketch = S.isSketchNode(node)
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
const isTextual = node.type === 'text' || isConfig
const isTextNode = node.type === 'text'
const annotating = S.annotateNodeId === node.id && hasImage && !isSketch
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
  {coverNote !== null
    ? <span
        className={css.overlapBadge}
        data-node-covered={node.id}
        role="status"
        aria-label={`${tt('canvas.overlapBadge', { title: coverNote.coverTitle })}。${tt('canvas.overlapHint')}`}
      >
        {tt('canvas.overlapBadge', { title: coverNote.coverTitle })}
      </span>
    : null}
  {composeIndex >= 0
    ? <span className={css.composeBadge} data-compose-badge={String(composeIndex + 1)} aria-hidden="true">
        {tt('canvas.composeBadge', { index: composeIndex + 1 })}
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
  {isStoryboard ? (() => {
    const board = S.storyboardOf(node)
    const progress = S.storyboardProgress(board, S.canvasDocument?.nodes ?? [])
    return <header className={css.nodeHeader}>
      <span className={css.nodeTitle}>{node.title}</span>
      <span className={css.nodeTag} data-storyboard-count="">{tt('canvas.storyboard.shotCount', { count: progress.total })}</span>
      {progress.generating > 0 ? <span className={css.nodeTag} data-storyboard-running="">{tt('canvas.storyboard.running', { count: progress.generating })}</span> : null}
    </header>
  })() : null}
  {isTextual || isSketch ? <header className={css.nodeHeader}>
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
  {isConfig ? <div className={css.configLinks} data-config-links={node.id}>
    <span className={css.composerChip}>{tt('canvas.composerLinked', { count: (S.canvasDocument?.connections ?? []).filter(connection => connection.toNodeId === node.id).length })}</span>
  </div> : null}
  {isConfig
    ? <p className={css.configHint}>{tt('canvas.configHint')}</p>
    : isTextual
    ? <textarea
        className={css.textArea}
        style={S.textStyleOf(node)}
        value={metadata.text ?? ''}
        placeholder={metadata.annotation !== undefined ? tt('canvas.annotationPlaceholder') : tt('canvas.textPlaceholder')}
        onPointerDown={event => event.stopPropagation()}
        onChange={event => A.patchNode(node.id, { text: event.target.value })}
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
        busy={busyLabel !== undefined}
        onChange={next => A.patchNode(node.id, { storyboard: next })}
        onRun={() => { void A.runStoryboard(node) }}
        onRunShot={index => { void A.submitShot(node, index) }}
        onPreview={nodeId => A.setVideoPreviewNodeId(nodeId)}
        onStitch={ids => A.startStoryboardStitch(ids)}
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
  {node.type === 'image' && !isSketch && hasImage ? <div className={css.imageFooter} data-image-footer="">
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
  {isSelected && !isSketch
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
    {S.isAnnotationCard(node) ? null : <S.IconButton name="duplicate" label={tt('canvas.duplicate')} onClick={() => A.duplicateNode(node.id)} />}
    <S.IconButton name="trash" label={tt('canvas.delete')} onClick={() => A.deleteNode(node.id)} />
  </div>
</>
}

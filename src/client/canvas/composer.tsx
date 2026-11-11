/**
 * 画布的生成输入条（composer）：贴着目标节点浮出来的一行提示词 + 参数。
 *
 * 从 CanvasWorkspace.tsx 的 `renderComposer` 原样搬出（159 行）。只接 props，
 * 不读组件状态、不发请求——与 `node-body.tsx` 同一约定。
 *
 * WHY 值得单独一个文件：这条输入条同时承载两种生成（图像/视频）× 两条执行路径
 * （模型 API / 代码渲染），参数组的显示条件是它们的组合，挤在 5452 行的组件里
 * 根本看不出哪一组在什么条件下出现。放在这里，`renderComposer` 的那个提前返回
 * （没打开、没画布、没目标就什么都不画）也才看得见。
 *
 * 位置的算法留在本文件里：它只依赖视口、目标节点和输入条自身的高宽，是这条
 * 组件的私有几何。
 */

import type { ReactNode } from 'react'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import type { ImageModelGroup } from '../settings-scope.ts'
import type { CanvasDocument, CanvasNode, VideoMode, VideoResolution } from '../../protocol.ts'
import { ModelPicker } from '../ModelPicker.tsx'
import { ComposerSelect, ToolbarIcon } from './dock-controls.tsx'
import css from '../canvas-workspace.module.css'

/** 输入条要读的画布状态。 */
export interface ComposerState {
  canvasDocument: CanvasDocument | null
  viewportSize: { width: number; height: number }
  /** 视口元素的 `offsetTop`：输入条是绝对定位，要减去它才对得上。 */
  viewportRef: { current: { offsetTop?: number } | null }
  modelGroups: ImageModelGroup[]
  videoGroups: ImageModelGroup[] | undefined
  composerVisible: boolean
  composerTarget: CanvasNode | null
  composerKind: 'image' | 'video'
  composerPrompt: string
  composerRenderer: 'model' | 'code'
  composerBusy: boolean
  composerReferenceCount: number
  composerTextCount: number
  composerAnnotationTexts: string[]
  composerChannelConnected: boolean
  composerChannelId: string
  composerModel: string
  composerVideoChannelId: string
  composerVideoModel: string
  composerVideoConnected: boolean
  composerVideoMode: VideoMode | 'auto'
  composerAspect: string
  composerAspectOptions: string[]
  composerSeconds: number
  composerDurationOptions: number[]
  composerResolution: string
  composerResolutionOptions: string[]
  composerSize: string
  composerQuality: string
  composerCount: number
  composerProbeWarning: string | undefined
  composerVideoCatalog: { aspectLabels?: Record<string, string> }
  videoModelCount: number
}

/** 输入条会触发的动作。 */
export interface ComposerActions {
  // 这两个收的就是目标节点本身（选中的那个 config 节点），返回值是 Promise——
  // 签名照实抄，别照着"只传几何"想当然。
  submitComposer: (target: CanvasNode | null) => Promise<void>
  submitVideoComposer: (target: CanvasNode | null) => Promise<void>
  setComposerPrompt: (value: string) => void
  setComposerKind: (value: 'image' | 'video') => void
  setComposerRenderer: (value: 'model' | 'code') => void
  setComposerChannelId: (value: string) => void
  setComposerModel: (value: string) => void
  setComposerVideoChannelId: (value: string) => void
  setComposerVideoModel: (value: string) => void
  setComposerVideoMode: (value: VideoMode | 'auto') => void
  setComposerAspect: (value: string) => void
  setComposerSeconds: (value: number) => void
  setComposerResolution: (value: VideoResolution) => void
  setComposerSize: (value: string) => void
  setComposerQuality: (value: string) => void
  setComposerCount: (value: number) => void
}

/**
 * 生成输入条。没打开、没载入画布、没有目标节点时返回 `null`——这三者缺一个，
 * 输入条都没有可挂的位置或可提交的对象。
 */
export function CanvasComposer(props: { S: ComposerState; A: ComposerActions }): ReactNode {
  const { S, A } = props
if (!S.composerVisible || S.canvasDocument === null || S.composerTarget === null) return null
  // 上面三行已排除 null，但 TS 不会把属性收窄带进 onClick/onKeyDown 的闭包，
  // 所以在动词处锚一个局部常量：闭包捕获它，类型也就跟上了。
  const composerTarget = S.composerTarget
const linkedCount = S.composerReferenceCount + S.composerTextCount
const k = S.canvasDocument.viewport.k
const topOffset = S.viewportRef.current?.offsetTop ?? 0
const centerX = topOffset * 0 + S.canvasDocument.viewport.x + (composerTarget.x + composerTarget.width / 2) * k
const clampedX = Math.min(Math.max(centerX, 292), Math.max(292, S.viewportSize.width - 292))
const belowY = topOffset + S.canvasDocument.viewport.y + (composerTarget.y + composerTarget.height) * k + 14
const top = belowY > S.viewportSize.height + topOffset - 170
  ? Math.max(64, topOffset + S.canvasDocument.viewport.y + composerTarget.y * k - 158)
  : belowY
return <div className={css.composer} data-canvas-no-zoom="" style={{ left: clampedX - 280, top }}>
  <textarea
    className={css.composerPrompt}
    value={S.composerPrompt}
    placeholder={tt(S.composerKind === 'video' ? 'canvas.videoComposerPlaceholder' : 'canvas.composerPlaceholder')}
    rows={1}
    onPointerDown={event => event.stopPropagation()}
    onChange={event => A.setComposerPrompt(event.target.value)}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        // Enter submits whichever path the toggle is on.
        if (S.composerKind === 'video') void A.submitVideoComposer(composerTarget)
        else void A.submitComposer(composerTarget)
      }
    }}
  />
  {linkedCount > 0 ? <div className={css.composerMeta}>
    <span className={css.composerChip}>{tt('canvas.composerLinked', { count: linkedCount })}</span>
  </div> : null}
  <div className={css.composerControls}>
    {/* The kind toggle normally needs a video catalog to be useful. The code
        path does not, so it stays reachable whenever that path is selected. */}
    {S.videoModelCount > 0 || S.composerRenderer === 'code' ? <div className={css.composerKind} role="group" aria-label={tt('canvas.videoKind')}>
      <button type="button" data-active={S.composerKind === 'image' ? '' : undefined} onClick={() => { A.setComposerKind('image') }}>{tt('canvas.kindImage')}</button>
      <button type="button" data-active={S.composerKind === 'video' ? '' : undefined} onClick={() => { A.setComposerKind('video') }}>{tt('canvas.kindVideo')}</button>
    </div> : null}
    {/* Per-task renderer choice. Kept in the ordinary composer row (not a
        separate dialog or a global setting) so one canvas can run both
        paths side by side, task by task. */}
    <ComposerSelect
      ariaLabel={tt('canvas.rendererLabel')}
      value={S.composerRenderer}
      options={[
        { value: 'model', label: tt('canvas.rendererModel') },
        { value: 'code', label: tt('canvas.rendererCode') },
      ]}
      onChange={value => A.setComposerRenderer(value === 'code' ? 'code' : 'model')}
    />
    {S.composerKind === 'video' ? <>
      {/* With the code path there is no provider to pick: the host's own
          conversation model writes the drawing code. */}
      {S.composerRenderer === 'model' ? <ModelPicker
        groups={S.videoGroups ?? []}
        value={{ channelId: S.composerVideoChannelId, model: S.composerVideoModel }}
        variant="composer"
        channelLabel={tt('model.channel')}
        modelLabel={tt('video.model')}
        channelPlaceholder={tt('model.channelPlaceholder')}
        emptyLabel={tt('canvas.videoNoModel')}
        ariaLabel={tt('video.model')}
        onChange={choice => { A.setComposerVideoChannelId(choice.channelId); A.setComposerVideoModel(choice.model) }}
      /> : null}
      <ComposerSelect
        ariaLabel={tt('canvas.videoModeLabel')}
        value={S.composerVideoMode}
        options={(['auto', 'text', 'image', 'keyframe'] as const).map(item => ({ value: item, label: tt(`canvas.videoMode${item === 'auto' ? 'Auto' : item === 'text' ? 'Text' : item === 'image' ? 'Image' : 'Keyframe'}` as ImageGenKey) }))}
        onChange={value => A.setComposerVideoMode(value as 'auto' | VideoMode)}
      />
      <ComposerSelect
        ariaLabel={tt('canvas.videoAspect')}
        value={S.composerAspect}
        options={S.composerAspectOptions.map(item => ({ value: item, label: S.composerVideoCatalog.aspectLabels?.[item] ?? item }))}
        onChange={A.setComposerAspect}
      />
      <ComposerSelect
        ariaLabel={tt('canvas.videoSeconds')}
        value={String(S.composerSeconds)}
        options={S.composerDurationOptions.map(item => ({ value: String(item), label: tt('canvas.videoDuration', { seconds: item }) }))}
        onChange={value => A.setComposerSeconds(Number(value))}
      />
      <ComposerSelect
        ariaLabel={tt('canvas.videoResolution')}
        value={S.composerResolution}
        options={S.composerResolutionOptions.map(item => ({ value: item, label: item }))}
        onChange={value => A.setComposerResolution(value as VideoResolution)}
      />
    </> : S.composerRenderer === 'model' ? <ModelPicker
      groups={S.modelGroups}
      value={{ channelId: S.composerChannelId, model: S.composerModel }}
      variant="composer"
      channelLabel={tt('model.channel')}
      modelLabel={tt('model.label')}
      channelPlaceholder={tt('model.channelPlaceholder')}
      emptyLabel={tt('canvas.modelPlaceholder')}
      ariaLabel={tt('canvas.model')}
      onChange={choice => { A.setComposerChannelId(choice.channelId); A.setComposerModel(choice.model) }}
    /> : null}
    {S.composerKind === 'image' ? <>
    <ComposerSelect
      ariaLabel={tt('canvas.size')}
      value={S.composerSize}
      options={[
        { value: 'auto', label: tt('canvas.sizeAuto') },
        { value: '1:1', label: '1:1' },
        { value: '3:4', label: '3:4' },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' },
      ]}
      onChange={A.setComposerSize}
    />
    <ComposerSelect
      ariaLabel={tt('canvas.quality')}
      value={S.composerQuality}
      options={[
        { value: 'auto', label: tt('canvas.qualityAuto') },
        { value: '1k', label: '1K' },
        { value: '2k', label: '2K' },
        { value: '4k', label: '4K' },
      ]}
      onChange={A.setComposerQuality}
    />
    {/* The code path renders one still per run (one chat answer, one
        drawing source), so a count above one would create placeholders
        that never fill. */}
    {S.composerRenderer === 'model' ? <ComposerSelect
      ariaLabel={tt('canvas.count')}
      value={String(S.composerCount)}
      options={[1, 2, 3, 4].map(item => ({ value: String(item), label: tt('canvas.countUnit', { count: item }) }))}
      onChange={value => A.setComposerCount(Number(value))}
    /> : null}
    </> : null}
    <button
      type="button"
      className={css.composerSend}
      aria-label={tt(S.composerKind === 'video' ? 'canvas.videoGenerate' : 'canvas.generate')}
      title={tt(S.composerKind === 'video' ? 'canvas.videoGenerate' : 'canvas.generate')}
      disabled={S.composerBusy
        || (S.composerKind === 'video'
          ? (S.composerRenderer === 'model' && (!S.composerVideoConnected || S.composerVideoModel === '')) || S.composerPrompt.trim() === ''
          : (S.composerRenderer === 'model' && !S.composerChannelConnected)
            || (S.composerPrompt.trim() === '' && S.composerTextCount === 0 && S.composerAnnotationTexts.length === 0))}
      onClick={() => {
        if (S.composerKind === 'video') void A.submitVideoComposer(composerTarget)
        else void A.submitComposer(composerTarget)
      }}
    >{S.composerBusy ? <span className={css.nodeSpinner} aria-hidden="true" /> : <ToolbarIcon name="send" />}</button>
  </div>
  {/* A missing ffmpeg is the one failure the user can fix before paying
      for a chat call: say it here, with the fix, instead of at render time. */}
  {S.composerRenderer === 'code' && S.composerProbeWarning !== undefined
    ? <div className={css.composerMeta}><span className={css.composerHint} data-renderer-warning="">{S.composerProbeWarning}</span></div>
    : null}
  {S.composerRenderer === 'code'
    ? <div className={css.composerMeta}><span className={css.composerHint}>{tt('canvas.rendererHint')}</span></div>
    : null}
</div>
}

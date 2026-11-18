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
import type { CanvasDocument, CanvasNode, CanvasPromptSetItem, VideoMode, VideoResolution } from '../../protocol.ts'
import { ModelPicker } from '../ModelPicker.tsx'
import { ComposerSelect, ToolbarIcon } from './dock-controls.tsx'
import { MAX_PROMPT_SET_ITEMS, newPromptSetId, normalizePromptSet } from './prompt-set.ts'
import css from '../canvas-workspace.module.css'

/** 输入条要读的画布状态。 */
export interface ComposerState {
  canvasDocument: CanvasDocument | null
  viewportSize: { width: number; height: number }
  /**
   * 底栏这一块实际盖住画布多高（含多选时出现的拼接条与对齐条）。
   *
   * WHY 传进来而不是在下面写死一个数：输入条会在「贴着节点下方」与「翻到节点
   * 上方」之间翻转，判断依据曾经是一个硬编码的 170px。多选时底栏上方会多出
   * 两条药丸（拼接条、对齐条），底栏整体比 170 高，于是输入条判定为「下面放得
   * 下」、翻到节点下面，正好压在对齐条上——用户想点对齐，点到的是生成输入条。
   * 真机截图抓到的就是这个：对齐条只露出左半句「对齐 2 个节点」，八枚按钮全在
   * 输入条底下。
   */
  chromeHeight: number
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
  /** 就在旁边、提交时会被自动连进来的图片张数（预告，未产生任何改动）。 */
  composerAutoLinkCount: number
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
  /**
   * 套图草稿：非空就表示用户切到了「套图」态。
   *
   * WHY 放组件外（Workspace）而不是本文件：提交路径要读它（不是——提交读的是
   * **目标节点** `metadata.promptSet`；这套 UI 是先写进目标节点、提交时再读出来
   * 跑）。但切节点时草稿要不要跟着走、切回单张时 prompt 怎么回填，都越过本文件
   * 的职责；Workspace 一侧只暴露 state + 两个动作。
   */
  composerPromptSet: CanvasPromptSetItem[]
  composerProbeWarning: string | undefined
  composerVideoCatalog: { aspectLabels?: Record<string, string> }
  videoModelCount: number
}

/**
 * 套图行：把原来的「生成数量」下拉换成 单张 / 套图 两个态。
 *
 * ## 为什么不是 `count` 的扩容
 *
 * `count` 是「同一条出 N 张」（求同，挑最好的一张），套图是「N 条不同提示词各
 * 出一张」（求异，一次出齐三视图 / 一组电商图）。语义相反。两者共用一个数字会
 * 让「填 3 想出三视图」的人拿到三张一样的正面——所以套图住自己的字段
 * `metadata.promptSet`，UI 上也是独立的两个态，不共用数字。
 *
 * ## 本地态
 *
 * 「套图 / 单张」的开关不另立 state：`composerPromptSet.length > 0` 就是「套图
 * 态」。切回单张时把第一条非空 prompt 写回 `composerPrompt`、清空草稿——两件事
 * 都在同一个 onClick 里，不需要 useEffect。
 */
function ComposerPromptSetToggle({ S, A }: { S: ComposerState; A: ComposerActions }): ReactNode {
  const isSet = S.composerPromptSet.length > 0
  const items = S.composerPromptSet
  return (
    <div className={css.promptSetToggle} role="group" aria-label={tt('canvas.promptSetMode')}>
        <button type="button"
          data-active={!isSet ? '' : undefined}
          onClick={() => {
            if (!isSet) return
            // 切回单张：第一条非空 prompt 成为主输入框的内容。
            // 无条件覆盖主框——主框里可能还是切换前自动预填的上游文本，而用户
            // 刚刚在套图里写的那一条才是他现在想要的；留在那里的旧文本会被当成
            // 「他刚切回来什么都没做」，然后下一次生成用错提示词。
            const first = items.map(item => item.prompt.trim()).find(text => text !== '')
            A.setComposerPromptSet([])
            if (first !== undefined) A.setComposerPrompt(first)
          }}
        >{tt('canvas.promptSetModeSingle')}</button>
        <button type="button"
          data-active={isSet ? '' : undefined}
          onClick={() => {
            if (isSet) return
            // 切到套图：主输入框里已有的话带成第一条，省得用户重打一遍。
            const seed = S.composerPrompt.trim()
            A.setComposerPromptSet(seed === ''
              ? [{ id: newPromptSetId(0), title: '', prompt: '' }]
              : [{ id: newPromptSetId(0), title: '', prompt: seed }])
          }}
        >{tt('canvas.promptSetModeSet')}</button>
    </div>
  )
}

/**
 * 套图编辑器：独占输入条的一整行。
 *
 * WHY 不塞进参数行：参数行是 `display: flex` 的横排，编辑器有几条就多高。
 * 放进去会被压成一列——截图里「尺寸 / 质量 / 模型」全被挤成竖排的一两个字，
 * 每条提示词也只剩一个字母宽。编辑器是**多行**的东西，它必须自己占一行。
 */
function ComposerPromptSetEditor({ S, A }: { S: ComposerState; A: ComposerActions }): ReactNode {
  const items = S.composerPromptSet
  if (items.length === 0) return null
  return (
        <div className={css.promptSetEditor}>
          <p className={css.promptSetHint}>{tt('canvas.promptSetHint')}</p>
          {items.map((item, index) => (
            <div key={item.id} className={css.promptSetItem}>
              <span className={css.promptSetIndex}>{index + 1}</span>
              <input
                className={css.promptSetTitle}
                value={item.title}
                placeholder={tt('canvas.promptSetTitlePlaceholder')}
                aria-label={tt('canvas.promptSetTitle')}
                onPointerDown={event => event.stopPropagation()}
                onChange={event => {
                  const next = items.map((it, at) => at === index ? { ...it, title: event.target.value } : it)
                  A.setComposerPromptSet(normalizePromptSet(next))
                }}
              />
              <textarea
                className={css.promptSetPrompt}
                value={item.prompt}
                rows={1}
                placeholder={tt('canvas.promptSetPromptPlaceholder')}
                aria-label={tt('canvas.promptSetPromptPlaceholder')}
                onPointerDown={event => event.stopPropagation()}
                onChange={event => {
                  const next = items.map((it, at) => at === index ? { ...it, prompt: event.target.value } : it)
                  A.setComposerPromptSet(normalizePromptSet(next))
                }}
              />
              <button type="button"
                className={css.promptSetRemove}
                aria-label={tt('canvas.promptSetRemove')}
                title={tt('canvas.promptSetRemove')}
                onClick={() => {
                  const next = items.filter((_, at) => at !== index)
                  A.setComposerPromptSet(next.length === 0 ? [] : normalizePromptSet(next))
                }}
              ><ToolbarIcon name="close" /></button>
            </div>
          ))}
          <div className={css.promptSetFooter}>
            <button type="button"
              className={css.promptSetAdd}
              disabled={items.length >= MAX_PROMPT_SET_ITEMS}
              onClick={A.addComposerPromptSetItem}
            >{tt('canvas.promptSetAdd')}</button>
            {items.length === 1 && items[0] !== undefined && items[0].prompt.trim() === ''
              ? <span className={css.promptSetHint}>{tt('canvas.promptSetEmpty')}</span>
              : null}
          </div>
        </div>
  )
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
  setComposerPromptSet: (items: CanvasPromptSetItem[]) => void
  addComposerPromptSetItem: () => void
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
const chipsRowVisible = linkedCount > 0 || S.composerAutoLinkCount > 0
// 出图方式只对「图片 + 模型」这条路有意义：视频没有套图，代码渲染一次只出一张。
const showPromptSetToggle = S.composerKind === 'image' && S.composerRenderer === 'model'
const k = S.canvasDocument.viewport.k
const topOffset = S.viewportRef.current?.offsetTop ?? 0
const centerX = topOffset * 0 + S.canvasDocument.viewport.x + (composerTarget.x + composerTarget.width / 2) * k
const clampedX = Math.min(Math.max(centerX, 292), Math.max(292, S.viewportSize.width - 292))
const belowY = topOffset + S.canvasDocument.viewport.y + (composerTarget.y + composerTarget.height) * k + 14
// 翻转到下方的判据是「节点下面还有没有一整条输入条的位置」。170 是输入条自身的
// 经验高度（一行提示词 + 参数排 + 留白），它必须与**底栏真正盖住的高度**相加：
// 只看 170 的话，多选时多出来的拼接条 / 对齐条正好落在两者之间的那段缝隙里，
// 输入条压在上面，用户点不到对齐按钮。`chromeHeight` 是实测值（见 CanvasWorkspace
// 里那个 ResizeObserver），底栏换行、加行它都会跟着变。
const top = belowY > S.viewportSize.height + topOffset - (170 + S.chromeHeight)
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
  {/* 出图方式（单张 / 套图）与「已连接几个输入」并排：两者回答的都是「这一次
      会跑什么」，而参数行那一排已经放满了尺寸 / 清晰度 / 模型，再塞一组按钮会把
      它们压成只剩一两个字的宽度（真机截图里「图片」「视频」都被折成两行）。 */}
  <div className={css.composerMeta}>
    {linkedCount > 0 ? <span className={css.composerChip}>{tt('canvas.composerLinked', { count: linkedCount })}</span> : null}
    {S.composerAutoLinkCount > 0 ? <span className={css.composerChip} data-auto-link="">{tt('canvas.composerAutoLink', { count: S.composerAutoLinkCount })}</span> : null}
    <span className={css.composerMetaSpacer} />
    {/* 这一排放的是「这一次跑什么」：图片还是视频、走模型还是代码、单张还是
        套图。它们都是低频切换的开关，不该占参数行——那一排要给尺寸、清晰度、
        数量和模型名，那几个是每次生成都在看、且文字不能被截的东西。 */}
    {S.videoModelCount > 0 || S.composerRenderer === 'code' ? <div className={css.composerKind} role="group" aria-label={tt('canvas.videoKind')}>
      <button type="button" data-active={S.composerKind === 'image' ? '' : undefined} onClick={() => { A.setComposerKind('image') }}>{tt('canvas.kindImage')}</button>
      <button type="button" data-active={S.composerKind === 'video' ? '' : undefined} onClick={() => { A.setComposerKind('video') }}>{tt('canvas.kindVideo')}</button>
    </div> : null}
    <ComposerSelect
      ariaLabel={tt('canvas.rendererLabel')}
      value={S.composerRenderer}
      options={[
        { value: 'model', label: tt('canvas.rendererModel') },
        { value: 'code', label: tt('canvas.rendererCode') },
      ]}
      onChange={value => A.setComposerRenderer(value === 'code' ? 'code' : 'model')}
    />
    {showPromptSetToggle ? <ComposerPromptSetToggle S={S} A={A} /> : null}
  </div>
  <div className={css.composerControls}>
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
    {/* 单张才显示「生成数量」：套图态下每条的张数恒为 1（一条提示词出一张），
        而两个数字同时出现在一条输入条上，用户没法判断哪个说了算。 */}
    {S.composerRenderer === 'model' && S.composerPromptSet.length === 0 ? <ComposerSelect
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
            // 套图条目也算提示词：编辑器里写满三条、主输入框空着，按钮必须是活的。
            || (S.composerPrompt.trim() === '' && S.composerTextCount === 0 && S.composerAnnotationTexts.length === 0
              && S.composerPromptSet.every(item => item.prompt.trim() === '')))}
      onClick={() => {
        if (S.composerKind === 'video') void A.submitVideoComposer(composerTarget)
        else void A.submitComposer(composerTarget)
      }}
    >{S.composerBusy ? <span className={css.nodeSpinner} aria-hidden="true" /> : <ToolbarIcon name="send" />}</button>
  </div>
  {S.composerKind === 'image' && S.composerRenderer === 'model' ? <ComposerPromptSetEditor S={S} A={A} /> : null}
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

/**
 * 分镜板：一个 storyboard 节点内部的多镜列表。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。它只接 props、回回调——改内容走
 * `onChange` 交回一份新 document，所以撤销/重做、自动保存、多窗口版本检查
 * 对这里都是透明的，板上不需要知道它们存在。
 *
 * 产出的片段不在这里渲染：它们是板右侧的普通视频节点，正因如此才能预览、
 * 收藏、参与拼接。这里只显示每一镜的状态，以及让那些节点可达的两个快捷方式。
 */

import { useState } from 'react'
import type { CanvasNode, CanvasStoryboard, VideoResolution } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { MAX_SHOTS, nextShotIndex, shotNodeOf, shotSecondsOptions, shotSpeechFit, shotState, shotsWithoutCast, storyboardClipIds, storyboardOf, storyboardProgress, withAppendedShot, withMovedShot, withRemovedShot, withShot } from '../storyboard.ts'
import { findingsByShot, shotsWithFindings, storyboardFindings, worstLevel } from '../storyboard-lint.ts'
import { castMembers } from '../cast.ts'
import { describeVideoModel, VIDEO_RESOLUTIONS } from '../../video-model-catalog.ts'
import { ModelPicker, resolveModelChoice } from '../ModelPicker.tsx'
import type { ImageModelGroup } from '../settings-scope.ts'
import type { ShotState } from '../storyboard.ts'
import css from '../canvas-workspace.module.css'

/** One shot's label, used for its state chip and its button. */
function shotStateLabel(state: ShotState): ImageGenKey {
  switch (state) {
    case 'ready': return 'canvas.storyboard.stateReady'
    case 'generating': return 'canvas.storyboard.stateGenerating'
    case 'failed': return 'canvas.storyboard.stateFailed'
    default: return 'canvas.storyboard.stateEmpty'
  }
}

/**
 * The storyboard node's body: a settings strip, the shot list, and the two
 * actions that move the board forward.
 *
 * It is a controlled component in the strict sense — every edit goes out
 * through `onChange` and comes back as a new document — so undo/redo, autosave
 * and the multi-window revision check all keep working without the board
 * knowing they exist. The only local state is which row the pointer is over.
 *
 * The produced clips are NOT rendered here. They are ordinary video nodes to
 * the right of the board, which is what makes them previewable, favoritable and
 * stitchable with no extra plumbing; this body shows each row's state and the
 * two shortcuts (preview, retry) that make those nodes reachable from the list.
 */
export function StoryboardBody(props: {
  node: CanvasNode
  nodes: readonly CanvasNode[]
  /** Video channels and their model aliases; the same list the composer uses. */
  videoGroups?: ImageModelGroup[]
  /** Fallback channel when neither the board nor the composer names one. */
  defaultChannelId?: string
  /** The composer's current video choice, shown when the board names none. */
  defaultVideoChannelId?: string
  /**
   * The video model a shot will actually be submitted with, when the board
   * names none of its own.
   *
   * `submitShot` resolves an unset board model against the composer's current
   * video choice, so that choice IS the model every shot runs on. It has to be
   * passed in, because this body cannot read settings. Without it `catalog`
   * stayed undefined on every real board and the duration picker offered all
   * seven lengths regardless of what the model accepts — the narrowing code
   * existed but was unreachable.
   */
  defaultVideoModel?: string
  busy: boolean
  onChange: (next: CanvasStoryboard) => void
  onRun: () => void
  onRunShot: (index: number) => void
  onPreview: (nodeId: string) => void
  onStitch: (ids: string[]) => void
  /**
   * 把这一集做出来的东西写回项目目录。
   *
   * 只有从文档铺出来的板才有去向（`storyboard.source`）；手画的板这里是
   * `undefined`，按钮也就不会出现——猜一个目录等于把用户的成片写进别人的
   * 项目里。
   */
  onWriteback?: () => void
  /** 回写进行中；与 `busy` 分开是因为它不该禁掉「运行」按钮。 */
  writebackBusy?: boolean
}): React.JSX.Element {
  const board = storyboardOf(props.node)
  const progress = storyboardProgress(board, props.nodes)
  const clipIds = storyboardClipIds(board, props.nodes)
  const nextIndex = nextShotIndex(board, props.nodes)
  const [hovered, setHovered] = useState<string | null>(null)
  // `nextShotIndex` is the single rule for "which shot runs next", and in
  // `carry` mode it answers -1 while the predecessor has no clip yet. The run
  // button follows it rather than counting empty rows itself, so the button and
  // the submit can never disagree about whether a run is possible.
  const runnable = nextIndex >= 0
  // The settings strip follows the board's model, the same way the composer and
  // the studio panel do. MiniMax-H3 accepts exactly one tier (768P) and answers
  // 720P with a 400, so a fixed three-option list would offer two choices that
  // cannot work. A resolution the model does not list is kept as a choice
  // rather than dropped: it is what the board already says, and silently
  // rewriting the user's document on open is worse than showing a stale row.
  // An unset model means "the channel default", which this body cannot resolve
  // on its own (the default lives in settings), so the full list is offered
  // rather than the unknown-family list -- that one exists to describe a model
  // we cannot classify, not the absence of a model.
  const named = (board.model ?? '').trim()
  const effectiveModel = named !== '' ? named : (props.defaultVideoModel ?? '').trim()
  const catalog = effectiveModel === '' ? undefined : describeVideoModel(effectiveModel)
  const resolutionOptions = catalog !== undefined && catalog.resolutions.length > 0 ? catalog.resolutions : VIDEO_RESOLUTIONS
  const resolutionChoices = resolutionOptions.includes(board.resolution as VideoResolution)
    ? resolutionOptions
    : [board.resolution as VideoResolution, ...resolutionOptions]
  const aspectOptions = catalog !== undefined && catalog.aspectRatios.length > 0 ? catalog.aspectRatios : ['16:9', '9:16', '1:1']
  /**
   * Shots that will run WITHOUT the pinned identities, and how many identities
   * that costs them.
   *
   * `carry` spends both frame slots on the join (`first_frame` / `last_frame`
   * exclude `reference_image` — see `minimaxRole` in the engine), so from the
   * second shot onward the pinned faces do not travel. That is the correct
   * trade when a cut would break the join, but it is invisible: the user pinned
   * 「阿禾」 once and reasonably expects every shot to look like her. The board
   * says which rows lose her instead of letting the drift show up in the render.
   */
  const pinned = castMembers(props.nodes).length
  const castless = new Set(shotsWithoutCast(board, pinned))
  /**
   * 板自己的模型优先；没选过就显示真正会被提交的那个默认模型。
   *
   * 分镜板原先没有选择器，用户只能改设置里的默认值，或者根本不知道这一镜
   * 走的是哪条渠道。选择器写回 `board.model` / `board.channelId`，`submitShot`
   * 本来就读这两个字段；默认值则与提交路径共用同一份解析，避免「板上显示
   * A、实际提交 B」。
   */
  const videoGroups = props.videoGroups ?? []
  const boardNamesModel = (board.model ?? '').trim() !== ''
  const modelChoice = resolveModelChoice(
    videoGroups,
    boardNamesModel
      ? { channelId: board.channelId, model: board.model }
      : { channelId: props.defaultVideoChannelId, model: props.defaultVideoModel },
    props.defaultChannelId,
  )
  /**
   * 体检结论，随每次渲染重算。
   *
   * 不 memo：输入是这份 board 与 nodes，两者都是新的引用就已经变了；而重算
   * 本身是「每镜一次名字子串 + 一次正则扫」，40 镜上限下远比一次 React 渲染
   * 便宜。memo 在这里只会带来「忘了把它加进依赖」这一类 bug。
   */
  const findings = storyboardFindings(board, props.nodes)
  const problemShots = shotsWithFindings(findings)
  const level = worstLevel(findings)
  const [lintOpen, setLintOpen] = useState(false)
  // A shot's length is the model's own vocabulary, narrowed to the editorial
  // set: snapgen accepts 6 / 10 / 15, muse only 10. Offering a 4 on a model that
  // answers with a 400 costs a failed submit per attempt, so the picker only
  // shows numbers the chosen model documents.
  //
  // `catalog.durations`, NOT `durationsOf(catalog)`: the latter answers the
  // panel's generic 5/10 default when a family declares nothing, and using that
  // here would silently drop 4 / 6 / 8 / 12 / 15 from every model that accepts
  // a range (Seedance takes 4-15). Only a DECLARED set is evidence.
  const secondsOptions = shotSecondsOptions(catalog?.durations)
  return <div className={css.storyboardBody} data-storyboard-body="" onPointerDown={event => event.stopPropagation()}>
    <div className={css.storyboardSettings}>
      <div className={`${css.storyboardField} ${css.storyboardModelField}`} data-storyboard-model="">
        <span>{tt('canvas.storyboard.model')}</span>
        <ModelPicker
          groups={videoGroups}
          value={modelChoice}
          variant="toolbar"
          channelLabel={tt('model.channel')}
          modelLabel={tt('video.model')}
          channelPlaceholder={tt('model.channelPlaceholder')}
          emptyLabel={tt('canvas.videoNoModel')}
          ariaLabel={tt('canvas.storyboard.modelAria')}
          disabled={props.busy}
          onChange={choice => props.onChange({ ...board, model: choice.model, channelId: choice.channelId })}
        />
      </div>
      <label className={css.storyboardField}>
        <span>{tt('canvas.storyboard.continuity')}</span>
        <select
          className={css.storyboardSelect}
          value={board.continuity}
          aria-label={tt('canvas.storyboard.continuity')}
          onChange={event => props.onChange({ ...board, continuity: event.target.value === 'carry' ? 'carry' : 'cut' })}
        >
          <option value="cut">{tt('canvas.storyboard.continuityCut')}</option>
          <option value="carry">{tt('canvas.storyboard.continuityCarry')}</option>
        </select>
      </label>
      <label className={css.storyboardField}>
        <span>{tt('canvas.videoAspect')}</span>
        <select
          className={css.storyboardSelect}
          value={board.aspectRatio}
          aria-label={tt('canvas.videoAspect')}
          onChange={event => props.onChange({ ...board, aspectRatio: event.target.value })}
        >
          {aspectOptions.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className={css.storyboardField}>
        <span>{tt('canvas.videoResolution')}</span>
        <select
          className={css.storyboardSelect}
          value={board.resolution}
          aria-label={tt('canvas.videoResolution')}
          onChange={event => props.onChange({ ...board, resolution: event.target.value })}
        >
          {resolutionChoices.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>

    <p className={css.storyboardHint} data-storyboard-spec-hint="">{tt('canvas.storyboard.specHelp')}</p>

    {/* 体检摘要。只在真有问题时出现：一条永远挂着的「检查通过」会变成墙纸，
        用户三天就学会无视整行——那比不显示更糟。 */}
    {level === undefined ? null : <div className={css.storyboardLint} data-storyboard-lint={level}>
      <button
        type="button"
        className={css.storyboardLintHead}
        data-level={level}
        aria-expanded={lintOpen}
        onClick={() => setLintOpen(open => !open)}
      >
        <span data-storyboard-lint-count="">{tt('canvas.storyboard.lintSummary', { count: problemShots })}</span>
        <span className={css.storyboardLintToggle}>{tt(lintOpen ? 'canvas.storyboard.lintClose' : 'canvas.storyboard.lintOpen')}</span>
      </button>
      {lintOpen ? <ul className={css.storyboardLintList} data-storyboard-lint-list="">
        {findings.map((finding, index) => <li
          key={`${finding.shotIndex}:${finding.rule}:${index}`}
          className={css.storyboardLintItem}
          data-level={finding.level}
        >
          <span className={css.storyboardLintShot}>{finding.shotIndex + 1}</span>
          <span>{tt(finding.key, finding.params)}</span>
        </li>)}
      </ul> : null}
    </div>}

    {/* 只有在真的会丢身份参考时才出现。一直显示会让「每镜独立」的板也挂着一句
        无关的警告，用户就会学会忽略这一行——那比不显示更糟。 */}
    {castless.size === 0 ? null : <p
      className={css.storyboardCastWarn}
      data-storyboard-cast-warn=""
      title={tt('canvas.storyboard.castDroppedHint')}
    >{tt('canvas.storyboard.castDroppedBar', { count: castless.size, cast: pinned })}</p>}

    {board.shots.length === 0
      ? <div className={css.storyboardEmpty}>{tt('canvas.storyboard.empty')}</div>
      : <ol className={css.storyboardShots} data-storyboard-shots="">
          {board.shots.map((shot, index) => {
            const state = shotState(shot, props.nodes)
            const clippable = shotNodeOf(shot, props.nodes)
            const active = hovered === shot.id || index === nextIndex
            // A board written by an older build can hold a length the current
            // model no longer accepts. Keep it as a choice rather than silently
            // rewriting the document: the row has to show what will be sent.
            // Only a REAL number is worth keeping as an extra option; a NaN
            // would render an option labelled "NaN" that selects nothing.
            const secondsChoices = secondsOptions.includes(shot.seconds) || !Number.isFinite(shot.seconds)
              ? secondsOptions
              : [shot.seconds, ...secondsOptions]
            const speech = shotSpeechFit(shot)
            const dropsCast = castless.has(index)
            const shotFindings = findingsByShot(findings, index)
            const shotLevel = worstLevel(shotFindings)
            return <li
              key={shot.id}
              className={css.storyboardShot}
              data-state={state}
              data-active={active ? '' : undefined}
              data-shot-id={shot.id}
              data-cast-dropped={dropsCast ? '' : undefined}
              onMouseEnter={() => setHovered(shot.id)}
              onMouseLeave={() => setHovered(previous => previous === shot.id ? null : previous)}
            >
              <div className={css.storyboardShotHead}>
                <span className={css.storyboardShotIndex}>{index + 1}</span>
                <span className={css.storyboardShotState} data-state={state}>{tt(shotStateLabel(state))}</span>
                {/* 一粒角标，而不是整行变色：这一镜仍然能跑、仍然有用，只是
                    少了钉住的脸。用警示色画整行会让用户以为它坏了。 */}
                {dropsCast ? <span
                  className={css.storyboardCastChip}
                  data-cast-chip=""
                  title={tt('canvas.storyboard.castDroppedHint')}
                >{tt('canvas.storyboard.castDroppedChip')}</span> : null}
                {/* 这一镜自己的体检结论。与上面的参考图角标不同：那个说「板
                    会丢参考图」，这个说「这一镜真的会因此出问题」。 */}
                {shotLevel === undefined ? null : <span
                  className={css.storyboardLintChip}
                  data-lint-chip={shotLevel}
                  data-lint-count={shotFindings.length}
                  title={shotFindings.map(finding => tt(finding.key, finding.params)).join('\n')}
                >{shotFindings.length}</span>}
                <span className={css.storyboardShotActions}>
                  <button
                    type="button"
                    className={css.storyboardIconButton}
                    title={tt('canvas.storyboard.moveUp')}
                    aria-label={tt('canvas.storyboard.moveUp')}
                    disabled={index === 0}
                    onClick={() => props.onChange(withMovedShot(board, index, -1))}
                  >↑</button>
                  <button
                    type="button"
                    className={css.storyboardIconButton}
                    title={tt('canvas.storyboard.moveDown')}
                    aria-label={tt('canvas.storyboard.moveDown')}
                    disabled={index === board.shots.length - 1}
                    onClick={() => props.onChange(withMovedShot(board, index, 1))}
                  >↓</button>
                  <button
                    type="button"
                    className={css.storyboardIconButton}
                    title={tt('canvas.storyboard.removeShot')}
                    aria-label={tt('canvas.storyboard.removeShot')}
                    data-danger=""
                    onClick={() => props.onChange(withRemovedShot(board, index))}
                  >×</button>
                </span>
              </div>
              <textarea
                className={css.storyboardShotPrompt}
                value={shot.prompt}
                rows={2}
                placeholder={tt('canvas.storyboard.promptPlaceholder')}
                aria-label={tt('canvas.storyboard.shot', { index: index + 1 })}
                onChange={event => props.onChange(withShot(board, index, { prompt: event.target.value }))}
              />
              <div className={css.storyboardShotFoot}>
                <select
                  className={css.storyboardSelect}
                  value={String(shot.seconds)}
                  aria-label={tt('canvas.storyboard.seconds', { seconds: shot.seconds })}
                  onChange={event => props.onChange(withShot(board, index, { seconds: Number(event.target.value) }))}
                >
                  {secondsChoices.map(value => <option key={value} value={String(value)}>{tt('canvas.videoDuration', { seconds: value })}</option>)}
                </select>
                {state === 'failed' || state === 'empty'
                  ? <button
                      type="button"
                      className={css.storyboardShotRun}
                      data-state={state}
                      disabled={props.busy || shot.prompt.trim() === ''}
                      onClick={() => props.onRunShot(index)}
                    >{tt(state === 'failed' ? 'canvas.storyboard.retryShot' : 'canvas.storyboard.runShot')}</button>
                  : state === 'ready' && clippable !== undefined
                    ? <button
                        type="button"
                        className={css.storyboardShotRun}
                        data-state="ready"
                        onClick={() => props.onPreview(clippable.id)}
                      >{tt('canvas.storyboard.previewShot')}</button>
                    : <span className={css.storyboardShotState} data-state="generating">{tt('canvas.storyboard.stateGenerating')}</span>}
              </div>
              {/* 台词装不下只是提醒：它按 4.5 字/秒的经验值估，用户可能就是要说得快。
                  放进按钮行会把 62px 的时长下拉挤变形，所以单独占一行。 */}
              {speech.fits ? null : <span
                className={css.storyboardSpeechWarn}
                data-storyboard-speech-warn=""
              >{tt('canvas.storyboard.speechTooLong', { seconds: Math.ceil(speech.required) })}</span>}
            </li>
          })}
        </ol>}

    <div className={css.storyboardFoot}>
      <button
        type="button"
        className={css.storyboardAdd}
        disabled={board.shots.length >= MAX_SHOTS}
        title={tt('canvas.storyboard.addShot')}
        onClick={() => props.onChange(withAppendedShot(board))}
      >{tt('canvas.storyboard.addShot')}</button>
      <span className={css.storyboardSpacer} />
      {/* 回写只在从文档铺出来的板上出现。手画的板没有去向，摆一个按不了的
          按钮只会让用户猜「为什么它灰着」。 */}
      {props.onWriteback === undefined ? null : <button
        type="button"
        className={css.storyboardStitch}
        data-storyboard-writeback=""
        disabled={props.writebackBusy === true}
        title={tt('canvas.drama.writebackHint')}
        onClick={props.onWriteback}
      >{tt(props.writebackBusy === true ? 'canvas.drama.writebackRunning' : 'canvas.drama.writeback')}</button>}
      <button
        type="button"
        className={css.storyboardStitch}
        disabled={clipIds.length < 2 || props.busy}
        title={tt('canvas.storyboard.stitch')}
        onClick={() => props.onStitch(clipIds)}
      >{tt('canvas.storyboard.stitch')}</button>
      <button
        type="button"
        className={css.storyboardRun}
        disabled={props.busy || !runnable}
        onClick={props.onRun}
      >{tt(board.continuity === 'carry' ? 'canvas.storyboard.runNext' : 'canvas.storyboard.runAll')}</button>
    </div>
  </div>
}

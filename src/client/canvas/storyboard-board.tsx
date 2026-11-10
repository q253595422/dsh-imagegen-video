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
import type { CanvasNode, CanvasStoryboard } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { MAX_SHOTS, SHOT_SECONDS, nextShotIndex, shotNodeOf, shotState, storyboardClipIds, storyboardOf, storyboardProgress, withAppendedShot, withMovedShot, withRemovedShot, withShot } from '../storyboard.ts'
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
  busy: boolean
  onChange: (next: CanvasStoryboard) => void
  onRun: () => void
  onRunShot: (index: number) => void
  onPreview: (nodeId: string) => void
  onStitch: (ids: string[]) => void
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
  return <div className={css.storyboardBody} data-storyboard-body="" onPointerDown={event => event.stopPropagation()}>
    <div className={css.storyboardSettings}>
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
          {['16:9', '9:16', '1:1'].map(value => <option key={value} value={value}>{value}</option>)}
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
          {(['480P', '720P', '1080P'] as const).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>

    {board.shots.length === 0
      ? <div className={css.storyboardEmpty}>{tt('canvas.storyboard.empty')}</div>
      : <ol className={css.storyboardShots} data-storyboard-shots="">
          {board.shots.map((shot, index) => {
            const state = shotState(shot, props.nodes)
            const clippable = shotNodeOf(shot, props.nodes)
            const active = hovered === shot.id || index === nextIndex
            return <li
              key={shot.id}
              className={css.storyboardShot}
              data-state={state}
              data-active={active ? '' : undefined}
              data-shot-id={shot.id}
              onMouseEnter={() => setHovered(shot.id)}
              onMouseLeave={() => setHovered(previous => previous === shot.id ? null : previous)}
            >
              <div className={css.storyboardShotHead}>
                <span className={css.storyboardShotIndex}>{index + 1}</span>
                <span className={css.storyboardShotState} data-state={state}>{tt(shotStateLabel(state))}</span>
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
                  {SHOT_SECONDS.map(value => <option key={value} value={String(value)}>{tt('canvas.videoDuration', { seconds: value })}</option>)}
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

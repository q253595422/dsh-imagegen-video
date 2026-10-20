/**
 * 时间线编辑面板：把选中的几段视频排好、剪好、选好转场，再交给拼接。
 *
 * 它不自己生成、不自己调 ffmpeg——按下「拼接」时把一条 {@link Timeline}
 * 序列化进技能参数，走的还是既有那条 compose 链路。这样时间线只是拼接的
 * 一个更完整的输入，而不是第二套成片系统。
 *
 * 设计上有一条硬约束：**每一段仍然是一个普通的视频节点**。面板只决定顺序
 * 与裁剪，不搬动素材，也不新增节点类型——用户关掉面板后，画布上还是那几
 * 个节点，预览/收藏/重试全都照旧。
 */

import { useCallback, useMemo, useState } from 'react'
import css from './timeline.module.css'
import {
  DEFAULT_TRANSITION,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  normalizeTransitions,
  placeTimeline,
  timelineSeconds,
  type Timeline,
  type TimelineTransition,
  type TimelineTransitionKind,
} from './timeline.ts'
import { tt } from './helpers.ts'

/** 面板用得到的一个素材（由调用方从画布节点里取）。 */
export interface TimelineClipView {
  nodeId: string
  title: string
  /** 真实时长；未知时按 0 处理，只影响显示，不影响拼接。 */
  seconds: number
  /** 成片地址。画布的片子没有封面字段，直接拿它当缩略图。 */
  src?: string
}

export interface TimelinePanelProps {
  clips: readonly TimelineClipView[]
  /** 初值：进来时按当前顺序排好、整段使用。 */
  initial?: Timeline
  busy: boolean
  onCancel: () => void
  /** 提交：把这条时间线交给拼接。 */
  onSubmit: (timeline: Timeline) => void
}

/** 把秒数写成 `m:ss.s`，时间线上比裸数字好读。 */
function clock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

export function TimelinePanel(props: TimelinePanelProps): React.JSX.Element {
  const byId = useMemo(() => new Map(props.clips.map(clip => [clip.nodeId, clip])), [props.clips])
  const [timeline, setTimeline] = useState<Timeline>(() => props.initial ?? {
    segments: props.clips.map((clip, index) => ({ id: `seg-${index + 1}-${clip.nodeId.slice(-6)}`, nodeId: clip.nodeId, inPoint: 0 })),
    transitions: normalizeTransitions(props.clips.length, []),
    keepAudio: true,
  })

  const secondsOf = useCallback((nodeId: string): number | undefined => {
    const clip = byId.get(nodeId)
    return clip === undefined || clip.seconds <= 0 ? undefined : clip.seconds
  }, [byId])
  const clipSecondsOf = useCallback((segment: Timeline['segments'][number]) => secondsOf(segment.nodeId), [secondsOf])
  const total = timelineSeconds(timeline, clipSecondsOf)
  const placements = placeTimeline(timeline, clipSecondsOf)

  /** 结构变化后统一归一化转场，避免列表错位。 */
  const commit = useCallback((next: Timeline) => {
    setTimeline({ ...next, transitions: normalizeTransitions(next.segments.length, next.transitions) })
  }, [])

  const move = useCallback((index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= timeline.segments.length) return
    const segments = [...timeline.segments]
    const [moved] = segments.splice(index, 1)
    if (moved === undefined) return
    segments.splice(target, 0, moved)
    commit({ ...timeline, segments })
  }, [commit, timeline])

  const remove = useCallback((index: number) => {
    const segments = timeline.segments.filter((_, at) => at !== index)
    // 删掉一段后，它两侧的两个转场合成一个：保留前一个，位置自然对上。
    const transitions = timeline.transitions.filter((_, at) => at !== index)
    commit({ ...timeline, segments, transitions })
  }, [commit, timeline])

  const setTrim = useCallback((index: number, patch: { inPoint?: number; outPoint?: number | undefined }) => {
    const segments = timeline.segments.map((segment, at) => {
      if (at !== index) return segment
      const limit = secondsOf(segment.nodeId) ?? Number.POSITIVE_INFINITY
      const inPoint = Math.max(0, Math.min(patch.inPoint ?? segment.inPoint, limit))
      const outPoint = patch.outPoint === undefined && !('outPoint' in patch)
        ? segment.outPoint
        : patch.outPoint
      const clamped = outPoint === undefined ? undefined : Math.min(Math.max(outPoint, inPoint), limit)
      return { ...segment, inPoint, ...clamped === undefined ? { outPoint: undefined } : { outPoint: clamped } }
    })
    commit({ ...timeline, segments })
  }, [commit, secondsOf, timeline])

  const setTransition = useCallback((index: number, kind: TimelineTransitionKind) => {
    const previous = timeline.transitions[index] ?? DEFAULT_TRANSITION
    const next: TimelineTransition = {
      kind,
      seconds: kind === 'cut' ? 0 : Math.max(MIN_TRANSITION_SECONDS, Math.min(previous.seconds || 0.5, MAX_TRANSITION_SECONDS)),
    }
    commit({ ...timeline, transitions: timeline.transitions.map((item, at) => at === index ? next : item) })
  }, [commit, timeline])

  const setTransitionSeconds = useCallback((index: number, seconds: number) => {
    const previous = timeline.transitions[index] ?? DEFAULT_TRANSITION
    if (previous.kind === 'cut') return
    const clamped = Math.max(MIN_TRANSITION_SECONDS, Math.min(seconds, MAX_TRANSITION_SECONDS))
    commit({ ...timeline, transitions: timeline.transitions.map((item, at) => at === index ? { ...item, seconds: clamped } : item) })
  }, [commit, timeline])

  const canSubmit = timeline.segments.length >= 2 && !props.busy

  return <div className={css.panel} data-timeline-panel="" role="dialog" aria-label={tt('timeline.title')}>
    <header className={css.header}>
      <strong>{tt('timeline.title')}</strong>
      <span className={css.total} data-timeline-total="">{tt('timeline.total', { time: clock(total) })}</span>
      <span className={css.spacer} />
      <label className={css.toggle}>
        <input
          type="checkbox"
          checked={timeline.keepAudio}
          onChange={event => { commit({ ...timeline, keepAudio: event.target.checked }) }}
        />
        {tt('timeline.keepAudio')}
      </label>
      <button type="button" className={css.ghost} onClick={props.onCancel}>{tt('canvas.close')}</button>
      <button
        type="button"
        className={css.primary}
        disabled={!canSubmit}
        onClick={() => { props.onSubmit(timeline) }}
      >{props.busy ? tt('timeline.working') : tt('timeline.submit')}</button>
    </header>

    <ol className={css.track}>
      {timeline.segments.map((segment, index) => {
        const clip = byId.get(segment.nodeId)
        const limit = secondsOf(segment.nodeId) ?? 0
        const placement = placements[index]
        const transition = timeline.transitions[index]
        return <li key={segment.id} className={css.segment} data-timeline-segment={segment.nodeId}>
          <span className={css.index}>{index + 1}</span>
          {clip === undefined || clip.src === undefined
            ? <span className={css.posterFallback} aria-hidden="true" />
            : <video
                className={css.poster}
                src={clip.src}
                preload="metadata"
                muted
                playsInline
                aria-hidden="true"
                tabIndex={-1}
              />}
          <div className={css.body}>
            <div className={css.title} title={clip?.title ?? segment.nodeId}>{clip?.title ?? segment.nodeId}</div>
            <div className={css.meta}>
              <span>{tt('timeline.segmentLength', { time: clock(placement?.seconds ?? 0) })}</span>
              <span className={css.dim}>{tt('timeline.segmentStart', { time: clock(placement?.start ?? 0) })}</span>
            </div>
            {limit > 0 ? <div className={css.trim}>
              <label>
                {tt('timeline.inPoint')}
                <input
                  type="number"
                  min={0}
                  max={limit}
                  step={0.1}
                  value={Number(segment.inPoint.toFixed(1))}
                  onChange={event => { setTrim(index, { inPoint: Number(event.target.value) }) }}
                />
              </label>
              <label>
                {tt('timeline.outPoint')}
                <input
                  type="number"
                  min={segment.inPoint}
                  max={limit}
                  step={0.1}
                  placeholder={limit.toFixed(1)}
                  value={segment.outPoint === undefined ? '' : Number(segment.outPoint.toFixed(1))}
                  onChange={event => {
                    const raw = event.target.value
                    setTrim(index, { outPoint: raw === '' ? undefined : Number(raw) })
                  }}
                />
              </label>
            </div> : null}
          </div>
          <div className={css.actions}>
            <button type="button" aria-label={tt('timeline.moveUp')} disabled={index === 0} onClick={() => { move(index, -1) }}>↑</button>
            <button type="button" aria-label={tt('timeline.moveDown')} disabled={index === timeline.segments.length - 1} onClick={() => { move(index, 1) }}>↓</button>
            <button type="button" aria-label={tt('timeline.remove')} disabled={timeline.segments.length <= 2} onClick={() => { remove(index) }}>×</button>
          </div>
          {transition !== undefined ? <div className={css.seam} data-timeline-seam={index}>
            <select
              aria-label={tt('timeline.transition')}
              value={transition.kind}
              onChange={event => { setTransition(index, event.target.value as TimelineTransitionKind) }}
            >
              <option value="cut">{tt('timeline.kindCut')}</option>
              <option value="dissolve">{tt('timeline.kindDissolve')}</option>
              <option value="fade">{tt('timeline.kindFade')}</option>
            </select>
            {transition.kind === 'cut' ? null : <input
              type="number"
              aria-label={tt('timeline.transitionSeconds')}
              min={MIN_TRANSITION_SECONDS}
              max={MAX_TRANSITION_SECONDS}
              step={0.1}
              value={Number(transition.seconds.toFixed(1))}
              onChange={event => { setTransitionSeconds(index, Number(event.target.value)) }}
            />}
          </div> : null}
        </li>
      })}
    </ol>
  </div>
}

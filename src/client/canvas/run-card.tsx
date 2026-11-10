/**
 * 运行卡：画布上显示一次技能运行进度的浮动卡片。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。它只接 props（这次运行的状态与结果），
 * 不读画布 document、不发请求——运行本身由上层驱动。
 */

import { useEffect, useState } from 'react'
import type { CanvasNode, CanvasRect, CanvasSkillDescriptor, CanvasSkillOutput, CanvasSkillTask } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { tierLabel } from './skill-dialogs.tsx'
import css from '../canvas-workspace.module.css'

/** Live skill-run card rendered as an ephemeral canvas node. It is not part of
 *  the document: it appears the moment a run is queued (wired to its source
 *  node with an animated edge), reports the host's progress phases, and hands
 *  its place to the real output nodes when the run lands. */
export interface SkillRunTrace {
  /** Canvas the run was queued on (results must not graft onto another). */
  canvasId: string
  /** Source node the run grew out of. */
  nodeId: string
  ids: string[]
  skillId: string
  label: string
  tier: CanvasSkillDescriptor['tier']
  stage: string
  phase: NonNullable<CanvasSkillTask['phase']>
  status: 'queued' | 'running' | 'failed' | 'pending'
  /** Set when the run finished while another canvas was open; applied on return. */
  output?: CanvasSkillOutput
  error?: string
  startedAt: number
  rect: CanvasRect
}

export const RUN_NODE_SIZE = { width: 272, height: 132 }
const RUN_NODE_GAP = 64

/** World-space rect of the run card for one source node (stacked per node). */
export function runRectOf(source: CanvasNode, stackIndex: number): CanvasRect {
  return {
    x: source.x + source.width + RUN_NODE_GAP,
    y: source.y + stackIndex * (RUN_NODE_SIZE.height + 18),
    width: RUN_NODE_SIZE.width,
    height: RUN_NODE_SIZE.height,
  }
}

const RUN_STEPS_HEAVY: Array<'queued' | 'preparing' | 'running' | 'collecting'> = ['queued', 'preparing', 'running', 'collecting']
const RUN_STEPS_LIGHT: Array<'queued' | 'running'> = ['queued', 'running']

export function SkillRunCard(props: {
  taskId: string
  trace: SkillRunTrace
  onCancel: (taskId: string) => void
  onDismiss: (taskId: string) => void
  onRetry: (taskId: string, trace: SkillRunTrace) => void
}): React.JSX.Element {
  const { trace } = props
  const [, tickNow] = useState(0)
  const live = trace.status === 'queued' || trace.status === 'running'
  useEffect(() => {
    if (!live) return undefined
    const timer = window.setInterval(() => tickNow(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const elapsed = Math.max(0, Math.floor((Date.now() - trace.startedAt) / 1000))
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  // `local` reuses the light step list (queued -> running): stitching has no
  // agent phases, and inventing preparing/collecting dots would promise stages
  // the host never enters. Its own progress lives in the stage text below.
  const steps = trace.tier === 'heavy' ? RUN_STEPS_HEAVY : RUN_STEPS_LIGHT
  const phaseIndex = trace.status === 'failed'
    ? -1
    : trace.status === 'pending'
      ? steps.length
      : Math.max(0, steps.indexOf(trace.phase as 'queued' | 'preparing' | 'running' | 'collecting'))
  return <div
    className={css.skillRunNode}
    data-status={trace.status}
    data-skill-run={props.taskId}
    style={{ left: trace.rect.x, top: trace.rect.y, width: trace.rect.width, minHeight: trace.rect.height }}
    onPointerDown={event => event.stopPropagation()}
  >
    <header className={css.skillRunHeader}>
      {live ? <span className={css.skillRunSpinner} aria-hidden="true" /> : null}
      <span className={css.skillRunTitle} title={trace.label}>{trace.label}</span>
      <span className={css.skillTier} data-tier={trace.tier}>{tierLabel(trace.tier)}</span>
    </header>
    {trace.status === 'failed'
      ? <p className={css.skillRunError} title={trace.error}>{trace.error}</p>
      : <>
          <div className={css.skillRunSteps}>
            {steps.map((step, index) => <span
              key={step}
              className={css.skillRunStep}
              data-done={index < phaseIndex ? '' : undefined}
              data-active={index === phaseIndex ? '' : undefined}
            />)}
          </div>
          <p className={css.skillRunStage}>{trace.status === 'pending' ? tt('canvas.skills.stageDone') : trace.stage}</p>
        </>}
    <footer className={css.skillRunFooter}>
      <span className={css.skillRunElapsed} title={tt('canvas.skills.runElapsed')}>{clock}</span>
      <span style={{ flex: 1 }} />
      {trace.status === 'failed'
        ? <>
            <button type="button" className={css.skillRunBtn} onClick={() => props.onRetry(props.taskId, trace)}>{tt('canvas.skills.runRetry')}</button>
            <button type="button" className={css.skillRunBtn} onClick={() => props.onDismiss(props.taskId)}>{tt('canvas.close')}</button>
          </>
        : <button type="button" className={css.skillRunBtn} onClick={() => props.onCancel(props.taskId)}>{tt('canvas.skills.cancel')}</button>}
    </footer>
  </div>
}

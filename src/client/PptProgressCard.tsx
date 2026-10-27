import type { CanvasSkillTask } from '../protocol.ts'
import { tt } from './helpers.ts'
import css from './ppt-workspace.module.css'

export function PptProgressCard({ task, clock, onDiagnostic }: { task: CanvasSkillTask; clock: number; onDiagnostic: () => void }) {
  const progress = task.progress
  const active = task.status === 'queued' || task.status === 'running'
  const idle = Math.max(0, Math.floor((clock - (progress?.lastActivityAt ?? task.startedAt)) / 1000))
  const log = <ol className={css.activityLog}>{progress?.events.map((event, index) => <li key={index} data-state={event.state}>
    <time>{new Date(event.time).toLocaleTimeString()}</time><span>{event.label}</span>
  </li>)}</ol>
  return <section className={css.progressCard} data-ppt-progress="">
    <header><strong>{tt('ppt.progressTitle')}</strong><button type="button" data-ppt-diagnostic="" onClick={onDiagnostic}>{tt('ppt.diagnostic')}</button></header>
    {active ? <><p className={css.currentOperation} role="status">{progress?.currentOperation || task.stage || tt('ppt.working')}</p>
      <small>{tt('ppt.lastActivity', { seconds: idle })}</small>
      {idle >= 60 ? <p className={css.idleNote}>{tt('ppt.idleNote')}</p> : null}</> : null}
    {progress?.pages ? <div className={css.pageProgress}><strong>{tt('ppt.pageProgress', { done: progress.pages.filter(page => page.state === 'validated').length, total: progress.pages.length })}</strong>
      <ul>{progress.pages.map(page => <li key={page.page} data-state={page.state}>{tt('ppt.progressPage', { page: page.page })}<span>{tt(`ppt.pageState.${page.state}`)}</span></li>)}</ul>
    </div> : null}
    {progress?.events.length ? active ? log : <details><summary>{tt('ppt.activityHistory')}</summary>{log}</details> : active ? <p>{tt('ppt.waitingActivity')}</p> : null}
  </section>
}

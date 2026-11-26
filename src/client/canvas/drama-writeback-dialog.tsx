/**
 * 「写回文档」的确认卡。
 *
 * WHY 要一张卡而不是点一下直接写：回写会往用户的剧集目录里落文件、还会改
 * 《分镜.md》。这两件事都不该在没有任何预览的情况下发生——用户按下去之前
 * 要知道「会多几个文件、会有几行被改」，按下去之后才知道「哪几条成了、哪几
 * 条因为已经存在而没动」。
 *
 * 卡片只负责「说清楚 + 收两个选择」，算账在 `drama-writeback.ts`，写盘在
 * 宿主。这样这一层可以整块换掉而不用碰规则。
 */

import { useMemo, useRef, useState } from 'react'
import { tt } from '../helpers.ts'
import type { DramaWritePlan } from '../drama-writeback.ts'
import css from './capability-catalog.module.css'
import { useModalFocus } from './capability-catalog.tsx'

export interface DramaWritebackDialogProps {
  plan: DramaWritePlan
  /** 正在写；按钮切到「写入中」并全部禁用。 */
  busy: boolean
  /** 写入进度（第几个 / 共几个），写的时候显示。 */
  progress?: { done: number, total: number, label: string }
  onConfirm: (options: { useAsNextFrame: boolean, overwrite: boolean }) => void
  onClose: () => void
}

/** 一行摘要：「23 个片段」这种，说数量而不是把路径铺满一屏。 */
function writebackSummaryOf(plan: DramaWritePlan): string[] {
  const rows: string[] = []
  if (plan.media.length > 0) rows.push(tt('canvas.drama.writebackClips', { count: plan.media.length }))
  if (plan.images.length > 0) rows.push(tt('canvas.drama.writebackImages', { count: plan.images.length }))
  if (plan.frames.length > 0) rows.push(tt('canvas.drama.writebackFrames', { count: plan.frames.length }))
  return rows
}

export function DramaWritebackDialog (props: DramaWritebackDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  // 两个默认值都是「不动别人的东西」：
  //  - `useAsNextFrame` 会改《分镜.md》里别人的行，默认不勾。
  //  - `overwrite` 会顶掉上一次的成片，默认不勾。
  const [useAsNextFrame, setUseAsNextFrame] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  useModalFocus(dialogRef, props.onClose, '[data-drama-writeback-confirm]')

  const summary = useMemo(() => writebackSummaryOf(props.plan), [props.plan])
  const nothing = props.plan.media.length === 0 && props.plan.images.length === 0
  const { plan } = props

  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.drama.writebackTitle')}
      data-drama-writeback=""
      style={{ minWidth: 560, maxWidth: 720 }}
    >
      <header className={css.header}>
        <h2>{tt('canvas.drama.writebackTitle')}</h2>
        <p>{tt('canvas.drama.writebackHint', { episode: plan.source.episode })}</p>
      </header>

      {/* 目的地：用户要能一眼看出这些文件会落进哪一部剧。 */}
      <p data-drama-writeback-target="" style={{ margin: '0 0 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
        {plan.source.projectPath}/制作成果/
      </p>

      {summary.length > 0
        ? <ul style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.8 }}>
          {summary.map(row => <li key={row}>{row}</li>)}
        </ul>
        : <p role="alert">{tt('canvas.drama.writebackNothing')}</p>}

      {/* 没跑出片子的镜头要说出来。静默跳过会让用户以为 22 镜全写回去了。 */}
      {plan.skipped.length > 0
        ? <p data-drama-writeback-skipped="" style={{ opacity: 0.75, margin: '0 0 12px' }}>
          {tt('canvas.drama.writebackSkipped', { count: plan.skipped.length })}
        </p>
        : null}

      <div style={{ display: 'grid', gap: 8, margin: '0 0 12px' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={useAsNextFrame}
            onChange={event => setUseAsNextFrame(event.target.checked)}
            data-drama-writeback-next-frame=""
          />
          <span>
            {tt('canvas.drama.writebackNextFrame')}
            <br />
            {/* 把「为什么它默认不勾」直接写在旁边：这条会改《分镜.md》里的行。 */}
            <span style={{ opacity: 0.7, fontSize: 12 }}>{tt('canvas.drama.writebackNextFrameHint')}</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={event => setOverwrite(event.target.checked)}
            data-drama-writeback-overwrite=""
          />
          <span>
            {tt('canvas.drama.writebackOverwrite')}
            <br />
            {/* 覆盖会留 .bak，所以它并不可怕；但「重跑一次就把上一次顶掉」
                仍然该是用户明确选的，而不是默认行为。 */}
            <span style={{ opacity: 0.7, fontSize: 12 }}>{tt('canvas.drama.writebackOverwriteHint')}</span>
          </span>
        </label>
      </div>

      {props.progress !== undefined
        ? <p data-drama-writeback-progress="" style={{ margin: '0 0 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
          {props.progress.done}/{props.progress.total} · {props.progress.label}
        </p>
        : null}

      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12 }}>
        <button type="button" onClick={props.onClose} disabled={props.busy}>{tt('canvas.drama.cancel')}</button>
        <button
          type="button"
          onClick={() => props.onConfirm({ useAsNextFrame, overwrite })}
          disabled={props.busy || (nothing && !useAsNextFrame)}
          data-drama-writeback-confirm=""
        >
          {props.busy ? tt('canvas.drama.writebackRunning') : tt('canvas.drama.writebackConfirm')}
        </button>
      </footer>
    </div>
  </div>
}

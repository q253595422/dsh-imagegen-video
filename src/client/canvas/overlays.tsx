/**
 * 画布的四类瞬态浮层：全屏视频预览、错误提示、通知、工作流进度。
 *
 * 从 CanvasWorkspace.tsx 原样搬出。它们只决定「显示成什么样」，不决定
 * 「什么时候显示」——可见性由上层用条件渲染控制，这里拿到 props 就画。
 * 所以这个模块不读画布 document、不发请求、不持有状态。
 *
 * 搬运时保留的三处细节：
 *
 * 1. 视频预览在 `onError` 里把节点标进 `brokenVideoIds`。片段是按 URL 引用
 *    的，存储会淘汰旧文件，所以全屏视图可能打开在一个已经没了的片段上。
 *    标进同一份集合，节点与全屏视图才会给出同一个结论（关掉浮层，节点上
 *    显示坏了）。
 * 2. 错误提示的「重试」按钮绑定在一条错误上（`errorAction.forError`）。
 *    只有它属于当前这条错误时才出现——否则用户会点到上一次失败的重试。
 * 3. 工作流进度显示 `layer + 1`，因为后端是从 0 数层的，而人读的是「第几层」。
 */

import { tt } from '../helpers.ts'
import type { WorkflowProgress } from '../workflow-runner.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import css from '../canvas-workspace.module.css'

/** 一条可以「一键重试」的错误：动作属于它产生时的那条错误文本。 */
export interface CanvasErrorAction {
  forError: string
  label: string
  run: () => void
}

/** 全屏播放的那个视频节点。 */
export interface CanvasVideoPreview {
  node: { id: string }
  clip: { url: string }
}

export interface CanvasVideoPreviewOverlayProps {
  preview: CanvasVideoPreview
  onClose: () => void
  /** 片段加载失败：把节点标进 brokenVideoIds，与节点自身播放器保持一致。 */
  onClipBroken: (nodeId: string) => void
}

export function CanvasVideoPreviewOverlay({ preview, onClose, onClipBroken }: CanvasVideoPreviewOverlayProps): React.JSX.Element {
  return <div
    className={css.videoPreview}
    data-canvas-no-zoom=""
    data-video-preview=""
    role="dialog"
    aria-label={tt('canvas.videoPreview')}
    onClick={onClose}
  >
    <video
      className={css.videoPreviewPlayer}
      controls
      autoPlay
      preload="metadata"
      src={preview.clip.url}
      onClick={event => event.stopPropagation()}
      onError={() => onClipBroken(preview.node.id)}
    />
    <button
      type="button"
      className={css.videoPreviewClose}
      aria-label={tt('canvas.videoPreviewClose')}
      onClick={onClose}
    >×</button>
  </div>
}

export interface CanvasErrorToastProps {
  error: string
  action: CanvasErrorAction | null
  onDismiss: () => void
}

/** 失败提示。`action` 只在它属于当前这条错误时才会渲染出重试按钮。 */
export function CanvasErrorToast({ error, action, onDismiss }: CanvasErrorToastProps): React.JSX.Element {
  return <div className={css.errorToast} role="status" data-canvas-no-zoom="">
    <span>{error}</span>
    {action !== null && action.forError === error
      ? <button type="button" className={css.errorToastAction} onClick={() => { action.run(); onDismiss() }}>{action.label}</button>
      : null}
    <button type="button" aria-label={tt('canvas.dismiss')} onClick={onDismiss}><ToolbarIcon name="close" /></button>
  </div>
}

export interface CanvasNoticeToastProps {
  notice: string
  onDismiss: () => void
}

/** 一次性告知（不是错误）：比如「已钉住身份」。 */
export function CanvasNoticeToast({ notice, onDismiss }: CanvasNoticeToastProps): React.JSX.Element {
  return <div className={css.errorToast} data-variant="notice" role="status" data-canvas-no-zoom="">
    <span>{notice}</span>
    <button type="button" aria-label={tt('canvas.dismiss')} onClick={onDismiss}><ToolbarIcon name="close" /></button>
  </div>
}

export interface CanvasWorkflowProgressProps {
  progress: WorkflowProgress
  onCancel: () => void
}

/** 运行中的进度：用户要能看到「跑到第几层、还剩多少」，而不是一个转圈。 */
export function CanvasWorkflowProgressBar({ progress, onCancel }: CanvasWorkflowProgressProps): React.JSX.Element {
  return <div className={css.workflowBar} data-workflow-progress="" role="status" data-canvas-no-zoom="">
    <span className={css.nodeSpinner} aria-hidden="true" />
    <span>{tt('canvas.workflow.progress', {
      layer: Math.min(progress.layer + 1, progress.total),
      total: progress.total,
      done: progress.done,
      count: progress.count,
    })}</span>
    <button type="button" onClick={onCancel}>{tt('canvas.workflow.stop')}</button>
  </div>
}

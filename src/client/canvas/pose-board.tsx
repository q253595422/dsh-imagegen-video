/**
 * 画布上的姿势人偶节点：一块方形预览 + 预设条 + 逐关节的三轴滑杆。
 *
 * 与草图画板同一个路子：节点本体只是一份数据（`metadata.pose`），预览在这里
 * 用 Canvas 2D 画出来，导出时再画一张不带辅助线的 PNG 交给
 * `onAssetChange` 落成节点的普通图片资产。这样下游的生成、标注、图库、
 * 导出全都不需要知道「姿势」这件事存在——它就是一个 image 节点。
 *
 * 这里只接 props、回回调，不读画布 document、不发请求。撤销/重做、自动保存、
 * 多窗口版本检查因此都看不见它。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasAssetRef, CanvasNode } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import type { ImageGenApi } from '../api.ts'
import {
  DEFAULT_CAMERA, POSE_JOINT_GROUPS, POSE_PRESETS, drawPose, emptyRig, frameCamera,
  type PoseAngles, type PoseCamera, type PoseJoint, type PoseRig,
} from './pose-rig.ts'
import { POSE_EXPORT_SIZE, POSE_NODE_SIZE } from './constants.ts'
import css from '../canvas-workspace.module.css'

/** 一个关节的某一轴改了多少度，收进 [-180, 180]，避免滑杆把角度绕到看不清。 */
function clampAngle(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180
  return Math.round(wrapped)
}

/** 从节点 metadata 里读姿势；缺省给一份空骨架，老节点因此照样打得开。 */
export function poseOf(node: CanvasNode): PoseRig {
  const pose = node.metadata?.pose
  return pose === undefined ? emptyRig() : pose
}

/**
 * 把姿势画进一个 canvas 元素，按设备像素比放大。
 *
 * 抽出来是因为预览和导出画的是同一张图，只是辅助线开关与尺寸不同；分两份
 * 实现迟早会出现「预览里看着对，导出来不对劲」。
 */
function paint(canvas: HTMLCanvasElement, rig: PoseRig, size: number, guides: boolean, camera: PoseCamera): void {
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size
    canvas.height = size
  }
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // 取景在画之前统一算：调用方只关心「从哪个角度看」，不关心站多远。固定距离
  // 会让蹲姿缩成画面中央一小团、举手被裁掉——这是参考图最不该出现的两种构图。
  //
  // 背板固定是 `studio`（近白柔和径向渐变）。人偶是淡蓝灰的，必须配浅底——
  // 深色底会把体块压成一块发亮的剪影，关节球与骨骼线也就叠在一片黑上。
  // 导出图用同一块背板，下游模型才拿到与预览一致的明暗关系。
  drawPose(ctx, rig, { size, guides, background: null, backdrop: 'studio', camera: frameCamera(rig, camera) })
}

export function PoseBoard(props: {
  api: ImageGenApi
  node: CanvasNode
  rig: PoseRig
  onRigChange: (next: PoseRig) => void
  onAssetChange: (asset: CanvasAssetRef | undefined) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { node, rig } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [camera, setCamera] = useState<PoseCamera>(DEFAULT_CAMERA)
  // 默认选中的关节跟着最近一次编辑的组走，用户切轴时不必每次重挑。
  const [joint, setJoint] = useState<PoseJoint>('shoulderR')
  const [busy, setBusy] = useState(false)
  const rigRef = useRef(rig)
  rigRef.current = rig
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const callbacks = useRef({ onRigChange: props.onRigChange, onAssetChange: props.onAssetChange, onError: props.onError })
  callbacks.current = { onRigChange: props.onRigChange, onAssetChange: props.onAssetChange, onError: props.onError }

  const repaint = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const box = Math.max(120, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)))
    paint(canvas, rigRef.current, box, true, cameraRef.current)
  }, [])

  useEffect(() => { repaint() }, [repaint, rig, camera])

  // 尺寸变了要重画：画布靠 clientWidth 定 backing store，缩放画布时它才变。
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { repaint() })
    observer.observe(canvas)
    return () => { observer.disconnect() }
  }, [repaint])

  /** 拖动预览 = 环绕相机（只转视角，不改姿势）。 */
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  const onPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch }
  }
  const onPreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    if (start === null) return
    event.stopPropagation()
    const yaw = start.yaw + (event.clientX - start.x) * 0.5
    const pitch = Math.min(45, Math.max(-30, start.pitch + (event.clientY - start.y) * 0.3))
    setCamera(previous => ({ ...previous, yaw, pitch }))
  }
  const onPreviewPointerUp = (): void => { dragRef.current = null }

  const patchAngle = (axis: keyof PoseAngles, value: number): void => {
    const current = rigRef.current.joints[joint] ?? { x: 0, y: 0, z: 0 }
    const next: PoseRig = {
      ...rigRef.current,
      joints: { ...rigRef.current.joints, [joint]: { ...current, [axis]: clampAngle(value) } },
    }
    callbacks.current.onRigChange(next)
  }

  /**
   * 导出：按 POSE_EXPORT_SIZE 画一张不带辅助线的 PNG，上传成普通图片资产。
   *
   * 辅助线、关节标记、地面网格一律不画——那张图是给模型看的参考图，不是给
   * 人看的界面。预览与输出分离是这块面板唯一必须做对的事。
   */
  const exportPng = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const canvas = document.createElement('canvas')
        // 导出与预览用同一块浅色背板：人偶的淡蓝灰只有在这种底色上才分得
        // 出轮廓，铺深底会压成剪影。
        paint(canvas, rigRef.current, POSE_EXPORT_SIZE, false, cameraRef.current)
        const dataUrl = canvas.toDataURL('image/png')
        const asset = await props.api.canvasUpload(dataUrl, POSE_EXPORT_SIZE, POSE_EXPORT_SIZE, { origin: 'upload', originId: `pose-${node.id}` })
        props.onAssetChange(asset)
      } catch (caught) {
        props.onError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    })()
  }

  const angles = rig.joints[joint] ?? { x: 0, y: 0, z: 0 }
  const axes = [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as const

  return <div className={css.pose} data-canvas-no-zoom="">
    <div
      className={css.posePreview}
      onPointerDown={onPreviewPointerDown}
      onPointerMove={onPreviewPointerMove}
      onPointerUp={onPreviewPointerUp}
      onPointerCancel={onPreviewPointerUp}
      title={tt('canvas.pose.dragHint')}
    >
      <canvas ref={canvasRef} className={css.poseCanvas} />
    </div>

    <div className={css.posePresets} onPointerDown={event => event.stopPropagation()} role="group" aria-label={tt('canvas.pose.presets')}>
      {POSE_PRESETS.map(preset => <button
        key={preset.id}
        type="button"
        className={css.posePreset}
        aria-label={tt(preset.labelKey as ImageGenKey)}
        title={tt(preset.labelKey as ImageGenKey)}
        onClick={() => callbacks.current.onRigChange({ ...preset.rig, joints: { ...preset.rig.joints } })}
      >{tt(preset.labelKey as ImageGenKey)}</button>)}
    </div>

    <div className={css.poseControls} onPointerDown={event => event.stopPropagation()}>
      <div className={css.poseRow}>
        <select
          className={css.poseSelect}
          value={joint}
          aria-label={tt('canvas.pose.joint')}
          onChange={event => setJoint(event.target.value as PoseJoint)}
        >
          {POSE_JOINT_GROUPS.map(group => <optgroup key={group.labelKey} label={tt(group.labelKey as ImageGenKey)}>
            {group.joints.map(item => <option key={item} value={item}>{tt(`canvas.pose.joint.${item}` as ImageGenKey)}</option>)}
          </optgroup>)}
        </select>
        <span className={css.poseSpacer} />
        <button
          type="button"
          className={css.poseAction}
          disabled={busy}
          title={tt('canvas.pose.exportHint', { size: POSE_EXPORT_SIZE })}
          onClick={exportPng}
        ><ToolbarIcon name="image" size={13} />{busy ? tt('canvas.pose.exporting') : tt('canvas.pose.export')}</button>
      </div>

      {axes.map(([axis, label]) => <label key={axis} className={css.poseAxis}>
        <span className={css.poseAxisLabel}>{label}</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={angles[axis]}
          aria-label={`${tt(`canvas.pose.joint.${joint}` as ImageGenKey)} ${label}`}
          onChange={event => patchAngle(axis, Number(event.target.value))}
        />
        {/* 数字框与滑杆同一状态：滑杆给手感，数字给精度。只给滑杆是这个面板
            最容易踩的坑——200px 走完 360°，一格 1.8°，用户根本调不到 45°。 */}
        <input
          type="number"
          className={css.poseNumber}
          min={-180}
          max={180}
          step={1}
          value={angles[axis]}
          aria-label={`${tt(`canvas.pose.joint.${joint}` as ImageGenKey)} ${label}°`}
          onChange={event => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) patchAngle(axis, value)
          }}
        />
      </label>)}
    </div>

    <div className={css.poseFoot} onPointerDown={event => event.stopPropagation()}>
      <label className={css.poseFacing}>
        <span>{tt('canvas.pose.facing')}</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={5}
          value={rig.facing}
          aria-label={tt('canvas.pose.facing')}
          onChange={event => callbacks.current.onRigChange({ ...rigRef.current, facing: Number(event.target.value) })}
        />
        <span className={css.poseFacingValue}>{Math.round(rig.facing)}°</span>
      </label>
      <button
        type="button"
        className={css.poseAction}
        title={tt('canvas.pose.reset')}
        onClick={() => callbacks.current.onRigChange(emptyRig())}
      >{tt('canvas.pose.reset')}</button>
    </div>
    <span hidden data-pose-node-size={`${POSE_NODE_SIZE.width}x${POSE_NODE_SIZE.height}`} />
  </div>
}

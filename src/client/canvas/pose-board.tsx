/**
 * 画布上的导演台节点卡片：一块场景预览 + 机位名/打开入口 + 预设条 + 导出。
 *
 * 与草图画板同一个路子：节点本体只是一份数据（`metadata.stage`，老文档是
 * `metadata.pose`），预览在这里用 Canvas 2D 画出来，导出时再画一张不带辅助线
 * 的 PNG 交给 `onAssetChange` 落成节点的普通图片资产。这样下游的生成、标注、
 * 图库、导出全都不需要知道「导演台」这件事存在——它就是一个 image 节点。
 *
 * 这块卡片已经不负责摆姿势了：17 个关节的三轴滑杆搬进了全屏导演台面板
 * （`pose-stage-panel.tsx`）。卡片只留四样东西——能看见整台戏的预览、当前
 * 机位、一个打开全屏编辑的入口、以及导出当前机位快照。原因很直接：320×520
 * 的卡片里塞 51 个滑杆时，预览被挤成一条缝，用户看不到自己摆的是什么。
 *
 * 样式全部复用 `canvas-workspace.module.css` 里既有的 `.pose*` 类；只有
 * 「预览改成非正方形、吃掉剩余高度」这一处用内联 style——它是一条几何覆盖，
 * 不值得为它新增一个只在两个类之间差一个 aspect-ratio 的类名。
 *
 * 这里只接 props、回回调，不读画布 document、不发请求。撤销/重做、自动保存、
 * 多窗口版本检查因此都看不见它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasAssetRef, CanvasNode, CanvasPoseStage } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import type { ImageGenApi } from '../api.ts'
import { DEFAULT_CAMERA, POSE_PRESETS, emptyRig, type PoseCamera, type PoseRig } from './pose-rig.ts'
import { renderSceneToCanvas } from './pose-scene-render.ts'
import { currentCamera, stageOf } from './pose-stage.ts'
import { POSE_EXPORT_SIZE, POSE_NODE_SIZE } from './constants.ts'
import css from '../canvas-workspace.module.css'

/** 从节点 metadata 里读姿势；缺省给一份空骨架，老节点因此照样打得开。
 *
 * 保留这个名字与签名：`node-body.tsx` 与 `CanvasWorkspace.tsx` 都引用它，
 * 而它现在的含义收窄成「第一个角色的姿势」——`stageOf` 才是完整舞台的入口。 */
export function poseOf(node: CanvasNode): PoseRig {
  const pose = node.metadata?.pose
  return pose === undefined ? emptyRig() : pose
}

/**
 * 卡片要画的舞台。
 *
 * `stageOf` 优先读 `stage`，但这里再用 `rig` 覆盖第一个角色：父组件把改姿
 * 势的请求写回磁盘之前，`metadata.stage.actors[0].rig` 还是旧值，直接读它
 * 会让「点了预设、预览没动」。覆盖是安全的——`stagePatch` 的契约就是
 * `pose` 恒等于 `actors[0].rig`，稳定态下两者本来就相同。
 */
function stageForCard(node: CanvasNode, rig: PoseRig): CanvasPoseStage {
  const stage = stageOf(node.metadata)
  const [first, ...rest] = stage.actors
  return first === undefined
    ? stage
    : { ...stage, actors: [{ ...first, rig }, ...rest] }
}

export function PoseBoard(props: {
  api: ImageGenApi
  node: CanvasNode
  rig: PoseRig
  onRigChange: (next: PoseRig) => void
  onAssetChange: (asset: CanvasAssetRef | undefined) => void
  onError: (message: string) => void
  /** 打开全屏导演台。可选：父组件还没接线时卡片仍可用。 */
  onOpenStage?: () => void
}): React.JSX.Element {
  const { node, rig } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /**
   * The preset row scrolls horizontally (eleven presets never fit a 320px card)
   * and hides its scrollbar, so without a cue the last pill just looked sliced
   * in half. These two flags say which ends still have content off-screen; the
   * stylesheet turns them into a one-sided fade. `end: false` means "nothing
   * more to the right", which is also the state before the first measurement —
   * a fade over content the user can already see the end of is worse than none.
   */
  const presetRowRef = useRef<HTMLDivElement>(null)
  const [presetScroll, setPresetScroll] = useState({ start: false, end: false })
  const updatePresetScroll = useCallback((): void => {
    const row = presetRowRef.current
    if (row === null) return
    const max = row.scrollWidth - row.clientWidth
    setPresetScroll({ start: row.scrollLeft > 1, end: max - row.scrollLeft > 1 })
  }, [])
  // Measured, not assumed: the card resizes with zoom and with the node's own
  // width, so "does it overflow" changes without any React state changing.
  useEffect(() => {
    updatePresetScroll()
    const row = presetRowRef.current
    if (row === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => updatePresetScroll())
    observer.observe(row)
    return () => observer.disconnect()
  }, [updatePresetScroll])
  // 拖动预览 = 环绕相机（只转视角，不改舞台数据）。初值取当前机位，
  // 于是卡片一开始看到的就是用户在机位里摆好的那一个角度。
  const [camera, setCamera] = useState<PoseCamera>(DEFAULT_CAMERA)
  const [busy, setBusy] = useState(false)
  // 每次渲染都新建舞台对象的话，下面那个 `[repaint, stage, camera]` 的副作用
  // 会在任何一次父组件重渲染后重画整台戏（离屏画布 + 逐角色距离场）。
  // 舞台只依赖这两个来源，按它们记忆即可。
  const stage = useMemo(() => stageForCard(node, rig), [node.metadata, rig])
  // 离屏正方形画布：预览不是正方形，见 `repaint`。放 ref 里是为了跨帧复用，
  // 避免每帧 allocate 一张新 canvas。
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  if (offscreenRef.current === null && typeof document !== 'undefined') {
    offscreenRef.current = document.createElement('canvas')
  }
  const offscreen = offscreenRef.current ?? document.createElement('canvas')
  const stageRef = useRef(stage)
  stageRef.current = stage
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const repaint = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    if (cssWidth < 8 || cssHeight < 8) return
    const ratio = window.devicePixelRatio || 1
    // 按设备像素比放大 backing store：卡片在 2x 屏上按 CSS 像素画会明显发糊，
    // 而场景里的地面网格与细骨骼线正是最先糊掉的东西。
    const width = Math.max(64, Math.round(cssWidth * ratio))
    const height = Math.max(64, Math.round(cssHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const context = canvas.getContext('2d')
    if (context === null) return
    // `drawScene` 只接受正方形边长（投影以它定焦距、画家算法按中心深度排序，
    // 宽高比会破坏取景假设）。卡片里的预览不是正方形，所以先画进一张正方形
    // 的离屏画布，再居中贴到节点画布上，长边方向由天空色续铺。
    //
    // 不能直接 `renderSceneToCanvas(canvas, size, …)`：那个函数在尺寸不符时
    // 会把传入的画布重设成 size×size，于是刚设好的 backing store 与平移一起
    // 被抹掉，预览会跳成一张贴着左上角的正方形小图。
    const size = Math.min(width, height)
    offscreen.width = size
    offscreen.height = size
    renderSceneToCanvas(offscreen, size, stageRef.current, { camera: cameraRef.current })
    context.setTransform(1, 0, 0, 1, 0, 0)
    // 天空色铺满整块：短边出图在长边方向会留边，节点背景是浅色的，
    // 透出去就是一圈白边。
    context.fillStyle = stageRef.current.scene.sky
    context.fillRect(0, 0, width, height)
    context.drawImage(offscreen, Math.round((width - size) / 2), Math.round((height - size) / 2))
  }, [])

  useEffect(() => { repaint() }, [repaint, stage, camera])

  // 尺寸变了要重画：预览按 clientWidth/clientHeight 定 backing store，
  // 拖动节点边缘、缩放画布时它才变。
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { repaint() })
    observer.observe(canvas)
    return () => { observer.disconnect() }
  }, [repaint])

  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  const onPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    // 不拦下来的话，画布的框选会用同一个 pointerdown 抢走这次手势
    // （`isBackground` 只看目标是不是背景，卡片本体是节点内容）。
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

  /**
   * 导出：按 POSE_EXPORT_SIZE 画一张当前机位的场景快照，上传成普通图片资产。
   *
   * 辅助线、关节标记、地面网格的编辑态、视锥一律不画——那张图是给模型看的
   * 参考图，不是给人看的界面。预览与输出分离是这块面板唯一必须做对的事。
   */
  const exportPng = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const canvas = document.createElement('canvas')
        // 导出用舞台自己的机位，不用预览里那个自由环绕相机：用户要的是
        // 「机位拍到的那一帧」，而拖动预览只是临时看一眼。
        renderSceneToCanvas(canvas, POSE_EXPORT_SIZE, stageRef.current)
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

  const cameraIndex = Math.max(1, stage.cameras.findIndex(item => item.id === currentCamera(stage).id) + 1)

  return <div className={css.pose} data-canvas-no-zoom="">
    <div
      className={css.posePreview}
      // 几何覆盖：预览不再是正方形，而是吃掉卡片的剩余高度——矮卡片里
      // 一个正方形预览会把下面的工具栏与导出按钮挤出去。
      style={{ aspectRatio: 'auto', flex: '1 1 auto', minHeight: 96 }}
      onPointerDown={onPreviewPointerDown}
      onPointerMove={onPreviewPointerMove}
      onPointerUp={onPreviewPointerUp}
      onPointerCancel={onPreviewPointerUp}
      title={tt('canvas.pose.dragHint')}
    >
      <canvas ref={canvasRef} className={css.poseCanvas} />
    </div>

    <div className={css.poseRow} onPointerDown={event => event.stopPropagation()}>
      {/* 机位名用内联几何而不是新类名：它只是一段 11px 的次要文字，
          样式表由另一处统一维护，为一个只差一行字号/颜色的芯片新增类不值得。 */}
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tt('canvas.stage.cameraN', { index: cameraIndex })}
      </span>
      <span className={css.poseSpacer} />
      <button
        type="button"
        className={css.poseAction}
        disabled={props.onOpenStage === undefined}
        aria-label={tt('canvas.stage.open')}
        title={tt('canvas.stage.open')}
        onClick={() => props.onOpenStage?.()}
      ><ToolbarIcon name="expand" size={13} />{tt('canvas.stage.title')}</button>
    </div>

    <div
      className={css.posePresets}
      onPointerDown={event => event.stopPropagation()}
      role="group"
      aria-label={tt('canvas.pose.presets')}
      /* Which ends still have content scrolled away. Written from the real
       * scroll offsets so the CSS mask can fade exactly the side that continues
       * — a static fade on both ends would dim a row the user can already read
       * to the end of. */
      data-scroll-start={presetScroll.start ? '' : undefined}
      data-scroll-end={presetScroll.end ? '' : undefined}
      onScroll={updatePresetScroll}
      ref={presetRowRef}
    >
      {POSE_PRESETS.map(preset => <button
        key={preset.id}
        type="button"
        className={css.posePreset}
        aria-label={tt(preset.labelKey as ImageGenKey)}
        title={tt(preset.labelKey as ImageGenKey)}
        onClick={() => props.onRigChange({ ...preset.rig, joints: { ...preset.rig.joints } })}
      >{tt(preset.labelKey as ImageGenKey)}</button>)}
    </div>

    <div className={css.poseFoot} onPointerDown={event => event.stopPropagation()}>
      <button
        type="button"
        className={css.poseAction}
        disabled={busy}
        title={tt('canvas.pose.exportHint', { size: POSE_EXPORT_SIZE })}
        onClick={exportPng}
      ><ToolbarIcon name="image" size={13} />{busy ? tt('canvas.pose.exporting') : tt('canvas.pose.export')}</button>
    </div>
    <span hidden data-pose-node-size={`${POSE_NODE_SIZE.width}x${POSE_NODE_SIZE.height}`} />
  </div>
}

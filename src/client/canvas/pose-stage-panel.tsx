/**
 * 导演台的全屏面板：左栏排角色与机位、中间一块可以绕着看（或透过某台机位看）
 * 的视口、右栏调整场景与镜头。
 *
 * 与 `pose-board.tsx` 同一个约定：只接 props、回回调。画布 document、写盘、上传
 * 都在外面——这里连 `api` 都不拿，于是撤销/重做、自动保存、多窗口版本检查都看
 * 不见它。
 *
 * 两个刻意的取舍：
 *
 *  1. **视口是正方形**。`drawScene` 的投影以边长的一半为基准，拉伸成宽屏会把
 *     地面网格与人形一起拉扁；LibTV 的视口本身也接近正方形。宁可两侧留出面板
 *     底色，也不要一张变形的预览——用户会照着它判断站位。
 *  2. **拖动只转视角，不改姿势**。摆姿势是卡片上的事（那里有逐关节滑杆），
 *     全屏面板负责「谁站在哪、机位在哪」。两件事混在同一个手势里，用户想转个
 *     角度就会不小心改掉一个人的动作。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasPoseActor, CanvasPoseCamera, CanvasPoseScene, CanvasPoseStage } from '../../protocol.ts'
import { errorMessage, tt } from '../helpers.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import {
  addActor, addCamera, actorTransform, cameraFromSpec, currentCamera, currentRenderCamera,
  frameCameraSpec,
} from './pose-stage.ts'
import { makeProjector, solveRig, type PoseCamera, type PoseJoint } from './pose-rig.ts'
import { drawScene, renderSceneToCanvas } from './pose-scene-render.ts'
import { STAGE_CAPTURE_SIZE } from './constants.ts'
import css from './pose-stage-panel.module.css'

/** 机位截图的边长。取自 `constants.ts`，与文档声称的尺寸只有一处定义——
 *  两处各写一个数时，面板里的那张实际是 1024，而说明写的是 1280。 */
const CAPTURE_SIZE = STAGE_CAPTURE_SIZE

/** 拖拽超过这个距离（CSS 像素）就算「转视角」，不算「点选角色」。 */
const CLICK_SLOP = 4

export interface PoseStagePanelProps {
  stage: CanvasPoseStage
  /** 舞台变了就调它。父组件负责写盘与把 pose 镜像回 metadata。 */
  onStageChange: (next: CanvasPoseStage) => void
  /** 已连接的全景图（父组件从连线上取），没有就 null。 */
  pano: { url: string } | null
  /** 导出当前机位截图；父组件负责上传与落成节点资产。 */
  onCapture: (dataUrl: string, size: number) => void | Promise<void>
  /** 一句话描述场景；父组件拿去接生成链。 */
  onPrompt: (text: string) => void
  /** 挂载点：必须盖在画布之上。 */
  container: HTMLElement | null
  onClose: () => void
  onError: (message: string) => void
}

/** 视点模式：自由环绕（导演）或透过当前机位看。 */
type ViewMode = 'director' | 'camera'
/** 指针工具：拖动转视角，或点击选中画面里的人。 */
type PointerTool = 'orbit' | 'select'
/** 当前在左栏选中了什么，只影响右栏显示哪个名字输入框。 */
type Selection = { kind: 'actor' | 'camera'; id: string }

/** 一个浮点数的输入框：中间态允许空串，失焦时才回落到合法值。
 *
 * 直接把 `value` 绑成数字，用户删光内容会立刻被写回 0 并把光标甩到末尾——
 * 想输入「-1.5」时那个减号根本打不进去。 */
function NumberField(props: {
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  title?: string
  label: string
  onChange: (next: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(props.value)
  return <input
    type="number"
    className={css.number}
    value={shown}
    min={props.min}
    max={props.max}
    step={props.step ?? 1}
    disabled={props.disabled}
    title={props.title}
    aria-label={props.label}
    onChange={event => {
      const text = event.target.value
      setDraft(text)
      const parsed = Number(text)
      if (text.trim() === '' || !Number.isFinite(parsed)) return
      props.onChange(parsed)
    }}
    onBlur={() => setDraft(null)}
  />
}

export function PoseStagePanel(props: PoseStagePanelProps): React.JSX.Element {
  const { stage } = props
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(0)
  const [mode, setMode] = useState<ViewMode>('director')
  const [tool, setTool] = useState<PointerTool>('orbit')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [panoImage, setPanoImage] = useState<HTMLImageElement | null>(null)
  const [selection, setSelection] = useState<Selection>({ kind: 'actor', id: stage.actors[0]?.id ?? '' })

  const spec = currentCamera(stage)
  /** 机位自己的视角。机位参数一变就重算——用户改了机位位置却还看着旧角度，
   *  会以为输入框没生效。 */
  const stageCamera = useMemo(() => currentRenderCamera(stage), [stage])
  const [view, setView] = useState<PoseCamera>(stageCamera)

  // 机位切换 / 位置 / 视场角变化时把自由视角拉回机位的角度。
  const cameraKey = `${spec.id}|${spec.x},${spec.y},${spec.z}|${spec.targetX},${spec.targetY},${spec.targetZ}|${spec.fov}`
  useEffect(() => {
    setView(currentRenderCamera(stage))
    // `stage` 每改一次都是新对象，拿它当依赖会让拖动中的视角被不断重置；
    // 这里只关心「机位本身变了没有」，所以依赖那串键。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraKey])

  // 舞台里角色被删掉时，选中态要跟着落回第一个，否则右栏的名字输入框会
  // 绑到一个不存在的 id 上、变成一个改什么都无效的框。
  useEffect(() => {
    const exists = selection.kind === 'actor'
      ? stage.actors.some(actor => actor.id === selection.id)
      : stage.cameras.some(camera => camera.id === selection.id)
    if (exists) return
    const fallback = stage.actors[0]?.id ?? stage.cameras[0]?.id
    if (fallback !== undefined) setSelection({ kind: stage.actors[0] === undefined ? 'camera' : 'actor', id: fallback })
  }, [stage.actors, stage.cameras, selection])

  const renderCamera = mode === 'camera' ? stageCamera : view

  /** 左栏的搜索：只过滤列表，不影响舞台数据。
   *
   * 没有它的话那个输入框就是个空壳——用户输入什么都不会变，只会以为面板坏了。
   * 匹配名字，不匹配 id（id 是 `actor-3` 这种内部值，用户看不见）。 */
  const matches = (name: string): boolean => {
    const needle = query.trim().toLowerCase()
    return needle === '' || name.toLowerCase().includes(needle)
  }

  /* ------------------------------------------------------------ 量尺寸 */

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (wrapper === null) return
    const measure = (): void => {
      // 量内层而不是整块视口：`.viewport` 上下留了给顶部/底部浮动控件的位置，
      // 按外层量会让正方形画布伸到控件底下，人的脚就被那排按钮挡住了。
      const rect = wrapper.getBoundingClientRect()
      const box = Math.floor(Math.min(rect.width, rect.height))
      setSize(box > 40 ? box : 0)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    return () => { observer.disconnect() }
  }, [])

  /* ------------------------------------------------------------ 全景图 */

  useEffect(() => {
    const url = props.pano?.url
    if (url === undefined) { setPanoImage(null); return }
    let live = true
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => { if (live) setPanoImage(image) }
    image.onerror = () => {
      // 图片节点还没落盘、或者 URL 过期时这里会失败。天空色仍在，画面不至于
      // 空白；但要告诉用户「背景没接上」，否则他会以为全景功能坏了。
      if (live) props.onError(tt('canvas.stage.panoHint'))
    }
    image.src = url
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pano?.url])

  /* -------------------------------------------------------------- 绘制 */

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || size <= 0) return
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const backing = Math.round(size * ratio)
    if (canvas.width !== backing || canvas.height !== backing) {
      canvas.width = backing
      canvas.height = backing
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawScene(ctx, {
      size, stage, camera: renderCamera, guides: true,
      // 机位视角下不画视锥：取景框正好贴着画面边缘，画出来只是一圈噪点。
      frustum: mode === 'director',
      pano: panoImage,
    })
  }, [size, stage, renderCamera, mode, panoImage])

  /* ------------------------------------------------------------ 交互 */

  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number; moved: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // 画布的框选与拖拽挂在祖先上，不拦住就会把这一下抢走（见 pose-board 同一处理）。
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, moved: 0 }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const start = dragRef.current
    if (start === null) return
    event.stopPropagation()
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    start.moved = Math.max(start.moved, Math.hypot(dx, dy))
    // 机位视角是「这台摄像机看到的东西」，转它就是改了机位——那该在右栏里做，
    // 不该从一个手势偷偷发生。
    if (mode === 'camera') return
    setView({
      ...view,
      yaw: start.yaw + dx * 0.4,
      pitch: Math.max(-80, Math.min(80, start.pitch - dy * 0.3)),
    })
  }

  /** 点选：把点击处最近的角色选中。
   *
   * 用投影后的头部与髋部两个点判定——只看包围盒会把「站在同一列但前后相隔
   * 两米」的两个人判成同一个。 */
  const pickActor = useCallback((clientX: number, clientY: number): void => {
    const canvas = canvasRef.current
    if (canvas === null || size <= 0) return
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const { project } = makeProjector(size, renderCamera)
    let best: { id: string; distance: number } | null = null
    for (const actor of stage.actors) {
      const transform = actorTransform(stage, actor)
      const world = solveRig(actor.rig)
      for (const joint of ['head', 'hips'] as PoseJoint[]) {
        const point = world[joint]
        const rot = transform.rotation * Math.PI / 180
        const cos = Math.cos(rot)
        const sin = Math.sin(rot)
        const placed: [number, number, number] = [
          (point[0] * cos + point[2] * sin) * transform.scale + transform.offset[0],
          point[1] * transform.scale + transform.offset[1],
          (-point[0] * sin + point[2] * cos) * transform.scale + transform.offset[2],
        ]
        const screen = project(placed)
        if (screen === null) continue
        const distance = Math.hypot(screen[0] - px, screen[1] - py)
        // 阈值取画面的 14%：远一点的人也能点中，但不会把地面上的空白处
        // 判成某个人。
        if (distance > size * 0.14) continue
        if (best === null || distance < best.distance) best = { id: actor.id, distance }
      }
    }
    if (best !== null) setSelection({ kind: 'actor', id: best.id })
  }, [size, stage, renderCamera])

  const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    const start = dragRef.current
    dragRef.current = null
    if (start === null) return
    event.stopPropagation()
    if (tool === 'select' && start.moved <= CLICK_SLOP) pickActor(event.clientX, event.clientY)
  }

  const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
    if (mode === 'camera') return
    event.stopPropagation()
    // 滚轮缩放只改「站多远」，仍围绕同一个注视点转，不会把画面拉偏。
    const factor = Math.exp(event.deltaY * 0.0012)
    setView(current => ({
      ...current,
      distance: Math.max(0.6, Math.min(24, current.distance * factor)),
    }))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      props.onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [props])

  /* ------------------------------------------------------------ 写舞台 */

  const patchScene = (patch: Partial<CanvasPoseScene>): void => {
    props.onStageChange({ ...stage, scene: { ...stage.scene, ...patch } })
  }
  const patchActor = (id: string, patch: Partial<CanvasPoseActor>): void => {
    props.onStageChange({ ...stage, actors: stage.actors.map(actor => actor.id === id ? { ...actor, ...patch } : actor) })
  }
  const patchCamera = (id: string, patch: Partial<CanvasPoseCamera>): void => {
    props.onStageChange({ ...stage, cameras: stage.cameras.map(camera => camera.id === id ? { ...camera, ...patch } : camera) })
  }

  const removeActor = (id: string): void => {
    if (stage.actors.length <= 1) return
    props.onStageChange({ ...stage, actors: stage.actors.filter(actor => actor.id !== id) })
  }
  const removeCamera = (id: string): void => {
    if (stage.cameras.length <= 1) return
    const cameras = stage.cameras.filter(camera => camera.id !== id)
    props.onStageChange({
      ...stage,
      cameras,
      cameraId: stage.cameraId === id ? cameras[0]!.id : stage.cameraId,
    })
  }

  const resetView = (): void => {
    const framed = frameCameraSpec(stage, spec)
    if (mode === 'camera') {
      patchCamera(framed.id, framed)
      return
    }
    // 导演视角不写盘：它是一次看待方式，不是舞台的一部分。
    setView(cameraFromSpec(framed))
  }

  const capture = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const canvas = document.createElement('canvas')
        renderSceneToCanvas(canvas, CAPTURE_SIZE, stage, { pano: panoImage })
        await props.onCapture(canvas.toDataURL('image/png'), CAPTURE_SIZE)
      } catch (caught) {
        props.onError(errorMessage(caught))
      } finally {
        setBusy(false)
      }
    })()
  }

  const submitPrompt = (): void => {
    const text = prompt.trim()
    if (text === '') return
    try {
      props.onPrompt(text)
      setPrompt('')
    } catch (caught) {
      props.onError(errorMessage(caught))
    }
  }

  const selectedActor = selection.kind === 'actor'
    ? stage.actors.find(actor => actor.id === selection.id)
    : undefined
  const selectedCamera = selection.kind === 'camera'
    ? stage.cameras.find(camera => camera.id === selection.id)
    : undefined

  const body = <div className={css.root} data-canvas-no-zoom="" role="dialog" aria-modal="true" aria-label={tt('canvas.stage.title')}>
    <div className={css.scrim} onPointerDown={props.onClose} />

    <div className={css.shell} onPointerDown={event => event.stopPropagation()}>
      {/* ---------------------------------------------------- 左栏 */}
      <aside className={leftCollapsed ? `${css.sidebar} ${css.sidebarCollapsed}` : css.sidebar}>
        <header className={css.sideHeader}>
          <span className={css.sideTitle}>{tt('canvas.stage.title')}</span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={tt('canvas.stage.scene')}
            title={tt('canvas.stage.scene')}
            aria-pressed={leftCollapsed}
            onClick={() => setLeftCollapsed(current => !current)}
          ><ToolbarIcon name={leftCollapsed ? 'chevronDown' : 'minimap'} size={14} /></button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={tt('canvas.stage.close')}
            title={tt('canvas.stage.close')}
            onClick={props.onClose}
          ><ToolbarIcon name="close" size={14} /></button>
        </header>

        {leftCollapsed ? null : <>
          <div className={css.sideSection}>{tt('canvas.stage.scene')}</div>
          <div className={css.search}>
            <input
              type="search"
              className={css.searchInput}
              value={query}
              placeholder={tt('canvas.stage.searchScene')}
              aria-label={tt('canvas.stage.searchScene')}
              onChange={event => setQuery(event.target.value)}
            />
          </div>

          <div className={css.list} role="listbox" aria-label={tt('canvas.stage.scene')}>
            {stage.cameras.map((camera, index) => {
              if (!matches(camera.name || tt('canvas.stage.cameraN', { index: index + 1 }))) return null
              const active = stage.cameraId === camera.id && selection.kind !== 'actor'
              return <div
                key={camera.id}
                className={active ? `${css.row} ${css.rowActive}` : css.row}
                role="option"
                aria-selected={stage.cameraId === camera.id}
                onClick={() => {
                  props.onStageChange({ ...stage, cameraId: camera.id })
                  setSelection({ kind: 'camera', id: camera.id })
                }}
              >
                <span className={css.rowIcon}><ToolbarIcon name="video" size={13} /></span>
                <span className={css.rowName} title={camera.name}>{camera.name || tt('canvas.stage.cameraN', { index: index + 1 })}</span>
                <button
                  type="button"
                  className={css.rowDelete}
                  aria-label={tt('canvas.stage.removeCamera')}
                  title={tt('canvas.stage.removeCamera')}
                  disabled={stage.cameras.length <= 1}
                  onClick={event => { event.stopPropagation(); removeCamera(camera.id) }}
                ><ToolbarIcon name="trash" size={12} /></button>
              </div>
            })}

            {stage.actors.length === 0
              ? <p className={css.empty}>{tt('canvas.stage.noActors')}</p>
              : stage.actors.map((actor, index) => {
                // 过滤后仍用**原始下标**：名字里的字母（角色A/B/C）与舞台上
                // 的顺序绑定，按过滤后的位置算会让「搜到第二个角色」显示成 A。
                if (!matches(actor.name || tt('canvas.stage.actorN', { letter: String.fromCharCode(65 + index) }))) return null
                return <div
                key={actor.id}
                className={selection.kind === 'actor' && selection.id === actor.id ? `${css.row} ${css.rowActive}` : css.row}
                role="option"
                aria-selected={selection.kind === 'actor' && selection.id === actor.id}
                onClick={() => setSelection({ kind: 'actor', id: actor.id })}
              >
                <span className={css.rowIcon}><ToolbarIcon name="select" size={13} /></span>
                <span className={css.rowName} title={actor.name}>{actor.name || tt('canvas.stage.actorN', { letter: String.fromCharCode(65 + index) })}</span>
                <button
                  type="button"
                  className={css.rowDelete}
                  aria-label={tt('canvas.stage.removeActor')}
                  title={tt('canvas.stage.removeActor')}
                  disabled={stage.actors.length <= 1}
                  onClick={event => { event.stopPropagation(); removeActor(actor.id) }}
                ><ToolbarIcon name="trash" size={12} /></button>
              </div>
              })}
          </div>

          <div className={css.sideActions}>
            <button
              type="button"
              className={css.sideButton}
              onClick={() => {
                const next = addActor(stage)
                /* 加完立刻重新取景。新角色排在已有角色右边 1.2 m，不重新取景
                   就会站到画面外——用户看到的是一张没变化的图，只会以为按钮
                   没生效，然后一直点，最后堆出五个看不见的人。 */
                const framed = frameCameraSpec(next, currentCamera(next))
                const cameras = next.cameras.map(camera => camera.id === framed.id ? framed : camera)
                const withFraming = { ...next, cameras }
                props.onStageChange(withFraming)
                // 导演视角下相机不在舞台上，要单独把自由视角也挪过去。
                setView(cameraFromSpec(framed))
                const added = withFraming.actors[withFraming.actors.length - 1]
                if (added !== undefined) setSelection({ kind: 'actor', id: added.id })
              }}
            ><ToolbarIcon name="new" size={12} />{tt('canvas.stage.addActor')}</button>
            <button
              type="button"
              className={css.sideButton}
              onClick={() => {
                const next = addCamera(stage)
                props.onStageChange(next)
                const added = next.cameras[next.cameras.length - 1]
                if (added !== undefined) setSelection({ kind: 'camera', id: added.id })
              }}
            ><ToolbarIcon name="new" size={12} />{tt('canvas.stage.addCamera')}</button>
          </div>
        </>}
      </aside>

      {/* ---------------------------------------------------- 中间视口 */}
      <main className={css.stage}>
        <div className={css.stageTop}>
          <div className={css.segmented} role="group">
            <button
              type="button"
              className={css.segment}
              aria-pressed={mode === 'director'}
              onClick={() => setMode('director')}
            >{tt('canvas.stage.directorView')}</button>
            <button
              type="button"
              className={css.segment}
              aria-pressed={mode === 'camera'}
              onClick={() => setMode('camera')}
            >{tt('canvas.stage.cameraView')}</button>
          </div>
        </div>

        <div className={css.axisCorner}>
          <div className={css.axisDial} aria-hidden="true">
            <span className={css.axisDotY}>Y</span>
            <span className={css.axisDotX}>X</span>
            <span className={css.axisDotZ}>Z</span>
          </div>
          <button
            type="button"
            className={css.resetButton}
            onClick={resetView}
          >{tt('canvas.stage.resetView')}</button>
        </div>

        <div className={css.viewport} ref={wrapperRef}>
          <canvas
            ref={canvasRef}
            className={css.stageCanvas}
            style={{ width: size > 0 ? `${size}px` : undefined, height: size > 0 ? `${size}px` : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          />
        </div>

        <div className={css.stageBottom}>
          <div className={css.toolRow}>
            <button
              type="button"
              className={css.toolButton}
              aria-pressed={tool === 'select'}
              onClick={() => setTool('select')}
            ><ToolbarIcon name="select" size={14} /><span>{tt('canvas.stage.selectActor')}</span></button>
            <button
              type="button"
              className={css.toolButton}
              aria-pressed={tool === 'orbit'}
              onClick={() => setTool('orbit')}
            ><ToolbarIcon name="pan" size={14} /></button>
            <button
              type="button"
              className={css.toolButton}
              disabled={busy}
              title={tt('canvas.stage.captureHint', { size: CAPTURE_SIZE })}
              onClick={capture}
            ><ToolbarIcon name="image" size={14} /><span>{busy ? tt('canvas.pose.exporting') : tt('canvas.stage.capture')}</span></button>
          </div>

          <div className={css.prompt}>
            <input
              type="text"
              className={css.promptInput}
              value={prompt}
              placeholder={tt('canvas.stage.promptPlaceholder')}
              aria-label={tt('canvas.stage.promptPlaceholder')}
              onChange={event => setPrompt(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                submitPrompt()
              }}
            />
            <button
              type="button"
              className={css.promptSend}
              aria-label={tt('canvas.stage.promptPlaceholder')}
              disabled={prompt.trim() === ''}
              onClick={submitPrompt}
            ><ToolbarIcon name="send" size={14} /></button>
          </div>
        </div>
      </main>

      {/* ---------------------------------------------------- 右栏 */}
      <aside className={css.inspector}>
        <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.settings')}</h3>

          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.scale')}</span>
            <span className={css.fieldRow}>
              <input
                type="range"
                className={css.slider}
                min={20}
                max={800}
                step={5}
                value={stage.scene.scale}
                aria-label={tt('canvas.stage.scale')}
                onChange={event => patchScene({ scale: Number(event.target.value) })}
              />
              <NumberField
                label={tt('canvas.stage.scale')}
                value={stage.scene.scale}
                min={20}
                max={800}
                onChange={next => patchScene({ scale: next })}
              />
            </span>
          </label>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.translate')}</span>
            <div className={css.triple}>
              {(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className={css.tripleCell}>
                <span>{axis}</span>
                <NumberField
                  label={`${tt('canvas.stage.translate')} ${axis}`}
                  value={stage.scene.translate[index] ?? 0}
                  step={0.1}
                  onChange={next => {
                    const translate: [number, number, number] = [
                      stage.scene.translate[0] ?? 0,
                      stage.scene.translate[1] ?? 0,
                      stage.scene.translate[2] ?? 0,
                    ]
                    translate[index] = next
                    patchScene({ translate })
                  }}
                />
              </label>)}
            </div>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.rotate')}</span>
            <div className={css.triple}>
              {/* 场景只有「绕 y 转」一个自由度：地面是水平面，绕 x/z 转会让地面
                  斜过来，那不是一个场景该有的状态。X/Z 摆在那里是为了和 LibTV
                  的三格对齐，禁用而不是假装能改。 */}
              {(['X', 'Y', 'Z'] as const).map(axis => <label key={axis} className={css.tripleCell}>
                <span>{axis}</span>
                {axis === 'Y'
                  ? <NumberField
                    label={`${tt('canvas.stage.rotate')} ${axis}`}
                    value={stage.scene.rotateY}
                    min={-180}
                    max={180}
                    onChange={next => patchScene({ rotateY: next })}
                  />
                  : <NumberField
                    label={`${tt('canvas.stage.rotate')} ${axis}`}
                    value={0}
                    disabled
                    title={tt('canvas.stage.rotate')}
                    onChange={() => { /* 只有 Y 轴可改，禁用态不接受输入 */ }}
                  />}
              </label>)}
            </div>
          </div>
        </section>

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.background')}</h3>
          {props.pano !== null
            ? <div className={css.panoConnected}>
              <img className={css.panoThumb} src={props.pano.url} alt="" />
              <span>{tt('canvas.stage.connectedPano')}</span>
            </div>
            : <p className={css.panoEmpty}>{tt('canvas.stage.panoHint')}</p>}

          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.skyColor')}</span>
            <span className={css.fieldRow}>
              <input
                type="color"
                className={css.colorInput}
                value={stage.scene.sky}
                aria-label={tt('canvas.stage.skyColor')}
                onChange={event => patchScene({ sky: event.target.value })}
              />
              <input
                type="text"
                className={css.colorText}
                value={stage.scene.sky}
                aria-label={tt('canvas.stage.skyColor')}
                onChange={event => {
                  const value = event.target.value.trim()
                  // 只在完整合法时才写盘：半截的 `#06` 写进去会让天空变成
                  // 浏览器默认的黑色，用户会以为颜色崩了。
                  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) patchScene({ sky: value })
                }}
              />
            </span>
          </label>
        </section>

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.background')} · {tt('canvas.stage.panoYaw')}</h3>

          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.panoYaw')}</span>
            <span className={css.fieldRow}>
              <input
                type="range"
                className={css.slider}
                min={0}
                max={360}
                step={1}
                value={stage.scene.panoYaw}
                aria-label={tt('canvas.stage.panoYaw')}
                onChange={event => patchScene({ panoYaw: Number(event.target.value) })}
              />
              <span className={css.value}>{Math.round(stage.scene.panoYaw)}°</span>
            </span>
          </label>

          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.panoRadius')}</span>
            <span className={css.fieldRow}>
              <input
                type="range"
                className={css.slider}
                min={10}
                max={200}
                step={1}
                value={stage.scene.panoRadius}
                aria-label={tt('canvas.stage.panoRadius')}
                onChange={event => patchScene({ panoRadius: Number(event.target.value) })}
              />
              <span className={css.value}>{Math.round(stage.scene.panoRadius)}</span>
            </span>
          </label>
        </section>

        <section className={css.section}>
          <label className={css.toggleRow}>
            <span className={css.fieldLabel}>{tt('canvas.stage.labels')}</span>
            <input
              type="checkbox"
              className={css.checkbox}
              checked={stage.scene.labels}
              aria-label={tt('canvas.stage.labels')}
              onChange={event => patchScene({ labels: event.target.checked })}
            />
          </label>

          {selectedActor !== undefined ? <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.actorName')}</span>
            <input
              type="text"
              className={css.textInput}
              value={selectedActor.name}
              aria-label={tt('canvas.stage.actorName')}
              onChange={event => patchActor(selectedActor.id, { name: event.target.value })}
            />
          </label> : null}

          {/* 站位：没有这两个数字框，视口里点选角色就只能改名，摆位只能靠
              「再多加一个角色」——那等于把角色数量当成了位置。 */}
          {selectedActor !== undefined ? <div className={css.field} title={tt('canvas.stage.positionHint')}>
            <span className={css.fieldLabel}>{tt('canvas.stage.position')}</span>
            <div className={css.triple}>
              {(['X', 'Z'] as const).map(axis => <label key={axis} className={css.tripleCell}>
                <span>{axis}</span>
                <NumberField
                  label={`${tt('canvas.stage.position')} ${axis}`}
                  value={axis === 'X' ? selectedActor.x : selectedActor.z}
                  step={0.1}
                  onChange={next => patchActor(selectedActor.id, axis === 'X' ? { x: next } : { z: next })}
                />
              </label>)}
            </div>
          </div> : null}

          {selectedCamera !== undefined ? <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.cameraName')}</span>
            <input
              type="text"
              className={css.textInput}
              value={selectedCamera.name}
              aria-label={tt('canvas.stage.cameraName')}
              onChange={event => patchCamera(selectedCamera.id, { name: event.target.value })}
            />
          </label> : null}

          {mode === 'camera' ? <label className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.fov')}</span>
            <span className={css.fieldRow}>
              <input
                type="range"
                className={css.slider}
                min={8}
                max={120}
                step={1}
                value={spec.fov}
                aria-label={tt('canvas.stage.fov')}
                onChange={event => patchCamera(spec.id, { fov: Number(event.target.value) })}
              />
              <span className={css.value}>{Math.round(spec.fov)}°</span>
            </span>
          </label> : null}
        </section>
      </aside>
    </div>
  </div>

  return props.container === null ? body : createPortal(body, props.container)
}

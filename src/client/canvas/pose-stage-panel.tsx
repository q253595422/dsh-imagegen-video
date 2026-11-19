/**
 * 导演台的全屏面板：左栏排角色、道具与机位、中间一块可以绕着看（或透过某台
 * 机位看）的视口 + 底部时间轴、右栏按段调关键帧 / 轨迹 / 姿势 / 场景。
 *
 * 与 `pose-board.tsx` 同一个约定：只接 props、回回调。画布 document、写盘、上传、
 * 逐帧导出都在外面——这里连 `api` 都不拿，于是撤销/重做、自动保存、多窗口版本
 * 检查都看不见它。
 *
 * 三个刻意的取舍：
 *
 *  1. **视口是正方形**。`drawScene` 的投影以边长的一半为基准，拉伸成宽屏会把
 *     地面网格与人形一起拉扁；牧野的视口本身也接近正方形。宁可两侧留出面板
 *     底色，也不要一张变形的预览——用户会照着它判断站位。
 *  2. **拖动只转视角，不改姿势**。摆姿势是右栏「预设姿势」段的事，视口负责
 *     「谁站在哪、机位在哪」。两件事混在同一个手势里，用户想转个角度就会不小
 *     心改掉一个人的动作。
 *  3. **画与点选都在一层薄接口后面**（{@link StageViewRenderer}）。现在实现
 *     是 Canvas 2D（`drawScene`），换 three.js 时只替换这一层，时间轴、关键帧、
 *     轨迹的代码一行不动——它们只认识「已经求值完的 stage」。
 *
 * 时间轴与静态舞台共存：`stage.timeline` 缺项时面板照旧渲染静态舞台、照旧可
 * 编辑，只是底部没有关键帧、播放头固定在第 0 帧、且「导出视频」是禁用的
 * （没有时间维度就没有可编码的帧序列，见 `videoExportable`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Pause, PenTool, Pencil, Play, Repeat, SkipBack, StepBack, StepForward,
} from 'lucide-react'
import type {
  CanvasPoseActor, CanvasPoseCamera, CanvasPoseScene, CanvasPoseStage,
  CanvasStagePath, CanvasStageProp, CanvasStageTimeline,
} from '../../protocol.ts'
import { errorMessage, tt } from '../helpers.ts'
import type { ImageGenKey } from '../locales.ts'
import { ToolbarIcon } from './dock-controls.tsx'
import {
  addActor, addCamera, addProp, actorTransform, cameraFromSpec, currentCamera,
  currentRenderCamera, frameCameraSpec, patchProp, removeProp, seatPropFor, withPosePreset,
} from './pose-stage.ts'
import { POSE_PRESETS, makeProjector, solveRig, type PoseCamera, type PoseJoint } from './pose-rig.ts'
import { drawScene, renderSceneToCanvas } from './pose-scene-render.ts'
import { renderStageToDataUrl } from './stage-scene-3d.ts'
import {
  STAGE_FPS, STAGE_MAX_DURATION, STAGE_MIN_DURATION, clampTime, emptyStageTimeline,
  frameCount, putKeyframe, putPath, removeKeyframe, removePath, removeTrack, retimeTimeline,
  sampleStage, snapToFrame, timelineOf, trackOf,
} from './stage-timeline.ts'
import { STAGE_CAPTURE_SIZE } from './constants.ts'
import { createStage3DRenderer } from './stage-view-3d.ts'
import css from './pose-stage-panel.module.css'

/** 机位截图的边长。取自 `constants.ts`，与文档声称的尺寸只有一处定义——
 *  两处各写一个数时，面板里的那张实际是 1024，而说明写的是 1280。 */
const CAPTURE_SIZE = STAGE_CAPTURE_SIZE

/** 拖拽超过这个距离（CSS 像素）就算「转视角」，不算「点选角色」。 */
const CLICK_SLOP = 4

/** 一帧的时长（秒）。与 `stage-timeline` 的帧率同一个值。 */
const FRAME = 1 / STAGE_FPS

/** 视口模式：自由环绕（导演）或透过当前机位看。 */
export type ViewMode = 'director' | 'camera'
/** 指针工具：拖动转视角、点击选中。 */
type PointerTool = 'orbit' | 'select'

/** 场景里被点中的东西。返回协议层 id，不泄漏渲染器内部的对象。 */
export interface StageHit {
  kind: 'actor' | 'camera' | 'prop'
  id: string
}

/** 正在画、还没提交的路径。 */
export interface StagePathDraft {
  shape: CanvasStagePath['shape']
  points: Array<[number, number, number]>
}

/** 画一帧需要的全部输入。`stage` 应当已经过 `sampleStage()`。 */
export interface StageViewInput {
  canvas: HTMLCanvasElement
  stage: CanvasPoseStage
  mode: ViewMode
  camera: PoseCamera
  /** 视口边长（CSS 像素）。 */
  size: number
  pano: HTMLImageElement | null
  /** 画辅助线（关节标记、视锥）；导出时关掉。 */
  guides: boolean
  /** 正在画的路径，供渲染器画预览点。 */
  draft: StagePathDraft | null
}

export interface StagePickInput {
  stage: CanvasPoseStage
  mode: ViewMode
  camera: PoseCamera
  size: number
  /** 相对画布左上角的 CSS 像素坐标。 */
  x: number
  y: number
}

/**
 * 「怎么画」与「怎么点中」的唯一入口。
 *
 * 这一层存在的理由不是抽象好看：2D 版与将来的 three.js 版**必须可以互换**，
 * 而时间轴求值、关键帧增删、轨迹编辑都不该知道自己脚下是什么渲染器。换实现
 * 时只替换这里的两个方法。
 */
export interface StageViewRenderer {
  paint(input: StageViewInput): void
  pick(input: StagePickInput): StageHit | null
  /**
   * 拖动环绕。**像素增量**，右/下为正。渲染器不支持时省略——面板会退回
   * 自己维护 yaw/pitch。
   */
  orbit?(deltaX: number, deltaY: number): void
  /** 滚轮缩放。`factor > 1` 拉近。 */
  zoom?(factor: number): void
  /** 重置视角（导演视角下重新框住整场）。 */
  resetView?(stage: CanvasPoseStage): void
}

let activeRenderer: StageViewRenderer | null = null

/** 模块级替换点。传 null 回到内置的 2D 实现。 */
export function setStageViewRenderer(next: StageViewRenderer | null): void {
  activeRenderer = next
}

/** 当前生效的渲染器：模块级注入的优先，否则内置 2D。 */
export function currentStageViewRenderer(): StageViewRenderer {
  return activeRenderer ?? twoDeeRenderer
}

/* ------------------------------------------------------------------ 数学 */

type Vec3 = [number, number, number]

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * 屏幕点 → 世界高度 `height` 平面上的一点。
 *
 * 画铅笔/钢笔路径要用：用户指哪儿，角色就该走到哪儿。与 `makeProjector` 的
 * 正向投影用同一套相机基（eye 由 yaw/pitch/distance 定，right = forward × up），
 * 否则画出来的路径和渲染出来的地面会错位——那种错位用户只会当成「点不准」。
 */
export function unprojectToPlane(
  camera: PoseCamera, size: number, x: number, y: number, height: number,
): Vec3 | null {
  if (size <= 0) return null
  const yaw = camera.yaw * Math.PI / 180
  const pitch = camera.pitch * Math.PI / 180
  const target: Vec3 = [camera.targetX ?? 0, camera.targetY, camera.targetZ ?? 0]
  const eye: Vec3 = [
    target[0] + Math.sin(yaw) * Math.cos(pitch) * camera.distance,
    target[1] + Math.sin(pitch) * camera.distance,
    target[2] + Math.cos(yaw) * Math.cos(pitch) * camera.distance,
  ]
  const forward = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]])
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  const sx0 = (x - size / 2) / focal
  const sy0 = -(y - size / 2) / focal
  const dir: Vec3 = [
    right[0] * sx0 + up[0] * sy0 + forward[0],
    right[1] * sx0 + up[1] * sy0 + forward[1],
    right[2] * sx0 + up[2] * sy0 + forward[2],
  ]
  if (Math.abs(dir[1]) < 1e-6) return null
  const t = (height - eye[1]) / dir[1]
  if (t <= 0) return null
  return [eye[0] + dir[0] * t, height, eye[2] + dir[2] * t]
}

/** 把一个点按欧拉角（度，R = Rz·Ry·Rx，与 `pose-rig` 同一约定）旋转。 */
function rotate(point: Vec3, rx: number, ry: number, rz: number): Vec3 {
  const ax = rx * Math.PI / 180
  const ay = ry * Math.PI / 180
  const az = rz * Math.PI / 180
  let [x, y, z] = point
  const y1 = y * Math.cos(ax) - z * Math.sin(ax)
  const z1 = y * Math.sin(ax) + z * Math.cos(ax)
  y = y1; z = z1
  const x2 = x * Math.cos(ay) + z * Math.sin(ay)
  const z2 = -x * Math.sin(ay) + z * Math.cos(ay)
  x = x2; z = z2
  const x3 = x * Math.cos(az) - y * Math.sin(az)
  const y3 = x * Math.sin(az) + y * Math.cos(az)
  return [x3, y3, z]
}

/* ------------------------------------------------------- 内置 2D 渲染器 */

/** 道具的 8 个角（世界坐标）。半边长 0.5 m × 缩放。 */
function propCorners(prop: CanvasStageProp): Vec3[] {
  const hx = 0.5 * (prop.scaleX ?? 1)
  const hy = 0.5 * (prop.scaleY ?? 1)
  const hz = 0.5 * (prop.scaleZ ?? 1)
  const corners: Vec3[] = []
  for (const sx0 of [-1, 1]) {
    for (const sy0 of [-1, 1]) {
      for (const sz0 of [-1, 1]) {
        const local: Vec3 = [sx0 * hx, sy0 * hy, sz0 * hz]
        const turned = rotate(local, prop.rotateX ?? 0, prop.rotateY ?? 0, prop.rotateZ ?? 0)
        corners.push([prop.x + turned[0], prop.y + turned[1], prop.z + turned[2]])
      }
    }
  }
  return corners
}

/** 立方体的 6 个面（按上面的角序索引）。 */
const CUBE_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 3, 2], [4, 6, 7, 5], [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6],
]

/**
 * 把道具画到已经画完人物的画布上。
 *
 * 2D 版把道具画在人物**之上**：画家算法没有深度缓冲，人物与道具相交时谁在前
 * 只能二选一。选「道具在前」是因为导演台里道具多半是垫脚/前景物件，而人物被
 * 道具挡住的场景（人躲在箱子后面）恰好是 three.js 那一层要解决的事——这里留
 * 一个已知的、有出路的不足，不去假造一个错的遮挡。
 */
function paintProps(
  ctx: CanvasRenderingContext2D,
  stage: CanvasPoseStage,
  size: number,
  camera: PoseCamera,
): void {
  const props = stage.props ?? []
  if (props.length === 0) return
  const { project, focal } = makeProjector(size, camera)
  const light = unit([-0.42, 0.72, 0.55])

  const ordered = props
    .map(prop => {
      const center = project([prop.x, prop.y, prop.z])
      return { prop, depth: center === null ? Number.POSITIVE_INFINITY : center[2] }
    })
    .sort((a, b) => b.depth - a.depth)

  for (const { prop } of ordered) {
    if (prop.kind === 'sphere') {
      const center = project([prop.x, prop.y, prop.z])
      if (center === null) continue
      const radius = Math.max(
        2,
        (0.5 * Math.max(prop.scaleX ?? 1, prop.scaleY ?? 1, prop.scaleZ ?? 1) * focal) / center[2],
      )
      const gradient = ctx.createRadialGradient(
        center[0] - radius * 0.35, center[1] - radius * 0.4, radius * 0.15,
        center[0], center[1], radius,
      )
      gradient.addColorStop(0, 'rgba(238, 241, 247, 0.96)')
      gradient.addColorStop(1, 'rgba(150, 160, 178, 0.96)')
      ctx.beginPath()
      ctx.arc(center[0], center[1], radius, 0, Math.PI * 2)
      ctx.fillStyle = gradient
      ctx.fill()
      ctx.strokeStyle = 'rgba(70, 80, 96, 0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
      continue
    }

    const corners = propCorners(prop)
    const screen = corners.map(point => project(point))
    if (screen.some(item => item === null)) continue
    const faces = CUBE_FACES
      .map(indices => {
        const points = indices.map(index => screen[index]!) as Vec3[]
        const depth = points.reduce((sum, point) => sum + point[2], 0) / points.length
        // 面法线取两条边的叉积（世界坐标），用来决定明暗。
        const a = corners[indices[0]!]!
        const b = corners[indices[1]!]!
        const c = corners[indices[3]!]!
        const normal = unit(cross(
          [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
          [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        ))
        const shade = Math.abs(normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2])
        return { points, depth, shade }
      })
      .sort((a, b) => b.depth - a.depth)

    for (const face of faces) {
      const tone = 132 + Math.round(face.shade * 96)
      ctx.beginPath()
      ctx.moveTo(face.points[0]![0], face.points[0]![1])
      for (const point of face.points.slice(1)) ctx.lineTo(point[0], point[1])
      ctx.closePath()
      ctx.fillStyle = `rgba(${tone}, ${tone + 6}, ${tone + 16}, 0.94)`
      ctx.fill()
      ctx.strokeStyle = 'rgba(70, 80, 96, 0.28)'
      ctx.lineWidth = 0.8
      ctx.stroke()
    }
  }
}

/** 画正在编辑的路径：点、折线与高度标记。 */
function paintDraft(
  ctx: CanvasRenderingContext2D,
  draft: StagePathDraft,
  size: number,
  camera: PoseCamera,
): void {
  if (draft.points.length === 0) return
  const { project } = makeProjector(size, camera)
  const screen = draft.points.map(point => project(point))
  ctx.save()
  ctx.strokeStyle = 'rgba(64, 158, 255, 0.9)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  let started = false
  for (const point of screen) {
    if (point === null) { started = false; continue }
    if (!started) { ctx.moveTo(point[0], point[1]); started = true }
    else ctx.lineTo(point[0], point[1])
  }
  ctx.stroke()
  for (const point of screen) {
    if (point === null) continue
    ctx.beginPath()
    ctx.arc(point[0], point[1], 3.2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(64, 158, 255, 0.95)'
    ctx.fill()
  }
  ctx.restore()
}

/** 点了谁：在阈值内取投影距离最近的那个（人物取头/胯两个锚点）。 */
function pickWithProjection(input: StagePickInput): StageHit | null {
  const { stage, camera, size, x, y } = input
  if (size <= 0) return null
  const { project } = makeProjector(size, camera)
  const candidates: Array<{ hit: StageHit; distance: number }> = []
  const consider = (hit: StageHit, distance: number, limit: number): void => {
    if (distance > limit) return
    candidates.push({ hit, distance })
  }

  for (const actor of stage.actors) {
    const transform = actorTransform(stage, actor)
    const world = solveRig(actor.rig)
    for (const joint of ['head', 'hips'] as PoseJoint[]) {
      const point = world[joint]
      const turn = transform.rotation * Math.PI / 180
      const cos = Math.cos(turn)
      const sin = Math.sin(turn)
      const placed: Vec3 = [
        (point[0] * cos + point[2] * sin) * transform.scale + transform.offset[0],
        point[1] * transform.scale + transform.offset[1],
        (-point[0] * sin + point[2] * cos) * transform.scale + transform.offset[2],
      ]
      const screen = project(placed)
      if (screen === null) continue
      // 阈值取画面的 14%：远一点的人也能点中，但不会把地面上的空白处
      // 判成某个人。
      consider({ kind: 'actor', id: actor.id }, Math.hypot(screen[0] - x, screen[1] - y), size * 0.14)
    }
  }

  for (const prop of stage.props ?? []) {
    const center = project([prop.x, prop.y, prop.z])
    if (center === null) continue
    const radius = Math.max(18, (0.6 * (prop.scaleX ?? 1) * (size / 2)) / Math.max(0.5, center[2]))
    consider({ kind: 'prop', id: prop.id }, Math.hypot(center[0] - x, center[1] - y), radius)
  }

  candidates.sort((a, b) => a.distance - b.distance)
  return candidates[0]?.hit ?? null
}

/** 内置的 Canvas 2D 实现。 */
const twoDeeRenderer: StageViewRenderer = {
  paint(input: StageViewInput): void {
    const { canvas, stage, mode, camera, size, pano, guides, draft } = input
    if (size <= 0) return
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
      size, stage, camera, guides,
      // 机位视角下不画视锥：取景框正好贴着画面边缘，画出来只是一圈噪点。
      frustum: mode === 'director',
      pano,
    })
    paintProps(ctx, stage, size, camera)
    if (draft !== null) paintDraft(ctx, draft, size, camera)
  },
  pick: pickWithProjection,
}

export interface PoseStagePanelProps {
  stage: CanvasPoseStage
  /** 舞台变了就调它。父组件负责写盘与把 pose 镜像回 metadata。 */
  onStageChange: (next: CanvasPoseStage) => void
  /** 已连接的全景图（父组件从连线上取），没有就 null。 */
  pano: { url: string } | null
  /** 导出当前时刻/机位的一张 PNG；父组件负责上传与落成节点资产。 */
  onCapture: (dataUrl: string, size: number) => void | Promise<void>
  /** 一句话描述场景；父组件拿去接生成链。 */
  onPrompt: (text: string) => void
  /**
   * 这份舞台能不能导出视频：有 timeline 才为 true。
   *
   * 静态舞台没有帧序列可编码——不是「还没实现」，而是**没有时间维度**。
   * 按钮因此是禁用的，提示语把用户引到 PNG（`exportNoTimeline`）。
   */
  videoExportable: boolean
  /** 导出进度 0..1；null = 当前没有在导出。 */
  videoExportProgress: number | null
  onExportVideo: () => void
  onCancelVideoExport: () => void
  /** 挂载点：必须盖在画布之上。 */
  container: HTMLElement | null
  onClose: () => void
  onError: (message: string) => void
  /**
   * 换掉视口实现（three.js 那一层从这里接进来）。
   *
   * 不传就用模块级注入的那个，再不行用内置 2D——三种情况的行为完全一致，
   * 因为时间轴求值发生在调用渲染器**之前**。
   */
  renderer?: StageViewRenderer
}

/** 当前在左栏选中了什么。道具也在同一个选中态里，因为它占右栏同一块位置。 */
type Selection = { kind: 'actor' | 'camera' | 'prop'; id: string }

/** 一个数字输入框：中间态允许空串，失焦时才回落到合法值。
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
  return <input
    type="number"
    className={css.number}
    value={draft ?? String(props.value)}
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

  /* ---------------------------------------------------------- 时间轴状态 */

  const timeline = stage.timeline
  /** 供 UI 显示的那份时间轴：没有关键帧时也给一个 5 秒的空壳，这样「时长」
   *  输入框与刻度条一开始就有意义，用户不必先点「新建时间轴」。 */
  const timelineView = useMemo(() => timelineOf(timeline), [timeline])
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [draft, setDraft] = useState<StagePathDraft | null>(null)
  const [draftShape, setDraftShape] = useState<CanvasStagePath['shape']>('line')
  const timeRef = useRef(0)
  timeRef.current = time

  // 时长改小以后播放头可能落在区间外，把它拉回来，否则画面会停在「最后一帧
  // 之后」而刻度条上找不到那个位置。
  useEffect(() => {
    if (time > timelineView.duration) setTime(timelineView.duration)
  }, [time, timelineView.duration])

  /** 当前时刻求值后的舞台：视口、截图都喂它。 */
  const sampled = useMemo(
    () => (timeline === undefined ? stage : sampleStage(stage, time)),
    [stage, timeline, time],
  )

  const spec = currentCamera(stage)
  /** 机位自己的视角。机位参数一变就重算——用户改了机位位置却还看着旧角度，
   *  会以为输入框没生效。 */
  const sampledCamera = useMemo(() => currentRenderCamera(sampled), [sampled])
  const [view, setView] = useState<PoseCamera>(sampledCamera)

  // 机位切换 / 位置 / 视场角变化时把自由视角拉回机位的角度。
  const cameraKey = `${spec.id}|${spec.x},${spec.y},${spec.z}|${spec.targetX},${spec.targetY},${spec.targetZ}|${spec.fov}`
  useEffect(() => {
    setView(currentRenderCamera(stage))
    // `stage` 每改一次都是新对象，拿它当依赖会让拖动中的视角被不断重置；
    // 这里只关心「机位本身变了没有」，所以依赖那串键。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraKey])

  // 舞台里角色/道具被删掉时，选中态要跟着落回第一个，否则右栏的输入框会
  // 绑到一个不存在的 id 上、变成一个改什么都无效的框。
  useEffect(() => {
    const exists = selection.kind === 'actor'
      ? stage.actors.some(actor => actor.id === selection.id)
      : selection.kind === 'camera'
        ? stage.cameras.some(camera => camera.id === selection.id)
        : (stage.props ?? []).some(prop => prop.id === selection.id)
    if (exists) return
    const fallback = stage.actors[0]?.id ?? stage.cameras[0]?.id
    if (fallback !== undefined) {
      setSelection({ kind: stage.actors[0] === undefined ? 'camera' : 'actor', id: fallback })
    }
  }, [stage.actors, stage.cameras, stage.props, selection])

  const renderCamera = mode === 'camera' ? sampledCamera : view
  // 渲染器优先级：props 注入 > 模块级注入 > **3D** > 内置 2D。
  //
  // 3D 拿不到 WebGL 时（老 GPU、远程桌面、策略禁用）会自己退回 2D，所以这里
  // 不需要先探测能力：探测到了也不代表下一帧还能建上下文。
  // 正式落地前这里是 `twoDeeRenderer`；改成 3D 是这次对标牧野的核心——
  // 真深度缓冲带来的遮挡是画家算法给不了的。
  const three = useMemo(() => createStage3DRenderer(twoDeeRenderer), [])
  useEffect(() => () => three.dispose(), [three])
  const renderer = props.renderer ?? activeRenderer ?? three.renderer

  /** 左栏的搜索：只过滤列表，不影响舞台数据。
   *
   * 没有它的话那个输入框就是个空壳——用户输入什么都不会变，只会以为面板坏了。
   * 匹配名字，不匹配 id（id 是 `actor-3` 这种内部值，用户看不见）。 */
  const matches = useCallback((name: string): boolean => {
    const needle = query.trim().toLowerCase()
    return needle === '' || name.toLowerCase().includes(needle)
  }, [query])

  /* ------------------------------------------------------------ 量尺寸 */

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (wrapper === null) return
    const measure = (): void => {
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
    renderer.paint({
      canvas,
      stage: sampled,
      mode,
      camera: renderCamera,
      size,
      pano: panoImage,
      guides: true,
      draft,
    })
  }, [renderer, size, sampled, renderCamera, mode, panoImage, draft])

  /* ------------------------------------------------------------ 播放 */

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let cursor = timeRef.current
    let last = performance.now()
    const step = (now: number): void => {
      // 夹一下 dt：切标签页回来时 now 会跳几十秒，不夹的话播放头会直接冲到结尾。
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      cursor += dt
      const span = timelineView.duration
      if (cursor >= span) {
        if (loop) cursor = cursor % Math.max(FRAME, span)
        else { setTime(span); setPlaying(false); return }
      }
      setTime(cursor)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf) }
  }, [playing, loop, timelineView.duration])

  /* ------------------------------------------------------------ 交互 */

  const dragRef = useRef<{ x: number; y: number; lastX: number; lastY: number; yaw: number; pitch: number; moved: number } | null>(null)
  /** 画路径时的「按下并拖动」是否正在收集点（铅笔）。 */
  const drawingRef = useRef(false)

  const seekFromPointer = (clientX: number, clientY: number): void => {
    const canvas = canvasRef.current
    if (canvas === null || size <= 0) return
    const rect = canvas.getBoundingClientRect()
    const point = unprojectToPlane(
      renderCamera, size, clientX - rect.left, clientY - rect.top,
      draft?.points[0]?.[1] ?? 0,
    )
    if (point === null) return
    setDraft(current => {
      const base = current ?? { shape: draftShape, points: [] }
      if (draftShape === 'free') {
        const points = base.points
        const tail = points[points.length - 1]
        // 拖动采样很密：间距小于 2.5 cm 的点丢掉，否则一条两米的线会存上
        // 几千个点，画布 JSON 膨胀而形状毫无变化。
        if (tail !== undefined && Math.hypot(point[0] - tail[0], point[2] - tail[2]) < 0.025) return base
        return { ...base, points: [...points, point] }
      }
      // 定形路径只需要两个点：起点与终点（圆是圆心与半径点）。
      const points = base.points.length >= 2 ? [point] : [...base.points, point]
      return { ...base, points }
    })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // 画布的框选与拖拽挂在祖先上，不拦住就会把这一下抢走（见 pose-board 同一处理）。
    event.stopPropagation()
    if (draft !== null) {
      drawingRef.current = draftShape === 'free'
      seekFromPointer(event.clientX, event.clientY)
      if (!drawingRef.current) return
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, yaw: view.yaw, pitch: view.pitch, moved: 0 }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    if (draft !== null) {
      if (!drawingRef.current) return
      event.stopPropagation()
      seekFromPointer(event.clientX, event.clientY)
      return
    }
    const start = dragRef.current
    if (start === null) return
    event.stopPropagation()
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    start.moved = Math.max(start.moved, Math.hypot(dx, dy))
    // 机位视角是「这台摄像机看到的东西」，转它就是改了机位——那该在右栏里做，
    // 不该从一个手势偷偷发生。
    if (mode === 'camera') return
    // 真正把这一下交给渲染器。早先这里只改局部 `view`，而**没有人读它**——
    // 于是拖动在任何渲染器下都不出效果（3D 场景的 `orbit()` 写好了，却
    // 一个调用方都没有）。增量用「上次位置」算，因为 `orbit()` 接的是步长。
    const stepX = event.clientX - start.lastX
    const stepY = event.clientY - start.lastY
    start.lastX = event.clientX
    start.lastY = event.clientY
    // 传送 `-stepY`：场景里是 `pitch += dy * 0.3`，而面板原本的语义是
    // `pitch - dy * 0.3`（往下拖看到头顶）。不取反就是上下颠倒。
    renderer.orbit?.(stepX, -stepY)
    setView({
      ...view,
      yaw: start.yaw + dx * 0.4,
      pitch: Math.max(-80, Math.min(80, start.pitch - dy * 0.3)),
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    const start = dragRef.current
    dragRef.current = null
    drawingRef.current = false
    if (draft !== null) return
    if (start === null) return
    event.stopPropagation()
    if (tool !== 'select' || start.moved > CLICK_SLOP) return
    const canvas = canvasRef.current
    if (canvas === null || size <= 0) return
    const rect = canvas.getBoundingClientRect()
    const hit = renderer.pick({
      stage: sampled,
      mode,
      camera: renderCamera,
      size,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
    if (hit !== null) setSelection(hit)
  }

  const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
    if (mode === 'camera') return
    event.stopPropagation()
    // 滚轮缩放只改「站多远」，仍围绕同一个注视点转，不会把画面拉偏。
    const factor = Math.exp(event.deltaY * 0.0012)
    // 渲染器的 `zoom()` 是「factor > 1 拉近」，而 wheel 的 factor 是
    // 「> 1 拉远」，所以传倒数。
    renderer.zoom?.(1 / factor)
    setView(current => ({
      ...current,
      distance: Math.max(0.6, Math.min(24, current.distance * factor)),
    }))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (draft !== null) { setDraft(null); return }
        props.onClose()
        return
      }
      if (event.key !== ' ' && event.code !== 'Space') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      // 在输入框里按空格是打字，不是播放。
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable === true) return
      event.preventDefault()
      event.stopPropagation()
      setPlaying(current => !current)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, draft])

  /* ------------------------------------------------------------ 写舞台 */

  const patchScene = (patch: Partial<CanvasPoseScene>): void => {
    props.onStageChange({ ...stage, scene: { ...stage.scene, ...patch } })
  }
  const patchActor = (id: string, patch: Partial<CanvasPoseActor>): void => {
    const actors = stage.actors.map(actor => (actor.id === id ? { ...actor, ...patch } : actor))
    const next: CanvasPoseStage = { ...stage, actors }
    const seatId = `seat-${id}`
    const actor = actors.find(item => item.id === id)
    const movesSeat = ['x', 'z', 'rotation', 'scale', 'rig'].some(key => key in patch)
    if (actor !== undefined && movesSeat && (stage.props ?? []).some(prop => prop.id === seatId)) {
      next.props = (stage.props ?? []).map(prop => (prop.id === seatId ? seatPropFor(actor) : prop))
    }
    props.onStageChange(next)
  }
  const patchCamera = (id: string, patch: Partial<CanvasPoseCamera>): void => {
    props.onStageChange({
      ...stage,
      cameras: stage.cameras.map(camera => (camera.id === id ? { ...camera, ...patch } : camera)),
    })
  }
  const patchPropById = (id: string, patch: Partial<CanvasStageProp>): void => {
    props.onStageChange(patchProp(stage, id, patch))
  }

  const writeTimeline = (next: CanvasStageTimeline): void => {
    props.onStageChange({ ...stage, timeline: next })
  }
  /** 现在这份时间轴（没有就以 5 秒空壳起步）。任何一次写关键帧都会把它建起来。 */
  const working = (): CanvasStageTimeline => timeline ?? emptyStageTimeline()

  const removeActor = (id: string): void => {
    if (stage.actors.length <= 1) return
    const nextProps = (stage.props ?? []).filter(prop => prop.id !== `seat-${id}`)
    // 先摘掉旧的 props 再决定要不要写回：只展开 `...stage` 时，props 为空
    // 也不会消失（原数组又回来了），删掉角色后会留下一块坐箱。
    const next: CanvasPoseStage = {
      ...stage,
      actors: stage.actors.filter(actor => actor.id !== id),
    }
    if (nextProps.length > 0) next.props = nextProps
    else delete next.props
    // 轨道不删就会留下指向不存在角色的孤儿轨道：导出时它们被求值但画不出来，
    // 时间轴上却还占一行。
    props.onStageChange(timeline === undefined ? next : { ...next, timeline: removeTrack(timeline, 'actor', id) })
  }
  const removeCamera = (id: string): void => {
    if (stage.cameras.length <= 1) return
    const cameras = stage.cameras.filter(camera => camera.id !== id)
    const next = {
      ...stage,
      cameras,
      cameraId: stage.cameraId === id ? cameras[0]!.id : stage.cameraId,
    }
    props.onStageChange(timeline === undefined ? next : { ...next, timeline: removeTrack(timeline, 'camera', id) })
  }
  const removePropById = (id: string): void => {
    props.onStageChange(removeProp(stage, id))
  }

  const resetView = (): void => {
    const framed = frameCameraSpec(stage, spec)
    if (mode === 'camera') {
      patchCamera(framed.id, framed)
      return
    }
    // 导演视角不写盘：它是一次看待方式，不是舞台的一部分。
    // 渲染器自己能重新框景时优先用它（3D 的包围球计算在场景那边）。
    renderer.resetView?.(stage)
    setView(cameraFromSpec(framed))
  }

  const capture = (): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const canvas = document.createElement('canvas')
        // 导出的是**当前时刻**的画面：时间轴存在时它就是播放头那一帧，
        // 否则就是静态舞台。
        //
        // 优先走 3D：视口里看到的是 three 渲染的人形，导出却用 2D 画家算法
        // 画一遍的话，用户按「生成参考图」拿到的是一张和眼前完全不同的图
        // （球拼的小人 vs 有体积的人体）。导出必须是「你看到的那一帧」。
        // 没有 WebGL 时才退回 2D——那条路本来就在，视口也在用它。
        let rendered = false
        try {
          const url = await renderStageToDataUrl(sampled, {
            width: CAPTURE_SIZE, height: CAPTURE_SIZE, pano: panoImage,
          })
          const image = new Image()
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('capture: the rendered frame could not be decoded'))
            image.src = url
          })
          canvas.width = CAPTURE_SIZE
          canvas.height = CAPTURE_SIZE
          canvas.getContext('2d')?.drawImage(image, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE)
          rendered = true
        } catch {
          // 3D 渲不出来（没有 WebGL、上下文丢了、GPU 被占）就退回 2D，别让
          // 用户点一下只得到一句报错——参考图本身没有「必须是 3D」的理由。
          rendered = false
        }
        if (!rendered) renderSceneToCanvas(canvas, CAPTURE_SIZE, sampled, { pano: panoImage })
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

  /* ------------------------------------------------------- 关键帧操作 */

  const selectedActor = selection.kind === 'actor'
    ? stage.actors.find(actor => actor.id === selection.id)
    : undefined
  const selectedCamera = selection.kind === 'camera'
    ? stage.cameras.find(camera => camera.id === selection.id)
    : undefined
  const selectedProp = selection.kind === 'prop'
    ? (stage.props ?? []).find(prop => prop.id === selection.id)
    : undefined

  /** 选中对象在时间轴上的轨道（道具没有轨道：协议的 track 只区分角色与机位）。 */
  const selectedTrack = selection.kind === 'prop'
    ? undefined
    : trackOf(working(), selection.kind === 'camera' ? 'camera' : 'actor', selection.id)

  const atSnapped = snapToFrame(clampTime(time, timelineView))
  const hasKeyHere = (selectedTrack?.keyframes ?? []).some(frame => snapToFrame(frame.at) === atSnapped)

  const recordTransform = (): void => {
    if (selection.kind === 'camera') {
      if (selectedCamera === undefined) return
      writeTimeline(putKeyframe(working(), 'camera', selectedCamera.id, {
        at: time,
        // 整份机位快照：只存位置的话，镜头推近那一下在时间轴上就丢了。
        camera: {
          id: selectedCamera.id,
          name: selectedCamera.name,
          x: selectedCamera.x,
          y: selectedCamera.y,
          z: selectedCamera.z,
          targetX: selectedCamera.targetX,
          targetY: selectedCamera.targetY,
          targetZ: selectedCamera.targetZ,
          fov: selectedCamera.fov,
        },
      }))
      return
    }
    if (selectedActor === undefined) return
    writeTimeline(putKeyframe(working(), 'actor', selectedActor.id, {
      at: time,
      position: [selectedActor.x, 0, selectedActor.z],
      facing: selectedActor.rotation ?? 0,
    }))
  }

  const dropTransformKey = (): void => {
    if (selection.kind === 'prop') return
    writeTimeline(removeKeyframe(
      working(), selection.kind === 'camera' ? 'camera' : 'actor', selection.id, time,
    ))
  }

  const recordPose = (): void => {
    if (selectedActor === undefined) return
    writeTimeline(putKeyframe(working(), 'actor', selectedActor.id, { at: time, rig: selectedActor.rig }))
  }

  const dropPoseKey = (): void => {
    if (selectedActor === undefined) return
    writeTimeline(removeKeyframe(working(), 'actor', selectedActor.id, time))
  }

  const applyPreset = (preset: typeof POSE_PRESETS[number]): void => {
    if (selectedActor === undefined) return
    props.onStageChange(withPosePreset(stage, selectedActor.id, preset))
  }

  /** 时长：先按整数夹到 2–15，再让时间轴里的关键帧跟着裁一遍。 */
  const setDuration = (next: number): void => {
    const duration = Math.min(STAGE_MAX_DURATION, Math.max(STAGE_MIN_DURATION, Math.round(next)))
    writeTimeline(retimeTimeline({ ...working(), duration }, duration))
  }

  /* ------------------------------------------------------------ 轨迹 */

  const startDraft = (shape: CanvasStagePath['shape']): void => {
    setDraftShape(shape)
    setDraft({ shape, points: [] })
  }

  const commitDraft = (): void => {
    if (draft === null || selection.kind !== 'actor' || draft.points.length < 2) {
      setDraft(null)
      return
    }
    const path: CanvasStagePath = {
      id: `path-${Math.random().toString(36).slice(2, 10)}`,
      shape: draft.shape,
      points: draft.points,
      // 从播放头开始，默认铺 2 秒（或到结尾为止）。用户随后能在列表里改这两个数。
      start: time,
      end: Math.min(timelineView.duration, time + 2),
      height: 0,
      orient: true,
    }
    writeTimeline(putPath(working(), 'actor', selection.id, path))
    setDraft(null)
  }

  const selectedPaths = selectedActor === undefined
    ? []
    : (trackOf(working(), 'actor', selectedActor.id)?.paths ?? [])

  const patchPath = (path: CanvasStagePath, patch: Partial<CanvasStagePath>): void => {
    if (selectedActor === undefined) return
    writeTimeline(putPath(working(), 'actor', selectedActor.id, { ...path, ...patch }))
  }

  const dropPath = (pathId: string): void => {
    if (selectedActor === undefined) return
    writeTimeline(removePath(working(), 'actor', selectedActor.id, pathId))
  }

  /* ------------------------------------------------------------ 刻度 */

  const duration = timelineView.duration
  const totalFrames = frameCount(timelineView)
  const currentFrame = Math.min(totalFrames - 1, Math.round(time * STAGE_FPS))
  const ticks = Array.from({ length: Math.floor(duration) + 1 }, (_, index) => index)

  const rows = [
    ...stage.actors.map((actor, index) => ({
      key: `actor:${actor.id}`,
      name: actor.name || tt('canvas.stage.actorN', { letter: String.fromCharCode(65 + index) }),
      keyframes: trackOf(timelineView, 'actor', actor.id)?.keyframes ?? [],
      paths: trackOf(timelineView, 'actor', actor.id)?.paths ?? [],
    })),
    ...stage.cameras.map((camera, index) => ({
      key: `camera:${camera.id}`,
      name: camera.name || tt('canvas.stage.cameraN', { index: index + 1 }),
      keyframes: trackOf(timelineView, 'camera', camera.id)?.keyframes ?? [],
      paths: trackOf(timelineView, 'camera', camera.id)?.paths ?? [],
    })),
  ]

  /* --------------------------------------------------------- 导出视频 */

  const progress = props.videoExportProgress
  const exporting = progress !== null
  const percent = exporting ? Math.max(0, Math.min(100, Math.round(progress * 100))) : 0

  const body = <div
    className={css.root}
    data-canvas-no-zoom=""
    role="dialog"
    aria-modal="true"
    aria-label={tt('canvas.stage.title')}
  >
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

          <div className={css.list} role="listbox" aria-label={tt('canvas.stage.cameras')}>
            {stage.cameras.map((camera, index) => {
              const name = camera.name || tt('canvas.stage.cameraN', { index: index + 1 })
              if (!matches(name)) return null
              return <div
                key={camera.id}
                className={selection.kind === 'camera' && selection.id === camera.id
                  ? `${css.row} ${css.rowActive}` : css.row}
                role="option"
                aria-selected={stage.cameraId === camera.id}
                onClick={() => {
                  props.onStageChange({ ...stage, cameraId: camera.id })
                  setSelection({ kind: 'camera', id: camera.id })
                }}
              >
                <span className={css.rowIcon}><ToolbarIcon name="video" size={13} /></span>
                <span className={css.rowName} title={name}>{name}</span>
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
                const name = actor.name || tt('canvas.stage.actorN', { letter: String.fromCharCode(65 + index) })
                if (!matches(name)) return null
                return <div
                  key={actor.id}
                  className={selection.kind === 'actor' && selection.id === actor.id
                    ? `${css.row} ${css.rowActive}` : css.row}
                  role="option"
                  aria-selected={selection.kind === 'actor' && selection.id === actor.id}
                  onClick={() => setSelection({ kind: 'actor', id: actor.id })}
                >
                  <span className={css.rowIcon}><ToolbarIcon name="select" size={13} /></span>
                  <span className={css.rowName} title={name}>{name}</span>
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

            {(stage.props ?? []).length > 0 ? <div className={css.sideSection}>{tt('canvas.stage.props')}</div> : null}
            {(stage.props ?? []).map(prop => {
              if (!matches(prop.name)) return null
              return <div
                key={prop.id}
                className={selection.kind === 'prop' && selection.id === prop.id
                  ? `${css.row} ${css.rowActive}` : css.row}
                role="option"
                aria-selected={selection.kind === 'prop' && selection.id === prop.id}
                onClick={() => setSelection({ kind: 'prop', id: prop.id })}
              >
                <span className={css.rowIcon}><ToolbarIcon name="layers" size={13} /></span>
                <span className={css.rowName} title={prop.name}>{prop.name}</span>
                <button
                  type="button"
                  className={css.rowDelete}
                  aria-label={tt('canvas.stage.removeProp')}
                  title={tt('canvas.stage.removeProp')}
                  onClick={event => { event.stopPropagation(); removePropById(prop.id) }}
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
                const cameras = next.cameras.map(camera => (camera.id === framed.id ? framed : camera))
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
            <div className={css.propButtons}>
              <button
                type="button"
                className={css.sideButton}
                onClick={() => {
                  const next = addProp(stage, 'cube')
                  props.onStageChange(next)
                  const added = (next.props ?? [])[(next.props ?? []).length - 1]
                  if (added !== undefined) setSelection({ kind: 'prop', id: added.id })
                }}
              >{tt('canvas.stage.addCube')}</button>
              <button
                type="button"
                className={css.sideButton}
                onClick={() => {
                  const next = addProp(stage, 'sphere')
                  props.onStageChange(next)
                  const added = (next.props ?? [])[(next.props ?? []).length - 1]
                  if (added !== undefined) setSelection({ kind: 'prop', id: added.id })
                }}
              >{tt('canvas.stage.addSphere')}</button>
            </div>
          </div>
        </>}
      </aside>

      {/* ---------------------------------------------------- 中间视口 */}
      <main className={css.stage}>
        {/* 顶栏：中间是模式切换，右边是两个出口。出口放顶部而不是底部，是因为
            底部要整条让给时间轴——一条固定的时间轴会吃掉 150px 高，再把按钮留
            在下面，正方形视口就会被挤成一条缝。 */}
        <div className={css.stageTopBar}>
          <span className={css.topSpacer} aria-hidden="true" />
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
          <div className={css.exportRow}>
            {exporting ? <>
              <span
                className={css.exportProgress}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                title={tt('canvas.stage.exporting', { percent })}
              >
                <span className={css.exportBar}>
                  <span className={css.exportBarFill} style={{ width: `${percent}%` }} />
                </span>
                <span className={css.exportPercent}>{tt('canvas.stage.exporting', { percent })}</span>
              </span>
              <button
                type="button"
                className={css.sideButton}
                onClick={props.onCancelVideoExport}
              >{tt('canvas.stage.exportCancel')}</button>
            </> : <>
              <button
                type="button"
                className={css.exportButton}
                disabled={!props.videoExportable}
                title={props.videoExportable
                  ? tt('canvas.stage.exportVideoHint')
                  : tt('canvas.stage.exportNoTimeline')}
                onClick={props.onExportVideo}
              ><ToolbarIcon name="video" size={13} />{tt('canvas.stage.exportVideo')}</button>
              <button
                type="button"
                className={css.sideButton}
                disabled={busy}
                title={tt('canvas.stage.captureHint', { size: CAPTURE_SIZE })}
                onClick={capture}
              ><ToolbarIcon name="image" size={13} />{busy
                ? tt('canvas.pose.exporting')
                : tt('canvas.stage.capture')}</button>
            </>}
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
              title={tt('canvas.stage.selectActor')}
              onClick={() => setTool('select')}
            ><ToolbarIcon name="select" size={14} /><span>{tt('canvas.stage.selectActor')}</span></button>
            <button
              type="button"
              className={css.toolButton}
              aria-pressed={tool === 'orbit'}
              title={tt('canvas.stage.resetView')}
              onClick={() => setTool('orbit')}
            ><ToolbarIcon name="pan" size={14} /></button>
          </div>

          <div className={css.prompt}>
            <input
              type="text"
              className={css.promptInput}
              value={prompt}
              placeholder={tt('canvas.stage.promptPlaceholder')}
              aria-label={tt('canvas.stage.promptLabel')}
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
              aria-label={tt('canvas.stage.promptLabel')}
              disabled={prompt.trim() === ''}
              onClick={submitPrompt}
            ><ToolbarIcon name="send" size={14} /></button>
          </div>
        </div>

        {/* -------------------------------------------------- 时间轴 */}
        <div className={css.timelineBar}>
          <div className={css.timelineTop}>
            <div className={css.playRow}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={tt('canvas.stage.toStart')}
                title={tt('canvas.stage.toStart')}
                onClick={() => setTime(0)}
              ><SkipBack size={14} strokeWidth={1.6} aria-hidden /></button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={tt('canvas.stage.prevFrame')}
                title={tt('canvas.stage.prevFrame')}
                onClick={() => setTime(current => Math.max(0, snapToFrame(current) - FRAME))}
              ><StepBack size={14} strokeWidth={1.6} aria-hidden /></button>
              <button
                type="button"
                className={css.playButton}
                aria-label={tt('canvas.stage.play')}
                title={tt('canvas.stage.play')}
                aria-pressed={playing}
                onClick={() => setPlaying(current => !current)}
              >{playing
                ? <Pause size={14} strokeWidth={1.8} aria-hidden />
                : <Play size={14} strokeWidth={1.8} aria-hidden />}</button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={tt('canvas.stage.nextFrame')}
                title={tt('canvas.stage.nextFrame')}
                onClick={() => setTime(current => Math.min(duration, snapToFrame(current) + FRAME))}
              ><StepForward size={14} strokeWidth={1.6} aria-hidden /></button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={tt('canvas.stage.loop')}
                title={tt('canvas.stage.loop')}
                aria-pressed={loop}
                onClick={() => setLoop(current => !current)}
              ><Repeat size={14} strokeWidth={1.6} aria-hidden /></button>
            </div>

            <span className={css.timelineClock}>
              {tt('canvas.stage.frameAt', {
                time: time.toFixed(2), duration, frame: currentFrame,
              })}
            </span>

            <label className={css.durationField}>
              <span>{tt('canvas.stage.duration')}</span>
              <NumberField
                label={tt('canvas.stage.duration')}
                value={duration}
                min={STAGE_MIN_DURATION}
                max={STAGE_MAX_DURATION}
                step={1}
                onChange={setDuration}
              />
            </label>
            <span className={css.fpsBadge}>{tt('canvas.stage.fps', { fps: STAGE_FPS })}</span>
          </div>

          <div className={css.scrubRow}>
            <input
              type="range"
              className={css.scrub}
              min={0}
              max={duration}
              step={FRAME}
              value={Math.min(time, duration)}
              aria-label={tt('canvas.stage.timeline')}
              onChange={event => setTime(Number(event.target.value))}
            />
            <div className={css.ticks} aria-hidden="true">
              {ticks.map(tick => <span key={tick} className={css.tick}>{tick}s</span>)}
            </div>
          </div>

          <div className={css.tracks}>
            {rows.map(row => <div key={row.key} className={css.trackRow}>
              <span className={css.trackName} title={row.name}>{row.name}</span>
              <div
                className={css.lane}
                onClick={event => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  const ratio = rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width
                  setTime(snapToFrame(Math.min(duration, Math.max(0, ratio * duration))))
                }}
              >
                {/* 轨迹段画在菱形下面：一段轨迹是**一段区间**，用横条表达；
                    关键帧是**一个时刻**，用菱形表达。两者叠在同一条轨道上，
                    用户一眼就能看出「这段时间在按路径走」与「这一刻被固定住」。
                    没有这一段的话，设了圆形轨迹的角色在时间轴上看起来和没设
                    一样——牧野那边轨迹段是可见的，这里不能只存在于右栏列表里。 */}
                {row.paths.map(path => <span
                  key={path.id}
                  className={css.pathBand}
                  style={{
                    left: `calc(${duration <= 0 ? 0 : (path.start / duration) * 100}% )`,
                    width: `calc(${duration <= 0 ? 0 : ((path.end - path.start) / duration) * 100}% )`,
                  }}
                  title={tt('canvas.stage.pathBandHint', { start: path.start.toFixed(2), end: path.end.toFixed(2) })}
                />)}
                {row.keyframes.map(frame => <span
                  key={frame.at}
                  className={frame.at === atSnapped ? `${css.keyDot} ${css.keyDotCurrent}` : css.keyDot}
                  // 用 `calc(<百分比> - 3.5px)` 而不是裸百分比：菱形宽 7px，
                  // 减去半宽之后中心才正好压在刻度上，0% 与 100% 也不会探出
                  // 轨道被外层 `overflow-x: hidden` 裁掉。
                  style={{ left: `calc(${duration <= 0 ? 0 : (frame.at / duration) * 100}% - 3.5px)` }}
                  title={tt('canvas.stage.frameAt', {
                    time: frame.at.toFixed(2), duration, frame: Math.round(frame.at * STAGE_FPS),
                  })}
                />)}
              </div>
            </div>)}
          </div>
        </div>
      </main>

      {/* ---------------------------------------------------- 右栏 */}
      <aside className={css.inspector}>
        {/* 关键帧：道具没有轨道（协议的 track 只区分角色与机位），所以选中道具时
            整段不出现，而不是留两个永远禁用的按钮。 */}
        {selection.kind === 'prop' ? null : <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.timeline')}</h3>
          <div className={css.keyframeRow}>
            <button type="button" className={css.sideButton} onClick={recordTransform}>
              {tt('canvas.stage.recordTransformKey')}
            </button>
            <button
              type="button"
              className={css.sideButton}
              disabled={!hasKeyHere}
              onClick={dropTransformKey}
            >{tt('canvas.stage.deleteTransformKey')}</button>
          </div>
          {selectedActor !== undefined ? <div className={css.keyframeRow}>
            <button type="button" className={css.sideButton} onClick={recordPose}>
              {tt('canvas.stage.recordPoseKey')}
            </button>
            <button
              type="button"
              className={css.sideButton}
              disabled={!hasKeyHere}
              onClick={dropPoseKey}
            >{tt('canvas.stage.deletePoseKey')}</button>
          </div> : null}
        </section>}

        {/* 运动轨迹：只有角色能画（机位的关键帧已经能编出运镜）。 */}
        {selectedActor !== undefined ? <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.motionPath')}</h3>
          {draft === null ? <>
            <div className={css.presetGrid}>
              <button type="button" className={css.pathChip} onClick={() => startDraft('circle')}>
                <ToolbarIcon name="timeline" size={12} />{tt('canvas.stage.pathCircle')}
              </button>
              <button type="button" className={css.pathChip} onClick={() => startDraft('line')}>
                <ToolbarIcon name="connections" size={12} />{tt('canvas.stage.pathLine')}
              </button>
              <button type="button" className={css.pathChip} onClick={() => startDraft('rect')}>
                <ToolbarIcon name="arrange" size={12} />{tt('canvas.stage.pathRect')}
              </button>
              <button type="button" className={css.pathChip} onClick={() => startDraft('free')}>
                <Pencil size={12} strokeWidth={1.6} aria-hidden />{tt('canvas.stage.pathPencil')}
              </button>
              <button type="button" className={css.pathChip} onClick={() => startDraft('free')}>
                <PenTool size={12} strokeWidth={1.6} aria-hidden />{tt('canvas.stage.pathPen')}
              </button>
            </div>
            {selectedPaths.length === 0 ? <p className={css.empty}>{tt('canvas.stage.pathEmpty')}</p> : null}
          </> : <>
            <p className={css.empty}>{tt('canvas.stage.pathHint')}</p>
            <div className={css.keyframeRow}>
              <button
                type="button"
                className={css.sideButton}
                disabled={draft.points.length < 2}
                onClick={commitDraft}
              >{tt('canvas.stage.pathFinish')}</button>
              <button type="button" className={css.sideButton} onClick={() => setDraft(null)}>
                {tt('canvas.stage.pathCancel')}
              </button>
            </div>
          </>}

          {selectedPaths.map(path => <div key={path.id} className={css.pathRow}>
            <div className={css.pathRowHead}>
              <span className={css.pathShape}>
                {path.shape === 'circle' ? tt('canvas.stage.pathCircle')
                  : path.shape === 'line' ? tt('canvas.stage.pathLine')
                    : path.shape === 'rect' ? tt('canvas.stage.pathRect')
                      : tt('canvas.stage.pathPencil')}
              </span>
              <button
                type="button"
                className={css.rowDelete}
                aria-label={tt('canvas.stage.removePath')}
                title={tt('canvas.stage.removePath')}
                onClick={() => dropPath(path.id)}
              ><ToolbarIcon name="trash" size={12} /></button>
            </div>
            {/* 时间窗口：开始 / 结束各一个框，带自己的标签。早先两个框共用一个
                「时间轴」标签、靠位置暗示哪个是起点，读起来要猜；专用键已经有
                了，就不该再靠布局传达语义。 */}
            <div className={css.field}>
              <span className={css.fieldLabel}>{tt('canvas.stage.pathStart')} / {tt('canvas.stage.pathEnd')}</span>
              <span className={css.fieldRow}>
                <NumberField
                  label={tt('canvas.stage.pathStart')}
                  value={Number(path.start.toFixed(2))}
                  min={0}
                  max={duration}
                  step={0.1}
                  onChange={next => patchPath(path, {
                    start: Math.min(Math.max(0, path.end - FRAME), Math.max(0, next)),
                  })}
                />
                <NumberField
                  label={tt('canvas.stage.pathEnd')}
                  value={Number(path.end.toFixed(2))}
                  min={0}
                  max={duration}
                  step={0.1}
                  onChange={next => patchPath(path, {
                    end: Math.min(duration, Math.max(path.start + FRAME, next)),
                  })}
                />
              </span>
            </div>
            <div className={css.fieldRow}>
              <label className={css.tripleCell}>
                <span>{tt('canvas.stage.pathHeight')}</span>
                <NumberField
                  label={tt('canvas.stage.pathHeight')}
                  value={path.height ?? 0}
                  step={0.1}
                  onChange={next => patchPath(path, { height: next })}
                />
              </label>
              <label className={css.toggleRow}>
                <span className={css.fieldLabel}>{tt('canvas.stage.pathOrient')}</span>
                <input
                  type="checkbox"
                  className={css.checkbox}
                  checked={path.orient === true}
                  aria-label={tt('canvas.stage.pathOrient')}
                  onChange={event => patchPath(path, { orient: event.target.checked })}
                />
              </label>
            </div>
          </div>)}
          <p className={css.empty}>{tt('canvas.stage.trackHint')}</p>
        </section> : null}

        {selectedActor !== undefined ? <>
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{tt('canvas.pose.presets')}</h3>
            <div className={css.presetGrid}>
              {POSE_PRESETS.map(preset => <button
                key={preset.id}
                type="button"
                className={css.presetChip}
                onClick={() => applyPreset(preset)}
              >{tt(preset.labelKey as ImageGenKey)}</button>)}
            </div>
          </section>

          <section className={css.section}>
            <h3 className={css.sectionTitle}>{tt('canvas.pose.facing')}</h3>
            <label className={css.field}>
              <span className={css.fieldRow}>
                <input
                  type="range"
                  className={css.slider}
                  min={-180}
                  max={180}
                  step={5}
                  value={selectedActor.rig.facing}
                  aria-label={tt('canvas.pose.facing')}
                  onChange={event => patchActor(selectedActor.id, {
                    rig: { ...selectedActor.rig, facing: Number(event.target.value) },
                  })}
                />
                <span className={css.value}>{Math.round(selectedActor.rig.facing)}°</span>
              </span>
            </label>
          </section>
        </> : null}

        <section className={css.section}>
          <h3 className={css.sectionTitle}>{tt('canvas.stage.settings')}</h3>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.figure')}</span>
            <div className={css.segmented} role="group" aria-label={tt('canvas.stage.figure')}>
              {(['clay', 'wood'] as const).map(figure => <button
                key={figure}
                type="button"
                className={css.segment}
                aria-pressed={(stage.scene.figure ?? 'clay') === figure}
                onClick={() => patchScene({ figure })}
              >{tt(figure === 'clay' ? 'canvas.stage.figureClay' : 'canvas.stage.figureWood')}</button>)}
            </div>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{tt('canvas.stage.body')}</span>
            <div className={css.segmented} role="group" aria-label={tt('canvas.stage.body')}>
              {(['standard', 'procedural'] as const).map(body => <button
                key={body}
                type="button"
                className={css.segment}
                aria-pressed={(stage.scene.body ?? 'standard') === body}
                onClick={() => patchScene({ body })}
              >{tt(body === 'standard' ? 'canvas.stage.bodyStandard' : 'canvas.stage.bodyProcedural')}</button>)}
            </div>
          </div>

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
                  斜过来，那不是一个场景该有的状态。X/Z 摆在那里是为了和竞品的
                  三格对齐，禁用而不是假装能改。 */}
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

          {selectedProp !== undefined ? <>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('canvas.stage.props')}</span>
              <input
                type="text"
                className={css.textInput}
                value={selectedProp.name}
                aria-label={tt('canvas.stage.props')}
                onChange={event => patchPropById(selectedProp.id, { name: event.target.value })}
              />
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{tt('canvas.stage.position')}</span>
              <div className={css.triple}>
                {(['X', 'Y', 'Z'] as const).map(axis => <label key={axis} className={css.tripleCell}>
                  <span>{axis}</span>
                  <NumberField
                    label={`${tt('canvas.stage.props')} ${tt('canvas.stage.position')} ${axis}`}
                    value={axis === 'X' ? selectedProp.x : axis === 'Y' ? selectedProp.y : selectedProp.z}
                    step={0.1}
                    onChange={next => patchPropById(
                      selectedProp.id,
                      axis === 'X' ? { x: next } : axis === 'Y' ? { y: next } : { z: next },
                    )}
                  />
                </label>)}
              </div>
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{tt('canvas.stage.scale')}</span>
              <div className={css.triple}>
                {(['X', 'Y', 'Z'] as const).map(axis => <label key={axis} className={css.tripleCell}>
                  <span>{axis}</span>
                  <NumberField
                    label={`${tt('canvas.stage.props')} ${tt('canvas.stage.scale')} ${axis}`}
                    value={axis === 'X'
                      ? selectedProp.scaleX ?? 1
                      : axis === 'Y' ? selectedProp.scaleY ?? 1 : selectedProp.scaleZ ?? 1}
                    min={0.05}
                    step={0.1}
                    onChange={next => patchPropById(
                      selectedProp.id,
                      axis === 'X' ? { scaleX: next } : axis === 'Y' ? { scaleY: next } : { scaleZ: next },
                    )}
                  />
                </label>)}
              </div>
            </div>
          </> : null}

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

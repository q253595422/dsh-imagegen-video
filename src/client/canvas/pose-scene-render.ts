/**
 * 导演台的场景渲染：天空、地面网格、多个角色、角色标签、机位视锥。
 *
 * 与 `pose-rig.ts` 的分工：
 *   - `pose-rig` 负责**一个人**怎么被画（骨架求解、球体、距离场、明暗）。
 *   - 这里负责**一台戏**怎么被画（每个角色放在哪、谁挡着谁、地面与天空、
 *     以及当前机位的取景框）。
 *
 * 为什么多角色必须各自成一张遮罩再合成，而不是把所有人的球体并进同一个
 * 距离场：距离场是**屏幕空间**的，合并之后两个人的轮廓会在接壤处被
 * smooth-min 融成一块——后排的人会像贴在前面那人身上的一个鼓包，前后
 * 关系彻底丢失。各自成形、按角色中心深度排序、依次贴上去，才有遮挡。
 *
 * 仍然是纯 Canvas 2D：不引 WebGL/three.js（理由见 `pose-rig.ts` 开头，
 * 远程桌面与禁用硬件加速会让整块画面白掉）。
 */

import type { CanvasPoseActor, CanvasPoseStage } from '../../protocol.ts'
import {
  POSE_GROUND_Y, POSE_SEGMENTS, buildSpheres, makeProjector, solveRig,
  type PoseCamera, type PoseJoint, type PoseSphere,
} from './pose-rig.ts'
import { actorTransform, currentRenderCamera, scaleFactor } from './pose-stage.ts'
import { figurePaletteOf } from './figure-colors.ts'

export interface SceneRenderOptions {
  size: number
  stage: CanvasPoseStage
  /** 覆盖机位（面板拖动预览时用自由相机）；缺省用舞台当前机位。 */
  camera?: PoseCamera
  /** 画辅助线与关节标记；导出时关掉。 */
  guides: boolean
  /** 画当前机位的视锥线框（机位视角下通常关掉——它就在你眼睛里）。 */
  frustum?: boolean
  /** 全景球贴图；缺省不画。 */
  pano?: CanvasImageSource | null
}

/** 世界坐标球体 + 该球体的角色 id，合成时按角色分组排序。 */
interface ActorShape {
  actor: CanvasPoseActor
  spheres: PoseSphere[]
  /** 该角色所有关节的世界（已施加场景变换），供骨骼线与标签使用。 */
  joints: Record<PoseJoint, [number, number, number]>
  /** 角色中心的相机空间深度，用于排序。 */
  depth: number
  /** 头顶世界坐标，供画名字。 */
  headTop: [number, number, number]
}

/** 把一个人偶的世界坐标搬进场景坐标：缩放 → 绕 y 旋转 → 平移。 */
function place(
  point: [number, number, number],
  scale: number, rotationDeg: number, offset: [number, number, number],
): [number, number, number] {
  const rot = rotationDeg * Math.PI / 180
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  return [
    (point[0] * cos + point[2] * sin) * scale + offset[0],
    point[1] * scale + offset[1],
    (-point[0] * sin + point[2] * cos) * scale + offset[2],
  ]
}

/** 舞台里每个角色在场景坐标下的形体。 */
function shapesOf(stage: CanvasPoseStage, project: (p: [number, number, number]) => [number, number, number] | null): ActorShape[] {
  const shapes: ActorShape[] = []
  for (const actor of stage.actors) {
    const transform = actorTransform(stage, actor)
    const world = solveRig(actor.rig)
    const joints = {} as Record<PoseJoint, [number, number, number]>
    let depthSum = 0
    let depthCount = 0
    for (const joint of Object.keys(world) as PoseJoint[]) {
      const placed = place(world[joint], transform.scale, transform.rotation, transform.offset)
      joints[joint] = placed
      const projected = project(placed)
      if (projected !== null) {
        depthSum += projected[2]
        depthCount += 1
      }
    }
    const spheres = buildSpheres(actor.rig, world).map(sphere => {
      const placed = place(
        [sphere.x, sphere.y, sphere.z],
        transform.scale, transform.rotation, transform.offset,
      )
      return { x: placed[0], y: placed[1], z: placed[2], r: sphere.r * transform.scale }
    })
    const headWorld = place(
      [world.head[0], world.head[1] + 0.14, world.head[2]],
      transform.scale, transform.rotation, transform.offset,
    )
    shapes.push({
      actor, spheres, joints,
      depth: depthCount > 0 ? depthSum / depthCount : Infinity,
      headTop: headWorld,
    })
  }
  // 远的先画、近的后画：画家算法在人物之间成立（人是不相交的凸体块，
  // 按中心深度排序的错判率远低于按逐球排序带来的接缝）。
  return shapes.sort((a, b) => b.depth - a.depth)
}

/** 把一个人物的球体画成一张遮罩（局部包围盒内计算，省掉整屏空白格）。 */
function paintActorMask(
  spheres: PoseSphere[], size: number, fieldSize: number, fieldCell: number,
  project: (p: [number, number, number]) => [number, number, number] | null,
  focal: number,
  body: readonly [number, number, number],
): HTMLCanvasElement | null {
  interface Disc { cx: number; cy: number; r: number }
  const discs: Disc[] = []
  for (const sphere of spheres) {
    const projected = project([sphere.x, sphere.y, sphere.z])
    if (projected === null) continue
    discs.push({ cx: projected[0], cy: projected[1], r: Math.max(0.8, (sphere.r * focal) / projected[2]) })
  }
  if (discs.length === 0) return null

  // 融合半径与世界尺寸成比例：人越大、离得越近，接缝越应该跟着变粗一点，
  // 否则放大之后腋下的缝会显得像刀刻的。
  const K = Math.max(0.9, size * 0.0035)

  /* 只在包围盒里算。
   *
   * 整屏算一个角色是 4 倍以上的浪费，而导演台里通常有 1–4 个角色、且每帧
   * 都要重画（拖动预览）。包围盒取 disc 的屏幕范围外扩 K 与一个格的余量。
   */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const disc of discs) {
    minX = Math.min(minX, disc.cx - disc.r)
    minY = Math.min(minY, disc.cy - disc.r)
    maxX = Math.max(maxX, disc.cx + disc.r)
    maxY = Math.max(maxY, disc.cy + disc.r)
  }
  const pad = K * 2 + fieldCell * 2
  const gx0 = Math.max(0, Math.floor((minX - pad) / fieldCell))
  const gy0 = Math.max(0, Math.floor((minY - pad) / fieldCell))
  const gx1 = Math.min(fieldSize - 1, Math.ceil((maxX + pad) / fieldCell))
  const gy1 = Math.min(fieldSize - 1, Math.ceil((maxY + pad) / fieldCell))
  if (gx1 < gx0 || gy1 < gy0) return null

  const width = gx1 - gx0 + 1
  const height = gy1 - gy0 + 1
  const mask = document.createElement('canvas')
  mask.width = width
  mask.height = height
  const maskCtx = mask.getContext('2d')
  if (maskCtx === null) return null

  const field = new Float32Array(width * height)
  const smin = (a: number, b: number): number => Math.min(a, b) - Math.max(0, K - Math.abs(a - b)) ** 2 / (4 * K)
  for (let gy = 0; gy < height; gy += 1) {
    const py = (gy0 + gy + 0.5) * fieldCell
    for (let gx = 0; gx < width; gx += 1) {
      const px = (gx0 + gx + 0.5) * fieldCell
      let distance = 1e9
      for (const disc of discs) {
        const dx = px - disc.cx
        const dy = py - disc.cy
        if (Math.abs(dx) > distance + disc.r + K && Math.abs(dy) > distance + disc.r + K) continue
        const d = Math.hypot(dx, dy) - disc.r
        distance = distance === 1e9 ? d : smin(distance, d)
      }
      field[gy * width + gx] = distance
    }
  }

  const edge = fieldCell * 1.1
  const image = maskCtx.createImageData(width, height)
  // 光从左上偏前方来：三个人物必须共用同一个光源，否则并排站着像三张
  // 不同的贴图拼在一起。
  const lx = -0.42, ly = -0.50, lz = 0.76
  const normalRadius = size * 0.10
  const fieldAt = (gx: number, gy: number): number => {
    const x = gx < 0 ? 0 : (gx >= width ? width - 1 : gx)
    const y = gy < 0 ? 0 : (gy >= height ? height - 1 : gy)
    return field[y * width + x] ?? 0
  }
  for (let gy = 0; gy < height; gy += 1) {
    for (let gx = 0; gx < width; gx += 1) {
      const i = gy * width + gx
      const d = field[i] ?? 0
      const alpha = Math.max(0, Math.min(1, 0.5 - d / edge))
      if (alpha <= 0) continue
      const gxv = ((fieldAt(gx + 1, gy) - fieldAt(gx - 1, gy)) * 0.5) / fieldCell
      const gyv = ((fieldAt(gx, gy + 1) - fieldAt(gx, gy - 1)) * 0.5) / fieldCell
      const inward = Math.max(0, Math.min(1, 1 + d / normalRadius))
      const nx = Math.max(-1, Math.min(1, gxv * inward))
      const ny = Math.max(-1, Math.min(1, gyv * inward))
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny))
      const shade = nx * lx + ny * ly + nz * lz
      const tone = 0.94 + 0.14 * shade
      // 与 3D 共用 `figure-colors.ts` 的色表。两个渲染器各写一个颜色时，
      // 没有 WebGL 的机器上人偶是灰的、有 WebGL 的是木色的——同一台机器
      // 换台电脑，人会「换个颜色」。
      image.data[i * 4] = Math.round(body[0] * tone)
      image.data[i * 4 + 1] = Math.round(body[1] * tone)
      image.data[i * 4 + 2] = Math.round(body[2] * tone)
      image.data[i * 4 + 3] = Math.round(alpha * 255)
    }
  }
  maskCtx.putImageData(image, 0, 0)
  // 记住这块遮罩对应的屏幕原点，绘制时按它贴回去。
  mask.dataset.originX = String(gx0 * fieldCell)
  mask.dataset.originY = String(gy0 * fieldCell)
  return mask
}

/** 画一段渐变天空与地面。地平线高度由相机俯仰角决定，yaw 不影响它。 */
function paintSkyAndGround(ctx: CanvasRenderingContext2D, size: number, camera: PoseCamera, stage: CanvasPoseStage): void {
  const sky = stage.scene.sky
  const ground = stage.scene.ground ?? '#12141c'
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  // 相机 pitch > 0 表示它在目标上方、向下看；地平线因此上移。
  const horizon = size / 2 - focal * Math.tan(camera.pitch * Math.PI / 180)
  const clamped = Math.max(-size, Math.min(size * 2, horizon))

  const skyGradient = ctx.createLinearGradient(0, Math.min(0, clamped), 0, Math.max(1, clamped))
  skyGradient.addColorStop(0, sky)
  skyGradient.addColorStop(1, mixColor(sky, ground, 0.55))
  ctx.fillStyle = skyGradient
  ctx.fillRect(0, Math.min(0, clamped), size, Math.max(1, clamped - Math.min(0, clamped)))

  // 地面：靠近地平线处融进天空色，否则会看到一条生硬的分界线。
  const groundGradient = ctx.createLinearGradient(0, Math.max(0, clamped), 0, size)
  groundGradient.addColorStop(0, mixColor(sky, ground, 0.45))
  groundGradient.addColorStop(0.25, ground)
  groundGradient.addColorStop(1, mixColor(ground, '#000000', 0.35))
  ctx.fillStyle = groundGradient
  ctx.fillRect(0, Math.max(0, clamped), size, size - Math.max(0, clamped))
}

/** 把两个十六进制颜色按比例混合；认不出的颜色原样返回前者。 */
function mixColor(a: string, b: string, ratio: number): string {
  const parse = (value: string): [number, number, number] | null => {
    const hex = value.trim()
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
    if (short !== null) {
      return [parseInt(short[1]! + short[1]!, 16), parseInt(short[2]! + short[2]!, 16), parseInt(short[3]! + short[3]!, 16)]
    }
    const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
    if (long !== null) return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)]
    return null
  }
  const from = parse(a)
  const to = parse(b)
  if (from === null || to === null) return a
  const t = Math.max(0, Math.min(1, ratio))
  const channel = (index: number): string => Math.round(from[index]! + (to[index]! - from[index]!) * t).toString(16).padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

/** 地面网格：世界平面 y=0 上的正交线，经场景变换后投影。 */
function paintGroundGrid(
  ctx: CanvasRenderingContext2D, size: number, project: (p: [number, number, number]) => [number, number, number] | null,
  stage: CanvasPoseStage,
): void {
  const scale = scaleFactor(stage.scene)
  const [tx, ty, tz] = stage.scene.translate
  const rot = stage.scene.rotateY * Math.PI / 180
  // 网格随场景一起缩放；格距固定 0.5 m，缩放到 300% 之后格子也跟着变大，
  // 与人物的相对比例才对。
  const step = 0.5
  const reach = 12
  const toWorld = (x: number, z: number): [number, number, number] => [
    (x * Math.cos(rot) + z * Math.sin(rot)) * scale + tx,
    ty + POSE_GROUND_Y,
    (-x * Math.sin(rot) + z * Math.cos(rot)) * scale + tz,
  ]
  ctx.save()
  ctx.lineWidth = Math.max(1, size / 900)
  for (let i = -reach; i <= reach; i += 1) {
    const offset = i * step
    // 线越远越淡：没有这层衰减，远处的地面会变成一片密网，把人物淹掉。
    const near = toWorld(offset, -reach * step)
    const far = toWorld(offset, reach * step)
    drawGridLine(ctx, project, near, far, size, i === 0)
    const left = toWorld(-reach * step, offset)
    const right = toWorld(reach * step, offset)
    drawGridLine(ctx, project, left, right, size, i === 0)
  }
  ctx.restore()
}

function drawGridLine(
  ctx: CanvasRenderingContext2D,
  project: (p: [number, number, number]) => [number, number, number] | null,
  a: [number, number, number], b: [number, number, number], size: number, axis: boolean,
): void {
  const from = project(a)
  const to = project(b)
  if (from === null || to === null) return
  // 深度取两端里近的那一端：远端已经快贴到地平线时不该还画一条实线。
  const depth = Math.min(from[2], to[2])
  const alpha = axis ? 0.30 : Math.max(0, Math.min(0.22, 0.28 - depth / 40))
  if (alpha <= 0.01) return
  ctx.strokeStyle = `rgba(150,170,210,${alpha.toFixed(3)})`
  ctx.beginPath()
  ctx.moveTo(from[0], from[1])
  ctx.lineTo(to[0], to[1])
  ctx.stroke()
}

/** 当前机位的取景框：四条从视点射向四角的线 + 远端矩形。 */
function paintFrustum(
  ctx: CanvasRenderingContext2D, size: number, stage: CanvasPoseStage,
  project: (p: [number, number, number]) => [number, number, number] | null,
): void {
  const camera = stage.cameras.find(item => item.id === stage.cameraId) ?? stage.cameras[0]
  if (camera === undefined) return
  const halfV = (camera.fov * Math.PI / 180) / 2
  const dx = camera.targetX - camera.x
  const dy = camera.targetY - camera.y
  const dz = camera.targetZ - camera.z
  const length = Math.hypot(dx, dy, dz) || 1
  const forward: [number, number, number] = [dx / length, dy / length, dz / length]
  // 右向量 = forward × up，up 固定为 +y。
  const right: [number, number, number] = [forward[2], 0, -forward[0]]
  const rightLength = Math.hypot(right[0], right[1], right[2]) || 1
  right[0] /= rightLength; right[2] /= rightLength
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  const reach = Math.max(2.4, length * 1.5)
  const halfH = Math.tan(halfV) * reach
  const halfW = halfH * 1.35
  const far: [number, number, number] = [
    camera.x + forward[0] * reach, camera.y + forward[1] * reach, camera.z + forward[2] * reach,
  ]
  const corners: Array<[number, number, number]> = [
    [far[0] - right[0] * halfW + up[0] * halfH, far[1] - right[1] * halfW + up[1] * halfH, far[2] - right[2] * halfW + up[2] * halfH],
    [far[0] + right[0] * halfW + up[0] * halfH, far[1] + right[1] * halfW + up[1] * halfH, far[2] + right[2] * halfW + up[2] * halfH],
    [far[0] + right[0] * halfW - up[0] * halfH, far[1] + right[1] * halfW - up[1] * halfH, far[2] + right[2] * halfW - up[2] * halfH],
    [far[0] - right[0] * halfW - up[0] * halfH, far[1] - right[1] * halfW - up[1] * halfH, far[2] - right[2] * halfW - up[2] * halfH],
  ]
  const eye = project([camera.x, camera.y, camera.z])
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.30)'
  ctx.lineWidth = Math.max(1, size / 1100)
  if (eye !== null) {
    for (const corner of corners) {
      const point = project(corner)
      if (point === null) continue
      ctx.beginPath(); ctx.moveTo(eye[0], eye[1]); ctx.lineTo(point[0], point[1]); ctx.stroke()
    }
  }
  const projectedCorners = corners.map(project)
  if (projectedCorners.every(point => point !== null)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.beginPath()
    projectedCorners.forEach((point, index) => {
      const [x, y] = point!
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.stroke()
  }
  ctx.restore()
}

/** 角色名字标签：画在头顶上方，暗底白字，任何背景上都读得清。 */
function paintLabel(
  ctx: CanvasRenderingContext2D, size: number, text: string,
  project: (p: [number, number, number]) => [number, number, number] | null,
  headTop: [number, number, number],
): void {
  const point = project(headTop)
  if (point === null) return
  const fontSize = Math.max(10, Math.round(size / 34))
  ctx.save()
  ctx.font = `500 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const width = ctx.measureText(text).width
  const paddingX = fontSize * 0.45
  const paddingY = fontSize * 0.25
  const x = Math.max(2, Math.min(size - 2, point[0]))
  const y = Math.max(fontSize + 2, point[1])
  ctx.fillStyle = 'rgba(8,10,14,0.62)'
  const boxX = x - width / 2 - paddingX
  const boxY = y - fontSize - paddingY * 2
  const boxW = width + paddingX * 2
  const boxH = fontSize + paddingY * 2
  const radius = Math.min(boxH / 2, 6)
  ctx.beginPath()
  ctx.roundRect(boxX, boxY, boxW, boxH, radius)
  ctx.fill()
  ctx.fillStyle = '#e8ecf4'
  ctx.fillText(text, x, y - paddingY)
  ctx.restore()
}

/** 影子：地面上的一枚椭圆，把人物「钉」在地上。
 *
 * 没有它，浅色的地面与浅蓝灰的人偶之间会缺一条接触关系，人物看起来像
 * 浮在半空——这是 3D 预览最常被一眼看出「假」的地方。 */
function paintShadow(
  ctx: CanvasRenderingContext2D, project: (p: [number, number, number]) => [number, number, number] | null,
  center: [number, number, number], radius: number, size: number,
): void {
  const point = project(center)
  if (point === null) return
  const near = project([center[0], center[1], center[2] + radius])
  if (near === null) return
  const screenRadius = Math.max(2, Math.abs(near[0] - point[0]) * 0.85)
  const gradient = ctx.createRadialGradient(point[0], point[1], 0, point[0], point[1], screenRadius)
  gradient.addColorStop(0, 'rgba(0,0,0,0.42)')
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.20)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.save()
  ctx.fillStyle = gradient
  // 压扁成椭圆：相机越平视，影子越扁。用一个固定比例 0.32 就是俯视 20°
  // 左右的效果，已经够用，不值得为此再算一次相机仰角。
  ctx.translate(point[0], point[1])
  ctx.scale(1, 0.32)
  ctx.beginPath()
  ctx.arc(0, 0, screenRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * 画整台戏。
 *
 * 顺序即层次：天空/地面 → 地面网格 → 影子 → 角色（远到近，各自成块）
 * → 标签 → 视锥。角色之间是「谁靠近谁后画」，所以遮挡成立。
 */
export function drawScene(ctx: CanvasRenderingContext2D, options: SceneRenderOptions): void {
  const { size, stage, guides } = options
  const camera = options.camera ?? currentRenderCamera(stage)
  ctx.save()
  ctx.clearRect(0, 0, size, size)

  paintSkyAndGround(ctx, size, camera, stage)

  const { focal, project } = makeProjector(size, camera)
  /* 距离场的格子数：跟着画布走，别只跟着「屏幕」走。
   *
   * 这里原本固定 `size / 2.4`（1024 上是 427 格），于是 1280 导出图里的人物
   * 体块是从一张 427² 的遮罩插值放大贴回去的——胳膊贴躯干那条缝、膝弯的
   * 转折全部糊成一片平涂白。真机走查一眼就看见了：预览里分得清的姿势，
   * 导出图里读不出来。
   *
   * 现在按「每个遮罩格最多 2.4 个设备像素」反推格子数，并给一个下限与上限：
   *  - 下限 280 是卡片预览（~200px）还看得清轮廓所需；
   *  - 上限 2048 是逐像素算距离场的成本墙。1280 导出对应 533 格，仍在墙内。 */
  const fieldSize = Math.max(280, Math.min(2048, Math.round(size / 2.4)))
  const fieldCell = size / fieldSize

  paintGroundGrid(ctx, size, project, stage)
  if (options.pano !== null && options.pano !== undefined) {
    // 全景球只做水平环绕：按 `panoYaw` 把图横向循环平移、纵向铺满天空。
    // 完整的球面反投影需要逐像素求逆矩阵，代价远高于它带来的收益——用户
    // 真正要的是「背景有个环境」，不是全景查看器。
    const width = size
    const shift = ((stage.scene.panoYaw % 360) / 360) * width
    ctx.save()
    ctx.globalAlpha = 0.85
    try {
      const ratio = width / (options.pano as { width?: number }).width! || 1
      ctx.drawImage(options.pano, -shift, 0, width, (options.pano as { height?: number }).height! * ratio)
    } catch {
      // 一张还没解码完的图会让 drawImage 抛；这一帧的天空色已经是可看的，
      // 不值得为它中断整个渲染。
    }
    ctx.restore()
  }

  const shapes = shapesOf(stage, project)

  // 影子先全部画完，再画人：否则近处那人的影子会盖到远处那人的脚上。
  for (const shape of shapes) {
    const transform = actorTransform(stage, shape.actor)
    const groundCenter: [number, number, number] = [
      transform.offset[0], transform.offset[1] + POSE_GROUND_Y, transform.offset[2],
    ]
    paintShadow(ctx, project, groundCenter, 0.52 * transform.scale, size)
  }

  for (const shape of shapes) {
    const mask = paintActorMask(
      shape.spheres, size, fieldSize, fieldCell, project, focal,
      figurePaletteOf(stage.scene.figure).bodyRgb,
    )
    if (mask === null) continue
    const originX = Number(mask.dataset.originX ?? '0')
    const originY = Number(mask.dataset.originY ?? '0')
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = size * 0.018
    /* 遮罩是「一格一像素」建的，贴回去必须放大 fieldCell 倍。
     *
     * 漏掉这一步时，人偶体块只有骨架的 1/fieldCell 大（900px 上是 1/2.4），
     * 画面上会看到一副正常的青色骨架外面套着一个白色小玩偶——这是眼睛一眼
     * 就能发现的错，但它不会让任何断言变红。 */
    ctx.drawImage(
      mask, originX, originY, mask.width * fieldCell, mask.height * fieldCell,
    )
    ctx.restore()
  }

  if (guides) {
    // 骨骼线与关节标记：只在编辑时出现，导出永远干净——与姿势面板同一条
    // 规矩，用户导出的那张图是给模型看的参考图，不是界面截图。
    ctx.save()
    ctx.strokeStyle = 'rgba(92,206,224,0.85)'
    ctx.lineWidth = Math.max(1, size / 520)
    ctx.lineCap = 'round'
    for (const shape of shapes) {
      for (const [parent, child] of POSE_SEGMENTS) {
        const a = project(shape.joints[parent])
        const b = project(shape.joints[child])
        if (a === null || b === null) continue
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
      }
    }
    ctx.fillStyle = '#f7a325'
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = Math.max(0.7, size / 1000)
    const dots = shapes.flatMap(shape => (Object.keys(shape.joints) as PoseJoint[])
      .map(joint => project(shape.joints[joint]))
      .filter((point): point is [number, number, number] => point !== null)
      .map(point => ({ point, depth: point[2] })))
      .sort((a, b) => b.depth - a.depth)
    for (const dot of dots) {
      const radius = Math.max(1.6, size / 190)
      ctx.beginPath()
      ctx.arc(dot.point[0], dot.point[1], radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  if (stage.scene.labels) {
    for (const shape of shapes) paintLabel(ctx, size, shape.actor.name, project, shape.headTop)
  }

  if (options.frustum === true) paintFrustum(ctx, size, stage, project)

  ctx.restore()
}

/** 导出用：与预览同一套渲染，只是关掉辅助线，避免「预览正确、导出不对」。 */
export function renderSceneToCanvas(canvas: HTMLCanvasElement, size: number, stage: CanvasPoseStage, options?: {
  camera?: PoseCamera
  pano?: CanvasImageSource | null
}): HTMLCanvasElement {
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size
    canvas.height = size
  }
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    drawScene(ctx, {
      size, stage, guides: false, frustum: false,
      ...options?.camera === undefined ? {} : { camera: options.camera },
      ...options?.pano === undefined ? {} : { pano: options.pano },
    })
  }
  return canvas
}

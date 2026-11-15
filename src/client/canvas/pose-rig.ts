/**
 * 姿势人偶：骨架、预设、以及把它画成图的那一步。
 *
 * 这个模块是纯计算——不读 React 状态、不碰画布节点、不发请求。它只做三件事：
 *
 *  1. 把「一套关节角度」正向运动学解成世界坐标里的胶囊（`solveRig`）；
 *  2. 把胶囊投影到相机平面上、按深度排序、画成一张参考图（`renderPose`）；
 *  3. 提供一排常用姿势（`POSE_PRESETS`）。
 *
 * 为什么自己算而不引 three.js：这里要的东西只有透视投影 + 画家算法。引一个
 * 3D 引擎会给浏览器 bundle 增加 670 KB，还要用户有可用的 WebGL——而 WebGL
 * 恰恰是最容易在远程桌面、禁用硬件加速、老显卡上失效的那一环。一个姿势参考
 * 工具在那种环境里整块白掉，比画得糙得多。纯 2D 计算没有这个失败面。
 *
 * 坐标系：右手系，y 轴朝上，+z 朝相机（相机在 +z 看向 -z）。地面在 y = 0。
 */

import type { CanvasPoseAngles, CanvasPoseJoint, CanvasPoseRig } from '../../protocol.ts'

/** 关节名。与人偶的骨骼层级一一对应，见 `JOINT_PARENT`。
 *
 *  定义放在 protocol 层是因为节点 metadata 要引用它——`protocol.ts` 不能反向
 *  依赖客户端模块，所以这里只做别名，形状仍只有一份。 */
export type PoseJoint = CanvasPoseJoint

/** 一个关节绕自身三个轴的旋转，单位为度。 */
export type PoseAngles = CanvasPoseAngles

/**
 * 整套姿势：每个关节的三轴角度，外加整体参数。
 *
 * 角度存成对象而不是数组，是因为它要直接往返 JSON（导入/导出）并被属性面板
 * 逐轴编辑；数组会让「这一项是哪个轴」变成位置约定，改一次骨骼就得改一遍。
 */
export type PoseRig = CanvasPoseRig

/** 关节层级：父关节名，根为 null。正向运动学按这个顺序累乘。 */
export const JOINT_PARENT: Readonly<Record<PoseJoint, PoseJoint | null>> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  shoulderL: 'chest',
  elbowL: 'shoulderL',
  handL: 'elbowL',
  shoulderR: 'chest',
  elbowR: 'shoulderR',
  handR: 'elbowR',
  hipL: 'hips',
  kneeL: 'hipL',
  footL: 'kneeL',
  hipR: 'hips',
  kneeR: 'hipR',
  footR: 'kneeR',
}

/** 每个关节相对父关节的静止偏移（米），站立姿态下的骨架尺寸。 */
export const JOINT_REST: Readonly<Record<PoseJoint, [number, number, number]>> = {
  hips: [0, 0.94, 0],
  spine: [0, 0.14, 0],
  chest: [0, 0.18, 0],
  neck: [0, 0.20, 0],
  head: [0, 0.10, 0],
  shoulderL: [-0.18, 0.14, 0],
  elbowL: [-0.03, -0.27, 0],
  handL: [0, -0.25, 0],
  shoulderR: [0.18, 0.14, 0],
  elbowR: [0.03, -0.27, 0],
  handR: [0, -0.25, 0],
  hipL: [-0.10, -0.06, 0],
  kneeL: [0, -0.44, 0],
  footL: [0, -0.42, 0],
  hipR: [0.10, -0.06, 0],
  kneeR: [0, -0.44, 0],
  footR: [0, -0.42, 0],
}

/** 关节半径（米）：画成胶囊时每一段的粗细。 */
export const JOINT_RADIUS: Readonly<Record<PoseJoint, number>> = {
  hips: 0.125,
  spine: 0.115,
  chest: 0.125,
  neck: 0.055,
  head: 0.105,
  shoulderL: 0.062, elbowL: 0.052, handL: 0.045,
  shoulderR: 0.062, elbowR: 0.052, handR: 0.045,
  hipL: 0.082, kneeL: 0.068, footL: 0.055,
  hipR: 0.082, kneeR: 0.068, footR: 0.055,
}

/** 面板里可选的关节，按「躯干 → 手臂 → 腿」分组；顺序即下拉顺序。 */
export const POSE_JOINT_GROUPS: ReadonlyArray<{ labelKey: string; joints: readonly PoseJoint[] }> = [
  { labelKey: 'canvas.pose.groupTorso', joints: ['hips', 'spine', 'chest', 'neck', 'head'] },
  { labelKey: 'canvas.pose.groupArmL', joints: ['shoulderL', 'elbowL', 'handL'] },
  { labelKey: 'canvas.pose.groupArmR', joints: ['shoulderR', 'elbowR', 'handR'] },
  { labelKey: 'canvas.pose.groupLegL', joints: ['hipL', 'kneeL', 'footL'] },
  { labelKey: 'canvas.pose.groupLegR', joints: ['hipR', 'kneeR', 'footR'] },
]

/* ---------------------------------------------------------------- 预设 */

const a = (x = 0, y = 0, z = 0): PoseAngles => ({ x, y, z })

/** 空姿势：直立，手臂自然下垂。 */
export function emptyRig(): PoseRig { return { joints: {}, facing: 0 } }

/**
 * 常用姿势。
 *
 * 符号约定（右手系，y 朝上，z 朝相机），角度单位度：
 *  - 绕 **Z**：正值把向下垂的肢体甩向 +x。左臂在 -x 侧，所以左臂外展/上举用
 *    **负** 值，右臂用正值。写成「左负右正」而不是「左正右负」是这套坐标的
 *    直接结果，不是笔误。
 *  - 绕 **X**：正值把肢体甩向 -z（远离相机，即向后）。抬手向前用负值。
 *  - 绕 **Y**：绕自身竖轴扭转。
 *
 * 数值取整到 5 的倍数，方便用户接着用滑杆微调而不是面对一堆 37.4°。
 */
export const POSE_PRESETS: ReadonlyArray<{ id: string; labelKey: string; rig: PoseRig }> = [
  {
    id: 'stand', labelKey: 'canvas.pose.presetStand',
    // 自然站立：手臂略离身，肘微屈。
    rig: { joints: { shoulderL: a(0, 0, -8), shoulderR: a(0, 0, 8), elbowL: a(0, 0, -10), elbowR: a(0, 0, 10) }, facing: 0 },
  },
  {
    id: 'tpose', labelKey: 'canvas.pose.presetTpose',
    // 双臂平举。
    rig: { joints: { shoulderL: a(0, 0, -90), shoulderR: a(0, 0, 90) }, facing: 0 },
  },
  {
    id: 'wave', labelKey: 'canvas.pose.presetWave',
    // 右手挥手：大臂举到耳侧，小臂折起。
    rig: { joints: { shoulderR: a(0, 0, 150), elbowR: a(0, 0, 55), shoulderL: a(0, 0, -8) }, facing: 0 },
  },
  {
    id: 'bothup', labelKey: 'canvas.pose.presetBothUp',
    // 双手高举。
    rig: { joints: { shoulderL: a(0, 0, -160), shoulderR: a(0, 0, 160), elbowL: a(0, 0, -15), elbowR: a(0, 0, 15) }, facing: 0 },
  },
  {
    id: 'side', labelKey: 'canvas.pose.presetSideRaise',
    // 侧身抬手：身体转 45°，一只手抬到胸前。
    rig: { joints: { shoulderR: a(-45, 0, 30), elbowR: a(-100, 0, -40), spine: a(0, 20, 0), chest: a(0, 15, 0) }, facing: 45 },
  },
  {
    id: 'sit', labelKey: 'canvas.pose.presetSit',
    // 坐姿：大腿前折不沉，小腿垂下，手搭在腿上。
    rig: {
      joints: {
        hipL: a(-88, 0, 0), kneeL: a(88, 0, 0), hipR: a(-88, 0, 0), kneeR: a(88, 0, 0),
        shoulderL: a(-18, 0, -6), elbowL: a(-40, 0, -8), shoulderR: a(-18, 0, 6), elbowR: a(-40, 0, 8),
      },
      facing: 0,
    },
  },
  {
    id: 'crouch', labelKey: 'canvas.pose.presetCrouch',
    // 蹲姿：髋前折、膝回折，躯干前倾。
    rig: {
      joints: {
        hips: a(-10, 0, 0),
        hipL: a(-75, 0, -8), kneeL: a(85, 0, 0), footL: a(10, 0, 0),
        hipR: a(-75, 0, 8), kneeR: a(85, 0, 0), footR: a(10, 0, 0),
        shoulderL: a(-20, 0, -14), elbowL: a(-35, 0, -10),
        shoulderR: a(-20, 0, 14), elbowR: a(-35, 0, 10),
      },
      facing: 0,
    },
  },
  {
    id: 'back', labelKey: 'canvas.pose.presetBack',
    // 背身站立：整体转 180°。
    rig: { joints: { shoulderL: a(0, 0, -8), shoulderR: a(0, 0, 8) }, facing: 180 },
  },
  {
    id: 'shrug', labelKey: 'canvas.pose.presetShrug',
    // 摊手：上臂外展，小臂上翻向前。
    rig: {
      joints: {
        shoulderL: a(-20, 0, -60), elbowL: a(-70, 0, -10),
        shoulderR: a(-20, 0, 60), elbowR: a(-70, 0, 10),
      },
      facing: 0,
    },
  },
  {
    id: 'step', labelKey: 'canvas.pose.presetStep',
    // 迈步：前腿屈、后腿直，手臂反向摆。
    rig: {
      joints: {
        hipL: a(-25, 0, 0), kneeL: a(20, 0, 0),
        hipR: a(18, 0, 0), kneeR: a(8, 0, 0),
        shoulderL: a(-12, 0, -6), elbowL: a(-25, 0, -8),
        shoulderR: a(12, 0, 6), elbowR: a(-25, 0, 8),
      },
      facing: 20,
    },
  },
  {
    id: 'run', labelKey: 'canvas.pose.presetRun',
    // 跑步：抬膝、屈臂、躯干前倾。
    rig: {
      joints: {
        hips: a(-12, 0, 0), spine: a(-8, 0, 0),
        hipL: a(-60, 0, 0), kneeL: a(85, 0, 0), footL: a(20, 0, 0),
        hipR: a(35, 0, 0), kneeR: a(30, 0, 0),
        shoulderL: a(-45, 0, -10), elbowL: a(-90, 0, -10),
        shoulderR: a(50, 0, 10), elbowR: a(-95, 0, 10),
      },
      facing: 0,
    },
  },
]

/* ------------------------------------------------------------- 正向运动学 */

/** 4x4 变换矩阵，行主序，与 `[行][列]` 索引一致。 */
type Mat4 = number[]

function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function multiply(m: Mat4, n: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += (m[r * 4 + k] ?? 0) * (n[k * 4 + c] ?? 0)
      out[r * 4 + c] = sum
    }
  }
  return out
}

/** 绕三轴旋转（先 X，再 Y，再 Z），再接平移。角度单位为度。 */
function jointMatrix(angles: PoseAngles, offset: [number, number, number]): Mat4 {
  const rx = angles.x * Math.PI / 180
  const ry = angles.y * Math.PI / 180
  const rz = angles.z * Math.PI / 180
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  // R = Rz * Ry * Rx（先绕自身 X 弯，再绕 Y 转，最后绕 Z 张）。
  const r00 = cz * cy
  const r01 = cz * sy * sx - sz * cx
  const r02 = cz * sy * cx + sz * sx
  const r10 = sz * cy
  const r11 = sz * sy * sx + cz * cx
  const r12 = sz * sy * cx - cz * sx
  const r20 = -sy
  const r21 = cy * sx
  const r22 = cy * cx
  return [
    r00, r01, r02, offset[0],
    r10, r11, r12, offset[1],
    r20, r21, r22, offset[2],
    0, 0, 0, 1,
  ]
}

/** 把矩阵的平移列取出来。 */
function translationOf(m: Mat4): [number, number, number] {
  return [m[3] ?? 0, m[7] ?? 0, m[11] ?? 0]
}

/**
 * 正向运动学：算出每个关节的世界坐标。
 *
 * 按 `JOINT_PARENT` 逐层累乘——层级是静态的，深度只有 4 层，一个固定的父先
 * 子后顺序就够，不必递归也不必拓扑排序。算完统一落地（见 `groundRig`）。
 */
export function solveRig(rig: PoseRig): Record<PoseJoint, [number, number, number]> {
  const world = {} as Record<PoseJoint, [number, number, number]>
  // 根关节也接 `joints.hips`：躯干前倾（蹲、跑）就是这一个角度，丢掉它等于
  // 那几个预设只改了四肢而身体笔直站着。
  const hipAngles = rig.joints.hips ?? { x: 0, y: 0, z: 0 }
  const rootM = jointMatrix(
    { x: hipAngles.x, y: rig.facing + hipAngles.y, z: hipAngles.z },
    [JOINT_REST.hips[0], JOINT_REST.hips[1], JOINT_REST.hips[2]],
  )
  world.hips = translationOf(rootM)
  const matrices = new Map<PoseJoint, Mat4>([['hips', rootM]])
  // 层级是静态的，深度只有 4 层：按父先子后的固定顺序走一遍就够，不必递归。
  const order: PoseJoint[] = ['spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'footL', 'hipR', 'kneeR', 'footR']
  for (const joint of order) {
    const parent = JOINT_PARENT[joint]
    const parentMatrix = parent === null ? identity() : matrices.get(parent)
    if (parentMatrix === undefined) continue
    const angles = rig.joints[joint] ?? { x: 0, y: 0, z: 0 }
    const m = multiply(parentMatrix, jointMatrix(angles, JOINT_REST[joint]))
    matrices.set(joint, m)
    world[joint] = translationOf(m)
  }
  return groundRig(world)
}

/** 人偶离地的高度。脚踩空是最刺眼的一种错——一张姿势参考图如果人物浮在
 *  空中，它传达的就变成了「跳跃」而不是「蹲下」。 */
const GROUND_Y = 0.02

/**
 * 把整副骨架垂直下移到最低点刚好落地。
 *
 * 用「求解完再落地」而不是「按姿势查一个下沉量」：下沉量取决于髋膝的角度、
 * 躯干前倾和坐站状态，手算到每个预设等于把同一套运动学再实现一遍；而落地
 * 只需要一个最小值。实测固定下沉量在蹲姿上差 15 cm、跑步差 20 cm。
 */
function groundRig(world: Record<PoseJoint, [number, number, number]>): Record<PoseJoint, [number, number, number]> {
  let lowest = Infinity
  for (const joint of Object.keys(world) as PoseJoint[]) lowest = Math.min(lowest, world[joint][1])
  const shift = GROUND_Y - lowest
  if (Math.abs(shift) < 1e-6) return world
  for (const joint of Object.keys(world) as PoseJoint[]) {
    const p = world[joint]
    world[joint] = [p[0], p[1] + shift, p[2]]
  }
  return world
}

/* ---------------------------------------------------------------- 渲染 */

/** 相机：位置、看向的目标、竖直视场角。 */
export interface PoseCamera { yaw: number; pitch: number; distance: number; fov: number; targetY: number }

/**
 * 默认 3/4 视角，不是正面。
 *
 * 正面看坐姿是看不出「坐」的：大腿朝正前方，被透视压缩成一个圆点，画面里只剩
 * 一条竖直的躯干——与站姿几乎无法区分。侧偏 22° 就能看到大腿伸出去，代价是
 * 正面姿势略瘦一点，这个交换对参考图是划算的。
 */
export const DEFAULT_CAMERA: PoseCamera = { yaw: 22, pitch: 6, distance: 4.2, fov: 32, targetY: 0.92 }

/**
 * 按姿势自己的包围盒自动取景。
 *
 * 固定机位对这套预设是不够的：站着的人偶高约 1.5 m，举手到 1.9 m，蹲着只有
 * 1.1 m 但向前铺开——一个距离要么把蹲姿画成画面中央的一小团，要么把举起的手
 * 裁掉。所以每次都按包围盒重新算：先把八个角点转到相机空间（不平移），取
 * 需要的最大距离，再留 8% 余量。
 *
 * 结果是每个姿势都填满画面，而参考图能给出的身体细节正是由这个填充率决定的。
 */
export function frameCamera(rig: PoseRig, base: PoseCamera): PoseCamera {
  const world = solveRig(rig)
  const eps = 0.16
  const points = Object.values(world)
  const minY = Math.min(...points.map(p => p[1] - eps))
  const maxY = Math.max(...points.map(p => p[1] + eps))
  const targetY = (minY + maxY) / 2
  const rotY = base.yaw * Math.PI / 180
  const rotX = base.pitch * Math.PI / 180
  // 旋转方向与 `cameraMatrix` 的 lookAt 基向量一致，只是世界原点平移到包围盒中心。
  let extent = 0.2
  for (const p of points) {
    const x = p[0]
    const y = p[1] - targetY
    const z = p[2]
    // 绕 y 转（yaw），再绕 x 抬（pitch）。
    const x1 = x * Math.cos(rotY) + z * Math.sin(rotY)
    const z1 = -x * Math.sin(rotY) + z * Math.cos(rotY)
    const y2 = y * Math.cos(rotX) - z1 * Math.sin(rotX)
    extent = Math.max(extent, Math.abs(x1) + eps, Math.abs(y2) + eps)
  }
  const halfFov = (base.fov * Math.PI / 180) / 2
  return { ...base, targetY, distance: (extent / Math.tan(halfFov)) * 1.08 }
}

/** 一根要画的胶囊：两端世界坐标 + 半径。 */
interface Capsule { from: [number, number, number]; to: [number, number, number]; radius: number; joint: PoseJoint }

/** 骨架里所有要画的段（父 → 子），末端关节用父到自身的偏移。 */
const SEGMENTS: ReadonlyArray<[PoseJoint, PoseJoint]> = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'shoulderL'], ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['chest', 'shoulderR'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['hips', 'hipL'], ['hipL', 'kneeL'], ['kneeL', 'footL'],
  ['hips', 'hipR'], ['hipR', 'kneeR'], ['kneeR', 'footR'],
]

function capsulesOf(rig: PoseRig): Capsule[] {
  const world = solveRig(rig)
  return SEGMENTS.map(([parent, child]) => ({
    from: world[parent],
    to: world[child],
    radius: Math.min(JOINT_RADIUS[parent], JOINT_RADIUS[child]),
    joint: child,
  }))
}

/** 相机空间：把世界坐标变换到「相机在原点、看向 -z」。 */
function cameraMatrix(camera: PoseCamera): Mat4 {
  const yaw = camera.yaw * Math.PI / 180
  const pitch = camera.pitch * Math.PI / 180
  const target: [number, number, number] = [0, camera.targetY, 0]
  const eye: [number, number, number] = [
    target[0] + Math.sin(yaw) * Math.cos(pitch) * camera.distance,
    target[1] + Math.sin(pitch) * camera.distance,
    target[2] + Math.cos(yaw) * Math.cos(pitch) * camera.distance,
  ]
  // 视图矩阵就是 lookAt 展开：forward 由 eye→target 定，right = forward × up，
  // up' = right × forward。展开写出来比再引一个数学库省事，也能直接对着公式核对。
  const forward: [number, number, number] = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]
  const flen = Math.hypot(...forward) || 1
  const f: [number, number, number] = [forward[0] / flen, forward[1] / flen, forward[2] / flen]
  const up: [number, number, number] = [0, 1, 0]
  const s: [number, number, number] = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]]
  const slen = Math.hypot(...s) || 1
  const sx = s[0] / slen, sy2 = s[1] / slen, sz = s[2] / slen
  const u: [number, number, number] = [sy2 * f[2] - sz * f[1], sz * f[0] - sx * f[2], sx * f[1] - sy2 * f[0]]
  const d = sx * eye[0] + sy2 * eye[1] + sz * eye[2]
  const e = u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]
  const g = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]
  return [
    sx, sy2, sz, -d,
    u[0], u[1], u[2], -e,
    -f[0], -f[1], -f[2], g,
    0, 0, 0, 1,
  ]
}

function applyMatrix(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    (m[0] ?? 0) * p[0] + (m[1] ?? 0) * p[1] + (m[2] ?? 0) * p[2] + (m[3] ?? 0),
    (m[4] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[6] ?? 0) * p[2] + (m[7] ?? 0),
    (m[8] ?? 0) * p[0] + (m[9] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[11] ?? 0),
  ]
}

export interface PoseRenderOptions {
  /** 输出边长（正方形，像素）。 */
  size: number
  /** 是否画骨骼连线与关节标记；PNG 导出时关掉。 */
  guides: boolean
  /** 背景色；`null` 表示透明。 */
  background: string | null
  camera: PoseCamera
}

/**
 * 把姿势画进给定的 2D 上下文。
 *
 * 画家算法：先按相机空间的 z 从远到近排序再画，近的覆盖远的。人偶全是凸的
 * 胶囊，这个排序足够——不需要深度缓冲，也不需要 z-fighting 那套。
 */
export function drawPose(ctx: CanvasRenderingContext2D, rig: PoseRig, options: PoseRenderOptions): void {
  const { size, camera } = options
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  if (options.background !== null) {
    ctx.fillStyle = options.background
    ctx.fillRect(0, 0, size, size)
  }
  // 地面网格：给人一个「站在地上」的参照，也让 3/4 视角能看出朝向。
  if (options.guides) {
    ctx.strokeStyle = 'rgba(0,0,0,0.10)'
    ctx.lineWidth = Math.max(1, size / 640)
    for (let i = -3; i <= 3; i += 1) {
      const step = i * 0.4
      const near = projectPoint([step, 0, 1.2], camera, size)
      const far = projectPoint([step, 0, -1.2], camera, size)
      if (near !== null && far !== null) {
        ctx.beginPath(); ctx.moveTo(near[0], near[1]); ctx.lineTo(far[0], far[1]); ctx.stroke()
      }
      const left = projectPoint([-1.2, 0, step], camera, size)
      const right = projectPoint([1.2, 0, step], camera, size)
      if (left !== null && right !== null) {
        ctx.beginPath(); ctx.moveTo(left[0], left[1]); ctx.lineTo(right[0], right[1]); ctx.stroke()
      }
    }
  }
  const view = cameraMatrix(camera)
  const capsules = capsulesOf(rig).map(capsule => {
    const a3 = applyMatrix(view, capsule.from)
    const b3 = applyMatrix(view, capsule.to)
    return { capsule, a3, b3, depth: Math.min(a3[2], b3[2]) }
  }).sort((left, right) => left.depth - right.depth)
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  const toScreen = (p: [number, number, number]): [number, number] | null => {
    const depth = -p[2]
    if (depth <= 0.05) return null
    return [size / 2 + (p[0] * focal) / depth, size / 2 - (p[1] * focal) / depth]
  }
  for (const item of capsules) {
    const from = toScreen(item.a3)
    const to = toScreen(item.b3)
    if (from === null || to === null) continue
    const depth = -((item.a3[2] + item.b3[2]) / 2)
    const radiusPx = Math.max(1.5, (item.capsule.radius * focal) / Math.max(0.05, depth))
    ctx.strokeStyle = '#b9c2cf'
    ctx.lineCap = 'round'
    ctx.lineWidth = radiusPx * 2
    ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke()
    // 上一道浅色内芯，让轮廓有体积感而不是一根粗线。
    ctx.strokeStyle = '#d6dde7'
    ctx.lineWidth = Math.max(1, radiusPx * 1.4)
    ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke()
  }
  if (options.guides) {
    // 关节标记：编辑时才画，导出永远干净。
    const world = solveRig(rig)
    for (const joint of Object.keys(world) as PoseJoint[]) {
      const p = toScreen(applyMatrix(view, world[joint]))
      if (p === null) continue
      ctx.fillStyle = '#f59f00'
      ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(2, size / 190), 0, Math.PI * 2); ctx.fill()
    }
  }
  ctx.restore()
}

/** 把一个世界坐标投影到屏幕，供网格与命中测试共用。 */
export function projectPoint(point: [number, number, number], camera: PoseCamera, size: number): [number, number] | null {
  const view = cameraMatrix(camera)
  const p = applyMatrix(view, point)
  const depth = -p[2]
  if (depth <= 0.05) return null
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  return [size / 2 + (p[0] * focal) / depth, size / 2 - (p[1] * focal) / depth]
}

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
  /* 标准人形比例：约 7.3 头身，无性别。
   *
   * 这里每一项都是**相对父节点的偏移**，注释写的是它的绝对含义
   * （以地面 0.02、头高 H=0.2 计，单位是世界坐标）。
   *
   * 踩过的坑，按严重程度：
   *  1. 把肘写成和肩相同的数 → 叠加成两倍外张，手臂变成披风；
   *  2. 把膝写成 -0.086 → 叠加成外八；
   *  3. **胸→颈写 0.179** → 脖颈一段比整个躯干的一半还长，导出图上
   *     脖子粗长、肩线从脖子斜下来像披着斗篷。现在压到 0.160。
   */
  hips: [0, 0.94, 0],
  // 腰：绝对 4.9H 处，只比骨盆收一点点。
  spine: [0, 0.104, 0],
  // 胸腔中心：5.7H。
  chest: [0, 0.160, 0],
  // 颈根：6.5H。这一段必须比胸→颈的「锁骨区」短，脖子才不会显得长。
  neck: [0, 0.160, 0],
  // 头的球心：头顶 7.5H。
  head: [0, 0.100, 0],
  /* 手臂：自然下垂、微微外张。
   * 肩在 6.2H（比颈根低 0.06H，与真实解剖一致）；肘只再外偏 0.020、
   * 腕收回 0.024，所以上臂近乎竖直。腋下的缝靠肩的位置拉开，不靠肘外张。
   */
  shoulderL: [-0.170, 0.100, 0],
  elbowL: [-0.020, -0.200, 0],
  handL: [0.004, -0.170, 0],
  shoulderR: [0.170, 0.100, 0],
  elbowR: [0.020, -0.200, 0],
  handR: [-0.004, -0.170, 0],
  /* 腿：竖直向下，两腿之间有明确的缝。
   * 胯距由 hipL/hipR 的 x 与大腿半径共同决定：±0.112 与 0.086，
   * 内缘在 ±0.026。膝、踝相对胯几乎不偏，才是竖直而不是外八。
   */
  /* 胯点 ±0.082、大腿根半径 0.066：外缘 0.148，与骨盆外缘（0.118）只差
   * 0.03——腿是从髋部长出来的，不会在胯侧鼓出一颗「臀包」。
   *
   * 上一版胯点 ±0.112 + 半径 0.086 = 外缘 0.198，比骨盆宽 0.09，导出图上
   * 胯侧两块明显的球形凸起，看着像穿了一条短裤。
   * 内缘 ±0.016，两腿之间仍有一条能看出来的缝。
   */
  hipL: [-0.082, -0.020, 0],
  kneeL: [-0.016, -0.376, 0.004],
  footL: [-0.012, -0.410, 0.030],
  hipR: [0.082, -0.020, 0],
  kneeR: [0.016, -0.376, 0.004],
  footR: [0.012, -0.410, 0.030],
}

/**
 * 关节半径（米）：关节处人形的半宽。
 *
 * 这些不是「线条粗细」，而是**身体轮廓**的一半：相邻两个关节之间的那一段
 * 会在两端半径之间插值，于是一段腿是上粗下细、腰窄臀宽、胸宽颈细。等粗
 * 的胶囊串起来只能得到一个橡皮人——那正是这一版要修掉的东西。
 */
export const JOINT_RADIUS: Readonly<Record<PoseJoint, number>> = {
  /* 标准人形的一组半径，同样由 H = 0.224 换算：
   *   骨盆 0.44H、腰 0.38H、胸 0.47H、颈 0.17H、头 0.37H
   *   肩 0.19H、肘 0.16H、腕 0.11H
   *   胯 0.28H、膝 0.20H、踝 0.13H
   *
   * 无性别：腰/胸/骨盆三者的差值都在 0.02 以内，只是一点点收放，
   * 读不出沙漏也读不出胸部。姿势参考图要表达的是骨骼朝向与重心，
   * 带上性别特征会把下游模型往那个方向带。
   */
  hips: 0.118,
  spine: 0.092,
  chest: 0.114,
  neck: 0.040,
  head: 0.100,
  shoulderL: 0.054, elbowL: 0.042, handL: 0.030,
  shoulderR: 0.054, elbowR: 0.042, handR: 0.030,
  hipL: 0.066, kneeL: 0.046, footL: 0.034,
  hipR: 0.066, kneeR: 0.046, footR: 0.034,
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
export const POSE_PRESETS: ReadonlyArray<{ id: string; labelKey: string; rig: PoseRig; seat?: boolean }> = [
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
    // `seat` 不是姿势的一部分，是给面板的信号：这个姿势需要一块支撑面。
    // 面板会按 hips 高度放一个坐箱；没有它，人就会悬在一张不存在的椅子上。
    rig: {
      joints: {
        hipL: a(-88, 0, 0), kneeL: a(88, 0, 0), hipR: a(-88, 0, 0), kneeR: a(88, 0, 0),
        shoulderL: a(-18, 0, -6), elbowL: a(-40, 0, -8), shoulderR: a(-18, 0, 6), elbowR: a(-40, 0, 8),
      },
      facing: 0,
    },
    seat: true,
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
 * 脚掌的放样剖面。
 *
 * **这一份是脚底接触和 3D 网格的唯一事实来源。** `stage-humanoid.ts` 的
 * 脚部几何从这里取环，`footSolePoints()` 也从这里取底面；两处各写一套时，
 * 3D 看到的脚和落地算出来的脚会差几毫米，坐下/迈步时就会一只脚贴地、一只
 * 脚悬空。
 *
 * `t` 是沿脚长（踝 → 脚尖）的比例，`rz` 是脚掌中心线到脚底的距离。脚不是
 * 一根圆柱：踝处窄而高，脚背处宽而低，脚尖收薄。
 */
export const FOOT_PROFILE: ReadonlyArray<{ t: number; rx: number; rz: number }> = [
  { t: 0, rx: 0.034, rz: 0.032 },
  { t: 0.28, rx: 0.048, rz: 0.040 },
  { t: 0.62, rx: 0.051, rz: 0.031 },
  { t: 0.86, rx: 0.047, rz: 0.023 },
  { t: 1, rx: 0.032, rz: 0.013 },
]

/** 脚掌长度（米），与 `stage-humanoid.ts` 的 `HUMANOID_FEET` 共用。 */
export const FOOT_LENGTH = 0.155

type Vec3 = [number, number, number]

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-8 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/**
 * 脚掌的局部基：`forward` 沿脚长，`up` 从小腿指向脚踝，`side` 为脚宽。
 *
 * 与 `stage-humanoid.ts` 的 `alignFoot()` 必须用同一套基，否则 2D 回退里
 * 的脚会和 3D 里的脚朝不同方向。`alignFoot` 用 `makeBasis(side, forward, up)`，
 * 即本地 X = side、Y = forward、Z = up；这里逐项对上。
 */
export function footFrame(ankle: Vec3, knee: Vec3): { forward: Vec3; up: Vec3; side: Vec3 } {
  // 脚掌的「上」是从踝指向膝，不是反过来：`alignFoot()` 之前用
  // `ankle - knee` 当 up，结果 local +Z 朝地，脚底接触点被算到了脚背上方。
  // 脚部放样绕 Z 对称，翻一次不影响外形；但接地求解必须知道真正的上方。
  const up = unit([knee[0] - ankle[0], knee[1] - ankle[1], knee[2] - ankle[2]])
  const upSafe = up[0] === 0 && up[1] === 0 && up[2] === 0 ? [0, 1, 0] as Vec3 : up
  // 默认朝 +z（相机前方）。小腿几乎水平时 +z 可能与 up 共线，换 +x。
  let forward: Vec3 = [0, 0, 1]
  if (Math.abs(forward[0] * upSafe[0] + forward[1] * upSafe[1] + forward[2] * upSafe[2]) > 0.98) {
    forward = [1, 0, 0]
  }
  // 投影到与 up 垂直的平面里，脚才不会歪着插进小腿。
  const dot = forward[0] * upSafe[0] + forward[1] * upSafe[1] + forward[2] * upSafe[2]
  forward = unit([forward[0] - upSafe[0] * dot, forward[1] - upSafe[1] * dot, forward[2] - upSafe[2] * dot])
  const side = unit(cross(forward, upSafe))
  return { forward, up: upSafe, side }
}

/**
 * 脚底接触点：脚掌中心线下方、脚宽两侧各取一列。
 *
 * 取两侧而不是只取中线，是为了让脚掌侧翻（迈步、蹲下时）也能正确落地：
 * 只取中线时，脚侧翻会得到「脚尖着地、脚跟悬空」的错误答案。
 */
export function footSolePoints(ankle: Vec3, knee: Vec3): Vec3[] {
  const { forward, up, side } = footFrame(ankle, knee)
  const points: Vec3[] = []
  for (const ring of FOOT_PROFILE) {
    const center: Vec3 = [
      ankle[0] + forward[0] * ring.t * FOOT_LENGTH - up[0] * ring.rz,
      ankle[1] + forward[1] * ring.t * FOOT_LENGTH - up[1] * ring.rz,
      ankle[2] + forward[2] * ring.t * FOOT_LENGTH - up[2] * ring.rz,
    ]
    points.push(center)
    for (const sign of [-1, 1]) {
      points.push([
        center[0] + side[0] * ring.rx * 0.78 * sign,
        center[1] + side[1] * ring.rx * 0.78 * sign,
        center[2] + side[2] * ring.rx * 0.78 * sign,
      ])
    }
  }
  return points
}

/**
 * 落地：让**形体**的最低点贴地，而不是关节点的最低点。
 *
 * 早先只取关节 y 的最小值对齐 `GROUND_Y`。那等于把「脚踝的中心」放在地面上
 * ——脚踝球半径 0.030，于是整个脚有一半埋在地面以下，导出图上脚完全消失
 * （只剩两根杆子插进地里）。这是看图的唯一解释，用数值也能对上：
 * 踝 y=0.020、GROUND_Y=0.020、半径 0.030 → 球底在 -0.010。
 *
 * 现在每个关节都按它自己的半径外扩一格再取最小值；脚掌例外，按
 * `footSolePoints()` 的真实脚底剖面取最低点。**不能**再拿 `footL` 的关节
 * 半径当脚底：脚掌是从踝向前伸出的一段，坐下时踝在椅面高度、脚尖却在
 * 地板高度，用一颗踝球算出来的「最低点」会让整个人悬在椅子上。
 */
function groundRig(world: Record<PoseJoint, [number, number, number]>): Record<PoseJoint, [number, number, number]> {
  let lowest = Infinity
  for (const joint of Object.keys(world) as PoseJoint[]) {
    // 脚掌不走关节球：它的最低点由脚底剖面决定，见下面。
    if (joint === 'footL' || joint === 'footR') continue
    lowest = Math.min(lowest, world[joint][1] - JOINT_RADIUS[joint])
  }
  for (const side of ['L', 'R'] as const) {
    const ankle = world[`foot${side}` as PoseJoint]
    const knee = world[`knee${side}` as PoseJoint]
    for (const point of footSolePoints(ankle, knee)) lowest = Math.min(lowest, point[1])
  }
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
export interface PoseCamera {
  yaw: number; pitch: number; distance: number; fov: number; targetY: number
  /** 注视点的水平位置。缺省 0 = 原点，姿势面板从来只照一个人，不需要挪。
   *  导演台里三个人并排时，相机必须能把画面中心挪到人群中间，否则只调距离
   *  的话第三人会被裁在画外。 */
  targetX?: number
  targetZ?: number
}

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

/** 一根要画的肢体：两端世界坐标 + 两端半径。 */
interface Limb {
  from: [number, number, number]
  to: [number, number, number]
  radiusFrom: number
  radiusTo: number
  joint: PoseJoint
}

/** 骨架里所有要画的段（父 → 子），末端关节用父到自身的偏移。 */
const SEGMENTS: ReadonlyArray<[PoseJoint, PoseJoint]> = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'shoulderL'], ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['chest', 'shoulderR'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['hips', 'hipL'], ['hipL', 'kneeL'], ['kneeL', 'footL'],
  ['hips', 'hipR'], ['hipR', 'kneeR'], ['kneeR', 'footR'],
]

/**
 * 肢体与躯干的连接段。
 *
 * `hips → hipL` / `chest → shoulderL` 只有 5～15 cm，但**不能删**：删了
 * 之后大腿从髖关节位置开始画，骨盆与腿之间就真空出一道缝（实测两臂两腿
 * 整个飞出去，只剩一根细躯干）。
 *
 * 也不能跟肢体一样粗：那样会在骨盆两侧与锁骨上各堆出一颗球，看起来像
 * 垫了护肩、裆部鼓起一球。正确做法是把起点半径压到远小于躯干。
 * 起点落在骨盆/胸腔内部，被前一层体块盖住，露在外面的只有从体块边缘
 * 到髖关节/肩关节那一小段，于是接缝淹没在体块里。
 */
const SITE_RADII: ReadonlyMap<string, [number, number]> = new Map([
  // 躯干：骨盆 → 腰 → 胸 → 颈 → 头。腰只收一点点，不做沙漏。
  ['hips>spine', [0.120, 0.092]],
  ['spine>chest', [0.092, 0.116]],
  // 颈子必须够宽才接得上头，否则距离场在颈部断开、头浮在半空。
  ['chest>neck', [0.114, 0.058]],
  ['neck>head', [0.050, 0.078]],
  // 连接段起点 = 躯干半径：细管从粗躯干里钻出来会在交界处塌出 V 形坑
  // （曾经表现为胸口折痕、腋下尖角、髋侧水滴）。
  /* 胸→肩的起点必须**小于**胸腔半径（0.114）。
   *
   * 写等宽时，这段锥形和胸腔一样粗，于是从脖子到肩关节铺成一片斜面——
   * 导出图上整个人像披了一件斗篷，没有肩。收到 0.086 之后才隆起成一个
   * 明确的肩头，腋下的折角也出来了。
   */
  /* 肩与胸腔**同高**（偏移 0.006 而不是 0.044），连接段起点略小于胸腔
   * 半径（0.108 vs 0.114）。
   *
   * 这决定肩线是「一条水平的肩」还是「从脖子斜下来的坡」：肩比胸腔高
   * 一段时，胸腔顶部到肩关节那条锥形正好铺成一面斜坡，导出图上整个人像
   * 披了斗篷。同高之后肩从胸腔侧面横向长出来，腋下的折角才出现。
   */
  ['chest>shoulderL', [0.100, 0.054]],
  ['chest>shoulderR', [0.100, 0.054]],
  ['hips>hipL', [0.088, 0.066]],
  ['hips>hipR', [0.088, 0.066]],
  // 手臂：肩头向肘、腕一路收细。
  ['shoulderL>elbowL', [0.054, 0.042]],
  ['elbowL>handL', [0.042, 0.030]],
  ['shoulderR>elbowR', [0.054, 0.042]],
  ['elbowR>handR', [0.042, 0.030]],
  // 腿：大腿 0.063 → 膝 0.045 → 踝 0.029，才分得出大腿与小腿。
  ['hipL>kneeL', [0.066, 0.046]],
  ['kneeL>footL', [0.046, 0.034]],
  ['hipR>kneeR', [0.066, 0.046]],
  ['kneeR>footR', [0.046, 0.034]],
])

function limbsOf(rig: PoseRig, solved?: Record<PoseJoint, [number, number, number]>): Limb[] {
  const world = solved ?? solveRig(rig)
  return SEGMENTS.map(([parent, child]) => {
    const explicit = SITE_RADII.get(`${parent}>${child}`)
    return {
      from: world[parent],
      to: world[child],
      radiusFrom: explicit?.[0] ?? JOINT_RADIUS[parent],
      radiusTo: explicit?.[1] ?? JOINT_RADIUS[child],
      joint: child,
    }
  })
}

/** 相机空间：把世界坐标变换到「相机在原点、看向 -z」。 */
function cameraMatrix(camera: PoseCamera): Mat4 {
  const yaw = camera.yaw * Math.PI / 180
  const pitch = camera.pitch * Math.PI / 180
  const target: [number, number, number] = [camera.targetX ?? 0, camera.targetY, camera.targetZ ?? 0]
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
  /** 背景色；`null` 表示透明。`backdrop: 'studio'` 时被相机棚渐变代替。 */
  background: string | null
  /**
   * 背板：`studio` 是近白的柔和径向渐变（见 `paintStudioBackdrop`），
   * `flat` 是纯色（或透明）。
   *
   * 预览与导出必须用同一块背板，否则用户在这里摆完姿势、导出的参考图
   * 却是另一种明暗，下游模型会把人形的亮部当成光源而不是皮肤。
   */
  backdrop?: 'studio' | 'flat'
  camera: PoseCamera
}

/**
 * 姿势图的背板：近白、中心略亮的柔和渐变 + 一层极淡的地面网格。
 *
 * 与「标准初始样子」那张参考图一致：淡蓝灰人偶要配浅底，深色底会把它压成
 * 一块发亮的剪影。网格留一条地平线，3/4 视角才看得出朝向，也看得出脚踩在
 * 地上而不是浮着。
 */
function paintStudioBackdrop(ctx: CanvasRenderingContext2D, size: number): void {
  const gradient = ctx.createRadialGradient(
    size * 0.5, size * 0.42, size * 0.02,
    size * 0.5, size * 0.52, size * 0.80,
  )
  gradient.addColorStop(0, '#ffffff')
  gradient.addColorStop(0.62, '#f7f8fa')
  gradient.addColorStop(1, '#e6e9ee')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
}

/**
 * 把一段肢体加成一条**两端不等宽**的轮廓路径。
 *
 * 两条外公切线夹着两个圆，就是一段上粗下细的肢体。等宽胶囊串出来的形
 * 体没有腰没有脚踝，整体像一根根管子——这正是要换掉的那种画法。
 */
function limbPath(
  ctx: CanvasRenderingContext2D,
  ax: number, ay: number, ra: number,
  bx: number, by: number, rb: number,
): void {
  const dx = bx - ax
  const dy = by - ay
  const distance = Math.hypot(dx, dy)
  if (distance < 1e-6) {
    ctx.moveTo(ax + ra, ay)
    ctx.arc(ax, ay, ra, 0, Math.PI * 2)
    return
  }
  const theta = Math.atan2(dy, dx)
  // 半径差超过间距时两个圆已经互相包含，没有外公切线；夹一下退化成圆头。
  const alpha = Math.acos(Math.min(1, Math.max(-1, (ra - rb) / distance)))
  ctx.moveTo(ax + ra * Math.cos(theta + alpha), ay + ra * Math.sin(theta + alpha))
  ctx.arc(ax, ay, ra, theta + alpha, theta - alpha + Math.PI * 2)
  ctx.lineTo(bx + rb * Math.cos(theta - alpha), by + rb * Math.sin(theta - alpha))
  ctx.arc(bx, by, rb, theta - alpha, theta + alpha)
  ctx.closePath()
}

/** 一个世界坐标球体：多角色合成时逐角色生成一批，再按深度排队。 */
export interface PoseSphere { x: number; y: number; z: number; r: number }

/**
 * 世界坐标 → 屏幕投影 + 屏幕深度。
 *
 * 导演台与姿势面板必须用同一套投影：两块界面各写一遍透视，迟早出现
 * 「导演台里人和地面错位、姿势面板里对得上」。深度是相机空间的 -z，世界
 * 单位，供画家算法排序。
 */
export function makeProjector(size: number, camera: PoseCamera): {
  focal: number
  project: (point: [number, number, number]) => [number, number, number] | null
} {
  const view = cameraMatrix(camera)
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  return {
    focal,
    project: (point) => {
      const cameraPoint = applyMatrix(view, point)
      const depth = -cameraPoint[2]
      if (depth <= 0.05) return null
      return [size / 2 + (cameraPoint[0] * focal) / depth, size / 2 - (cameraPoint[1] * focal) / depth, depth]
    },
  }
}

/**
 * 骨架 → 一串世界坐标球体。
 *
 * 从 `drawPose` 里抽出来供导演台复用：每个角色各自生成一批球，之后按整组
 * 变换搬到场景坐标、各自算一张遮罩再按深度合成。**不能**把多个角色的球体
 * 并进同一个距离场——那会让两个人在屏幕空间糊成一团，谁在前面都看不出来。
 */
export function buildSpheres(rig: PoseRig, world: Record<PoseJoint, [number, number, number]> = solveRig(rig)): PoseSphere[] {
  const spheres: PoseSphere[] = []

  /** 两个关节之间插一串球，半径按 t 线性插值。 */
  const addTube = (a: [number, number, number], b: [number, number, number], ra: number, rb: number): void => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    /* 步长：取半径的 1/4，而不是 1/2。
     *
     * 一串等距球求并集，表面沿轴向是**轻微串珠状**的：球心处最粗，两个
     * 球之间略细。幅度约 0.032·r，1/2 步长时只有几毫米，看轮廓看不出来。
     * 但法线是从场的梯度算的，这点起伏会让法线在轴心附近周期性翻转，
     * 被放大成躯干上一条条横纹（实测像缝了拉链）。1/4 步长把幅度压到
     * 1/4，横纹随之消失；球数翻倍，可这点开销远小于重画一次的其它成本。
     */
    const steps = Math.max(1, Math.min(96, Math.ceil(len / Math.max(0.006, Math.min(ra, rb) * 0.25))))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      spheres.push({
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        z: a[2] + (b[2] - a[2]) * t,
        r: ra + (rb - ra) * t,
      })
    }
  }

  /* 脚掌：沿脚踝 → 脚尖的方向铺一串球。
   *
   * 旧实现把三颗球硬钉在 y=GROUND_Y 上，等于无论怎么摆姿势脚掌都躺在地上：
   * 坐下时踝在椅面高度、脚却还留在地板，腿和脚中间被拉成一根橡皮管；迈步时
   * 也会出现一只脚贴地、另一只脚跟着踝悬空的错觉。现在脚掌跟着小腿的方向
   * 走，落地交给 `groundRig()` 的脚底剖面统一处理。
   *
   * 这是「补形」而不是新关节：脚踝仍然是唯一的骨骼端点，摆姿自由度不变。
   */
  for (const side of ['L', 'R'] as const) {
    const ankle = world[`foot${side}` as PoseJoint]
    const knee = world[`knee${side}` as PoseJoint]
    const { forward } = footFrame(ankle, knee)
    for (const ring of FOOT_PROFILE) {
      const r = Math.max(ring.rx, ring.rz)
      spheres.push({
        x: ankle[0] + forward[0] * ring.t * FOOT_LENGTH,
        y: ankle[1] + forward[1] * ring.t * FOOT_LENGTH,
        z: ankle[2] + forward[2] * ring.t * FOOT_LENGTH,
        r,
      })
    }
  }

  for (const limb of limbsOf(rig, world)) {
    if (limb.joint === 'head') {
      // 头单独成球（略扁），颈子用一根细管接上，否则头会浮着。
      const head = limb.to
      const neck = limb.from
      const ry = limb.radiusTo * 1.20
      addTube(neck, [head[0], head[1] - ry * 0.55, head[2]], limb.radiusFrom, limb.radiusTo * 0.72)
      spheres.push({ x: head[0], y: head[1] - ry * 0.10, z: head[2], r: limb.radiusTo * 1.05 })
      continue
    }
    addTube(limb.from, limb.to, limb.radiusFrom, limb.radiusTo)
  }

  // 胸腔的「肩宽」已经由两条连接段锥形承担，不再额外补球——
  // 补了就是胸侧两处鼓包（实测是胸下两个明显的蝶翼形凸起）。

  return spheres
}

/** 骨架里的父子段，供导演台画青色骨骼线。 */
export const POSE_SEGMENTS: ReadonlyArray<[PoseJoint, PoseJoint]> = SEGMENTS

/** 地面高度常量，供场景画网格与角色落地对齐。 */
export const POSE_GROUND_Y = GROUND_Y

/**
 * 把姿势画进给定的 2D 上下文。
 *
 * 用距离场把各部件的球平滑融合成一具体块，再在体块里刷明暗。
 * 逐段画圆的做法已被证伪：一条串起来的球永远在关节处鼓包。
 */
export function drawPose(ctx: CanvasRenderingContext2D, rig: PoseRig, options: PoseRenderOptions): void {
  const { size, camera } = options
  const studio = options.backdrop === 'studio'
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  if (studio) {
    paintStudioBackdrop(ctx, size)
  } else if (options.background !== null) {
    ctx.fillStyle = options.background
    ctx.fillRect(0, 0, size, size)
  }

  const view = cameraMatrix(camera)
  const focal = (size / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)
  const project = (p: [number, number, number]): [number, number, number] | null => {
    const cameraPoint = applyMatrix(view, p)
    const depth = -cameraPoint[2]
    if (depth <= 0.05) return null
    return [size / 2 + (cameraPoint[0] * focal) / depth, size / 2 - (cameraPoint[1] * focal) / depth, depth]
  }

  // 地面网格：给人一个「站在地上」的参照，也让 3/4 视角能看出朝向。
  if (options.guides) {
    // 浅底网格用极淡的灰：既要让人看出「站在地上」，又不能盖过线稿的描边。
    ctx.strokeStyle = studio ? 'rgba(60,68,80,0.10)' : 'rgba(0,0,0,0.10)'
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

  /* ---------------------------------------------------------------
   * 距离场渲染。
   *
   * 为什么换掉「逐段画圆」：一串球拼起来的东西永远在关节处鼓出一个包，
   * 调半径只是把包从肩膀挪到胯部。距离场把「离身体有多远」定义成一个
   * 连续函数，再用 smooth-min 把各部件的距离平滑地融合，于是接缝真的
   * 消失了——这正是附件 2 那种人偶的观感来源。
   *
   * 分辨率固定：人的高度只占屏幕的 0.6 左右，1/2.2 的格距在 640px 上
   * 是 290 格高，足够看清轮廓；再高就只是把同一形状算得更慢。
   * --------------------------------------------------------------- */
  const fieldSize = Math.min(720, Math.max(280, Math.round(size / 2.2)))
  const cell = size / fieldSize

  // 球体构建抽到 `buildSpheres`：导演台要按角色各生成一批再合成，两块
  // 界面必须用同一份形体定义，否则同一个人在两处长得不一样。
  const world = solveRig(rig)
  const spheres = buildSpheres(rig, world)
  // 把探测点换回世界坐标用的逆变换：屏幕 → 相机 → 世界。
  // 这里不真的做逆变换，而是把球体投到屏幕空间里算距离场：
  // 投影不是保距的，但对「融合一个看起来像人的体块」这件事够用，
  // 而且免掉了逆矩阵与逐像素射线求交。
  interface Disc { cx: number; cy: number; r: number }
  const discs: Disc[] = []
  for (const sphere of spheres) {
    const p = project([sphere.x, sphere.y, sphere.z])
    if (p === null) continue
    discs.push({ cx: p[0], cy: p[1], r: Math.max(0.6, (sphere.r * focal) / p[2]) })
  }

  /* 平滑并集（smin）：两个距离取较小值，再在接缝处平滑过渡。
   *
   * K 是「融合半径」，单位是屏幕像素。它有一个很窄的可用区间，两端都实测过：
   *
   *  · 太大（size*0.010 ≈ 6.4px）→ 手臂与躯干、两腿之间整个糊成一片。
   *    这不是理论推演：导出图上整个人成了一块「床单」，腋下没有缝、
   *    两条腿并成一根柱子，只能靠橙色球猜关节在哪。
   *  · 太小（< 1px）→ 接缝处留下硬折线，关节球边缘露出毛刺。
   *
   * 现在取 size*0.0035（640 上约 2.2px）：手臂内缘到胸腔的间隙是
   * 世界 0.018（投影后五六个像素），K 必须明显小于它才留得住那条缝。
   */
  const K = size * 0.0035
  const smin = (a: number, b: number): number => Math.min(a, b) - Math.max(0, K - Math.abs(a - b)) ** 2 / (4 * K)

  const field = new Float32Array(fieldSize * fieldSize)
  for (let gy = 0; gy < fieldSize; gy += 1) {
    const py = (gy + 0.5) * cell
    for (let gx = 0; gx < fieldSize; gx += 1) {
      const px = (gx + 0.5) * cell
      let distance = 1e9
      for (const disc of discs) {
        const dx = px - disc.cx
        const dy = py - disc.cy
        // 快速排除：比当前最近距离还远一大截的球不可能影响结果。
        if (Math.abs(dx) > distance + disc.r + K && Math.abs(dy) > distance + disc.r + K) continue
        const d = Math.hypot(dx, dy) - disc.r
        distance = distance === 1e9 ? d : smin(distance, d)
      }
      field[gy * fieldSize + gx] = distance
    }
  }

  /* 出图：淡蓝灰实体人偶 + 橙色关节球 + 青色骨骼连线。
   *
   * 这是照着「标准初始样子」那张参考图定的：不是在画雕塑，而是在画**骨架
   * 外面套了一层皮**。三样东西各管一件事，缺一样都读不懂：
   *
   *  · 体块用一层非常浅的蓝灰、几乎不做明暗（参考图的明暗也很淡）。之前
   *    那版强明暗白模被否了两次——它把「转折」画得太重，人偶看着像塑料
   *    雕塑，而且和「姿势参考」这件事没关系；
   *  · 橙色小球钉在每个关节上，这是用户真正要读的信息；
   *  · 青色细线把关节连成骨架，一眼能看出哪根骨朝哪边折。
   *
   * 体块仍然来自距离场（smin 融合后的等值面），所以轮廓是连续的、没有
   * 串珠和关节鼓包；只是「怎么上色」换成了淡色 + 一点点方向性明暗。
   */
  const mask = document.createElement('canvas')
  mask.width = fieldSize
  mask.height = fieldSize
  const maskCtx = mask.getContext('2d')
  if (maskCtx === null) { ctx.restore(); return }
  const image = maskCtx.createImageData(fieldSize, fieldSize)
  const edge = cell * 1.1
  // 明暗只需要「有个方向」：光从左上前来，幅度很小（±7% 亮度）。
  // 之前用 0.22..1.0 的强对比，看着像打了影棚灯；参考图那种淡法才对。
  const lx = -0.42
  const ly = -0.50
  const lz = 0.76
  const normalRadius = size * 0.10
  const fieldAt = (gx: number, gy: number): number => {
    const x = gx < 0 ? 0 : (gx >= fieldSize ? fieldSize - 1 : gx)
    const y = gy < 0 ? 0 : (gy >= fieldSize ? fieldSize - 1 : gy)
    return field[y * fieldSize + x] ?? 0
  }
  for (let gy = 0; gy < fieldSize; gy += 1) {
    for (let gx = 0; gx < fieldSize; gx += 1) {
      const i = gy * fieldSize + gx
      const d = field[i] ?? 0
      const alpha = Math.max(0, Math.min(1, 0.5 - d / edge))
      if (alpha <= 0) continue
      const gxv = ((fieldAt(gx + 1, gy) - fieldAt(gx - 1, gy)) * 0.5) / cell
      const gyv = ((fieldAt(gx, gy + 1) - fieldAt(gx, gy - 1)) * 0.5) / cell
      // 与白模那版同一个思路：让法线在半径内平缓转向，避免轴心一条硬亮线。
      const inward = Math.max(0, Math.min(1, 1 + d / normalRadius))
      const nx = Math.max(-1, Math.min(1, gxv * inward))
      const ny = Math.max(-1, Math.min(1, gyv * inward))
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny))
      const shade = nx * lx + ny * ly + nz * lz
      // 基色是冷调浅蓝灰，明暗只在这个基准上加减小量。
      //
      // 第一版基色 0xb8 乘出来落在 175 上下，整具人偶是灰的——参考图明显
      // 更亮、更偏冷白（大约 #c8ccd4 到 #dae0e8）。基准抬到 0xc8，明暗
      // 幅度收到 ±9%，亮面才像一块磨砂白模而不是水泥。
      const tone = 0.94 + 0.14 * shade
      image.data[i * 4] = Math.round(0xc8 * tone)
      image.data[i * 4 + 1] = Math.round(0xcc * tone)
      image.data[i * 4 + 2] = Math.round(0xd6 * tone)
      image.data[i * 4 + 3] = Math.round(alpha * 255)
    }
  }
  maskCtx.putImageData(image, 0, 0)

  // 一层柔影，让体块不像是贴在纸上。幅度比白模那版小得多。
  ctx.save()
  ctx.shadowColor = 'rgba(70,80,100,0.20)'
  ctx.shadowBlur = size * 0.022
  ctx.shadowOffsetY = size * 0.008
  ctx.drawImage(mask, 0, 0, size, size)
  ctx.restore()

  /* 骨骼连线：青色细线，逐段画在体块之上。
   *
   * 用 SEGMENTS 而不是包围盒：线要落在真正的骨头上，否则「这根骨朝哪折」
   * 这件事反而被画糊涂了。脊柱那三段也照画——参考图里躯干上就是一条竖线
   * 串到骨盆。
   */
  ctx.save()
  ctx.strokeStyle = 'rgba(46,196,214,0.85)'
  ctx.lineWidth = Math.max(1, size / 460)
  ctx.lineCap = 'round'
  for (const [parent, child] of SEGMENTS) {
    const a = project(world[parent])
    const b = project(world[child])
    if (a === null || b === null) continue
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
  }
  // 脊柱中线一直连到地面：参考图里有一条竖直的参考线，用来判断重心有没有偏。
  const hips = project(world.hips)
  const ground = project([world.hips[0], 0.02, world.hips[2]])
  if (hips !== null && ground !== null) {
    ctx.strokeStyle = 'rgba(46,196,214,0.32)'
    ctx.beginPath(); ctx.moveTo(hips[0], hips[1]); ctx.lineTo(ground[0], ground[1]); ctx.stroke()
  }
  ctx.restore()

  // 关节球：橙色，由远及近画，前后遮挡才对。
  const dots = (Object.keys(world) as PoseJoint[])
    .map(joint => ({ joint, p: project(world[joint]) }))
    .filter((item): item is { joint: PoseJoint; p: [number, number, number] } => item.p !== null)
    .sort((a, b) => b.p[2] - a.p[2])
  ctx.save()
  ctx.fillStyle = '#f7a325'
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = Math.max(0.7, size / 900)
  for (const dot of dots) {
    const radius = Math.max(1.8, size / 165)
    ctx.beginPath()
    ctx.arc(dot.p[0], dot.p[1], radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()

  if (options.guides) {
    // 关节标记：编辑时才画，导出永远干净。
    for (const joint of Object.keys(world) as PoseJoint[]) {
      const p = project(world[joint])
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

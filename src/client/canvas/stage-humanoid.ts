/**
 * 导演台的人形：用椭圆截面放样拼出来的人体，替换原来「每个关节一颗球 +
 * 每根骨一根等粗圆柱」的写法。
 *
 * 为什么必须换：球 + 圆柱的横截面永远是**圆**，于是躯干是一根管子、大臂是
 * 一根管子，关节处靠大球遮缝。远看是一个球关节木偶，近看是几根香肠叠在一起
 * ——和牧野那种连续人体差在最基础的一层：人体没有一段是正圆截面的。胸腔左右
 * 宽、前后薄；小腿肚后厚前薄；大腿上粗下细。把横截面从圆换成椭圆、再让半径
 * 沿骨长变化，同一个骨架就能立起一个有体积的人。
 *
 * ## 几何怎么来
 *
 * 每一段（骨盆、腹胸、颈、大臂、小臂、大腿、小腿）都是一条 {@link loft}：
 * 一串「沿骨长 t 处的椭圆半宽」，相邻两环之间补四边形，两端封口。几何**按段
 * 只建一次**（面板级共享），每个角色只是引用 + 每帧改变换——与原来共享球/圆柱
 * 的做法同一个理由：拖动时反复重建 BufferGeometry 会掉帧。
 *
 * ## 为什么还要关节球
 *
 * 保留肩、肘、膝、胯、踝处的小球。它们不是偷懒：木偶人偶本来就是外露球关节，
 * 而且两段放样在弯折到极限时会露出缝——球把缝补上。这是**刻意的造型**，
 * 不是遮丑。
 */

import {
  BufferGeometry, Float32BufferAttribute, Matrix4, SphereGeometry, Vector3,
  type Material, type Object3D,
} from 'three'
import { FOOT_LENGTH, FOOT_PROFILE, type PoseJoint } from './pose-rig.ts'

/** 一段骨头上的一环：t 是沿骨长的位置（0 = 起点关节，1 = 终点关节）。 */
export interface LoftRing {
  t: number
  /** 左右半宽（X）。 */
  rx: number
  /** 前后半宽（Z）。 */
  rz: number
  /**
   * 这一环相对骨轴的横向偏移。省略即 0。
   *
   * 没有它就做不出「臀部往后、胸往前」：椭圆只能沿骨轴对称排列，侧面看是
   * 一块竖直的板。加上偏移之后，同一根骨上不同高度的截面可以各自偏一点点，
   * 臀线与胸线就出来了。
   */
  oz?: number
  /** 左右偏移。目前只用在需要不对称的地方，留着以免以后再改接口。 */
  ox?: number
}

/**
 * 把一串椭圆环放样成一根管。
 *
 * 法线用解析式而不是 `computeVertexNormals()`：沿骨长有收放时，靠三角形绕向
 * 自动算出的法线会在环与环之间出现一条一条的棱，而这里要的正是连续的曲面。
 * 解析法线取「椭圆在该角度的外法向」，再把收放造成的斜率补进 Y 分量。
 *
 * 两端各封一个三角扇。封口在关节球里，看不见，但没有封口时从任何角度看过去
 * 都是一个空心管（背面剔除之后里面全黑）。
 */
export function loft(rings: readonly LoftRing[], radial = 20): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const count = rings.length

  for (let r = 0; r < count; r += 1) {
    const ring = rings[r]!
    // 收放斜率：用相邻环的半径差估这一段在 Y 方向的倾角，补进法线。
    const prev = rings[Math.max(0, r - 1)]!
    const next = rings[Math.min(count - 1, r + 1)]!
    const span = Math.max(1e-6, next.t - prev.t)
    for (let i = 0; i < radial; i += 1) {
      const a = (i / radial) * Math.PI * 2
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      positions.push(ca * ring.rx + (ring.ox ?? 0), ring.t, sa * ring.rz + (ring.oz ?? 0))
      // 椭圆外法向：梯度 (x/rx², z/rz²)，再归一化。
      let nx = ca / Math.max(1e-6, ring.rx)
      let nz = sa / Math.max(1e-6, ring.rz)
      const len = Math.hypot(nx, nz) || 1
      nx /= len
      nz /= len
      const slope = ((next.rx + next.rz) - (prev.rx + prev.rz)) / (2 * span)
      const ny = -slope * 0.5
      const nlen = Math.hypot(nx, ny, nz) || 1
      normals.push(nx / nlen, ny / nlen, nz / nlen)
    }
  }

  for (let r = 0; r < count - 1; r += 1) {
    const base = r * radial
    const ahead = (r + 1) * radial
    for (let i = 0; i < radial; i += 1) {
      const j = (i + 1) % radial
      // 绕向与 three 的 CylinderGeometry 一致（从 +Y 往下看是逆时针），
      // 否则背面剔除会把整根管子剔掉——画面上什么都不剩。
      indices.push(base + i, ahead + i, ahead + j)
      indices.push(base + i, ahead + j, base + j)
    }
  }

  // 封口：两端各一个圆心 + 一圈扇形。
  const first = rings[0]!
  const last = rings[count - 1]!
  const startCenter = positions.length / 3
  positions.push(first.ox ?? 0, first.t, first.oz ?? 0)
  normals.push(0, -1, 0)
  const endCenter = positions.length / 3
  positions.push(last.ox ?? 0, last.t, last.oz ?? 0)
  normals.push(0, 1, 0)
  const endBase = (count - 1) * radial
  for (let i = 0; i < radial; i += 1) {
    const j = (i + 1) % radial
    indices.push(startCenter, i, j)
    indices.push(endCenter, endBase + j, endBase + i)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 一段骨头的几何：单位长度（y 从 0 到 1），横截面半径按 {@link LoftRing} 走。
 *
 * 用单位长度而不是烘进真实长度，是为了让同一份几何被所有角色共用——每个角色
 * 的骨长其实相同（骨架是同一套），但缩放成单位长度之后，道具/GLB 那条路要
 * 拿它当模板也方便。
 */
function bone(rings: readonly LoftRing[], radial = 20): BufferGeometry {
  return loft([...rings].sort((a, b) => a.t - b.t), radial)
}

/**
 * 一整套人形零件的几何表。
 *
 * 尺寸口径与 `JOINT_RADIUS` 同一套（那是一个 H = 0.224 的标准人形换算出来的）：
 * 头半径 0.100、胸 0.114、腰 0.092、胯 0.118。这里在它上面加的是**截面形状**
 * 与**沿骨长的收放**，骨骼位置一个都没改——姿势、预设、时间轴、导出全不用动。
 */
export interface HumanoidGeometry {
  pelvis: BufferGeometry
  chest: BufferGeometry
  neck: BufferGeometry
  head: BufferGeometry
  upperArm: BufferGeometry
  forearm: BufferGeometry
  hand: BufferGeometry
  thigh: BufferGeometry
  shin: BufferGeometry
  foot: BufferGeometry
  /**
   * 髋部过桥：从骨盆包到大腿根的一小段。
   *
   * 骨盆和腿是两段独立的放样，髋关节只靠一颗球补。腿往前一抬（坐、迈步），
   * 大腿根的平口就从骨盆底下转出来，正面看是胯下两道断开的台阶。这一小段
   * 跟着大腿走、上口比大腿根更宽，把台阶盖在骨盆里。
   */
  thighSleeve: BufferGeometry
  /** 肩部三角肌套筒：从肩关节往大臂铺一小段，盖住胸廓与大臂之间的缝。 */
  shoulderSleeve: BufferGeometry
  /** 木铰链：膝/肘的圆角圆柱，替代一颗正球。 */
  hinge: BufferGeometry
  joint: BufferGeometry
}

/**
 * 建一整套人形几何。
 *
 * 调用方负责在面板销毁时释放（这些几何是面板级共享的，见 `stage-scene-3d` 的
 * 共享池约定）。
 */
export function createHumanoidGeometry(): HumanoidGeometry {
  return {
    // 骨盆：胯最宽，往上收到腰。前后比左右薄一截——这是「人」与「管子」
    // 最直接的区别，正面看是胯，侧面看是扁的。
    //
    // `t` 可以是负数：那些环落在**起点关节之下**，把平底收成圆弧。没有它们
    // 时骨盆底面是一个圆盘，从低机位看就是一块切开的截面。
    //
    // 顶端收到 0.096，正好接上 `chest` 的第一环——两段在腰上**同宽**，
    // 否则腰侧会出现一道台阶（上一版骨盆比腹胸宽 0.018，正面看起来像
    // 单独套了一条尿布）。
    pelvis: bone([
      { t: -0.58, rx: 0.012, rz: 0.010, oz: 0 },
      { t: -0.52, rx: 0.040, rz: 0.035, oz: -0.001 },
      { t: -0.44, rx: 0.075, rz: 0.060, oz: -0.004 },
      { t: -0.34, rx: 0.095, rz: 0.076, oz: -0.008 },
      { t: -0.22, rx: 0.102, rz: 0.084, oz: -0.012 },
      { t: -0.10, rx: 0.110, rz: 0.094, oz: -0.016 },
      { t: 0.02, rx: 0.114, rz: 0.100, oz: -0.018 },
      { t: 0.32, rx: 0.112, rz: 0.102, oz: -0.014 },
      { t: 0.68, rx: 0.102, rz: 0.090, oz: -0.004 },
      { t: 1, rx: 0.100, rz: 0.082, oz: 0 },
    ]),
    // 腹胸：从腰到**肩线之上**。先收再放（腰—肋—胸），t≈1.35 处最宽，
    // 那里正好是肩关节的高度（chest 关节往上 0.06，本段每 t 是 0.160）。
    //
    // 上一版只画到 chest 关节就收口，于是「肩线」落在了颈部那一段上，
    // 而颈只有 0.072 宽——胸廓在肩高处只有 0.082，手臂挂在 ±0.170 的肩
    // 关节上，中间空出 0.09 的缝，远看就是两条手臂浮在身体旁边。
    chest: bone([
      { t: 0, rx: 0.100, rz: 0.082, oz: 0 },
      { t: 0.30, rx: 0.104, rz: 0.090, oz: 0.004 },
      { t: 0.65, rx: 0.114, rz: 0.102, oz: 0.008 },
      { t: 0.95, rx: 0.128, rz: 0.110, oz: 0.010 },
      { t: 1.28, rx: 0.148, rz: 0.104, oz: 0.008 },
      { t: 1.58, rx: 0.168, rz: 0.092, oz: 0.002 },
      { t: 1.72, rx: 0.132, rz: 0.074, oz: 0 },
      { t: 1.82, rx: 0.070, rz: 0.056, oz: 0 },
      { t: 1.88, rx: 0.040, rz: 0.038, oz: 0 },
    ]),
    // 颈：从胸廓顶端收到脖子。大部分藏在胸廓里，露出来的只有最上面一截。
    neck: bone([
      { t: 0, rx: 0.070, rz: 0.062 },
      { t: 0.55, rx: 0.050, rz: 0.047 },
      { t: 0.80, rx: 0.048, rz: 0.045 },
      { t: 1.05, rx: 0.052, rz: 0.049 },
    ], 16),
    // 头：早先 t 只画到 0..1（= 颈到头的 0.100），得到一块
    // 0.10 高、0.19 宽的**扁碟**；后来撑到 -0.85..2.20 又过头，成了 0.305
    // 高——正面只是「头大」，侧面就是一颗向后歪的大鸡蛋（5.5 头身）。
    // 人的头身比 7..7.5：头高 0.204、头宽 0.15，量出来正好 7.0 头身。
    // 下端仍画到颈根以下，否则颈与头之间断开。
    head: bone([
      { t: -0.60, rx: 0.040, rz: 0.038 },
      { t: -0.38, rx: 0.058, rz: 0.056 },
      { t: -0.02, rx: 0.070, rz: 0.070 },
      { t: 0.42, rx: 0.075, rz: 0.076 },
      { t: 0.91, rx: 0.070, rz: 0.072 },
      { t: 1.22, rx: 0.052, rz: 0.054 },
      { t: 1.37, rx: 0.030, rz: 0.032 },
      { t: 1.44, rx: 0.013, rz: 0.014 },
    ], 18),
    // 大臂：三角肌处最粗，往肘收到细。
    upperArm: bone([
      { t: 0, rx: 0.054, rz: 0.054 },
      { t: 0.28, rx: 0.050, rz: 0.050 },
      { t: 1, rx: 0.042, rz: 0.042 },
    ], 16),
    // 小臂：肘处稍粗，往腕收细。
    forearm: bone([
      { t: 0, rx: 0.042, rz: 0.042 },
      { t: 0.30, rx: 0.040, rz: 0.040 },
      { t: 1, rx: 0.030, rz: 0.030 },
    ], 16),
    // 手：掌部更宽、前后更薄，读成一只连指手套而不是一根圆头桩。
    hand: bone([
      { t: 0, rx: 0.030, rz: 0.024 },
      { t: 0.42, rx: 0.040, rz: 0.026 },
      { t: 0.82, rx: 0.038, rz: 0.022 },
      { t: 1, rx: 0.028, rz: 0.016 },
    ], 14),
    // 大腿：胯下最粗，往膝收。根部取 0.066 而不是更粗——胯点 ±0.082 加上
    // 这个半径，外缘 0.148，与骨盆外缘 0.116 只差一档；再粗就在胯侧鼓出
    // 两块「臀包」。
    thigh: bone([
      { t: 0, rx: 0.066, rz: 0.080 },
      { t: 0.45, rx: 0.058, rz: 0.070 },
      { t: 1, rx: 0.050, rz: 0.054 },
    ]),
    // 小腿：膝下细、小腿肚鼓在靠上三分之一处、踝处最细。这一处鼓起是
    // 「有腿的人」与「一根棍」最明显的分界。
    shin: bone([
      { t: 0, rx: 0.048, rz: 0.050 },
      { t: 0.28, rx: 0.052, rz: 0.058 },
      { t: 0.62, rx: 0.042, rz: 0.044 },
      { t: 1, rx: 0.034, rz: 0.036 },
    ]),
    // 脚：脚踝根部圆，脚背最高，脚尖收圆。早先末环是 rx 0.044 × rz 0.018 的
    // 平切面，侧面看是一块带钝头的踏板——多给一档收才圆得起来。
    // 脚掌剖面与接地求解共用 `pose-rig.ts` 的 `FOOT_PROFILE`：两边各写
    // 一套时，3D 看到的脚和 `groundRig()` 算出来的脚会差几毫米。
    foot: bone(FOOT_PROFILE, 14),
    // 髋部过桥：上口伸进骨盆内部，髋线处略宽，往下收到与大腿同粗。
    // 上口不能比骨盆还宽，否则会从胯侧鼓出一圈「短裤」边；下口必须
    // 收到大腿在该处的半径，否则会在腿中段留一道台阶。
    thighSleeve: bone([
      // 顶端做成圆顶，而不是一个藏在骨盆里的平口圆盘：平口与骨盆相交时
      // 两个面几乎平行，低模上会留下锯齿状的缝；圆顶与骨盆以更陡的角度
      // 相交，缝变成一条干净的曲线。
      { t: -0.10, rx: 0.012, rz: 0.014 },
      { t: -0.04, rx: 0.045, rz: 0.052 },
      { t: 0.04, rx: 0.062, rz: 0.070 },
      { t: 0.35, rx: 0.064, rz: 0.070 },
      { t: 0.70, rx: 0.062, rz: 0.066 },
      { t: 1, rx: 0.059, rz: 0.062 },
    ], 18),
    // 肩部套筒：起点比大臂根（0.054）宽一点，压住三角肌与胸廓的接缝；
    // 下口收到上臂在该处的半径，避免看起来像套了一件短袖。
    shoulderSleeve: bone([
      { t: -0.15, rx: 0.048, rz: 0.052 },
      { t: 0, rx: 0.056, rz: 0.060 },
      { t: 0.35, rx: 0.053, rz: 0.055 },
      { t: 0.70, rx: 0.050, rz: 0.052 },
      { t: 1, rx: 0.047, rz: 0.049 },
    ], 16),
    // 轴沿 Y、长度 1 的木铰链：以关节为中心（t=-0.5..0.5），两端收窄的
    // 桶形，不再是一根平口圆柱。平口圆柱在近景里像两个易拉罐；桶形两端
    // 有收分，读起来才是木销。
    hinge: bone([
      { t: -0.5, rx: 0.55, rz: 0.55 },
      { t: -0.38, rx: 0.88, rz: 0.88 },
      { t: 0, rx: 1, rz: 1 },
      { t: 0.38, rx: 0.88, rz: 0.88 },
      { t: 0.5, rx: 0.55, rz: 0.55 },
    ], 16),
    // 关节球：单位球，按关节半径缩放。
    joint: new SphereGeometry(1, 18, 14),
  }
}

/** 释放整套几何。 */
export function disposeHumanoidGeometry(geometry: HumanoidGeometry): void {
  for (const part of Object.values(geometry)) part.dispose()
}

/**
 * 人形零件在骨上的挂法。
 *
 * 每一项是「几何名 + 从哪个关节到哪个关节」，`stage-scene-3d` 照着它每帧把
 * 每一段摆到两个关节之间。写成数据而不是在渲染循环里写七段 if，是因为
 * 加一段（比如加手掌朝向）时只需要在这里加一行。
 */
export type HumanoidPartName =
  | 'pelvis' | 'chest' | 'neck' | 'head'
  | 'upperArmL' | 'forearmL' | 'handL'
  | 'upperArmR' | 'forearmR' | 'handR'
  | 'thighL' | 'shinL' | 'footL'
  | 'thighR' | 'shinR' | 'footR'

/** 关节球：五个位置在弯折时会露缝，各补一颗。 */
export type HumanoidJointName =
  | 'shoulderL' | 'elbowL' | 'handL'
  | 'shoulderR' | 'elbowR' | 'handR'
  | 'hipL' | 'kneeL' | 'footL'
  | 'hipR' | 'kneeR' | 'footR'

/** 材质约定：整个人体一个材质，不分区着色——分区会让「这是一整块」散掉。 */
export type HumanoidMaterial = Material

/** 几何表里能当零件用的键（`joint` 是关节球，不在此列）。 */
export type HumanoidGeometryKey = Exclude<keyof HumanoidGeometry, 'joint'>

/** 一段零件：从 `from` 关节摆到 `to` 关节。 */
export interface HumanoidSpan {
  key: string
  geometry: HumanoidGeometryKey
  from: PoseJoint
  to: PoseJoint
}

/**
 * 从某个关节**继续往外**延伸的零件（手）。
 *
 * 手不在两个关节之间——腕关节之后才是手，所以方向取「肘 → 腕」的延长线。
 */
export interface HumanoidExtension {
  key: string
  geometry: HumanoidGeometryKey
  from: PoseJoint
  away: PoseJoint
  length: number
}

/**
 * 脚：踝关节之后朝**身体正前方**（+Z）延伸，同时保持贴地。
 *
 * 脚的朝向不能跟着小腿转——小腿一弯，脚要是跟着转，人就像踮着脚尖。
 * 这里用「小腿方向当上、世界 +Z 当前」现搭一个基。
 */
export interface HumanoidFoot {
  key: string
  geometry: HumanoidGeometryKey
  ankle: PoseJoint
  knee: PoseJoint
  length: number
}

/** 一段套筒：从关节 `from` 沿 `to` 的方向铺 `length` 米。 */
export interface HumanoidSleeve {
  key: string
  geometry: HumanoidGeometryKey
  from: PoseJoint
  to: PoseJoint
  length: number
}

/** 一个木铰链：轴垂直于两根骨所在的平面。 */
export interface HumanoidHinge {
  key: string
  /** 放在哪个关节上。 */
  joint: PoseJoint
  /** 铰链两侧的关节，用来求弯曲轴。 */
  parent: PoseJoint
  child: PoseJoint
  /**
   * 明确的铰链轴（局部坐标）。缺省按 `parent → joint → child` 的弯曲平面
   * 求法线；髋关节需要固定成左右轴，因为它两侧的骨几乎共线，叉积会退化。
   */
  axis?: [number, number, number]
  radius: number
  length: number
}

/** 躯干与四肢：从哪个关节到哪个关节。左右共用同一份几何，靠变换区分。 */
export const HUMANOID_SPANS: readonly HumanoidSpan[] = [
  { key: 'pelvis', geometry: 'pelvis', from: 'hips', to: 'spine' },
  { key: 'chest', geometry: 'chest', from: 'spine', to: 'chest' },
  { key: 'neck', geometry: 'neck', from: 'chest', to: 'neck' },
  { key: 'head', geometry: 'head', from: 'neck', to: 'head' },
  { key: 'upperArmL', geometry: 'upperArm', from: 'shoulderL', to: 'elbowL' },
  { key: 'forearmL', geometry: 'forearm', from: 'elbowL', to: 'handL' },
  { key: 'upperArmR', geometry: 'upperArm', from: 'shoulderR', to: 'elbowR' },
  { key: 'forearmR', geometry: 'forearm', from: 'elbowR', to: 'handR' },
  { key: 'thighL', geometry: 'thigh', from: 'hipL', to: 'kneeL' },
  { key: 'shinL', geometry: 'shin', from: 'kneeL', to: 'footL' },
  { key: 'thighR', geometry: 'thigh', from: 'hipR', to: 'kneeR' },
  { key: 'shinR', geometry: 'shin', from: 'kneeR', to: 'footR' },
]

/** 手：腕之后继续往外。长度按手掌算，约 0.6 个头高。 */
export const HUMANOID_EXTENSIONS: readonly HumanoidExtension[] = [
  { key: 'handL', geometry: 'hand', from: 'handL', away: 'elbowL', length: 0.105 },
  { key: 'handR', geometry: 'hand', from: 'handR', away: 'elbowR', length: 0.105 },
]

/** 脚：踝之后朝正前方。 */
export const HUMANOID_FEET: readonly HumanoidFoot[] = [
  { key: 'footL', geometry: 'foot', ankle: 'footL', knee: 'kneeL', length: FOOT_LENGTH },
  { key: 'footR', geometry: 'foot', ankle: 'footR', knee: 'kneeR', length: FOOT_LENGTH },
]

/**
 * 髋/肩的过桥套筒。
 *
 * 这两处不是「补一颗更大的球」能解决的：球越大越像护肩/尿布，仍然会在
 * 旋转时和大腿/胸廓之间露出平口。套筒沿骨的方向放样，上口宽、下口收，
 * 跟着肢体转，接缝就落在骨盆/胸廓内部。
 */
export const HUMANOID_SLEEVES: readonly HumanoidSleeve[] = [
  { key: 'thighSleeveL', geometry: 'thighSleeve', from: 'hipL', to: 'kneeL', length: 0.13 },
  { key: 'thighSleeveR', geometry: 'thighSleeve', from: 'hipR', to: 'kneeR', length: 0.13 },
  { key: 'shoulderSleeveL', geometry: 'shoulderSleeve', from: 'shoulderL', to: 'elbowL', length: 0.11 },
  { key: 'shoulderSleeveR', geometry: 'shoulderSleeve', from: 'shoulderR', to: 'elbowR', length: 0.11 },
]

/**
 * 膝/肘的木铰链。
 *
 * 木偶人偶的膝肘不是球，是一根横着的木销：弯曲轴就是两根骨所在平面的法线。
 * `radius` 必须盖住相邻两段放样的管口（H8 的同类断言守住），否则弯到极限
 * 时会从铰链两侧看到孔洞。
 */
export const HUMANOID_HINGES: readonly HumanoidHinge[] = [
  { key: 'hipHingeL', joint: 'hipL', parent: 'hips', child: 'kneeL', axis: [1, 0, 0], radius: 0.070, length: 0.12 },
  { key: 'hipHingeR', joint: 'hipR', parent: 'hips', child: 'kneeR', axis: [1, 0, 0], radius: 0.070, length: 0.12 },
  { key: 'elbowHingeL', joint: 'elbowL', parent: 'shoulderL', child: 'handL', radius: 0.046, length: 0.105 },
  { key: 'elbowHingeR', joint: 'elbowR', parent: 'shoulderR', child: 'handR', radius: 0.046, length: 0.105 },
  { key: 'kneeHingeL', joint: 'kneeL', parent: 'hipL', child: 'footL', radius: 0.053, length: 0.115 },
  { key: 'kneeHingeR', joint: 'kneeR', parent: 'hipR', child: 'footR', radius: 0.053, length: 0.115 },
]

/**
 * 补关节球的关节。
 *
 * 只补**会露缝的**那几个，不是把十七个关节都堆一颗：躯干那几段（胯、腰、
 * 胸、颈、头）已经被放样面自己连上，再堆球的话胸侧与背侧会鼓出一串圆包，
 * 从侧面看正像一个球关节木偶。四肢关节保留球，因为木偶人偶本来就是这样，
 * 而且两段放样弯到极限时确实会张嘴。
 */
export const HUMANOID_JOINT_CAPS: readonly { joint: PoseJoint, radius: number }[] = [
  { joint: 'shoulderL', radius: 0.056 }, { joint: 'shoulderR', radius: 0.056 },
  { joint: 'handL', radius: 0.032 }, { joint: 'handR', radius: 0.032 },
  { joint: 'footL', radius: 0.038 }, { joint: 'footR', radius: 0.038 },
]

/**
 * 把一段放样摆到 from→to 上：位置取 from，Y 轴指过去，长度按距离缩放。
 *
 * 放样几何的横截面半径是**绝对值**（直接来自 JOINT_RADIUS 那套换算），
 * 所以只有 Y 需要按骨长缩放，X/Z 保持 1。这正是把「半径」和「长度」分开
 * 之后才做得到的事——原来的单位圆柱只能三个轴一起缩。
 */
export function alignSpan(mesh: Object3D, from: Vector3, to: Vector3): void {
  const dir = new Vector3().subVectors(to, from)
  const length = dir.length()
  mesh.position.copy(from)
  if (length < 1e-6) {
    mesh.quaternion.identity()
    mesh.scale.set(1, 1e-4, 1)
    return
  }
  dir.divideScalar(length)
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir)
  mesh.scale.set(1, length, 1)
}

/**
 * 把脚摆到踝关节上，朝身体正前方，并按小腿方向决定「朝上」。
 *
 * 本地轴：Y = 脚长方向（前），Z = 脚背方向（上），X = 宽度。
 * 三者构成右手系，所以 X 由 Y×Z 得到，不能反过来。
 */
export function alignFoot(mesh: Object3D, ankle: Vector3, knee: Vector3, length: number): void {
  // `up` 必须从踝指向膝。脚部放样绕 Z 对称，所以这个符号不影响外形；
  // 但它决定了脚底接触点在哪一侧——`pose-rig.ts` 的 `footSolePoints()`
  // 用同一套 `up`，两边必须一致。
  const up = new Vector3().subVectors(knee, ankle)
  if (up.lengthSq() < 1e-8) up.set(0, 1, 0)
  up.normalize()
  const forward = new Vector3(0, 0, 1)
  // 小腿几乎水平时（倒立、躺下）+Z 可能与小胈方向重合，这时换一个参考轴。
  if (Math.abs(forward.dot(up)) > 0.98) forward.set(1, 0, 0)
  // 把前方向投影到与「上」垂直的平面里，脚才不会歪着插进小腿。
  forward.addScaledVector(up, -forward.dot(up)).normalize()
  const side = new Vector3().crossVectors(forward, up).normalize()
  const basis = new Matrix4().makeBasis(side, forward, up)
  mesh.position.copy(ankle)
  mesh.quaternion.setFromRotationMatrix(basis)
  mesh.scale.set(1, length, 1)
}

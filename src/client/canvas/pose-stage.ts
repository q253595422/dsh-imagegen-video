/**
 * 舞台（导演台）的归一化：把节点 metadata 里那份**可能不完整**的
 * `stage`，以及只认 `pose` 的老文档，统一读成一份渲染与面板都能直接用的
 * 完整舞台。
 *
 * 为什么要有这一层，而不是在渲染和面板里各自 `?? 默认值`：
 *
 *  - 一份老画布只有 `pose`。渲染要按单角色舞台画它，面板要给出一台机位、
 *    一个场景，两边如果各补各的默认值，迟早出现「预览里有地面、导出没有」，
 *    而那是用户唯一能一眼看出来的错。
 *  - 存储校验对缺项一律放行（`isPoseStage` 只拒类型错的值），因此**字段缺失
 *    是常态而不是异常**。缺项必须在读的这一刻被补齐，之后所有代码都按完整
 *    形状工作。
 *  - `pose` 与 `stage` 的双写规则（见下）只在这一个文件里实现。写盘的地方
 *    散落在面板里，规则就必须收在纯函数里，才能被离线脚本钉住。
 *
 * 本模块是纯计算：不读 React、不碰 DOM、不发请求，Node 可直接 strip-types 跑
 * （见 `scripts/smoke-pose-stage.mjs`）。
 */

import type {
  CanvasFigureBody, CanvasPoseActor, CanvasPoseCamera, CanvasPoseRig, CanvasPoseScene, CanvasPoseStage,
  CanvasStageProp, CanvasStagePropKind,
} from '../../protocol.ts'
import { timelineOf } from './stage-timeline.ts'
import { DEFAULT_CAMERA, emptyRig, solveRig, type PoseCamera } from './pose-rig.ts'

/** 默认场景：深色天空 + 略亮的地面，和 LibTV 导演台的观感一致。
 *
 * 深底是为了让淡蓝灰的人偶立起来——浅底上它是一团更浅的灰，看不出体积。
 * 这与姿势面板的 `studio` 背板是两个用途：那个是给模型看的参考图，这个是
 * 给用户摆戏的舞台。 */
export const DEFAULT_SCENE: CanvasPoseScene = {
  sky: '#060608',
  ground: '#12141c',
  figure: 'clay',
  body: 'standard',
  translate: [0, 0, 0],
  rotateY: 0,
  scale: 100,
  panoYaw: 0,
  panoRadius: 60,
  labels: true,
}

/** 默认机位（导演视角）：与姿势面板的默认 3/4 视角同一套取景，切换过来不会
 *  看到一个人突然变小或跑出画面。 */
export const DEFAULT_CAMERA_SPEC: CanvasPoseCamera = {
  id: 'camera-1', name: '机位1',
  x: 0, y: 1.35, z: 3.6,
  targetX: 0, targetY: 0.92, targetZ: 0,
  fov: 32,
}

/** 演员 id 与机位 id 的前缀。加一个新角色/机位时用它 + 序号，避免重名。 */
const ACTOR_PREFIX = 'actor'
const CAMERA_PREFIX = 'camera'
const PROP_PREFIX = 'prop'

/** 舞台缩放的单位是百分比（面板里显示 300%），渲染要的是倍数。 */
export function scaleFactor(scene: CanvasPoseScene): number {
  const percent = Number.isFinite(scene.scale) ? scene.scale : 100
  // 0 会让整个世界塌成一个点，负值会把角色翻到地面以下；两端都夹住。
  return Math.max(0.05, Math.min(20, percent / 100))
}

/** 缺项按标准底模读；只有显式 `procedural` 才走木偶。 */
export function bodyOf(scene: CanvasPoseScene): CanvasFigureBody {
  return scene.body === 'procedural' ? 'procedural' : 'standard'
}

/** 把一台机位换算成 `pose-rig` 认识的环绕相机，供取景与投影复用。
 *
 * 姿势渲染器只有一种相机：环绕一个注视点。机位是显式视点，但两者可以互转
 * ——距离与 yaw/pitch 由视点减注视点得出。这样多角色渲染不必再写一套投影。
 */
export function cameraFromSpec(spec: CanvasPoseCamera): PoseCamera {
  const dx = spec.x - spec.targetX
  const dy = spec.y - spec.targetY
  const dz = spec.z - spec.targetZ
  const distance = Math.max(0.05, Math.hypot(dx, dy, dz))
  const yaw = Math.atan2(dx, dz) * 180 / Math.PI
  const pitch = Math.asin(Math.max(-0.999, Math.min(0.999, dy / distance))) * 180 / Math.PI
  return {
    yaw, pitch, distance, fov: spec.fov, targetY: spec.targetY,
    // 水平注视点必须一起带出来：导演台把三个人摆在 x=-1.2/0/1.2 时，只传
    // targetY 等于永远盯着原点，人群的一半在画面外。
    ...spec.targetX === 0 ? {} : { targetX: spec.targetX },
    ...spec.targetZ === 0 ? {} : { targetZ: spec.targetZ },
  }
}

/** 反向：从环绕相机（面板里拖动预览得到的那一个）写出机位。
 *
 * 面板的「导演视角」是自由环绕的，用户转完视角要把它存成一台机位时走这里，
 * 否则「拖动 → 切到机位视角」会跳回默认角度。 */
export function specFromCamera(camera: PoseCamera, base: CanvasPoseCamera): CanvasPoseCamera {
  const yaw = camera.yaw * Math.PI / 180
  const pitch = camera.pitch * Math.PI / 180
  const horizontal = Math.cos(pitch) * camera.distance
  // 注视点的水平位置跟着相机走：它在自由视角里被拖动/取景挪过之后，写回机位
  // 必须落在同一个位置，否则切到机位视角画面会横向跳一下。
  const targetX = camera.targetX ?? base.targetX
  const targetZ = camera.targetZ ?? base.targetZ
  return {
    ...base,
    x: targetX + Math.sin(yaw) * horizontal,
    y: camera.targetY + Math.sin(pitch) * camera.distance,
    z: targetZ + Math.cos(yaw) * horizontal,
    targetX,
    targetY: camera.targetY,
    targetZ,
    fov: camera.fov,
  }
}

/** 把一个可能缺字段的道具补完整。缺 id 的按序号补，缺 name 的按形状起名。 */
function propOf(raw: Partial<CanvasStageProp> | undefined, index: number): CanvasStageProp {
  const kind: CanvasStagePropKind = raw?.kind === 'sphere' || raw?.kind === 'glb' ? raw.kind : 'cube'
  const fallbackName = kind === 'cube' ? '立方体' : kind === 'sphere' ? '球体' : 'GLB'
  return {
    id: raw?.id !== undefined && raw.id !== '' ? raw.id : `${PROP_PREFIX}-${index + 1}`,
    name: raw?.name !== undefined && raw.name !== '' ? raw.name : `${fallbackName}${index + 1}`,
    kind,
    x: typeof raw?.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0,
    y: typeof raw?.y === 'number' && Number.isFinite(raw.y) ? raw.y : 0,
    z: typeof raw?.z === 'number' && Number.isFinite(raw.z) ? raw.z : 0,
    ...typeof raw?.rotateX === 'number' ? { rotateX: raw.rotateX } : {},
    ...typeof raw?.rotateY === 'number' ? { rotateY: raw.rotateY } : {},
    ...typeof raw?.rotateZ === 'number' ? { rotateZ: raw.rotateZ } : {},
    ...typeof raw?.scaleX === 'number' ? { scaleX: raw.scaleX } : {},
    ...typeof raw?.scaleY === 'number' ? { scaleY: raw.scaleY } : {},
    ...typeof raw?.scaleZ === 'number' ? { scaleZ: raw.scaleZ } : {},
    ...raw?.asset !== undefined && typeof raw.asset.assetId === 'string' && raw.asset.assetId !== '' ? { asset: raw.asset } : {},
  }
}

/** 给舞台加一个道具。摆在已有道具的右前方，和角色一样不叠在同一点。 */
export function addProp(stage: CanvasPoseStage, kind: CanvasStagePropKind): CanvasPoseStage {
  const props = stage.props ?? []
  const used = new Set(props.map(prop => prop.id))
  let serial = props.length + 1
  while (used.has(`${PROP_PREFIX}-${serial}`)) serial += 1
  const label = kind === 'cube' ? '立方体' : kind === 'sphere' ? '球体' : 'GLB'
  const prop: CanvasStageProp = {
    id: `${PROP_PREFIX}-${serial}`,
    name: `${label} ${serial}`,
    kind,
    // 前沿（+z）摆开：相机默认在 +z 侧，摆在正前方才看得见。
    x: props.length === 0 ? 0 : Math.max(...props.map(item => item.x)) + 1.2,
    y: 0,
    z: 1.2,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
  return { ...stage, props: [...props, prop] }
}

/** 面板「预设姿势」按钮收到的最小形状。 */
export interface PosePresetLike {
  rig: CanvasPoseRig
  /** 这个姿势需要一块支撑面（目前是坐姿）。 */
  seat?: boolean
}

/**
 * 某个角色当前姿势需要的坐箱。
 *
 * 箱顶取骨盆底缘（髋中心往下约 6cm），所以角色坐下时箱面刚好贴住臀部；
 * 角色缩放时箱子一起缩放。位置、朝向跟着角色走——否则拖走角色会留下一块
 * 没人在坐的箱子。
 */
export function seatPropFor(actor: CanvasPoseActor): CanvasStageProp {
  const scale = actor.scale ?? 1
  const height = Math.max(0.2, (solveRig(actor.rig).hips[1] - 0.06) * scale)
  return {
    id: `seat-${actor.id}`,
    name: '坐箱',
    kind: 'cube',
    x: actor.x,
    y: height / 2,
    z: actor.z,
    rotateY: actor.rotation ?? 0,
    scaleX: 0.55 * scale,
    scaleY: height,
    scaleZ: 0.45 * scale,
  }
}

/**
 * 把一条预设写到某个角色上，并维护它需要的支撑面。
 *
 * 坐姿不是「把腿弯起来」就成立的：`solveRig` 会把骨盆落在约 0.5m 的高度，
 * 在没有椅子的画面上看起来就是悬空。这里按骨盆底缘自动放一块普通 cube
 * 坐箱（用户可以拖动/删除），换到其他预设时再收掉它。
 *
 * 之所以放在 `pose-stage` 而不是面板里：坐下、换姿势、老文档读回都要得到
 * 同一份结果；只在 React 回调里算一次，测试就只能测到面板的 DOM。
 */
export function withPosePreset(
  stage: CanvasPoseStage,
  actorId: string,
  preset: PosePresetLike,
): CanvasPoseStage {
  const actor = stage.actors.find(item => item.id === actorId)
  if (actor === undefined) return stage
  const actors = stage.actors.map(item => (item.id === actorId ? { ...item, rig: preset.rig } : item))
  const seatId = `seat-${actorId}`
  const props = stage.props ?? []
  if (preset.seat === true) {
    const seat = seatPropFor({ ...actor, rig: preset.rig })
    const existing = props.some(prop => prop.id === seatId)
    return {
      ...stage,
      actors,
      props: existing
        ? props.map(prop => (prop.id === seatId ? seat : prop))
        : [...props, seat],
    }
  }
  // 只收自动加的坐箱；用户自己摆的同名道具不碰。
  if (!props.some(prop => prop.id === seatId)) return { ...stage, actors }
  return { ...stage, actors, props: props.filter(prop => prop.id !== seatId) }
}

/** 改一个道具的字段；id 指不到时原样返回。 */
export function patchProp(stage: CanvasPoseStage, id: string, patch: Partial<CanvasStageProp>): CanvasPoseStage {
  const props = stage.props ?? []
  if (!props.some(prop => prop.id === id)) return stage
  return { ...stage, props: props.map(prop => (prop.id === id ? { ...prop, ...patch, id: prop.id } : prop)) }
}

/** 删一个道具。`timeline` 里它的轨道由调用方用 `removeTrack` 一并清掉。 */
export function removeProp(stage: CanvasPoseStage, id: string): CanvasPoseStage {
  const props = stage.props ?? []
  if (!props.some(prop => prop.id === id)) return stage
  return { ...stage, props: props.filter(prop => prop.id !== id) }
}

/** 一个空舞台：一个标准站姿的角色 + 一台默认机位 + 默认场景。
 *
 * 新建导演台、以及一份文档的 `pose`/`stage` 全都读不出来时，都用这一份。 */
export function emptyStage(): CanvasPoseStage {
  return {
    actors: [{ id: `${ACTOR_PREFIX}-1`, name: '角色A', rig: emptyRig(), x: 0, z: 0 }],
    cameras: [{ ...DEFAULT_CAMERA_SPEC }],
    cameraId: DEFAULT_CAMERA_SPEC.id,
    scene: { ...DEFAULT_SCENE, translate: [0, 0, 0] },
  }
}

/** 把一个可能缺字段的角色补完整。 */
function actorOf(raw: Partial<CanvasPoseActor> | undefined, index: number): CanvasPoseActor {
  const name = raw?.name !== undefined && raw.name !== '' ? raw.name : `角色${String.fromCharCode(65 + Math.min(25, index))}`
  return {
    id: raw?.id !== undefined && raw.id !== '' ? raw.id : `${ACTOR_PREFIX}-${index + 1}`,
    name,
    rig: raw?.rig ?? emptyRig(),
    x: typeof raw?.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0,
    z: typeof raw?.z === 'number' && Number.isFinite(raw.z) ? raw.z : 0,
    // 缺省不写字段：`scale: 1` 与「没有 scale」是同一个意思，而磁盘上保留
    // 「没有这个字段」的形态，往返保存才无损（同 `connection-role` 的约定）。
    ...raw?.scale === undefined ? {} : { scale: raw.scale },
    ...raw?.rotation === undefined ? {} : { rotation: raw.rotation },
  }
}

/** 把一台可能缺字段的机位补完整。 */
function cameraOf(raw: Partial<CanvasPoseCamera> | undefined, index: number): CanvasPoseCamera {
  return {
    id: raw?.id !== undefined && raw.id !== '' ? raw.id : `${CAMERA_PREFIX}-${index + 1}`,
    name: raw?.name !== undefined && raw.name !== '' ? raw.name : `机位${index + 1}`,
    x: typeof raw?.x === 'number' && Number.isFinite(raw.x) ? raw.x : DEFAULT_CAMERA_SPEC.x,
    y: typeof raw?.y === 'number' && Number.isFinite(raw.y) ? raw.y : DEFAULT_CAMERA_SPEC.y,
    z: typeof raw?.z === 'number' && Number.isFinite(raw.z) ? raw.z : DEFAULT_CAMERA_SPEC.z,
    targetX: typeof raw?.targetX === 'number' && Number.isFinite(raw.targetX) ? raw.targetX : DEFAULT_CAMERA_SPEC.targetX,
    targetY: typeof raw?.targetY === 'number' && Number.isFinite(raw.targetY) ? raw.targetY : DEFAULT_CAMERA_SPEC.targetY,
    targetZ: typeof raw?.targetZ === 'number' && Number.isFinite(raw.targetZ) ? raw.targetZ : DEFAULT_CAMERA_SPEC.targetZ,
    fov: typeof raw?.fov === 'number' && Number.isFinite(raw.fov) ? Math.max(8, Math.min(120, raw.fov)) : DEFAULT_CAMERA_SPEC.fov,
  }
}

/** 把场景补完整：逐字段取值，缺的用默认。 */
function sceneOf(raw: Partial<CanvasPoseScene> | undefined): CanvasPoseScene {
  const translate = raw?.translate
  return {
    sky: typeof raw?.sky === 'string' && raw.sky !== '' ? raw.sky : DEFAULT_SCENE.sky,
    ...raw?.ground === undefined ? { ground: DEFAULT_SCENE.ground } : { ground: raw.ground },
    // 缺项不补：老文档没有这个字段时保持「没有」，存回去才不会被我们
    // 单方面加一条 `figure: 'clay'`。渲染端把缺项当灰白膜。
    ...(raw?.figure === 'clay' || raw?.figure === 'wood'
      ? { figure: raw.figure }
      : {}),
    ...(raw?.body === 'standard' || raw?.body === 'procedural'
      ? { body: raw.body }
      : {}),
    translate: Array.isArray(translate) && translate.length === 3 && translate.every(item => Number.isFinite(item))
      ? [translate[0]!, translate[1]!, translate[2]!]
      : [0, 0, 0],
    rotateY: typeof raw?.rotateY === 'number' && Number.isFinite(raw.rotateY) ? raw.rotateY : 0,
    scale: typeof raw?.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 100,
    panoYaw: typeof raw?.panoYaw === 'number' && Number.isFinite(raw.panoYaw) ? raw.panoYaw : 0,
    panoRadius: typeof raw?.panoRadius === 'number' && Number.isFinite(raw.panoRadius) && raw.panoRadius > 0
      ? raw.panoRadius : 60,
    labels: typeof raw?.labels === 'boolean' ? raw.labels : true,
  }
}

/**
 * 节点 metadata → 一份完整舞台。这是**唯一**的读取入口。
 *
 * 优先级：`stage` 存在就用它（缺项补齐）；否则用 `pose` 合成单角色舞台；
 * 两者都没有时给 `emptyStage()`。
 *
 * 注意 `pose` 与 `stage` 不一致时的处理：以 `stage` 为准，`pose` 只是给旧
 * 版本看的镜像。反过来会让「用户在导演台里摆了三个角色，重新打开却只剩一个」
 * ——因为 `pose` 永远只有一个角色的信息，它没有能力表达其余两个。
 */
export function stageOf(metadata: { pose?: CanvasPoseRig; stage?: CanvasPoseStage } | undefined): CanvasPoseStage {
  const raw = metadata?.stage
  if (raw !== undefined) {
    const actors = Array.isArray(raw.actors) && raw.actors.length > 0
      ? raw.actors.map((actor, index) => actorOf(actor, index))
      : emptyStage().actors
    const cameras = Array.isArray(raw.cameras) && raw.cameras.length > 0
      ? raw.cameras.map((camera, index) => cameraOf(camera, index))
      : emptyStage().cameras
    const cameraId = cameras.some(camera => camera.id === raw.cameraId) ? raw.cameraId : cameras[0]!.id
    const props = Array.isArray(raw.props) ? raw.props.map((prop, index) => propOf(prop, index)) : undefined
    // 时间轴只在文档真的带了它时才带出来：`timelineOf(undefined)` 会造出一份
    // 默认 5 秒空时间轴，那会让每一份老文档都变成「有时间轴」，而 UI 正是靠
    // 「有没有 timeline」判断该不该显示那条轨道栏。
    const timeline = raw.timeline === undefined ? undefined : timelineOf(raw.timeline)
    // 提示词原样带出来：它不是渲染数据，但面板要能重新显示用户敲过的字。
    return {
      actors,
      cameras,
      cameraId,
      scene: sceneOf(raw.scene),
      ...typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {},
      ...props !== undefined && props.length > 0 ? { props } : {},
      ...timeline !== undefined ? { timeline } : {},
    }
  }
  const stage = emptyStage()
  if (metadata?.pose !== undefined) {
    stage.actors = [{ ...stage.actors[0]!, rig: metadata.pose }]
  }
  return stage
}

/**
 * 舞台 → 要写进节点的两份 metadata。
 *
 * `pose` 必须镜像 `actors[0].rig`，这样一份带导演台的文档在只认 `pose` 的
 * 旧版本插件里仍然是一张能用的姿势人偶，而不是一张读不懂的空白图片。
 *
 * 返回的对象直接展开进 `patchNode` 的 patch。
 */
export function stagePatch(stage: CanvasPoseStage): { stage: CanvasPoseStage; pose: CanvasPoseRig } {
  return {
    stage,
    pose: stage.actors[0]?.rig ?? emptyRig(),
  }
}

/**
 * 给舞台加一个角色。新角色站在已有角色的右侧一点，避免叠在同一个点上——
 * 叠在一起时用户看不出「加成功了」，只会以为按钮没反应。
 */
export function addActor(stage: CanvasPoseStage): CanvasPoseStage {
  const index = stage.actors.length
  const used = new Set(stage.actors.map(actor => actor.id))
  let serial = index + 1
  while (used.has(`${ACTOR_PREFIX}-${serial}`)) serial += 1
  const actor: CanvasPoseActor = {
    id: `${ACTOR_PREFIX}-${serial}`,
    name: `角色${String.fromCharCode(65 + Math.min(25, index))}`,
    rig: emptyRig(),
    // 沿 x 向右排开 1.2 m：两个人并排，相机不用动就能看全。
    x: stage.actors.length === 0 ? 0 : Math.max(...stage.actors.map(item => item.x)) + 1.2,
    z: 0,
  }
  return { ...stage, actors: [...stage.actors, actor] }
}

/** 给舞台加一台机位：摆在后排一点，名字接着编号。 */
export function addCamera(stage: CanvasPoseStage): CanvasPoseStage {
  const index = stage.cameras.length
  const used = new Set(stage.cameras.map(camera => camera.id))
  let serial = index + 1
  while (used.has(`${CAMERA_PREFIX}-${serial}`)) serial += 1
  const base = stage.cameras[0] ?? DEFAULT_CAMERA_SPEC
  const camera: CanvasPoseCamera = {
    ...base,
    id: `${CAMERA_PREFIX}-${serial}`,
    name: `机位${serial}`,
    // 往右后方挪一步：新机位和已有的不重合，用户切过去才知道换了台机器。
    x: base.x + 1.6,
    z: base.z + 0.9,
  }
  return { ...stage, cameras: [...stage.cameras, camera] }
}

/** 当前机位；`cameraId` 指不到任何一台时退回第一台（同 `stageOf` 的口径）。 */
export function currentCamera(stage: CanvasPoseStage): CanvasPoseCamera {
  return stage.cameras.find(camera => camera.id === stage.cameraId) ?? stage.cameras[0] ?? DEFAULT_CAMERA_SPEC
}

/** 当前机位换算成渲染用的环绕相机。 */
export function currentRenderCamera(stage: CanvasPoseStage): PoseCamera {
  const spec = currentCamera(stage)
  const converted = cameraFromSpec(spec)
  // 机位恰好压在注视点上时距离为 0，yaw/pitch 无意义；退回默认机位而不是
  // 让投影除以零（整块画面会白掉）。
  return Number.isFinite(converted.distance) && converted.distance > 0.1 ? converted : DEFAULT_CAMERA
}

/** 舞台里所有角色的世界包围盒（已含整组变换），供「重置视角」用。
 *
 * 一个角色都没有时给一个标准人的包围盒——否则空舞台的重置视角会算出
 * 一个无穷小的框，相机凑到贴着地面。 */
export function stageBounds(stage: CanvasPoseStage): { center: [number, number, number]; radius: number } {
  const scale = scaleFactor(stage.scene)
  const [tx, ty, tz] = stage.scene.translate
  const rot = stage.scene.rotateY * Math.PI / 180
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const actor of stage.actors) {
    const actorScale = actor.scale ?? 1
    // 每个角色按它自己的身高铺一个盒子：姿势只影响形体的细节，不影响
    // 「这个人在画面里占多大」，用统一的身高盒就够定位相机。
    const halfWidth = 0.55 * actorScale
    const height = 1.75 * actorScale
    for (const corner of [
      [-halfWidth, 0, -halfWidth], [halfWidth, 0, -halfWidth],
      [-halfWidth, height, -halfWidth], [halfWidth, height, -halfWidth],
      [-halfWidth, 0, halfWidth], [halfWidth, 0, halfWidth],
      [-halfWidth, height, halfWidth], [halfWidth, height, halfWidth],
    ] as Array<[number, number, number]>) {
      // 角色自身绕 y 的旋转（rig.facing + rotation）不在这里算：盒子是方的，
      // 转 90° 只是把长宽互换，对定位相机没有区别。
      const wx = actor.x + corner[0]
      const wz = actor.z + corner[2]
      const rx = wx * Math.cos(rot) + wz * Math.sin(rot)
      const rz = -wx * Math.sin(rot) + wz * Math.cos(rot)
      const px = rx * scale + tx
      const py = corner[1] * scale + ty
      const pz = rz * scale + tz
      minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz)
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz)
    }
  }
  if (!Number.isFinite(minX)) {
    return { center: [0, 0.9, 0], radius: 1.2 }
  }
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: Math.max(0.4, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2),
  }
}

/** 机位的默认取景：把整台演员装进画面。 */
export function frameCameraSpec(stage: CanvasPoseStage, base: CanvasPoseCamera): CanvasPoseCamera {
  const bounds = stageBounds(stage)
  const halfFov = (base.fov * Math.PI / 180) / 2
  const distance = (bounds.radius / Math.tan(Math.min(halfFov, Math.PI / 3))) * 1.16
  const camera = cameraFromSpec(base)
  const yaw = camera.yaw * Math.PI / 180
  const pitch = Math.max(-70, Math.min(70, camera.pitch)) * Math.PI / 180
  const horizontal = Math.cos(pitch) * distance
  return {
    ...base,
    targetX: bounds.center[0],
    targetY: bounds.center[1],
    targetZ: bounds.center[2],
    x: bounds.center[0] + Math.sin(yaw) * horizontal,
    y: bounds.center[1] + Math.sin(pitch) * distance,
    z: bounds.center[2] + Math.cos(yaw) * horizontal,
  }
}

/** 一个角色的世界变换：位置 + 整组变换，渲染与命中测试共用。 */
export function actorTransform(stage: CanvasPoseStage, actor: CanvasPoseActor): {
  scale: number
  rotation: number
  offset: [number, number, number]
} {
  const sceneScale = scaleFactor(stage.scene)
  const [tx, ty, tz] = stage.scene.translate
  const rot = stage.scene.rotateY * Math.PI / 180
  const rx = actor.x * Math.cos(rot) + actor.z * Math.sin(rot)
  const rz = -actor.x * Math.sin(rot) + actor.z * Math.cos(rot)
  return {
    scale: sceneScale * (actor.scale ?? 1),
    rotation: stage.scene.rotateY + (actor.rotation ?? 0),
    offset: [rx * sceneScale + tx, ty, rz * sceneScale + tz],
  }
}

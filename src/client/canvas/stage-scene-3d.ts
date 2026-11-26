/**
 * 导演台的 3D 渲染层（three.js）。
 *
 * 为什么是独立一层而不是继续扩 `pose-scene-render.ts`：那一层是**手写的 2D
 * 画家算法**——把骨架投影到屏幕、用 metaball 拼人形、逐球排序。它能做到
 * 「看得懂姿势」，但做不到「一个真的立方体挡住人的腿」：画家算法只对互不
 * 相交的凸体成立，而道具、地面、GLB 之间的遮挡是常态。遮罩与光照也是屏幕
 * 空间的近似，换个机位就露馅。这里换成真正的深度缓冲。
 *
 * 这一层与它**并存**：`pose-scene-render.ts` 继续服务姿势节点（轻、无依赖、
 * 1024 见方一次性出图），这一层只服务导演台。两边的 stage 数据结构是同一份
 * 协议类型，`sampleStage()` 出来后喂给谁都行。
 *
 * ## 坐标与变换
 *
 * 与 `pose-scene-render.ts` 的 `place()` 必须是同一套，否则「导演台里人和
 * 地面错位、姿势面板里对得上」：
 *
 *   世界点 = R(scene.rotateY + actor.rotation) · S(scene.scale × actor.scale) · 局部点 + offset
 *
 * three 的 Object3D 是 T·R·S，把 scale / rotation.y / position 直接挂在 Group
 * 上就得到同一条式子。骨架本身（`solveRig`）算的是**局部坐标**（已落地到
 * `POSE_GROUND_Y`），放进 Group 就变成世界位置。
 *
 * ## 确定性
 *
 * 导出路径把同一份 stage 渲染两次必须逐像素一致（脚本 V4 守这一点）。所以
 * 光照、材质、像素比全部固定，不引任何随时间或视角变化的光照（没有环境贴图、
 * 没有软阴影），渲染顺序也不依赖遍历顺序。
 */

import {
  AmbientLight, BoxGeometry, BufferGeometry, Color, ConeGeometry, DirectionalLight, Euler,
  EquirectangularReflectionMapping, GridHelper, Group, HemisphereLight, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera,
  PlaneGeometry, Raycaster, Scene, SphereGeometry, Sprite, SpriteMaterial, Texture,
  Vector2, Vector3, WebGLRenderer, type Material, type Object3D,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type {
  CanvasFigureMaterial, CanvasPoseActor, CanvasPoseStage, CanvasStageProp,
} from '../../protocol.ts'
import { POSE_GROUND_Y, solveRig, type PoseJoint } from './pose-rig.ts'
import { figureMaterialOf, FIGURE_PALETTES } from './figure-colors.ts'
import { bodyOf } from './pose-stage.ts'
import {
  instantiateStandardBody, loadStandardBodyTemplate, poseStandardBody,
  type StandardBodyRig,
} from './standard-body.ts'
import {
  HUMANOID_EXTENSIONS, HUMANOID_FEET, HUMANOID_HINGES,
  HUMANOID_JOINT_CAPS, HUMANOID_SLEEVES, HUMANOID_SPANS,
  alignFoot, alignSpan, createHumanoidGeometry, disposeHumanoidGeometry,
  type HumanoidGeometry,
} from './stage-humanoid.ts'
import { currentCamera, scaleFactor, stageBounds } from './pose-stage.ts'

/** 视口模式：自由环绕（导演视角）或透过当前机位看。 */
export type StageViewMode = 'director' | 'camera'

/** 画布尺寸（设备像素）。 */
export interface StageSize {
  width: number
  height: number
}

/**
 * 场景里可以被点/被选中的东西。
 *
 * 返回的是**协议层的 id**，不是 three 的 uuid：面板的选中态、关键帧的轨道
 * 都按协议 id 存，渲染器内部的对象生命周期不能泄漏到外面。
 */
export interface StagePick {
  target: 'actor' | 'camera' | 'object'
  id: string
}

/**
 * 一块渲染面板。所有几何都在构造时建好，之后每帧只更新变换——反复重建
 * BufferGeometry 会在拖动时掉帧，而拖动正是这个组件主要的交互。
 */
export interface StageScene {
  /** 换画布尺寸。窗口 resize 与面板展开/收起都走它。 */
  setSize(size: StageSize): void
  /** 换机位模式。`director` 用自由环绕相机，`camera` 用 stage 里的当前机位。 */
  setMode(mode: StageViewMode): void
  /**
   * 画某一刻的场景。
   *
   * `stage` 应当已经过 `sampleStage()`；这里不再做时间求值——渲染器不认识
   * 时间轴，只认识「现在的样子」。这个边界让导出路径可以逐帧喂它，也让它
   * 能在没有 timeline 的静态舞台上正常工作。
   */
  render(stage: CanvasPoseStage): void
  /** 屏幕坐标（CSS 像素，相对画布左上角）命中测试。miss 返回 null。 */
  pick(x: number, y: number): StagePick | null
  /** 直接改自由环绕相机（导演视角下拖动）。`camera` 模式忽略。 */
  orbit(deltaX: number, deltaY: number): void
  /** 缩放任一模式下都生效，`factor > 1` 拉近。 */
  zoom(factor: number): void
  /** 把自由环绕相机框到整场；`camera` 模式不动它。 */
  resetView(stage: CanvasPoseStage): void
  /** 全景球（可选）。传 null 撤掉。图未加载完不阻塞渲染。 */
  setPanorama(image: HTMLImageElement | null): void
  /** 等标准体的异步资产/克隆都落地；导出前用它避免第一帧还是木偶。 */
  ready(): Promise<void>
  /** 释放 WebGL 资源。组件卸载必须调，否则每开一次面板漏一个上下文。 */
  dispose(): void
}

/* ------------------------------------------------------------------ 常量 */

/** 道具的材质色。与人偶拉开距离，否则「盒子挡住腿」在截图上看不出来。 */
const PROP_COLOR = '#a58f78'
/** 机位的指示块颜色。 */
const CAMERA_COLOR = '#4d9de0'
/** 挂在骨架上的人形识别件。都用共享单位球缩放，不新增几何。 */
const FIGURE_FEATURES = ['nose', 'chin', 'earL', 'earR', 'thumbL', 'thumbR', 'toeL', 'toeR'] as const
type FigureFeature = typeof FIGURE_FEATURES[number]
/** 导演视角的默认取景角，与 `DEFAULT_CAMERA`（22°/6°）同一套。 */
const DIRECTOR_YAW = 22
const DIRECTOR_PITCH = 6
/** 俯仰上限。贴到 ±90° 时视线与 up 向量共线，`lookAt` 退化成随机朝向。 */
const MAX_PITCH = 85
/** 导演视角的竖直视场角。 */
const DIRECTOR_FOV = 35

/* ------------------------------------------------------------------ 工具 */

/**
 * 把一行文字画成一张纹理，给角色标签用。
 *
 * 观感对齐 2D 版的 `paintLabel`：深色圆角底 + 亮字，浅色与深色天空上都读得出来。
 * 字号 34px（2 倍采样）是「贴进 3D 拉到大约一个头宽仍清楚」与「不浪费显存」
 * 之间的折中。
 *
 * 每次改名才新建一张；调用方负责释放被替换掉的旧纹理。
 */
function labelTexture(text: string): { texture: Texture, aspect: number } {
  const canvas = document.createElement('canvas')
  const scale = 2
  const font = `600 ${17 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`
  // 先量一次再定画布尺寸：先定死尺寸的话，长名字会被裁掉，而「角色A」和
  // 「角色长长长长长」在左栏里都是合法的名字。
  const measure = canvas.getContext('2d')
  if (measure === null) throw new Error('labelTexture: no 2d context')
  measure.font = font
  const padding = 10 * scale
  const width = Math.ceil(measure.measureText(text).width) + padding * 2
  const height = Math.ceil(17 * scale * 1.9)
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('labelTexture: no 2d context')
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 圆角底：与面板里的胶囊一致，不用正圆角。
  const radius = height / 2
  ctx.fillStyle = 'rgba(17, 20, 28, 0.72)'
  ctx.beginPath()
  ctx.moveTo(radius, 0)
  ctx.arcTo(width, 0, width, height, radius)
  ctx.arcTo(width, height, 0, height, radius)
  ctx.arcTo(0, height, 0, 0, radius)
  ctx.arcTo(0, 0, width, 0, radius)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#f4f6fb'
  ctx.fillText(text, width / 2, height / 2)

  const texture = new Texture(canvas)
  texture.colorSpace = 'srgb'
  texture.needsUpdate = true
  return { texture, aspect: width / height }
}

/** 释放一个子树里所有 geometry / material / texture。
 *
 * **必须认 `userData.shared` 这条标记。** 人偶的球/圆柱/盒与四种材质都是
 * 面板级共享池里的资源：删掉一个角色时如果不加判断就 `dispose()` 它们，
 * 其余还站在场景里的角色会在下一帧变成空白（几何已释放，draw call 拿到的
 * 是空缓冲）。共享池由 `dispose()` 在面板销毁时统一释放，那里才是它们的归宿。
 *
 * GLB 的几何与材质是每个加载结果独有的，没有标记，照常释放。
 */
function disposeSubtree(root: Object3D): void {
  root.traverse(object => {
    const mesh = object as Mesh
    if (mesh.geometry !== undefined && mesh.geometry.userData.shared !== true) {
      mesh.geometry.dispose()
    }
    const materials: Material[] = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material === undefined ? [] : [mesh.material]
    for (const material of materials) {
      if (material.userData.shared === true) continue
      // 纹理挂在材质的各个槽（map / normalMap / …）上，不逐个释放会让每次
      // 导出都在显存里留一张图。共享材质上的纹理同样是共享的，上面那行已跳过。
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object' && 'isTexture' in value) {
          ;(value as Texture).dispose()
        }
      }
      material.dispose()
    }
  })
}

/**
 * 给共享池里的几何/材质打标记，让 `disposeSubtree` 不去碰它们。
 *
 * three 的 `BufferGeometry` 与 `Material` 都有 `userData`（`Material` 上也
 * 有，虽然它更常被当成"用户自定义字段"，这里正是这个用途）。
 */
function markShared<T extends { userData: Record<string, unknown> }>(resource: T): T {
  resource.userData.shared = true
  return resource
}

/**
 * 从 CSS 颜色串取 three Color；认不出来时退回兜底色。
 *
 * `scene.sky` / `scene.ground` 是用户可编辑的字符串，而 `new Color('#zzz')`
 * 不抛错、只是给一个黑色——整块画面会变黑，看起来像渲染器坏了。
 */
function colorOf(value: string | undefined, fallback: string): Color {
  const text = (value ?? '').trim()
  const usable = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)
    || /^rgba?\(/i.test(text)
    || /^[a-z]+$/i.test(text)
  return new Color(usable ? text : fallback)
}

/* ------------------------------------------------------------ 人偶网格池 */

/** 一个人偶的网格集合：每个零件一块网格，构造时建好复用。 */
interface ActorMesh {
  group: Group
  /** 标准蒙皮体；载入完成前为 undefined，此时继续显示程序化木偶。 */
  standard?: StandardBodyRig
  /** 键来自 `HUMANOID_SPANS` / `HUMANOID_EXTENSIONS` / `HUMANOID_FEET` 的 `key`。 */
  parts: Map<string, Mesh>
  /** 头/手/脚的识别件：鼻、耳、拇指、鞋头。 */
  features: Map<FigureFeature, Mesh>
  /** 膝/肘的木铰链，键来自 `HUMANOID_HINGES`。 */
  hinges: Map<string, Mesh>
  /** 补缝用的关节球，键是关节名。 */
  joints: Map<PoseJoint, Mesh>
  /** 角色名标签。只在 `scene.labels` 为真时可见；`null` 表示还没建过。 */
  label: Sprite | null
  /** 上一次贴在标签上的文字。变了才重建纹理——
   *  每帧新建 canvas 纹理会在拖动时把显存吃满。 */
  labelText: string
  /** 标签纹理的宽高比。`Texture.image` 在 three 的类型里是 `{}`，
   *  从那里读尺寸编译不过；建纹理时顺手记下来更直接。 */
  labelAspect: number
}

/* -------------------------------------------------------------- 面板实现 */

interface StageSceneOptions {
  /**
   * 复用外面创建的渲染器。离屏导出要在一段连续调用里反复画（150 次），
   * 每次新建 WebGLRenderer 都会占一个 GPU 上下文、并把着色器重编一遍。
   */
  renderer?: WebGLRenderer
}

class StageSceneImpl implements StageScene {
  private readonly renderer: WebGLRenderer
  /** 这个渲染器是不是自己建的：只有自己建的才允许丢掉上下文。 */
  private readonly ownRenderer: boolean
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(DIRECTOR_FOV, 1, 0.05, 500)
  private readonly root = new Group()
  private readonly ground = new Group()
  private readonly actorLayer = new Group()
  private readonly propLayer = new Group()
  private readonly cameraLayer = new Group()

  /** 复用的单位几何：半径/边长都是 1，尺寸全靠 scale。 */
  private readonly unitSphere = markShared(new SphereGeometry(1, 16, 12))
  /** 鼻楔：四/六面锥，低模但比一颗球有方向。 */
  private readonly noseGeometry = markShared(new ConeGeometry(1, 1, 6))
  /** 人形零件的几何表。整套只建一次，所有角色共用——见 `stage-humanoid.ts`。 */
  private readonly humanoid: HumanoidGeometry = createHumanoidGeometry()
  private readonly unitBox = markShared(new BoxGeometry(1, 1, 1))
  /**
   * 两套人偶材质。灰白膜是默认；木色保留给「木制人偶」那一版观感。
   * 白膜的粗糙度略高，避免高光把肩/髋的形体打平。
   */
  private readonly bodyMaterials: Readonly<Record<CanvasFigureMaterial, Material>> = {
    clay: markShared(new MeshStandardMaterial({ color: new Color(FIGURE_PALETTES.clay.body), roughness: 0.74, metalness: 0 })),
    wood: markShared(new MeshStandardMaterial({ color: new Color(FIGURE_PALETTES.wood.body), roughness: 0.55, metalness: 0 })),
  }

  private readonly jointMaterials: Readonly<Record<CanvasFigureMaterial, Material>> = {
    clay: markShared(new MeshStandardMaterial({ color: new Color(FIGURE_PALETTES.clay.joint), roughness: 0.68, metalness: 0 })),
    wood: markShared(new MeshStandardMaterial({ color: new Color(FIGURE_PALETTES.wood.joint), roughness: 0.62, metalness: 0 })),
  }
  private readonly propMaterial = markShared(new MeshStandardMaterial({ color: new Color(PROP_COLOR), roughness: 0.92, metalness: 0 }))
  /** 标准体的统一 clay 材质；不读写 GLB 自带的皮肤贴图。 */
  private readonly standardMaterial = markShared(new MeshStandardMaterial({
    color: new Color(FIGURE_PALETTES.clay.body), roughness: 0.68, metalness: 0,
  }))
  private readonly standardClothMaterial = markShared(new MeshStandardMaterial({
    color: new Color(FIGURE_PALETTES.clay.joint), roughness: 0.78, metalness: 0,
  }))
  private readonly cameraMaterial = markShared(new MeshBasicMaterial({ color: new Color(CAMERA_COLOR) }))
  /** 地面板；`sky` 是背景色，`ground` 是地板色，两者都在每帧跟着 stage 变。
   *
   *  材质共享、**几何不共享**：地面尺寸随 `scene.scale` 变，换尺寸时那一块
   * 平面会被重建，旧的那块必须能被正常释放掉。 */
  private readonly groundPlaneMaterial = markShared(new MeshStandardMaterial({ color: new Color('#12141c'), roughness: 1, metalness: 0 }))

  private readonly actors = new Map<string, ActorMesh>()
  private readonly props = new Map<string, Object3D>()
  private readonly cameraMeshes = new Map<string, Mesh>()
  /** 正在加载的 GLB 的键，避免同一份模型每一帧都发一次请求。 */
  private readonly glbLoading = new Set<string>()
  /** 每帧结束后重建：被点选的对象是「这一帧真正在场景里的那些」，不是缓存的一份。 */
  private pickables: Object3D[] = []
  /** 命中测试复用一个 raycaster：每次新建都会重新分配内部数组，而点在拖动
   *  过程中可能一秒调十几次。 */
  private readonly raycaster = new Raycaster()

  private mode: StageViewMode = 'director'
  private size: StageSize = { width: 640, height: 400 }
  private readonly orbitState = { yaw: DIRECTOR_YAW, pitch: DIRECTOR_PITCH, distance: 4.2, target: new Vector3(0, 0.92, 0) }
  private panoTexture: Texture | null = null
  /** 是否已经按第一帧的包围盒取过景。
   *
   *  初始 `distance: 4.2` 只是个占位值；三个角色摆开之后它会框不下。
   *  只在**第一次** render 时自适一次、之后不再动：每帧重算会在用户
   *  刚用滚轮拉近时又把它拉回默认距离，看起来像“滚轮不起作用”。
   *  用户主动「重置视角」仍走 `resetView()`。 */
  private framed = false
  /** 最近一次 render 的 stage。GLB 异步回来时要据此重画一帧。 */
  private lastStage: CanvasPoseStage | undefined
  private disposed = false
  /** 正在等待标准体挂载的任务；导出前 await 它们。 */
  private readonly pendingStandard = new Set<Promise<void>>()
  /** 画布显式声明成字段而不是构造器参数属性：Node 跑 `.ts` 是「只剥类型、
   *  不生成代码」，参数属性要生成 `this.x = x`，属于被 strip-only 明确拒绝的
   *  语法，整个模块连 import 都会失败。 */
  private readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement, options: StageSceneOptions = {}) {
    this.canvas = canvas
    // The CC0 clothing meshes are shrink-wrapped to the body. Without a small
    // normal offset they sit exactly on the skin and lose the depth test to the
    // body mesh. Inflate the garment by 12 mm so the t-shirt/jeans/shoes have
    // their own surface; this also gives the seams a readable thickness.
    this.standardClothMaterial.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  transformed += normalize(objectNormal) * 0.012;',
      )
    }
    this.standardClothMaterial.customProgramCacheKey = () => 'stage-standard-cloth-inflate'
    this.ownRenderer = options.renderer === undefined
    this.renderer = options.renderer ?? new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      // 导出路径 render 之后立刻读像素；没有这个标志时浏览器可能在读取前
      // 已经清空后备缓冲，`toDataURL` 会得到一张透明图。
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(1)
    // 阴影是这个场景里唯一能把人偶“放”在地面上的东西。不开的时候整幅画面
    // 是一层平光，人偶看着像剪贴画贴在天上——上一版的「不咋地」一半来自这里。
    // 类型写死为 PCFSoft：导出要求同一份 stage 两次逐帧一致，而阴影贴图的
    // 采样方式一旦跟随设备变化就会出像素差。
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap

    this.scene.add(this.root)
    this.root.add(this.ground, this.actorLayer, this.propLayer, this.cameraLayer)

    // 固定光照：导出必须逐帧可复现，任何随时间变化的光都会让同一份 stage
    // 在两次导出之间出现像素差。
    //
    // 三层而不是一层：单纯「环境光 + 一盏平行光」会把人偶照成一团平糊的
    // 白——环境光 1.15 把所有暗面抬高，形体全靠轮廓线，看上去像贴纸。
    // 现在环境光只留一点点底，主光负责体积与影子，半球光给上下渐变
    // （天顶亮、地面反光暖），再补一盏冷色背光把剪影从背景里剥离。
    // 灰白膜的反射率比木色高，主光沿用木色时的 2.1 会把胸腹打成一团纯白。
    // 这里把主光压一档、环境光抬一点，让白膜保留体积，同时木色也不会太暗。
    this.scene.add(new AmbientLight(0xffffff, 0.28))
    this.scene.add(new HemisphereLight(0xdfe8ff, 0x2b2f3a, 0.60))

    const key = new DirectionalLight(0xfff6e8, 1.8)
    key.position.set(-3, 6, 4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    // 阴影相机要盖住整个舞台（缩放 100 时约 ±5 世界单位），否则边缘的角色
    // 没有影子、中间的有——那比干脆不开还假。
    key.shadow.camera.left = -7
    key.shadow.camera.right = 7
    key.shadow.camera.top = 7
    key.shadow.camera.bottom = -7
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 26
    key.shadow.bias = -0.0012
    this.scene.add(key)

    const rim = new DirectionalLight(0x9fc4ff, 0.55)
    rim.position.set(4, 3, -5)
    this.scene.add(rim)

    const rect = canvas.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      this.setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    } else {
      this.applySize()
    }
  }

  setSize(size: StageSize): void {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return
    this.size = {
      width: Math.max(2, Math.round(size.width)),
      height: Math.max(2, Math.round(size.height)),
    }
    this.applySize()
  }

  private applySize(): void {
    // `updateStyle = false`：像素尺寸由调用方决定，CSS 尺寸归布局，渲染器
    // 不碰 style（碰了会让面板里的视口在 resize 时抖动）。
    this.renderer.setSize(this.size.width, this.size.height, false)
    this.camera.aspect = this.size.width / this.size.height
    this.camera.updateProjectionMatrix()
  }

  setMode(mode: StageViewMode): void {
    this.mode = mode
    // 机位视角下不该看见「机位自己」——那是从机器的眼睛里往外看。
    this.cameraLayer.visible = mode === 'director'
  }

  orbit(deltaX: number, deltaY: number): void {
    if (this.mode !== 'director') return
    this.orbitState.yaw = (this.orbitState.yaw + deltaX * 0.4) % 360
    this.orbitState.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.orbitState.pitch + deltaY * 0.3))
    this.repaint()
  }

  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    if (this.mode === 'director') {
      this.orbitState.distance = Math.max(0.6, Math.min(80, this.orbitState.distance / factor))
      this.repaint()
      return
    }
    // 机位模式下缩放改视场角，不改机位坐标：那个数在右栏里是用户自己填的，
    // 拖滚轮就把它改掉的话，下次打开属性页会对不上。
    this.camera.fov = Math.max(8, Math.min(95, this.camera.fov / factor))
    this.camera.updateProjectionMatrix()
    this.repaint()
  }

  /**
   * 相机变了就自己重画一帧。
   *
   * WHY：上面这三个手势只改 `orbitState`，而真正把场景画到 canvas 上的是
   * `render(stage)`——它由面板的 effect 驱动，effect 的依赖里没有相机。
   * 不补这一下，拖动时 state 在变、画面一动不动（实测：拖 120px 后
   * `toDataURL` 逐字节相同）。
   */
  private repaint(): void {
    if (this.lastStage !== undefined) this.render(this.lastStage)
  }

  resetView(stage: CanvasPoseStage): void {
    if (this.mode !== 'director') return
    const bounds = stageBounds(stage)
    this.orbitState.target.set(bounds.center[0], bounds.center[1], bounds.center[2])
    // 1.6 而不是贴着包围球算出来的 1.0：角色名标签悬在头顶、还有半个标签宽
    // 探到角色两侧，只按几何包围球取景时最边上那个标签会被视口边缘切掉一半
    // （实测「角色B」只剩「角色」两个字）。留出这段余量比精确取景更有用——
    // 用户要的是「一眼看清谁是谁」，不是「像素利用到最大」。
    this.orbitState.distance = (bounds.radius / Math.tan(DIRECTOR_FOV * Math.PI / 360)) * 1.6
    this.orbitState.yaw = DIRECTOR_YAW
    this.orbitState.pitch = DIRECTOR_PITCH
    this.repaint()
  }

  async ready(): Promise<void> {
    // A loader may attach another actor while this waits; loop until the set is
    // empty rather than taking one snapshot.
    while (this.pendingStandard.size > 0) {
      await Promise.all([...this.pendingStandard])
    }
  }

  setPanorama(image: HTMLImageElement | null): void {
    if (image === null) {
      this.panoTexture?.dispose()
      this.panoTexture = null
      this.scene.background = null
      return
    }
    this.panoTexture?.dispose()
    const texture = new Texture(image)
    // 等距柱状投影：全景图是 2:1 的球面展开，这样贴回球内侧才不接缝。
    texture.mapping = EquirectangularReflectionMapping
    texture.colorSpace = 'srgb'
    texture.needsUpdate = true
    this.panoTexture = texture
    this.scene.background = texture
  }

  render(stage: CanvasPoseStage): void {
    if (this.disposed) return
    this.lastStage = stage
    this.standardMaterial.color = new Color(FIGURE_PALETTES[figureMaterialOf(stage.scene.figure)].body)
    this.standardClothMaterial.color = new Color(
      figureMaterialOf(stage.scene.figure) === 'wood' ? FIGURE_PALETTES.wood.joint : '#8a99ad',
    )
    // 首帧按实际包围盒取景，之后交给用户（滚轮 / 拖拽 / 重置视角）。
    if (!this.framed && this.mode === 'director') {
      this.framed = true
      this.resetView(stage)
    }
    this.syncEnvironment(stage)
    this.syncActors(stage)
    this.syncProps(stage)
    this.syncCameras(stage)
    this.syncCamera(stage)
    this.renderer.render(this.scene, this.camera)
  }

  /** 天空、地面、网格。 */
  private syncEnvironment(stage: CanvasPoseStage): void {
    const scale = scaleFactor(stage.scene)
    // 地面至少铺 12m：一台舞台通常只有几米宽，地面太小会看见它的边，
    // 一眼就露馅「这是两块板」。
    const worldSize = Math.max(12, 40 * scale)

    this.groundPlaneMaterial.color = colorOf(stage.scene.ground, '#12141c')
    if (this.panoTexture === null) {
      this.scene.background = colorOf(stage.scene.sky, '#060608')
    } else {
      this.scene.background = this.panoTexture
      // 全景球水平旋转承担 `panoYaw`：用户转的是环境，不是角色。
      const yaw = (stage.scene.panoYaw ?? 0) * Math.PI / 180
      this.scene.backgroundRotation = new Euler(0, yaw, 0)
    }

    // 尺寸没变就不重建：每帧重建几何会在拖动时掉帧，而这里唯一的变量是缩放。
    const wanted = Math.round(worldSize * 10)
    if (this.ground.userData.size === wanted) return
    disposeSubtree(this.ground)
    this.ground.clear()
    const plane = new Mesh(new PlaneGeometry(worldSize, worldSize), this.groundPlaneMaterial)
    plane.rotation.x = -Math.PI / 2
    plane.position.y = POSE_GROUND_Y
    plane.receiveShadow = true
    this.ground.add(plane)
    const grid = new GridHelper(worldSize, Math.max(8, Math.round(worldSize)), 0x3b4459, 0x282f3d)
    grid.position.y = POSE_GROUND_Y + 0.001
    this.ground.add(grid)
    this.ground.userData.size = wanted
  }

  /** 角色：按 id 建/删，每帧只改变换。 */
  private syncActors(stage: CanvasPoseStage): void {
    const alive = new Set(stage.actors.map(actor => actor.id))
    for (const [id, mesh] of this.actors) {
      if (alive.has(id)) continue
      this.actorLayer.remove(mesh.group)
      disposeSubtree(mesh.group)
      this.actors.delete(id)
    }
    for (const actor of stage.actors) {
      const mesh = this.actors.get(actor.id) ?? this.createActorMesh(actor)
      this.updateActor(mesh, stage, actor)
    }
    this.refreshPickables()
  }

  private createActorMesh(actor: CanvasPoseActor): ActorMesh {
    const group = new Group()
    group.name = actor.id
    const parts = new Map<string, Mesh>()
    const features = new Map<FigureFeature, Mesh>()
    const hinges = new Map<string, Mesh>()
    const joints = new Map<PoseJoint, Mesh>()
    const pick: StagePick = { target: 'actor', id: actor.id }
    const add = (key: string, geometry: BufferGeometry): void => {
      const mesh = new Mesh(geometry, this.bodyMaterials.clay)
      mesh.userData.pick = pick
      // 投影开、接收影也开：深色的关节球落在木身上时，两者之间有一道软阴影，
      // 接缝就不会看着像两块贴片。
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      parts.set(key, mesh)
    }
    for (const span of HUMANOID_SPANS) add(span.key, this.humanoid[span.geometry])
    for (const extension of HUMANOID_EXTENSIONS) add(extension.key, this.humanoid[extension.geometry])
    for (const foot of HUMANOID_FEET) add(foot.key, this.humanoid[foot.geometry])
    for (const sleeve of HUMANOID_SLEEVES) add(sleeve.key, this.humanoid[sleeve.geometry])
    for (const cap of HUMANOID_JOINT_CAPS) {
      const sphere = new Mesh(this.humanoid.joint, this.jointMaterials.clay)
      sphere.userData.pick = pick
      sphere.castShadow = true
      sphere.receiveShadow = true
      group.add(sphere)
      joints.set(cap.joint, sphere)
    }
    for (const hinge of HUMANOID_HINGES) {
      const mesh = new Mesh(this.humanoid.hinge, this.jointMaterials.clay)
      mesh.userData.pick = pick
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      hinges.set(hinge.key, mesh)
    }
    for (const key of FIGURE_FEATURES) {
      const mesh = new Mesh(key === 'nose' ? this.noseGeometry : this.unitSphere, this.bodyMaterials.clay)
      mesh.userData.pick = pick
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      features.set(key, mesh)
    }
    this.actorLayer.add(group)
    const record: ActorMesh = { group, parts, features, hinges, joints, label: null, labelText: '', labelAspect: 3 }
    this.actors.set(actor.id, record)
    void this.attachStandardBody(record, actor)
    return record
  }

  /** 异步挂载 CC0 标准体；失败/未加载时继续显示程序化木偶。 */
  private attachStandardBody(mesh: ActorMesh, actor: CanvasPoseActor): void {
    const task = (async () => {
      try {
        const template = await loadStandardBodyTemplate()
        if (this.disposed || this.actors.get(actor.id) !== mesh) return
        const rig = instantiateStandardBody(
          template, this.standardMaterial, this.standardClothMaterial,
          { target: 'actor', id: actor.id },
        )
        mesh.standard = rig
        mesh.group.add(rig.group)
        this.refreshPickables()
        if (this.lastStage !== undefined) this.render(this.lastStage)
      } catch {
        // The procedural body is already in the scene; a missing asset route or
        // an offline host degrades to the lightweight mannequin.
      }
    })()
    this.pendingStandard.add(task)
    void task.finally(() => { this.pendingStandard.delete(task) })
  }

  /** 只切换零件/特征，不隐藏角色标签。 */
  private setProceduralVisible(mesh: ActorMesh, visible: boolean): void {
    for (const part of mesh.parts.values()) part.visible = visible
    for (const feature of mesh.features.values()) feature.visible = visible
    for (const hinge of mesh.hinges.values()) hinge.visible = visible
    for (const joint of mesh.joints.values()) joint.visible = visible
  }

  /**
   * 把角色名画成一个始终面向相机的 sprite。
   *
   * 2D 版一直有这两个标签（`drawScene` 里的 `paintLabel`），而 3D 版没有——
   * 于是切到 3D 之后画面上不再看得出哪个角色是哪个，而右栏、时间轴、左栏
   * 都还在用名字指代他们。这是**能力缺口**，不是风格差异。
   *
   * 用 canvas 画字而不是 `SpriteMaterial` 的 default 纹理：标签必须随场景缩放
   * 保持可读，文字内容又是运行时的（用户能改名）。
   */
  private updateLabel(mesh: ActorMesh, actor: CanvasPoseActor, visible: boolean): void {
    const text = actor.name ?? ''
    if (!visible || text === '') {
      if (mesh.label !== null) mesh.label.visible = false
      return
    }
    if (mesh.label === null) {
      const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }))
      // 标签不该被场景里的东西遮挡：它是指示，不是实体。
      sprite.renderOrder = 10
      mesh.group.add(sprite)
      mesh.label = sprite
      mesh.labelText = ''
    }
    const sprite = mesh.label
    sprite.visible = true
    if (mesh.labelText !== text) {
      const label = labelTexture(text)
      const previous = sprite.material.map
      sprite.material.map = label.texture
      sprite.material.needsUpdate = true
      // 换掉的那张必须释放，否则改十次名字就漏十张纹理。
      previous?.dispose()
      mesh.labelText = text
      mesh.labelAspect = label.aspect
    }
    // 放在头顶（骨架最高点之上），按标签自身宽高比决定缩放。
    const world = solveRig(actor.rig)
    const top = Math.max(world.head[1], world.neck[1]) + 0.22
    sprite.position.set(world.head[0], top, world.head[2])
    // 高度固定 0.16 个世界单位（大约一个头的宽度），宽度按纹理比例。
    sprite.scale.set(0.16 * mesh.labelAspect, 0.16, 1)
  }

  private updateActor(mesh: ActorMesh, stage: CanvasPoseStage, actor: CanvasPoseActor): void {
    // 场景变换 + 角色站位，与 `actorTransform()` 同一套顺序。
    const sceneScale = scaleFactor(stage.scene)
    const figure = figureMaterialOf(stage.scene.figure)
    const bodyMaterial = this.bodyMaterials[figure]
    const jointMaterial = this.jointMaterials[figure]
    for (const part of mesh.parts.values()) part.material = bodyMaterial
    for (const feature of mesh.features.values()) feature.material = bodyMaterial
    for (const part of mesh.hinges.values()) part.material = jointMaterial
    for (const part of mesh.joints.values()) part.material = jointMaterial
    const rotation = (stage.scene.rotateY ?? 0) + (actor.rotation ?? 0)
    const rad = rotation * Math.PI / 180
    const [tx, ty, tz] = stage.scene.translate
    const rx = actor.x * Math.cos(rad) + actor.z * Math.sin(rad)
    const rz = -actor.x * Math.sin(rad) + actor.z * Math.cos(rad)
    mesh.group.position.set(rx * sceneScale + tx, ty, rz * sceneScale + tz)
    mesh.group.scale.setScalar(sceneScale * (actor.scale ?? 1))
    mesh.group.rotation.set(0, rad, 0)

    const useStandard = bodyOf(stage.scene) === 'standard' && mesh.standard !== undefined
    this.setProceduralVisible(mesh, !useStandard)
    if (mesh.standard !== undefined) {
      mesh.standard.group.visible = useStandard
      if (useStandard) poseStandardBody(mesh.standard, actor.rig)
    }

    // 骨架在角色局部坐标里求解（已落地），不需要再搬一次。
    const world = solveRig(actor.rig)
    const at = (joint: PoseJoint): Vector3 => {
      const p = world[joint]
      return new Vector3(p[0], p[1], p[2])
    }

    for (const cap of HUMANOID_JOINT_CAPS) {
      const sphere = mesh.joints.get(cap.joint)
      if (sphere === undefined) continue
      sphere.position.copy(at(cap.joint))
      // 半径用 `stage-humanoid` 那份表而不是 `JOINT_RADIUS`：球要比相邻管口
      // 略大一点才能盖住弯折时的缝（管口是同宽的，球一口大就刚刚好）。
      sphere.scale.setScalar(cap.radius)
    }

    // 木铰链：轴向取两根骨所在平面的法线，圆柱沿这个轴躺倒。直腿时
    // `cross` 退化为 0，用本地 +X（人体的左右轴）兜底。
    for (const hinge of HUMANOID_HINGES) {
      const part = mesh.hinges.get(hinge.key)
      if (part === undefined) continue
      const center = at(hinge.joint)
      const parent = at(hinge.parent)
      const child = at(hinge.child)
      const axis = hinge.axis === undefined
        ? new Vector3().crossVectors(
            new Vector3().subVectors(parent, center),
            new Vector3().subVectors(child, center),
          )
        : new Vector3(...hinge.axis)
      if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0)
      axis.normalize()
      part.position.copy(center)
      part.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis)
      // `hinge` 几何本身就是单位长度（t=0..1），所以 Y 直接乘长度。
      part.scale.set(hinge.radius, hinge.length, hinge.radius)
    }

    for (const span of HUMANOID_SPANS) {
      const part = mesh.parts.get(span.key)
      if (part !== undefined) alignSpan(part, at(span.from), at(span.to))
    }
    for (const sleeve of HUMANOID_SLEEVES) {
      const part = mesh.parts.get(sleeve.key)
      if (part === undefined) continue
      const from = at(sleeve.from)
      const to = at(sleeve.to)
      const dir = new Vector3().subVectors(to, from)
      const span = Math.min(sleeve.length, dir.length())
      if (span < 1e-6) continue
      dir.normalize()
      alignSpan(part, from, from.clone().addScaledVector(dir, span))
    }
    for (const extension of HUMANOID_EXTENSIONS) {
      const part = mesh.parts.get(extension.key)
      if (part === undefined) continue
      const tail = at(extension.from)
      const away = at(extension.away)
      const dir = new Vector3().subVectors(tail, away)
      if (dir.lengthSq() < 1e-8) dir.set(0, -1, 0)
      dir.normalize()
      alignSpan(part, tail, tail.clone().addScaledVector(dir, extension.length))
    }
    for (const foot of HUMANOID_FEET) {
      const part = mesh.parts.get(foot.key)
      if (part !== undefined) alignFoot(part, at(foot.ankle), at(foot.knee), foot.length)
    }
    this.updateFigureFeatures(mesh, world)
    this.updateLabel(mesh, actor, stage.scene.labels)
  }

  /**
   * 头/手/脚的识别件。
   *
   * 这些不是五官，也不准备做成写实人脸：鼻和耳只负责让「正面」一眼可读，
   * 拇指让手掌不再是一块圆头，鞋头让脚尖有方向。全部用共享单位球缩放，
   * 不新增几何；换材质时和身体一起切。
   */
  private updateFigureFeatures(
    mesh: ActorMesh,
    world: Record<PoseJoint, [number, number, number]>,
  ): void {
    const at = (joint: PoseJoint): Vector3 => new Vector3(...world[joint])
    const forwardOf = (up: Vector3): Vector3 => {
      const forward = Math.abs(new Vector3(0, 0, 1).dot(up)) > 0.98
        ? new Vector3(1, 0, 0)
        : new Vector3(0, 0, 1)
      return forward.addScaledVector(up, -forward.dot(up)).normalize()
    }

    // 头：以颈根到头的方向为上，把鼻放在正面、耳放在两侧。
    const neck = at('neck')
    const headJoint = at('head')
    const headUp = new Vector3().subVectors(headJoint, neck)
    if (headUp.lengthSq() > 1e-8) headUp.normalize()
    else headUp.set(0, 1, 0)
    const headForward = forwardOf(headUp)
    const headSide = new Vector3().crossVectors(headForward, headUp).normalize()
    const headCenter = neck.clone().addScaledVector(headUp, 0.045)
    const headBasis = new Matrix4().makeBasis(headSide, headForward, headUp)

    const nose = mesh.features.get('nose')
    if (nose !== undefined) {
      nose.position.copy(headCenter)
        .addScaledVector(headForward, 0.052)
        .addScaledVector(headUp, -0.008)
      nose.quaternion.setFromRotationMatrix(headBasis)
      // 锥的本地 Y 是前后方向：底面贴着面门，尖端朝前。
      nose.scale.set(0.020, 0.055, 0.022)
    }
    const chin = mesh.features.get('chin')
    if (chin !== undefined) {
      chin.position.copy(headCenter)
        .addScaledVector(headUp, -0.040)
        .addScaledVector(headForward, 0.046)
      chin.quaternion.setFromRotationMatrix(headBasis)
      chin.scale.set(0.034, 0.020, 0.024)
    }
    for (const [key, sign] of [['earL', -1], ['earR', 1]] as const) {
      const ear = mesh.features.get(key)
      if (ear === undefined) continue
      ear.position.copy(headCenter).addScaledVector(headSide, sign * 0.073).addScaledVector(headUp, 0.006)
      ear.quaternion.setFromRotationMatrix(headBasis)
      ear.scale.set(0.010, 0.018, 0.026)
    }

    // 手：沿肘→腕方向放一个拇指楔，朝身体一侧收，读成连指手套。
    for (const [side, elbow, wrist] of [
      ['L', 'elbowL', 'handL'],
      ['R', 'elbowR', 'handR'],
    ] as const) {
      const hand = mesh.features.get(`thumb${side}`)
      if (hand === undefined) continue
      const dir = new Vector3().subVectors(at(wrist), at(elbow))
      if (dir.lengthSq() < 1e-8) dir.set(0, -1, 0)
      dir.normalize()
      const forward = forwardOf(dir)
      const handSide = new Vector3().crossVectors(dir, forward).normalize()
      const basis = new Matrix4().makeBasis(handSide, dir, forward)
      // 拇指朝身体一侧：左手在 -x，内缘是 +x；右手反过来。
      const inward = side === 'L' ? -1 : 1
      hand.position.copy(at(wrist))
        .addScaledVector(dir, 0.035)
        .addScaledVector(handSide, inward * 0.032)
        .addScaledVector(forward, 0.004)
      hand.quaternion.setFromRotationMatrix(basis)
      hand.scale.set(0.016, 0.030, 0.018)
    }

    // 脚：在脚尖加一块扁圆鞋头，让脚掌有明确的前端。
    for (const side of ['L', 'R'] as const) {
      const toe = mesh.features.get(`toe${side}`)
      if (toe === undefined) continue
      const ankle = at(`foot${side}`)
      const knee = at(`knee${side}`)
      const up = new Vector3().subVectors(knee, ankle)
      if (up.lengthSq() < 1e-8) up.set(0, 1, 0)
      up.normalize()
      const forward = forwardOf(up)
      const footSide = new Vector3().crossVectors(forward, up).normalize()
      const basis = new Matrix4().makeBasis(footSide, forward, up)
      toe.position.copy(ankle).addScaledVector(forward, 0.105).addScaledVector(up, -0.002)
      toe.quaternion.setFromRotationMatrix(basis)
      toe.scale.set(0.036, 0.046, 0.022)
    }
  }

  /** 道具：立方体、球体、GLB。 */
  private syncProps(stage: CanvasPoseStage): void {
    const props = stage.props ?? []
    const alive = new Set(props.map(prop => prop.id))
    for (const [id, object] of this.props) {
      if (alive.has(id)) continue
      this.propLayer.remove(object)
      disposeSubtree(object)
      this.props.delete(id)
    }

    for (const prop of props) {
      if (prop.kind === 'glb') {
        this.syncGlb(prop, stage)
        continue
      }
      const wanted = prop.kind
      let mesh = this.props.get(prop.id) as Mesh | undefined
      if (mesh === undefined || mesh.userData.kind !== wanted) {
        if (mesh !== undefined) {
          this.propLayer.remove(mesh)
          disposeSubtree(mesh)
        }
        const geometry = wanted === 'sphere' ? this.unitSphere : this.unitBox
        mesh = new Mesh(geometry, this.propMaterial)
        mesh.userData.kind = wanted
        mesh.userData.pick = { target: 'object', id: prop.id } satisfies StagePick
        this.propLayer.add(mesh)
        this.props.set(prop.id, mesh)
      }
      this.applyPropTransform(mesh, stage, prop)
    }
    this.refreshPickables()
  }

  /** 道具的变换。场景整组变换同样施加在道具上（与角色一致）。 */
  private applyPropTransform(object: Object3D, stage: CanvasPoseStage, prop: CanvasStageProp): void {
    const sceneScale = scaleFactor(stage.scene)
    const sceneRad = (stage.scene.rotateY ?? 0) * Math.PI / 180
    const [tx, ty, tz] = stage.scene.translate
    const rx = prop.x * Math.cos(sceneRad) + prop.z * Math.sin(sceneRad)
    const rz = -prop.x * Math.sin(sceneRad) + prop.z * Math.cos(sceneRad)
    object.position.set(rx * sceneScale + tx, prop.y * sceneScale + ty, rz * sceneScale + tz)
    object.rotation.set(
      (prop.rotateX ?? 0) * Math.PI / 180,
      (prop.rotateY ?? 0) * Math.PI / 180 + sceneRad,
      (prop.rotateZ ?? 0) * Math.PI / 180,
    )
    object.scale.set(
      (prop.scaleX ?? 1) * sceneScale,
      (prop.scaleY ?? 1) * sceneScale,
      (prop.scaleZ ?? 1) * sceneScale,
    )
  }

  /**
   * GLB 道具：异步载入，载入中先放一个占位盒。
   *
   * 加载失败**不抛到渲染循环外**——一个坏模型不该把整块视口变成异常，用户
   * 还要能继续摆别的东西。失败时占位盒留在原地，于是「这个道具没加载出来」
   * 是看得见的，而不是道具凭空消失。
   */
  private syncGlb(prop: CanvasStageProp, stage: CanvasPoseStage): void {
    const url = prop.asset?.url
    const key = `${prop.id}:${url ?? ''}`
    const existing = this.props.get(prop.id)

    if (existing !== undefined && existing.userData.glbKey === key) {
      this.applyPropTransform(existing, stage, prop)
      return
    }

    if (existing === undefined) {
      const placeholder = new Mesh(this.unitBox, this.propMaterial)
      placeholder.userData.kind = 'glb'
      placeholder.userData.glbKey = key
      placeholder.userData.pick = { target: 'object', id: prop.id } satisfies StagePick
      this.propLayer.add(placeholder)
      this.props.set(prop.id, placeholder)
      this.applyPropTransform(placeholder, stage, prop)
    }

    if (url === undefined || url === '' || this.glbLoading.has(key)) return
    // 换了一个模型：旧的那份立刻摘掉，别让占位盒与旧模型叠着。
    this.glbLoading.add(key)
    new GLTFLoader().load(
      url,
      loaded => {
        this.glbLoading.delete(key)
        if (this.disposed) {
          disposeSubtree(loaded.scene)
          return
        }
        /* 回调里**现查**当前状态，不用闭包里捕获的那份 `prop`。
         *
         * 闭包里的是「发起加载那一刻」的位置与 URL。用户在这期间拖动道具或
         * 换模型都很正常，而导出路径是逐帧一次渲染、**没有下一帧来纠正**——
         * 用旧坐标画的那一帧会被原样定格进 mp4。所以：按 id 从最新 stage 里
         * 取出这个道具，取不到（被删了）或 URL 变了（换了模型）就整份丢弃。 */
        const latest = this.lastStage
        const fresh = latest?.props?.find(item => item.id === prop.id)
        const freshKey = `${prop.id}:${fresh?.asset?.url ?? ''}`
        if (latest === undefined || fresh === undefined || freshKey !== key) {
          disposeSubtree(loaded.scene)
          return
        }
        const current = this.props.get(prop.id)
        if (current === undefined || current.userData.glbKey !== key) {
          disposeSubtree(loaded.scene)
          return
        }
        this.propLayer.remove(current)
        disposeSubtree(current)
        const wrapper = new Group()
        wrapper.userData.kind = 'glb'
        wrapper.userData.glbKey = key
        wrapper.userData.pick = { target: 'object', id: prop.id } satisfies StagePick
        // 包一层：GLB 的根节点可能自带变换与动画，直接改它会和包内动画打架。
        wrapper.add(loaded.scene)
        this.propLayer.add(wrapper)
        this.props.set(prop.id, wrapper)
        this.refreshPickables()
        // 位置取**现查**到的那一份，不是闭包里那份。
        this.applyPropTransform(wrapper, latest, fresh)
        this.render(latest)
      },
      undefined,
      () => {
        // 清掉 loading 标记但**不重试**：一个 404 会变成每帧一次请求。
        this.glbLoading.delete(key)
      },
    )
  }

  /** 机位：导演视角下画一个小方块，用户能看见「机器」在哪。 */
  private syncCameras(stage: CanvasPoseStage): void {
    const alive = new Set(stage.cameras.map(camera => camera.id))
    for (const [id, mesh] of this.cameraMeshes) {
      if (alive.has(id)) continue
      this.cameraLayer.remove(mesh)
      disposeSubtree(mesh)
      this.cameraMeshes.delete(id)
    }
    for (const spec of stage.cameras) {
      let mesh = this.cameraMeshes.get(spec.id)
      if (mesh === undefined) {
        mesh = new Mesh(this.unitBox, this.cameraMaterial)
        mesh.scale.set(0.3, 0.2, 0.42)
        mesh.userData.pick = { target: 'camera', id: spec.id } satisfies StagePick
        this.cameraLayer.add(mesh)
        this.cameraMeshes.set(spec.id, mesh)
      }
      mesh.position.set(spec.x, spec.y, spec.z)
      mesh.lookAt(spec.targetX, spec.targetY, spec.targetZ)
    }
  }

  /** 相机本身：director 用环绕，camera 用 stage 的当前机位。 */
  private syncCamera(stage: CanvasPoseStage): void {
    if (this.mode === 'camera') {
      const spec = currentCamera(stage)
      this.camera.position.set(spec.x, spec.y, spec.z)
      this.camera.fov = Math.max(8, Math.min(95, spec.fov))
      this.camera.updateProjectionMatrix()
      this.camera.lookAt(spec.targetX, spec.targetY, spec.targetZ)
      return
    }
    const { yaw, pitch, distance, target } = this.orbitState
    const yawRad = yaw * Math.PI / 180
    const pitchRad = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)) * Math.PI / 180
    const horizontal = Math.cos(pitchRad) * distance
    this.camera.position.set(
      target.x + Math.sin(yawRad) * horizontal,
      target.y + Math.sin(pitchRad) * distance,
      target.z + Math.cos(yawRad) * horizontal,
    )
    this.camera.fov = DIRECTOR_FOV
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(target)
  }

  private refreshPickables(): void {
    this.pickables = [
      ...this.actorLayer.children,
      ...this.propLayer.children,
      ...this.cameraLayer.children,
    ]
  }

  pick(x: number, y: number): StagePick | null {
    const rect = this.canvas.getBoundingClientRect()
    const width = rect.width > 0 ? rect.width : this.size.width
    const height = rect.height > 0 ? rect.height : this.size.height
    if (width <= 0 || height <= 0) return null
    this.raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera)
    for (const hit of this.raycaster.intersectObjects(this.pickables, true)) {
      // 命中点可能是骨架里的一颗球，沿父链往上找带 pick 标记的那一层。
      let node: Object3D | null = hit.object
      while (node !== null) {
        const pick = node.userData.pick as StagePick | undefined
        if (pick !== undefined) return pick
        node = node.parent
      }
    }
    return null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    disposeSubtree(this.scene)
    this.unitSphere.dispose()
    this.noseGeometry.dispose()
    disposeHumanoidGeometry(this.humanoid)
    this.unitBox.dispose()
    this.bodyMaterials.clay.dispose()
    this.bodyMaterials.wood.dispose()
    this.jointMaterials.clay.dispose()
    this.jointMaterials.wood.dispose()
    this.propMaterial.dispose()
    this.standardMaterial.dispose()
    this.standardClothMaterial.dispose()
    this.cameraMaterial.dispose()
    this.groundPlaneMaterial.dispose()
    this.panoTexture?.dispose()
    if (this.ownRenderer) {
      this.renderer.dispose()
      // 不丢上下文的话，反复开关面板会撞上浏览器的「Too many active WebGL
      // contexts」，最后几个面板直接黑屏。
      this.renderer.forceContextLoss()
    }
  }
}

/**
 * 建一个渲染面板。`canvas` 必须已经在 DOM 里（尺寸取自它的 bounding rect）。
 *
 * 失败方式：WebGL 不可用时**抛错**而不是返回一个空壳。调用方据此显示
 * 「这台机器开不了 3D」的提示——静默降级成一屏黑会让用户以为是自己操作错。
 */
export function createStageScene(canvas: HTMLCanvasElement): StageScene {
  if (!stageSceneSupported()) {
    throw new Error('WebGL is not available in this browser, so the director desk cannot render 3D')
  }
  return new StageSceneImpl(canvas)
}

/* -------------------------------------------------------------- 离屏导出 */

/**
 * 导出的离屏场景缓存。
 *
 * 一次导出会调用 `renderStageToDataUrl` 150 次（5 秒 × 30fps）。每次都新建
 * WebGLRenderer 会：① 每次占一个 GPU 上下文（浏览器上限约 16 个，超了会丢掉
 * 最早那个，最后一个都画不出来）；② 每次重编一遍着色器。所以在尺寸不变时
 * 复用同一个实例——它的几何池与材质本来就是为「逐帧只改变换」设计的。
 *
 * 空闲一会儿自动释放：导出结束后没人再调，就把上下文还给浏览器。
 */
let exportScene: { scene: StageSceneImpl; renderer: WebGLRenderer; canvas: HTMLCanvasElement; width: number; height: number } | undefined
let exportIdleTimer: ReturnType<typeof setTimeout> | undefined
/** 空闲多久后释放。够跨过一次连续导出（帧间隔通常 < 200ms），也够放过一次
 *  用户「导完看看再导一次」的间隔。 */
const EXPORT_IDLE_MS = 5000

function releaseExportScene(): void {
  if (exportIdleTimer !== undefined) {
    clearTimeout(exportIdleTimer)
    exportIdleTimer = undefined
  }
  if (exportScene === undefined) return
  exportScene.scene.dispose()
  exportScene.renderer.dispose()
  exportScene.renderer.forceContextLoss()
  exportScene = undefined
}

function exportContext(width: number, height: number): typeof exportScene & object {
  if (exportScene !== undefined && exportScene.width === width && exportScene.height === height) {
    return exportScene
  }
  releaseExportScene()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // 导出不需要抗锯齿：输出是给模型看的参考帧，边缘柔和反而糊；而且 MSAA
  // 在每个 GPU 驱动上的采样模式不完全一致，会让「同一份 stage 两次导出
  // 逐像素相同」这条性质变得不可靠。
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  // 导出路径也开阴影，否则导出图比视口里少一层接地影——用户看到的两张图
  // 不一致。`StageSceneImpl` 里已经设了 `shadowMap.type`，这里只负责打开。
  renderer.shadowMap.enabled = true
  const scene = new StageSceneImpl(canvas, { renderer })
  exportScene = { scene, renderer, canvas, width, height }
  return exportScene
}

/**
 * 把某一刻的场景渲染成一张离屏 PNG 的 data URL。
 *
 * 与面板共用同一个渲染器实现，但用独立的 WebGL 上下文与离屏画布：导出时
 * 面板可能正被滚出视野或已卸载，而导出的画面必须是确定的那一帧。
 *
 * `width/height` 是输出像素尺寸；`pano` 是已加载完的全景图（可选）。
 */
export async function renderStageToDataUrl(
  stage: CanvasPoseStage,
  options: { width: number; height: number; pano?: HTMLImageElement | null },
): Promise<string> {
  const width = Math.max(2, Math.round(options.width))
  const height = Math.max(2, Math.round(options.height))
  const context = exportContext(width, height)
  // 导出永远是「当前机位看到的那一帧」，不是导演视角。
  context.scene.setMode('camera')
  if (options.pano !== undefined) context.scene.setPanorama(options.pano)
  context.scene.setSize({ width, height })
  context.scene.render(stage)
  // First render starts the async standard-body load; wait for it before
  // reading pixels, otherwise the first frame of an export is the mannequin.
  await context.scene.ready()
  context.scene.render(stage)
  const url = context.canvas.toDataURL('image/png')
  if (exportIdleTimer !== undefined) clearTimeout(exportIdleTimer)
  exportIdleTimer = setTimeout(releaseExportScene, EXPORT_IDLE_MS)
  return url
}

/**
 * 这个环境能不能跑 3D。
 *
 * 单独暴露是因为它在**建渲染器之前**就要问：WebGL 不可用时面板应该显示
 * 一句说明，而不是先建再捕获异常、闪一下黑屏。探测完立刻释放探测用的
 * 上下文，不要留下一个占着 GPU 槽位的空 canvas。
 */
export function stageSceneSupported(): boolean {
  if (typeof document === 'undefined') return false
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl === null) return false
    // 显式丢掉探测上下文：面板每次打开都会问一次，不丢的话十几次之后就
    // 真的建不出渲染器了。
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  } finally {
    canvas?.remove()
  }
}

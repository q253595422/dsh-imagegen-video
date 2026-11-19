/**
 * 标准蒙皮人形：CC0 MakeHuman/CharacterCreator 底模 + 简单服装。
 *
 * 这套资产是 53 骨、带 92 个 morph 的 `game_engine` 骨架，和程序化木偶是
 * 两条完全不同的路线：
 *
 *  - 木偶是放样几何，轻、无资产、没有脸和手指；适合 blocking 和 2D 回退。
 *  - 标准体是真正的蒙皮网格，有脸、手指、鞋，观感接近 LibTV 那种白膜。
 *
 * 这里只做**方向重定向**：用 `pose-rig` 的 17 个关节位置作为目标方向，把
 * 53 骨里的主骨逐根 aim 过去。手指/面部保持 rest，不假装做了面部捕捉。
 *
 * 资产 GLB 的 morph 默认全是 1，必须在实例化时归零，再把 `gender_male`
 * 置 1；否则身体会被 92 个形变叠加成一团。
 */

import {
  Bone, Group, Mesh, Quaternion, SkinnedMesh, Vector3,
  type Material, type Object3D,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STAGE_ASSETS_API, type CanvasPoseRig } from '../../protocol.ts'
import { footFrame, solveRig, type PoseJoint } from './pose-rig.ts'
import { cloneSkinned } from './skinned-clone.ts'

const ASSET_NAMES = [
  'base-body.glb',
  'clothing-tshirt.glb',
  'clothing-jeans.glb',
  'clothing-shoes.glb',
] as const

export interface StandardBodyTemplate {
  /** base body first, then the clothing layers. */
  scenes: Group[]
}

export interface StandardBodyRig {
  group: Group
  baseBones: Map<string, Bone>
  clothingBones: Map<string, Bone>[]
  rest: Map<Bone, Quaternion>
  clothingRest: Map<Bone, Quaternion>
  /** The base body's rest pelvis height, in metres. */
  pelvisY: number
}

let templatePromise: Promise<StandardBodyTemplate> | undefined

/** A broken asset route must degrade to the mannequin, not hang the first export. */
const ASSET_LOAD_TIMEOUT_MS = 5000

function loadWithTimeout(loader: GLTFLoader, url: string): Promise<{ scene: Group }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`standard body asset timed out: ${url}`)), ASSET_LOAD_TIMEOUT_MS)
    loader.load(
      url,
      gltf => {
        clearTimeout(timer)
        resolve({ scene: gltf.scene as Group })
      },
      undefined,
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Load the four CC0 GLBs once per client bundle. */
export function loadStandardBodyTemplate(): Promise<StandardBodyTemplate> {
  if (templatePromise !== undefined) return templatePromise
  const loader = new GLTFLoader()
  templatePromise = Promise.all(ASSET_NAMES.map(name => loadWithTimeout(loader, `${STAGE_ASSETS_API}/${name}`)))
    .then(list => ({ scenes: list.map(item => item.scene) }))
    .catch(error => {
      // A failed load must be retryable: a transient 404 or a host without the
      // asset route should not poison every later actor in this page.
      templatePromise = undefined
      throw error
    })
  return templatePromise
}

/** The GLBs ship every morph target at 1; reset them, then select the male body. */
function applyMaleMorph(mesh: Mesh | SkinnedMesh): void {
  const influences = mesh.morphTargetInfluences
  if (influences === undefined) return
  influences.fill(0)
  const male = mesh.morphTargetDictionary?.gender_male
  if (male !== undefined) influences[male] = 1
}

function collectBones(root: Object3D): Map<string, Bone> {
  const bones = new Map<string, Bone>()
  root.traverse(object => {
    if ((object as Bone).isBone) bones.set(object.name, object as Bone)
  })
  return bones
}

/**
 * Clone one actor's body + clothing.
 *
 * Every clone gets its own geometry because `disposeSubtree` disposes a removed
 * actor's geometry; sharing the template's buffers would blank every other
 * actor when one of them was deleted. The material is shared on purpose — it is
 * marked `shared` and disposed by the stage scene.
 */
export function instantiateStandardBody(
  template: StandardBodyTemplate,
  material: Material,
  clothingMaterial: Material,
  pick: { target: 'actor'; id: string },
): StandardBodyRig {
  const group = new Group()
  const boneMaps: Map<string, Bone>[] = []
  for (const source of template.scenes) {
    const clone = cloneSkinned(source) as Group
    clone.traverse(object => {
      const mesh = object as Mesh
      if (mesh.isMesh !== true && (object as SkinnedMesh).isSkinnedMesh !== true) return
      // A slightly darker clay for the garments makes the t-shirt/jeans seams
      // readable without turning the standard body into a clothed avatar.
      mesh.material = mesh.name.startsWith('Cloth_') ? clothingMaterial : material
      mesh.geometry = mesh.geometry.clone()
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.userData.pick = pick
      applyMaleMorph(mesh)
    })
    boneMaps.push(collectBones(clone))
    group.add(clone)
  }
  group.updateMatrixWorld(true)

  const baseBones = boneMaps[0] ?? new Map<string, Bone>()
  const clothingBones = boneMaps.slice(1)
  const rest = new Map<Bone, Quaternion>()
  for (const bone of baseBones.values()) rest.set(bone, bone.quaternion.clone())
  const clothingRest = new Map<Bone, Quaternion>()
  for (const bones of clothingBones) {
    for (const bone of bones.values()) clothingRest.set(bone, bone.quaternion.clone())
  }
  const pelvis = baseBones.get('pelvis')
  const pelvisY = pelvis === undefined ? 0.874 : pelvis.getWorldPosition(new Vector3()).y
  return { group, baseBones, clothingBones, rest, clothingRest, pelvisY }
}

/**
 * Drive the 53-bone rig from the 17-joint pose.
 *
 * `world` is solved with `facing: 0` on purpose: the standard group itself is
 * rotated by `facing`, and target directions are local to that group. Solving
 * with facing and also rotating the group would turn the model twice.
 */
export function poseStandardBody(
  rig: StandardBodyRig,
  pose: CanvasPoseRig,
): void {
  const world = solveRig({ ...pose, facing: 0 })
  const boneMaps = [rig.baseBones, ...rig.clothingBones]
  for (const [bone, rest] of rig.rest) bone.quaternion.copy(rest)
  for (const [bone, rest] of rig.clothingRest) bone.quaternion.copy(rest)

  const facing = (pose.facing ?? 0) * Math.PI / 180
  rig.group.position.set(world.hips[0], world.hips[1] - rig.pelvisY, world.hips[2])
  rig.group.rotation.set(0, facing, 0)
  rig.group.updateMatrixWorld(true)
  const groupQ = new Quaternion()
  rig.group.getWorldQuaternion(groupQ)

  const jointDir = (from: PoseJoint, to: PoseJoint): Vector3 => {
    const a = new Vector3(...world[from])
    const b = new Vector3(...world[to])
    return b.sub(a).normalize()
  }
  const aim = (bones: Map<string, Bone>, boneName: string, childName: string, targetLocal: Vector3): void => {
    const bone = bones.get(boneName)
    const child = bones.get(childName)
    if (bone === undefined || child === undefined || bone.parent === null) return
    bone.updateWorldMatrix(true, false)
    child.updateWorldMatrix(true, false)
    const from = bone.getWorldPosition(new Vector3())
    const to = child.getWorldPosition(new Vector3())
    const restDir = to.sub(from)
    if (restDir.lengthSq() < 1e-8) return
    restDir.normalize()
    const target = targetLocal.clone().applyQuaternion(groupQ)
    if (target.lengthSq() < 1e-8) return
    target.normalize()
    const turn = new Quaternion().setFromUnitVectors(restDir, target)
    const worldQ = bone.getWorldQuaternion(new Quaternion())
    const parentQ = bone.parent.getWorldQuaternion(new Quaternion())
    bone.quaternion.copy(parentQ.invert().multiply(turn.multiply(worldQ)))
    bone.updateWorldMatrix(true, false)
  }

  // Pose the body and each garment skeleton independently. The clothing GLBs
  // have their own rest rolls; copying the body bone's local quaternion would
  // twist or collapse the garment even though the names match.
  for (const bones of boneMaps) {
    // Torso first: the arm/leg targets are directions, but they should be read
    // after the torso has turned.
    aim(bones, 'spine_01', 'spine_02', jointDir('hips', 'spine'))
    aim(bones, 'spine_03', 'neck_01', jointDir('chest', 'neck'))
    aim(bones, 'neck_01', 'head', jointDir('neck', 'head'))

    // GLB's `_l` is the character's left (+X); our `L` is the viewer's left
    // (-X). The names are mirrored, so the mapping is deliberately swapped.
    for (const [glbSide, ourSide] of [['l', 'R'], ['r', 'L']] as const) {
      aim(bones, `upperarm_${glbSide}`, `lowerarm_${glbSide}`, jointDir(`shoulder${ourSide}`, `elbow${ourSide}`))
      aim(bones, `lowerarm_${glbSide}`, `hand_${glbSide}`, jointDir(`elbow${ourSide}`, `hand${ourSide}`))
      aim(bones, `hand_${glbSide}`, glbSide === 'l' ? 'index_01_l' : 'index_01_r', jointDir(`elbow${ourSide}`, `hand${ourSide}`))
      aim(bones, `thigh_${glbSide}`, `calf_${glbSide}`, jointDir(`hip${ourSide}`, `knee${ourSide}`))
      aim(bones, `calf_${glbSide}`, `foot_${glbSide}`, jointDir(`knee${ourSide}`, `foot${ourSide}`))
      const foot = footFrame(world[`foot${ourSide}`], world[`knee${ourSide}`])
      aim(bones, `foot_${glbSide}`, `ball_${glbSide}`, new Vector3(...foot.forward))
    }
  }
  rig.group.updateMatrixWorld(true)
}


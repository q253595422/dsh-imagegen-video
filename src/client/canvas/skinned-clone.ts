/**
 * Clone an Object3D subtree and rebind every SkinnedMesh to the cloned bones.
 *
 * `Object3D.clone()` copies the hierarchy but leaves a SkinnedMesh pointing at
 * the original Skeleton. three ships `SkeletonUtils.clone()` for this, but
 * importing that examples module makes `tsc` analyze its large JSDoc surface on
 * every run (measured: typecheck 8s -> 12min). This is the same algorithm,
 * narrowed to what the stage GLBs use.
 */

import type { Bone, Object3D, SkinnedMesh } from 'three'

function parallelTraverse(source: Object3D, clone: Object3D, visit: (source: Object3D, clone: Object3D) => void): void {
  visit(source, clone)
  for (let index = 0; index < source.children.length; index += 1) {
    parallelTraverse(source.children[index]!, clone.children[index]!, visit)
  }
}

export function cloneSkinned(source: Object3D): Object3D {
  const sourceToClone = new Map<Object3D, Object3D>()
  const cloneToSource = new Map<Object3D, Object3D>()
  const clone = source.clone(true)

  parallelTraverse(source, clone, (sourceNode, clonedNode) => {
    cloneToSource.set(clonedNode, sourceNode)
    sourceToClone.set(sourceNode, clonedNode)
  })

  clone.traverse(node => {
    if ((node as SkinnedMesh).isSkinnedMesh !== true) return
    const clonedMesh = node as SkinnedMesh
    const sourceMesh = cloneToSource.get(node) as SkinnedMesh | undefined
    if (sourceMesh === undefined) return
    const skeleton = sourceMesh.skeleton.clone()
    skeleton.bones = sourceMesh.skeleton.bones.map(bone => (sourceToClone.get(bone) ?? bone) as Bone)
    clonedMesh.bind(skeleton, sourceMesh.bindMatrix)
  })
  return clone
}

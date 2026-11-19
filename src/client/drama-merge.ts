/**
 * 把一次铺板结果合并进画布节点表。
 *
 * WHY 单独一个纯函数：这段逻辑曾经写在 React 的 `mutate` 回调里，用「先按
 * id 排除再追加」的写法，而重铺时 `placed` 复用的正是旧 id——于是旧节点被
 * 排除、新节点没被追加，重铺一次把 4 个设定板节点整个弄丢了。用例只测
 * `placeDrama` 返回啥，测不到「合并进画布之后还剩啥」，所以缺陷一路走到
 * 真机。放在这里就能直接喂两张节点表断言结果。
 */

import type { CanvasConnection, CanvasNode } from '../protocol.ts'

/** 一次合并要用的：画布现状 + 这次铺出来的 + 之前找回来的旧板。 */
export interface MergeDramaInput {
  previous: { nodes: readonly CanvasNode[], connections: readonly CanvasConnection[] }
  placed: { boardNode: CanvasNode, imageNodes: readonly CanvasNode[], castNodes: readonly CanvasNode[], connections: readonly CanvasConnection[] }
  /** 同一集的旧板与旧附件；首次铺板时为 `undefined`。 */
  existing?: {
    board: CanvasNode
    imageNodes: Map<string, CanvasNode>
    castNodes: Map<string, CanvasNode>
    connections: readonly CanvasConnection[]
  }
}

/**
 * 首次铺板：新节点追加到末尾。
 *
 * 不重排、不动其他节点——用户手上的版面不该因为一次铺板而变动。
 */
function mergeFresh(input: MergeDramaInput): { nodes: CanvasNode[], connections: CanvasConnection[] } {
  const { previous, placed } = input
  const nodes = [...previous.nodes, placed.boardNode, ...placed.imageNodes, ...placed.castNodes]
  const known = new Set(nodes.map(node => node.id))
  const connections = [
    ...previous.connections,
    ...placed.connections.filter(edge => known.has(edge.fromNodeId) && known.has(edge.toNodeId)),
  ]
  return { nodes, connections }
}

/**
 * 重铺：旧板与旧附件原地换内容，文档删掉的条目跟着消失。
 *
 * 合并规则一句话：**旧节点表逐个走，能在新结果里找到同名 id 的换成新内容，
 * 找不到的先留住；只有「上一版铺出来的附件、这次文档里已经没有」才删**。
 * 这样用户在这套节点上做的（跑出来的图、摆的位置、钉住的身份）全部保留。
 */
function mergeReuse(input: MergeDramaInput & { existing: NonNullable<MergeDramaInput['existing']> }): { nodes: CanvasNode[], connections: CanvasConnection[] } {
  const { previous, placed, existing } = input
  const fresh = new Map<string, CanvasNode>()
  for (const node of [...placed.imageNodes, ...placed.castNodes]) fresh.set(node.id, node)
  const oldAttachmentIds = new Set([
    ...[...existing.imageNodes.values()].map(node => node.id),
    ...[...existing.castNodes.values()].map(node => node.id),
  ])
  const nodes: CanvasNode[] = []
  for (const node of previous.nodes) {
    if (node.id === existing.board.id) {
      nodes.push(placed.boardNode)
      continue
    }
    const replacement = fresh.get(node.id)
    if (replacement !== undefined) {
      nodes.push(replacement)
      fresh.delete(node.id)
      continue
    }
    // 上一版铺出来、这次文档里已经没有的附件：不留，铺板结果才等于文档。
    if (oldAttachmentIds.has(node.id)) continue
    nodes.push(node)
  }
  // 文档这次新增的条目。
  nodes.push(...fresh.values())
  const ids = new Set(nodes.map(node => node.id))
  // 旧板的连线全不要（附件可能被文档删了），新板的重新连。
  const untouched = previous.connections.filter(edge =>
    edge.fromNodeId !== existing.board.id
    && edge.toNodeId !== existing.board.id
    && !existing.connections.some(old => old.id === edge.id))
  const connections = [
    ...untouched,
    ...placed.connections.filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)),
  ]
  return { nodes, connections }
}

/**
 * 一次铺板结果落到画布上。
 *
 * @param input - 画布现状、这次铺出的节点、以及（重铺时）找回的旧板。
 * @returns 新的节点表与连线表；调用方整体写回，算一条撤销记录。
 */
export function mergeDramaPlacement(input: MergeDramaInput): { nodes: CanvasNode[], connections: CanvasConnection[] } {
  return input.existing === undefined ? mergeFresh(input) : mergeReuse({ ...input, existing: input.existing })
}

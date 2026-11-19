/**
 * 重铺同一集时，怎么处理画布上已有的那套节点。
 *
 * 铺板是幂等的：同一部剧的同一集再铺一次，该**更新**原来那块板，而不是在
 * 画布上叠第二块 22 镜的板——用户的片段、排过的手工位置、跑过的图都在原来
 * 那套节点上，叠一份新的等于把它们变成孤儿。
 *
 * 判等只看 `storyboard.source.projectPath`（相对工作区的剧集目录），不看
 * 标题：标题用户可以改，也可能同时铺两集。
 *
 * 附件按**文档条目**对齐，不是「上一次铺的全带走」：
 *  - `IMG-…` 待填节点认标题里的编号（`IMG-OFFICE-PLATE · 两处办公室场景板`）；
 *  - 参考图（cast）认 `asset.originId`，那是导入时写下的项目相对路径。
 * 这样文档里删掉的条目会跟着消失，重铺结果始终等于文档，而不是越铺越多。
 *
 * 这里刻意全是纯函数：找回哪块板、哪些节点能接管，都是「看一眼节点表就能
 * 定」的事，不该混进布局计算或 React 状态，否则 Node 侧测不到。
 */

import type { CanvasConnection, CanvasNode, CanvasStoryboardSource } from '../protocol.ts'

/** 一块已铺出来的板，以及这次重铺可以原地接管的旧节点。 */
export interface ExistingDramaBoard {
  /** 原来那块板（用它的 id 原地更新，位置也跟着它，不跳到视口中心）。 */
  board: CanvasNode
  /**
   * 上一版可以接管的附件节点，`id` 供调用方对比「这次还要不要」。
   *
   * 分两路是因为两路身份来源不同：`IMG-…` 只有标题，参考图有路径。
   */
  imageNodes: Map<string, CanvasNode>
  castNodes: Map<string, CanvasNode>
}

/**
 * 在现有节点里找出「同一集」的那块板。
 *
 * 只认带 `metadata.storyboard.source` 的板：用户在画布上手画的分镜板没有
 * 这个标记，绝不能因为标题碰巧相同就被当成可覆盖的目标。
 */
export function findExistingDramaBoard(
  nodes: readonly CanvasNode[],
  source: CanvasStoryboardSource | undefined,
): CanvasNode | undefined {
  if (source === undefined) return undefined
  return nodes.find(node => {
    if (node.type !== 'storyboard') return false
    const origin = node.metadata?.storyboard?.source
    return origin !== undefined && origin.projectPath === source.projectPath
  })
}

/**
 * 标题里 `IMG-…` 的编号。
 *
 * 铺板写下的标题形如 `IMG-OFFICE-PLATE · 两处办公室场景板`，也可能是
 * 没有名字的裸编号 `IMG-OFFICE-PLATE`。只取编号部分做键，名字改了也还认得。
 */
export function imageIdOfTitle(title: string): string | undefined {
  const head = title.split('·')[0]?.trim() ?? ''
  return /^IMG-[A-Za-z0-9_-]+$/.test(head) ? head : undefined
}

/**
 * 把小节判等出来的旧附件收成两张表。
 *
 * @param nodes - 当前画布的全部节点。
 * @param connections - 当前画布的全部连线；用来兜住老版本铺出的、只靠连线
 *   挂在板上而没有来源标记的设定板。
 * @param board - {@link findExistingDramaBoard} 找回的板。
 * @param source - 这次要铺的那一集的来源（判等用）。
 */
export function reuseTargetsOf(input: {
  nodes: readonly CanvasNode[]
  connections: readonly CanvasConnection[]
  board: CanvasNode
  source: CanvasStoryboardSource | undefined
}): { imageNodes: Map<string, CanvasNode>, castNodes: Map<string, CanvasNode> } {
  const { nodes, connections, board, source } = input
  const imageNodes = new Map<string, CanvasNode>()
  const castNodes = new Map<string, CanvasNode>()
  // 老版本铺板没有 source 标记，但它把设定板连线挂在板上；这条线也能证明
  // 「这张是我铺的」，所以一并认。
  const linked = new Set(connections.filter(edge => edge.toNodeId === board.id).map(edge => edge.fromNodeId))
  for (const node of nodes) {
    if (node.id === board.id || node.type !== 'image') continue
    const path = node.metadata?.asset?.originId
    // 参考图：路径是导入时写下的项目相对路径，最可靠的一路。
    if (node.metadata?.cast !== undefined && path !== undefined) {
      castNodes.set(path, node)
      continue
    }
    const imageId = imageIdOfTitle(node.title)
    if (imageId !== undefined && (linked.has(node.id) || node.metadata?.prompt !== undefined)) {
      imageNodes.set(imageId, node)
      continue
    }
    // 兜底：来源路径空着（老数据）但明确挂在板上、又带着 source 标记，
    // 也按「上一版铺的设定板」接管，避免老文档重铺时叠出一份。
    if (source !== undefined && linked.has(node.id) && imageId !== undefined) imageNodes.set(imageId, node)
  }
  return { imageNodes, castNodes }
}

/** 一次重铺要接管的整套旧节点。 */
export interface DramaReuse extends ExistingDramaBoard {
  /** 旧板、旧附件之间的连线：重铺时整批换掉，不沿用。 */
  connections: CanvasConnection[]
}

/**
 * 找出同一集的旧板与它名下可接管的附件。
 *
 * 分成两步（先找板、再收附件）是因为附件判定要读整张连线表；收在一个函数里
 * 让调用方少踩一次「忘了传 connections」的坑。
 */
export function existingDramaBoardOf(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  source: CanvasStoryboardSource | undefined,
): DramaReuse | undefined {
  const board = findExistingDramaBoard(nodes, source)
  if (board === undefined) return undefined
  const { imageNodes, castNodes } = reuseTargetsOf({ nodes, connections, board, source })
  const kept = new Set([
    board.id,
    ...[...imageNodes.values(), ...castNodes.values()].map(node => node.id),
  ])
  return {
    board,
    imageNodes,
    castNodes,
    connections: connections.filter(edge => kept.has(edge.fromNodeId) && kept.has(edge.toNodeId)),
  }
}

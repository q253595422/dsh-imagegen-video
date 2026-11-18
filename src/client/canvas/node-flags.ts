/**
 * 节点的两个开关：锁定与隐藏。
 *
 * 两个字段都住在 `node.metadata` 里（`locked` / `hidden`），所以老文档读出来
 * 就是「没锁、没藏」，不需要迁移。这个模块只回答「这张卡现在算不算在画面
 * 上」「这组 id 里哪些动得了」「文档里藏了几张」——不写文档、不碰 DOM。
 *
 * WHY 单独一层而不是让每个调用方自己 `node.metadata?.hidden === true`：隐藏
 * 一旦漏在某一处（框选、⌘A、连线、删除前的确认），症状都极其安静——要么
 * 看不见的卡片还能被框住，要么画面空着却提示「已选中 1 项」。把判断收在
 * 这里，漏掉的地方就只剩「没调用它」这一种形态，review 时看得出来。
 *
 * **`visibleNodes` 与 `visibleConnections` 必须一起用。** 只过滤节点会留下
 * 通往空气的线：一端已经不见了，线还从原来的坐标画出来，用户看到的是画布
 * 上多了一条谁都不连的线，比整条线不画更困惑。反过来只过滤线也不够——被
 * 藏起来的卡片仍然占着位置、仍然能被选中。
 *
 * 纯函数，Node 里能直接 import（`scripts/smoke-canvas-node-flags.mjs`）。
 */

import type { CanvasNode } from '../../protocol.ts'

/**
 * 这张卡锁了吗。
 *
 * 只有严格的 `true` 算锁：`undefined`（老文档）、`false`、以及任何被外部
 * 写坏的假值都是「没锁」。锁是给人踩刹车用的，读错方向的代价（一张其实
 * 没锁的卡突然拖不动）比多判一层大。
 *
 * 收在这里而不是让每处写 `metadata?.locked === true`：将来锁的判定若要从
 * 单张扩到「分组整体锁定」，只改这一个函数，而不是逐个调用方去找。
 */
export const isLocked = (node: CanvasNode): boolean => node.metadata?.locked === true

/**
 * 这张卡藏了吗。
 *
 * 与 `isLocked` 同一套读法。隐藏只是「暂时别看」，节点本身仍在 `nodes`
 * 里，所以这里做的是过滤而不是删除。判定收在这一处，框选、渲染、⌘A 才不
 * 会各自漏掉一种节点类型。
 */
export const isHidden = (node: CanvasNode): boolean => node.metadata?.hidden === true

/**
 * 画面上的节点：隐藏的那些不在里面。渲染、框选、⌘A 都读这一份。
 *
 * 返回**新数组**，但不复制节点对象——`layer-order.ts` 同一条纪律：调用方
 * 拿 `===` 判断「这一项还是不是原来那张卡」是成立的（比如它用引用作 key、
 * 或缓存了某张卡的 DOM 测量结果）。复制对象会让这些缓存全部静默失配。
 *
 * 没有隐藏项时返回**入参本身**，让 React 的 memo / `useMemo` 依赖能靠引用
 * 相等跳过重算；一张都没藏的画布是绝大多数时刻的常态。
 *
 * 只过滤节点不够：指向隐藏节点的连线仍会画出来，必须同时用
 * `visibleConnections`。
 *
 * 收在这里而不是每个渲染/选区入口各写一次 `filter`：漏掉一处的表现是
 * 「藏起来的卡还能被框住」，不崩、不报错，只有用户会撞见。
 */
export function visibleNodes(nodes: readonly CanvasNode[]): CanvasNode[] {
  // 只读数组转成可变类型是为了沿用原数组：画布传进来的本来就是普通数组，
  // 而复制一份再返回就丢掉了引用相等。
  if (!nodes.some(isHidden)) return nodes as CanvasNode[]
  return nodes.filter(node => !isHidden(node))
}

/**
 * 把 ids 里锁定的那些剔掉。拖动、删除、对齐都先过这一道。
 *
 * WHAT 这一层做：以**节点当前状态**为准判断锁定，而不是相信调用方手里的
 * 选中集——选中可能是在卡片被锁之前建立的，锁上之后它不会自动从选中集里
 * 消失。
 *
 * WHY 不总是返回新对象：没有任何锁定项时返回入参本身（引用相等），调用方
 * 就能像对待 `layer-order` 的 `moved: false` 一样跳过「写文档 / 推撤销」
 * 这些重活。每次都造一份等值的新 Set，会让「什么都没变」和「变了」在类型
 * 上长得一样，调用方只能遍历比较。
 *
 * 入参 Set 永不被修改。不在 `nodes` 里的 id（已经删掉的）原样保留：调用方
 * 可能正在清理它们，这里替它丢掉只会让上层对不上账。
 */
export function unlockedIds(nodes: readonly CanvasNode[], ids: ReadonlySet<string>): Set<string> {
  const blocked = new Set<string>()
  for (const node of nodes) {
    if (isLocked(node) && ids.has(node.id)) blocked.add(node.id)
  }
  if (blocked.size === 0) return ids as Set<string>
  const next = new Set(ids)
  for (const id of blocked) next.delete(id)
  return next
}

/**
 * 文档里有多少张被隐藏 —— 底部那条「N 张卡片已隐藏」的货源。
 *
 * 数的是全部节点，不是「当前视口里的」，也不是「选中范围里的」：用户需要
 * 知道整份文档藏了什么，否则那些卡片就真的从他的记忆里消失了。
 */
export const hiddenCount = (nodes: readonly CanvasNode[]): number =>
  nodes.reduce((count, node) => (isHidden(node) ? count + 1 : count), 0)

/**
 * 隐藏之后，指向它的连线也不该画：一根线通往空气比没有线更让人困惑。
 * 只要一端不可见，这条线就不画。
 *
 * 「不可见」包括两种：节点被隐藏，以及节点**已经不存在**。后者不是本模块
 * 能控制的（删除逻辑总会有先删节点、后删连线的中间态），但渲染这一层必须
 * 把它当成同一件事，否则一次删除就会在画面上留下一条悬空的线。
 *
 * 没有任何变化时返回入参本身，理由同 `visibleNodes`：拖动一帧会调用很多次，
 * 画布上没有隐藏、没有悬空线时不该每次都分配一个新数组。
 *
 * 必须与 `visibleNodes` 同时用：只过滤节点会留下通往空气的线，只过滤线则
 * 藏起来的卡片仍然能被选中。
 */
export function visibleConnections<T extends { fromNodeId: string; toNodeId: string }>(
  connections: readonly T[],
  nodes: readonly CanvasNode[],
): T[] {
  const onCanvas = new Set<string>()
  for (const node of nodes) {
    if (!isHidden(node)) onCanvas.add(node.id)
  }
  const drawn = (connection: T): boolean =>
    onCanvas.has(connection.fromNodeId) && onCanvas.has(connection.toNodeId)
  if (connections.every(drawn)) return connections as T[]
  return connections.filter(drawn)
}

/**
 * 复制/粘贴出来的那一份要**清掉这两个标记**。
 *
 * WHY 不是照抄：复制一张锁住的卡，用户想要的是「再来一份能动的」；照抄会让新
 * 卡一出现就拖不动，用户的第一反应是「粘贴坏了」。复制一张隐藏的卡更糟——粘贴
 * 完屏幕上什么都没有，看起来像粘贴失败。
 *
 * 两者都是「对源卡的临时处置」，不是源卡内容的一部分，所以不随内容复制。
 */
export function withoutFlags(metadata: CanvasNode['metadata']): CanvasNode['metadata'] {
  if (metadata === undefined) return undefined
  if (metadata.locked === undefined && metadata.hidden === undefined) return metadata
  const { locked: _locked, hidden: _hidden, ...rest } = metadata
  return rest
}

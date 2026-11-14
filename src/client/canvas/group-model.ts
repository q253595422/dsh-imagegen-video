/**
 * 画布分组：把几个节点圈在一起，给一个名字，一起搬。
 *
 * 纯函数，只吃 `CanvasGroup[]` 与节点查找表，不碰组件状态、不碰 DOM——
 * 与 `connection-role.ts`、`auto-link.ts` 同一约定，所以能单独验证。
 *
 * 三条约束，每条都有具体代价在后面：
 *
 *  1. **一个节点最多属于一个组。** 允许重叠就得决定「拖这个节点，另一个组的框
 *     要不要跟着动」，而这个问题的答案没有对错，只有一堆例外。所以
 *     `withGroup` 会把选中的节点从别的组里摘出来。
 *  2. **组不存坐标。** 框的位置每次由成员节点的包围盒算出来。存一份坐标就等于
 *     多了一份要和节点同步的状态，而移动节点的路径有拖拽、吸附、撤销、Agent
 *     写入四条，漏同步一处框就飘在空地上。
 *  3. **空组自动消失。** 成员被删光的组既没框可画也没东西可拖，留着只会在
 *     右键菜单里变成一个点不动的条目。`pruneGroups` 负责这件事，调用方只需
 *     在删除节点处过一道。
 */

import type { CanvasDocument, CanvasGroup, CanvasNode } from '../../protocol.ts'

/**
 * 框比成员包围盒外扩多少世界像素。
 *
 * 20 是「看得出框在包着它们、又不至于让两个挨得近的组互相插进去」的值：
 * 小于 12 时框贴着节点边缘，视觉上像节点的边框而不是组；大于 28 时两个
 * 相邻组的框会重叠，而重叠的框正是在说「这里有两层归属」——恰恰是这套
 * 模型不允许的事情。
 */
export const GROUP_FRAME_PAD = 20

/** 框的最小尺寸：单个小节点成组时也要有个能点中的矩形。 */
export const GROUP_FRAME_MIN = { width: 120, height: 80 }

export interface GroupFrame {
  x: number
  y: number
  width: number
  height: number
}

/** 文档里的分组。老文档没有这个字段，读作空数组。 */
export function groupsOf(document: Pick<CanvasDocument, 'groups'> | null | undefined): CanvasGroup[] {
  return document?.groups ?? []
}

/**
 * 组的框：成员节点的包围盒外扩 `GROUP_FRAME_PAD`。
 *
 * 成员一个都解析不到时返回 `null`——这时不该画一个点不中的幽灵框，调用方
 * 顺手跳过即可。这也让「组还在、成员全被删了」这个中间态在界面上直接消失，
 * 不必等下一次 prune。
 */
export function groupFrame(
  group: CanvasGroup,
  nodeById: ReadonlyMap<string, CanvasNode>,
): GroupFrame | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const id of group.nodeIds) {
    const node = nodeById.get(id)
    if (node === undefined) continue
    found = true
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  if (!found) return null
  const width = Math.max(GROUP_FRAME_MIN.width, maxX - minX + GROUP_FRAME_PAD * 2)
  const height = Math.max(GROUP_FRAME_MIN.height, maxY - minY + GROUP_FRAME_PAD * 2)
  return { x: minX - GROUP_FRAME_PAD, y: minY - GROUP_FRAME_PAD, width, height }
}

/** 这个节点属于哪个组。模型保证最多一个，所以返回单值而不是数组。 */
export function groupOfNode(groups: readonly CanvasGroup[], nodeId: string): CanvasGroup | undefined {
  return groups.find(group => group.nodeIds.includes(nodeId))
}

/**
 * 把 `nodeIds` 收进一个新组。
 *
 * 这些节点会从它们原来所在的组里被摘掉（约束 1）。原来的组因此变空就整个消失——
 * 一个只剩空壳的组会在菜单里留下一个点不动的「解散组」，比直接消失更让人困惑。
 *
 * 不足两个成员时返回 `undefined`：一个节点的组和没成组看不出区别，却多了一个
 * 要管理的对象。
 */
export function withGroup(
  groups: readonly CanvasGroup[],
  nodeIds: readonly string[],
  makeId: () => string,
  title?: string,
): { groups: CanvasGroup[]; group: CanvasGroup } | undefined {
  const unique = [...new Set(nodeIds)]
  if (unique.length < 2) return undefined
  const claimed = new Set(unique)
  const kept = groups
    .map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => !claimed.has(id)) }))
    .filter(group => group.nodeIds.length > 0)
  const group: CanvasGroup = {
    id: makeId(),
    title: title ?? nextGroupTitle(kept),
    nodeIds: unique,
  }
  return { groups: [...kept, group], group }
}

/** 解散一个组。成员节点原地不动，只是不再被圈着。 */
export function withoutGroup(groups: readonly CanvasGroup[], groupId: string): CanvasGroup[] {
  return groups.filter(group => group.id !== groupId)
}

/** 重命名。空标题落回默认名，否则组框上会留一片点不中的空白。 */
export function withGroupTitle(
  groups: readonly CanvasGroup[],
  groupId: string,
  title: string,
): CanvasGroup[] {
  const trimmed = title.trim()
  // 默认名必须按**其他**组来算：拿整份 groups 去算会把这一组自己的旧名字也算成
  // 已占用，于是「组 1」清空后变成「组 2」——每次清空都往后跳一号。
  const others = groups.filter(group => group.id !== groupId)
  return groups.map(group => group.id === groupId
    ? { ...group, title: trimmed === '' ? nextGroupTitle(others) : trimmed }
    : group)
}

/**
 * 节点被删掉之后收拾分组。
 *
 * `remaining` 是删完还剩的节点 id；不在里面的从成员里剔掉，剔空的组整个消失。
 * 只按「还剩谁」判断而不接受「删了谁」，是因为删除路径有多条（Delete 键、
 * 菜单、撤销外的清理、标注卡连带删除），列一份删除清单迟早漏一条。
 */
export function pruneGroups(
  groups: readonly CanvasGroup[],
  remaining: ReadonlySet<string>,
): CanvasGroup[] {
  const next: CanvasGroup[] = []
  for (const group of groups) {
    const nodeIds = group.nodeIds.filter(id => remaining.has(id))
    if (nodeIds.length === group.nodeIds.length) { next.push(group); continue }
    if (nodeIds.length > 0) next.push({ ...group, nodeIds })
  }
  return next
}

/**
 * 写回文档时用的 prune：**保住「没有这个字段」这一形态**。
 *
 * `pruneGroups` 只吃数组，所以 `pruneGroups(groupsOf(doc), …)` 在 doc 本来
 * 没有 `groups` 时会返回 `[]` —— 写进文档就凭空长出了一个字段。1429 个老画布
 * 里没有一个带 `groups`，第一次删节点就全体多出 `groups: []`，等于本功能改写了
 * 每一份用户文档。这与 `withRole(x, 'input')` 删字段同一策略：磁盘上「没有这个
 * 字段」是这批老画布的唯一形态，就让它继续是唯一形态。
 *
 * 全部组都被删光时同样返回 `undefined`：空数组与缺失在语义上相同，留一个空数组
 * 只会让下一次读的人以为这里本来有东西。
 */
export function pruneGroupsField(
  groups: readonly CanvasGroup[] | undefined,
  remaining: ReadonlySet<string>,
): CanvasGroup[] | undefined {
  if (groups === undefined) return undefined
  return groupsField(pruneGroups(groups, remaining))
}

/**
 * 写回文档时把「组的数组」归一成字段值：空数组落成 `undefined`（即删字段）。
 *
 * 所有写 `groups` 的地方（成组、解散、改名、删除后收拾）都过这一道，否则
 * 「用户解散了最后一个组」会在文档里留下 `groups: []`，而那正是本功能要避免的
 * 「凭空改写老画布」的另一种形态。
 */
export function groupsField(groups: readonly CanvasGroup[] | undefined): CanvasGroup[] | undefined {
  if (groups === undefined || groups.length === 0) return undefined
  // 不复制：这张数组是 document 的一部分，复制一份只会让「没变化」在引用比较里
  // 看起来像变化，白白让下游的 useMemo 全部失效。
  return groups as CanvasGroup[]
}

/**
 * 默认组名：「组 1」「组 2」……取当前没被占用的最小序号。
 *
 * 用最小空位而不是 `groups.length + 1`：解散掉「组 2」之后再建新组，用户希望
 * 拿到「组 2」，而不是一个跳过 2 的「组 4」。
 */
export function nextGroupTitle(groups: readonly CanvasGroup[]): string {
  const used = new Set<number>()
  for (const group of groups) {
    const match = /^组\s*(\d+)$/.exec(group.title)
    if (match !== null) used.add(Number(match[1]))
  }
  let index = 1
  while (used.has(index)) index += 1
  return `组 ${index}`
}

/**
 * 拖动一个成员时，还要一起动的节点：同组其余成员。
 *
 * 返回的是**除被拖节点之外**的成员 id——被拖的那个本来就在移动集合里，
 * 重复加进去只会让调用方多写一次去重。
 */
export function siblingsInGroup(
  groups: readonly CanvasGroup[],
  nodeId: string,
  existing: ReadonlySet<string>,
): string[] {
  const group = groupOfNode(groups, nodeId)
  if (group === undefined) return []
  return group.nodeIds.filter(id => id !== nodeId && !existing.has(id))
}

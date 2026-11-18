/**
 * 两个窗口同时编辑同一张画布时的合并。
 *
 * 原来的做法是：保存撞上 `canvas-conflict`，读一次服务端最新 revision，然后把
 * **本地的整份快照**按新 revision 再写一次。写出去的是本地那份，所以另一个
 * 窗口在这个间隙里改的节点——新建、删除、拖到别处、连线、改标题——全部被抹掉，
 * 而且没有任何提示：用户看到的是「已保存」。这是丢稿，不是冲突处理。
 *
 * 这里做真正的三方合并：`base` 是本地最后一次成功写回的快照（组件里的
 * `syncedRef`），`ours` 是本地当前编辑，`theirs` 是服务端现在的版本。
 * 以 base 为参照，逐节点、逐连线判断「谁改了」：
 *
 * - 只有一边改了 → 取改了的那边。
 * - 两边改成一样的 → 取它。
 * - 两边改成不一样的 → **不能猜**。两张卡都动过同一个字段时，选哪一边都是
 *   替用户做决定，而代价是他那一次编辑无声消失。这类冲突单独返回，调用方
 *   必须让用户看见。
 *
 * 为什么不自动偏向「本地」或「服务端」：两种情况都有人做过，也都错过。偏本地
 * 等于另一个窗口白干；偏服务端等于当前这个窗口白干。合并不了的就报出来，
 * 这是唯一不会静默丢数据的做法。
 */

import type {
  CanvasConnection,
  CanvasDocument,
  CanvasGroup,
  CanvasNode,
} from '../../protocol.ts'

/** 一边改了、另一边没改 → 直接可合并；两边改法不同 → 报冲突。 */
export type MergeOutcome =
  | { ok: true; document: CanvasDocument; applied: MergeSummary }
  | { ok: false; conflicts: MergeConflict[] }

/** 合并后告诉用户「替他保住了什么」，否则他无从判断要不要再看一眼。 */
export interface MergeSummary {
  /** 另一个窗口新增、这次合并保留下来的节点 id。 */
  addedNodes: string[]
  /** 另一个窗口改过、这次合并保留下来的节点 id。 */
  changedNodes: string[]
  /** 另一个窗口删掉、这次合并跟着删掉的节点 id。 */
  removedNodes: string[]
  addedConnections: string[]
  removedConnections: string[]
  addedGroups: string[]
  removedGroups: string[]
  /** 标题 / 视口 / 背景这类整份文档级字段，是否沿用了对方的值。 */
  adoptedTitle: boolean
  adoptedViewport: boolean
  adoptedBackground: boolean
}

/** 一条说不清该听谁的冲突。`subject` 用来写给人看，不做匹配用。 */
export interface MergeConflict {
  /** `node` / `connection` / `group` / `document` */
  kind: 'node' | 'connection' | 'group' | 'document'
  /** 节点、连线或分组的 id；文档级字段用字段名。 */
  id: string
  /** 冲突的那一项叫什么，用于提示里点名。 */
  subject: string
}

const stableKey = (value: unknown): string => JSON.stringify(value ?? null)

/**
 * 三方合并一张画布。
 *
 * 没改过的字段一律保持原样：这个函数只回答「哪一边动过」，不重新序列化文档，
 * 也不修正任何已有值——画布文档里的字段都有各自的语义，合并器没有资格替它
 * 归一化。
 */
export function mergeCanvasDocuments (
  base: CanvasDocument,
  ours: CanvasDocument,
  theirs: CanvasDocument,
): MergeOutcome {
  const conflicts: MergeConflict[] = []
  const applied: MergeSummary = {
    addedNodes: [],
    changedNodes: [],
    removedNodes: [],
    addedConnections: [],
    removedConnections: [],
    addedGroups: [],
    removedGroups: [],
    adoptedTitle: false,
    adoptedViewport: false,
    adoptedBackground: false,
  }

  const nodes = mergeList<CanvasNode>({
    base: base.nodes,
    ours: ours.nodes,
    theirs: theirs.nodes,
    idOf: (node) => node.id,
    labelOf: (node) => node.title,
    kind: 'node',
    added: applied.addedNodes,
    changed: applied.changedNodes,
    removed: applied.removedNodes,
    conflicts,
    // 节点按 id 认身份：同一个 id 在两个窗口里指同一张卡。位置、尺寸、标题、
    // metadata 任何一处不同都算「改过」，因为它们都是用户能直接编辑的东西。
    same: (left, right) => stableKey(left) === stableKey(right),
  })

  const connections = mergeList<CanvasConnection>({
    base: base.connections,
    ours: ours.connections,
    theirs: theirs.connections,
    idOf: (connection) => connection.id,
    labelOf: (connection) => connection.id,
    kind: 'connection',
    added: applied.addedConnections,
    changed: [],
    removed: applied.removedConnections,
    conflicts,
    same: (left, right) => stableKey(left) === stableKey(right),
  })

  const groups = mergeList<CanvasGroup>({
    base: base.groups ?? [],
    ours: ours.groups ?? [],
    theirs: theirs.groups ?? [],
    idOf: (group) => group.id,
    labelOf: (group) => group.title,
    kind: 'group',
    added: applied.addedGroups,
    changed: [],
    removed: applied.removedGroups,
    conflicts,
    same: (left, right) => stableKey(left) === stableKey(right),
  })

  if (conflicts.length > 0) return { ok: false, conflicts }

  const pickField = <K extends keyof CanvasDocument> (
    key: K,
    adopted: 'adoptedTitle' | 'adoptedViewport' | 'adoptedBackground',
  ): CanvasDocument[K] => {
    const baseline = stableKey(base[key])
    const mine = stableKey(ours[key])
    const theirsKey = stableKey(theirs[key])
    // 本地没动过、对方动了 → 听对方的。
    if (mine === baseline && theirsKey !== baseline) {
      applied[adopted] = true
      return theirs[key]
    }
    // 本地动了 → 听本地的（`theirsKey === baseline` 时对方没动，自然也是本地）。
    return ours[key]
  }

  return {
    ok: true,
    document: {
      ...ours,
      // revision 由宿主在写入时递增，这里保留对方看到的那个值，交给 store 处理。
      revision: theirs.revision,
      title: pickField('title', 'adoptedTitle'),
      viewport: pickField('viewport', 'adoptedViewport'),
      background: pickField('background', 'adoptedBackground'),
      backgroundImage: pickField('backgroundImage', 'adoptedBackground'),
      nodes,
      connections,
      // 老文档没有 `groups` 字段。空数组和「没有这个字段」在别处读起来一样，
      // 但写回一份凭空多出 `groups: []` 的文档就是不必要的迁移，所以只有
      // 三份里任意一份真的有分组时才写这个字段。
      ...(groups.length > 0 || ours.groups !== undefined || theirs.groups !== undefined ? { groups } : {}),
    },
    applied,
  }
}

interface MergeListInput<T> {
  base: readonly T[]
  ours: readonly T[]
  theirs: readonly T[]
  idOf: (item: T) => string
  labelOf: (item: T) => string
  kind: MergeConflict['kind']
  added: string[]
  changed: string[]
  removed: string[]
  conflicts: MergeConflict[]
  same: (left: T, right: T) => boolean
}

/**
 * 按 id 对齐三份列表，逐项决定取舍。
 *
 * 顺序取「本地顺序」并追加对方新增的项：用户手上那张画布的排布不能被一次
 * 保存打断；对方新加的卡排在后面，至少位置是对的（坐标本来就在节点上）。
 */
function mergeList<T> (input: MergeListInput<T>): T[] {
  const { base, ours, theirs, idOf, labelOf, kind, added, changed, removed, conflicts, same } = input
  const baseMap = new Map(base.map((item) => [idOf(item), item]))
  const theirMap = new Map(theirs.map((item) => [idOf(item), item]))

  const result: T[] = []
  const settled = new Set<string>()

  for (const mine of ours) {
    const id = idOf(mine)
    settled.add(id)
    const before = baseMap.get(id)
    const theirsItem = theirMap.get(id)
    const mineChanged = before === undefined || !same(before, mine)
    const theirsChanged = theirsItem !== undefined
      && (before === undefined ? true : !same(before, theirsItem))

    if (theirsItem === undefined) {
      // 对方那份里没有这一项。两种完全不同的原因，不能混：
      //  - base 里也没有 → 本地新加的，对方压根没见过，保留。
      //  - base 里有 → 对方删掉了。本地没碰就跟着删；本地也改过则是两边都做了
      //    明确的相反动作，合并不了。
      if (before === undefined) {
        result.push(mine)
        continue
      }
      if (!mineChanged) {
        removed.push(id)
        continue
      }
      conflicts.push({ kind, id, subject: labelOf(mine) })
      result.push(mine)
      continue
    }

    if (!theirsChanged) {
      // 对方没碰这一项。本地改没改都不进 `changedNodes`——那个列表是给用户看
      // 「替你保住了对方的什么」，写进本地自己的改动就成了假汇报。
      result.push(mine)
      continue
    }

    if (!mineChanged || same(mine, theirsItem)) {
      // 本地没动过（或恰好改成一样） → 取对方的，并记下对方改了什么。
      if (before === undefined) added.push(id)
      else if (!same(before, theirsItem)) changed.push(id)
      result.push(theirsItem)
      continue
    }

    // 两边都改了且不一样。
    conflicts.push({ kind, id, subject: labelOf(mine) })
    result.push(mine)
  }

  for (const theirItem of theirs) {
    const id = idOf(theirItem)
    if (settled.has(id)) continue
    const before = baseMap.get(id)
    // 本地经过的都是 ours 里的项，所以走到这里的本地一定没有这一项。
    // 对方新建的：本地从未有过 → 加进来。
    // base 里有、本地却没有：本地删了，而对方这一项改过或没改——没改过就
    // 保持删除（用户删了就是删了），改过才报冲突。
    if (before !== undefined) {
      if (same(before, theirItem)) continue
      conflicts.push({ kind, id, subject: labelOf(theirItem) })
      continue
    }
    added.push(id)
    result.push(theirItem)
  }

  return result
}

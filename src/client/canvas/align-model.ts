/**
 * 对齐 / 分布：把选中的节点排到同一条边、同一条中线，或让它们之间的空隙相等。
 *
 * WHY 单独一个纯函数：差一像素肉眼看不出来，正是要靠数字守的那类问题。调用方
 * 拿 `positions` 一次性写回画布，不必知道哪个节点是被组「带」过去的。
 *
 * 核心概念是 **unit（可移动单元）**：
 *
 *  - 没成组的节点，自己是一个 unit；
 *  - 整组成员都被选中，每个成员各是一个 unit（就是普通节点，各自去够目标）；
 *  - 只选中了组的一部分，**整组是一个 unit**，按同一个整数 delta 平移。
 *
 * 不这么建模的话，「只选一个成员」会让框里其余节点留在原地，组框下一帧就被
 * 重算成一条拉长的、不再包住原内容的框——用户以为自己只是对齐了一张卡，实际
 * 把组拆了。把「整组」当成刚体，规则就只剩一条：unit 移动，成员跟着同一个
 * delta 走。
 *
 * 三个踩过的坑，写在各自的位置旁边：
 *
 *  1. 每一趟的基准都必须在这一趟动手**之前**算完。边算边挪（先挪左边的卡、再
 *     用它去量右边的卡）会让同一趟里后面的节点看到被改过的包围盒，结果依赖
 *     `nodes` 的排列顺序。
 *  2. 组内的 delta 必须是整数。逐个成员各自 `Math.round` 会把相对位置揉掉零
 *     点几像素，而分组的全部意义就是「彼此的位置不变」。
 *  3. 一趟算完**不一定**是幂等的：宽度奇偶不同的卡居中时，取整会让包围盒的
 *     中心挪半像素，第二轮又挪一像素。所以内部反复走单趟直到坐标不再变化，
 *     交给 UI 的是这个映射的不动点，而不是半路上的一步。
 */

import type { CanvasGroup, CanvasNode } from '../../protocol.ts'

export type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' | 'distributeH' | 'distributeV'

export interface AlignInput {
  nodes: readonly CanvasNode[]
  /** 被选中的节点 id。 */
  selectedIds: ReadonlySet<string>
  /** 画布上的分组（`CanvasGroup[]`，可为 undefined）：同组成员的相对位置必须保持不变。 */
  groups?: readonly CanvasGroup[]
}

export type AlignResult =
  | { ok: true; moved: number; positions: Map<string, { x: number; y: number }> }
  | { ok: false; reason: 'too-few' }

interface Point {
  x: number
  y: number
}

/**
 * 一个会被整体平移的东西：普通节点，或一个「只选中了一部分」的组。
 *
 * `members` 是会被写的全部节点（组的未选中成员也在里面）；`selected` 是其中
 * 被选中的那些，只有它们参与包围盒的计算——未选中的成员是跟着走的，不是对齐
 * 的基准。
 */
interface Unit {
  members: CanvasNode[]
  selected: CanvasNode[]
}

/** 取整：输入允许半像素，但结果和基准都按整数像素说话。 */
function px(value: number): number {
  return Math.round(value)
}

/**
 * 距离取整，恰好 ±0.5 时朝零取整（不动）。
 *
 * WHY 不用 `Math.round`：居中时目标中点经常落在半像素上，`Math.round(-0.5)`
 * 得到 -1、`Math.round(0.5)` 得到 1——同一个节点在两轮里朝相反方向各挪一像素，
 * 「对齐」按钮按第二次还会动。平局不动，才让第二轮自然收敛。
 */
function deltaRound(value: number): number {
  const floored = Math.trunc(value)
  // 只有落在半个像素上才是平局；其余照常四舍五入。
  return Math.abs(value - floored) === 0.5 ? floored : Math.round(value)
}

/**
 * 一组节点沿某根轴的整数范围。
 *
 * `x` 与 `width` 各自取整后再相加（而不是 `round(x + width)`）：这样「右边缘
 * − 左边缘」恰好等于整数宽度，第二遍和第一遍的跨度逐字节相同。先加后取整在
 * 两个值都带小数时会让宽度每次少/多一像素，分布于是来回抖。
 */
function spanOf(nodes: readonly CanvasNode[], horizontal: boolean): { start: number; end: number } {
  let start = Infinity
  let end = -Infinity
  for (const node of nodes) {
    const begin = px(horizontal ? node.x : node.y)
    // 负数尺寸是坏数据：夹到 0 让它退化成一条线，而不是把跨度算成负的。
    const extent = Math.max(0, px(horizontal ? node.width : node.height))
    start = Math.min(start, begin)
    end = Math.max(end, begin + extent)
  }
  return { start, end }
}

/**
 * 节点 id → 所属组。
 *
 * 模型保证一个节点最多属于一个组（成组时会把节点从旧组摘掉），这里仍按
 * 「第一个命中的组」建索引，与 `groupOfNode` 的 `find` 语义一致。
 *
 * 已删除节点的 id 不进索引：它既不会出现在选中集合里，也没有坐标可写。
 */
function groupIndexOf(
  groups: readonly CanvasGroup[] | undefined,
  byId: ReadonlyMap<string, CanvasNode>,
): Map<string, CanvasGroup> {
  const index = new Map<string, CanvasGroup>()
  for (const group of groups ?? []) {
    for (const id of group.nodeIds) {
      if (byId.has(id) && !index.has(id)) index.set(id, group)
    }
  }
  return index
}

/**
 * 组里仍然存在于画布上的成员，按 `nodeIds` 顺序去重。
 *
 * 只算「还在画布上」的成员，是为了让「整组都被选中」不被幽灵 id 永远破坏：
 * 不存在的成员永远不可能被选中，若把它算进成员表，这个组就永远判成「只选了
 * 一部分」，每次对齐都整体平移，用户选中的那个节点反而到不了位。
 */
function liveMembersOf(group: CanvasGroup, byId: ReadonlyMap<string, CanvasNode>): CanvasNode[] {
  const seen = new Set<string>()
  const members: CanvasNode[] = []
  for (const id of group.nodeIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node !== undefined) members.push(node)
  }
  return members
}

/** 一份坐标快照上的节点视图：几何计算一律读它，而不是节点自带的 x/y。 */
function viewOf(coords: ReadonlyMap<string, Point>) {
  return (node: CanvasNode): CanvasNode => {
    const point = coords.get(node.id)
    return point === undefined ? node : { ...node, x: point.x, y: point.y }
  }
}

/** 单趟对齐/分布：吃一份当前坐标，返回一份新坐标。不改输入、不碰未涉及的节点。 */
function alignPass(
  coords: ReadonlyMap<string, Point>,
  selected: readonly CanvasNode[],
  selectedIds: ReadonlySet<string>,
  groupOf: ReadonlyMap<string, CanvasGroup>,
  fullGroups: ReadonlySet<string>,
  byId: ReadonlyMap<string, CanvasNode>,
  mode: AlignMode,
): Map<string, Point> {
  const at = viewOf(coords)
  const next = new Map(coords)

  // unit 的顺序 = 第一个被选中成员在文档里的顺序。两遍调用必须选出同一批
  // unit，否则「这一组由谁代表」会换人，结果自己变来变去。
  const units: Unit[] = []
  const groupUnit = new Map<string, Unit>()
  for (const node of selected) {
    const group = groupOf.get(node.id)
    if (group === undefined || fullGroups.has(group.id)) {
      units.push({ members: [node], selected: [node] })
      continue
    }
    if (groupUnit.has(group.id)) continue
    const members = liveMembersOf(group, byId).map(at)
    const unit: Unit = { members, selected: members.filter(member => selectedIds.has(member.id)) }
    groupUnit.set(group.id, unit)
    units.push(unit)
  }

  /** 把一个 unit 的全体成员按同一个整数 delta 平移。相对位置因此逐字节不变。 */
  const moveUnit = (unit: Unit, dx: number, dy: number): void => {
    if (dx === 0 && dy === 0) return
    for (const member of unit.members) {
      const current = coords.get(member.id) ?? { x: px(member.x), y: px(member.y) }
      next.set(member.id, { x: current.x + dx, y: current.y + dy })
    }
  }

  const distributing = mode === 'distributeH' || mode === 'distributeV'
  if (!distributing) {
    const horizontal = mode === 'left' || mode === 'centerH' || mode === 'right'
    // 基准来自这一趟开始时的选中集合，也就是上一趟的结果。整条链跑到不动点
    // 之后，它就是「移动之前」的基准。
    const guide = spanOf(selected.map(at), horizontal)
    const mid = (guide.start + guide.end) / 2

    for (const unit of units) {
      // 用 unit 的**选中成员**包围盒去够基准：只有一个成员时它就是那张卡，
      // 于是选中的节点精确落在基准线上；组里选中的成员多于一个时，落线的是
      // 这一组选中部分的整体边缘，整组仍然是刚体。
      const box = spanOf(unit.selected.map(at), horizontal)
      let offset = 0
      if (mode === 'left' || mode === 'top') offset = guide.start - box.start
      else if (mode === 'right' || mode === 'bottom') offset = guide.end - box.end
      // 居中目标是**节点中心**，不是左边缘：按左边缘对齐会让宽度不同的卡整体
      // 偏到右边，用户看到的中线就不再是中线。
      else offset = deltaRound(mid - (box.start + box.end) / 2)
      if (horizontal) moveUnit(unit, offset, 0)
      else moveUnit(unit, 0, offset)
    }
    return next
  }

  const horizontal = mode === 'distributeH'
  /** 垂直于分布轴的坐标：排序打平时用它，保证顺序稳定。 */
  const crossOf = (node: CanvasNode): number => px(horizontal ? node.y : node.x)

  // 排序与空隙都只按**选中的成员**量：需求里的「选中集合的最左与最右」是字面
  // 意思。组的未选中成员由 `moveUnit` 一起带过去，但它们不参与「哪里是第一张、
  // 哪段空隙该多宽」的判断——否则用户多圈一张卡，整个带子就会重排。
  const ordered = [...units].sort((a, b) => {
    const first = spanOf(a.selected.map(at), horizontal)
    const second = spanOf(b.selected.map(at), horizontal)
    return first.start - second.start
      || crossOf(at(a.selected[0])) - crossOf(at(b.selected[0]))
      || (a.selected[0].id < b.selected[0].id ? -1 : a.selected[0].id > b.selected[0].id ? 1 : 0)
  })
  // 一个 unit 都没有的情况已经在入口被 `too-few` 拦住了；同一组里的三个选中
  // 节点会合成一个 unit，这时没有可分布的对象，保持原样返回。
  if (ordered.length < 2) return next

  const boxes = ordered.map(unit => spanOf(unit.selected.map(at), horizontal))
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  // 两端固定，剩下的空间平均分给 `n - 1` 段**边缘到边缘的空隙**。扣掉的是所有
  // unit 的沿轴宽度，所以算出来的是卡与卡之间的空气，而不是中心距。
  const occupied = boxes.reduce((sum, box) => sum + (box.end - box.start), 0)
  const span = last.end - first.start
  // 总宽度超过跨度时等间距是负的——卡片互相倒插，第二遍排出来的顺序会换人，
  // 既不再幂等，也会把用户指定「不动」的那张卡拉走。这种输入本来就摆不出等
  // 距，保持原样（`moved === 0`）比让它来回跳更诚实。
  const gap = (span - occupied) / (ordered.length - 1)
  if (gap < 0) return next

  let cursor = first.end + gap
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const box = boxes[index]
    const target = px(cursor)
    // 游标一直前进，与这个 unit 本轮是否真的动过无关：「等间距」说的是整条
    // 带子的骨架，骨架不能因为某个 unit 被跳过而缩一截。
    cursor += box.end - box.start + gap
    const delta = target - box.start
    if (horizontal) moveUnit(ordered[index], delta, 0)
    else moveUnit(ordered[index], 0, delta)
  }
  return next
}

/**
 * 跑到不动点的上限。
 *
 * 居中时的半像素取整最多造成 1px 的余量；5000 组随机输入实测最多 3 趟就停，
 * 这里留出一倍余量应付「组 + 半像素 + 混合尺寸」的叠加。真到了上限还没停，
 * 说明这组形状没有精确整数解（比如三张奇数宽度的卡要居中到偶数跨度上）——
 * 返回最后一次结果，它已经是整数格点上离目标最近的一步，不会来回跳。
 */
const SETTLE_PASSES = 6

export function alignNodes(input: AlignInput, mode: AlignMode): AlignResult {
  const { nodes, selectedIds, groups } = input
  const byId = new Map(nodes.map(node => [node.id, node]))
  // 只认画布上真的存在的节点：选中集合里混进一个已删除的 id 时不能把它算成
  // 一个「节点」，否则两个真实节点 + 一个幽灵 id 会被当成三个而放行。
  const selected = nodes.filter(node => selectedIds.has(node.id))

  // 分布至少三个：两个节点之间只有一段空隙，谈不上「等间距」，放行只会让
  // 用户点一个看不出任何变化的按钮。
  const distributing = mode === 'distributeH' || mode === 'distributeV'
  if (selected.length < (distributing ? 3 : 2)) return { ok: false, reason: 'too-few' }

  const groupOf = groupIndexOf(groups, byId)
  const fullGroups = new Set<string>()
  for (const group of groups ?? []) {
    const members = liveMembersOf(group, byId)
    if (members.length > 0 && members.every(node => selectedIds.has(node.id))) fullGroups.add(group.id)
  }

  // 起点是**取整后的原坐标**：后面的每一步都只在整数格点上走，`moved` 与幂等
  // 才有意义。未选中的节点不在表里，自然的写回路径就碰不到它们。
  let coords = new Map<string, Point>()
  for (const node of selected) coords.set(node.id, { x: px(node.x), y: px(node.y) })

  for (let pass = 0; pass < SETTLE_PASSES; pass += 1) {
    const next = alignPass(coords, selected, selectedIds, groupOf, fullGroups, byId, mode)
    let changed = false
    for (const [id, point] of next) {
      const before = coords.get(id)
      if (before === undefined || before.x !== point.x || before.y !== point.y) { changed = true; break }
    }
    coords = next
    if (!changed) break
  }

  // 「真的变了」按最终坐标和**原始**坐标逐项比：被组带动、最终恰好没动的成员
  // 不该算进去，否则调用方会以为画布变了而多写一条撤销记录。
  let moved = 0
  for (const [id, final] of coords) {
    const before = byId.get(id)
    if (before === undefined) continue
    if (final.x !== before.x || final.y !== before.y) moved += 1
  }
  return { ok: true, moved, positions: coords }
}

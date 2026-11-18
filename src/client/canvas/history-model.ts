/**
 * 把「一次撤销」说成人话：前后两份画布文档 → 一条结构化摘要。
 *
 * WHY 单独一个纯函数：撤销按钮现在只写「撤销」，连按三次之后用户不知道
 * 自己刚刚退掉了哪一步。摘要要同时喂两处——按钮的 title 和将来的历史面板
 * ——所以这里只产出 key + 参数 + 相关节点 id：文案留在三语表里，这个模块
 * 不读字典、不碰 DOM、不 import 任何 `.tsx`，Node 里能直接 import 来验证。
 *
 * ## 判定顺序
 *
 *   节点增删 > 连线增删 > 移动 > 分组 > 标题 / 背景 > 其它字段编辑
 *
 * 顺序只用来看「一条变化归到哪一类」，以及给下面这些边界定调：
 *
 * - 删除节点必然连带删除它的连线，这不是第二个动作，是同一个动作的结果。
 *   所以「新节点带来的连线」「被删节点带走的连线」都吸收进节点那一类，
 *   否则每次删节点都会变成 `mixed`，tooltip 永远说不出「撤销删除」。
 * - 节点同时改了坐标和 metadata 时记 `move`（几何优先）。用户的动作是拖动，
 *   metadata 里跟着变的字段是这次拖动的附带结果；这也和撤销栈一条快照对应
 *   一次手势的粒度一致。
 *
 * 出现**两个彼此独立**的类别时（例如删了一个节点，又移动了另一个节点），
 * 返回 `mixed` 而不是让优先级吞掉后一个。理由：撤销按钮的 title 是一句
 * 承诺——「按下去会退掉什么」。同一动作的连带结果可以合并，两件独立的事
 * 若只报优先级最高的那件，就是在隐瞒另一件。`mixed` 的 `count` 是这次
 * 涉及的条目总数：一个节点算 1，一根线算 1，一个分组算 1，文档字段算 1。
 * 按同一逻辑，文档标题和背景同时改了也是 `mixed`，不是 `title`。
 *
 * ## 几个刻意不做的判断
 *
 * - **`arrange` 永远不会由本函数产出。** 文档差异里「整理画布」与「多选拖动
 *   一批节点」是同一件事（都是 x/y 批量变化），从两份快照里分不出来。用
 *   「变了 ≥N 个节点就猜整理」会在用户多选手拖时撒谎，而这正是本模块要
 *   消除的那类含糊。`arrange` 这个 key 留给调用方：只有按下「整理画布」的
 *   那一处知道这是整理，将来应由它显式标注这一步。
 * - **节点改名算 `edit`，不算 `title`。** `title` / `background` 说的是画布
 *   文档自身的标题与背景，和「画布上某张卡片的标题」不是一回事；后者是
 *   对节点内容的编辑。
 * - **连线步骤的 `nodeIds` 为空。** 接口里 `nodeIds` 只收「真的变了的节点」：
 *   新增、删除、坐标/尺寸/标题/metadata 变化。连线的两端节点本身没变，
 *   不能为了将来能跳转就把它们的 id 塞进来——那会让「这一步动了几个节点」
 *   的统计凭空多出两个。历史面板要跳连线，应当用连线自己的 id（后续字段）。
 * - **viewport 不参与正文分类。** 平移/缩放是视图动作，不是对画布的编辑。
 *   它若和内容改动同处一份快照，会被忽略；只有「除视口外什么都没变」时
 *   才返回 `mixed` 且 `nodeIds` 为空——否则每次拖动画布都会变成 `mixed`。
 * - **`revision` / `updatedAt` / `id` 等簿记字段不参与比较。** 它们每次保存
 *   都会变，拿它们判变化等于每条历史都是「混合操作」。
 *
 * ## 稳定性
 *
 * 节点、连线、分组一律按 id 建 Map 比较，不按下标：两份文档的数组顺序不同
 * 但内容相同时，不能报出一串「每个节点都变了」。比较值用 `canonical()` 做
 * 递归按键排序的序列化，metadata 的键顺序不同不算变化。`nodeIds` 的产出
 * 顺序固定为「before 里的顺序（删除/修改），接 after 里新增的」，去重。
 */

import type { CanvasConnection, CanvasDocument, CanvasNode } from '../../protocol.ts'

export type StepKind =
  | 'add'
  | 'remove'
  | 'move'
  | 'edit'
  | 'connect'
  | 'disconnect'
  | 'group'
  | 'arrange'
  | 'title'
  | 'background'
  | 'mixed'

export interface HistoryStep {
  kind: StepKind
  /** 文案 key（三语表由接线方补，这里只给 key）。 */
  detailKey:
    | 'canvas.step.add'
    | 'canvas.step.remove'
    | 'canvas.step.move'
    | 'canvas.step.edit'
    | 'canvas.step.connect'
    | 'canvas.step.disconnect'
    | 'canvas.step.group'
    | 'canvas.step.arrange'
    | 'canvas.step.title'
    | 'canvas.step.background'
    | 'canvas.step.mixed'
  /** 填进文案的参数，例如 { count: 3 }、{ titles: '图片节点、生成配置' }。 */
  detailValues?: Record<string, string | number>
  /** 这一步影响到的节点 id，供将来做「点历史项跳过去」。 */
  nodeIds: readonly string[]
}

const DETAIL_KEYS: Record<StepKind, HistoryStep['detailKey']> = {
  add: 'canvas.step.add',
  remove: 'canvas.step.remove',
  move: 'canvas.step.move',
  edit: 'canvas.step.edit',
  connect: 'canvas.step.connect',
  disconnect: 'canvas.step.disconnect',
  group: 'canvas.step.group',
  arrange: 'canvas.step.arrange',
  title: 'canvas.step.title',
  background: 'canvas.step.background',
  mixed: 'canvas.step.mixed',
}

/**
 * 一句话里最多点名三个节点。
 *
 * 三个是「读得完」的上限：撤销按钮的 title 是一行不放大的浮层，第四个名字
 * 之后用户已经不再逐字读，只会看到一串没有边界的长文本。多出来的用中文
 * 省略号（六个点）收尾，长度仍在一行内。
 */
const TITLE_LIMIT = 3
const ELLIPSIS = '……'

/**
 * 递归按键排序的 JSON 序列化，只用于比较，不用于落盘。
 *
 * WHY 不直接 JSON.stringify：metadata 是普通对象，{ a, b } 与 { b, a } 在
 * JSON 文本里不同但在语义上相同。直接比字符串会把「键顺序变了」误报成一次
 * 编辑。`undefined` 显式写成标记，是因为它在 JSON.stringify 里会被整个丢掉，
 * 让 `{ a: undefined }` 和 `{}` 看起来一样——而删掉一个字段确实是编辑。
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/** 几何是「移动」的唯一依据；宽度/高度变化同样是一次布局移动，不是文本编辑。 */
function geometryOf(node: CanvasNode): string {
  return `${node.x}|${node.y}|${node.width}|${node.height}`
}

/**
 * 抹掉几何后再比较，用来判断「除了位置尺寸之外还改了什么」。
 * 保留其余所有字段（而不是只挑 type/title/metadata），这样以后给节点加字段
 * 时，本模块不需要跟着改也不会漏报。
 */
function contentOf(node: CanvasNode): string {
  return canonical({ ...node, x: 0, y: 0, width: 0, height: 0 })
}

function indexNodes(nodes: readonly CanvasNode[]): Map<string, CanvasNode> {
  const index = new Map<string, CanvasNode>()
  for (const node of nodes) index.set(node.id, node)
  return index
}

function indexConnections(connections: readonly CanvasConnection[]): Map<string, CanvasConnection> {
  const index = new Map<string, CanvasConnection>()
  for (const connection of connections) index.set(connection.id, connection)
  return index
}

/**
 * 节点标题，空串退回 id 的短前缀。
 *
 * 空标题在界面上是一张没有名字的卡片，直接拼进「撤销编辑：、生成配置」会
 * 多出一个空档；id 前 6 位是用户在节点详情里也能看到的稳定标识，至少能
 * 指认出是哪一张。只去空白判断，不回写 title——摘要不应改文档。
 */
function labelOf(node: CanvasNode): string {
  const title = node.title.trim()
  // 只由空格组成的标题与空串一样读不出来，所以用 trim 后的结果。
  return title === '' ? node.id.slice(0, 6) : title
}

/**
 * 三个名字 + 「、……」。
 *
 * 注意这里只截**个数**，不截单个标题的字数：标题是用户起的名字，从中间
 * 砍断比多占一行更难认。
 */
function joinTitles(titles: readonly string[]): string {
  const shown = titles.slice(0, TITLE_LIMIT).join('、')
  return titles.length > TITLE_LIMIT ? `${shown}、${ELLIPSIS}` : shown
}

function titlesFor(
  nodeIds: readonly string[],
  before: Map<string, CanvasNode>,
  after: Map<string, CanvasNode>,
): string[] {
  const titles: string[] = []
  for (const id of nodeIds) {
    // 删除的节点只在 before 里，新增的只在 after 里，改名的用 after 的
    // 名字——用户此刻屏幕上看到的是新标题。
    const node = after.get(id) ?? before.get(id)
    if (node !== undefined) titles.push(labelOf(node))
  }
  return titles
}

function makeStep(
  kind: StepKind,
  count: number,
  nodeIds: readonly string[],
  before: Map<string, CanvasNode>,
  after: Map<string, CanvasNode>,
): HistoryStep {
  const detailValues: Record<string, string | number> = { count }
  if (nodeIds.length > 0) detailValues.titles = joinTitles(titlesFor(nodeIds, before, after))
  return { kind, detailKey: DETAIL_KEYS[kind], detailValues, nodeIds }
}

/** 分组比较：成员顺序无意义（画框只看集合），所以排序后再比。 */
function groupKey(group: { id: string; title: string; nodeIds: readonly string[] }): string {
  return canonical({ id: group.id, title: group.title, nodeIds: [...group.nodeIds].sort() })
}

/**
 * 前后两份文档 → 一句话。
 *
 * 调用方要表达「撤销到空」时传一份空文档（nodes/connections 为空）即可：
 * 撤销栈只存真实快照，`null` 是接线方自己的状态，不该让纯函数多一种分支。
 * 空文档的标题与背景仍会参与比较——若调用方真拿一份被清空内容的文档来比，
 * 「标题也变了」是事实，合并成 mixed 不会撒谎。
 */
export function describeStep(before: CanvasDocument, after: CanvasDocument | null): HistoryStep {
  const beforeNodes = indexNodes(before.nodes)
  const afterNodes = indexNodes(after?.nodes ?? [])

  // ------------------------------------------------------------ 节点

  const removedIds: string[] = []
  const addedIds: string[] = []
  const movedIds: string[] = []
  const editedIds: string[] = []
  /** before 顺序下的删除与修改；新增的另起一段接在后面。 */
  const touchedIds: string[] = []
  const seen = new Set<string>()

  for (const node of before.nodes) {
    // 文档里不该有重复 id；真出现了也只认一次，避免 count 虚高。
    if (seen.has(node.id)) continue
    seen.add(node.id)

    const current = afterNodes.get(node.id)
    if (current === undefined) {
      removedIds.push(node.id)
      touchedIds.push(node.id)
      continue
    }
    if (canonical(node) === canonical(current)) continue

    touchedIds.push(node.id)
    if (geometryOf(node) !== geometryOf(current)) movedIds.push(node.id)
    else editedIds.push(node.id)
  }

  const added = new Set<string>()
  for (const node of after?.nodes ?? []) {
    if (beforeNodes.has(node.id) || added.has(node.id)) continue
    added.add(node.id)
    addedIds.push(node.id)
  }

  const nodeIds = [...touchedIds, ...addedIds]
  const removedNodeIds = new Set(removedIds)
  const addedNodeIds = new Set(addedIds)

  // ------------------------------------------------------------ 连线

  const beforeConnections = indexConnections(before.connections)
  const afterConnections = indexConnections(after?.connections ?? [])

  const touches = (connection: CanvasConnection, nodes: Set<string>): boolean =>
    nodes.has(connection.fromNodeId) || nodes.has(connection.toNodeId)

  let addedConnections = 0
  let removedConnections = 0

  for (const [id, previous] of beforeConnections) {
    const current = afterConnections.get(id)
    if (current === undefined) {
      // 被删节点带走的线属于「删除节点」这一步，不单独计数。
      if (!touches(previous, removedNodeIds)) removedConnections += 1
      continue
    }
    if (canonical(previous) === canonical(current)) continue
    // 端点换掉了：读作「重新连了一根」。若它只是新节点的自动连线，归给 add。
    if (touches(previous, removedNodeIds) || touches(current, addedNodeIds)) continue
    addedConnections += 1
  }

  for (const [id, current] of afterConnections) {
    if (beforeConnections.has(id)) continue
    if (touches(current, addedNodeIds)) continue
    addedConnections += 1
  }

  // ------------------------------------------------------------ 分组

  let groupChanges = 0
  if (after !== null) {
    const beforeGroups = new Map((before.groups ?? []).map(group => [group.id, group] as const))
    const afterGroups = new Map((after.groups ?? []).map(group => [group.id, group] as const))

    // 节点增删会顺带改分组：删掉的成员被移出组、成员全删光时整组消失、
    // 新节点可能一创建就入组。这些和连线一样是**同一步的连带结果**，
    // 不是用户真的去动了分组；按原样比较会把每次「删掉一个组员」都变成
    // mixed。所以比较时先剔除本快照新增/删除的节点，只看「剩下的成员」。
    const members = (ids: readonly string[], drop: Set<string>): string[] =>
      [...new Set(ids.filter(id => !drop.has(id)))].sort()

    for (const [id, previous] of beforeGroups) {
      const current = afterGroups.get(id)
      if (current === undefined) {
        // 组消失：若成员全是被删节点，它是删除的附带结果。
        if (members(previous.nodeIds, removedNodeIds).length === 0) continue
        groupChanges += 1
        continue
      }
      if (previous.title !== current.title) {
        groupChanges += 1
        continue
      }
      const previousMembers = members(previous.nodeIds, removedNodeIds)
      const currentMembers = members(current.nodeIds, addedNodeIds)
      if (canonical(previousMembers) !== canonical(currentMembers)) groupChanges += 1
    }
    for (const [id, current] of afterGroups) {
      if (beforeGroups.has(id)) continue
      // 新组只装着新节点：它是这次新增的附带结果，不是一次独立的分组动作。
      if (members(current.nodeIds, addedNodeIds).length === 0) continue
      groupChanges += 1
    }
  }

  // ------------------------------------------------------- 文档自身字段

  const titleChanged = after !== null && before.title !== after.title
  const backgroundChanged = after !== null
    && (before.background !== after.background
      || canonical(before.backgroundImage) !== canonical(after.backgroundImage))
  const viewportChanged = after !== null && canonical(before.viewport) !== canonical(after.viewport)

  // --------------------------------------------------------------- 归类

  // 顺序即约定的优先级；这里只用来阅读与兜底，真正的取舍见上方注释：
  // 单一类别直接产出，独立的多类别合并成 mixed。
  const buckets: Array<{ kind: StepKind; count: number }> = []
  if (addedIds.length > 0) buckets.push({ kind: 'add', count: addedIds.length })
  if (removedIds.length > 0) buckets.push({ kind: 'remove', count: removedIds.length })
  if (addedConnections > 0) buckets.push({ kind: 'connect', count: addedConnections })
  if (removedConnections > 0) buckets.push({ kind: 'disconnect', count: removedConnections })
  if (movedIds.length > 0) buckets.push({ kind: 'move', count: movedIds.length })
  if (groupChanges > 0) buckets.push({ kind: 'group', count: groupChanges })
  if (titleChanged) buckets.push({ kind: 'title', count: 1 })
  if (backgroundChanged) buckets.push({ kind: 'background', count: 1 })
  if (editedIds.length > 0) buckets.push({ kind: 'edit', count: editedIds.length })

  if (buckets.length === 1) {
    const [only] = buckets
    return makeStep(only!.kind, only!.count, nodeIds, beforeNodes, afterNodes)
  }

  if (buckets.length > 1) {
    // 节点在 nodeIds 里已经去重，只算一次；连线/分组/文档字段各算一项。
    const count = nodeIds.length
      + addedConnections
      + removedConnections
      + groupChanges
      + (titleChanged ? 1 : 0)
      + (backgroundChanged ? 1 : 0)
    return makeStep('mixed', count, nodeIds, beforeNodes, afterNodes)
  }

  // 什么都没变，或只有视口动了。两者都给 mixed：前者调用方据 nodeIds 空
  // 拒绝压栈；后者是视图动作，不该被说成「改了 N 个节点」。
  return makeStep('mixed', viewportChanged ? 1 : 0, [], beforeNodes, afterNodes)
}

/**
 * 历史面板里的一行。
 *
 * `stepsBack` 是「点它要往回退几步」：1 是上一步，2 是再上一步。用它而不是
 * 时间戳——撤销栈是按顺序压的，用户点第 N 行要的是「回到那一步」；而同一个
 * 时刻可能被压两次（`beginHistory` 会去重，但旧数据里有），时间戳说不清。
 */
export interface HistoryRow {
  /** 相对**当前**状态要退几步。1 = 上一步（也就是按一次撤销到的地方）。 */
  stepsBack: number
  detailKey: HistoryStep['detailKey']
  detailValues?: Record<string, string | number>
  /** 这一步涉及的节点，供「点一行跳过去」；连线 / 文档字段的步骤为空。 */
  nodeIds: readonly string[]
  kind: StepKind
}

/**
 * 撤销栈 → 历史列表（最新在上）。
 *
 * 输入是快照栈（`pastRef` 的 JSON 串数组，末尾是最近一次的前态）与当前文档。
 * 每一行的说明走 `describeStep(前一个快照, 后一个快照)`——与撤销按钮读同一个
 * 函数，两处不可能对不上。
 *
 * WHY 从栈里重建、而不是每步存一句文案：文案存下来就得跟着语言切换重算，而
 * DSH 的界面语言是活的（会话中间可以改）。快照是与语言无关的事实，文案是它
 * 的函数——存事实、每次算文案，切语言后整张表立刻跟着变。
 *
 * 两处例外都朝「宁可少一行」的方向倒：
 *  - 坏掉的快照直接**截断**，不跳过。跳过一个会让 `stepsBack` 与真实栈深错开，
 *    点一行退错步比表里少几行危险得多。
 *  - 只有视口变化 / 内容完全相同的一步不列出。`beginHistory` 会去重，但历史
 *    文件里存在过这种数据。
 *
 * @param past - 快照栈，末尾是最新一步的前态。
 * @param current - 当前文档；null 时返回空表（画布还没载入）。
 * @param limit - 最多给多少行；调用方按面板容量给预算。
 */
export function historyRows(
  past: readonly string[],
  current: CanvasDocument | null,
  limit = 40,
): HistoryRow[] {
  if (current === null) return []
  const frames: CanvasDocument[] = []
  for (const snapshot of past) {
    try {
      frames.push(JSON.parse(snapshot) as CanvasDocument)
    } catch {
      break
    }
  }
  const rows: HistoryRow[] = []
  for (let index = frames.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const before = frames[index]!
    const after = index === frames.length - 1 ? current : frames[index + 1]!
    const step = describeStep(before, after)
    if (step.kind === 'mixed' && step.nodeIds.length === 0) continue
    rows.push({
      stepsBack: frames.length - index,
      detailKey: step.detailKey,
      detailValues: step.detailValues,
      nodeIds: step.nodeIds,
      kind: step.kind,
    })
  }
  return rows
}

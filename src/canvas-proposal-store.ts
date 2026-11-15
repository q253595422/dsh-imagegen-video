/**
 * 待确认的画布改动（Agent 提案）。
 *
 * WHY 需要这一层：Agent 的八个画布工具今天一调用就落盘。乐观锁只挡得住
 * 「两个写入者同时改」，挡不住「用户根本不在场」——模型可以在用户睡觉时
 * 把画布重排一遍，用户第二天打开看到的是既成事实。工具自己的说明写着
 * 「add_canvas_node 不花钱」，但那说的是钱，不是改动本身的风险。
 *
 * 这里的做法：Agent 的写操作产出一个**提案**，存在 canvas/proposals/ 下，
 * 与 pages/ 完全分开。用户接受时，提案被**增量**应用到当前文档，再交给
 * `CanvasStore.save` 走那把乐观锁：用户在提议之后自己加的节点、改的标题都
 * 留着，两个窗口同时写会明确地冲突，而不是悄悄覆盖。
 *
 * 三条必须守住的边界：
 *
 *  1. **绝不碰 pages/。** 提案是旁路文件。哪怕这个模块坏了、写满了磁盘，
 *     用户的画布也一字未动。这是它敢接管全部 Agent 写操作的前提。
 *  2. **提案按顺序叠加。** `connect_canvas_nodes` 要能连上
 *     `add_canvas_node` 刚提议的节点，所以第 N 条提案是在「真实文档 + 前
 *     N-1 条提案」上算出来的。否则 Agent 一连串操作里除了第一条全部失败。
 *  3. **接受一条不作废后面几条。** 每条提案都记下 baseRevision（诊断与界面
 *     用），但接受时**不拿它当闸门**。原因是它会砸在最常见的路径上：Agent
 *     一次任务连着提议三条，三条的 baseRevision 都是同一个数；用户接受第一条
 *     后 revision +1，第二三条就被判过期——界面写着「还有 2 条在后面」，却
 *     一条都点不动。
 *
 *     真正要防的两件事各有更合适的机制：
 *       - 覆盖用户刚做的编辑 → `apply` 只增删提案点名的节点/连线，其余字段
 *         原样带过去；用户改的标题、拖的坐标不会被回退。
 *       - 读与写之间有人插了一笔 → `save(next, revision)` 那把乐观锁。
 *       - 提案点名的节点被删了 → `apply` 返回 undefined。
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CanvasDocument, CanvasNode, CanvasProposal, CanvasProposalChange, CanvasProposalNodeUpdate } from './protocol.ts'
import { canvasStore, CanvasConflictError, coerceDocument, readJson, safeId, writeJsonAtomic, type CanvasStore } from './canvas-store.ts'
import { CONNECTION_ROLES, roleOf, withRole } from './client/canvas/connection-role.ts'
import { pruneGroupsField } from './client/canvas/group-model.ts'
import { imageDataRoot } from './image-storage-path.ts'

// 供同包内其他模块从存储层导入类型；客户端仍从 protocol.ts 拿。
export type { CanvasProposal, CanvasProposalChange }

/**
 * 接受一条提案的结果。
 *
 * 路由把它翻成 HTTP 响应，测试直接断言它——**两边跑的是同一段逻辑**。
 * 曾经测试自己重写了一遍「读 → 比 revision → apply → save」，于是测试绿着、
 * 线上第二三条提案全部过期：测的不是同一个东西，这种绿比红更危险。
 */
export type AcceptResult =
  | { ok: true; document: CanvasDocument }
  | { ok: false; code: 'not-found' | 'proposal-stale' | 'canvas-conflict' | 'canvas-failed'; message: string }

/**
 * 提案账本。
 *
 * 每条提案单独一个文件、再加一个按画布索引的目录。不用单一大文件：并发写
 * 两个画布时不必抢同一把锁，而坏掉一条提案也只损失那一条。
 */
export class ProposalStore {
  constructor(private readonly root?: string) {}

  private dir(): string { return path.join(this.root ?? path.join(imageDataRoot(), 'canvas'), 'proposals') }
  private filePath(id: string): string { return path.join(this.dir(), `${safeId(id)}.json`) }

  private async ensure(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
  }

  /** 一份画布上所有待确认的提案，按提议顺序。 */
  async list(canvasId: string): Promise<CanvasProposal[]> {
    return (await this.scan(canvasId)).proposals
  }

  /**
   * 读一遍 proposals/ 目录，同时给出「这份画布的提案」与「每份画布各几条」。
   *
   * WHY 合并：画布每 5 秒轮询一次本画布的提案，而项目下拉又要每份画布的
   * 条数；两者分开写就是每轮把同一个目录和同一批 JSON 读两遍。提案是个小
   * 旁路目录，但它会在每次轮询里被读，重复读的代价是持续的。
   *
   * 一次遍历里两件事一起攒：`proposals` 只收集 `canvasId` 命中的那些，
   * `counts` 收集全部。读不懂的文件跳过，不猜——一条坏文件不该让整份列表消
   * 失，也不该让计数变成 NaN。
   */
  async scan(canvasId: string): Promise<{ proposals: CanvasProposal[]; counts: Record<string, number> }> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir())
    } catch {
      // 目录还不存在：没有提案。这是常态，不是错误。
      return { proposals: [], counts: {} }
    }
    const found: CanvasProposal[] = []
    const counts: Record<string, number> = {}
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const proposal = coerceProposal(await readJson(path.join(this.dir(), name)))
      if (proposal === undefined) continue
      counts[proposal.canvasId] = (counts[proposal.canvasId] ?? 0) + 1
      if (proposal.canvasId === canvasId) found.push(proposal)
    }
    // 目录顺序由文件系统决定，必须自己排；同一毫秒内的两条提案用 id 兜底，
    // 否则叠加顺序会随机器而变。
    found.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    return { proposals: found, counts }
  }

  /**
   * 每份画布各有多少条待确认提案（一次读目录，给列表页用）。
   *
   * 返回的键是 canvasId。项目下拉有上千份画布，逐画布调 `list()` 会把目录
   * 读上千遍；这里只走一次 readdir。
   */
  async countByCanvas(): Promise<Record<string, number>> {
    return (await this.scan('')).counts
  }

  async add(proposal: Omit<CanvasProposal, 'id' | 'createdAt'>): Promise<CanvasProposal> {
    await this.ensure()
    const id = randomUUID()
    const created: CanvasProposal = { ...proposal, id, createdAt: this.nextTimestamp() }
    await writeJsonAtomic(this.filePath(id), created)
    return created
  }

  /**
   * 提案时间戳，保证**同一进程内严格递增**。
   *
   * WHY 不是裸的 `Date.now()`：Agent 一次任务会连发好几条提案（加节点、连线、
   * 改标题），它们常常落在同一毫秒里。`scan` 的排序是
   * `createdAt || id.localeCompare`，而 uuid 是随机的——同一毫秒的多条提案
   * 于是按 uuid 排，用户看到的顺序每次机器都不一样，Agent 说「先加再连」，
   * 界面上可能先连后加。探针实测：八次里有两次顺序被重排。
   *
   * 单调递增还顺带解决了另一种情况：系统时钟往回跳时，新提案不会排到旧提案
   * 前面去，队列不会突然「回到过去」。
   */
  private nextTimestamp(): number {
    const now = Date.now()
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1)
    return this.lastTimestamp
  }

  /** 本进程发出过的最后一个提案时间戳（见 `nextTimestamp`）。 */
  private lastTimestamp = 0

  async remove(id: string): Promise<void> {
    await fs.rm(this.filePath(id), { force: true })
  }

  /** 丢掉一份画布上的全部提案（用户点「全部丢弃」）。 */
  async clear(canvasId: string): Promise<number> {
    const existing = await this.list(canvasId)
    for (const proposal of existing) await this.remove(proposal.id)
    return existing.length
  }

  /**
   * 接受一条提案：应用到当前文档并落盘。
   *
   * ## 为什么不比 baseRevision
   *
   * 提案记录着 `baseRevision`，但接受时**不用它判过期**，只看 `apply` 还能
   * 不能应用。原因是这样会错在最常见的路径上：Agent 一次任务里连着提议三条
   * （加节点、加配置节点、连线），三条的 baseRevision 都是提议时那份文档的
   * revision；用户接受第一条后 revision 就 +1，第二三条于是全部被判过期——
   * 界面写着「还有 2 条在后面」，实际一条都接受不了。
   *
   * 不比 revision 不丢掉它本来要挡的三件事：
   *  - **不覆盖用户刚做的编辑**：`ProposalStore.apply` 是增量语义，只在当前
   *    文档上增删提案点名的节点与连线，其余字段（标题、视口、用户拖过的坐标）
   *    原样带过去。
   *  - **读与写之间有人插了一笔**：`save(next, current.revision)` 这把乐观锁
   *    照旧生效，冲突报 `canvas-conflict`。
   *  - **提案要改的东西已经不在**：`apply` 返回 undefined，报 `proposal-stale`。
   *
   * 只接受本画布上的提案：id 是 uuid，但跨画布接受会改到用户没看着的那份文档。
   */
  async acceptOne(canvasId: string, proposalId: string, store: CanvasStore = canvasStore): Promise<AcceptResult> {
    const pending = await this.list(canvasId)
    const proposal = pending.find(item => item.id === proposalId)
    if (proposal === undefined) return { ok: false, code: 'not-found', message: '该改动已处理或不存在' }

    const current = await store.read(canvasId)
    if (current === undefined) return { ok: false, code: 'not-found', message: '画布不存在' }

    const next = ProposalStore.apply(current, proposal.change)
    // `apply` 只保证「差分能应用」，不保证结果是一份合法文档：老版本的提案
    // 或手工改过的文件可能带着文档校验器挡掉的字段（`title` 不是字符串是最
    // 典型的一个）。不在这里拦住，`store.save` 会抛「malformed canvas
    // document」——那句话对用户没有意义，而且这条提案永远应用不了却一直占着
    // 队首。与下面那条分支同等处理：它已不可能再生效，移除并如实说明。
    if (next === undefined || coerceDocument(next) === undefined) {
      // 这条提案已经不可能再生效：`apply` 是纯函数，只要文档还缺它点名的
      // 节点/连线，以后每一次都会失败。留着它没有意义——它是队列的头，而
      // 界面只让用户点队首那一条，于是后面所有**本来能应用**的提案全被它
      // 挡住，用户只能自己想到去点「丢弃」才能继续。探针实测过：连点三次
      // 「接受」都是同一条 proposal-stale，队列一动不动。
      //
      // 删掉它而不是只报错：这也是「接受失败」与「接受成功」唯一的区别被
      // 保留的地方——错误照旧报给用户（他需要知道这条改动没生效），但这把
      // 卡住队列的钥匙由服务端自己收走。
      await this.remove(proposal.id)
      return {
        ok: false,
        code: 'proposal-stale',
        message: '这条改动引用的节点已经不在画布上了（可能被删掉了），无法应用。它已从待确认列表里移除，后面的改动可以继续。',
      }
    }

    try {
      const saved = await store.save(next, current.revision)
      await this.remove(proposal.id)
      return { ok: true, document: saved }
    } catch (error) {
      // 冲突要单独归类：客户端按这个码提示「画布刚被改过，重试一次」。
      if (error instanceof CanvasConflictError) {
        return { ok: false, code: 'canvas-conflict', message: '画布刚刚被改动过，这条改动没有写入。再试一次。' }
      }
      return { ok: false, code: 'canvas-failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 把一条提案应用到一份文档上。
   *
   * 纯函数：只读 `document` 与 `change`，返回新对象或 `undefined`（提案要求
   * 动的东西已经不在了——节点被别人删了之类）。返回 `undefined` 时调用方
   * 应当明确报错，而不是当成「什么都没发生」。
   *
   * 单独拿出来是因为它同时被两处用：**叠加**（算第 N 条提案的起点时，把
   * 前 N-1 条依次应用）与**接受**（应用用户点的这一条）。
   */
  static apply(document: CanvasDocument, change: CanvasProposalChange): CanvasDocument | undefined {
    const nodes = [...document.nodes]
    for (const node of change.addedNodes ?? []) {
      if (nodes.some(existing => existing.id === node.id)) return undefined
      nodes.push(node)
    }
    for (const update of change.updatedNodes ?? []) {
      const index = nodes.findIndex(node => node.id === update.id)
      // 提案要改的节点已经不在了（被用户删了）：让调用方明确报错，而不是
      // 假装这条提案生效了。
      if (index < 0) return undefined
      // 字段补丁，不是整份替换：用户在提议之后拖过的坐标、改过的标题要留着。
      // 只覆盖提案点名的键，其余读**当前文档**里的值。
      nodes[index] = mergeNodePatch(nodes[index]!, update)
    }
    const removed = new Set(change.removedNodeIds ?? [])
    const kept = removed.size === 0 ? nodes : nodes.filter(node => !removed.has(node.id))
    if (removed.size > 0 && kept.length === nodes.length) return undefined

    let connections = [...document.connections]
    for (const connection of change.addedConnections ?? []) {
      if (connections.some(existing => existing.id === connection.id)) return undefined
      // 端点是提案起草时点名的节点。用户在提议之后删掉其中任何一个，这条连线
      // 就没有意义了——旧实现只查 id 重复，于是能把一条**指向不存在节点**的
      // 边写进文档（探针实测：删掉下游节点后接受连线提案仍然成功）。画布自己
      // 的删除语义是「删节点连带删连线」，这里必须一致，否则用户看到一条
      // 「缺少端点」的幽灵边，它还会在每次渲染时被跳过、永远连不上任何东西。
      const endpoints = new Set(nodes.map(node => node.id))
      if (!endpoints.has(connection.fromNodeId) || !endpoints.has(connection.toNodeId)) return undefined
      connections.push(connection)
    }
    for (const update of change.updatedConnections ?? []) {
      const index = connections.findIndex(connection => connection.id === update.id)
      // 提案要改的连线已经不在了（用户断开过）：与节点同一条规矩，明确失败，
      // 不假装生效。
      if (index < 0) return undefined
      connections[index] = update.role === undefined
        ? connections[index]!
        : withRole(connections[index]!, update.role)
    }
    const droppedEdges = new Set(change.removedConnectionIds ?? [])
    if (droppedEdges.size > 0) {
      const next = connections.filter(connection => !droppedEdges.has(connection.id))
      if (next.length === connections.length) return undefined
      connections = next
    }
    // 删掉的节点必须连带删掉它的连线，与画布自己的删除语义一致；漏了这一步
    // 会留下指向不存在节点的边，连线层画的时候直接跳过，用户看到一个「缺少
    // 端点」的幽灵边。
    if (removed.size > 0) {
      connections = connections.filter(edge => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId))
    }
    // 分组同理：用户在画布上把几个节点框成一组，Agent 删掉其中一个，组里就会
    // 留下一个指向不存在节点的 id。画布自己删节点时走的是 `pruneGroupsField`
    // （去掉悬空成员、清空则整个组消失、没有 groups 字段时保持没有），提案这
    // 条路径漏了它——探针实测删完节点后 `groups[0].nodeIds` 仍指着那个 id。
    // 复用同一个函数，两种删除语义不各写一套。
    const groups = removed.size === 0
      ? document.groups
      : pruneGroupsField(document.groups, new Set(kept.map(node => node.id)))

    const next: CanvasDocument = {
      ...document,
      ...change.title === undefined ? {} : { title: change.title },
      nodes: kept,
      connections,
    }
    // 「没有 groups 字段」必须继续是没有：1429 份老画布都不带它，写回一个
    // `groups: []` 等于 Agent 第一次删节点就改写了它们的形态。
    if (groups === undefined) delete next.groups
    else next.groups = groups
    return next
  }
}

/**
 * 把一份字段补丁合到一个现有节点上。
 *
 * 只覆盖补丁里出现过的键——`fields` 里的顶层字段，以及 `metadata` 里的逐键。
 * `metadata` 是整体替换里最危险的一处：整份替换会连带把用户在这次提议之后写
 * 上去的其它 metadata（换过的模型、刚点上的 cast）抹掉，所以必须逐键合。
 */
function mergeNodePatch(node: CanvasNode, update: CanvasProposalNodeUpdate): CanvasNode {
  const merged: CanvasNode = { ...node, ...update.fields ?? {} }
  const removedKeys = new Set(update.removedMetadataKeys ?? [])
  const metadata: Record<string, unknown> = { ...node.metadata, ...update.metadata ?? {} }
  for (const key of removedKeys) delete metadata[key]
  if (Object.keys(metadata).length === 0) delete merged.metadata
  else merged.metadata = metadata
  return merged
}

/** 新格式：`{id, fields?, metadata?, removedMetadataKeys?}`。 */
function isPatchShape(patch: Record<string, unknown>): boolean {
  for (const field of ['fields', 'metadata'] as const) {
    if (patch[field] !== undefined && (patch[field] === null || typeof patch[field] !== 'object')) return false
  }
  if (patch.removedMetadataKeys !== undefined
    && (!Array.isArray(patch.removedMetadataKeys) || !patch.removedMetadataKeys.every(key => typeof key === 'string'))) return false
  return true
}

/**
 * 旧格式：整份节点（改造前 `updatedNodes` 存的就是它）。
 *
 * 至少要认出 `type` 与几何，否则一个形状坏掉的补丁也会被当成旧节点放过去。
 * 旧文件是真实存在的：`proposals/` 是旁路目录，没有任何清理逻辑，用户机器上
 * 可能躺着改造前的提案。
 */
function isLegacyNodeShape(node: Record<string, unknown>): boolean {
  return typeof node.type === 'string' && typeof node.title === 'string'
    && typeof node.x === 'number' && typeof node.y === 'number'
    && typeof node.width === 'number' && typeof node.height === 'number'
}

/**
 * 把 `updatedNodes` 统一成补丁数组。
 *
 * 旧格式保留它当初想改的字段（`title`/`x`/`y`/`width`/`height` 与整份
 * `metadata`），丢掉 `type`/`id`：改节点的类型不是这套工具做过的事，拿它当
 * 补丁应用反而可能让一条旧提案把一个节点变成另一种东西。
 */
function normalizeNodeUpdates(raw: unknown[] | undefined): CanvasProposalNodeUpdate[] | undefined {
  if (raw === undefined) return undefined
  return raw.map(entry => {
    const value = entry as Record<string, unknown> & Partial<CanvasNode> & { id: string }
    if (isPatchShape(value) && !isLegacyNodeShape(value)) return value as CanvasProposalNodeUpdate
    const fields: Record<string, unknown> = {}
    for (const key of ['title', 'x', 'y', 'width', 'height'] as const) {
      if (value[key] !== undefined) fields[key] = value[key]
    }
    return {
      id: value.id,
      ...Object.keys(fields).length === 0 ? {} : { fields },
      ...value.metadata === undefined ? {} : { metadata: value.metadata },
    } as CanvasProposalNodeUpdate
  })
}

function coerceProposal(value: unknown): CanvasProposal | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.canvasId !== 'string' || raw.canvasId === '') return undefined
  if (typeof raw.tool !== 'string' || typeof raw.summary !== 'string') return undefined
  if (typeof raw.baseRevision !== 'number' || typeof raw.createdAt !== 'number') return undefined
  if (raw.change === null || typeof raw.change !== 'object') return undefined
  const change = raw.change as Record<string, unknown>
  const isArray = (field: unknown): boolean => field === undefined || Array.isArray(field)
  if (!isArray(change.addedNodes) || !isArray(change.updatedNodes) || !isArray(change.removedNodeIds)
    || !isArray(change.addedConnections) || !isArray(change.updatedConnections)
    || !isArray(change.removedConnectionIds)) return undefined
  // `title` 会被原样写进文档，而文档的校验器（`isDocument`）要求它是字符串。
  // 不在这里挡住的话：这条提案读得出来、排进队列、接受时由 `store.save` 抛
  // 「malformed canvas document」——而 `apply` 是成功返回的，所以「应用不了就
  // 自己出队」那条路走不到它，它会永久占着队首，用户点多少次都一样，后面
  // 本来能用的提案全被挡住。形状不对就当坏文件跳过，与这里其余字段一致。
  if (change.title !== undefined && typeof change.title !== 'string') return undefined
  // 节点本身用画布自己的校验器过一遍：提案里的节点最终会被写进 pages/，
  // 形状不合格的必须在**入库时**就被挡住，而不是等到接受时才炸。
  for (const node of (change.addedNodes as unknown[] | undefined) ?? []) {
    const probe = { version: 2, id: '__probe__', title: '', revision: 1, viewport: { x: 0, y: 0, k: 1 }, background: 'lines', nodes: [node], connections: [], createdAt: 0, updatedAt: 0 }
    if (coerceDocument(probe) === undefined) return undefined
  }
  // 补丁只要 `id` 是字符串就必须认，其余字段可选；`fields`/`metadata` 若
  // 出现必须是对象。形状在这里挡，`apply` 那边只做合并。
  for (const update of (change.updatedNodes as unknown[] | undefined) ?? []) {
    if (update === null || typeof update !== 'object') return undefined
    const patch = update as Record<string, unknown>
    if (typeof patch.id !== 'string' || patch.id === '') return undefined
    if (!isPatchShape(patch) && !isLegacyNodeShape(patch)) return undefined
  }
  // 连线补丁同理：`id` 必须是字符串，`role` 出现就必须是认得的角色。认不得的
  // 角色会经 `withRole` 原样写进文档，而那是一个只在画布渲染时才露出来的
  // 坏值。读入时就当坏文件跳过。
  for (const update of (change.updatedConnections as unknown[] | undefined) ?? []) {
    if (update === null || typeof update !== 'object') return undefined
    const patch = update as Record<string, unknown>
    if (typeof patch.id !== 'string' || patch.id === '') return undefined
    if (patch.role !== undefined && !(CONNECTION_ROLES as readonly unknown[]).includes(patch.role)) return undefined
  }
  const updatedNodes = normalizeNodeUpdates(change.updatedNodes as unknown[] | undefined)
  return {
    id: raw.id,
    canvasId: raw.canvasId,
    tool: raw.tool,
    summary: raw.summary,
    // 旧提案没有 counts（改造前只写了中文句子）。不补一个从 change 反推的：
    // 反推出来的数字可能与当初那句 summary 不一致，而界面对「没有 counts」
    // 已经有明确的退路——显示 summary 原文。
    ...isCountsShape(raw.counts) ? { counts: raw.counts as CanvasProposal['counts'] } : {},
    baseRevision: raw.baseRevision,
    createdAt: raw.createdAt,
    // 归一在读取时做，`apply` 于是只有一种形状要处理。旧提案（整份节点）
    // 不会被当成坏文件丢掉，也不会「接受成功但什么都没改」。
    change: {
      ...raw.change as CanvasProposalChange,
      ...updatedNodes === undefined ? {} : { updatedNodes },
    },
  }
}

/**
 * `counts` 的形状：出现的每个键都必须是非负整数，`title` 必须是字符串。
 *
 * 严格因为它是**渲染输入**：一个 `NaN` 或字符串数字进了文案会变成
 * 「添加 NaN 个节点」。形状不对就当没有——界面退回 summary，比显示一句
 * 坏文案强。
 */
function isCountsShape(value: unknown): boolean {
  if (value === undefined) return false
  if (value === null || typeof value !== 'object') return false
  const counts = value as Record<string, unknown>
  for (const key of ['addedNodes', 'updatedNodes', 'removedNodes', 'addedConnections', 'updatedConnections', 'removedConnections'] as const) {
    const field = counts[key]
    if (field !== undefined && !(typeof field === 'number' && Number.isInteger(field) && field >= 0)) return false
  }
  return counts.title === undefined || typeof counts.title === 'string'
}

export const proposalStore = new ProposalStore()

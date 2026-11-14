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
import type { CanvasDocument, CanvasProposal, CanvasProposalChange } from './protocol.ts'
import { canvasStore, CanvasConflictError, coerceDocument, readJson, safeId, writeJsonAtomic, type CanvasStore } from './canvas-store.ts'
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
    let names: string[]
    try {
      names = await fs.readdir(this.dir())
    } catch {
      return []
    }
    const found: CanvasProposal[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const value = await readJson(path.join(this.dir(), name))
      const proposal = coerceProposal(value)
      // 读不懂的提案直接跳过，不猜。一条坏文件不该让整份列表消失。
      if (proposal !== undefined && proposal.canvasId === canvasId) found.push(proposal)
    }
    // 目录顺序由文件系统决定，必须自己排；同一毫秒内的两条提案用 id 兜底，
    // 否则叠加顺序会随机器而变。
    return found.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  /** 一份画布上所有画布的提案条数（一次读目录，给列表页用）。 */
  async countByCanvas(): Promise<Record<string, number>> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir())
    } catch {
      return {}
    }
    const counts: Record<string, number> = {}
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const proposal = coerceProposal(await readJson(path.join(this.dir(), name)))
      if (proposal === undefined) continue
      counts[proposal.canvasId] = (counts[proposal.canvasId] ?? 0) + 1
    }
    return counts
  }

  async add(proposal: Omit<CanvasProposal, 'id' | 'createdAt'>): Promise<CanvasProposal> {
    await this.ensure()
    const id = randomUUID()
    const created: CanvasProposal = { ...proposal, id, createdAt: Date.now() }
    await writeJsonAtomic(this.filePath(id), created)
    return created
  }

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
    if (next === undefined) {
      return {
        ok: false,
        code: 'proposal-stale',
        message: '这条改动引用的节点已经不在画布上了（可能被删掉了），无法应用。',
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
      nodes[index] = update
    }
    const removed = new Set(change.removedNodeIds ?? [])
    const kept = removed.size === 0 ? nodes : nodes.filter(node => !removed.has(node.id))
    if (removed.size > 0 && kept.length === nodes.length) return undefined

    let connections = [...document.connections]
    for (const connection of change.addedConnections ?? []) {
      if (connections.some(existing => existing.id === connection.id)) return undefined
      connections.push(connection)
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

    return {
      ...document,
      ...change.title === undefined ? {} : { title: change.title },
      nodes: kept,
      connections,
    }
  }
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
    || !isArray(change.addedConnections) || !isArray(change.removedConnectionIds)) return undefined
  // 节点本身用画布自己的校验器过一遍：提案里的节点最终会被写进 pages/，
  // 形状不合格的必须在**入库时**就被挡住，而不是等到接受时才炸。
  for (const node of (change.addedNodes as unknown[] | undefined) ?? []) {
    const probe = { version: 2, id: '__probe__', title: '', revision: 1, viewport: { x: 0, y: 0, k: 1 }, background: 'lines', nodes: [node], connections: [], createdAt: 0, updatedAt: 0 }
    if (coerceDocument(probe) === undefined) return undefined
  }
  return {
    id: raw.id,
    canvasId: raw.canvasId,
    tool: raw.tool,
    summary: raw.summary,
    baseRevision: raw.baseRevision,
    createdAt: raw.createdAt,
    change: raw.change as CanvasProposalChange,
  }
}

export const proposalStore = new ProposalStore()

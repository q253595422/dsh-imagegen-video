/**
 * 画布视频节点的「成片认领」：把已经落盘的历史片段接回它所属的节点。
 *
 * WHY 需要这一层：画布原本只通过**宿主内存里的任务队列**认识一个片段。
 * 那个队列重启即空、终态只保留最近 100 条，于是一个仍在 `generating` 的占位
 * 节点只要在队列里找不到自己的 `taskId`，就会被判成「视频任务已丢失」——
 * 哪怕上游早已出片、字节已经写进 `videos/index.json`。两套数据之间原本没有
 * 任何 id 关联，所以这种误判没有任何自愈路径。
 *
 * 现在历史条目持久化 `canvas.nodeId`（见 `protocol.ts` 的
 * `VideoHistoryEntry.canvas`），认领就有了一个**落盘的**依据：重启不会带走它。
 * 老条目没有这个字段，因此另有一条严格受限的兜底（见 {@link claimableClips}）。
 *
 * 本模块不碰 React / DOM / 网络：调用方把节点、历史、文案递进来，拿回该改哪些
 * 节点。这样每条规则都能在离线套件里直接验。
 */

import type { CanvasDocument, CanvasNode, CanvasVideoRef, VideoHistoryEntry } from '../../protocol.ts'
import { nodeMetadata } from './node-model.ts'

/** 一次认领：把哪一段片段填进哪个节点。 */
export interface ClipClaim {
  nodeId: string
  video: CanvasVideoRef
}

/** 这些节点正在等一个片段；只有它们会被认领改写。 */
function isAwaitingClip(node: CanvasNode, lostError: string): boolean {
  if (node.type !== 'video') return false
  const metadata = nodeMetadata(node)
  // 已经拿到片段的不再动：重复认领会让一次重试的结果被旧片段覆盖。
  if (metadata.video !== undefined && metadata.video.url !== '') return false
  if (metadata.status === 'generating') return true
  // 仅限「被判成丢失」的错误节点。真正渲染失败（上游报错）的节点必须保留
  // 它自己的错误，否则用户点重试的动机被抹掉了。
  if (metadata.status !== 'error') return false
  // 标记优先：它不随界面语言变。旧文档没有这个字段，才退回去比对当轮文案。
  return metadata.failure === 'task-lost' || metadata.error === lostError
}

/** 从一条历史条目里取第一个可播放的片段。 */
function clipOf(entry: VideoHistoryEntry): CanvasVideoRef | undefined {
  const file = entry.videos[0]
  if (file === undefined || file.url === '') return undefined
  return {
    url: file.url,
    mime: file.mime,
    ...file.duration === undefined ? {} : { duration: file.duration },
    entryId: entry.id,
  }
}

/**
 * 算出应该被认领的片段。
 *
 * 两条规则，按可信度从高到低，一条历史条目最多被认领一次（同一条片段填进
 * 两个节点会产生两张指向同一 entryId 的卡，删除、收藏、拼接的语义都会变糊）：
 *
 * 1. **lineage 精确匹配**：`entry.canvas.nodeId === node.id`。这是生成时写下的
 *    归属，不受重启、清空队列、重新打开画布影响，也没有歧义。
 * 2. **老条目兜底**：只在节点被判成「丢失」时启用，且要求
 *    `prompt + mode + model + seconds` 全部相等、候选**恰好一条**、且这条历史
 *    还没被任何节点的 `video.entryId` 引用。四个字段全等已经很难误配；再加上
 *    「唯一候选」和「未被引用」，宁可留着丢失状态让用户手动重试，也不把一段
 *    别人的片子塞进来——错误地显示成成功比显示成丢失更难被发现。
 *
 * 已被画布上任意节点引用过的历史条目不参与任何一条规则。
 */
export function claimableClips(input: {
  document: CanvasDocument
  videoHistory: readonly VideoHistoryEntry[]
  /** 当前语言的「视频任务已丢失」文案；用来识别被判丢失的节点。 */
  lostError: string
}): ClipClaim[] {
  const { document, videoHistory, lostError } = input
  const nodes = document.nodes

  const usedEntryIds = new Set<string>()
  for (const node of nodes) {
    const metadata = nodeMetadata(node)
    if (metadata.video?.entryId !== undefined) usedEntryIds.add(metadata.video.entryId)
  }

  const byNodeId = new Map<string, VideoHistoryEntry>()
  const unclaimed: VideoHistoryEntry[] = []
  for (const entry of videoHistory) {
    if (usedEntryIds.has(entry.id)) continue
    const owner = entry.canvas?.nodeId
    // 历史是新到旧；同一个节点若有多条归属（重试过），保留最先遇到的即为最新。
    if (owner !== undefined) {
      if (!byNodeId.has(owner)) byNodeId.set(owner, entry)
    } else {
      unclaimed.push(entry)
    }
  }

  const claims: ClipClaim[] = []
  const claimedEntryIds = new Set<string>()

  for (const node of nodes) {
    if (!isAwaitingClip(node, lostError)) continue
    const metadata = nodeMetadata(node)

    // 规则 1：生成时写下的归属。只认这个节点自己的那条。
    const exact = byNodeId.get(node.id)
    if (exact !== undefined && !claimedEntryIds.has(exact.id)) {
      const video = clipOf(exact)
      if (video !== undefined) {
        claimedEntryIds.add(exact.id)
        claims.push({ nodeId: node.id, video })
        continue
      }
    }

    // 规则 2 只对「被判丢失」的节点生效：一个还在 generating 的节点本来就该
    // 继续等队列，拿一条老片段去填它会让真正在跑的那次渲染的结果无处可去。
    if (metadata.status !== 'error') continue
    const prompt = metadata.prompt?.trim()
    if (prompt === undefined || prompt === '') continue
    const candidates = unclaimed.filter(entry =>
      !claimedEntryIds.has(entry.id)
      && entry.prompt.trim() === prompt
      && entry.mode === metadata.videoMode
      && entry.model === metadata.model
      && entry.seconds === metadata.seconds)
    if (candidates.length !== 1) continue
    const [match] = candidates
    if (match === undefined) continue
    const video = clipOf(match)
    if (video === undefined) continue
    claimedEntryIds.add(match.id)
    claims.push({ nodeId: node.id, video })
  }

  return claims
}

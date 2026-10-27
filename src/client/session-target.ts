import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** The fields needed to present explicit conversation targets. */
export type SessionTargetSnapshot = Pick<ReturnType<ISessions['list']['getSnapshot']>, 'ids' | 'byId'>

/** A session the user can explicitly choose as the destination for an image. */
export interface ConversationSessionTarget {
  id: SessionId
  title: string
}

/**
 * Read only DSH's authoritative current selection; never infer from list order.
 *
 * 宿主列表快照的 `ids` 顺序是「最近活跃在前」这类展示顺序，不是用户意图：
 * 拿 `ids[0]` 兜底会把图片悄悄塞进一个用户没选过的历史会话，所以这里只认
 * `current` 这一个字段，取不到就让调用方去问用户。
 */
export function currentConversationSessionId(sessions: Pick<ISessions, 'list'> | undefined): SessionId | undefined {
  return sessions?.list.getSnapshot().current
}

/**
 * Build explicit targets from the host's listed sessions.
 *
 * @param snapshot - DSH's current session-list snapshot.
 * @returns listed sessions in host order, with the host-projected display title.
 */
export function conversationSessionTargets(snapshot: SessionTargetSnapshot | undefined): ConversationSessionTarget[] {
  // 宿主的列表快照不保证带 `ids`（测试替身与老宿主只给 `current`），
  // 缺了就当作「列不出来」，让调用方报 noSession 而不是崩在渲染里。
  if (snapshot === undefined || !Array.isArray(snapshot.ids)) return []
  return snapshot.ids.map(id => ({
    // displayTitle 是宿主按当前语言投影过的标题；只有老宿主没有它时才退回原始 title。
    id,
    title: snapshot.byId?.[id]?.displayTitle || snapshot.byId?.[id]?.title || String(id),
  }))
}

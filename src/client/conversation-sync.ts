import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationController, IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** Document event used to bridge chat tool results into the image workspace. */
export const CHAT_IMAGE_EVENT = 'dsh-imagegen:chat-images'

export interface ChatImageEventDetail {
  sessionId: SessionId
  refs: readonly ImageAttachmentRef[]
}

/** Composer-facing extension of the narrower public conversation interface. */
export type ConversationService = IConversation
  & Partial<Pick<ConversationController, 'createDraftImages' | 'releaseDraftImages'>>
  & ConversationDraftApi

/**
 * One browser-owned draft attachment. Identities are opaque branded strings at
 * runtime, and `kind` only exists on the shells that generalized drafts from
 * images to arbitrary files, so it stays optional here.
 */
export interface ConversationDraftAttachment {
  /** Registry id the composer input accepts. */
  readonly id: string
  /** Draft discriminator ('image' | 'file') on the generalized shells. */
  readonly kind?: string
}

/**
 * Draft verbs the 0.1.5+ shells expose in place of the image-only pair
 * (`createDraftImages` / `releaseDraftImages`). Declared structurally because
 * the pinned ui-conversation typings predate the rename.
 */
export interface ConversationDraftApi {
  /** 0.1.5+: register files as drafts owned by the target session. */
  createDrafts?(sessionId: SessionId, files: readonly File[]): readonly ConversationDraftAttachment[]
  /** 0.1.5+: release drafts created by `createDrafts`. */
  releaseDraftAttachments?(attachments: readonly ConversationDraftAttachment[]): void
}

/**
 * The slice of the per-session composer input facade this plugin drives. Both
 * verb pairs are optional: the shells name the draft rail `addImages` /
 * `removeImage` up to 0.1.2, and `addAttachments` / `removeAttachment` after
 * drafts stopped being images only.
 */
export interface ConversationInput {
  addImages?(ids: readonly string[]): boolean
  addAttachments?(ids: readonly string[]): boolean
  removeImage?(id: string): void
  removeAttachment?(id: string): boolean
  readonly state: { getSnapshot(): { readonly draft: string } }
  setDraft(text: string): void
}

/**
 * Register an image through the host's complete composer and durable-edit path.
 *
 * 顺序是有约束的，不能调换：先建草稿 → 再交给 composer 附件栏 → 再落盘
 * （`attachImage` 让 `/edit_image` 之后还能找回这张图）→ 最后补提示词。任何
 * 一步失败都要把前面的痕迹撤掉，否则会话里会留下一条指向已失败图片的
 * 附件 chip，用户点发送才炸。
 *
 * @param options - target session, browser draft, composer, and durable staging API.
 */
export async function addConversationImageDraft(options: {
  conversation: ConversationService
  sessionId: SessionId
  sessionScope: NonNullable<ReturnType<ISessions['scope']>>
  file: File
  dataUrl: string
  name: string
  prompt: string
  attachImage: (sessionId: string, dataUrl: string, name: string) => Promise<void>
  unavailableMessage: string
  busyMessage: string
}): Promise<void> {
  const { conversation, sessionId, sessionScope, file, dataUrl, name, prompt, attachImage } = options
  let attachments: readonly ConversationDraftAttachment[] = []
  let added = false
  try {
    const created = createConversationDrafts(conversation, sessionId, [file])
    if (created === undefined) throw new Error(options.unavailableMessage)
    attachments = created
    const input = conversationInput(conversation.input.for(sessionScope))
    const accepted = addConversationAttachments(input, attachments.map(attachment => attachment.id))
    if (accepted === undefined) throw new Error(options.unavailableMessage)
    // composer 已经有一批待发附件时会拒绝新的：此时草稿没人接手，交给 catch 释放。
    if (!accepted) throw new Error(options.busyMessage)
    added = true
    try {
      await attachImage(String(sessionId), dataUrl, name)
    } catch (error) {
      // 落盘失败：composer 里那个 chip 还挂着，先摘掉再往外抛。
      for (const attachment of attachments) removeConversationAttachment(input, attachment.id)
      added = false
      throw error
    }
    // 只在用户没写东西时补提示词，别覆盖正在编辑的草稿正文。
    if (input.state.getSnapshot().draft.trim() === '' && prompt.trim() !== '') input.setDraft(prompt.trim())
  } catch (error) {
    if (!added) releaseConversationDrafts(conversation, attachments)
    throw error
  }
}

/** Narrow one session input facade onto the verb pair this plugin drives. */
export function conversationInput(input: unknown): ConversationInput {
  return input as ConversationInput
}

/**
 * Register browser files as composer drafts, whichever verb pair the running
 * shell exposes.
 * @param conversation - the conversation service resolved from the client context.
 * @param sessionId - session that owns the drafts.
 * @param files - browser files to register.
 * @returns the created drafts, or undefined when the shell exposes neither verb.
 */
export function createConversationDrafts(
  conversation: ConversationService,
  sessionId: SessionId,
  files: readonly File[],
): readonly ConversationDraftAttachment[] | undefined {
  if (typeof conversation.createDrafts === 'function') return conversation.createDrafts(sessionId, files)
  if (typeof conversation.createDraftImages === 'function') return conversation.createDraftImages(files)
  return undefined
}

/**
 * Release drafts made by {@link createConversationDrafts}. Best-effort: a shell
 * with neither verb never handed drafts out, so there is nothing to release.
 * @param conversation - the conversation service resolved from the client context.
 * @param attachments - drafts to release.
 */
export function releaseConversationDrafts(
  conversation: ConversationService,
  attachments: readonly ConversationDraftAttachment[],
): void {
  if (attachments.length === 0) return
  if (typeof conversation.releaseDraftAttachments === 'function') {
    conversation.releaseDraftAttachments(attachments)
    return
  }
  if (typeof conversation.releaseDraftImages === 'function') conversation.releaseDraftImages(attachments as never)
}

/**
 * Append draft ids to the composer rail.
 * @param input - session input facade from `conversation.input.for(scope)`.
 * @param ids - draft ids to append.
 * @returns whether the composer accepted them; undefined when the shell
 * exposes neither verb (its composer has no attachment rail this plugin knows).
 */
export function addConversationAttachments(input: ConversationInput, ids: readonly string[]): boolean | undefined {
  if (typeof input.addAttachments === 'function') return input.addAttachments(ids)
  if (typeof input.addImages === 'function') return input.addImages(ids)
  return undefined
}

/**
 * Remove one draft id from the composer rail.
 * @param input - session input facade from `conversation.input.for(scope)`.
 * @param id - draft id to drop.
 */
export function removeConversationAttachment(input: ConversationInput, id: string): void {
  if (typeof input.removeAttachment === 'function') {
    input.removeAttachment(id)
    return
  }
  if (typeof input.removeImage === 'function') input.removeImage(id)
}

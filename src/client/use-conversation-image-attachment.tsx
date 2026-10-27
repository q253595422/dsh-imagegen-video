import { useCallback, useEffect, useState } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { GeneratedImage } from '../protocol.ts'
import { addConversationImageDraft } from './conversation-sync.ts'
import type { ConversationService } from './conversation-sync.ts'
import { conversationSessionTargets, currentConversationSessionId, type ConversationSessionTarget } from './session-target.ts'

export interface PreparedConversationImage {
  file: File
  dataUrl: string
}

interface ConversationImageAttachmentMessages {
  noSession: string
  unavailable: string
  busy: string
}

interface PendingConversationImage {
  image: GeneratedImage
  index: number
  actionKey: number | string
}

/**
 * Coordinate native composer attachment with a safe session fallback.
 *
 * The currently selected session always comes from DSH's list snapshot. When
 * that authoritative value is absent (or cannot resolve a scope), callers get
 * an explicit target picker; list order is never treated as user intent.
 *
 * 这个 hook 只服务图片侧：视频片段走的是 `ImageGenPanel` 里自己的
 * `addClipToConversation`，那条链路没有 `/edit_image` 式的持久化暂存步骤，
 * 硬塞进同一个 hook 会把两种语义压成一种。
 */
export function useConversationImageAttachment(options: {
  sessions?: ISessions
  conversation?: ConversationService
  prompt: string
  prepareImage: (image: GeneratedImage, index: number) => Promise<PreparedConversationImage>
  attachImage: (sessionId: string, dataUrl: string, name: string) => Promise<void>
  messages: ConversationImageAttachmentMessages
  onError: (error: unknown) => void
  onAdded: () => void
}) {
  const { sessions, conversation } = options
  // 用 state + effect 跟随宿主列表，而不是 useSyncExternalStore：宿主的
  // `getSnapshot()` 每次可能返回新对象，直接交给 useSyncExternalStore 会被
  // 当成「值变了」而无限重渲染。只在订阅回调里 setState，就不会自激。
  const [snapshot, setSnapshot] = useState(() => sessions?.list.getSnapshot())
  useEffect(() => {
    if (sessions === undefined) {
      setSnapshot(undefined)
      return
    }
    const sync = (): void => { setSnapshot(sessions.list.getSnapshot()) }
    sync()
    return sessions.list.subscribe(sync)
  }, [sessions])
  const targets = conversationSessionTargets(snapshot)
  const [pending, setPending] = useState<PendingConversationImage | null>(null)
  const [busyKey, setBusyKey] = useState<number | string | null>(null)

  const perform = useCallback(async (
    image: GeneratedImage,
    index: number,
    actionKey: number | string,
    sessionId: SessionId,
  ): Promise<void> => {
    if (sessions === undefined || conversation === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }
    const sessionScope = sessions.scope(sessionId)
    if (sessionScope === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }

    setBusyKey(actionKey)
    try {
      const prepared = await options.prepareImage(image, index)
      await addConversationImageDraft({
        conversation,
        sessionId,
        sessionScope,
        file: prepared.file,
        dataUrl: prepared.dataUrl,
        name: prepared.file.name,
        prompt: options.prompt,
        attachImage: options.attachImage,
        unavailableMessage: options.messages.unavailable,
        busyMessage: options.messages.busy,
      })
      options.onAdded()
    } catch (error) {
      options.onError(error)
    } finally {
      setBusyKey(null)
    }
  }, [conversation, options, sessions])

  const add = useCallback((image: GeneratedImage, index: number, actionKey: number | string = index): void => {
    if (busyKey !== null || pending !== null) return
    if (sessions === undefined || conversation === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }

    const current = currentConversationSessionId(sessions)
    if (current !== undefined && sessions.scope(current) !== undefined) {
      void perform(image, index, actionKey, current)
      return
    }

    const currentTargets = conversationSessionTargets(sessions.list.getSnapshot())
    if (currentTargets.length === 0) {
      // 一个会话都没有时列不出选项，弹空选择器只会让人卡住。
      options.onError(new Error(options.messages.noSession))
      return
    }
    setPending({ image, index, actionKey })
  }, [busyKey, conversation, options, pending, perform, sessions])

  const selectTarget = useCallback((sessionId: SessionId): void => {
    if (pending === null || sessions === undefined) return
    // Revalidate against the latest authoritative list after the user choice:
    // 选择器开着的时候会话可能已被删除，落进一个已不存在的会话比报错更糟。
    const stillListed = conversationSessionTargets(sessions.list.getSnapshot()).some(target => target.id === sessionId)
    if (!stillListed) {
      setPending(null)
      options.onError(new Error(options.messages.unavailable))
      return
    }
    const selected = pending
    setPending(null)
    void perform(selected.image, selected.index, selected.actionKey, sessionId)
  }, [options, pending, perform, sessions])

  const cancelPicker = useCallback((): void => { setPending(null) }, [])

  return { add, busyKey, pending, targets, selectTarget, cancelPicker }
}

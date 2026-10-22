/**
 * Panel view mounting.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the panel takes over the center column at
 * the DOM level: a container is appended inside the conversation grid item
 * (an extra trailing child React never manages), and a stylesheet rule hides
 * the conversation content while the panel is active. Toggling is a data
 * attribute on <html> — no React involvement, so the conversation subtree
 * underneath stays mounted and stateful.
 *
 * Shell compatibility: the center column is `[data-pane="conversation"]` on
 * legacy shells and `[class*="centerCol"]` on the rc.6+ AppFrame layout (the
 * same dual selector the dsh-ssh / task-board panels use); both are queried
 * and both get the `position: relative` base in panel.module.css.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { createRoot, type Root } from 'react-dom/client'
import type { ImageGenApi } from './api.ts'
import type { ImageGenController } from './controller.ts'
import { ImageGenPanel } from './ImageGenPanel.tsx'
import type { ImageGenScope } from './settings-scope.ts'
import type { ConversationService } from './conversation-sync.ts'
import { subscribeImageGenLanguage, tt } from './helpers.ts'
import css from './panel.module.css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-imagegen-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-imagegen-active'
const RESIZER_SELECTOR = '[data-dsh-imagegen-chat-resizer]'
const CHAT_WIDTH_STORAGE_KEY = 'dsh-imagegen:chat-width'
const CHAT_MIN_WIDTH = 320
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'imagegen'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

function readChatWidth(): number | undefined {
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value >= CHAT_MIN_WIDTH ? value : undefined
  } catch {
    return undefined
  }
}

function writeChatWidth(value: number): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(value)))
  } catch {
    // Private browsing and embedded shells may disable localStorage.
  }
}

function applyChatWidth(column: HTMLElement, clientX: number): void {
  const bounds = column.getBoundingClientRect()
  const max = Math.max(CHAT_MIN_WIDTH, bounds.width * 0.7)
  const width = Math.min(max, Math.max(CHAT_MIN_WIDTH, bounds.right - clientX))
  column.style.setProperty('--dsh-imagegen-chat-width', `${Math.round(width)}px`)
  writeChatWidth(width)
}

/**
 * Keep the separator out of the tab order while the stylesheet hides it.
 *
 * `.chatResizer` starts as `display: none` and only becomes a flex box while
 * the panel is active, but `tabIndex = 0` stays on the element either way: a
 * keyboard or screen-reader user tabs into a separator that has no visible
 * focus ring and no keyboard-reachable size. The handle is created outside the
 * React tree, so visibility has to be observed on the element itself.
 * @param resizer - the handle whose tab order follows its rendered state.
 * @returns disposer stopping the observation.
 */
function watchChatResizerVisibility(resizer: HTMLDivElement): () => void {
  // Without ResizeObserver there is no way to notice the toggle, so leaving
  // `tabIndex = 0` is truer than freezing the handle at -1 forever.
  if (typeof ResizeObserver === 'undefined') return () => {}
  // `display: none` (on the handle or an ancestor) leaves no client rects.
  const visible = (): boolean => resizer.getClientRects().length > 0
  const apply = (): void => {
    if (visible()) {
      resizer.tabIndex = 0
      resizer.removeAttribute('aria-hidden')
      return
    }
    // A hidden focused element must not carry aria-hidden: browsers drop the
    // attribute and warn. Focus lands here only via the keyboard.
    if (document.activeElement === resizer) resizer.blur()
    resizer.tabIndex = -1
    resizer.setAttribute('aria-hidden', 'true')
  }
  apply()
  // Hiding is a size change too (the box collapses to 0×0 and comes back),
  // and a freshly observed target reports once, so no extra initial pass.
  const observer = new ResizeObserver(() => { apply() })
  observer.observe(resizer)
  return () => { observer.disconnect() }
}

/** Create the visible handle that separates the image workspace and chat. */
function createChatResizer(column: HTMLElement): HTMLDivElement {
  const resizer = document.createElement('div')
  resizer.dataset.dshImagegenChatResizer = ''
  resizer.className = css.chatResizer
  resizer.setAttribute('role', 'separator')
  resizer.setAttribute('aria-orientation', 'vertical')
  resizer.setAttribute('aria-label', tt('chat.resizeHint'))
  resizer.tabIndex = 0
  // This handle is created once and lives outside the React tree, so nothing
  // re-renders it on a DSH language switch. The subscription is wired in
  // `ensure` (where the element's lifetime is owned) rather than here, because
  // a replaced resizer must be able to release it.
  const saved = readChatWidth()
  if (saved !== undefined) column.style.setProperty('--dsh-imagegen-chat-width', `${saved}px`)

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    resizer.setPointerCapture?.(event.pointerId)
    const onMove = (move: PointerEvent): void => { applyChatWidth(column, move.clientX) }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      resizer.releasePointerCapture?.(event.pointerId)
      document.documentElement.style.removeProperty('cursor')
      document.documentElement.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.documentElement.style.setProperty('cursor', 'col-resize')
    document.documentElement.style.setProperty('user-select', 'none')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const bounds = column.getBoundingClientRect()
    const current = column.style.getPropertyValue('--dsh-imagegen-chat-width')
    const currentWidth = Number.parseFloat(current) || bounds.width * 0.36
    const delta = event.key === 'ArrowLeft' ? -24 : 24
    applyChatWidth(column, bounds.right - currentWidth - delta)
  }
  resizer.addEventListener('pointerdown', onPointerDown)
  resizer.addEventListener('keydown', onKeyDown)
  return resizer
}

/**
 * Mount the panel React tree into the center column and bind its visibility
 * to the controller's panelOpen state.
 * @param controller - the panel controller driving the view.
 * @param api - the image-generation API client the panel operates through.
 * @param scope - the settings scope (config status banner).
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountPanel(
  controller: ImageGenController,
  api: ImageGenApi,
  scope: ImageGenScope,
  services: {
    sessions?: ISessions
    conversation?: ConversationService
  } = {},
): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let resizer: HTMLDivElement | undefined
  /** Releases the resizer's language subscription; re-pointed in `ensure`. */
  let stopResizerLanguageWatch: (() => void) | undefined
  /** Releases the resizer's visibility observation; re-pointed in `ensure`. */
  let stopResizerVisibilityWatch: (() => void) | undefined
  let panelActive = false

  const renderPanel = (): void => {
    root?.render(<ImageGenPanel api={api} scope={scope} active={panelActive} {...services} />)
  }

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      // The conversation pane was replaced; drop the stale tree and remount.
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
      resizer?.remove()
      resizer = undefined
      // The old resizer is gone with its element, so its language subscription
      // would keep writing to a detached node forever.
      stopResizerLanguageWatch?.()
      stopResizerLanguageWatch = undefined
      stopResizerVisibilityWatch?.()
      stopResizerVisibilityWatch = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshImagegenView = ''
    container.className = css.view
    column.appendChild(container)
    root = createRoot(container)
    renderPanel()
    resizer = column.querySelector<HTMLDivElement>(RESIZER_SELECTOR) ?? createChatResizer(column)
    if (resizer.parentElement !== column) column.appendChild(resizer)
    // Re-point the language subscription at whichever element now owns the
    // handle: a re-created resizer starts in the language of its creation.
    stopResizerLanguageWatch?.()
    resizer.setAttribute('aria-label', tt('chat.resizeHint'))
    stopResizerLanguageWatch = subscribeImageGenLanguage(() => {
      resizer?.setAttribute('aria-label', tt('chat.resizeHint'))
    })
    stopResizerVisibilityWatch?.()
    stopResizerVisibilityWatch = watchChatResizerVisibility(resizer)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    panelActive = controller.getSnapshot().panelOpen
    if (panelActive) {
      // Single-occupant center column: opening this panel must evict sibling
      // panels (task board / ssh), both their html attributes and their
      // controller states, otherwise the visibility rules fight.
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
    renderPanel()
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if ((detail === 'ssh' || detail === 'taskboard') && controller.getSnapshot().panelOpen) {
      controller.close()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // hands the center column back to the conversation. Capture phase.
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"], [data-dsh-imagegen-new-session]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    resizer?.remove()
    resizer = undefined
    stopResizerLanguageWatch?.()
    stopResizerLanguageWatch = undefined
    stopResizerVisibilityWatch?.()
    stopResizerVisibilityWatch = undefined
  }
}

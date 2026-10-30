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
 * Shell compatibility: the centre column is found through the shell's own
 * anchors, never through a class name. DSH's AppFrame renders the column as a
 * grid item whose child is the `main` slot anchor — `renderSlot("main", …)`
 * inside `className: centerCol` (dsh-client-ui-layout) — and every slot anchor
 * carries `data-slot` (dsh-client-ui-renderer). Both are contract facts; the
 * class name next to them is a build-hashed CSS-module artifact. Legacy shells
 * marked the column itself with `data-pane="conversation"`.
 *
 * // NATIVE-GAP: the outright fix for the takeover below is to register into
 * the `main` slot (`ctx.slots.register({ name: 'main', key: … })`) and let the
 * `layout` service activate it. That replaces this whole DOM takeover — the
 * html-level activation attribute, the sibling eviction and the stylesheet
 * rules that hide the conversation — but it also moves the panel's root and
 * its stylesheet onto the slot renderer's entry lifetime, which is a rewrite of
 * this surface rather than a query repair. Until then the panel hangs off the
 * column the slot anchor names, and a shell that renames neither `data-slot`
 * nor `data-pane` is a case this file cannot see.
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

/** Centre-column occupant anchor: the AppFrame's keyed `main` slot entry. */
const MAIN_SLOT_ANCHOR = '[data-slot="main"]'
/** Legacy web shell: the conversation column itself carries the pane marker. */
const LEGACY_COLUMN_SELECTOR = '[data-pane="conversation"]'
/**
 * Our own mark on the centre column.
 *
 * The column is resolved from the `main` slot anchor above, never from a class
 * name: the grid item's CSS-module class (`_3WPZCG_centerCol`) is a build-time
 * hash that moves on every shell release, so a stylesheet that matched
 * `[class*="centerCol"]` was one rename away from silently dropping the whole
 * takeover. Marking the element we already resolved keeps the stylesheet on an
 * attribute this plugin owns.
 */
const CENTER_COL_ATTR = 'data-dsh-imagegen-center-col'
const ACTIVE_ATTR = 'data-dsh-imagegen-active'
const RESIZER_SELECTOR = '[data-dsh-imagegen-chat-resizer]'
const CHAT_WIDTH_STORAGE_KEY = 'dsh-imagegen:chat-width'
/** Inline custom property carrying the chat width, written onto the host's column. */
const CHAT_WIDTH_VAR = '--dsh-imagegen-chat-width'
const CHAT_MIN_WIDTH = 320
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Our own marker on the shell's New Session affordance (set by sidebar-entry). */
const NEW_SESSION_MARKER = '[data-dsh-imagegen-new-session]'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'imagegen'

/**
 * Nearest ancestor that paints a box. Slot anchors are `display: contents` by
 * contract (the renderer's ANCHOR_STYLE), so the grid item this panel takes
 * over is the first ancestor with a real display mode — not the anchor.
 */
function boxAncestor(anchor: HTMLElement): HTMLElement | undefined {
  if (typeof globalThis.getComputedStyle !== 'function') return anchor.parentElement ?? undefined
  let node: HTMLElement | null = anchor
  while (node !== null) {
    if (getComputedStyle(node).display !== 'contents') return node
    node = node.parentElement
  }
  return undefined
}

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  const anchor = document.querySelector<HTMLElement>(MAIN_SLOT_ANCHOR)
  if (anchor !== null) {
    const column = boxAncestor(anchor)
    if (column !== undefined) return column
  }
  return document.querySelector<HTMLElement>(LEGACY_COLUMN_SELECTOR) ?? undefined
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
  column.style.setProperty(CHAT_WIDTH_VAR, `${Math.round(width)}px`)
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

/**
 * Create the visible handle that separates the image workspace and chat.
 *
 * Returns the element together with a drag disposer: a drag in flight binds
 * three window listeners and pins `cursor` / `user-select` on <html>, and those
 * outlive the element unless someone unbinds them. The mount owns the handle's
 * lifetime, so it also owns that release (see `stopResizerDragWatch`).
 */
function createChatResizer(column: HTMLElement): { resizer: HTMLDivElement; disposeDrag: () => void } {
  /** Ends an in-flight drag; set while the pointer is down. */
  let endDrag: (() => void) | undefined
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
  if (saved !== undefined) column.style.setProperty(CHAT_WIDTH_VAR, `${saved}px`)

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    resizer.setPointerCapture?.(event.pointerId)
    const onMove = (move: PointerEvent): void => { applyChatWidth(column, move.clientX) }
    const onUp = (): void => {
      endDrag = undefined
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
    endDrag = onUp
    document.documentElement.style.setProperty('cursor', 'col-resize')
    document.documentElement.style.setProperty('user-select', 'none')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const bounds = column.getBoundingClientRect()
    const current = column.style.getPropertyValue(CHAT_WIDTH_VAR)
    const currentWidth = Number.parseFloat(current) || bounds.width * 0.36
    const delta = event.key === 'ArrowLeft' ? -24 : 24
    applyChatWidth(column, bounds.right - currentWidth - delta)
  }
  resizer.addEventListener('pointerdown', onPointerDown)
  resizer.addEventListener('keydown', onKeyDown)
  return { resizer, disposeDrag: () => { endDrag?.() } }
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
  /** The column carrying {@link CENTER_COL_ATTR}; released with the panel. */
  let markedColumn: HTMLElement | undefined
  /** Releases the resizer's language subscription; re-pointed in `ensure`. */
  let stopResizerLanguageWatch: (() => void) | undefined
  /** Releases the resizer's visibility observation; re-pointed in `ensure`. */
  let stopResizerVisibilityWatch: (() => void) | undefined
  /** Aborts a drag in flight before the resizer is dropped; re-pointed in `ensure`. */
  let stopResizerDragWatch: (() => void) | undefined
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
      // A drag in flight binds window listeners that no longer have an element
      // to release them, and leaves <html> with a pinned cursor.
      stopResizerDragWatch?.()
      stopResizerDragWatch = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    // Mark the resolved grid item for the stylesheet: which element the centre
    // column is, is decided here from slot anchors; the sheet only reads this.
    // A React rebuild can hand over a new column, so the old mark is dropped.
    if (markedColumn !== undefined && markedColumn !== column) markedColumn.removeAttribute(CENTER_COL_ATTR)
    markedColumn = column
    column.setAttribute(CENTER_COL_ATTR, '')
    container = document.createElement('div')
    container.dataset.dshImagegenView = ''
    container.className = css.view
    column.appendChild(container)
    root = createRoot(container)
    renderPanel()
    const existing = column.querySelector<HTMLDivElement>(RESIZER_SELECTOR)
    if (existing === null) {
      const created = createChatResizer(column)
      resizer = created.resizer
      // The disposer belongs to the element just created; the previous one
      // outlived its own element (it was removed in the branch above).
      stopResizerDragWatch?.()
      stopResizerDragWatch = created.disposeDrag
    } else {
      // Adopting a handle that is already in the column keeps its drag disposer:
      // it is still bound to this same element.
      resizer = existing
    }
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
  // Hand the center column back to the conversation when the user navigates.
  // Only our own marker is matched by the click below. The row markup is the
  // sidebar's own business — its class names are build hashes and its rows
  // carry no stable attribute — so five `[class*=…]` guesses used to stand in
  // for "the user navigated". The host publishes that same fact on the sessions
  // feed, and the subscription handles it there instead. Capture phase, so a
  // row whose own handler stops propagation still closes the studio.
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(NEW_SESSION_MARKER) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  // Any change of the current session — opening a row, a search hit, a
  // workspace's blank session, a new session created elsewhere — means the
  // centre column is wanted for a conversation. The feed is the authority for
  // that transition; the click handler above only covers the case where the
  // shell's own button did not move the selection (a failed create).
  const sessionList = services.sessions?.list
  let watchedSession = sessionList?.getSnapshot().current
  const stopSessionWatch = sessionList === undefined
    ? () => {}
    : sessionList.subscribe(() => {
      const next = sessionList.getSnapshot().current
      if (next === watchedSession) return
      watchedSession = next
      // `close()` is a no-op when the panel is already shut.
      controller.close()
    })
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    stopSessionWatch()
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    // A drag in flight would otherwise keep its window listeners and the
    // <html> cursor alive past the unmount.
    stopResizerDragWatch?.()
    stopResizerDragWatch = undefined
    resizer?.remove()
    resizer = undefined
    // The width variable is written onto the host's own grid item, so leaving it
    // there would survive the plugin being disabled.
    markedColumn?.style.removeProperty(CHAT_WIDTH_VAR)
    markedColumn?.removeAttribute(CENTER_COL_ATTR)
    markedColumn = undefined
    stopResizerLanguageWatch?.()
    stopResizerLanguageWatch = undefined
    stopResizerVisibilityWatch?.()
    stopResizerVisibilityWatch = undefined
  }
}

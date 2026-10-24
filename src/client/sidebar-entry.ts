/**
 * Add a two-tab switcher above the shell's own New Session affordance:
 * Session (the conversation view) and Image Generation. The shell button stays
 * visible underneath, so creating a new session keeps its old position and the
 * switcher never doubles as the only way out of the studio. When image
 * generation is active, the plugin also uses the shell's region area as a
 * dedicated history surface; the original workspace/session tree remains
 * underneath and is restored when the panel closes.
 *
 * ## How the shell is found (no class names)
 *
 * DSH's sidebar is `@deepseek-ai/dsh-client-ui-sidebar` — a React tree whose
 * only outward-stable marks are slot anchors. `dsh-client-ui-renderer` renders
 * every slot outlet as `<div data-slot="<key>" style="display: contents">`, so
 * the anchors below are contract, while the CSS-module class next to them
 * (`_3WPZCG_logoRow`, `_3WPZCG_regionArea`, …) is a build-time hash that moves
 * on every release. The tree, and therefore what this file relies on:
 *
 *   div.root
 *     ├ div.logoRow      → [data-slot="sidebar.brand.mark"|"sidebar.brand.name"]
 *     ├ button           → the New Session control (aria-label = "新建会话"/
 *     │                    "New session"; the SAME action the brand row starts)
 *     ├ nav.panelList    → [data-slot="sidebar.panellist"] rows
 *     ├ div.regionArea   → [data-slot="sidebar.workspaces"]   ← the seat
 *     └ div.footArea     → [data-slot="sidebar.footer.action"], "sidebar.settings"
 *
 * So the column is resolved from the workspace seat upward, the brand row from
 * the brand slot, and the New Session control by its accessible name — the
 * three things a shell cannot rename without breaking its own accessibility.
 *
 * // NATIVE-GAP: there is no slot ABOVE New Session, so the switcher cannot be
 * registered and is still inserted at the DOM level (`placeTabs`). The official
 * seats this plugin could take instead are `sidebar.panellist` (icon row) +
 * the layout's keyed `main` slot (panel content), which would replace the whole
 * takeover in mount.tsx — but that also rewrites the panel's stylesheet, so it
 * is a separate change, not a query repair.
 */

import type { ImageGenController } from './controller.ts'
import css from './panel.module.css'

/** Stable selector for the injected two-tab host. */
export const ENTRY_SELECTOR = '[data-dsh-imagegen-session-tabs]'
/** Stable selector for the history surface in the shell region area. */
export const HISTORY_HOST_SELECTOR = '[data-dsh-imagegen-history-host]'

/** Inline picture glyph kept deliberately small for the sidebar rail. */
const IMAGE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.6" cy="5.8" r="1"/><path d="M2.5 12.5l3.6-3.4 2.4 2.2 3-3 2 2.4"/></svg>'

/** Inline conversation glyph for the session-view tab. */
const SESSION_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3h11v8H7l-3 2.4V11H2.5z"/></svg>'

/**
 * The shell's workspace/session seat. Its anchor is `display: contents`, so the
 * element that paints the box (and the one the history host belongs in) is its
 * first real ancestor.
 */
const WORKSPACES_ANCHOR = '[data-slot="sidebar.workspaces"]'
/** Brand-row anchors: present in every shell that renders the brand at all. */
const BRAND_MARK_ANCHOR = '[data-slot="sidebar.brand.mark"]'
const BRAND_NAME_ANCHOR = '[data-slot="sidebar.brand.name"]'
/** Foot anchors: the two slot outlets the shell keeps below the tree. */
const FOOT_ACTION_ANCHOR = '[data-slot="sidebar.footer.action"]'
const SETTINGS_ANCHOR = '[data-slot="sidebar.settings"]'
/**
 * Our own marks on the shell's own sidebar blocks.
 *
 * The studio hides every sidebar entry that is not shell chrome, and the sheet
 * used to spell "chrome" as `[class*="logoRow"]`-style guesses. The block set is
 * decided here instead — from the slot anchors above — and the sheet only reads
 * these attributes, so a shell rename cannot silently un-hide another plugin's
 * entry (or hide the shell's own rows).
 */
const BLOCK_ATTR = 'data-dsh-imagegen-sidebar-block'
/** Our own mark on the block the history host is seated in. */
const REGION_ATTR = 'data-dsh-imagegen-sidebar-region'
/**
 * Set on the shell root once every chrome block above has been resolved. The
 * stylesheet's "hide foreign entries" rule requires it: in a shell that does
 * not expose the anchors nothing is marked, and an inert rule leaves a foreign
 * entry visible (cosmetic overlap) instead of hiding the shell's own brand row
 * or footer (a broken sidebar).
 */
const BLOCKS_ATTR = 'data-dsh-imagegen-shell-blocks'
/**
 * Older shells marked the sidebar column directly instead of registering slot
 * anchors. Declared by DSH Desktop's own docs and kept as a read-only fallback
 * (an attribute, so no `class` substring matching); absent from current builds,
 * where the branch above always answers first.
 */
const LEGACY_SIDEBAR_PANE = '[data-pane="sidebar"]'
/** Our own injected nodes, never candidates for the shell's seats. */
const OWN_NODES = `${ENTRY_SELECTOR}, ${HISTORY_HOST_SELECTOR}, [data-dsh-imagegen-sidebar-root]`

/** Accessible names the shell gives its New Session affordance. */
const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

/** Loose New Session match for shells without a stable class or data hook. */
function looksLikeNewSession(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return NEW_SESSION_LABELS.some((label) => name.includes(label))
}

/**
 * True while the element still paints.
 *
 * The shell renders a hidden mobile copy of its sidebar slots (`header.dsh-
 * mobile-app-header`) before — and sometimes instead of — the desktop column,
 * and that copy is `display: none`. A seat resolved inside it is real DOM with
 * no box, so anything cached from it is unusable and must be recomputed once
 * the desktop column appears.
 */
function isVisible(node: HTMLElement): boolean {
  if (!node.isConnected) return false
  if (typeof globalThis.getComputedStyle !== 'function') return true
  for (let cursor: HTMLElement | null = node; cursor !== null && cursor !== document.body; cursor = cursor.parentElement) {
    if (getComputedStyle(cursor).display === 'none') return false
  }
  return true
}

/**
 * Nearest ancestor that paints a box. Slot anchors are `display: contents` by
 * contract (the renderer's `ANCHOR_STYLE`), so the grid item this plugin hangs
 * off is the first ancestor with a real display mode — not the anchor.
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

/**
 * Resolve a slot anchor to the element that paints its box.
 *
 * Anchors are tried in document order and the first PAINTED one wins: the
 * hidden mobile copy comes first in document order on a desktop shell, so
 * `querySelector` alone would always answer with the invisible header.
 */
function seatOf(selector: string): HTMLElement | undefined {
  for (const anchor of document.querySelectorAll<HTMLElement>(selector)) {
    if (!isVisible(anchor)) continue
    const seat = boxAncestor(anchor)
    if (seat !== undefined && isVisible(seat)) return seat
  }
  return undefined
}

/**
 * The shell-owned New Session button.
 *
 * Two controls start a session in the current shell: the brand button (its
 * accessible name is the same dictionary string) and the dedicated button below
 * it. The brand one contains the brand slots, so it is excluded — picking it
 * would put the switcher above the logo instead of above the action.
 */
function newSessionButton(root: ParentNode = document): HTMLButtonElement | undefined {
  const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
  return candidates.find((button) => looksLikeNewSession(button) && button.querySelector('[data-slot]') === null && isVisible(button))
}

/**
 * The region seat that normally holds the workspace/session tree.
 *
 * The anchor above answers on every shell this plugin supports. The fallback is
 * for a shell that renders the seat without registering the slot: shell chrome
 * blocks (brand row, panel rows, footer) all own an interactive control, the
 * seat owns a tree, so the last control-free block is the seat.
 *
 * "Control-free" is measured WITHOUT our own output: this plugin renders the
 * history list (with its own buttons) into that very seat, so counting those
 * would make the seat stop looking like a seat one render after it was found.
 */
function regionSeat(root: HTMLElement): HTMLElement | undefined {
  const anchored = seatOf(WORKSPACES_ANCHOR)
  if (anchored !== undefined && anchored !== root && root.contains(anchored)) return anchored
  const blocks = Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(OWN_NODES) === false,
  )
  const quiet = blocks.filter((block) => Array
    .from(block.querySelectorAll('button, a, input, [role="button"]'))
    .every((control) => control.closest(HISTORY_HOST_SELECTOR) !== null || control.closest(ENTRY_SELECTOR) !== null))
  return quiet[quiet.length - 1]
}

/**
 * The shell root's direct child that owns a slot anchor.
 *
 * The studio's "hide foreign entries" rule works on direct children of the
 * shell root, so the mark has to land on that same block — not on the anchor
 * itself (which is `display: contents`) and not on an inner wrapper the shell
 * may put between them (the foot nests `footerActions`/`settingsArea` inside
 * `footArea`, and hiding the inner ones would leave the foot painted).
 */
function blockOf(root: HTMLElement, selector: string): HTMLElement | undefined {
  const anchor = root.querySelector<HTMLElement>(selector)
  if (anchor === null) return undefined
  return blockHolding(root, anchor)
}

/** The shell root's direct child that contains `node`. */
function blockHolding(root: HTMLElement, node: HTMLElement): HTMLElement | undefined {
  return Array.from(root.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.contains(node),
  )
}

/** The root child that wraps the New Session action, unless it is the action. */
function newSessionBlock(root: HTMLElement, action: HTMLElement): HTMLElement | undefined {
  const block = blockHolding(root, action)
  return block === action ? undefined : block
}

/**
 * Mark the shell's own chrome blocks so the stylesheet can spare them.
 *
 * Replaces three `[class*="logoRow"]`-style guesses with attributes this plugin
 * owns. `BLOCKS_ATTR` is set only once the brand block resolved: the sheet's
 * hiding rule is gated on it, so a shell that exposes no anchors keeps its
 * sidebar wholly intact (a foreign entry overlapping for a moment) instead of
 * losing its brand row and footer (a broken shell).
 */
function markBlocks(
  root: HTMLElement,
  region: HTMLElement | undefined,
  newSession: HTMLElement | undefined,
): HTMLElement[] {
  const brand = blockOf(root, BRAND_MARK_ANCHOR) ?? blockOf(root, BRAND_NAME_ANCHOR)
  const blocks = [
    brand,
    blockOf(root, FOOT_ACTION_ANCHOR),
    blockOf(root, SETTINGS_ANCHOR),
    region,
    // The row that holds the shell's New Session affordance stays visible too.
    // Marking it here rather than asking the sheet for `:not(:has(...))` keeps
    // the rule expressible in every engine that renders the plugin. When the
    // action is a direct child of the root the block IS the action, which the
    // sheet already spares by its own mark, so there is nothing to add.
    newSession === undefined ? undefined : newSessionBlock(root, newSession),
  ].filter((block): block is HTMLElement => block !== undefined)
  for (const block of blocks) block.setAttribute(BLOCK_ATTR, '')
  if (region !== undefined) region.setAttribute(REGION_ATTR, '')
  if (brand !== undefined) root.setAttribute(BLOCKS_ATTR, '')
  else root.removeAttribute(BLOCKS_ATTR)
  return blocks
}

/**
 * Find the sidebar shell root, or undefined while it is not mounted.
 *
 * Order matters: the slot anchors answer in current builds, the pane attribute
 * in older ones, and the last resort is the New Session control's own parent —
 * a shell that has the action but none of the marks around it.
 */
function sidebarRoot(): HTMLElement | undefined {
  // `SidebarRoot` renders the region seat as an only child of the column, so
  // the seat's parent IS the shell root in every shape this plugin supports.
  const column = seatOf(WORKSPACES_ANCHOR)?.parentElement
  if (column !== undefined && column !== null && isVisible(column)) return column

  const brand = seatOf(BRAND_MARK_ANCHOR) ?? seatOf(BRAND_NAME_ANCHOR)
  if (brand !== undefined) {
    for (let candidate: HTMLElement | null = brand; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (newSessionButton(candidate) !== undefined) return candidate
    }
  }

  const pane = document.querySelector<HTMLElement>(LEGACY_SIDEBAR_PANE)
  if (pane !== null && isVisible(pane)) return pane

  return newSessionButton()?.parentElement ?? undefined
}

function makeTab(
  label: string,
  tooltip: string,
  icon: string,
  onClick: () => void,
): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = css.sessionTab
  tab.setAttribute('aria-label', label)
  tab.setAttribute('title', tooltip)
  tab.innerHTML = `<span class="${css.sessionTabIcon}">${icon}</span><span class="${css.sessionTabLabel}">${label}</span>`
  tab.addEventListener('click', onClick)
  return tab
}

/**
 * Build the two-tab switcher. Detached from any seat: the caller decides where
 * it goes, so both the preferred seat and the fallback below share one builder.
 */
function createTabs(
  controller: ImageGenController,
  sessionLabel: string,
  sessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): HTMLDivElement {
  const tabs = document.createElement('div')
  tabs.dataset.dshImagegenSessionTabs = ''
  tabs.className = css.sessionTabs
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', imageTooltip)

  const sessionTab = makeTab(sessionLabel, sessionTooltip, SESSION_ICON, () => {
    controller.close()
  })
  const imageTab = makeTab(imageLabel, imageTooltip, IMAGE_ICON, () => {
    controller.open()
  })
  sessionTab.dataset.dshImagegenTab = 'session'
  imageTab.dataset.dshImagegenTab = 'image'
  tabs.append(sessionTab, imageTab)
  return tabs
}

/** Seat marker for a switcher that had to fall back to the column itself. */
const FALLBACK_SEAT_ATTR = 'dshImagegenTabsSeat'
const FALLBACK_SEAT_VALUE = 'top'

/**
 * Mount or repair the two-tab switcher.
 *
 * Preferred seat: directly above the shell's New Session button, which stays
 * visible there — the switcher only moves between the conversation and the
 * studio, it never creates a session.
 *
 * Fallback seat: the first child of the sidebar column. Another plugin may take
 * over the shell's sidebar and hide that button (`display: none !important`, the
 * way ds-bot's team view does), which used to leave this switcher with no seat
 * at all and therefore no way into the panel. The column itself always paints,
 * so the switcher becomes its first child instead of vanishing. The marker lets
 * the stylesheet restyle only this seat.
 */
function placeTabs(
  root: HTMLElement,
  button: HTMLButtonElement | undefined,
  controller: ImageGenController,
  sessionLabel: string,
  sessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): HTMLDivElement {
  const existing = root.querySelector<HTMLDivElement>(ENTRY_SELECTOR)

  if (button !== undefined) {
    if (existing !== null && existing.parentElement === button.parentElement) return existing
    existing?.remove()
    const tabs = createTabs(controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
    // The shell button keeps its own slot below the switcher, untouched.
    button.parentElement?.insertBefore(tabs, button)
    return tabs
  }

  // Already seated at the fallback: keep the node (its listeners stay live).
  if (existing !== null && existing.parentElement === root) return existing
  existing?.remove()
  const tabs = createTabs(controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
  tabs.dataset[FALLBACK_SEAT_ATTR] = FALLBACK_SEAT_VALUE
  root.insertBefore(tabs, root.firstChild)
  return tabs
}

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement, region: HTMLElement | undefined): HTMLDivElement | undefined {
  // Reuse the host already in place: the seat is recomputed on every shell
  // mutation, and a host that is still mounted elsewhere must not be duplicated
  // (the panel renders its history list into whichever host it finds).
  const installed = root.querySelector<HTMLDivElement>(HISTORY_HOST_SELECTOR)
  if (installed !== null) {
    if (region !== undefined && installed.parentElement !== region) region.append(installed)
    return installed
  }
  if (region === undefined) return undefined
  const host = document.createElement('div')
  host.dataset.dshImagegenHistoryHost = ''
  host.className = css.sidebarHistoryHost
  region.append(host)
  return host
}

/**
 * Mount the two tabs and self-heal after React rebuilds the sidebar. The
 * shell-owned New Session button keeps its native behavior. A temporary marker
 * preserves its visibility and identifies context clicks across shell layouts.
 */
export function mountSidebarEntry(
  controller: ImageGenController,
  sessionLabel: string,
  sessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): () => void {
  let root: HTMLElement | undefined
  let tabs: HTMLDivElement | undefined
  let historyHost: HTMLDivElement | undefined
  let markedButton: HTMLButtonElement | undefined
  /** Blocks carrying {@link BLOCK_ATTR}/{@link REGION_ATTR}; released on unload. */
  let markedBlocks: HTMLElement[] = []
  let warnedUnmounted = false

  /**
   * Compact shell fingerprint for the warning below: it never dumps the sidebar
   * markup (which carries session titles), only the markers we look for.
   */
  const describeShell = (): string => {
    const markers = [WORKSPACES_ANCHOR, BRAND_MARK_ANCHOR, LEGACY_SIDEBAR_PANE]
      .map((selector) => `${selector}=${document.querySelectorAll(selector).length}`)
      .join(' ')
    const outline = Array.from(document.body.children)
      .slice(0, 6)
      .map((element) => {
        const name = typeof element.className === 'string' ? element.className.split(/\s+/)[0] : ''
        return `${element.tagName.toLowerCase()}${name === '' ? '' : `.${name}`}`
      })
      .join(' > ')
    return `${markers} body>${outline}`
  }

  // A shell we have never seen must not fail silently: the reporter of #20 had
  // no console output at all to work from.
  const warnUnmounted = (): void => {
    if (warnedUnmounted || tabs !== undefined) return
    warnedUnmounted = true
    const reason = root === undefined ? 'sidebar root not found' : 'no seat for the switcher'
    console.warn(`[dsh-imagegen] sidebar entry stayed unmounted (${reason}); shell probe: ${describeShell()}`)
  }

  const unmountedTimer = window.setTimeout(warnUnmounted, 5000)

  const syncActive = (): void => {
    if (tabs === undefined) return
    const sessionTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="session"]')
    const imageTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="image"]')
    if (controller.getSnapshot().panelOpen) {
      if (sessionTab !== null) delete sessionTab.dataset.active
      if (imageTab !== null) imageTab.dataset.active = ''
    } else {
      if (sessionTab !== null) sessionTab.dataset.active = ''
      if (imageTab !== null) delete imageTab.dataset.active
    }
  }

  const ensure = (): void => {
    // A root that stopped painting was resolved against a shell the host has
    // since replaced (the hidden mobile copy that lands before the desktop
    // column): recompute instead of writing the entry into an invisible box.
    if (root !== undefined && (!root.isConnected || !isVisible(root))) {
      markedButton?.removeAttribute('data-dsh-imagegen-new-session')
      markedButton = undefined
      for (const block of markedBlocks) {
        block.removeAttribute(BLOCK_ATTR)
        block.removeAttribute(REGION_ATTR)
      }
      markedBlocks = []
      // The nodes themselves go with the stale root: the next seat is a
      // different container, and leaving a copy behind would either duplicate
      // the switcher or keep the invisible one alive.
      tabs?.remove()
      historyHost?.remove()
      tabs = undefined
      historyHost = undefined
      if (root.isConnected) delete root.dataset.dshImagegenSidebarRoot
      root = undefined
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    root.dataset.dshImagegenSidebarRoot = ''
    const button = newSessionButton(root)
    if (button !== undefined) {
      if (markedButton !== button) markedButton?.removeAttribute('data-dsh-imagegen-new-session')
      markedButton = button
      if (!button.hasAttribute('data-dsh-imagegen-new-session')) {
        button.setAttribute('data-dsh-imagegen-new-session', '')
      }
    } else if (markedButton !== undefined) {
      // The action this plugin used to mark is gone (another plugin hid or
      // replaced it): drop the mark so a stale attribute cannot keep a hidden
      // button styled for a seat that no longer exists.
      markedButton.removeAttribute('data-dsh-imagegen-new-session')
      markedButton = undefined
    }
    tabs = placeTabs(root, button, controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
    // The seat is resolved once here and shared: the history host has to sit in
    // it, and the stylesheet has to be able to spare it.
    const region = regionSeat(root)
    const nextBlocks = markBlocks(root, region, button)
    for (const block of markedBlocks) {
      if (nextBlocks.includes(block)) continue
      block.removeAttribute(BLOCK_ATTR)
      block.removeAttribute(REGION_ATTR)
    }
    markedBlocks = nextBlocks
    historyHost = placeHistoryHost(root, region)
    syncActive()
  }

  const bodyObserver = new MutationObserver(ensure)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = controller.subscribe(syncActive)
  ensure()

  return () => {
    window.clearTimeout(unmountedTimer)
    bodyObserver.disconnect()
    unsubscribe()
    tabs?.remove()
    historyHost?.remove()
    markedButton?.removeAttribute('data-dsh-imagegen-new-session')
    for (const block of markedBlocks) {
      block.removeAttribute(BLOCK_ATTR)
      block.removeAttribute(REGION_ATTR)
    }
    markedBlocks = []
    if (root !== undefined) {
      delete root.dataset.dshImagegenSidebarRoot
      root.removeAttribute(BLOCKS_ATTR)
    }
  }
}

/**
 * Internals re-exported for the standalone smoke test: the browser bundle is
 * the only consumer of the entry, so the check has to drive these directly to
 * cover a shell layout the jsdom studio fixture does not render (#20).
 */
export const sidebarEntryTestHooks = {
  findSidebarRoot: sidebarRoot,
  findNewSessionButton: newSessionButton,
  mount: mountSidebarEntry,
}

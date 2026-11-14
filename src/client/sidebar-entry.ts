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
import { onTablistKeyDown, tabIndexFor } from './tablist.ts'

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
/**
 * Our own mark on sidebar blocks that must disappear while the studio is open.
 *
 * A shell may nest the workspace seat a few levels deep inside a scrolling
 * container (DSH 0.2.2-rc.2: root > scrollRegion > scrollArea > regionArea).
 * The root-child rule can only hide the scroll container as a whole, which
 * would also hide the history host seated next to the workspace tree. These
 * marks let the stylesheet hide sibling branches (the panel nav) while the
 * branch that carries the region, and only that branch, stays painted.
 */
const HIDE_ATTR = 'data-dsh-imagegen-sidebar-hide'
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
/**
 * Marks the history host as the owner of its own wheel events.
 *
 * The shell's 0.2.2 sidebar scroll viewport listens for `wheel` on an ancestor
 * of the host and takes over anything that is not its own tree, so the host
 * claims its events first (see `containHistoryWheel`). The attribute is also
 * what tells a re-render that the listener is already installed — the host
 * element is reused across shell mutations.
 */
const WHEEL_CONTAINER_ATTR = 'data-dsh-imagegen-wheel-owner'
/** Our own injected nodes, never candidates for the shell's seats. */
const OWN_NODES = `${ENTRY_SELECTOR}, ${HISTORY_HOST_SELECTOR}, [data-dsh-imagegen-sidebar-root]`

/** Accessible names the shell gives its New Session affordance. */
const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

/** Accessible names the shell gives its own sidebar-collapse control. */
const SIDEBAR_TOGGLE_LABELS = [
  'collapse sidebar',
  'open sidebar',
  '收起侧边栏',
  '打开侧边栏',
]

/** Loose New Session match for shells without a stable class or data hook. */
function looksLikeNewSession(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return NEW_SESSION_LABELS.some((label) => name.includes(label))
}

/** Same loose match, for the shell's own collapse control. */
function looksLikeSidebarToggle(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return SIDEBAR_TOGGLE_LABELS.some((label) => name.includes(label))
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
  return candidates.find((button) => looksLikeNewSession(button)
    && button.querySelector('[data-slot]') === null
    // Workspace bundles (dsh-better-sidebar, DSH's own tree) render a
    // per-workspace "New session in …" action that reveals itself on row
    // hover. It starts a session in that workspace, not the shell-level one
    // this switcher belongs above, so it must never become the seat — the
    // hover was what used to drag the tabs down into the tree.
    && button.closest(WORKSPACES_ANCHOR) === null
    && isVisible(button))
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
 * True for the sidebar column: the box that stacks vertically AND paints the
 * shell's own chrome around the seat.
 *
 * The seat is reached through single-purpose wrappers in 0.2.2
 * (`scrollRegion > scrollArea > regionArea`), and every one of them also
 * contains the brand row and the foot, so "contains the chrome" alone answers
 * with the innermost wrapper and seats the switcher in a scrolling grid cell
 * (#35). What separates the column from those wrappers is the axis it stacks
 * on: the column is a vertical stack (flex column) that owns the chrome, while
 * the wrappers between it and the seat are either horizontal rows or grids.
 *
 * The chrome has to be counted from the anchors, NOT from their visibility:
 * another plugin can hide the brand row and the New Session row outright
 * (`ds-bot`'s team view does), and a visibility test would then call the
 * column "a plain wrapper" and walk past it to `body`.
 *
 * Nor can it be "the outermost box that holds an anchor": the app frame that
 * contains the whole window also contains the sidebar, so that test walks past
 * the column and seats the switcher in the window's own flex row.
 */
function ownsColumnChrome(candidate: HTMLElement): boolean {
  if (!isVisible(candidate)) return false
  // The wrappers between the column and the seat own no chrome anchor at all.
  if (!holdsAnyAnchor(candidate)) return false
  // A horizontal row or a grid does not stack the shell's chrome; the column does.
  const style = getComputedStyle(candidate)
  return style.display === 'flex' || style.display === 'block' || style.display === 'inline-flex'
}

/** True while the box owns at least one of the shell's own chrome anchors. */
function holdsAnyAnchor(node: HTMLElement): boolean {
  return node.querySelector(`${BRAND_MARK_ANCHOR}, ${BRAND_NAME_ANCHOR}, ${FOOT_ACTION_ANCHOR}, ${SETTINGS_ANCHOR}`) !== null
}

/**
 * The shell's own sidebar-collapse control.
 *
 * On macOS the shell puts it in a window-chrome strip above the brand row (so it
 * clears the traffic lights); on Windows it rides inside the brand row. Both
 * are shell chrome the studio must not hide — losing it leaves the user with no
 * way back to a wide sidebar except the keyboard shortcut.
 *
 * Deliberately NOT filtered on visibility, only on a painted seat preferred:
 * the studio's own rule is what hides this control when its block is unmarked,
 * so requiring a painted box would lock the find out after the first pass — the
 * block could never be marked again, and the control would stay gone for good.
 * `root` is already the painted column, so the first match is the real one; the
 * visible-first ordering only covers a shell that emits a hidden duplicate.
 */
function sidebarToggleButton(root: ParentNode = document): HTMLButtonElement | undefined {
  const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => looksLikeSidebarToggle(button))
  return candidates.find((button) => isVisible(button)) ?? candidates[0]
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
  const toggle = sidebarToggleButton(root)
  const keep = new Set<HTMLElement>()
  const hide = new Set<HTMLElement>()
  for (const block of [
    brand,
    blockOf(root, FOOT_ACTION_ANCHOR),
    blockOf(root, SETTINGS_ANCHOR),
    // The root-level block that carries the workspace seat. In 0.2.1 this is
    // the region itself; in 0.2.2-rc.2 it is the `scrollRegion` wrapper. It
    // must stay painted for the history host inside the region.
    region === undefined ? undefined : blockHolding(root, region),
    region,
    // The row that holds the shell's New Session affordance stays visible too.
    // Marking it here rather than asking the sheet for `:not(:has(...))` keeps
    // the rule expressible in every engine that renders the plugin. When the
    // action is a direct child of the root the block IS the action, which the
    // sheet already spares by its own mark, so there is nothing to add.
    newSession === undefined ? undefined : newSessionBlock(root, newSession),
    // Same for the collapse control: on macOS it lives in a chrome strip of its
    // own above the brand row, which is not any of the anchor blocks above.
    toggle === undefined ? undefined : blockHolding(root, toggle),
  ]) {
    if (block !== undefined) keep.add(block)
  }

  // A shell that nests the region under a scrolling container puts the panel
  // navigation next to the region inside that container. Mark every sibling
  // branch on the path from the region up to the column: the history host must
  // keep the whole column, but the panel nav is foreign chrome in studio mode.
  if (region !== undefined) {
    let node: HTMLElement = region
    while (node.parentElement !== null && node.parentElement !== root) {
      const parent = node.parentElement
      for (const child of Array.from(parent.children)) {
        if (child === node || !(child instanceof HTMLElement) || child.matches(OWN_NODES)) continue
        hide.add(child)
      }
      node = parent
    }
  }

  for (const block of keep) {
    hide.delete(block)
    block.setAttribute(BLOCK_ATTR, '')
  }
  for (const block of hide) block.setAttribute(HIDE_ATTR, '')
  if (region !== undefined) region.setAttribute(REGION_ATTR, '')
  if (brand !== undefined) root.setAttribute(BLOCKS_ATTR, '')
  else root.removeAttribute(BLOCKS_ATTR)
  return [...keep, ...hide]
}

/**
 * Find the sidebar shell root, or undefined while it is not mounted.
 *
 * Order matters: the slot anchors answer in current builds, the pane attribute
 * in older ones, and the last resort is the New Session control's own parent —
 * a shell that has the action but none of the marks around it.
 */
function sidebarRoot(): HTMLElement | undefined {
  const region = seatOf(WORKSPACES_ANCHOR)
  const action = newSessionButton()

  // The region seat is NOT necessarily a child of the column. DSH 0.2.2-rc.2
  // inserted `scrollRegion > scrollArea` between them (0.2.1 had the seat as a
  // direct child), so `seat.parentElement` answers with the scrolling grid.
  // Inserting the switcher there made it one 4x8px grid cell — invisible
  // (#35) — and scoping the New Session search to it let a hovered workspace
  // row's action steal the tabs into the tree. The column is the nearest
  // painted ancestor of the seat that also owns the shell-level action.
  if (region !== undefined) {
    for (let candidate: HTMLElement | null = region.parentElement; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (isVisible(candidate) && action !== undefined && candidate.contains(action)) return candidate
    }
    // A shell that hid its New Session action still has a brand row; the
    // column is the nearest common ancestor of the seat and the brand mark.
    const brand = seatOf(BRAND_MARK_ANCHOR) ?? seatOf(BRAND_NAME_ANCHOR)
    if (brand !== undefined) {
      for (let candidate: HTMLElement | null = region; candidate !== null; candidate = candidate.parentElement) {
        if (candidate === document.body) break
        if (isVisible(candidate) && candidate.contains(brand)) return candidate
      }
    }
    // Neither the action nor the brand row is reachable: another plugin owns
    // the whole shell chrome above this seat and hid both (`ds-bot`'s team view
    // does exactly that — `[class*="_newSession"]` and `[class*="_logoRow"]`
    // are `display: none !important`, and it shadows `sidebar.workspaces` with
    // its own team column). The column itself is still there, still painted,
    // and it still contains this seat — which is all the switcher needs. Without
    // this branch the entry resolved no root at all and never mounted, so the
    // studio became unreachable for as long as the user stayed in the other
    // plugin's view.
    for (let candidate: HTMLElement | null = region; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      // `regionArea`/`scrollArea` wrappers are single-purpose boxes; the column
      // is the one that also owns the shell's other chrome. Stopping at the
      // first ancestor of the seat that is NOT one of its own single-child
      // wrappers keeps the switcher from landing inside the scrolling grid.
      if (ownsColumnChrome(candidate)) return candidate
    }
  }

  const brand = seatOf(BRAND_MARK_ANCHOR) ?? seatOf(BRAND_NAME_ANCHOR)
  if (brand !== undefined) {
    for (let candidate: HTMLElement | null = brand; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (newSessionButton(candidate) !== undefined) return candidate
    }
  }

  const pane = document.querySelector<HTMLElement>(LEGACY_SIDEBAR_PANE)
  if (pane !== null && isVisible(pane)) return pane

  // Last resort: the column that holds the workspace seat, even when every
  // anchor above answers nothing because a foreign plugin hid the shell's own
  // chrome. A shell that has neither an anchor nor the action still has a
  // column around its region.
  if (region !== undefined) {
    for (let candidate: HTMLElement | null = region.parentElement; candidate !== null && candidate !== document.body; candidate = candidate.parentElement) {
      if (ownsColumnChrome(candidate)) return candidate
    }
  }

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
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', 'false')
  tab.setAttribute('aria-label', label)
  tab.setAttribute('title', tooltip)
  tab.innerHTML = `<span class="${css.sessionTabIcon}">${icon}</span><span class="${css.sessionTabLabel}">${label}</span>`
  tab.addEventListener('click', onClick)
  return tab
}

/**
 * Close the shell's mobile drawer after a tab activation.
 *
 * DSH renders the sidebar as an off-canvas drawer on narrow viewports. The
 * switcher lives inside that drawer, so switching to the image studio would
 * leave the drawer covering the studio the user just asked for (the same for
 * switching back to the conversation). Only an OPEN drawer is touched: in the
 * desktop layout there is no `data-sidebar-drawer` frame and the sidebar
 * stays exactly where it was.
 */
function closeSidebarDrawer(): void {
  const frame = document.querySelector<HTMLElement>('[data-sidebar-drawer="true"]')
  if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return
  const toggle = frame.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')
    ?? sidebarToggleButton(frame)
  toggle?.click()
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
  // Name the switcher itself, not the image tab: its tooltip is a model list.
  tabs.setAttribute('aria-label', `${sessionLabel} / ${imageLabel}`)

  // One `activate` per tab, shared by the click and the arrow key that lands on
  // it: two lambdas meaning the same thing is how a keyboard path drifts away
  // from the mouse path it is supposed to mirror.
  const activateSession = (): void => { controller.close(); closeSidebarDrawer() }
  const activateImage = (): void => { controller.open(); closeSidebarDrawer() }

  const sessionTab = makeTab(sessionLabel, sessionTooltip, SESSION_ICON, activateSession)
  const imageTab = makeTab(imageLabel, imageTooltip, IMAGE_ICON, activateImage)
  sessionTab.dataset.dshImagegenTab = 'session'
  imageTab.dataset.dshImagegenTab = 'image'

  // `role="tablist"` plus `role="tab"` is a keyboard promise, not decoration:
  // only the selected tab stays in the Tab order and the arrow keys move
  // between them. Declaring the roles without this leaves a keyboard user
  // pressing arrows that do nothing — the exact defect `tablist.ts` documents.
  // The switcher is built imperatively (no React), so it wires the shared
  // helper by hand instead of getting it from `onKeyDown`.
  const entries: ReadonlyArray<readonly [HTMLButtonElement, () => void]> = [
    [sessionTab, activateSession],
    [imageTab, activateImage],
  ]
  for (const [index, entry] of entries.entries()) {
    entry[0].addEventListener('keydown', event => {
      onTablistKeyDown(event, {
        count: entries.length,
        index,
        select: next => entries[next]?.[1](),
      })
    })
  }

  tabs.append(sessionTab, imageTab)
  return tabs
}

/**
 * Copy the shell button's horizontal geometry onto the switcher.
 *
 * The switcher is that button's sibling, inserted with `insertBefore`, so the
 * only correct answer is the button's own used margin — not a token, not a
 * constant. Measured in a live shell (dsh 0.2.1-rc.5): the button carries
 * `margin-inline: 2px` and there is no `--dsh-sidebar-paint-inset` anywhere on
 * its ancestor chain, so the old `calc(var(…, 3px) + 1px)` resolved to 4px and
 * the switcher sat 2px inside the button on both edges (issue #25 reopened).
 *
 * Reading `getComputedStyle` beats reading a custom property here because the
 * shell is free to change the number without telling anyone, and a stylesheet
 * cannot see a sibling's used value. Both edges are taken separately: a shell
 * that insets asymmetrically still lines up.
 *
 * The element measured is the SEAT the switcher was inserted before, not the
 * New Session button: since 0.2.2-rc.3 the inset lives on the row that wraps
 * the button (`newSessionRow` carries `--dsh-sidebar-paint-inset + 1px`, the
 * button's own margin is `0`). Measuring the button would leave the switcher
 * 4px wider than the action row on both edges.
 */
function alignToSeat(tabs: HTMLElement, seat: HTMLElement): void {
  if (typeof globalThis.getComputedStyle !== 'function') return
  const style = getComputedStyle(seat)
  const left = style.marginLeft
  const right = style.marginRight
  // An unparsed value ('auto', '') would break the box; fall back to the
  // stylesheet's own symmetric margin rather than writing garbage.
  if (!/^-?[\d.]+px$/.test(left) || !/^-?[\d.]+px$/.test(right)) {
    tabs.style.removeProperty('margin-left')
    tabs.style.removeProperty('margin-right')
    return
  }
  tabs.style.marginLeft = left
  tabs.style.marginRight = right
}

/** Seat marker for a switcher that had to fall back to the column itself. */
const FALLBACK_SEAT_ATTR = 'dshImagegenTabsSeat'
const FALLBACK_SEAT_VALUE = 'top'

/**
 * The element the switcher is inserted BEFORE.
 *
 * Up to 0.2.2-rc.2 the New Session button was a direct child of the sidebar
 * column, so "the seat" and "the button" were the same element. 0.2.2-rc.3 gave
 * the button a wrapper row (`newSessionRow` — a `display: flex; gap: 6px` row
 * that also hosts the new `sidebar.session.action` slot outlet) and moved the
 * row inset onto it. Inserting before the BUTTON then put the switcher inside
 * that flex row — 会话 / 生图 / 新会话 side by side — which is the layout this
 * rule exists to prevent.
 *
 * So the seat is the root-level block that owns the action ({@link
 * newSessionBlock}, the same block `markBlocks` spares), read from the row
 * instead of guessed from wrappers. The block is only used when it holds
 * nothing but this action: a shell that wraps the brand row and the action in
 * one header must keep the old behaviour (insert before the button itself)
 * rather than get the switcher hoisted above the logo.
 */
function actionSeat(root: HTMLElement, button: HTMLElement): HTMLElement {
  const block = newSessionBlock(root, button)
  if (block === undefined) return button
  // The brand row is the tell for "this block is a header, not the action row".
  if (block.querySelector(`${BRAND_MARK_ANCHOR}, ${BRAND_NAME_ANCHOR}`) !== null) return button
  return block
}

/**
 * Mount or repair the two-tab switcher.
 *
 * Preferred seat: directly above the shell's New Session button, which stays
 * visible there — the switcher only moves between the conversation and the
 * studio, it never creates a session.
 *
 * Fallback seat: directly above the block that carries the workspace seat.
 * Another plugin may take over the shell's sidebar, hide that button and hide
 * the brand row with it (`display: none !important`, the way ds-bot's team view
 * does). The column itself always paints, and the workspace block always
 * exists, so the switcher goes above that block instead of vanishing. The
 * marker lets the stylesheet restyle only this seat.
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
  const seat = button === undefined ? undefined : actionSeat(root, button)

  if (seat !== undefined) {
    if (existing !== null && existing.parentElement === seat.parentElement
      && existing.nextElementSibling === seat) {
      // Same seat, but the shell may have re-rendered its row with a new
      // inset; re-measure rather than keep a value that was true once.
      alignToSeat(existing, seat)
      return existing
    }
    existing?.remove()
    const tabs = createTabs(controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
    // The shell action keeps its own slot below the switcher, untouched.
    seat.parentElement?.insertBefore(tabs, seat)
    alignToSeat(tabs, seat)
    return tabs
  }

  // Already seated at the fallback: keep the node (its listeners stay live).
  if (existing !== null && existing.parentElement === root) return existing
  existing?.remove()
  const tabs = createTabs(controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
  tabs.dataset[FALLBACK_SEAT_ATTR] = FALLBACK_SEAT_VALUE
  // NOT the column's first child: on macOS that is the window-chrome strip that
  // clears the traffic lights, and the switcher would be painted over the
  // drag surface. The block that carries the workspace seat is what the studio
  // paints over anyway, so the switcher goes directly above it — the same
  // place it takes when the shell's own action row is visible.
  const anchor = regionSeat(root)
  const above = anchor === undefined ? undefined : blockHolding(root, anchor)
  if (above !== undefined) root.insertBefore(tabs, above)
  else root.append(tabs)
  return tabs
}

/**
 * Keep the shell's own wheel handoff out of the history surface.
 *
 * DSH 0.2.2 puts a `wheel` listener (`passive: false`) on its sidebar scroll
 * viewport — `[data-sidebar-scrollport]`, an ANCESTOR of the region this host
 * sits in — and for every event that does not belong to its own session tree it
 * calls `preventDefault()` and scrolls that tree instead. In the studio the
 * tree is painted over by this host, so the visible result is a history list
 * that refuses to move while an invisible one scrolls behind it.
 *
 * The listener has to run inside the host and before the shell's, which sits
 * further out on the same bubble path: hence the host element, and
 * `stopPropagation()`. It deliberately does NOT `preventDefault()` — the
 * browser's own scroll of `.historyList` is exactly the behaviour we want, and
 * stopping propagation cancels no default action.
 *
 * At the list's ends nothing else happens. Handing the remainder back to the
 * shell would scroll the hidden session tree, which is the bug being fixed, not
 * a fallback.
 */
function containHistoryWheel(host: HTMLElement): void {
  if (host.hasAttribute(WHEEL_CONTAINER_ATTR)) return
  host.setAttribute(WHEEL_CONTAINER_ATTR, '')
  host.addEventListener('wheel', (event) => { event.stopPropagation() })
}

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement, region: HTMLElement | undefined): HTMLDivElement | undefined {
  // Reuse the host already in place: the seat is recomputed on every shell
  // mutation, and a host that is still mounted elsewhere must not be duplicated
  // (the panel renders its history list into whichever host it finds).
  const installed = root.querySelector<HTMLDivElement>(HISTORY_HOST_SELECTOR)
  if (installed !== null) {
    if (region !== undefined && installed.parentElement !== region) region.append(installed)
    containHistoryWheel(installed)
    return installed
  }
  if (region === undefined) return undefined
  const host = document.createElement('div')
  host.dataset.dshImagegenHistoryHost = ''
  host.className = css.sidebarHistoryHost
  containHistoryWheel(host)
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
    const panelOpen = controller.getSnapshot().panelOpen
    for (const [tab, active] of [[sessionTab, !panelOpen], [imageTab, panelOpen]] as const) {
      if (tab === null) continue
      if (active) tab.dataset.active = ''
      else delete tab.dataset.active
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
      // The roving half of the contract: exactly one tab is in the Tab order,
      // and it is the selected one. `aria-selected` alone still leaves both
      // buttons tabbable, which is the state the keyboard contract forbids.
      tab.tabIndex = tabIndexFor(active)
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
        block.removeAttribute(HIDE_ATTR)
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
      block.removeAttribute(HIDE_ATTR)
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
      block.removeAttribute(HIDE_ATTR)
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

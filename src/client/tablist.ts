/**
 * Keyboard contract for the ARIA tabs in this plugin.
 *
 * `role="tablist"` is not only a label: it commits the component to a keyboard
 * model. Assistive technology and keyboard users expect exactly one tab in the
 * Tab order (a roving tabIndex) and the arrow keys to move between tabs.
 * Declaring the roles without the keys leaves those users pressing arrows that
 * do nothing, which is a real defect rather than a missing nicety.
 *
 * Everything here is duck-typed rather than using `instanceof HTMLElement`:
 * the same code runs inside the jsdom smoke sandbox, which exposes a `document`
 * but no DOM constructors on its global.
 */

/** Roving tabIndex: only the selected tab is reachable by Tab. */
export function tabIndexFor(active: boolean): 0 | -1 {
  return active ? 0 : -1
}

/**
 * Move the selection and the focus when the user presses an arrow / Home / End
 * on a tab. Call it from every `role="tab"` button's `onKeyDown`.
 *
 * Activation follows the arrow keys because the views behind these tabs are
 * already mounted and switching is cheap -- there is nothing an extra Enter
 * press would protect.
 *
 * @param event - the keyboard event; only `key`, `preventDefault` and
 *   `currentTarget` are read, so any React synthetic event fits.
 * @param options.count - how many tabs the list has.
 * @param options.index - the position of the tab the event came from.
 * @param options.select - applies the new selection (same call the click makes).
 */
export function onTablistKeyDown(
  event: { key: string; preventDefault: () => void; currentTarget: unknown },
  options: { count: number; index: number; select: (index: number) => void },
): void {
  const { count, index, select } = options
  if (count <= 0 || index < 0 || index >= count) return
  const next = event.key === 'ArrowRight' ? (index + 1) % count
    : event.key === 'ArrowLeft' ? (index - 1 + count) % count
      : event.key === 'Home' ? 0
        : event.key === 'End' ? count - 1
          : -1
  if (next < 0) return
  event.preventDefault()
  select(next)
  // The roving tabIndex leaves every unselected tab at -1, so focus has to
  // travel with the selection; otherwise the user is stranded on a tab that is
  // no longer in the Tab order.
  tabsOf(event.currentTarget)[next]?.focus?.()
}

/** The sibling tabs of the element the event came from, in document order. */
function tabsOf(target: unknown): Array<{ focus?: () => void }> {
  const element = target as { closest?: unknown } | null
  if (element === null || typeof element !== 'object' || typeof element.closest !== 'function') return []
  const list = (element.closest as (selector: string) => unknown)('[role="tablist"]') as { querySelectorAll?: unknown } | null
  if (list === null || list === undefined || typeof list !== 'object' || typeof list.querySelectorAll !== 'function') return []
  const nodes = (list.querySelectorAll as (selector: string) => ArrayLike<{ focus?: () => void }>)('[role="tab"]')
  return Array.from(nodes)
}

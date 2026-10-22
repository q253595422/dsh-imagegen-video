/**
 * The canvas keyboard map, made visible.
 *
 * WHY a table and not just JSX: none of these bindings were discoverable. The
 * handlers existed (Ctrl+Z, Ctrl+D, Delete, Space-to-pan…), but nothing in the
 * UI said so, and a user cannot look up a shortcut they do not know exists.
 * Keeping the map as data also lets a check compare it against the handler, so
 * a binding added there and forgotten here fails a check instead of silently
 * going undocumented.
 *
 * The modifier is written "Ctrl/⌘" rather than sniffing the platform: the
 * handler accepts either (`event.ctrlKey || event.metaKey`), so naming both is
 * what the code actually does.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { ImageGenKey } from './locales.ts'
import { tt } from './helpers.ts'
import css from './shortcut-help.module.css'

/** One row: the keys to press, and what they do. */
export interface ShortcutEntry {
  /** Display tokens, in press order. Kept short — they sit in `kbd` chips. */
  keys: readonly string[]
  label: ImageGenKey
  /**
   * The dock/toolbar action this binding triggers, when there is one.
   *
   * The label above describes the gesture (`撤销`) while a control already has
   * its own short label (`canvas.undo`); without this field those two rows
   * cannot find each other and a tooltip silently loses its key hint.
   */
  action?: ImageGenKey
}

/** One section of the panel. */
export interface ShortcutGroup {
  title: ImageGenKey
  entries: readonly ShortcutEntry[]
}

/**
 * Every binding the canvas implements, grouped the way a user looks for them:
 * moving around, picking things, changing things, then acting on a node.
 *
 * A key token starting with `i18n:` is a word rather than a symbol (a wheel, a
 * middle button, a pinch) and is resolved through the active dictionary; the
 * rest are printed as-is because Ctrl/Shift/Esc/Tab read the same everywhere.
 */
export const CANVAS_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'canvas.shortcuts.groupView',
    entries: [
      { keys: ['Ctrl/⌘', 'Space'], label: 'canvas.shortcuts.pan' },
      { keys: ['i18n:canvas.shortcuts.keyMiddle'], label: 'canvas.shortcuts.panMiddle' },
      { keys: ['i18n:canvas.shortcuts.keyWheel'], label: 'canvas.shortcuts.zoom' },
      { keys: ['i18n:canvas.shortcuts.keyPinch'], label: 'canvas.shortcuts.pinch' },
    ],
  },
  {
    title: 'canvas.shortcuts.groupSelect',
    entries: [
      { keys: ['Ctrl/⌘', 'A'], label: 'canvas.shortcuts.selectAll' },
      { keys: ['Shift'], label: 'canvas.shortcuts.marquee' },
      { keys: ['Shift/⌘'], label: 'canvas.shortcuts.multi' },
      { keys: ['Esc'], label: 'canvas.shortcuts.clear' },
    ],
  },
  {
    title: 'canvas.shortcuts.groupEdit',
    entries: [
      { keys: ['Ctrl/⌘', 'Z'], label: 'canvas.shortcuts.undo', action: 'canvas.undo' },
      { keys: ['Ctrl/⌘', 'Shift', 'Z'], label: 'canvas.shortcuts.redo', action: 'canvas.redo' },
      { keys: ['Ctrl/⌘', 'C'], label: 'canvas.shortcuts.copy' },
      { keys: ['Ctrl/⌘', 'V'], label: 'canvas.shortcuts.paste' },
      { keys: ['Ctrl/⌘', 'D'], label: 'canvas.shortcuts.duplicate' },
      { keys: ['Delete'], label: 'canvas.shortcuts.delete', action: 'canvas.delete' },
    ],
  },
  {
    title: 'canvas.shortcuts.groupNode',
    entries: [
      { keys: ['i18n:canvas.shortcuts.keyDoubleClick'], label: 'canvas.shortcuts.create' },
      { keys: ['i18n:canvas.shortcuts.keyDoubleClick'], label: 'canvas.shortcuts.openNode' },
      { keys: ['Tab'], label: 'canvas.shortcuts.focusNode' },
      { keys: ['?'], label: 'canvas.shortcuts.help' },
    ],
  },
]

/**
 * Print one key token: dictionary-backed words go through `tt`, symbols stay
 * verbatim.
 * @param token - a key from {@link CANVAS_SHORTCUTS}.
 * @returns the text to show inside the chip.
 */
export function shortcutKeyText (token: string): string {
  return token.startsWith('i18n:') ? tt(token.slice(5) as ImageGenKey) : token
}

/**
 * Join the keys of the row whose label is `labelKey`, so a control's tooltip can
 * name the key that does the same thing (`撤销 (Ctrl/⌘+Z)`).
 * @param labelKey - the label to look up.
 * @returns the keys joined for a tooltip, or '' when that action has no binding.
 */
export function shortcutKeysFor (labelKey: ImageGenKey): string {
  for (const group of CANVAS_SHORTCUTS) {
    for (const entry of group.entries) {
      if (entry.label === labelKey || entry.action === labelKey) return entry.keys.map(shortcutKeyText).join('+')
    }
  }
  return ''
}

/** Everything inside the dialog that can take focus, in DOM order. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Make this overlay's `role="dialog" aria-modal="true"` true for the keyboard.
 *
 * WHY a copy of `useModalFocus` in DiagnosticsPanel instead of an import:
 * no such helper is exported yet, and the two panels are owned separately, so
 * importing one panel's private helper would couple them: a change there (or a
 * file being edited by someone else) would silently alter this legend. The
 * logic is three short concerns and they belong next to the markup they guard.
 *
 * Semantics are kept identical to the original: the container (which carries
 * `tabIndex={-1}`) takes focus so a screen reader announces the dialog and its
 * label, Tab cycles inside the container instead of walking onto the canvas
 * behind it, Esc is claimed in the capture phase so the canvas's own window
 * keydown never sees it, and the element that had focus before gets it back.
 *
 * Focus goes to the container rather than the × button because the legend is a
 * reference surface: announcing “快捷键” and then letting the user read is what
 * a dialog is for, while landing on “关闭” makes the first Tab stop repeat the
 * same button (the only control) and skips the label.
 *
 * The component is rendered only while open, so mounting is the open signal and
 * there is no `open` parameter to keep in sync.
 *
 * @param ref - the element carrying the dialog role.
 * @param onClose - dismiss the panel; called for Esc too.
 */
function useModalFocus (ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  // Held in a ref: a fresh inline `onClose` on every render would otherwise tear
  // the listeners down and rebuild them, re-focusing the container mid-use.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const container = ref.current
    const opener = document.activeElement
    container?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // The canvas listens for Esc on `window` in the bubble phase; claiming it
        // here in the capture phase stops that handler, so closing the legend
        // does not also clear the canvas selection or close its menus.
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || container === null) return
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (active === null || active === container || !container.contains(active)) {
        // Focus is on the container itself (its initial landing point) or
        // outside entirely. Tab would otherwise continue in document order —
        // straight onto the canvas behind — so send it to the edge the user was
        // travelling towards: forward lands on the close button, backward wraps
        // to the last control inside instead of leaving the dialog.
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // Duck-typed like the original: jsdom hands out elements from another
      // realm where `instanceof HTMLElement` is silently false.
      if (opener !== null && typeof (opener as { focus?: unknown }).focus === 'function') {
        (opener as HTMLElement).focus()
      }
    }
  }, [ref])
}

/**
 * The shortcut legend. Rendered inside the canvas so it inherits the panel's
 * theme tokens, and marked `data-canvas-no-zoom` so a click on it is not read as
 * a canvas gesture.
 * @param props.onClose - dismiss the panel (Esc is handled here, and by the canvas too).
 */
export function ShortcutHelp ({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRef, onClose)
  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div ref={dialogRef} tabIndex={-1} className={css.dialog} role="dialog" aria-modal="true" aria-label={tt('canvas.shortcuts.title')} data-shortcut-help="">
      <header className={css.header}>
        <strong>{tt('canvas.shortcuts.title')}</strong>
        <button type="button" aria-label={tt('canvas.shortcuts.close')} title={tt('canvas.shortcuts.close')} onClick={onClose}>×</button>
      </header>
      <div className={css.body}>
        {CANVAS_SHORTCUTS.map(group => <section key={group.title} className={css.group}>
          <h4>{tt(group.title)}</h4>
          {group.entries.map(entry => <div key={entry.label} className={css.row}>
            <span className={css.keys}>{entry.keys.map(key => <kbd key={key}>{shortcutKeyText(key)}</kbd>)}</span>
            <span className={css.label}>{tt(entry.label)}</span>
          </div>)}
        </section>)}
      </div>
      <footer className={css.footer}>{tt('canvas.shortcuts.hint')}</footer>
    </div>
  </div>
}

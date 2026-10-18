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

/**
 * The shortcut legend. Rendered inside the canvas so it inherits the panel's
 * theme tokens, and marked `data-canvas-no-zoom` so a click on it is not read as
 * a canvas gesture.
 * @param props.onClose - dismiss the panel (Esc is handled by the canvas too).
 */
export function ShortcutHelp ({ onClose }: { onClose: () => void }): React.JSX.Element {
  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-label={tt('canvas.shortcuts.title')} data-shortcut-help="">
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

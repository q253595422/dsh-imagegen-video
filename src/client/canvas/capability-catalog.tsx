/**
 * 「全部功能」弹窗：目录数据在这里被画成可搜索、可键盘操作的一张表。
 *
 * 分类与搜索全在 `capability-catalog.ts`（纯函数、有单测）；这个文件只做三件
 * 事：把查询串交给它、把可用项画出来、把方向键和回车接到行上。
 *
 * WHY 不把状态（查询串、高亮行）抬到 CanvasWorkspace：这个弹窗是**瞬态**的，
 * 打开、选一项、关掉，画布不需要知道它中间查了什么。抬上去只会让那个已经
 * 6500 行的文件再多两个与画布无关的 state，并在每次按键时重渲染整张画布。
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ImageGenKey } from '../locales.ts'
import { tt } from '../helpers.ts'
import { shortcutKeysFor } from '../ShortcutHelp.tsx'
import { ToolbarIcon } from './dock-controls.tsx'
import {
  capabilitySections, CAPABILITY_GROUP_LABELS, runnableItems,
  type CapabilityContext, type CapabilityEntry, type CapabilityId,
} from './capability-catalog.ts'
import css from './capability-catalog.module.css'

/** Everything inside the dialog that can take focus, in DOM order. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Make `role="dialog" aria-modal="true"` true for the keyboard.
 *
 * WHY a third copy of this ten-line helper: `ShortcutHelp` and
 * `DiagnosticsPanel` each keep a private one (see the note in ShortcutHelp), and
 * neither is exported. Exporting one of them from a component file would make a
 * stylesheet-owning panel the home of a keyboard primitive every overlay needs;
 * the honest fix is a shared module, and that is a refactor of three files, not
 * something to smuggle in under a search box. Same semantics, so the three
 * dialogs behave identically: container takes focus, Tab cycles, Esc is claimed
 * in the capture phase, the opener gets focus back.
 *
 * Unlike the other two, focus does NOT land on the container here: this dialog
 * exists to type into, so the search field takes the caret on open.
 *
 * @param focusSelector - element inside the dialog that receives focus on open.
 *   Dialogs whose first control is not the catalog search pass their own; the
 *   default keeps the catalog's behavior.
 */
export function useModalFocus (ref: RefObject<HTMLElement | null>, onClose: () => void, focusSelector = '[data-catalog-search]'): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const container = ref.current
    const opener = document.activeElement
    container?.querySelector<HTMLElement>(focusSelector)?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Capture phase: the canvas listens for Esc on window in the bubble
        // phase and would otherwise clear the selection behind the dialog.
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
      if (active === null || !container.contains(active)) {
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
      // Duck-typed: jsdom hands out elements from another realm where
      // `instanceof HTMLElement` is silently false.
      if (opener !== null && typeof (opener as { focus?: unknown }).focus === 'function') {
        (opener as HTMLElement).focus()
      }
    }
  }, [ref, focusSelector])
}

export function CapabilityCatalog (props: {
  entries: readonly CapabilityEntry[]
  context: CapabilityContext
  onRun: (id: CapabilityId) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<CapabilityId | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRef, props.onClose)

  const translate = useMemo(() => (key: ImageGenKey): string => tt(key), [])
  const sections = useMemo(
    () => capabilitySections(props.entries, props.context, query, translate),
    [props.entries, props.context, query, translate],
  )
  const runnable = useMemo(() => runnableItems(sections), [sections])

  // The highlight has to survive a query change honestly: the row it pointed at
  // may be filtered out. Falling back to the first runnable row is what the user
  // expects after typing — Enter now runs the top result, not a hidden row.
  const activeIndex = (() => {
    const index = runnable.findIndex(item => item.entry.id === activeId)
    return index === -1 ? (runnable.length === 0 ? -1 : 0) : index
  })()
  const activeRowId = runnable[activeIndex]?.entry.id ?? null

  /**
   * Move the highlight by `delta` among runnable rows and keep it on screen.
   *
   * Scrolling through the ref list rather than `scrollIntoView`: the latter
   * also scrolls the page behind the dialog in some browsers, which reads as
   * the whole canvas jumping while the user is picking a menu item.
   */
  const move = (delta: number): void => {
    if (runnable.length === 0) return
    const next = (activeIndex + delta + runnable.length) % runnable.length
    setActiveId(runnable[next]!.entry.id)
    const row = listRef.current?.querySelector<HTMLElement>(`[data-capability="${runnable[next]!.entry.id}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  const runActive = (): void => {
    const item = runnable[activeIndex]
    if (item === undefined) return
    props.onRun(item.entry.id)
  }

  return <div className={css.backdrop} data-canvas-no-zoom="" onPointerDown={event => event.stopPropagation()}>
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={css.dialog}
      role="dialog"
      aria-modal="true"
      aria-label={tt('canvas.catalog.title')}
      data-capability-catalog=""
      onKeyDown={event => {
        // Claimed here, not on `window`: the canvas's own handler would read
        // ArrowDown/Enter as canvas gestures, and both keys mean "move inside
        // this list" while the dialog is open.
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'Enter' && (event.target as HTMLElement | null)?.tagName === 'INPUT') {
          // In the search field Enter runs the highlighted row; on a focused row
          // button Enter already dispatches its own click, and doubling it here
          // would run the action twice.
          event.preventDefault()
          runActive()
        }
      }}
    >
      <header className={css.header}>
        <input
          data-catalog-search=""
          className={css.search}
          value={query}
          placeholder={tt('canvas.catalog.searchPlaceholder')}
          aria-label={tt('canvas.catalog.searchPlaceholder')}
          onChange={event => setQuery(event.target.value)}
        />
        <button type="button" className={css.close} aria-label={tt('canvas.catalog.close')} title={tt('canvas.catalog.close')} onClick={props.onClose}>×</button>
      </header>
      <div ref={listRef} className={css.body} data-catalog-list="">
        {sections.length === 0
          ? <p className={css.empty}>{tt('canvas.catalog.empty', { query })}</p>
          : sections.map(section => <section key={section.group} className={css.group} data-catalog-group={section.group}>
              <h4>{tt(CAPABILITY_GROUP_LABELS[section.group])}</h4>
              {section.items.map(item => {
                // 键位徽章。文本只从 `shortcutKeysFor` 来——那张表是唯一一份
                // 键位事实，界面里再拼一份，两处必然走散（改了键位、目录还在
                // 说旧键，用户会照着按，然后以为功能坏了）。
                //
                // 灰行**不显示**徽章：一条按下去没反应的行旁边写着 Ctrl/⌘+Z，
                // 等于告诉用户「这个现在能用」。空字符串也走同一支，于是没有
                // 快捷键的行右侧不留空列——一个永远存在的空白列会让每一行的
                // 标题都短一截，看起来像被裁掉了。
                const keys = item.blockedBy === null ? shortcutKeysFor(item.entry.labelKey) : ''
                return <button
                  key={item.entry.id}
                  type="button"
                  className={css.row}
                  data-capability={item.entry.id}
                  data-blocked={item.blockedBy !== null ? '' : undefined}
                  data-active={item.entry.id === activeRowId ? '' : undefined}
                  // 不可用的行**不 disabled**：`disabled` 会让它从 Tab 顺序里消失，
                  // 键盘用户于是永远看不到「为什么这条不能点」。它照样能聚焦，
                  // 只是按下去没有动作。
                  aria-disabled={item.blockedBy !== null}
                  title={item.blockedBy === null ? undefined : tt(item.blockedBy)}
                  onClick={() => {
                    if (item.blockedBy !== null) return
                    props.onRun(item.entry.id)
                  }}
                  onMouseEnter={() => setActiveId(item.entry.id)}
                >
                  <span className={css.icon}><ToolbarIcon name={item.entry.icon} size={16} /></span>
                  <span className={css.text}>
                    <strong>{tt(item.entry.labelKey)}</strong>
                    <small>{item.blockedBy === null ? tt(item.entry.hintKey) : tt(item.blockedBy)}</small>
                  </span>
                  {/* 不加 `aria-hidden`：键位是这个按钮的真实一部分，读屏按到的
                      应该是「撤销 Ctrl/⌘+Z」，而不是一个只剩标题的按钮。 */}
                  {keys === '' ? null : <kbd className={css.keys} data-quick-keys="">{keys}</kbd>}
                </button>
              })}
            </section>)}
      </div>
      <footer className={css.footer}>{tt('canvas.catalog.footer')}</footer>
    </div>
  </div>
}

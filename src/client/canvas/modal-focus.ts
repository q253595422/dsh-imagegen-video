/**
 * 让 `role="dialog" aria-modal="true"` 对键盘成立。
 *
 * WHY 一个共享模块而不是每个弹窗各抄一份：`ShortcutHelp` 与 `DiagnosticsPanel`
 * 已经各有一份私有实现（后者导出了，但签名不同：它带 `open` 参数）。第三、
 * 第四份复制不会更安全，只会让「按 Esc 会不会顺手清掉画布选区」这件事出现
 * 四种答案。这里把**拾取器类**弹窗（要打字、焦点落在搜索框）的那一种收成一份；
 * 快捷键表那种「焦点落在容器上先让读屏念标题」的语义不同，仍留在原处。
 *
 * 四条语义，缺一条都会在真机上表现出来：
 *   - 打开时焦点进搜索框，用户不必先点一下；
 *   - Esc 在**捕获阶段**拦下：画布的监听挂在 `window` 冒泡阶段，不拦就会
 *     顺手把后面的选区清掉（「关掉弹窗，选中也没了」）；
 *   - Tab 在弹窗内循环，不会跑到画布上；
 *   - 关闭后焦点回到打开它的那个元素。
 */

import { useEffect, useRef, type RefObject } from 'react'

/** Everything inside the dialog that can take focus, in DOM order. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

/**
 * @param ref - carrying the dialog role.
 * @param onClose - dismiss the panel; called for Esc too.
 * @param focusSelector - element to focus on open; defaults to the container.
 */
export function usePickerFocus (ref: RefObject<HTMLElement | null>, onClose: () => void, focusSelector?: string): void {
  // 收进 ref：调用方每次渲染都传一个新闭包，直接进依赖会拆装监听、
  // 并在使用途中把焦点抢回来一次。
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const container = ref.current
    const opener = document.activeElement
    if (focusSelector !== undefined) container?.querySelector<HTMLElement>(focusSelector)?.focus()
    else container?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
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

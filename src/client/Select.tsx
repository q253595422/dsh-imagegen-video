/** Theme-aware select shared by filters, forms and canvas controls. */
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './select.module.css'

export interface SelectOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

type OptionProps = { value?: string | number; label?: string; children?: ReactNode; disabled?: boolean }

function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<OptionProps>(child)
    ? optionText(child.props.children)
    : String(child)).join('')
}

/** Keep option/optgroup declarations readable at the call site. */
function optionsFromChildren(children: ReactNode, group?: string, disabled = false): SelectOption[] {
  const result: SelectOption[] = []
  Children.forEach(children, child => {
    if (!isValidElement<OptionProps>(child)) return
    if (child.type === 'optgroup' || child.type === Fragment) {
      result.push(...optionsFromChildren(child.props.children, child.props.label ?? group, disabled || child.props.disabled === true))
    } else if (child.type === 'option') {
      const label = child.props.label ?? optionText(child.props.children)
      result.push({ value: String(child.props.value ?? label), label, group, disabled: disabled || child.props.disabled === true })
    }
  })
  return result
}

export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  value: string
  options?: SelectOption[]
  children?: ReactNode
  variant?: 'field' | 'compact' | 'composer' | 'toolbar'
  onChange: (value: string) => void
}

export function Select({ value, options: suppliedOptions, children, variant = 'field', onChange, className, disabled, id, onKeyDown, onClick, ...buttonProps }: SelectProps): React.JSX.Element {
  const options = suppliedOptions ?? optionsFromChildren(children)
  const selectedIndex = options.findIndex(option => option.value === value)
  const selected = options[selectedIndex] ?? options[0]
  const generatedId = useId()
  const triggerId = id ?? `dsh-select-${generatedId}`
  const menuId = `${triggerId}-listbox`
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef({ text: '', time: 0 })
  const unavailable = disabled === true || options.every(option => option.disabled === true)

  const dismiss = (): void => { setOpen(false); triggerRef.current?.focus() }
  const show = (last = false): void => {
    if (unavailable) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const width = Math.min(Math.max(rect.width, 168, Math.min(360, Math.max(...options.map(option => option.label.length)) * 7 + 28)), window.innerWidth - 16)
    const below = window.innerHeight - rect.bottom - 14
    const above = below < 160 && rect.top - 14 > below
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: above ? rect.top - 6 : rect.bottom + 6,
      width,
      maxHeight: Math.max(36, Math.min(278, above ? rect.top - 14 : below)),
      above,
    })
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
    setActiveIndex(selectedIndex >= 0 && !selected?.disabled ? selectedIndex : enabled[last ? enabled.length - 1 : 0] ?? 0)
    searchRef.current = { text: '', time: 0 }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    menuRef.current?.focus()
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && (triggerRef.current?.contains(target) || menuRef.current?.contains(target))) return
      setOpen(false)
    }
    const viewportChanged = (event: Event): void => {
      if (event.target instanceof Element && menuRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', viewportChanged)
    window.addEventListener('scroll', viewportChanged, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', viewportChanged)
      window.removeEventListener('scroll', viewportChanged, true)
    }
  }, [open])

  useEffect(() => {
    if (unavailable) setOpen(false)
  }, [unavailable])

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const choose = (index: number): void => {
    const option = options[index]
    if (option === undefined || option.disabled) return
    onChange(option.value)
    dismiss()
  }
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      dismiss()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(activeIndex)
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const current = enabled.indexOf(activeIndex)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
      setActiveIndex(enabled[next] ?? 0)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      const now = Date.now()
      const text = (now - searchRef.current.time < 700 ? searchRef.current.text : '') + event.key.toLocaleLowerCase()
      searchRef.current = { text, time: now }
      const next = [...enabled.filter(index => index > activeIndex), ...enabled.filter(index => index <= activeIndex)]
        .find(index => options[index]?.label.toLocaleLowerCase().startsWith(text))
      if (next !== undefined) setActiveIndex(next)
    }
  }

  return <>
    <button
      {...buttonProps}
      ref={triggerRef}
      id={triggerId}
      type="button"
      className={`${css.trigger}${className ? ` ${className}` : ''}`}
      data-dsh-select=""
      data-variant={variant}
      data-open={open ? '' : undefined}
      disabled={unavailable}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={buttonProps.title ?? selected?.label}
      onClick={event => { onClick?.(event); if (!event.defaultPrevented) { if (open) dismiss(); else show() } }}
      onKeyDown={event => {
        onKeyDown?.(event)
        if (!event.defaultPrevented && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show(event.key === 'ArrowUp') }
      }}
    >
      <span className={css.value}>{selected?.label ?? value}</span>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && position !== null ? createPortal(<div
      ref={menuRef}
      id={menuId}
      className={css.menu}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : undefined }}
      role="listbox"
      tabIndex={-1}
      aria-labelledby={triggerId}
      aria-activedescendant={options[activeIndex] === undefined ? undefined : `${menuId}-${activeIndex}`}
      data-dsh-select-menu=""
      data-canvas-no-zoom=""
      onKeyDown={menuKeyDown}
      onPointerDown={event => { event.stopPropagation() }}
    >
      {options.map((option, index) => <Fragment key={`${option.value}-${index}`}>
        {option.group !== undefined && option.group !== options[index - 1]?.group ? <span className={css.group}>{option.group}</span> : null}
        <button
          id={`${menuId}-${index}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === Math.max(0, selectedIndex)}
          disabled={option.disabled}
          className={css.option}
          data-selected={index === Math.max(0, selectedIndex) ? '' : undefined}
          data-highlighted={index === activeIndex ? '' : undefined}
          data-option-index={index}
          title={option.label}
          onPointerEnter={() => { if (!option.disabled) setActiveIndex(index) }}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { choose(index) }}
        >{option.label}</button>
      </Fragment>)}
    </div>, document.body) : null}
  </>
}

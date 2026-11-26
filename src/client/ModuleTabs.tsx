/**
 * Top-level module switcher, following DSH's own settings-tab pattern:
 * text-weight hierarchy plus a 2px underline, not a floating capsule.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { onTablistKeyDown, tabIndexFor } from './tablist.ts'
import css from './ModuleTabs.module.css'

export interface ModuleTabItem {
  key: string
  label: ReactNode
}

export function ModuleTabs(props: {
  items: ModuleTabItem[]
  activeIndex: number
  onSelect: (index: number) => void
  ariaLabel?: string
}): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const active = activeRef.current
    const scroller = active?.closest<HTMLElement>('[data-module-tabs-scroll]')
    if (active === null || active === undefined || scroller === null || scroller === undefined) return
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    if (left < scroller.scrollLeft) scroller.scrollLeft = left
    else if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right - scroller.clientWidth
    }
  }, [props.activeIndex])

  return <div className={css.root}>
    <nav
      className={css.tabs}
      data-module-tabs-scroll=""
      role="tablist"
      aria-label={props.ariaLabel}
    >
      {props.items.map((item, index) => {
        const active = props.activeIndex === index
        return <button
          key={item.key}
          ref={active ? activeRef : undefined}
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={active}
          tabIndex={tabIndexFor(active)}
          onKeyDown={event => {
            onTablistKeyDown(event, {
              count: props.items.length,
              index,
              select: props.onSelect,
            })
          }}
          onClick={() => props.onSelect(index)}
        >
          {item.label}
        </button>
      })}
    </nav>
  </div>
}

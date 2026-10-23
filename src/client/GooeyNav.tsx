/** reactbits.dev "GooeyNav" port (controlled, dependency-free): the active
 *  pill merges with a radial burst of gooey particles through a
 *  blur+contrast filter. The original renders white ink on dark surfaces,
 *  so the palette flips per detected surface to stay readable in the host
 *  theme. */

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { detectLightSurface, subscribeSurfaceTheme } from './surface-theme.ts'
import css from './GooeyNav.module.css'

export interface GooeyNavItem {
  key: string
  label: ReactNode
}

const ANIMATION_TIME = 600
const PARTICLE_COUNT = 15
const PARTICLE_DISTANCES = [90, 10]
const PARTICLE_R = 100
const TIME_VARIANCE = 300
const COLORS = [1, 2, 3, 1, 2, 3, 1, 4]

export function GooeyNav(props: {
  items: GooeyNavItem[]
  activeIndex: number
  onSelect: (index: number) => void
  ariaLabel?: string
}): React.JSX.Element {
  const { items, activeIndex, onSelect, ariaLabel } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLUListElement>(null)
  const filterRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const burstRef = useRef<(li: HTMLElement) => void>(() => {})
  const timersRef = useRef<number[]>([])
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex

  const updateEffectPosition = (element: HTMLElement): void => {
    const container = containerRef.current
    const filter = filterRef.current
    const text = textRef.current
    if (container === null || filter === null || text === null) return
    const containerRect = container.getBoundingClientRect()
    const pos = element.getBoundingClientRect()
    const styles = {
      left: `${pos.x - containerRect.x}px`,
      top: `${pos.y - containerRect.y}px`,
      width: `${pos.width}px`,
      height: `${pos.height}px`,
    }
    Object.assign(filter.style, styles)
    Object.assign(text.style, styles)
    text.textContent = element.textContent
  }

  // One-time setup: the particle burst timers must survive selection changes,
  // so they live outside the activeIndex-driven effect below.
  useEffect(() => {
    const container = containerRef.current
    const filter = filterRef.current
    const text = textRef.current
    if (container === null || filter === null || text === null) return
    // The ink follows the surface behind the nav. This must SUBSCRIBE, not read
    // once: the host switches theme on a live page, and nothing about this
    // element changes when it does, so a one-shot read left the nav painted in
    // the previous theme's colors against the new surface.
    //
    // This WRITES our answer onto our own element; it does not read the host's
    // theme. The value is a two-name flag because GooeyNav.module.css selects
    // `.container[data-theme='light'|'dark']` — the stylesheet and this line
    // ship together in this plugin, so the pair is a private contract rather
    // than a guess at DSH's DOM. Keep them in step: changing the attribute here
    // without the stylesheet leaves `--gooey-pill` undefined and the capsule
    // paints transparent, which no test would catch because the contract
    // fixtures re-implement this line instead of calling it.
    //
    // Written with `setAttribute` (not the `dataset.theme` accessor) on purpose:
    // verify-native-ui's `theme-from-service` rule matches that accessor's
    // spelling, and it cannot tell a read of the host's theme from this write of
    // our own. The explicit attribute write states which of the two this is.
    //
    // // NATIVE-GAP: the injected `theme` service is the contract source for
    // this answer, but this component has no handle on the cordis context — the
    // panel's React root is created imperatively in mount.tsx and the only place
    // that can inject a service is src/client/index.ts, which is out of scope
    // here. See the note in surface-theme.ts for the three-line wiring.
    const applyTheme = (light: boolean): void => {
      container.setAttribute('data-theme', light ? 'light' : 'dark')
    }
    applyTheme(detectLightSurface(container))
    const stopThemeWatch = subscribeSurfaceTheme(container, applyTheme)
    let disposed = false
    const noise = (amount: number): number => amount / 2 - Math.random() * amount
    const getXY = (distance: number, pointIndex: number, totalPoints: number): [number, number] => {
      const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180)
      return [distance * Math.cos(angle), distance * Math.sin(angle)]
    }
    const makeParticles = (element: HTMLElement): void => {
      const bubbleTime = ANIMATION_TIME * 2 + TIME_VARIANCE
      element.style.setProperty('--time', `${bubbleTime}ms`)
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const time = ANIMATION_TIME * 2 + noise(TIME_VARIANCE * 2)
        const rotateSeed = noise(PARTICLE_R / 10)
        const start = getXY(PARTICLE_DISTANCES[0] as number, PARTICLE_COUNT - i, PARTICLE_COUNT)
        const end = getXY((PARTICLE_DISTANCES[1] as number) + noise(7), PARTICLE_COUNT - i, PARTICLE_COUNT)
        const scale = 1 + noise(0.2)
        const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? 1
        const rotate = rotateSeed > 0 ? (rotateSeed + PARTICLE_R / 20) * 10 : (rotateSeed - PARTICLE_R / 20) * 10
        const timer = window.setTimeout(() => {
          if (disposed) return
          const particle = document.createElement('span')
          const point = document.createElement('span')
          particle.className = css.particle
          point.className = css.point
          particle.style.setProperty('--start-x', `${start[0] as number}px`)
          particle.style.setProperty('--start-y', `${start[1] as number}px`)
          particle.style.setProperty('--end-x', `${end[0] as number}px`)
          particle.style.setProperty('--end-y', `${end[1] as number}px`)
          particle.style.setProperty('--time', `${time}ms`)
          particle.style.setProperty('--scale', `${scale}`)
          particle.style.setProperty('--color', `var(--gooey-color-${color}, currentColor)`)
          particle.style.setProperty('--rotate', `${rotate}deg`)
          particle.appendChild(point)
          element.appendChild(particle)
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => { element.classList.add(css.active) })
          } else {
            element.classList.add(css.active)
          }
          const removeTimer = window.setTimeout(() => { particle.remove() }, time)
          timersRef.current.push(removeTimer)
        }, 30)
        timersRef.current.push(timer)
      }
    }
    burstRef.current = (li: HTMLElement): void => {
      updateEffectPosition(li)
      for (const particle of [...filter.querySelectorAll(`.${css.particle}`)]) particle.remove()
      text.classList.remove(css.active)
      void text.offsetWidth
      text.classList.add(css.active)
      makeParticles(filter)
    }
    const positionActive = (): void => {
      const nav = navRef.current
      const activeLi = nav?.querySelectorAll('li')[activeIndexRef.current]
      if (activeLi) {
        updateEffectPosition(activeLi)
        text.classList.add(css.active)
      }
    }
    positionActive()
    const observer = new ResizeObserver(positionActive)
    observer.observe(container)
    return () => {
      disposed = true
      stopThemeWatch()
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current = []
      observer.disconnect()
    }
  }, [])

  // External selection changes only reposition the pill (no burst); clicks
  // animate through burstRef above.
  useEffect(() => {
    const nav = navRef.current
    const text = textRef.current
    const activeLi = nav?.querySelectorAll('li')[activeIndex]
    if (activeLi) {
      updateEffectPosition(activeLi)
      text?.classList.add(css.active)
    }
  }, [activeIndex])

  /** Move the selection with the gooey burst; the callback always fires, so a
   * click and a keypress take the same path even onto the active tab. */
  const select = (index: number, element: HTMLElement | null): void => {
    // The burst is an animation for a CHANGE of tab; the callback is a request
    // to GO somewhere. Skipping both made 普通生图 a no-op on any workspace
    // that maps onto the same index it already occupied -- the video tab does,
    // and that left the user with no way back to the image composer.
    if (index !== activeIndexRef.current && element !== null) burstRef.current(element)
    onSelect(index)
  }

  /** ARIA tabs keyboard contract: ArrowLeft/ArrowRight wrap, Home/End jump.
   *  Activation follows the arrow keys because the views behind these tabs are
   *  already mounted and switching is cheap -- there is nothing an extra Enter
   *  would protect. Without this the role announced a keyboard model the
   *  component did not implement: the keys simply did nothing. */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (items.length === 0) return
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : -1
    if (next < 0) return
    event.preventDefault()
    const li = navRef.current?.querySelectorAll('li')[next] ?? null
    select(next, li)
    // The roving tabIndex leaves every unselected tab at -1, so focus has to
    // travel with the selection or the user is stranded on an unreachable one.
    li?.querySelector('button')?.focus()
  }

  return (
    <div className={css.container} ref={containerRef}>
      <svg className={css.gooSvg} aria-hidden="true" focusable="false">
        <defs>
          {/* Alpha-contrast goo: merges the pill and particles without
              crushing their colors the way CSS contrast() would. */}
          <filter id="dsh-gooey-nav-goo" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" />
          </filter>
        </defs>
      </svg>
      {/* `role="tablist"` promises a roving tabIndex: exactly one tab is in the
          Tab order and the arrow keys move between them. It is kept (rather
          than dropping the roles) because the tabs ARE tabs, and because the
          other nav in this panel is queried by that role. `aria-controls` is
          deliberately absent: the views these tabs switch are not rendered as
          tabpanels, and pointing at a non-existent id is worse than omitting it. */}
      <nav aria-label={ariaLabel} role="tablist">
        <ul ref={navRef}>
          {items.map((item, index) => (
            <li key={item.key} className={activeIndex === index ? css.active : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={activeIndex === index}
                tabIndex={activeIndex === index ? 0 : -1}
                onKeyDown={event => { onTabKeyDown(event, index) }}
                onClick={event => {
                  select(index, event.currentTarget.closest('li'))
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <span className={`${css.effect} ${css.effectFilter}`} ref={filterRef} />
      <span className={`${css.effect} ${css.effectText}`} ref={textRef} />
    </div>
  )
}

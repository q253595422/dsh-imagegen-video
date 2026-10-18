import { memo, type CSSProperties } from 'react'
import css from './generation-loading.module.css'

// A fixed, bounded SVG field: CSS drives the wave without timers or React updates.
const dots = Array.from({ length: 19 * 25 }, (_, index) => {
  const x = index % 19
  const y = Math.floor(index / 19)
  const distance = Math.hypot((x - 8) / 12, (y - 10) / 16)
  return {
    x: 10 + x * 20,
    y: 10 + y * 20,
    radius: 1.3 + 3.7 * Math.max(0, 1 - distance),
    style: { animationDelay: `${(-x * 0.13 - y * 0.09).toFixed(2)}s` } as CSSProperties,
  }
})
// Comparison cards share the wave but use a sparser field to bound work per model.
const compactDots = dots.filter((_, index) => index % 19 % 2 === 0 && Math.floor(index / 19) % 2 === 0)

/** Decorative activity only. Task state and elapsed time come from the host. */
export const GenerationLoading = memo(function GenerationLoading({ title, hint, compact = false }: { title: string; hint: string; compact?: boolean }) {
  return (
    <div className={css.field} data-generation-animation="" data-compact={compact ? '' : undefined}>
      <svg className={css.dots} viewBox="0 0 380 500" aria-hidden="true" focusable="false">
        {(compact ? compactDots : dots).map((dot, index) => (
          <circle key={index} className={css.dot} cx={dot.x} cy={dot.y} r={dot.radius} style={dot.style} />
        ))}
      </svg>
      <div className={css.badge}>
        <span className={css.title}>{title}</span>
        <span className={css.hint}>{hint}</span>
      </div>
    </div>
  )
})

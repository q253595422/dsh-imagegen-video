/**
 * Surface theming for the ported reactbits visuals.
 *
 * `detectLightSurface` answers "is the surface behind this element light?"
 * by walking up to the first opaque background. That is a snapshot, and the
 * DSH host switches theme at runtime — so anything that picks its ink from the
 * answer needs to be re-asked, not asked once.
 */

/**
 * Walk up from an element to the first opaque surface and decide light vs dark,
 * so ported reactbits visuals can pick their ink. Non-browser environments
 * (jsdom smoke) have no computed styles and default to dark.
 */
export function detectLightSurface(element: HTMLElement): boolean {
  if (typeof globalThis.getComputedStyle !== 'function') return false
  let node: HTMLElement | null = element
  while (node !== null) {
    const color = getComputedStyle(node).backgroundColor
    const match = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/)
    if (match !== null) {
      const alpha = match[4] !== undefined ? Number(match[4]) : 1
      if (alpha >= 0.5) {
        const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
        return luminance > 0.55
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * Call `onChange` whenever the light/dark answer for `element` may have changed,
 * and return the disposer.
 *
 * WHY this exists rather than a one-shot read at mount: the host switches theme
 * on a running page. Nothing about the element itself changes in that case, so
 * no ResizeObserver or React render notices it — a visual that read the answer
 * once keeps the ink it was built with and goes unreadable against the new
 * surface. Three signals are needed to catch every way the answer can move:
 *
 *  - the root `class` / `data-theme` attributes, which is how DSH and most
 *    theme systems publish the switch (an ancestor's background changes);
 *  - the OS preference, for a host that follows it without touching the DOM;
 *  - our own element being re-parented, when a shell rebuild moves it onto a
 *    different surface.
 *
 * A MutationObserver on the whole document would be the lazy version; this
 * watches only the attributes that can actually carry a theme, so it does not
 * fire on every node the panel renders.
 */
export function subscribeSurfaceTheme(element: HTMLElement, onChange: (light: boolean) => void): () => void {
  let last = detectLightSurface(element)
  const report = (): void => {
    const next = detectLightSurface(element)
    if (next === last) return
    last = next
    onChange(next)
  }

  // The theme is published as an attribute on <html> or <body>. DSH uses
  // `data-ds-dark-theme` on <body>; `class` and `data-theme` cover the other
  // systems this plugin can run under (and a shell that sets either). All three
  // are watched -- an attribute-only observer that misses the real one is a
  // subscription that never fires.
  const roots = [document.documentElement, document.body].filter(Boolean)
  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(report)
    : null
  for (const root of roots) {
    observer?.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme', 'style'] })
  }

  const media = typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(prefers-color-scheme: dark)')
    : null
  media?.addEventListener?.('change', report)

  // A re-parented element sits on a different surface; the parent observer
  // below is what notices that (an attribute-only observer would not).
  const parentObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(report)
    : null
  const parent = element.parentElement
  if (parent !== null) parentObserver?.observe(parent, { childList: true })

  return () => {
    observer?.disconnect()
    parentObserver?.disconnect()
    media?.removeEventListener?.('change', report)
  }
}

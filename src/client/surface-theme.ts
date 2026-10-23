/**
 * Surface theming for the ported reactbits visuals.
 *
 * `detectLightSurface` answers "is the surface behind this element light?"
 * by walking up to the first opaque background. That is a snapshot, and the
 * DSH host switches theme at runtime — so anything that picks its ink from the
 * answer needs to be re-asked, not asked once.
 *
 * // NATIVE-GAP: the contract-preferred source is the injected `theme` service
 * (snapshot field `active.colorScheme`, event `theme/change`, provided by
 * dsh-client-ui-theme). This surface cannot reach it: the panel's React root is
 * created imperatively from `mount.tsx`, which receives only the services
 * `src/client/index.ts` hands it, and that file is outside this change's scope.
 * Wiring it is three lines there — add `'theme'` to `inject`, then pass
 * `theme: { getSnapshot: () => ctx.get('theme').getTheme(), subscribe }` into
 * `mountPanel` — after which the subscription below is the secondary path.
 * Until then this measures the surface and re-measures when the host publishes
 * the switch, which is what keeps the nav readable instead of asking the user
 * to reload.
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
 *  - the attributes the DSH theme presenter writes when it applies a snapshot
 *    (dsh-client-ui-layout, `ThemePresenter.apply`): `data-ds-dark-theme` and
 *    `data-ds-theme-source` on <body>/<html>, plus `style.color-scheme`, which
 *    is how a host that merely swaps tokens rather than an attribute shows up;
 *  - `class` / `data-theme`, for other theme systems this plugin can run under
 *    (and for a shell that sets either instead);
 *  - our own element being re-parented, when a shell rebuild moves it onto a
 *    different surface.
 *
 * A MutationObserver on the whole document would be the lazy version; this
 * watches only the attributes that can actually carry a theme, so it does not
 * fire on every node the panel renders.
 *
 * No OS-preference media query is watched here. DSH resolves `system` itself
 * (`ThemeRuntime.buildSnapshot`: `media.matches ? 'dark' : 'light'`) and its
 * presenter writes the resolved answer onto the document, so an OS flip
 * re-emits `theme/change`, which re-applies the attributes observed above. A
 * separate query would be a second source of truth that can disagree with the
 * palette actually painted.
 */
export function subscribeSurfaceTheme(element: HTMLElement, onChange: (light: boolean) => void): () => void {
  let last = detectLightSurface(element)
  const report = (): void => {
    const next = detectLightSurface(element)
    if (next === last) return
    last = next
    onChange(next)
  }

  const roots = [document.documentElement, document.body].filter(Boolean)
  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(report)
    : null
  for (const root of roots) {
    observer?.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme', 'data-ds-theme-source', 'style'],
    })
  }

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
  }
}

/**
 * Build for the visual-acceptance page (`scripts/studio-preview.tsx`).
 *
 * Reuses the plugin bundle's client config so the preview renders the same
 * module CSS the shipped bundle does, then changes exactly three things:
 *
 *  - `format: 'iife'` — the preview is a plain `<script>` in a static page, not
 *    a `__ModuleLoader__` registration.
 *  - `deps.neverBundle: []` — the shipped bundle treats
 *    `@deepseek-ai/dsh-client-ui-primitives` as a platform module and expects the
 *    shell to supply it. The preview page has no shell, and the only reason this
 *    build exists is to show the REAL primitives, so they get inlined.
 *  - plain `.css` imports are stubbed: primitives pull in `katex`/`shiki`, whose
 *    stylesheets are for markdown math and code highlighting — neither appears
 *    in the studio, and their `url()` font references would 404 against the
 *    preview's static server. Without this stub the build fails outright.
 */
import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'

const client = configs[1]

/**
 * Virtual id for a stubbed plain stylesheet.
 *
 * The suffix is deliberately NOT `.css`: tsdown's own css guard claims any
 * resolved id ending in `.css`, and it would fail on this one before `load`
 * ever ran.
 */
const PLAIN_CSS_PREFIX = '\0studio-preview-css-stub:'
const PLAIN_CSS_SUFFIX = '.stub'

export default {
  ...client,
  name: 'studio-preview',
  entry: { preview: fileURLToPath(new URL('./studio-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.studio-preview', import.meta.url)),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  clean: true,
  // The real primitives ship .module.css files and a clsx dependency; bundling
  // them is the whole point (a stub cannot show whether the studio looks native).
  deps: {
    neverBundle: [],
    alwaysBundle: ['react', 'react-dom', 'lucide-react', '@deepseek-ai/dsh-client-ui-primitives', 'clsx'],
  },
  plugins: [
    // Must run BEFORE the shared css-modules plugin: that one only claims
    // `.module.css`, and tsdown's own css guard claims everything else.
    {
      name: 'studio-preview-plain-css-stub',
      enforce: 'pre' as const,
      resolveId(source: string) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        return PLAIN_CSS_PREFIX + source + PLAIN_CSS_SUFFIX
      },
      load(id: string) {
        if (!id.startsWith(PLAIN_CSS_PREFIX)) return null
        return 'export default {}\n'
      },
    },
    ...(client.plugins ?? []),
  ],
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '', intro: '' },
}

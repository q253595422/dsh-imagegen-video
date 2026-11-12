/**
 * Standalone tsdown build for @q253595422/dsh-imagegen-video.
 *
 * Replicates the dsh client-bundle contract (packages/client/tsdown.client.ts
 * preset) so the package builds without depending on the dsh monorepo:
 *
 *  - Node half  -> lib/index.js (ESM, externals stay bare)
 *  - Client half -> lib/client.js (CJS browser bundle that registers itself
 *    via `window.__ModuleLoader__.load({ id, factory })`, resolving platform
 *    modules through the injected require and inlining everything else; CSS
 *    Modules are compiled by lightningcss and injected as <style> tags).
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Resolve bare package CSS paths (e.g. @xyflow/react/dist/style.css) without
 *  involving rolldown's resolver — going through this.resolve() makes rolldown
 *  record the original specifier as an external dependency and hoist a stray
 *  `require("@xyflow/react/dist/style.css")` into the CJS bundle that the host
 *  loader cannot resolve. */
const nodeRequire = createRequire(import.meta.url)

/** Plugin id (package name) stamped into the __ModuleLoader__.load handoff. */
const ID = '@q253595422/dsh-imagegen-video'

/** react-flow ships a global stylesheet (.react-flow__* rules). Importing it
 *  through JS makes rolldown hoist a `require("@xyflow/react/dist/style.css")`
 *  into the CJS bundle that the host loader cannot resolve, so instead we read
 *  and minify it at build time and inject it from the client intro. The bytes
 *  are stable (no cssModules hash), keeping the build reproducible. */
const xyflowCss = transform({
  filename: '@xyflow/react/dist/style.css',
  code: readFileSync(nodeRequire.resolve('@xyflow/react/dist/style.css')),
  minify: true,
}).code.toString()
const xyflowCssTag = `${ID}/xyflow-style.css`
const xyflowCssInjection = `if(typeof document!=='undefined'&&document.querySelector('style[data-plugin-css='+JSON.stringify(${JSON.stringify(xyflowCssTag)})+']')===null){var __xyflowStyle=document.createElement('style');__xyflowStyle.dataset.plugin=${JSON.stringify(ID)};__xyflowStyle.dataset.pluginCss=${JSON.stringify(xyflowCssTag)};__xyflowStyle.textContent=${JSON.stringify(xyflowCss)};document.head.appendChild(__xyflowStyle);}`

/**
 * The module specifiers the web shell shares into the frozen module table
 * (mirror of @deepseek-ai/dsh-client-web PLATFORM_MODULES) plus the store
 * store exemption. Anything else is inlined by the bundle.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-store',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 *
 * The id is deliberately synthetic (`\0dsh-css:src/client/panel.module.css.mjs`)
 * rather than the CSS file's absolute path. Rolldown stamps each module's id
 * into a `//#region <id>` banner that survives into the emitted bundle, and
 * lib/ IS published to npm (see `files`) — an absolute id would therefore ship
 * this machine's directory layout to every consumer, and would make the
 * bundle's bytes depend on where the repo was checked out. A repo-relative id
 * is stable, unique, and reveals nothing the repository does not already
 * publish.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
/** Global (non-module) CSS — e.g. `@xyflow/react/dist/style.css` — inlined as a
 *  plain <style> tag with NO class-name hashing. A separate prefix lets load()
 *  skip cssModules for it: react-flow ships global `.react-flow__*` rules that
 *  must keep their original names, and copying them into src/client/ would trip
 *  the native-UI guard (which only scans src/client), so they stay in
 *  node_modules and are inlined here at build time. */
const GLOBAL_CSS_PREFIX = '\0dsh-global-css:'
/** Absolute CSS path -> synthetic virtual id (repo-relative). */
function cssVirtualId(absolutePath: string): string {
  return CSS_VIRTUAL_PREFIX + relative(process.cwd(), absolutePath) + CSS_VIRTUAL_SUFFIX
}
/** Synthetic virtual id -> absolute CSS path. */
function cssRealPath(virtualId: string): string {
  return resolvePath(process.cwd(), virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length))
}
/**
 * Synthetic virtual id -> repo-relative CSS path, i.e. the id with its wrapper
 * stripped. This is NOT the same string as the absolute path, and the
 * difference is load-bearing: see the `filename` argument at the lightningcss
 * call site.
 */
function cssRepoPath(virtualId: string): string {
  return virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
}

/** Node half: plain ESM library, host-shared packages stay bare (module
 *  identity must be the host runtime's own copies — bundling them would
 *  duplicate cordis Services and the settings seam). */
const nodeConfig: UserConfig = {
  name: ID,
  // `locale-tables` is a second entry so the host-side copy resolver can be
  // exercised (and reused) without creating a cycle back through index.
  entry: { index: 'src/index.ts', 'locale-tables': 'src/locale-tables.ts', 'components/image': 'src/components/image.ts', 'components/video': 'src/components/video.ts', 'components/canvas': 'src/components/canvas.ts', 'components/gallery': 'src/components/gallery.ts', 'components/templates': 'src/components/templates.ts', 'components/skills': 'src/components/skills.ts', 'components/ppt': 'src/components/ppt.ts', 'components/ecommerce': 'src/components/ecommerce.ts', 'components/outfit': 'src/components/outfit.ts', 'components/prompt': 'src/components/prompt.ts', 'components/storage': 'src/components/storage.ts', 'components/diagnostics': 'src/components/diagnostics.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  outputOptions: {
    entryFileNames: '[name].js',
    // Pin the shared-chunk name. Rolldown otherwise suffixes a content hash
    // (locale-tables-<hash>.js) that changes on ANY edit to the dictionaries,
    // which means every rebuild silently renames a file index.js imports —
    // an install that copies only index.js then fails to load. A stable name
    // makes reinstalling the built artifacts a plain overwrite.
    chunkFileNames: '[name]-chunk.js',
  },
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm/message',
      '@deepseek-ai/schemastery',
    ],
  },
}

/** Browser half: the __ModuleLoader__ registration bundle. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Platform modules resolve from the injected require (loader module
    // table); everything else is inlined by the bundle. lucide-react must be
    // forced in: `dependencies` default to external, which a browser bundle
    // cannot resolve at runtime.
    neverBundle: [...CLIENT_EXTERNALS],
    // react-flow and its transitive runtime deps must be inlined: a browser
    // bundle cannot resolve bare requires at runtime. react/react-dom stay
    // external (CLIENT_EXTERNALS) so react-flow uses the host's single React.
    alwaysBundle: ['lucide-react', '@xyflow/react', '@xyflow/system', 'zustand', 'classcat'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    async resolveId(source: string, importer: string | undefined) {
      if (source.endsWith('.module.css')) {
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        // CSS injection is a side effect: keep it even when the importing
        // module's exports are tree-shaken (e.g. react-flow's global sheet).
        return { id: cssVirtualId(abs), moduleSideEffects: true }
      }
      if (source.endsWith('.css')) {
        // Global stylesheet (react-flow's dist/style.css). Resolve bare package
        // specifiers via Node's resolver (NOT this.resolve, which would make
        // rolldown hoist a stray external require), then wrap in the global
        // virtual id; load() inlines it without cssModules hashing.
        const abs = source.startsWith('.')
          ? (importer !== undefined ? sourceAssetPath(source, importer) : resolvePath(source))
          : nodeRequire.resolve(source)
        return { id: `${GLOBAL_CSS_PREFIX}${abs}${CSS_VIRTUAL_SUFFIX}`, moduleSideEffects: true }
      }
      return null
    },
    async load(virtualId: string) {
      if (virtualId.startsWith(GLOBAL_CSS_PREFIX)) {
        const fileId = virtualId.slice(GLOBAL_CSS_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        // Package-relative name keeps the injected tag id (and thus the bundle
        // bytes) stable across machines; no cssModules, so no hash depends on it.
        const cssName = fileId.split('node_modules/').pop() ?? relative(process.cwd(), fileId)
        const { code } = transform({ filename: cssName, code: source, minify: true })
        const tagId = `${ID}/${cssName}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          'export default {};',
        ].join('\n')
      }
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = cssRealPath(virtualId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        // The repo-relative path, NOT `fileId`. lightningcss derives `[hash]`
        // from this string and from nothing else — measured: the same bytes
        // under `/a/b/src/client/x.module.css` hash to `uoukpq_wrap` and under
        // `/c/d/src/client/x.module.css` to `ByV2Ia_wrap`, while changing the
        // CSS from `red` to `blue` does not move it at all. So the absolute
        // path made every generated class name — and therefore the bundle —
        // depend on where the repo happened to be checked out, and the same
        // commit built in two directories produced different `lib/client.js`.
        // A repo-relative path is stable across machines, which is what makes
        // the published SHA256SUMS reproducible from source at all.
        // Uniqueness is a precondition, not a hope: 18 `.module.css` files,
        // all under `src/client/`, all basenames distinct — and the path, not
        // just the basename, is the input, so even a repeated basename would
        // not collide.
        filename: cssRepoPath(virtualId),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // lightningcss hands back CSS-module exports from a native hash map, so
      // `Object.entries` returns the classes in a different order on every
      // process -- measured on this repo: five runs of the same stylesheet
      // produced five different first keys. Nothing READS that order (the map
      // is only ever indexed by name), but it is serialised into the bundle
      // and the bundle is the release artifact. An unstable order means two
      // builds of the same commit hash differently, so `SHA256SUMS` cannot be
      // reproduced from source and a re-run cannot be shown to ship the bytes
      // it replaced. Sorting pins it.
      const classMap: Record<string, string> = {}
      const exported = cssExports ?? {}
      for (const local of Object.keys(exported).sort()) classMap[local] = exported[local].name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
    renderChunk(code: string) {
      // Rolldown stamps each module's resolved id into a banner comment.
      // node_modules ids resolve through symlinks to a real path, so the
      // relative prefix depends on the checkout directory (a mirror with a
      // symlinked node_modules emits `../../../Users/…/node_modules/…` where
      // the original emits `node_modules/…`). Normalise the prefix away so the
      // published bytes are a pure function of the source tree.
      //
      // TWO spellings, because the banner format is not this repository's to
      // keep stable: rolldown 1.1 writes `//#region <id>`, and rolldown 1.3
      // (what tsdown 0.23 resolves) writes a bare `// <id>` with no region
      // marker. Matching only the first form stopped normalising anything, and
      // the leak is invisible until the same tree is built in another
      // directory — which is exactly what verify-reproducible.mjs does.
      // Checked before touching the second form: `// ` requires the space, so
      // `//#region` can never be matched by it.
      //
      // The prefix between `// ` and `node_modules/` is constrained to a
      // path-like token (relative or absolute, no whitespace or colon), so a
      // prose banner mentioning the directory — `// loads node_modules …`, or
      // a URL — is left alone. That guard is not decoration: an unconstrained
      // `[^\n]*?` rewrites `// see https://…/node_modules/x` too, which would
      // silently mangle comments that are not module ids at all.
      return code
        .replace(/\/\/#region [^\n]*?(node_modules\/[^\n]*)/g, '//#region $1')
        .replace(
          /^([ \t]*)\/\/ ((?:\.{1,2}\/|\/)?[^\s:]*?)(node_modules\/[^\r\n]*)$/gm,
          '$1// $3',
        )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: `var module = { exports: {} }; var exports = module.exports;${xyflowCssInjection}`,
  },
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${process.platform === 'win32' ? '\\' : '/'}lib${process.platform === 'win32' ? '\\' : '/'}types${process.platform === 'win32' ? '\\' : '/'}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

export default [nodeConfig, clientConfig]

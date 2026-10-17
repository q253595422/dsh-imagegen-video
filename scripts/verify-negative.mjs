/**
 * Negative verification for every fix in this round.
 *
 * For each fix, re-introduce the exact defect it removed and require the
 * matching check to go RED. A check that stays green when the defect is back
 * proves nothing about the fix.
 *
 * Runs against a COPY of the repo (node_modules symlinked) so the working tree
 * is never mutated. Cases run through one of three runners:
 *
 *   contracts -- scripts/verify-ui-contracts.mjs, which reads the sources and
 *                stylesheets directly, so it needs no build.
 *   smoke     -- scripts/smoke.mjs, which loads lib/client.js, so the copy is
 *                rebuilt after the mutation.
 *   video     -- scripts/smoke-video.mjs, which drives the built host's video
 *                engine against a local upstream; also needs the rebuild.
 */
import { cpSync, symlinkSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
// Per-process, because a FIXED name is shared state: two runs (a leftover one
// and a new one, or `contracts` and `smoke` side by side) then mutate the same
// copy of the repo, and `rmSync` even races on it (ENOTEMPTY). That produced a
// bogus "1/7 defects turn the check red" -- a fake failure caused by the
// harness stepping on itself, which is just as misleading as a fake pass.
const COPY = join(tmpdir(), `dsh-neg-verify-${process.pid}`)

function freshCopy () {
  rmSync(COPY, { recursive: true, force: true })
  mkdirSync(COPY, { recursive: true })
  for (const entry of ['src', 'scripts', 'lib', 'package.json', 'tsdown.config.ts']) {
    cpSync(join(SRC, entry), join(COPY, entry), { recursive: true })
  }
  // The `pack` runner inspects a real archive, so the copy needs the directories
  // that the archive rule is about. Reproducing the 57 MiB of real assets would
  // make every pack case pay for the copy; a one-byte stand-in is enough to make
  // "this directory was published" a fact rather than an absence. Without these
  // the check would pass because there was nothing to publish -- a false green.
  for (const [dir, file] of [['docs/images', 'demo.png'], ['docs/videos', 'demo.mp4']]) {
    mkdirSync(join(COPY, dir), { recursive: true })
    writeFileSync(join(COPY, dir, file), 'x')
  }
  symlinkSync(join(SRC, 'node_modules'), join(COPY, 'node_modules'))
}

/** @returns {{ ok: boolean, out: string }} ok = the check passed. */
function run (script) {
  try {
    const out = execFileSync('node', [script], {
      cwd: COPY, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function build () {
  // `pnpm build`, not `node node_modules/.bin/tsdown`: pnpm's bin shims are
  // shell scripts, so handing one to `node` is a syntax error, not a build.
  execFileSync('pnpm', ['build'], { cwd: COPY, encoding: 'utf8', stdio: 'ignore' })
}

function patch (relative, from, to) {
  const path = join(COPY, relative)
  let before = readFileSync(path, 'utf8')
  // `from`/`to` may be parallel arrays: some defects are not one edit. Swapping
  // two rungs, for instance, has to move their declarations AND their doc-table
  // rows, or the table check fires first and the case never reaches the guard
  // it means to test.
  const froms = Array.isArray(from) ? from : [from]
  const tos = Array.isArray(to) ? to : [to]
  if (froms.length !== tos.length) throw new Error(`from/to length mismatch in ${relative}`)
  for (let index = 0; index < froms.length; index += 1) {
    if (!before.includes(froms[index])) throw new Error(`anchor not found in ${relative}: ${froms[index].slice(0, 70)}`)
    before = before.replace(froms[index], tos[index])
  }
  writeFileSync(path, before)
}

const CASES = [
  // ------------------------------------------------------ three UI contracts
  {
    name: 'the subscription is wired but never observes',
    runner: 'contracts',
    file: 'src/client/surface-theme.ts',
    from: "  const observer = typeof MutationObserver === 'function'\n    ? new MutationObserver(report)\n    : null",
    to: '  const observer = null',
    expect: /subscription did not fire|data-theme is still/,
  },
  {
    name: 'GooeyNav drops the theme subscription entirely',
    runner: 'contracts',
    file: 'src/client/GooeyNav.tsx',
    from: 'subscribeSurfaceTheme(container, applyTheme)',
    to: 'detectLightSurface(container)',
    expect: /no longer calls subscribeSurfaceTheme|subscription did not fire/,
  },
  {
    name: 'the annotation token is not declared on the canvas root',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '--canvas-annotation: var(--dsw-static-red-500, #ef4444);',
    to: '--canvas-annotation-unused: var(--dsw-static-red-500, #ef4444);',
    expect: /annotation token does not resolve/,
  },
  {
    name: 'the stylesheet hardcodes the marker color again',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '--canvas-annotation: var(--dsw-static-red-500, #ef4444);',
    to: '--canvas-annotation: #ff2d55;',
    expect: /still hardcodes the marker color/,
  },
  {
    name: 'a z-index literal comes back',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '  z-index: var(--z-topbar);',
    to: '  z-index: 40;',
    expect: /z-index literals are back/,
  },
  {
    // The regression this whole guard exists for: a "tidy" renumbering by role
    // that silently re-stacks the UI. Here the select menu is pulled down to
    // where the old rewrite put it.
    name: 'the select menu drops below the modal that contains it',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: ['  --z-select-menu: 1010;', ' * 1010  select-menu       any <Select> dropdown: must clear every modal that'],
    to: ['  --z-select-menu: 66;', ' *   66  select-menu       any <Select> dropdown: must clear every modal that'],
    expect: /stacking order is wrong|must be above/,
  },
  {
    name: 'the compose strip sinks under the dock',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: ['  --z-dock-raised: 31;', ' *   31  dock-raised       the multi-select strip above the canvas dock'],
    to: ['  --z-dock-raised: 29;', ' *   29  dock-raised       the multi-select strip above the canvas dock'],
    expect: /stacking order is wrong|must be above/,
  },
  {
    // Pins only matter when the relative order still holds -- otherwise the
    // ordering check catches it and this one is never reached. So the mutation
    // moves a pinned rung AND its neighbour, keeping every relative assertion
    // true: only the absolute pin can see the host-facing change.
    name: 'a host-facing layer changes its number with the order intact',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: [
      '  --z-media-viewer: 400;\n  --z-lightbox: 1000;\n  --z-modal-picker: 1005;\n  --z-select-menu: 1010;',
      ' * 1000  lightbox          full-screen image preview\n * 1005  modal-picker      the provider picker modal\n * 1010  select-menu       any <Select> dropdown: must clear every modal that',
    ],
    to: [
      '  --z-media-viewer: 400;\n  --z-lightbox: 2000;\n  --z-modal-picker: 2005;\n  --z-select-menu: 2010;',
      ' * 2000  lightbox          full-screen image preview\n * 2005  modal-picker      the provider picker modal\n * 2010  select-menu       any <Select> dropdown: must clear every modal that',
    ],
    expect: /interleaves with the host changed its number/,
  },
  {
    name: 'the doc table stops matching the declarations',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: ' *  120  modal             the settings editor backdrop',
    to: ' *  121  modal             the settings editor backdrop',
    expect: /documentation does not match the declarations/,
  },
  {
    // The only case that measures paint order instead of reading source, and
    // deliberately built to be invisible to every source-level check: the notice
    // is pointed at the backdrop's rung, so the scale itself keeps its distinct
    // numbers, its doc table and its relative order -- only the two USED values
    // become equal at runtime. Source invariants all pass; the browser is the
    // only thing that can see the tie come back.
    name: 'the notice borrows the backdrop rung and the two are tied',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '  z-index: var(--z-notice);',
    to: '  z-index: var(--z-picker-backdrop);',
    expect: /tied at z-index/,
  },
  {
    name: 'two scale rungs collide on one number',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '  --z-composer: 35;',
    to: '  --z-composer: 30;',
    expect: /two scale entries share a number/,
  },
  {
    name: 'a layer references an undeclared scale entry',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '  --z-composer: 35;',
    to: '  --z-composer-renamed: 35;',
    expect: /never declared/,
  },
  {
    // The token is declared on the canvas root, not on documentElement, so a
    // reader without the origin element gets an empty string and silently falls
    // back to the literal -- which is exactly the drift the token exists to
    // remove. Both halves are separate defects: the reader must accept an
    // origin, and the caller must pass one.
    name: 'image-ops reads the token without an origin element',
    runner: 'contracts',
    file: 'src/client/image-ops.ts',
    from: "themeColor('--canvas-annotation', '#ff2d55', tokenOrigin)",
    to: "'#ff2d55'",
    expect: /without an origin element|no longer reads --canvas-annotation/,
  },
  {
    name: 'the drawAnnotation caller forgets the canvas root',
    runner: 'contracts',
    file: 'src/client/CanvasWorkspace.tsx',
    from: 'drawAnnotation(raster, boxes.map((box, index) => ({ rect: box.rect, index })), rootRef.current)',
    to: 'drawAnnotation(raster, boxes.map((box, index) => ({ rect: box.rect, index })))',
    expect: /does not pass the canvas root/,
  },
  {
    name: 'the hidden node toolbar is focusable again',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '  visibility: hidden;\n  transition: opacity 0.12s ease, visibility 0s linear 0.12s;',
    to: '  transition: opacity 0.12s ease;',
    expect: /no longer leaves the tab order/,
  },
  {
    // The shared helper is what makes the tablists roving; if it stops
    // returning -1 for the unselected tab, every tab is back in the Tab order
    // while all the call sites still look correct.
    name: 'the roving tabIndex stops roving',
    runner: 'contracts',
    file: 'src/client/tablist.ts',
    from: '  return active ? 0 : -1',
    to: '  return 0',
    expect: /tabIndexFor no longer returns -1/,
  },
  {
    name: 'a tablist loses its arrow keys',
    runner: 'contracts',
    file: 'src/client/VideoPanel.tsx',
    from: '              onKeyDown={event => { onTablistKeyDown(event, { count: availableModes.length, index, select: next => { setMode(availableModes[next]!) } }) }}\n',
    to: '',
    expect: /never calls onTablistKeyDown/,
  },
  {
    name: 'nothing reveals the node toolbar on focus',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '.node:focus-within .hoverToolbar {',
    to: '.node-unused:focus-within .hoverToolbar {',
    expect: /nothing reveals the node toolbar/,
  },
  {
    // The browser check is the only one that can see this: the source keeps
    // both rules, but the node stops being focusable, so the toolbar is never
    // revealed and the deadlock is back.
    name: 'the node stops being a tab stop in a real browser',
    runner: 'contracts',
    file: 'src/client/CanvasWorkspace.tsx',
    from: '      tabIndex={0}\n      role="group"\n      aria-label={node.title}',
    to: '      role="group"\n      aria-label={node.title}',
    expect: /canvas node root is not focusable|does not reveal its toolbar/,
  },

  // -------------------------------------------- this round's interaction fixes
  {
    // The overlay guarantee is STRUCTURAL: every overlay is a sibling of the
    // viewport, so a pointerdown on it never reaches the viewport handler and
    // cannot clear the selection that opened it. The mutation gives the
    // composer a viewport-matching class, i.e. makes the structural assertion
    // itself false -- which is what proves the check is not vacuous.
    //
    // (Nesting the composer inside the viewport for real would be the more
    // faithful mutation, but it destabilises the jsdom harness: the run is
    // killed with SIGKILL before the assertion is reached, so it proves nothing
    // about the check.)
    name: 'the overlay stops being outside the viewport',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "    return <div className={css.composer} data-canvas-no-zoom=\"\" style={{ left: clampedX - 280, top }}>",
    to: "    return <div className={`${css.composer} ${css.viewport}`} data-canvas-no-zoom=\"\" style={{ left: clampedX - 280, top }}>",
    expect: /composer sits outside the viewport/,
  },
  {
    name: 'touch pinch is gone again',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "    if (event.pointerType === 'touch') {\n      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })",
    to: '    if (false) {\n      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })',
    expect: /two touch pointers moving apart zoom in/,
  },
  {
    name: 'Space eats a focused button again',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "      if (event.code === 'Space' && !isEditingTarget(event.target) && !isActivatableTarget(event.target)) {",
    to: "      if (event.code === 'Space' && !isEditingTarget(event.target)) {",
    expect: /Space on a focused button/,
  },
  {
    name: 'Esc no longer closes the in-canvas video preview',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: '        if (videoPreviewNodeId !== null) { setVideoPreviewNodeId(null); return }\n',
    to: '',
    expect: /Escape closes the in-canvas video preview/,
  },
  {
    name: 'the image picker keeps its stale file value',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "        event.target.value = ''\n        if (files.length > 0) uploadFiles(files)",
    to: '        if (files.length > 0) uploadFiles(files)',
    expect: /clears its file input/,
  },
  {
    // The z-index literal upstream shipped with the diagnostics panel. The
    // scale check is what turns it red, which is the point of the scale.
    name: 'the diagnostics panel brings back a literal layer number',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '.diagnosticsPanel {\n  position: absolute;\n  z-index: var(--z-diagnostics);',
    to: '.diagnosticsPanel {\n  position: absolute;\n  z-index: 92;',
    expect: /z-index literals are back/,
  },
  {
    // Measured in a real browser, because whether a shell panel yields the
    // column is decided by the cascade over a `display: contents` anchor --
    // source-level reasoning cannot see it.
    name: 'a shell panel no longer yields the keyed main slot',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: "html[data-dsh-imagegen-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-slot='main'] > :not([data-dsh-imagegen-view]):not([data-phase]):not([data-slot='main.conversation']) {\n  display: none !important;\n}",
    to: '',
    expect: /shell panel inside the keyed `main` slot is still rendered/,
  },

  // -------------------------------------------------- video diagnostics parity
  {
    // The parity claim is "the video chain records into the SAME buffer". Drop
    // the recording and the video check has nothing to look at.
    name: 'a failed video submit is no longer recorded',
    runner: 'video',
    file: 'src/video-engine.ts',
    from: '    recordVideoFailure(attempt, failure, { requestExcerpt: excerpt })\n',
    to: '',
    expect: /refused video submit leaves a diagnostic entry/,
  },
  {
    // Phase is the whole reason the video pipeline needs its own vocabulary:
    // without it a poll failure is indistinguishable from a submit failure.
    name: 'the video pipeline loses its own phases',
    runner: 'video',
    file: 'src/video-engine.ts',
    from: "  const statusAttempt: VideoAttempt = {\n    ...attempt,\n    phase: 'video-poll',",
    to: "  const statusAttempt: VideoAttempt = {\n    ...attempt,\n    phase: 'video-submit',",
    expect: /phase says the render started/,
  },
  {
    // A raw fetch rejection is transient inside the poll loop, so the loop
    // judges it; if it stops recording once the retries run out, the "it just
    // sat there" report has nothing behind it. The throw stays, so only the
    // record disappears -- the case turns red on the diagnostic assertion, not
    // on a hang.
    name: 'an exhausted poll retry budget is no longer recorded',
    runner: 'video',
    file: 'src/video-engine.ts',
    from: '        recordPollExhausted(statusAttempt, error, taskId, family, transientRetries)\n        throw error',
    to: '        throw error',
    expect: /exhausted poll retry budget leaves a diagnostic entry/,
  },
  {
    // The poll loop never sees the response, only the error, so the wire code
    // has to travel on the error. Without it the record says "the status
    // endpoint failed" without saying WHAT it answered, which is the first
    // thing anyone asks.
    name: 'a spent poll budget forgets which status it kept getting',
    runner: 'video',
    file: 'src/video-engine.ts',
    from: "      retryable ? 'video-status-transient' : 'video-status-failed',\n      retryable,\n      response.status,\n    )",
    to: "      retryable ? 'video-status-transient' : 'video-status-failed',\n      retryable,\n    )",
    expect: /status the endpoint kept answering with/,
  },
  {
    // The parity claim fails in the direction that actually shipped upstream:
    // the entry lives only where a TASK already exists. Drop the always-rendered
    // toolbar row and the video studio no longer reaches the record at all --
    // which is exactly the state a user with zero tasks is in.
    name: 'the video studio stops offering the diagnostics record',
    runner: 'smoke',
    file: 'src/client/VideoPanel.tsx',
    from: '      <div className={css.videoDiagnosticsRow}>\n        <DiagnosticsButton open={diagnosticsOpen} onToggle={() => { setDiagnosticsOpen(open => !open) }} />\n      </div>',
    to: '',
    expect: /renders exactly one diagnostics entry|opens the diagnostics record/,
  },
  {
    // The source row grew past one line. Put back the plain flex box and every
    // tab past the right edge becomes unreachable -- the defect is invisible in
    // a screenshot of the first few tabs, which is why it needs a guard.
    name: 'the template source row stops scrolling and clips its later tabs',
    runner: 'contracts',
    file: 'src/client/templates.module.css',
    from: '  overflow-x: auto;\n  overflow-y: hidden;\n  scrollbar-width: none;\n}',
    to: '  overflow: hidden;\n  scrollbar-width: none;\n}',
    expect: /source row can no longer scroll/,
  },
  {
    // The other half of the same fix: shrinking tabs does not bring the row
    // back into view, it just truncates the labels that are visible.
    name: 'template source tabs are allowed to shrink again',
    runner: 'contracts',
    file: 'src/client/templates.module.css',
    from: '.sourceTab {\n  display: inline-flex;\n  align-items: center;\n  flex: none;',
    to: '.sourceTab {\n  display: inline-flex;\n  align-items: center;',
    expect: /allowed to shrink/,
  },
  {
    // The half of the row defect that the DECLARATION checks above cannot see:
    // `overflow-x: auto` is still there, `flex: none` is still there, and the
    // row still scrolls -- it just got a height smaller than its own tabs, so
    // `overflow-y: hidden` slices the labels in half. Only a rendered box
    // reports that, and a sliced tab is no more usable than a missing one.
    name: 'the template source row is shorter than the tabs it holds',
    runner: 'contracts',
    file: 'src/client/templates.module.css',
    from: '  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 0 18px 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n  flex: none;',
    to: '  display: flex;\n  align-items: center;\n  gap: 6px;\n  height: 22px;\n  padding: 0 18px 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n  flex: none;',
    expect: /clipping its tabs vertically/,
  },
  {
    // A registered source with no tab of its own: the library is shipped and
    // loadable, and no control anywhere opens it. The row has to be generated
    // from the registry for that not to happen.
    name: 'the source row stops being generated from the registry',
    runner: 'contracts',
    file: 'src/client/TemplateLibrary.tsx',
    from: '{TEMPLATE_SOURCES.map((source, index) => (',
    to: '{TEMPLATE_SOURCES.filter(source => source.id !== \'youart\').map((source, index) => (',
    expect: /no longer renders one tab per registered source/,
  },
  {
    // A source registered on the client with no host-side fetch definition is a
    // tab that opens onto an empty library. Remove one definition and the seam
    // between the two registries is unguarded again.
    name: 'a registered template source loses its host-side fetch definition',
    runner: 'contracts',
    file: 'src/templates-store.ts',
    from: "  itgoyo: {\n    bundledPath: fileURLToPath(new URL('../src/templates/itgoyo-cases.json', import.meta.url)),",
    to: "  itgoyoDisabled: {\n    bundledPath: fileURLToPath(new URL('../src/templates/itgoyo-cases.json', import.meta.url)),",
    expect: /no host-side fetch definition/,
  },
  {
    // The bug this whole round started from: keying an evolink case by its bare
    // number. Its numbers repeat across category files (character.md and
    // portrait.md both open at Case 1), so two different cases collapse onto one
    // id -- and since templates-store keys favourites by `source:id` and the
    // gallery keys cards by id, the library silently loses cases while every
    // other check stays green. Reproduced here as the collision it produced.
    name: 'evolink loses cases to colliding ids again',
    runner: 'smoke',
    file: 'src/templates/evolink-cases.json',
    from: '"id": "portrait-2",',
    to: '"id": "ecommerce-2",',
    expect: /every bundled snapshot keeps its ids unique/,
  },
  {
    // "Detect models" silently listed two models fewer than the catalog: the
    // predicate demanded a separator after the family keyword, so `nanobanana2`
    // (a shipped default) failed its own family test and was dropped. Both ids
    // are served by the mock gateway now, so putting the strict boundary back
    // has to turn C5 red -- the deepEqual there compares the whole list.
    name: 'model detection drops ids whose family carries a numeric suffix',
    runner: 'smoke',
    file: 'src/model-catalog.ts',
    from: 'hunyuan|jimeng|wanx|hidream|playground)\\d*(?:$|[-_.])/i',
    to: 'hunyuan|jimeng|wanx|hidream|playground)(?:$|[-_.])/i',
    expect: /C5 image model discovery/,
  },
  {
    // The gate that decides whether a snapshot's images can ever load. Narrow a
    // source's allowlist and its snapshot's images become unservable -- the
    // check has to read the real SOURCE_DEFS to notice, so it lives with the
    // other source invariants.
    name: 'a snapshot points at an image host its source does not allow',
    runner: 'contracts',
    file: 'src/templates-store.ts',
    from: "    allowedImageHosts: ['raw.githubusercontent.com', 'cdn.openai.com'],",
    to: "    allowedImageHosts: ['raw.githubusercontent.com'],",
    expect: /carries images its source will refuse to serve/,
  },
  {
    // A shipped snapshot pointing an image at a repository that grants no
    // licence. Regenerating prompt-signal without the filter puts exactly these
    // six references back, which is why the check reads the snapshot rather
    // than trusting that the filter exists in the fetch script.
    name: 'a snapshot points an image at a repository that grants no licence',
    runner: 'contracts',
    file: 'src/templates/prompt-signal-cases.json',
    from: '"githubUrl": "https://github.com/songguoxs/gpt4o-image-prompts/blob/master/README.md#prompt-1131",\n      "image": "",',
    to: '"githubUrl": "https://github.com/songguoxs/gpt4o-image-prompts/blob/master/README.md#prompt-1131",\n      "image": "https://raw.githubusercontent.com/songguoxs/gpt4o-image-prompts/master/images/1131.jpeg",',
    expect: /grants no licence/,
  },
  {
    // docs/images is ~20 MiB of README screenshots that nothing reads at
    // runtime. It belongs in the repository (GitHub renders it from there) and
    // not in the installed archive -- the same rule docs/videos already has, and
    // CI is where it is enforced. This case runs the real check out of the
    // workflow file rather than restating it, so the two cannot drift.
    name: 'the published archive carries the README screenshots again',
    runner: 'pack',
    file: 'package.json',
    from: '  "files": [\n    "lib",\n    "src/templates",\n    "cordis.patch.yml",\n    "docs/releases",',
    to: '  "files": [\n    "lib",\n    "src/templates",\n    "cordis.patch.yml",\n    "docs/images",\n    "docs/releases",',
    expect: /docs\/images\/ -- README screenshots/,
  },
]

const RUNNERS = {
  contracts: { script: 'scripts/verify-ui-contracts.mjs', build: false },
  smoke: { script: 'scripts/smoke.mjs', build: true },
  video: { script: 'scripts/smoke-video.mjs', build: true },
  // The archive rule, run against a real `pnpm pack`. No rebuild: the archive
  // contents depend on package.json and the tree, not on the built output.
  pack: { script: 'scripts/verify-pack.mjs', build: false },
}

const results = []
// The runner name is a CLI filter: the smoke cases each rebuild and run the
// full jsdom suite, so all of them in one process exceeds the command timeout.
// `node dsh-neg-verify.mjs smoke` and `... contracts` each stay inside it.
const only = process.argv[2]
for (const testCase of CASES) {
  if (only !== undefined && only !== '' && testCase.runner !== only) continue
  const runner = RUNNERS[testCase.runner]
  const script = runner.script
  freshCopy()
  const baseline = run(script)
  if (!baseline.ok) {
    results.push({ name: testCase.name, verdict: 'HARNESS BROKEN', detail: baseline.out.slice(-400) })
    continue
  }
  try {
    patch(testCase.file, testCase.from, testCase.to)
    if (runner.build) build()
  } catch (error) {
    results.push({ name: testCase.name, verdict: 'HARNESS BROKEN', detail: String(error.message) })
    continue
  }
  const mutated = run(script)
  if (mutated.ok) {
    results.push({ name: testCase.name, verdict: 'FALSE GREEN', detail: 'check still passed with the defect re-introduced' })
    continue
  }
  const matched = testCase.expect.test(mutated.out)
  results.push({
    name: testCase.name,
    verdict: matched ? 'RED as expected' : 'RED but wrong reason',
    detail: matched ? '' : mutated.out.slice(-500),
  })
}

console.log('negative verification of this round\'s fixes\n' + '='.repeat(64))
for (const result of results) {
  const mark = result.verdict === 'RED as expected' ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${result.verdict.padEnd(22)} ${result.name}`)
  if (result.detail !== '') console.log(`      ${result.detail.replace(/\n/g, '\n      ')}`)
}
const bad = results.filter(result => result.verdict !== 'RED as expected')
console.log('='.repeat(64))
console.log(`${results.length - bad.length}/${results.length} defects turn the check red`)
rmSync(COPY, { recursive: true, force: true })
process.exit(bad.length === 0 ? 0 : 1)

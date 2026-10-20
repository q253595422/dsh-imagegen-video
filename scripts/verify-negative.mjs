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
import { cpSync, existsSync, symlinkSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function freshCopy (needsGit = false) {
  rmSync(COPY, { recursive: true, force: true })
  mkdirSync(COPY, { recursive: true })
  // `.github` is here because `verify-pack.mjs` reads the publish job out of
  // `release.yml` to check the read-back window. A copy without it makes that
  // check throw ENOENT -- the harness reporting its own incompleteness as if
  // it were the injected defect, which reads as "0/N defects turn the check
  // red" and hides whether the mutation works at all.
  for (const entry of ['src', 'scripts', 'lib', 'package.json', 'tsdown.config.ts', '.gitignore', '.github']) {
    cpSync(join(SRC, entry), join(COPY, entry), { recursive: true })
  }
  // `verify-pack.mjs` reads the packed manifest and requires every entry point
  // it declares to exist in the archive. Those entries are the `files` list in
  // package.json, so a copy without them makes the packaging check fail for a
  // reason that has nothing to do with the injected defect -- the harness
  // reporting ITS OWN incompleteness as the defect. Copied from `files` rather
  // than listed here, so the two cannot drift apart.
  const { files = [] } = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
  for (const entry of files) {
    const from = join(SRC, entry)
    const to = join(COPY, entry)
    if (!existsSync(from)) continue
    cpSync(from, to, { recursive: true })
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
  // `verify-tracked.mjs` can only answer its question inside a checkout, and it
  // SKIPS (green) outside one. A runner that silently skips is exactly how the
  // incident it guards got through, so the copy becomes a real repository for
  // the runners that need one -- and only for those, since committing the tree
  // costs a second and 50+ cases would each pay it.
  if (needsGit) {
    const git = (...args) => execFileSync('git', ['-c', 'user.email=neg@verify', '-c', 'user.name=neg', ...args], {
      cwd: COPY, encoding: 'utf8', stdio: 'ignore',
    })
    git('init', '--quiet')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'baseline')
  }
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
  //
  // But a machine can have the tree installed WITHOUT having pnpm on its PATH
  // (a plain `npm install` checkout, or a pnpm-less CI image). Every smoke case
  // then died in the rebuild with `spawnSync pnpm ENOENT` and the harness
  // reported HARNESS BROKEN -- its own missing tool presented as if the case
  // were unprovable. The shim is executable on its own (it is a `sh` script),
  // so it is the fallback, not the primary: the copy is rebuilt the same way
  // either way, and only the launcher differs.
  const shim = join(COPY, 'node_modules', '.bin', 'tsdown')
  if (existsSync(shim)) {
    execFileSync(shim, [], { cwd: COPY, encoding: 'utf8', stdio: 'ignore' })
    return
  }
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

/** Build a `from '<specifier>'` fragment at runtime.
 *
 *  Some mutation payloads *are* import specifiers (the tracked-file case points
 *  an import at a file no checkout has). Written literally they would appear in
 *  this file's own source, and verify-tracked.mjs -- which scans every script --
 *  would report them as real broken imports. The case would then fail as
 *  HARNESS BROKEN before it proved anything. */
const importFrom = (specifier) => ['from', ["'", '.', specifier, "'"].join('')].join(' ')

// The version this checkout declares. Two pack cases below inject a version
// bump, and a hardcoded old version silently stops matching the tree the day
// the package is released -- the case then reports HARNESS BROKEN (or, worse,
// goes red for the wrong reason) while the guard it exists to prove is fine.
const SRC_VERSION = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).version
/** Bump the patch component: the smallest version change a release can make. */
const bumped = (version, by) => {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + by}`
}

const CASES = [
  // ------------------------------------------------ the poster recipe guard
  {
    // Accepting the recipe without validating it is the dangerous direction: a
    // stored recipe drives a canvas the host paints, and an unvalidated one can
    // point anywhere. Drop the guard and C10c4's two refusals must go green.
    name: 'a poster recipe is stored without being validated',
    runner: 'smoke',
    file: 'src/canvas-store.ts',
    from: "    if (state.poster !== undefined && !isPosterDocument(state.poster)) return false",
    to: '    // guard removed',
    expect: /recipe without layers must be refused|pointing off-host must be refused/,
  },
  {
    // The sweep only ever looked at `metadata.asset`, so a poster's background
    // and logo layers -- which live in `metadata.poster` and are re-read by the
    // editor -- counted as garbage. Any canvas deletion then deleted the base
    // image behind every poster. This restores exactly that reachability set.
    name: 'the asset sweep ignores the files a poster recipe still points at',
    runner: 'smoke',
    file: 'src/canvas-store.ts',
    from: "        const poster = metadata?.poster\n        if (isPosterDocument(poster)) {\n          referenced.add(poster.background.assetId)\n          for (const layer of poster.layers) {\n            if (layer.type === 'image') referenced.add(layer.asset.assetId)\n          }\n        }",
    to: '        void 0',
    expect: /poster background was deleted by the sweep/,
  },
  {
    // The incident: a guard imported `scripts/lib/headless-chrome.mjs`, the file
    // was never committed (an unanchored `lib/` in .gitignore matched it), and
    // every clean clone died at import time while the author's tree was green.
    // Pointing an import at a file no checkout has reproduces exactly that
    // state: the import resolves on disk in the tree that has it and nowhere
    // else, which is what "not in the repository" means.
    name: 'a guard imports a helper that never made it into the repository',
    runner: 'tracked',
    file: 'scripts/verify-frame-grab.mjs',
    // Assembled at runtime so this file's OWN source contains no import-shaped
    // text. The scanner under test reads every script here, so a literal payload
    // would be reported as a real broken import and the case would come back
    // HARNESS BROKEN -- failing before it proves anything about the guard.
    from: importFrom('/lib/headless-chrome.mjs'),
    to: importFrom('/lib/headless-chrome-not-committed.mjs'),
    expect: /which is not in the repository/,
  },
  // --------------------------------------------------- the gallery trash window
  {
    // A hard delete is the regression this round removed: the entry leaves the
    // shelf AND the bytes go, so there is nothing left to restore. This keeps
    // the `deletedAt` flag exactly as shipped and only re-adds the unlink, so
    // the failure lands on the byte assertion — the precise symptom a user hits
    // (a "restore" that hands back a dead URL).
    name: 'deleting a gallery entry destroys its bytes again',
    runner: 'canvas-video',
    file: 'src/gallery-store.ts',
    from: "    const target = entries.find(entry => entry.id === id)\n    if (target !== undefined && isLiveEntry(target)) target.deletedAt = Date.now()\n    await writeIndex(entries)\n    return entries.map(toWire)",
    to: "    const target = entries.find(entry => entry.id === id)\n    if (target !== undefined && isLiveEntry(target)) target.deletedAt = Date.now()\n    if (target !== undefined) await removeEntryFiles(target)\n    await writeIndex(entries)\n    return entries.map(toWire)",
    expect: /soft delete keeps the clip bytes/,
  },
  // --------------------------------------------- the jsdom teardown ordering
  {
    // The bug this round was about, restored verbatim: `ReferenceError: window
    // is not defined` printed four times while the suite still reported green.
    // jsdom notifies mutation observers from a MICROTASK, so the old teardown --
    // delete the globals, then `close()` -- ran every queued callback with no
    // `window` in scope. Both halves are needed to reproduce it: closing last
    // (this edit) without the collector would only print to stderr again, so
    // this case is also the proof that the virtual-console collector is wiring
    // the error into `results` instead of letting it escape as noise.
    name: 'the jsdom globals are torn down before the observers are drained',
    runner: 'canvas-video',
    file: 'scripts/smoke-canvas-video.mjs',
    from: [
      '      await new Promise(resolve => setTimeout(resolve, 25))\n      dom.window.close()\n      await new Promise(resolve => setTimeout(resolve, 25))\n',
      '      else globalThis.document = previousDocument\n    })',
    ],
    to: [
      '      await new Promise(resolve => setTimeout(resolve, 25))\n',
      '      else globalThis.document = previousDocument\n      dom.window.close()\n    })',
    ],
    expect: /escaped into the jsdom console: window is not defined/,
  },
  // ------------------------------------------------------ the update chain
  {
    // Writing the wrong profile into the CLI call is what made the Desktop
    // update fail with pnpm's own message: a profile the CLI is not allowed to
    // touch. Spawning instead of refusing must be caught by name.
    name: 'the updater spawns the locked desktop profile anyway',
    runner: 'smoke',
    file: 'src/updater.ts',
    // The refusal lives on `installMode` now: a Desktop profile without the
    // launcher's install hook resolves to `host-managed`, and that branch is
    // the only thing standing between the user and a `dsh plugin --profile
    // desktop` spawn the CLI is guaranteed to reject.
    from: "  if (installMode === 'host-managed') {\n    throw new ManualUpdateRequiredError(profile, tarballUrl)",
    to: "  if (installMode === 'host-managed' && false) {\n    throw new ManualUpdateRequiredError(profile, tarballUrl)",
    // The refusal is an `assert.rejects`, so a spawn instead of a throw surfaces
    // as "Missing expected rejection" — that message IS the defect firing, and
    // the two wire-contract strings are listed for the variants that throw a
    // different error instead of none.
    expect: /Missing expected rejection|locked profile has its own wire code|never spawned/,
  },
  // ------------------------------------------------- PPT agent error passthrough
  {
    // A failure inside the host Agent used to be swallowed and reported as
    // "no final PPTX was produced", hiding the real cause (a 401, a bad
    // adapter). Drop the turn-end read and the failure loses its reason.
    name: 'a host Agent error collapses back into a missing-file message',
    runner: 'smoke',
    file: 'src/skill-runner.ts',
    from: "    if (reason?.kind === 'error') return redactDiagnosticText(",
    to: "    if (reason?.kind === 'error' && false) return redactDiagnosticText(",
    expect: /NO_ADAPTER|agent error|RED as/i,
  },
  {
    // The updater's message is copied into public issue threads. Skipping the
    // redaction step is how a credential reaches one.
    name: 'the updater stops redacting package-manager output',
    runner: 'smoke',
    file: 'src/updater.ts',
    from: 'const tail = updateDiagnosticText(message, STDERR_LIMIT)',
    to: 'const tail = message.slice(0, STDERR_LIMIT)',
    expect: /npm-native-secret|doesNotMatch|secret/i,
  },
  // ------------------------------------------------- inspiration wall vs a clip
  {
    // Opening a clip returns to the image tab with `images` emptied — the exact
    // state the empty-canvas inspiration wall renders in — so without the video
    // guard the prompt suggestions drew over the playing clip.
    name: 'the inspiration wall returns on top of a clip that is playing',
    runner: 'smoke',
    file: 'src/client/ImageGenPanel.tsx',
    from: 'images.length === 0 && viewingVideoEntry === null ? (',
    to: 'images.length === 0 ? (',
    expect: /inspiration wall yields to a clip/,
  },
  // ------------------------------------------------------- the shortcut legend
  {
    // Every binding existed before the legend; none was discoverable. Drop the
    // `?` branch and the shortcut whose whole point is "you can always get back
    // to the list" is gone — the check must say so by name.
    name: 'the ? key stops opening the shortcut legend',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "      } else if (event.key === '?' || (event.key === 'F1')) {",
    to: "      } else if (event.key === 'F1' && shortcutHelpOpen) {",
    expect: /\? opens the legend too|\? is claimed by the legend/,
  },
  {
    // The undo tooltip is the only place a user learns the key without opening
    // the legend. Drop the bridge back to the action label and the tooltip
    // collapses to a bare verb.
    name: 'the dock stops naming the key on its own controls',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "  const keys = shortcutKeysFor(key)\n  return keys === '' ? text : `${text} (${keys})`",
    to: "  const keys = ''\n  return keys === '' ? text : `${text} (${keys})`",
    expect: /the undo control names its key/,
  },
  // ------------------------------------------------------------- storyboard
  {
    // The board's whole reason to exist is that a shot's state is read from the
    // clip NODE. Making every row fall back to "empty" is the failure mode a
    // stored-copy implementation has: the clip is finished and on the canvas,
    // and the row still says there is nothing. SB1 must go red by name.
    name: 'a storyboard row ignores the clip it produced',
    runner: 'canvas-video',
    file: 'src/client/storyboard.ts',
    from: '  if ((metadata.video?.url ?? \'\') !== \'\') return \'ready\'',
    to: '  if (false) return \'ready\'',
    expect: /each row is typed from its own clip node/,
  },
  {
    // A 41st shot means the renderer builds a list the save gate will refuse —
    // the canvas would then fail every save, losing the whole board on reload.
    // Dropping the cap makes the harness accept it and H4 must go red.
    name: 'the shot cap stops being enforced on save',
    runner: 'storyboard',
    file: 'src/canvas-store.ts',
    from: '  if (board.shots.length > 40) return false',
    to: '  if (board.shots.length > 4000) return false',
    expect: /41 shots is past the documented cap/,
  },
  {
    // Losing the ready-only filter is how a stitch ends up submitting a clip
    // that is still rendering: the compose run then fails on an unreadable
    // segment and the user loses the whole run. P4 must name it.
    name: 'the stitch hand-off stops filtering for finished clips',
    runner: 'storyboard',
    file: 'src/client/storyboard.ts',
    from: "    return node === undefined || (node.metadata?.video?.url ?? '') === '' ? [] : [node.id]",
    to: '    return [shot.nodeId ?? "missing"]',
    expect: /list order, ready clips only/,
  },
  // --------------------------------------------------------------- workflow
  {
    // Treating a self-loop as "no dependency" makes the run start a node that
    // waits for its own product forever -- a hang the user cannot see, instead
    // of the cycle refusal. The planner has to call it a cycle by name.
    name: 'a self-loop is mistaken for an independent node',
    runner: 'workflow',
    file: 'src/client/workflow-graph.ts',
    from: '    dependencies.get(edge.toNodeId)!.add(edge.fromNodeId)',
    to: '    if (edge.fromNodeId !== edge.toNodeId) dependencies.get(edge.toNodeId)!.add(edge.fromNodeId)',
    expect: /互相依赖的节点应报为环/,
  },
  {
    // The failure rule that keeps a broken node from spawning a wave of
    // downstream failures: drop it and the chain keeps submitting after a
    // failure, which is the "everything looks broken" state the loop exists to
    // avoid. The run loop must stop at the failed node.
    name: 'the run loop keeps going after a node failed',
    runner: 'workflow',
    file: 'src/client/workflow-runner.ts',
    from: "      if (outcome.value === 'failed') {",
    to: "      if (false) {",
    expect: /链路中段失败应让整体失败|失败节点之后不该再提交任何节点/,
  },
  // ------------------------------------------------- one browser launcher only
  {
    // The flake this removes is invisible in a single run: two guards picking
    // ports out of overlapping random ranges only collide when they run at the
    // same time, and the loser asserts against whichever page answered. Put the
    // guess back and the browser guard has to say so by name.
    name: 'a browser guard hand-picks its DevTools port again',
    runner: 'contracts',
    file: 'scripts/verify-video-layout.mjs',
    from: 'const launched = await launchChrome({ chrome: CHROME, name: \'dsh-imagegen-layout\' })',
    to: 'const launched = await launchChrome({ chrome: CHROME, name: \'dsh-imagegen-layout\', args: [\'--remote-debugging-port=9500\'] })',
    expect: /hand-picks its DevTools port/,
  },
  // The legend has two separate ways to become unreadable, and the browser
  // check measures both, so both are injected here: a removed single-column
  // breakpoint, and a removed height cap (the body then grows past the viewport
  // instead of scrolling inside it).
  {
    name: 'the shortcut legend stops collapsing to one column on a phone',
    runner: 'contracts',
    file: 'src/client/shortcut-help.module.css',
    from: '@media (max-width: 560px) {\n  .body { grid-template-columns: minmax(0, 1fr); }\n}',
    to: '@media (max-width: 560px) {\n  .body { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}',
    expect: /keeps two columns/,
  },
  {
    name: 'the shortcut legend grows past the viewport instead of scrolling',
    runner: 'contracts',
    file: 'src/client/shortcut-help.module.css',
    from: '  max-height: calc(100dvh - 40px);\n',
    to: '',
    expect: /taller than the viewport/,
  },
  // The trash is where soft delete either pays off or does not. Three ways it
  // can silently stop working, each invisible to every other check: the restore
  // button loses the entry id it was rendering, the panel prints the count a
  // second time inside the section (so the heading reads as duplicated copy),
  // and the purge confirmation loses the number the user is agreeing to.
  {
    name: 'the trash restore button stops carrying its entry id',
    runner: 'smoke',
    file: 'src/client/ImageGenPanel.tsx',
    from: 'data-gallery-restore={entry.id}',
    to: 'data-gallery-restore="gallery-trashed"',
    expect: /carries its own id, not a repeated one/,
  },
  {
    name: 'the open trash repeats the count heading it sits under',
    runner: 'smoke',
    file: 'src/client/ImageGenPanel.tsx',
    from: "                <section className={css.gallerySelectionBar} data-gallery-trash=\"\" aria-label={tt('gallery.trash')}>\n                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto', minWidth: 0, maxHeight: 180, overflowY: 'auto' }}>",
    to: "                <section className={css.gallerySelectionBar} data-gallery-trash=\"\" aria-label={tt('gallery.trash')}>\n                  <strong>{tt('gallery.trashCount', { count: galleryTrash.length })}</strong>\n                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto', minWidth: 0, maxHeight: 180, overflowY: 'auto' }}>",
    expect: /does not repeat the count heading/,
  },
  {
    name: 'the trash purge confirmation forgets how many entries will go',
    runner: 'smoke',
    file: 'src/client/ImageGenPanel.tsx',
    from: "if (!window.confirm(tt('gallery.purgeConfirm', { count: galleryTrash.length }))) return",
    to: "if (!window.confirm(tt('gallery.purge'))) return",
    expect: /states how many entries will go/,
  },
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
  {
    // `files` decides what gets packed; `exports` decides what the host and the
    // browser will load. Nothing used to compare the two, so a `files` edit that
    // drops a half of the plugin -- or an `exports` edit pointing at a renamed
    // file -- produced an archive that installed cleanly, booted cleanly, and
    // then did absolutely nothing, with no error anywhere.
    //
    // Dropping "lib" from `files` is the shape that hurts most: the host half is
    // `main: lib/index.js` and the browser half is `exports["./client"]`, so the
    // archive ships a manifest promising two files and contains neither.
    name: 'the archive declares a client half it does not contain',
    runner: 'pack',
    file: 'package.json',
    from: '  "files": [\n    "lib",\n    "src/templates",\n    "cordis.patch.yml",\n    "docs/releases",',
    to: '  "files": [\n    "src/templates",\n    "cordis.patch.yml",\n    "docs/releases",',
    expect: /exports\["\.\/client"\] -> lib\/client\.js \(not in the archive\)/,
  },
  {
    // v1.8.0 shipped without `docs/releases/v1.8.0.md`, and the fallback in
    // release.yml published the version with GitHub's one-line compare link as
    // its entire body. A version bump that has no notes is exactly the state
    // that produced it: the tag freezes that page the moment it is created.
    name: 'a version bump ships without a release note',
    runner: 'pack',
    file: 'package.json',
    // Derived, so the case keeps naming a version this tree never had a note
    // for: `1.8.0 -> 1.8.1` was the original shape, and a literal like that goes
    // stale the moment the package is released.
    from: `  "version": "${SRC_VERSION}",`,
    to: `  "version": "${bumped(SRC_VERSION, 1)}",`,
    expect: new RegExp(`version ${bumped(SRC_VERSION, 1).replace(/\./g, '\\.')} has no release notes`),
  },
  {
    // The other half: the notes exist on disk but the archive leaves them out.
    // `files` lists docs/releases, so this is the manifest drifting from the
    // convention that every release carries its own notes.
    name: 'the archive stops carrying the release notes it declares',
    runner: 'pack',
    file: 'package.json',
    from: '  "files": [\n    "lib",\n    "src/templates",\n    "cordis.patch.yml",\n    "docs/releases",',
    to: '  "files": [\n    "lib",\n    "src/templates",\n    "cordis.patch.yml",',
    expect: new RegExp(`does not contain docs\\/releases\\/v${SRC_VERSION.replace(/\./g, '\\.')}\\.md`),
  },
  {
    // The publish job proves a publish worked by reading the version back. On
    // 2026-10-18 that read lagged the write by 3m16s, so the shipped 60-second
    // window failed a run whose publish had actually succeeded -- the worst
    // shape of a false failure, because it points at credentials. Restoring
    // the short window restores the defect.
    name: 'the publish job gives the registry read less time than it takes',
    runner: 'pack',
    file: '.github/workflows/release.yml',
    from: 'for attempt in $(seq 1 30); do',
    to: 'for attempt in $(seq 1 6); do',
    expect: /the publish visibility window is 60s \(6 x 10s\)/,
  },
  {
    // `lightningcss` returns CSS-module exports from a native hash map, so the
    // class names come out in a different order on every process. Serialising
    // that map in iteration order made every build of the same commit produce
    // different bytes -- invisible to every consumer, and fatal to the only
    // thing `SHA256SUMS` is for. Iterating unsorted is exactly the shipped
    // shape of the defect, restored verbatim.
    name: 'the build serialises a hash map in iteration order',
    runner: 'reproducible',
    file: 'tsdown.config.ts',
    from: 'for (const local of Object.keys(exported).sort()) classMap[local] = exported[local].name',
    to: 'for (const [local, exp] of Object.entries(exported)) classMap[local] = exp.name',
    expect: /two builds of the same source tree produced different bytes/,
  },
  // --------------------------------------------------------------- identity
  {
    // 钉住的意义全在于「以后再生成时能找回来」。如果收集时把没成图的节点也算
    // 进去，参考图就是空字节——上传时静默失败，用户以为镇住了。
    name: 'a pinned node without a picture is treated as a reference',
    runner: 'cast',
    file: 'src/client/cast.ts',
    from: "    if ((node.metadata?.asset?.url ?? '') === '') continue",
    to: '    // guard removed',
    expect: /没成图的节点不算/,
  },
  {
    // 同一张图既连线又被钉住时送两次，参考图名额被吃掉一张，而且有些提供方
    // 会把它当成两个主体。
    name: 'a pinned node already in the graph is sent twice',
    runner: 'cast',
    file: 'src/client/cast.ts',
    from: '    if (seen.has(member.nodeId)) continue',
    to: '    // duplicate guard removed',
    expect: /连线里已经有的节点不再重复送/,
  },
  {
    // 钉住只改了界面不上保存：刷新一下就没了，所有后续生成也带不上参考。
    // 这是整个功能最容易�半截的那种错。
    name: 'pinning an identity never reaches the saved document',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: '        patchNode(castNode.id, { cast: member })',
    to: '        void castNode',
    expect: /the pin reaches the saved document|the node shows it is pinned/,
  },

  // --------------------------------------------------------------- timeline
  {
    // 时间线面板盖在画布上、带自己的输入框；没有 Esc 分支时它只能靠点「关闭」
    // 退出，而 Esc 会继续往下走清掉选区——面板后面的东西被改掉了，面板还在。
    name: 'Escape no longer closes the timeline editor',
    runner: 'smoke',
    file: 'src/client/CanvasWorkspace.tsx',
    from: '        if (timelineOpen) { setTimelineOpen(false); return }\n',
    to: '',
    expect: /Escape closes the timeline editor|the timeline entry opens the editor/,
  },
  {
    // 转场超过素材一半时 xfade 会拿到比输入还长的偏移，整条命令直接失败。
    // 夹取是计算期的事，编辑器显示的总时长也靠它；去掉之后两侧都会撒谎。
    name: 'a transition is allowed to outlast half of the clip beside it',
    runner: 'timeline',
    file: 'src/client/timeline.ts',
    from: '  return Math.max(0, Math.min(wanted, leftSeconds / 2 - 0.05, rightSeconds / 2 - 0.05))',
    to: '  return wanted',
    expect: /转场不能超过任一侧素材的一半|素材太短导致一半减余量为负时不返回负重叠/,
  },
  {
    // 删段/重排之后转场列表会短一截。不补硬切，接缝就那么空着：编辑器里
    // 改不了，合成器按 cut 处理——用户以为设了转场，文件里没有。
    name: 'the transition list is left short after a segment is removed',
    runner: 'timeline',
    file: 'src/client/timeline.ts',
    from: '    out.push(transitions[index] ?? DEFAULT_TRANSITION)',
    to: '    if (transitions[index] !== undefined) out.push(transitions[index])',
    expect: /转场列表不够时补硬切|转场列表按段数裁剪/,
  },
  {
    // 出点存的是用户的意图，素材长度是事实。相信意图会让 ffmpeg 去读不存在
    // 的帧，而编辑器同时报一个根本不会出现的长度。
    name: 'an out-point past the end of the clip is trusted',
    runner: 'timeline',
    file: 'src/client/timeline.ts',
    from: '    : Math.max(start, Math.min(segment.outPoint, clipSeconds))',
    to: '    : segment.outPoint',
    expect: /出点超过素材长度时按素材长度算/,
  },
]

const RUNNERS = {
  contracts: { script: 'scripts/verify-ui-contracts.mjs', build: false },
  smoke: { script: 'scripts/smoke.mjs', build: true },
  video: { script: 'scripts/smoke-video.mjs', build: true },
  // The gallery/store half of the video chain: smoke-canvas-video drives the
  // real store in a temp home, which smoke-video does not touch at all.
  'canvas-video': { script: 'scripts/smoke-canvas-video.mjs', build: true },
  // The board's persisted state and its pure rules, driven against the real
  // modules in a temp home. No build needed: the source is imported directly.
  storyboard: { script: 'scripts/smoke-storyboard.mjs', build: false },
  // The workflow planner and run loop are imported straight from source, so
  // this group needs no build: it is pure functions plus a promise loop.
  workflow: { script: 'scripts/smoke-workflow.mjs', build: false },
  // 时间线规则是纯函数，直接从源码 import，不需要构建。
  timeline: { script: 'scripts/smoke-timeline.mjs', build: false },
  // 身份锚定的规则也是纯函数，直接从源码 import。
  cast: { script: 'scripts/smoke-cast.mjs', build: false },
  // The archive rule, run against a real `pnpm pack`. No rebuild: the archive
  // contents depend on package.json and the tree, not on the built output.
  pack: { script: 'scripts/verify-pack.mjs', build: false },
  // Needs a real checkout: the guard asks git which files are tracked, and a
  // bare copy would make it skip -- a skip that reads as a pass.
  tracked: { script: 'scripts/verify-tracked.mjs', build: false, git: true },
  // Builds twice on its own (that is what it measures), so the harness must not
  // build first: one extra build would be spent and, worse, the copy would be
  // rebuilt AFTER the mutation, which hides the fact that the baseline and the
  // mutated tree both need two builds of their own.
  reproducible: { script: 'scripts/verify-reproducible.mjs', build: false },
}

// ---------------------------------------------------------------- chain guard
//
// A runner that no command invokes is a case nobody ever runs. Adding the
// `canvas-video` group above and forgetting `test:negative` is exactly how the
// gallery soft-delete case silently stopped being part of the gate: the case
// was green when invoked by hand and never invoked by `pnpm test:negative`.
// Checked here rather than in a case, because a case can only fail after the
// runner it belongs to has been selected -- and a runner nobody selects never
// runs its own guard.
{
  const chain = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).scripts['test:negative'] ?? ''
  const invoked = new Set([...chain.matchAll(/verify-negative\.mjs\s+([\w-]+)/g)].map(match => match[1]))
  const missing = Object.keys(RUNNERS).filter(name => !invoked.has(name))
  const unknown = CASES.filter(testCase => RUNNERS[testCase.runner] === undefined)
  if (missing.length > 0 || unknown.length > 0) {
    console.log('negative verification is not wired up\n' + '='.repeat(64))
    for (const name of missing) console.log(`FAIL  runner "${name}" has cases but \`test:negative\` never runs it`)
    for (const testCase of unknown) console.log(`FAIL  case "${testCase.name}" names an undefined runner "${testCase.runner}"`)
    console.log('='.repeat(64))
    process.exit(1)
  }
}

const results = []
// The runner name is a CLI filter: the smoke cases each rebuild and run the
// full jsdom suite, so all of them in one process exceeds the command timeout.
// `node dsh-neg-verify.mjs smoke` and `... contracts` each stay inside it.
const only = process.argv[2]
// A second, free-form filter on the case name. Every smoke case pays a rebuild
// plus the whole suite (about a minute), so adding one case to that group has to
// be verifiable without re-running its neighbours.
const nameFilter = process.argv[3]
for (const testCase of CASES) {
  if (only !== undefined && only !== '' && testCase.runner !== only) continue
  if (nameFilter !== undefined && nameFilter !== '' && !testCase.name.includes(nameFilter)) continue
  const runner = RUNNERS[testCase.runner]
  const script = runner.script
  freshCopy(runner.git === true)
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

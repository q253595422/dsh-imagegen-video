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
import { canvasSourceFiles } from './lib/canvas-source.mjs'

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
  // pnpm-lock.yaml + tsconfig.json: verify-reproducible's mirrorSourceTree
  // copies its BUILD_INPUTS whitelist from the copy; a missing entry dies with
  // ENOENT before the check runs, which reads as HARNESS BROKEN rather than
  // the injected defect.
  for (const entry of ['src', 'scripts', 'lib', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsdown.config.ts', '.gitignore', '.github']) {
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

/**
 * 画布源码组的「虚拟路径」。
 *
 * 用它的用例想说的是「这段代码还在画布源码里」，不是「这段代码还恰好在
 * CanvasWorkspace.tsx 的第 N 行」。写死具体文件的用例在每次搬模块时都会
 * 悄悄失效——`patch()` 只会在真正跑到那一条时报 anchor not found，而没跑到
 * 的时候就一声不响，安全网静悄悄少了一层。定位交给 `canvasSourceFiles()`，
 * 与断言侧的聚合读取用同一份清单。
 */
const CANVAS_GROUP = 'src/client/canvas'

/** 把锚点定位到真正含有它的那个文件；划定了组就只在组内找。 */
function locate (relative, anchor) {
  const candidates = relative === CANVAS_GROUP
    ? canvasSourceFiles().map(file => join('src/client', file))
    : [relative]
  for (const candidate of candidates) {
    const path = join(COPY, candidate)
    if (!existsSync(path)) continue
    if (readFileSync(path, 'utf8').includes(anchor)) return path
  }
  // 组内找不到就退回第一个候选，让 patch 打出带文件名的 anchor not found：
  // 报「锚点不在了」比报「某个虚拟路径不存在」更接近事实。
  return join(COPY, candidates[0])
}

function patch (relative, from, to) {
  // `from`/`to` may be parallel arrays: some defects are not one edit. Swapping
  // two rungs, for instance, has to move their declarations AND their doc-table
  // rows, or the table check fires first and the case never reaches the guard
  // it means to test.
  const froms = Array.isArray(from) ? from : [from]
  const tos = Array.isArray(to) ? to : [to]
  if (froms.length !== tos.length) throw new Error(`from/to length mismatch in ${relative}`)
  for (let index = 0; index < froms.length; index += 1) {
    // 每一条锚点各自定位：同一用例的 from 与 to 是对应的，但不同条目可能
    // 落在组内不同文件里（比如一条改组件、一条改搬出去的辅助函数）。
    const path = locate(relative, froms[index])
    let before = readFileSync(path, 'utf8')
    if (!before.includes(froms[index])) throw new Error(`anchor not found in ${relative}: ${froms[index].slice(0, 70)}`)
    before = before.replace(froms[index], tos[index])
    writeFileSync(path, before)
  }
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
  // ---------------------------------------- history prompt and host drag overlay
  {
    // The prompt one: the result prompt above the image must preserve newlines
    // with pre-wrap, while the sidebar remains clamped to 2 lines.
    name: 'the result image prompt loses its pre-wrap formatting',
    runner: 'smoke',
    file: 'src/client/panel.module.css',
    from: '  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  user-select: text;\n}\n\n/* --- result grid',
    to: '  white-space: nowrap;\n  overflow-wrap: anywhere;\n  user-select: text;\n}\n\n/* --- result grid',
    expect: /result image prompt line preserves user newlines/,
  },
  {
    // LibTV 式空态快捷卡：把空态条件改成永假，画布无节点时不再渲染五卡，
    // smoke 的空态驱动检查必须变红。
    name: 'the empty canvas loses its quick-start cards',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: 'const emptyState = document !== null && document.nodes.length === 0',
    to: 'const emptyState = document !== null && document.nodes.length === -1',
    // 空态不渲染时 waitForSelector 先抛 "selector did not render: …"，
    // 断言消息在其后；两种输出都认。
    expect: /data-quick-card|empty canvas shows the five quick-start cards/,
  },
  {
    // 框选把 no-zoom 面当空白：pointerdown preventDefault+指针捕获抢走卡片
    // click。把守卫改回旧选择器，smoke 的源码不变式必须变红。
    name: 'the marquee swallows quick-card clicks',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: "const isBackground = closestOf(target, '[data-node-id],[data-connection-hit],[data-canvas-no-zoom]') === null",
    to: "const isBackground = closestOf(target, '[data-node-id],[data-connection-hit]') === null",
    expect: /marquee must ignore no-zoom surfaces/,
  },
  {
    // 去掉外壳的 pointer-events:auto：react-flow wrapper 的 none 继承下来，
    // 卡片本体收不到真指针。契约的 PE 不变式必须变红。
    name: 'node cards stop receiving real pointers',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: 'pointerdown，真用户拖不动节点（交互子元素各自 stopPropagation，不受影响）。 */\n  pointer-events: auto;',
    to: 'pointerdown，真用户拖不动节点（交互子元素各自 stopPropagation，不受影响）。 */',
    expect: /pointer-events:auto|drag dead/,
  },
  {
    // The overlay one: the host counts dragenter/dragleave on document and only
    // resets on a drop that reaches it, so one stopPropagation() leaves the
    // "drop files here" overlay stuck on screen. Re-adding it is the defect.
    name: 'a plugin drop stops the event before the host drag overlay can reset',
    runner: 'smoke',
    file: 'src/client/ReferenceImages.tsx',
    from: 'onDrop={event => { event.preventDefault(); props.onAdd',
    to: 'onDrop={event => { event.preventDefault(); event.stopPropagation(); props.onAdd',
    expect: /must not stop propagation/,
  },
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
  {
    // The `pack` case above proves the assertion exists; this one proves it is
    // reached BEFORE the push. WHY the second case: the check has been correct
    // since v1.8.0, and still 1.15.2 and 1.23.0 both shipped a bump without its
    // notes sheet, because the only place it ran was `verify-pack.mjs` -- CI's
    // last step, four minutes after the push, on somebody else's machine. The
    // local suite was green right up to that.
    //
    // `verify-tracked.mjs` is the FIRST entry in `pnpm test`, so this is the
    // cheapest place the question can be asked. Mutating the version here is
    // the shipped shape of the mistake: bump `package.json`, don't write the
    // sheet. If this ever goes green, the local loop has lost the check again
    // and the failure has moved back to being a surprise after pushing.
    name: 'the local suite cannot see a version bump that has no notes',
    runner: 'tracked',
    file: 'package.json',
    from: `  "version": "${SRC_VERSION}",`,
    to: `  "version": "${bumped(SRC_VERSION, 1)}",`,
    expect: new RegExp(`version ${bumped(SRC_VERSION, 1).replace(/\./g, '\\.')} has no release notes`),
  },
  {
    // The `lib/` mapping exists so the guard stops reporting BUILD OUTPUT as
    // uncommitted. Deleting just the resolution reproduces the state every
    // clean clone was in before it: `../lib/index.js` names a gitignored
    // artifact, nothing in the candidate set is tracked, and the guard calls a
    // correct import missing. Without this case the mapping could quietly
    // disappear and nothing would notice until somebody ran `pnpm test` on a
    // fresh checkout -- which is exactly the bug the mapping fixed.
    name: 'a guard forgets that lib/ is build output',
    runner: 'tracked',
    file: 'scripts/verify-tracked.mjs',
    from: `    if (entry !== undefined) list.push(join(ROOT, entry))`,
    to: '',
    expect: /smoke-canvas-agent\.mjs imports \.\.\/lib\/index\.js/,
  },
  {
    // The other direction, and the dangerous one. A guard that never reports
    // anything passes every "is it still green" check while protecting nothing
    // -- so this mutates the mapping into "accept ANY lib/ specifier" and
    // requires that a source entry which is genuinely gone is still caught.
    // The mutation keeps `entry` consulted (an unknown chunk still falls
    // through to the real candidates), so only the resolution of a KNOWN entry
    // is corrupted -- the narrowest change that makes the guard too permissive.
    name: 'a guard accepts a lib/ import whose source entry is gone',
    runner: 'tracked',
    file: 'scripts/verify-tracked.mjs',
    from: `    if (entry !== undefined) list.push(join(ROOT, entry))`,
    to: `    if (entry !== undefined) list.push(join(ROOT, 'src/__absent__' + entry))`,
    expect: /smoke-canvas-agent\.mjs imports \.\.\/lib\/index\.js/,
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
  {
    // D1's invariant is "a run's nodes enter the document ONCE".
    name: 'a landed skill run puts its nodes on the canvas twice',
    runner: 'canvas-video',
    file: 'src/client/canvas',
    // The applier is the one place a run's nodes enter the document. Appending
    // the batch twice is exactly the user-visible failure D1 guards: two nodes
    // under one id. (Dropping the run-map cleanup would also duplicate, but it
    // duplicates on EVERY poll tick, so the suite wedges long before the D1
    // assertion and the case proves nothing about this check.)
    //
    // The append is `...fresh` (the batch minus ids already in the document),
    // not `...nodes`: the applier is idempotent by id, so a second application
    // of the same run adds nothing. Appending `fresh` twice still writes the
    // same id twice within one document, which is what D1 forbids -- the anchor
    // follows the code it guards, or the guard silently stops applying.
    from: "          ...fresh,\n        ],\n        connections: [",
    to: "          ...fresh,\n          ...fresh,\n        ],\n        connections: [",
    expect: /D1: the clip run applied exactly once/,
  },
  {
    // The defect D4 exists for, restored exactly: seeding a canvas throws away
    // the traces that belong to other canvases (and any held output). Measured
    // consequence, not a guess -- `activeSkillRunCount` drops to zero, the poll
    // effect tears down and never re-arms, and a run that was still in flight
    // when the user switched canvases is gone with no card and no node.
    name: 'switching canvases throws away a run that is still in flight',
    runner: 'canvas-video',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "        if (trace.canvasId !== canvasId || trace.status === 'pending') next[taskId] = trace",
    to: "        if (trace.canvasId === canvasId && trace.status !== 'pending') next[taskId] = trace",
    expect: /D4: returning to the run\u2019s own canvas applies the held output/,
  },
  {
    // The held output is the only copy of that result in the browser -- the
    // poll tick skips `pending` outright. Dropping the apply leaves the card
    // cleared but no node, which is what a user would report as "it said it
    // finished and nothing appeared".
    name: 'a held skill output is cleared without being applied',
    runner: 'canvas-video',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "      if (trace.output !== undefined) {",
    to: "      if (trace.output !== undefined && false) {",
    expect: /D4: returning to the run\u2019s own canvas applies the held output/,
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
    file: 'src/client/canvas',
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
    file: 'src/client/canvas',
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
    name: 'the shell window seat falls back under the studio takeover',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: "[data-platform='darwin'] [data-shell-leading] {\n  z-index: var(--z-shell-seat);\n}\n",
    to: '',
    expect: /shell window seat is not lifted above the studio takeover|--z-shell-seat is not declared/,
  },
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
    // The regression the canvas layout guard exists for: the three bottom
    // pieces go back to being independently positioned absolute layers, which
    // is what let a 711px job dock paint over the 236px zoom dock by 107px.
    // Every source invariant still holds — the classes exist, the tokens
    // resolve, the z-index scale is untouched — so only a real browser can see
    // the overlap.
    name: 'the bottom chrome goes back to independent absolute layers',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: [
      '  display: flex;\n  flex-wrap: wrap;\n  align-items: flex-end;',
      '.minimap {\n  position: relative;\n  flex: none;\n  pointer-events: auto;',
      '.zoomDock {\n  position: relative;\n  flex: none;\n  pointer-events: auto;',
      '.dockOuter {\n  flex: 0 1 auto;\n  min-width: 0;\n  margin-inline: auto;',
    ],
    to: [
      '  position: static;\n  display: block;',
      '.minimap {\n  position: absolute;\n  left: 14px;\n  bottom: 62px;',
      '.zoomDock {\n  position: absolute;\n  left: 14px;\n  bottom: 14px;',
      '.dockOuter {\n  position: absolute;\n  left: 0;\n  right: 0;\n  bottom: 14px;\n  height: 42px;\n  margin: 0;',
    ],
    expect: /does not fit the canvas|overlaps itself/,
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
    file: 'src/client/canvas',
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
    // The sidebar switcher is built imperatively, so it is the one tablist the
    // old `.tsx`-only scan could not see. Dropping its keydown wiring is
    // exactly what shipped in #26 and stayed green.
    //
    // This single case proves both halves of the follow-up. The check it must
    // turn red reads `sidebar-entry.ts`, which is a `.ts` file; if the scan were
    // still `.tsx`-only there would be nothing to report and the case would be a
    // FALSE GREEN. (A case that only reverts the extension and injects no defect
    // proves nothing: the file is correct either way, so it can only ever be
    // green. Do not add one.)
    name: 'the sidebar switcher loses its arrow keys',
    runner: 'contracts',
    file: 'src/client/sidebar-entry.ts',
    from: "    entry[0].addEventListener('keydown', event => {\n      onTablistKeyDown(event, {\n        count: entries.length,\n        index,\n        select: next => entries[next]?.[1](),\n      })\n    })\n",
    to: '',
    expect: /sidebar-entry\.ts: declares 2 tab\(s\) but never calls onTablistKeyDown/,
  },
  {
    // Issue #25 measured this in a real host: content-box sizing plus a
    // width:100% is 16px of overflow. Source review cannot see it, and the
    // whole point of the browser check is that it can.
    name: 'the sidebar switcher goes back to content-box sizing',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '  box-sizing: border-box;\n  width: auto;\n  min-width: 0;\n  margin: 0 0 8px;',
    to: '  width: 100%;\n  min-width: 0;\n  margin: 0 0 0;',
    expect: /does not line up with the shell button|box-sizing: content-box|not the 8px/,
  },
  {
    // The 2px drift the live shell actually had, and the exact shape it had it
    // in. The host's New Session button carries a hard-coded `margin: 2px` and
    // publishes no custom property; the old code assumed
    // `--dsh-sidebar-paint-inset` and fell back to 3px, so the switcher sat 2px
    // inside the button on both edges. Re-introduce the assumption and the
    // browser check has to see the drift.
    //
    // This is injected into `alignToSeat` rather than into `placeTabs` on
    // purpose: the fixture lifts `alignToSeat` out of the source and runs it, so
    // the function IS the code under test. Removing a call site in `placeTabs`
    // would prove nothing here -- that call site is covered by the jsdom smoke
    // test, which mounts the real entry.
    name: 'the switcher trusts a paint inset the shell never defines',
    runner: 'contracts',
    file: 'src/client/sidebar-entry.ts',
    from: '  const style = getComputedStyle(button)\n  const left = style.marginLeft\n  const right = style.marginRight\n',
    to: "  const style = getComputedStyle(button)\n  const inset = style.getPropertyValue('--dsh-sidebar-paint-inset').trim() || '3px'\n  const left = inset === '3px' ? '4px' : inset\n  const right = inset === '3px' ? '4px' : inset\n",
    expect: /does not line up with the shell button/,
  },
  {
    // The macOS shell renders its own collapse control in a window-chrome strip
    // above the brand row. That strip owns no slot anchor, so a chrome set built
    // only from the anchors hid it — and the 生图 pane lost the only visible way
    // back to a wide sidebar. Dropping the mark puts that state back.
    name: 'the studio hides the shell collapse control with the foreign entries',
    runner: 'smoke',
    file: 'src/client/sidebar-entry.ts',
    from: '    toggle === undefined ? undefined : blockHolding(root, toggle),\n',
    to: '',
    expect: /the shell's own \.xUkysG_topStrip block stays visible in the studio/,
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
    file: 'src/client/canvas-flow-context.tsx',
    from: '      tabIndex={0}\n      role="group"\n      aria-label={node.title}',
    to: '      role="group"\n      aria-label={node.title}',
    expect: /canvas node root is not focusable|does not reveal its toolbar/,
  },
  {
    // The adapter is the save boundary: dropping the metadata spread means
    // every autosave silently strips prompts/annotations off the user's nodes.
    name: 'the flow adapter drops node metadata on the way back',
    runner: 'contracts',
    file: 'src/client/canvas-flow-adapter.ts',
    from: '    ...(flow.data.metadata !== undefined ? { metadata: flow.data.metadata } : {}),\n',
    to: '',
    expect: /flow adapter round-trip is lossy/,
  },
  {
    // Without the finite guard a layout-less react-flow reports NaN straight
    // into document.viewport, and every coordinate after that inherits it.
    name: 'the viewport write-back accepts non-finite geometry',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom)) return\n',
    to: '',
    expect: /viewport write-back lost its finite guard/,
  },

  // ------------------------------------------------------ issues #22 and #23
  // Four defects, each one a state this repository actually shipped.
  //
  // The first two are the halves of issue #22. The close button was reported as
  // MISSING and was in fact painted; the fix moved the boundary onto the ring,
  // so the mutation puts the boundary back below the bar while leaving the fill
  // and the glyph exactly as they are. That is the failure mode worth guarding:
  // every text-contrast measurement stays green.
  {
    name: 'the preview close button loses its boundary against the mask',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '  --lightbox-control-surface: color-mix(in srgb, var(--dsw-static-neutral-00) 34%, transparent);\n  --lightbox-control-surface-hover: color-mix(in srgb, var(--dsw-static-neutral-00) 44%, transparent);\n  --lightbox-control-edge: color-mix(in srgb, var(--dsw-static-neutral-00) 55%, transparent);',
    to: '  --lightbox-control-surface: color-mix(in srgb, var(--dsw-static-neutral-00) 16%, transparent);\n  --lightbox-control-surface-hover: color-mix(in srgb, var(--dsw-static-neutral-00) 28%, transparent);\n  --lightbox-control-edge: color-mix(in srgb, var(--dsw-static-neutral-00) 22%, transparent);',
    expect: /close button is not a findable control|not findable in a/,
  },
  {
    // The regression the user reported: the chrome was derived from a token that
    // flips with the theme, so in a DARK theme every control became the same
    // colour as the mask. This mutation puts that token back — which leaves the
    // LIGHT theme byte-identical (the flipped value there was already #fff) and
    // is therefore invisible to every check that only renders one palette.
    name: 'the lightbox chrome goes back to a theme-coupled ink',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: '  --lightbox-ink: var(--dsw-static-neutral-00);\n  --lightbox-surface: color-mix(in srgb, var(--dsw-static-neutral-00) 16%, transparent);\n  --lightbox-surface-hover: color-mix(in srgb, var(--dsw-static-neutral-00) 28%, transparent);',
    to: '  --lightbox-ink: var(--dsw-alias-label-primary-foreground);\n  --lightbox-surface: color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 16%, transparent);\n  --lightbox-surface-hover: color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 28%, transparent);',
    expect: /unreadable in a dark theme/,
  },
  {
    // The other half of the same user report, and the reason the light theme got
    // damaged: one value mixed from theme ink "fixed" dark and dimmed a light
    // canvas that was never broken. Reproducing it makes the LIGHT measurement
    // read 1.29:1 on a palette whose correct answer is 1.00:1.
    name: 'the canvas node is dimmed in the light theme too',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '  --canvas-node-surface: var(--dsw-alias-bg-layer-1);',
    to: '  --canvas-node-surface: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, var(--dsw-alias-label-primary));',
    expect: /the LIGHT theme's canvas was changed|original white card/,
  },
  {
    // The instance of the bug that a scroll-and-zoom race is made of: the
    // non-passive listener is gone, so `preventDefault()` is dead code again
    // and the deck scrolls under the zoom.
    name: 'the preview goes back to a passive wheel handler',
    runner: 'contracts',
    file: 'src/client/ImageGenPanel.tsx',
    from: "    stage.addEventListener('wheel', onWheel, { passive: false })",
    to: "    stage.addEventListener('wheel', onWheel)",
    expect: /no `addEventListener\('wheel'/,
  },
  {
    // The half of #22 that `overscroll-behavior: contain` did NOT fix: the
    // listener is still on the stage, so the stage is fine, but the overlay
    // around it (toolbar, caption, margin) lets the notch through to the
    // workbench. Removing only the overlay binding reproduces exactly that.
    name: 'the preview overlay lets the wheel escape to the workbench',
    runner: 'contracts',
    file: 'src/client/ImageGenPanel.tsx',
    from: "    dialog?.addEventListener('wheel', containWheel, { passive: false })",
    to: '    void containWheel',
    expect: /scrolled the workbench/,
  },
  {
    // Issue #23, exactly as it shipped: the node and the canvas name the same
    // token, so in a dark theme the two surfaces are not similar but identical.
    name: 'the canvas node paints the same surface as the canvas',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '  background: var(--canvas-node-surface);',
    to: '  background: var(--dsw-alias-bg-layer-1);',
    expect: /has no fill of its own/,
  },
  {
    // The other half of #23: a selection that paints the resting border is a
    // selection the user cannot see, and the resting state is now the baseline
    // the selected state has to beat.
    name: 'selecting a node stops changing its border',
    runner: 'contracts',
    file: 'src/client/canvas-workspace.module.css',
    from: '.nodeSelected {\n  border-color: var(--dsw-alias-brand-primary);',
    to: '.nodeSelected {\n  border-color: var(--canvas-node-border);',
    expect: /same border as the resting node/,
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
    file: 'src/client/canvas',
    from: "return <div className={css.composer} data-canvas-no-zoom=\"\" style={{ left: clampedX - 280, top }}>",
    to: "return <div className={`${css.composer} ${css.viewport}`} data-canvas-no-zoom=\"\" style={{ left: clampedX - 280, top }}>",
    expect: /composer sits outside the viewport/,
  },
  {
    name: 'touch pinch is gone again',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: "    if (event.pointerType === 'touch') {\n      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })",
    to: '    if (false) {\n      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })',
    expect: /two touch pointers moving apart zoom in/,
  },
  {
    name: 'Space eats a focused button again',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: "      if (event.code === 'Space' && !isEditingTarget(event.target) && !isActivatableTarget(event.target)) {",
    to: "      if (event.code === 'Space' && !isEditingTarget(event.target)) {",
    expect: /Space on a focused button/,
  },
  {
    name: 'Esc no longer closes the in-canvas video preview',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: '        if (videoPreviewNodeId !== null) { setVideoPreviewNodeId(null); return }\n',
    to: '',
    expect: /Escape closes the in-canvas video preview/,
  },
  {
    name: 'the image picker keeps its stale file value',
    runner: 'smoke',
    file: 'src/client/canvas',
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
    // The #9 fallback exists because a terminal poll may carry no URL at all.
    // Put the old "no URL means failed" branch back and the smoke case that
    // serves exactly that body must go red.
    name: 'a finished task with no URL is failed again instead of fetched from /content (#9)',
    runner: 'video',
    file: 'src/video-engine.ts',
    from: "    if (typeof url !== 'string') {\n      return {\n        kind: 'done-content',",
    to: "    if (typeof url !== 'string') {\n      return { kind: 'failed', message: '视频任务已完成但未返回视频地址' }\n    }\n    if (false) {\n      return {\n        kind: 'done-content',",
    expect: /falls back to GET \/videos\/\{id\}\/content/,
  },
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
    from: '      <div className={css.videoDiagnosticsRow}>\n        <DiagnosticsButton open={diagnosticsOpen} onToggle={() => { setDiagnosticsOpen(open => !open) }} />\n        <SignalsButton open={signalsOpen} onToggle={() => { setSignalsOpen(open => !open) }} />\n      </div>',
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
    // Anchored on ONE line, not on its neighbours: the `files` array grew a
    // "locale" entry between "lib" and "src/templates", and every case written
    // against that adjacency silently stopped applying (HARNESS BROKEN) even
    // though the rule it guards was unchanged.
    from: '    "docs/releases",',
    to: '    "docs/images",\n    "docs/releases",',
    expect: /docs\/images\/ -- README screenshots/,
  },
  {
    // The archive ships a manifest promising two halves: `main` (the host half)
    // and `exports["./client"]` (what the browser fetches). Nothing used to
    // compare the promise against the packed file list, so an `exports` edit
    // aimed at a renamed file produced an archive that installed cleanly,
    // booted cleanly, and then 404ed the panel with no error anywhere.
    //
    // Mutated on the `exports` side, not by dropping "lib" from `files` -- see
    // the case below for why that mutation can no longer reach this check.
    name: 'the archive declares a client half it does not contain',
    runner: 'pack',
    file: 'package.json',
    // Anchored on the whole line, so the case does not depend on which entry
    // happens to follow it.
    from: '    "./client": "./lib/client.js",\n',
    to: '    "./client": "./lib/client-browser.js",\n',
    expect: /exports\["\.\/client"\] -> lib\/client-browser\.js \(not in the archive\)/,
  },
  {
    // The other direction, and the reason the case above is no longer written
    // this way: npm and pnpm ALWAYS pack the file named by `main`, even when
    // `files` omits it. While `main` was `lib/index.js`, dropping "lib" from
    // `files` still shipped that one file, so the archive's declared entry
    // points were checked next and the missing browser half was reported.
    //
    // `main` now points at the committed `index.js` re-export (so a source-only
    // tree has a runtime entry at all), which means the automatic inclusion no
    // longer covers `lib/index.js`. Dropping "lib" is therefore caught EARLIER,
    // by the required-entries check -- this case pins that ordering, because a
    // reordering that let the archive ship with no built code would make the
    // plugin install and do nothing.
    name: 'the archive drops the built code that the entry re-exports',
    runner: 'pack',
    file: 'package.json',
    // Single-line anchor: removing the "lib" entry is the defect, and it must
    // not depend on which entries happen to surround it.
    from: '    "lib",\n',
    to: '',
    expect: /the published archive is missing entries the runtime needs:[\s\S]*package\/lib\/index\.js/,
  },
  {
    // `files` is what the manifest promises to ship; the tarball is what got
    // shipped. npm and pnpm add `main` (and `bin`, `package.json`, the readme,
    // the licence) on their own, so the two disagree without anyone noticing:
    // measured by deleting "index.js" from `files` and watching every
    // archive-content check stay green, because the packer was doing the
    // manifest's job. That cover vanishes the day `main` is renamed or the
    // tarball is built by something that reads `files` literally.
    name: 'the entry point ships only because the packer added it',
    runner: 'pack',
    file: 'package.json',
    // Single-line anchor: the defect is the missing entry, not its neighbours.
    from: '    "index.js",\n',
    to: '',
    expect: /entry points that `files` does not ship:[\s\S]*main -> index\.js/,
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
    // A real bump changes both halves; leaving `src/protocol.ts` behind makes
    // the two-copies-of-the-version guard fire FIRST, and this case then went
    // red for a reason it never meant to test ("RED but wrong reason"). It has
    // been that way since that guard was added -- measured on a clean checkout
    // of 9e3cfbf, so it is not this round's doing. Carrying the second half
    // keeps the case aimed at the notes check.
    also: [{
      file: 'src/protocol.ts',
      from: `export const PLUGIN_VERSION = '${SRC_VERSION}'`,
      to: `export const PLUGIN_VERSION = '${bumped(SRC_VERSION, 1)}'`,
    }],
    expect: new RegExp(`version ${bumped(SRC_VERSION, 1).replace(/\./g, '\\.')} has no release notes`),
  },
  {
    // The other half: the notes exist on disk but the archive leaves them out.
    // `files` lists docs/releases, so this is the manifest drifting from the
    // convention that every release carries its own notes.
    name: 'the archive stops carrying the release notes it declares',
    runner: 'pack',
    file: 'package.json',
    // Single-line anchor, same reason as the two above: the neighbouring
    // entries moved and this case silently stopped applying.
    from: '    "docs/releases",',
    to: '    "docs/releases-removed",',
    expect: new RegExp(`does not contain docs\\/releases\\/v${SRC_VERSION.replace(/\./g, '\\.')}\\.md`),
  },
  {
    // The publish job proves a publish worked by reading the version back. That
    // read lags the write by minutes: 3m16s on 1.7.8, and 6m11s on 1.29.0. The
    // shipped window has to outlast the worst of them, so the negative case
    // restores a window short enough to fail on a publish that worked -- the
    // worst shape of a false failure, because it points at credentials.
    name: 'the publish job gives the registry read less time than it takes',
    runner: 'pack',
    file: '.github/workflows/release.yml',
    from: 'for attempt in $(seq 1 60); do',
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
    // The drift can surface in either comparison (the native map's order is
    // per-process); the invariant header is printed for both.
    expect: /same input yields different output/,
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
    file: 'src/client/canvas',
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
    file: 'src/client/canvas',
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
  {
    // This is the user-visible symptom, verbatim: click "A+ 详情页" on the
    // right-hand end of the nav row and every title looks like two. There is
    // only one tab per label in the DOM; the second copy is the decoration
    // layer (`span.effectText`, z-index 1, pointer-events none) plus the pill,
    // which were placed from VIEWPORT coordinates inside a container that is
    // itself a scroll container (`overflow-x: auto`). The row only overflows
    // below ~1280px, which is why it never reproduced on a wide window.
    //
    // The mutation removes exactly the scroll amount from the left offset, so
    // the fixture has to catch it by measuring the decoration against the
    // active tab -- a source-level "does the string contain scrollLeft" check
    // would pass on a fix that reads the wrong container.
    name: 'the nav pill stops following the row when it scrolls',
    runner: 'contracts',
    file: 'src/client/GooeyNav.tsx',
    from: 'pos.x - containerRect.x + container.scrollLeft',
    to: 'pos.x - containerRect.x',
    expect: /drifts off the active tab/,
  },
  {
    // One press, one charge. The submit buttons carried `type="submit"` AND an
    // `onClick` calling the same handler, so a click ran both paths and every
    // generate was billed twice. Putting the `onClick` back is the exact
    // mutation: it must make the request-count check go red.
    name: 'a submit button also fires its own click handler',
    runner: 'smoke',
    file: 'src/client/PromoWorkspace.tsx',
    from: '            <button type="submit" className={css.primary} disabled={!ready}>',
    to: '            <button type="submit" className={css.primary} disabled={!ready} onClick={() => void generate()}>',
    expect: /one click on promo's submit must issue one generation/,
  },
  {
    // #13: a deleted channel used to keep its plaintext key in `channelSecrets`
    // forever — the row vanished from the UI, so no control was left to clear
    // it. Dropping the derived removals restores exactly that: the `channels`
    // rewrite still happens, only the secret survives.
    name: 'a deleted channel keeps its api key in channelSecrets',
    runner: 'smoke',
    file: 'src/client/channels-form.ts',
    from: '    for (const id of removed) ops.push({ op: \'unset\', path: [\'channelSecrets\', id] })',
    to: '    void removed',
    expect: /deleting a channel unsets its secret/,
  },
  {
    // #13, the nastier half: a key typed just before the delete stayed staged
    // as `{kind:'set'}`, so the save wrote it straight back to the id that was
    // being removed. Two independent guards stop that — `stageChannels` drops
    // the stale edit, and `planOps` skips any removed id — so the case has to
    // remove both, or the surviving one keeps the check green and the case
    // reports FALSE GREEN while the write-back it targets is still reachable.
    name: 'a key typed before the delete is written back to the removed id',
    runner: 'smoke',
    file: 'src/client/channels-form.ts',
    from: [
      '    const kept = new Set(cleaned.map(channel => channel.id))\n    for (const id of [...this.stagedKeys.keys()]) {\n      if (!kept.has(id)) this.stagedKeys.delete(id)\n    }',
      '      if (removed.includes(id)) continue',
    ],
    to: [
      '    // stale staged edits kept',
      '      // removed ids not skipped',
    ],
    expect: /must not be written back to the removed id/,
  },
  {
    // #14: `.channelBadge` was `white-space: nowrap` with no way to shrink, so a
    // long model-alias list set the channel row's min-content width and pushed
    // it past the card — where `.settingsSection`'s `overflow: clip` swallowed
    // it with no scrollbar. Three declarations together make the row survive at
    // 850px (the badge can shrink, and `.card`/`.body` keep `min-width: 0` so a
    // grid track cannot be widened by a child), so the case restores all three:
    // removing only the badge rule leaves the row green and reports FALSE GREEN.
    name: 'a long model-alias badge pushes the channel row out of the card',
    runner: 'contracts',
    file: 'src/client/settings-card.module.css',
    from: [
      '  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-weight: 500;',
      '  transition: border-color 0.16s, background 0.16s;\n  /* The settings host can mount this card as a grid item. There `min-width:\n     auto` resolves to min-content, so a wide child widened the track and the\n     card hung over both edges of the pane instead of wrapping inside it. */\n  min-width: 0;',
      '  margin: 0 16px;\n  padding-bottom: 8px;\n  min-width: 0;',
      '  overflow-x: auto;\n  overflow-y: visible;',
    ],
    to: [
      '  white-space: nowrap;\n  font-weight: 500;',
      '  transition: border-color 0.16s, background 0.16s;',
      '  margin: 0 16px;\n  padding-bottom: 8px;',
      '  overflow: clip;',
    ],
    expect: /card hangs outside its pane|channel row is wider|clips its overflow|settings page scrolls horizontally/,
  },
  {
    // The lightbox chrome followed the theme's inversion while sitting on a
    // fixed dark mask: white text on the light theme's white input background
    // = 1:1, invisible until :hover. Restoring the theme tokens restores that
    // exact pair, and the contrast guard must go red.
    name: 'the lightbox buttons follow the theme instead of the dark mask',
    runner: 'contracts',
    file: 'src/client/panel.module.css',
    from: [
      '  color: var(--lightbox-ink);\n  background: var(--lightbox-surface);\n  border: 1px solid var(--lightbox-edge);\n  cursor: pointer;\n}',
    ],
    to: [
      '  color: var(--dsw-alias-label-primary-inverted);\n  background: var(--dsw-specific-input-major);\n  border: 1px solid var(--lightbox-edge);\n  cursor: pointer;\n}',
    ],
    expect: /lightbox chrome is unreadable in a light theme|unreadable in a light theme/,
  },
  {
    // A canvas drop used to read every dropped image at once with Promise.all
    // and no size or count cap, which seized the page on a large selection.
    // Removing the caps restores exactly that path.
    name: 'a canvas drop reads every image at once with no caps',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: '    const oversized = allImages.filter(file => file.size > DROP_IMAGE_MAX_BYTES)\n    const withinSize = allImages.filter(file => file.size <= DROP_IMAGE_MAX_BYTES)\n    const images = withinSize.slice(0, DROP_IMAGE_MAX_COUNT)',
    to: '    const oversized = []\n    const withinSize = allImages\n    const images = allImages',
    expect: /dropped image over the size cap|drop is capped to a maximum|read sequentially/,
  },
  {
    // Every Windows installer writes `ffmpeg.exe`; joining the bare name is a
    // lookup that can never match it. Dropping the `.exe` spelling restores the
    // P0 from issue #15, where a correctly installed ffmpeg was invisible to the
    // whole video pipeline.
    name: 'a Windows lookup only tries the bare tool name',
    runner: 'smoke',
    file: 'src/video-tools.ts',
    from: '  return platform === \'win32\' ? [`${name}.exe`, name] : [name]',
    to: '  return [name]',
    expect: /must find ffmpeg\.exe through PATH/,
  },
  {
    // The candidate list used to be four POSIX directories, none of which exist
    // on Windows, while PATH -- the one place winget, scoop and the official zip
    // install to -- was never consulted. Removing PATH restores that state.
    name: 'tool discovery never consults PATH',
    runner: 'smoke',
    file: 'src/video-tools.ts',
    from: "  const separator = platform === 'win32' ? ';' : ':'\n  const fromPath = (env.PATH ?? env.Path ?? '').split(separator)\n  return [...new Set([...dirs, ...fromPath])].filter(dir => dir !== '')",
    to: "  return [...new Set(dirs)].filter(dir => dir !== '')",
    expect: /must find ffmpeg\.exe through PATH/,
  },
  {
    // The whole point of normalising at the read. Git for Windows hands a fresh
    // checkout CRLF, and every cross-line pattern in the guards is written with
    // `\n`.
    //
    // The injected defect CONVERTS to CRLF rather than merely dropping the
    // normalisation. Dropping it alone is a no-op on this machine — the working
    // tree is LF, so the check stays green and the case reports FALSE GREEN
    // while the Windows failure it targets is still reachable. Converting makes
    // the copy look like the checkout the guard actually gets on Windows, which
    // is the state the normalisation exists to survive.
    name: 'source text is read with its CRLF line endings intact',
    runner: 'contracts',
    file: 'scripts/lib/source-text.mjs',
    from: "  return readFileSync(path, 'utf8').replace(/\\r\\n?/g, '\\n')",
    to: "  return readFileSync(path, 'utf8').replace(/\\n/g, '\\r\\n')",
    expect: /no readable label|has no host-side fetch definition/,
  },
  // ------------------------------------------------- behaviour signals (L0)
  // Each of these three restores a defect that would leave the report looking
  // healthy while being wrong — the exact failure mode a signal log must not
  // have, because its whole purpose is to be trusted over a release cycle.
  {
    // Storing the prompt instead of its length bucket. This is the privacy
    // promise the feature rests on: the line is written to a file the user may
    // later copy into a public issue, so the check has to fail if the text ever
    // reaches it.
    name: 'the signal log stores the prompt text instead of its length bucket',
    runner: 'signals',
    file: 'src/signal-store.ts',
    from: "    promptBucket: promptBucketOf(typeof input.prompt === 'string' ? input.prompt : undefined),",
    to: "    promptBucket: (typeof input.prompt === 'string' ? input.prompt : undefined),",
    expect: /落盘内容不含提示词原文|分档不保留任何原文片段/,
  },
  {
    // Bucketing by model alone. Two modes then share one rate, and the model's
    // hard-task failures get blamed on its easy-task volume — a report that
    // reads fine and points at the wrong fix.
    name: 'signals from different modes are pooled into one bucket',
    runner: 'signals',
    file: 'src/signal-report.ts',
    from: "    entry.pipeline,\n    entry.model,\n    entry.mode,\n    entry.promptBucket ?? '',",
    to: "    entry.pipeline,\n    entry.model,\n    '',\n    entry.promptBucket ?? '',",
    expect: /同一个模型的不同 mode 分成两个桶|小样本一律 unknown/,
  },
  {
    // Calling a small sample healthy. `ok` on three signals is the sentence
    // that teaches a reader to ignore every later verdict.
    name: 'a small sample is reported as healthy instead of unknown',
    runner: 'signals',
    file: 'src/signal-report.ts',
    from: "  if (bucket.total < MIN_SAMPLE) return { verdict: 'unknown', verdictMetric: '' }",
    to: "  if (bucket.total < MIN_SAMPLE) return { verdict: 'ok', verdictMetric: '' }",
    // The mutation flips the verdict, so the assertion that fails is the
    // strictEqual on the verdict value, not the case title. Match the raw fact.
    expect: /expected: 'unknown'|小样本一律 unknown/,
  },
  {
    // The report exists on the host but nothing opens it. This is the defect
    // that survives every unit test: a perfectly correct aggregator behind a
    // button that is rendered nowhere, reachable from neither studio.
    name: 'the video studio stops offering the behaviour report',
    runner: 'smoke',
    file: 'src/client/VideoPanel.tsx',
    from: '        <SignalsButton open={signalsOpen} onToggle={() => { setSignalsOpen(open => !open) }} />\n',
    to: '',
    expect: /exactly one behaviour-report entry|opens the behaviour report/,
  },
  // ------------------------------------------- the outfit gallery trust boundary
  {
    // The gallery index is remote JSON that names the image URLs the host will
    // download. With the guard gone `outfitAssetUrl` passes anything through --
    // http, loopback, another repository, a path that walks out of the pinned
    // one -- and the host fetches whatever the index says. The smoke case pins
    // those five refusals individually, so dropping the guard has to go red.
    name: 'the gallery accepts any image address instead of only the pinned sources',
    runner: 'outfit',
    file: 'src/outfit-reference-store.ts',
    from: "  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !imagePath.test(expectedPath)) throw new Error('图库图片地址不在可信来源内')\n",
    to: '',
    expect: /Missing expected exception/,
  },
  {
    // The index is pinned to a commit by GIT BLOB hash, not by an HTTP ETag: a
    // mirror serving a different row set must be rejected instead of trusted,
    // which is what stops the material drifting under an unchanged plugin
    // version. Note the smoke case is built on exactly this asymmetry -- the
    // served index is a VALID one-row index whose hash is simply not the pinned
    // one -- so a no-op check accepts the drifted mirror and the count goes
    // from zero rows to one.
    name: 'a mirror whose index does not hash to the pinned commit is trusted',
    runner: 'outfit',
    file: 'src/outfit-reference-store.ts',
    from: "  const header = Buffer.from(`blob ${content.byteLength}\\0`)\n  if (createHash('sha1').update(header).update(content).digest('hex') !== expected) throw new Error('远端图库索引版本已变化，请等待插件更新固定版本')",
    to: '  void content\n  void expected',
    expect: /1 !== 0/,
  },
  // --------------------------------------------------- the outfit reference sheet
  {
    // Past the channel's reference capacity the workspace composes ONE numbered
    // sheet, which is what replaced the old behaviour of quietly dropping the
    // extras. Truncating to the first N references restores that defect while
    // the prompt is still built for the full recipe, so the model is told about
    // images it never received -- exactly the silent loss the sheet prevents.
    name: 'references past the channel capacity are truncated instead of composed',
    runner: 'outfit',
    script: 'scripts/smoke-outfit-generation.mjs',
    file: 'src/client/outfit-generation.ts',
    from: '    const sheet = await composeSheet(parts, blobs)\n    return { prompt: buildOutfitPrompt(recipe, true), image: sheet, images: [], sheet, referenceCount: parts.length }',
    to: '    const kept = blobs.slice(0, referenceLimit)\n    const images = await Promise.all(kept.map(toDataUrl))\n    return { prompt: buildOutfitPrompt(recipe), image: images[0], images: images.slice(1), sheet: null, referenceCount: kept.length }',
    expect: /falsy value/,
  },
  {
    // 提交改回阻塞式 generate 后，面板既不产生任务记录也无可恢复进行中状态；
    // 任务门禁（verify-outfit-task-gate.mjs）的四条源码不变式断言随之变红。
    name: 'outfit generation waits blocking and leaves no restorable task record',
    runner: 'outfit',
    script: 'scripts/verify-outfit-task-gate.mjs',
    file: 'src/client/OutfitWorkspace.tsx',
    from: '      await api.taskSubmit(request)\n',
    to: '      const result = await api.generate(request)\n      if (result.historyError) throw new Error(result.historyError)\n',
    expect: /MISSING api\.taskSubmit/,
  },
  {
    // 用户的要求是「模特库放在浏览人像图库中」。把 list 里注入模特那一行
    // 摘掉，人物图库就退回成只有内置人像的远程图库——门禁里的第一条断言
    // 随之失配，而模特库究竟还在不在人物图库里，正是这条用例在守的东西。
    name: 'the model library is dropped from the portrait gallery list',
    runner: 'outfit',
    script: 'scripts/verify-outfit-model-gallery.mjs',
    file: 'src/outfit-reference-store.ts',
    from: "    const models = request.kind === 'portrait' ? (await listModels()).map(modelReference) : []\n",
    to: '',
    expect: /FAIL 人物图库列表没有把本机模特库并进来/,
  },
  {
    // 另一种退化：模特库又搬回工作台，人物图库不再承担它。这种情况下列表
    // 里仍有模特，但「添加 / AI 生成」的入口不在图库里了。
    name: 'adding a model leaves the portrait gallery again',
    runner: 'outfit',
    script: 'scripts/verify-outfit-model-gallery.mjs',
    file: 'src/client/OutfitReferencePicker.tsx',
    from: '      {kind === \'portrait\' && (api.saveModel || generateModel) ? <div className={css.modelRow} data-outfit-model-add="">\n',
    to: '      {false ? <div className={css.modelRow} data-outfit-model-add="">\n',
    expect: /FAIL 人物图库的添加模特行没有按/,
  },
  // ------------------------------------------- the outfit form's draft gate
  {
    // 草稿读失败曾经把整张 <fieldset> 永久禁用：模式按钮、图库入口、上传全
    // 部点不动，而提示只说「无法读取草稿」——用户看到的就是「角色搭配点不了」。
    // 旧的 `disabled={!draftLoaded}` 在草稿永远读不到时就等于恒禁用，所以
    // 这里直接注入恒禁用：E1 新增的两条启用态断言必须变红。
    name: 'the outfit form goes back to a permanently disabled fieldset',
    runner: 'smoke',
    file: 'src/client/OutfitWorkspace.tsx',
    from: "  const formLocked = !draftLoaded && draftError === ''",
    to: '  const formLocked = true',
    expect: /the outfit form is interactive, not stuck waiting on a draft read/,
  },
  // ------------------------------------------- animated GIF output (gpt-image-2.6)
  {
    // 把 output_format 从请求体摘掉，上游就拿不到「这是动图」这条指令，
    // 只会退回成一张静图——用户付了动图的帧数预算却拿到 PNG。套件里
    // 「GIF 应只发一次请求 / output_format 应为 gif」随之失配。
    name: 'gif output forgets to ask upstream for a gif',
    runner: 'gif',
    file: 'src/engine.ts',
    from: "      output_format: 'gif',\n",
    to: '',
    expect: /undefined !== 'gif'|output_format|GIF 应走 generations/,
  },
  {
    // 另一条退化：给不支持的模型也发 GIF 参数。2.5 会拒绝或忽略，
    // 用户看到的错误离真实原因很远，所以前置拒绝必须在。
    name: 'gif is sent to a model that cannot produce it',
    runner: 'gif',
    file: 'src/engine.ts',
    from: "  if (!supportsGifOutput(model)) {\n    throw new ImageGenError('该模型不支持 GIF 动图，请切换到 gpt-image-2.6', 'gif-unsupported')\n  }\n",
    to: '',
    expect: /gif-unsupported|2\.5 请求 GIF 应被拒绝/,
  },
  {
    // 帧数不夹紧：99 帧会被上游直接拒绝（或超出像素预算），
    // 面板说的「9 帧」与实际发出的不一致。
    name: 'gif frame count is passed through unclamped',
    runner: 'gif',
    // 夹紧已经收进 model-catalog，引擎、面板提交、面板提示共用同一份。
    file: 'src/model-catalog.ts',
    from: '  return Math.min(GIF_FRAME_MAX, Math.max(GIF_FRAME_MIN, Math.round(value)))',
    to: '  return Math.round(value)',
    expect: /帧数上限 16|正数但低于下限时夹到 2/,
  },
  {
    // 清空输入框得到的 0 被当成真实帧数夹到下限：面板提示按默认 9 帧
    // 算时长，请求却只发 2 帧，屏幕上的秒数与拿到的动图不符。
    name: 'gif treats an emptied frame input as a real zero',
    runner: 'gif',
    file: 'src/model-catalog.ts',
    from: '  if (value === undefined || !Number.isFinite(value) || value <= 0) return GIF_FRAME_DEFAULT',
    to: '  if (value === undefined || !Number.isFinite(value)) return GIF_FRAME_DEFAULT',
    expect: /0 视为未设置|回落默认帧数/,
  },
  {
    // 前置闸搬回 effectiveParams 的退化：chat/completions 与 Qwen / MiniMax
    // 原生分支都在那之前 return，GIF 参数被丢掉，用户付费拿到静图
    // 却被历史标成 GIF。
    name: 'gif gate sits after the protocol dispatch again',
    runner: 'gif',
    file: 'src/engine.ts',
    from: '  assertGifRequestSupported(request, wireModel(request))\n',
    to: '',
    expect: /gif-unsupported|2\.5 请求 GIF 应被拒绝|Qwen 原生分支请求 GIF 应被拒绝|MiniMax 原生分支请求 GIF 应被拒绝/,
  },
  {
    // chat/completions 的请求体没有 output_format 字段，即使模型是 2.6
    // 也只会出静图；放行这条等于让用户为一张假 GIF 付费。
    name: 'gif is accepted on a chat-completions channel',
    runner: 'gif',
    file: 'src/engine.ts',
    from: "    if (request.outputFormat === 'gif') {\n      throw new ImageGenError('当前渠道走 chat/completions 协议，不支持 GIF 动图：请改用 /images/generations 渠道', 'gif-protocol-unsupported')\n    }\n",
    to: '',
    expect: /gif-protocol-unsupported|chat\/completions 渠道请求 GIF 应被拒绝/,
  },
  {
    // 图生图开口子：官方指南写明 /images/edits 不出 GIF，
    // 放行等于让用户以为参考图能动起来。
    name: 'gif is allowed through the edit endpoint',
    runner: 'gif',
    file: 'src/engine.ts',
    from: "  if (request.mode === 'edit') {\n    throw new ImageGenError('GIF 动图只支持文字生成，参考图不参与动图请求', 'gif-edit-unsupported')\n  }\n",
    to: '',
    expect: /gif-edit-unsupported|图生图 GIF 应被拒绝/,
  },
  {
    // issue #29：URL 型模板图引用解码后 https:// 必然切出空段；把空段限制
    // 改回全局生效，URL 型引用就又恒死在路由校验、到不了 store 的白名单。
    name: 'URL-type template image refs are rejected as empty-segment paths again',
    runner: 'smoke',
    file: 'src/routes.ts',
    from: "    if (segment === '.' || segment === '..' || (segment === '' && !isUrlRef)) return undefined",
    to: "    if (segment === '' || segment === '.' || segment === '..') return undefined",
    expect: /C6a2 URL-type template image references reach the backend/,
  },
  {
    // issue #28：Google 原生协议层的 GIF 闸。去掉它，GIF capable 模型配
    // google-native 渠道就会发出去，用户为动图付费拿到静图。
    name: 'google-native accepts a GIF request again',
    runner: 'google-native',
    file: 'src/engine.ts',
    from: "    if (request.outputFormat === 'gif') {\n      throw new ImageGenError('当前渠道走 Google 原生协议，不支持 GIF 动图：请改用 /images/generations 渠道', 'gif-protocol-unsupported')\n    }\n",
    to: '',
    expect: /应抛 ImageGenError\(gif-protocol-unsupported\)/,
  },
  {
    // issue #28：google-native 鉴权是 x-goog-api-key；换回 Bearer 会被
    // Google 401，套件的请求头断言必须变红。
    name: 'google-native authenticates with Bearer again',
    runner: 'google-native',
    file: 'src/engine.ts',
    from: "        headers: { 'content-type': 'application/json', 'x-goog-api-key': upstream.apiKey.trim() },",
    to: "        headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.apiKey.trim()}` },",
    expect: /test-google-key/,
  },
  {
    // issue #28：参考图上限 5；放宽到 6 会多发一张 inlineData，
    // 套件的 parts 计数断言必须变红。
    name: 'google-native carries a sixth reference image',
    runner: 'google-native',
    file: 'src/engine.ts',
    from: "    const references = [request.image, ...(request.images ?? []).filter(img => typeof img === 'string' && img !== '')].slice(0, 5)",
    to: "    const references = [request.image, ...(request.images ?? []).filter(img => typeof img === 'string' && img !== '')].slice(0, 6)",
    expect: /5 张参考图 \+ 1 段文本/,
  },
  {
    // 千问生图 API 的 model 必须把渠道别名原样发给上游；写死成默认模型
    // 会让所有模型都出同一套结果，套件的请求体断言必须变红。
    name: 'qwen-draw ignores the requested model',
    runner: 'qwen-draw',
    file: 'src/engine.ts',
    from: "    prompt: request.prompt,\n    model,\n",
    to: "    prompt: request.prompt,\n    model: 'krea2-turbo',\n",
    expect: /qwen-draw must send the requested model/,
  },
  {
    // issue #28：客户端协议选择器的 google-native 选项。去掉它用户就
    // 选不到这条协议，D4 的源码不变式必须变红。
    name: 'the client protocol selector drops google-native',
    runner: 'smoke',
    file: 'src/client/SettingsCard.tsx',
    from: "              <option value=\"google-native\">{t('channels.protocolGoogle')}</option>\n",
    to: '',
    expect: /the protocol selector offers google-native/,
  },
  {
    // issue #28：客户端参考图上限规则里的 google-native。去掉它 gemini
    // 模型落回 nanobanana 族的 1 张，D4 的上限断言必须变红。
    name: 'google-native collapses to the nanobanana single reference',
    runner: 'smoke',
    file: 'src/client/reference-images.ts',
    from: "  if (protocol === 'chat-completions' || protocol === 'google-native') return EDIT_REFERENCE_LIMIT",
    to: "  if (protocol === 'chat-completions') return EDIT_REFERENCE_LIMIT",
    expect: /five-reference ceiling/,
  },
  // ------------------------------------------- 内置模型基线表
  {
    // 本轮修的真实缺陷：聚合网关按 `vendor/model` 寻址，旧实现拿原始串直接
    // 比对，`google/gemini-3-pro-image` 因此落到 unknown——面板随即误报
    // 「只保留 1 张参考图」，engine 也退回通用 OpenAI 协议。把剥离逻辑退回
    // 原样（不剥前缀）后，基线表套件必须变红。
    name: 'a vendor-prefixed model id falls back to unknown',
    runner: 'baseline',
    file: 'src/model-baseline.ts',
    from: "  const slash = id.indexOf('/')\n  if (slash <= 0 || slash === id.length - 1) return id\n  return id.slice(slash + 1)",
    to: '  return id',
    expect: /带厂商前缀的图像模型不再落到 unknown|前缀 id 也能精确命中基线表/,
  },
  {
    // 生命周期是「提示而非拦截」。若哪天有人把它写成硬门（例如认不出就
    // 当成 removed），未记录的模型会被集体误报弃用——这条守住那个边界。
    name: 'an unrecorded model is reported as deprecated',
    runner: 'baseline',
    file: 'src/model-catalog.ts',
    from: "    lifecycle: entry.lifecycle ?? 'active',",
    to: "    lifecycle: entry.lifecycle ?? 'deprecated',",
    expect: /未记录的模型一律 active，不误报弃用/,
  },
]

const RUNNERS = {
  contracts: { script: 'scripts/verify-ui-contracts.mjs', build: false },
  // The canvas's bottom chrome (dock / zoom dock / minimap) is a layout
  // question that only a real browser can answer: jsdom has no layout engine,
  // and `.canvasChrome` wraps based on the PANEL's width, which no media query
  // measures. No rebuild: the guard reads the stylesheet and the component.
  'canvas-layout': { script: 'scripts/verify-canvas-layout.mjs', build: false },
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
  // 信号账本与聚合器都是纯函数 + 临时目录，直接从源码 import，不需要构建。
  signals: { script: 'scripts/smoke-signals.mjs', build: false },
  // 身份锚定的规则也是纯函数，直接从源码 import。
  cast: { script: 'scripts/smoke-cast.mjs', build: false },
  // 穿戴的两份套件都从源码 import（canvas / FileReader 由套件自己打桩），
  // 不需要构建。它们同属一个组，但跑的是两个文件：单个 runner 只能挂一个
  // script，所以 case 上可以用 `script` 覆盖默认值 —— 组名进 test:negative
  // 的链条守卫只认 runner 名，多一个组就要多一行调用，两组反而更容易漏。
  outfit: { script: 'scripts/smoke-outfit-reference.mjs', build: false },
  // GIF 输出是纯请求体问题：套件自己打桩 fetch，直接 import src/engine.ts，
  // 不发真实请求也不需要构建。
  gif: { script: 'scripts/smoke-gif-output.mjs', build: false },
  // Google 原生协议同 GIF：纯请求体问题，套件打桩 fetch 直接 import src，
  // 零网络零构建。
  'google-native': { script: 'scripts/smoke-google-native.mjs', build: false },
  // 千问生图 API 同样是纯请求体/轮询桩，套件直接 import src，无需构建。
  'qwen-draw': { script: 'scripts/smoke-qwen-draw.mjs', build: false },
  // 内置模型基线表：纯函数，直接 import src，零网络零构建。
  baseline: { script: 'scripts/smoke-model-baseline.mjs', build: false },
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
  // A case may run a different suite from its group's default. The outfit
  // group has two suites (gallery trust boundary, reference sheet) and one
  // group name, because the chain guard below counts RUNNERS keys against
  // `test:negative` — every extra group is another line that can be forgotten.
  const script = testCase.script ?? runner.script
  freshCopy(runner.git === true)
  const baseline = run(script)
  if (!baseline.ok) {
    results.push({ name: testCase.name, verdict: 'HARNESS BROKEN', detail: baseline.out.slice(-3000) })
    continue
  }
  try {
    patch(testCase.file, testCase.from, testCase.to)
    // Some defects are only reachable once an UNRELATED invariant is kept
    // intact. `package.json` carries the version that a guard compares against
    // `src/protocol.ts`, so bumping it alone makes that guard fire first and the
    // case reports RED for a reason it never meant to test. `also` applies the
    // rest of the mutation so the case can reach the check it is about.
    for (const extra of testCase.also ?? []) patch(extra.file, extra.from, extra.to)
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

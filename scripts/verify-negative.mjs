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
    expect: /data-quick-card|empty canvas shows the six quick-start cards/,
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
    // 1.30.x 的真机回归：按住空格/Control 时框选分支照样在 pointerdown 上
    // preventDefault + 抓指针。浏览器因此不再派发兼容 mousedown，而 d3-zoom
    // 只靠 mousedown 起平移——画布拖不动，节点拖动（自定义引擎）却正常。
    // 把让路条件去掉，正好恢复那个缺陷，两条断言必须变红。
    name: 'the marquee steals the pointer back from the pan gesture',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: "tool === 'select' && !temporaryPanTool",
    to: "tool === 'select'",
    expect: /holding Space leaves the pointer to d3-zoom|marquee yields the pointer/,
  },
  {
    // d3-zoom 默认拒绝带 ctrlKey 的拖拽（当成捏合缩放），所以 Control 必须
    // 出现在 panActivationKeyCode 里，快捷键表的「Ctrl/⌘ + Space」才成立。
    // 退回只写 Space，源码不变式必须变红。
    name: 'the pan activation keys forget Control',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: "panActivationKeyCode={['Space', 'Control']}",
    to: 'panActivationKeyCode="Space"',
    expect: /both Space and Control as pan activation keys/,
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
  // ---------------------------------------- history list vs the shell handoff
  {
    // DSH 0.2.2's sidebar listens for `wheel` on an ancestor of the history
    // host and, for anything that is not its own session tree, calls
    // preventDefault() and scrolls that (in the studio: invisible) tree. Drop
    // the host's stopPropagation and the event reaches that listener again —
    // the reported "the list will not scroll, the session records scroll".
    name: 'a wheel over the history list falls through to the shell handoff',
    runner: 'smoke',
    file: 'src/client/sidebar-entry.ts',
    from: "  host.addEventListener('wheel', (event) => { event.stopPropagation() })",
    to: "  host.addEventListener('wheel', () => {})",
    expect: /never reaches the shell handoff|claims its own wheel events/,
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
  {
    // The reported defect itself: `submitShot` never asks who is pinned. Every
    // other symbol in the handler still exists, so only the wiring assertion in
    // P9 can see it -- which is why P9 checks the call, not the imports.
    name: 'a storyboard shot stops looking for pinned identities',
    runner: 'storyboard',
    file: 'src/client/CanvasWorkspace.tsx',
    from: '    const castNodes = castRefsFor(current, [])',
    to: '    const castNodes = []',
    expect: /分镜要取被钉住的参考图/,
  },
  {
    // Same defect, one layer out and much more dangerous: the reference nodes
    // are collected and then thrown away, so the request still says
    // `mode: reference` and carries no image. A static check cannot tell the
    // two apart (every symbol is still there), which is exactly why SB5 reads
    // the request body the host received.
    name: 'a storyboard shot collects the pinned cast and drops it',
    runner: 'canvas-video',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "    const usedCast = plan.mode === 'reference' ? castNodes.slice(0, plan.castSlots) : []",
    to: '    const usedCast = []',
    expect: /SB5: the run reached the host|SB5: the pinned image itself travels/,
  },
  {
    // The off-by-one this round found: the prompt said 参考图 0, a reference the
    // model does not have. A reader skims past it; the model reads it as an
    // instruction about nothing.
    name: 'the identity sentence numbers its references from zero',
    runner: 'canvas-video',
    file: 'src/client/CastDialog.tsx',
    from: '  return tt(castPromptKey(member.role), { index: index + 1, name: member.name })',
    to: '  return tt(castPromptKey(member.role), { index, name: member.name })',
    expect: /SB5: the prompt says which reference is who/,
  },
  {
    // The dead-code defect a screenshot found: the board narrowed its length
    // picker "to the model", but no model ever reached it for a board that
    // names none, so `catalog` was undefined on every real board and all seven
    // lengths were offered regardless. Every source-level assertion stayed
    // green because the narrowing call was still there — it was just always
    // fed `undefined`. Only SB6, which reads the rendered <option> list, sees it.
    //
    // The injected defect drops the FALLBACK, which is the half that mattered:
    // a board naming its own model still narrows (that path is untouched), so
    // deleting the prop alone is not enough to reach the bug.
    name: 'the board ignores the model its shots will run on',
    runner: 'canvas-video',
    file: 'src/client/canvas/storyboard-board.tsx',
    from: "  const effectiveModel = named !== '' ? named : (props.defaultVideoModel ?? '').trim()",
    to: "  const effectiveModel = named",
    // The resolution line is the one that can ONLY pass when a model reached the
    // render: the fixture default is a 720P-only id, so a board that sees it
    // offers one tier and a board that sees nothing offers all four. The length
    // lines above it also go red, but they go red for a weaker reason (the
    // "no declared durations" fallback happens to be a longer list too).
    expect: /SB6: the board follows the 720P-only model it will actually run on/,
  },
  // -------------------------------------------------------- storyboard-spec
  {
    // Dropping the performance margin turns the rule into "a shot must be as
    // long as the words take", which is exactly the clip that cuts off
    // mid-sentence: the actor gets no room to breathe or react. S9 names it.
    name: 'the speech rule forgets the performance margin',
    runner: 'storyboard-spec',
    file: 'src/client/storyboard.ts',
    from: '  const required = speech + SPEECH_MARGIN_SECONDS',
    to: '  const required = speech',
    expect: /4 s of speech needs 6 s/,
  },
  {
    // Putting the old five-value list back is the reported limitation itself:
    // an 8-15 s paragraph with two cuts inside it becomes unwritable, and the
    // picker silently offers nothing above ten seconds. S12 has to say so.
    name: 'the shot length list stops at ten seconds again',
    runner: 'storyboard-spec',
    file: 'src/client/storyboard.ts',
    from: 'export const SHOT_SECONDS = [4, 5, 6, 8, 10, 12, 15] as const',
    to: 'export const SHOT_SECONDS = [4, 5, 6, 8, 10] as const',
    expect: /12 s is offered/,
  },
  {
    // The ceiling is the ONLY thing keeping a board with nine pinned identities
    // from sending nine reference images: the providers reject the body, and
    // the four that matter get diluted on the way. S16 pins it.
    name: 'a shot is allowed to carry more references than the provider takes',
    runner: 'storyboard-spec',
    file: 'src/client/storyboard.ts',
    from: '  const castSlots = Math.max(0, Math.min(MAX_SHOT_REFERENCES, Math.floor(input.castCount)))',
    to: '  const castSlots = Math.max(0, Math.floor(input.castCount))',
    expect: /never more than four/,
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
  {
    // 用户报的那个缺陷：菜单点开就挂在底栏上，只有点「运行工作流」能带它走。
    // 把工作流菜单从统一清单里摘出去，就等于回到「关闭清单各写一份」的状态，
    // 断言必须按名字说出这件事，而不是笼统地报某处不匹配。
    name: 'the workflow options menu is dropped from the shared close list',
    runner: 'workflow',
    file: 'src/client/CanvasWorkspace.tsx',
    from: 'setBackgroundMenu(null); setImageMenu(null); setWorkflowMenu(null); setAddMenu(null)',
    to: 'setBackgroundMenu(null); setImageMenu(null); setAddMenu(null)',
    expect: /底栏浮层的关闭清单必须只有一处，且含工作流选项菜单|setWorkflowMenu 必须出现在唯一的关闭清单里/,
  },
  {
    // 同一类缺陷的另一种形状：清单还在，但某个入口又自己抄了一份。抄一份就
    // 意味着下一次加浮层会漏一处——这次漏的就是工作流菜单本身。
    name: 'a close path writes its own parallel list again',
    runner: 'workflow',
    file: 'src/client/CanvasWorkspace.tsx',
    from: "    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null)\n    closeDockMenus()",
    to: "    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null)\n    setBackgroundMenu(null); setImageMenu(null)",
    expect: /关闭清单被抄了 2 份/,
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
    // 分镜设置条退回「三格等分」：`flex: 1` 的 basis 是 0，三格平分 364px，
    // 「镜头衔接」那一格只剩 65px，而它的选项文案需要 94px（英文 186、俄文
    // 203），用户在下拉里看到的是「接上一…」——偏偏下面那条警告说的正是
    // 「接上一镜会丢身份参考」。只有真浏览器量得出这件事：原生 select 不报
    // overflow，源码里每个类都还在。
    name: 'the storyboard settings row goes back to three equal columns',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: [
      '  flex-wrap: wrap;\n  row-gap: 6px;\n}',
      '  flex: 1 1 auto;\n  min-width: 0;\n  display: flex;',
      '  flex: 0 1 auto;\n  min-width: 0;\n  height: 26px;',
    ],
    to: [
      '  flex-wrap: nowrap;\n}',
      '  flex: 1;\n  min-width: 0;\n  display: flex;',
      '  flex: 1;\n  min-width: 0;\n  height: 26px;',
    ],
    expect: /truncated label/,
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
    // 低缩放的那一圈补偿轮廓如果被挪到 `border-width` 上，卡片的**世界外框**
    // 会随缩放变胖，而连线锚点 / 吸附 / 缩略图投影全部按 `node.width` 算。
    // 几何错位在截图上看不出来（线还连着），只有这条断言能抓住。
    name: 'the low-zoom outline is painted as a border (enters layout)',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.root[data-zoom-band="far"] .node:not(.nodeSelected):not(.nodeRelated):not(.nodeConnectTarget):not(.nodeOverlap) {\n  box-shadow: var(--dsw-shadow-lv2), inset 0 0 0 calc(1.5px * var(--canvas-inv-scale, 1)) var(--canvas-node-edge-far);\n}',
    to: '.root[data-zoom-band="far"] .node:not(.nodeSelected):not(.nodeRelated):not(.nodeConnectTarget):not(.nodeOverlap) {\n  border-width: calc(1.5px * var(--canvas-inv-scale, 1));\n}',
    expect: /no compensating outline/,
  },
  {
    // 状态优先级的反向：低缩放的通用规则盖住了选中态，「哪个节点被选中」就
    // 被「这是一张卡片」压过去了。用户点了一张卡、看不到它被选中。
    name: 'the low-zoom outline overrides the selected state',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.root[data-zoom-band="far"] .node:not(.nodeSelected):not(.nodeRelated):not(.nodeConnectTarget):not(.nodeOverlap) {',
    to: '.root[data-zoom-band="far"] .node {',
    expect: /painted over a SELECTED card/,
  },
  {
    // 缩略图退回「图 = 黑块 / 文本 = 灰块」两色：草稿和产物又分不开了。
    name: 'the minimap loses the sketch / product distinction',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.minimapKindSketch {\n  background: color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent);\n  border: 1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent);\n}',
    to: '.minimapKindSketch {\n  background: var(--dsw-alias-label-primary);\n}',
    expect: /same block on the minimap/,
  },
  {
    // 空节点填实：一版还没产出的画布在缩略图上和「全都做完了」一模一样。
    name: 'an empty minimap block paints as produced',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.minimapNode[data-state="empty"] {\n  background: transparent;\n  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-primary) 38%, transparent);\n}',
    to: '.minimapNode[data-state="empty"] {\n  background: var(--dsw-alias-label-primary);\n}',
    expect: /EMPTY minimap block is filled/,
  },
  {
    // 连线消失：缩略图只剩一堆方块，回答不了「流程长什么样」。
    name: 'the minimap stops drawing connections',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.minimapEdge {\n  stroke: var(--dsw-alias-label-primary);\n  stroke-opacity: 0.28;\n  stroke-width: 1.2;',
    to: '.minimapEdge {\n  stroke: var(--dsw-alias-label-primary);\n  stroke-opacity: 0.28;\n  stroke-width: 0;',
    expect: /draws no connection lines/,
  },
  {
    // 两种运行痕迹合成一色：用户看到一片红，不知道该重试哪个节点、也不知道
    // 哪个是「根本没跑」。这条只有真浏览器算得出合成后的颜色。
    name: 'failed and skipped nodes share one run-mark colour',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.runMark[data-run-mark="blocked"] {\n  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 18%, var(--dsw-alias-bg-layer-1));\n  color: var(--dsw-alias-state-warn-primary, #f59e0b);\n}',
    to: '.runMark[data-run-mark="blocked"] {\n  background: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-label-primary-foreground, #fff);\n}',
    expect: /same chip|resolve to the same/,
  },
  {
    // 两种痕迹只剩颜色差别：缩到 40% 时颜色先糊成一片，线型是最后一层信息。
    name: 'run marks lose their border-style distinction',
    runner: 'canvas-layout',
    file: 'src/client/canvas-workspace.module.css',
    from: '.nodeRunBlocked {\n  border-style: dashed;',
    to: '.nodeRunBlocked {\n  border-style: solid;',
    expect: /do not use different border styles/,
  },
  {
    // 就绪徽标退回「永远只显示缺提示词」。用户明明连了一条有内容的文本节点，
    // 卡片还说「缺提示词」——那比没有徽标更糟：它让人怀疑自己写的东西没进去。
    name: 'the readiness badge ignores connected prompts',
    runner: 'smoke',
    file: 'src/client/canvas/readiness.ts',
    // 注意转义：这里的 `\\n` 是源码里的两个字符，不是换行。写成 `\n` 的话
    // 锚点会变成一个真换行，而源码里那个位置是 `join('\n')` 的字面量——
    // 结果就是 anchor not found，被报成 HARNESS BROKEN，看起来像套件坏了。
    //
    // 锚点跟着实现走过一次：取值顺序现在是「活动编辑 → 节点持久值 → 上游」，
    // 三段的判定本身才是这条用例要测的东西，所以整条链都留在 `from` 里——
    // 只截最后一段 `own : upstream` 的话，将来再插入一个来源又会失配。
    from: "  const prompt = composer !== '' ? composer : own !== '' ? own : upstream.join('\\n')",
    to: "  const prompt = composer !== '' ? composer : own",
    expect: /clear the missing-prompt blocker/,
  },
  {
    // 整理画布把「从没接线的散卡」当成第一层：它们排在流程源头前面，真正的
    // 起点被淹没在一堆还没接线的卡片里。A4/A5 必须变红。
    name: 'arrange canvas mixes unwired cards into the first column',
    runner: 'geometry',
    file: 'src/client/canvas/arrange-model.ts',
    from: "  const flow = visualOrder.filter(node => wired.has(node.id))",
    to: '  const flow = visualOrder',
    expect: /parked|落在流程下方/,
  },
  {
    // 标注卡被当成上游提示词：那些是给图上某个局部写的备注，混进提示词会变成
    // 一句莫名其妙的注释，而用户找不到它是从哪来的。
    name: 'the canvas forwards annotation-card text as a prompt',
    runner: 'geometry',
    file: 'src/client/canvas/readiness.ts',
    from: "        .filter(candidate => candidate.type === 'text' && candidate.metadata?.annotation === undefined)",
    to: "        .filter(candidate => candidate.type === 'text')",
    expect: /标注卡/,
  },
  {
    // 「被跳过」和「失败」合成一条红：用户看到一片红，不知道该点谁的重试，
    // 或者会去重试一个根本没跑过的节点。F1 必须变红。
    name: 'run marks collapse failed and skipped into one',
    runner: 'geometry',
    file: 'src/client/canvas/run-marks.ts',
    from: "  if (marks.failed.has(nodeId)) return 'failed'\n  if (marks.blocked.has(nodeId)) return 'blocked'",
    to: '  if (marks.failed.has(nodeId) || marks.blocked.has(nodeId)) return \'failed\'',
    expect: /失败与被跳过是两种标记/,
  },
  {
    // 取消时把「按停之前就已经失败」的节点一起洗成好的：用户按了一次停，
    // 屏幕上那些已知的坏结果就不再有任何标记，而它们确实还是坏的。
    name: 'a cancelled run washes away failures that already happened',
    runner: 'geometry',
    file: 'src/client/canvas/run-marks.ts',
    from: "  if (result.status === 'completed' || result.status === 'cycle') return EMPTY_RUN_MARKS",
    to: '  if (result.status !== \'failed\' && result.status !== \'partial\') return EMPTY_RUN_MARKS',
    expect: /取消.*保留|取消会保留/,
  },
  {
    // 单节点重试把下游的「没跑」标记也一起清了：那个节点从此既没有产物、
    // 也没有任何标记，看起来像是跑过了。
    name: 'retrying one node also clears its blocked downstream',
    runner: 'geometry',
    file: 'src/client/canvas/run-marks.ts',
    from: '  return { failed, blocked: marks.blocked }',
    to: '  return { failed, blocked: new Set() }',
    expect: /仍然存在|被跳过的下游不动/,
  },
  {
    // 空 asset 的图片节点被算成参考图：画布上每个新建的空图片卡都会让菜单
    // 声称「这次是图生图」，而提交路径一张参考图都拿不到。
    name: 'an empty image node counts as a reference',
    runner: 'geometry',
    file: 'src/client/canvas/readiness.ts',
    from: "      referenceCount: upstream.filter(candidate => candidate.type === 'image' && (candidate.metadata?.asset?.url ?? '') !== '').length,",
    to: "      referenceCount: upstream.filter(candidate => candidate.type === 'image').length,",
    expect: /空 asset 的图片节点不算参考图|不算参考图/,
  },
  {
    // 环被当成「没有依赖」直接排：画布会得到一张井然有序、却根本跑不起来的图，
    // 而用户没有任何线索说明为什么「运行工作流」报环。
    name: 'arrange canvas lays out a cyclic graph instead of refusing',
    runner: 'geometry',
    file: 'src/client/canvas/arrange-model.ts',
    from: '  if (plan.cycle.length > 0) return { ok: false, cycle: plan.cycle }',
    to: '  void plan.cycle',
    expect: /环|cycle/,
  },
  {
    // 层内按「边的插入顺序」排而不是用户的上下顺序：他有意放在上面那张卡被
    // 挪到下面。这条只在几何层看得见，界面上只会显得「整理不听话」。
    name: 'arrange canvas ignores the order the user placed things in',
    runner: 'geometry',
    file: 'src/client/canvas/arrange-model.ts',
    from: '    const layer = [...planned].sort((a, b) => (visualRank.get(a) ?? 0) - (visualRank.get(b) ?? 0))',
    to: '    const layer = [...planned]',
    expect: /原来在上面的那个整理后还在上面/,
  },
  {
    // 只搜标题、不搜同义词与说明：目录立刻退化成「你得先知道它叫什么」。而用户
    // 打开这张表的**原因**恰恰是他不知道。C3/C4 必须变红。
    name: 'the catalog searches only the row titles',
    runner: 'geometry',
    file: 'src/client/canvas/capability-catalog.ts',
    from: '      const haystack = [translate(entry.labelKey), translate(entry.hintKey), ...entry.keywords]',
    to: '      const haystack = [translate(entry.labelKey)]',
    expect: /接片|同义词|排版|缩略图|英文同义词/,
  },
  {
    // 「不可用」退回「不显示」：用户搜「撤销」得到空列表，于是认为这张画布没有
    // 撤销——而他真正需要的只是先改点什么。C6 必须变红（数量对不上）。
    name: 'the catalog hides actions that cannot run right now',
    runner: 'geometry',
    file: 'src/client/canvas/capability-catalog.ts',
    from: '    matched.push({ entry, blockedBy: entry.blocked?.(context) ?? null })',
    to: '    const blockedBy = entry.blocked?.(context) ?? null\n    if (blockedBy !== null) continue\n    matched.push({ entry, blockedBy })',
    expect: /藏起来|不可用的项被藏起来|一条都不能少/,
  },
  {
    // 方向键停在灰行上：按回车什么都不发生，而用户以为是自己按错了键。这正是
    // 「灰行占着坑」这件事唯一的可见症状，C7 守它。
    name: 'arrow keys stop on rows that cannot run',
    runner: 'geometry',
    file: 'src/client/canvas/capability-catalog.ts',
    from: '  return sections.flatMap(section => section.items).filter(item => item.blockedBy === null)',
    to: '  return sections.flatMap(section => section.items)',
    expect: /方向键|撤销是灰的/,
  },
  {
    // 分组里把灰行排到前面：一屏里最先看到的几行全是按不动的，用户会以为整张表
    // 都不能用。C6 的组内顺序断言守它。
    name: 'blocked rows sort above the ones that work',
    runner: 'geometry',
    file: 'src/client/canvas/capability-catalog.ts',
    from: '    items.sort((a, b) => Number(a.blockedBy !== null) - Number(b.blockedBy !== null))',
    to: '    items.sort((a, b) => Number(b.blockedBy !== null) - Number(a.blockedBy !== null))',
    expect: /排在了灰行后面/,
  },
  {
    // 整理之后视口跟着跑：用户按下按钮的瞬间可见内容全部飞出屏幕，看起来像
    // 一次误点。contracts 组守的正是这条「动作副作用」。
    name: 'arrange canvas drags the viewport along',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "    setNotice(result.parked > 0\n      ? tt('canvas.arrangeDoneParked', { columns: result.columns, parked: result.parked })\n      : tt('canvas.arrangeDone', { columns: result.columns }))",
    to: "    setViewport({ ...current.viewport })\n    setNotice(result.parked > 0\n      ? tt('canvas.arrangeDoneParked', { columns: result.columns, parked: result.parked })\n      : tt('canvas.arrangeDone', { columns: result.columns }))",
    expect: /moves the viewport as well/,
  },
  {
    // 取消分支忘了落痕：按停之前已经失败的节点被静默洗成好的，而它们的产物
    // 确实不可用。纯函数对、接线漏，是这条功能最可能的坏法。
    name: 'cancelling swallows the failures that already happened',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "      if (result.status === 'cancelled') {\n        // 取消本身不是失败，但「按停之前就已经失败」的节点是真的坏了，它们的\n        // 产物不可信。因此这里照样落痕——理由是「产物能不能用」，不是「这次\n        // 运行怎么结束的」。抹掉它们等于因为一次取消把已知的坏结果洗成好的。\n        setRunMarks(runMarksFrom(result))\n        setNotice(tt('canvas.workflow.cancelled'))",
    to: "      if (result.status === 'cancelled') {\n        setNotice(tt('canvas.workflow.cancelled'))",
    expect: /取消 \/ 失败 \/ 部分成功|有运行结局没有写进画布状态/,
  },
  {
    // 目录里多出一行、没人接：它长得和别的一模一样，按下去什么都不发生，用户
    // 会以为「这个功能不存在」。契约组最后一条断言守的正是这张表和目录的对齐。
    name: 'a catalog row is listed but left unwired',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "    'help.shortcuts': () => setShortcutHelpOpen(true),",
    to: "    'help.shortcuts.disabled': () => setShortcutHelpOpen(true),",
    expect: /no action|wires ids the catalog does not list|unwired/,
  },
  {
    // 目录不关就执行：动作真的跑了，但结果被那张弹窗盖着，用户看到的是「点了，
    // 屏幕没动」。这是「接线对了但体验是死的」那一类缺陷。
    name: 'the catalog stays open while the action runs',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '  const runCatalogItem = useCallback((id: CapabilityId): void => {\n    setCatalogOpen(false)',
    to: '  const runCatalogItem = useCallback((id: CapabilityId): void => {',
    expect: /closes before running|no longer closes/,
  },
  {
    // 顶栏退回「文件管理」：四枚低频动作重新平铺，标题在窄面板被挤到第二行。
    // 真浏览器只看得到「换行了」，看不出是谁挤的；这条守的是布局的**意图**。
    name: 'file management buttons grow back onto the top bar',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '        name="more"\n        label={tt(\'canvas.canvasMenu\')}',
    to: '        name="favorite"\n        label={tt(\'canvas.favoriteCanvas\')}',
    expect: /file management is back in the top bar/,
  },
  {
    // 保存状态被 spacer 推回顶栏另一头：它与标题读不成一句话，而 760px 以下
    // 顶栏一换行，的那枚橙色「未保存」会孤零零落在第二行最右边。
    name: 'the save state drifts away from the canvas title',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "<span className={css.saveState} data-state={document?.id === '' ? 'draft' : saveState}>",
    to: "<span className={css.topBarSpacer} /><span className={css.saveState} data-state={document?.id === '' ? 'draft' : saveState}>",
    // 这条注入把「状态紧跟在标题后」的结构拆开：正则要求 titleButton 之后、
    // spacer 之前出现 saveState，注入后中间多了一个 spacer，不再匹配。
    expect: /save state drifted away/,
  },
  {
    // 运行前预告退回「只数不给原因」：菜单说「有 2 个节点不行」，用户不知道
    // 是缺提示词还是缺钥匙，只能一个个点开找。属性一没有，smoke 里那条
    // 「说清卡在哪」的断言就必须红。
    name: 'the run menu counts blocked configs without naming the cause',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: ' data-workflow-blocked={props.firstBlocker ?? \'\'}',
    to: '',
    expect: /data-workflow-blocked/,
  },
  {
    // 那个假输入框回来：配置节点又长出一个写 `metadata.text` 的 textarea，
    // 而没有任何路径读它。用户写进去的提示词被静默丢弃，旁边还挂着「可生成」。
    //
    // 用 contracts 而不是 smoke：这个缺陷是**结构**问题（多了一个不该存在的
    // 编辑入口），不是渲染时序问题，源码级断言就够。走 smoke 的话每验一次要
    // 重建 + 跑整个 jsdom 套件，还会和别的用例抢内存（曾经整条链被 SIGKILL，
    // 报成 HARNESS BROKEN，看起来像套件坏了）。
    name: 'a config node grows a second, discarded prompt editor',
    runner: 'contracts',
    file: 'src/client/canvas/node-body.tsx',
    from: '        <p className={css.configPrompt} data-config-prompt={node.id}>\n          {configReady !== null && configReady.prompt !== \'\'\n            ? configReady.prompt\n            : tt(\'canvas.configPromptElsewhere\')}\n        </p>',
    to: '        <textarea className={css.configPrompt} data-config-prompt={node.id} value={metadata.text ?? \'\'} onChange={event => A.patchNode(node.id, { text: event.target.value })} />',
    expect: /renders an editable prompt input/,
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
    from: '  const style = getComputedStyle(seat)\n  const left = style.marginLeft\n  const right = style.marginRight\n',
    to: "  const style = getComputedStyle(seat)\n  const inset = style.getPropertyValue('--dsh-sidebar-paint-inset').trim() || '3px'\n  const left = inset === '3px' ? '4px' : inset\n  const right = inset === '3px' ? '4px' : inset\n",
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
  // ------------------------------------------- #47 Magpie 图像模型发现
  {
    // issue #47 的核心：Magpie 的 /v1/models 只给聊天模型，图像条目在
    // `?kind=image` 后面。退回「图像发现复用普通列表」——也就是它修掉的那个
    // 缺陷——图像恒为 0，「检测模型」绿灯但一个生图模型都列不出来。
    name: 'image discovery falls back to the plain model list',
    runner: 'magpie',
    file: 'src/prompt-enhancer.ts',
    from: '  const protocol = resolveChannelProtocol(config.apiUrl.trim(), config.protocol)\n  if (protocol === \'google-native\' || protocol === \'qwen-draw\') return listModelRecords(config)',
    to: '  const protocol = resolveChannelProtocol(config.apiUrl.trim(), config.protocol)\n  if (protocol !== \'__never__\') return listModelRecords(config)',
    expect: /图像发现先问图像作用域的列表|Magpie 的 kind:image 条目应被发现/,
  },
  {
    // 老版本 Magpie 认这个头，不看查询参数。去掉它，那批版本上图像发现仍然为 0，
    // 而新版本照常工作——回归会只在老网关上出现，最难被发现。
    name: 'the legacy Magpie drawer header disappears',
    runner: 'magpie',
    file: 'src/prompt-enhancer.ts',
    from: "    requestHeaders['X-Magpie-Drawers'] = '1'",
    to: "    requestHeaders['X-Magpie-Drawers-Disabled'] = '1'",
    expect: /老版本 Magpie 靠这个头返回图像条目/,
  },
  {
    // Magpie 的图像条目不带标准 output_modalities，只带 kind 或嵌套 modalities。
    // 去掉 kind 判定，只留标准字段的网关不再被发现。
    name: 'the Magpie kind:image shape stops being recognised',
    runner: 'magpie',
    file: 'src/prompt-enhancer.ts',
    from: "  if (typeof record.kind === 'string' && record.kind.trim().toLowerCase() === 'image') return true",
    to: "  if (typeof record.kind === 'string' && record.kind.trim().toLowerCase() === '__image__') return true",
    expect: /kind:"image" 单独就能识别/,
  },
  {
    // 网关静默忽略未知参数时，作用域列表会原样返回全量（且可能一条图像模型都
    // 认不出）。不回退到普通候选，结果就是空列表——「检测成功但 0 个模型」。
    name: 'a gateway that ignores kind=image yields an empty list',
    runner: 'magpie',
    file: 'src/prompt-enhancer.ts',
    from: '  if (scoped.some(isImageModelRecord)) return scoped',
    to: '  return scoped',
    expect: /作用域列表返回空数组时回退/,
  },
  // ------------------------------------------- #48 非 JSON 报错可诊断
  {
    // issue #48：旧文案只有 `（HTTP 404）`，既没有请求地址，也没说返回的是网页。
    // 换成一句只有状态码的话，用户拿不到任何自查线索。
    name: 'a non-JSON failure loses the request address',
    runner: 'diagnosis',
    file: 'src/upstream-diagnosis.ts',
    from: '  const address = requestAddress(input.url)\n  const head = `${input.label}返回了非 JSON 响应（HTTP ${input.status}, ${type}）：${address}`',
    to: '  const address = requestAddress(input.url)\n  const head = `${input.label}返回了非 JSON 响应（HTTP ${input.status}）：${address.replace(/.*/, \'\')}`',
    expect: /消息要点名实际请求的地址/,
  },
  {
    // HTML 被当成普通文本时，最可操作的那句「少了 /v1」不会出现，
    // 用户看到的只是一段被截断的网页源码。
    name: 'an HTML body stops being named as a webpage',
    runner: 'diagnosis',
    file: 'src/upstream-diagnosis.ts',
    from: '    return `${head} —— 返回的是网页而不是接口响应，通常说明渠道的 API 地址少了路径（例如末尾缺 /v1）或填成了站点首页`',
    to: '    return `${head} —— 返回的内容无法解析，通常说明渠道的 API 地址少了路径（例如末尾缺 /v1）或填成了站点首页`',
    expect: /要点出返回的是网页/,
  },
  {
    // query 里可能带密钥（`?api_key=`）。把它拼回报错，等于把凭据写进截图和
    // issue 正文。
    name: 'the request address keeps its query string',
    runner: 'diagnosis',
    file: 'src/upstream-diagnosis.ts',
    from: '    return `${parsed.origin}${parsed.pathname}`',
    to: '    return parsed.toString()',
    expect: /query 里可能有密钥，报错不带/,
  },
  {
    // 这条守门自己就差点假绿过三次（见文件头）：注释掉的赋值、字符串字面量、
    // 「恢复原值」都被当成过隔离证据。把最常见的那一种注入回去——把真正的
    // mkdtempSync 赋值注掉——守门必须报红，否则它就是一个永远绿的摆设。
    name: 'a canvas test script stops isolating its data root',
    runner: 'isolation',
    file: 'scripts/smoke.mjs',
    from: "process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-'))",
    to: "// process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-'))",
    expect: /会写画布，却没有把数据目录指到临时目录/,
  },
  // ------------------------------------------- 空态示例链（example）
  {
    // 中心线不对齐：两个节点看起来像两张碰巧靠近的卡，而不是一条流程的两步。
    // 这条只在几何层看得见——界面上它「也没坏」，只是读起来不对。
    name: 'the example pair is not centred on one line',
    runner: 'example',
    file: 'src/client/canvas/example-flow.ts',
    from: '  const textOffsetY = (CONFIG_NODE_SIZE.height - TEXT_NODE_SIZE.height) / 2',
    to: '  const textOffsetY = 0',
    expect: /中心线没对齐/,
  },
  {
    // 列间距自造一个数：整理画布排出来是 96，示例是 40。用户点一次「整理」，
    // 示例自己会挪位置——看起来像整理动了它不该动的卡。
    name: 'the example invents its own column gap',
    runner: 'example',
    file: 'src/client/canvas/example-flow.ts',
    from: '    x: origin.x - ARRANGE_GAP.x - TEXT_NODE_SIZE.width,',
    to: '    x: origin.x - 40 - TEXT_NODE_SIZE.width,',
    expect: /隔了 .*px|与整理画布同档/,
  },
  {
    // 连线方向反了：示例的「提示词喂给生成」变成「生成喂给提示词」，按下运行
    // 什么都不会发生，而画布上看起来完全正常。
    name: 'the example wires the config card into the prompt',
    runner: 'example',
    file: 'src/client/canvas/example-flow.ts',
    from: '    fromNodeId: textId,\n    toNodeId: configId,',
    to: '    fromNodeId: configId,\n    toNodeId: textId,',
    expect: /连线的起点不是文本节点|连线的终点不是配置节点/,
  },
  // ------------------------------------------- 画布体检（health）
  {
    // 环的下游被一起描红：用户顺着高亮找那根首尾相接的线，会找不到——被描红的
    // 那个节点根本不在环上。H3b 守它。
    name: 'the cycle report blames the downstream too',
    runner: 'health',
    file: 'src/client/canvas/graph-health.ts',
    from: '    const ring = nodesOnCycle(plan.cycle, live)\n    const nodeIds = (ring.length > 0 ? ring : plan.cycle).slice().sort(compareText)',
    to: '    const nodeIds = plan.cycle.slice().sort(compareText)',
    expect: /下游污染|不在环里|环上节点/,
  },
  {
    // 残线被当成有效连线：删掉一个上游之后，留在原地的图片不再算孤立产物，
    // 而它确实没人喂、也没接出去。H4 守它。
    name: 'a dangling edge still counts as a connection',
    runner: 'health',
    file: 'src/client/canvas/graph-health.ts',
    // 让残线「落进」有效连线：删掉那条 `continue`，它就会继续走到
    // `incoming.add(connection.toNodeId)`——那个指向已删除节点的残线于是
    // 把还活着的图片算成「有上游」，孤立产物再也报不出来。
    from: '      continue\n    }\n    live.push(connection)',
    to: '    }\n    live.push(connection)',
    expect: /残线|孤立/,
  },
  {
    // 未就绪的配置被报成「结构没问题」：菜单说能跑，按下去跳过整条分支，跑完
    // 显示「完成」——这是这条功能最坏的一种失败。H7 守它。
    name: 'a blocked config is not reported at all',
    runner: 'health',
    file: 'src/client/canvas/graph-health.ts',
    from: '    if (state === undefined || state.ready) continue',
    to: '    if (state === undefined || !state.ready) continue',
    expect: /blockedConfig|未就绪/,
  },
  {
    // 严重度排序反了：一条「这张图有环」排在「有张图没人用」后面，用户可能
    // 根本滚不到那条真正不能跑的。H8 守它。
    name: 'the blocking issues sort below the advisories',
    runner: 'health',
    file: 'src/client/canvas/graph-health.ts',
    from: '    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]',
    to: '    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]',
    expect: /kind 顺序|按固定顺序/,
  },
  // ------------------------------------------- 找节点（search）
  {
    // 空查询返回整张画布：下拉里列出上百张卡等于没有搜索，还会让下一次输入
    // 多等一帧渲染。S1 守它。
    name: 'an empty query lists the whole canvas',
    runner: 'search',
    file: 'src/client/canvas/node-search.ts',
    from: '  if (terms.length === 0) return []',
    to: '  if (terms.length === 0) return nodes.slice(0, 20).map(node => ({ nodeId: node.id, nodeType: node.type, snippet: node.title, field: \'title\', score: 60 }))',
    expect: /空查询|不该列出整张画布/,
  },
  {
    // 同一节点出两条结果：搜「猫」得到同一张卡的两行，用户还要自己分辨哪行
    // 才是那张图。S8 守它。
    name: 'one node yields two results from two fields',
    runner: 'search',
    file: 'src/client/canvas/node-search.ts',
    from: '      break\n    }\n  }',
    to: '      continue\n    }\n  }',
    expect: /只出一条结果|一个节点只出一条/,
  },
  {
    // 视口尺寸为 0 时照样相除：0/0 得 NaN，`.world` 的 transform 里一进 NaN，
    // 整块画布直接消失，控制台一个字都不吭。V5 守它。
    name: 'the viewport maths divides by a zero-sized viewport',
    runner: 'search',
    file: 'src/client/canvas/node-search.ts',
    from: '  if (!(viewportSize.width > 0) || !(viewportSize.height > 0)) {\n    return { k: safeCurrent, x: 0, y: 0 }\n  }',
    to: '',
    expect: /视口还没量出尺寸|NaN|有限数/,
  },
  {
    // 缩放不夹：一个 240×240 的小卡会被放大到十几倍，跳过去看到的是它的一角；
    // 一张超大画布会被缩到看不见。V3/V4/V8 守它。
    name: 'focusing a card ignores the zoom limits',
    runner: 'search',
    file: 'src/client/canvas/node-search.ts',
    from: '  const k = Math.min(maxScale, Math.max(minScale, fit))',
    to: '  const k = fit',
    expect: /夹在|无限放大|缩到看不见/,
  },
  // ---------------------------------- 多窗口保存的合并（merge）
  {
    // 只认「对方也改过」这一条，把「本地改过、对方没碰」也当成冲突：两边都在
    // 正常编辑时，任何一次并发保存都会弹冲突，用户被逼着选边丢掉自己刚做的改动。
    // M4 守它。
    name: 'a change only this window made is reported as a conflict',
    runner: 'merge',
    file: 'src/client/canvas/canvas-merge.ts',
    from: "    if (!theirsChanged) {",
    to: "    if (!theirsChanged && false) {",
    expect: /本地拖了一张卡|保留本地位置|false/,
  },
  {
    // 两边把同一处改成不同样子时挑一边：这就是原来的整图覆盖，换了形式而已。
    // 不在这时报冲突，用户的某一次编辑必然无声消失。M8 / M9 守它。
    name: 'a real conflict picks a side instead of reporting it',
    runner: 'merge',
    file: 'src/client/canvas/canvas-merge.ts',
    from: "    conflicts.push({ kind, id, subject: labelOf(mine) })\n    result.push(mine)\n  }",
    to: "    result.push(mine)\n  }",
    expect: /报冲突|不静默挑一边|true/,
  },
  {
    // 合并时把 revision 也一起换成自己的：宿主那边的乐观锁就永远拦不住第二次
    // 并发写入，冲突检测本身失效。M18 守它。
    name: 'the merged document invents its own revision',
    runner: 'merge',
    file: 'src/client/canvas/canvas-merge.ts',
    from: "      revision: theirs.revision,",
    to: "      revision: ours.revision,",
    expect: /revision|对方看到的那个/,
  },
  // ------------------------------------------- 三处接线的契约（contracts）
  {
    // 找节点不关弹窗就先跳：动作真的执行了，但结果被那张全屏遮罩盖着，用户
    // 看到的是「按了回车，屏幕没动」。
    name: 'find-node jumps while its own overlay still covers the canvas',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'onPick={(hit: NodeHit) => { setNodeSearchOpen(false); jumpToNode(hit.nodeId) }}',
    to: 'onPick={(hit: NodeHit) => { jumpToNode(hit.nodeId) }}',
    expect: /先关弹窗再跳过去|closes before jumping/,
  },
  {
    // 跳过去但不选中：用户被带到一张卡前，它和旁边每张长得一样，不知道自己
    // 刚才被带到了哪一张。
    name: 'find-node moves the viewport but selects nothing',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    setSelectedIds(new Set([nodeId]))\n    setSelectedConnectionId(null)\n  }, [mutate, setViewport, viewportSize, topBarHeight, chromeHeight])',
    to: '  }, [mutate, setViewport, viewportSize, topBarHeight, chromeHeight])',
    expect: /不再选中那张卡/,
  },
  {
    // 体检清单退回「只报不带路」：告诉用户三个节点绕成了环，然后让他在上百张
    // 卡里自己找。
    name: 'the check-up lists problems it will not take you to',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '              onClick={() => props.onJumpIssue(issue)}',
    to: '              onClick={() => undefined}',
    expect: /只报不带你去看/,
  },
  {
    // 示例拆成两次写：撤销一次只退半条示例，剩下的半条既跑不了也删不干净。
    name: 'the example lands in two separate edits',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...flow.nodes], connections: [...previous.connections, ...flow.connections] }))',
    to: '    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...flow.nodes] }))\n    mutate(previous => ({ ...previous, connections: [...previous.connections, ...flow.connections] }))',
    expect: /一次写入|half-applied/,
  },
  {
    // 空态的「载入示例」被拿掉：剩下五张卡都在要求用户先知道要放什么、怎么连，
    // 而第一次打开画布的人恰恰不知道。
    name: 'the empty canvas loses its load-an-example card',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '          <button type="button" className={css.quickCard} data-quick-card="example"',
    to: '          <button type="button" className={css.quickCard} data-quick-card="example-removed"',
    expect: /不再提供「载入示例」|load-an-example/,
  },
  {
    // 对齐逐节点写：撤销一次只退一张卡，用户得按 N 次才回到对齐前，而按到
    // 一半时画布既不是旧的也不是新的。契约守「一次 mutate」。
    name: 'alignment writes one undo step per card',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    if (result.moved === 0) { setNotice(tt(\'canvas.align.already\')); return }\n    mutate(',
    to: '    if (result.moved === 0) { setNotice(tt(\'canvas.align.already\')); return }\n    for (const node of current.nodes) { const next = result.positions.get(node.id); if (next !== undefined) mutate(previous => ({ ...previous, nodes: previous.nodes.map(item => item.id === node.id ? { ...item, x: next.x, y: next.y } : item) })) }\n    mutate(',
    expect: /一次 mutate|一次写入|one edit/,
  },
  {
    // 对齐条常驻：只选中一张卡时也出现，用户去点它，然后以为它坏了（一个节点
    // 没有可对齐的对象）。
    name: 'the align bar shows up even for a single node',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    {selectedNodeCount >= 2 ? <AlignBar',
    to: '    {selectedNodeCount >= 1 ? <AlignBar',
    expect: /对齐条|两张|two selected/,
  },
  {
    // 撤销按钮退回只说「撤销」：连按三次之后用户不知道自己退掉了哪一步。
    name: 'the undo button stops saying what it will take back',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'label={undoHint === null ? labelWithKeys(\'canvas.undo\') : tt(\'canvas.undo.step\', { step: undoHint })}',
    to: 'label={labelWithKeys(\'canvas.undo\')}',
    expect: /describeStep|撤销|undo/,
  },
  {
    // 接线时不把分组传进去：纯函数里「组是刚体」那 5 条单测照样全绿，画布上却
    // 每次只对齐组里被选中的那一张、把组拆开——两层各自都对，接起来是错的。
    name: 'the align wiring forgets the canvas groups',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'groups: groupsOf(current) }, mode)',
    to: 'groups: [] }, mode)',
    expect: /alignNodes|align-model/,
  },
  {
    // 输入条退回硬编码阈值：多选时对齐条 / 拼接条让底栏整行变高，输入条判定
    // 「下面放得下」就压在按钮上——真机截图里八枚对齐按钮全被盖住。
    name: 'the composer keeps its hard-coded flip threshold and covers the strips',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'const top = belowY > S.viewportSize.height + topOffset - (170 + S.chromeHeight)',
    to: 'const top = belowY > S.viewportSize.height + topOffset - 170',
    expect: /翻转判据|扣掉底栏|chromeHeight/,
  },
  {
    // chromeHeight 只量底栏那一格：两条药丸出现时没人重新量，输入条照旧压上去。
    name: 'the chrome height measurement ignores the strips above the dock',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    const tops = [...chrome.children]',
    to: '    const tops = [...chrome.children].slice(-1)',
    expect: /最高成员|量出来|chromeHeight/,
  },
  {
    // 历史面板点一行时不先关面板：跳转把画布换成了另一版，而面板还盖在上面，
    // 用户看不到自己退到了哪里，得再关一次才知道；下一次编辑还落在旧的地图上。
    name: 'a history row jumps with the panel still covering the canvas',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'onJump={(stepsBack, nodeIds) => { setHistoryOpen(false); jumpToHistoryStep(stepsBack, nodeIds) }}',
    to: 'onJump={(stepsBack, nodeIds) => { jumpToHistoryStep(stepsBack, nodeIds) }}',
    expect: /先关面板|history/,
  },
  {
    // 回退多步改成循环调用 undo()：栈是同步改的、document state 不是，中间的帧
    // 读到的 documentRef 还是旧的，最后落下的快照与用户点的那一行对不上。
    name: 'jumping back several steps loops undo instead of one document write',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    setDocument(restored)',
    to: '    setDocument(restored)\n    setDocument(restored)',
    expect: /一次文档替换|jumpToHistoryStep/,
  },
  {
    // 对齐快捷键退回 event.key：macOS 按住 Option 时 key 是组合字符（⌥F = ƒ），
    // 这条分支在真机上永远不成立，而单元测试和源码读起来都「有」这个快捷键。
    name: 'the align shortcuts go back to matching the composed character',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '      } else if (event.altKey && mod && ALIGN_SHORTCUTS[event.code] !== undefined) {',
    to: '      } else if (event.altKey && mod && ALIGN_SHORTCUTS[event.key] !== undefined) {',
    expect: /event\.code|physical code|对齐快捷键/,
  },
  {
    // 文案里又把键位写死：macOS 上用户按 ⌘D，读到的是 Ctrl+D；而目录按 labelKey
    // 反查时也读不到文案里的括号。契约组同时扫「有没有硬编码」和「查不查得到」。
    name: 'a menu label hard-codes the key instead of reading the shortcut table',
    runner: 'contracts',
    file: 'src/client/locales.ts',
    from: "  'canvas.duplicate': '创建副本',",
    to: "  'canvas.duplicate': '创建副本 (Ctrl+D)',",
    expect: /把键位写死|literal key/,
  },
  {
    // 目录的动作在快捷键表里只有 label、没有 action：目录拿 labelKey 去查，
    // 那一行就永远没有徽章，看起来像「这个动作没有快捷键」。
    name: 'a catalog action resolves to no key because the binding names another label',
    runner: 'contracts',
    file: 'src/client/ShortcutHelp.tsx',
    from: "      { keys: ['Ctrl/⌘', 'D'], label: 'canvas.shortcuts.duplicate', action: 'canvas.duplicate' },",
    to: "      { keys: ['Ctrl/⌘', 'D'], label: 'canvas.shortcuts.duplicate' },",
    expect: /查不到|no shortcut/,
  },
  {
    // 右键菜单那一枚退回写死的文案：它和目录是同一个动作，键位却各写一份。
    name: 'the context menu writes its own copy of the duplicate key',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "items.push({ label: S.labelWithKeys('canvas.duplicate'), icon: 'duplicate', action: () => A.duplicateNode(contextMenu.nodeId) })",
    to: "items.push({ label: tt('canvas.duplicate'), icon: 'duplicate', action: () => A.duplicateNode(contextMenu.nodeId) })",
    expect: /创建副本|快捷键表|reads the same table/,
  },
  {
    // 按下对齐什么都不写：按钮、文案、读数全对，只有画布没变——用户看到的唯一
    // 证据是「点了没反应」。这一条只有真正驱动 UI 的套件看得见（契约读源码，
    // 它只关心「有没有那一次 mutate」），所以挂在 smoke 组。
    name: 'the align button announces success and writes nothing',
    runner: 'smoke',
    file: 'src/client/canvas',
    from: '    if (result.moved === 0) { setNotice(tt(\'canvas.align.already\')); return }',
    to: '    if (result.moved === 0) { setNotice(tt(\'canvas.align.already\')); return }\n    if (result.moved > 0) { setNotice(tt(\'canvas.align.done\', { count: result.moved })); return }',
    expect: /align-left puts both cards on the same x/,
  },
  // ------------------------------------------- 层级顺序（layer order）
  //
  // 四件事各自会让「置顶 / 置底」在界面上坏成不同的样子，而且全都长得对：
  // 按钮在、点得动、有时候还真的动了。
  {
    // 逐节点写：撤销一次只退一张卡的层级。选中三张卡一起置顶之后，用户要按
    // 三次才回到原样，而按到一半时那三张散在三个高度——正是「整组当刚体」
    // 这条约定要防的画面。
    name: 'layer order writes one undo step per card',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    mutate(previous => ({ ...previous, nodes: [...result.nodes] }))',
    to: '    for (const node of result.nodes) { mutate(previous => ({ ...previous, nodes: previous.nodes.map(item => item.id === node.id ? node : item) })) }\n    mutate(previous => ({ ...previous, nodes: [...result.nodes] }))',
    expect: /一次编辑/,
  },
  {
    // 「一个都没动」时照样写：undo 栈里多一条空步骤，下一次 ⌘Z 看起来没反应。
    name: 'layer order writes even when nothing moved',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    if (!result.moved) {',
    to: '    if (false) {',
    expect: /一个都没动/,
  },
  {
    // 目录那一行接到了反方向：两行都能点，只有一行做的是反的。界面上完全看
    // 不出来——除非有人真的按下去。
    name: 'a catalog row is wired to the opposite direction',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "    'edit.layerFront': () => reorderSelection('front'),",
    to: "    'edit.layerFront': () => reorderSelection('back'),",
    expect: /没有接到/,
  },
  {
    // react-flow 的选中提权回来了：被置底的那张卡一被点中就用内联 z-index 1000
    // 跳回最上层。用户看到的是「置底没生效」，刷新后又是对的——最难复现的一类。
    name: 'react-flow elevates the selected node again',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '                elevateNodesOnSelect={false}',
    to: '',
    expect: /选中提权/,
  },
  {
    // 叠放顺序退回「靠 react-flow 的渲染顺序」：`onlyRenderVisibleElements` 之类
    // 的开关会重排节点元素，那时谁在后面就不再等于谁在上面。
    name: 'flow nodes stop carrying their document index as zIndex',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '      zIndex: index,',
    to: '',
    expect: /按下标写 zIndex/,
  },
  {
    // 遮盖提示挪回卡片内部：它要说明的正是「这张你看不见」，挂进卡片就等于和
    // 它一起被压住。以前靠着选中提权碰巧可见，提权一关就彻底消失——真机截图
    // 里只剩一圈黄边，而那圈边也在下面。
    name: 'the covered badge moves back inside the covered card',
    runner: 'contracts',
    file: 'src/client/canvas/node-body.tsx',
    from: '  {composeIndex >= 0',
    to: '  <span data-node-covered={node.id} />\n  {composeIndex >= 0',
    expect: /画回卡片里/,
  },
  {
    // 提示不画了：被完全盖住的卡片就是彻底看不见——黄边也在下面。
    name: 'the overlay stops drawing the covered badge',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '            data-node-covered={covered.id}',
    to: '            data-covered-removed=""',
    expect: /找不到遮盖提示/,
  },
  // ------------------------------------------- 锁定 / 隐藏（lock & hide）
  //
  // 五个缺陷，每一个都在界面上长得完全正常：锁看起来锁上了、卡看起来藏起
  // 来了、复制粘贴看起来成功了。它们的共同点是只有用户按下那一下才暴露。
  {
    // 删除不再跳过锁定项：一张锁不住 Delete 的卡等于没锁，而用户正因为相
    // 信它锁上了才敢把它留在那里。
    name: 'delete takes locked cards away anyway',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    const deletable = unlockedIds(current.nodes, ids)',
    to: '    const deletable = new Set(ids)',
    expect: /删除不再跳过锁定的节点/,
  },
  {
    // 渲染不过滤隐藏项：菜单说「已隐藏」，画布上那张卡还在，还继续吃点击。
    // 这是这个功能最坏的一种失败——用户会反复点「隐藏」，然后怀疑是不是自
    // 己点错了卡。
    name: 'hidden cards stay in the render',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '    () => nodesToFlow(visibleNodesOf).map((node, index) => ({',
    to: '    () => nodesToFlow(document?.nodes ?? []).map((node, index) => ({',
    expect: /渲染不再用 visibleNodesOf/,
  },
  {
    // 复制照抄标记：复制一张锁住的卡得到的是另一张拖不动的卡，用户第一反应
    // 是「粘贴坏了」；复制一张藏起来的卡更糟，粘完屏幕上什么都没有。
    name: 'duplicating a locked card produces another locked card',
    runner: 'contracts',
    file: 'src/client/canvas/node-model.ts',
    from: 'metadata: withoutFlags(metadata ?? { ...nodeMetadata(node) })',
    to: 'metadata: metadata ?? { ...nodeMetadata(node) }',
    expect: /复制路径不再清掉/,
  },
  {
    // 拖动不再检查锁定：一框选一拖，锁住的卡跟着走。而更贵的是它把「锁定」
    // 这个词在用户心里的含义整个换掉了——他下次不会再用它。
    name: 'a locked card still follows the pointer',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '      if (isLocked(item)) { lockedInSelection += 1; continue }',
    to: '      if (false) { lockedInSelection += 1; continue }',
    expect: /拖动入口不再跳过锁定的卡片/,
  },
  {
    // 底栏那条提示没了：藏起来的卡既不在渲染里，也不在框选和 ⌘A 里，用户
    // 再也没有把它叫回来的入口。隐藏于是变成「删除，但还占着导出」。
    name: 'the hidden-cards strip loses its only action',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'data-hidden-bar-show=""',
    to: 'data-hidden-strip-removed=""',
    expect: /底栏没有「全部显示」的入口/,
  },
  {
    // 锁定逐张写：一次「锁定三张」在撤销栈里变成三步，而按到一半时那批卡
    // 一半锁着、一半没锁——用户从画面上看不出这个中间态。
    name: 'lock writes one undo step per card',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: "    setNotice(tt(locking ? 'canvas.lock.locked' : 'canvas.lock.unlocked', { count: ids.size }))",
    to: "    mutate(previous => previous)\n    setNotice(tt(locking ? 'canvas.lock.locked' : 'canvas.lock.unlocked', { count: ids.size }))",
    expect: /不再是「一次编辑」/,
  },
  {
    // ⌥⇧L 退回认 `event.key`：macOS 按住 Option 时它给的是组合字符，这条
    // 分支永远不成立，按了没反应也没有任何报错。
    name: 'the lock shortcut reads event.key again',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '        if (FLAG_SHORTCUTS[event.code] === \'lock\') toggleLock()',
    to: '        if (FLAG_SHORTCUTS[event.key] === \'lock\') toggleLock()',
    expect: /锁定 \/ 隐藏的键位不再读 event\.code/,
  },
  // ------------------------------------------- 吸附参考线（snap guides）
  //
  // 两种坏法都不报错、都不崩：线没画出来（吸附仍生效，用户看到卡片自己跳），
  // 或松手后线还留着（静止画布上一条红线，读起来像一次真正的对齐）。
  {
    name: 'the snap guides are computed but never drawn',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '        {renderSnapGuides()}',
    to: '        {null}',
    expect: /不再渲染吸附参考线/,
  },
  {
    name: 'the snap guides are computed from the un-snapped position',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '            const landed = { ...primary, x: Math.round(origin.x + dx + snap.x), y: Math.round(origin.y + dy + snap.y) }\n            const next = snapGuides(landed, others)',
    to: '            const landed = { ...primary, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }\n            const next = snapGuides(primary, others)',
    expect: /不再按吸附后的位置计算/,
  },
  {
    name: 'the guides survive the pointer release',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: '        if (snapGuidesRef.current.length > 0) {\n          snapGuidesRef.current = []\n          bumpSnapGuides(version => version + 1)\n        }\n        // 刻意**不**在这里清 dragMovingIds',
    to: '        // 刻意**不**在这里清 dragMovingIds',
    expect: /松手之后吸附参考线还留在画布上/,
  },
  {
    // 对着藏起来的卡吸附：可见的那张会停在一片空处，而画面上没有任何东西解释
    // 它为什么停在那里。
    name: 'snapping still targets hidden cards',
    runner: 'contracts',
    file: 'src/client/canvas',
    from: 'const others = visibleNodes(documentRef.current?.nodes ?? []).filter(node => !moving.has(node.id))',
    to: 'const others = (documentRef.current?.nodes ?? []).filter(node => !moving.has(node.id))',
    expect: /不再只看画面上的节点/,
  },
  // ------------------------------------------- 对齐（align）
  {
    // 把「只动选中」改成「所有节点都跑去对齐」：界面上看起来一切正常，
    // 只是每按一次对齐，用户没圈中的卡也挪了位置。A2/A3/A10 守它。
    name: 'align moves the nodes the user did not select',
    runner: 'align',
    file: 'src/client/canvas/align-model.ts',
    from: '  const selected = nodes.filter(node => selectedIds.has(node.id))',
    to: '  const selected = [...nodes]',
    expect: /动了未选中的|未选中的/,
  },
  {
    // 居中改成按左边缘对齐：六个模式里只有两种的差别是「中心 vs 边缘」，
    // 其余四种一模一样，所以这个错只在中/右下的语义里露头。A5 守它。
    name: 'centre alignment lands the left edge on the midline',
    runner: 'align',
    file: 'src/client/canvas/align-model.ts',
    from: '      else offset = deltaRound(mid - (box.start + box.end) / 2)',
    to: '      else offset = deltaRound(mid - box.start)',
    expect: /居中不是左边缘对齐|中心应落在|a 中心应落在/,
  },
  {
    // 分布按「中心等距」而不是「空隙相等」：四张等宽卡时两者算出来一模一样，
    // 一旦宽窄不一，中间那几张就会挤在一起——而用户按下按钮前看不出区别。
    // A7/A8 守它。
    name: 'distribute spaces the centres evenly instead of the gaps',
    runner: 'align',
    file: 'src/client/canvas/align-model.ts',
    from: '  const gap = (span - occupied) / (ordered.length - 1)',
    to: '  const gap = (span - occupied) / (ordered.length - 1) * 0',
    expect: /等间距|中心等距|空隙/,
  },
  {
    // 整组成员都被选中时仍当成一个刚体：用户圈住整组去对齐，结果每张卡都
    // 到了基准线上却保持彼此原来的间距，一张都没落到位。A13 守它。
    name: 'a whole group selected still moves as one rigid body',
    runner: 'align',
    file: 'src/client/canvas/align-model.ts',
    from: '    if (members.length > 0 && members.every(node => selectedIds.has(node.id))) fullGroups.add(group.id)',
    to: '    void members',
    expect: /整组选中|b 应独立对齐|全组/,
  },
  {
    // 组的未选中成员不跟着走：用户以为自己只对齐了一张卡，实际把组拆了。
    // A12/A15 守它。
    name: 'aligning part of a group tears the group apart',
    runner: 'align',
    file: 'src/client/canvas/align-model.ts',
    from: '    const members = liveMembersOf(group, byId).map(at)',
    to: '    const members = liveMembersOf(group, byId).map(at).filter(member => selectedIds.has(member.id))',
    expect: /跟着动|组内 dx|组内 dy/,
  },
  // ------------------------------------------- 撤销摘要（history）
  {
    // 删节点带走的线被当成第二次改动：于是每次删卡都变成「混合操作」，
    // tooltip 永远说不出「撤销删除」。H1 守它。
    name: 'deleting a node counts its wires as a second change',
    runner: 'history',
    file: 'src/client/canvas/history-model.ts',
    from: '      if (!touches(previous, removedNodeIds)) removedConnections += 1',
    to: '      removedConnections += 1',
    expect: /删节点应报 remove|连带结果|不算第二项/,
  },
  {
    // 新节点自带的自动连线被当成独立的 connect：加一张配置卡报「混合操作」，
    // 而用户只做了一件事。H2 守它。
    name: 'a node arriving with its auto-wire reads as two actions',
    runner: 'history',
    file: 'src/client/canvas/history-model.ts',
    from: '    if (touches(current, addedNodeIds)) continue',
    to: '',
    expect: /自动连线|add，不报 connect/,
  },
  {
    // 只动视口被说成「改了 1 项」：滚动一下画布，撤销按钮就承诺能退掉一件事，
    // 按下去屏幕不动。H11 守它。
    name: 'a viewport-only change is announced as an edit',
    runner: 'history',
    file: 'src/client/canvas/history-model.ts',
    from: '  return makeStep(\'mixed\', viewportChanged ? 1 : 0, [], beforeNodes, afterNodes)',
    to: '  return makeStep(\'mixed\', 1, [], beforeNodes, afterNodes)',
    expect: /视口|nodeIds \[\]|0/,
  },
  {
    // 坏快照被跳过而不是截断：`stepsBack` 与真实栈深从此错开一格，下面每点一
    // 行都会退到错的地方。H22 守它。
    name: 'a corrupt snapshot is skipped instead of ending the list',
    runner: 'history',
    file: 'src/client/canvas/history-model.ts',
    from: '    } catch {\n      break',
    to: '    } catch {\n      continue',
    expect: /坏快照|stepsBack|退错步/,
  },
  {
    // limit 从最旧的一端截：面板明明只放得下十几行，却给出「很早以前」的几步，
    // 而用户要退的几乎总是最近发生的那件事。H21 守它。
    name: 'the history list fills its budget from the oldest step',
    runner: 'history',
    file: 'src/client/canvas/history-model.ts',
    from: '  for (let index = frames.length - 1; index >= 0 && rows.length < limit; index -= 1) {',
    to: '  for (let index = 0; index < frames.length && rows.length < limit; index += 1) {',
    expect: /截断取最近|limit|最旧/,
  },
  {
    // 空提示词条目不再丢弃：它会变成一个白跑的任务，而卡片上还占着一行让人以为
    // 算进了这一套。T2 守它。
    name: 'an empty prompt-set item is submitted as a real task',
    runner: 'prompt-set',
    file: 'src/client/canvas/prompt-set.ts',
    from: "    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''\n    if (prompt === '') continue",
    to: "    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''",
    expect: /空提示词|白跑|T2/,
  },
  {
    // 套图条目总数不再封顶：一次提交十几条就是十几个付费请求，而按钮上只写着
    // 「12 条」。T7 / T14 守它。
    name: 'the prompt-set item cap is lifted',
    runner: 'prompt-set',
    file: 'src/client/canvas/prompt-set.ts',
    from: "export const MAX_PROMPT_SET_ITEMS = 12",
    to: "export const MAX_PROMPT_SET_ITEMS = 200",
    expect: /上限|12|T7|T14/,
  },
  {
    // 套图编辑器回到参数排里：那一排是单行 flex，多行子元素会把旁边的
    // 下拉压成一两个字（真机上「自动清晰度」直接退成「自…」）。
    name: 'the prompt-set editor moves back into the parameter row',
    runner: 'contracts',
    file: 'src/client/canvas/composer.tsx',
    from: "  {S.composerKind === 'image' && S.composerRenderer === 'model' ? <ComposerPromptSetEditor S={S} A={A} /> : null}",
    to: "  {S.composerKind === 'image' && S.composerRenderer === 'model' ? null : null}\n  <div className={css.composerControls}><ComposerPromptSetEditor S={S} A={A} /></div>",
    expect: /multi-line prompt-set editor|parameter row|squeeze/,
  },
  {
    // 发送按钮不再看套图草稿：用户写满三条、主输入框空着，按钮是灰的，点不动。
    name: 'the send button ignores the prompt-set draft',
    runner: 'contracts',
    file: 'src/client/canvas/composer.tsx',
    from: "              && S.composerPromptSet.every(item => item.prompt.trim() === '')))",
    to: "              )))",
    expect: /ignores the prompt-set draft|must be live/,
  },
  {
    // 草稿执行清单不丢空条目：与读侧那一条相反，这里是**提交**用的清单，
    // 空条目必须被剔掉，否则每条都换来一次白跑。T13 守它。
    name: 'the draft job list keeps empty items',
    runner: 'prompt-set',
    file: 'src/client/canvas/prompt-set.ts',
    from: "    const prompt = item.prompt.trim()\n    if (prompt === '') continue",
    to: "    const prompt = item.prompt.trim()",
    expect: /全空草稿|白跑|T13/,
  },
  {
    // 「画布生成的东西不要进历史记录」那条要求的失败形态：投影漏掉 `canvas`，
    // 写盘时字段还在、读回来却没了。当次会话里一切正常（返回值来自内存里那
    // 一份），重启之后所有画布产物都变成独立生成——所以这一条必须落在
    // 「写盘 → 重新读」的断言上，只比返回值测不出来。
    name: 'the canvas lineage is dropped when the index is written',
    runner: 'history-canvas',
    file: 'src/video-store.ts',
    from: "    ...entry.canvas === undefined ? {} : { canvas: entry.canvas },\n  }\n}",
    to: "  }\n}",
    expect: /写入盘、读回来还在|survive a write \+ read/,
  },
  {
    // 缩略图写进了索引、读的时候又丢掉：保存那一步是对的，列表里却全是图标。
    // 这类错只在「写完之后再列一次」时现形，所以反向用例落在读侧。
    name: 'the canvas thumbnail is written but never read back',
    runner: 'history-canvas',
    file: 'src/canvas-store.ts',
    from: "        ...typeof project.thumb === 'string' && project.thumb !== '' ? { thumb: project.thumb } : {},",
    to: "",
    expect: /第一张图片节点记成缩略图|first IMAGE node/,
  },
]

const RUNNERS = {
  // 「会写画布的测试必须隔离数据目录」。读源码，零构建：守门看的是脚本怎么写，
  // 不是它跑出什么。这条的存在理由是 2026-10-13~15 那三天攒下的 1408 条残渣。
  isolation: { script: 'scripts/verify-test-isolation.mjs', build: false },
  contracts: { script: 'scripts/verify-ui-contracts.mjs', build: false },
  // The canvas's bottom chrome (dock / zoom dock / minimap) is a layout
  // question that only a real browser can answer: jsdom has no layout engine,
  // and `.canvasChrome` wraps based on the PANEL's width, which no media query
  // measures. No rebuild: the guard reads the stylesheet and the component.
  'canvas-layout': { script: 'scripts/verify-canvas-layout.mjs', build: false },
  // 画布的纯函数（吸附 / 遮挡 / 缩略图投影 / 缩放分档 / 就绪判定 / 整理排版）
  // 直接从源码 import，零构建。整理画布的「分层与环」这类规则只有这一层能守：
  // 界面上看不出「这一版把环当成了无依赖」。
  geometry: { script: 'scripts/smoke-canvas-geometry.mjs', build: false },
  // 空态「载入示例」的几何与 metadata：纯数据模块，直接从源码 import。
  example: { script: 'scripts/smoke-canvas-example.mjs', build: false },
  // 画布体检：环 / 残线 / 空配置 / 未就绪，纯函数 + `planLayers`，零构建。
  health: { script: 'scripts/smoke-canvas-health.mjs', build: false },
  // 找节点：搜索排序与视野计算，纯函数，零构建。
  search: { script: 'scripts/smoke-canvas-node-search.mjs', build: false },
  // 多窗口保存的合并：纯函数，直接从源码 import，零构建。
  merge: { script: 'scripts/smoke-canvas-merge.mjs', build: false },
  // 对齐 / 分布：分组刚体、幂等、取整，纯函数，零构建。
  align: { script: 'scripts/smoke-canvas-align.mjs', build: false },
  // 撤销摘要：把两份快照说成一句话，纯函数，零构建。
  history: { script: 'scripts/smoke-canvas-history.mjs', build: false },
  // 套图：清理 / 兜底 / 上限 / 草稿执行清单，纯函数，零构建。
  'prompt-set': { script: 'scripts/smoke-canvas-prompt-set.mjs', build: false },
  smoke: { script: 'scripts/smoke.mjs', build: true },
  video: { script: 'scripts/smoke-video.mjs', build: true },
  // The gallery/store half of the video chain: smoke-canvas-video drives the
  // real store in a temp home, which smoke-video does not touch at all.
  'canvas-video': { script: 'scripts/smoke-canvas-video.mjs', build: true },
  // 历史记录里的画布行：产物过滤、缩略图、画布来源落盘。跑真实存储（临时
  // home + 构建产物），因为「来源没写进盘」这类错只有在重新读盘时才现形。
  'history-canvas': { script: 'scripts/smoke-history-canvas.mjs', build: true },
  // The board's persisted state and its pure rules, driven against the real
  // modules in a temp home. No build needed: the source is imported directly.
  storyboard: { script: 'scripts/smoke-storyboard.mjs', build: false },
  // 分镜的写作规范（台词时长 / 可选时长 / 参考图上限）是另一套纯函数，
  // 与上面那组的「状态」问题无关，所以单列一组：一个组名只挂一个 script，
  // 两个无关的失败模式混在一起，红的那一行永远分不清是谁坏了。
  'storyboard-spec': { script: 'scripts/smoke-storyboard-spec.mjs', build: false },
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
  // Magpie 的图像发现（#47）：桩 fetch，直接 import src，零网络零构建。
  magpie: { script: 'scripts/smoke-magpie-discovery.mjs', build: false },
  // 非 JSON 报错的可诊断性（#48）：桩 fetch 驱动真实生成路径，零网络零构建。
  diagnosis: { script: 'scripts/smoke-upstream-diagnosis.mjs', build: false },
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
  // 子检查的输出由 run 捕获；在调用边界报告进度，避免整组长跑时只能看到空日志。
  const caseStarted = Date.now()
  console.log(`START [${testCase.runner}] ${testCase.name}`)
  console.log('  copying test inputs')
  freshCopy(runner.git === true)
  console.log(`  copy ready (${((Date.now() - caseStarted) / 1000).toFixed(2)}s); running baseline: ${script}`)
  const baselineStarted = Date.now()
  const baseline = run(script)
  console.log(`  baseline ${baseline.ok ? 'PASS' : 'FAIL'} (${((Date.now() - baselineStarted) / 1000).toFixed(2)}s)`)
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
    if (runner.build) {
      console.log('  rebuilding mutated copy')
      build()
    }
  } catch (error) {
    results.push({ name: testCase.name, verdict: 'HARNESS BROKEN', detail: String(error.message) })
    continue
  }
  console.log('  running mutated check')
  const mutationStarted = Date.now()
  const mutated = run(script)
  console.log(`  mutated check ${mutated.ok ? 'PASS (defect missed)' : 'FAIL (matching expected diagnostic next)'} (${((Date.now() - mutationStarted) / 1000).toFixed(2)}s)`)
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

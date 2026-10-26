/**
 * Assert that the build is a pure function of the source tree.
 *
 * WHY this is a check and not a note in the release notes: the release workflow
 * publishes `SHA256SUMS` next to a tarball it just packed, and re-running that
 * workflow replaces a release's assets. Both of those only mean something if
 * the same commit produces the same bytes. They did not — three times, for
 * three different reasons, and the third one is why this script now reads a
 * source map.
 *
 * **First failure: iteration order.** `lightningcss` returns CSS-module exports
 * from a native hash map, `tsdown.config.ts` serialised the map in iteration
 * order, and that order differed on every process: five runs over one
 * stylesheet produced five different first keys. Sorting at the point where the
 * map becomes bytes fixed it.
 *
 * **Second failure: the checkout path.** lightningcss derives a CSS module's
 * `[hash]` from the `filename` string it is handed and from nothing else —
 * measured: identical bytes under `/a/b/src/client/x.module.css` hash to
 * `uoukpq_wrap` and under `/c/d/src/client/x.module.css` to `ByV2Ia_wrap`, while
 * changing the CSS from `red` to `blue` does not move the hash at all. The
 * config was handing it the absolute path, so every generated class name — and
 * therefore `lib/client.js` — depended on where the repo was checked out. The
 * same commit built in `/Users/malang/chajian/dsh-imagegen-video` and in
 * `/tmp/repro-check` produced `58182bf0…` and `64533a53…`. It now passes the
 * repo-relative path.
 *
 * **Third gap: the artifact nobody looked at.** `package.json` ships all of
 * `lib/`, so the tarball contains FIVE build outputs, and this check asserted
 * FOUR — `lib/client.js.map` was published but never compared. It is now, and
 * the artifact list is derived from what the build actually wrote rather than
 * typed out, with a loud failure on anything unrecognised.
 *
 * **Why the map needs its own handling.** `lib/client.js.map` records the paths
 * rolldown resolved for its inputs, and it resolves through symlinks: a mirror
 * whose `node_modules` is a symlink back to the original produces
 * `sources[8] = ../../../../Users/malang/…/node_modules/.pnpm/lucide-react@…/…`
 * where the original produces `../node_modules/.pnpm/lucide-react@…/…`. Same
 * code, different map. The mirror therefore uses a symlink (not a hard link:
 * see mirrorSourceTree for why `cp -al` was measured and rejected), and the
 * map comparison normalises every `node_modules/` prefix away, which is what
 * makes a symlinked mirror indistinguishable from a hard-linked one. That
 * normalisation is not an optional extra: drop it and the same source tree
 * reports a map difference that is purely the mirror's construction.
 *
 * What that normalisation costs: a difference confined to the node_modules
 * portion of a `sources` entry would go unnoticed. It cannot hide a real
 * regression, because a different resolved dependency also changes the code in
 * `lib/client.js`, which IS asserted byte-for-byte.
 *
 * Full builds rather than a partial reproduction, because a difference in ANY
 * of the eighteen stylesheets shows up in the same output file, and because
 * rebuilding only what changed would not exercise the path the release takes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { copyTree } from './lib/copy-tree.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(ROOT, 'lib')

/**
 * Entry stems the build emits.
 *
 * An explicit list rather than "whatever .js is in lib/", so that a file this
 * check does not know about is a loud failure instead of a silent omission.
 * Measured: a stale `lib/STALE-ONLY.js` survives a client-only build (the
 * client config is `clean: false` and does not delete what the node config
 * wrote), but `pnpm build` runs the node config first with `clean: true`, which
 * empties `lib/` — so on the path the release takes, no stale file can reach
 * this list. The guard is about build entries growing, not about leftovers:
 * adding an entry without adding its stem must fail, or a sixth artifact would
 * ship uncompared.
 */
const KNOWN_STEMS = ['client', 'index', 'locale-tables', 'locale-tables-chunk']

/**
 * What a build reads, relative to the repository root.
 *
 * Deliberately a whitelist rather than "everything except the big things": a
 * copy that silently dropped a build input would make the cross-directory
 * comparison vacuous, and the failure mode of a vacuous check is that it stays
 * green while the property it names rots. If the build starts reading a new
 * root-level file, this list is where it has to be added.
 */
const BUILD_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  // tsdown hands the TS to rolldown, which resolves tsconfig.json itself, so
  // `target` reaches the emitted bytes. Measured: the same source with
  // `target: ES2022` builds `client.js` db0f023a… and with `target: ES2020`
  // builds 474e84be…. Omitting it here therefore compared "with tsconfig"
  // against "without" — two different inputs — and the drift it reported was
  // an artifact of the comparison, not of the build. It only stayed quiet
  // because the repo's settings happen to be the defaults; that is luck, not
  // a guarantee, and it is exactly the silent omission the whitelist exists
  // to prevent.
  'tsconfig.json',
  'tsdown.config.ts',
  'src',
]

/**
 * The JS entry point of the pnpm that is on PATH, or undefined.
 *
 * Windows installs `pnpm` as a `.cmd`/`.ps1` shim, and Node refuses to
 * `execFile` a `.cmd` (parameter-injection hardening, since 18.20.2). The
 * failure reads `spawnSync pnpm ENOENT`, which points at the wrong thing
 * entirely: pnpm is installed. `shell: true` is not the way out either — under
 * Git Bash PATH is spelled `/c/Users/...`, which cmd.exe cannot resolve, and it
 * answers 127. Running the shim's JS entry point with the current node sidesteps
 * PATH and the shim both, and is identical in behaviour on posix.
 *
 * Several layouts are searched because the installer decides which one exists:
 * npm's global install puts pnpm under `<prefix>/node_modules`, nvm puts it
 * under `<bin>/../lib/node_modules`, and corepack — whose shim is what `pnpm`
 * on PATH actually is on the machine this was measured on — sits in either.
 * A posix `pnpm` on PATH is usually a symlink into one of those, so it is
 * followed too. Finding none is a real possibility rather than an error, which
 * is why the caller keeps its by-name fallback.
 */
const PNPM_LAYOUTS = [
  join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  join('node_modules', 'corepack', 'dist', 'pnpm.js'),
  join('..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  join('..', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  'pnpm.cjs',
]

function findPnpmEntry () {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const layout of PNPM_LAYOUTS) {
      const entry = join(dir, layout)
      if (existsSync(entry)) return entry
    }
    for (const name of ['pnpm', 'pnpm.cjs']) {
      const shim = join(dir, name)
      if (!existsSync(shim)) continue
      let real
      try {
        real = realpathSync(shim)
      } catch {
        continue
      }
      if (/\.[cm]?js$/.test(real)) return real
    }
  }
  return undefined
}

const PNPM = findPnpmEntry()

function build (cwd) {
  const options = { cwd, encoding: 'utf8', stdio: 'ignore' }
  if (PNPM !== undefined) {
    execFileSync(process.execPath, [PNPM, 'build'], options)
    return
  }
  try {
    execFileSync('pnpm', ['build'], options)
  } catch (error) {
    // A bare ENOENT here names `pnpm` and not the real problem, which is that
    // this script could not locate an entry point it knows how to run.
    if (error.code === 'ENOENT') {
      fail([
        '',
        'FAIL: found no pnpm JS entry point on PATH, and spawning `pnpm` by name failed too.',
        'Searched every PATH directory for node_modules/pnpm/bin/pnpm.cjs,',
        'node_modules/corepack/dist/pnpm.js and pnpm.cjs. Install pnpm (or run this',
        'check from a shell where `pnpm build` works), then run it again.',
      ])
    }
    throw error
  }
}

/**
 * The build outputs, discovered from disk.
 *
 * Derived rather than hard-coded so that adding an entry to `tsdown.config.ts`
 * extends the assertion instead of silently shipping an unchecked file — the
 * whole lesson of `lib/client.js.map`, which was published for weeks with no
 * one comparing it. An unknown file is a hard failure rather than an
 * afterthought: the alternative is a check that says "reproducible" while a
 * sixth artifact drifts.
 */
function artifacts (libDir) {
  const stems = new Set(
    readdirSync(libDir)
      .filter(name => name.endsWith('.js') || name.endsWith('.js.map'))
      .map(name => name.replace(/\.js(\.map)?$/, '')),
  )
  const unknown = [...stems].filter(stem => !KNOWN_STEMS.includes(stem))
  if (unknown.length > 0) {
    fail([
      '',
      `FAIL: lib/ contains build outputs this check does not know about: ${unknown.join(', ')}`,
      '',
      'Either it is a leftover from an older build (remove it) or the build grew a',
      'new entry. If it is a new entry, add its stem to KNOWN_STEMS in',
      'scripts/verify-reproducible.mjs — an artifact that ships is an artifact that',
      'has to be reproducible, and this check refuses to pass while one is uncompared.',
    ])
  }
  const missing = KNOWN_STEMS.filter(stem => !stems.has(stem))
  if (missing.length > 0) {
    fail(['', `FAIL: expected build outputs are missing from lib/: ${missing.join(', ')}`])
  }
  return [...stems].sort().flatMap(stem => [`${stem}.js`, `${stem}.js.map`])
    .filter(name => readdirSync(libDir).includes(name))
}

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * A source map with its dependency paths erased.
 *
 * Only the `node_modules/` portion of a `sources` entry is touched: the input
 * `../src/client/api.ts` (a first-party file, path stable by construction)
 * survives untouched, and so does the whole `mappings`/`sourcesContent` body.
 * The regex is anchored on the literal `node_modules/` including its slash, so
 * a first-party path that merely contains the word is left alone.
 */
function normalizedMapDigest (file) {
  const map = JSON.parse(readFileSync(file, 'utf8'))
  map.sources = map.sources.map(source => {
    const at = source.lastIndexOf('node_modules/')
    return at >= 0 ? `node_modules/${source.slice(at + 'node_modules/'.length)}` : source
  })
  return createHash('sha256').update(JSON.stringify(map)).digest('hex')
}

function digests (root, names) {
  const out = new Map()
  for (const name of names) {
    const file = join(root, 'lib', name)
    out.set(name, name.endsWith('.js.map') ? normalizedMapDigest(file) : sha256(file))
  }
  return out
}

function fail (lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/**
 * A copy of the source tree in a different absolute directory.
 *
 * `node_modules` is a symlink back to the original, not a copy. The obvious
 * objection is that the source map records resolved paths and therefore
 * resolves through the symlink — and it does: a symlinked mirror produced
 * `sources[8] = ../../../../Users/malang/…/node_modules/.pnpm/lucide-react@…/…`
 * where the original produced `../node_modules/.pnpm/lucide-react@…/…`. That
 * is why the map comparison normalises the `node_modules/` prefix, which makes
 * the symlink indistinguishable from a hard-link copy (measured: hard link,
 * symlink, and a plain nested copy all normalize to the same digest).
 *
 * The alternative — hard-linking `node_modules` with `cp -al` — was measured
 * and rejected: it costs ~5.5s of pure syscall time walking 333 store entries,
 * it is the single most expensive step in this check, and it buys nothing the
 * normaliser does not already provide. It also cannot cross a filesystem
 * boundary at all, so on a split-volume macOS or a tmpfs `/tmp` it would fail
 * and need the symlink fallback anyway.
 */
function mirrorSourceTree () {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repro-'))
  for (const input of BUILD_INPUTS) {
    // Not `cpSync(..., { recursive: true })`: on Windows that call took the
    // whole process down with exit code 127 and no output at all, which reads
    // as a syntax error in this script rather than as a failed copy.
    copyTree(join(ROOT, input), join(dir, input))
  }
  const target = join(ROOT, 'node_modules')
  const link = join(dir, 'node_modules')
  // A junction is the only directory link Windows creates without administrator
  // rights or developer mode — the default type raised EPERM there. The type
  // argument means nothing on posix, so it is passed only where it exists.
  if (process.platform === 'win32') symlinkSync(target, link, 'junction')
  else symlinkSync(target, link)
  return dir
}

function compare (label, left, right, leftName, rightName, names) {
  const drifted = names.filter(name => left.get(name) !== right.get(name))
  if (drifted.length === 0) return []
  return [
    '',
    `FAIL: ${label} produced different bytes:`,
    ...drifted.map(name => `  - ${name}\n      ${leftName}  ${left.get(name)}\n      ${rightName} ${right.get(name)}`),
  ]
}

/* ---------------------------------------------------------------- same dir */

build(ROOT)
const names = artifacts(LIB)
const first = digests(ROOT, names)
build(ROOT)
const second = digests(ROOT, names)

const sameDirDrift = compare(
  'two builds in the same directory',
  first, second,
  'first ', 'second ',
  names,
)

/* ------------------------------------------------------------ across dirs */

let mirror
let crossDirDrift = []
try {
  mirror = mirrorSourceTree()
  build(mirror)
  const mirrored = digests(mirror, names)
  crossDirDrift = compare(
    'the same source tree built in a different directory',
    first, mirrored,
    'ROOT   ', 'mirror ',
    names,
  )
} finally {
  // Clean up on the failure path too: a leftover 10 MiB tree in /tmp per run
  // is how a check becomes something people disable.
  if (mirror !== undefined) rmSync(mirror, { recursive: true, force: true })
}

if (sameDirDrift.length > 0 || crossDirDrift.length > 0) {
  fail([
    ...sameDirDrift,
    ...crossDirDrift,
    '',
    'The release publishes SHA256SUMS for exactly the tarball it packed, and',
    're-running that workflow replaces a release\'s assets. Neither can be',
    'trusted -- and no checksum can be reproduced from source -- while the',
    'same input yields different output.',
    '',
    'Two causes, both seen in this repo:',
    '',
    '  1. Serialising a value whose iteration order is not defined. lightningcss',
    '     hands CSS-module exports back from a native hash map, and the map was',
    '     being serialised in iteration order, so every build reordered the same',
    '     classes. Sort it where it becomes bytes, not where it is produced.',
    '',
    '  2. Letting WHERE it was built reach the compiler. lightningcss derives',
    '     CSS-module class name hashes from the filename string alone, so the',
    '     config passes a repo-relative path; an absolute path made every class',
    '     name depend on the checkout. The same applies to timestamps and any',
    '     embedded cwd.',
    '',
    'A difference that shows up only in the cross-directory build is cause 2.',
  ])
}

console.log(`reproducible: ${names.length} artifacts are byte-identical across two builds in the same directory`)
console.log(`reproducible: ${names.length} artifacts are byte-identical in a different directory`)
for (const name of names) {
  console.log(`  ${name}\n    ${first.get(name)}`)
}

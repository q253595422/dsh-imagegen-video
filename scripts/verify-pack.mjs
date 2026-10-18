/**
 * Assemble the archive that would be published and inspect what is in it.
 *
 * WHY this is a script and not inline bash in the workflow: the negative
 * verification has to re-run the same assertion after re-introducing a defect,
 * and an assertion that exists in two places drifts. CI runs this file; the
 * `pack` runner in verify-negative.mjs runs the same file against a mutated
 * copy of the repository.
 *
 * What is checked, and why each one is here rather than left to review:
 *
 *  - `lib/index.js` and a template snapshot are present. The runtime resolves
 *    the snapshots relative to lib/, so a tarball without them installs a
 *    plugin whose template library is silently empty.
 *  - `docs/videos/` is absent. ~37 MiB of demo recordings that no shipped
 *    document references.
 *  - `docs/images/` is absent. ~20 MiB of README screenshots (one 13 MiB GIF)
 *    that nothing reads at runtime; GitHub renders them from the repository.
 *  - Every entry point the packed manifest declares -- `main`, each `exports`
 *    target, and `dsh.bundle.patch` -- is actually in the archive. A tarball
 *    that installs and boots while `exports["./client"]` points at a file it
 *    does not contain produces no error anywhere; the panel just never appears.
 *
 * A missing build is a real failure here, not a skip: packing without `lib/`
 * would produce an archive that installs and does nothing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Entries the archive must contain, relative to the `package/` root. */
const REQUIRED = ['lib/index.js', 'src/templates/cases.json']

/**
 * Everything `package.json` tells a host to load, resolved the same way the
 * host resolves it.
 *
 * `REQUIRED` above is a hand-maintained list, and a hand-maintained list can
 * only confirm what somebody remembered to write down. The fields below are
 * what actually gets loaded: `main` for the node half, every `exports` target
 * (`.` executes in the host process, `./client` is what the browser fetches as
 * `/plugins/<id>/client.js`), and the `dsh.bundle.patch` overlay the profile
 * reads to even register the plugin.
 *
 * The failure this catches is silent, which is why it is checked here: a
 * `files` edit that drops `lib/` or a renamed export produces an archive that
 * installs cleanly, boots cleanly, and simply never appears in the UI -- "I
 * installed it and nothing happened" with no error anywhere.
 */
function declaredEntryPoints (manifest) {
  const declared = new Map()
  const add = (label, value) => {
    if (typeof value === 'string' && value !== '') declared.set(label, value)
  }
  add('main', manifest.main)
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    // A conditional export (`{import: './x.js'}`) is not a string; the ones
    // this package ships are, and a non-string is skipped rather than guessed.
    add(`exports[${JSON.stringify(key)}]`, target)
  }
  add('dsh.bundle.patch', manifest.dsh?.bundle?.patch)
  // `dsh.client` names no file (the client is found through `exports`), but a
  // `dsh.profile`/`dsh.bundle` rename would silently unmount the plugin.
  return [...declared]
}

/** Directories that must NOT be published, with the reason shown on failure. */
const FORBIDDEN = [
  { path: 'docs/videos/', why: 'demo recordings no shipped document references (~37 MiB)' },
  { path: 'docs/images/', why: 'README screenshots that are never read at runtime (~20 MiB)' },
]

function fail (lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

// Any .tgz already sitting in the tree would be picked up by a bare glob in
// older versions of this check, so the archive name is derived from
// package.json instead of guessed.
//
// pnpm's rule for a scoped package: `@scope/name` becomes `scope-name-version.tgz`
// (the `@` and the `/` both become `-`). Stripping the scope entirely produces
// `dsh-imagegen-video-1.7.6.tgz`, which does not exist -- and then the check
// reports a missing archive that IS there.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const archiveName = `${String(pkg.name).replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
const archivePath = join(ROOT, archiveName)

// `--ignore-scripts`: the build already ran (CI builds before testing, and the
// negative runner's copy is built by its own runner). Re-running `prepare` here
// would rebuild 24 MiB of output for an archive whose contents are unchanged.
rmSync(archivePath, { force: true })
execFileSync('pnpm', ['pack', '--pack-destination', '.', '--ignore-scripts'], {
  cwd: ROOT, encoding: 'utf8', stdio: 'ignore',
})

if (!existsSync(archivePath)) {
  fail([
    '',
    `FAIL: \`pnpm pack\` did not produce ${archiveName}.`,
    'The publish step cannot continue without an archive to inspect.',
  ])
}

const listing = execFileSync('tar', ['-tzf', archivePath], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(line => line !== '')
const entries = new Set(listing)

const missing = REQUIRED.filter(entry => !entries.has(`package/${entry}`))
if (missing.length > 0) {
  fail([
    '',
    'FAIL: the published archive is missing entries the runtime needs:',
    ...missing.map(entry => `  - package/${entry}`),
    'The host resolves bundled prompt snapshots relative to lib/, so an archive',
    'without them installs a plugin whose template library is empty.',
  ])
}

const present = FORBIDDEN.filter(entry => listing.some(line => line.startsWith(`package/${entry.path}`)))
if (present.length > 0) {
  fail([
    '',
    'FAIL: the published archive carries files that must not ship:',
    ...present.map(entry => `  - ${entry.path} -- ${entry.why}`),
    'These belong to the repository, not to the installed plugin.',
  ])
}

// ------------------------------------------------------------- release notes
// `release.yml` uses `docs/releases/<tag>.md` as the Release body and falls back
// to GitHub's auto-generated "Full Changelog: <compare link>" line when the file
// is absent -- printing only a ::warning nobody reads. v1.8.0 shipped that way,
// so the page for a release with four user-visible features described none of
// them, and the tag froze that page the moment it was created. A version bump
// without its notes sheet is therefore a failure here, before anything is
// packed, rather than a warning after the release exists.
//
// The second half is about the archive, not the Release: `docs/releases` is in
// `files`, so a tarball that cannot carry its own notes means the manifest
// drifted from the convention that every release has one.
const notesEntry = `docs/releases/v${pkg.version}.md`
if (!existsSync(join(ROOT, notesEntry))) {
  fail([
    '',
    `FAIL: version ${pkg.version} has no release notes (${notesEntry}).`,
    'release.yml would publish this version with GitHub\'s one-line compare link',
    'as its entire body, and only a warning to say so. Write the notes first:',
    'they are the only place the user-visible changes of a version are explained.',
  ])
}
if (!entries.has(`package/${notesEntry}`)) {
  fail([
    '',
    `FAIL: the archive does not contain ${notesEntry}, although \`files\` lists docs/releases.`,
    'Every release ships its own notes; an archive without them means the',
    'manifest and the repository no longer agree on what a release contains.',
  ])
}

// The archive's own manifest is authoritative: `files` may be edited and the
// packing happens from the tree, so what the manifest promises and what got
// packed can disagree. Read the copy INSIDE the archive, not the one on disk.
const packedManifest = JSON.parse(
  execFileSync('tar', ['-xzOf', archivePath, 'package/package.json'], { cwd: ROOT, encoding: 'utf8' }),
)
const unresolved = declaredEntryPoints(packedManifest)
  .map(([label, target]) => [label, target.replace(/^\.\//, '')])
  .filter(([, target]) => !entries.has(`package/${target}`))
if (unresolved.length > 0) {
  fail([
    '',
    'FAIL: the archive declares entry points it does not contain:',
    ...unresolved.map(([label, target]) => `  - ${label} -> ${target} (not in the archive)`),
    'The plugin would install and boot, and one of its halves would never load:',
    'the host half throws at import time, or the browser half 404s and the',
    'panel silently never appears. Neither error names the packaging mistake.',
  ])
}

const sizeMiB = Number(execFileSync('du', ['-m', archivePath], { encoding: 'utf8' }).split('\t')[0])
const topLevel = [...new Set(listing.map(line => line.split('/')[1]).filter(Boolean))].sort()
console.log(`pack: ${archiveName} (${sizeMiB} MiB) -- ${entries.size} entries, top level: ${topLevel.join(', ')}`)
console.log('pack: required entries present; every declared entry point resolves')
console.log('pack: no docs/videos, no docs/images')

// ---------------------------------------------------------------- publish lag
// The publish job verifies the version it just pushed by reading it back. That
// read lags the write by MINUTES, not seconds -- measured on this repository:
// the 1.7.8 publish returned `+ pkg@1.7.8` with a provenance statement at
// 08:17:45Z and the version was not readable until 08:21:01Z, so the original
// 60-second window turned a successful publish into a red run. The guard here
// is the window itself: it has to outlast the lag we actually observed.
//
// This is a source invariant, not a runtime one, which is why it lives here
// rather than in a browser check: nothing at install time can observe it, and
// the cost of getting it wrong is a false failure that sends someone hunting
// for a credential problem.
const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
const windowLoop = /for attempt in \$\(seq 1 (\d+)\); do[\s\S]{0,400}?not visible yet \(attempt \$attempt\/\d+\); waiting (\d+)s/.exec(workflow)
if (!windowLoop) {
  fail([
    '',
    'FAIL: the npm publish job no longer has a bounded visibility loop.',
    'It must retry the read-back and print the attempt count; without both, a',
    'read lag is indistinguishable from a version that never published.',
  ])
}
const [, attempts, interval] = windowLoop
const windowSeconds = Number(attempts) * Number(interval)
// 3m16s was observed once. Anything under four minutes would have failed that
// same day, so the floor is the observation plus headroom, not a round number.
if (windowSeconds < 240) {
  fail([
    '',
    `FAIL: the publish visibility window is ${windowSeconds}s (${attempts} x ${interval}s).`,
    'The registry read path lagged a successful publish by 3m16s on 2026-10-18.',
    'A shorter window reports a publish that worked as a failed one.',
  ])
}
console.log(`pack: publish visibility window is ${windowSeconds}s, past the 3m16s read lag measured on 1.7.8`)

// Leave no archive behind in the working tree: the caller only wanted the
// inspection, and a stray .tgz is what made older checks pick the wrong file.
if (process.env.DSH_KEEP_ARCHIVE !== '1') rmSync(archivePath, { force: true })

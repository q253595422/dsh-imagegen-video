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

const sizeMiB = Number(execFileSync('du', ['-m', archivePath], { encoding: 'utf8' }).split('\t')[0])
const topLevel = [...new Set(listing.map(line => line.split('/')[1]).filter(Boolean))].sort()
console.log(`pack: ${archiveName} (${sizeMiB} MiB) -- ${entries.size} entries, top level: ${topLevel.join(', ')}`)
console.log('pack: required entries present; no docs/videos, no docs/images')

// Leave no archive behind in the working tree: the caller only wanted the
// inspection, and a stray .tgz is what made older checks pick the wrong file.
if (process.env.DSH_KEEP_ARCHIVE !== '1') rmSync(archivePath, { force: true })

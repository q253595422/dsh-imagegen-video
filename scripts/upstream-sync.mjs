#!/usr/bin/env node
/**
 * Detect new releases of the project this one descends from, and turn each one
 * into a port plan instead of a hand-diff session.
 *
 * WHY this exists: keeping up by hand means noticing a release, fetching its
 * diff, and working out which hunks still apply to a tree that has moved on.
 * That is exactly the kind of bookkeeping a machine does without forgetting a
 * file. The script does NOT merge anything: the two histories share no
 * ancestor, so every release is adopted file by file, and which files those are
 * is a decision a person makes from the report.
 *
 * The signal that matters is not "has this file changed here" — with no shared
 * history there is nothing to compare against — but **whether the release's
 * hunks still apply to this tree**. `git apply --check` answers that directly,
 * per file, without touching the working tree.
 *
 * What it writes, under `.upstream/<version>/`:
 *
 *   diff.patch     the release diff, verbatim
 *   report.md      every changed file, classified by whether it applies
 *   source/        only the files that cannot be applied, copied whole
 *
 * Classification:
 *
 *   new            absent here → copy from `source/`
 *   applies        every hunk applies cleanly → `git apply` that file's hunks
 *   conflicts      some hunk does not apply → read `source/` against ours
 *   ours-only      this tree owns the concern (video chain, notes, licensing)
 *
 * Usage:
 *   node scripts/upstream-sync.mjs            detect + report
 *   node scripts/upstream-sync.mjs --check    exit 1 when a newer release exists
 *   node scripts/upstream-sync.mjs --adopt v1.8.3   record what has been ported
 *
 * `--adopt` only records a version number. It never edits source, because
 * "adopted" has to mean "I read the report and ported what I wanted". It
 * requires the version to be named: defaulting to the newest release would
 * record the one thing that certainly has NOT been ported yet.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const UPSTREAM = 'dickpy/dsh-imagegen'
const STATE_FILE = join(ROOT, '.upstream-state.json')
const OUT_ROOT = join(ROOT, '.upstream')

/** Files whose content is this project's own regardless of what the release touches. */
const OURS_ONLY = [
  /^src\/video-/, // the whole video chain exists only here
  /^src\/clip-/, // clip ordering / stitching
  /^src\/agent-video-tools\.ts$/,
  /^src\/canvas-store\.ts$/, // video nodes live in the canvas document
  /^src\/client\/VideoPanel\.tsx$/,
  /^src\/client\/video-/,
  /^docs\/releases\//, // release notes are per-project, never copied
  /^NOTICE$/,
  /^LICENSE$/,
]

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const adopt = args.has('--adopt')

function readState () {
  if (!existsSync(STATE_FILE)) return { adopted: null }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function writeState (state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

/** Every published release, newest first, via the public API (no token needed). */
async function listReleases () {
  const response = await fetch(
    `https://api.github.com/repos/${UPSTREAM}/releases?per_page=30`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-imagegen-video-upstream-sync' } },
  )
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`)
  const releases = await response.json()
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
      publishedAt: release.published_at,
      body: release.body ?? '',
    }))
}

/** Numeric comparison so v1.10.0 sorts after v1.9.0. */
function compareVersions (a, b) {
  const parse = (value) => value.replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function fetchText (url) {
  const response = await request(url)
  return response.text()
}

/**
 * Fetch with a timeout and bounded retries.
 *
 * `github.com/<repo>/archive/...` redirects to codeload and the redirect is what
 * times out on some networks (observed here: connect timeout, while
 * api.github.com and codeload.github.com both answer). Retrying costs one
 * request and turns a flaky network into a slow run instead of a failed one.
 */
async function request (url, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dsh-imagegen-video-upstream-sync' },
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok) return response
      // A 4xx will not improve on retry; a 5xx or a rate limit might.
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`${response.status} for ${url}`)
      }
      lastError = new Error(`${response.status} for ${url}`)
    } catch (error) {
      // `fetch failed` alone says nothing; the cause carries ECONNRESET /
      // ETIMEDOUT / ENOTFOUND, which is the part worth printing.
      lastError = error instanceof Error
        ? new Error(`${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ''} for ${url}`)
        : new Error(String(error))
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000))
  }
  throw lastError
}

/** Split a unified diff into one entry per file, keeping its header lines. */
function splitDiff (patch) {
  const files = []
  let current = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = { path: match?.[2] ?? '', lines: [line], added: 0, removed: 0, binary: false, created: false, deleted: false }
      files.push(current)
      continue
    }
    if (current === null) continue
    current.lines.push(line)
    if (line.startsWith('+') && !line.startsWith('+++')) current.added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed += 1
    else if (line.startsWith('Binary files')) current.binary = true
    else if (line.startsWith('new file mode')) current.created = true
    else if (line.startsWith('deleted file mode')) current.deleted = true
  }
  return files.filter((file) => file.path !== '')
}

function isOursOnly (path) {
  return OURS_ONLY.some((pattern) => pattern.test(path))
}

/**
 * Whether this file's hunks still apply to the working tree.
 *
 * `git apply --check` is asked per file, with the patch on stdin, so a conflict
 * in one file does not hide a clean file elsewhere. Binary files and whole-file
 * creations are not "applied" — they are copied — so they never reach here.
 */
function appliesCleanly (file) {
  const patch = `${file.lines.join('\n')}\n`
  try {
    execFileSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
      cwd: ROOT, input: patch, stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

async function main () {
  const state = readState()
  const releases = await listReleases()
  const newest = releases[0]

  if (!newest) {
    console.log('No published releases found upstream.')
    return 0
  }

  if (adopt) {
    // Adopting "the newest" is almost never what is meant: the newest release is
    // exactly the one nobody has ported yet. The version has to be named.
    const target = process.argv[process.argv.indexOf('--adopt') + 1]
    if (target === undefined || target.startsWith('--')) {
      throw new Error(
        `--adopt needs the version that was actually ported, e.g. --adopt ${newest.tag}\n` +
        'It records what this tree is caught up to; it does not port anything.',
      )
    }
    if (!releases.some((release) => release.tag === target)) {
      throw new Error(`no such upstream release: ${target}`)
    }
    writeState({ adopted: target, adoptedAt: new Date().toISOString() })
    console.log(`Recorded ${target} as adopted.`)
    return 0
  }

  const baseline = state.adopted
  const fresh = baseline === null
    ? [newest]
    : releases.filter((release) => compareVersions(release.tag, baseline) > 0)

  if (fresh.length === 0) {
    console.log(`Up to date: newest upstream release is ${newest.tag}, already adopted.`)
    return 0
  }

  console.log(`${fresh.length} release(s) newer than ${baseline ?? '(nothing recorded)'}:`)
  for (const release of fresh) console.log(`  ${release.tag}  ${release.publishedAt}`)

  if (checkOnly) return 1

  if (baseline === null) {
    console.log('')
    console.log('No baseline recorded, so there is no diff to classify.')
    console.log('Record what this tree is caught up to with:')
    console.log(`  node scripts/upstream-sync.mjs --adopt ${baseline ?? newest.tag}`)
    console.log('Then re-run to get the port plan for the release after it.')
    return 0
  }

  // Oldest first: a later release's diff assumes the earlier one landed.
  for (const release of fresh.reverse()) await buildReport(release, baseline)
  return 0
}

/** Fetch one release, classify every changed file, write the report. */
async function buildReport (release, baseline) {
  const outDir = join(OUT_ROOT, release.tag)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const patch = await fetchText(
    `https://github.com/${UPSTREAM}/compare/${baseline}...${release.tag}.diff`,
  )
  writeFileSync(join(outDir, 'diff.patch'), patch)

  const files = splitDiff(patch)
  const buckets = { new: [], applies: [], conflicts: [], oursOnly: [], deleted: [] }

  for (const file of files) {
    if (isOursOnly(file.path)) buckets.oursOnly.push(file)
    else if (file.deleted) buckets.deleted.push(file)
    else if (!existsSync(join(ROOT, file.path))) buckets.new.push(file)
    else if (file.binary) buckets.conflicts.push(file)
    else if (appliesCleanly(file)) buckets.applies.push(file)
    else buckets.conflicts.push(file)
  }

  // Only the files that cannot be applied need their release copy on disk.
  const wholeCopies = [...buckets.new, ...buckets.conflicts]
  if (wholeCopies.length > 0) {
    const archive = join(outDir, 'source.tar.gz')
    // codeload directly: the github.com/archive redirect is what times out.
    const response = await request(
      `https://codeload.github.com/${UPSTREAM}/tar.gz/refs/tags/${release.tag}`,
    )
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    mkdirSync(join(outDir, 'source'), { recursive: true })
    // GitHub archives wrap everything in one `<repo>-<version>/` directory.
    // The entries are listed first and matched by suffix, then extracted by
    // their exact name: `--wildcards` is GNU-only and bsdtar (macOS) rejects it.
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    const wanted = new Set(wholeCopies.map((file) => file.path))
    const entries = listing.filter((entry) => {
      const suffix = entry.slice(entry.indexOf('/') + 1)
      return wanted.has(suffix)
    })
    const missing = [...wanted].filter(
      (path) => !entries.some((entry) => entry.slice(entry.indexOf('/') + 1) === path),
    )
    if (missing.length > 0) {
      throw new Error(`release archive is missing: ${missing.join(', ')}`)
    }
    execFileSync('tar', [
      '-xzf', archive, '-C', join(outDir, 'source'), '--strip-components=1', ...entries,
    ])
    rmSync(archive)
  }

  writeFileSync(join(outDir, 'report.md'), renderReport(release, baseline, buckets, files.length))
  console.log(`wrote ${relative(ROOT, join(outDir, 'report.md'))}`)
  console.log(`  new ${buckets.new.length} · applies ${buckets.applies.length} · ` +
    `conflicts ${buckets.conflicts.length} · ours-only ${buckets.oursOnly.length} · ` +
    `deleted ${buckets.deleted.length}`)
}

function renderReport (release, baseline, buckets, total) {
  const table = (rows) => rows
    .map((file) => `| \`${file.path}\` | +${file.added} | -${file.removed} |${file.binary ? ' binary |' : ''}`)
    .join('\n')

  const section = (title, rows, why) => (rows.length === 0
    ? `## ${title}\n\nNone.\n`
    : `## ${title} (${rows.length})\n\n${why}\n\n| file | added | removed |\n| --- | --- | --- |\n${table(rows)}\n`)

  return [
    `# ${release.tag} — port plan`,
    '',
    `Diffed \`${baseline}...${release.tag}\`. ${total} files changed, published ${release.publishedAt}.`,
    '',
    'Nothing here has been applied. Each section says how its files land.',
    '',
    section('New here — copy whole', buckets.new,
      'Absent from this tree. Copy from `source/<path>`, then wire it into the entry points by hand.'),
    section('Applies cleanly', buckets.applies,
      'Every hunk applies to this tree as it stands. Extract the file\'s hunks from `diff.patch` and `git apply` them, or apply the whole patch and drop the files below.'),
    section('Conflicts — read by hand', buckets.conflicts,
      'This tree has its own version of these. Compare `source/<path>` with ours and port what still applies.'),
    section('This project\'s own concern — do not overwrite', buckets.oursOnly,
      'The release touches these, but this tree owns them (the video chain, release notes, licensing). Read the diff for ideas only.'),
    section('Deleted upstream', buckets.deleted,
      'The release removes these. Decide whether this tree still needs them.'),
    '## Release notes',
    '',
    release.body,
    '',
  ].join('\n')
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`upstream-sync: ${error.message}`)
    process.exit(2)
  },
)

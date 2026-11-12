#!/usr/bin/env node
/**
 * Run the reverse verification in parallel instead of one group after another.
 *
 * WHY this exists: `test:negative` is a chain of 17 sequential invocations.
 * Measured on one machine, the whole chain does not finish — it was stopped at
 * the 40-minute mark with two groups done, and 137 cases is not a number anyone
 * re-runs while iterating. A verification nobody runs is a verification that
 * protects nothing, which is exactly the failure this suite was written to catch
 * for everything else.
 *
 * The cost is not the build (2.5s) — it is that EVERY case runs its whole suite
 * twice, once on a clean copy and once with the defect injected. So the only
 * lever with a big enough payoff is running independent groups at the same time.
 *
 * WHY that is safe here: each `verify-negative.mjs` process copies the tree into
 * `tmpdir()/dsh-neg-verify-<pid>` and mutates only that copy. Two processes
 * therefore never touch the same bytes, so no locking is needed between them —
 * which is also why this script does NOT wrap the groups in `with-lock.sh`; the
 * lock would serialize them again and defeat the point.
 *
 * The one thing that MUST be shared and stable is the source tree itself:
 * `freshCopy()` copies `lib/` from the working tree, and the groups with
 * `build: true` rebuild inside their own copy. If someone rebuilds the working
 * tree while the copies are being taken, a group can start from a half-written
 * bundle and report `HARNESS BROKEN` — the harness blaming itself for someone
 * else's build. So the tree is pinned with one `pnpm build` up front, and this
 * script refuses to start while another process holds `.build-lock`.
 *
 * Residual risk, stated rather than hidden: the lock is released once that
 * initial build is done, so a DIFFERENT process that starts building during the
 * long parallel phase can still disturb the copies. That is the trade-off for
 * being able to run at all; re-checking the lock between groups would not close
 * it either.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCK_DIR = join(ROOT, '.build-lock')
const LOCK_HOLDER = join(LOCK_DIR, 'holder')

/**
 * Two by default, four at most.
 *
 * Each group runs a jsdom suite (or a headless browser), and this repository has
 * an on-record OOM kill at exit 137 from two React/jsdom suites at once on a
 * machine that was otherwise fine. The cap is a memory limit, not an arbitrary
 * taste: raising it trades wall-clock for a risk of the run dying with no
 * verdict, which is worse than a slow run.
 */
const DEFAULT_JOBS = 2
const MAX_JOBS = 4

/** `node scripts/verify-negative.mjs <group>` — the shape `test:negative` uses. */
const GROUP_IN_CHAIN = /verify-negative\.mjs[ \t]+([\w-]+)/g

function fail (lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

function parseArgs (argv) {
  const options = { jobs: DEFAULT_JOBS, only: null, verbose: false, skipBuild: false }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        fail([`verify-negative-parallel: ${arg} needs a value`])
      }
      index += 1
      return value
    }
    if (arg === '--jobs' || arg.startsWith('--jobs=')) {
      const raw = arg.startsWith('--jobs=') ? arg.slice('--jobs='.length) : next()
      const jobs = Number(raw)
      if (!Number.isInteger(jobs) || jobs < 1) {
        fail([`verify-negative-parallel: --jobs expects a whole number >= 1, got ${JSON.stringify(raw)}`])
      }
      // Clamping rather than rejecting: a caller asking for 8 is expressing "as
      // parallel as you can", and silently honouring it is how the OOM comes
      // back. Say so, then run at the ceiling.
      if (jobs > MAX_JOBS) {
        console.error(`verify-negative-parallel: --jobs ${jobs} clamped to ${MAX_JOBS} (memory, see DEFAULT_JOBS)`)
      }
      options.jobs = Math.min(jobs, MAX_JOBS)
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      const raw = arg.startsWith('--only=') ? arg.slice('--only='.length) : next()
      options.only = raw.split(',').map(name => name.trim()).filter(name => name !== '')
      if (options.only.length === 0) fail(['verify-negative-parallel: --only needs at least one group name'])
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--skip-build') {
      options.skipBuild = true
    } else {
      fail([`verify-negative-parallel: unknown argument ${JSON.stringify(arg)}`])
    }
  }
  return options
}

/**
 * The group list, read from `test:negative` rather than repeated here.
 *
 * A hardcoded list is a second copy of the same fact, and the copies drift in
 * the direction that hurts: a group added to the chain but not to this list is
 * simply never run in parallel, and the summary still says "all groups passed".
 */
function groupsFromChain (root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const chain = manifest.scripts?.['test:negative'] ?? ''
  const groups = [...chain.matchAll(GROUP_IN_CHAIN)].map(match => match[1])
  // Preserve the chain's order (the summary is printed in it) but drop repeats:
  // a group listed twice would run twice for no verdict anyone reads.
  const unique = [...new Set(groups)]
  if (unique.length === 0) {
    fail([
      'verify-negative-parallel: `test:negative` in package.json names no groups.',
      'Expected a chain like `node scripts/verify-negative.mjs <group> && …`.',
    ])
  }
  return unique
}

function lockHolder () {
  try {
    return readFileSync(LOCK_HOLDER, 'utf8').trim()
  } catch {
    return '(no holder file — the lock may be half-created or left over)'
  }
}

function runCommand (command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const collect = chunk => { out += String(chunk) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', error => resolve({ code: -1, out: `${out}\n${error.message}` }))
    child.on('close', code => resolve({ code: code ?? -1, out }))
  })
}

async function pinTree (root) {
  // Through `with-lock.sh` even though the lock was just checked: that check
  // closes the "someone is already building" window, this closes the "someone
  // starts building right now" one. Exit 75 is the lock script's "did not get
  // it", which must not be reported as a build failure — it points at a
  // concurrent run, and the fix is to wait rather than to debug the build.
  const result = await runCommand('bash', [join(root, 'scripts', 'with-lock.sh'), 'pnpm', 'build'], root)
  if (result.code === 75) {
    fail([
      'verify-negative-parallel: could not take .build-lock to pin the tree.',
      'Another run holds it. Wait for it to finish, then start this again.',
    ])
  }
  if (result.code !== 0) {
    return { ok: false, out: result.out }
  }
  return { ok: true, out: result.out }
}

/** Run one group, capturing everything it prints so groups cannot interleave. */
function runGroup (root, name) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(root, 'scripts', 'verify-negative.mjs'), name], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const collect = chunk => { out += String(chunk) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const finish = code => resolve({ name, ok: code === 0, code, ms: Date.now() - started, out, child: null })
    child.on('error', error => finish(-1, error))
    child.on('close', code => {
      live.delete(child)
      finish(code ?? -1, null)
    })
    live.add(child)
  })
}

/** Children still running, so an interrupt does not orphan a fleet of suites. */
const live = new Set()

async function runPool (root, groups, jobs, progress) {
  const results = groups.map(name => ({ name, ok: false, code: -1, ms: 0, out: '', done: false }))
  let next = 0
  const workers = Array.from({ length: Math.min(jobs, groups.length) }, async () => {
    while (true) {
      // Read-and-increment before any await, so two workers cannot claim the
      // same index even though this function is async.
      const index = next
      next += 1
      if (index >= groups.length) return
      const result = await runGroup(root, groups[index])
      results[index] = result
      progress(result, results.filter(entry => entry.done || entry.ms > 0).length)
    }
  })
  await Promise.all(workers)
  return results
}

function formatSeconds (ms) {
  // Integer seconds: at this scale sub-second precision is noise, and the
  // comparison being made is "minutes versus an afternoon".
  return `${Math.round(ms / 1000)}s`
}

async function main () {
  const options = parseArgs(process.argv)
  const allGroups = groupsFromChain(ROOT)
  const groups = options.only === null ? allGroups : options.only
  if (options.only !== null) {
    const unknown = groups.filter(name => !allGroups.includes(name))
    if (unknown.length > 0) {
      fail([
        `verify-negative-parallel: not a group in \`test:negative\`: ${unknown.join(', ')}`,
        `Known groups: ${allGroups.join(', ')}`,
      ])
    }
  }

  // Checked before the build, not after: the answer the caller needs is "this
  // tree is busy, come back", and that should arrive in a second rather than
  // after a build has queued behind the lock for half an hour.
  if (existsSync(LOCK_DIR)) {
    fail([
      'verify-negative-parallel: .build-lock is held, so this tree is being changed right now.',
      `  holder: ${lockHolder()}`,
      'Refusing to start: the group copies take lib/ from the working tree, and',
      'copying it mid-build makes a group report HARNESS BROKEN about its own',
      'harness. Wait for the other run, or remove .build-lock by hand if its',
      'process is gone.',
    ])
  }

  if (!options.skipBuild) {
    console.log(`pinning the tree with one build before ${groups.length} groups…`)
    const pinned = await pinTree(ROOT)
    if (!pinned.ok) {
      fail([
        'verify-negative-parallel: `pnpm build` failed, so the tree cannot be pinned.',
        'Running the groups anyway would let them copy a half-written lib/, which',
        'reads as a broken harness rather than a broken build. Output:',
        '',
        pinned.out.trim(),
      ])
    }
  }

  const startedAt = Date.now()
  console.log(`reverse verification: ${groups.length} groups, ${options.jobs} at a time\n`)

  // Progress goes to stderr one line at a time. The suite prints nothing until
  // a group finishes, and a 20-minute run with no output is indistinguishable
  // from a hang -- which is how the previous attempt got killed while it was
  // working. This is not group output, so it cannot interleave with it.
  const progress = (result, doneCount) => {
    const mark = result.ok ? 'ok  ' : 'FAIL'
    process.stderr.write(`  [${doneCount}/${groups.length}] ${mark} ${result.name} (${formatSeconds(result.ms)})\n`)
  }

  const results = await runPool(ROOT, groups, options.jobs, progress)
  const wallMs = Date.now() - startedAt

  // Printed in the chain's order, not the order groups happened to finish: two
  // runs of the same tree should produce the same report, or the report becomes
  // something to interpret instead of something to read.
  console.log('\n' + '='.repeat(64))
  for (const result of results) {
    const mark = result.ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${result.name.padEnd(16)} ${formatSeconds(result.ms)}`)
    if (!result.ok) {
      // A failing group is the only thing worth reading in full; a passing one
      // is a line. `--verbose` overrides when the whole log is wanted.
      console.log(result.out.trimEnd().split('\n').map(line => `      ${line}`).join('\n'))
    } else if (options.verbose) {
      console.log(result.out.trimEnd().split('\n').map(line => `      ${line}`).join('\n'))
    }
  }
  console.log('='.repeat(64))

  const passed = results.filter(result => result.ok).length
  // The serial figure is the SUM of what each group actually took, not a guess:
  // that is exactly what the `&&` chain would have cost on this machine now.
  const serialMs = results.reduce((total, result) => total + result.ms, 0)
  console.log(`${passed}/${results.length} groups passed`)
  console.log(`wall ${formatSeconds(wallMs)} vs ${formatSeconds(serialMs)} if run one after another (${(serialMs / wallMs).toFixed(1)}x)`)
  if (options.jobs > 1 && serialMs / wallMs < 1.3) {
    // Say WHY, with the number that matters. On this repository the answer has
    // been one group: `contracts` took 577s while the other thirteen together
    // took 44s, so raising --jobs cannot help — the wall clock is that single
    // group's inner loop. Naming it here saves the next person from measuring it
    // again, and points at the real fix (let a case run only the check it
    // targets) instead of a bigger pool.
    const slowest = results.reduce((worst, result) => (result.ms > worst.ms ? result : worst), results[0])
    const share = Math.round((slowest.ms / serialMs) * 100)
    console.log(
      `note: the limit is one group, not the schedule — "${slowest.name}" alone took `
      + `${formatSeconds(slowest.ms)} (${share}% of the serial total). Raising --jobs cannot beat it;`,
    )
    console.log('      cutting per-case work inside that group can.')
  }
  process.exit(passed === results.length ? 0 : 1)
}

// Interrupt handling: without this, Ctrl-C leaves up to `jobs` suites running in
// their own temp copies, still burning CPU and still holding their own copies —
// the next run then competes with ghosts.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of live) child.kill('SIGTERM')
    process.exit(130)
  })
}

main().catch(error => fail([`verify-negative-parallel: ${error.stack ?? error.message}`]))

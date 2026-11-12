// Every script here is a guard. A guard nothing runs is a comment.
//
// This has now happened twice in this repository: `verify-check-harness.mjs`
// was written to pin the shared check executor's rules and never called from
// anywhere, so the rules it described were enforced by nothing; and the three
// canvas suites written alongside the react-flow migration and the export
// feature were in no gate at all. Both times the file existed, passed when run
// by hand, and protected nothing -- the failure is invisible from inside the
// script, because a script cannot observe that it is never started.
//
// So reachability is checked from OUTSIDE, structurally, and only from the
// places that actually execute things:
//
//   * package.json scripts  -- the literal `node scripts/<x>.mjs` commands
//   * .github/workflows/*   -- the literal `run:` commands
//   * verify-negative.mjs   -- its RUNNERS table, but only for a group that
//                              `test:negative` really invokes
//
// Deliberately NOT scanned: free text, other scripts' source, README, docs.
// A mention is not an execution, and counting mentions is how this guard would
// end up certifying the very thing it exists to catch. (Every orphan above had
// its own `Run: node scripts/...` header comment, so a mention-based rule
// would have declared all of them healthy.)
//
// A script that genuinely must not run automatically says so below, with the
// reason. Declaring one as manual is a claim, not a silencer: a script marked
// manual that IS reachable fails too, because that means the invocation was
// deleted and the label was never updated.
//
// Run: node scripts/verify-script-entries.mjs [--verbose]
// Exit 0 = every script is reachable or declared, 1 = something is not.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VERBOSE = process.argv.includes('--verbose')

/**
 * Scripts that must not run in a gate, and why. Only the second half of each
 * sentence is useful to a reader: "when this is supposed to run".
 */
const MANUAL = {
  'studio-preview-shot.mjs':
    'produces a screenshot for a human to look at; it has no verdict to assert',
  // These four were previously counted as gated only because their command
  // existed in `package.json`. None of them runs in any workflow, and none
  // should: three have side effects (network, rewriting files) and the fourth
  // needs a tool the repository does not depend on. Naming them here is the
  // honest record of "a person runs this, on purpose".
  'fetch-templates.mjs':
    'refreshes the bundled prompt-template snapshots from the network; run by hand when those sources change',
  'upstream-sync.mjs':
    'checks the upstream project and writes a port plan; the README calls it a manual command, and it must never decide a push',
  'ppt-browser-test.mjs':
    'needs Playwright, which this repository does not depend on; its own header says it is deliberately outside `pnpm test`',
}

/* ------------------------------------------------------------ reachability */

/** `node [flags] scripts/x.mjs` and `node --test scripts/x.mjs`. */
const NODE_INVOCATION = /\bnode(?:[ \t]+--?[^\s]+)*[ \t]+scripts\/([\w.-]+\.mjs)\b/g

function invocationsIn(text) {
  const found = new Set()
  for (const match of text.matchAll(NODE_INVOCATION)) found.add(match[1])
  return found
}

/** Every command string a package.json script would run. */
function packageCommands(pkg) {
  return Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({ name, command }))
}

/**
 * The `package.json` scripts that actually run inside a gate.
 *
 * WHY this is not "all of them": a script is an entry point, not a gate. Until
 * this distinction existed, defining `"test:ppt-browser": "node scripts/…"` was
 * enough to make that file count as reachable — even though no workflow invoked
 * it and no other script chained to it. `ppt-browser-test.mjs` says in its own
 * header that it is "deliberately NOT part of `pnpm test`", and it needs
 * Playwright, which this repository does not depend on; it was a hand-run entry
 * wearing a gate's badge. A guard that cannot tell those apart reports "every
 * script is reachable" over a set that is partly fiction.
 *
 * A script counts when a workflow runs it (`pnpm test`) or when another script
 * that counts invokes it (`test:components` is only reached through nothing —
 * see below — so it must name its own gate to qualify).
 *
 * @param {ReturnType<typeof packageCommands>} scripts
 * @param {readonly string[]} workflowTexts - raw YAML of every workflow.
 */
function gatedPackageScripts(scripts, workflowTexts) {
  const byName = new Map(scripts.map(entry => [entry.name, entry.command]))
  const gated = new Set()
  const queue = []
  // Seeds: a script whose name a workflow reaches for with `pnpm <name>` or
  // `pnpm run <name>`, PLUS the suites that are a documented full run even
  // though no workflow schedules them. `test:negative` is the latter: 137
  // reverse-verification cases that a person runs, that the README lists, and
  // that `verify-negative-anchors` keeps honest. Leaving it out would report
  // `verify-negative.mjs` as orphaned, which is untrue and would push someone
  // to add it to CI under a name that does not work there.
  //
  // `verify-negative-parallel.mjs` is the same kind of entry: it runs exactly
  // those groups, several at a time, and is run by hand. It is not chained FROM
  // `test:negative` (it is the faster alternative to it), so it has to be named
  // as a gate root itself rather than discovered through the closure.
  const MANUALLY_GATED_SUITES = ['test:negative']
  // A gate root that is itself a script, not a package.json entry: nothing
  // invokes it, a person types `node scripts/<name>`. `test:negative` is a
  // chain of `verify-negative.mjs <group>`; this is the same work, several
  // groups at a time. It cannot be discovered through the closure above (it
  // does not appear in package.json at all), so it is named here.
  const MANUAL_GATE_ROOTS = ['verify-negative-parallel.mjs']
  for (const text of workflowTexts) {
    for (const match of text.matchAll(/\bpnpm(?:[ \t]+run)?[ \t]+([\w:@./-]+)/g)) {
      const name = match[1]
      if (byName.has(name)) queue.push(name)
    }
  }
  for (const name of MANUALLY_GATED_SUITES) {
    if (byName.has(name)) queue.push(name)
  }
  // Transitive: `test` chains `pnpm build`; anything it names is gated too.
  while (queue.length > 0) {
    const name = queue.pop()
    if (gated.has(name)) continue
    gated.add(name)
    const command = byName.get(name) ?? ''
    for (const match of command.matchAll(/\bpnpm(?:[ \t]+run)?[ \t]+([\w:@./-]+)/g)) {
      if (byName.has(match[1])) queue.push(match[1])
    }
  }
  return {
    scripts: scripts.filter(entry => gated.has(entry.name)),
    roots: MANUAL_GATE_ROOTS,
  }
}

/**
 * Workflow commands, comment lines dropped. A `# run: node scripts/x` inside a
 * step is documentation about a command someone used once, not a gate.
 */
function workflowCommands() {
  const dir = join(ROOT, '.github', 'workflows')
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file)) continue
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    for (const line of lines) {
      if (line.trimStart().startsWith('#')) continue
      out.push({ name: `.github/workflows/${file}`, command: line })
    }
  }
  return out
}

/**
 * The RUNNERS table's `script:` literals, but only for groups `test:negative`
 * actually invokes. A group that is defined and never called protects nothing,
 * and counting its scripts as reachable would launder that.
 */
function negativeCommands(pkg, reached) {
  if (!reached.has('verify-negative.mjs')) return []
  const negative = readFileSync(join(ROOT, 'scripts', 'verify-negative.mjs'), 'utf8')
  const chain = pkg.scripts?.['test:negative'] ?? ''
  const called = new Set([...chain.matchAll(/verify-negative\.mjs[ \t]+([\w-]+)/g)].map(m => m[1]))

  const out = []
  const table = negative.slice(negative.indexOf('const RUNNERS'))
  const body = table.slice(0, table.indexOf('\n}\n') + 1)
  const groups = [...body.matchAll(/^\s{2}'?([\w-]+)'?:\s*\{([^}]*)\}/gm)]
  for (const [, group, fields] of groups) {
    const script = fields.match(/script:\s*'scripts\/([\w.-]+\.mjs)'/)
    if (script === null) continue
    // A group the chain does not call protects nothing: counting its script
    // would launder exactly the deletion this exists to catch.
    if (!called.has(group)) continue
    out.push({ name: `verify-negative:${group}`, command: `node scripts/${script[1]}` })
  }
  return out
}

/* ---------------------------------------------------------------- the check */

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const scripts = readdirSync(join(ROOT, 'scripts'))
    .filter(file => file.endsWith('.mjs'))
    .sort()

  const reached = new Map()
  const record = (file, where) => {
    if (!reached.has(file)) reached.set(file, new Set())
    reached.get(file).add(where)
  }

  const workflowTexts = []
  {
    const dir = join(ROOT, '.github', 'workflows')
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!/\.ya?ml$/.test(file)) continue
        workflowTexts.push(readFileSync(join(dir, file), 'utf8'))
      }
    }
  }

  // A gate root that is itself a script (not a package.json entry). Recorded
  // rather than discovered through `invocationsIn`, because nothing invokes it:
  // a person types `node scripts/<name>`.
  const gatedNow = gatedPackageScripts(packageCommands(pkg), workflowTexts)
  for (const root of gatedNow.roots) record(root, 'manual gate root')

  for (const { name, command } of gatedNow.scripts) {
    for (const file of invocationsIn(command)) record(file, `package.json → ${name}`)
  }
  for (const { name, command } of workflowCommands()) {
    for (const file of invocationsIn(command)) record(file, name)
  }
  // verify-negative's table is only meaningful once verify-negative is itself
  // reachable, so this runs last and reads the set built above.
  for (const { name, command } of negativeCommands(pkg, reached)) {
    for (const file of invocationsIn(command)) record(file, name)
  }

  const problems = []
  const manual = []

  for (const file of scripts) {
    const declared = MANUAL[file]
    const reachable = reached.get(file)

    if (declared !== undefined && reachable !== undefined) {
      problems.push(
        `${file} is declared manual but IS reachable via ${[...reachable].join(', ')} — ` +
        `either the invocation should go, or the declaration is stale`,
      )
      continue
    }
    if (declared !== undefined) {
      manual.push(`${file} — ${declared}`)
      continue
    }
    if (reachable === undefined) {
      problems.push(
        `${file} is in no gate and not declared manual — nothing runs it, ` +
        `so whatever it guards is unguarded`,
      )
    }
  }

  // A declaration for a file that no longer exists is a claim about nothing,
  // and it hides the fact that the guard it named was deleted.
  for (const file of Object.keys(MANUAL)) {
    if (!scripts.includes(file)) problems.push(`MANUAL declares ${file}, which does not exist`)
  }

  if (VERBOSE) {
    for (const file of scripts) {
      const where = reached.get(file)
      if (where !== undefined) console.log(`  ${file}\n      ← ${[...where].join(', ')}`)
    }
    console.log()
  }

  console.log(`script entries: ${scripts.length} scripts, ${reached.size} reachable, ${manual.length} manual`)

  if (problems.length > 0) {
    for (const problem of problems) console.log(`FAIL  ${problem}`)
    console.log(`\n${problems.length} of ${scripts.length} scripts are not wired in`)
    process.exit(1)
  }

  for (const line of manual) console.log(`manual  ${line}`)
  console.log('\nevery script is either executed by a gate or declared manual')
}

main()

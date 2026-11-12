#!/usr/bin/env node
/**
 * Every reverse-verification case names a defect by quoting the code it breaks.
 * `verify-negative.mjs` applies that quote to a copy of the repo and requires the
 * suite to turn red — but only for the ONE group being run. So an anchor that
 * has drifted (a line inserted between two that a case quoted together, a helper
 * moved to another file, a rename) does not fail anything until that group is
 * scheduled. The pack group sat like that: three of its five cases were
 * `HARNESS BROKEN` ("anchor not found") and nobody saw it, because the reverse
 * verification never runs in CI and `test:negative` runs the groups one at a
 * time by hand.
 *
 * This guard asks a much cheaper question, with no suites and no repo copy:
 * does every `from` (and every `also[].from`) still appear verbatim in the file
 * the case points at? That is exactly the condition `patch()` needs, and a
 * missing one is a drifted anchor, not a real failure. It runs in seconds, so it
 * can sit in `pnpm test` and catch the drift the day it is introduced.
 *
 * It deliberately does NOT check that the mutation still makes the check red —
 * that needs the suites, and it is what `verify-negative.mjs` is for. This guard
 * only makes sure those cases are still able to run at all.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { canvasSourceFiles } from './lib/canvas-source.mjs'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const NEGATIVE = join(SRC, 'scripts', 'verify-negative.mjs')

/** Same value as `CANVAS_GROUP` in verify-negative.mjs: a case with this `file`
 *  may quote code from any module under `src/client/canvas/`, because moving a
 *  helper there is not a behaviour change. */
const CANVAS_GROUP = 'src/client/canvas'

/** Where a case's `from` may live, mirroring `locate()` in verify-negative.mjs.
 *  Kept as a list of candidate paths; the anchor counts as present when ANY of
 *  them contains it. */
function candidatesFor (relative) {
  return relative === CANVAS_GROUP
    ? canvasSourceFiles().map(file => join('src/client', file))
    : [relative]
}

/** Evaluate the `CASES` literal out of verify-negative.mjs.
 *
 *  Importing that module is not an option: it is a program whose top level makes
 *  a repo copy and runs suites, so a plain `import` would start a full run. The
 *  array is a literal with no calls, so slicing it out and evaluating it here
 *  gives the real table without any of that. If the slice ever stops parsing,
 *  the guard fails loudly instead of silently checking nothing. */
function loadCases () {
  const source = readFileSync(NEGATIVE, 'utf8')
  const start = source.indexOf('\nconst CASES = [')
  const end = source.indexOf('\nconst RUNNERS = {')
  if (start < 0 || end < 0) {
    throw new Error('could not locate the CASES table in verify-negative.mjs (the markers moved)')
  }
  // Slice from the declaration through the end of the array literal. Starting
  // at the newline means the slice opens with `const CASES = [` as written.
  const literal = source.slice(start + 1, end)
  // The table is a literal, but a few entries build their payload with helpers
  // defined above it. Recreate those few rather than pulling in the module:
  // they are three small pure functions, and copying their source would drift.
  const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
  const sandbox = {
    // Same body as verify-negative.mjs: an import specifier assembled at runtime
    // so no real broken import appears in this file's own source.
    importFrom: specifier => ['from', ["'", '.', specifier, "'"].join('')].join(' '),
    SRC_VERSION: pkg.version,
    bumped: (version, by) => {
      const [major, minor, patch] = version.split('.').map(Number)
      return `${major}.${minor}.${patch + by}`
    },
  }
  vm.runInNewContext(`${literal}\nthis.CASES = CASES`, sandbox)
  return sandbox.CASES
}

const cases = loadCases()
const files = new Map()
const read = relative => {
  if (!files.has(relative)) {
    const path = join(SRC, relative)
    files.set(relative, existsSync(path) ? readFileSync(path, 'utf8') : null)
  }
  return files.get(relative)
}

const problems = []
for (const testCase of cases) {
  const anchors = []
  const froms = Array.isArray(testCase.from) ? testCase.from : [testCase.from]
  for (const from of froms) anchors.push(['from', from])
  for (const extra of testCase.also ?? []) {
    const alsoFroms = Array.isArray(extra.from) ? extra.from : [extra.from]
    for (const from of alsoFroms) anchors.push([`also (${extra.file})`, from, extra.file])
  }
  anchors.forEach(([label, anchor, ownFile]) => {
    const relative = ownFile ?? testCase.file
    const candidates = candidatesFor(relative)
    const found = candidates.some(candidate => read(candidate)?.includes(anchor))
    if (found) return
    const missingFile = candidates.every(candidate => read(candidate) === null)
    problems.push({
      name: testCase.name,
      label,
      file: relative,
      missingFile,
      anchor,
    })
  })
}

console.log(`anchor reachability: ${cases.length} cases, ${cases.length - new Set(problems.map(p => p.name)).size} intact`)
if (problems.length > 0) {
  console.log('='.repeat(64))
  for (const problem of problems) {
    const where = problem.missingFile
      ? `${problem.file} does not exist`
      : `no candidate file contains it (${problem.file})`
    console.log(`FAIL  ${problem.name}`)
    console.log(`      ${problem.label} anchor: ${where}`)
    console.log(`      ${JSON.stringify(problem.anchor.slice(0, 90))}`)
  }
  console.log('='.repeat(64))
  console.log('A case whose anchor no longer exists cannot run: verify-negative.mjs')
  console.log('would report HARNESS BROKEN for it, and only when that group is run.')
  console.log('Re-point the anchor at the code that carries the defect today.')
  process.exit(1)
}
console.log('every reverse-verification anchor still matches the tree')

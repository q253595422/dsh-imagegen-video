/**
 * Every file a script imports must be IN the repository.
 *
 * WHY this exists: `.gitignore` had an unanchored `lib/`, which also matches
 * `scripts/lib/`. `scripts/lib/headless-chrome.mjs` was therefore never
 * committed — three guard scripts import it, so a clean clone died with
 * `ERR_MODULE_NOT_FOUND` while the author's working tree was perfectly green.
 * Nothing in the suite could see it, because the file was on exactly one disk.
 *
 * The two halves are different questions and both are asked:
 *
 *  1. For every relative import under `scripts/` and `src/`, the target must
 *     exist AND be tracked by git. "It works on my machine" is exactly what an
 *     untracked-but-imported file looks like.
 *  2. No file under `src/`, `scripts/` or `docs/` may be sitting in the tree
 *     untracked and un-ignored. That is the look of a new source file somebody
 *     forgot to `git add` before pushing.
 *
 * A directory that is not a git checkout (an unpacked tarball) SKIPS with an
 * explicit line rather than passing: a check that quietly does nothing on the
 * machine that needs it is worse than no check.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Git's spelling of a path, which is posix on every platform.
 *
 * `git ls-files` separates with `/` even on Windows; `path.relative` separates
 * with `sep`, so there it answers `src\protocol.ts`. Feeding the two into the
 * same `Set.has()` made every single tracked file read as untracked — the guard
 * reported 150 missing files in a repository that contained all 150.
 */
const toPosix = value => value.split(sep).join('/')

function git (...args) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

try {
  git('rev-parse', '--is-inside-work-tree')
} catch {
  console.log('SKIP  not a git checkout: imported-file tracking was NOT verified.')
  process.exit(0)
}

const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean))

/** Every source file whose imports have to resolve. */
function walk (dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:mjs|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'src'))]

// Relative specifiers only: a bare package name is resolved by the package
// manager and has no file in this tree to point at.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g

const problems = []
/**
 * Resolve a relative specifier the way the bundler does.
 *
 * TypeScript's ES-module style writes `./oauth.js` for the file `oauth.ts`
 * (`allowImportingTsExtensions` means this repo usually spells the real
 * extension, but the subscription modules keep the emitted-name convention).
 * Without this the check reports every one of them as missing, which is the
 * kind of false alarm that gets a guard deleted.
 */
function candidates (from, specifier) {
  const base = resolve(dirname(from), specifier)
  const list = [base]
  const js = /\.(?:js|mjs|cjs)$/.exec(base)
  if (js !== null) {
    const stem = base.slice(0, js.index)
    list.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mjs`)
  } else if (!/\.(?:mjs|ts|tsx)$/.test(base)) {
    list.push(`${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, 'index.ts'))
  }
  return list
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1]
    const rel = toPosix(relative(ROOT, file))
    const options = candidates(file, specifier)
    // Any one candidate being tracked is enough: the import resolves.
    if (options.some(option => tracked.has(toPosix(relative(ROOT, option))))) continue
    // Not tracked. Name the one the author most likely meant, but only report
    // it when NOTHING in the candidate set is tracked.
    problems.push(`${rel} imports ${specifier} -> ${toPosix(relative(ROOT, options[0]))}, which is not in the repository`)
  }
}

// Untracked-and-not-ignored: a file that would simply not travel with the code.
//
// Scoped to `src/`, `scripts/` and `docs/` on purpose. A scratch note at the
// repository root is nobody's bug, but a source file that was never `git add`ed
// is exactly the shape of the incident this guard exists for -- and it would
// otherwise only surface after pushing.
//
// `docs/` is checked for untracked files but NOT added to the import walk above:
// what lives there is demo pages and their render scripts, whose specifiers are
// mostly assets resolved by a browser, not modules resolved by the bundler. Rule
// 1 over that tree would report every `<img src="...">`-shaped reference as a
// missing import -- a false alarm loud enough to get the whole guard deleted.
// The gap that mattered is already closed from the other side: the modules those
// pages DO import live under `scripts/lib/`, and rule 1 covers them there.
const GUARDED = ['src/', 'scripts/', 'docs/']

// `-z` rather than newline records: with the default `core.quotePath=true` git
// wraps any path holding a non-ASCII byte in quotes and escapes it to octal, so
// `docs/推广片-备注.md` arrives as `"docs/\346\216\250..."`. That string starts
// with `"`, not `docs/`, and the prefix test below silently skipped the file --
// on a fresh machine, for exactly the filenames this repository uses. `-z` hands
// over the raw bytes, one record per NUL, with no quoting to undo.
for (const record of git('status', '--porcelain', '-z', '--untracked-files=all').split('\0')) {
  if (!record.startsWith('?? ')) continue
  const path = record.slice(3)
  if (GUARDED.some(prefix => path.startsWith(prefix))) {
    problems.push(`${path} is in the tree but neither committed nor ignored -- git add it, or add it to .gitignore if it is generated`)
  }
}

if (problems.length > 0) {
  console.error('\nFAIL: a file this code needs is not in the repository.')
  console.error([...new Set(problems)].map(line => `  ${line}`).join('\n'))
  console.error('A clean clone does not have it, so the failure lands on somebody else\'s')
  console.error('machine first -- an ERR_MODULE_NOT_FOUND, or a page missing an asset --')
  console.error('with an error that names the missing file and not this rule.')
  process.exit(1)
}

console.log(`imports tracked: ${files.length} source files, every relative import is committed; no untracked files under ${GUARDED.join(', ')}`)

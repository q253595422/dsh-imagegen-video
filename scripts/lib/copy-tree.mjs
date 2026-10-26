/**
 * Recursively copy a file or a directory tree.
 *
 * WHY this is not `cpSync(from, to, { recursive: true })`: on Windows that call
 * made the process disappear with exit code 127 and not one byte on stdout or
 * stderr — no exception, so neither `try/catch` nor an `'uncaughtException'`
 * handler could see it — while this walk copied the same tree fine. The caller
 * is `scripts/verify-reproducible.mjs`, which mirrors the source tree into a
 * second directory to prove the build does not depend on where it runs; a copy
 * that dies silently takes the whole check with it and leaves nothing to read.
 *
 * Symlinks are followed rather than reproduced, which is what the mirror wants:
 * it points `node_modules` back at the original explicitly, and everything else
 * it copies is ordinary files.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Copy `from` to `to`, creating every parent directory on the way.
 *
 * `to` is replaced when it exists, so a caller may copy into a directory it has
 * already started populating.
 */
export function copyTree (from, to) {
  if (!statSync(from).isDirectory()) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    return
  }
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    copyTree(join(from, entry), join(to, entry))
  }
}

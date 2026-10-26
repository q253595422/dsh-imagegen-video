/**
 * Read a source file the way the guards' regexes assume it looks.
 *
 * Every cross-line pattern in these scripts is written with `\n`, because that
 * is what the file has on the machines the guards were developed on. Git hands
 * a Windows checkout CRLF line endings whenever `core.autocrlf=true` (still the
 * default of Git for Windows), and then `/^\s{4}id: ...,\n\s{4}label: .../m`
 * matches nothing -- the file is right there on disk, the guard says a source
 * has no label, and the reader goes looking for a bug in the registry.
 *
 * Normalising once, at the read, is the fix that survives: a new pattern added
 * later inherits it, whereas patching each regex with `\r?` leaves the next one
 * to be written wrong. `.gitattributes` (`* text=auto eol=lf`) keeps the
 * working tree LF as well, but the guards must not depend on it -- CI checks out
 * with whatever attributes the commit has, and a stale clone has none.
 *
 * Text only. JSON fixtures, images and anything served as bytes must be read
 * raw: rewriting their line endings changes the bytes they are compared on.
 */

import { readFileSync } from 'node:fs'

/**
 * @param {string | URL} path - file to read.
 * @returns {string} the file's text with every line ending normalised to `\n`.
 */
export function readSourceText (path) {
  // A lone CR is not a line ending Git produces, but a file saved by an old
  // Windows editor has them, and `\n`-based patterns fail on those the same way.
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
}

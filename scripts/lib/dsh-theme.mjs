/**
 * Find the installed DSH shell's theme stylesheet, for the visual harnesses.
 *
 * Both `studio-preview-shot.mjs` (the full acceptance suite) and
 * `studio-canvas-shot.mjs` (the canvas first-run shot) need the same thing: the
 * REAL `--dsw-alias-*` tokens, so what they photograph is the studio as the
 * shell paints it. Without them every token resolves to nothing, and the
 * picture is quietly wrong in a way that looks like a stylesheet bug in the
 * canvas: cards lose their fill and border, so a first-run screenshot shows
 * floating text on white and reads as "the node styles are broken".
 *
 * WHY the tokens come out of a JS string rather than a `.css` file: DSH ships
 * stylesheets as `const css = "…"` constants inside its client bundle and
 * injects them as `<style>` tags, so there is no stylesheet on disk to read.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const THEME_PACKAGE = 'dsh-client-ui-theme'

/**
 * Version of a package directory.
 *
 * Throws rather than returning a placeholder: every caller has already checked
 * that the directory exists, so an unreadable manifest is a broken cache, not a
 * package that is "not there". Answering `null` here would sort that cache last
 * and silently photograph the shot with an older palette — a wrong picture with
 * no trace of why.
 */
function versionOf(directory) {
  const manifest = join(directory, 'package.json')
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof parsed.version !== 'string') throw new Error(`${manifest} has no version`)
  return parsed.version
}

/**
 * A `node_modules` tree that contains an installed DSH.
 *
 * The two fixed locations come first because they are where a packaged app and
 * the documented dev checkout put it. The npx cache is the fallback that makes
 * this work on a machine with the desktop app installed but nothing unpacked:
 * `dsh` run through `npx` leaves a complete `@deepseek-ai` tree there, and it is
 * the only copy on disk. Several caches can exist side by side, so they are
 * ordered by the theme package's version rather than by mtime — an older
 * directory touched more recently would otherwise win and paint the shot with
 * a stale palette.
 */
export function dshNodeModules(env = process.env) {
  const theme = `@deepseek-ai/${THEME_PACKAGE}`
  const fixed = [
    env.DSH_ASAR_DIR,
    '/tmp/dshnative/dsh/node_modules',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  ].filter((dir) => typeof dir === 'string' && dir !== '')
  const found = fixed.find(dir => existsSync(join(dir, theme)))
  if (found !== undefined) return found

  const cached = globSync(join(env.HOME ?? '', '.npm/_npx/*/node_modules'))
    .filter(dir => existsSync(join(dir, theme)))
    .map(dir => ({ dir, version: versionOf(join(dir, theme)) ?? '' }))
    // Newest first. `localeCompare` with numeric collation so 0.2.10 > 0.2.9.
    .sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }))
  return cached[0]?.dir ?? null
}

/** Every theme stylesheet, in the order the theme package injects them. */
export function themeCss(nodeModules) {
  const file = join(nodeModules, '@deepseek-ai', THEME_PACKAGE, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  const pattern = /^\s*var\s+(\w*_css_default)\s*=\s*("(?:[^"\\]|\\.)*");?\s*$/gm
  const blocks = []
  let match
  while ((match = pattern.exec(source)) !== null) blocks.push(JSON.parse(match[2]))
  if (blocks.length === 0) throw new Error('theme package: no inlined CSS constants')
  return blocks.join('\n')
}

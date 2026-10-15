import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_ROOT = path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), 'dsh-imagegen')
let root = DEFAULT_ROOT

export function imageDataRoot(): string { return root }

export function setImageDataRoot(value: string | undefined): void {
  const trimmed = value?.trim()
  root = trimmed === undefined || trimmed === '' ? DEFAULT_ROOT : path.resolve(expandHome(trimmed))
}

/**
 * Expand a leading `~` before the path is resolved.
 *
 * The setting is typed by hand into the settings form, where `~/my-images` is
 * the natural thing to write. `path.resolve` does NOT expand it, so without
 * this the host would create a directory literally named `~` under the
 * process's working directory and store everything there — while the user
 * looked in their home folder and found nothing.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  // A `~user` form is left alone: resolving another user's home is not
  // something this setting should be doing.
  return value
}

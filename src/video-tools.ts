/**
 * Shared ffmpeg/ffprobe plumbing for the host's video paths.
 *
 * Two callers need the same three things: resolve `ffmpeg`/`ffprobe` to an
 * absolute path, run a child process without a shell and with a hard timeout,
 * and read its bounded output. `clip-compose.ts` had all three privately, and
 * poster extraction (`video-poster.ts`) needs them too — this is that code,
 * moved verbatim rather than copied, so there is one implementation to reason
 * about.
 *
 * Why the extraction is worth it and not just a copy:
 *
 *  - the timeout behaviour is the part that must not be re-derived. The host
 *    machine has no `timeout(1)` command, so a child that hangs has to be
 *    killed by our own timer; a second hand-written version of that race is a
 *    second place to get it wrong.
 *  - `localVideoToolDirs()` is a published export of `src/index.ts`, so it
 *    stays here behind the same name and signature.
 *
 * `clip-compose.ts` keeps its behaviour exactly: it still resolves tools the
 * same way and still runs every invocation through the same function.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants as FS_CONSTANTS, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Cap on captured process output, per stream (bad inputs can be very loud). */
const MAX_PROCESS_OUTPUT = 8_000

/** Cap on the diagnostic tail kept for one failure message. */
const MAX_ERROR_TAIL = 600

/** Tool names this module knows how to locate. */
export type VideoToolName = 'ffmpeg' | 'ffprobe'

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Absolute directories searched for `ffmpeg`/`ffprobe`, in order.
 *
 * `~/.local/bin` first because that is where this machine actually keeps them;
 * a bare command name is never tried, since the host's PATH cannot see it.
 */
export function localVideoToolDirs(): string[] {
  const dirs = [
    path.join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
  return [...new Set(dirs)]
}

/** Last printable characters of process output, for an error message. */
export function tail(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '(no output)'
  return trimmed.length <= MAX_ERROR_TAIL ? trimmed : `…${trimmed.slice(-MAX_ERROR_TAIL)}`
}

/**
 * Run one child process without a shell and collect its bounded output.
 *
 * Rejects on spawn failure, on the timeout, and on abort; a non-zero exit is
 * reported through `code` so callers can distinguish "ran and refused" from
 * "never ran". Modeled on `src/skill-store.ts` `run()`.
 * @param command - absolute executable path.
 * @param args - argument vector, never a shell string.
 * @param options - timeout and cancellation.
 */
export function runProcess(command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
  const label = path.basename(command)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdout = ''
    let stderr = ''
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk.toString('utf8')
    })
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      settle()
    }
    function onAbort(): void {
      child.kill()
      finish(() => reject(new Error(`${label} was cancelled`)))
    }
    timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`${label} timed out after ${options.timeoutMs}ms`)))
    }, options.timeoutMs)
    timer.unref?.()
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', error => finish(() => reject(new Error(`${label} could not start: ${error.message}`))))
    child.on('close', code => finish(() => resolve({ code: code ?? -1, stdout, stderr })))
  })
}

/** First executable candidate for one tool name, or undefined. */
export function findTool(name: VideoToolName): string | undefined {
  for (const dir of localVideoToolDirs()) {
    const candidate = path.join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, FS_CONSTANTS.X_OK)
      return candidate
    } catch { /* not here — keep looking */ }
  }
  return undefined
}

/** The resolved pair, looked up once per caller and cached. */
export interface ToolPair {
  ffmpeg?: string
  ffprobe?: string
}

/** Human-readable summary of what was found and where it was searched. */
export function describeTools(found: ToolPair): string {
  const ffmpeg = found.ffmpeg ?? 'not found'
  const ffprobe = found.ffprobe ?? 'not found'
  return `ffmpeg: ${ffmpeg}; ffprobe: ${ffprobe} (searched ${localVideoToolDirs().join(', ')})`
}

/** Cap on captured process output, re-exported for callers building budgets. */
export const MAX_PROCESS_OUTPUT_BYTES = MAX_PROCESS_OUTPUT

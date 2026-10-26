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
 * Which platform a lookup should behave as.
 *
 * Injected rather than read from `process.platform` at each use, because the
 * rules that differ — the `.exe` suffix, whether an execute bit means anything
 * — can then be exercised from a POSIX machine instead of only being reasoned
 * about. Production callers omit it and get the real platform.
 */
export type ToolPlatform = 'win32' | 'posix'

/**
 * What one lookup should assume about the machine it runs on.
 *
 * All three are injectable for the same reason: a Windows install cannot be
 * reproduced on the machine that runs the tests, so the rules have to be
 * testable without one. `home` matters as much as the other two — the first
 * candidate directory is derived from it, and on a developer machine that
 * directory really does contain an `ffmpeg`, so a lookup that could not be told
 * a different home would find the developer's binary and silently pass whatever
 * it was asked. An assertion about PATH order would then be measuring the wrong
 * file.
 */
export interface ToolLookupOptions {
  /** Lookup rules to apply; defaults to this process's platform. */
  platform?: ToolPlatform
  /** Environment to read PATH and the overrides from. */
  env?: NodeJS.ProcessEnv
  /** Home directory to derive `~/.local/bin` from. */
  home?: string
}

/** The platform this process runs on, in the terms this module uses. */
function currentPlatform(): ToolPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * Absolute directories searched for `ffmpeg`/`ffprobe`, in order.
 *
 * `~/.local/bin` first because that is where this machine actually keeps them;
 * the POSIX package-manager directories follow so a Homebrew or distro install
 * is found without any PATH lookup.
 *
 * PATH is appended rather than trusted. The host process runs with a minimal
 * PATH that excludes user bin directories — which is why the absolute list came
 * first — but on Windows there is no `~/.local/bin` convention at all: winget,
 * scoop and the official zip all install by adding a directory to the system
 * PATH, so `ffmpeg.exe` lives there and nowhere else. Leaving PATH out meant
 * discovery was guaranteed to fail on the one platform where it is the only
 * answer.
 * @param options - what to assume about the machine; all default to the real one.
 * @returns absolute directories, de-duplicated, in search order.
 */
export function localVideoToolDirs(options: ToolLookupOptions = {}): string[] {
  const platform = options.platform ?? currentPlatform()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const dirs = platform === 'win32'
    ? [path.join(home, '.local', 'bin')]
    : [
        path.join(home, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ]
  // The separator follows the platform being emulated, not the one running:
  // a Windows PATH split on ':' would yield `C` and `\Program Files\…` as two
  // separate "directories". `process.env` already holds PATH in native form,
  // so no other conversion is needed.
  const separator = platform === 'win32' ? ';' : ':'
  const fromPath = (env.PATH ?? env.Path ?? '').split(separator)
  return [...new Set([...dirs, ...fromPath])].filter(dir => dir !== '')
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

/**
 * Filenames to try for one tool name, in order.
 *
 * Windows resolves executables by extension. `path.join(dir, 'ffmpeg')` can
 * never match the `ffmpeg.exe` that every Windows installer writes, so the bare
 * name has to be joined by its `.exe` spelling — trying only the bare name made
 * a correctly installed ffmpeg invisible.
 */
function toolFileNames(name: VideoToolName, platform: ToolPlatform): string[] {
  return platform === 'win32' ? [`${name}.exe`, name] : [name]
}

/** Whether one absolute candidate is a tool this platform would run. */
function isUsableTool(candidate: string, platform: ToolPlatform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    // The execute bit is a POSIX concept. On Windows `X_OK` is emulated on top
    // of the read-only attribute and says nothing useful about whether a file
    // can be run, so being a regular file is the whole test — which is also the
    // answer `where` gives.
    if (platform === 'win32') return true
    accessSync(candidate, FS_CONSTANTS.X_OK)
    return true
  } catch {
    return false
  }
}

/** Environment variable that overrides discovery for one tool. */
const OVERRIDE_ENV: Record<VideoToolName, string> = {
  ffmpeg: 'FFMPEG_PATH',
  ffprobe: 'FFPROBE_PATH',
}

/**
 * First usable candidate for one tool name, or undefined.
 *
 * An explicit `FFMPEG_PATH`/`FFPROBE_PATH` wins over discovery. That override
 * has to be honoured here rather than only in `code-render.ts`: the clip
 * composer and the poster extractor both resolve through this function, so an
 * override only one of them saw left the other still reporting "not found" on a
 * machine where the user had already answered the question.
 * @param name - tool to resolve.
 * @param options - what to assume about the machine; all default to the real one.
 */
export function findTool(name: VideoToolName, options: ToolLookupOptions = {}): string | undefined {
  const platform = options.platform ?? currentPlatform()
  const env = options.env ?? process.env
  const override = env[OVERRIDE_ENV[name]]
  if (override !== undefined && override !== '' && isUsableTool(override, platform)) return override
  for (const dir of localVideoToolDirs(options)) {
    for (const fileName of toolFileNames(name, platform)) {
      const candidate = path.join(dir, fileName)
      if (isUsableTool(candidate, platform)) return candidate
    }
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

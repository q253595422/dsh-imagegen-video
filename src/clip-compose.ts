/**
 * Local clip stitching (ffmpeg) — the host half of the canvas 「拼接视频」 action.
 *
 * One {@link ClipComposer} covers every step the runner must not know about:
 * locate ffmpeg/ffprobe, turn a served clip URL back into a local file, run the
 * pipeline, and persist the result into the video history. Keeping it as one
 * injected seam is what lets the smoke suites drive the whole compose path with
 * a fake — offline, with no ffmpeg installed and no network.
 *
 * Three measured facts shape this file (see `docs/compose-contract.md` §1/§5):
 *
 *  - the running host's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, which does NOT
 *    contain `~/.local/bin`, so a bare `ffmpeg` is a guaranteed ENOENT. Every
 *    executable is resolved through absolute-path candidates only.
 *  - `-c copy` + the concat demuxer exits 0 on a silently corrupt file when the
 *    inputs differ in size or frame rate, so the pipeline always re-encodes
 *    through an explicit filtergraph.
 *  - referencing an audio stream an input does not have fails the whole
 *    filtergraph, while `anullsrc` without `d=` is an infinite source whose
 *    concat never advances (OOM, exit 137). So every input is probed for audio
 *    and for its real duration before the graph is built.
 *
 * Process handling copies `src/skill-store.ts` `run()`: no shell, args as an
 * array, `stdio: ['ignore','pipe','pipe']`, bounded output, a timer that kills
 * the child, and `error`/`close` settling behind a `settled` flag.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants as FS_CONSTANTS, promises as fs, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { GALLERY_API, VIDEO_API, type ClipComposer, type ClipStitchResult } from './protocol.ts'
import { appendVideoHistory, readVideoFile } from './video-store.ts'
import { readGalleryVideo } from './gallery-store.ts'

// ---------------------------------------------------------------- constants

/** Target canvas geometry: the format every input is normalized onto. */
const TARGET_WIDTH = 1280
const TARGET_HEIGHT = 720
const TARGET_FPS = 30
const TARGET_SAMPLE_RATE = 48_000

/** Cap on captured process output, per stream (bad inputs can be very loud). */
const MAX_PROCESS_OUTPUT = 8_000

/** Cap on the diagnostic tail kept for one failure message. */
const MAX_ERROR_TAIL = 600

/** Wall-clock cap for one transcode. Cancellation is the AbortSignal's job. */
const STITCH_TIMEOUT_MS = 30 * 60_000

/** Wall-clock cap for one probe (audio presence, duration). */
const PROBE_TIMEOUT_MS = 60_000

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

// ---------------------------------------------------------------- process

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

/** Last printable characters of process output, for an error message. */
function tail(text: string): string {
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
function runProcess(command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
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

// ---------------------------------------------------------------- locating

/** First executable candidate for one tool name, or undefined. */
function findTool(name: 'ffmpeg' | 'ffprobe'): string | undefined {
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

/** The resolved pair, looked up once per composer and cached. */
interface ToolPair {
  ffmpeg?: string
  ffprobe?: string
}

function describeTools(found: ToolPair): string {
  const ffmpeg = found.ffmpeg ?? 'not found'
  const ffprobe = found.ffprobe ?? 'not found'
  return `ffmpeg: ${ffmpeg}; ffprobe: ${ffprobe} (searched ${localVideoToolDirs().join(', ')})`
}

// ---------------------------------------------------------------- probing

/**
 * One input's contribution to the filtergraph.
 *
 * `trimStart`/`trimSeconds` turn the input into a slice before it joins the
 * graph: a timeline segment rarely uses its whole clip, and trimming inside the
 * filtergraph (rather than in a temp file) keeps the run to a single ffmpeg
 * invocation.
 */
interface ClipProbe {
  file: string
  /** False means a silent track has to be synthesized for this input. */
  hasAudio: boolean
  /** Real length in seconds, when ffprobe reported one. */
  duration?: number
  /** In-point of this segment, in seconds. */
  trimStart: number
  /** Length to keep after the in-point; absent means "to the end". */
  trimSeconds?: number
}

/** One seam between two adjacent segments, as the composer receives it. */
export interface ComposeTransition {
  kind: 'cut' | 'fade' | 'dissolve'
  /** Requested overlap, in seconds; `cut` ignores it. */
  seconds: number
}

async function probeAudio(ffprobe: string, file: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runProcess(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    file,
  ], { timeoutMs: PROBE_TIMEOUT_MS, signal })
  if (result.code !== 0) throw new Error(`ffprobe could not read ${file}: ${tail(result.stderr)}`)
  // Empty output is "no audio stream" — ffprobe exits 0 either way.
  return result.stdout.trim() !== ''
}

async function probeDuration(ffprobe: string, file: string, signal?: AbortSignal): Promise<number | undefined> {
  const result = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ], { timeoutMs: PROBE_TIMEOUT_MS, signal })
  if (result.code !== 0) throw new Error(`ffprobe could not measure ${file}: ${tail(result.stderr)}`)
  const seconds = Number.parseFloat(result.stdout.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

async function probeClip(
  ffprobe: string,
  file: string,
  trim: { start: number; seconds?: number },
  signal?: AbortSignal,
): Promise<ClipProbe> {
  const hasAudio = await probeAudio(ffprobe, file, signal)
  const duration = await probeDuration(ffprobe, file, signal)
  return {
    file,
    hasAudio,
    ...duration === undefined ? {} : { duration },
    trimStart: Math.max(0, trim.start),
    ...trim.seconds === undefined ? {} : { trimSeconds: Math.max(0, trim.seconds) },
  }
}

// ---------------------------------------------------------------- filtergraph

/**
 * Build the ffmpeg argument vector (contract §5, extended for timelines).
 *
 * Each input is trimmed to its segment, normalized to 1280x720/30fps/yuv420p,
 * and its audio either reformatted or synthesized at the TRIMMED length, so no
 * branch of the graph can ever stall the concat.
 *
 * Two paths, deliberately:
 *  - every seam is a hard cut: one `concat` node (cheapest, what the original
 *    stitch always did), and
 *  - any seam has a transition: chained `xfade`/`acrossfade`, each taking the
 *    measured overlap. xfade needs absolute offsets into the growing result, so
 *    the offset for seam i is the running total minus the overlaps so far — the
 *    arithmetic lives in `placeTimeline` on the client and is passed in already
 *    resolved, because the composer must not re-derive (and disagree with) what
 *    the editor showed the user.
 *
 * @param sources - local file paths in final play order.
 * @param probes - one probe per source, same order.
 * @param target - output file path.
 * @param options - transitions (length = sources-1) and whether to keep audio.
 */
function buildStitchArgs(
  sources: readonly string[],
  probes: readonly ClipProbe[],
  target: string,
  options: { transitions?: readonly ComposeTransition[]; keepAudio?: boolean } = {},
): string[] {
  const keepAudio = options.keepAudio !== false
  const transitions = options.transitions ?? []
  const trimmedSeconds = probes.map(probe => {
    const available = probe.duration === undefined
      ? probe.trimSeconds
      : Math.max(0, probe.duration - probe.trimStart)
    return probe.trimSeconds === undefined ? available : Math.min(probe.trimSeconds, available ?? probe.trimSeconds)
  })

  const filters: string[] = []
  let concatInputs = ''
  const overlapOf = (index: number): number => {
    const transition = transitions[index]
    if (transition === undefined || transition.kind === 'cut') return 0
    const left = trimmedSeconds[index]
    const right = trimmedSeconds[index + 1]
    if (left === undefined || right === undefined) return 0
    // Clamp at build time as well: the guest can hand a duration the inputs
    // cannot support, and xfade failing on an offset is an unreadable error.
    return Math.max(0, Math.min(transition.seconds, left / 2 - 0.05, right / 2 - 0.05))
  }
  const hasTransition = probes.some((_, index) => overlapOf(index) > 0)

  probes.forEach((probe, index) => {
    // `trim` before `setpts` resets the timestamp base; without it the joined
    // stream keeps each segment's original start time and the result jumps.
    // Audio needs its own pair (`atrim`/`asetpts`): `trim` outputs video, so
    // reusing the video chain on an audio pad fails to link at all.
    const hasTrim = probe.trimStart > 0 || probe.trimSeconds !== undefined
    const trimRange = `start=${probe.trimStart.toFixed(3)}${probe.trimSeconds === undefined ? '' : `:duration=${probe.trimSeconds.toFixed(3)}`}`
    const videoTrim = hasTrim ? `trim=${trimRange},setpts=PTS-STARTPTS,` : ''
    const audioTrim = hasTrim ? `atrim=${trimRange},asetpts=PTS-STARTPTS,` : ''
    filters.push(`[${index}:v]${videoTrim}scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},setsar=1,format=yuv420p[v${index}]`)
    if (!keepAudio) return
    if (probe.hasAudio) {
      filters.push(`[${index}:a]${audioTrim}aformat=sample_rates=${TARGET_SAMPLE_RATE}:channel_layouts=stereo[a${index}]`)
      return
    }
    const length = trimmedSeconds[index]
    if (length === undefined) {
      throw new Error(`cannot determine the length of ${probe.file}, so its silent audio track cannot be bounded`)
    }
    // `d=` is mandatory: an unbounded anullsrc never lets the concat advance.
    filters.push(`anullsrc=r=${TARGET_SAMPLE_RATE}:cl=stereo:d=${length.toFixed(3)}[a${index}]`)
  })

  if (!hasTransition) {
    for (let index = 0; index < probes.length; index += 1) {
      concatInputs += keepAudio ? `[v${index}][a${index}]` : `[v${index}]`
    }
    filters.push(`${concatInputs}concat=n=${probes.length}:v=1:a=${keepAudio ? 1 : 0}[v]${keepAudio ? '[a]' : ''}`)
  } else {
    // Chain the seams: each step takes the previous result and the next input.
    let videoLabel = 'v0'
    let audioLabel = keepAudio ? 'a0' : ''
    let running = trimmedSeconds[0] ?? 0
    for (let index = 1; index < probes.length; index += 1) {
      const overlap = overlapOf(index - 1)
      const videoOut = `vx${index}`
      if (overlap <= 0) {
        // A hard cut inside a transition-bearing timeline still has to be
        // expressed as a concat of two branches; xfade would refuse offset 0.
        const videoIn = `vc${index}`
        const audioIn = `ac${index}`
        if (keepAudio) {
          filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0,settb=AVTB[${videoIn}]`)
          filters.push(`[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${audioIn}]`)
          audioLabel = audioIn
        } else {
          filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0,settb=AVTB[${videoIn}]`)
        }
        videoLabel = videoIn
        running += trimmedSeconds[index] ?? 0
      } else {
        const offset = Math.max(0, running - overlap)
        // xfade refuses inputs whose timebases differ, and a `concat` branch
        // yields 1/30 while an untouched single input is still 1/1000000. `settb`
        // on BOTH sides is what makes a hard cut and a dissolve chainable in the
        // same graph; without it the second seam fails to configure.
        filters.push(`[${videoLabel}]settb=AVTB[vtb${index}]`)
        filters.push(`[v${index}]settb=AVTB[vtb${index}b]`)
        filters.push(`[vtb${index}][vtb${index}b]xfade=transition=${transitionFilter(transitions[index - 1]!.kind)}:duration=${overlap.toFixed(3)}:offset=${offset.toFixed(3)}[${videoOut}]`)
        videoLabel = videoOut
        if (keepAudio) {
          const audioOut = `ax${index}`
          filters.push(`[${audioLabel}][a${index}]acrossfade=d=${overlap.toFixed(3)}[${audioOut}]`)
          audioLabel = audioOut
        }
        running += (trimmedSeconds[index] ?? 0) - overlap
      }
    }
    filters.push(`[${videoLabel}]null[v]`)
    if (keepAudio) filters.push(`[${audioLabel}]anull[a]`)
  }

  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    ...sources.flatMap(source => ['-i', source]),
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...keepAudio ? ['-map', '[a]'] : [],
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    ...keepAudio ? ['-c:a', 'aac'] : ['-an'],
    '-movflags', '+faststart',
    target,
  ]
}

/** ffmpeg's xfade name for one of our three seam kinds. */
function transitionFilter(kind: ComposeTransition['kind']): string {
  // `fade` in xfade is a cross-fade through black; `dissolve` blends pixels.
  // Both are what a video editor means by those words.
  return kind === 'fade' ? 'fade' : 'dissolve'
}

// ---------------------------------------------------------------- urls

/** One place a clip can live: a served-URL prefix plus the store that reads it. */
interface ClipSource {
  prefix: string
  read: (file: string) => Promise<{ path: string } | undefined>
}

/**
 * Every store a canvas clip node can point at.
 *
 * TWO, because the user can act on a clip before or after favoriting it:
 *  - the video history (`videos/files/`), what a finished generation writes, and
 *  - the gallery (`gallery/videos/`), where 「收藏」 COPIES the bytes.
 * Favoriting used to make a clip un-stitchable: the composer only knew the first
 * prefix, so `resolve()` answered undefined and the whole run failed. The order
 * matters only for readability of this list — the prefixes are disjoint.
 *
 * Each `read` re-validates the name against that store's own pattern, so a URL
 * can never reach outside its directory (see below).
 */
const CLIP_SOURCES: readonly ClipSource[] = [
  { prefix: VIDEO_API.file, read: readVideoFile },
  { prefix: GALLERY_API.videoFile, read: readGalleryVideo },
]

/**
 * Decode a served clip URL into the file name and the store that owns it.
 *
 * The prefix is matched EXACTLY, as `prefix + '/'`, so a lookalike route such as
 * `/api/dsh-imagegen/gallery/video-file-x/…` cannot be mistaken for a clip. The
 * `URL` parse normalizes `..` segments away and the store's own name pattern
 * rejects whatever survives, so `../../etc/passwd` is still refused.
 *
 * A malformed escape (`%ZZ`, or a truncated `%E0%A4%A`) makes
 * `decodeURIComponent` throw a `URIError`. That is an unreadable clip like any
 * other, so it resolves to `undefined` here and the run reports it by name
 * instead of surfacing a raw engine error.
 */
function videoFileFrom(rawUrl: string): { file: string; read: ClipSource['read'] } | undefined {
  if (rawUrl.trim() === '') return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return undefined
  }
  for (const source of CLIP_SOURCES) {
    if (!pathname.startsWith(`${source.prefix}/`)) continue
    let file: string
    try {
      file = decodeURIComponent(pathname.slice(source.prefix.length + 1))
    } catch {
      return undefined
    }
    return file === '' ? undefined : { file, read: source.read }
  }
  return undefined
}

// ---------------------------------------------------------------- composer

/** Defensive entry id, only used when a caller passes none. */
function localEntryId(): string {
  return `compose-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The host's local clip stitcher.
 *
 * Every dependency is derived here from the module's own imports
 * (`imageDataRoot()` through the video store, `VIDEO_API.file` through the
 * protocol), so the plugin can construct it with no arguments and the runner
 * never has to import the video store itself.
 */
export function createClipComposer(): ClipComposer {
  let cached: ToolPair | undefined
  const locate = (): ToolPair => {
    if (cached === undefined) cached = { ffmpeg: findTool('ffmpeg'), ffprobe: findTool('ffprobe') }
    return cached
  }

  const requireTools = (): Required<ToolPair> => {
    const found = locate()
    if (found.ffmpeg === undefined || found.ffprobe === undefined) {
      throw new Error(`ffmpeg and ffprobe are both required; ${describeTools(found)}`)
    }
    return { ffmpeg: found.ffmpeg, ffprobe: found.ffprobe }
  }

  return {
    available: () => {
      const found = locate()
      return found.ffmpeg !== undefined && found.ffprobe !== undefined
    },

    describe: () => describeTools(locate()),

    /**
     * Turn a served clip URL back into its local file. A clip that is no longer
     * on disk (evicted history entry, foreign URL) resolves to undefined, and
     * the caller must fail the run rather than drop the segment.
     */
    resolve: async (url: string): Promise<string | undefined> => {
      const found = videoFileFrom(url)
      if (found === undefined) return undefined
      const stored = await found.read(found.file)
      return stored?.path
    },

    stitch: async (input): Promise<ClipStitchResult> => {
      const { ffmpeg, ffprobe } = requireTools()
      const sources = [...input.sources]
      if (sources.length < 2) throw new Error(`stitching needs at least two clips, got ${sources.length}`)
      // One trim entry per source, in the same order. Missing entries mean
      // "the whole clip", which is exactly what a plain stitch always meant.
      const trims = input.trims ?? []
      input.onStage?.('probe')
      const probes: ClipProbe[] = []
      for (let index = 0; index < sources.length; index += 1) {
        if (input.signal?.aborted === true) throw new Error('stitch was cancelled')
        const trim = trims[index] ?? { start: 0 }
        probes.push(await probeClip(ffprobe, sources[index]!, trim, input.signal))
      }
      input.onStage?.('encode')
      const dir = await fs.mkdtemp(path.join(tmpdir(), 'dsh-compose-'))
      const target = path.join(dir, 'stitched.mp4')
      try {
        const result = await runProcess(ffmpeg, buildStitchArgs(sources, probes, target, {
          ...input.transitions === undefined ? {} : { transitions: input.transitions },
          ...input.keepAudio === undefined ? {} : { keepAudio: input.keepAudio },
        }), {
          timeoutMs: STITCH_TIMEOUT_MS,
          ...input.signal === undefined ? {} : { signal: input.signal },
        })
        if (result.code !== 0) throw new Error(`ffmpeg exited ${result.code}: ${tail(result.stderr)}`)
        const bytes = await fs.readFile(target)
        if (bytes.length === 0) throw new Error('ffmpeg produced an empty file')
        // Measured from the produced file, never summed from the inputs.
        const duration = await probeDuration(ffprobe, target, input.signal).catch(() => undefined)
        return {
          bytes,
          mime: 'video/mp4',
          ...duration === undefined ? {} : { duration },
          width: TARGET_WIDTH,
          height: TARGET_HEIGHT,
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ })
      }
    },

    /**
     * Persist the stitched bytes as one video-history entry and hand back the
     * SERVED ref. The URL is read back off the stored entry rather than
     * assembled here, so exactly one place knows the served URL shape.
     */
    publish: async (input): Promise<{ url: string; mime: string; duration?: number }> => {
      const id = input.id.trim() === '' ? localEntryId() : input.id
      const entries = await appendVideoHistory({
        id,
        createdAt: Date.now(),
        mode: 'compose',
        model: 'ffmpeg',
        prompt: input.prompt,
        aspectRatio: '16:9',
        resolution: `${TARGET_WIDTH}x${TARGET_HEIGHT}`,
        seconds: input.duration ?? 0,
        files: [{
          bytes: Buffer.from(input.bytes),
          mime: input.mime,
          ...input.duration === undefined ? {} : { duration: input.duration },
        }],
      })
      const entry = entries.find(item => item.id === id)
      const file = entry?.videos[0]
      if (file === undefined) {
        throw new Error('the stitched clip did not come back from the video history')
      }
      return {
        url: file.url,
        mime: file.mime,
        ...file.duration === undefined ? {} : { duration: file.duration },
      }
    },
  }
}

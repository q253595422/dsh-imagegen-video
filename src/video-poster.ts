/**
 * Poster-frame extraction for stored clips.
 *
 * The history list has to show something for every row, and the only thing
 * guaranteed to be on disk is the clip itself: a provider's `poster` is
 * optional and, when present, is a remote URL the browser may or may not still
 * be able to reach. So the host cuts one JPEG out of the mp4 it just saved.
 *
 * Deliberate choices, all of them measured on this machine:
 *
 *  - **10% in, not frame 0.** Providers hand back clips whose first frame is
 *    routinely a black or transitional frame, which is a useless thumbnail.
 *  - **320px wide.** These sit in a ~64px row thumbnail; 320 gives a sharp
 *    render on a HiDPI display at a few KB each. 30 entries at that size is a
 *    rounding error next to 30 clips.
 *  - **`-frames:v 1`, `-q:v 4`.** One frame, near-best JPEG quality — the
 *    scale filter is what shrinks the bytes, not the quantizer.
 *  - **20s cap, then kill.** A poster is decoration; a clip that takes longer
 *    than that to open is not worth waiting for.
 *  - **never throws.** Every failure — no ffmpeg, ffprobe silent, output file
 *    missing or empty — returns `false`. The caller then simply has no poster,
 *    which is exactly the state the user reported and strictly better than a
 *    clip that never made it into history.
 */

import { promises as fs } from 'node:fs'
import { findTool, runProcess } from './video-tools.ts'

/** Wall-clock cap for one extraction; posters must never stall a save. */
const POSTER_TIMEOUT_MS = 20_000

/** Poster width in pixels (height follows the aspect ratio, kept even). */
const POSTER_WIDTH = 320

/** JPEG quality: 2 is best, 31 is worst. 4 is near-visually-lossless at 320px. */
const POSTER_QUALITY = 4

/** A file this small is a failure the exit code did not report. */
const MIN_POSTER_BYTES = 512

/** Probe the container duration, or undefined when ffprobe cannot say. */
async function probeDuration(ffprobe: string, file: string, signal?: AbortSignal): Promise<number | undefined> {
  const result = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ], { timeoutMs: POSTER_TIMEOUT_MS, signal })
  if (result.code !== 0) return undefined
  const seconds = Number.parseFloat(result.stdout.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * Cut one JPEG frame out of a local clip.
 *
 * @param input - absolute path to the source clip.
 * @param output - absolute path to write the JPEG to (caller owns the name).
 * @param signal - optional cancellation.
 * @returns true when `output` exists and holds a plausible JPEG.
 */
export async function extractPoster(opts: {
  input: string
  output: string
  signal?: AbortSignal
}): Promise<boolean> {
  const { input, output, signal } = opts
  try {
    const ffmpeg = findTool('ffmpeg')
    const ffprobe = findTool('ffprobe')
    if (ffmpeg === undefined || ffprobe === undefined) return false

    // 10% of the real duration when we can measure it, else the very start.
    // `Math.max(0, ...)` guards a sub-second clip, where 10% is under a frame
    // and ffmpeg would answer "no frame at that timestamp".
    const duration = await probeDuration(ffprobe, input, signal)
    const seek = duration === undefined ? 0 : Math.max(0, duration * 0.1)

    const result = await runProcess(ffmpeg, [
      // `-ss` before `-i` makes ffmpeg seek by timestamp rather than decode
      // from frame 0 — dramatically cheaper on a long clip, and accurate here.
      '-ss', String(seek),
      '-i', input,
      '-frames:v', '1',
      '-vf', `scale=${POSTER_WIDTH}:-2`,
      '-q:v', String(POSTER_QUALITY),
      // Overwrite silently: a stale file at this path must not fail the run.
      '-y',
      output,
    ], { timeoutMs: POSTER_TIMEOUT_MS, signal })

    if (result.code !== 0) return false

    const stat = await fs.stat(output)
    if (!stat.isFile() || stat.size < MIN_POSTER_BYTES) return false
    return true
  } catch {
    // ffprobe/ffmpeg refused to start, timed out, or was aborted. Also covers
    // the (unlikely) case where `output` is unwritable — a poster is optional,
    // so every one of these is a quiet `false`.
    return false
  }
}

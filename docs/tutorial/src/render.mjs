/**
 * Render the tutorial animation to frame sequences.
 *
 * The page is fully deterministic: window.setTime(t) positions every element
 * for second t (docs/shared/timeline.js), so each frame is captured by seeking
 * and screenshotting rather than by letting CSS animate in real time. Clips are
 * seeked, never played, so a re-render after a copy change is cheap.
 *
 * Usage (from the repository root):
 *   node docs/tutorial/src/render.mjs stills          # key frames for review
 *   node docs/tutorial/src/render.mjs wide|tall [fps] [from] [to]
 *
 * Frames land in docs/tutorial/src/frames/; combine them with the ffmpeg
 * command in docs/tutorial/README.md.
 */
import { resolve, join } from 'node:path'
import { runRenderCli } from '../../../scripts/lib/render-frames.mjs'

const ROOT = resolve(import.meta.dirname)

await runRenderCli({
  pagePath: join(ROOT, 'tutorial.html'),
  duration: 72,
  // one frame per chapter, plus the intro and the tail
  stillTimes: [2.4, 7.0, 14.0, 22.0, 30.0, 38.0, 46.0, 54.0, 63.0, 70.0],
  outDir: join(ROOT, 'frames'),
})

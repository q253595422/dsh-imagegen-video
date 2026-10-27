/**
 * Render the promo animation to frame sequences.
 *
 * The page is fully deterministic: window.setTime(t) positions every element
 * for second t (docs/shared/timeline.js), so each frame is captured by seeking
 * and screenshotting rather than by letting CSS animate in real time. That
 * keeps the two layouts in sync and makes a re-render after a copy change cheap.
 *
 * Usage (from the repository root):
 *   node docs/promo/src/render.mjs stills          # key frames for review
 *   node docs/promo/src/render.mjs wide|tall [fps] [from] [to]  # full sequence,
 *     or only frames [from, to) after a copy change that touches one section
 *
 * Frames land in docs/promo/src/frames/; combine them with the ffmpeg command
 * in docs/promo/README.md.
 */
import { resolve, join } from 'node:path'
import { runRenderCli } from '../../../scripts/lib/render-frames.mjs'

const ROOT = resolve(import.meta.dirname)

await runRenderCli({
  pagePath: join(ROOT, 'promo.html'),
  duration: 30,
  stillTimes: [0.6, 1.6, 4.2, 7.0, 10.4, 12.4, 16.4, 18.6, 22.4, 24.6, 27.6, 29.2],
  outDir: join(ROOT, 'frames'),
})

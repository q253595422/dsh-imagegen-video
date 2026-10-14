/**
 * Host-side smoke checks for the 「拼接视频」 (stitch clips) action.
 *
 * Offline by default: every check drives the REAL runner but an INJECTED FAKE
 * {@link ClipComposer}, so the whole compose path — ordering, probing stages,
 * publishing, the produced node — is proven with no ffmpeg and no network. Only
 * the last check touches real ffmpeg, and it skips loudly when it is absent.
 *
 * What this proves:
 *
 *  V1  the catalog offers `compose.videos` as a builtin `local` tier action
 *      accepting `video`, with copy from the compose locale keys — and WITHOUT
 *      a `requires` gate, so a host with no agent runtime still shows it
 *  V2  a selection of fewer than two real clips fails with the composeTooFew
 *      copy (a stray image in the selection does not count as a clip)
 *  V3  three clips reach ffmpeg in CANVAS-POSITION order, not the order the
 *      client sent — and the run spends ZERO chat calls (a `local` tier that
 *      fell into runLight would answer a stitch request with a text node)
 *  V4  the produced node is a clip REFERENCE: type `video`, metadata.video.url
 *      set, metadata.asset UNDEFINED (bytes stay in the video store, never
 *      copied into the canvas asset library), one connection per source clip
 *  V5  the task's stage text advances through the probe stage into the encode
 *      stage while the run is in flight
 *  V10 READ-ORDER REGRESSION: one tall clip beside two short ones (unequal
 *      heights, all overlapping vertically) stays ONE row — the old
 *      centre-in-band rule split it into three and produced a wrong concat
 *      order that looked plausible, so nothing else in this suite caught it
 *  V11 ROW-JOIN REGRESSION: two ordinary rows that OVERLAP vertically (a grid)
 *      stay two rows — a "any vertical overlap means one row" rule merges them
 *      and the whole layout reads column-major (a,c,b,d). V10 cannot catch that
 *      rule, so without this fixture it could ship with a green suite
 *  V12 ORDER INVERSION: a tall clip beside two clips that are strictly one
 *      above the other must not play the LOWER one first — the centre-inside
 *      rule (v3) did exactly that, and no earlier fixture noticed
 *  V13 COLUMN COLLAPSE: a portrait clip (3:4, one click away in the UI) beside
 *      a 2x2 grid must not make the grid read column-major (a,c,b,d) — the rule
 *      that decides a row by SOME member rather than EVERY member did that
 *  V14 TWO SHORT ROWS BESIDE A TALL CLIP: the same over-merge, one row shorter
 *  V15 O7 INVERSION: two 700px clips with a short clip strictly above the lower
 *      one and no horizontal overlap — the shipped 18698e1b rule played the
 *      lower clip second (its row window scaled with the tall clip's own height
 *      and had no ceiling). Reachable by dragging a clip taller, and only a
 *      three-node layout can show it
 *  V16/V17 NESTED SMALL CLIP: a 64px (and a 96x64 minimum-size) clip dropped
 *      inside a 240px host's vertical span. Without the nested clause the pair
 *      reads as a column, the small clip opens its own row and lands AFTER a
 *      clip to its right — old rule A,C,B against A,B,C
 *  V18 PROXIMITY FLOOR: a 240x64 clip butting exactly against the 200x240 clip
 *      beside it (zero horizontal overlap, so neither nested nor stacked
 *      applies) with a 32px top-edge offset. With the window at exactly 32px the
 *      offset is not < 32, so the shrunk clip is exiled to its own row and read
 *      last — old rule B,C,A against A,B,C
 *  V19/V20 FULL-NESTING REGRESSION: a clip sunk LOW inside a tall host (320px,
 *      then 480px) beside a clip that sits entirely ABOVE it on the right. A
 *      rule that treats ANY nested pair as one row welds the low clip to its
 *      host and reads it BEFORE the clip above it — V16/V17 cannot see this
 *      because they nest near the TOP of the host, where both rules agree
 *  V21 ABOVE-LIFT: the row grouping files a 240x64 clip nested in a tall host
 *      into the host's row while another tall clip sits wholly BELOW it, so flat
 *      row order plays the lower clip first — host,right,small against the
 *      correct host,small,right. A final stable topological pass over "wholly
 *      above" (a.y + a.height <= b.y) repairs it; this fixture is its only guard
 *  V8  FAILURE HONESTY: one clip whose URL no longer resolves (an evicted
 *      history entry) fails the whole run BEFORE ffmpeg — the offending clip is
 *      named, nothing is stitched and nothing is published, so the user can
 *      never receive a quietly shorter video than the badges promised
 *  V9  a host with no local composer reports the composeNoFfmpeg copy instead of
 *      silently answering a stitch request with a chat completion — both when
 *      the option is omitted (refused up front) and when a wired composer
 *      reports the tools missing (a failed task)
 *  E1  (real ffmpeg only) two synthetic clips — one with audio, one silent —
 *      stitch through the REAL ClipComposer and the result is ~2x as long
 *
 * Run: node scripts/smoke-compose.mjs   (from the package root, after a build)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, accessSync, constants as FS } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const results = []
/** Run one check; async-aware and sequential so nothing races the fake. */
async function check(name, fn, timeoutMs = 60_000) {
  // Progress goes to stderr so a hung check is identifiable from the log alone.
  process.stderr.write(`... ${name}\n`)
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    results.push(`PASS  ${name}`)
  } catch (error) {
    if (error instanceof SkipSignal) {
      // A loud skip: a machine without ffmpeg must not look like a broken feature.
      results.push(`SKIP  ${name}: ${error.message}`)
      process.stderr.write(`\n!!! SKIP ${name}: ${error.message}\n!!! (this is not a failure; the offline checks above still ran)\n\n`)
      return
    }
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

/** Thrown by skip() so the check is recorded as SKIP, never as PASS or FAIL. */
class SkipSignal extends Error {}

function skip(why) {
  throw new SkipSignal(why)
}

const root = mkdtempSync(join(tmpdir(), 'gal-compose-'))
process.env.DSH_HOME = root
const host = await import(new URL('../lib/index.js', import.meta.url).href)
const hostLocale = await import(new URL('../lib/locale-tables.js', import.meta.url).href)
// The runner renders its stage text through the same dictionaries the browser
// ships; wire that resolver so the stage assertions compare real copy.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'en')
/** The copy one locale key resolves to, for the language the host uses here. */
const copy = (key, params) => hostLocale.interpolate(key, params, 'en')

/** The served-URL prefix the video store uses (`${VIDEO_API.file}/<file>`). */
const VIDEO_FILE_API = '/api/dsh-imagegen/video/file'

// ---------------------------------------------------------------- fixtures

/** Documents the fake canvas backend serves, by canvas id. */
const canvasDocuments = new Map()
const canvasBackend = {
  async read(id) { return canvasDocuments.get(id) },
}

/** One canvas clip node: a REFERENCE with no canvas asset (see protocol). */
function clipNode(id, x, y, prompt) {
  return {
    id, type: 'video', title: `clip ${id}`, x, y, width: 240, height: 160,
    metadata: {
      video: { url: `${VIDEO_FILE_API}/${id}-0.mp4`, mime: 'video/mp4', duration: 2 },
      status: 'success',
      prompt,
    },
  }
}
function imageNode(id, x, y) {
  return {
    id, type: 'image', title: `still ${id}`, x, y, width: 240, height: 240,
    metadata: { asset: { assetId: 'asset-1', name: 'a.png', mime: 'image/png', size: 4, origin: 'generated' }, status: 'success' },
  }
}

/**
 * One clip node with explicit geometry. The default 240x160 box cannot express a
 * layout that tells the two row rules apart, so the regression fixture below
 * needs its own sizes.
 */
function sizedClipNode(id, x, y, width, height, prompt) {
  return { ...clipNode(id, x, y, prompt), width, height }
}

/** The three clips, deliberately laid out so ARRAY order ≠ canvas order. */
const CLIPS = [
  clipNode('clip-c', 0, 600, 'third prompt'),   // bottom row → last
  clipNode('clip-a', 0, 0, 'first prompt'),     // top row, left → first
  clipNode('clip-b', 900, 0, 'second prompt'),  // top row, right → second
]
/** The client sends them scrambled; the host must re-sort by position. */
const AS_SENT = ['clip-c', 'clip-b', 'clip-a']
const EXPECTED_ORDER = ['clip-a', 'clip-b', 'clip-c']

/**
 * The read-order regression layout: one TALL clip on the left beside two SHORT
 * clips on the right — a plausible hand arrangement, and the case where the old
 * centre-based rule and the current overlap rule disagree.
 *
 *   wide : x=0,   y=0,   w=400, h=400   (spans the whole height)
 *   r1   : x=500, y=0,   w=200, h=100
 *   r2   : x=500, y=300, w=200, h=100
 *
 * Vertical centres are 200 / 50 / 350, so the OLD rule (sort by centre, join a
 * row when the centre lands strictly inside the row's band) sorted them r1·wide·r2
 * and then let r2 join wide's row: ['r1', 'wide', 'r2'] — wrong, and wrong in a
 * way that still looks like a sensible order.
 *
 * The current rule sorts by TOP edge (0 / 0 / 300) and joins the first row whose
 * vertical extent the node overlaps, so all three overlap and form ONE row:
 * left to right, then top to bottom => ['wide', 'r1', 'r2'].
 */
const UNEQUAL_CLIPS = [
  sizedClipNode('wide', 0, 0, 400, 400, 'tall left clip'),
  sizedClipNode('r1', 500, 0, 200, 100, 'short top-right clip'),
  sizedClipNode('r2', 500, 300, 200, 100, 'short bottom-right clip'),
]
/** Sent in the exact reverse of the expected order: the host must re-sort. */
const UNEQUAL_AS_SENT = ['r2', 'r1', 'wide']
const UNEQUAL_EXPECTED = ['wide', 'r1', 'r2']

/**
 * The row-join regression layout: an ordinary 2x2 grid whose second row OVERLAPS
 * the first, i.e. every clip's box shares vertical space with both clips of the
 * other row. Clips are placed on a 336px pitch with a 150px row gap, so the rows
 * overlap by 10px — nothing exotic, just a hand-arranged grid.
 *
 *   a : x=0,   y=0,   w=240, h=160   (row 1 left)    extent y 0..160
 *   b : x=336, y=0,   w=240, h=160   (row 1 right)   extent y 0..160
 *   c : x=0,   y=150, w=240, h=160   (row 2 left)    extent y 150..310
 *   d : x=336, y=150, w=240, h=160   (row 2 right)   extent y 150..310
 *
 * Reading order is plainly row-major: ['a', 'b', 'c', 'd']. Three measured
 * rules give:
 *   centre-in-band (HEAD of this repo at the time) -> a,b,c,d  (happens to pass)
 *   ANY-VERTICAL-OVERLAP (the withdrawn rule)      -> a,c,b,d  (column-major —
 *       every clip here overlaps its neighbours vertically, so all four merge
 *       into one row and it is then sorted purely by x)
 *   centre-in-taller (current)                     -> a,b,c,d
 * So this fixture is the one that keeps the withdrawn over-merging rule out,
 * which the V10 layout above does not: V10 passes under that rule.
 */
const GRID_CLIPS = [
  sizedClipNode('g-a', 0, 0, 240, 160, 'grid top-left clip'),
  sizedClipNode('g-b', 336, 0, 240, 160, 'grid top-right clip'),
  sizedClipNode('g-c', 0, 150, 240, 160, 'grid bottom-left clip'),
  sizedClipNode('g-d', 336, 150, 240, 160, 'grid bottom-right clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const GRID_AS_SENT = ['g-d', 'g-c', 'g-b', 'g-a']
const GRID_EXPECTED = ['g-a', 'g-b', 'g-c', 'g-d']

/**
 * Order-inversion fixture: a TALL clip on the left with two short clips on the
 * right that do not overlap each other at all — `upper` ends at y=160 and
 * `lower` starts at y=300, a 140px gap. Reading order is plainly top to bottom:
 * the spine, then `upper`, then `lower`.
 *
 *   spine : x=0,   y=0,   w=240, h=600   (extent y 0..600)
 *   upper : x=700, y=0,   w=240, h=160   (extent y 0..160)
 *   lower : x=400, y=300, w=240, h=160   (extent y 300..460)
 *
 * The centre-inside rule (revision 3) put `lower` SECOND, because it joined the
 * spine's row on the strength of any single member — an order that plays a clip
 * sitting strictly BELOW another one before it. Measured: v1 upper,spine,lower ·
 * v3 spine,lower,upper (inverted) · v4 spine,upper,lower.
 */
const SPINE_CLIPS = [
  sizedClipNode('spine', 0, 0, 240, 600, 'tall left spine'),
  sizedClipNode('upper', 700, 0, 240, 160, 'upper right clip'),
  sizedClipNode('lower', 400, 300, 240, 160, 'lower right clip'),
]
const SPINE_AS_SENT = ['lower', 'upper', 'spine']
const SPINE_EXPECTED = ['spine', 'upper', 'lower']

/**
 * Column-collapse fixture: a PORTRAIT clip on the left beside an ordinary 2x2
 * grid. The 240x320 portrait is NOT an automatic size: `nodeSizeFromRatio` uses
 * the spec's height for a portrait ratio, so a 3:4 clip comes out 200x160 at the
 * video node spec (240x160) and 200x240 at the image spec (240x240) — both
 * shorter than 240 wide. Reaching 240x320 therefore takes a manual resize.
 *
 * That distinction is not academic: this fixture still separates the rules at
 * 240x320, 200x240 and 240x240, but NOT at 200x160 — a 3:4 clip left at its
 * automatic size would not expose the column-collapse defect at all.
 *
 *   portrait : x=0,   y=0,   w=240, h=320   (extent y 0..320)
 *   a        : x=400, y=0,   w=240, h=160
 *   b        : x=736, y=0,   w=240, h=160
 *   c        : x=400, y=150, w=240, h=160
 *   d        : x=736, y=150, w=240, h=160
 *
 * Reading order: portrait, then the grid row-major => portrait,a,b,c,d.
 * A rule that admits an item into a row when it shares that row with SOME
 * member (v3) merged each grid column instead and read the grid column-major.
 * Measured: v1 a,b,portrait,c,d · v3 portrait,a,c,b,d (column-major) ·
 * v4 portrait,a,b,c,d.
 */
const PORTRAIT_CLIPS = [
  sizedClipNode('portrait', 0, 0, 240, 320, 'portrait left clip'),
  sizedClipNode('a', 400, 0, 240, 160, 'grid top-left clip'),
  sizedClipNode('b', 736, 0, 240, 160, 'grid top-right clip'),
  sizedClipNode('c', 400, 150, 240, 160, 'grid bottom-left clip'),
  sizedClipNode('d', 736, 150, 240, 160, 'grid bottom-right clip'),
]
const PORTRAIT_AS_SENT = ['d', 'c', 'b', 'a', 'portrait']
const PORTRAIT_EXPECTED = ['portrait', 'a', 'b', 'c', 'd']

/**
 * The same over-merge one row shorter: a tall clip beside a 2x2 grid that is
 * missing its bottom-right cell. The second row must still come after the first.
 *
 *   tall : x=0,   y=0,   w=240, h=600
 *   r1a  : x=400, y=0,   w=240, h=160
 *   r1b  : x=736, y=0,   w=240, h=160
 *   r2a  : x=400, y=300, w=240, h=160
 *
 * Measured: v1 r1a,r1b,tall,r2a · v3 tall,r1a,r2a,r1b · v4 tall,r1a,r1b,r2a.
 */
const TALLROWS_CLIPS = [
  sizedClipNode('tall', 0, 0, 240, 600, 'tall left clip'),
  sizedClipNode('r1a', 400, 0, 240, 160, 'first row left clip'),
  sizedClipNode('r1b', 736, 0, 240, 160, 'first row right clip'),
  sizedClipNode('r2a', 400, 300, 240, 160, 'second row left clip'),
]
const TALLROWS_AS_SENT = ['r2a', 'r1b', 'r1a', 'tall']
const TALLROWS_EXPECTED = ['tall', 'r1a', 'r1b', 'r2a']

/**
 * The O7 inverted-row layout: TWO tall 700px clips with a short one between them
 * horizontally, and — this is the point — ZERO horizontal overlap anywhere.
 *
 *   left : x=0,    y=0,   w=240, h=700   (extent y 0..700;  x 0..240)
 *   mid  : x=1000, y=80,  w=240, h=160   (extent y 80..240; x 1000..1240)
 *   low  : x=600,  y=320, w=240, h=700   (extent y 320..1020; x 600..840)
 *
 * `mid` ends at y=240 and `low` starts at y=320, so `mid` is ENTIRELY above
 * `low`, and they do not overlap horizontally at all (mid starts at x=1000, low
 * ends at x=840). Reading order is unambiguous: left, mid, low.
 *
 * The previous shipped rule (18698e1b) nevertheless played `low` SECOND. Its
 * row window was `0.5 * min(height)` with no ceiling, and the 700px clips made
 * that 350px — wide enough for `left` to swallow `low` into its own row, after
 * which the two were ordered by x and the plainly-lower clip came first. Only a
 * THREE-node layout exposes it: with two nodes the walk order already matches.
 * A 700px-tall node is reachable by dragging the resize handle (heights are
 * unbounded above; only MIN_NODE_HEIGHT=64 exists).
 *
 * Measured on this fixture: v1 centre-band mid,left,low · v2 any-overlap
 * left,low,mid · v3 centre-inside left,low,mid · 18698e1b left,low,mid (all
 * three inverted) · current rule left,mid,low.
 */
const O7_CLIPS = [
  sizedClipNode('left', 0, 0, 240, 700, 'tall left clip'),
  sizedClipNode('mid', 1000, 80, 240, 160, 'short middle clip'),
  sizedClipNode('low', 600, 320, 240, 700, 'tall lower clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const O7_AS_SENT = ['low', 'mid', 'left']
const O7_EXPECTED = ['left', 'mid', 'low']

/**
 * Nested-small-clip fixture: a 64px-tall clip sitting INSIDE the vertical span
 * of a 240px-tall clip, overlapping it horizontally from x=0 to x=240.
 *
 *   A : x=0,   y=0,  w=240, h=240   (extent y 0..240)
 *   B : x=0,   y=32, w=240, h=64    (extent y 32..96 — entirely inside A)
 *   C : x=400, y=96, w=240, h=240   (extent y 96..336, clear of A horizontally)
 *
 * B was dropped onto A, so A and B are one visual cluster and B is read second;
 * C is its own column to the right. Reading order: A, B, C.
 *
 * The previous rule had no nested clause, so B fell through to the stacked-pair
 * guard: B overlaps A's full width and its top edge is 32px lower, which is
 * both >= 0.5*narrower and >= 0.25*shorter(64)=16, so the pair counted as a
 * COLUMN. B then opened a row of its own and — because rows come out in
 * top-edge order — was read after C. Measured on this fixture: old rule A,C,B ·
 * current rule A,B,C.
 *
 * The window clause alone does not fix this fixture: removing ROW_PROXIMITY_FLOOR
 * still yields A,B,C here, because the nested clause answers first. V18 below is
 * the fixture that needs the floor.
 */
const NESTED_CLIPS = [
  sizedClipNode('clip-a', 0, 0, 240, 240, 'host clip'),
  sizedClipNode('clip-b', 0, 32, 240, 64, 'nested clip'),
  sizedClipNode('clip-c', 400, 96, 240, 240, 'right column clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const NESTED_AS_SENT = ['clip-c', 'clip-b', 'clip-a']
const NESTED_EXPECTED = ['clip-a', 'clip-b', 'clip-c']

/**
 * The same nesting at the MINIMUM node footprint: B is 96x64 (MIN_NODE_WIDTH /
 * MIN_NODE_HEIGHT), the smallest a clip can be dragged to.
 *
 *   A : x=0,   y=0,  w=240, h=240
 *   B : x=0,   y=32, w=96,  h=64    (inside A vertically, overlaps A from x=0..96)
 *   C : x=400, y=96, w=240, h=240
 *
 * Reading order: A, B, C. This pins the nested clause at the size where the
 * proximity window is at its absolute tightest (0.5*64 = 32px, exactly B's
 * offset), so a rule that leans on the window instead of nesting is caught.
 * Measured: old rule A,C,B · current rule A,B,C.
 */
const NESTED_MIN_CLIPS = [
  sizedClipNode('clip-a', 0, 0, 240, 240, 'host clip'),
  sizedClipNode('clip-b', 0, 32, 96, 64, 'minimum nested clip'),
  sizedClipNode('clip-c', 400, 96, 240, 240, 'right column clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const NESTED_MIN_AS_SENT = ['clip-c', 'clip-b', 'clip-a']
const NESTED_MIN_EXPECTED = ['clip-a', 'clip-b', 'clip-c']

/**
 * Column fixture with NO nesting and ZERO horizontal overlap, where the two
 * left-hand clips are SEPARATED VERTICALLY only by a 32px top-edge offset —
 * wider than 0.5*min(64,240)=32 would allow, so the OLD window rejected it.
 *
 *   A : x=0,   y=32, w=240, h=64    (extent y 32..96;   x 0..240)
 *   B : x=240, y=0,  w=200, h=240   (extent y 0..240;    x 240..440)
 *   C : x=480, y=96, w=200, h=240   (extent y 96..336;   x 480..680)
 *
 * A butts exactly against B horizontally (A ends at 240, B starts at 240) so
 * their overlap is 0 — neither nested nor stacked applies. A is a short clip
 * sitting on B's top-left shoulder, so it is read first, then B, then C across
 * the top. Reading order: A, B, C.
 *
 * This is the fixture ROW_PROXIMITY_FLOOR exists for: with the window at
 * min(0.5*64, 240) = 32px, the offset 32 is NOT < 32, so A is thrown onto a row
 * of its own and read last. Measured: old rule B,C,A · current rule A,B,C, and
 * removing only the floor from the current rule reproduces B,C,A.
 */
const FLOOR_CLIPS = [
  sizedClipNode('clip-a', 0, 32, 240, 64, 'shrunk shoulder clip'),
  sizedClipNode('clip-b', 240, 0, 200, 240, 'shoulder host clip'),
  sizedClipNode('clip-c', 480, 96, 200, 240, 'right clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const FLOOR_AS_SENT = ['clip-c', 'clip-b', 'clip-a']
const FLOOR_EXPECTED = ['clip-a', 'clip-b', 'clip-c']

/**
 * FULL-NESTING regression: a clip sunk LOW inside a tall host, beside a clip
 * that sits entirely ABOVE it on the right.
 *
 *   h : x=0,   y=0,   w=240, h=320   (extent y 0..320)
 *   b : x=89,  y=249, w=240, h=64    (extent y 249..313 — nested LOW inside h)
 *   c : x=409, y=84,  w=240, h=160   (extent y 84..244;  x 409..649, no overlap with h)
 *
 * `c` ends at y=244, entirely above `b` which starts at 249. Reading order is
 * plainly h, c, b: the host first, then the clip that sits higher and to the
 * right, then the low nested one.
 *
 * This is the ONE shape the nested fixtures above cannot see. V16/V17 nest a
 * small clip near the TOP of its host, which is the geometry where full nesting
 * and level-nesting agree. Here they disagree: a rule that treats ANY nested
 * pair as one row welds `b` into `h`'s row, so rows come out h,b and then c —
 * `h,b,c` — and a clip that is entirely above another is stitched after it.
 * That is a strict inversion of the reading order the ①②③ badges show.
 *
 * The clip that ends up out of order is `c`, which is NOT nested in anything —
 * the damage lands on a node the user arranged perfectly normally.
 */
const DEEP_NESTED_CLIPS = [
  sizedClipNode('h', 0, 0, 240, 320, 'tall host clip'),
  sizedClipNode('b', 89, 249, 240, 64, 'deeply nested low clip'),
  sizedClipNode('c', 409, 84, 240, 160, 'clip above the nested one'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const DEEP_NESTED_AS_SENT = ['b', 'c', 'h']
const DEEP_NESTED_EXPECTED = ['h', 'c', 'b']

/**
 * The same inversion at a taller host, where the geometry is unambiguous. The
 * window a full-nesting rule swallows scales with host height, so a 480px host
 * leaves `b` no plausible claim on `h`'s row at all.
 *
 *   h : x=0,   y=0,   w=240, h=480   (extent y 0..480)
 *   b : x=89,  y=409, w=240, h=64    (extent y 409..473 — nested LOW inside h)
 *   c : x=409, y=120, w=240, h=160   (extent y 120..280, ends 129px above b)
 */
const DEEP_NESTED_TALL_CLIPS = [
  sizedClipNode('h', 0, 0, 240, 480, 'taller host clip'),
  sizedClipNode('b', 89, 409, 240, 64, 'deeply nested low clip'),
  sizedClipNode('c', 409, 120, 240, 160, 'clip above the nested one'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const DEEP_NESTED_TALL_AS_SENT = ['b', 'c', 'h']
const DEEP_NESTED_TALL_EXPECTED = ['h', 'c', 'b']

/**
 * ABOVE-LIFT regression: a short clip that sits WHOLLY ABOVE a taller neighbour
 * must not be stitched after it, even when the row grouping files them apart.
 *
 *   host  : x=0,   y=0,   w=240, h=480   (extent y 0..480)
 *   small : x=0,   y=64,  w=240, h=64    (extent y 64..128;  x 0..240)
 *   right : x=240, y=200, w=240, h=480   (extent y 200..680; x 240..480)
 *
 * No two of the three overlap at all: `host` and `small` are stacked in the left
 * column (small nested inside host, both starting at x=0), and `right` is a
 * separate column to the right. Reading order is plainly host, small, right.
 *
 * The row grouping can still be fooled by this shape, and no threshold fixes it:
 * `small` (64px tall) is nested inside `host` and level-topped with it, so it
 * joins host's row even though its 64..128 band is nowhere near `right`'s
 * 200..680; `right` is then pushed onto its own row BELOW, and the flat row
 * order plays `right` before `small` — host, right, small. That is a strict
 * inversion: `small` ends at y=128 and `right` starts at y=200, so one is wholly
 * above the other.
 *
 * The repair is not another threshold but a final stable topological pass over
 * `entirelyAbove` (a.y + a.height <= b.y), seeded by the row order. This fixture
 * is its only coverage: with the pass disabled every other fixture here — and
 * the canvas-video and main suites — still passes.
 *
 * `small` is 240x64, the MINIMUM node height (reachable by dragging the resize
 * handle), which is also the automatic height for a 16:9 clip in a shrunk box.
 */
const ABOVE_LIFT_CLIPS = [
  sizedClipNode('host', 0, 0, 240, 480, 'tall left host clip'),
  sizedClipNode('small', 0, 64, 240, 64, 'short nested clip wholly above the right one'),
  sizedClipNode('right', 240, 200, 240, 480, 'tall right clip'),
]
/** Sent in the EXACT REVERSE of the expected order: only geometry can fix it. */
const ABOVE_LIFT_AS_SENT = ['right', 'small', 'host']
const ABOVE_LIFT_EXPECTED = ['host', 'small', 'right']

/**
 * Run one order fixture end to end and assert the whole chain. The three order
 * cases share it so they cannot drift apart, and so each of them proves the
 * same four things: the SENT array is not canvas order, the task records the
 * resolved order, the produced node and its edges follow it — and, the one that
 * decides the shipped file, that ffmpeg is handed exactly that order.
 */
async function checkOrderFixture(label, documentId, clips, sentOrder, expectedOrder) {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: documentId, title: documentId, nodes: [...clips] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // Deliberately NOT the canvas order: the host re-sorts by geometry alone.
    nodeIds: [...sentOrder],
  })
  composer.observe(task)
  assert.notDeepEqual([...sentOrder], [...expectedOrder],
    `${label}: the fixture only proves anything if the client order differs from the canvas order`)
  assert.deepEqual([...sentOrder].reverse(), [...expectedOrder],
    `${label}: the client order is the exact reverse, so only geometry can produce the result`)
  assert.deepEqual(task.nodeIds, [...expectedOrder],
    `${label}: the task records the resolved reading order`)

  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'completed', `${label}: ${JSON.stringify(snapshot)}`)

  // The load-bearing assertion: this is the argument list ffmpeg would receive.
  assert.equal(composer.record.stitchCalls.length, 1, `${label}: exactly one ffmpeg invocation`)
  assert.deepEqual(composer.record.stitchCalls[0],
    expectedOrder.map(id => `/fake/${id}-0.mp4`),
    `${label}: the sources handed to ffmpeg are in canvas reading order`)
  assert.deepEqual(composer.record.resolveCalls,
    expectedOrder.map(id => `${VIDEO_FILE_API}/${id}-0.mp4`),
    `${label}: the sources were resolved in the same order`)

  const produced = snapshot.output.nodes[0]
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, [...expectedOrder],
    `${label}: the produced node names its sources in reading order`)
  assert.deepEqual(snapshot.output.connections.map(edge => edge.fromNodeId), [...expectedOrder],
    `${label}: the connections follow the same order`)
  assert.equal(chatCalls, before, `${label}: a local run spends no chat calls`)
}

/** A fake composer: records every call, emits the two stages, never touches disk. */
function fakeComposer() {
  const record = {
    resolveCalls: [], stitchCalls: [], publishes: [], stageSamples: [], signals: [],
    available: 0, describe: 0,
  }
  let liveTask
  /** A macrotask boundary: every pending microtask (incl. the caller's task
   *  assignment) has run by the time this resolves. */
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const composer = {
    record,
    /** Hand the fake the task object the runner returned, to sample its stage. */
    observe: task => { liveTask = task },
    available: () => { record.available += 1; return true },
    describe: () => { record.describe += 1; return 'fake ffmpeg 6.0 / fake ffprobe 6.0' },
    resolve: async url => {
      record.resolveCalls.push(url)
      // A URL the store no longer serves resolves to nothing, exactly like the
      // real composer when the history entry was evicted.
      return url.includes('gone') ? undefined : `/fake/${basename(new URL(url, 'http://x').pathname)}`
    },
    stitch: async input => {
      record.stitchCalls.push([...input.sources])
      record.signals.push(input.signal)
      input.onStage?.('probe')
      await settle()
      record.stageSamples.push({ at: 'probe', text: liveTask?.stage })
      input.onStage?.('encode')
      await settle()
      record.stageSamples.push({ at: 'encode', text: liveTask?.stage })
      return { bytes: Buffer.from('stitched-bytes'), mime: 'video/mp4', duration: 4, width: 1280, height: 720 }
    },
    publish: async input => {
      record.publishes.push({ ...input, bytes: Buffer.from(input.bytes) })
      return { url: `${VIDEO_FILE_API}/${input.id}-0.mp4`, mime: input.mime, duration: input.duration }
    },
  }
  return composer
}

let chatCalls = 0
let liveRunner
/** One runner over the fake canvas + a chat stub that must stay untouched. */
function makeRunner(composer) {
  return new host.SkillRunner({
    backend: {
      canvas: canvasBackend,
      chat: { async complete() { chatCalls += 1; return 'this must never be used' } },
    },
    enabled: () => true,
    heavyEnabled: () => false,
    allowlist: () => [],
    runRoot: () => join(root, 'runs'),
    heavyTimeoutMs: () => 30_000,
    dataRoot: () => root,
    ...composer === undefined ? {} : { composer },
  })
}

/** Poll a task through the runner until it leaves queued/running. */
async function settleTask(taskId, attempts = 200) {
  let snapshot = liveRunner.task(taskId)
  for (let attempt = 0; attempt < attempts && snapshot !== undefined
    && (snapshot.status === 'queued' || snapshot.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    snapshot = liveRunner.task(taskId)
  }
  return snapshot
}

// ---------------------------------------------------------------- V1 catalog

await check('V1 compose.videos is a builtin local-tier action accepting video', async () => {
  liveRunner = makeRunner(fakeComposer())
  // No agent runtime is attached anywhere in this suite: a catalog entry gated
  // on `agentAvailable` would still list, but with a `requires` that blocks it.
  const catalog = await liveRunner.list('en')
  const compose = catalog.skills.find(skill => skill.id === 'compose.videos')
  assert.ok(compose !== undefined, `no compose.videos in the catalog: ${catalog.skills.map(s => s.id).join(', ')}`)
  assert.equal(compose.origin, 'builtin')
  assert.equal(compose.tier, 'local', 'stitching runs on this machine, never through a model')
  assert.deepEqual(compose.accepts, ['video'])
  assert.equal(compose.output, 'video')
  assert.equal(compose.name, copy('canvas.skills.compose'))
  assert.equal(compose.description, copy('canvas.skills.composeDesc'))
  assert.equal(compose.costHint, copy('canvas.skills.composeCost'))
  assert.notEqual(compose.name, 'canvas.skills.compose', 'the locale key resolved to real copy')
  assert.equal('requires' in compose, false, 'a local action must never be gated on the agent runtime')
  assert.equal(catalog.agentAvailable, false, 'this suite runs with no agent runtime at all')
  // The other built-ins are untouched by this change.
  assert.deepEqual(catalog.skills.filter(s => s.origin === 'builtin').map(s => s.id),
    ['polish.text', 'describe.image', 'extract.content', 'compose.videos', 'ppt.fromImages'])
})

// ------------------------------------------------------------- V2 too few

await check('V2 fewer than two real clips fails with the composeTooFew copy', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-thin', title: 'thin', nodes: [
    clipNode('clip-a', 0, 0, 'only one clip'),
    imageNode('still-1', 400, 0),
  ] }
  canvasDocuments.set(document.id, document)
  // One clip + one image: the image is a multi-select artifact, not a source.
  await assert.rejects(
    () => liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a', 'still-1'] }),
    error => error.message === copy('canvas.skills.composeTooFew'),
  )
  // A single clip is refused too, and nothing was ever handed to ffmpeg.
  await assert.rejects(
    () => liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a'] }),
    error => error.message === copy('canvas.skills.composeTooFew'),
  )
  assert.deepEqual(composer.record.stitchCalls, [], 'a refused run never reaches ffmpeg')
  assert.equal(chatCalls, 0, 'a refused run never reaches the chat model')
  // A missing canvas is still reported as such, not as a bad selection.
  await assert.rejects(
    () => liveRunner.run({ canvasId: 'canvas-none', skillId: 'compose.videos', nodeIds: ['clip-a', 'clip-b'] }),
    error => error.message === copy('canvas.skills.canvasMissing'),
  )
})

// ------------------------------------------------- V3/V4/V5 the real path

await check('V3-V5 three clips stitch in canvas order and land as a referenced video node', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-stitch', title: 'stitch', nodes: [...CLIPS, imageNode('still-9', 1200, 0)] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // Scrambled, and with a stray image thrown in: the host owns the order and
    // the membership of the source list.
    nodeIds: [...AS_SENT, 'still-9'],
  })
  composer.observe(task)
  assert.equal(task.tier, 'local')
  // The task records the RESOLVED order, so a reloaded run card shows the same
  // order the user will see in the produced clip.
  assert.deepEqual(task.nodeIds, EXPECTED_ORDER)

  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))

  // V3 — order, membership, and a run that never touched a model.
  assert.equal(composer.record.stitchCalls.length, 1, 'exactly one ffmpeg invocation')
  assert.deepEqual(composer.record.stitchCalls[0],
    EXPECTED_ORDER.map(id => `/fake/${id}-0.mp4`),
    'sources reached ffmpeg in canvas-position order (top row left→right, then the row below)')
  assert.deepEqual(composer.record.resolveCalls,
    EXPECTED_ORDER.map(id => `${VIDEO_FILE_API}/${id}-0.mp4`))
  assert.equal(composer.record.available, 1, 'the run asked the composer whether the tools exist')
  assert.ok(composer.record.signals[0] instanceof AbortSignal, 'the run hands ffmpeg an AbortSignal')
  assert.equal(chatCalls, before, 'a local-tier run spends ZERO chat calls')

  // V5 — the stage text advanced while the run was in flight.
  assert.deepEqual(composer.record.stageSamples, [
    { at: 'probe', text: copy('canvas.skills.composeStageProbe') },
    { at: 'encode', text: copy('canvas.skills.composeStageEncode') },
  ])
  assert.notEqual(copy('canvas.skills.composeStageProbe'), 'canvas.skills.composeStageProbe')

  // V4 — the produced node is a reference, never a copied asset.
  assert.equal(snapshot.output.nodes.length, 1)
  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'video')
  assert.equal(produced.metadata.video.url, `${VIDEO_FILE_API}/${composer.record.publishes[0].id}-0.mp4`)
  assert.match(produced.metadata.video.url, new RegExp(`^${VIDEO_FILE_API}/compose`))
  assert.equal(produced.metadata.video.mime, 'video/mp4')
  assert.equal(produced.metadata.video.duration, 4)
  assert.equal(produced.metadata.asset, undefined, 'the stitched clip is NOT copied into the canvas asset library')
  assert.equal('asset' in produced.metadata, false)
  assert.equal(produced.metadata.status, 'success')
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, EXPECTED_ORDER)
  assert.equal(produced.metadata.skill.id, 'compose.videos')
  // One edge per source clip, so the lineage is visible on the canvas.
  assert.deepEqual(snapshot.output.connections.map(edge => edge.fromNodeId), EXPECTED_ORDER)
  assert.deepEqual([...new Set(snapshot.output.connections.map(edge => edge.toNodeId))], [produced.id])
  assert.deepEqual(snapshot.output.warnings, [])

  // The publish call carried the human-readable provenance into the history.
  const publish = composer.record.publishes[0]
  assert.equal(publish.mime, 'video/mp4')
  assert.equal(publish.duration, 4)
  assert.equal(Buffer.from(publish.bytes).toString('utf8'), 'stitched-bytes')
  assert.match(publish.prompt, /first prompt/)
  assert.match(publish.prompt, /third prompt/)
  assert.equal(publish.prompt.indexOf('first prompt') < publish.prompt.indexOf('third prompt'), true,
    'the history prompt lists the clips in play order')
  assert.match(String(publish.id), /^compose/)

  // V6 — the node carries the SAME id as the history entry. The canvas 收藏
  // button is gated on `video.entryId` alone, so omitting it yields a gray
  // button while preview/download/frame-grab keep working; nothing else in this
  // suite would notice.
  assert.equal(produced.metadata.video.entryId, publish.id,
    'the produced node carries the history entryId — without it the canvas favorite button is disabled')

  // V7 — provenance is persisted into the video index, so it must NOT be
  // localized: a zh-composed entry re-read under an en UI would otherwise show
  // Chinese. Assert the stored string is language-independent.
  assert.match(publish.prompt, /^stitched from 3 clips:/)
  const zhPrompt = hostLocale.interpolate('canvas.skills.composeNode', undefined, 'zh')
  assert.equal(publish.prompt.includes(zhPrompt), false,
    'the persisted history prompt does not bake in a localized label')
})

// ------------------------------- V10 read-order regression (unequal heights)

await check('V10 a tall clip beside two short ones stays one row and keeps canvas order', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-uneven', title: 'uneven', nodes: [...UNEQUAL_CLIPS] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // NOT the canvas order: the host re-sorts, it never trusts this list.
    nodeIds: [...UNEQUAL_AS_SENT],
  })
  composer.observe(task)
  assert.notDeepEqual([...UNEQUAL_AS_SENT], UNEQUAL_EXPECTED,
    'the fixture only proves anything if the client order differs from the canvas order')
  assert.deepEqual(task.nodeIds, UNEQUAL_EXPECTED,
    'the task records the resolved reading order: the tall clip reads first, then the two short ones top to bottom')

  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))

  // The assertion that catches the regression: this is what ffmpeg would get.
  assert.equal(composer.record.stitchCalls.length, 1, 'exactly one ffmpeg invocation')
  assert.deepEqual(composer.record.stitchCalls[0],
    UNEQUAL_EXPECTED.map(id => `/fake/${id}-0.mp4`),
    'all three overlap vertically, so they form ONE row read left to right — the old centre-in-band rule '
    + 'split them into three rows and handed ffmpeg [r1, wide, r2]')
  assert.deepEqual(composer.record.resolveCalls,
    UNEQUAL_EXPECTED.map(id => `${VIDEO_FILE_API}/${id}-0.mp4`))

  const produced = snapshot.output.nodes[0]
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, UNEQUAL_EXPECTED)
  assert.deepEqual(snapshot.output.connections.map(edge => edge.fromNodeId), UNEQUAL_EXPECTED)
  assert.equal(chatCalls, before)
})

// ------------------------------- V11 row-join regression (overlapping rows)

await check('V11 two overlapping rows stay two rows and keep row-major order', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  const document = { id: 'canvas-grid', title: 'grid', nodes: [...GRID_CLIPS] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // The exact reverse of the canvas order: the host must re-sort by geometry.
    nodeIds: [...GRID_AS_SENT],
  })
  composer.observe(task)
  assert.notDeepEqual([...GRID_AS_SENT], GRID_EXPECTED,
    'the fixture only proves anything if the client order differs from the canvas order')
  assert.deepEqual([...GRID_AS_SENT].reverse(), [...GRID_EXPECTED],
    'the client order is exactly the expected order reversed, so only geometry can produce the result')
  assert.deepEqual(task.nodeIds, GRID_EXPECTED,
    'the task records row-major reading order: two overlapping rows must not merge into one')

  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))

  // The assertion that matters: this is the argument list ffmpeg would receive.
  assert.equal(composer.record.stitchCalls.length, 1, 'exactly one ffmpeg invocation')
  assert.deepEqual(composer.record.stitchCalls[0],
    GRID_EXPECTED.map(id => `/fake/${id}-0.mp4`),
    'the two rows overlap vertically, so a rule that merges on ANY overlap reads this grid column-major '
    + 'and hands ffmpeg [g-a, g-c, g-b, g-d] — two rows must stay two rows')
  assert.deepEqual(composer.record.resolveCalls,
    GRID_EXPECTED.map(id => `${VIDEO_FILE_API}/${id}-0.mp4`))

  const produced = snapshot.output.nodes[0]
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, GRID_EXPECTED)
  assert.deepEqual(snapshot.output.connections.map(edge => edge.fromNodeId), GRID_EXPECTED)
  assert.equal(chatCalls, before)
})

// ------------------------------- V12 what is strictly above plays first

await check('V12 a tall clip does not invert two clips that are strictly one above the other', () => checkOrderFixture(
  'V12',
  'canvas-spine',
  SPINE_CLIPS,
  SPINE_AS_SENT,
  SPINE_EXPECTED,
))

// ------------------------------- V13 a portrait clip must not collapse the grid

await check('V13 a portrait clip beside a 2x2 grid keeps the grid row-major', () => checkOrderFixture(
  'V13',
  'canvas-portrait',
  PORTRAIT_CLIPS,
  PORTRAIT_AS_SENT,
  PORTRAIT_EXPECTED,
))

// ------------------------------- V14 two short rows beside a tall clip

await check('V14 two short rows beside a tall clip stay in row order', () => checkOrderFixture(
  'V14',
  'canvas-tallrows',
  TALLROWS_CLIPS,
  TALLROWS_AS_SENT,
  TALLROWS_EXPECTED,
))

// ------------------- V15 O7: a clip strictly above another must not play after it

await check('V15 a clip strictly above another is never stitched after it', () => checkOrderFixture(
  'V15',
  'canvas-o7',
  O7_CLIPS,
  O7_AS_SENT,
  O7_EXPECTED,
))

// -------------------- V16/V17 nested small clips must stay with their host

await check('V16 a clip nested inside a tall clip is read with it, not after its neighbour', () => checkOrderFixture(
  'V16',
  'canvas-nested',
  NESTED_CLIPS,
  NESTED_AS_SENT,
  NESTED_EXPECTED,
))

await check('V17 the same nesting holds at the minimum node footprint', () => checkOrderFixture(
  'V17',
  'canvas-nested-min',
  NESTED_MIN_CLIPS,
  NESTED_MIN_AS_SENT,
  NESTED_MIN_EXPECTED,
))

// ---------------- V18 a shrunk clip at the proximity floor keeps its row

await check('V18 a shrunk clip 32px lower than its neighbour is still read in that row', () => checkOrderFixture(
  'V18',
  'canvas-floor',
  FLOOR_CLIPS,
  FLOOR_AS_SENT,
  FLOOR_EXPECTED,
))

// ------- V19/V20 a clip nested LOW in a tall host must not jump the queue

await check('V19 a deeply nested clip does not play before the clip above it', () => checkOrderFixture(
  'V19',
  'canvas-deep-nested',
  DEEP_NESTED_CLIPS,
  DEEP_NESTED_AS_SENT,
  DEEP_NESTED_EXPECTED,
))

await check('V20 the same holds when the host is tall enough to leave no ambiguity', () => checkOrderFixture(
  'V20',
  'canvas-deep-nested-tall',
  DEEP_NESTED_TALL_CLIPS,
  DEEP_NESTED_TALL_AS_SENT,
  DEEP_NESTED_TALL_EXPECTED,
))

// --- V21 a lift: a clip wholly above another must never be stitched after it

await check('V21 a clip wholly above another is lifted ahead of it', () => checkOrderFixture(
  'V21',
  'canvas-above-lift',
  ABOVE_LIFT_CLIPS,
  ABOVE_LIFT_AS_SENT,
  ABOVE_LIFT_EXPECTED,
))

// ------------------------------------------------- V8 failure honesty

await check('V8 one unresolvable clip fails the whole run instead of stitching the rest', async () => {
  const composer = fakeComposer()
  liveRunner = makeRunner(composer)
  // Three clips in canvas order first·second·third, but the MIDDLE one points at
  // a history entry the video store no longer serves. A run that skipped it
  // would happily produce a 2-clip video while the canvas showed three badges.
  const gone = {
    ...clipNode('clip-gone', 900, 0, 'second prompt'),
    title: 'second clip',
    metadata: {
      video: { url: `${VIDEO_FILE_API}/compose-gone-0.mp4`, mime: 'video/mp4', duration: 2 },
      status: 'success',
      prompt: 'second prompt',
    },
  }
  const document = { id: 'canvas-gone', title: 'gone', nodes: [CLIPS[1], gone, CLIPS[0]] }
  canvasDocuments.set(document.id, document)

  const before = chatCalls
  const task = await liveRunner.run({
    canvasId: document.id,
    skillId: 'compose.videos',
    // Scrambled again: resolving in canvas order is what makes "the middle one"
    // the clip the USER sees in the middle.
    nodeIds: ['clip-c', 'clip-gone', 'clip-a'],
  })
  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'failed', `a clip that cannot be read must fail the run: ${JSON.stringify(snapshot)}`)
  // The message names the clip by its canvas badge AND its title, so the user
  // knows which of the three to fix. The badge copy is locale-dependent, so it
  // is asserted through the same dictionary the runner renders with.
  assert.equal(snapshot.error,
    copy('canvas.skills.composeFailed', { message: `${copy('canvas.composeBadge', { index: 2 })}：${gone.title}` }))
  assert.match(snapshot.error, /second clip/i, 'the error names the offending clip')
  assert.equal(snapshot.error.includes(copy('canvas.skills.stageDone')), false,
    'a failed run never reports the success stage')
  assert.equal(snapshot.output, undefined, 'a failed run produces no output')

  // The sharpest form of the guarantee: resolution stopped AT the bad clip, so
  // ffmpeg was never reached and nothing can have been published.
  assert.deepEqual(composer.record.resolveCalls, [
    `${VIDEO_FILE_API}/clip-a-0.mp4`,
    `${VIDEO_FILE_API}/compose-gone-0.mp4`,
  ], 'resolution stopped at the offending clip instead of skipping ahead to the next one')
  assert.deepEqual(composer.record.stitchCalls, [], 'never reaches ffmpeg when a source cannot be resolved')
  assert.deepEqual(composer.record.publishes, [], 'nothing lands in the video history')
  assert.equal(chatCalls, before, 'the failure is reported, not answered by a model')

  // Boundary sanity (the full cases stay above; nothing here replaces them):
  // dropping the unreadable clip from the selection makes the SAME fixture run.
  const okComposer = fakeComposer()
  liveRunner = makeRunner(okComposer)
  const okTask = await liveRunner.run({
    canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a', 'clip-c'],
  })
  const okSnapshot = await settleTask(okTask.id)
  assert.equal(okSnapshot.status, 'completed', JSON.stringify(okSnapshot))
  assert.equal(okComposer.record.stitchCalls.length, 1, 'two readable clips still stitch')
  assert.deepEqual(okComposer.record.stitchCalls[0], ['/fake/clip-a-0.mp4', '/fake/clip-c-0.mp4'])
})

// ----------------------------------------- V9 no usable local tool on this host

await check('V9 a host without a usable local composer refuses instead of calling a model', async () => {
  const before = chatCalls

  // (a) No composer wired at all: refused before a task is even created — the
  // same up-front shape as a too-few selection, so the client shows the reason
  // rather than a run card that queues forever.
  liveRunner = makeRunner(undefined)
  const document = { id: 'canvas-nocomposer', title: 'nocomposer', nodes: [CLIPS[0], CLIPS[1]] }
  canvasDocuments.set(document.id, document)
  // composeNoFfmpeg carries a host-specific {detail}; assert the copy up to that
  // slot so the check survives a rewording of the detail.
  const head = copy('canvas.skills.composeNoFfmpeg', { detail: '\u0000' }).split('\u0000')[0]
  assert.notEqual(head, 'canvas.skills.composeNoFfmpeg', 'the locale key resolved to real copy')
  await assert.rejects(
    () => liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a', 'clip-c'] }),
    error => {
      assert.equal(typeof error.message, 'string')
      assert.equal(error.message.startsWith(head), true,
        `expected the composeNoFfmpeg copy, got: ${error.message}`)
      assert.equal(error.message.length > head.length, true, 'the message explains WHICH tool is missing')
      // The heavy/agent branch would have complained about the agent runtime.
      assert.equal(error.message.includes(copy('canvas.skills.needAgent')), false,
        'a local skill must not be reported as an agent-runtime problem')
      return true
    },
  )

  // (b) A composer that IS wired but finds no ffmpeg/ffprobe — the real
  // "machine without ffmpeg" host. That becomes a FAILED task carrying the same
  // localized copy plus the searched-directory detail.
  const bare = fakeComposer()
  const missing = {
    ...bare,
    available: () => false,
    describe: () => 'ffmpeg: not found; ffprobe: not found (searched /nonexistent/bin)',
  }
  liveRunner = makeRunner(missing)
  const task = await liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['clip-a', 'clip-c'] })
  const snapshot = await settleTask(task.id)
  assert.equal(snapshot.status, 'failed', JSON.stringify(snapshot))
  assert.equal(snapshot.error,
    copy('canvas.skills.composeNoFfmpeg', { detail: missing.describe() }),
    'a missing local tool is reported as such, never as a generic failure')
  assert.deepEqual(bare.record.stitchCalls, [], 'no tool, no ffmpeg invocation')
  assert.deepEqual(bare.record.publishes, [], 'no tool, nothing published')
  assert.equal(snapshot.output, undefined)

  // The whole point: neither refusal was answered by a model.
  assert.equal(chatCalls, before, 'a local-tier skill must never be answered by a chat completion')
})

// ------------------------------------------------------------ E1 real ffmpeg

await check('E1 (real ffmpeg) two synthetic clips stitch to roughly twice the length', async () => {
  const dirs = host.localVideoToolDirs()
  const findTool = name => dirs
    .map(dir => join(dir, name))
    .find(candidate => {
      try { accessSync(candidate, FS.X_OK); return statSync(candidate).isFile() } catch { return false }
    })
  const ffmpeg = findTool('ffmpeg')
  const ffprobe = findTool('ffprobe')
  if (ffmpeg === undefined || ffprobe === undefined) {
    skip(`no ffmpeg/ffprobe in ${dirs.join(', ')}`)
  }

  // Two synthetic clips in the video store: the first has real audio, the second
  // is SILENT — which is the branch where the pipeline must synthesize a
  // length-bounded silent track (an unbounded one would be OOM-killed).
  const filesDir = join(root, 'dsh-imagegen', 'videos', 'files')
  mkdirSync(filesDir, { recursive: true })
  const encode = (name, args) => {
    const target = join(filesDir, name)
    const run = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, target], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(run.status, 0, `building ${name} failed: ${run.stderr ?? run.error?.message ?? ''}`)
    return target
  }
  const clipA = encode('e2e-0.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ])
  const clipB = encode('e2e-1.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
  ])
  const durationOf = file => {
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr ?? ''}`)
    return Number.parseFloat(probe.stdout.trim())
  }
  const before = await host.listVideoHistory()
  assert.equal(before.length, 0, 'the video history starts empty')
  const totalInput = durationOf(clipA) + durationOf(clipB)

  liveRunner = makeRunner(host.createClipComposer())
  const document = { id: 'canvas-e2e', title: 'e2e', nodes: [
    { ...clipNode('e2e-b', 900, 0, 'silent second clip'), metadata: { video: { url: `${VIDEO_FILE_API}/e2e-1.mp4`, mime: 'video/mp4', duration: 2 }, status: 'success', prompt: 'silent second clip' } },
    { ...clipNode('e2e-a', 0, 0, 'clip with audio'), metadata: { video: { url: `${VIDEO_FILE_API}/e2e-0.mp4`, mime: 'video/mp4', duration: 2 }, status: 'success', prompt: 'clip with audio' } },
  ] }
  canvasDocuments.set(document.id, document)
  const task = await liveRunner.run({ canvasId: document.id, skillId: 'compose.videos', nodeIds: ['e2e-b', 'e2e-a'] })
  const snapshot = await settleTask(task.id, 600)
  assert.equal(snapshot.status, 'completed', JSON.stringify({ error: snapshot.error, stage: snapshot.stage }))

  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'video')
  const served = String(produced.metadata.video.url).replace(`${VIDEO_FILE_API}/`, '')
  const onDisk = join(filesDir, served)
  assert.equal(statSync(onDisk).size > 0, true, 'the stitched clip exists on disk')
  const outSeconds = durationOf(onDisk)
  // Roughly 2x: the encode normalizes frame rate and pads to 1280x720, so allow
  // a generous window rather than demanding an exact sum.
  assert.equal(outSeconds > totalInput * 0.9 && outSeconds < totalInput * 1.1, true,
    `expected ~${totalInput.toFixed(2)}s, got ${outSeconds.toFixed(2)}s`)

  // It landed in the video history as a compose entry, not as a provider render.
  const history = await host.listVideoHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].mode, 'compose')
  assert.equal(history[0].model, 'ffmpeg')
  assert.equal(history[0].videos.length, 1)
  assert.equal(history[0].videos[0].url, produced.metadata.video.url)
  assert.equal(produced.metadata.asset, undefined, 'still a reference, even on the real path')
  assert.equal(chatCalls, 0, 'the real path spends zero chat calls too')

  rmSync(clipA, { force: true })
  rmSync(clipB, { force: true })
}, 300_000)

// ---------------------------------------------------------------- report

process.stderr.write(`\n${results.join('\n')}\n`)
rmSync(root, { recursive: true, force: true })

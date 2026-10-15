/**
 * PERMANENT GUARD for defect B, kept alongside `smoke-compose.mjs` V22.
 *
 * What is NOT duplicated: PART 2 below exercises the §1.2 guarantee at the RUN
 * level with the REAL `resolve()` (only `stitch`/`publish` are wrapped, because
 * they are the parts that need ffmpeg). V22 is `resolve()` unit level, and every
 * run-level compose test (V8) uses a FAKE composer — so "a favorited gallery
 * clip really reaches the encoder inside a real SkillRunner run" is asserted
 * only here. Both halves were shown live by deliberately breaking them: dropping
 * the gallery store fails 7 assertions here; replacing the §1.2 throw with
 * `continue` fails exactly the 4 `B-§1.2` ones.
 *
 * PART 1's inputs (directory-named-like-a-clip, bare prefix, empty URL, no
 * negative cache) were originally unique to this probe and are now ALSO asserted
 * in V22, so a future edit to CLIP_SOURCES fails in both places by design —
 * section 6/7 of V22 names each one.
 *
 * Originally t6's independent verification of defect B — written from the contract
 * (docs/parity-contract.md §1.1/§1.2), NOT from `scripts/smoke-compose.mjs`.
 *
 * Two halves:
 *
 *  PART 1 — `createClipComposer().resolve()` against a fixture directory tree I
 *  build myself. The load-bearing assertion is that the GALLERY prefix resolves
 *  to the file *in the gallery directory*: the two stores keep different
 *  directories, so "returns some path" is not the claim — a fix that read the
 *  wrong store would still return a path.
 *
 *  PART 2 — §1.2 at the RUN level, which `resolve()` unit checks cannot show:
 *  an unreadable segment must fail the WHOLE run (never silently stitch the
 *  rest), and a favorited gallery clip must actually reach the encoder inside a
 *  real `SkillRunner` run. `stitch`/`publish` are wrapped (they are the only
 *  parts that need ffmpeg) while `resolve` stays the REAL implementation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 't6-verifyB-'))
process.env.DSH_HOME = root

const host = await import(new URL('../lib/index.js', import.meta.url).href)
const hostLocale = await import(new URL('../lib/locale-tables.js', import.meta.url).href)
// The host half installs this at plugin load; a bare `import` of the bundle
// does not run `apply()`, so without it every run message would read as a raw
// locale KEY ("canvas.skills.composeFailed") and the §1.2 assertion below
// could not see whether the failing segment is named at all.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'en')

let passed = 0
let failed = 0
const check = (ok, label) => {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; console.log(`FAIL  ${label}`) }
}

// The host bundle does not re-export the API route table, so the two served
// prefixes are written out and then CHECKED against the built bundle: if the
// routes ever move, this probe fails loudly instead of testing nothing.
const BUNDLE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const VIDEO_PREFIX = '/api/dsh-imagegen/video/file'
const GALLERY_PREFIX = '/api/dsh-imagegen/gallery/video-file'
check(BUNDLE.includes(VIDEO_PREFIX), 'B-setup: the video-store route literal is what the bundle serves')
check(BUNDLE.includes(GALLERY_PREFIX), 'B-setup: the gallery-clip route literal is what the bundle serves')

// ---------------------------------------------------------------- fixture

const videoDir = join(root, 'dsh-imagegen', 'videos', 'files')
const galleryDir = join(root, 'dsh-imagegen', 'gallery', 'videos')
mkdirSync(videoDir, { recursive: true })
mkdirSync(galleryDir, { recursive: true })

/** Names the stores themselves mint: `<uuid>-<index>.<ext>`. */
const historyFile = 'a1b2c3d4-0000-4000-8000-000000000001-0.mp4'
const galleryFile = 'f9e8d7c6-0000-4000-8000-000000000002-1.webm'
const historyPath = join(videoDir, historyFile)
const galleryPath = join(galleryDir, galleryFile)
// A name that is legal in BOTH stores, present in the video store only: it is
// what separates "the prefix picked the right store" from "the name was found".
const twinFile = '00000000-0000-4000-8000-000000000003-0.mov'
const twinPath = join(videoDir, twinFile)
const bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
writeFileSync(historyPath, bytes)
writeFileSync(galleryPath, bytes)
writeFileSync(twinPath, bytes)
// A DIRECTORY whose name matches the store pattern: `stat().isFile()` is the
// only thing standing between it and a returned "path".
mkdirSync(join(galleryDir, '00000000-0000-4000-8000-000000000004-0.mp4'), { recursive: true })

const composer = host.createClipComposer()

// ------------------------------------------------- PART 1: resolve()

const cases = [
  // [url, expected, label]
  [`${VIDEO_PREFIX}/${historyFile}`, historyPath, 'B: the video store prefix resolves to the video store directory'],
  [`${GALLERY_PREFIX}/${galleryFile}`, galleryPath, 'B: THE GALLERY prefix resolves to the GALLERY directory (defect B)'],
  [`${GALLERY_PREFIX}/${twinFile}`, undefined, 'B: a name that only exists in the video store does not resolve through the gallery prefix'],
  [`${VIDEO_PREFIX}/${galleryFile}`, undefined, 'B: a name that only exists in the gallery store does not resolve through the video prefix'],
  [`${VIDEO_PREFIX}/00000000-0000-4000-8000-0000000000ff-0.mp4`, undefined, 'B: a well-formed name with no file on disk resolves to undefined'],
  [`${GALLERY_PREFIX}/00000000-0000-4000-8000-000000000004-0.mp4`, undefined, 'B: a DIRECTORY named like a clip does not resolve'],
  [`${VIDEO_PREFIX}/`, undefined, 'B: the bare prefix with an empty name resolves to undefined'],
  [VIDEO_PREFIX, undefined, 'B: the bare prefix with no slash resolves to undefined'],
  ['/api/dsh-imagegen/gallery/video-file-x/x-0.mp4', undefined, 'B: the lookalike route gallery/video-file-x is not the gallery prefix'],
  ['/api/dsh-imagegen/gallery/image/x-0.png', undefined, 'B: gallery/image/ is not a clip'],
  ['/api/dsh-imagegen/canvas/asset/00000000-0000-4000-8000-000000000000.mp4', undefined, 'B: a canvas ASSET url is not a served clip (cannot be stitched)'],
  ['https://evil.example/x.mp4', undefined, 'B: a foreign absolute URL is not a clip'],
  [`${VIDEO_PREFIX}/../../etc/passwd`, undefined, 'B: raw traversal out of the video store is refused'],
  [`${VIDEO_PREFIX}/..%2F..%2Fetc%2Fpasswd`, undefined, 'B: percent-encoded traversal is refused by the store name pattern'],
  [`${GALLERY_PREFIX}/..%2F..%2F..%2F..%2Fetc%2Fpasswd`, undefined, 'B: percent-encoded traversal out of the gallery store is refused'],
  [`${GALLERY_PREFIX}/..%2Fvideos%2F${twinFile}`, undefined, 'B: gallery traversal cannot reach across into the video store'],
  ['', undefined, 'B: the empty URL resolves to undefined'],
  // Malformed escapes: decodeURIComponent throws on these, and a raw URIError
  // would escape resolve() as an engine message instead of the caller's own
  // "this segment could not be read" report. An unreadable clip is undefined.
  [`${VIDEO_PREFIX}/%ZZ-0.mp4`, undefined, 'B: an invalid percent escape is an unreadable clip, not a crash'],
  [`${VIDEO_PREFIX}/%E0%A4%A-0.mp4`, undefined, 'B: a truncated multi-byte escape is an unreadable clip, not a crash'],
  [`${GALLERY_PREFIX}/%C3%28-0.mp4`, undefined, 'B: a malformed gallery escape is an unreadable clip, not a crash'],
]
for (const [url, expected, label] of cases) {
  let got
  let threw
  try {
    got = await composer.resolve(url)
  } catch (error) {
    threw = error
  }
  // `threw === undefined` is part of the check on purpose: without it a throw
  // leaves `got` undefined, which equals the expected undefined and would let
  // the very defect this guards against pass silently.
  check(
    threw === undefined && got === expected,
    `${label}${threw !== undefined
      ? ` — it THREW ${threw.constructor.name}: ${threw.message}`
      : got === expected ? '' : ` — got ${String(got)}, wanted ${String(expected)}`}`,
  )
}

// A file added AFTER the first call must be seen (no stale negative cache).
const lateFile = '00000000-0000-4000-8000-000000000005-0.mp4'
const latePath = join(galleryDir, lateFile)
check(await composer.resolve(`${GALLERY_PREFIX}/${lateFile}`) === undefined, 'B: not-yet-written gallery file -> undefined')
writeFileSync(latePath, bytes)
check(await composer.resolve(`${GALLERY_PREFIX}/${lateFile}`) === latePath, 'B: the same URL resolves once the file exists (no negative cache)')

// ------------------------------------------------- PART 2: the run

const canvasDocument = {
  version: 2, id: 't6-canvas', title: 't6', revision: 1,
  viewport: { x: 0, y: 0, k: 1 }, background: 'blank',
  nodes: [
    {
      id: 'clip-history', type: 'video', title: '历史片段', x: 0, y: 0, width: 240, height: 240,
      metadata: { status: 'success', video: { url: `${VIDEO_PREFIX}/${historyFile}`, mime: 'video/mp4', duration: 2 } },
    },
    {
      id: 'clip-gallery', type: 'video', title: '收藏片段', x: 300, y: 0, width: 240, height: 240,
      metadata: { status: 'success', video: { url: `${GALLERY_PREFIX}/${galleryFile}`, mime: 'video/webm', duration: 2 } },
    },
    {
      id: 'clip-gone', type: 'video', title: '找不到的片段', x: 600, y: 0, width: 240, height: 240,
      metadata: { status: 'success', video: { url: `${GALLERY_PREFIX}/00000000-0000-4000-8000-0000000000ff-0.mp4`, mime: 'video/mp4' } },
    },
  ],
  connections: [], createdAt: 1, updatedAt: 1,
}

const seen = { resolve: [], stitch: [], publish: [] }
/** The real resolve, instrumented stitch/publish (the only ffmpeg-dependent bits). */
const probeComposer = {
  available: () => true,
  describe: () => 't6 probe composer',
  resolve: url => { seen.resolve.push(url); return composer.resolve(url) },
  stitch: async input => {
    seen.stitch.push(input)
    return { bytes: Buffer.alloc(64), mime: 'video/mp4', duration: 4, width: 1280, height: 720 }
  },
  publish: async input => {
    seen.publish.push(input)
    return { url: `${VIDEO_PREFIX}/00000000-0000-4000-8000-000000000006-0.mp4`, mime: 'video/mp4', duration: 4 }
  },
}

const backend = { canvas: { async read() { return canvasDocument }, async write() {} }, chat: { async complete() { throw new Error('chat must not be called by a local stitch') } } }
const runner = new host.SkillRunner({
  backend,
  enabled: () => true,
  heavyEnabled: () => false,
  allowlist: () => [],
  runRoot: () => join(root, 'runs'),
  heavyTimeoutMs: () => 30_000,
  dataRoot: () => root,
  composer: probeComposer,
})

const settle = async taskId => {
  for (let i = 0; i < 400; i += 1) {
    const snapshot = runner.task(taskId)
    if (snapshot.status === 'completed' || snapshot.status === 'failed') return snapshot
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const last = runner.task(taskId)
  throw new Error(`task never settled: ${JSON.stringify(last)}`)
}

// 1. A favorited GALLERY clip must be a usable source inside a real run.
const okTask = await runner.run({ canvasId: canvasDocument.id, skillId: 'compose.videos', nodeIds: ['clip-gallery', 'clip-history'] })
const okDone = await settle(okTask.id)
check(okDone.status === 'completed', `B-run: a run over [gallery clip, history clip] completes (${okDone.status} ${okDone.error ?? ''})`)
check(seen.stitch.length === 1, 'B-run: the encoder was reached exactly once')
const stitchedSources = seen.stitch[0]?.sources ?? []
check(stitchedSources.includes(galleryPath), 'B-run: the encoder received the GALLERY file path — the favorited clip really was stitched')
check(stitchedSources.includes(historyPath), 'B-run: the encoder received the history file path too')
const outputNodes = okDone.output?.nodes ?? []
check(outputNodes.length === 1 && outputNodes[0].metadata?.video?.url !== undefined, 'B-run: the run produced a referenced video node')
check(outputNodes[0]?.metadata?.asset === undefined, 'B-run: the produced clip node references bytes, it does not copy an asset')

// 2. §1.2 — one unreadable segment fails the WHOLE run, it is never dropped.
seen.stitch.length = 0
seen.publish.length = 0
const badTask = await runner.run({ canvasId: canvasDocument.id, skillId: 'compose.videos', nodeIds: ['clip-history', 'clip-gone'] })
const badDone = await settle(badTask.id)
check(badDone.status === 'failed', 'B-§1.2: a run with one unreadable segment FAILS instead of stitching the rest')
check(seen.stitch.length === 0, 'B-§1.2: the encoder was never invoked for a partially readable run')
check(seen.publish.length === 0, 'B-§1.2: nothing was published for a failed run')
const message = String(badDone.error ?? '')
check(message.includes('找不到的片段'), `B-§1.2: the failure names the unreadable segment (got: ${message})`)

rmSync(root, { recursive: true, force: true })
console.log(`\nT6 PART B: ${passed} PASS / ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)

/**
 * Canvas export/import: the bundle format, its refusals, and the two routes.
 *
 * What this suite is guarding:
 *
 *  B*  base64 — the encoder is hand-written (no `Buffer`, no `btoa`, so the same
 *      module can be inlined into the browser bundle). A codec that silently
 *      mangles a byte produces a PNG that opens as a grey box, which is much
 *      harder to notice than an exception.
 *  R*  the reference walk — an export that misses one reference hands someone a
 *      canvas with a broken picture. The walk has to agree with the store's own
 *      asset sweep (node asset, poster background, poster image layers, and the
 *      background-image URL), because the sweep is what deletes assets nothing
 *      references.
 *  X*  export itself — bytes travel, missing bytes are REPORTED rather than
 *      dropped, and clips are named as not-bundled instead of vanishing.
 *  I*  import — always a NEW canvas id, never overwriting; every rejection names
 *      an actionable code; hostile input (path traversal, oversized, corrupt
 *      base64, wrong version) is refused before anything is written.
 *  T*  the routes — the two endpoints are wired to the same code, refuse on a
 *      backend without import support instead of failing obscurely, and answer
 *      `not-found` rather than throwing.
 *
 * Run: node scripts/smoke-canvas-bundle.mjs   (from the package root)
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

const root = mkdtempSync(join(tmpdir(), 'gal-bundle-'))
process.env.DSH_HOME = root

/**
 * Load the store from SOURCE. `CanvasStore`'s constructor uses a parameter
 * property, which Node's strip-only mode refuses; re-exec once with
 * `--experimental-transform-types` rather than testing a copy of the rules.
 */
async function withTransformTypes() {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(result.status ?? 0)
}

let CanvasStore
try {
  CanvasStore = (await import(new URL('../src/canvas-store.ts', import.meta.url).href)).CanvasStore
} catch (error) {
  if (!/parameter property is not supported/.test(String(error?.message))) throw error
  await withTransformTypes()
}

const bundleModule = await import(new URL('../src/canvas-bundle.ts', import.meta.url).href)
const {
  CANVAS_BUNDLE_FORMAT, CANVAS_BUNDLE_VERSION, CANVAS_BUNDLE_API,
  encodeBase64, decodeBase64, referencedCanvasAssets, bundlingVideoNodes,
  buildCanvasBundle, parseCanvasBundle,
} = bundleModule

// ------------------------------------------------------------ fixtures

/** A real tiny PNG's first bytes are enough: nothing here decodes pixels. */
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
const ref = (assetId, extra = {}) => ({
  assetId,
  url: `/api/dsh-imagegen/canvas/asset/${assetId}`,
  mime: 'image/png',
  bytes: pngBytes.byteLength,
  width: 4,
  height: 4,
  origin: 'upload',
  ...extra,
})

function documentWith(values) {
  return {
    version: 2,
    id: 'doc-1',
    title: '导出测试',
    revision: 3,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: values.nodes ?? [],
    connections: [],
    createdAt: 1,
    updatedAt: 2,
    ...values.extra ?? {},
  }
}

// ------------------------------------------------------------ B* base64

await check('B1 base64 round-trips every length residue class', () => {
  for (let length = 0; length < 40; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255)
    const decoded = decodeBase64(encodeBase64(bytes))
    assert.ok(decoded !== undefined, `length ${length} decodes`)
    assert.deepEqual([...decoded], [...bytes], `length ${length} survives the round trip`)
  }
  // The encoder must agree with the platform's own base64, or a bundle written
  // by one half of the code and read by the other disagrees byte for byte.
  const sample = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
  assert.equal(encodeBase64(sample), Buffer.from(sample).toString('base64'), 'encoder matches Buffer')
})

await check('B2 malformed base64 is refused, not approximated', () => {
  for (const bad of ['A', 'AB', 'AB=D', 'A===', '****', 'AB==AB==', 'A B C D']) {
    assert.equal(decodeBase64(bad), undefined, `${JSON.stringify(bad)} is refused`)
  }
  assert.equal(decodeBase64('ABC'), undefined, 'a partial final group is refused')
  // Padding in the middle of a longer string must not be tolerated: that is how
  // a truncated-then-padded bundle would sneak half an image through.
  assert.equal(decodeBase64('AA==AAAA'), undefined, 'padding before the end is refused')
  assert.equal(decodeBase64('===='), undefined, 'a padding-only string is refused')
})

// --------------------------------------------------- R* reference walk

await check('R1 the walk finds every reference the store sweep would collect', () => {
  const document = documentWith({
    nodes: [
      { id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('a'.repeat(64) + '.png') } },
      {
        id: 'poster', type: 'image', title: '海报', x: 0, y: 0, width: 10, height: 10,
        metadata: {
          asset: ref('b'.repeat(64) + '.png'),
          poster: {
            version: 1, width: 100, height: 100,
            background: ref('c'.repeat(64) + '.png'),
            layers: [
              { id: 'l1', type: 'image', x: 0, y: 0, width: 10, height: 10, asset: ref('d'.repeat(64) + '.png') },
              { id: 'l2', type: 'text', x: 0, y: 0, width: 10, text: 'x', fontSize: 12, fontFamily: 'sans-serif', color: '#000', bold: false, align: 'left' },
            ],
          },
        },
      },
      { id: 'txt', type: 'text', title: '字', x: 0, y: 0, width: 10, height: 10, metadata: { text: 'hello' } },
    ],
    extra: { backgroundImage: `/api/dsh-imagegen/canvas/asset/${'e'.repeat(64)}.png?inline=1` },
  })
  const ids = referencedCanvasAssets(document).map(item => item.assetId[0])
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e'], 'node asset, poster asset, poster background, poster layer, background image')
  // The node attribution is what lets the import panel point at the broken node.
  const byNode = referencedCanvasAssets(document).find(item => item.assetId.startsWith('c'))
  assert.equal(byNode.nodeId, 'poster', 'a poster background is attributed to its node')
})

await check('R2 a non-asset background URL contributes nothing', () => {
  const document = documentWith({
    extra: { backgroundImage: 'https://example.com/some/picture.png' },
  })
  assert.deepEqual(referencedCanvasAssets(document), [], 'a foreign URL is not bundled')
})

await check('R3 video nodes are reported as not-bundled', () => {
  const document = documentWith({
    nodes: [
      { id: 'clip', type: 'video', title: '片段', x: 0, y: 0, width: 10, height: 10, metadata: { video: { url: '/api/dsh-imagegen/videos/file/abc.mp4', mime: 'video/mp4' } } },
      { id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('f'.repeat(64) + '.png') } },
    ],
  })
  assert.deepEqual(bundlingVideoNodes(document).map(node => node.id), ['clip'], 'only the clip node is a video node')
})

// ------------------------------------------------------- X* export

await check('X1 export carries the document and every asset byte', async () => {
  const bundle = await buildCanvasBundle({
    document: documentWith({
      nodes: [{ id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('1'.repeat(64) + '.png') } }],
    }),
    readAsset: async assetId => assetId === '1'.repeat(64) + '.png'
      ? { data: pngBytes, mime: 'image/png' }
      : undefined,
  })
  assert.equal(bundle.format, CANVAS_BUNDLE_FORMAT)
  assert.equal(bundle.version, CANVAS_BUNDLE_VERSION)
  assert.equal(bundle.title, '导出测试')
  assert.equal(bundle.assets.length, 1, 'the referenced asset travelled')
  assert.deepEqual([...decodeBase64(bundle.assets[0].data)], [...pngBytes], 'the bytes are exact')
  assert.deepEqual(bundle.unresolved, [], 'nothing was missing')
})

await check('X2 missing bytes are reported, and the rest still travels', async () => {
  const bundle = await buildCanvasBundle({
    document: documentWith({
      nodes: [
        { id: 'gone', type: 'image', title: '丢了', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('2'.repeat(64) + '.png') } },
        { id: 'here', type: 'image', title: '在', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('3'.repeat(64) + '.png') } },
        { id: 'clip', type: 'video', title: '片段', x: 0, y: 0, width: 10, height: 10, metadata: { video: { url: '/api/dsh-imagegen/videos/file/x.mp4', mime: 'video/mp4' } } },
      ],
    }),
    readAsset: async assetId => assetId.startsWith('3') ? { data: pngBytes, mime: 'image/png' } : undefined,
  })
  assert.equal(bundle.assets.length, 1, 'the asset that still has bytes travelled')
  assert.deepEqual(
    bundle.unresolved.map(item => `${item.kind}:${item.reason}:${item.nodeId}`).sort(),
    ['asset:bytes-missing:gone', 'video:clip-not-bundled:clip'],
    'both cancellations are named with the node they affect',
  )
})

// ------------------------------------------------------- I* import

await check('I1 a re-import is a new canvas, never an overwrite', async () => {
  const store = new CanvasStore(join(root, 'store-i1'))
  const original = await store.create('原画布')
  const asset = await store.putImage({ data: Buffer.from(pngBytes), mime: 'image/png', width: 4, height: 4, origin: 'upload' })
  const saved = await store.save({
    ...original,
    nodes: [{ id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset } }],
  }, original.revision)

  const bundle = await buildCanvasBundle({
    document: saved,
    readAsset: async assetId => {
      const found = await store.readAsset(assetId)
      return found === undefined ? undefined : { data: found.data, mime: found.mime }
    },
  })
  const parsed = parseCanvasBundle(bundle)
  assert.ok(parsed.ok, 'the bundle this store exported parses back')

  const imported = await store.importDocument({ title: parsed.plan.title, document: parsed.plan.document, assets: parsed.plan.assets })
  assert.notEqual(imported.id, saved.id, 'the import gets a new canvas id')
  assert.equal(imported.nodes[0].id, 'img', 'node ids survive, so connections still resolve')
  assert.equal(imported.nodes[0].metadata.asset.assetId, asset.assetId, 'the asset id survived')
  assert.ok(await store.readAsset(asset.assetId) !== undefined, 'the bytes are readable on the importing store')

  // The import must not touch the canvas it came FROM. Comparing ids alone would
  // miss the failure that matters: an import that rewrote the source page's
  // revision, timestamps or nodes while creating its own.
  const source = await store.read(saved.id)
  assert.deepEqual(source, saved, 'every field of the source canvas is untouched, not just its id')
  assert.equal((await store.list()).length, 2, 'both canvases are listed')
})

await check('I2 an empty store imports a bundle it has none of the bytes for', async () => {
  const source = new CanvasStore(join(root, 'store-i2-source'))
  const created = await source.create('搬家')
  const asset = await source.putImage({ data: Buffer.from(pngBytes), mime: 'image/png', width: 4, height: 4, origin: 'upload' })
  const saved = await source.save({
    ...created,
    nodes: [{ id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset } }],
  }, created.revision)
  const bundle = await buildCanvasBundle({
    document: saved,
    readAsset: async assetId => {
      const found = await source.readAsset(assetId)
      return found === undefined ? undefined : { data: found.data, mime: found.mime }
    },
  })
  const parsed = parseCanvasBundle(JSON.parse(JSON.stringify(bundle)))
  assert.ok(parsed.ok, 'a bundle survives a JSON round trip (that is how it is stored)')
  const target = new CanvasStore(join(root, 'store-i2-target'))
  assert.equal(await target.readAsset(asset.assetId), undefined, 'the target store really does not have the bytes')
  const imported = await target.importDocument({ title: parsed.plan.title, document: parsed.plan.document, assets: parsed.plan.assets })
  const found = await target.readAsset(asset.assetId)
  assert.ok(found !== undefined, 'the import wrote the asset bytes')
  assert.deepEqual([...found.data], [...pngBytes], 'byte-for-byte')
  assert.equal(imported.title, '搬家', 'the title travelled')
})

await check('I3 every bad bundle is refused with a code, and nothing is written', async () => {
  const good = await buildCanvasBundle({ document: documentWith({}), readAsset: async () => undefined })
  const cases = [
    ['not an object', null, 'bad-bundle'],
    ['no format marker', { ...good, format: 'something-else' }, 'bad-format'],
    ['future version', { ...good, version: 99 }, 'unsupported-version'],
    ['no document', { ...good, document: undefined }, 'bad-bundle'],
    ['v1 document', { ...good, document: { ...good.document, version: 1 } }, 'unsupported-document'],
    ['pre-refactor version', { ...good, document: { ...good.document, version: 'v1' } }, 'unsupported-document'],
    ['no nodes', { ...good, document: { ...good.document, nodes: undefined } }, 'bad-document'],
    ['bad background', { ...good, document: { ...good.document, background: 'plaid' } }, 'bad-document'],
    ['non-finite viewport', { ...good, document: { ...good.document, viewport: { x: 0, y: 0, k: 0 } } }, 'bad-document'],
    ['assets not a list', { ...good, assets: 'nope' }, 'bad-bundle'],
    ['traversal asset name', { ...good, assets: [{ assetId: '../../etc/passwd', mime: 'image/png', data: '' }] }, 'bad-asset-id'],
    ['absolute asset name', { ...good, assets: [{ assetId: '/etc/passwd', mime: 'image/png', data: '' }] }, 'bad-asset-id'],
    ['asset name without hash', { ...good, assets: [{ assetId: 'picture.png', mime: 'image/png', data: '' }] }, 'bad-asset-id'],
    ['corrupt base64', { ...good, assets: [{ assetId: 'a'.repeat(64) + '.png', mime: 'image/png', data: 'not base64!!' }] }, 'bad-asset-data'],
    ['duplicate asset', {
      ...good,
      assets: [
        { assetId: 'a'.repeat(64) + '.png', mime: 'image/png', data: encodeBase64(pngBytes) },
        { assetId: 'a'.repeat(64) + '.png', mime: 'image/png', data: encodeBase64(pngBytes) },
      ],
    }, 'duplicate-asset'],
    ['huge asset count', { ...good, assets: new Array(2001).fill(null).map((_, index) => ({ assetId: String(index).padStart(64, '0') + '.png', mime: 'image/png', data: '' })) }, 'too-many-assets'],
  ]
  for (const [label, value, code] of cases) {
    const parsed = parseCanvasBundle(value)
    assert.equal(parsed.ok, false, `${label} is refused`)
    assert.equal(parsed.code, code, `${label} names ${code} (got ${parsed.code})`)
    assert.ok(typeof parsed.message === 'string' && parsed.message !== '', `${label} explains itself`)
  }
  // The store must refuse a traversal name too, even if a future caller skips
  // the parse step: this is the second gate, not a duplicate of the first.
  const store = new CanvasStore(join(root, 'store-i3'))
  await assert.rejects(
    () => store.putBundleAssets([{ assetId: '../escape.png', data: pngBytes }]),
    /素材名不合法/,
    'the store refuses a name that would escape the asset directory',
  )
  assert.equal(existsSync(join(root, 'store-i3', 'escape.png')), false, 'nothing escaped onto disk')
})

await check('I4 unresolved entries survive the JSON round trip', async () => {
  const bundle = await buildCanvasBundle({
    document: documentWith({
      nodes: [
        { id: 'gone', type: 'image', title: '丢', x: 0, y: 0, width: 10, height: 10, metadata: { asset: ref('4'.repeat(64) + '.png') } },
        { id: 'clip', type: 'video', title: '片段', x: 0, y: 0, width: 10, height: 10, metadata: { video: { url: '/api/dsh-imagegen/videos/file/x.mp4', mime: 'video/mp4' } } },
      ],
    }),
    readAsset: async () => undefined,
  })
  const parsed = parseCanvasBundle(JSON.parse(JSON.stringify(bundle)))
  assert.ok(parsed.ok, 'parses')
  assert.deepEqual(
    parsed.plan.unresolved.map(item => `${item.kind}:${item.reason}:${item.nodeId}`).sort(),
    ['asset:bytes-missing:gone', 'video:clip-not-bundled:clip'],
  )
  // Garbage inside the list is dropped rather than trusted.
  const dirty = parseCanvasBundle({ ...bundle, unresolved: [{ kind: 'video' }, 7, null, { kind: 'asset', reason: 'bytes-missing', assetId: 'nope' }] })
  assert.ok(dirty.ok, 'a dirty unresolved list does not fail the import')
  assert.deepEqual(dirty.plan.unresolved, [], 'unusable entries are dropped')
})

// ------------------------------------------------------------ T* routes

/**
 * Drive one route handler with a fake request/response pair.
 *
 * `routes` comes from the BUILT package (`lib/index.js`), not from `src/routes.ts`:
 * the source file imports sibling modules with `.js` suffixes that Node cannot
 * resolve against `.ts` files, so loading it directly throws on the first
 * `subscription/oauth.js`. Every other route-level suite in this repo takes the
 * same path, and the built bundle is what actually ships.
 */
async function loadMakeRoutes() {
  const host = await import(new URL('../lib/index.js', import.meta.url).href)
  return host.makeRoutes
}

async function callRoute(routes, path, body) {
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route !== undefined, `the route ${path} is registered`)
  let payload
  const req = {
    method: 'POST',
    url: path,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = { writeHead() {}, end(data) { payload = JSON.parse(data) } }
  await route.handler(req, res)
  return payload
}

await check('T1 export and import are wired to the same code the store proves', async () => {
  const makeRoutes = await loadMakeRoutes()
  const store = new CanvasStore(join(root, 'store-t1'))
  const created = await store.create('路由测试')
  const asset = await store.putImage({ data: Buffer.from(pngBytes), mime: 'image/png', width: 4, height: 4, origin: 'upload' })
  const saved = await store.save({
    ...created,
    nodes: [{ id: 'img', type: 'image', title: '图', x: 0, y: 0, width: 10, height: 10, metadata: { asset } }],
  }, created.revision)

  const routes = makeRoutes({ settings: { describe: () => [], mutate: async () => {} }, resolve: () => ({ apiUrl: '', apiKey: '' }), canvas: store })

  const exported = await callRoute(routes, CANVAS_BUNDLE_API.export, { id: saved.id })
  assert.equal(exported.ok, true, `export succeeds: ${exported.message ?? ''}`)
  assert.equal(exported.bundle.document.id, saved.id, 'the bundle carries the saved document')
  assert.equal(exported.bundle.assets.length, 1, 'the referenced asset is in the bundle')

  const imported = await callRoute(routes, CANVAS_BUNDLE_API.import, { bundle: exported.bundle })
  assert.equal(imported.ok, true, `import succeeds: ${imported.message ?? ''}`)
  assert.notEqual(imported.document.id, saved.id, 'the import landed on a new canvas')
  assert.deepEqual(imported.unresolved, [], 'nothing was reported missing')
  assert.equal((await store.list()).length, 2, 'the importing store now holds two canvases')
})

await check('T2 the routes refuse what they cannot serve', async () => {
  const makeRoutes = await loadMakeRoutes()
  const store = new CanvasStore(join(root, 'store-t2'))
  const routes = makeRoutes({ settings: { describe: () => [], mutate: async () => {} }, resolve: () => ({ apiUrl: '', apiKey: '' }), canvas: store })

  const missing = await callRoute(routes, CANVAS_BUNDLE_API.export, { id: 'no-such-canvas' })
  assert.equal(missing.code, 'not-found', 'an unknown canvas is not-found, not a crash')

  const noId = await callRoute(routes, CANVAS_BUNDLE_API.export, {})
  assert.equal(noId.code, 'bad-request', 'an empty id is a bad request')

  // A backend written before export/import existed must say so, and must not be
  // probed with a partial call that fails halfway through writing assets.
  const legacy = { ...store }
  delete legacy.importDocument
  const legacyRoutes = makeRoutes({ settings: { describe: () => [], mutate: async () => {} }, resolve: () => ({ apiUrl: '', apiKey: '' }), canvas: legacy })
  const unsupported = await callRoute(legacyRoutes, CANVAS_BUNDLE_API.import, { bundle: { format: CANVAS_BUNDLE_FORMAT, version: 1 } })
  assert.equal(unsupported.code, 'canvas-import-unsupported', 'an older backend is told apart from a bad bundle')

  const badVersion = await callRoute(routes, CANVAS_BUNDLE_API.import, { bundle: { format: CANVAS_BUNDLE_FORMAT, version: 99 } })
  assert.equal(badVersion.code, 'unsupported-version', 'a future bundle is refused with its own code')
})

await check('T3 a bundle posted as JSON text is what the route expects', async () => {
  const makeRoutes = await loadMakeRoutes()
  const store = new CanvasStore(join(root, 'store-t3'))
  const created = await store.create('往返')
  const routes = makeRoutes({ settings: { describe: () => [], mutate: async () => {} }, resolve: () => ({ apiUrl: '', apiKey: '' }), canvas: store })
  const exported = await callRoute(routes, CANVAS_BUNDLE_API.export, { id: created.id })
  // The client writes this to a file and reads it back later; prove the exact
  // bytes survive JSON.stringify/parse before they ever touch a disk.
  const text = JSON.stringify({ bundle: exported.bundle })
  const parsed = parseCanvasBundle(JSON.parse(text).bundle)
  assert.ok(parsed.ok, 'the text form parses back')
  assert.deepEqual(parsed.plan.document, exported.bundle.document, 'the document is unchanged by serialisation')
  const imported = await callRoute(routes, CANVAS_BUNDLE_API.import, { bundle: exported.bundle })
  assert.equal(imported.ok, true)
  const documents = readdirSync(join(root, 'store-t3', 'pages'))
  assert.equal(documents.length, 2, 'two pages on disk: the original and the import')
  assert.ok(readFileSync(join(root, 'store-t3', 'pages', `${imported.document.id}.json`), 'utf8').includes('往返'), 'the import is a real file')
})

// ------------------------------------------------------------ run

for (const { name, fn } of checks) {
  process.stderr.write(`... ${name}\n`)
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

rmSync(root, { recursive: true, force: true })
for (const line of results) console.log(line)

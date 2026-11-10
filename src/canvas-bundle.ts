/**
 * Canvas export/import bundles.
 *
 * A canvas document alone is not portable: every image and file node points at
 * a content-addressed asset in this machine's store, and a poster's recipe
 * points at assets no node carries directly. Handing someone the JSON would
 * give them a canvas full of broken pictures.
 *
 * So a bundle carries both halves — the `CanvasDocument` v2 exactly as saved,
 * plus the raw bytes of every asset it references. The format is one JSON
 * object; bytes travel base64 inside it. There is deliberately no archive
 * container: a canvas export has to be inspectable with `jq` when something
 * goes wrong, and adding a zip dependency to a plugin that ships a browser
 * bundle is a cost this feature does not justify.
 *
 * This module is pure: no `node:` imports, no filesystem, no network. The
 * routes own I/O and the store owns writing, which keeps the validation rules
 * testable on their own and keeps the module safe to import from the client
 * half for the path constants.
 */

import type { CanvasDocument, CanvasNode } from './protocol.ts'

/** Marker written into every bundle; a file without it is not ours. */
export const CANVAS_BUNDLE_FORMAT = 'dsh-imagegen-canvas-bundle'

/** Bundle schema version. Bumped only when an older importer would misread one. */
export const CANVAS_BUNDLE_VERSION = 1

/** Routes serving bundle export/import (client and host agree through these). */
export const CANVAS_BUNDLE_API = {
  export: '/api/dsh-imagegen/canvas/bundle/export',
  import: '/api/dsh-imagegen/canvas/bundle/import',
} as const

/**
 * Cap on the decoded size of one whole bundle.
 *
 * Sized against the realistic worst case rather than a round number: a canvas
 * with several 4K generations and a handful of attachments runs into tens of
 * megabytes, and an export that silently refuses to include an asset the user
 * can see on screen would be worse than a slow request. Above this the export
 * fails loudly with the size it measured.
 */
export const MAX_CANVAS_BUNDLE_BYTES = 256 * 1024 * 1024

/** Cap on asset entries, so a hand-made bundle cannot pin the process on a loop. */
export const MAX_CANVAS_BUNDLE_ASSETS = 2000

/** Cap on one asset's decoded bytes: the canvas file-asset ceiling. */
export const MAX_CANVAS_BUNDLE_ASSET_BYTES = 50 * 1024 * 1024

/** Content-addressed asset names only: `<64 hex>.<1-8 latin chars>`. */
const BUNDLE_ASSET_ID = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/

/** One asset's bytes inside a bundle. */
export interface CanvasBundleAsset {
  /** Content-addressed file name, the same id the document references. */
  assetId: string
  mime: string
  /** Base64 of the raw bytes (not a data URL: no `;base64,` prefix). */
  data: string
}

/**
 * Something the bundle could not carry, reported instead of dropped.
 *
 * Two cases exist today, and both must reach the person importing: a clip that
 * lives in the video store rather than the canvas asset store (a bundle would
 * have to copy whole videos), and an asset whose bytes were already gone from
 * disk at export time.
 */
export interface CanvasBundleUnresolved {
  kind: 'asset' | 'video'
  reason: 'bytes-missing' | 'clip-not-bundled'
  /** Asset id, for `kind: 'asset'`. */
  assetId?: string
  /** The node that referenced it, so the UI can point at the broken picture. */
  nodeId?: string
}

/** The whole portable form of one canvas. */
export interface CanvasBundle {
  format: typeof CANVAS_BUNDLE_FORMAT
  version: typeof CANVAS_BUNDLE_VERSION
  exportedAt: number
  /** Title at export time; the importer offers it as the new canvas's name. */
  title: string
  document: CanvasDocument
  assets: CanvasBundleAsset[]
  unresolved: CanvasBundleUnresolved[]
}

/** One asset's bytes, decoded and ready for the store to write. */
export interface CanvasBundleImportAsset {
  assetId: string
  data: Uint8Array
}

/**
 * What an importer should apply. The document still carries the id it had on
 * the exporting machine — the caller replaces it, because an import must always
 * create a new canvas and never touch an existing one.
 */
export interface CanvasBundleImportPlan {
  title: string
  document: CanvasDocument
  assets: CanvasBundleImportAsset[]
  unresolved: CanvasBundleUnresolved[]
}

/** Outcome of reading an untrusted bundle: either a plan or an actionable code. */
export type CanvasBundleParseResult =
  | { ok: true; plan: CanvasBundleImportPlan }
  | { ok: false; code: string; message: string }

// ------------------------------------------------------------------ base64

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) table[BASE64_ALPHABET.charCodeAt(index)] = index
  return table
})()

/** Base64-encode bytes without depending on `Buffer` or `btoa`. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]!
      + BASE64_ALPHABET[(chunk >> 6) & 63]! + BASE64_ALPHABET[chunk & 63]!
  }
  const remaining = bytes.length - index
  if (remaining === 1) {
    const chunk = bytes[index]! << 16
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]! + '=='
  } else if (remaining === 2) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8)
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]!
      + BASE64_ALPHABET[(chunk >> 6) & 63]! + '='
  }
  return out
}

/**
 * Decode base64, or `undefined` when the input is not valid base64.
 *
 * Strict on purpose: padding must be well formed and nothing outside the
 * alphabet is accepted, so a truncated or hand-edited bundle fails here rather
 * than writing half an image and letting the canvas show a corrupt picture.
 */
export function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined
  let padding = 0
  if (value.endsWith('==')) padding = 2
  else if (value.endsWith('=')) padding = 1
  const out = new Uint8Array((value.length / 4) * 3 - padding)
  let outIndex = 0
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_LOOKUP[value.charCodeAt(index)]
    const b = BASE64_LOOKUP[value.charCodeAt(index + 1)]
    const cRaw = value.charCodeAt(index + 2)
    const dRaw = value.charCodeAt(index + 3)
    const c = cRaw === 61 ? 0 : BASE64_LOOKUP[cRaw]
    const d = dRaw === 61 ? 0 : BASE64_LOOKUP[dRaw]
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined
    // Padding may only appear in the final group, and only in the last one or
    // two positions of it.
    if ((cRaw === 61 || dRaw === 61) && index + 4 !== value.length) return undefined
    if (cRaw === 61 && dRaw !== 61) return undefined
    const chunk = (a << 18) | (b << 12) | (c << 6) | d
    if (outIndex < out.length) out[outIndex++] = (chunk >> 16) & 255
    if (outIndex < out.length) out[outIndex++] = (chunk >> 8) & 255
    if (outIndex < out.length) out[outIndex++] = chunk & 255
  }
  return out
}

// ------------------------------------------------------- asset references

/** One asset id reached through the document, with the node that references it. */
export interface CanvasAssetReference {
  assetId: string
  nodeId?: string
}

/**
 * Loose structural check for an asset reference.
 *
 * Deliberately loose where `canvas-store`'s own check is strict: a bundle has
 * to carry the bytes of whatever the document mentions, so a reference that is
 * merely incomplete still names an asset worth exporting. The store re-validates
 * every node on save and decides whether the document is acceptable.
 */
function isAssetRefLoose(value: unknown): value is { assetId: string } {
  return value !== null && typeof value === 'object'
    && typeof (value as { assetId?: unknown }).assetId === 'string'
    && (value as { assetId: string }).assetId !== ''
}

/**
 * Pull the asset id out of a served asset URL.
 *
 * The canvas background image is stored as a URL rather than a ref, so its id
 * only exists inside the path. Unparseable or foreign URLs yield nothing: this
 * function never guesses, because a guess would bundle the wrong picture.
 */
function assetIdFromUrl(url: string): string | undefined {
  const last = url.split('/').pop() ?? ''
  const file = decodeURIComponent(last.split('?')[0] ?? '')
  return BUNDLE_ASSET_ID.test(file) ? file : undefined
}

/**
 * Every asset the document actually needs, in first-seen order.
 *
 * Mirrors the reference walk the store's own asset sweep performs: node asset,
 * poster background and poster image layers, plus the background-image URL. A
 * canvas that exports a subset here would lose exactly what the sweep would
 * later collect, so the two walks have to agree — see the smoke suite.
 */
export function referencedCanvasAssets(document: CanvasDocument): CanvasAssetReference[] {
  const out: CanvasAssetReference[] = []
  const seen = new Set<string>()
  const push = (assetId: string | undefined, nodeId?: string): void => {
    if (assetId === undefined || seen.has(assetId)) return
    seen.add(assetId)
    out.push({ assetId, ...nodeId === undefined ? {} : { nodeId } })
  }
  for (const node of document.nodes as readonly CanvasNode[]) {
    const metadata = node.metadata as
      | { asset?: unknown; poster?: unknown }
      | undefined
    const asset = metadata?.asset
    if (isAssetRefLoose(asset)) push(asset.assetId, node.id)
    const poster = metadata?.poster
    if (poster !== null && typeof poster === 'object') {
      const recipe = poster as { background?: unknown; layers?: unknown }
      if (isAssetRefLoose(recipe.background)) push(recipe.background.assetId, node.id)
      if (Array.isArray(recipe.layers)) {
        for (const layer of recipe.layers) {
          if (layer === null || typeof layer !== 'object') continue
          const inner = (layer as { asset?: unknown }).asset
          if (isAssetRefLoose(inner)) push(inner.assetId, node.id)
        }
      }
    }
  }
  if (typeof document.backgroundImage === 'string' && document.backgroundImage !== '') {
    push(assetIdFromUrl(document.backgroundImage))
  }
  return out
}

/** Nodes whose clip lives in the video store rather than the asset store. */
export function bundlingVideoNodes(document: CanvasDocument): CanvasNode[] {
  return (document.nodes as readonly CanvasNode[]).filter(node => {
    const video = (node.metadata as { video?: unknown } | undefined)?.video
    return video !== null && typeof video === 'object' && typeof (video as { url?: unknown }).url === 'string'
  })
}

// ------------------------------------------------------------------ export

/**
 * Build a bundle from a saved document.
 *
 * `readAsset` is injected rather than imported so the routes can pass the
 * store (or a test double) and this module stays pure. A referenced asset whose
 * bytes are gone does not fail the export: it is listed in `unresolved` and the
 * rest still travels, because half a canvas the user can repair beats no export.
 */
export async function buildCanvasBundle(input: {
  document: CanvasDocument
  readAsset: (assetId: string) => Promise<{ data: Uint8Array; mime: string } | undefined>
}): Promise<CanvasBundle> {
  const assets: CanvasBundleAsset[] = []
  const unresolved: CanvasBundleUnresolved[] = []
  let total = 0
  for (const reference of referencedCanvasAssets(input.document)) {
    const found = await input.readAsset(reference.assetId)
    if (found === undefined) {
      unresolved.push({
        kind: 'asset',
        reason: 'bytes-missing',
        assetId: reference.assetId,
        ...reference.nodeId === undefined ? {} : { nodeId: reference.nodeId },
      })
      continue
    }
    if (found.data.byteLength > MAX_CANVAS_BUNDLE_ASSET_BYTES) {
      unresolved.push({
        kind: 'asset',
        reason: 'bytes-missing',
        assetId: reference.assetId,
        ...reference.nodeId === undefined ? {} : { nodeId: reference.nodeId },
      })
      continue
    }
    total += found.data.byteLength
    if (total > MAX_CANVAS_BUNDLE_BYTES) throw new Error(`画布素材合计超过 ${Math.round(MAX_CANVAS_BUNDLE_BYTES / (1024 * 1024))}MB 上限，无法打包导出`)
    assets.push({
      assetId: reference.assetId,
      mime: found.mime === '' ? 'application/octet-stream' : found.mime,
      data: encodeBase64(found.data),
    })
    if (assets.length > MAX_CANVAS_BUNDLE_ASSETS) throw new Error(`画布素材数量超过 ${MAX_CANVAS_BUNDLE_ASSETS} 个上限`)
  }
  // Clips are referenced, never copied (docs/parity-contract.md §1.7). The bundle
  // keeps the reference so the nodes survive, and says out loud that the bytes
  // did not come along — a node that silently stops playing looks like data loss.
  for (const node of bundlingVideoNodes(input.document)) {
    unresolved.push({ kind: 'video', reason: 'clip-not-bundled', nodeId: node.id })
  }
  return {
    format: CANVAS_BUNDLE_FORMAT,
    version: CANVAS_BUNDLE_VERSION,
    exportedAt: Date.now(),
    title: input.document.title,
    document: input.document,
    assets,
    unresolved,
  }
}

// ------------------------------------------------------------------ import

const BACKGROUNDS = new Set([
  'dots', 'lines', 'blank', 'image', 'flow', 'liquid', 'floatingLines',
  'galaxy', 'silk', 'waves', 'faultyTerminal', 'dotField', 'dotGrid', 'shapeGrid',
])

function fail(code: string, message: string): CanvasBundleParseResult {
  return { ok: false, code, message }
}

/**
 * Validate and decode an untrusted bundle.
 *
 * Deliberately total: every rejection names a code the client can act on, and
 * nothing here mutates state. The store's own `save` still re-validates the
 * document node by node — this pass only has to reject what would be unsafe or
 * meaningless to hand it, not re-implement its schema.
 */
export function parseCanvasBundle(value: unknown): CanvasBundleParseResult {
  if (value === null || typeof value !== 'object') return fail('bad-bundle', '这不是一个画布文件')
  const bundle = value as Record<string, unknown>
  if (bundle.format !== CANVAS_BUNDLE_FORMAT) return fail('bad-format', '这不是本插件导出的画布文件')
  if (bundle.version !== CANVAS_BUNDLE_VERSION) {
    return fail('unsupported-version', `画布文件版本 ${String(bundle.version)} 不受支持，请升级插件后再导入`)
  }
  const document = bundle.document
  if (document === null || typeof document !== 'object') return fail('bad-bundle', '画布文件里没有画布内容')
  const raw = document as Record<string, unknown>
  if (raw.version !== 2) return fail('unsupported-document', '只支持 v2 画布文档')
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) return fail('bad-document', '画布节点或连线格式不正确')
  if (typeof raw.background !== 'string' || !BACKGROUNDS.has(raw.background)) return fail('bad-document', '画布背景类型不正确')
  const viewport = raw.viewport
  if (viewport === null || typeof viewport !== 'object') return fail('bad-document', '画布视口格式不正确')
  const { x, y, k } = viewport as Record<string, unknown>
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k) || (k as number) <= 0) {
    return fail('bad-document', '画布视口数值不正确')
  }
  if (!Array.isArray(bundle.assets)) return fail('bad-bundle', '画布文件缺少素材列表')
  if (bundle.assets.length > MAX_CANVAS_BUNDLE_ASSETS) {
    return fail('too-many-assets', `素材数量超过 ${MAX_CANVAS_BUNDLE_ASSETS} 个上限`)
  }

  const assets: CanvasBundleImportAsset[] = []
  const seen = new Set<string>()
  let total = 0
  for (const entry of bundle.assets as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') return fail('bad-asset', '素材条目格式不正确')
    const item = entry as Record<string, unknown>
    const assetId = item.assetId
    if (typeof assetId !== 'string' || !BUNDLE_ASSET_ID.test(assetId)) {
      return fail('bad-asset-id', '素材名不合法：只接受内容寻址的文件名')
    }
    if (seen.has(assetId)) return fail('duplicate-asset', `素材 ${assetId} 重复出现`)
    if (typeof item.data !== 'string') return fail('bad-asset-data', `素材 ${assetId} 缺少内容`)
    const decoded = decodeBase64(item.data)
    if (decoded === undefined) return fail('bad-asset-data', `素材 ${assetId} 的 base64 内容损坏`)
    if (decoded.byteLength > MAX_CANVAS_BUNDLE_ASSET_BYTES) {
      return fail('asset-too-large', `素材 ${assetId} 超过单个 ${Math.round(MAX_CANVAS_BUNDLE_ASSET_BYTES / (1024 * 1024))}MB 上限`)
    }
    total += decoded.byteLength
    if (total > MAX_CANVAS_BUNDLE_BYTES) {
      return fail('bundle-too-large', `画布素材合计超过 ${Math.round(MAX_CANVAS_BUNDLE_BYTES / (1024 * 1024))}MB 上限`)
    }
    seen.add(assetId)
    assets.push({ assetId, data: decoded })
  }

  const unresolved: CanvasBundleUnresolved[] = Array.isArray(bundle.unresolved)
    ? (bundle.unresolved as readonly unknown[]).flatMap(entry => {
      if (entry === null || typeof entry !== 'object') return []
      const item = entry as Record<string, unknown>
      if (item.kind !== 'asset' && item.kind !== 'video') return []
      if (item.reason !== 'bytes-missing' && item.reason !== 'clip-not-bundled') return []
      const assetId = typeof item.assetId === 'string' && BUNDLE_ASSET_ID.test(item.assetId) ? item.assetId : undefined
      // An asset reference that names no asset tells the importer nothing it can
      // act on — it cannot show a placeholder for it or look for it on disk — so
      // it is dropped rather than surfaced as an anonymous "something is missing".
      if (item.kind === 'asset' && assetId === undefined) return []
      return [{
        kind: item.kind,
        reason: item.reason,
        ...assetId === undefined ? {} : { assetId },
        ...typeof item.nodeId === 'string' ? { nodeId: item.nodeId } : {},
      } as CanvasBundleUnresolved]
    })
    : []

  const title = typeof bundle.title === 'string' && bundle.title.trim() !== ''
    ? bundle.title
    : typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : '导入的画布'

  return {
    ok: true,
    plan: {
      title,
      document: raw as unknown as CanvasDocument,
      assets,
      unresolved,
    },
  }
}

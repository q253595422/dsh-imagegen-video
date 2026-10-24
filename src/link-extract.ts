export type LinkExtractResult =
  | { ok: true; title: string; images: string[]; sellingPoints: string[]; price?: string; source: 'json-ld' | 'og' }
  | { ok: false; reason: 'no-product-data' }

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function products(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(products)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  const type = object['@type']
  const types = Array.isArray(type) ? type : [type]
  const own = types.some(item => item === 'Product' || (typeof item === 'string' && item.endsWith(':Product')))
  return [...(own ? [object] : []), ...products(object['@graph'])]
}
function meta(html: string, key: string): string[] {
  const out: string[] = []
  const re = /<meta\b[^>]*>/gi
  for (const tag of html.match(re) ?? []) {
    const property = /(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]
    if (property?.toLowerCase() !== key.toLowerCase()) continue
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1]
    if (content) out.push(decode(content))
  }
  return out
}
function jsonLd(html: string): unknown[] {
  const out: unknown[] = []
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(match[1] ?? '')) } catch { /* malformed JSON-LD is ignored */ }
  }
  return out
}
export function extractProductLink(html: string, pageUrl: string): LinkExtractResult {
  for (const candidate of jsonLd(html).flatMap(products)) {
    const title = text(candidate.name)
    if (!title) continue
    const rawImages = Array.isArray(candidate.image) ? candidate.image : [candidate.image]
    const images = rawImages.map(text).map(value => { try { return new URL(value, pageUrl).toString() } catch { return '' } }).filter(value => /^https?:$/.test(new URL(value || 'http://invalid').protocol))
    const description = text(candidate.description)
    const offers = candidate.offers && typeof candidate.offers === 'object' ? candidate.offers as Record<string, unknown> : undefined
    const price = text(offers?.lowPrice) || text(offers?.price)
    return { ok: true, title, images, sellingPoints: description ? [description] : [], ...(price ? { price } : {}), source: 'json-ld' }
  }
  const title = meta(html, 'og:title')[0] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || ''
  const images = [...meta(html, 'og:image'), ...meta(html, 'og:image:url')].map(value => { try { const url = new URL(value, pageUrl); return /^https?:$/.test(url.protocol) ? url.toString() : '' } catch { return '' } }).filter(Boolean)
  const description = meta(html, 'og:description')[0] || ''
  if (!title && images.length === 0 && !description) return { ok: false, reason: 'no-product-data' }
  return { ok: true, title, images, sellingPoints: description ? [description] : [], source: 'og' }
}

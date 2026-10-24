export type PromoPlatform = 'xiaohongshu' | 'douyin' | 'taobao' | 'dewu'
export interface PromoCopy { title: string; body: string; tags: string[] }
export function promoImagePrompt(platform: PromoPlatform, product: string, points: string): string {
  const style = { xiaohongshu: '明亮自然光、生活方式场景、轻松种草构图', douyin: '强对比灯光、醒目主体、节奏感爆款视觉', taobao: '纯净棚拍、商品居中、留白充足、商业主图质感', dewu: '冷静中性背景、细节清晰、干净高级、潮流编辑感' }[platform]
  return `电商带货产品摄影，${style}。商品：${product}。卖点：${points}。不添加任何文字、Logo 或排版。`
}
export function parsePromoCopy(value: unknown): PromoCopy {
  if (!value || typeof value !== 'object') throw new Error('copy response is not an object')
  const item = value as Record<string, unknown>
  if (typeof item.title !== 'string' || typeof item.body !== 'string' || !Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string')) throw new Error('copy response has invalid fields')
  return { title: item.title, body: item.body, tags: item.tags as string[] }
}

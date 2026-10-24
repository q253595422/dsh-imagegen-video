/**
 * Product-listing copy generation (task-20): turns the product-set draft into
 * marketplace-ready listing copy over the SAME chat channel the prompt
 * enhancer uses. The host side owns the system prompt and the structured
 * output validation; the model is told to use only facts from the input, and
 * every failure mode (prose answers, malformed JSON, missing fields) surfaces
 * as an actionable error instead of silent fallback.
 */

import { chatComplete, jsonPayload, type PromptModelConfig } from './prompt-enhancer.ts'
import type { ListingCopy, ListingCopyRequest, ListingCopyResult, ListingSpec } from './protocol.ts'

/** Platform title limits in characters. 「淘宝 / 京东」= 60, Amazon = 200. */
const TITLE_LIMITS: ReadonlyArray<readonly [pattern: RegExp, limit: number]> = [
  [/amazon|亚马逊/i, 200],
  [/淘宝|京东|taobao|jd\b/i, 60],
]

/** Fallback title limit for the「通用」platform. */
const DEFAULT_TITLE_LIMIT = 60

/** Title limit that applies to one platform label. */
export function listingTitleLimit(platform: string): number {
  const hit = TITLE_LIMITS.find(([pattern]) => pattern.test(platform))
  return hit?.[1] ?? DEFAULT_TITLE_LIMIT
}

/** The listing system prompt: structure, limits and the no-invention rule. */
function listingSystemPrompt(limit: number): string {
  return [
    '你是电商上架文案生成器。只输出一个 JSON 对象，不要输出任何其他文字、解释或 markdown 围栏。',
    '结构：',
    `{"title": "商品标题（不超过 ${limit} 字符）", "sellingPoints": ["卖点，3-5 条，每条不超过 20 字"], "description": "商品描述，300-600 字，分段", "keywords": ["搜索关键词，5-10 个"], "specs": [{"name": "规格名", "value": "规格值"}]}`,
    '硬性规则：只使用输入中明确给出的事实。不要虚构材质、产地、认证、成分、参数或任何未提供的商品属性——用户没给的信息就跳过，不要编。',
    '所有文案语言必须与输入的语言一致。',
  ].join('\n')
}

/** The user turn: everything the draft actually states, nothing else. */
function listingUserPrompt(request: ListingCopyRequest): string {
  const parts = [
    `商品名称：${request.productName.trim() === '' ? '（未填写）' : request.productName.trim()}`,
    `商品品类：${request.category}`,
    `目标平台：${request.platform}`,
    `文案语言：${request.language}`,
  ]
  if (request.promptInfo.trim() !== '') {
    parts.push(`商品信息（唯一可用的事实来源，不要超出）：\n${request.promptInfo.trim()}`)
  } else {
    parts.push('商品信息：（用户未填写额外信息）')
  }
  return parts.join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
  return items.length > 0 ? items : undefined
}

function asSpecs(value: unknown): ListingSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter(isRecord)
    .map(item => ({ name: asString(item.name) ?? '', value: asString(item.value) ?? '' }))
    .filter(spec => spec.name !== '' && spec.value !== '')
  return items.length > 0 ? items : undefined
}

/**
 * Run one listing-copy generation. Throws with the model's own error message
 * when the chat channel is not configured or the upstream fails; returns
 * `ok: false` with an actionable message when the answer carries no usable
 * JSON structure (prose replies must never be shown as listing copy).
 */
export async function generateListingCopy(config: PromptModelConfig, request: ListingCopyRequest): Promise<ListingCopyResult> {
  const limit = listingTitleLimit(request.platform)
  const answer = await chatComplete(config, {
    temperature: 0.6,
    system: listingSystemPrompt(limit),
    content: listingUserPrompt(request),
  })
  const payload = jsonPayload(answer)
  if (payload === undefined || !isRecord(payload)) {
    return {
      ok: false,
      code: 'listing-copy-unstructured',
      message: `模型返回的不是结构化文案（无法解析出 JSON 对象）。请重试；若持续出现，换用支持指令跟随的模型。原始回复开头：${answer.slice(0, 120)}`,
    }
  }
  const copy: ListingCopy = {
    title: asString(payload.title),
    sellingPoints: asStringArray(payload.sellingPoints),
    description: asString(payload.description),
    keywords: asStringArray(payload.keywords),
    specs: asSpecs(payload.specs),
  }
  // A JSON object with no usable field in ANY slot is the same user
  // experience as a prose answer: nothing to show, retry. Returning
  // `ok: true` with an empty copy would make the UI report success while
  // showing nothing, so it fails as unstructured instead.
  const hasAny = copy.title !== undefined || copy.sellingPoints !== undefined || copy.description !== undefined || copy.keywords !== undefined || copy.specs !== undefined
  if (!hasAny) {
    return {
      ok: false,
      code: 'listing-copy-unstructured',
      message: `模型返回的 JSON 里没有可用的文案字段（title/sellingPoints/description/keywords/specs 均为空或类型不符）。请重试；若持续出现，换用支持指令跟随的模型。原始回复开头：${answer.slice(0, 120)}`,
    }
  }
  return { ok: true, copy }
}

/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */

import { isLikelyImageModelId } from './model-catalog.ts'
import { isChatCompletionsUrl, qwenDrawBaseUrl, resolveChannelProtocol, type ChannelProtocolPreference } from './protocol.ts'
import { diagnoseNonJsonBody } from './upstream-diagnosis.ts'

/** Bounded wait for one chat completion. A hung chat endpoint would otherwise
 *  leave prompt enhancement (and the canvas light tier) pending forever. */
const CHAT_TIMEOUT_MS = 60_000

/** Bounded wait per `/models` attempt. Discovery walks a few candidate URLs in
 *  turn, so this caps each one instead of the whole walk. */
const MODELS_TIMEOUT_MS = 30_000

export interface PromptModelConfig {
  apiUrl: string
  apiKey: string
  model: string
}

/** Credentials shared by OpenAI-compatible `/models` discovery. */
export interface ModelListConfig {
  apiUrl: string
  apiKey: string
  apiUrlFull?: boolean
  protocol?: ChannelProtocolPreference
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

function headers(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...apiKey.trim() === '' ? {} : { authorization: `Bearer ${apiKey.trim()}` },
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body === null || typeof body !== 'object') {
    const message = body !== null && typeof body === 'object' && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as Record<string, unknown>
}

type ModelRecord = Record<string, unknown> & { id: string }

/** Google-native endpoint URL from a configured base or full URL: known
 *  suffixes (/models/<id>:generateContent, /interactions, /models) are stripped
 *  back to the versioned base, then one model is addressed. Without a model
 *  this is the GET models-list URL. Query and hash never travel. */
export function googleNativeUrl(apiUrl: string, model = ''): string {
  const trimmed = apiUrl.trim()
  if (trimmed === '') throw new Error('API URL is required')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Google 原生协议需要绝对 API URL（如 https://generativelanguage.googleapis.com/v1beta）')
  }
  const path = url.pathname.replace(/\/+$/, '')
    .replace(/\/models\/[^/]+:generateContent$/, '')
    .replace(/\/interactions$/, '')
    .replace(/\/models$/, '')
  const id = model.trim().replace(/^models\//, '')
  url.pathname = id === '' ? `${path}/models` : `${path}/models/${encodeURIComponent(id)}:generateContent`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Candidate /models URLs for a configured base URL, most specific first. */
function modelListUrls(config: ModelListConfig): string[] {
  const base = config.apiUrl.trim().replace(/\/+$/, '')
  if (base === '') throw new Error('API URL is required')
  if (resolveChannelProtocol(base, config.protocol) === 'google-native') return [googleNativeUrl(base)]
  if (resolveChannelProtocol(base, config.protocol) === 'qwen-draw') {
    const root = qwenDrawBaseUrl(base)
    return [root === '' ? '/api/models' : `${root}/api/models`]
  }
  const urls: string[] = []
  if (resolveChannelProtocol(base, config.protocol) === 'chat-completions' && isChatCompletionsUrl(base)) {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/chat\/completions\/?$/, '')}/models`
    url.search = ''
    url.hash = ''
    urls.push(url.toString())
    return urls
  }
  urls.push(endpoint(base, '/models'))
  try {
    const url = new URL(base)
    const path = url.pathname.replace(/\/+$/, '')
    // Some gateways serve their marketing site at /models and the API only
    // under /v1. Try that conventional suffix when the configured base does
    // not already end in a version segment.
    if (!/\/v\d+(?:[a-z0-9._-]*)?$/i.test(path)) {
      url.pathname = `${path === '' || path === '/' ? '' : path}/v1/models`
      url.search = ''
      url.hash = ''
      urls.push(url.toString())
    }
  } catch {
    // Non-URL bases fall back to the original string concatenation behavior.
  }
  return [...new Set(urls)]
}

/** The same URL with one query parameter set, leaving existing ones intact. */
function withSearchParam(value: string, key: string, parameter: string): string {
  try {
    const url = new URL(value)
    url.searchParams.set(key, parameter)
    return url.toString()
  } catch {
    // A bare path (qwen-draw's `/api/models` fallback) cannot carry a query;
    // image scoping never asks for one there anyway.
    return value
  }
}

/**
 * Image-scoped `/models` candidates: the normal walk with `kind=image` added.
 *
 * Magpie's `/v1/models` returns chat models only — its image entries are behind
 * `?kind=image` (#47). Other gateways ignore an unknown query parameter, so
 * asking costs them nothing, and a gateway that rejects it outright falls back
 * to the plain walk in `listImageRecords`.
 *
 * google-native and qwen-draw already list image models only, so their single
 * candidate is returned untouched.
 */
function imageModelListUrls(config: ModelListConfig): string[] {
  const urls = modelListUrls(config)
  const protocol = resolveChannelProtocol(config.apiUrl.trim(), config.protocol)
  if (protocol === 'google-native' || protocol === 'qwen-draw') return urls
  return urls.map(url => withSearchParam(url, 'kind', 'image'))
}

function errorMessageOf(body: unknown, fallback: string): string {
  if (body === null || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  const error = record.error
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return typeof record.message === 'string' && record.message.trim() !== '' ? record.message : fallback
}

function modelRecordsOf(body: unknown): ModelRecord[] | undefined {
  const candidate = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : body !== null && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : undefined
  if (candidate === undefined) return undefined
  return candidate.flatMap(item => {
    const id = typeof item === 'string'
      ? item.trim()
      : item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id.trim()
        // Google's native list names models `models/<id>` instead of `id`.
        : item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
          ? (item as { name: string }).name.trim().replace(/^models\//, '')
          : ''
    return id === '' ? [] : [{ ...(typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}), id }]
  })
}

interface ModelListAttempt {
  records?: ModelRecord[]
  error?: Error
  retryable: boolean
}

async function fetchModelRecords(url: string, apiKey: string, googleNative = false, drawers = false): Promise<ModelListAttempt> {
  const requestHeaders = googleNative
    // Google's native list authenticates with x-goog-api-key, not Bearer.
    ? { 'x-goog-api-key': apiKey.trim() }
    : headers(apiKey)
  if (drawers) {
    // Older Magpie builds honour this header instead of the query parameter
    // (#47). Harmless elsewhere: no other gateway reads it.
    requestHeaders['X-Magpie-Drawers'] = '1'
  }
  const response = await fetch(url, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let body: unknown
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text) as unknown
  } catch {
    body = undefined
  }
  // A body that is not JSON is diagnosed BEFORE the status is considered: the
  // reported failure (#48) was exactly this — a 404 whose body is the site's
  // HTML, where `HTTP 404` alone names neither the address nor the cause.
  if (body === undefined) {
    return {
      error: new Error(diagnoseNonJsonBody({
        url,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        text,
        label: '模型接口',
      })),
      // A 404/405 here is still "this address is not a models route", so the
      // walk moves on to the next candidate exactly as before.
      retryable: !response.ok ? response.status === 404 || response.status === 405 : true,
    }
  }
  if (!response.ok) {
    const fallback = `HTTP ${response.status}`
    return {
      error: new Error(errorMessageOf(body, fallback)),
      retryable: response.status === 404 || response.status === 405,
    }
  }
  const records = modelRecordsOf(body)
  if (records === undefined) {
    return {
      error: new Error(errorMessageOf(body, '模型接口响应中没有 data/models 列表')),
      retryable: true,
    }
  }
  return { records, retryable: false }
}

async function listModelRecordsFrom(config: ModelListConfig, urls: string[], drawers: boolean): Promise<ModelRecord[]> {
  const googleNative = resolveChannelProtocol(config.apiUrl.trim(), config.protocol) === 'google-native'
  let lastError: Error | undefined
  for (const url of urls) {
    let attempt: ModelListAttempt
    try {
      attempt = await fetchModelRecords(url, config.apiKey, googleNative, drawers)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      continue
    }
    if (attempt.records !== undefined) return attempt.records
    lastError = attempt.error
    if (!attempt.retryable) throw attempt.error
  }
  throw lastError ?? new Error('模型接口不可用')
}

async function listModelRecords(config: ModelListConfig): Promise<ModelRecord[]> {
  return listModelRecordsFrom(config, modelListUrls(config), false)
}

function textOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function hasImageGenerationCapability(record: ModelRecord): boolean | undefined {
  // Magpie tags its own catalogue entries with `kind` (#47). Nothing else is
  // inferred from the field: a gateway that uses `kind` for something else
  // keeps falling through to the heuristics below rather than being vetoed.
  if (typeof record.kind === 'string' && record.kind.trim().toLowerCase() === 'image') return true

  const capability = record.capabilities
  if (capability !== null && typeof capability === 'object') {
    const values = capability as Record<string, unknown>
    for (const key of ['image_generation', 'imageGeneration', 'text_to_image', 'textToImage', 'image_gen']) {
      if (typeof values[key] === 'boolean') return values[key]
    }
    const serialized = JSON.stringify(values).toLowerCase()
    if (/image[ _-]?generation|text[ _-]?to[ _-]?image/.test(serialized)) return true
  }

  const taskText = [
    ...textOf(record.task),
    ...textOf(record.task_type),
    ...textOf(record.taskType),
    ...textOf(record.type),
    ...textOf(record.model_type),
    ...textOf(record.modelType),
    ...textOf(record.tasks),
    ...textOf(record.description),
  ].join(' ').toLowerCase()
  if (/image[ _-]?generation|text[ _-]?to[ _-]?image|image[ _-]?gen/.test(taskText)) return true
  if (/^image(?:[ _-]?generation)?$/.test(taskText.trim())) return true
  if (/embedding|rerank|moderation|transcri|speech|audio|video|chat[ _-]?completion/.test(taskText)) return false

  for (const key of ['output_modalities', 'outputModalities', 'supported_output_modalities']) {
    const modalities = textOf(record[key]).map(value => value.toLowerCase())
    if (modalities.length > 0) return modalities.includes('image')
  }
  // Magpie's nested shape: `modalities: { input: [...], output: ["image"] }`.
  const modalities = record.modalities
  if (modalities !== null && typeof modalities === 'object') {
    const outputs = textOf((modalities as Record<string, unknown>).output).map(value => value.toLowerCase())
    if (outputs.length > 0) return outputs.includes('image')
  }
  return undefined
}

function isImageModelRecord(record: ModelRecord): boolean {
  return hasImageGenerationCapability(record) ?? isLikelyImageModelId(record.id)
}

/** List candidates exposed by an OpenAI-compatible endpoint. */
export async function listOpenAIModels(config: ModelListConfig): Promise<string[]> {
  return [...new Set((await listModelRecords(config)).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Records for image discovery, asking the image-scoped list first when the
 * gateway has one.
 *
 * Magpie serves chat models at `/v1/models` and its image entries only under
 * `?kind=image` (#47), so the plain walk turns discovery permanently green with
 * zero image models. The scoped walk is an enhancement, never a hard failure:
 * if it errors at all, discovery falls back to the historical candidates rather
 * than breaking for every gateway that does not recognise the parameter.
 *
 * google-native and qwen-draw already list image models only, so they keep the
 * single unscoped candidate.
 */
async function listImageRecords(config: ModelListConfig): Promise<ModelRecord[]> {
  const protocol = resolveChannelProtocol(config.apiUrl.trim(), config.protocol)
  if (protocol === 'google-native' || protocol === 'qwen-draw') return listModelRecords(config)
  let scoped: ModelRecord[]
  try {
    scoped = await listModelRecordsFrom(config, imageModelListUrls(config), true)
  } catch {
    return listModelRecords(config)
  }
  if (scoped.some(isImageModelRecord)) return scoped
  // A gateway that ignores the parameter answered with the plain list. Walking
  // the ordinary candidates restores what discovery did before this change,
  // including ids only the naming heuristic recognises.
  const plain = await listModelRecordsFrom(config, modelListUrls(config), false)
  return [...plain, ...scoped]
}

/** List only models that advertise or conventionally represent image generation. */
export async function listImageModels(config: ModelListConfig): Promise<string[]> {
  const records = await listImageRecords(config)
  // The 千问生图 API's /api/models lists image models only; its ids
  // (qwen-turbo / qwen-gguf / krea2-turbo / sdxl) do not follow the usual
  // image-model naming conventions, so the capability heuristic would drop
  // every one of them.
  if (resolveChannelProtocol(config.apiUrl.trim(), config.protocol) === 'qwen-draw') {
    return [...new Set(records.map(record => record.id))].sort((a, b) => a.localeCompare(b))
  }
  return [...new Set(records.filter(isImageModelRecord).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/** List chat models exposed by an OpenAI-compatible endpoint. */
export async function listPromptModels(config: PromptModelConfig): Promise<string[]> {
  return listOpenAIModels(config)
}

/** Remove reasoning-model artifacts from a chat model's visible content:
 *  complete `<think>…</think>` blocks first, then anything from a dangling
 *  unclosed `<think>` to the end of the text. Reasoning models served through
 *  OpenAI-compatible endpoints (MiniMax M3, DeepSeek R1, Qwen QVQ, …) inline
 *  these blocks in `message.content`; leaking them into the prompt box both
 *  pollutes the prompt and can push it past image models' length limits. */
export function stripReasoning(text: string): string {
  const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const dangling = /<think>/i.exec(withoutClosed)
  return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim()
}

/** One OpenAI-style multimodal user part (`text` or an `image_url` data URL). */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** One chat-completion request over the configured OpenAI-compatible endpoint. */
export interface ChatOptions {
  system: string
  /** Either a plain string or multimodal parts. */
  content: string | ChatPart[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Run one chat completion and return the cleaned visible answer.
 *
 * Shared by prompt enhancement, the canvas light-tier skill runner and the
 * layer analyzer: it owns the endpoint, auth, error shaping (an upstream
 * `error.message` is surfaced verbatim) and the reasoning-strip step, so every
 * caller sees the same behaviour.
 * The wait is bounded, but the caller's own cancellation still wins: the
 * timeout signal is combined with `options.signal` rather than replacing it.
 * @param config - endpoint, secret and model.
 * @param options - prompt parts plus optional sampling controls.
 * @returns the model's visible answer, with reasoning artifacts removed.
 */
export async function chatComplete(config: PromptModelConfig, options: ChatOptions): Promise<string> {
  if (config.apiUrl.trim() === '' || config.model.trim() === '') {
    throw new Error('chat model is not configured (left sidebar > Image settings > Prompt enhancement)')
  }
  const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])
  const response = await fetch(endpoint(config.apiUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(config.apiKey),
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: options.temperature ?? 0.4,
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      messages: [
        { role: 'system', content: options.system },
        {
          role: 'user',
          content: typeof options.content === 'string' ? options.content : options.content,
        },
      ],
    }),
    signal,
  })
  const body = await responseJson(response)
  const choices = Array.isArray(body.choices) ? body.choices : []
  const content = choices[0] !== null && typeof choices[0] === 'object'
    ? (choices[0] as { message?: { content?: unknown } }).message?.content
    : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error('chat model returned an empty answer')
  const answer = stripReasoning(content)
  if (answer === '') throw new Error('chat model returned only reasoning content (empty <think> payload)')
  return answer
}

/** Strip a fenced code block and pull the outermost JSON object/array out. */
export function jsonPayload(content: string): unknown {
  const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)
  const start = useArray ? arrayStart : objectStart
  const end = useArray ? arrayEnd : objectEnd
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(cleaned.slice(start, end + 1)) as unknown } catch { return undefined }
}

/** Expand a concise image request into a production-ready image prompt. */
export async function enhancePrompt(config: PromptModelConfig, prompt: string): Promise<string> {
  return chatComplete(config, {
    temperature: 0.7,
    system: 'You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.',
    content: prompt,
  })
}

/** Polish one existing generation prompt without changing its purpose. */
export async function polishPrompt(config: PromptModelConfig, prompt: string): Promise<string> {
  return chatComplete(config, {
    temperature: 0.35,
    system: '你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。',
    content: prompt,
  })
}

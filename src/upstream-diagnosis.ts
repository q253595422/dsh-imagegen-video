/**
 * One sentence that explains a non-JSON upstream response well enough for the
 * user to fix their own channel (#48).
 *
 * WHY a shared module: the engine has five response-parsing sites (generate /
 * generate-edit / google-native / chat-completions / async poll / qwen-draw
 * poll) and the model-discovery walk has a sixth. Each used to build its own
 * message, and each had drifted: the video engine already names the HTML case,
 * the image engine still printed a bare `（HTTP 404）`. Copying the better
 * sentence into five places would recreate the same drift one release later, so
 * the wording lives here and the call sites only supply facts.
 *
 * The reported failure (#48) is the shape this exists for: `/models` answers
 * because a gateway adds a convenience route at the root, while
 * `/images/generations` only exists under `/v1`. Discovery turns green, every
 * generation fails, and the message named neither the address nor the fact that
 * an HTML page came back — leaving the user nothing to act on.
 */

/** What the body turned out to be. `html` is the one worth naming. */
export type BodyShape = 'html' | 'text' | 'empty' | 'binary'

/** Cap on the excerpt quoted back inside the message, in characters. */
const EXCERPT_MAX = 120

/**
 * Classify a body we failed to parse as JSON.
 *
 * Only the leading bytes matter: an HTML error page carries its doctype or a
 * `<html`/`<head`/`<body`/`<meta` tag within the first handful of characters,
 * and a gateway's homepage does the same. Anything else is reported as plain
 * text rather than guessed at.
 */
export function bodyShapeOf(text: string, contentType = ''): BodyShape {
  const trimmed = text.trimStart()
  if (trimmed === '') return 'empty'
  if (/^\s*<(?:!doctype|html|head|body|meta)/i.test(trimmed)) return 'html'
  // A server that says text/html without a recognisable prologue (a bare
  // `<div>` 404 page) still is not an API response; the header settles it.
  if (/^text\/html\b/i.test(contentType.trim())) return 'html'
  // NUL or a high share of non-printable bytes: a truncated image or a binary
  // error payload, not prose.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(trimmed.slice(0, 64))) return 'binary'
  return 'text'
}

/** Whitespace-collapsed, length-capped excerpt for the message body. */
function shortExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}…` : collapsed
}

/** The address as the user can act on it: no query, no credentials. */
export function requestAddress(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}

export interface NonJsonDiagnosisInput {
  /** The exact URL handed to fetch. Query strings are dropped in the output. */
  url: string
  status: number
  contentType: string
  /** The raw body, already read (never already redacted). */
  text: string
  /** What this call was doing, e.g. 「上游接口」/「模型接口」. Chinese, like the rest. */
  label: string
}

/**
 * Build the user-facing sentence for a response that could not be parsed.
 *
 * The order is deliberate: what happened → which address → why it is usually
 * wrong. A user reads the first clause and stops; a user who pastes this into
 * an issue gets the address for free.
 */
export function diagnoseNonJsonBody(input: NonJsonDiagnosisInput): string {
  const shape = bodyShapeOf(input.text, input.contentType)
  const type = input.contentType.trim() === '' ? '未声明 Content-Type' : input.contentType.trim()
  const address = requestAddress(input.url)
  const head = `${input.label}返回了非 JSON 响应（HTTP ${input.status}, ${type}）：${address}`

  if (shape === 'html') {
    return `${head} —— 返回的是网页而不是接口响应，通常说明渠道的 API 地址少了路径（例如末尾缺 /v1）或填成了站点首页`
  }
  if (shape === 'empty') {
    return `${head} —— 响应体是空的，上游可能只写了状态码；请确认该地址是否为 API 端点`
  }
  if (shape === 'binary') {
    return `${head} —— 响应体是二进制内容而不是 JSON，可能是出图流被当成了接口响应`
  }
  const excerpt = shortExcerpt(input.text)
  return excerpt === '' ? head : `${head} —— 响应内容：${excerpt}`
}

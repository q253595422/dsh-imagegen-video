/**
 * The prompt one video/image is written from, and the guards around the chat
 * answer that produces it.
 *
 * Separate from `code-render.ts` on purpose: that module executes code and must
 * stay free of any opinion about models, while this one is all opinion — what
 * the model is told, how its answer is read, and what counts as "not code".
 */

/** What the model is asked to produce, as a kind. */
export type CodeTarget = 'video' | 'image'

/** Output settings the prompt is written against. */
export interface CodeBrief {
  target: CodeTarget
  /** The user's request, verbatim. */
  prompt: string
  width: number
  height: number
  /** Video only. */
  fps?: number
  /** Video only. */
  seconds?: number
  /** Style/locale hint: the answer must match the request's language for text drawn on screen. */
  language?: string
}

/**
 * The drawing API, documented for the model.
 *
 * Every method here is exercised by `code-render.ts`; a method the model invents
 * fails at run time with a legible TypeError, which is why the list is stated
 * as complete and final.
 */
const API_DOC = `ctx.width, ctx.height   // output size in pixels (use these, never hard-code)
ctx.fps                 // frames per second (video only)
ctx.duration            // seconds (video only)
ctx.frame               // 0-based frame index
ctx.t                   // 0..1 progress through the clip

ctx.background(color)
ctx.rect(x, y, w, h, color, opacity?)
ctx.roundRect(x, y, w, h, radius, color, opacity?)
ctx.circle(cx, cy, r, color, opacity?)
ctx.line(x1, y1, x2, y2, thickness, color, opacity?)
ctx.text(value, x, y, { size?, color?, align?: 'left'|'center'|'right', weight?, opacity?, spacing? })
ctx.gradient(x, y, w, h, [[offset0to1, color], ...], angleDegrees?)
ctx.ease(t)             // ease-in-out, 0..1 -> 0..1
ctx.lerp(a, b, t)
ctx.clamp(value, min, max)

Colors: '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)', 'rgba(r,g,b,a)'.

The font is a built-in 5x7 bitmap font: ASCII letters, digits, and . , : - + / % ! ? & ( ) °.
CJK and emoji render as an empty box — do NOT put Chinese/Japanese/Korean characters in
ctx.text(); draw shapes instead, or use the request's language for a title only if it is Latin.`

/**
 * Build the chat prompt for one render.
 *
 * Written as a specification rather than a conversation: the model is being
 * asked for a single function, and every sentence that is not a constraint
 * costs output tokens without improving the drawing.
 */
export function codeRenderSystemPrompt(brief: CodeBrief): string {
  const chinese = /[\u4e00-\u9fff]/.test(brief.prompt)
  const output = brief.target === 'video'
    ? `a ${brief.seconds}s video at ${brief.fps}fps (${Math.round((brief.fps ?? 30) * (brief.seconds ?? 5))} frames) at ${brief.width}x${brief.height}`
    : `a still image at ${brief.width}x${brief.height} (the function runs once, ctx.t = 0)`
  const header = chinese
    ? `你是动效图形工程师。请为用户的需求写一段 JavaScript 绘图代码，输出 ${output}。`
    : `You are a motion-graphics engineer. Write JavaScript drawing code for the request, producing ${output}.`
  const rules = chinese
    ? [
      '规则：',
      '1. 只输出一个函数：function render(ctx) { ... }，不要 Markdown 围栏、不要解释、不要 import/require。',
      '2. 每帧调用一次；必须根据 ctx.frame / ctx.t 计算动画，禁止使用 Math.random()、Date.now() 或任何时间/网络 API（结果必须可复现）。',
      '3. 只用下面这些 ctx 方法，不要假设有别的 API；不要访问 document/window/process。',
      '4. 先 ctx.background(...) 铺底，再画内容；颜色和排版要克制、有层次。',
      '5. 尺寸一律用 ctx.width / ctx.height 推导，保证任意分辨率都成立。',
      '6. 文字只用 Latin（内置点阵字体）；中文/emoji 会变成方框。',
      `7. 总时长 ${brief.seconds ?? 1} 秒，${brief.fps ?? 30} fps；动画要首尾自然（入场与收尾）。`,
      '',
      '绘图 API（完整列表）：',
      API_DOC,
    ]
    : [
      'Rules:',
      '1. Output exactly one function: function render(ctx) { ... } — no markdown fence, no explanation, no imports.',
      '2. It is called once per frame; drive all motion from ctx.frame / ctx.t. Never use Math.random(), Date.now() or any clock/network API (output must be reproducible).',
      '3. Use only the ctx methods below. Do not assume any other API, and do not touch document/window/process.',
      '4. Paint a background first, then content; keep colour and layout deliberate.',
      '5. Derive every dimension from ctx.width / ctx.height so the code works at any resolution.',
      '6. Text is the built-in Latin bitmap font; CJK and emoji draw as empty boxes.',
      `7. The clip is ${brief.seconds ?? 1}s at ${brief.fps ?? 30}fps; give it a clean entrance and exit.`,
      '',
      'Drawing API (complete list):',
      API_DOC,
    ]
  return [...(chinese ? [] : []), header, '', ...rules].join('\n')
}

/** Build the user turn: the request plus the hard output settings. */
export function codeRenderUserPrompt(brief: CodeBrief): string {
  const chinese = /[\u4e00-\u9fff]/.test(brief.prompt)
  const params = brief.target === 'video'
    ? `width=${brief.width}, height=${brief.height}, fps=${brief.fps}, seconds=${brief.seconds}`
    : `width=${brief.width}, height=${brief.height}`
  return `${chinese ? '需求' : 'Request'}: ${brief.prompt}\n${chinese ? '输出参数' : 'Output'}: ${params}`
}

/**
 * Read the model's answer into the source handed to the executor.
 *
 * The executor accepts `function render(ctx){}`, an arrow form, or a bare body,
 * so this only has to reject the one answer that cannot work: prose with no
 * code in it. Rejecting here gives a wire code the panel can act on
 * (`code-not-code`) instead of a downstream syntax error that reads like a bug.
 */
export function readGeneratedCode(answer: string): { ok: true; source: string } | { ok: false; reason: string } {
  const text = String(answer ?? '').trim()
  if (text === '') return { ok: false, reason: '对话模型返回了空内容' }
  const cleaned = text
    .replace(/^```(?:javascript|js|typescript|ts)?/i, '')
    .replace(/```\s*$/,'')
    .trim()
  const hasFunction = /function\s+render\s*\(|(?:const|let|var)\s+render\s*=/.test(cleaned)
  const hasCalls = /ctx\.(background|rect|roundRect|circle|line|text|gradient)\s*\(/.test(cleaned)
  if (!hasFunction && !hasCalls) {
    return { ok: false, reason: '对话模型返回的不是绘图代码（没有 render 函数，也没有任何绘制调用）' }
  }
  if (cleaned.length > 60_000) return { ok: false, reason: '对话模型返回的代码过长' }
  return { ok: true, source: cleaned }
}

/**
 * A last-resort renderer for when the chat model produces unusable code.
 *
 * Deliberately NOT presented as a successful generation: the caller marks the
 * task as degraded and says so. It exists so the path always produces a
 * playable artefact instead of dead-ending, and it draws the request itself as
 * a title card — the one thing a code renderer is reliably good at.
 */
export function fallbackRendererSource(brief: CodeBrief): string {
  const title = brief.prompt.replace(/\s+/g, ' ').trim().slice(0, 28).toUpperCase()
  const safe = title.replace(/[\\'"`]/g, '')
  return `
ctx.background('#0b1220')
ctx.gradient(0, 0, ctx.width, ctx.height, [[0, '#0b1220'], [1, '#16233d']], 90)
const p = ctx.ease(ctx.t)
ctx.rect(ctx.width * 0.1, ctx.height / 2 + 60, ctx.width * 0.8 * p, 4, '#7dd3fc')
ctx.text(${JSON.stringify(safe)}, ctx.width / 2, ctx.height / 2 - 10, { size: Math.round(ctx.height / 12), color: '#ffffff' })
ctx.rect(ctx.width * 0.1, ctx.height * 0.8, ctx.width * 0.8, 1, '#22304d')
`.trim()
}

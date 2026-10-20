/**
 * Host-side orchestration of the code-render path.
 *
 * Sits beside `ImageGenerationRuntime` rather than inside it: the model paths
 * call an image/video API and persist its bytes, while this path calls a chat
 * model once, renders locally, and persists the result into the SAME two stores
 * the model paths write to — the image history and the video history. That is
 * what makes a code-rendered clip stitchable and a code-rendered still usable
 * as a reference: downstream code sees an ordinary entry either way.
 *
 * No image or video model is ever contacted here. The only network call is the
 * chat completion that writes the drawing code.
 */

import { randomUUID } from 'node:crypto'
import { appendHistory } from './history-store.ts'
import { appendVideoHistory } from './video-store.ts'
import { CodeRenderError, dimensionsFor, locateFfmpeg, renderCode, type CodeRenderResult } from './code-render.ts'
import { codeRenderSystemPrompt, codeRenderUserPrompt, fallbackRendererSource, readGeneratedCode, type CodeBrief, type CodeTarget } from './code-prompt.ts'
import type { PromptModelConfig } from './prompt-enhancer.ts'
import type { CodeRenderRequest, CodeRenderResponse, HistoryEntry, VideoHistoryEntry, VideoResolution } from './protocol.ts'

/** The chat call, injected so this module holds no endpoint policy. */
export type CodeChatCompleter = (options: { system: string; content: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }) => Promise<string>

/** What the panel sends for one code render. */
export interface CodeRenderInput {
  /** `video` produces an MP4, `image` a PNG. */
  kind: CodeTarget
  /** The user's request, verbatim. */
  prompt: string
  /** Panel-facing settings, resolved to pixels here. */
  resolution: VideoResolution
  aspectRatio: string
  /** Video only; ignored for stills. */
  seconds?: number
  fps?: number
  /** Canvas lineage, when the run was started from a canvas node. */
  canvasId?: string
  canvasNodeId?: string
  /** The chat model to write the code (independent of image/video channels). */
  model?: string
  /** A previously generated source, reused on retry without another model call. */
  source?: string
}

/** Invoice-shaped result: what was produced and where it landed. */
export interface CodeRenderOutcome {
  kind: CodeTarget
  width: number
  height: number
  fps?: number
  seconds?: number
  /**
   * The encoded bytes. Always present, including when `persist: false` was
   * asked for — the caller that writes history needs them.
   */
  bytes: Buffer
  /** The chat-written source, kept so a retry does not need the model again. */
  source: string
  /** True when the model produced unusable code and the safe fallback drew it. */
  degraded: boolean
  degradedReason?: string
  /** Video results: the history entry + the served clip. */
  video?: { entryId: string; url: string; mime: string; duration?: number }
  /** Image results: the history entry + the served image. */
  image?: { entryId: string; url: string; mime: string }
  history?: VideoHistoryEntry[] | HistoryEntry[]
}

/**
 * Resolve the concrete pixel size a request will render at.
 *
 * Exposed so the panel can show the same numbers before spending a render, and
 * so the probe route and the render route cannot drift apart.
 */
export function codeRenderPlan(input: Pick<CodeRenderInput, 'kind' | 'resolution' | 'aspectRatio' | 'seconds' | 'fps'>): {
  width: number
  height: number
  fps: number
  seconds: number
  frames: number
} {
  const { width, height } = dimensionsFor(input.resolution, input.aspectRatio)
  if (input.kind === 'image') return { width, height, fps: 1, seconds: 0, frames: 1 }
  const fps = Math.max(1, Math.min(60, Math.round(input.fps ?? 30)))
  const seconds = Math.max(0.2, Math.min(120, input.seconds ?? 5))
  return { width, height, fps, seconds, frames: Math.max(1, Math.round(fps * seconds)) }
}

/** Reject an input that cannot produce anything, with copy the panel can show. */
export function validateCodeInput(input: CodeRenderInput): void {
  const prompt = String(input.prompt ?? '').trim()
  if (prompt === '') {
    throw new CodeRenderError('描述为空：请先写一句你想要的画面，代码生成会用这句描述来绘制', 'code-prompt-empty')
  }
  if (prompt.length > 4_000) {
    throw new CodeRenderError(`描述过长（${prompt.length} 字符，上限 4000）：请压缩到核心画面与文案`, 'code-prompt-too-long')
  }
  if (input.kind !== 'video' && input.kind !== 'image') {
    throw new CodeRenderError('未知的输出类型：只能是 video 或 image', 'code-bad-kind')
  }
}

/**
 * Render one request through the code path end to end.
 *
 * Order matters: validate → plan → generate code → render → persist. Each step
 * can fail with its own wire code, and nothing is written to a store until the
 * bytes exist, so a failed run leaves no half-entry behind.
 */
export async function runCodeRender(
  input: CodeRenderInput,
  config: PromptModelConfig,
  complete: CodeChatCompleter,
  options: { signal?: AbortSignal; ffmpeg?: string; persist?: boolean } = {},
): Promise<CodeRenderOutcome> {
  validateCodeInput(input)
  const plan = codeRenderPlan(input)
  const brief: CodeBrief = {
    target: input.kind,
    prompt: input.prompt.trim(),
    width: plan.width,
    height: plan.height,
    ...input.kind === 'video' ? { fps: plan.fps, seconds: plan.seconds } : {},
  }

  // ---- 1. code ------------------------------------------------------------
  // A retry passes the previous source back in, so a render that failed on
  // its *rendering* (timeout, encoder) can be retried without paying for
  // another model call — and without getting different code this time.
  let source = ''
  let degraded = false
  let degradedReason: string | undefined
  if (typeof input.source === 'string' && input.source.trim() !== '') {
    source = input.source
  } else {
    if (config.apiUrl.trim() === '' || config.model.trim() === '') {
      throw new CodeRenderError(
        '尚未配置对话模型：代码生成需要「设置 → 提示词增强模型」里的对话模型来写绘图代码。请配置后重试，或切回模型生成。',
        'code-no-chat-model',
      )
    }
    let answer: string
    try {
      answer = await complete({
        system: codeRenderSystemPrompt(brief),
        content: codeRenderUserPrompt(brief),
        temperature: 0.3,
        // A drawing is short; a long answer means the model started explaining.
        maxTokens: 3_000,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new CodeRenderError('代码生成已取消', 'code-cancelled')
      const message = error instanceof Error ? error.message : String(error)
      throw new CodeRenderError(`对话模型调用失败：${message}`, 'code-chat-failed', true)
    }
    const read = readGeneratedCode(answer)
    if (!read.ok) {
      // The model answered prose. Rather than fail the whole run, draw the
      // request as a title card and say plainly that it was not the model's
      // code — a dead end here would be worse than a plain card.
      source = fallbackRendererSource(brief)
      degraded = true
      degradedReason = `${read.reason}，已用内置标题卡渲染；可重试或切回模型生成。`
    } else {
      source = read.source
    }
  }

  // ---- 2. render ----------------------------------------------------------
  const request: CodeRenderRequest = {
    kind: input.kind,
    source,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    seconds: plan.seconds,
  }
  const rendered: CodeRenderResult = await renderCode(
    request,
    {
      ...options.ffmpeg === undefined ? {} : { ffmpeg: options.ffmpeg },
      ...options.signal === undefined ? {} : { signal: options.signal },
    },
  )

  // ---- 3. persist ---------------------------------------------------------
  // The runtime that owns the queue passes `persist: false` and writes the
  // history itself, in exactly the shape its model path writes — that is what
  // keeps a code clip and a model clip indistinguishable downstream. Left on
  // by default so this module still works on its own.
  const persist = options.persist !== false
  const base = {
    kind: input.kind,
    width: rendered.width,
    height: rendered.height,
    ...input.kind === 'video' ? { fps: rendered.fps, seconds: rendered.seconds } : {},
    bytes: rendered.bytes,
    source,
    degraded,
    ...degradedReason === undefined ? {} : { degradedReason },
  } satisfies CodeRenderOutcome
  if (!persist) return base

  const entryId = randomUUID()
  if (input.kind === 'video') {
    const entry = {
      id: entryId,
      createdAt: Date.now(),
      mode: 'text' as const,
      model: config.model,
      prompt: input.prompt.trim(),
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      seconds: rendered.seconds ?? plan.seconds,
      files: [{ bytes: rendered.bytes, mime: rendered.mime, duration: rendered.seconds ?? plan.seconds }],
      renderer: 'code' as const,
      ...input.canvasId === undefined ? {} : { channel: undefined },
    }
    const history = await appendVideoHistory(entry)
    const stored = history.find(item => item.id === entryId)
    const clip = stored?.videos[0]
    return {
      ...base,
      video: {
        entryId,
        url: clip?.url ?? '',
        mime: clip?.mime ?? 'video/mp4',
        ...clip?.duration === undefined ? {} : { duration: clip.duration },
      },
      history,
    }
  }

  const b64 = rendered.bytes.toString('base64')
  const history = await appendHistory({
    id: entryId,
    createdAt: Date.now(),
    mode: 'text',
    model: config.model,
    prompt: input.prompt.trim(),
    size: `${rendered.width}x${rendered.height}`,
    quality: 'code',
    detail: '',
    n: 1,
    images: [{ b64, mime: rendered.mime }],
    renderer: 'code',
  })
  const stored = history.find(item => item.id === entryId)
  return {
    ...base,
    image: {
      entryId,
      url: stored?.images[0]?.url ?? '',
      mime: rendered.mime,
    },
    history,
  }
}

/**
 * Report what a request WOULD do, without a model call or a rendered frame.
 *
 * The panel uses this to show the exact pixel size and frame count and to warn
 * early when ffmpeg is missing — the one failure a user can fix before paying
 * for a model call.
 */
export function probeCodeRender(input: Pick<CodeRenderInput, 'kind' | 'resolution' | 'aspectRatio' | 'seconds' | 'fps'>, ffmpeg?: string): CodeRenderResponse {
  const plan = codeRenderPlan(input)
  const resolved = ffmpeg ?? locateFfmpeg()
  return {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    seconds: plan.seconds,
    frames: plan.frames,
    ffmpegAvailable: resolved !== undefined,
    ffmpegPath: resolved,
  }
}

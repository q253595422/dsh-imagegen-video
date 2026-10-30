/**
 * Shared host-side generation runtime. Both the browser routes and Agent tools
 * submit to this one queue so persisted history and cancellation semantics stay
 * identical regardless of where a request originated.
 *
 * Requests carry a channel id (host-filled by the route/tool resolution); the
 * runtime picks that channel's upstream credentials, otherwise the default
 * channel, and records a channel snapshot on the history entry so usage
 * counters and filters survive channel deletion.
 */

import { randomUUID } from 'node:crypto'
import { generateImage, ImageGenError, type UpstreamConfig } from './engine.ts'
import { generateVideo, VideoGenError } from './video-engine.ts'
import { applyPlan, adoptPlan, planVideo, requirePrompt, VideoPlanError, type ChatCompleter } from './video-director.ts'
import { describeVideoModel } from './video-model-catalog.ts'
import { appendVideoHistory } from './video-store.ts'
import { detectImageMime } from './image-format.ts'
import { vendorOf, type SubscriptionManager, type SubscriptionReferenceImage } from './subscription/manager.ts'
import { appendHistory } from './history-store.ts'
import { GenerationTaskQueue } from './task-queue.ts'
import { VideoTaskQueue, type VideoTask } from './video-task-queue.ts'
import { recordDiagnostic } from './diagnostics-store.ts'
import { runCodeRender, type CodeChatCompleter } from './code-render-runtime.ts'
import { CodeRenderError } from './code-render.ts'
import type { PromptModelConfig } from './prompt-enhancer.ts'
import type { ChannelConfig, GeneratedImage, GenerateRequest, GenerateResult, HistoryEntry, HistoryEntryInput, SubscriptionProvider, VideoDirectorPlan, VideoGenerateRequest, VideoGenerateResult, VideoHistoryEntry, VideoResolution } from './protocol.ts'

/** A channel with its resolved API key (the settings doc holds the key
 *  separately so redacted reads never expose it). */
export interface RuntimeChannel extends ChannelConfig {
  apiKey: string
}

/** The resolved channels view the runtime picks upstream credentials from. */
export interface ChannelsView {
  channels: RuntimeChannel[]
  defaultChannelId: string
}

export interface HistorySink {
  append(entry: HistoryEntryInput): Promise<HistoryEntry[]>
}

/**
 * The DSH host's own conversation model — the one the user already talks to in
 * the chat panel, NOT a plugin setting.
 *
 * Injected by the host entry (which is the only place that owns the `agents` /
 * `agentDefaultModel` services) so the runtime never composes an agent itself.
 * When absent the code path falls back to the prompt-enhancement endpoint, so a
 * minimal host still works — but on a normal DSH install this is what draws.
 */
export interface HostChatSeam {
  /** Whether a host model is currently reachable (services mounted + a model chosen). */
  available: () => boolean
  /** The label recorded on the history entry (the model the host will use). */
  label: () => string
  /** Run one turn and return the assistant's text. */
  complete: (options: { system: string; content: string; signal?: AbortSignal }) => Promise<string>
}

/**
 * Seam for the director planning step: the chat endpoint a plan is written
 * with, and the call itself.
 *
 * Injected rather than imported so the runtime stays free of network policy:
 * the host entry owns which credentials exist (`resolvePromptModelConfig`), and
 * a test can supply a scripted completer without a socket.
 */
export interface VideoDirectorSeam {
  /** Resolve the current chat endpoint (the same one prompt enhancement uses). */
  resolveConfig: () => PromptModelConfig
  /** Complete one chat turn. */
  complete: ChatCompleter
}

export class ImageGenerationRuntime {
  readonly queue: GenerationTaskQueue
  /** Video runs through its own queue: a render takes minutes, not seconds. */
  readonly videoQueue: VideoTaskQueue

  constructor(
    private readonly resolve: () => ChannelsView,
    private readonly history: HistorySink = { append: appendHistory },
    private readonly subscriptions?: SubscriptionManager,
    private readonly director?: VideoDirectorSeam,
    /**
     * The DSH host's own conversation model. Optional so a minimal host (and
     * every existing test) keeps working; when present it wins over the
     * prompt-enhancement endpoint for the code path.
     */
    private readonly hostChat?: HostChatSeam,
  ) {
    // Every task runs in parallel up to this small host-wide limit; a
    // four-model comparison fits within it in a single wave.
    this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal), 4)
    // Video concurrency is 1: renders are minutes long and providers queue
    // them anyway, so parallel submits only make the queue less predictable.
    this.videoQueue = new VideoTaskQueue((request, signal) => this.runVideo(request, signal), 1)
  }

  /**
   * Resolve the channel that owns one video model alias.
   *
   * 顺序：显式 `channelId`（渠道存在就以它为准，**包括它没配这条别名的情况**）
   * → 别名所在的第一个渠道 → 默认渠道 → 第一个渠道。
   *
   * 为什么显式渠道跑在别名命中前面：同一个别名可以在多个渠道各配一份，各自映射
   * 到不同的上游 id、用不同的 key 计费。「别名配在谁那儿」是猜出来的（取第一个
   * 命中的渠道），`channelId` 是用户选出来的；把猜测放在选择前面，用户明明选了
   * B，请求仍会被恰好也配了同名别名的 A 抢走，事后只能翻 history 的渠道快照才
   * 看得出走了哪个 key。
   *
   * 为什么第二档是硬用而不是退回别名所在渠道：显式选了却悄悄换渠道，等于拿用户
   * 另一把 key 去计费，还把失败点藏起来。硬用会让上游 id 退化成别名本身，随即在
   * `describeVideoModel` 处报 `video-unknown-model`——错误出现在用户能理解的位置
   * （「这个渠道没配这个模型」），而不是一条由别的渠道付钱的成功记录。
   */
  private videoChannel(model: string, channelId: string | undefined, view: ChannelsView): RuntimeChannel | undefined {
    // 前两档合成一次查找：只要这个渠道还在，它有没有这条别名都以它为准。
    const explicit = channelId === undefined
      ? undefined
      : view.channels.find(candidate => candidate.id === channelId)
    const byAlias = view.channels.find(candidate =>
      (candidate.videoModels ?? []).some(row => row.alias === model))
    return explicit
      ?? byAlias
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
  }

  /**
   * Resolve the chat endpoint used by the director step.
   *
   * Absent on hosts that did not mount prompt enhancement: planning then runs
   * on the offline backend rather than failing, so video still works.
   */
  private directorSeam(): VideoDirectorSeam | undefined {
    return this.director
  }

  /**
   * Run the planning step for one video request.
   *
   * Deliberately public and side-effect free (it never renders, never writes
   * history) so the preview route can show the same plan the submit path will
   * use, without spending a render.
   */
  async planVideoRequest(request: VideoGenerateRequest, signal?: AbortSignal): Promise<VideoDirectorPlan> {
    const view = this.resolve()
    const channel = this.videoChannel(request.model, request.channelId, view)
    const upstream = channel === undefined
      ? request.model
      : (channel.videoModels ?? []).find(row => row.alias === request.model)?.id ?? request.model
    const seam = this.directorSeam()
    return planVideo(
      {
        mode: request.mode,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        seconds: request.seconds,
        model: upstream,
        hasReference: request.image !== undefined
          || request.firstFrame !== undefined
          || request.lastFrame !== undefined
          || (request.images?.length ?? 0) > 0,
      },
      seam?.resolveConfig(),
      seam?.complete,
      signal,
    )
  }

  /** Generate one video: submit, poll, download, then persist the clip. */
  async runVideo(request: VideoGenerateRequest, signal?: AbortSignal): Promise<VideoGenerateResult> {
    // ---- code path --------------------------------------------------------
    // `renderer: 'code'` is a different production path, not a different model:
    // a chat model writes drawing code and this host renders it. It runs
    // BEFORE channel resolution on purpose — the whole point is that no video
    // provider (and no video model alias) is needed.
    if (request.renderer === 'code') return await this.runVideoCode(request, signal)

    const view = this.resolve()
    const channel = this.videoChannel(request.model, request.channelId, view)
    if (channel === undefined) {
      throw new VideoGenError('尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    // Map the panel's alias onto the channel's upstream id, exactly like the
    // image path does, so the engine always sends the real gateway model id.
    const mapping = (channel.videoModels ?? []).find(row => row.alias === request.model)
    const upstream = mapping?.id ?? request.model
    const family = describeVideoModel(upstream).family
    if (family === 'unknown') {
      throw new VideoGenError(`渠道「${channel.name}」未为模型「${request.model}」配置视频协议族；请在渠道的视频模型中改用受支持的视频模型`, 'video-unknown-model')
    }

    // ---- director step ----------------------------------------------------
    // Runs BEFORE the engine and its output IS the request: the planned prompt
    // and parameters are what gets submitted. With planning off the request is
    // passed through untouched (the historical behaviour).
    let plan: VideoDirectorPlan | undefined
    let effective: VideoGenerateRequest = { ...request, upstream }
    if (request.plan === true) {
      // A plan the caller already previewed is REUSED rather than re-planned:
      // the chat model is not deterministic, so re-planning would submit a
      // different prompt from the one the user just approved. The previewed
      // plan is re-clamped against this request (it travels over the wire), so
      // a tampered plan still cannot widen a parameter.
      try {
        requirePrompt(request.prompt)
      } catch (error) {
        if (error instanceof VideoPlanError) throw error
        throw new VideoPlanError(error instanceof Error ? error.message : String(error))
      }
      const startedAt = Date.now()
      plan = request.planPreview !== undefined
        ? adoptPlan(request, upstream)
        : await this.planVideoRequest(request, signal)
      if (plan.degraded) {
        // A degraded plan still renders, but the reason has to survive: it is
        // the difference between "the chat model is down" and "the chat model
        // answered nonsense", and nothing else records it.
        recordDiagnostic({
          phase: 'video-plan',
          channel: channel.name,
          model: request.model,
          mode: request.mode,
          url: 'chat/completions',
          method: 'POST',
          failureCode: 'video-plan-degraded',
          message: plan.degradedReason ?? '规划降级为离线模式',
          requestExcerpt: plan.notes.length > 0 ? plan.notes.join(' · ') : undefined,
          durationMs: Date.now() - startedAt,
          hadAuth: (this.directorSeam()?.resolveConfig().apiKey.trim() ?? '') !== '',
        })
      }
      effective = applyPlan(effective, plan)
    }

    const result = await generateVideo(
      { apiUrl: channel.apiUrl, apiKey: channel.apiKey, apiUrlFull: channel.apiUrlFull, protocol: channel.protocol, channelName: channel.name } satisfies UpstreamConfig,
      effective,
      { ...signal === undefined ? {} : { signal }, family },
    )
    const entryId = randomUUID()
    try {
      const history = await appendVideoHistory({
        id: entryId,
        createdAt: Date.now(),
        mode: effective.mode,
        model: effective.model,
        prompt: effective.prompt,
        aspectRatio: effective.aspectRatio,
        resolution: effective.resolution,
        seconds: effective.seconds,
        files: result.videos.map(video => ({
          bytes: video.bytes,
          mime: video.mime,
          ...video.duration === undefined ? {} : { duration: video.duration },
          ...video.poster === undefined ? {} : { poster: video.poster },
          ...video.revisedPrompt === undefined ? {} : { revisedPrompt: video.revisedPrompt },
        })),
        ...request.refName === undefined ? {} : { refName: request.refName },
        ...channel.id === undefined ? {} : { channelId: channel.id },
        channel: channel.name,
        ...plan === undefined ? {} : { plan },
      })
      // The engine's bytes are not serializable; hand back the stored URLs.
      const stored = history.find(entry => entry.id === entryId)
      return {
        videos: stored?.videos ?? [],
        history,
        ...plan === undefined ? {} : { plan },
      }
    } catch (error) {
      // The render already happened and was paid for, so never discard it just
      // because the local write failed: fall back to the provider's own URL so
      // the user can still watch and save the clip, and report the failure.
      return {
        videos: result.videos.map(video => ({
          url: video.sourceUrl,
          mime: video.mime,
          ...video.duration === undefined ? {} : { duration: video.duration },
          ...video.poster === undefined ? {} : { poster: video.poster },
        })),
        historyError: error instanceof Error ? error.message : String(error),
        ...plan === undefined ? {} : { plan },
      }
    }
  }

  /**
   * The chat model the code path draws with.
   *
   * Preference order matters and is the whole point of this seam: the DSH
   * host's own conversation model first (the one the user already talks to),
   * and only then the plugin's prompt-enhancement endpoint. Neither adds a new
   * setting — there is nothing to configure beyond picking this path.
   */
  private codeProvider(): { config: PromptModelConfig; complete: CodeChatCompleter } {
    const host = this.hostChat
    if (host !== undefined && host.available()) {
      return {
        // A sentinel URL: the host seam is already authenticated, so nothing
        // here is dialled. It exists because the renderer treats an empty
        // endpoint as "not configured" and refuses before drawing.
        config: { apiUrl: HOST_CHAT_ENDPOINT, apiKey: '', model: host.label() },
        complete: async options => await host.complete({
          system: options.system,
          content: options.content,
          ...options.signal === undefined ? {} : { signal: options.signal },
        }),
      }
    }
    const seam = this.director
    if (seam === undefined) {
      throw new CodeRenderError(
        '没有可用的对话模型：代码生成需要 DSH 里已接入的模型（或「设置 → 提示词增强模型」）。请配置后重试，或切回模型生成。',
        'code-no-chat-model',
      )
    }
    return { config: seam.resolveConfig(), complete: seam.complete }
  }

  /**
   * Render one clip through the code path and persist it like any other clip.
   *
   * The persistence step deliberately mirrors the model path field for field
   * (mode / prompt / aspectRatio / resolution / seconds / files) and only adds
   * `renderer: 'code'`. Downstream — the canvas placeholder, the clip history,
   * favoriting, stitching, the timeline — cannot tell the two apart, which is
   * the whole requirement.
   */
  private async runVideoCode(request: VideoGenerateRequest, signal?: AbortSignal): Promise<VideoGenerateResult> {
    const provider = this.codeProvider()
    const config = provider.config
    const outcome = await runCodeRender(
      {
        kind: 'video',
        prompt: request.prompt,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        seconds: request.seconds,
        fps: CODE_RENDER_FPS,
        model: config.model,
        ...request.renderSource === undefined ? {} : { source: request.renderSource },
      },
      config,
      provider.complete,
      { ...signal === undefined ? {} : { signal }, persist: false },
    )
    const entryId = randomUUID()
    const duration = outcome.seconds ?? request.seconds
    try {
      const history = await appendVideoHistory({
        id: entryId,
        createdAt: Date.now(),
        mode: request.mode,
        model: config.model,
        prompt: request.prompt.trim(),
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        seconds: duration,
        files: [{ bytes: outcome.bytes, mime: outcome.kind === 'video' ? 'video/mp4' : 'image/png', duration }],
        renderer: 'code',
        ...request.channel === undefined ? {} : { channel: request.channel },
      })
      const stored = history.find(entry => entry.id === entryId)
      return {
        videos: stored?.videos ?? [],
        history,
        renderer: 'code',
        renderSource: outcome.source,
        degraded: outcome.degraded,
        ...outcome.degradedReason === undefined ? {} : { degradedReason: outcome.degradedReason },
      }
    } catch (error) {
      // The render already succeeded; never discard it because the local write
      // failed. There is no provider URL to fall back to here, so the failure
      // is reported plainly instead of pretending a clip exists.
      return {
        videos: [],
        historyError: error instanceof Error ? error.message : String(error),
        renderer: 'code',
        renderSource: outcome.source,
        degraded: outcome.degraded,
        ...outcome.degradedReason === undefined ? {} : { degradedReason: outcome.degradedReason },
      }
    }
  }

  /**
   * Render one still through the code path and persist it into the image
   * history — the same store the model path writes, so the canvas uploads it,
   * the gallery can favorite it, and an edit can reference it.
   */
  private async runImageCode(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const provider = this.codeProvider()
    const config = provider.config
    const { resolution, aspectRatio } = stillShape(request.size, request.quality)
    const outcome = await runCodeRender(
      {
        kind: 'image',
        prompt: request.prompt,
        resolution,
        aspectRatio,
        model: config.model,
        ...request.renderSource === undefined ? {} : { source: request.renderSource },
      },
      config,
      provider.complete,
      { ...signal === undefined ? {} : { signal }, persist: false },
    )
    const images: GeneratedImage[] = [{ b64: outcome.bytes.toString('base64'), mime: 'image/png' }]
    try {
      const history = await this.history.append({
        id: randomUUID(),
        createdAt: Date.now(),
        mode: request.mode,
        model: config.model,
        prompt: request.prompt.trim(),
        size: `${outcome.width}x${outcome.height}`,
        quality: 'code',
        detail: request.detail,
        n: 1,
        images,
        renderer: 'code',
        ...request.refName === undefined ? {} : { refName: request.refName },
        ...request.canvas === undefined ? {} : { canvas: request.canvas },
      })
      return {
        images,
        history,
        renderer: 'code',
        renderSource: outcome.source,
        degraded: outcome.degraded,
        ...outcome.degradedReason === undefined ? {} : { degradedReason: outcome.degradedReason },
      }
    } catch (error) {
      return {
        images,
        historyError: error instanceof Error ? error.message : String(error),
        renderer: 'code',
        renderSource: outcome.source,
        degraded: outcome.degraded,
        ...outcome.degradedReason === undefined ? {} : { degradedReason: outcome.degradedReason },
      }
    }
  }

  async run(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    // The code path needs no image model, so it is resolved before any channel
    // lookup: requiring a configured image channel here would be a lie.
    if (request.renderer === 'code') return await this.runImageCode(request, signal)
    const view = this.resolve()
    const channel = view.channels.find(candidate => candidate.id === request.channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
    if (channel === undefined) {
      throw new ImageGenError('尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    const result = channel.auth === 'subscription' && channel.subscription !== undefined
      ? { images: await this.generateSubscription(channel.subscription, request, signal) }
      : await generateImage({ apiUrl: channel.apiUrl, apiKey: channel.apiKey, apiUrlFull: channel.apiUrlFull, protocol: channel.protocol, channelName: channel.name, watermark: channel.watermark } satisfies UpstreamConfig, request, { signal })
    try {
      const history = await this.history.append({
        id: randomUUID(),
        createdAt: Date.now(),
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        detail: request.detail,
        n: request.n,
        images: result.images,
        ...request.refName === undefined ? {} : { refName: request.refName },
        ...request.channelId === undefined ? {} : { channelId: request.channelId },
        ...request.channel === undefined ? {} : { channel: request.channel },
        ...request.comparisonId === undefined ? {} : { comparisonId: request.comparisonId },
        ...request.comparisonModels === undefined ? {} : { comparisonModels: request.comparisonModels },
        ...request.workflow === undefined ? {} : { workflow: request.workflow },
        ...request.projectId === undefined ? {} : { projectId: request.projectId },
        ...request.projectName === undefined ? {} : { projectName: request.projectName },
        ...request.slotKey === undefined ? {} : { slotKey: request.slotKey },
        ...request.slotLabel === undefined ? {} : { slotLabel: request.slotLabel },
        ...request.canvas === undefined ? {} : { canvas: request.canvas },
      })
      return { ...result, history }
    } catch (error) {
      return { ...result, historyError: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Generate images through one logged-in subscription account. */
  private async generateSubscription(provider: SubscriptionProvider, request: GenerateRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
    if (this.subscriptions === undefined) {
      throw new ImageGenError('当前部署未挂载 DSH Credentials，订阅账号不可用', 'subscription-unavailable')
    }
    const references = subscriptionReferences(request)
    const count = Math.max(1, Math.min(4, Math.trunc(request.n) || 1))
    const batches = await Promise.all(Array.from({ length: count }, async () => await this.subscriptions!.generate({
      vendor: vendorOf(provider),
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      ...(references.length > 0 ? { referenceImages: references } : {}),
      ...(signal === undefined ? {} : { signal }),
    })))
    return batches.flatMap(batch => batch.flatMap(row => {
      const bytes = Buffer.from(row.b64_json, 'base64')
      const mime = detectImageMime(bytes)
      if (mime === undefined) throw new ImageGenError('订阅图像返回了无法识别的图片格式', 'subscription-invalid-image')
      return [{ b64: row.b64_json, mime, ...row.revisedPrompt === undefined ? {} : { revisedPrompt: row.revisedPrompt } }]
    }))
  }
}

/**
 * Stand-in endpoint for the host-model seam.
 *
 * The host conversation model is reached through an agent, not HTTP, so there
 * is no URL to dial. `runCodeRender` refuses to call a model when the endpoint
 * looks unconfigured, so this sentinel exists purely to say "provider present".
 */
const HOST_CHAT_ENDPOINT = 'dsh://host-model'

/**
 * Frame rate the code path renders at.
 *
 * Fixed rather than user-facing: the model path's clip length is provider-
 * defined, so exposing fps here would add a knob no model path has. Everything
 * the user DOES choose — aspect ratio, resolution tier, seconds — is honoured.
 */
const CODE_RENDER_FPS = 30

/**
 * Map the panel's image size/quality vocabulary onto a code render.
 *
 * The panel speaks `size: 'auto' | '1:1' | '3:4' | ...` and
 * `quality: 'auto' | '1k' | '2k' | '4k'`; the renderer speaks pixels. 'auto'
 * falls back to a square, which is what an unset image model would produce.
 */
function stillShape(size: string, quality: string): { resolution: VideoResolution; aspectRatio: string } {
  const aspectRatio = size === 'auto' || size.trim() === '' ? '1:1' : size.trim()
  const resolution: VideoResolution = quality === '1k' ? '720P' : '1080P'
  return { resolution, aspectRatio }
}

/** Decode the request's data-URL references into subscription wire images. */
function subscriptionReferences(request: GenerateRequest): SubscriptionReferenceImage[] {
  return [request.image, ...(request.images ?? [])]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .slice(0, 5)
    .map(value => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value)
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new ImageGenError('订阅图生图收到无法解码的参考图片', 'subscription-invalid-reference')
      }
      return { data: Buffer.from(match[2], 'base64'), mediaType: match[1] }
    })
}

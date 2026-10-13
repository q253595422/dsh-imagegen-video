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
import { describeVideoModel } from './video-model-catalog.ts'
import { appendVideoHistory } from './video-store.ts'
import { detectImageMime } from './image-format.ts'
import { vendorOf, type SubscriptionManager, type SubscriptionReferenceImage } from './subscription/manager.ts'
import { appendHistory } from './history-store.ts'
import { GenerationTaskQueue } from './task-queue.ts'
import { VideoTaskQueue, type VideoTask } from './video-task-queue.ts'
import type { ChannelConfig, GeneratedImage, GenerateRequest, GenerateResult, HistoryEntry, HistoryEntryInput, SubscriptionProvider, VideoGenerateRequest, VideoGenerateResult, VideoHistoryEntry } from './protocol.ts'

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

export class ImageGenerationRuntime {
  readonly queue: GenerationTaskQueue
  /** Video runs through its own queue: a render takes minutes, not seconds. */
  readonly videoQueue: VideoTaskQueue

  constructor(
    private readonly resolve: () => ChannelsView,
    private readonly history: HistorySink = { append: appendHistory },
    private readonly subscriptions?: SubscriptionManager,
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
   * A video request names a model alias, not a channel, and video aliases live
   * in a channel's `videoModels` catalog rather than its image `models` one. So
   * resolution is: the alias's own channel, then the explicitly requested
   * channel, then the default channel.
   */
  private videoChannel(model: string, channelId: string | undefined, view: ChannelsView): RuntimeChannel | undefined {
    const byAlias = view.channels.find(candidate =>
      (candidate.videoModels ?? []).some(row => row.alias === model))
    return byAlias
      ?? view.channels.find(candidate => candidate.id === channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
  }

  /** Generate one video: submit, poll, download, then persist the clip. */
  async runVideo(request: VideoGenerateRequest, signal?: AbortSignal): Promise<VideoGenerateResult> {
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
    const result = await generateVideo(
      { apiUrl: channel.apiUrl, apiKey: channel.apiKey, apiUrlFull: channel.apiUrlFull, protocol: channel.protocol } satisfies UpstreamConfig,
      { ...request, upstream },
      { ...signal === undefined ? {} : { signal }, family },
    )
    const entryId = randomUUID()
    try {
      const history = await appendVideoHistory({
        id: entryId,
        createdAt: Date.now(),
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        seconds: request.seconds,
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
      })
      // The engine's bytes are not serializable; hand back the stored URLs.
      const stored = history.find(entry => entry.id === entryId)
      return { videos: stored?.videos ?? [], history }
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
      }
    }
  }

  async run(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const view = this.resolve()
    const channel = view.channels.find(candidate => candidate.id === request.channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
    if (channel === undefined) {
      throw new ImageGenError('尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    const result = channel.auth === 'subscription' && channel.subscription !== undefined
      ? { images: await this.generateSubscription(channel.subscription, request, signal) }
      : await generateImage({ apiUrl: channel.apiUrl, apiKey: channel.apiKey, apiUrlFull: channel.apiUrlFull, protocol: channel.protocol } satisfies UpstreamConfig, request, { signal })
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

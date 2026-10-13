/**
 * Agent-facing video-generation tools backed by the shared host video queue.
 *
 * Kept in its own module beside `agent-image-tools.ts` rather than folded into
 * it: video needs a different tool contract. Image tools return attachment refs
 * the model can pass straight back for editing, while video returns a served
 * file URL (a clip is far too large to attach) and its renders are minutes
 * long, so background mode is the normal case rather than the exception.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { VideoGenError } from './video-engine.ts'
import { describeVideoModel } from './video-model-catalog.ts'
import type { ImageGenerationRuntime, RuntimeChannel } from './generation-runtime.ts'
import type { VideoGenerateRequest, VideoMode, VideoTask, VideoResolution } from './protocol.ts'

export interface AgentVideoToolConfig {
  enabled: boolean
  allowAgentVideoGeneration: boolean
  channels: RuntimeChannel[]
  defaultChannelId: string
  defaultVideoModel?: string
}

/** One finished clip as the Agent consumes it. */
interface AgentVideoRef {
  url: string
  mime: string
  duration?: number
}

interface AgentVideoTaskResult {
  task_id: string
  status: string
  message: string
  error?: string
  videos: AgentVideoRef[]
}

/** One reference image the model passes back from a completed generation. */
const imageRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string', required: true },
    media_type: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

const videoRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    mime: { type: 'string', required: true },
    duration: { type: 'number' },
  },
} as const

const videoTaskResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', required: true },
    status: { type: 'string', required: true },
    message: { type: 'string', required: true },
    error: { type: 'string' },
    videos: { type: 'array', required: true, items: videoRefSchema },
  },
} as const

/** Agent submits stay pending until the queue task settles. */
const AGENT_VIDEO_TIMEOUT_MS = 40 * 60_000

export function ensureAgentVideoConfigured(config: AgentVideoToolConfig): void {
  if (!config.enabled) throw new VideoGenError('AI image generation is disabled. Open Settings → Image settings and enable it.', 'plugin-disabled')
  if (!config.allowAgentVideoGeneration) throw new VideoGenError('Agent video generation is disabled in Settings → Image settings.', 'agent-video-disabled')
  const usable = config.channels.some(channel =>
    channel.apiUrl.trim() !== ''
    && channel.apiKey.trim() !== ''
    && (channel.videoModels ?? []).length > 0)
  if (!usable) {
    throw new VideoGenError('No video models are configured. Open Settings → Image settings, pick a channel and add video models to it.', 'video-model-not-configured')
  }
}

/** Resolve a configured video alias and its owning channel. */
export function resolveAgentVideoModel(config: AgentVideoToolConfig, requested: unknown): { channel: RuntimeChannel; alias: string; upstream: string } {
  const entries = config.channels.flatMap(channel => (channel.videoModels ?? []).map(model => ({ channel, alias: model.alias, upstream: model.id })))
  if (entries.length === 0) {
    throw new VideoGenError('No video models are configured. Open Settings → Image settings and add video models to a channel.', 'video-model-not-configured')
  }
  const wanted = typeof requested === 'string' && requested.trim() !== ''
    ? requested.trim()
    : (typeof config.defaultVideoModel === 'string' ? config.defaultVideoModel.trim() : '')
  if (wanted === '') {
    if (entries.length === 1) return entries[0]!
    const options = entries.map(entry => `"${entry.channel.name} · ${entry.alias}"`).join(', ')
    throw new VideoGenError(`Multiple video models are available — ask the user which channel and model to use, then call this tool again with that exact model name. Options: ${options}.`, 'video-model-choice-required')
  }
  const hosting = entries.filter(entry => entry.alias === wanted)
  if (hosting.length === 0) {
    const available = [...new Set(entries.map(entry => entry.alias))].join(', ')
    throw new VideoGenError(`Video model "${wanted}" is not configured in any channel. Choose one of: ${available}.`, 'video-model-not-configured')
  }
  const preferred = hosting.find(entry => entry.channel.id === config.defaultChannelId)
  return preferred ?? hosting[0]!
}

/** Reject a model whose protocol family the engine cannot shape. */
function requireKnownFamily(upstream: string): void {
  const entry = describeVideoModel(upstream)
  if (entry.family === 'unknown') {
    throw new VideoGenError(`Video model "${upstream}" has an unknown protocol family, so it cannot be generated. Use a known video model such as agnes-video-2.5-flash.`, 'video-unknown-model')
  }
}

function isFinalVideoTask(task: VideoTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

/** Wait for a video queue task without sending anything through the chat model. */
export function waitForAgentVideoTask(runtime: ImageGenerationRuntime, id: string, signal: AbortSignal | undefined): Promise<VideoTask> {
  return new Promise<VideoTask>((resolveTask, rejectTask) => {
    let settled = false
    let unsubscribe = (): void => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = (): void => {}

    const cleanup = (): void => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const settle = (task: VideoTask): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveTask(task)
    }
    const reject = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectTask(error)
    }
    abort = (): void => {
      if (settled) return
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('Video generation was cancelled.')
      reject(reason)
    }
    if (signal?.aborted === true) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })

    // Poll rather than subscribe: the queue publishes only its own transitions,
    // and a task may already have settled before this call ran.
    const inspect = (): void => {
      const task = runtime.videoQueue.get(id)
      if (task === undefined) { reject(new VideoGenError(`Video generation task ${id} was not found.`, 'task-not-found')); return }
      if (isFinalVideoTask(task)) { settle(task); return }
    }
    inspect()
    if (settled) return
    unsubscribe = runtime.videoQueue.subscribe(task => { if (task.id === id) inspect() })
    timer = setTimeout(() => {
      reject(new VideoGenError(`Video generation did not finish within ${Math.round(AGENT_VIDEO_TIMEOUT_MS / 60_000)} minutes. The task is still running on the host; query it again with get_video_generation_task.`, 'video-timeout'))
    }, AGENT_VIDEO_TIMEOUT_MS)
  })
}

/**
 * Render one video result for the model.
 *
 * Textual, like the image tools: a clip cannot be attached to the
 * conversation, and keeping the model-facing result textual lets video
 * generation work with text-only conversation models.
 */
function renderVideoTaskResult(value: AgentVideoTaskResult): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Register the video tools on the host context.
 *
 * `enabled` is read per call so a settings change applies without a restart,
 * exactly like the image tools.
 */
export function registerAgentVideoTools(ctx: Context, runtime: ImageGenerationRuntime, config: () => AgentVideoToolConfig): () => void {
  const ensureConfigured = (): AgentVideoToolConfig => {
    const value = config()
    ensureAgentVideoConfigured(value)
    return value
  }

  const taskResult = (task: VideoTask): AgentVideoTaskResult => {
    const clips = task.result?.videos ?? []
    return {
      task_id: task.id,
      status: task.status,
      message: task.status === 'completed'
        ? (clips.length > 0
            ? 'Video generation completed. The clip is served at the URL below; tell the user where it is and that it is also listed in the studio\'s video history.'
            : 'Video generation completed, but the clip could not be persisted locally.')
        : task.status === 'failed'
          ? 'Video generation failed.'
          : task.status === 'cancelled'
            ? 'Video generation was cancelled.'
            : 'Video generation is still running. Video renders usually take several minutes; query the task again later rather than in a tight loop.',
      ...task.error === undefined ? {} : { error: task.error },
      ...task.result?.historyError === undefined ? {} : { error: task.result.historyError },
      videos: clips.map(video => ({
        url: video.url,
        mime: video.mime,
        ...video.duration === undefined ? {} : { duration: video.duration },
      })),
    }
  }

  const findTask = (id: string): VideoTask => {
    const task = runtime.videoQueue.get(id)
    if (task === undefined) throw new VideoGenError(`Video generation task ${id} was not found.`, 'task-not-found')
    return task
  }

  const buildRequest = (
    picked: { channel: RuntimeChannel; alias: string; upstream: string },
    args: Record<string, unknown>,
    mode: VideoMode,
    frame?: { image?: string; firstFrame?: string; lastFrame?: string; refName?: string },
  ): VideoGenerateRequest => {
    const seconds = typeof args.seconds === 'number' ? args.seconds : 5
    const resolution = typeof args.resolution === 'string' ? args.resolution : '720P'
    return {
      mode,
      model: picked.alias,
      upstream: picked.upstream,
      channelId: picked.channel.id,
      channel: picked.channel.name,
      prompt: typeof args.prompt === 'string' ? args.prompt.trim() : '',
      aspectRatio: typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim() !== '' ? args.aspect_ratio.trim() : '16:9',
      resolution: (resolution === '480P' || resolution === '720P' || resolution === '1080P' ? resolution : '720P') as VideoResolution,
      seconds,
      ...frame === undefined ? {} : frame,
    }
  }

  const disposers = [
    ctx.tools.register(defineTool({
      name: 'generate_video',
      description: 'Generate a video (text-to-video). Video rendering is asynchronous and usually takes several minutes, so by default this tool call stays pending until the task settles; set wait_for_completion to false for background mode and then use get_video_generation_task. The finished clip is saved as a file on the host and returned as a same-origin URL (it is never attached to the conversation). Only models configured in the channel\'s video catalog are allowed; omit model to use the configured default video model.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Detailed video prompt: subject, action, camera movement, lighting and mood.' },
        model: { type: 'string', description: 'One of the configured video models. Defaults to the configured default video model.' },
        aspect_ratio: { type: 'string', description: 'Aspect ratio such as 16:9, 9:16 or 1:1. Defaults to 16:9.' },
        resolution: { type: 'string', description: '480P, 720P (default) or 1080P, when the model supports it.' },
        seconds: { type: 'integer', description: 'Clip length in seconds. Defaults to 5.' },
        wait_for_completion: { type: 'boolean', description: 'Wait for the finished clip and return its URL. Defaults to true; set false for background mode.' },
      },
      output: {
        schema: videoTaskResultSchema,
        render: (_args, value) => renderVideoTaskResult(value),
      },
      async execute(args, exec) {
        const config = ensureConfigured()
        const picked = resolveAgentVideoModel(config, args.model)
        requireKnownFamily(picked.upstream)
        const task = runtime.videoQueue.submit(buildRequest(picked, args, 'text'))
        return taskResult(args.wait_for_completion === false ? task : await waitForAgentVideoTask(runtime, task.id, exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'generate_video_from_image',
      description: 'Generate a video from reference image(s). Use mode "image" for one reference frame, "keyframe" for first/last-frame interpolation (providers that accept both), or "reference" for one or more style/subject references. Reference images must be image references returned by a completed generation or get_video_generation_task; pass that entire object unchanged. Rendering is asynchronous and usually takes minutes; by default this tool call stays pending until the task settles.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Detailed video prompt describing the motion and mood.' },
        mode: { type: 'string', required: true, description: 'image (one reference), keyframe (first/last frame) or reference (multiple references).' },
        image: { ...imageRefSchema, description: 'Reference image for mode=image or mode=reference.' },
        first_frame: { ...imageRefSchema, description: 'First-frame image for mode=keyframe.' },
        last_frame: { ...imageRefSchema, description: 'Optional last-frame image for mode=keyframe.' },
        model: { type: 'string', description: 'One of the configured video models. Defaults to the configured default video model.' },
        aspect_ratio: { type: 'string', description: 'Aspect ratio such as 16:9, 9:16 or 1:1.' },
        resolution: { type: 'string', description: '480P, 720P (default) or 1080P, when the model supports it.' },
        seconds: { type: 'integer', description: 'Clip length in seconds. Defaults to 5.' },
        wait_for_completion: { type: 'boolean', description: 'Wait for the finished clip and return its URL. Defaults to true.' },
      },
      output: {
        schema: videoTaskResultSchema,
        render: (_args, value) => renderVideoTaskResult(value),
      },
      async execute(args, exec) {
        const config = ensureConfigured()
        const picked = resolveAgentVideoModel(config, args.model)
        requireKnownFamily(picked.upstream)
        const mode: VideoMode = args.mode === 'keyframe' ? 'keyframe' : args.mode === 'reference' ? 'reference' : 'image'
        const readFrame = async (value: unknown, what: string): Promise<string | undefined> => {
          if (value === null || typeof value !== 'object') return undefined
          const reference = await ctx.attachments.readImage(restoreRef(value as Record<string, unknown>), exec.signal)
          if (reference.data.byteLength === 0) throw new VideoGenError(`${what} had no readable bytes.`, 'video-bad-reference')
          return imageDataUrl(reference)
        }
        const image = await readFrame(args.image, 'image')
        const first = await readFrame(args.first_frame, 'first_frame')
        const last = await readFrame(args.last_frame, 'last_frame')
        if (mode === 'keyframe' && first === undefined) {
          throw new VideoGenError('mode=keyframe needs first_frame (and optionally last_frame).', 'video-bad-reference')
        }
        if (mode !== 'keyframe' && image === undefined) {
          throw new VideoGenError(`mode=${mode} needs image.`, 'video-bad-reference')
        }
        const frame = mode === 'keyframe'
          ? { ...first === undefined ? {} : { firstFrame: first }, ...last === undefined ? {} : { lastFrame: last } }
          : { image: image!, refName: 'reference' }
        const task = runtime.videoQueue.submit(buildRequest(picked, args, mode, frame))
        return taskResult(args.wait_for_completion === false ? task : await waitForAgentVideoTask(runtime, task.id, exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'get_video_generation_task',
      description: 'Check a video-generation task status. Completed tasks return the served clip URL. Video renders usually take several minutes, so use this for polling or recovery instead of re-submitting; do not poll in a tight loop.',
      parameters: { task_id: { type: 'string', required: true, description: 'Task id returned by generate_video or generate_video_from_image.' } },
      output: {
        schema: videoTaskResultSchema,
        render: (_args, value) => renderVideoTaskResult(value),
      },
      async execute(args) {
        ensureConfigured()
        return taskResult(findTask(args.task_id))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'cancel_video_generation_task',
      description: 'Cancel a queued or running video generation task.',
      parameters: { task_id: { type: 'string', required: true, description: 'Task id returned by generate_video or generate_video_from_image.' } },
      output: {
        schema: videoTaskResultSchema,
        render: (_args, value) => renderVideoTaskResult(value),
      },
      async execute(args) {
        ensureConfigured()
        const task = runtime.videoQueue.cancel(args.task_id)
        if (task === undefined) throw new VideoGenError(`Video generation task ${args.task_id} was not found.`, 'task-not-found')
        return taskResult(task)
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Tool names this module registers (used by the host to gate announcements). */
export const AGENT_VIDEO_TOOL_NAMES = ['generate_video', 'generate_video_from_image', 'get_video_generation_task', 'cancel_video_generation_task'] as const


/** Whether a media type is one the host accepts as a reference frame. */
function acceptedMediaType(value: string): value is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

/** Rebuild an attachment reference from the model-passed object. */
function restoreRef(value: Record<string, unknown>): ImageAttachmentRef {
  const mediaType = typeof value.media_type === 'string' ? value.media_type : ''
  if (!acceptedMediaType(mediaType)) throw new VideoGenError('reference image media_type is not a supported image type', 'video-bad-reference')
  if (typeof value.attachment_id !== 'string' || value.attachment_id === '') throw new VideoGenError('reference image attachment_id is missing', 'video-bad-reference')
  const dim = (key: string): number => typeof value[key] === 'number' && Number.isInteger(value[key]) && (value[key] as number) > 0 ? value[key] as number : 0
  const bytes = dim('bytes')
  const width = dim('width')
  const height = dim('height')
  if (bytes === 0 || width === 0 || height === 0) throw new VideoGenError('reference image metadata is invalid', 'video-bad-reference')
  return {
    attachmentId: value.attachment_id as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
    ...typeof value.name === 'string' && value.name !== '' ? { name: value.name } : {},
  }
}

/** Encode one attachment as a data URL the engine can send upstream. */
function imageDataUrl(image: { data: Uint8Array; ref: ImageAttachmentRef }): string {
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

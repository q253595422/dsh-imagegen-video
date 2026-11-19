/**
 * 导演台导出视频：逐帧出图 → 逐帧上传 → 宿主编成 mp4。
 *
 * 为什么逐帧走网络而不是在浏览器里编码：WebCodecs 的 H.264 支持受浏览器与
 * 画幅约束（牧野自己在同一位置也带了一句「当前浏览器不支持此画幅的 H.264
 * 编码」），而这个插件的宿主本来就有 ffmpeg（`src/clip-compose.ts`）。把编码
 * 放到宿主，画幅、时长、帧率都不再受编码器能力表限制，也复用了拼接那条路
 * 已有的工具探测与错误处理。
 *
 * 这一层只负责「按时间轴逐帧画出来、按顺序送上去」。它不认识 ffmpeg，
 * 也不认识画布节点——建节点与连线在 `CanvasWorkspace` 里，编码在宿主。
 */

import type { CanvasPoseStage, StageEncodeResult, StageFrameUpload } from '../../protocol.ts'
import { frameTimes, sampleStage } from './stage-timeline.ts'
import { renderStageToDataUrl } from './stage-scene-3d.ts'

export interface StageExportOptions {
  stage: CanvasPoseStage
  width: number
  height: number
  /**
   * 这次导出属于哪张画布。
   *
   * 带上它，宿主编好的成片写视频历史时就知道来源，历史列表才能把它归到
   * 那张画布下而不是冒充一次独立生成。缺省照旧（脚本调用、无画布场景）。
   */
  canvasId?: string
  pano?: HTMLImageElement | null
  /** 进度回调，0..1。`total` 在开始前就已知，进度不会倒退。 */
  onProgress?: (ratio: number) => void
  /** 取消信号。关面板、点取消、组件卸载都应当 abort。 */
  signal?: AbortSignal
  /**
   * 把某一刻的场景画成 PNG data URL。默认用 three.js 的离屏渲染。
   *
   * 之所以留一个注入点：默认实现需要 WebGL，因此整条导出流程在 Node 里根本
   * 进不来——于是「帧的序号对不对」「进度会不会倒退」「取消是不是真在上传
   * 前生效」这些与渲染无关、却能直接弄坏一次导出的规则一条也测不到。
   * 注入一个返回固定 data URL 的实现，这些规则就能离线验。
   */
  render?: (stage: CanvasPoseStage, size: { width: number; height: number }) => string | Promise<string>
}

export interface StageExportResult {
  url: string
  mime: string
  /** 实际时长（秒）。宿主按真实帧数算的，不取客户端声明。 */
  duration: number
  bytes: number
}

/** 导出用到的两个接口。写成结构类型而不是直接依赖 `ImageGenApi`，是为了
 *  让这条流程能在离线脚本里跑（`scripts/` 里的 smoke 没有 fetch 环境）。 */
export interface StageExportApi {
  stageFrame: (payload: StageFrameUpload) => Promise<{ ok: true } & Partial<StageEncodeResult>>
  stageEncode: (sessionId: string) => Promise<StageEncodeResult>
}

/** 中止时抛的错。调用方据此把「用户取消」与「真失败」分开显示。 */
export class StageExportAborted extends Error {
  constructor() {
    super('stage export aborted')
    this.name = 'StageExportAborted'
  }
}

/**
 * 让出主线程一次。
 *
 * 逐帧渲染是同步的、单帧几十毫秒，串起来 150 帧就是一次十几秒的长任务：
 * 期间页面不响应、进度条不动，用户会以为卡死。每帧之间让出一次，浏览器
 * 才有机会重绘进度、处理取消点击。
 */
function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * 逐帧渲染并上传，返回编好的视频。
 *
 * 串行、不并发：一帧 1–3MB，并发上传会同时压垮浏览器的连接池与宿主的解码
 * 队列，而这条路的总耗时本来就由渲染决定，并发不会让它更快。
 *
 * 取消：中途 abort 时立刻停手。**这里只停在本轮上传之前**——已经传上去的
 * 帧留在宿主的临时目录里，因为宿主侧没有「作废一次会话」的接口（协议里只有
 * `stageFrame` / `stageEncode`）。那些帧永远等不到最后一帧、也就永远不会触发
 * 编码，最终靠宿主的会话超时清理。这条依赖写在注释里，是因为它是这一版
 * 已知的、没有内建保障的一处。
 */
export async function exportStageVideo(
  api: StageExportApi,
  options: StageExportOptions,
): Promise<StageExportResult> {
  const timeline = options.stage.timeline
  if (timeline === undefined) {
    // 没有时间轴就是一张静态图，不是一段视频。让调用方去走导出 PNG 那条路，
    // 而不是在这里编一段「同一帧重复 150 次」的 mp4。
    throw new Error('director desk has no timeline to export')
  }
  const times = frameTimes(timeline)
  if (times.length === 0) throw new Error('director desk timeline is empty')

  const paint = options.render
  const sessionId = crypto.randomUUID()
  const total = times.length
  let last: ({ ok: true } & Partial<StageEncodeResult>) | undefined

  for (let index = 0; index < total; index += 1) {
    checkAborted(options.signal)
    // 渲染器只认识「此刻的样子」，时间求值在这一层做完再交给它。这个边界
    // 让同一份渲染代码既能画面板、也能逐帧导出。
    const frame = sampleStage(options.stage, times[index]!)
    const dataUrl = paint === undefined
      ? await renderStageToDataUrl(frame, {
        width: options.width,
        height: options.height,
        pano: options.pano ?? null,
      })
      : await paint(frame, { width: options.width, height: options.height })
    last = await api.stageFrame({
      sessionId,
      ...options.canvasId === undefined ? {} : { canvasId: options.canvasId },
      index,
      total,
      width: options.width,
      height: options.height,
      fps: timeline.fps,
      dataUrl,
    })
    checkAborted(options.signal)
    options.onProgress?.((index + 1) / total)
    await yieldToBrowser()
  }

  // 宿主可能在最后一帧的响应里直接给结果（省掉一次往返），也可能只回 ok、
  // 由这里再问一次。两种都认——`stageFrame` 的契约把「最后一帧触发编码」
  // 写成允许而非强制，两边都不该猜对方。
  if (last !== undefined && isEncodeResult(last)) {
    return { url: last.url, mime: last.mime, duration: last.duration, bytes: last.bytes }
  }
  return await api.stageEncode(sessionId)
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new StageExportAborted()
}

function isEncodeResult(value: Partial<StageEncodeResult>): value is StageEncodeResult {
  return typeof value.url === 'string' && value.url !== ''
    && typeof value.mime === 'string'
    && typeof value.duration === 'number'
    && typeof value.bytes === 'number'
}

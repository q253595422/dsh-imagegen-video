/**
 * 从一条片子里抽一帧，返回 png 的 data URL。
 *
 * 画布有两处要用同一件事：「接着上一镜拍」（`CanvasWorkspace` 的
 * `frameFromClip`）和「回写时把片子登记成下一镜的起始帧」
 * （`drama-writeback-run.ts` 的 `frameOfClip`）。两处原先各写了一份同样的
 * 算法——加载、超时、seek、取尺寸、画到 canvas、转 png——一份改了另一份
 * 没跟上，症状会是「一处能抽到帧、另一处报空画面」。
 *
 * 算法本身没有 UI 语义，所以搬到这里；**文案留在调用方**：那边的失败属于
 * 「生成这一镜」，这边的失败属于「回写这一集」，混成一句会让用户看到
 * 「生成失败」而其实只是回写抽帧失败。
 */

/** 默认读片超时，与画布上那条既有的行为一致。 */
const DEFAULT_TIMEOUT_MS = 15_000

export interface FrameGrabInput {
  /** 同源片段地址。 */
  url: string
  /** `first` 取开头一帧，`last` 取结尾一帧。 */
  at: 'first' | 'last'
  /** 片段读不出来、或没有可解码画面时的文案。 */
  failure: string
  /** 超时文案。必填：两个调用方要给用户说不同的话，默认值只会把差异藏起来。 */
  timeoutFailure: string
  /** 超时毫秒；默认 15 秒。 */
  timeoutMs?: number
}

/**
 * 抽一帧。
 *
 * seek 到结尾要不早不晚：正好停在 `duration` 常落在解码器还没吐出的那一帧
 * 上，所以退一点点（60ms）。
 */
export async function grabFrame (input: FrameGrabInput): Promise<string> {
  const document = globalThis.document
  if (document === undefined) throw new Error('抽帧只能在浏览器里做。')
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const video = document.createElement('video')
  video.src = input.url
  video.muted = true
  video.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }
    video.addEventListener('loadeddata', () => { finish() }, { once: true })
    video.addEventListener('error', () => { finish(new Error(input.failure)) }, { once: true })
    globalThis.setTimeout(
      () => { finish(new Error(input.timeoutFailure)) },
      timeoutMs,
    )
  })
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  const target = input.at === 'last' && duration > 0 ? Math.max(0, duration - 0.06) : 0
  if (target > 0) {
    await new Promise<void>(resolve => {
      video.addEventListener('seeked', () => { resolve() }, { once: true })
      video.currentTime = target
    })
  }
  const width = video.videoWidth
  const height = video.videoHeight
  if (width === 0 || height === 0) throw new Error(input.failure)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error(input.failure)
  context.drawImage(video, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

/**
 * 导演台导出视频：宿主侧把逐帧 PNG 拼成 mp4。
 *
 * 为什么不在浏览器里编码：WebCodecs 的 H.264 可用性取决于浏览器、画幅和
 * 硬件，牧野自己就带了一句「当前浏览器不支持此画幅的 H.264 编码」给用户看。
 * 而宿主本来就有 ffmpeg（`clip-compose.ts` 已经在用），会话本来就有临时目录，
 * 编码这一步放这里，客户端只需要「渲一帧、传一帧」。
 *
 * ## 两个路由的分工（这里选的是「帧传完后客户端再显式取结果」）
 *
 * `stageFrame` 只接收帧，**不收尾**：它回答 `{ ok: true }`，不编码、不返回
 * 视频。`stageEncode` 才编码并返回 `StageEncodeResult`。
 *
 * 为什么不「最后一帧到达时顺手编码」：编码是几秒到几十秒的事情，而最后一帧
 * 的上传请求是客户端在一串顺序 await 里发的。把编码塞进那个请求的响应里，
 * 会让客户端分不清「传帧超时」和「编码超时」，也让重试语义变得古怪（重传
 * 最后一帧会不会再编一次？）。分成两条，客户端可以：传完 → 显示进度 →
 * 显式请求编码 → 拿到 URL，每一步的失败都能各自重试，且编码天然幂等
 * （同一 sessionId 编两次得到两个文件，不会互相踩）。
 *
 * ## 三条硬约束（都是踩过的坑）
 *
 *  - **yuv420p + 偶数边长**：H.264 的 4:2:0 色度抽样要求宽高为偶数，奇数
 *    尺寸直接编会失败。这里在编码前用 `pad` 补 1 像素而不是拒绝上传：用户
 *    拖出来的画幅是 1080×607 有什么好怪的，报错让他去改数字才是推卸责任。
 *  - **逐帧落盘，不在内存里攒**：150 帧 1080p 的原始 PNG 是几百 MB。这也
 *    决定了 `appendVideoHistory` 只能接受 Buffer 这一件事——读完整个 mp4 再
 *    交给它，mp4 比 PNG 序列小一个量级（几十 MB），可以接受。
 *  - **临时目录必须删干净**：编码成功、失败、进程退出三条路都要覆盖。参考
 *    `scripts/verify-frame-grab.mjs` 记的那笔账：`process.exit()` 会让
 *    `finally` 抓不到，所以 exit 钩子是必需的兜底，不是保险丝。
 */

import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StageEncodeResult, StageFrameUpload } from './protocol.ts'
import { appendVideoHistory } from './video-store.ts'
import { describeTools, findTool, runProcess, tail } from './video-tools.ts'

// ---------------------------------------------------------------- 限额

/**
 * 单会话帧数上限。
 *
 * 导演台的工程时长上限是 15 秒、固定 30fps，所以 450 帧是协议的物理上限。
 * 留一点余量给「客户端算错了一帧」这种情形，但不再往上放：帧数直接决定临时
 * 目录的占用，而这是一个每次导出都会重来一遍的路径。
 */
export const STAGE_MAX_FRAMES = 480

/** 单帧字节上限（PNG，解码后）。4K 的一帧 PNG 约 8–12 MB，取 32 MB 留足余量。 */
export const STAGE_MAX_FRAME_BYTES = 32 * 1024 * 1024

/**
 * 单帧请求体上限（JSON，含 base64）。
 *
 * base64 会把字节膨胀 4/3，再加 JSON 键名与引号；1.45 倍是实测够用的系数，
 * 不要在「差一点」的时候往上加——上限的意义是拒绝病态输入，不是刚好容纳
 * 最大的正常输入。
 */
export const STAGE_MAX_FRAME_BODY_BYTES = Math.ceil(STAGE_MAX_FRAME_BYTES * 1.5)

/** 一次编码的墙钟上限。150 帧 1080p 用 libx264 medium 大约 20–40 秒。 */
const ENCODE_TIMEOUT_MS = 10 * 60_000

/** 失败信息里保留的 ffmpeg 输出尾巴长度。 */
const MAX_ERROR_TAIL = 600

/** 边长上限。超过就是客户端算错了画幅，不是正常输入。 */
const MAX_DIMENSION = 4096

// ---------------------------------------------------------------- 会话状态

/** 一个导出会话在磁盘上的样子。 */
interface SessionRecord {
  dir: string
  /** 客户端声明的帧数，用于发现跳号与提前编码。 */
  total: number
  width: number
  height: number
  fps: number
  /**
   * 这次导出属于哪张画布。
   *
   * 记在会话上而不是 `stageEncode` 的入参里：编码请求只带 sessionId，客户端
   * 不该为「我是哪张画布」再传一遍——传两处就有两处不一致的可能，而以帧为准
   * 的那一处才是真的（帧是这次导出发生的时刻）。
   */
  canvasId?: string
  /** 已经收到的帧序号。跳号检测靠它，不靠文件系统——文件可能被外部删掉。 */
  received: Set<number>
  /** 编码结果，收到后缓存；同一会话重复请求就不再重编。 */
  result?: StageEncodeResult
  /** 正在编码的 Promise，防止两个请求同时进来各编一遍。 */
  encoding?: Promise<StageEncodeResult>
}

/**
 * 会话表。进程内的 Map 就够了：导出会话的生命周期是「一次点击到拿到 URL」，
 * 跨进程重启的空会话本来也没有恢复的意义（帧还在临时目录里但没人认领，
 * 由 exit 钩子和启动时的清扫处理）。
 *
 * 并发安全靠 sessionId 隔离：两个会话各自一个子目录、各自的 received 集合，
 * 唯一的共享状态是这张 Map 本身的读写，而 JS 单线程不会有竞态。
 */
const sessions = new Map<string, SessionRecord>()

/** 所有已创建的临时根目录，供 exit 钩子一次性清掉。 */
const stagingRoots = new Set<string>()

let exitHookInstalled = false

/**
 * 装进程退出钩子。
 *
 * `exit` 里只能做同步操作，所以用 `rmSync`。这不是「保险丝」而是**唯一**
 * 能覆盖 `process.exit()` 的手段：`src/skill-store.ts` 与
 * `scripts/verify-frame-grab.mjs` 都记过同一件事——三处 `process.exit()` 让
 * `finally` 成了摆设。
 */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const root of stagingRoots) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // 退出路径上不做任何补救：报错也无处可去，且可能遮住真正的退出原因。
      }
    }
    stagingRoots.clear()
    sessions.clear()
  })
}

/** 校验 sessionId：它会变成目录名，所以只允许安全字符。 */
function assertSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('sessionId 缺失')
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('sessionId 缺失')
  // 目录名只用字母数字与连字符：`..`、`/`、绝对路径都不能进来。
  if (!/^[A-Za-z0-9-]{1,64}$/.test(trimmed)) {
    throw new Error('sessionId 只能包含字母、数字和连字符，长度 1–64')
  }
  return trimmed
}

/** 从 data URL 里取出 PNG 字节。只认 PNG——这一路唯一的调用方是离屏 canvas。 */
function pngBytesOf(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string') throw new Error('帧数据缺失')
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (match === null) throw new Error('帧必须是 PNG 的 data URL')
  const bytes = Buffer.from(match[1]!, 'base64')
  if (bytes.length === 0) throw new Error('帧数据为空')
  if (bytes.length > STAGE_MAX_FRAME_BYTES) {
    throw new Error(`单帧超过 ${Math.round(STAGE_MAX_FRAME_BYTES / 1024 / 1024)} MB 上限`)
  }
  return bytes
}

/** 把 H.264 要求的偶数边长补齐后的实际尺寸。 */
function evenSize(width: number, height: number): { width: number; height: number; padded: boolean } {
  const evenW = width - (width % 2)
  const evenH = height - (height % 2)
  return { width: evenW < 2 ? 2 : evenW, height: evenH < 2 ? 2 : evenH, padded: evenW !== width || evenH !== height }
}

/**
 * 校验画布 id。
 *
 * 它只会被写进视频历史的索引，永远不变成文件名，所以这里不做字符白名单——
 * 收得太紧的代价是整次导出失败，而这段值唯一的用途是「之后能不能认出这张
 * 画布」。只截长度，拒绝病态输入。
 */
function optionalCanvasId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > 128 ? undefined : trimmed
}

/** 取一个会话；不存在就建（第一次上传时建）。 */
function sessionOf(upload: { sessionId: string; total: number; width: number; height: number; fps: number; canvasId?: string }): SessionRecord {
  const existing = sessions.get(upload.sessionId)
  if (existing !== undefined) {
    // 同一个会话的画幅若变了，说明客户端在两次上传之间改了尺寸；与其让它
    // 编出一段花屏，不如当场说清楚。帧率/总帧数同理。
    if (existing.width !== upload.width || existing.height !== upload.height) {
      throw new Error(`同一会话的画幅必须一致：已收到 ${existing.width}×${existing.height}，本帧是 ${upload.width}×${upload.height}`)
    }
    if (existing.total !== upload.total) {
      throw new Error(`同一会话的总帧数必须一致：已收到 ${existing.total}，本帧声明 ${upload.total}`)
    }
    // 后到的帧补上来源：客户端可能只在第一帧带它，也可能一帧都没带。会话里
    // 已经有就不覆盖——同一会话不可能属于两张画布，最先说出来的那次为准。
    if (existing.canvasId === undefined && upload.canvasId !== undefined) existing.canvasId = upload.canvasId
    return existing
  }
  installExitHook()
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-stage-'))
  stagingRoots.add(root)
  const dir = path.join(root, upload.sessionId)
  const record: SessionRecord = {
    dir,
    total: upload.total,
    width: upload.width,
    height: upload.height,
    fps: upload.fps,
    ...upload.canvasId === undefined ? {} : { canvasId: upload.canvasId },
    received: new Set(),
  }
  sessions.set(upload.sessionId, record)
  return record
}

// ---------------------------------------------------------------- 收帧

/**
 * 收一帧。返回 `{ received, total }`，客户端据此显示进度。
 *
 * 重复上传同一 `index` 是允许的（覆盖写入）：网络重试不该被判成错误，而
 * 「同一帧传两次」没有任何歧义。
 */
export async function stagePutFrame(raw: Record<string, unknown>): Promise<{ received: number; total: number }> {
  const sessionId = assertSessionId(raw.sessionId)
  const index = Number(raw.index)
  const total = Number(raw.total)
  const width = Number(raw.width)
  const height = Number(raw.height)
  const fps = Number(raw.fps)

  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index 必须是非负整数')
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('total 必须是不小于 1 的整数')
  if (total > STAGE_MAX_FRAMES) throw new Error(`单次导出最多 ${STAGE_MAX_FRAMES} 帧，收到 ${total}`)
  if (index >= total) throw new Error(`index ${index} 越界：total 是 ${total}`)
  if (!Number.isSafeInteger(width) || width < 2 || width > MAX_DIMENSION) throw new Error(`宽度非法：${String(raw.width)}`)
  if (!Number.isSafeInteger(height) || height < 2 || height > MAX_DIMENSION) throw new Error(`高度非法：${String(raw.height)}`)
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error(`帧率非法：${String(raw.fps)}`)

  const bytes = pngBytesOf(raw.dataUrl)
  const canvasId = optionalCanvasId(raw.canvasId)
  const session = sessionOf({ sessionId, total, width, height, fps, ...canvasId === undefined ? {} : { canvasId } })

  await fs.mkdir(session.dir, { recursive: true })
  await fs.writeFile(path.join(session.dir, frameName(index)), bytes)
  session.received.add(index)
  return { received: session.received.size, total: session.total }
}

/** 帧文件名。`%05d` 让 ffmpeg 的 image2 demuxer 按序号顺序读。 */
function frameName(index: number): string {
  return `${String(index).padStart(5, '0')}.png`
}

// ---------------------------------------------------------------- 编码

/**
 * 编码一个会话，返回可落成视频节点的引用。
 *
 * 幂等：同一会话已经编过就直接返回上次的结果（客户端可能在拿结果时重试）。
 * 并发安全：同一会话的两个请求共用同一个 Promise，不会起两个 ffmpeg。
 */
export async function stageEncodeSession(raw: Record<string, unknown>): Promise<StageEncodeResult> {
  const sessionId = assertSessionId(raw.sessionId)
  const session = sessions.get(sessionId)
  if (session === undefined) {
    throw new Error('找不到这次导出：会话已过期或帧从未上传')
  }
  if (session.result !== undefined) return session.result
  if (session.encoding !== undefined) return session.encoding

  session.encoding = encodeOnce(sessionId, session).finally(() => { session.encoding = undefined })
  return session.encoding
}

async function encodeOnce(sessionId: string, session: SessionRecord): Promise<StageEncodeResult> {
  const missing: number[] = []
  for (let index = 0; index < session.total; index += 1) {
    if (!session.received.has(index)) missing.push(index)
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 8).join('、')
    const more = missing.length > 8 ? ` 等 ${missing.length} 帧` : ''
    throw new Error(`还有帧没到：第 ${shown}${more}`)
  }

  const found = { ffmpeg: findTool('ffmpeg'), ffprobe: findTool('ffprobe') }
  if (found.ffmpeg === undefined) {
    throw new Error(`这台机器上找不到 ffmpeg，无法导出视频。${describeTools(found)}`)
  }

  const size = evenSize(session.width, session.height)
  const output = path.join(path.dirname(session.dir), `${sessionId}.mp4`)
  const args = buildEncodeArgs(session, size, output)
  const run = await runProcess(found.ffmpeg, args, { timeoutMs: ENCODE_TIMEOUT_MS })
  if (run.code !== 0) {
    throw new Error(`ffmpeg 编码失败（退出码 ${run.code}）：${tail(run.stderr)}`)
  }

  const bytes = await fs.readFile(output)
  if (bytes.length === 0) throw new Error('ffmpeg 没有产出文件')

  // 时长按**实际帧数**算，不信客户端声明的 duration：帧数才是视频里真实
  // 存在的东西，声明值只是意图。
  const duration = session.total / session.fps
  const entries = await appendVideoHistory({
    id: entryIdOf(sessionId),
    createdAt: Date.now(),
    mode: 'compose',
    model: 'ffmpeg',
    prompt: '3D 导演台导出',
    aspectRatio: aspectOf(session.width, session.height),
    resolution: `${size.width}x${size.height}`,
    seconds: duration,
    files: [{ bytes, mime: 'video/mp4', duration }],
    // 带来源的视频在历史列表里会被归到那张画布下，而不是冒充一次独立生成；
    // 没有 canvasId 的导出（脚本调用、老客户端）保持原样，一条都不缺。
    ...session.canvasId === undefined ? {} : { canvas: { canvasId: session.canvasId } },
  })

  const entry = entries.find(item => item.id === entryIdOf(sessionId))
  const file = entry?.videos[0]
  if (file === undefined) throw new Error('编好的视频没有写进视频库')

  const result: StageEncodeResult = {
    // `file.url` 已经是 `${VIDEO_API.file}/<file>` 形状（由 `video-store` 唯一
    // 一处置成）。不要再在这里重新拼一遍——两处都拼 URL 的时候，改一处就漏。
    url: file.url,
    mime: file.mime,
    duration,
    bytes: bytes.length,
  }
  session.result = result
  await cleanup(sessionId, session)
  return result
}

/**
 * ffmpeg 参数。
 *
 * `-framerate` 放在 `-i` 前（作用于输入的解帧率）；`-pix_fmt yuv420p` 是必须
 * 的——没有它 libx264 可能选 yuv444p，浏览器与 QuickTime 会拒播或绿屏；
 * `+faststart` 把 moov 挪到文件头，视频节点在画布上才能边下边播。
 *
 * 奇数边长用 `pad` 各补 1 像素（右下角），而不是 `scale`：缩放会重采样整幅
 * 画面，为了 1 个像素把整段视频糊掉不划算。补出来的那一条是黑的，但 1 像素
 * 看不出来。
 */
function buildEncodeArgs(session: SessionRecord, size: { width: number; height: number; padded: boolean }, output: string): string[] {
  const args = [
    '-y',
    '-framerate', String(session.fps),
    '-i', path.join(session.dir, '%05d.png'),
  ]
  if (size.padded) {
    args.push('-vf', `pad=${size.width}:${size.height}:0:0:black`)
  }
  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    // CRF 18 对「预演参考片」足够：它要喂给视频模型当参考，不是交付母版。
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    output,
  )
  return args
}

/** 视频库条目 id：带前缀，避免和生成/拼接出来的条目撞名。 */
function entryIdOf(sessionId: string): string {
  return `stage-${sessionId}`
}

/** 宽高比，按现有画布的写法给一个近似值。 */
function aspectOf(width: number, height: number): string {
  const ratio = width / height
  if (Math.abs(ratio - 16 / 9) < 0.02) return '16:9'
  if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16'
  if (Math.abs(ratio - 1) < 0.02) return '1:1'
  if (Math.abs(ratio - 4 / 3) < 0.02) return '4:3'
  if (Math.abs(ratio - 3 / 4) < 0.02) return '3:4'
  if (Math.abs(ratio - 21 / 9) < 0.02) return '21:9'
  return `${width}:${height}`
}

// ---------------------------------------------------------------- 清理

/**
 * 删掉一个会话的临时目录与登记。
 *
 * 编码完立刻调（mp4 已经在视频库里，帧不再有用）；也供失败路径兜底。
 * 不删镜头表里的条目——`result` 要留着，客户端拿到结果后可能还会重试一次
 * 取结果。
 */
async function cleanup(sessionId: string, session: SessionRecord): Promise<void> {
  const root = path.dirname(session.dir)
  try {
    await fs.rm(root, { recursive: true, force: true })
  } catch {
    // 删不掉不是错误：exit 钩子会再试一次，而磁盘上的临时目录不影响正确性。
  }
  stagingRoots.delete(root)
  void sessionId
}

/** 客户端放弃导出时释放帧。路由没强制要求，留给上层按需调用。 */
export async function stageDropSession(raw: Record<string, unknown>): Promise<{ dropped: boolean }> {
  const sessionId = assertSessionId(raw.sessionId)
  const session = sessions.get(sessionId)
  if (session === undefined) return { dropped: false }
  sessions.delete(sessionId)
  await cleanup(sessionId, session)
  return { dropped: true }
}

/** 测试用：清空所有会话（离线脚本不该看见上一个 case 的残留）。 */
export async function resetStageEncode(): Promise<void> {
  for (const [sessionId, session] of sessions) {
    sessions.delete(sessionId)
    await cleanup(sessionId, session)
  }
}

/** 从已上传的帧表里算出还差哪些帧——路由用它给客户端更准的进度。 */
export function describeSession(sessionId: string): { total: number; received: number; complete: boolean } | undefined {
  const session = sessions.get(sessionId)
  if (session === undefined) return undefined
  return {
    total: session.total,
    received: session.received.size,
    complete: session.received.size >= session.total,
  }
}

export type { StageFrameUpload }

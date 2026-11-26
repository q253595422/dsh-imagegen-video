/**
 * 画布 → 文档回写的编排层。
 *
 * 三层各管一件事：`drama-writeback.ts`（纯函数）算「要写什么」，
 * `drama-write.ts`（宿主）只管落盘与安全边界，这里负责把两者接起来，并做
 * 三件只有浏览器能做或只有这里知道顺序的事：
 *
 *  - **取字节。** 图片在画布资产里（`assetToDataUrl`），视频在视频库里、按
 *    URL 引用（`fetch` 回来转 data URL）。两条路不同，不能互相套。
 *  - **抽帧。** `REF-` 不收 mp4，所以「登记为起始帧」必须先把片子解码、seek
 *    到指定位置、画成 png。这一段离了浏览器就不存在。
 *  - **一个失败不带走整批。** 22 镜回写里坏掉一条，另外 21 条该照常落盘：
 *    逐个写、逐个报，比整批回滚更有用——整批回滚之后用户还得猜是哪条坏的。
 */

import type { CanvasAssetRef, CanvasNode } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { assetToDataUrl } from './canvas/node-model.ts'
import { grabFrame } from './frame-grab.ts'
import { patchStoryboardReferences, type DramaWritePlan } from './drama-writeback.ts'

/** 一条产出的回写结果。 */
export interface DramaWriteResult {
  relativePath: string
  ok: boolean
  bytes?: number
  /** `exists` 是「已经有了、没有覆盖」，不是「写坏了」。 */
  code?: string
  message?: string
  backup?: string
}

/** 一份文档的回写结果。 */
export interface DramaDocumentResult {
  relativePath: string
  changed: boolean
  backup: string
}

/** 一次回写的全部结果，供界面如实汇总。 */
export interface DramaWriteReport {
  files: DramaWriteResult[]
  frames: DramaWriteResult[]
  document?: DramaDocumentResult
  /** 文档里缺 `- 输入参考图：` 行、因而没有改写的镜号。 */
  missingField: string[]
  /** 没跑出片子的镜头。 */
  skipped: Array<{ shotId: string }>
}

/**
 * 把一条同源视频读成 data URL。
 *
 * 不走 `assetToDataUrl`：那条读的是画布资产（图片），而片子住在视频库、
 * 由 `metadata.video.url` 引用。两者都不该为对方改形状。
 */
export async function clipToDataUrl(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取片段失败：HTTP ${response.status}`)
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取片段失败：无法解码'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 从一条片子里抽一帧，返回 png 的 data URL。
 *
 * 算法在 `frame-grab.ts` 里，与画布的「接着上一镜拍」共用一份；这里只提供
 * 回写这一侧的文案：那边的失败属于「生成这一镜」，这边的失败属于「回写这
 * 一集」，混成一句会让用户看到「生成失败」而其实只是回写抽帧失败。
 */
export async function frameOfClip(input: {
  url: string
  at: 'first' | 'last'
  /** 超时毫秒；默认 15 秒，与画布那条一致。 */
  timeoutMs?: number
}): Promise<string> {
  return await grabFrame({
    url: input.url,
    at: input.at,
    failure: '片段读不出来，无法抽帧。',
    timeoutFailure: '抽帧超时：片段在 15 秒内没有读出来。',
    timeoutMs: input.timeoutMs,
  })
}

/** 一个节点的字节从哪来。 */
function dataUrlOfNode(node: CanvasNode, api: ImageGenApi): Promise<string> {
  const asset: CanvasAssetRef | undefined = node.metadata?.asset
  if (node.type === 'image' && asset !== undefined && asset.assetId !== '') return assetToDataUrl(asset)
  const clip = node.metadata?.video
  if (node.type === 'video' && clip !== undefined && clip.url !== '') return clipToDataUrl(clip.url)
  return Promise.reject(new Error(`节点 ${node.id} 没有可取的内容。`))
}

/**
 * 执行一次回写。
 *
 * 顺序有讲究：**先写图与片子，最后才改文档**。
 *
 * 文档里的 `输入参考图` 会指向那些还没落盘的产出；先落盘、后改文档，中途
 * 失败时文档仍然指向实际存在的文件。反过来会让文档先声明「起始帧是这张
 * png」，而磁盘上还没有它——上游拿这份文档去校验就会报「参考图不存在」，
 * 而用户看到的却是「回写成功了一部分」。
 *
 * @param input.existing - 目标文件已存在时是否覆盖。默认不覆盖：产出是用户
 *   的作品，静默替换会把「再跑一次」变成「把上一次的成品顶掉」。覆盖时宿主
 *   会先备份成 `.bak-<时间戳>`。
 */
export async function writebackDrama(input: {
  api: ImageGenApi
  plan: DramaWritePlan
  nodes: readonly CanvasNode[]
  /** 分镜文档的原文，用来算改写后的全文；不传就只写产出、不改文档。 */
  storyboardText?: string
  overwrite: boolean
  /** 报告进度（第几个 / 共几个），界面拿来显示。 */
  onProgress?: (done: number, total: number, label: string) => void
}): Promise<DramaWriteReport> {
  const { api, plan, nodes, overwrite } = input
  const byId = new Map(nodes.map(node => [node.id, node]))
  const files: DramaWriteResult[] = []
  const frames: DramaWriteResult[] = []
  const total = plan.media.length + plan.images.length + plan.frames.length
  let done = 0
  const tick = (label: string): void => {
    done += 1
    input.onProgress?.(done, total, label)
  }

  const writeOne = async (relativePath: string, dataUrl: string, label: string): Promise<DramaWriteResult> => {
    try {
      const written = await api.dramaWriteFile({
        root: plan.source.root,
        projectPath: plan.source.projectPath,
        path: relativePath,
        dataUrl,
        overwrite,
      })
      return { relativePath: written.relativePath, ok: true, bytes: written.bytes, ...written.backup === undefined ? {} : { backup: written.backup } }
    } catch (error) {
      const failure = error as { code?: string, message?: string }
      return {
        relativePath,
        ok: false,
        code: failure.code ?? 'drama-write-failed',
        message: failure.message ?? String(error),
      }
    } finally {
      tick(label)
    }
  }

  // 1. 图片（设定板）
  for (const image of plan.images) {
    const node = byId.get(image.nodeId)
    if (node === undefined) {
      files.push({ relativePath: image.relativePath, ok: false, code: 'drama-write-failed', message: '画布上找不到这个节点。' })
      continue
    }
    try {
      const dataUrl = await dataUrlOfNode(node, api)
      files.push(await writeOne(image.relativePath, dataUrl, image.relativePath))
    } catch (error) {
      files.push({ relativePath: image.relativePath, ok: false, code: 'drama-write-failed', message: String(error) })
      tick(image.relativePath)
    }
  }

  // 2. 片子
  for (const video of plan.media) {
    const node = byId.get(video.nodeId)
    if (node === undefined) {
      files.push({ relativePath: video.relativePath, ok: false, code: 'drama-write-failed', message: '画布上找不到这个节点。' })
      continue
    }
    try {
      const dataUrl = await dataUrlOfNode(node, api)
      files.push(await writeOne(video.relativePath, dataUrl, video.relativePath))
    } catch (error) {
      files.push({ relativePath: video.relativePath, ok: false, code: 'drama-write-failed', message: String(error) })
      tick(video.relativePath)
    }
  }

  // 3. 起始帧（抽帧 → 写图）
  for (const frame of plan.frames) {
    try {
      const dataUrl = await frameOfClip({ url: frame.clipUrl, at: frame.at })
      frames.push(await writeOne(frame.relativePath, dataUrl, frame.relativePath))
    } catch (error) {
      frames.push({ relativePath: frame.relativePath, ok: false, code: 'drama-frame-failed', message: String(error) })
      tick(frame.relativePath)
    }
  }

  // 4. 文档：最后一步，而且只在真要改的时候。
  let document: DramaDocumentResult | undefined
  const missingField: string[] = []
  if (input.storyboardText !== undefined && plan.referenceLines.size > 0) {
    const patched = patchStoryboardReferences(input.storyboardText, plan.referenceLines)
    missingField.push(...patched.missing)
    if (patched.changes.length > 0) {
      try {
        const written = await api.dramaWriteDocument({
          root: plan.source.root,
          projectPath: plan.source.projectPath,
          text: patched.text,
          expected: input.storyboardText,
        })
        document = { relativePath: written.relativePath, changed: written.changed, backup: written.backup }
      } catch (error) {
        const failure = error as { message?: string }
        frames.push({ relativePath: '分镜.md', ok: false, code: 'drama-write-failed', message: failure.message ?? String(error) })
      }
    }
  }

  return {
    files,
    frames,
    ...document === undefined ? {} : { document },
    missingField,
    skipped: plan.skipped,
  }
}

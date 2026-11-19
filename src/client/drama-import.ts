/**
 * 「从工作区的一集短剧铺一块板」的编排层。
 *
 * 三层各管一件事：`drama-project.ts`（宿主）只把字节读出来，
 * `storyboard-markdown.ts` 只回答「文档说了什么」，`storyboard-layout.ts` 只
 * 回答「那变成画布上的什么」。这个模块负责把它们接起来，并处理三件只有在
 * 真实环境里才会出现的事：
 *
 *  - **工作区从哪来。** 宿主自己的会话列表里带 `cwd`（`SessionSummary.cwd`），
 *    所以不需要在画布文档里存路径，也不需要用户手填。
 *  - **参考图怎么变成 cast。** `submitShot` 只从被钉住的图片节点取参考图
 *    （`castRefsFor(current, [])`），连线不会生效。所以参考图必须真的导入成
 *    图片节点、打上 `metadata.cast`，否则铺了也是白铺。
 *  - **失败要说人话。** 一份文档读到了、另一份没有，是常态；`notes` 里逐条
 *    写清楚，界面才有东西可显示。
 */

import type { CanvasAssetRef, CanvasNode, DramaProjectRead } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import {
  parseImagePromptsMarkdown,
  parseMotionPromptsMarkdown,
  parseStoryboardMarkdown,
  type ParsedMotionPrompt,
} from './storyboard-markdown.ts'
import { layoutNodes, planCanvasLayout, type CanvasLayoutPlan, type LayoutNodes } from './storyboard-layout.ts'
import { IMAGE_NODE_SIZE, STORYBOARD_NODE_SIZE } from './canvas/constants.ts'

/** 从宿主读回来、解析好、还没落成节点的一次铺板。 */
export interface DramaImport {
  /** 宿主读到的原始内容。 */
  project: DramaProjectRead
  plan: CanvasLayoutPlan
  /** 从《视频提示词.md》接回分镜的条目，导入参考图时还要用。 */
  motions: ParsedMotionPrompt[]
  /** 文档里点名、但项目里找不到实图的参考图。 */
  missingReferences: string[]
  /** 给用户看的整体说明。 */
  notes: string[]
}

/** 一次读取的可选输入。 */
export interface DramaReadInput {
  /** 工作区绝对路径；缺省时由调用方从会话列表取。 */
  root: string
  /** 剧集目录（相对工作区）；缺省让宿主自己找。 */
  projectPath?: string
}

/**
 * 读 + 解析一次，不碰画布。
 *
 * 拆出来是为了让「读到了什么」可以在不落节点的情况下先给用户看——用户可能
 * 只想确认这文档读对了，不想立刻在画布上多出三十个节点。
 */
export async function readDrama(api: ImageGenApi, input: DramaReadInput): Promise<DramaImport> {
  const project = await api.dramaProject(input.root, input.projectPath)
  const byKey = new Map(project.documents.map(document => [document.key, document]))
  const storyboardText = byKey.get('storyboard')?.text ?? ''
  const imageText = byKey.get('imagePrompts')?.text ?? ''
  const motionText = byKey.get('motionPrompts')?.text ?? ''
  const storyboard = parseStoryboardMarkdown(storyboardText)
  const images = imageText === '' ? undefined : parseImagePromptsMarkdown(imageText)
  const motions = motionText === '' ? undefined : parseMotionPromptsMarkdown(motionText)
  const plan = planCanvasLayout({
    storyboard,
    ...motions === undefined ? {} : { motions: motions.items },
    ...images === undefined ? {} : { images: images.items },
  })
  const notes: string[] = [...project.notes]
  if (images === undefined) notes.push('没有《图片提示词.md》，设定板不会铺出来。')
  if (motions === undefined) notes.push('没有《视频提示词.md》，每镜的提示词会退回首帧静帧描述。')
  if (images !== undefined) notes.push(...images.warnings)
  if (motions !== undefined) notes.push(...motions.warnings)
  // 文档里写了 `REF-…` 路径、项目里却没有这张图：铺板能继续，但这一镜的
  // 参考会静默缺失——这是最需要说出口的一类，因为用户会以为参考已经生效。
  const available = new Set(project.images.map(image => image.relativePath))
  const missingReferences: string[] = []
  for (const shot of storyboard.shots) {
    for (const reference of shot.references) {
      if (reference.slot.startsWith('PLAN-') || reference.path === '') continue
      if (available.has(reference.path)) continue
      missingReferences.push(`${shot.shotId} 的 ${reference.slot}：「${reference.path}」不在项目里。`)
    }
  }
  return {
    project,
    plan,
    motions: motions?.items ?? [],
    missingReferences,
    notes: [...notes, ...missingReferences],
  }
}

/** 一次铺板要落到画布上的东西。 */
export interface DramaPlacement extends LayoutNodes {
  /** 导入并钉住的参考图节点（已带 `metadata.cast`）。 */
  castNodes: CanvasNode[]
  /** 导入过程中没成功的图（路径与原因）。 */
  skippedImages: Array<{ relativePath: string, message: string }>
}

/** 图片的自然尺寸，用来填 `putImage` 要求的宽高。 */
async function imageSizeOf(dataUrl: string): Promise<{ width: number, height: number }> {
  return await new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth < 1 || image.naturalHeight < 1) { reject(new Error('图片没有有效尺寸')); return }
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => reject(new Error('图片无法解码'))
    image.src = dataUrl
  })
}

/**
 * 把一次导入落成节点与连线。
 *
 * 参考图分三步，顺序不能反：
 *  1. 宿主把字节读成 data URL（`dramaImage`）。
 *  2. 浏览器把图解码，量出宽高——`canvasUpload` 要这两个数。
 *  3. `canvasUpload` 入库拿资产，再建节点、打 `metadata.cast`。
 *
 * `cast` 是「这张被钉住了」的唯一记号，`submitShot` 就是按它取图的
 * （`CanvasWorkspace.tsx:4160`）——连一条线过去不会生效，所以这一步是
 * 整个铺板能不能真跑起来的关口。
 *
 * 一张图失败不中断整次铺板：其余镜头仍然可用，失败的那张列在
 * `skippedImages` 里由界面说清楚。
 */
export async function placeDrama(input: {
  api: ImageGenApi
  root: string
  imported: DramaImport
  at: { x: number, y: number }
  newId: (kind: 'node' | 'edge') => string
}): Promise<DramaPlacement> {
  const { api, root, imported, at, newId } = input
  const base = layoutNodes({ plan: imported.plan, at, newId })
  const notes: string[] = [...base.warnings]
  const castNodes: CanvasNode[] = []
  const skippedImages: Array<{ relativePath: string, message: string }> = []
  // 一镜可以引用同一张图；同一个路径只导一次。
  const importedByPath = new Map<string, CanvasAssetRef>()
  const castNames = new Set<string>()
  for (const placed of imported.plan.shots) for (const name of placed.castNames) castNames.add(name)
  const wanted: string[] = []
  for (const placed of imported.plan.shots) {
    for (const path of placed.referencePaths) if (!wanted.includes(path)) wanted.push(path)
  }
  // 参考图横排在设定板下方一行；不重叠，也不挡分镜板。
  const startY = at.y + STORYBOARD_NODE_SIZE.height + IMAGE_NODE_SIZE.height + 48
  for (const relativePath of wanted) {
    let asset: CanvasAssetRef | undefined = importedByPath.get(relativePath)
    if (asset === undefined) {
      try {
        const bytes = await api.dramaImage(root, relativePath)
        const size = await imageSizeOf(bytes.dataUrl)
        // 尺寸按资产原比例缩到节点宽度，图才不会在节点里变形。
        const scale = Math.min(1, IMAGE_NODE_SIZE.width / size.width)
        asset = await api.canvasUpload(
          bytes.dataUrl,
          size.width,
          size.height,
          { origin: 'upload', originId: relativePath },
        )
        importedByPath.set(relativePath, asset)
        castNodes.push({
          id: newId('node'),
          type: 'image',
          title: castNameFor(relativePath, [...castNames]),
          x: Math.round(at.x + castNodes.length * (IMAGE_NODE_SIZE.width + 24)),
          y: Math.round(startY),
          width: Math.round(size.width * scale),
          height: Math.round(size.height * scale),
          metadata: {
            asset,
            status: 'success',
            // 钉住：这是 `submitShot` 取参考图的唯一来源。
            cast: { role: 'character', name: castNameFor(relativePath, [...castNames]) },
          },
        })
      } catch (error) {
        skippedImages.push({ relativePath, message: errorMessage(error) })
        continue
      }
    }
  }
  if (skippedImages.length > 0) notes.push(`${skippedImages.length} 张参考图没有导入成功。`)
  return {
    boardNode: base.boardNode,
    imageNodes: base.imageNodes,
    connections: base.connections,
    // `LayoutNodes.warnings` 就是给人看的那些话，不另起一个 `notes`。
    warnings: notes,
    castNodes,
    skippedImages,
  }
}

/** 一张参考图该钉成什么名字：文档里的身份名优先，没有就用文件名。 */
function castNameFor(relativePath: string, names: readonly string[]): string {
  const file = relativePath.slice(relativePath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  const matched = names.find(name => file.includes(name))
  return matched ?? file
}

/** 一句可读的错误文案。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

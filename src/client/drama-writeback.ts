/**
 * 画布 → 文档回写：把做出来的东西算成「该写进磁盘的什么」。
 *
 * A 案（`drama-import.ts`）是文档 → 画布；这里是它的镜像，两个方向用同一套
 * 编号：镜头的 `SHOT-…` 就是文档里那个二级标题的编号，`IMG-…` 同理。所以
 * 回写不需要新的映射表，也不需要问用户「这一镜是第几镜」。
 *
 * ## 分工
 *
 *  1. **这里**只回答「有哪些文件要落、路径叫什么、`输入参考图` 该写成什么」。
 *     全是纯函数，输入是画布节点 + 项目信息，输出是待办清单。
 *  2. 宿主（`drama-write.ts`）只负责把字节落到磁盘，并做路径与覆盖检查。
 *  3. 界面负责取字节（画布资产 → data URL、视频抽帧）与确认。
 *
 * ## 为什么路径与写法长这样
 *
 * 照 `short-drama-produce` 的 adapter 契约来：产出落 `剧集/<EP>/制作成果/images/`
 * 与 `.../video/`，参考图绑定写成
 * `REF-<槽位>（顺序：n）· <项目相对路径>《<名称>》（用途：…）`。按它写，
 * 回写出来的文档能直接被上游技能继续用；自己另发明一套，等于把用户锁死在
 * 我们这里。
 *
 * ## 一条容易搞错、代价很大的事
 *
 * `REF-` 只接受 `.png / .jpg / .jpeg / .webp`——**视频不能当参考图**。所以
 * 「把这一镜的片子登记成下一镜的起始帧」不能直接写 `…/video/SHOT-x.mp4`：
 * 上游校验会拒，而且它本来也读不了 mp4。正确做法是从片子里抽一帧存成
 * `制作成果/images/SHOT-x.png`，再让下一镜引那张 png。这也是为什么计划里
 * 除了「取字节写文件」之外还有一类「抽帧任务」。
 */

import type { CanvasNode, CanvasShot, CanvasStoryboardSource } from '../protocol.ts'
import { imageIdOfTitle } from './drama-reuse.ts'
// 标题与字段行的读法只有一份：`storyboard-markdown.ts` 是文档格式与分镜模型
// 唯一的相遇点。两处各写一份正则，读写两侧会在某次格式微调后静默分家。
import { fieldOf, shotHeadingOf } from './storyboard-markdown.ts'

/** 一个待写文件：项目相对路径 + 它的内容从哪来。 */
export interface DramaWriteFile {
  /** 项目相对路径，如 `剧集/EP001/制作成果/video/SHOT-EP001-001.mp4`。 */
  relativePath: string
  /** 画布节点 id；调用方据此去取字节。 */
  nodeId: string
  kind: 'image' | 'video'
}

/**
 * 一条抽帧任务：从一条片子里取一帧，存成一张图。
 *
 * 单独一类是因为它需要的能力不同——`DramaWriteFile` 的字节就在画布资产里，
 * 抽帧却要把视频解码、seek、画到 canvas 上，只有浏览器能做。
 */
export interface DramaFrameTask {
  /** 同源片段 URL（`metadata.video.url`）。 */
  clipUrl: string
  /** 抽哪一帧。 */
  at: 'first' | 'last'
  /** 抽出来的图写到哪。 */
  relativePath: string
  /** 这一帧属于哪一镜（报告与去重用）。 */
  shotId: string
}

/** 一镜的参考图绑定，按文档里那一行的写法组织。 */
export interface DramaReferenceBinding {
  /** `REF-…` 的槽位后缀，只允许 `A-Z0-9-`。 */
  slot: string
  /** 从 1 连续递增。 */
  order: number
  /** 项目相对路径。 */
  path: string
  /** `《…》` 里的名字：文档里写的是它，提示词里称呼的也是它。 */
  name: string
  /** `用途：…`，只能取上游那十个词之一。 */
  purpose: DramaReferencePurpose
  /** `控制：…`。 */
  control?: string
  /** `不得控制：…`。 */
  notControl?: string
}

/**
 * `用途` 的取值集合，照抄 `short-drama-storyboard` 的规范。
 *
 * 不自己加词：上游校验按这份清单核对，多写一个词等于给用户造一份「我们认、
 * 它不认」的文档。
 */
export const DRAMA_REFERENCE_PURPOSES = [
  '外貌', '主体', '造型状态', '空间布局', '构图', '尺度', '效果', '起始帧', '结束帧', '风格',
] as const

export type DramaReferencePurpose = typeof DRAMA_REFERENCE_PURPOSES[number]

/** 只接受清单里的用途；认不出来时落到 `主体`（最泛的一个）。 */
export function purposeOf(raw: string): DramaReferencePurpose {
  const value = raw.trim()
  return (DRAMA_REFERENCE_PURPOSES as readonly string[]).includes(value)
    ? value as DramaReferencePurpose
    : '主体'
}

/** 槽位后缀允许的字符，与上游 `REF-...` 的规范一致。 */
const SLOT_BODY = /^[A-Z0-9-]+$/

/**
 * 从一镜编号派生稳定的槽位后缀。
 *
 * `SHOT-EP001-007` → `EP001-007`。用镜号而不是序号，是因为镜号在文档里
 * 唯一且稳定；用序号（1、2、3…）的话，用户插一镜就把后面所有参考图的
 * 槽位名改了，等于每改一次分镜就把回写过的东西全打乱。
 */
export function slotOfShot(shotId: string): string {
  const body = shotId.replace(/^SHOT-/, '').toUpperCase().replace(/[^A-Z0-9-]/g, '-')
  return SLOT_BODY.test(body) && body !== '' ? body : 'SHOT'
}

/**
 * 一个产出文件名。
 *
 * 用镜号而不是标题：标题里有中文、空格和标点，落到文件名上会出现跨平台
 * 编码差异，而这些文件要交给外部工具读。上游契约的 `outputs` 示例也正是
 * `剧集/EP001/制作成果/video/SHOT-EP001-001.mp4`。
 */
export function outputFileOf(input: {
  shotId: string
  kind: 'image' | 'video'
}): string {
  return `${input.shotId}.${input.kind === 'image' ? 'png' : 'mp4'}`
}

/** 产出目录（相对项目根），与上游 adapter 契约里的两条一致。 */
export function outputDirectoryOf(projectPath: string, kind: 'image' | 'video'): string {
  const base = projectPath === '.' || projectPath === '' ? '' : `${projectPath}/`
  return `${base}制作成果/${kind === 'image' ? 'images' : 'video'}`
}

/** 这一镜的片子是不是这个节点。 */
export function isShotClip(node: CanvasNode, boardId: string, shot: CanvasShot): boolean {
  if (node.type !== 'video') return false
  const origin = node.metadata?.shot
  if (origin !== undefined) return origin.storyboardId === boardId && origin.shotId === shot.id
  // 板自己记的那一路：`shot.nodeId`。老画布可能只有这个。
  return shot.nodeId !== undefined && shot.nodeId === node.id
}

/** 画布上这一镜的片子（有就返回，没有就 undefined）。 */
export function shotClipOf(nodes: readonly CanvasNode[], boardId: string, shot: CanvasShot): CanvasNode | undefined {
  if (shot.nodeId !== undefined) {
    const direct = nodes.find(node => node.id === shot.nodeId)
    if (direct !== undefined && direct.type === 'video') return direct
  }
  return nodes.find(node => isShotClip(node, boardId, shot))
}

/** 这条片子取不取得到字节。 */
export function clipReady(node: CanvasNode | undefined): node is CanvasNode {
  return node !== undefined && node.metadata?.video !== undefined && node.metadata.video.url !== ''
}

/**
 * 把绑定列表写成文档那一行的正文。
 *
 * 格式照抄上游：`REF-A（顺序：1）· <路径>《<名称>》（用途：外貌；控制：…）`，
 * 多项之间用全角分号 `；`。注意路径前是**中点 `·`**，不是 `/`——上游解析器
 * 按中点切字段，写成 `/` 会让路径被读成名称的一部分。
 */
export function referenceLineOf(bindings: readonly DramaReferenceBinding[]): string {
  if (bindings.length === 0) return '无（文生视频）。'
  return bindings.map(binding => {
    const parts = [`用途：${binding.purpose}`]
    if (binding.control !== undefined && binding.control !== '') parts.push(`控制：${binding.control}`)
    if (binding.notControl !== undefined && binding.notControl !== '') parts.push(`不得控制：${binding.notControl}`)
    return `REF-${binding.slot}（顺序：${binding.order}）· ${binding.path}《${binding.name}》（${parts.join('；')}）`
  }).join('；')
}

/** 改写结果：新文本 + 改了哪几行（供界面如实报告）。 */
export interface ReferencePatch {
  text: string
  changes: Array<{ shotId: string, before: string, after: string }>
  /** 请求里有、但文档里没有这一行的镜号。 */
  missing: string[]
}

/**
 * 在一份 `分镜.md` 里改写指定镜头的 `输入参考图` 行。
 *
 * 三个必须守住的东西：
 *
 *  - **不碰别的行。** 整份文档是 Agent 和用户一起写的，回写只该动它负责的
 *    那几行；重排、格式化、补空行都会制造一次巨大的 diff。
 *  - **只在镜头段落之内找字段行。** `- 输入参考图：` 这个字段名只有镜头有，
 *    但 `### 首帧提示词` 下面的引用块里也可能出现同样字样（提示词正文写着
 *    「输入参考图：无」）。所以按 `## SHOT-…` 切段，只在段内找。
 *  - **行不存在就不添加。** 缺这一行的文档多半是没写完的分镜；替用户补一行
 *    等于替她写文档。这种情况报出来（`missing`），由界面说清楚。
 *
 * @param text - 原始 Markdown（含可能的 CRLF 或 BOM）。
 * @param updates - 镜号 → 新的行正文（`无（文生视频）。` 这种也算正文）。
 */
export function patchStoryboardReferences(
  text: string,
  updates: ReadonlyMap<string, string>,
): ReferencePatch {
  const hadBom = text.startsWith('\uFEFF')
  const body = hadBom ? text.slice(1) : text
  // 保留原文件的换行风格：混进另一种会让整份文档在 git 里变成全文件 diff。
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const rows = body.split(/\r?\n/)
  const changes: Array<{ shotId: string, before: string, after: string }> = []
  const seen = new Set<string>()
  let current: string | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const heading = shotHeadingOf(row)
    if (heading !== undefined) { current = heading.shotId; continue }
    // 任何别的二级标题都结束当前镜头：`## 场景站位`、`## 整集汇总` 之类。
    if (/^##[ \t]/.test(row)) { current = undefined; continue }
    if (current === undefined) continue
    const wanted = updates.get(current)
    if (wanted === undefined) continue
    const field = fieldOf(row)
    if (field === undefined || field.name !== '输入参考图') continue
    seen.add(current)
    if (field.value === wanted.trim()) continue
    // 只替换值，行首那一段（缩进、空白）原样留着——否则重复回写会让同一行
    // 的空白在两种写法之间来回跳，git 里看起来像改过。
    const colon = row.indexOf('：')
    const lead = row.slice(colon + 1).match(/^[ \t]*/)?.[0] ?? ''
    rows[index] = row.slice(0, colon + 1) + lead + wanted
    changes.push({ shotId: current, before: field.value, after: wanted })
  }
  const missing = [...updates.keys()].filter(shotId => !seen.has(shotId))
  return {
    text: (hadBom ? '\uFEFF' : '') + rows.join(eol),
    changes,
    missing,
  }
}

/** 一次回写的完整计划。 */
export interface DramaWritePlan {
  source: CanvasStoryboardSource
  /** 字节就在画布资产里、直接取来写的文件。 */
  media: DramaWriteFile[]
  /** 要从片子抽帧再写的图。 */
  frames: DramaFrameTask[]
  /** 镜号 → 新的 `输入参考图` 行正文；空表示这次的勾选不需要改文档。 */
  referenceLines: Map<string, string>
  /** 还没跑出片子的镜头。 */
  skipped: Array<{ shotId: string }>
  /** 已生成、可回写的设定板图片节点。 */
  images: DramaWriteFile[]
}

/**
 * 算出一集完整的回写计划。
 *
 * 三组产出，各自独立：
 *
 *  - **片子**：每一镜跑出来的视频 → `制作成果/video/SHOT-….mp4`。
 *  - **设定板图**：铺板时那些 `IMG-…` 节点，跑出了图就 → `制作成果/images/IMG-….png`。
 *  - **起始帧**（可选）：`carry` 板里，把上一镜的尾帧抽成 `images/SHOT-….png`，
 *    登记成下一镜的 `输入参考图`。默认不做：它会改文档里别人的行，而回写的
 *    默认动作应该只有「把做出来的东西记下来」。改写指令是第二件事，得用户
 *    自己勾。
 *
 * @param input.useAsNextFrame - 勾上「把每镜尾帧登记为下一镜起始帧」。
 */
export function planDramaWriteback(input: {
  source: CanvasStoryboardSource
  boardId: string
  board: { shots: readonly CanvasShot[], continuity: 'cut' | 'carry' }
  nodes: readonly CanvasNode[]
  useAsNextFrame: boolean
  /** 起始帧那一条《…》里的名字；缺省用镜号。 */
  frameLabel?: string
}): DramaWritePlan {
  const { source, boardId, board, nodes, useAsNextFrame } = input
  const media: DramaWriteFile[] = []
  const frames: DramaFrameTask[] = []
  const referenceLines = new Map<string, string>()
  const skipped: Array<{ shotId: string }> = []

  for (let index = 0; index < board.shots.length; index += 1) {
    const shot = board.shots[index]!
    const clip = shotClipOf(nodes, boardId, shot)
    if (!clipReady(clip)) { skipped.push({ shotId: shot.id }); continue }
    const clipUrl = clip.metadata!.video!.url
    media.push({
      relativePath: `${outputDirectoryOf(source.projectPath, 'video')}/${outputFileOf({ shotId: shot.id, kind: 'video' })}`,
      nodeId: clip.id,
      kind: 'video',
    })
    // 起始帧：这一镜的尾帧交给下一镜。最后一镜没有下一镜，不抽。
    const next = board.shots[index + 1]
    if (!useAsNextFrame || board.continuity !== 'carry' || next === undefined) continue
    const framePath = `${outputDirectoryOf(source.projectPath, 'image')}/${outputFileOf({ shotId: shot.id, kind: 'image' })}`
    frames.push({ clipUrl, at: 'last', relativePath: framePath, shotId: shot.id })
    const label = input.frameLabel === undefined || input.frameLabel === '' ? shot.id : input.frameLabel
    referenceLines.set(next.id, referenceLineOf([{
      slot: slotOfShot(shot.id),
      order: 1,
      path: framePath,
      name: label,
      purpose: '起始帧',
    }]))
  }

  // 设定板：铺板时由 `IMG-…` 建的图片节点，跑出图了才写。
  const images: DramaWriteFile[] = []
  for (const node of nodes) {
    if (node.type !== 'image') continue
    const imageId = imageIdOfTitle(node.title)
    if (imageId === undefined) continue
    const asset = node.metadata?.asset
    // `assetId === ''` 是铺板留下的空位：还没跑图，没东西可写。
    if (asset === undefined || asset.assetId === '') continue
    images.push({
      relativePath: `${outputDirectoryOf(source.projectPath, 'image')}/${imageId}.png`,
      nodeId: node.id,
      kind: 'image',
    })
  }

  return { source, media, frames, referenceLines, skipped, images }
}

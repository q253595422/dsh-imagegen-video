/**
 * 画布 → 文档回写：宿主侧的字节落盘。
 *
 * 与 `drama-project.ts`（只读）对称：那一半只把字节读出来，这一半只把字节写
 * 回去，两边都不做格式判断。回写要写什么、路径叫什么，全在
 * `client/drama-writeback.ts` 里算好；这里只回答「能不能写、写到哪、写完
 * 之后原文件还在不在」。
 *
 * 安全边界比读侧更严，因为写坏是不可逆的：
 *
 *  - **只在调用方声明的工作区根目录之内。** 与读侧同一条规则。
 *  - **产出只能落在 `剧集/<EP>/制作成果/` 之下。** 不是「根目录内随便写」，
 *    而是「这一集的产出目录内」。用户在根目录里可能有代码仓库、笔记和别的
 *    项目，一个能写任意相对路径的接口等于把它们都摆在误写面前。
 *  - **创作文档只写《分镜.md》，且永远先备份。** 它是 Agent 和用户一起写
 *    的；回写出错时，`.bak-<时间戳>` 是用户唯一能回去的地方。产出文件反过来
 *    默认不覆盖——已经有了就报出来，让用户决定。
 *  - **不跟随符号链接到根目录之外。** 与读侧同样的理由，多一步：先建目录，
 *    再对**目录**取真实路径校验，写的时候用的是那个真实路径。
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DRAMA_DOCUMENTS, safeRelativePath } from './drama-project.ts'

/** 产出目录的固定名字，与上游 adapter 契约一致。 */
export const DRAMA_OUTPUT_DIR = '制作成果'

/** 单张图上限，照抄上游契约。 */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
/** 单条视频上限，照抄上游契约。 */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

/** 允许写的扩展名 → 期望的 MIME 前缀。 */
const MEDIA_BY_EXTENSION: Record<string, { mime: string, max: number }> = {
  '.png': { mime: 'image/png', max: MAX_IMAGE_BYTES },
  '.jpg': { mime: 'image/jpeg', max: MAX_IMAGE_BYTES },
  '.jpeg': { mime: 'image/jpeg', max: MAX_IMAGE_BYTES },
  '.webp': { mime: 'image/webp', max: MAX_IMAGE_BYTES },
  '.mp4': { mime: 'video/mp4', max: MAX_VIDEO_BYTES },
  '.webm': { mime: 'video/webm', max: MAX_VIDEO_BYTES },
  '.mov': { mime: 'video/quicktime', max: MAX_VIDEO_BYTES },
}

/** 一次写入的三种结果，分开是因为界面要说不同的话。 */
export type DramaWriteOutcome =
  | { ok: true, relativePath: string, bytes: number, overwrote: boolean, backup?: string }
  | { ok: false, reason: 'bad-path' | 'outside-project' | 'bad-media' | 'too-large' | 'exists' | 'failed', message: string }

/**
 * 数据 URL 拆成字节与 MIME。
 *
 * 只有「形状不是 data URL」这一种失败，所以回 `undefined` 是明确的一种含义：
 * `Buffer.from(…, 'base64')` 本身不会抛（非法字符会被跳过），空结果由调用方
 * 按 `byteLength === 0` 另行判成「内容是空的」。
 */
export function decodeDataUrl(dataUrl: string): { mime: string, data: Buffer } | undefined {
  const match = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (match === null) return undefined
  return { mime: match[1]!.toLowerCase(), data: Buffer.from(match[2]!, 'base64') }
}

/**
 * 一份项目相对路径的「写入版」解析。
 *
 * 与读侧的 `resolveInside` 不同：目标文件通常**还不存在**（第一次落盘），
 * 所以不能对文件本身 `realpath`。做法是先建父目录，再对父目录取真实路径
 * 校验——父目录是符号链接时，这一步会把它指向的真实位置暴露出来。
 *
 * @returns 可以写入的绝对路径（已确保真实位置在根目录内）；越界时 undefined。
 */
export async function resolveForWrite(root: string, relative: string): Promise<string | undefined> {
  // `root` 自己可能就是一个符号链接目标——macOS 的 `/var` 实际指向
  // `/private/var`，用户从 Finder 拿到的 `/var/folders/…` 与 `realpath` 的
  // 结果一字之差。先前先算字面路径再比 `realpath(root)`，于是每个正常写入
  // 都被判成「越界」。所以**先用真实根目录拼路径**，再做之后的每一步。
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return undefined }
  const absolute = path.resolve(realRoot, relative)
  const literal = path.relative(realRoot, absolute)
  if (literal.startsWith('..') || path.isAbsolute(literal)) return undefined
  const directory = path.dirname(absolute)
  await mkdir(directory, { recursive: true })
  let realDirectory: string
  try { realDirectory = await realpath(directory) } catch { return undefined }
  if (realDirectory !== realRoot && !realDirectory.startsWith(realRoot + path.sep)) return undefined
  return path.join(realDirectory, path.basename(absolute))
}

/**
 * 写一个产出文件。
 *
 * @param input.root - 工作区绝对路径。
 * @param input.projectPath - 剧集目录（相对根），如 `剧集/EP001`。
 * @param input.relativePath - 要写的项目相对路径；必须在
 *   `<projectPath>/制作成果/` 之下。
 * @param input.dataUrl - `data:<mime>;base64,…`。
 * @param input.overwrite - 同名文件已存在时是否覆盖。默认不覆盖：产出是
 *   用户的作品，静默替换会让「重新跑一次」变成「把上一次的成品顶掉」。
 *   覆盖时先把它备份成 `.bak-<时间戳>`。
 */
export async function writeDramaOutput(input: {
  root: string
  projectPath: string
  relativePath: string
  dataUrl: string
  overwrite?: boolean
}): Promise<DramaWriteOutcome> {
  const clean = safeRelativePath(input.relativePath)
  if (clean === undefined) return { ok: false, reason: 'bad-path', message: `路径不合法：${input.relativePath}` }
  const project = input.projectPath === '.' ? '' : safeRelativePath(input.projectPath)
  if (project === undefined) return { ok: false, reason: 'bad-path', message: `剧集目录不合法：${input.projectPath}` }
  const prefix = project === '' || project === '.' ? `${DRAMA_OUTPUT_DIR}/` : `${project}/${DRAMA_OUTPUT_DIR}/`
  if (!clean.startsWith(prefix)) {
    return { ok: false, reason: 'outside-project', message: `只能写进 ${prefix}` }
  }
  const extension = path.extname(clean).toLowerCase()
  const media = MEDIA_BY_EXTENSION[extension]
  if (media === undefined) {
    return { ok: false, reason: 'bad-media', message: `不支持写这种文件：${extension || '（无扩展名）'}` }
  }
  const decoded = decodeDataUrl(input.dataUrl)
  if (decoded === undefined) return { ok: false, reason: 'bad-media', message: '内容不是合法的 data URL。' }
  if (!decoded.mime.startsWith(media.mime)) {
    return { ok: false, reason: 'bad-media', message: `扩展名 ${extension} 与内容 ${decoded.mime} 不一致。` }
  }
  if (decoded.data.byteLength === 0) return { ok: false, reason: 'bad-media', message: '内容是空的。' }
  if (decoded.data.byteLength > media.max) {
    return {
      ok: false,
      reason: 'too-large',
      message: `${Math.round(decoded.data.byteLength / 1024 / 1024)}MB 超过 ${Math.round(media.max / 1024 / 1024)}MB 上限。`,
    }
  }
  const target = await resolveForWrite(input.root, clean)
  if (target === undefined) return { ok: false, reason: 'outside-project', message: '这个位置不在项目目录内：' + clean }

  let existing = false
  try { existing = (await stat(target)).isFile() } catch { existing = false }
  if (existing && input.overwrite !== true) {
    return { ok: false, reason: 'exists', message: `${clean} 已经存在。` }
  }
  try {
    let backup: string | undefined
    if (existing) {
      backup = `${target}.bak-${stamp()}`
      await rename(target, backup)
    }
    // 原子写：先写同目录临时文件再改名，中途失败不会留下半个文件。
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temp, decoded.data)
    await rename(temp, target)
    return {
      ok: true,
      relativePath: clean,
      bytes: decoded.data.byteLength,
      overwrote: existing,
      ...backup === undefined ? {} : { backup: projectRelative(input.root, backup) },
    }
  } catch (error) {
    return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把一个绝对路径说回项目相对路径，只用于回显。
 *
 * WHY 不用 `path.relative(input.root, …)`：`root` 可能是从会话里拿到的字面
 * 路径（macOS 的 `/var/…`），而目标已经过 `realpath`（`/private/var/…`）。
 * 两者一字之差，相对路径就算成 `../../../../..` 那种垃圾，界面上一显示就
 * 像出了大事。先用真实根目录做基准，真相对不出来（跨盘）就不回显。
 */
function projectRelative(root: string, absolute: string): string {
  const bases = [root]
  try { bases.push(realpathSync(root)) } catch { /* 根目录已经不存在时只看字面 */ }
  for (const base of bases) {
    const relative = path.relative(base, absolute)
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  }
  return ''
}

/** 一段可排序、可读的时间戳，用于备份文件名。 */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 写回一份创作文档的结果。 */
export type DramaDocumentOutcome =
  | { ok: true, relativePath: string, bytes: number, backup: string, changed: boolean }
  | { ok: false, reason: 'bad-path' | 'not-found' | 'failed', message: string }

/**
 * 把改好的《分镜.md》写回去。
 *
 * 只认 `分镜.md` 这一个文件名：回写负责的是「镜头的参考图与产出」，别的
 * 创作文档（`剧本.md`、`视觉设定.md`）不属于这条链路，允许写它们等于给了
 * 一个能改用户所有文档的接口。
 *
 * **永远先备份**，没有「覆盖确认」这个选项：内容没变时直接返回
 * `changed: false`，不写盘、不备份——用户点了一次回写但什么都没改，不该在
 * 目录里堆出一份多余的 `.bak`。
 *
 * @param input.expected - 调用方读到的原文。用来发现「读完之后文件被改了」：
 *   不一致就拒绝写，否则会用一份基于旧内容的改写覆盖掉别人刚写的东西。
 */
export async function writeDramaDocument(input: {
  root: string
  projectPath: string
  text: string
  expected?: string
}): Promise<DramaDocumentOutcome> {
  const project = input.projectPath === '.' ? '' : safeRelativePath(input.projectPath)
  if (project === undefined) return { ok: false, reason: 'bad-path', message: `剧集目录不合法：${input.projectPath}` }
  const relative = project === '' || project === '.' ? DRAMA_DOCUMENTS.storyboard : `${project}/${DRAMA_DOCUMENTS.storyboard}`
  const target = await resolveForWrite(input.root, relative)
  if (target === undefined) return { ok: false, reason: 'bad-path', message: `位置不合法：${relative}` }

  let current: string
  try {
    current = await readFile(target, 'utf8')
  } catch {
    return { ok: false, reason: 'not-found', message: `没有找到 ${relative}。` }
  }
  if (current === input.text) {
    return { ok: true, relativePath: relative, bytes: Buffer.byteLength(input.text, 'utf8'), backup: '', changed: false }
  }
  if (input.expected !== undefined && current !== input.expected) {
    return {
      ok: false,
      reason: 'failed',
      message: `${relative} 在回写过程中被改过（可能是 Agent 或编辑器），为免覆盖刚写的内容，这次没有写入。重新读一次再回写。`,
    }
  }
  const backup = `${target}.bak-${stamp()}`
  try {
    await rename(target, backup)
    await writeFile(target, input.text, 'utf8')
    return {
      ok: true,
      relativePath: relative,
      bytes: Buffer.byteLength(input.text, 'utf8'),
      backup: projectRelative(input.root, backup),
      changed: true,
    }
  } catch (error) {
    // 改名成功而写入失败时，把原文件放回去——宁可这次回写失败，也不能
    // 让用户的 分镜.md 消失在一个只有 .bak 的目录里。
    try { await rename(backup, target) } catch { /* 恢复也失败时只能如实报错 */ }
    return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

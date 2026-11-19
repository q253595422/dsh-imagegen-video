/**
 * 读用户的 oh-story 短剧项目：三份 Markdown + 参考图，只读。
 *
 * 为什么这一层在宿主而不在浏览器：浏览器拿不到工作区里的文件字节，而
 * 「把 分镜.md 读成一块板子」所需的全部内容都在磁盘上。宿主读、浏览器解析
 * 是唯一分工——解析逻辑（`client/storyboard-markdown.ts`）留在浏览器侧，
 * 因为它要跟着界面一起演进，宿主不必知道格式。
 *
 * 安全边界，三条都是必须的：
 *
 *  - **只在调用方声明的工作区根目录之内。** 根目录由浏览器从宿主自己的会话
 *    列表里取（`SessionSummary.cwd`），不从这里猜。
 *  - **只读这三份固定文件名，以及它们引用到的、位于 `剧集/` 下的图片。**
 *    不接受任意路径，否则这个路由就是一台「读宿主上任何文件」的机器。
 *  - **不跟随符号链接到根目录之外。** 项目是用户的目录，里面可能有一个指
 *    向 `~/.ssh` 的链接；按真实路径再校验一次才算数。
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DramaProjectDocument, DramaProjectRead } from './protocol.ts'

/** 允许读的三份文档，键是线上字段名。 */
export const DRAMA_DOCUMENTS = {
  storyboard: '分镜.md',
  imagePrompts: '图片提示词.md',
  motionPrompts: '视频提示词.md',
} as const

/** 文档读取的键类型。 */
export type DramaDocumentKey = keyof typeof DRAMA_DOCUMENTS

/** 一份读到的文档：线上形状在 `protocol.ts`，这里只给它一个本地名字。 */
export type DramaDocument = DramaProjectDocument

/** 上限：一份短剧文档不该有几 MB；超出说明读错了目标。 */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

/** 一集最多带多少张参考图（避免一次导入几百张）。 */
const MAX_IMAGES = 120

/** 允许导入的图片扩展名——与 oh-story 的 `REF-` 规范一致。 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/**
 * 把用户给的相对路径收成一个干净的相对路径。
 *
 * 拒绝绝对路径与任何 `..` 段。`path.resolve` 之后再用根目录前缀比对，是
 * 防「`剧集/../../../etc/passwd`」这类输入的常规做法；这里先规范化再比对，
 * 因为 Windows 与 POSIX 的分隔符都可能混进来。
 */
export function safeRelativePath(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (trimmed === '' || trimmed.startsWith('/')) return undefined
  if (/^[A-Za-z]:/.test(trimmed)) return undefined
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return undefined
  if (normalized.includes('\0')) return undefined
  return normalized
}

/**
 * 在根目录下解析一个相对路径，并确认它的真实位置仍在根目录内。
 *
 * 符号链接是这里唯一真正棘手的东西：`剧集/link` 指向 `/etc` 时，前缀比对
 * 通过而实际读的是根目录之外的文件。所以按 `realpath` 再比一次；路径不存在
 * 时（`realpath` 抛错）直接返回 undefined，调用方按「没有这个文件」处理。
 */
async function resolveInside(root: string, relative: string): Promise<string | undefined> {
  try {
    const target = await realpath(path.resolve(root, relative))
    const realRoot = await realpath(root)
    const inside = target === realRoot || target.startsWith(realRoot + path.sep)
    return inside ? target : undefined
  } catch { return undefined }
}

/** 读一份文档；不存在或超限时返回 undefined 并记一条说明。 */
async function readDocument(
  root: string,
  relative: string,
  fileName: string,
  notes: string[],
): Promise<{ text?: string, bytes: number }> {
  const found = await resolveInside(root, relative)
  if (found === undefined) {
    notes.push(`没有找到 ${relative}。`)
    return { bytes: 0 }
  }
  const info = await stat(found)
  if (!info.isFile()) {
    notes.push(`${relative} 不是文件。`)
    return { bytes: 0 }
  }
  if (info.size > MAX_DOCUMENT_BYTES) {
    notes.push(`${relative} 有 ${Math.round(info.size / 1024)}KB，超过 ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB 上限，没有读。`)
    return { bytes: info.size }
  }
  try {
    return { text: await readFile(found, 'utf8'), bytes: info.size }
  } catch (error) {
    notes.push(`${fileName} 读取失败：${error instanceof Error ? error.message : String(error)}`)
    return { bytes: info.size }
  }
}

/**
 * 从一个目录里找出剧集目录。
 *
 * 用户传进来的可能是项目根（含 `剧集/`），也可能是某一集本身。两种都认，
 * 因为两种人都有：有人从项目根打开，有人直接打开 `剧集/EP001`。
 *
 * @returns `projectPath` **已经是剧集目录本身**（如 `剧集/EP001`，根目录本身
 *   就是那一集时为 `.`），调用方直接在里面找文档，**不要再拼一层 episode**。
 *   返回值的形状曾经是「剧集目录 + 集名」两半，调用方拼了一遍就变成
 *   `EP001/EP001/分镜.md`——用户直接选某一集时三份文档全部读不到，而界面
 *   只报「没找到」。别把集名再从 `projectPath` 里拼一次。
 */
export async function findEpisodeDirectory(root: string, requested: string | undefined): Promise<{ projectPath: string, episode: string } | undefined> {
  const candidates: string[] = []
  if (requested !== undefined && requested.trim() !== '') {
    const clean = safeRelativePath(requested)
    if (clean !== undefined) candidates.push(clean)
  }
  candidates.push('.')
  for (const candidate of candidates) {
    const resolved = await resolveInside(root, candidate)
    if (resolved === undefined) continue
    try {
      if (!(await stat(resolved)).isDirectory()) continue
    } catch { continue }
    // 这个目录自己就是某一集：直接含 分镜.md。
    if (await exists(path.join(resolved, DRAMA_DOCUMENTS.storyboard))) {
      return { projectPath: path.posix.normalize(candidate).replace(/^\.\/?/, '') || '.', episode: path.basename(resolved) }
    }    // 这个目录下有 `剧集/<EP>`：取第一集（一集一块板）。
    const direct = await firstEpisodeUnder(resolved, path.posix.normalize(candidate).replace(/^\.\/?/, ''))
    if (direct !== undefined) return direct
    // 这个目录本身就是「剧集」那一层：`剧集/EP001` 被直接选中时，下面直接
    // 就是含《分镜.md》的 EP001，没有第二层「剧集」。卡片文案允许用户选这一层，
    // 所以它也算一个入口。
    const asEpisodes = await firstEpisodeIn(resolved, path.posix.normalize(candidate).replace(/^\.\/?/, ''))
    if (asEpisodes !== undefined) return asEpisodes
    // 工作区通常不是某一部剧，而是「放好几部剧的目录」——`drama/<项目>/剧集/EP001`。
    // 这里只下探一层：再深就是用户自己的目录结构，靠猜不如让他选。
    let children: Array<{ name: string, isDirectory: () => boolean }> = []
    try { children = await readdir(resolved, { withFileTypes: true }) } catch { continue }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name.startsWith('.') || !child.isDirectory()) continue
      const childResolved = await resolveInside(root, `${candidate === '.' ? '' : `${candidate}/`}${child.name}`)
      if (childResolved === undefined) continue
      const nested = await firstEpisodeUnder(childResolved, `${candidate === '.' ? '' : `${candidate}/`}${child.name}`)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 在一个项目目录里找第一集。
 *
 * @param resolved - 已经确认在根目录内的绝对路径。
 * @param base - 同一目录的项目相对路径（`''` 表示根目录本身）。
 */
async function firstEpisodeUnder(resolved: string, base: string): Promise<{ projectPath: string, episode: string } | undefined> {
  const relative = base === '' || base === '.' ? '剧集' : `${base}/剧集`
  return firstEpisodeIn(path.join(resolved, '剧集'), relative)
}

/**
 * 在一个「剧集目录」里找第一集。
 *
 * @param episodesRoot - 装各集的那个目录（项目根下的 `剧集`，或用户直接选中的 `剧集`）。
 * @param relativeRoot - 同一个目录的项目相对路径（如 `剧集`、`短剧/让你管账号/剧集`）。
 *   **由调用方拼好完整前缀**：这里只接一层集名。之前它自己再拼一次「剧集」，
 *   用户直接选「剧集」这一层时就变成了 `剧集/剧集/EP001`，文档全读成空。
 */
async function firstEpisodeIn(episodesRoot: string, relativeRoot: string): Promise<{ projectPath: string, episode: string } | undefined> {
  let entries: string[] = []
  try { entries = await readdir(episodesRoot) } catch { return undefined }
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const episodeDir = path.join(episodesRoot, entry)
    try { if (!(await stat(episodeDir)).isDirectory()) continue } catch { continue }
    if (!(await exists(path.join(episodeDir, DRAMA_DOCUMENTS.storyboard)))) continue
    // 返回的必须已经是剧集目录本身（`剧集/<EP>`）：`readDramaProject` 不再拼
    // 第二层集名。只给「剧集」再加集名也行不通——调用方不知道要不要拼。
    // 前缀为空（用户直接把「剧集」那一层当 root 选）时不能拼成 `/EP001`：
    // 那是绝对路径，会被 `path.resolve(root, …)` 当成根以外的位置。
    const projectPath = relativeRoot === '' || relativeRoot === '.' ? entry : `${relativeRoot}/${entry}`
    return { projectPath, episode: entry }
  }
  return undefined
}

/** 一个路径是否存在且是文件。 */
async function exists(target: string): Promise<boolean> {
  try { return (await stat(target)).isFile() } catch { return false }
}

/**
 * 读一集短剧的全部输入。
 *
 * @param root - 工作区根目录，绝对路径。
 * @param requested - 用户给的项目/剧集相对路径；缺省在根目录下找。
 */
export async function readDramaProject(root: string, requested: string | undefined): Promise<DramaProjectRead | undefined> {
  const found = await findEpisodeDirectory(root, requested)
  if (found === undefined) return undefined
  // `projectPath` 已经是剧集目录本身（`.` 表示根目录就是那一集）：直接用它，
  // **不要再拼集名**。多拼一层会让用户直接选某一集时所有文档都找不到。
  const episodeDir = found.projectPath
  const notes: string[] = []
  const documents: DramaDocument[] = []
  for (const [key, fileName] of Object.entries(DRAMA_DOCUMENTS) as Array<[DramaDocumentKey, string]>) {
    const relative = `${episodeDir}/${fileName}`
    const read = await readDocument(root, relative, fileName, notes)
    documents.push({ key, fileName, relativePath: relative, ...read })
  }
  return {
    projectPath: episodeDir,
    episode: found.episode,
    documents,
    images: await listProjectImages(root, episodeDir, notes),
    notes,
  }
}

/**
 * 列出这一集可能用到的图片。
 *
 * 两个位置：`剧集/<EP>/` 自己（含 `制作成果/` 与 `输入/` 之类的子目录），以及
 * 项目根下的 `输入/`。深度有上限——用户的目录里可能有一整个素材库，把一个
 * 影像库列出来再由浏览器筛，是把「读三个文件」变成一次目录遍历。
 *
 * 返回的是**项目相对路径**，与文档里写的路径同一种写法，浏览器才好对上。
 */
async function listProjectImages(root: string, episodeDir: string, notes: string[]): Promise<Array<{ relativePath: string, bytes: number }>> {
  const out: Array<{ relativePath: string, bytes: number }> = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (out.length >= MAX_IMAGES || depth > 3) return
    const resolved = await resolveInside(root, relative)
    if (resolved === undefined) return
    let entries: Array<{ name: string, isDirectory: () => boolean }> = []
    try { entries = await readdir(resolved, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (out.length >= MAX_IMAGES) return
      if (entry.name.startsWith('.')) continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) { await walk(child, depth + 1); continue }
      if (!IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue
      const target = path.join(resolved, entry.name)
      try {
        const info = await stat(target)
        if (info.isFile()) out.push({ relativePath: child, bytes: info.size })
      } catch { /* 读不到就跳过：一张坏文件不该让整次铺板失败 */ }
    }
  }
  await walk(episodeDir, 0)
  // 项目根下的 `输入/`：oh-story 的约定是把作者给的素材放这里。
  const projectRoot = episodeDir.includes('/') ? episodeDir.slice(0, episodeDir.lastIndexOf('/')) : episodeDir
  const inputDir = projectRoot.includes('/') ? `${projectRoot.slice(0, projectRoot.lastIndexOf('/'))}/输入` : '输入'
  await walk(inputDir, 0)
  if (out.length >= MAX_IMAGES) notes.push(`图片数量达到 ${MAX_IMAGES} 张上限，其余的没有列出。`)
  return out
}

/**
 * 读一张项目内的图片字节。
 *
 * 返回值分得开三种情况：`ok` 是真读到了，`missing` 是路径不合法 / 扩展名不
 * 对 / 文件不在，`failed` 是文件在但读不出来（权限、损坏）。三者分开是因为
 * 调用方要给不同的提示：「这张图不在项目里」和「这张图读坏了」是两件事，
 * 而读坏的图如果被当成不存在，用户会去重拍一张本来好好的图。
 */
export type ProjectImageRead =
  | { ok: true, data: Buffer, mime: string }
  | { ok: false, reason: 'missing' | 'failed', message: string }

export async function readProjectImage(root: string, relative: string): Promise<ProjectImageRead> {
  const clean = safeRelativePath(relative)
  if (clean === undefined) return { ok: false, reason: 'missing', message: `路径不合法：${relative}` }
  if (!IMAGE_EXTENSIONS.includes(path.extname(clean).toLowerCase())) {
    return { ok: false, reason: 'missing', message: `不是支持的图片格式：${path.extname(clean) || '（无扩展名）'}` }
  }
  const resolved = await resolveInside(root, clean)
  if (resolved === undefined) return { ok: false, reason: 'missing', message: `不在项目目录内，或文件不存在：${clean}` }
  try {
    const info = await stat(resolved)
    if (!info.isFile()) return { ok: false, reason: 'missing', message: `不是文件：${clean}` }
    const data = await readFile(resolved)
    const extension = path.extname(clean).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data, mime }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: `读取 ${clean} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

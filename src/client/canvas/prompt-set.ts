/**
 * 套图：一个配置节点上挂一组**带标题的提示词**，跑一次各出一张。
 *
 * ## 它和 `count` 不是一回事
 *
 * `metadata.count` 是「同一条提示词出 N 张」——四张一样的图，用来看哪张更好。
 * 套图是「N 条不同提示词，每条出一张」——正面 / 侧面 / 背面，一次出齐一套。
 * 两者语义相反：前者求**同**，后者求**异**。把它做成 `count` 的扩容，会让两
 * 件事共用一个数字，而那个数字无论填几都会被另一边读错：填 3 是想出三视图，
 * 结果拿到三张一样的正面。
 *
 * 所以它住在自己的字段 `metadata.promptSet` 里，形状是一组有序的
 * `{ id, title, prompt }`。顺序就是出图的顺序（从目标节点下方依次往下排），
 * 标题会落到结果节点的标题上——「正面视图」比「图片节点」有用得多，而批量
 * 出图之后靠缩略图分辨哪张是哪张，是一套图能用起来的前提。
 *
 * ## 为什么在纯函数层
 *
 * 套图有三条边界全都是「看起来对、其实错」：空条目要不要出图、标题重复怎么
 * 办、条目上限截在哪里。这些在组件里各写一遍就会各错一遍，而症状都是「点了
 * 没反应」或「多出一张空白」。收在这里，Node 里直接跑。
 *
 * 不 import React、不碰 DOM、不读字典（标题的兜底文案由调用方给）。
 */

import type { CanvasNode, CanvasPromptSetItem } from '../../protocol.ts'

/**
 * 一次套图最多几条。
 *
 * 12 与技能批量的上限同一条理由：一次提交十几条提示词意味着一轮十几个付费
 * 请求，而用户按下按钮时看到的只是「4 条」这样的读数。上限是刹车，不是功能。
 */
export const MAX_PROMPT_SET_ITEMS = 12

/** 单个条目的标题最长多少字符；超出截断而不是拒绝——用户没做错什么。 */
const MAX_TITLE_CHARS = 24

/**
 * 这张卡上的套图条目，已经过清理：空提示词丢掉、标题补齐、上限截断。
 *
 * 返回**新数组**（每次都是），因为调用方要拿去 map 成任务，而共享一个可变
 * 数组会让「上一次提交的条目」在用户编辑之后还被读到。
 *
 * 空提示词的条目直接丢掉，而不是「跳过但保留」：一条只有标题没有正文的条目
 * 提交出去只会得到一个白跑的任务；而它在界面上仍然占着一行，用户会以为它被
 * 算进了这一套。丢掉之后 `length === 0` 就精确等于「这张卡没有套图」。
 *
 * @param fallbackTitle - 标题为空时的兜底（`{index}` 从 1 起）。由调用方传，
 *   因为这个模块不读字典。
 */
export function promptSetOf(node: CanvasNode, fallbackTitle?: (index: number) => string): CanvasPromptSetItem[] {
  const raw = node.metadata?.promptSet
  if (!Array.isArray(raw)) return []
  const items: CanvasPromptSetItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''
    if (prompt === '') continue
    const at = items.length + 1
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    items.push({
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `prompt-${at}`,
      title: title === '' ? (fallbackTitle === undefined ? '' : fallbackTitle(at)) : title.slice(0, MAX_TITLE_CHARS),
      prompt,
    })
    if (items.length >= MAX_PROMPT_SET_ITEMS) break
  }
  return items
}

/**
 * 一条新套图条目的 id。
 *
 * WHY 不用 crypto.randomUUID：id 只用于 React 列表的 key 与「改哪一条」，不参与
 * 生成——可读的 `prompt-N-seq` 在调试时比一串 hex 有用得多。`seq` 是模块级的单调
 * 计数，同一会话里连续加两条也不会撞 key。
 */
let promptSetSeq = 0
export function newPromptSetId(length: number): string {
  promptSetSeq += 1
  return `prompt-${length + 1}-${promptSetSeq.toString(36)}`
}

/** 这张卡是不是一套套图（有至少一条非空提示词）。 */
export function hasPromptSet(node: CanvasNode): boolean {
  return promptSetOf(node).length > 0
}

/**
 * 把一组条目规整成可写进文档的形状。
 *
 * 与 `promptSetOf` 的分工：这个函数是**写**之前用的（编辑器保存时），它保留
 * 空条目——用户正在打字，一个空行不该在保存的瞬间消失，那会让光标跳走。读的
 * 那一侧（`promptSetOf`）才做丢弃。
 *
 * 标题不做去重：用户可能真的想要两条都叫「细节图」，而自动改名（加序号）会
 * 让他在结果里找不到自己写的那一条。
 */
export function normalizePromptSet(items: readonly CanvasPromptSetItem[]): CanvasPromptSetItem[] {
  return items.slice(0, MAX_PROMPT_SET_ITEMS).map((item, index) => ({
    id: item.id !== '' ? item.id : `prompt-${index + 1}`,
    title: item.title.slice(0, MAX_TITLE_CHARS),
    prompt: item.prompt,
  }))
}

/**
 * 把一组条目折成「这次真的要跑哪几条」。
 *
 * 与 `normalizePromptSet` 的分工是读写两侧：那个保留空条目（用户正在打字），
 * 这个丢掉空条目（空条目提交出去只会白跑一次，还占一行让人以为算进了这一套）。
 *
 * 输入是**草稿**而不是节点：编辑器里正在写的那些条目还没落盘，而按下生成时
 * 要跑的就是它们。直接读节点 metadata 的话，用户刚敲进去的内容不会被执行，
 * 要等他改别的才生效——那是「点了没反应」这类最难查的毛病。
 */
export function promptSetJobsFromItems(items: readonly CanvasPromptSetItem[]): { title: string; prompt: string }[] {
  const jobs: { title: string; prompt: string }[] = []
  for (const item of normalizePromptSet(items)) {
    const prompt = item.prompt.trim()
    if (prompt === '') continue
    const title = item.title.trim()
    jobs.push({ title: title === '' ? item.id : title, prompt })
    if (jobs.length >= MAX_PROMPT_SET_ITEMS) break
  }
  return jobs
}

/**
 * 一次套图提交要跑的任务清单（读节点版）。
 *
 * 每条都带上自己的标题：结果节点的标题就是它。没有标题的条目退到自己的
 * id（prompt-1、prompt-2…）——N 个空白标题一起交出去会变成 N 张同名卡，
 * 而界面上已经标了「第 1 / 2 / 3 条」，退到 id 至少让缩略图还能对上号。
 */
export function promptSetJobs(node: CanvasNode): { title: string; prompt: string }[] {
  return promptSetOf(node).map(item => ({ title: item.title === '' ? item.id : item.title, prompt: item.prompt }))
}

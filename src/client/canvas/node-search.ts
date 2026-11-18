/**
 * 画布上的「找节点」：搜出来，然后跳过去。
 *
 * WHY 是纯函数而不是塞在 `CanvasWorkspace.tsx` 里：这张画布少则五张卡，多则
 * 上百张，用户知道「我要找那张写着『樱花街道』的图」，却得缩到 10% 自己扫。
 * 搜索和跳转是两件能脱离 DOM 讲清楚的事，放进组件只会变成又一个没人敢动的
 * 闭包。这里不 import React、不读字典、不碰 `.tsx`，Node 里直接跑。
 *
 * 两条刻意的取舍：
 *
 * 1. **同一段文字里必须含全部词。** 不跨字段拼，是因为「模型名 + 标题」拼出来
 *    的句子用户从没写过，命中了也解释不清为什么它在结果里。多条命中取字段
 *    优先级最高的那一条，而不是把所有字段拼成一行再搜。
 * 2. **同分按画布顺序，不按 id。** 用户找的是「我刚放的那张」，位置顺序（数组
 *    下标）比随机 id 有信息量；按 id 排会让结果看起来像随机重排过。
 */

import type { CanvasNode } from '../../protocol.ts'

/** 命中落在哪里：决定结果行上把哪一段文字放大显示。 */
export type NodeHitField = 'title' | 'text' | 'prompt' | 'model'

export interface NodeHit {
  nodeId: string
  nodeType: CanvasNode['type']
  /** 命中的那段原文（已按 query 截断到 snippet 长度），用来说明「为什么它会出现在结果里」。 */
  snippet: string
  field: NodeHitField
  /** 越大越靠前。同名同字段时按 `score` 相等，再按画布顺序。 */
  score: number
}

export interface NodeSearchOptions {
  /** 最多返回几条；缺省 20。 */
  limit?: number
  /** snippet 的最大字符数；缺省 60。按 query 首次出现的位置居中截取。 */
  snippetLength?: number
}

const DEFAULT_LIMIT = 20
const DEFAULT_SNIPPET_LENGTH = 60

/**
 * 字段优先级，同时也是「命中要在哪一段里解释」的顺序。
 *
 * 标题排第一：它是一张卡被认出自己的最短方式。`text` 排在 `prompt` 前，因为
 * 配置节点上的 text 是用户自己写的那句，prompt 往往是从上游抄来的同一句话。
 */
const FIELD_ORDER: readonly NodeHitField[] = ['title', 'text', 'prompt', 'model']

/**
 * 按空白切词。全角空格也要切——中文输入法下混进来一个是常事，不切就会变成
 * 一个谁也命中不了的词，用户看到的是「明明写了却没有结果」。
 */
function termsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s\u3000]+/).filter(term => term !== '')
}

/** 字段原文；缺 `metadata`、`null`、非字符串一律当作「没有这一段」。 */
function fieldText(node: CanvasNode, field: NodeHitField): string {
  const raw = field === 'title' ? node.title : node.metadata?.[field]
  return typeof raw === 'string' ? raw : ''
}

/**
 * 居中截到 `cap` 个字符，两侧被切时各加一个 `…`。
 *
 * 上限含省略号本身：调用方要的是「一行放得下」，多出来的两个字符正好会把
 * 结果行挤到折行。原文没超上限时原样返回，连结尾的省略号都不加——那会让
 * 用户以为后面还有字。
 */
function snippetAround(text: string, index: number, matchLength: number, cap: number): string {
  if (text.length <= cap) return text
  // 上限小到装不下「…正文…」时，省略号比正文还占地方：退回从开头截，
  // 至少保证结果行不超宽。
  if (cap < 3) return text.slice(0, cap)
  const center = index + matchLength / 2
  let body = cap
  let start = 0
  // 两侧是否被截断影响可用正文宽度，而宽度又反过来影响起止位置。迭代三次
  // 足够收敛（body 只会变小，不会来回跳）。
  for (let pass = 0; pass < 3; pass += 1) {
    const raw = Math.round(center - body / 2)
    start = Math.max(0, Math.min(raw, text.length - body))
    const cuts = (start > 0 ? 1 : 0) + (start + body < text.length ? 1 : 0)
    const next = Math.max(1, cap - cuts)
    if (next === body) break
    body = next
  }
  const leftCut = start > 0
  const rightCut = start + body < text.length
  return `${leftCut ? '…' : ''}${text.slice(start, start + body)}${rightCut ? '…' : ''}`
}

/**
 * 多词查询在原文里不一定连着（「樱花 街道」会命中「樱花大道旁的街道」）。
 * 整串先找；找不到就取最早出现的那一个词作为居中锚点，至少让用户看到自己
 * 打的第一个词，而不是从头开始的一段无关文字。
 */
function locate(text: string, query: string, terms: readonly string[]): { index: number; length: number } {
  const whole = text.toLowerCase().indexOf(query)
  if (whole >= 0) return { index: whole, length: query.length }
  let best = { index: 0, length: 0 }
  let bestAt = Number.POSITIVE_INFINITY
  for (const term of terms) {
    const at = text.toLowerCase().indexOf(term)
    if (at >= 0 && at < bestAt) {
      bestAt = at
      best = { index: at, length: term.length }
    }
  }
  return best
}

function scoreOf(field: NodeHitField, text: string, query: string): number {
  if (field !== 'title') return 30
  const title = text.toLowerCase()
  if (title === query) return 100
  if (title.startsWith(query)) return 80
  return 60
}

export function searchNodes(nodes: readonly CanvasNode[], query: string, options?: NodeSearchOptions): NodeHit[] {
  const terms = termsOf(query)
  // 空查询返回空，而不是全部：下拉里列出上百张卡等于没有搜索，还会让下一次
  // 输入多等一帧渲染。
  if (terms.length === 0) return []
  const normalized = query.trim().toLowerCase()

  const rawLimit = options?.limit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.max(0, Math.floor(rawLimit))
    : DEFAULT_LIMIT
  if (limit === 0) return []
  const rawSnippet = options?.snippetLength
  const snippetLength = typeof rawSnippet === 'number' && Number.isFinite(rawSnippet)
    ? Math.max(1, Math.floor(rawSnippet))
    : DEFAULT_SNIPPET_LENGTH

  const hits: Array<NodeHit & { index: number }> = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    for (const field of FIELD_ORDER) {
      const text = fieldText(node, field)
      // 空串跳过：`''.includes('')` 恒真，放行会让每个空字段都算命中。
      if (text === '') continue
      const lower = text.toLowerCase()
      if (!terms.every(term => lower.includes(term))) continue
      const { index: at, length } = locate(text, normalized, terms)
      hits.push({
        nodeId: node.id,
        nodeType: node.type,
        snippet: snippetAround(text, at, length, snippetLength),
        field,
        score: scoreOf(field, text, normalized),
        index,
      })
      // 一个节点只出一条结果：标题命中了就不再报它正文里的同一个词，否则搜
      // 「猫」会得到同一张卡的两行，用户还要自己分辨哪行才是那张图。
      break
    }
  }

  hits.sort((a, b) => b.score - a.score || a.index - b.index)
  return hits.slice(0, limit).map(({ index: _index, ...hit }) => hit)
}

/**
 * 把视口对准一个世界矩形。
 *
 * 坐标系与画布一致：`screen = world * k + viewport`。结果居中，意味着视口中心
 * 落在 `rect` 中心上；缩放让 `rect + 四周 padding` 刚好装进视口。
 *
 * 所有返回值都必须是有限数。`NaN` 进到 `.world` 的 `transform` 里，整块画布
 * 会直接消失——用户看到的是空白，而且没有任何报错能告诉他为什么。所以这里
 * 对 0 尺寸视口、0 宽高矩形、非有限输入全部兜底。
 */
export function focusViewport(
  rect: { x: number; y: number; width: number; height: number },
  viewportSize: { width: number; height: number },
  currentScale: number,
  options?: { padding?: number; maxScale?: number; minScale?: number },
): { k: number; x: number; y: number } {
  // 调用约定是「量不出尺寸就什么也别改」：只要 `currentScale` 是个有限数就
  // 原样带回去，判断画布能不能用是调用方的事，这里不替它改缩放。
  const safeCurrent = Number.isFinite(currentScale) ? currentScale : 1
  // 还没量出尺寸时不能相除：0/0 得 NaN，画布会整块消失。
  if (!(viewportSize.width > 0) || !(viewportSize.height > 0)) {
    return { k: safeCurrent, x: 0, y: 0 }
  }

  const rawPadding = options?.padding
  const padding = typeof rawPadding === 'number' && Number.isFinite(rawPadding) ? Math.max(0, rawPadding) : 80
  const rawMax = options?.maxScale
  const rawMin = options?.minScale
  const maxScale = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : 1.6
  const minScale = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 0.1

  // 宽高为 0 的节点（刚放下、还没量出内容）用 1 代替：比例会是几十倍，夹到
  // maxScale 就停，至少不会除零。
  const width = Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 1
  const height = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 1
  const x = Number.isFinite(rect.x) ? rect.x : 0
  const y = Number.isFinite(rect.y) ? rect.y : 0

  const fit = Math.min(
    viewportSize.width / (width + padding * 2),
    viewportSize.height / (height + padding * 2),
  )
  // 闭区间夹取。min > max 这种错配置下以 max 为准——宁可小一点，也不要因为
  // 一次读到坏设置就把画布放到糊掉。
  const k = Math.min(maxScale, Math.max(minScale, fit))
  const centerX = x + width / 2
  const centerY = y + height / 2
  const vx = viewportSize.width / 2 - centerX * k
  const vy = viewportSize.height / 2 - centerY * k

  // 兜底到 0：正常情况下上面每一步都有限，但调用方可能传进一个荒谬的
  // `viewportSize`（Infinity），此时宁可原地不动也要保住「画布还在」。
  return {
    k: Number.isFinite(k) ? k : safeCurrent,
    x: Number.isFinite(vx) ? vx : 0,
    y: Number.isFinite(vy) ? vy : 0,
  }
}

/**
 * 「跳过去」时真正能放卡的高度。
 *
 * 顶栏与底部浮层（小地图 / 缩放下巴 / 任务栏）是浮在画布上的，不算画布的
 * 布局空间，所以要让开它们。但在窄画幅里——展开着对话栏的三栏工作室，或者
 * 一个矮窗口——两条边距加起来能比视口本身还高：实测 722×332 的画布，顶栏
 * 59 px 加底栏 22 px 之后只剩几像素，`focusViewport` 于是把卡塞进那一小块，
 * 比例一路夹到 `MIN_SCALE`，用户搜到卡、按回车，卡变成 16 px 宽的缩略图。
 * 那不是「跳过去」，是把他送丢了。
 *
 * 所以可用高度有个下限：放不下就允许卡片压到浮层底下，至少看得清。下限
 * 取视口的一半（且不少于 160 px），既给浮层留出位置，也保证卡片不是一条线。
 */
export function usableFocusHeight(
  viewportHeight: number,
  topInset: number,
  bottomInset: number,
): number {
  if (!(viewportHeight > 0)) return Math.max(1, viewportHeight)
  const real = viewportHeight - topInset - bottomInset
  const floor = Math.min(viewportHeight, Math.max(160, viewportHeight * 0.5))
  return Math.max(floor, real)
}

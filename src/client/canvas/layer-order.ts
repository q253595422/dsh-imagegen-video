/**
 * 画布的叠放顺序：谁盖住谁。
 *
 * WHY 需要一个独立模块：在加它之前，画布上没有任何「层级」概念。节点的绘制
 * 顺序就是 `document.nodes` 的数组顺序，而那个顺序由「谁先被创建」决定，用户
 * 看不见也改不了。后果有两个，都是画布类工具里的常识性缺陷：
 *
 *  - 后来放上去的卡永远盖住先放的。想在一片图上写个字，字必须在图**之后**
 *    创建；否则它被压在图底下，框选也选不到，看起来像它不存在。
 *  - 被盖住时画布只能描一条黄边说「这张被挡住了」（`geometry.ts` 的
 *    `coveredNodes`），却不能告诉用户「把它拿到前面来」——因为拿不上来。
 *
 * 于是这里只做一件事：给定当前顺序与一组要动的位置，算出新顺序。数组顺序即
 * 绘制顺序，**末尾在最上面**（与 CSS 的 z-index 直觉、与 react-flow 的默认
 * 叠放一致）。选择这条约定而不是另存一个 `z` 字段，有三个理由：
 *
 *  1. 老文档零迁移。数组顺序已经在磁盘上了，加字段要写迁移代码，而迁移一旦
 *     有缺口就是「用户的画布打开后遮挡关系全变」——最难被察觉的一类数据损坏。
 *  2. 不会有「两个节点 z 相同」的并列态。任何时刻只有一条全序，置顶置底都是
 *     明确的，不需要再定一条 tie-break 规则。
 *  3. 撤销栈里的一次层级调整就是一次普通的节点数组变化，不需要第二套快照。
 *
 * 纯函数、不碰 DOM、不 import 任何 `.tsx`：Node 里能直接 import 来验证。
 */

import type { CanvasNode } from '../../protocol.ts'

/** 四个层级动作。前两个是「相对其他人」，后两个是「相对自己当前位置」。 */
export type LayerMode = 'front' | 'back' | 'forward' | 'backward'

/**
 * 一个槽位：要么是「整组选中的卡」（占一位），要么是某一张未选中的卡。
 *
 * WHY 把整组折成一个槽位再移动：选了三张卡做「上移一层」时，它们必须整体
 * 跨过**一个**未选中的卡，否则三张会被打散到三个高度，用户点一次按钮看到的
 * 是「这三张不像一个组了」。折成槽位之后，「上移一层」就是一个数组里的相邻
 * 交换——正确性一眼可见，也不需要在散落的下标之间做算术。
 */
type Slot = 'group' | CanvasNode

/**
 * 把选中的节点移到最上面 / 最下面 / 上移一层 / 下移一层。
 *
 * ## 为什么整组一次性重排，而不是逐个 `splice`
 *
 * 选了三张卡做「置顶」时，它们之间的相对顺序必须保持：用户摆出来的前后关系
 * 是他自己的决定，置顶只该改变它们与**未选中**那些卡的关系。逐个 `splice`
 * 会把 a、b、c 变成 c、b、a（每次插到末尾），三张卡换了叠放次序而用户没有
 * 要求过——这种错只有在一张压着一张、又刚好有透明区域时看得出来。
 *
 * ## 返回值
 *
 * 返回新的节点数组（每一项都来自入参，不复制节点），以及实际上有没有变化。
 * `moved === false` 时调用方不该写文档——最上面那张再置顶一次，撤销栈里不该
 * 多出一条什么都没改的步骤。
 *
 * @param nodes - 当前节点数组，末尾在最上面。
 * @param selectedIds - 要移动的节点。
 * @param mode - 四个方向之一。
 * @returns 新顺序（或原顺序），以及是否真的变了。
 */
export function reorderLayers(
  nodes: readonly CanvasNode[],
  selectedIds: ReadonlySet<string>,
  mode: LayerMode,
): { nodes: readonly CanvasNode[]; moved: boolean } {
  const unchanged = { nodes, moved: false }
  if (nodes.length < 2) return unchanged

  const chosen = nodes.filter(node => selectedIds.has(node.id))
  // 没选中任何东西、或全都选中了：四个动作都是空操作。全选时没有「其他人」
  // 可以跨过——「上移」无处可去，「置顶」本来就已经覆盖整块。
  if (chosen.length === 0 || chosen.length === nodes.length) return unchanged

  const slots: Slot[] = []
  let placed = false
  for (const node of nodes) {
    if (selectedIds.has(node.id)) {
      // 整组只占一个槽位，位置取它出现的第一处。
      if (!placed) { slots.push('group'); placed = true }
    } else {
      slots.push(node)
    }
  }

  const at = slots.indexOf('group')
  if (mode === 'front') {
    slots.splice(at, 1)
    slots.push('group')
  } else if (mode === 'back') {
    slots.splice(at, 1)
    slots.unshift('group')
  } else if (mode === 'forward') {
    // 已经在最上面时无路可走：这时的「上移一层」若强行重排，会把整组压缩到
    // 与原来一样的位置却标成「变了」，撤销栈里就多一条空步骤。
    if (at === slots.length - 1) return unchanged
    const [moving] = slots.splice(at, 1)
    slots.splice(at + 1, 0, moving!)
  } else {
    if (at === 0) return unchanged
    const [moving] = slots.splice(at, 1)
    slots.splice(at - 1, 0, moving!)
  }

  const next: CanvasNode[] = []
  for (const slot of slots) {
    if (slot === 'group') next.push(...chosen)
    else next.push(slot)
  }

  // 逐项比较 id 而不是只比长度：置顶一张已经在最上面的卡时长度与内容都没变，
  // 而它正是「按了没反应、也不该留一条撤销」的那种。比 id 不比对象引用，
  // 因为调用方可能刚换了新对象而顺序没变。
  const moved = next.some((node, index) => node.id !== nodes[index]!.id)
  return moved ? { nodes: next, moved } : unchanged
}

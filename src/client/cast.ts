/**
 * 身份锚定：把「这个人是这个人」从每次重述提示词变成画布上的一次定义。
 *
 * 一段片子拍到第二个镜头，最容易散掉的就是脸：每次生成都是新的采样，提示
 * 词写得再细，模型也不会记住上一张。可用的办法只有一个——把定义好的那张图
 * 作为参考图一起送进去。
 *
 * 所以这里不做「角色库」，也不新增节点类型：被钉住的就是画布上那张已经生
 * 成好的图片节点，`metadata.cast` 是它身上的一枚标记。改脸只需重拍那个节
 * 点，所有后续生成自动跟着变。
 *
 * 纯函数，不碰 DOM、不碰上传：选谁进参考图、提示词里怎么称呼它们，规则都
 * 在这里，能离线测。
 */

import type { CanvasCastRole, CanvasNode } from '../protocol.ts'

/** 画布上被钉住的一个身份参考。 */
export interface CastMember {
  nodeId: string
  /** 提示词里用的称呼：用户填的名字优先，否则节点标题。 */
  name: string
  role: CanvasCastRole
}

/** 角色 → 中文/英文都不影响的一句话由调用方翻译；这里只给规则用的键。 */
const ROLES: readonly CanvasCastRole[] = ['character', 'item', 'style']

/** 面板里角色下拉的顺序；与 {@link ROLE_LABELS} 一一对应。 */
export const ROLE_ORDER: readonly CanvasCastRole[] = ROLES

/** 角色到文案键的映射，只此一份：面板、角标、提示都要说同一个词。 */
export const ROLE_LABELS: Record<CanvasCastRole, 'canvas.cast.roleCharacter' | 'canvas.cast.roleItem' | 'canvas.cast.roleStyle'> = {
  character: 'canvas.cast.roleCharacter',
  item: 'canvas.cast.roleItem',
  style: 'canvas.cast.roleStyle',
}

export function isCastRole(value: unknown): value is CanvasCastRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * 画布上所有可用的身份参考。
 *
 * 三条排除规则，每条都对应一次真实的误用：
 *  - 没有成图（空占位、还在生成、失败）的节点送不进去，参考图必须是字节；
 *  - `url` 为空同理——占位节点也有 asset 字段，只是没有内容；
 *  - 名字为空的节点仍然算数：称呼退化成「参考图 1」，总比默默丢掉用户钉过
 *    的节点好——那会让人以为锚定坏了。
 */
export function castMembers(nodes: readonly CanvasNode[]): CastMember[] {
  const out: CastMember[] = []
  for (const node of nodes) {
    if (node.type !== 'image') continue
    const cast = node.metadata?.cast
    if (cast === undefined) continue
    if ((node.metadata?.asset?.url ?? '') === '') continue
    const named = (cast.name ?? '').trim()
    const title = node.title.trim()
    out.push({ nodeId: node.id, name: named !== '' ? named : title, role: cast.role })
  }
  return out
}

/**
 * 这次生成要额外带上的身份参考。
 *
 * `already` 是调用方已经选进参考图的那批节点（上游连线来的）。同一个节点
 * 既被连线又被钉住时只送一次：多送一张同样的图既浪费参考图名额，也会让某
 * 些提供方把它当成两个不同的主体。
 */
export function castReferenceIds(members: readonly CastMember[], already: readonly string[]): string[] {
  const seen = new Set(already)
  const names = new Set<string>()
  const out: string[] = []
  for (const member of members) {
    if (seen.has(member.nodeId)) continue
    // 同一个名字只送第一个：两个「阿禾」同时进参考图，模型只会左右为难。
    if (member.name !== '' && names.has(member.name)) continue
    seen.add(member.nodeId)
    if (member.name !== '') names.add(member.name)
    out.push(member.nodeId)
  }
  return out
}

/**
 * 角色对应的文案键；由调用方把名字与序号填进模板。
 *
 * 放在这里而不是散在调用处，是因为「角色 → 称呼」的映射只有这一份：提示
 * 词、角标、钉住后的提示都必须说同一个词。
 */
export function castPromptKey(role: CanvasCastRole): 'canvas.cast.promptCharacter' | 'canvas.cast.promptItem' | 'canvas.cast.promptStyle' {
  if (role === 'item') return 'canvas.cast.promptItem'
  if (role === 'style') return 'canvas.cast.promptStyle'
  return 'canvas.cast.promptCharacter'
}

/**
 * 提示词里补的一句身份说明。
 *
 * 只补「谁在参考图里」这件事，不补外观描述——外观由那张图负责，写进提示
 * 词的描述越多，和参考图打架的机会越大。
 *
 * @param members - 本次实际送进参考图的成员。
 * @param line - 把一条成员翻成一句话；由调用方提供，因为文案要跟界面语言走。
 */
export function castPromptLines(
  members: readonly CastMember[],
  line: (member: CastMember, index: number) => string,
): string[] {
  const named: CastMember[] = []
  for (const member of members) {
    if (named.some(item => item.name === member.name && member.name !== '')) continue
    named.push(member)
  }
  return named.map((member, index) => line(member, index))
}

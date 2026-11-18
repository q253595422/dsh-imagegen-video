/**
 * 配置节点的「能不能跑」判定。
 *
 * WHY 单独一个纯函数：画布上真正会让一次运行白跑的不是按钮长得不好看，而是
 * 点了「运行工作流」之后才发现某个节点缺提示词、或者模型那一路的渠道根本没
 * 连上。这两件事在 `submitComposer` / `runWorkflowNode` 里各有一份守卫，但
 * 它们都是**提交之后**才说话——那时用户已经在等结果了。
 *
 * 判定要能出现在卡片上，就必须先能脱离 React 被算出来、被单测钉住边界。
 * 所以这里只做「给定这些输入，缺什么」这一件事，不 import 任何 UI。
 *
 * 与提交路径的关系：这是**预告**，不是许可。判定说 ready 不代表提交一定会
 * 成功（网络、额度、上游模型下线都在后面），判定说缺东西时提交路径也一定会
 * 拦住。两边读同一组事实，但不共享代码——UI 层多一个 import 就多一条会被
 * 打包进 client 的依赖，而这里要的只是六个布尔和字符串。
 */

import type { CanvasConnection, CanvasNode } from '../../protocol.ts'

/** 会挡住一次生成的东西。顺序即「用户最该先解决哪一个」。 */
export type ConfigBlocker = 'prompt' | 'model' | 'channel'

export interface ConfigReadinessInput {
  /** 节点自己的提示词（生成配置节点把用户输入存在 `metadata.text`）。 */
  ownText: string
  /**
   * 悬浮生成器里正在编辑的提示词 —— 只对「当前选中的那张配置节点」非空。
   *
   * WHY 要单独一项而不是并进 `ownText`：两处的写入时机不同。生成器是活动
   * 编辑框（改了立刻生效但关掉选区就没了），`metadata.text` 是落在文档里的
   * 持久值。提交路径读的就是「活动编辑 → 持久值 → 上游」，卡片必须读同一
   * 顺序，否则会出现「卡片说缺提示词，而按下去照样生成」。
   */
  composerText: string
  /** 上游文本节点里非空的那些。 */
  upstreamTexts: readonly string[]
  /** 已经解析出来的模型 id；空串表示一个都没选上。 */
  model: string
  /** 该模型所在渠道是否已连接。 */
  channelConnected: boolean
  /** 走本地代码渲染（`renderer: 'code'`）时不需要模型与渠道。 */
  codeRenderer: boolean
  /** 上游图片节点数；只用于「有没有参考图」这条提示，不构成阻塞。 */
  referenceCount: number
}

export interface ConfigReadiness {
  /** 三个阻塞项都清了。 */
  ready: boolean
  blockers: ConfigBlocker[]
  /** 实际会被当成提示词用的那段文字（自己的优先，否则拼上游）。 */
  prompt: string
  /** 有参考图 —— 决定文案说「文生图」还是「图生图」。 */
  hasReference: boolean
}

export function configReadiness(input: ConfigReadinessInput): ConfigReadiness {
  const composer = input.composerText.trim()
  const own = input.ownText.trim()
  const upstream = input.upstreamTexts.map(text => text.trim()).filter(text => text !== '')
  // 与 `submitComposer` 完全一致的取值顺序：活动编辑 → 节点持久值 → 上游文本。
  // 两边顺序不同的话，卡片说「可以生成」而提交时说「请输入生成描述」——那种
  // 自相矛盾比没有预告更糟。
  const prompt = composer !== '' ? composer : own !== '' ? own : upstream.join('\n')

  const blockers: ConfigBlocker[] = []
  if (prompt === '') blockers.push('prompt')
  if (!input.codeRenderer) {
    // 模型与渠道分开报：一个是「这家没有可用模型」，另一个是「模型选好了但
    // 那把钥匙没填」。合成一句「无法生成」会让人去翻设置却不知道翻哪一页。
    if (input.model === '') blockers.push('model')
    else if (!input.channelConnected) blockers.push('channel')
  }

  return {
    ready: blockers.length === 0,
    blockers,
    prompt,
    hasReference: input.referenceCount > 0,
  }
}

/**
 * 一次工作流里所有配置节点的就绪情况汇总。
 *
 * 给「运行工作流」按钮用：还有节点没准备好时，按钮的提示应当说清楚差什么，
 * 而不是等用户按下去、跑了一半才发现。
 */
export function summarizeReadiness(items: readonly ConfigReadiness[]): { ready: number; blocked: number; first: ConfigBlocker | null } {
  const blocked = items.filter(item => !item.ready).length
  const first = items.find(item => !item.ready)?.blockers[0] ?? null
  return { ready: items.length - blocked, blocked, first }
}

/**
 * 一张画布上每个配置节点缺什么。
 *
 * WHY 要一个「扫全图」的入口：卡片上的徽标只回答「我这张能不能跑」，而用户按下
 * 「运行工作流」时问的是**另一个**问题——「这整条链会不会跑到一半停下来」。
 * 两个问题用同一个判定函数，但调用点不同，所以判定必须能脱开单张卡片算。
 *
 * 上游文本、参考图的取法与 `node-body.tsx` 完全一致（这几行是那套语义的唯一
 * 定义，两边各写一份必然分叉）：
 *   - 上游**文本节点**的文字进提示词；标注卡（挂在图片上的小卡片）不算——
 *     它们是给模型看某个局部用的，混进提示词会变成一句莫名其妙的注释。
 *   - 上游**图片节点**且真有 asset 的，算参考图（决定文案说图生图还是文生图）。
 *   - 已经连进这个节点的连线才算上游，没连的一律不猜。
 *
 * @param nodes - 画布全部节点。
 * @param connections - 画布全部连线。
 * @param ctx - 调用方知道、而这里不该知道的三件事：当前活动编辑框里的文字、
 *   某个节点的模型怎么解析、某个渠道是否已配置。把这些做成函数而不是值，
 *   是因为「哪张节点被选中」在事件发生时才确定。
 */
export function scanConfigReadiness(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  ctx: {
    /** 只有当前选中的那张配置节点会有活动编辑框，其余传空串。 */
    composerTextFor: (nodeId: string) => string
    /** 节点 metadata → 实际会被用的模型 id（空串 = 一个都没选上）。 */
    modelFor: (node: CanvasNode) => string
    /** 渠道是否已配置密钥。 */
    channelConnected: (channelId: string) => boolean
  },
): Map<string, ConfigReadiness> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const upstreamOf = new Map<string, CanvasNode[]>()
  for (const connection of connections) {
    const source = byId.get(connection.fromNodeId)
    if (source === undefined) continue
    const list = upstreamOf.get(connection.toNodeId)
    if (list === undefined) upstreamOf.set(connection.toNodeId, [source])
    else list.push(source)
  }

  const result = new Map<string, ConfigReadiness>()
  for (const node of nodes) {
    if (node.type !== 'config') continue
    const metadata = node.metadata ?? {}
    const upstream = upstreamOf.get(node.id) ?? []
    const codeRenderer = metadata.renderer === 'code'
    result.set(node.id, configReadiness({
      ownText: metadata.text ?? '',
      composerText: ctx.composerTextFor(node.id),
      upstreamTexts: upstream
        .filter(candidate => candidate.type === 'text' && candidate.metadata?.annotation === undefined)
        .map(candidate => candidate.metadata?.text ?? ''),
      model: codeRenderer ? '' : ctx.modelFor(node),
      channelConnected: codeRenderer ? true : ctx.channelConnected(metadata.channelId ?? ''),
      codeRenderer,
      referenceCount: upstream.filter(candidate => candidate.type === 'image' && (candidate.metadata?.asset?.url ?? '') !== '').length,
    }))
  }
  return result
}

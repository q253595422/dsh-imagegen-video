/**
 * 空画布上的「载入示例」：构造一条「文本节点 → 配置节点」的最小可跑链。
 *
 * WHY 这个模块不读字典：它只返回**数据**，所有文案由调用方翻译好传进来。
 * 两个原因——其一，它要能被 Node 直接 import 跑单测（字典模块依赖运行时语
 * 言状态，一进来就拖进 React 环境，脚本里加载不了）；其二，文案归三语表管，
 * 这里再留一份默认中文，等于给同一句话造了第二个来源，改文案时必漏一处。
 *
 * 几何只有一条约定：配置节点左上角就是 `origin`，与画布其它「新建节点」的
 * 语义一致；文本节点摆在它左边，水平间距取整理画布同一档 `ARRANGE_GAP.x`，
 * 两节点的中心线对齐——看起来是同一条流程的两步，而不是两张碰巧靠近的卡。
 *
 * 纯数据：不碰 React、不碰 DOM、不发请求。
 */

import type { CanvasConnection, CanvasNode } from '../../protocol.ts'
import { ARRANGE_GAP } from './arrange-model.ts'
import { CONFIG_NODE_SIZE, TEXT_NODE_SIZE } from './constants.ts'

export interface ExampleFlowInput {
  /** 示例提示词正文。由调用方翻译好传进来——这个模块不读字典。 */
  prompt: string
  /** 文本节点标题、配置节点标题。同上，调用方翻译。 */
  textTitle: string
  configTitle: string
  /** 这条链的锚点：配置节点**左上角**落在这里（与画布其它新建动作的语义一致）。 */
  origin: { x: number; y: number }
  /** id 生成器，调用方传 `newId`。用来保证与画布现有 id 规则一致。 */
  newId: (kind: 'node' | 'edge') => string
}

export interface ExampleFlow {
  nodes: [CanvasNode, CanvasNode]
  connections: [CanvasConnection]
  /** 落完后应该选中的那个节点（配置节点）——用户接着就能在底部生成器里按生成。 */
  focusNodeId: string
}

/**
 * 造出示例链。纯函数：同样的 origin 与同样的 id 序列得到同样的结构。
 *
 * id 一律走调用方的 `newId`，不在这里拼：画布上所有节点/连线的 id 都出自
 * 同一家工厂，自己造一套前缀迟早会和粘贴、导入那条路径撞车。
 */
export function exampleFlow(input: ExampleFlowInput): ExampleFlow {
  const { prompt, textTitle, configTitle, origin, newId } = input

  const textId = newId('node')
  const configId = newId('node')
  const edgeId = newId('edge')

  // 垂直居中：两个节点的高度差取一半。这里刻意不取整——取整会把「中心线
  // 严格相等」变成「高度差是偶数时才相等」，以后谁调了尺寸就会悄悄歪半个
  // 像素；世界坐标本来就可以是小数，没必要为了好看牺牲对齐。
  const textOffsetY = (CONFIG_NODE_SIZE.height - TEXT_NODE_SIZE.height) / 2

  const textNode: CanvasNode = {
    id: textId,
    type: 'text',
    title: textTitle,
    // 从配置节点左边缘往回退「一个列间距 + 自身宽度」：两个节点的外框之间
    // 正好留出 ARRANGE_GAP.x，和整理画布排出来的列间距是同一个数。
    x: origin.x - ARRANGE_GAP.x - TEXT_NODE_SIZE.width,
    y: origin.y + textOffsetY,
    width: TEXT_NODE_SIZE.width,
    height: TEXT_NODE_SIZE.height,
    metadata: { text: prompt, fontSize: 14 },
  }

  const configNode: CanvasNode = {
    id: configId,
    type: 'config',
    title: configTitle,
    // 锚点语义：左上角精确落在 origin 上，不做居中换算。
    x: origin.x,
    y: origin.y,
    width: CONFIG_NODE_SIZE.width,
    height: CONFIG_NODE_SIZE.height,
    // 只要 idle + image：这是「点一下就能生成」的示例，不该先让用户去选模式。
    metadata: { status: 'idle', mode: 'image' },
  }

  // 不写 role：缺省即 input，与手拉的普通连线完全一致。写上 'input' 反而
  // 会给以后比对文档的代码多一个「这两种写法是不是不同」的分叉。
  const connection: CanvasConnection = {
    id: edgeId,
    fromNodeId: textId,
    toNodeId: configId,
  }

  return {
    nodes: [textNode, configNode],
    connections: [connection],
    // 焦点给下游配置节点：示例的下一步动作是「按生成」，而生成器读的是配置
    // 节点。选中文本节点只会把人带回编辑提示词，不是这条链的终点。
    focusNodeId: configId,
  }
}

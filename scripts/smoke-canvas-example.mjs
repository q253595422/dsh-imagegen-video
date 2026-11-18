/**
 * 「载入示例」这条链的纯数据契约。
 *
 * WHY 单独一个套件：这条链是空画布的第一次上手体验，它一旦偏了几像素或
 * 少连一根线，用户看到的就不是「示例」而是「一张跑不通的图」，却不会有人
 * 报错——画布只是安静地不生成。这里盯的是几何与 metadata 这种肉眼难看出的
 * 偏差：列间距要等于整理画布那一档、中心线要严格齐、左上角要精确落在锚点。
 *
 * 不测 UI：本模块不碰 React，所以脚本能直接在 Node 里 import `.ts`。
 *
 * Run: node scripts/smoke-canvas-example.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { exampleFlow } from '../src/client/canvas/example-flow.ts'
import { ARRANGE_GAP } from '../src/client/canvas/arrange-model.ts'
import { CONFIG_NODE_SIZE, TEXT_NODE_SIZE } from '../src/client/canvas/constants.ts'

/** 同一工厂形状的递增 id：真实的 `newId` 带随机 UUID，这里只要可控的顺序。 */
const counterFactory = () => {
  let next = 0
  return kind => `${kind}-${next++}`
}

const baseInput = (overrides = {}) => ({
  prompt: '一只橘猫坐在窗台上，午后逆光，浅景深',
  textTitle: '提示词',
  configTitle: '生成图片',
  origin: { x: 400, y: 300 },
  newId: counterFactory(),
  ...overrides,
})

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// --------------------------------------------------------------- 结构与连线

check('E1 两个节点类型正确、id 互不相同，连线从文本节点指向配置节点', () => {
  const flow = exampleFlow(baseInput())
  const [text, config] = flow.nodes

  assert.equal(text.type, 'text', `左边应是文本节点，实际是 ${text.type}`)
  assert.equal(config.type, 'config', `右边应是配置节点，实际是 ${config.type}`)
  assert.notEqual(text.id, config.id, '两个节点拿到了同一个 id：再插入画布会互相覆盖')
  assert.equal(flow.connections.length, 1, `示例链应恰好一根连线，实际 ${flow.connections.length} 根`)

  const [connection] = flow.connections
  assert.notEqual(connection.id, text.id, '连线 id 与文本节点 id 相同')
  assert.notEqual(connection.id, config.id, '连线 id 与配置节点 id 相同')
  assert.equal(connection.fromNodeId, text.id, '连线的起点不是文本节点——方向和用户理解的「提示词喂给生成」相反')
  assert.equal(connection.toNodeId, config.id, '连线的终点不是配置节点，生成时读不到这段提示词')
  assert.equal(connection.role, undefined, `连线带了 role=${connection.role}，示例应是默认输入`)
})

// ------------------------------------------------------------------- 几何

check('E2 水平间距精确等于 ARRANGE_GAP.x，两节点中心线 y 相同', () => {
  const flow = exampleFlow(baseInput())
  const [text, config] = flow.nodes
  const gap = config.x - (text.x + text.width)

  assert.equal(gap, ARRANGE_GAP.x, `两节点之间实际隔了 ${gap}px，应为 ${ARRANGE_GAP.x}px（与整理画布同档）`)
  const textCenterY = text.y + text.height / 2
  const configCenterY = config.y + config.height / 2
  assert.equal(textCenterY, configCenterY, `中心线没对齐：文本 ${textCenterY} / 配置 ${configCenterY}`)
})

check('E3 配置节点左上角精确等于 origin（含负坐标）', () => {
  for (const origin of [{ x: 400, y: 300 }, { x: -120, y: -64 }, { x: 0, y: 0 }]) {
    const flow = exampleFlow(baseInput({ origin }))
    const config = flow.nodes[1]
    assert.equal(config.x, origin.x, `origin.x=${origin.x} 时配置节点 x 落在 ${config.x}`)
    assert.equal(config.y, origin.y, `origin.y=${origin.y} 时配置节点 y 落在 ${config.y}`)
    assert.ok(Number.isInteger(config.x) && Number.isInteger(config.y), `配置节点坐标不是整数：(${config.x}, ${config.y})`)
  }
})

check('E4 两个节点不重叠，且横向空气恰好是 ARRANGE_GAP.x（尺寸取真实常量）', () => {
  // 用真实尺寸走一遍：文本 280×150、配置 320×190。间距检查同时排除了
  // 「x 算对了但宽度写成了别的常量」这种偏差。
  const flow = exampleFlow(baseInput({ origin: { x: -300, y: -200 } }))
  const [text, config] = flow.nodes

  assert.equal(text.width, TEXT_NODE_SIZE.width, `文本节点宽度 ${text.width}，应取 TEXT_NODE_SIZE`)
  assert.equal(text.height, TEXT_NODE_SIZE.height, `文本节点高度 ${text.height}，应取 TEXT_NODE_SIZE`)
  assert.equal(config.width, CONFIG_NODE_SIZE.width, `配置节点宽度 ${config.width}，应取 CONFIG_NODE_SIZE`)
  assert.equal(config.height, CONFIG_NODE_SIZE.height, `配置节点高度 ${config.height}，应取 CONFIG_NODE_SIZE`)

  const overlapX = Math.min(text.x + text.width, config.x + config.width) - Math.max(text.x, config.x)
  const overlapY = Math.min(text.y + text.height, config.y + config.height) - Math.max(text.y, config.y)
  assert.ok(overlapX < 0 || overlapY < 0, `两个节点重叠：横向重叠 ${overlapX}px、纵向重叠 ${overlapY}px`)
  // 纵向有交集（真实尺寸下一定会）时，横向不重叠就等于右边缘到左边缘的距离。
  assert.equal(-overlapX, ARRANGE_GAP.x, `两节点横向实际空出 ${-overlapX}px，应为 ${ARRANGE_GAP.x}px`)
})

// ---------------------------------------------------------------- metadata

check('E5 文本节点字号为 14，prompt 原样写进 metadata.text', () => {
  const prompt = '  首尾有空格，中间有\n换行，不要 trim 也不要改写  '
  const flow = exampleFlow(baseInput({ prompt }))
  const text = flow.nodes[0]

  assert.equal(text.metadata?.fontSize, 14, `文本节点字号 ${text.metadata?.fontSize}，新建文本节点一律 14`)
  assert.equal(text.metadata?.text, prompt, 'metadata.text 被裁剪或改写了，用户传进来的正文必须原样落盘')
})

check('E6 配置节点 mode 为 image、status 为 idle', () => {
  const config = exampleFlow(baseInput()).nodes[1]

  assert.equal(config.metadata?.mode, 'image', `配置节点 mode=${config.metadata?.mode}，示例应直接处于图片模式`)
  assert.equal(config.metadata?.status, 'idle', `配置节点 status=${config.metadata?.status}，示例应是可立即生成的 idle`)
})

check('E7 focusNodeId 指向配置节点', () => {
  const flow = exampleFlow(baseInput())
  const [, config] = flow.nodes

  assert.equal(flow.focusNodeId, config.id, '落完后选中的不是配置节点——用户还得自己点一下才能按生成')
})

// ------------------------------------------------------------- 可复现性

check('E8 同一 origin、同一 id 序列连调两次得到逐字节相同的结构', () => {
  const run = () => exampleFlow(baseInput({ origin: { x: 128, y: 96 }, newId: counterFactory() }))
  const first = JSON.stringify(run())
  const second = JSON.stringify(run())

  assert.equal(first, second, `两次构造的结果不同：\n第一次 ${first}\n第二次 ${second}`)
})

// ------------------------------------------------------------------- 驱动

let passed = 0
let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
    passed += 1
  } catch (error) {
    results.push(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}
console.log(results.join('\n'))
if (failed > 0) {
  console.error(`\ncanvas example flow: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas example flow: ${passed} passed`)

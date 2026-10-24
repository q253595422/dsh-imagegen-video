/**
 * 工作流执行器的离线验证：图分层、下游闭包、层内并行、失败只停下游、缓存复用。
 *
 * 只跑纯函数与执行循环，不碰网络、不碰画布状态，所以它能进 `pnpm test` 的
 * 离线套件。
 */

import assert from 'node:assert/strict'
import { downstreamClosure, planLayers, planWorkflow, upstreamClosure } from '../src/client/workflow-graph.ts'
import { runWorkflow } from '../src/client/workflow-runner.ts'

const nodes = ['text', 'img', 'vid', 'vid2', 'compose', 'lonely']
const edges = [
  { fromNodeId: 'text', toNodeId: 'img' },
  { fromNodeId: 'img', toNodeId: 'vid' },
  { fromNodeId: 'text', toNodeId: 'vid' },
  { fromNodeId: 'vid', toNodeId: 'compose' },
  { fromNodeId: 'vid2', toNodeId: 'compose' },
]

// ---------------------------------------------------------------- 下游闭包

// 只往下游走：从 img 出发不能回头碰到 text，必须包含整条下游。
assert.deepEqual(
  downstreamClosure(['img'], nodes, edges),
  ['img', 'vid', 'compose'],
  '下游闭包应包含 img → vid → compose，且不含上游 text',
)

// 起点不在画布上不报错，返回空。
assert.deepEqual(downstreamClosure(['missing'], nodes, edges), [], '未知起点应得到空闭包')

// 闭环（节点连回自己）不该让遍历卡住。
assert.deepEqual(
  downstreamClosure(['a'], ['a', 'b'], [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'b' }]),
  ['a', 'b'],
  '自环不应让遍历无限循环',
)

// 上游闭包只沿连线反方向走：下游的分支不能被当成「输入」。
assert.deepEqual(
  upstreamClosure(['compose'], nodes, edges),
  ['text', 'img', 'vid', 'vid2', 'compose'],
  '上游闭包应包含 compose 的全部输入侧节点，且不含无关节点',
)

// ------------------------------------------------------------------ 分层

{
  const plan = planLayers(nodes, edges)
  assert.deepEqual(plan.cycle, [], '无环图不该报环')
  // text 没有依赖；img 与 vid2 只依赖已完成节点，可以与 img 同层。
  assert.deepEqual(plan.layers[0], ['text', 'vid2', 'lonely'], '第一层应是没有依赖的节点')
  assert.deepEqual(plan.layers[1], ['img'], 'img 依赖 text')
  assert.deepEqual(plan.layers[2], ['vid'], 'vid 依赖 img 与 text')
  assert.deepEqual(plan.layers[3], ['compose'], 'compose 依赖 vid 与 vid2')
}

// 重复连线只算一次依赖，不能把层数撑错。
{
  const plan = planLayers(['a', 'b'], [
    { fromNodeId: 'a', toNodeId: 'b' },
    { fromNodeId: 'a', toNodeId: 'b' },
  ])
  assert.deepEqual(plan.layers, [['a'], ['b']], '重复连线不应增加层数')
}

// 环上的节点既不进 layers，也不该被静默丢掉。
{
  const plan = planLayers(['a', 'b', 'c'], [
    { fromNodeId: 'a', toNodeId: 'b' },
    { fromNodeId: 'b', toNodeId: 'a' },
    { fromNodeId: 'c', toNodeId: 'c' },
  ])
  assert.deepEqual(plan.cycle, ['a', 'b', 'c'], '互相依赖的节点应报为环')
  assert.deepEqual(plan.layers, [], '环上的节点不能出现在可执行层里')
}

// 起点集合为空时计划为空。
assert.deepEqual(planWorkflow([], nodes, edges), { layers: [], cycle: [] }, '无起点应得到空计划')

// -------------------------------------------------------------- 执行语义

{
  // 记录提交顺序，验证层内并行、层间串行。
  const order = []
  const result = await runWorkflow({
    roots: ['text'],
    nodeIds: nodes,
    edges,
    run: async nodeId => {
      order.push(`start:${nodeId}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${nodeId}`)
      return 'done'
    },
  })
  assert.equal(result.status, 'completed', '无环链路应跑完')
  assert.equal(result.done, 4, 'text 的下游是 text/img/vid/compose 四个节点')
  // 层间串行：img 开始之前 text 必须已经结束。
  assert.ok(
    order.indexOf('end:text') < order.indexOf('start:img'),
    `下一层必须等上一层结束，实际顺序：${order.join(' → ')}`,
  )
  assert.ok(order.indexOf('end:img') < order.indexOf('start:vid'), 'vid 必须等 img')
  // lonely 不在下游里，不能被执行。
  assert.ok(!order.includes('start:lonely'), '起点以外的孤立节点不应被执行')
}

{
  // 同一层内并行：两个无依赖节点应同时处于运行中。
  let concurrent = 0
  let peak = 0
  await runWorkflow({
    roots: ['a', 'b'],
    nodeIds: ['a', 'b', 'c'],
    edges: [{ fromNodeId: 'a', toNodeId: 'c' }, { fromNodeId: 'b', toNodeId: 'c' }],
    run: async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise(resolve => setTimeout(resolve, 10))
      concurrent -= 1
      return 'done'
    },
  })
  assert.equal(peak, 2, '同层两个无依赖节点应并行执行')
}

{
  // 整个下游闭包都被挡住（中间节点失败，没有兄弟分支），仍是 failed：
  // 部分成功的状态只用来描述「确实有独立分支跑出来了」。
  const ran = []
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a', 'b', 'c'],
    edges: [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'c' }],
    run: async nodeId => {
      ran.push(nodeId)
      return nodeId === 'b' ? 'failed' : 'done'
    },
  })
  assert.equal(result.status, 'failed', '链路中段失败应让整体失败')
  assert.deepEqual(ran, ['a', 'b'], '失败节点之后不该再提交任何节点')
  assert.deepEqual(result.blocked, ['c'], '失败节点的下游应被列为阻断')
  assert.deepEqual(result.failedNodeIds, ['b'], '失败节点列表应含 b')
}

{
  // 失败只停自己的下游：两条互不依赖的管线，A 断了不能让 B 一起停下。
  // 这曾经是误伤：一个节点失败就 return，另一条能跑完的分支被跳过。
  const ran = []
  const result = await runWorkflow({
    roots: ['a1', 'b1'],
    nodeIds: ['a1', 'a2', 'b1', 'b2'],
    edges: [
      { fromNodeId: 'a1', toNodeId: 'a2' },
      { fromNodeId: 'b1', toNodeId: 'b2' },
    ],
    run: async nodeId => {
      ran.push(nodeId)
      return nodeId === 'a1' ? 'failed' : 'done'
    },
  })
  assert.deepEqual(ran, ['a1', 'b1', 'b2'], 'A 断了下游 a2 不该提交，但 B 分支必须跑完')
  assert.equal(result.status, 'partial', '有一条分支跑完时不能报成 failed 或 completed')
  assert.equal(result.failedNodeId, 'a1', '应报出失败的那个节点')
  assert.deepEqual(result.blocked, ['a2'], '被阻断的只有失败节点的下游')
  assert.equal(result.done, 2, 'done 只数真正跑出结论的节点（b1、b2）')
}

{
  // 上游跑成功不能证明「有分支跑完」：a → b 里 b 失败，a 是 b 的输入。
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a', 'b'],
    edges: [{ fromNodeId: 'a', toNodeId: 'b' }],
    run: async nodeId => nodeId === 'b' ? 'failed' : 'done',
  })
  assert.equal(result.status, 'failed', '失败节点的上游完成不算独立分支跑完')
  assert.equal(result.done, 1, '上游节点本身仍然计入 done')
}

{
  // 同层里一个失败、另一个独立节点成功，且后面的层仍照常推进。
  const ran = []
  const result = await runWorkflow({
    roots: ['a', 'b'],
    nodeIds: ['a', 'b', 'a2', 'b2'],
    edges: [
      { fromNodeId: 'a', toNodeId: 'a2' },
      { fromNodeId: 'b', toNodeId: 'b2' },
    ],
    run: async nodeId => {
      ran.push(nodeId)
      if (nodeId === 'a') throw new Error('渠道未配置')
      return 'done'
    },
  })
  assert.equal(result.status, 'partial', '异常也只该停自己的下游')
  assert.equal(result.error, '渠道未配置', '异常信息应原样带出')
  assert.deepEqual(ran, ['a', 'b', 'b2'], '抛异常的节点下游不该提交，另一条链照常')
}

{
  // 抛异常等价于失败，并且异常信息要带出来。
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a'],
    edges: [],
    run: async () => { throw new Error('渠道未配置') },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, '渠道未配置', '异常信息应原样带出')
}

{
  // 有环：一个节点都不跑。
  let calls = 0
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a', 'b'],
    edges: [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'a' }],
    run: async () => { calls += 1; return 'done' },
  })
  assert.equal(result.status, 'cycle', '有环时状态应为 cycle')
  assert.equal(calls, 0, '有环时不该提交任何节点')
}

{
  // 中断：signal 已中止时，一个节点都不跑。
  const controller = new AbortController()
  controller.abort()
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a'],
    edges: [],
    signal: controller.signal,
    run: async () => { throw new Error('不该被调用') },
  })
  assert.equal(result.status, 'cancelled', '已中止的信号应直接取消')
}

{
  // 缓存复用：cached 计入完成数，且不阻断下游。
  const result = await runWorkflow({
    roots: ['a'],
    nodeIds: ['a', 'b'],
    edges: [{ fromNodeId: 'a', toNodeId: 'b' }],
    run: async nodeId => nodeId === 'a' ? 'cached' : 'done',
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.done, 2, 'cached 也算这次执行过')
}

{
  // 进度回调要覆盖每一层，且最终 done 等于真正有结论的节点数。
  const seen = []
  await runWorkflow({
    roots: ['a'],
    nodeIds: ['a', 'b'],
    edges: [{ fromNodeId: 'a', toNodeId: 'b' }],
    run: async () => 'done',
    onProgress: progress => seen.push(progress),
  })
  assert.ok(seen.length >= 2, '两层至少要有两次进度回调')
  const last = seen[seen.length - 1]
  assert.equal(last.done, 2, '最后一次进度应是全部完成')
  assert.equal(last.count, 2, '总数应为参与执行的节点数')
}

{
  // 部分失败时进度里的 running 不能把被阻断的节点报成正在跑。
  const seen = []
  const result = await runWorkflow({
    roots: ['a1', 'b1'],
    nodeIds: ['a1', 'a2', 'b1', 'b2'],
    edges: [
      { fromNodeId: 'a1', toNodeId: 'a2' },
      { fromNodeId: 'b1', toNodeId: 'b2' },
    ],
    run: async nodeId => nodeId === 'a1' ? 'failed' : 'done',
    onProgress: progress => seen.push(progress),
  })
  const running = seen.flatMap(progress => progress.running)
  assert.ok(!running.includes('a2'), `被阻断的节点不能被报成正在执行：${running.join(', ')}`)
  assert.equal(seen[seen.length - 1].done, result.done, '最后一次进度的 done 应与结果一致')
}

console.log('workflow: ok')

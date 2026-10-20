/**
 * 时间线的离线验证：裁剪区间、总时长、转场重叠上限、结构变化后的归一化。
 *
 * 这里不跑 ffmpeg——真正生成文件的是 `verify-timeline-compose.mjs`。这个脚本
 * 只钉住「编辑器显示的时长」和「合成器要用的偏移」是同一套算法，因为这两
 * 边一旦分歧，用户看到的 8.0 秒和文件里的 7.5 秒就再也对不上了。
 *
 * Run: node scripts/smoke-timeline.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_TRANSITION,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  emptyTimeline,
  normalizeTransitions,
  placeTimeline,
  segmentSeconds,
  timelineFromNodeIds,
  timelineSeconds,
  transitionOverlap,
} from '../src/client/timeline.ts'

let count = 0
function ok(name, fn) {
  fn()
  count += 1
  console.log(`ok ${count} - ${name}`)
}

const seg = (id, inPoint = 0, outPoint) => ({
  id: `seg-${id}`,
  nodeId: id,
  inPoint,
  ...outPoint === undefined ? {} : { outPoint },
})

/** 用一张 nodeId → 时长表扮演画布上的素材。 */
const lengths = table => segment => table[segment.nodeId]

// ------------------------------------------------------------------ 裁剪

ok('整段使用：没有出点时取到素材结尾', () => {
  assert.equal(segmentSeconds(seg('a'), 5), 5)
})

ok('出点裁短', () => {
  assert.equal(segmentSeconds(seg('a', 1, 3), 5), 2)
})

ok('出点超过素材长度时按素材长度算，而不是相信输入', () => {
  // 时间线存的是意图，素材长度是事实。照 99 秒去切会读到不存在的帧。
  assert.equal(segmentSeconds(seg('a', 0, 99), 5), 5, '出点超过素材长度时按素材长度算')
})

ok('入点超过素材长度时裁出零长度，而不是负数', () => {
  assert.equal(segmentSeconds(seg('a', 9), 5), 0)
  assert.equal(segmentSeconds(seg('a', 9, 12), 5), 0)
})

ok('出点早于入点时按零长度算', () => {
  assert.equal(segmentSeconds(seg('a', 3, 2), 5), 0)
})

ok('时长未知的素材不参与计算', () => {
  assert.equal(segmentSeconds(seg('a'), undefined), undefined)
  assert.equal(segmentSeconds(seg('a'), 0), undefined)
})

// ---------------------------------------------------------------- 总时长

ok('硬切：总时长是各段之和', () => {
  const timeline = timelineFromNodeIds(['a', 'b', 'c'])
  assert.equal(timelineSeconds(timeline, lengths({ a: 4, b: 4, c: 4 })), 12)
})

ok('转场：总时长减掉重叠的部分', () => {
  const timeline = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'dissolve', seconds: 1 }],
    keepAudio: true,
  }
  assert.equal(timelineSeconds(timeline, lengths({ a: 4, b: 4 })), 7)
})

ok('两条转场各减一次', () => {
  const timeline = {
    segments: [seg('a'), seg('b'), seg('c')],
    transitions: [{ kind: 'fade', seconds: 0.5 }, { kind: 'dissolve', seconds: 1 }],
    keepAudio: true,
  }
  assert.equal(timelineSeconds(timeline, lengths({ a: 4, b: 4, c: 4 })), 12 - 0.5 - 1)
})

ok('含未知长度的段：已知的部分照样报，而不是整体归零', () => {
  const timeline = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'dissolve', seconds: 1 }],
    keepAudio: true,
  }
  // b 长度未知，它的转场也无法夹取，只报 a 的长度。
  assert.equal(timelineSeconds(timeline, lengths({ a: 4 })), 4)
})

ok('空时间线是 0 秒', () => {
  assert.equal(timelineSeconds(emptyTimeline(), () => 5), 0)
})

// ------------------------------------------------------------ 转场上限

ok('转场不能超过任一侧素材的一半', () => {
  const timeline = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'dissolve', seconds: 3 }],
    keepAudio: true,
  }
  // b 只有 2 秒，一半是 1 秒，再留 0.05 秒余量。
  const overlap = transitionOverlap(timeline, 0, lengths({ a: 10, b: 2 }))
  assert.ok(Math.abs(overlap - (1 - 0.05)) < 1e-9, `转场不能超过任一侧素材的一半，期望 0.95，实际 ${overlap}`)
})

ok('两侧都够长时，转场取用户要的时长', () => {
  const timeline = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'fade', seconds: 0.8 }],
    keepAudio: true,
  }
  assert.equal(transitionOverlap(timeline, 0, lengths({ a: 10, b: 10 })), 0.8)
})

ok('转场时长本身也夹到合法范围', () => {
  const tooLong = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'fade', seconds: 99 }],
    keepAudio: true,
  }
  assert.equal(transitionOverlap(tooLong, 0, lengths({ a: 20, b: 20 })), MAX_TRANSITION_SECONDS)

  const tooShort = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'fade', seconds: 0 }],
    keepAudio: true,
  }
  assert.equal(transitionOverlap(tooShort, 0, lengths({ a: 20, b: 20 })), MIN_TRANSITION_SECONDS)
})

ok('硬切没有重叠', () => {
  const timeline = timelineFromNodeIds(['a', 'b'])
  assert.equal(transitionOverlap(timeline, 0, lengths({ a: 4, b: 4 })), 0)
})

ok('接缝下标越界时报 0，而不是抛错', () => {
  const timeline = timelineFromNodeIds(['a'])
  assert.equal(transitionOverlap(timeline, 0, lengths({ a: 4 })), 0)
  assert.equal(transitionOverlap(timeline, -1, lengths({ a: 4 })), 0)
})

ok('素材太短导致一半减余量为负时不返回负重叠', () => {
  const timeline = {
    segments: [seg('a'), seg('b')],
    transitions: [{ kind: 'dissolve', seconds: 1 }],
    keepAudio: true,
  }
  assert.equal(transitionOverlap(timeline, 0, lengths({ a: 4, b: 0.06 })), 0)
})

// ------------------------------------------------------------- 归一化

ok('转场列表按段数裁剪', () => {
  const transitions = normalizeTransitions(2, [
    { kind: 'fade', seconds: 1 },
    { kind: 'dissolve', seconds: 1 },
    { kind: 'fade', seconds: 1 },
  ])
  assert.deepEqual(transitions, [{ kind: 'fade', seconds: 1 }])
})

ok('转场列表不够时补硬切', () => {
  assert.deepEqual(normalizeTransitions(3, []), [DEFAULT_TRANSITION, DEFAULT_TRANSITION])
  assert.deepEqual(normalizeTransitions(3, [{ kind: 'fade', seconds: 1 }]), [
    { kind: 'fade', seconds: 1 },
    DEFAULT_TRANSITION,
  ])
})

ok('没有接缝时是空列表', () => {
  assert.deepEqual(normalizeTransitions(0, []), [])
  assert.deepEqual(normalizeTransitions(1, [{ kind: 'fade', seconds: 1 }]), [])
})

ok('从节点列表造初值：顺序即参数顺序，整段使用', () => {
  const timeline = timelineFromNodeIds(['n1', 'n2'])
  assert.deepEqual(timeline.segments.map(item => item.nodeId), ['n1', 'n2'])
  assert.deepEqual(timeline.segments.map(item => item.inPoint), [0, 0])
  assert.deepEqual(timeline.segments.map(item => item.outPoint), [undefined, undefined])
  assert.equal(timeline.keepAudio, true)
  assert.equal(timeline.transitions.length, 1)
})

// ------------------------------------------------------------ 时间轴落位

ok('硬切：后一段紧接前一段', () => {
  const timeline = timelineFromNodeIds(['a', 'b', 'c'])
  const placed = placeTimeline(timeline, lengths({ a: 4, b: 4, c: 4 }))
  assert.deepEqual(placed.map(item => item.start), [0, 4, 8])
  assert.deepEqual(placed.map(item => item.seconds), [4, 4, 4])
  assert.deepEqual(placed.map(item => item.overlap), [0, 0, 0])
})

ok('转场：后一段提前 overlap 秒开始', () => {
  const timeline = {
    segments: [seg('a'), seg('b'), seg('c')],
    transitions: [{ kind: 'dissolve', seconds: 1 }, { kind: 'cut', seconds: 0 }],
    keepAudio: true,
  }
  const placed = placeTimeline(timeline, lengths({ a: 4, b: 4, c: 4 }))
  assert.deepEqual(placed.map(item => item.start), [0, 3, 7])
  // 重叠记在「接缝右侧那一段」上：它是被往前拉的那一段。
  assert.deepEqual(placed.map(item => item.overlap), [0, 1, 0])
})

ok('落位总长与 timelineSeconds 一致', () => {
  const timeline = {
    segments: [seg('a', 1, 3), seg('b'), seg('c', 0, 2)],
    transitions: [{ kind: 'fade', seconds: 0.6 }, { kind: 'dissolve', seconds: 2 }],
    keepAudio: true,
  }
  const clipSecondsOf = lengths({ a: 5, b: 3, c: 4 })
  const placed = placeTimeline(timeline, clipSecondsOf)
  const last = placed[placed.length - 1]
  const expected = timelineSeconds(timeline, clipSecondsOf)
  assert.ok(Math.abs(last.start + last.seconds - expected) < 1e-9,
    `落位末端 ${last.start + last.seconds} 与总时长 ${expected} 不一致`)
})

console.log(`\ntimeline: ${count} checks ok`)

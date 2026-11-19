/**
 * 分镜体检的离线验证：规则读出什么、什么时候**不**报。
 *
 * 这是纯函数（src/client/storyboard-lint.ts）的套件，不碰 DOM、不碰网络，
 * 所以一条红线永远指向规则本身，不会指向测试环境。
 *
 * 「什么时候不报」和「什么时候报」一样重要：体检最坏的失败模式不是漏报，
 * 是满屏假警报——用户三天就学会无视整行。所以每条规则都配了反例。
 *
 * Run: node scripts/smoke-storyboard-lint.mjs   (from the package root, no build)
 */

import assert from 'node:assert/strict'
import {
  findingsByShot,
  mentionsName,
  mergeSegments,
  motionConflict,
  shotHasSegments,
  shotSegments,
  shotsWithFindings,
  storyboardFindings,
  worstLevel,
} from '../src/client/storyboard-lint.ts'
import { en, ru, zh } from '../src/client/locales.ts'

const locales = { zh, en, ru }

const results = []
/**
 * 一条失败不终止整份套件。
 *
 * 这些用例是反向验证的被测对象：注入缺陷后要能让**指定的那一条**变红。
 * 第一条断言就 process.exit，输出里只剩堆栈，找不到是哪条用例坏了——于是
 * 反向用例只能靠「反正红了」蒙对。每条都跑完、用 L 编号报告，才能让
 * `expect: /L16 …/` 真正对上号。
 */
function ok (name, fn) {
  try {
    fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** 一个钉住的身份（已经成图，否则 castMembers 会把它排除）。 */
const image = (id, name, role = 'character') => ({
  id,
  type: 'image',
  title: id,
  x: 0,
  y: 0,
  width: 240,
  height: 240,
  metadata: {
    status: 'success',
    asset: { assetId: `${id}.png`, url: `/assets/${id}.png`, mime: 'image/png', width: 512, height: 512, bytes: 1 },
    cast: { role, name },
  },
})

const board = (prompts, continuity = 'cut', seconds = 6) => ({
  shots: prompts.map((prompt, index) => ({ id: `shot-${index + 1}`, prompt, seconds })),
  aspectRatio: '16:9',
  resolution: '720P',
  continuity,
})

const rules = findings => findings.map(finding => `${finding.shotIndex}:${finding.rule}`)

// ------------------------------------------------------------------ 标秒解析

ok('L1 两种分隔符与括号写法都认', () => {
  assert.deepEqual(shotSegments('[0:00–0:03] 推近'), [{ start: 0, end: 3 }])
  assert.deepEqual(shotSegments('0:03-0:06 停住'), [{ start: 3, end: 6 }])
  assert.deepEqual(shotSegments('[00:03—00:06]'), [{ start: 3, end: 6 }])
  assert.deepEqual(shotSegments('0:03~0:06'), [{ start: 3, end: 6 }])
})

ok('L2 单独一个时间点不算分段', () => {
  // 「第 3 秒切」判断不出属于哪一段，硬猜出来的总时长只会变成噪音。
  assert.deepEqual(shotSegments('第 3 秒切到她的手'), [])
  assert.deepEqual(shotSegments('0:03 她抬头'), [])
})

ok('L3 反复调用同一条提示词不会漏掉后面的分段', () => {
  // 共享的带 g 正则只要漏了每次新建，`test()` 一次成功就把 lastIndex 留在
  // 末尾，紧接着的 `test()` 从那开始扫——同一个问题问两次会得到两个答案。
  // 这里刻意用**只含一段**的短提示词：用两段的 prompt 会让污染后仍能在后半
  // 段找到匹配，测试悄悄变成假绿。
  const one = '[0:00–0:03] 甲。'
  assert.equal(shotHasSegments({ id: 's', prompt: one, seconds: 6 }), true)
  assert.equal(shotHasSegments({ id: 's', prompt: one, seconds: 6 }), true, '重复询问必须得到同一个答案')
  // 同一份正则被 test 动过之后，matchAll 也必须还能从头读到分段。
  assert.deepEqual(shotSegments(one), [{ start: 0, end: 3 }])
  const two = '[0:00–0:03] 甲。[0:03–0:06] 乙。'
  assert.deepEqual(shotSegments(two), [{ start: 0, end: 3 }, { start: 3, end: 6 }])
  assert.deepEqual(shotSegments(two), [{ start: 0, end: 3 }, { start: 3, end: 6 }], '第二次调用的结果必须和第一次一致')
})

ok('L4 重叠按合并覆盖区间算，首尾相接不算重叠', () => {
  assert.equal(mergeSegments([{ start: 0, end: 3 }, { start: 3, end: 6 }]), 6)
  assert.equal(mergeSegments([{ start: 0, end: 4 }, { start: 3, end: 6 }]), 6)
  assert.equal(mergeSegments([{ start: 2, end: 3 }, { start: 0, end: 1 }]), 2)
  assert.equal(mergeSegments([]), 0)
})

// ------------------------------------------------------------------ 静动冲突

ok('L5 同一段里固定机位加移动运镜算冲突', () => {
  assert.equal(motionConflict('固定机位，缓慢推近'), true)
  assert.equal(motionConflict('机位固定。随后跟拍'), true)
})

ok('L6 单字「推」「摇」不算运镜信号', () => {
  // 推门、摇头、拉开抽屉几乎每镜都有；拿它们当信号会把九成镜头标成冲突。
  assert.equal(motionConflict('固定机位，她推门进来'), false)
  assert.equal(motionConflict('固定机位，他摇头'), false)
  assert.equal(motionConflict('固定机位，拉开抽屉'), false)
})

// ------------------------------------------------------------------ 名字点名

ok('L7 单字名字不参与点名判定', () => {
  // 「禾」「她」这类字在中文里到处都是，子串匹配会让每一镜都报警。
  assert.equal(mentionsName('禾抬起头', '禾'), false)
  assert.equal(mentionsName('阿禾抬起头', '阿禾'), true)
})

// ------------------------------------------------------------------ 逐镜规则

ok('L8 carry 板上提到钉住身份，但这一镜正是丢参考图的那一镜', () => {
  // 第 1 镜带参考图，第 2 镜起 carry 把两个帧槽都花在接缝上。
  const findings = storyboardFindings(
    board(['阿禾推门进来，固定机位。', '阿禾抬头看向窗外。'], 'carry'),
    [image('a', '阿禾')],
  )
  assert.deepEqual(rules(findings), ['1:castMentionedButDropped'])
  assert.equal(findings[0].level, 'block')
})

ok('L9 carry 板上没提到钉住身份的那一镜不报', () => {
  // 丢参考图是这一镜的常态，但只有真的写了她的名字才是问题。
  const findings = storyboardFindings(
    board(['阿禾推门进来。', '窗外下起雨。'], 'carry'),
    [image('a', '阿禾')],
  )
  assert.deepEqual(rules(findings), [], '第 2 镜没提到阿禾，不该报')
})

ok('L10 cut 板上身份参考本来就随行，不报', () => {
  const findings = storyboardFindings(board(['阿禾推门进来。']), [image('a', '阿禾')])
  assert.deepEqual(rules(findings), [])
})

ok('L11 分段加起来超过镜长要报，并给出实际覆盖', () => {
  const findings = storyboardFindings(board(['[0:00–0:04] 甲。[0:04–0:09] 乙。']), [])
  assert.deepEqual(rules(findings), ['0:segmentTotal'])
  assert.equal(findings[0].key, 'canvas.storyboard.lintSegmentOver')
  assert.equal(findings[0].params.covered, 9)
  assert.equal(findings[0].params.seconds, 6)
})

ok('L12 分段加起来不足镜长也要说，但不是错误', () => {
  const findings = storyboardFindings(board(['[0:00–0:03] 甲。']), [])
  assert.deepEqual(rules(findings), ['0:segmentTotal'])
  assert.equal(findings[0].key, 'canvas.storyboard.lintSegmentUnder')
  assert.equal(findings[0].params.left, 3)
  assert.equal(findings[0].level, 'warn')
})

ok('L13 分段刚好铺满整镜不报', () => {
  const findings = storyboardFindings(board(['[0:00–0:03] 甲。[0:03–0:06] 乙。']), [])
  assert.deepEqual(rules(findings), [])
})

ok('L14 分段不从 0 秒开始要报', () => {
  const findings = storyboardFindings(board(['[0:02–0:06] 甲。']), [])
  assert.deepEqual(rules(findings), ['0:segmentCoverage'])
  assert.equal(findings[0].key, 'canvas.storyboard.lintSegmentStart')
})

ok('L15 起止写反要报，而不是被算成负数覆盖', () => {
  const findings = storyboardFindings(board(['[0:06–0:02] 甲。']), [])
  assert.deepEqual(rules(findings), ['0:segmentCoverage'])
  assert.equal(findings[0].key, 'canvas.storyboard.lintSegmentOrder')
})

ok('L16 同一段里静动冲突要报', () => {
  const findings = storyboardFindings(board(['[0:00–0:06] 固定机位，缓慢推近她。']), [])
  assert.deepEqual(rules(findings), ['0:motionConflict'])
  assert.equal(findings[0].params.count, 1)
})

ok('L17 整镜先固定后推近（分段写的）不算冲突', () => {
  // 那是先后两段，合法；只有同一段里同时出现才是病句。
  const findings = storyboardFindings(
    board(['[0:00–0:03] 固定机位，她抬头。[0:03–0:06] 推近到她眼睛。']),
    [],
  )
  assert.deepEqual(rules(findings), [])
})

ok('L18 空提示词的镜头不参与体检', () => {
  const findings = storyboardFindings(board(['', '  ']), [image('a', '阿禾')])
  assert.deepEqual(rules(findings), [])
})

ok('L19 超过参考图上限要报，并说清丢几个', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id, index) => image(id, `角色${index}`))
  const findings = storyboardFindings(board(['甲']), nodes)
  const overflow = findings.find(finding => finding.rule === 'castOverflow')
  assert.notEqual(overflow, undefined)
  assert.equal(overflow.params.max, 4)
  assert.equal(overflow.params.dropped, 1)
  assert.equal(overflow.shotIndex, 0, '全板级问题挂第 1 镜，否则点不动')
})

ok('L20 钉了两个同名的人要报，因为第二个会被去重丢掉', () => {
  const findings = storyboardFindings(board(['甲']), [image('a', '阿禾'), image('b', '阿禾')])
  const duplicate = findings.find(finding => finding.rule === 'castDuplicate')
  assert.notEqual(duplicate, undefined)
  assert.equal(duplicate.params.names, '阿禾')
})

// ------------------------------------------------------------------ 汇总

ok('L21 结论按镜序排，同一镜里 block 排在 warn 前面', () => {
  const findings = storyboardFindings(
    board(['[0:00–0:09] 固定机位，推近。', '阿禾抬头。'], 'carry'),
    [image('a', '阿禾')],
  )
  // 第 0 镜两条都是 warn，同级之间保持规则自己的插入顺序（顺序只要有确定性
  // 就行，用户读的是「哪一镜有几句」）；第 1 镜的 block 必须排在它后面。
  assert.deepEqual(
    findings.map(finding => `${finding.shotIndex}:${finding.level}`),
    ['0:warn', '0:warn', '1:block'],
  )
  assert.deepEqual(rules(findings).slice(0, 2).sort(), ['0:motionConflict', '0:segmentTotal'])
})

ok('L22 最重级别与有问题的镜数', () => {
  assert.equal(worstLevel([]), undefined)
  assert.equal(worstLevel([{ shotIndex: 0, rule: 'segmentTotal', level: 'warn', key: 'x' }]), 'warn')
  assert.equal(worstLevel([
    { shotIndex: 0, rule: 'segmentTotal', level: 'warn', key: 'x' },
    { shotIndex: 1, rule: 'castMentionedButDropped', level: 'block', key: 'y' },
  ]), 'block')
  assert.equal(shotsWithFindings([
    { shotIndex: 0, rule: 'segmentTotal', level: 'warn', key: 'x' },
    { shotIndex: 0, rule: 'motionConflict', level: 'warn', key: 'y' },
    { shotIndex: 2, rule: 'segmentTotal', level: 'warn', key: 'z' },
  ]), 2, '同一镜两条结论只算一个镜')
})

ok('L23 findingsByShot 只给这一镜的结论', () => {
  const findings = storyboardFindings(board(['[0:00–0:09] 甲。', '[0:00–0:09] 乙。']), [])
  assert.equal(findingsByShot(findings, 0).length, 1)
  assert.equal(findingsByShot(findings, 1).length, 1)
  assert.equal(findingsByShot(findings, 5).length, 0)
})

// ------------------------------------------------------------ 文案可读性
//
// 清单每行前面已经有一个镜号，正文若以裸数字开头，屏幕上就是「1 1 个分段里…」
// ——两个数字贴在一起，用户分不清哪个是镜号。这条把「正文不以数字开头」钉死，
// 三语一起查，新加规则时也不用再记得。
const LINT_KEYS = [
  'canvas.storyboard.lintCastDropped',
  'canvas.storyboard.lintCastOverflow',
  'canvas.storyboard.lintCastDuplicate',
  'canvas.storyboard.lintSegmentOver',
  'canvas.storyboard.lintSegmentUnder',
  'canvas.storyboard.lintSegmentStart',
  'canvas.storyboard.lintSegmentOrder',
  'canvas.storyboard.lintMotionConflict',
]

ok('L24 体检文案不以数字开头（三语都查）', () => {
  for (const language of ['zh', 'en', 'ru']) {
    const table = locales[language]
    for (const key of LINT_KEYS) {
      const text = table[key]
      assert.equal(typeof text, 'string', `${language} 缺 ${key}`)
      assert.doesNotMatch(
        text,
        /^\s*[\d{]/,
        `${language} 的 ${key} 以数字开头，会和镜号连读：「${text}」`,
      )
    }
  }
})

// ---------------------------------------------------------------- 收尾

for (const line of results) console.log(line)
const failed = results.filter(line => line.startsWith('FAIL')).length
console.log(`\nstoryboard-lint: ${results.length - failed}/${results.length} checks ok`)

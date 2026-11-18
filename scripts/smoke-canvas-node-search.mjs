/**
 * 画布「找节点」：搜出来的顺序、以及跳过去之后视野落在哪。
 *
 * 这两个函数都只喂数字和字符串，坏起来却都是「不报错的坏」：搜索结果顺序一乱，
 * 用户会以为那张卡不在了；视野算出一个 NaN，整块画布直接变空白，控制台一个字
 * 都不吭。所以这里不测「大概对」，只钉具体的分数、具体的下标顺序、具体的
 * `Number.isFinite`。
 *
 * 断言用的都是画布上真会出现的字与坐标：中文标题、全角空格、上百张卡里的
 * 240×240 节点、1200×900 的视口。抽象数字看不出「阈值到底是世界像素还是
 * 屏幕像素」这类错误。
 *
 * Run: node scripts/smoke-canvas-node-search.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { focusViewport, searchNodes, usableFocusHeight } from '../src/client/canvas/node-search.ts'

/** 只给搜索需要的字段；宽高用画布默认尺寸，避免每处都写一遍。 */
const node = (id, title, metadata) => ({
  id,
  type: metadata?.model ? 'config' : 'image',
  title,
  x: 0,
  y: 0,
  width: 240,
  height: 240,
  ...(metadata === undefined ? {} : { metadata }),
})

const results = []
const checks = []
function check(name, fn) { checks.push({ name, fn }) }

// ------------------------------------------------------------------ 搜

check('S1 空查询返回空数组：什么都没打的时候不该列出整张画布', () => {
  const nodes = [node('a', '樱花街道'), node('b', '猫')]
  // 空查询如果退化成「全部」，用户一打开列表就是上百行，而且每敲一个字都要
  // 重排一次整份节点表。全角空格尤其要算空——中文输入法下很容易先敲出一个。
  for (const query of ['', '   ', '\u3000', ' \u3000\t ']) {
    assert.deepEqual(searchNodes(nodes, query), [], `查询 ${JSON.stringify(query)} 不是空查询，仍返回了结果`)
  }
})

check('S2 大小写不敏感，模型名里的连字符也能搜到', () => {
  // 模型名是用户唯一会照着「别处看到的拼写」打进来的东西；要求大小写一致
  // 等于让他重新背一遍。
  const hits = searchNodes([node('cfg', '出图设置', { model: 'GPT-Image-2' })], 'gpt-image')
  assert.equal(hits.length, 1, '大小写不同就搜不到模型名')
  assert.equal(hits[0].field, 'model')
  assert.equal(hits[0].snippet, 'GPT-Image-2')
})

check('S3 标题完全匹配排第一；同分时按画布顺序，不按 id', () => {
  const nodes = [
    node('z-first', '红色樱花'),   // 60：标题包含，画布里最前
    node('a-exact', '樱花'),       // 100：标题完全等于查询
    node('p-prefix', '樱花街道'),  // 80：标题以查询开头
    node('m-third', '粉色樱花'),   // 60：标题包含
  ]
  const hits = searchNodes(nodes, '樱花')
  assert.deepEqual(hits.map(hit => hit.nodeId), ['a-exact', 'p-prefix', 'z-first', 'm-third'])
  assert.deepEqual(hits.map(hit => hit.score), [100, 80, 60, 60])
  // 两条 60 分保持数组下标顺序：z-first 在 m-third 前面。按 id 排会把 m 提到
  // z 前面，用户会觉得「我刚放的那张」被藏到了后面。
})

check('S4 标题前缀 80 分，其它字段包含只有 30 分：前者必须排在前面', () => {
  const nodes = [
    node('body-hit', '无关标题', { text: '樱花街道的说明' }), // 30，且在数组更前
    node('prefix-hit', '樱花街道夜景', {}),                   // 80
  ]
  const hits = searchNodes(nodes, '樱花街道')
  assert.deepEqual(hits.map(hit => hit.nodeId), ['prefix-hit', 'body-hit'])
  assert.equal(hits[0].score, 80, '标题前缀没有拿到 80 分，结果顺序会退化成「谁先放进画布谁靠前」')
  assert.equal(hits[1].score, 30, '正文命中被给了标题级分数，搜索会先把无关卡片推上来')
  assert.equal(hits[0].field, 'title')
  assert.equal(hits[1].field, 'text')
})

check('S5 多个词必须都命中同一段文字，全角空格也算分隔', () => {
  const nodes = [
    node('both', '樱花大道旁的街道'),
    node('one', '樱花大道'),
  ]
  const hits = searchNodes(nodes, '樱花\u3000街道')
  assert.deepEqual(hits.map(hit => hit.nodeId), ['both'], '全角空格没有切开查询，或者多词被当成了「有一个就行」')
})

check('S6 跨字段拼词不算命中：用户没写过「标题 + 提示词」拼起来的那句话', () => {
  const nodes = [
    node('mixed', 'a', { text: '樱花', prompt: '街道' }),
    node('single', 'b', { text: '樱花街道' }),
  ]
  const hits = searchNodes(nodes, '樱花 街道')
  assert.deepEqual(hits.map(hit => hit.nodeId), ['single'], '两个词分散在不同字段也算命中，结果行会用一段没人写过的文字解释它为什么出现')
})

check('S7 limit 在排序之后截断：limit=1 拿到的是最高分，不是数组第一条', () => {
  const nodes = [
    node('first', '无关', { text: '樱花' }),      // 30，画布里排最前
    node('best', '樱花', {}),                     // 100，画布里排第二
  ]
  const hits = searchNodes(nodes, '樱花', { limit: 1 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].nodeId, 'best', '先截断后排序：用户打一个词只看到画布里最靠前的那张无关卡片')
})

check('S8 一个节点只出一条结果，字段优先级 title > text > prompt > model', () => {
  const everyField = node('all', '樱花标题', { text: '樱花正文', prompt: '樱花提示词', model: '樱花模型' })
  const hits = searchNodes([everyField], '樱花')
  assert.equal(hits.length, 1, '同一张卡在四个字段都命中时出了四行，用户得自己分辨哪行是那张图')
  assert.equal(hits[0].field, 'title')
  assert.equal(hits[0].snippet, '樱花标题')

  // 逐级退让：去掉标题后应当是 text，再往下去 prompt、model。
  assert.equal(searchNodes([node('t', 'x', { text: '樱花', prompt: '樱花', model: '樱花' })], '樱花')[0].field, 'text')
  assert.equal(searchNodes([node('p', 'x', { prompt: '樱花', model: '樱花' })], '樱花')[0].field, 'prompt')
  assert.equal(searchNodes([node('m', 'x', { model: '樱花' })], '樱花')[0].field, 'model')
})

check('S9 空字符串字段不算命中，哪怕查询只差一个空格', () => {
  // `''.includes('')` 恒真：放行空字段的话，任何一条查询都会把空卡片带出来。
  const nodes = [node('empty', '', { text: '' })]
  assert.deepEqual(searchNodes(nodes, '猫'), [], '空标题 / 空正文的卡片出现在结果里，点进去是一张空白卡')
  // 空白字段也不能被当成「包含空格查询」的证据。
  assert.deepEqual(searchNodes(nodes, ' '), [], '只有空格的查询命中了空字段')
})

check('S10 缺 metadata、字段是 null / undefined 都不崩', () => {
  const nodes = [
    { id: 'bare', type: 'text', title: '樱花', x: 0, y: 0, width: 200, height: 100 },
    { id: 'nulls', type: 'config', title: 'x', x: 0, y: 0, width: 200, height: 100, metadata: { text: null, prompt: null, model: null } },
    { id: 'partial', type: 'image', title: '', x: 0, y: 0, width: 200, height: 100, metadata: { prompt: undefined } },
  ]
  const hits = searchNodes(nodes, '樱花')
  assert.deepEqual(hits.map(hit => hit.nodeId), ['bare'], '缺 metadata 或 null 字段让搜索抛了异常 / 误命中')
  // 全空的那两条用任何查询都不该出现，且不抛。
  assert.deepEqual(searchNodes(nodes, 'null'), [])
})

check('S11 snippet 围绕命中处居中截断，两侧被切时各加一个…', () => {
  // 20 个字符、命中在正中间第 10 位、上限 10：正文留 8 个字符 + 两个省略号。
  const text = '0123456789ABCDEFGHIJ'
  const hits = searchNodes([node('n', text, {})], 'ABCD', { snippetLength: 10 })
  assert.equal(hits[0].snippet, '…89ABCDEF…', 'snippet 不是从命中处居中截的：用户在结果行里看不到自己搜的词')
  assert.equal(hits[0].snippet.length, 10, 'snippet 超出上限，结果行会折行挤掉下一张卡')
})

check('S12 原文没超上限就原样返回，不加省略号', () => {
  const hits = searchNodes([node('n', '樱花街道', {})], '樱花')
  assert.equal(hits[0].snippet, '樱花街道', '没有截断却也加了省略号，用户会以为标题后面还有字')
  assert.ok(!hits[0].snippet.includes('…'))
  // snippet 是纯文本：高亮是渲染层的事，这里塞标记会把用户原文中的同名符号搅乱。
  assert.ok(!/[<>*]/.test(hits[0].snippet))
})

check('S13 长时间正文里命中靠后时也截到命中处，而不是从头开始截', () => {
  const text = '前言'.repeat(40) + '樱花街道' + '后记'.repeat(40)
  const hits = searchNodes([node('n', 'x', { text })], '樱花', { snippetLength: 20 })
  assert.ok(hits[0].snippet.includes('樱花'), 'snippet 不含查询词：这行结果解释不了它自己为什么在这')
  assert.ok(hits[0].snippet.startsWith('…') && hits[0].snippet.endsWith('…'), '两侧都被切掉却少了省略号，读起来像原文本来就从这里开始')
})

// -------------------------------------------------------------- 跳过去

/** 世界坐标 → 屏幕坐标，与画布 `.world` 的 transform 同一公式。 */
const toScreen = (point, view) => ({ x: point.x * view.k + view.x, y: point.y * view.k + view.y })

check('V1 矩形中心落在视口中心：跳过去看到的是整张卡，不是它的一个角', () => {
  const rect = { x: 2000, y: 1000, width: 2400, height: 1200 }
  const size = { width: 1200, height: 900 }
  const view = focusViewport(rect, size, 0.4)
  const center = toScreen({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, view)
  assert.ok(Math.abs(center.x - size.width / 2) < 1e-9, `矩形中心横向偏离视口中心 ${center.x - size.width / 2}px`)
  assert.ok(Math.abs(center.y - size.height / 2) < 1e-9, `矩形中心纵向偏离视口中心 ${center.y - size.height / 2}px`)
  // 四周各留 80 世界像素后正好装下：缩放取两个方向里更紧的那个。
  const expected = Math.min(size.width / (rect.width + 160), size.height / (rect.height + 160))
  assert.ok(Math.abs(view.k - expected) < 1e-9, '缩放没有按「矩形 + 默认 80 边距」来算')
})

check('V2 默认 padding 是 80 世界像素：840×640 的卡在 1000×800 视口里正好 100%', () => {
  const view = focusViewport({ x: 0, y: 0, width: 840, height: 640 }, { width: 1000, height: 800 }, 1)
  assert.equal(view.k, 1, '边距不是 80（或算成了屏幕像素），「适应一张卡」跳过去会放大到卡片贴边')
})

check('V3 小卡片不会无限放大：缩放夹在 maxScale 上', () => {
  // 100×100 的卡片在 1000×800 视口里按比例能到 5 倍以上，放大到这个程度只会
  // 让用户看到几个像素的色块。
  const view = focusViewport({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 800 }, 1)
  assert.equal(view.k, 1.6, '小卡片没有夹在默认 maxScale=1.6 上')
  const custom = focusViewport({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 800 }, 1, { maxScale: 2.5 })
  assert.equal(custom.k, 2.5, 'maxScale 选项没生效')
})

check('V4 超大矩形不会缩到看不见：缩放夹在 minScale 上', () => {
  // 十万像素的画布按比例会把 k 算到 0.01 以下，整块内容缩成一个点。
  const view = focusViewport({ x: 0, y: 0, width: 100_000, height: 100_000 }, { width: 1000, height: 800 }, 1)
  assert.equal(view.k, 0.1, '超大范围没有夹在默认 minScale=0.1 上')
  const custom = focusViewport({ x: 0, y: 0, width: 100_000, height: 100_000 }, { width: 1000, height: 800 }, 1, { minScale: 0.05 })
  assert.equal(custom.k, 0.05, 'minScale 选项没生效')
})

check('V5 窄画幅里跳过去仍看得清卡片，不被压到最小缩放', () => {
  // 实测场景：三栏工作室下画布只有 722×332，顶栏 59 px、底部浮层 22 px。
  // 按「视口高 − 两个边距」算，可用高度只剩 251 px，看着还行；但一旦对话栏
  // 再挤窄或底栏换成两行（chromeHeight 涨到 300+），可用高度会掉到个位数，
  // focusViewport 于是把 320×190 的卡塞进一条缝里，比例夹到 MIN_SCALE=0.05，
  // 卡片只剩 16 px 宽——用户搜到卡、回车，眼睛跟丢了。
  const height = 332
  const top = 59
  const bottom = 22
  const usable = usableFocusHeight(height, top, bottom)
  assert.ok(usable >= 160, `可用高度 ${usable} 低于可读下限`)
  const view = focusViewport({ x: 0, y: 0, width: 320, height: 190 }, { width: 722, height: usable }, 0.5, { padding: 80, minScale: 0.05, maxScale: 1.6 })
  assert.ok(view.k * 320 >= 100, `跳转后卡片只有 ${Math.round(view.k * 320)} px 宽`)

  // 底部浮层高到超过视口时也不能返回 0 或负数：那会让 focusViewport 做除法后
  // 得到一个荒谬的 k。
  for (const bottomInset of [0, 100, 332, 900]) {
    const value = usableFocusHeight(332, top, bottomInset)
    assert.ok(Number.isFinite(value) && value > 0, `bottomInset=${bottomInset} 时可用高度是 ${value}`)
    assert.ok(value <= 332, `bottomInset=${bottomInset} 时可用高度 ${value} 超过了视口`)
  }
})

check('V6 视口还没量出尺寸时原样返回当前缩放，不产生 NaN', () => {
  for (const size of [{ width: 0, height: 800 }, { width: 1000, height: 0 }, { width: 0, height: 0 }]) {
    assert.deepEqual(
      focusViewport({ x: 100, y: 50, width: 240, height: 240 }, size, 0.7),
      { k: 0.7, x: 0, y: 0 },
      `视口尺寸 ${JSON.stringify(size)} 时返回了非原始值`,
    )
  }
})

check('V7 宽高为 0 的矩形按 1 处理，不做除零', () => {
  // 刚放下还没量出内容的卡片就是 0×0。按 1 代进去，比例会很大→夹到 maxScale；
  // 若是除 0，得到的是 Infinity，夹取之后看着也「正常」，但中间已经脏了。
  const view = focusViewport({ x: 0, y: 0, width: 0, height: 0 }, { width: 100, height: 100 }, 1, {
    padding: 0,
    minScale: 0.1,
    maxScale: 1000,
  })
  assert.equal(view.k, 100, '0 尺寸矩形没有按 1 计算：缩放会到 1000 或无穷大')
  for (const value of Object.values(view)) assert.ok(Number.isFinite(value), '0 尺寸矩形算出了非有限数')
})

check('V8 所有返回值都是有限数，哪怕输入本身是 NaN / Infinity', () => {
  const cases = [
    [{ x: Number.NaN, y: 0, width: 240, height: 240 }, { width: 1200, height: 900 }, 1, undefined],
    [{ x: 0, y: Number.NaN, width: 240, height: 240 }, { width: 1200, height: 900 }, 0.5, { padding: Number.NaN }],
    [{ x: 0, y: 0, width: Number.NaN, height: Number.NaN }, { width: 1200, height: 900 }, Number.NaN, undefined],
    [{ x: 0, y: 0, width: 240, height: 240 }, { width: Number.NaN, height: 900 }, 1, undefined],
    [{ x: 0, y: 0, width: 240, height: 240 }, { width: 1200, height: 900 }, 1, { minScale: Number.NaN, maxScale: Number.NaN }],
  ]
  for (const [rect, size, scale, options] of cases) {
    const view = focusViewport(rect, size, scale, options)
    for (const [key, value] of Object.entries(view)) {
      assert.ok(Number.isFinite(value), `输入 ${JSON.stringify({ rect, size, scale, options })} 算出的 ${key} 是 ${value}，写进 transform 会让整块画布消失`)
    }
  }
})

check('V9 缩放严格夹在 [minScale, maxScale] 闭区间内', () => {
  const size = { width: 1200, height: 900 }
  for (const width of [1, 40, 240, 1200, 4800, 200_000]) {
    const view = focusViewport({ x: 0, y: 0, width, height: width }, size, 1, { minScale: 0.2, maxScale: 3 })
    assert.ok(view.k >= 0.2 && view.k <= 3, `宽 ${width} 时 k=${view.k} 跑出了 [0.2, 3]`)
  }
  // 边界值本身要能取到：正好等于下限时不能被夹成「略大于下限」。
  const exact = focusViewport({ x: 0, y: 0, width: 4400, height: 4400 }, size, 1, { padding: 0, minScale: 0.2, maxScale: 3 })
  assert.ok(Math.abs(exact.k - 900 / 4400) < 1e-9, '区间内的自然缩放被错误地贴到了边界上')
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
  console.error(`\ncanvas node search: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncanvas node search: ${passed} passed`)

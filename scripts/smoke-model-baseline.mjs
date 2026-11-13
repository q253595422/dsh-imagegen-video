// 内置模型基线表：族判定、厂商前缀剥离、生命周期与「不拦截请求」这条边界。
// 纯函数，不需要网络、密钥或构建产物。
import assert from 'node:assert/strict'
import { baselineEntry, MODEL_BASELINE, normalizeModelId } from '../src/model-baseline.ts'
import { describeModel, lifecycleNoticeKey, modelFamily, supportsGifOutput } from '../src/model-catalog.ts'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

// ---------------------------------------------------------------- baseline 表自身
check('基线表里没有重复 id', () => {
  const seen = new Set()
  for (const entry of MODEL_BASELINE) {
    assert.equal(seen.has(entry.id), false, `重复 id：${entry.id}`)
    seen.add(entry.id)
  }
})

check('每个非 active 条目都写明了来源', () => {
  for (const entry of MODEL_BASELINE) {
    if (entry.lifecycle === undefined) continue
    assert.equal(typeof entry.source, 'string', `${entry.id} 标了 ${entry.lifecycle} 却没写 source`)
    assert.ok(entry.source.length > 0, `${entry.id} 的 source 是空串`)
  }
})

check('基线表里的 id 都是小写（查表按小写建索引）', () => {
  for (const entry of MODEL_BASELINE) {
    assert.equal(entry.id, entry.id.toLowerCase(), `${entry.id} 含大写，BY_ID 查不到`)
  }
})

// ---------------------------------------------------------------- 厂商前缀
check('剥离一层厂商前缀', () => {
  assert.equal(normalizeModelId('google/gemini-3-pro-image'), 'gemini-3-pro-image')
  assert.equal(normalizeModelId('openai/gpt-image-2.5'), 'gpt-image-2.5')
})

check('没有前缀的 id 原样返回', () => {
  assert.equal(normalizeModelId('image-01'), 'image-01')
  assert.equal(normalizeModelId('gpt-image-2'), 'gpt-image-2')
})

check('只剥一层，不把 a/b/c 塌成 c', () => {
  assert.equal(normalizeModelId('a/b/c'), 'b/c')
})

check('前缀后面为空或前缀为空时不动', () => {
  assert.equal(normalizeModelId('google/'), 'google/')
  assert.equal(normalizeModelId('/gpt-image-2'), '/gpt-image-2')
})

check('前缀 id 也能精确命中基线表', () => {
  // 这条是本轮修的真实缺陷：OpenRouter 预设用 google/gemini-3-pro-image，
  // 旧实现落到 unknown，面板因此误报「只保留 1 张参考图」。
  const entry = baselineEntry('google/gemini-3-pro-image')
  assert.ok(entry !== undefined, '带前缀的 id 没命中基线表')
  assert.equal(entry.family, 'nanobanana')
})

check('大小写不敏感', () => {
  assert.equal(baselineEntry('GPT-Image-2.5')?.family, 'gpt-image')
})

// ---------------------------------------------------------------- describeModel
check('带厂商前缀的图像模型不再落到 unknown', () => {
  const described = describeModel('google/gemini-3-pro-image')
  assert.equal(described.family, 'nanobanana')
  assert.equal(described.known, true, '带前缀的官方预设仍被判成未知协议')
})

check('基线表里每个 id 都能被 describeModel 反查到同一族', () => {
  for (const entry of MODEL_BASELINE) {
    assert.equal(modelFamily(entry.id), entry.family, `${entry.id} 的族判定与表不一致`)
  }
})

check('未列入表的新 id 靠命名约定归族，而不是 unknown', () => {
  // 上游出新的后缀比表更新快，这条是「表不需要每次追新」的保证。
  assert.equal(modelFamily('gpt-image-2.7-sunburst'), 'gpt-image')
  assert.equal(modelFamily('seedream-6.0'), 'seedream')
  assert.equal(modelFamily('qwen-image-3.5'), 'qwen')
})

check('真正认不出的 id 仍然落到 unknown（保留逃生口）', () => {
  assert.equal(modelFamily('some-gateway-alias-42'), 'unknown')
})

// ---------------------------------------------------------------- 生命周期
check('未记录的模型一律 active，不误报弃用', () => {
  for (const id of ['gpt-image-2.5', 'gemini-3-pro-image', 'seedream-5.0-pro', 'unknown-alias']) {
    assert.equal(describeModel(id).lifecycle, 'active', `${id} 被误报为 ${describeModel(id).lifecycle}`)
  }
})

check('生命周期不改变能力判定', () => {
  // 同样的族、同样的 GIF 能力——弃用只影响提示，不影响请求形态。
  assert.equal(supportsGifOutput('gpt-image-2.6-sunburst'), true)
  assert.equal(describeModel('gpt-image-2.6-sunburst').lifecycle, 'active')
})

check('生命周期不拦截请求：unknown 与 removed 都能拿到族', () => {
  // 这是边界本身——没有「拒绝生成」这种返回值可用，说明上游弃用从不阻断。
  for (const id of ['gpt-image-2.5', 'totally-unknown-model']) {
    const described = describeModel(id)
    assert.equal(typeof described.supportsEdit, 'boolean')
    assert.equal(Array.isArray(described.qualityTiers), true)
  }
})

// ------------------------------------------------- 生命周期 → 文案 key 的映射
// 这一层单独测，是因为表里目前全是 active：不注入状态的话，面板里那条分支
// 永远走不到，等于未经验证的代码。
check('active 不出提示', () => {
  assert.equal(lifecycleNoticeKey({ lifecycle: 'active' }), null)
})

check('deprecated 有替代品时指向替代品', () => {
  assert.equal(lifecycleNoticeKey({ lifecycle: 'deprecated', replacement: 'gpt-image-3' }), 'model.deprecated')
})

check('deprecated 没有替代品时只提示风险', () => {
  assert.equal(lifecycleNoticeKey({ lifecycle: 'deprecated' }), 'model.deprecatedNoReplacement')
})

check('removed 有替代品时给出迁移目标', () => {
  assert.equal(lifecycleNoticeKey({ lifecycle: 'removed', replacement: 'gpt-image-3' }), 'model.removed')
})

check('removed 没有替代品时只提示会失败', () => {
  assert.equal(lifecycleNoticeKey({ lifecycle: 'removed' }), 'model.removedNoReplacement')
})

check('空串替代品等同于没有替代品', () => {
  // 基线表里写 replacement: '' 是笔误，不该渲染出「建议改用 」这样的空句。
  assert.equal(lifecycleNoticeKey({ lifecycle: 'removed', replacement: '' }), 'model.removedNoReplacement')
})

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} 内置模型基线表 ${passed}/${passed + failed}`)
process.exit(failed === 0 ? 0 : 1)

import assert from 'node:assert/strict'
import { defaultOutfitRecipe, buildOutfitPrompt, prepareOutfitGeneration } from '../src/client/outfit-generation.ts'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const base = 'http://127.0.0.1:35432/'
globalThis.location = new URL(base)
const files = new Map()
const requested = []
globalThis.fetch = async url => {
  requested.push(url)
  return files.get(url)?.() ?? new Response('missing', { status: 404 })
}
class Reader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
      this.onload?.()
    }).catch(error => { this.error = error; this.onerror?.() })
  }
}
globalThis.FileReader = Reader
const labels = []
const draws = []
let canvasCount = 0
URL.createObjectURL = () => `blob:test-${++canvasCount}`
URL.revokeObjectURL = () => {}
globalThis.Image = class {
  naturalWidth = 900
  naturalHeight = 1200
  set src(url) { this.url = url; queueMicrotask(() => this.onload?.()) }
}
globalThis.document = {
  createElement(name) {
    assert.equal(name, 'canvas')
    return {
      width: 0, height: 0,
      getContext(kind) {
        assert.equal(kind, '2d')
        return {
          fillRect() {},
          drawImage(_image, x, y, width, height) { draws.push({ x, y, width, height }) },
          fillText(label) { labels.push(label) },
        }
      },
      toDataURL(mime) { assert.equal(mime, 'image/jpeg'); return 'data:image/jpeg;base64,' + Buffer.from('sheet').toString('base64') },
    }
  },
}
const makeRef = (kind, key, more = {}) => ({ key, kind, source: 'local', sourceUrl: '', revision: 'test', title: key, category: '测试', tags: [], thumbnailUrl: '', imageUrl: `/api/outfit/${key}`, ...more })
const add = (key, bytes = png, mime = 'image/png') => files.set(new URL(`/api/outfit/${key}`, base).href, () => new Response(new Blob([bytes], { type: mime })))
function recipe() {
  const value = defaultOutfitRecipe()
  value.portrait = makeRef('portrait', 'person')
  value.costumes = [makeRef('costume', 'dress')]
  value.pose = makeRef('pose', 'pose', { angle: '正面', useDepth: true })
  return value
}

async function main() {
  add('person'); add('dress'); add('pose')
  const draft = recipe()
  assert.equal(draft.mode, 'try-on')
  const prompt = buildOutfitPrompt(draft)
  assert.match(prompt, /图1：人物面容与身份/)
  assert.match(prompt, /图2：服装1的款式、颜色和材质/)
  assert.match(prompt, /图3：仅用于身体动作和镜头角度/)
  assert.match(prompt, /图案、商标和材质/)
  assert.match(prompt, /深度视图，仅作视觉参考/)
  draft.scene = '咖啡馆'
  draft.extraPrompt = '自然光'
  assert.match(buildOutfitPrompt(draft), /场景：咖啡馆。\n补充要求：自然光。/)
  const multiref = await prepareOutfitGeneration(draft, 5)
  assert.equal(multiref.referenceCount, 3)
  assert.equal(multiref.sheet, null)
  assert.equal(multiref.images.length, 2)
  assert.ok(multiref.image.startsWith('data:image/png;base64,'))
  assert.deepEqual(requested.map(url => new URL(url).pathname), ['/api/outfit/person', '/api/outfit/dress', '/api/outfit/pose'])
  assert.equal(canvasCount, 0)
  console.log('PASS 多图顺序及提示词对照')

  const sheet = await prepareOutfitGeneration(draft, 1)
  assert.ok(sheet.sheet?.startsWith('data:image/jpeg;base64,'))
  assert.equal(sheet.image, sheet.sheet)
  assert.equal(sheet.images.length, 0)
  assert.equal(sheet.referenceCount, 3)
  assert.deepEqual(labels, ['图1 人物面容与身份', '图2 服装1的款式、颜色和材质', '图3 仅用于身体动作和镜头角度'])
  assert.equal(draws.length, 3)
  for (const rect of draws) {
    assert.ok(rect.width <= 456 && rect.height <= 476, '拼图图格不得裁切')
    assert.equal(Math.round(rect.width / rect.height * 1e4), 7500, '拼图保持原图的 3:4 比例')
  }
  assert.match(sheet.prompt, /唯一输入图片是带编号的参考拼图/)
  console.log('PASS 单图渠道拼图与不裁切')

  const six = recipe()
  six.costumes = [0, 1, 2, 3].map(index => makeRef('costume', `garment-${index}`))
  six.costumes.forEach(item => add(item.key))
  const crowded = await prepareOutfitGeneration(six, 5)
  assert.equal(crowded.referenceCount, 6)
  assert.equal(crowded.images.length, 0)
  assert.ok(crowded.sheet)
  assert.match(crowded.prompt, /图6：仅用于身体动作和镜头角度/)
  console.log('PASS 六张素材自动压成单张拼图')

  const alone = defaultOutfitRecipe()
  alone.mode = 'character'
  alone.pose = makeRef('pose', 'pose', { angle: '侧面' })
  const one = await prepareOutfitGeneration(alone, 1)
  assert.equal(one.referenceCount, 1)
  assert.equal(one.sheet, null)
  assert.match(one.prompt, /侧面视角/)
  await assert.rejects(prepareOutfitGeneration(defaultOutfitRecipe(), 5), /需要人物和至少一张服装/)
  await assert.rejects(prepareOutfitGeneration(alone, 0), /不支持参考图编辑/)
  const tooManyClothes = recipe()
  tooManyClothes.costumes = Array(5).fill(makeRef('costume', 'dress'))
  await assert.rejects(prepareOutfitGeneration(tooManyClothes, 5), /最多选择 4 张/)
  console.log('PASS 模式必填、容量和四件服装边界')

  const dressUrl = new URL('/api/outfit/dress', base).href
  files.delete(dressUrl)
  await assert.rejects(prepareOutfitGeneration(recipe(), 5), /HTTP 404/)
  add('dress', png, 'text/html')
  await assert.rejects(prepareOutfitGeneration(recipe(), 5), /不是支持的图片格式/)
  files.set(dressUrl, () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/redirect.png' } }))
  await assert.rejects(prepareOutfitGeneration(recipe(), 5), /HTTP 302/)
  add('dress')
  const external = recipe()
  external.portrait.imageUrl = 'https://attacker.example/image.png'
  const callsBefore = requested.length
  await assert.rejects(prepareOutfitGeneration(external, 5), /不是本机缓存图片/)
  assert.equal(requested.length, callsBefore, '不向外部 URL 发起下载')
  // 绝对回环地址视为本机缓存：宿主页面协议可能与插件 API 不同源。
  const loopbackRecipe = recipe()
  loopbackRecipe.portrait.imageUrl = `${base}api/outfit/person`
  const loopbackPrepared = await prepareOutfitGeneration(loopbackRecipe, 5)
  assert.equal(loopbackPrepared.images.length, 2)
  console.log('PASS 绝对回环参考图可加载')
  add('dress', new Uint8Array(10 * 1024 * 1024 + 1))
  await assert.rejects(prepareOutfitGeneration(recipe(), 5), /超过单张 10 MiB/)
  add('person', new Uint8Array(9 * 1024 * 1024))
  add('dress', new Uint8Array(8 * 1024 * 1024))
  await assert.rejects(prepareOutfitGeneration(recipe(), 5), /总大小超过 16 MiB/)
  console.log('PASS HTTP、类型、同源和大小失败不降级成少图提交')
}
await main()

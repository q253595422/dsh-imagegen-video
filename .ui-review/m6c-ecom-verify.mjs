/**
 * 第 6 批·电商模式 第三轮：修正上一轮的两个错误。
 * 上一轮把文件塞进了 index=0 的 input（不是主图参考图），5 张上限没测到；
 * 「套图结构」点了两次计数没变，需要看 data-active 变化确认到底有没有响应。
 *
 * F1 枚举所有 input[type=file]，按它所在的卡片标题归属
 * F2 主图参考图一次性给 5 张（上限写 4）：实际收几张、有没有提示
 * F3 风格参考图给 2 张（上限写 1）：静默替换还是拒绝
 * F4 套图结构：逐个 chip 点击，读 data-active / aria-pressed 与「将生成 N 张」
 * F5 文字折行：用 Range 逐行量，避免上一轮 height/lineHeight 的误判
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

const IMG_DIR = join(homedir(), '.dsh/dsh-imagegen/images')
const FIXTURES = readdirSync(IMG_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 8)
  .map(f => join(IMG_DIR, f))

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .find(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

/** input[type=file] 的 DOM 节点 id 列表 + 归属说明 */
const fileInputs = async (p) => {
  await p.send('DOM.enable')
  const doc = await p.send('DOM.getDocument', { depth: -1, pierce: true })
  const q = await p.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
  const ids = q.result.nodeIds || []
  const meta = await p.evaluate(`(()=>[...document.querySelectorAll('input[type=file]')].map((e,i)=>{
    const card=e.closest('div')
    return {i, accept:e.accept||'', multiple:e.multiple,
      near:((card&&card.innerText)||'').replace(/\\s+/g,' ').slice(0,60),
      hidden:getComputedStyle(e).display==='none'||e.getBoundingClientRect().width===0}
  }))()`)
  return { ids, meta }
}

const setFiles = async (p, nodeId, files) => {
  const r = await p.send('DOM.setFileInputFiles', { files, nodeId })
  await sleep(2200)
  return { ok: !r.error, err: r.error?.message || null }
}

const state = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const counters=[...t.matchAll(/(\\d+)\\/(\\d+)/g)].map(m=>m[0])
  const thumbs=[...v.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect(); return r.width>24&&r.height>24}).length
  return {counters, thumbs, sum:(t.match(/将生成 \\d+ 张套图/)||[''])[0],
    warn:/超出|最多|只能|已达上限|已替换|已忽略/.test(t),
    toast:[...v.querySelectorAll('[role=status],[role=alert],[class*="toast"],[class*="Toast"]')].map(e=>(e.innerText||'').trim().slice(0,80)).filter(Boolean)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2600)

  // ---------- F1 ----------
  const fi = await fileInputs(p)
  rec('f1-file-inputs', fi.meta)

  // ---------- F5 文字折行（Range 逐行）----------
  rec('f5-wrapped', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const out=[]
    for(const e of v.querySelectorAll('*')){
      if(e.children.length) continue
      const t=(e.textContent||'').trim(); if(!t||t.length<2) continue
      const r=e.getBoundingClientRect(); if(r.width<10||r.height<6) continue
      const rng=document.createRange(); rng.selectNodeContents(e)
      const rects=[...rng.getClientRects()]
      if(rects.length>1) out.push({t:t.slice(0,34),lines:rects.length,box:Math.round(r.width)+'x'+Math.round(r.height),
        lineH:Math.round(rects[0].height), y:Math.round(r.y)})
    }
    return out.slice(0,25)
  })()`))

  // ---------- F2 主图参考图：找归属「主图参考图」的 input ----------
  // 用「点卡片触发 file chooser」的方式无法在 headless 拿到；改按 accept + 上文文案匹配。
  const mainIdx = fi.meta.findIndex(m => /主体|包装|细节/.test(m.near))
  const styleIdx = fi.meta.findIndex(m => /风格参考图/.test(m.near))
  rec('f2-input-index', { mainIdx, styleIdx, total: fi.ids.length })

  if (mainIdx >= 0) {
    rec('f2-set-5', await setFiles(p, fi.ids[mainIdx], FIXTURES.slice(0, 5)))
    await sleep(1500)
    rec('f2-state', await state(p))
    R['f2-state'].shot = await p.shoot('158-m6c-ecom-main5')
  }

  // ---------- F3 风格参考图给 2 张 ----------
  if (styleIdx >= 0) {
    rec('f3-set-2', await setFiles(p, fi.ids[styleIdx], FIXTURES.slice(0, 2)))
    await sleep(1500)
    rec('f3-state', await state(p))
    R['f3-state'].shot = await p.shoot('159-m6c-ecom-style2')
  } else {
    rec('f3-skip', { reason: 'no style input', meta: fi.meta })
  }

  // ---------- F4 套图结构逐个 chip ----------
  const chipPoint = (label) => p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>new RegExp('^'+${JSON.stringify(label)}).test((e.innerText||'').trim()))
    if(!b) return null
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      active:b.hasAttribute('data-active'), pressed:b.getAttribute('aria-pressed'),
      text:(b.innerText||'').replace(/\\s+/g,' ').trim(),
      bg:getComputedStyle(b).backgroundColor, border:getComputedStyle(b).borderColor}
  })()`)

  const trace = []
  for (const name of ['卖点图', '场景图', '细节图', '主图']) {
    const before = await chipPoint(name)
    if (!before) { trace.push({ name, missing: true }); continue }
    await press(p, before.x, before.y, { wait: 900 })
    const after = await chipPoint(name)
    const st = await state(p)
    trace.push({ name, before: { active: before.active, pressed: before.pressed, text: before.text, bg: before.bg },
      after: { active: after?.active, pressed: after?.pressed, text: after?.text, bg: after?.bg }, sum: st.sum })
  }
  rec('f4-chips', trace)
  R['f4-chips'].shot = await p.shoot('160-m6c-ecom-chips')

  // 再截一张：把所有 chip 都点一遍后（看有没有哪个变成 0）
  rec('f4-final-state', await state(p))

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6c-ecom-verify.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

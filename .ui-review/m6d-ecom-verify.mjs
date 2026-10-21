/**
 * 第 6 批·电商模式 第四轮：修掉「点了但点在视口外」的问题。
 * 上一轮套图结构 chips 在 y≈1034，而视口高 1000 —— 点击落在视口外，等于没点。
 *
 * G1 滚动到「套图结构」再逐 chip 点击，读「将生成 N 张套图」与 chip 文本
 * G2 点「+ 上传风格参考图」后是否出现 file input
 * G3 商品名称留空时「生成套图预览」是禁用还是可点，禁用有没有说明原因
 * G4 填入商品名称后按钮是否变可用（确认 disabled 的唯一原因就是名称）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
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

/** 把某段文字滚进视口中部，再把它所在的可点元素中心点算出来 */
const chipPoint = (p, label) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(e=>new RegExp('^'+${JSON.stringify(label)}).test((e.innerText||'').trim()))
  if(!b) return null
  b.scrollIntoView({block:'center'})
  const r=b.getBoundingClientRect()
  const cs=getComputedStyle(b)
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    inViewport:r.top>=0&&r.bottom<=window.innerHeight,
    text:(b.innerText||'').replace(/\\s+/g,' ').trim(),
    active:b.hasAttribute('data-active'), pressed:b.getAttribute('aria-pressed'),
    bg:cs.backgroundColor, color:cs.color, border:cs.borderColor, opacity:cs.opacity}
})()`)

const sum = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return (t.match(/将生成 \\d+ 张套图/)||[''])[0]
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2600)

  // ---------- G3 名称空 → 生成按钮状态 ----------
  rec('g3-empty-name-button', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    if(!b) return {none:true}
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    const box=v.getBoundingClientRect()
    return {dis:b.disabled, title:b.getAttribute('title')||'', ariaDisabled:b.getAttribute('aria-disabled'),
      x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)}
  })()`))

  // 悬停在禁用按钮上，看有没有 title / tooltip 解释
  const btn = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  await press(p, btn.x, btn.y, { wait: 1500 })
  rec('g3-after-click-disabled', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {anyHint:/请填写商品名称|商品名称不能为空|请先填写|缺少/.test(t),
      tail:t.slice(-240),
      tooltips:[...document.querySelectorAll('[role=tooltip]')].map(e=>(e.innerText||'').trim().slice(0,80))}
  })()`))
  R['g3-after-click-disabled'].shot = await p.shoot('161-m6d-ecom-disabled-submit')

  // ---------- G4 填名称 → 按钮是否变可用 ----------
  const typed = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    if(!inp) return 'no-input'
    inp.focus()
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'测试商品-陶瓷马克杯')
    inp.dispatchEvent(new Event('input',{bubbles:true}))
    inp.dispatchEvent(new Event('change',{bubbles:true}))
    return inp.value
  })()`)
  await sleep(1200)
  rec('g4-after-name', { typed, state: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {disabled:b?b.disabled:'none', sum:(t.match(/将生成 \\d+ 张套图/)||[''])[0]}
  })()`)})
  R['g4-after-name'].shot = await p.shoot('162-m6d-ecom-name-filled')

  // ---------- G1 套图结构 chips（滚进视口再点）----------
  const trace = []
  for (const name of ['主图', '卖点图', '场景图', '细节图', '规格图', '使用图']) {
    const before = await chipPoint(p, name)
    if (!before) { trace.push({ name, missing: true }); continue }
    const sumBefore = await sum(p)
    await press(p, before.x, before.y, { wait: 900 })
    const after = await chipPoint(p, name)
    trace.push({ name, inViewport: before.inViewport,
      before: { text: before.text, active: before.active, bg: before.bg, color: before.color },
      after: { text: after?.text, active: after?.active, bg: after?.bg, color: after?.color },
      sumBefore, sumAfter: await sum(p) })
  }
  rec('g1-chips', trace)
  R['g1-chips'].shot = await p.shoot('163-m6d-ecom-chips-scrolled')

  // ---------- G2 风格参考图：点按钮后是否出现 file input ----------
  const before = await p.evaluate(`document.querySelectorAll('input[type=file]').length`)
  await tapText(p, '上传风格参考图')
  await sleep(1600)
  const after = await p.evaluate(`({
    count:document.querySelectorAll('input[type=file]').length,
    dialog:[...document.querySelectorAll('[role=dialog]')].map(d=>(d.innerText||'').replace(/\\s+/g,' ').slice(0,160)),
    accept:[...document.querySelectorAll('input[type=file]')].map(e=>e.accept)
  })`)
  rec('g2-style-input', { before, after })
  R['g2-style-input'].shot = await p.shoot('164-m6d-ecom-style-upload')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6d-ecom-verify.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

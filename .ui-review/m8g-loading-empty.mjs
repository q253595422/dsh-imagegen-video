/**
 * 第 8 批·G 组：加载态与空态取证（补齐六项里的「状态」）
 * G1 文生图点「开始生成」后 0.4s / 1.5s / 5s 的界面：按钮文案、禁用态、骨架/占位、进度
 * G2 生视频「先规划」点下去后的加载表现
 * G3 素材库真正空态（比例筛选到 0 条）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1100)) }

const press = async (p, x, y, w = 900) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const tapText = async (p, text, wait = 1800) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .find(e=>{const t=(e.innerText||'').replace(/\\s+/g,'').trim(); const r=e.getBoundingClientRect()
        return t===want&&r.width>0&&r.height>0})
    if(!hit) return null; hit.scrollIntoView({block:'center'})
    const r=hit.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y, wait)
  return true
}
const snap = (p) => p.evaluate(`(()=>{
  const gen=[...document.querySelectorAll('button')].find(b=>/开始生成|生成中|取消/.test(b.innerText||''))
  const gr=gen&&gen.getBoundingClientRect()
  const busy=document.querySelector('[aria-busy="true"],[class*=spinner],[class*=Spinner],[class*=skeleton],[class*=Skeleton],[class*=loading],[class*=Loading]')
  const res=[...document.querySelectorAll('[class*=result],[class*=Result]')].find(e=>e.getBoundingClientRect().width>200)
  return {btnText:gen?(gen.innerText||'').replace(/\\s+/g,' ').trim():null,
    btnDis:gen?gen.disabled:null, btnBox:gr?{t:Math.round(gr.top),h:Math.round(gr.height)}:null,
    busyEl:busy?{tag:busy.tagName.toLowerCase(),cls:(busy.className||'').toString().slice(0,30)}:null,
    resultText:res?(res.innerText||'').replace(/\\s+/g,' ').slice(0,160):null,
    tail:document.body.innerText.replace(/\\s+/g,' ').slice(-220)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---- G1 文生图加载
  const ta = await p.evaluate(`(()=>{const t=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!t) return null
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'a cat on a windowsill')
    t.dispatchEvent(new Event('input',{bubbles:true}))
    const r=t.getBoundingClientRect(); return {ok:true}})()`)
  rec('g1-prompt', ta)
  const gen = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/开始生成/.test(e.innerText||''))
    if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  if (gen) {
    await press(p, gen.x, gen.y, 400)
    rec('g1-t0.4', await snap(p)); R['g1-t0.4'].shot = await p.shoot('221-m8g-img-loading-0.4s')
    await sleep(1400)
    rec('g1-t1.8', await snap(p)); R['g1-t1.8'].shot = await p.shoot('222-m8g-img-loading-1.8s')
    await sleep(4000)
    rec('g1-t5.8', await snap(p)); R['g1-t5.8'].shot = await p.shoot('223-m8g-img-after-5.8s')
  }

  // ---- G2 视频「先规划」加载
  await tapText(p, '生视频', 2200)
  await sleep(1600)
  const vp = await p.evaluate(`(()=>{
    const t=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(t){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'a cat stretching, slow push in')
      t.dispatchEvent(new Event('input',{bubbles:true}))}
    const b=[...document.querySelectorAll('button')].find(e=>/规划|预览|Plan/i.test(e.innerText||'')&&!e.disabled&&e.getBoundingClientRect().width>60)
    if(!b) return {noBtn:true, btns:[...document.querySelectorAll('button')].map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,20)}
    const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(b.innerText||'').trim()}
  })()`)
  rec('g2-btn', vp)
  if (vp && !vp.noBtn) {
    await press(p, vp.x, vp.y, 600)
    rec('g2-t0.6', await snap(p)); R['g2-t0.6'].shot = await p.shoot('224-m8g-video-plan-0.6s')
    await sleep(2500)
    rec('g2-t3', await snap(p)); R['g2-t3'].shot = await p.shoot('225-m8g-video-plan-3s')
  }

  // ---- G3 素材库真正空态
  await tapText(p, '素材库', 2600)
  await sleep(2200)
  const ratio = await p.evaluate(`(()=>{
    const btns=[...document.querySelectorAll('button,[role=button],a,span')].filter(e=>{
      const t=(e.innerText||'').trim(); const r=e.getBoundingClientRect()
      return /^(21:9|16:9|4:3|3:4|1:1)$/.test(t)&&r.width>0&&r.height>0})
    const list=btns.map(e=>{const r=e.getBoundingClientRect(); return {t:e.innerText.trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})
    return list})
  `)
  rec('g3-ratios', ratio)
  // 找计数为 0 的比例
  const zero = await p.evaluate(`(()=>{
    const items=[...document.querySelectorAll('button,[role=button],li,div')].filter(e=>{
      const t=(e.innerText||'').trim(); const r=e.getBoundingClientRect()
      return /^21:9/.test(t)&&r.width>0&&r.width<200})
    const el=items[0]; if(!el) return null
    const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(el.innerText||'').trim()}
  })()`)
  rec('g3-zero-target', zero)
  if (zero) {
    await press(p, zero.x, zero.y, 1800)
    rec('g3-empty', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      const grid=document.querySelector('[class*=grid],[class*=Grid],[class*=waterfall]')
      return {count:(t.match(/共\\s*\\d+\\s*幅/)||[''])[0],
        hasEmptyHint:/没有|暂无|空|无匹配|试试/.test(t),
        text:t.slice(0,300), gridText:grid?(grid.innerText||'').replace(/\\s+/g,' ').slice(0,120):null,
        sel:/21:9/.test(([...document.querySelectorAll('[aria-pressed=true],[aria-selected=true]')].map(e=>e.innerText).join(' ')))}
    })()`))
    R['g3-empty'].shot = await p.shoot('226-m8g-gallery-empty')
  }

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8g-loading-empty.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

/**
 * 第 3 批补测 3。
 * 1) 「该模式需要一张参考图」在选图后是否消失（截图 58 显示它还在）。
 * 2) 视频模型控件 button 点开后有哪些项、能否切换、当前值怎么显示。
 * 3) 首尾帧 / 参考图 两种模式的字段与校验提示文案。
 * 4) 生图侧模型控件是不是同一套 button（用于“两套实现”这条结论定性）。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1500)

const R = {}
const log = (k, v) => { console.log(k, typeof v === 'string' ? v : JSON.stringify(v, null, 1)) }

const panel = () => p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return {t:t.slice(0,700), hints:(t.match(/该模式需要[^ ]*|至少需要[^ ]*/g)||[]),
    gen:(()=>{const b=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
      if(!b) return null; const cs=getComputedStyle(b)
      return {dis:b.disabled, ariaDis:b.getAttribute('aria-disabled'), title:b.getAttribute('title')||'',
        cursor:cs.cursor, bg:cs.backgroundColor}})()}
})()`)

const setMode = async m => {
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(m)}); if(b) b.click()})()`)
  await sleep(1100)
}
const injectImg = async () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const inp=v.querySelector('input[type=file]'); if(!inp) return {noInput:true}
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin=atob(b64); const u8=new Uint8Array(bin.length)
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i)
  const dt=new DataTransfer(); dt.items.add(new File([u8],'probe.png',{type:'image/png'}))
  inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}))
  return {ok:true, accept:inp.accept, multiple:inp.multiple}
})()`)

await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(1500)

// ---------- 1. 图生视频：选图前后提示对比 ----------
await setMode('图生视频')
R.i2v_before = await panel()
await injectImg(); await sleep(2200)
R.i2v_after = await panel()
R.shot_i2v_after = await p.shoot('m3c-i2v-after-image')

// 移除后再看
const removed = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()==='移除'); if(!b) return false; b.click(); return true})()`)
await sleep(1500)
R.removed = removed
R.i2v_removed = await panel()

// ---------- 2. 视频模型控件 ----------
await setMode('文生视频')
const modelBtn = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText)); if(!b) return null
  const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:b.innerText.trim(),
    ariaExpanded:b.getAttribute('aria-expanded'), ariaHaspopup:b.getAttribute('aria-haspopup'),
    role:b.getAttribute('role'), cls:String(b.className).slice(0,40)}})()`)
log('MODEL-BTN', modelBtn)
if (modelBtn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modelBtn.x, y: modelBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modelBtn.x, y: modelBtn.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  R.model_open = await p.evaluate(`(()=>{
    const list=[...document.querySelectorAll('[role=listbox],[role=menu],[role=option],[class*=menu],[class*=dropdown],[class*=popover]')]
    const vis=list.filter(e=>e.offsetParent!==null)
    return {count:vis.length,
      items:vis.flatMap(e=>[...e.querySelectorAll('[role=option],li,button')].map(x=>x.innerText.trim()).filter(Boolean)).slice(0,20),
      expanded:(()=>{const b=[...document.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText))
        return b?b.getAttribute('aria-expanded'):null})()}
  })()`)
  log('MODEL-OPEN', R.model_open)
  R.shot_model_open = await p.shoot('m3c-model-open')
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
}

// ---------- 3. 首尾帧 / 参考图 模式字段 ----------
for (const m of ['首尾帧', '参考图']) {
  await setMode(m)
  R['mode_' + m] = await panel()
  R['shot_' + m] = await p.shoot('m3c-mode-' + (m === '首尾帧' ? 'keyframe' : 'reference'))
}

// ---------- 4. 生图侧模型控件形态 ----------
await p.clickText('文生图', '[data-dsh-imagegen-view]').catch(() => {})
await sleep(1500)
R.img_model = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const btns=[...v.querySelectorAll('button')].filter(x=>/gpt-image|seedream|nano|banana|grok|agnes/.test(x.innerText)).slice(0,4)
  return {count:btns.length, items:btns.map(x=>({t:x.innerText.trim().slice(0,40),
    role:x.getAttribute('role'), expanded:x.getAttribute('aria-expanded'),
    haspopup:x.getAttribute('aria-haspopup'), cls:String(x.className).slice(0,34)})),
    selects:v.querySelectorAll('select').length}
})()`)
log('IMG-MODEL', R.img_model)
R.shot_img_model = await p.shoot('m3c-img-model')

writeFileSync(join(SHOT_DIR, '..', 'm3c-video.json'), JSON.stringify(R, null, 2))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

/**
 * 第 3 批补测定点（消除上一轮的模式切换歧义）。
 * 先证明「图生视频」确实被切到（读四个 tab 的计算样式），再做三件事：
 *  1) 空态下提示文案与生成按钮态；2) 注入参考图后提示是否消失、按钮是否变可用；3) 移除后再看。
 * 4) 打开视频模型下拉，dump 该弹层的全部可见文本与 role，判断它是不是可访问的下拉。
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
await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(1800)

const R = {}

/** 四个模式 tab 的当前态：靠计算样式判断谁被选中（无 ARIA，只能看样式）。 */
const tabs = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  return [...v.querySelectorAll('button')]
    .filter(b=>['文生视频','图生视频','首尾帧','参考图'].includes(b.innerText.trim()))
    .map(b=>{const cs=getComputedStyle(b)
      return {t:b.innerText.trim(), fw:cs.fontWeight, bg:cs.backgroundColor, color:cs.color,
        bc:cs.borderColor, aria:b.getAttribute('aria-pressed'), cls:String(b.className).slice(0,30)}})
})()`)

/** 面板关键事实：提示文案、生成按钮、有没有参考图区 */
const facts = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const g=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
  const cs=g?getComputedStyle(g):null
  return {
    modeTabs:(()=>{const r=[];for(const b of v.querySelectorAll('button')){
      if(!['文生视频','图生视频','首尾帧','参考图'].includes(b.innerText.trim()))continue
      const c=getComputedStyle(b); r.push(b.innerText.trim()+'|fw='+c.fontWeight+'|bg='+c.backgroundColor+'|bd='+c.borderColor) }
      return r.join('  ')})(),
    hasRefSection: t.includes('参考图') && (t.includes('选择图片')||t.includes('移除')),
    hints:(t.match(/该模式需要一张参考图|至少需要一张首帧/g)||[]),
    gen:g?{dis:g.disabled, cursor:cs.cursor, bg:cs.backgroundColor, ariaDis:g.getAttribute('aria-disabled'), title:g.getAttribute('title')||''}:null,
    thumbs:v.querySelectorAll('img').length,
    fileInputs:v.querySelectorAll('input[type=file]').length
  }
})()`)

const clickMode = async name => {
  const hit = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const bs=[...v.querySelectorAll('button')].filter(b=>b.innerText.trim()===${JSON.stringify(name)})
    if(!bs.length) return {found:0}
    const b=bs[0]; const r=b.getBoundingClientRect()
    return {found:bs.length, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}
  })()`)
  if (hit.x != null) {
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  }
  await sleep(1200)
  return hit
}

// ---------- 切到图生视频 ----------
R.i2vClick = await clickMode('图生视频')
R.i2v_tabs = await tabs()
R.i2v_empty = await facts()
R.shot_empty = await p.shoot('m3d-i2v-empty')

// ---------- 注入参考图 ----------
R.inject = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const inp=v.querySelector('input[type=file]'); if(!inp) return {noInput:true}
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin=atob(b64); const u8=new Uint8Array(bin.length)
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i)
  const dt=new DataTransfer(); dt.items.add(new File([u8],'probe.png',{type:'image/png'}))
  inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}))
  return {ok:true, accept:inp.accept,multiple:inp.multiple}
})()`)
await sleep(2500)
R.i2v_filled = await facts()
R.shot_filled = await p.shoot('m3d-i2v-filled')

// ---------- 移除 ----------
R.removeClicked = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()==='移除'); if(!b) return false; b.click(); return true})()`)
await sleep(1800)
R.i2v_removed = await facts()
R.shot_removed = await p.shoot('m3d-i2v-removed')

// ---------- 视频模型下拉：dump 弹层 ----------
const mb = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText)); if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
if (mb) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mb.x, y: mb.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mb.x, y: mb.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  R.popup = await p.evaluate(`(()=>{
    const cand=[...document.querySelectorAll('body > div, body > div *')].filter(e=>{
      const cs=getComputedStyle(e)
      return (cs.position==='fixed'||cs.position==='absolute') && e.offsetParent!==null && e.innerText && e.innerText.trim()
    })
    const top=cand.filter(e=>!/^[\\s\\S]{400,}/.test(e.innerText))
    return {n:cand.length,
      texts:[...new Set(cand.map(e=>e.innerText.replace(/\\s+/g,' ').trim()))].filter(s=>s.length<200).slice(0,12),
      roles:[...new Set([...document.querySelectorAll('[role=listbox],[role=option],[role=menu],[role=menuitem]')].map(e=>e.getAttribute('role')))],
      expanded:(()=>{const b=[...document.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText));return b?b.getAttribute('aria-expanded'):null})()}
  })()`)
  R.shot_popup = await p.shoot('m3d-model-popup')
  // 关掉
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
}

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o && o[k]]))
console.log('I2V-EMPTY', JSON.stringify(pick(R.i2v_empty, ['modeTabs', 'hasRefSection', 'hints', 'gen', 'fileInputs']), null, 1))
console.log('I2V-FILLED', JSON.stringify(pick(R.i2v_filled, ['modeTabs', 'hasRefSection', 'hints', 'gen', 'thumbs']), null, 1))
console.log('I2V-REMOVED', JSON.stringify(pick(R.i2v_removed, ['hasRefSection', 'hints', 'gen', 'thumbs']), null, 1))
console.log('POPUP', JSON.stringify(R.popup, null, 1))

writeFileSync(join(SHOT_DIR, '..', 'm3d-video.json'), JSON.stringify(R, null, 2))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

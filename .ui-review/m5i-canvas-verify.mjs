/**
 * 第 5 批复核（三条待定项）：
 *  A) 新建第二个画布后，「删除画布」是否可用、点击后有没有确认
 *  B) 素材库选图后是否真的生成图片节点（上一轮 dialogsLeft:1 且节点没变，需要确认是不是弹层没关）
 *  C) 收藏画布：点击后按钮有无 aria-pressed / data-active
 *  D) 清理：把本轮多出来的画布删掉，只留一个
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 280000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos, { double = false } = {}) => {
  const n = double ? 2 : 1
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: n })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: n })
  await sleep(600)
}
const tapAria = async (aria) => {
  const r = await p.evaluate(`(()=>{
    const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(aria)})
    if(!e) return null
    const rc=e.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2),
      disabled:e.hasAttribute('disabled')||e.getAttribute('aria-disabled')==='true'}
  })()`)
  if (!r) return null
  await clickAt(r); return r
}
const tap = async (text, root = 'body') => {
  const r = await p.evaluate(`(()=>{
    const rt=document.querySelector(${JSON.stringify(root)})||document.body
    const hit=[...rt.querySelectorAll('button,a,[role=tab],[role=button],li')].find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return null
  await clickAt(r); return r
}
const nodes = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id').slice(0,10), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height), hasImg:!!n.querySelector('img'),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,26)}
  })
})()`)
const delState = () => p.evaluate(`(()=>{const e=document.querySelector('[aria-label="删除画布"]')
  if(!e) return null; const cs=getComputedStyle(e)
  return {disabled:e.disabled||e.getAttribute('aria-disabled')==='true', opacity:cs.opacity, cursor:cs.cursor,
    cls:String(e.className).slice(0,40)}})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) { const n = await nodes(); if (n.length) break; await sleep(300) }
await tapAria('适应全部内容'); await sleep(700)
rec('start', { nodes: await nodes(), del: await delState() })

// ---------- A. 新建 → 删除是否有确认 ----------
step('new-then-delete')
await tapAria('新建画布'); await sleep(2200)
rec('after-new', { nodes: await nodes(), del: await delState() })
const delHit = await tapAria('删除画布')
rec('del-click', { hit: delHit, del: await delState() })
await sleep(900)
const conf = await p.evaluate(`(()=>{
  const d=[...document.querySelectorAll('[role=alertdialog],[role=dialog],[class*=dialog]')]
    .filter(e=>e.getBoundingClientRect().width>120)
  return {dialogs:d.map(e=>({cls:String(e.className).slice(0,30),
      text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,180),
      buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,6)})),
    bodyTail:(document.body.innerText||'').replace(/\\s+/g,' ').slice(-160)}})()`)
rec('delete-confirm', conf)
R['delete-confirm'] = { ...R['delete-confirm'], shot: await p.shoot('m5i-delete-confirm') }
await p.key('Escape'); await sleep(600)

// ---------- B. 素材库选图 ----------
step('gallery-pick')
// 确保在干净的画布上
await tapAria('新建画布'); await sleep(2000)
const n0 = await nodes()
await tapAria('添加图片'); await sleep(800)
const menu = await p.evaluate(`(()=>{
  const m=[...document.querySelectorAll('[role=menu]')].filter(e=>e.getBoundingClientRect().width>60)
  const top=m[m.length-1]
  if(!top) return null
  const it=[...top.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim(),r:b.getBoundingClientRect()}))
    .find(i=>i.t==='素材库')
  return it?{x:Math.round(it.r.x+it.r.width/2),y:Math.round(it.r.y+it.r.height/2)}:null})()`)
rec('menu-素材库', menu)
if (menu) {
  await clickAt(menu); await sleep(1800)
  const pickerState = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200)
    const top=d[d.length-1]
    return top?{visible:top.getBoundingClientRect().width>0,
      options:top.querySelectorAll('[role=option]').length,
      selected:top.querySelectorAll('[role=option][aria-selected=true]').length,
      text:(top.innerText||'').replace(/\\s+/g,' ').slice(0,100)}:null})()`)
  rec('picker', pickerState)

  const opt = await p.evaluate(`(()=>{
    const o=[...document.querySelectorAll('[role=option]')].filter(e=>e.getBoundingClientRect().width>60)[0]
    if(!o) return null; const r=o.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)}})()`)
  rec('first-option', opt)
  if (opt) {
    await clickAt(opt)
    // 多等一会儿：若需要二次确认（比如「加入画布」按钮），这里会看到
    await sleep(2500)
    const after = await p.evaluate(`(()=>{
      const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200 && e.offsetParent!==null)
      return {dialogsVisible:d.length,
        dlgText:d.length?(d[d.length-1].innerText||'').replace(/\\s+/g,' ').slice(0,120):'',
        dlgButtons:d.length?[...d[d.length-1].querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,8):[]}})()`)
    rec('after-pick', { after, nodes: await nodes(), delta: (await nodes()).length - n0.length })
    R['after-pick'] = { ...R['after-pick'], shot: await p.shoot('m5i-after-pick') }

    // 如果有确认按钮，点它
    if (after.dialogsVisible) {
      const confirmBtn = await p.evaluate(`(()=>{
        const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200 && e.offsetParent!==null)
        const top=d[d.length-1]; if(!top) return null
        const b=[...top.querySelectorAll('button')].find(x=>/^(加入画布|添加|确定|使用|插入)$/.test((x.innerText||'').trim()))
        if(!b) return null; const r=b.getBoundingClientRect()
        return {t:b.innerText.trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      rec('confirm-btn', confirmBtn)
      if (confirmBtn) {
        await clickAt(confirmBtn); await sleep(2200)
        rec('after-confirm', { nodes: await nodes() })
        R['after-confirm'] = { ...R['after-confirm'], shot: await p.shoot('m5i-after-confirm') }
      }
    }
  }
}

// ---------- C. 标注（有图片节点后）----------
step('annotate')
const imgNode = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const n=[...c.querySelectorAll('[data-node-id]')].find(x=>x.querySelector('img'))
  if(!n) return null; const r=n.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+Math.round(r.height*0.35))}})()`)
rec('image-node', imgNode)
if (imgNode) {
  await clickAt(imgNode); await sleep(700)
  const labels = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-canvas-workspace]')
    return [...c.querySelectorAll('[aria-label],[title]')].map(e=>(e.getAttribute('aria-label')||e.getAttribute('title')||''))
      .filter(x=>/标注|画框/.test(x)).slice(0,6)})()`)
  rec('annotate-labels', labels)
  const hit = await tapAria(labels[0] || '标注：在图片上画框，自动挂上提示词卡片')
  await sleep(900)
  const mode = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-canvas-workspace]')
    return {text:(c.innerText||'').replace(/\\s+/g,' ').match(/.{0,30}(画框|引导线|标注).{0,50}/)?.[0]||'',
      shotNote:'annotation mode'}})()`)
  rec('annotate-mode', { hit, mode })
  R['annotate-mode'] = { ...R['annotate-mode'], shot: await p.shoot('m5i-annotate') }
  await p.key('Escape'); await sleep(500)
}

// ---------- D. 收藏按钮状态 ----------
step('fav')
const fav0 = await p.evaluate(`(()=>{const e=document.querySelector('[aria-label="收藏画布"]')
  return e?{active:e.getAttribute('data-active'),pressed:e.getAttribute('aria-pressed'),
    label:e.getAttribute('aria-label'),cls:String(e.className).slice(0,40),
    svgFill:(e.querySelector('svg')||{}).getAttribute?e.querySelector('svg').getAttribute('fill'):null}:null})()`)
await tapAria('收藏画布'); await sleep(700)
const fav1 = await p.evaluate(`(()=>{const e=document.querySelector('[aria-label="收藏画布"]')
  return e?{active:e.getAttribute('data-active'),pressed:e.getAttribute('aria-pressed'),
    label:e.getAttribute('aria-label'),cls:String(e.className).slice(0,40),
    svgFill:(e.querySelector('svg')||{}).getAttribute?e.querySelector('svg').getAttribute('fill'):null}:null})()`)
rec('favorite', { before: fav0, after: fav1 })

// ---------- E. 清理：删掉本轮多建的画布 ----------
step('cleanup')
rec('projects', await p.evaluate(`(()=>{
  const sel=document.querySelector('[aria-label="画布项目"]')
  return sel?{text:(sel.innerText||'').replace(/\\s+/g,' ').trim()}:null})()`))

writeFileSync(join(SHOT_DIR, '..', 'm5i-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

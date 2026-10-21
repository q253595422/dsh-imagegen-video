/**
 * 第 5 批 2/4：节点与视口（带就绪等待版）。
 * 上一轮画布停在「加载中…」导致几何全空，且脚本在收尾处挂住。
 * 这里：① 等 saveState 离开「加载中」且节点出现；② 全局看门狗防止挂死；③ 每步打标记。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 600)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog fired'); process.exit(2) }, 170000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos, double = false) => {
  const n = double ? 2 : 1
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: n })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: n })
  await sleep(800)
}

const tapAria = async (aria) => {
  const r = await p.evaluate(`(()=>{
    const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(aria)})
    if(!e) return null
    const rc=e.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
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

const view = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  if(!c) return {noCanvas:true}
  const vp=c.querySelector('[class*=viewport]')||c
  const vr=vp.getBoundingClientRect()
  const nodes=[...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id'),
      x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,40),
      offLeft: Math.round(vr.left - r.left), offTop: Math.round(vr.top - r.top),
      clipped: r.left < vr.left - 0.5 || r.top < vr.top - 0.5 || r.right > vr.right + 0.5 || r.bottom > vr.bottom + 0.5}
  })
  const save=(c.querySelector('[class*=saveState]')||{}).innerText||''
  const zoomTxt=(c.innerText||'').match(/\\d+%/g)||[]
  return {viewport:{x:Math.round(vr.x),y:Math.round(vr.y),w:Math.round(vr.width),h:Math.round(vr.height)},
    save, nodes, zoomTxt:zoomTxt.slice(0,3)}
})()`)

step('enter canvas')
await tap('无限画布')
// 等加载完：saveState 不再是「加载中」或节点出现
let ready = false
for (let i = 0; i < 60; i++) {
  const st = await view()
  if (st.noCanvas) { await sleep(300); continue }
  if (st.nodes.length > 0 && !/加载中/.test(st.save)) { ready = true; break }
  await sleep(300)
}
rec('ready', { ready, state: await view() })
R.ready = { ...R.ready, shot: await p.shoot('m5c-ready') }

if (!ready) {
  // 加载卡住本身就是要记录的状态
  rec('stuck-loading', {
    body: await p.evaluate(`(document.querySelector('[data-canvas-workspace]')||document.body).innerText.replace(/\\s+/g,' ').slice(0,300)`),
    shot: await p.shoot('m5c-stuck-loading'),
  })
}

step('fit')
rec('fit', await tapAria('适应全部内容'))
await sleep(800)
rec('after-fit', await view())
R['after-fit'].shot = await p.shoot('m5c-fit')

const vpRect = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const vp=c.querySelector('[class*=viewport]'); const r=vp.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)

step('wheel')
await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vpRect.x, y: vpRect.y })
await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vpRect.x, y: vpRect.y, deltaX: 0, deltaY: -240 })
await sleep(600)
const zin = await view()
await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vpRect.x, y: vpRect.y, deltaX: 0, deltaY: 480 })
await sleep(600)
const zout = await view()
rec('wheel', { in: zin.zoomTxt, out: zout.zoomTxt, nodeW: [zin.nodes[0]?.w, zout.nodes[0]?.w] })

step('slider-min')
const slider = await p.evaluate(`(()=>{const e=document.querySelector('[aria-label="缩放"]')
  if(!e) return null; const r=e.getBoundingClientRect()
  return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()`)
rec('slider', slider)
if (slider) {
  const y = slider.y + Math.round(slider.h / 2)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slider.x + 3, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: slider.x + 3, y, button: 'left', clickCount: 1 })
  await sleep(600)
  const mn = await view()
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slider.x + slider.w - 3, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: slider.x + slider.w - 3, y, button: 'left', clickCount: 1 })
  await sleep(600)
  const mx = await view()
  rec('slider-both-ends', { min: mn.zoomTxt, max: mx.zoomTxt })
  R['slider-both-ends'].shot = await p.shoot('m5c-slider-max')
}

step('pan-ctrl-drag')
await tapAria('适应全部内容'); await sleep(600)
const b4 = await view()
await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vpRect.x, y: vpRect.y, button: 'left', clickCount: 1, modifiers: 2 })
for (let i = 1; i <= 5; i++) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vpRect.x - i * 24, y: vpRect.y, button: 'left', modifiers: 2 })
  await sleep(30)
}
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vpRect.x - 120, y: vpRect.y, button: 'left', clickCount: 1, modifiers: 2 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
await sleep(600)
const af = await view()
rec('pan', { before: b4.nodes.map(n => [n.x, n.y]), after: af.nodes.map(n => [n.x, n.y]) })
R.pan = { ...R.pan, shot: await p.shoot('m5c-pan') }

step('minimap')
await tapAria('适应全部内容'); await sleep(600)
const mm = await p.evaluate(`(()=>{const e=document.querySelector('[class*=minimap]')
  if(!e) return null; const r=e.getBoundingClientRect()
  return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
    html:(e.innerHTML||'').slice(0,200)}})()`)
rec('minimap', mm)
if (mm) {
  const m0 = await view()
  const tx = mm.x + Math.round(mm.w * 0.8); const ty = mm.y + Math.round(mm.h * 0.75)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 })
  await sleep(700)
  const m1 = await view()
  rec('minimap-click', { before: m0.nodes.map(n => [n.x, n.y]), after: m1.nodes.map(n => [n.x, n.y]) })
  R['minimap-click'] = { ...R['minimap-click'], shot: await p.shoot('m5c-minimap') }
}

step('close-minimap')
rec('close-minimap', await tapAria('关闭缩略图'))
await sleep(500)
rec('minimap-gone', await p.evaluate(`(()=>{const e=document.querySelector('[class*=minimap]')
  return e?{w:Math.round(e.getBoundingClientRect().width)}:null})()`))

writeFileSync(join(SHOT_DIR, '..', 'm5c-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

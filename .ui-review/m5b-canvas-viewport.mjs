/**
 * 第 5 批 2/4：节点与视口。
 * 1) 枚举画布节点（data-node-id）的屏幕矩形，和视口矩形对比，看默认布局是否被裁
 * 2) 「适应全部内容」前后 zoom 与节点位置
 * 3) 滚轮缩放 / 拖动平移 / 缩放滑块的百分比文案
 * 4) 小地图点一下是否改变视口
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 600)) }

const s = await openStudio()
const p = s.page

const clickAt = async (pos, double = false) => {
  const n = double ? 2 : 1
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: n })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: n })
  await sleep(900)
}

const tapAria = async (aria) => {
  const r = await p.evaluate(`(()=>{
    const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(aria)})
    if(!e) return null
    const rc=e.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return null
  await clickAt(r)
  return r
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

/** 画布状态快照 */
const view = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const vp=c.querySelector('[class*=viewport]')||c
  const vr=vp.getBoundingClientRect()
  const nodes=[...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id'), kind:n.getAttribute('data-node-kind')||'',
      x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,50),
      clipped: r.left < vr.left - 0.5 || r.top < vr.top - 0.5 || r.right > vr.right + 0.5 || r.bottom > vr.bottom + 0.5}
  })
  const zoomTxt=(c.innerText||'').match(/\\d+%/g)||[]
  return {viewport:{x:Math.round(vr.x),y:Math.round(vr.y),w:Math.round(vr.width),h:Math.round(vr.height)},
    nodes, zoomTxt:zoomTxt.slice(0,3)}
})()`)

await tap('无限画布'); await sleep(2600)
rec('initial', await view())
R['initial'].shot = await p.shoot('m5b-nodes-initial')

// ---------- 1. 适应全部内容 ----------
rec('fit', await tapAria('适应全部内容'))
await sleep(900)
rec('after-fit', await view())
R['after-fit'].shot = await p.shoot('m5b-nodes-fit')

// ---------- 2. 滚轮缩放 ----------
const center = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const vp=c.querySelector('[class*=viewport]'); const r=vp.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y })
await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -240 })
await sleep(700)
rec('wheel-in', await view())
await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 480 })
await sleep(700)
rec('wheel-out', await view())
R['wheel-out'].shot = await p.shoot('m5b-wheel-out')

// 缩放滑块：点最左端
const slider = await p.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="缩放"]')][0]
  if(!e) return null; const r=e.getBoundingClientRect()
  return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()`)
rec('slider', slider)
if (slider) {
  const y = slider.y + Math.round(slider.h / 2)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slider.x + 4, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slider.x + 4, y, button: 'left' })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: slider.x + 4, y, button: 'left', clickCount: 1 })
  await sleep(700)
  rec('slider-min', await view())
}

// ---------- 3. 空格 + 拖动 平移 ----------
await tapAria('适应全部内容'); await sleep(700)
const before = await view()
await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 6; i++) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x - i * 20, y: center.y, button: 'left' })
  await sleep(40)
}
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x - 120, y: center.y, button: 'left', clickCount: 1 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await sleep(700)
const after = await view()
rec('pan', { before: before.viewport, after: after.viewport,
  nodeMoved: before.nodes.map((n, i) => after.nodes[i] ? after.nodes[i].x - n.x : null) })
R['pan'].shot = await p.shoot('m5b-pan')

// ---------- 4. 小地图点击 ----------
await tapAria('适应全部内容'); await sleep(700)
const mm = await p.evaluate(`(()=>{const e=document.querySelector('[class*=minimap]')
  if(!e) return null; const r=e.getBoundingClientRect()
  return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()`)
rec('minimap', mm)
if (mm) {
  const v0 = await view()
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mm.x + Math.round(mm.w * 0.85), y: mm.y + Math.round(mm.h * 0.8), button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mm.x + Math.round(mm.w * 0.85), y: mm.y + Math.round(mm.h * 0.8), button: 'left', clickCount: 1 })
  await sleep(800)
  const v1 = await view()
  rec('minimap-click', { before: v0.nodes.map(n => [n.x, n.y]), after: v1.nodes.map(n => [n.x, n.y]), zoom: v1.zoomTxt })
  R['minimap-click'].shot = await p.shoot('m5b-minimap-click')
}

rec('doc-overflow', await p.docOverflow())
writeFileSync(join(SHOT_DIR, '..', 'm5b-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

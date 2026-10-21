/**
 * 第 5 批收尾：
 *  A) 空格 / Ctrl 两种临时平移的真实状态（读 cursor + 是否移动）
 *  B) 标注（annotation）入口与行为
 *  C) 画布项目下拉的真实清单（m5d/m5e 新建过画布与节点，需要核查并清理）
 *  D) 清理：删掉本轮测试新增的节点，避免污染用户画布
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 600)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 280000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(550)
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
const nodes = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id'), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,36)}
  })
})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) { const n = await nodes(); if (n.length) break; await sleep(300) }
await tapAria('适应全部内容'); await sleep(700)
rec('start-nodes', await nodes())

const vp = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const v=c.querySelector('[class*=viewport]'); const r=v.getBoundingClientRect()
  return {x:Math.round(r.x+r.width*0.42),y:Math.round(r.y+r.height*0.76)}})()`)

// ---------- A1. 空格 ----------
step('space')
await clickAt(vp)
const s0 = await nodes()
const cur0 = await p.evaluate(`getComputedStyle(document.querySelector('[class*=viewport]')).cursor`)
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' })
await sleep(300)
const cur1 = await p.evaluate(`getComputedStyle(document.querySelector('[class*=viewport]')).cursor`)
const cls1 = await p.evaluate(`document.querySelector('[class*=viewport]').className`)
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 6; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - i * 20, y: vp.y, button: 'left', buttons: 1 }); await sleep(25) }
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x - 120, y: vp.y, button: 'left', buttons: 0, clickCount: 1 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
await sleep(500)
const s1 = await nodes()
rec('space', { cursorBefore: cur0, cursorWhileSpace: cur1, viewportClassWhileSpace: String(cls1).slice(0, 80),
  moved: s0.map((n, i) => s1[i] ? s1[i].x - n.x : null) })

// ---------- A2. Ctrl ----------
step('ctrl')
await tapAria('适应全部内容'); await sleep(600)
const c0 = await nodes()
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 59, modifiers: 2 })
await sleep(300)
const cur2 = await p.evaluate(`getComputedStyle(document.querySelector('[class*=viewport]')).cursor`)
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 })
for (let i = 1; i <= 6; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x + i * 20, y: vp.y, button: 'left', buttons: 1, modifiers: 2 }); await sleep(25) }
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x + 120, y: vp.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 59 })
await sleep(500)
const c1 = await nodes()
rec('ctrl', { cursorWhileCtrl: cur2, moved: c0.map((n, i) => c1[i] ? c1[i].x - n.x : null) })

// ---------- A3. 中键 ----------
step('middle')
await tapAria('适应全部内容'); await sleep(600)
const m0 = await nodes()
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'middle', buttons: 4, clickCount: 1 })
for (let i = 1; i <= 6; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y - i * 20, button: 'middle', buttons: 4 }); await sleep(25) }
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x, y: vp.y - 120, button: 'middle', buttons: 0, clickCount: 1 })
await sleep(500)
const m1 = await nodes()
rec('middle', { moved: m0.map((n, i) => m1[i] ? m1[i].y - n.y : null) })

// ---------- B. 标注 ----------
step('annotation')
// 选中一个节点，看有没有「标注/批注」
await tapAria('适应全部内容'); await sleep(600)
const npos = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const n=c.querySelector('[data-node-id]'); if(!n) return null
  const r=n.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+16)}})()`)
if (npos) {
  await clickAt(npos)
  await sleep(500)
  const labels = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-canvas-workspace]')
    return [...c.querySelectorAll('[aria-label],[title]')].map(e=>(e.getAttribute('aria-label')||e.getAttribute('title')||'')).filter(Boolean)
      .filter(x=>/标注|批注|注解|画框|箭头|区域/.test(x)).slice(0,10)})()`)
  rec('annotation-labels', labels)
  R['annotation-labels'] = { ...R['annotation-labels'], shot: await p.shoot('m5g-annotations') }
}

// ---------- C. 画布项目清单 ----------
step('projects')
const projBtn = await p.evaluate(`(()=>{const b=document.querySelector('[aria-label="画布项目"]')
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(b.innerText||'').trim()}})()`)
rec('project-btn', projBtn)
if (projBtn) {
  await clickAt(projBtn)
  await sleep(800)
  const list = await p.evaluate(`(()=>{
    const items=[...document.querySelectorAll('[role=option],[role=menuitem],li,[class*=option]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>80 && r.height>18 && e.offsetParent!==null})
      .map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30), role:e.getAttribute('role')||''}))
    return items.slice(0,15)})()`)
  rec('project-list', list)
  R['project-list'] = { ...R['project-list'], shot: await p.shoot('m5g-project-list') }
  await p.key('Escape'); await sleep(400)
}

writeFileSync(join(SHOT_DIR, '..', 'm5g-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

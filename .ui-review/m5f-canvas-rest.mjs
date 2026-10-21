/**
 * 第 5 批补：m5d 在「技能库」处被看门狗截断，剩 5 个工具没测；另外补空格平移与连线。
 * 注意 m5d 已经在真实画布里加了 文本/画板/配置/分镜 四个节点，本轮跑完要清掉。
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
    return {id:n.getAttribute('data-node-id').slice(0,10), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,36)}
  })
})()`)
/** 只取「对话框/菜单」类层，排除常驻面板 */
const dialog = () => p.evaluate(`(()=>{
  const cands=[...document.querySelectorAll('[role=dialog],[role=menu],[aria-modal=true],[class*=modal],[class*=picker],[class*=overlay],[class*=panel]')]
    .filter(e=>{const r=e.getBoundingClientRect()
      const cs=getComputedStyle(e)
      return r.width>150 && r.height>60 && cs.display!=='none' && cs.visibility!=='hidden'
        && parseFloat(cs.opacity||'1')>0.5 && !/P3OORG/.test(String(e.className))})
  return cands.slice(0,3).map(e=>({cls:String(e.className).slice(0,28), role:e.getAttribute('role')||'',
    text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,300),
    buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()||b.getAttribute('aria-label')||'').filter(Boolean).slice(0,10)}))
})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) { const n = await nodes(); if (n.length) break; await sleep(300) }
await tapAria('适应全部内容'); await sleep(700)
rec('start', { nodes: await nodes(), shot: await p.shoot('m5f-start') })

// ---------- 1. 空格平移（先点画布确保焦点在画布内）----------
step('space-pan')
const vp = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const v=c.querySelector('[class*=viewport]'); const r=v.getBoundingClientRect()
  return {x:Math.round(r.x+r.width*0.45),y:Math.round(r.y+r.height*0.75)}})()`)
await clickAt(vp) // 把焦点交给画布背景
const n0 = await nodes()
await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
await sleep(250)
const cursor = await p.evaluate(`(()=>{const c=document.querySelector('[class*=viewport]')
  return getComputedStyle(c).cursor})()`)
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 8; i++) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - i * 18, y: vp.y - i * 8, button: 'left', buttons: 1 })
  await sleep(25)
}
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x - 144, y: vp.y - 64, button: 'left', buttons: 0, clickCount: 1 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await sleep(500)
const n1 = await nodes()
rec('space-pan', { cursorWhileSpace: cursor, before: n0.map(n => [n.x, n.y]), after: n1.map(n => [n.x, n.y]) })

// ---------- 2. 剩余工具 ----------
for (const [aria, key] of [
  ['技能库', 'toolSkills'],
  ['时间线编辑', 'toolTimeline'],
  ['画布背景', 'toolBackground'],
  ['快捷键', 'toolShortcut'],
]) {
  step('tool ' + aria)
  const beforeN = (await nodes()).length
  const hit = await tapAria(aria)
  await sleep(1300)
  const dlg = await dialog()
  const afterN = (await nodes()).length
  rec(key, { hit: !!hit, nodeDelta: afterN - beforeN, dialog: dlg, shot: await p.shoot('m5f-' + key) })
  await p.key('Escape'); await sleep(450)
  rec(key + '-esc', { dialog: await dialog() })
}

// ---------- 3. 运行工作流（无选中时）----------
step('workflow')
const wf = await p.evaluate(`(()=>{
  const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')==='运行工作流（从选中节点往下）')
  if(!e) return null
  const r=e.getBoundingClientRect()
  return {disabled:e.hasAttribute('disabled')||e.getAttribute('aria-disabled')==='true', w:Math.round(r.width),
    cls:String(e.className).slice(0,40), aria:e.getAttribute('aria-label')}})()`)
rec('workflow-btn', wf)
if (wf) {
  const r = await p.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')==='运行工作流（从选中节点往下）')
    const rc=e.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}})()`)
  await clickAt(r); await sleep(1200)
  rec('workflow-click', { dialog: await dialog(), toasts: await p.evaluate(`(()=>{
    return [...document.querySelectorAll('[role=status],[role=alert]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,150))})()`),
    shot: await p.shoot('m5f-workflow-click') })
}

// ---------- 4. 连线：从节点右缘拖到另一节点左缘 ----------
step('connect')
await tapAria('适应全部内容'); await sleep(600)
const pair = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const ns=[...c.querySelectorAll('[data-node-id]')].map(n=>{const r=n.getBoundingClientRect()
    return {x:r.x,y:r.y,w:r.width,h:r.height,t:(n.innerText||'').replace(/\\s+/g,' ').slice(0,20)}})
  if(ns.length<2) return null
  // 找两个左右并排的节点
  const [a,b]=ns.slice(0,2)
  return {a:{x:Math.round(a.x+a.w-6),y:Math.round(a.y+a.h*0.5),t:a.t},
          b:{x:Math.round(b.x+6),y:Math.round(b.y+b.h*0.5),t:b.t}}})()`)
rec('connect-pair', pair)
if (pair) {
  const hitsBefore = await p.evaluate(`document.querySelectorAll('[data-connection-hit]').length`)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pair.a.x, y: pair.a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      x: pair.a.x + Math.round((pair.b.x - pair.a.x) * i / 10),
      y: pair.a.y + Math.round((pair.b.y - pair.a.y) * i / 10), button: 'left', buttons: 1 })
    await sleep(30)
  }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pair.b.x, y: pair.b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(900)
  const hitsAfter = await p.evaluate(`document.querySelectorAll('[data-connection-hit]').length`)
  rec('connect-result', { hitsBefore, hitsAfter, shot: await p.shoot('m5f-connect') })
}

// ---------- 5. 标注 / 画布右键菜单 ----------
step('context-menu')
await clickAt({ x: vp.x, y: vp.y }, { double: false })
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'right', buttons: 2, clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x, y: vp.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(700)
const menu = await p.evaluate(`(()=>{
  const m=[...document.querySelectorAll('[role=menu],[class*=contextMenu],[class*=createMenu]')]
    .filter(e=>e.getBoundingClientRect().width>80)
  return m.map(e=>({cls:String(e.className).slice(0,30), text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,200),
    items:[...e.querySelectorAll('button,[role=menuitem]')].map(b=>(b.innerText||'').trim()).filter(Boolean)}))})()`)
rec('right-click-menu', menu)
R['right-click-menu'] = { ...R['right-click-menu'], shot: await p.shoot('m5f-context-menu') }

writeFileSync(join(SHOT_DIR, '..', 'm5f-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

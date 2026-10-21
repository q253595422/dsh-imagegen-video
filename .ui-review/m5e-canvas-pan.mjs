/**
 * 第 5 批 4/4：平移重测 + 新建画布初始视口 + 节点选中工具条。
 * 上一轮平移失败的根因是探针：CDP 拖动必须带 buttons:1，否则浏览器认为没按键。
 * 本轮：
 *  A) 先记录画布下拉里的项目清单（收尾要还原）
 *  B) 新建画布 → 看初始缩放与节点是否完整落在视口内（默认布局是否被裁）
 *  C) 平移：手型工具 + 拖动（buttons:1），再空格 + 拖动
 *  D) 选中节点 → 节点上方工具条（A-/A+/加粗/颜色/技能/AI润色/副本/删除）逐项
 *  E) 删除本次新建的画布
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 240000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos, { double = false } = {}) => {
  const n = double ? 2 : 1
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: n })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: n })
  await sleep(650)
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

/** 画布状态：视口、节点矩形、是否越界、缩放文案、保存态 */
const view = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  if(!c) return {noCanvas:true}
  const vp=c.querySelector('[class*=viewport]')||c
  const vr=vp.getBoundingClientRect()
  const nodes=[...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id').slice(0,12), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,30),
      outLeft: r.left < vr.left - 1, outTop: r.top < vr.top - 1,
      outRight: r.right > vr.right + 1, outBottom: r.bottom > vr.bottom + 1}
  })
  const save=(c.querySelector('[class*=saveState]')||{}).innerText||''
  const zoom=((c.innerText||'').match(/(\\d+)%/)||[])[1]||''
  return {vp:{x:Math.round(vr.x),y:Math.round(vr.y),w:Math.round(vr.width),h:Math.round(vr.height)}, save, zoom, nodes}
})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) {
  const v = await view()
  if (!v.noCanvas && v.nodes.length > 0) break
  await sleep(300)
}

// ---------- A. 画布项目清单 ----------
step('projects')
const projects = await p.evaluate(`(()=>{
  const sel=document.querySelector('[aria-label="画布项目"]')
  if(!sel) return null
  return {tag:sel.tagName, role:sel.getAttribute('role')||'', value:sel.value||sel.innerText.trim(),
    text:(sel.innerText||'').replace(/\\s+/g,' ').trim()}
})()`)
rec('projects-before', projects)

// ---------- B. 新建画布 ----------
step('create')
await tapAria('新建画布')
await sleep(2200)
rec('after-create', await view())
R['after-create'] = { ...R['after-create'], shot: await p.shoot('m5e-new-canvas') }
rec('projects-after-create', await p.evaluate(`(()=>{
  const sel=document.querySelector('[aria-label="画布项目"]')
  return sel?{value:sel.value||'', text:(sel.innerText||'').replace(/\\s+/g,' ').trim()}:null})()`))

// ---------- C. 平移重测 ----------
const vp = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const v=c.querySelector('[class*=viewport]'); const r=v.getBoundingClientRect()
  return {x:Math.round(r.x+r.width*0.5),y:Math.round(r.y+r.height*0.72),
    left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})()`)

const drag = async (from, dx, dy, steps = 8) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + Math.round(dx * i / steps), y: from.y + Math.round(dy * i / steps), button: 'left', buttons: 1 })
    await sleep(25)
  }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(500)
}

step('pan-hand')
await tapAria('拖动画布（空格 / Ctrl + 拖动）')
await sleep(250)
const panMode = await p.evaluate(`(()=>{
  const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')==='拖动画布（空格 / Ctrl + 拖动）')
  const c=document.querySelector('[class*=viewport]')
  const host=e?e.closest('[data-dock-item]')||e.parentElement:null
  return {active:e?e.getAttribute('data-active'):null,
    hostActive:host?host.getAttribute('data-active'):null,
    cursor:c?getComputedStyle(c).cursor:''}})()`)
rec('pan-mode', panMode)
const p0 = await view()
await drag(vp, -140, -70)
const p1 = await view()
rec('pan-hand-result', { before: p0.nodes.map(n => [n.x, n.y]), after: p1.nodes.map(n => [n.x, n.y]), zoom: [p0.zoom, p1.zoom] })
R['pan-hand-result'] = { ...R['pan-hand-result'], shot: await p.shoot('m5e-pan-hand') }

step('pan-space')
await tapAria('选择 / 移动节点')
await sleep(200)
const p2 = await view()
await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', modifiers: 0 })
await sleep(200)
const spaceCursor = await p.evaluate(`(()=>{const c=document.querySelector('[class*=viewport]')
  return {cursor:getComputedStyle(c).cursor}})()`)
await drag(vp, 120, 60)
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await sleep(300)
const p3 = await view()
rec('pan-space-result', { cursorWhileSpace: spaceCursor, before: p2.nodes.map(n => [n.x, n.y]), after: p3.nodes.map(n => [n.x, n.y]) })

// ---------- D. 选中节点 → 工具条 ----------
step('select-node')
await tapAria('适应全部内容'); await sleep(600)
const nodePos = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const n=c.querySelector('[data-node-id]')
  if(!n) return null
  const r=n.getBoundingClientRect()
  return {x:Math.round(r.x+r.width*0.5), y:Math.round(r.y+18), w:Math.round(r.width), h:Math.round(r.height),
    text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,40)}})()`)
rec('node-target', nodePos)
if (nodePos) {
  await clickAt(nodePos)
  await sleep(600)
  const toolbar = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-canvas-workspace]')
    const btns=[...c.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect()
      return r.width>0 && r.height>0 && /^(A-|A\\+|技能|AI 润色|创建副本 \\(Ctrl\\+D\\)|删除|加粗|文字颜色)$/.test((b.getAttribute('aria-label')||b.getAttribute('title')||'').trim())})
    return btns.map(b=>({aria:b.getAttribute('aria-label')||b.getAttribute('title'),
      x:Math.round(b.getBoundingClientRect().x), y:Math.round(b.getBoundingClientRect().y)}))})()`)
  rec('node-toolbar', toolbar)
  R['node-toolbar'] = { ...R['node-toolbar'], shot: await p.shoot('m5e-node-selected') }

  // 字号：点 A+ 三次，看节点高度/字体是否变化
  const fontBefore = await p.evaluate(`(()=>{const n=document.querySelector('[data-node-id] textarea, [data-node-id] [contenteditable]')
    if(!n) return null; const cs=getComputedStyle(n); return {fs:cs.fontSize, lh:cs.lineHeight}})()`)
  await tapAria('放大字号'); await tapAria('放大字号'); await tapAria('放大字号')
  const fontAfter = await p.evaluate(`(()=>{const n=document.querySelector('[data-node-id] textarea, [data-node-id] [contenteditable]')
    if(!n) return null; const cs=getComputedStyle(n); return {fs:cs.fontSize, lh:cs.lineHeight}})()`)
  rec('font-size', { before: fontBefore, after: fontAfter })

  // 颜色
  await tapAria('文字颜色')
  await sleep(700)
  const colorPop = await p.evaluate(`(()=>{
    const e=[...document.querySelectorAll('[role=menu],[class*=popover],[class*=swatch],[class*=color]')]
      .filter(x=>x.getBoundingClientRect().width>40)
    return e.slice(0,3).map(x=>({cls:String(x.className).slice(0,30), text:(x.innerText||'').replace(/\\s+/g,' ').slice(0,80),
      swatches:x.querySelectorAll('button,[role=option],[class*=swatch]').length}))})()`)
  rec('color-popover', colorPop)
  R['color-popover'] = { ...R['color-popover'], shot: await p.shoot('m5e-color') }
  await p.key('Escape'); await sleep(400)

  // 技能
  await tapAria('技能')
  await sleep(1200)
  const skillPop = await p.evaluate(`(()=>{
    const el=[...document.querySelectorAll('[role=menu],[role=dialog],[class*=popover],[class*=menu]')]
      .filter(x=>{const r=x.getBoundingClientRect(); return r.width>100&&r.height>40})
    const top=el[el.length-1]
    return top?{cls:String(top.className).slice(0,30), role:top.getAttribute('role'),
      text:(top.innerText||'').replace(/\\s+/g,' ').slice(0,220),
      items:[...top.querySelectorAll('button,[role=menuitem],[role=option]')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,12)}:null})()`)
  rec('node-skills', skillPop)
  R['node-skills'] = { ...R['node-skills'], shot: await p.shoot('m5e-node-skills') }
  await p.key('Escape'); await sleep(400)
}

// ---------- E. 删除本次新建的画布 ----------
step('cleanup')
const projNow = await p.evaluate(`(()=>{const sel=document.querySelector('[aria-label="画布项目"]')
  return sel?{value:sel.value||'', text:(sel.innerText||'').replace(/\\s+/g,' ').trim()}:null})()`)
rec('projects-now', projNow)
// 新建后标题应当从「未命名画布」变成新的编号，据此判断要不要清理
if (projNow && projects && projNow.text !== projects.text) {
  await tapAria('删除画布')
  await sleep(700)
  const confirm = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=alertdialog],[role=dialog],[class*=confirm]')]
      .filter(e=>e.getBoundingClientRect().width>100)
    return d.map(e=>({text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,140),
      buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean)}))})()`)
  rec('delete-confirm', confirm)
  R['delete-confirm'] = { ...R['delete-confirm'], shot: await p.shoot('m5e-delete-confirm') }
} else {
  rec('delete-confirm', { skipped: 'draw count unchanged' })
}

writeFileSync(join(SHOT_DIR, '..', 'm5e-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

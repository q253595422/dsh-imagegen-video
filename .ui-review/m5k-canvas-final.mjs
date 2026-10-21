/**
 * 第 5 批收尾（最后一条）：
 *  A) 用节点上的「拖到其他节点建立连线」手柄真实拖一次，看连线计数是否 +1
 *  B) 画布项目下拉：先点空白处再点，准确枚举 [role=listbox] 内的 option 条数
 *  C) 节点重叠：量图片节点与「生成配置」节点的矩形交集
 * 只读为主；不新建、不删除。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 800)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 240000).unref()

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

await tap('无限画布')
for (let i = 0; i < 60; i++) {
  const ok = await p.evaluate(`!!document.querySelector('[data-canvas-workspace]')`)
  if (ok) break
  await sleep(300)
}
await sleep(1500)
await tapAria('适应全部内容')
await sleep(800)

// ---------- C. 节点重叠 ----------
step('overlap')
const geom = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const ns=[...c.querySelectorAll('[data-node-id]')].map(n=>{const r=n.getBoundingClientRect()
    return {t:(n.innerText||'').replace(/\\s+/g,' ').slice(0,14),
      x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
      hasImg:!!n.querySelector('img')}})
  const pairs=[]
  for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++){
    const a=ns[i],b=ns[j]
    const ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)
    const oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)
    if(ox>0&&oy>0) pairs.push({a:a.t,b:b.t,overlapW:ox,overlapH:oy,
      pctOfA:Math.round(ox*a===ox?100:(ox/a.w)*100), pctOfB:Math.round((ox/b.w)*100)})
  }
  return {nodes:ns, overlapping:pairs}})()`)
rec('node-overlap', geom)
R['node-overlap'] = { ...R['node-overlap'], shot: await p.shoot('m5k-overlap') }

// ---------- A. 连线手柄 ----------
step('connect-handle')
const handleInfo = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const hs=[...c.querySelectorAll('[title="拖到其他节点建立连线"]')].filter(e=>e.getBoundingClientRect().width>0)
  return hs.map(e=>{const r=e.getBoundingClientRect()
    // 手柄属于哪个节点
    let host=e, label=''
    for(let i=0;i<6;i++){ if(!host.parentElement) break; host=host.parentElement
      if(host.hasAttribute&&host.hasAttribute('data-node-id')){ label=(host.innerText||'').replace(/\\s+/g,' ').slice(0,12); break } }
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      w:Math.round(r.width),h:Math.round(r.height), host:label}})})()`)
rec('handles', handleInfo)

if (handleInfo.length >= 2) {
  // 用第一个手柄拖到第二个手柄所属节点的中心
  const target = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-canvas-workspace]')
    const hs=[...c.querySelectorAll('[title="拖到其他节点建立连线"]')].filter(e=>e.getBoundingClientRect().width>0)
    if(hs.length<2) return null
    const h2=hs[1]
    let host=h2
    for(let i=0;i<6;i++){ if(!host.parentElement) break; host=host.parentElement
      if(host.hasAttribute&&host.hasAttribute('data-node-id')) break }
    const r=host.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:(host.innerText||'').replace(/\\s+/g,' ').slice(0,14)}})()`)
  rec('connect-target', target)
  const before = await p.evaluate(`document.querySelectorAll('[data-connection-hit]').length`)
  const src = handleInfo[0]
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: src.x, y: src.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 12; i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      x: src.x + Math.round((target.x - src.x) * i / 12),
      y: src.y + Math.round((target.y - src.y) * i / 12), button: 'left', buttons: 1 })
    await sleep(30)
  }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(900)
  const after = await p.evaluate(`document.querySelectorAll('[data-connection-hit]').length`)
  rec('connect-list', { from: src.host, to: target.t, hitsBefore: before, hitsAfter: after })
  R['connect-list'] = { ...R['connect-list'], shot: await p.shoot('m5k-connected') }
}

// ---------- B. 项目下拉 ----------
step('project-select')
// 先点画布空白，清掉焦点与菜单
await clickAt({ x: 1200, y: 700 })
await sleep(400)
const pb = await p.evaluate(`(()=>{const b=document.querySelector('[aria-label="画布项目"]')
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:b.tagName,
    expanded:b.getAttribute('aria-expanded'),haspopup:b.getAttribute('aria-haspopup')}})()`)
rec('project-btn', pb)
if (pb) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pb.x, y: pb.y, button: 'left', buttons: 1, clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pb.x, y: pb.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1200)
  const dd = await p.evaluate(`(()=>{
    const lb=[...document.querySelectorAll('[role=listbox]')].filter(e=>e.getBoundingClientRect().width>100)
    const top=lb[lb.length-1]
    const b=document.querySelector('[aria-label="画布项目"]')
    if(!top) return {open:false, expanded:b?b.getAttribute('aria-expanded'):null,
      allRoles:[...document.querySelectorAll('[role=option],[role=menuitem]')].length}
    const opts=[...top.querySelectorAll('[role=option]')]
    const r=top.getBoundingClientRect()
    return {open:true, expanded:b?b.getAttribute('aria-expanded'):null,
      box:{w:Math.round(r.width),h:Math.round(r.height)}, scrollH:top.scrollHeight,
      optionCount:opts.length,
      hasSearch:!!top.querySelector('input'),
      names:[...new Set(opts.map(o=>(o.innerText||'').trim()))].slice(0,6),
      dupNames:opts.length - new Set(opts.map(o=>(o.innerText||'').trim())).size}
  })()`)
  rec('project-dropdown', dd)
  R['project-dropdown'] = { ...R['project-dropdown'], shot: await p.shoot('m5k-project-dropdown') }
  await p.key('Escape'); await sleep(400)
}

writeFileSync(join(SHOT_DIR, '..', 'm5k-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

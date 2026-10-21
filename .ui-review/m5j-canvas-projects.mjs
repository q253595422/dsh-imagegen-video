/**
 * 第 5 批：画布项目清单规模核查。
 * 背景：~/.dsh/dsh-imagegen/canvas/index.json 有 1425 个项目，绝大多数 nodeCount=0、同名「未命名画布」。
 * 要确认的是：用户在界面上看到的清单到底有多少条、能不能区分、能不能搜索/清理。
 * 只读：不新建、不删除任何画布。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 900)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 200000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(500)
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

// ---------- 打开画布项目下拉 ----------
step('open-project-select')
const btn = await p.evaluate(`(()=>{const b=document.querySelector('[aria-label="画布项目"]')
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
rec('project-button', btn)
if (btn) {
  await clickAt(btn)
  await sleep(1200)
  const pop = await p.evaluate(`(()=>{
    const list=[...document.querySelectorAll('[role=listbox],[role=menu],[class*=dropdown],[class*=popover],[class*=optionList]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120 && r.height>40 && e.offsetParent!==null})
    const top=list[list.length-1]
    if(!top) return null
    const opts=[...top.querySelectorAll('[role=option],[role=menuitem],li,button')]
      .filter(e=>e.getBoundingClientRect().width>60)
    const rect=top.getBoundingClientRect()
    return {cls:String(top.className).slice(0,30), role:top.getAttribute('role')||'',
      box:{w:Math.round(rect.width),h:Math.round(rect.height)},
      optionCount:opts.length,
      scrollH:top.scrollHeight, clientH:top.clientHeight,
      hasSearch:!!top.querySelector('input'),
      searchPh:top.querySelector('input')?top.querySelector('input').placeholder:'',
      firstOpts:opts.slice(0,6).map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26), role:e.getAttribute('role')||'', sel:e.getAttribute('aria-selected')||''})),
      lastOpts:opts.slice(-4).map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26)),
      // 有没有「删除/清空/管理」入口
      actions:[...top.parentElement.querySelectorAll('button')].map(b=>(b.innerText||'').trim()||b.getAttribute('aria-label')||'').filter(Boolean).slice(0,10)}})()`)
  rec('project-dropdown', pop)
  R['project-dropdown'] = { ...R['project-dropdown'], shot: await p.shoot('m5j-project-dropdown') }

  // 下拉里能滚多少
  const scroll = await p.evaluate(`(()=>{
    const list=[...document.querySelectorAll('[role=listbox],[class*=popover],[class*=dropdown]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120&&r.height>40&&e.offsetParent!==null})
    const top=list[list.length-1]; if(!top) return null
    top.scrollTop = top.scrollHeight
    return {scrollH:top.scrollHeight, clientH:top.clientHeight, scrolledTo:top.scrollTop}})()`)
  await sleep(400)
  rec('project-scroll', scroll)
  await p.key('Escape'); await sleep(400)
}

// ---------- 画布名称是否可区分 ----------
step('names')
const names = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const t=(c.innerText||'').replace(/\\s+/g,' ')
  return {topBar:t.slice(0,90)}})()`)
rec('topbar', names)

writeFileSync(join(SHOT_DIR, '..', 'm5j-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

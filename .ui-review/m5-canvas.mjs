/**
 * 第 5 批 1/4：无限画布进入 + 首屏结构。
 * 先只做「看得见什么」：顶部栏、工具栏、缩放坞、小地图、空态提示原文，
 * 以及画布区所有可点控件的文字/aria/title。后面几个探针再逐个真点。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }

const s = await openStudio()
const p = s.page

const clickAt = async (pos) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(1200)
}

/** 按可见文字点一个控件（精确匹配），返回命中信息 */
const tap = async (text, root = 'body') => {
  const r = await p.evaluate(`(()=>{
    const rt=document.querySelector(${JSON.stringify(root)})||document.body
    const els=[...rt.querySelectorAll('button,a,[role=tab],[role=button],li,div[tabindex]')]
    const hit=els.find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect()
    if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2), tag:hit.tagName}
  })()`)
  if (!r) return null
  await clickAt(r)
  return r
}

// ---------- 1. 面板顶部有哪些 tab ----------
const tabs = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/[ \\t]+/g,' ').split('\\n').map(x=>x.trim()).filter(Boolean)
  return t.slice(0,14)
})()`)
rec('view-head', tabs)

// 顶部 tab 的真实 DOM（找到「无限画布」按哪个元素点）
const topTabs = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  return [...v.querySelectorAll('button,[role=tab]')].slice(0,40).map(b=>{
    const r=b.getBoundingClientRect()
    return {t:(b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,18), role:b.getAttribute('role')||'',
      sel:b.getAttribute('aria-selected')||'', w:Math.round(r.width)}
  }).filter(x=>x.w>0)
})()`)
rec('view-buttons', topTabs)

// ---------- 2. 进画布 ----------
rec('tap-canvas', await tap('无限画布'))
await sleep(2600)

const hasCanvas = await p.evaluate(`!!document.querySelector('[data-canvas-workspace]')`)
rec('canvas-mounted', hasCanvas)
if (!hasCanvas) {
  rec('page-text', await p.evaluate(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,600)`))
  writeFileSync(join(SHOT_DIR, '..', 'm5-canvas.json'), JSON.stringify({ result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors }, null, 2))
  s.close(); setTimeout(() => process.exit(0), 500)
}

R['first-screen'] = { shot: await p.shoot('m5-canvas-empty') }

// ---------- 3. 画布内部结构 ----------
const layout = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const r=c.getBoundingClientRect()
  const kids=[...c.children].map(e=>{
    const rc=e.getBoundingClientRect()
    return {cls:String(e.className).slice(0,40), tag:e.tagName,
      x:Math.round(rc.x),y:Math.round(rc.y),w:Math.round(rc.width),h:Math.round(rc.height),
      text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,120)}
  })
  return {rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}, kids}
})()`)
rec('canvas-layout', layout)

// 全部可点控件：文字 / aria-label / title / 尺寸
const controls = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('button,[role=button],[role=menuitem],input,a')].map(b=>{
    const r=b.getBoundingClientRect()
    return {t:(b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,24),
      aria:b.getAttribute('aria-label')||'', title:b.getAttribute('title')||'',
      ph:b.getAttribute('placeholder')||'',
      dis:b.hasAttribute('disabled')||b.getAttribute('aria-disabled')==='true'?'D':'',
      x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}
  }).filter(x=>x.w>0&&x.h>0)
})()`)
rec('canvas-controls', controls)

// 空画布有没有提示
const emptyHint = await p.evaluate(`(()=>{
  const e=document.querySelector('[class*=emptyHint]')
  return e?{text:(e.innerText||'').replace(/\\s+/g,' ').trim(), w:Math.round(e.getBoundingClientRect().width)}:null
})()`)
rec('empty-hint', emptyHint)

// 小地图
const minimap = await p.evaluate(`(()=>{
  const e=document.querySelector('[aria-label]')
  const all=[...document.querySelectorAll('[aria-label]')].map(x=>({aria:x.getAttribute('aria-label'),
    w:Math.round(x.getBoundingClientRect().width)})).filter(x=>x.w>0)
  return all.slice(0,20)
})()`)
rec('aria-labels', minimap)

rec('doc-overflow', await p.docOverflow())

writeFileSync(join(SHOT_DIR, '..', 'm5-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 12),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

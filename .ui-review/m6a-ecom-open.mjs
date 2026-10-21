/**
 * 第 6 批·电商模式（预览）第一轮：结构勘察。
 * 只做「进去 → 把界面上有什么全量倒出来 → 截图」，不做判断。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,[role=tab],[role=button],a,div[role=tab]')]
    const want=${JSON.stringify(text)}
    const hit=els.find(e=>{const t=(e.innerText||'').trim(); return t===want || t===want+'预览' || t.startsWith(want)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  return true
}

/** 画布工具条那种「只有图标」的按钮，按 title 点 */
const tapTitle = async (p, title) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1000)
  return true
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // 顶栏工作区导航：先看有哪些
  rec('topnav', await p.evaluate(`(()=>{
    const root=document.querySelector('[data-dsh-imagegen-view]')||document.body
    const cands=[...document.querySelectorAll('button,[role=tab],a')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.y<140&&r.width>20&&r.height>10})
    return cands.map(e=>({t:(e.innerText||'').trim().slice(0,20),title:(e.getAttribute('title')||'').slice(0,30),
      aria:(e.getAttribute('aria-label')||'').slice(0,30),x:Math.round(e.getBoundingClientRect().x),w:Math.round(e.getBoundingClientRect().width)}))
      .filter(o=>o.t||o.title||o.aria)
  })()`))

  const opened = await tapText(p, '电商模式')
  rec('ecom-open-clicked', { opened })
  await sleep(2500)
  R['ecom-open-clicked'].shot = await p.shoot('150-m6a-ecom-open')

  // 整块面板文字
  rec('ecom-text', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
    return (v.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0, 3000)
  })()`))

  // 所有可见可交互元素（带坐标），用来定位后续点击
  rec('ecom-controls', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
    const els=[...v.querySelectorAll('button,input,textarea,select,[role=button],[role=tab],[role=radio],[role=checkbox]')]
    return els.map(e=>{
      const r=e.getBoundingClientRect()
      if(r.width===0||r.height===0) return null
      return {tag:e.tagName.toLowerCase(),t:(e.innerText||'').trim().slice(0,22),
        ph:(e.getAttribute('placeholder')||'').slice(0,28),
        title:(e.getAttribute('title')||'').slice(0,30),
        aria:(e.getAttribute('aria-label')||'').slice(0,30),
        role:e.getAttribute('role')||'', dis:e.disabled||false,
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}
    }).filter(Boolean)
  })()`))

  // 分区标题 / 小标题（粗体或较重的文字）
  rec('ecom-headings', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
    return [...v.querySelectorAll('*')].filter(e=>{
      if(e.children.length) return false
      const t=(e.textContent||'').trim(); if(!t||t.length>30) return false
      const cs=getComputedStyle(e)
      const w=parseInt(cs.fontWeight)||400
      return w>=600||parseFloat(cs.fontSize)>=15
    }).map(e=>({t:(e.textContent||'').trim().slice(0,28),sz:getComputedStyle(e).fontSize,w:getComputedStyle(e).fontWeight,
      y:Math.round(e.getBoundingClientRect().y)})).slice(0,60)
  })()`))

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6a-ecom-open.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

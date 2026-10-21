/**
 * 第 5 批·无限画布：第一轮只做侦察。
 * 切到「无限画布」标签，导出 DOM 骨架、所有可点元素（含 title/aria-label）、空态文案，
 * 好让后续脚本按真实选择器写，而不是靠猜。
 */
import { openStudio, sleep } from './boot.mjs'

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
const out = {}

try {
  // 顶部的工作区标签：先把它列出来，确认「无限画布」这枚在哪个容器里
  out.tabs = await p.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,[role=tab]')]
    return els.filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0})
      .map(e=>({t:(e.innerText||'').trim().slice(0,20), role:e.getAttribute('role')||'', sel:e.getAttribute('data-dsh-imagegen-tab')||''}))
      .filter(o=>o.t!=='').slice(0,40)
  })()`)

  const clicked = await p.evaluate(`(()=>{
    const b=[...document.querySelectorAll('button,[role=tab]')]
      .find(e=>(e.innerText||'').trim()==='无限画布')
    if(!b) return false
    const r=b.getBoundingClientRect(); if(r.width===0) return false
    b.click(); return true
  })()`)
  out.clicked = clicked
  await sleep(2500)

  // 画布区域的骨架：带 data-* 的元素 + 一个粗粒度 DOM 路径
  out.skeleton = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    if(!v) return {noView:true}
    const marked=[...v.querySelectorAll('*')].filter(e=>[...e.attributes].some(a=>a.name.startsWith('data-')))
      .map(e=>e.tagName.toLowerCase()+'['+[...e.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name+(a.value?'="'+a.value.slice(0,24)+'"':'')).join(' ')+']')
    return {marked:[...new Set(marked)].slice(0,60), text:(v.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0,1200)}
  })()`)

  // 所有可点元素：文字 / title / aria-label / class 首段
  out.clickable = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
    return [...v.querySelectorAll('button,[role=button],a,input,select,textarea')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>1&&r.height>1})
      .map(e=>({
        tag:e.tagName.toLowerCase(),
        text:(e.innerText||'').trim().slice(0,28),
        title:(e.getAttribute('title')||'').slice(0,60),
        aria:(e.getAttribute('aria-label')||'').slice(0,40),
        ph:(e.getAttribute('placeholder')||'').slice(0,40),
        cls:(e.className||'').toString().split(' ')[0].slice(0,30),
        x:Math.round(e.getBoundingClientRect().x), y:Math.round(e.getBoundingClientRect().y),
        w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height),
      }))
  })()`)

  out.shot = await p.shoot('120-m5a-canvas-empty')
  out.pageErrors = p.pageErrors
  out.consoleErrors = (p.consoleErrors || []).slice(0, 15)
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e)
} finally {
  console.log(JSON.stringify(out, null, 2))
  close()
}

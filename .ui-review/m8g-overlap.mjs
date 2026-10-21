import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
const R={}
const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  await p.setViewport(760, 900); await sleep(1800)
  R.nav = await p.evaluate(`(()=>{
    const box=e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),r:Math.round(r.right)}}
    const tabs=[...document.querySelectorAll('[role=tab]')].filter(e=>e.getBoundingClientRect().width>0
      &&/普通生图|素材库|无限画布|电商模式|图片转/.test(e.innerText||'')).map(e=>({t:(e.innerText||'').replace(/\s+/g,' ').trim(),...box(e)}))
    const talk=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').replace(/\s+/g,'')==='对话')
    const tb=talk?box(talk):null
    const overlap=tabs.filter(t=>tb&&t.r>tb.x&&t.x<tb.r).map(t=>({t:t.t,coversBy:Math.round(t.r-Math.max(t.x,tb.x))}))
    const conn=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').trim()==='已连接')
    return {tabs, talk:tb, overlap, talkText:talk?JSON.stringify(talk.innerText):null,
      conn:conn?box(conn):null, vw:window.innerWidth,
      // 图片转 PPT tab 文本被谁盖住
      topAtTabText:(()=>{const t=tabs.find(x=>/图片转/.test(x.t)); if(!t) return null
        return document.elementsFromPoint(t.x+t.w-6, t.y+t.h/2).slice(0,4).map(e=>e.tagName.toLowerCase()+':'+((e.innerText||'').replace(/\s+/g,' ').trim().slice(0,10)))})()}
  })()`)
  R.shot = await p.shoot('220-m8g-nav-overlap')
} finally { writeFileSync('.ui-review/m8g-overlap.json', JSON.stringify(R,null,2)); console.log(JSON.stringify(R).slice(0,1500)); close() }

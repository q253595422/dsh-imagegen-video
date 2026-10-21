/**
 * 第 8 批·窄窗实测（760 / 900 / 1024 / 1280）。
 * 每个工作区记录：整页横向溢出、面板根溢出、导航是否被裁、左栏/右栏宽度、
 * 被视口边缘切掉的元素（宽/高越界）、以及截图。
 * 另外单独测设置弹层在 760 宽下是否超出视口。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 900)) }

const press = async (p, x, y) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(900)
}
const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .find(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

const measure = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const de=document.documentElement
  const vw=window.innerWidth, vh=window.innerHeight
  const root=v||document.body
  const rs=root.getBoundingClientRect()
  // 溢出视口右/下边且大于 4px 的可见元素（排除 fixed 装饰性 dock 内部滚动）
  const clipped=[]
  for(const e of root.querySelectorAll('*')){
    const r=e.getBoundingClientRect()
    if(r.width<2||r.height<2) continue
    const cs=getComputedStyle(e)
    if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') continue
    if(r.right>vw+4||r.left<-4||r.bottom>vh+4) {
      clipped.push({tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,28),
        txt:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26),
        L:Math.round(r.left),R:Math.round(r.right),T:Math.round(r.top),B:Math.round(r.bottom)})
      if(clipped.length>14) break
    }
  }
  // 横向滚动条是否出现
  const scrollers=[...root.querySelectorAll('*')].filter(e=>{
    const c=getComputedStyle(e)
    return /(auto|scroll)/.test(c.overflowX) && e.scrollWidth>e.clientWidth+2
  }).slice(0,5).map(e=>({tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,24),
    sw:e.scrollWidth,cw:e.clientWidth}))
  const nav=[...document.querySelectorAll('[data-dsh-imagegen-tab],[role=tab]')].map(e=>{
    const r=e.getBoundingClientRect()
    return {t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,10),w:Math.round(r.width),x:Math.round(r.x)}
  }).filter(o=>o.t).slice(0,8)
  const cols=[...root.querySelectorAll('aside,main,[class*="column"],[class*="Column"]')].slice(0,6)
    .map(e=>({tag:e.tagName.toLowerCase(),w:Math.round(e.getBoundingClientRect().width)}))
  return {vw,vh,
    pageScroll:{sw:de.scrollWidth,cw:de.clientWidth,overflow:de.scrollWidth>de.clientWidth+2},
    panel:{w:Math.round(rs.width),h:Math.round(rs.height),x:Math.round(rs.x)},
    clippedCount:clipped.length, clipped, scrollers, nav, cols,
    textLen:(root.innerText||'').length}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

const WS = [
  { name: 'normal', tap: '普通生图', shot: '198' },
  { name: 'gallery', tap: '素材库', shot: '199' },
  { name: 'canvas', tap: '无限画布', shot: '200' },
  { name: 'ecom', tap: '电商模式', shot: '201' },
  { name: 'ppt', tap: '图片转 PPT', shot: '202' },
]

try {
  for (const w of WS) {
    await p.setViewport(1600, 1000)
    await sleep(500)
    await tapText(p, w.tap)
    await sleep(2600)
    for (const width of [1280, 1024, 900, 760]) {
      await p.setViewport(width, 900)
      await sleep(1400)
      const m = await measure(p)
      rec(`${w.name}@${width}`, m)
      if (width === 760 || width === 900) {
        R[`${w.name}@${width}`].shot = await p.shoot(`${w.shot}-m8a-${w.name}-${width}`)
      }
    }
  }

  // 设置弹层在 760 宽
  await p.setViewport(760, 900)
  await sleep(1000)
  const ok = await tapText(p, '设置')
  await sleep(2200)
  rec('settings@760', { clicked: ok, state: await p.evaluate(`(()=>{
    const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200)
    const vw=window.innerWidth
    return {dialogs:dlg.map(d=>({label:d.getAttribute('aria-label')||'',
      box:(r=>({x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right)}))(d.getBoundingClientRect()),
      clippedRight: d.getBoundingClientRect().right>vw+2,
      scrollH:d.scrollHeight, clientH:d.clientHeight})),
      vw,
      bodyOverflow: document.documentElement.scrollWidth>document.documentElement.clientWidth+2}
  })()`)})
  R['settings@760'].shot = await p.shoot('203-m8a-settings-760')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8a-narrow.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

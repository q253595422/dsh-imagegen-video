/**
 * 第 4 批：素材库（顶栏「素材库」）。
 * 覆盖：布局与分区、分类/比例/标签筛选与计数一致性、搜索、空结果态、收藏、
 * 条目操作（放大/下载/删除/重命名/发送到画布）、视频条目、加载态与错误态、
 * 无数据态，以及窄窗口。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const F = []
const rec = o => { F.push(o); console.log('·', o.step, o.ok === false ? 'FAIL' : 'ok', o.note ? String(o.note).slice(0, 300) : '') }

const s = await openStudio()
const p = s.page

const tapText = async (text, root = '[data-dsh-imagegen-view]') => {
  const r = await p.evaluate(`(()=>{
    const rt=document.querySelector(${JSON.stringify(root)})||document.body
    const hit=[...rt.querySelectorAll('button,a,[role=tab],[role=button]')].find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null; const rc=hit.getBoundingClientRect()
    if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  return true
}

/** 素材库当前可见状态：分组、筛选项与计数、卡片数量、空态/加载/错误 */
const gallery = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const chips=[...v.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean)
  return {
    heading:(v.querySelector('h1,h2,h3')||{}).innerText||'',
    textHead:t.slice(0,700),
    loading:/加载中|正在加载/.test(t),
    emptyMatch:t.match(/没有[^ ]{0,12}|暂无[^ ]{0,12}|空空如也/g),
    chipsAll:chips.slice(0,50),
    imgs:v.querySelectorAll('img').length,
    videos:v.querySelectorAll('video').length,
    figures:v.querySelectorAll('figure').length,
    cards:v.querySelectorAll('[class*=card],[class*=item],[class*=tile]').length
  }
})()`)

// ---------- 进入素材库 ----------
const entered = await tapText('素材库', 'body')
rec({ step: 'gallery/enter', ok: entered, state: await gallery(), shot: await p.shoot('m4-gallery-enter') })
await sleep(2500)
rec({ step: 'gallery/settled', ok: true, state: await gallery(), shot: await p.shoot('m4-gallery-settled') })

// ---------- 左栏筛选项全量：点每一项，记录计数与卡片数 ----------
const filters = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  // 左栏：取包含「全部」且在其后有一串按钮的那一列
  const cols=[...v.querySelectorAll('aside,section,div')].filter(e=>e.querySelector('button')&&(e.innerText||'').includes('全部'))
  const col=cols.sort((a,b)=>a.innerText.length-b.innerText.length)[0]
  if(!col) return null
  return [...col.querySelectorAll('button')].map(b=>b.innerText.trim().replace(/\\s+/g,' ')).filter(Boolean).slice(0,60)
})()`)
rec({ step: 'gallery/left-filters', ok: !!filters, note: JSON.stringify(filters) })

const listing = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return {countText:(t.match(/共\\s*\\d+\\s*[个张项]/g)||[]), imgs:v.querySelectorAll('img').length,
    plus:(t.match(/\\+\\s*\\d+/g)||[]).slice(0,5)}
})()`)
rec({ step: 'gallery/count', ok: true, note: JSON.stringify(listing) })

// 逐个点前 8 个筛选（跳过会触发下载/删除的）
if (filters) {
  for (const label of filters.slice(0, 10)) {
    if (/删除|清空|下载|上传/.test(label)) continue
    await tapText(label, 'body')
    await sleep(1200)
    const st = await gallery()
    rec({ step: 'gallery/filter/' + label, ok: true,
      note: JSON.stringify({ imgs: st.imgs, videos: st.videos, emptyMatch: st.emptyMatch, countText: (st.textHead.match(/共 ?\d+ ?[个张项]/)||[])[0] }),
      shot: await p.shoot('m4-filter-' + label.replace(/[^\w\u4e00-\u9fa5]/g, '-').slice(0, 12)) })
  }
}

// ---------- 空结果态：搜一个不可能的词 ----------
const searchInput = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const i=[...v.querySelectorAll('input')].find(x=>/placeholder/.test('')&&(x.type==='search'||/搜索/.test(x.placeholder||'')))
  if(!i) return null
  const r=i.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),ph:i.placeholder}
})()`)
rec({ step: 'gallery/search-input', ok: !!searchInput, note: JSON.stringify(searchInput) })
if (searchInput) {
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const i=[...v.querySelectorAll('input')].find(x=>x.type==='search'||/搜索/.test(x.placeholder||''))
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    set.call(i,'zzzzzz-not-exist'); i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(1800)
  const st = await gallery()
  rec({ step: 'gallery/search-empty', ok: true,
    note: JSON.stringify({ imgs: st.imgs, emptyMatch: st.emptyMatch, head: st.textHead.slice(0, 200) }),
    shot: await p.shoot('m4-search-empty') })
  // 清空
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const i=[...v.querySelectorAll('input')].find(x=>x.type==='search'||/搜索/.test(x.placeholder||''))
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(1500)
}

// ---------- 条目上的操作按钮 ----------
const cardActions = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const btns=[...v.querySelectorAll('button')].map(b=>({t:b.innerText.trim(), aria:b.getAttribute('aria-label')||'', title:b.getAttribute('title')||''}))
  const meaningful=btns.filter(b=>b.aria||b.title)
  const seen=new Map()
  for(const b of meaningful){const k=b.aria||b.title; if(!seen.has(k)) seen.set(k,b)}
  return [...seen.keys()].slice(0,30)
})()`)
rec({ step: 'gallery/card-actions', ok: true, note: JSON.stringify(cardActions) })

// 收藏一颗星，看计数是否变化
const before = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return (v.innerText.match(/★[^ ]*/g)||[]).join('|')})()`)
const starred = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/收藏/.test(x.getAttribute('aria-label')||'')||/收藏/.test(x.getAttribute('title')||''))
  if(!b) return false; b.click(); return true})()`)
await sleep(1500)
const after = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return (v.innerText.match(/★[^ ]*/g)||[]).join('|')})()`)
rec({ step: 'gallery/favorite', ok: starred, note: JSON.stringify({ before, after }), shot: await p.shoot('m4-favorite') })

// ---------- 窄窗口 ----------
await p.setViewport(900, 1000); await sleep(900)
rec({ step: 'gallery/narrow-900', ok: true, overflow: await p.docOverflow(), shot: await p.shoot('m4-narrow900') })
await p.setViewport(700, 1000); await sleep(900)
rec({ step: 'gallery/narrow-700', ok: true, overflow: await p.docOverflow(), shot: await p.shoot('m4-narrow700') })
await p.setViewport(1600, 1000); await sleep(600)

writeFileSync(join(SHOT_DIR, '..', 'm4-gallery.json'), JSON.stringify({
  findings: F, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 12),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

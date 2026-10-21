/**
 * 第 4 批补测：把上一轮三个探针的漏洞补上。
 * 1) 空态文案原文（上一轮正则没覆盖「还是空的」，误判成没有空态）
 * 2) 搜索框：按 placeholder 定位，输入不存在的词，看是否真的过滤
 * 3) 卡片悬停操作：真实 mouseMoved 触发，枚举按钮；顺带看遮罩会不会卡住
 * 4) 收藏：从悬停操作或编辑里找，看计数变化
 * 5) 左栏计数与实际条目是否一致（0 计数模型仍可点）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 420)) }

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
  await sleep(1000)
  return true
}

const goGallery = async () => { await tapText('素材库', 'body'); await sleep(2500) }

/** 完整快照：正文尾部（空态文案通常在末尾）、卡片数与图片数、当前选中项 */
const snap = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/[ \\t]+/g,' ').trim()
  const lines=t.split('\\n').map(x=>x.trim()).filter(Boolean)
  return {
    header:(lines[0]||'')+' | '+(lines[1]||''),
    tail:lines.slice(-6),
    imgs:v.querySelectorAll('img').length,
    figures:v.querySelectorAll('figure').length,
    selected:[...v.querySelectorAll('button')].filter(b=>getComputedStyle(b).backgroundColor==='rgb(239, 240, 243)'||getComputedStyle(b).borderColor==='rgb(15, 17, 21)').map(b=>b.innerText.trim()).slice(0,8),
    docScroll:{sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth}
  }
})()`)

// ---------- 1. 空态文案原文（比例筛选 1:1）----------
await goGallery()
await tapText('全部素材')
await sleep(1200)
rec('all', await snap())
await tapText('1:1')
await sleep(1200)
rec('ratio-1-1', await snap())
R['ratio-1-1'].shot = await p.shoot('m4b-ratio-1-1-empty')

// ---------- 2. 搜索：按 placeholder 定位 ----------
await tapText('全部素材')
await sleep(1000)
const inputInfo = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const ins=[...v.querySelectorAll('input')].map(i=>({type:i.type, ph:i.placeholder, cls:String(i.className).slice(0,40), w:i.getBoundingClientRect().width}))
  return ins
})()`)
rec('inputs', inputInfo)

const typed = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const i=[...v.querySelectorAll('input')].find(x=>/作品|模型|搜索/.test(x.placeholder||''))
  if(!i) return {noInput:true}
  const r=i.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),ph:i.placeholder}
})()`)
rec('search-target', typed)

if (!typed.noInput) {
  const before = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    return {imgs:v.querySelectorAll('img').length, text:(v.innerText||'').slice(0,120)}})()`)
  // 用真实按键输入，确保走的是 React 的受控路径
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: typed.x, y: typed.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: typed.x, y: typed.y, button: 'left', clickCount: 1 })
  await sleep(300)
  for (const ch of 'zzqqxx') {
    await p.send('Input.insertText', { text: ch })
    await sleep(60)
  }
  await sleep(1600)
  const after = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const i=[...v.querySelectorAll('input')].find(x=>/作品|模型|搜索/.test(x.placeholder||''))
    const t=(v.innerText||'').replace(/[ \\t]+/g,' ')
    return {value:i?i.value:null, imgs:v.querySelectorAll('img').length,
      tail:t.split('\\n').map(x=>x.trim()).filter(Boolean).slice(-4),
      hasEmpty:/空的|没有|暂无|无匹配|找不到/.test(t)}})()`)
  rec('search-nonsense', { before, after })
  R['search-nonsense'].shot = await p.shoot('m4b-search-nonsense')
  // 清空
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const i=[...v.querySelectorAll('input')].find(x=>/作品|模型|搜索/.test(x.placeholder||''))
    if(i){const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
      set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}))}})()`)
  await sleep(1200)
  rec('search-cleared', await snap())
}

// ---------- 3. 卡片悬停操作 ----------
const cardPos = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const img=v.querySelector('img')
  if(!img) return null
  // 往上找卡片容器
  let el=img
  for(let i=0;i<6;i++){ if(!el.parentElement) break; el=el.parentElement
    if(el.querySelectorAll('button').length>=2) break }
  const r=el.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)}
})()`)
rec('card', cardPos)

const hoverActions = async () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const imgs=[...v.querySelectorAll('img')]
  if(!imgs.length) return {noImg:true}
  let card=imgs[0]
  for(let i=0;i<6;i++){ if(!card.parentElement) break; card=card.parentElement
    if(card.querySelectorAll('button').length>=2) break }
  const btns=[...card.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim(), aria:b.getAttribute('aria-label')||'', title:b.getAttribute('title')||'', vis:b.getBoundingClientRect().width>0}))
  return {btns, cardText:(card.innerText||'').replace(/\\s+/g,' ').slice(0,120)}
})()`)

rec('card-actions-before-hover', await hoverActions())
if (cardPos) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPos.x, y: cardPos.y })
  await sleep(700)
  rec('card-actions-hover', await hoverActions())
  R['card-actions-hover'].shot = await p.shoot('m4b-card-hover')
  // 移开鼠标，看遮罩是否退场
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(700)
  const away = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const vis=[...v.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect()
      return r.width>0 && r.height>0 && /加入对话|加入画布/.test(b.innerText||'')})
    return {stillVisible:vis.map(b=>b.innerText.trim()), shotRect:vis.map(b=>{const r=b.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y)]})}
  })()`)
  rec('card-actions-after-leave', away)
  R['card-actions-after-leave'].shot = await p.shoot('m4b-card-leave')
}

// ---------- 4. 收藏 ----------
const favInfo = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const all=[...v.querySelectorAll('button,[role=button]')].map(b=>({t:(b.innerText||'').trim().slice(0,20),
    aria:(b.getAttribute('aria-label')||''), title:(b.getAttribute('title')||''),
    svg:(b.innerHTML||'').includes('svg')}))
  return {starLike:all.filter(x=>/★|☆|收藏/.test(x.t+x.aria+x.title)).slice(0,10), total:all.length}
})()`)
rec('fav-controls', favInfo)

// 左栏「★收藏」这个 tab 在哪
const favTab = await p.evaluate(`(()=>{
  const t=document.body.innerText||''
  return {hasStarTab:/★\\s*收藏|收藏/.test(t), tabs:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(x=>/收藏/.test(x))}
})()`)
rec('fav-tab', favTab)

// ---------- 5. 左栏计数 vs 实际 ----------
const leftCounts = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const lines=(v.innerText||'').split('\\n').map(x=>x.trim()).filter(Boolean)
  // 分类区：形如「名字 数字」的行
  const pairs=[]
  for(let i=0;i<lines.length-1;i++){
    if(/^\\d+$/.test(lines[i+1]) && lines[i].length<40 && !/^\\d+$/.test(lines[i])) pairs.push([lines[i], +lines[i+1]])
  }
  return pairs.slice(0,20)
})()`)
rec('left-counts', leftCounts)

// 点一个计数为 0 的模型，看结果
const zeroModel = (leftCounts || []).find(x => x[1] === 0)
if (zeroModel) {
  const ok = await tapText(zeroModel[0])
  await sleep(1400)
  const st = await snap()
  rec('zero-model-click', { clicked: zeroModel[0], ok, state: st })
  R['zero-model-click'].shot = await p.shoot('m4b-zero-model')
}

// ---------- 6. 网格模式切换 ----------
await tapText('全部素材'); await sleep(900)
await tapText('整齐网格'); await sleep(1200)
rec('grid-mode', { state: await snap(), shot: await p.shoot('m4b-grid-mode') })
await tapText('瀑布流'); await sleep(1000)

// ---------- 7. 排序下拉 ----------
const sortBtn = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/最新发布/.test(x.innerText))
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:b.innerText.trim(),exp:b.getAttribute('aria-expanded')}
})()`)
rec('sort-btn', sortBtn)
if (sortBtn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sortBtn.x, y: sortBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sortBtn.x, y: sortBtn.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const opts = await p.evaluate(`(()=>{
    const items=[...document.querySelectorAll('[role=menuitem],[role=option],li')]
      .filter(e=>e.offsetParent!==null && (e.innerText||'').trim().length<20)
      .map(e=>({t:e.innerText.trim(), role:e.getAttribute('role')}))
    const b=[...document.querySelectorAll('button')].find(x=>/最新发布/.test(x.innerText))
    return {expanded:b?b.getAttribute('aria-expanded'):null, items:items.slice(0,10)}
  })()`)
  rec('sort-open', opts)
  R['sort-open'].shot = await p.shoot('m4b-sort-open')
  await p.key('Escape'); await sleep(500)
}

writeFileSync(join(SHOT_DIR, '..', 'm4b-gallery.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 12),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

/**
 * 第 4 批收尾：剩下三个真实交互。
 * 1) 左栏 0 计数的模型行能否点、点了是什么状态
 * 2) 卡片「编辑」（编辑标签）——文案、可提交性、取消
 * 3) 卡片图片「点击预览」——弹层内容与关闭方式
 * 4) 「×」（移出素材库）的确认与可撤销性——只打开确认，不真删
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 500)) }

const s = await openStudio()
const p = s.page

/** 通用点击：按可见文字，可选精确/包含；根节点可指定 */
const tap = async (text, { exact = true, root = '[data-dsh-imagegen-view]', el = 'button,a,[role=tab],[role=button],li,div[tabindex]' } = {}) => {
  const r = await p.evaluate(`(()=>{
    const rt=document.querySelector(${JSON.stringify(root)})||document.body
    const els=[...rt.querySelectorAll(${JSON.stringify(el)})]
    const hit=els.find(e=>{const t=(e.innerText||'').trim(); return ${exact ? `t===${JSON.stringify(text)}` : `t.includes(${JSON.stringify(text)})`}})
    if(!hit) return null; const rc=hit.getBoundingClientRect()
    if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2), tag:hit.tagName, cls:String(hit.className).slice(0,40)}
  })()`)
  if (!r) return null
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1100)
  return r
}

const text = (n = 500) => p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return (v.innerText||'').replace(/[ \\t]+/g,' ').slice(0,${n})})()`)

const count = () => p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return {imgs:v.querySelectorAll('img').length, header:(v.querySelector('h1,h2,h3')||{}).innerText||'',
    countText:((v.innerText||'').match(/共\\s*\\d+\\s*[幅张个]/)||[])[0]||''}})()`)

await tap('素材库', { root: 'body' })
await sleep(2600)

// ---------- 1. 0 计数模型 ----------
rec('before', await count())
const rows = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  // 左栏：包含「全部素材」的那一列，取所有可点行
  const cols=[...v.querySelectorAll('aside,nav,section,div')].filter(e=>(e.innerText||'').includes('全部素材')&&(e.innerText||'').includes('画面比例'))
  const col=cols.sort((a,b)=>a.innerText.length-b.innerText.length)[0]
  if(!col) return null
  const clickable=[...col.querySelectorAll('button,li,a,[role=button],[role=option],div[tabindex]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0})
    .map(e=>({t:(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,30), tag:e.tagName, role:e.getAttribute('role')||''}))
  return {colText:(col.innerText||'').replace(/\\s+/g,' ').slice(0,200), clickable:clickable.slice(0,20)}
})()`)
rec('left-rail-dom', rows)

const zero = await tap('agnes-image-2.1-flash', { root: 'body', el: 'button,li,a,[role=button],[role=option],div[tabindex]' })
rec('zero-model-tap', { hit: !!zero, hitInfo: zero })
rec('zero-model-state', { count: await count(), text: await text(400), shot: await p.shoot('m4c-zero-model') })

// 回到全部
await tap('全部素材', { root: 'body', el: 'button,li,a,[role=button],[role=option],div[tabindex]' })
await sleep(1000)

// ---------- 2. 编辑标签 ----------
const editHit = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='编辑')
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
})()`)
rec('edit-btn', editHit)
if (editHit) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editHit.x, y: editHit.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editHit.x, y: editHit.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const dlg = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog],dialog,[class*=modal],[class*=dialog],[class*=popover]')]
      .filter(e=>e.getBoundingClientRect().width>0)
    const focus=document.activeElement
    return {dialogs:d.map(e=>({cls:String(e.className).slice(0,50), text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,300),
        inputs:[...e.querySelectorAll('input,textarea')].map(i=>({ph:i.placeholder,val:i.value,type:i.type})),
        buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean)})).slice(0,3),
      focusedTag:focus?focus.tagName:'', focusedPh:focus?(focus.placeholder||''):''}
  })()`)
  rec('edit-dialog', dlg)
  R['edit-dialog'].shot = await p.shoot('m4c-edit-tag')
  await p.key('Escape'); await sleep(700)
  rec('edit-after-esc', { text: (await text(200)) })
}

// ---------- 3. 点击预览 ----------
const imgHit = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'')==='点击预览')
  const t=b||v.querySelector('img')
  if(!t) return null; const r=t.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:t.tagName}
})()`)
rec('preview-target', imgHit)
if (imgHit) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: imgHit.x, y: imgHit.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: imgHit.x, y: imgHit.y, button: 'left', clickCount: 1 })
  await sleep(1600)
  const pv = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog],[class*=lightbox],[class*=preview],[class*=overlay],body > div')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>300 && r.height>300})
    const top=d[d.length-1]
    return {layerCount:d.length,
      text: top?(top.innerText||'').replace(/\\s+/g,' ').slice(0,300):'',
      imgs: top?top.querySelectorAll('img').length:0,
      buttons: top?[...top.querySelectorAll('button')].map(b=>(b.innerText||'').trim()+'|'+(b.getAttribute('aria-label')||'')).filter(Boolean).slice(0,12):[]}
  })()`)
  rec('preview-open', pv)
  R['preview-open'].shot = await p.shoot('m4c-preview')
  await p.key('Escape'); await sleep(800)
  const closed = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    return {viewVisible:!!v && v.getBoundingClientRect().width>0, imgs:v?v.querySelectorAll('img').length:0}})()`)
  rec('preview-after-esc', closed)
}

// ---------- 4. 移出素材库：只打开确认，不确认 ----------
const xHit = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>{const t=(x.innerText||'').trim(); return (t==='×'||t==='✕') && (x.getAttribute('title')||'')==='移出素材库'})
    || [...v.querySelectorAll('button')].find(x=>(x.getAttribute('title')||'')==='移出素材库')
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),title:b.getAttribute('title')}
})()`)
rec('remove-btn', xHit)
if (xHit) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xHit.x, y: xHit.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xHit.x, y: xHit.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const conf = await p.evaluate(`(()=>{
    const t=(document.body.innerText||'').replace(/\\s+/g,' ')
    return {stillCount:(t.match(/共\\s*\\d+\\s*幅/)||[])[0]||'', confirmish:/确定|确认|删除/.test(t)?t.match(/.{0,30}(确定|确认|移出).{0,40}/g).slice(0,3):[],
      alert:[...document.querySelectorAll('[role=alertdialog],[role=dialog],[class*=toast]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,160))}
  })()`)
  rec('remove-click', conf)
  R['remove-click'].shot = await p.shoot('m4c-remove')
}

writeFileSync(join(SHOT_DIR, '..', 'm4c-gallery.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 10),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

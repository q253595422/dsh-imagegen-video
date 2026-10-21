/**
 * 第 5 批补 2：
 *  A) 无文字按钮的可达名称审计（画布工具栏 20 个图标按钮有没有 aria-label）
 *  B) 画布重命名（双击重命名）是否可用、Escape/回车行为
 *  C) 收藏画布 / 删除画布 的反馈与确认
 *  D) 图片节点上的「标注」入口：从素材库拖一张图 or 用已有图节点
 *  E) 连线：节点边缘手柄 / 工具条连线按钮
 * 全程只读为主；删除只删本轮自己新建的画布。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 280000).unref()

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
const nodes = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id').slice(0,10), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height), text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,32)}
  })
})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) { const n = await nodes(); if (n.length) break; await sleep(300) }
await tapAria('适应全部内容'); await sleep(700)

// ---------- A. 工具按钮可达名称审计 ----------
step('a11y-audit')
const audit = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  const btns=[...c.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect(); return r.width>0&&r.height>0})
  const unnamed=btns.filter(b=>{
    const t=(b.innerText||'').trim()
    const aria=(b.getAttribute('aria-label')||'').trim()
    const title=(b.getAttribute('title')||'').trim()
    return t==='' && aria===''
  }).map(b=>({cls:String(b.className).slice(0,32), title:b.getAttribute('title')||'', html:(b.innerHTML||'').slice(0,60)}))
  return {total:btns.length, unnamedCount:unnamed.length, unnamed:unnamed.slice(0,12),
    named:btns.length-unnamed.length}
})()`)
rec('a11y-unnamed', audit)

// ---------- B. 重命名 ----------
step('rename')
const rn = await p.evaluate(`(()=>{
  const e=[...document.querySelectorAll('[title="双击重命名"]')][0]
  if(!e) return null; const r=e.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:(e.innerText||'').trim()}})()`)
rec('rename-target', rn)
if (rn) {
  await clickAt(rn, { double: true })
  await sleep(700)
  const st = await p.evaluate(`(()=>{
    const a=document.activeElement
    return {tag:a?a.tagName:'', value:a?(a.value??''):'', ph:a?(a.placeholder||''):'',
      editable:a?!!(a.isContentEditable||a.tagName==='INPUT'||a.tagName==='TEXTAREA'):false,
      role:a?a.getAttribute('role')||'':''}})()`)
  rec('rename-after-dblclick', st)
  R['rename-after-dblclick'] = { ...R['rename-after-dblclick'], shot: await p.shoot('m5h-rename') }
  await p.key('Escape'); await sleep(400)
}

// ---------- C. 收藏 / 删除 ----------
step('fav')
const favBefore = await p.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="收藏画布"]')][0]
  return e?{active:e.getAttribute('data-active'), pressed:e.getAttribute('aria-pressed'), cls:String(e.className).slice(0,40)}:null})()`)
await tapAria('收藏画布')
await sleep(600)
const favAfter = await p.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="收藏画布"]')][0]
  return e?{active:e.getAttribute('data-active'), pressed:e.getAttribute('aria-pressed'), cls:String(e.className).slice(0,40)}:null})()`)
rec('favorite', { before: favBefore, after: favAfter })

step('delete')
await tapAria('删除画布')
await sleep(900)
const del = await p.evaluate(`(()=>{
  const d=[...document.querySelectorAll('[role=alertdialog],[role=dialog],[class*=dialog]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120})
  return {dialogs:d.map(e=>({cls:String(e.className).slice(0,30),
    text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,200),
    buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean)})),
    bodyHasConfirm:/确定|确认删除|不可恢复/.test(document.body.innerText||'')}})()`)
rec('delete-dialog', del)
R['delete-dialog'] = { ...R['delete-dialog'], shot: await p.shoot('m5h-delete-dialog') }
await p.key('Escape'); await sleep(500)

// ---------- D. 从素材库往画布加一张图 → 标注 ----------
step('image-node')
// 工具栏「添加图片」→ 菜单「素材库」
await tapAria('添加图片')
await sleep(800)
const menu = await p.evaluate(`(()=>{
  const m=[...document.querySelectorAll('[role=menu],[class*=backgroundMenu]')].filter(e=>e.getBoundingClientRect().width>60)
  const top=m[m.length-1]
  return top?{text:(top.innerText||'').replace(/\\s+/g,' ').slice(0,120),
    items:[...top.querySelectorAll('button,[role=menuitem]')].map(b=>({t:(b.innerText||'').trim(),x:Math.round(b.getBoundingClientRect().x),y:Math.round(b.getBoundingClientRect().y),w:Math.round(b.getBoundingClientRect().width)})).filter(i=>i.w>0)}:null})()`)
rec('image-menu', menu)
const pick = menu?.items?.find(i => i.t === '素材库')
if (pick) {
  await clickAt({ x: pick.x + Math.round(pick.w / 2), y: pick.y + 10 })
  await sleep(1600)
  const picker = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200)
    const top=d[d.length-1]
    return top?{text:(top.innerText||'').replace(/\\s+/g,' ').slice(0,220),
      options:top.querySelectorAll('[role=option]').length,
      imgs:top.querySelectorAll('img').length,
      buttons:[...top.querySelectorAll('button')].map(b=>(b.innerText||'').trim()||b.getAttribute('aria-label')||'').filter(Boolean).slice(0,8)}:null})()`)
  rec('gallery-picker', picker)
  R['gallery-picker'] = { ...R['gallery-picker'], shot: await p.shoot('m5h-gallery-picker') }
  // 选第一张
  const opt = await p.evaluate(`(()=>{
    const o=[...document.querySelectorAll('[role=option]')].filter(e=>e.getBoundingClientRect().width>60)[0]
    if(!o) return null; const r=o.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  if (opt) {
    await clickAt(opt); await sleep(2000)
    const after = await p.evaluate(`(()=>{
      const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200)
      return {dialogsLeft:d.length}})()`)
    rec('picker-closed', after)
    await sleep(1200)
    rec('nodes-with-image', await nodes())
    R['nodes-with-image'] = { ...R['nodes-with-image'], shot: await p.shoot('m5h-image-node') }

    // 选中图片节点 → 找标注按钮
    const imgNode = await p.evaluate(`(()=>{
      const c=document.querySelector('[data-canvas-workspace]')
      const n=[...c.querySelectorAll('[data-node-id]')].find(x=>x.querySelector('img'))
      if(!n) return null; const r=n.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height*0.4),w:Math.round(r.width),h:Math.round(r.height)}})()`)
    rec('image-node-pos', imgNode)
    if (imgNode) {
      await clickAt(imgNode)
      await sleep(600)
      const annotate = await p.evaluate(`(()=>{
        const c=document.querySelector('[data-canvas-workspace]')
        return {labels:[...c.querySelectorAll('[aria-label],[title]')].map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||'')
          .filter(x=>/标注|批注|画框|区域/.test(x)).slice(0,8),
          shotNote:'labels with 标注'} })()`)
      rec('annotate-controls', annotate)
      await tapAria('标注：在图片上画框，自动挂上提示词卡片')
      await sleep(800)
      const hint = await p.evaluate(`(()=>{
        const c=document.querySelector('[data-canvas-workspace]')
        return {text:(c.innerText||'').replace(/\\s+/g,' ').match(/.{0,40}(画框|拖拽|引导线).{0,60}/)?.[0]||'',
          cursor:getComputedStyle(c.querySelector('[class*=viewport]')).cursor}})()`)
      rec('annotate-mode', hint)
      R['annotate-mode'] = { ...R['annotate-mode'], shot: await p.shoot('m5h-annotate-mode') }
      await p.key('Escape'); await sleep(400)
    }
  }
}

// ---------- E. 节点工具条里的连线 ----------
step('connect-button')
const strip = await p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('[aria-label],[title]')].map(e=>(e.getAttribute('aria-label')||e.getAttribute('title')||''))
    .filter(x=>/连线|连接|参考图|作为输入/.test(x)).slice(0,10)})()`)
rec('connect-labels', strip)

writeFileSync(join(SHOT_DIR, '..', 'm5h-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

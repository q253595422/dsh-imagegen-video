/**
 * 第 5 批·无限画布 修正版：先确认画布工具条存在（说明真的在画布视图里），再操作。
 * 上一版把顶栏第一个下拉误当成项目切换器，实际点到了「普通生图」标签，导致后面全在生图面板里。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 800)) }

async function clickPt (p, pt) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(900)
}

async function tapText (p, text) {
  const r = await p.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,[role=tab],[role=button],li,a')]
    const hit=els.find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await clickPt(p, r)
  return true
}

async function tapTitle (p, title) {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button],[role=menuitem]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await clickPt(p, r)
  return true
}

/** 是否处于画布视图：底部有「添加图片节点」这枚工具栏按钮 */
const inCanvas = (p) => p.evaluate(`!![...document.querySelectorAll('button')]
  .find(e=>e.getAttribute('title')==='添加图片节点'&&e.getBoundingClientRect().width>0)`)

/** 画布快照：有没有节点、节点文字、右上状态、底部工具条 */
const snap = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  if(!v) return {noView:true}
  const all=[...v.querySelectorAll('*')]
  const nodeEls=all.filter(e=>/node|Node/.test((e.className||'').toString())&&e.getBoundingClientRect().width>60)
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return {
    text:t.slice(0,700),
    loading:/加载中…/.test(t),
    saved:/已保存|保存中…|保存失败/.exec(t)?.[0]||'',
    nodeClasses:[...new Set(nodeEls.map(e=>(e.className||'').toString().split(' ')[0]))].slice(0,10),
    nodeCount:nodeEls.length,
    canvasRoot:[...v.querySelectorAll('[data-canvas-id],[data-canvas],[class*="canvasRoot"],[class*="CanvasRoot"],[class*="viewport"],[class*="Viewport"]')]
      .map(e=>e.tagName.toLowerCase()+'.'+(e.className||'').toString().split(' ')[0]).slice(0,8),
  }
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '无限画布')
  let ok = false
  for (let i = 0; i < 40; i++) { if (await inCanvas(p)) { ok = true; break } await sleep(300) }
  rec('canvas-open', { ok, state: await snap(p) })
  R['canvas-open'].shot = await p.shoot('127-m5c-canvas-open')

  // 等「加载中…」消失，记录耗时
  let waited = 0
  for (let i = 0; i < 60; i++) { const s = await snap(p); if (!s.loading) break; waited += 300; await sleep(300) }
  rec('after-loading', { waitedMs: waited, state: await snap(p) })
  R['after-loading'].shot = await p.shoot('128-m5c-after-loading')

  // 顶栏项目名附近的控件（只取 y<130 且带 title 的）
  rec('canvas-topbar', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    return [...v.querySelectorAll('button,input')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.y<130&&r.width>0})
      .map(e=>({tag:e.tagName.toLowerCase(),text:(e.innerText||'').trim().slice(0,16),title:(e.getAttribute('title')||'').slice(0,40),aria:(e.getAttribute('aria-label')||'').slice(0,30),disabled:e.disabled||false,x:Math.round(e.getBoundingClientRect().x)}))
  })()`))

  // 画布区 DOM 骨架（带 class 的容器，前两层）
  rec('canvas-dom', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const walk=(el,d)=>{ if(d>3) return [];
      return [...el.children].map(c=>{
        const cls=(c.className||'').toString().split(' ')[0]
        const r=c.getBoundingClientRect()
        return {tag:c.tagName.toLowerCase(),cls, w:Math.round(r.width), h:Math.round(r.height), kids:d<2?walk(c,d+1).slice(0,8):[]}
      }).filter(o=>o.w>10&&o.h>10)
    }
    return walk(v,0)
  })()`))

  // ---------- A. 添加图片节点（画布视图内） ----------
  const a1 = await tapTitle(p, '添加图片节点')
  await sleep(1500)
  rec('add-image', { clicked: a1, state: await snap(p) })
  R['add-image'].shot = await p.shoot('129-m5c-add-image')

  // 节点内的可点元素：找 class 含 node 且尺寸合理的容器，取最右/最新那个
  rec('image-node-detail', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const cands=[...v.querySelectorAll('[class*="node"],[class*="Node"]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>100&&r.height>80})
      .sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)
    const n=cands[0]
    if(!n) return {none:true, classes:[...new Set([...v.querySelectorAll('[class*="node"],[class*="Node"]')].map(e=>(e.className||'').toString().split(' ')[0]))].slice(0,12)}
    return {
      cls:(n.className||'').toString().slice(0,80),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,240),
      buttons:[...n.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,16),title:(b.getAttribute('title')||'').slice(0,44),aria:(b.getAttribute('aria-label')||'').slice(0,30)})),
      inputs:[...n.querySelectorAll('input,textarea,select')].map(i=>({tag:i.tagName.toLowerCase(),ph:(i.placeholder||'').slice(0,40),type:i.type||''})),
    }
  })()`))

  // ---------- B. 空态：双击空白新建？先看有没有「开始你的创作」 ----------
  rec('empty-title-present', await p.evaluate(`(()=>{
    const t=(document.querySelector('[data-dsh-imagegen-view]')||document.body).innerText||''
    return {hasEmptyTitle:/开始你的创作/.test(t), hasEmptyHint:/双击空白处/.test(t)}
  })()`))

  // ---------- C. 添加配置节点并读它的控件 ----------
  const a2 = await tapTitle(p, '添加配置节点')
  await sleep(1500)
  rec('add-config', { clicked: a2, state: await snap(p) })
  R['add-config'].shot = await p.shoot('130-m5c-add-config')

  rec('config-detail', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const n=[...v.querySelectorAll('[class*="node"],[class*="Node"]')]
      .filter(e=>/生成配置|把图片节点连线/.test(e.innerText||''))
      .sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0]
    if(!n) return {none:true}
    return {
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,400),
      buttons:[...n.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,22),title:(b.getAttribute('title')||'').slice(0,40),dis:b.disabled||false,aria:(b.getAttribute('aria-pressed')||b.getAttribute('aria-selected')||'')})),
      selects:[...n.querySelectorAll('select')].map(s=>({val:s.value,opts:[...s.options].map(o=>o.text).slice(0,14)})),
      inputs:[...n.querySelectorAll('input,textarea')].map(i=>({tag:i.tagName.toLowerCase(),ph:(i.placeholder||'').slice(0,44)})),
    }
  })()`))

  rec('final', await snap(p))
  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 12)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm5c-canvas-nodes.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

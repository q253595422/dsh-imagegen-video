/**
 * 第 5 批·无限画布 第二轮：顶栏菜单 + 添加节点 + 节点内的工具条。
 * 每步都记录文案与可点元素，截图落在 .ui-review/shots/。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }

/** 按可见文字（trim 相等）点一个元素 */
async function tapText (p, text) {
  const r = await p.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,a,[role=tab],[role=button],[role=menuitem],li,div[tabindex]')]
    const hit=els.find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(900)
  return true
}

/** 按 title / aria-label 点（画布工具条按钮只有图标） */
async function tapTitle (p, title) {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(900)
  return true
}

/** 画布当前快照：节点数、浮层文字、菜单项 */
const snap = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
  const nodes=[...v.querySelectorAll('[data-node-id],[data-canvas-node],[class*="canvasNode"],[class*="node"]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>40&&r.height>40})
  const menus=[...document.querySelectorAll('[role=menu],[role=listbox],[class*="menu"],[class*="Menu"],[class*="popover"],[class*="Popover"]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0})
  return {
    loading:/加载中|正在加载/.test(v.innerText||''),
    text:(v.innerText||'').replace(/\\s+/g,' ').slice(0,600),
    nodeish:nodes.length,
    menus:menus.map(m=>(m.innerText||'').replace(/\\s+/g,' ').slice(0,300)).slice(0,4),
    dialogs:[...document.querySelectorAll('[role=dialog]')].map(d=>(d.innerText||'').replace(/\\s+/g,' ').slice(0,200)),
  }
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '无限画布')
  await sleep(2500)

  // ---------- A. 顶栏：画布名 / + / 收藏 / 删除 ----------
  rec('initial', await snap(p))
  R.initial.shot = await p.shoot('121-m5b-initial')

  // 「加载中…」到底是常驻还是瞬时：隔 4 秒再看
  await sleep(4000)
  rec('after-4s', await snap(p))

  // 顶栏那排按钮的 title
  rec('topbar', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const top=v.querySelector('[class*="canvasHeader"],[class*="CanvasHeader"],[class*="toolbar"],[class*="Toolbar"]')||v
    return [...top.querySelectorAll('button,input,select')].slice(0,30).map(e=>({
      tag:e.tagName.toLowerCase(),
      text:(e.innerText||'').trim().slice(0,20),
      title:(e.getAttribute('title')||'').slice(0,50),
      aria:(e.getAttribute('aria-label')||'').slice(0,50),
      val:(e.value||'').toString().slice(0,20),
      disabled:e.disabled||false,
      y:Math.round(e.getBoundingClientRect().y),
    })).filter(o=>o.y<140)
  })()`))

  // 画布名旁边那个下拉（左上角空 combobox）
  const dropdownOpened = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const cands=[...v.querySelectorAll('button,[role=combobox],select,[class*="select"],[class*="Select"]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.y<120&&r.width>60&&r.height>10})
    if(!cands.length) return null
    const c=cands[0]; c.click()
    return {tag:c.tagName.toLowerCase(), title:c.getAttribute('title')||'', cls:(c.className||'').toString().slice(0,40)}
  })()`)
  await sleep(1000)
  rec('project-switcher', { clicked: dropdownOpened, state: await snap(p) })
  R['project-switcher'].shot = await p.shoot('122-m5b-project-switcher')
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  // ---------- B. 添加图片节点 ----------
  const addImage = await tapTitle(p, '添加图片节点')
  await sleep(1200)
  rec('add-image-node', { clicked: addImage, state: await snap(p) })
  R['add-image-node'].shot = await p.shoot('123-m5b-add-image-node')

  // 新节点里的可点元素（含 hover 前的按钮）
  rec('image-node-controls', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const nodes=[...v.querySelectorAll('[data-node-id]')]
    const n=nodes[nodes.length-1]
    if(!n) return {noNode:true, sample:[...v.querySelectorAll('[class*="node"]')].length}
    return {
      id:n.getAttribute('data-node-id'),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,300),
      buttons:[...n.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,18),title:(b.getAttribute('title')||'').slice(0,40),aria:(b.getAttribute('aria-label')||'').slice(0,30)})),
    }
  })()`))

  // ---------- C. 添加文本节点并输入 ----------
  const addText = await tapTitle(p, '添加文本节点')
  await sleep(1200)
  rec('add-text-node', { clicked: addText, state: await snap(p) })
  R['add-text-node'].shot = await p.shoot('124-m5b-add-text-node')

  const typed = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const tas=[...v.querySelectorAll('textarea,[contenteditable="true"],input[type=text]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>80&&r.height>20})
    if(!tas.length) return {none:true, ph:[...v.querySelectorAll('textarea')].map(t=>t.placeholder)}
    const t=tas[tas.length-1]
    t.focus()
    return {ph:t.placeholder||'', cls:(t.className||'').toString().slice(0,40), tag:t.tagName.toLowerCase()}
  })()`)
  rec('text-node-input', typed)
  if (!typed.none) {
    await p.send('Input.insertText', { text: '一只橘猫坐在窗台上' })
    await sleep(600)
  }
  rec('after-typing', await snap(p))
  R['after-typing'].shot = await p.shoot('125-m5b-text-typed')

  // ---------- D. 添加配置节点（生成配置） ----------
  const addConfig = await tapTitle(p, '添加配置节点')
  await sleep(1400)
  rec('add-config-node', { clicked: addConfig, state: await snap(p) })
  R['add-config-node'].shot = await p.shoot('126-m5b-add-config-node')
  rec('config-node-controls', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const nodes=[...v.querySelectorAll('[data-node-id]')]
    const n=nodes[nodes.length-1]
    if(!n) return {noNode:true}
    return {
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,400),
      buttons:[...n.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,20),title:(b.getAttribute('title')||'').slice(0,40),dis:b.disabled||false})),
      selects:[...n.querySelectorAll('select')].map(s=>({val:s.value, opts:[...s.options].map(o=>o.text).slice(0,12)})),
    }
  })()`))

  rec('final', await snap(p))
  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 12)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
  R.lastState = await snap(p).catch(() => null)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm5b-canvas-nodes.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

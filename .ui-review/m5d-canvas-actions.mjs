/**
 * 第 5 批·无限画布 第三轮：交互面
 * A 选中节点后的底部生成条（量「图片/视频」切换器被压成两行）
 * B 节点右键菜单 / 悬停工具条
 * C 技能库
 * D 运行工作流（未选中时）
 * E 画布背景面板
 * F 快捷键面板（按 ?）
 * G 缩放（滑块 / 滚轮 / 中键平移）、缩略图开关
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 900)) }

const clickPt = async (p, pt, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: opts.button || 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: opts.button || 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

const rectOf = (p, sel) => p.evaluate(`(()=>{
  const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
  const r=e.getBoundingClientRect(); if(r.width===0) return null
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}
})()`)

const tapTitle = async (p, title) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button],[role=menuitem]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await clickPt(p, r)
  return true
}

/** 收集当前所有浮层（菜单/弹层）的文字 */
const popovers = (p) => p.evaluate(`(()=>{
  const all=[...document.querySelectorAll('[role=menu],[role=dialog],[role=listbox],[class*="menu"],[class*="Menu"],[class*="popover"],[class*="Popover"],[class*="dropdown"],[class*="Dropdown"]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>60&&r.height>40&&getComputedStyle(e).visibility!=='hidden'})
  return all.map(e=>({
    cls:(e.className||'').toString().split(' ')[0].slice(0,26),
    role:e.getAttribute('role')||'',
    w:Math.round(e.getBoundingClientRect().width),
    text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,320),
    items:[...e.querySelectorAll('button,[role=menuitem],[role=option]')].map(b=>(b.innerText||'').trim().slice(0,26)).filter(Boolean).slice(0,20),
  }))
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // 切到画布
  await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='无限画布'); if(b) b.click()})()`)
  for (let i = 0; i < 30; i++) {
    if (await p.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='添加图片节点')`)) break
    await sleep(300)
  }
  await sleep(1500)

  // ---------- A. 选中一个节点，量底部生成条 ----------
  const nodeBox = await p.evaluate(`(()=>{
    const n=[...document.querySelectorAll('[class*="_node"]')].filter(e=>{
      const r=e.getBoundingClientRect(); return r.width>150&&r.height>100&&/生成配置|文本节点|素材库图片/.test(e.innerText||'')
    })[0]
    if(!n) return null
    const r=n.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+20),text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,40)}
  })()`)
  rec('node-box', nodeBox)
  if (nodeBox) await clickPt(p, nodeBox)

  rec('composer', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    // 底部生成条：包含 placeholder「描述要生成的图片」的文本域所在的容器
    const ta=[...v.querySelectorAll('textarea')].find(t=>/描述要生成的图片/.test(t.placeholder||''))
    if(!ta) return {noComposer:true}
    let box=ta.parentElement
    for(let i=0;i<4&&box;i++){ if(/composer|Composer|generator|Generator/.test((box.className||'').toString())) break; box=box.parentElement }
    const scope=box||ta.parentElement
    const r=scope.getBoundingClientRect()
    return {
      cls:(scope.className||'').toString().slice(0,60),
      box:{w:Math.round(r.width),h:Math.round(r.height)},
      buttons:[...scope.querySelectorAll('button')].map(b=>{
        const br=b.getBoundingClientRect()
        return {t:(b.innerText||'').trim().slice(0,18),w:Math.round(br.width),h:Math.round(br.height),title:(b.getAttribute('title')||'').slice(0,30),dis:b.disabled||false}
      }),
      selects:[...scope.querySelectorAll('select')].map(s=>({val:s.value,opts:[...s.options].map(o=>o.text).slice(0,8)})),
    }
  })()`))
  R.composer.shot = await p.shoot('131-m5d-composer')

  // ---------- B. 右键节点 ----------
  const nb = await p.evaluate(`(()=>{
    const n=[...document.querySelectorAll('[class*="_node"]')].filter(e=>{
      const r=e.getBoundingClientRect(); return r.width>150&&r.height>100
    })[0]
    if(!n) return null
    const r=n.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (nb) {
    await clickPt(p, nb, { button: 'right', wait: 1000 })
    rec('context-menu', await popovers(p))
    R['context-menu'].shot = await p.shoot('132-m5d-context-menu')
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
  }

  // ---------- C. 技能库 ----------
  const skillBtn = await tapTitle(p, '技能库')
  await sleep(1500)
  rec('skills-panel', { clicked: skillBtn, popovers: await popovers(p) })
  R['skills-panel'].shot = await p.shoot('133-m5d-skills')
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  // ---------- D. 运行工作流（不选中任何节点） ----------
  // 先点空白处取消选中
  await clickPt(p, { x: 700, y: 300 }, { wait: 600 })
  const wf = await tapTitle(p, '运行工作流（从选中节点往下）')
  await sleep(1500)
  rec('workflow-noselect', { clicked: wf, popovers: await popovers(p), text: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    return (v.innerText||'').replace(/\\s+/g,' ').slice(-300)
  })()`)})
  R['workflow-noselect'].shot = await p.shoot('134-m5d-workflow-noselect')

  // ---------- E. 画布背景 ----------
  const bg = await tapTitle(p, '画布背景')
  await sleep(1200)
  rec('background-panel', { clicked: bg, popovers: await popovers(p) })
  R['background-panel'].shot = await p.shoot('135-m5d-background')
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  // ---------- F. 快捷键面板：按 ? ----------
  await clickPt(p, { x: 700, y: 300 }, { wait: 400 })
  await p.key('?')
  await sleep(1200)
  rec('shortcuts', { popovers: await popovers(p) })
  R.shortcuts.shot = await p.shoot('136-m5d-shortcuts')
  const scClose = await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog],[class*="modal"],[class*="Modal"]')].find(e=>{const r=e.getBoundingClientRect(); return r.width>200&&r.height>200})
    if(!d) return null
    const b=[...d.querySelectorAll('button')].find(x=>/关闭|Close/.test(x.getAttribute('aria-label')||x.innerText||''))
    if(!b) return {noCloseButton:true, buttons:[...d.querySelectorAll('button')].map(x=>({t:(x.innerText||'').slice(0,14),aria:x.getAttribute('aria-label')||'',title:x.getAttribute('title')||''})).slice(0,10)}
    const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  rec('shortcuts-close', scClose)
  if (scClose && scClose.x) await clickPt(p, scClose)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  // ---------- G. 缩放：读滑块值 → 滚轮放大 → 复位 ----------
  const zoomBefore = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').match(/(\\d+)%/); return t?t[1]:null
  })()`)
  await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 0, deltaY: -240 })
  await sleep(900)
  const zoomAfter = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').match(/(\\d+)%/); return t?t[1]:null
  })()`)
  rec('zoom', { before: zoomBefore, after: zoomAfter })
  R.zoom.shot = await p.shoot('137-m5d-zoom')

  // 缩略图开关
  const mm = await tapTitle(p, '关闭缩略图')
  await sleep(800)
  rec('minimap-toggle-off', {
    clicked: mm,
    stillOpen: await p.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='关闭缩略图')`),
    openBtn: await p.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='打开缩略图')`),
  })
  R['minimap-toggle-off'].shot = await p.shoot('138-m5d-minimap-off')

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 12)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm5d-canvas-actions.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

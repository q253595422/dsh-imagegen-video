/**
 * 第 5 批·无限画布 第四轮：把源码审计给出的候选逐条在界面上验证。
 * V1 空画布空态（新建画布，不碰现有项目）
 * V2 同时选中两个「生成配置」节点 → 底部生成条是否消失（候选 C12）
 * V3 生成条里「图片 / 视频」切换器的实际尺寸（截图里看到被压成两行）
 * V4 Tab 焦点遍历：节点工具条是否随之出现、按钮能否聚焦（候选 C17）
 * V5 顶栏：项目下拉与右侧标题是否重复显示同一名字（截图上看到两处「未命名画布」）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 900)) }

const clickPt = async (p, pt, opts = {}) => {
  if (!pt) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: opts.button || 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: opts.button || 'left', clickCount: 1 })
  await sleep(opts.wait || 800)
  return true
}

const tapTitle = async (p, title) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  return clickPt(p, r)
}

/** 按 innerText 找可见按钮并点（用于「新建画布」这种带文字的） */
const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button],[role=menuitem]')]
      .find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  return clickPt(p, r)
}

/** 所有「生成配置」节点的中心点 */
const configNodes = (p) => p.evaluate(`(()=>{
  return [...document.querySelectorAll('[class*="_node"]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120&&r.height>80&&/生成配置/.test(e.innerText||'')})
    .map(e=>{const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+16),w:Math.round(r.width)}})
})()`)

/** 底部生成条是否存在 + 关键控件尺寸 */
const composer = (p) => p.evaluate(`(()=>{
  const ta=[...document.querySelectorAll('textarea')].find(t=>/描述要生成的图片|描述想生成的视频/.test(t.placeholder||''))
  if(!ta) return {present:false}
  let box=ta.parentElement
  for(let i=0;i<5&&box;i++){ if(box.querySelectorAll('button').length>3) break; box=box.parentElement }
  const scope=box||ta.parentElement
  const btns=[...scope.querySelectorAll('button')].map(b=>{
    const r=b.getBoundingClientRect()
    return {t:(b.innerText||'').trim().slice(0,14), w:Math.round(r.width), h:Math.round(r.height), title:(b.getAttribute('title')||'').slice(0,24)}
  })
  return {present:true, ph:ta.placeholder.slice(0,40), buttons:btns}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='无限画布'); if(b) b.click()})()`)
  for (let i = 0; i < 30; i++) {
    if (await p.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='添加图片节点')`)) break
    await sleep(300)
  }
  await sleep(1800)

  // ---------- V5 顶栏重复显示的名字 ----------
  rec('v5-topbar-names', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const hits=[...v.querySelectorAll('*')].filter(e=>{
      const r=e.getBoundingClientRect()
      return r.y<130&&r.width>0&&r.height>0&&e.children.length===0&&/未命名画布/.test(e.textContent||'')
    })
    return hits.map(e=>({tag:e.tagName.toLowerCase(), text:(e.textContent||'').trim(), x:Math.round(e.getBoundingClientRect().x), w:Math.round(e.getBoundingClientRect().width)}))
  })()`))

  // ---------- V3 生成条控件尺寸（先选中一个配置节点） ----------
  const cfgs = await configNodes(p)
  rec('config-nodes', cfgs)
  if (cfgs[0]) await clickPt(p, cfgs[0], { wait: 1200 })
  rec('v3-composer-one', await composer(p))
  R['v3-composer-one'].shot = await p.shoot('139-m5e-composer-one')

  // ---------- V2 同时选中两个配置节点 ----------
  if (cfgs[1]) {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 })
    await clickPt(p, cfgs[1], { wait: 1200 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
    await sleep(800)
  }
  rec('v2-composer-two', await composer(p))
  rec('v2-selection-count', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'')
    return {handles:[...v.querySelectorAll('[class*="resize"],[class*="Resize"]')].length,
            selected:document.querySelectorAll('[aria-selected="true"],[data-selected="true"]').length,
            text:t.match(/已连接 \\d+ 个输入节点/g)||[]}
  })()`))
  R['v2-composer-two'].shot = await p.shoot('140-m5e-composer-two')

  // ---------- V4 Tab 焦点遍历 ----------
  await clickPt(p, { x: 700, y: 260 }, { wait: 600 }) // 点空白取消选中
  const tabTrace = []
  for (let i = 0; i < 12; i++) {
    await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(220)
    const f = await p.evaluate(`(()=>{
      const a=document.activeElement
      if(!a) return null
      const r=a.getBoundingClientRect()
      const inNode=!!a.closest('[class*="_node"]')
      const toolbarVisible=inNode? (()=>{ const n=a.closest('[class*="_node"]'); return !!n && getComputedStyle(n).opacity!=='0' })(): null
      return {tag:a.tagName.toLowerCase(), title:(a.getAttribute('title')||'').slice(0,32), text:(a.innerText||'').trim().slice(0,18),
              aria:(a.getAttribute('aria-label')||'').slice(0,26), inNode, w:Math.round(r.width), h:Math.round(r.height)}
    })()`)
    if (f) tabTrace.push(f)
  }
  rec('v4-tab-trace', tabTrace)
  R['v4-tab-trace'].shot = await p.shoot('141-m5e-tab-trace')

  // ---------- V1 新建空画布 → 空态 ----------
  const newBtn = await tapTitle(p, '新建画布')
  await sleep(2500)
  rec('v1-new-canvas', { clicked: newBtn, state: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {text:t.slice(0,400), hasEmptyTitle:/开始你的创作/.test(t), hasEmptyHint:/双击空白处/.test(t),
            nodes:[...v.querySelectorAll('[class*="_node"]')].filter(e=>e.getBoundingClientRect().width>100).length}
  })()`)})
  R['v1-new-canvas'].shot = await p.shoot('142-m5e-empty-canvas')

  // 空画布上：空白右键菜单（看有没有「添加图片」「粘贴」等）
  await clickPt(p, { x: 760, y: 420 }, { button: 'right', wait: 1000 })
  rec('v1-blank-context', await p.evaluate(`(()=>{
    const m=[...document.querySelectorAll('[role=menu]')].filter(e=>e.getBoundingClientRect().width>40)
    return m.map(e=>({w:Math.round(e.getBoundingClientRect().width), text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,200)}))
  })()`))
  R['v1-blank-context'].shot = await p.shoot('143-m5e-blank-context')
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)

  // 空画布上双击空白 → 新建菜单
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 780, y: 460, button: 'left', clickCount: 2 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 780, y: 460, button: 'left', clickCount: 2 })
  await sleep(1200)
  rec('v1-double-click-menu', await p.evaluate(`(()=>{
    const m=[...document.querySelectorAll('[role=menu]')].filter(e=>e.getBoundingClientRect().width>40)
    return m.map(e=>({text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,240)}))
  })()`))
  R['v1-double-click-menu'].shot = await p.shoot('144-m5e-doubleclick-menu')

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 12)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm5e-canvas-verify.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

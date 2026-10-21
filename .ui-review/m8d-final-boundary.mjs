/**
 * 第 8 批·最后三个缺口
 * D1 顶部工作区导航（普通生图/素材库/…）是不是键盘可达：tag / role / tabindex / 能否 Enter 激活
 * D2 「已连接」是什么元素、按下去有没有反应（它在 Tab 序里占了一站）
 * D3 760 宽设置弹层：正确坐标打开 → 内部滚动能否到达最底部
 * D4 Tab 序里哪两站没有可见焦点环
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

const press = async (p, x, y, w = 900) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const tabKey = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await sleep(200)
}
const enter = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(900)
}
const activeInfo = (p) => p.evaluate(`(()=>{
  const a=document.activeElement; if(!a) return {none:true}
  const r=a.getBoundingClientRect(); const cs=getComputedStyle(a)
  return {tag:a.tagName.toLowerCase(), role:a.getAttribute('role')||'', tabindex:a.getAttribute('tabindex'),
    t:(a.innerText||a.value||'').replace(/\\s+/g,' ').trim().slice(0,24), aria:a.getAttribute('aria-label')||'',
    outline:cs.outlineStyle+'/'+cs.outlineWidth, shadow:(cs.boxShadow||'none').slice(0,50),
    cls:(a.className||'').toString().slice(0,40)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---------- D1 导航 tab 的可达性
  rec('d1-nav-tabs', await p.evaluate(`(()=>{
    const nav=[...document.querySelectorAll('[data-dsh-imagegen-tab],[role=tab]')].filter(e=>e.getBoundingClientRect().width>0)
    return nav.map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,12),
      tag:e.tagName.toLowerCase(), role:e.getAttribute('role'), dataTab:e.hasAttribute('data-dsh-imagegen-tab'),
      tabindex:e.getAttribute('tabindex'), native:e.tabIndex>=0,
      ariaSelected:e.getAttribute('aria-selected'), aria:e.getAttribute('aria-label')||''}))
  })()`))
  // 「已连接」
  rec('d2-connected', await p.evaluate(`(()=>{
    const b=[...document.querySelectorAll('button,[role=button],span,div')].filter(e=>{
      const t=(e.innerText||'').trim(); return t==='已连接'&&e.getBoundingClientRect().width>0&&e.children.length<=1})
    const el=b.sort((x,y)=>x.getBoundingClientRect().width-y.getBoundingClientRect().width)[0]
    if(!el) return {none:true}
    const r=el.getBoundingClientRect(); const cs=getComputedStyle(el)
    return {tag:el.tagName.toLowerCase(), role:el.getAttribute('role'), tabindex:el.getAttribute('tabindex'),
      nativeFocusable: el.tabIndex>=0, cursor:cs.cursor,
      w:Math.round(r.width),h:Math.round(r.height), title:el.getAttribute('title')||'',
      parentTag:el.parentElement?.tagName.toLowerCase(), parentRole:el.parentElement?.getAttribute('role')||''}
  })()`))
  // 「开始生成」是否可达（tabindex）
  rec('d1-generate-btn', await p.evaluate(`(()=>{
    const b=[...document.querySelectorAll('button')].find(e=>/开始生成/.test(e.innerText||''))
    if(!b) return {none:true}
    return {tag:b.tagName.toLowerCase(), tabindex:b.getAttribute('tabindex'), native:b.tabIndex>=0,
      dis:b.disabled, aria:b.getAttribute('aria-label')||'', w:Math.round(b.getBoundingClientRect().width)}
  })()`))

  // 键盘 Tab 到导航 tab 之外：直接试 Tab 序列前 3 站是否跳过导航
  await p.evaluate(`(()=>{ document.activeElement?.blur?.() })()`)
  const first = []
  for (let i = 0; i < 6; i++) { await tabKey(p); first.push(await activeInfo(p)) }
  rec('d1-first-stops', first.map(o => `${o.tag}${o.role?'['+o.role+']':''}:${o.t || o.aria || '-'}`))

  // ---------- D3 设置弹层 @760（正确坐标：底部 gear）
  await p.setViewport(760, 900)
  await sleep(1800)
  const gear = await p.evaluate(`(()=>{
    const b=[...document.querySelectorAll('button,[role=button]')].filter(e=>e.getBoundingClientRect().width>0)
      .find(e=>e.getAttribute('aria-label')==='设置')
    if(!b) return {none:true}
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}
  })()`)
  rec('d3-gear', gear)
  if (gear && !gear.none) {
    await press(p, gear.x, gear.y, 3000)
    rec('d3-dialog', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>300).pop()
      if(!dlg) return {none:true, roleCount:document.querySelectorAll('[role=dialog]').length}
      const r=dlg.getBoundingClientRect(); const vh=window.innerHeight
      const sc=[...dlg.querySelectorAll('*')].filter(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      return {box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
        bottomGap:Math.round(vh-r.bottom), vh,
        scrollers: sc.map(e=>({tag:e.tagName.toLowerCase(),sh:e.scrollHeight,ch:e.clientHeight,
          pos:getComputedStyle(e).position})).slice(0,3),
        lastVisibleText:(()=>{const pts=document.elementsFromPoint(r.x+r.width/2, r.bottom-8)
          .map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean); return pts[0]?.slice(0,40)})()}
    })()`))
    R['d3-dialog'].shot = await p.shoot('212-m8d-settings-760')
    rec('d3-scroll', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>300).pop()
      const sc=[...dlg.querySelectorAll('*')].find(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      if(!sc) {
        // 整个弹层自身滚动？
        const canScroll=dlg.scrollHeight>dlg.clientHeight+4
        return {noInnerScroller:true, dlgScrollable:canScroll, sh:dlg.scrollHeight, ch:dlg.clientHeight}
      }
      sc.scrollTop=sc.scrollHeight
      const leaves=[...dlg.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim().length>1)
      const last=leaves[leaves.length-1]; const r=last.getBoundingClientRect()
      return {scrollTop:Math.round(sc.scrollTop), sh:sc.scrollHeight, ch:sc.clientHeight,
        lastText:(last.innerText||'').trim().slice(0,28), lastBottom:Math.round(r.bottom),
        vh:window.innerHeight, fullyReachable:r.bottom<=window.innerHeight+2}
    })()`))
    R['d3-scroll'].shot = await p.shoot('213-m8d-settings-760-bottom')
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(800)
    rec('d3-esc', await p.evaluate(`document.querySelectorAll('[role=dialog]').length`))
  }

  // ---------- D4 无焦点环的站
  await p.setViewport(1600, 1000)
  await sleep(1500)
  await p.evaluate(`(()=>{ document.activeElement?.blur?.() })()`)
  const noRing = []
  for (let i = 0; i < 16; i++) {
    await tabKey(p)
    const o = await activeInfo(p)
    if (!o.none && o.outline.startsWith('none') && /none|^0px/.test(o.shadow)) {
      noRing.push({i, tag:o.tag, t:o.t, aria:o.aria, outline:o.outline, shadow:o.shadow, cls:o.cls})
    }
  }
  rec('d4-no-ring', { count: noRing.length, stops: noRing })
  R['d4-no-ring'].shot = await p.shoot('214-m8d-focus-ring')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8d-final-boundary.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

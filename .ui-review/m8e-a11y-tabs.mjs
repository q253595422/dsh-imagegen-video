/**
 * 第 8 批·E 组（最后）
 * E1 工作区导航用 roving tabindex（只有选中项 tabindex=0），方向键能否切换？不能 = 4/5 个工作区键盘进不去
 * E2 面板内二级 tab（文生图/图生图/生视频）同样：方向键能否切换
 * E3 设置弹层底部那行「当前版本：0.1.7-rc.2」的上下文：它是宿主版本还是插件版本？附近有没有「检查更新」
 * E4 「已连接」按钮按下去有没有反应
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
const key = async (p, k, code, vk, mod = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod })
  await sleep(700)
}
const activeInfo = (p) => p.evaluate(`(()=>{
  const a=document.activeElement; if(!a) return {none:true}
  const r=a.getBoundingClientRect()
  return {tag:a.tagName.toLowerCase(), role:a.getAttribute('role')||'',
    ti:a.getAttribute('tabindex'), sel:a.getAttribute('aria-selected'),
    t:(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,14), aria:a.getAttribute('aria-label')||'',
    x:Math.round(r.x), y:Math.round(r.y)}
})()`)
const focusByText = (p, text) => p.evaluate(`(()=>{
  const want=${JSON.stringify(text)}
  const el=[...document.querySelectorAll('[role=tab],button')].find(e=>{
    const t=(e.innerText||'').replace(/\\s+/g,'').trim(); const r=e.getBoundingClientRect()
    return t===want&&r.width>0})
  if(!el) return {none:true}
  el.focus()
  return {ok:document.activeElement===el, ti:el.getAttribute('tabindex'), tag:el.tagName.toLowerCase()}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---- E1 工作区导航方向键
  rec('e1-focus-selected', await focusByText(p, '普通生图'))
  const trail = [await activeInfo(p)]
  for (const [k, code, vk] of [['ArrowRight','ArrowRight',39],['ArrowRight','ArrowRight',39],['ArrowRight','ArrowRight',39],['ArrowLeft','ArrowLeft',37]]) {
    await key(p, k, code, vk)
    trail.push(await activeInfo(p))
  }
  rec('e1-arrow-trail', trail.map(o=>`${o.t||'-'}(sel=${o.sel},ti=${o.ti})`))
  // 焦点还在原处但 aria-selected 变了吗？
  rec('e1-selected-after', await p.evaluate(`(()=>{
    const tabs=[...document.querySelectorAll('[role=tab]')].filter(e=>e.getBoundingClientRect().width>0&&/普通生图|素材库|无限画布|电商模式预览|图片转 PPT/.test(e.innerText||''))
    return tabs.map(e=>({t:(e.innerText||'').replace(/\\s+/g,'').slice(0,8),sel:e.getAttribute('aria-selected'),ti:e.getAttribute('tabindex')}))
  })()`))
  R['e1-arrow-trail'].shot = await p.shoot('215-m8e-nav-arrow')

  // 用 Enter 在聚焦的未选中 tab 上激活
  const f2 = await p.evaluate(`(()=>{
    const el=[...document.querySelectorAll('[role=tab]')].find(e=>(e.innerText||'').replace(/\\s+/g,'').trim()==='素材库'&&e.getBoundingClientRect().width>0)
    if(!el) return {none:true}
    el.focus(); return {focused:document.activeElement===el, ti:el.getAttribute('tabindex')}
  })()`)
  rec('e1-focus-unselected', f2)
  await key(p, 'Enter', 'Enter', 13)
  rec('e1-after-enter', { active: await activeInfo(p), workspace: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    return {tab:(v.innerText||'').replace(/\\s+/g,' ').slice(0,80)}
  })()`) })

  // ---- E2 二级 tab 方向键
  await focusByText(p, '文生图')
  const t2 = [await activeInfo(p)]
  await key(p, 'ArrowRight', 'ArrowRight', 39)
  t2.push(await activeInfo(p))
  rec('e2-inner-tabs', { trail: t2.map(o=>`${o.t||'-'}(sel=${o.sel},ti=${o.ti})`),
    all: await p.evaluate(`(()=>[...document.querySelectorAll('[role=tab]')].filter(e=>/文生图|图生图|生视频/.test(e.innerText||'')).map(e=>({t:(e.innerText||'').replace(/\\s+/g,''),sel:e.getAttribute('aria-selected'),ti:e.getAttribute('tabindex')})))()`) })

  // ---- E3 版本行上下文
  await p.setViewport(760, 900)
  await sleep(1500)
  const gear = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>e.getAttribute('aria-label')==='设置'&&e.getBoundingClientRect().width>0)
    if(!b) return {none:true}; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  if (gear && !gear.none) {
    await press(p, gear.x, gear.y, 2800)
    rec('e3-version', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>300).pop()
      if(!dlg) return {none:true}
      const sc=[...dlg.querySelectorAll('*')].find(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      if(sc) sc.scrollTop=sc.scrollHeight
      const leaves=[...dlg.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim().length>1)
      const idx=leaves.findIndex(e=>/当前版本/.test(e.innerText||''))
      const near=leaves.slice(Math.max(0,idx-4), idx+5).map(e=>({t:(e.innerText||'').trim().slice(0,40),tag:e.tagName.toLowerCase()}))
      const btns=[...dlg.querySelectorAll('button')].map(b=>(b.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean)
      const links=[...dlg.querySelectorAll('a')].map(a=>(a.innerText||'').trim().slice(0,20))
      return {near, allButtons:[...new Set(btns)].slice(0,30), links,
        hasUpdateCheck:/检查更新|更新到|升级/.test(dlg.innerText||''),
        hasTestConn:/测试连接/.test(dlg.innerText||'')}
    })()`))
    R['e3-version'].shot = await p.shoot('216-m8e-settings-version')
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(700)
  }

  // ---- E4 「已连接」点击
  await p.setViewport(1600, 1000)
  await sleep(1400)
  const conn = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='已连接'&&e.getBoundingClientRect().width>0)
    if(!b) return {none:true}; const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  if (conn && !conn.none) {
    const before = await p.evaluate(`document.body.innerText.length`)
    await press(p, conn.x, conn.y, 1400)
    rec('e4-connected-click', { before, after: await p.evaluate(`document.body.innerText.length`),
      opened: await p.evaluate(`(()=>{
        const d=[...document.querySelectorAll('[role=dialog],[role=menu],[role=tooltip]')].filter(e=>e.getBoundingClientRect().width>60)
        return {count:d.length, texts:d.map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,90)),
          tail:document.body.innerText.replace(/\\s+/g,' ').slice(-200)}
      })()`) })
    R['e4-connected-click'].shot = await p.shoot('217-m8e-connected')
  }

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8e-a11y-tabs.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

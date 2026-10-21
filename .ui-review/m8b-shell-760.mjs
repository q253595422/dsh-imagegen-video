/**
 * 第 8 批补测。
 * R1 760 宽下宿主左栏：图标栏里的文字（「历史记录」）是否被压成竖排/重叠
 * R2 760 宽下顶部导航：各 tab 是否被压缩/换行（「对话」按钮）
 * R3 760 宽打开设置弹层：宽度、内部是否横向溢出、能否滚动到底部保存
 * R4 760 宽下诊断日志面板
 * R5 1024 宽（笔记本常见）：面板内容是否有换行挤压（左栏 248px 的「0/4」折行）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1100)) }

const press = async (p, x, y, w = 900) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // R1 宿主左栏文字
  await p.setViewport(760, 900)
  await sleep(1600)
  const rail = await p.evaluate(`(()=>{
    const out=[]
    for (const sel of ['aside','[class*="sidebar"],[class*="rail"]']) {
      for (const e of document.querySelectorAll(sel)) {
        const r=e.getBoundingClientRect()
        if(r.width>0&&r.width<120&&r.height>300){
          out.push({w:Math.round(r.width),h:Math.round(r.height),
            text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,120)})
        }
      }
    }
    // 竖排文字元素：宽<20 高>50 且文字长度>2
    const vert=[...document.querySelectorAll('*')].filter(e=>{
      const r=e.getBoundingClientRect(); const cs=getComputedStyle(e)
      return r.width>0&&r.width<22&&r.height>44&&(e.innerText||'').trim().length>=2&&cs.display!=='none'
    }).slice(0,6).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName.toLowerCase(),
      cls:(e.className||'').toString().slice(0,24), w:Math.round(r.width),h:Math.round(r.height),
      text:(e.innerText||'').replace(/\\s+/g,'').slice(0,20), writing:getComputedStyle(e).writingMode}})
    return {rails:out.slice(0,3), verticalText:vert}
  })()`)
  rec('r1-rail-760', rail)

  // R2 顶部导航
  rec('r2-nav-760', await p.evaluate(`(()=>{
    const tabs=[...document.querySelectorAll('[data-dsh-imagegen-tab],[role=tab]')].filter(e=>e.getBoundingClientRect().width>0)
    return tabs.map(e=>{
      const r=e.getBoundingClientRect(); const cs=getComputedStyle(e)
      return {t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,12), w:Math.round(r.width),h:Math.round(r.height),
        lines: Math.round(r.height/parseFloat(cs.lineHeight||'16')),
        whiteSpace:cs.whiteSpace, scrollW:e.scrollWidth, clientW:e.clientWidth}
    })
  })()`))
  R['r2-nav-760'].shot = await p.shoot('204-m8b-shell-760')

  // R3 设置弹层（用 aria-label 或图标按钮定位，避免文字被压竖排后点不到）
  const setBtn = await p.evaluate(`(()=>{
    const c=[...document.querySelectorAll('button,[role=button],a')].filter(e=>{
      const r=e.getBoundingClientRect(); return r.width>0&&r.height>0
    })
    const hit=c.find(e=>/设置/.test(e.getAttribute('aria-label')||'')||/^设置$/.test((e.innerText||'').trim()))
      || c.find(e=>/settings|gear/i.test(e.getAttribute('title')||'')+e.getAttribute('aria-label')||'')
    if(!hit) return {none:true, labels:c.map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||'').filter(Boolean).slice(0,20)}
    const r=hit.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      label:hit.getAttribute('aria-label')||'', text:(hit.innerText||'').trim().slice(0,10)}
  })()`)
  rec('r3-settings-btn', setBtn)
  if (setBtn && !setBtn.none) {
    await press(p, setBtn.x, setBtn.y, 2400)
    rec('r3-dialog-760', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200)
      const vw=window.innerWidth
      return {count:dlg.length, vw,
        boxes:dlg.map(d=>{const r=d.getBoundingClientRect()
          return {label:d.getAttribute('aria-label')||'',x:Math.round(r.x),w:Math.round(r.width),
            h:Math.round(r.height),right:Math.round(r.right),
            overRight:r.right>vw+2, scrollH:d.scrollHeight, clientH:d.clientHeight,
            innerOverflowX:[...d.querySelectorAll('*')].some(e=>e.scrollWidth>e.clientWidth+4&&getComputedStyle(e).overflowX!=='visible')}}),
        backdrop:!!document.querySelector('[class*="backdrop"],[class*="Backdrop"],[class*="overlay"]')}
    })()`))
    R['r3-dialog-760'].shot = await p.shoot('205-m8b-settings-760')

    // 能否滚到底部看到保存按钮
    rec('r3-save-visible', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>200).pop()
      if(!dlg) return {noDialog:true}
      const save=[...dlg.querySelectorAll('button')].find(b=>/^保存/.test((b.innerText||'').trim()))
      if(!save) return {noSave:true, buttons:[...dlg.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).slice(0,14)}
      save.scrollIntoView({block:'center'}); const r=save.getBoundingClientRect()
      return {inViewport:r.top>=0&&r.bottom<=window.innerHeight, box:{t:Math.round(r.top),b:Math.round(r.bottom)},
        dis:save.disabled, vh:window.innerHeight}
    })()`))
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(900)
  }

  // R4 760 诊断日志
  const diag = await p.evaluate(`(()=>{
    const b=document.querySelector('[data-diagnostics-button]')
    if(!b) return null
    b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (diag) {
    await press(p, diag.x, diag.y, 1400)
    rec('r4-diag-760', await p.evaluate(`(()=>{
      const el=document.querySelector('[data-diagnostics-panel]')
      if(!el) return {none:true}
      const r=el.getBoundingClientRect(); const vw=window.innerWidth
      return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),
        overRight:r.right>vw+2, overLeft:r.left<-2,
        scrollH:el.scrollHeight, clientH:el.clientHeight,
        text:(el.innerText||'').replace(/\\s+/g,' ').slice(0,180)}
    })()`))
    R['r4-diag-760'].shot = await p.shoot('206-m8b-diagnostics-760')
  }

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8b-shell-760.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

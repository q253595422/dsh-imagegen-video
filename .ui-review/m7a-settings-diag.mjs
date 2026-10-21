/**
 * 第 7 批：设置卡 / 诊断日志 / 更新入口 / 快捷键。
 * N1 宿主「设置」里的「AI 生图」卡片：折叠态、展开后的分区、渠道编辑是否有「测试连接」
 * N2 面板 header 的「诊断日志」：role/aria-modal、Esc、焦点、清空是否二次确认
 * N3 更新入口：当前没有新版本时界面是否显示「当前版本 / 检查更新」
 * N4 画布快捷键面板（按 ?）：role、Esc、内容分组
 * N5 键盘可达性抽查：Tab 走一遍面板 header，记录焦点顺序与可见焦点环
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1400)) }

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a,div[tabindex],li')]
      .find(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

const esc = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---------- N3 更新入口（先看 header，未点任何东西）----------
  rec('n3-update-entry', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const h=v.querySelector('header')||v
    const t=(h.innerText||'').replace(/\\s+/g,' ')
    const cand=[...document.querySelectorAll('[class*="update"],[aria-haspopup="dialog"]')]
      .map(e=>({tag:e.tagName.toLowerCase(), cls:(e.className||'').toString().slice(0,40),
        text:(e.innerText||'').trim().slice(0,40), title:e.getAttribute('title')||''}))
    return {headerText:t.slice(0,180), updateWidgets:cand,
      mentionsVersion:/\bv?\d+\.\d+\.\d+\b/.test(t),
      hasCheckButton:/检查更新|检查新版本|Check for updates/i.test((v.innerText||''))}
  })()`))

  // ---------- N2 诊断日志 ----------
  const diagBtn = await p.evaluate(`(()=>{
    const b=document.querySelector('[data-diagnostics-button]')
    if(!b) return null
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      pressed:b.getAttribute('aria-pressed'), expanded:b.getAttribute('aria-expanded'), title:b.getAttribute('title')||''}
  })()`)
  rec('n2-button', diagBtn)
  if (diagBtn) {
    await press(p, diagBtn.x, diagBtn.y, { wait: 1500 })
    rec('n2-open', await p.evaluate(`(()=>{
      const panel=document.querySelector('[data-diagnostics-panel]')
      const all=[...document.querySelectorAll('section[aria-label]')].filter(e=>/诊断|Diagnostics/.test(e.getAttribute('aria-label')||''))
      const t=(panel?panel.innerText:'').replace(/\\s+/g,' ')
      return {present:!!panel,
        role:panel?panel.getAttribute('role'):null,
        ariaModal:panel?panel.getAttribute('aria-modal'):null,
        label:panel?panel.getAttribute('aria-label'):null,
        count:all.length,
        text:t.slice(0,420),
        buttons:panel?[...panel.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,14),
          a:b.getAttribute('aria-label')||'', dis:b.disabled})):[],
        focus:{tag:document.activeElement?.tagName.toLowerCase(),
          inside: !!document.activeElement?.closest('[data-diagnostics-panel]')}}
    })()`))
    R['n2-open'].shot = await p.shoot('186-m7a-diagnostics-open')

    // Esc 能否关掉
    await esc(p)
    rec('n2-esc', await p.evaluate(`({stillOpen:!!document.querySelector('[data-diagnostics-panel]')})`))

    // 清空按钮是否二次确认（点它，看有没有 confirm/dialog）
    const clr = await p.evaluate(`(()=>{
      const panel=document.querySelector('[data-diagnostics-panel]')
      if(!panel) return null
      const b=[...panel.querySelectorAll('button')].find(e=>/清空|Clear/.test((e.innerText||'')))
      if(!b) return null
      b.scrollIntoView({block:'center'})
      const r=b.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
        dis:b.disabled, text:(b.innerText||'').trim(),
        hasConfirmAttr:/confirm/i.test(b.outerHTML)}
    })()`)
    rec('n2-clear-button', clr)
    if (clr && !clr.dis) {
      p.send('Page.javascriptDialogOpening').catch(()=>{})
      await press(p, clr.x, clr.y, { wait: 1200 })
      rec('n2-after-clear', await p.evaluate(`(()=>{
        const panel=document.querySelector('[data-diagnostics-panel]')
        return {panelStill:!!panel,
          empty:(panel?panel.innerText:'').replace(/\\s+/g,' ').slice(0,200),
          dialogs:[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,140))}
      })()`))
      R['n2-after-clear'].shot = await p.shoot('187-m7a-diagnostics-cleared')
      await esc(p)
    }
  }

  // ---------- N1 设置卡 ----------
  const openedSettings = await tapText(p, '设置')
  await sleep(2500)
  rec('n1-open', { clicked: openedSettings, state: await p.evaluate(`(()=>{
    const cards=[...document.querySelectorAll('[data-dsh-imagegen-settings-panel]')]
    const t=(document.body.innerText||'').replace(/\\s+/g,' ')
    return {cards:cards.length,
      cardText:cards.map(c=>(c.innerText||'').replace(/\\s+/g,' ').slice(0,240)),
      bodyTail:t.slice(0,500)}
  })()`)})
  R['n1-open'].shot = await p.shoot('188-m7a-settings-collapsed')

  // 展开
  const expand = await p.evaluate(`(()=>{
    const c=document.querySelector('[data-dsh-imagegen-settings-panel]')
    if(!c) return null
    const b=c.querySelector('button')
    if(!b) return null
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      expanded:b.getAttribute('aria-expanded'), label:b.getAttribute('aria-label')||''}
  })()`)
  rec('n1-header', expand)
  if (expand) {
    await press(p, expand.x, expand.y, { wait: 1600 })
    rec('n1-expanded', await p.evaluate(`(()=>{
      const c=document.querySelector('[data-dsh-imagegen-settings-panel]')
      const t=(c.innerText||'').replace(/\\s+/g,' ')
      return {text:t.slice(0,900),
        sections:[...c.querySelectorAll('section')].map(s=>({
          id:s.id||'', open:s.hasAttribute('data-open'),
          head:(s.querySelector('button')?.innerText||'').replace(/\\s+/g,' ').slice(0,50),
          expanded:s.querySelector('button')?.getAttribute('aria-expanded')})).slice(0,12),
        buttons:[...c.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,18),
          a:b.getAttribute('aria-label')||'', dis:b.disabled})).filter(o=>o.t).slice(0,24),
        hasTestConnection:/测试连接|测试 |Test connection/i.test(t),
        hasVersion:/\bv?\d+\.\d+\.\d+\b/.test(t)}
    })()`))
    R['n1-expanded'].shot = await p.shoot('189-m7a-settings-expanded')
  }

  // 回面板
  await tapText(p, '生图')
  await sleep(2000)

  // ---------- N4 画布快捷键 ----------
  await tapText(p, '无限画布')
  await sleep(3000)
  rec('n4-canvas', await p.evaluate(`({canvas:!!document.querySelector('[class*="canvas"]'),
    text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(-260)})`))
  // 点一下画布空白再按 ?
  await press(p, 900, 600, { wait: 600 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8 })
  await sleep(1500)
  rec('n4-shortcuts', await p.evaluate(`(()=>{
    const t=(document.body.innerText||'').replace(/\\s+/g,' ')
    const dlg=[...document.querySelectorAll('[role=dialog],[class*="shortcut"],[class*="Shortcut"]')]
      .filter(e=>e.getBoundingClientRect().width>200)
    return {opened:/键盘快捷键|快捷键/.test(t)&&/视图/.test(t),
      dialogs:dlg.slice(0,3).map(e=>({tag:e.tagName.toLowerCase(), role:e.getAttribute('role')||'',
        modal:e.getAttribute('aria-modal'), label:e.getAttribute('aria-label')||'',
        text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,420)}))}
  })()`))
  R['n4-shortcuts'].shot = await p.shoot('190-m7a-canvas-shortcuts')
  await esc(p)
  rec('n4-esc', await p.evaluate(`(()=>{
    const t=(document.body.innerText||'').replace(/\\s+/g,' ')
    return {stillOpen:/键盘快捷键/.test(t)&&/视图/.test(t)}
  })()`))

  // ---------- N5 键盘走查（面板 header）----------
  await tapText(p, '普通生图')
  await sleep(2200)
  const order = []
  for (let i = 0; i < 12; i++) {
    await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(180)
    const f = await p.evaluate(`(()=>{
      const a=document.activeElement
      if(!a) return null
      const r=a.getBoundingClientRect()
      const cs=getComputedStyle(a)
      return {tag:a.tagName.toLowerCase(),
        text:(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26),
        aria:a.getAttribute('aria-label')||'', ph:a.getAttribute('placeholder')||'',
        role:a.getAttribute('role')||'',
        outline:cs.outlineStyle+' '+cs.outlineWidth, boxShadow:cs.boxShadow.slice(0,30),
        visible:r.width>0&&r.height>0}
    })()`)
    order.push(f)
  }
  rec('n5-tab-order', order)
  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm7a-settings-diag.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

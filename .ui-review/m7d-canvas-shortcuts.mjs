/**
 * 第 7 批补测：画布快捷键面板（干净状态）。
 * Q1 进入无限画布后是否有已打开的项目（否则画布没挂载，按键属于无效环境）
 * Q2 快捷键面板的实际 DOM：role / aria-modal / aria-label / 是否 portal
 * Q3 触发方式：?（Shift+/）与 F1 是否都能打开；Esc 是否关闭
 * Q4 关闭后焦点回到哪里
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

const tapText = async (p, text, nth = 0) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hits=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .filter(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    const hit=hits[${nth}]
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2),n:hits.length}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y, { wait: 1600 })
  return r
}

const key = async (p, k, code, vk, modifiers = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(900)
}

const panelState = (p) => p.evaluate(`(()=>{
  const bands=[...document.querySelectorAll('*')].filter(e=>{
    const t=(e.innerText||'').trim()
    return /键盘快捷键/.test(t) && t.length<2600 && e.getBoundingClientRect().width>260
  })
  const top=bands.sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0]
  const vis=top&&top.getBoundingClientRect()
  return {open:!!top,
    box:vis?{w:Math.round(vis.width),h:Math.round(vis.height),x:Math.round(vis.x),y:Math.round(vis.y)}:null,
    tag:top?top.tagName.toLowerCase():null, role:top?top.getAttribute('role'):null,
    modal:top?top.getAttribute('aria-modal'):null, label:top?top.getAttribute('aria-label'):null,
    inBodyChild:top?top.parentElement===document.body:null,
    text:top?(top.innerText||'').replace(/\\s+/g,' ').slice(0,600):'',
    groups:top?[...top.querySelectorAll('h3,h4,strong,[class*="group"]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20)).slice(0,12):[],
    focus:{tag:document.activeElement?.tagName.toLowerCase(), inside: !!(top&&top.contains(document.activeElement))}}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  const c = await tapText(p, '无限画布')
  await sleep(3500)
  rec('q1-canvas-state', { nav: c, state: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    const canvasRoot=document.querySelector('[data-canvas-root],[class*="canvasRoot"],[class*="surface"]')
    return {canvasRootPresent:!!canvasRoot,
      title:(v.querySelector('h2,h3')?.innerText||'').slice(0,40),
      hasProjectPicker:/新建项目|选择项目|还没有项目/.test(t),
      projectName:(t.match(/项目[：:]\\s*[^ ]{1,20}/)||[''])[0],
      head:t.slice(0,200)}
  })()`)})

  // 点画布空白处（避开节点/工具条）
  await press(p, 1200, 780, { wait: 700 })
  rec('q2-before', await panelState(p))

  // ? = Shift+Slash
  await key(p, '?', 'Slash', 191, 8)
  rec('q3-question', await panelState(p))
  if (R['q3-question'].open) R['q3-question'].shot = await p.shoot('195-m7d-canvas-shortcuts')

  await key(p, 'Escape', 'Escape', 27)
  rec('q3-question-esc', await panelState(p))

  // F1
  await press(p, 1200, 780, { wait: 500 })
  await key(p, 'F1', 'F1', 112)
  rec('q3-f1', await panelState(p))
  if (R['q3-f1'].open) R['q3-f1'].shot = await p.shoot('196-m7d-canvas-shortcuts-f1')

  // 用 dock 上的「?」按钮打开（不依赖键盘），看面板本身
  if (!R['q3-f1'].open) {
    const help = await p.evaluate(`(()=>{
      const b=document.querySelector('[data-dock-item][data-label]')
      const all=[...document.querySelectorAll('[data-dock-item]')]
      const h=all.find(e=>/快捷键|帮助|shortcut/i.test(e.getAttribute('data-label')||'')||(e.getAttribute('aria-label')||'').match(/快捷键/))
      if(!h) return {none:true, labels:all.map(e=>e.getAttribute('data-label')||'')}
      const btn=h.querySelector('button')||h
      const r=btn.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2), label:h.getAttribute('data-label')||''}
    })()`)
    rec('q4-dock-help', help)
    if (help && !help.none) {
      await press(p, help.x, help.y, { wait: 1400 })
      rec('q4-after-click', await panelState(p))
      if (R['q4-after-click'].open) R['q4-after-click'].shot = await p.shoot('197-m7d-canvas-shortcuts-dock')
      await key(p, 'Escape', 'Escape', 27)
      rec('q4-esc', await panelState(p))
    }
  }

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm7d-canvas-shortcuts.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

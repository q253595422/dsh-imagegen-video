/**
 * 第 3 批（重跑）：生视频面板全量实测。
 * 覆盖：四个模式、每模式必填校验与文案、生成按钮可用性、先规划开关与预览规划
 * （含 loading / 结果 / 结果卡片内容）、模型下拉、比例/分辨率/时长、视频历史入口、
 * 空提示词提交、窄窗口。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const F = []
const rec = o => { F.push(o); console.log('·', o.step, o.ok === false ? 'FAIL' : 'ok', o.note ? String(o.note).slice(0, 260) : '') }

const s = await openStudio()
const p = s.page
const panelText = (n = 800) => p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return (v.innerText||'').replace(/\\s+/g,' ').slice(0,${n})})()`)

/** 面板状态：模式选中态、提示文案、生成按钮、有没有结果卡 */
const state = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const g=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
  const cs=g?getComputedStyle(g):null
  return {
    modes:[...v.querySelectorAll('button')].filter(b=>['文生视频','图生视频','首尾帧','参考图'].includes(b.innerText.trim()))
      .map(b=>{const c=getComputedStyle(b);return {t:b.innerText.trim(), bg:c.backgroundColor, bc:c.borderColor, aria:b.getAttribute('aria-pressed')}}),
    hints:(t.match(/该模式需要一张参考图|至少需要一张首帧|请先[^ ]{0,12}/g)||[]),
    planning:t.includes('规划中'),
    hasPlanCard:t.includes('镜头规划'),
    gen:g?{dis:g.disabled, cursor:cs.cursor}:null,
    text:t.slice(0,600)
  }
})()`)

const tapText = async (text, exact = true) => {
  const r = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
    const els=[...v.querySelectorAll('button,a,[role=tab],[role=button]')]
    const hit=els.find(e=>{const t=(e.innerText||'').trim(); return ${exact ? 't===' : 't.includes('}${JSON.stringify(text)}${exact ? '' : ')'}})
    if(!hit) return null; const rc=hit.getBoundingClientRect()
    if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2), tag:hit.tagName}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1000)
  return true
}

// ---------- 进入生视频 ----------
await tapText('生视频')
await sleep(1200)
rec({ step: 'video/enter', ok: true, state: await state(), shot: await p.shoot('m3-enter') })

// ---------- 四个模式 + 各自必填提示 ----------
for (const m of ['文生视频', '图生视频', '首尾帧', '参考图']) {
  await tapText(m)
  await sleep(1100)
  rec({ step: 'video/mode/' + m, ok: true, state: await state(), shot: await p.shoot('m3-mode-' + m) })
}

// ---------- 空提示词 + 图生视频（无图）：点生成视频 ----------
const genPos = async () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled,title:b.getAttribute('title')||''}
})()`)
const gp = await genPos()
rec({ step: 'video/gen-disabled-i2v', ok: true, note: JSON.stringify(gp) })
if (gp) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gp.x, y: gp.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gp.x, y: gp.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  rec({ step: 'video/gen-click-disabled', ok: true, state: await state(), shot: await p.shoot('m3-gen-click-disabled') })
}

// ---------- 文生视频：空提示词点生成 ----------
await tapText('文生视频')
await sleep(900)
const gp2 = await genPos()
rec({ step: 'video/gen-empty-prompt', ok: true, note: JSON.stringify(gp2) })
if (gp2 && !gp2.dis) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gp2.x, y: gp2.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gp2.x, y: gp2.y, button: 'left', clickCount: 1 })
  await sleep(2000)
  rec({ step: 'video/submit-empty-prompt', ok: true, state: await state(), shot: await p.shoot('m3-empty-prompt-submit') })
}

// ---------- 填提示词 + 先规划预览 ----------
await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const ta=v.querySelector('textarea'); if(!ta) return
  const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
  set.call(ta,'a cat stretching on a windowsill, afternoon light, slow push in')
  ta.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(900)
rec({ step: 'video/prompt-typed', ok: true, value: await p.evaluate(`document.querySelector('[data-dsh-imagegen-view] textarea').value`),
  shot: await p.shoot('m3-prompt') })

const planToggle = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/先规划/.test(x.innerText))
  return b?{t:b.innerText.trim(), pressed:b.getAttribute('aria-pressed'), role:b.getAttribute('role')}:null})()`)
rec({ step: 'video/plan-toggle', ok: !!planToggle, note: JSON.stringify(planToggle) })

// 关掉先规划再点，看交互
await tapText('先规划（开）')
await sleep(800)
rec({ step: 'video/plan-toggle-off', ok: true, note: await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/先规划/.test(x.innerText))
  return b?(b.innerText.trim()+'|aria='+b.getAttribute('aria-pressed')):'gone'})()`), shot: await p.shoot('m3-plan-off') })
await tapText('先规划（关）')
await sleep(800)

const pv = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/预览规划/.test(x.innerText)); if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled}})()`)
rec({ step: 'video/plan-preview-btn', ok: !!pv, note: JSON.stringify(pv) })
if (pv) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  rec({ step: 'video/plan-preview/T+1.5s', ok: true, state: await state(), shot: await p.shoot('m3-plan-loading') })
  await sleep(6000)
  rec({ step: 'video/plan-preview/T+7.5s', ok: true, state: await state(), shot: await p.shoot('m3-plan-result') })
}

// ---------- 模型下拉 ----------
const mb = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText)); if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    text:b.innerText.trim(), expanded:b.getAttribute('aria-expanded'), haspopup:b.getAttribute('aria-haspopup')}})()`)
rec({ step: 'video/model-trigger', ok: !!mb, note: JSON.stringify(mb) })
if (mb) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mb.x, y: mb.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mb.x, y: mb.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const opened = await p.evaluate(`(()=>{
    const trig=[...document.querySelectorAll('button')].find(x=>/agnes-video/.test(x.innerText))
    const list=document.querySelector('[role=listbox]')
    const items=[...document.querySelectorAll('[role=option]')].filter(e=>e.offsetParent!==null)
    return {expanded:trig?trig.getAttribute('aria-expanded'):null,
      listbox:!!list, optionCount:items.length,
      options:items.map(e=>({t:e.innerText.trim().slice(0,40), sel:e.getAttribute('aria-selected')})).slice(0,12),
      bodyText:(document.body.innerText||'').replace(/\\s+/g,' ').match(/agnes-video[^|,]{0,60}/g)}
  })()`)
  rec({ step: 'video/model-open', ok: true, note: JSON.stringify(opened), shot: await p.shoot('m3-model-open') })
  await p.key('Escape')
  await sleep(600)
}

// ---------- 视频历史 ----------
await tapText('生视频')
await sleep(1000)
const histCandidates = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  return {inPanel:[...v.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(t=>/历史|记录/.test(t)),
    inBody:[...document.querySelectorAll('button,a')].map(b=>b.innerText.trim()).filter(t=>/视频历史|历史/.test(t)).slice(0,10)}
})()`)
rec({ step: 'video/history-entry', ok: true, note: JSON.stringify(histCandidates) })

// ---------- 窄窗口 ----------
await p.setViewport(900, 1000)
await sleep(900)
rec({ step: 'video/narrow-900', ok: true, overflow: await p.docOverflow(), shot: await p.shoot('m3-narrow900') })
await p.setViewport(700, 1000)
await sleep(900)
rec({ step: 'video/narrow-700', ok: true, overflow: await p.docOverflow(), shot: await p.shoot('m3-narrow700') })
await p.setViewport(1600, 1000)
await sleep(600)

writeFileSync(join(SHOT_DIR, '..', 'm3-proper.json'), JSON.stringify({
  findings: F, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 12),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

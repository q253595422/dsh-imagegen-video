/**
 * 第 3 批：生视频面板。
 * 覆盖：四个模式（文生视频/图生视频/首尾帧/参考图）+ 拼接合成、模型选择器、
 * 比例/分辨率/时长、先规划开关与预览、必填图校验、空态/错误态、视频历史。
 * 不真正提交生成（避免付费调用），只走到提交前一步并强制点一次看校验提示。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const F = []
const rec = o => { F.push(o); console.log('·', o.step, o.ok === false ? 'FAIL' : 'ok', o.note ? String(o.note).slice(0, 300) : '') }

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1500)

/** 面板当前可见的整屏文本（截断），用来判断模式切换后的差异。 */
const panelText = (n = 700) => p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  return (v.innerText||'').replace(/\\s+/g,' ').slice(0,${n})})()`)

// ---------- 进入「生视频」 ----------
await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(1800)
rec({ step: 'video/enter', ok: true, text: await panelText(), shot: await p.shoot('m3-video-enter') })

/** 读可能的错误/提示条 —— 空态、校验提示。 */
const noticeOf = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  return [...v.querySelectorAll('[role=alert],[class*=notice],[class*=error],[class*=warn],[class*=hint]')]
    .map(e=>({cls:String(e.className).slice(0,26),text:(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,80),
      color:getComputedStyle(e).color}))
    .filter(e=>e.text).slice(0,8)
})()`)

// ---------- 模式切换 ----------
const MODES = ['文生视频', '图生视频', '首尾帧', '参考图', '拼接合成']
const modeResults = []
for (const m of MODES) {
  const clicked = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(m)})
    if(!b) return null
    b.click(); return {text:b.innerText.trim()}
  })()`)
  await sleep(1200)
  const state = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const btns=[...v.querySelectorAll('button')].filter(b=>['文生视频','图生视频','首尾帧','参考图','拼接合成'].includes(b.innerText.trim()))
      .map(b=>({t:b.innerText.trim(),aria:b.getAttribute('aria-pressed'),
        bg:getComputedStyle(b).backgroundColor,bc:getComputedStyle(b).borderColor,
        cls:String(b.className).slice(0,34)}))
    return {btns, fileInputs:v.querySelectorAll('input[type=file]').length,
      hasPrompt:!!v.querySelector('textarea'),
      buttons:[...new Set([...v.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean))].slice(0,40)}
  })()`)
  modeResults.push({ mode: m, clicked: !!clicked, state })
  rec({ step: 'video/mode-' + m, ok: !!clicked, note: JSON.stringify(state.btns),
    shot: await p.shoot('m3-video-mode-' + MODES.indexOf(m)) })
}

// ---------- 图生视频：不传图直接提交 → 看校验 ----------
await p.clickText('图生视频', '[data-dsh-imagegen-view]')
await sleep(1000)
const beforeSubmit = await noticeOf()
const genBtn = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/生成视频|开始生成/.test(x.innerText))
  if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    text:b.innerText.trim(), disabled:b.hasAttribute('disabled')}
})()`)
rec({ step: 'video/submit-button', ok: !!genBtn, note: JSON.stringify(genBtn) })
if (genBtn && !genBtn.disabled) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: genBtn.x, y: genBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: genBtn.x, y: genBtn.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  rec({ step: 'video/validate-no-image', ok: true, notice: await noticeOf(),
    text: await panelText(400), shot: await p.shoot('m3-video-validate') })
} else if (genBtn) {
  // 禁用态：点一下看有无解释
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: genBtn.x, y: genBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: genBtn.x, y: genBtn.y, button: 'left', clickCount: 1 })
  await sleep(900)
  rec({ step: 'video/disabled-click', ok: true, notice: await noticeOf(), note: '按钮本来禁用',
    shot: await p.shoot('m3-video-disabled') })
}

// ---------- 先规划开关 + 预览 ----------
const plan = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/先规划/.test(x.innerText))
  if(!b) return null
  return {text:b.innerText.trim(), pressed:b.getAttribute('aria-pressed'), cls:String(b.className).slice(0,30)}
})()`)
rec({ step: 'video/plan-toggle', ok: !!plan, note: JSON.stringify(plan) })

// 填一句提示词，再看「预览规划」
const ta = await p.info('[data-dsh-imagegen-view] textarea')
if (ta) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
  await sleep(150)
  for (const ch of 'a cat stretching on a windowsill, afternoon light, slow push in') {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
  await sleep(900)
  rec({ step: 'video/prompt-typed', ok: true, value: await p.evaluate(`document.querySelector('[data-dsh-imagegen-view] textarea').value`),
    shot: await p.shoot('m3-video-prompt') })
}

const previewBtn = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/预览规划/.test(x.innerText))
  if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:b.hasAttribute('disabled')}
})()`)
if (previewBtn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: previewBtn.x, y: previewBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: previewBtn.x, y: previewBtn.y, button: 'left', clickCount: 1 })
  await sleep(6000)
  rec({ step: 'video/plan-preview', ok: true, disabled: previewBtn.disabled, notice: await noticeOf(),
    text: await panelText(500), shot: await p.shoot('m3-video-plan-preview') })
}

// ---------- 视频历史 ----------
await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(800)
const histBtn = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/视频历史/.test(x.innerText))
  if(!b) return null
  const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:b.innerText.trim()}
})()`)
if (histBtn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: histBtn.x, y: histBtn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: histBtn.x, y: histBtn.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  rec({ step: 'video/history', ok: true, text: await panelText(500), shot: await p.shoot('m3-video-history') })
} else {
  rec({ step: 'video/history', ok: false, note: '找不到「视频历史」按钮' })
}

// ---------- 窄窗口 ----------
await p.setViewport(900, 1000)
await sleep(900)
rec({ step: 'video/narrow-900', ok: true, overflow: await p.docOverflow(), shot: await p.shoot('m3-video-narrow900') })
await p.setViewport(1600, 1000)
await sleep(500)

writeFileSync(join(SHOT_DIR, '..', 'm3-video.json'), JSON.stringify({
  findings: F, modes: modeResults, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 20),
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length)
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

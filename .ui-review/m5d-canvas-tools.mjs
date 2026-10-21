/**
 * 第 5 批 3/4：画布交互。
 * 1) 平移：空格+拖动 与 手型工具+拖动，两种都试，看视口是否真的移动
 * 2) 工具栏逐个点：添加图片/文本/画板/文件/配置/分镜/模板库/技能库/时间线/画布背景/快捷键
 *    每次记录：是否打开弹层、弹层标题/文案、是否新增节点
 * 3) 选中节点后的工具条（字号、颜色、技能、AI 润色、副本、删除）
 * 4) 两条节点之间的连线是否存在可点区域
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 700)) }
const step = n => console.log('== step', n)
setTimeout(() => { console.log('!! watchdog'); process.exit(2) }, 260000).unref()

const s = await openStudio()
const p = s.page

const clickAt = async (pos, { double = false, modifiers = 0 } = {}) => {
  const n = double ? 2 : 1
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: n, modifiers })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: n, modifiers })
  await sleep(700)
}

const tapAria = async (aria) => {
  const r = await p.evaluate(`(()=>{
    const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(aria)})
    if(!e) return null
    const rc=e.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return null
  await clickAt(r); return r
}

const tap = async (text, root = 'body') => {
  const r = await p.evaluate(`(()=>{
    const rt=document.querySelector(${JSON.stringify(root)})||document.body
    const hit=[...rt.querySelectorAll('button,a,[role=tab],[role=button],li')].find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return null
  await clickAt(r); return r
}

const nodes = () => p.evaluate(`(()=>{
  const c=document.querySelector('[data-canvas-workspace]')
  return [...c.querySelectorAll('[data-node-id]')].map(n=>{
    const r=n.getBoundingClientRect()
    return {id:n.getAttribute('data-node-id'), x:Math.round(r.x), y:Math.round(r.y),
      w:Math.round(r.width), h:Math.round(r.height),
      text:(n.innerText||'').replace(/\\s+/g,' ').slice(0,40)}
  })
})()`)

/** 当前弹层/面板：role=dialog、aria-modal、picker 等 */
const overlay = () => p.evaluate(`(()=>{
  const cands=[...document.querySelectorAll('[role=dialog],[aria-modal=true],[class*=modal],[class*=picker],[class*=panel],[class*=popover],[role=menu]')]
    .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120 && r.height>60})
  return cands.slice(0,4).map(e=>({cls:String(e.className).slice(0,30), role:e.getAttribute('role')||'',
    text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,180),
    inputs:[...e.querySelectorAll('input,textarea,select')].map(i=>i.placeholder||i.type),
    buttons:[...e.querySelectorAll('button')].map(b=>(b.innerText||'').trim()||b.getAttribute('aria-label')||'').filter(Boolean).slice(0,10)}))
})()`)

await tap('无限画布')
for (let i = 0; i < 60; i++) {
  const n = await nodes()
  if (n.length > 0) break
  await sleep(300)
}
await tapAria('适应全部内容'); await sleep(800)
rec('start', { nodes: await nodes() })
R.start = { ...R.start, shot: await p.shoot('m5d-start') }

const vp = await p.evaluate(`(()=>{const c=document.querySelector('[data-canvas-workspace]')
  const v=c.querySelector('[class*=viewport]'); const r=v.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})()`)

// ---------- 1a. 空格 + 拖动 ----------
step('space-drag')
const s0 = await nodes()
await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
await sleep(150)
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 8; i++) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - i * 16, y: vp.y - i * 6, button: 'left' })
  await sleep(30)
}
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x - 128, y: vp.y - 48, button: 'left', clickCount: 1 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
await sleep(600)
const s1 = await nodes()
rec('space-drag-result', { before: s0.map(n => [n.x, n.y]), after: s1.map(n => [n.x, n.y]) })

// ---------- 1b. 手型工具 + 拖动 ----------
step('hand-drag')
await tapAria('拖动画布（空格 / Ctrl + 拖动）')
await sleep(300)
const handActive = await p.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label]')]
  .find(x=>x.getAttribute('aria-label')==='拖动画布（空格 / Ctrl + 拖动）')
  return e?{active:e.getAttribute('data-active'), pressed:e.getAttribute('aria-pressed')}:null})()`)
rec('hand-tool-active', handActive)
const h0 = await nodes()
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 8; i++) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x + i * 14, y: vp.y + i * 8, button: 'left' })
  await sleep(30)
}
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vp.x + 112, y: vp.y + 64, button: 'left', clickCount: 1 })
await sleep(600)
const h1 = await nodes()
rec('hand-drag-result', { before: h0.map(n => [n.x, n.y]), after: h1.map(n => [n.x, n.y]) })
R['hand-drag-result'] = { ...R['hand-drag-result'], shot: await p.shoot('m5d-after-pan') }
await tapAria('选择 / 移动节点')

// ---------- 2. 工具栏逐项 ----------
const TOOLS = [
  ['添加图片', 'toolAddImage'],
  ['添加文本', 'toolAddText'],
  ['添加画板（手绘草图生图）', 'toolSketch'],
  ['添加文件节点', 'toolFile'],
  ['添加配置节点', 'toolConfig'],
  ['分镜', 'toolStoryboard'],
  ['模板库（选择提示词生成文本+配置节点）', 'toolTemplate'],
  ['技能库', 'toolSkills'],
  ['运行工作流（从选中节点往下）', 'toolWorkflow'],
  ['时间线编辑', 'toolTimeline'],
  ['画布背景', 'toolBackground'],
  ['快捷键', 'toolShortcut'],
]
for (const [aria, key] of TOOLS) {
  step('tool ' + aria)
  const beforeN = (await nodes()).length
  const hit = await tapAria(aria)
  await sleep(1400)
  const ov = await overlay()
  const afterN = (await nodes()).length
  rec(key, { hit: !!hit, nodeDelta: afterN - beforeN, overlay: ov,
    shot: await p.shoot('m5d-' + key) })
  // 关掉可能打开的弹层
  await p.key('Escape'); await sleep(500)
  const still = await overlay()
  if (still.length) { await p.key('Escape'); await sleep(400) }
  rec(key + '-after-esc', { overlay: await overlay() })
}

writeFileSync(join(SHOT_DIR, '..', 'm5d-canvas.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length, 'consoleErrors', p.consoleErrors.length)
s.close()
setTimeout(() => process.exit(0), 400)

/**
 * 定点探测两处第 1 批的失败：
 * A. [data-dsh-imagegen-chat-resizer] 为什么量到 0×0、键盘为什么没反应；
 * B. 侧栏历史记录里的「搜索」到底是不是 <input>。
 * 只读，不修改页面状态（除了把拖柄 focus 一下）。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())

await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await sleep(3500)

// 「继续」弹窗若还在，先点掉，避免它挡着布局
const clicked = await p.evaluate(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')
  if(!btn) return false
  const r=btn.getBoundingClientRect(); const opt={bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}
  btn.dispatchEvent(new PointerEvent('pointerdown',opt)); btn.dispatchEvent(new MouseEvent('mousedown',opt))
  btn.dispatchEvent(new PointerEvent('pointerup',opt)); btn.dispatchEvent(new MouseEvent('mouseup',opt)); btn.click()
  return true
})()`)
await sleep(1200)
console.log('disclaimer dismissed:', clicked)

// ---------- A. 拖柄 ----------
const resizerDump = await p.evaluate(`(()=>{
  const all=[...document.querySelectorAll('[data-dsh-imagegen-chat-resizer]')]
  const htmlAttr={
    active:document.documentElement.getAttribute('data-dsh-imagegen-active'),
    taskboard:document.documentElement.getAttribute('data-dsh-taskboard-active'),
    ssh:document.documentElement.getAttribute('data-dsh-ssh-active'),
  }
  const rows=all.map((e,i)=>{
    const r=e.getBoundingClientRect(); const cs=getComputedStyle(e)
    const col=e.parentElement
    const ccs=col?getComputedStyle(col):null
    return {i, connected:e.isConnected, parent:e.parentElement?e.parentElement.tagName+'.'+String(e.parentElement.className||'').slice(0,50):null,
      cls:e.className, w:Math.round(r.width), h:Math.round(r.height), x:Math.round(r.x), y:Math.round(r.y),
      display:cs.display, visibility:cs.visibility, minWidth:cs.minWidth,
      gridColumn:cs.gridColumn, gridRow:cs.gridRow,
      parentGridCols: ccs?ccs.gridTemplateColumns:null,
      parentDisplay: ccs?ccs.display:null,
      chatWidthVar: col?col.style.getPropertyValue('--dsh-imagegen-chat-width'):null,
      label:e.getAttribute('aria-label'),
    }
  })
  return {count:all.length, htmlAttr, rows}
})()`)
console.log('RESIZER', JSON.stringify(resizerDump, null, 1))

// 拖柄上直接派发 keydown，看 CSS 变量有没有变（不依赖 focus 的真实性）
const keyProbe = await p.evaluate(`(()=>{
  const e=document.querySelector('[data-dsh-imagegen-chat-resizer]')
  if(!e) return 'no-resizer'
  const col=e.parentElement
  const before=col?col.style.getPropertyValue('--dsh-imagegen-chat-width'):null
  const rect=col?col.getBoundingClientRect():null
  e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))
  const after=col?col.style.getPropertyValue('--dsh-imagegen-chat-width'):null
  return {before, after, changed:before!==after,
    colRect: rect?{x:Math.round(rect.x),w:Math.round(rect.width),right:Math.round(rect.right)}:null}
})()`)
console.log('KEYDOWN ON RESIZER', JSON.stringify(keyProbe))

// 用真实键盘事件（Input 域）打到页面上，确认 focus 落点
const focusProbe = await p.evaluate(`(()=>{
  const e=document.querySelector('[data-dsh-imagegen-chat-resizer]')
  e.focus()
  return {activeIsResizer: document.activeElement===e, activeTag: document.activeElement&&document.activeElement.tagName,
    tabindex:e.getAttribute('tabindex')}
})()`)
console.log('FOCUS', JSON.stringify(focusProbe))
const beforeVar = await p.evaluate(`(()=>{const e=document.querySelector('[data-dsh-imagegen-chat-resizer]');
  return e.parentElement.style.getPropertyValue('--dsh-imagegen-chat-width')})()`)
await p.key('ArrowLeft')
await sleep(300)
const afterVar = await p.evaluate(`(()=>{const e=document.querySelector('[data-dsh-imagegen-chat-resizer]');
  return e.parentElement.style.getPropertyValue('--dsh-imagegen-chat-width')})()`)
console.log('REAL KEY', JSON.stringify({ beforeVar, afterVar, changed: beforeVar !== afterVar }))

// ---------- B. 侧栏搜索框 ----------
const searchDump = await p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  if(!h) return 'no-host'
  const cands=[...h.querySelectorAll('input,textarea,[contenteditable="true"],[role="searchbox"],[role="textbox"],[role="combobox"]')]
  return {
    hostRect:(()=>{const r=h.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})(),
    candCount:cands.length,
    cands:cands.map(e=>({tag:e.tagName, type:e.getAttribute('type'), role:e.getAttribute('role'),
      placeholder:e.getAttribute('placeholder'), cls:String(e.className||'').slice(0,60),
      editable:e.isContentEditable,
      rect:(()=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()})),
    // 宿主页面里所有 input 的概况，看看搜索框是不是在 host 外面
    allInputs:[...document.querySelectorAll('input')].slice(0,20).map(e=>({type:e.getAttribute('type'),
      ph:e.getAttribute('placeholder'),cls:String(e.className||'').slice(0,40),
      inHost: h.contains(e),
      rect:(()=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()})),
  }
})()`)
console.log('SEARCH', JSON.stringify(searchDump, null, 1))
console.log('shot:', await p.shoot('m1b-probe'))
console.log('console:', JSON.stringify(p.consoleErrors.slice(-6)))
p.close(); b.close()

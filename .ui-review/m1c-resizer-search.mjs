/**
 * 修正第 1 批的两个判定：
 * A. 拖柄要在「对话」栏开启后才有宽度——重测尺寸、键盘、鼠标拖动、最小宽度；
 * B. 搜索框：挂原生 input 监听 + 读 React valueTracker，判断事件到底有没有到 React。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const R = {}
const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
for (let i = 0; i < 40; i++) { if (await p.evaluate(`!!document.querySelector('[data-history-clear]')`)) break; await sleep(400) }

const chatBtn = () => p.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-dsh-imagegen-view] button')].find(x=>x.innerText.trim()==='对话');
  return b?{pressed:b.getAttribute('aria-pressed'),active:b.hasAttribute('data-active')}:null})()`)
const resizerInfo = () => p.evaluate(`(()=>{
  const e=document.querySelector('[data-dsh-imagegen-chat-resizer]')
  if(!e) return null
  const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); const col=e.parentElement
  const colRect=col.getBoundingClientRect()
  return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),
    display:cs.display, cols:getComputedStyle(col).gridTemplateColumns,
    colWidth:Math.round(colRect.width),
    chatVar:col.style.getPropertyValue('--dsh-imagegen-chat-width')||null,
    canFocus:(()=>{e.focus();return document.activeElement===e})()}
})()`)

// ---------- A. 先开对话栏 ----------
R.chatBefore = await chatBtn()
if (!R.chatBefore?.pressed || R.chatBefore.pressed !== 'true') {
  await p.clickText('对话', '[data-dsh-imagegen-view]')
  await sleep(1500)
}
R.chatAfter = await chatBtn()
R.resizerOpen = await resizerInfo()
R.shotOpen = await p.shoot('m1c-chat-open')

// 键盘：← 应该让对话栏变宽 → 面板变窄
const widths = []
for (let i = 0; i < 6; i++) {
  await p.evaluate(`document.querySelector('[data-dsh-imagegen-chat-resizer]').focus()`)
  await p.key('ArrowLeft'); await sleep(150)
}
widths.push((await resizerInfo()).chatVar)
R.shotKeyLeft = await p.shoot('m1c-resizer-key-left')
for (let i = 0; i < 20; i++) {
  await p.evaluate(`document.querySelector('[data-dsh-imagegen-chat-resizer]').focus()`)
  await p.key('ArrowRight'); await sleep(120)
}
const afterRight = await resizerInfo()
R.keyboard = { leftResult: widths[0], rightResult: afterRight.chatVar, resizer: afterRight }
R.shotKeyRight = await p.shoot('m1c-resizer-key-right')

// 鼠标拖动：从拖柄中点往左拖 200px
const r = await resizerInfo()
if (r && r.w > 0) {
  const sx = r.x + r.w / 2, sy = 500
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx - i * 20, y: sy, button: 'left', buttons: 1 })
    await sleep(40)
  }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx - 200, y: sy, button: 'left', clickCount: 1 })
  await sleep(600)
  R.drag = { after: (await resizerInfo()).chatVar, cursorLeft: await p.evaluate(`document.documentElement.style.cursor||null`) }
  R.shotDrag = await p.shoot('m1c-resizer-dragged')
}

// ---------- B. 搜索框事件链 ----------
R.searchProbe = await p.evaluate(`(()=>{
  const i=document.querySelector('[data-dsh-imagegen-history-host] input')
  if(!i) return 'no-input'
  window.__probe={native:0, reactTracker: !!i._valueTracker, desc:null}
  i.addEventListener('input',()=>{window.__probe.native++})
  const d=Object.getOwnPropertyDescriptor(i,'value')
  window.__probe.ownerSetter = !!d
  const proto=Object.getPrototypeOf(i)
  window.__probe.protoSame=proto===HTMLInputElement.prototype
  window.__probe.ctor=i.constructor.name
  return {reactTracker:!!i._valueTracker, ownSetter:!!d, protoSame:proto===HTMLInputElement.prototype,
    inHost:!!i.closest('[data-dsh-imagegen-history-host]'), tag:i.tagName}
})()`)

const box = await p.info('[data-dsh-imagegen-history-host] input')
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.w / 2, y: box.y + box.h / 2, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.w / 2, y: box.y + box.h / 2, button: 'left', clickCount: 1 })
await sleep(200)
for (const ch of 'grad') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  await sleep(70)
}
await sleep(800)
R.afterTyping = await p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const list=h.querySelector('[class*=historyList]')
  return {value:h.querySelector('input').value, nativeInputEvents: window.__probe.native,
    rows:list?list.children.length:0}
})()`)
await sleep(300)
// 再读一次：受控组件若 state 没更新，React 会在任意一次重渲染时把值刷回 ''
R.settle = await p.evaluate(`(()=>{const h=document.querySelector('[data-dsh-imagegen-history-host]');
  return {value:h.querySelector('input').value}})()`)
R.shotSearch = await p.shoot('m1c-search-probe')

console.log(JSON.stringify(R, null, 1))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

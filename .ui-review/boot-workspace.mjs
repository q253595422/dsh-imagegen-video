/** 探：点开「选择工作区」后菜单里有哪些项，以及能否直接进入会话。 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await sleep(7000)

const btn = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/选择工作区/.test(x.innerText))
  if(!b) return null; const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
console.log('BTN', JSON.stringify(btn))
if (btn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await sleep(2000)
}
console.log('MENU-TEXT', JSON.stringify(await p.evaluate(`(()=>{
  const m=[...document.querySelectorAll('[role=menu]')].find(e=>e.offsetParent!==null)
  return m ? m.innerText.replace(/\\s+/g,' ').slice(0,400) : 'none'
})()`)))
console.log('MENU-ITEMS', JSON.stringify(await p.evaluate(`(()=>{
  const items=[...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(e=>e.offsetParent!==null)
  return items.map(e=>({t:e.innerText.trim().slice(0,60), tag:e.tagName}))
})()`)))
console.log('shot', await p.shoot('m0-ws-menu'))
p.close(); b.close(); setTimeout(() => process.exit(0), 300)

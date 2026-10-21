/** 试点左侧栏的「生图」tab：面板是否不依赖会话就能挂载。 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await sleep(8000)

console.log('BODY', JSON.stringify(await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(0,300)`)))
console.log('hasTab', await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-tab="image"]')`))
console.log('hasView', await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-view]')`))

// 按可见文字点「生图」
const r = await p.evaluate(`(()=>{
  const els=[...document.querySelectorAll('button,a,[role=tab],[role=button],div[tabindex]')]
  const hit=els.find(e=>e.innerText && e.innerText.trim()==='生图')
  if(!hit) return {found:false}
  const rc=hit.getBoundingClientRect()
  return {found:true, x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2), tag:hit.tagName}
})()`)
console.log('TAB', JSON.stringify(r))
if (r.found) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(3000)
}
console.log('after hasTab', await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-tab="image"]')`))
console.log('after hasView', await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-view]')`))
console.log('after hasActive', await p.evaluate(`document.documentElement.hasAttribute('data-dsh-imagegen-active')`))
console.log('BODY2', JSON.stringify(await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(0,400)`)))
console.log('shot', await p.shoot('m0-tab-image'))
console.log('consoleWarn', JSON.stringify(p.consoleErrors.slice(0, 8)))
p.close(); b.close(); setTimeout(() => process.exit(0), 300)

/** 打开模板库，读 harness 记录的 failedRequests（含 URL + errorText），并复现一次重试。 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(2500)
p.failedRequests.length = 0

const btn = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim().includes('模板库'))
  if(!b) return null
  const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:b.innerText.trim()}
})()`)
console.log('TRIGGER', JSON.stringify(btn))
if (btn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
}
await sleep(3000)
console.log('FAILED', JSON.stringify(p.failedRequests, null, 1))
console.log('DLG', JSON.stringify(await p.evaluate(`(()=>{
  const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>/模板/.test(d.innerText))
  if(!dlg) return 'no-dialog'
  return {text:dlg.innerText.replace(/\\s+/g,' ').slice(0,300),
    tabs:[...dlg.querySelectorAll('[role=tab],button')].map(e=>e.innerText.trim()).filter(Boolean).slice(0,20)}
})()`), null, 1))

// 点「重试」，看是否仍失败
const retried = await p.evaluate(`(()=>{
  const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>/模板/.test(d.innerText))
  const b=dlg&&[...dlg.querySelectorAll('button')].find(x=>x.innerText.trim()==='重试')
  if(!b) return false
  b.click(); return true
})()`)
await sleep(2500)
console.log('RETRY', retried, JSON.stringify(await p.evaluate(`(()=>{
  const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>/模板/.test(d.innerText))
  return dlg?dlg.innerText.replace(/\\s+/g,' ').slice(0,300):null
})()`)))
console.log('FAILED2', JSON.stringify(p.failedRequests.slice(0,6)))
console.log('shot:', await p.shoot('m2c-template-net'))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

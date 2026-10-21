/** 窄探测：只回答两个问题，输出尽量短。 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await sleep(3500)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1000)

console.log('GRID', JSON.stringify(await p.evaluate(`(()=>{
  const r=document.querySelector('[data-dsh-imagegen-chat-resizer]')
  if(!r) return 'no-resizer'
  const chain=[]; let n=r
  for(let i=0;i<5&&n;i++,n=n.parentElement){
    const cs=getComputedStyle(n); const b=n.getBoundingClientRect()
    chain.push({tag:n.tagName, cls:String(n.className||'').slice(0,40),
      slot:n.getAttribute&&n.getAttribute('data-slot'),
      phase:n.getAttribute&&n.getAttribute('data-phase'),
      display:cs.display, cols:cs.gridTemplateColumns, rows:cs.gridTemplateRows,
      gridCol:cs.gridColumn, w:Math.round(b.width), h:Math.round(b.height), x:Math.round(b.x)})
  }
  const rb=r.getBoundingClientRect()
  return {resizer:{w:Math.round(rb.width),h:Math.round(rb.height),display:getComputedStyle(r).display,
    gridCol:getComputedStyle(r).gridColumn}, chain,
    siblings:[...r.parentElement.children].map(c=>c.tagName+'|'+String(c.className||'').slice(0,30)+'|'+
      (c.getAttribute('data-slot')||c.getAttribute('data-dsh-imagegen-view')!==null?'view':''))}
})()`), null, 1))

console.log('SETTER', JSON.stringify(await p.evaluate(`(()=>{
  const i=document.querySelector('[data-dsh-imagegen-history-host] input')
  if(!i) return 'no-input'
  const d1=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')
  const d2=Object.getOwnPropertyDescriptor(i,'value')
  return {tag:i.tagName, ctor:i.constructor&&i.constructor.name,
    isHTMLInput: i instanceof HTMLInputElement,
    protoDescriptor: d1?Object.keys(d1):null,
    ownDescriptor: d2?Object.keys(d2):null,
    sameRealm: i.ownerDocument.defaultView===window,
    value:i.value}
})()`)))

// 直接写一次，看列表有没有跟着变
console.log('SEARCH-WRITE', JSON.stringify(await p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const i=h.querySelector('input')
  const before=h.querySelectorAll('button').length
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
  set.call(i,'gradient')
  i.dispatchEvent(new Event('input',{bubbles:true}))
  return {before, wrote:i.value}
})()`)))
await sleep(800)
console.log('AFTER-WRITE', JSON.stringify(await p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  return {buttons:h.querySelectorAll('button').length, text:h.innerText.replace(/\\s+/g,' ').slice(0,180)}
})()`)))
console.log('shot:', await p.shoot('m1b-search-written'))
p.close(); b.close()

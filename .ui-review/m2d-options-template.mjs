/**
 * 1) 模板库长时间停「正在加载模板库…」是否为真（等 15s + 页面内直发同一请求对照）。
 * 2) 尺寸/清晰度/数量/细节 这四组选项的选中态是怎么实现的（aria / class / 边框），
 *    因为视觉上有选中态但 data-active / aria-pressed 全为 false。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(2000)

// ---------- A. 选项组的选中态实现 ----------
console.log('OPTIONS', JSON.stringify(await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const groups={}
  for (const g of ['尺寸','清晰度','生成数量','细节']) {
    const lb=[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.innerText||'').trim()===g)
    if(!lb){groups[g]='no-label';continue}
    let card=lb
    for(let i=0;i<6&&card.parentElement;i++){card=card.parentElement;if(card.querySelector('button'))break}
    groups[g]=[...card.querySelectorAll('button')].map(btn=>{
      const cs=getComputedStyle(btn)
      return {t:btn.innerText.trim(), ariaPressed:btn.getAttribute('aria-pressed'),
        ariaChecked:btn.getAttribute('aria-checked'), role:btn.getAttribute('role'),
        dataActive:btn.hasAttribute('data-active'), cls:String(btn.className).slice(0,30),
        border:cs.borderColor, bg:cs.backgroundColor, color:cs.color,
        parentRole: btn.parentElement.getAttribute('role')}
    })
  }
  return groups
})()`), null, 1))

// ---------- B. 模板库加载态 ----------
const btn = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim().includes('模板库'));
  if(!b)return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
if (btn) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
}
for (const t of [1000, 4000, 9000, 15000]) {
  await sleep(t === 1000 ? 1000 : t - (t === 4000 ? 1000 : t === 9000 ? 4000 : 9000))
  const s = await p.evaluate(`(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/模板/.test(x.innerText))
    if(!d) return 'gone'
    return {loading:d.innerText.includes('正在加载'), cards:d.querySelectorAll('img').length,
      err:d.innerText.includes('加载失败'), text:d.innerText.replace(/\\s+/g,' ').slice(0,120)}})()`)
  console.log('T+' + t + 'ms', JSON.stringify(s))
}
console.log('FAILED', JSON.stringify(p.failedRequests.slice(0,6)))

// 页面内直接打同一接口，看同源请求是否可用
console.log('INPAGE', JSON.stringify(await p.evaluate(`(async()=>{
  try{
    const r=await fetch('/api/dsh-imagegen/templates/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'vibeui'})})
    const j=await r.json()
    return {status:r.status, ok:j.ok, cases:j.cases&&j.cases.length, err:j.message}
  }catch(e){ return {error:String(e)} }
})()`)))
console.log('shot:', await p.shoot('m2d-template-stuck'))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

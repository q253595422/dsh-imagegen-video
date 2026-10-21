/**
 * 诊断内测声明的「继续」按钮为什么关不掉。
 * 打印按钮所在的容器、是否被遮挡、点击前后的 DOM 差异。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 30000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 15000)
await sleep(3500)

const dump = await p.evaluate(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')
  if(!btn) return {found:false}
  const r=btn.getBoundingClientRect()
  const cx=Math.round(r.x+r.width/2), cy=Math.round(r.y+r.height/2)
  const top=document.elementFromPoint(cx,cy)
  const chain=[]; let n=btn
  for(let i=0;i<6&&n;i++){ chain.push(n.tagName+(n.getAttribute&&n.getAttribute('role')?('[role='+n.getAttribute('role')+']'):'')+(n.className&&typeof n.className==='string'?('.'+n.className.split(/\\s+/).slice(0,3).join('.')):'')); n=n.parentElement }
  return {
    found:true,
    rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
    topElementAtCenter: top ? top.tagName+'|'+(top.innerText||'').trim().slice(0,20) : null,
    topIsButtonOrChild: !!(top && (top===btn || btn.contains(top))),
    outerStart: btn.outerHTML.slice(0,300),
    chain,
    bodyChildren: [...document.body.children].map(e=>e.tagName+'.'+String(e.className||'').slice(0,40)),
  }
})()`)
console.log('BEFORE', JSON.stringify(dump, null, 1))

// 真实鼠标点击（走 Input 域，绕过 elementFromPoint 的遮挡问题）
const r = dump.rect
await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.w / 2, y: r.y + r.h / 2 })
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 })
await sleep(1200)

const after = await p.evaluate(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')
  const dialog=[...document.querySelectorAll('[role="dialog"]')][0]
  return { stillThere: !!btn, dialogStill: !!dialog,
    dialogText: dialog ? dialog.innerText.slice(0,80) : null,
    bodyText: document.body.innerText.slice(0,120) }
})()`)
console.log('AFTER', JSON.stringify(after, null, 1))
console.log('shot:', await p.shoot('diag-disclaimer-after-click'))
console.log('console:', JSON.stringify(p.consoleErrors.slice(-6), null, 1))
p.close(); b.close()

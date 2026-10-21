/**
 * 检查侧边栏注入的实际 DOM：标签在哪、data 属性是什么。
 * 这一步只读，不改页面。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
for (let i = 0; i < 20; i++) {
  await sleep(1000)
  if (await p.exists('[data-dsh-imagegen-session-tabs]')) break
}
console.log('session tabs count:', await p.count('[data-dsh-imagegen-session-tabs]'))
console.log('image tab count:', await p.count('[data-dsh-imagegen-tab]'))
console.log('sidebar root:', await p.count('[data-dsh-imagegen-sidebar-root]'))
console.log('dump of tabs outerHTML:', (await p.evaluate(
  `(()=>{const e=document.querySelector('[data-dsh-imagegen-session-tabs]');return e?e.outerHTML.slice(0,900):null})()`,
)))
console.log('any svg 生图 text node:', await p.evaluate(
  `[...document.querySelectorAll('button')].map(b=>(b.getAttribute('aria-label')||'')+'|'+b.innerText.trim().slice(0,20)).slice(0,25).join(' ;; ')`,
))
p.close(); b.close()

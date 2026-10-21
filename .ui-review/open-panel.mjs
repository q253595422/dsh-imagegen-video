/**
 * 打开生图面板并导出结构：顶部 GooeyNav、子模式页签、配置区。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 30000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 15000)
await sleep(3500)

console.log('html attrs:', await p.evaluate('document.documentElement.getAttributeNames().join(",")'))
console.log('view hosts:', await p.count('[data-dsh-imagegen-view]'))
console.log('--- panel innerText ---')
console.log((await p.evaluate('document.querySelector("[data-dsh-imagegen-view]").innerText')).slice(0, 2500))
console.log('--- tabs ---')
console.log(await p.evaluate(`[...document.querySelectorAll('[data-dsh-imagegen-view] [role="tab"]')].map(e=>e.innerText.trim()+'#'+e.getAttribute('aria-selected')).join(' | ')`))
console.log('shot:', await p.shoot('panel-text-mode'))
console.log('console:', JSON.stringify(p.consoleErrors.slice(-10), null, 1))
console.log('page errors:', JSON.stringify(p.pageErrors.slice(-5), null, 1))
p.close(); b.close()

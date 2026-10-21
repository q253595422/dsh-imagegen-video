/**
 * 探测：登录、等面板挂载、列出可点的模块入口。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await sleep(7000)

console.log('url:', (await p.url()).replace(/token=[^&]+/, 'token=<redacted>'))
console.log('title:', await p.evaluate('document.title'))
console.log('view hosts:', await p.count('[data-dsh-imagegen-view]'))
console.log('sidebar tabs:', await p.count('[data-dsh-imagegen-session-tabs]'))
console.log('sidebar history host:', await p.count('[data-dsh-imagegen-history-host]'))
console.log('body text 800:', JSON.stringify((await p.evaluate('document.body.innerText'))?.slice(0, 800)))
console.log('console errors:', JSON.stringify(p.consoleErrors.slice(0, 10), null, 1))
console.log('page errors:', JSON.stringify(p.pageErrors.slice(0, 5), null, 1))
console.log('shot:', await p.shoot('probe-initial'))
p.close(); b.close()

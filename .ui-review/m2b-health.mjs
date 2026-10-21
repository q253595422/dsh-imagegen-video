/** 核实两件事：1) 侧栏缩略图是否真的加载失败；2) 模板库 fetch 失败是不是评审环境没网。 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
for (let i = 0; i < 40; i++) { if (await p.evaluate(`!!document.querySelector('[data-history-clear]')`)) break; await sleep(400) }
await sleep(2500)

// 1) 缩略图健康度
console.log('IMGS', JSON.stringify(await p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const imgs=[...h.querySelectorAll('img')]
  return {total:imgs.length,
    broken:imgs.filter(i=>i.complete&&i.naturalWidth===0).length,
    pending:imgs.filter(i=>!i.complete).length,
    sample:imgs.slice(0,6).map(i=>({nw:i.naturalWidth, complete:i.complete,
      src:i.src.slice(0,80), alt:(i.alt||'').slice(0,20)}))}
})()`), null, 1))

// 2) 从页面里发一个 fetch，看宿主到外网通不通
console.log('NET', JSON.stringify(await p.evaluate(`(async()=>{
  const out={}
  try{
    const r=await fetch('https://api.github.com/zen',{cache:'no-store'})
    out.github={status:r.status}
  }catch(e){ out.github={error:String(e).slice(0,90)} }
  try{
    const r=await fetch('/api/dsh-imagegen/config',{cache:'no-store'})
    out.localConfig={status:r.status}
  }catch(e){ out.localConfig={error:String(e).slice(0,90)} }
  return out
})()`)))

// 3) 连接状态区文案与顶栏徽标是否一致
console.log('CONN', JSON.stringify(await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const badge=[...v.querySelectorAll('*')].filter(e=>e.children.length===0&&/已连接|连接中|未连接|重新连接|连接失败/.test(e.innerText||''))
    .map(e=>e.innerText.trim())
  return {badges:[...new Set(badge)]}
})()`)))
console.log('shot:', await p.shoot('m2b-health'))
console.log('failed', JSON.stringify(p.failedRequests.slice(0,8)))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

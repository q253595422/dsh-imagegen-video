/**
 * 第 3 批补测：确认「预览规划」是不是点了完全无反应。
 * 对照条件：切到「文生视频」（不需要参考图）→ 填提示词 → 点「预览规划」，
 * 并在点击前后各采一次 DOM 快照（弹层 / 文本 / 按钮 disabled / aria-busy / 网络请求）。
 * 另测：禁用态「生成视频」的 title / aria-disabled / cursor，模型下拉的真实选项。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1500)

const rpc = []
// 粗粒度网络：记录 POST 到 /api/dsh-imagegen/ 的请求（harness 无事件订阅，用 PerformanceObserver 之外的办法：包一层 fetch）
await p.evaluate(`(()=>{
  window.__calls=[];
  const of=window.fetch;
  window.fetch=function(...a){
    const url=typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';
    window.__calls.push({url:String(url).slice(0,90), t:Date.now()});
    return of.apply(this,a);
  };
})()`)

await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(1500)

/** 快照：弹层 / 面板文本 / 规划相关节点 / 按钮态 */
const snap = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const dlg=[...document.querySelectorAll('[role=dialog]')].map(d=>({t:(d.innerText||'').replace(/\\s+/g,' ').slice(0,200)}))
  const btns=[...v.querySelectorAll('button')].map(b=>{
    const cs=getComputedStyle(b)
    return {t:b.innerText.trim().slice(0,14), dis:b.disabled, ariaDis:b.getAttribute('aria-disabled'),
      ariaBusy:b.getAttribute('aria-busy'), title:b.getAttribute('title')||'', cursor:cs.cursor, op:cs.opacity}
  }).filter(x=>x.t)
  return {dlg, text:(v.innerText||'').replace(/\\s+/g,' ').slice(0,900),
    btns:btns.filter(x=>/生成视频|预览规划|先规划|诊断/.test(x.t)),
    calls:(window.__calls||[]).length}
})()`)

// ---- 切到文生视频 ----
await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()==='文生视频'); if(b) b.click()})()`)
await sleep(1200)
console.log('T2V BEFORE', JSON.stringify(await snap(), null, 1))

// ---- 填提示词 ----
const ta = await p.info('[data-dsh-imagegen-view] textarea')
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
await sleep(150)
for (const ch of 'a cat stretching on a windowsill, slow push in') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
}
await sleep(1000)
console.log('T2V TYPED', JSON.stringify(await snap(), null, 1))
const shotTyped = await p.shoot('m3b-t2v-typed')

// ---- 点「预览规划」 ----
const pv = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/预览规划/.test(x.innerText)); if(!b) return null
  const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled,
    title:b.getAttribute('title'), rect:{w:Math.round(r.width),h:Math.round(r.height)}}})()`)
console.log('PREVIEW BTN', JSON.stringify(pv))
if (pv) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pv.x, y: pv.y })
  await sleep(400)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  for (const ms of [1200, 4000, 12000]) {
    await sleep(ms === 1200 ? 1200 : ms === 4000 ? 2800 : 8000)
    console.log('T+' + ms + 'ms', JSON.stringify(await snap(), null, 1))
  }
  console.log('CALLS', JSON.stringify(await p.evaluate(`window.__calls||[]`)))
  console.log('shot:', await p.shoot('m3b-plan-after-t2v'))
}

// ---- 生成视频按钮：now 应该可用了？ ----
const gen = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>/生成视频/.test(x.innerText)); if(!b) return null
  const cs=getComputedStyle(b)
  return {dis:b.disabled, ariaDis:b.getAttribute('aria-disabled'), title:b.getAttribute('title')||'',
    cursor:cs.cursor, bg:cs.backgroundColor, color:cs.color, op:cs.opacity}})()`)
console.log('GEN BTN (t2v + prompt)', JSON.stringify(gen))

// ---- 视频模型下拉的真实选项 ----
const sel = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
  const s=v.querySelector('select'); if(!s) return null
  return {value:s.value, options:[...s.options].map(o=>({v:o.value,t:o.text}))}})()`)
console.log('VIDEO MODEL SELECT', JSON.stringify(sel, null, 1))
console.log('shot:', shotTyped)

writeFileSync(join(SHOT_DIR, '..', 'm3b-video-plan.json'), JSON.stringify({
  consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 10),
}, null, 2))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

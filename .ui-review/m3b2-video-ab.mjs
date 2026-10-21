/**
 * 第 3 批补测 2 —— 「预览规划」模式相关失效的 A/B 复现。
 * A: 文生视频 + prompt → 点预览规划 → 应出现「规划中…」→「镜头规划」
 * B: 图生视频 + prompt（未选图）→ 点预览规划 → 观察是否同样出现
 * C: 图生视频 + 选中一张图 → 再点预览规划
 * 附带：视频模型控件的真实标签（是否原生 select）、参考图上传走真实 File 注入。
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

await p.evaluate(`(()=>{
  window.__calls=[]; const of=window.fetch
  window.fetch=function(...a){ const u=typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||''
    if(String(u).includes('/video/')) window.__calls.push(String(u)); return of.apply(this,a) }
})()`)

const P = { findings: [] }
const log = (k, v) => { P.findings.push({ k, v }); console.log(k, typeof v === 'string' ? v : JSON.stringify(v)) }

await p.clickText('生视频', '[data-dsh-imagegen-view]')
await sleep(1500)

/** 面板状态：是否处于「规划中…」、是否已出镜头规划、错误提示 */
const st = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return { planning:t.includes('规划中'), hasPlan:t.includes('镜头规划'),
    hint:(v.innerText||'').match(/该模式需要[^\\n]*/)?.[0]||'',
    calls:(window.__calls||[]).slice(-3),
    gen:(()=>{const b=[...v.querySelectorAll('button')].find(x=>/生成视频/.test(x.innerText))
      return b?{dis:b.disabled}:null})()}
})()`)

const setMode = async m => {
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(m)})
    if(b) b.click()})()`)
  await sleep(1000)
}

const fillPrompt = async text => {
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const ta=v.querySelector('textarea'); if(!ta) return
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
    set.call(ta,${JSON.stringify(text)}); ta.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(800)
  return p.evaluate(`document.querySelector('[data-dsh-imagegen-view] textarea').value.slice(0,60)`)
}

const clickPreview = async () => {
  const pv = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(x=>/预览规划/.test(x.innerText)); if(!b) return null
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled,text:b.innerText.trim()}})()`)
  if (!pv) return { noButton: true }
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pv.x, y: pv.y, button: 'left', clickCount: 1 })
  return pv
}

const PROMPT = 'a cat stretching on a windowsill, slow push in'

// ============ A. 文生视频 ============
await setMode('文生视频')
log('A/prompt-value', await fillPrompt(PROMPT))
log('A/before', await st())
log('A/preview-btn', await clickPreview())
await sleep(1500); log('A/T+1500', await st())
await sleep(4000); log('A/T+5500', await st())
log('A/shot', await p.shoot('m3b2-A-t2v'))

// ============ B. 图生视频（未选图）============
await setMode('图生视频')
log('B/prompt-value', await fillPrompt(PROMPT))
log('B/before', await st())
log('B/preview-btn', await clickPreview())
await sleep(1500); log('B/T+1500', await st())
await sleep(4000); log('B/T+5500', await st())
log('B/shot', await p.shoot('m3b2-B-i2v-nofile'))

// ============ C. 图生视频 + 注入一张图 ============
const injected = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const inp=v.querySelector('input[type=file]')
  if(!inp) return {noInput:true, kinds:[...v.querySelectorAll('input')].map(i=>i.type)}
  // 造一个 1x1 PNG 的 File
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin=atob(b64); const u8=new Uint8Array(bin.length)
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i)
  const f=new File([u8],'probe.png',{type:'image/png'})
  const dt=new DataTransfer(); dt.items.add(f)
  inp.files=dt.files
  inp.dispatchEvent(new Event('change',{bubbles:true}))
  return {ok:true, name:inp.files[0]&&inp.files[0].name, accept:inp.accept}
})()`)
log('C/inject-file', injected)
await sleep(2500)
log('C/after-inject', await st())
log('C/shot', await p.shoot('m3b2-C-i2v-withfile'))
log('C/preview-btn', await clickPreview())
await sleep(1500); log('C/T+1500', await st())
await sleep(4000); log('C/T+5500', await st())
log('C/shot2', await p.shoot('m3b2-C-plan'))

// ============ 模型控件真实标签 ============
log('model-control', await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const out=[]
  for(const e of v.querySelectorAll('*')){
    const t=(e.innerText||'').trim()
    if(t!=='agnes-video-2.5-flash') continue
    if(e.children.length>0) continue
    let node=e, chain=[]
    for(let i=0;i<5&&node;i++){ chain.push(node.tagName.toLowerCase()+(node.getAttribute('role')?('['+node.getAttribute('role')+']'):'')); node=node.parentElement }
    out.push(chain)
    break
  }
  return {chain:out[0]||null, hasSelect:!!v.querySelector('select'),
    selects:[...v.querySelectorAll('select')].length}
})()`))

writeFileSync(join(SHOT_DIR, '..', 'm3b2-video.json'), JSON.stringify(P, null, 2))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

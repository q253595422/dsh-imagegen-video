/**
 * 图生视频：空态 → 选图 → 移除，三态的提示文案与生成按钮可用性。
 * 之前一轮因为宿主重启、模式切换有歧义，这里用统一引导重做一次干净对照。
 */
import { openStudio, sleep } from './boot.mjs'

const s = await openStudio()
const p = s.page

const tapText = async text => {
  const r = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const hit=[...v.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)})
    if(!hit) return null; const rc=hit.getBoundingClientRect()
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(1000)
  return true
}

const facts = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const g=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
  const modeOn=(()=>{for(const b of v.querySelectorAll('button')){
    if(!['文生视频','图生视频','首尾帧','参考图'].includes(b.innerText.trim()))continue
    const c=getComputedStyle(b); if(c.borderColor==='rgb(15, 17, 21)') return b.innerText.trim()}
    return null})()
  return {modeOn, hints:(t.match(/该模式需要一张参考图|至少需要一张首帧/g)||[]),
    gen:g?{dis:g.disabled}:null, thumbs:v.querySelectorAll('img').length,
    hasRemove:[...v.querySelectorAll('button')].some(b=>b.innerText.trim()==='移除'),
    snippet:t.slice(120,420)}
})()`)

await tapText('生视频')
await sleep(1400)
await tapText('图生视频')
await sleep(1200)
console.log('EMPTY   ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('m3b-i2v-empty'))

const inj = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const inp=v.querySelector('input[type=file]'); if(!inp) return {noInput:true}
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin=atob(b64); const u8=new Uint8Array(bin.length)
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i)
  const dt=new DataTransfer(); dt.items.add(new File([u8],'probe.png',{type:'image/png'}))
  inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}))
  return {ok:true, accept:inp.accept}
})()`)
console.log('INJECT  ', JSON.stringify(inj))
await sleep(3000)
console.log('FILLED  ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('m3b-i2v-filled'))

console.log('REMOVE  ', await tapText('移除'))
await sleep(1800)
console.log('REMOVED ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('m3b-i2v-removed'))

s.close(); setTimeout(() => process.exit(0), 400)

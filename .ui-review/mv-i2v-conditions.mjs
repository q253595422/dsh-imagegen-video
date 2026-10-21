/**
 * 判定「图生视频选图后仍禁用」是不是真 bug：逐一补齐条件，看哪一步才让按钮变可用。
 * 四个阶段：仅选图 / 仅提示词 / 图+提示词 / 切回文生视频+提示词（对照）。
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
  await sleep(900)
  return true
}

const facts = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  const g=[...v.querySelectorAll('button')].find(x=>/^生成视频$/.test(x.innerText.trim()))
  const ta=v.querySelector('textarea')
  return {hints:(t.match(/该模式需要一张参考图|至少需要一张首帧/g)||[]),
    gen:g?{dis:g.disabled}:null, thumbs:v.querySelectorAll('img').length,
    promptLen:ta?ta.value.length:null}
})()`)

const inject = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const inp=v.querySelector('input[type=file]'); if(!inp) return {noInput:true}
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const bin=atob(b64); const u8=new Uint8Array(bin.length)
  for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i)
  const dt=new DataTransfer(); dt.items.add(new File([u8],'probe.png',{type:'image/png'}))
  inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}))
  return {ok:true}
})()`)

const setPrompt = text => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const ta=v.querySelector('textarea'); if(!ta) return 'no-textarea'
  const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
  set.call(ta,${JSON.stringify(text)}); ta.dispatchEvent(new Event('input',{bubbles:true}))
  return ta.value.length
})()`)

await tapText('生视频')
await sleep(1400)
await tapText('图生视频')
await sleep(1200)
console.log('0-empty        ', JSON.stringify(await facts()))

await inject(); await sleep(2500)
console.log('1-img-only     ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('mv-img-only'))

console.log('setPrompt →', await setPrompt('the cat stretches slowly, warm afternoon light'))
await sleep(1500)
console.log('2-img+prompt   ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('mv-img-plus-prompt'))

// 移除图，只留提示词
await tapText('移除'); await sleep(1800)
console.log('3-prompt-only  ', JSON.stringify(await facts()))

// 对照：文生视频 + 提示词
await tapText('文生视频'); await sleep(1200)
console.log('4-t2v+prompt   ', JSON.stringify(await facts()))
console.log('shot', await p.shoot('mv-t2v-prompt'))

s.close(); setTimeout(() => process.exit(0), 400)

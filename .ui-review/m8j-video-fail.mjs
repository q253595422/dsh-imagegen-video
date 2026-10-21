/** 生视频链路的失败反馈：与文生图对照。 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 800)) }
const press = async (p, x, y, w = 500) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  const t = await p.evaluate(`(()=>{const el=[...document.querySelectorAll('[role=tab],button')].find(e=>(e.innerText||'').trim()==='生视频')
    if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  await press(p, t.x, t.y, 2600)
  rec('v0-enter', await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]')
    return {text:(v.innerText||'').replace(/\\s+/g,' ').slice(0,200)}})()`))
  await p.evaluate(`(()=>{const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!ta) return; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'a cat stretching, slow push in')
    ta.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(900)
  const g = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/开始生成|生成视频|生成/.test(e.innerText||'')&&!e.disabled&&e.getBoundingClientRect().width>100&&e.getBoundingClientRect().top>300)
    if(!b) return {none:true, btns:[...document.querySelectorAll('button')].filter(e=>!e.disabled&&e.getBoundingClientRect().width>100).map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,16)}
    b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(b.innerText||'').replace(/\\s+/g,' ').trim()}})()`)
  rec('v1-btn', g)
  if (g && !g.none) {
    await press(p, g.x, g.y, 800)
    const snap = (p) => p.evaluate(`(()=>{const t=document.body.innerText.replace(/\\s+/g,' ')
      const gen=[...document.querySelectorAll('button')].find(b=>/生成中|取消|排队/.test(b.innerText||''))
      return {btn:gen?(gen.innerText||'').replace(/\\s+/g,' ').trim():null,
        err:(t.match(/(失败|错误|HTTP \\d{3}|超时)/g)||[]).slice(0,5),
        tail:t.slice(-220)}})()`)
    rec('v2-t0.8', await snap(p)); R['v2-t0.8'].shot = await p.shoot('233-m8j-video-0.8s')
    await sleep(4000)
    rec('v3-t5', await snap(p)); R['v3-t5'].shot = await p.shoot('234-m8j-video-5s')
    await sleep(6000)
    rec('v4-t11', await snap(p)); R['v4-t11'].shot = await p.shoot('235-m8j-video-11s')
  }
  R.console = (p.consoleErrors || []).slice(-6)
} catch (e) { R.error = String(e && e.stack ? e.stack : e) }
finally { writeFileSync('.ui-review/m8j-video-fail.json', JSON.stringify(R, null, 2)); console.log('--- done'); close() }

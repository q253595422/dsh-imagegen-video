import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
const R={}
const press=async(p,x,y,w=500)=>{await p.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
  await p.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1})
  await p.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await sleep(w)}
const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  await p.evaluate(`(()=>{const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!ta) return; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'a red apple on a wooden table')
    ta.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(600)
  const g=await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/开始生成/.test(e.innerText||''))
    if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  if(!g){R.err='no gen btn'} else {
    await press(p,g.x,g.y,5000)
    // 诊断日志按钮
    const d=await p.evaluate(`(()=>{const b=document.querySelector('[data-diagnostics-button]')||[...document.querySelectorAll('button')].find(e=>/诊断日志/.test(e.innerText||''))
      if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    R.diagBtn=d
    if(d){ await press(p,d.x,d.y,1600)
      R.panel=await p.evaluate(`(()=>{const el=document.querySelector('[data-diagnostics-panel]')||[...document.querySelectorAll('section')].find(e=>/诊断日志/.test(e.innerText||'')&&e.getBoundingClientRect().width>300)
        if(!el)return {none:true}
        return {text:(el.innerText||'').replace(/\\s+/g,' ').slice(0,900)}})()`)
      R.shot=await p.shoot('232-m8i-diag-after-silent-fail')
    }
  }
  R.console=(p.consoleErrors||[]).slice(-8)
  R.pageErrors=p.pageErrors
} finally { writeFileSync('.ui-review/m8i-diag.json',JSON.stringify(R,null,2)); console.log(JSON.stringify(R).slice(0,1800)); close() }

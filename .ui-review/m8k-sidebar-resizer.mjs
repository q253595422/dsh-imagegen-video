import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
const R={}; const rec=(k,v)=>{R[k]=v;console.log('·',k,JSON.stringify(v).slice(0,700))}
const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  // 侧边栏搜索
  rec('s1-search', await p.evaluate(`(()=>{
    const all=[...document.querySelectorAll('input')].filter(e=>e.getBoundingClientRect().width>100)
    return all.map(e=>({type:e.type,ph:e.placeholder||'',aria:e.getAttribute('aria-label')||'',w:Math.round(e.getBoundingClientRect().width)}))
  })()`))
  const typed = await p.evaluate(`(()=>{
    const inp=[...document.querySelectorAll('input')].find(e=>/搜索/.test(e.placeholder||'')||/搜索/.test(e.getAttribute('aria-label')||''))
    if(!inp) return {none:true}
    const before=document.querySelectorAll('aside a,aside li,[class*=historyItem],[class*=HistoryItem]').length
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'zzzz不存在的东西')
    inp.dispatchEvent(new Event('input',{bubbles:true}))
    return {ok:true, before, ph:inp.placeholder}
  })()`)
  rec('s2-typed', typed)
  await sleep(1600)
  rec('s3-filtered', await p.evaluate(`(()=>{
    const aside=document.querySelector('aside')||document.body
    const t=(aside.innerText||'').replace(/\\s+/g,' ')
    return {text:t.slice(0,260), hasEmpty:/没有|无匹配|未找到|暂无/.test(t),
      count:(t.match(/\\d+\\s*条/)||[''])[0]}
  })()`))
  R['s3-filtered'].shot=await p.shoot('236-m8k-sidebar-search')
  // 清空
  await p.evaluate(`(()=>{const inp=[...document.querySelectorAll('input')].find(e=>/搜索/.test(e.placeholder||''))
    if(!inp) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'')
    inp.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(900)

  // 分隔条
  const sepr = await p.evaluate(`(()=>{
    const s=document.querySelector('[role=separator]')
    if(!s) return {none:true}
    const r=s.getBoundingClientRect(); const cs=getComputedStyle(s)
    s.focus()
    return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y),
      ti:s.getAttribute('tabindex'), aria:s.getAttribute('aria-label')||'',
      orient:s.getAttribute('aria-orientation')||'', cursor:cs.cursor,
      focused:document.activeElement===s}
  })()`)
  rec('r1-separator', sepr)
  if (sepr && !sepr.none) {
    const before = await p.evaluate(`document.querySelector('[data-dsh-imagegen-view]')?.getBoundingClientRect().width||0`)
    await p.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37})
    await p.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37})
    await sleep(600)
    const after = await p.evaluate(`document.querySelector('[data-dsh-imagegen-view]')?.getBoundingClientRect().width||0`)
    rec('r2-keyboard', {before:Math.round(before), after:Math.round(after), changed:Math.round(after)!==Math.round(before)})
  }
} catch(e){R.error=String(e&&e.stack?e.stack:e)}
finally{writeFileSync('.ui-review/m8k-sidebar-resizer.json',JSON.stringify(R,null,2));console.log('--- done');close()}

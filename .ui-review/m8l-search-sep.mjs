import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
const R={}; const rec=(k,v)=>{R[k]=v;console.log('·',k,JSON.stringify(v).slice(0,760))}
const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  rec('a1-all-inputs', await p.evaluate(`(()=>[...document.querySelectorAll('input')]
    .filter(e=>e.getBoundingClientRect().width>60)
    .map(e=>({ph:e.placeholder||'',aria:e.getAttribute('aria-label')||'',
      w:Math.round(e.getBoundingClientRect().width),x:Math.round(e.getBoundingClientRect().x)})))()`))
  const r = await p.evaluate(`(()=>{
    const inp=[...document.querySelectorAll('input')].find(e=>(e.placeholder||'').startsWith('搜索提示词'))
    if(!inp) return {none:true}
    const q=(els)=>[...els].map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)).filter(Boolean)
    const before=q(document.querySelectorAll('aside [class*=item],aside li,aside article')).length
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'zzzz不存在的')
    inp.dispatchEvent(new Event('input',{bubbles:true}))
    return {ok:true, before, ph:inp.placeholder}
  })()`)
  rec('a2-typed', r)
  await sleep(1800)
  rec('a3-after', await p.evaluate(`(()=>{
    const a=document.querySelector('aside')||document.body
    const t=(a.innerText||'').replace(/\\s+/g,' ')
    return {text:t.slice(0,300), hasEmpty:/没有|无匹配|未找到|暂无|试试/.test(t),
      itemCount:[...a.querySelectorAll('[class*=item],[class*=Item],li')].length}})()`))
  R['a3-after'].shot=await p.shoot('237-m8l-sidebar-search-typed')
  await p.evaluate(`(()=>{const inp=[...document.querySelectorAll('input')].find(e=>(e.placeholder||'').startsWith('搜索提示词'))
    if(!inp) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'')
    inp.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(800)

  rec('b1-sep-dom', await p.evaluate(`(()=>{
    const s=document.querySelector('[role=separator]')
    if(!s) return {none:true}
    const r=s.getBoundingClientRect(); const cs=getComputedStyle(s)
    const hit=document.elementsFromPoint(279, 500)
    return {w:r.width,h:r.height,display:cs.display,vis:cs.visibility,op:cs.opacity,
      ariaHidden:s.getAttribute('aria-hidden'), disabled:s.hasAttribute('disabled'),
      tabindex:s.getAttribute('tabindex'), canFocus:(()=>{try{s.focus()}catch(e){return 'err'}return document.activeElement===s})(),
      hitAt279:hit.slice(0,3).map(e=>e.tagName.toLowerCase()+'.'+((e.className||'').toString().slice(0,18)))}
  })()`))
} catch(e){R.error=String(e&&e.stack?e.stack:e)}
finally{writeFileSync('.ui-review/m8l-search-sep.json',JSON.stringify(R,null,2));console.log('--- done');close()}

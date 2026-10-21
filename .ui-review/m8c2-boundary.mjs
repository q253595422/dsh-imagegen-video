/**
 * 第 8 批收尾 C 组（修正版）：设置弹层 760 宽滚动、超长文案、Tab 顺序。
 * 上一版 c2 因 selector 过严（[role=dialog] 宽度>400）返回 none 后 throw，c3/c4 未执行。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1300)) }

const press = async (p, x, y, w = 900) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const tapText = async (p, text, nth = 0, wait = 1500) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hits=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .filter(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    const hit=hits[${nth}]
    if(!hit) return null
    hit.scrollIntoView({block:'center'})
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2),n:hits.length}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y, wait)
  return r
}
const tabKey = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await sleep(230)
}
const esc = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(900)
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---------- C2 设置弹层 @760
  await p.setViewport(760, 900)
  await sleep(1800)
  const g = await p.evaluate(`(()=>{
    const all=[...document.querySelectorAll('button,[role=button]')].filter(e=>e.getBoundingClientRect().width>0)
    const b=all.find(e=>e.getAttribute('aria-label')==='设置')
    const box=b&&b.getBoundingClientRect()
    return b?{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2),
      label:b.getAttribute('aria-label')}:{none:true, labels:all.map(e=>e.getAttribute('aria-label')||'').filter(Boolean).slice(0,20)}
  })()`)
  rec('c2-gear', g)
  if (g && !g.none) {
    await press(p, g.x, g.y, 3000)
    const dialogs = await p.evaluate(`(()=>{
      const cands=[...document.querySelectorAll('[role=dialog],[aria-modal],div')]
        .filter(e=>{const t=(e.innerText||'').trim(); const r=e.getBoundingClientRect()
          return /^设置/.test(t)&&r.width>300&&r.height>200})
      const dlg=cands.sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0]
      if(!dlg) return {none:true, roleCount:document.querySelectorAll('[role=dialog]').length,
        modals:document.querySelectorAll('[aria-modal]').length}
      window.__dlg=dlg
      const r=dlg.getBoundingClientRect()
      const sc=[...dlg.querySelectorAll('*')].filter(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      const ox=[...dlg.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+4&&e.clientWidth>0
        &&getComputedStyle(e).overflowX!=='visible'&&getComputedStyle(e).overflowX!=='hidden')
        .map(e=>({tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,26),
          sw:e.scrollWidth,cw:e.clientWidth,txt:(e.innerText||'').replace(/\\s+/g,' ').slice(0,26)}))
      return {tag:dlg.tagName.toLowerCase(), role:dlg.getAttribute('role'),
        ariaLabel:dlg.getAttribute('aria-label'), ariaModal:dlg.getAttribute('aria-modal'),
        box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
        vw:window.innerWidth, vh:window.innerHeight,
        overflowX: ox.slice(0,6),
        scrollers: sc.map(e=>({tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,20),sh:e.scrollHeight,ch:e.clientHeight})).slice(0,4)}
    })()`)
    rec('c2-dialog', dialogs)
    R['c2-dialog'].shot = await p.shoot('207-m8c-settings-760')

    const bot = await p.evaluate(`(()=>{
      const dlg=window.__dlg; if(!dlg) return {noRef:true}
      const sc=[...dlg.querySelectorAll('*')].find(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      if(!sc) return {noScroller:true, dlgScrollH:dlg.scrollHeight, dlgClientH:dlg.clientHeight}
      sc.scrollTop=sc.scrollHeight
      const leaves=[...dlg.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim().length>1)
      const last=leaves[leaves.length-1]; const r=last&&last.getBoundingClientRect()
      return {scrolled:Math.round(sc.scrollTop), sh:sc.scrollHeight, ch:sc.clientHeight,
        lastText:(last?.innerText||'').trim().slice(0,30),
        lastBottom:r?Math.round(r.bottom):null, vh:window.innerHeight,
        reachable: r? r.bottom<=window.innerHeight+2 : null}
    })()`)
    rec('c2-scroll-bottom', bot)
    R['c2-scroll-bottom'].shot = await p.shoot('208-m8c-settings-760-bottom')
    await esc(p)
    rec('c2-esc-closed', await p.evaluate(`!!window.__dlg && window.__dlg.isConnected`))
  }

  // ---------- C3 超长文案
  await p.setViewport(1600, 1000)
  await sleep(1600)
  const LONG = '一只戴着宇航员头盔的橘猫在月球上举起望远镜，水彩风格，柔和光线，'.repeat(18)
  const t1 = await p.evaluate(`(()=>{
    const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!ta) return {noTextarea:true}
    window.__ta=ta
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta, ${JSON.stringify(LONG)})
    ta.dispatchEvent(new Event('input',{bubbles:true}))
    return {len:ta.value.length, h:Math.round(ta.getBoundingClientRect().height),
      scrollH:ta.scrollHeight, maxLength:ta.maxLength, overflowY:getComputedStyle(ta).overflowY,
      resize:getComputedStyle(ta).resize}
  })()`)
  rec('c3-prompt', t1)
  await sleep(1200)
  rec('c3-prompt-after', await p.evaluate(`(()=>{
    const ta=window.__ta; const h=Math.round(ta.getBoundingClientRect().height)
    const box=ta.closest('div')
    const txt=(box?.parentElement?.innerText||'').replace(/\\s+/g,' ')
    const counter=(txt.match(/\\d+\\s*[\\/／]\\s*\\d+/)||[''])[0]
    const gen=[...document.querySelectorAll('button')].find(b=>/开始生成/.test(b.innerText||''))
    const gr=gen&&gen.getBoundingClientRect()
    return {h, scrollH:ta.scrollHeight, counter, counterFound:!!counter,
      genBelowFold: gr? gr.bottom>window.innerHeight : null,
      pageScrollH:document.documentElement.scrollHeight, docOverflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth+2}
  })()`))
  R['c3-prompt-after'].shot = await p.shoot('209-m8c-long-prompt')
  // 清掉
  await p.evaluate(`(()=>{ const ta=window.__ta
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'')
    ta.dispatchEvent(new Event('input',{bubbles:true})) })()`)

  // 电商长商品名
  await tapText(p, '电商模式', 0, 2800)
  await sleep(2400)
  const nm = await p.evaluate(`(()=>{
    const all=[...document.querySelectorAll('input,textarea')].filter(e=>e.getBoundingClientRect().width>100)
    const byLabel=all.find(e=>/商品|名称|name/i.test((e.placeholder||'')+(e.getAttribute('aria-label')||'')+(e.closest('label')?.innerText||'')))
    const t=byLabel||all[0]
    if(!t) return {none:true, fields:all.map(e=>e.placeholder||e.type).slice(0,10)}
    window.__name=t
    const proto=t.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(t, '超长商品名称测试'.repeat(9))
    t.dispatchEvent(new Event('input',{bubbles:true}))
    const r=t.getBoundingClientRect()
    return {tag:t.tagName.toLowerCase(), ph:t.placeholder||'', len:t.value.length,
      w:Math.round(r.width), h:Math.round(r.height), scrollW:t.scrollWidth,
      pageOverflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth+2}
  })()`)
  rec('c3-ecom-name', nm)
  await sleep(800)
  R['c3-ecom-name'].shot = await p.shoot('210-m8c-long-ecom-name')
  await p.evaluate(`(()=>{ const t=window.__name; if(!t) return
    const proto=t.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(t,'')
    t.dispatchEvent(new Event('input',{bubbles:true})) })()`)

  // ---------- C4 Tab 顺序（普通生图）
  await tapText(p, '普通生图', 0, 2800)
  await sleep(2000)
  await p.evaluate(`(()=>{ document.activeElement?.blur?.() })()`)
  const order = []
  for (let i = 0; i < 24; i++) {
    await tabKey(p)
    order.push(await p.evaluate(`(()=>{
      const a=document.activeElement
      if(!a||a===document.body) return {none:true}
      const r=a.getBoundingClientRect(); const cs=getComputedStyle(a)
      const ring=(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth||'0')>0)||(cs.boxShadow&&cs.boxShadow!=='none')
      return {tag:a.tagName.toLowerCase(), t:(a.innerText||a.value||a.placeholder||'').replace(/\\s+/g,' ').trim().slice(0,20),
        aria:a.getAttribute('aria-label')||'', off:r.width===0||r.height===0, ring:!!ring,
        outline:cs.outlineStyle+'/'+cs.outlineWidth}
    })()`))
  }
  rec('c4-tab-order', { seq: order.map(o=>o.none?'[body]':`${o.tag}:${o.t||o.aria||'-'}${o.off?'(0x0)':''}${o.ring?'·ring':''}`) })
  rec('c4-summary', {
    steps: order.length,
    anyRing: order.some(o=>o.ring),
    noRingStops: order.filter(o=>!o.none && !o.ring).length,
    zeroSizeStops: order.filter(o=>o.off).length,
    bodyStops: order.filter(o=>o.none).length,
  })
  R['c4-tab-order'].shot = await p.shoot('211-m8c-tab-order')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8c-longtext-keyboard.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

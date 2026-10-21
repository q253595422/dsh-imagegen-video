/**
 * 第 8 批收尾：C 组
 * C1 760 宽导航：「图片转 PPT」是否被截断（省略号/裁切）、「对话」是否竖排折行
 * C2 760 宽设置弹层：内部滚动容器能不能滚到最底部；哪个元素横向溢出
 * C3 超长文案：prompt 800 字 / 电商商品名 120 字 / 渠道名 60 字 —— 换行、截断、撑破布局
 * C4 键盘可达性：Tab 顺序、焦点环是否可见、是否有 tabindex=-1 把主按钮排除
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
const tab = async (p, shift = false) => {
  const m = shift ? 8 : 0
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: m })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: m })
  await sleep(220)
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await p.setViewport(760, 900)
  await sleep(1600)

  // ---- C1 导航两个缺陷
  rec('c1-nav-defects', await p.evaluate(`(()=>{
    const nav=[...document.querySelectorAll('[data-dsh-imagegen-tab],[role=tab]')].filter(e=>e.getBoundingClientRect().width>0)
    const rows=nav.map(e=>{
      const r=e.getBoundingClientRect(), cs=getComputedStyle(e)
      // 找到真正裁切文本的子孙
      const clipped=[...e.querySelectorAll('*')].filter(c=>c.scrollWidth>c.clientWidth+2&&c.clientWidth>0)
        .map(c=>({tag:c.tagName.toLowerCase(),sw:c.scrollWidth,cw:c.clientWidth,ov:getComputedStyle(c).textOverflow,
          ws:getComputedStyle(c).whiteSpace,txt:(c.textContent||'').slice(0,16)}))
      return {t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,12),
        w:Math.round(r.width),h:Math.round(r.height),
        whiteSpace:cs.whiteSpace, overflow:cs.overflow,
        title:e.getAttribute('title')||'', aria:e.getAttribute('aria-label')||'',
        childClipped:clipped.slice(0,3)}
    })
    // 顶栏右侧「对话」按钮
    const talk=[...document.querySelectorAll('button,[role=button]')].filter(b=>{
      const t=(b.innerText||'').replace(/\\s+/g,''); return t==='对话'&&b.getBoundingClientRect().width>0})
    return {tabs:rows,
      talkBtn:talk.map(b=>{const r=b.getBoundingClientRect()
        return {w:Math.round(r.width),h:Math.round(r.height),
          raw:JSON.stringify(b.innerText), whiteSpace:getComputedStyle(b).whiteSpace,
          wordBreak:getComputedStyle(b).wordBreak, aria:b.getAttribute('aria-label')||'', title:b.getAttribute('title')||''}}) }
  })()`))

  // ---- C2 设置弹层滚动到底 + 横向溢出元素
  const g = await p.evaluate(`(()=>{ const b=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>e.getAttribute('aria-label')==='设置'&&e.getBoundingClientRect().width>0)
    if(!b) return null; b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  if (g) {
    await press(p, g.x, g.y, 2400)
    rec('c2-dialog', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400).pop()
      if(!dlg) return {none:true}
      const dr=dlg.getBoundingClientRect()
      const sc=[...dlg.querySelectorAll('*')].filter(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      const ox=[...dlg.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+4&&e.clientWidth>0&&getComputedStyle(e).overflowX!=='visible')
        .map(e=>({tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,26),
          sw:e.scrollWidth,cw:e.clientWidth,txt:(e.innerText||'').replace(/\\s+/g,' ').slice(0,30)}))
      return {box:{x:Math.round(dr.x),y:Math.round(dr.y),w:Math.round(dr.width),h:Math.round(dr.height)},
        vh:window.innerHeight, dlgScrollable: dlg.scrollHeight>dlg.clientHeight+4,
        scrollers: sc.map(e=>({tag:e.tagName.toLowerCase(),sh:e.scrollHeight,ch:e.clientHeight})).slice(0,4),
        overflowX: ox.slice(0,6),
        lastRows:[...dlg.querySelectorAll('*')].filter(e=>/快捷键/.test((e.innerText||''))&&e.children.length===0)
          .map(e=>{const r=e.getBoundingClientRect();return {t:(e.innerText||'').trim().slice(0,12),top:Math.round(r.top),bottom:Math.round(r.bottom)}}).slice(0,4)}
    })()`))
    R['c2-dialog'].shot = await p.shoot('207-m8c-settings-760')
    // 滚到底
    rec('c2-scroll-bottom', await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400).pop()
      const sc=[...dlg.querySelectorAll('*')].find(e=>{const c=getComputedStyle(e)
        return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
      if(!sc) return {noScroller:true}
      sc.scrollTop=sc.scrollHeight
      const kids=[...dlg.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim().length>1)
      const last=kids[kids.length-1]; const r=last.getBoundingClientRect()
      return {scrolled:sc.scrollTop, sh:sc.scrollHeight, ch:sc.clientHeight,
        lastText:(last.innerText||'').trim().slice(0,30), lastBottom:Math.round(r.bottom), vh:window.innerHeight,
        reachable:r.bottom<=window.innerHeight+2}
    })()`))
    R['c2-scroll-bottom'].shot = await p.shoot('208-m8c-settings-760-bottom')
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(900)
  }

  // ---- C3 超长文案（1600 宽，常规环境）
  await p.setViewport(1600, 1000)
  await sleep(1400)
  const LONG = '一只戴着宇航员头盔的橘猫在月球上举起望远镜，水彩风格，柔和光线，'.repeat(18)
  rec('c3-prompt', await p.evaluate(`(()=>{
    const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!ta) return {noTextarea:true}
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set
    setter.call(ta, ${JSON.stringify(LONG)})
    ta.dispatchEvent(new Event('input',{bubbles:true}))
    return {len:ta.value.length, taH:Math.round(ta.getBoundingClientRect().height),
      taScrollH:ta.scrollHeight, maxLength:ta.maxLength,
      overflowY:getComputedStyle(ta).overflowY}
  })()`))
  await sleep(900)
  rec('c3-prompt-after', await p.evaluate(`(()=>{
    const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    const taH=Math.round(ta.getBoundingClientRect().height)
    // 找计数器
    const near=ta.closest('div')?.parentElement
    const txt=(near?.innerText||'').replace(/\\s+/g,' ')
    const counter=(txt.match(/\\d+\\s*\\/\\s*\\d+/)||[''])[0]
    const gen=[...document.querySelectorAll('button')].find(b=>/开始生成/.test(b.innerText||''))
    const gr=gen&&gen.getBoundingClientRect()
    return {taH, taScrollH:ta.scrollHeight, counter, counterFound:!!counter,
      genBox:gr?{t:Math.round(gr.top),b:Math.round(gr.bottom)}:null,
      genBelowFold: gr? gr.bottom>window.innerHeight: null,
      pageScrollH:document.documentElement.scrollHeight}
  })()`))
  R['c3-prompt-after'].shot = await p.shoot('209-m8c-long-prompt')

  // 电商长商品名
  await tapText(p, '电商模式', 0, 2600)
  await sleep(2200)
  const NAME = '超长商品名称测试'.repeat(9)
  rec('c3-ecom-name', await p.evaluate(`(()=>{
    const ins=[...document.querySelectorAll('input[type=text],input:not([type])')]
      .filter(e=>e.getBoundingClientRect().width>120&&/商品|名称|name/i.test((e.placeholder||'')+(e.getAttribute('aria-label')||'')+(e.closest('label')?.innerText||'')))
    const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>120)
    const t=ins[0]||ta[0]
    if(!t) return {none:true, inputs:ins.length, seen:[...document.querySelectorAll('input')].map(e=>e.placeholder).filter(Boolean).slice(0,14)}
    const proto=t.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(t, ${JSON.stringify(NAME)})
    t.dispatchEvent(new Event('input',{bubbles:true}))
    return {tag:t.tagName.toLowerCase(), ph:t.placeholder, len:t.value.length,
      w:Math.round(t.getBoundingClientRect().width), scrollW:t.scrollWidth}
  })()`))
  await sleep(700)
  R['c3-ecom-name'].shot = await p.shoot('210-m8c-long-ecom-name')

  // ---- C4 键盘可达性（回到普通生图）
  await tapText(p, '普通生图', 0, 2400)
  await sleep(1800)
  await p.evaluate(`(()=>{ document.activeElement?.blur?.(); document.body.focus?.() })()`)
  const order = []
  for (let i = 0; i < 22; i++) {
    await tab(p)
    const s = await p.evaluate(`(()=>{
      const a=document.activeElement
      if(!a||a===document.body) return {none:true}
      const r=a.getBoundingClientRect(); const cs=getComputedStyle(a)
      const ring=(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth||'0')>0)||cs.boxShadow!=='none'
      return {tag:a.tagName.toLowerCase(), t:(a.innerText||a.value||a.placeholder||'').replace(/\\s+/g,' ').trim().slice(0,22),
        aria:a.getAttribute('aria-label')||'', role:a.getAttribute('role')||'',
        off: r.width===0||r.height===0, ring,
        outline:cs.outlineStyle+' '+cs.outlineWidth, shadow:cs.boxShadow.slice(0,40),
        y:Math.round(r.top)}
    })()`)
    order.push(s)
  }
  rec('c4-tab-order', { steps: order.length, seq: order.map(o=>o.none?'[body]':`${o.tag}:${o.t||o.aria||'-'}${o.off?'(0x0)':''}${o.ring?'·ring':''}`) })
  rec('c4-focus-ring', {
    anyRing: order.some(o => o.ring),
    noRing: order.filter(o => o.ring === false).length,
    offscreen: order.filter(o => o.off).length,
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

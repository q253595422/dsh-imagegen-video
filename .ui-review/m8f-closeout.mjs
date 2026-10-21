/**
 * 第 8 批·F 组（收口）
 * F1 「图片转 PPT」在 760 宽到底是被裁成「图片转」还是只是视觉错觉：逐层量 clientWidth/scrollWidth + 文本 rect
 * F2 二级 tab（文生图/图生图/生视频）方向键能否切换（上一轮因工作区被方向键切走而没测到）
 * F3 设置里出现的版本号是谁：全文里所有 x.y.z 形状的字符串 + 上下文；插件版本 1.15.1 是否出现
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1400)) }

const press = async (p, x, y, w = 900) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const key = async (p, k, code, vk, mod = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod })
  await sleep(700)
}
const tapText = async (p, text, wait = 2200) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .find(e=>{const t=(e.innerText||'').replace(/\\s+/g,'').trim(); const r=e.getBoundingClientRect()
        return t===want&&r.width>0&&r.height>0})
    if(!hit) return null; hit.scrollIntoView({block:'center'})
    const r=hit.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y, wait)
  return true
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // ---- F1
  await p.setViewport(760, 900)
  await sleep(1800)
  rec('f1-ppt-tab', await p.evaluate(`(()=>{
    const tab=[...document.querySelectorAll('[role=tab]')].find(e=>/图片转/.test(e.innerText||'')&&e.getBoundingClientRect().width>0)
    if(!tab) return {none:true}
    const r=tab.getBoundingClientRect()
    const walk=[]
    const push=(e,d)=>{const b=e.getBoundingClientRect(); const cs=getComputedStyle(e)
      walk.push({d,tag:e.tagName.toLowerCase(),cls:(e.className||'').toString().slice(0,30),
        text:(e.children.length===0?(e.textContent||''):'').slice(0,16),
        cw:e.clientWidth, sw:e.scrollWidth, w:Math.round(b.width),
        ov:cs.overflow, to:cs.textOverflow, ws:cs.whiteSpace, flex:cs.flexShrink, maxW:cs.maxWidth})}
    push(tab,0)
    ;[...tab.querySelectorAll('*')].forEach(e=>push(e,1))
    // 文本实际渲染宽度
    const range=document.createRange(); range.selectNodeContents(tab)
    const rects=[...range.getClientRects()].map(q=>({l:Math.round(q.left),r:Math.round(q.right),w:Math.round(q.width)}))
    return {tabText:JSON.stringify(tab.innerText), textContent:JSON.stringify(tab.textContent),
      w:Math.round(r.width), h:Math.round(r.height), walk, rects,
      textOverflowsBox: rects.some(q=>q.r>r.right+1)}
  })()`))
  R['f1-ppt-tab'].shot = await p.shoot('218-m8f-ppt-tab-760')

  // ---- F2 二级 tab 方向键（先回到普通生图，用鼠标切，不污染）
  await p.setViewport(1600, 1000)
  await sleep(1500)
  await tapText(p, '普通生图', 2400)
  await sleep(1600)
  const inner = await p.evaluate(`(()=>{
    const tabs=[...document.querySelectorAll('[role=tab]')].filter(e=>/^(文生图|图生图|生视频)$/.test((e.innerText||'').trim()))
    return tabs.map(e=>({t:(e.innerText||'').trim(),sel:e.getAttribute('aria-selected'),ti:e.getAttribute('tabindex'),
      tag:e.tagName.toLowerCase()}))
  })()`)
  rec('f2-inner-tabs', inner)
  if (inner.length) {
    await p.evaluate(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>(e.innerText||'').trim()==='文生图'); t?.focus()})()`)
    const trail=[]
    for (const [k,c,v] of [['x','ArrowRight',39],['x','ArrowRight',39]]) {
      await key(p, k==='x'?'ArrowRight':'ArrowLeft', c, v)
      trail.push(await p.evaluate(`(()=>{const a=document.activeElement
        return {t:(a.innerText||'').trim().slice(0,8), sel:a.getAttribute('aria-selected'), ti:a.getAttribute('tabindex')}})()`))
    }
    rec('f2-arrow-trail', trail)
    rec('f2-selected', await p.evaluate(`(()=>[...document.querySelectorAll('[role=tab]')]
      .filter(e=>/^(文生图|图生图|生视频)$/.test((e.innerText||'').trim()))
      .map(e=>({t:(e.innerText||'').trim(),sel:e.getAttribute('aria-selected'),ti:e.getAttribute('tabindex')})))()`))
  }

  // ---- F3 版本号
  await tapText(p, '设置', 2600)
  const gear = await p.evaluate(`(()=>{
    const b=[...document.querySelectorAll('button,[role=button]')].find(e=>e.getAttribute('aria-label')==='设置'&&e.getBoundingClientRect().width>0)
    if(!b) return {none:true}; const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (gear && !gear.none) await press(p, gear.x, gear.y, 2800)
  rec('f3-settings-open', await p.evaluate(`document.querySelectorAll('[role=dialog]').length`))
  rec('f3-versions', await p.evaluate(`(()=>{
    const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>300).pop()
    const scope=dlg||document.body
    const t=(scope.innerText||'')
    const vers=[...new Set((t.match(/\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?/gi)||[]))]
    const leaves=[...scope.querySelectorAll('*')].filter(e=>e.children.length===0&&/当前版本|版本/.test(e.innerText||''))
    return {versions:vers, pluginVersionShown:/1\\.15\\.1/.test(t),
      versionLeaves:leaves.map(e=>({t:(e.innerText||'').trim().slice(0,40),tag:e.tagName.toLowerCase()})).slice(0,6),
      hasCheckUpdate:/检查更新|有新版本|更新到/.test(t), textLen:t.length}
  })()`))
  R['f3-versions'].shot = await p.shoot('219-m8f-settings-version')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm8f-closeout.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

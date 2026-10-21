/**
 * 第 5 批·无限画布 第五轮：把上一轮三个存疑项用更严谨的方式重测。
 * R1 「图片 / 视频」切换器是否真的换行（比 scrollHeight 与 clientHeight、量文字行数）
 * R2 新建画布：画布列表是否多了一条、新画布是否真的是空的
 * R3 双击空白：用两次真正的 press/release（上一轮只发了一次 clickCount:2）
 * R4 两个不同的配置节点同时选中时生成条是否消失
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 900)) }

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: opts.button || 'left', clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: opts.button || 'left', clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 })
  await sleep(opts.wait || 800)
}

const tapTitle = async (p, title) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>e.getAttribute('title')===${JSON.stringify(title)}||e.getAttribute('aria-label')===${JSON.stringify(title)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); if(rc.width===0) return null
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='无限画布'); if(b) b.click()})()`)
  for (let i = 0; i < 30; i++) {
    if (await p.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='添加图片节点')`)) break
    await sleep(300)
  }
  await sleep(1800)

  // ---------- R1 切换器换行 ----------
  // 先选中一个配置节点，让生成条出现
  const cfgPt = await p.evaluate(`(()=>{
    const n=[...document.querySelectorAll('[class*="_node"]')].find(e=>{
      const r=e.getBoundingClientRect(); return r.width>150&&r.height>100&&/生成配置/.test(e.innerText||'')
    })
    if(!n) return null
    const r=n.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+16)}
  })()`)
  if (cfgPt) await press(p, cfgPt.x, cfgPt.y, { wait: 1200 })

  rec('r1-toggle-metrics', await p.evaluate(`(()=>{
    const ta=[...document.querySelectorAll('textarea')].find(t=>/描述要生成的图片/.test(t.placeholder||''))
    if(!ta) return {noComposer:true}
    let scope=ta.parentElement
    for(let i=0;i<5&&scope;i++){ if(scope.querySelectorAll('button').length>3) break; scope=scope.parentElement }
    const out=[]
    for (const b of scope.querySelectorAll('button')) {
      const t=(b.innerText||'').trim()
      if(t!=='图片'&&t!=='视频') continue
      const cs=getComputedStyle(b)
      // 文字被拆成几行：用 Range 量每一行的高度与个数
      const rng=document.createRange(); rng.selectNodeContents(b)
      const rects=[...rng.getClientRects()].map(r=>({w:Math.round(r.width),h:Math.round(r.height),y:Math.round(r.y)}))
      out.push({
        text:t,
        box:{w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)},
        scrollH:b.scrollHeight, clientH:b.clientHeight,
        whiteSpace:cs.whiteSpace, wordBreak:cs.wordBreak, lineHeight:cs.lineHeight, fontSize:cs.fontSize,
        padding:cs.padding, textRects:rects,
        lines:rects.length, wrapped:rects.length>1,
      })
    }
    return out
  })()`))
  R['r1-toggle-metrics'].shot = await p.shoot('145-m5f-toggle-wrap')

  // ---------- R2 新建画布 ----------
  const listBefore = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const sel=[...v.querySelectorAll('button')].find(e=>/画布项目/.test(e.getAttribute('aria-label')||''))
    const nodes=[...v.querySelectorAll('[class*="_node"]')].filter(e=>e.getBoundingClientRect().width>100).length
    return {hasSelector:!!sel, nodes, name:(sel?(sel.innerText||'').trim():'')}
  })()`)
  rec('r2-before', listBefore)

  const clicked = await tapTitle(p, '新建画布')
  await sleep(3000)
  rec('r2-after', { clicked, state: await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const sel=[...v.querySelectorAll('button')].find(e=>/画布项目/.test(e.getAttribute('aria-label')||''))
    const nodes=[...v.querySelectorAll('[class*="_node"]')].filter(e=>e.getBoundingClientRect().width>100).length
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {nodes, name:(sel?(sel.innerText||'').trim():''), hasEmpty:/开始你的创作/.test(t), text:t.slice(0,220)}
  })()`)})
  R['r2-after'].shot = await p.shoot('146-m5f-new-canvas')

  // 打开画布项目下拉，数一数现在有几个画布
  const selPt = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const sel=[...v.querySelectorAll('button')].find(e=>/画布项目/.test(e.getAttribute('aria-label')||''))
    if(!sel) return null
    const r=sel.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (selPt) {
    await press(p, selPt.x, selPt.y, { wait: 1200 })
    rec('r2-project-list', await p.evaluate(`(()=>{
      const m=[...document.querySelectorAll('[role=menu],[class*="menu"],[class*="Menu"]')]
        .filter(e=>{const r=e.getBoundingClientRect(); return r.width>100&&r.height>40})
      return m.map(e=>({w:Math.round(e.getBoundingClientRect().width),
        text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,300),
        items:[...e.querySelectorAll('button,[role=menuitem],[role=option]')].map(b=>(b.innerText||'').trim().slice(0,24)).slice(0,20)}))
    })()`))
    R['r2-project-list'].shot = await p.shoot('147-m5f-project-list')
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(600)
  }

  // ---------- R3 双击空白：两次真正的按下-抬起 ----------
  const vb = await p.evaluate(`(()=>{
    const vp=document.querySelector('[class*="viewport"]')
    if(!vp) return null
    const r=vp.getBoundingClientRect()
    return {x:Math.round(r.x+r.width*0.35), y:Math.round(r.y+r.height*0.75)}
  })()`)
  rec('r3-blank-point', vb)
  if (vb) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vb.x, y: vb.y })
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vb.x, y: vb.y, button: 'left', clickCount: 1 })
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vb.x, y: vb.y, button: 'left', clickCount: 1 })
    await sleep(60)
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vb.x, y: vb.y, button: 'left', clickCount: 2 })
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vb.x, y: vb.y, button: 'left', clickCount: 2 })
    await sleep(1500)
  }
  rec('r3-double-click', await p.evaluate(`(()=>{
    const m=[...document.querySelectorAll('[role=menu],[class*="menu"],[class*="Menu"]')]
      .filter(e=>{const r=e.getBoundingClientRect(); return r.width>100&&r.height>40})
    return {menus:m.map(e=>({text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,240)})),
            nodes:[...document.querySelectorAll('[class*="_node"]')].filter(e=>e.getBoundingClientRect().width>100).length}
  })()`))
  R['r3-double-click'].shot = await p.shoot('148-m5f-doubleclick')

  // ---------- R4 两个不同配置节点 ----------
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  // 先确保画布上有两个配置节点
  await tapTitle(p, '添加配置节点')
  await sleep(1500)
  const cfgAll = await p.evaluate(`(()=>{
    // 只取最外层节点：父元素里不再有 class 含 _node 的
    const all=[...document.querySelectorAll('[class*="_node"]')].filter(e=>{
      const r=e.getBoundingClientRect(); return r.width>150&&r.height>100&&/生成配置/.test(e.innerText||'')&&!/生成配置[\\s\\S]*生成配置/.test(e.innerText||'')
    })
    return all.map(e=>{const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+16),w:Math.round(r.width)}})
  })()`)
  rec('r4-config-nodes', cfgAll)
  if (cfgAll.length >= 2) {
    await press(p, cfgAll[0].x, cfgAll[0].y, { wait: 800 })
    await press(p, cfgAll[1].x, cfgAll[1].y, { wait: 1200, modifiers: 8 }) // Shift
    rec('r4-two-selected', await p.evaluate(`(()=>{
      const ta=[...document.querySelectorAll('textarea')].find(t=>/描述要生成的图片/.test(t.placeholder||''))
      return {composer:!!ta, connected:[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/^已连接 \\d+ 个输入节点$/.test((e.textContent||'').trim())).map(e=>e.textContent.trim())}
    })()`))
    R['r4-two-selected'].shot = await p.shoot('149-m5f-two-config')
  }

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 12)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm5f-canvas-verify2.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

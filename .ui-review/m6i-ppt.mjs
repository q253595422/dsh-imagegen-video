/**
 * 第 6 批·图片转 PPT 实测（此前只有源码审计，零浏览器证据）。
 * L1 空态：整页结构、上传区文案、OCR 单选默认值、转换按钮禁用原因、结果区空态
 * L2 上传 2 张真实 PNG：缩略图 / 序号 / 文件名截断 / ←→× 按钮可用性
 * L3 排序按钮：点「→」是否真的换位（数据与 DOM 是否一致）
 * L4 文件数上限 12、非法类型拒绝（用非图片文件触发）
 * L5 「PPT 配置」弹层：role/aria-modal、Esc 是否关闭、焦点是否被限制
 * L6 「生成可编辑 PPT」未就绪时的禁用状态与说明文案
 * L7 拖拽区：整体是否可拖入（只做静态判定，不伪造 drop）
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1500)) }

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

const tapText = async (p, text) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .find(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

const setFiles = async (p, files) => {
  await p.send('DOM.enable')
  const doc = await p.send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await p.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
  if (!found.result.nodeIds.length) return { ok: false, reason: 'no file input' }
  const meta = await p.evaluate(`(()=>[...document.querySelectorAll('input[type=file]')].map((e,i)=>({
    i, accept:e.accept||'', multiple:e.multiple, hidden:!e.getClientRects().length })))()`)
  const target = meta.find(m => /image\/png/.test(m.accept)) || meta[meta.length - 1]
  await p.send('DOM.setFileInputFiles', { files, nodeId: found.result.nodeIds[target.i] })
  await sleep(2500)
  return { ok: true, used: target }
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  const opened = await tapText(p, '图片转 PPT')
  await sleep(2500)
  rec('l0-open', { opened, workspacePresent: await p.evaluate(`!!document.querySelector('[data-ppt-workspace]')`) })
  if (!opened) {
    rec('l0-tabs', await p.evaluate(`(()=>[...document.querySelectorAll('[role=tab],nav button')]
      .map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,20))()`))
  }

  // ---------- L1 空态 ----------
  rec('l1-empty', await p.evaluate(`(()=>{
    const w=document.querySelector('[data-ppt-workspace]')
    if(!w) return {none:true}
    const t=(w.innerText||'').replace(/\\s+/g,' ')
    const r=(e)=>{const b=e.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}}
    const btn=(sel)=>w.querySelector(sel)
    const conv=btn('[data-ppt-convert]')
    return {text:t.slice(0,700),
      layout:{root:r(w), sidebar:r(w.querySelector('aside')), main:r(w.querySelector('main'))},
      uploadZone: btn('[data-ppt-upload-empty]') ? {...r(btn('[data-ppt-upload-empty]')), text:(btn('[data-ppt-upload-empty]').innerText||'').replace(/\\s+/g,' ')} : null,
      convert:{dis:conv?conv.disabled:null, text:conv?(conv.innerText||'').trim():'', title:conv?conv.getAttribute('title')||'':'', ariaDis:conv?conv.getAttribute('aria-disabled'):null},
      radios:[...w.querySelectorAll('input[type=radio]')].map(e=>({name:e.name, checked:e.checked,
        label:(e.closest('label')?.innerText||'').replace(/\\s+/g,' ').trim(), dis:e.disabled, inFieldset:e.closest('fieldset')?.disabled})),
      emptyBlock:(w.querySelector('main')?.innerText||'').replace(/\\s+/g,' ').slice(0,160),
      note:(w.querySelector('p')?.innerText||'').slice(0,160)}
  })()`))
  R['l1-empty'].shot = await p.shoot('177-m6i-ppt-empty')

  // ---------- L5 配置弹层（先测，避免上传后状态干扰）----------
  const cfgBtn = await tapText(p, 'PPT 配置')
  await sleep(1500)
  rec('l5-dialog', { clicked: cfgBtn, state: await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog]')].map(e=>({
      label:e.getAttribute('aria-label'), modal:e.getAttribute('aria-modal'),
      w:Math.round(e.getBoundingClientRect().width), text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,320),
      buttons:[...e.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,22), dis:b.disabled})).filter(o=>o.t),
      fields:[...e.querySelectorAll('input,select,textarea')].map(f=>({tag:f.tagName.toLowerCase(), type:f.type,
        label:(f.closest('label')?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40), dis:f.disabled}))}))
    const active=document.activeElement
    return {dialogs:d, focus:{tag:active?.tagName.toLowerCase(), text:(active?.innerText||'').trim().slice(0,30)||active?.getAttribute('aria-label')||''}}
  })()`)})
  R['l5-dialog'].shot = await p.shoot('178-m6i-ppt-config-dialog')

  // Esc 能否关闭（role=dialog 一般应当能）
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(1000)
  rec('l5-esc', await p.evaluate(`({dialogs:[...document.querySelectorAll('[role=dialog]')].length,
    focusInsideDialog: !!document.activeElement?.closest('[role=dialog]')})`))
  // 若 Esc 没关，点 × 关掉
  if (await p.evaluate(`[...document.querySelectorAll('[role=dialog]')].length>0`)) {
    await p.evaluate(`(()=>{const d=document.querySelector('[role=dialog]')
      const b=[...d.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')==='关闭'||x.innerText.trim()==='×')
      if(b) b.click()})()`)
    await sleep(900)
  }

  // ---------- L2 上传 2 张 ----------
  const up = await setFiles(p, [
    '/Users/malang/chajian/dsh-imagegen-video/.ui-review/shots/65-m0-workspace.png',
    '/Users/malang/chajian/dsh-imagegen-video/.ui-review/shots/66-m0-ws-menu.png',
  ])
  rec('l2-upload', { up, state: await p.evaluate(`(()=>{
    const w=document.querySelector('[data-ppt-workspace]')
    const items=[...w.querySelectorAll('[data-ppt-input]')]
    return {count:items.length,
      countLabel:(w.querySelector('section header,[class*="sourceHeading"]')?.innerText||'').replace(/\\s+/g,' '),
      items:items.map((li,i)=>({
        i, name:(li.querySelector('[class*="inputName"]')?.textContent||''),
        nameTitle:(li.querySelector('[class*="inputName"]')?.getAttribute('title')||'').slice(0,50),
        imgLoaded: (()=>{const im=li.querySelector('img'); return !!im && im.complete && im.naturalWidth>0})(),
        imgBox:(()=>{const im=li.querySelector('img');const b=im?.getBoundingClientRect();return b?{w:Math.round(b.width),h:Math.round(b.height)}:null})(),
        btns:[...li.querySelectorAll('button')].map(b=>({a:b.getAttribute('aria-label')||'', t:(b.innerText||'').trim().slice(0,3), dis:b.disabled}))})),
      convert:{dis:w.querySelector('[data-ppt-convert]')?.disabled, text:(w.querySelector('[data-ppt-convert]')?.innerText||'').trim()},
      errors:[...w.querySelectorAll('[role=alert]')].map(e=>(e.innerText||'').trim().slice(0,120))}
  })()`)})
  R['l2-upload'].shot = await p.shoot('179-m6i-ppt-two-images')

  // ---------- L3 排序 ----------
  const before = await p.evaluate(`(()=>[...document.querySelectorAll('[data-ppt-input]')]
    .map(li=>(li.querySelector('[class*="inputName"]')?.textContent||'')))()`)
  const arrow = await p.evaluate(`(()=>{
    const li=[...document.querySelectorAll('[data-ppt-input]')][0]
    const b=[...li.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').includes('后')||x.innerText.trim()==='→')
    if(!b) return null
    b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled,label:b.getAttribute('aria-label')||''}
  })()`)
  rec('l3-arrow', arrow)
  if (arrow && !arrow.dis) {
    await press(p, arrow.x, arrow.y, { wait: 1200 })
    rec('l3-after-move', { before, after: await p.evaluate(`(()=>{
      const w=document.querySelector('[data-ppt-workspace]')
      return {order:[...w.querySelectorAll('[data-ppt-input]')].map(li=>(li.querySelector('[class*="inputName"]')?.textContent||'')),
        numbers:[...w.querySelectorAll('[data-ppt-input] [class*="slideNumber"]')].map(e=>(e.textContent||'').trim()),
        firstArrowDis:[...document.querySelectorAll('[data-ppt-input]')][0]
          ?[...document.querySelectorAll('[data-ppt-input]')][0].querySelector('button[aria-label*="向前"]')?.disabled:null,
        errors:[...w.querySelectorAll('[role=alert]')].map(e=>(e.innerText||'').trim().slice(0,120))}
    })()`)})
    R['l3-after-move'].shot = await p.shoot('180-m6i-ppt-reordered')
  }

  // ---------- L4 非法类型 ----------
  const bad = await setFiles(p, ['/Users/malang/chajian/dsh-imagegen-video/package.json'])
  await sleep(1800)
  rec('l4-bad-type', { bad, state: await p.evaluate(`(()=>{
    const w=document.querySelector('[data-ppt-workspace]')
    return {count:[...w.querySelectorAll('[data-ppt-input]')].length,
      alerts:[...w.querySelectorAll('[role=alert]')].map(e=>({t:(e.innerText||'').trim().slice(0,140), live:e.getAttribute('aria-live')})),
      anyToast:[...document.querySelectorAll('[role=status],[class*="toast"]')].map(e=>(e.innerText||'').trim().slice(0,80)).filter(Boolean)}
  })()`)})
  R['l4-bad-type'].shot = await p.shoot('181-m6i-ppt-bad-type')

  // ---------- L6 转换按钮为何不可用 ----------
  rec('l6-convert-gate', await p.evaluate(`(()=>{
    const w=document.querySelector('[data-ppt-workspace]')
    const c=w.querySelector('[data-ppt-convert]')
    const t=(w.innerText||'').replace(/\\s+/g,' ')
    return {dis:c.disabled, title:c.getAttribute('title')||'', text:(c.innerText||'').trim(),
      setupNote:(t.match(/请先在生图配置[^ ]{0,30}|需要[^ ]{0,10}skill|安装[^ ]{0,12}skill/)||[''])[0],
      tail:t.slice(-260)}
  })()`))

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6i-ppt.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

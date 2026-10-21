/**
 * 第 2 批：文生图 / 图生图 配置区。
 * 每个控件都做「读真实状态 → 操作 → 再读状态」的闭环，并把控件矩形记录下来，
 * 方便报告里把问题和截图坐标对上。不真发请求（避免花钱），只测到「开始生成」前的所有交互。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const F = []
const rec = o => { F.push(o); console.log('·', o.step, o.ok === false ? 'FAIL' : 'ok') }

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1500)

/** 把配置区里所有「选项型」控件按 label 找出来，读它们的真实状态。 */
const cfgDump = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const aside=v.querySelector('aside')||v
  // 找每组参数的标题 + 组内按钮
  const rows=[...aside.querySelectorAll('[class*=card]')].map(card=>{
    const title=(card.querySelector('[class*=label],[class*=title],h3,h4')||{}).innerText||''
    const btns=[...card.querySelectorAll('button')].map(b=>({
      t:b.innerText.trim().replace(/\\s+/g,' ').slice(0,24),
      active:b.hasAttribute('data-active')||b.getAttribute('aria-pressed')==='true'||b.getAttribute('aria-selected')==='true',
      disabled:b.hasAttribute('disabled'),
      rect:(()=>{const r=b.getBoundingClientRect();return{w:Math.round(r.width),h:Math.round(r.height)}})(),
    }))
    return {title:title.trim().slice(0,20), btns}
  }).filter(r=>r.btns.length)
  return rows
})()`)

rec({ step: 'text2img/config-groups', ok: true, note: JSON.stringify(await cfgDump()),
  shot: await p.shoot('m2-text2img-config') })

// ---------- 尺寸：逐项点选，看选中态是否唯一、是否联动提示 ----------
const sizeResult = await p.evaluate(`(()=>[...document.querySelectorAll('[data-dsh-imagegen-view] aside button')]
  .filter(b=>/^(自动|\\d+:\\d+)/.test(b.innerText.trim())).map(b=>b.innerText.trim().replace(/\\s+/g,' ')))()`)
rec({ step: 'text2img/size-options', ok: true, note: JSON.stringify(sizeResult) })

const sizeClick = []
for (const label of sizeResult.slice(0, sizeResult.length)) {
  try {
    await p.clickText(label, '[data-dsh-imagegen-view] aside')
    await sleep(300)
    const sel = await p.selectedLabels('[data-dsh-imagegen-view] aside')
    sizeClick.push({ label, selected: sel })
  } catch (e) {
    sizeClick.push({ label, error: String(e.message).slice(0, 80) })
  }
}
rec({ step: 'text2img/size-click-each', ok: true, note: JSON.stringify(sizeClick),
  shot: await p.shoot('m2-text2img-size-last') })

// 回到「自动」
try { await p.clickText('自动', '[data-dsh-imagegen-view] aside'); await sleep(300) } catch {}

// ---------- 清晰度 / 数量 / 细节 ----------
const groups = ['清晰度', '生成数量', '细节']
const groupState = []
for (const g of groups) {
  const state = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const all=[...v.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim()===${JSON.stringify(g)})
    let anchor=all[0]
    if(!anchor) return 'label-not-found'
    let card=anchor
    for(let i=0;i<6&&card.parentElement;i++){ card=card.parentElement; if(card.querySelector('button')) break }
    const btns=[...card.querySelectorAll('button')].map(b=>({t:b.innerText.trim(),
      active:b.hasAttribute('data-active')||b.getAttribute('aria-pressed')==='true'}))
    return {btns}
  })()`)
  groupState.push({ g, state })
}
rec({ step: 'text2img/param-groups', ok: true, note: JSON.stringify(groupState) })

// 数量：点 4 张
try {
  await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const lb=[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.innerText||'').trim()==='生成数量')
    let card=lb; for(let i=0;i<6&&card.parentElement;i++){card=card.parentElement; if(card.querySelector('button'))break}
    const b=[...card.querySelectorAll('button')].find(x=>x.innerText.trim()==='4 张'); b&&b.click()
  })()`)
  await sleep(500)
  rec({ step: 'text2img/count-4', ok: true, selected: await p.selectedLabels('[data-dsh-imagegen-view] aside'),
    shot: await p.shoot('m2-text2img-count4') })
} catch (e) { rec({ step: 'text2img/count-4', ok: false, note: String(e.message).slice(0, 120) }) }

// ---------- 增强开关（含计数 0） ----------
const enhanceBefore = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>x.innerText.includes('增强'))
  if(!b) return null
  return {text:b.innerText.trim().replace(/\\s+/g,' '), pressed:b.getAttribute('aria-pressed'),
    active:b.hasAttribute('data-active'), disabled:b.hasAttribute('disabled'),
    title:b.getAttribute('title'), aria:b.getAttribute('aria-label')}
})()`)
rec({ step: 'text2img/enhance-initial', ok: !!enhanceBefore, note: JSON.stringify(enhanceBefore) })
if (enhanceBefore) {
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.includes('增强')); b.click()})()`)
  await sleep(900)
  rec({ step: 'text2img/enhance-after', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.includes('增强'))
    return {text:b.innerText.trim().replace(/\\s+/g,' '), pressed:b.getAttribute('aria-pressed'), active:b.hasAttribute('data-active')}
  })()`)), shot: await p.shoot('m2-text2img-enhance-on') })
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');
    const b=[...v.querySelectorAll('button')].find(x=>x.innerText.includes('增强')); b.click()})()`)
  await sleep(600)
}

// ---------- 模板库弹层 ----------
try {
  await p.clickText('模板库', '[data-dsh-imagegen-view]')
  await sleep(1200)
  const lib = await p.evaluate(`(()=>{
    const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>d.innerText.includes('模板'))
    if(!dlg) return 'no-dialog'
    const r=dlg.getBoundingClientRect()
    return {rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      title:(dlg.querySelector('h2,h3,[class*=title]')||{}).innerText,
      cats:[...dlg.querySelectorAll('[role=tab],button')].map(b=>b.innerText.trim().replace(/\\s+/g,' ')).filter(t=>t&&t.length<20).slice(0,25),
      cards:dlg.querySelectorAll('[class*=card],[class*=item]').length,
      hasSearch:!!dlg.querySelector('input'),
      empty:dlg.innerText.includes('暂无')}
  })()`)
  rec({ step: 'template-library/open', ok: true, note: JSON.stringify(lib),
    shot: await p.shoot('m2-template-library') })

  // 搜索一个不存在的词 → 空态
  if (lib && lib.hasSearch) {
    const inp = await p.info('[role=dialog] input')
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inp.x + inp.w / 2, y: inp.y + inp.h / 2, button: 'left', clickCount: 1 })
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inp.x + inp.w / 2, y: inp.y + inp.h / 2, button: 'left', clickCount: 1 })
    for (const ch of 'zzzzzz') {
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
      await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await sleep(60)
    }
    await sleep(900)
    rec({ step: 'template-library/empty-search', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
      const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>d.innerText.includes('模板'))
      return {text:dlg?dlg.innerText.replace(/\\s+/g,' ').slice(0,160):null}
    })()`)), shot: await p.shoot('m2-template-empty') })
  }
  await p.key('Escape'); await sleep(600)
  const closed = !(await p.evaluate(`[...document.querySelectorAll('[role=dialog]')].some(d=>d.innerText.includes('模板'))`))
  rec({ step: 'template-library/esc-close', ok: closed })
  if (!closed) {
    // 找关闭按钮
    await p.evaluate(`(()=>{const dlg=[...document.querySelectorAll('[role=dialog]')].find(d=>d.innerText.includes('模板'));
      const b=dlg&&[...dlg.querySelectorAll('button')].find(x=>/关闭|×/.test(x.innerText)||/close/i.test(x.getAttribute('aria-label')||'')); b&&b.click()})()`)
    await sleep(600)
  }
} catch (e) { rec({ step: 'template-library/open', ok: false, note: String(e.message).slice(0, 200) }) }

// ---------- 切到图生图 ----------
try {
  await p.clickText('图生图', '[data-dsh-imagegen-view]')
  await sleep(1500)
  rec({ step: 'edit/enter', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    return {selected: [...v.querySelectorAll('[data-active],[aria-selected=true]')].map(e=>e.innerText.trim()).slice(0,6),
      uploadHint:[...v.querySelectorAll('*')].filter(e=>e.children.length===0&&/上传|拖|参考图/.test(e.innerText||'')).map(e=>e.innerText.trim()).slice(0,6)}
  })()`)), shot: await p.shoot('m2-edit-panel') })

  // 参考图上传区结构
  rec({ step: 'edit/reference-area', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const drop=[...v.querySelectorAll('[class*=drop],[class*=upload],[class*=reference]')].slice(0,6)
      .map(e=>({cls:String(e.className).slice(0,40),text:(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,50),
        rect:(()=>{const r=e.getBoundingClientRect();return{w:Math.round(r.width),h:Math.round(r.height)}})()}))
    const fileInputs=[...v.querySelectorAll('input[type=file]')].map(i=>({accept:i.accept,multiple:i.multiple}))
    return {drop, fileInputs, notice:[...v.querySelectorAll('[class*=notice],[class*=warn]')].map(e=>e.innerText.trim()).slice(0,4)}
  })()`)) })
} catch (e) { rec({ step: 'edit/enter', ok: false, note: String(e.message).slice(0, 200) }) }

// ---------- 多模型对比 ----------
try {
  await p.clickText('文生图', '[data-dsh-imagegen-view]')
  await sleep(1000)
  const cmp = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const lab=[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.innerText||'').trim()==='多模型对比')
    if(!lab) return 'label-not-found'
    const cb=lab.closest('label')?.querySelector('input')||lab.parentElement.querySelector('input')
    return {tag:cb&&cb.tagName, type:cb&&cb.type, checked:cb&&cb.checked,
      role:cb&&cb.getAttribute('role'), labelHasFor:!!cb&&!!cb.id}
  })()`)
  rec({ step: 'compare/find-toggle', ok: true, note: JSON.stringify(cmp) })
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');
    const lab=[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.innerText||'').trim()==='多模型对比');
    const cb=lab&&(lab.closest('label')?.querySelector('input')||lab.parentElement.querySelector('input')); cb&&cb.click()})()`)
  await sleep(1200)
  rec({ step: 'compare/after-toggle', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    return {modelPickers:v.querySelectorAll('select,[class*=picker],[class*=modelRow]').length,
      text:v.innerText.replace(/\\s+/g,' ').slice(0,200)}
  })()`)), shot: await p.shoot('m2-compare-on') })
  await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');
    const lab=[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.innerText||'').trim()==='多模型对比');
    const cb=lab&&(lab.closest('label')?.querySelector('input')||lab.parentElement.querySelector('input')); cb&&cb.click()})()`)
  await sleep(600)
} catch (e) { rec({ step: 'compare/find-toggle', ok: false, note: String(e.message).slice(0, 160) }) }

// ---------- 渠道/模型选择器 ----------
rec({ step: 'model/picker', ok: true, note: JSON.stringify(await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const sels=[...v.querySelectorAll('select')].map(s=>({options:[...s.options].map(o=>o.text).slice(0,30), value:s.value, rect:(()=>{const r=s.getBoundingClientRect();return{w:Math.round(r.width)}})()}))
  const custom=[...v.querySelectorAll('[role=combobox],[aria-haspopup]')].map(e=>({tag:e.tagName,text:(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,50)}))
  return {sels, custom}
})()`)) })

writeFileSync(join(SHOT_DIR, '..', 'm2-image.json'), JSON.stringify({
  findings: F, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failed: p.failedRequests.slice(0, 20),
}, null, 2))
console.log('--- console ---', JSON.stringify(p.consoleErrors.slice(-6)))
console.log('--- pageErrors ---', p.pageErrors.length)
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

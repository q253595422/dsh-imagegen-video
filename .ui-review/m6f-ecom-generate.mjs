/**
 * 第 6 批·电商模式 第六轮：真实生成一次（只选主图 1 张，成本最小），看状态流转。
 * I1 「参考图设置（可选）」展开后有什么
 * I2 填名称 + 只保留主图 → 点「生成套图预览」→ 轮询 60s，记录任务卡的状态文案变化
 * I3 若失败，记录错误文案与可重试入口
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1400)) }

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

const chipAt = (p, label) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(e=>new RegExp('^'+${JSON.stringify(label)}).test((e.innerText||'').trim()))
  if(!b) return null
  b.scrollIntoView({block:'center'})
  const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    text:(b.innerText||'').replace(/\\s+/g,' ').trim(), active:b.hasAttribute('data-active')}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2800)

  // ---------- I1 参考图设置 ----------
  const refBtn = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/参考图设置/.test(e.innerText||''))
    if(!b) return null
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      expanded:b.getAttribute('aria-expanded'), text:(b.innerText||'').replace(/\\s+/g,' ').trim()}
  })()`)
  rec('i1-ref-button', refBtn)
  if (refBtn) {
    await press(p, refBtn.x, refBtn.y, { wait: 1300 })
    rec('i1-ref-open', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const b=[...v.querySelectorAll('button')].find(e=>/参考图设置/.test(e.innerText||''))
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      const i=t.indexOf('参考图设置')
      return {expanded:b?b.getAttribute('aria-expanded'):null, section:i>=0?t.slice(i,i+260):'',
        checkboxes:[...v.querySelectorAll('input[type=checkbox]')].map(e=>({checked:e.checked,aria:e.getAttribute('aria-label')||''})),
        radios:[...v.querySelectorAll('[role=radio],[role=switch]')].map(e=>({t:(e.innerText||'').trim().slice(0,20),checked:e.getAttribute('aria-checked')}))}
    })()`))
    R['i1-ref-open'].shot = await p.shoot('168-m6f-ecom-ref-settings')
  }

  // ---------- I2 最小生成：名称 + 只留主图 ----------
  await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'UI 测评用马克杯'); inp.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await sleep(600)

  for (const name of ['卖点图', '场景图', '细节图']) {
    const c = await chipAt(p, name)
    if (c && c.active) { await press(p, c.x, c.y, { wait: 600 }) }
  }
  rec('i2-before-submit', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {sum:(t.match(/将生成 \\d+ 张套图/)||[''])[0], disabled:b?b.disabled:null,
      chips:[...v.querySelectorAll('button')].filter(e=>/^(主图|卖点图|场景图|细节图|规格图|使用图)/.test((e.innerText||'').trim()))
        .map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim()}))}
  })()`))
  R['i2-before-submit'].shot = await p.shoot('169-m6f-ecom-one-image')

  const submit = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled}
  })()`)
  rec('i2-submit-button', submit)
  if (!submit.dis) await press(p, submit.x, submit.y, { wait: 1500 })

  // 轮询 60s
  const timeline = []
  for (let i = 0; i < 20; i++) {
    const st = await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      const i=t.indexOf('套图结果')
      return {states:(t.match(/排队中|生成中|已完成|失败|等待|取消/g)||[]),
        result:t.slice(i,i+420),
        tasks:[...v.querySelectorAll('[class*="task"],[class*="Task"],[class*="job"]')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,120)).filter(Boolean).slice(0,4)}
    })()`)
    timeline.push({ t: i * 3, ...st })
    if (/失败|已完成/.test(st.result) && st.result.length > 40) break
    await sleep(3000)
  }
  rec('i2-timeline', timeline)
  R['i2-timeline'].shot = await p.shoot('170-m6f-ecom-result')

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 10)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6f-ecom-generate.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

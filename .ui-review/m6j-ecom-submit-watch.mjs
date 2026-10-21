/**
 * 第 6 批·电商模式 第九轮：从提交一路观察到终态（含「生成前预览」二级页）。
 * 之前失败的两次都是环境问题（服务挂了 / 用户中止 / timeout 不存在），不是逻辑问题；
 * 轮询条件已改为「结果栏出现图片 或 结果栏出现失败」，最长 4 分钟。
 * 记录：每次采样只读结果栏；失败时抓完整错误 + 展开诊断日志。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1200)) }

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

const resultArea = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  if(!v) return {noView:true}
  const heads=[...v.querySelectorAll('*')].filter(e=>e.children.length===0&&/^套图结果$/.test((e.textContent||'').trim()))
  const h=heads[heads.length-1]
  if(!h) return {noResultArea:true}
  let box=h.parentElement
  for(let i=0;i<6&&box&&box!==v;i++){ if(box.querySelectorAll('img,button').length>2) break; box=box.parentElement }
  const t=(box?box.innerText:v.innerText||'').replace(/\\s+/g,' ')
  const imgs=[...(box||v).querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>60})
  return {text:t.slice(0,500), imgs:imgs.length, imgSrc:(imgs[0]||{}).src?.slice(0,60)||'',
    stateWords:[...new Set((t.match(/生成中|已完成|失败|排队|等待|重试|取消|已取消|超时/g)||[]))]}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2800)

  // 填名称 + 只留主图（1 张，成本最小）
  await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'UI 测评用马克杯'); inp.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await sleep(700)
  for (const name of ['卖点图', '场景图', '细节图']) {
    const c = await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const b=[...v.querySelectorAll('button')].find(e=>new RegExp('^'+${JSON.stringify(name)}).test((e.innerText||'').trim()))
      if(!b) return null
      b.scrollIntoView({block:'center'})
      const r=b.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),active:b.hasAttribute('data-active')}
    })()`)
    if (c && c.active) await press(p, c.x, c.y, { wait: 600 })
  }
  rec('m0-before-preview', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    return {sum:(t.match(/将生成 \\d+ 张套图/)||[''])[0], dis:b?b.disabled:null}
  })()`))

  await tapText(p, '生成套图预览')
  await sleep(2800)

  // 「生成前预览」页
  const preview = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {present:/生成前预览|确认生成整套图片/.test(t), text:t.slice(0,700),
      buttons:[...v.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,16),dis:b.disabled})).filter(o=>o.t).slice(0,20)}
  })()`)
  rec('m1-preview-page', preview)
  R['m1-preview-page'].shot = await p.shoot('182-m6j-ecom-pre-preview')

  // 确认生成
  const confirm = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/确认生成整套图片/.test(e.innerText||''))
    if(!b) return null
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled,
      text:(b.innerText||'').trim()}
  })()`)
  rec('m2-confirm', confirm)
  if (!confirm) throw new Error('确认生成整套图片 按钮不存在')
  if (confirm.dis) throw new Error('确认按钮被禁用：' + JSON.stringify(confirm))
  await press(p, confirm.x, confirm.y, { wait: 2500 })

  const samples = []
  for (let i = 0; i < 48; i++) {
    const s = await resultArea(p)
    samples.push({ t: i * 5, ...s })
    if (s.noView) { await sleep(5000); continue }
    if ((s.imgs || 0) > 0) break
    if (/失败|已取消/.test(s.text || '')) break
    await sleep(5000)
  }
  rec('m3-samples', samples)
  R['m3-samples'].shot = await p.shoot('183-m6j-ecom-terminal')

  const last = samples[samples.length - 1] || {}
  if (/失败|已取消/.test(last.text || '')) {
    rec('m4-failure', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      return {tail:t.slice(-800), alerts:[...v.querySelectorAll('[role=alert]')].map(e=>(e.innerText||'').trim().slice(0,220))}
    })()`))
    R['m4-failure'].shot = await p.shoot('184-m6j-ecom-failure')
    await tapText(p, '诊断日志')
    await sleep(1800)
    rec('m5-diagnostics', await p.evaluate(`(()=>[...document.querySelectorAll('section,[role=dialog]')]
      .filter(e=>/诊断日志|phase|HTTP|请求/.test(e.innerText||''))
      .map(e=>({tag:e.tagName.toLowerCase(), role:e.getAttribute('role')||'', modal:e.getAttribute('aria-modal'),
        w:Math.round(e.getBoundingClientRect().width), text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,800)})))()`))
    R['m5-diagnostics'].shot = await p.shoot('185-m6j-ecom-diagnostics')
  }

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6j-ecom-submit-watch.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

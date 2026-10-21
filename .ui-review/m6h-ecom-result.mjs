/**
 * 第 6 批·电商模式 第八轮：只做一件事——把上一轮提交的任务看到终态。
 * 上一轮轮询的 break 条件写错了：结果区常驻标题「套图结果 0/1 已完成」里的「已完成」
 * 被当成任务完成标志，第一次采样就 break，等于没观察。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1600)) }

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

/** 只读结果区（「套图结果」右侧那一栏），避免被左栏文案干扰 */
const resultArea = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const heads=[...v.querySelectorAll('*')].filter(e=>e.children.length===0&&/^套图结果$/.test((e.textContent||'').trim()))
  const h=heads[heads.length-1]
  if(!h) return {noResultArea:true}
  // 往上找到包含结果卡片的容器
  let box=h.parentElement
  for(let i=0;i<4&&box;i++){ if(box.querySelectorAll('img,button').length>2) break; box=box.parentElement }
  const t=(box?box.innerText:'').replace(/\\s+/g,' ')
  const imgs=[...(box||v).querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>60})
  return {text:t.slice(0,600),
    imgs:imgs.length,
    imgSrc:(imgs[0]||{}).src?.slice(0,80)||'',
    stateWords:[...new Set((t.match(/生成中|已完成|失败|排队|等待|重试|取消/g)||[]))],
    buttons:[...(box||v).querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,16),
      dis:b.disabled})).filter(o=>o.t).slice(0,12)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(3000)

  const samples = []
  for (let i = 0; i < 30; i++) {
    const s = await resultArea(p)
    samples.push({ t: i * 5, ...s })
    // 真正的终态判断：出现了图片，或结果卡里明确写了「失败」
    if (s.imgs > 0 || /失败/.test(s.text || '')) break
    await sleep(5000)
  }
  rec('k1-result-samples', samples)
  R['k1-result-samples'].shot = await p.shoot('174-m6h-ecom-result-final')

  // 若失败，把完整错误原文抓下来（含诊断日志）
  if (/失败/.test((samples[samples.length - 1] || {}).text || '')) {
    rec('k2-failure', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      return {full:t.slice(-900), alerts:[...v.querySelectorAll('[role=alert]')].map(e=>(e.innerText||'').trim().slice(0,200))}
    })()`))
    R['k2-failure'].shot = await p.shoot('175-m6h-ecom-failure')

    // 展开「诊断日志」
    const diag = await tapText(p, '诊断日志')
    await sleep(1800)
    rec('k3-diagnostics', { clicked: diag, panel: await p.evaluate(`(()=>{
      const s=[...document.querySelectorAll('section,[role=dialog],[class*="diag"]')]
        .filter(e=>/诊断日志|phase|HTTP/.test(e.innerText||''))
      return s.map(e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',
        ariaModal:e.getAttribute('aria-modal'),w:Math.round(e.getBoundingClientRect().width),
        text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,700)}))
    })()`)})
    R['k3-diagnostics'].shot = await p.shoot('176-m6h-ecom-diagnostics')
  }

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6h-ecom-result.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

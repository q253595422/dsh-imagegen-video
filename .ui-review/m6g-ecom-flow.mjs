/**
 * 第 6 批·电商模式 第七轮：「生成前预览」二级页 + 真实提交。
 * J1 预览页结构：提示词是否可编辑、每张卡有哪些按钮、有几个「取消」
 * J2 提示词框是否被裁切（截图里看到底部文字被切）
 * J3 「AI 润色」点了之后发生什么
 * J4 点「确认生成整套图片」→ 轮询状态流转（排队/生成/完成/失败）与错误文案
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

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2800)

  // 填名称 + 只留主图，进入预览
  await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'UI 测评用马克杯'); inp.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await sleep(600)
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
  await tapText(p, '生成套图预览')
  await sleep(2500)

  // ---------- J1 预览页结构 ----------
  rec('j1-preview-structure', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {text:t.slice(0,900),
      buttons:[...v.querySelectorAll('button')].map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,18),
        title:(e.getAttribute('title')||'').slice(0,24), dis:e.disabled,
        x:Math.round(e.getBoundingClientRect().x), y:Math.round(e.getBoundingClientRect().y)})).filter(o=>o.t).slice(0,30),
      textareas:[...v.querySelectorAll('textarea')].map(e=>({ph:(e.placeholder||'').slice(0,30),
        val:(e.value||'').slice(0,60), h:Math.round(e.getBoundingClientRect().height)}))}
  })()`))
  R['j1-preview-structure'].shot = await p.shoot('171-m6g-ecom-preview-page')

  // ---------- J2 提示词框裁切 ----------
  rec('j2-prompt-clip', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const out=[]
    for(const ta of v.querySelectorAll('textarea')){
      const r=ta.getBoundingClientRect(); if(r.width<40) continue
      const cs=getComputedStyle(ta)
      out.push({w:Math.round(r.width),h:Math.round(r.height),
        scrollH:ta.scrollHeight, clientH:ta.clientHeight,
        clipped:ta.scrollHeight>ta.clientHeight+1,
        overflow:cs.overflowY, valueLen:(ta.value||'').length,
        rows:ta.rows})
    }
    return out
  })()`))

  // ---------- J3 AI 润色 ----------
  const pol = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/AI 润色/.test(e.innerText||''))
    if(!b) return null
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      before:(v.querySelector('textarea')||{}).value?.slice(0,40)}
  })()`)
  rec('j3-polish-button', pol)
  if (pol) {
    await press(p, pol.x, pol.y, { wait: 4000 })
    rec('j3-after-polish', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      const ta=v.querySelector('textarea')
      return {toast:[...v.querySelectorAll('[role=status],[role=alert],[class*="toast"]')].map(e=>(e.innerText||'').trim().slice(0,90)).filter(Boolean),
        textTail:t.slice(-260), textareaAfter:(ta?ta.value:'').slice(0,60),
        hasDiffUI:/原|替换|恢复|撤销|应用/.test(t.slice(-400))}
    })()`))
    R['j3-after-polish'].shot = await p.shoot('172-m6g-ecom-polish')
  }

  // ---------- J4 真实提交 ----------
  const go = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/确认生成整套图片/.test(e.innerText||''))
    if(!b) return null
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled}
  })()`)
  rec('j4-confirm-button', go)
  const timeline = []
  if (go && !go.dis) {
    await press(p, go.x, go.y, { wait: 1500 })
    for (let i = 0; i < 24; i++) {
      const st = await p.evaluate(`(()=>{
        const v=document.querySelector('[data-dsh-imagegen-view]')
        const t=(v.innerText||'').replace(/\\s+/g,' ')
        const i=t.indexOf('套图结果')
        const tail=i>=0?t.slice(i,i+400):t.slice(-320)
        return {marks:[...new Set((t.match(/排队中|生成中|已完成|失败|重试|取消|准备中|等待/g)||[]))],
          tail,
          imgs:[...v.querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>60}).length}
      })()`)
      timeline.push({ t: i * 4, ...st })
      if (/失败/.test(st.tail) || /已完成/.test(st.tail)) break
      await sleep(4000)
    }
  }
  rec('j4-timeline', timeline)
  R['j4-timeline'].shot = await p.shoot('173-m6g-ecom-submitted')

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6g-ecom-flow.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

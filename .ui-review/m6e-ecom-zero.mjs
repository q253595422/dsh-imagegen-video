/**
 * 第 6 批·电商模式 第五轮：0 张套图这个边界。
 * H1 把 6 个用途全部取消 → 底部还有没有「将生成 N 张套图」、按钮是否仍可点
 * H2 全部取消后再点「生成套图预览」会发生什么（有无提示、有无请求）
 * H3 「参考图设置（可选）」展开后有什么
 * H4 「平台 / 类目」下拉：选项是否硬编码中文、有没有 i18n
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

const chipAt = (p, label) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(e=>new RegExp('^'+${JSON.stringify(label)}).test((e.innerText||'').trim()))
  if(!b) return null
  b.scrollIntoView({block:'center'})
  const r=b.getBoundingClientRect()
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
    text:(b.innerText||'').replace(/\\s+/g,' ').trim(), active:b.hasAttribute('data-active')}
})()`)

const footer = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
  const t=(v.innerText||'').replace(/\\s+/g,' ')
  return {sumLine:(t.match(/将生成 \\d+ 张套图/)||[''])[0],
    hasZeroHint:/请至少选择|至少选一|未选择/.test(t),
    btn:{dis:b?b.disabled:null, title:b?b.getAttribute('title')||'':'', text:b?(b.innerText||'').trim():''},
    tail:t.slice(-200)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2600)

  // 填名称，排除「名称未填」这个禁用原因
  await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(inp,'测试商品'); inp.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await sleep(800)
  rec('h0-with-name', await footer(p))

  // ---------- H1 全部取消 ----------
  const steps = []
  for (const name of ['主图', '卖点图', '场景图', '细节图', '规格图', '使用图']) {
    const c = await chipAt(p, name)
    if (!c) { steps.push({ name, missing: true }); continue }
    if (c.active) { await press(p, c.x, c.y, { wait: 700 }) }
    const after = await chipAt(p, name)
    steps.push({ name, wasActive: c.active, nowActive: after?.active, footer: (await footer(p)).sumLine })
  }
  rec('h1-all-off', { steps, footer: await footer(p) })
  R['h1-all-off'].shot = await p.shoot('165-m6e-ecom-zero-select')

  // ---------- H2 0 张时点生成 ----------
  const btn = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),dis:b.disabled}
  })()`)
  rec('h2-button-zero', btn)
  if (!btn.dis) {
    const reqs = []
    p.send('Network.enable')
    await press(p, btn.x, btn.y, { wait: 3000 })
    rec('h2-after-click', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      return {tail:t.slice(-320),
        toast:[...v.querySelectorAll('[role=status],[role=alert],[class*="toast"]')].map(e=>(e.innerText||'').trim().slice(0,90)).filter(Boolean),
        newBlocks:(t.match(/生成失败[^ ]{0,40}/g)||[])}
    })()`))
    R['h2-after-click'].shot = await p.shoot('166-m6e-ecom-zero-submit')
  }

  // ---------- H3 参考图设置展开 ----------
  const ref = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/参考图设置/.test(e.innerText||''))
    if(!b) return null
    b.scrollIntoView({block:'center'})
    const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),expanded:b.getAttribute('aria-expanded')}
  })()`)
  rec('h3-ref-button', ref)
  if (ref) {
    await press(p, ref.x, ref.y, { wait: 1200 })
    rec('h3-ref-open', await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const b=[...v.querySelectorAll('button')].find(e=>/参考图设置/.test(e.innerText||''))
      const t=(v.innerText||'').replace(/\\s+/g,' ')
      const i=t.indexOf('参考图设置')
      return {expanded:b?b.getAttribute('aria-expanded'):null,
        section: i>=0? t.slice(i, i+300):'',
        toggles:[...v.querySelectorAll('input[type=checkbox],[role=switch]')].map(e=>({
          aria:e.getAttribute('aria-checked'), checked:e.checked, label:(e.getAttribute('aria-label')||'')}))}
    })()`))
    R['h3-ref-open'].shot = await p.shoot('167-m6e-ecom-ref-settings')
  }

  // ---------- H4 平台 / 类目 / 比例 下拉选项 ----------
  const opens = []
  for (const label of ['通用', '通用商品', '1:1']) {
    const b = await p.evaluate(`(()=>{
      const v=document.querySelector('[data-dsh-imagegen-view]')
      const els=[...v.querySelectorAll('button')].filter(e=>(e.innerText||'').trim()===${JSON.stringify(label)})
      const b=els[els.length-1]
      if(!b) return null
      b.scrollIntoView({block:'center'})
      const r=b.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
    })()`)
    if (!b) { opens.push({ label, missing: true }); continue }
    await press(p, b.x, b.y, { wait: 1100 })
    const opts = await p.evaluate(`(()=>{
      const m=[...document.querySelectorAll('[role=listbox],[role=menu],[class*="menu"],[class*="popover"]')]
        .filter(e=>{const r=e.getBoundingClientRect(); return r.width>60&&r.height>30})
      return m.map(e=>({role:e.getAttribute('role')||'', w:Math.round(e.getBoundingClientRect().width),
        items:[...e.querySelectorAll('[role=option],[role=menuitem],button,li')].map(x=>(x.innerText||'').trim()).filter(Boolean).slice(0,20)}))
    })()`)
    opens.push({ label, opts })
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
  }
  rec('h4-dropdowns', opens)

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6e-ecom-zero.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

/**
 * 第 4 批最后一块：左栏「计数为 0」的模型行。
 * 上一轮按 innerText 精确匹配模型名失败，因为按钮文字是「模型名 0」（带计数）。
 * 这里按「以模型名开头」匹配，点击后记录：选中态、卡片数、空态文案原文。
 * 另外测模型筛选「有结果」的一项，确认筛选本身是好的。
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 460)) }

const s = await openStudio()
const p = s.page

/** 左栏某一行的中心点：按文本前缀匹配 */
const rowPos = (prefix) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const b=[...v.querySelectorAll('button')].find(x=>(x.innerText||'').trim().startsWith(${JSON.stringify(prefix)}))
  if(!b) return null
  const r=b.getBoundingClientRect()
  if(r.width===0) return null
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:(b.innerText||'').trim().replace(/\\s+/g,' '),
    tag:b.tagName, role:b.getAttribute('role')||'', aria:b.getAttribute('aria-pressed')||b.getAttribute('aria-selected')||''}
})()`)

const clickAt = async (pos) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(1400)
}

/** 当前视图：卡片数、标题计数、空态原文、选中行 */
const state = () => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')
  const t=(v.innerText||'').replace(/[ \\t]+/g,' ')
  const lines=t.split('\\n').map(x=>x.trim()).filter(Boolean)
  return {
    imgs:v.querySelectorAll('img').length,
    countText:(t.match(/共\\s*\\d+\\s*幅/)||[])[0]||'',
    empty:lines.filter(x=>/还是空的|没有|暂无|无匹配|找不到/.test(x)),
    tail:lines.slice(-5),
    selectedRows:[...v.querySelectorAll('button')].filter(b=>{
      const c=getComputedStyle(b); return c.backgroundColor==='rgb(239, 240, 243)'})
      .map(b=>(b.innerText||'').trim().replace(/\\s+/g,' ')).slice(0,4)
  }
})()`)

const tapTop = async (text) => {
  const r = await p.evaluate(`(()=>{
    const hit=[...document.querySelectorAll('button,a,[role=tab]')].find(e=>(e.innerText||'').trim()===${JSON.stringify(text)})
    if(!hit) return null; const rc=hit.getBoundingClientRect()
    return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await clickAt(r); return true
}

await tapTop('素材库')
await sleep(2600)
rec('initial', await state())

// ---------- A. 计数为 0 的模型 ----------
const zero = await rowPos('agnes-image-2.1-flash')
rec('zero-row', zero)
if (zero) {
  await clickAt(zero)
  rec('zero-model-after', await state())
  R['zero-model-after'].shot = await p.shoot('m4d-zero-model')
}

// ---------- B. 计数 >0 的模型（对照，证明筛选可用）----------
const good = await rowPos('sensenova-u1.5-lite')
rec('good-row', good)
if (good) {
  await clickAt(good)
  rec('good-model-after', await state())
  R['good-model-after'].shot = await p.shoot('m4d-good-model')
}

// ---------- C. 模式筛选：图生图（1）----------
const mode = await rowPos('图生图')
rec('mode-row', mode)
if (mode) {
  await clickAt(mode)
  rec('mode-after', await state())
  R['mode-after'].shot = await p.shoot('m4d-mode-filter')
}

// ---------- D. 回到全部素材 ----------
const all = await rowPos('全部素材')
if (all) { await clickAt(all); rec('back-to-all', await state()) }

writeFileSync(join(SHOT_DIR, '..', 'm4d-gallery.json'), JSON.stringify({
  result: R, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
}, null, 2))
console.log('--- pageErrors', p.pageErrors.length)
s.close(); setTimeout(() => process.exit(0), 500)

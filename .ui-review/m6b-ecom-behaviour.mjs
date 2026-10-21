/**
 * 第 6 批·电商模式（预览）第二轮：行为与边界。
 * E1 布局：左表单栏 / 右结果栏的实际宽度、有没有被压窄、标题是否折行
 * E2 主图参考图：传 5 张（上限写 4）看实际接受几张、超限有没有提示
 * E3 风格参考图：传 2 张（上限写 1）看是「静默替换」还是「明确拒绝」
 * E4 商品名称必填：不填直接点「生成套图预览」，看有没有行内校验
 * E5 AI 帮写：名称空 / 名称有值，两种情况下点它分别发生什么
 * E6 套图结构：点选/取消（卖点图 2 / 场景图 2 可减到 0 吗），底部「将生成 N 张」是否同步
 * E7 生成设置：质量 1K/2K/4K 选中态、模型行展示了什么
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SHOT_DIR = new URL('./shots/', import.meta.url).pathname
const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1100)) }

const IMG_DIR = join(homedir(), '.dsh/dsh-imagegen/images')
const FIXTURES = readdirSync(IMG_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 8)
  .map(f => join(IMG_DIR, f))

const press = async (p, x, y, opts = {}) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: opts.button || 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: opts.button || 'left', clickCount: 1 })
  await sleep(opts.wait || 900)
}

/** 按可见文字找可见元素并点 */
const tapText = async (p, text, { exact = false } = {}) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],[role=menuitem],a')]
      .find(e=>{const t=(e.innerText||'').trim(); const ok=${exact ? 'true' : 'false'} ? t===want : (t===want||t.startsWith(want))
        const rc=e.getBoundingClientRect(); return ok&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

/** 给第 n 个 file input 塞文件（CDP DOM.setFileInputFiles） */
const setFiles = async (p, index, files) => {
  await p.send('DOM.enable')
  const doc = await p.send('DOM.getDocument', { depth: -1, pierce: true })
  const q = await p.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
  const ids = q.result.nodeIds || []
  if (!ids[index]) return { error: 'no-file-input', count: ids.length }
  const r = await p.send('DOM.setFileInputFiles', { files, nodeId: ids[index] })
  await sleep(1800)
  return { ok: !r.error, count: ids.length, cdpError: r.error?.message || null }
}

const snap = (p) => p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]')||document.body
  return { text:(v.innerText||'').replace(/\\s+/g,' ').slice(0,2600),
    thumbs:[...v.querySelectorAll('img')].filter(i=>i.getBoundingClientRect().width>20).length }
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '电商模式')
  await sleep(2600)

  // ---------- E1 布局 ----------
  rec('e1-layout', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const out={ viewW:Math.round(v.getBoundingClientRect().width) }
    // 找左右两栏：直接量「主图参考图」那张卡与右侧结果区
    const label=(t)=>[...v.querySelectorAll('*')].find(e=>e.children.length===0&&(e.textContent||'').trim()===t)
    const refCard=label('主图参考图')?.closest('div[class]')
    if(refCard){const r=refCard.getBoundingClientRect(); out.refCard={x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height)}}
    const res=label('套图结果')
    if(res){const r=res.closest('div[class]').getBoundingClientRect(); out.resultPanel={x:Math.round(r.x),w:Math.round(r.width)}}
    // 「主图参考图」这行标题是否折行：看它的 clientHeight 与行高
    const h=label('主图参考图')
    if(h){const r=h.getBoundingClientRect(); const cs=getComputedStyle(h)
      out.refHeading={text:h.textContent.trim(),w:Math.round(r.width),h:Math.round(r.height),lineHeight:cs.lineHeight,
        lines:Math.round(r.height/parseFloat(cs.lineHeight)||1)}}
    // 商品名称输入框宽度
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    if(inp){const r=inp.getBoundingClientRect(); out.nameInput={w:Math.round(r.width),x:Math.round(r.x)}}
    out.docOverflow={scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth}
    return out
  })()`))
  R['e1-layout'].shot = await p.shoot('151-m6b-ecom-layout')

  // 分区小标题里哪些被压到多行（「主图参考图 / 必选 · 商品主体图,最多 4 张」挤在同一行）
  rec('e1-heading-wrap', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const rows=[]
    for(const e of v.querySelectorAll('*')){
      if(e.children.length) continue
      const t=(e.textContent||'').trim(); if(!t||t.length<3) continue
      const r=e.getBoundingClientRect(); if(r.width<10) continue
      const cs=getComputedStyle(e)
      const lh=parseFloat(cs.lineHeight)||16
      const lines=Math.round(r.height/lh)
      if(lines>1&&r.y<1300) rows.push({t:t.slice(0,40),w:Math.round(r.width),lines,y:Math.round(r.y)})
    }
    return rows.slice(0,20)
  })()`))

  // ---------- E2 主图参考图：传 5 张 ----------
  rec('e2-upload-5', await setFiles(p, 0, FIXTURES.slice(0, 5)))
  await sleep(1200)
  rec('e2-after', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {counter:(t.match(/\\d\\/4/)||[''])[0], hasWarn:/超出|最多|只能|已达上限|请删除/.test(t),
      warnText:(t.match(/[^。]{0,30}(超出|最多|只能|已达上限)[^。]{0,40}/)||[''])[0],
      thumbs:[...v.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect(); return r.width>20&&r.height>20}).length}
  })()`))
  R['e2-after'].shot = await p.shoot('152-m6b-ecom-upload5')

  // ---------- E3 风格参考图：传 2 张（第 2 张应被拒或静默替换） ----------
  rec('e3-upload-2', await setFiles(p, 1, FIXTURES.slice(0, 2)))
  await sleep(1200)
  rec('e3-after', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {counter:(t.match(/\\d\\/1/)||[''])[0],
      hasWarn:/超出|最多 1|只能|已达上限|替换/.test(t),
      warnText:(t.match(/[^。]{0,30}(超出|最多|只能|已达上限|替换)[^。]{0,40}/)||[''])[0]}
  })()`))
  R['e3-after'].shot = await p.shoot('153-m6b-ecom-style2')

  // ---------- E4 商品名称必填：不填直接生成 ----------
  const btnState = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/生成套图预览/.test(e.innerText||''))
    if(!b) return {none:true}
    const r=b.getBoundingClientRect()
    return {t:b.innerText.trim(),dis:b.disabled,aria:b.getAttribute('aria-disabled'),title:b.getAttribute('title')||'',
      x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  rec('e4-button', btnState)
  if (!btnState.none) {
    await press(p, btnState.x, btnState.y, { wait: 2200 })
  }
  rec('e4-after-click', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    const inp=v.querySelector('input[placeholder*="商品名称"]')
    return {text:t.slice(0,700), invalid:inp?inp.getAttribute('aria-invalid'):null,
      hasErr:/请填写|必填|不能为空|请先/.test(t),
      errText:(t.match(/[^。]{0,20}(请填写|必填|不能为空|请先)[^。]{0,40}/)||[''])[0]}
  })()`))
  R['e4-after-click'].shot = await p.shoot('154-m6b-ecom-empty-submit')

  // ---------- E5 AI 帮写：名称为空时点它 ----------
  const aiState = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='AI 帮写')
    if(!b) return {none:true}
    const r=b.getBoundingClientRect(); return {dis:b.disabled,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  rec('e5-ai-button-empty-name', aiState)
  if (!aiState.none) {
    await press(p, aiState.x, aiState.y, { wait: 2500 })
  }
  rec('e5-after-ai', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    const ta=v.querySelector('textarea[placeholder*="品牌型号"]')
    const dlg=[...v.querySelectorAll('[role=dialog]')].map(d=>(d.innerText||'').replace(/\\s+/g,' ').slice(0,200))
    return {text:t.slice(0,600), dlg, textareaValue:(ta?ta.value:null),
      hasErr:/请填写|请先|需要|无法/.test(t)}
  })()`))
  R['e5-after-ai'].shot = await p.shoot('155-m6b-ecom-ai-help')

  // ---------- E6 套图结构：把「卖点图 2」取消 / 减到 0 ----------
  const structBefore = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {sum:(t.match(/将生成 \\d+ 张套图/)||[''])[0],
      chips:[...v.querySelectorAll('button')].filter(e=>/^(主图|卖点图|场景图|细节图|规格图|使用图)/.test((e.innerText||'').trim()))
        .map(e=>({t:(e.innerText||'').replace(/\\s+/g,' ').trim(),aria:e.getAttribute('aria-pressed')||e.getAttribute('aria-selected')||e.getAttribute('data-active')||'',
          title:e.getAttribute('title')||''}))}
  })()`)
  rec('e6-before', structBefore)
  // 点「卖点图 2」两次，看计数能否降到 0
  const sp = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const b=[...v.querySelectorAll('button')].find(e=>/^卖点图/.test((e.innerText||'').trim()))
    if(!b) return null
    const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
  })()`)
  if (sp) {
    await press(p, sp.x, sp.y, { wait: 700 })
    const one = await snap(p)
    await press(p, sp.x, sp.y, { wait: 700 })
    const two = await snap(p)
    rec('e6-sellpoint-clicks', {
      after1: (one.text.match(/将生成 \d+ 张套图/) || [''])[0],
      after2: (two.text.match(/将生成 \d+ 张套图/) || [''])[0],
      chipAfter2: (two.text.match(/卖点图 ?\d?/) || [''])[0],
    })
    R['e6-sellpoint-clicks'].shot = await p.shoot('156-m6b-ecom-structure')
  }

  // ---------- E7 生成设置 ----------
  rec('e7-settings', await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const seg=(label)=>{
      const b=[...v.querySelectorAll('button')].find(e=>(e.innerText||'').trim()===label)
      if(!b) return null
      return {dis:b.disabled, pressed:b.getAttribute('aria-pressed'), active:b.hasAttribute('data-active'),
        cls:(b.className||'').toString().slice(0,40)}
    }
    const t=(v.innerText||'').replace(/\\s+/g,' ')
    return {auto:seg('自动'), q1:seg('1K'), q2:seg('2K'), q4:seg('4K'),
      modelRow:(t.match(/\d+ \/ [\w.\-]+/)||[''])[0],
      tail:t.slice(-260)}
  })()`))
  R['e7-settings'].shot = await p.shoot('157-m6b-ecom-settings')

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 10)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm6b-ecom-behaviour.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

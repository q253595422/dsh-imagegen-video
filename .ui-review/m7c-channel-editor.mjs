/**
 * 第 7 批·渠道编辑器（设置 → 生图配置 → 渠道 → 编辑）。
 * P1 编辑区有哪些字段与按钮，是否有「测试连接」
 * P2 密钥字段类型（password / text）、是否可回显、占位文案
 * P3 清空地址/密钥后点保存 → 有无校验提示，提示出现在哪
 * P4 底部「保存」是 sticky 还是被内容遮住（截图里 footer 压住内容）
 * P5 关闭未保存时有无确认
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

const tapText = async (p, text, nth = 0) => {
  const r = await p.evaluate(`(()=>{
    const want=${JSON.stringify(text)}
    const hits=[...document.querySelectorAll('button,[role=tab],[role=button],a')]
      .filter(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    const hit=hits[${nth}]
    if(!hit) return null
    hit.scrollIntoView({block:'center'})
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2),n:hits.length}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y, { wait: 1400 })
  return r
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  await tapText(p, '设置')
  await sleep(2000)
  await tapText(p, '生图配置')
  await sleep(2400)

  // P1 点第一个渠道的「编辑」
  const ed = await tapText(p, '编辑', 0)
  rec('p1-edit-click', ed)
  await sleep(1200)
  rec('p1-editor', await p.evaluate(`(()=>{
    const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
    const t=(scope.innerText||'').replace(/\\s+/g,' ')
    return {text:t.slice(0,1400),
      hasTest:/测试连接|测试|Test/i.test(t),
      fields:[...scope.querySelectorAll('input,select,textarea')].filter(e=>e.getBoundingClientRect().width>0)
        .map(e=>({tag:e.tagName.toLowerCase(),type:e.type||'',ph:e.placeholder||'',
          val:(e.value||'').slice(0,14), dis:e.disabled,
          aria:e.getAttribute('aria-label')||'', name:e.name||''})),
      buttons:[...scope.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20),
        a:b.getAttribute('aria-label')||'', dis:b.disabled})).filter(o=>o.t).slice(0,26)}
  })()`))
  R['p1-editor'].shot = await p.shoot('193-m7b-channel-editor')

  // P4 footer 是否 sticky / 盖住内容
  rec('p4-footer', await p.evaluate(`(()=>{
    const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
    const save=[...scope.querySelectorAll('button')].find(b=>/^保存/.test((b.innerText||'').trim()))
    if(!save) return {none:true}
    const bar=save.closest('footer')||save.parentElement
    const cs=getComputedStyle(bar)
    const scroller=[...scope.querySelectorAll('*')].find(e=>{const c=getComputedStyle(e);return /(auto|scroll)/.test(c.overflowY)&&e.scrollHeight>e.clientHeight+4})
    return {barTag:bar.tagName.toLowerCase(),position:cs.position,bg:cs.backgroundColor,
      scroller:scroller?{tag:scroller.tagName.toLowerCase(),scrollH:scroller.scrollHeight,clientH:scroller.clientHeight}:null,
      bodyTextBehindBar:(document.elementFromPoint(window.innerWidth/2, window.innerHeight-140)||{}).tagName||''}
  })()`))

  // P3 清空第一个 URL 输入再保存
  rec('p3-clear-and-save', await p.evaluate(`(()=>{
    const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
    const inputs=[...scope.querySelectorAll('input')].filter(e=>e.getBoundingClientRect().width>0&&/https?:|api/i.test(e.value||''))
    const target=inputs[0]
    if(!target) return {noUrlInput:true, seen:[...scope.querySelectorAll('input')].map(e=>({type:e.type,val:(e.value||'').slice(0,20),ph:e.placeholder}))}
    const before=target.value
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(target,''); target.dispatchEvent(new Event('input',{bubbles:true}))
    return {clearedFrom:before.slice(0,40), now:target.value}
  })()`))
  await sleep(600)
  const saved = await tapText(p, '保存')
  await sleep(2200)
  rec('p3-after-save', { clicked: saved, state: await p.evaluate(`(()=>{
    const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
    const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400)
    const t=((dlg[dlg.length-1]||scope).innerText||'').replace(/\\s+/g,' ')
    return {alerts:[...document.querySelectorAll('[role=alert]')].map(e=>(e.innerText||'').trim().slice(0,160)),
      toasts:[...document.querySelectorAll('[role=status],[class*=toast]')].map(e=>(e.innerText||'').trim().slice(0,120)).filter(Boolean),
      hasRequired:/必填|不能为空|请输入|请填写/.test(t),
      tail:t.slice(-420)}
  })()`)})
  R['p3-after-save'].shot = await p.shoot('194-m7b-channel-save-validate')

  R.pageErrors = p.pageErrors
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm7c-channel-editor.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

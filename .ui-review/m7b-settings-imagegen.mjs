/**
 * 第 7 批·生图配置页（设置 → 生图配置）。
 * O1 页面结构：总分览 badge、各分区标题/摘要/展开态
 * O2 渠道编辑：有没有「测试连接」、密钥是明文还是可回显、必填校验
 * O3 更新：页内是否有「当前版本 / 检查更新」
 * O4 二次打开设置时，之前叠着的「诊断日志」是否还在（图层叠放）
 * O5 键盘：Esc 关设置
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
    const hit=[...document.querySelectorAll('button,[role=tab],[role=button],a,div[tabindex],li')]
      .find(e=>{const t=(e.innerText||'').trim(); const rc=e.getBoundingClientRect()
        return (t===want||t.startsWith(want))&&rc.width>0&&rc.height>0})
    if(!hit) return null
    const rc=hit.getBoundingClientRect(); return {x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await press(p, r.x, r.y)
  return true
}

const esc = async (p) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(900)
}

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })

try {
  // O1 打开设置 → 生图配置
  await tapText(p, '设置')
  await sleep(2200)
  rec('o0-dialog', await p.evaluate(`(()=>{
    const d=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400)
    return {dialogs:d.length, labels:d.map(e=>e.getAttribute('aria-label')||''),
      items:[...document.querySelectorAll('[role=tab],[role=menuitem],button')]
        .map(e=>(e.innerText||'').trim()).filter(t=>t&&t.length<8).slice(0,20)}
  })()`))

  const ok = await tapText(p, '生图配置')
  await sleep(2600)
  rec('o1-page', { clicked: ok, state: await p.evaluate(`(()=>{
    const card=document.querySelector('[data-dsh-imagegen-settings-panel]')
    const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400)
    const scope=dlg[dlg.length-1]||document.body
    const t=(scope.innerText||'').replace(/\\s+/g,' ')
    return {cardPresent:!!card,
      summaryBadge:(scope.querySelector('[data-state]')?.innerText||'').trim(),
      summaryHint:(t.match(/配置|就绪|需要配置|尚未配置|已配置[^ ]{0,20}/g)||[]).slice(0,6),
      text:t.slice(0,1100),
      sections:[...scope.querySelectorAll('section')].slice(0,14).map(s=>({
        id:s.id||'', open:s.hasAttribute('data-open'),
        head:(s.querySelector('button')?.innerText||'').replace(/\\s+/g,' ').slice(0,60),
        expanded:s.querySelector('button')?.getAttribute('aria-expanded')})),
      buttons:[...scope.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20),
        a:b.getAttribute('aria-label')||'', dis:b.disabled})).filter(o=>o.t).slice(0,30),
      hasTest:/测试连接|Test connection|测试 API/i.test(t),
      hasVersion:/\bv?\d+\.\d+\.\d+\b/.test(t),
      versionHit:(t.match(/v?\\d+\\.\\d+\\.\\d+/g)||[]).slice(0,4)}
  })()`)})
  R['o1-page'].shot = await p.shoot('191-m7b-settings-imagegen')

  // O2 展开「渠道」类分区，找渠道行与编辑入口
  const chan = await p.evaluate(`(()=>{
    const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
    const btns=[...scope.querySelectorAll('section > button')]
    const target=btns.find(b=>/渠道|Channel/i.test(b.innerText||''))
    if(!target) return {none:true, heads:btns.map(b=>(b.innerText||'').replace(/\\s+/g,' ').slice(0,40))}
    target.scrollIntoView({block:'center'})
    const r=target.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
      text:(target.innerText||'').replace(/\\s+/g,' ').slice(0,80),
      expanded:target.getAttribute('aria-expanded')}
  })()`)
  rec('o2-channel-head', chan)
  if (chan && !chan.none) {
    await press(p, chan.x, chan.y, { wait: 1500 })
    rec('o2-channel-open', await p.evaluate(`(()=>{
      const scope=document.querySelector('[data-dsh-imagegen-settings-panel]')||document.body
      const t=(scope.innerText||'').replace(/\\s+/g,' ')
      return {text:t.slice(0,1200),
        hasTest:/测试连接|Test connection/i.test(t),
        channelRows:[...scope.querySelectorAll('[data-channel],[class*="channel"]')].filter(e=>e.getBoundingClientRect().height>20).slice(0,6)
          .map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,90)),
        buttons:[...scope.querySelectorAll('button')].map(b=>({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,22),
          a:b.getAttribute('aria-label')||'', dis:b.disabled})).filter(o=>o.t).slice(0,26),
        inputs:[...scope.querySelectorAll('input,select')].filter(e=>e.getBoundingClientRect().width>0)
          .map(e=>({tag:e.tagName.toLowerCase(), type:e.type||'', ph:e.placeholder||'',
            val:(e.value||'').slice(0,12), dis:e.disabled, aria:e.getAttribute('aria-label')||''})).slice(0,14)}
    })()`))
    R['o2-channel-open'].shot = await p.shoot('192-m7b-settings-channels')
  }

  // O4 诊断日志是否还压着
  rec('o4-layering', await p.evaluate(`(()=>{
    const dp=document.querySelector('[data-diagnostics-panel]')
    const dlg=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400)
    const dz=(e)=>getComputedStyle(e).zIndex
    return {diagnosticsStillMounted:!!dp, diagnosticsZ:dp?dz(dp):null,
      dialogs:dialogs2(dlg)}
    function dialogs2(a){return a.map(e=>({label:e.getAttribute('aria-label')||'', z:dz(e)}))}
  })()`))

  // O5 Esc
  await esc(p)
  rec('o5-esc', await p.evaluate(`(()=>({
    bigDialogs:[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getBoundingClientRect().width>400).length,
    diagnostics:!!document.querySelector('[data-diagnostics-panel]')}))()`))

  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(0, 8)
} catch (e) {
  R.error = String(e && e.stack ? e.stack : e)
} finally {
  writeFileSync(join(SHOT_DIR, '..', 'm7b-settings-imagegen.json'), JSON.stringify(R, null, 2))
  console.log('--- pageErrors', (p.pageErrors || []).length)
  close()
}

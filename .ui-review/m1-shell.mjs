/**
 * 模块 1+2：面板外壳（顶栏/导航/对话栏/配置区）与宿主侧边栏注入（两页签 + 历史记录）。
 * 每一步都读回真实状态，不做「点到了就算过」的假绿。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const F = []
const rec = (o) => { F.push(o); console.log('·', o.step, o.ok === false ? 'FAIL' : 'ok', o.note ?? '') }

const b = await launch()
const p = await newPage(b.port, loginUrl())

const shot = async (label) => p.shoot(label)

try {
  // ---------- 进入面板 ----------
  await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
  rec({ step: 'sidebar/tabs-exist', ok: true, tabs: await p.evaluate(
    `[...document.querySelectorAll('[data-dsh-imagegen-tab]')].map(e=>e.dataset.dshImagegenTab+':'+e.innerText.trim()).join(',')`) })

  await p.click('[data-dsh-imagegen-tab="image"]')
  const mounted = await p.waitFor('[data-dsh-imagegen-view]', 20000)
  await sleep(3000)
  rec({ step: 'panel/mounted', ok: mounted, htmlAttr: await p.evaluate(
    `document.documentElement.getAttribute('data-dsh-imagegen-active')`) })

  // ---------- 外壳：顶栏与导航 ----------
  const shell = await p.evaluate(`(()=>{
    const v=document.querySelector('[data-dsh-imagegen-view]')
    const nav=v.querySelector('nav')||v.querySelector('[class*=nav]')
    const navItems=[...(v.querySelectorAll('button')||[])].filter(b=>b.closest('header'))
      .map(b=>b.innerText.trim().replace(/\\s+/g,' ')).filter(Boolean)
    const r=v.getBoundingClientRect()
    return { rect:{x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height)},
      navCount: nav?nav.querySelectorAll('button').length:0,
      headerButtons: navItems,
      active: [...v.querySelectorAll('[data-active],[aria-selected="true"],[aria-pressed="true"]')]
        .map(e=>e.innerText.trim().replace(/\\s+/g,' ')).slice(0,10) }
  })()`)
  rec({ step: 'shell/header', ok: shell.navCount >= 5, note: JSON.stringify(shell), shot: await shot('m1-shell-full') })

  // 顶栏五项逐个切换，看内容区真的换了吗
  const navLabels = ['普通生图', '素材库', '无限画布', '电商模式预览', '图片转 PPT']
  for (const label of navLabels) {
    try {
      const before = await p.evaluate(`document.querySelector('[data-dsh-imagegen-view]').innerText.slice(0,200)`)
      await p.clickText(label, '[data-dsh-imagegen-view]')
      await sleep(1600)
      const after = await p.evaluate(`document.querySelector('[data-dsh-imagegen-view]').innerText.slice(0,200)`)
      const activeNow = await p.selectedLabels('[data-dsh-imagegen-view]')
      rec({ step: 'nav/' + label, ok: true, changed: before !== after,
        activeNow, shot: await shot('m1-nav-' + label.replace(/\s+/g, '')) })
    } catch (e) {
      rec({ step: 'nav/' + label, ok: false, note: String(e.message).slice(0, 200) })
    }
  }

  // 回到普通生图
  await p.clickText('普通生图', '[data-dsh-imagegen-view]')
  await sleep(1500)

  // ---------- 对话开关 / 分栏拖柄 ----------
  const resizer = await p.evaluate(`(()=>{const r=document.querySelector('[data-dsh-imagegen-chat-resizer]');
    if(!r) return null; const b=r.getBoundingClientRect(); return {w:Math.round(b.width),h:Math.round(b.height),role:r.getAttribute('role'),tabindex:r.getAttribute('tabindex')}})()`)
  rec({ step: 'shell/resizer', ok: !!resizer, note: JSON.stringify(resizer) })

  const chatBtn = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-dsh-imagegen-view] button')].find(x=>x.innerText.trim()==='对话');
    return b?{label:b.innerText.trim(),pressed:b.getAttribute('aria-pressed'),active:b.hasAttribute('data-active')}:null})()`)
  rec({ step: 'shell/chat-toggle', ok: !!chatBtn, note: JSON.stringify(chatBtn) })
  if (chatBtn) {
    await p.clickText('对话', '[data-dsh-imagegen-view]')
    await sleep(1200)
    rec({ step: 'shell/chat-toggle-after', ok: true,
      state: await p.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-dsh-imagegen-view] button')].find(x=>x.innerText.trim()==='对话');
        return b?{pressed:b.getAttribute('aria-pressed'),active:b.hasAttribute('data-active')}:null})()`),
      resizer: await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-chat-resizer]')`),
      shot: await shot('m1-chat-toggled') })
    await p.clickText('对话', '[data-dsh-imagegen-view]')
    await sleep(1000)
  }

  // 分栏键盘调整（无障碍 + 边界：最小宽度）
  if (resizer && resizer.role === 'separator') {
    const widths = []
    for (let i = 0; i < 12; i++) {
      await p.evaluate(`document.querySelector('[data-dsh-imagegen-chat-resizer]').focus()`)
      await p.key('ArrowLeft')
      await sleep(120)
    }
    widths.push(await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');return Math.round(v.getBoundingClientRect().width)})()`))
    for (let i = 0; i < 12; i++) {
      await p.evaluate(`document.querySelector('[data-dsh-imagegen-chat-resizer]').focus()`)
      await p.key('ArrowRight')
      await sleep(120)
    }
    widths.push(await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');return Math.round(v.getBoundingClientRect().width)})()`))
    rec({ step: 'shell/resizer-keyboard', ok: widths[0] !== widths[1], widths,
      overflow: await p.docOverflow(), shot: await shot('m1-resizer-max') })
  }

  // ---------- 配置区折叠 ----------
  const collapse = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');
    const b=[...v.querySelectorAll('button')].filter(x=>x.querySelector('svg')&&x.getBoundingClientRect().width<40);
    return b.map(x=>({label:x.getAttribute('aria-label'),title:x.getAttribute('title'),w:Math.round(x.getBoundingClientRect().width),x:Math.round(x.getBoundingClientRect().x)})).slice(0,10)})()`)
  rec({ step: 'shell/config-collapse-buttons', ok: true, note: JSON.stringify(collapse) })

  // ---------- 侧边栏：两页签 + 历史记录 ----------
  const sideTabs = await p.evaluate(`(()=>{const root=document.querySelector('[data-dsh-imagegen-session-tabs]');
    if(!root) return null
    return { text: root.innerText.trim().replace(/\\s+/g,' '),
      items:[...root.querySelectorAll('[data-dsh-imagegen-tab]')].map(e=>({k:e.dataset.dshImagegenTab,
        sel:e.getAttribute('aria-selected'),active:e.hasAttribute('data-active')})) }})()`)
  rec({ step: 'sidebar/tabs-state', ok: !!sideTabs, note: JSON.stringify(sideTabs), shot: await shot('m1-sidebar-history') })

  const hist = await p.evaluate(`(()=>{const h=document.querySelector('[data-dsh-imagegen-history-host]');
    if(!h) return null
    const cards=[...h.querySelectorAll('[class*=card],[class*=item]')].length
    return { text: h.innerText.slice(0,300), cardGuess: cards,
      search: !!h.querySelector('input'),
      selects: [...h.querySelectorAll('select')].map(s=>s.options.length) }})()`)
  rec({ step: 'sidebar/history', ok: !!hist, note: JSON.stringify(hist) })

  // 搜索框：输入后列表是否真的过滤
  const beforeCount = await p.evaluate(`(()=>{const h=document.querySelector('[data-dsh-imagegen-history-host]');
    return h?h.querySelectorAll('button').length:0})()`)
  try {
    await p.type('[data-dsh-imagegen-history-host] input', 'gradient')
    await sleep(900)
    const afterCount = await p.evaluate(`(()=>{const h=document.querySelector('[data-dsh-imagegen-history-host]');
      return {buttons:h.querySelectorAll('button').length, text:h.innerText.slice(0,200)}})()`)
    rec({ step: 'sidebar/search', ok: beforeCount !== afterCount.buttons,
      beforeCount, after: afterCount, shot: await shot('m1-sidebar-search') })
    await p.evaluate(`(()=>{const i=document.querySelector('[data-dsh-imagegen-history-host] input');
      const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await sleep(600)
  } catch (e) {
    rec({ step: 'sidebar/search', ok: false, note: String(e.message).slice(0, 200) })
  }

  // 页签切回「会话」
  try {
    await p.click('[data-dsh-imagegen-tab="session"]')
    await sleep(1500)
    rec({ step: 'sidebar/session-tab', ok: true,
      historyHostVisible: await p.evaluate(`(()=>{const h=document.querySelector('[data-dsh-imagegen-history-host]');
        if(!h) return 'no-host'; const r=h.getBoundingClientRect(); return r.width>0&&r.height>0})()`),
      panelStillMounted: await p.exists('[data-dsh-imagegen-view]'),
      htmlActive: await p.evaluate(`document.documentElement.getAttribute('data-dsh-imagegen-active')`),
      shot: await shot('m1-sidebar-session-tab') })
    await p.click('[data-dsh-imagegen-tab="image"]')
    await sleep(1500)
  } catch (e) {
    rec({ step: 'sidebar/session-tab', ok: false, note: String(e.message).slice(0, 200) })
  }
} catch (e) {
  rec({ step: 'fatal', ok: false, note: String(e.stack).slice(0, 600) })
}

writeFileSync(join(SHOT_DIR, '..', 'm1-shell.json'), JSON.stringify({
  findings: F, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors,
  failedRequests: p.failedRequests.slice(0, 20),
}, null, 2))
console.log('--- console errors ---')
console.log(JSON.stringify(p.consoleErrors.slice(-10), null, 1))
console.log('--- page errors ---', p.pageErrors.length)
p.close(); b.close()

/**
 * 第 1 批：面板外壳 + 文生图模块。
 * 每步截图，并记录该步新增的控制台错误，便于把问题对应到模块。
 */
import { launch, newPage, loginUrl, sleep, SHOT_DIR } from './harness.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const findings = []
const note = (step, shot, extra = {}) => findings.push({ step, shot, ...extra })

const b = await launch()
const p = await newPage(b.port, loginUrl())

async function mark () {
  const before = p.consoleErrors.length
  return () => p.consoleErrors.slice(before)
}

await p.waitFor('[data-dsh-imagegen-tab="image"]', 30000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 15000)
await sleep(3000)

// 内测声明遮挡
const disclaimer = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续');if(!b)return null;const d=b.closest('[role="dialog"],div');return d?d.innerText.slice(0,400):null})()`)
console.log('disclaimer present:', disclaimer !== null)
const shotDisclaimer = await p.shoot('shell-disclaimer')
note('shell', shotDisclaimer, { disclaimer })

if (disclaimer !== null) {
  const stop = await mark()
  await p.clickText('继续')
  await sleep(800)
  note('shell/dismiss', await p.shoot('shell-after-dismiss'), { errors: await stop() })
}

// 外壳：顶栏 + 侧栏 + 对话
await sleep(1500)
const shotShell = await p.shoot('shell-full')
const shellMetrics = await p.evaluate(`(()=>{
  const v=document.querySelector('[data-dsh-imagegen-view]'); const r=v.getBoundingClientRect()
  const header=v.querySelector('header'); const hr=header?header.getBoundingClientRect():null
  return {view:{w:Math.round(r.width),h:Math.round(r.height)},header:hr?{h:Math.round(hr.height)}:null,
    scrollW:v.scrollWidth, clientW:v.clientWidth,
    docOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}
})()`)
note('shell', shotShell, { metrics: shellMetrics })

// 空态/加载态：结果区没有内容时的提示
const resultArea = await p.evaluate(`(()=>{const v=document.querySelector('[data-dsh-imagegen-view]');return v.innerText.includes('还没有')||v.innerText.includes('暂无')?'has-empty-copy':'no-empty-copy'})()`)
note('shell/empty', shotShell, { resultArea })

// 文生图：配置区逐项
const promptSel = 'textarea'
console.log('textarea count:', await p.count('textarea'))
const stop1 = await mark()
await p.type('textarea', '一只戴着宇航员头盔的橘猫坐在月球表面，远处是地球，电影感光线')
await sleep(500)
note('text/prompt', await p.shoot('text-prompt-filled'), { value: await p.evaluate('document.querySelector("textarea").value'), errors: await stop1() })

// 字数计数器
const counter = await p.evaluate(`(()=>{const t=document.querySelector('textarea');const p=t.closest('section,div');return p?p.innerText.slice(0,200):null})()`)
note('text/counter', await p.shoot('text-counter'), { counterBlock: counter })

// 尺寸切换
const stop2 = await mark()
await p.clickText('16:9 宽屏')
await sleep(400)
note('text/ratio', await p.shoot('text-ratio-169'), { selected: await p.evaluate(`[...document.querySelectorAll('button')].filter(b=>b.getAttribute('data-active')!==null||b.getAttribute('aria-pressed')==='true').map(b=>b.innerText.trim()).slice(0,12)`), errors: await stop2() })

// 清晰度 4K
const stop3 = await mark()
await p.clickText('4K')
await sleep(400)
note('text/quality', await p.shoot('text-quality-4k'), { errors: await stop3() })

// 生成数量 4
const stop4 = await mark()
await p.clickText('4 张')
await sleep(400)
note('text/count', await p.shoot('text-count-4'), { errors: await stop4() })

// 细节 高清
const stop5 = await mark()
await p.clickText('高清')
await sleep(400)
note('text/detail', await p.shoot('text-detail-hd'), { errors: await stop5() })

writeFileSync(join(SHOT_DIR, '..', 'batch1.json'), JSON.stringify({ findings, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failedRequests: p.failedRequests }, null, 2))
console.log(JSON.stringify({ findings, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors }, null, 1).slice(0, 4000))
p.close(); b.close()

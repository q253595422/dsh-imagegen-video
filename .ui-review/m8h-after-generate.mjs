/**
 * 第 8 批·H：点「开始生成」之后的去向
 * H1 T+0.4s / 2s / 6s / 12s：任务面板条目数、诊断日志条数、任何错误文本
 * H2 按钮在 1.8s 就恢复可点，是否意味着请求已经失败了却什么也没显示
 */
import { openStudio, sleep } from './boot.mjs'
import { writeFileSync } from 'node:fs'

const R = {}
const rec = (k, v) => { R[k] = v; console.log('·', k, JSON.stringify(v).slice(0, 1000)) }
const press = async (p, x, y, w = 400) => {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(w)
}
const probe = (p) => p.evaluate(`(()=>{
  const t=document.body.innerText.replace(/\\s+/g,' ')
  const gen=[...document.querySelectorAll('button')].find(b=>/开始生成|生成中/.test(b.innerText||''))
  const taskBtn=[...document.querySelectorAll('button')].find(b=>/生成任务/.test(b.innerText||''))
  const cards=[...document.querySelectorAll('[class*=taskCard],[class*=TaskCard],[class*=resultCard],[class*=ResultCard]')]
  const imgs=[...document.querySelectorAll('img')].filter(e=>e.getBoundingClientRect().width>80)
  return {btn:gen?(gen.innerText||'').replace(/\\s+/g,' ').trim():null, dis:gen?gen.disabled:null,
    taskLine:taskBtn?(taskBtn.innerText||'').replace(/\\s+/g,' ').trim():null,
    taskCards:cards.length, bigImgs:imgs.length,
    errMatch:(t.match(/(失败|错误|异常|Error|error|超时|HTTP \\d{3})/g)||[]).slice(0,6),
    lastText:t.slice(-260)}
})()`)

const { page: p, close } = await openStudio({ width: 1600, height: 1000 })
try {
  await p.evaluate(`(()=>{const ta=[...document.querySelectorAll('textarea')].filter(e=>e.getBoundingClientRect().width>200)[0]
    if(!ta) return; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'a red apple on a wooden table')
    ta.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(700)
  rec('h0-before', await probe(p))
  const gen = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/开始生成/.test(e.innerText||''))
    if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  rec('h0-btn', gen)
  if (gen) {
    await press(p, gen.x, gen.y, 400)
    rec('h1-t0.4', await probe(p))
    R['h1-t0.4'].shot = await p.shoot('227-m8h-gen-0.4s')
    await sleep(1600)
    rec('h2-t2', await probe(p))
    R['h2-t2'].shot = await p.shoot('228-m8h-gen-2s')
    await sleep(4000)
    rec('h3-t6', await probe(p))
    R['h3-t6'].shot = await p.shoot('229-m8h-gen-6s')
    await sleep(6000)
    rec('h4-t12', await probe(p))
    R['h4-t12'].shot = await p.shoot('230-m8h-gen-12s')
    // 打开生成任务面板
    const tb = await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/生成任务/.test(e.innerText||''))
      if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    if (tb) { await press(p, tb.x, tb.y, 1400)
      rec('h5-task-panel', await p.evaluate(`(()=>{
        const el=[...document.querySelectorAll('section,[role=region],[class*=panel]')].find(e=>/生成任务/.test(e.innerText||'')&&e.getBoundingClientRect().width>200)
        return {text:el?(el.innerText||'').replace(/\\s+/g,' ').slice(0,400):null}})`))
      R['h5-task-panel'].shot = await p.shoot('231-m8h-task-panel')
    }
  }
  R.pageErrors = p.pageErrors
  R.consoleErrors = (p.consoleErrors || []).slice(-6)
} catch (e) { R.error = String(e && e.stack ? e.stack : e) }
finally { writeFileSync('.ui-review/m8h-after-generate.json', JSON.stringify(R, null, 2)); console.log('--- done'); close() }

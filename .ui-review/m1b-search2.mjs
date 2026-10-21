/**
 * 严格验证侧栏「历史记录」搜索框是否真的过滤。
 * 上一轮的坑：列表是异步加载的，输入时可能还在「暂无历史记录」。
 * 这里先等列表出现，再输入，再逐步判断。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)

// 等列表真的加载出来（有「清空」按钮 = unifiedHistory.length>0）
let loaded = false
for (let i = 0; i < 40; i++) {
  loaded = await p.evaluate(`!!document.querySelector('[data-history-clear]')`)
  if (loaded) break
  await sleep(500)
}
console.log('history loaded:', loaded)

const snapshot = () => p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const i=h.querySelector('input')
  const list=h.querySelector('[class*=historyList]')
  const rows=list?[...list.children]:[]
  return {
    value:i.value,
    rowCount:rows.length,
    prompts:rows.map(r=>{
      const t=r.innerText.replace(/\\s+/g,' ').trim()
      return t.slice(0,60)
    }),
    emptyText:h.innerText.includes('暂无历史记录'),
  }
})()`)

const before = await snapshot()
console.log('BEFORE', JSON.stringify(before, null, 1))

// 真实点击 + 逐字符键入
const box = await p.info('[data-dsh-imagegen-history-host] input')
const cx = box.x + box.w / 2, cy = box.y + box.h / 2
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
await sleep(200)

for (const ch of 'gradient') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  await sleep(80)
}
await sleep(1200)

const after = await snapshot()
console.log('AFTER gradient', JSON.stringify(after, null, 1))
console.log('filtered?', before.rowCount, '->', after.rowCount)
console.log('shot:', await p.shoot('m1b-search-verified'))

// 清空再试一个不存在的词，看空态
await p.evaluate(`(()=>{const i=document.querySelector('[data-dsh-imagegen-history-host] input');i.focus();i.select()})()`)
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 })
for (const ch of 'zzzzz') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  await sleep(60)
}
await sleep(1000)
console.log('AFTER zzzzz', JSON.stringify(await snapshot(), null, 1))
console.log('shot:', await p.shoot('m1b-search-noresult'))

p.close(); b.close()
setTimeout(() => process.exit(0), 500)

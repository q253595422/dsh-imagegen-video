/**
 * 用真实输入轨迹验证「历史记录搜索框」：
 * 1) CDP 点击输入框 → Input.insertText 输入；2) 读 value 与列表条数；
 * 3) 再补发 Input.dispatchKeyEvent 的字符，覆盖 insertText 不被接受的情况。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await sleep(3500)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
await sleep(1000)

const stats = () => p.evaluate(`(()=>{
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const i=h.querySelector('input')
  return {value:i.value, buttons:h.querySelectorAll('button').length,
    // 历史条目：每条都有一个「…」按钮或四宫格图标组，用 role=listitem 兜底
    items:h.querySelectorAll('[role=listitem],li').length,
    text:h.innerText.replace(/\\s+/g,' ').slice(0,120)}
})()`)

console.log('BEFORE', JSON.stringify(await stats()))

// 真实点击输入框
const box = await p.info('[data-dsh-imagegen-history-host] input')
const cx = box.x + box.w / 2; const cy = box.y + box.h / 2
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
await sleep(300)
console.log('FOCUSED', JSON.stringify(await p.evaluate(`document.activeElement===document.querySelector('[data-dsh-imagegen-history-host] input')`)))

// 逐字符走真实键盘事件
for (const ch of 'gradient') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  await sleep(60)
}
await sleep(900)
console.log('AFTER-TYPING', JSON.stringify(await stats()))
console.log('shot:', await p.shoot('m1b-search-typed'))

// 再试 insertText（对照组）
await p.evaluate(`(()=>{const i=document.querySelector('[data-dsh-imagegen-history-host] input'); i.focus(); i.select()})()`)
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 })
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 })
await sleep(200)
await p.send('Input.insertText', { text: 'sunrise' })
await sleep(900)
console.log('AFTER-INSERTTEXT', JSON.stringify(await stats()))
console.log('shot:', await p.shoot('m1b-search-inserttext'))

p.close(); b.close()
setTimeout(() => process.exit(0), 500)

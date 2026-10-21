/**
 * 判断侧栏历史搜索框的 React 受控链路是否断了：
 * 1) 从 DOM 上取 fiber props，看 onChange 是否存在、指向哪个函数；
 * 2) 真实键入后，比较 props.value（上次渲染的快照）和 DOM value；
 * 3) 再用同样的真实键入打主面板 textarea，确认这不是「整个页面都收不到输入」。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())
await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)
await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
for (let i = 0; i < 40; i++) { if (await p.evaluate(`!!document.querySelector('[data-history-clear]')`)) break; await sleep(400) }

console.log('FIBER', JSON.stringify(await p.evaluate(`(()=>{
  const i=document.querySelector('[data-dsh-imagegen-history-host] input')
  if(!i) return 'no-input'
  const key=Object.keys(i).find(k=>k.startsWith('__reactProps$'))
  const fkey=Object.keys(i).find(k=>k.startsWith('__reactFiber$'))
  const props=key?i[key]:null
  return {hasPropsKey:!!key, hasFiberKey:!!fkey,
    propKeys:props?Object.keys(props):null,
    hasOnChange:!!(props&&props.onChange),
    onChangeType:props&&typeof props.onChange,
    propValue:props?props.value:null,
    domValue:i.value,
    placeholder:props?props.placeholder:null}
})()`), null, 1))

// 真实键入
const box = await p.info('[data-dsh-imagegen-history-host] input')
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.w / 2, y: box.y + box.h / 2, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.w / 2, y: box.y + box.h / 2, button: 'left', clickCount: 1 })
await sleep(150)
for (const ch of 'grad') {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  await sleep(70)
}
await sleep(1000)

console.log('AFTER', JSON.stringify(await p.evaluate(`(()=>{
  const i=document.querySelector('[data-dsh-imagegen-history-host] input')
  const props=i[Object.keys(i).find(k=>k.startsWith('__reactProps$'))]
  const h=document.querySelector('[data-dsh-imagegen-history-host]')
  const list=h.querySelector('[class*=historyList]')
  return {domValue:i.value, renderedPropsValue:props?props.value:null,
    rows:list?list.children.length:0,
    // 列表里还有没有不含 grad 的行
    firstRow:list&&list.children[0]?list.children[0].innerText.replace(/\\s+/g,' ').slice(0,50):null}
})()`), null, 1))

// 对照：主面板提示词 textarea 真实键入
const ta = await p.info('[data-dsh-imagegen-view] textarea')
if (ta) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ta.x + 40, y: ta.y + 20, button: 'left', clickCount: 1 })
  await sleep(150)
  for (const ch of 'hello') {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(70)
  }
  await sleep(700)
  console.log('TEXTAREA', JSON.stringify(await p.evaluate(`(()=>{
    const t=document.querySelector('[data-dsh-imagegen-view] textarea')
    return {value:t.value, len:t.value.length}
  })()`)))
}
console.log('shot:', await p.shoot('m1c-search-fiber'))
p.close(); b.close()
setTimeout(() => process.exit(0), 500)

/**
 * 宿主「内测声明」浮层的实测：
 * 1) 它什么时候出现、是不是 role=dialog、有没有遮罩；
 * 2) 它显示时点「开始生成」能不能穿透；
 * 3) 点「继续」到底关不关得掉（真实鼠标事件，不用 element.click()）。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

const b = await launch()
const p = await newPage(b.port, loginUrl())

await p.waitFor('[data-dsh-imagegen-tab="image"]', 40000)
await p.click('[data-dsh-imagegen-tab="image"]')
await p.waitFor('[data-dsh-imagegen-view]', 20000)

// 等弹窗出现（宿主的 onboarding 弹窗在面板挂载后才渲染）
let found = null
for (let i = 0; i < 60; i++) {
  found = await p.evaluate(`(()=>{
    const btn=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')
    if(!btn) return null
    const r=btn.getBoundingClientRect()
    const layer=btn.closest('[role="dialog"],[class*=dialog],[class*=modal]')
    const lr=layer?layer.getBoundingClientRect():null
    return {
      btn:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      layer:{tag:layer?layer.tagName:null, role:layer?layer.getAttribute('role'):null,
        x:lr?Math.round(lr.x):null,y:lr?Math.round(lr.y):null,w:lr?Math.round(lr.w||lr.width):null,h:lr?Math.round(lr.height):null},
      // 面板里有没有遮罩（半透明黑幕）
      dimmers:[...document.querySelectorAll('body *')].filter(e=>{
        const cs=getComputedStyle(e); const rr=e.getBoundingClientRect()
        return rr.width>800&&rr.height>600&&cs.position==='fixed'&&cs.backgroundColor!=='rgba(0, 0, 0, 0)'&&cs.backgroundColor!=='transparent'
          &&parseFloat(cs.backgroundColor.split(',')[3]||'0')>=0||false
      }).slice(0,3).map(e=>getComputedStyle(e).backgroundColor),
      genBtn:(()=>{const g=[...document.querySelectorAll('[data-dsh-imagegen-view] button')].find(x=>x.innerText.trim()==='开始生成');
        if(!g) return null; const gr=g.getBoundingClientRect()
        return {x:Math.round(gr.x),y:Math.round(gr.y),disabled:g.hasAttribute('disabled')}})(),
    }
  })()`)
  if (found) break
  await sleep(500)
}

console.log('disclaimer:', JSON.stringify(found, null, 1))
if (!found) { p.close(); b.close(); process.exit(0) }

await p.shoot('diag-disclaimer-noshade')

// 弹窗显示时，「开始生成」按钮在不在弹窗下面
const hitTest = await p.evaluate(`(()=>{
  const g=[...document.querySelectorAll('[data-dsh-imagegen-view] button')].find(x=>x.innerText.trim()==='开始生成')
  if(!g) return null
  const r=g.getBoundingClientRect()
  const top=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)
  return { genAt:{x:Math.round(r.x),y:Math.round(r.y)}, top:top?top.tagName+'|'+(top.innerText||'').trim().slice(0,20):null,
    topIsGen: !!(top&&(top===g||g.contains(top))) }
})()`)
console.log('hit-test while disclaimer shown:', JSON.stringify(hitTest))

// 真实鼠标点「继续」
const bx = found.btn.x + found.btn.w / 2
const by = found.btn.y + found.btn.h / 2
await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by })
await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 })
await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 })
await sleep(1500)

const after = await p.evaluate(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')
  return { stillThere: !!btn, bodyHasText: document.body.innerText.includes('内测声明') }
})()`)
console.log('after real mouse click:', JSON.stringify(after))
console.log('shot:', await p.shoot('diag-disclaimer-after-real-click'))
console.log('console:', JSON.stringify(p.consoleErrors.slice(-5)))
p.close(); b.close()

/**
 * 各批共用的启动流程。评审实例重启后会停在「选择工作区」，插件虽已加载但面板不挂载，
 * 需要先选一个工作区、开一个会话，再点左侧「生图」才能进到插件界面。
 * 失败时抛错并附上当前页面文字，方便区分「宿主没就绪」和「插件坏了」。
 */
import { launch, newPage, loginUrl, sleep } from './harness.mjs'

/** 点一个可见文字精确匹配的按钮，返回是否点到。不抛错——调用方要按「没这个选项」继续走。 */
async function tapText (p, text) {
  const r = await p.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,a,[role=tab],[role=button],div[tabindex],li')]
    const hit=els.find(e=>e.innerText && e.innerText.trim()===${JSON.stringify(text)})
    if(!hit) return null
    const rc=hit.getBoundingClientRect()
    if(rc.width===0||rc.height===0) return null
    return {x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2)}
  })()`)
  if (!r) return false
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(800)
  return true
}

/**
 * 打开插件面板并返回 page 对象。
 * @param {object} opts
 * @param {string} opts.workspace 左侧栏工作区名，默认 chajian（本插件的仓库就在它下面）
 * @param {number} opts.width / opts.height 视口尺寸
 */
export async function openStudio ({ workspace = 'chajian', width = 1600, height = 1000 } = {}) {
  const b = await launch({ width, height })
  const p = await newPage(b.port, loginUrl(), { width, height })

  // 插件加载是异步的：先等宿主把插件列表加载完，否则 tab 还不存在。
  for (let i = 0; i < 100; i++) {
    const ready = await p.evaluate(`(()=>{
      const t=document.body.innerText||''
      return !/Loading plugins/.test(t) && (!!document.querySelector('[data-dsh-imagegen-tab="image"]') || /选择工作区|新会话/.test(t))
    })()`)
    if (ready) break
    await sleep(300)
  }

  // 有会话才挂面板。先选工作区，再开一个新会话。
  if (!(await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-view]')`))) {
    const pickedWs = await tapText(p, workspace)
    await sleep(1200)
    const newSession = (await tapText(p, '新会话')) || (await tapText(p, '选择工作区'))
    await sleep(2000)
    if (!(await p.evaluate(`!!document.querySelector('[data-dsh-imagegen-tab="image"]')`))) {
      // 兜底：有的版本工作区是直接点路径名进会话的
      await tapText(p, workspace)
      await sleep(1500)
    }
    p.bootNote = { pickedWs, newSession }
  }

  const hasTab = await p.waitFor('[data-dsh-imagegen-tab="image"]', 30000)
  if (!hasTab) {
    const body = await p.evaluate(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`)
    p.close(); b.close()
    throw new Error('boot: 插件 tab 没出现，页面写着：' + body)
  }
  await p.click('[data-dsh-imagegen-tab="image"]')
  const hasView = await p.waitFor('[data-dsh-imagegen-view]', 20000)
  if (!hasView) {
    const body = await p.evaluate(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`)
    p.close(); b.close()
    throw new Error('boot: 面板没挂载，页面写着：' + body)
  }
  // 内测声明弹窗（首次进入会出现）
  await p.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b) b.click()})()`)
  await sleep(1800)
  return { browser: b, page: p, close: () => { try { p.close() } catch {} ; try { b.close() } catch {} } }
}

export { sleep }

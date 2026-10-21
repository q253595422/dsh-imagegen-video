/**
 * 评审用 CDP 驱动：登录评审实例、截图、按选择器驱动、收集控制台错误。
 * Chrome 155 在本机不写 DevToolsActivePort（--remote-debugging-port=0 失效），
 * 所以这里用「先占一个空闲端口再显式传参」的方式启动。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const SHOT_DIR = new URL('./shots/', import.meta.url).pathname

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function freePort () {
  return await new Promise(resolve => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

export async function launch ({ width = 1600, height = 1000 } = {}) {
  const port = await freePort()
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ui-review-'))
  const browser = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  browser.stderr.on('data', c => { if (log.length < 20000) log += String(c) })

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) break
    } catch {}
    if (browser.exitCode !== null) break
    await sleep(200)
  }
  mkdirSync(SHOT_DIR, { recursive: true })
  return { port, browser, profileDir, log: () => log, close: () => { try { browser.kill() } catch {} } }
}

/** 建一个页面并接上 CDP；返回驱动对象。 */
export async function newPage (port, url, { width = 1600, height = 1000 } = {}) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  const consoleErrors = []
  const pageErrors = []
  const failedRequests = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleErrors.push({
        type: msg.params.type,
        text: (msg.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 500),
      })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push((msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 500))
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push({ url: msg.params.requestId, error: msg.params.errorText })
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      failedRequests.push({ url: msg.params.response.url, status: msg.params.response.status })
    }
  }
  const send = (method, params = {}) => new Promise(resolve => {
    const myId = ++id
    pending.set(myId, { resolve })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error('eval threw: ' + (d.exception?.description ?? d.text))
    }
    return r.result?.result?.value
  }

  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.enable')
  await send('Page.navigate', { url })
  await sleep(1500)

  // 截图编号全局递增：多个批次脚本共用 shots 目录，从 01 重数会互相覆盖。
  let shotIndex = (() => {
    try {
      const nums = readdirSync(SHOT_DIR).map(f => parseInt(f, 10)).filter(n => Number.isFinite(n))
      return nums.length ? Math.max(...nums) : 0
    } catch { return 0 }
  })()
  let vw = width; let vh = height
  const page = {
    send, evaluate, consoleErrors, pageErrors, failedRequests,
    sleep,
    url: () => evaluate('location.href'),
    text: sel => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:null})()`),
    count: sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    exists: async sel => (await evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`)) > 0,
    /** 等选择器出现；返回是否等到。宿主外壳与插件都是异步挂载的，固定 sleep 会抢跑。 */
    waitFor: async (sel, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await page.exists(sel)) return true
        await sleep(250)
      }
      return false
    },
    click: async (sel, { timeoutMs = 20000 } = {}) => {
      if (!(await page.waitFor(sel, timeoutMs))) throw new Error('click: not found ' + sel)
      const ok = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`)
      if (!ok) throw new Error('click: not found ' + sel)
      await sleep(400)
    },
    /** 按可见文字点击（button/a/[role=tab] 等）；找不到时把相近的候选打出来，避免瞎猜。 */
    clickText: async (text, root = 'body') => {
      const ok = await evaluate(`(()=>{
        const root=document.querySelector(${JSON.stringify(root)}); if(!root) return false
        const els=[...root.querySelectorAll('button,a,[role=tab],[role=button],li,div[tabindex]')]
        const hit=els.find(e=>e.innerText && e.innerText.trim()===${JSON.stringify(text)})
        if(!hit) return false
        hit.scrollIntoView({block:'center'}); hit.click(); return true
      })()`)
      if (!ok) {
        const near = await evaluate(`(()=>[...document.querySelectorAll('button,a,[role=button],li')]
          .filter(e=>e.innerText && e.innerText.includes(${JSON.stringify(text)}))
          .slice(0,8).map(e=>e.tagName+'『'+e.innerText.trim().slice(0,30)+'』').join(' | '))()`)
        throw new Error(`clickText: not found 「${text}」; near: ${near}`)
      }
      await sleep(400)
    },
    /**
     * 填入文本。React 受控组件会接管 value 的 setter，Input.insertText 对它不生效，
     * 必须走原型上的 native setter 再自己派发 input 事件。
     * 返回写入后元素的真实 value，便于断言「确实写进去了」。
     */
    type: async (sel, value) => {
      if (!(await page.waitFor(sel, 10000))) throw new Error('type: not found ' + sel)
      const r = await evaluate(`(()=>{
        const e=document.querySelector(${JSON.stringify(sel)})
        if(!e) return 'no-element'
        e.focus()
        const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement
          : e instanceof HTMLInputElement ? HTMLInputElement : null
        const setter = proto && Object.getOwnPropertyDescriptor(proto,'value').set
        if(!setter) return 'no-native-setter:'+e.tagName
        setter.call(e, ${JSON.stringify(value)})
        e.dispatchEvent(new Event('input',{bubbles:true}))
        e.dispatchEvent(new Event('change',{bubbles:true}))
        return 'ok'
      })()`)
      if (r !== 'ok') throw new Error('type failed: ' + r)
      await sleep(300)
      return evaluate(`document.querySelector(${JSON.stringify(sel)}).value`)
    },
    /** 读某个元素的属性，用于断言选中态。 */
    attr: (sel, name) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.getAttribute(${JSON.stringify(name)}):null})()`),
    /**
     * 读出当前所有处于选中态的按钮/页签。
     * 这个仓库的控件用 data-active，少数用 aria-selected / aria-pressed，三者都要认。
     */
    selectedLabels: (root = 'body') => evaluate(`(()=>{
      const r=document.querySelector(${JSON.stringify(root)})||document.body
      return [...r.querySelectorAll('button,[role=tab],[role=radio],[role=option]')]
        .filter(b=>b.hasAttribute('data-active')||b.getAttribute('aria-selected')==='true'||b.getAttribute('aria-pressed')==='true')
        .map(b=>b.innerText.trim().replace(/\s+/g,' ').slice(0,20))
    })()`),
    /** 元素的结构快照：矩形、可见性、禁用态、文本，用于把截图里的位置和 DOM 对上。 */
    info: sel => evaluate(`(()=>{
      const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
      const r=e.getBoundingClientRect(); const cs=getComputedStyle(e)
      return { tag:e.tagName, text:(e.innerText||'').trim().slice(0,60),
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
        visible:r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none',
        disabled:e.hasAttribute('disabled')||e.getAttribute('aria-disabled')==='true',
        overflowX:cs.overflowX, color:cs.color, fontSize:cs.fontSize }
    })()`),
    /** 页面上是否有横向溢出（边界情况：窄窗口、超长文案）。 */
    docOverflow: () => evaluate(`({ scrollW:document.documentElement.scrollWidth,
      clientW:document.documentElement.clientWidth,
      bodyScrollW:document.body.scrollWidth })`),
    key: async key => {
      const map = { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 }
      const code = map[key] ?? 0
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
      await sleep(200)
    },
    /** 视口尺寸；窄宽度边界情况要在这里切，而不是重开浏览器。 */
    setViewport: async (w, h) => {
      vw = w; vh = h
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      await sleep(400)
    },
    /** 截图并存成带序号的文件，返回相对路径。 */
    shoot: async (label, { fullPage = false } = {}) => {
      const params = { format: 'png' }
      if (fullPage) {
        const m = await send('Page.getLayoutMetrics')
        const h = Math.ceil(m.result.contentSize.height)
        const w = Math.ceil(m.result.contentSize.width)
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
        await sleep(300)
      }
      const r = await send('Page.captureScreenshot', params)
      if (fullPage) {
        await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false })
        await sleep(200)
      }
      shotIndex += 1
      const name = `${String(shotIndex).padStart(2, '0')}-${label.replace(/[^\w\u4e00-\u9fa5-]+/g, '-')}.png`
      writeFileSync(join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
      return name
    },
    close: () => { try { ws.close() } catch {} },
  }
  return page
}

export function readToken () {
  const log = readFileSync('/tmp/dsh-uireview/server.log', 'utf8')
  const token = /token=([A-Za-z0-9_%.-]+)/.exec(log)?.[1]
  if (!token) throw new Error('server.log 里没有 token')
  return token
}

export const BASE = 'http://127.0.0.1:4790'

export function loginUrl () {
  return `${BASE}/?token=${readToken()}`
}

export { sleep }

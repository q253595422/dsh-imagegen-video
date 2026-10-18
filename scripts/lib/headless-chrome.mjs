/**
 * One honest way to start a headless Chromium for the browser guards.
 *
 * The three guards (verify-ui-contracts, verify-video-layout, verify-frame-grab)
 * each used to pick a DevTools port out of a hand-rolled random range and poll
 * `/json/version` until it answered. That is a coin flip whenever two runs share
 * a machine: the loser either never binds the port or — worse — finds the OTHER
 * Chrome answering, so the assertions run against a blank `about:blank` target
 * and the failure surfaces as an unrelated contract turning green.
 *
 * Here the browser picks the port itself (`--remote-debugging-port=0`) and
 * publishes it in `<user-data-dir>/DevToolsActivePort`. Reading that file is the
 * documented handshake, and it cannot be confused with a neighbour's browser.
 *
 * A fresh profile directory per launch is mandatory, not tidiness: Chrome reuses
 * a leftover `DevToolsActivePort` from an old profile and then listens on a port
 * nobody is polling.
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Find a Chromium binary, honouring the same two knobs every guard documents:
 * the first CLI argument and `CHROME_HEADLESS_SHELL`.
 * @param {readonly string[]} [argv] - process.argv-like list.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string | null} an existing binary path, or null when none is found.
 */
export function findChrome (argv = process.argv, env = process.env) {
  const explicit = argv[2] ?? env.CHROME_HEADLESS_SHELL
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : null
  const candidates = [
    // Both spellings of the temp root: on macOS `os.tmpdir()` is the per-user
    // /var/folders/... directory, while the tooling that downloads a bundled
    // shell usually unpacks it under the literal /tmp. Checking only one of
    // them silently misses the shell on one of the two platforms.
    ...globSync('/tmp/chromium/chrome-headless-shell/*/*/chrome-headless-shell').sort().reverse(),
    ...globSync(`${tmpdir()}/chromium/chrome-headless-shell/*/*/chrome-headless-shell`).sort().reverse(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...globSync(`${env.HOME ?? ''}/.cache/puppeteer/**/chrome-headless-shell`).sort().reverse(),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Print the loud skip block and exit 0 when no browser exists.
 * A missing tool is not a failing contract; a silent pass is.
 * @param {string} noBrowserMessage - what these particular guards cover.
 * @returns {never}
 */
export function skipWithoutChrome (noBrowserMessage) {
  console.error('\n' + '='.repeat(72))
  console.error(`SKIP: no headless Chromium found -- ${noBrowserMessage}`)
  console.error('This is a MISSING TOOL, not a regression. Install chrome-headless-shell,')
  console.error('or point CHROME_HEADLESS_SHELL at a Chromium binary, to gate on these.')
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}

/**
 * Launch a headless Chromium and wait until its DevTools endpoint answers.
 * @param {object} options
 * @param {string} options.chrome - binary to run.
 * @param {string} options.name - profile-directory prefix, so a stray leftover
 *   is identifiable in `$TMPDIR`.
 * @param {readonly string[]} [options.args] - extra Chromium flags.
 * @returns {Promise<{port: number, browser: import('node:child_process').ChildProcess, profileDir: string, close: () => void}>}
 * @throws when the browser exits, publishes no port, or never answers.
 */
export async function launchChrome ({ chrome, name, args = [] }) {
  const profileDir = mkdtempSync(join(tmpdir(), `${name}-profile-`))
  const browser = spawn(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    ...args,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let browserLog = ''
  browser.stderr?.on('data', chunk => {
    if (browserLog.length < 4_000) browserLog += String(chunk)
  })

  const cleanup = () => {
    try { browser.kill() } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }

  const portFile = join(profileDir, 'DevToolsActivePort')
  let port = 0
  for (let i = 0; i < 120; i++) {
    // A browser that already exited will never publish a port; waiting out the
    // full deadline only delays the diagnosis.
    if (browser.exitCode !== null) break
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first) && Number(first) > 0) { port = Number(first); break }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  if (port === 0) {
    cleanup()
    throw new Error(`headless Chromium published no DevTools port `
      + `(chrome exitCode=${String(browser.exitCode)})\n${browserLog.trim() || '(no browser output)'}`)
  }

  let lastError
  for (let i = 0; i < 60; i++) {
    if (browser.exitCode !== null) break
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return { port, browser, profileDir, close: cleanup }
    } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  cleanup()
  throw new Error(`DevTools port ${port} never answered `
    + `(chrome exitCode=${String(browser.exitCode)}): ${lastError?.message ?? 'no response'}`
    + `\n${browserLog.trim() || '(no browser output)'}`)
}

/**
 * Open a new page target and return a CDP session bound to it.
 * @param {number} port - DevTools port from {@link launchChrome}.
 * @param {string} url - page to open.
 * @returns {Promise<{send: (method: string, params?: object) => Promise<any>, evaluate: (expression: string) => Promise<any>, close: () => void}>}
 */
export async function openPage (port, url) {
  const target = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  )).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => { ws.onopen = resolve })

  let id = 0
  const send = (method, params = {}) => new Promise(resolve => {
    const myId = ++id
    const onMessage = event => {
      const message = JSON.parse(event.data)
      if (message.id === myId) {
        ws.removeEventListener('message', onMessage)
        resolve(message)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.result?.exceptionDetails !== undefined) {
      throw new Error(`page threw: ${JSON.stringify(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails)}`)
    }
    return response.result.result.value
  }

  await send('Runtime.enable', {})
  return { send, evaluate, close: () => { try { ws.close() } catch {} } }
}

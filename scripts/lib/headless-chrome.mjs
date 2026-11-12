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
import { basename, join } from 'node:path'

/**
 * Resolve a bare command name the way the shell would, using only the PATH in
 * the environment handed in.
 *
 * WHY not `which`: that spawns a process and consults the *current* PATH, which
 * is neither the environment this function was given nor available on every
 * Windows machine. Splitting PATH here keeps `findChrome()` pure and testable.
 *
 * @param {string} name - e.g. `google-chrome`.
 * @param {NodeJS.ProcessEnv} env - environment whose PATH is searched.
 * @returns {string | null} the first executable match, or null.
 */
function resolveOnPath (name, env) {
  const raw = env.PATH ?? env.Path ?? ''
  if (raw === '') return null
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of raw.split(process.platform === 'win32' ? ';' : ':')) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

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
    // Linux. Without these every browser guard skipped on CI, which is Ubuntu
    // -- and a skip exits 0, so four guards sat green while never running:
    //   SKIP: no headless Chromium found -- the UI contract guards did NOT run.
    // Found in a real CI log (run 43166516751). The runner image ships Chrome
    // and Chromium, but not where the macOS-centric list looked, so a fixed
    // path list alone is still a guess: `resolveOnPath` asks the system what
    // the command actually resolves to, which survives an image move.
    ...globSync('/opt/google/chrome/chrome').sort().reverse(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
      .map(name => resolveOnPath(name, env))
      .filter(path => path !== null),

    // Windows. Without these the browser guards skipped on every Windows
    // machine -- and a skip is not a pass, but it also never fails, so the
    // contracts simply never ran there. Installed browsers come first because
    // they are what a Windows user actually has; a bundled headless shell is
    // the fallback for whoever downloads one.
    ...WINDOWS_CHROME_PATHS.flatMap(([variable, suffix]) => {
      const base = env[variable]
      return base === undefined || base === '' ? [] : [`${base}\\${suffix}`]
    }),
    ...globSync(`${env.LOCALAPPDATA ?? ''}/Chromium/**/chrome.exe`).sort().reverse(),
    ...globSync(`${env.LOCALAPPDATA ?? ''}/ms-playwright/**/chrome.exe`).sort().reverse(),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Where an installed Chrome, Edge or Chromium lives on Windows.
 *
 * Kept as (environment variable, path below it) pairs rather than assembled
 * literals: `%ProgramFiles%` is `C:\Program Files` on one machine and a
 * different drive on the next, and `%ProgramFiles(x86)%` cannot even be
 * written as a plain identifier in some shells. The variable name is looked up
 * in the environment passed in, so this list stays testable.
 */
const WINDOWS_CHROME_PATHS = [
  ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES', 'Chromium\\Application\\chrome.exe'],
]

/**
 * Print the loud skip block and exit 0 when no browser exists — EXCEPT in CI,
 * where it exits 1 instead.
 *
 * WHY the exception: a skip is right on a developer machine (no browser, the
 * contract is not wrong) but it is a hole in CI. These guards sat green on every
 * push for as long as they existed, printing "SKIP: ... the UI contract guards
 * did NOT run" into a log nobody read, because CI only judges the exit code
 * (measured: run 43166516751, `UI CONTRACTS VERIFIED` absent from the log). The
 * fix that found the Linux binary is in `findChrome`; this is the guard that
 * stops the hole reopening the next time a runner image moves the browser.
 *
 * `GITHUB_ACTIONS` is what separates "a run whose colour people trust" from "a
 * run on someone's machine". `CI` alone is too broad: this developer shell has
 * `CI=1` set for unrelated tooling, and failing a local run that simply lacks a
 * browser would train people to export CHROME_HEADLESS_SHELL to a dummy path.
 * The gap being closed is specifically a green CI run that proved nothing, so
 * the check keys on the CI that gates pushes.
 *
 * @param {string} noBrowserMessage - what these particular guards cover.
 * @returns {never}
 */
export function skipWithoutChrome (noBrowserMessage) {
  const inCi = (process.env.GITHUB_ACTIONS ?? '') === 'true'
  console.error('\n' + '='.repeat(72))
  console.error(`${inCi ? 'FAIL' : 'SKIP'}: no headless Chromium found -- ${noBrowserMessage}`)
  console.error(inCi
    ? 'CI has no browser, so these guards cannot be skipped without leaving a hole:'
    : 'This is a MISSING TOOL, not a regression. Install chrome-headless-shell,')
  console.error(inCi
    ? 'a green run would mean the contracts were never checked. Install a browser'
    : 'or point CHROME_HEADLESS_SHELL at a Chromium binary, to gate on these.')
  console.error(inCi
    ? 'in CI (or set CHROME_HEADLESS_SHELL) instead of accepting this skip.'
    : '')
  console.error('='.repeat(72) + '\n')
  process.exit(inCi ? 1 : 0)
}

/**
 * The flags that make a given binary run headless.
 *
 * Two kinds of binary answer here and they do not take the same flag.
 * `chrome-headless-shell` is a purpose-built headless build: it is headless with
 * no flag at all, and it does not understand `--headless=new`. A full Chrome,
 * Edge or Chromium needs to be told, and on current versions the old
 * `--headless` means the deprecated implementation while `--headless=new` is the
 * real one.
 *
 * Decided from the executable's name rather than from how `findChrome()` found
 * it, so every caller keeps passing a plain path string and none of them has to
 * know this distinction exists.
 * @param {string} chrome - the binary about to be launched.
 * @returns {readonly string[]} flags to put before the rest of the command line.
 */
function headlessFlags (chrome) {
  return /chrome-headless-shell/i.test(basename(chrome)) ? [] : ['--headless=new']
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
    ...headlessFlags(chrome),
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

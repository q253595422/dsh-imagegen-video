/**
 * Standalone smoke test for the built @q253595422/dsh-imagegen-video artifacts:
 *
 *  A. host half loads and exposes the plugin contract
 *  B. generate engine works against a mock OpenAI-compatible upstream
 *     (text mode with b64_json, edit mode with multipart + url result)
 *  C. route handlers (settings bridge + generate) work over real HTTP
 *  D. client bundle registers via window.__ModuleLoader__ and the factory
 *     exposes apply/inject with the right shape
 *
 * Run: node scripts/smoke.mjs   (from the package root)
 */
import { createServer, request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const results = []
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
/**
 * Run one check under a hard per-check deadline; async-aware and sequential so
 * nothing races the servers.
 *
 * WHY the deadline: a check that never settles — a mock upstream that accepts
 * the socket and never answers, a React effect that stops flushing under jsdom
 * — would otherwise hang the whole suite with no line naming it, so the run
 * looks like a job that never finished instead of a failing check. The sibling
 * suites (smoke-video, smoke-canvas-video, smoke-video-picker, smoke-compose)
 * all bound each check the same way; this one used to be the exception.
 *
 * The deadline only decides when a check is DECLARED failed — it never changes
 * what any check asserts.
 */
async function check(name, fn, timeoutMs = 60_000) {
  // Progress goes to stderr so a hung check is identifiable from the log alone.
  process.stderr.write(`... ${name}\n`)
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

/** Wait for React/jsdom state to settle without relying on a fixed delay. */
async function waitForSelector(root, selector, timeout = 1200) {
  const deadline = Date.now() + timeout
  while (root.querySelector(selector) === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(root.querySelector(selector) !== null, `selector did not render: ${selector}`)
}

/** Wait for async fixture data to reach the rendered list, not just its host. */
async function waitForSelectorCount(root, selector, count, timeout = 1200) {
  const deadline = Date.now() + timeout
  while (root.querySelectorAll(selector).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(root.querySelectorAll(selector).length >= count, `expected ${count} matches: ${selector}`)
}

/** Wait until a synchronous predicate becomes true. */
async function waitUntil(predicate, timeout = 1200) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

// ---------------------------------------------------------------- A. host half
/**
 * Point the plugin's data root at a scratch dir so the suite never touches the
 * real ~/.dsh. `DSH_HOME` is read when the module resolves its storage path and
 * when the canvas store resolves its root, so it must be set before the host
 * half is imported — the sibling suites (smoke-video, smoke-canvas-video,
 * smoke-compose) all do this.
 *
 * Without it the canvas/skill checks fell through to the real
 * ~/.dsh/dsh-imagegen/canvas: `makeRoutes` injects no `canvas` backend, so the
 * route used the real store, whose foreign index made `create` return an
 * unexpected document and every dependent check fail on `.id` / `.background` —
 * and the run wrote its fixtures into that real directory.
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-'))
const host = await import(new URL('lib/index.js', root).href)
const hostLocale = await import(new URL('lib/locale-tables.js', root).href)
// The host half renders skill copy through the same dictionaries the browser
// bundle ships; wire that resolver here so the copy assertions see real text.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'zh')

await check('A1 host exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.name, 'imagegen')
  assert.deepEqual(host.inject, ['webServer', 'systemPrompt', 'commands'])
  assert.equal(typeof host.Config, 'function')
  assert.equal(typeof host.ImageGenSettingsNamespace, 'string') // branded at runtime as string
  assert.equal(typeof host.makeRoutes, 'function')
  assert.equal(typeof host.SubscriptionManager, 'function')
  assert.equal(host.subscriptionOauthRef('codex'), 'DSH_IMAGEGEN_CODEX_OAUTH_1')
  assert.equal(host.subscriptionOauthRef('openrouter'), 'DSH_IMAGEGEN_OPENROUTER_OAUTH_1')
  assert.equal(typeof host.generateImage, 'function')
})
await check('A1b Git dependency prepare hook builds distributable artifacts', () => {
  assert.equal(packageJson.scripts.prepare, 'tsdown')
})

/**
 * Windows has to find its own ffmpeg, and the rules that make that work are the
 * ones a POSIX machine never exercises. So the lookup takes the platform and
 * the environment as arguments: a scratch directory and a fake `PATH` are enough
 * to prove, on macOS, that a Windows install is discoverable at all.
 *
 * What each assertion is guarding:
 *  - `.exe` — every Windows installer writes `ffmpeg.exe`, and joining the bare
 *    name is a lookup that can never match. This was the P0 in issue #15: a
 *    correctly installed ffmpeg was invisible to the whole video pipeline.
 *  - `PATH` — winget, scoop and the official zip all install by appending a
 *    directory to the system PATH. The old candidate list held four POSIX
 *    directories, none of which exist on Windows, so PATH was the only answer
 *    and it was not consulted.
 *  - the execute bit — `X_OK` is emulated on Windows on top of the read-only
 *    attribute and says nothing about whether a file can run, so a Windows
 *    lookup must accept a plain regular file.
 *  - the override — `FFMPEG_PATH` has to be honoured by the shared lookup, not
 *    only by code rendering, or a user who answers the question still sees the
 *    clip composer report "not found".
 */
await check('A1c tool discovery finds a Windows-style install and honours the override', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-toolfind-'))
  try {
    const bin = join(scratch, 'Kdenlive', 'bin')
    mkdirSync(bin, { recursive: true })
    const exe = join(bin, 'ffmpeg.exe')
    writeFileSync(exe, 'not a real binary; discovery only stats it\n')

    // `home` points into the scratch directory, and that is not incidental. The
    // first candidate directory is `<home>/.local/bin`, and on a developer
    // machine that directory holds a real ffmpeg — so a lookup that could not be
    // told a different home would return the developer's binary and every
    // assertion below would pass for the wrong reason.
    const win = { platform: 'win32', env: { PATH: bin }, home: scratch }

    // The directory is reachable only through PATH, exactly like a winget or
    // scoop install, and only the `.exe` spelling exists in it.
    assert.equal(host.findTool('ffmpeg', win), exe,
      'a Windows lookup must find ffmpeg.exe through PATH')
    assert.equal(host.findTool('ffprobe', win), undefined,
      'a missing tool stays missing; discovery must not invent one')

    // The same directory on a POSIX lookup holds nothing usable: there is no
    // bare `ffmpeg` here, and the guard must not accept `ffmpeg.exe` instead.
    //
    // Asserted as "not this file" rather than "nothing at all", because the
    // POSIX candidate list also holds the real system directories. CI installs
    // ffmpeg into /usr/bin before the suite runs, so a lookup there legitimately
    // finds a working tool -- and an assertion that it must find nothing would
    // fail on CI while passing on a developer machine that has no
    // /usr/bin/ffmpeg. The claim under test is that a `.exe` is never accepted,
    // which holds either way.
    assert.notEqual(host.findTool('ffmpeg', { platform: 'posix', env: { PATH: bin }, home: scratch }), exe,
      'a POSIX lookup must not accept a .exe as the tool')

    // Windows has no meaningful execute bit, so a regular file is the whole
    // test. Asserting it here pins that difference instead of leaving it to a
    // platform nobody runs the suite on.
    chmodSync(exe, 0o644)
    assert.equal(host.findTool('ffmpeg', win), exe,
      'on Windows a regular file counts as runnable regardless of mode bits')

    // POSIX still requires the execute bit, and this proves the two platforms
    // really do diverge rather than both happening to return the same thing.
    //
    // The bare file goes in a SEPARATE scratch home. `<home>/.local/bin` is the
    // first candidate directory on both platforms, so planting a file there
    // under the Windows home above would give the later Windows assertions a
    // second candidate to find -- and "the override falls back to discovery"
    // would then resolve to this POSIX test's file instead of the `.exe`.
    const posixHome = join(scratch, 'posix-home')
    const localBin = join(posixHome, '.local', 'bin')
    mkdirSync(localBin, { recursive: true })
    const bare = join(localBin, 'ffmpeg')
    const posix = { platform: 'posix', env: { PATH: bin }, home: posixHome }
    writeFileSync(bare, 'not executable either\n')
    chmodSync(bare, 0o644)
    assert.notEqual(host.findTool('ffmpeg', posix), bare,
      'on POSIX a file without the execute bit is not a tool')
    chmodSync(bare, 0o755)
    assert.equal(host.findTool('ffmpeg', posix), bare,
      'on POSIX the execute bit is what makes it a tool')

    // The override wins over discovery, and an override pointing at nothing is
    // ignored rather than reported as a found tool.
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: bin, FFMPEG_PATH: exe } }), exe,
      'FFMPEG_PATH is honoured by the shared lookup')
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: bin, FFMPEG_PATH: join(scratch, 'nope.exe') } }), exe,
      'an override that does not exist falls back to discovery')
    assert.equal(host.findTool('ffprobe', { ...win, env: { PATH: bin, FFPROBE_PATH: join(scratch, 'nope') } }), undefined,
      'a stale override must not fabricate a tool')

    // A Windows PATH is semicolon separated. Splitting it on ':' would yield `C`
    // and the rest of the path as two separate entries, so nothing would match.
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: `C:\\nowhere;${bin}` } }), exe,
      'a Windows PATH is split on the semicolon, not the colon')

    // The POSIX-only package-manager directories must not be searched on Windows:
    // they do not exist there, and listing them only makes the "searched …"
    // message that accompanies a failure misleading.
    const winDirs = host.localVideoToolDirs({ platform: 'win32', env: { PATH: bin }, home: scratch })
    assert.ok(winDirs.includes(bin), 'the Windows PATH entry is searched')
    assert.ok(!winDirs.includes('/opt/homebrew/bin'), 'Homebrew is not a Windows location')
    assert.ok(!winDirs.includes('/usr/bin'), '/usr/bin is not a Windows location')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
await check('A2 Config schema validates + marks apiKey secret', () => {
  const resolvedRefs = host.Config({ apiUrl: 'https://x/v1', apiKey: 'sk-1' })
  const resolved = Object.fromEntries(Object.entries(resolvedRefs).map(([key, value]) => [
    key,
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value,
  ]))
  assert.equal(resolved.apiKey, 'sk-1')
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.allowAgentImageGeneration, true)
  assert.equal(resolved.defaultModel, '')
  assert.deepEqual(resolved.imageModels, [])
  // Config is the schemastery schema itself: the secret role lives on the
  // schema node, which the settings seam's redactor walks.
  assert.equal(host.Config.dict?.apiKey?.meta?.role, 'secret')
  assert.equal(host.Config.dict?.apiKey?.meta?.volatile, true, 'live fields are exposed to dsh-settings 0.1.7')
})
await check('A2b configured default image model is used when Agent omits model', () => {
  const channels = [{
    id: 'default',
    preset: '',
    name: 'Default',
    apiUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    models: [
      { alias: 'qwen-image-3-pro', id: 'qwen-image-3-pro' },
      { alias: 'qwen-image-2', id: 'qwen-image-2' },
    ],
  }]
  const picked = host.resolveAgentImageModel({
    enabled: true,
    allowAgentImageGeneration: true,
    channels,
    defaultChannelId: 'default',
    defaultModel: 'qwen-image-2',
  }, undefined)
  assert.equal(picked.alias, 'qwen-image-2')
  assert.equal(picked.upstream, 'qwen-image-2')
})
await check('A2c prompt models reuse an API-key channel instead of a leading subscription channel', () => {
  const base = {
    channels: [
      {
        id: 'subscription', preset: '', name: 'Subscription', apiUrl: '', apiUrlFull: false,
        auth: 'subscription', subscription: 'openrouter-sub', apiKey: '', models: [],
      },
      {
        id: 'xlink', preset: '', name: 'xlink', apiUrl: 'https://api.xlinks.site/v1', apiUrlFull: false,
        apiKey: 'sk-xlink', models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      },
    ],
    defaultChannelId: 'subscription',
    defaultModel: 'gpt-image-2',
    promptApiUrl: '',
    promptApiKey: '',
    promptModel: 'gpt-5.6-luna',
  }
  assert.deepEqual(host.resolvePromptModelConfig(base), {
    apiUrl: 'https://api.xlinks.site/v1',
    apiKey: 'sk-xlink',
    model: 'gpt-5.6-luna',
  })
  assert.deepEqual(host.resolvePromptModelConfig({
    ...base,
    defaultModel: '',
    promptApiUrl: 'https://chat.example.test/v1',
    promptApiKey: 'sk-chat',
  }), {
    apiUrl: 'https://chat.example.test/v1',
    apiKey: 'sk-chat',
    model: 'gpt-5.6-luna',
  })
})
await check('A3 updater parses stable Releases and caches checks', async () => {
  assert.equal(host.CURRENT_VERSION, packageJson.version)
  assert.equal(host.compareVersions('v1.0.3', '1.0.2') > 0, true)
  assert.equal(host.compareVersions('1.0.2', '1.0.2'), 0)
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile', 'desktop'], {}), 'desktop')
  // DSH Desktop passes the profile as a bare path among its argv entries and
  // sets no flag at all. Reading only `--profile` resolved every Desktop host to
  // `web`, so an update ran against a profile the user was not running.
  const desktopHostArgv = [
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    '--expose-internals',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
    '/Users/someone/.dsh/profiles/desktop',
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime',
  ]
  assert.equal(host.profileFromProcess(desktopHostArgv, {}), 'desktop', 'the Desktop host profile is read from its path argument')
  assert.equal(host.profileFromProcess(['node', 'dsh', 'web'], {}), 'web', 'a bare web run still resolves to web')
  assert.equal(host.profileFromProcess(['node', 'dsh'], {}), 'web', 'an unidentifiable host keeps the historical default')
  // A path that merely CONTAINS "profiles" must not match; only a real segment does.
  assert.equal(host.profileFromProcess(['node', 'dsh', '/tmp/profiles-backup/x'], {}), 'web')
  host.clearUpdateCache()
  let calls = 0
  const fetchRelease = async () => {
    calls += 1
    return new Response(JSON.stringify({
      tag_name: 'v9.9.9',
      html_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/tag/v9.9.9',
      published_at: '2026-08-17T00:00:00Z',
      body: '## Changes\n\n- Faster update discovery\n- Show release notes',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/checksums.txt' },
        { name: 'notes-9.9.9.tgz', browser_download_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/notes-9.9.9.tgz' },
        { name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const first = await host.checkForUpdate(fetchRelease, 1000)
  const second = await host.checkForUpdate(fetchRelease, 1001)
  assert.equal(first.latestVersion, '9.9.9')
  assert.equal(first.updateAvailable, true)
  assert.match(first.releaseNotes, /Faster update discovery/)
  assert.equal(second, first)
  assert.equal(calls, 1)
  // This fork ships as a Release asset, not an npm package, so the installable
  // archive has to be discovered among the assets rather than guessed from the
  // tag. `notes-9.9.9.tgz` also carries the version, so the expected name is
  // what actually distinguishes the plugin archive from a same-version file.
  assert.equal(
    first.tarballUrl,
    'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz',
  )
  assert.equal(host.isInstallableTarballUrl(first.tarballUrl), true)
  host.clearUpdateCache()
})

await check('A3b update install refuses what it cannot verify, and never guesses a registry name', async () => {
  const spawnCalls = []
  const spawnFn = (...args) => {
    spawnCalls.push(args)
    // The updater settles on `close` (it waits for the piped output to drain);
    // a real child emits both, so the stub does too.
    return { once: (event, handler) => { if (event === 'exit' || event === 'close') queueMicrotask(() => { handler(0, null) }) } }
  }
  const releaseWith = assets => async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9', html_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/tag/v9.9.9',
    draft: false, prerelease: false, assets,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const argv = ['node', 'dsh', '--profile', 'desktop']

  // A release with no archive must fail rather than fall back to an npm spec:
  // this fork is not on npm, so installing `@q253595422/dsh-imagegen-video@9.9.9`
  // would fetch nothing while looking like it worked.
  host.clearUpdateCache()
  await assert.rejects(
    () => host.installUpdate('9.9.9', spawnFn, argv, {}, releaseWith([])),
    /publishes no installable archive/,
  )
  assert.equal(spawnCalls.length, 0)

  // The download URL arrives from the network, so an off-GitHub host is refused
  // before anything is executed.
  host.clearUpdateCache()
  await assert.rejects(
    () => host.installUpdate('9.9.9', spawnFn, argv, {}, releaseWith([
      { name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: 'https://evil.example/x.tgz' },
    ])),
    /untrusted download host/,
  )
  assert.equal(spawnCalls.length, 0)
  assert.equal(host.isInstallableTarballUrl('http://github.com/a.tgz'), false)
  assert.equal(host.isInstallableTarballUrl('https://github.com.evil.example/a.tgz'), false)
  assert.equal(host.isInstallableTarballUrl('not a url'), false)

  // `desktop` is the profile DSH Desktop boots, and the CLI refuses to manage
  // it (`profile "desktop" is managed exclusively by the Electron application`).
  // Spawning it anyway is what produced a bare "update failed" with no cause, so
  // the host now refuses BEFORE spawning and hands the caller the archive URL.
  host.clearUpdateCache()
  const archive = 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz'
  await assert.rejects(
    () => host.installUpdate('9.9.9', spawnFn, argv, {}, releaseWith([
      { name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: archive },
    ])),
    (error) => {
      assert.equal(error.code, 'update-manual-required', 'the locked profile has its own wire code')
      assert.equal(error.tarballUrl, archive, 'the caller gets the URL it has to install by hand')
      assert.match(error.message, /Electron/)
      return true
    },
  )
  assert.equal(spawnCalls.length, 0, 'a locked profile is never spawned')

  // The happy path: a CLI-managed profile boots, and the profile comes from the
  // running process instead of being hardcoded.
  const webArgv = ['node', 'dsh', '--profile', 'web']
  host.clearUpdateCache()
  await host.installUpdate('9.9.9', spawnFn, webArgv, {}, releaseWith([
    { name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: archive },
  ]))
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0][1], ['plugin', '--profile', 'web', 'add', archive])

  // Every shape an installer can boot under. `--profile=name` and the Windows
  // `…\profiles\desktop\` path both resolved to `web` before, so an update ran
  // against a profile the user was not running.
  const desktopArgv = [
    '/Applications/DSH.app/Contents/MacOS/DSH',
    '/Applications/DSH.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
    '/Users/test/.dsh/profiles/desktop',
  ]
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile=custom_web'], {}), 'custom_web')
  assert.equal(host.profileFromProcess(['node', 'dsh', 'C:\\Users\\test\\.dsh\\profiles\\desktop\\'], {}), 'desktop')
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile', 'desktop'], { DSH_PROFILE: 'custom' }), 'custom', 'the env profile outranks the flag')
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile', 'desktop'], { DSH_PROFILE: 'ignored' }, { profile: 'host-profile' }), 'host-profile', 'the launcher outranks both')
  // A path that merely contains "profiles" must not match; only a real segment does.
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile', '../bad'], {}), 'web', 'an invalid profile falls back instead of being used')
  assert.equal(host.updateInstallTarget(desktopArgv, {}).installMode, 'host-managed')
  assert.equal(host.updateInstallTarget(['node', 'dsh', 'web'], { DSH_DESKTOP: '1' }).installMode, 'host-managed', 'the launcher marker alone locks CLI writes')
  assert.equal(host.updateInstallTarget(['node', 'dsh', 'web'], {}).installMode, 'cli')
  assert.equal(host.updateInstallTarget([], {}, { installBundle: async () => undefined }).installMode, 'host')
  // A version string is spliced into argv, so anything that is not a semver
  // triple must be refused before a process exists.
  host.clearUpdateCache()
  await assert.rejects(host.installUpdate('9.9.9; touch nope', spawnFn, webArgv, {}, releaseWith([])), /invalid update version/)
  assert.equal(spawnCalls.length, 1, 'an invalid version never starts a package operation')
  host.clearUpdateCache()
})

await check('A3c updater keeps the package manager output, store guidance and a diagnostic record', async () => {
  const calls = []
  // A child process good enough for the updater: two piped streams, an exit, and
  // a close that arrives AFTER the output (which is why `close` is awaited).
  const fakeSpawn = (code, output = '', error) => (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    queueMicrotask(() => {
      if (error !== undefined) { child.emit('error', error); return }
      child.emit('exit', code, null)
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from(output))
        child.emit('close', code, null)
      }, 5)
    })
    return child
  }
  // The three things pnpm prints that matter, assembled from parts so this
  // fixture carries no credential-shaped literal of its own.
  const marker = ['Zq4x', 'marker'].join('')
  const failures = [
    'ERR_PNPM_UNEXPECTED_STORE',
    'store/v10 does not match store/v11',
    ['_auth', 'Token=', marker].join(''),
    ['https://svc:', marker, '@registry.example/'].join(''),
  ].join('\n')
  const release = async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9', draft: false, prerelease: false,
    assets: [{ name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const webArgv = ['node', 'dsh', 'web']

  host.clearDiagnostics()
  host.clearUpdateCache()
  await host.installUpdate('9.9.9', fakeSpawn(0), webArgv, {}, release)
  assert.deepEqual(calls.at(-1).args, ['plugin', '--profile', 'web', 'add', 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz'])
  // Both pipes are read: pnpm splits its explanation across stdout and stderr,
  // and `ignore` on either used to lose half of it.
  assert.deepEqual(calls.at(-1).options.stdio, ['ignore', 'pipe', 'pipe'])

  host.clearUpdateCache()
  await assert.rejects(
    host.installUpdate('9.9.9', fakeSpawn(1, failures), ['node', 'dsh', 'web', '--profile', 'team-web'], {}, release),
    error => {
      assert.match(error.message, /profile: team-web/, 'the failure names the profile it wrote to')
      assert.match(error.message, /exited with code 1/)
      assert.match(error.message, /ERR_PNPM_UNEXPECTED_STORE/)
      assert.match(error.message, /same pnpm version/, 'a store mismatch carries its own remedy')
      assert.ok(!error.message.includes(marker), 'package-manager output is redacted before it is shown')
      return true
    },
  )
  // The same failure is retained host-side, so the panel can still explain a
  // failed update after the popover has been dismissed.
  const recorded = host.listDiagnostics()
  assert.ok(
    recorded.some(entry => entry.mode === 'update' && entry.message.includes('ERR_PNPM_UNEXPECTED_STORE')),
    JSON.stringify(recorded.map(entry => entry.mode)),
  )
  assert.ok(recorded.every(entry => !entry.message.includes(marker)), 'diagnostics never keep a credential')

  host.clearUpdateCache()
  await assert.rejects(host.installUpdate('9.9.9', fakeSpawn(null, '', new Error('spawn dsh ENOENT')), webArgv, {}, release), /ENOENT/)
  host.clearUpdateCache()
  // A spawn that throws synchronously (missing binary, refused execution) used
  // to escape as a bare exception with nothing about the update attached.
  await assert.rejects(host.installUpdate('9.9.9', () => { throw new Error('spawn refused') }, webArgv, {}, release), /spawn refused/)
  host.clearDiagnostics()
  host.clearUpdateCache()
})

await check('A3d update discovery exposes the launcher-owned profile and install mode', async () => {
  const savedFetch = globalThis.fetch
  host.clearUpdateCache()
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: 'v9.9.9', draft: false, prerelease: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    // A launcher that reports no install hook: the check has to say so, because
    // "update available" without an install mode is what made Desktop show a
    // button that then failed with a bare message.
    const routes = host.makeRoutes({
      settings: { describe: () => [], mutate: async () => {} },
      resolve: () => ({ apiUrl: '', apiKey: '' }),
      resolveUpdateContext: () => ({ profile: 'desktop', profileDir: '/Users/test/.dsh/profiles/desktop' }),
    })
    const route = routes.find(candidate => candidate.path === '/api/dsh-imagegen/update/check')
    assert.ok(route !== undefined, 'the update check route exists')
    let result
    await route.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } }, { writeHead() {}, end(payload) { result = JSON.parse(payload) } })
    assert.equal(result.ok, true)
    assert.equal(result.update.profile, 'desktop', 'the panel can tell the user which profile it would write to')
    assert.equal(result.update.installMode, 'host-managed', 'a Desktop profile without an install hook cannot be updated by the CLI')
  } finally {
    globalThis.fetch = savedFetch
    host.clearUpdateCache()
  }
})

await check('A3e desktop updates delegate to the launcher and verify its actual outcome', async () => {
  const calls = []
  const neverSpawn = () => { throw new Error('a launcher-managed update must not spawn a CLI') }
  const tarball = 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz'
  const release = async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9', draft: false, prerelease: false,
    assets: [{ name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: tarball }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const context = {
    profile: 'desktop',
    installBundle: async (spec, options) => {
      calls.push({ spec, options })
      return { application: 'restart-required', bundle: host.PACKAGE_NAME ?? packageJson.name, version: '9.9.9', packageResult: { exitCode: 0 } }
    },
  }
  host.clearUpdateCache()
  assert.equal(host.updateInstallTarget([], {}, context).installMode, 'host', 'an install hook outranks the locked profile name')
  await host.installUpdate('9.9.9', neverSpawn, [], {}, release, context)
  assert.deepEqual(calls, [{ spec: tarball, options: { saveExact: true } }], 'the launcher receives the verified archive URL')

  host.clearUpdateCache()
  await assert.rejects(host.installUpdate('9.9.9; bad', neverSpawn, [], {}, release, context), /invalid update version/)
  assert.equal(calls.length, 1, 'an invalid version never reaches the launcher')

  // Nothing about the launcher's report is believed on trust: an update that
  // claims success but installed something else leaves the disk and the running
  // plugin disagreeing, which is worse than a visible failure.
  for (const result of [
    null,
    {},
    { application: 'failed', error: { code: 'already-installed', diagnostic: 'native refusal' } },
    { application: 'cancelled', version: '9.9.9' },
    { application: 'overridden', version: '9.9.9' },
    { application: 'applied', version: '9.9.9', packageResult: { exitCode: 1 } },
    { application: 'applied', version: '9.9.8' },
    { application: 'applied', version: '9.9.9', bundle: '@other/bundle' },
    { application: 'applied' },
  ]) {
    host.clearUpdateCache()
    await assert.rejects(
      host.installUpdate('9.9.9', neverSpawn, [], {}, release, { ...context, installBundle: async () => result }),
      undefined,
      `launcher result must be refused: ${JSON.stringify(result)}`,
    )
  }

  const marker = ['Zq4x', 'marker'].join('')
  host.clearUpdateCache()
  await assert.rejects(
    host.installUpdate('9.9.9', neverSpawn, [], {}, release, {
      ...context,
      installBundle: async () => ({
        application: 'failed',
        error: { code: 'operation-error' },
        packageResult: { exitCode: 1, output: ['_auth', 'Token=', marker].join('') + '\nERR_PNPM_UNEXPECTED_STORE', logPath: '/profile/diagnostics.log' },
      }),
    }),
    error => {
      assert.match(error.message, /ERR_PNPM_UNEXPECTED_STORE/)
      assert.match(error.message, /diagnostics\.log/, 'the launcher diagnostic file is named')
      assert.ok(!error.message.includes(marker), 'launcher output is redacted too')
      return true
    },
  )

  host.clearUpdateCache()
  await assert.rejects(
    host.installUpdate('9.9.9', neverSpawn, [], {}, release, { ...context, installBundle: async () => { throw new Error('host offline') } }),
    /host offline/,
  )

  // Older launchers omit `version`; the installed manifest is then the only
  // evidence, and a missing one is a failure rather than a silent success.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-imagegen-update-profile-'))
  const packageDir = join(profileDir, 'node_modules', '@q253595422', 'dsh-imagegen-video')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: packageJson.name, version: '9.9.9' }))
  host.clearUpdateCache()
  await host.installUpdate('9.9.9', neverSpawn, [], {}, release, { ...context, profileDir, installBundle: async () => ({ application: 'applied' }) })
  rmSync(profileDir, { recursive: true, force: true })
  host.clearUpdateCache()
})

await check('A3f update routes propagate launcher capability and installation failures', async () => {
  const savedFetch = globalThis.fetch
  host.clearUpdateCache()
  const tarball = 'https://github.com/q253595422/dsh-imagegen-video/releases/download/v9.9.9/q253595422-dsh-imagegen-video-9.9.9.tgz'
  globalThis.fetch = async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9', draft: false, prerelease: false,
    assets: [{ name: 'q253595422-dsh-imagegen-video-9.9.9.tgz', browser_download_url: tarball }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  let installs = 0
  let fail = false
  try {
    const routes = host.makeRoutes({
      settings: { describe: () => [], mutate: async () => {} },
      resolve: () => ({ apiUrl: '', apiKey: '' }),
      resolveUpdateContext: () => ({
        profile: 'desktop',
        installBundle: async spec => {
          installs += 1
          assert.equal(spec, tarball)
          return fail
            ? { application: 'failed', error: { code: 'operation-error', diagnostic: 'native install failed' } }
            : { application: 'restart-required', bundle: packageJson.name, version: '9.9.9' }
        },
      }),
    })
    const invoke = async (path, body = {}) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } })
      let response
      await routes.find(candidate => candidate.path.endsWith(path)).handler(req, { writeHead() {}, end(payload) { response = JSON.parse(payload) } })
      return response
    }
    assert.equal((await invoke('/update/check')).update.installMode, 'host')
    // Only the version the check just reported is installable, so a stale panel
    // cannot install a version that has since been pulled.
    assert.equal((await invoke('/update/apply', { version: '1.0.0' })).code, 'update-not-available')
    assert.equal(installs, 0, 'a non-latest version never reaches the launcher')
    assert.equal((await invoke('/update/apply', { version: '9.9.9' })).updatedVersion, '9.9.9')
    assert.equal(installs, 1)
    fail = true
    const failure = await invoke('/update/apply', { version: '9.9.9' })
    assert.equal(failure.ok, false, 'a refused install is not reported as applied')
    assert.match(failure.message, /native install failed/, 'the launcher cause survives to the panel')
  } finally {
    globalThis.fetch = savedFetch
    host.clearUpdateCache()
  }
})

// ---------------------------------------------- B. engine vs mock upstream
/** A PNG fixture: one pixel, valid header, no external file needed. */
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
let activeGenerationRequests = 0
let maxGenerationRequests = 0
// A second listener = a different origin (port) from the API base. It stands in
// for a malicious relay pointing image URLs at an attacker-controlled host.
const foreignAuthHeaders = []
const resultAuthHeaders = []
const foreignHost = createServer((req, res) => {
  foreignAuthHeaders.push(req.headers.authorization)
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(pngBytes)
})
await new Promise(resolve => foreignHost.listen(0, '127.0.0.1', resolve))
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Gateway site</title>')
    return
  }
  if (url.pathname === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'grok-imagine-image' },
      { id: 'gpt-image-2' },
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'glm-image', capabilities: { image_generation: true } },
      { id: 'chat-only-model', capabilities: { image_generation: false } },
      { id: 'gpt-image-legacy', capabilities: { image_generation: false } },
      { id: 'gpt-image-2' },
      // No separator between the family name and the version: the shipped
      // defaults use this shape (`nanobanana2`, `nanobanana2-lite`), so the
      // id-only fallback has to accept it or "detect models" drops models the
      // catalog itself declares known.
      { id: 'nanobanana2' },
      { id: 'nanobanana2-lite' },
    ] }))
    return
  }
  if (url.pathname === '/v1/wand/si-image/generation') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    assert.equal(body.model, 'si-image')
    assert.equal(body.prompt, 'full endpoint')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/images/generations') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    assert.ok(body.model === 'gpt-image-2' || body.model === 'grok-imagine-image')
    assert.ok(body.prompt === 'a cat' || body.prompt === 'a mismatch cat' || body.prompt === 'a background cat' || body.prompt === 'cancel this' || body.prompt === 'signed urls' || body.prompt === 'foreign url' || body.prompt === 'parallel one' || body.prompt === 'parallel two')
    if (body.model === 'gpt-image-2') {
      assert.equal(body.size, '1024x1024')
      assert.equal(body.quality, 'high')
    } else {
      assert.equal(body.aspect_ratio, '1:1')
      assert.equal(body.response_format, 'b64_json')
    }
    // The engine never sends `n`: Responses-API gateways reject the batch
    // parameter, so the requested count is satisfied by parallel requests.
    assert.equal(body.n, undefined)
    assert.equal(body.detail, body.model === 'grok-imagine-image' || body.prompt === 'signed urls' || body.prompt === 'foreign url' ? undefined : 'standard')
    if (body.prompt === 'parallel one' || body.prompt === 'parallel two') {
      activeGenerationRequests += 1
      maxGenerationRequests = Math.max(maxGenerationRequests, activeGenerationRequests)
      await new Promise(resolve => setTimeout(resolve, 50))
      activeGenerationRequests -= 1
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const data = body.prompt === 'foreign url'
      ? [{ url: `http://127.0.0.1:${foreignHost.address().port}/steal.png` }]
      : body.prompt === 'signed urls'
      ? [
          { b64_json: '', url: `http://127.0.0.1:${upstream.address().port}/image/gcs-signed.png?X-Goog-Credential=test&X-Goog-Signature=test` },
          { b64_json: '   ', url: `http://127.0.0.1:${upstream.address().port}/image/s3-signed.png?X-Amz-Credential=test&X-Amz-Signature=test` },
        ]
      : [
          { b64_json: pngBytes.toString('base64'), revised_prompt: 'a refined cat' },
          { url: `http://127.0.0.1:${upstream.address().port}/image/${body.prompt === 'a mismatch cat' ? 'mismatch' : 'result'}.png` },
        ]
    res.end(JSON.stringify({ created: 1, data }))
    return
  }
  if (url.pathname === '/v1/images/edits') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    assert.ok(req.headers['content-type'].startsWith('multipart/form-data'), 'multipart expected')
    const commandEdit = body.includes('edit via command') || body.includes('edit attached image')
    assert.ok(body.includes('name="prompt"') && (body.includes('edit this') || commandEdit), 'prompt part missing')
    assert.ok(body.includes('name="model"') && body.includes('gpt-image-2'), 'model part missing')
    if (!commandEdit) assert.ok(body.includes('name="size"') && body.includes('1536x1024'), 'size part missing')
    assert.ok(!body.includes('name="n"'), 'n must not be sent (batch param rejected)')
    assert.ok(body.includes('name="image"'), 'image part missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    const asked = body.messages.at(-1).content
    const imageUrl = `http://127.0.0.1:${upstream.address().port}/image/result.png`
    const askedText = typeof asked === 'string'
      ? asked
      : Array.isArray(asked)
        ? asked.find(part => part !== null && typeof part === 'object' && part.type === 'text')?.text ?? ''
        : ''
    if (askedText.startsWith('chat image')) {
      assert.equal(body.stream, false, 'chat image requests must disable streaming')
      assert.equal(body.messages[0].role, 'user', 'chat image request must use a user message')
    }
    if (askedText === 'chat image markdown') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `Generated: ![cat](${imageUrl})` } }] }))
      return
    }
    if (askedText === 'chat image html') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `<p>Result</p><img src="${imageUrl}" />` } }] }))
      return
    }
    if (askedText === 'chat image plain') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: imageUrl } }] }))
      return
    }
    if (askedText === 'chat image json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: { image_url: imageUrl } }) } }] }))
      return
    }
    if (askedText === 'chat image message images') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '', images: [{ image_url: { url: imageUrl } }] } }] }))
      return
    }
    if (askedText === 'chat image error text') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '上游策略拒绝了这次图片生成' } }] }))
      return
    }
    if (askedText === 'chat image edit') {
      assert.ok(Array.isArray(asked), 'chat edit content must be multimodal')
      assert.ok(asked.some(part => part !== null && typeof part === 'object' && part.type === 'image_url'), 'chat edit image_url missing')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: imageUrl } }] } }] }))
      return
    }
    // Vision request (layer decomposition): the canvas route sends a content
    // array; answer with a fenced JSON plan that also exercises normalization
    // (background first, a text layer, and one degenerate box to drop).
    const visionReply = '```json\n'
      + JSON.stringify({
        layers: [
          { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#FFEE00' },
          { kind: 'background', label: '背景' },
          { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.25, width: 0.3, height: 0.6 } },
          { kind: 'object', label: '退化框', rect: { x: 0.2, y: 0.2, width: 0, height: 0.3 } },
        ],
      })
      + '\n```'
    const reply = Array.isArray(asked)
      ? visionReply
      : asked === 'think leak'
        ? '<think>\u9996\u5148\u5206\u6790\u7528\u6237\u9700\u6c42\u2026\uff08\u5927\u6bb5\u63a8\u7406\uff09</think>\nA lighthouse at dusk over a stormy sea.'
        : asked === 'dangling think'
          ? '<think>reasoning that never closes'
          : 'A calm meadow under morning light.'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    return
  }
  if (url.pathname === '/image/result.png') {
    // Same-origin downloads (B1: API base is this server) keep the key; other
    // suites (Qwen / async providers on their own ports) point here from a
    // foreign origin and must arrive without it.
    resultAuthHeaders.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/mismatch.png') {
    // Regression fixture: the provider declares JPEG while returning PNG bytes.
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/gcs-signed.png' || url.pathname === '/image/s3-signed.png') {
    assert.equal(req.headers.authorization, undefined, 'presigned URLs must not receive the channel API key')
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

await check('B1 text generation normalizes b64_json + url items', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    // n=1: one request returns two data items (b64_json + url), both normalized.
    { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].revisedPrompt, 'a refined cat')
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].mime, 'image/png')
  assert.equal(resultAuthHeaders.at(-1), 'Bearer sk-test', 'same-origin result URLs keep the channel API key')
})

await check('B1b exact URL channels use the configured endpoint verbatim (#26)', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/wand/si-image/generation`, apiKey: 'sk-test', apiUrlFull: true },
    { mode: 'text', model: 'si-image', prompt: 'full endpoint', size: 'auto', quality: 'auto', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B1c chat completions text content extracts markdown, HTML, plain and JSON image URLs', async () => {
  const prompts = ['chat image markdown', 'chat image html', 'chat image plain', 'chat image json']
  for (const prompt of prompts) {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test', protocol: 'auto' },
      { mode: 'text', model: 'gpt-image-2', prompt, size: '1:1', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images.length, 1, prompt)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'), prompt)
    assert.equal(result.images[0].mime, 'image/png', prompt)
  }
})

await check('B1d chat completions edit sends image_url and reads structured content images', async () => {
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', protocol: 'chat-completions' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'chat image edit', size: '1:1', quality: '4k', n: 1, detail: '', image: dataUrl },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B1e chat completions message.images and text errors are handled', async () => {
  const image = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'chat image message images', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(image.images.length, 1)
  await assert.rejects(
    host.generateImage(
      { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'chat image error text', size: '1:1', quality: '4k', n: 1, detail: '' },
    ),
    /上游策略拒绝了这次图片生成/,
  )
})

await check('B2 signed URLs bypass API-key auth and empty base64 falls back to URL', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'signed urls', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
})

await check('B2b result URLs on a foreign origin never receive the channel API key', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'foreign url', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(foreignAuthHeaders.length, 1)
  assert.equal(foreignAuthHeaders[0], undefined, 'a foreign-origin image URL must not carry the Bearer key')
})

await check('B3 edit mode sends multipart and normalizes', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'edit this', size: '3:2', quality: '2k', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B3b edit mode forwards every reference image', async () => {
  const seen = { fields: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('latin1')
    seen.fields = [...body.matchAll(/name="([^"]+)"/g)].map(match => match[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' },
      { mode: 'edit', model: 'gpt-image-2', prompt: 'combine both references', size: '1:1', quality: 'auto', n: 1, detail: '', image: dataUrl, images: [dataUrl, dataUrl] },
    )
    assert.deepEqual(seen.fields.filter(name => name.startsWith('image')), ['image[]', 'image[]', 'image[]'])
  } finally {
    server.close()
  }
})

await check('B4 config missing errors are user-presentable', async () => {
  await assert.rejects(
    host.generateImage({ apiUrl: '', apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_url 未配置/,
  )
  await assert.rejects(
    host.generateImage({ apiUrl: 'http://x', apiKey: '' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_key 未配置/,
  )
})

await check('B4b a failed call is explainable afterwards (#38)', async () => {
  // The reporter of #38 reverse-engineered an image API, verified it against
  // new-api, and then watched every plugin call fail while NEITHER side had a
  // log entry — because the request never reached their gateway. The plugin
  // toasted one sentence and kept no record, so the URL it actually called, the
  // HTTP status and the network error code were all unrecoverable.
  host.clearDiagnostics()

  // 1. A refused connection: no response at all, so the URL and the socket code
  //    are the only evidence that the request left the process.
  const closedPort = await (async () => {
    const probe = createServer(() => {})
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    return port
  })()
  await assert.rejects(
    host.generateImage(
      { apiUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: 'sk-secret-key-abcdefghijklmnop', channelName: 'MyChannel' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '' },
    ),
  )
  const refused = host.listDiagnostics().find(entry => entry.phase === 'generate')
  assert.ok(refused !== undefined, 'a refused connection leaves a diagnostic entry')
  assert.equal(refused.url, `http://127.0.0.1:${closedPort}/v1/images/generations`, 'the diagnostic records the FINAL request URL, including the appended path')
  assert.equal(refused.channel, 'MyChannel', 'the entry names the channel so it maps to a settings row')
  assert.equal(refused.model, 'gpt-image-2')
  assert.equal(refused.method, 'POST')
  assert.equal(refused.failureCode, 'upstream-unreachable')
  assert.equal(refused.hadAuth, true, 'the entry records THAT a key was sent, never its value')
  assert.ok(refused.durationMs >= 0, 'the entry records elapsed time')
  assert.ok(refused.requestBytes > 0, 'the entry records the request body size (a huge edit can be rejected before the app sees it)')
  assert.equal(refused.status, undefined, 'a request that never got a response carries no status')

  // 2. A non-2xx upstream: the status and the body have to survive, because
  //    that is where the gateway says WHY it refused.
  const bad = createServer((_req, res) => {
    res.writeHead(413, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'payload too large' }, request_id: 'req_123' }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const badPort = bad.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${badPort}/v1`, apiKey: 'k', channelName: 'Bad' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'a dog', size: 'auto', quality: 'auto', n: 1, detail: '' },
      ),
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
  const rejected = host.listDiagnostics().find(entry => entry.channel === 'Bad')
  assert.ok(rejected !== undefined, 'a rejected request leaves a diagnostic entry')
  assert.equal(rejected.status, 413, 'the upstream status is recorded')
  assert.equal(rejected.failureCode, 'upstream-rejected')
  assert.match(rejected.message, /payload too large/, 'the upstream message reaches the record')
  assert.match(rejected.bodyExcerpt ?? '', /req_123/, 'the raw upstream body (with its request id) is kept for support')

  // 3. Redaction: these entries are meant to be pasted into a public issue.
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  const redacted = host.redactDiagnosticText(`Authorization: Bearer ${secret}\n{"apiKey":"${secret}"}\nhttps://x.test/v1?api_key=${secret}`)
  assert.equal(redacted.includes(secret), false, 'the recorded text never carries the key')
  assert.match(redacted, /<redacted>|<redacted-key>/, 'the redaction is visible in the text')
  assert.equal(
    host.redactDiagnosticText('data:image/png;base64,' + 'A'.repeat(5000)).length < 200,
    true,
    'inline base64 image payloads are summarised, not stored',
  )

  // 4. The buffer is bounded and clearable.
  assert.ok(host.listDiagnostics().length >= 2, 'entries accumulate newest-first')
  host.clearDiagnostics()
  assert.equal(host.listDiagnostics().length, 0, 'the panel can clear the record')
})

await check('B5 upstream error surfaces its message', async () => {
  const bad = createServer(async (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Unknown parameter: detail' } }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const port = bad.address().port
  try {
    await assert.rejects(
      host.generateImage({ apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
      /Unknown parameter: detail/,
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
})

await check('B6 dall-e-3 clamps params', async () => {
  const seen = []
  const dalle = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => dalle.listen(0, '127.0.0.1', resolve))
  const port = dalle.address().port
  try {
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      { mode: 'text', model: 'dall-e-3', prompt: 'x', size: '512x512', quality: 'high', n: 4, detail: 'high' },
    )
    // dall-e-3: params clamp to { model, size } and no `n` is ever sent.
    assert.deepEqual(seen[0], { model: 'dall-e-3', size: '1024x1024', prompt: 'x' })
  } finally {
    await new Promise(resolve => dalle.close(resolve))
  }
})

await check('B7 Volcengine Seedream uses Ark size and URL response fields', async () => {
  const seen = []
  const seedream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push(body)
      assert.equal(body.model, 'doubao-seedream-5-0-pro-260628')
      // Ark has no aspect-ratio parameter, so a 16:9 pick has to reach the wire
      // as explicit pixels inside 5.0 pro's [1280x720, 2048x2048x1.1025] budget.
      const [w, h] = String(body.size).split('x').map(Number)
      assert.ok(Number.isFinite(w) && Number.isFinite(h), `size must be WxH, got ${body.size}`)
      assert.ok(w * h >= 921_600 && w * h <= 4_624_220, `pixels outside the budget: ${w}x${h}`)
      assert.ok(Math.abs(w / h - 16 / 9) < 0.01, `ratio drifted: ${w}x${h}`)
      assert.equal(w % 2, 0, 'Ark wants even dimensions')
      assert.equal(h % 2, 0, 'Ark wants even dimensions')
      assert.equal(body.response_format, 'url')
      assert.equal(body.resolution, undefined)
      // The upstream default is a visible "AI生成" stamp; it must be sent off.
      assert.equal(body.watermark, false)
      assert.equal(body.prompt, 'a volcano')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${seedream.address().port}/seedream.png` }] }))
      return
    }
    if (url.pathname === '/seedream.png') {
      assert.equal(req.headers.authorization, 'Bearer sk-seedream')
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(pngBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => seedream.listen(0, '127.0.0.1', resolve))
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${seedream.address().port}/v1`, apiKey: 'sk-seedream', watermark: false },
      { mode: 'text', model: 'doubao-seedream-5-0-pro-260628', prompt: 'a volcano', size: '16:9', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(seen.length, 1)
  } finally {
    await new Promise(resolve => seedream.close(resolve))
  }
})

await check('B7b Ark Seedream edit path and tier vocabulary match the docs', async () => {
  // The edit path builds its own body, so `watermark` had to be switched off
  // in TWO places; a test that only covers text-to-image would miss the one
  // that stamps every image the user uploads a reference for.
  const seen = []
  const seedream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      seen.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${seedream.address().port}/edited.png` }] }))
      return
    }
    if (url.pathname === '/edited.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(pngBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => seedream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${seedream.address().port}/v1`
  try {
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'k' },
      {
        mode: 'edit',
        model: 'doubao-seedream-5-0-pro-260628',
        prompt: 'make it night',
        size: '1:1',
        quality: '2k',
        n: 1,
        detail: '',
        image: `data:image/png;base64,${pngBytes.toString('base64')}`,
      },
    )
    assert.equal(result.images.length, 1)
    // Seedream has no /images/edits endpoint: an edit is a generations call
    // that carries the reference as a JSON array.
    assert.equal(seen[0].path, '/v1/images/generations')
    const edit = seen[0].body
    assert.equal(edit.watermark, undefined, 'default watermark stays off wire unless opted out')
    assert.equal(edit.response_format, 'url')
    assert.ok(Array.isArray(edit.image) && edit.image.length === 1, 'the reference travels as a JSON array')
    assert.equal(edit.model, 'doubao-seedream-5-0-pro-260628')

    // Opting out explicitly sends watermark: false.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'k', watermark: false },
      {
        mode: 'edit',
        model: 'doubao-seedream-5-0-pro-260628',
        prompt: 'make it night',
        size: '1:1',
        quality: '2k',
        n: 1,
        detail: '',
        image: `data:image/png;base64,${pngBytes.toString('base64')}`,
      },
    )
    assert.equal(seen[0].body.watermark, false, 'the edit path forwards watermark: false when channel opts out')

    // The tier vocabulary is per model: lite and 4.5 start at 2K, so a 1K ask
    // is a 400 upstream and has to be snapped up rather than forwarded.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'k' },
      { mode: 'text', model: 'doubao-seedream-4-5-251128', prompt: 'p', size: 'auto', quality: '1k', n: 1, detail: '' },
    )
    assert.equal(seen[0].body.size, '2K', '4.5 has no 1K tier')
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'k' },
      { mode: 'text', model: 'doubao-seedream-5-0-pro-260628', prompt: 'p', size: 'auto', quality: '1k', n: 1, detail: '' },
    )
    assert.equal(seen[0].body.size, '1K', '5.0 pro does have a 1K tier')

    // Rounding to even used to push the product a few pixels over the ceiling
    // at 4K (16:9 → 16,779,264 > 4096²), which Ark rejects outright.
    for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']) {
      seen.length = 0
      await host.generateImage(
        { apiUrl: base, apiKey: 'k' },
        { mode: 'text', model: 'doubao-seedream-4-0-250828', prompt: 'p', size: ratio, quality: '4k', n: 1, detail: '' },
      )
      const [w, h] = String(seen[0].body.size).split('x').map(Number)
      assert.ok(Number.isFinite(w) && Number.isFinite(h), `${ratio}: size must be WxH, got ${seen[0].body.size}`)
      assert.ok(w * h <= 16_777_216, `${ratio}: ${w}x${h} is over the 4096x4096 ceiling`)
      assert.ok(w * h >= 921_600, `${ratio}: ${w}x${h} is under the 1280x720 floor`)
    }
  } finally {
    await new Promise(resolve => seedream.close(resolve))
  }
})

await check('B7c Seedream watermark opt-out only reaches official hosts (#56)', async () => {
  const seen = []
  const seedream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${seedream.address().port}/seedream.png` }] }))
      return
    }
    if (url.pathname === '/seedream.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(pngBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => seedream.listen(0, '127.0.0.1', resolve))
  const base = { apiUrl: `http://127.0.0.1:${seedream.address().port}/v1`, apiKey: 'k' }
  const reference = `data:image/png;base64,${pngBytes.toString('base64')}`
  const generation = { mode: 'text', model: 'doubao-seedream-5-0-pro-260628', prompt: 'x', size: '16:9', quality: '2k', n: 1, detail: '' }
  try {
    // Default on: the field is never sent, so upstream keeps its own default.
    await host.generateImage(base, generation)
    assert.equal(seen.at(-1).watermark, undefined, 'watermark stays absent unless the channel opts out')
    // An explicit opt-out travels on the official model id.
    await host.generateImage({ ...base, watermark: false }, generation)
    assert.equal(seen.at(-1).watermark, false, 'generation sends watermark=false')
    // Editing shares /images/generations, so the hand-built body must repeat it.
    await host.generateImage({ ...base, watermark: false }, { ...generation, mode: 'edit', image: reference })
    assert.equal(seen.at(-1).watermark, false, 'edit body repeats watermark=false')
    assert.deepEqual(seen.at(-1).image, [reference], 'edit keeps its reference array intact')
    // A third-party relay serving short Seedream ids keeps its original body.
    await host.generateImage({ ...base, watermark: false }, { ...generation, model: 'seedream-5.0-pro' })
    assert.equal(seen.at(-1).watermark, undefined, 'relays without the documented field never see watermark')
  } finally {
    await new Promise(resolve => seedream.close(resolve))
  }
})

await check('B8 Zhipu GLM-Image uses the official generation contract', async () => {
  const seen = []
  const zhipu = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/paas/v4/images/generations') {
      seen.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => zhipu.listen(0, '127.0.0.1', resolve))
  const port = zhipu.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/api/paas/v4`, apiKey: 'zhipu-key' },
      { mode: 'text', model: 'glm-image', prompt: 'x', size: '1:1', quality: '4k', n: 1, detail: 'high' },
    )
    assert.equal(result.images.length, 1)
    assert.deepEqual(seen[0], {
      path: '/api/paas/v4/images/generations',
      body: { model: 'glm-image', prompt: 'x', size: '1024x1024', quality: 'hd' },
    })
  } finally {
    await new Promise(resolve => zhipu.close(resolve))
  }
})

await check('B9 Qwen-Image speaks the DashScope native contract', async () => {
  const seen = []
  const qwen = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
      seen.push({
        auth: req.headers.authorization,
        path: url.pathname,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${upstreamPort}/image/result.png` }] } }] },
        usage: { image_count: 1 },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => qwen.listen(0, '127.0.0.1', resolve))
  const port = qwen.address().port
  const base = `http://127.0.0.1:${port}/api/v1`
  try {
    // Versioned series: wide ratio maps to the HD size set and n batches natively.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-3.0', prompt: 'a cat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.deepEqual(seen[0], {
      auth: 'Bearer qwen-key',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      body: {
        model: 'qwen-image-3.0',
        input: { messages: [{ role: 'user', content: [{ text: 'a cat' }] }] },
        parameters: { size: '2688*1536', n: 2 },
      },
    })
    // Classic series: single image per call, fixed size list, no n parameter.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-plus', prompt: 'x', size: '9:16', quality: '2k', n: 4, detail: '' },
    )
    assert.deepEqual(seen[0].body.parameters, { size: '928*1664' })
    // Edit mode rides the reference image as a message content item.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'edit', model: 'qwen-image-3.0', prompt: 'edit this', size: '1:1', quality: 'auto', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
    )
    assert.deepEqual(seen[0].body.input.messages[0].content, [
      { image: `data:image/png;base64,${pngBytes.toString('base64')}` },
      { text: 'edit this' },
    ])
    assert.deepEqual(seen[0].body.parameters, { size: '2048*2048' })
  } finally {
    await new Promise(resolve => qwen.close(resolve))
  }
})


await check('B9b MiniMax image-01 speaks the native /image_generation contract', async () => {
  const seen = []
  let reply = () => ({ id: 'req-1', data: { image_base64: [pngBytes.toString('base64')] }, metadata: { failed_count: '0', success_count: '1' }, base_resp: { status_code: 0, status_msg: 'success' } })
  const minimax = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/image_generation') {
      seen.push({ auth: req.headers.authorization, path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      // MiniMax answers HTTP 200 for failures too; base_resp carries the verdict.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply()))
      return
    }
    res.writeHead(404)
    res.end('404 page not found')
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    // Text mode: aspect_ratio passthrough, native n batching, base64 results.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'mm-key' },
      { mode: 'text', model: 'image-01', prompt: 'a boat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(result.images[0].mime, 'image/png')
    assert.deepEqual(seen[0], {
      auth: 'Bearer mm-key',
      path: '/v1/image_generation',
      body: { model: 'image-01', prompt: 'a boat', response_format: 'base64', aspect_ratio: '16:9', n: 2 },
    })
    // auto size omits aspect_ratio; n=1 omits n; n is capped at 9.
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: 'auto', quality: '4k', n: 1, detail: '' })
    assert.deepEqual(seen[0].body, { model: 'image-01', prompt: 'x', response_format: 'base64' })
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 50, detail: '' })
    assert.ok(seen[0].body.n <= 9, `n must be capped at 9, got ${seen[0].body.n}`)
    // Edit mode: one character subject_reference with the data URL.
    seen.length = 0
    const ref = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'edit', model: 'image-01', prompt: 'same person, beach', size: '3:4', quality: 'auto', n: 1, detail: '', image: ref })
    assert.deepEqual(seen[0].body.subject_reference, [{ type: 'character', image_file: ref }])
    assert.equal(seen[0].body.aspect_ratio, '3:4')
    // Prompts at MiniMax's 1500-char limit fail fast, before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1600), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 0)
    // Unsupported panel ratio is rejected locally before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '5:7', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'size-unsupported',
    )
    assert.equal(seen.length, 0)
    // HTTP 200 + non-zero base_resp.status_code surfaces as an upstream rejection.
    reply = () => ({ id: 'req-2', data: null, base_resp: { status_code: 2013, status_msg: 'invalid params, unsupported model: image-99' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-rejected' && /2013/.test(error.message) && /image-99/.test(error.message),
    )
    reply = () => ({ id: 'req-3', data: null, base_resp: { status_code: 2049, status_msg: 'invalid api key' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-unauthorized',
    )
    // The catalog classifies the family so the UI shows the right badge, and a
    // wrong-family model on the same base must NOT hit /image_generation.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
    )
    assert.equal(seen.length, 0, 'non-MiniMax models keep the OpenAI route')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B9c prompt character limits share one source between engine and panel counter', async () => {
  // Only MiniMax documents a limit today; everything else — including
  // unrecognized ids — must report null so the panel hides the counter.
  assert.equal(host.promptCharLimit('image-01'), 1500)
  assert.equal(host.promptCharLimit('minimax-image-01'), 1500)
  assert.equal(host.promptCharLimit('gpt-image-2'), null)
  assert.equal(host.promptCharLimit('doubao-seedream-4.0'), null)
  assert.equal(host.promptCharLimit('totally-unknown'), null)
  // The engine enforces exactly that shared number: 1499 chars pass through
  // to the fake upstream, 1500 fail fast before any network call.
  const seen = []
  const minimax = createServer(async (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r', data: { image_base64: [pngBytes.toString('base64')] }, base_resp: { status_code: 0, status_msg: 'ok' } }))
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1499), size: '1:1', quality: 'auto', n: 1, detail: '' })
    assert.equal(seen.length, 1, '1499 chars must reach the upstream')
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1500), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 1, '1500 chars must fail fast without an upstream call')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B10 async two-step providers submit, poll, and flatten URL arrays', async () => {
  const submissions = []
  const polls = new Map()
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/images/generations') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const taskId = `task-${submissions.length + 1}`
      submissions.push({
        taskId,
        body,
        authorization: req.headers.authorization,
        modelScopeHeader: req.headers['x-modelscope-async-mode'],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: taskId }] }))
      return
    }
    if (url.pathname.startsWith('/v1/tasks/')) {
      const taskId = url.pathname.slice('/v1/tasks/'.length)
      const count = (polls.get(taskId) ?? 0) + 1
      polls.set(taskId, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (count === 1) {
        res.end(JSON.stringify({ data: { status: 'processing', task_id: taskId } }))
      } else {
        res.end(JSON.stringify({ data: { status: 'completed', task_id: taskId, result: { images: [{ url: [`http://127.0.0.1:${upstreamPort}/image/result.png`, `data:image/png;base64,${pngBytes.toString('base64')}`] }] } } }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'async image', size: '1:1', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(submissions.length, 2, 'one upstream task is submitted for each requested image')
    assert.equal(result.images.length, 4, 'each completed task URL array is flattened')
    assert.ok(submissions.every(item => item.authorization === 'Bearer async-key'))
    assert.ok(submissions.every(item => item.modelScopeHeader === undefined), 'ordinary gateways do not receive ModelScope headers')
    assert.ok([...polls.values()].every(count => count >= 2), 'submitted tasks are polled until completed')
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B10b ModelScope inference submits and polls the OpenAI-compatible Qwen task', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const imageDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    calls.push({ url, method, headers, body: typeof init.body === 'string' ? init.body : undefined })
    if (method === 'POST' && url === 'https://api-inference.modelscope.cn/v1/images/generations') {
      return new Response(JSON.stringify({ task_id: 'modelscope-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && url === 'https://api-inference.modelscope.cn/v1/tasks/modelscope-task-1') {
      return new Response(JSON.stringify({ task_status: 'SUCCEED', output_images: [imageDataUrl] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected ModelScope request: ${method} ${url}`)
  }
  try {
    const result = await host.generateImage(
      { apiUrl: 'https://api-inference.modelscope.cn/', apiKey: 'modelscope-key' },
      { mode: 'text', model: 'qwen-image-2.1', upstream: 'Qwen/Qwen-Image-2.1', prompt: 'a calm lake', size: '1:1', quality: 'auto', n: 1, detail: '' },
    )
    assert.equal(calls.length, 2, 'submission is followed by one successful task poll')
    assert.equal(calls[0].url, 'https://api-inference.modelscope.cn/v1/images/generations')
    assert.equal(calls[0].headers.get('x-modelscope-async-mode'), 'true')
    assert.equal(calls[0].headers.get('authorization'), 'Bearer modelscope-key')
    const submitted = JSON.parse(calls[0].body)
    assert.equal(submitted.model, 'Qwen/Qwen-Image-2.1')
    assert.equal(submitted.prompt, 'a calm lake')
    assert.equal(calls[1].url, 'https://api-inference.modelscope.cn/v1/tasks/modelscope-task-1')
    assert.equal(calls[1].headers.get('x-modelscope-task-type'), 'image_generation')
    assert.equal(calls[1].headers.get('authorization'), 'Bearer modelscope-key')
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(result.images[0].mime, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('B11 async provider failures surface the remote error', async () => {
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'submitted', task_id: 'failed-task' } }))
      return
    }
    if (url.pathname === '/v1/tasks/failed-task') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'failed', error: { message: 'content rejected' } } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'bad', size: '1:1', quality: 'auto', n: 1, detail: '' },
      ),
      /content rejected/,
    )
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B12 async provider cancellation aborts polling', async () => {
  let pollCount = 0
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: 'cancel-task' }] }))
      return
    }
    if (url.pathname === '/v1/tasks/cancel-task') {
      pollCount += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'processing', task_id: 'cancel-task' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  const controller = new AbortController()
  try {
    const pending = host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'cancel', size: '1:1', quality: 'auto', n: 1, detail: '' },
      { signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 80))
    controller.abort()
    await assert.rejects(pending)
    assert.ok(pollCount >= 1)
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})
// ------------------------------------------------- C. routes over real HTTP
const stored = new Map() // namespace -> user section
const seam = {
  writable: true,
  describe({ redactSecrets } = {}) {
    const value = { enabled: true, announceToAgent: true, apiUrl: 'http://upstream/v1', apiKey: 'sk-secret' }
    const user = stored.get('imagegen')
    const merged = { ...value, ...user }
    const view = {
      ns: 'imagegen',
      value: redactSecrets ? { ...merged, apiKey: undefined } : merged,
      revision: stored.get('rev') ?? 0,
      ...user !== undefined ? { user: redactSecrets ? { ...user, apiKey: undefined } : user } : {},
      applies: 'live',
      ...redactSecrets ? { secrets: [{ path: ['apiKey'], set: (user?.apiKey ?? '') !== '' }] } : {},
    }
    return [view]
  },
  async mutate(ns, ops, expectedRevision) {
    assert.equal(String(ns), 'imagegen')
    const current = { ...(stored.get('imagegen') ?? {}) }
    for (const op of ops) {
      if (op.op === 'set') current[op.path[0]] = op.value
      else if (op.op === 'unset') delete current[op.path[0]]
    }
    stored.set('imagegen', current)
    stored.set('rev', (stored.get('rev') ?? 0) + 1)
  },
}
const subscriptionStatuses = {
  'chatgpt-sub': { state: 'logged-out' },
  'grok-sub': { state: 'logged-in', email: 'grok@example.test' },
  'google-sub': { state: 'logged-out' },
  'openrouter-sub': { state: 'logged-out' },
}
let subscriptionGenerateCalls = 0
const subscriptionFake = {
  async loginStatus(vendor) {
    const provider = vendor === 'codex' ? 'chatgpt-sub' : vendor === 'antigravity' ? 'google-sub' : vendor === 'openrouter' ? 'openrouter-sub' : 'grok-sub'
    return subscriptionStatuses[provider]
  },
  async beginLogin(vendor) { return { url: `https://auth.example.test/${vendor}`, ...vendor === 'grok' ? { code: 'ABCD-EFGH' } : {} } },
  lastLoginError() { return undefined },
  async completeLogin(vendor, input) {
    assert.equal(vendor, 'openrouter')
    assert.equal(input, 'http://127.0.0.1:56231/oauth/callback?code=manual&state=manual-state')
    subscriptionStatuses['openrouter-sub'] = { state: 'logged-in', email: 'openrouter@example.test' }
  },
  async logout(vendor) {
    const provider = vendor === 'codex' ? 'chatgpt-sub' : vendor === 'antigravity' ? 'google-sub' : vendor === 'openrouter' ? 'openrouter-sub' : 'grok-sub'
    subscriptionStatuses[provider] = { state: 'logged-out' }
  },
  async generate(options) {
    subscriptionGenerateCalls += 1
    assert.equal(options.vendor, 'grok')
    assert.equal(options.prompt, 'subscription cat')
    return [{ b64_json: pngBytes.toString('base64') }]
  },
}
const persistedHistory = []
let persistedFavorites = []
const history = {
  async list() { return persistedHistory },
  async append(entry) {
    const wire = {
      ...entry,
      images: entry.images.map((image, index) => ({
        url: `/api/dsh-imagegen/history/image/${entry.id}-${index}.png`,
        mime: image.mime,
        ...(image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt }),
      })),
    }
    persistedHistory.unshift(wire)
    return persistedHistory
  },
  async remove(id) {
    const index = persistedHistory.findIndex(entry => entry.id === id)
    if (index >= 0) persistedHistory.splice(index, 1)
    return persistedHistory
  },
  async clear() {
    persistedHistory.splice(0)
    return persistedHistory
  },
  async readImage() { return undefined },
}
const templateImage = Buffer.from('template-image')
let templateRefreshes = 0
const templateSamples = []
const templates = {
  async list(sourceId) {
    return {
      sourceId,
      cases: [{
        id: 1,
        title: 'Poster template',
        prompt: 'Create a bright product poster',
        category: 'Posters & Typography',
        categoryZh: '海报与排版',
        styles: [],
        scenes: [],
        sourceLabel: '@author',
        sourceUrl: 'https://example.test/author',
        githubUrl: 'https://example.test/repo#1',
        image: 'case1.png',
        featured: true,
      }],
      total: 1,
      origin: 'bundled',
      repository: 'example/templates',
      fetchedAt: '2026-08-19T00:00:00.000Z',
    }
  },
  async refresh(sourceId) {
    templateRefreshes += 1
    return { sourceId, total: 1, fetchedAt: '2026-08-19T00:00:01.000Z' }
  },
  async sample(count) {
    templateSamples.push(count)
    return [{ sourceId: 'vibeui', case: { id: 1, title: 'Poster template', prompt: 'Create a bright product poster', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false } }]
  },
  async readImage(sourceId, file) {
    return sourceId === 'vibeui' && file === 'case1.png' ? { data: templateImage, mime: 'image/png' } : undefined
  },
}
const favorites = {
  async list() { return [...persistedFavorites] },
  async add(sourceId, item) {
    const key = `${sourceId}:${item.id}`
    const entry = { key, sourceId, savedAt: '2026-08-19T00:00:02.000Z', case: item }
    persistedFavorites = [entry, ...persistedFavorites.filter(favorite => favorite.key !== key)]
    return [...persistedFavorites]
  },
  async remove(key) {
    persistedFavorites = persistedFavorites.filter(favorite => favorite.key !== key)
    return [...persistedFavorites]
  },
}
const agentPreviewImage = Buffer.from('agent-preview-image')
const agentPreviewRef = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: agentPreviewImage.length,
  width: 1,
  height: 1,
}
const attachments = {
  async readImage(ref) {
    assert.equal(ref.attachmentId, agentPreviewRef.attachmentId)
    assert.equal(ref.mediaType, agentPreviewRef.mediaType)
    assert.equal(ref.bytes, agentPreviewRef.bytes)
    return { ref: agentPreviewRef, data: agentPreviewImage }
  },
  async saveImage(input) {
    return {
      attachmentId: `sha256:${'b'.repeat(64)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}
const pendingConversationImages = new Map()
let storageProbeEndpoint = ''
let heavySkillAllowed = true
const skillRunRoot = join(tmpdir(), `dsh-imagegen-smoke-${process.pid}`)
mkdirSync(skillRunRoot, { recursive: true })
/** ---------------------------------------------------------------- canvas ---
 * In-memory canvas + file store standing in for CanvasStore, plus a scripted
 * chat model and skill registry so the skill runner can run end to end. */
const canvasDocuments = new Map()
const canvasFiles = new Map()
const canvasBlobs = new Map()
/** The same self-executing extensions `CanvasStore.putFile` refuses. */
const BLOCKED_FILE_EXTENSIONS = new Set(['exe', 'js', 'mjs', 'cjs', 'sh', 'bash', 'bat', 'cmd', 'ps1', 'html', 'htm', 'xhtml', 'svg'])
let canvasFileSeq = 0
let chatCalls = 0
let chatReply = 'polished text by model'
const skillRegistrySkills = []
const recordCanvasFile = (data, mime, name) => {
  canvasFileSeq += 1
  const assetId = `file${canvasFileSeq.toString().padStart(4, '0')}`
  const extension = name.includes('.') ? name.split('.').pop() : 'bin'
  const fileName = `${assetId}.${extension}`
  canvasFiles.set(assetId, { name, mime })
  canvasBlobs.set(fileName, { data: Buffer.from(data), mime })
  return {
    assetId,
    url: `/api/dsh-imagegen/canvas/asset/${fileName}`,
    mime,
    bytes: data.length,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name,
  }
}
const canvasBackend = {
  async read(id) { return canvasDocuments.get(id) },
  async readAsset(file) { return canvasBlobs.get(file) },
  async readAssets(refs) {
    const found = new Map()
    for (const ref of refs) {
      const extension = (ref.name ?? '').includes('.') ? ref.name.split('.').pop() : 'bin'
      const blob = canvasBlobs.get(`${ref.assetId}.${extension}`)
      if (blob !== undefined) found.set(ref.assetId, blob)
    }
    return found
  },
  async materialize(ref, targetPath) {
    const found = await canvasBackend.readAssets([ref])
    const blob = found.get(ref.assetId)
    if (blob === undefined) throw new Error(`missing asset ${ref.assetId}`)
    writeFileSync(targetPath, blob.data)
  },
  async putFile(input) {
    // Mirrors `CanvasStore.putFile`'s refusals, so a check can stage an
    // artifact the real store would reject (blocked extension, size cap).
    const name = String(input.name)
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    if (BLOCKED_FILE_EXTENSIONS.has(extension)) throw new Error(`出于安全考虑，不支持上传 .${extension} 文件`)
    if (input.data.byteLength > 50 * 1024 * 1024) throw new Error('文件超过 50MB 上限')
    return recordCanvasFile(input.data, input.mime, name)
  },
}
let heavyRunsStarted = 0
/** Extra artifacts the fake heavy agent writes on top of `deck.pptx`, keyed by
 *  file name. A check sets this to stage an unpublishable artifact. */
let heavyArtifacts = []
/** Isolated skill library root for the install/remove cases. */
const skillLibraryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-skills-'))
/** Isolated local skill root the canvas registry adapter falls back to. */
const skillRegistryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-registry-'))
const canvasSkillRunner = new host.SkillRunner({
  backend: {
    canvas: canvasBackend,
    chat: {
      async complete() {
        chatCalls += 1
        return chatReply
      },
    },
  },
  enabled: () => true,
  heavyEnabled: () => heavySkillAllowed,
  allowlist: () => [],
  runRoot: () => skillRunRoot,
  heavyTimeoutMs: () => 30_000,
  dataRoot: () => skillRunRoot,
})
// The canvas reads the local library beside the host registry: on the Web
// surface a preset owns local discovery, so an unscoped `ctx.skills.list()` sees
// no installed skill at all. The fake above stands in for that empty answer.
canvasSkillRunner.attach({
  registry: host.createSkillRegistryBackend({
    async list() { return skillRegistrySkills },
    async get(name) {
      const found = skillRegistrySkills.find(skill => skill.name === name)
      return found === undefined ? undefined : { name, content: `# ${name}\nDo the thing.` }
    },
  }, { root: () => skillRegistryRoot }),
  agents: {
    available: () => true,
    async create(options) {
      heavyRunsStarted += 1
      return {
        session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'heavy done' }] }] },
        followup() {},
        async whenIdle() {
          // Publish the artifact the way a real skill would: into the run's
          // output directory the runner handed the agent.
          const outputDir = join(options.cwd, 'output')
          mkdirSync(outputDir, { recursive: true })
          writeFileSync(join(outputDir, 'deck.pptx'), Buffer.from('pptx-bytes'))
          // Extra artifacts a check may ask for — used to prove that one
          // unpublishable file does not take the rest of the run down with it.
          for (const [name, bytes] of heavyArtifacts) writeFileSync(join(outputDir, name), bytes)
        },
        cancel() {},
        async dispose() {},
      }
    },
  },
})
/** The skill-library backend the route family sees (kept by name so the config
 *  routes can be exercised with a scripted backend). */
const skillLibraryFake = {
  async list() {
    return await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  },
  async install(request) {
    const installed = []
    const failed = []
    let message
    for (const source of request.sources ?? []) {
      try { installed.push(host.classifySource(source).kind) }
      catch (error) { failed.push({ source, message: String(error.message) }) }
    }
    if (request.asset !== undefined) {
      // The upload route stores into the real canvas store, so read it back
      // the same way the plugin does.
      const found = await host.canvasStore.readAssets([request.asset])
      const blob = found.get(request.asset.assetId)
      if (blob === undefined) message = 'missing upload'
      else {
        try {
          installed.push(await host.installFromArchive(blob.data, skillLibraryRoot, request.name ?? 'skill', request.force === true))
        } catch (error) { message = String(error.message) }
      }
    }
    return {
      ok: installed.length > 0,
      installed,
      failed,
      library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }),
      ...message === undefined ? {} : { message },
    }
  },
  async remove(name) {
    try {
      await host.removeSkill(name, skillLibraryRoot)
      return { ok: true, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }) }
    } catch (error) {
      return { ok: false, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }), message: String(error.message) }
    }
  },
}
const routes = host.makeRoutes({
  settings: seam,
  settingsNamespace: 'imagegen',
  subscriptions: subscriptionFake,
  resolve: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' }),
  resolvePrompt: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', model: 'chat-test' }),
  history,
  templates,
  favorites,
  resolveStorage: () => ({ endpoint: storageProbeEndpoint, region: 'ap-guangzhou', accessKey: 'AKID-test', secretKey: 'secret-test', prefix: 'dsh-imagegen' }),
  attachments,
  pendingConversationImages,
  skills: canvasSkillRunner,
  skillLibrary: skillLibraryFake,
})
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find(r => r.kind === 'exact'
    ? r.path === pathname
    : pathname === r.path || pathname.startsWith(`${r.path}/`))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res).catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const post = async (path, body, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new Error(`HTTP ${response.status} returned non-JSON body: ${text || '<empty>'}`)
  }
}

await check('C0b prompt enhance strips reasoning-model <think> blocks', async () => {
  // Closed think block: only the visible answer may reach the prompt box.
  const leak = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'think leak' })
  assert.equal(leak.status, 200)
  assert.equal(leak.body.ok, true)
  assert.equal(leak.body.prompt, 'A lighthouse at dusk over a stormy sea.')
  // Dangling unclosed <think>: everything after it is reasoning, so the
  // enhancer must fail loudly instead of returning the raw reasoning text.
  const dangling = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'dangling think' })
  assert.equal(dangling.body.ok, false)
  assert.match(dangling.body.message, /only reasoning content/)
  // Clean content passes through untouched.
  const clean = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please' })
  assert.equal(clean.body.prompt, 'A calm meadow under morning light.')
  const polished = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please', mode: 'polish' })
  assert.equal(polished.body.ok, true)
  assert.equal(polished.body.prompt, 'A calm meadow under morning light.')
})

await check('C0c canvas layer decomposition parses a fenced vision plan and clamps it', async () => {
  // Unit: the normalizer accepts the documented shape, drops degenerate boxes,
  // clamps rectangles into the frame, orders background first and de-dupes it.
  assert.equal(host.normalizeLayerPlan({ layers: [] }), undefined)
  assert.equal(host.normalizeLayerPlan({ nope: 1 }), undefined)
  assert.equal(host.normalizeLayerPlan({ layers: [{ kind: 'object' }] }), undefined, 'an object layer without a rect is dropped')
  const clamped = host.normalizeLayerPlan({
    layers: [
      { kind: 'text', label: '  title  ', rect: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, text: ' hi ' },
      { kind: 'text', label: 'no text', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ],
  })
  assert.deepEqual(clamped.layers, [{ kind: 'text', label: 'title', rect: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, text: 'hi' }])
  const ordered = host.normalizeLayerPlan([
    { kind: 'object', label: 'b', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { kind: 'background', label: 'bg' },
    { kind: 'background', label: 'bg2' },
  ])
  assert.deepEqual(ordered.layers.map(layer => layer.kind), ['background', 'object'])
  assert.equal(ordered.layers[0].rect, undefined, 'the background layer carries no rect')

  // Route: the browser sends one data URL, the host answers with the plan.
  const plan = await post('/api/dsh-imagegen/canvas/layers', { image: `data:image/png;base64,${pngBytes.toString('base64')}` })
  assert.equal(plan.body.ok, true, JSON.stringify(plan.body))
  assert.deepEqual(plan.body.plan.layers.map(layer => layer.kind), ['background', 'object', 'text'])
  assert.equal(plan.body.plan.layers[2].text, '夏日限定')
  assert.equal(plan.body.plan.layers[2].color, '#ffee00', 'hex colors are normalized to lower case')
  assert.deepEqual(plan.body.plan.layers[1].rect, { x: 0.3, y: 0.25, width: 0.3, height: 0.6 })

  const missing = await post('/api/dsh-imagegen/canvas/layers', {})
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'bad-request')
  // A channel without a vision chat model fails with an actionable message.
  await assert.rejects(
    host.analyzeLayers({ apiUrl: '', apiKey: '', model: '' }, `data:image/png;base64,${pngBytes.toString('base64')}`),
    /提示词增强/,
  )
})

await check('C1 settings describe serves the redacted namespace', async () => {
  const { status, body } = await post('/api/dsh-imagegen/settings/describe', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.writable, true)
  assert.equal(body.value.namespaces.length, 1)
  const view = body.value.namespaces[0]
  assert.equal(view.ns, 'dsh-imagegen')
  assert.equal(view.value.apiUrl, 'http://upstream/v1')
  assert.equal(view.value.apiKey, undefined)
  assert.deepEqual(view.secrets, [{ path: ['apiKey'], set: false }])
})

await check('C2 settings mutate writes + redacts the key', async () => {
  const { body } = await post('/api/dsh-imagegen/settings/mutate', {
    ns: 'dsh-imagegen',
    ops: [{ op: 'set', path: ['apiKey'], value: 'sk-new' }],
    expectedRevision: 0,
  })
  assert.equal(body.ok, true)
  assert.equal(body.value.secrets.find(s => s.path[0] === 'apiKey').set, true)
  assert.equal(body.value.value.apiKey, undefined)
  assert.equal(stored.get('imagegen').apiKey, 'sk-new')
})

await check('C2b subscription status/login routes keep tokens host-side', async () => {
  const status = await post('/api/dsh-imagegen/subscription/status', {})
  assert.equal(status.body.ok, true)
  assert.equal(status.body.statuses['grok-sub'].state, 'logged-in')
  assert.equal(status.body.statuses['grok-sub'].email, 'grok@example.test')
  assert.equal(status.body.statuses['chatgpt-sub'].state, 'logged-out')
  assert.equal(status.body.statuses['openrouter-sub'].state, 'logged-out')
  const login = await post('/api/dsh-imagegen/subscription/login', { provider: 'chatgpt-sub' })
  assert.equal(login.body.ok, true)
  assert.equal(login.body.url, 'https://auth.example.test/codex')
  const logout = await post('/api/dsh-imagegen/subscription/login', { provider: 'grok-sub', action: 'logout' })
  assert.equal(logout.body.ok, true)
  assert.equal(subscriptionStatuses['grok-sub'].state, 'logged-out')
  const complete = await post('/api/dsh-imagegen/subscription/login', { provider: 'openrouter-sub', action: 'complete', input: 'http://127.0.0.1:56231/oauth/callback?code=manual&state=manual-state' })
  assert.equal(complete.body.ok, true)
  assert.equal(subscriptionStatuses['openrouter-sub'].state, 'logged-in')
})

await check('C2c subscription runtime generates without an API key', async () => {
  const runtime = new host.ImageGenerationRuntime(
    () => ({
      channels: [{
        id: 'grok-sub',
        preset: 'grok-subscription',
        name: 'Grok 订阅',
        apiUrl: '',
        apiKey: '',
        apiUrlFull: false,
        auth: 'subscription',
        subscription: 'grok-sub',
        models: [{ alias: 'grok-imagine-image-2.0', id: 'grok-imagine-image-2.0' }],
      }],
      defaultChannelId: 'grok-sub',
    }),
    { append: async () => [] },
    subscriptionFake,
  )
  const result = await runtime.run({ mode: 'text', model: 'grok-imagine-image-2.0', prompt: 'subscription cat', size: '1024x1024', quality: 'auto', n: 1, detail: '', channelId: 'grok-sub' })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(subscriptionGenerateCalls, 1)
})

await check('C2d OpenRouter OAuth image request uses the hosted credential', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const manager = new host.SubscriptionManager({
      get(name) {
        assert.equal(name, 'credentials')
        return {
          async resolve(ref) {
            assert.equal(ref, 'DSH_IMAGEGEN_OPENROUTER_OAUTH_1')
            return { value: JSON.stringify({ accessToken: 'openrouter-key', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER, label: 'OpenRouter', email: '', accountId: '' }) }
          },
        }
      },
    })
    const images = await manager.generate({ vendor: 'openrouter', prompt: 'openrouter cat' })
    assert.equal(images.length, 1)
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(calls[0].init.headers.authorization, 'Bearer openrouter-key')
    const body = JSON.parse(String(calls[0].init.body))
    assert.equal(body.model, 'google/gemini-3-pro-image')
    assert.deepEqual(body.modalities, ['image'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('C2e Grok device polling continues through authorization_pending', async () => {
  const originalFetch = globalThis.fetch
  const credentialStore = new Map()
  let tokenPolls = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return new Response(JSON.stringify({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
          interval: 1,
          expires_in: 10,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        tokenPolls += 1
        if (tokenPolls === 1) {
          return new Response(JSON.stringify({ error: 'authorization_pending', error_description: 'User has not yet authorized' }), { status: 400, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ access_token: 'grok-access', refresh_token: 'grok-refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected Grok test URL: ${url}`)
    }
    const manager = new host.SubscriptionManager({
      get(name) {
        assert.equal(name, 'credentials')
        return {
          async resolve(ref) {
            const value = credentialStore.get(ref)
            return value === undefined ? undefined : { value }
          },
          async set(ref, value) { credentialStore.set(ref, value) },
          async unset(ref) { credentialStore.delete(ref) },
        }
      },
    })
    const login = await manager.beginLogin('grok')
    assert.equal(login.code, 'ABCD-EFGH')
    const ref = host.subscriptionOauthRef('grok')
    assert.ok(await waitUntil(() => credentialStore.has(ref), 4000), 'Grok polling did not finish after authorization')
    assert.equal(tokenPolls, 2)
    assert.equal(manager.lastLoginError('grok'), undefined)
    assert.equal((await manager.loginStatus('grok')).state, 'logged-in')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('C3 generate route persists history server-side and enforces loopback fence', async () => {
  const { status, body } = await post('/api/dsh-imagegen/generate', {
    mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.images.length, 2)
  assert.equal(persistedHistory.length, 1, 'history is written before the response reaches the browser')
  assert.equal(persistedHistory[0].prompt, 'a cat')
  assert.equal(persistedHistory[0].images.length, 2)
  assert.equal(body.history.length, 1)
  const missing = await post('/api/dsh-imagegen/generate', { mode: 'text', model: 'gpt-image-2', prompt: '  ', size: 'auto', quality: 'auto', n: 1, detail: '' })
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.message, /prompt is required/)
  // Non-loopback fence: a raw request carrying a foreign Host header must be
  // refused (undici forbids overriding Host on fetch, so go raw).
  const foreignStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/dsh-imagegen/generate',
      method: 'POST',
      headers: { host: 'evil.example.com', 'content-type': 'application/json' },
    }, res => { resolve(res.statusCode) }, reject)
    request.end('{}')
  })
  assert.equal(foreignStatus, 403)
})

await check('C3b diagnostics routes read back and clear the retained attempts (#38)', async () => {
  // The panel reads this route after a failure; the record has to survive the
  // HTTP hop unchanged and stay redacted.
  host.clearDiagnostics()
  const clearedOnce = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(clearedOnce.body.ok, true)
  assert.equal(clearedOnce.body.entries.length, 0, 'a fresh buffer is empty')

  // Produce a real failed attempt through the engine, then read it back.
  host.recordDiagnostic({
    phase: 'generate',
    channel: 'SmokeChannel',
    model: 'gpt-image-2',
    mode: 'text',
    url: 'https://api.example.test/v1/images/generations',
    method: 'POST',
    status: 404,
    errorCode: 'ENOTFOUND',
    failureCode: 'upstream-rejected',
    message: 'model not found',
    bodyExcerpt: '{"error":"no such route"}',
    durationMs: 42,
    hadAuth: true,
  })
  const listed = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.entries.length, 1)
  const entry = listed.body.entries[0]
  assert.equal(entry.channel, 'SmokeChannel')
  assert.equal(entry.url, 'https://api.example.test/v1/images/generations', 'the URL the engine called reaches the panel')
  assert.equal(entry.status, 404)
  assert.equal(entry.errorCode, 'ENOTFOUND')
  assert.equal(entry.durationMs, 42)
  assert.equal(entry.hadAuth, true, 'the panel learns THAT a key was sent, never the key')

  // A secret must not survive the round trip: the store redacts on record.
  host.recordDiagnostic({
    phase: 'generate',
    channel: 'SmokeChannel',
    model: 'gpt-image-2',
    mode: 'text',
    url: 'https://api.example.test/v1/images/generations',
    method: 'POST',
    failureCode: 'upstream-unreachable',
    message: 'failed with Authorization: Bearer {{API_KEY_2iip3dvh}}',
    bodyExcerpt: '{"apiKey":"{{API_KEY_2iip3dvh}}"}',
    durationMs: 1,
    hadAuth: true,
  })
  const withSecret = await post('/api/dsh-imagegen/diagnostics/list', {})
  const serialized = JSON.stringify(withSecret.body)
  assert.equal(serialized.includes('{{API_KEY_2iip3dvh}}'), false, 'no credential survives to the client')
  assert.match(serialized, /<redacted/, 'the redaction marker is present instead')

  const cleared = await post('/api/dsh-imagegen/diagnostics/clear', {})
  assert.equal(cleared.body.ok, true)
  const afterClear = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(afterClear.body.entries.length, 0, 'the Clear action empties the record')
})

await check('C4 comparison tasks run in parallel and share comparison history metadata', async () => {
  const comparisonId = 'smoke-comparison'
  const request = { mode: 'text', model: 'gpt-image-2', prompt: 'parallel one', size: '1:1', quality: '4k', n: 1, detail: 'standard', comparisonId, comparisonModels: ['gpt-image-2', 'grok-imagine-image'] }
  const first = await post('/api/dsh-imagegen/tasks/submit', request)
  const second = await post('/api/dsh-imagegen/tasks/submit', { ...request, model: 'grok-imagine-image', prompt: 'parallel two' })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/tasks/list', {})
    const ids = [first.body.task.id, second.body.task.id]
    if (ids.every(id => listed.body.tasks.find(task => task.id === id)?.status === 'completed')) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(maxGenerationRequests >= 2, 'comparison requests must overlap at the upstream')
  const comparisonEntries = persistedHistory.filter(entry => entry.comparisonId === comparisonId)
  assert.equal(comparisonEntries.length, 2)
  assert.deepEqual(comparisonEntries[0].comparisonModels, ['gpt-image-2', 'grok-imagine-image'])
})

await check('C4b task polling stays lightweight and hydrates completed results on demand', async () => {
  const image = `data:image/png;base64,${pngBytes.toString('base64')}`
  const submitted = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'edit', model: 'gpt-image-2', prompt: 'edit this lightweight task payload', size: '3:2', quality: '4k', n: 1, detail: '',
    image, refName: 'reference.png',
  })
  assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body))
  let summary
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/tasks/list', {})
    summary = listed.body.tasks.find(task => task.id === submitted.body.task.id)
    if (summary?.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(summary?.status, 'completed')
  assert.equal(summary.result, undefined)
  assert.equal(summary.resultAvailable, true)
  assert.equal(summary.request.image, undefined)
  assert.equal(summary.request.images, undefined)

  const hydrated = await post('/api/dsh-imagegen/tasks/get', { id: submitted.body.task.id })
  assert.equal(hydrated.body.ok, true)
  assert.equal(hydrated.body.task.request.image, image)
  assert.ok(hydrated.body.task.result.images.length > 0)
  const missing = await post('/api/dsh-imagegen/tasks/get', { id: 'missing-task' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'not-found')
})
await check('C5 image model discovery and configured-model allow-list work', async () => {
  const discovered = await post('/api/dsh-imagegen/image-models', {})
  assert.equal(discovered.body.ok, true)
  // `nanobanana2` / `nanobanana2-lite` are shipped defaults whose family name
  // carries a numeric suffix with no separator; they must survive detection.
  // `gpt-4o`, `text-embedding-3-small` and the capability-flagged
  // `chat-only-model` / `gpt-image-legacy` must not appear.
  assert.deepEqual(discovered.body.models, ['glm-image', 'gpt-image-2', 'grok-imagine-image', 'nanobanana2', 'nanobanana2-lite'])
  const chatDiscovered = await post('/api/dsh-imagegen/image-models', {
    apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    apiKey: 'sk-test',
    apiUrlFull: true,
    protocol: 'auto',
  })
  assert.equal(chatDiscovered.body.ok, true)
  assert.deepEqual(chatDiscovered.body.models, ['glm-image', 'gpt-image-2', 'grok-imagine-image', 'nanobanana2', 'nanobanana2-lite'])
  const fallbackDiscovered = await post('/api/dsh-imagegen/image-models', {
    apiUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'sk-test',
    protocol: 'auto',
  })
  assert.equal(fallbackDiscovered.body.ok, true, JSON.stringify(fallbackDiscovered.body))
  assert.deepEqual(fallbackDiscovered.body.models, ['glm-image', 'gpt-image-2', 'grok-imagine-image', 'nanobanana2', 'nanobanana2-lite'])
  const presets = await post('/api/dsh-imagegen/presets', {})
  assert.equal(presets.body.ok, true)
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'openai-official').models, [{ alias: 'gpt-image-2.5', id: 'gpt-image-2.5' }, { alias: 'gpt-image-2', id: 'gpt-image-2' }])
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'zhipu-official').models, [{ alias: 'glm-image', id: 'glm-image' }])
  // The Ark preset is the one that carries BOTH catalogs: a single channel has
  // to serve Seedream images and Seedance videos, and the ids have to be the
  // real ones (the family is derived from those ids, not from the alias).
  const arkPreset = presets.body.presets.find(preset => preset.id === 'volc-ark-seedream')
  assert.ok(arkPreset.models.some(model => model.id === 'doubao-seedream-5-0-pro-260628'), 'the Ark preset ships the real image id')
  assert.deepEqual(
    arkPreset.videoModels.map(model => model.id),
    ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-1-0-pro-250528'],
    'the Ark preset ships a video catalog',
  )
  const rejected = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'not-configured', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'image-model-not-configured')
})

await check('C6 template routes are source-scoped, refresh per source, and proxy only known images', async () => {
  const { body: list } = await post('/api/dsh-imagegen/templates/list', { source: 'vibeui' })
  assert.equal(list.ok, true)
  assert.equal(list.sourceId, 'vibeui')
  assert.equal(list.total, 1)
  assert.equal(list.cases[0].prompt, 'Create a bright product poster')

  const { body: refreshed } = await post('/api/dsh-imagegen/templates/refresh', { source: 'vibeui' })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.sourceId, 'vibeui')
  assert.equal(refreshed.total, 1)
  assert.equal(templateRefreshes, 1)

  // Unknown sources are rejected before the backend is touched.
  const badSource = await post('/api/dsh-imagegen/templates/list', { source: 'nope' })
  assert.equal(badSource.body.ok, false)
  assert.equal(badSource.body.code, 'templates-source-unknown')
  assert.equal(templateRefreshes, 1)

  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/case1.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), templateImage)
  const unknown = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/not-allowed.png`)
  assert.equal(unknown.status, 404)
  // Legacy single-segment image paths are gone: the source id is required.
  const legacy = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/case1.png`)
  assert.equal(legacy.status, 404)
  const badPool = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/canghe/case1.png`)
  assert.equal(badPool.status, 404)
})

await check('C6b template favorites persist host-side and round-trip', async () => {
  const empty = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(empty.body.ok, true)
  assert.deepEqual(empty.body.favorites, [])

  const item = {
    id: 1,
    title: 'Poster template',
    prompt: 'Create a bright product poster',
    category: 'Posters & Typography',
    categoryZh: '海报与排版',
    styles: [],
    scenes: [],
    sourceLabel: '@author',
    sourceUrl: 'https://example.test/author',
    githubUrl: 'https://example.test/repo#1',
    image: 'case1.png',
    featured: true,
  }
  const added = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'vibeui', case: item })
  assert.equal(added.body.ok, true)
  assert.equal(added.body.favorites.length, 1)
  assert.equal(added.body.favorites[0].key, 'vibeui:1')
  assert.equal(added.body.favorites[0].case.prompt, item.prompt)

  const invalid = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'nope', case: item })
  assert.equal(invalid.body.ok, false)

  const relisted = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(relisted.body.favorites.length, 1)

  const removed = await post('/api/dsh-imagegen/templates/favorites/remove', { key: 'vibeui:1' })
  assert.equal(removed.body.ok, true)
  assert.deepEqual(removed.body.favorites, [])

  const stringItem = { ...item, id: 's-001', title: 'Hand-drawn template' }
  const stringAdded = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'handraw', case: stringItem })
  assert.equal(stringAdded.body.ok, true)
  assert.equal(stringAdded.body.favorites[0].key, 'handraw:s-001')
  await post('/api/dsh-imagegen/templates/favorites/remove', { key: 'handraw:s-001' })
})

await check('C6c template sample route draws random inspiration picks', async () => {
  const { body } = await post('/api/dsh-imagegen/templates/sample', { count: 9 })
  assert.equal(body.ok, true)
  assert.equal(body.samples.length, 1)
  assert.equal(body.samples[0].sourceId, 'vibeui')
  assert.equal(body.samples[0].case.prompt, 'Create a bright product poster')
  assert.deepEqual(templateSamples, [9])
})

await check('C6c2 bundled community template snapshots expose stable ids and images', async () => {
  const expected = {
    handraw: { total: 441, first: 's-001' },
    'prompt-signal': { total: 577, first: 'raw-subway' },
    // evolink used to hold 462: its case numbers repeat across — and inside —
    // the upstream category files, so keying by number alone discarded most of
    // the corpus. The ids are now category-scoped, and the snapshot carries
    // every case whose prompt parsed.
    evolink: { total: 967, first: 'ecommerce-1' },
    itgoyo: { total: 602, first: 't-001' },
    songtianlun: { total: 55, first: 'nb2-magazine-cover' },
    // youart publishes no images of its own — only each author's post — so its
    // cards are prompt-only by design and this source is exempt from the image
    // assertion below.
    youart: { total: 150, first: '16-panel-female-dance-pose-sheet' },
  }
  for (const [sourceId, meta] of Object.entries(expected)) {
    const list = await host.listTemplates(sourceId)
    assert.equal(list.sourceId, sourceId)
    assert.equal(list.total, meta.total)
    assert.equal(list.cases[0].id, meta.first)
    if (sourceId === 'youart') {
      assert.equal(list.cases[0].image, '', 'youart cases carry no image by design')
      assert.match(list.cases[0].sourceUrl, /^https:\/\/x\.com\//, 'the author post is the attribution')
      continue
    }
    assert.match(list.cases[0].image, /^https:\/\//)
  }
})

await check('C6c3 every bundled snapshot keeps its ids unique', async () => {
  // A snapshot whose ids collide silently loses cases: templates-store keys
  // favourites by `source:id`, and the gallery keys cards by id, so duplicates
  // render as one card and overwrite each other's favourite. The host half of
  // this contract lives in verify-ui-contracts.mjs, where it can read the real
  // `allowedImageHosts` out of SOURCE_DEFS instead of a copy of that list.
  //
  // Two image shapes are legal and they are served differently: a bare file
  // name goes through the source's `imageBaseUrl` (vibeui / canghe), anything
  // else must be an absolute http(s) URL with no credentials. youart is absent
  // because it publishes no images at all.
  for (const sourceId of ['vibeui', 'canghe', 'handraw', 'prompt-signal', 'evolink', 'itgoyo', 'songtianlun']) {
    const list = await host.listTemplates(sourceId)
    assert.ok(list.total > 0, `${sourceId} must not be empty`)
    const ids = list.cases.map(entry => entry.id)
    assert.equal(new Set(ids).size, ids.length, `${sourceId} has duplicate case ids`)
    for (const entry of list.cases) {
      if (entry.image === '') continue
      const bareName = /^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(entry.image)
      // Parsed, not pattern-matched: jsdelivr's pinned URLs carry an `@commit`
      // in the path, so treating a bare `@` as userinfo rejected the handraw
      // snapshot outright. What actually matters is that the URL has no
      // credentials, which only the parser can tell.
      let absolute = false
      if (/^https?:\/\//i.test(entry.image)) {
        try {
          const url = new URL(entry.image)
          absolute = url.username === '' && url.password === '' && url.hostname !== ''
        } catch { absolute = false }
      }
      assert.ok(
        bareName || absolute,
        `${sourceId} case ${entry.id} carries an image reference this store cannot serve: ${entry.image}`,
      )
    }
  }
})


await check('C6c4 PPT routes validate the request and rebuild asset URLs host-side', async () => {
  // The client sends asset ids only; the URL is rebuilt on the host so a caller
  // cannot point the conversion at an arbitrary address. Both halves are
  // asserted: the malformed inputs are refused, and a well-formed one produces
  // a URL on this host's asset route rather than the one it was handed.
  const tooMany = await post('/api/dsh-imagegen/ppt/run', {
    images: Array.from({ length: 13 }, (_, i) => ({ assetId: `a${i}` })),
    offlineOcr: true,
  })
  assert.equal(tooMany.body.ok, false, '13 images must be refused')
  assert.equal(tooMany.body.code, 'bad-request', JSON.stringify(tooMany.body))

  const none = await post('/api/dsh-imagegen/ppt/run', { images: [], offlineOcr: true })
  assert.equal(none.body.code, 'bad-request', 'zero images must be refused')

  const badId = await post('/api/dsh-imagegen/ppt/run', {
    images: [{ assetId: '../etc/passwd' }],
    offlineOcr: true,
  })
  assert.equal(badId.body.code, 'bad-request', 'an asset id with path syntax must be refused')

  const missingOcr = await post('/api/dsh-imagegen/ppt/run', { images: [{ assetId: 'ok-1' }] })
  assert.equal(missingOcr.body.code, 'bad-request', 'offlineOcr is required, not defaulted')

  // Without a usable editppt setup the route must say what is missing instead
  // of starting a run that cannot finish. Two refusals are legitimate here —
  // the runtime is not installed, or the skill itself is not — so the assertion
  // is "refused, with a reason naming what to fix", not one exact message.
  const run = await post('/api/dsh-imagegen/ppt/run', { images: [{ assetId: 'ok-1' }], offlineOcr: true })
  assert.equal(run.body.ok, false, JSON.stringify(run.body))
  assert.match(String(run.body.message), /PPT runtime|editppt|image-to-editable-ppt|技能/i, JSON.stringify(run.body))

  const runtime = await post('/api/dsh-imagegen/ppt/runtime', {})
  assert.equal(typeof runtime.body.ok, 'boolean', JSON.stringify(runtime.body))

  // The task list is served whenever the host mounted the skill registry, which
  // this suite does. An empty list is the correct answer here — what must hold
  // is that the route answers with tasks rather than failing.
  const tasks = await post('/api/dsh-imagegen/ppt/tasks', {})
  assert.equal(tasks.body.ok, true, JSON.stringify(tasks.body))
  assert.ok(Array.isArray(tasks.body.tasks), 'the task list is always an array')
})

await check('C6d data-folder route resolves the host directory (no spawn in tests)', async () => {
  const { body } = await post('/api/dsh-imagegen/data-folder/open', { open: false })
  assert.equal(body.ok, true)
  // Assert the property that actually matters: the route resolves the SAME data
  // root the stores use. This suite points DSH_HOME at a temp directory, so the
  // old `includes('.dsh')` assertion only passed because the route hardcoded
  // `~/.dsh/dsh-imagegen` — it certified the bug, not the behaviour. Anything
  // that pins the literal home path would pass here while ignoring DSH_HOME and
  // a custom localStoragePath, which is exactly the defect being guarded.
  const dataRoot = process.env.DSH_HOME
  assert.ok(dataRoot !== undefined && dataRoot !== '', 'this suite must set DSH_HOME')
  assert.ok(
    String(body.path).startsWith(dataRoot),
    `resolved path stays under DSH_HOME (got ${String(body.path)}, DSH_HOME=${dataRoot})`,
  )
  assert.ok(String(body.path).endsWith('dsh-imagegen'), 'resolved path is the dsh-imagegen data dir')
})

await check('C6e storage test route signs and uploads a probe object', async () => {
  const uploads = []
  const probe = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'PUT' && url.pathname === '/dsh-imagegen/ping.txt') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      uploads.push({
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
        amzDate: req.headers['x-amz-date'],
        payloadHash: req.headers['x-amz-content-sha256'],
      })
      res.writeHead(200)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  storageProbeEndpoint = `http://127.0.0.1:${probe.address().port}`
  try {
    const { body } = await post('/api/dsh-imagegen/storage/test', {})
    assert.equal(body.ok, true, `probe upload must succeed: ${JSON.stringify(body)}`)
    assert.equal(typeof body.ms, 'number')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].body, 'dsh-imagegen storage ok')
    assert.ok(String(uploads[0].authorization).startsWith('AWS4-HMAC-SHA256 Credential=AKID-test/'), 'SigV4 credential scope is present')
    assert.ok(uploads[0].amzDate !== undefined && uploads[0].payloadHash !== undefined)
  } finally {
    storageProbeEndpoint = ''
    await new Promise(resolve => probe.close(resolve))
  }
})

await check('C7 Agent tool-result image route serves durable attachments without a session-log image reference', async () => {
  const query = new URLSearchParams({
    attachment_id: agentPreviewRef.attachmentId,
    media_type: agentPreviewRef.mediaType,
    bytes: String(agentPreviewRef.bytes),
    width: String(agentPreviewRef.width),
    height: String(agentPreviewRef.height),
  })
  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?${query}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), agentPreviewImage)
  const invalid = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?attachment_id=bad`)
  assert.equal(invalid.status, 400)
})

await check('C8 composer images can be staged for the direct edit_image command', async () => {
  const staged = await post('/api/dsh-imagegen/conversation-image', {
    sessionId: 'session-staged',
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    name: 'staged.png',
  })
  assert.equal(staged.body.ok, true)
  assert.equal(pendingConversationImages.has('session-staged'), true)
  assert.equal(pendingConversationImages.get('session-staged').mediaType, 'image/png')
})

await check('C9 Agent tools wait for results, keep images in the UI view, edit, and enforce the allow setting', async () => {
  const tools = new Map()
  const saved = new Map()
  let serial = 0
  const attachmentStore = {
    async saveImages(images) {
      return images.map((image) => {
        assert.equal(image.mediaType, 'image/png', 'attachment media type must match the encoded image bytes')
        const attachmentId = `attachment-${++serial}`
        const ref = { attachmentId, mediaType: image.mediaType, bytes: image.data.byteLength, width: 1, height: 1, name: image.name }
        saved.set(attachmentId, { ref, data: image.data })
        return ref
      })
    },
    async readImage(ref) {
      lastReadImageAttachmentId = ref.attachmentId
      const storedImage = saved.get(ref.attachmentId)
      assert.ok(storedImage, 'the returned source_image must resolve through the attachment store')
      return storedImage
    },
  }
  let enabled = true
  let lastReadImageAttachmentId
  const sent = []
  const agent = { send: (...args) => { sent.push(args) } }
  const runtime = new host.ImageGenerationRuntime(
    () => ({
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
      defaultChannelId: 'default',
    }),
    { append: async () => [] },
  )
  const dispose = host.registerAgentImageTools({
    tools: { register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
    attachments: attachmentStore,
  }, runtime, () => ({
    enabled: true,
    allowAgentImageGeneration: enabled,
    defaultChannelId: 'default',
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'configured',
      apiKey: 'configured',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
    }],
  }))
  try {
    const generated = await tools.get('generate_image').execute({ prompt: 'a mismatch cat', size: '1:1', quality: '4k', detail: 'standard' }, { agent })
    assert.equal(generated.status, 'completed', 'the Agent tool waits for the task to finish')
    assert.equal(generated.images.length, 2)
    const generatedRendered = tools.get('generate_image').output.render({ prompt: 'a cat' }, generated)
    assert.equal(generatedRendered.filter(block => block.type === 'image').length, 0, 'generated images stay out of model-facing tool content')
    const generatedArgs = { prompt: 'a cat' }
    const generatedMeta = tools.get('generate_image').output.presentationMeta(generatedArgs, generated)
    const generatedView = tools.get('generate_image').presentResult(generatedArgs, {
      content: generatedRendered,
      isError: false,
      meta: generatedMeta,
    })
    assert.equal(generatedView?.card, 'generic')
    assert.equal(generatedView?.content?.filter(block => block.type === 'image').length, 2, 'completed tool results keep image attachments in the UI view')
    assert.equal(saved.size, 2, 'completed generation stores attachments once')
    assert.equal(sent.length, 0, 'completion does not inject a conversation message')
    const complete = await tools.get('get_image_generation_task').execute({ task_id: generated.task_id }, {})
    assert.equal(complete.status, 'completed')
    assert.equal(complete.images.length, 2)
    assert.equal(saved.size, 2, 'status lookup reuses the completion attachments instead of saving duplicate files')

    const background = await tools.get('generate_image').execute({ prompt: 'a background cat', size: '1:1', quality: '4k', detail: 'standard', wait_for_completion: false }, { agent })
    assert.ok(background.status === 'queued' || background.status === 'running', 'background mode returns before completion')
    assert.equal(sent.length, 0, 'background mode also does not inject a conversation message')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtime.queue.list().find(task => task.id === background.task_id)?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(runtime.queue.list().find(task => task.id === background.task_id)?.status, 'completed')
    const backgroundComplete = await tools.get('get_image_generation_task').execute({ task_id: background.task_id }, {})
    assert.equal(backgroundComplete.status, 'completed')
    assert.equal(saved.size, 4)

    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat', model: 'grok-imagine-image' }, {}),
      /not configured/,
    )

    const edited = await tools.get('edit_image').execute({ prompt: 'edit this', source_image: complete.images[0], size: '3:2', quality: '2k' }, { signal: new AbortController().signal })
    assert.equal(edited.status, 'completed', 'image edits also wait for completion')
    assert.equal(edited.images.length, 1)
    const editedRendered = tools.get('edit_image').output.render({ prompt: 'edit this' }, edited)
    assert.equal(editedRendered.filter(block => block.type === 'image').length, 0, 'edit_image output stays out of model-visible image context')
    assert.equal(saved.size, 5)

    const commands = new Map()
    const pending = new Map()
    const commandDispose = host.registerEditImageCommand({
      commands: { register: definition => { commands.set(definition.name, definition); return () => { commands.delete(definition.name) } } },
      attachments: attachmentStore,
    }, runtime, () => ({
      enabled: true,
      allowAgentImageGeneration: true,
      defaultChannelId: 'default',
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: 'configured',
        apiKey: 'configured',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
    }), {
      get: sessionId => pending.get(sessionId),
      consume: (sessionId, ref) => { if (pending.get(sessionId)?.attachmentId === ref.attachmentId) pending.delete(sessionId) },
    })
    try {
      assert.ok(commands.has('edit_image'), 'the /edit_image command is registered')
      const command = commands.get('edit_image')
      assert.deepEqual(command.input, { hint: 'Describe how to modify the latest image', images: true }, 'the command accepts composer images')
      const noImageAgent = { session: { deriveMessages: () => [] } }
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: '   ', signal: new AbortController().signal }), {
        kind: 'error',
        text: '请提供图片修改描述，例如：/edit_image 把背景改成夜景',
      })
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: 'edit this', signal: new AbortController().signal }), {
        kind: 'error',
        text: '当前对话没有可用图片，请先上传图片或把画廊图片加入对话。',
      })
      const commandSource = complete.images[0]
      const commandReference = {
        attachmentId: commandSource.attachment_id,
        mediaType: commandSource.media_type,
        bytes: commandSource.bytes,
        width: commandSource.width,
        height: commandSource.height,
        name: commandSource.name,
      }
      const commandAgent = { session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } }
      const commandResult = await command.handler({ agent: commandAgent, rawInput: 'edit via command', signal: new AbortController().signal })
      assert.equal(commandResult.kind, 'success')
      assert.match(commandResult.text, /图片编辑已完成/)
      assert.equal(sent.length, 0, 'slash command does not send a chat-model message')
      const invocationReference = { ...commandReference, attachmentId: `sha256:${'d'.repeat(64)}` }
      saved.set(invocationReference.attachmentId, { ref: invocationReference, data: pngBytes })
      const invocationResult = await command.handler({
        agent: noImageAgent,
        attachments: [{ type: 'image', attachment: invocationReference }],
        rawInput: 'edit attached image',
        signal: new AbortController().signal,
      })
      assert.equal(invocationResult.kind, 'success', 'an image carried by the command reaches the plugin edit path')
      assert.equal(lastReadImageAttachmentId, invocationReference.attachmentId, 'the invocation image is used as the edit source')
      const pendingRef = { ...commandReference, attachmentId: `sha256:${'c'.repeat(64)}` }
      saved.set(pendingRef.attachmentId, { ref: pendingRef, data: pngBytes })
      pending.set('pending-session', pendingRef)
      const pendingResult = await command.handler({
        agent: { id: 'pending-session', session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } },
        rawInput: 'edit via command',
        signal: new AbortController().signal,
      })
      assert.equal(pendingResult.kind, 'success', 'staged composer image is accepted without a chat message')
      assert.equal(lastReadImageAttachmentId, pendingRef.attachmentId, 'the staged image takes precedence over older session history')
      assert.equal(pending.has('pending-session'), false, 'staged image is consumed after a successful edit')
    } finally {
      commandDispose()
    }

    const aborted = new AbortController()
    aborted.abort(new Error('test cancellation'))
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'cancel this' }, { signal: aborted.signal }),
      /test cancellation/,
    )
    assert.equal(runtime.queue.list().find(task => task.request.prompt === 'cancel this')?.status, 'cancelled')

    enabled = false
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat' }, {}),
      /disabled in Settings → Image settings/,
    )
  } finally {
    dispose()
  }
})

await check('C10 canvas file upload accepts arbitrary bytes and serves them as an attachment', async () => {
  const bytes = Buffer.from('name,role\nalice,admin\n', 'utf8')
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=people.csv`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: bytes,
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.asset.kind, 'file')
  assert.equal(body.asset.name, 'people.csv')
  assert.equal(body.asset.bytes, bytes.length)
  assert.equal(body.asset.mime, 'text/csv')
  assert.match(body.asset.url, /^\/api\/dsh-imagegen\/canvas\/asset\/[a-f0-9]{64}\.csv$/)

  // Non-image assets download rather than render inline.
  const served = await fetch(`http://127.0.0.1:${port}${body.asset.url}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'application/octet-stream')
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.match(served.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(await served.text(), bytes.toString('utf8'))
})

await check('C10b canvas file upload refuses executable extensions with an actionable message', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=payload.exe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('MZ'),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(String(body.message), /不支持|not supported|\.exe/i)

  // Uploads carry no byte limit inside the raw-body reader other than the cap:
  // a name that sanitizes to nothing still lands under a safe fallback.
  const odd = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent('../..\\evil.txt')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('ok'),
  })
  const oddBody = await odd.json()
  assert.equal(oddBody.ok, true, JSON.stringify(oddBody))
  assert.equal(oddBody.asset.name.includes('/'), false)
  assert.equal(oddBody.asset.name.includes('\\'), false)
})

await check('C10c a file node round-trips through canvas save with its asset intact', async () => {
  const asset = recordCanvasFile(Buffer.from('报告正文\n', 'utf8'), 'text/plain', 'report.txt')
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'files' })
  const document = created.body.document
  assert.equal(document.background, 'lines', 'new canvases default to the lightweight grid background')
  const fileNode = {
    id: 'node-file-1',
    type: 'file',
    title: 'report.txt',
    x: 40,
    y: 60,
    width: 300,
    height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, fileNode] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
  const storedNode = saved.body.document.nodes.find(node => node.id === 'node-file-1')
  assert.equal(storedNode.type, 'file')
  assert.equal(storedNode.metadata.asset.assetId, asset.assetId)
  assert.equal(storedNode.metadata.fileKind, 'text')
})

await check('C10c3 a video node round-trips through canvas save (every CanvasNodeType must)', async () => {
  // WHY this exists: the canvas node guard used to accept only image/text/file/
  // config, while `CanvasNodeType` (protocol.ts) also declares 'video'. That
  // mismatch did not reject a document — it made every canvas holding a video
  // node UNSAVABLE ('malformed canvas document'). No suite caught it because
  // the canvas-video suite answers /canvas/save with a stub that records the
  // payload, so the real guard never ran on a video node. This check goes
  // through the real route and the real store, like C10c does for file nodes.
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'video nodes' })
  const document = created.body.document

  // The three states a video node legitimately has: a finished clip, one still
  // rendering, and one that failed. Only the reference is validated, and its
  // absence must not make the document malformed.
  const nodes = [
    {
      id: 'node-video-clip', type: 'video', title: '视频节点', x: 40, y: 40, width: 240, height: 240,
      metadata: { status: 'success', videoMode: 'text', video: { url: '/api/dsh-imagegen/video/file/clip.mp4', mime: 'video/mp4', duration: 5, bytes: 1024, entryId: 'entry-1' } },
    },
    {
      id: 'node-video-rendering', type: 'video', title: '视频节点', x: 40, y: 340, width: 240, height: 240,
      metadata: { status: 'generating', taskId: 'vt-1', prompt: 'still rendering', model: 'agnes-video-2.5-flash', videoMode: 'text' },
    },
    {
      id: 'node-video-failed', type: 'video', title: '视频节点', x: 340, y: 40, width: 240, height: 240,
      metadata: { status: 'error', error: '上游拒绝了这个请求', videoMode: 'image' },
    },
  ]
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, ...nodes] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `a canvas with video nodes must save: ${JSON.stringify(saved.body)}`)
  const stored = saved.body.document.nodes.filter(node => node.type === 'video')
  assert.equal(stored.length, 3, 'all three video nodes survive the save')
  const clip = stored.find(node => node.id === 'node-video-clip')
  assert.equal(clip.metadata.video.url, '/api/dsh-imagegen/video/file/clip.mp4')
  assert.equal(clip.metadata.video.entryId, 'entry-1')
  assert.equal(clip.metadata.videoMode, 'text')

  // Read it back through the list route too: the guard runs on the way in AND
  // on the way out, and a node that only survived one direction is still broken.
  const reopened = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.equal(reopened.body.ok, true)
  assert.equal(
    reopened.body.document.nodes.filter(node => node.type === 'video').length, 3,
    'the video nodes are still there when the canvas is reopened',
  )
})

await check('C10c4 a poster recipe round-trips, and a broken one is refused', async () => {
  // The poster editor (ported from upstream v1.7.0) writes its layer recipe into
  // `metadata.poster`. The recipe is host-validated rather than trusted, because
  // it comes back from the browser and drives a canvas the host then paints.
  // Without this check the guard's two directions are unproven: a valid recipe
  // could be rejected (posters never save) and an invalid one accepted (a
  // document that fails to render, or renders something the user never drew).
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'poster recipe' })
  const document = created.body.document
  // The recipe may only point at immutable host canvas assets: a content-hashed
  // id, the host's own asset URL, a whitelisted image MIME. That rule is why a
  // recipe can be replayed later without the image changing under it.
  const assetId = `${'a'.repeat(64)}.png`
  const asset = { assetId, url: `/api/dsh-imagegen/canvas/asset/${assetId}`, mime: 'image/png', width: 1200, height: 1600, bytes: 2048 }
  const poster = {
    version: 1,
    width: 1200,
    height: 1600,
    background: asset,
    layers: [
      {
        id: 'layer-text', type: 'text', x: 80, y: 120, width: 900,
        text: '秋季新品', fontSize: 128, fontFamily: 'sans-serif', color: '#111111', bold: true, align: 'left',
      },
      { id: 'layer-logo', type: 'image', x: 980, y: 60, width: 160, height: 160, asset },
    ],
  }
  const node = { id: 'node-poster', type: 'image', title: '海报成品', x: 40, y: 40, width: 300, height: 400, metadata: { status: 'success', asset, poster } }

  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, node] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `a canvas with a poster recipe must save: ${JSON.stringify(saved.body)}`)
  const stored = saved.body.document.nodes.find(candidate => candidate.id === 'node-poster')
  assert.equal(stored.metadata.poster.layers.length, 2, 'both layers survive the round trip')
  assert.equal(stored.metadata.poster.layers[0].type, 'text')
  assert.equal(stored.metadata.poster.width, 1200)

  const reopened = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.equal(reopened.body.document.nodes.find(candidate => candidate.id === 'node-poster').metadata.poster.layers.length, 2,
    'the recipe is intact when the canvas is read back')

  // Two refusals, both of which would otherwise corrupt a stored poster: a
  // recipe with no layers array (the renderer iterates it), and one pointing at
  // a remote URL instead of a host asset (it would break the moment the remote
  // file moves, and the host never agreed to fetch it).
  const broken = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...reopened.body.document,
      nodes: [{ ...node, metadata: { ...node.metadata, poster: { version: 1, width: 1200, height: 1600, background: asset } } }],
    },
    expectedRevision: reopened.body.document.revision,
  })
  assert.equal(broken.body.ok, false, `a recipe without layers must be refused: ${JSON.stringify(broken.body)}`)
  const remote = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...reopened.body.document,
      nodes: [{
        ...node,
        metadata: {
          ...node.metadata,
          poster: { ...poster, background: { ...asset, url: 'https://example.com/elsewhere.png' } },
        },
      }],
    },
    expectedRevision: reopened.body.document.revision,
  })
  assert.equal(remote.body.ok, false, `a recipe pointing off-host must be refused: ${JSON.stringify(remote.body)}`)

  // The whole guard, not just two of its edges: each entry below is a recipe the
  // renderer would either crash on or draw something the user never made, so a
  // save that accepts one of them corrupts a stored poster instead of failing.
  const unchanged = { id: 'legacy-image', type: 'image', title: '旧节点', x: 0, y: 0, width: 240, height: 240, metadata: { asset, status: 'success' } }
  const withLegacy = { ...reopened.body.document, nodes: [unchanged, node] }
  const baseline = await post('/api/dsh-imagegen/canvas/save', { document: withLegacy, expectedRevision: reopened.body.document.revision })
  assert.equal(baseline.body.ok, true, `a legacy image node beside a poster still saves: ${JSON.stringify(baseline.body)}`)
  assert.deepEqual(baseline.body.document.nodes[0], unchanged, 'a recipe never rewrites the plain image node beside it')
  const revision = baseline.body.document.revision
  const layer = poster.layers[0]
  for (const [label, broken] of [
    ['width 0', { ...poster, width: 0 }],
    ['height past the cap', { ...poster, height: 999999 }],
    ['null font size', { ...poster, layers: [{ ...layer, fontSize: null }] }],
    ['4001-character text', { ...poster, layers: [{ ...layer, text: 'x'.repeat(4001) }] }],
    ['a remote image layer', { ...poster, layers: [{ ...poster.layers[1], asset: { ...asset, url: 'https://example.test/logo.png' } }] }],
    ['41 layers', { ...poster, layers: Array.from({ length: 41 }, (_, index) => ({ ...layer, id: `text-${index}` })) }],
  ]) {
    const result = await post('/api/dsh-imagegen/canvas/save', {
      document: { ...withLegacy, nodes: [unchanged, { ...node, metadata: { ...node.metadata, poster: broken } }] },
      expectedRevision: revision,
    })
    assert.equal(result.body.ok, false, `a recipe with ${label} must be refused: ${JSON.stringify(result.body)}`)
  }
  // None of those refusals may have replaced the document that is on disk.
  const afterRefusals = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.deepEqual(afterRefusals.body.document.nodes.find(candidate => candidate.id === 'legacy-image'), unchanged)
  assert.deepEqual(
    afterRefusals.body.document.nodes.find(candidate => candidate.id === node.id).metadata.poster,
    poster,
    'an invalid save leaves the stored recipe intact',
  )
})

await check('C10c5 deleting a canvas keeps the assets a poster recipe still points at', async () => {
  // `sweepAssets` collects references from the node graph, and a poster node
  // only *carries* the flattened composite in `metadata.asset`. Its background
  // and its logo layers live in `metadata.poster`, which no node points at
  // directly -- yet the editor re-renders from exactly those files. Without
  // counting them, the first canvas a user deletes wipes the base image behind
  // every poster they made, and re-opening one shows an empty stage with the
  // layers floating on it. The sweep itself must keep working: an asset nothing
  // references still has to go.
  const upload = async (bytes, width, height) => {
    const uploaded = await post('/api/dsh-imagegen/canvas/asset/upload', {
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height, origin: 'upload',
    })
    assert.equal(uploaded.body.ok, true, JSON.stringify(uploaded.body))
    return uploaded.body.asset
  }
  const background = await upload(pngBytes, 640, 640)
  const logo = await upload(Buffer.concat([pngBytes, Buffer.from('a logo, hashed apart')]), 96, 96)
  const composite = await upload(Buffer.concat([pngBytes, Buffer.from('the flattened poster')]), 640, 640)
  const orphan = await upload(Buffer.concat([pngBytes, Buffer.from('nothing points here')]), 32, 32)

  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'poster assets' })
  const document = created.body.document
  const poster = {
    version: 1, width: 640, height: 640, background,
    layers: [{ id: 'layer-logo', type: 'image', asset: logo, x: 16, y: 16, width: 96, height: 96 }],
  }
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...document,
      nodes: [{
        id: 'node-poster-assets', type: 'image', title: '海报成品', x: 0, y: 0, width: 640, height: 640,
        metadata: { asset: composite, status: 'success', poster },
      }],
    },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `the poster canvas must save: ${JSON.stringify(saved.body)}`)

  // Any canvas deletion runs the sweep; use a throwaway page so the poster
  // canvas above is the only thing holding those references.
  const doomed = await post('/api/dsh-imagegen/canvas/create', { title: 'doomed canvas' })
  const removed = await post('/api/dsh-imagegen/canvas/remove', { id: doomed.body.document.id })
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body))

  const served = async asset => (await fetch(`http://127.0.0.1:${port}${asset.url}`)).status
  assert.equal(await served(background), 200, 'the poster background was deleted by the sweep')
  assert.equal(await served(logo), 200, 'the poster logo layer was deleted by the sweep')
  assert.equal(await served(composite), 200, 'the flattened composite was deleted by the sweep')
  assert.equal(await served(orphan), 404, 'an asset nothing references is still collected')

  await post('/api/dsh-imagegen/canvas/remove', { id: document.id })
})

await check('C10c2 canvas favorites persist across saves and project lists', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'favorite canvas' })
  const document = created.body.document
  const before = await post('/api/dsh-imagegen/canvas/list', {})
  assert.equal(before.body.projects.find(project => project.id === document.id)?.favorite, undefined)

  const favorited = await post('/api/dsh-imagegen/canvas/favorite', { id: document.id, favorite: true })
  assert.equal(favorited.body.ok, true, JSON.stringify(favorited.body))
  assert.equal(favorited.body.projects.find(project => project.id === document.id)?.favorite, true)

  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, title: 'favorite canvas saved' },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
  const after = await post('/api/dsh-imagegen/canvas/list', {})
  assert.equal(after.body.projects.find(project => project.id === document.id)?.favorite, true, 'saving must preserve the favorite marker')

  const unfavorited = await post('/api/dsh-imagegen/canvas/favorite', { id: document.id, favorite: false })
  assert.equal(unfavorited.body.ok, true, JSON.stringify(unfavorited.body))
  assert.equal(unfavorited.body.projects.find(project => project.id === document.id)?.favorite, undefined)
  await post('/api/dsh-imagegen/canvas/remove', { id: document.id })
})

/** Upload one file through the real route, exactly like the browser does. */
const uploadCanvasFile = async (name, mime, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': mime },
    body,
  })
  const parsed = await response.json()
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  return parsed.asset
}

/** Ask the host for one asset's structured preview (node metadata as hints). */
const canvasFilePreview = async asset => {
  const response = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: asset.assetId, name: asset.name, mime: asset.mime })
  assert.equal(response.body.ok, true, JSON.stringify(response.body))
  return response.body.preview
}

await check('C10d a canvas file preview decodes text, tables and office documents', async () => {
  const textPreview = await canvasFilePreview(await uploadCanvasFile('notes.txt', 'text/plain', Buffer.from('line one\nline two\n', 'utf8')))
  assert.equal(textPreview.kind, 'text')
  assert.match(textPreview.text, /line two/)
  assert.ok(textPreview.lines >= 2, 'line count reported')

  const tablePreview = await canvasFilePreview(await uploadCanvasFile('people.csv', 'text/csv', Buffer.from('name,role\nalice,admin\nbob,viewer\n', 'utf8')))
  assert.equal(tablePreview.kind, 'table')
  assert.deepEqual(tablePreview.rows[0], ['name', 'role'])
  assert.deepEqual(tablePreview.rows[2], ['bob', 'viewer'])
  assert.equal(tablePreview.totalRows, 3)
  assert.equal(tablePreview.truncated, false)

  // RFC4180 quoting: separators and newlines inside quotes stay in one cell.
  const quotedPreview = await canvasFilePreview(await uploadCanvasFile('quoted.csv', 'text/csv', Buffer.from('a,b\n"x,1","y\n2"\n', 'utf8')))
  assert.deepEqual(quotedPreview.rows[1], ['x,1', 'y\n2'])

  // DOCX: the OOXML body is inflated and its paragraphs keep their order.
  const docx = buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/document.xml', body: '<w:document><w:body><w:p><w:r><w:t>季度报告</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>' },
  ])
  const docxPreview = await canvasFilePreview(await uploadCanvasFile('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx))
  assert.equal(docxPreview.kind, 'document')
  assert.equal(docxPreview.format, 'docx')
  assert.equal(docxPreview.blocks.length, 2, 'both paragraphs survive as blocks')
  assert.equal(docxPreview.blocks[0].type, 'paragraph')
  assert.match(docxPreview.blocks[0].runs.map(run => run.text).join(''), /季度报告/)
  assert.match(docxPreview.blocks[1].runs.map(run => run.text).join(''), /Second paragraph/)

  // XLSX: shared strings resolve into a grid instead of a wall of XML.
  const xlsx = buildZip([
    { name: 'xl/sharedStrings.xml', body: '<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', body: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>97</v></c></row></sheetData></worksheet>' },
  ])
  const sheetPreview = await canvasFilePreview(await uploadCanvasFile('scores.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx))
  assert.equal(sheetPreview.kind, 'table')
  assert.deepEqual(sheetPreview.rows[0], ['Name', 'Score'])
  assert.deepEqual(sheetPreview.rows[1], ['Ada', '97'])

  // Markdown decodes whole so the client can render it as rich text.
  const mdPreview = await canvasFilePreview(await uploadCanvasFile('readme.md', 'text/markdown', Buffer.from('# 计划\n\n**加粗** and `code`\n', 'utf8')))
  assert.equal(mdPreview.kind, 'markdown')
  assert.match(mdPreview.markdown, /# 计划/)
  assert.equal(mdPreview.truncated, false)

  const missing = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: 'nope.csv' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'not-found')
})

await check('C10d2 rich previews reconstruct html / svg / docx layouts and pptx slides', () => {
  // The upload gate keeps HTML/SVG out of the store, so these go straight to
  // the preview builder — the same function the route calls with store bytes.
  const preview = (name, mime, data) => host.buildFilePreview({ data, mime, name, url: 'asset-url' })

  // HTML is handed over untouched: the client renders it in a sandboxed iframe.
  const html = preview('page.html', 'text/html', Buffer.from('<!doctype html><html><body><h1>你好</h1><script>alert(1)</script></body></html>', 'utf8'))
  assert.equal(html.kind, 'html')
  assert.match(html.html, /<h1>你好<\/h1>/)
  assert.match(html.html, /<script>/)

  // SVG likewise; the browser renders it through an `<img>` (no script runs).
  const svg = preview('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 'utf8'))
  assert.equal(svg.kind, 'svg')
  assert.match(svg.svg, /<rect/)

  // DOCX layout: heading level, bold/italic runs, numbered list, table grid.
  const richDocx = preview('plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/numbering.xml', body: '<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>' },
    { name: 'word/document.xml', body: '<w:document><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目计划</w:t></w:r></w:p>'
      + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>'
      + '<w:p/>' // Word-style empty spacer paragraph between blocks
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>' },
  ]))
  assert.equal(richDocx.kind, 'document')
  const [heading, paragraph, list, table] = richDocx.blocks
  assert.deepEqual(heading, { type: 'heading', level: 1, runs: [{ text: '项目计划' }] })
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(paragraph.runs, [{ text: '加粗', bold: true }, { text: '斜体', italic: true }])
  assert.deepEqual(list, { type: 'list', ordered: true, items: [[{ text: '第一项' }], [{ text: '第二项' }]] })
  assert.deepEqual(table, { type: 'table', rows: [['A1', 'B1']] })

  // PPTX: one card per slide, title placeholder split from body lines, and
  // embedded raster pictures ride along as data URLs.
  const deck = preview('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>'
      + '<a:p><a:r><a:t>营收增长</a:t></a:r></a:p><a:p><a:r><a:t>成本下降</a:t></a:r></a:p>'
      + '</p:txBody></p:sp>'
      + '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
      + '</p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>' },
    { name: 'ppt/media/image1.png', body: pngBytes },
    { name: 'ppt/slides/slide2.xml', body: '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>结尾页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ]))
  assert.equal(deck.kind, 'slides')
  assert.equal(deck.format, 'pptx')
  assert.equal(deck.slides.length, 2)
  assert.equal(deck.slides[0].title, '季度回顾')
  assert.deepEqual(deck.slides[0].lines, ['营收增长', '成本下降'])
  assert.equal(deck.slides[0].images.length, 1)
  assert.equal(deck.slides[0].images[0].mime, 'image/png')
  assert.equal(deck.slides[0].images[0].data, `data:image/png;base64,${pngBytes.toString('base64')}`)
  assert.deepEqual(deck.slides[1], { lines: ['结尾页'], images: [] })

  // Vector metafiles (EMF) cannot render in an <img>, so they are dropped.
  const emfDeck = preview('legacy.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId2" Target="../media/image1.emf"/></Relationships>' },
    { name: 'ppt/media/image1.emf', body: '\u0001\u0002emf' },
  ]))
  assert.equal(emfDeck.kind, 'slides')
  assert.equal(emfDeck.slides[0].images.length, 0)
})

await check('C10e a canvas file preview lists archives and reports opaque binaries', async () => {
  const archive = buildZip([
    { name: 'docs/', body: '' },
    { name: 'docs/a.txt', body: 'hello' },
    { name: 'b.bin', body: 'xxxxx' },
  ])
  const archivePreview = await canvasFilePreview(await uploadCanvasFile('bundle.zip', 'application/zip', archive))
  assert.equal(archivePreview.kind, 'archive')
  assert.equal(archivePreview.totalEntries, 3)
  assert.deepEqual(archivePreview.entries.map(entry => entry.name), ['docs/', 'docs/a.txt', 'b.bin'])
  assert.equal(archivePreview.entries[0].dir, true)
  assert.equal(archivePreview.entries[1].size, 5)
  assert.equal(archivePreview.truncated, false)

  // A PDF and media ask the browser to render the asset itself.
  const pdfPreview = await canvasFilePreview(await uploadCanvasFile('paper.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8')))
  assert.equal(pdfPreview.kind, 'media')
  assert.equal(pdfPreview.media, 'pdf')
  assert.match(pdfPreview.url, /\?inline=1$/)

  const audioPreview = await canvasFilePreview(await uploadCanvasFile('track.mp3', 'audio/mpeg', Buffer.from('ID3fakeaudio')))
  assert.equal(audioPreview.kind, 'media')
  assert.equal(audioPreview.media, 'audio')

  // An opaque binary says so, with a machine-readable reason for the browser.
  const blob = await canvasFilePreview(await uploadCanvasFile('blob.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3])))
  assert.equal(blob.kind, 'none')
  assert.equal(blob.reason, 'unsupported')
  assert.equal(typeof blob.format, 'string')
})

await check('C10f previewable assets serve inline with byte ranges, markup never does', async () => {
  const base = `http://127.0.0.1:${port}`
  const bytes = Buffer.from('%PDF-1.4\nsecond page\n%%EOF\n', 'utf8')
  const pdf = await uploadCanvasFile('inline.pdf', 'application/pdf', bytes)
  const png = await uploadCanvasFile('inline.png', 'image/png', pngBytes)
  assert.match(png.url, /\.png$/)
  const inlinePng = await fetch(`${base}${png.url}`)
  assert.equal(inlinePng.headers.get('content-type'), 'image/png')
  assert.match(inlinePng.headers.get('content-disposition') ?? '', /^inline/)
  assert.deepEqual(Buffer.from(await inlinePng.arrayBuffer()), pngBytes)

  // Plain requests keep the attachment contract the upload path promises.
  const download = await fetch(`${base}${pdf.url}`)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment/)

  // ?inline=1 unlocks the browser's own renderer for the documented types.
  const inline = await fetch(`${base}${pdf.url}?inline=1`)
  assert.equal(inline.headers.get('content-type'), 'application/pdf')
  assert.match(inline.headers.get('content-disposition') ?? '', /^inline/)
  assert.equal(inline.headers.get('accept-ranges'), 'bytes')
  assert.equal(await inline.text(), bytes.toString('utf8'))

  // Media seeking needs real range answers.
  const ranged = await fetch(`${base}${pdf.url}?inline=1`, { headers: { range: 'bytes=0-7' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${bytes.length}`)
  assert.equal(await ranged.text(), '%PDF-1.4')

  // A range that cannot be satisfied is told so (RFC 7233) instead of silently
  // receiving the whole body with a 200.
  const unsatisfiable = await fetch(`${base}${pdf.url}?inline=1`, { headers: { range: 'bytes=999999-' } })
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${bytes.length}`)

  // Text-shaped assets travel as JSON previews, never as an inline response.
  const csv = await uploadCanvasFile('inline.csv', 'text/csv', Buffer.from('a,b\n', 'utf8'))
  const csvInline = await fetch(`${base}${csv.url}?inline=1`)
  assert.equal(csvInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(csvInline.headers.get('content-disposition') ?? '', /^attachment/)

  // An HTML-shaped payload may sit in the store (a declared type can slip past
  // the name check) but can never render in the app's origin.
  const markup = await uploadCanvasFile('evil.txt', 'text/html', Buffer.from('<html><script>alert(1)</script></html>', 'utf8'))
  const markupInline = await fetch(`${base}${markup.url}?inline=1`)
  assert.equal(markupInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(markupInline.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(markupInline.headers.get('x-content-type-options'), 'nosniff')
})

await check('C11 the skill catalog merges built-ins with local skills and tiers external ones', async () => {
  skillRegistrySkills.length = 0
  skillRegistrySkills.push(
    { name: 'image-to-editable-ppt', description: 'Rebuild slides as an editable deck', path: 'C:/skills/ppt/SKILL.md' },
    { name: 'summarize-notes', description: 'Turn notes into a short brief', metadata: { tier: 'light' } },
  )
  const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(listed.body.ok, true, JSON.stringify(listed.body))
  const ids = listed.body.skills.map(skill => skill.id)
  assert.ok(ids.includes('polish.text'), `missing polish.text in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('ppt.fromImages'), `missing ppt.fromImages in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing ppt skill in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:summarize-notes'), `missing summarize-notes in ${JSON.stringify(ids)}`)
  const ppt = listed.body.skills.find(skill => skill.id === 'skill:image-to-editable-ppt')
  assert.equal(ppt.tier, 'heavy', JSON.stringify(ppt))
  assert.equal(ppt.origin, 'external', JSON.stringify(ppt))
  const notes = listed.body.skills.find(skill => skill.id === 'skill:summarize-notes')
  assert.equal(notes.tier, 'light', JSON.stringify(notes))
  assert.equal(listed.body.agentAvailable, true, JSON.stringify(listed.body))
  assert.equal(listed.body.registryAvailable, true, JSON.stringify(listed.body))
})

await check('C11a the host registry adapter hides user-only skills and narrows summaries', async () => {
  const adapter = host.createSkillRegistryBackend({
    async list() {
      return [
        { name: 'visible', description: 'a model-invocable skill', invocation: { modelInvocable: true, userInvocable: true }, metadata: { tier: 'heavy' }, path: 'C:/s/visible/SKILL.md' },
        { name: 'user-only', description: 'slash command only', invocation: { modelInvocable: false, userInvocable: true } },
        { name: 'undeclared', description: 'provider omitted the policy', extra: 'dropped' },
      ]
    },
    async get(name) {
      return name === 'visible' ? { name, content: '# visible', metadata: { canvasTier: 'light' } } : undefined
    },
  })
  const listed = await adapter.list()
  assert.deepEqual(listed.map(skill => skill.name), ['visible', 'undeclared'])
  assert.equal(listed[0].path, 'C:/s/visible/SKILL.md')
  assert.deepEqual(listed[0].metadata, { tier: 'heavy' })
  assert.equal('extra' in listed[1], false)
  const body = await adapter.get('visible')
  assert.equal(body.content, '# visible')
  assert.deepEqual(body.metadata, { canvasTier: 'light' })
  assert.equal(await adapter.get('user-only'), undefined)
})

await check('C11b a lightweight skill run answers through the chat model and drafts a text node', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'polish' })
  const document = created.body.document
  const textNode = {
    id: 'node-text-1', type: 'text', title: 'draft', x: 0, y: 0, width: 280, height: 150,
    metadata: { text: 'hello world', fontSize: 14 },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [textNode] })
  const before = chatCalls
  chatReply = 'Hello, world.'
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'polish.text',
    nodeIds: ['node-text-1'],
    params: { style: 'formal' },
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  // The run-card rebuild path: tasks carry their input ids and a machine phase.
  assert.deepEqual(run.body.task.nodeIds, ['node-text-1'])
  assert.equal(['queued', 'running'].includes(run.body.task.phase), true, JSON.stringify(run.body.task))
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  // The finished snapshot keeps nodeIds so a reload can still rebuild context.
  assert.deepEqual(snapshot.nodeIds, ['node-text-1'])
  // A canvas-scoped listing only reports unfinished runs.
  const drained = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: document.id })
  assert.equal(drained.body.ok, true)
  assert.deepEqual(drained.body.tasks, [], 'finished runs are not listed as live')
  const unknown = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: 'canvas-none' })
  assert.deepEqual(unknown.body.tasks, [])
  assert.equal(chatCalls, before + 1)
  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'text')
  assert.equal(produced.metadata.text, 'Hello, world.')
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, ['node-text-1'])
  assert.equal(snapshot.output.connections[0].fromNodeId, 'node-text-1')
  assert.equal(snapshot.output.connections[0].toNodeId, produced.id)
})

await check('C11c extract.content reads an uploaded text file without spending a chat call', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'extract' })
  const document = created.body.document
  const asset = recordCanvasFile(Buffer.from('第一行\n第二行\n', 'utf8'), 'text/plain', 'notes.txt')
  const fileNode = {
    id: 'node-file-2', type: 'file', title: 'notes.txt', x: 0, y: 0, width: 300, height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [fileNode] })
  const before = chatCalls
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'extract.content',
    nodeIds: ['node-file-2'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(chatCalls, before)
  assert.equal(snapshot.output.nodes[0].type, 'text')
  assert.match(snapshot.output.nodes[0].metadata.text, /第一行/)
})

await check('C11d heavy skills refuse to start without the agent runtime, then produce a file node', async () => {  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'deck' })
  const document = created.body.document
  const imageNode = {
    id: 'node-image-1', type: 'image', title: 'slide-1', x: 0, y: 0, width: 240, height: 240,
    metadata: {
      asset: { assetId: 'img-1', url: '/api/dsh-imagegen/canvas/asset/' + 'a'.repeat(64) + '.png', mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', kind: 'image', name: 'img-1.png' },
      status: 'success',
    },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [imageNode] })

  // The built-in deck conversion disappears from the catalog when the agent
  // runtime is not available, so the run fails instead of silently no-oping.
  heavySkillAllowed = false
  const disabled = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(disabled.body.agentAvailable, false)
  heavySkillAllowed = true

  const before = heavyRunsStarted
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at.
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at (`<assetId>.<extension>`).
  canvasBlobs.set('img-1.png', { data: pngBytes, mime: 'image/png' })
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'ppt.fromImages',
    nodeIds: ['node-image-1'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 200 && snapshot.status !== 'completed' && snapshot.status !== 'failed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(heavyRunsStarted, before + 1)
  const produced = snapshot.output.nodes.find(node => node.type === 'file')
  assert.ok(produced !== undefined, 'the deck artifact became a file node')
  assert.match(String(produced.metadata.asset.name), /\.pptx$/)
})

await check('C11d2 an unpublishable artifact is skipped, not a lost run', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'deck-with-junk' })
  const document = created.body.document
  const imageNode = {
    id: 'node-image-2', type: 'image', title: 'slide-1', x: 0, y: 0, width: 240, height: 240,
    metadata: {
      asset: { assetId: 'img-2', url: '/api/dsh-imagegen/canvas/asset/' + 'b'.repeat(64) + '.png', mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', kind: 'image', name: 'img-2.png' },
      status: 'success',
    },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [imageNode] })
  canvasBlobs.set('img-2.png', { data: pngBytes, mime: 'image/png' })

  // A skill that writes an executable-shaped artifact beside its real one: the
  // store refuses the `.svg`, and before the per-file catch that refusal
  // unwound the whole run — the deck was thrown away and the task failed.
  heavyArtifacts = [['chart.svg', Buffer.from('<svg/>', 'utf8')]]
  try {
    const run = await post('/api/dsh-imagegen/canvas/skills/run', {
      canvasId: document.id,
      skillId: 'ppt.fromImages',
      nodeIds: ['node-image-2'],
    })
    assert.equal(run.body.ok, true, JSON.stringify(run.body))
    const taskId = run.body.task.id
    let snapshot = run.body.task
    for (let attempt = 0; attempt < 200 && snapshot.status !== 'completed' && snapshot.status !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
    }
    assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
    const names = snapshot.output.nodes.filter(node => node.type === 'file').map(node => String(node.metadata.asset.name))
    assert.deepEqual(names, ['deck.pptx'], `the good artifact still landed: ${JSON.stringify(names)}`)
    const skipped = snapshot.output.warnings.find(line => line.includes('chart.svg'))
    assert.ok(skipped !== undefined, `the skipped artifact is reported: ${JSON.stringify(snapshot.output.warnings)}`)
    assert.match(skipped, /chart\.svg/)
  } finally {
    heavyArtifacts = []
  }
})

await check('C11e an unknown skill id and a missing canvas fail with copy, not a crash', async () => {
  const unknown = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: 'nope', skillId: 'skill:does-not-exist', nodeIds: [],
  })
  assert.equal(unknown.body.ok, false)
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'gone' })
  const missing = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: `missing-${created.body.document.id}`, skillId: 'polish.text', nodeIds: ['x'],
  })
  assert.equal(missing.body.ok, false)
  assert.ok(typeof missing.body.message === 'string' && missing.body.message.length > 0)
})

await check('C11f skill routes answer in the caller language and reject unknown hints', async () => {
  const zh = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'zh' })
  const en = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'en' })
  const bogus = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'not-a-locale' })
  const nameOf = (body, id) => body.skills.find(skill => skill.id === id).name
  assert.equal(nameOf(zh.body, 'polish.text'), '文本润色')
  assert.equal(nameOf(en.body, 'polish.text'), 'Polish text')
  // An unknown/absent hint falls back to the host resolver, never a raw key.
  assert.equal(nameOf(bogus.body, 'polish.text'), '文本润色')
  assert.ok(zh.body.reason === undefined || !String(zh.body.reason).includes('canvas.skills.'))
})

await check('C11g a scope-blind host registry still offers the local skill library', async () => {
  // The user's exact situation: the skill is installed under the local root,
  // while the registry the host-plane plugin can query answers nothing (on the
  // Web surface a preset owns local discovery, so the global layer is empty).
  const previous = [...skillRegistrySkills]
  skillRegistrySkills.length = 0
  const bundle = (name, body) => {
    mkdirSync(join(skillRegistryRoot, name), { recursive: true })
    writeFileSync(join(skillRegistryRoot, name, 'SKILL.md'), body)
  }
  const names = ['image-to-editable-ppt', 'local-worker', 'Bad_Name', 'user-only-thing']
  try {
    bundle('image-to-editable-ppt', '---\nname: image-to-editable-ppt\ndescription: Rebuild slides\n---\n\n# Deck\n')
    bundle('local-worker', '---\nname: local-worker\ndescription: Local notes worker\n---\n\n# Local\n\nlocal body marker\n')
    // Entries the host registry would drop: never offered to a node.
    bundle('Bad_Name', '---\nname: Bad_Name\ndescription: Wrong name shape\n---\n\n# Bad\n')
    bundle('user-only-thing', '---\nname: user-only-thing\ndescription: Slash command only\ndisable-model-invocation: true\n---\n\n# Human\n')

    const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
    const ids = listed.body.skills.map(skill => skill.id)
    assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing the installed deck skill in ${JSON.stringify(ids)}`)
    assert.ok(ids.includes('skill:local-worker'), `missing the local skill in ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:Bad_Name'), false, `a non-kebab name must not be offered: ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:user-only-thing'), false, `a user-only skill must not be offered: ${JSON.stringify(ids)}`)
    // The built-in deck action keys its install hint off this list: the skill IS
    // installed, so the picker must stop telling the user to install it.
    assert.deepEqual([...listed.body.installed].sort(), ['image-to-editable-ppt', 'local-worker'])

    // The body loads from disk too, so a run is not silently instruction-less.
    const adapter = host.createSkillRegistryBackend({ async list() { return [] }, async get() { return undefined } }, { root: () => skillRegistryRoot })
    const definition = await adapter.get('local-worker')
    assert.equal(definition.name, 'local-worker')
    assert.match(definition.content, /local body marker/)
    assert.equal(await adapter.get('Bad_Name'), undefined)
    // A registry entry still wins a name collision (deployment outranks a user install).
    const merged = host.createSkillRegistryBackend({
      async list() { return [{ name: 'local-worker', description: 'registry wins', path: 'C:/repo/local-worker/SKILL.md' }] },
      async get() { return { name: 'local-worker', content: 'registry body' } },
    }, { root: () => skillRegistryRoot })
    assert.equal((await merged.list()).find(skill => skill.name === 'local-worker').description, 'registry wins')
    assert.equal((await merged.get('local-worker')).content, 'registry body')
  } finally {
    for (const name of names) rmSync(join(skillRegistryRoot, name), { recursive: true, force: true })
    skillRegistrySkills.push(...previous)
    // Leave the catalog a later check sees as the registry-only one again.
    const restored = await post('/api/dsh-imagegen/canvas/skills/list', {})
    assert.equal(restored.body.skills.some(skill => skill.id === 'skill:local-worker'), false)
  }
})

await check('C11h a heavy run composes its agent with the preset roster and a model route', async () => {
  // Creating an agent is not enough: on the Web surface every model-facing row
  // lives behind a preset, and the model route is not implied by the request.
  const seen = { sections: [] }
  const created = await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        seen.options = options
        // The real factory runs setup before it publishes the agent.
        await options.setup({
          systemPrompt: { section: input => seen.sections.push(input) },
        })
        return {
          agent: {
            session: { deriveMessages: () => [] },
            followup() { seen.delivered = true },
            async whenIdle() {},
            cancel(cause) { seen.cancelled = cause },
          },
          async dispose() {},
        }
      },
    },
    presets: {
      async resolve(id) { seen.resolvedWith = id; return { id: 'standard' } },
      async mount(_ctx, id) { seen.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'packyapi', model: 'deepseek-flash' }) },
    agentPreset: '',
    sessionId: 'skillagent-smoke',
    cwd: 'C:/runs/smoke',
    systemPrompt: 'SKILL BODY',
    fail: key => `copy:${key}`,
  })
  assert.equal(seen.resolvedWith, undefined, 'an empty setting must ask for the deployment default')
  assert.deepEqual(seen.options.agentOptions, { provider: 'packyapi', model: 'deepseek-flash' })
  assert.equal(seen.options.meta.agentPreset, 'standard')
  assert.equal(seen.options.meta.origin, 'subagent')
  assert.equal(seen.options.meta.cwd, 'C:/runs/smoke')
  assert.equal(seen.mounted, 'standard', 'the agent must join the preset, or it runs tool-less')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].text, 'SKILL BODY')
  assert.equal(seen.sections[0].name, 'plugin:dsh-imagegen:canvas-skill')
  // Driving the handle narrows the DSH agent to what a run needs.
  created.followup('go')
  assert.equal(seen.delivered, true)
  created.cancel()
  assert.deepEqual(seen.cancelled, { kind: 'user' })
  await created.dispose()

  // A configured preset name wins over the deployment default.
  const named = {}
  await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        await options.setup({ systemPrompt: { section() {} } })
        return { agent: { session: { deriveMessages: () => [] }, followup() {}, async whenIdle() {}, cancel() {} }, async dispose() {} }
      },
    },
    presets: {
      async resolve(id) { named.resolvedWith = id; return { id: id ?? 'standard' } },
      async mount(_ctx, id) { named.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPreset: 'deck-runner',
    sessionId: 'x',
    cwd: 'c',
    systemPrompt: 's',
    fail: key => key,
  })
  assert.equal(named.resolvedWith, 'deck-runner')
  assert.equal(named.mounted, 'deck-runner')

  // Without a default model the run fails with copy instead of starting a
  // model-less agent that dies on its first step.
  await assert.rejects(
    () => host.createCanvasSkillAgent({
      agents: { async create() { throw new Error('must not be reached') } },
      defaultModel: { currentSelection: () => ({}) },
      agentPreset: '',
      sessionId: 'x',
      cwd: 'c',
      systemPrompt: 's',
      fail: key => `copy:${key}`,
    }),
    /copy:canvas\.skills\.needModel/,
  )
})

await check('C11i a contained host Agent failure is surfaced instead of a missing-file error', async () => {
  // The driver contains a failed turn: `whenIdle` resolves normally and the
  // reason only exists as a retained event. Reading it is what turns
  // "the skill produced no final PPTX" into "the model API returned 401" —
  // and the key inside that message must not reach the panel.
  let listener
  const marker = '401 ' + ['sk', 'fake', '123456789'].join('-')
  const created = await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        await options.setup({
          on(name, callback) { if (name === 'agent/error') listener = callback },
          systemPrompt: { section() {} },
        })
        return {
          agent: {
            session: { deriveMessages: () => [] },
            followup() {},
            async whenIdle() {
              listener({ agent: { id: 'failure-test' }, error: new Error(`Model API returned ${marker}`) })
            },
            cancel() {},
          },
          async dispose() {},
        }
      },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPreset: '',
    sessionId: 'failure-test',
    cwd: 'c',
    systemPrompt: 's',
  })
  await assert.rejects(
    created.whenIdle(),
    error => {
      assert.match(error.message, /401/, 'the model error survives instead of being replaced by "no output"')
      assert.ok(!error.message.includes(marker), 'the key inside the model error is redacted')
      return true
    },
  )
  await created.dispose()
})

// Two reports from real use, both invisible to a jsdom render:
//  1. A multi-line prompt showed up as one squashed line, so the user could not
//     read back what they had generated from.
//  2. Dropping an image into the edit-reference strip left the host's drag
//     overlay ("drop files here") stuck on screen: the host counts dragenter/
//     dragleave on document and only resets when document receives the drop, so
//     a stopPropagation() in between leaves that counter permanently above zero.
await check('C15 history prompts keep their line breaks and plugin drops reach the host', async () => {
  const panelCss = readFileSync(new URL('../src/client/panel.module.css', import.meta.url), 'utf8')
  const promptRule = panelCss.slice(panelCss.indexOf('.historyPrompt {'), panelCss.indexOf('.historyMeta')) || ''
  assert.ok(promptRule !== '', 'the history prompt rule is findable')
  assert.match(promptRule, /-webkit-line-clamp:\s*2/, 'the sidebar history prompt is clamped to 2 lines to keep cards balanced')
  const resultPromptRule = panelCss.slice(panelCss.indexOf('.canvasPromptText {'), panelCss.indexOf('.grid {')) || ''
  assert.ok(resultPromptRule !== '', 'the canvas prompt rule above the result image is findable')
  assert.match(resultPromptRule, /white-space:\s*pre-wrap/, 'the result image prompt line preserves user newlines')
  // A real drag is not reproducible in jsdom, so the invariant is what gets
  // checked: every drop handler this plugin registers lets the event bubble.
  for (const file of ['ReferenceImages.tsx', 'ReplicaWorkspace.tsx', 'PptWorkspace.tsx', 'ImageGenPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/onDrop=\{[^}]*\}/g)) {
      assert.ok(!/stopPropagation/.test(match[0]), `${file} drop handlers must not stop propagation (the host drag overlay would never reset)`)
    }
  }
})

// PPT checkpoints and live progress: the deck pipeline needs two guarantees —
// a Windows replacement lock can never lose a checkpoint, and the progress card
// reports only what the upstream run directory actually recorded.
await check('C11ppt-progress exposes real host activity and validated page records without model reasoning or tool output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-progress-'))
  const events = []
  const session = { get seq() { return events.length }, eventAt(index) { return events[index] }, deriveMessages: () => [] }
  const task = { id: 'skillrun-progress', canvasId: 'ppt', startedAt: Date.now(), pptImages: [{}, {}] }
  const monitor = new host.PptProgressMonitor(task, session, root, host.canvasSkillCopy('zh'))
  try {
    events.push({ type: 'step/start', data: { turn: 1, step: 1 } }, { type: 'tool/call', data: { callId: 'shell-1', name: 'shell', arguments: JSON.stringify({ command: 'editppt page hints --token sk-secret-do-not-show' }) } })
    await monitor.refresh()
    assert.match(task.progress.currentOperation, /shell/)
    assert.match(task.progress.currentOperation, /文字提示/)
    events.push({ type: 'tool/result', data: { message: { callId: 'shell-1', isError: true, content: [{ type: 'text', text: 'tool-secret-output' }] } } }, { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private-model-reasoning' }] } } })
    await monitor.refresh()
    assert.ok(task.progress.events.some(event => event.state === 'warning'))
    const jobs = { pages: [{ status: 'recorded', result: { validation_passed: true } }, { status: 'dispatched', result: { validation_passed: false } }] }
    writeFileSync(join(root, 'page_jobs.json'), JSON.stringify(jobs))
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({ status: 'pages_dispatched' }))
    await monitor.refresh()
    assert.deepEqual(task.progress.pages.map(page => page.state), ['validated', 'running'])
    assert.equal(task.progress.upstreamStage, 'pages_dispatched')
    const count = task.progress.events.length, activity = task.progress.lastActivityAt
    await monitor.refresh()
    assert.equal(task.progress.events.length, count, 'polling unchanged files does not invent progress')
    assert.equal(task.progress.lastActivityAt, activity, 'polling does not reset the last actual activity time')
    jobs.pages[1] = { status: 'accepted', result: { validation_passed: true } }
    writeFileSync(join(root, 'page_jobs.json'), JSON.stringify(jobs))
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({ status: 'deck_validated' }))
    await monitor.refresh()
    assert.equal(task.progress.pages.filter(page => page.state === 'validated').length, 2)
    assert.equal(task.status, undefined, 'upstream page records cannot mark the overall task completed')
    const serialized = JSON.stringify(task.progress)
    for (const secret of ['sk-secret', 'tool-secret-output', 'private-model-reasoning']) assert.ok(!serialized.includes(secret))
    assert.ok(!serialized.includes('%'), 'there is no fabricated percentage')
    await monitor.stop()
    const stoppedCount = task.progress.events.length
    events.push({ type: 'step/start', data: {} })
    await monitor.refresh()
    assert.equal(task.progress.events.length, stoppedCount, 'cancelled or settled monitors cannot emit late progress')
  } finally { await monitor.stop(); rmSync(root, { recursive: true, force: true }) }
})
await check('C11ppt-store immutable checkpoints survive Windows replacement locks, overlapping writes and partial files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-checkpoint-'))
  let activeWrites = 0, maximumWrites = 0, renames = 0
  const io = { ...fsPromises,
    async rename() { renames++; throw Object.assign(new Error('Windows destination sharing violation'), { code: 'EPERM' }) },
    async writeFile(...args) { activeWrites++; maximumWrites = Math.max(maximumWrites, activeWrites); try { await new Promise(r => setTimeout(r, 10)); return await fsPromises.writeFile(...args) } finally { activeWrites-- } },
  }
  const store = new host.PptTaskStore(() => root, io)
  const task = { id: 'skillrun-lock-test', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT', tier: 'heavy', status: 'queued', startedAt: 1 }
  try {
    mkdirSync(join(root, 'ppt-tasks'))
    writeFileSync(join(root, 'ppt-tasks', task.id + '.json'), JSON.stringify(task))
    const first = store.write(task)
    task.status = 'running'
    const second = store.write(task)
    task.status = 'completed'; task.finishedAt = 3
    const third = store.write(task)
    await Promise.all([first, second, third])
    assert.equal(renames, 0, 'PPT persistence must not replace a locked Windows destination')
    assert.equal(maximumWrites, 1, 'writes for the same task are serialized')
    const names = await fsPromises.readdir(join(root, 'ppt-tasks'))
    const snapshots = await Promise.all(names.filter(n => n !== task.id + '.json').sort().map(n => fsPromises.readFile(join(root, 'ppt-tasks', n), 'utf8').then(JSON.parse)))
    assert.deepEqual(snapshots.map(t => t.status), ['queued', 'running', 'completed'], 'each queued write captures its own immutable state')
    writeFileSync(join(root, 'ppt-tasks', `${task.id}.${Date.now()+60000}.dead-beef.json`), '{"status":')
    writeFileSync(join(root, 'ppt-tasks', `${task.id}.json.dead-beef.tmp`), '{"status":')
    const restored = await new host.PptTaskStore(() => root).list()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].status, 'completed', 'partial checkpoints cannot hide the preceding complete snapshot')
    assert.equal(JSON.parse(readFileSync(join(root, 'ppt-tasks', task.id+'.json'), 'utf8')).status, 'queued', 'the legacy record was never overwritten')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

await check('C11ppt standalone PPT validates input, preserves order, persists results and rejects incomplete outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-conversion-'))
  const assets = ['first.png', 'second.png'].map(assetId => ({
    assetId, url: `/api/dsh-imagegen/canvas/asset/${assetId}`, mime: 'image/png',
    bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', name: assetId,
  }))
  let mode = 'ok'
  let stopped = 0
  let recordedPrompt = ''
  const recordedInputs = []
  let release
  const backend = {
    ...canvasBackend,
    async readAsset(id) {
      return assets.some(asset => asset.assetId === id) ? { data: pngBytes, mime: 'image/png' } : undefined
    },
    async materialize(asset, target) {
      recordedInputs.push([asset.assetId, target])
      writeFileSync(target, pngBytes)
    },
  }
  const options = {
    backend: { canvas: backend },
    enabled: () => true,
    heavyEnabled: () => true,
    allowlist: () => [],
    runRoot: () => root,
    dataRoot: () => root,
    heavyTimeoutMs: () => 30_000,
    pptCommand: async () => '/test/python/bin/editppt',
  }
  const runner = new host.SkillRunner(options)
  const registry = {
    async list() { return [{ name: 'image-to-editable-ppt', description: 'PPT skill', path: '/upstream/image-to-editable-ppt/SKILL.md' }] },
    async get() { return { name: 'image-to-editable-ppt', content: '# upstream body\nFollow upstream commands.' } },
  }
  runner.attach({
    registry,
    agents: {
      available: () => true,
      async create(createOptions) {
        recordedPrompt = createOptions.systemPrompt
        return {
          session: {
            get seq() { return mode === 'agent-error' ? 1 : 0 },
            eventAt() {
              return { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'Provider unavailable sk-private123456789' } } } }
            },
            deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'agent result' }] }],
          },
          followup() {},
          async whenIdle() {
            if (mode === 'hold') await new Promise(resolve => { release = resolve })
            if (mode === 'no-deck' || mode === 'agent-error') return
            const slides = mode === 'wrong-count' ? 1 : 2
            const deck = mode === 'bad-zip' ? Buffer.from('not-a-pptx') : buildZip([
              { name: 'ppt/presentation.xml', body: '<p:presentation/>' },
              ...Array.from({ length: slides }, (_, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, body: '<p:sld><p:sp>Editable text</p:sp></p:sld>' })),
            ])
            if (mode === 'upstream-final' || mode === 'unvalidated-final') {
              // The editppt skill finalizes outside the output dir this runner
              // hands it; only a completed, validated run may be collected.
              const final = join(createOptions.cwd, 'output', 'upstream-run', 'final')
              mkdirSync(final, { recursive: true })
              writeFileSync(join(final, 'deck_edited.pptx'), deck)
              writeFileSync(join(final, 'validation.json'), JSON.stringify({ passed: mode === 'upstream-final' }))
              writeFileSync(join(final, 'run_summary.json'), JSON.stringify({
                status: 'complete', page_count: 2, output: join(final, 'deck_edited.pptx'), validation: join(final, 'validation.json'),
              }))
            } else writeFileSync(join(createOptions.cwd, 'output', 'final.pptx'), deck)
          },
          cancel() { stopped += 1; release?.() },
          async dispose() {},
        }
      },
    },
  })
  const wait = async task => {
    for (let index = 0; index < 200 && ['running', 'queued'].includes(task.status); index++) await new Promise(resolve => setTimeout(resolve, 10))
    return task
  }
  try {
    await assert.rejects(runner.runPpt({ images: [], offlineOcr: true }), /1.?12|图片|images/)
    await assert.rejects(runner.runPpt({ images: [{ ...assets[0], assetId: 'missing' }], offlineOcr: true }), /图片|image/i)
    const task = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(task.status, 'completed', JSON.stringify(task))
    assert.deepEqual(recordedInputs.slice(0, 2).map(([id]) => id), ['first.png', 'second.png'], 'slide order follows the upload order')
    assert.match(recordedPrompt, /upstream body/)
    assert.match(recordedPrompt, /\/upstream\/image-to-editable-ppt\/SKILL.md/)
    assert.match(recordedPrompt, /\/test\/python\/bin\/editppt/)
    assert.match(recordedPrompt, /prepare --no-text-hints/, 'the offline OCR choice reaches the skill untouched')
    assert.ok(task.output.nodes.some(node => node.metadata.asset?.name === 'final.pptx'))
    // Final persistence finishes just after the terminal status becomes visible.
    await new Promise(resolve => setTimeout(resolve, 30))
    const restarted = new host.SkillRunner(options)
    const restored = await restarted.pptTasks()
    assert.equal(restored[0].id, task.id)
    assert.equal(restored[0].status, 'completed')
    assert.ok(restored[0].agentSessionId?.startsWith('skillagent-'), 'the conversion history names its agent session')
    assert.ok(restored[0].runDirectory?.includes(task.id), 'the conversion history names its run directory')
    assert.equal(restored[0].output.nodes[0].metadata.asset.name, 'final.pptx')
    for (const bad of ['bad-zip', 'wrong-count', 'no-deck']) {
      mode = bad
      const failed = await wait(await runner.runPpt({ images: assets, offlineOcr: false, language: 'en' }))
      assert.equal(failed.status, 'failed', bad)
      assert.ok(failed.error, `${bad} reports why it failed`)
    }
    mode = 'upstream-final'
    const recovered = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered))
    assert.ok(recovered.output.nodes.some(node => node.metadata.asset?.name === 'deck_edited.pptx'), 'the skill final deck is collected')
    mode = 'unvalidated-final'
    const unvalidated = await wait(await runner.runPpt({ images: assets, offlineOcr: true }))
    assert.equal(unvalidated.status, 'failed', 'a final deck without a passing validation report must not become successful')
    mode = 'agent-error'
    const providerError = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(providerError.status, 'failed')
    assert.match(providerError.error, /NO_ADAPTER/)
    assert.ok(!providerError.error.includes('sk-private123456789'), 'provider error secrets are redacted')
    mode = 'hold'
    const live = await runner.runPpt({ images: assets, offlineOcr: true })
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const queued = await runner.runPpt({ images: assets, offlineOcr: true })
    assert.equal(await runner.cancel(queued.id), true)
    assert.equal(queued.status, 'cancelled')
    assert.equal(await runner.cancel(live.id), true)
    assert.equal(live.status, 'cancelled')
    assert.equal(stopped, 1, 'the running agent is cancelled exactly once')
    await new Promise(resolve => setTimeout(resolve, 30))
    // A run interrupted by a restart is reported as interrupted, not left running.
    writeFileSync(join(root, 'ppt-tasks', 'skillrun-interrupted.json'), JSON.stringify({ ...task, id: 'skillrun-interrupted', status: 'running' }))
    const afterRestart = await restarted.pptTasks()
    assert.equal(afterRestart.find(item => item.id === 'skillrun-interrupted').status, 'failed')
    assert.ok(afterRestart.find(item => item.id === 'skillrun-interrupted').error)
    const noAgent = new host.SkillRunner(options)
    await assert.rejects(noAgent.runPpt({ images: assets, offlineOcr: true }))
  } finally {
    release?.()
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C11ppt routes refuse bad sources and expose durable conversion history', async () => {
  for (const body of [{ images: [], offlineOcr: true }, { images: [{ assetId: '../escape' }], offlineOcr: true }, { images: [{ assetId: 'x.png' }] }]) {
    const result = await post('/api/dsh-imagegen/ppt/run', body)
    assert.equal(result.body.ok, false, JSON.stringify(body))
    assert.equal(result.body.code, 'bad-request')
  }
  const list = await post('/api/dsh-imagegen/ppt/tasks', {})
  assert.equal(list.body.ok, true)
  assert.ok(Array.isArray(list.body.tasks))
})

// ------------------------------------------- C12. local skill library

/** Minimal stored-method ZIP writer (the reader validates structure, not CRC). */
function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, 'utf8')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0, 14) // crc (unused by the reader)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, body)
    const head = Buffer.alloc(46 + name.length)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(0, 10) // stored
    head.writeUInt32LE(0, 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(body.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(offset, 42)
    name.copy(head, 46)
    central.push(head)
    offset += local.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

await check('C12 install sources are classified without touching the network', () => {
  assert.deepEqual({ ...host.classifySource('https://github.com/ningzimu/image-to-editable-ppt-skill') }, {
    kind: 'github', owner: 'ningzimu', repo: 'image-to-editable-ppt-skill', ref: '', subpath: '',
  })
  // A blob/tree URL keeps its ref and subfolder so the bundle (not the file) installs.
  assert.deepEqual({ ...host.classifySource('https://github.com/o/r/tree/main/skills/deck') }, {
    kind: 'github', owner: 'o', repo: 'r', ref: 'main', subpath: 'skills/deck',
  })
  const raw = host.classifySource('https://raw.githubusercontent.com/o/r/main/SKILL.md')
  assert.equal(raw.kind, 'raw')
  assert.equal(raw.name, 'SKILL')
  assert.equal(host.classifySource('https://example.com/bundle.zip').kind, 'archive')
  assert.equal(host.classifySource('https://git.example.com/team/skill.git').kind, 'git')
  // Names are folder names: anything path-like is refused.
  assert.equal(host.isValidSkillName('image-to-editable-ppt'), true)
  assert.equal(host.isValidSkillName('../escape'), false)
  assert.equal(host.isValidSkillName(''), false)

  // Skill root resolution: DSH_SKILLS_HOME takes precedence over DSH_HOME and default homedir.
  const previousSkillsHome = process.env.DSH_SKILLS_HOME
  const previousDshHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_SKILLS_HOME
    process.env.DSH_HOME = '/custom/dsh'
    assert.equal(host.skillsRoot(), join('/custom/dsh', 'skills'))

    process.env.DSH_SKILLS_HOME = '  /custom/isolated/skills  '
    assert.equal(host.skillsRoot(), '/custom/isolated/skills')

    // DSH_SKILLS_HOME also overrides explicit dshHome argument
    assert.equal(host.skillsRoot('/explicit/dsh'), '/custom/isolated/skills')
  } finally {
    if (previousSkillsHome === undefined) delete process.env.DSH_SKILLS_HOME
    else process.env.DSH_SKILLS_HOME = previousSkillsHome
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

await check('C12a the library lists, installs from an archive, replaces and removes', async () => {
  // A flat `<name>.md` skill and a bundle folder both count as installed.
  writeFileSync(join(skillLibraryRoot, 'flat-skill.md'), '---\nname: flat-skill\ndescription: A flat one\n---\n\n# Flat\n')
  mkdirSync(join(skillLibraryRoot, 'bundle-skill'), { recursive: true })
  writeFileSync(join(skillLibraryRoot, 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: A bundled one\n---\n\n# Bundle\n')

  const listed = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.equal(listed.networkAvailable, false)
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['bundle-skill', 'flat-skill'])
  assert.equal(listed.entries.find(entry => entry.name === 'bundle-skill').description, 'A bundled one')
  assert.ok(listed.catalog.some(source => source.name === 'image-to-editable-ppt'))

  // GitHub-shaped archive: one wrapper folder, bundle a level deeper.
  const archive = buildZip([
    { name: 'repo-main/', body: '' },
    { name: 'repo-main/SKILL.md', body: '---\nname: deck-maker\ndescription: Makes decks\n---\n\n# Deck\n' },
    { name: 'repo-main/scripts/run.py', body: 'print(1)\n' },
  ])
  assert.equal(host.readZipDirectory(archive).length, 3)
  const installed = await host.installFromArchive(archive, skillLibraryRoot, 'repo', false)
  assert.equal(installed, 'deck-maker')
  assert.equal(readFileSync(join(skillLibraryRoot, 'deck-maker', 'scripts', 'run.py'), 'utf8'), 'print(1)\n')
  // Without force a second install refuses instead of clobbering.
  await assert.rejects(
    () => host.installFromArchive(archive, skillLibraryRoot, 'repo', false),
    /已经安装/,
  )
  assert.equal(await host.installFromArchive(archive, skillLibraryRoot, 'repo', true), 'deck-maker')

  // An archive with no SKILL.md anywhere is rejected, not half-installed.
  const empty = buildZip([{ name: 'repo-main/README.md', body: 'nothing here\n' }])
  await assert.rejects(() => host.installFromArchive(empty, skillLibraryRoot, 'nope', true), /SKILL\.md/)

  assert.equal(await host.removeSkill('flat-skill', skillLibraryRoot), 'flat-skill')
  await assert.rejects(() => host.removeSkill('flat-skill', skillLibraryRoot), /没有找到/)
  await assert.rejects(() => host.removeSkill('../escape', skillLibraryRoot), /不合法/)
  const after = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.deepEqual(after.entries.map(entry => entry.name).sort(), ['bundle-skill', 'deck-maker'])
})

await check('C12b the library routes list, install from an upload, and remove', async () => {
  const initial = await post('/api/dsh-imagegen/canvas/skills/library', { language: 'zh' })
  assert.equal(initial.status, 200)
  assert.equal(initial.body.ok, true)
  assert.equal(initial.body.library.root, skillLibraryRoot)

  // The browser uploads the archive first (same route as a file node), then
  // installs it by asset reference.
  const archive = buildZip([{ name: 'bundle/SKILL.md', body: '---\nname: routed-skill\ndescription: From a route\n---\n\n# Routed\n' }])
  const uploaded = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=routed.zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: archive,
  })
  const upload = await uploaded.json()
  assert.equal(upload.ok, true, JSON.stringify(upload))

  const install = await post('/api/dsh-imagegen/canvas/skills/install', {
    asset: upload.asset, name: 'routed', force: true, language: 'zh',
  })
  assert.equal(install.body.ok, true, JSON.stringify(install.body))
  assert.deepEqual(install.body.installed, ['routed-skill'])
  assert.ok(install.body.library.entries.some(entry => entry.name === 'routed-skill'))

  // An empty install request is a bad request, not a crash.
  const empty = await post('/api/dsh-imagegen/canvas/skills/install', {})
  assert.equal(empty.body.ok, false)
  assert.equal(empty.body.code, 'bad-request')

  const removed = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'routed-skill' })
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body))
  assert.ok(!removed.body.library.entries.some(entry => entry.name === 'routed-skill'))
  const missing = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'never-installed' })
  assert.equal(missing.body.ok, false)
})

await check('C12c an install the host registry would ignore is refused with copy', async () => {
  // A non-kebab frontmatter name is dropped by the host provider: installing it
  // would look successful and stay unusable in every node.
  const badName = buildZip([{ name: 'b/SKILL.md', body: '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n' }])
  await assert.rejects(() => host.installFromArchive(badName, skillLibraryRoot, 'b', true), /kebab-case/)
  // Same for a bundle with no description at all.
  const noBlurb = buildZip([{ name: 'b/SKILL.md', body: '---\nname: no-blurb\n---\n\n# No blurb\n' }])
  await assert.rejects(() => host.installFromArchive(noBlurb, skillLibraryRoot, 'b', true), /description/)
  // A user-only skill is a legitimate install: the canvas just cannot run it.
  const userOnly = buildZip([{ name: 'b/SKILL.md', body: '---\nname: human-only\ndescription: Slash command\ndisable-model-invocation: true\n---\n\n# Human\n' }])
  assert.equal(await host.installFromArchive(userOnly, skillLibraryRoot, 'b', true), 'human-only')
  assert.equal(await host.removeSkill('human-only', skillLibraryRoot), 'human-only')

  // The panel explains the same verdicts it would otherwise leave silent.
  const issueRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-issue-'))
  try {
    mkdirSync(join(issueRoot, 'bad-name'), { recursive: true })
    writeFileSync(join(issueRoot, 'bad-name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n')
    writeFileSync(join(issueRoot, 'loose.md'), '# No frontmatter at all\n')
    const listed = await host.listLibrary({
      root: issueRoot,
      networkAvailable: false,
      issueText: (issue, name) => `${issue}:${name}`,
    })
    const byName = new Map(listed.entries.map(entry => [entry.name, entry]))
    assert.equal(byName.get('Bad_Name').issue, 'bad-name:Bad_Name')
    assert.equal(byName.get('loose').issue, 'no-frontmatter:loose')
    // The disk scan still offers the loadable ones, and only those.
    assert.deepEqual((await host.listLocalSkills(issueRoot)).map(skill => skill.name), [])
  } finally {
    rmSync(issueRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------- C13. per-skill configuration surface

await check('C13a a skill.config.json is validated, bounded and versioned', () => {
  const parsed = host.parseSkillConfigManifest({
    version: 1,
    note: 'secrets stay local',
    fields: [
      { id: 'api-key', label: 'Key', type: 'secret', required: true, expose: true },
      { id: 'base-url', type: 'string', default: 'https://x/v1', expose: true },
      { id: 'Bad_Id', type: 'string' },
      { id: 'mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b' }] },
    ],
    apply: [
      { kind: 'command', argv: ['tool', '--key', '{api-key}'], cwd: 'skill' },
      { kind: 'file', path: '~/.x/config.json', content: '{"url":"{base-url}"}' },
      { kind: 'nonsense' },
    ],
  })
  assert.equal(parsed.issue, undefined)
  // A bad field id and an unknown step kind are dropped, not fatal.
  assert.deepEqual(parsed.manifest.fields.map(field => field.id), ['api-key', 'base-url', 'mode'])
  // A secret can never be expository, whatever the declaration says.
  assert.equal(parsed.manifest.fields[0].expose, undefined)
  assert.equal(parsed.manifest.fields[1].expose, true)
  assert.equal(parsed.manifest.steps.length, 2)
  assert.equal(parsed.manifest.steps[0].cwd, 'skill')
  assert.equal(parsed.manifest.note, 'secrets stay local')

  assert.equal(host.parseSkillConfigManifest({ version: 2, fields: [{ id: 'a' }] }).issue, 'unsupported-version')
  assert.equal(host.parseSkillConfigManifest({ version: 1 }).issue, 'empty')
  assert.equal(host.parseSkillConfigManifest('nope').issue, 'unreadable')
  // Caps: only the first 32 fields survive.
  const many = host.parseSkillConfigManifest({
    version: 1,
    fields: Array.from({ length: 40 }, (_value, index) => ({ id: `f${index}` })),
  })
  assert.equal(many.manifest.fields.length, 32)

  // File targets: `~` expands, escapes and DSH control files are refused.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  assert.equal(host.resolveConfigTarget('~/.editppt/config.yaml').path, join(homedir(), '.editppt', 'config.yaml'))
  assert.equal(host.resolveConfigTarget('relative/path').issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(`${home}/../outside/config.yaml`).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'settings.yaml')).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'profiles', 'web', 'package.json')).issue, 'refused-path')
})

await check('C13b apply steps substitute values, honor guards and mask secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-config-'))
  try {
    const parsed = host.parseSkillConfigManifest({
      version: 1,
      fields: [
        { id: 'api-key', label: 'Key', type: 'secret', required: true },
        { id: 'base-url', label: 'URL', type: 'string' },
        { id: 'ocr-token', label: 'OCR', type: 'secret' },
        { id: 'endpoint', label: 'Endpoint', type: 'string', required: true },
      ],
      apply: [
        { kind: 'command', argv: [process.execPath, '-e', 'console.log("echo " + process.argv[1])', '{api-key}'] },
        { kind: 'file', path: join(root, 'out', 'config.json'), content: '{"base":"{base-url}"}' },
        { kind: 'command', argv: [process.execPath, '-e', 'process.exit(9)'], when: { field: 'ocr-token', set: true } },
      ],
    })
    const declaration = { manifest: parsed.manifest, source: 'skill' }
    const values = host.valuesFor(declaration, { values: { 'deck/base-url': 'https://x/v1' }, secrets: { 'deck/api-key': 'sk-super-secret' } }, 'deck')
    assert.equal(values.get('api-key'), 'sk-super-secret')
    assert.deepEqual(host.missingFields(declaration, values), ['Endpoint'])

    const steps = await host.applySkillConfigSteps(declaration, values, { runRoot: root })
    assert.equal(steps.length, 3)
    // The secret is never echoed back to the panel.
    assert.equal(steps[0].ok, true)
    assert.equal(steps[0].detail.includes('sk-super-secret'), false)
    assert.equal(steps[0].output.includes('sk-super-secret'), false)
    assert.match(steps[0].output, /•••/)
    assert.equal(steps[1].ok, true)
    assert.equal(readFileSync(join(root, 'out', 'config.json'), 'utf8'), '{"base":"https://x/v1"}')
    // The guarded step is skipped: its field has no value.
    assert.equal(steps[2].detail, 'skipped')

    // A missing required value stops that step with copy, not a crash.
    const empty = host.valuesFor(declaration, { values: {}, secrets: {} }, 'deck')
    const failed = await host.applySkillConfigSteps(declaration, empty, { runRoot: root })
    assert.equal(failed[0].ok, false)
    assert.match(failed[0].output, /api-key/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13c the built-in recipe covers image-to-editable-ppt and a sidecar wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-recipe-'))
  try {
    const recipe = await host.readCanvasSkillConfig({ name: 'image-to-editable-ppt', root, store: { values: {}, secrets: {} } })
    assert.equal(recipe.declaration.source, 'plugin')
    assert.deepEqual(recipe.declaration.manifest.fields.map(field => field.id), ['image-api-key', 'image-base-url', 'image-model', 'paddle-ocr-token'])
    // The image API key is optional: a host that already has Codex OAuth does
    // not need one, so nothing is reported missing on a fresh install.
    assert.deepEqual(recipe.view.missing, [])
    assert.equal(recipe.view.applicable, true)
    // The declared command is exactly what the skill documents, and it only runs
    // once a key is actually set — otherwise it would write an empty secret.
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('editppt'))
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('{image-api-key}'))
    assert.deepEqual(recipe.declaration.manifest.steps[0].when, { field: 'image-api-key', set: true })
    assert.deepEqual(recipe.declaration.manifest.steps[1].when, { field: 'paddle-ocr-token', set: true })

    // A skill's own sidecar takes over, and a broken one reports why.
    mkdirSync(join(root, 'image-to-editable-ppt'), { recursive: true })
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), JSON.stringify({
      version: 1,
      fields: [{ id: 'own-field', label: 'Own', type: 'string' }],
      apply: [{ kind: 'file', path: join(root, 'own.txt'), content: '{own-field}' }],
    }))
    const own = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: { 'image-to-editable-ppt/own-field': 'x' }, secrets: {} },
    })
    assert.equal(own.declaration.source, 'skill')
    assert.deepEqual(own.declaration.manifest.fields.map(field => field.id), ['own-field'])
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), '{ not json')
    const broken = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: {}, secrets: {} },
      issueText: issue => `copy:${issue}`,
    })
    assert.equal(broken.declaration, undefined)
    assert.equal(broken.view.issue, 'copy:unreadable')

    // A skill with no declaration and no recipe gets no configuration surface.
    const none = await host.readCanvasSkillConfig({ name: 'whatever-skill', root, store: { values: {}, secrets: {} } })
    assert.equal(none.view, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13d the config routes save and apply through the library backend', async () => {
  const seen = {}
  const previous = { save: skillLibraryFake.configSave, apply: skillLibraryFake.configApply }
  skillLibraryFake.configSave = async request => {
    seen.saved = request
    return { ok: true, library: await skillLibraryFake.list() }
  }
  skillLibraryFake.configApply = async request => {
    seen.applied = request
    return { ok: true, library: await skillLibraryFake.list(), steps: [{ kind: 'command', detail: 'editppt config --api-key •••', ok: true }] }
  }
  try {
    const saved = await post('/api/dsh-imagegen/canvas/skills/config/save', {
      name: 'image-to-editable-ppt',
      values: [{ id: 'image-api-key', value: 'sk-1' }, { bad: true }, { id: 'x' }],
      language: 'zh',
    })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    assert.deepEqual(seen.saved, { name: 'image-to-editable-ppt', values: [{ id: 'image-api-key', value: 'sk-1' }], language: 'zh' })

    const applied = await post('/api/dsh-imagegen/canvas/skills/config/apply', { name: 'image-to-editable-ppt', language: 'zh' })
    assert.equal(applied.body.ok, true, JSON.stringify(applied.body))
    assert.equal(applied.body.steps[0].kind, 'command')
    assert.equal(seen.applied.name, 'image-to-editable-ppt')

    const nameless = await post('/api/dsh-imagegen/canvas/skills/config/save', { values: [] })
    assert.equal(nameless.body.ok, false)
    assert.equal(nameless.body.code, 'bad-request')
  } finally {
    skillLibraryFake.configSave = previous.save
    skillLibraryFake.configApply = previous.apply
  }
})

await check('C14 product-link fetching refuses every internal or literal host', async () => {
  for (const url of [
    'http://127.0.0.1:8791/v1/models',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/x',
    'http://192.168.1.10/x',
    'http://172.20.0.9/x',
    'http://[::1]/x',
    'http://0.0.0.0/x',
    'http://metadata.google.internal/x',
    'http://93.184.216.34/x',
    'file:///etc/passwd',
    'gopher://example.com/x',
  ]) {
    const blocked = await post('/api/dsh-imagegen/ecommerce/fetch-link', { url })
    assert.equal(blocked.status, 200, `${url} answers as a normal envelope`)
    assert.equal(blocked.body.ok, false, `${url} is refused`)
    assert.equal(blocked.body.reason, 'blocked-host', `${url} is refused as an internal host`)
  }
  const empty = await post('/api/dsh-imagegen/ecommerce/fetch-link', {})
  assert.equal(empty.status, 400, 'a missing url is a bad request')
})

await check('C14b product markup extraction prefers JSON-LD and falls back to og', async () => {
  const { extractProductLink } = await import(new URL('src/link-extract.ts', root).href)
  const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"陶瓷杯","image":["/cup.png"],"offers":{"price":"9.9"},"description":"轻。耐热。"}</script>'
  const graph = '<script type="application/ld+json">{"@graph":[{"@type":"WebSite","name":"shop"},{"@type":"Product","name":"玻璃碗","image":"https://cdn.example.com/bowl.jpg","offers":{"price":"19"}}]}</script>'
  const og = '<meta property="og:title" content="帆布包" /><meta property="og:image" content="/bag.jpg" /><meta property="og:description" content="厚实。能装。" />'
  const fromJsonLd = extractProductLink(`<html><head>${jsonLd}</head></html>`, 'https://shop.example.com/p/1')
  assert.equal(fromJsonLd.ok, true, 'a Product node is understood')
  assert.equal(fromJsonLd.title, '陶瓷杯')
  assert.deepEqual(fromJsonLd.images, ['https://shop.example.com/cup.png'], 'relative images resolve against the page')
  assert.equal(fromJsonLd.price, '9.9')
  assert.equal(fromJsonLd.source, 'json-ld')
  const fromGraph = extractProductLink(`<html><head>${graph}</head></html>`, 'https://shop.example.com/p/2')
  assert.equal(fromGraph.title, '玻璃碗', 'a Product node inside @graph is found')
  assert.deepEqual(fromGraph.images, ['https://cdn.example.com/bowl.jpg'])
  const fromOg = extractProductLink(`<html><head>${og}</head></html>`, 'https://shop.example.com/p/3')
  assert.equal(fromOg.ok, true, 'og tags are the fallback')
  assert.equal(fromOg.title, '帆布包')
  assert.deepEqual(fromOg.images, ['https://shop.example.com/bag.jpg'])
  assert.equal(fromOg.source, 'og')
  const nothing = extractProductLink('<html><head></head><body>hello</body></html>', 'https://shop.example.com/p/4')
  assert.equal(nothing.ok, false, 'a page without product markup is refused')
  assert.equal(nothing.reason, 'no-product-data')
  const titleOnly = extractProductLink('<html><head><title>只有标题</title></head></html>', 'https://shop.example.com/p/5')
  assert.equal(titleOnly.title, '只有标题', 'a bare document title is still usable as a name')
})

await new Promise(resolve => server.close(resolve))

// -------------------------------------------------- D. client bundle shape
await check('D1 client bundle registers via __ModuleLoader__ and exposes the canvas raster and conversation-draft helpers', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { handoff = h } },
    },
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'load() was called')
  assert.equal(handoff.id, '@q253595422/dsh-imagegen-video')
  assert.equal(typeof handoff.factory, 'function')
  // Evaluate the factory with stubbed platform modules; only the exports
  // surface is exercised (apply never runs without a real DOM). The react
  // stub needs the top-level APIs the inlined lucide-react icons touch.
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: () => null,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-dom': {},
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({
      getSnapshot: () => initial,
      set: () => {},
      update: () => {},
      subscribe: () => () => {},
    }) },
  }
  const required = []
  const exportsOf = handoff.factory((spec) => {
    required.push(spec)
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  assert.equal([...new Set(required)].sort().join(','), Object.keys(stubs).sort().join(','))
  assert.equal(typeof exportsOf.apply, 'function')
  // Cross-realm array (VM context): compare contents, not identity.
  assert.equal([...exportsOf.inject].join(','), 'slots,locale,connection,sessions,conversation')

  // --- canvas raster helpers (image-ops.ts), reachable only through the bundle
  // Cross-realm values (VM context): spread into local objects before comparing.
  const { containRect, rectBetween, rectToPixels, removeBackground, autoRemoveBackground, transparencyRatio, drawAnnotation, compositeAnnotatedResult } = exportsOf
  const { conversationInput, createConversationDrafts, releaseConversationDrafts, addConversationAttachments, removeConversationAttachment } = exportsOf
  // Letterbox: a 200x100 image inside a 100x100 node body.
  assert.deepEqual({ ...containRect(100, 100, 200, 100) }, { left: 0, top: 25, width: 100, height: 50 })
  // Dragging across the letterboxed image yields the full normalized rect.
  assert.deepEqual(
    { ...rectBetween({ x: 0, y: 25 }, { x: 100, y: 75 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 1, height: 1 },
  )
  // Drags that leave the image clamp to [0,1] instead of going negative.
  assert.deepEqual(
    { ...rectBetween({ x: -50, y: -50 }, { x: 10, y: 37.5 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 0.1, height: 0.25 },
  )
  // Normalized rect -> pixels, kept inside the canvas bounds.
  assert.deepEqual({ ...rectToPixels({ x: 0.5, y: 0.5, width: 0.75, height: 0.75 }, 200, 100) }, { x: 100, y: 50, width: 100, height: 50 })

  // Minimal 2D canvas mock: enough of the API for the matting, annotation and
  // composite helpers (createElement/getImageData/putImageData/drawImage/fillRect
  // plus destination-out erasing) to run headless.
  const makeCanvas = (width = 0, height = 0, fill) => {
    let pixels = null
    const canvas = { width, height }
    const ensure = () => {
      const size = canvas.width * canvas.height * 4
      if (pixels === null || pixels.length !== size) {
        pixels = new Uint8ClampedArray(size)
        if (fill !== undefined) fill(pixels, canvas.width, canvas.height)
      }
      return pixels
    }
    // `_data` mirrors a real canvas: allocated lazily, filled by drawImage.
    Object.defineProperty(canvas, '_data', { get: () => ensure(), set: next => { pixels = next } })
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?._data
      if (src === undefined) return
      const sourceWidth = source.width
      const sourceHeight = source.height
      let sx = 0
      let sy = 0
      let sWidth = sourceWidth
      let sHeight = sourceHeight
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(sourceWidth - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * sourceWidth + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const erase = canvas.__composite === 'destination-out'
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    canvas.getContext = () => ({
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, strokeRect() {}, fillText() {},
      measureText: () => ({ width: 8 }),
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    })
    canvas.toDataURL = () => 'data:image/png;base64,AAAA'
    ensure()
    return canvas
  }
  // White backdrop with a red square in the middle.
  const subjectCanvas = makeCanvas(64, 64, (data, width) => {
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= 20 && x < 44 && y >= 20 && y < 44
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  })
  // image-ops reads globalThis.document inside the VM realm, so the stub has
  // to live on the sandbox global, not on this module's globalThis.
  sandbox.document = { createElement: () => makeCanvas() }
  try {
    const removed = removeBackground(subjectCanvas)
    assert.ok(removed.removedRatio > 0.5 && removed.removedRatio < 0.95, `border backdrop removed, got ${removed.removedRatio}`)
    const output = removed.canvas._data
    assert.equal(output[0 * 4 + 3], 0, 'the corner is fully transparent')
    assert.equal(output[(32 * 64 + 32) * 4 + 3], 255, 'the subject stays opaque')
    assert.equal(output[(32 * 64 + 32) * 4], 220, 'the subject keeps its color')
    assert.equal(output[(0 * 64 + 32) * 4 + 3], 0, 'the top edge is transparent')
    assert.ok(transparencyRatio(removed.canvas) > 0.4, 'the cut-out is detected as transparent')
    // A uniform image has no distinguishable background: nothing is removed.
    const flat = makeCanvas(32, 32, data => data.fill(200))
    assert.equal(autoRemoveBackground(flat).removedRatio, 0, 'a flat image is left untouched')
    // Annotation marks are burned into a copy, not the source.
    const marked = drawAnnotation(subjectCanvas, [{ rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, index: 0 }])
    assert.equal(marked.width, 64)
    assert.equal(marked._data[(0 * 64 + 0) * 4], 255, 'outside the box the pixels are unchanged')
    assert.equal(subjectCanvas._data[(20 * 64 + 20) * 4], 220, 'the source image is not modified')

    // 标注 composite: the model's "result" keeps the marker everywhere, but the
    // final image must show generated pixels only inside the box and the clean
    // original outside it.
    const modelResult = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 7; data[i + 1] = 7; data[i + 2] = 7; data[i + 3] = 255 } })
    const cleanOriginal = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = 200; data[i + 2] = 200; data[i + 3] = 255 } })
    const composited = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 0)
    const pixels = composited._data
    const at = (x, y) => pixels[(y * 64 + x) * 4]
    assert.equal(at(32, 32), 7, 'inside the box the generated content is kept')
    assert.equal(at(4, 4), 200, 'outside the box the clean original is restored')
    assert.equal(at(60, 60), 200, 'the marker in the result is overwritten outside the box')
    // The inset shaves the marker stroke that sits on the box border.
    const inset = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 4)._data
    assert.equal(inset[(16 * 64 + 16) * 4], 200, 'the inset restores the pixels right on the box edge')
  } finally {
    delete sandbox.document
  }

  // --- conversation draft bridge (conversation-sync.ts)
  // DSH renamed the image-only draft verbs to attachment-wide ones in 0.1.5
  // (`createDrafts` / `releaseDraftAttachments` / `input.addAttachments`), so
  // the panel must drive whichever pair the running shell exposes instead of
  // calling a verb that no longer exists (#18).
  const modernCalls = []
  const modernInput = {
    addAttachments: (ids) => { modernCalls.push(`add:${ids.join(',')}`); return true },
    removeAttachment: (id) => { modernCalls.push(`remove:${id}`) },
    addImages: () => { throw new Error('the legacy verb was called on a 0.1.5+ shell') },
  }
  const modern = {
    createDrafts: (sessionId, files) => {
      modernCalls.push(`create:${sessionId}:${files.length}`)
      return [{ id: 'draft-1', kind: 'image' }]
    },
    releaseDraftAttachments: (drafts) => { modernCalls.push(`release:${drafts.length}`) },
    createDraftImages: () => { throw new Error('the legacy verb was called on a 0.1.5+ shell') },
  }
  const modernDrafts = createConversationDrafts(modern, 'session-1', ['file'])
  assert.equal(modernDrafts.map(draft => draft.id).join(','), 'draft-1', 'a 0.1.5+ shell hands the drafts back')
  assert.equal(addConversationAttachments(conversationInput(modernInput), modernDrafts.map(draft => draft.id)), true)
  removeConversationAttachment(conversationInput(modernInput), 'draft-1')
  releaseConversationDrafts(modern, modernDrafts)
  assert.equal(modernCalls.join(' | '), 'create:session-1:1 | add:draft-1 | remove:draft-1 | release:1')

  // A 0.1.2 shell keeps the image-only names; the bridge must not reach for the
  // newer verbs there either.
  const legacyCalls = []
  const legacy = {
    createDraftImages: (files) => {
      legacyCalls.push(`createImages:${files.length}`)
      return [{ id: 'legacy-1' }]
    },
    releaseDraftImages: (drafts) => { legacyCalls.push(`releaseImages:${drafts.length}`) },
  }
  const legacyInput = {
    addImages: (ids) => { legacyCalls.push(`addImages:${ids.join(',')}`); return true },
    removeImage: (id) => { legacyCalls.push(`removeImage:${id}`) },
  }
  const legacyDrafts = createConversationDrafts(legacy, 'session-1', ['file'])
  assert.equal(addConversationAttachments(conversationInput(legacyInput), legacyDrafts.map(draft => draft.id)), true)
  removeConversationAttachment(conversationInput(legacyInput), 'legacy-1')
  releaseConversationDrafts(legacy, legacyDrafts)
  assert.equal(legacyCalls.join(' | '), 'createImages:1 | addImages:legacy-1 | removeImage:legacy-1 | releaseImages:1')

  // A shell exposing neither pair reports the gap (the panel shows its
  // localized "unavailable" copy) and release stays a no-op instead of throwing
  // the `releaseDraftImages is not a function` TypeError that masked the real
  // failure in #18.
  assert.equal(createConversationDrafts({}, 'session-1', ['file']), undefined)
  assert.equal(addConversationAttachments(conversationInput({}), ['draft-1']), undefined)
  releaseConversationDrafts({}, [])
  releaseConversationDrafts({}, [{ id: 'draft-1' }])
})

await check('D2 the client bundle ships the canvas skill + file-node surface', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Copy: the skill picker, the polish menu and the file-node strings all ride
  // the same dictionary as every other panel label.
  for (const needle of [
    'canvas.skills.pickerTitle',
    'canvas.skills.fileNode',
    'canvas.skills.pptDesc',
    'canvas.skills.libraryTitle',
    'canvas.skills.installNow',
    'canvas.polish.formal',
    'settings.skillsEnabled',
    'canvas.preview.expand',
    'canvas.preview.textTruncated',
    'canvas.preview.reason.unreadable',
  ]) {
    assert.ok(source.includes(needle), `client bundle is missing ${needle}`)
  }
  // Endpoints: the browser half must call the exact routes the host registers.
  for (const route of [
    '/api/dsh-imagegen/canvas/file/upload',
    '/api/dsh-imagegen/canvas/file/preview',
    '/api/dsh-imagegen/canvas/skills/list',
    '/api/dsh-imagegen/canvas/skills/run',
    '/api/dsh-imagegen/canvas/skills/task',
    '/api/dsh-imagegen/canvas/skills/cancel',
    '/api/dsh-imagegen/canvas/skills/library',
    '/api/dsh-imagegen/canvas/skills/install',
    '/api/dsh-imagegen/canvas/skills/remove',
  ]) {
    assert.ok(source.includes(route), `client bundle is missing route ${route}`)
  }
  // The heavy-tier confirmation and the batch cap are UI-side gates.
  assert.ok(source.includes('canvas.skills.confirmBody'))
  assert.ok(source.includes('canvas.skills.batchTooMany'))
})

// ------------------------------- D3 sidebar entry adapters across shell layouts
await check('D3 sidebar entry mounts inside desktop and unknown sidebar shells, and reports one it cannot reach (#20)', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body>'
    // DSH Desktop renders the upstream sidebar inside a surface of its own, so
    // the web shell markers the entry used to look for are nowhere on the path
    // and the mount silently bailed out (#20).
    //
    // The slot anchors below are the ones the shipped `SidebarRoot` renders (see
    // `dsh-client-ui-sidebar`): brand marks/name inside the logo row, workspaces
    // inside the region area, footer action and settings inside the foot. They
    // are `display: contents` (inline, exactly as the renderer writes them), so
    // the block that paints the box is their
    // ancestor — that ancestor is what the studio marks and spares. A fixture
    // without them would describe a shell that does not ship.
    + '<aside class="dshDesktopSidebarSurface">'
    + '<div class="dshDesktopUpstreamSidebar">'
    + '<div class="xUkysG_root">'
    + '<div class="xUkysG_logoRow"><span class="xUkysG_brandIdentity">'
    + '<span class="xUkysG_brandMark"><span data-slot="sidebar.brand.mark" style="display: contents"></span></span>'
    + '<span class="xUkysG_brandName"><span data-slot="sidebar.brand.name" style="display: contents"></span></span>'
    + '</span><button class="xUkysG_brandButton" aria-label="DSH">DSH</button></div>'
    + '<button class="xUkysG_newSession" aria-label="New session">New session</button>'
    + '<div data-other-sidebar-plugin>Other plugin</div>'
    + '<div class="xUkysG_regionArea"><div data-slot="sidebar.workspaces" style="display: contents"></div></div>'
    + '<div class="xUkysG_footArea">'
    + '<div class="xUkysG_footerActions"><div data-slot="sidebar.footer.action" style="display: contents"></div></div>'
    + '<div class="xUkysG_settingsArea"><div data-slot="sidebar.settings" style="display: contents"></div></div>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</aside>'
    + '</body></html>',
    { pretendToBeVisual: true },
  )
  const jsdomWindow = dom.window
  const jsdomDocument = jsdomWindow.document
  // The "stayed unmounted" watchdog is a five second timer; shrink it so the
  // check does not idle for real seconds.
  const realSetTimeout = jsdomWindow.setTimeout.bind(jsdomWindow)
  jsdomWindow.setTimeout = (fn, delay, ...args) => realSetTimeout(fn, Math.min(Number(delay) || 0, 20), ...args)
  const warnings = []
  const sandbox = {
    window: jsdomWindow,
    document: jsdomDocument,
    MutationObserver: jsdomWindow.MutationObserver,
    HTMLElement: jsdomWindow.HTMLElement,
    console: {
      log: (...args) => console.log(...args),
      warn: (...args) => { warnings.push(args.join(' ')) },
      error: (...args) => console.error(...args),
      info: (...args) => console.info(...args),
      debug: (...args) => console.debug(...args),
    },
  }
  // Same stub set as D1: the entry is reached through the bundle export surface.
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: () => null,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-dom': {},
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({
      getSnapshot: () => initial,
      set: () => {},
      update: () => {},
      subscribe: () => () => {},
    }) },
  }
  let handoff
  sandbox.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const exportsOf = handoff.factory((spec) => {
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  const { findSidebarRoot, mount } = exportsOf.sidebarEntryTestHooks
  assert.equal(typeof findSidebarRoot, 'function')
  assert.equal(typeof mount, 'function')

  const calls = []
  const listeners = new Set()
  let panelOpen = false
  const controller = {
    getSnapshot: () => ({ panelOpen }),
    open: () => { calls.push('open') },
    close: () => { calls.push('close') },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }

  // --- desktop shell: the wrapper owning the shell button is the mount point,
  // and the brand row on the same ancestor must stay untouched.
  const desktopRoot = findSidebarRoot()
  assert.equal(desktopRoot?.className, 'xUkysG_root', 'the desktop sidebar surface resolves to the wrapper that owns the shell button')
  const disposeDesktop = mount(controller, 'Session', 'Back to the current conversation', 'Image', 'Open the image studio')
  const tabs = jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]')
  assert.ok(tabs !== null, 'the two tabs mount in the desktop shell')
  assert.equal(tabs.parentElement.className, 'xUkysG_root', 'the tabs land where the shell button sits')
  assert.equal(tabs.getAttribute('role'), 'tablist')
  assert.deepEqual(
    [...tabs.querySelectorAll('[data-dsh-imagegen-tab]')].map(tab => tab.getAttribute('data-dsh-imagegen-tab')),
    ['session', 'image'],
  )
  const shellButton = jsdomDocument.querySelector('.xUkysG_newSession')
  assert.equal(shellButton.style.display, '', 'the shell New Session button stays visible: the switcher only moves between the conversation and the studio')
  assert.equal(shellButton.hasAttribute('aria-hidden'), false)
  assert.equal(shellButton.tabIndex, 0)
  assert.equal(shellButton.previousElementSibling, tabs, 'the switcher sits directly above the shell button')
  const brandButton = jsdomDocument.querySelector('.xUkysG_brandButton')
  assert.equal(brandButton.style.display, '', 'the brand button is never hidden')
  assert.equal(brandButton.hasAttribute('aria-hidden'), false)
  assert.equal(brandButton.tabIndex, 0)
  const historyHost = jsdomDocument.querySelector('[data-dsh-imagegen-history-host]')
  assert.ok(historyHost !== null, 'the history host mounts inside the desktop sidebar')
  assert.equal(historyHost.parentElement.className, 'xUkysG_regionArea')
  assert.equal(desktopRoot.getAttribute('data-dsh-imagegen-sidebar-root'), '', 'the resolved shell root is marked')

  // Tab clicks drive the panel, and the active state follows the panel store.
  tabs.querySelector('[data-dsh-imagegen-tab="image"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  tabs.querySelector('[data-dsh-imagegen-tab="session"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.equal(calls.join(','), 'open,close', 'the image tab opens the studio and the session tab returns to the conversation without starting one')
  panelOpen = true
  for (const listener of [...listeners]) listener()
  assert.equal(tabs.querySelector('[data-dsh-imagegen-tab="image"]').hasAttribute('data-active'), true, 'the open panel marks the image tab')
  assert.equal(tabs.querySelector('[data-dsh-imagegen-tab="session"]').hasAttribute('data-active'), false)
  jsdomDocument.documentElement.setAttribute('data-dsh-imagegen-active', '')
  assert.notEqual(jsdomWindow.getComputedStyle(shellButton).display, 'none', 'the native New Session action stays visible under the shipped studio CSS')
  assert.equal(jsdomWindow.getComputedStyle(desktopRoot.querySelector('[data-other-sidebar-plugin]')).display, 'none', 'unrelated sidebar plugin entries remain hidden')
  // The other half of the same rule, and the reason it is gated: a shell whose
  // chrome we resolved must keep that chrome. Hiding a foreign entry is a
  // cosmetic win; hiding the brand row or the foot is a broken sidebar.
  for (const block of ['.xUkysG_logoRow', '.xUkysG_regionArea', '.xUkysG_footArea']) {
    assert.notEqual(jsdomWindow.getComputedStyle(desktopRoot.querySelector(block)).display, 'none', `the shell's own ${block} block stays visible in the studio`)
    assert.equal(desktopRoot.querySelector(block).getAttribute('data-dsh-imagegen-sidebar-block'), '', `the shell's own ${block} block is marked as chrome, not guessed by class`)
  }
  jsdomDocument.documentElement.removeAttribute('data-dsh-imagegen-active')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(warnings.length, 0, `a mounted sidebar entry logs nothing: ${warnings.join(' | ')}`)

  disposeDesktop()
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]') === null, true, 'the disposer takes the tabs back out')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-history-host]') === null, true, 'the disposer takes the history host back out')
  assert.equal(shellButton.style.display, '', 'the shell button keeps its native display after unload')
  assert.equal(shellButton.hasAttribute('aria-hidden'), false)
  assert.equal(shellButton.hasAttribute('tabindex'), false)
  assert.equal(shellButton.hasAttribute('data-dsh-imagegen-new-session'), false, 'the temporary action marker is removed on unload')
  assert.equal(desktopRoot.hasAttribute('data-dsh-imagegen-sidebar-root'), false, 'the root marker is cleared on unload')

  // --- sidebar mode: one row in the shell's global panel list, no top tabs.
  jsdomDocument.body.innerHTML =
    '<div class="panelShell">'
    + '<div class="logoRow"><span data-slot="sidebar.brand.mark" style="display: contents"></span></div>'
    + '<button aria-label="New session">+</button>'
    + '<nav class="panelList">'
    + '<button class="panelRow" aria-label="插件"><span class="panelGlyph"><span data-slot="sidebar.panellist" style="display: contents"></span></span><span class="panelTitle">插件</span></button>'
    + '<button class="panelRow" aria-label="自动化任务"><span class="panelGlyph"><span data-slot="sidebar.panellist" style="display: contents"></span></span><span class="panelTitle">自动化任务</span></button>'
    + '<button class="panelRow" aria-label="SSH"><span class="panelGlyph"><span data-slot="sidebar.panellist" style="display: contents"></span></span><span class="panelTitle">SSH</span></button>'
    + '<span class="moreAnchor"><button class="panelRow" aria-label="更多" aria-haspopup="menu"><span class="panelGlyph"></span><span class="panelTitle">更多</span></button></span>'
    + '</nav>'
    + '<div class="regionArea"><div data-slot="sidebar.workspaces" style="display: contents"></div></div>'
    + '</div>'
  panelOpen = false
  const callsBeforePanel = calls.length
  const disposePanelMode = mount(controller, 'Session', 'Back to the current conversation', 'Image', 'Open the image studio', 'sidebar')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]') === null, true, 'sidebar mode does not mount the top tab pair')
  const panelEntry = jsdomDocument.querySelector('[data-dsh-imagegen-panel-entry]')
  assert.ok(panelEntry !== null, 'sidebar mode mounts the global panel row')
  assert.equal(panelEntry.parentElement?.tagName.toLowerCase(), 'nav', 'the row lands inside the global panel list')
  assert.equal(panelEntry.getAttribute('aria-label'), 'Image')
  assert.equal(jsdomDocument.querySelectorAll('[data-dsh-imagegen-panel-entry]').length, 1, 'repairing the panel list never duplicates the row')
  panelEntry.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.equal(calls.slice(callsBeforePanel).join(','), 'open', 'the panel row opens the studio')
  panelOpen = true
  for (const listener of [...listeners]) listener()
  assert.equal(panelEntry.hasAttribute('data-active'), true, 'the open panel marks the sidebar row')
  panelEntry.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.equal(calls.slice(callsBeforePanel).join(','), 'open,close', 'clicking the open row returns to the conversation')
  disposePanelMode()
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-panel-entry]') === null, true, 'the sidebar-mode disposer takes the row back out')
  panelOpen = false

  // --- unknown shell: no marker class and no data hook anywhere, only the brand
  // row plus the shell button's accessible name.
  jsdomDocument.body.innerHTML =
    '<div class="zzzShell">'
    + '<div class="zzz_logoRow"><button class="zzz_brand">brand</button></div>'
    + '<button aria-label="New session">+</button>'
    + '<div class="zzz_regionArea"></div>'
    + '</div>'
  const unknownRoot = findSidebarRoot()
  assert.equal(unknownRoot?.className, 'zzzShell', 'a shell without our markers resolves through the brand row and the button name')
  const disposeUnknown = mount(controller, 'Session', 'Back to the current conversation', 'Image', 'Open the image studio')
  const unknownTabs = jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]')
  assert.ok(unknownTabs !== null, 'the tabs mount in a shell we have never seen')
  assert.equal(unknownTabs.parentElement.className, 'zzzShell')
  assert.equal(jsdomDocument.querySelector('.zzzShell > button[aria-label="New session"]').style.display, '', 'the shell button stays visible in an unknown shell too')
  assert.equal(jsdomDocument.querySelector('.zzzShell > button[aria-label="New session"]').previousElementSibling, unknownTabs)
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-history-host]').parentElement.className, 'zzz_regionArea')

  // React can wrap or replace a native action without retaining its CSS class.
  // Check ancestor visibility as well as the button's own computed display.
  const unknownButton = jsdomDocument.querySelector('.zzzShell > button[aria-label="New session"]')
  const actionWrapper = jsdomDocument.createElement('div')
  unknownRoot.insertBefore(actionWrapper, unknownButton)
  actionWrapper.append(unknownButton)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(jsdomDocument.querySelectorAll('[data-dsh-imagegen-session-tabs]').length, 1, 'repairing a wrapped action never duplicates the switcher')
  assert.equal(unknownButton.previousElementSibling?.hasAttribute('data-dsh-imagegen-session-tabs'), true, 'the switcher follows the wrapped action')
  jsdomDocument.documentElement.setAttribute('data-dsh-imagegen-active', '')
  assert.notEqual(jsdomWindow.getComputedStyle(actionWrapper).display, 'none', 'a wrapper around the native action stays visible')
  assert.notEqual(jsdomWindow.getComputedStyle(unknownButton).display, 'none', 'an action found only by its accessible name stays visible')
  const replacementButton = jsdomDocument.createElement('button')
  replacementButton.setAttribute('aria-label', 'New session')
  replacementButton.textContent = '+'
  unknownButton.replaceWith(replacementButton)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.notEqual(jsdomWindow.getComputedStyle(actionWrapper).display, 'none', 'replacing the native action preserves its wrapper visibility')
  assert.notEqual(jsdomWindow.getComputedStyle(replacementButton).display, 'none', 'the replacement native action stays visible')
  assert.equal(unknownButton.hasAttribute('data-dsh-imagegen-new-session'), false, 'the replaced action loses its temporary marker')
  jsdomDocument.documentElement.removeAttribute('data-dsh-imagegen-active')
  disposeUnknown()
  assert.equal(replacementButton.hasAttribute('data-dsh-imagegen-new-session'), false, 'the replacement action is cleaned up on unload')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]') === null, true)

  // --- a shell without a New Session affordance must still get an entry. Another
  // plugin can take the sidebar over and hide that action (`display: none
  // !important` — ds-bot's team view does exactly this), which used to leave the
  // switcher with no seat at all and therefore no way into the studio. The column
  // itself becomes the seat, and only the fallback carries its own marker.
  jsdomDocument.body.innerHTML =
    '<div data-pane="sidebar">'
    + '<div class="logoRow"><button class="brandButton" aria-label="Collapse sidebar">SESSION-TITLE-MUST-NOT-BE-LOGGED</button></div>'
    + '<div class="regionArea"></div>'
    + '</div>'
  const fallbackPane = jsdomDocument.querySelector('[data-pane="sidebar"]')
  const callsBeforeFallback = calls.length
  const disposeFallback = mount(controller, 'Session', 'Back to the current conversation', 'Image', 'Open the image studio')
  const fallbackTabs = jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]')
  assert.ok(fallbackTabs !== null, 'the switcher mounts even when no shell New Session action is reachable')
  assert.equal(fallbackTabs.parentElement, fallbackPane, 'the sidebar column itself becomes the seat')
  assert.equal(fallbackTabs, fallbackPane.firstElementChild, 'the fallback switcher is the column first child')
  assert.equal(fallbackTabs.getAttribute('data-dsh-imagegen-tabs-seat'), 'top', 'the fallback seat is marked so only that seat is restyled')
  assert.equal(jsdomDocument.querySelector('.brandButton').style.display, '', 'the brand button is not mistaken for the new-session control')
  assert.equal(jsdomDocument.querySelector('.brandButton').hasAttribute('data-dsh-imagegen-new-session'), false, 'no action marker lands on an unrelated control')
  fallbackTabs.querySelector('[data-dsh-imagegen-tab="image"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.equal(calls.slice(callsBeforeFallback).join(','), 'open', 'the fallback switcher opens the studio like the seated one')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-history-host]').parentElement.className, 'regionArea', 'the history host still seats in the region area')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(warnings.length, 0, `a mounted fallback entry logs nothing: ${warnings.join(' | ')}`)
  disposeFallback()
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]') === null, true, 'the fallback disposer takes the tabs back out')
  assert.equal(fallbackPane.hasAttribute('data-dsh-imagegen-sidebar-root'), false, 'the fallback root marker is cleared on unload')

  // --- a page with no sidebar at all reaches no seat, and says so: the silent
  // return is exactly what made #20 hard to diagnose.
  jsdomDocument.body.innerHTML = '<main></main>'
  const disposeUnmounted = mount(controller, 'Session', 'Back to the current conversation', 'Image', 'Open the image studio')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]') === null, true, 'a page with no sidebar mounts no tabs')
  assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-history-host]') === null, true, 'no history host mounts either')
  await new Promise(resolve => setTimeout(resolve, 60))
  const warning = warnings.find(line => line.includes('sidebar entry stayed unmounted'))
  assert.ok(warning !== undefined, `an unreachable shell is reported instead of failing silently: ${warnings.join(' | ')}`)
  assert.match(warning, /sidebar root not found/)
  assert.match(warning, /body>main/, 'the warning carries a shell probe for bug reports')
  assert.equal(warning.includes('SESSION-TITLE-MUST-NOT-BE-LOGGED'), false, 'the probe never dumps sidebar content')
  disposeUnmounted()
  jsdomWindow.setTimeout = realSetTimeout
})

// --------------- E. full client apply in jsdom (mounts the sidebar entry)
await check('E1 client apply mounts the sidebar entry and studio (jsdom)', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body>'
    + '<div data-pane="sidebar"><div class="logoRow"><button class="newSession">New session</button></div><div class="regionArea"></div></div>'
    + '<div data-pane="conversation"><div data-slot="conversation"><div data-conversation-scroll></div></div></div>'
    // DSH 0.1.5+ frame: the centre column is the AppFrame's `centerCol` and the
    // Conversation arrives as a keyed `main` slot entry. Both slot anchors are
    // `display: contents` by contract, so the Conversation root itself is the
    // grid item the chat track has to place (#19).
    + '<div class="smoke_centerCol">'
    + '<div data-slot="main" style="display: contents">'
    + '<div data-slot="main.conversation" style="display: contents"><div class="smoke_root" data-phase="hero"></div></div>'
    + '</div>'
    + '<div data-other-plugin-entry></div>'
    + '</div>'
    + '</body></html>',
    { pretendToBeVisual: true },
  )
  const jsdomWindow = dom.window
  const jsdomDocument = jsdomWindow.document
  let confirmationCalls = 0
  // The copy is recorded, not just counted: a confirmation that names the wrong
  // number ("delete 0 assets") is a real defect that a call count cannot see.
  // `confirmationAnswer` is what the stub returns, so a check that needs the
  // action to actually run can opt in for one click.
  const confirmationMessages = []
  let confirmationAnswer = false
  let nativeNewSessionCalls = 0
  const nativeNewSession = jsdomDocument.querySelector('.newSession')
  nativeNewSession.addEventListener('click', () => { nativeNewSessionCalls += 1 })
  jsdomWindow.confirm = (message) => {
    confirmationCalls += 1
    confirmationMessages.push(String(message ?? ''))
    return confirmationAnswer
  }
  // jsdom has no ResizeObserver; the canvas measures its viewport with one.
  jsdomWindow.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Pointer capture is a no-op here; the annotation drag only needs the events.
  jsdomWindow.Element.prototype.setPointerCapture = function setPointerCapture() {}
  jsdomWindow.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  jsdomWindow.Element.prototype.hasPointerCapture = function hasPointerCapture() { return true }
  // Headless 2D canvas: white backdrop with a red square, nearest-neighbour
  // drawImage (source rect aware, like the real API) and a fixed PNG data URL.
  const paintSample = (data, width, height) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.3 && y < height * 0.7
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    // WebGL backgrounds opt out (the real jsdom build has no GL either).
    if (type !== '2d') return null
    const canvas = this
    const ensure = () => {
      const size = Math.max(1, canvas.width * canvas.height * 4)
      if (canvas.__pixels === undefined || canvas.__pixels.length !== size) {
        canvas.__pixels = new Uint8ClampedArray(size)
        if (canvas.__painted === true) paintSample(canvas.__pixels, canvas.width, canvas.height)
      }
      return canvas.__pixels
    }
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?.__pixels
      if (src === undefined) {
        canvas.__painted = true
        paintSample(dest, canvas.width, canvas.height)
        return
      }
      let sx = 0
      let sy = 0
      let sWidth = source.width
      let sHeight = source.height
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(source.height - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(source.width - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * source.width + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          // Source-over compositing: fully transparent source pixels leave the
          // destination untouched (the real canvas does the same).
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      const erase = canvas.__composite === 'destination-out'
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    return {
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
      strokeRect() {}, clearRect() {}, fillText() {}, scale() {},
      measureText: () => ({ width: 8 }),
      strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', lineCap: '', lineJoin: '',
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJD'

  // Stateful bridge stub: describe + mutate (same wire shapes as the routes).
  // The redacted view never returns the key; the secrets sidecar tracks it.
  const keyState = { set: false, ids: {} }
  const configState = {
    enabled: true,
    announceToAgent: true,
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'https://example.test/v1',
      models: [
        { alias: 'gpt-image-2', id: 'gpt-image-2' },
        { alias: 'gpt-image-2-alt', id: 'gpt-image-2' },
      ],
      videoModels: [
        { alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' },
      ],
    }],
    defaultChannelId: 'default',
    defaultModel: 'gpt-image-2-alt',
    defaultVideoModel: 'agnes-video-2.5-flash',
    promptModel: 'chat-test',
  }
  const channelSecrets = () => [{ path: ['channelSecrets', 'default'], set: keyState.set }]
  const mutateCalls = []
  let rejectNextSettingsMutation = false
  const ecommerceSubmissions = []
  /** Canvas generation requests submitted from the workspace composer. */
  const canvasTasks = []
  /** Documents the workspace persisted through /canvas/save. */
  const canvasSaves = []
  /** Every gallery mutation the panel issued, in order (see the gallery stubs). */
  const galleryMutations = []
  /** Video tasks the panel sees when polling, and submissions it makes. */
  const videoTasks = []
  const videoSubmissions = []
  // #38: the record the shared diagnostics panel reads. The video studio opens
  // the SAME buffer the image tray does, so the fixture is one entry whose phase
  // names a video leg -- if the panel reached a different surface, or reached
  // nothing, this is what would show it.
  const diagnosticsEntries = [{
    id: 'diag-1',
    at: Date.now(),
    phase: 'video-submit',
    channel: 'Default',
    model: 'agnes-video-2.5-flash',
    mode: 'text',
    url: 'https://example.test/v1/videos',
    method: 'POST',
    status: 400,
    failureCode: 'video-submit-failed',
    message: '视频提交失败（HTTP 400）',
    durationMs: 12,
    hadAuth: true,
  }]
  let diagnosticsListCalls = 0
  /** Clip history the sidebar must merge with the image history. */
  const videoHistoryEntries = [
    {
      id: 'clip-new', createdAt: 6, mode: 'text', model: 'agnes-video-2.5-flash',
      prompt: 'a clip newest', aspectRatio: '16:9', resolution: '720P', seconds: 5,
      videos: [{ url: '/api/dsh-imagegen/video/file/clip-new-0.mp4', mime: 'video/mp4', duration: 5 }],
    },
    {
      id: 'clip-mid', createdAt: 3, mode: 'text', model: 'agnes-video-2.5-flash',
      prompt: 'a clip middle', aspectRatio: '9:16', resolution: '1080P', seconds: 10,
      videos: [{ url: '/api/dsh-imagegen/video/file/clip-mid-0.mp4', mime: 'video/mp4', duration: 10 }],
    },
  ]
  const videoHistoryRemovals = []
  /** How many times the client asked for the clip list. The sidebar loads it
   *  once behind initialDataRequestedRef, so any second read proves the
   *  completion-triggered refetch ran (a finished clip used to stay invisible
   *  until the whole app was reloaded). */
  let videoHistoryListCalls = 0
  /** How many times the client asked for the video task queue. Counted so a
   *  check can prove the video tab's submit/cancel goes through the PARENT's
   *  single poller (one extra read) instead of the tab starting its own. */
  let videoTaskListCalls = 0
  /** Ids the video tab asked the host to cancel, in order. */
  const videoCancellations = []
  /** Canvas video runs, recorded so the canvas test can assert the request. */
  const canvasVideoSubmissions = []
  /** Assets the canvas uploaded during a frame grab. */
  const canvasGrabUploads = []
  const canvasImageAsset = {
    assetId: `${'a'.repeat(64)}.png`,
    url: `/api/dsh-imagegen/canvas/asset/${'a'.repeat(64)}.png`,
    mime: 'image/png',
    bytes: 128,
    width: 64,
    height: 64,
    origin: 'upload',
  }
  let canvasUploads = 0
  /** One stored text file, addressed the way the real content-addressed store is. */
  const canvasFileAsset = {
    assetId: `${'c'.repeat(64)}.txt`,
    url: `/api/dsh-imagegen/canvas/asset/${'c'.repeat(64)}.txt`,
    mime: 'text/plain',
    bytes: 48,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'notes.txt',
    textPreview: '文件预览正文',
  }
  /** One stored PDF, the document type the browser renders itself. */
  const canvasPdfAsset = {
    assetId: `${'d'.repeat(64)}.pdf`,
    url: `/api/dsh-imagegen/canvas/asset/${'d'.repeat(64)}.pdf`,
    mime: 'application/pdf',
    bytes: 1024,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'paper.pdf',
  }
  /** Preview requests the canvas file nodes issued (assetId + hints). */
  const previewRequests = []
  /** Every fetch path the client issued (debug aid for the canvas tools). */
  const requestPaths = []
  const canvasDocument = {
    version: 2,
    id: 'canvas-smoke',
    title: 'Smoke canvas',
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: 1,
    updatedAt: 1,
  }
  /** A second canvas the project switch can land on. */
  const canvasDocument2 = {
    ...canvasDocument,
    id: 'canvas-two',
    title: 'Second canvas',
    nodes: [{ id: 'node-second', type: 'text', title: 'second', x: 0, y: 0, width: 280, height: 150, metadata: { text: 'second canvas' } }],
  }
  /** Saves the check parks mid-flight, so a superseded answer can be released
   *  on demand instead of racing a real timer. */
  const heldSaves = []
  let heldSaveBudget = 0
  /** While > 0, canvas saves answer with a failure instead of committing. Used
   *  to pin the "a failed save stops retrying" rule (F13). */
  let failSaveBudget = 0
  /** How many save requests answered with a failure. */
  let failedSaveAttempts = 0
  /** PPT conversions this run submitted / sources it uploaded / tasks it lists. */
  const pptSubmissions = []
  const pptUploaded = []
  let pptClientTasks = []
  /** Requests the deck preview issued for `/canvas/file/preview`. */
  const deckPreviewRequests = []
  const fetchStub = async (input, init) => {
    const path = String(input)
    requestPaths.push(path)
    // Tool-result attachments are served as bytes by the host route; the tool
    // view then turns the blob into an object URL. Without this branch the
    // view shows its load error instead of the generated image.
    if (path.startsWith('/api/dsh-imagegen/agent-image?')) {
      return { ok: true, blob: async () => new Blob([pngBytes], { type: 'image/png' }) }
    }
    if (path.endsWith('/settings/describe')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            namespaces: [{
              ns: 'dsh-imagegen',
          value: configState,
          revision: 0,
          secrets: channelSecrets(),
            }],
            writable: true,
          },
        }),
      }
    }
    if (path.endsWith('/video/tasks/list')) {
      videoTaskListCalls += 1
      // Completed tasks expose the served clip (mirroring the host summary), so
      // the canvas can fill its placeholder without a second round trip.
      const tasks = videoTasks.map(task => task.status === 'completed'
        ? {
            ...task,
            resultAvailable: true,
            resultUrl: '/api/dsh-imagegen/video/file/vt-1-0.mp4',
            resultVideo: { url: '/api/dsh-imagegen/video/file/vt-1-0.mp4', mime: 'video/mp4', duration: 5 },
            resultEntryId: 'video-entry-1',
          }
        : { ...task, resultAvailable: false })
      return { ok: true, json: async () => ({ ok: true, tasks }) }
    }
    // #38: the two diagnostics routes the shared panel reads. They live on the
    // same client as the video studio, so the stub has to answer them or the
    // panel's own open action throws instead of showing the record.
    if (path.endsWith('/diagnostics/list')) {
      diagnosticsListCalls += 1
      return { ok: true, json: async () => ({ ok: true, entries: diagnosticsEntries }) }
    }
    if (path.endsWith('/diagnostics/clear')) {
      diagnosticsEntries.length = 0
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (path.endsWith('/video/history/list')) {
      videoHistoryListCalls += 1
      // One clip, interleaved chronologically with the image fixture below:
      // createdAt 6 (newer than every image entry) and createdAt 3 (between the
      // comparison group at 2 and the ecommerce set at 4/5).
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: videoHistoryEntries,
        }),
      }
    }
    if (path.endsWith('/video/history/remove')) {
      const body = JSON.parse(init.body)
      videoHistoryRemovals.push(body.id)
      const index = videoHistoryEntries.findIndex(entry => entry.id === body.id)
      if (index >= 0) videoHistoryEntries.splice(index, 1)
      return { ok: true, json: async () => ({ ok: true, entries: videoHistoryEntries }) }
    }
    if (path.endsWith('/video/history/clear')) {
      videoHistoryEntries.length = 0
      return { ok: true, json: async () => ({ ok: true, entries: [] }) }
    }
    if (path.endsWith('/gallery/video')) {
      return { ok: true, json: async () => ({ ok: true, entries: [], added: true }) }
    }
    // The clip bytes themselves, so "add to chat" can build a real File. Both
    // clip routes are covered: the gallery's favorites and the video store's
    // history clips (the sidebar row uses the latter).
    if (path.includes('/gallery/video-file/') || path.includes('/video/file/')) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }),
      }
    }
    if (path.endsWith('/code/probe')) {
      // The composer asks this before a code run so it can warn about a missing
      // ffmpeg BEFORE a chat call is spent. Report it as available here; the
      // warning branch is covered by its own case in the code-render suite.
      return { ok: true, json: async () => ({ ok: true, probe: { width: 1280, height: 720, fps: 30, seconds: 5, frames: 150, ffmpegAvailable: true, ffmpegPath: '/usr/local/bin/ffmpeg' } }) }
    }
    if (path.endsWith('/video/tasks/submit')) {
      const body = JSON.parse(init.body)
      videoSubmissions.push(body)
      // A canvas-originated run is recorded separately so the canvas test can
      // assert its lineage without confusing it with a studio submission.
      if (body.canvas !== undefined) canvasVideoSubmissions.push(body)
      const task = { id: `vt-${videoSubmissions.length}`, request: body, status: 'queued', createdAt: Date.now() }
      videoTasks.push(task)
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/video/tasks/cancel')) {
      const body = JSON.parse(init.body)
      videoCancellations.push(body.id)
      const task = videoTasks.find(entry => entry.id === body.id)
      if (task !== undefined) task.status = 'cancelled'
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/settings/mutate')) {
      const payload = JSON.parse(init.body)
      mutateCalls.push(payload)
      if (rejectNextSettingsMutation) {
        rejectNextSettingsMutation = false
        return {
          ok: true,
          json: async () => ({ ok: false, code: 'revision-conflict', message: 'settings changed; reload and retry' }),
        }
      }
      for (const op of payload.ops) {
        if (op.path[0] === 'channels' && op.op === 'set') configState.channels = op.value
        if (op.path[0] === 'defaultChannelId') {
          if (op.op === 'set') configState.defaultChannelId = op.value
          else delete configState.defaultChannelId
        }
        if (op.path[0] === 'defaultModel') {
          if (op.op === 'set') configState.defaultModel = op.value
          else delete configState.defaultModel
        }
        if (op.path[0] === 'defaultVideoModel') {
          if (op.op === 'set') configState.defaultVideoModel = op.value
          else delete configState.defaultVideoModel
        }
        // Every channel id, not just `default`: a delete has to clear the
        // removed id's entry, and the stub must show that it really went away.
        if (op.path[0] === 'channelSecrets') {
          const id = op.path[1]
          if (op.op === 'set') keyState.ids[id] = op.value
          else delete keyState.ids[id]
          if (id === 'default') keyState.set = op.op === 'set'
        }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            ns: 'dsh-imagegen',
            value: configState,
            revision: 1,
            secrets: channelSecrets(),
          },
        }),
      }
    }
    if (path.endsWith('/history/list')) {
      const comparisonHistory = {
        comparisonId: 'client-comparison',
        comparisonModels: ['gpt-image-2', 'grok-imagine-image'],
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          // Newest-first, exactly like the host: history-store prepends each new
          // entry ([entry, ...readIndex()]), so array order is insertion order,
          // newest first. A fixture in ascending order would misrepresent the
          // contract the sidebar's two-list merge relies on.
          entries: [
            { id: 'history-plain', createdAt: 7, mode: 'text', model: 'gpt-image-2', prompt: 'plain image prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/plain.png', mime: 'image/png' }] },
            { id: 'hist-ecom-2', createdAt: 5, mode: 'text', model: 'gpt-image-2', prompt: 'product selling point', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom2.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'sp-1', slotLabel: '卖点图' },
            { id: 'hist-ecom-1', createdAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'product main image', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom1.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'main-1', slotLabel: '主图' },
            { id: 'history-grok', createdAt: 2, mode: 'text', model: 'grok-imagine-image', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/grok.png', mime: 'image/png' }], ...comparisonHistory },
            { id: 'history-gpt', createdAt: 1, mode: 'text', model: 'gpt-image-2', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/gpt.png', mime: 'image/png' }], ...comparisonHistory },
          ],
        }),
      }
    }
    if (path.endsWith('/gallery/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }] },
            // A favorited clip: the host stores it by reference, with NO images.
            {
              id: 'gallery-clip', createdAt: 8, mode: 'video', model: 'agnes-video-2.5-flash',
              prompt: 'favorited clip', size: '16:9', quality: '', detail: '', n: 1, images: [],
              video: { url: '/api/dsh-imagegen/gallery/video-file/gallery-clip-0.mp4', mime: 'video/mp4', duration: 5 },
            },
          ],
          // Two soft-deleted entries. Two, not one, because the restore check
          // below brings one back and the trash section unmounts when the last
          // entry leaves it -- with a single fixture the purge button would have
          // been gone by the time the purge check looked for it, which reads as
          // "purge is not rendered" rather than as a fixture that ran out.
          trash: [
            { id: 'gallery-trashed', createdAt: 2, deletedAt: 9, mode: 'text', model: 'gpt-image-2', prompt: 'trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed.png', mime: 'image/png' }] },
            { id: 'gallery-trashed-2', createdAt: 1, deletedAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'older trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed2.png', mime: 'image/png' }] },
          ],
        }),
      }
    }
    // Every gallery mutation answers with the same { entries, trash } pair. The
    // stubs used to be absent, so a client calling one of these threw, the
    // caller's catch swallowed it, and the test stayed green while the UI showed
    // nothing — a silent hole rather than a failure.
    if (path.endsWith('/gallery/remove') || path.endsWith('/gallery/restore') || path.endsWith('/gallery/purge') || path.endsWith('/gallery/clear') || path.endsWith('/gallery/tags')) {
      galleryMutations.push({ path: path.split('/').pop(), body: init?.body ?? null })
      const trashed = { id: 'gallery-trashed', createdAt: 2, deletedAt: 9, mode: 'text', model: 'gpt-image-2', prompt: 'trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed.png', mime: 'image/png' }] }
      // The sibling stays in the trash after the other one is restored, so the
      // purge check still has a rendered section to find its button in.
      const sibling = { id: 'gallery-trashed-2', createdAt: 1, deletedAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'older trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed2.png', mime: 'image/png' }] }
      const purged = path.endsWith('/gallery/purge')
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: path.endsWith('/gallery/restore') ? [trashed, { id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }] }] : [],
          trash: purged ? [] : path.endsWith('/gallery/restore') ? [sibling] : [trashed, sibling],
        }),
      }
    }
    if (path.endsWith('/canvas/list')) {
      const summaryOfCanvas = doc => ({ id: doc.id, title: doc.title, revision: doc.revision, nodeCount: doc.nodes.length, createdAt: 1, updatedAt: 1 })
      return { ok: true, json: async () => ({ ok: true, projects: [summaryOfCanvas(canvasDocument), summaryOfCanvas(canvasDocument2)] }) }
    }
    if (path.endsWith('/canvas/read')) {
      const requested = JSON.parse(init.body).id
      const found = requested === canvasDocument2.id ? canvasDocument2 : canvasDocument
      return { ok: true, json: async () => ({ ok: true, document: found }) }
    }
    if (path.endsWith('/canvas/save')) {
      const payload = JSON.parse(init.body)
      canvasSaves.push(payload.document)
      if (failSaveBudget > 0) {
        failSaveBudget -= 1
        failedSaveAttempts += 1
        // A plain failure, not a conflict: the conflict path reads the canvas
        // back and retries once, which would muddy the count below.
        return { ok: true, json: async () => ({ ok: false, code: 'write-failed', message: '宿主写入失败' }) }
      }
      // Recorded before the hold: a check can see the request landed while its
      // answer is still parked.
      if (heldSaveBudget > 0) {
        heldSaveBudget -= 1
        await new Promise(resolve => { heldSaves.push(resolve) })
      }
      return { ok: true, json: async () => ({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } }) }
    }
    if (path.endsWith('/ppt/tasks')) {
      return { ok: true, json: async () => ({ ok: true, tasks: pptClientTasks }) }
    }
    if (path.endsWith('/ppt/run')) {
      const payload = JSON.parse(init.body)
      pptSubmissions.push(payload)
      // The conversion drops the source images from its result: the panel shows
      // the produced deck, never the uploads.
      const task = {
        id: 'ppt-client-1', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT',
        tier: 'heavy', status: 'completed', startedAt: Date.now(), pptImages: payload.images,
        output: {
          nodes: [{
            id: 'ppt-file', type: 'file', title: 'final.pptx',
            metadata: { asset: { assetId: 'deck.pptx', url: '/api/dsh-imagegen/canvas/asset/deck.pptx', name: 'final.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: 12, width: 0, height: 0, origin: 'upload' } },
          }],
          connections: [], warnings: [],
        },
      }
      pptClientTasks = [task]
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/canvas/skills/list')) {
      return { ok: true, json: async () => ({ ok: true, skills: [], installed: ['image-to-editable-ppt'], agentAvailable: true, registryAvailable: true }) }
    }
    if (path.endsWith('/canvas/skills/library')) {
      return { ok: true, json: async () => ({ ok: true, library: { entries: [] } }) }
    }
    if (path.includes('/canvas/file/upload?')) {
      const name = new URL(path, 'http://localhost').searchParams.get('name')
      const asset = {
        assetId: `${pptUploaded.length + 1}.png`,
        url: `/api/dsh-imagegen/canvas/asset/${pptUploaded.length + 1}.png`,
        mime: init.headers['content-type'], name, bytes: 12, width: 12, height: 12, origin: 'upload',
      }
      pptUploaded.push(asset)
      return { ok: true, json: async () => ({ ok: true, asset }) }
    }
    if (path.endsWith('/canvas/file/preview')) {
      // The real host decodes the asset; the fixture stands in with the decoded
      // shape so the reader can be exercised end to end.
      const payload = JSON.parse(init.body)
      previewRequests.push(payload)
      // A deck decodes to one card per slide; everything else stays text. The
      // PPT panel reads THIS shape (it previews the produced PPTX, not the
      // source images), so returning text for a .pptx would leave its viewer
      // empty and the check would pass on nothing.
      if (payload.assetId === 'preview-retry.pptx') deckPreviewRequests.push(payload)
      const slides = payload.assetId === 'deck.pptx' || payload.assetId === 'preview-retry.pptx'
      return {
        ok: true,
        json: async () => ({
          ok: true,
          preview: slides
            ? {
                kind: 'slides',
                format: 'pptx',
                slides: [
                  { title: 'AI PLATFORM ROADMAP', lines: ['第一页可编辑内容'], images: [] },
                  { title: 'NEXT STEPS', lines: ['第二页可编辑内容'], images: [] },
                ],
                truncated: false,
              }
            : { kind: 'text', format: 'txt', text: '文件预览正文\nsecond line\nthird line', truncated: false, lines: 3 },
        }),
      }
    }
    if (path.endsWith('/canvas/asset/upload')) {
      canvasUploads += 1
      const payload = JSON.parse(init.body)
      return {
        ok: true,
        json: async () => ({
          ok: true,
          asset: {
            assetId: `${String(canvasUploads).padStart(64, 'b')}.png`,
            url: `/api/dsh-imagegen/canvas/asset/${String(canvasUploads).padStart(64, 'b')}.png`,
            mime: 'image/png',
            bytes: 64,
            width: payload.width,
            height: payload.height,
            origin: payload.origin ?? 'upload',
          },
        }),
      }
    }
    if (path.endsWith('/canvas/layers')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plan: {
            layers: [
              { kind: 'background', label: '背景' },
              { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } },
              { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#ffee00' },
            ],
          },
        }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/canvas/asset/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/history/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/gallery/image/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.endsWith('/templates/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          sourceId: 'vibeui',
          cases: [{
            id: 1,
            title: 'Template poster',
            prompt: 'A reusable template prompt',
            category: 'Posters & Typography',
            categoryZh: '海报与排版',
            styles: [],
            scenes: [],
            sourceLabel: '@author',
            sourceUrl: '',
            githubUrl: '',
            image: '',
            featured: false,
          }],
          total: 1,
          origin: 'bundled',
          repository: 'example/templates',
          fetchedAt: '2026-08-19T00:00:00.000Z',
        }),
      }
    }
    if (path.endsWith('/templates/favorites/list')) {
      return { ok: true, json: async () => ({ ok: true, favorites: [] }) }
    }
    if (path.endsWith('/templates/sample')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          samples: [{
            sourceId: 'vibeui',
            case: { id: 1, title: 'Template poster', prompt: 'A reusable template prompt', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false },
          }],
        }),
      }
    }
    if (path.endsWith('/tasks/submit')) {
      const payload = JSON.parse(init.body)
      ecommerceSubmissions.push(payload)
      if (payload.canvas !== undefined) canvasTasks.push(payload)
      // Freeze the id eagerly: the json() closure runs after all concurrent
      // submits pushed, so a lazy template literal would hand every response
      // the same id.
      const task = { id: `ecommerce-task-${ecommerceSubmissions.length}`, request: payload, status: 'queued', createdAt: 1 }
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/tasks/get')) {
      const requestedId = JSON.parse(init.body).id
      const match = /^ecommerce-task-(\d+)$/.exec(requestedId)
      const index = match === null ? -1 : Number(match[1]) - 1
      const payload = index < 0 ? undefined : ecommerceSubmissions[index]
      if (payload === undefined) {
        return { ok: true, json: async () => ({ ok: false, code: 'not-found', message: 'task not found' }) }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          task: {
            id: requestedId,
            request: payload,
            status: index === 0 ? 'completed' : 'queued',
            createdAt: 1,
            ...index === 0 ? { result: { images: [{ b64: 'cG5nLWRhdGE=', mime: 'image/png' }] } } : {},
          },
        }),
      }
    }
    if (path.endsWith('/tasks/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: ecommerceSubmissions.map((payload, index) => {
            const request = { ...payload }
            delete request.image
            delete request.images
            return {
              id: `ecommerce-task-${index + 1}`,
              request,
              status: index === 0 ? 'completed' : 'queued',
              createdAt: 1,
              resultAvailable: index === 0,
            }
          }),
        }),
      }
    }
    // The two routes the form workspaces submit to. Answered here so a submit
    // click completes instead of landing on the catch-all below: the checks that
    // count requests need the request to be recorded, and a throw here would
    // also paint an error into the workspace a later check reads.
    if (path.endsWith('/generate')) {
      return { ok: true, json: async () => ({ ok: true, images: [{ mime: 'image/png', b64: pngBytes.toString('base64') }] }) }
    }
    if (path.endsWith('/prompt-enhance')) {
      return { ok: true, json: async () => ({ ok: true, prompt: JSON.stringify({ title: '促销标题', body: '促销正文', tags: ['好物'] }) }) }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }

  // Evaluate the bundle in a jsdom-backed sandbox.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: jsdomWindow,
    document: jsdomDocument,
    MutationObserver: jsdomWindow.MutationObserver,
    ResizeObserver: jsdomWindow.ResizeObserver,
    CustomEvent: jsdomWindow.CustomEvent,
    HTMLElement: jsdomWindow.HTMLElement,
    FileReader: jsdomWindow.FileReader,
    // image-ops decodes asset URLs through `new Image()`; jsdom never loads
    // resources, so the stub resolves onload on the next tick.
    Image: class SmokeImage {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0 }
      set src(value) {
        this._src = value
        setTimeout(() => {
          this.naturalWidth = 64
          this.naturalHeight = 64
          this.onload?.()
        }, 0)
      }
      get src() { return this._src }
    },
    fetch: fetchStub,
    // The tool view turns a fetched blob into an <img> source. jsdom ships
    // neither, and the bundle reads them off the global scope.
    URL: class SmokeURL extends URL {
      static createObjectURL() { return 'blob:image-toolview-smoke' }
      static revokeObjectURL() {}
    },
    URLSearchParams,
    console,
  }
  // jsdom's window.window is a getter-only property; only plain-object
  // sandboxes need the self-reference.
  if (!('window' in sandbox.window)) sandbox.window.window = sandbox.window
  sandbox.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined)

  const registered = []
  // Locale runtime stub: register/addLanguage/subscribe + a snapshot, mirroring
  // the dsh-client-locale face the plugin bridges into.
  const localeListeners = new Set()
  // Records what the composer rail receives, so the clip-attachment path can be
  // asserted without a real GUI.
  const conversationDrafts = []
  const conversationInputs = []
  const conversationStub = {
    createDrafts: (sessionId, files) => files.map((file, index) => {
      conversationDrafts.push({ sessionId: String(sessionId), name: file.name, type: file.type, size: file.size })
      return { id: `draft-${index + 1}`, kind: /^image\//.test(file.type) ? 'image' : 'file' }
    }),
    releaseDraftAttachments: () => {},
    input: {
      for: () => ({
        addAttachments: (ids) => { conversationInputs.push(...ids); return true },
        removeAttachment: () => {},
        state: { getSnapshot: () => ({ draft: '' }) },
        setDraft: () => {},
      }),
    },
  }
  /** Minimal session list feed: the panel only reads `current` and `scope`. */
  const sessionsStub = {
    list: { getSnapshot: () => ({ current: 'session-smoke' }), subscribe: () => () => {} },
    scope: () => ({ sessionId: 'session-smoke' }),
  }
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    get(name) {
      // A page served through a loopback reverse proxy is NOT a loopback
      // authority in the browser (the address bar carries the LAN/public
      // hostname), yet its requests reach the host from 127.0.0.1. The
      // settings card must probe the bridge instead of pre-blocking on this
      // flag; every settings assertion below is the regression guard for that.
      if (name === 'connection') return { isLoopback: false }
      // The panel reads the conversation service from the context; without it
      // the "add to chat" actions cannot be exercised at all.
      if (name === 'conversation') return conversationStub
      // The panel resolves the current session through `sessions`, and its
      // chat-attachment actions no-op without one. Supplying a minimal list
      // feed is what makes those actions reachable at all.
      if (name === 'sessions') return sessionsStub
      return undefined
    },
    locale: {
      register() {},
      addLanguage() { return () => {} },
      getLocale() { return { active: 'zh', locales: [], revision: 0 } },
      subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn) },
    },
    slots: {
      // The Web UI plugin group slot is already declared.
      // `inject` may return an iterable of disposers (the tool-view registrations
      // yield one per tool), and `register` takes the component as a second
      // argument — a stub that dropped it made every toolview check vacuous.
      inject(key, callback) {
        const result = callback()
        if (result?.[Symbol.iterator]) for (const _dispose of result) { /* drain */ }
        return () => {}
      },
      register(options, component) { registered.push({ ...options, component }); return () => {} },
    },
  }
  // react-dom (outer realm) reads the bare `window`/`document` globals at
  // render time (dev-branch event priority, event delegation); expose the
  // jsdom ones for the render.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = jsdomWindow
  globalThis.document = jsdomDocument
  const react = await import('react')
  const moduleStubs = {
    'react': react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    // Minimal functional stubs for the system primitives (the real GUI loads
    // the genuine platform module from the module table).
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: ({ variant, size, className, children, ...rest }) =>
        react.createElement('button', { type: 'button', className, ...rest }, children),
      Pill: ({ active, className, children, onClick, ...rest }) =>
        react.createElement(onClick ? 'button' : 'span', {
          type: 'button',
          className,
          ...(onClick !== undefined ? { onClick } : {}),
          ...rest,
        }, children),
    },
    // The real runtime module touches `window` at import time and cannot load
    // in a bare Node realm; this minimal store mirrors the snapshot-store
    // contract (mutable-draft update, wholesale set, subscriber fan-out) that
    // the plugin's scope lifecycle depends on.
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: (initial) => {
        let snapshot = initial
        const listeners = new Set()
        return {
          getSnapshot: () => snapshot,
          set: (next) => {
            snapshot = next
            for (const fn of [...listeners]) fn()
          },
          update: (mutator) => {
            const draft = { ...snapshot }
            mutator(draft)
            snapshot = draft
            for (const fn of [...listeners]) fn()
          },
          subscribe: (fn) => {
            listeners.add(fn)
            return () => { listeners.delete(fn) }
          },
        }
      },
    },
  }
  const exportsOf = handoff.factory((spec) => {
    const stub = moduleStubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })

  exportsOf.apply(ctx)
  // #46: DSH's Web client forwards persisted result metadata (it does not call
  // the host's presentResult), while older sessions only kept JSON or image
  // content blocks. All three shapes have to yield the same visible image, and
  // none may show a duplicate or an errored result's images.
  const rawImage = {
    attachment_id: 'issue-46-image', media_type: 'image/png', bytes: pngBytes.length,
    width: 1, height: 1, name: 'chat-result.png',
  }
  const toolBlock = {
    kind: 'tool-result',
    callId: 'call-image',
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ status: 'completed', message: 'done', images: [rawImage] }) }],
    meta: { images: [rawImage] },
  }
  const refsOf = exportsOf.imageRefsOf
  assert.equal(typeof refsOf, 'function', 'the tool-view ref reader is part of the built bundle')
  assert.equal(refsOf(toolBlock)[0].attachmentId, rawImage.attachment_id, 'persisted metadata alone is enough')
  assert.equal(refsOf({ ...toolBlock, meta: undefined }).length, 1, 'a JSON-only tool result stays visible on replay')
  const directImage = { type: 'image', attachment: refsOf(toolBlock)[0] }
  assert.equal(refsOf({ ...toolBlock, content: [directImage, ...toolBlock.content] }).length, 1, 'content and metadata refs are deduplicated')
  assert.equal(refsOf({ ...toolBlock, isError: true }).length, 0, 'a failed call shows no image')
  assert.equal(refsOf({ phase: 'start' }).length, 0, 'an in-flight call shows no image')
  assert.equal(
    refsOf({ ...toolBlock, content: [], meta: { images: [{ ...rawImage, width: -1 }, null, {}] } }).length,
    0,
    'an invalid reference is dropped rather than rendered broken',
  )
  const toolviewHost = jsdomDocument.createElement('div')
  jsdomDocument.body.append(toolviewHost)
  const toolviewRoot = moduleStubs['react-dom/client'].createRoot(toolviewHost)
  for (const toolName of ['generate_image', 'edit_image', 'get_image_generation_task']) {
    const registration = registered.find(row => row.name === 'tool.call.toolview' && row.key === toolName)
    assert.ok(registration?.component, `${toolName} registers its real conversation renderer`)
    toolviewRoot.render(react.createElement(registration.component, {
      key: toolName, sessionId: 'issue-46-other', toolName, callId: 'call-image', block: toolBlock,
    }))
    assert.ok(
      await waitUntil(() => toolviewHost.querySelector('img')?.getAttribute('src') === 'blob:image-toolview-smoke'),
      `${toolName} displays a metadata-only generated image`,
    )
    assert.equal(toolviewHost.querySelectorAll('img').length, 1, `${toolName} shows the image once`)
    assert.equal(toolviewHost.querySelector('a')?.getAttribute('href'), 'blob:image-toolview-smoke', `${toolName} links the full image`)
  }
  toolviewRoot.unmount()
  toolviewHost.remove()
  // In-app prompts must open Settings through its rendered dialog affordances
  // and select the image-generation section.
  const settingsTrigger = jsdomDocument.createElement('button')
  settingsTrigger.setAttribute('aria-haspopup', 'dialog')
  settingsTrigger.setAttribute('aria-label', '设置')
  const settingsNavButton = jsdomDocument.createElement('button')
  settingsNavButton.textContent = '生图配置'
  let settingsSectionClicks = 0
  settingsNavButton.addEventListener('click', () => { settingsSectionClicks += 1 })
  settingsTrigger.addEventListener('click', () => {
    const dialog = jsdomDocument.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = jsdomDocument.createElement('nav')
    nav.append(settingsNavButton)
    dialog.append(nav)
    jsdomDocument.body.append(dialog)
  })
  jsdomDocument.body.append(settingsTrigger)
  jsdomWindow.dispatchEvent(new jsdomWindow.CustomEvent('dsh-imagegen:open-config'))
  assert.ok(await waitUntil(() => settingsSectionClicks === 1), 'in-app configure prompts select the settings.section entry')
  jsdomDocument.querySelector('[role="dialog"]')?.remove()
  settingsTrigger.remove()
  // Wait for the bridge fetch + scope settle + sidebar entry. The studio is
  // intentionally loaded without history images until the image tab activates.
  await waitForSelectorCount(jsdomDocument, '[data-dsh-imagegen-session-tabs]', 1)
  assert.equal(jsdomDocument.querySelectorAll('[data-dsh-imagegen-history] img').length, 0, 'inactive studio renders no history images')
  assert.equal(
    requestPaths.some(path => path.endsWith('/history/list') || path.endsWith('/gallery/list')),
    false,
    'inactive studio does not request history or gallery data',
  )
  jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]')
    .dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  await waitForSelectorCount(jsdomDocument, '[data-comparison]', 1)

  try {
    // Regression: the scope must settle (a scope that never loads leaves the
    // UI unmounted forever) and the two session tabs must be inserted.
    const entry = jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]')
    assert.ok(entry !== null, 'session tabs were mounted')
    assert.equal(entry.querySelectorAll('[data-dsh-imagegen-tab]').length, 2, 'session and image tabs are present')
    assert.ok(entry.textContent.includes('生图'), 'image tab label localized')
    assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-entry]') === null, true, 'standalone image entry was removed')
    const view = jsdomDocument.querySelector('[data-dsh-imagegen-view]')
    assert.ok(view !== null, 'studio view container was mounted')
    assert.ok(view.isConnected, 'view container attached to the center column')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-chat-resizer]') !== null, 'chat resizer was mounted')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history]') !== null, 'history moved into the sidebar region')
    assert.equal(view.querySelector('[data-dsh-imagegen-history]') === null, true, 'studio no longer owns the history column')
    assert.ok(jsdomDocument.querySelector('[data-history-new]') !== null, 'new creation button rendered beside history clear')
    assert.ok(jsdomDocument.querySelector('[data-history-clear]') !== null, 'history clear button rendered')
    jsdomDocument.querySelector('[data-history-clear]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(confirmationCalls, 1, 'history clear asks for confirmation')
    // The panel header rendered.
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-view] h2') !== null, 'panel header rendered')
    const connectionStatus = jsdomDocument.querySelector('[data-dsh-imagegen-view] [data-connected]')
    assert.equal(connectionStatus?.getAttribute('data-connected'), 'false', 'missing key is shown as disconnected')
    assert.equal(jsdomDocument.querySelectorAll('[data-comparison]').length, 1, 'comparison history rows collapse into one item')
    assert.ok(jsdomDocument.querySelector('[data-comparison]')?.textContent?.includes('gpt-image-2'), 'comparison history shows its models')

    // Issue #19 regression: DSH 0.1.5+ seats the Conversation in the keyed
    // `main` slot instead of a `conversation` slot, whose anchors are
    // layout-neutral. The studio takeover must keep that slot (hiding it leaves
    // the chat pane blank) and must place the Conversation root inside the chat
    // track. jsdom's cascade cannot evaluate this selector shape (an
    // attribute-valued ancestor with a child combinator) and does not apply
    // `!important` sheet rules over inline styles, so the takeover is asserted
    // through selector matching and the placement through the shipped sheet's
    // own declarations.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]')
      .dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), 'the image tab opens the studio')
    const historyFilter = jsdomDocument.querySelector('button[data-dsh-select][aria-label="模型筛选"]')
    assert.ok(historyFilter !== null, 'history uses the shared rounded selector')
    historyFilter.click()
    await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
    const historyFilterMenu = jsdomDocument.querySelector('[data-dsh-select-menu]')
    assert.equal(historyFilterMenu.parentElement, jsdomDocument.body, 'the menu escapes sidebar clipping')
    // jsdom cannot resolve custom properties, so the cascade hands back the
    // token itself. The contract records what DSH's theme resolves it to
    // (radius-md = 12px, docs/native-ui-contract.md), so asserting the token is
    // both stricter and honest: a hardcoded px would fail here even at 12px.
    assert.equal(jsdomWindow.getComputedStyle(historyFilterMenu).borderRadius, 'var(--dsw-radius-md)', 'filters use the same rounded menu as channel selection, through the native radius token')
    historyFilterMenu.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(historyFilterMenu.getAttribute('aria-activedescendant'), historyFilterMenu.querySelector('[role="option"]:last-child').id, 'End moves keyboard focus to the last option')
    historyFilterMenu.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.querySelector('[data-dsh-select-menu]') === null, true, 'Escape closes the menu')
    assert.equal(jsdomDocument.activeElement, historyFilter, 'closing the menu restores keyboard focus')
    assert.ok(historyFilter.textContent.includes('全部模型'), 'canceling preserves the current filter')
    const chatToggle = view.querySelector('button[data-open]')
    assert.ok(chatToggle !== null, 'chat toggle rendered in the panel header')
    chatToggle.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-chat-collapsed'), false, 'the chat toggle opens the chat track')
    const centreCol = jsdomDocument.querySelector('.smoke_centerCol')
    const mainSlot = centreCol.querySelector('[data-slot="main"]')
    const conversationRoot = centreCol.querySelector('[data-slot="main.conversation"] > [data-phase]')
    assert.ok(mainSlot !== null && conversationRoot !== null, 'the 0.1.5+ conversation fixture stays mounted')
    // The column is addressed by OUR mark, not by a class-name guess: the
    // shell's `centerCol` is a build-time hash, so a `[class*='centerCol']`
    // selector here would keep passing on a fixture that spells the class while
    // the shipped sheet matches nothing at all.
    assert.equal(centreCol.getAttribute('data-dsh-imagegen-center-col'), '', 'the resolved column carries our mark, which is what the sheet addresses')
    const takeoverSelector = "html[data-dsh-imagegen-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-dsh-imagegen-center-col] > :not([data-dsh-imagegen-view]):not([data-slot='conversation']):not([data-slot='main']):not([data-dsh-imagegen-chat-resizer])"
    assert.equal(mainSlot.matches(takeoverSelector), false, 'the keyed main slot survives the studio takeover')
    assert.equal(centreCol.querySelector('[data-other-plugin-entry]').matches(takeoverSelector), true, 'unrelated center-column entries are still hidden')
    // #38: a shell global panel (the plugin market page) registers into the SAME
    // keyed `main` slot as the Conversation. The direct-child rule above let the
    // anchor through and therefore left that page rendering inside it, so the
    // studio ended up sharing the column with a live panel. Assert on computed
    // style, not selector matching: only the cascade proves the page is gone.
    const shellPanelSelector = "html[data-dsh-imagegen-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-slot='main'] > :not([data-dsh-imagegen-view]):not([data-phase]):not([data-slot='main.conversation'])"
    const shellPanel = jsdomDocument.createElement('div')
    shellPanel.setAttribute('data-shell-panel', 'plugins')
    shellPanel.textContent = 'plugin market page'
    mainSlot.append(shellPanel)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(
      jsdomWindow.getComputedStyle(shellPanel).display,
      'none',
      'a shell panel rendered into the keyed main slot yields the column to the studio (#38)',
    )
    assert.equal(shellPanel.matches(shellPanelSelector), true, 'the shell-panel rule reaches entries nested inside the main anchor')
    assert.notEqual(
      jsdomWindow.getComputedStyle(conversationRoot).display,
      'none',
      'replacing the main entry never hides the conversation fixture itself',
    )
    shellPanel.remove()
    await new Promise(resolve => setTimeout(resolve, 20))
    const collapseSelector = "html[data-dsh-imagegen-chat-collapsed][data-dsh-imagegen-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-slot='main.conversation'] > [data-phase]"
    assert.equal(conversationRoot.matches(collapseSelector), false, 'the open chat track keeps the conversation root')
    // The shipped sheet carries the chat-track placement and the stretch; the
    // minifier may fold the placement into the `grid-area` shorthand.
    const chatTrackDeclarations = [...jsdomDocument.styleSheets]
      .flatMap(sheet => [...sheet.cssRules])
      .filter(rule => typeof rule.selectorText === 'string' && rule.selectorText.includes('main\\.conversation') && rule.selectorText.includes('[data-phase]'))
      .map(rule => rule.style.cssText)
      .join(' ; ')
    assert.match(chatTrackDeclarations, /grid-area:\s*1\s*\/\s*3|grid-column:\s*3/, 'the conversation root is placed in the chat track')
    assert.match(chatTrackDeclarations, /width:\s*100%/, 'the conversation root stretches over the chat track')
    assert.match(chatTrackDeclarations, /max-width:\s*none/)
    assert.match(chatTrackDeclarations, /display:\s*none/, 'the collapsed chat track still hides the conversation root')
    chatToggle.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-chat-collapsed'), 'the chat toggle collapses the track again')
    assert.equal(conversationRoot.matches(collapseSelector), true, 'the collapsed chat track drops the conversation root')
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="session"]')
      .dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), false, 'the studio closes again')
    assert.equal(nativeNewSessionCalls, 0, 'returning to the current conversation never starts a new session')

    // The native action must both create a session and close the studio, even
    // when the shell exposes no recognizable newSession CSS class.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]').click()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), true)
    nativeNewSession.className = ''
    nativeNewSession.click()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(nativeNewSessionCalls, 1, 'the native New Session handler still runs exactly once')
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), false, 'the native action returns from the studio to the conversation')
    assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-tab="session"]').hasAttribute('data-active'), true, 'the switcher follows the native action')
    nativeNewSession.className = 'newSession'

    // Gallery keeps the sidebar history visible, and selecting one history
    // group returns the center workspace to text-to-image.
    const tablistButtons = [...view.querySelectorAll('[role="tablist"] button')]
    // Eight top-nav entries (normal / gallery / canvas / ecommerce / ppt /
    // replica / outfit / aplus) plus the normal workspace's three generation modes.
    assert.equal(tablistButtons.length, 12, 'top nav has nine entries and the normal workspace shows three generation modes')
    const pptSwitch = tablistButtons.find(button => button.textContent?.includes('图片转 PPT'))
    assert.ok(pptSwitch !== undefined, 'ppt top-nav entry is present')
    const ecommerceSwitch = tablistButtons.find(button => button.textContent?.includes('电商模式'))
    assert.ok(ecommerceSwitch !== undefined, 'ecommerce top-nav entry is present')
    const normalSwitch = tablistButtons.find(button => button.textContent?.includes('普通生图'))
    assert.ok(normalSwitch !== undefined, 'normal top-nav entry is present')
    const canvasSwitch = tablistButtons.find(button => button.textContent?.includes('无限画布'))
    assert.ok(canvasSwitch !== undefined, 'infinite canvas top-nav entry is present')
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    const ecommerceWorkspace = view.querySelector('[data-ecommerce-workspace]')
    assert.ok(ecommerceWorkspace !== null, 'ecommerce workspace is rendered')
    assert.equal(jsdomWindow.getComputedStyle(ecommerceWorkspace).fontSize, '12px', 'ecommerce UI inherits the compact panel type scale')
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 9, 'generation sub-modes hide in the ecommerce workspace')
    assert.equal([...view.querySelectorAll('textarea')].some(textarea => (textarea.getAttribute('placeholder') ?? '').includes('描述你想要的画面')), false, 'normal prompt card is hidden in ecommerce workspace')
    const ecommerceName = view.querySelector('input[placeholder="商品名称（必填）"]')
    assert.ok(ecommerceName !== null, 'ecommerce product form is rendered')
    // Fill the product name through the native value setter (React 18 +
    // jsdom), then open the local plan preview: this must not call the host.
    const nativeInputSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLInputElement.prototype, 'value').set
    const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set
    nativeInputSetter.call(ecommerceName, '测试保温杯')
    ecommerceName.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(view.querySelectorAll('input[placeholder="项目名称（可选）"]').length, 0, 'project name input was removed')
    const ecommerceLanguage = view.querySelector('button[data-dsh-select][aria-label="文案语言"]')
    assert.ok(ecommerceLanguage !== null, 'ecommerce copy language selector is rendered')
    ecommerceLanguage.click()
    await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
    const customLanguageOption = [...jsdomDocument.querySelectorAll('[data-dsh-select-menu] [role="option"]')].find(option => option.textContent === '自定义…')
    assert.ok(customLanguageOption !== undefined, 'the rounded language menu offers custom languages')
    customLanguageOption.click()
    await new Promise(resolve => setTimeout(resolve, 20))
    const customLanguage = view.querySelector('input[placeholder*="语言名称"]')
    assert.ok(customLanguage !== null, 'custom language input is rendered')
    nativeInputSetter.call(customLanguage, 'Русский')
    customLanguage.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    // Upload one product asset through the multi-file input and mark the
    // scene slot as reference-free: the confirm flow must resolve each slot's
    // reference role into an edit or text request accordingly.
    const ecommerceUploadInput = view.querySelector('input[type="file"][multiple]')
    assert.ok(ecommerceUploadInput !== null, 'ecommerce multi-upload input is rendered')
    const assetFile = new jsdomWindow.File(['cup'], 'cup.png', { type: 'image/png' })
    Object.defineProperty(ecommerceUploadInput, 'files', { value: { 0: assetFile, length: 1 }, configurable: true })
    ecommerceUploadInput.dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(view.querySelector('[data-ecommerce-asset]') !== null, 'uploaded product asset renders as a chip')
    const refToggle = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('参考图设置'))
    assert.ok(refToggle !== undefined, 'reference-role settings toggle is rendered')
    refToggle.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    const refSelects = [...view.querySelectorAll('button[data-ecommerce-ref-select]')]
    assert.equal(refSelects.length, 4, 'every enabled slot exposes a reference-role selector')
    refSelects[2].click()
    await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
    const noReferenceOption = [...jsdomDocument.querySelectorAll('[data-dsh-select-menu] [role="option"]')].find(option => option.textContent === '不使用参考图')
    assert.ok(noReferenceOption !== undefined, 'the rounded reference menu offers reference-free generation')
    noReferenceOption.click()
    await new Promise(resolve => setTimeout(resolve, 20))
    // A layout reference is not a picture of the product, so the slot menu has to
    // offer that role separately from the product shot; otherwise a template can
    // only be uploaded as the product itself and the model copies its subject.
    {
      const probe = [...view.querySelectorAll('button[data-ecommerce-ref-select]')][0]
      probe.click()
      await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
      const options = [...jsdomDocument.querySelectorAll('[data-dsh-select-menu] [role="option"]')]
      const layoutOption = options.find(option => option.textContent === '版式参考')
      assert.ok(layoutOption !== undefined, 'the reference menu offers the layout role')
      const productOption = options.find(option => option.textContent === '商品主体')
      assert.ok(productOption !== undefined, 'the reference menu keeps the product role')
      productOption.click()
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const previewSet = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('生成套图预览'))
    assert.ok(previewSet !== undefined, 'ecommerce preview action is rendered')
    previewSet.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(view.textContent?.includes('预计生成'), 'ecommerce plan preview is shown')
    const ecommercePreviewTextareas = [...view.querySelectorAll('[data-ecommerce-preview] textarea')]
    assert.equal(ecommercePreviewTextareas.length, 6, 'every planned ecommerce image gets a preview prompt')
    assert.equal(new Set(ecommercePreviewTextareas.map(textarea => textarea.value)).size, 6, 'multi-image slots receive distinct automatic prompts')
    const polishButtons = [...view.querySelectorAll('[data-ecommerce-preview] button')].filter(button => button.textContent?.includes('AI 润色'))
    assert.equal(polishButtons.length, 6, 'every ecommerce preview prompt exposes AI polish')
    assert.equal(ecommerceSubmissions.length, 0, 'plan preview must not submit generation tasks')

    // ------------------------------------------------------ PPT workspace
    // The production panel, driven the way a user drives it: upload two
    // sources, reorder them, convert, then read the produced deck. Nothing
    // here stubs the component, so a regression in its wiring fails a check
    // instead of passing as a no-op.
    // Re-query the nav: switching workspaces re-renders the tab list, so a
    // button captured earlier is detached and its click reaches nothing.
    // A local predicate helper: this scope declares its own `waitUntil` further
    // down, and using that name here would hit the temporal dead zone.
    const waitPpt = async (predicate, timeout = 3000) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      return predicate()
    }
    // The studio was closed by the native "new session" action above, so the
    // tab strip is visible but the panel is mounted inactive — `active` gates
    // `PptWorkspace`'s `hidden`. Re-open the studio through the image tab the
    // way a user would before switching workspaces.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]')
      .dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(
      await waitPpt(() => jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active')),
      'the studio re-opens before the PPT workspace is exercised',
    )
    const pptTab = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('图片转 PPT'))
    assert.ok(pptTab !== undefined, 'the PPT entry survives a workspace switch')
    pptTab.click()
    const pptShown = await waitPpt(() => {
      const el = view.querySelector('[data-ppt-workspace]')
      return el !== null && el.hidden === false
    }, 3000)
    assert.ok(
      pptShown,
      `the PPT tab shows its workspace — tabs=${[...view.querySelectorAll('[role="tablist"] button')].map(b => `${b.textContent}:${b.getAttribute('aria-selected')}`).join('|')} pptNodes=${view.querySelectorAll('[data-ppt-workspace]').length} hidden=${String(view.querySelector('[data-ppt-workspace]')?.hidden)} attr=${String(view.querySelector('[data-ppt-workspace]')?.getAttribute('hidden'))} parentHidden=${String(view.querySelector('[data-ppt-workspace]')?.parentElement?.hidden)}`,
    )
    const pptView = view.querySelector('[data-ppt-workspace]')
    assert.ok(pptView !== null, 'the PPT workspace is rendered')
    // The upload hero is replaced by the thumbnail grid once a source exists,
    // and the add tile is the way back to the picker.
    assert.ok(pptView.querySelector('[data-ppt-upload-empty]') !== null, 'an empty conversion offers the upload area')
    const pptUpload = pptView.querySelector('input[type="file"]')
    assert.ok(pptUpload !== null, 'the workspace has a file input')
    const fileFor = name => new dom.window.File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
    Object.defineProperty(pptUpload, 'files', { value: [fileFor('slide-1.png')], configurable: true })
    pptUpload.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    assert.ok(await waitPpt(() => pptView.querySelectorAll('[data-ppt-input]').length === 1), 'the first upload becomes a thumbnail')
    assert.ok(pptView.querySelector('[data-ppt-upload-empty]') === null, 'thumbnails replace the upload hero')
    assert.ok(pptView.querySelector('[data-ppt-add]') !== null, 'an add tile offers more sources')
    Object.defineProperty(pptUpload, 'files', { value: [fileFor('slide-2.png')], configurable: true })
    pptUpload.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    assert.ok(await waitPpt(() => pptView.querySelectorAll('[data-ppt-input]').length === 2), 'the second upload appends')
    // Source order is slide order, and the reorder control is what changes it.
    assert.ok(pptView.querySelector('[data-ppt-input]').textContent.includes('slide-1.png'))
    pptView.querySelectorAll('[data-ppt-input]')[1].querySelector('button[aria-label="向前移动一页"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitPpt(() => pptView.querySelector('[data-ppt-input]').textContent.includes('slide-2.png')), 'the reorder control changes the slide order')
    // Configuration opens in place instead of hunting for the host's button.
    pptView.querySelector('[data-ppt-open-settings]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await waitForSelector(jsdomDocument, '[role="dialog"][aria-label="图片转 PPT 配置"]')
    assert.ok(jsdomDocument.querySelector('[data-ppt-setup]') !== null, 'the configuration dialog renders its fields')
    jsdomDocument.querySelector('[role="dialog"][aria-label="图片转 PPT 配置"] button[aria-label="关闭"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(jsdomDocument.querySelector('[role="dialog"][aria-label="图片转 PPT 配置"]') === null, true, 'the configuration dialog closes')
    pptView.querySelector('[data-ppt-convert]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitPpt(() => pptSubmissions.length === 1), 'the convert button starts a conversion')
    assert.deepEqual(pptSubmissions[0].images.map(image => image.name), ['slide-2.png', 'slide-1.png'], 'the conversion sends the sources in the order the user set')
    assert.equal(pptSubmissions[0].offlineOcr, true, 'the default OCR choice reaches the host')
    assert.ok(await waitPpt(() => pptView.querySelector('a[download="final.pptx"]') !== null), 'the finished deck is downloadable')
    // The result pane shows the produced deck only — never the sources — and
    // opens its first slide without another click.
    assert.equal(pptView.querySelectorAll('[data-ppt-task] img').length, 0, 'the result pane shows no source images')
    assert.ok(await waitPpt(() => (pptView.querySelector('[data-ppt-slide="1"]')?.textContent ?? '').includes('第一页可编辑内容')), 'the produced deck opens inline')
    pptView.querySelector('[data-ppt-page="2"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitPpt(() => (pptView.querySelector('[data-ppt-slide="2"]')?.textContent ?? '').includes('第二页可编辑内容')), 'the filmstrip switches slides')
    pptView.querySelector('[data-ppt-preview]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await waitForSelector(jsdomDocument, '[role="dialog"][aria-label="final.pptx"]')
    assert.ok(await waitPpt(() => (jsdomDocument.querySelector('[role="dialog"]')?.textContent ?? '').includes('AI PLATFORM ROADMAP')), 'the expanded viewer previews the deck')
    jsdomDocument.querySelector('[role="dialog"][aria-label="final.pptx"] [aria-label="关闭"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(jsdomDocument.querySelector('[role="dialog"][aria-label="final.pptx"]') === null, true, 'closing dismisses the expanded viewer')

    // Back to the normal workspace via the top nav: gallery works as before.
    normalSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 12, 'generation sub-modes return in the normal workspace')
    const galleryPill = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('素材库'))
    assert.ok(galleryPill !== undefined, '素材库入口存在')
    galleryPill.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    await waitForSelector(view, '[data-gallery-add-conversation]')
    assert.equal(view.querySelector('textarea[placeholder*="描述你想要的画面"]') === null, true, 'gallery hides normal generation prompt')
    assert.equal(view.querySelector('button[class*="generateButton"]') === null, true, 'gallery hides normal generation button')
    assert.equal(view.textContent?.includes('灵感案例'), false, 'gallery hides inspiration examples')
    assert.ok(view.querySelector('[data-gallery="true"]') !== null, 'gallery workspace is isolated')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history]') !== null, 'history remains visible in gallery mode')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 2, 'gallery mode is active')
    assert.ok(view.querySelector('[data-gallery="true"] [data-gallery-add-conversation]') !== null, 'gallery entries expose add-to-conversation action')
    // Target a PLAIN image row. The sidebar now also lists clips (which open the
    // video studio) and product sets (which rebuild the ecommerce canvas), so
    // neither is what this assertion is about: it checks that selecting an
    // ordinary image history entry restores the image board.
    const galleryHistoryMain = [...jsdomDocument.querySelectorAll('[data-dsh-imagegen-history-host] [data-kind="image"]')]
      .find(row => row.textContent?.includes('plain image prompt'))
      ?.querySelector('[data-dsh-imagegen-history-main]')
    assert.ok(galleryHistoryMain !== null && galleryHistoryMain !== undefined, 'gallery mode exposes clickable image history')
    galleryHistoryMain.click()
    await waitForSelector(view, '[data-count]')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 0, 'history click returns to text-to-image')
    assert.ok(view.querySelector('textarea[placeholder*="描述你想要的画面"]') !== null, 'normal prompt returns after gallery')
    assert.ok(view.querySelector('[class*="generateButton"]') !== null, 'normal generate button returns after gallery')
    assert.ok(view.querySelectorAll('[data-count]').length > 0, 'history result is visible before starting a new creation')
    jsdomDocument.querySelector('[data-history-new]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(view.querySelectorAll('[data-count]').length, 0, 'new creation clears the image preview')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 0, 'new creation returns to text-to-image')

    const galleryTab = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('素材库'))
    assert.ok(galleryTab !== undefined, '素材库入口仍存在')
    galleryTab.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    // ------------------------------------------------- gallery clips (素材库)
    // This runs while the gallery is still open and populated (it precedes the
    // gallery-clear step below), which is BEFORE the shared `waitUntil` helper is
    // declared -- so it brings its own.
    const waitFor = async (predicate, timeout = 2500) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      return predicate()
    }
    // A favorited clip has NO images (the host stores it by reference), so the
    // card must render a <video> rather than being skipped as "no image".
    assert.ok(view.querySelector('[data-gallery-clip-card], article[data-clip]') !== null, 'a clip card renders in the gallery')
    const clipCard = view.querySelector('article[data-clip]')
    assert.ok(clipCard !== null, 'the clip card is marked as a clip')
    assert.ok(clipCard.querySelector('video') !== null, 'the clip card renders a video element')
    assert.match(clipCard.querySelector('video').getAttribute('src'), /gallery\/video-file\//, 'the clip card plays the served gallery clip URL')
    assert.equal(clipCard.querySelector('img') === null, true, 'a clip card does not fake an image')
    assert.ok(clipCard.textContent?.includes('视频'), 'the clip card is badged as a video')
    // The clip card offers a download and NOT the image-only conversation action.
    assert.ok(clipCard.querySelector('[data-gallery-video-download]') !== null, 'the clip card offers download')
    assert.ok(clipCard.querySelector('[data-gallery-video-canvas]') !== null, 'the clip card offers add-to-canvas')
    assert.equal(clipCard.querySelector('[data-gallery-add-conversation]') === null, true, 'the clip card has no image-only add-to-conversation')

    // The image card is unaffected and keeps its own actions.
    const imageCard = [...view.querySelectorAll('article')].find(card => card.getAttribute('data-clip') === null && card.querySelector('img') !== null)
    assert.ok(imageCard !== undefined, 'the image card still renders')
    assert.ok(imageCard.querySelector('[data-gallery-add-conversation]') !== null, 'the image card keeps add-to-conversation')

    // The 视频 filter bucket selects exactly the clips and its badge agrees.
    // Match BUTTONS: the `galleryFilters` CONTAINER also carries a matching class
    // and swallowing the click there would silently apply no filter at all.
    const videoChip = [...view.querySelectorAll('button[class*="galleryFilter"]')].find(chip => chip.textContent?.includes('视频'))
    assert.ok(videoChip !== undefined, 'the gallery offers a video filter bucket')
    videoChip.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.ok(view.querySelector('article[data-clip]') !== null, 'the video filter keeps the clip')
    // Avoid `:not()` here: jsdom evaluates it across the whole subtree, which is
    // slow and memory-hungry on this fixture. Counting the cards directly is
    // both cheaper and more precise.
    assert.equal([...view.querySelectorAll('article')].filter(card => card.getAttribute('data-clip') === null).length, 0, 'the video filter hides image cards')

    // Re-query both the card and the button: the filter chips re-render the
    // list, so anything captured before them is detached and its clicks are
    // lost (a detached node still reports isConnected=false only after React
    // swaps it; querying fresh is the reliable approach).
    const liveCard = view.querySelector('article[data-clip]')
    assert.ok(liveCard !== null, 'the clip card is present after filtering')
    const clipToChat = liveCard.querySelector('[data-gallery-video-conversation]')
    assert.ok(clipToChat !== null, 'the clip card offers add-to-chat')
    clipToChat.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitFor(() => conversationDrafts.length > 0), 'clicking add-to-chat drafts the clip')
    const drafted = conversationDrafts.at(-1)
    assert.match(drafted.type, /^video\//, `the draft carries a video MIME type (got ${drafted.type})`)
    assert.match(drafted.name, /\.(mp4|webm|mov|mkv)$/i, `the draft keeps a video file name (got ${drafted.name})`)
    assert.ok(drafted.size > 0, 'the draft is not empty')
    assert.ok(conversationInputs.length > 0, 'the draft reaches the composer attachment rail')
    assert.ok(liveCard.textContent?.includes('视频'), 'the clip card still identifies as a video')

    // Opening the clip shows it in a player (the image lightbox cannot play it).
    view.querySelector('article[data-clip] button[class*="galleryImageButton"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    // The player is a portal rendered into document.body, so it lives OUTSIDE
    // the plugin's view subtree.
    assert.ok(await waitFor(() => jsdomDocument.querySelector('[data-gallery-clip-viewer]') !== null), 'clicking a clip card opens the clip player')
    const clipViewer = jsdomDocument.querySelector('[data-gallery-clip-viewer]')
    assert.ok(clipViewer.querySelector('video') !== null, 'the clip player renders a video element')
    clipViewer.querySelector('button').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitFor(() => jsdomDocument.querySelector('[data-gallery-clip-viewer]') === null), 'the clip player dismisses')

    // Back to the full gallery for the assertions that follow.
    const allChip = [...view.querySelectorAll('button[class*="galleryFilter"]')].find(chip => chip.textContent?.includes('全部'))
    assert.ok(allChip !== undefined, 'the all filter exists')
    allChip.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))

    assert.ok(view.querySelector('[data-gallery-clear]') !== null, 'gallery clear button rendered')
    view.querySelector('[data-gallery-clear]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(confirmationCalls, 2, 'gallery clear asks for confirmation')

    // ------------------------------------------------------------ the trash
    // Soft delete is only worth anything if the user can GET an entry back, and
    // the trash fixture above was there while nothing asserted on it: the panel
    // could have stopped rendering the toggle, dropped the restore button, or
    // sent the wrong id and every existing check would still have been green.
    // `window.confirm` is stubbed to accept, so the purge below actually runs.
    const trashToggle = view.querySelector('[data-gallery-trash-toggle]')
    assert.ok(trashToggle !== null, 'the trash toggle appears once an entry is in the trash')
    assert.equal(trashToggle.getAttribute('aria-expanded'), 'false', 'the trash starts collapsed')
    trashToggle.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(view.querySelector('[data-gallery-trash-toggle]')?.getAttribute('aria-expanded'), 'true', 'the toggle reports the trash as open')
    const trashSection = view.querySelector('[data-gallery-trash]')
    assert.ok(trashSection !== null, 'opening the toggle renders the trash section')
    // The heading is the toggle itself; the section must not print the count a
    // second time inside its body.
    assert.equal(trashSection.querySelectorAll('strong').length, 0, 'the open trash does not repeat the count heading it already sits under')
    assert.equal(trashSection.textContent?.includes('trashed prompt'), true, 'the trash row names the deleted entry')
    assert.ok(trashSection.textContent?.includes('删除于'), 'the trash row says when it was deleted')

    const restoreButton = trashSection.querySelector('[data-gallery-restore="gallery-trashed"]')
    assert.ok(restoreButton !== null, 'the trash row offers a restore button for its own id')
    // A hardcoded id would pass the lookup above whenever it happens to name the
    // first fixture entry, so the second row is checked too: every row must
    // carry its OWN id, not one id repeated.
    assert.ok(trashSection.querySelector('[data-gallery-restore="gallery-trashed-2"]') !== null, 'a second trashed row carries its own id, not a repeated one')
    restoreButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    const restoredCall = galleryMutations.filter(entry => entry.path === 'restore').pop()
    assert.ok(restoredCall !== undefined, 'restore reached the host')
    assert.equal(JSON.parse(restoredCall.body).id, 'gallery-trashed', 'restore names the trashed entry')

    // Purge is the one action that really unlinks, so it must ask first -- and
    // the confirmation text has to carry the count the user is agreeing to.
    // The stub has to say yes for the route to be reached at all; it is reset
    // immediately after so the rest of the suite keeps the declining default.
    const purgeButton = view.querySelector('[data-gallery-purge]')
    assert.ok(purgeButton !== null, 'the trash offers emptying it')
    confirmationAnswer = true
    purgeButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    confirmationAnswer = false
    assert.equal(confirmationCalls, 3, 'emptying the trash asks for confirmation')
    assert.equal(confirmationMessages.at(-1)?.includes('1'), true, 'the purge confirmation states how many entries will go')
    assert.ok(galleryMutations.some(entry => entry.path === 'purge'), 'purge reached the host')
    // The configuration entry registers exactly one Settings navigation section.
    const sectionRegistrations = registered.filter(item => item.name === 'settings.section')
    assert.equal(sectionRegistrations.length, 1)
    const sectionRegistration = sectionRegistrations[0]
    assert.equal(sectionRegistration?.id, 'dsh-imagegen')
    assert.equal(sectionRegistration?.order, 16)
    assert.equal(typeof sectionRegistration?.label, 'function')
    assert.equal(sectionRegistration?.label(), '生图配置')
    assert.equal(typeof sectionRegistration?.inject, 'function')
    // The page below reports isLoopback: false, the authority a LAN/public
    // reverse-proxied page carries while its requests still reach the host
    // from 127.0.0.1. The settings bridge must have been probed, not skipped.
    assert.ok(
      requestPaths.some(path => path.endsWith('/settings/describe')),
      'a non-loopback page probes the settings bridge instead of pre-blocking',
    )
    assert.equal(registered.some(item => item.name === 'main' || item.name === 'sidebar.panellist'), false)

    // The asset library must not inherit the normal generation inspiration wall.
    assert.equal(jsdomDocument.querySelector('[aria-label="灵感案例"]') === null, true, 'asset library hides inspiration wall')
    normalSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    // Inspiration wall belongs to the empty normal-generation canvas only.
    const inspirationWall = jsdomDocument.querySelector('[aria-label="灵感案例"]')
    assert.ok(inspirationWall !== null, 'inspiration wall rendered on the empty canvas')
    const shuffleButton = [...inspirationWall.querySelectorAll('button')]
      .find(button => button.textContent?.includes('随机'))
    assert.ok(shuffleButton !== undefined, 'inspiration shuffle action rendered')
    const inspirationTile = [...inspirationWall.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Template poster'))
    assert.ok(inspirationTile !== undefined, 'inspiration tile rendered')
    inspirationTile.click()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.querySelector('textarea')?.value, 'A reusable template prompt', 'inspiration tile filled the prompt')
    // Opening a clip from the sidebar returns to this tab with `images` emptied
    // — the very state that renders the wall above — so the wall has to yield to
    // the clip. The panel keeps every surface in one JSX tree and `viewingVideoId`
    // is component state, so the guard is asserted where it lives; the runtime
    // half (wall on the empty canvas, clip on the board) is covered above and in
    // the unified-history block below.
    const panelSource = readFileSync(new URL('../src/client/ImageGenPanel.tsx', import.meta.url), 'utf8')
    assert.match(
      panelSource,
      /isGeneration && !generating && !error && images\.length === 0 && viewingVideoEntry === null \? \(\s*<InspirationGallery/,
      'the inspiration wall yields to a clip that is on the board',
    )

    // ---------------------------------------------------------- video studio
    // The video tab is a separate surface: selecting it must render the video
    // composer (not the image one), offer the configured video model, and
    // submit through the video route with the chosen mode/params.
    const videoTab = [...view.querySelectorAll('[role="tablist"] button')]
      .find(button => button.textContent?.includes('生视频'))
    assert.ok(videoTab !== undefined, 'video mode entry is present')
    videoTab.click()
    await waitForSelector(view, '[id="dsh-video-prompt"]')
    assert.ok(view.querySelector('[id="dsh-video-prompt"]') !== null, 'video prompt renders')
    assert.equal(view.querySelector('button[class*="generateButton"]') === null, true, 'the image generate button is replaced in video mode')
    assert.ok(view.querySelector('button[class*="videoGenerate"]') !== null, 'video generate button renders')

    // The configured video model is offered; image-only models are not.
    const videoModelSelect = view.querySelector('[class*="videoSelect"]')
    assert.ok(videoModelSelect !== null, 'video model picker renders')
    assert.ok(videoModelSelect.textContent?.includes('agnes-video-2.5-flash'), 'the configured video model is offered')
    assert.equal(videoModelSelect.textContent?.includes('gpt-image-2'), false, 'image models are not offered as video models')

    // Mode buttons come from the family's own capabilities: Agnes supports
    // text / image / keyframe / reference, so all four appear.
    const modeButtons = [...view.querySelectorAll('[class*="videoModeButton"]')].map(button => button.textContent)
    assert.deepEqual(modeButtons, ['文生视频', '图生视频', '首尾帧', '参考图'], 'video modes follow the model family capabilities')

    // Generating with an empty prompt stays disabled.
    const videoGenerate = view.querySelector('button[class*="videoGenerate"]')
    assert.equal(videoGenerate.disabled, true, 'video generate is disabled without a prompt')

    // Type a prompt and submit: the request must carry the mode and params.
    const videoPrompt = view.querySelector('[id="dsh-video-prompt"]')
    // React 18 + jsdom: the plain `.value =` assignment does not notify the
    // controlled component, so write through the native setter and dispatch.
    const videoTextAreaSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set
    videoTextAreaSetter.call(videoPrompt, 'a cat on a windowsill')
    videoPrompt.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(videoGenerate.disabled, false, 'video generate enables once a prompt exists')
    // Baseline for the check below: the tab must make the PARENT re-read the
    // queue rather than fetching a list of its own.
    const taskListCallsBeforeSubmit = videoTaskListCalls
    videoGenerate.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(videoSubmissions.length, 1, 'submitting reached the video route exactly once')
    assert.equal(videoSubmissions[0].prompt, 'a cat on a windowsill')
    assert.equal(videoSubmissions[0].model, 'agnes-video-2.5-flash')
    assert.equal(videoSubmissions[0].mode, 'text', 'text-to-video is the default mode')
    assert.equal(videoSubmissions[0].seconds, 5, 'the default duration is sent')
    assert.equal(videoSubmissions[0].resolution, '720P', 'the default resolution is sent')

    // --- the studio tab refreshes the queue the parent owns (F11) ---
    // The parent supplies `tasks` and its own single poller, so the tab has to
    // push its mutation UP: reading a list of its own would fork the two views
    // (and the canvas reads the parent's copy). Without the upward refresh a
    // render the user just submitted stays invisible for a full poll cycle.
    const submittedAt = Date.now()
    assert.ok(
      await waitFor(() => videoTaskListCalls > taskListCallsBeforeSubmit, 1500),
      `submitting asks the parent to re-read the queue (reads: ${taskListCallsBeforeSubmit} -> ${videoTaskListCalls})`,
    )
    assert.ok(Date.now() - submittedAt < 1500, 'the refresh does not wait for the next poll tick')
    await waitFor(() => view.querySelector('li[data-status="queued"]') !== null, 1500)
    const queuedRow = view.querySelector('li[data-status="queued"]')
    // A row existing at all is the proof the tab renders the PARENT's list:
    // in controlled mode the tab's own `localTasks` is never rendered.
    assert.ok(queuedRow !== null, 'the submitted render appears on the parent-owned list without waiting for a tick')

    // Cancelling travels the same way, so the row settles immediately too.
    const cancelCallsBefore = videoCancellations.length
    const cancelButton = [...queuedRow.querySelectorAll('button')].find(button => button.textContent === '取消')
    assert.ok(cancelButton !== undefined, 'a queued task offers cancel')
    cancelButton.click()
    assert.ok(await waitFor(() => videoCancellations.length > cancelCallsBefore, 1500), 'cancel reaches the host')
    assert.equal(videoCancellations[0], 'vt-1', 'cancel names the submitted task')
    assert.ok(
      await waitFor(() => view.querySelector('li[data-status="cancelled"]') !== null, 1500),
      'the row shows the cancelled state on the parent-owned list',
    )

    // --- #38 video parity: the video studio reaches the SAME record ---
    // Upstream's diagnostics landed on the image path, whose entry point lives
    // in the task tray -- and that tray only renders once an IMAGE task exists.
    // So a user whose images work and whose videos fail had no way in at all,
    // even though the buffer holds the failed video submit. The entry must be
    // reachable with zero tasks, and it must be the same panel.
    const videoTasksAtOpen = videoSubmissions.length
    const diagnosticsButtons = [...view.querySelectorAll('[data-diagnostics-button]')]
    assert.equal(diagnosticsButtons.length, 1, 'the video studio renders exactly one diagnostics entry (not two)')
    const listCallsBeforeOpen = diagnosticsListCalls
    diagnosticsButtons[0].click()
    assert.equal(
      await waitFor(() => view.querySelector('[data-diagnostics-panel]') !== null),
      true,
      'the entry opens the diagnostics record without any task row present',
    )
    assert.ok(diagnosticsListCalls > listCallsBeforeOpen, 'opening the panel reads the host record')
    const diagnosticsPanel = view.querySelector('[data-diagnostics-panel]')
    // The phase the entry shows is the proof it is the shared buffer: a
    // video-only surface could not name `video-submit`, and the image tray
    // is not even rendered here.
    assert.ok(
      diagnosticsPanel.querySelector('[data-phase="video-submit"]') !== null,
      'the panel shows the video leg from the shared buffer',
    )
    assert.equal(
      view.querySelectorAll('[data-diagnostics-panel]').length,
      1,
      'the record is one overlay, not nested',
    )
    // Closing puts the studio back exactly as it was.
    const closeButton = [...diagnosticsPanel.querySelectorAll('button')]
      .find(button => button.textContent === '×')
    assert.ok(closeButton !== undefined, 'the record has a close button')
    closeButton.click()
    assert.equal(
      await waitFor(() => view.querySelector('[data-diagnostics-panel]') === null),
      true,
      'the record closes and leaves the studio behind it',
    )
    assert.equal(videoSubmissions.length, videoTasksAtOpen, 'opening the record never submits a render')

    // The theme toggle must clear a frame error surfaced by the tab, so go back
    // to the image mode and confirm the composer returns unchanged.
    const textTab = [...view.querySelectorAll('[role="tablist"] button')]
      .find(button => button.textContent?.includes('文生图'))
    assert.ok(textTab !== undefined, 'text-to-image entry is present')
    textTab.click()
    await waitForSelector(view, 'textarea[placeholder*="描述你想要的画面"]')
    assert.ok(view.querySelector('textarea[placeholder*="描述你想要的画面"]') !== null, 'the image composer returns after video mode')
    assert.equal(view.querySelector('[id="dsh-video-prompt"]') === null, true, 'the video composer is unmounted outside video mode')

    // Template-library regression: choose a card, use its prompt, and verify
    // the text editor receives it while the modal closes.
    const templateTrigger = [...jsdomDocument.querySelectorAll('button')]
      .find(button => button.textContent?.includes('模板库'))
    assert.ok(templateTrigger !== undefined, 'template library trigger rendered')
    templateTrigger.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const libraryModal = jsdomDocument.querySelector('[role="dialog"][aria-label="提示词模板库"]')
    assert.ok(libraryModal !== null, 'template modal rendered')
    const templateCard = [...libraryModal.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Template poster'))
    assert.ok(templateCard !== undefined, 'template card rendered')
    templateCard.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    // The detail view is a portal on document.body, not a child of the drawer.
    const detailButtons = [...jsdomDocument.querySelectorAll('[data-template-detail] button')]
    const useTemplate = detailButtons
      .find(button => button.textContent?.includes('使用此提示词'))
    assert.ok(useTemplate !== undefined, 'use-template action rendered')
    useTemplate.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(jsdomDocument.querySelector('textarea')?.value, 'A reusable template prompt')
    assert.equal(jsdomDocument.querySelector('[role="dialog"][aria-label="提示词模板库"]') === null, true, 'template modal closed after use')

    // --- save-flow regression: a secret field's save must report success ---
    // The redacted wire view never returns the key, so the form judges the
    // write by the secrets sidecar; a save that landed must not show failure
    // (this exact bug surfaced as "保存失败" while values were actually stored).
    const face = sectionRegistration.inject()
    const initialSettings = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(initialSettings.channels.defaultModel, 'gpt-image-2-alt', 'settings select shows the configured default model')
    assert.equal(initialSettings.channels.channels[0].apiUrlFull, false, 'existing channels default to base-URL mode')
    // #56: the Seedream watermark opt-out has to survive the settings round trip.
    assert.notEqual(initialSettings.channels.channels[0].watermark, false, 'existing channels keep the Seedream watermark on')
    face.channels.setChannels(initialSettings.channels.channels.map(channel => ({ ...channel, watermark: false })))
    await face.channels.commit()
    assert.ok(
      mutateCalls.some(m => m.ops.some(o => o.path[0] === 'channels' && o.op === 'set' && o.value[0]?.watermark === false)),
      'watermark opt-out reaches the channel settings document (#56)',
    )
    face.channels.setChannels(initialSettings.channels.channels.map(channel => ({ ...channel, apiUrlFull: true })))
    await face.channels.commit()
    assert.ok(
      mutateCalls.some(m => m.ops.some(o => o.path[0] === 'channels' && o.op === 'set' && o.value[0]?.apiUrlFull === true)),
      'exact URL mode reaches the channel settings document (#26)',
    )
    face.channels.setChannels(initialSettings.channels.channels.map(channel => ({ ...channel, apiUrlFull: false })))
    await face.channels.commit()
    face.channels.setDefaultModel('gpt-image-2')
    await face.channels.commit()
    assert.ok(
      mutateCalls.some(m => m.ops.some(o => o.path[0] === 'defaultModel' && o.op === 'set' && o.value === 'gpt-image-2')),
      'default model write reaches the host bridge',
    )
    face.channels.setChannelKey('default', 'sk-new')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 100))
    const afterSave = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterSave.failed, false, 'save must not report failure for a secret write')
    assert.equal(afterSave.dirty, false, `staged drafts cleared after a landed save: ${JSON.stringify(afterSave)}`)
    assert.equal(keyState.set, true, 'key write reached the bridge')
    assert.ok(
      mutateCalls.some(m => m.ops.some(o => o.path[0] === 'channelSecrets' && o.path[1] === 'default' && o.op === 'set' && o.value === 'sk-new')),
      'channel key write sent with the typed value',
    )

    // A rejected host mutation must retain a staged channel key instead of
    // clearing the only copy from the settings form.
    face.channels.setChannelKey('default', 'sk-retry')
    rejectNextSettingsMutation = true
    await face.channels.commit()
    const afterRejectedSave = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterRejectedSave.channels.failed, true, 'a rejected batch is surfaced as a channel-save failure')
    assert.equal(afterRejectedSave.dirty, true, 'a rejected save keeps the form dirty for retry')
    assert.ok(mutateCalls.at(-1).ops.some(op => op.path[0] === 'channelSecrets' && op.value === 'sk-retry'), 'the rejected request carried the staged token')
    await face.channels.commit()
    const afterRetry = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterRetry.channels.failed, false, 'a successful retry clears the failure state')
    assert.equal(afterRetry.dirty, false, 'a successful retry clears staged edits')
    assert.ok(mutateCalls.at(-1).ops.some(op => op.path[0] === 'channelSecrets' && op.value === 'sk-retry'), 'retry resends the preserved token')

    // #13: deleting a channel must take its plaintext key with it. Before the
    // fix the save rewrote `channels` and nothing else, so `channelSecrets`
    // kept an entry for an id the UI could no longer show — the only way left
    // to clear it was hand-editing cordis.patch.yml.
    //
    // The nastier half: a key typed just before the delete was still staged as
    // `{kind:'set'}`, so committing wrote it straight back to the dead id.
    face.channels.setChannels([...face.hooks.imageGenSettingsCard.getSnapshot().channels.channels, {
      id: 'doomed', preset: '', name: 'Doomed', apiUrl: 'https://doomed.test/v1', apiUrlFull: false,
      models: [{ alias: 'doomed-model', id: 'doomed-model' }], videoModels: [{ alias: 'doomed-video', id: 'doomed-video' }],
    }])
    await face.channels.commit()
    face.channels.setDefaultChannel('doomed')
    face.channels.setDefaultModel('doomed-model')
    face.channels.setDefaultVideoModel('doomed-video')
    face.channels.setChannelKey('doomed', 'sk-doomed')
    await face.channels.commit()
    assert.ok(
      mutateCalls.at(-1).ops.some(op => op.path[0] === 'channelSecrets' && op.path[1] === 'doomed' && op.op === 'set' && op.value === 'sk-doomed'),
      'the doomed channel really holds a key before it is deleted',
    )

    // Stage a fresh key and then delete the channel in the SAME save: the
    // staged `set` must be dropped, never replayed onto the removed id.
    face.channels.setChannelKey('doomed', 'sk-typed-then-deleted')
    face.channels.setChannels(face.hooks.imageGenSettingsCard.getSnapshot().channels.channels.filter(channel => channel.id !== 'doomed'))
    await face.channels.commit()
    const deleteOps = mutateCalls.at(-1).ops
    assert.ok(
      deleteOps.some(op => op.path[0] === 'channelSecrets' && op.path[1] === 'doomed' && op.op === 'unset'),
      `deleting a channel unsets its secret: ${JSON.stringify(deleteOps)}`,
    )
    assert.equal(
      deleteOps.some(op => op.path[0] === 'channelSecrets' && op.path[1] === 'doomed' && op.op === 'set'),
      false,
      `a key staged before the delete must not be written back to the removed id: ${JSON.stringify(deleteOps)}`,
    )
    assert.equal(keyState.ids.doomed, undefined, 'the removed channel no longer holds a secret')

    // The defaults that pointed at the removed channel must be reset on disk,
    // not merely papered over by resolve()'s read-time fallback — otherwise the
    // stale alias silently wins again the moment a channel re-adds that name.
    assert.ok(
      deleteOps.some(op => op.path[0] === 'defaultChannelId' && op.op === 'set' && op.value === 'default'),
      `defaultChannelId falls back to a surviving channel: ${JSON.stringify(deleteOps)}`,
    )
    assert.ok(
      deleteOps.some(op => op.path[0] === 'defaultModel' && op.op === 'unset'),
      `a dangling defaultModel is unset: ${JSON.stringify(deleteOps)}`,
    )
    assert.ok(
      deleteOps.some(op => op.path[0] === 'defaultVideoModel' && op.op === 'unset'),
      `a dangling defaultVideoModel is unset: ${JSON.stringify(deleteOps)}`,
    )

    // Ecommerce submission flow: with the channel key set, confirming the plan
    // fans out one queued task per planned image carrying the set metadata.
    const ecommerceTabAgain = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('电商模式'))
    assert.ok(ecommerceTabAgain !== undefined, 'ecommerce switch still present for submission flow')
    ecommerceTabAgain.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    // Platform compliance switch: off by default, and turning it on has to say
    // out loud that the main image is no longer generated at the ratio above it.
    const whiteToggle = view.querySelector('[data-ecommerce-white]')
    assert.ok(whiteToggle !== null, 'the white-background compliance switch is rendered')
    assert.equal(whiteToggle.checked, false, 'the compliance switch is off by default')
    whiteToggle.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(whiteToggle.checked, true, 'the compliance switch can be turned on')
    assert.ok(view.textContent?.includes('主图将强制 1:1'), 'the panel states the main image is locked to a square')
    const confirmSet = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('确认生成整套图片'))
    assert.ok(confirmSet !== undefined, 'ecommerce confirm action is rendered')
    confirmSet.click()
    await new Promise(resolve => setTimeout(resolve, 3500))
    assert.equal(ecommerceSubmissions.length, 6, 'anchor chain submits the main image first, then the remaining slots')
    assert.ok(ecommerceSubmissions.every(payload => payload.workflow === 'ecommerce' && typeof payload.projectId === 'string' && payload.projectId !== ''), 'submissions carry the ecommerce workflow and project id')
    assert.ok(ecommerceSubmissions.every(payload => typeof payload.slotLabel === 'string' && payload.slotLabel !== '' && typeof payload.slotKey === 'string' && payload.slotKey !== ''), 'submissions carry slot metadata')
    const mainPayload = ecommerceSubmissions.find(payload => payload.slotKey === 'main-1')
    assert.ok(mainPayload !== undefined && mainPayload.mode === 'edit' && mainPayload.refName === 'cup.png', 'main image uses the uploaded product asset')
    const anchored = ecommerceSubmissions.filter(payload => payload.slotKey !== 'main-1')
    assert.equal(anchored.length, 5, 'remaining slots are anchored after the main image')
    assert.ok(anchored.every(payload => payload.mode === 'edit' && payload.refName === 'set-main-anchor' && typeof payload.image === 'string' && payload.image.startsWith('data:')), 'anchored slots reference the generated main image')
    assert.ok(anchored.every(payload => payload.prompt.startsWith('商品套图一致性约束')), 'anchored prompts carry the consistency constraint')
    // The compliance clause is a main-image requirement, not a style: it must
    // reach exactly one submission, or a scene shot turns into a white packshot.
    assert.ok(mainPayload.prompt.includes('纯白 #FFFFFF'), 'the compliance clause reaches the main image prompt')
    assert.equal(anchored.some(payload => payload.prompt.includes('纯白 #FFFFFF')), false, 'the compliance clause never leaks into the other slots')
    assert.equal(mainPayload.size, '1:1', 'the compliant main image is requested square')
    assert.ok(ecommerceSubmissions.every(payload => payload.projectName === '测试保温杯'), 'submissions carry the product name snapshot')
    const ecommerceResults = view.querySelector('[data-ecommerce-results]')
    assert.ok(ecommerceResults !== null, 'product set results section is rendered')
    assert.ok(ecommerceResults.textContent?.includes('1/6'), 'results header reports task progress')
    const mainGroup = ecommerceResults.querySelector('[data-ecommerce-group="主图"]')
    assert.ok(mainGroup !== null, 'results are grouped by slot label')
    assert.ok(mainGroup.querySelector('img') !== null, 'completed slot renders its image')
    let draftSnapshot = null
    try { draftSnapshot = jsdomWindow.localStorage.getItem('dsh-imagegen-ecommerce-draft') } catch { /* opaque origin: draft persistence is optional */ }
    if (draftSnapshot !== null) {
      assert.ok(draftSnapshot.includes('测试保温杯'), 'ecommerce draft persists to local storage')
    }

    // Restore one persisted product set from history: the sidebar collapses
    // its rows into one project entry, and clicking it rebuilds the grouped
    // results canvas from the stored entries.
    const ecommerceHistoryRow = [...jsdomDocument.querySelectorAll('[data-dsh-imagegen-history-main]')]
      .find(button => button.textContent?.includes('历史保温杯'))
    assert.ok(ecommerceHistoryRow !== undefined, 'ecommerce history rows collapse into one project entry')
    ecommerceHistoryRow.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const restoredResults = view.querySelector('[data-ecommerce-results]')
    assert.ok(restoredResults !== null, 'restored project keeps the ecommerce canvas')
    assert.ok(restoredResults.textContent?.includes('2/2'), 'restored results report history progress')
    assert.ok(restoredResults.querySelector('[data-ecommerce-group="卖点图"] img') !== null, 'restored groups render stored images')

    // The clear path: resetting the key stages an explicit clear and must
    // also report success.
    face.channels.setChannelKey('default', '')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 100))
    const afterClear = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterClear.failed, false, 'clearing a secret must not report failure')
    assert.equal(keyState.set, false, 'key clear reached the bridge')
    assert.equal(face.hooks.imageGenSettingsCard.getSnapshot().channels.keySet.default, false, 'key-set flag follows the clear')
    canvasSwitch.click()
    await waitForSelector(view, '[data-canvas-workspace]')
    assert.ok(view.querySelector('[data-canvas-workspace]') !== null, 'infinite canvas workspace is mounted')

    // --- canvas image tools: 标注 / 移除背景 / 图层拆分 / 模型选择 ---
    // The fixture below seeds an image -> config pair, so the whole pipeline can
    // run headless: draw a box, get a prompt card, generate a boxed edit, cut
    // out the background, and decompose the picture into layer nodes.
    canvasDocument.nodes = [
      { id: 'node-image', type: 'image', title: '图片节点', x: 0, y: 0, width: 240, height: 240, metadata: { asset: canvasImageAsset, status: 'success' } },
      { id: 'node-config', type: 'config', title: '生成配置', x: 640, y: 0, width: 320, height: 190, metadata: { status: 'idle' } },
    ]
    canvasDocument.connections = [{ id: 'edge-fixture', fromNodeId: 'node-image', toNodeId: 'node-config' }]
    // Leave and re-enter the workspace so it reads the seeded document.
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-image"]')
    assert.ok(view.querySelector('[data-node-id="node-image"]') !== null, 'image node rendered from the fixture')

    const waitUntil = async (predicate, timeout = 2500) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      return predicate()
    }

    // ------------------------------- autosave across a project switch (F8/F9)
    // Two promises the workspace makes, both driven here through the real UI —
    // the project selector and the title field — with the save answer parked so
    // the window is deterministic instead of a race against the 650 ms debounce.
    /** Open the project menu and pick the first entry whose title starts with
     *  `label` — the canvas keeps whatever title the check last typed into it. */
    const switchProject = async label => {
      const trigger = view.querySelector('[data-canvas-workspace] [data-dsh-select][aria-label="画布项目"]')
      assert.ok(trigger !== null, 'the project selector is mounted')
      trigger.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
      const wanted = label.toLowerCase()
      const deadline = Date.now() + 1500
      let option
      while (option === undefined && Date.now() < deadline) {
        option = [...jsdomDocument.querySelectorAll('[data-option-index]')]
          .find(button => (button.textContent ?? '').trim().toLowerCase().startsWith(wanted))
        if (option === undefined) await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(option !== undefined, `the project menu offers ${label}: ${JSON.stringify([...jsdomDocument.querySelectorAll('[data-option-index]')].map(button => button.textContent))}`)
      option.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    }
    /** Type a new canvas title through the real rename field, then commit it. */
    const renameCanvas = async title => {
      view.querySelector('[data-canvas-workspace] button[title="双击重命名"]').dispatchEvent(new jsdomWindow.MouseEvent('dblclick', { bubbles: true }))
      await waitForSelector(view, '[data-canvas-workspace] input[aria-label="重命名画布"]')
      const field = view.querySelector('[data-canvas-workspace] input[aria-label="重命名画布"]')
      nativeInputSetter.call(field, title)
      field.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
      field.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    // F9: an edit made just before the switch is written BEFORE the canvas is
    // replaced. The autosave effect's cleanup cancels the pending debounce, so
    // without the flush this edit never leaves the browser at all.
    await switchProject('second')
    assert.ok(await waitUntil(() => view.querySelector('[data-node-id="node-second"]') !== null), 'the second canvas is on screen')
    await renameCanvas('second edited')
    await switchProject('smoke')
    assert.ok(
      await waitUntil(() => canvasSaves.some(saved => saved.id === 'canvas-two' && saved.title === 'second edited')),
      'the pending edit was flushed before the canvas was replaced',
    )
    assert.ok(await waitUntil(() => view.querySelector('[data-node-id="node-image"]') !== null), 'the fixture canvas is back on screen')

    // F8: an answer that arrives after the user left belongs to a canvas that is
    // no longer on screen. Letting it through put the previous canvas back —
    // with its stale revision — while the selector still showed the new one.
    heldSaveBudget = 1
    await renameCanvas('smoke edited')
    assert.ok(await waitUntil(() => heldSaves.length === 1, 3000), 'the first canvas save is in flight')
    await switchProject('second')
    assert.ok(await waitUntil(() => view.querySelector('[data-node-id="node-second"]') !== null), 'the switch landed while that answer was still parked')
    heldSaves.splice(0).forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.ok(view.querySelector('[data-node-id="node-second"]') !== null, 'a late answer for the canvas the user left is discarded')
    assert.equal(view.querySelector('[data-node-id="node-image"]'), null, 'the left canvas does not come back on screen')
    await switchProject('smoke')
    assert.ok(await waitUntil(() => view.querySelector('[data-node-id="node-image"]') !== null), 'the fixture canvas is restored for the checks that follow')

    // ------------------------------------- canvas shortcuts yield when hidden
    // The panel is hidden by a STYLESHEET RULE, not by unmounting: the React
    // tree (and the canvas inside it) stays alive so node state survives a trip
    // to the conversation. That also kept the canvas's window-level key handler
    // live, so it went on claiming Ctrl+A / Ctrl+Z / Delete for the whole
    // document while the user typed in the chat beside it. This pins the "only
    // while on screen" rule with the panel properly closed.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]').click()
    await new Promise(resolve => setTimeout(resolve, 80))
    const nodeElement = () => view.querySelector('[data-node-id="node-image"]')
    assert.ok(nodeElement() !== null, 'the fixture node is on screen before the panel is closed')
    // Select it through a real pointerdown, so the Delete below has something
    // to act on and a surviving deletion is unmistakable.
    nodeElement().dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.match(nodeElement().className, /nodeSelected/, 'pointerdown selects a node while the canvas is on screen')

    // Close the panel through the sidebar switcher, exactly as the user does.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="session"]').click()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), false, 'the panel reports itself closed')
    assert.ok(nodeElement() !== null, 'the canvas stays mounted while the panel is closed -- that is WHY the listeners outlive visibility')

    const savesBeforeHiddenDelete = canvasSaves.length
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    // Comfortably past the autosave debounce, so a write that was going to
    // happen has happened by the assertion below.
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(canvasSaves.length, savesBeforeHiddenDelete, 'Delete with the panel closed never reaches the canvas document')
    assert.ok(nodeElement() !== null, 'the selected node survives a keypress aimed at the conversation')
    assert.match(nodeElement().className, /nodeSelected/, 'the closed canvas keeps its selection untouched')

    // Back to the studio for the checks that follow.
    jsdomDocument.querySelector('[data-dsh-imagegen-tab="image"]').click()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(jsdomDocument.documentElement.hasAttribute('data-dsh-imagegen-active'), true, 'the studio is active again')

    // ------------------------------------- a failed save must stop retrying (F13)
    // `syncedRef` only advances on a SUCCESSFUL write, so while an edit stays
    // unsynced the autosave effect re-ran on every `saveState` change and
    // re-armed its 650 ms timer: an unreachable host meant one failing request
    // every 650 ms, forever, with the toast re-set on each round -- which is
    // also why dismissing it looked broken, since the next tick put it back.
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-image"]')
    failSaveBudget = 1_000
    const attemptsBeforeFailure = failedSaveAttempts
    await renameCanvas('save will fail')
    assert.ok(
      await waitUntil(() => failedSaveAttempts > attemptsBeforeFailure, 2500),
      'the failing save reached the host',
    )
    // Well past several debounce windows: the old loop fired ~4 times here, and
    // the backoff is 15s, so anything above 1 means the storm is back.
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.equal(
      failedSaveAttempts - attemptsBeforeFailure, 1,
      `a rejected save is not retried on the debounce (attempts: ${failedSaveAttempts - attemptsBeforeFailure})`,
    )
    // The toast offers recovery instead of being a dead end.
    const failedToast = view.querySelector('[class*="errorToast"]')
    assert.ok(failedToast !== null, 'the failure is surfaced on screen')
    const retrySaving = [...failedToast.querySelectorAll('button')].find(button => button.textContent === '重试保存')
    assert.ok(retrySaving !== undefined, 'the toast offers an explicit retry')
    // Dismissing the toast must NOT mean "this edit is never saved": the × only
    // clears the message, so a plain stop would strand the document unsaved with
    // no visible way back. The quiet retry is armed regardless.
    const dismiss = [...failedToast.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '关闭提示')
    assert.ok(dismiss !== undefined, 'the toast can be dismissed')
    dismiss.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(view.querySelector('[class*="errorToast"]'), null, 'the toast is gone after dismissing')
    // And the failure is not permanent: the retry actually writes.
    failSaveBudget = 0
    const attemptsBeforeRetry = failedSaveAttempts
    retrySaving.click()
    assert.ok(
      await waitUntil(() => canvasSaves.some(saved => saved.title === 'save will fail'), 2500),
      'the explicit retry saves the document that failed',
    )
    assert.equal(failedSaveAttempts, attemptsBeforeRetry, 'the retry succeeds rather than failing again')
    // The notice clears once the write lands.
    assert.ok(await waitUntil(() => view.querySelector('[class*="errorToast"]') === null, 2500), 'the toast clears after the retry succeeds')

    // ------------------------------------------- unified history (clips + images)
    // Clips and images share ONE sidebar list. Both stores are newest-first, so
    // the merge must interleave them by time while leaving each store's own
    // relative order untouched (a blanket re-sort can change which row a click
    // opens, because comparison groups and product sets do not follow createdAt).
    const histHost = jsdomDocument.querySelector('[data-dsh-imagegen-history-host]')
    assert.ok(histHost !== null, 'the history sidebar is mounted')
    const rowKinds = () => [...histHost.querySelectorAll('[data-kind]')].map(el => el.getAttribute('data-kind'))
    const rowPrompts = () => [...histHost.querySelectorAll('[data-dsh-imagegen-history-main]')].map(el => el.querySelector('[class*="historyPrompt"]')?.textContent ?? '')
    assert.ok(rowKinds().includes('video'), 'clip rows appear in the same list as images')
    assert.ok(rowKinds().includes('image'), 'image rows are still present')
    // Chronological interleave: the newest clip (6) leads, then the ecommerce
    // image group, then the mid clip (3), then the comparison group.
    assert.deepEqual(
      rowPrompts(),
      // The product-set group is keyed by projectId, so its row shows the FIRST
      // entry the host returned for that project (selling point @5, which
      // precedes main image @4 in the newest-first fixture).
      ['plain image prompt', 'a clip newest', 'product selling point', 'a clip middle', 'compare prompt'],
      `rows are merged in chronological order: ${JSON.stringify(rowPrompts())}`,
    )
    // The clip row carries clip-specific actions, not image ones.
    const clipRow = histHost.querySelector('[data-video-row]')
    assert.ok(clipRow !== null, 'the clip row is marked as a video row')
    assert.ok(clipRow.querySelector('[data-history-video-gallery]') !== null, 'the clip row offers add-to-gallery')
    assert.ok(clipRow.querySelector('[data-history-video-canvas]') !== null, 'the clip row offers add-to-canvas')
    assert.ok(clipRow.querySelector('[data-history-video-download]') !== null, 'the clip row offers download')
    assert.equal(clipRow.querySelector('[data-history-add-canvas]') === null, true, 'the clip row has no image-only add-to-canvas action')
    assert.equal(clipRow.querySelector('[data-history-add-conversation]') === null, true, 'the clip row has no image-only add-to-conversation action')
    // An image row keeps its own actions and gains no clip action.
    const imageRow = [...histHost.querySelectorAll('[data-kind="image"]')][0]
    assert.ok(imageRow.querySelector('[data-history-add-canvas]') !== null, 'image rows keep add-to-canvas')
    assert.equal(imageRow.querySelector('[data-history-video-gallery]') === null, true, 'image rows have no clip gallery action')

    // Deleting a clip removes only that row, from the clip store.
    const clipDelete = clipRow.querySelector('.historyIconAction[data-danger], [data-danger]')
    assert.ok(clipDelete !== null, 'the clip row offers a delete action')
    clipDelete.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(
      await waitUntil(() => videoHistoryRemovals.includes('clip-new')),
      'deleting a clip row calls the clip history remove endpoint',
    )
    assert.ok(await waitUntil(() => !rowPrompts().includes('a clip newest')), 'the deleted clip row disappears')
    assert.ok(rowPrompts().includes('compare prompt'), 'the image rows are untouched by a clip deletion')

    // Clicking a clip row opens the video surface (an image board cannot play it).
    const midClip = [...histHost.querySelectorAll('[data-video-row]')][0]
    assert.ok(midClip !== undefined, 'the remaining clip row is present')
    // The sidebar's clip row offers the same chat attachment, driven through the
    // same draft bridge (the history row is a separate surface from the gallery).
    const beforeSidebarDrafts = conversationDrafts.length
    const sidebarClipChat = midClip.querySelector('[data-history-video-conversation]')
    assert.ok(sidebarClipChat !== null, 'the sidebar clip row offers add-to-chat')
    sidebarClipChat.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitFor(() => conversationDrafts.length > beforeSidebarDrafts), 'the sidebar clip row drafts the clip too')
    assert.match(conversationDrafts.at(-1).type, /^video\//, 'the sidebar draft is also a video file')

    midClip.querySelector('[data-dsh-imagegen-history-main]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 60))
    // A clip opens on the RESULT BOARD (where image results appear), which is
    // where the user is already looking -- not by jumping to the video studio.
    assert.ok(await waitUntil(() => view.querySelector('[data-video-board]') !== null), 'clicking a clip row shows it on the result board')
    const board = view.querySelector('[data-video-board]')
    assert.ok(board.querySelector('video') !== null, 'the result board plays the clip')
    assert.match(board.querySelector('video').getAttribute('src'), /video\/file\//, 'the board uses the served clip URL')
    assert.ok(board.querySelector('[data-video-board-canvas]') !== null, 'the board offers add-to-canvas')
    assert.ok(board.querySelector('[data-video-board-conversation]') !== null, 'the board offers add-to-chat')

    // Adding a clip to the canvas must land a REFERENCED video node: the node
    // records the served URL and NO copied asset, because a clip is far too big
    // to duplicate into the canvas asset store (the image import path does copy,
    // and a clip must not take that path).
    const savesBeforeClip = canvasSaves.length
    const boardCanvas = view.querySelector('[data-video-board-canvas]')
    boardCanvas.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitFor(() => canvasSaves.length > savesBeforeClip), 'add-to-canvas persists the canvas')
    const clipNode = (canvasSaves.at(-1).nodes ?? []).find(node => node.type === 'video')
    assert.ok(clipNode !== undefined, 'the canvas gained a video node')
    assert.match(clipNode.metadata?.video?.url ?? '', /video\/file\//, 'the node references the served clip URL')
    if (clipNode.metadata?.asset !== undefined) {
      throw new Error(`CLIPNODE asset=${JSON.stringify(clipNode.metadata.asset)} | video=${JSON.stringify(clipNode.metadata.video)}`)
    }

    // Leave the panel where the rest of this case expects it: the canvas
    // workspace. The clip click above moves the studio to the video surface, and
    // the canvas assertions that follow need the dock mounted.
    canvasSwitch.click()
    await waitForSelector(view, '[data-canvas-workspace]')
    assert.ok(view.querySelector('[data-canvas-workspace]') !== null, 'the canvas returns after the clip jump')

    // Regression for the runaway Dock magnification (#27): a browser can give
    // requestAnimationFrame a timestamp older than performance.now(), which
    // used to produce a negative frame delta. Drive that exact case through the
    // mounted toolbar and require every tile to stay within its 34-50px range.
    const dockToolbar = view.querySelector('[data-canvas-workspace] [role="toolbar"]')
    assert.ok(dockToolbar !== null, 'canvas dock toolbar is mounted')
    // Let the dock's initial spring settle before replacing RAF so the stale
    // timestamp we inject cannot be ignored by an already-running loop.
    await new Promise(resolve => setTimeout(resolve, 100))
    const originalRequestAnimationFrame = jsdomWindow.requestAnimationFrame
    const queuedDockFrames = []
    jsdomWindow.requestAnimationFrame = callback => {
      queuedDockFrames.push(callback)
      return queuedDockFrames.length
    }
    const drainDockFrames = (count) => {
      for (let frame = 0; frame < count && queuedDockFrames.length > 0; frame += 1) queuedDockFrames.shift()(0)
    }
    dockToolbar.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: 0 }))
    drainDockFrames(12)
    const dockSizes = [...dockToolbar.querySelectorAll('[data-dock-item]')].map(item => Number.parseFloat(item.style.width))
    assert.ok(dockSizes.length > 0, 'dock tiles are present')
    assert.ok(
      dockSizes.every(size => Number.isFinite(size) && size >= 34 && size <= 50),
      `dock tiles stay bounded after a stale frame timestamp: ${dockSizes.join(',')}`,
    )
    dockToolbar.dispatchEvent(new jsdomWindow.MouseEvent('pointerleave', { bubbles: true }))
    drainDockFrames(12)
    jsdomWindow.requestAnimationFrame = originalRequestAnimationFrame

    // The workflow runner lives in the dock: one press runs the selected
    // nodes' downstream chain. It must be rendered, reachable by its label,
    // and — with nothing selected and no unfinished node — report the
    // "nothing to run" reason instead of failing silently.
    const workflowDockButton = view.querySelector('[data-dock-item][data-label="运行工作流（从选中节点往下）"] button')
    assert.ok(workflowDockButton !== null, 'canvas workflow dock action is rendered')
    const workflowErrorsBefore = view.querySelectorAll('[data-canvas-error]').length
    workflowDockButton.click()
    await waitUntil(() => view.querySelectorAll('[data-canvas-error]').length > workflowErrorsBefore
      || view.textContent.includes('这条链路上的节点都已经有结果了'))
    const workflowMessage = view.textContent
    assert.ok(
      workflowMessage.includes('这条链路上的节点都已经有结果了')
      || workflowMessage.includes('画布上还没有节点'),
      'workflow action explains why nothing was run when the chain is already complete',
    )

    // The background menu exposes an explicit performance-off action, and the
    // blank mode unmounts every animated background implementation (#27).
    const backgroundDockButton = view.querySelector('[data-dock-item][data-label="画布背景"] button')
    assert.ok(backgroundDockButton !== null, 'canvas background dock action is rendered')
    backgroundDockButton.click()
    await waitForSelector(view, '[role="menu"]')
    const backgroundMenu = view.querySelector('[role="menu"]')
    const disableBackground = [...backgroundMenu.querySelectorAll('button')]
      .find(button => button.textContent?.includes('关闭背景渲染'))
    assert.ok(disableBackground !== undefined, 'background menu has an explicit off action (#27)')
    disableBackground.click()
    assert.ok(await waitUntil(() => view.querySelector('[data-mode="blank"]') !== null), 'animated background is disabled')
    backgroundDockButton.click()
    await waitForSelector(view, '[role="menu"]')
    const restoredBackgroundMenu = view.querySelector('[role="menu"]')
    const dotsBackground = [...restoredBackgroundMenu.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '点阵')
    assert.ok(dotsBackground !== undefined, 'background menu still exposes visual modes')
    dotsBackground.click()
    assert.ok(await waitUntil(() => view.querySelector('[data-mode="dots"]') !== null), 'visual background mode can be restored')

    const nodeTool = (nodeId, label) => view.querySelector(`[data-node-id="${nodeId}"] [title^="${label}"]`)
    assert.ok(nodeTool('node-image', '标注') !== null, '标注 button rendered')
    assert.ok(nodeTool('node-image', '移除背景') !== null, '移除背景 button rendered')
    assert.ok(nodeTool('node-image', '图层拆分') !== null, '图层拆分 button rendered')
    assert.ok(view.querySelector('[data-node-id="node-image"] button[aria-label^="本节点使用的模型"]') !== null, 'node model selector rendered')

    // Enter annotation mode: the image body gains a drawing overlay.
    nodeTool('node-image', '标注').click()
    await waitForSelector(view, '[data-node-id="node-image"][data-annotating]')
    const overlay = view.querySelector('[data-node-id="node-image"] [title^="在图片上拖拽画框"]')
    assert.ok(overlay !== null, 'annotation overlay mounted')
    // The 64x64 image letterboxes into a 100x100 overlay: a drag from 10% to
    // 60% must land as a normalized 0.5 box.
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const pointer = (type, x, y) => overlay.dispatchEvent(new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
    pointer('pointerdown', 10, 10)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer('pointermove', 60, 60)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer('pointerup', 60, 60)
    await waitForSelector(view, 'textarea[placeholder^="描述这个框里要改成什么"]')
    const cardArea = view.querySelector('textarea[placeholder^="描述这个框里要改成什么"]')
    assert.ok(cardArea !== null, 'releasing the box created a prompt card')
    assert.ok(view.querySelector('[data-node-id="node-image"][data-annotating]') !== null, 'annotation mode stays active for more boxes')
    // Delete inside an empty card removes the card itself (the key would look
    // broken otherwise, since a fresh card has nothing to erase).
    const firstCardId = cardArea.closest('[data-node-id]').getAttribute('data-node-id')
    // Make sure the card is on the canvas (a save carrying it landed) before
    // deleting it, so the assertion below cannot pass on a stale snapshot.
    assert.ok(await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === firstCardId)), 'the prompt card reached the document')
    cardArea.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    assert.ok(
      await waitUntil(() => view.querySelector(`[data-node-id="${firstCardId}"]`) === null),
      'Delete removes an empty text card',
    )
    // Draw the box that carries the real prompt.
    const overlay2 = view.querySelector('[data-node-id="node-image"] [title^="在图片上拖拽画框"]')
    overlay2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const pointer2 = (type, x, y) => overlay2.dispatchEvent(new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
    pointer2('pointerdown', 10, 10)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer2('pointermove', 60, 60)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer2('pointerup', 60, 60)
    await waitForSelector(view, 'textarea[placeholder^="描述这个框里要改成什么"]')
    const cardArea2 = view.querySelector('textarea[placeholder^="描述这个框里要改成什么"]')
    assert.ok(cardArea2 !== null, 'a second box produced a new prompt card')
    // Type the box prompt; the debounced save carries it into the document.
    nativeTextAreaSetter.call(cardArea2, '把这里换成一只橘猫')
    cardArea2.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.text === '把这里换成一只橘猫'))
    const savedAfterAnnotation = canvasSaves.at(-1)
    assert.ok(savedAfterAnnotation !== undefined, 'annotation edit was persisted')
    const annotationImage = savedAfterAnnotation.nodes.find(node => node.id === 'node-image')
    assert.equal(annotationImage.metadata.annotations.length, 1, `the box is recorded on the image node: ${JSON.stringify(annotationImage.metadata.annotations)}`)
    const recordedBox = annotationImage.metadata.annotations[0]
    assert.deepEqual(
      { x: recordedBox.x, y: recordedBox.y, width: recordedBox.width, height: recordedBox.height },
      { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    )
    const cardNode = savedAfterAnnotation.nodes.find(node => node.id === recordedBox.nodeId)
    assert.ok(cardNode !== undefined, 'the box links to its prompt card')
    assert.equal(cardNode.metadata.text, '把这里换成一只橘猫')
    assert.deepEqual(
      savedAfterAnnotation.connections.map(connection => `${connection.fromNodeId}->${connection.toNodeId}`),
      ['node-image->node-config'],
      'annotation cards are attached, not wired into the graph',
    )
    const linkLayer = view.querySelector('[data-annotation-links]')
    assert.ok(linkLayer !== null, 'annotation leader lines render in their own layer')
    assert.ok(linkLayer.querySelector('[data-annotation-link]') !== null, 'the box has a leader line')
    assert.ok(linkLayer.querySelector('circle') !== null, 'the leader line starts with an anchor dot on the box')
    // The layer must paint above the nodes, otherwise the line hides under the
    // picture it points at.
    const imageElementForOrder = view.querySelector('[data-node-id="node-image"]')
    assert.equal(
      linkLayer.compareDocumentPosition(imageElementForOrder) & jsdomWindow.Node.DOCUMENT_POSITION_PRECEDING,
      jsdomWindow.Node.DOCUMENT_POSITION_PRECEDING,
      'the leader-line layer comes after the nodes in document order',
    )

    // Generate from the config node: the request must carry the boxed reference.
    // The earlier settings flow cleared the channel key, so restore it first —
    // the composer refuses to submit while the plugin reads as disconnected.
    face.channels.setChannelKey('default', 'sk-new')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 120))
    view.querySelector('[data-node-id="node-config"]').dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0 }))
    await waitForSelector(view, '[aria-label="生成图片"]')
    const sendButton = view.querySelector('[aria-label="生成图片"]')
    // React refuses to invoke click handlers on a disabled control (mirroring
    // the browser), so wait for the composer to leave the disconnected state.
    assert.ok(await waitUntil(() => view.querySelector('[aria-label="生成图片"]')?.disabled === false), 'composer enabled after the key is restored')
    sendButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    if (!await waitUntil(() => canvasTasks.length > 0)) {
      const toast = [...view.querySelectorAll('[role="status"]')].map(element => element.textContent).join(' | ')
      throw new Error(`no task submitted; toast: ${toast}; requests: ${requestPaths.slice(-6).join(',')}`)
    }
    const boxed = canvasTasks[0]
    assert.equal(boxed.mode, 'edit', 'an annotated generation runs in edit mode')
    assert.equal(boxed.model, 'gpt-image-2', 'the configured model is used')
    assert.ok(String(boxed.image).startsWith('data:image/png;base64,'), 'the marked reference is uploaded as a data URL')
    assert.equal(boxed.refName, 'canvas-annotated.png')
    assert.ok(boxed.prompt.includes('【局部修改约束】'), 'the box constraint reaches the prompt')
    assert.ok(boxed.prompt.includes('把这里换成一只橘猫'), 'the card prompt reaches the prompt')
    assert.ok(boxed.prompt.includes('框 1（左 10%，上 10%，右 60%，下 60%）'), `box coordinates are described: ${boxed.prompt}`)
    assert.equal(boxed.canvas.sourceNodeId, 'node-image', 'the generation is anchored on the annotated image')
    assert.equal(boxed.canvas.parentNodeId, 'node-config')
    // The placeholder remembers the boxes so the finished image can be
    // composited back onto the clean original (the marker must not survive).
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.annotationEdit !== undefined)),
      'the generated placeholder records the annotated boxes for compositing',
    )

    // --- canvas video: the composer switches kind and submits a video run ---
    // The canvas shares one composer between images and clips; this proves the
    // switch actually reroutes the submit and stamps canvas lineage so the
    // placeholder node can be filled when the render settles.
    await new Promise(resolve => setTimeout(resolve, 60))
    const kindSwitch = [...view.querySelectorAll('[data-node-id="node-config"] ~ *, [class*="composerKind"] button')]
    const videoKindButton = [...view.querySelectorAll('button')].find(button => button.textContent === '视频' && button.closest('[class*="composerKind"]') !== null)
    assert.ok(videoKindButton !== undefined, 'the composer offers a video kind toggle')
    videoKindButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const videoSend = await waitUntil(() => view.querySelector('[aria-label="生成视频"]'))
    assert.ok(videoSend !== null && videoSend !== false, 'the composer send button switches to video')
    assert.equal(view.querySelector('[aria-label="生成图片"]') === null, true, 'the image send button is replaced in video mode')

    // The composer swaps in the video model picker: its trigger shows the model
    // the run will use, and the image-only selects are gone.
    // CSS Modules hash class names, so anchor on the composer root by the
    // element that contains the prompt box rather than by a class substring.
    const canvasPromptBox = view.querySelector('[data-canvas-no-zoom] textarea')
    assert.ok(canvasPromptBox !== null, 'the composer prompt is mounted')
    const composer = canvasPromptBox.closest('[data-canvas-no-zoom]')
    const videoPicker = composer.querySelector('[aria-label^="视频模型"]')
    assert.ok(videoPicker !== null, 'the canvas composer swaps in the video model picker')
    assert.ok(
      videoPicker.getAttribute('aria-label').includes('agnes-video-2.5-flash'),
      `the video picker shows the configured video model: ${videoPicker.getAttribute('aria-label')}`,
    )
    assert.equal(composer.querySelector('[aria-label="清晰度"]') === null, true, 'image-only selects are absent in video mode')
    assert.equal(composer.querySelector('[aria-label="画面比例"]') === null, true, 'the image ratio select is replaced by the video ratio select')

    // Fill the prompt through the native setter (React 18 + jsdom), then submit.
    const canvasPrompt = canvasPromptBox
    const canvasTextAreaSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set
    canvasTextAreaSetter.call(canvasPrompt, 'a cat walking through rain')
    canvasPrompt.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const videoSendEnabled = view.querySelector('[aria-label="生成视频"]')
    assert.equal(videoSendEnabled.disabled, false, 'video submit enables once a prompt exists')
    videoSendEnabled.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(
      await waitUntil(() => canvasVideoSubmissions.length > 0),
      'the canvas submits a video run',
    )
    const run = canvasVideoSubmissions[0]
    assert.equal(run.model, 'agnes-video-2.5-flash', 'the canvas sends the configured video model')
    assert.equal(run.prompt, 'a cat walking through rain')
    assert.equal(run.canvas.canvasId, canvasDocument.id, 'the run carries its canvas id')
    assert.equal(run.canvas.sourceNodeId, 'node-config', 'the run records the config node that started it')
    assert.ok(typeof run.canvas.nodeId === 'string' && run.canvas.nodeId !== '', 'the run names its placeholder node')
    // The image -> config edge means one image feeds the run, so the planner
    // picks image-to-video rather than silently dropping the reference.
    assert.equal(run.mode, 'image', 'a connected image makes this an image-to-video run')
    assert.ok(String(run.image).startsWith('data:image/png;base64,'), 'the connected image travels as a data URL')
    assert.equal(run.canvas.referenceNodeIds?.length, 1, 'the reference node is recorded for retries')

    // A placeholder video node exists and shows the rendering state.
    //
    // Match it by the id the run named (`run.canvas.nodeId`) rather than by
    // "the first video node": a canvas may legitimately hold several video nodes
    // (an imported clip is one too), and a positional lookup would quietly
    // assert against whichever happened to be appended first.
    const placeholderNodeId = run.canvas.nodeId
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === placeholderNodeId)),
      'a placeholder video node is added to the canvas',
    )
    const placeholder = canvasSaves.at(-1).nodes.find(node => node.id === placeholderNodeId)
    assert.equal(placeholder.metadata.status, 'generating', 'the placeholder starts in the generating state')
    assert.equal(placeholder.metadata.videoMode, 'image', 'the placeholder remembers the video mode')
    assert.ok(typeof placeholder.metadata.seconds === 'number', 'the placeholder remembers the duration')
    assert.ok(view.querySelector(`[data-node-id="${placeholder.id}"]`) !== null, 'the video node renders')

    // Now let the render "finish" and confirm the node receives the served clip
    // by reference (no asset copy) and becomes playable.
    const placeholderId = placeholder.id
    const taskId = placeholder.metadata.taskId
    const finished = videoTasks.find(task => task.id === taskId)
    assert.ok(finished !== undefined, 'the submitted task is in the queue stub')
    // The clip list is read once per app session (initialDataRequestedRef), so
    // count the reads to prove the completion-triggered refetch below fires.
    const clipListCallsBefore = videoHistoryListCalls
    finished.status = 'completed'
    // The poller reads /video/tasks/list, which returns the mutated stub.
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === placeholderId && node.metadata?.video !== undefined), 6000),
      'the placeholder receives its clip once the render completes',
    )
    // A finished render appends to the host's clip history, but the sidebar
    // reads that list only once: without a refetch keyed off the newly
    // completed task, the clip never appeared until the whole app was
    // reloaded. The image path has always refreshed after a completion; the
    // clip path lost it when its list moved into the unified sidebar.
    assert.ok(
      await waitUntil(() => videoHistoryListCalls > clipListCallsBefore, 6000),
      `a finished clip render refetches the clip list (reads: ${clipListCallsBefore} -> ${videoHistoryListCalls})`,
    )
    const filled = canvasSaves.at(-1).nodes.find(node => node.id === placeholderId)
    assert.equal(filled.metadata.status, 'success', 'the video node reports success')
    assert.match(filled.metadata.video.url, /\/api\/dsh-imagegen\/video\/file\//, 'the clip is referenced by its served URL')
    assert.equal(filled.metadata.video.mime, 'video/mp4')
    assert.equal(filled.metadata.video.entryId, 'video-entry-1', 'the node remembers its history entry for gallery writes')
    // The clip must NOT be copied into the canvas asset store.
    assert.equal(filled.metadata.asset, undefined, 'a video node carries no canvas asset (the clip is referenced)')
    const player = view.querySelector(`[data-node-id="${placeholderId}"] video`)
    assert.ok(player !== null, 'the finished node renders a video element')
    assert.equal(player.getAttribute('src'), filled.metadata.video.url, 'the player points at the served clip')

    // The video node toolbar exposes download / frame grab / gallery actions.
    assert.ok(view.querySelector(`[data-node-id="${placeholderId}"] [title="下载视频"]`) !== null, 'the video node offers a download action')
    assert.ok(view.querySelector(`[data-node-id="${placeholderId}"] [title="抽取当前帧"]`) !== null, 'the video node offers a frame-grab action')
    assert.ok(view.querySelector(`[data-node-id="${placeholderId}"] [title="收藏到画廊"]`) !== null, 'the video node offers a gallery action')

    // The clip opens in a full-screen player (double-click, or the expand
    // action), and Escape/close dismisses it.
    assert.ok(view.querySelector(`[data-node-id="${placeholderId}"] [title="放大预览"]`) !== null, 'the video node offers an expand action')
    const videoNodeEl = view.querySelector(`[data-node-id="${placeholderId}"]`)
    videoNodeEl.dispatchEvent(new jsdomWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-video-preview]') !== null), 'double-clicking a video node opens the full-screen player')
    const clipOverlay = view.querySelector('[data-video-preview]')
    const overlayPlayer = clipOverlay.querySelector('video')
    assert.ok(overlayPlayer !== null, 'the full-screen player renders a video element')
    assert.equal(overlayPlayer.getAttribute('src'), filled.metadata.video.url, 'the full-screen player uses the served clip URL')
    clipOverlay.querySelector('button').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(view.querySelector('[data-video-preview]') === null, true, 'the full-screen player dismisses')

    // --- the code-generation path, chosen per task in the same composer ---
    // The requirement is that both paths sit side by side and the user picks one
    // per run; this drives the real composer rather than the runtime API.
    const rendererTrigger = view.querySelector('button[data-dsh-select][aria-label="生成方式"]')
    assert.ok(rendererTrigger !== null, 'the composer offers a per-task rendering choice')
    assert.equal(rendererTrigger.textContent, '模型生成', 'the historical model path stays the default')
    rendererTrigger.click()
    await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
    const codeOption = [...jsdomDocument.querySelectorAll('[data-dsh-select-menu] [role="option"]')].find(option => option.textContent === '代码生成')
    assert.ok(codeOption !== undefined, 'the menu offers the code path next to model generation')
    codeOption.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    // Re-grab the composer: the switch re-renders it, and a stale reference
    // would make the "picker is hidden" assertion pass against a detached node.
    const codeComposer = view.querySelector('[data-canvas-no-zoom] textarea').closest('[data-canvas-no-zoom]')
    assert.equal(view.querySelector('button[data-dsh-select][aria-label="生成方式"]').textContent, '代码生成', 'the switch took effect')

    // No provider is picked in this mode — there is no provider to pick.
    assert.equal(codeComposer.querySelector('[aria-label^="视频模型"]') === null, true, 'the video model picker is hidden on the code path')
    // The shape controls that the code renderer actually honours stay.
    assert.ok(view.querySelector('[aria-label="比例"]') !== null, 'the aspect select survives the switch')
    assert.ok(view.querySelector('[aria-label="分辨率"]') !== null, 'the resolution select survives the switch')
    assert.ok(view.querySelector('[aria-label="时长"]') !== null, 'the duration select survives the switch')
    assert.ok(
      (view.textContent ?? '').includes('由本机渲染') || (view.textContent ?? '').includes('本机渲染'),
      'the composer explains that this path renders locally',
    )

    const codePrompt = view.querySelector('[data-canvas-no-zoom] textarea')
    const codeSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set
    codeSetter.call(codePrompt, 'a slow pan over a blue grid')
    codePrompt.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const codeSend = view.querySelector('[aria-label="生成视频"]')
    assert.equal(codeSend.disabled, false, 'a code run does not require a connected channel')
    const codeRunsBefore = canvasVideoSubmissions.length
    codeSend.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(
      await waitUntil(() => canvasVideoSubmissions.length > codeRunsBefore, 6000),
      'the composer submits a code run',
    )
    const codeRun = canvasVideoSubmissions.at(-1)
    assert.equal(codeRun.renderer, 'code', 'the run is marked as a code render')
    assert.equal(codeRun.model, '', 'no model alias is sent on the code path')
    assert.equal(codeRun.channelId, undefined, 'no channel is named on the code path')
    assert.equal(codeRun.mode, 'text', 'references are not sent as provider frames')
    assert.equal(codeRun.image, undefined, 'the wired picture is not uploaded as a provider frame')
    assert.equal(codeRun.prompt, 'a slow pan over a blue grid')
    assert.equal(codeRun.seconds, Number(codeRun.seconds), 'the duration is a number')
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === codeRun.canvas.nodeId && node.metadata?.renderer === 'code'), 6000),
      'the placeholder remembers it is a code render',
    )
    // A failed code run must say it can be switched back, not just die.
    const codePlaceholderId = codeRun.canvas.nodeId
    const codeTask = videoTasks.find(task => task.id === canvasSaves.at(-1).nodes.find(node => node.id === codePlaceholderId).metadata.taskId)
    assert.ok(codeTask !== undefined, 'the code run reached the queue stub')
    codeTask.status = 'failed'
    codeTask.error = 'code-syntax: unexpected token'
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === codePlaceholderId)?.metadata?.status === 'error', 6000),
      'a failed code run lands on the node as an error',
    )
    const failedCodeNode = view.querySelector(`[data-node-id="${codePlaceholderId}"]`)
    assert.ok((failedCodeNode?.textContent ?? '').includes('code-syntax'), 'the host message is shown verbatim')
    assert.ok((failedCodeNode?.textContent ?? '').includes('切回模型生成'), 'the node says how to recover')

    // Switching back restores the model picker with the configured model.
    view.querySelector('button[data-dsh-select][aria-label="生成方式"]').click()
    await waitForSelector(jsdomDocument, '[data-dsh-select-menu]')
    const modelOption = [...jsdomDocument.querySelectorAll('[data-dsh-select-menu] [role="option"]')].find(option => option.textContent === '模型生成')
    assert.ok(modelOption !== undefined, 'the menu still offers the model path')
    modelOption.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(
      await waitUntil(() => view.querySelector('[aria-label^="视频模型"]') !== null),
      'switching back brings the video model picker back',
    )

    // Switching back to the image kind restores the image controls.
    const imageKindButton = [...view.querySelectorAll('[class*="composerKind"] button')].find(button => button.textContent === '图片')
    assert.ok(imageKindButton !== undefined, 'the composer offers an image kind toggle')
    imageKindButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.ok(await waitUntil(() => view.querySelector('[aria-label="生成图片"]') !== null), 'the image send button returns')

    // 移除背景: local matting uploads a transparent PNG and adds a result node.
    nodeTool('node-image', '移除背景').click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.transparent === true)),
      'a transparent cut-out node was created',
    )
    const savedAfterMatte = canvasSaves.at(-1)
    const matteNode = savedAfterMatte.nodes.find(node => node.metadata.transparent === true)
    assert.ok(
      savedAfterMatte.connections.some(connection => connection.fromNodeId === 'node-image' && connection.toNodeId === matteNode.id),
      'the cut-out is connected to its source',
    )

    // 图层拆分: the host plan becomes background / object / text nodes.
    nodeTool('node-image', '图层拆分').click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).filter(node => node.metadata?.layer !== undefined).length >= 3),
      'the planned layers became nodes',
    )
    const savedAfterLayers = canvasSaves.at(-1)
    const layerNodes = savedAfterLayers.nodes.filter(node => node.metadata.layer !== undefined)
    assert.deepEqual(layerNodes.map(node => node.metadata.layer.kind).sort(), ['background', 'object', 'text'], 'every planned layer became a node')
    const layerText = layerNodes.find(node => node.metadata.layer.kind === 'text')
    assert.equal(layerText.metadata.text, '夏日限定', 'the recognized text lands in an editable text node')
    assert.equal(layerText.metadata.color, '#ffee00')
    assert.ok(layerText.metadata.fontSize > 0, 'the text layer keeps an editable font size')
    const layerObject = layerNodes.find(node => node.metadata.layer.kind === 'object')
    assert.ok(String(layerObject.metadata.asset.url).startsWith('/api/dsh-imagegen/canvas/asset/'), 'the object layer was uploaded as its own asset')
    assert.ok(
      layerNodes.every(node => savedAfterLayers.connections.some(connection => connection.fromNodeId === 'node-image' && connection.toNodeId === node.id)),
      'every layer node is wired to the source image',
    )

    // Text cards expose font size, weight and color controls.
    const textNodeId = layerText.id
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="放大字号"]`) !== null, 'font size controls rendered')
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="加粗"]`) !== null, 'bold control rendered')
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="文字颜色"]`) !== null, 'color control rendered')
    view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="放大字号"]`).click()
    view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="文字颜色"]`).click()
    await waitForSelector(view, `[data-node-id="${textNodeId}"] [title="#e03131"]`)
    view.querySelector(`[data-node-id="${textNodeId}"] [title="#e03131"]`).click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === textNodeId && node.metadata?.color === '#e03131')),
      'the palette writes the text color',
    )
    const savedText = canvasSaves.at(-1).nodes.find(node => node.id === textNodeId)
    assert.ok(savedText.metadata.fontSize > layerText.metadata.fontSize, 'the font size stepper writes metadata')

    // --- layout + interaction regressions ---
    // Image node chrome no longer covers the picture: no info chips inside the
    // body, a footer strip instead, and the toolbar hangs below the frame.
    const imageNode = view.querySelector('[data-node-id="node-image"]')
    assert.ok(imageNode.querySelector('[data-image-footer]') !== null, 'image node renders an info footer')
    assert.equal(imageNode.querySelector('[data-toolbar]').getAttribute('data-toolbar'), 'bottom', 'image node toolbar sits below the frame')
    assert.ok(imageNode.querySelector('[data-image-footer]').textContent.includes('64×64'), 'footer carries the asset size')
    // Layer nodes are laid out as a column, not stacked on one another.
    const layerBoxes = layerNodes.map(node => ({ y: node.y, height: node.height })).sort((a, b) => a.y - b.y)
    for (let index = 1; index < layerBoxes.length; index += 1) {
      assert.ok(layerBoxes[index].y >= layerBoxes[index - 1].y + layerBoxes[index - 1].height, `layer nodes overlap at index ${index}`)
    }
    // The composer survives the image-node tools (the config node stays selected).
    assert.ok(view.querySelector('[aria-label="生成图片"]') !== null, 'composer still visible after the image-node tools')
    // Ctrl-clicking another node keeps the config node in the selection, so the
    // generation bar does not vanish.
    imageNode.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0, ctrlKey: true }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(view.querySelector('[aria-label="生成图片"]') !== null, 'composer survives a multi-selection containing the config node')

    // The hover toolbar acts on the node under the pointer, not on the
    // selection: deleting an unselected layer node removes exactly that node.
    view.querySelector(`[data-node-id="${layerObject.id}"] [title="删除"]`).dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).every(node => node.id !== layerObject.id)),
      'the hovered node was deleted',
    )
    const afterDelete = canvasSaves.at(-1)
    assert.ok(afterDelete.nodes.some(node => node.id === 'node-image'), 'other nodes survive a targeted delete')
    assert.ok(afterDelete.nodes.some(node => node.id === 'node-config'), 'the config node survives a targeted delete')
    assert.equal(
      afterDelete.connections.some(connection => connection.fromNodeId === layerObject.id || connection.toNodeId === layerObject.id),
      false,
      'its connections are cleaned up',
    )

    // --- image node ergonomics: attached cards follow, four corner grips ---
    const beforeDrag = canvasSaves.at(-1)
    const imageBefore = beforeDrag.nodes.find(node => node.id === 'node-image')
    const cardBefore = beforeDrag.nodes.find(node => node.id === cardNode.id)
    const imageElement = view.querySelector('[data-node-id="node-image"]')
    imageElement.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 110, clientY: 60, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 40))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 60, button: 0 }))
    assert.ok(
      await waitUntil(() => {
        const moved = (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === 'node-image')
        return moved !== undefined && moved.x === imageBefore.x + 100 && moved.y === imageBefore.y + 50
      }),
      'the image node moved with the pointer',
    )
    const afterDrag = canvasSaves.at(-1)
    const cardAfter = afterDrag.nodes.find(node => node.id === cardNode.id)
    assert.equal(cardAfter.x, cardBefore.x + 100, 'the attached prompt card follows its image node horizontally')
    assert.equal(cardAfter.y, cardBefore.y + 50, 'the attached prompt card follows its image node vertically')

    // Four corner grips, and dragging one resizes (images keep their ratio).
    const grips = [...view.querySelectorAll('[data-node-id="node-image"] [data-corner]')].map(element => element.getAttribute('data-corner')).sort()
    assert.deepEqual(grips, ['ne', 'nw', 'se', 'sw'], 'all four resize corners are rendered')
    const grip = view.querySelector('[data-node-id="node-image"] [data-corner="se"]')
    grip.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 40, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 40))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 90, clientY: 40, button: 0 }))
    assert.ok(
      await waitUntil(() => {
        const resized = (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === 'node-image')
        return resized !== undefined && resized.width > imageBefore.width + 40
      }),
      'dragging a corner grip grows the node',
    )
    const resizedImage = canvasSaves.at(-1).nodes.find(node => node.id === 'node-image')
    assert.equal(resizedImage.height, Math.round(resizedImage.width), 'the image keeps its aspect ratio while resizing')
    assert.equal(resizedImage.x, imageBefore.x + 100, 'the anchored corner stays put')

    // --- a fully covered node is called out while the drag is in progress ---
    // 节点在画布上可以任意摆放，所以「把一个节点整个拖到另一个上面」是能真的做出
    // 来的：被盖住的那个既看不见、也框选不到，用户会以为节点丢了。
    //
    // 用一个 100x80 的小文本节点去盖：包含关系要成立，被盖的那方必须真的比盖住它
    // 的小，而画布上现成的图片节点（240x240）比配置节点（320x190）还高。
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-covered', type: 'text', title: '会被盖住的小卡片', x: 0, y: 1200, width: 100, height: 80, metadata: { status: 'idle', text: '' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-covered"]')
    {
      const coveredEl = view.querySelector('[data-node-id="node-covered"]')
      const configEl = view.querySelector('[data-node-id="node-config"]')
      assert.ok(coveredEl !== null && configEl !== null, 'both nodes are on the canvas')
      // 从 DOM 读位置：重开画布后第一次保存还没发生，canvasSaves 里可能仍是上一版。
      const boxOf = (element) => ({
        x: Number.parseFloat(element.style.left),
        y: Number.parseFloat(element.style.top),
        width: Number.parseFloat(element.style.width),
        height: Number.parseFloat(element.style.height),
      })
      const coveredNode = boxOf(coveredEl)
      const coverNode = boxOf(configEl)
      // 目标：小节点落在配置节点正中（四周都留余量，包含关系才成立）。
      const toCentre = {
        x: coverNode.x + (coverNode.width - coveredNode.width) / 2 - coveredNode.x,
        y: coverNode.y + (coverNode.height - coveredNode.height) / 2 - coveredNode.y,
      }
      coveredEl.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
      jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 10 + toCentre.x, clientY: 10 + toCentre.y, button: 0 }))
      assert.ok(
        await waitUntil(() => view.querySelector('[data-node-covered]') !== null),
        'a node dragged fully under another is called out while the drag is live',
      )
      const badge = view.querySelector('[data-node-covered]')
      assert.equal(badge.getAttribute('data-node-covered'), 'node-covered', 'the badge names the covered node')
      assert.ok(
        (badge.getAttribute('aria-label') ?? '').includes('完全重叠'),
        'the badge says what happened, for a reader that cannot see the outline',
      )
      // 松手后提示必须还在：松手之后那个节点依然被盖着、依然看不见，
      // 提示只在拖动期间存在的话，它就正好错过了唯一需要它的时刻。
      jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 10 + toCentre.x, clientY: 10 + toCentre.y, button: 0 }))
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.ok(
        view.querySelector('[data-node-covered]') !== null,
        'the callout survives the pointer being released — the node is still covered',
      )
      // 再拖开一次：提示必须跟着消失，否则它就成了画布上一个不会散的标记。
      coveredEl.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
      jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 10 + toCentre.x + coverNode.width, clientY: 10 + toCentre.y, button: 0 }))
      assert.ok(
        await waitUntil(() => view.querySelector('[data-node-covered]') === null),
        'the callout clears as soon as the node is no longer covered',
      )
      jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 10 + toCentre.x + coverNode.width, clientY: 10 + toCentre.y, button: 0 }))
      await new Promise(resolve => setTimeout(resolve, 40))
      // 收尾：把探针节点从文档里删掉，后面读 canvasDocument 的检查不该看见它。
      canvasDocument.nodes = canvasDocument.nodes.filter(node => node.id !== 'node-covered')
    }

    // --- file nodes read their content instead of showing a download hint ---
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-file', type: 'file', title: 'notes.txt', x: 0, y: 640, width: 300, height: 170, metadata: { asset: canvasFileAsset, fileKind: 'text', status: 'success' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-file"]')
    assert.ok(await waitUntil(() => previewRequests.some(request => request.assetId === canvasFileAsset.assetId)), 'the node asked the host to decode the file')
    assert.ok(
      await waitUntil(() => (view.querySelector('[data-node-id="node-file"] pre')?.textContent ?? '').includes('文件预览正文')),
      'the node body renders the decoded text',
    )
    // The reader opens from the node toolbar and shows the same content larger.
    const fileNode = view.querySelector('[data-node-id="node-file"]')
    assert.ok(fileNode.querySelector('[data-file-footer]').textContent.includes('notes.txt'), 'the file footer carries the name')
    fileNode.querySelector('[title="放大预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await waitForSelector(view, '[role="dialog"]')
    const reader = view.querySelector('[role="dialog"]')
    assert.ok(reader.textContent.includes('notes.txt'), 'the reader header carries the file name')
    assert.ok(reader.querySelector('pre').textContent.includes('second line'), 'the reader shows the full decoded text')
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[role="dialog"]') === null), 'Escape closes the reader')

    // A PDF needs no host payload: the browser renders it from the inline URL,
    // in the node body and in the reader alike.
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-pdf', type: 'file', title: 'paper.pdf', x: 0, y: 900, width: 300, height: 170, metadata: { asset: canvasPdfAsset, fileKind: 'pdf', status: 'success' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-pdf"] object[type="application/pdf"]')
    const pdfBody = view.querySelector('[data-node-id="node-pdf"] object[type="application/pdf"]')
    assert.match(pdfBody.getAttribute('data'), /\?inline=1$/, 'the node embeds the inline URL')
    view.querySelector('[data-node-id="node-pdf"] [title="放大预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await waitForSelector(view, '[role="dialog"] object[type="application/pdf"]')
    assert.ok(view.querySelector('[role="dialog"]').textContent.includes('paper.pdf'), 'the reader names the PDF')
    view.querySelector('[role="dialog"] [title="关闭预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[role="dialog"]') === null), 'the close button dismisses the reader')

    // ------------------------------------------- canvas interaction defects
    // Every check below pins a defect that was confirmed by the UI sweep and
    // is NOT visible in the rendered output -- the failure mode is a control
    // that silently does nothing, or does something invisible.

    // (1) Clicking a floating overlay's blank margin must not clear the
    // selection that put the overlay on screen.
    //
    // The guarantee here is STRUCTURAL, not a guard inside the viewport
    // handler: every overlay (the composer, the picker, the context menus) is
    // rendered as a SIBLING of the viewport, so a pointerdown on it never
    // reaches `onViewportPointerDown` in the first place. Asserting the
    // structure is what makes this check able to fail -- a behaviour-only
    // assertion passes whether or not the guard exists, which is how an
    // earlier version of this check turned out to be vacuous.
    const configNode = view.querySelector('[data-node-id="node-config"]')
    configNode.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 60))
    const composerRoot = view.querySelector('[data-canvas-no-zoom][class*="composer"]')
    assert.ok(composerRoot !== null, 'the composer is on screen before the overlay pointerdown check')
    // `=== null` rather than assert.equal: on failure assert.equal runs
    // util.inspect over the actual value, and inspecting a jsdom element walks
    // its React fiber (circular, unbounded) until the process is OOM-killed --
    // the mutation below reproduced exactly that, killing the run before the
    // failure could be reported.
    assert.ok(
      composerRoot.closest('[class*="viewport"]') === null,
      'the composer sits outside the viewport, so its blank margin cannot clear the selection',
    )
    // And the behaviour that structure buys, stated directly.
    composerRoot.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(
      view.querySelector('[data-canvas-no-zoom][class*="composer"]') !== null,
      'a pointerdown on the composer overlay does not clear the selection that opened it',
    )

    // (2) A touch device never sends a wheel event, so pinch is the only zoom
    // there. Two touch pointers moving apart must raise the viewport scale.
    const viewportEl = view.querySelector('[class*="viewport"]')
    assert.ok(viewportEl !== null, 'the canvas viewport is mounted')
    const zoomPercent = () => Number((view.querySelector('[class*="zoomValue"]')?.textContent ?? '0').replace('%', ''))
    const beforePinch = zoomPercent()
    // jsdom has no PointerEvent: the handler reads clientX/clientY/pointerId/
    // pointerType off the event object, so a MouseEvent with those fields added
    // exercises the same code path.
    const touch = (type, id, x, y) => {
      const event = new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      Object.assign(event, { pointerId: id, pointerType: 'touch' })
      viewportEl.dispatchEvent(event)
      jsdomWindow.dispatchEvent(event)
    }
    touch('pointerdown', 901, 100, 100)
    touch('pointerdown', 902, 200, 100)
    touch('pointermove', 902, 400, 100)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(
      zoomPercent() > beforePinch,
      `two touch pointers moving apart zoom in (${beforePinch}% -> ${zoomPercent()}%)`,
    )
    touch('pointerup', 902, 400, 100)
    touch('pointerup', 901, 100, 100)
    await new Promise(resolve => setTimeout(resolve, 40))
    // Lifting the fingers must not leave a pan armed: the next pointermove
    // with nothing down has to be inert, or the canvas drifts on the next tap.
    const afterPinch = zoomPercent()
    touch('pointermove', 903, 700, 500)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(zoomPercent(), afterPinch, 'the gesture ends cleanly when the fingers lift')

    // (3) Space on a focused button must activate it, not start a canvas pan.
    // The panel-wide keydown claims Space for the hand tool and preventDefaults
    // it, which ate the standard activation key of every button in the panel.
    const dockButton = view.querySelector('[data-canvas-workspace] [role="toolbar"] button')
    assert.ok(dockButton !== null, 'the dock has a button to focus')
    let spaceDefaultPrevented = false
    const spaceProbe = new jsdomWindow.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    dockButton.dispatchEvent(spaceProbe)
    spaceDefaultPrevented = spaceProbe.defaultPrevented
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(spaceDefaultPrevented, false, 'Space on a focused button is left to the button, not eaten by the pan tool')
    // ...while Space on the canvas background still starts the hand tool.
    const backgroundProbe = new jsdomWindow.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    viewportEl.dispatchEvent(backgroundProbe)
    assert.equal(backgroundProbe.defaultPrevented, true, 'Space on the canvas background still arms the pan tool')

    // (4) Esc must close the in-canvas overlays rather than silently reset the
    // selection behind them. The video preview is the clearest case: its only
    // other exit is the × button.
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-clip', type: 'video', title: 'clip.mp4', x: 0, y: 1200, width: 260, height: 160, metadata: { video: { url: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', width: 320, height: 240, duration: 2 }, status: 'success' } },
      // 第二段成片：时间线至少要两段才开得起来，而它是「配了两段就只显示两段」
      // 那条断言的对象。
      { id: 'node-clip-2', type: 'video', title: 'clip-2.mp4', x: 300, y: 1200, width: 260, height: 160, metadata: { video: { url: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', width: 320, height: 240, duration: 3 }, status: 'success' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-clip"]')
    view.querySelector('[data-node-id="node-clip"] [title="放大预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await waitForSelector(view, '[data-video-preview]')
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-video-preview]') === null), 'Escape closes the in-canvas video preview')

    // The timeline editor is the door to trims and transitions: it has to be in
    // the dock, it has to take the canvas clips in canvas order, and Escape has
    // to close it without clearing the selection behind it (the same rule the
    // preview above follows).
    const timelineButton = view.querySelector('[data-dock-item][data-label="时间线编辑"] button')
    assert.ok(timelineButton !== null, 'the dock carries a timeline entry')
    timelineButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-timeline-panel]') !== null), 'the timeline entry opens the editor')
    const timelineSegments = [...view.querySelectorAll('[data-timeline-segment]')]
    assert.deepEqual(
      timelineSegments.map(segment => segment.getAttribute('data-timeline-segment')),
      ['node-clip', 'node-clip-2'],
      'the timeline lists exactly the canvas clips, in canvas order',
    )
    const timelineTotal = view.querySelector('[data-timeline-total]')?.textContent ?? ''
    assert.ok(timelineTotal.includes('0:05.0'), `the timeline reports the summed length (got "${timelineTotal}")`)
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-timeline-panel]') === null), 'Escape closes the timeline editor')

    // Identity anchoring: a right-click pins the image, the dialog names it, the
    // node shows the pin, and the pin reaches the SAVED document (the whole
    // point is that a later generation reads it back from there).
    const castNodeEl = view.querySelector('[data-node-id="node-image"]')
    assert.ok(castNodeEl !== null, 'the image node is still mounted for the pin')
    const savesBeforeCast = canvasSaves.length
    castNodeEl.dispatchEvent(new jsdomWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
    assert.ok(await waitUntil(() => view.querySelector('[role="menu"]') !== null), 'the node menu opens')
    const pinRow = [...view.querySelectorAll('[role="menu"] button[role="menuitem"]')]
      .find(button => (button.textContent ?? '').includes('钉为身份参考'))
    assert.ok(pinRow !== undefined, 'the node menu offers the identity pin')
    pinRow.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-cast-dialog]') !== null), 'the pin opens the naming dialog')
    // The preview must show the sentence the model will actually receive.
    const castPreview = view.querySelector('[data-cast-preview]')?.textContent ?? ''
    assert.ok(castPreview.includes('图片节点'), `the dialog previews the prompt line (got "${castPreview}")`)
    view.querySelector('[data-cast-save]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-cast-badge]') !== null), 'the node shows it is pinned')
    assert.ok(
      (view.querySelector('[data-cast-badge]')?.textContent ?? '').includes('图片节点'),
      'the badge names the pinned identity',
    )
    assert.ok(
      await waitUntil(() => canvasSaves.slice(savesBeforeCast).some(saved =>
        saved.nodes.some(node => node.id === 'node-image' && node.metadata?.cast?.role === 'character'))),
      'the pin reaches the saved document',
    )
    // Unpinning goes through the same menu and must persist too.
    castNodeEl.dispatchEvent(new jsdomWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
    await waitUntil(() => view.querySelector('[role="menu"]') !== null)
    const unpinRow = [...view.querySelectorAll('[role="menu"] button[role="menuitem"]')]
      .find(button => (button.textContent ?? '').includes('取消身份参考'))
    assert.ok(unpinRow !== undefined, 'a pinned node offers to unpin')
    const savesBeforeUnpin = canvasSaves.length
    unpinRow.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-cast-badge]') === null), 'unpinning removes the badge')
    assert.ok(
      await waitUntil(() => canvasSaves.slice(savesBeforeUnpin).some(saved =>
        saved.nodes.some(node => node.id === 'node-image' && node.metadata?.cast === undefined))),
      'unpinning reaches the saved document',
    )

    // (6) The keyboard map has to be REACHABLE. Every binding existed before
    // this round; none of them was discoverable anywhere in the UI, which is
    // why the legend exists at all. Four things must hold, and each one fails
    // independently: the dock opens it, `?` opens it, Esc closes it, and the
    // dock's own undo tooltip names the key.
    const helpButton = view.querySelector('[data-canvas-workspace] [role="toolbar"] button[aria-label="快捷键"]')
    assert.ok(helpButton !== null, 'the dock carries a shortcut entry')
    helpButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') !== null), 'the dock entry opens the legend')
    const legend = view.querySelector('[data-shortcut-help]')
    assert.ok(legend.querySelectorAll('kbd').length >= 20, 'the legend lists the real bindings, not a placeholder')
    assert.ok(
      (legend.textContent ?? '').includes('Ctrl/⌘+Z') === false,
      'modifier combinations render as separate key chips, not one fused token',
    )
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') === null), 'Escape closes the legend')

    const questionProbe = new jsdomWindow.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })
    // Re-queried, not the `viewportEl` captured before step (4): that block
    // remounts the canvas, so the old node is detached and its events never
    // reach the window listener -- the probe would fail for a reason unrelated
    // to the binding it is testing.
    const liveViewport = view.querySelector('[class*="viewport"]')
    assert.ok(liveViewport !== null, 'the canvas viewport is mounted after the remount')
    liveViewport.dispatchEvent(questionProbe)
    assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') !== null), '? opens the legend too')
    assert.equal(questionProbe.defaultPrevented, true, '? is claimed by the legend, not typed into the page')
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') === null), 'Escape closes the one ? opened')

    const undoLabel = view.querySelector('[data-canvas-workspace] [role="toolbar"] button[aria-label^="撤销"]')?.getAttribute('aria-label') ?? ''
    assert.ok(undoLabel.includes('Ctrl/⌘+Z'), `the undo control names its key (got "${undoLabel}")`)

    // (5) The image picker must clear its file input, so re-picking the same
    // file after a failure still fires `change`. A stale value makes the retry
    // look like a dead button.
    //
    // This one is asserted from the SOURCE, not from the DOM: jsdom refuses a
    // non-empty `value` on a file input (InvalidStateError) and reports `''`
    // either way, so a DOM assertion here is green whether or not the code
    // clears anything -- a false green that negative verification caught.
    // Re-picking the same file cannot be reproduced in jsdom at all, so the
    // honest check is the invariant that the handler clears the field.
    const pickerSource = readFileSync(new URL('../src/client/CanvasWorkspace.tsx', import.meta.url), 'utf8')
    const pickerInputBlock = pickerSource.match(/onChange=\{event => \{[\s\S]{0,400}?uploadFiles\(files\)\s*\}\}/)?.[0] ?? ''
    assert.ok(pickerInputBlock !== '', 'the picker file input handler is findable')
    assert.match(
      pickerInputBlock,
      /event\.target\.value = ''/,
      'the picker clears its file input so the same file can be re-picked',
    )

    // A drop of images used to read EVERY file at once with Promise.all and no
    // size or count cap, so dragging a large selection in from Finder seized
    // the page (each FileReader holds the whole file, then the base64 string).
    // A real drop is not reproducible in jsdom, so the honest check is the
    // invariant: the caps are applied BEFORE any reader runs, and the reads are
    // sequential.
    const dropSource = readFileSync(new URL('../src/client/CanvasWorkspace.tsx', import.meta.url), 'utf8')
    const dropBlock = dropSource.match(/const onDrop = useCallback\([\s\S]{0,3000}?\[addAssets, api, screenToWorld, uploadCanvasFile\]\)/)?.[0] ?? ''
    assert.ok(dropBlock !== '', 'the canvas drop handler is findable')
    assert.match(
      dropBlock,
      /file\.size > DROP_IMAGE_MAX_BYTES/,
      'a dropped image over the size cap is filtered out',
    )
    assert.match(
      dropBlock,
      /\.slice\(0, DROP_IMAGE_MAX_COUNT\)/,
      'a drop is capped to a maximum number of images',
    )
    assert.ok(
      !/Promise\.all\(images\.map/.test(dropBlock),
      'dropped images are read sequentially, not all at once (a big drop used to freeze the page)',
    )
    // Leave the canvas as this check found it.
    const closePicker = view.querySelector('[data-canvas-no-zoom][class*="modalBackdrop"] [aria-label="关闭"]')
    closePicker?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 60))

    // The A+ workspace is a real surface, not just an eighth label: selecting
    // its tab mounts it, and it is the last top-nav entry so the generation
    // sub-modes stay hidden exactly like the other non-normal workspaces.
    const aplusSwitch = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('A+ 详情'))
    assert.ok(aplusSwitch !== undefined, 'aplus top-nav entry is present')
    aplusSwitch.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 90))
    const aplusWorkspace = view.querySelector('[data-aplus-workspace]')
    assert.ok(aplusWorkspace !== null, 'aplus workspace is rendered')
    assert.equal(aplusWorkspace.hidden, false, 'aplus workspace is visible while selected')
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 9, 'aplus keeps the nine top-nav entries and hides generation sub-modes')
    assert.ok(aplusWorkspace.textContent?.includes('A+ 详情页'), 'the aplus workspace labels itself')
    assert.ok(aplusWorkspace.querySelectorAll('input[type="checkbox"]').length >= 12, 'the aplus workspace offers all twelve modules')
    // Every module carries its own copy fields; the export draws them as a band on
    // the picture, so a module without them would silently export a caption-less row.
    assert.ok(aplusWorkspace.querySelector('[data-aplus-copy$="-title"]') !== null, 'a module exposes a title field for the on-image copy')
    assert.ok(aplusWorkspace.querySelector('[data-aplus-copy$="-body"]') !== null, 'a module exposes a body field for the on-image copy')
    assert.equal(aplusWorkspace.querySelectorAll('[data-aplus-copy]').length >= 12, true, 'every module can be captioned')

    // The clothing upload has to stop where the wire stops: the engine takes the
    // model shot plus four garments, so offering six meant two uploaded images
    // were dropped without a word.
    const outfitSwitch = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent === '服饰穿戴')
    assert.ok(outfitSwitch !== undefined, 'outfit top-nav entry is present')
    outfitSwitch.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 90))
    const outfitWorkspace = view.querySelector('[data-outfit]')
    assert.ok(outfitWorkspace !== null, 'outfit workspace is rendered')
    assert.ok(outfitWorkspace.textContent?.includes('最多 4 张服装图'), 'the outfit hint states the real upload limit')
    // Nothing has been generated yet, so the results column is showing its empty
    // state. `outfit.resultAlt` is the alt text of a finished picture ("生成结果 1")
    // and it used to stand in for the empty state, which reads like a result has
    // already come back. Pin the dedicated empty-state key instead, and pin the
    // other reading out so nobody quietly swaps it back.
    assert.ok(outfitWorkspace.textContent?.includes('生成结果会出现在这里'), 'the outfit results area describes an empty state, not a result')
    assert.equal(outfitWorkspace.textContent?.includes('生成结果 1'), false, 'the empty outfit results area must not read like a finished result')
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 9, 'outfit keeps the nine top-nav entries')

    // Promo mode is the ninth workspace: it has to mount a link field and the four
    // platform styles, and the nav count must not drift when it does.
    const promoSwitch = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent === '带货图文')
    assert.ok(promoSwitch !== undefined, 'promo top-nav entry is present')
    promoSwitch.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 90))
    const promoWorkspace = view.querySelector('[data-promo]')
    assert.ok(promoWorkspace !== null, 'promo workspace is rendered')
    assert.ok(promoWorkspace.querySelector('input[placeholder="粘贴商品链接"]') !== null, 'promo workspace offers a product-link field')
    // task-29: the platform picker became four pills (a <select> hid its current
    // value until it was opened). The assertion is deliberately NOT "there are
    // four <option>s" any more — that would pass for a stray select that nobody
    // renders. It checks the pill group carries the same four values the
    // <option>s did, because `promoImagePrompt` switches on them.
    const promoPills = [...promoWorkspace.querySelectorAll('[data-promo-platform]')]
    assert.deepEqual(promoPills.map(pill => pill.getAttribute('data-promo-platform')), ['xiaohongshu', 'douyin', 'taobao', 'dewu'], 'promo workspace offers the four platform styles as pills')
    assert.equal(promoWorkspace.querySelectorAll('select option').length, 0, 'the platform picker is no longer a hidden select')
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 9, 'promo keeps the nine top-nav entries')

    // One click must bill one generation. The submit buttons in both form
    // workspaces carried `type="submit"` AND an `onClick` that called the same
    // handler, so a single click ran the submit path and the click path: two
    // `/generate` requests, two charges, for one press. The count is observed on
    // the wire (the fetch stub records every path) rather than inferred from the
    // markup, because only the request count says the user is billed once.
    const promoNameField = promoWorkspace.querySelector('input[placeholder="商品名称"]')
    assert.ok(promoNameField !== null, 'promo workspace offers a product-name field')
    Object.getOwnPropertyDescriptor(jsdomWindow.HTMLInputElement.prototype, 'value').set.call(promoNameField, '测试保温杯')
    promoNameField.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    const promoSubmit = promoWorkspace.querySelector('button[type="submit"]')
    assert.ok(promoSubmit !== null, 'promo submit button is rendered')
    assert.equal(promoSubmit.disabled, false, 'promo submit enables once a product name exists')
    const generatePathsBefore = requestPaths.filter(path => path.endsWith('/generate')).length
    promoSubmit.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 120))
    const generatePathsAfter = requestPaths.filter(path => path.endsWith('/generate')).length
    assert.equal(
      generatePathsAfter - generatePathsBefore,
      1,
      `one click on promo's submit must issue one generation, not ${generatePathsAfter - generatePathsBefore}`,
    )
    // The same defect lived in the outfit form. It needs a model and clothing to
    // reach its handler, so the wire cannot be observed there without a long
    // fixture; the markup rule that caused both is checked directly instead.
    for (const file of ['OutfitWorkspace.tsx', 'PromoWorkspace.tsx']) {
      const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
      for (const tag of source.match(/<button\b[^>]*>/g) ?? []) {
        const isSubmit = /type="submit"/.test(tag)
        assert.equal(
          isSubmit && /onClick=/.test(tag),
          false,
          `${file}: a submit button must not also carry onClick — the click and the submit both run: ${tag}`,
        )
      }
    }

    // The remake workspace used to print "参考图上限 0 张" with an empty form,
    // because the capacity line showed `usable` — a number that is 0 whenever
    // nothing is picked — where a ceiling belongs. The fixture model resolves to
    // the generic branch (5), so the number is pinned here: if the line ever
    // shows anything but the model's real ceiling, this fails.
    const replicaSwitch = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent === '爆款复刻')
    assert.ok(replicaSwitch !== undefined, 'replica top-nav entry is present')
    replicaSwitch.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 90))
    const replicaWorkspace = view.querySelector('[data-replica-workspace]')
    assert.ok(replicaWorkspace !== null, 'replica workspace is rendered')
    // The bundle renames CSS-module classes (`.capacity` → `MTiGsq_capacity`), so
    // the honest block is selected by its data attribute and the line by its own
    // hook, exactly as the other workspaces are.
    const capacityBlock = replicaWorkspace.querySelector('[data-replica-capacity]')
    assert.ok(capacityBlock !== null, 'the replica capacity line is rendered')
    const emptyCapacity = capacityBlock.textContent ?? ''
    assert.equal(emptyCapacity.includes('0 张'), false, `an empty form must not advertise a ceiling of zero: ${emptyCapacity}`)
    assert.match(emptyCapacity, /5 张/, `the empty form states the model's real ceiling: ${emptyCapacity}`)
    const submitNote = [...replicaWorkspace.querySelectorAll('span')].find(node => /本次会带上|先加参考图/.test(node.textContent ?? ''))
    assert.ok(submitNote !== undefined, 'the replica submit hint is rendered')
    assert.equal(submitNote.textContent, '先加参考图；这个模型最多带 5 张。', `an empty form must not count 0 of 0 images: ${submitNote.textContent}`)
    // Uploading one reference restores the counting sentence, which is what
    // proves the empty wording above is a state and not a rewrite of the line.
    const replicaInput = replicaWorkspace.querySelector('input[type="file"][accept="image/*"]')
    assert.ok(replicaInput !== null, 'the replica reference input is rendered')
    Object.defineProperty(replicaInput, 'files', { value: [new jsdomWindow.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' })], configurable: true })
    replicaInput.dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 90))
    assert.match(capacityBlock.textContent ?? '', /1 张全部会发送/, `a picked reference states how many are sent: ${capacityBlock.textContent}`)
  } finally {
    // Drain pending React work BEFORE restoring the globals. React DOM reads
    // `window` during commit (getActiveElementDeep), so a flush that lands after
    // the jsdom globals are gone throws "window is not defined" even though
    // every assertion already passed. The plugin mounts itself through the
    // client bundle, so there is no root handle to unmount here; letting a
    // couple of macrotasks run while the window still exists is what drains it.
    await new Promise(resolve => setTimeout(resolve, 25))
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

await new Promise(resolve => upstream.close(resolve))

// ------------------------------------------------------------------ summary
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST OK')
process.exit(process.exitCode === 1 ? 1 : 0)

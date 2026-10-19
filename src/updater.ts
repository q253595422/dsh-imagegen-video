/** GitHub Release discovery and explicit, user-triggered plugin updates. */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_VERSION, type UpdateInfo } from './protocol.ts'
import { recordDiagnostic, redactDiagnosticText } from './diagnostics-store.ts'
export type { UpdateInfo } from './protocol.ts'

/** Keep this in sync with package.json for each published release. */
export const CURRENT_VERSION = PLUGIN_VERSION
export const RELEASES_URL = 'https://api.github.com/repos/q253595422/dsh-imagegen-video/releases/latest'

/** The one bundle this updater is allowed to report as installed. */
export const PACKAGE_NAME = '@q253595422/dsh-imagegen-video'

/**
 * Time budget for the release check, measured from the user's point of view:
 * the popover shows "checking" while this runs, and a slower answer is worth
 * abandoning rather than keeping the button spinning. The endpoint is one
 * unauthenticated GitHub API call, which answers in well under a second on a
 * normal link, so 10s leaves room for a slow proxy without ever feeling stuck.
 */
const CHECK_TIMEOUT_MS = 10_000
/**
 * 15 minutes, and deliberately not shorter: the apply route re-reads the check
 * to resolve the archive URL, so a very short TTL would fetch GitHub twice per
 * click; a much longer one would keep offering a version that was pulled.
 */
const CACHE_TTL_MS = 15 * 60_000

/**
 * Cap on the CLI's stderr kept for the failure message. pnpm prints a stack for
 * a store mismatch, and the tail is what matters; the cap keeps one failed
 * update from parking a megabyte in the response.
 */
const STDERR_LIMIT = 4_000
/**
 * Cap on the raw output kept while the package manager runs. pnpm prints a
 * store-mismatch stack that is long but only its tail is useful, so the buffer
 * is bounded and the failure message reports the last lines.
 */
const OUTPUT_LIMIT = 32_768
/**
 * A `pkg add` that hangs holds the popover's "updating" state forever. Ten
 * minutes is long enough for a cold pnpm store on a slow link and short enough
 * that the user still gets an answer.
 */
const UPDATE_TIMEOUT_MS = 10 * 60_000

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

/**
 * `pnpm pack` names the archive after the package, with the scope's `/` replaced
 * by `-`. Matching on it is what keeps a release's *other* version-carrying
 * archive — a source tarball, a checksum bundle, anything a maintainer attaches
 * later — from winning the ranking by alphabetical accident.
 */
const ARCHIVE_NAME = 'q253595422-dsh-imagegen-video'

/**
 * GitHub names its auto-generated source archives `<repo>-<tag>.tar.gz`, and
 * attaches them to a Release even when the maintainer uploaded nothing. They
 * are never installable: a source tarball has no build output (`lib/` is
 * produced by `pnpm build`) and `dsh plugin add` does not run `prepare` on a
 * tarball, so installing one yields a plugin that cannot load. The tag makes
 * them look "versioned" to the ranking below, so they have to be excluded by
 * name rather than outranked. (GitHub's `.zip` variant never gets this far —
 * the extension filter below only accepts `.tgz` / `.tar.gz`.)
 */
const SOURCE_ARCHIVE_NAME = /^dsh-imagegen-video-.+\.tar\.gz$/i

/**
 * Pick the release asset to install from. Only archives are considered, and
 * only over HTTPS, and never a GitHub source archive. Rank order: the package
 * archive for this version, then any archive carrying the version, then the
 * rest; ties break by name so the host never installs a different file just
 * because GitHub listed assets in a different order. Returns undefined when
 * the release carries no installable archive at all.
 */
function installableAssetUrl(assets: unknown, version: string): string | undefined {
  if (!Array.isArray(assets)) return undefined
  const candidates = assets
    .flatMap((asset) => {
      if (asset === null || typeof asset !== 'object') return []
      const record = asset as { name?: unknown; browser_download_url?: unknown }
      const name = typeof record.name === 'string' ? record.name : ''
      const url = typeof record.browser_download_url === 'string' ? record.browser_download_url : ''
      if (!/\.(?:tgz|tar\.gz)$/.test(name) || !url.startsWith('https://')) return []
      if (SOURCE_ARCHIVE_NAME.test(name)) return []
      const versioned = name.includes(version)
      const rank = versioned && name.includes(ARCHIVE_NAME) ? 0 : versioned ? 1 : 2
      return [{ rank, name, url }]
    })
    .sort((left, right) => left.rank - right.rank || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return candidates[0]?.url
}

/**
 * Only the download host GitHub serves release assets from may be installed
 * from. The URL comes from a release the host already fetched, but a redirect
 * to an arbitrary host would still turn "install the update" into "run
 * whatever the network returns", so the host is checked before spawning.
 */
export function isInstallableTarballUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.githubusercontent.com'))
}

let cached: { expiresAt: number; value: UpdateInfo } | undefined

/** Compare stable semver triples; returns positive when `left` is newer. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    if (match === null) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function normalizedReleaseVersion(tag: unknown): string | undefined {
  if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim())) return undefined
  return tag.trim().replace(/^v/, '')
}

/** Read the latest stable GitHub Release, with a short host-side cache. */
export async function checkForUpdate(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<UpdateInfo> {
  if (cached !== undefined && cached.expiresAt > now) return cached.value
  const response = await fetchFn(RELEASES_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-imagegen-update-check',
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (payload === null || typeof payload !== 'object') throw new Error('GitHub Releases returned malformed JSON')
  const release = payload as GitHubRelease
  if (release.draft === true || release.prerelease === true) throw new Error('latest GitHub Release is not stable')
  const latestVersion = normalizedReleaseVersion(release.tag_name)
  if (latestVersion === undefined) throw new Error('latest GitHub Release has an invalid version tag')
  const releaseUrl = typeof release.html_url === 'string' ? release.html_url : 'https://github.com/q253595422/dsh-imagegen-video/releases'
  const releaseNotes = typeof release.body === 'string' ? release.body.trim() : ''
  const tarballUrl = installableAssetUrl(release.assets, latestVersion)
  const value: UpdateInfo = {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, CURRENT_VERSION) > 0,
    releaseUrl,
    ...typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {},
    ...releaseNotes === '' ? {} : { releaseNotes: releaseNotes.slice(0, 20_000) },
    ...tarballUrl === undefined ? {} : { tarballUrl },
  }
  cached = { expiresAt: now + CACHE_TTL_MS, value }
  return value
}

/**
 * Profile name DSH Desktop runs under. The CLI refuses it outright
 * (`bin.js`: `profile "desktop" is managed exclusively by the Electron
 * application`), so anything that would spawn `dsh plugin --profile desktop`
 * has to take the manual route instead of pretending to update.
 */
export const DESKTOP_PROFILE = 'desktop'

/**
 * What a newer launcher can report back after installing a bundle. Every field
 * is optional: the host owns the package manager, so older launchers simply
 * omit what they cannot tell us, and the caller verifies what it can.
 */
export interface HostUpdateResult {
  /** `applied` / `restart-required` mean the bundle is on disk; anything else is not. */
  application?: string
  /** Package name the host actually installed. */
  bundle?: string
  /** Version the host reports as installed. Older launchers omit it. */
  version?: string
  error?: { code?: string; diagnostic?: string }
  packageResult?: { exitCode?: number; output?: string; logPath?: string }
}

/**
 * Launcher-owned facts the host entry can supply. Absent on every launcher that
 * predates the install hook, which is why nothing here is required: without
 * `installBundle` the updater keeps its own argv/env probing and its CLI path.
 */
export interface UpdateHostContext {
  profile?: string
  /** Absolute profile directory, used to read the installed manifest when the
   *  host result omits the version. */
  profileDir?: string
  /** The live host owns package-manager selection, locking and activation. The
   *  result is `unknown` on purpose: it arrives from the launcher, so every field
   *  is validated before it is believed. */
  installBundle?: (tarballUrl: string, options?: { saveExact?: boolean }) => Promise<unknown>
}

/** How an update can be installed for the profile this process runs under. */
export interface UpdateInstallTarget {
  profile: string
  /**
   * `host` — the launcher installs the bundle itself;
   * `host-managed` — a Desktop profile with no install hook, so only the user
   * can install it (the CLI refuses the profile);
   * `cli` — spawn `dsh plugin add`.
   */
  installMode: 'cli' | 'host' | 'host-managed'
}

/**
 * Resolve the profile that launched the current DSH process.
 *
 * The Electron host passes the profile as a bare *path* among its argv entries
 * (`…/dsh /Users/<user>/.dsh/profiles/desktop …`) and sets no `DSH_PROFILE` and
 * no `--profile` flag, so the flag-only reading below fell through to `'web'`
 * for every Desktop user. The update then ran against the wrong profile: even
 * when it succeeded, the running host kept the old plugin.
 */
export function profileFromProcess(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  host: UpdateHostContext = {},
): string {
  // The launcher's own answer beats anything inferred from this process: it
  // knows which profile it booted, and a wrong guess installs into the profile
  // the user is not running.
  const hostProfile = host.profile?.trim()
  if (hostProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(hostProfile)) return hostProfile
  const envProfile = env.DSH_PROFILE?.trim()
  if (envProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile
  const profileIndex = argv.indexOf('--profile')
  // `--profile=name` is as common as the two-token form; reading only the
  // latter silently fell through to the path scan and then to `web`.
  const inline = argv.find(entry => entry.startsWith('--profile='))
  const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : inline?.slice('--profile='.length).trim()
  if (explicit !== undefined && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit
  // `…/.dsh/profiles/<name>` — the Electron host's only description of which
  // profile it booted. Matched on the path segments rather than on a resolved
  // absolute prefix, because `DSH_HOME` moves the tree.
  const fromPath = argv
    // A trailing separator is normal here: Windows paths arrive as
    // `…\profiles\desktop\`, and matching only `/` sent every one of those
    // back to `web`.
    .map(entry => /(?:^|[/\\])profiles[/\\]([A-Za-z0-9_-]+)[/\\]?$/.exec(entry))
    .find(match => match !== null)
  if (fromPath !== null && fromPath !== undefined && fromPath[1] !== undefined) return fromPath[1]
  if (env.DSH_DESKTOP === '1' || argv.some(entry => /[/\\]dsh-desktop-host[/\\]/.test(entry))) return DESKTOP_PROFILE
  return 'web'
}

/**
 * Thrown instead of attempting an update the CLI is guaranteed to reject. It
 * carries the archive URL so the UI can hand the user a command that works.
 */
export class ManualUpdateRequiredError extends Error {
  readonly code = 'update-manual-required'
  readonly tarballUrl: string
  readonly profile: string
  constructor(profile: string, tarballUrl: string) {
    super(
      `profile "${profile}" is managed by the Electron app, so the CLI cannot update it. ` +
      'Open Settings → Plugins in DSH Desktop and install the archive from there.',
    )
    this.name = 'ManualUpdateRequiredError'
    this.profile = profile
    this.tarballUrl = tarballUrl
  }
}

/**
 * Decide how this profile can be updated.
 *
 * Host capability comes first: when the launcher exposes `installBundle` it owns
 * the package manager and the update runs through it, even on Desktop. Only a
 * Desktop profile *without* that hook falls back to `host-managed` — the CLI
 * refuses the profile outright, so the user has to install the archive by hand.
 * Everything else keeps the historical `dsh plugin add` path.
 */
export function updateInstallTarget(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  host: UpdateHostContext = {},
): UpdateInstallTarget {
  const profile = profileFromProcess(argv, env, host)
  if (typeof host.installBundle === 'function') return { profile, installMode: 'host' }
  // The launcher's marker is as authoritative as the profile name: a Desktop
  // host that reports `DSH_DESKTOP=1` still refuses CLI writes even when its
  // argv names no profile.
  const desktop = profile.toLowerCase() === DESKTOP_PROFILE || env.DSH_DESKTOP === '1'
  return { profile, installMode: desktop ? 'host-managed' : 'cli' }
}

/**
 * Run the same official command documented for plugin installation, but point
 * it at this plugin's release archive.
 *
 * There is deliberately no `PACKAGE_NAME@version` spec here: this plugin ships as
 * a GitHub Release asset and is not on npm, so a registry spec would resolve to
 * nothing. The route has just fetched the latest release, so resolving the URL
 * through `checkForUpdate` is a cache hit, not a second request.
 *
 * `host` is the launcher's install hook when it has one; without it the update
 * either spawns the CLI or refuses a Desktop profile with
 * `ManualUpdateRequiredError`.
 */
export async function installUpdate(
  version: string,
  spawnFn: typeof spawn = spawn,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  host: UpdateHostContext = {},
): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('invalid update version')
  }
  const release = await checkForUpdate(fetchFn)
  const tarballUrl = release.tarballUrl
  if (tarballUrl === undefined) {
    throw new Error(`release ${release.latestVersion} publishes no installable archive`)
  }
  if (!isInstallableTarballUrl(tarballUrl)) {
    throw new Error(`release ${release.latestVersion} points at an untrusted download host`)
  }
  const { profile, installMode } = updateInstallTarget(argv, env, host)
  if (installMode === 'host') {
    await installThroughHost(version, profile, tarballUrl, host)
    return
  }
  // DSH Desktop's profile is locked by the CLI, with exit code 1 and one line on
  // stderr. Spawning it anyway produced a bare "update failed" with no cause —
  // the exact dead end upstream issue #41 describes. Fail here instead, with a
  // routable reason and the URL the user can install by hand.
  if (installMode === 'host-managed') {
    throw new ManualUpdateRequiredError(profile, tarballUrl)
  }
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const args = ['plugin', '--profile', profile, 'add', tarballUrl]
  const displayCommand = `${command} ${args.join(' ')}`
  const started = Date.now()
  // One place builds both the diagnostic record and the thrown message: the
  // panel shows the same text the log keeps, so a user copy-pasting a failure
  // into an issue never pastes a credential with it.
  const failure = (message: string): Error => {
    const safe = updateDiagnosticText(
      `profile: ${profile}\ncommand: ${displayCommand}\n${message}`,
    )
    recordDiagnostic({
      phase: 'config',
      channel: '',
      model: PACKAGE_NAME,
      mode: 'update',
      url: command,
      method: 'SPAWN',
      message: safe,
      requestExcerpt: displayCommand,
      durationMs: Date.now() - started,
    })
    return new Error(safe)
  }
  let child: ChildProcess
  try {
    child = spawnFn(command, args, {
      shell: process.platform === 'win32',
      // Both streams are read. pnpm explains *why* it refused on stderr (locked
      // profile, pnpm store mismatch, unreachable registry) and prints a store
      // hint on stdout; discarding either left the user with an exit code.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }) as ChildProcess
  } catch (caught) {
    // A spawn that throws synchronously (missing binary, refused execution)
    // used to escape as a raw exception with no profile or cause attached.
    return Promise.reject(failure(caught instanceof Error ? caught.message : String(caught)))
  }
  let output = ''
  let settled = false
  let timedOut = false
  const append = (chunk: unknown): void => {
    output = (output + (typeof chunk === 'string' ? chunk : String(chunk))).slice(-OUTPUT_LIMIT)
  }
  child.stdout?.setEncoding?.('utf8')
  child.stderr?.setEncoding?.('utf8')
  child.stdout?.on?.('data', append)
  child.stderr?.on?.('data', append)
  return new Promise((resolve, reject) => {
    const finish = (message?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (message === undefined) { resolve(); return }
      // The store mismatch has a specific remedy, and without it the message is
      // an opaque pnpm stack. Everything else reports its own tail.
      const hint = /ERR_PNPM_UNEXPECTED_STORE/.test(output)
        ? '\nThe pnpm store does not match this profile. Use the DSH installation that created it, or the same pnpm version/store recorded in node_modules/.modules.yaml; do not switch stores automatically.'
        : ''
      const tail = output.trim().split(/\r?\n/).slice(-50).join('\n').slice(-STDERR_LIMIT)
      reject(failure(`${message}${hint}${tail === '' ? '' : `\n${tail}`}`))
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* keep the timeout diagnostic */ }
      finish(`plugin update timed out after ${Math.round(UPDATE_TIMEOUT_MS / 60_000)} minutes`)
    }, UPDATE_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error: Error) => finish(error.message))
    // `close`, not `exit`: exit can arrive before the piped streams drain, and
    // the drained stderr is the whole point of reading them.
    child.once('close', (code: number | null, signal: string | null) => {
      if (timedOut) return
      finish(
        code === 0
          ? undefined
          : signal === null
            ? `plugin update exited with code ${code ?? 'unknown'}`
            : `plugin update terminated by ${signal}`,
      )
    })
  })
}

/**
 * Bounded, credential-redacted package-manager output.
 *
 * `redactDiagnosticText` already masks `sk-…` keys, bearer tokens and URL
 * passwords, but not the `_authToken=<value>` line npm/pnpm writes into their
 * own config on failure. That value is exactly the kind of thing a user pastes
 * into an issue, so it is masked here before the shared redaction runs.
 */
function updateDiagnosticText(value: string, limit = STDERR_LIMIT): string {
  return redactDiagnosticText(
    value
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
      .replace(/((?:_authToken|npm_token|password)\s*[=:]\s*)[^\s]+/gi, '$1<redacted>'),
    limit,
  )
}

/**
 * Install the release archive through the launcher's own package manager.
 *
 * The host reports what it did, but nothing here trusts that report: an update
 * that silently installed a different bundle or version would leave the running
 * plugin claiming to be current while the disk says otherwise, so every field
 * that can be checked is checked, and an unverifiable result is a failure rather
 * than a success. Older launchers omit `version`; their installed manifest is
 * read instead, and when neither is available the update fails.
 */
async function installThroughHost(
  version: string,
  profile: string,
  tarballUrl: string,
  host: UpdateHostContext,
): Promise<void> {
  const install = host.installBundle
  if (install === undefined) throw new Error('DSH does not provide a plugin install hook')
  const fail = (message: string): Error => {
    // The launcher hands back the package manager's own output, which can carry
    // `_authToken=` lines just like the CLI path — same masking, same cap.
    const tail = updateDiagnosticText(message, STDERR_LIMIT)
    return new Error(`DSH could not install the update for profile "${profile}": ${tail}`)
  }
  let result: HostUpdateResult
  try {
    const raw: unknown = await install(tarballUrl, { saveExact: true })
    if (raw === null || typeof raw !== 'object') throw new Error('DSH returned an invalid installation result')
    result = raw as HostUpdateResult
  } catch (caught) {
    throw fail(caught instanceof Error ? caught.message : String(caught))
  }
  const output = typeof result.packageResult?.output === 'string' ? result.packageResult.output.trim() : ''
  const detail = [
    result.error?.code === undefined ? '' : `(${result.error.code})`,
    result.error?.diagnostic ?? '',
    output === '' ? '' : output.split('\n').slice(-3).join(' | '),
    result.packageResult?.logPath === undefined ? '' : `diagnostics: ${result.packageResult.logPath}`,
  ].filter(part => part !== '').join(' ')
  if (result.error !== undefined) throw fail(`DSH reported ${result.error.code ?? 'an error'}${detail === '' ? '' : `: ${detail}`}`)
  if (result.application !== 'applied' && result.application !== 'restart-required') {
    throw fail(`DSH reported application "${result.application ?? 'unknown'}"${detail === '' ? '' : `: ${detail}`}`)
  }
  const exitCode = result.packageResult?.exitCode
  if (exitCode !== undefined && exitCode !== 0) throw fail(`the package manager exited with code ${exitCode}${detail === '' ? '' : `: ${detail}`}`)
  if (result.bundle !== undefined && result.bundle !== PACKAGE_NAME) {
    throw fail(`DSH installed an unexpected bundle "${result.bundle}"`)
  }
  let installedVersion = typeof result.version === 'string' ? result.version : undefined
  if (installedVersion === undefined && host.profileDir !== undefined) {
    installedVersion = await installedManifestVersion(host.profileDir)
  }
  if (installedVersion !== version) {
    throw fail(`DSH installed version ${installedVersion ?? 'unknown'}; expected ${version}`)
  }
}

/** Read the version this plugin's own manifest records in a profile, if any. */
async function installedManifestVersion(profileDir: string): Promise<string | undefined> {
  const manifestPath = join(profileDir, 'node_modules', '@q253595422', 'dsh-imagegen-video', 'package.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') return undefined
    return manifest.version
  } catch {
    // A missing or unreadable manifest is "no evidence", not a crash: the caller
    // turns it into a version-mismatch failure.
    return undefined
  }
}

/** Test helper: clear the host-side Release cache. */
export function clearUpdateCache(): void {
  cached = undefined
}

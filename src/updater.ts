/** GitHub Release discovery and explicit, user-triggered plugin updates. */

import { spawn, type ChildProcess } from 'node:child_process'
import { PLUGIN_VERSION } from './protocol.ts'

/** Keep this in sync with package.json for each published release. */
export const CURRENT_VERSION = PLUGIN_VERSION
export const RELEASES_URL = 'https://api.github.com/repos/q253595422/dsh-imagegen-video/releases/latest'

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

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
  /** Markdown release body shown in the update popover. */
  releaseNotes?: string
  /**
   * Download URL of the release's installable archive. This fork ships as a
   * GitHub Release asset, not as an npm package, so installing an update means
   * handing `dsh plugin add` this URL — there is no registry spec to resolve.
   */
  tarballUrl?: string
}

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
 * Resolve the profile that launched the current DSH process.
 *
 * The Electron host passes the profile as a bare *path* among its argv entries
 * (`…/dsh /Users/<user>/.dsh/profiles/desktop …`) and sets no `DSH_PROFILE` and
 * no `--profile` flag, so the flag-only reading below fell through to `'web'`
 * for every Desktop user. The update then ran against the wrong profile: even
 * when it succeeded, the running host kept the old plugin.
 */
export function profileFromProcess(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const envProfile = env.DSH_PROFILE?.trim()
  if (envProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile
  const profileIndex = argv.indexOf('--profile')
  const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : undefined
  if (explicit !== undefined && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit
  // `…/.dsh/profiles/<name>` — the Electron host's only description of which
  // profile it booted. Matched on the path segments rather than on a resolved
  // absolute prefix, because `DSH_HOME` moves the tree.
  const fromPath = argv
    .map(entry => /(?:^|[/\\])profiles[/\\]([A-Za-z0-9_-]+)\/?$/.exec(entry))
    .find(match => match !== null)
  if (fromPath !== null && fromPath !== undefined && fromPath[1] !== undefined) return fromPath[1]
  if (argv.includes('web')) return 'web'
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
 * Run the same official command documented for plugin installation, but point
 * it at this fork's release archive.
 *
 * There is deliberately no `PACKAGE_NAME@version` spec here: this fork ships as
 * a GitHub Release asset and is not on npm, so a registry spec would resolve to
 * nothing. The route has just fetched the latest release, so resolving the URL
 * through `checkForUpdate` is a cache hit, not a second request.
 */
export async function installUpdate(
  version: string,
  spawnFn: typeof spawn = spawn,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
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
  const profile = profileFromProcess(argv, env)
  // DSH Desktop's profile is locked by the CLI, with exit code 1 and one line on
  // stderr. Spawning it anyway produced a bare "update failed" with no cause —
  // the exact dead end upstream issue #41 describes. Fail here instead, with a
  // routable reason and the URL the user can install by hand.
  if (profile.toLowerCase() === DESKTOP_PROFILE) {
    throw new ManualUpdateRequiredError(profile, tarballUrl)
  }
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const child = spawnFn(command, ['plugin', '--profile', profile, 'add', tarballUrl], {
    shell: process.platform === 'win32',
    // stderr has to be read: the CLI explains *why* it refused (locked profile,
    // pnpm store mismatch, unreachable registry) and discarding it left the user
    // with an exit code and nothing to act on.
    stdio: ['ignore', 'ignore', 'pipe'],
  }) as ChildProcess
  let stderr = ''
  const appendStderr = (chunk: unknown): void => {
    if (stderr.length >= STDERR_LIMIT) return
    stderr += typeof chunk === 'string' ? chunk : String(chunk)
  }
  child.stderr?.setEncoding?.('utf8')
  child.stderr?.on?.('data', appendStderr)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) { resolve(); return }
      const reason = stderr.trim().split('\n').filter(line => line.trim() !== '').slice(-3).join(' | ')
      const base = signal === null ? `plugin update exited with code ${code ?? 'unknown'}` : `plugin update terminated by ${signal}`
      reject(new Error(reason === '' ? base : `${base}: ${reason}`))
    })
  })
}

/** Test helper: clear the host-side Release cache. */
export function clearUpdateCache(): void {
  cached = undefined
}

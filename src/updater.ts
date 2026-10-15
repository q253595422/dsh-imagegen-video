/** GitHub Release discovery and explicit, user-triggered plugin updates. */

import { spawn, type ChildProcess } from 'node:child_process'
import { PLUGIN_VERSION } from './protocol.ts'

/** Keep this in sync with package.json for each published release. */
export const CURRENT_VERSION = PLUGIN_VERSION
export const RELEASES_URL = 'https://api.github.com/repos/q253595422/dsh-imagegen-video/releases/latest'

const CHECK_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 15 * 60_000

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

/** Resolve the profile that launched the current DSH process. */
export function profileFromProcess(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const envProfile = env.DSH_PROFILE?.trim()
  if (envProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile
  const profileIndex = argv.indexOf('--profile')
  const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : undefined
  if (explicit !== undefined && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit
  if (argv.includes('web')) return 'web'
  return 'web'
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
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const child = spawnFn(command, ['plugin', '--profile', profile, 'add', tarballUrl], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  }) as ChildProcess
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal === null ? `plugin update exited with code ${code ?? 'unknown'}` : `plugin update terminated by ${signal}`))
    })
  })
}

/** Test helper: clear the host-side Release cache. */
export function clearUpdateCache(): void {
  cached = undefined
}

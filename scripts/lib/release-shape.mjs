/**
 * The shape a release has to have before it is packed, shared by every guard
 * that is in a position to notice it is wrong.
 *
 * WHY this is a module and not two copies of an `existsSync`: the check exists
 * because v1.8.0 shipped without `docs/releases/v1.8.0.md` and `release.yml`
 * fell back to GitHub's one-line compare link, so the page for a version with
 * four user-visible features described none of them -- and the tag froze that
 * page the moment it was created. The same omission stopped the 1.23.0 release
 * outright: `Verify the archive contents` failed, the five steps after it were
 * skipped, and the registry stayed on 1.22.2 until 1.23.1 was cut with notes.
 *
 * The reason it kept happening is timing, not phrasing. The assertion lived in
 * `verify-pack.mjs`, which applies it while packing, and packing is only reached
 * from `ci.yml`'s last step -- several minutes of install, build and two dozen
 * suites after a push, on GitHub's machines. `pnpm test` never touches it. The
 * local suite was green for both of those releases right up to the moment the
 * remote run went red, and the failure then reads as "the release workflow is
 * broken" rather than "one file is missing".
 *
 * So the assertion is defined here, once, and asked from both sides:
 *
 *   - `verify-tracked.mjs`, first in `pnpm test`: answered in a few seconds,
 *     before the build, on the machine where the bump was typed.
 *   - `verify-pack.mjs`, before anything is packed: still the release gate, and
 *     still the one the negative verification mutates.
 *
 * Two call sites, one implementation. A second copy of the message would drift
 * from this one the first time either side was reworded.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Repository-relative path of the notes sheet a version must ship. */
export function releaseNotesEntry (version) {
  return `docs/releases/v${version}.md`
}

/**
 * Lines explaining why a version cannot ship, or `null` when it can.
 *
 * Returned rather than printed so each caller keeps its own failure style: the
 * two do not share an error helper, and `verify-pack.mjs` runs inside the
 * negative verification where an unexpected exit shape reads as a harness bug.
 *
 * @param {string} root - repository root.
 * @param {string} version - the version `package.json` declares.
 * @returns {string[] | null}
 */
export function missingReleaseNotes (root, version) {
  const entry = releaseNotesEntry(version)
  if (existsSync(join(root, entry))) return null
  return [
    '',
    `FAIL: version ${version} has no release notes (${entry}).`,
    'release.yml would publish this version with GitHub\'s one-line compare link',
    'as its entire body, and in CI that missing file fails the packaging step',
    'outright -- every step after it is skipped and the version never reaches',
    'the registry. Write the notes first: they are the only place the',
    'user-visible changes of a version are explained.',
  ]
}

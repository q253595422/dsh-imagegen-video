/**
 * Package root entry point -- what the Cordis loader imports for `id: imagegen`.
 *
 * WHY this file exists instead of pointing `main` at `lib/index.js` directly:
 * `lib/` is build output and is gitignored, so a source-only tree (a fresh
 * clone before `pnpm build`, or anything that inspects the repository without
 * building it) has no file for the manifest to point at. Third-party
 * registries read the manifest and check that the declared runtime entry
 * actually exports `apply(ctx)`; with `main` aimed at a file that is not in
 * the repository, that check cannot be satisfied no matter what the source
 * says, and the plugin is recorded as having no runtime at all.
 *
 * So the committed entry is this two-line re-export, `main`/`exports["."]`
 * point at it, and `files` ships it next to `lib/`. The archive therefore has
 * BOTH -- the stable committed declaration and the built code behind it -- and
 * `scripts/verify-pack.mjs` checks that whatever the manifest declares is
 * really inside the tarball.
 *
 * Keep the explicit `apply` line: the star export alone re-exports it, but a
 * named export makes the plugin contract (`apply` / `name` / `inject`) visible
 * from the file a reader or a tool actually opens.
 */
export * from './lib/index.js'
export { apply } from './lib/index.js'

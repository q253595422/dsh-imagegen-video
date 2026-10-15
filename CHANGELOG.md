# Changelog

This project is a fork of [dsh-imagegen](https://github.com/dickpy/dsh-imagegen).
The fork starts from the upstream **v1.6.8** release source, which is preserved as
the first commit (`baseline: upstream @dickpy/dsh-imagegen v1.6.8 source`). Every
commit after that is this fork's own work.

The list below describes the fork's delta against that baseline. Commit-level
detail is in `git log 9305f9f..HEAD`.

## What the fork adds

### Video generation (the original motivation for the fork)

Upstream generates images only. The fork adds a complete video pipeline:

- **Contract layer** — video types and the `VIDEO_API` route family, a video
  model catalog with per-family request shaping (`src/video-engine.ts`,
  `src/video-model-catalog.ts`).
- **Host side** — an async submit → poll → download engine, a bounded video
  history store with Range-capable clip streaming, a serial task queue, and
  per-channel video-model catalogs in settings.
- **Studio UI** — a video tab next to the image studio: text-to-video,
  image-to-video, keyframe (first/last frame) and multi-reference modes, model
  picker, polling with progress, an inline player and clip history.
- **Agent tools** — host-side video tools (generate, from-image, poll, cancel)
  so an Agent can drive the pipeline too.
- **Conversation** — a finished clip can be attached to the conversation draft
  through the existing file-draft bridge.

### Infinite canvas: video nodes

- Video nodes render inline with generating/error states and a footer.
- A canvas video run reports "rendering", not "failed", while it is in flight.
- Node toolbar and context menu: clip preview, download, frame grab, and
  favorite to the asset library.
- A finished clip can be added to the canvas as a reference node (the bytes are
  not copied into the canvas asset store).
- Video nodes carry the same controls as image nodes: a per-node video model
  picker and "regenerate with the current model".

### Infinite canvas: clip stitching (compose)

Select two or more video nodes and stitch them into one clip with the local
`ffmpeg`, in canvas reading order (top-to-bottom, left-to-right).

- **Ordering** — `src/clip-order.ts` is a shared pure module: the browser draws
  the ①②③ badges and the host builds the concat list from the same function, so
  what the user confirms is what gets encoded. It went through nine revisions;
  each earlier revision was certified green by the suites that existed at the
  time. The criteria and the known suite blind spots are documented in
  `docs/compose-contract.md`.
- **Compose is a canvas skill run**, not a new video mode and not a new route:
  `compose.videos` has `tier: 'local'` (a local subprocess — no model, no agent,
  no network). Stitched clips land in the video history, so they appear in the
  sidebar and can be favorited into the asset library.
- Clips are read from **both** stores (video history and gallery favorites).
  A clip that cannot be read fails the whole run rather than being silently
  skipped, so five selected clips never become a three-clip output.

### Asset library and history unification

- Clip history is merged into the image history sidebar instead of living in a
  separate list.
- Favorited clips render in the asset library with a "video" badge, a play
  overlay, download, and a full-screen viewer.
- The sidebar refreshes the clip list when a render finishes, so a new row
  appears without a page reload.

### Fixes to inherited behaviour

- **The update check no longer points at upstream.** `src/updater.ts` carried
  `PACKAGE_NAME = '@dickpy/dsh-imagegen'` and upstream's GitHub Releases API URL,
  so this fork's "check for updates" would have offered upstream's release notes
  and installed upstream's package over itself. Both now point at this
  repository. (Same class of problem as the package rename below.)
- The video studio composer was capped at 420px while an empty column took the
  remaining width; it now uses the full panel width (guarded by
  `scripts/verify-video-layout.mjs`).
- The shared-chunk filename is pinned so reinstalling built artifacts is a plain
  overwrite instead of leaving a stale hashed chunk behind.
- Polling uses the resource `id`, because at least one upstream returns both
  `id` and `task_id` in a flat body.
- `scripts/verify-frame-grab.mjs` no longer hardcodes one machine's ffmpeg and
  Chrome paths (and a fixed CDP port); it discovers both, and skips loudly if
  either is missing.

### This repository's identity

The fork publishes under its own name so it cannot be confused with, or
mistaken for, upstream:

| Where | Value |
| --- | --- |
| npm package | `@q253595422/dsh-imagegen-video` |
| plugin id (stamped by `tsdown.config.ts` into the `__ModuleLoader__` handoff) | `@q253595422/dsh-imagegen-video` |
| `cordis.patch.yml` row `name` | `@q253595422/dsh-imagegen-video` |
| update check (`src/updater.ts`) | this repository |

The **runtime identity is deliberately left alone**: the `/api/dsh-imagegen/*`
route family, the `dsh-imagegen` settings namespace, the `~/.dsh/dsh-imagegen/`
data root and the `dsh-imagegen:*` client events/storage keys all keep their
inherited names. Renaming them would orphan the settings and data of anyone
switching between the two installs, and the route prefix is upstream's design,
not this fork's.

### Test infrastructure

Upstream ships one smoke suite. The fork adds offline suites that run without
network access or paid upstream calls, plus a guard for each defect found:

| Suite | Covers |
| --- | --- |
| `scripts/smoke-video.mjs` | video studio: modes, catalog, polling, history |
| `scripts/smoke-canvas-video.mjs` | canvas video nodes, ordering badges, compose entry points, video-node controls |
| `scripts/smoke-video-picker.mjs` | the in-canvas video picker (three tabs, upload, empty/error states) |
| `scripts/smoke-compose.mjs` | stitching end-to-end against a fake composer, plus one real-`ffmpeg` case |
| `scripts/verify-b-defect.mjs` | clip resolution against both stores, with real files on disk |
| `scripts/verify-video-layout.mjs` | real-browser check that the composer fills the panel |
| `scripts/verify-frame-grab.mjs` | real-browser proof of the frame-grab path (seek + capture) |
| `scripts/with-lock.sh` | serializes build/test runs across a shared working tree |

Browser-dependent suites **skip loudly and exit 0** when the browser or
`ffmpeg` is missing, so a contributor without those tools gets a clear "not
verified" instead of a false failure.

## Configuration notes for this fork

- The `@q253595422/dsh-imagegen-video` package **cannot be installed alongside
  upstream `@dickpy/dsh-imagegen`**: both register the same
  `/api/dsh-imagegen/*` route family and both inject the same UI panel. The
  route prefix is inherited from upstream, not introduced here.
- Data (history, gallery, canvases, settings) lives under
  `~/.dsh/dsh-imagegen/` and keeps the inherited name, so it is *shared* with an
  upstream install. Back it up before switching between the two.

## Not in this fork

- No paid upstream verification is performed by the test suites; all upstream
  interactions are replayed from fixtures.
- The fork does not publish to npm under its own scope yet.

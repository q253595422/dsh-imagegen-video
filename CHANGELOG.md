# Changelog

This project is a fork of [dsh-imagegen](https://github.com/dickpy/dsh-imagegen).
The fork starts from the upstream **v1.6.8** release source, which is preserved as
the first commit (`baseline: upstream @dickpy/dsh-imagegen v1.6.8 source`). Every
commit after that is this fork's own work.

The list below describes the fork's delta against that baseline. Commit-level
detail is in `git log 9305f9f..HEAD`.

## Releases

### 1.7.5 — every UI module reviewed, and a failed call that can be explained

Two things: a full pass over the plugin's UI, driven by real defects rather than
taste (the theme no longer leaks into component internals, and the layer order is
written down in one place), and a failed call that can actually be explained —
including on the video chain, which upstream's version of that work did not cover.

- **The nav follows the host theme at runtime.** `GooeyNav` had its four colors
  baked in as literals and detected the surface only once, at mount. Switching
  light/dark while it was on screen left it painted for the old surface and
  unreadable against the new one. The palette now derives from the `--dsw-alias-*`
  tokens, and a new `surface-theme.ts` subscription re-derives it on the host
  attribute (including DSH's `data-ds-dark-theme`), on the OS preference, and on
  re-parenting. **`--dsw-alias-brand-primary` is a neutral inverse, not an
  accent** (near-white on light, near-black on dark) — it is used as one, and
  the annotation marker deliberately does not.
- **The annotation marker is one token, read by both sides.** The on-screen boxes
  were colored from CSS while the boxes burned into the image by Canvas2D were a
  `#ff2d55` literal, so the two could drift. Both now read
  `--canvas-annotation`. Because that token is declared on the canvas root
  class — not on `documentElement` — `themeColor()` takes an origin element and
  the caller passes the canvas root; reading it from the document root returns
  empty and silently falls back to the literal again.
- **One stacking scale, and it does not renumber what already worked.** Every
  z-index literal is gone from the module stylesheets in favor of a documented
  scale in `panel.module.css`. The numbers are the values the layers already
  had; only layers that genuinely *shared* a number were moved, and only as far
  as the existing comparisons required (1000 → 1000/1005/1010, 130 → 130/131/132,
  60 → 60/61/62, 70 → 70/72, 20 → 20/21). Those ties were real: the winner was
  decided by document order, so a harmless refactor could re-stack the UI. The
  guard is threefold — the doc table must match the declarations, 26 required
  orderings must hold, and the three rungs that interleave with the host shell
  are pinned by value — plus a real-browser check that renders two of the former
  ties in *reversed* order and requires the same winner.
- **Overlays no longer clear the canvas selection.** Every overlay (composer,
  menus, dialogs) is a sibling of the viewport, so a pointerdown on one never
  reached the viewport handler. This is now asserted structurally rather than by
  a guard that turned out to be dead code.
- **Touch pinch zooms the canvas.** Two touch pointers moving apart scale the
  view, the way a trackpad already did.
- **Keyboard fixes.** Space on a focused dock button activates the button again
  instead of being swallowed by the pan handler; Escape closes the in-canvas
  video preview, the skill menu, the polish dialog and the picker; a node's
  hidden hover toolbar leaves the tab order and is revealed by focus, so Tab no
  longer lands on invisible controls (including delete); every `role="tablist"`
  wired the shared roving-tabIndex and arrow-key contract.
- **Failures stop masquerading as empty lists.** History, gallery and template
  favorites showed "nothing here yet" when the read had actually failed. They
  now show the failure and a retry, and a template favorite whose state could
  not be read shows an unknown marker instead of an unstarred star.

#### The record of a failed call, and the video chain made equal to it

Upstream's diagnostics work (#38) is part of this release. Their history and ours
share no ancestor — this fork's baseline is a squash of v1.6.8 — so `git merge`
is refused outright and the work landed as a file-level port rather than a merge.
Attribution for their code is in [NOTICE](./NOTICE). The version line here is this
repository's own and does not follow theirs.

- **Diagnostics: every failed upstream attempt is now on the record.** A new
  in-memory ring buffer (200 entries, cleared on restart, never written to disk)
  keeps the *final* request URL, the HTTP status, the network code
  (`ECONNREFUSED` / `ENOTFOUND` / `CERT_*`), the duration, the byte counts and the
  raw upstream body. Credentials are redacted before storage — `Bearer` tokens,
  keys in a query string and inline base64 all become placeholders — so the
  copied report is safe to paste into a public issue. The panel offers copy-all
  and states the failure instead of pretending there is nothing to show.
- **A failed task explains itself in the task list**, instead of the word
  "failed": the message now carries the request URL and the network code, which
  is what settles the usual "the request never reached the gateway" report.
- **The studio no longer hides behind the plugin-market page.** Both live in the
  same `main` slot, so switching from the conversation to the studio left two
  panels in the column. The keyed slot now yields for non-conversation content.
- **The video chain records into the same buffer.** Upstream's #38 covered
  images only, so a user whose images worked and whose videos did not had
  nowhere to look — and `DiagnosticPhase` could not even name the video legs.
  Video is submit → poll → download rather than one synchronous call, so each leg
  is its own phase (`video-submit` / `video-poll` / `video-download`), and
  "the render never started" is now distinguishable from "the status endpoint
  stopped answering". Reference frames are recorded as a count, never as the
  megabytes of base64 they are; a transient blip the poll loop retries is
  deliberately not recorded, while an exhausted retry budget is, with the status
  the endpoint kept answering with. The entry point rides the always-rendered
  toolbar in both studios, because a submit that never reached the provider
  leaves no task row to open it from.

### 1.7.4 — timing bugs the user actually hits

- **One artifact the host refuses no longer loses the whole skill run.** A
  canvas skill hands each produced file to the host, which hard-refuses some
  extensions (`.svg`, `.html`, …) and anything over 50MB. One refusal used to
  bubble out of the whole run, discarding the artifacts that had already been
  published to the canvas; the user saw one error and nothing else. The refused
  file is now skipped, the rest land, and a localized warning names it.
- **A failing read stream no longer takes the host process down.** A clip is
  served by piping the file to the response. `pipe` forwards errors to the
  destination, never to the source, so an unhandled `error` on the read stream
  terminated the whole web process. The source now has its own listener and
  ends one response instead.
- **Switching canvases neither drops a pending edit nor resurrects the old
  one.** Autosave is debounced, so a rename followed by a canvas switch could
  silently lose the edit, or let the old canvas's late save answer land on
  screen and replace the new canvas. Writes now carry a sequence number, an
  answer behind the newest edit is discarded, the pending snapshot is flushed
  before the canvas is replaced, and deleting a canvas marks it reconciled so
  the follow-up switch cannot write it back.
- **The video studio's submit/cancel updates the list immediately.** The task
  list is polled once by the parent (so the tab and the canvas share one view),
  but the tab's own refresh returned early in controlled mode, leaving a new or
  cancelled row invisible for a full 5s poll cycle. The request now travels up
  to that single poller instead of starting a second loop.

### 1.7.3 — small correctness fixes around the edges

- **A `~` in the data-folder setting now means the home directory.** The value
  is typed by hand into the settings form, where `~/my-images` is the natural
  thing to write, and `path.resolve` does not expand it — so the host created a
  directory literally named `~` under its working directory and stored
  everything there while the user looked in their home folder. A `~user` form
  is deliberately left alone.
- **The chat-resize handle's `aria-label` follows the interface language.** It
  is created once and lives outside the React tree, so nothing re-rendered it
  on a DSH language switch and it kept the language it was built in. It now
  subscribes, and releases the subscription when the element is replaced or the
  panel unmounts.

### 1.7.2 — video nodes could not be saved at all

**A canvas holding a video node could not be persisted.** The host's canvas
node guard accepted only `image` / `text` / `file` / `config` while
`CanvasNodeType` also declares `video`, so `coerceDocument` returned undefined
and `save()` answered `malformed canvas document`. Video nodes on the canvas
are this fork's headline feature, which made the feature unusable end to end:
place a clip, and the canvas stopped saving.

No suite caught it because the canvas-video suite answers `/canvas/save` with a
stub that records the payload, so the real guard never ran against a video
node. `smoke.mjs` now round-trips a video node through the real route and the
real store, in all three states a video node can be in (finished clip,
rendering, failed). Removing `video` from the guard makes that check fail with
the exact error a user saw.

Also in this release:

- The full-screen clip preview marks the node when its clip will not load,
  instead of being the same dead player one click deeper.
- The dead-clip marker is now cleared by reload, single delete, bulk delete and
  regenerate. Regenerating used to leave a node claiming its clip was gone even
  after a fresh clip landed; bulk delete left marks for an undo to restore.
- The template favorites memo and the template list memo are keyed by the data
  root they were read from. Both were module-level and outlived a repointed
  root, so changing `localStoragePath` could read the old root and write back to
  the new one.

### 1.7.1 — the two fixes 1.7.0 shipped without, plus release hygiene

v1.7.0's release asset was uploaded before two fixes landed, and because the
version constant was not bumped the in-app updater could never offer them
(`updateAvailable` compares strictly greater). This release carries them, and
closes the class of gaps that let a release go out with no automated check.

**Fixes that were stranded on `main` after v1.7.0 was published**

- **A transient status blip no longer fails a video render.** Polling retries
  transient failures (5xx, 429, transport errors) within a bounded budget
  instead of marking a multi-minute render failed, and gives up with the
  provider's own message when the budget runs out.
- **An unsatisfiable `Range` is answered with 416**, not a silent 200 carrying
  the whole clip.

**Resource bounds (host side)**

- The image and video task queues keep only the newest terminal tasks (200 and
  100) alongside every live one. A finished image task pins its base64 result,
  so the previous unbounded array held every image generated in the session.
- A heavy skill run's working directory is removed once the run reaches a
  terminal state. Its outputs are already ingested into the canvas asset store
  by then, which is what makes the deletion safe.
- Deleting a canvas now sweeps assets nothing references any more. The sweep is
  deliberately conservative — a page that fails to parse aborts it, so a bug
  here can leave garbage but cannot delete a file in use. Both reference
  sources are collected: `metadata.asset` and `backgroundImage`.

**One data root**

- The "open data folder" route, the template snapshot cache and the template
  favorites all used to hardcode `~/.dsh/dsh-imagegen` while the history,
  gallery, video and canvas stores honoured `DSH_HOME` and a configured
  `localStoragePath`. With either set, the button opened the wrong directory
  and the template data lived in a second tree. All four now resolve through
  `imageDataRoot()`, lazily, so a path set after import is still honoured.

**Network calls have ceilings**

- Prompt enhancement and the `/models` discovery walk are bounded (60s/30s),
  and the vision call behind layer split is bounded (120s). The caller's own
  cancellation is combined with the timeout, not replaced by it.

**Canvas UI**

- A video node whose clip is gone (history cleared, or evicted by the 30-entry
  cap) now says so, with a retry and a remove control, instead of rendering a
  dead player with no explanation.
- The canvas revision-conflict self-heal branches on the stable
  `canvas-conflict` code instead of matching a translated message string.
- Hardcoded Chinese copy in the tool view, the panel resize handle, the video
  panel and the canvas moved into the locale dictionaries, so the English and
  Russian UIs no longer show Chinese.

**Release and verification**

- `package.json` `files` no longer ships `docs/videos/` (37 MiB of demo
  recordings no shipped document references) or the rest of `src/`; the
  bundled prompt snapshots stay, because the runtime reads them relative to
  `lib/`.
- **CI** (`.github/workflows/ci.yml`): typecheck, build, the full suite with
  ffmpeg installed, and an inspection of the packed archive that fails if the
  tarball is missing the runtime files or has the demo recordings back in it.
- `scripts/verify-frame-grab.mjs` is part of `pnpm test` now, and uses a fresh
  browser profile per run — a fixed path made its second run fail with
  "CDP did not come up" and no hint why.
- `scripts/verify-video-layout.mjs` validates its fixture's class names against
  the real component and stylesheet, so a renamed class fails the guard instead
  of silently measuring markup the panel no longer renders.
- `scripts/smoke.mjs` gained a per-check timeout, and its data-folder assertion
  now checks the route follows `DSH_HOME` rather than the literal `.dsh` path —
  the old assertion passed precisely because the route was hardcoded.
- `scripts/smoke-compose.mjs` reports how many checks were skipped, so a
  missing ffmpeg is visible instead of looking like a clean run.
- The update installer refuses GitHub's auto-generated source archives
  (`<repo>-<tag>.tar.gz`), which carry no build output and would install a
  plugin that cannot load.

**Docs and licensing**

- `THIRD_PARTY_NOTICES.md` now credits every upstream the bundled snapshots
  actually come from — including `freestylefly/awesome-gpt-image-2` (MIT, the
  largest single source), which was missing entirely — and states which
  snapshots pin a commit versus which reference a moving branch. It also flags
  `songguoxs/gpt4o-image-prompts`, which declares **no licence** upstream and is
  the source of six on-demand image URLs, as an open question rather than
  quietly listing it as fine.
- The compose and skill-config contracts were corrected against the code: a
  type name that never existed (`ClipComposeResult` → `ClipStitchResult`), a
  claim that `'compose'` appears as a video-panel mode tab (it does not — no
  model catalog declares it), and a secret-masking claim that omitted the
  four-character threshold in `mask()`.
- The issue templates lost a duplicated install-method option and an
  outdated version placeholder.

### 1.7.0 — first published release of the fork

The fork's first published release. It ships as a **GitHub Release asset**
(`q253595422-dsh-imagegen-video-1.7.0.tgz`), not as an npm package. Everything in
"What the fork adds" below is in this release.

- **The version line is this repository's own.** It starts at 1.7.0 rather than
  continuing upstream's 1.6.x, because this fork is an independent project and
  its releases are not upstream releases. (At the time, 1.6.8 would also have
  looked like it *predated* the very baseline it derives from, since upstream's
  own line had moved on.)
- **No absolute paths ship in the tarball.** `lib/` is published (it is in
  `files`), and Rolldown stamps each module's id into a `//#region <id>` banner
  that survives into the bundle. The CSS Modules virtual id used to be the CSS
  file's absolute path, so `lib/client.js` embedded ten
  `/Users/<name>/…/src/client/*.module.css.mjs` strings and the bundle's bytes
  depended on where it was checked out. The virtual id is now repo-relative
  (`\0dsh-css:src/client/panel.module.css.mjs`), which is stable, unique, and
  reveals nothing the repository does not already publish.
- **The in-app update button installs the release archive.** `installUpdate` used
  to run `dsh plugin add <package>@<version>`, which is a registry lookup: with no
  npm publication it resolves to nothing and the button would fail while looking
  like it worked. It now reads the archive URL from the release's own assets and
  hands that URL to `dsh plugin add`. Two guards came with it — a release with no
  archive is refused instead of falling back to a registry spec, and the download
  host must be GitHub, because the URL arrives from the network. Asset ranking is
  by name (the package archive for this version first), so a release that also
  carries another version-named archive cannot win by alphabetical accident.

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
| release archive (`q253595422-dsh-imagegen-video-<version>.tgz`) | `https://github.com/q253595422/dsh-imagegen-video/releases` |
| plugin id (stamped by `tsdown.config.ts` into the `__ModuleLoader__` handoff) | `@q253595422/dsh-imagegen-video` |
| `cordis.patch.yml` row `name` | `@q253595422/dsh-imagegen-video` |
| update check (`src/updater.ts`) | this repository |

The npm package name is `@q253595422/dsh-imagegen-video` as well, but nothing is
published there: the fork distributes through GitHub Releases, so both the README
and the in-app update button install the release asset. `src/updater.ts` reads the
asset URL from the release itself and refuses to install a release that carries no
archive, rather than falling back to a registry spec that would resolve to nothing.

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

# Changelog

Releases are listed newest first. Commit-level detail is in `git log`.
Attribution for third-party code is in [NOTICE](./NOTICE).

## Releases

### 1.15.2 — 视频取片支持 `/content` 回退

- **A finished task with no URL in its body is now downloaded instead of
  failed (#9).** OpenAI's video API — and the OpenAI-compatible relays that
  copy it — report `status: "completed"` with no `url` anywhere and serve the
  bytes only from `GET /videos/{id}/content`. `readPoll()` treated that body as
  "completed but no video address" and failed a render the provider had already
  finished. The poll now reports the content endpoint as the clip source, and
  the download leg fetches it unchanged — same-origin key forwarding, MIME
  inference and the size cap all still apply. A body URL is still preferred,
  and a `/content` that 404s reports the download leg rather than passing as a
  silent success.
- **A batch of UI fixes ships in the same version.** Eight modules were driven
  in a real browser: a fully covered canvas node now marks both nodes and
  carries a `role="status"` badge naming what covers it (the hint survives
  pointer-up, when the node is still hidden); the sixty error/warning
  declarations that referenced `--dsw-alias-label-error` / `-warning` — which
  the dsh theme never defines — now use the resolvable
  `--dsw-alias-state-error-primary` / `-state-warn-primary`; the ecommerce
  section title no longer shrinks to 69px against a hint needing 70 (no column
  width changed); saving, channel tests, update checks and diagnostics clearing
  report what actually happened instead of reading as successes; dialogs trap
  and restore focus, and the select exposes combobox semantics with
  `aria-activedescendant`; PPT setup reports per-step state. Full detail in
  `docs/releases/v1.15.2.md`.

### 1.15.1 — 火山适配的收口修复

- **Ark pixel sizes stay inside the budget.** At 4K / 16:9 the solved
  `2866x1612` rounds up to 16,779,264 pixels, 2048 over the 4096² ceiling, and
  the provider rejects it. The height is now scanned near the target for an
  even pair that is both legal and nearest the requested ratio, with a scale
  fallback when none exists. lite and 4.5 also get their own tier floor
  (`2560x1440`, not 5.0 pro's `1280x720`), so 1K stops being refused there.
- **Capabilities are read from the upstream id, not the alias.** A channel can
  map `seedance-hd` to `doubao-seedance-2-0-fast-260128`, and the 720p ceiling
  belongs to the latter. Both the engine and the panel described the alias, so
  the panel offered 1080P and the submit got a 400. `resolveVideoModelId`
  resolves the id first; the resolution fallback also stops collapsing 1080P to
  480P (it now picks the highest tier at or below the request).
- **The `ep-…` claim was wrong** and is corrected in the README, the preset
  hint and the release notes: the family comes from the model id prefix, so an
  inference endpoint is refused before submit instead of being sent a
  malformed body.
- **A `renderer: code` submit no longer demands a channel.** Code rendering
  needs no image/video channel, but both submit routes validated one and
  refused the request before rendering started.
- **Code detection no longer uses a method whitelist.** A model writing
  `ctx.fillRect(...)` — a method this renderer does not have — had the whole
  answer filed as prose and silently replaced with the fallback title card,
  hiding the actual problem. Any `ctx.<method>(` now counts as code and the
  executor reports `code-runtime` with the method name; a prose answer also
  quotes what the model said, so a refusal is distinguishable from a wrong API.

### 1.15.0 — Volcengine Ark, properly

- **Seedream gets the real Ark contract.** The official ids
  (`doubao-seedream-5-0-pro-260628` and friends) have no `aspect_ratio`
  parameter at all, and their `size` is EITHER a tier (`1K`/`1.5K`/`2K`/`3K`/
  `4K`) OR an explicit `WxH` — never both. Sending a bare tier therefore
  threw the panel's ratio away and a 16:9 request came back square or 1:1.
  Ark ids now receive explicit even dimensions solved from the chosen ratio
  inside that model's documented pixel budget (5.0 pro/flash cap at
  `2048x2048x1.1025`; 4.5 and 5.0 lite at `4096x4096`; 3.0 at `2048x2048`).
  `auto` still sends the tier string, which is Ark's "you choose" form.
- **The watermark is turned off explicitly.** Ark documents `watermark: true`
  as the default, so every Ark request used to come back with a visible
  "AI生成" stamp in the corner. Both the text-to-image and the edit request
  now send `watermark: false`. Gateway-shaped Seedream still sends
  `b64_json`; only the official Ark shape uses `response_format: 'url'`.
- **Seedance is a first-class video family.** `doubao-seedance-*` ids were
  being classified as the generic OpenAI-style video endpoint, which posted
  to `/videos` and never worked. They now speak Ark's own task contract:
  `POST /contents/generations/tasks`, poll
  `GET /contents/generations/tasks/{id}`, clip at `content.video_url`.
  The prompt and every reference ride in a `content` array — images carry a
  `role` of `first_frame` / `last_frame` / `reference_image` — the ratio field
  is `ratio`, resolution is lowercase, and duration is an integer.
- **Values are narrowed where the model would reject them.** Seedance 2.x
  accepts 4–15 seconds and 1.0 accepts 2–12; the `fast`/`mini` ids cap at
  720p and reject 1080p and 4k upstream, and 1.0 does not accept the
  `reference_image` role (`1.0 pro fast` also has no last frame). Requests are
  clamped to the window, degraded to the best tier the id does support (a
  1080P ask on a fast id becomes 720p, not 480p), and modes the id cannot
  express are dropped from the panel instead of being sent as a 400.
- **Silent by default, not by accident.** Seedream's `watermark` defaults to
  `true` (a visible "AI生成" stamp), so it is sent as `false`. On the video
  side `watermark` already defaults to `false` but is still sent explicitly,
  while `generate_audio` — which exists on 2.x and defaults to `true` — is
  sent as `false`; 1.0 ids do not receive the field at all, since they have no
  audio track to switch off.
- **One channel, both halves.** The built-in preset is now "字节 · 火山方舟
  （Seedream / Seedance）" with real model ids and a video catalog, so one
  Ark channel serves images and videos.
- **Offline coverage.** `B7` asserts the Ark pixel size stays inside the
  budget, keeps the ratio and is even, plus `watermark: false`; two new
  `smoke-video` cases cover the Seedance submit body, the poll path and
  `content.video_url`, and the duration/resolution narrowing.

### 1.14.0 — draw it in code, render it here

- **A second renderer, chosen per task.** The canvas composer now carries a
  *Rendering* select: **Model** (the historical path, unchanged and still the
  default) or **Code**. The choice belongs to the task being submitted — it is
  not a setting, not a global switch, and nothing is written to disk, so the
  next generation on the same canvas can use the other one.
- **No image or video provider involved.** In code mode the drawing program is
  written by the conversation model DSH already has (`ctx.agentDefaultModel`,
  mounted through the host's `agents` and `agentPresets` services) — not the
  plugin's prompt-enhancement endpoint — and rendered on this machine. One
  headless turn, no tools, no vendor SDK, no second credential.
- **Rendered, not prompted.** The returned JavaScript runs in a `node:vm`
  context with a drawing API and no `require`, `process` or filesystem; each
  frame is RGBA pixels handed to ffmpeg, or encoded straight to PNG. Nothing
  leaves the machine, so a code render costs no image/video quota.
- **Same pipeline, same slots.** A code result is submitted through the same
  `GenerateRequest` / `VideoGenerateRequest` (an extra `renderer: 'code'`),
  lands in the same `images/` and `videos/` directories and the same history
  stores, and is therefore stitchable, timeline-cuttable, transitionable,
  favouritable and re-framable exactly like a model result. Resolution,
  aspect and duration come from the same composer controls; frames =
  duration × 30 fps.
- **Failures are named and recoverable.** `code-prompt-empty`,
  `code-prompt-too-long`, `code-no-chat-model`, `code-chat-failed`,
  `code-not-code`, `code-syntax`, `code-runtime`, `render-timeout`,
  `render-no-ffmpeg`, `render-cancelled`, `render-encoder-died`,
  `render-encoder-failed`, `render-empty`. The node shows the host's own
  message plus a hint to switch back to Model and retry; a missing ffmpeg is
  warned about in the composer *before* submitting (`POST /code/probe`).
- **A non-code answer still produces something.** If the model replies with
  prose instead of a program, the render falls back to a built-in title card
  and the task is marked `degraded` with the reason — a wasted render is worse
  than a plain one.
- **Retry replays the program.** The generated source is kept on the task, so
  retrying a failed *render* does not ask the model again; generating again
  does.
- **No new dependency.** `node:vm`, hand-written PNG encoding and the existing
  `locateFfmpeg()` / `clip-compose.ts` path — ffmpeg remains the only external
  tool, needed for code videos only.

### 1.13.0 — the video is directed before it is rendered

- **A planning step before every render.** With the studio's new *Plan first*
  switch on (the default), a one-line request is no longer forwarded verbatim.
  A reasoning pass splits it into shots, subject motion, camera work, duration
  and style, and produces the prompt and parameters the provider actually
  receives. The finished task, its queue summary and the history entry all
  carry the plan, so a clip can be explained later without re-running anything.
- **The plan is the request.** The planned prompt replaces the typed one, and
  the planned duration / aspect / resolution replace the panel's values. A plan
  may only NARROW them: a model asking for 30s when the user chose 5s gets 5s,
  and a frame the family cannot render (4:3 on comemoe) is overruled. A
  previewed plan that arrives back over the wire is re-clamped before use.
- **Preview before you pay for a render.** `POST /video/plan` runs the same
  planning code with no submit, and the studio's *Preview plan* button shows
  the shots and parameters. Submitting afterwards adopts that exact plan
  instead of asking the chat model again, so what was previewed is what gets
  rendered.
- **Planning degrades, it does not disappear.** No chat model configured, an
  unreachable endpoint, a timeout, or an answer that is not the agreed JSON all
  fall back to an offline shot planner. The plan is marked `degraded` with the
  reason, shown in the panel and recorded under the new `video-plan`
  diagnostics phase — the raw sentence is never silently submitted.
- **Inputs are bounded.** An empty prompt is refused with `video-prompt-empty`
  and one over 4000 characters with `video-prompt-too-long`, both before any
  submit. A planned prompt is capped at 900 characters.
- **Prompt structure follows Wan 2.2.** The shot skeleton (style → shot size and
  lighting → per-shot subject, motion and camera; motion over static scene for
  image-bearing modes) is the one Wan's own Apache-2.0 `--use_prompt_extend`
  guide teaches, which is the reference implementation behind the `wan2.2-*`
  family this plugin routes.
- **No new credential.** Planning reuses the existing prompt-enhancement chat
  endpoint (`promptModel` / `promptApiUrl` / `promptApiKey`); blank values reuse
  the image channel. `pnpm test:director` covers all of the above offline, and
  an end-to-end run against a real channel was verified: the planning model
  produced the shot list and the provider rendered from it.

### 1.12.0 — cut, join, and keep the same face

- **A timeline editor on the canvas.** The dock's new film button lines the
  finished clips up in canvas reading order, then lets them be reordered,
  trimmed (in/out point per clip) and joined with a transition. The result is
  still an ordinary video node, so preview / download / favorite / retry keep
  working on it.
- **Trims are clamped to the clip.** An out point past the end of the material
  is the material's own length, never a read past the last frame; a transition
  is clamped to half of the shorter clip beside it at *calculation* time, so
  xfade never receives an offset longer than its input.
- **Real transitions in ffmpeg.** Hard cuts keep the single `concat` pass; any
  fade/dissolve switches to a chained `xfade`/`acrossfade` graph with a unified
  time base on both sides. Audio is optional — turning it off omits the audio
  chain entirely instead of mapping a silent one.
- **The editor's total matches the file.** Both sides read
  `timeline.ts`, so the length shown in the panel is the length that gets
  written. `pnpm test:timeline` checks the rules offline and
  `pnpm test:timeline-compose` runs four real ffmpeg renders and measures them.
- **Identity anchoring.** Any image node can be pinned as a character, item or
  style with a name. Pinned nodes join every later image and video generation
  as references automatically, and the prompt gains one sentence saying which
  reference is whom. Connecting a node still wins for *this* run; the pin is the
  film's standing definition and is de-duplicated against it (one image sent
  once, one name sent once).
- **A pin that only exists on screen is a bug, not a feature.** The pin lives in
  `metadata.cast` on the node, so it survives a reload and every later run reads
  the same definition — change the face by re-shooting that one node.
- **Video mode upgrades rather than degrades.** With nothing wired but a
  character pinned, an `auto` video run becomes reference-mode instead of
  quietly falling back to text-to-video.

### 1.11.0 — the canvas runs the whole chain, not one node

- **A workflow run.** The dock's new branch button walks the graph downstream
  from the selection (or from every unfinished node when nothing is selected)
  and runs the whole chain: nodes with no remaining dependency start together,
  the next layer waits for the previous one, and finished nodes are reused
  rather than generated twice.
- **Failures stop the chain where they happen.** One node failing ends the run
  and names the node, instead of submitting a downstream wave that would fail
  for lack of input and read like a broken app.
- **A cycle is refused before anything is submitted.** Self-loops count as
  cycles: a node wired to itself would wait for its own product forever.
- **A running node is adopted, not resubmitted.** Re-running a chain no longer
  pays twice for work already in flight.
- **Progress and stop.** A bar reports the current layer and how many nodes are
  done; stopping ends the chain at the next layer boundary while tasks already
  submitted finish on their own.
- The scheduling rules are pure functions (`workflow-graph.ts`) and the run loop
  is engine-free (`workflow-runner.ts`), so `pnpm test:workflow` exercises them
  offline.

### 1.10.0 — storyboards: a shot list that runs into clip nodes

- **A storyboard node.** One board is a list of shots — a prompt and a length
  each, reorderable, renamable by moving — and every shot produces an ORDINARY
  video node on the canvas. That is the whole design: because the result is the
  same node type as a hand-made clip, it is previewable, downloadable,
  favoritable, retryable and stitchable with no second workflow to learn.
- **Two kinds of continuity.** The independent mode submits every shot that has
  no clip in one press; the carry mode submits one shot at a time, using the
  previous shot's last frame as this shot's first frame, so consecutive shots
  join up. A carry shot is blocked — with a visible state, not a silent refusal
  — until its predecessor has a clip.
- **The tail frame is reusable on its own.** Any finished clip offers a
  continue-from-tail action: it grabs the closing frame, drops it as an image
  node, and wires it into a fresh video config, ready to type the next shot's
  direction into.
- **The board stitches through the existing compose run.** Once two shots have
  clips, the board's stitch action hands them to the same ffmpeg path, with the
  same numbered order review; a shot still rendering is left out and the
  shortfall is said out loud instead of being submitted as a run that would
  fail.
- **State survives a reload.** The shot list, the shared settings and each
  shot's link to its clip node are part of the canvas document; a board whose
  stored state cannot be honoured fails the save loudly rather than being
  written half-valid. Every row's state is read from its clip node, so the board
  and the canvas can never disagree about what is finished.
- **Editing goes through the document**, so undo, redo and autosave work on a
  board exactly as they do on a text node.

### 1.9.3 — session images, PPT delivery, and xAI Grok video

Upstream 1.9.1 + 1.9.2 landed here, alongside this repository's own fixes.

- **A host Agent failure is reported as itself.** Model and execution errors are
  kept (and redacted) instead of surfacing as "no final PPTX was produced";
  a run with no reply points at the default-model connection and tool setup.
- **The upstream skill's own `final/` deck is collected.** Only a run summary
  marked complete with a passed validation report qualifies, and the deck is
  still checked for PPTX structure and page count — an intermediate page file
  never becomes the result.
- **PPT configuration opens in place.** The dialog reuses the generation
  settings' own fields rather than reaching for the host settings button by DOM
  lookup, with Escape, focus containment and return-to-trigger.
- **Uploads become a thumbnail grid** with an add tile: preview, reorder, delete,
  and the order is the slide order.
- **The result pane shows only the final PPTX**, auto-opened: left column for
  sources and options, right for the deck with page thumbnails, previous/next,
  expand and download. Narrow screens go single-column with the source list
  scrolling on its own. A task diagnostic entry exports the run's identifiers,
  a failed preview can be retried, and the download survives the error.
- **Conversation tool results show their images again.** The renderer reads DSH's
  persisted result metadata, so text-to-image, image-to-image and task-query
  results all display thumbnails and open the original; older sessions keep
  working through their image content blocks and JSON references, and a repeated
  attachment appears once. Images stay UI data — what the model receives is
  still text.
- **`format v4 message requires a producer-owned source kind` is fixed.** A PPT
  run's first message carries `plugin:dsh-imagegen` instead of the v4-rejected
  plugin wrapper; cast-heavy canvas skills share the fix.
- **Grok video speaks xAI's own contract.** A new `xai` family submits to
  `/v1/videos/generations` and reads `request_id`, polls
  `/v1/videos/{request_id}` for `video.url` / `video.duration`, and reports
  `failed` and `expired` as failures. The body sends a numeric `duration`, a
  lowercase `resolution` and `image: { url }`. The `xai-grok` preset ships
  `grok-imagine-video-1.5` and `-lite`.
- **The narrow centre column stays usable.** Below 760px the conversation row
  sizes to its content, the studio scrolls as a whole, and the config column no
  longer stretches the layout — the generate button and the canvas stay reachable.
- **Desktop updates run through the launcher's install hook** and verify what it
  actually reports: installed bundle, version, exit code and error code are each
  checked, and an unverifiable result fails rather than claiming success.

### 1.9.0 — images to an editable PPTX

A standalone conversion workspace, reached from any finished image.

- **A PPT workspace of its own.** Upload PNG / JPG / WebP — up to 12, 20 MB each —
  reorder or remove the thumbnails (the order is the slide order), and convert.
  The run reports its real state: running, cancellable, done with a download, or
  failed; the inputs stay put so a deck can be converted again.
- **Every result can start a conversion.** Text-to-image, image-to-image,
  the multi-model comparison cards and the full-screen preview each gained a
  "make an editable PPT" action that carries the image into the workspace.
- **A PPT section in the settings card.** Install or update the official skill,
  install and check the isolated `editppt` Python environment, configure the
  image API and an optional PaddleOCR token. Keys go through the existing
  redacted secret storage and never enter the task prompt.
- **OCR is a choice, not a requirement.** PaddleOCR, or the offline text
  detection that ships with the conversion.
- **A conversion that produced nothing is reported as failed.** No final PPTX, an
  invalid ZIP, or a page-count mismatch all fail loudly; a task interrupted by a
  host restart shows as interrupted and can be started again.
- **PPT routes validate before they run.** The client sends asset ids only and the
  host rebuilds the URL, so a caller cannot point the conversion at an arbitrary
  address; image count, asset-id syntax and the OCR flag are checked up front,
  and the refusal names what is missing. Covered by `C6c4`.
- **The nav scrolls on a phone.** At ≤760px the top nav scrolls horizontally
  instead of pushing entries off-screen, and settings summaries wrap.

Prerequisites: Python 3.10+, a configured default model, skills and long tasks
enabled, and an Agent preset with file and command tools. Multi-page runs use the
skill's own page tasks, which need sub-agent support in the preset.

### 1.8.0 — multi-reference editing, a template drawer, and honest wait states

Four capabilities: multi-reference editing, a template drawer, wait states that
show they are waiting, and results that are no longer cropped.

- **Image editing takes up to five reference images.** The first stays in
  `image` and the rest travel in `images`, so a single-reference provider still
  sees exactly one image and every existing request shape is unchanged. The
  engine half of this was already present; what was missing was the panel: the
  form held one `refImage`, so the protocol could
  never be reached from the UI. It now holds a list, with multi-select, drag,
  paste, per-image removal, a preview with arrow-key paging, and the documented
  limits (5 images, 10 MiB each, 16 MiB total) enforced in one place
  (`reference-images.ts`) rather than in each entry point.
  A model whose adapter takes only one reference is refused **before** submit
  with the count it does support, instead of sending a request the upstream
  would silently trim; in compare mode the strictest target wins.
- **The template library is a drawer, not a centred modal.** It docks to the
  right edge at ~75% of the workspace, remembers its width in `localStorage`,
  can be dragged from its left edge or expanded to the full workspace, goes
  full-width on phones, searches across every library, and keeps the last 24
  used templates for one-click reuse. A picked prompt can replace the composer
  text or be appended to it. Two things were kept on purpose:
  `favorites: null` still means "not loaded yet" (so a failed read shows an
  unknown star and a retry, not a wall of un-favourited cards), and the shared
  roving-tabindex helper still walks the source tabs.
- **Waiting looks like waiting.** A bounded SVG dot field (475 dots, 130 in the
  compact variant) driven purely by CSS `animation-delay` — no timers, no React
  updates — replaces the single spinner. In a multi-model comparison each card
  gets its own field and its **own** elapsed time from that task's `startedAt`,
  so four models no longer share one misleading clock. Failures and cancellations
  stop only their own card; `prefers-reduced-motion` drops the animation.
- **Results are no longer cropped.** The result grid switched from `cover` to
  `contain` with a zero-basis flex so a tall or wide image fits the space it has
  instead of having its edges cut off. The ecommerce cards keep their `cover`
  override — that rule is what stops a product shot from being letterboxed.

Two deliberate choices:

- **Desktop updates still explain themselves.** In-panel updates run when the
  host exposes an install hook, and otherwise show an explanation rather than a
  bare hint. `updateInstallTarget()` reports
  `cli` / `host` / `host-managed`, and the `host` path installs the exact Release
  tarball through the host and then verifies `application`, exit code, bundle
  name and version, falling back to the installed manifest when an older host
  omits the version (an unverifiable install is a failure, never a success) —
  and `ManualUpdateRequiredError` stays for the managed case, because the panel
  renders a copyable command from `details.tarballUrl` and a one-line hint would
  lose that.
- **One primary label in the template detail view.** The button does not get
  renamed to "Replace" once the composer holds text. It says "Use this prompt" in both
  cases and adds a separate "Add" button only when there is something to append
  to, so the primary action never changes meaning under the user.

One gate added after 1.8.0 shipped:

- **A version bump without its notes is now a failure.** This release reached
  the Release page without `docs/releases/v1.8.0.md`, so `release.yml` fell back
  to GitHub's auto-generated "Full Changelog: <compare link>" line — a ::warning
  in a log nobody reads — and the tag froze that one-line page the moment it was
  created. `verify-pack.mjs` now requires `docs/releases/v<version>.md` to exist
  and to be inside the archive (it is in `files`), which runs in CI before
  anything is packed. Two negative cases prove the assertion: bumping `version`
  with no notes file, and dropping `docs/releases` from `files`.

### 1.7.8 — the manifest stops claiming a package the host already provides

One packaging correction, no behaviour change.

- **`@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies`.**
  It is not an implementation detail of this plugin — its `z` builds the config
  schema the host validates — so the host's own copy is the one that must be
  used. Declaring it as a dependency made every install pull a second copy of a
  `@deepseek-ai/*` package alongside the host's, which is both the wrong
  ownership relationship and the thing plugin directories list as a rule.
  `devDependencies` still carries it, so local builds, typecheck and the whole
  offline suite resolve it exactly as before; only the published manifest
  changes. Verified by installing the packed tarball into an isolated
  `DSH_HOME`: the profile pulls two packages instead of three (no second
  schemastery), resolves the host's own 3.18.4, and `lib/index.js` imports
  cleanly (132 exports, `CURRENT_VERSION` 1.7.8).

### 1.7.7 — deleting becomes undoable, the poster editor arrives, and the update chain stops lying

Three user-visible failures and one new feature, plus the release process itself
moving onto a machine that runs the gates.

- **Deleting a gallery entry no longer destroys its bytes.** Removal was an
  unlink, so every history row and canvas node still holding that URL turned
  into a broken image, and there was no way back. It is now a soft delete: the
  entry is flagged `deletedAt` and listed as trash, the files stay put, and only
  `purgeGallery` (or the retention sweep) unlinks. The retention window is
  `GALLERY_TRASH_RETENTION_MS` = 30 days, enforced lazily inside `mutateGallery`
  — no timer, nothing to shut down, and a process that is never opened again
  still gets its cleanup on the first store call of the next one. Re-adding an
  image whose old copy is in the trash produces a visible entry, not a silent
  no-op. The panel's trash section was also covered by nothing: the fixture fed
  it rows and no check ever looked at them, so the toggle, the per-row restore id
  and the purge confirmation's count could all have broken silently. Each has a
  check now, and the section stopped printing its own count heading directly
  under the toggle that already says it.
- **The poster editor is new.** Text and logo layers are
  composited over an image node locally with Canvas 2D — no model call, no
  quota. Saving uploads the flattened bitmap as a new image node and stores the
  recipe in that node's `metadata.poster` (the new node is wired to its source),
  so reopening the result restores every layer instead of flattening the work
  into a picture. The source image is never rewritten. `Ctrl+Z`/`Delete` inside
  the modal act on poster layers and never on the canvas beneath it.
  The asset sweep counts those recipe references too: a poster node only stores
  the flattened composite in `metadata.asset`, while its background and logo
  layers live in `metadata.poster` and are re-read by the editor. Collecting
  only `metadata.asset` meant the first canvas a user deleted removed the base
  image behind every poster they had made, and reopening one drew the layers
  over an empty stage.
- **The update chain reports what actually happened.** `profileFromProcess`
  resolves the profile from `DSH_PROFILE`, then `--profile`, then a
  `profiles/<name>` path segment in argv, and only then falls back to `web`. The
  Electron host passes the profile as a bare *path* and sets neither of the
  other two, so the flag-only reading targeted the wrong profile for every
  Desktop user — even a successful update left the running host on the old
  plugin. DSH Desktop's profile is locked by the CLI — spawning it anyway
  produced a bare "update failed" with no cause — so that profile now throws
  `ManualUpdateRequiredError`
  (`update-manual-required`) carrying the archive URL, and the panel shows a
  copyable install command instead of a scary error. A failed spawn keeps the
  last three lines of the CLI's stderr (`STDERR_LIMIT` 4 000 chars) so a pnpm
  store mismatch or a locked directory is readable.
- **The canvas has a keyboard shortcut legend.** `?` or `F1` opens it, the dock
  gained an entry, `Esc` closes it above every other overlay, and the controls
  that have a shortcut now name it in their own tooltip ("撤销 (Ctrl+Z)"). The
  bindings live in one data table (`CANVAS_SHORTCUTS`) shared with the check that
  compares them against the key handler, so the legend cannot drift from the code
  it documents. `canvas.undo` / `canvas.redo` lost their hardcoded `(Ctrl+Z)`
  suffix in all three languages — the key text is derived from the table now.
  The layout is measured in a real browser at 1280×800 and 390px: the dialog
  has to fit the viewport (its body scrolls instead), no row may overflow its
  grid column, and the two-column grid has to collapse to one on a phone.
- **A malformed poster recipe is refused on the way in and on the way out.**
  `isPosterDocument()` is strict (`version === 1`, integer sides within 4096, a
  64-hex `assetId` with an image extension, `url` on the same-origin asset route,
  `type` not `kind`, unique ids, `#rrggbb` colours), and `isNode()` calls it, so
  a canvas save carrying a half-valid recipe fails loudly instead of throwing
  when the editor is reopened. A route-level test round-trips a valid one and
  refuses two corrupt shapes.
- **The browser suites stop fighting over a debugging port.** They guessed
  `9900 + random(300)`, and two runs (or a leftover browser) could land on the
  same port — the intermittent `Error: CDP down` that made `verify-ui-contracts`
  report 27/28. `scripts/lib/headless-chrome.mjs` launches with
  `--remote-debugging-port=0` and reads the port Chromium actually published
  from `DevToolsActivePort`, checks `exitCode`, keeps stderr for the error, and
  uses a fresh profile directory per launch. All three guards share it, and
  `verify-ui-contracts` now scans the other guards' sources for a guessed port,
  so nobody can reintroduce one without a red check.
- **The release is built by CI, not by hand.** `.github/workflows/release.yml`
  runs typecheck → build → ffmpeg → tests → verify-pack → `pnpm pack` →
  `SHA256SUMS` → tag → GitHub Release, and the tarball the Release advertises is
  the one the tests ran against (`--ignore-scripts` on the pack, so nothing
  rebuilds into different bytes). Re-running is idempotent: same tag, replaced
  assets, no duplicate Release. It never moves an existing tag. npm publishing is
  a separate job gated on a repository variable, and it probes for the package
  before the version — npm answers both "no such package" and "no such version"
  with E404, and only the second one is a normal publish.
- **The browser launcher had never been committed.** `.gitignore` carried an
  unanchored `lib/`, which matches `scripts/lib/` as well as the build output,
  so `scripts/lib/headless-chrome.mjs` was excluded from the repository from the
  day it was written. Three guard scripts import it: a clean clone died with
  `ERR_MODULE_NOT_FOUND` before any suite could run, while the author's tree
  stayed green because the file existed on exactly one disk. The first release
  workflow is what surfaced it — `pnpm test` failed before `verify-pack` ran and
  no tag was created. `.gitignore` now anchors the rule to `/lib/`, and
  `scripts/verify-tracked.mjs` runs as the first step of `pnpm test`: every
  relative import under `src/` and `scripts/` must name a file git tracks, and
  no source file may be sitting in the tree untracked.
- **The archive check only confirmed what somebody remembered to list.** 
  `verify-pack.mjs` required `lib/index.js` and one template snapshot, both
  hard-coded, and nothing compared them against what `package.json` tells a host
  to load. A `files` edit that drops `lib/`, or an `exports` target pointing at
  a renamed file, produced an archive that installs cleanly, boots cleanly, and
  does nothing at all: the host throws at import time or the browser half 404s,
  and neither error names packaging. The check now reads the manifest **inside**
  the tarball and requires `main`, every `exports` target and
  `dsh.bundle.patch` to actually be in it. Writing the case exposed a second
  problem in the harness itself: `freshCopy()` copied `lib` but not
  `cordis.patch.yml` or the other `files` entries, so the pack runner was
  inspecting an archive that could never satisfy a packaging rule — the copy is
  now built from the `files` list instead of a hand-kept one.
- **`test:negative` was not running every case it defines.** The `canvas-video`
  runner was added for the gallery soft-delete case but never appended to the
  `test:negative` chain, so the case passed when invoked by hand and was absent
  from the gate. The chain now includes it, and `verify-negative.mjs` refuses to
  run at all if any defined runner is missing from that command — a guard on the
  gate, since a case can only fail after its runner has been selected.
- **The build was not a function of the source tree.** Two builds of the same
  commit produced different `lib/client.js` bytes. `lightningcss` returns
  CSS-module exports from a native hash map, so the class names arrive in a
  different order on each process — five runs over one stylesheet produced five
  different first keys — and `tsdown.config.ts` serialised that map in iteration
  order. Object key order is invisible to every consumer of a CSS-module map,
  which is why nothing ever noticed; but it is byte-stable input to the release
  artifact, so `SHA256SUMS` could not be reproduced from source and "the Release
  ships the bytes the gates approved" was true only of the run that made them.
  The map is sorted at the one point where it becomes bytes, and
  `scripts/verify-reproducible.mjs` now builds twice on every `pnpm test` and
  requires all four artifacts to be byte-identical.
- **The npm job's "exactly one tarball" guard could not fail on zero.** Bash
  leaves an unmatched glob in the array as its own literal, so
  `packages=(dist/*.tgz)` against an empty `dist/` yielded count=1, the guard
  passed, and the next line asked npm to publish a file named `dist/*.tgz`. The
  job did fail — with `ENOENT`, which reads like an npm fault instead of "the
  artifact never arrived". `shopt -s nullglob` makes the count mean what it
  says, and the failure now prints `ls -la dist`.

### 1.7.6 — the template library grows to eight sources, and a parser bug that hid half of one

The template library was smaller than it said it was. A snapshot keyed each case
by its number alone, and the upstream reuses numbers across AND inside its
category files, so roughly a thousand cases were overwritten without a single
error. Fixing that, plus three newly found upstream collections that can be
included on their licences, takes the library from 5 sources / 2462 cases to
**8 sources / 3774 cases**.

- **evolink: 462 → 967 cases.** `cases/character.md` and `cases/portrait.md`
  both open at `### Case 1:` with images in different directories, and numbers
  repeat inside one file too, so keying a case by its number discarded the rest
  — about 1420 parseable prompts reduced to 462 with nothing to show for it. Ids
  are now category-scoped (`portrait-53`) and de-duplicated per file: 967 cases,
  zero duplicate ids. This is a repair, not an addition, which is why it is
  called out separately.
- **Three new sources, each pinned to an exact commit.** `itgoyo/awesome-gpt-image2-prompt`
  (602 cases, CC BY 4.0), `songtianlun/awesome-prompts` (55, MIT) and
  `youart-open-source/awesome-gpt-image-2-5-prompts` (150, layered licensing —
  see THIRD_PARTY_NOTICES.md). `ITGOYO_COMMIT`, `SONGTIANLUN_COMMIT` and
  `YOUART_COMMIT` fix the revision the build reads; the sources are deliberately
  not refreshable at runtime, so what was reviewed is what ships.
- **youart ships no images on purpose.** The corpus publishes none of its own;
  every row credits the person who wrote the prompt and the post where it first
  appeared. Those cards show the placeholder thumbnail and keep the full prompt,
  title and author link.
- **The source tab row scrolls.** Eight `nowrap` tabs in a plain flex box
  neither wrapped nor scrolled, so every source past the right edge was
  invisible, unclickable, and undiscoverable. The row now scrolls horizontally
  and the tabs do not shrink (shrinking truncates the label and its count badge
  instead). Verified in a real browser, not by reading the declarations.
- **Favorites for evolink cases do not carry over.** Favorites are keyed
  `sourceId:caseId`, and evolink's ids changed shape (`case-12` →
  `portrait-12`), so a star put on an evolink case in 1.7.5 will not resolve.
  No other source's ids changed. This is the unavoidable cost of fixing a
  collision that was silently discarding cases.
- **Six preview images from an unlicensed repository are gone.** `prompt-signal`
  carried six `image` URLs pointing at `songguoxs/gpt4o-image-prompts`, which
  declares no licence. The URLs are shipped data, so serving them is this
  project's call rather than the aggregator's: the field is now empty and those
  cards show the placeholder thumbnail. Their prompt text, title and link to the
  original author's own post all stay — the prompt was never the aggregator's,
  and the `githubUrl` attribution link is kept. Both the generator and the
  contract check guard this, so a regeneration that forgets the filter fails.
- **The installed archive is 4 MiB instead of 24 MiB.** `docs/images/` — the
  README screenshots, including a 13 MiB demo GIF — is never read at runtime and
  is rendered by GitHub from the repository. It is no longer in `files`, the way
  `docs/videos/` already was not. The archive rule now runs as
  `scripts/verify-pack.mjs` against a real `pnpm pack` in CI and in the negative
  verification, instead of as inline shell in the workflow.
- **"Detect models" no longer drops `nanobanana2` and `nanobanana2-lite`.**
  Both ship in `DEFAULT_IMAGE_MODELS`, and `describeModel()` recognises them,
  but `isLikelyImageModelId()` required a separator after the family keyword —
  `nanobanana2` has none between `nanobanana` and `2`. Against a gateway whose
  `/models` returns ids without capability metadata, the panel therefore listed
  two models fewer than the catalog declares. The predicate now accepts an
  optional digit run before the boundary (`flux2`, `wanx2` likewise);
  `gpt-4o` and `text-embedding-3-small` are still rejected. The smoke suite's
  detection check now serves both ids from its mock gateway, so reverting the
  regex turns it red.

### 1.7.5 — every UI module reviewed, and a failed call that can be explained

Two things: a full pass over the plugin's UI, driven by real defects rather than
taste (the theme no longer leaks into component internals, and the layer order is
written down in one place), and a failed call that can actually be explained —
including on the video chain, where a failed render had nowhere to be inspected.

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
- **The video chain records into the same buffer.** A user whose images work and
  whose videos do not would otherwise have nowhere to look — and
  `DiagnosticPhase` could not even name the video legs.
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
are this plugin's headline feature, which made the feature unusable end to end:
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

### 1.7.0 — first published release

This project's first published release. It ships as a **GitHub Release asset**
(`q253595422-dsh-imagegen-video-1.7.0.tgz`), not as an npm package. Everything in
"What this plugin adds" below is in this release.

- **The version line is this project's own.** It starts at 1.7.0, so these
  version numbers never collide with another plugin's release line.
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

## What this plugin adds

### Video generation (the original motivation)

A complete video pipeline, from the contract layer to the studio UI:

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

### Fixes to the image chain

- **The update check points at this repository.** `src/updater.ts` carried
  `PACKAGE_NAME = '@dickpy/dsh-imagegen'` and that project's GitHub Releases API
  URL, so "check for updates" would have offered another package's release notes
  and installed it over this plugin. Both now point at this repository. (Same
  class of problem as the package rename below.)
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

The plugin publishes under its own name so it cannot be confused with, or
mistaken for, another package:

| Where | Value |
| --- | --- |
| release archive (`q253595422-dsh-imagegen-video-<version>.tgz`) | `https://github.com/q253595422/dsh-imagegen-video/releases` |
| plugin id (stamped by `tsdown.config.ts` into the `__ModuleLoader__` handoff) | `@q253595422/dsh-imagegen-video` |
| `cordis.patch.yml` row `name` | `@q253595422/dsh-imagegen-video` |
| update check (`src/updater.ts`) | this repository |

The npm package name is `@q253595422/dsh-imagegen-video` as well, but nothing is
published there: releases go through GitHub Releases, so both the README and the
in-app update button install the release asset. `src/updater.ts` reads the
asset URL from the release itself and refuses to install a release that carries no
archive, rather than falling back to a registry spec that would resolve to nothing.

The **runtime identity is deliberately left alone**: the `/api/dsh-imagegen/*`
route family, the `dsh-imagegen` settings namespace, the `~/.dsh/dsh-imagegen/`
data root and the `dsh-imagegen:*` client events/storage keys all keep their
inherited names. Renaming them would orphan the settings and data of anyone
switching between the two installs, and the route prefix predates this plugin.

### Test infrastructure

The offline suites run without network access or paid upstream calls, plus a
guard for each defect found:

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

## Configuration notes

- The `@q253595422/dsh-imagegen-video` package **cannot be installed alongside
  `@dickpy/dsh-imagegen`**: both register the same
  `/api/dsh-imagegen/*` route family and both inject the same UI panel. The
  route prefix predates this plugin.
- Data (history, gallery, canvases, settings) lives under
  `~/.dsh/dsh-imagegen/` and keeps that name, so it is *shared* with an install
  of `@dickpy/dsh-imagegen`. Back it up before switching between the two.

## Not in this plugin

- No paid upstream verification is performed by the test suites; all upstream
  interactions are replayed from fixtures.

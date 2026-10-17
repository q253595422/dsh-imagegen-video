# Third-Party Notices

The bundled prompt snapshots under `src/templates/` include material from the
following projects. Image assets are not bundled; they are fetched on demand
from the URLs recorded in the snapshot metadata, so how stable those URLs are
matters:

- `handraw-cases.json`, `evolink-cases.json`, `itgoyo-cases.json`,
  `songtianlun-cases.json` and `youart-cases.json` each pin an exact commit
  (`HANDRAW_COMMIT`, `EVOLINK_COMMIT`, `ITGOYO_COMMIT`, `SONGTIANLUN_COMMIT`,
  `YOUART_COMMIT` in `scripts/fetch-templates.mjs`), so they keep serving the
  revision that was reviewed.
- `prompt-signal-cases.json` mixes both: 35 image URLs pin an exact commit, but
  511 reference `freestylefly/awesome-gpt-image-2` on its **`main` branch** and 6
  reference `songguoxs/gpt4o-image-prompts` on its **`master` branch**. Those
  follow whatever those branches hold today rather than a frozen revision.

Each snapshot also records the upstream it was built from in its own top-level
`repository` field.

## yang0/handraw-style

- Source: https://github.com/yang0/handraw-style
- License: MIT
- Copyright (c) 2026 yang0
- Bundled in `src/templates/handraw-cases.json`.

## andy7076/image_prompt

- Source: https://github.com/andy7076/image_prompt
- License: MIT
- Copyright (c) 2026 andy7076
- Declared repository of `src/templates/prompt-signal-cases.json`.

## EvoLinkAI/awesome-gpt-image-2-prompts

- Source: https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts
- License: CC0 1.0 Universal
- Bundled in `src/templates/evolink-cases.json`.

Note: this snapshot previously held 462 cases although the upstream carried
~1420 with a parseable prompt. Its case numbers are reused across category
files (`cases/character.md` and `cases/portrait.md` both open at `### Case 1:,
with images in different directories) and even inside one file, so keying a
case by its number alone discarded the rest. The ids are now category-scoped
(`portrait-53`), and the snapshot holds every case whose prompt parsed.

## itgoyo/awesome-gpt-image2-prompt

- Source: https://github.com/itgoyo/awesome-gpt-image2-prompt
- License: CC BY 4.0
- Copyright (c) 2025 itgoyo
- Bundled in `src/templates/itgoyo-cases.json`. The prompt text is published
  there under that licence; each case also records the author and the original
  post it credits, and those links are kept verbatim in the snapshot.

## songtianlun/awesome-prompts

- Source: https://github.com/songtianlun/awesome-prompts
- License: MIT
- Copyright (c) 2025 TianLun Song
- Bundled in `src/templates/songtianlun-cases.json`.

## youart-open-source/awesome-gpt-image-2-5-prompts

- Source: https://github.com/youart-open-source/awesome-gpt-image-2-5-prompts
- License: three layers, declared per path in the repository's `REUSE.toml`
  (GitHub's licence detector reports "Other" because it reads `LICENSE` alone):
  the build scripts are MIT (Copyright (c) 2026 Formative Intelligence Inc.).
  The prompt text is not that project's to license — every row names the person
  who wrote it and the post where it first appeared, and the repository keeps a
  copy of the terms each upstream collection stated over its own copy
  (`provenance/`). The rows bundled here came from collections stated as
  CC0-1.0 or CC BY 4.0.
- Bundled in `src/templates/youart-cases.json`. The corpus publishes no images
  of its own, so those cards carry no reference image by design.

## freestylefly/awesome-gpt-image-2

- Source: https://github.com/freestylefly/awesome-gpt-image-2
- License: MIT
- Copyright (c) 2026 freestylefly
- Bundled in `src/templates/cases.json` and
  `src/templates/canghe-cases.json`; also the source of 511 on-demand image URLs
  in `src/templates/prompt-signal-cases.json`.

## songguoxs/gpt4o-image-prompts

- Source: https://github.com/songguoxs/gpt4o-image-prompts
- License: **none declared upstream.** The repository carries no LICENSE file
  and GitHub reports no license for it (checked 2026-10-17).
- Referenced by 6 cases in `src/templates/prompt-signal-cases.json`, each in one
  field left: the `githubUrl` attribution link (branch `master`). The `image`
  URL that used to point here has been cleared.

This one is listed because links into it are in the shipped data, and because
the decision to clear the images is worth recording. See "Resolved: the
unlicensed image URLs" below.

## Resolved: the unlicensed image URLs

Six cases in `prompt-signal-cases.json` used to carry an `image` URL pointing at
a repository declaring no licence (`songguoxs/gpt4o-image-prompts`).

**What was decided.** The image references were cleared. Each of those six cases
keeps its prompt text, its title and its link to the original author's own post,
so it stays fully usable — the card shows the placeholder thumbnail instead of a
preview image.

**Why that option.** Nothing was ever redistributed from the aggregator either
way: only URLs were stored, and the image was fetched on demand. But the URLs
are part of the distributed data, which makes serving them this project's
decision to defend rather than the upstream's. Clearing the field removes the
aggregator from the shipped data entirely, and costs only a preview thumbnail on
six cards out of 577.

**The prompt text is not from the aggregator.** In all six cases it is verbatim
from the original authors' own posts — checked case by case against the X post
already recorded in each case's `sourceUrl`. The snapshot's `sourceLabel` and
`sourceUrl` therefore already credit the real author; the aggregator supplied
only the preview image and the `githubUrl` link. The `githubUrl` is kept: it is
a per-case attribution link, not bundled content.

Pointing the images at the original authors' own media instead (`pbs.twimg.com`)
was investigated and is **not** a drop-in replacement: three of the six posts
carry four images each, so the specific image the snapshot showed cannot be
identified from the post alone, and that host is not reachable from every
network.

**How it stays fixed.** `scripts/fetch-templates.mjs` drops an image reference at
generation time (`UNLICENSED_IMAGE_REPOS`, matched by parsed host and path — the
URLs live on `raw.githubusercontent.com`, which a naive `github.com` substring
test would miss), and `scripts/verify-ui-contracts.mjs` re-checks the shipped
snapshot itself, so a regeneration that forgets the filter fails the build
rather than shipping the URLs again. That check has its own reverse case.

The other repositories cited one or two times each in the case metadata
(`wuyoscar/GPT-Image2-Skill`, `zaizhi-1112/ai-image-extension-playbook`,
`openai/openai-cookbook`) are per-case source links recorded by the upstream
snapshots — attribution of where a prompt came from, not bundled content.

Since the six image references are gone, the `songguoxs/gpt4o-image-prompts`
entry above is kept only as the record of why that repository appears in the
`githubUrl` fields.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

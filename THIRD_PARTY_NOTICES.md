# Third-Party Notices

The bundled prompt snapshots under `src/templates/` include material from the
following projects. Image assets are not bundled; they are fetched on demand
from the URLs recorded in the snapshot metadata, so how stable those URLs are
matters:

- `handraw-cases.json` and `evolink-cases.json` pin an exact commit
  (`HANDRAW_COMMIT`, `EVOLINK_COMMIT` in `scripts/fetch-templates.mjs`), so they
  keep serving the revision that was reviewed.
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
  and GitHub reports no license for it (checked 2026-10-16).
- Referenced by 6 cases in `src/templates/prompt-signal-cases.json`, each in
  two fields: the `image` URL and the `githubUrl` link (branch `master`).

This one is listed because the URLs are in the shipped data, not because the
licence position is settled — it is not. See "Open question" below.

## Open question: the unlicensed image URLs

Six cases in `prompt-signal-cases.json` carry an `image` URL and a `githubUrl`
that point at a repository declaring no licence.

**What those six cases are, and are not.** The prompt text in all six is
**verbatim from the original authors' own posts** — checked case by case against
the X post already recorded in each case's `sourceUrl`, on 2026-10-16. The
snapshot's own `sourceLabel` and `sourceUrl` therefore already credit the real
author; the aggregator supplied only the preview image and the `githubUrl`
link. It is not the source of the prompts.

Nothing is redistributed from the aggregator either way: only URLs are stored,
and the image is fetched on demand. But the upstream never granted a licence,
so the two ways to settle it are still the maintainer's call:

1. Clear the `image` field of those six cases. Each case keeps its prompt text,
   its title, and its link to the original author's post, so it stays usable —
   the card simply shows the placeholder thumbnail. This is the option that
   removes the aggregator from the shipped data entirely.
2. Leave them and accept the reference as-is.

Pointing the images at the original authors' own media instead
(`pbs.twimg.com`) was investigated and is **not** a drop-in replacement: three
of the six posts carry four images each, so the specific image the snapshot
shows cannot be identified from the post alone, and that host is not reachable
from every network. If option 1 is taken, do not substitute those.

The other repositories cited one or two times each in the case metadata
(`wuyoscar/GPT-Image2-Skill`, `zaizhi-1112/ai-image-extension-playbook`,
`openai/openai-cookbook`) are per-case source links recorded by the upstream
snapshots — attribution of where a prompt came from, not bundled content.

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

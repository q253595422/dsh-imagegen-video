# Functional components

The bundle declares 13 Cordis loader entries: a shared core and twelve independent host components. Each has its own loader id and can be enabled or disabled through the host plugin manager.

| Entry | Responsibility |
| --- | --- |
| imagegen | Shared settings, channels, queues, subscriptions, updates and browser workspace |
| imagegen-image | Image generation, tasks/history, image tools and edit command |
| imagegen-video | Video generation, planning, tasks/history, code probe and video tools |
| imagegen-canvas | Canvas documents, assets, files, layers and canvas tools |
| imagegen-gallery | Gallery and model assets |
| imagegen-templates | Templates, favorites and periodic refresh |
| imagegen-skills | Canvas skills, skill library and host skill/agent bindings |
| imagegen-ppt | Editable PPT conversion |
| imagegen-ecommerce | Product-link extraction and listing copy |
| imagegen-outfit | Outfit references |
| imagegen-prompt | Prompt enhancement |
| imagegen-storage | Object storage and automatic upload hook |
| imagegen-diagnostics | Diagnostics and feedback signals |

## Package entry points

`main` and `exports["."]` point at the committed `index.js` at the package root, not at `lib/index.js`.

`lib/` is build output and is not in the repository, so a manifest aimed straight at it declares a runtime entry that does not exist until somebody runs `pnpm build`. Tooling that inspects the repository without building it -- package registries that check the declared entry exports `apply(ctx)`, for one -- reads the file the manifest names and finds nothing there. `index.js` is a two-line re-export of `lib/index.js` (`export *` plus an explicit `apply`), committed so the declaration always resolves, and `files` ships both it and `lib/`.

`scripts/verify-pack.mjs` closes both ends of that. The packed manifest is read back out of the archive and every entry point it declares, `main` included, must be a real file inside the tarball -- and it must be shipped by a `files` entry, not by the packer adding `main` on its own. The second half matters because npm and pnpm always pack `package.json`, the readme, the licence and the file named by `main`: with `"index.js"` removed from `files`, the archive still contained `package/index.js` and every content check stayed green. A `files` edit that drops either half therefore fails locally, before anything is published.

## Lifecycle

The core provides route definitions and runtime mounting hooks. Each feature registers its assigned routes, tools, commands and background hooks on its own context. Disabling a feature removes these registrations; removing the core suspends all dependent features. Shared queues and persisted data remain owned by the core. Disabling a feature does not cancel already submitted upstream jobs or delete records.

The browser remains one shared workspace under the root entry. The current host discovers browser bundles only from package roots. Subpath host entries therefore have no independent browser bundles; disabled features can still have visible controls. Internal workflows can also call shared helpers (for example a canvas skill generating media). These are public endpoint and tool lifecycle boundaries, not authorization boundaries for every internal operation.

## Loading and validation

Existing installations must load the updated package and recompose/reload its bundle to see the expanded roster. Building this checkout alone does not replace a separate registry installation in the running desktop host.

Run `pnpm test:components` for the real Cordis lifecycle and core integration tests; run `pnpm typecheck` and the normal regression suite for broader validation.

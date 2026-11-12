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

## Lifecycle

The core provides route definitions and runtime mounting hooks. Each feature registers its assigned routes, tools, commands and background hooks on its own context. Disabling a feature removes these registrations; removing the core suspends all dependent features. Shared queues and persisted data remain owned by the core. Disabling a feature does not cancel already submitted upstream jobs or delete records.

The browser remains one shared workspace under the root entry. The current host discovers browser bundles only from package roots. Subpath host entries therefore have no independent browser bundles; disabled features can still have visible controls. Internal workflows can also call shared helpers (for example a canvas skill generating media). These are public endpoint and tool lifecycle boundaries, not authorization boundaries for every internal operation.

## Loading and validation

Existing installations must load the updated package and recompose/reload its bundle to see the expanded roster. Building this checkout alone does not replace a separate registry installation in the running desktop host.

Run `pnpm test:components` for the real Cordis lifecycle and core integration tests; run `pnpm typecheck` and the normal regression suite for broader validation.

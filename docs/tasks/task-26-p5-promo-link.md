# task-26 P5 带货图文 + 商品链接抓取（降级版）

工作区：`/Users/malang/chajian/dsh-imagegen-video/.worktrees/p5`
分支：`task/p5`
已预置当前发版候选的全部内容（A+ 详情页 + 模特库加固），`npx tsc --noEmit` EXIT=0。直接在上面改，别去别的树。

## 0. 两件事，一件事一个做法

### A. 带货图文：配图 + 可粘贴的文案，**不让模型在图里写字**

生成 3:4 竖图（小红书/抖音/淘宝主图习惯），同时产出**一份能直接粘贴到平台的文案**（标题 / 正文 / 话题标签）。文案走已有的提示词增强通道，不要另造模型调用。

不要试图让模型把中文排进图里——那必然糊。文字排版是 task-25 在做的事，与本任务无关，不要引它、不要提前做。

### B. 商品链接抓取：宿主抓页面、抽结构化数据，**失败必须能回退手填**

粘贴商品链接 → 宿主 `fetch` 页面 → 抽 JSON-LD `Product` 与 `og:` 标签 → 回填商品名、卖点、参考图。抓不到就返回明确原因，UI 让用户手填，**不许静默失败、不许假装抓到**。

## 1. 硬约束

- 不新增任何 npm 依赖。HTML 解析自己写（正则 + 简单状态机即可，不要引入 cheerio/parse5）。
- **SSRF 防护是硬要求**，见 §3。
- 新增导航 tab 后，`scripts/smoke.mjs` 三处导航计数必须同步：当前是 11 / 8 / 11（8 个顶栏 tab），加第 9 个 tab 后为 **12 / 9 / 12**，文案里 `eight entries` → `nine entries`。
- 新增 UI 必须走主题 token；**不许使用不存在的 token 名**（`--dsw-alias-spacing-*` 系列不存在，间距写字面量）。
- 三语 i18n：zh / en / ru，键名前缀 `promo.` 与 `link.`。

## 2. A 部分规格

- 版式：`size` 固定 `3:4`，`n` 由用户选 1–4，`quality` 用户可选。
- 输入：商品图（可选，走 `image` 参考）、商品名（必填）、卖点（多行）、平台风格（小红书种草 / 抖音爆款 / 淘宝主图 / 得物干净感）、语言（复用现有 `ECOMMERCE_COPY_LANGUAGES` 的取值）。
- 提示词：按平台风格给不同的构图与调性描述（自己写，别只写「更高级」这种空词），并把卖点原句喂进去。
- 文案产出：一次调用返回结构化 JSON `{ title, body, tags: string[] }`，映射到现有 `PROMPT_ENHANCE_API.enhance`（`src/protocol.ts:85-88`、`src/routes.ts:995-1025`、`src/prompt-enhancer.ts` 的 `chatComplete` / `jsonPayload`）。解析失败要明确报错，不许返回半截 JSON。
- 文案卡：标题（≤20 字提示）、正文（可编辑 `<textarea>`）、标签（`#` 拼接）；提供「复制」按钮（`navigator.clipboard.writeText`，失败时回退 `document.execCommand('copy')` 并提示）。

## 3. B 部分规格（安全是重点）

路由：`POST /ecommerce/fetch-link`，body `{ url: string }`。

必须做：
- 只接受 `http:` / `https:`；其他协议直接 400。
- 用 `new URL()` 解析后拒绝：主机为 `localhost` / `*.local` / `0.0.0.0` / 裸 IP 落在私有段（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`127/8`、`::1`、`fc00::/7`、`fe80::/10`）。IPv4 用数值比较判断，不许字符串前缀乱匹配。
- `redirect: 'manual'`，最多跟 3 跳，**每一跳都重新做上面的主机校验**。
- 超时 8 秒（`AbortController`），响应体最多读 2 MiB（读的过程中按字节数中止），`content-type` 必须是 `text/html` 或 `application/xhtml+xml`，否则 415。
- 不跟随 `file:`、不带 cookie、`User-Agent` 写一个普通浏览器串。

抽取值：
- 优先 JSON-LD：`<script type="application/ld+json">` 里 `@type` 为 `Product`（含 `@graph` 嵌套）；取 `name`、`image`（字符串或数组）、`description`、`offers.lowPrice/price`。
- 回退 `og:title` / `og:image`（可多个）/ `og:description` / `<title>`。
- 返回 `{ ok: true, title, images: string[], sellingPoints: string[], price?: string, source: 'json-ld' | 'og' }` 或 `{ ok: false, reason: 'blocked-host' | 'timeout' | 'too-large' | 'not-html' | 'no-product-data' | 'fetch-failed' }`。
- `images` 必须是绝对 URL；相对路径用页面 URL 解析；只保留 `https:`/`http:`。
- **不许把远程图片下载进 models 目录**，只回填 URL 给前端当参考图入口（前端自己决定是否再取）。

前端：链接输入框 + 「抓取」按钮 + 状态行（抓取中 / 成功 / 失败原因的人话）。成功时回填商品名与卖点，图片列出来让用户勾选。失败时**明确显示原因**并保持手填路径可用。

## 4. 落点

- 新增 `src/client/PromoWorkspace.tsx`、`src/client/promo-prompt.ts`（纯函数：平台风格 → 提示词；文案 JSON → 校验后的对象）。
- 新增 `src/link-extract.ts`（纯函数：HTML 字符串 → 抽取结果，可单测；不许在里面 `fetch`）与路由实现放 `src/routes.ts`。
- `src/protocol.ts` 加路由常量（照现有 `XXX_API` 的写法）。
- 接线四处：`PanelWorkspace` 类型（`src/client/ImageGenPanel.tsx:632`）、`GooeyNav` items/activeIndex/onSelect（`:3127` 附近）、渲染处（`:3745` 附近）、import。

## 5. 必须自己测（数字写进报告）

1. `npx tsc --noEmit` EXIT=0、`npx tsdown` 过、`node scripts/smoke.mjs` → `SMOKE TEST OK`（PASS 数不许掉，当前 94）。
2. `src/link-extract.ts` 纯函数单测（Node 24 直接 `import` `.ts`，不用构建）：JSON-LD 单条 / `@graph` 嵌套 / 只有 og / 两者都无 / `image` 为数组 / `image` 为相对路径 → 六种输入的输出逐项断言。
3. SSRF 用例（用假 `fetch` 注入，不打真网络）：`http://127.0.0.1`、`http://169.254.169.254/latest/meta-data/`、`http://[::1]/`、`http://192.168.1.1`、`file:///etc/passwd`、`http://localhost:8791/v1/models`（**这条是本机 WorkBuddy 桥，必须被拦**）→ 全部 `ok:false / blocked-host`。
4. 真起 HTTP 服务跑路由：一个本地 fixture 页面（JSON-LD 齐全）→ `ok:true`；`content-type: application/json` → 415；响应体 3 MiB → `too-large`；超时 → `timeout`。
5. 负向对照：把主机校验函数改成 `return true`，第 3 组用例必须变红。**负向必须破坏真实的失效路径。**

## 6. 禁区

不许 `git commit` / `push` / `stash` / `reset` / `checkout` / `add`；不许跑 `pnpm test:negative`；验证输出只写 `/tmp/`；`pnpm build` 与 `pnpm test` 必须串行。

## 7. 交付

报告写：改了哪些文件、各多少行、路由签名、抽取结果类型、你自己的断言数字（含负向）、**以及你认为哪条规格有问题需要我裁决**。有问题照实写，别写「全部完成」。

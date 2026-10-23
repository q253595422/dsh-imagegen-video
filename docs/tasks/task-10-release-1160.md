# task-10 · 发布 1.16.0

派给：**金团**。这一轮是发版准备（版本号 + 发布说明 + CHANGELOG + 提交），**不改任何 `src/` 业务代码**（版本号字段除外）。

用户已明确授权推送（原话：「已经确认了 推送吧」）。但**推送这一步由我来做，你不要 push**。

## 你要产出的四样东西

| # | 文件 | 内容 |
|---|---|---|
| 1 | `docs/releases/v1.16.0.md` | 发布说明。`scripts/verify-pack.mjs:179` 强制要求存在，缺了 `pnpm pack` 直接 FAIL |
| 2 | `package.json` | `"version"` 改成 `"1.16.0"` |
| 3 | `src/protocol.ts` | `PLUGIN_VERSION` 改成 `'1.16.0'` |
| 4 | `CHANGELOG.md` | 在 `## Releases` 下、`### 1.15.3` 之上插入一节 |

**版本号必须两处一致。** `scripts/verify-pack.mjs:126` 读 `src/protocol.ts` 的 `PLUGIN_VERSION`，`:135` 与 `package.json` 比对，不一致就 FAIL。这是 `b5af2ae` 那次事故（1.15.3 推送 CI 在 smoke A3 挂掉）留下的守卫。

## 发布说明的写法

先读 `docs/releases/v1.15.3.md`，那是最好的范本。它的结构是：

```
# v1.15.3 — <一句话标题>
一句话概括：<一段话，说清用户看到什么变化>

## 为什么
<问题是什么、为什么会这样、为什么以前没被发现>

## 做了什么
- **<小标题>** <具体改动，带文件/函数名>

## 验证
<实测命令与数字>

## 影响面
<哪些用户会受影响、哪些不会>
```

**硬性要求：**

1. **中文。** 这版的用户是简体中文用户。技术名词保留英文（`ffmpeg`、`CSS Module`、`token` 名）。
2. **每个数字必须是你亲眼在命令输出里看到的，或者从任务书下方《事实清单》里抄的。** 不要估算，不要写「约」「大概」。想引用一个我没有给的事实，你就自己跑命令量，并把命令和输出贴进报告的「我量了什么」一节。
3. **不写营销话术。** 这份文件是给用户解释「这一版变了什么、为什么值得升」的，不是宣传稿。仓库里既有的 4 份 `v1.15.*.md` 都是这个调子，照着来。
4. **诚实记录缺陷与代价。** 比如视频行缩略图从 52 变成 54 这件事（见事实清单第 12 条），要写在「影响面」里。用户不喜欢被瞒。

## 事实清单（我逐条核实过，可直接引用）

### 规模

- 工作树改动：**38 个文件**，`2153 insertions(+), 1066 deletions(-)`（`git diff --stat`）。另有 12 个新文件已 `git add`（`git diff --cached --stat`：`2498 insertions(+)`）。
- 其中 `src/client/` 下 **18 个 `*.module.css`** 文件被改。
- `src/client/panel.module.css` 单文件 `+462/-…`（`git diff --stat` 那一列）。
- `src/client/sidebar-entry.ts` **+289**、`src/client/mount.tsx` **+152**、`src/client/ImageGenPanel.tsx` **+142**。

### 新增的能力（不是重写，是新东西）

1. **`docs/native-ui-contract.md`（319 行）** —— 把「什么叫看起来像原生」写成可检查的规则：圆角按角色选 token、字号必须落在宿主刻度上、颜色只能取 `--dsw-alias-*`、不许猜宿主 class 名。§2.2 圆角表、§2.4 排版、§4.3 CSS 怎么找到宿主元素。

2. **`scripts/verify-native-ui.mjs`（306 行）** —— 上面那份契约的执行器，8 条规则（原文见 `:317-325` 的 `RULE_TEXT`）：
   ```
   no-literal-color     字面色 → 必须用 --dsw-alias-* token
   no-literal-shadow    字面阴影 → --dsw-shadow-lv* / --dsw-elevation-*
   radius-from-token    硬编码圆角 → --dsw-radius-xs|sm|md|lg|xl|panel（999px 例外）
   font-size-on-scale   字号不在宿主刻度 → 10|11|12|13|14|15|16|18|20|22|24|26|28px
   no-os-theme-query    prefers-color-scheme → 宿主主题是 body[data-ds-dark-theme]
   token-must-exist     用了 DSH 没定义的 token
   no-dom-class-guessing [class*=] 选择器 → 注册 slot
   theme-from-service   从 DOM/matchMedia 读主题 → 注入 theme service
   ```
   已接进 `pnpm test`（`package.json` 的 `test` 脚本里，`verify-reproducible` 之后、`smoke` 之前）。

3. **`scripts/studio-preview.{tsx,ts,mjs}` + `studio-preview-shot.mjs`** —— 一条命令 `pnpm studio:preview` 把整个面板构建成单文件预览包，再用真 Chrome 出明暗两态截图并做五类页内审计。产物 `/.studio-preview/` 已进 `.gitignore`（6MB 预览包不进仓库）。

4. **`src/video-poster.ts`（103 行）+ `src/video-tools.ts`（149 行）** —— 视频封面抽帧。`ffmpeg` 在**时长的 10%** 处抽一帧，缩到 320 宽存成 JPEG。为什么不是首帧：首帧常是黑场或转场（实测 10 个 clip 的 YAVG 证明首尾亮度差异不足以判断「首帧可用」）。

5. **`src/video-store.ts` +229 行** —— 封面落盘（`posterFile` 字段，`<clip名>-poster.jpg`）、老记录惰性回填、`posterFailures` 失败记忆。

### 修掉的缺陷（用户能感觉到的）

6. **视频历史记录没有封面**（用户直接报的）。此前 `ImageGenPanel.tsx:583` 注释写着「A clip has no poster frame of its own」——设计上就漏了。现在宿主侧抽帧存盘，前端渲染 `<img>`；没封面的行保留原来的胶片图标。

   **关键前提，必须写清楚**：宿主只保证**终局正确**，第一次响应永远是 0 封面（`drainVideoPosters()` 不阻塞响应）。前端在回填完成后补取一次列表，用户才会看到封面浮现。详见第 9 条的三个缺陷。

7. **侧栏插件条目认不出宿主** —— `sidebar-entry.ts` 原先靠 `[class*="logoRow"]` 这类 class 名猜，宿主每次发版 CSS Module 的 hash 都变，一改名就静默失效。现在改从 **slot 锚点** 解析：`[data-slot="sidebar.workspaces"]`、`[data-slot="sidebar.brand.mark"|"sidebar.brand.name"]`、`[data-slot="sidebar.footer.action"]`、`[data-slot="sidebar.settings"]`。锚点是 `@deepseek-ai/dsh-client-ui-renderer` 写进 DOM 的契约（`<div data-slot="<key>" style="display: contents">`），class 名才是构建期哈希。

8. **中间栏接管同样改为锚点解析** —— `mount.tsx` 新增 `MAIN_SLOT_ANCHOR = '[data-slot="main"]'` + `boxAncestor()`（跳过 `display: contents` 的锚点，取真正画盒子的祖先）。旧逻辑匹配 `[class*="centerCol"]`，宿主一改名整套接管就静默消失。加了 `data-dsh-imagegen-center-col` 自有标记让样式表只依赖自己的属性。

9. **回填永不完成**（我实测发现，两次派工才修净）—— 三个叠在一起的缺陷：
   - `BACKFILL_BATCH = 3`，每次 `historyList` 只补 3 条；而前端 `initialDataRequestedRef` 让 `loadInitialData()` **一个面板生命周期只跑一次**，开关面板不卸载组件、ref 不重置 ⇒ 第二次请求永远不发生 ⇒ 30 条历史最多 27 条永久无封面。改成 `drainVideoPosters()`：一次请求内把积压排空。
   - `void backfillVideoPosters()` 没有 `.catch`，unawaited rejection 落到宿主的 fail-loud handler，会 `proc.exit(1)`。补了 `.catch`（`src/routes.ts:2502`）。
   - 一条坏 clip 会卡住队首永远重试。加了模块级 `posterFailures: Set<string>`（`src/video-store.ts:340`），失败的跳过、成功的清除。

10. **主题切换后导航文字不可读** —— `surface-theme.ts` 原先监听 `prefers-color-scheme` 媒体查询，但 DSH 自己解析 `system` 并把结果写到 `body[data-ds-dark-theme]` 上，媒体查询是**第二个真相来源**，可能和实际画的调色板打架。改成只监听宿主真正写的属性（`data-ds-dark-theme`、`data-ds-theme-source`、`style.color-scheme`、`class`、`data-theme`）。

11. **聊天分隔条拖拽泄漏** —— 拖拽中绑的三个 window 监听 + `<html>` 上的 `cursor`/`user-select` 在元素销毁后没人解绑。新增 `stopResizerDragWatch` 由 mount 生命周期持有释放权。

### 依赖升级

12. **`@deepseek-ai/dsh-client-ui-primitives` `0.1.2-alpha.2` → `0.2.1-rc.2`** —— 插件原来声明的是旧版，宿主实际提供的是 0.2.1-rc.2。差别是真实的：旧版 `Button.module.css` 硬编码 `14px/18px` 圆角，新版是 `var(--dsw-radius-md)` / `var(--dsw-radius-sm)`（12px/8px），与契约一致。

13. **新增 3 个 `0.2.1-rc.2` 系列的 devDependencies**：`dsh-util-code-language`、`dsh-util-workspace-path`（第 12 条的传递依赖），外加把 0.2.1 运行时需要的打包依赖显式补进 devDependencies —— 因为 `primitives@0.2.1` 的 `dependencies` 是空的（全放进了 `devDependencies`），单独打包会退化成未解析的全局变量。这条要写，它是真陷阱。

### 代价（必须写进「影响面」）

14. **视频行缩略图盒子从 52×52 变成 54×54。** `.historyThumbPlaceholder[data-video-thumb]` 从 HEAD 起就有 `border: 1px solid var(--dsw-alias-border-l1)`，但 `.panel *` 的 `box-sizing: border-box` 够不到它 —— 历史列表被 `createPortal` 到了宿主侧栏，在 `.panel` 子树之外，而宿主自己的 CSS 里 universal box-sizing 规则数是 **0**。所以 HEAD 时它就是 54×54（内容盒 52 + 左右各 1px），只是没人量过。这一版补了 `box-sizing: border-box`，让两类行的缩略图盒真正相等（都是 52×52 边框盒）。净效果：视频行比之前小 2px。

15. **`.pptBadge` 对比度**从 3.92:1 修到 5.53:1（amber-600 底 + amber-900 字）。原先是白字，2.79:1 低于 3:1。

### 验证（我跑过的，你可以直接引用）

```
pnpm typecheck                                   EXIT=0
pnpm build                                       EXIT=0   client 6.55 MB
DSH_ASAR_DIR=… node scripts/verify-native-ui.mjs PASS  native-UI contract: no violations.  EXIT=0
pnpm test                                        EXIT=0   UI CONTRACTS VERIFIED
```

三条负向验证（把修复逐条回退，断言各自 FAIL / EXIT=1）：
- 抽掉 `.historyThumbPlaceholder[data-video-thumb]` 的 `box-sizing:border-box` → `FAIL the fallback thumbnail box is 52×52 {"w":54,"h":54}`
- 抽掉 `posterFailures.add(...)` → 5 次调用全 `filled=0 0/6`（队首阻塞永久卡死）
- 抽掉 drain 的收敛判据 → 回填永远补不满

### 老数据行为

用户本机 `~/.dsh/dsh-imagegen/videos/` 现有 **10 个 clip**，`index.json` 里一个 `posterFile` 都没有。升级后首次打开面板：先看到 10 个胶片图标 → 宿主在后台抽帧（实测 10 条共 1344ms）→ 前端补取列表 → 变成封面。

## 不许做的事

1. **不许 `git push`。** 提交完就停，推送我来做。
2. **不许改 `src/` 下任何非版本号字段。** 这一轮只动 4 个文件（见上表）+ `git add`。
3. **不许 stash / reset / checkout / revert。** 工作区 48 项改动是几十轮工作的产物，一项都不能丢。
4. **不许跑 `test:negative`。** 它会临时改源文件再恢复，在发版前跑这个风险不值得。
5. **不许改 `scripts/verify-native-ui.mjs`。** 它的两处已知盲区（`token-must-exist` 对带 fallback 的假 token 报错文案不准；不校验选择器语法）用户还没裁决。
6. **`pnpm test` 里的 `verify-tracked` 会检查未跟踪文件。** 4 份任务书（`docs/tasks/task-6..9.md`）目前未跟踪，`docs/` 不在它的检查范围内（只查 `src/` 和 `scripts/`），但提交时要一起 `git add`，别落下。

## 交付报告要求

1. 四个文件的完整改动（`git diff` 原文，不要摘要）。
2. 你为写说明而自己跑的命令 + 输出原文（如果有）。
3. `pnpm typecheck` / `pnpm build` / `pnpm test` 三条的 EXIT 码。
4. 提交后的 `git log --oneline -2` 与 `git status --short`（应该只剩 0 项）。
5. **如果发现我这份事实清单里有任何一条是错的，直接指出来，不要顺着写。** 上一轮金团报告漏前提、界团夹具自证，都是靠这种互查才发现的。

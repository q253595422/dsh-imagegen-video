# task-27 — 侧栏入口在「壳层 New Session 被他人隐藏」时消失

## 现象（用户 2026-10-24 20:27 报）

「最新版打开 dsh 未发现插件入口了」——桌面 DSH 里完全找不到生图入口，9 个 tab 一个都看不到。

## 已由我（团团）实测定位的根因

1. 插件本体是好的：带 cookie 打开 `http://127.0.0.1:50657`，`ul` 里 9 个导航项都在，`[data-workspace]`、面板、导航齐备。面板 `display:none` 只是因为没打开。
2. 入口挂点找不到落点。`src/client/sidebar-entry.ts:302` 的 `placeTabs()` 只往「壳层 New Session 按钮的上方」插节点，`newSessionButton()` 要求按钮 `isVisible()`。
3. `ds-bot@0.2.0`（`~/.dsh/profiles/desktop/node_modules/ds-bot/client.js`）注入了一张「Shell chrome reshaped for the team view」样式表，把壳层侧栏的 New Session、panelList、brand 全部 `display:none!important`。真机上是它把 `button.kB3qhq_newSession` 打成 `display:none`（我用 CDP `CSS.getMatchedStylesForNode` 抓到这条规则，来源确认是 ds-bot）。
4. 同时壳层的可见侧栏里 `logoRow` / `newSession` / `panelList` 全是 `display:none`，只有 `regionArea`（272×830，ds-bot 的机器人列表）和 `footArea` 是可见的。所以插件一个落点都没有。
5. 这事跟 1.17.0 无关：`sidebar-entry.ts` 自 1.16.0（`9adcdaf`）之后没再改过。ds-bot 从 10/21 起就这个行为。

## 目标

壳层 New Session 按钮不可见时，入口仍然要出现，并且**不许**动 ds-bot 或壳层的任何文件、不许猜 ds-bot 的类名（`bt-*`）。

## 落地方式（我已在真机用 DOM 注入验证过落点可行）

`placeTabs()` 加一条兜底：

- 优先走原路径（找到可见的 New Session 按钮 → 插在它上面），行为一字不改。
- 找不到可见按钮时，退到「侧栏根节点的第一个子节点」：`sidebarRoot()` 已返回那个可见列（真机 `div.kB3qhq_root`，280×900，flex column），把 `tabs` 作为首个子节点插入。
- 兜底插进去的行必须仍然带 `data-dsh-imagegen-session-tabs`，点击 Image → `controller.open()`，点击 Session → `controller.close()`，`syncActive()` 的高亮照旧。
- 兜底位置加一个自有标记（例如 `tabs.dataset.dshImagegenTabsSeat = 'top'`），CSS 只认这个标记来做宽度/内边距，不要影响原位置样式。
- `ensure()` 的幂等与自愈要保住：React 重建后不许重复插、不许丢。真机实测落点尺寸：256×35，`x=12,y=6`，侧栏 `scrollHeight` 不溢出。

## 验收（必须你自己跑，贴原始输出）

1. `npx tsc --noEmit` EXIT=0；`npx tsdown` EXIT=0。
2. `node scripts/verify-native-ui.mjs` PASS（新增 CSS 不许引入 hex/rgb/非法字号，用 `--dsw-*` 既有 token 或 0/百分比）。
3. `node scripts/smoke.mjs` SMOKE TEST OK，且**新增一条断言**：夹具里把壳层 New Session 按钮设成 `display:none`（模拟 ds-bot），入口仍挂载、可见、宽度 > 0，点击后面板打开。
4. **负向对照**：把兜底分支临时去掉，第 3 条新断言必须变红；改回来必须绿。贴两次输出。
5. 不许跑 `pnpm test` 与 `pnpm test:negative`；不许 `git commit / push / add / stash / reset / checkout`；产物只写 `/tmp/`。

## 交回时告诉我

改动文件 + 行号、兜底判据、第 3/4 条的原始输出、以及你没做到的部分。

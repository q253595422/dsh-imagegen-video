# task-12 — 结果板互斥 + 历史详情补全

**两个独立缺陷，同一个文件 `src/client/ImageGenPanel.tsx`。可以一起做。**

先读完全部事实再动手。Lead 已经把根因定位到行号，但**每一行你都要自己打开确认**，不要凭这份文档下判断。
如果你发现我没写到的路径，或者我的结论不成立，**直接在报告里说，不要顺着写**。

---

# 缺陷 A：点图片历史时，视频板不消失（两个结果同时显示）

## 用户原话
> 生成视频后查看历史记录 是能看到 但如果我点击别的 会同时出现两个视频或者图片的历史记录
> 应该是我点击一个就只能看到当前的历史记录

## 根因（Lead 已核实，你复核）

结果板上有两个互不排斥的渲染分支：

```tsx
// :4019  视频板
{isGeneration && viewingVideoEntry !== null ? (
// :4059  图片格
{isGeneration && !generating && images.length > 0 ? (
```

`viewingVideoId`（驱动 `viewingVideoEntry`，定义在 `:2598`）全仓只有 3 处会写：

```
:923   useState(null)                    // 初始
:2055  setViewingVideoId(entry.id)       // openVideoFromHistory，打开视频
:2085  setViewingVideoId(null)           // 删掉那条视频
:2138  setViewingVideoId(null)           // clearHistory，清空全部
```

**点击图片历史（`viewHistoryGroup` :2013、`viewGalleryEntry` :2362、`onChatImages` :1305、`startNewCreation` :2114）都不清 `viewingVideoId`。**
于是 `viewingVideoId` 还留着 → 视频板成立；`images` 也被填了 → 图片格也成立；两块同时画。

反方向没有这个问题：`openVideoFromHistory` :2051 有 `setImages([])`、:2053 有 `setViewingHistoryId(null)`。
**这个不对称就是缺陷。**

## 要求

结果板只能有一个「当前视图」。实现方式你自己选，但必须满足：

1. 画面上任何时刻，视频板和图片格**不可能同时存在**（用互斥的条件保证，而不是靠各处记得清另一个 state —— 那是同一个 bug 的温床）。
2. 点视频历史 → 只显示视频；点图片历史 → 只显示图片；点画廊条目 → 只显示那张；`startNewCreation` → 都不显示。
3. 交给空状态 `InspirationGallery`（:4009）的判据也要跟着对：现在它写的是
   `images.length === 0 && viewingVideoEntry === null`，你改完之后它仍然只应「什么都没选中时」出现。
4. 侧栏高亮（`:2740-2741` 的 `isActive`）必须跟着一起对：只有当前真正显示的那一行是 active。

**约束**：不要用「在 5 个地方各补一行 `setViewingVideoId(null)`」的方式修。那正是现在这个 bug 的成因（有人漏了一处）。
选一个**结构上不可能再漏**的方案，在报告里说明你为什么认为它不可能再漏。

---

# 缺陷 B：打开历史后看不到 提示词/尺寸/清晰度/张数/细节

## 用户原话
> 问题生成完成图片 视频查看历史对话，历史丢失无相关：提示词，尺寸、清晰度、生成张数、细节

## 事实（Lead 已核实）

**数据一直都在，只是从来没渲染过。**

`src/protocol.ts:1866` 的 `HistoryEntry` 上这五个字段全都有：
```ts
prompt: string
size: string
quality: string
detail: string
n: number
```
宿主 `history-store.ts` 一直在存。

但前端：
- 侧栏行 meta：`imageRowOf` :669 只拼 `图片 · 3 张`；`videoRowOf` :650 只拼 `16:9 · 720P · 5s`
- 结果板顶部 `:4060` 的 `.canvasMeta`：只有 `本次生成 3 张` + `历史 · 时间`
- 图片下方 :4091 只在**上游返回 `revisedPrompt`** 时才显示 figcaption

**所以用户看不到尺寸/清晰度/细节/张数。**

## 要显示的（图片历史）

结果板顶部 `.canvasMeta` 那一行（:4060 附近）要能读到：

| 字段 | 来源 | 显示要求 |
|---|---|---|
| 提示词 | `entry.prompt` | 完整显示，长了要能换行或省略+title，不许截断到看不清 |
| 尺寸 | `entry.size` | 用已有 i18n（`size.*` 系列，`src/client/locales.ts:410-418`），**不是原始值** |
| 清晰度 | `entry.quality` | 用 `normalizeQuality()`（`:200`）归一再显示 |
| 生成张数 | `entry.n` | |
| 细节 | `entry.detail` | |

- 已有 i18n key：`params.size` / `params.quality` / `params.count` / `params.detail`（`locales.ts:406-409`，中英都有），**直接用，不要新建同义 key**。
- 老数据兜底：`normalizeSize()` :194、`normalizeQuality()` :200 已存在，必须用它们。
- 对比组（`group.entries.length > 1`）时，五个字段取 `group.entries[0]`，并在报告里说明这样是否会误导（比如不同模型 n 不同时）。

## 要显示的（视频历史）

现在视频板 :4023 只有 `历史 · 时间`，figcaption :4051 只有 `模型 · 比例 · 秒数`。缺：

| 字段 | 来源 |
|---|---|
| 提示词 | `entry.prompt`（**最重要，现在完全看不到**） |
| 分辨率 | `entry.resolution`（figcaption 里有吗？自己确认） |
| 模式 | `entry.mode` |

## 样式约束（不遵守会被守卫或测试打回）

- 只能用 `docs/native-ui-contract.md` §2 列出的圆角 token（`--dsw-radius-xs/sm/md/lg/xl/panel`）
- 字号：原生 89% 是硬编码 px，11% 是 `var(--dsh-content-font-size, 14px)`，按契约 §2.4
- 颜色只用 `--dsw-alias-*` / `--dsw-static-*`，不许写裸 hex
- 不许写 `data-dark` 之类的新属性去选择主题（上一轮的教训：写了 `data-dark` 但 CSS 还选 `[data-theme=...]`，守卫夹具自己复制了那行所以照过）

---

# 共同约束（违反任何一条都算没做完）

- **不许改 `src/client/panel.module.css`** —— 另一个人（金团）没在改它，但 Lead 要单独验收这个文件，你先只改 TSX，样式用**已存在的 class**。如果确实需要新 class，在报告里列出「需要哪条规则、加在哪个位置」，让 Lead 决定。
  - 例外：如果某条已存在的 class 语义不对（比如拿 `.canvasMeta` 硬塞提示词），可以用 inline style 做一次性兜底，但报告里必须说明这是临时方案。
- **不许碰 `tsdown.config.ts` / `scripts/verify-reproducible.mjs`** —— 金团在 task-11 里改，你碰了必冲突
- 不许 commit、不许 push、不许 stash、不许 reset、不许 checkout
- 不许跑 `pnpm test:negative`
- **`pnpm build` 和 `pnpm test` 必须串行**，不许放同一个并行块（上一轮的教训：build 写 `lib/`，test 读 `lib/`，并行跑出过假的 SMOKE TEST FAILED）

# 完成标准

```
pnpm typecheck      EXIT=0
pnpm build          EXIT=0
DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs   -> PASS  EXIT=0
pnpm test           EXIT=0
```

**外加一个能证明缺陷 A 真被修掉的浏览器断言**（不接受「我看了代码觉得对」）：

- 在 `.studio-preview/` 下加一个探针（该目录在 `.gitignore:18`，不会进提交），复用 `scripts/lib/headless-chrome.mjs` 的 `findChrome` / `launchChrome` / `openPage`
- 场景：先挂载面板 → 调 `videoHistoryList` 返回 1 条 clip → 点视频行 → 断言 `[data-video-board]` 存在且图片格不存在 → 再 `historyList` 返回 1 条图片 → 点图片行 → **断言 `[data-video-board]` 不存在且图片格存在**
- 这个断言必须在**改动前 FAIL、改动后 PASS**。两个状态的原文都贴进报告（先 stash 不行的话，用 `git stash` 不许，那就先跑一遍记录 FAIL 再改）。

# 报告格式

1. 缺陷 A：你选的方案、为什么它不可能再漏、改动 diff
2. 缺陷 B：五列对照表 `字段 → TSX 位置 → 显示文案（中英两态）→ 老数据兜底值`
3. 断言：改动前 FAIL 原文 + 改动后 PASS 原文 + 两条命令的 EXIT
4. 四条命令输出
5. `git status --short` 原文
6. 你认为我上面哪条判断不对（有就说，没有就写「无」）

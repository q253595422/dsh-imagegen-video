# task-15 — 结果板互斥在第 4 条路径上仍然失效（真实缺陷）

## 0. 这是我实测复现的，不是推测

你上一轮说「物理上不可能」：`BoardView` 判别联合让同一个值上判两个 `kind` 编译不过。这一点我接受，也确实成立。

**但它只证明了 `boardView` 只有一个值，没证明「图片格会去读 `boardView`」。**

`src/client/ImageGenPanel.tsx` 当前（`ed02aa1e…`）：

```
:4053   {isGeneration && viewingVideoEntry !== null ? (      ← 视频板，只看 viewingVideoEntry
:4101   {isGeneration && !generating && images.length > 0 ? (  ← 图片格，只看 images
```

`viewingVideoEntry` 派生自 `boardView`，但 `:4101` **完全不读 `boardView`**，只读 `images.length`。而 `images` 不归 `boardView` 管。

于是只要有一条路径在「`boardView` 是 video」的同时把 `images` 填上，两块板就再次同时成立——和修之前一模一样。

## 1. 我找到的那条路径：生成完成

`src/client/ImageGenPanel.tsx:1431`（轮询发现任务完成）：

```ts
if (completed?.result !== undefined) {
  setImages(completed.result.images)
  if (completed.result.history !== undefined) setHistory(completed.result.history)
  setError(completed.result.historyError ?? null)
}
```

它写 `images`，**不写 `boardView`**。

全部 `setImages` 调用点（6 处）里，只有 `:1345`（chat 图片）会在同一分支里 `setBoardView(null)`；`:1431`、`:2058`、`:2082`、`:2145`、`:2397` 都不清。其中 `:2058`/`:2397` 是打开历史/素材库，紧接着自己写了 `boardView`，没问题；`:1431` **没有任何人接手**。

复现路径（用户能真实走到）：打开一条视频历史 → 之前提交的生成任务完成 → 图片格和视频板同时出现。

## 2. 我的探针（我自己写的，在仓库外）

`/private/tmp/probe-gen/`：

```
config.ts      复用 scripts/studio-preview.config.ts，只换入口与输出名
entry.tsx      真实 mountPanel + mountSidebarEntry + ImageGenPanel + 真实 primitives + 真实 DSH token
               唯一伪造：宿主应答。taskList 改成读 globalThis.__probeTasks，可控
probe.mjs      渲染断言
build：node <repo>/node_modules/tsdown/dist/run.mjs --config /private/tmp/probe-gen/config.ts
运行：node /private/tmp/probe-gen/probe.mjs
```

探针做的事：点开 `clip-b` 这条视频历史 → 让一次生成「完成」（往 `__probeTasks` 塞一条 completed 摘要，`__probeFull` 塞它的 result）→ 等 4 秒 → 量两块板。

**改动前（当前工作区 `ed02aa1e…`）实测 FAIL：**

```
  start          videoBoard=false imageGrid=false
  PASS  a clip history row was clicked
  on clip        videoBoard=true imageGrid=false

  after gen      videoBoard=true imageGrid=true imageCount=1 videoPlayers=1
  videoText      "视频历史 · 2026-10-24 02:59clip-b 老片段分辨率 720p加入画布加入对话下载agnes-video-2.5-flash · 9:16 · 5s"
  imageText      "本次生成 1 张点击预览加入素材库加入对话下载"
  FAIL  THE DEFECT: a finished generation does not put the image grid beside the open clip  videoBoard=true imageGrid=true imageCount=1 videoPlayers=1

FAIL  1 probe assertion(s) failed:
```

`videoBoard=true` 且 `imageGrid=true`，两个播放器/图片同时挂着。这正是用户报的「同时出现两个视频或者图片的历史记录」。

## 3. 要你做什么

### 3.1 硬要求：修在派发处，不修在写入处

我上一轮已经禁止「在 N 个地方各补一行 `setBoardView(null)`」。`images` 有 6 个写入点，补 6 行就是把今天这个 bug 原样再种一遍。

**要求：让「图片格能不能画」由 `boardView` 决定。** 最小形态类似：

```ts
{isGeneration && !generating && images.length > 0 && boardView?.kind !== 'video' ? (
```

但**不要照抄我这个写法**——你自己判断哪一种能保证「以后再加第 4、第 5 个板面时，漏掉互斥会被编译器或类型挡住」，而不是靠人记得。如果 `BoardView` 判别联合能扩展成一个 `kind => 该画哪个板` 的穷尽映射（`switch` 带 `assertNever`），那比散在 JSX 里的条件更好。你上一轮已经建立了单一 `setBoardView`，这轮把这个思路补完到**渲染侧**。

### 3.2 不要顺手改行为

**不要**让「生成完成」自动把结果板切到新生成（即不要清 `boardView`）。理由：那是另一条产品决策，而且会把「用户正在看的老视频被顶掉」变成新问题。这轮只解决「两个同时出现」。用户当前的预期是「点一个只能看到当前那一个」，不是「新生成自动抢屏」。

如果你认为这条决策错了，直接说理由，但**不要在代码里替我做**。

### 3.3 自己证明两头

1. **改动前必须 FAIL**：用我的探针，或者你自己等价的一个，先跑出上面那段 FAIL 原文。不许只跑改动后。
2. **改动后必须 PASS**：`videoBoard=true imageGrid=false`，且 `videoPlayers=1`。
3. **反向也要证明**：关掉视频板之后，新生成的那张图必须能正常显示。即「排除」不能变成「图永远看不到」。
4. **我原有的 41 条断言必须一条不少地继续 PASS**：`node /private/tmp/task12-assert/assert.mjs`（先跑 `build.mjs` 重建 `app.js`）。你的改动如果让其中任何一条变红，说明修坏了别的东西。

### 3.4 顺带确认（只要回答，不必改）

`:4053` 的视频板**没有 `!generating` 守卫**，`:4101` 的图片格有。所以「正在生成时打开一条视频历史」会同时画视频板和 `canvasState` 加载态。这算不算要一起处理，你判断并说明——**如果改，必须有断言覆盖；如果不改，说明为什么现在的行为是对的**。

## 4. 禁区

- 不许碰 `src/client/panel.module.css`（CSS 归我验收）
- 不许碰 `tsdown.config.ts`、`scripts/verify-reproducible.mjs`（金团地盘）
- 不许 commit / push / stash / reset / checkout
- 不许跑 `pnpm test:negative`
- 验证输出只写 `/private/tmp/`

## 5. 交付

报告里我要看到：

1. `git diff --numstat src/client/ImageGenPanel.tsx` 原文，以及**属于本轮**的 hunk 列表（标明哪些是别人/前几轮的）
2. 改动前后的探针输出原文（含 EXIT 码）
3. `node /private/tmp/task12-assert/assert.mjs` 的 PASS/FAIL 汇总行
4. 你选的那种写法的理由——特别是「以后加板面漏了互斥，凭什么会被挡住」
5. 3.4 那个问题的回答
6. `typecheck` 与 `build` 的 EXIT 码

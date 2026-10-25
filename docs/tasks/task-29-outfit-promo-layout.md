# task-29 — 服饰穿戴 / 带货图文 没有界面（把两个工作台做到 Replica / A+ 的完成度）

## 现象（用户 2026-10-24 22:29 截图报障）

用户在真宿主里点「服饰穿戴」，看到的是**一屏未排版的原生控件**：

- `.root` 的 11 个直接子元素全是裸元素：裸 `<h2>`、裸 `<p>`、裸 `<button>`、
  裸 `<input>`、裸 `<select>`、裸 `<label>`；
- 两个 `DIV.S7oYFW_grid` 高度为 0；
- 按钮高 22px，全部沿页面左缘堆成一列。

点「带货图文」，七件控件（链接框、抓取按钮、商品名输入、卖点 textarea、
平台 select、生成按钮、「小红书种草 v 生成 3:4 带货图文」）**全部挤在
y≈136–180 的同一行**，右侧画布区整片空白。

## 根因（两条，必须一起修）

### 1. 样式本身只有骨架

- `src/client/OutfitWorkspace.tsx` 45 行，`PromoWorkspace.tsx` 14 行，
  两者共用 `src/client/outfit-workspace.module.css`，而该文件**只有 10 行**：
  `.root / .grid / .card / .selected / .thumb / .actions / .muted / .error /
  .results / .result`。没有排版、没有分栏、没有面板头、没有空态。

### 2. 生成的宿主容器没有本工作台的占位规则

`src/client/panel.module.css:862-871` 只给 `canvas` 和 `ppt` 写了：

```
.generation[data-workspace='canvas'], .generation[data-workspace='ppt'] { display:flex; height:100% }
.generation[data-workspace='canvas'] > .config, ... > .canvas,
.generation[data-workspace='ppt']  > .config, ... > .canvas { display:none !important }
```

`outfit` / `promo` 两条**没有**。结果是：经典 config 侧栏（300px）和执行结果区
仍然占着位置，本工作台的 `.root` 被挤成一条 2px 宽的缝 → 控件换行成一列、
`grid` 高度算成 0。这就是截图上「没有 UI」的直接原因。

**修法照抄 `src/client/replica-workspace.module.css:23-31` 与
`aplus-workspace.module.css:15-23`**（那份注释解释了为什么必须用全局属性选择器
而不是 CSS module 类：`.generation` 会被 hash 成 `WKhQka_generation`）。
写在本工作台自己的样式表里，**不要改 `panel.module.css`**（有别人在改它）。

```
:global([data-workspace='outfit']) {
  display: flex;
  height: 100%;
  flex-wrap: nowrap;
}
:global([data-workspace='outfit']) > :not([data-outfit]) {
  display: none !important;
}
```

`data-outfit="true"` / `data-promo="true"` 已经在根节点上了，直接用作标记，
**不要**再造一个 `data-outfit-workspace` 之类的第二套属性（replica 那套是历史
包袱，不必跟）。两条规则各写一份，`outfit` 和 `promo` 分别对应。

## 目标：对齐 Replica / A+ 的完成度

参照样板（**先读，再动手**）：

- `src/client/ReplicaWorkspace.tsx` 552 行 + `replica-workspace.module.css` 427 行
- `src/client/AplusWorkspace.tsx` 523 行 + `aplus-workspace.module.css` 422 行

要具备的骨架（两者都按这个做）：

1. `.root`：`display:flex; flex-direction:column; flex:1; min-width:0;
   min-height:0; height:100%; gap:14px; padding:14px 16px 18px;
   overflow:hidden; container-type:inline-size;`（容器查询，不是 `@media`——
   panel 在壳层中列，视口宽度不等于面板宽度）。
2. `.intro`：左 `h2` 标题 + 一行说明，右上一个状态/主操作位。
3. `.body`：`grid-template-columns: 340px minmax(0,1fr); gap:14px;`，
   窄容器（`@container`）降为单列。
4. `.form`：左列，带边框/圆角/底色，内部纵向 `.field` 流。
5. 每个 `.field` 一套 `.fieldHead > .fieldLabel + .fieldNote`，
   控件本体在下面——**不要**再把 label 文字和控件挤在同一行。
6. 右列 `.results`：空态 `.empty`（一句「生成结果会出现在这里」）+
   结果网格 `.outputs > .output`。
7. `.submitBar`：按钮 + 右侧一行提示，固定在表单底部（`margin-top:auto`）。

### 服饰穿戴 具体分区

| 分区 | 内容 |
|---|---|
| 服装图 | 4 格缩略图条（`.thumbs > .thumb`，带序号角标 + 删除按钮）+ 添加入口（虚线投放区样式，照 `replica` 的 `.drop`）。`count` 用现有 `outfit.uploadClothes` 的 `{count}/4` |
| 模特 | 三选来源 pill（`role="radiogroup"` + `aria-checked`，语义与 replica 的 `.pills`/`.fact` 一致）：模特库 / AI 生成 / 上传新模特。三态各自的内容区：库为 `.grid` 封面卡（选中态 `.selected`）、AI 为描述框 + 生成按钮、上传为投放区 |
| 场景 | 现有 `<select>` 保留（9 个预设），放进 `.field` |
| 参数 | 比例 3:4 / 1:1 / 9:16 与分辨率 1K / 2K 各一组 pill（现在是把文字和按钮混在一个 flex 里，必须拆成 `.fieldLabel` + pill 组） |
| 提交 | `outfit.generate`，禁用条件不变 |
| 结果 | 空态 + 网格 |

**功能一行都不许改**：`uploadClothes` 的 4 张上限、`MAX_BYTES` 20 MiB、
`api.modelSave` / `api.modelImage` / `api.generate` 的调用参数、`modelMissing`
的禁用逻辑、`outfit.consistency` 那行免责声明，全部原样保留。

### 带货图文 具体分区

| 分区 | 内容 |
|---|---|
| 商品链接 | `link.placeholder` 输入 + `link.fetch` 按钮同一行（`.inline`），下面是抓取状态 |
| 商品信息 | `promo.productName` 单行 + `promo.points` 多行 textarea |
| 平台 | 现在是一个 `<select>` 四项。改成 4 个 pill（`role="radiogroup"` + `aria-checked`），文案沿用现有 `<option>` 的中文（小红书种草 / 抖音爆款 / 淘宝主图 / 得物干净感） |
| 提交 | `promo.generate` + 一行提示 |
| 结果 | 空态 + 左图右文两栏：图片 `.output`，文案卡 `.output`（标题 input + 正文 textarea + 标签行 + `promo.copy` 按钮） |

**功能一行都不许改**：`fetchEcommerceLink` 的回填、`promoImagePrompt` 的入参、
`enhancePrompt` 的 JSON 解析、`copyText` 的剪贴板降级路径，全部原样保留。
`<select>` 改 pill 时，**四项的 `value` 必须还是** `xiaohongshu / douyin /
taobao / dewu`，否则 smoke 里 `promo workspace offers four platform styles`
那条断言会红。

## 硬约束

- **只改这四个文件**：`src/client/OutfitWorkspace.tsx`、
  `src/client/PromoWorkspace.tsx`、`src/client/outfit-workspace.module.css`、
  本任务书。`panel.module.css` / `ImageGenPanel.tsx` / `locales.ts` /
  `scripts/smoke.mjs` **本轮你先不要动**——
  金团正在同一个工作树里改 `locales.ts` 和 `smoke.mjs`（task-28）。
  你需要的每条文案、每条断言，写进你的交回报告，我来落。
  等我说「可以动 locales 了」你再动，别抢。
- 新文案的中英俄三语措辞由你在报告里给出，格式：
  `'outfit.section.clothes': '服装图' / 'Clothing' / 'Одежда'`。
  暂时**先用现有 key 兜底**，不要就地编 `tt('outfit.section.clothes')` 这种
  不存在的 key —— 那会在运行时直接把 key 名渲染到界面上。
  现有可用 key 见 `src/client/locales.ts:318-343`（zh）、`:1838-1863`（en）、
  `:3347-3372`（ru）。确实需要新分区标题时，用**字面中文常量**先顶住并在报告里
  标注 `// TODO(task-29): 待补 locales`，但**最多只允许 4 处**。
- 样式守卫 `scripts/verify-native-ui.mjs` 会拒：字面颜色/阴影、
  非 token 的 `border-radius`、不在
  `10|11|12|13|14|15|16|18|20|22|24|26|28px` 上的 `font-size`、
  `prefers-color-scheme`、`[class*=]` 猜宿主 class、`dataset.theme` /
  `matchMedia(`、以及任何**不存在**的 `var(--dsw-*)`。
- 最小改动：不做无关重构，不动 `api.ts` / 协议层 / 路由。

## 验收（你自己跑，贴原始输出）

1. `npx tsc --noEmit` → `EXIT=0`。
2. `node scripts/verify-native-ui.mjs` → PASS。
3. `node scripts/verify-tracked.mjs`（若存在）→ EXIT=0。
4. `scripts/with-lock.sh pnpm build` → `BUILD_EXIT=0`。
5. `node scripts/smoke.mjs` → `SMOKE TEST OK`，且下列既有断言不许红：
   - `the outfit hint states the real upload limit`
   - `outfit keeps the nine top-nav entries`
   - `promo workspace offers a product-link field`
   - `promo workspace offers four platform styles`
   - `promo keeps the nine top-nav entries`
6. **构建产物自证**：从 `lib/client.js` 里 grep 出
   `data-workspace=\\"outfit\\"` 与 `data-workspace=\\"promo\\"` 这两个全局规则
   的存在（贴 grep 命中的行），证明两条占位规则真的进了产物。
7. **不许**跑 `pnpm test` / `pnpm test:negative`（我自己跑）。
8. **不许** `git commit / push / add / stash / reset / checkout`。
   验证产物只写 `/tmp/`。

## 布局是否真的成立，由我在真宿主上量盒

jsdom 没有排版引擎，smoke 断言只能证明结构和产物里有规则。真正的
`rect / display / 是否被 config 侧栏挤扁`，我用 CDP 在真宿主上量
`[data-workspace]` 与其子元素的 `getBoundingClientRect()`。
所以我只要求你：**产物里有那两条全局规则 + 组件结构按上面的分区搭好**。
你如果自己想量，可以照 `/tmp/probe-box.mjs` 的写法（需要两个参数：
cookie 名、cookie 值，用 `node /tmp/mint-cookie.mjs 127.0.0.1:64192` 现签），
但那是加分项，不是交付前提。

## 交回时告诉我

- 改动文件清单 + 每个文件的行数变化（45→? / 14→? / 10→?）。
- 服饰穿戴、带货图文各自的最终分区清单（截图文字描述即可，我看不了图）。
- 你要我补的 locale key 完整三语措辞（逐条，格式见上）。
- 你建议加进 `smoke.mjs` 的断言原文（我落）。
- 第 1/2/4/5/6 条的原始输出。
- 你没做到的部分、以及哪里是你自己拍的板。

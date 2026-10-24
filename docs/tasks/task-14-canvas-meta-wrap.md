# task-14：修复结果板参数行的窄宽度回归

## 背景

task-12 把历史参数（提示词 / 尺寸 / 清晰度 / 细节 / 分辨率）画到了结果板上，功能正确，
但在窄面板宽度下 `.canvasMeta` 这一行会溢出，并且**提示词被挤成 0 宽**。

这是我（团团）用真 Chrome 在界团改动后的工作区上实测出来的，不是推断。
完整测量记录在 `/tmp/lead-canvasmeta-check.md`。

## 你要改什么

**只改 `src/client/panel.module.css` 里的 `.canvasMeta` 规则（当前在 `:2735`）。**

现在：

```css
.canvasMeta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
```

要求改成能换行，且换行后同一项内部的字不能被拆开：

```css
.canvasMeta {
  flex: none;
  display: flex;
  flex-wrap: wrap;      /* ← 新增 */
  align-items: center;
  gap: 8px;
  row-gap: 4px;         /* ← 新增：换行后两行的间距 */
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
```

`.canvasMeta` 全仓只有两个使用者，都在 `src/client/ImageGenPanel.tsx`（`:4055` 视频板、
`:4103` 图片板），所以这一处改动同时覆盖两个板。

## 实测证据：为什么必须改

真 Chrome，真 `mountPanel`，宿主回答被 stub，宽度用 CDP `Emulation.setDeviceMetricsOverride` 改。

### 当前状态（改之前）

图片板：

```
@1440px  scrollW=799 clientW=799  overflowing=false
@1100px  scrollW=459 clientW=459  overflowing=false
@900px   scrollW=413 clientW=259  overflowing=true   ← 溢出
```

900px 下每个子元素的实际宽度：

```
本次生成 3 张       w=12            ← 被挤成竖着的一列
历史 · 2026-10-24   w=144
历史图片：…         w=0  scrollW=132   ← 提示词宽度归零，完全看不见
尺寸 3:2            w=60
清晰度 medium       w=96
细节 low            w=61
```

用户自己数据里最长的一条提示词是 **2257 字符**（`~/.dsh/dsh-imagegen/`）。把它放进这一行：

```
w=0  scrollW=16996    ← 16996px 的文字被压进 0px，只剩 title 里有全文
```

视频板同样溢出，只是差得少：

```
@900px  scrollW=261 clientW=259  overflowing=true（差 2px）
@820px  scrollW=261 clientW=179  overflowing=true（差 82px）
```

### 候选修复在页面里注入后的实测（未改仓库，只是证明有效）

```
BARE       @900px  row=259  scrollW=413  promptW=0       ← 现状
WRAP       @900px  row=259  scrollW=259  promptW=259     ← 换行后
WRAP+MINW0 @900px  row=259  scrollW=259  promptW=259     ← 多一个 min-width:0，结果相同
```

两点结论：

1. **`flex-wrap: wrap` 就够。** 加 `min-width:0` 没有额外收益，不要加——多一条无用声明只是噪音。
2. 换行后提示词独占一行，`.historyMeta` 已有的 `overflow:hidden; text-overflow:ellipsis`
   才真正生效（它一直写着，只是宽度被挤到 0 所以从来没机会截断）。

## 硬性要求

1. **只改 `panel.module.css`。** 不许碰 `src/client/ImageGenPanel.tsx`、`tsdown.config.ts`、
   `scripts/**`、`src/**` 其它文件、`package.json`。
2. **不许 commit / push / stash / reset / checkout。**
3. **不许跑 `pnpm test:negative`。**
4. 验证输出只写 `/tmp/`。
5. `pnpm build` 与 `pnpm test` **必须串行**，不许并行。

## 验收（你自己跑，贴真实输出和 EXIT 码）

1. `pnpm build` → 贴末尾几行 + EXIT
2. `node scripts/smoke-canvas-video.mjs` → 贴 `CANVAS VIDEO SMOKE` 那行 + EXIT
3. `DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs` → 贴结果 + EXIT。
   注意：这份守卫会检查圆角 token 和排版契约，改 `panel.module.css` 必须过它。

## 必须证明你的改动没有把别的地方弄坏

`flex-wrap: wrap` 只在内容放不下时才起作用，所以**宽屏（1440px）下渲染必须和改之前逐像素一致**。

做法：改之前先把宽屏截图存到 `/tmp/`，改完再截一张，比对。

参考我用的方法（真 Chrome，`scripts/lib/headless-chrome.mjs`，`--window-size=1440,900`）：

```js
// 页面注入，验证「1440px 下子元素宽度不变」
const kids = [...meta.children].map(c => Math.round(c.getBoundingClientRect().width))
// 改前 BARE @1440: [74, 144, 132, 60, 96, 61]
// 改后必须逐项相同
```

如果 1440px 下有任何一项宽度变了，说明你把宽屏布局也改了，**那不是我要的**，必须报告而不是自己判断可接受。

## 报告要写清

1. `git diff src/client/panel.module.css` 原文
2. 3 条验收的真实输出 + EXIT 码
3. 1440px 下改前 / 改后每项宽度的对照（证明宽屏未变）
4. 900px / 820px 下改后的 `scrollWidth` 与 `clientWidth`（证明溢出已消失）
5. 有没有你没覆盖到的宽度或情形

如果发现我上面的判断有错——比如 `flex-wrap` 并不够、或者某个宽度下另有问题——
**直接说，不要顺着我的结论写。** 上面所有数字都是我自己跑出来的，但你复现不出来就是有问题，
必须报告而不是接受。

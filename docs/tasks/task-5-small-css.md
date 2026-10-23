# task-5 · 14 个小 CSS 契约修复（批量）

**仓库** `/Users/malang/chajian/dsh-imagegen-video`


> **行号基准（2026-10-23 09:27 已修）**：守卫脚本原先有两个打印行号的 bug
> （剥注释吃掉了换行、`var(--x,#hex)` 替换成短标记后索引前移），会把违规报到**上一行或更靠前的无关行**。
> 已修复并逐行验证。如果你在修复前拿到过行号，**重新跑一次**再动手。
> 现在报出的行号是精确的：`file:LINE` 指向的那一行就是违规所在行。


## 所有权

你独占这 14 个文件，**不许改其它任何文件**：

| 文件 | 违规 |
|---|---|
| `src/client/templates.module.css` | 29 |
| `src/client/canvas-video-picker.module.css` | 23 |
| `src/client/reference-images.module.css` | 13 |
| `src/client/timeline.module.css` | 11 |
| `src/client/select.module.css` | 8 |
| `src/client/model-picker.module.css` | 8 |
| `src/client/cast-dialog.module.css` | 8 |
| `src/client/shortcut-help.module.css` | 7 |
| `src/client/inspiration.module.css` | 6 |
| `src/client/generation-loading.module.css` | 4 |
| `src/client/GooeyNav.module.css` | 4 |
| `src/client/error-detail.module.css` | 3 |
| `src/client/image-toolview.module.css` | 2 |

同仓另有 4 个 Bot 并行改 `panel.module.css` / `canvas-workspace.module.css` / `settings-card+ppt-workspace+poster-editor` / 挂载层 tsx。改到别人的文件 = 冲突 = 返工。

## 必读

1. `docs/native-ui-contract.md`（契约，重点 2.1-2.4 节）
2. `scripts/verify-native-ui.mjs`（守卫）

## 方法论：这个任务的关键是别做傻替换

13 个文件、126 处违规，看起来适合脚本批量替换。**但不要。**

理由：`border-radius: 8px` 在一个 32px 的按钮上和在一个 400px 的卡片上，语义不同。前者是"小控件"（`radius-sm` 对），后者可能是"面板"（`radius-panel` 对）。同一个数字在不同上下文映射到不同 token。

正确顺序：

1. **先读文件**，搞清它是什么组件、尺寸量级
2. 再决定这个文件里的 `8px` 该落哪一档
3. 同类组件之间保持一致（`model-picker` 和 `select` 都是下拉，圆角必须一致）

**批量替换只在你确认过整个文件都是同一档时才可以。**

## 圆角映射（基准）

| 现值 | 改为 |
|---|---|
| 2px / 4px | `var(--dsw-radius-xs)` |
| 6px / 8px | `var(--dsw-radius-sm)` |
| 10px / 12px | `var(--dsw-radius-md)` |
| 14px / 16px | `var(--dsw-radius-lg)` |
| 18px / 20px | `var(--dsw-radius-xl)` |
| ≥24px 面板级 | `var(--dsw-radius-panel)` |
| 999px / 50% / 100% / 100vw | 不动 |

例外：`timeline.module.css` 与 `canvas-video-picker.module.css` 里有**内容层元素**（时间轴刻度、视频缩略图上的角标）。如果圆角是为了贴合媒体内容形状，保留数字 + 注释。

## 字号

阶梯 `10 11 12 13 14 15 16 18 20 22 24 26 28`。

半像素归整优先落 11/12/13。可读文字改 `var(--dsh-content-font-size, 14px)`。

## 颜色

`var(--token, #hex)` 的**回退值保留**（全仓 89 处合法，不要删）。

裸露字面值按语义映射到 `--dsw-alias-*`。见契约 2.1 节完整映射表。

**特别注意** `canvas-video-picker`、`reference-images`、`timeline` 这三个：里面有压在**图片/视频**上的元素（播放按钮、删除角标、时间码）。这些属于**内容层**，不能全部跟界面主题走 —— 深色遮罩压在亮图上、浅色遮罩压在暗图上，都要保证可读。

按 task-2 的做法：用 `--dsw-static-*` 静态原色，或在文件顶部定义模块私有变量。**判断不了就报告，不要拍。**

## 阴影

`0 1px 2px`→`lv1`，`0 4-8px`→`lv2`，`0 12px+`→`lv3`，弹层→`elevation-soft|panel|prominent`。

## 坏 token（4 处，优先改）

| 文件 | 坏 token | 换成 |
|---|---|---|
| `error-detail.module.css` | `--dsw-alias-state-danger-primary` | `--dsw-alias-state-error-primary` |
| `shortcut-help.module.css:103` | `--dsw-font-mono` | `font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

`--dsw-font-mono` 在 `canvas-workspace` 也有 5 处，那归别人。你只管 `shortcut-help` 这一处。

坏 token 会导致**整条声明被浏览器丢弃**，是功能损坏，优先修。

## 验收（硬性，贴实际输出）

```bash
cd /Users/malang/chajian/dsh-imagegen-video

DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs --verbose 2>&1 \
  | grep -E "templates|canvas-video-picker|reference-images|timeline|select\.module|model-picker|cast-dialog|shortcut-help|inspiration|generation-loading|GooeyNav\.module|error-detail|image-toolview"
# 应无输出，或只剩你有注释说明的

node scripts/verify-ui-contracts.mjs
pnpm typecheck && pnpm build
pnpm test
```

## 禁止

- 改 `.tsx` / `.ts`
- 改别人所有的 CSS 文件
- 用 sed 全局批量替换（除非你确认过整文件同档）
- 修改守卫脚本放行

## 环境

- DSH 原生源码：`/tmp/dshnative/dsh/node_modules/@deepseek-ai/`
- 真 Chromium：`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`

## 报告要求

回给我：

1. **按文件**列出改动数（13 行表格）
2. 同类组件的圆角一致性怎么保证的（`select` 和 `model-picker`、`cast-dialog` 和 `error-detail`）
3. 内容层颜色（picker/reference-images/timeline 上的浮层元素）怎么处理的
4. 「保留数字 + 注释」的清单与理由
5. 四条验收命令的**实际输出**

文件多但每个不大，**质量优先于速度**。宁可少改几个可疑的，也不要为了清零把语义改错。

# task-3 · settings-card / ppt-workspace / poster-editor 三文件契约修复

**仓库** `/Users/malang/chajian/dsh-imagegen-video`


> **行号基准（2026-10-23 09:27 已修）**：守卫脚本原先有两个打印行号的 bug
> （剥注释吃掉了换行、`var(--x,#hex)` 替换成短标记后索引前移），会把违规报到**上一行或更靠前的无关行**。
> 已修复并逐行验证。如果你在修复前拿到过行号，**重新跑一次**再动手。
> 现在报出的行号是精确的：`file:LINE` 指向的那一行就是违规所在行。


## 所有权

你独占这 3 个文件，**不许改其它任何文件**：

| 文件 | 违规数 |
|---|---|
| `src/client/settings-card.module.css` | 65 |
| `src/client/ppt-workspace.module.css` | 51 |
| `src/client/poster-editor.module.css` | 7 |

同仓另有 4 个 Bot 并行改其它文件。改到别人的文件 = 冲突 = 返工。

## 必读（先读完再动手）

1. `docs/native-ui-contract.md` —— 契约。重点 2.1 颜色 / 2.2 圆角 / 2.3 阴影 / 2.4 字号。
2. `scripts/verify-native-ui.mjs` —— 守卫。验收就是让它对这 3 个文件零输出。

## 三个文件各自的特点

### settings-card.module.css（65 处）

设置面板的卡片样式。**它应该最像原生** —— DSH 自己的设置面板在 `/tmp/dshnative/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-*/` 里，可以直接对照着看。

DSH 有两个专用 token，用它们：
- `--dsw-alias-settings-card-fill`
- `--dsw-alias-settings-card-stroke`

圆角按 2.2 节映射；字号多改 `var(--dsh-content-font-size, 14px)` 与 `var(--dsh-content-font-size-secondary, 13px)`。

### ppt-workspace.module.css（51 处）

幻灯片编辑器。**这个文件有个设计判断题，别搞错。**

里面有 `color: #fff`、`rgb(15 18 24 / 75%)`、`rgb(0 0 0 / 40%)` 这类**深色固定值**（大致在 L23、L35、L45、L54）。

**不能**机械换成 `--dsw-alias-bg-base`。理由：舞台是「文档的画布」，里面放的是用户的幻灯片（常为白底）。如果舞台跟随主题变成浅色，白色幻灯片就融进背景看不见了。

正确处理：
```css
.pptRoot {
  /* 舞台承载用户文档，不随界面主题变 —— 幻灯片常为白底，
     浅色舞台会让内容失去边界。这是 token 体系的合法例外。 */
  --ppt-stage-bg: rgb(15 18 24 / 75%);
  --ppt-stage-ink: #fff;
}
```

`L45` 的 `rgb(208 64 64 / 20%)` 是**错误态**（不是舞台），改成从 `--dsw-alias-state-error-primary` 用 `color-mix()` 派生。

### poster-editor.module.css（7 处）

主要是阴影与圆角，直接按映射改。

## 四类修复规则

### 圆角

2/4px→`var(--dsw-radius-xs)`，6/8px→`radius-sm`，10/12px→`radius-md`，14/16px→`radius-lg`，18/20px→`radius-xl`，≥24px→`radius-panel`。999px/50%/100%/100vw 不动。

### 字号

阶梯 `10 11 12 13 14 15 16 18 20 22 24 26 28`。半像素归整到 11/12/13 优先。可读文字用 `var(--dsh-content-font-size, 14px)`。

### 颜色

- `var(--token, #hex)` 的**回退值保留**（合法，不要删）
- 裸露字面值按语义映射到 `--dsw-alias-*`
- 固定深色舞台按上面说的用私有变量 + 注释

### 阴影

`0 1px 2px`→`var(--dsw-shadow-lv1)`，`0 4-8px`→`lv2`，`0 12px+`→`lv3`，弹层→`elevation-soft|panel|prominent`。

**例外**：幻灯片/海报的 `box-shadow` 如果是表现「纸张浮起」的物理感（`0 24px 60px` 这种），不是界面层级 —— 保留数字 + 注释说明。

### 坏 token（共 17 处，**优先改**）

这些 token 在 DSH 里不存在，浏览器会**整条声明丢弃** —— 功能已经坏了。

| 文件 | 坏 token | 数量 | 换成 |
|---|---|---|---|
| settings-card | `--dsw-color-success` | 6 | `--dsw-alias-state-success-primary` |
| settings-card | `--dsw-font-family-mono` | 5 | `font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| settings-card | `--dsw-color-danger` | 1 | `--dsw-alias-state-error-primary` |
| settings-card | `--dsw-alias-bg-module-poped` | 1 | 拼写错的 token，按语义换成 `--dsw-alias-bg-layer-2` 或 `bg-layer-3` |
| ppt-workspace | `--dsw-alias-state-danger-primary` | 3 | `--dsw-alias-state-error-primary` |
| poster-editor | `--dsw-alias-label-inverse` | 1 | 按语义处理，见下 |

`--dsw-alias-label-inverse` 要看用途：深底上的浅色字还是浅底上的深色字。DSH 没有 inverse 语义，正确做法是用 `--dsw-static-*` 静态原色，或让底色决定前景色。

改对之后外观会变化，这是修复不是回归，报告里说明。

## 验收（硬性，逐条跑，贴实际输出）

```bash
cd /Users/malang/chajian/dsh-imagegen-video

DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs --verbose 2>&1 | grep -E "settings-card|ppt-workspace|poster-editor"
# 应无输出，或只剩你有注释说明的

node scripts/verify-ui-contracts.mjs
pnpm typecheck && pnpm build
pnpm test
```

## 禁止

- 改 `.tsx` / `.ts`
- 改其它 CSS 文件
- 把幻灯片舞台改成跟随主题的浅色（会毁掉可用性）
- 修改守卫脚本放行

## 环境

- DSH 原生源码：`/tmp/dshnative/dsh/node_modules/@deepseek-ai/`
- 真 Chromium：`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`
- 守卫要带：`DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules`

## 报告要求

回给我：

1. 三个文件各改多少处
2. 哪些是「保留数字 + 注释」的、理由
3. 外观明显变化的地方
4. 四条验收命令的**实际输出**

写完建议用 Chromium 截图自查明暗两态，别只凭代码想象。

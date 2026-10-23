# task-1 · panel.module.css 全量契约修复

**仓库** `/Users/malang/chajian/dsh-imagegen-video`


> **行号基准（2026-10-23 09:27 已修）**：守卫脚本原先有两个打印行号的 bug
> （剥注释吃掉了换行、`var(--x,#hex)` 替换成短标记后索引前移），会把违规报到**上一行或更靠前的无关行**。
> 已修复并逐行验证。如果你在修复前拿到过行号，**重新跑一次**再动手。
> 现在报出的行号是精确的：`file:LINE` 指向的那一行就是违规所在行。


## 所有权

你独占 `src/client/panel.module.css`（218 处违规，全仓最重）。**不许改其它任何文件。**

同仓另有 4 个 Bot 并行改其它文件：
- `canvas-workspace.module.css` （另一个 Bot）
- `settings-card` + `ppt-workspace` + `poster-editor` （另一个 Bot）
- `mount.tsx` / `surface-theme.ts` / `GooeyNav.tsx` （另一个 Bot）
- 14 个小 CSS （另一个 Bot）

改到别人的文件 = 冲突 = 返工。

## 为什么按文件分而不是按规则分

同一行 CSS 会同时违反多条规则（`border-radius: 12px; color: #fff` 一行两违规），两个 Bot 并行改同一文件必然互相覆盖。所以一个文件一个主人，主人负责该文件里的**全部**规则。

## 必读（先读完再动手）

1. `docs/native-ui-contract.md` —— 契约。重点 2.1 颜色 / 2.2 圆角 / 2.3 阴影 / 2.4 字号。
2. `scripts/verify-native-ui.mjs` —— 守卫。验收就是让它对你这个文件零输出。

## 四类修复

### 圆角（本文件约 106 处）

| 现值 | 改为 |
|---|---|
| 2px / 4px | `var(--dsw-radius-xs)` |
| 6px / 8px | `var(--dsw-radius-sm)` |
| 10px / 12px | `var(--dsw-radius-md)` |
| 14px / 16px | `var(--dsw-radius-lg)` |
| 18px / 20px | `var(--dsw-radius-xl)` |
| ≥24px 面板级 | `var(--dsw-radius-panel)` |
| 999px / 50% / 100% / 100vw | 不动 |

### 字号（本文件约 46 处）

阶梯只有 `10 11 12 13 14 15 16 18 20 22 24 26 28`。

- 半像素归整：10.5→10/11，11.5→11/12，12.5→12/13，13.5→13/14，14.5→14。**优先落 11/12/13**（原生使用频次最高的三档：12 出现 145 次、11 出现 113 次、13 出现 60 次）
- 9px→10px，5px/4px→10px，17px→16 或 18，19px→18 或 20
- **承载用户可读文字**的改 `var(--dsh-content-font-size, 14px)`，次级 `var(--dsh-content-font-size-secondary, 13px)`，代码 `var(--dsh-code-font-size, 11px)`
- 装饰性角标可硬编码，但必须落在阶梯上

### 颜色（本文件约 40 处裸露）

**重要边界**：`var(--token, #hex)` 里的回退值是**合法的**，全仓 89 处，**不要删**。守卫已放行这种写法。

要改的是**裸露的**字面值，例如：
- `box-shadow: 0 18px 48px rgba(0, 0, 0, 0.25)`
- `background: rgb(0 0 0 / 35%)`

按语义映射：

| 语义 | token |
|---|---|
| 页面/面板底 | `--dsw-alias-bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-layer-3` |
| 浮层底 | `--dsw-alias-bg-overlay` |
| 遮罩（弹层后面压暗） | `--dsw-alias-bg-mask-1`（浅）/ `-2` / `-3`（深） |
| 主文字 | `--dsw-alias-label-primary` |
| 次文字 | `--dsw-alias-label-secondary` |
| 弱文字 | `--dsw-alias-label-tertiary` |
| 极弱/说明 | `--dsw-alias-label-caption` |
| 边框（轻→重） | `--dsw-alias-border-l1` → `-l2` → `-l3` → `-l4` |
| 悬停底 | `--dsw-alias-interactive-bg-hover` |
| 按下底 | `--dsw-alias-interactive-bg-active` |
| 错误 | `--dsw-alias-state-error-primary` |
| 成功 | `--dsw-alias-state-success-primary` |
| 品牌 | `--dsw-alias-brand-primary` / `brand-text` |

**特殊情形**：`background: rgb(0 0 0 / 35%)` 如果是**压在图片/视频上**做遮罩，用 `--dsw-alias-bg-mask-1|2|3`；如果是界面遮罩也用 mask 系列，但深度选对。

### 阴影

| 现值 | 改为 |
|---|---|
| `0 1px 2px` 类微阴影 | `var(--dsw-shadow-lv1)` |
| `0 4-8px` 中等 | `var(--dsw-shadow-lv2)` |
| `0 12px+` 大 | `var(--dsw-shadow-lv3)` |
| 弹层/浮窗 | `var(--dsw-elevation-soft)` / `-panel` / `-prominent` |
| `inset` | 保留结构，颜色换 token |

### 坏 token（10 处，其中 **9 处是真坏**）

**先分清两类，别一概而论**：

- **真坏（9 处）**：裸用不存在的 token，无 fallback → 浏览器**整条声明丢弃** → 功能已经坏了，界面上这块是空的/没颜色
- **假坏（1 处）**：`var(--坏token, 兜底值)` 带 fallback → 视觉上正常，只是写法不规范

**真坏的这 9 行（已逐行核对，精确）**：

| 行号 | 内容 |
|---|---|
| `panel.module.css:1394` | `color: var(--dsw-alias-state-error);` |
| `panel.module.css:1395` | `background: color-mix(in srgb, var(--dsw-alias-state-error) 10%, transparent);` |
| `panel.module.css:2642` | `background: var(--dsw-alias-bg-hover);` |
| `panel.module.css:3300` | `color: var(--dsw-alias-label-quaternary);` |
| `panel.module.css:3388` | `color: var(--dsw-alias-state-error);` |
| `panel.module.css:3751` | `border: 1px solid var(--dsw-alias-border-secondary);` |
| `panel.module.css:3771` | `border: 1px solid var(--dsw-alias-border-secondary);` |
| `panel.module.css:3789` | `border: 1px solid var(--dsw-alias-border-secondary);` |
| `panel.module.css:3903` | `border-color: var(--dsw-alias-state-error);` |

替换对照：

| 坏 token | 换成 |
|---|---|
| `--dsw-alias-state-error` | `--dsw-alias-state-error-primary` |
| `--dsw-alias-bg-hover` | `--dsw-alias-interactive-bg-hover` |
| `--dsw-alias-label-quaternary` | `--dsw-alias-label-caption` |
| `--dsw-alias-border-secondary` | `--dsw-alias-border-l2`（需要更重就用 `-l3`） |

**假坏的 1 处**：`panel.module.css:739` 的 `var(--dsw-font-mono, ui-monospace, ...)` —— 带 fallback，渲染正常。仍建议改成 `font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`（不带 var），因为 DSH 确实没有等宽字体 token，包一层是误导。

**`--dsw-font-mono` 是虚构 token**，DSH 里不存在。别指望它能被定义。

**这 9 行优先改。** 改完后那几处外观会**从"没颜色/没边框"变成有颜色有边框** —— 这是修复，不是回归，报告里要单独说明是哪几处、变成了什么样。

## 验收（硬性，逐条跑，贴实际输出）

```bash
cd /Users/malang/chajian/dsh-imagegen-video

# 1. 自己文件的违规必须为 0
DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs --verbose 2>&1 | grep "panel.module.css"
# 应无输出

# 2. 层叠顺序守卫
node scripts/verify-ui-contracts.mjs

# 3. 类型与构建
pnpm typecheck && pnpm build

# 4. 冒烟测试（396 条 DOM 断言）
pnpm test
```

## 禁止

- 改任何 `.tsx` / `.ts`
- 改其它 CSS 文件（别的 Bot 正在改）
- 用 `!important` 绕过
- 修改 `scripts/verify-native-ui.mjs` 让它放行
- 机械替换字面色而不看语义（`background: #000` 压在图片上 ≠ `bg-base`）

## 环境

- DSH 原生源码已解包：`/tmp/dshnative/dsh/node_modules/@deepseek-ai/`
- 真 Chromium：`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`
- 守卫必须带环境变量：`DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules`

## 报告要求

回给我：

1. 四类各改了多少处
2. **外观发生变化**的地方 —— 尤其原本引用了不存在 token 导致样式静默失效的，改对了会变样
3. 判断不了而保留的地方 + 理由
4. 四条验收命令的**实际输出**（不是「应该通过」）

有疑问先问，不要猜。改到测试红着交回来是最差的结果。

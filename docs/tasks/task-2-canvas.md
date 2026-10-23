# task-2 · canvas-workspace.module.css 全量契约修复

**仓库** `/Users/malang/chajian/dsh-imagegen-video`


> **行号基准（2026-10-23 09:27 已修）**：守卫脚本原先有两个打印行号的 bug
> （剥注释吃掉了换行、`var(--x,#hex)` 替换成短标记后索引前移），会把违规报到**上一行或更靠前的无关行**。
> 已修复并逐行验证。如果你在修复前拿到过行号，**重新跑一次**再动手。
> 现在报出的行号是精确的：`file:LINE` 指向的那一行就是违规所在行。


## 所有权

你独占 `src/client/canvas-workspace.module.css`（184 处违规，2900+ 行）。**不许改其它任何文件。**

同仓另有 4 个 Bot 并行改其它文件：
- `panel.module.css`
- `settings-card` + `ppt-workspace` + `poster-editor`
- `mount.tsx` / `surface-theme.ts` / `GooeyNav.tsx`
- 14 个小 CSS

改到别人的文件 = 冲突 = 返工。

## 必读（先读完再动手）

1. `docs/native-ui-contract.md` —— 契约。重点 2.1 颜色 / 2.2 圆角 / 2.3 阴影 / 2.4 字号。
2. `scripts/verify-native-ui.mjs` —— 守卫。验收就是让它对你这个文件零输出。

## 这个文件为什么难

2900+ 行，是**画布工作区**的全部样式：缩放、拖拽、多图层、时间轴、选区、参考图槽位。改之前先通读骨架，理解每块在干什么。**不要按行号盲改。**

## 四类修复

### 圆角（约 100 处）

| 现值 | 改为 |
|---|---|
| 2px / 4px | `var(--dsw-radius-xs)` |
| 6px / 8px | `var(--dsw-radius-sm)` |
| 10px / 12px | `var(--dsw-radius-md)` |
| 14px / 16px | `var(--dsw-radius-lg)` |
| 18px / 20px | `var(--dsw-radius-xl)` |
| ≥24px 面板级 | `var(--dsw-radius-panel)` |
| 999px / 50% / 100% / 100vw | 不动 |

### 字号

阶梯只有 `10 11 12 13 14 15 16 18 20 22 24 26 28`。

- 半像素归整：10.5/11.5/12.5/13.5/14.5 → **优先落 11/12/13**
- 9px→10px，5px/4px→10px
- 承载可读文字的改 `var(--dsh-content-font-size, 14px)`

### 颜色（约 55 处裸露，含 5 处坏 token）

**重要边界**：`var(--token, #hex)` 里的回退值**合法**，全仓 89 处，不要删。

要改的是裸露字面值。

**但是这个文件有个特殊难点，必须分清两类色**：

**第一类：界面色** → 用 `--dsw-alias-*`
面板底、按钮、文字、边框、弹层遮罩。

**第二类：内容色** → **不能**用界面语义 token
画布上**压在用户图片/视频上**的视觉元素：标注线、网格线、选框、对齐辅助线、裁剪框。

理由：这些在明暗两态下**应该保持一致**。如果用了 `--dsw-alias-*`，画在图片上的红线在亮色主题下会变淡甚至看不见——因为图片本身的明度不随主题变，而界面前景色会变。

正确处理二选一：
1. 用 `--dsw-static-*` 静态原色板（原生定义过，如 `--dsw-static-red-500`）
2. 在文件顶部定义本模块私有变量（如 `--canvas-annotation:`），从一个 `--dsw-static-*` 派生

**注意本文件 L19-L21 已经有 `--canvas-annotation` 这类私有变量** —— 沿用它，不要打散成散落的字面值。

**这类判断不了的，报告出来，不要自己拍。** 把界面色改成内容色、或反过来，都会毁掉可用性。

### 阴影

| 现值 | 改为 |
|---|---|
| `0 1px 2px` | `var(--dsw-shadow-lv1)` |
| `0 4-8px` | `var(--dsw-shadow-lv2)` |
| `0 12px+` | `var(--dsw-shadow-lv3)` |
| 弹层/浮窗 | `--dsw-elevation-soft` / `-panel` / `-prominent` |
| `inset` | 保留结构，颜色换 token |

**例外**：画布元素压在**图片内容**上的投影跟随图片内容，不跟随界面主题。这类保留数字，但在注释里说明为什么。

### 坏 token（本文件 6 处，优先改）

这些 token **在 DSH 里不存在**，浏览器遇到未定义的自定义属性会**整条声明丢弃** —— 代码看着对，样式静默失效。

| 坏 token | 数量 | 换成 |
|---|---|---|
| `--dsw-font-mono` | 5 | `font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| `--dsw-alias-label-inverse` | 1 | 看清语义：若是深底浅字用 `--dsw-alias-label-primary` 配深色底；若确需反色，用 `--dsw-static-*` 系列，**不要造 token** |

**这一类要优先改** —— 它不只是风格问题，是**功能已经坏了**（声明被丢弃）。改对之后外观会变化，这是修复，不是回归，要在报告里说明。

## 验收（硬性，逐条跑，贴实际输出）

```bash
cd /Users/malang/chajian/dsh-imagegen-video

# 1. 自己文件的违规必须为 0
DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs --verbose 2>&1 | grep "canvas-workspace.module.css"
# 应无输出

# 2. 层叠顺序守卫
node scripts/verify-ui-contracts.mjs

# 3. 类型与构建
pnpm typecheck && pnpm build

# 4. 冒烟测试（396 条 DOM 断言）
pnpm test
```

## 禁止

- 改 `.tsx` / `.ts`
- 改其它 CSS 文件
- 把画布标注色/网格线改成界面语义 token（会让画在图片上的标注在两态下不一致）—— 这类要报告，不要自己决定
- 修改守卫脚本放行

## 环境

- DSH 原生源码已解包：`/tmp/dshnative/dsh/node_modules/@deepseek-ai/`
- 真 Chromium：`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`
- 守卫必须带环境变量：`DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules`

## 报告要求

回给我：

1. 四类各改多少处
2. 外观变化处
3. **画布专属色你是怎么处理的** —— 用了哪些 `--dsw-static-*`、哪些保留了私有变量
4. 判断不了的地方
5. 四条验收命令的**实际输出**

这个文件改错的影响面最大（它是插件的核心交互区）。有疑问先问，不要猜。

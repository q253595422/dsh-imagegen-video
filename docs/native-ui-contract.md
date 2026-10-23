# DSH 原生 UI 契约

本插件的前端必须看起来、用起来、跟随设置的方式都和 DSH 自带界面一致。这份文档是**唯一权威**：任何界面改动以它为准，不以个人审美为准。

所有结论都来自对已安装 DSH 的反向读解（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` → `dsh/node_modules/@deepseek-ai/`），不是猜测。

---

## 1. 为什么需要这份契约

实测差距（基线 = DSH 41 段原生内嵌 CSS，共约 12000 行；插件 = 18 个 CSS 文件，12080 行）：

| 指标 | DSH 原生 | 插件 | 倍数 |
|---|---|---|---|
| 硬编码颜色 / 千行 CSS | 2.0 | 17.6 | **8.8x** |
| 硬编码 `border-radius` / 千行 | 1.4 | 30.6 | **21.6x** |
| 硬编码 `font-size` / 千行 | 12.2 | 43.2 | **3.5x** |
| 语义 token 覆盖 | — | 19 / 107 | **17.8%** |

还有三类**功能性**缺陷，不是风格问题：

1. **12 个 token 名根本不存在**（`--dsw-alias-label-inverse`、`--dsw-color-success`、`--dsw-font-mono` 等），共 36 处引用。其中 9 处没有回退值，浏览器直接丢弃该声明 —— 样式静默失效，看代码看不出来。
2. **完全不响应用户字号设置**。DSH 在 `body` 上写 `--dsh-content-font-size` / `--dsh-code-font-size`，插件硬编码了 522 处 `font-size: Npx`，用户把字号调大插件纹丝不动。
3. **侧栏入口靠猜 DOM**。用 `[class*="sidebarCol"]`、`[class*="logoRow"]`、`[class*="newSession"]` 找插入点。DSH 有正式的 `sidebar.panellist` slot，插件没用。

---

## 2. 唯一真理源

### 2.1 颜色：只用 `--dsw-alias-*`

**禁止**在 `.css` 里写任何 `#rrggbb` / `rgb()` / `rgba()` / `hsl()`。

107 个语义 token 按用途分：

| 用途 | token |
|---|---|
| 背景分层（由深到浅） | `bg-base` → `bg-layer-1` → `bg-layer-2` → `bg-layer-3` |
| 浮层背景 | `bg-overlay`、`bg-module-platform` |
| 遮罩 | `bg-mask-1`（轻）/ `bg-mask-2`（更轻）/ `bg-mask-3`（重）/ `bg-mask-drop`（拖拽） |
| 文字 | `label-primary` > `label-secondary` > `label-tertiary` > `label-caption` |
| 弱化文字 | `label-dimmed`、`label-primary-dimmed` |
| 边框 | `border-l1`（最轻）→ `border-l2` → `border-l3` → `border-l4`（最重） |
| 交互态 | `interactive-bg-hover`、`interactive-bg-active`、`interactive-bg-hover-solid`、`interactive-bg-hover-danger` |
| 按钮 | `button-primary-fill` / `-hover`、`button-elevated-fill`、`button-floating-fill` / `-hover`、`button-ghost-active-fill` / `-border` / `-hover`、`button-info-fill` / `-hover`、`button-contrast-fill` |
| 状态 | `state-error-primary`、`state-success-primary`、`state-warn-primary`、`state-business-primary`、`state-idle-primary`（各有 `-secondary` / `-tertiary` 变体） |
| 品牌 | `brand-primary`、`brand-text`、`link` |
| 滚动条 | `scrollbar-bg-l1` / `-l2`、`scrollbar-hover-l1` / `-l2` |
| 提示 | `tooltip-bg`、`tooltip-key-bg`、`toast-bg`、`toast-label` |
| 代码 | `markdown-code-block`、`markdown-inline-code`、`markdown-code-segment-selected` 等 |
| 设置卡片 | `settings-card-fill`、`settings-card-stroke` |

**以下名称不存在，禁止使用**（曾用但从未定义）：

```
--dsw-alias-bg-hover              → 用 interactive-bg-hover
--dsw-alias-bg-module-poped       → 用 bg-overlay
--dsw-alias-border-secondary      → 用 border-l2
--dsw-alias-label-inverse         → 用 label-primary-inverted
--dsw-alias-label-quaternary      → 用 label-caption
--dsw-alias-state-danger-primary  → 用 state-error-primary
--dsw-alias-state-error           → 用 state-error-primary
--dsw-alias-status-danger         → 用 state-error-primary
--dsw-color-danger                → 用 state-error-primary
--dsw-color-success               → 用 state-success-primary
--dsw-font-family-mono            → 用 --ds-font-family-code（见 2.4）
--dsw-font-mono                   → 用 --ds-font-family-code（见 2.4）
```

### 2.2 圆角：只用 `--dsw-radius-*`

| token | 值 | 用途 |
|---|---|---|
| `radius-xs` | 4px | 小标签、内联元素 |
| `radius-sm` | 8px | **按钮、输入框、大多数控件** |
| `radius-md` | 12px | 卡片、面板 |
| `radius-lg` | 16px | 大卡片 |
| `radius-xl` | 20px | 弹层 |
| `radius-panel` | 28px | 全局面板 |

胶囊形用 `border-radius: 999px`（原生也这么写）。**其余一律禁止写 px。**

另有一个全站生效的 `--dsw-corner-shape: superellipse(1.5)`，`*, :before, :after` 都应用了 `corner-shape`。不要覆盖它，不要给元素设 `corner-shape: round`。

### 2.3 阴影与层级

只用 `--dsw-shadow-lv1` / `-lv2` / `-lv3`，或 `--dsw-elevation-soft` / `-panel` / `-prominent`。

**禁止自造 `box-shadow` 数值。**

z-index 用一个有序阶梯，不允许两个无关层用同一数字（`verify-ui-contracts.mjs` 已在检查这条）：

```
内容 < 侧栏浮层 < 弹窗 < 菜单/tooltip < toast
```

### 2.4 排版

先看 DSH 自己怎么做。实测原生 41 段内嵌 CSS 的 `font-size` 来源分布：

| 来源 | 次数 | 占比 |
|---|---|---|
| 硬编码 `font-size: Npx` | 147 | **89%** |
| `var(--dsh-content-font-size, 14px)` | 18 | 11% |
| `var(--dsw-font-*-font-size)` | 0 | 0% |

**`--dsw-font-*-font-size` 这套 token 存在但原生一个都没用**，值是固定 px（`--dsw-font-xxs-12-font-size: 12px`），不跟随用户设置。真正跟随「Settings → General → Font size」的只有 `--dsh-content-font-size` / `--dsh-code-font-size` / `--dsh-terminal-font-size`，且只用在**承载用户内容**的地方：工具调用标题与摘要、goal 气泡、workflow 运行状态的各行、用户提问卡片、文件侧栏状态行。

**结论（这就是规则）**：

- 承载用户内容 / 需要用户阅读并可能被复制的文字 → `var(--dsh-content-font-size, 14px)`，需要次级大小用 `var(--dsh-content-font-size-secondary, 13px)`
- 代码与终端 → `var(--dsh-code-font-size, 11px)` / `var(--dsh-terminal-font-size, 13px)`
- 纯界面装饰（角标、计数、极小标签）→ 允许硬编码，但**必须落在下面这套阶梯上**

字号阶梯（取自原生实际取值，按使用频次排序）：

```
12px (48次) > 13px (32) > 14px (27) > 11px (20) > 16px (5) > 10px (3) > 18px (3) > 15px (2)
```

**禁止**：`10.5`、`11.5`、`12.5`、`13.5`、`14.5`、`9`、`5`、`4` 这类原生从未出现过的值。现有代码里有 121 处半像素字号，全部要归到阶梯上。

半像素字号不是字体精度问题，是**缩放的残渣**：`11.5px` 和 `12px` 在 1x 屏上差别不可辨，在 2x 屏上都是清晰的 23/24 物理像素，却让设计者以为自己有更细的层级。实际结果是阶梯变成了噪声。

字体族：`--dsw-font-family`（正文）、`--dsw-font-family-brand`（品牌）。等宽字体用 `--ds-font-family-code`（**注意是 `--ds-` 前缀，比本节其余 token 少一个 `w`**，它不是 `--dsw-*` 一族）：它在 `body` 上合成，`var(--dsh-font-family-code, var(--dsh-font-family-code-default))` 两项串联，前者由「设置 → 代码字体」写入，后者是内置栈，所以用它才跟得上用户改字体。宿主自己 33 处 `font-family` 全部这么写，零处用 `--dsh-font-family-code-default`、零处用裸 `ui-monospace` 栈。裸栈只在 token 缺失时作为 fallback 出现在末尾。

### 2.5 间距

DSH **没有**间距 token。原生 CSS 的实际取值分布（作为惯例，不是硬规则）：

```
gap: 4 / 6 / 8 / 12 / 16 px    （8、4、6 最常见）
padding: 同上一套
```

用 4 的倍数体系，允许 6、10、14 这类原生也在用的值。**禁止 3px、5px、7px、9px、11px、13px 这类无规律的奇数。** 现有代码里有 `11.5px`、`12.5px`、`10.5px` 字号，属于历史遗留，应随重写清除。

### 2.6 主题切换

不要读 `prefers-color-scheme`，不要自己在元素上打 `data-theme`。DSH 用：

```css
body[data-ds-dark-theme] .xxx { ... }
```

绝大多数情况**根本不需要这个选择器** —— 用了 alias token 就自动双向适配。只有在 token 表达不了时才写它。

若需要 JS 判断主题，注入 `theme` 服务，读 `theme.getTheme()`，订阅 `theme/change` 事件：

```ts
export const inject = ['theme']
const theme = ctx.get('theme')
const isDark = theme?.getTheme().appearance === 'dark'
ctx.on('theme/change', () => { /* 重新计算 */ })
```

**不要**用 `matchMedia` 或读 `body.dataset`。

---

## 3. 组件：用 DSH 的，别手搓

DSH 在 `@deepseek-ai/dsh-client-ui-primitives` 里导出了 **146 个组件/工具 + 188 个图标**。当前插件只用了 2 个（`Button`、`Pill`）。

### 3.1 可直接替换的

| 手搓的 | 用原生 | 说明 |
|---|---|---|
| `Select.tsx`（270 行 + 2 个 portal） | `Menu` / `MenuSurface` / `MenuItemButton` / `MenuGroup` | 原生菜单自带锚定定位、外部点击关闭、max-height 计算 |
| 各处 `createPortal` 弹层（18 处） | `Modal` + `useModalLayer` / `closeTopModal` | 原生统一管理层级与 Esc |
| 自造 tooltip | `Tooltip` / `HoverCard` / `HoverCardGroup` | |
| 自造 toast | `Toast` | |
| 自造右键菜单（`CanvasWorkspace` 46 处状态） | `Menu` + `useAnchoredPosition` / `useDismissOnOutsidePointer` | |
| 自造开关 | `Switch` / `Checkbox` | |
| 自造分段控件、tab | `SegmentedControl` / `SegmentedTabs` | |
| 自造输入框 | `Input` / `InlineEditor` | |
| 自造标签 | `Tag` / `Pill` / `StateDot` | |
| 自造图片查看器 | `ImageLightbox` | |
| 自造折叠区 | `DisclosureRow` | |
| 自造键位提示 | `ShortcutKeys` | |
| 自造加载文字 | `TextShimmer` | |
| 自造设置表单 | `SettingsForm` / `SettingsValueField` / `SettingsSecretField` | |

### 3.2 图标

188 个 `Icon*` 组件，命名规则 `Icon<名字><Outline|Fill><Regular|Medium>`，如 `IconCheckOutlineRegular`、`IconArchiveCheckOutlineMedium`。

**禁止**再内联写 `<svg>`。现有 `sidebar-entry.ts`、`CanvasWorkspace` 里有一批内联 SVG，全部替换。

### 3.3 工具函数

这些别自己写：`writeClipboard`、`relativeTime`、`fileSizeText`、`fileExtension`、`classifyFileType`、`languageForPath`、`useCodeHighlighter`、`focusWithoutRing`、`pointerModality`、`observeComposition`、`rankByName`。

---

## 4. 挂载：用 slot，别猜 DOM

DSH 有 **103 个 slot**。当前插件只用了 2 个（`settings.section`、`tool.call.toolview`），侧栏入口是猜出来的。

### 4.1 本插件该用的 slot

| 用途 | slot | 契约 |
|---|---|---|
| 侧栏面板图标 | `sidebar.panellist` | `kind: list`，`scope: root`。注册 `{ id, order, label }`，owner 提供按钮并解析 label |
| 主面板内容 | `main` | `{ key: <与 panellist 的 id 相同> }` 决定点图标后中间区显示什么 |
| 侧栏底部动作 | `sidebar.footer.action` | 放「设置」旁边 |
| 折叠态角标 | `sidebar.toggle.badge` | 非交互提示 |
| 全框浮层 | `shell.overlay` | 在一切列之上、滚动容器之外 |
| 工作区通知 | `workspace.toast` | |
| 设置项 | `settings.general.item` | 单个开关/选项 |
| 插件自己的配置页 | `settings.section`（已用） | |
| 对话内工具结果 | `tool.call.toolview`（已用） | |

**规则**：`sidebar.panellist` 的 `id` 与 `main` 的 `key` 必须相同，才会互相寻址。

### 4.2 禁止

```ts
// 全部禁止
document.querySelector('[class*="sidebarCol"]')
document.querySelector('[class*="logoRow"]')
document.querySelector('[class*="newSession"]')
new MutationObserver(ensure)   // 等待插入点
```

DSH 的内部类名是构建期哈希（`Fw9vfq_trigger` 这种），**任何时候都可能变**。`[class*="..."]` 匹配的是语义名片段，而语义名是打包器保留的偶然产物。

### 4.3 CSS 怎么找到宿主元素

CSS 执行不了 JS，所以「禁止猜类名」在样式表这一侧必须有一个可执行的替代：**由 JS 从 slot 锚点解析出元素，打上本插件自己的属性，样式表只按属性选择。**

| 样式表要选的东西 | 谁打标记 | 属性 |
|---|---|---|
| 中心列（会话所在的 grid item） | `mount.tsx` 的 `conversationColumn()` | `data-dsh-imagegen-center-col` |
| 侧栏 shell root | `sidebar-entry.ts` | `data-dsh-imagegen-sidebar-root` |
| 侧栏自有 chrome 区块（品牌行 / 底栏 / 设置区 / 历史区 / 含 New Session 的那一行） | `sidebar-entry.ts` 的 `markBlocks()` | `data-dsh-imagegen-sidebar-block`、`data-dsh-imagegen-sidebar-region` |
| 「本 shell 的 chrome 已全部解析」的门控 | 同上，解析到品牌块才设 | `data-dsh-imagegen-shell-blocks` |

三条约束：

1. **门控优先于隐藏**。某个 shell 若没有品牌锚点，`shell-blocks` 不设，「隐藏外来条目」规则整体不生效——宁可另一个插件的条目短暂叠一下，也不能把 shell 自己的品牌行和底栏藏掉（那是坏界面）。
2. **不要用 `:has()` 表达「包含某节点」**。走 `:not(:has(...))` 的选择器在 jsdom 里既不解析也没有判别力，等于把规则排除在测试之外。需要这个语义时，由 JS 把外层区块一起标记，样式表只读属性。
3. **标记必须可回收**。React 重建会换掉列/根节点，旧标记要摘掉，否则两个元素同时带标记，规则会作用到已脱离的树上。

`scripts/verify-native-ui.mjs` 的规则 5 同时扫 `.ts`/`.tsx` 和 `.css`，违反即失败。

### 4.4 例外与降级

确实没有 slot 覆盖的能力（例如「打开设置并切换到我这一页」），当前实现是点 DOM 按钮。这类必须在代码里**显式标注** `// NATIVE-GAP:`，说明找的是哪个可访问性 affordance、失败时如何降级。允许降级，禁止静默。

---

## 5. 验收

`scripts/verify-native-ui.mjs` 会对以下项硬性失败：

1. `.css` 里任何 `#rgb` / `rgb()` / `rgba()` / `hsl()`
2. 任何 `border-radius: <数字>px`（`999px` 除外）
3. 任何 `font-size: <数字>px`
4. 任何不存在的 `--dsw-*` token 名
5. `src/client/**` 里任何 `[class*="..."]` 选择器
6. 任何 `prefers-color-scheme` / `body.dataset.theme`

浏览器层验收（`verify-ui-contracts.mjs`，真 Chrome）：

| 项 | 状态 |
|---|---|
| 中心列接管：外来条目被逐出、会话保留、shell 面板让位 | ✅ 已实现（`main slot` 三项断言） |
| 侧栏 chrome 在工作室激活时保留、外来条目隐藏 | ✅ 已实现（`smoke.mjs` D3，jsdom + 计算样式） |
| 明暗两态下计算样式的对比度达标 | ⚠️ 有测量，但**不在 `pnpm test` 里**（见下） |
| 改 `--dsh-content-font-size` 后插件文字跟着变 | ❌ **尚未实现，且当前 0 处使用该变量**（182 处 `font-size` 全是固定值） |
| 切换界面语言后插件文案跟着变 | ⚠️ 三语 key 有 smoke 覆盖，界面实际切换无浏览器断言 |

### 对比度与布局的测量（`scripts/studio-preview-shot.mjs`）

用真实 primitives + 从安装版 DSH 抽出的真 token 渲染真实 `ImageGenPanel`，再在真 Chrome 里量：

```
pnpm studio:preview            # 打 .studio-preview/preview.js（6 MB）
node scripts/studio-preview-shot.mjs
```

它同时产出 `.studio-preview/{light,dark,comparison}.png` 和四份页内审计：布局（裁切 / 越界 / 横向溢出）、顶部切换器与右侧控件是否重叠、侧栏接管（tab 注入、shell chrome 保留、外来条目隐藏）、文字对比度（明暗各一遍）。

2026-10-23 实测：浅色 60 个文本样本中 1 个低于 3:1（`已连接` = 2.28:1，用 DSH 同款 `--dsw-alias-state-success-primary`，与原生 `ConnectionIndicator` 一致），深色 0 个；裁切 0、越界 0、重叠 0。

**它不在 `pnpm test` 里**：需要已安装的 DSH 与本机 Chrome，还要先打 6 MB 预览包，不适合做每次提交的闸门。也就意味着**这条基线不会自动防止回归** —— 改完 UI 要手动跑一次。

最后两项仍是**已知缺口**。写在这里是为了不让它们被误当成已通过 —— 「看起来像原生」在这两点上还没有证据。

其中字号一项要先做决策：DSH 原生自身 89% 的 `font-size` 也是固定值，只有 11% 走 `--dsh-content-font-size`，所以「全部跟随字号设置」不是原生行为。合理目标是**正文类文字跟随、紧凑控件（chip、徽标）保持固定**，但这条需要先量出插件里哪些是正文。

---

## 6. 参照物

要判断"原生长什么样"，看这些包的内嵌 CSS：

```
dsh-client-ui-jobs          菜单、紧凑按钮
dsh-client-ui-settings-*    表单、卡片
dsh-client-ui-sidebar       侧栏、面板图标
dsh-client-ui-session       会话行、hover 态
dsh-client-ui-primitives    组件实现（在 web-frontend 的 dist 里）
```

提取方式：

```bash
cd /tmp/dshnative
python3 - <<'EOF'
import re
s=open('dsh/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/client.js').read()
print(re.search(r'const css = (`|")(.{200,60000}?)\1', s, re.S).group(2))
EOF
```

主题 token 全表：`dsh-client-ui-theme/lib/client.js`（403 个定义）。
slot 契约全表：`dsh-cordis-client-runner/lib/client.js`（搜 `key: "sidebar.panellist"`）。

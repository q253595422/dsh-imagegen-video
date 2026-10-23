# task-4 · 挂载层：sidebar-entry + mount + surface-theme + GooeyNav + README

**仓库** `/Users/malang/chajian/dsh-imagegen-video`


> **行号基准（2026-10-23 09:27 已修）**：守卫脚本原先有两个打印行号的 bug
> （剥注释吃掉了换行、`var(--x,#hex)` 替换成短标记后索引前移），会把违规报到**上一行或更靠前的无关行**。
> 已修复并逐行验证。如果你在修复前拿到过行号，**重新跑一次**再动手。
> 现在报出的行号是精确的：`file:LINE` 指向的那一行就是违规所在行。


## 所有权

你独占这 5 个文件，**不许改其它任何文件**：

| 文件 | 违规 | 干什么 |
|---|---|---|
| `src/client/sidebar-entry.ts` | 6 | 把插件塞进 DSH 侧边栏 |
| `src/client/mount.tsx` | 6 | 根节点挂载 |
| `src/client/surface-theme.ts` | 1 | 宿主主题读取 |
| `src/client/GooeyNav.tsx` | 1 | 导航 |
| `README.md` | 1 | 示例 CSS 用了裸色 |

同仓另有 4 个 Bot 并行改 CSS。改到别人的文件 = 冲突 = 返工。

## 必读

1. `docs/native-ui-contract.md`（契约）
2. `scripts/verify-native-ui.mjs`（守卫）
3. **`/tmp/dshnative/dsh/node_modules/@deepseek-ai/` 的原生挂载源码** —— 判断「什么算原生」的唯一依据

## 真正的重点：12 处 `[class*=]` 选择器

这是本任务的核心，不是颜色。先看清现状：

```
sidebar-entry.ts:20  [class*="sidebarCol"]
sidebar-entry.ts:21  [class*="dshDesktopSidebarSurface"]
sidebar-entry.ts:22  [class*="dshDesktopUpstreamSidebar"]
sidebar-entry.ts:39  [class*="logoRow"]
sidebar-entry.ts:62  [class*="newSession"]
sidebar-entry.ts:75  [class*="regionArea"]
mount.tsx:16         [class*="centerCol"]
mount.tsx:222        [class*="sessionRow"]
mount.tsx:222        [class*="projectRow"]
mount.tsx:222        [class*="searchResultRow"]
mount.tsx:222        [class*="searchResultWorkspace"]
mount.tsx:222        [class*="newSession"]
```

**问题**：这些是猜测 DSH 内部 class 名来定位 DOM 节点。

- DSH 的 class 名是构建期生成的，改版就变
- `[class*="newSession"]` 这种子串匹配会误命中（DSH 若有 `newSessionButton`、`newSessionRow`，全都中）
- 这是**整个插件里最容易因为 DSH 升级而静默失效**的部分 —— 失效后不报错，只是插件不见了

**这次要求**：查清 DSH 是否提供了正式的挂载点。

去 `/tmp/dshnative/dsh/node_modules/` 里找：
- 有没有 slot / portal / extension point 之类的注册 API
- DSH 自己的侧边栏组件是否导出可扩展的接口
- `@deepseek-ai/dsh-client-*` 包里有没有类似的插件挂载机制

**三种结果，三种处理**：

1. **找到官方挂载点** → 改用官方 API。这是最好的结果。
2. **没找到，但有稳定约定**（比如某个 `data-*` 属性）→ 改用属性选择器，比 class 子串稳。
3. **确实没有** → **保留现状，但加上防护**：
   - 每个查询后面加「找不到就静默跳过」的判断（不要抛错）
   - 在代码顶部写一节注释，列出当前依赖的 DSH 版本和全部 class 名，说明升级时要复核
   - 报告里明确写「DSH 未提供挂载点」

**不要为了「消除违规」而把代码改成查不到就崩。** 保持功能优先。

## 剩下 2 处

### `surface-theme.ts:46` — `matchMedia(`

读系统暗色偏好。**这一处大概率是对的**，因为系统主题偏好本来就该读。判断标准：如果它是「用户没设主题时的兜底」，保留并加注释说明；如果是「用来推导界面色的」，改成读 DSH 注入的主题。

### `GooeyNav.tsx:64` — `dataset.theme`

从 DOM 读主题。理想做法是注入主题服务。但**先查清 DSH 有没有暴露这个能力** —— 如果没有，读 `dataset` 是当下唯一办法，加注释即可。

注意：这文件之前修过 activeIndex 短路 bug，**只改主题读取那一处，别动导航逻辑。**

## `README.md`（1 处）

README 里有示例 CSS 用了裸色（如 `#1a1a1a`）。改成 `var(--dsw-alias-bg-base)`。

**这是给用户抄的模板**，错例会被复制进别人的项目，必须改。

## 额外任务：卸载清理（只查不改）

搜 `dispose` / `unmount` / `destroy` / `removeEventListener`：

- 插件在 `<html>` / `<body>` 上加的 class、data 属性、style 是否复原
- 注入的 `<style>` 标签是否移除
- DOM 事件监听器是否解绑
- 定时器是否清理

**只读检查，把发现写成清单回报。** 不要动 `src/index.ts`（不归你）。这一条即使没违规我也要。

## 验收（硬性，贴实际输出）

```bash
cd /Users/malang/chajian/dsh-imagegen-video

DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs --verbose 2>&1 | grep -E "sidebar-entry|mount.tsx|surface-theme|GooeyNav|README"
# 应无输出，或只剩你有注释说明的

node scripts/verify-ui-contracts.mjs
pnpm typecheck && pnpm build
pnpm test
```

## 禁止

- 改任何 `.module.css`
- 改 `src/index.ts`
- 修改守卫脚本放行
- 把 `[class*=]` 改成「查不到就抛异常」

## 环境

- DSH 原生源码：`/tmp/dshnative/dsh/node_modules/@deepseek-ai/`
- 真 Chromium：`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`

## 报告要求

回给我，按重要度排序：

1. **DSH 有没有官方挂载点** —— 找到什么、证据是哪个文件哪一行、你选了上面三种方案的哪一种
2. **卸载清理问题清单**（我很关心这条）
3. 2 处主题读取怎么处理的
4. 四条验收命令的**实际输出**

第 1 条是这次重置能不能「扛住 DSH 升级」的关键。找不到就说找不到，不要编。

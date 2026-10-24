# task-23 — P4 A+ 详情页：12 模块 + 浏览器端 canvas 拼长图

## 0. 你的工作区

```
/Users/malang/chajian/dsh-imagegen-video/.worktrees/aplus    分支 task/aplus    from 6f8f882
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。命令都在这里跑。

这棵树已含上一轮全部成果（多参考图、爆款复刻、服饰穿戴、上架文案、7 项导航）。你加第 8 个 workspace，**不许回退任何已有东西**。

## 1. 要做的东西

新 tab「A+ 详情页」：勾选模块 → 逐块生成图 → **在浏览器里用 `<canvas>` 竖向拼成一张长图并导出 PNG**。

### 1.1 十二个模块（顺序即拼装顺序）

| key | 名称 | 建议比例 | 提示词要点 |
|---|---|---|---|
| `brand` | 品牌海报 | 16:9 | 品牌调性大图，主视觉，可留标题区 |
| `selling-point` | 核心卖点 | 4:3 | 1–3 个卖点的图标/文字块版式，商品为主体 |
| `scene` | 场景共鸣 | 4:3 | 真实使用场景，人物/环境氛围 |
| `detail` | 细节特写 | 1:1 | 材质/工艺微距特写，浅景深 |
| `comparison` | 参数对比 | 4:3 | 左右或上下对比版式，留出对比栏位 |
| `steps` | 使用步骤 | 4:3 | 2–4 步流程版式，带编号位 |
| `model` | 模特上身 | 3:4 | 人物穿着/使用商品，棚拍 |
| `trust` | 信任背书 | 4:3 | 认证/奖项/质检图标版式 |
| `bundle` | 套装清单 | 4:3 | 平铺俯拍，配件罗列整齐 |
| `spec` | 规格表 | 4:3 | 表格版式留白，横平竖直 |
| `faq` | 常见问题 | 4:3 | Q&A 版式，成对留白 |
| `closing` | 结尾海报 | 16:9 | 收尾大图，可放 slogan |

第一版这 12 个写死，**不做自定义模块**。每个模块：勾选框、一句文案输入（可空）、生成按钮、缩略图、单块重生成。

### 1.2 生成

- 走 `api.generate`，参数形状照抄 `src/client/ReplicaWorkspace.tsx:227`（`mode: 'text' | 'edit'`、`model`、`prompt`、`size`、`quality`、`n`、`detail: ''`、可选 `channelId`、可选 `image`/`images`/`refName`）。
- 用户可传**一张商品参考图**（走 `image`），所有模块共用。`size` 用 §1.1 的建议比例（引擎不认的比例会自动映射，不用你处理）。
- 并发上限 3，其余排队。每块独立状态（待生成/生成中/完成/失败），**单块失败不许整批停**。
- 模型选择复用 `ModelPicker` + `resolveModelChoice`（照 ReplicaWorkspace 的用法）。

### 1.3 拼长图（本期技术核心）

- **纯浏览器 canvas，不许加任何 npm 依赖**（不要 `sharp`、不要 `node-canvas`、不要 `puppeteer`）。
- 宽度可选 `750 / 970 / 1200`，默认 `970`；模块间距可选 `0 / 16 / 32`，默认 `16`。
- 每块高度 = `width / 实际图片宽高比`；读不到宽高时用 §1.1 的建议比例兜底。
- 导出 `image/png`，文件名 `aplus-<yyyyMMdd-HHmmss>.png`，用 `<a download>`（Object URL，用完 `revokeObjectURL`）。
- **高度护栏**：总高度 > 16000px 直接拒绝并提示「模块太多，请减少勾选或换窄宽度」。不许静默截断、不许降采样糊图。
- 跨域：图片来自本机 base64 data URL，不是外链，所以不会污染 canvas。若某块是 http URL，必须 `crossOrigin='anonymous'` 并在失败时明确报「该图片无法绘制」。

### 1.4 布局纯函数（必须可单测）

新文件 `src/client/aplus-layout.ts`，导出：

```ts
export interface AplusModuleSpec { key: string; label: string; aspect: number }
export interface AplusBlock { key: string; y: number; width: number; height: number }
export interface AplusLayout { blocks: AplusBlock[]; height: number; overflow: boolean }

export const APLUS_MAX_HEIGHT = 16000
export function composeAplusLayout(input: {
  modules: Array<{ key: string; aspect?: number }>
  width: number
  gap: number
}): AplusLayout
```

规则：按传入顺序竖排、`y` 从 0 起累加、块间加 `gap`、末块后不加 `gap`；`height > APLUS_MAX_HEIGHT` 时 `overflow: true`（仍算出真实高度，别截断）。

**所有几何数学都放这个文件**，React 组件只负责调它 + 画。这样 jsdom 里没有 canvas 也测得动。

## 2. 接线（只有这四处）

`src/client/ImageGenPanel.tsx` 只许改这四处，其余一个字不动：

1. `:632` 附近 `PanelWorkspace` 类型加 `'aplus'`。
2. `:3127` 的 `<GooeyNav>`：`items` 加第 8 项、`activeIndex` 三元链加一段（`aplus` → 7）、`onSelect` 分支链加一个 `else if (index === 7) setWorkspace('aplus')`。
3. `:3745` 附近加一行：`{workspace === 'aplus' ? <AplusWorkspace api={api} config={config} … /> : null}`。
4. 顶部 `import` 加一行。

**必须精确报告这四处的行号和原文。**

## 3. 必须同步改的既有断言（这一个文件允许改）

加第 8 个 tab 会让导航计数从 10/7/10 变成 11/8/11。`scripts/smoke.mjs` 这三行必须改，**只许改数字和文案，不许改断言结构**：

```
:5885  assert.equal(tablistButtons.length, 10, 'top nav has seven entries …')
:5899  assert.equal(..., 7, 'generation sub-modes hide in the ecommerce workspace')
:6044  assert.equal(..., 10, 'generation sub-modes return in the normal workspace')
```

改成 11 / 8 / 11，文案里的 `seven entries` 改成 `eight entries`。**报告这三行的改前改后。**

## 4. i18n

- 新键一律 `aplus.` 前缀，写进 `src/client/locales.ts`：`zh` 是键源，`en` / `ru` 同步。
- 12 个模块名、按钮、状态、护栏提示、导出提示全要键，**不许留裸 key、不许中文硬编码进组件**。

## 5. 不许碰

```
src/engine.ts
src/video-engine.ts
src/routes.ts
src/model-store.ts
package.json / pnpm-lock.yaml
CHANGELOG.md / docs/releases/**
其它 workspace 的文件（ReplicaWorkspace / OutfitWorkspace / PptWorkspace / ListingCopyCard）
```

## 6. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`（抢 CPU，我自己跑）。你自己跑：

```bash
cd /Users/malang/chajian/dsh-imagegen-video/.worktrees/aplus
npx tsc --noEmit
npx tsdown
node scripts/smoke.mjs
```

## 7. 必须自己证明的

1. **布局数学**：`composeAplusLayout` 至少四个用例——三块 970 宽 gap 16 的 y/height 逐项断言；单块；空数组（height 0）；12 块 970 宽触发 `overflow: true` 且 height 是真实值不是 16000。
2. **导出真的画出像素**：用真 Chrome（`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`，`--remote-debugging-port=0` 或 `--headless --dump-dom` 自选）跑一个最小页面：喂两张已知纯色 data URL，走你的 `composeAplusLayout` + 绘制，`toBlob` 后取 PNG 字节，断言宽 = 970、高 = 计算值、左上与右下角像素是预期的两个颜色。**不许只说「在浏览器里能导出」**。
3. **护栏**：12 块 970 宽时 UI 上确实拒绝导出并给出提示文案（断言文案出现）。
4. **负向**：把 `gap` 从累加里删掉，用例 1 必须红；把高度护栏拿掉，用例 3 必须红。贴出红的结果。
5. **单块失败不整批停**：假上游让第 2 块返回 500，断言第 1、3 块仍完成、第 2 块显示失败。

验证产物只写 `/tmp/`。

## 8. 诚实边界

- **不许**在 UI 或文档里说「符合亚马逊 A+ 官方规范」——我们没核对过平台文档，只能说「长图导出」。
- **不许**承诺「一次生成全部 12 块」。逐块生成，用户看得见每块状态。
- 提示词里让模型「留出版式位置」是**导引**，不是保证；报告里如实写。

## 9. 报告格式

```
## 1. 新建了哪些文件、各多少行
## 2. ImageGenPanel.tsx 四处接线的精确行号 + 原文
## 3. smoke.mjs 三行改前改后
## 4. 布局数学四个用例的结果
## 5. 真 Chrome 导出像素的实测（宽 / 高 / 两个角点颜色）
## 6. 护栏与单块失败的实测
## 7. 负向做坏了什么、红了什么
## 8. 我没做到 / 有疑问的
```

## 10. 一句话

这一期的成败不在 12 个模块名，而在于**长图是不是真的拼出来了、像素对不对**。宁可 12 个模块少两个，也不许交一个「点导出没反应」或者「导出图是空白」的东西。

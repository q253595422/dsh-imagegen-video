# task-22 — P1 商品套图补全：白底图合规 + 卖点图版式参考

## 0. 你的工作区

```
/Users/malang/chajian/dsh-imagegen-video/.worktrees/p1    分支 task/p1    from 6f8f882
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。所有命令在这里跑。

这棵树已经包含上一轮的全部成果（多参考图按角色真传图、爆款复刻、服饰穿戴、上架文案、7 项导航），**你在这基础上加，不要回退任何东西**。

## 1. 要做的东西

对标 designkit 商品套图里我们缺的两项。就这两项，别扩。

### A. 白底图平台合规（主图开关）

主图现在写的是「干净背景，突出商品主体」，**不保证纯白**。亚马逊一类平台对主图有硬要求。加一个开关，默认**关**。

开启后，只对 `key === 'main'` 的 slot 生效：
- prompt 追加硬约束：纯白背景 `#FFFFFF`、无文字 / 无水印 / 无边框 / 无投影 / 无道具 / 无场景、商品正面平铺、商品占画面 ≥85%、主体边缘完整不被裁切。
- **尺寸强制 `1:1`**（平台主图要求正方形）。
- UI 上必须写明「开启后主图强制 1:1」，**不许静默改尺寸**。

数据结构：
- `src/protocol.ts` 的 `ProductSetDraft`（`:1582` 附近）加一个可选布尔字段 `whiteBackground?: boolean`，照现有可选字段的写法。
- `src/client/ImageGenPanel.tsx` 的 `defaultEcommerceDraft()`（`:501` 附近）默认 `false`。
- 历史恢复处（`:1124` 附近 `merged.slots` 那段同一个 merge 函数）要能读回；**旧草稿没有这个字段时按 `false`**，不许因为缺字段而崩或变成 `undefined` 行为。
- 提交处（`handleEcommerceGenerate` → `buildRequest`，`:1890-1930`）里按 slot 决定 `size`：`whiteBackground === true && slot.key === 'main'` → `'1:1'`，其余不变。

### B. 卖点图版式参考（新增参考角色 `layout`）

现在参考角色是 `'none' | 'product' | 'packaging' | 'detail' | 'style'`，**没有版式**。要让用户传一张排版模板图，让卖点图借它的版式。

- `src/protocol.ts:1579` `EcommerceRefRole` 加 `'layout'`。
- `src/client/ImageGenPanel.tsx:152` 的 `ECOMMERCE_ASSET_ROLES` 加 `'layout'`，`:154` 的 `ECOMMERCE_ROLE_PROMPT_LABELS` 加文案「版式参考」。
- 提示词里要说清边界：**只借用版式的分区、留白比例、文字块位置和视觉节奏，不得复制版式图里的商品、不得把版式图当商品参考**。
- 上传区、角色下拉、slot 的参考角色下拉都要能选到 `layout`（下拉选项是从 `EcommerceRefRole` 派生的就自动有了，自己确认一遍）。
- `asset.role === 'layout'` 的图**同样要真传**（走 `image` + `images`，和别的角色一样，别又变成只拼一句话）。

## 2. 硬约束

- `src/client/ImageGenPanel.tsx` 已 4400+ 行，**只许改 §1 点名的位置**，其余一个字不许动。改完精确报告改了几行、哪一行、原文。
- 主体逻辑放新函数或新文件；能抽成纯函数（比如「给定 draft + slot 返回 size」和「给定 draft + slot 返回白底约束片段」）的就抽出来，我要能单测。
- i18n 键加 `ecommerce.` 前缀，改 `src/client/locales.ts`（`zh` 为键源，`en` / `ru` 同步）。**不许留裸 key**。
- 不许加任何 npm 依赖。

## 3. 不许碰

```
src/engine.ts
src/video-engine.ts
package.json / pnpm-lock.yaml
CHANGELOG.md / docs/releases/**
scripts/smoke.mjs 的现有断言（你只许新建自己的脚本）
其它 workspace 的文件（ReplicaWorkspace / OutfitWorkspace / ListingCopyCard / PptWorkspace）
```

## 4. 参考图上限是 5 张，不许写 6

`src/engine.ts:955-958` 是 `slice(0, 4)`，加上 `image` 那 1 张，实际到模型 5 张；grok / nanobanana **只认 1 张**，其余静默丢弃。

`MAX_ECOMMERCE_ASSETS` 是 4（`:153`）。如果你为了 `layout` 把它调大，**必须同时保证 UI 上的数字不骗人**。

## 5. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`（抢 CPU，我自己跑）。你自己跑：

```bash
cd /Users/malang/chajian/dsh-imagegen-video/.worktrees/p1
npx tsc --noEmit
npx tsdown
node scripts/smoke.mjs
```

## 6. 必须自己证明的

1. **白底开关真的生效**：本地假上游 + `listen(0)`（照 `scripts/smoke-video.mjs:56-130` 的写法），断言开启时主图请求 `size === '1:1'` 且 prompt 含白底硬约束关键词；关闭时 `main` 的 size 与原来一致、prompt 不含。
2. **`layout` 角色真传图**：断言上传一张 layout 图后，请求体里 `image` 或 `images` 真的带上了它，而不是只出现在 prompt 文字里。
3. **旧草稿兼容**：构造一个没有 `whiteBackground` 字段的旧 draft，恢复后是 `false`，不报错。
4. **负向**：把白底硬约束那一段删掉，第 1 条断言必须变红；把 layout 的图不上送，第 2 条必须变红。贴出红的结果。

验证产物只写 `/tmp/`。

## 7. 报告格式

```
## 1. 我改了 ImageGenPanel.tsx 的哪几行（精确行号 + 原文）
## 2. 我改了 protocol.ts / locales.ts 的哪些位置
## 3. 白底开关的实测（开 / 关两组的请求体）
## 4. layout 角色真传图的实测
## 5. 旧草稿兼容的实测
## 6. 负向做坏了什么、红了什么
## 7. 我没做到 / 有疑问的
```

## 8. 一句话

这一轮最在意的不是加了多少开关，而是**「白底」不能只是提示词里一句好听话**，以及**新加的参考角色不能又变成「只拼一句话、图没传」**。

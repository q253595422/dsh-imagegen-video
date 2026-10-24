# task-20 — 上架文案（把商品套图的文字部分真生成出来）

## 0. 你的工作区

```
/Users/malang/chajian/wt-listing      分支 task/listing    from 21c39d8
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。所有命令在这里跑。

## 1. 要做什么

designkit 的「商品套图」里有个「附加功能 → 商品上架文案生成」。我们的插件现在**完全没有**这个能力：`src/client/ImageGenPanel.tsx` 里只有图片 prompt 的润色（`polishEcommercePrompt`，`:1687`），没有任何地方产出标题、卖点、描述。

要做的是：根据商品信息，生成一份能直接粘到淘宝/亚马逊后台的上架文案。

**输出结构**（你按平台差异调整，但至少这几项）：

```json
{
  "title": "≤ 60 字（淘宝）/ ≤ 200 字符（亚马逊）",
  "sellingPoints": ["3–5 条，每条 ≤ 20 字"],
  "description": "300–600 字，分段",
  "keywords": ["5–10 个搜索词"],
  "specs": [{ "name": "材质", "value": "棉" }]
}
```

平台字数上限差异是真实的（淘宝 60、亚马逊 200 字符、京东 60），**要按 `draft.platform` 取对应上限并在 UI 上显示当前字数**。

## 2. 通道已经现成，别再造

`src/prompt-enhancer.ts` 已有：

```ts
export async function chatComplete(config: PromptModelConfig, options: ChatOptions): Promise<string>
export function jsonPayload(content: string): unknown   // 剥 ```json 围栏 + 取最外层 {} 或 []，失败返回 undefined
```

路由侧写法照抄 `src/routes.ts:1000-1025`（`PROMPT_ENHANCE_API` 那两个 handler 的形状：`guard` → `readJsonBody` → `resolvePrompt()` → `writeJson`）。

**注意**：`chatComplete` 在没配提示词模型时抛 `'chat model is not configured (left sidebar > Image settings > Prompt enhancement)'`。这条错误要原样传给用户，不要吞掉、不要换成「生成失败」。

## 3. 硬约束：代码放新文件

`src/client/ImageGenPanel.tsx` 已 4300+ 行，**还有 3 个 Bot 同时在改它**。

- 宿主侧逻辑放新文件 `src/listing-copy.ts`（你新建，含 system prompt 与 JSON 解析/校验）。
- 客户端 UI 放新文件 `src/client/ListingCopyCard.tsx`（你新建）。
- `ImageGenPanel.tsx` 只允许：在商品套图的表单区（`:3217` 起那块）插一个 `<ListingCopyCard … />`，以及给它传 `draft`。**精确报告行号与原文。**
- `src/routes.ts` 加一个 handler、`src/protocol.ts` 加一个 `LISTING_COPY_API` 常量、`src/client/api.ts` 加一个方法。**这三处改动都要报告精确位置。**
- i18n 键统一 `listing.` 前缀，改 `src/client/locales.ts`（`zh` 为键源，`en` / `ru` 必须同步，否则类型报错）。

## 4. 必须处理的诚实问题

1. **模型不一定会吐合法 JSON。** `jsonPayload` 会返回 `undefined`。这时不许静默失败、不许把原文塞进 UI 当文案 —— 要给出可操作的失败提示（「模型返回的不是结构化文案，点此重试」之类）。
2. **字段可能缺失或超长。** 要有校验：缺字段补空、超长给用户看到「超出 N 字」，不要替用户截断还说成功。
3. **不许编造商品事实。** 提示词里必须明确「只使用输入里给出的事实，不要虚构材质、产地、认证」。如果用户没填材质，输出里就不能出现具体材质。这条要用实测证明（输入不填材质 → 输出里无材质词）。

## 5. 不许碰

```
src/engine.ts
scripts/**（除你新建的验收脚本）
package.json / pnpm-lock.yaml
src/prompt-enhancer.ts      — 已够用，不要改
src/client/ImageGenPanel.tsx — 只许 §3 说的一处插入
CHANGELOG.md / docs/releases/**
```

可以新建：`src/listing-copy.ts`、`src/client/ListingCopyCard.tsx`。
需要改：`src/routes.ts`、`src/protocol.ts`、`src/client/api.ts`、`src/client/locales.ts`、`src/client/ImageGenPanel.tsx`（仅 §3）。

## 6. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`（3 分钟+，抢 CPU）。你自己跑：

```bash
cd /Users/malang/chajian/wt-listing
npx tsc --noEmit
npx tsdown
node scripts/smoke.mjs      # 你动了 routes/protocol 就必须跑
```

验证产物只写 `/tmp/`。

## 7. 必须自己证明的（用假上游，不要真调模型）

起本地假上游（参考 `scripts/smoke-video.mjs:56-130` 的 `createServer` + `listen(0)`），让 `chatComplete` 打到它上面，**用固定回复模拟三种情况**：

1. **正常 JSON** → UI 正确渲染出 title / sellingPoints / description / keywords / specs。
2. **带 ```json 围栏的 JSON** → 仍能解析（`jsonPayload` 应该能处理，实测确认）。
3. **非 JSON 的散文回复** → 必须给出可操作错误，不许把散文当文案显示。
4. **超长 title**（例如 120 字）→ UI 显示「超出上限」，不许静默截断。

外加：
5. **不填材质时输出里无材质词**（§4 第 3 条）。
6. `npx tsc --noEmit` 与 `npx tsdown` 都 EXIT=0。

每条都要贴真实输出原文。

## 8. 报告格式

```
## 1. 我新建了哪些文件
## 2. 我改了 ImageGenPanel.tsx 的哪几行（精确行号 + 原文）
## 3. 我改了 routes.ts / protocol.ts / api.ts 的哪些位置
## 4. locales.ts 新增了哪些键
## 5. 五种假上游场景的实测原文
## 6. 平台字数上限我是怎么处理的
## 7. 我没做到 / 有疑问的
```

## 9. 一句话

这一项的失败模式几乎全在「模型给的 JSON 不合规」上。**先把四种坏输出处理对，再谈文案质量。**

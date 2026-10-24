# task-16 — P0 底座：按角色传多参考图

## 0. 你的工作区（重要，别在别处干活）

```
/Users/malang/chajian/wt-p0a        分支 task/p0a     from 21c39d8
```

这个 worktree 已建好，`node_modules` 已用硬链接拷入（与本仓库同一份 inode，不要 `pnpm install`）。
**一切命令都在这个目录里跑。** 不要碰 `/Users/malang/chajian/dsh-imagegen-video`（那是主工作区）。

```bash
cd /Users/malang/chajian/wt-p0a
npx tsc --noEmit          # 应 EXIT=0
npx tsdown                # 应 EXIT=0，约 0.6 s
```

## 1. 要解决的问题

现在商品套图的参考图**只是拼一句文字**，图根本没按角色传给模型。

`src/client/ImageGenPanel.tsx`：

```ts
// :539-549 ecommercePrompt()
:543-545   本图以上传的${ECOMMERCE_ROLE_PROMPT_LABELS[slot.refRole]}图片为参考，商品与风格必须与参考图保持一致；
```

而 `buildRequest`（`:1842-1856`）只取该角色的**第一张**：

```ts
const asset = refRole === 'none' ? undefined : ecommerceAssets.find(item => item.role === refRole)
...
...(asset !== undefined ? { image: asset.dataUrl, refName: asset.name } : {}),
```

用户传 4 张商品图（正面/背面/侧面/包装），实际只有 1 张到了模型手上。

## 2. 宿主侧已经支持多参考图 —— 不要再改协议字段

这一点我已核实，**`GenerateRequest` 已经有 `images?: string[]`**（`src/protocol.ts:1648`，注释「The first image stays in `image`」）。

引擎侧（`src/engine.ts`）：
- `:955-958` `const extras = (request.images ?? []).filter(...).slice(0, 4).map(decodeReference)`
- generic else 分支：`extras.length > 0` 时逐张 `form.append('image[]', …)`
- Seedream 分支：`image: [request.image, ...(request.images ?? []).filter(...).slice(0, 4)]`
- chat 协议 `:1387-1394`：`[request.image, ...(request.images ?? [])].filter(...).slice(0, 5)`
- `:1620` `if (request.image !== undefined) shape.referenceImages = 1 + (request.images?.length ?? 0)`

**通道差异必须在 UI 上说清楚（这是本轮的核心判断，不许糊过）：**

| 通道 | 实际能收几张 |
|---|---|
| Grok（`isGrokImagine`） | **1**（只用 `request.image`） |
| Nano Banana（`form.append('image', …)`） | **1** |
| Seedream | 1 + 4 |
| generic / chat | 1 + 4（chat 上限 5） |

也就是说「传 4 张」在 Grok / Nano Banana 上会被静默丢掉 3 张。**你要么在 UI 上按当前选中模型提示上限，要么在提交时把被丢的图明确告知用户。二选一，必须做，不许假装 4 张都到了。**

## 3. 要交付什么

### 3.1 每个角色支持多选（上限沿用现有规则）

现状：`src/client/ImageGenPanel.tsx:1718-1756` `acceptEcommerceFiles(files, role)`，`room = role === 'style' ? 1 : Math.max(0, MAX_ECOMMERCE_ASSETS - ecommerceAssets.filter(item => item.role !== 'style').length)`，`MAX_ECOMMERCE_ASSETS = 4`（`:150`）。

`buildRequest` 改成把**该角色的全部资产**按顺序拼成 `{ image: first, images: rest }`：

```ts
const assets = refRole === 'none' ? [] : ecommerceAssets.filter(item => item.role === refRole)
// image 放第一张（单参考通道只认它），其余放 images
```

顺序必须是用户上传顺序（`ecommerceAssets` 数组顺序已经是它）。

### 3.2 参考图条款不再是「一句话」，而是按角色列清楚

`ecommercePrompt`（`:539-549`）现在只拼一句。改成按实际传图列出每张的用途，例如：

```
参考图 1（商品主体正面）：…
参考图 2（商品主体背面）：…
```

具体文案你定，但要求：**模型能分清哪张图对应哪条约束**，而不是笼统「以参考图为参考」。商品身份约束句（`:549` 那一大段 `商品身份与一致性约束`）保留。

### 3.3 通道上限可见

见 §2 的表格。UI 落点建议在现有 `:3582` `tt('ecommerce.noAssetWarn')` 附近或参考图 chips 区（`:3227-3245`）。用现成的 i18n 机制加键（`src/client/locales.ts` 的 `zh` 为键源，`en` 与 `ru` 必须同步加，否则类型报错）。

### 3.4 锚定链不能退化

`:1164-1193` 的锚定 effect 会把自己算出来的 `dataUrl` 作为 `image` 提交 main 之后的其余 slot，`remaining` 用解构剥掉 `image` / `refName`（`:1873-1876`）。你改成 `images` 之后，**剥除逻辑必须同时剥 `images`**，否则锚定图会和商品原图混在一起。

## 4. 不许碰的文件

```
src/engine.ts           — 引擎已支持，不要改
scripts/**              — 所有脚本只读，除你自己新建的验收脚本
package.json / pnpm-lock.yaml
CHANGELOG.md / docs/releases/**
src/client/ImageGenPanel.tsx 以外的任何 client 文件（除 locales.ts）
```

你可以改：`src/client/ImageGenPanel.tsx`、`src/client/locales.ts`、`src/protocol.ts`（只加字段/类型，不改已有字段语义）、`src/client/panel.module.css`（只追加）。

## 5. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative          # 绝对不许跑
```

不许跑全量 `pnpm test`（那要 3 分钟以上且会与其他 Bot 抢 CPU）。你自己按需跑：

```bash
cd /Users/malang/chajian/wt-p0a
npx tsc --noEmit
npx tsdown
node scripts/smoke.mjs      # 你改动影响宿主协议形状时跑
```

验证产物只写 `/tmp/`。

## 6. 必须自己证明的（不要转述我的说法）

1. **多图真的到了请求里**：起一个本地假上游（参考 `scripts/smoke-video.mjs:56-130` 的 `createServer` 写法，`listen(0)`），接住 `/v1/images/...` 的请求体，断言收到 N 张图而不是 1 张。**generic 通道和单图通道各测一次**，证明 §2 的表格。
2. **负向**：把 `images` 从请求里删掉，上面那条必须 FAIL。证明断言是承重的。
3. **锚定链不退化**：main 完成后，其余 slot 的请求里只有锚定图，没有商品原图残留。
4. `npx tsc --noEmit` EXIT=0、`npx tsdown` EXIT=0。

## 7. 报告格式

```
## 1. 改动清单
git diff --numstat 原文

## 2. 共享文件我要改哪几行
（这条最关键：ImageGenPanel.tsx / locales.ts / protocol.ts 各改了什么、大概几行、在哪个函数里）

## 3. 实测输出
每条断言的真实输出（原文，不要改写成「通过」）
含负向验证的 FAIL 原文

## 4. 通道差异是怎么告知用户的
截图不行就贴 DOM 断言

## 5. 我没做到 / 有疑问的
```

**同一时间还有 3 个 Bot 在并行改别的部分，所以 §2 必须写清楚**，我要按它排序整合。

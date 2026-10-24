# task-19 — P3 服饰穿戴 + 模特库

## 0. 你的工作区

```
/Users/malang/chajian/wt-outfit       分支 task/outfit     from 21c39d8
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。所有命令在这里跑。

## 1. 要做的东西（对标 designkit 的「服饰穿戴」）

把衣服穿到模特身上。

| 项 | 类型 | 说明 |
|---|---|---|
| 服装图 | 最多 **6 张** | 衣服本身（正面/背面/细节） |
| 模特来源 | 三个入口 | ①从模特库选 ②AI 生成一个 ③上传新模特 |
| 拍摄场景 | 预设 + 自定义 | 纯色棚拍 / 都市街头 / 街角咖啡 / 自然草坪 / 度假海滩 / 温馨居家 / 艺术展馆 / 自定义 / AI 推荐 |
| 比例 | 单选 | 3:4 / 1:1 / 9:16 |
| 分辨率 | 单选 | 1K / 2K |

## 2. 模特库要真的持久化

designkit 的模特库是云端资产；我们只能落本地盘。

**落点已定**：`~/.dsh/dsh-imagegen/models/`
（数据根见 `src/image-storage-path.ts:4`，`DEFAULT_ROOT = join(DSH_HOME || ~/.dsh, 'dsh-imagegen')`）

要做的：
- 一个宿主侧 store（照抄 `src/gallery-store.ts` 或 `src/template-store.ts` 的写法），存模特条目：`{ id, name, createdAt, file, mime }` + 图片文件。
- 对应路由挂到 `src/routes.ts`，路由常量放进 `src/protocol.ts`（照 `GALLERY_API` 的形状写 `MODEL_API`）。
- 客户端 `src/client/api.ts` 加对应方法（照 `listGallery` / `appendGallery` 的写法）。

**注意 `scripts/smoke.mjs` 会断言所有路径都在 `DSH_HOME` 之下**（`:2504-2513` 那段），你的新 store 必须遵守，否则 smoke 会红。

## 3. 硬约束：**代码放在新文件里**

`src/client/ImageGenPanel.tsx` 已 4300+ 行，且**同时还有别人在改它**。

- 主体实现放新文件 `src/client/OutfitWorkspace.tsx`（你新建）。模特库选单可以是子组件。
- `ImageGenPanel.tsx` 的改动**只允许接线**：`PanelWorkspace` 类型（`:589`）加 `'outfit'`、`GooeyNav`（`:3068-3084`）加一项、`onSelect` 加分支、渲染处加一行。
- **接线必须精确报告行号与原文**（两个人同时改同一段，我要按报告整合）。
- i18n 键统一 `outfit.` 前缀，改 `src/client/locales.ts`（`zh` 为键源，`en` / `ru` 同步）。

## 4. 多图通道：宿主已支持，别改协议

`src/protocol.ts:1648` 已有 `images?: string[]`；`src/engine.ts:955-958` 走 `slice(0, 4)`。
**「最多 6 张服装图」实际能到模型的是 5 张（1+4），且 Grok / Nano Banana 只认 1 张。**

这个落差必须如实告知用户（UI 上标实际值，或提交时说明），**不许写着 6 张实际只传 1 张还不作声**。

## 5. 「模特库」这件事的诚实边界

AI 生成模特 = 每次生成一张新图，**同一个人在两次生成之间不会长得一样**（除非用同一条种子/同一张参考图）。

如果你做不到「同一个模特在多张图里保持一致」，**在 UI 上别暗示能做到**，并在报告里明确写出来。这一条比功能本身重要。

## 6. 不许碰

```
src/engine.ts
scripts/**（除你新建的验收脚本）
package.json / pnpm-lock.yaml
src/client/ImageGenPanel.tsx —— 只许改 §3 的接线点
src/client/locales.ts —— 只许加 `outfit.` 前缀的键
CHANGELOG.md / docs/releases/**
```

可以新建：`src/client/OutfitWorkspace.tsx`、`src/model-store.ts`。
需要改：`src/routes.ts`、`src/protocol.ts`、`src/client/api.ts`（这几处按 §2 新增路由，改动要报告）。

## 7. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`（3 分钟+，抢 CPU）。你自己跑：

```bash
cd /Users/malang/chajian/wt-outfit
npx tsc --noEmit
npx tsdown
node scripts/smoke.mjs         # 你改了 routes/protocol 就必须跑，确认没打破宿主契约
```

渲染验证用现成工具链 `scripts/lib/headless-chrome.mjs`。验证产物只写 `/tmp/`。

## 8. 必须自己证明的

1. **模特库真的存在盘上**：写入 → 重启进程（或重新 `import` store 模块）→ 还能读出来。贴 `ls ~/.dsh/dsh-imagegen/models/` 的真实输出与 JSON 内容。
2. **路径在 DSH_HOME 之下**：`node scripts/smoke.mjs` 那一组断言必须绿。
3. **负向**：把 models 目录指向别处（例如硬编码绝对路径），smoke 必须红。
4. 服装多图的请求体断言（本地假上游 + `listen(0)`，参考 `scripts/smoke-video.mjs:56-130`）。

## 9. 报告格式

```
## 1. 我新建了哪些文件
## 2. 我改了 ImageGenPanel.tsx 的哪几行（精确行号 + 原文）
## 3. 我改了 routes.ts / protocol.ts / api.ts 的哪些位置
## 4. locales.ts 新增了哪些键
## 5. 模特库持久化的实测（重启后仍在）
## 6. 模特一致性这件事我做到了什么程度（诚实回答）
## 7. 我没做到 / 有疑问的
```

## 10. 一句话

这一轮我最在意的不是功能多全，而是**「模特库」不能是个假库**，以及**「6 张图」不能是假数字**。

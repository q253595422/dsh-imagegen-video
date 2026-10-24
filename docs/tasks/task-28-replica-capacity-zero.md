# task-28 — 爆款复刻：「参考图上限 0 张」与「本次会带上 0 张图」

## 现象（用户 2026-10-24 22:28 截图报障）

爆款图复刻（Hit remake）页，一张参考图都没选时，界面写着：

- 中文：`参考图上限 0 张，实际能到模型的张数取决于所选模型。`
- 英文：`You can pick up to 0 references; how many reach the model depends on the selected model.`
- 提交按钮旁：`本次会带上 0 张图（共 0 张）。` / `This run carries 0 of 0 images.`

「上限 0 张」是自相矛盾的话：上限是模型能力，不会是 0。

## 我已定位的根因（你不要重新排查，直接按这个改）

`src/client/replica-capacity.ts` 的 `referenceCapacity()`

```
const limit = editReferenceLimit(model, channel)   // 模型真实上限：1 或 5
const usable = Math.min(limit, picked)             // 本次会用几张
return { usable, dropped: max(0, picked - usable), ... }
```

`usable` 是「本次会用几张」，它的语义在 `picked === 0` 时必然退化为 0。

但 UI 把它当成了「上限」来显示：

- `src/client/ReplicaWorkspace.tsx:320-333` 的 `.capacity` 块，
  `references.length === 0` 分支传 `{ count: capacity.usable }` 给
  `replica.capacity.none`（文案定义 `src/client/locales.ts:1437` 中文 / `:2943` 英文 / `:4450` 俄文）。
- `src/client/ReplicaWorkspace.tsx:486` 传
  `{ used: Math.min(capacity.usable, picked), picked }` 给 `replica.submitHint`。

## 目标

1. **上限就必须是上限**：未选图时显示模型真实上限（`limit`），不是 `usable`。
2. **未选图时不要再说「本次会带上 0 张图」**：0/0 是噪音，改成一句有用的提示（例如提示先加参考图 / 说明本模型上限几张）。
3. 选 1 张及以上时，现有三态（`none` / `all` / `dropped`）的实际语义要**保持准确**，不许把「本次会用几张」也说成上限。
4. 三种语言（zh / en / ru）必须同步改，不许只改中文。

## 实现约束

- `ReferenceCapacity` 接口新增一个字段暴露真实上限（例如 `limit: number`），由 `referenceCapacity()` 填 `editReferenceLimit()` 的返回值。**不要**在 `ReplicaWorkspace` 里再调一次 `editReferenceLimit()` —— 那会造出第二份真相。
- `usable` / `dropped` 的既有语义一字不改，它们是 `splitReferences()` 的入参，动了会改请求负载。
- 最小改动。不重构 ReplicaWorkspace 的其它部分，不动样式。
- 文案 key 可以新增（`replica.capacity.none` 的语义变了，也可以顺手让它的文案不再暗示「本次」）；新增 key 三语都要有。

## 验收（必须你自己跑，贴原始输出）

1. `npx tsc --noEmit` → EXIT=0。
2. `node scripts/verify-native-ui.mjs` → PASS。
3. `node scripts/smoke.mjs` → `SMOKE TEST OK`。
4. **新增断言**（写进 `scripts/smoke.mjs` 爆款复刻那一段附近）：
   - 未选任何参考图时，容量行文案里**不出现** `0 张` / `up to 0`；
   - 未选任何参考图时，容量行文案里的数字等于该模型的真实上限（夹具里模型固定，直接断言那个数）；
   - 提交提示在 `picked === 0` 时**不等于** `本次会带上 0 张图（共 0 张）。`。
5. **负向对照（必须做，贴两次输出）**：
   - 把 `count` 参数临时改回 `capacity.usable`，第 4 条必须变红；
   - 改回来必须绿。
6. 不许跑 `pnpm test` / `pnpm test:negative`（我自己跑）。
7. 不许 `git commit / push / add / stash / reset / checkout`。验证产物只写 `/tmp/`。

## 交回时告诉我

改动文件 + 行号、新字段名、三语文案的最终措辞、第 4/5 条的原始输出、以及你没做到的部分。

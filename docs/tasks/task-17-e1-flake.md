# task-17 — 修掉那个会随机挡住发版的 flake（E1）

## 0. 你的工作区

```
/Users/malang/chajian/wt-e1         分支 task/e1       from 21c39d8
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。所有命令在这个目录跑。

## 1. 事实：这个 flake 真实存在，且挡过一次正式发版

1.16.1 发版时 CI 第一次跑**失败**，红在：

```
FAIL E1-E2 a video node carries its own model picker and regenerate control:
  E1: the leftover selection is cleared before the next read
CANVAS VIDEO SMOKE FAILED
```

`gh run rerun --failed` 后同一 commit **success**。所以是 flake，不是代码缺陷。

对照计数（上一轮别人测的，你可以复核）：
- 含改动的树：10 次跑，1 次红
- **未改动的树**：6 次跑，1 次红

→ 未改动的树上也红，与本轮改动无关。

## 2. 现场

`scripts/smoke-canvas-video.mjs:1750-1759`：

```js
const selectedNodes = () => [...view.querySelectorAll('[data-node-id]')]
  .filter(node => node.querySelector('[data-corner]') !== null)
const clearSelection = async () => {
  for (const selected of selectedNodes()) {
    const before = selectedNodes().length
    pointerDown(selected, true)
    assert.ok(
      await waitUntil(() => selectedNodes().length === before - 1),
      'E1: the leftover selection is cleared before the next read',
    )
  }
}
```

`waitUntil` 默认超时 `4000`（`:323`），轮询间隔 25 ms。
`pointerDown` 在 `:831-835`。

## 3. 我的怀疑方向（你可以否定，要用实测说话）

`for…of` 遍历的是 `selectedNodes()` 的**快照**，但循环体里 `before` 每次重新求值，而 `pointerDown(selected, true)` 带 `ctrlKey`。

如果 ctrl+点 的行为是「toggle」而不是「clear」：
- 当 `before === 2` 时点掉一个 → 剩 1 ✓
- 当 `before === 1` 时点掉唯一一个 → 剩 0 ✓
- **但如果某次 `pointerDown` 落在已经被移除的节点上，或者 ctrl+点 对「已选中」的节点是取消选中、对「未选中」是加选**，那么 `before - 1` 这个判据在某些时序下不成立。

另一个可能：`assert` 的判据是**严格等于 `before - 1`**，而实际可能是「一次 ctrl+点 清掉了 2 个」（如果实现是「点击空白清空全部」）或「一个都没清掉」（如果点击落在了别的元素上）。

**这两个方向都要用实测排除，不要只在代码里推理。**

## 4. 要求

1. **先复现**。用循环跑（例如 20 次），统计失败率。如果你 20 次全绿，说明本机难复现 —— 那就用 `--repeat` 方式或人为注入延迟/改变节点顺序去逼出时序窗口，并说明你怎么逼出来的。
2. **找到确定性根因**。不接受「加长 timeout」「加 retry」「加重试 3 次」这种把 flake 藏起来的做法 —— 那是把问题变成「更慢的 flake」。
3. **修法必须保留原意图**：E1 的意图是「进入 E2 前，画布上不能残留任何选中态」，这个断言不能变弱、不能删。
4. 如果根因在被测代码（`src/client/CanvasWorkspace.tsx` 或画布选择逻辑）而不在测试里，**改被测代码**，并说明改了什么、为什么真实用户也会遇到。
5. 修完要能通过负向验证：**人为破坏真实修复点后，这条断言必须 FAIL**。

## 5. 你的改动边界

优先只改 `scripts/smoke-canvas-video.mjs`。
如果确认根因在源码里，可以改 `src/client/CanvasWorkspace.tsx`（**但要先告诉我在哪个函数**，那份文件别人也在读）。

不许碰：`package.json`、`pnpm-lock.yaml`、`src/engine.ts`、`scripts/smoke.mjs`。

## 6. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

**不要跑全量 `pnpm test`**（3 分钟以上，还和别的 Bot 抢 CPU）。你只要：

```bash
cd /Users/malang/chajian/wt-e1
npx tsdown                                    # 先构建，smoke 读 lib/
node scripts/smoke-canvas-video.mjs           # 约 102 s
```

反复跑时把输出都写到 `/tmp/`，别覆盖。

## 7. 报告格式

```
## 1. 复现统计
跑 N 次，红 M 次，原文贴失败那一次的完整堆栈

## 2. 根因
是测试的判据错了，还是被测代码有竞态？（要有代码依据 + 实测依据）

## 3. 修了什么
git diff --numstat + 关键 hunk

## 4. 负向验证
破坏哪里 → 哪条断言红（原文）

## 5. 修后连续 N 次全绿
原文时间戳/序号

## 6. 我不确定的
```

## 8. 一句话

这是发版的拦路虎，修好它比修好任何新功能都值钱。但**不许用「加重试」糊过去**。

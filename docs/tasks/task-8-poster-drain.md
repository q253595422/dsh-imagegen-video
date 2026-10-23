# task-8 · 让老记录的封面回填一次跑完，而不是每次请求只补 3 条

## 背景（我已经实测确认，不是猜测）

`src/video-store.ts:29` `BACKFILL_BATCH = 3`，`src/routes.ts:2500` 在 `historyList` 处理器里
`void backfillVideoPosters().catch(...)`。设计意图写在 `src/video-store.ts:342-352` 的注释里：
「不能把首次列表请求扣住当人质，剩下的积压由下一次请求接手」。

问题在于**下一次请求不会发生**：

- `src/client/ImageGenPanel.tsx:919` `const initialDataRequestedRef = useRef(false)`
- `:1191-1193` `if (!active || initialDataRequestedRef.current) return; initialDataRequestedRef.current = true; loadInitialData()`
- `src/client/mount.tsx:250/253/321`：开关面板只是 `root.render(...)` 重渲染，`ImageGenPanel` **不卸载**，ref 不重置。
- 只有 `:1197-1199` `retryInitialData()` 会把 ref 归 false，而它只挂在「加载失败重试」按钮上（`:2632`、`:3605`），正常状态看不见。
- 另外两处重取都不成立：`:1370-1373` 只在**有 new 完成的视频任务**时才重取；`:3478` `onClipStored` 只在拼接路径触发。

后果：用户 10 条老 clip，重启后打开一次面板 → 只补最前面 3 条，剩下 7 条永远不会补，除非以后又生成了一条新视频。`VIDEO_HISTORY_MAX = 30`，最坏情形 27 条一直没封面。

## 要你做的（宿主侧，只改 `src/video-store.ts`，必要时 `src/routes.ts`）

把「每次请求补 3 条」改成「每次请求负责**把积压排空**」，但保持两条不变：

1. **响应不能被扣住**。`routes.ts:2500` 仍是 unawaited + `.catch`，`writeJson` 仍在回填开始之前写完。这条不许动。
2. **单条失败不许拖垮整批**。`posterFailures` 的语义保持：失败记住、下次跳过、成功才 `delete`。

建议做法（你可以推翻，但要给理由）：新增一个模块级 `let drain: Promise<void> | undefined`，
`backfillVideoPosters()` 保持「补一批、返回本批数量」的语义不变（现有调用方和探针都在用它的返回值），
另加一个 `drainVideoPosters(): Promise<void>` 用 `drain` 做去重：

```ts
// 伪代码，结构自定
export function drainVideoPosters(): Promise<void> {
  drain ??= (async () => {
    try {
      // 一直补到某一批返回 0（补完 / 只剩失败项）
      while (await backfillVideoPosters() > 0) { /* keep going */ }
    } finally { drain = undefined }
  })()
  return drain
}
```

`routes.ts:2500` 改成 `void drainVideoPosters().catch(() => { ... })`。

注意几个边界，都要处理：

- **`while (... > 0)` 不能死循环**：靠 `posterFailures` 保证失败项不再进 `pending`，所以补完一批后必然收敛。请你确认这一点并写进报告（如果某条 entry 有多个 video 且第一个失败、第二个成功，`filled` 仍会 +1，下一轮会再试第二个吗？看 `:371` 的 `find` 只取第一个候选——请说明最终状态是「每条 entry 至多一个封面」）。
- **数据目录被重指**：`setImageDataRoot()` 之后旧的 `drain` 不能继续对旧目录跑。加一句让 `drain` 作废（或至少在 `resetVideoStore()` 里等它结束），不要留下写旧路径的残留任务。
- **不许多 spawn**：全程串行，不许并发 ffmpeg。现有 `mutateVideos()` 队列已经串行化了，但你要确认 `drain` 不会和用户的 `appendVideoHistory` 互相饿死。
- 30 条上限 × 单条 ~130ms ≈ 4s。如果实测明显超过，报告里给数，我们再决定要不要加 `await` 间隔。

## 不许做的事

- 不许改前端任何文件（`src/client/**` 归界团，它这轮也在改这块，会撞车）。
- 不许改 `BACKFILL_BATCH` 的值来「解决」问题 —— 那只是把问题从 3 条推到 N 条。
- 不许提交 git、不许发版、不许 stash（工作区有 46 项别人的改动）。
- 验证时的真实数据目录：**不许碰** `~/.dsh/dsh-imagegen/videos/`。全部输出写 `/tmp/task8-*`，用 `DSH_HOME` 重指。

## 必须交回的东西

1. `git diff src/video-store.ts src/routes.ts` 原文。
2. 一个探针（放 `/tmp/task8-probe.mjs`），构造「10 条老记录、其中 1 条坏文件」的索引，
   然后**只调一次** `drainVideoPosters()`，打印 最终 `filled` 总数 / `with-poster` 总数 / 总耗时 / ffmpeg spawn 次数。
   我要看到 `9/10`（坏的那条补不上是预期的）以及能收敛的耗时。
3. 负向验证：把 `drain` 退回成单次 `backfillVideoPosters()`（或直接不 drain），同一个探针应该只出 3 条。
   把两次的原始输出都贴上来。
4. 四条命令的真实输出与退出码，**串行跑**（build 写 `lib/`、test 读 `lib/`，并行会假失败，上一轮界团踩过）：
   ```
   pnpm typecheck
   pnpm build
   DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs
   pnpm test
   ```
5. 一句话说明：这次改动之后，用户 10 条老 clip 的封面在**面板打开一次**之后是否全部出现。
   注意前端还有一次显示刷新由界团那边做（task-9），你只说宿主侧磁盘与 `list()` 返回的 `poster` 字段是否齐全。

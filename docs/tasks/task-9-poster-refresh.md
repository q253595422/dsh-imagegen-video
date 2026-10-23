# task-9 · 封面回填完之后，侧栏要自己再取一次列表

## 背景（宿主侧的根因我已派给金团，详见 `docs/tasks/task-8-poster-drain.md`）

前端这边有一个独立的缺口，即使宿主把封面全部补完，用户也看不到：

`src/client/ImageGenPanel.tsx:1191-1193`

```ts
useEffect(() => {
  if (!active || initialDataRequestedRef.current) return
  initialDataRequestedRef.current = true
  loadInitialData()
}, [active, loadInitialData])
```

`initialDataRequestedRef`（`:919`）在整个 `ImageGenPanel` 生命周期内只放行**一次** `loadInitialData()`。
而 `src/client/mount.tsx:250/253/321` 显示开关面板只是 `root.render(...)` 重渲染，组件不卸载、ref 不重置。
`retryInitialData()`（`:1197-1199`）能重置它，但只挂在「加载失败重试」按钮上（`:2632`、`:3605`），正常状态下看不到。

另外两处重取都覆盖不到这个场景：
- `:1370-1373`（每 5s 的 `videoTaskList` 轮询）**只在出现了新的完成任务时**才重取；
- `:3478`（`onClipStored`）只在拼接路径触发。

所以：宿主在后台补封面 → 前端拿着第一次那个 `entries` 数组不动 → 封面永远不出现。

## 要你做的（只改 `src/client/ImageGenPanel.tsx`）

首次加载回来后，如果 `videoHistory` 里存在**没有 `poster` 的视频条目**，就在后台做一次**有界**的补取，
把结果合并回去；补到了就停，补不到也要停（不许无限轮询）。

约束（这些是硬要求，不是建议）：

1. **有界**：最多补取 2 次，间隔 2s 与 5s（宿主那边的 drain 最多跑 ~4s，上面这两个时间点能覆盖到）。
   用 `window.setTimeout` 并在 effect cleanup 里 `clearTimeout`，组件卸载后不许再 `setState`。
2. **不阻塞**：不许 `await` 在渲染路径上，不许影响首屏。首次列表照旧立刻显示（没有封面的行显示胶片图标）。
3. **只在需要时补**：`videoHistory.some(e => e.videos.some(v => v.poster === undefined))` 为真才排定时器；
   全都已有封面就一次都不排。
4. **合并而不是覆盖**：宿主返回的是完整列表，直接 `setVideoHistory(next)` 可以，但要注意与
   `videoHistoryRemove` / `videoHistoryClear`（`:1985-1988`、`:2037-2048`）的竞态——如果用户在补取窗口内删了一条，
   晚到的答案不能把它变回来。**这一点必须处理**：可以在补取结果回来时按当前 state 的 id 集合过滤，
   或者用一个 `deletedIdsRef` 记录已删 id。你选一种，并在报告里说明选它的理由。
5. **失败静默**：补取失败不写 `historyLoadError`（首屏已经成功了，后台补装饰失败不该给用户报错）。
6. 不许动 `initialDataRequestedRef` 的既有语义（那是一次性首屏加载的守卫，`retryInitialData` 在依赖它）。

## 不许做的事

- 不许改 `src/video-store.ts` / `src/routes.ts`（宿主侧归金团，它正在改，会撞车）。
- 不许改 `videoRowOf()` / 渲染分支 / `panel.module.css` 的缩略图规则 —— 这些上一轮已经验收通过，不许回退。
- 不许提交 git、不许发版、不许 stash（工作区有 46 项别人的改动）。

## 必须交回的东西

1. `git diff src/client/ImageGenPanel.tsx` 原文，并标出哪些 hunk 是你这一轮的（其余是历史改动）。
2. **不靠夹具自证**。上一轮的教训写在这里：不许只贴「PASS」两个字。
   你要给一张对照表：**改动的选择器/变量 ↔ 它维护的 CSS 规则或渲染位置 ↔ TSX 行号**。
3. 一个真浏览器断言（放 `/tmp/task9-assert/`，**不要**写进 `.studio-preview/`，那里已有别人在用的文件）。
   做法：复用 `.studio-preview/thumb-assert.entry.tsx` 的骨架（它已经从 `../src/client/mount.tsx` 引真 `mountPanel`），
   但把宿主 stub 的 `videoHistoryList()` 做成「第 1 次返回无 poster，第 2 次返回有 poster」，
   然后在页面里等 5s，断言侧栏那几行的 `img.count` 从 0 变成 N。把两次测量的原文贴上来。
4. 负向验证：把补取的定时器关掉（或 `if (false)`），同一个断言必须失败。两次输出都贴。
5. 四条命令的真实输出与退出码，**串行跑**（build 写 `lib/`、test 读 `lib/`，并行会假失败）：
   ```
   pnpm typecheck
   pnpm build
   DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs
   pnpm test
   ```
6. 一句话说明：用户 10 条老 clip，重启后**打开一次面板、不做任何其他操作**，封面会不会自己出现。

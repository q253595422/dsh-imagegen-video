# task-25 A+ 长图文案排版（在拼图上叠真文字）

工作区：`/Users/malang/chajian/dsh-imagegen-video/.worktrees/aplus-text`
分支：`task/aplus-text`（基于 `task/aplus`）
`node_modules` 已用硬链接就位，`npx tsc --noEmit` 当前 EXIT=0。

## 0. 为什么做这个

现在的长图是「图 + 图」竖拼。12 个模块的文案只作为 prompt 导引传给模型（`aplus.guide.*` 那 12 句），模型不理会时用户拿到的长图上**一个字都没有**，这是目前唯一会持续产生客诉的缺口。

做法：导出长图时，在每块图的下方叠一条文案带（标题 + 正文），文字由 canvas 真画上去。**不做 DOM→canvas 截图**，不引入任何新依赖。

## 1. 硬约束

- 禁止新增任何 npm 依赖；禁止 `sharp` / `node-canvas` / `puppeteer` / `html2canvas` / `foreignObject`。
- 不新增导航 tab，**不要动 `scripts/smoke.mjs` 的三处导航计数**（现在是 11 / 8 / 11）。
- 文字层只在导出时画进 canvas；DOM 预览保持现状（图上不叠字），别改现有预览布局。
- 文案全空时，导出结果必须与改动前**逐像素一致**（老用户不受影响）。
- 必须能被 jsdom 挂载：`aplus-layout.ts` / 新增的文字模块**不许在模块顶层或 import 时碰 canvas / measureText**，现有 E1 断言就是靠 jsdom 挂载跑的。
- 中文字体用系统字体栈，不许下载字体文件：`-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`。

## 2. 数据形状

每个模块新增可选文案（存 React state 即可，不进协议、不进历史）：

```ts
interface AplusCopy { title: string; body: string }
type AplusCopyMap = Record<string, AplusCopy>   // key = 模块 key（brand / selling-point / …）
```

`title` 单行，`body` 允许多行（用户按换行分段，排版时按宽度自动折行）。

## 3. 排版规格（照这个实现，别自由发挥）

- 文案带贴在该块的**底部**，宽度 = 图片宽度，半透明白底 `rgba(255,255,255,0.92)`，上边缘一条 `1px` 的 `rgba(0,0,0,0.08)` 分隔线。
- 内边距：左右 `width * 0.06`，上 `width * 0.035`，下 `width * 0.035`。
- 标题字号 `width * 0.042`，粗体，行高 `1.3`，颜色 `#111111`。
- 正文字号 `width * 0.028`，常规，行高 `1.55`，颜色 `#333333`。
- 标题与正文之间空 `width * 0.018`。
- 折行：按 `ctx.measureText` 逐字符累加（中文按字、英文按词），超出可用宽度就换行；单个不可分割的长串（如连续英文/URL）允许按字符硬切，不许溢出画布。
- 溢出护栏：文案带总高**不得超过该块高度的 40%**。超过时先按 `0.9` 递减字号（最低到 `0.6` 倍）；仍超过则**拒绝导出并提示**（`tt` 文案：文案太长，请精简第 N 块），不允许截断、不允许把图挤没。
- 数字与英文不要被空格吃掉：折行只在字符边界发生，别 `trim()` 掉正文内部的缩进以外内容。

## 4. 代码落点

新增 **`src/client/aplus-text.ts`**（纯逻辑，可断言）：
- `wrapText(measure: (text: string) => number, text: string, maxWidth: number): string[]` —— 传入测量函数而不是 canvas，这样纯函数可测。
- `measureCopyBlock(copy: AplusCopy, width: number, measure: (text, font) => number): { height, lines: Array<{ text, font, size, bold, y }> }`
- `bandHeightFor(blockHeight: number, measuredHeight: number): { ok: boolean; scale: number }` —— 落实 40% 护栏与 `0.9` 递减。
- 导出常量 `APLUS_BAND_MAX_RATIO = 0.4`。

改 **`src/client/aplus-draw.ts`**：
- `drawAplusBlocks(canvas, layout, images, copies?: AplusCopyMap)` —— 第四个参数可选，不传时行为与现在完全一致（逐像素）。
- 新增内部 `drawCopyBand(context, block, copy)`，用 `#ffffff` 的纸白打底再叠半透明白带（canvas 的 alpha 叠加在图片上即可，不要用 CSS 变量）。

改 **`src/client/AplusWorkspace.tsx`**：每行模块的文案输入（标题 + 正文两个字段，正文用 `<textarea>`），紧凑排布，别把现有的 12 行撑爆；导出时把 `copyMap` 传进 `drawAplusBlocks`。

i18n：`src/client/locales.ts` 加 zh / en / ru 三语，键名前缀 `aplus.copy.`（标题占位、正文占位、太长提示）。

## 5. 必须自己测（数字写进报告，我要复核）

1. `npx tsc --noEmit` EXIT=0、`npx tsdown` 过、`node scripts/smoke.mjs` → `SMOKE TEST OK`（不许掉 PASS 数，当前 94）。
2. 真 Chromium 像素断言（你自己起 CDP，`/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`，注意本机 `--dump-dom` 无输出，必须走 CDP + `Runtime.evaluate`）：
   - 无文案：导出结果与改动前**逐像素一致**（同一 layout 两次渲染比 hash）。
   - 有文案：文案带区域内出现非纸白像素（证明字真画上去了），带内背景是 `rgba(255,255,255,0.92)` 与图叠加后的值。
   - 带高 ≤ 块高 40%。
   - 超长文案：`bandHeightFor` 返回 `ok:false`，UI 拒导出。
   - 中文折行：给一段 200 字中文，行数与每行宽度都不超可用宽度。
3. 负向对照：把 `drawCopyBand` 改成空实现，像素断言必须变红；把 40% 护栏改成 `0.9`，溢出断言必须变红。**负向必须破坏真实失效路径**（上次那版 `Promise.all` 假绿的教训）。

## 6. 禁区

不许 `git commit` / `push` / `stash` / `reset` / `checkout` / `add`；不许跑 `pnpm test:negative`；验证输出只写 `/tmp/`；`pnpm build` 与 `pnpm test` 必须串行。

## 7. 交付格式

报告里给：改了哪些文件、各多少行、文字模块的导出签名、你自己的断言数字（含负向）、以及**你认为哪里做得不对或该由我裁决的地方**。别报「全部完成」，有问题照实写。

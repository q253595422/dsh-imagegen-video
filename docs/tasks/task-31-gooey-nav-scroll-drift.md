# task-31 — GooeyNav：导航行滚动后选中胶囊/文字停在旧位置（看起来像两个标题）

## 背景（我已复现并定位，不需要你重新归因）

用户报障：点「A+ 详情页」后，导航条上**所有的标题都变成两个**。截图 OCR 两遍确认
导航条上真有两个「A+ 详情页」（`[1864,44 122x29]` 与 `[2061,44 122x29]`，截图 2560×1640
Retina ≈ CSS 1280 宽）。

不是多渲染了一个 tab：DOM 里只有一个 `[role="tab"]`（`tabCount 9`）。多出来的是装饰层
`span.effectText`（`.effectText`，`z-index:1`，`pointer-events:none`）。

**根因** `src/client/GooeyNav.tsx:47-48`：

```ts
left: `${pos.x - containerRect.x}px`,
top: `${pos.y - containerRect.y}px`,
```

`pos` 与 `containerRect` 都是**视口坐标**，但父容器 `.container` 是
`overflow-x: auto` 的滚动容器（`src/client/GooeyNav.module.css` 的
`.container { overflow-x: auto; }`）。滚动后 `pos.x - containerRect.x` 已经是
「内容坐标 - 已滚动量」，少加了 `container.scrollLeft`，于是胶囊和它的文字墨
（`.effect` / `.effectFilter` / `.effectText`）停在**滚动前**的位置，视觉上就是
第二个标题。

这就是为什么 1440 宽复现不到：那时 `scrollWidth 801 = clientWidth 801`，不溢出。
1280 宽时 `scrollLeft` 可以是 97，A+ 的 `li` 被裁在右边。

## 我已跑过的验证（你不用重复，但要知道判据）

自建 fixture（真 `GooeyNav.tsx` 转译产物 + 真 `GooeyNav.module.css`），把容器压到
溢出（`document.body.style.width = '520px'`，`clientWidth 520 / scrollWidth 791`，
`maxScroll 271`），滚到最右点最后一项：

- 未修：`{"scrollLeft":271,"activeX":439,"textX":168,"textDrift":-271,"pillDrift":-271}`
- 已修（只改那两行）：`{"activeX":439,"textX":439,"textDrift":0,"pillDrift":0}`
- 三态对照（选中最后一项后滚回 0 / 滚到 140）：未修恒 `-271`，已修恒 `0`。

关键是**滚动事件不触发重新定位**：`updateEffectPosition` 只在挂载、`ResizeObserver`
和 `activeIndex` 变化时调用。所以正确做法不是监听 scroll，而是把坐标换算到
**容器内容坐标系**（加上 `scrollLeft`/`scrollTop`），滚动就自然跟着走。

## 要做的

### A. 修 `src/client/GooeyNav.tsx:47-48`

改成一个表达式，并在上方留一段注释说明 `.container` 是滚动容器、为什么这里要加
滚动量（注释内容你自己写，写清「视口坐标 vs 内容坐标」这一层）。

必须是**这两个字面量**（负向对照要按字符串删）：

- 含 `left` 的那行出现 `pos.x - containerRect.x + container.scrollLeft`
- 含 `top` 的那行出现 `pos.y - containerRect.y + container.scrollTop`

不要加 scroll 监听、不要 `scrollIntoView`、不要动 `.effect` 的层级或 CSS。
`GooeyNav.module.css` **一字节别动**。

### B. 在 `scripts/verify-ui-contracts.mjs` 加真浏览器断言

新开一个 fixture，**不要**动现有 `/` 那个 gooey fixture（它测的是主题订阅）。

已验过的配方（照抄，省你踩坑）：

1. 转译真组件（`tsc` 已在 `node_modules/.bin/tsc`，TypeScript 5.7.3）：

```js
const navModuleDir = join(tmpdir(), `dsh-gooey-nav-${process.pid}`)
mkdirSync(navModuleDir, { recursive: true })
const navTsc = spawnSync(join(projectRoot, 'node_modules/.bin/tsc'), [
  join(projectRoot, 'src/client/GooeyNav.tsx'),
  '--outDir', navModuleDir,
  '--module', 'esnext', '--target', 'es2022', '--jsx', 'react-jsx',
  '--moduleResolution', 'bundler', '--skipLibCheck', '--noCheck',
], { cwd: projectRoot, encoding: 'utf8' })
```

产出 `GooeyNav.js` + `surface-theme.js`。**注意**：`GooeyNav.js` 里的 import 说明符
原样保留成 `'./surface-theme.ts'` 和 `'./GooeyNav.module.css'`，所以顺带产出也够，
只是服务端路由要按这两个 URL 提供：

- `/GooeyNav.js` → 转译产物
- `/surface-theme.ts` → 转译出来的 `surface-theme.js`（content-type `text/javascript`）
- `/GooeyNav.module.css` → `export default new Proxy({}, { get: (_, k) => String(k) })`
- `/react.js` → `node_modules/react/umd/react.development.js`
- `/react-dom.js` → `node_modules/react-dom/umd/react-dom.development.js`
- `/react.mjs` / `/jsx-runtime.mjs` / `/react-dom-client.mjs` → 三个薄 shim，
  把 UMD 全局转成 ESM：

```js
// /react.mjs
const R = window.React; export const useEffect = R.useEffect, useRef = R.useRef, useState = R.useState, useMemo = R.useMemo, useCallback = R.useCallback, createElement = R.createElement; export default R;
// /jsx-runtime.mjs
const R = window.React; export const jsx = (t, p) => { const { children, ...rest } = p || {}; return children === undefined ? R.createElement(t, rest) : R.createElement(t, rest, children) }; export const jsxs = jsx; export const Fragment = R.Fragment;
// /react-dom-client.mjs
export const createRoot = window.ReactDOM.createRoot; export default { createRoot };
```

2. 页面 `?navscroll=1`：`importmap` 把 `react` / `react/jsx-runtime` /
   `react-dom/client` 指到上面三个 shim，然后

```js
import { createRoot } from 'react-dom/client'
import { GooeyNav } from '/GooeyNav.js'
const items = ['普通生图','素材库','无限画布','电商模式预览','图片转 PPT','爆款复刻','服饰穿戴','带货图文','A+ 详情页'].map((l, i) => ({ key: String(i), label: l }))
```

用 `createRoot` 挂一个受控组件（`activeIndex` 存页内状态，`onSelect` 重渲染），
挂完把 `window.__navReady = true`。样式表直接内联真 `gooeyCss`（脚本里已有
`read('GooeyNav.module.css')`），并给 `body` 设
`--dsw-alias-brand-primary` / `--dsw-static-red-400` / `--dsw-static-neutral-00` /
`--dsw-static-blue-400` 这几个 `.container` 会读的 token（缺了会走 `var()` fallback，
不影响几何，但别让它在无关地方报错）。

3. 照 `:1150-1240` 的 `sourcetabs=1` 那套连 CDP（`json/new` + `WebSocket` +
   `Runtime.evaluate` + `Input.dispatchMouseEvent`）。

4. 断言（三态，对应我验过的）：

```js
// 让行溢出
await evaluate(`(document.body.style.width = '520px', 1)`)
// 先读一次，证明这个 fixture 真的有溢出，否则它什么也没证明
// { clientWidth, scrollWidth, maxScroll }
```

- `maxScroll <= 0` → 直接判 harness 坏掉（写成失败，不许当通过）。
- 滚到最右（`container.scrollLeft = container.scrollWidth`），用
  `Input.dispatchMouseEvent` 在最后一项中心点 `mousePressed` + `mouseReleased`
  选中它，等 ≥600ms（胶囊动画 300ms + 粒子）。
- 测量函数读：`container.scrollLeft`、`li.active` 的 `left`、
  `.effectText` 的 `left`、`.effectFilter` 的 `left`，算 `textDrift = textX - activeX`
  与 `pillDrift`。
- 三态各测一次：`after-select-last` / `after-scroll-back-to-0` /
  `after-scroll-140`，每态断言 `Math.abs(textDrift) <= 1 && Math.abs(pillDrift) <= 1`。

失败文案必须含 **`drifts off the active tab`**（负向对照要按这句匹配），
并打印实际 `drift` 与 `scrollLeft`，别只打印「mismatch」。

### C. 在 `scripts/verify-negative.mjs` 的 `CASES` 里加一条

`runner: 'contracts'`，文件 `src/client/GooeyNav.tsx`：

```js
from: 'pos.x - containerRect.x + container.scrollLeft',
to: 'pos.x - containerRect.x',
expect: /drifts off the active tab/,
```

注释写清：这是用户看到的那一秒（点 A+ 后两个「A+ 详情页」）的直接成因。

## 验收（你自己跑，输出到 /tmp/）

1. `npx tsc --noEmit` → 必须 0。
2. `node scripts/verify-native-ui.mjs` → 必须 `PASS native-UI contract: no violations.`
3. `node scripts/verify-ui-contracts.mjs` → 必须 `UI CONTRACTS VERIFIED`，且新断言那行
   有实际 `drift` 数字（贴出来）。
4. **负向对照（必做）**：手工把 `GooeyNav.tsx` 那行改回不含 `scrollLeft` 的样子，
   跑第 3 条 → 必须红在 `drifts off the active tab`，贴红字原文，然后改回来。
   （这一步只用来给你自己确认；`verify-negative.mjs` 那条 case 也要加，但
   `node scripts/verify-negative.mjs contracts` 由我跑全量，你可以只挑这一条名字过滤跑一次。）
5. 报告里给 `git diff --numstat`（只列你动的文件）。

## 禁区

- **不许** `git commit / push / stash / reset / checkout / add`。
- **不许**跑 `pnpm test` / `pnpm test:negative`——那是我的活。
- **不许**跑 `pnpm build`（我要串行跑全量，你别占锁）。
- 不许动 `src/client/GooeyNav.module.css`（一字节都别动）、不许动现有 `/` 那个
  gooey 主题 fixture、不许动 `surface-theme.ts`。
- 不许加 scroll 监听、不许 `scrollIntoView`、不许把 `.effect` 挪进 `li`。
- 验证产物只写 `/tmp/`；`tsc --outDir` 必须指向 `/tmp` 下的目录，别落在仓库里。
- 只改上面点名的位置，不做顺手重构。

## 交回

写 `/tmp/report-task31.md`，然后用 `message_bot` 回报我：改了哪几行、四/五条验收的实际
输出（含三态 `drift` 数字）、负向对照的红字原文、`git diff --numstat`。

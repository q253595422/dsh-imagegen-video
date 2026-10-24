# task-30 — 服饰穿戴结果区空态文案 + 把 promo 的按值断言并回 smoke

## 背景

task-29 交回后我审计出两个遗留问题（真宿主 + 源码双向核过）：

### 1. 服饰穿戴结果区空态说「生成结果 1」

`src/client/OutfitWorkspace.tsx:178-180`：

```tsx
<div className={css.empty}>
  <span>{tt('outfit.resultAlt', { count: 1 })}</span>
</div>
```

`outfit.resultAlt` 是**成品图的 alt 文案**（`生成结果 {count}` / `Generated result {count}` /
`Результат {count}`，`src/client/locales.ts:338 / 1872 / 3395`），它被拿来当空态用了。
一张图都没生成时界面显示「生成结果 1」，读起来像已经出过一张。真宿主实测确认可见。

对照：带货图文同一位置用的是专门的空态 key `promo.emptyResults`
（`生成结果会出现在这里` / `Results appear here` / `Результаты появятся здесь`，
`locales.ts:352 / 1886 / 3409`，用在 `src/client/PromoWorkspace.tsx:115-117`）。

### 2. promo 的平台断言退成了「数个数」

我核过：`scripts/smoke.mjs:7756` 现在是

```js
assert.equal(promoWorkspace.querySelectorAll('[role="radio"]').length, 4, 'promo workspace offers four platform styles')
```

而你在 `/tmp/task29/smoke-patch.txt` 里写的那版是**按值**校验的：

```js
const promoPills = [...promoWorkspace.querySelectorAll('[data-promo-platform]')]
assert.deepEqual(promoPills.map(pill => pill.getAttribute('data-promo-platform')), ['xiaohongshu', 'douyin', 'taobao', 'dewu'], 'promo workspace offers the four platform styles as pills')
assert.equal(promoWorkspace.querySelectorAll('select option').length, 0, 'the platform picker is no longer a hidden select')
```

按值那版更强：`promoImagePrompt` 就是 switch 在这四个字符串上的，数个数过不了「三个对、
一个写成 `xiaohongshu2`」这种错。**这是你写的，现在并回树里。**

## 要做的

### A. 空态文案

1. `src/client/locales.ts` 三语各新增一个 key（沿用 promo 的措辞，让两个面板读起来一致）：
   - zh `'outfit.emptyResults': '生成结果会出现在这里'`
   - en `'outfit.emptyResults': 'Results appear here'`
   - ru `'outfit.emptyResults': 'Результаты появятся здесь'`
2. `src/client/OutfitWorkspace.tsx:179` 空态改用它：
   ```tsx
   <span>{tt('outfit.emptyResults')}</span>
   ```
   `outfit.resultAlt` 保留，只给 `<img alt>` 用（`:175`），不要动那处。
3. 不要给空态添别的装饰（图标/按钮）；promo 那边是纯文字，这边保持一致。

### B. promo 断言并回

把 `scripts/smoke.mjs` 里那条 `[role="radio"]` 计数断言**整条替换**为你 patch 里的两条
（`deepEqual` 按值 + `select option` 为 0），注释也照你的原文保留——那段注释解释了为什么
不能退回数 `<option>`，是给后来人看的。

替换后 **`view.querySelectorAll('[role="tablist"] button').length === 9`** 那条不要动。

### C. 顺手补一条空态断言（防回归）

在 `scripts/smoke.mjs` 的 outfit 块（`scripts/smoke.mjs:7736-7744`，就在
`outfit keeps the nine top-nav entries` 那条之后）加一条：拉完服饰穿戴面板后，
断言它的结果区空态**不是**「生成结果 1」那种读法。用正向断言钉住新文案：

```js
assert.ok(outfitWorkspace.textContent?.includes('生成结果会出现在这里'), 'the outfit results area describes an empty state, not a result')
```

再加一条负向钉死（防止有人把 `resultAlt` 又塞回来）：

```js
assert.equal(outfitWorkspace.textContent?.includes('生成结果 1'), false, 'the empty outfit results area must not read like a finished result')
```

两条都要在**渲染出 outfit 面板之后**取 `outfitWorkspace.textContent`（那时 `results` 为空，
空态就是页面上唯一的那段文字）。

## 验收（你自己跑，输出到 /tmp/）

1. `npx tsc --noEmit` → 必须 0。
2. `node scripts/verify-native-ui.mjs` → 必须 `PASS  native-UI contract: no violations.`
3. `node scripts/smoke.mjs` → 必须 `SMOKE TEST OK`、`0 FAIL`。
4. **负向对照（必做，两条都要）**：
   - 把 `OutfitWorkspace.tsx:179` 临时改回 `tt('outfit.resultAlt', { count: 1 })` → smoke 必须
     红在那条新加的断言上，把红的原文贴给我，然后改回来。
   - 把 `PromoWorkspace.tsx:98` 里 `PLATFORMS` 某一项的值临时改成 `'xiaohongshu2'` → smoke 必须
     红在 `deepEqual` 那条上，贴红的原文，然后改回来。
5. 报告里给 `git diff --numstat`（只列你动的文件）。

## 禁区

- **不许** `git commit / push / stash / reset / checkout / add`。
- **不许**跑 `pnpm test` 或 `pnpm test:negative`——那是我的活。
- **不许**跑 `pnpm build`（我要串行跑全量，你别占锁）。
- 不许改 `PromoWorkspace.tsx` / `OutfitWorkspace.tsx` 的布局与样式（task-29 的成果，
  `outfit-workspace.module.css` 一字节别动），本任务只改文案 key、那一行 JSX、和 smoke 断言。
- 不许改 `panel.module.css` / `ImageGenPanel.tsx`。
- 验证产物只写 `/tmp/`。
- 只改上面点名的位置，不做顺手重构。

## 交回

写 `/tmp/report-task30.md`，然后用 `message_bot` 回报我：改了哪几行、四条验收的实际输出、
两条负向对照的红字原文、`git diff --numstat`。

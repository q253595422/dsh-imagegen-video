# task-7：视频历史封面 —— 前端渲染（img 缩略图）

派给：**界团**。你只改 `src/client/` 下的文件。宿主侧（抽帧 + 存储）由金团在 task-6 里做，**不要改 `src/` 下的服务端代码**。

## 背景（已确认的事实，不要再推翻）

用户报「视频历史记录没有封面」。前端这一侧的原因很明确：

`src/client/ImageGenPanel.tsx:2655-2670`，视频行的缩略图分支是硬编码的胶片 SVG：

```tsx
{isVideoRow
  ? <span className={css.historyThumbPlaceholder} data-video-thumb="" title={tt('history.video')} aria-label={tt('history.video')}>
      <svg viewBox="0 0 16 16" ...>...</svg>
    </span>
  : row.thumbUrl !== undefined
    ? <img className={css.historyThumb} src={row.thumbUrl} alt="" loading="lazy" decoding="async" />
    : <span className={css.historyThumbPlaceholder} />}
```

`videoRowOf()`（同文件 `:585-597`）的注释写着：

> A clip has no poster frame of its own, so the row renders a film icon rather than paying for a video element in the list.

金团那边已经在让 clip **有**封面帧了，所以这段注释和这个分支都要改。

**绝对不要用 `<video>` 元素做缩略图。** 30 条历史各挂一个 `<video preload="metadata">` 的解码代价不可接受，这也是原来那位作者不做的原因。只用 `<img>`。

## 金团提供的接口契约（按这个写，不要自己发明字段名）

`VideoHistoryEntry.videos[n].poster?: string` —— **本来就是现成字段**，`src/protocol.ts` 里有，`src/client/CanvasVideoPicker.tsx:305` 已经在用（`<video poster={clip.poster}>`）。

金团改的是这个字段的**来源**：以前只有上游给才有值，现在宿主抽帧后也会有值。**前端不需要知道区别，`poster` 有值就是一张可直接当 `<img src>` 用的同源 URL。**

所以前端要做的只有一件事：**有 `poster` 就渲染 `<img>`，没有就保持现有的胶片图标。**

## 具体改动

### 1. `src/client/ImageGenPanel.tsx`

**`videoRowOf()`（`:585` 附近）**：把 `poster` 提到 `thumbUrl`，并把那条过时注释改掉。

```ts
function videoRowOf(entry: VideoHistoryEntry): UnifiedHistoryRow {
  const poster = entry.videos[0]?.poster
  return {
    key: `video:${entry.id}`,
    kind: 'video',
    createdAt: entry.createdAt,
    prompt: entry.prompt,
    models: [entry.model],
    // The host extracts a poster frame when a clip is saved, so most rows now
    // have a still to show. A clip saved before that existed has none, and
    // falls back to the film glyph below.
    ...poster === undefined ? {} : { thumbUrl: poster },
    meta: `${entry.aspectRatio} · ${entry.resolution} · ${entry.seconds}s`,
    entry,
  }
}
```

**渲染分支（`:2661` 附近）**：视频行里先看 `thumbUrl`，有就 `<img>`，没有才保留现有的胶片 span。`data-video-thumb=""` 这个属性**只留在胶片兜底那一支上**，别加到 img 上（CSS 靠它给视频行一个品牌色图标，加错了会把图片也染色）。

```tsx
{row.thumbUrl !== undefined
  ? <img className={css.historyThumb} src={row.thumbUrl} alt="" loading="lazy" decoding="async" />
  : isVideoRow
    ? <span className={css.historyThumbPlaceholder} data-video-thumb="" title={tt('history.video')} aria-label={tt('history.video')}>
        <svg ...同现状... />
      </span>
    : <span className={css.historyThumbPlaceholder} />}
```

注意 `row.thumbUrl !== undefined` 现在同时覆盖图片行和视频行，所以判断顺序要按上面这样写：**先 thumbUrl，再 isVideoRow，最后空占位**。请对照你改完的实际代码确认三条分支都还在。

### 2. `src/client/panel.module.css`

- `.historyThumb`（`:1320`）现在只服务图片行，尺寸 52×52、`border-radius: var(--dsw-radius-sm)`、`object-fit: cover`。视频行复用同一个类，**尺寸和圆角必须一致**（历史列表里两者视觉上要对齐）。检查 `object-fit: cover` 对 16:9 的横版视频是否合适——不合适的话给视频行加个 `data-kind="video"` 的修饰，但**不要**因此让两者形状不一致（还是 52×52 的方形裁切，和图片行一样）。
- 如果确实需要区分，用已有的 `[data-kind]` 属性（`historyItem` 上已有 `data-kind={row.kind}`），不要新造属性名。
- 现有的 `.historyThumbPlaceholder[data-video-thumb]`（`:4007`）和 `.historyItem[data-video-row] .historyThumbPlaceholder[data-video-thumb]`（`:4016`）两条规则**保留**——它们服务的是「还没有封面」的兜底。但第二条给视频行图标上品牌色的规则，注释要改成「还没有封面时的兜底」。
- **圆角只用 `var(--dsw-radius-*)` token，字号只用合法阶梯**。仓库有守卫：`DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs`，必须 `PASS`。

### 3. i18n

`tt('history.video')` 已存在，不用加。如果你需要新文案（比如 img 的 `alt`），**先确认 `src/locale-tables.ts` 里有没有现成的**，没有就保持 `alt=""`（装饰性图片，`alt` 空是正确做法，不要为了「看起来完整」加一堆新 key）。

## 硬性约束

- **不要提交、不要发版、不要动 `package.json` 的 version、不要碰 `PLUGIN_VERSION`。** 工作区已有 38 项未提交改动，都是别人的活，不许 stash / reset / checkout。
- 不要动 `src/` 下除 `src/client/` 之外的文件（金团的地盘）。
- 不要动 `tools/ui-verify/`。
- 最小改动。这个任务是「让已有的 poster 字段显示出来」，不是重做历史列表。

## 一个容易踩的坑（上一轮你踩过）

上一轮你把组件改成写 `data-dark`、而 CSS 还在选 `[data-theme='light'|'dark']`，导致导航胶囊整块变透明，而 `verify-ui-contracts.mjs` 的夹具自己复制了那行所以断言照过。

**这轮同理**：如果你在 TSX 里加了新的 `data-*` 属性或改了类名，必须确认 `panel.module.css` 里真有对应规则，而且**在真实渲染路径上生效**，不要只让夹具通过。你在报告里要明确写出：你加的每一个选择器 / 属性，分别对应哪个 CSS 规则、哪个 TSX 位置。

## 验收（你必须自己跑，把真实输出贴给我）

```bash
cd /Users/malang/chajian/dsh-imagegen-video
pnpm typecheck
pnpm build
DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs
pnpm test
```

四条都要 EXIT=0。

**还要做一次真实渲染验证**。数据是真的：`~/.dsh/dsh-imagegen/videos/index.json` 里有 10 条 clip。但因为金团那边还没落地，它们目前**没有** `poster`。

所以你要做的是：用 `node scripts/studio-preview-shot.mjs` 那条已有管线，或者自己在本机起一个最小 Chrome 页面（Chrome 在 `/tmp/chromium/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell`，工具库在 `scripts/lib/headless-chrome.mjs`），**构造两条假 row：一条有 poster、一条没有**，断言：

- 有 poster 的那条，DOM 里出现 `<img>`，`src` 等于你给的 URL，且**没有** `data-video-thumb`
- 没有 poster 的那条，DOM 里出现胶片 span，**有** `data-video-thumb`，且 `img` 数量为 0
- 两者的缩略图盒尺寸都是 52×52（`getBoundingClientRect`）

把断言脚本和输出贴给我。**不要让夹具自己伪造 DOM 再断言自己**——要真的渲染 `videoRowOf` + 那段 JSX。

## 报告格式

1. 你改了哪些文件、每个文件多少行增删（`git diff --numstat` 原文）
2. 四条验收的真实输出（贴命令 + 退出码，不要写「通过」两个字）
3. 渲染断言的脚本路径 + 真实输出
4. 「我加的每个选择器 / 属性 ↔ 对应的 CSS 规则 ↔ TSX 位置」对照表
5. 有没有你没做完或做不了的部分（如实说，不要粉饰）

做完停下来等我验收，不要继续做别的事。

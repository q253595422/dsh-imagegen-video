# task-6：视频历史封面 —— 宿主侧（抽帧 + 存储 + 惰性回填）

派给：**金团**。你负责 `src/` 下的宿主代码。前端渲染由界团在 task-7 里做，**不要碰 `src/client/`**。

## 背景（已确认的事实，不要再推翻）

用户报「视频历史记录没有封面」。原因两处：

1. `src/client/ImageGenPanel.tsx:2655` 视频行硬编码只渲染一个胶片 SVG 图标，从不读 `poster`。
2. 宿主保存 clip 时从不生成封面。`poster` 只在「上游偶尔返回 `last_frame_url`」时才有值（`src/video-engine.ts:649-651`），而且那是**上游 URL**，不是本地文件。

本任务只做第 2 点：**宿主侧用 ffmpeg 抽一帧，存成 JPEG，和历史条目一起保存**。

**不要用 `<video>` 元素做缩略图**（界团那边也一样），30 条历史各挂一个 video 元素的解码代价不可接受。

## 已实测的环境事实

- ffmpeg 在 `/Users/malang/.local/bin/ffmpeg`，ffprobe 同目录。**本机没有 `timeout` 命令**。
- 工具发现已有现成实现：`src/clip-compose.ts:62` 的 `localVideoToolDirs()`（已从 `src/index.ts:366` 导出），`:145` 的 `findTool('ffmpeg' | 'ffprobe')` 是**私有函数**，`:147` 起是它的实现。
- 现有历史数据在 `~/.dsh/dsh-imagegen/videos/`：`index.json` + `files/<id>-<n>.mp4`。当前有 10 个 clip。

## 必须实现的接口契约（界团按这个写前端，你可以细化实现但不要改这些语义）

`src/protocol.ts` 的 `VideoHistoryFile`：

```ts
/** Poster/thumbnail URL, when the provider supplies one. */   // 已有
poster?: string
```

**保持 `poster` 的现有语义不变**（`https://` 开头就是上游 URL，原样透传）。新增一个存储侧字段：

```ts
// user-clip-poster-design
interface StoredVideoFile {
  // ... 现有字段
  /** Locally extracted poster file name (e.g. `<id>-<n>-poster.jpg`). */
  posterFile?: string
}
```

`toWire()` 里合成：

```ts
poster: video.poster ?? (video.posterFile === undefined ? undefined : fileUrl(video.posterFile))
```

即：**上游有海报就用上游的；没有才用本地抽帧**。这样对上游给了 poster 的渠道行为不变。

在 `VideoHistoryFile` 上加一句注释说明 `poster` 可能是上游 URL 也可能是本地抽帧的 served URL，两者对前端是同一种东西。

## 具体改动

### 1. 新文件 `src/video-poster.ts`

导出一个函数：

```ts
export async function extractPoster(opts: {
  input: string          // 源 clip 的绝对路径
  output: string         // 目标 jpg 的绝对路径
  signal?: AbortSignal
}): Promise<boolean>     // true = 已写出；false = 放弃（工具缺失 / 抽帧失败）
```

要求：

- **永不抛异常**。抽帧是锦上添花，失败必须静默返回 `false`，绝不能让它挡住 clip 入库。
- 抽帧时间点取**时长的 10%**（首帧常是黑场或转场）。先用 ffprobe 拿时长（`-v error -show_entries format=duration -of csv=p=0`）；拿不到就退化到 `0`。
- 输出：JPEG，宽 320px，`-vf scale=320:-2`，`-q:v 4`。用 `-frames:v 1`。
- 必须加**超时**（建议 20s），超时就 kill 子进程并返回 `false`。参考 `src/clip-compose.ts:145` 附近 `findTool` 和 `runProcess`（`:95` 起）的写法——`runProcess` 也是私有的，**你可以把工具发现/进程执行抽成 `src/video-tools.ts` 供两处共用，也可以复制一份**，二选一，说明你的选择。抽成共用模块更干净，但要保证 `clip-compose.ts` 的现有行为一字不变（它的 `localVideoToolDirs` 是 `src/index.ts` 的公开导出，别改签名）。
- 写文件用 `fs.writeFile`，`output` 必须由调用方给的是 `videos/files/` 下的路径。

### 2. `src/video-store.ts`

- `extensionOf` / `mimeOfFile` 加 `.jpg` → `image/jpeg`。`readVideoFile`（`:268`）的正则要能放行 poster 文件名，**但仍然要挡住 `..` 和绝对路径**。建议把 poster 命名成 `<id>-<n>-poster.jpg`，正则加一条独立分支，不要放宽原有那条。
- `appendVideoHistory` 的 `files` 入参加可选 `posterBytes?: Buffer`。有 `posterBytes` 就写 `<prefix>-<index>-poster.jpg` 并记 `posterFile`；没有就不写。
- `removeEntryFiles`（`:143` 附近）要**一并删掉** poster 文件。
- 新增导出 `listVideoHistory` 的惰性回填：见下。

### 3. 惰性回填（让用户现有的 10 个 clip 也有封面）

新增导出：

```ts
/** Fill in posters for entries saved before posters existed. Idempotent. */
export async function backfillVideoPosters(): Promise<number>  // 返回本次补了几条
```

- 遍历 index，凡是 `posterFile` 和 `poster` 都没有的条目，对它的第 0 个 clip 抽帧、写 `index.json`。
- **在 `mutateVideos` 里做**，否则和并发的 append 抢索引。
- 单次调用最多处理 3 条（避免首次调用卡住列表请求）。
- 任何一条失败都跳过、继续下一条，不中断。
- 在 `src/routes.ts` 的 `VIDEO_API.historyList` 处理器里**不要 await** 它——用 `void backfillVideoPosters()` 后台跑，列表照常立即返回。加注释说明为什么不等。

### 4. 抽帧的调用点（三处，都要接上）

- `src/generation-runtime.ts:236` 和 `:344`
- `src/code-render-runtime.ts:222`（`:212` 起是 entry 构造）
- `src/clip-compose.ts:548`

做法建议：**不要**在每处各自调 `extractPoster`。给 `video-store.ts` 的 `appendVideoHistory` 加一个「先落盘、再抽帧」的内部步骤最省事：clip 字节写完后，如果该文件是视频且 `poster` 未提供，就地抽帧。这样四个调用点一行都不用改。

**这条我倾向让你这么实现**（store 内部抽帧），因为抽帧是存储的附属行为，不是生成的行为。但 store 目前是「framework-free（node:fs only）」，引入子进程会破坏这个注释承诺 —— 如果你的判断是让调用方抽帧更干净，那就按调用方的做法改，并且把 store 顶部那段注释同步改掉。**说明你的选择与理由。**

## 硬性约束

- **不要提交、不要发版、不要动 `package.json` 的 version、不要碰 `PLUGIN_VERSION`。** 工作区已有 38 项未提交改动，都是别人的活，不许 stash / reset / checkout。
- 不要动 `src/client/`（界团的地盘）、不要动 `tools/ui-verify/`。
- 不要改 `.gitignore`、不要动 `docs/native-ui-contract.md`。
- 最小改动。抽帧失败路径必须静默降级，用户看不到封面不能变成用户看不到视频。

## 验收（你必须自己跑，把真实输出贴给我）

```bash
cd /Users/malang/chajian/dsh-imagegen-video
pnpm typecheck
pnpm build
DSH_ASAR_DIR=/tmp/dshnative/dsh/node_modules node scripts/verify-native-ui.mjs
pnpm test
```

四条都要 EXIT=0。

另外**必须做一次真实验证**：拿 `~/.dsh/dsh-imagegen/videos/files/` 里任意一个真实 mp4，调你自己写的 `extractPoster`，确认产出的 jpg 能被读回来、尺寸是 320 宽、字节数 > 2KB。把命令和输出贴给我。

**注意**：`~/.dsh/dsh-imagegen/videos/` 是用户的真实数据。验证时**把输出写到 `/tmp/` 下**，不要污染用户目录、不要删用户的 clip。

## 报告格式

1. 你改了哪些文件、每个文件多少行增删（`git diff --numstat` 原文）
2. 四条验收的真实输出（贴命令 + 退出码，不要写「通过」两个字）
3. 抽帧实测的命令与输出
4. 「store 内部抽帧 vs 调用方抽帧」你选了哪个、为什么
5. 有没有你没做完或做不了的部分（如实说，不要粉饰）

做完停下来等我验收，不要继续做别的事。

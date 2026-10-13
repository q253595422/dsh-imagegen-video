# 契约：画布「拼接视频」（compose.videos）

> 本文件是并行开发的**冻结接口**。任何一方改动其中的签名、字段名、路由、data-* 锚点之前，
> 必须先通知队长改本文件；实现里不得出现与本文不一致的自创命名。

## 0. 一句话

用户在画布上多选若干**视频节点** → 触发「拼接视频」→ **宿主**用本机 ffmpeg 把它们按
**画布位置顺序（从上到下、从左到右）** 归一化后拼成一条 MP4 → 产物作为**新视频节点**
落回画布，同时写进**视频历史**（因此侧栏可见、可收藏进素材库）。

## 0.1 文件归属（并行开发的硬边界，不得越界）

| 文件 | 归属 | 说明 |
|---|---|---|
| `src/clip-order.ts` | 队长（**已完成**） | 顺序规则，双方共用，只读 |
| `src/protocol.ts` | 队长（**已完成**） | 类型与常量，只读 |
| `src/client/locales.ts` | 队长（**已完成**） | zh/en/ru 20 个 key，只读 |
| `src/index.ts` | 队长 | composer 注入（2 行） |
| `src/routes.ts` | 队长 | 本期**可能不需要改**（复用 skill run 路由） |
| `package.json` | 队长 | 把新套件加进 `test` |
| `docs/compose-contract.md` | 队长 | 本文件 |
| `src/clip-compose.ts` | **compose-engine** | 新增：ffmpeg 定位/探测/拼接/落库 |
| `src/skill-runner.ts` | **compose-engine** | 新增 `runCompose` + `'local'` 分派 |
| `src/skills-catalog.ts` | **compose-engine** | 新增 `compose.videos` 条目 |
| `scripts/smoke-compose.mjs` | **compose-engine** | 新增宿主侧套件（可跑真 ffmpeg，离线） |
| `src/client/CanvasWorkspace.tsx` | **canvas-ui** | 菜单/徽标/确认卡/产物 |
| `src/client/canvas-workspace.module.css` | **canvas-ui** | 徽标与确认卡样式 |
| `scripts/smoke-canvas-video.mjs` | **canvas-ui** | 追加画布侧断言 |
| 其它任何文件 | 动之前先问队长 | — |

## 1. 已实测钉死的事实（不要重新推断）

| 事实 | 值 | 证据 |
|---|---|---|
| ffmpeg/ffprobe | 6.0，`~/.local/bin/{ffmpeg,ffprobe}` | `ffmpeg -version` |
| 运行中 DSH 的 PATH | `/usr/bin:/bin:/usr/sbin:/sbin` | `ps eww` |
| ⇒ 裸命令名 | **必然 ENOENT**，必须绝对路径候选 | `env -i PATH=…` 下 spawn 实测 |
| 画布帧率 | 30 fps | 见第 5 节配方 |
| macOS | **没有** GNU `timeout` | `timeout: command not found` |

**视频节点是引用而非复制**：`CanvasVideoRef.url` 指向 video store 路由，字节不在画布资产库里。
合成产物同样如此 —— 落进 **video store**，不落画布资产库。

## 2. 共享文件（队长所有，成员只读）

### `src/clip-order.ts`（新增，已完成）
```ts
export interface PositionedItem { id: string; x: number; y: number; width: number; height: number }
export function orderByPosition<T extends PositionedItem>(items: readonly T[]): T[]
export function orderIdsByPosition(items: readonly PositionedItem[]): string[]
```
规则：按垂直中心排成「行」，同一行内按 `x` 升序，`id` 兜平局。
**浏览器画序号徽标与宿主建 concat 列表必须调用同一个函数**——两处若各自实现，
用户看到的顺序与实际产物可能不一致，且无法察觉。

### `src/protocol.ts`（已完成）
```ts
export type VideoMode = 'text' | 'image' | 'keyframe' | 'reference' | 'compose'
export type CanvasSkillTier = 'light' | 'heavy' | 'local'      // tier 已加第三档
export type CanvasSkillDescriptor['output'] = 'text' | 'image' | 'file' | 'video' | 'nodes'

export interface ClipComposeResult { bytes: Uint8Array; mime: string; duration?: number; width?: number; height?: number }

export interface ClipComposer {
  available: () => boolean                  // false = 找不到 ffmpeg+ffprobe
  describe: () => string                    // 定位结果，用于报错与 stage 文案
  resolve: (url: string) => Promise<string | undefined>   // 服务 URL → 本地文件绝对路径
  stitch: (input: {
    sources: readonly string[]              // 本地路径，已按最终播放顺序排好
    signal?: AbortSignal
    onStage?: (stage: 'probe' | 'encode') => void
  }) => Promise<ClipComposeResult>
  publish: (input: {                       // 落库，返回可直接播放的 served ref
    id: string; bytes: Uint8Array; mime: string; duration?: number; prompt: string
  }) => Promise<{ url: string; mime: string; duration?: number }>
}
```


**`'compose'` 不是 provider mode**：`src/routes.ts:407` 的 mode 白名单会把未知值静默降级成
`'text'`，且它会出现在生视频面板的模式页签里。**永远不要把它送到 `/video/generate`**。
它的唯一用途是标注视频历史条目里「这条是宿主拼的」。

**`tier: 'local'` 不是 light/heavy**：不消费模型、不需要 agent。所有 `tier === 'heavy' ? … : …`
的三元必须显式处理第三档（见第 6 节），否则 local 会静默走进 runLight。

### `src/client/locales.ts`（已完成，zh/en/ru 各 20 个 key）
`canvas.skills.tierLocal`、`canvas.skills.compose{,Desc,Cost,TooFew,NoFfmpeg,StageProbe,StageEncode,Order,Done,Failed,Node}`、
`canvas.compose{Badge,Bar,Ask,AskHint,Confirm}`、`video.mode.compose`。
宿主侧不需要单独字典：`src/locale-tables.ts` 复用 `src/client/locales.ts`。

## 3. 路由（队长所有：`src/protocol.ts` + `src/routes.ts`）

不改 `VIDEO_API` 的既有语义（协议注释明写「deliberately no append endpoint」）。
拼接是**一个 skill run**，因此走既有 `CANVAS_SKILL_API.run`，**不新增路由**。

- `POST ${CANVAS_SKILL_API.run}` body 形如 `{ canvasId, skillId: 'compose.videos', nodeIds: [...], language? }`
  ⇒ 返回 `{ ok: true, task: CanvasSkillTask }`，客户端照既有 1500ms 轮询 `CANVAS_SKILL_API.task`。
- **`nodeIds` 按画布位置顺序传入**（客户端用 `orderIdsByPosition` 排好），
  但宿主持有最终权威：宿主**再排一次**，不信任客户端顺序。理由：文档、撤销、多端都可能让顺序漂移。

## 4. 宿主的输入构造（成员实现）

现有 `SkillRunner.run()` 只读 `node.metadata.asset`（不读 `metadata.video`）⇒ 视频节点拿不到输入。
**不修改既有输入逻辑**（会波及 polish/describe/extract/ppt 四条路径），新增独立分支：

```
run(request):
  if (request.skillId === BUILTIN_COMPOSE) return this.runCompose(request)   // 提前返回
  …既有逻辑不变
```

`runCompose` 自建输入：读文档 → 取 `request.nodeIds` → 只保留 `type === 'video'` 且
`metadata.video.url !== ''` 的节点 → 用 `orderByPosition` 排序 → 少于 2 段抛
`t('canvas.skills.composeTooFew')`。

**素材来自 URL 而非字节**：视频节点的 bytes 不在画布资产库里，所以要让 ffmpeg 拿到本地文件，
有两条路，实现必须选**下面这条**：

- 宿主内用 `imageFileFrom(url, VIDEO_API.file)` + `readVideoFile(file)` 拿到 `{path, size, mime}`，
  **直接把该绝对路径交给 ffmpeg**（video store 的片段本来就在磁盘上，无需复制）。

若某来源解析不到本地文件（例如 `sourceUrl` 指向已被淘汰的历史条目），
抛 `t('canvas.skills.composeFailed', { message })` 并说明是哪一段，不要静默跳过——
静默跳过会让用户以为拼了 5 段、实际 3 段。

## 5. ffmpeg 配方（**已实测，不要自行发明**）

目标：1280x720、30fps、yuv420p、H.264 + AAC、`+faststart`。

```
ffmpeg -y -hide_banner -loglevel error \
  -i <src0> -i <src1> … \
  -filter_complex "<每路归一化>;<每路音频>;[v0][a0][v1][a1]…concat=n=N:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset veryfast -crf 20 -c:a aac -movflags +faststart <out>
```

每路视频：
```
[i:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[vI]
```
每路音频，**必须先探测该输入有没有音轨**：
- 有音轨 → `[i:a]aformat=sample_rates=48000:channel_layouts=stereo[aI]`
- 无音轨 → `anullsrc=r=48000:cl=stereo:d=<该输入的秒数>[aI]`

### 三个会致命的坑（都实测过）
1. **禁止 `-c copy` + concat demuxer**。尺寸/帧率不同的输入会得到 exit 0 的**静默损坏**文件
   （ffprobe 看着正常、全解码报 `non monotonically increasing dts`、帧被塞进错误分辨率）。
2. **引用不存在的音轨会让整条 filtergraph 失败**（`Stream specifier ':a' … matches no streams`）。
   必须逐输入探测：`ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 <f>`，
   输出为空即无音轨。
3. **`anullsrc` 不带 `d=` 是无限源**，concat 永不推进 ⇒ 内存暴涨 `exit 137`。
   必须 `d=<该输入实际时长>`，时长取自
   `ffprobe -v error -show_entries format=duration -of csv=p=0 <f>`。

### 进程管理
照抄 `src/skill-store.ts:376` 的 `run()` 范式：`stdio: ['ignore','pipe','pipe']`、
输出上限、`setTimeout` 超时后 `kill()`、`error`/`close` 双路 settle 且带 `settled` 标志。
**不要用 shell**（无 `shell: true`），参数以数组传递。必须支持 `AbortSignal`（任务可取消）。

### 进程输出上限
stderr 可能很长（尤其坏输入），必须截断（照 `skill-store.ts` 的 8000 字符上限），
并把截断后的文本放进错误信息供用户诊断。

## 6. tier 的全部消费点（`'local'` 必须逐处处理）

| 位置 | 现状 | 改成 |
|---|---|---|
| `src/skill-runner.ts` `enqueue()` 分派 | `tier === 'heavy' ? runHeavy : runLight` | 三分支，`'local'` → `runLocal` |
| `src/skill-runner.ts` `run()` 前置校验 | `tier === 'heavy' && !agentAvailable` → 报错 | 保持（local 不受影响，**不要**误加 local 检查） |
| `src/client/CanvasWorkspace.tsx` 图标 | `tier === 'heavy' ? 'sparkle' : 'skill'` | local 用 `'sparkle'` 或既有图标名（**不要发明新图标名**） |
| 同上 tier 徽标 | `tier === 'heavy' ? tierHeavy : tierLight` | 加 `tierLocal` |
| 同上 `RUN_STEPS_*` | HEAVY / LIGHT 两套 | local 复用 LIGHT 步骤 + 拼接专属 stage 文案 |
| 同上 `pickSkill` 确认弹窗 | `tier === 'heavy'` 才弹 | **local 也弹**（用户要看到拼接顺序） |

## 7. 客户端（成员实现，`src/client/CanvasWorkspace.tsx` + `canvas-workspace.module.css`）

### 入口
skill 菜单（`openSkillMenu`）里出现 `compose.videos`，`accepts: ['video']`。
多选 ≥2 个视频节点时可用；单选视频节点时该行 `disabled`（沿用 `canvas.skills.incompatible`）。

### 顺序徽标（**用户明确要求**）
选中集合里有 ≥2 个视频节点时，每个视频节点左上角显示 `data-compose-badge="<1-based>"`，
文字 `t('canvas.composeBadge', { index })`。序号来自 **`orderIdsByPosition`**（与宿主同源）。
选中不足 2 个或未进入拼接上下文时不渲染。徽标**不拦截指针事件**（`pointer-events: none`）。

### 确认
点击拼接后弹确认卡：`t('canvas.composeAsk', { count })` + `t('canvas.composeAskHint', { list })`，
`list` 是序号顺序的简短标签（如 `①②③`），确认按钮 `t('canvas.composeConfirm')`。
**必须与徽标顺序一致**——这是用户唯一能校验顺序的机会。

### 运行卡与产物
沿用既有 skill run 卡（`applySkillOutput` 已泛化，产出任意类型节点都能合入，无需改）。
产物节点：`type: 'video'`、`metadata.video = { url, mime, duration }`、
`metadata.status = 'success'`、`metadata.skill = { id: 'compose.videos', … }`，
**不设** `metadata.asset`（引用而非复制）。
`title` 用 `t('canvas.skills.composeNode')`。

### data-* 锚点（测试依赖，不可改名）
- `data-compose-badge`：顺序徽标，值 = 序号字符串
- `data-compose-bar`：多选时 dock/选区旁显示的「按画布位置拼接 · N 段」条
- `data-compose-card`：确认卡容器
- `data-compose-run`：确认按钮
- 产物节点沿用既有 `data-video-body`（因为它是普通视频节点）

## 8. 宿主产物落地（队长所有：`src/index.ts` + 成员实现 `src/clip-compose.ts`）

产物**必须进视频库**（用户决策），不走画布资产库：

```
const stitched = await stitcher.stitch({ sources, signal, onStage })
const entryId = newId('compose')
await appendVideoHistory({
  id: entryId, createdAt: Date.now(), mode: 'compose',
  model: 'ffmpeg', prompt: <各输入 prompt 拼接的说明>,
  aspectRatio: '16:9', resolution: '1280x720', seconds: <实测>,
  files: [{ bytes: Buffer.from(stitched.bytes), mime: stitched.mime, duration: <实测秒> }],
})
```

之后节点 URL 指向 `${VIDEO_API.file}/<file>`，与既有 clip 完全一致 ⇒ 侧栏可见、
可收藏进素材库、可用 Range seek，**无需任何新的服务路由**。

### 已知代价（已向用户明示，不要偷偷扩大）
`VIDEO_HISTORY_MAX = 30`，合成产物进视频库后会占用槽位并可能**淘汰旧的生成记录**。
不要为此改 `VIDEO_HISTORY_MAX`（会改变既有行为）。

### ffmpeg 定位
候选绝对路径，按序探测，命中即用：`~/.local/bin/{ffmpeg,ffprobe}`、
`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`。全部落空 →
`available() === false` → 抛 `t('canvas.skills.composeNoFfmpeg', { detail })`。
**同时需要 ffprobe**（探测音轨与时长）；只有 ffmpeg 不算可用。

`ClipComposer` 通过 `SkillRunnerOptions` 注入（`composer?: ClipComposer`），
这样 smoke 套件能注入假实现，**测试不需要真 ffmpeg**，也不需要网络。
一次注入覆盖四件事：找 ffmpeg、把 served URL 反解成本地文件、跑管线、落库。
**runner 不直接 import `src/video-store.ts`**（会让 smoke 无法打桩，也把宿主存储耦合进 runner）。

## 9. 验证要求

- `pnpm test` 必须全绿（`scripts/with-lock.sh pnpm test`，共享工作树必须串行）。
- 新增断言必须**反向验证**：故意改坏 → 对应断言失败 → 按 hash 逐字节还原。
- 能离线跑真实 ffmpeg 的地方就用 `testsrc`/`sine` 合成素材（零付费、零网络）——
  参考 `/tmp/compose-probe` 里已证明的配方。
- 不得调用任何付费上游。

## 10. 明确不做（本期）

- 不做片段排序 UI（顺序 = 画布位置，已定）。
- 不做转场/滤镜/配乐/字幕。
- 不改 `VIDEO_API` 的既有语义、不加新的视频路由。
- 不改 `VIDEO_HISTORY_MAX`。
- 不扩 `VideoMode` 到 `'compose'` 以外的值。

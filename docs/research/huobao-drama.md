# 火宝短剧（chatfire-AI/huobao-drama）能力对比调研

调研日期：2026-11-17。口径：`master` @ `76bf150`（2026-11-16），release `v4.0.11`（2026-11-05）。代码规模：`backend/src` 8 994 行、`frontend/app` 13 074 行、18 张表、19 个 Agent 工具、39 个测试文件（其中 26 个实际下载核对，13 个因 GitHub API 限流未下）。

> **这份文件解决什么**：判断火宝短剧这条「小说 → 剧本 → 资产 → 分镜 → 成片」的流水线，有哪些东西值得移植进本插件的画布与分镜，哪些不值得。结论是**三段文案规范**（分镜段落 / 视频提示词 / 角色三视图）、**两处工程约定**（结果先落库再下载、种子内容的内容寻址升级）、**一处我们的接线缺陷**（分镜不吃身份参考），其余不跟。
> **它在整体里是哪一环**：竞品调研，只给结论、优先级与落点，不改源码；真要动手时按 `docs/tasks/` 一件一件来。
> **三个不显然的取舍**：① 它是 **CC BY-NC-SA 4.0**，不是开源许可证——本文只做**读思路、重写实现**，任何原文复制都会让本仓库的 Apache-2.0 失效（见「许可证与商业关系」）；② 结论来自**源码**而不是 README，因为两者至少有三处不一致（见「README 与代码对不上的三处」），照 README 评估会高估它；③ 它是**商业产品的开源壳**（设置页自带 Firemux 网关一键配置、桌面版更新指向 `installer.firemux.site`），评估能力时要区分「产品功能」与「导流设施」。

## 结论先说

1. **它真正稀缺的东西不是代码，是提示词工程**。三个 `SKILL.md` 里有若干条**可量化的硬规则**：「段落时长 ≥ 台词字数 ÷ 4.5 字/秒 + 2 秒表演余量」、「每个 `【镜头N】` 映射为 1–2 个连续的 3 秒段」、「节拍边界强制切段」。这些与实现语言无关，可以整段重写成我们自己的规范。
2. **它的产品形态（剧集工作台）不值得搬**。`episode.vue` 单文件 6 239 行，是一条线性向导（剧本 → 资产 → 分镜 → 视频 → 导出）配一层 SQLite 关系表。本插件的画布是并行的非线性结构，硬搬会把画布降级成表单。要补的是**规范**与**资产语义**，不是界面。
3. **工程上它比我们弱的地方不少**：拼接用 concat demuxer 直拼、不做逐输入探测；已下载核对的 26 个测试里 **19 个**只做「`readFileSync` 读源码跑正则」，**6 个**真实 import 源码跑行为；`assets` 表、`subtitle_url` 字段、单镜头合成这三样**只有壳没有实现**（`assets` 唯一的出现是遗留 MySQL 导入的候选表名，没有任何读写代码）。
4. **它比我们强的地方很集中**：跨镜头的**身份一致性链条**（角色三视图 → 参考图序号 → 提示词里的 `@图片N名字` → 适配器里的 `@图片N` → `图N`）是端到端闭合的；本插件的 `cast`（身份锚定）只接进了 composer，**没接进分镜执行**（见「我们的洞」）。
5. **优先级**：先补分镜 / 视频提示词规范（纯文案，零架构改动），再修「分镜不吃身份参考」这个洞，最后才考虑剧本层与配音层。

## 平台基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | `chatfire-AI/huobao-drama`，17.6k star / 3.3k fork |
| 许可证 | **CC BY-NC-SA 4.0**（非商用 + 相同方式共享） |
| 技术栈 | Nuxt 3 + Vue 3（纯 CSS，无 UI 框架）/ Hono + Drizzle + better-sqlite3 / Mastra / Electron |
| 端口 | 后端 5679，前端 3013（代理 `/api`、`/static`） |
| 部署 | 服务器（Docker）+ Electron 桌面版；桌面版里后端由 `utilityProcess.fork` 启动 |
| 商业模式 | 免费版 + FireLumi 商业版（`firelumi.com`）；设置页内置 Firemux 网关一键配置 |
| 模型接入 | OpenAI 兼容 / Gemini / 火山 Seedance 2.0 / MiniMax H3 / 阿里 Wan 3.0 |
| 内容语言 | 界面中 / 英 / 日 / 韩；AI 产出语言另有一套 `app_settings.content_language`，提示词按 `<agent>.<lang>.md` 分文件 |

## 架构

```
backend/   Hono 路由 + Drizzle(18 表) + Mastra(4 agent)
  workspace/    Agent 的 jail 根：prompts/<agent>.md、skills/<name>/SKILL.md（设置页可在线编辑）
  services/     统一任务生命周期 generation.ts；适配器 adapters/*；拼接 ffmpeg-merge.ts
frontend/  Nuxt 3 SPA，views/drama/episode.vue 是全部工作台
desktop/   Electron 主进程：单实例锁 → 空闲端口 → userData 准备 → fork 后端 → 轮询 health → BrowserWindow
data/      huobao.sqlite3 + static/（图片、视频、成片、海报帧）
```

18 张表：`dramas / episodes / characters / scenes / props / storyboards` 六个主体，`episode_characters|scenes|props`、`storyboard_characters|props` 五个多对多，`ai_service_configs / ai_service_providers` 渠道，`style_presets` 风格，`sys_task` 任务，`video_merges` 成片，`assets` 素材库，`app_settings` 全局设置。

两个字段值得单独看：

- `storyboards.duration` 是**段落时长**（8–15 秒），不是镜头时长；一个段落内部按 `description` 里的 `【镜头1】…` 写 2–4 个子镜头。
- `storyboards.first_frame_image / last_frame_image / composed_image` 预留了三种回写位（`generation.ts:492-497` 按 `frameType` 分流），但**前端没有任何入口传 `frame_type`**——这是「分镜出图」留下的半成品。

## 流水线五步

1. **剧本改写** `script_rewriter`：小说 → 格式化剧本（`## S1 | 内景·地点 | 时间`），每场景 30–60 秒。
2. **资产提取** `extractor`：角色 / 场景 / 道具，**带去重**（角色按名字归一化；场景按「地点 + 时段」）。道具规则写得最细：三问法（删掉后剧情是否成立 / 是否只是随手日常物 / 是否只是场景陈设），「一集通常 0–3 个，宁可少提」。
3. **分镜拆解** `storyboard_breaker`：剧本 → 分镜段落；一次 `save_storyboards` 最多 8 条，**第一批必须 `replace_existing: true`**，后续追加；按 `shot_number` upsert，重试不产生重复。
4. **提示词** `prompt_generator`：角色三视图 / 场景固定视角（明确要求**剔除所有人影**）/ 道具白底单品；以及每个段落的 `video_prompt`。
5. **生成与拼接**：资产图 → 分镜视频 → `mergeEpisodeVideos`（concat 列表 + 重编码 h264/aac）→ 成片写回 `episodes.video_url`。

## 三个 SKILL 里的硬规则（最值得抄的部分）

### 分镜段落 = 一个视频任务，内含 2–4 个子镜头

`storyboard-breaker/SKILL.md:12`：

- 每段 **8–15 秒**，内部 **2–4 个子镜头**，子镜头之间**可以切镜**（换景别 / 角度 / 对象），用硬切衔接；
- 子镜头**不跨场景**——`scene_id` 绑定在段落上，这是「一个视频任务只有一个场景」的结构前提；
- 每个子镜头 2–6 秒，聚焦一个画面单元（一个动作、一个反应、一个特写）。

### 两条时长硬约束

`storyboard-breaker/SKILL.md:20` 与 `:34-36`：

- **节拍边界强制切段**：先识别叙事节拍（【开场】【触发】【高潮】【收尾】，或地点转移、规则揭示、情绪爆发、反转），**不把一条「铺垫-发生-反应」的因果链切散到两个段落**。
- **台词时长下限**：`段落时长 ≥ 段内台词与旁白总字数 ÷ 4.5 字/秒 + 2 秒表演余量`，装不下的台词拆到下一段。这是全文最有价值的一条——它把「AI 写出来的台词，视频模型根本念不完」这个最高频的废片原因，变成了一条可计算的准入条件。
- **总量锚定**：目标总时长 = 剧本字数 ÷ 500 字/分钟；段落数 ≈ 总时长 ÷ 12 秒，允许 ±20%。

### 视频提示词按 3 秒切段

`prompt-generator/video-prompt/SKILL.md`：

- 第一行是**信息头**：`出场人物：@小明、@小红；场景：@咖啡厅。`，之后才是时间分段。
- 按 **3 秒为一段**，每段一行，时间连续、无重叠、无空缺；**段数 = 段落时长 ÷ 3 向上取整**。
- `description` 的每个 `【镜头N】` 映射为 **1–2 个**连续 3 秒段：顺序一致、不遗漏、不合并、不新增。
- **每段至少一个 `@` 引用锚定画面**；角色出场的段必须 `@` 该角色；只能引用本段落已绑定的场景 / 角色 / 道具。
- 情绪必须转成可见动作（「他低下头、手指攥紧杯沿、呼吸变重」），禁止写「他很伤心」。
- 禁止跨场景、禁止闪回、禁止文学化比喻。

### 角色三视图是「形象锚点」，不是作品

`prompt-generator/character-prompt/SKILL.md`：左侧正脸特写 + 右侧正面 / 90° 侧面 / 背面三张等高全身视图；**中性 A 字站姿、纯白背景、柔和均匀棚拍光**；明确写出「特写与三张全身视图的脸、发型和服装完全一致」；禁止动态姿势、手持道具、与他物同框、文字水印。核心原则一句话：**一致性 > 美观**。

## 引用系统：`@名字` 与 `#名字` 怎么落到线上

这是它整条链路最扎实的一段，分四层：

| 层 | 做法 | 位置 |
| --- | --- | --- |
| 规范层 | 提示词里只允许 `@角色名` `@场景名` `@道具名`，名字必须与列表**完全一致** | `video-prompt/SKILL.md:51-55` |
| 前端替换 | 按「场景 → 角色 → 道具」重建参考图数组，生成 `name → 序号` 映射，把 `@小明` 改写成 `@图片1小明`；上限 9 张（Wan 3.0 为 10） | `episode.vue:3280-3308` |
| 适配层 | Aliyun 再把 `@图片N` 转成官方 `图N`；Seedance 走 `content[]` 带 `role: reference_image`，上限 9 图 / 3 视频 / 3 音频 | `adapters/aliyun-wan-video.ts:100`、`volcengine-video.ts:24` |
| 语音层 | `#小明` 单独表示**音色**引用；`resolveVoiceMentions` 换成「小明（音色参考音频1）」并把音频 URL 追加进 `reference_audio_urls`；未绑定角色 / 无音色 / 同名歧义直接抛错 | `character-voice-references.ts:8-38` |

两个细节：**`@` 是形象、`#` 是声音**，两者在同一句台词里并列（`@林小雨抬头，#林小雨轻声说：「早上好。」`）；编号只由**接口层**生成，模型输出里永远保留原始标签——避免模型把序号写进可编辑内容，重排参考图就全部失效。

本插件的对应物是 `src/client/cast.ts` 的 `cast`，但它是**全局锚定**（钉住的图不经连线也进参考池），语义不同。两者可以并存：`cast` 管「这部片子谁是这个人」，`@名字` 管「这一镜里提到谁」。

## 任务恢复：结果先落库，再下载

`docs/video-delivery-implementation.md` 与 `generation.ts` 的落地方式：

1. 上游返回成功后**先写 `result_url` 与真实 `duration`，状态仍为 `processing`、`stage=downloading`**（`generation.ts:508-515`），再开始下载。下载失败时任务记为 `failed`，但**地址保留**，用户可以「恢复下载」而不必重新计费。
2. 恢复只查已有任务、只下载已有文件；`if (!record.resultUrl && !record.taskId) throw '未保存上游任务编号…勿重复生成'`。
3. 恢复**只认原配置**：`config_id` + `config_base_url` 都写进任务行，配置被删 / 停用 / 地址变更时直接报「请恢复原配置」，不会悄悄换一家厂商去查（`generation.ts:535-548`）。
4. 下载用 `.part` 临时文件，校验 MP4 / WebM 容器头后原子 `rename`；单文件上限 512 MiB，3 次重试，只对网络错误与 408 / 429 / 5xx 退避。
5. 完成状态与分镜回写在**同一个 SQLite 事务**里；事务内再查「同一分镜是否有更新的视频任务」，有则只保留历史、不覆盖主视频（`generation.ts:519-531`）。
6. 同一分镜已有失败任务时，新生成必须**显式传 `force_new: true`**，否则报「请先恢复原任务；重新生成需确认可能再次计费」。

## 种子内容的内容寻址升级

`sqlite-schema.ts:307-403` 的 `style_presets` 有 8 条风格（3D 漫剧 / 日漫赛璐璐 / 吉卜力 / 水彩 / 美式漫画 / 国风 2.5D / 韩系网漫 / 黑白漫画），每条是一整段结构化英文正向词 + 一串 avoid 负向词。

更值得看的是它的**迁移策略**：

- `INSERT … WHERE NOT EXISTS`：只补缺失行；
- `UPDATE … WHERE value = ? AND prompt = <旧种子原文>`：**只有用户没改过的那一份才会被升级**；
- `DELETE … WHERE value = ? AND prompt = <下架原文>`：同理，用户改过的行视为用户数据保留。

这套「内容寻址」比版本号迁移稳：用户改过的行永远不动，改文案也不用写迁移脚本。本插件的 `src/presets.ts` 目前是纯代码常量（渠道预设），模板库是 JSON 快照 + 运行时覆盖，两者都没有这层保护。

## 与我们逐项对比

| 维度 | 火宝短剧 | 本插件 | 判断 |
| --- | --- | --- | --- |
| 结构 | 剧集工作台，线性向导 | 无限画布，节点式并行 | 形态不同，不互搬 |
| 分镜粒度 | **段落 8–15s 内含 2–4 子镜头** | 单镜头 4 / 5 / 6 / 8 / 10s（`storyboard.ts:21`），最多 40 镜 | **它更完整**：我们的镜头上限定死 10s，表达不了「一段 12 秒带两次切镜」 |
| 分镜来源 | 剧本经 Agent 自动拆 | 手工逐条写 | 我们的分镜是「手工排列」而非「从文本拆」 |
| 时长约束 | 台词字数 ÷ 4.5 + 2s，节拍切段 | 无 | **它最强的一项**，本仓库零 |
| 视频提示词 | 3 秒分段 + 信息头 + `@` 锚定 | 自由文本，由 `video-director.ts` 规划成 ≤6 镜、≤900 字 | 规划能力我们更强（参数会 clamp 到模型能力），**结构化写作规范我们没有** |
| 身份一致性 | 三视图 + `@图片N` + 适配器 `图N`，端到端闭合 | `cast.ts` 三类（角色 / 物品 / 风格）+ 提示词自动补「参考图 N 是 X」，**但只接进 composer**（`CanvasWorkspace.tsx:3059`、`:3207`） | **我们的洞**：`submitShot` 只处理 `carry` 的首帧，不带任何 `cast`（`:3507-3545`） |
| 分镜执行模式 | 参考图模式（Seedance 多参考）+ 音色参考 | `text` / `keyframe`（`carry` 用上一镜尾帧） | 它把「一镜多角色」当常态，我们当特例 |
| 视频队列 | 前端逐条 `forEach` 提交，后端用 `videoSubmissions` Set 防重复点击 | 宿主队列，**并发 1**，带持久化、恢复、重试（`video-task-queue.ts:98`） | **我们更强** |
| 恢复 | 先存 URL 再下载、配置溯源、`force_new` 防重复计费、`resumeInterruptedTasks` | 已提交任务按 `remoteTaskId` 重挂（`pending-tasks.json`），持久化失败时回退 `sourceUrl` | 两边各有细节；它那条「下载失败保留地址」值得抄——我们有 `sourceUrl`，但只在**整个持久化失败**时用（`generation-runtime.ts:275-290`） |
| 拼接 | concat demuxer + 统一重编码，**不探测输入** | 逐输入 ffprobe（音轨、时长），统一 1280×720 / 30fps，`xfade` 转场 + `atrim` 裁剪，30 分钟超时 | **我们明显更强**，`docs/compose-contract.md` 记了 `-c copy` 静默损坏的实测 |
| 时间线 | 无 | `TimelinePanel` + `timeline.ts`，cut / fade / dissolve，0.2–3s | **我们独有** |
| 音频 | 角色音色上传 → 参考音频（Seedance / MiniMax 内联；Wan 需公网 URL） | `generate_audio: false` 硬编码（`video-engine.ts:1362`），无音色、无 TTS | 若要「有台词的短剧」，这是**最大的能力缺口** |
| 字幕 | 只有一列 `subtitle_url`，无写入、无 burn-in | 明确不做（`docs/compose-contract.md:586`） | 双方都没有，别被 README 骗 |
| 风格 | 8 条结构化种子（正向 + avoid），内容寻址升级 | `presets.ts` 只有渠道预设，无视觉风格词库 | **可直接对标**，但风格词要改写成我们模板库的条目 |
| 技能 / 提示词可编辑 | `workspace/prompts/*.md` + `skills/*/SKILL.md`，设置页在线改，**热生效**，支持按语言分文件、frontmatter 可覆盖模型 | 内置技能提示词写在代码里（`skills-catalog.ts`），外部技能从宿主注册表读 | **它的可编辑性更强**；我们只有「运行外部技能」一条路 |
| Agent 工具 | 19 个（读剧本 / 资产 / 分镜 + 写回；写入是 upsert + 分批） | 16 个（画布增删改连 + 图像/视频生成与查询），**不能写 `storyboard.shots`** | 它允许 Agent 直接改分镜结构，我们只能改节点标题 / 提示词 |
| 测试 | 已下载核对的 26 个里 **19 个只做「读源码跑正则」**（如 `assert.match(route, /app\.post\('\/'/)`），**6 个**真实 import 源码跑行为（`video-recovery`、`character-voice` 等） | 37 个 smoke + 22 个 verify，含真浏览器走查与**反向注入**（负向测试必须变红） | **我们的测试体系严格得多**，别被它的测试文件数量误导 |
| 可观测性 | `sys_task.stage/error_code` + `GET /tasks/:id/diagnostics`（脱敏 URL / 密钥） | `signal-store.ts` + `DiagnosticsPanel` + 失败码 | 大致对等 |

## 我们的洞（看完它之后确认的具体缺陷）

1. **分镜不吃身份参考**。`submitShot`（`CanvasWorkspace.tsx:3507`）只做了 `carry` 的尾帧 → 首帧；`castRefsFor` / `castPromptOf` 只在图像 composer（`:3059`）与视频 composer（`:3207`）被调用。也就是说：用户把「阿禾」钉为角色参考后，在画布 composer 里生成是对的，**在分镜节点里连跑十条，十条都没有阿禾的图**。这不是设计取舍，是接线遗漏——修法是在 `submitShot` 里复用同一对函数，并在参考池非空时把 `mode` 从 `text` 提升为 `reference`。
2. **镜头时长表达不了 8–15 秒段落**。`SHOT_SECONDS = [4, 5, 6, 8, 10]`（`src/client/storyboard.ts:21`）。即使只想要「12 秒、两个子镜头」，当前 UI 也做不到；而模型侧 `clampVideoSeconds` 其实允许 1–30 秒（`video-model-catalog.ts:412-417`），是面板收窄了。
3. **没有从文本到分镜拆解的入口**。`video-director.ts` 只把「一句话」拆成 ≤6 个镜头用于**单条视频**，不产出分镜节点；`agent-canvas-tools.ts` 不能写 `storyboard.shots`。所以「把一段剧本变成 12 个分镜段落」在当前插件里没有路径。
4. **`generate_audio` 恒为 false**。Seedance 2.x 默认生成音轨，我们显式关掉（`video-engine.ts:1362`）。对纯视觉生成是对的（省 token、避免幻觉人声），但一旦要做「有对白的短剧」，这条就是阻断项。

## README 与代码对不上的三处

评估时最容易踩的坑，单独列出：

| README 声称 | 代码事实 |
| --- | --- |
| 「FFmpeg 单镜头合成与字幕处理」 | 全仓无 `.srt/.ass/drawtext/subtitles` 任何一处；`subtitle_url` 一列从未被写入 |
| 「FFmpeg 单镜头合成」 | 只有整集拼接 `mergeEpisodeVideos`；`composed_video_url` 只在读取端兼容历史数据，无写入 |
| 「素材库统一管理」 | `assets` 表定义完整，但只有遗留 MySQL 导入把它当候选表名（`db/mysql-import.ts:35`），**没有任何读写代码，也没有路由** |

也就是说：它的成品能力 = 资产图 + 分镜视频 + 整集拼接，字幕与调色属于宣传口径。

## 许可证与商业关系

- **CC BY-NC-SA 4.0**：禁止商业使用；衍生作品必须同样以 CC BY-NC-SA 4.0 发布；**与 Apache-2.0 不兼容**。本插件有赞助位与商业分发路径，因此**不能包含它的任何代码片段**，包括 `SKILL.md` 原文。
- 可安全借鉴的是**思路与可量化规则**：段落结构、台词时长公式、3 秒分段、三视图构图、引用标签语义。这些属于方法，重写后归我们。
- 它是商业产品的外壳：设置页 `huobaoSiteUrl = https://api.firemux.${cn|com}` 一键写入自家网关；桌面版更新检查指向 `installer.firemux.site`；仓库里另有一个测试专门断言**注册表不得出现 chatfire / openrouter**（`official-provider-adapters.test.mjs`）——说明「去导流」是他们自己也在守的边界。不要把它的网关预设当成行业最佳实践。

## 建议顺序

1. **分镜规范重写（P0，纯文案）**：把「段落 8–15s / 2–4 子镜头 / 节拍切段 / 台词 4.5 字·秒 + 2s / 3 秒分段 / 每段一个 `@` 锚定」改写成我们自己的分镜与视频提示词规范。落点：画布 storyboard 的帮助文案 + `video-director.ts` 的系统提示词 + 一条可单测的**台词时长校验函数**（纯函数，进 `smoke-storyboard.mjs`）。不动数据结构。
2. **修 `submitShot` 的 cast 接线（P0，小改动）**：分镜执行时接上 `castRefsFor` / `castPromptOf`，参考池非空时 `mode` 升为 `reference`，参考图上限沿用 composer 的 4 张。这是「分镜跑出来不像同一个人」的直接修法。
3. **放开镜头时长上限（P1）**：`SHOT_SECONDS` 增补 12 / 15，并按 `describeVideoModel(model).durations` 收窄可选项——面板显示模型真能接受的值，而不是固定五档。
4. **分镜段落与子镜头（P1，结构性）**：给 `CanvasShot` 加可选 `subshots` / `segmentId`，或在 `storyboard` 节点上加「段落」概念。**先做 1，观察是否真的需要结构**——如果只靠提示词规范 + 时长校验就能产出可用的 12 秒段落，就不要动协议。
5. **风格种子（P2）**：把 8 条风格改写成我们模板库的条目，并引入「内容寻址升级」（用户改过的条目永不被覆盖）。落点 `src/presets.ts` 或模板快照的启动合并逻辑。
6. **不做**：剧集 / 剧集向导、Firemux 网关预设、`force_new` 式的收费确认话术（我们的队列已有明确的失败态与重试，不需要再拦一层）、配音与字幕（除非确定要做「带对白的短剧」，那是另一个项目）。

## 落地（2026-11-17）

上面 1–3 已做完，4 按「先做 1、观察是否需要结构」的建议**暂不动协议**：

| # | 状态 | 落点 |
| --- | --- | --- |
| 1 分镜规范 | 完成 | `storyboard.ts` 的 `shotSpeechFit` / `shotSecondsOptions` / `shotsWithoutCast`；`storyboard-board.tsx` 的规范说明行与台词超时提醒；`video-director.ts` 中英各加第 8、9 条（段落 8–15 秒 / 2–4 子镜头 / 台词 4.5 字秒 + 2 秒余量） |
| 2 cast 接线 | 完成 | `submitShot` 接上 `castRefsFor` / `castPromptOf`，`shotVideoPlan` 决定 `cut` / `carry` 首镜带最多 4 张参考；`carry` 第 2 镜起丢参考这件事现在有界面警示，见下 |
| 3 时长上限 | 完成 | `SHOT_SECONDS` 补 12 / 15，并按 `catalog.durations` 收窄；老文档里的旧值保留为选项，不静默改写 |
| 4 段落结构 | 未做 | 提示词规范 + 时长校验已经能表达 12 秒段落，先不引入 `subshots` / `segmentId` |
| 5 风格种子 | 未做 | — |

两处与本文原判断不同的地方：

- **`@名字` 引用不能照搬**。本插件没有 `@` 语法，身份参考由程序自动补「参考图 N 是…」，所以规范文案里写的是「钉住的身份参考会自动带上」，而不是原方案里的「每段至少一个 `@` 引用」——后者会教用户一个不存在的功能。
- **`carry` 丢参考不是漏接线，是契约互斥**。修第 2 项时实测发现 `video-engine.ts:1207` 记录 Seedance / MiniMax 禁止 `first_frame` / `last_frame` 与 `reference_image` 混用。所以「接上一镜尾帧」从第 2 镜起带不上钉住的脸是**正确的取舍**（接缝优先），不能靠接线修掉。做法是把它显式化：板上说明会丢哪些镜头，行上挂「不带身份参考」角标，并提示改成「每镜独立」即可每镜都带。

顺带修掉一个与本调研无关但同链路的既有缺陷：「镜头衔接」下拉在 380px 卡片里只有 65px，而 `接上一镜尾帧` 需要 94px（英 186、俄 203），选项文字被截断——恰好与新增的 cast 警告说不到一处去。根因是三格 `flex: 1` 的 basis 为 0，改成按内容起算 + 允许换行，真浏览器量过 380 / 420 / 560px × 三语。

实拍（`scripts/studio-preview.tsx` 的临时副本，一个钉住的 cast 节点 + 一块 3 镜 `carry` 板）：

![中文：接上一镜尾帧，第 2、3 镜带「不带身份参考」角标](../images/research/storyboard-carry-cast-zh.png)

![俄文：设置条换到两行，底部按钮仍在卡片内](../images/research/storyboard-carry-cast-ru.png)

## 复现方式

```bash
# 只拉源码与技能定义，不进 node_modules / data
git clone --depth 1 --filter=blob:none --sparse https://github.com/chatfire-AI/huobao-drama.git
cd huobao-drama && git sparse-checkout set backend/src backend/workspace frontend/app desktop/src

# 三份规范（本文的核心依据）
sed -n '1,80p' backend/workspace/skills/storyboard-breaker/SKILL.md
cat            backend/workspace/skills/prompt-generator/video-prompt/SKILL.md
cat            backend/workspace/skills/prompt-generator/character-prompt/SKILL.md

# 任务生命周期与恢复
grep -n 'stage\|resultUrl\|recoverVideoTask\|forceNew' backend/src/services/generation.ts

# 引用系统四层
grep -n '@图片\|refImageLimit\|resolveVideoPromptRefs' frontend/app/views/drama/episode.vue
grep -n 'voiceToken\|resolveVoiceMentions' backend/src/services/character-voice-references.ts

# 种子内容寻址升级
sed -n '307,410p' backend/src/db/sqlite-schema.ts

# 确认「声称但无实现」的三处（三条都应为空）
grep -rn 'srt\|\.ass\|drawtext\|subtitles' backend/src frontend/app
grep -rn 'schema\.assets' backend/src
grep -rn 'composedVideoUrl:' backend/src
```

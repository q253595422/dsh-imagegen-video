# Changelog

Releases are listed newest first. Commit-level detail is in `git log`.
Attribution for third-party code is in [NOTICE](./NOTICE).

## Releases

### 未发布

- **侧栏切换器重新独占一行（DSH 0.2.2-rc.3 回归）**：rc.3 给「新会话」按钮套了一层 `div.newSessionRow`（`display:flex; gap:6px`，同时是新的 `sidebar.session.action` 槽位出口），并把行缩进从按钮搬到了这层。插件仍按「插到按钮前面」落位，于是切换器进了那个 flex 行——会话 / 生图 / 新会话 三个按钮挤在同一行。现在落位对象改为「承载该动作的 root 级块」，缩进也对这一层量（rc.3 里按钮自身的 `margin` 是 `0`，量按钮会两边各宽 4px）。块里含品牌行时退回旧行为，不把切换器抬到 logo 上方。
- **测试**：`smoke.mjs` 新增 D3c，按 rc.3 的真实结构（`root > newSessionRow > button`）挂载并断言切换器是 `newSessionRow` 的前一个兄弟、`parentElement` 是列而非动作行。原有 D3/D3b 的 fixture 都是旧结构（按钮直接挂在列上），看不见这个回归。反向验证过：把落点改回「按钮本身」，D3 与 D3c 各自变红。
- **本版不发**：等本地真机确认后再合并进下一个版本号。

### 1.30.3 — 接通 Nbility 的 MiniMax-H3（768P + 参考图上传）

- **`minimax` 协议族**：`MiniMax-H3` 此前被归进通用的 `openai-video` 族，只提供 480P/720P/1080P 三档；而上游只认 **768P**，720P / 1080P 一律 400（`MiniMax-H3 supports only 768P at normalizeRequest`）——每个请求都注定失败。补上 768P 档位后，图生视频仍然失败：参考图必须是公网 HTTPS URL，而插件只会发 data URI。官方契约的 `POST /v1/media/uploads` 正是把本地图换成公网 URL 的那条腿。
- **两条提交形状**：文生视频发扁平 `{model, prompt, resolution: '768P', duration, ratio}`；有参考图时先 multipart 上传，再发 `content[]` + 每项 `role`（`image` → `first_frame`，`keyframe` → `first_frame` + `last_frame`，`reference` → `reference_image`，上限 9 张）。
- **上传有自己的失败域**：新增诊断阶段 `video-upload` 与失败码 `video-upload-failed` / `video-unreachable`。上传的 413 与提交的 401 是完全不同的问题，混在一个 phase 里没法排查。「上传 + 建任务」共用同一个 `SUBMIT_TIMEOUT_MS` 预算，避免卡住的上传让整体耗时翻倍。
- **档位白名单收成一处**：四处各写一份的三档判断收成 `parseVideoResolution` / `resolutionRank`，`video-director.ts` 里两份私有排序数组消失；分镜板分辨率下拉框改为从模型目录派生。
- **code-render 给 768P 真实短边**；`200 + HTML` 改为点名「渠道地址少了路径」而不是把 markup 塞进错误消息。
- **工作流运行选项菜单关不掉已修**：根因是关闭清单被抄了多份，工作流菜单是后加的第三个，成了画布上唯一关不掉的浮层。收成一处 `closeDockMenus()`，五条关闭路径（悬停离开 / Escape / 点画布 / 打开其它菜单 / 技能菜单）全部改调它，箭头按钮改成 toggle。
- **测试**：`smoke-video.mjs` 新增 V1l/V1n/V1o（目录与文生视频、三种参考图模式的 role 与上传、上传失败与前置守卫），41 项全绿；`smoke-workflow.mjs` 锁「平行关闭清单只有一份」而不是「某处有没有写 `setWorkflowMenu(null)`」。
- **真机**（api.nbility.ai）：文生视频 1,859,764 字节、图生视频 1,628,276 字节、首尾帧 959,479 字节（376 秒）。
- **版本说明**：本版内容原本准备以 1.30.2 发布，但那个号已被一次不完整的发布占用（只含 768P，缺参考图上传；且发布后 main 被重置，那批代码不在 main 上）。为不覆盖已发布版本的资产，以 1.30.3 发出。

### 1.30.1 — 三个「已经实现但没有入口」的功能补上界面

- **画布整图导出 / 导入接上界面**：后端两条路由与 `buildCanvasBundle` / `parseCanvasBundle` 早就写好了，客户端一直是零引用。现在画布顶栏全屏按钮右侧两个入口。导出把文档连同每个图片资产的字节打成一个 JSON；片段是**引用而非拷贝**（捎上整段视频会让体积不可用），所以带片段的画布一定会产生 `unresolved`，提示按 `asset` / `video` 分开计数告诉用户换台机器后哪部分打不开。导入**总是创建新画布**、分配新 id，绝不覆盖已有画布。
- **两处实现细节**：导出在 `finally` 里 `revokeObjectURL`（几百 MB 的 blob 留在文档生命周期里是内存泄漏）；导入**刻意不走 `seedDocument`**——那个函数会给空画布注入一对起点节点，对新画布是对的、对导入是错的，导出一张空画布应当收回一张空画布。
- **工作流三项开关接上界面**：底栏工作流按钮旁多一个箭头，可切换「复用上次产物」（默认开）、「强制重跑选中节点」（默认关）、「层内并发」（默认开）。三个默认值都等于升级前写死的行为，所以**直接点主按钮与旧版完全一致**——这也是没有采纳「把运行塞进菜单」的原因：那会让常用路径每次都多点一下，而默认值本来就保证了不会误关复用。
- **「复用」有两层，必须同时受控**：`runWorkflowPlan` 的 `reuse` 数组（节点级不提交）与 `runWorkflowNode` 的 `reuse` 布尔闸门（`hasProduce` 时短路成 cached）是两回事。此前调用点只写死了后者，只关前一层的话节点仍会被短路——用户看到开关关了，实际什么都没重跑。
- **补上「写错了也不会有任何测试变红」的那一层**：执行器层原本覆盖得不错，缺的是界面有没有把参数传下去。`smoke-workflow.mjs` 新增接线断言（默认值、两处 `reuse` 同受控、`maxParallel` 方向、重跑只交起点、`useCallback` 依赖），并补执行器两个真实边界：`maxParallel=2` 时同时在飞**恰好** 2 个（此前只测 1 与「不限」两个极端），以及 `0`/`-3`/`1.5`/`NaN` 一律按 1 处理（漏掉归一会让宽度变 0，一个节点都不派发，工作流静默挂住）。
- **`smoke.mjs` 真机断言**：在 jsdom 渲染的画布上确认两个按钮确实在顶栏、`accept` 正确、且没有被打上 `data-dock-item`（那是底栏瓦片的标记，布局守卫会逐个量宽度）。
- **反向用例实证**：把单节点闸门改回 `true`、把限流归一拆掉、把导出按钮文案改错，各自都让对应断言变红；还原后恢复绿色。
- **已知未覆盖**：导出/导入只验证到渲染与接线，真实的几百 MB 导出、跨机器导入、`unresolved` 长文案折行需一次真机走查；大画布导出期间只有按钮变灰，没有百分比进度。导入不做版本兼容转换。

### 1.30.0 — 模型能力改为内置基线表；修好聚合网关模型被误判为未知协议

- **新增 `src/model-baseline.ts`：一张内置的模型基线表**，把「哪些模型 id 属于哪个协议族、以及它是否还该被推荐」从代码分支里搬到数据表。此前每加一个族就要在 `describeModel` 的 if 链上加一段、每出一个新 id 都要改代码；现在弃用一个上游模型是**表里改一行**，与请求拼装逻辑分开评审、分开回溯。
- **不做远程拉取，这是刻意的**：能力目录全部内置，插件不发任何额外的网络请求。上游弃用时发一个小版本更新基线表即可，用户不需要联网同步，也不会有一次「目录接口挂了导致面板不可用」的故障面。代价是表会滞后于上游，所以**保留命名约定兜底**（见下条）。
- **修掉一个线上就存在的误判**：聚合网关按 `vendor/model` 寻址（`google/gemini-3-pro-image`），旧实现拿原始串直接比对，于是 OpenRouter 预设**落到 `unknown`**——面板随即把它当成「只能带 1 张参考图」而误报警告，engine 也退回通用 OpenAI 协议。现在查表前剥掉一层厂商前缀（只剥一层，`a/b/c` 不会塌成 `c`）。本仓库默认模型与全部预设跑一遍，**unknown 从 1 条降到 0 条**。
- **三层判定，顺序是重点**：① 基线表精确命中（唯一能报生命周期的层）→ ② 命名约定归族（保证上游新出的后缀不至于掉进 `unknown`）→ ③ 真的认不出才 `unknown`，仍走尽力而为的通用请求。表不需要追着上游每次发版更新。
- **新增模型生命周期提示，是提示不是拦截**：表里标了 `deprecated` / `removed` 的 id，会在模型选择器下方显示一行说明（有替代品时点名建议改用哪个），走真实主题的 `state-warn` / `state-error` token。**请求照发、不改写、不禁用**——用户可能挂在中转站上，那边仍在服务一个原厂已经下线的模型，硬拦会弄坏本来能跑的流程。三语齐备。
- **刻意不写自动关停日期**：本轮试图核对 OpenAI / Google 官方弃用页，三个入口从构建环境均不可达（403 与超时）。日期是整个页面里最容易变、又最无法在本机验证的一项，写错比不写更有害——要么劝退一个还能用的模型，要么承诺一个已经结束的支持。因此 `lifecycle` 只记录**已经发生**的状态，且每条都必须写明 `source`（测试强制），方便下一个人复核而不是照信。表里目前**没有一条被标为弃用**：没有可靠证据就不编。
- **测试**：新增 `scripts/smoke-model-baseline.mjs`（22 条），覆盖厂商前缀剥离、三层判定、生命周期映射与「不拦截请求」这条边界；接入 `pnpm test` 与 `test:negative` 新组 `baseline`。两条反向用例**实证能变红**：把前缀剥离退回原样、把默认生命周期改成 `deprecated`，各自让对应用例失败。smoke 另加一条真机断言——活跃模型不得出现生命周期提示（误报的代价是让用户习惯性忽略这一行）。
- **边界如实说明**：表里同一批 id 的族判定与能力标注是照现有协议实现填的，**没有对每个 id 逐一发起真实调用验证**；生命周期提示的正向分支目前没有真实数据可渲染，只能由纯函数测试覆盖。

### 1.29.0 — 插件改名「团团TV」；入口可被扫描器验证；侧栏适配 DSH 0.2.2

- **插件显示名定为「团团TV」**（英文界面 `TuanTuan TV`），包名 `@q253595422/dsh-imagegen-video` 不变——npm 包名不允许中文，改的是用户看到的那一层。声明方式是 `locale/zh.json` 与 `locale/en.json` 的 `meta.title`：宿主插件详情页从这个字段取标题，**此前没有声明，于是回退显示完整包名**，页面上就是 `@q253595422/dsh-imagegen-video`。
- **三语品牌文案统一**：`entry.label`（侧边栏入口）、`panel.title`（面板标题，原为 `VisioWork`）、`settings.title`（设置卡标题）、`config.disabledTitle`（停用提示）在 zh / en / ru 三语里改成同一个名字。此前三处各写各的，互不一致。
- **Agent 指导文案与 `/edit_image` 成功提示**同步改用新名；指导文案保留包名以免模型对不上实际安装的模块。
- **刻意不改**：设置分区名「生图配置 / Image settings / Настройки генерации」。它是位置名不是品牌名，后端 22 处错误提示与 3 条测试断言按它定位，改它得成批同步且不带来品牌收益。
- 新增 `smoke` 的 **D6** 守卫：两语 `meta.title` 必须存在且非空、中文必须是「团团TV」、英文不得回退成包名、且与界面里的 `panel.title` / `entry.label` 一致。**反向验证过**：删掉 `meta.title` 后 D6 变红。这个字段纯展示、没有运行时代码读它，漏写不会有别的检查报错。
- **插件图标入库**：`icon.png` 此前只在本机、没提交，`package.json` 也没有 `icon` 字段；现两样都有并进 `files`。
- **`main` / `exports["."]` 改指仓库根目录的 `index.js`。** 此前指向构建产物 `lib/index.js`——`lib/` 被 gitignore，只读源码树的扫描器拿到一个声明了却不存在的文件，读不到 `apply(ctx)`，`DSH_RUNTIME_APPLY_MISSING` 让收录扫描的 DeepSeek Harness Plugin 一项丢 5 分。现根目录是两行再导出（`export *` 加显式 `export { apply }`），`files` 同时装它与 `lib/`。**同一版本扫描器本地 77/100 → 85/100**，该项 15/20 → 20/20。
- **`verify-pack` 改按声明入口追问「是否被某条 `files` 条目自己覆盖」。** 此前只问「包里有没有」，而打包器总会无条件附带 `main` 指的文件，所以从 `files` 删掉 `index.js` 依旧全绿——这层兜底在 `main` 改名或换成严格读 `files` 的打包器时消失，入口静默消失的后果是「装上了、什么都没发生」。新增负向用例钉住。
- **侧栏入口与历史区适配 DSH 0.2.2（#35）**：新版本在侧栏列与 `sidebar.workspaces` 槽之间加了 `scrollRegion > scrollArea` 两层，插件仍按旧结构定位，导致入口不可见、点击被工作区行内动作抢走、历史区只占半截。`sidebarRoot()` 改为向上找「同时含全局 New Session 按钮」的最近祖先，`newSessionButton()` 排除工作区级行内动作，`markBlocks()` 只隐藏与 region 同级的 panel nav 而保留 history host；**手机端**点「会话 / 生图」后调宿主 `[data-sidebar-toggle]` 收起抽屉，不再被盖住。新增 smoke D3b。
- **修掉 rolldown 1.3 上的可复现性静默失效**：banner 从 `//#region <id>` 改成 `// <id>`，只匹配前者的正则一条都匹配不上，`node_modules` realpath 前缀进了产物，同源码在另一目录构建字节不同。旧正则只在 rolldown 1.1 上验证过，升级后是静默失效而非报错。现两种拼写都归一化，并限制前缀不含空白与冒号以免误伤普通注释。
- **没有版本变更的推送不再当成发布事件**：原闸门把「`package.json` 变了」当「要发布」，九条 dependabot PR 全会触发 Release 并因版本未升而让 `main` 变红。现提成独立 `preflight` job：tag 不存在→发；tag 指向本次提交→发；`replace_released_assets`→发并告警；**本次没改 `version`→跳过且不失败**；改了 `version` 撞上已发布号→失败（不许覆盖旧资产）。用 `github.event.before` 比对，merge / squash / 直推都适用。
- **新增 HOL 插件扫描器自检 workflow**（收录 PR 的建议项，缺它会在 registry trust score 扣 10%）。取官方模板，checkout 换成仓库统一 pin v7.0.1，权限仅 `contents: read` 且 checkout 不留凭据，action 固定 v1.2.806。它是 advisory：`min_score` 钉在收录门槛 75、`fail_on_severity: none`。
- **本版 `Publish to npm` 首次运行报红，是读取延迟不是发布失败**：`npm publish` 退出码 0，5 分钟轮询窗口内 registry 尚不可读（日志明确写了不是 auth failure），实际 3 分半后可见、`latest` 已指向 1.29.0，重跑后整条 run 转绿；npm 与 GitHub 资产 tgz 字节一致。
- 依赖升级：`tsdown` 0.23.7、`lightningcss` 1.33.0、`@types/node` 26.6.6、两个 `@deepseek-ai/dsh-client-*` 到 0.1.2-rc.1；actions checkout 7.0.1 / setup-node 7.1.0 / upload-artifact 7.0.2 / download-artifact 8.0.2 / pnpm-action-setup 6.1.1。

### 1.28.0 — 插件拆成 13 个可独立装卸的组件；画布整图导出/导入；Agent 读写画布结构

- **宿主侧从一个组件拆成 13 个**：1 个共享核心（`imagegen`：设置、渠道、队列、订阅、更新、浏览器工作台）+ 12 个独立 feature 组件（image / video / canvas / gallery / templates / skills / ppt / ecommerce / outfit / prompt / storage / diagnostics）。每个都有自己的 exports 子路径、多语言文件与注册行，可单独 mount 与 unload；路由归属由一处判定函数决定，未知端点留在核心；移除核心连带挂起依赖者。这是生命周期边界不是权限边界——浏览器侧仍是一个共享工作台，已提交的上游任务不会因卸载而取消。老安装需重新加载新版包并重组 bundle 才能看到这 13 行。
- **画布整图导出/导入（宿主路由）**：一个 JSON 文件搬走整张画布，v2 文档 + 引用素材字节内联 base64，不引入 zip 依赖；导入永远新建（新 id、节点 id 保留），绝不覆盖已有画布；拿不到字节的引用逐条进 `unresolved` 并带 nodeId，不静默丢弃；上限 256MB，超限 / 坏 base64 / 路径穿越 / 文档版本过高在写入前逐个拒绝。**界面还没有入口**，本版只交付两条路由与全部校验。
- **Agent 画布工具（八个）**：`list_canvases`、`read_canvas`、`create_canvas`、`add_canvas_node`、`update_canvas_node`、`remove_canvas_node`、`connect_canvas_nodes`、`disconnect_canvas_nodes`。**没有任何 run/generate 类工具，并被套件钉成断言**（扫描工具名与 schema，加一个生成工具立刻变红）——生成要用户自己按运行键。写操作走 `CanvasStore.save(document, revision)` 同一把乐观锁，冲突时返回可操作说明；`read_canvas` 附带结构提示（无下游连接的节点、孤立节点）。
- **工作流执行器三项加法能力**：续跑（上一轮已有结论的节点按 `cached` 计，画布一直在用）、强制重跑（指定节点及其下游闭包以 force 提交，优先于续跑）、层内并发上限（默认不限，保持旧行为）。后两项**尚无界面开关**。
- **手机端第三轮（#33）**：画布 dock 改单排横向滑动、画布铺满面板；素材选择器未点选时详情栏收起、点选后大图为主；点标题/筛选/状态栏回列表的返回手势；搜索框字号 16px 修掉 iOS 整页放大；服饰说明两行截断。
- **修复：切走画布丢弃在途技能运行。** `seedSkillRuns` 整体重建运行表，只留「属于该画布且非挂起」，在跑的 run 与已挂起待落地的输出一起被丢，而轮询跳过挂起项——那是它唯一一份拷贝。
- **修复：技能挂起输出 effect 按 id 集合触发。** 依赖数组原先读 `length`，一次提交里删一条又新增一条时长度不变，effect 不重跑，新条目永不落地。
- **修复：技能轮询防重入。** host 慢时上一次 tick 仍在 await，下一次就起来读同一份 ref、重复请求并重复弹通知。
- **修复：画布导入失败区分「文件太大」与「不是画布文件」。** 新增 `readJsonBodyExact`，超限返 `too-large`（读到上限就停）、解析失败返 `malformed`，分别给 `bundle-too-large` / `bundle-malformed`；以前一个被截断的 2KB 文件会被报成超过 256MB。
- 删掉无人读取的 `flowEdges` 派生与其专属 helper（连线真正由 connection-layer 按 `document.connections` 绘制，同一套过滤规则此前已漂移过一次）。
- **仓库侧**：补 `SECURITY.md`、Dependabot 配置、三个工作流 action 全部固定到 40 位 SHA（第三方收录扫描 77/100 过 75 分门槛）；release 加闸门——版本已发布且 tag 指向别的提交时直接失败并说明怎么 bump，另补 release 侧的无头浏览器安装；CI 里四个浏览器守卫不再「找不到浏览器就退出 0」；反向验证可并排跑（14 组 `--jobs 3` 全过，`contracts` 单组 577s 占串行 93%）。
- 测试：新增 `smoke-components`（12 个组件各自挂载/卸载/重挂、根组合全端点、video 工具单独卸载、移除核心连带挂起）、`smoke-canvas-bundle`（14 项）、`smoke-canvas-agent`（10 项，三条反向验证）；`smoke-workflow` 补 12 条、三条反向验证。**未验证项**：画布导出/导入、Agent 画布工具、工作流 rerun/maxParallel 均无界面入口，只有路由与工具层被覆盖。
### 1.27.0 — 千问生图 API；大图预览可按住拖动（一并发布 1.25.0 / 1.26.0）

- **v1.24.0 之后的第一个发布版本。** 1.25.0（react-flow 画布引擎）与 1.26.0（画布布局对齐 LibTV）此前只推了代码、没有 tag 与 Release，它们的改动随本版一起发出，条目保留在下面各自的小节里。
- **渠道协议新增「千问生图 API」（#32）**，文生图与图生图都支持。走 DashScope 异步任务链路：提交拿 `task_id` 再轮询，上限 240 秒、超时抛 `upstream-timeout`；进行中/完成/失败三张状态词表（失败含 `cancelled`/`canceled`），词表外的状态直接报 `upstream-invalid`，不当成「还在跑」无限等待。比例按文档档位发送，**21:9 无对应档位按 16:9 发**；清晰度映射 `megapixels`，**上游上限 2MP，2k/4k 都取最高档**。图生图上传参考图原始字节；空 Key 不发空 `Bearer ` 头。渠道支持模型检测，文案补齐 zh/en/ru。
- **修复配置校验拒绝 `google-native`。** `src/index.ts` 的 schemastery `protocol` 联合漏了类型里早已存在的 `google-native`，实测旧 schema 报 `expected "auto" | "images" | "chat-completions" but got "google-native"`。#32 顺带修掉的独立缺陷。
- **修复大图预览放大后无法拖动（#31）。** 以前放大后只能拉滚动条，现在按住鼠标左键直接拖画面平移：pointer 事件 + `setPointerCapture`，反向写 `scrollLeft`/`scrollTop`，移动距离与鼠标一致；光标 `grab` → 拖动中 `grabbing` → 松手复原。拖动后紧跟的那一次 click 由浮层捕获阶段的一次性抑制器吞掉，不会误关预览，随后的普通点击照常关闭。只接管鼠标主键，触摸交浏览器，内容不溢出不拦按下；图片禁用原生拖拽。
- 测试：新增 `smoke-qwen-draw.mjs`（桩 fetch、零网络，断言请求体深度相等、`21:9→16:9`、`4k→2MP`、上传原始字节）接入 `test` 与 `test:negative`；`verify-ui-contracts` 新增 11 条预览拖拽不变量与 1 条真实 `getComputedStyle` 测量。#31 在打包产物解包部署后的真实实例上复验（200% 下拖 200×80，scrollLeft 547.5→347.5、scrollTop 296→216，拖后 click 不关、普通 click 正常关）。千问协议未用真实 Key 发起过请求，线上返回未验证。

### 1.26.0 — 画布布局对齐 LibTV：悬浮顶栏、左下工具排、分组 dock、空态快捷卡

- **顶栏改悬浮细栏。** 不再占布局高度，画布铺满整个区域；顶栏玻璃浮在其上（项目下拉/重命名/收藏/全屏/保存状态原样保留）。中心点语义不变：chromeHeight 只量底部 dock。
- **左下工具排铺平。** 网格吸附、显示连线从缩放菜单里独立成按钮（`aria-pressed` + 高亮，状态一眼可见），与小地图/适应/缩放%并排；缩放菜单保留预设与自定义。
- **dock 按 LibTV 节奏分六组**：工具｜建节点｜库｜运行｜编辑｜删除，组间发丝分隔；tile 命中区 34→40px（弹簧基准同步），hover 标签照旧。全部动作一个不删。
- **空态快捷卡。** 无节点的画布居中「开始你的创作」+ 一排五卡（图片/视频/文本/分镜/文件），点卡=现有创建动作落在画布中心；视频走现有 video picker。有节点后卡片退场。文案补齐 zh/en/ru。
- 配色仍跟随宿主主题、插件外框不动（用户拍板）；窄屏顶栏换行不溢出。测试：smoke 新增空态驱动检查（空文档→五卡→点卡建节点→卡片退场）与配套反向用例；canvas-layout fixture 同步新分隔位与左下排；#27 弹簧边界同步 40–50px。
- 真机走查修掉两个手势缺陷：框选不再把空态快捷卡当空白（pointerdown 的 preventDefault+指针捕获曾抢走卡片 click）；`.node` 外壳恢复 pointer-events:auto（react-flow wrapper 的 none 可继承，曾让卡片本体收不到真指针、拖拽死掉）。各配契约不变式与反向用例。

### 1.25.0 — 无限画布换用 react-flow 引擎；LibTV 式缩放菜单与视图开关

- **画布渲染与视口交给 @xyflow/react v12（受控视图），现有功能全部保留。** `CanvasDocument` v2 仍是唯一真源：宿主校验、revision 乐观锁、自动保存、撤销重做留在文档层，用户磁盘数据零破坏。节点拖动（边缘对齐吸附、标注卡随行、重叠提示）、四角 resize、选择、连线、捏合缩放、框选保留自定义引擎，手势与快捷键一个不丢。
- **无损适配层。** 新增 `canvas-flow-adapter`（节点/连线/视口双向 round-trip，metadata 全字段与「无/空 metadata」区别保住）与 `canvas-flow-context`（模块级稳定节点外壳）。连线持久化仍存 `{fromNodeId,toNodeId}`，workflow/compose/storyboard 纯函数契约不动。react-flow 样式构建时内联，跨目录可复现构建字节一致。
- **LibTV 式 chrome。** 缩放百分比点开预设菜单：放大/缩小/适应、50–800% 预设、自定义输入（上限 500%→800%）；视图开关：对齐吸附、显示连线（隐藏持久边，进行中预览不受影响）。文案补齐 zh/en/ru。
- 测试契约同步：smoke 沙箱补 react-flow 所需桩（测量 ResizeObserver/DOMMatrix/navigator），boxOf 改读 wrapper transform；verify-ui-contracts 新增 adapter round-trip 与视口有限值守卫；反向锚点迁移并新增四条用例。真机逐项走查缩放菜单、草图重绘、标注引线、重叠徽标、视频节点工具条与拼接条。

### 1.24.0 — Google 原生渠道协议；URL 型模板图不再 404

- **渠道「接口协议」新增 Google 原生（#28）。** 用 Google API Key 直连 Generative Language `:generateContent`：`x-goog-api-key` 鉴权，参考图最多 5 张走 `inlineData`，比例/清晰度嵌套在 `generationConfig.imageConfig`，auto 省略；body 不带 `n`，多张由并行单图请求满足；响应跳过 `thought` 部分、兼容 `inline_data`、缺 mimeType 按字节嗅探，空结果报 `blockReason`。配置地址带 `/models`、`:generateContent`、`/interactions` 后缀时自动剥回基址。GIF 请求在网络调用前拒绝，不静默降级成静图计费。
- **google-native 渠道支持模型检测。** GET models 列表解析 `name` 字段、剥 `models/` 前缀、只留图像模型；完整 URL 模式下检测按钮放行。新增「Google Gemini 官方（原生）」预设（v1beta，预填 gemini-3-pro-image / gemini-2.5-flash-image），协议选项与提示补齐 zh/en/ru；参考图上限对 google-native 给 5 张。
- **URL 型模板图缩略图全部 404 修复（#29）。** `imageFileFrom` 的空段校验把解码后 `https://` 的 `//` 判成空段，五个 URL 型模板源的引用恒死在路由层。仅对模板路由放行 URL 型引用（空段不拦、复合上限 400→4100），`.`/`..`/绝对路径照旧拒绝，主机白名单仍由 store 兜底；其余图片路由不受影响。
- 新增 `smoke-google-native.mjs`（桩 fetch、零网络、直接 import src）接入 `pnpm test` 与 `test:negative`；smoke 新增 C6a2（URL 型模板图透传/穿越/超长/作用域）与 D4（客户端 google-native 接线）。反向用例 6 条全部 RED as expected。

### 1.23.1 — 服饰穿戴：草稿读失败不再把整张表单锁死

- **「角色搭配」点不动的根因是草稿读失败变成了永久禁用。** 面板在草稿读回来之前会把整张
  `<fieldset>` 禁用，避免迟到的草稿覆盖用户刚做的编辑；但读**失败**时 `draftLoaded` 永远是
  `false`，于是模式切换、图库入口、上传按钮全部点不动，提示只说「无法读取搭配草稿」。现在
  只有「正在读」这一小段窗口会锁表单，读失败后表单解锁，提示同时说明「现在仍可继续编辑，但
  草稿要等重新加载成功才会保存」。
- **重试成功不覆盖用户眼前的编辑。** 读失败期间改过配方（模式、素材、场景、模型）就记为已编辑，
  重试或重新挂载拿到的旧草稿不再覆盖它，只解除保存闸。
- **离线套件的 E1 不再在禁用控件上点空气。** 它的 jsdom 沙箱没有应答 `/outfit/draft`，请求
  落到 catch-all 抛错，表单因此整块禁用——`dispatchEvent` 仍会触发处理器，所以模式切换看
  起来被覆盖，而真浏览器会把点击直接丢掉。补上该路由的应答，并新增两条断言钉住「表单与模式
  按钮在点击前是启用的」。点击后的断言改为等一次重渲染再读（React 在同一个 tick 内批量更新，
  紧跟着读只能读到渲染前的树）。
- 反向用例新增一条：把 `formLocked` 改回恒禁用，上述断言必须变红。

### 1.23.0 — 服饰穿戴：商品试穿与角色搭配；生图支持 GIF 动图

- **「服饰穿戴」支持两种模式。** 「商品试穿」拿真实商品图当服装参考，保留版型、颜色、图案与材质，人物与至少一张服装图为必选；「角色搭配」把参考服装设计穿到人物身上，人物、服装、姿势三类素材任选其一以上，也能和自己的图混着用。
- **人物、服装、姿势有了内置图库。** 选图器支持按名称或标签搜索，按分类和来源筛选，姿势还能按视角筛选；服装条目带多视角可切换，姿势可选深度图。18+ 素材默认不显示，需要时手动打开。
- **提交前先看预览，所见即所发。** 点「准备参考图预览」只下载与排版参考图、不调用模型，右侧给出实际会发送的图片和完整提示词；确认后才调模型。任何编辑、换渠道或换模型都会让预览失效，需要重新准备，避免发出去的和看到的不是同一份。
- **参考素材超过渠道容量时压成一张编号拼图，不再静默少发。** 一部分模型只收一张参考图，以前多出来的会被丢；现在把全部素材排进一张带「图N 用途」标注的拼图，提示词同步改成按格子编号指代，预览里也会说明这次发的是一张拼图。拼图按原比例留白，不裁切服装或姿势。
- **搭配草稿自动保存。** 模式、素材、场景、比例、清晰度与所选模型都留在本机，编辑停顿约 0.35 秒即写入，下次打开接着改。
- **可以完全离线用。** 把 `anhao/ai-pose-gallery-zh` 克隆到本地后填目录路径即可导入整份图库；其余情况图库索引与图片按需缓存到 `~/.dsh/dsh-imagegen/outfit/`，选中后读的是本地副本，第三方站点失效也不会中途失败。
- **图库数据锁定到固定提交。** 索引与图片都按 Git blob 校验，站点不可达时换镜像重试，并用图片魔数确认拿到的确实是图片；更新失败时继续使用已有离线索引并在面板上说明原因。
- **参考图片的权利归各来源原作者所有，不适用本插件的代码许可证**，使用时请遵守原站条款，部分素材不允许商用；面板底部会显示当前素材的来源说明与原始链接。

#### GIF 动图

- **支持 `gpt-image-2.6` 生成 GIF 动图。** 面板新增「静图 / GIF 动图」切换，选了 GIF 才出现帧数与每帧时长的输入；请求按 `output_format: 'gif'` 整形，帧数夹在 2–16、每帧不短于 20ms，超出的按上限收窄而不是发出去被上游拒绝。
- **不支持的模型与渠道在发请求前就拒绝。** GIF 请求先过能力闸再分派协议：模型不支持、或渠道协议是 `chat-completions`（该请求体根本没有 `output_format` 字段，模型再新也只会出静图）时立即报错，不会静默降级成一张静图却照常计费。订阅渠道同样明确拒绝。
- **帧数与时长只有一个真值。** 面板上的时长提示、提交的参数、引擎的夹紧用的是同一个函数：清空输入框按「未设置」回落默认值，而不是一处按默认、一处按下限，造成提示 1.8 秒实际 0.4 秒。
- **GIF 期间不能切到不支持的形态。** 开着 GIF 时「图生图」与「对比」置灰并说明原因，而不是点下去界面闪一下又弹回来看起来像按钮坏了；生成数量固定为 1 并注明原因，因为 GIF 受上游像素预算限制只能出单张。
- **动图在结果板、历史、画廊与画布里都按动图处理。** mime 按字节魔数判定（GIF87a/GIF89a），下载扩展名、历史记录标记与画廊落盘都认 gif，预览用浏览器原生播放，不会只显示第一帧。

### 1.22.2 — 侧栏：生图态也有收起和展开键，标签栏对齐宿主

- **生图态「收起侧边栏」消失，根因是那条 chrome 条没有 slot 锚点。** macOS 宿主把折叠
  控件放在 logoRow 之上的 `topStrip` 里（为了避开红绿灯），而插件「隐藏外来条目」的
  `display: none !important` 把整条吞掉——连带 logoRow 上移、品牌 logo 被压进红绿灯底下，
  用户只剩 ⌘B。改为按**可访问名**（中英文四个词）认出宿主自己的折叠控件，把它所在的
  root 直接子块并入 chrome 白名单。按名字不按类名，是因为宿主类名是构建哈希
  （`kB3qhq_`，上一版还是 `_3WPZCG_`），升级就变。
- **可见性只用来择优、不做过滤。** 被自己规则隐藏的块必须还能被再次认出来，否则标记
  一次失败就把按钮永久弄丢——这种自锁比原来的 bug 更难查。
- **生图态「打开侧边栏」也能用了，但原因完全不同：不是没渲染，是被盖住。** 收起后宿主在
  左上角挂 `[data-shell-leading]` 座位（`z-index: 15`），里面是「打开侧边栏」和「新建会话」；
  插件接管中心列是 `--z-takeover: 60`，于是生图态把它压在下层。会话态之所以正常，纯粹因为
  它的插件视图是 `display: none`。实测按钮位置一直正确（`88,11`，28×28），只是中心点命中的
  是插件自己的标题行。
- **抬座位，不降接管层。** 60 是钉死的：任务板、SSH 等兄弟面板都照着这个数写过，挪它会
  连锁影响插件之外的代码。新增 `--z-shell-seat`（63，层级表独占一个号），只抬这个只在
  收起态存在的宿主座位；同时用宿主发布的 `--dsh-frame-top-clearance` 给面板加顶部内边距，
  免得生图第一行贴在座位底下。
- **标签栏不再和「新建会话」差 2px，而上一版的几何检查是假绿的。** 真机量出来标签栏
  `16..264`、按钮 `14..266`；检查没发现，是因为 fixture 自己声明了
  `--dsh-sidebar-paint-inset: 3px`，和 CSS 的 fallback 正好一致——检查在和自己的假设对答案。
  真宿主整条祖先链上都没有这个变量，按钮用的是写死的 `margin: 2px`。现在 CSS 不再假装
  知道内缩是多少，`alignToSeat` 直接读兄弟按钮的**已用 margin**——样式表看不见兄弟的
  used value，这是唯一诚实的来源。真机复测两侧 0 漂移、间距 8px。
- **`role="tab"` 现在兑现了键盘契约。** 上个 PR 加了角色，但两个 tab 都在 Tab 序里、方向键
  什么也不做。改为复用 `tablist.ts` 的 `tabIndexFor` / `onTablistKeyDown`，把 `tabIndex` 写进
  同步选中态的**同一处**，让 `aria-selected` 与 Tab 序永远描述同一个状态；侧栏入口是命令式
  构建，点击和方向键共用同一个 `activate`，避免两条路径漂移。契约扫描因此覆盖 `.ts` 的
  tablist，并新增真浏览器几何检查。
- **四条修复都补了会变红的反向用例**：删掉 chrome 白名单、删掉抬座位的规则、
  `alignToSeat` 退回读不存在的变量、去掉 roving tabIndex。

### 1.22.1 — 深色模式：预览按键恢复可见，浅色画布恢复原样

- **深色模式下全屏预览的按键「都看不到」，根因不是填充不够，而是基色跟着主题翻转了。**
  v1.22.0 把 lightbox 的墨色与所有 `color-mix` 基色都取自 `--dsw-alias-label-primary-foreground`。
  这个 token 名字像「白色」，实际是**「站在哪种表面上的反色」**：DSH 主题包里它在 `body` 上是
  `#fff`，在 `body[data-ds-dark-theme]` 上是 `#0f1115`。深色主题下它把每个控件的底色与文字
  一起压成近黑，叠在本来就有 88% 黑的照片遮罩上，实测填充 1.03:1、描边 1.08:1、提示文字 1.11:1、
  说明文字 1.15:1——不是「太暗」，是和底色同色。改用静态色阶 `--dsw-static-neutral-00`（两套主题
  下都是白）后，两套主题实测都是**文字 5.34:1、控件边界 5.41:1**。浅色主题的取值一个字节都没变，
  因为它原本解析出来就已经是 `#fff`。
- **圆形按钮的填充从 40% 降到 34%，因为 40% 会吃掉图标。** 上一轮为了把圆盘抬到 3:1 用了 40% 填充，
  而白图标在 40% 填充上只有 4.38:1，低于文字要求的 4.5:1——等于用丢图标换来边框可见。34% 是唯一同时
  满足两边的取值：图标 5.32:1、圆盘对遮罩 3.10:1。边界本来也由 55% 的描边扛着（5.87:1），
  填充只需要自己过 3:1 那条线。
- **无限画布：深色卡片与背景同色的问题修好了，但浅色模式回到了原样。** v1.22.0 用
  `label-primary` 混 12% 去「一次性修好两套主题」，可是这个 token 在浅色下近黑，于是把一个
  本来没问题的浅色画布也调灰了。事实是：DSH 的 `layer-1/2/3` 在浅色下**全是 `#ffffff`**，
  白卡片配白背景就是用户原本要的样子；缺陷只在深色。现在 `.root` 的默认值退回
  `bg-layer-1` / `border-l1`（浅色逐字节不变），深色由
  `body[data-ds-dark-theme] .root` 单独覆盖：填充 12% 混色（对画布 1.44:1）、描边 36% 混色
  （3.19:1）。悬停也拆成变量，浅色仍是原来的 `border-l2`。
- **两处契约都改成同时测两套主题，并修掉两个假绿来源。** 预览的 fixture 原先把
  `label-primary-foreground` 硬写成 `#ffffff`、且只渲染浅色，深色永远没被画出来；现在按
  DSH 真实取值各渲染一遍。画布的 fixture 把 `.module.css` 原样塞进 `<style>`，而
  `:global(...)` 是 CSS Modules 语法、浏览器会丢弃整条规则，所以深色覆盖根本没生效——现在按
  构建后的样子归一化。新增三条反向用例：深色墨色回退、浅色画布被调暗、圆形按钮丢边界，
  都确认把缺陷植回后检查变红。

### 1.22.0 — 大图预览可关闭、深色画布节点可辨认，接入 Agnes 图像/视频

- **大图预览的关闭按钮原来是「看不见」，不是「没有」。** 按钮一直渲染着，但白色图标画在 16% 白的圆盘上、
  下面再叠 82% 黑遮罩：圆盘对遮罩 1.67:1、描边 2.03:1，图标本身却和圆盘有 8.15:1。原来的检查之所以是绿的，
  因为它量的是**图标 vs 自身表面**——圆盘彻底消失也照样满分。现在边界放到描边上而不是填充：填充要抬到
  40% 才够 3:1，而白色文字放在 40% 填充上会掉到 3.9:1，等于用丢掉文字换边界。浮在照片上、不承载文字的
  圆形按钮（关闭、左右翻页）同时给 40% 填充与 55% 描边，带文字的药丸保持原样。
  实测：填充 3.52:1、描边 5.26:1、38×38、中心点命中自身。顺带补了 `:focus-visible` 描边。
- **一次滚轮不再同时滚动和缩放。** 原处理器是 `onWheel={e => { e.preventDefault(); … }}`，而 React 18 把
  `wheel` 挂在 root 上注册为 **passive**，那句 `preventDefault()` 是死代码——于是浏览器照常滚动，同时
  handler 又改了缩放。现在改用原生 `{ passive: false }` 监听，**只有 Ctrl/⌘ 才缩放**（两个键都认：报障用户
  在 Windows，插件也发行到 macOS），界面上有提示文字，`overscroll-behavior: contain` 让滚轮在预览内收敛。
- **预览层内操作不再带动底层工作台滚动。** 上一版只给 stage 加了 `overscroll-behavior`，那只约束 stage 自己的
  滚动链：遮罩是 `position: fixed; inset: 0`，鼠标停在工具条、说明或留白上，滚轮仍会滚到下面的工作台
  （实测滚了 300px）。现在遮罩层自己吸收滚轮，实测 stage / 工具条 / 边距三个点位都不穿透。
- **深色画布中节点与背景原来完全同色。** `.root` 和 `.node` 画的是同一个 token `--dsw-alias-bg-layer-1`，
  对比度实测 **1.00:1**——不是「接近」，是相同。换成 `layer-3` 也不够：深色相邻两层只差 1.298:1，
  而**浅色下三层全是 `#ffffff`**，换层对浅色零改善。改用 `label-primary` 混色（它永远是背景的反色），
  同一句声明在两套主题下方向自动正确：深色节点更亮 1.87:1，浅色节点更暗 1.29:1。12% 是两套主题都过
  1.25 的最小步长。边框同样混色，深色下 **3.07:1**（原 `border-l1` 只有 1.16:1），正好越过
  WCAG 1.4.11 的 3:1。
- **悬停加强只加强「静止态」，不削弱选中态。** `.node:hover` 是 (0,2,0) 特异性，会盖掉 `.nodeSelected`
  等 (0,1,0) 规则——悬停一个已选中的节点反而把它降回 hover 强度。用 `:not()` 链显式排除选中/关联/
  连线目标/重叠/标注中五种状态。
- **新增 `agnes` 图片协议族**（`agnes-image-2.5-flash` / `2.1-flash` / `2.0-flash`）。此前这类 id 落到
  「未知协议」，图生图按 OpenAI 编辑协议发 `POST /images/edits` multipart，而 Agnes 根本没有这个端点，
  网关回 `503 no available server`（实测 14s 后失败）。现在编辑走 `POST /images/generations`，参考图
  以 URL / `data:` URI 数组放进 `extra_body.image`（多图合成天然支持），输出格式也写在
  `extra_body.response_format`——Agnes 明确禁止顶层 `response_format`。
- **尺寸改成档位 + 比例。** 面板的清晰度档映射为 `size: 1K/2K/3K/4K`，画幅映射为 `ratio`
  （1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9）；`auto` 回落到 `1K` 且不发 `ratio`。
- **不再发送 OpenAI 的 `quality` / `detail`。** Agnes 对 `quality` 直接 400
  （`quality is not supported by text image queue`），所以文生图只要用户选了清晰度档就会失败；
  现在这两个字段只按协议族发送。
- **新增「Agnes AI 官方」渠道预设。** 预填 `https://apihub.agnes-ai.com/v1`、三个图片模型与
  `agnes-video-2.5-flash`，图片与视频可以共用同一个渠道。
- **Agnes 视频对齐官方文档。** `agnes-video-2.5-flash` 只接受 `size: "720P"`（其他值在**创建任务前**
  就返回 `400 size must be 720P`），现在按 id 收窄档位，面板不再提供必然失败的选项，非 flash 的
  `agnes-video-2.5` 保留 480P/720P/1080P；参考图在提交前截断到 5 张
  （`400 images length must not exceed 5`）；画幅补上实测可用的 `21:9`；轮询放宽到 2s / 40 分钟
  （实测一个 4 秒片子建完后 35 分钟仍在 `queued`，原来的 20 分钟上限会把还在排队的任务误报成超时）。
- **画布工具的键盘可达性**：`.root` 是 tab 停留点，工具栏可由键盘走到。
- **验证**：`pnpm test` 全套 265 项通过、退出 0；`typecheck` 与 `build` 通过；新增真浏览器契约检查
  （预览关闭按钮边界、滚轮语义、遮罩不穿透、深色画布节点对比度），并对每条修复补了**反向用例**——
  把缺陷注回仓库副本后对应检查必须变红。因为「注释里解释缺陷」会命中「找缺陷」的正则，滚轮检查改用
  TypeScript 自己的 `transpileModule` 剥注释（手写的扫描器会在正则字面量 `/https?:\/\//` 上误判）。
  另外反向用例抓出过一次自己的**假绿**：遮罩穿透检查最初把监听写死在 fixture 里，等于自证，改正为
  由源码文本驱动后才真正会在缺陷下变红。

### 1.21.0 — 画布底部工具条自适应，Agent 生成结果可直接内嵌

- **画布底部浮层不再互相压盖，窄了就换行。** 任务工具条、缩放条、缩略图原来是三个各自绝对定位的图层，
  彼此不知道对方尺寸：三栏布局下画布只有约 1000px，711px 的任务工具条与 236px 的缩放条横向重叠约 107px，
  压住缩放条最左侧四个按钮；面板 560px 时工具条还会溢出左边。这类重叠取决于**面板**宽度而不是窗口宽度，
  `@media` 测不到，jsdom 也没有排版引擎，测试一直是绿的。现在三者合并成一个换行 flex 行，宽度不够时
  任务工具条换行而不是盖上去；工具条自身也会在面板比它窄时折行（实测窄于约 690px 折成 2 行、83px 高）。
- **画布给底部浮层留出真实高度。** 浮层浮在画布之上不占布局空间，`fitView` / 新建节点 / 种子节点
  算的都是被遮挡的几何中心。现在用 `ResizeObserver` 实测「视口底 − 任务工具条顶」并三处减掉；
  不用浮层总高是因为缩略图在左侧、不挡中间，按总高留会白扔 150px。
- **Agent 生成结果输出落盘绝对路径，支持在回复正文内嵌图片。** 工具结果新增 `files` 与 `embed_id`，
  提交时带 `agentTool` 标记区分 Agent 生成与面板生成。不新增 UI 注入。
- **修复 `files[]` 永远是空数组。** 没有任何地方给 `embedId` 赋值，结果回来时短路成 `files: []`。
  现在两条路径都先建 id 再 append，且只在 store 确实列出该条目时才回显——写盘被丢弃时不给不存在的路径。
- **顶栏新增画布全屏控件。** 走真实 Fullscreen API，任何途径退出全屏都会回写到按钮状态；
  模板库抽屉改挂载到画布根节点，避免在全屏元素之下被盖住。
- **验证**：`tsc` 0 错、`pnpm build` 与 `pnpm test` 全套通过；新增真浏览器布局守卫
  `verify-canvas-layout.mjs`（五档面板宽度零重叠 + fixture 双向核对），反向验证注回旧布局后实测
  重叠从 0 变成 2644px² 并变红。

### 1.20.0 — 接入 snapgen.ai 视频模型

- **新增 snapgen.ai 视频协议族。** 渠道预设新增 `snapgen.ai`，支持 `grok-1.5-lite`、`grok-video`、
  `grok-lower`、`muse-ai-video`、`vela-ai-video` 五个模型。该服务不是 OpenAI 兼容接口：提交是
  multipart 加自研反爬守卫头 `x-guard-id`，返回历史 uuid 而不是任务 id，状态接口 `GET /history/{uuid}`
  用数字状态（1 生成中 / 2 完成 / 3 失败），成片地址在 `generated_video[0].video_url`。这四条都在
  `src/snapgen-engine.ts` 里单独实现，`video-engine.ts` 只负责编排。
- **密钥填 refresh_token，Access Token 自动续期。** Access Token 只有约 10 分钟有效期，过期时上游
  返回的是 HTTP 403 `TOKEN_EXPIRED` 而不是 401，所以引擎按 JWT `exp` 提前续期，并在收到带 TOKEN
  字样的 403 时强制刷新后重试一次。密钥栏接受原始 refresh_token、`{"refresh_token":"…","cdp_port":9333}`
  形式的 JSON，或一枚仍在有效期内的 access_token。
- **每次提交现场换取一次性 Cloudflare Turnstile token。** 上游强制校验，token 一次性且绑定 site key，
  无法缓存或本地计算，因此通过本机 CDP Chrome（默认端口 9333，无头亦可）在真实 snapgen.ai 页面上换取。
- **按模型区分能力。** 时长与比例词表按模型收窄后渲染：`grok-*` 为 6/10/15 秒，`muse-ai-video` 固定
  10 秒，`vela-ai-video` 固定 5 秒；五个模型都支持文生视频，`muse`/`vela` 另有图生视频。视频面板与画布
  的时长、比例、分辨率选项改为读目录数据，不再写死 `[5, 10]`。
- **只有视频模型的渠道可以保存了。** 以前渠道至少需要一个图片模型标识才能保存，只接视频的 snapgen
  渠道因此存不下来；校验与「已就绪」判定改为图片或视频模型任一非空即可。
- **验证**：`tsc` 0 错；离线冒烟新增两组断言（守卫字节与实测值逐字节对齐、提交前失败不触网），
  `smoke-video.mjs` 33 项全过；通过插件本体对 api.snapgen.ai 实跑成功出片：文生视频 10 秒 4.3 MB、
  图生视频 10 秒 7.7 MB，均为 h264 + aac 的有效 MP4。

### 1.19.1 — 修正历史提示词换行展示位置

- **左侧边栏历史卡片恢复 2 行截断。** 修复之前误将左侧卡片提示词取消截断导致长文本撑高卡片、
  破坏列表平衡的问题；左侧 `.historyPrompt` 恢复 `-webkit-line-clamp: 2` 与省略号展示。
- **右侧大图上方提示词独立完整展示。** 真正需要看完整提示词的大图顶部区域增加 `.canvasPromptLine`，
  支持多行换行（`white-space: pre-wrap`）与文本选择（`user-select: text`），图文与视频生成视图均生效。
- **验证**：`tsc` 0 错、`smoke.mjs` 全套通过、反向测试覆盖左侧截断与右侧换行断言。

### 1.19.0 — Seedream 水印开关与技能目录隔离

- **合并上游 v1.10.0 的 Seedream 水印开关。** 渠道配置新增「图片添加「AI 生成」水印」
  开关，关闭后向火山方舟 / BytePlus 官方 Seedream 模型透传 `watermark: false`，
  去除右下角水印；非官方兼容网关不发送该字段以防 400。覆盖文生图与图生图两条路径，
  提供中、英、俄三语设置文案与合规提示。
- **支持环境变量 `DSH_SKILLS_HOME` 隔离技能根目录。** 允许测试套件与自动化探针通过
  环境变量重定向本地技能库，避免安装或卸载操作影响宿主真实 `~/.dsh/skills` 数据。
- **验证**：`tsc` 0 错、全套离线冒烟及单元测试通过（包含 B7b/B7c 水印透传测试、
  E1 设置保存测试及 C12 环境变量解析优先级测试）。

### 1.18.0 — PPT 转换进度、会话归属与侧栏稳定性

- **PPT 任务记录改为不可变快照。** 旧写法是写 `.tmp` 再 rename 覆盖同一个 JSON，
  在 Windows 上会撞上目标文件被占用（EPERM / 共享冲突）而让整次转换失败。现在每次
  写入落一个独立文件，读取取版本号最大的完整快照，残缺文件跳过；旧格式
  `skillrun-<id>.json` 仍能读出，只是不再被覆盖。同一任务的写入串行化。
- **保存历史出错不再中断已启动的转换。** 转换错误与「历史没存上」分开表达：
  后者只在结果区挂提示，成功的 PPT 不会因为写盘失败被改判成失败；历史目录读不出来时，
  当前进程里活跃的转换仍然可见、可预览、可下载。
- **右侧新增真实执行进度。** 当前操作、最近活动时间、页级校验状态、执行记录；
  页数只来自上游 `page_jobs.json` 的实际校验记录，没有按时间估算的百分比。
  长时间无新事件时如实说明可能仍在运行，不宣称卡死也不宣称完成。
- **生图结果加入对话前先确认真实当前会话。** 取不到宿主当前选择时弹出会话选择器，
  由用户明确指定，不再按列表顺序自动挑历史会话；选择器不预选、提交前重新核对。
- **一个文档只保留一棵生图 UI 树。** 宿主重复应用客户端时释放旧树的 portal 与设置订阅，
  侧栏不再出现多个历史面板；侧栏历史宿主补上不透明底色兜底。
- **验证**：`tsc` 0 错、`tsdown` 通过、全量 `pnpm test` EXIT=0 零 FAIL、0 skipped、
  `UI CONTRACTS VERIFIED`。新增 `C11ppt-progress`、`C11ppt-store` 与 `conversation-sync`
  四个单测；反向验证确认快照串行化断言有判别力。
- **已知缺口**：`page_jobs.json` / `run_state.json` 的真实落盘位置未实跑确认；
  未在 DSH Web / Windows Desktop / macOS Desktop 宿主中实机验证。

### 1.17.2 — Windows 上 ffmpeg 找得到、失败不再被记成通过、视频任务重启不丢

- **修 Windows 上所有 ffmpeg 能力不可用。** 「本机找不到 ffmpeg」但
  `where ffmpeg` 有输出——因为同一个问题有四份独立实现，没有一份能在
  Windows 上成立：候选目录只列 POSIX 路径且从不查 PATH（而 winget / scoop /
  官方 zip 全靠加 PATH 安装）、`path.join(dir, 'ffmpeg')` 匹配不到
  `ffmpeg.exe`、`X_OK` 在 Windows 上无意义。现在收敛成一个入口，
  `locateFfmpeg()` 只剩 `return findTool('ffmpeg')`，两个测试脚本也改用宿主
  自己的查找。`FFMPEG_PATH`/`FFPROBE_PATH` 由共享查找处理，「填了路径只修好
  一半功能」不再出现。
- **修「缺工具的用例被记成 PASS」。** `smoke-code-render` 用 `return` 静默跳过，
  而 `check()` 把正常返回记 PASS，于是 C5（产出可播放 MP4）、C7（片段可拼接）
  在缺 ffmpeg 的机器上一直显示「通过」却一行没执行——这正是上一条能藏那么久的
  原因。三处改为 `skip()`（含顺带发现的 C4c：它原来在缺工具时反而**报红**），
  汇总固定打印 `N skipped: <名字列表>`。跳过仍退出 0。
- **修其余 10 处 Windows 假设。** `verify-tracked` 的路径分隔符（150 个文件全被
  判成未跟踪）、`pnpm` 的 `.cmd` shim、目录符号链接改 junction、
  `cpSync({recursive:true})` 静默退出 127、`URL.pathname` 当文件路径、
  `pnpm pack --ignore-scripts` 在 pnpm 10 已移除、tar/du 把盘符冒号当远程主机、
  `.bin/tsc` 在 Windows 是 POSIX 脚本、`findChrome()` 缺 Windows 候选、
  跨行正则与 CRLF 检出。CRLF 做了两层：读取处统一归一（`scripts/lib/source-text.mjs`）
  加 `.gitattributes`。
- **带上 v1.17.1 之后未发布的五条视频可靠性修复。** 重启后重连正在渲染的远端
  任务（不再重复提交和扣费）、取消只停本地并如实报 `unsupported`、工作流
  fail-fast 不再误杀独立分支、分镜 carry 重跑标脏下游、跨渠道模型别名歧义以
  显式 `channelId` 优先。
- **验证**：`tsc` 0 错、`tsdown` 通过、全量 `pnpm test` EXIT=0 零 FAIL
  （`16/16 code-render checks pass`、`0 skipped`、`UI CONTRACTS VERIFIED` 等）。
  Windows 规则靠 `platform`/`env`/`home` 可注入在 macOS 上验证 15 项断言；
  「跳过真的显示成 SKIP」用空 `HOME` 实测确认；新增三条反向用例均确认变红。
- **已知缺口**：Windows 上的行为未在真机实测，机理依据报告者实测的根因；
  `verify-native-ui` 的 DSH token 检查在 Windows 上仍跳过（宿主包在 `app.asar`）。

### 1.17.1 — 导航不重影、侧栏换座不丢、上限不再自相矛盾

- **修「点 A+ 详情页后导航栏出现两个标题」。** 根因在 `GooeyNav` 的
  `updateEffectPosition`：它用 `getBoundingClientRect()` 取 tab 的视口坐标，却
  拿去给一个 `overflow-x: auto` 容器里的子元素设 `left`。行不溢出时两套坐标
  相等，一旦容器横向滚动，装饰层和滑块就整体偏一个 `scrollLeft`，看上去每项
  都多印了一份。改成算 `left`/`top` 时加上 `container.scrollLeft`/`scrollTop`。
  只在窄于 ~1280px（导航真的溢出）时复现，宽窗口上看不见。
- **修一次点击扣两次费。** 「服饰穿戴」与「带货图文」的提交按钮同时带着
  `type="submit"` 和指向同一处理函数的 `onClick`，表单提交与点击各触发一次，
  一次点击发出两个 `/generate` 请求。去掉多余的 `onClick`，只留表单提交。
- **修侧栏切换器在别的插件抢走侧栏后消失。** `seatOf()` 用 `querySelector`
  取第一个锚点，而桌面外壳会先渲染一份 `display: none` 的移动端副本，取到的
  常常是没有盒子、没人看得见的那个。改为按文档顺序取第一个**真的在画**的锚点
  （`isVisible()` 一路向上查到 `body`）；「新建会话」行被隐藏时切换器退到栏首，
  靠 `data-dsh-imagegen-tabs-seat='top'` 补间距。
- **修空表单写着「参考图上限 0 张」。** `referenceCapacity()` 只返回 `usable`，
  而它同时取决于上限和已选数量，空表单时就是 0，拿来当「上限」显示等于自相
  矛盾。新增 `limit` 字段（单纯上限），空表单显示它；提交栏在没选图时改用自己的
  文案。
- **三个工作区重排。** 服饰穿戴、带货图文改为分区表单（字段分组带标题与说明）；
  平台选择从 `<select>` 换成四个 pill（当前值在打开前看不见，值与标签不变）；
  生成的文案落进可编辑输入框，复制按钮复制屏幕上的内容而非模型返回原文；空态
  改用自己的文案键，不再借用「生成结果 1」这类看起来像已有结果的字符串。
- **验证**：`tsc` 0 错、`tsdown` 通过、全量 `pnpm test` EXIT=0（245 行 `PASS`、
  0 `FAIL`、`UI CONTRACTS VERIFIED`）、native-UI 契约 PASS、`verify-reproducible`
  跨目录逐字节一致。导航漂移与双击提交都在真浏览器/真请求计数下验证，并各做了
  负向破坏（改回去必红）；另加静态规则「`<button type="submit">` 不许带
  `onClick`」。
- **已知缺口**：`scrollTop` 的同款换算保留了，但容器纵向不滚、恒为 0，没有负向
  对照能证明它必要——如实记在这里，不假装覆盖。

### 1.17.0 — 电商六件套、A+ 长图、带货图文，参考图按角色真传

- **参考图带角色真传。** 过去 `refRole` 只用来拼一句提示词，真正进 `image` 的
  永远只有第一张，其余静默丢弃。现在按角色筛出的图全部发送（`[primary,
  ...extras]` → `image` + `images`），角色扩为 `product / packaging / detail /
  style / layout`。上限写引擎的真实值 `EDIT_REFERENCE_LIMIT = 5`，grok 与
  nanobanana 只吃单张的事实在界面写明。
- **五个新工作区**（导航 6 → 9 项）：爆款图复刻、服饰穿戴（模特库落盘
  `~/.dsh/dsh-imagegen/models/`）、商品上架文案、带货图文（含商品链接抓取）、
  A+ 详情页（12 模块 + 导出长图）。
- **A+ 长图零新依赖。** 浏览器 `<canvas>` 绘制并导出，没引入 `sharp` /
  `node-canvas` / `puppeteer`，没用 `foreignObject`。`APLUS_MAX_HEIGHT = 16000`
  超限拒绝不截断；文案带高超过块高 40% 时先缩到 0.6 倍再拒绝，那一块保留图片。
- **商品套图补全。** 白底图合规只作用于主图（纯白 #FFFFFF、商品 ≥85%、强制
  `1:1`，界面写明比例被锁）；新增 `layout` 版式参考角色。
- **商品链接抓取是降级实现。** JSON-LD `Product`（含 `@graph`）优先、og 兜底，
  抓不到回退手填。SSRF 硬拦：只 http/https，私有段 / 回环 / 云元数据域名 /
  `169.254.169.254` / `.internal` / `.local` / 任何 IP 字面量 / 单标签主机名
  全拒，`redirect:'manual'` 最多 4 跳每跳重校验，8 秒超时，2 MiB 上限。
- **顺带修的既有缺陷**：820–1000px 下导航压住「展开右侧对话」（1.16.1 就有，
  点不到）；服饰穿戴上传 6 张只发 4 张的静默丢弃；模特库 `..` 路径逃逸；
  `smoke-canvas-video.mjs` 的 E1 flake 判据；A+ 文案带是不透明白盒子。
- **验证**：`tsc` 0 错、`tsdown` 通过、全量 `pnpm test` EXIT=0（630 行、5 段
  smoke 全绿、`UI CONTRACTS VERIFIED`）、native-UI 契约 PASS、152 源文件
  tracked、`verify-reproducible` 跨目录逐字节一致。新增断言全部做过负向破坏，
  改坏必红；长图与折行用真 Chromium 画 canvas 数像素，不靠 jsdom。
- **已知缺口**：A+ 预览里不叠字（只在导出的长图上出现，留 1.18）；Windows
  的折行未验证（PingFang 与微软雅黑度量不同）。

### 1.16.1 — 历史详情补全、两块结果板互斥、发布产物真正可重现

- **历史记录不显示生成参数，是前端从没渲染过。** 宿主从生成那一刻就把
  `prompt` / `size` / `quality` / `detail` 写进索引，`historyList` 一直原样
  返回，只是从 1.16.0 起结果板只画「本次生成 N 张」和时间。现在图片板与
  素材库的 `canvasMeta` 统一取自这条历史自己的 `viewingImageEntry`——不是
  表单里「下次要生成」的值；数量取 `images.length` 而不是条目上的 `n`，两者
  在「一张图生成失败」时会分叉。视频板补 `prompt` 与 `resolution`，i18n 只
  复用现成 key。
- **两块结果板的条件互不排斥。** 视频板判 `kind === 'video'`，图片格判
  `images.length > 0`；生成完成时 `setImages(...)` 会把图片格重新长出来贴在
  视频下面。1.16.0 的第一次修法是「两个板面各加一个条件」，那正是成因。现在
  由 `resultSurfaceOf(boardView, viewingVideoEntry)`
  （`src/client/ImageGenPanel.tsx:2689`）单一派生四种状态，两个板面只读它，
  `switch` 穷尽 + `assertNever`：以后加第五种状态编译期就报错。
- **`verify-reproducible.mjs` 只在同一目录构建两次**，所以「绝对路径进了 CSS
  Module 类名哈希」它永远看不见。`tsdown.config.ts` 改用仓库相对路径
  （`cssRepoPath()`，`:60-66`）；检查改为在另一个目录再构建一次，逐字节比对
  `lib/` 下全部 5 个产物（此前漏了同样随包发布的 `client.js.map`），
  `BUILD_INPUTS` 补上 `tsconfig.json`——tsdown 自己不读它，rolldown 读，改一条
  `target` 就能让产物变字节。四种破坏（绝对路径 / 只让 `.map` 依赖 cwd /
  删掉 tsconfig 输入 / 恢复）逐条确认会红。
- **参数行换行。** `.canvasMeta` 加 `flex-wrap: wrap` 与 `row-gap: 4px`
  （必须写在 `gap` 之后，简写会覆盖它）。1440px 下短提示词与改前逐像素一致；
  真实数据里那条 2257 字符的提示词改前在 1440px 下会被压成「本次生成 3 张」
  每行一个字，这一版顺带修好。
- **验证**：`tsc --noEmit` / `pnpm build` / `verify-native-ui.mjs` /
  `pnpm test` 全 EXIT=0；真 Chrome 断言 42 PASS（改前 14 FAIL）。
- **已知未做**：`smoke-canvas-video.mjs` 的 E1 是既有 flake（未改动树上同样偶发
  失败）；CI 的 apt 超时未修；契约守卫两处盲区（选择器语法校验、`token-must-exist`
  对带 fallback 的报错文案）未补；三处 `HEAD` 写死 `5px` 的按钮未统一。

### 1.16.0 — 视频历史有封面了，侧栏不再猜宿主的类名

- **视频历史此前没有封面，这是设计遗漏。** The host never generated a poster
  frame when saving a clip, and `poster` was only populated when the upstream
  happened to return `last_frame_url` — so every row rendered the same film
  glyph. New `src/video-poster.ts` + `src/video-tools.ts` extract a frame with
  the local ffmpeg at 10% of the duration (frame 0 is routinely a black frame
  or a transition), scale it to 320px wide, and store it as
  `<clip名>-poster.jpg`. `src/video-store.ts` gains `StoredVideoFile.posterFile`
  and serves it through the existing `poster` field, so
  `VideoHistoryFile.poster` keeps its meaning — an upstream URL or a same-origin
  host-extracted one, either way just an `<img src>`.
- **老记录惰性回填，且这一次请求内做完。** Three defects stacked here:
  `BACKFILL_BATCH = 3` left the rest to "the next request"; the panel's
  `initialDataRequestedRef` let `loadInitialData()` run only once per panel
  lifetime on HEAD, so that request never came; and one unreadable clip blocked
  the head of the queue forever. Now `drainVideoPosters()` empties the backlog
  within the request, `posterFailures` (`src/video-store.ts:348`) remembers
  clips that fail so they cost one slot instead of all of them, and the drain's
  fixed point is `attempted === 0` rather than `filled === 0` — a batch whose
  three slots were all unreadable clips fills nothing yet must not stop the
  drain. `src/routes.ts:2501` keeps the drain unawaited but adds the `.catch`
  an unawaited rejection needs: the host's fail-loud handler would otherwise
  turn one unwritable index into `proc.exit(1)`.
- **侧栏插件条目不再猜宿主的 class 名。** `sidebar-entry.ts` matched
  `[class*="logoRow"]`-style guesses; the host re-hashes CSS Module class names
  every release, and a selector that stops matching fails silently — the entry
  simply disappears. It now reads the slot anchors the host writes into the DOM
  (`[data-slot="sidebar.workspaces"]`, `sidebar.brand.mark`/`.name`,
  `sidebar.footer.action`, `sidebar.settings`), which are a contract rather than
  a build artifact. The middle-column takeover moves the same way:
  `MAIN_SLOT_ANCHOR = '[data-slot="main"]'` plus `boxAncestor()`, which skips
  the `display: contents` anchor itself for the ancestor that actually paints a
  box.
- **主题切换不再读 OS 偏好。** `surface-theme.ts` watched
  `prefers-color-scheme`, but DSH resolves `system` itself and writes the answer
  onto `body[data-ds-dark-theme]` — the media query was a second source of truth
  that could disagree with the palette actually painted, leaving nav text
  unreadable after a switch. It now observes only the attributes the host
  writes.
- **拖拽监听不再泄漏。** The chat divider's drag bound three window listeners
  and `cursor`/`user-select` on `<html>` that nothing released after the element
  was destroyed. `stopResizerDragWatch` is now held and released by the mount
  lifetime.
- **「看起来像原生」变成可检查的规则。** New `docs/native-ui-contract.md`
  (319 lines) plus `scripts/verify-native-ui.mjs` (347 lines) enforcing eight
  rules — literal colors, literal shadows, hardcoded radii, off-scale font
  sizes, `prefers-color-scheme`, tokens DSH does not define, `[class*=]`
  guessing, and theme read from the DOM. Wired into `pnpm test` after
  `verify-reproducible`. 18 `*.module.css` files under `src/client/` were
  migrated onto the tokens.
- **`pnpm studio:preview`** builds the whole panel into a single-file preview
  bundle and shoots light and dark states in a real Chrome with five in-page
  audits. The 6MB artifact is gitignored.
- **Dependency:** `@deepseek-ai/dsh-client-ui-primitives`
  `0.1.2-alpha.2` → `0.2.1-rc.2` (the version the host actually ships; the old
  one hardcoded 14px/18px radii where the new one uses
  `var(--dsw-radius-md)`/`var(--dsw-radius-sm)`), plus the `0.2.1-rc.2` dev
  dependencies it needs at pack time — `primitives@0.2.1` ships an empty
  `dependencies` and degrades to unresolved globals if they are not declared.
- **Cost, stated plainly:** the video row's thumbnail box goes from 54×54 to
  52×52. `.historyThumbPlaceholder[data-video-thumb]` has had a 1px border since
  HEAD, but `.panel *`'s `box-sizing: border-box` cannot reach it (the history
  list is portalled into the sidebar host, outside the `.panel` subtree, and the
  host ships no universal reset) — so 54×54 was the measured size all along.
  Adding the rule makes clip rows match image rows; the net effect is that
  video rows are 2px smaller. `.pptBadge` contrast goes 2.79:1 → 5.53:1.
- Full detail, including the end-to-end measurement that the first listing is
  always 0/10 covered and only the client's follow-up read makes the posters
  appear, is in `docs/releases/v1.16.0.md`.

### 1.15.3 — 视频工作室不再是死路

- **生视频标签页此前无法返回生图。** The shell hides the image config sidebar
  on the video tab (two composers must never be shown at once), and that sidebar
  is the only place the text/edit/video pills are rendered — so the tab had no
  return control anywhere on screen, and leaving meant reloading or detouring
  through the gallery. `VideoPanel` now takes an optional `onExit` and renders a
  "← 返回生图" button at the head of its own toolbar. The button is defined once
  and shared by both return branches, including the no-model branch, which is the
  screen that most needs an exit.
- **"普通生图" in the top nav did nothing while the video tab was open.** The
  video tab maps onto workspace index 0, the same index 普通生图 occupies, and
  `GooeyNav.select()` returned early on `index === activeIndex` — swallowing the
  callback along with the burst animation it meant to skip. The short-circuit now
  gates only the animation; `onSelect` fires unconditionally. Click and keyboard
  share that function, so both paths are fixed.
- **`video.back` ships in zh / en / ru.**
- Full detail, including the verification that this was never observable through
  the existing guards and the one change that was measured and then reverted, is
  in `docs/releases/v1.15.3.md`.

### 1.15.2 — 视频取片支持 `/content` 回退

- **A finished task with no URL in its body is now downloaded instead of
  failed (#9).** OpenAI's video API — and the OpenAI-compatible relays that
  copy it — report `status: "completed"` with no `url` anywhere and serve the
  bytes only from `GET /videos/{id}/content`. `readPoll()` treated that body as
  "completed but no video address" and failed a render the provider had already
  finished. The poll now reports the content endpoint as the clip source, and
  the download leg fetches it unchanged — same-origin key forwarding, MIME
  inference and the size cap all still apply. A body URL is still preferred,
  and a `/content` that 404s reports the download leg rather than passing as a
  silent success.
- **A batch of UI fixes ships in the same version.** Eight modules were driven
  in a real browser: a fully covered canvas node now marks both nodes and
  carries a `role="status"` badge naming what covers it (the hint survives
  pointer-up, when the node is still hidden); the sixty error/warning
  declarations that referenced `--dsw-alias-label-error` / `-warning` — which
  the dsh theme never defines — now use the resolvable
  `--dsw-alias-state-error-primary` / `-state-warn-primary`; the ecommerce
  section title no longer shrinks to 69px against a hint needing 70 (no column
  width changed); saving, channel tests, update checks and diagnostics clearing
  report what actually happened instead of reading as successes; dialogs trap
  and restore focus, and the select exposes combobox semantics with
  `aria-activedescendant`; PPT setup reports per-step state. Full detail in
  `docs/releases/v1.15.2.md`.

### 1.15.1 — 火山适配的收口修复

- **Ark pixel sizes stay inside the budget.** At 4K / 16:9 the solved
  `2866x1612` rounds up to 16,779,264 pixels, 2048 over the 4096² ceiling, and
  the provider rejects it. The height is now scanned near the target for an
  even pair that is both legal and nearest the requested ratio, with a scale
  fallback when none exists. lite and 4.5 also get their own tier floor
  (`2560x1440`, not 5.0 pro's `1280x720`), so 1K stops being refused there.
- **Capabilities are read from the upstream id, not the alias.** A channel can
  map `seedance-hd` to `doubao-seedance-2-0-fast-260128`, and the 720p ceiling
  belongs to the latter. Both the engine and the panel described the alias, so
  the panel offered 1080P and the submit got a 400. `resolveVideoModelId`
  resolves the id first; the resolution fallback also stops collapsing 1080P to
  480P (it now picks the highest tier at or below the request).
- **The `ep-…` claim was wrong** and is corrected in the README, the preset
  hint and the release notes: the family comes from the model id prefix, so an
  inference endpoint is refused before submit instead of being sent a
  malformed body.
- **A `renderer: code` submit no longer demands a channel.** Code rendering
  needs no image/video channel, but both submit routes validated one and
  refused the request before rendering started.
- **Code detection no longer uses a method whitelist.** A model writing
  `ctx.fillRect(...)` — a method this renderer does not have — had the whole
  answer filed as prose and silently replaced with the fallback title card,
  hiding the actual problem. Any `ctx.<method>(` now counts as code and the
  executor reports `code-runtime` with the method name; a prose answer also
  quotes what the model said, so a refusal is distinguishable from a wrong API.

### 1.15.0 — Volcengine Ark, properly

- **Seedream gets the real Ark contract.** The official ids
  (`doubao-seedream-5-0-pro-260628` and friends) have no `aspect_ratio`
  parameter at all, and their `size` is EITHER a tier (`1K`/`1.5K`/`2K`/`3K`/
  `4K`) OR an explicit `WxH` — never both. Sending a bare tier therefore
  threw the panel's ratio away and a 16:9 request came back square or 1:1.
  Ark ids now receive explicit even dimensions solved from the chosen ratio
  inside that model's documented pixel budget (5.0 pro/flash cap at
  `2048x2048x1.1025`; 4.5 and 5.0 lite at `4096x4096`; 3.0 at `2048x2048`).
  `auto` still sends the tier string, which is Ark's "you choose" form.
- **The watermark is turned off explicitly.** Ark documents `watermark: true`
  as the default, so every Ark request used to come back with a visible
  "AI生成" stamp in the corner. Both the text-to-image and the edit request
  now send `watermark: false`. Gateway-shaped Seedream still sends
  `b64_json`; only the official Ark shape uses `response_format: 'url'`.
- **Seedance is a first-class video family.** `doubao-seedance-*` ids were
  being classified as the generic OpenAI-style video endpoint, which posted
  to `/videos` and never worked. They now speak Ark's own task contract:
  `POST /contents/generations/tasks`, poll
  `GET /contents/generations/tasks/{id}`, clip at `content.video_url`.
  The prompt and every reference ride in a `content` array — images carry a
  `role` of `first_frame` / `last_frame` / `reference_image` — the ratio field
  is `ratio`, resolution is lowercase, and duration is an integer.
- **Values are narrowed where the model would reject them.** Seedance 2.x
  accepts 4–15 seconds and 1.0 accepts 2–12; the `fast`/`mini` ids cap at
  720p and reject 1080p and 4k upstream, and 1.0 does not accept the
  `reference_image` role (`1.0 pro fast` also has no last frame). Requests are
  clamped to the window, degraded to the best tier the id does support (a
  1080P ask on a fast id becomes 720p, not 480p), and modes the id cannot
  express are dropped from the panel instead of being sent as a 400.
- **Silent by default, not by accident.** Seedream's `watermark` defaults to
  `true` (a visible "AI生成" stamp), so it is sent as `false`. On the video
  side `watermark` already defaults to `false` but is still sent explicitly,
  while `generate_audio` — which exists on 2.x and defaults to `true` — is
  sent as `false`; 1.0 ids do not receive the field at all, since they have no
  audio track to switch off.
- **One channel, both halves.** The built-in preset is now "字节 · 火山方舟
  （Seedream / Seedance）" with real model ids and a video catalog, so one
  Ark channel serves images and videos.
- **Offline coverage.** `B7` asserts the Ark pixel size stays inside the
  budget, keeps the ratio and is even, plus `watermark: false`; two new
  `smoke-video` cases cover the Seedance submit body, the poll path and
  `content.video_url`, and the duration/resolution narrowing.

### 1.14.0 — draw it in code, render it here

- **A second renderer, chosen per task.** The canvas composer now carries a
  *Rendering* select: **Model** (the historical path, unchanged and still the
  default) or **Code**. The choice belongs to the task being submitted — it is
  not a setting, not a global switch, and nothing is written to disk, so the
  next generation on the same canvas can use the other one.
- **No image or video provider involved.** In code mode the drawing program is
  written by the conversation model DSH already has (`ctx.agentDefaultModel`,
  mounted through the host's `agents` and `agentPresets` services) — not the
  plugin's prompt-enhancement endpoint — and rendered on this machine. One
  headless turn, no tools, no vendor SDK, no second credential.
- **Rendered, not prompted.** The returned JavaScript runs in a `node:vm`
  context with a drawing API and no `require`, `process` or filesystem; each
  frame is RGBA pixels handed to ffmpeg, or encoded straight to PNG. Nothing
  leaves the machine, so a code render costs no image/video quota.
- **Same pipeline, same slots.** A code result is submitted through the same
  `GenerateRequest` / `VideoGenerateRequest` (an extra `renderer: 'code'`),
  lands in the same `images/` and `videos/` directories and the same history
  stores, and is therefore stitchable, timeline-cuttable, transitionable,
  favouritable and re-framable exactly like a model result. Resolution,
  aspect and duration come from the same composer controls; frames =
  duration × 30 fps.
- **Failures are named and recoverable.** `code-prompt-empty`,
  `code-prompt-too-long`, `code-no-chat-model`, `code-chat-failed`,
  `code-not-code`, `code-syntax`, `code-runtime`, `render-timeout`,
  `render-no-ffmpeg`, `render-cancelled`, `render-encoder-died`,
  `render-encoder-failed`, `render-empty`. The node shows the host's own
  message plus a hint to switch back to Model and retry; a missing ffmpeg is
  warned about in the composer *before* submitting (`POST /code/probe`).
- **A non-code answer still produces something.** If the model replies with
  prose instead of a program, the render falls back to a built-in title card
  and the task is marked `degraded` with the reason — a wasted render is worse
  than a plain one.
- **Retry replays the program.** The generated source is kept on the task, so
  retrying a failed *render* does not ask the model again; generating again
  does.
- **No new dependency.** `node:vm`, hand-written PNG encoding and the existing
  `locateFfmpeg()` / `clip-compose.ts` path — ffmpeg remains the only external
  tool, needed for code videos only.

### 1.13.0 — the video is directed before it is rendered

- **A planning step before every render.** With the studio's new *Plan first*
  switch on (the default), a one-line request is no longer forwarded verbatim.
  A reasoning pass splits it into shots, subject motion, camera work, duration
  and style, and produces the prompt and parameters the provider actually
  receives. The finished task, its queue summary and the history entry all
  carry the plan, so a clip can be explained later without re-running anything.
- **The plan is the request.** The planned prompt replaces the typed one, and
  the planned duration / aspect / resolution replace the panel's values. A plan
  may only NARROW them: a model asking for 30s when the user chose 5s gets 5s,
  and a frame the family cannot render (4:3 on comemoe) is overruled. A
  previewed plan that arrives back over the wire is re-clamped before use.
- **Preview before you pay for a render.** `POST /video/plan` runs the same
  planning code with no submit, and the studio's *Preview plan* button shows
  the shots and parameters. Submitting afterwards adopts that exact plan
  instead of asking the chat model again, so what was previewed is what gets
  rendered.
- **Planning degrades, it does not disappear.** No chat model configured, an
  unreachable endpoint, a timeout, or an answer that is not the agreed JSON all
  fall back to an offline shot planner. The plan is marked `degraded` with the
  reason, shown in the panel and recorded under the new `video-plan`
  diagnostics phase — the raw sentence is never silently submitted.
- **Inputs are bounded.** An empty prompt is refused with `video-prompt-empty`
  and one over 4000 characters with `video-prompt-too-long`, both before any
  submit. A planned prompt is capped at 900 characters.
- **Prompt structure follows Wan 2.2.** The shot skeleton (style → shot size and
  lighting → per-shot subject, motion and camera; motion over static scene for
  image-bearing modes) is the one Wan's own Apache-2.0 `--use_prompt_extend`
  guide teaches, which is the reference implementation behind the `wan2.2-*`
  family this plugin routes.
- **No new credential.** Planning reuses the existing prompt-enhancement chat
  endpoint (`promptModel` / `promptApiUrl` / `promptApiKey`); blank values reuse
  the image channel. `pnpm test:director` covers all of the above offline, and
  an end-to-end run against a real channel was verified: the planning model
  produced the shot list and the provider rendered from it.

### 1.12.0 — cut, join, and keep the same face

- **A timeline editor on the canvas.** The dock's new film button lines the
  finished clips up in canvas reading order, then lets them be reordered,
  trimmed (in/out point per clip) and joined with a transition. The result is
  still an ordinary video node, so preview / download / favorite / retry keep
  working on it.
- **Trims are clamped to the clip.** An out point past the end of the material
  is the material's own length, never a read past the last frame; a transition
  is clamped to half of the shorter clip beside it at *calculation* time, so
  xfade never receives an offset longer than its input.
- **Real transitions in ffmpeg.** Hard cuts keep the single `concat` pass; any
  fade/dissolve switches to a chained `xfade`/`acrossfade` graph with a unified
  time base on both sides. Audio is optional — turning it off omits the audio
  chain entirely instead of mapping a silent one.
- **The editor's total matches the file.** Both sides read
  `timeline.ts`, so the length shown in the panel is the length that gets
  written. `pnpm test:timeline` checks the rules offline and
  `pnpm test:timeline-compose` runs four real ffmpeg renders and measures them.
- **Identity anchoring.** Any image node can be pinned as a character, item or
  style with a name. Pinned nodes join every later image and video generation
  as references automatically, and the prompt gains one sentence saying which
  reference is whom. Connecting a node still wins for *this* run; the pin is the
  film's standing definition and is de-duplicated against it (one image sent
  once, one name sent once).
- **A pin that only exists on screen is a bug, not a feature.** The pin lives in
  `metadata.cast` on the node, so it survives a reload and every later run reads
  the same definition — change the face by re-shooting that one node.
- **Video mode upgrades rather than degrades.** With nothing wired but a
  character pinned, an `auto` video run becomes reference-mode instead of
  quietly falling back to text-to-video.

### 1.11.0 — the canvas runs the whole chain, not one node

- **A workflow run.** The dock's new branch button walks the graph downstream
  from the selection (or from every unfinished node when nothing is selected)
  and runs the whole chain: nodes with no remaining dependency start together,
  the next layer waits for the previous one, and finished nodes are reused
  rather than generated twice.
- **Failures stop the chain where they happen.** One node failing ends the run
  and names the node, instead of submitting a downstream wave that would fail
  for lack of input and read like a broken app.
- **A cycle is refused before anything is submitted.** Self-loops count as
  cycles: a node wired to itself would wait for its own product forever.
- **A running node is adopted, not resubmitted.** Re-running a chain no longer
  pays twice for work already in flight.
- **Progress and stop.** A bar reports the current layer and how many nodes are
  done; stopping ends the chain at the next layer boundary while tasks already
  submitted finish on their own.
- The scheduling rules are pure functions (`workflow-graph.ts`) and the run loop
  is engine-free (`workflow-runner.ts`), so `pnpm test:workflow` exercises them
  offline.

### 1.10.0 — storyboards: a shot list that runs into clip nodes

- **A storyboard node.** One board is a list of shots — a prompt and a length
  each, reorderable, renamable by moving — and every shot produces an ORDINARY
  video node on the canvas. That is the whole design: because the result is the
  same node type as a hand-made clip, it is previewable, downloadable,
  favoritable, retryable and stitchable with no second workflow to learn.
- **Two kinds of continuity.** The independent mode submits every shot that has
  no clip in one press; the carry mode submits one shot at a time, using the
  previous shot's last frame as this shot's first frame, so consecutive shots
  join up. A carry shot is blocked — with a visible state, not a silent refusal
  — until its predecessor has a clip.
- **The tail frame is reusable on its own.** Any finished clip offers a
  continue-from-tail action: it grabs the closing frame, drops it as an image
  node, and wires it into a fresh video config, ready to type the next shot's
  direction into.
- **The board stitches through the existing compose run.** Once two shots have
  clips, the board's stitch action hands them to the same ffmpeg path, with the
  same numbered order review; a shot still rendering is left out and the
  shortfall is said out loud instead of being submitted as a run that would
  fail.
- **State survives a reload.** The shot list, the shared settings and each
  shot's link to its clip node are part of the canvas document; a board whose
  stored state cannot be honoured fails the save loudly rather than being
  written half-valid. Every row's state is read from its clip node, so the board
  and the canvas can never disagree about what is finished.
- **Editing goes through the document**, so undo, redo and autosave work on a
  board exactly as they do on a text node.

### 1.9.3 — session images, PPT delivery, and xAI Grok video

Upstream 1.9.1 + 1.9.2 landed here, alongside this repository's own fixes.

- **A host Agent failure is reported as itself.** Model and execution errors are
  kept (and redacted) instead of surfacing as "no final PPTX was produced";
  a run with no reply points at the default-model connection and tool setup.
- **The upstream skill's own `final/` deck is collected.** Only a run summary
  marked complete with a passed validation report qualifies, and the deck is
  still checked for PPTX structure and page count — an intermediate page file
  never becomes the result.
- **PPT configuration opens in place.** The dialog reuses the generation
  settings' own fields rather than reaching for the host settings button by DOM
  lookup, with Escape, focus containment and return-to-trigger.
- **Uploads become a thumbnail grid** with an add tile: preview, reorder, delete,
  and the order is the slide order.
- **The result pane shows only the final PPTX**, auto-opened: left column for
  sources and options, right for the deck with page thumbnails, previous/next,
  expand and download. Narrow screens go single-column with the source list
  scrolling on its own. A task diagnostic entry exports the run's identifiers,
  a failed preview can be retried, and the download survives the error.
- **Conversation tool results show their images again.** The renderer reads DSH's
  persisted result metadata, so text-to-image, image-to-image and task-query
  results all display thumbnails and open the original; older sessions keep
  working through their image content blocks and JSON references, and a repeated
  attachment appears once. Images stay UI data — what the model receives is
  still text.
- **`format v4 message requires a producer-owned source kind` is fixed.** A PPT
  run's first message carries `plugin:dsh-imagegen` instead of the v4-rejected
  plugin wrapper; cast-heavy canvas skills share the fix.
- **Grok video speaks xAI's own contract.** A new `xai` family submits to
  `/v1/videos/generations` and reads `request_id`, polls
  `/v1/videos/{request_id}` for `video.url` / `video.duration`, and reports
  `failed` and `expired` as failures. The body sends a numeric `duration`, a
  lowercase `resolution` and `image: { url }`. The `xai-grok` preset ships
  `grok-imagine-video-1.5` and `-lite`.
- **The narrow centre column stays usable.** Below 760px the conversation row
  sizes to its content, the studio scrolls as a whole, and the config column no
  longer stretches the layout — the generate button and the canvas stay reachable.
- **Desktop updates run through the launcher's install hook** and verify what it
  actually reports: installed bundle, version, exit code and error code are each
  checked, and an unverifiable result fails rather than claiming success.

### 1.9.0 — images to an editable PPTX

A standalone conversion workspace, reached from any finished image.

- **A PPT workspace of its own.** Upload PNG / JPG / WebP — up to 12, 20 MB each —
  reorder or remove the thumbnails (the order is the slide order), and convert.
  The run reports its real state: running, cancellable, done with a download, or
  failed; the inputs stay put so a deck can be converted again.
- **Every result can start a conversion.** Text-to-image, image-to-image,
  the multi-model comparison cards and the full-screen preview each gained a
  "make an editable PPT" action that carries the image into the workspace.
- **A PPT section in the settings card.** Install or update the official skill,
  install and check the isolated `editppt` Python environment, configure the
  image API and an optional PaddleOCR token. Keys go through the existing
  redacted secret storage and never enter the task prompt.
- **OCR is a choice, not a requirement.** PaddleOCR, or the offline text
  detection that ships with the conversion.
- **A conversion that produced nothing is reported as failed.** No final PPTX, an
  invalid ZIP, or a page-count mismatch all fail loudly; a task interrupted by a
  host restart shows as interrupted and can be started again.
- **PPT routes validate before they run.** The client sends asset ids only and the
  host rebuilds the URL, so a caller cannot point the conversion at an arbitrary
  address; image count, asset-id syntax and the OCR flag are checked up front,
  and the refusal names what is missing. Covered by `C6c4`.
- **The nav scrolls on a phone.** At ≤760px the top nav scrolls horizontally
  instead of pushing entries off-screen, and settings summaries wrap.

Prerequisites: Python 3.10+, a configured default model, skills and long tasks
enabled, and an Agent preset with file and command tools. Multi-page runs use the
skill's own page tasks, which need sub-agent support in the preset.

### 1.8.0 — multi-reference editing, a template drawer, and honest wait states

Four capabilities: multi-reference editing, a template drawer, wait states that
show they are waiting, and results that are no longer cropped.

- **Image editing takes up to five reference images.** The first stays in
  `image` and the rest travel in `images`, so a single-reference provider still
  sees exactly one image and every existing request shape is unchanged. The
  engine half of this was already present; what was missing was the panel: the
  form held one `refImage`, so the protocol could
  never be reached from the UI. It now holds a list, with multi-select, drag,
  paste, per-image removal, a preview with arrow-key paging, and the documented
  limits (5 images, 10 MiB each, 16 MiB total) enforced in one place
  (`reference-images.ts`) rather than in each entry point.
  A model whose adapter takes only one reference is refused **before** submit
  with the count it does support, instead of sending a request the upstream
  would silently trim; in compare mode the strictest target wins.
- **The template library is a drawer, not a centred modal.** It docks to the
  right edge at ~75% of the workspace, remembers its width in `localStorage`,
  can be dragged from its left edge or expanded to the full workspace, goes
  full-width on phones, searches across every library, and keeps the last 24
  used templates for one-click reuse. A picked prompt can replace the composer
  text or be appended to it. Two things were kept on purpose:
  `favorites: null` still means "not loaded yet" (so a failed read shows an
  unknown star and a retry, not a wall of un-favourited cards), and the shared
  roving-tabindex helper still walks the source tabs.
- **Waiting looks like waiting.** A bounded SVG dot field (475 dots, 130 in the
  compact variant) driven purely by CSS `animation-delay` — no timers, no React
  updates — replaces the single spinner. In a multi-model comparison each card
  gets its own field and its **own** elapsed time from that task's `startedAt`,
  so four models no longer share one misleading clock. Failures and cancellations
  stop only their own card; `prefers-reduced-motion` drops the animation.
- **Results are no longer cropped.** The result grid switched from `cover` to
  `contain` with a zero-basis flex so a tall or wide image fits the space it has
  instead of having its edges cut off. The ecommerce cards keep their `cover`
  override — that rule is what stops a product shot from being letterboxed.

Two deliberate choices:

- **Desktop updates still explain themselves.** In-panel updates run when the
  host exposes an install hook, and otherwise show an explanation rather than a
  bare hint. `updateInstallTarget()` reports
  `cli` / `host` / `host-managed`, and the `host` path installs the exact Release
  tarball through the host and then verifies `application`, exit code, bundle
  name and version, falling back to the installed manifest when an older host
  omits the version (an unverifiable install is a failure, never a success) —
  and `ManualUpdateRequiredError` stays for the managed case, because the panel
  renders a copyable command from `details.tarballUrl` and a one-line hint would
  lose that.
- **One primary label in the template detail view.** The button does not get
  renamed to "Replace" once the composer holds text. It says "Use this prompt" in both
  cases and adds a separate "Add" button only when there is something to append
  to, so the primary action never changes meaning under the user.

One gate added after 1.8.0 shipped:

- **A version bump without its notes is now a failure.** This release reached
  the Release page without `docs/releases/v1.8.0.md`, so `release.yml` fell back
  to GitHub's auto-generated "Full Changelog: <compare link>" line — a ::warning
  in a log nobody reads — and the tag froze that one-line page the moment it was
  created. `verify-pack.mjs` now requires `docs/releases/v<version>.md` to exist
  and to be inside the archive (it is in `files`), which runs in CI before
  anything is packed. Two negative cases prove the assertion: bumping `version`
  with no notes file, and dropping `docs/releases` from `files`.

### 1.7.8 — the manifest stops claiming a package the host already provides

One packaging correction, no behaviour change.

- **`@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies`.**
  It is not an implementation detail of this plugin — its `z` builds the config
  schema the host validates — so the host's own copy is the one that must be
  used. Declaring it as a dependency made every install pull a second copy of a
  `@deepseek-ai/*` package alongside the host's, which is both the wrong
  ownership relationship and the thing plugin directories list as a rule.
  `devDependencies` still carries it, so local builds, typecheck and the whole
  offline suite resolve it exactly as before; only the published manifest
  changes. Verified by installing the packed tarball into an isolated
  `DSH_HOME`: the profile pulls two packages instead of three (no second
  schemastery), resolves the host's own 3.18.4, and `lib/index.js` imports
  cleanly (132 exports, `CURRENT_VERSION` 1.7.8).

### 1.7.7 — deleting becomes undoable, the poster editor arrives, and the update chain stops lying

Three user-visible failures and one new feature, plus the release process itself
moving onto a machine that runs the gates.

- **Deleting a gallery entry no longer destroys its bytes.** Removal was an
  unlink, so every history row and canvas node still holding that URL turned
  into a broken image, and there was no way back. It is now a soft delete: the
  entry is flagged `deletedAt` and listed as trash, the files stay put, and only
  `purgeGallery` (or the retention sweep) unlinks. The retention window is
  `GALLERY_TRASH_RETENTION_MS` = 30 days, enforced lazily inside `mutateGallery`
  — no timer, nothing to shut down, and a process that is never opened again
  still gets its cleanup on the first store call of the next one. Re-adding an
  image whose old copy is in the trash produces a visible entry, not a silent
  no-op. The panel's trash section was also covered by nothing: the fixture fed
  it rows and no check ever looked at them, so the toggle, the per-row restore id
  and the purge confirmation's count could all have broken silently. Each has a
  check now, and the section stopped printing its own count heading directly
  under the toggle that already says it.
- **The poster editor is new.** Text and logo layers are
  composited over an image node locally with Canvas 2D — no model call, no
  quota. Saving uploads the flattened bitmap as a new image node and stores the
  recipe in that node's `metadata.poster` (the new node is wired to its source),
  so reopening the result restores every layer instead of flattening the work
  into a picture. The source image is never rewritten. `Ctrl+Z`/`Delete` inside
  the modal act on poster layers and never on the canvas beneath it.
  The asset sweep counts those recipe references too: a poster node only stores
  the flattened composite in `metadata.asset`, while its background and logo
  layers live in `metadata.poster` and are re-read by the editor. Collecting
  only `metadata.asset` meant the first canvas a user deleted removed the base
  image behind every poster they had made, and reopening one drew the layers
  over an empty stage.
- **The update chain reports what actually happened.** `profileFromProcess`
  resolves the profile from `DSH_PROFILE`, then `--profile`, then a
  `profiles/<name>` path segment in argv, and only then falls back to `web`. The
  Electron host passes the profile as a bare *path* and sets neither of the
  other two, so the flag-only reading targeted the wrong profile for every
  Desktop user — even a successful update left the running host on the old
  plugin. DSH Desktop's profile is locked by the CLI — spawning it anyway
  produced a bare "update failed" with no cause — so that profile now throws
  `ManualUpdateRequiredError`
  (`update-manual-required`) carrying the archive URL, and the panel shows a
  copyable install command instead of a scary error. A failed spawn keeps the
  last three lines of the CLI's stderr (`STDERR_LIMIT` 4 000 chars) so a pnpm
  store mismatch or a locked directory is readable.
- **The canvas has a keyboard shortcut legend.** `?` or `F1` opens it, the dock
  gained an entry, `Esc` closes it above every other overlay, and the controls
  that have a shortcut now name it in their own tooltip ("撤销 (Ctrl+Z)"). The
  bindings live in one data table (`CANVAS_SHORTCUTS`) shared with the check that
  compares them against the key handler, so the legend cannot drift from the code
  it documents. `canvas.undo` / `canvas.redo` lost their hardcoded `(Ctrl+Z)`
  suffix in all three languages — the key text is derived from the table now.
  The layout is measured in a real browser at 1280×800 and 390px: the dialog
  has to fit the viewport (its body scrolls instead), no row may overflow its
  grid column, and the two-column grid has to collapse to one on a phone.
- **A malformed poster recipe is refused on the way in and on the way out.**
  `isPosterDocument()` is strict (`version === 1`, integer sides within 4096, a
  64-hex `assetId` with an image extension, `url` on the same-origin asset route,
  `type` not `kind`, unique ids, `#rrggbb` colours), and `isNode()` calls it, so
  a canvas save carrying a half-valid recipe fails loudly instead of throwing
  when the editor is reopened. A route-level test round-trips a valid one and
  refuses two corrupt shapes.
- **The browser suites stop fighting over a debugging port.** They guessed
  `9900 + random(300)`, and two runs (or a leftover browser) could land on the
  same port — the intermittent `Error: CDP down` that made `verify-ui-contracts`
  report 27/28. `scripts/lib/headless-chrome.mjs` launches with
  `--remote-debugging-port=0` and reads the port Chromium actually published
  from `DevToolsActivePort`, checks `exitCode`, keeps stderr for the error, and
  uses a fresh profile directory per launch. All three guards share it, and
  `verify-ui-contracts` now scans the other guards' sources for a guessed port,
  so nobody can reintroduce one without a red check.
- **The release is built by CI, not by hand.** `.github/workflows/release.yml`
  runs typecheck → build → ffmpeg → tests → verify-pack → `pnpm pack` →
  `SHA256SUMS` → tag → GitHub Release, and the tarball the Release advertises is
  the one the tests ran against (`--ignore-scripts` on the pack, so nothing
  rebuilds into different bytes). Re-running is idempotent: same tag, replaced
  assets, no duplicate Release. It never moves an existing tag. npm publishing is
  a separate job gated on a repository variable, and it probes for the package
  before the version — npm answers both "no such package" and "no such version"
  with E404, and only the second one is a normal publish.
- **The browser launcher had never been committed.** `.gitignore` carried an
  unanchored `lib/`, which matches `scripts/lib/` as well as the build output,
  so `scripts/lib/headless-chrome.mjs` was excluded from the repository from the
  day it was written. Three guard scripts import it: a clean clone died with
  `ERR_MODULE_NOT_FOUND` before any suite could run, while the author's tree
  stayed green because the file existed on exactly one disk. The first release
  workflow is what surfaced it — `pnpm test` failed before `verify-pack` ran and
  no tag was created. `.gitignore` now anchors the rule to `/lib/`, and
  `scripts/verify-tracked.mjs` runs as the first step of `pnpm test`: every
  relative import under `src/` and `scripts/` must name a file git tracks, and
  no source file may be sitting in the tree untracked.
- **The archive check only confirmed what somebody remembered to list.** 
  `verify-pack.mjs` required `lib/index.js` and one template snapshot, both
  hard-coded, and nothing compared them against what `package.json` tells a host
  to load. A `files` edit that drops `lib/`, or an `exports` target pointing at
  a renamed file, produced an archive that installs cleanly, boots cleanly, and
  does nothing at all: the host throws at import time or the browser half 404s,
  and neither error names packaging. The check now reads the manifest **inside**
  the tarball and requires `main`, every `exports` target and
  `dsh.bundle.patch` to actually be in it. Writing the case exposed a second
  problem in the harness itself: `freshCopy()` copied `lib` but not
  `cordis.patch.yml` or the other `files` entries, so the pack runner was
  inspecting an archive that could never satisfy a packaging rule — the copy is
  now built from the `files` list instead of a hand-kept one.
- **`test:negative` was not running every case it defines.** The `canvas-video`
  runner was added for the gallery soft-delete case but never appended to the
  `test:negative` chain, so the case passed when invoked by hand and was absent
  from the gate. The chain now includes it, and `verify-negative.mjs` refuses to
  run at all if any defined runner is missing from that command — a guard on the
  gate, since a case can only fail after its runner has been selected.
- **The build was not a function of the source tree.** Two builds of the same
  commit produced different `lib/client.js` bytes. `lightningcss` returns
  CSS-module exports from a native hash map, so the class names arrive in a
  different order on each process — five runs over one stylesheet produced five
  different first keys — and `tsdown.config.ts` serialised that map in iteration
  order. Object key order is invisible to every consumer of a CSS-module map,
  which is why nothing ever noticed; but it is byte-stable input to the release
  artifact, so `SHA256SUMS` could not be reproduced from source and "the Release
  ships the bytes the gates approved" was true only of the run that made them.
  The map is sorted at the one point where it becomes bytes, and
  `scripts/verify-reproducible.mjs` now builds twice on every `pnpm test` and
  requires all four artifacts to be byte-identical.
- **The npm job's "exactly one tarball" guard could not fail on zero.** Bash
  leaves an unmatched glob in the array as its own literal, so
  `packages=(dist/*.tgz)` against an empty `dist/` yielded count=1, the guard
  passed, and the next line asked npm to publish a file named `dist/*.tgz`. The
  job did fail — with `ENOENT`, which reads like an npm fault instead of "the
  artifact never arrived". `shopt -s nullglob` makes the count mean what it
  says, and the failure now prints `ls -la dist`.

### 1.7.6 — the template library grows to eight sources, and a parser bug that hid half of one

The template library was smaller than it said it was. A snapshot keyed each case
by its number alone, and the upstream reuses numbers across AND inside its
category files, so roughly a thousand cases were overwritten without a single
error. Fixing that, plus three newly found upstream collections that can be
included on their licences, takes the library from 5 sources / 2462 cases to
**8 sources / 3774 cases**.

- **evolink: 462 → 967 cases.** `cases/character.md` and `cases/portrait.md`
  both open at `### Case 1:` with images in different directories, and numbers
  repeat inside one file too, so keying a case by its number discarded the rest
  — about 1420 parseable prompts reduced to 462 with nothing to show for it. Ids
  are now category-scoped (`portrait-53`) and de-duplicated per file: 967 cases,
  zero duplicate ids. This is a repair, not an addition, which is why it is
  called out separately.
- **Three new sources, each pinned to an exact commit.** `itgoyo/awesome-gpt-image2-prompt`
  (602 cases, CC BY 4.0), `songtianlun/awesome-prompts` (55, MIT) and
  `youart-open-source/awesome-gpt-image-2-5-prompts` (150, layered licensing —
  see THIRD_PARTY_NOTICES.md). `ITGOYO_COMMIT`, `SONGTIANLUN_COMMIT` and
  `YOUART_COMMIT` fix the revision the build reads; the sources are deliberately
  not refreshable at runtime, so what was reviewed is what ships.
- **youart ships no images on purpose.** The corpus publishes none of its own;
  every row credits the person who wrote the prompt and the post where it first
  appeared. Those cards show the placeholder thumbnail and keep the full prompt,
  title and author link.
- **The source tab row scrolls.** Eight `nowrap` tabs in a plain flex box
  neither wrapped nor scrolled, so every source past the right edge was
  invisible, unclickable, and undiscoverable. The row now scrolls horizontally
  and the tabs do not shrink (shrinking truncates the label and its count badge
  instead). Verified in a real browser, not by reading the declarations.
- **Favorites for evolink cases do not carry over.** Favorites are keyed
  `sourceId:caseId`, and evolink's ids changed shape (`case-12` →
  `portrait-12`), so a star put on an evolink case in 1.7.5 will not resolve.
  No other source's ids changed. This is the unavoidable cost of fixing a
  collision that was silently discarding cases.
- **Six preview images from an unlicensed repository are gone.** `prompt-signal`
  carried six `image` URLs pointing at `songguoxs/gpt4o-image-prompts`, which
  declares no licence. The URLs are shipped data, so serving them is this
  project's call rather than the aggregator's: the field is now empty and those
  cards show the placeholder thumbnail. Their prompt text, title and link to the
  original author's own post all stay — the prompt was never the aggregator's,
  and the `githubUrl` attribution link is kept. Both the generator and the
  contract check guard this, so a regeneration that forgets the filter fails.
- **The installed archive is 4 MiB instead of 24 MiB.** `docs/images/` — the
  README screenshots, including a 13 MiB demo GIF — is never read at runtime and
  is rendered by GitHub from the repository. It is no longer in `files`, the way
  `docs/videos/` already was not. The archive rule now runs as
  `scripts/verify-pack.mjs` against a real `pnpm pack` in CI and in the negative
  verification, instead of as inline shell in the workflow.
- **"Detect models" no longer drops `nanobanana2` and `nanobanana2-lite`.**
  Both ship in `DEFAULT_IMAGE_MODELS`, and `describeModel()` recognises them,
  but `isLikelyImageModelId()` required a separator after the family keyword —
  `nanobanana2` has none between `nanobanana` and `2`. Against a gateway whose
  `/models` returns ids without capability metadata, the panel therefore listed
  two models fewer than the catalog declares. The predicate now accepts an
  optional digit run before the boundary (`flux2`, `wanx2` likewise);
  `gpt-4o` and `text-embedding-3-small` are still rejected. The smoke suite's
  detection check now serves both ids from its mock gateway, so reverting the
  regex turns it red.

### 1.7.5 — every UI module reviewed, and a failed call that can be explained

Two things: a full pass over the plugin's UI, driven by real defects rather than
taste (the theme no longer leaks into component internals, and the layer order is
written down in one place), and a failed call that can actually be explained —
including on the video chain, where a failed render had nowhere to be inspected.

- **The nav follows the host theme at runtime.** `GooeyNav` had its four colors
  baked in as literals and detected the surface only once, at mount. Switching
  light/dark while it was on screen left it painted for the old surface and
  unreadable against the new one. The palette now derives from the `--dsw-alias-*`
  tokens, and a new `surface-theme.ts` subscription re-derives it on the host
  attribute (including DSH's `data-ds-dark-theme`), on the OS preference, and on
  re-parenting. **`--dsw-alias-brand-primary` is a neutral inverse, not an
  accent** (near-white on light, near-black on dark) — it is used as one, and
  the annotation marker deliberately does not.
- **The annotation marker is one token, read by both sides.** The on-screen boxes
  were colored from CSS while the boxes burned into the image by Canvas2D were a
  `#ff2d55` literal, so the two could drift. Both now read
  `--canvas-annotation`. Because that token is declared on the canvas root
  class — not on `documentElement` — `themeColor()` takes an origin element and
  the caller passes the canvas root; reading it from the document root returns
  empty and silently falls back to the literal again.
- **One stacking scale, and it does not renumber what already worked.** Every
  z-index literal is gone from the module stylesheets in favor of a documented
  scale in `panel.module.css`. The numbers are the values the layers already
  had; only layers that genuinely *shared* a number were moved, and only as far
  as the existing comparisons required (1000 → 1000/1005/1010, 130 → 130/131/132,
  60 → 60/61/62, 70 → 70/72, 20 → 20/21). Those ties were real: the winner was
  decided by document order, so a harmless refactor could re-stack the UI. The
  guard is threefold — the doc table must match the declarations, 26 required
  orderings must hold, and the three rungs that interleave with the host shell
  are pinned by value — plus a real-browser check that renders two of the former
  ties in *reversed* order and requires the same winner.
- **Overlays no longer clear the canvas selection.** Every overlay (composer,
  menus, dialogs) is a sibling of the viewport, so a pointerdown on one never
  reached the viewport handler. This is now asserted structurally rather than by
  a guard that turned out to be dead code.
- **Touch pinch zooms the canvas.** Two touch pointers moving apart scale the
  view, the way a trackpad already did.
- **Keyboard fixes.** Space on a focused dock button activates the button again
  instead of being swallowed by the pan handler; Escape closes the in-canvas
  video preview, the skill menu, the polish dialog and the picker; a node's
  hidden hover toolbar leaves the tab order and is revealed by focus, so Tab no
  longer lands on invisible controls (including delete); every `role="tablist"`
  wired the shared roving-tabIndex and arrow-key contract.
- **Failures stop masquerading as empty lists.** History, gallery and template
  favorites showed "nothing here yet" when the read had actually failed. They
  now show the failure and a retry, and a template favorite whose state could
  not be read shows an unknown marker instead of an unstarred star.

#### The record of a failed call, and the video chain made equal to it

- **Diagnostics: every failed upstream attempt is now on the record.** A new
  in-memory ring buffer (200 entries, cleared on restart, never written to disk)
  keeps the *final* request URL, the HTTP status, the network code
  (`ECONNREFUSED` / `ENOTFOUND` / `CERT_*`), the duration, the byte counts and the
  raw upstream body. Credentials are redacted before storage — `Bearer` tokens,
  keys in a query string and inline base64 all become placeholders — so the
  copied report is safe to paste into a public issue. The panel offers copy-all
  and states the failure instead of pretending there is nothing to show.
- **A failed task explains itself in the task list**, instead of the word
  "failed": the message now carries the request URL and the network code, which
  is what settles the usual "the request never reached the gateway" report.
- **The studio no longer hides behind the plugin-market page.** Both live in the
  same `main` slot, so switching from the conversation to the studio left two
  panels in the column. The keyed slot now yields for non-conversation content.
- **The video chain records into the same buffer.** A user whose images work and
  whose videos do not would otherwise have nowhere to look — and
  `DiagnosticPhase` could not even name the video legs.
  Video is submit → poll → download rather than one synchronous call, so each leg
  is its own phase (`video-submit` / `video-poll` / `video-download`), and
  "the render never started" is now distinguishable from "the status endpoint
  stopped answering". Reference frames are recorded as a count, never as the
  megabytes of base64 they are; a transient blip the poll loop retries is
  deliberately not recorded, while an exhausted retry budget is, with the status
  the endpoint kept answering with. The entry point rides the always-rendered
  toolbar in both studios, because a submit that never reached the provider
  leaves no task row to open it from.

### 1.7.4 — timing bugs the user actually hits

- **One artifact the host refuses no longer loses the whole skill run.** A
  canvas skill hands each produced file to the host, which hard-refuses some
  extensions (`.svg`, `.html`, …) and anything over 50MB. One refusal used to
  bubble out of the whole run, discarding the artifacts that had already been
  published to the canvas; the user saw one error and nothing else. The refused
  file is now skipped, the rest land, and a localized warning names it.
- **A failing read stream no longer takes the host process down.** A clip is
  served by piping the file to the response. `pipe` forwards errors to the
  destination, never to the source, so an unhandled `error` on the read stream
  terminated the whole web process. The source now has its own listener and
  ends one response instead.
- **Switching canvases neither drops a pending edit nor resurrects the old
  one.** Autosave is debounced, so a rename followed by a canvas switch could
  silently lose the edit, or let the old canvas's late save answer land on
  screen and replace the new canvas. Writes now carry a sequence number, an
  answer behind the newest edit is discarded, the pending snapshot is flushed
  before the canvas is replaced, and deleting a canvas marks it reconciled so
  the follow-up switch cannot write it back.
- **The video studio's submit/cancel updates the list immediately.** The task
  list is polled once by the parent (so the tab and the canvas share one view),
  but the tab's own refresh returned early in controlled mode, leaving a new or
  cancelled row invisible for a full 5s poll cycle. The request now travels up
  to that single poller instead of starting a second loop.

### 1.7.3 — small correctness fixes around the edges

- **A `~` in the data-folder setting now means the home directory.** The value
  is typed by hand into the settings form, where `~/my-images` is the natural
  thing to write, and `path.resolve` does not expand it — so the host created a
  directory literally named `~` under its working directory and stored
  everything there while the user looked in their home folder. A `~user` form
  is deliberately left alone.
- **The chat-resize handle's `aria-label` follows the interface language.** It
  is created once and lives outside the React tree, so nothing re-rendered it
  on a DSH language switch and it kept the language it was built in. It now
  subscribes, and releases the subscription when the element is replaced or the
  panel unmounts.

### 1.7.2 — video nodes could not be saved at all

**A canvas holding a video node could not be persisted.** The host's canvas
node guard accepted only `image` / `text` / `file` / `config` while
`CanvasNodeType` also declares `video`, so `coerceDocument` returned undefined
and `save()` answered `malformed canvas document`. Video nodes on the canvas
are this plugin's headline feature, which made the feature unusable end to end:
place a clip, and the canvas stopped saving.

No suite caught it because the canvas-video suite answers `/canvas/save` with a
stub that records the payload, so the real guard never ran against a video
node. `smoke.mjs` now round-trips a video node through the real route and the
real store, in all three states a video node can be in (finished clip,
rendering, failed). Removing `video` from the guard makes that check fail with
the exact error a user saw.

Also in this release:

- The full-screen clip preview marks the node when its clip will not load,
  instead of being the same dead player one click deeper.
- The dead-clip marker is now cleared by reload, single delete, bulk delete and
  regenerate. Regenerating used to leave a node claiming its clip was gone even
  after a fresh clip landed; bulk delete left marks for an undo to restore.
- The template favorites memo and the template list memo are keyed by the data
  root they were read from. Both were module-level and outlived a repointed
  root, so changing `localStoragePath` could read the old root and write back to
  the new one.

### 1.7.1 — the two fixes 1.7.0 shipped without, plus release hygiene

v1.7.0's release asset was uploaded before two fixes landed, and because the
version constant was not bumped the in-app updater could never offer them
(`updateAvailable` compares strictly greater). This release carries them, and
closes the class of gaps that let a release go out with no automated check.

**Fixes that were stranded on `main` after v1.7.0 was published**

- **A transient status blip no longer fails a video render.** Polling retries
  transient failures (5xx, 429, transport errors) within a bounded budget
  instead of marking a multi-minute render failed, and gives up with the
  provider's own message when the budget runs out.
- **An unsatisfiable `Range` is answered with 416**, not a silent 200 carrying
  the whole clip.

**Resource bounds (host side)**

- The image and video task queues keep only the newest terminal tasks (200 and
  100) alongside every live one. A finished image task pins its base64 result,
  so the previous unbounded array held every image generated in the session.
- A heavy skill run's working directory is removed once the run reaches a
  terminal state. Its outputs are already ingested into the canvas asset store
  by then, which is what makes the deletion safe.
- Deleting a canvas now sweeps assets nothing references any more. The sweep is
  deliberately conservative — a page that fails to parse aborts it, so a bug
  here can leave garbage but cannot delete a file in use. Both reference
  sources are collected: `metadata.asset` and `backgroundImage`.

**One data root**

- The "open data folder" route, the template snapshot cache and the template
  favorites all used to hardcode `~/.dsh/dsh-imagegen` while the history,
  gallery, video and canvas stores honoured `DSH_HOME` and a configured
  `localStoragePath`. With either set, the button opened the wrong directory
  and the template data lived in a second tree. All four now resolve through
  `imageDataRoot()`, lazily, so a path set after import is still honoured.

**Network calls have ceilings**

- Prompt enhancement and the `/models` discovery walk are bounded (60s/30s),
  and the vision call behind layer split is bounded (120s). The caller's own
  cancellation is combined with the timeout, not replaced by it.

**Canvas UI**

- A video node whose clip is gone (history cleared, or evicted by the 30-entry
  cap) now says so, with a retry and a remove control, instead of rendering a
  dead player with no explanation.
- The canvas revision-conflict self-heal branches on the stable
  `canvas-conflict` code instead of matching a translated message string.
- Hardcoded Chinese copy in the tool view, the panel resize handle, the video
  panel and the canvas moved into the locale dictionaries, so the English and
  Russian UIs no longer show Chinese.

**Release and verification**

- `package.json` `files` no longer ships `docs/videos/` (37 MiB of demo
  recordings no shipped document references) or the rest of `src/`; the
  bundled prompt snapshots stay, because the runtime reads them relative to
  `lib/`.
- **CI** (`.github/workflows/ci.yml`): typecheck, build, the full suite with
  ffmpeg installed, and an inspection of the packed archive that fails if the
  tarball is missing the runtime files or has the demo recordings back in it.
- `scripts/verify-frame-grab.mjs` is part of `pnpm test` now, and uses a fresh
  browser profile per run — a fixed path made its second run fail with
  "CDP did not come up" and no hint why.
- `scripts/verify-video-layout.mjs` validates its fixture's class names against
  the real component and stylesheet, so a renamed class fails the guard instead
  of silently measuring markup the panel no longer renders.
- `scripts/smoke.mjs` gained a per-check timeout, and its data-folder assertion
  now checks the route follows `DSH_HOME` rather than the literal `.dsh` path —
  the old assertion passed precisely because the route was hardcoded.
- `scripts/smoke-compose.mjs` reports how many checks were skipped, so a
  missing ffmpeg is visible instead of looking like a clean run.
- The update installer refuses GitHub's auto-generated source archives
  (`<repo>-<tag>.tar.gz`), which carry no build output and would install a
  plugin that cannot load.

**Docs and licensing**

- `THIRD_PARTY_NOTICES.md` now credits every upstream the bundled snapshots
  actually come from — including `freestylefly/awesome-gpt-image-2` (MIT, the
  largest single source), which was missing entirely — and states which
  snapshots pin a commit versus which reference a moving branch. It also flags
  `songguoxs/gpt4o-image-prompts`, which declares **no licence** upstream and is
  the source of six on-demand image URLs, as an open question rather than
  quietly listing it as fine.
- The compose and skill-config contracts were corrected against the code: a
  type name that never existed (`ClipComposeResult` → `ClipStitchResult`), a
  claim that `'compose'` appears as a video-panel mode tab (it does not — no
  model catalog declares it), and a secret-masking claim that omitted the
  four-character threshold in `mask()`.
- The issue templates lost a duplicated install-method option and an
  outdated version placeholder.

### 1.7.0 — first published release

This project's first published release. It ships as a **GitHub Release asset**
(`q253595422-dsh-imagegen-video-1.7.0.tgz`), not as an npm package. Everything in
"What this plugin adds" below is in this release.

- **The version line is this project's own.** It starts at 1.7.0, so these
  version numbers never collide with another plugin's release line.
- **No absolute paths ship in the tarball.** `lib/` is published (it is in
  `files`), and Rolldown stamps each module's id into a `//#region <id>` banner
  that survives into the bundle. The CSS Modules virtual id used to be the CSS
  file's absolute path, so `lib/client.js` embedded ten
  `/Users/<name>/…/src/client/*.module.css.mjs` strings and the bundle's bytes
  depended on where it was checked out. The virtual id is now repo-relative
  (`\0dsh-css:src/client/panel.module.css.mjs`), which is stable, unique, and
  reveals nothing the repository does not already publish.
- **The in-app update button installs the release archive.** `installUpdate` used
  to run `dsh plugin add <package>@<version>`, which is a registry lookup: with no
  npm publication it resolves to nothing and the button would fail while looking
  like it worked. It now reads the archive URL from the release's own assets and
  hands that URL to `dsh plugin add`. Two guards came with it — a release with no
  archive is refused instead of falling back to a registry spec, and the download
  host must be GitHub, because the URL arrives from the network. Asset ranking is
  by name (the package archive for this version first), so a release that also
  carries another version-named archive cannot win by alphabetical accident.

## What this plugin adds

### Video generation (the original motivation)

A complete video pipeline, from the contract layer to the studio UI:

- **Contract layer** — video types and the `VIDEO_API` route family, a video
  model catalog with per-family request shaping (`src/video-engine.ts`,
  `src/video-model-catalog.ts`).
- **Host side** — an async submit → poll → download engine, a bounded video
  history store with Range-capable clip streaming, a serial task queue, and
  per-channel video-model catalogs in settings.
- **Studio UI** — a video tab next to the image studio: text-to-video,
  image-to-video, keyframe (first/last frame) and multi-reference modes, model
  picker, polling with progress, an inline player and clip history.
- **Agent tools** — host-side video tools (generate, from-image, poll, cancel)
  so an Agent can drive the pipeline too.
- **Conversation** — a finished clip can be attached to the conversation draft
  through the existing file-draft bridge.

### Infinite canvas: video nodes

- Video nodes render inline with generating/error states and a footer.
- A canvas video run reports "rendering", not "failed", while it is in flight.
- Node toolbar and context menu: clip preview, download, frame grab, and
  favorite to the asset library.
- A finished clip can be added to the canvas as a reference node (the bytes are
  not copied into the canvas asset store).
- Video nodes carry the same controls as image nodes: a per-node video model
  picker and "regenerate with the current model".

### Infinite canvas: clip stitching (compose)

Select two or more video nodes and stitch them into one clip with the local
`ffmpeg`, in canvas reading order (top-to-bottom, left-to-right).

- **Ordering** — `src/clip-order.ts` is a shared pure module: the browser draws
  the ①②③ badges and the host builds the concat list from the same function, so
  what the user confirms is what gets encoded. It went through nine revisions;
  each earlier revision was certified green by the suites that existed at the
  time. The criteria and the known suite blind spots are documented in
  `docs/compose-contract.md`.
- **Compose is a canvas skill run**, not a new video mode and not a new route:
  `compose.videos` has `tier: 'local'` (a local subprocess — no model, no agent,
  no network). Stitched clips land in the video history, so they appear in the
  sidebar and can be favorited into the asset library.
- Clips are read from **both** stores (video history and gallery favorites).
  A clip that cannot be read fails the whole run rather than being silently
  skipped, so five selected clips never become a three-clip output.

### Asset library and history unification

- Clip history is merged into the image history sidebar instead of living in a
  separate list.
- Favorited clips render in the asset library with a "video" badge, a play
  overlay, download, and a full-screen viewer.
- The sidebar refreshes the clip list when a render finishes, so a new row
  appears without a page reload.

### Fixes to the image chain

- **The update check points at this repository.** `src/updater.ts` carried
  `PACKAGE_NAME = '@dickpy/dsh-imagegen'` and that project's GitHub Releases API
  URL, so "check for updates" would have offered another package's release notes
  and installed it over this plugin. Both now point at this repository. (Same
  class of problem as the package rename below.)
- The video studio composer was capped at 420px while an empty column took the
  remaining width; it now uses the full panel width (guarded by
  `scripts/verify-video-layout.mjs`).
- The shared-chunk filename is pinned so reinstalling built artifacts is a plain
  overwrite instead of leaving a stale hashed chunk behind.
- Polling uses the resource `id`, because at least one upstream returns both
  `id` and `task_id` in a flat body.
- `scripts/verify-frame-grab.mjs` no longer hardcodes one machine's ffmpeg and
  Chrome paths (and a fixed CDP port); it discovers both, and skips loudly if
  either is missing.

### This repository's identity

The plugin publishes under its own name so it cannot be confused with, or
mistaken for, another package:

| Where | Value |
| --- | --- |
| release archive (`q253595422-dsh-imagegen-video-<version>.tgz`) | `https://github.com/q253595422/dsh-imagegen-video/releases` |
| plugin id (stamped by `tsdown.config.ts` into the `__ModuleLoader__` handoff) | `@q253595422/dsh-imagegen-video` |
| `cordis.patch.yml` row `name` | `@q253595422/dsh-imagegen-video` |
| update check (`src/updater.ts`) | this repository |

The npm package name is `@q253595422/dsh-imagegen-video` as well, but nothing is
published there: releases go through GitHub Releases, so both the README and the
in-app update button install the release asset. `src/updater.ts` reads the
asset URL from the release itself and refuses to install a release that carries no
archive, rather than falling back to a registry spec that would resolve to nothing.

The **runtime identity is deliberately left alone**: the `/api/dsh-imagegen/*`
route family, the `dsh-imagegen` settings namespace, the `~/.dsh/dsh-imagegen/`
data root and the `dsh-imagegen:*` client events/storage keys all keep their
inherited names. Renaming them would orphan the settings and data of anyone
switching between the two installs, and the route prefix predates this plugin.

### Test infrastructure

The offline suites run without network access or paid upstream calls, plus a
guard for each defect found:

| Suite | Covers |
| --- | --- |
| `scripts/smoke-video.mjs` | video studio: modes, catalog, polling, history |
| `scripts/smoke-canvas-video.mjs` | canvas video nodes, ordering badges, compose entry points, video-node controls |
| `scripts/smoke-video-picker.mjs` | the in-canvas video picker (three tabs, upload, empty/error states) |
| `scripts/smoke-compose.mjs` | stitching end-to-end against a fake composer, plus one real-`ffmpeg` case |
| `scripts/verify-b-defect.mjs` | clip resolution against both stores, with real files on disk |
| `scripts/verify-video-layout.mjs` | real-browser check that the composer fills the panel |
| `scripts/verify-frame-grab.mjs` | real-browser proof of the frame-grab path (seek + capture) |
| `scripts/with-lock.sh` | serializes build/test runs across a shared working tree |

Browser-dependent suites **skip loudly and exit 0** when the browser or
`ffmpeg` is missing, so a contributor without those tools gets a clear "not
verified" instead of a false failure.

## Configuration notes

- The `@q253595422/dsh-imagegen-video` package **cannot be installed alongside
  `@dickpy/dsh-imagegen`**: both register the same
  `/api/dsh-imagegen/*` route family and both inject the same UI panel. The
  route prefix predates this plugin.
- Data (history, gallery, canvases, settings) lives under
  `~/.dsh/dsh-imagegen/` and keeps that name, so it is *shared* with an install
  of `@dickpy/dsh-imagegen`. Back it up before switching between the two.

## Not in this plugin

- No paid upstream verification is performed by the test suites; all upstream
  interactions are replayed from fixtures.

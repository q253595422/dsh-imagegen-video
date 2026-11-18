# 牧野工作台（muye.si）3D 导演台调研

调研日期：2026-11-17。样本画布 `https://muye.si/canvas/W9H2_LCDrgViEp1T7YC0q`，在用户自己的 Chrome（已登录、有 WebGL2）里实测，不是看截图猜的。

> **这份文件解决什么**：判断牧野的 3D 导演台值不值得对标、对标到什么粒度，以及我们缺的到底是"三维"还是"时间"。
> **它在整体里是哪一环**：竞品调研 + 我们的实施方案依据。结论已经落进代码（`stage-scene-3d.ts` / `stage-timeline.ts` / `stage-encode.ts`），这份文件是那些取舍的证据来源。
> **三个不显然的取舍**：① 结论建立在**一次登录态实测 + 打包产物静态分析**上，不是官方文档；② 它的节点尺寸、连线 role、校验文案都是从 bundle 和 DOM 里读出来的，平台会变，重跑即失效；③ 我们**没有**跟它的全部设计——视频编码走宿主 ffmpeg 而非 WebCodecs（理由见「我们没跟的两件事」）。

## 结论先说

1. **它的导演台是"真 3D + 时间轴 + 逐帧导出"三件套**，不是给 2D 画面加一个播放器。我们原来的导演台是 2D 画家算法（`pose-scene-render.ts` 的 metaball 球拼人），差的是**深度**和**时间**两样，只补一样都没用。
2. **渲染层用 three.js**，证据是 chunk `00zcg~610p2mw.js` 里同时出现 `JOINTS_0→skinIndex` / `WEIGHTS_0→skinWeight`（GLTFLoader 的蒙皮路径映射）、`accessors`/`bufferViews`（glTF 解析）、`quaternion`/`slerp`。人偶是蒙皮 GLB，不是几何拼的。
3. **固定 30fps，时长 0–5 秒**（默认），关键帧必须落在帧边界——它的校验文案 `directorFrameRateMustBe30Fps`、`{value0}关键帧时间必须落在固定帧边界` 是从前端包里的规则表直接读到的。我们也定 30fps，但时长放到 2–15 秒（理由见「我们改了的」）。
4. **导出走两条路**：`导出 PNG` 落成「3D 导演台 参考图片」节点、`导出视频` 落成「3D 导演台 参考视频」节点，都自动与导演台节点连线。实测确认：两条 Edge from directorDesk。

## 平台与渲染实测

| 项 | 值 |
| --- | --- |
| 视口 | WebGL2 真 3D，`ANGLE Metal Renderer: Apple M5` |
| 可用编码 | `VideoEncoder` 存在，H.264 可用 |
| 前端栈 | 打包 chunk 44 个 js，Vue/React 无关的 bundle，three.js 内联 |
| 人偶 | 蒙皮 GLB（`JOINTS_0`/`WEIGHTS_0` 映射证据） |
| 画布保存 | `POST /api/v1/canvas/saveProject`；未登录 `401 {"code":3001,"msg":"请先登录"}` |

## 导演台 UI 实测结构

三栏 + 底部时间轴：

- **左栏**：主机位 / 地面 / 角色A；道具支持 `Mannequin` / `Cube` / `Sphere` / `GLB prop`；`Add camera` / `Upload GLB` / `Set background`；导出画幅（横屏 16:9）。
- **右栏**：三个页签 `属性` / `姿势` / `运动轨迹`。
- **底部时间轴**：0–5s、30 帧/秒、角色A + 主机位双轨。

### 姿势（右栏「姿势」页）

20 个预设：站立、T型、行走、跑步、坐姿、蹲下、单膝跪、双膝跪、叉腰、倚靠、鞠躬、思考、格斗、踢球、投掷、推进、招手、伸手、抱臂、看手机。
另有逐关节前倾 / 转身 / 侧倾，以及记录姿势关键帧、重心偏移 XYZ。

### 运动轨迹（右栏「运动轨迹」页）

五种形状：圆形 / 直线 / 矩形 / 铅笔 / 钢笔。追加片段、路径高度、右键删除。

### 关键帧（实测计数）

点「记录变换关键帧」后节点计数从 `0 个关键帧` 变成 `2 个关键帧`——说明它一次记录写入的是**一个对象在某一时刻的完整变换**，而不是按属性拆成多条。我们的 `CanvasStageKeyframe` 也是同样口径（`rig?` / `position?` / `facing?` / `camera?` 全可选，同一时刻一条）。

## 导出实测

| 操作 | 结果 |
| --- | --- |
| 导出 PNG | 自动建「3D 导演台 参考图片」节点并连线 |
| 导出视频 | 自动建「3D 导演台 参考视频」节点并连线 |

两条 Edge from directorDesk 已在画布数据里确认。

## 前端规则表（从 bundle 读出）

这些字符串是它自己的校验文案，等于把它的约束暴露了出来：

- `directorFrameRateMustBe30Fps`
- `{value0}关键帧时间必须落在固定帧边界`
- `cameraPathCannotCoexistWithPositionAnimation`
- `motionPathsCannotCoexistWithPositionKeyframes`
- `atLeastOneDirectorCameraIsRequired`

后两条对我们有参考价值：**轨迹与位置关键帧互斥**是真实存在的设计冲突，不是我们的实现困难。我们的 `sampleStage()` 选了"轨迹在活动区间内覆盖位置关键帧"（smoke 的 G5 断言的就是这条），比直接报错更宽容。

## 节点尺寸与连线 role（bundle 证据）

节点尺寸：director `520×360`、storyboard `600×600`、background `960×640`、video `630×354`、compose `440×380`、audio `480×200`。

节点类型：`text / image / video / audio / storyboard / videoComposition / directorDesk / background`。

连线 role：`Reference` / `First frame` / `Last frame` / `Edit or extend` / `Upscale source` / `Voice reference` / `Not used in this mode` / `DuplicateFrames`。
我们只有 `input | first | last | reference`（`src/client/canvas/connection-role.ts`），这次导出用 `reference`。

## 我们跟了什么

| 牧野 | 我们 | 落在哪 |
| --- | --- | --- |
| 真 3D 视口 | three.js 渲染层，真深度缓冲 | `src/client/canvas/stage-scene-3d.ts` |
| 固定 30fps | `STAGE_FPS = 30` | `stage-timeline.ts` |
| 关键帧落在帧边界 | `snapToFrame()` | `stage-timeline.ts` |
| 双轨（角色 + 机位） | `CanvasStageTrack.target: 'actor' \| 'camera'` | `src/protocol.ts` |
| 五种运动轨迹 | `circle / line / rect / free` | `CanvasStagePath` |
| 道具 Cube / Sphere / GLB | `CanvasStagePropKind = 'cube' \| 'sphere' \| 'glb'` | `src/protocol.ts:1916` |
| 导出 PNG 落参考图节点 | 已有（`onCapture`） | `CanvasWorkspace.tsx:7039` |
| 导出视频落参考视频节点 | `exportStageVideo` + 落节点连线 | `stage-export.ts`、`CanvasWorkspace.tsx` |

## 我们没跟的两件事

### 1. 视频编码不在浏览器里做

牧野用 WebCodecs，代价是它自己得给用户看一句「当前浏览器不支持此画幅的 H.264 编码」。这个插件的宿主本来就有 ffmpeg（`src/clip-compose.ts` 已经在用），把编码放到宿主之后：

- 画幅不再受浏览器能力表限制（`MAX_DIMENSION = 4096`，内部 `evenSize()` 补偶数边）；
- 复用拼接那条路已有的工具探测与错误处理；
- 客户端只需要"渲一帧、传一帧"，不用管编码器。

代价是多了一次逐帧上传（一帧 1–3MB，串行）。`stage-export.ts` 的注释里写明了这个取舍，以及"中止时已上传的帧靠会话超时清理"这个已知缺口。

### 2. 时长上限放到 15 秒

牧野默认 0–5 秒。我们放 `STAGE_MIN_DURATION = 2` / `STAGE_MAX_DURATION = 15`：5 秒装不下一个完整的运镜加走位，而 15 秒 × 30fps = 450 帧仍在 `STAGE_MAX_FRAMES = 480` 之内（`smoke-stage-encode.mjs` 的 E5 就是在守这个关系）。

## 复现方式

我在用户自己的 Chrome 里实测，所以"有 WebGL 无登录 / 有登录无 WebGL"那个矛盾不存在了。要点：

- 自动化浏览器若带 `--disable-gpu`，`getContext('webgl2')` 会返回 null（实测 `GL_VENDOR = Disabled`，报 `Could not create a WebGL context ... BindToCurrentSequence failed`）。这就是 `scripts/verify-stage-3d.mjs` 自己拼启动参数、不走 `lib/headless-chrome.mjs` 的原因——那个模块固定带 `--disable-gpu`，会把一个正确的三维渲染判成"环境不支持"。
- 未登录时 `listProjects` 返回 `401 {"code":3001,"msg":"请先登录"}`，私有画布读不到。

## 遗留

用户在牧野那边的测试画布上有我留下的测试垃圾：一个「立方体 1」、2 个变换关键帧、一个「3D 导演台 参考图片」、一个「3D 导演台 参考视频」节点，尚未清理。

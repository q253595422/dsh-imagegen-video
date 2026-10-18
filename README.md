# dsh-imagegen-video

> **这是 [dickpy/dsh-imagegen](https://github.com/dickpy/dsh-imagegen) 的衍生版（fork）。**
> 上游只做生图；本仓库在上游 v1.6.8 源码基础上增加了**完整的生视频链路**与
> **画布视频节点、片段拼接**。上游的署名与许可证见 [NOTICE](./NOTICE)，
> 本仓库相对上游改了什么见 [CHANGELOG.md](./CHANGELOG.md)。

<div align="center">
  <a href="https://github.com/q253595422/dsh-imagegen-video/releases"><img src="https://img.shields.io/github/v/release/q253595422/dsh-imagegen-video?color=cb3837&label=release" alt="Latest release" /></a>
  &nbsp;
  <a href="https://github.com/q253595422/dsh-imagegen-video/releases"><img src="https://img.shields.io/github/downloads/q253595422/dsh-imagegen-video/total?label=downloads&color=blue" alt="Release downloads" /></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg" alt="License" /></a>
  &nbsp;
  <a href="https://github.com/q253595422/dsh-imagegen-video"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827" alt="Platform" /></a>

  <p><strong>在 DeepSeek Harness 里，生成、编辑、管理，一站完成；图片与视频同一套工作流。</strong></p>
  <p><strong>快速导航</strong></p>
  <p><a href="#quick-start">🚀 快速开始</a>　·　<a href="#canvas">无限画布</a>　·　<a href="#compose">片段拼接</a>　·　<a href="#ecommerce">电商套图</a>　·　<a href="#txt2img">文生图 / 图生图</a>　·　<a href="#txt2video">生视频</a>　·　<a href="#gallery">模板 / 画廊</a>　·　<a href="#configuration">模型配置</a>　·　<a href="#upstream">上游与授权</a></p>
</div>

<a id="quick-start"></a>
## 快速开始

需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 和 Node.js 20+。

安装包有两个来源：**npm registry**（推荐，包名即版本，`npm view` 能查、能被锁文件盯住）与 **GitHub Release 资产**（每次附带 `SHA256SUMS`）。

```bash
# npm（registry 直达）
dsh plugin --profile web add @q253595422/dsh-imagegen-video

# 或 GitHub Release 资产
dsh plugin --profile web add https://github.com/q253595422/dsh-imagegen-video/releases/download/v1.7.8/q253595422-dsh-imagegen-video-1.7.8.tgz
```

也可以先到 [Releases](https://github.com/q253595422/dsh-imagegen-video/releases) 页面下载 `.tgz`，再安装本地文件：

```bash
dsh plugin --profile web add ./q253595422-dsh-imagegen-video-1.7.8.tgz
```

> ⚠️ **不要与原版 `@dickpy/dsh-imagegen` 同时安装。** 两者注册的是同一套
> `/api/dsh-imagegen/*` 路由和同一个 UI 面板（该路由前缀继承自上游，不是本
> 衍生版引入的），同时启用会冲突。数据目录 `~/.dsh/dsh-imagegen/` 也与上游
> **共用**，切换前请先备份。详见 [上游与授权](#upstream)。

安装后重启 `dsh web`，侧边栏会出现「生图」入口。到「设置 → 生图配置」添加提供方、填写 API 地址与密钥、检测并选择生图模型，保存后即可开始创作。Windows 若遇 PowerShell 脚本策略限制，请使用 `dsh.cmd`。

<details>
<summary><b>其他安装方式、升级与回滚</b></summary>

- **让 Agent 安装：**把上面的安装命令发给 DSH、Codex 或其他 coding agent。
- **指定版本：**把 URL 里的 `v1.7.8` 与文件名里的版本号换成目标版本，或从 [GitHub Releases](https://github.com/q253595422/dsh-imagegen-video/releases) 下载对应版本的 tgz 后安装。
- **升级：**重复执行 `add` 命令指向新版本即可；插件也会在面板中提示新版本。更新后重启 `dsh web`。
- **DSH Desktop 用户：**宿主 CLI 不允许写入 `desktop` 这个 profile，所以面板不会假装去更新，而是直接给出可复制的命令和下载地址，由你自己执行——这与上游 issue #41 里「更新失败但看不到原因」是两回事。
- 渠道配置、历史记录和画廊数据保存在 DSH 宿主侧，正常升级不会清空。

</details>

<a id="features"></a>
## 核心功能

| 能力 | 用途 |
| --- | --- |
| **无限画布** | 把提示词、参考图和生成节点连成可迭代的创作流程。 |
| **视频节点与拼接** | 视频节点与图片节点同一套控制；多选后按画布位置拼成一条成片。 |
| **电商套图** | 从商品参考图生成主图、卖点图、场景图等成套素材。 |
| **文生图 / 图生图** | 使用兼容的生图渠道生成、编辑并比较图片。 |
| **生视频** | 文生视频、图生视频、首尾帧与多参考图；按协议族适配异步渲染与轮询。 |
| **对话与 Agent** | 在 DSH 对话中生成图片、继续编辑，并把结果带回会话。 |
| **画廊与历史** | 图片与视频同列管理，支持模板与标签；在不同设备上接续创作。 |

<a id="canvas"></a>

把文字、图片和生成配置连起来；从历史或画廊加入素材，再继续生成和迭代。

<div align="center">
  <img src="docs/images/infinite-canvas-demo.gif" alt="无限画布：连接节点并继续创作的演示" width="100%" />
</div>

<details>
<summary><b>画布、文件节点与技能细节</b></summary>

- 支持图片、文本、视频、生成配置和文件节点；图片节点可标注、移除背景或拆分图层。
- **海报编辑**：在图片节点上叠加文字与 Logo 图层，拖动改位置，实时预览；导出是一张新图片节点，原图与图层配方都保留，随时可以重开继续改。整条链路纯本地 Canvas 2D，不调用任何模型、不消耗额度。
- **快捷键面板**：按 `?`（或 `F1`）随时呼出，或点工具栏的键盘图标；`Esc` 关闭。常用操作同时写在控件自身的提示里（如「撤销 (Ctrl+Z)」），不必先记住有这块面板。
- 单个文件最大 50MB；可在画布内预览常见文档、表格、PDF、图片与音视频。
- 内置文本润色、图片描述、内容抽取和图片转可编辑 PPT 等技能；图片转 PPT 不需要另外安装第三方技能或配置 OCR token。
- 图片转 PPT 使用配置的聊天模型理解版式，在本地生成可编辑文字与基础矢量形状；复杂照片或插画可能会简化。
- 也可安装和管理外部技能。重任务技能会启动具有本机文件读写与命令执行能力的无头 Agent；运行前请检查技能来源和权限。
- 旧版第三方 `image-to-editable-ppt` 可继续用于独立 Agent 工作流；它不参与内置图片转 PPT，相关 OCR 或图片后端配置也不是内置流程的前置条件。
- 技能配置格式与安全边界见 [`docs/skill-config.md`](docs/skill-config.md)。

</details>

<a id="compose"></a>
### 片段拼接

把生好的视频片段拖到画布上，**框选两段以上**，底部会出现「拼接这 N 段」按钮。

- **顺序按画布位置**：从上到下、从左到右；每个被选中的片段上会标出 ①②③，确认卡里也会列出最终顺序 —— 你看到的序号就是成片里的顺序。
- **本机 ffmpeg 执行**：不调用任何模型、不联网、不消耗额度。工具从 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 依次查找；找不到时按钮会明确说明原因，而不是静默失败。
- **成片进入视频历史**：拼接结果作为一条普通视频记录落盘，可以在侧栏看到、播放，也可以收藏进素材库。
- 找不到的片段会让**整次拼接失败**并指出是第几段，而不是悄悄少拼一段。
- 输出统一为 1280×720 / 30fps / H.264 + AAC，不同尺寸或帧率的输入会等比缩放并补边，不会变形。

判定规则与已知边界见 [`docs/compose-contract.md`](docs/compose-contract.md)。

<a id="ecommerce"></a>

从商品主体和可选风格参考出发，先预览套图计划、逐张调整提示词，再批量生成；主图可作为其他用途图片的一致性参考。

<div align="center">
  <img src="docs/images/ecommerce-mode.png" alt="电商模式：配置商品参考图并生成成套商品视觉" width="100%" />
</div>

<a id="txt2img"></a>

输入提示词即可生成，也可上传参考图进行编辑；支持多张结果、比例与清晰度设置、任务队列、历史恢复和全屏预览。

<div align="center">
  <img src="docs/images/image-generation-studio-four.png" alt="文生图与图生图工作台" width="100%" />
</div>

在 DSH 对话里可让 Agent 调用生图；用 `/edit_image` 描述修改内容，也可从工作台或画廊把图片加入当前会话继续编辑。

<a id="txt2video"></a>

### 生视频

在「生视频」标签页里写视频描述，选择视频模型、比例、分辨率与时长即可提交。视频在上游是**异步渲染**：宿主先提交任务、再按协议族轮询，渲染完成后把成片以文件落盘，并在面板内直接播放；渲染通常需要数分钟，期间可以关闭页面，任务仍在宿主继续执行。

**视频模型按渠道单独配置**，与图片模型分开：渠道里的「视频模型」目录决定该渠道能用哪些视频模型，因为视频走的是提交+轮询协议，和图片的同步返回不是一回事。

<details>
<summary><b>支持的协议族与模式</b></summary>

| 协议族 | 模型示例 | 说明 |
| --- | --- | --- |
| Agnes 视频 | `agnes-video-2.5-flash`、`agnes-video-2.5` | 提交 `POST /v1/videos`，轮询 `GET /v1/videos/{id}`，取 `metadata.url`；支持文生视频、首尾帧、多参考图、`seed`。 |
| 算力萌 comemoe | `wan2.2-t2v`、`zhimeng-h3-local` | `wan2.2-t2v` 仅文生视频；`zhimeng-h3-local` 支持图生视频。比例只接受 16:9 / 9:16 / 1:1；5 秒片子实测约 9 分钟。 |
| 通用视频 | 其他视频模型 id | 按 OpenAI 兼容视频端点尽力适配；未识别的协议族会明确报错，不会静默发出错误请求。 |

- **生成模式**：文生视频、图生视频（单张参考图）、首尾帧（首帧+尾帧插值）、参考图（多张风格/主体参考）；不同模型支持的模式不同，面板只会给出该模型支持的选项。
- **成片存储**：视频保存在本机数据目录的 `videos/` 下，历史列表只存元数据，播放走支持 Range 的同源路由，所以可以拖动进度条。
- **Agent 调用**：Agent 可调用 `generate_video`（文生视频）与 `generate_video_from_image`（图生视频/首尾帧/参考图），并用 `get_video_generation_task` 查询进度；视频渲染较慢，不要紧凑轮询。

</details>

#### 多模型对比

同一提示词可提交给多个模型并列查看结果，便于快速挑选风格与质量。

<div align="center">
  <img src="docs/images/multi-model-comparison.png" alt="多个生图模型的并列结果对比" width="100%" />
</div>

<a id="gallery"></a>

提示词模板库内置八个来源（精选案例、沧河、手绘、Prompt/Signal、evolink、itgoyo、songtianlun、youart），共三千余条，可搜索、筛选、收藏并直接带入生图。生成结果可在画廊中用标签和收藏继续整理；**删除是可撤销的**——被删的条目先进回收站，保留 30 天，期间可以逐条还原或一键清空，只有清空（或超过 30 天后的首次访问）才真正删除磁盘上的文件。

<p align="center">
  <img src="docs/images/prompt-template-library.png" alt="提示词案例模板库" width="49%" />
  <img src="docs/images/gallery-workspace.png" alt="画廊工作区" width="49%" />
</p>

<a id="configuration"></a>
## 模型配置

在「设置 → 生图配置」添加渠道，填写 API 地址与密钥，检测并选择生图模型。可配置多个提供方，并设置默认生图模型和可选的提示词增强聊天模型。

支持 OpenAI 兼容的 Images API / Chat Completions，以及 xAI Grok、Google Nano Banana、Seedream、Qwen-Image、GLM-Image、MiniMax 等预置渠道；也可手动添加兼容模型。

<details>
<summary><b>接口与渠道补充说明</b></summary>

- 通用渠道默认自动判断 Images API 与 Chat Completions；也可在设置中手动指定。
- One-API、New API、LiteLLM 等只暴露 `/chat/completions` 的网关，可填写完整接口地址并选择对应模型。
- API 密钥保存在 DSH 宿主设置中；未被自动识别的兼容模型可手动添加。
- 不同服务商的图生图、尺寸与返回格式可能不同，请确认所选模型实际支持的能力。

</details>

<a id="security"></a>
## 数据与安全

- API 请求经 DSH 宿主转发；密钥保存在本机设置中，不直接暴露给浏览器。
- 历史、画廊、画布和图片保存在 DSH 数据目录 `~/.dsh/dsh-imagegen/`，由你控制。
- 生图与图生图会把提示词或参考图发送给所配置的上游服务；请按服务商政策处理敏感内容。
- 内置轻量技能会把所选内容发送给配置的聊天模型。图片转 PPT 的 PPTX 在本地生成，由原生文字与基础矢量形状组成，不会把整张原图直接铺成幻灯片背景；结果需人工检查。
- 外部重任务技能可能读写本机文件并执行命令；运行前请确认技能可信、输入内容可共享。
- 生图会消耗上游 API 额度；请人工检查生成结果。不要把 API 密钥贴到 Issue、日志或截图中。
- **诊断日志**（两个工作台右上角）：失败的上游请求会留在本机内存里
  （最多 200 条，重启即清空，不写磁盘，不产生后台请求），
  可一键复制后贴进 Issue。记录含实际请求地址、HTTP 状态、网络错误码、耗时、
  体积与上游原始响应；**密钥已在写入前脱敏**（`Bearer` 令牌、查询串密钥、
  内联 base64 均替换为占位符，API Key 只记「是否发送」）。
  生图与生视频写同一个缓冲：视频的提交 / 轮询 / 下载三条腿各自标记。

<a id="upstream"></a>
## 上游与授权

本仓库是 [dickpy/dsh-imagegen](https://github.com/dickpy/dsh-imagegen) 的衍生版，按
[Apache-2.0](./LICENSE) 发布。上游的版权与来源见 [NOTICE](./NOTICE)；本仓库相对
上游 v1.6.8 的全部改动逐条列在 [CHANGELOG.md](./CHANGELOG.md)。

> **本仓库是独立项目，不跟随上游版本线。** 上游源码只在 fork 时一次性取用（基线
> v1.6.8），此后本仓库按自己的节奏发版（当前 v1.7.8）。上游后续版本的功能会**按需**
> 吸收进来——例如失败可查的诊断日志（上游 #38）——吸收后即为本仓库自己代码的一部分，
> 版本号仍是本仓库的。因为两边历史没有共同祖先，吸收是**逐文件移植**，不是 `git merge`。

**这个衍生版做了什么**：上游只有生图。本仓库在上游源码上补齐了生视频链路
（异步提交/轮询、视频渠道目录、视频标签页、Agent 视频工具），并把视频接进
无限画布（视频节点、片段拼接、视频节点与图片节点同一套控制）。

**支持与问题反馈请提到本仓库的 Issues**（[Bug 报告](https://github.com/q253595422/dsh-imagegen-video/issues/new?template=bug_report.yml) · [功能建议](https://github.com/q253595422/dsh-imagegen-video/issues/new?template=feature_request.yml) · [全部 Issues](https://github.com/q253595422/dsh-imagegen-video/issues)），不要提到上游仓库 —— 上游并不维护这里的代码。上游的 QQ 交流群与本仓库无关，这里不代为宣传。

**与上游不能共存**：两者注册同一套 `/api/dsh-imagegen/*` 路由与同一个 UI
面板，同时安装会冲突；数据目录 `~/.dsh/dsh-imagegen/` 也是共用的。要换回
原版，请先卸载本插件。

<details>
<summary><b>本地开发</b></summary>

```bash
pnpm run typecheck
pnpm run build
pnpm run watch
pnpm test
node scripts/smoke-video.mjs
pnpm run test:negative
```

`pnpm test` 跑全部十一项离线检查（`verify-tracked` 排第一）；`pnpm run test:negative` 做反向验证——
把每处修复对应的缺陷重新注回**仓库副本**，要求对应检查变红，
工作树不被改动。

本地打包并安装到 DSH 验收：

```bash
pnpm pack --pack-destination .
dsh plugin --profile web add ./q253595422-dsh-imagegen-video-<版本>.tgz
```

仓库里的离线套件不需要网络与付费上游调用；需要浏览器或 `ffmpeg` 的检查在缺
少工具时会**明确跳过并返回成功**，而不是伪装成失败。并行跑构建与测试请用
`./scripts/with-lock.sh`，它会把整棵工作树串行化。

</details>

## 许可证

[Apache-2.0](./LICENSE)

上游与本仓库的署名见 [NOTICE](./NOTICE)。内置模板所引用的第三方项目与许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

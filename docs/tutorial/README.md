# VisioWork 演示教程片

72 秒、中文、纯字幕 + BGM、无人声。八个章节按「从装好到出片」的顺序走一遍。

| 文件 | 画幅 | 用途 |
| --- | --- | --- |
| `visiowork-tutorial-16x9.mp4` | 1920×1080 · 30fps · H.264/AAC | B 站、YouTube、官网、GitHub Release、公众号 |
| `visiowork-tutorial-9x16.mp4` | 1080×1920 · 30fps · H.264/AAC | 抖音、快手、视频号、小红书、Shorts、Reels |

竖屏不是横屏裁切，是重新排过版的：截图换成近方形裁切窗口，标题居中，字幕条压在下三分之一。

## 分镜

| 时间 | 章节 | 字幕 |
| --- | --- | --- |
| 0–4.2s | 片头 + 目录 | — |
| 4.2–11.2s | 01 安装与进入 | 一条命令装上，重启 dsh web，侧栏多出「生图」。 |
| 11.2–18.4s | 02 配置渠道 | 先配渠道：API 地址、密钥，检测模型，保存。 |
| 18.4–26.4s | 03 第一张图 | 写一句话，点「开始生成」，第一张图就出来了。 |
| 26.4–34.0s | 04 图生图与参考图 | 图生图能一次喂五张参考图，风格人物分开给。 |
| 34.0–43.0s | 05 第一条视频 | 图片定好，一句话让它动起来。 |
| 43.0–50.6s | 06 画布串流程 | 把整条流程摊在画布上，改哪步只跑哪步。 |
| 50.6–59.4s | 07 分镜 · 拼接 · 时间线 | 多段按画布顺序拼成一条，要剪再接就开时间线。 |
| 59.4–67.4s | 08 电商与模板库 | 电商成套出图，模板库里挑现成提示词。 |
| 67.4–72s | 片尾 | 安装命令 + 仓库地址 |

## 素材来源（全部真机，无示意稿）

- `src/assets/ui-*.png` — 在 `127.0.0.1` 上真实运行的宿主截图（2560×1440），界面语言切成中文后逐屏截取。不是设计稿、不是重绘。
- `src/assets/gen-image.png` — 通过插件自己的 `/api/dsh-imagegen/generate` 真实生成的一张图（`gpt-image-2`，16:9，1792×1024）。
- `src/assets/clip-{a,b,c}.mp4` — 本机 `~/.dsh/dsh-imagegen/videos/files/` 下真实生成并落盘的成片，在片里按时间线 seek 播放。

重新采集界面截图时，注意两件事：

1. **默认模型可能被上游拒绝。** 第一次跑真实生成时，默认选中的 `agnes-image-2.1-flash` 被网关以 `400` 拒绝（`Model ... is not supported on /v1/images/generations`）。生成前先确认选中的模型在上游可用，或显式指定 `gpt-image-2`。
2. **视频渠道要单独验证。** 本次 `agnes-video-2.5-flash` 在 closeai 网关报 `503 No available channel`、`wan2.2-t2v` 在 comemoe 报 `402 insufficient balance`，所以片中的视频用的是本机已有的真实成片，而不是当次新渲染的。

## 重新生成

源文件在 `docs/tutorial/src/`：`tutorial.html` 是动画稿，`assets/` 是真机素材，`render.mjs` 用无头 Chrome 逐帧截图。

两个演示页（本页与 `docs/promo/`）共用两份实现，改其中一处两页同时生效：

- `docs/shared/timeline.js` — 时间线引擎。页面声明 `[data-scene]` 场景、`data-a` 效果与 `data-crop` 裁切窗口，调用 `window.createTimeline({ duration, cues, hudTotal, onFrame })` 即可；`setTime(t)` 把整页摆到第 t 秒。
- `scripts/lib/render-frames.mjs` — 逐帧渲染外壳。`runRenderCli({ pagePath, duration, stillTimes, outDir })` 负责起浏览器、等 `window.__ready`、逐帧 seek 截图；两个 `render.mjs` 都只是它的薄壳。

```bash
# 先验排版：溢出、栏重叠、片段越界、字幕出框都会让它退出码非 0
node docs/tutorial/src/guard.mjs

# 关键帧（10 个时间点 × 两版），改完文案先看这个
node docs/tutorial/src/render.mjs stills

# 全量 2160 帧；带上帧区间只重渲改动过的那一段
node docs/tutorial/src/render.mjs wide 30
node docs/tutorial/src/render.mjs tall 30 1020 1080
```

页面导出 `window.setTime(t)`，每一帧都是 seek 出来的，两版严格同步，不依赖 CSS 实时动画；内嵌的视频片段也是 seek 而不是播放，所以重渲是幂等的。

`guard.mjs` 是这套东西的排版护栏——它按「留白下限」而不是「绝对越界」判定（一张只剩 7px 边距的卡片已经是坏帧），并且区分容器与内容元素。改动版式后先跑它，别直接渲 2160 帧。

帧序列落在 `docs/tutorial/src/frames/`（未纳入版本库）。合成：

```bash
# BGM：从 docs/promo/src/bgm/go-cart-loop-mix.mp3 裁出 72 秒并归一化到 -14 LUFS
ffmpeg -i docs/promo/src/bgm/go-cart-loop-mix.mp3 -t 72 \
  -af "loudnorm=I=-14:TP=-1.5:LRA=7,afade=t=in:st=0:d=0.4,afade=t=out:st=70.2:d=1.8" \
  -ar 48000 -ac 2 /tmp/bgm-72s.wav

# 横屏（换成 tall 与 1080:1920 就是竖屏版）
ffmpeg -framerate 30 -i docs/tutorial/src/frames/wide/f%05d.jpg -i /tmp/bgm-72s.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -level 4.1 \
  -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:a aac -b:a 192k -ar 48000 -t 72 -movflags +faststart \
  docs/tutorial/visiowork-tutorial-16x9.mp4
```

## 音乐署名（CC BY 4.0，发布时必须带）

BGM：**"Go Cart - Loop Mix" Kevin MacLeod (incompetech.com)**
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/

放在视频简介或置顶评论里，让人找得到出处即可。YouTube 若被 Content ID 认领，先在简介加署名再 dispute，通常 72 小时内释放（[incompetech 说明](https://incompetech.com/music/royalty-free/youtube-contentid.html)）。

## 发布文案

标题（挑一条，按平台字数裁剪）：

- 从装好到出片：DeepSeek Harness 生图生视频插件完整演示
- 八步走完一个生图生视频插件：装、配、出图、出片
- 一条命令装上，侧栏多一个「生图」｜VisioWork 演示教程

正文：

```
VisioWork —— DeepSeek Harness 的生图 / 生视频插件。这条片子按顺序走一遍：

01 安装与进入   一条命令，重启后侧栏多出「会话 / 生图」
02 配置渠道     设置 → 生图配置，填地址与密钥，检测模型
03 第一张图     写一句话，点「开始生成」
04 图生图       一次最多五张参考图，风格人物分开给
05 生视频       文生视频 / 图生视频 / 首尾帧 / 参考图
06 无限画布     节点连线，改哪步只跑哪步
07 分镜拼接     多段按画布顺序拼成一条，时间线可剪再接
08 电商模板     成套出图 + 现成提示词库

装上就能用：
dsh plugin --profile web add @q253595422/dsh-imagegen-video

GitHub：https://github.com/q253595422/dsh-imagegen-video
需要 DeepSeek Harness + Node.js 20 以上。安装后重启 dsh web。
```

话题标签：

```
#AI绘画 #AI视频 #DeepSeek #提示词 #开源项目 #AI工具 #效率工具
```

平台差异：

- **B 站 / YouTube**：横屏，标题带「开源」和「插件」，简介里放完整安装命令。
- **抖音 / 快手 / 视频号**：竖屏，标题控制在 20 字内；第一章 4.2 秒才进来，前 3 秒是片头，别指望 3 秒内讲完卖点。
- **小红书**：竖屏，正文分段带 emoji 更容易读。
- **X / 即刻**：横屏，配一句「72 秒看完八个步骤」，安装命令单独一行。

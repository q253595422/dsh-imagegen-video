# VisioWork 推广片

30 秒、中文、纯字幕 + BGM、无人声。四个卖点各占一段，画面全部来自插件真实界面。

| 文件 | 画幅 | 用途 |
| --- | --- | --- |
| `visiowork-promo-16x9.mp4` | 1920×1080 · 30fps · H.264/AAC | B 站、YouTube、官网、GitHub Release、公众号 |
| `visiowork-promo-9x16.mp4` | 1080×1920 · 30fps · H.264/AAC | 抖音、快手、视频号、小红书、Shorts、Reels |
| `cover-16x9.jpg` / `cover-9x16.jpg` | 对应画幅 | 平台封面（可直接用，也可换成自己截的） |

竖屏不是横屏裁切，是重新排过版的：截图换成近方形裁切窗口，标题居中，字幕条压在下三分之一。

## 分镜

| 时间 | 段落 | 字幕 |
| --- | --- | --- |
| 0–2.7s | 片头 | — |
| 2.7–8.7s | 01 多图参考 | 五张参考图一起喂，风格和人物不用二选一。 |
| 8.7–14.7s | 02 生视频 | 图片定好，一句话让它动起来。 |
| 14.7–20.7s | 03 无限画布 | 整条流程摊在画布上，改哪步只跑哪步。 |
| 20.7–26.1s | 04 模板库 | 3774 条现成提示词，点一下就能用。 |
| 26.1–30s | 片尾 | 安装命令 + 仓库地址 + VisioWork |

## 发布文案

标题（挑一条，按平台字数裁剪）：

- 给 DeepSeek Harness 装个生图生视频插件，五张参考图一起喂
- 图片定好，一句话让它动起来：VisioWork 生视频实测
- 3774 条现成提示词，点一下就能用｜DeepSeek Harness 生图插件

正文：

```
VisioWork —— DeepSeek Harness 的生图 / 生视频插件。

· 多图参考：五张参考图一起喂，风格、人物、构图分开给
· 生视频：文生视频 / 图生视频 / 首尾帧 / 多参考，关掉页面任务还在跑
· 无限画布：图片和视频节点同一套控制，多选后按位置拼成一条成片
· 模板库：3774 条现成提示词，8 个库、17 个分类，点一下填进输入框

装上就能用：
dsh plugin --profile web add @q253595422/dsh-imagegen-video

GitHub：https://github.com/q253595422/dsh-imagegen-video
需要 DeepSeek Harness + Node.js 20 以上。安装后侧边栏「生图」进入。
```

话题标签：

```
#AI绘画 #AI视频 #DeepSeek #提示词 #开源项目 #AI工具 #效率工具
```

平台差异：

- **B 站 / YouTube**：横屏，标题带「开源」和「插件」两个词，简介里放完整安装命令。
- **抖音 / 快手 / 视频号**：竖屏，标题控制在 20 字内，前 3 秒不要留空——片头只有 2.7 秒，多图参考在 2.7 秒就进来了。
- **小红书**：竖屏，封面用 `cover-9x16.jpg`，正文分段带 emoji 更容易读。
- **X / 即刻**：横屏，配一句「30 秒看完四个功能」，安装命令单独一行。

## 音乐署名（CC BY 4.0，发布时必须带）

BGM：**"Go Cart - Loop Mix" Kevin MacLeod (incompetech.com)**
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/

放在视频简介或置顶评论里，让人找得到出处即可。YouTube 若被 Content ID 认领，先在简介加署名再 dispute，通常 72 小时内释放（[incompetech 说明](https://incompetech.com/music/royalty-free/youtube-contentid.html)）。

## 重新生成

源文件在 `docs/promo/src/`：`promo.html` 是动画稿，`assets/` 是四组界面截图与视频帧表，
`render.mjs` 用无头 Chrome 逐帧截图（复用 `scripts/lib/headless-chrome.mjs`）。

```bash
# 关键帧（12 个时间点 × 两版），改完文案先看这个
node docs/promo/src/render.mjs stills

# 全量 900 帧；带上帧区间只重渲改动过的那一段
node docs/promo/src/render.mjs wide 30
node docs/promo/src/render.mjs tall 30 780 900
```

页面导出 `window.setTime(t)`，每一帧都是 seek 出来的，两版严格同步，不依赖 CSS 实时动画。
帧序列落在 `docs/promo/src/frames/`（未纳入版本库）。先把 BGM 归一化到 -14 LUFS
（信息流常用响度，首尾各带淡入淡出），再合成：

```bash
# 1) BGM：从 docs/promo/src/bgm/go-cart-loop-mix.mp3 裁出 30 秒并归一化
ffmpeg -i docs/promo/src/bgm/go-cart-loop-mix.mp3 -t 30 \
  -af "loudnorm=I=-14:TP=-1.5:LRA=7,afade=t=in:st=0:d=0.35,afade=t=out:st=28.4:d=1.6" \
  -ar 48000 -ac 2 /tmp/bgm-30s.wav

# 2) 合成（换成 tall 与 1080:1920 就是竖屏版）
ffmpeg -framerate 30 -i docs/promo/src/frames/wide/f%05d.jpg -i /tmp/bgm-30s.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -level 4.1 \
  -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:a aac -b:a 192k -ar 48000 -t 30 -movflags +faststart \
  visiowork-promo-16x9.mp4
```

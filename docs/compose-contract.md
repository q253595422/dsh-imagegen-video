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
规则：按**顶边**自上而下逐项归行，同一行内按 `x` 升序，再 `y`，再 `id` 兜平局。

**两个节点算同一行的判据**（`ROW_PROXIMITY = 0.5` / `ROW_PROXIMITY_LIMIT = 240` / `ROW_PROXIMITY_FLOOR = 64` / `STACK_OVERLAP = 0.5` / `STACK_OFFSET = 0.25`）：

设 `offset = |a.y - b.y|`、`shorter = min(a.height, b.height)`、`narrower = min(a.width, b.width)`：

1. 🚨 **先查「嵌套」**：若两者**水平重叠 > 0** 且**其中一个是竖直方向被另一个包住的**
   （`a.y ≥ b.y && a.y + a.height ≤ b.y + b.height`，任一侧成立即可）⇒ **同一行**。
   **为什么必须先查**：一个小片段嵌在高片段里面时，它既与高片段水平重叠、顶边又不同——
   正好命中下一条的竖排守卫。守卫先跑就会把「被大片段圈住的小片段」推出去自开一行，
   而那行是用户没画过的。（实测：`A(0,0,240x240) + B(0,32,240x64) + C(400,96,240x240)`
   没有这条时会给出 `A,C,B` —— 完全在 C 上方的 B 反而排在 C 后面。）
   要求 `重叠 > 0` 是刻意的：竖直方向被包住但**水平完全错开**的两个片段是两列，不是一组。
2. 否则，若**水平重叠** ≥ `STACK_OVERLAP × narrower` **且** `offset` ≥ `STACK_OFFSET × shorter`
   ⇒ **不同行**——这是**竖排**，不是参差的横排。
   🚨 **两个条件都必需**：只留水平重叠，会把「顶边齐平、只是横向搭了一点」的横排撕成两行
   （§O8/O9：一个节点比邻居低 1px 就插到前面去）；只留垂直偏移，竖排会并成一行。
3. 否则，`offset < min(max(ROW_PROXIMITY × shorter, ROW_PROXIMITY_FLOOR), ROW_PROXIMITY_LIMIT)` ⇒ **同一行**。

🚨 **`ROW_PROXIMITY_FLOOR = 64` 也不是修饰**。窗口是**较矮者**高度的比例，所以被拖到
最小高度的片段（`MIN_NODE_HEIGHT = 64`）只配到 32px 的窗口——比手放的误差还紧。
一个 64px 的片段与更高的邻居排在同一视觉行里时会被单独甩出去，然后**更高的邻居被读成第一段**。
实测（`/private/tmp/cand/floor-sweep.mjs`，40 万布局各含一个被压到 96x64 的片段）：

| floor | 硬用例 | 严格倒置 / 40 万 |
|---|---|---|
| 32（无下限） | 21/23 | 190 |
| 48 | 22/23 | 30 |
| **64** | **22/23** | **0** |
| 80 | 22/23 | 5915 |
| 96 | 22/23 | 11419 |
| 128 | 22/23 | 21419 |
| 160 | 22/23 | 31135 |

⇒ **64 是唯一让倒置归零的取值**，恰好等于 `MIN_NODE_HEIGHT`。取 96 以上虽然会提高普通
行语料的恢复率（行抖动 60px：92.3% → 99.3%），但那是把窗口放宽到能吞掉真实行间距，
倒置随之爆炸。靠下限修掉的具体几何是 **M3**：
`A(0,32,240x64) + B(240,0,200x240) + C(480,96,200x240)`，期望 `A,B,C`，
无下限时给出 `B,C,A`（A 完全在 B 上方却排最后）。

🚨 **已知未修（几何本身有歧义，非缺陷）**：2x2 等高网格第二行只上移 `0..39px`
（240x160 片段、336px 列距）时读成列优先 `a,c,b,d`。此时两行垂直重叠 ≥ 50%，
「两行」与「两列」两种读法都成立，任何只按位置判断的规则都必须选一边。
本规则选「行」以外的另一边时会把 40 个偏移判成列优先；v4 只错 `dy=0` 一个偏移
但代价是零重叠时会出现严格倒置（40 万布局 1814 次 vs 本规则 0 次）。**这个取舍是有意的**，
不要为它改判据。见下面「全夹具 × 全版本矩阵」。

🚨 **`ROW_PROXIMITY_LIMIT = 240` 这个像素上限不是修饰，是必需机制**。没有它，接近度窗口会随
**片段自身高度**缩放：700px 高的片段窗口就有 350px，足以把下一行整个吞进来。反例（零重叠）：

```
left(0,0,240x700)   mid(1000,80,240x160)   low(600,320,240x700)
期望 left,mid,low —— mid 底边 240 完全在 low 顶边 320 之上
无上限时 low 会被并进 left 的行，该行再纯按 x 排序 ⇒ left,low,mid（严格倒置）
```
上限取**一个片段的自身footprint**（默认视频节点 240x160 的宽）：超过这个距离就是行间距，不是参差。
`mid` 底边 240 与 `low` 顶边 320 的 80px 缝是这个反例的关键——它比 `0.25 × 160 = 40` 大，
所以竖排守卫不介入。

一个节点加入**所有成员都与它同行的第一个**行；没有这样的行就自开一行。
要求**每个**成员而**不是任一**成员，才能防止一串两两重叠的节点把远处的项目拖进同一行。

**嵌套子句必须带上「顶边齐平」（v7 修的就是这里）**：若只要求「一个片段垂直嵌套在另一个里」就判同行，
那么**落在高宿主底部的片段会被焊进宿主的行**，再被该行的 x 排序安排到前面，越过一个完全在它上方、
只是偏右的片段。反例（compose-verifier 用随机探针发现，套件当时全绿）：

```
h(0,0,240x320)   b(89,249,240x64)   c(409,84,240x160)
期望 h,c,b —— c 底边 244 完全在 b 顶边 249 之上
无条件嵌套时给出 h,b,c（严格倒置）
```
倒置频率随宿主高度暴涨：H=320 时 0.18%、H=480 时 7.08%、H=700 时 18.01%、H=1000 时 **26.93%**。
加上「内层片段的顶边必须落在宿主顶边的接近度窗口内」这一条之后，上述每个高度都是 **0**。

**可达性（不是人造几何）**：节点高度**没有上限**（只有 `MIN_NODE_HEIGHT = 64`），拖底部把手即可变高；
自动尺寸在 160..427 之间。上面那个 700px 片段就是拖出来的。

| 写法 | 结果 |
|---|---|
| 只比**垂直中心**并按中心排序（最初实现） | 高片段被挤到下一行：240x600 挨着同排 240x160 时被排到第二位。不等高并排全错 |
| 较矮者中心落在较高者范围内 + 与**任一**成员比较 | **严格倒置**：完全在上方的片段被排到后面。40000 个合理布局里 **40.1%** 中招（**已废弃的第三版**，`4d331c36`） |
| **垂直区间有任何重叠**就算同行 | 过度合并：2x2 网格第二行上移 1px 即变**列优先**（`a,c,b,d`）（**已废弃的第二版**，`7ca72e06`） |
| 顶边接近度（**无上限**）+ 竖排守卫 | **严格倒置**：零重叠的一对也会中招——`left/mid/low` 反例，700px 片段窗口 350px 吞掉下一行（**已废弃的第四版**，`18698e1b`） |
| 顶边接近度（**上限 240**）+ 竖排守卫**含垂直偏移** | 上述四类几何全部正确；21 个硬用例全过，60000 个对抗布局中严格倒置 0、排列不变性违规 0（**已废弃的第五版**，`d6a9bd13`：嵌套小片段仍倒置，实测 M1/M2/M3） |
| 顶边接近度（上限 240 + **下限 64**）+ 竖排守卫含垂直偏移 + **嵌套无条件优先** | **严格倒置**：只要求「垂直嵌套」，于是**落在高宿主底部的片段被焊进宿主的行**，越过它右上方完全在上的片段。宿主 240x1000 时 **26.9%** 的布局中招（H=320 0.18% / H=480 7.08% / H=700 18.01%）。**已废弃的第六版**，`dad79dd1` |
| 顶边接近度（上限 240 + **下限 64**）+ 竖排守卫含垂直偏移 + **嵌套仅在顶边齐平时优先** | 当前出货（v7）。23 个硬用例 22/23（唯一漏项 `ragged tall y79` 为**几何本身有歧义**，见下），高宿主倒置从 26.9% 降到 **0**，60 万随机布局上 `v7 比 v6 差` 与 `v6 比 v7 差` 都是 **0**（只在上述特定形状上有别） |

**这几版之所以能带绿通过，是因为套件对它们不敏感**——每次都只有「事后补的」夹具才抓得住。
见下一段的盲区记录。

**已实测证伪的样板例警告**：早期版本的本文件声称「网格第二行上移 100px 仍读作两行」。
那条断言**对当时的规则是假的**——对 240x160 的片段，上移超过 80px 就会变成列优先。
凡是写进本文件的几何断言，都必须先在任何候选规则上跑过，不能凭直觉写。

**已实测的套件盲区（务必记住）**：本文件记录的顺序规则一共改过六版，**每一版的缺陷都是靠事后
专门补的夹具才抓住的**，没有任何一次是既有套件先发现的：

| 版本 | 缺陷 | 抓它的夹具 | 当时既有套件 |
|---|---|---|---|
| v1 `ded80204` 中心式 | 不等高并排颠倒 | V10 | 全绿 |
| v2 垂直区间重叠 | 2x2 网格变列优先 | V11 | 全绿 |
| v3 `4d331c36` 中心在较高者内 + 任一成员 | 严格倒置（40.1%） | V12/V13/V14 | **全绿**（实测 `BUILD=0 · smoke-compose EXIT=0 · smoke-canvas-video EXIT=0 · smoke.mjs EXIT=0`） |
| v4 `18698e1b` 顶边接近度无上限 | O7 零重叠也倒置、O8 1px 抖动、O9 半重叠拆行 | **V15** | 全绿（实测 `smoke-compose 0 · smoke-canvas-video 0 · smoke.mjs 0`，把 v4 写回磁盘后**只有 V15 失败**） |
| v5 `d6a9bd13` 顶边接近度有上限、无下限、无嵌套条款 | 嵌套小片段倒置（M1 `A,C,B`、M3 `B,C,A`） | **V16/V17/V18** | 全绿（实测：把 v5 写回磁盘重建后 `smoke-compose EXIT=0 12 PASS`、`smoke-canvas-video EXIT=0 8 PASS`、`smoke EXIT=0 77 PASS`，**零失败**） |
| v6 `dad79dd1` 嵌套**无条件**优先 | 高宿主底部片段被焊进宿主行 ⇒ 严格倒置（H=1000 时 26.9%） | **V19**（t16 补；在此之前**零覆盖**） | **全绿**（实测：把 v6 写回磁盘重建后 `smoke-compose EXIT=0`，**15 个夹具全过**，V16/V17/V18 也过——它们嵌套在宿主**顶部**，是两条规则唯一一致的形状） |

即：**V10 只抓 v1、V11 只抓 v2、V12-V14 只抓 v3、V15 只抓 v4、V16-V18 只抓 v5、V19 只抓 v6**——每一版都只有专门补的夹具才抓得住。
这就是一个错误规则能带着全绿通过审查的原因。本文件的规则每次改动，都必须先用「把旧规则写回磁盘、
重建、确认新夹具失败」的方式证明夹具是活的——只跑一遍绿是不能说明任何事的。

**v6 的缺陷是 compose-verifier 用随机探针发现的，不是套件发现的**（t14）。
这一点值得单独记住：v6 与 v7 在普通随机布局上**完全一致**（60 万布局互相「更差」计数都是 0），
差别**只存在于**「高宿主 + 底部嵌套片段 + 右上方片段」这一种形状里。随机采样永远裁定不了这个差别，
必须**按形状**构造语料。凡是要判断两个候选规则是否等价，先问「它们分歧的**形状**长什么样」，
而不是「跑多少随机」。

**v7 的两条子句由不同的夹具守卫，不要合并理解**（compose-engine 在 t15 逐条隔离实测，v7 沿用）：
- **嵌套子句只被 V16/V17 守卫**：删掉它，V16/V17 复现 `A,C,B`。但只删 `ROW_PROXIMITY_FLOOR`
  时 V16/V17 **仍然通过**——因为嵌套判定在窗口被查之前就返回了；没有嵌套判定时竖排守卫先否决
  （`240 ≥ 0.5×240` 且 `32 ≥ 0.25×64`），走的正是 `A,C,B` 那条路。
- **`ROW_PROXIMITY_FLOOR` 只被 V18 守卫**：删掉它，V18 复现 `B,C,A`。删掉嵌套子句时 V18
  **仍然通过**——A 与 B 恰好相接（水平重叠 0），嵌套与竖排都不适用，只有窗口在做判断。
- **不存在能单独隔离嵌套子句的夹具**（试过「深度嵌套、偏移超过 64px 下限」）：下限总是盖住嵌套对
  的偏移，所以嵌套子句**只能经由竖排守卫被触发**。⇒ 将来若有人简化规则删掉嵌套子句，
  **只有 V16/V17 会响**；删掉下限**只有 V18 会响**。改规则时按这张映射表核对。
- **v7 的「顶边齐平」条件由 V19 守卫**（t16 补）：把 v6 的无条件嵌套写回磁盘，只有 V19 响。

**全部夹具 × 全部历史版本（实测矩阵，表里的 ok/BAD 是「是否等于人读的读序」）**：

| 夹具 | v7 出货 | v6 | v5 | v4 | v3 | v2 | v1 |
|---|---|---|---|---|---|---|---|
| V10 | ok | ok | ok | ok | ok | ok | BAD |
| V11 | ok | ok | ok | ok | ok | BAD | ok |
| V12/V13/V14 | ok | ok | ok | ok | BAD | BAD | BAD |
| V15 / O7 | ok | ok | ok | **BAD** | BAD | BAD | BAD |
| V16/V17/V18（嵌套/缩小片段） | ok | ok | **BAD** | **BAD** | **BAD** | **BAD** | **BAD** |
| V19（高宿主 + 底部嵌套 + 右上方片段） | ok | **BAD** | **BAD** | ok | ok | ok | ok |
| C8 | ok | ok | ok | ok | ok | ok | BAD |
| O8（1px 抖动 `b.y=1`） | ok | ok | ok | **BAD** | ok | ok | ok |
| O9（`b.x=120` 正好半重叠） | ok | ok | ok | ok | ok | ok | ok |
| 网格第二行 y=40 | ok | ok | ok | ok | BAD | BAD | BAD |
| 同列纵向堆叠 / C2 | ok | ok | ok | ok | ok | ok | ok |

⇒ V12-V19 各自只覆盖一个版本的缺陷，**没有一个夹具能替另一版把关**；每一版都必须留着它自己的夹具。
注意 V19 是**唯一**能区分 v6 与 v7 的夹具，而 v4/v5/v1/v2/v3 在它上面**都是对的**——
即这个夹具对老版本没有回退保护价值，它只守着 v7 新加的那半句话。

**诚实边界：当前规则（v7，`1e66414d`）的残余。** 40 万随机布局（尺寸取自画布真实自动尺寸，且**含一个被压到
96x64 的片段**）：严格倒置 **0**、排列不变性违规 **0**；不含被压小片段时同样为 0。
唯一的已知漏项是硬用例 `ragged tall y79`
（`tall(0,79,240x600) + s1(400,0,240x160) + s2(736,0,240x160)`，我期望 `s1,s2,tall`，
规则给出 `tall,s1,s2`）——**v4、v5、v6 也给出同一结果**，所以这不是 v7 引入的回归。
按几何判它本身有歧义：三个片段的顶边分别是 79/0/0，`tall` 与 `s1` 的水平投影不重叠
（0..240 vs 400..640），两种读法都讲得通。**不再为它改判据。**

**默认只有两个片段时不可能出现严格倒置**（暴力枚举 0 例）——缺陷只在 ≥3 个片段时显现，
这也是早期全是两段夹具的套件一直看不出来的一部分原因。

**客户端套件对顺序规则几乎没有守卫**（实测）：把 v4 写回磁盘重建后，`smoke-canvas-video`（含
C1-C9 徽标/确认卡/合成节点）与 `smoke.mjs` **全部通过**。C8-C9 只覆盖 v1 与 v3 那两类几何。
顺序的唯一真门禁是宿主套件的 V10-V18。这是可接受的——两侧共用同一个 `orderByPosition`，
规则错了两边一起错——但**不要误以为客户端徽标断言能发现规则缺陷**。

**历史版本已存档**：`~/.dsh/patches/clip-order-versions/`（v1–v7 全部 + 本套件快照 + 回滚说明）。
因为中间各版**从未提交**（`231523a` 是唯一碰过该文件的提交，内容就是 v1），
`git show HEAD:src/clip-order.ts` 取到的是 **v1 而不是最新版**——按这条指令做反向验证会用错规则。
`/private/tmp` 会被系统清理，不要把它当依赖。

**V13 的判别力有尺寸边界**（实测）：portrait 片段在 240x320、200x240、240x240 时 V13 都能判别旧
规则，但在 **200x160** 时两边输出相同、**不具判别力**。而 3:4 的**视频**节点自动尺寸正是 200x160
（`nodeSizeFromRatio('3:4', 240x160)` → 200x160）⇒ **未经手动缩放的 3:4 片段不受 V13 保护**。
V13 文档注释里「无需手动 resize」的说法是错的，已由 t13 订正。

**浏览器画序号徽标与宿主建 concat 列表必须调用同一个函数**——两处若各自实现，
用户看到的顺序与实际产物可能不一致，且无法察觉。注意这一条**不能靠套件全绿来保证**：
两侧共用同一函数时，规则错了两边会**一起错**，而旧夹具对两种规则给出相同结果。
新增夹具必须先证明它在旧规则下会失败。

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

#### 8.1 产物节点必须带上 `entryId`（否则画布上的「收藏」是灰的）

`publish()` **必须**把调用方传入的 `id` 用作历史条目 id（`appendVideoHistory` 内部即
`id: input.id`，已如此实现；`clip-compose.ts` 也正是按该 id 回查条目）。

因此 runner 必须把**同一个 id** 写进产物节点的 `metadata.video.entryId`：

```ts
const entryId = newId('compose')
const clip = await composer.publish({ id: entryId, bytes, mime, duration, prompt })
// …节点…
video: { url: clip.url, mime: clip.mime, entryId, ...duration }
```

**为什么不能省**：画布视频节点的「收藏」按钮的可用性完全由 `CanvasVideoRef.entryId`
决定——`src/client/CanvasWorkspace.tsx:4183` 的 `disabled={… || video.entryId === undefined}`
与 `:2404` 的 `if (clip === undefined || clip.entryId === undefined) return` 都会让缺
`entryId` 的节点变成**点不动的灰按钮**（而「加入对话 / 下载 / 抓帧 / 预览」照常可用，
所以这个缺陷在肉眼检查时很容易被漏掉）。生成路径的节点正是靠 `task.resultEntryId`
拿到该字段（`:3106`）。

据此，本功能对用户承诺的「也能收藏进素材库」有**两条**都必须成立：侧栏视频行可收藏
（走 `entry.id`），以及画布产物节点可收藏（走 `metadata.video.entryId`）。

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

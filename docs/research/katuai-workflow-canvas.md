# 咖图AI（katuai.cn）节点式工作流画布调研

调研日期：2026-11-16。原始数据见 `./katuai-samples/`（`catalog.json` 是节点目录，其余是 6 个公开模板的完整 `graph_state`，`kt-imported-full.json` 是用户提供的 `.kt` 文件导入后的全量数据，`source.kt` 是原始密文）。

> **这份文件解决什么**：判断咖图AI 的画布有没有值得移植进本项目画布的东西，结论是"套图批量"和"输入级轮换"两件，其余不跟。
> **它在整体里是哪一环**：竞品调研，只出结论和优先级，不改源码；真要动手时的实施细节走 `docs/tasks/`。
> **三个不显然的取舍**：① 结论建立在**公开模板 + 后端 catalog + 一份用户提供的 `.kt`** 上，那个私有工作流链接打不开（见下），所以"它内部怎么存"是从样本反推的，不是官方文档；② 节点清单是抓的快照（catalog version 21），平台会变，重跑文末命令即可刷新，别把这当成长期契约；③ 那份 `.kt` 是**真的解密不了**（见「`.kt` 导出文件」一节），我是通过登录态把它导入平台、再读回全量 JSON 才拿到内容的，不是破解了加密。

## 结论先说

1. **用户给的链接本身打不开**：`https://www.katuai.cn/workflow-canvas/<32位id>` 是**私有**工作流路由，只有所有者登录后可见。同 ID 走公开接口一律 `404 开放工作流不存在或已下架`，私有接口 `404 工作流项目不存在或无权访问`。公开分享走的是另一个路由 `/workflow-canvas/public/<id>`，那个页面把链接重定向回列表，说明该 ID 未分享。
2. **这个平台的产品形态值得对标的地方不多，但节点目录的设计很干净**：17 个节点、5 个分类、8 种数据类型，全部由后端 `/api/workflow-canvas/catalog` 下发，前端只负责渲染。这是它最值得抄的一点。
3. **它比我们多的是"套图（多提示词批量）"和"多图轮换输入"两件事**，这两个正是它全部模板的主线。我们缺。

## 平台基本信息

| 项 | 值 |
| --- | --- |
| 品牌 | 咖图AI（KATU AI），站点 `www.katuai.cn` |
| 前端资源 | `cdn.lingdong5.com/katu/frontend/dist/`（Vue 3 SPA） |
| 后端形态 | 单体 HTTP API，`/api/...`，nginx |
| 节点目录版本 | `catalog.version = 21` |
| 公开模板 | 6 个（4 个官方 demo + 1 个 45 节点教程 + 1 个批量改图） |
| 模型清单 | `gpt-image-2`、`nano-banana`、`seedream` |
| 计费 | 积分制（`tool_prices` 按工具定价，抠图/放大/清晰修复各 1 点，逆向提示词 2 点等） |

## 节点目录（17 个）

分类：`input` 输入 / `ai` AI 创作 / `image` 图片处理 / `output` 输出 / `other` 其他。

数据类型：`audio` `image` `image[]` `json` `mask` `model` `text` `video` —— 注意 audio / video / mask / model / json 五种**已声明但没有节点使用**，是留给后续的。

| key | 标题 | 输入 | 输出 | 可见字段 | runtime |
| --- | --- | --- | --- | --- | --- |
| `input.image` | 图片输入 | — | `image[]` | images, input_mode(隐藏) | passive |
| `input.prompt` | 文本输入 | — | `text` | content | passive |
| `ai.text_generate` | AI文本生成 | prompt?, reference? | text | system_prompt, prompt | text_generation |
| `ai.image_generate` | AI图片生成 | prompt, reference?(≤6) | image | model, size, ratio, count | image_generation |
| `ai.image_batch_generate` | AI套图生成 | prompt?, reference?(≤6) | `image[]` | model, size, ratio, count | image_generation |
| `image.upscale` | 高清放大 | `image[]` | `image[]` | scale(2倍/4K/8K) | image_process |
| `image.remove_background` | 智能抠图 | `image[]` | `image[]` | mode(主体/头部), bg_color | image_process |
| `image.clarity_enhance` | 清晰修复 | `image[]` | `image[]` | mode(通用/人像) | image_process |
| `image.watermark_removal` | 去水印与区域擦除 | `image[]` | `image[]` | mode(自动/蒙版) | image_process |
| `image.translate` | 图片翻译 | `image[]` | `image[]` | target_language, translation_style | image_process |
| `image.stitch` | 多图拼接 | `image[]` | `image[]` | layout(纵/横/网格), gap, background | image_process |
| `image.reverse_prompt` | 图片反推提示词 | `image[]` | text | language | image_process |
| `image.color_process` | 色彩处理 | `image[]` | `image[]` | mode(上色/色彩增强) | image_process |
| `image.compress` | 压缩图片 | `image[]` | `image[]` | quality, resize_percent, output_format | image_process |
| `output.image` | 图片结果 | `image[]` | `image[]` | output_name, images | passive |
| `output.text` | 文本结果 | text | text | output_name, content | passive |
| `utility.note` | 便签 | — | — | 富文本 content | — |

### 字段层面的两个设计细节

- **隐藏字段承担"用户看不见但引擎要读"的状态**。例如 `ai.image_generate` 的 `prompt`（组合后的提示词）和 `prompt_overridden`、`reference_order`、`reference_group_orders` 全部 `hidden`，不占面板空间，但参与运行。`ai.image_batch_generate` 更极致，9 个字段里 6 个隐藏。
- **`utility.note` 是富文本便签**，模板里所有教程都写在便签里，跟着画布一起传。这比我们把说明放在 README 里更好——复制工作流时说明跟着走。

## `.kt` 导出文件

用户给了一份 `案例演示 - 首次使用必看！！.kt`（131 KB）。格式是：

```
KATU-WORKFLOW-KT/1
<base64 的一整行，134004 字符>
```

**它是真加密，本地解不开**，依据：

- base64 解码后 100503 字节，**熵 7.9982 bits/byte**（8.0 为完全随机）；
- 6281 个 16 字节块**没有一块重复**——排除了"压缩后编码"和"只是异或/混淆"这类可逆变换；
- 文件里没有任何可识别的明文头（不是 gzip/zlib/zip/msgpack 的魔数）。

浏览器端也**不解密**：我把平台前端三个 bundle（`WorkflowCanvasView-*.js`、`WorkflowProjectsView-*.js`、`notifications-*.js`）全搜了一遍，`KATU-WORKFLOW` 这个魔数**一次都没出现**，`crypto.subtle` 的 5 处用途全是 SHA-256 指纹采集和短信验证码的 HMAC 签名，跟工作流无关。导入实现是纯上传：

```js
// 前端只做后缀校验，然后把文件丢给后端
if (!file.name.toLowerCase().endsWith('.kt')) { throw '仅支持后端加密生成的 .kt 文件' }
// POST /api/workflow-canvas/projects/import  (multipart)
```

所以**解密密钥只在服务端**。要拿到内容只有一条路：在已登录状态下导入，再读回。我这么做了，读到的全量 JSON 存在 `katuai-samples/kt-imported-full.json`；导入产生的临时项目（`6cda84db…`）读完就删了，用户自己那份（`abf3e745…`，19:11 创建）保留。

**它和公开模板 `ssssbf0db5374de6911c664b8e49c96x` 是同一个东西**：45 节点、29 边、节点 key 序列和 `custom_name` 逐一相同、边按 handle 对排序后完全相同。唯一差别是 `result_snapshot`——`.kt` 有 25 个节点带运行结果，公开版只有 14 个，因为用户导入的这份跑过更多任务。**结论：这份 `.kt` 没有提供公开模板之外的新结构信息，但它把"运行后长什么样"补全了。**

## 数据结构

三个版本号各管一摊：

```jsonc
{
  "project_id": "…",
  "schema_version": 1,      // 存储结构版本
  "state_version": 1030,    // 每次保存 +1（并发控制用）
  "preview_state": {        // 列表页缩略图：只带 id/x/y/w/h/kind 和边
    "version": 1, "nodes": [...], "edges": [["a","b"]], "groups": [...], "bounds": {...}
  },
  "graph_state": {          // 打开画布时取全量
    "version": 1,
    "viewport": { "x": 0, "y": 0, "zoom": 0.4261 },
    "nodes": [ { "id", "definition_key", "definition_version", "position": {x,y}, "data": {...}, "result_snapshot": {...} } ],
    "edges": [ { "id", "source", "source_handle", "target", "target_handle" } ],
    "groups": [...]
  }
}
```

**要点：边的两端是 `handle` 名，不是索引。** 端口由 catalog 的 `inputs[].id` / `outputs[].id` 定义（如 `image` → `reference`、`text` → `prompt`），所以一个节点可以有多条同方向边而不会歧义。我们的画布目前用 `CanvasConnectionRole` 表达类似语义，但没有把"端口 id"抽出来做成可下发的契约。

`result_snapshot` 是**把运行结果写回节点本身**（`run_status` + `image_tasks`），所以公开模板打开就能看到当时的产出图和命名（`正面视图 · 第1张`），不需要重跑。这是"模板即案例"的关键。

## 六个公开模板在做什么

| 模板 | 节点/边 | 组成 |
| --- | --- | --- |
| 电商套图生成、人物三视图 | 7/4 | 2×(`input.image` → `ai.image_batch_generate` → `output.image`) + 便签 |
| Ai图片生成 + 图像处理 | 5/4 | `input.image` + `input.prompt` → 生图 → 放大 → 输出 |
| 静态图片分层，产出透明背景图层 | 6/4 | 套图生成（8 个分层提示词）→ 抠图 → 输出 |
| 漫剧宫格图生成并拆分 | 5/3 | 生图（九宫格排版）→ 套图生成（9 个格子）→ 输出 |
| 批量改图 | 9/6 | 4×`input.image` + 2×生图（1×N 与 M×N） |
| 案例演示（教程） | 45/29 | 上面全部 + 单图/图生图/透明背景/超分等 |

全局节点使用频次：`output.image` 24、`input.image` 17、`ai.image_generate` 12、`utility.note` 9、`ai.image_batch_generate` 8、`image.remove_background` 3。

**17 个节点里只有 8 个被用过；另外 9 个在 6 个模板里一次都没出现**（`ai.text_generate` `image.clarity_enhance` `image.color_process` `image.compress` `image.reverse_prompt` `image.stitch` `image.translate` `image.watermark_removal` `output.text`）。用过的 8 个里，前 5 个（`output.image` / `input.image` / `ai.image_generate` / `utility.note` / `ai.image_batch_generate`）占了 77 个节点中的 70 个。

这个平台的真实主线就是：**提示词 → 生图 → 套图批量 → 输出**。它把 17 个节点列在目录里，但**一半以上的节点是没人用的摆设**——这恰好反证了做工具时该先做哪几个。

### 那份 45 节点教程是怎么组织的

它把 5 个独立案例摆在同一张画布上，每个案例是一个**编组**（`groups[]`），带名字和主题色：

```jsonc
{ "id": "…", "name": "基础案例-5：批量改图(可用于任何领域改图)",
  "node_ids": ["…9 个 id…"], "group_ids": [], "color": "#ec4899" }
```

`group_ids` 是嵌套子组，这份数据里全是空数组——说明它支持嵌套但没用。配色的用法：5 个组分别是 `#8b5cf6` 紫 / `#3b82f6` 蓝 / `#14b8a6` 青 / `#f59e0b` 橙 / `#ec4899` 粉。

每个组里第一个节点都是 `utility.note`，写这个案例的操作步骤（`<h1>` 标题 + `<ol>` 步骤 + 关键提示词原文）。**这是"模板即教程"的完整形态：一张画布既是 5 个可跑的例子，又是自己的说明书。** 我们如果做便签节点，值得照这个用法设计——便签不是装饰，是模板的第一公民。

节点/边的量级参考：45 节点只有 29 条边，因为套图节点一个节点吃一整个提示词数组，不需要为每条提示词画一条链。

## 两个真正值得学的机制

### 1. AI套图生成（`ai.image_batch_generate`）

一个节点自带一组"带标题的提示词"，然后批量出图：

```jsonc
"prompt_items": [
  { "id": "prompt-…", "title": "正面视图", "prompt": "以参考图为人物基准，保持…生成正面全身视图。" },
  { "id": "prompt-…", "title": "侧面视图", "prompt": "…生成侧面全身视图。" },
  { "id": "prompt-…", "title": "背面视图", "prompt": "…生成背面全身视图。" }
]
```

两种创建方式（`prompt_creation_mode`）：

- `manual`：手填每一条。
- `ai`：只填一句 `plan_demand`（"帮我生成这个商品的模特试戴图，商品细节图以及参数页的图"），点「AI生成提示词组」，后端按需求拆成一组合格提示词，每条可再编辑。

关键在**输出命名空间**：批量结果按 `logical_task_title` + `output_index` 命名（`正面视图 · 第1张`），并带 `logical_task_total`。所以下游 `output.image` 拿到的是**有序、有语义名字**的一组图，不是一堆 UUID。

我们现在的 `config` 节点是 `count: 1-4` 张同一提示词，没有"多组不同提示词共用一个参考图"的概念。这是我们和它最大的差距。

### 2. 轮换输入（`input.image.input_mode = 'batch' | 'rotate'`）

`input.image` 有一个默认隐藏的 `input_mode`：

- `batch`：多张图**全部**喂给下游，作为一组参考图。
- `rotate`：多张图**轮流**喂，每张图各跑一次生成任务。

配合 `reference_group_orders`，两个 `input.image` 都开 rotate 时，产出是 M×N（模板里 1×N 和 M×N 两个例子）。提示词里用 `【@图1 单个产品图】` / `【@图2 多个电商模板图】` 的占位语法引用具体输入。

**M×N 展开的确切规则**（从 `.kt` 里的 8 组数据反推）：两路 rotate 各 2 张和 4 张，`reference_group_orders` 正好 8 条，且排列是**笛卡尔积、第二路快变**：

```jsonc
"reference_order": ["source:node-…-8", "source:node-…-9"],
"reference_group_orders": {
  "node-…-8:0|node-…-9:0": ["node-…-8:0", "node-…-9:0"],
  "node-…-8:0|node-…-9:1": ["node-…-8:0", "node-…-9:1"],
  "node-…-8:0|node-…-9:2": ["node-…-8:0", "node-…-9:2"],
  "node-…-8:0|node-…-9:3": ["node-…-8:0", "node-…-9:3"],
  "node-…-8:1|node-…-9:0": ["node-…-8:1", "node-…-9:0"],
  …共 8 条
}
```

key 是"每一路取第几张"用 `|` 拼起来，value 是按 `reference_order` 排好的具体图片索引。**注意 1×N 那个节点这两项都是空的**——单向 rotate 不需要显式记录，按数组顺序展开即可。所以实现时可以只做"哪几路在 rotate"这一个判断，M×N 才落需要展开表。

**顺带发现一个平台的 bug**：这些 `node-1786873977425-8` 形态的 id 在 `graph_state.nodes` 里**一个都找不到**（节点真实 id 是 32 位 hex）。它们是画布前端临时生成的 id，`reference_group_orders` 保存/导入时没有重新映射成真实节点 id。后果是这类 M×N 工作流导出再导入后，那 8 组展开表全部指向不存在的节点——如果后端按 id 查图就会退化成"按顺序取"。复现时别把它当成正确契约抄。

**为什么这个设计比"生成节点上加个批量开关"好**：`input_mode` 长在**输入源**上，所以它对任意下游节点都生效——今天接生图，明天接抠图、接放大，批量语义自动跟着走，不需要每个节点各实现一套。这是它最值得抄的一句设计判断。

## 与我们的对比

| 能力 | 咖图AI | 本仓库（画布） |
| --- | --- | --- |
| 节点类型 | 17 个，后端 catalog 下发 | 6 个 `CanvasNodeType`（`src/protocol.ts:1188`：image/text/file/config/video/storyboard），前端写死；`sketch`/`pose`/`annotation` 是挂在 `type:'image'` 节点上的 `metadata` 字段，不是独立类型 |
| 端口契约 | `${node}.${handle}` + `data_type` | `CanvasConnectionRole`（`src/protocol.ts:2056`：input/first/last/reference），无 data_type |
| 多提示词套图 | ✅ `ai.image_batch_generate` | ❌ 只有 `metadata.count`（1–4 张，同一提示词） |
| 输入级批量/轮换 | ✅ `input_mode = batch/rotate` | ❌ |
| 结果快照回写节点 | ✅ `result_snapshot` | 部分（`metadata.asset` / `video` + `status`） |
| 画布内教程 | ✅ `utility.note` 富文本 | ❌ 无便签节点 |
| 分享 | 8 位分享码 + `.kt` 加密文件 + 公开模板 | 无 |
| 本地抠图 | `image.remove_background`（服务端，1 咖豆） | ✅ `src/client/image-ops.ts:272 removeBackground` + `autoRemoveBackground:404`，纯本地 canvas 算法，透明 PNG |
| 图层拆分 | 用套图生成 + 8 条提示词"假装"拆分，再逐个抠图 | ✅ `src/layer-analyzer.ts` + 「图层拆分」动作，直接产出多个可编辑图层节点 |
| 图片超分 / 清晰修复 / 去水印 / 上色 / 压缩 | 5 个独立节点 | ❌ 无（`clarity` 在 `src/engine.ts` 指的是清晰度档位，不是修复） |
| 图片翻译 / 图片拼接 | 2 个节点 | ❌ 无（`stitch` 只有视频侧：`src/clip-compose.ts`） |
| 视频 | catalog 声明了 `video` 类型，**但零个视频节点** | ✅ 完整视频链（生视频、`storyboard` 分镜、`clip-compose` 拼接） |
| Agent 工具 | 无 | ✅ `agent-canvas-tools.ts` / `agent-image-tools.ts` / `agent-video-tools.ts` |

**这张表里最反直觉的一格是"图层拆分"**：咖图AI 用套图生成 + 8 条手工调过的提示词 + 逐个抠图，绕了一圈做到"静态图分层"；我们 `src/layer-analyzer.ts` 是直接分析出图层结构、产出多个节点。同一个效果，它是"用提示词骗出来的"，我们是"当结构化问题解的"。这一格不要照抄它的做法。

**我们在视频、画板、姿势人偶、标注、图层拆分、本地抠图上更强；它在"套图批量"和"输入级轮换"上更完整。** 后者恰好是电商运营最常用的入口，也是我们唯一该补的两个。

## 如果要跟进，建议的顺序

1. **输入级 `rotate` 语义**（收益最大、改动面最小）：给图片输入节点的连接角色加一个"轮换"位，运行器按上游图片数笛卡尔展开任务。纯执行器逻辑，`CanvasConnectionRole` 只有一个 `reference` 语义要扩，**不新增 UI 面板、不加节点类型**。参照 `/Users/malang/chajian/dsh-imagegen-video/src/protocol.ts:2056` 和 `src/client/canvas/node-model.ts` 的连接读取处。
2. **套图节点 / 或给 `config` 节点加"提示词组"模式**：一组带标题的提示词共享参考图，输出按标题命名。这是从"一次一张"到"一次一套"的跨越。**注意和现有 `metadata.count` 的区别**——`count` 是"同一提示词出 N 张"，套图是"N 条不同提示词各出一张"，语义不同，不要把它做成 `count` 的扩容。
3. **便签节点**：画布内富文本说明。咖图AI 的用法值得照抄——每组第一个节点就是便签，写操作步骤和关键提示词原文，模板自带教程。
4. 其余 7 个图片处理节点（清晰修复、去水印、翻译、拼接、上色、压缩、反推提示词）**优先级最低**：它们在咖图AI 自己的 6 个模板里**零使用**。超分用了 2 次、抠图用了 3 次，也已经够少了。**不要因为"它列了 8 个处理节点"就当作它的强项**。

不建议跟的：分享码体系（我们要处理的是内部共享，不是对外分发）、积分计费、`reference_group_orders` 那套 id 方案（见上面的 bug）。

## 复现方式

```bash
# 公开模板列表
curl -s 'https://www.katuai.cn/api/workflow-canvas/public-projects?page=1&page_size=50&sort_by=comprehensive'

# 单个模板（含完整 graph_state）
curl -s 'https://www.katuai.cn/api/workflow-canvas/public-projects/workflow-official-demo-02'

# 节点目录
curl -s 'https://www.katuai.cn/api/workflow-canvas/catalog'
```

私有工作流需要登录态（`Authorization: Bearer <token>`，token 在 `localStorage.token`），无权限时返回 `404 工作流项目不存在或无权访问`。

### `.kt` 文件怎么读

解密密钥只在服务端，前端只做后缀校验然后 multipart 上传，所以没有本地解法。可行的路径只有一条——登录态下导入再读回：

```bash
# 1. 导入（multipart，字段名 file）
curl -s -X POST 'https://www.katuai.cn/api/workflow-canvas/projects/import' \
  -H "Authorization: Bearer $KATU_TOKEN" \
  -F "file=@案例演示 - 首次使用必看！！.kt"
# -> { "project_id": "…" }

# 2. 读回全量 graph_state
curl -s "https://www.katuai.cn/api/workflow-canvas/projects/<project_id>" \
  -H "Authorization: Bearer $KATU_TOKEN"

# 3. 清理（可选；导入会占一个项目位）
curl -s -X DELETE "https://www.katuai.cn/api/workflow-canvas/projects/<project_id>" \
  -H "Authorization: Bearer $KATU_TOKEN"
```

第 2 步拿到的东西存成了 `katuai-samples/kt-imported-full.json`，第三节「`.kt` 导出文件」记了它和公开模板的差异。

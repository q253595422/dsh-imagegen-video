# 契约：画布视频「与生图对等」改造（第四轮）

本文件冻结本轮四件事的接口。成员按文件归属并行推进；**撞车即失败**，所以先读归属表。

用户原话（m06154 / m06222）：
> 你看下我们无限画布
> 视频已能放进画布，但点击后无法直接查看 / 找不到拼接功能在哪 / 视频也要像生图那样有同样的功能

用户已选定范围（四项全做，不要自行增删）：
1. 底部拼接提示条 → **真的可点按钮**
2. 视频节点右键菜单补 **预览 / 下载**
3. 画布内新增 **「添加视频」入口**
4. 视频节点悬浮工具条补 **模型选择 / 重新生成**

---

## 0. 一句话

视频节点目前是**二等公民**：它的功能散落在别处、入口要靠悬停才出现、唯一能点的提示条是假的。本轮把它抬到与图片节点对等，并修掉两个已证实的真缺陷。

---

## 0.1 文件归属（硬边界，越界即回滚）

| 文件 | 归属 |
|---|---|
| `src/client/locales.ts` | **队长**（已完成，见 §2） |
| `docs/parity-contract.md`（本文件） | **队长** |
| `src/client/ImageGenPanel.tsx` | **队长** |
| `src/clip-compose.ts` | **host-clip** 成员 |
| `scripts/smoke-compose.mjs` | **host-clip** 成员 |
| `src/client/CanvasWorkspace.tsx` | **canvas-actions** 成员（A → D → 接线，**同一文件必须串行**） |
| `src/client/canvas-workspace.module.css` | **canvas-actions** 成员 |
| `scripts/smoke-canvas-video.mjs` | **canvas-actions** 成员 |
| `src/client/CanvasVideoPicker.tsx` | **picker-ui** 成员 |
| `src/client/canvas-video-picker.module.css`（新建，已存在） | **picker-ui** 成员 |
| `scripts/smoke-video-picker.mjs`（新建） | **picker-ui** 成员 |
| `package.json` | **队长**（test 链） |

**没有任何成员可以 commit**，队长统一提交。

**为什么 `CanvasWorkspace.tsx` 只有一个主人**：A、D、接线三件事都改这个 5465 行文件。上一轮把它交给两个成员会直接互相覆盖。三件事由同一成员**按 A → D → 接线 的顺序**做完；中途不得并行。

### 0.2 为什么分两波（已实测的构建事实）

`lib/client.js` 是**单一 CJS bundle**，只包含被 import 到的模块。`CanvasVideoPicker.tsx` 只有在**被 `CanvasWorkspace.tsx` import 之后**才会进入 bundle，而套件全部通过加载 `lib/client.js` 来驱动客户端。

⇒ **picker-ui 在接线落地前无法为自己的组件写任何套件**（组件不在 bundle 里，`smoke-video-picker.mjs` 无从挂载）。

因此分两波：

| 波次 | 任务 | 归属 | 依赖 |
|---|---|---|---|
| **W1** | t1 缺陷 B（两个 store） | host-clip | 无 |
| **W1** | t2 拾取器组件本体（`CanvasVideoPicker.tsx` + 自己的 CSS） | picker-ui | 无（**不写套件**） |
| **W1** | t3 任务 A（底部拼接条 → 真按钮） | canvas-actions | 无 |
| **W2** | t4 任务 D + 任务 C 接线（含 `import` 与挂载拾取器 + smoke-canvas-video 新用例） | canvas-actions | t2, t3 |
| **W2** | t5 拾取器套件（`scripts/smoke-video-picker.mjs`） | picker-ui | **t4**（等 import 进 bundle） |
| **W2** | t6 独立验证（B/A/C/D 四项 + 四次反向验证） | compose-verifier | t1, t4, t5 |

**t4 的 `import` 是 t5 的硬前置**：canvas-actions 必须在 t4 里落下
`import { CanvasVideoPicker } from './CanvasVideoPicker.tsx'`
并把组件挂到渲染树里，否则 t5 永远拿不到组件。

---

## 1. 已实测钉死的事实（不要重新推断）

### 1.1 缺陷 B（真缺陷，已可执行复现）：素材库里收藏的片子**无法参与拼接**

`src/clip-compose.ts:259-270` `videoFileFrom()` 只接受 `${VIDEO_API.file}/` 前缀：

```ts
if (!pathname.startsWith(`${VIDEO_API.file}/`)) return undefined
```

而素材库里的片子由 `src/gallery-store.ts:235-240` `toWire()` 生成，前缀是 **`${GALLERY_API.videoFile}/`**（`/api/dsh-imagegen/gallery/video-file/`），落在 `gallery/videos/`；两个 store 的目录不同（`videos/files/` vs `gallery/videos/`）。

队长实测（`/private/tmp/defectB2.mjs`，调用**真的** `createClipComposer()`，两个文件都真实存在于磁盘）：

```
history file that EXISTS    -> ~/.dsh/dsh-imagegen/videos/files/811e60f2-…-0.mp4
gallery file that EXISTS    -> UNDEFINED
```

⇒ 用户把片子收藏进素材库、再拖到画布上选两段拼接，`resolve()` 返回 undefined，`stitchClips` **故意** throw（见 §1.2），整个 run 失败。**「收藏」这个动作把片子变得不可拼接**。

修法已在 `/private/tmp/defectB-fix.mjs` 实测（两个 store 都命中，且仍拒绝穿越与外部 URL）：

```
RESOLVES 811e60f2-…-0.mp4  [video store]
RESOLVES da599d10-…-0.mp4  [gallery store]
REJECT           /api/dsh-imagegen/gallery/image/a-0.png
REJECT           https://evil.example/x.mp4
REJECT           /api/dsh-imagegen/video/file/../../etc/passwd
```

### 1.2 缺失片段必须让整个 run 失败（不得改成跳过）

`src/skill-runner.ts` `stitchClips` 里 `composer.resolve(url)` 返回 undefined 即 throw `composeFailed`。注释原文：**Never skip a clip that cannot be read**。理由：静默跳过会让用户选 5 段却拿到 3 段的成片，且没有任何提示。**这条不许动。**

### 1.3 缺陷 A（真缺陷，用户原文即证据）：底部拼接条是**假的**

`src/client/CanvasWorkspace.tsx:4833-4837` 是**纯 div + 两个 span，没有任何 button**：

```tsx
<div className={css.composeBar} data-compose-bar="" data-canvas-no-zoom="" aria-live="polite">
  <span className={css.composeBarIcon} aria-hidden="true">⛓</span>
  <span>{tt('canvas.composeBar', { count: composeIds.length })}</span>
  <span className={css.composeBarOrder}>{composeGlyphs(composeIds.length)}</span>
</div>
```

而 CSS `src/client/canvas-workspace.module.css:2932` `.composeBar { … **pointer-events: none** }`。

⇒ 用户选中 2 段，看到「按画布位置拼接 · 2 段 ⛓ ①②」，去点它，**什么都不会发生**（连 hover 态都没有）。他因此认为「拼接功能没做」。这是「找不到拼接功能在哪」的第一原因。

### 1.4 拼接入口目前只有两条，且都是隐藏路径

| 入口 | 位置 | 可见性 |
|---|---|---|
| 悬浮工具条「技能」图标 | `:4338-4343`（`{skillable ? … : null}` 块内） | 只在 `.node:hover` / `.nodeSelected` 时可见（`.hoverToolbar { opacity:0; pointer-events:none }`，`:1064`） |
| 右键菜单「技能」 | `:4686-4688` | 需要先想到右键 |

且 `SkillPicker.compatible()`（`:605-609`）对 compose 要求 `props.composeCount >= 2` ⇒ **只选中 1 段时那一行是灰的**，提示文案是通用的 `canvas.skills.incompatible`，**不告诉用户「先选两个片段」**。这是第二原因。

### 1.5 缺陷 D：视频节点功能不对等（逐项实测）

| 功能 | 图片节点 | 视频节点 |
|---|---|---|
| 悬浮工具条 | annotate / removeBg / layers / **ModelPicker** / expand / download（`:4325-4343`） | download / grabFrame / favorite / expand（`:4316-4321`）——**无模型选择、无重新生成** |
| 右键菜单 | 预览 + 下载（`:4675-4678`） | **完全没有 video 分支**（`:4670-4690`），只剩「技能/复制/删除」 |
| 双击 | `openImageNode`（`:4098-4109`） | `setVideoPreviewNodeId` ✓（双方都有） |

`retryVideoGeneration`（`:3026-3070`）**已经存在且能工作**：读 `metadata.prompt` / `resolveModelChoice(videoGroups ?? [], …)` / 重发 `metadata.videoMode ?? 'text'`。它已被失败态的重试按钮使用（`:4210` 附近）。**所以「重新生成」不需要新逻辑，只需要一个新入口 + 一个模型选择器**（选中的模型要 `patchNode` 进 `metadata.model` / `metadata.channelId`，`retryVideoGeneration` 已经在读这两者）。

### 1.6 缺陷 C：画布内完全没有「添加视频」入口

坞站 13 个按钮（`:4841-4907`）无「加视频」。`imageMenu` 四项（`:4913-4925`）全部只服务图片。拾取器 `ImagePicker`（`:5393`）的 `accept="image/png,image/jpeg,image/webp,image/gif"`，网格只渲染 `<img>`，`addSelected()` 只调 `api.canvasImport(…)` ⇒ 视频历史 / 素材库里的片段在这一页完全看不到。

目前唯一把视频放进画布的路径是**侧栏**（`src/client/ImageGenPanel.tsx:2437` `data-history-video-canvas` → `addClipToCanvas` → 面板设 `canvasImportRequest` → 画布 `:3317-3344` effect 建引用型 video 节点）。

### 1.7 引用式导入（不许改成复制字节）

`CanvasWorkspaceProps.importRequest` 的 video 分支（`:113-116` 注释 + `:3317` effect）：video 节点只带 `{ url, mime, duration? }`，**不设 `metadata.asset`**。理由：片子比图大几个数量级，且 video store / gallery store 的路由**已经支持 Range**（`src/routes.ts:638` `serveClip`，206 + `content-range`）。任何把片段字节塞进画布资产库的做法都是错的。

### 1.8 `ToolbarIconName` 是闭集（`:520`，`:628` 注释明写）

现有：`new select pan image text file sketch eraser trash undo redo fit minimap background template download duplicate sparkle send close deleteProject annotate removeBg layers bold color skill upload expand favorite favoriteFilled`。

**禁止发明新名称。** 新增 UI 只能用上表里的图标（`sparkle` 已被 heavy/local 与生成共用；`expand`=预览；`download`=下载；`redo`=重新生成；`image`=添加图片；`file`=文件；`skill`=技能）。

### 1.9 拖入的视频文件会成为 **file 节点**，不是 video 节点（已知限制，本期不扩大）

`onDrop`（`:3884-3908`）只把 `file.type.startsWith('image/')` 走图片路径，其余全走 `uploadCanvasFile` → `file` 节点。`CanvasFileBody` 对 `video/*` 确实渲染 `<video>`（`src/client/CanvasFilePreview.tsx:355-357`），所以**能播**；但 `composeClipIds`（`:87-90`）与宿主 `runCompose` 都过滤 `node.type === 'video'` ⇒ **拖进来的片子不能参与拼接**。

本期**不修**（拖入→video 节点会牵扯 file 节点的语义与 `putFile` 的 mime 推断）。但这条必须写进用户可见的说明，不能让用户拖进来再困惑为什么拼不了。

### 1.10 CSS Modules 会哈希类名

选择器必须锚在 `data-*` 上。**写错 class 名是静默失效**（无样式、不报错）。本契约所有新锚点都写成了 `data-*`。

### 1.11 套件加载的是 `lib/`（构建产物）不是 `src/`

改完 src **必须** `pnpm build` 再跑套件，否则得到假绿/假红。`pnpm test` 已含 build。一律 `scripts/with-lock.sh pnpm test`（并发 build 会互相写坏 `lib/`，两个 jsdom 套件并发会 OOM exit 137）。

### 1.12 jsdom 里 `:not()` 会遍历整棵子树 ⇒ OOM exit 137

用显式数组过滤：`[...view.querySelectorAll('article')].filter(...)`。

**同族的第二个 OOM 陷阱（picker-ui 在 t8 实测）**：`assert.equal(domNode, null)` **失败**时，Node 会去 inspect 那个 jsdom 元素，遍历环形 DOM ⇒ OOM，表现为 **exit 137 且 stdout 全空**，看着像「组件崩了」，实际是断言写得不可读。改用布尔比较（`assert.equal(node === null, true)`）+ **逐条即时输出**，不要攒到最后一次打印。

### 1.13 读取失败 ≠ 空列表（t8 的真缺陷，已修）

`CanvasVideoPicker` 的 `loadHistory` 在 catch 里 `setHistory([])`，所以 `empty === clips.length === 0` **无法区分**「确实没有片段」和「读取失败，不知道有没有」。原实现把空态文案无条件渲染在错误行之上，用户同时看到：

```
这里还没有可用的视频          ← 假话
读取视频列表失败：network down
```

修法（`src/client/CanvasVideoPicker.tsx:213`）：`showEmptyCopy = empty && !(tab === 'history' && historyError !== null)`，错误行 + retry 从 `empty` 分支**提出去独立渲染**。

> 🚨 门控里的 `tab === 'history'` **不是废话**：`gallery` 的数据来自 props，不可能读取失败，写成朴素的 `!(historyError !== null)` 会把 **gallery 的空态文案一起吞掉**。t8 专门写了区分性用例钉住这一点（`gallery: []` 且 history 失败 ⇒ gallery 仍显示空态、不显示 history 错误行）。

---

## 2. 共享文件（队长所有，已完成）

### `src/client/locales.ts`（已完成，zh/en/ru 各 13 个 key）

新增（三语齐备，`grep -c` 各为 3）：

| key | zh |
|---|---|
| `canvas.composeStart` | 拼接这 {count} 段 |
| `canvas.composeUnavailable` | 拼接功能当前不可用（{reason}） |
| `canvas.addVideo` | 添加视频 |
| `canvas.videoPicker` | 添加视频 |
| `canvas.videoPickerUpload` | 本地上传 |
| `canvas.videoPickerHistory` | 视频历史 |
| `canvas.videoPickerGallery` | 素材库 |
| `canvas.videoPickerEmpty` | 这里还没有可用的视频 |
| `canvas.videoPickerAdd` | 加入画布 |
| `canvas.videoPicked` | 已选 {count} 段 |
| `canvas.videoUploadFailed` | 视频上传失败：{message} |
| `canvas.videoRegenerate` | 用当前模型重新生成 |
| `canvas.videoNodeModel` | 本节点使用的视频模型（重新生成时默认使用） |

（en / ru 见文件；测试要断言文案时**只断言中文**，宿主默认语言实测为英文但这不影响客户端 `tt`。）

**已有可复用 key**：`canvas.composeConfirm`「开始拼接」、`canvas.skills.composeTooFew`、`canvas.skills.composeNoFfmpeg`、`canvas.videoDownload`「下载视频」、`canvas.videoPreview`「放大预览」、`canvas.videoGrabFrame`、`canvas.videoFavorite`、`canvas.videoRetry`「重试」、`canvas.addToCanvas`「加入画布」、`canvas.videoNoModel`、`canvas.needApi`、`canvas.preview.expand`、`canvas.download`、`canvas.untitledWork`。

### `src/client/CanvasVideoPicker.tsx`（**骨架已冻结**，由 picker-ui 填充）

队长已落一个可编译、可关闭、带全部 `data-*` 锚点的骨架。props 签名**字节冻结**，接线方按它编译：

```ts
export interface CanvasVideoPickerProps {
  api: ImageGenApi
  gallery: HistoryEntry[]          // 有 .video 的条目即片段
  onClose: () => void
  onAddClip: (clip: { url: string; mime: string; duration?: number; title?: string }) => void
}
```

---

## 3. 任务 A（canvas-actions）：底部拼接条 → 真按钮

### 3.0 🚨 门控更正（这条是契约原文的错，2026-10-14 发现）

契约初版写「技能描述符取不到时按钮 `disabled`」。**那是错的** —— 它把「按了没反应」换成「永远灰着」，同一个 bug 换个长相。

实测依据：

```
$ grep -n "useEffect" -A6 src/client/CanvasWorkspace.tsx | grep loadSkillCatalog
(空)
```

`src/client/CanvasWorkspace.tsx:1934` 的 `loadSkillCatalog` **只在 `openSkillMenu`（`:2067`）与几个安装/配置回调里被调用**，**没有任何 mount 时的加载**；`skillCatalog` 初值是 `null`（`:1312`）。⇒ 用户在新开 / 刚载入的画布上选中 2 段时 `skillCatalog` 仍是 `null`，按钮会**一直灰着**，除非他先去点某个节点的「技能」菜单。这就是用户报的同一个病。

**正确做法**：底部按钮**自己负责把目录加载过来** —— 当 `composeIds.length >= 2` 且 `skillCatalog === null` 时，在 effect 里调 `loadSkillCatalog()`。

- **不要**改成 mount 时无条件加载（对从不选两段的用户是白花一次请求，超出范围）
- **不要**用 `disabled` 当默认态
- 只有 `skillCatalog !== null` 且真的找不到 compose 条目（宿主给了 `reason`）时才 `disabled` + `canvas.composeUnavailable`
- 回退文案一律 `canvas.composeUnavailable` + reason，**不许静默无反应**

**必须有的断言**：在**从未打开过技能菜单**的画布上选中 2 段 → 点击底部按钮 → 观察到确认卡（`data-compose-card`）。这正是用户报的场景，也是本任务唯一真正的验收。

### 3.1 锚点

**注意**：不能用 `data-compose-run` —— 它已被确认卡占用（`:1090`）。用**新锚点**：

- `data-compose-bar` 保留在外层容器上（现有 C3 断言读它的 `textContent`，**不许破坏**）
- 新增 `data-compose-bar-run` 放在新 button 上

点击行为：等价于用户走既有的 `pickSkill(compose技能, …)` 路径 —— 即
`setPendingSkill({ skill, nodeIds: composeIds, instruction: '' })`，也就是**弹出既有确认卡**，由用户再点「开始拼接」。

**为什么只到确认卡、不直接开跑**：确认卡是用户唯一能核对 ①②③ 顺序的机会（契约 §7 原文）。直接开跑会跳过它。

`composeIds` 就是已有的 `composeClipIds(document.nodes, selectedIds)`（`:87`）。技能描述符从 `skillCatalog?.skills.find(skill => skill.id === COMPOSE_SKILL_ID)` 取 —— **门控方式见 §3.0，不要用「取不到就 disabled」**。

CSS：`.composeBar` 的 `pointer-events: none` 必须去掉（或改为容器仍 none、button 单独 `pointer-events: auto`——两种都行，但**必须实测按钮真的可点**）。

**不得破坏**：`scripts/smoke-canvas-video.mjs` 的 C1（`data-compose-bar` 文案「按画布位置拼接 · 2 段」）、C2（徽标 `pointerEvents === 'none'`）、C3。

---

## 4. 任务 D（canvas-actions）：视频节点与图片节点对等

### 4.1 悬浮工具条（`:4316-4321` 块）

在现有四个按钮前插入：

1. `<ModelPicker variant="toolbar" groups={videoGroups ?? []} value={resolveModelChoice(videoGroups ?? [], { channelId: metadata.channelId, model: metadata.model }, defaultChannelId)} onChange={choice => patchNode(node.id, { model: choice.model === '' ? undefined : choice.model, channelId: choice.channelId === '' ? undefined : choice.channelId })} … />`
   - `channelLabel={tt('model.channel')}`、`modelLabel={tt('video.model')}`、`emptyLabel={tt('canvas.videoNoModel')}`、`ariaLabel={tt('canvas.videoNodeModel')}`
   - **图标/文案与图片节点一致**（`variant="toolbar"`），使两者视觉对等
2. `<IconButton name="redo" label={tt('canvas.videoRegenerate')} disabled={busyLabel !== undefined || (metadata.prompt ?? '') === ''} onClick={() => { void retryVideoGeneration(node) }} />`

`redo` 图标是现成的（`ToolbarIconName` 闭集内）。`busyLabel !== undefined` 的门与同排其它按钮一致。

**注意**：视频节点的 `metadata.model` 存的是**视频别名**，必须用 `videoGroups`（不是 `modelGroups`）解析，否则选择器显示空。`retryVideoGeneration` 已经在用 `videoGroups ?? []`（`:3030` 附近）。

### 4.2 右键菜单（`:4670-4690` 的 node 分支）

在 image / file 两个分支之后、`node.type !== 'config'` 的技能项之前，插入 video 分支：

```tsx
if (node !== undefined && node.type === 'video' && (videoOf(node)?.url ?? '') !== '') {
  items.push({ label: tt('canvas.videoPreview'), icon: 'expand', action: () => { setVideoPreviewNodeId(node.id) } })
  items.push({ label: tt('canvas.videoDownload'), icon: 'download', action: () => { downloadVideoNode(node) } })
}
```

用现成文案（`canvas.videoPreview` / `canvas.videoDownload`），与悬浮工具条**同一对动作**，不新造词。

---

## 5. 任务 C（picker-ui + canvas-actions 接线）

### 5.1 picker-ui：`CanvasVideoPicker.tsx`（填充骨架）

三个页签，**顺序固定 `upload` / `history` / `gallery`**：

| 页签 | 内容 | 数据来源 |
|---|---|---|
| `upload` | 本地文件 `<input type="file" accept="video/*">` + 拖放 | `api.canvasFileUpload(file)` → `CanvasAssetRef` |
| `history` | 视频历史里的片段 | `api.videoHistoryList()`（**组件自己取**，不新增 props） |
| `gallery` | `props.gallery` 里带 `.video` 的条目 | props（面板已经有了） |

**锚点（测试依赖，不可改名）**：
- 根容器 `data-video-picker=""`
- 关闭按钮 `data-video-picker-close=""`
- 页签按钮 `data-video-tab="upload|history|gallery"`
- 每张片段卡 `data-video-card=""`，且卡上带 `data-clip-url={url}`
- 卡片内的 `<video preload="metadata" muted playsInline>`，**src = 该片段的 served url**
- 「加入画布」 `data-video-add=""`
- 空态 **`data-video-picker-empty=""`**

> ⚠️ **空态锚点必须带 `picker` 前缀**（原来我写的是 `data-video-empty`，那是**错的**）。
> `src/client/CanvasWorkspace.tsx:4217` 的视频节点占位**已经**用了 `data-video-empty=""`：
> ```tsx
> : <div className={css.nodeState} data-video-empty=""><span>{tt('canvas.videoEmptyNode')}</span></div>
> ```
> 两者同名 ⇒ 任何 `view.querySelector('[data-video-empty]')` 都会命中画布节点而不是拾取器，而且**命中哪个取决于渲染顺序**（画布先挂载），套件会静默测错对象。这正是契约 §1.10 说的那类「不报错但错」的坑。
> 改名后，`data-video-empty` **只属于画布视频节点占位**，`data-video-picker-empty` **只属于拾取器**。
> 写套件时仍然建议整个选择器限定在 `[data-video-picker]` 内（双保险，且更可读）。

**上传路径的语义（重要）**：本地视频上传走 `api.canvasFileUpload(file)` 拿到 `CanvasAssetRef`（`url` 形如 `/api/dsh-imagegen/canvas/asset/<sha>.mp4`）。这是**画布资产**，**不是** video store 的片段 ⇒

- 加入到画布后是 **file 节点**（`fileKind` 为 `video`，能播，见 §1.9），**不能参与拼接**；
- 若要让它能拼接，必须**先把资产落到 video store**，而 `VIDEO_API` 注释明写 **deliberately no append endpoint**（客户端永远不能提交视频内容）。

⇒ **本期决定**：`upload` 页签的产物是 **file 节点**（走既有 `onAssets` 语义），并在该页签下用 `canvas.videoPickerUpload` 文案旁加一句 `canvas.videoPickerEmpty` 之外的说明性 small 文本……**不行**——没有这样的 key，不得自造。

**最终决定（简单且诚实）**：`props.onAddClip` 只接受**served 片段 url**（video store / gallery store 两种前缀），因此 `history` 与 `gallery` 两个页签走 `onAddClip`；`upload` 页签**不调用 `onAddClip`**，而是把上传得到的 `CanvasAssetRef` 通过一个**新增的 props 回调** `onAddAsset(asset: CanvasAssetRef)` 交给接线方，由接线方走既有的 `addAssets([asset])`（即 file 节点，与坞站图片上传后 `addAssets` 同一条路径）。

⇒ props 冻结签名**增加一个字段**（队长已同步更新骨架文件）：

```ts
onAddAsset: (asset: CanvasAssetRef) => void
```

**这是对本节骨架的唯一补充**；`CanvasVideoPickerProps` 以文件里的最终定义为准。

### 5.2 canvas-actions：坞站接线

坞站「添加图片」按钮旁边新增「添加视频」入口：

- 图标用现有 `file`？**不行**，`file` 已被「文件节点」占用（`:4865`）。
- 用 **`sparkle`**？已被配置节点占用（`:4873`）。
- **用新锚点 + 复用 `image` 图标不可**（会与添加图片混淆）。

**决定**：不新增坞站按钮，改为**在既有 `imageMenu`（`:4913-4925`）里加一项**「添加视频」`data-image-menu-video`，点击后 `setPickerOpen(false)` + 打开视频拾取器。理由：
- 坞站图标是**闭集**，没有可用的视频图标（`file`/`sparkle` 已占用），强行复用会制造混淆；
- `imageMenu` 本来就是「往画布加东西」的菜单，语义一致；
- 不新增坞站条目 = 不动坞站布局与现有 `data-dock-item` 断言。

**同时**把 `imageMenu` 的 label 语义保持不动（`canvas.addImage`），避免改既有断言。

接线点：
- 新 state `const [videoPickerOpen, setVideoPickerOpen] = useState(false)`
- `imageMenu` 新项 → `setImageMenu(null); setVideoPickerOpen(true)`
- 渲染 `{videoPickerOpen ? <CanvasVideoPicker api={api} gallery={gallery} onClose={() => { setVideoPickerOpen(false) }} onAddClip={clip => { … }} onAddAsset={asset => { addAssets([asset]); setVideoPickerOpen(false) }} /> : null}`
- `onAddClip` 的实现**复用 `importRequest` 既有 video 分支**，即构造同样的请求交给既有 effect；**不要**在拾取器里重写建节点逻辑。做法：给 `CanvasWorkspaceProps` 增一个内部回调不可行（props 由面板提供），所以**在本组件内**直接建节点：把 `:3317-3344` 那段建引用型 video 节点的逻辑抽成一个 `useCallback`（例如 `addClipNode(clip)`），**effect 与新拾取器都调它**。抽出来后 effect 行为必须逐字不变。

---

## 6. 任务 B（host-clip）：`src/clip-compose.ts` 接受两个 store

### 6.1 改动

`videoFileFrom()` 由「单前缀 → `readVideoFile`」改为「多前缀 → 对应的 read 函数」：

```ts
const CLIP_SOURCES = [
  { prefix: VIDEO_API.file,        read: readVideoFile,    label: 'video store' },
  { prefix: GALLERY_API.videoFile, read: readGalleryVideo, label: 'gallery store' },
] as const
```

`videoFileFrom` 返回 **`{ file, read }`**（或等价结构），`resolve()` 里用返回的 `read`。**注意**：

- 前缀匹配必须**逐个精确匹配 `prefix + '/'`**，不允许 `startsWith(GALLERY_API.video)` 这种宽松前缀（会让 `/gallery/video-file-x` 命中）。
- 原有的**路径穿越拒绝**必须保留（§1.1 实测 `../../etc/passwd` 被拒）。
- `readGalleryVideo` 与 `readVideoFile` 各自已有自己的文件名正则（两者**相同**：`^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$`）。不要绕过它们。
- `src/clip-compose.ts` **新增 import** `GALLERY_API` 与 `readGalleryVideo`。注意 `skill-runner.ts` **不得** import `video-store.ts`/`gallery-store.ts`（那一层的 seam 是 `ClipComposer`），但 `clip-compose.ts` 本来就是那个 seam 的实现，**可以**直接 import 两个 store。已确认无循环依赖风险（两个 store 都不 import clip-compose）。

### 6.2 `describe()` 文案

`describe()` 目前报 ffmpeg 定位结果。**不要**把两个 store 塞进去（用户看不懂）。保持原样。

### 6.3 套件（`scripts/smoke-compose.mjs`）

新增用例，**必须**满足：

1. 注入的假 composer 之外，**另加一条真 resolve 用例**：在两个 store 的临时根目录里各造一个真实 `.mp4`（可用 `-f lavfi` 造，或直接写几条假字节——`resolve()` 只做 `stat`，不解码），断言：
   - video store 前缀 → 返回磁盘路径
   - **gallery store 前缀 → 返回磁盘路径**（这是回归的本体）
   - `gallery/image/` 前缀 → undefined
   - 外部 `https://` → undefined
   - `../` 穿越 → undefined
2. **反向验证（必做，写进交付说明）**：把 `videoFileFrom` 退回单前缀版本 → **恰好** gallery 那条断言失败、其余全过 → 按 `shasum` 逐字节还原 → 全绿。

---

## 7. 验证要求

### 7.0 t5（`scripts/smoke-video-picker.mjs`）必须覆盖的断言清单

**从 t8 转达（这两条仓内还没有，必须落地）**：

1. **失败态**：让假 `api.videoHistoryList()` **抛错** ⇒ `[data-video-picker-empty]` **不存在**、`[data-video-load-error]` **存在**且含 `canvas.videoLoadFailed` 文案、`[data-video-reload]` 存在。
2. **成功空数组**：假 api 返回 `[]`（成功）⇒ `[data-video-picker-empty]` **存在**、`[data-video-load-error]` **不存在**。
3. **区分性用例（必须有，否则朴素门控也能蒙过套件）**：`gallery: []` 且 history 读取失败 ⇒ **gallery 页签仍显示空态**、**不显示** history 的错误行。少了这条，「把门控写坏成无条件吞掉所有空态」的版本会全绿通过。

> 选择器**必须**用 `[data-video-picker-empty]`：旧名 `[data-video-empty]` 会**静默**断言到 `CanvasWorkspace.tsx:4217` 的画布视频节点占位（画布先挂载），套件测错对象却不报错（§5.1）。

**逐条即时输出**，不要攒到最后一次打印；断言失败时不要 `assert.equal(domNode, null)`（§1.12 的 OOM）。

### 7.1 每个成员自查（交付前）

- `scripts/with-lock.sh pnpm build` 通过
- `scripts/with-lock.sh npx tsc --noEmit` 干净
- 自己那条套件全绿

### 7.2 反向验证（每处改动都要，写进交付说明）

故意改坏 → 确认**恰好对应**的断言失败 → 按 `shasum` **逐字节**还原 → 全树扫 `REVERSE-VERIFICATION|WRONG-COPIED|SABOTAGED|DELIBERATELY` 必须为空。

**反向验证前必须 build**，否则测的是旧产物。

### 7.3 独立验证（verifier，单独任务）

不得由写了实现的成员自验。verifier 要独立复现：
- B：真 store 目录 + 真文件，两个前缀都能 resolve，穿越仍被拒
- A：确认 `data-compose-bar-run` 真的可点（jsdom 里 `getComputedStyle(bar).pointerEvents !== 'none'` **且** 点击后确认卡出现）
- D：右键视频节点出现预览/下载；悬浮条出现模型选择与重新生成；重新生成真的发出 `videoTaskSubmit`
- C：坞站菜单出现「添加视频」；打开拾取器；`history`/`gallery` 页签能加到画布且**是引用型 video 节点**（`metadata.asset === undefined`）；`upload` 页签走 file 节点
- 对四项各做一次反向验证

### 7.4 t6 独立验证的结论与四条 finding（含已修项）

t6（compose-verifier，attempt 2）verdict = **pass**：B/A/D/C 四项都由它自己造夹具独立复现（不是只读代码、也不是只跑别人的套件），四次反向验证各只失败预期断言，全链 162 PASS / 0 FAIL / 0 SKIP。它的结构性结论：**四项改动真的接通**；它对 upload 路径的读法（产物是 file 节点，走 `onAddAsset`）被两套套件独立佐证 —— 它故意改成草稿的错误读法后，canvas 套件与 picker 套件各恰好失败一条。

#### F1（medium，真缺陷，已修）失败的元素断言会静默 OOM

`assert.equal(<jsdom element>, null, …)` 一旦失败，Node 会去 inspect **整棵已挂载的 React/DOM 图**，在本仓库的套件里以 **SIGKILL、exit 137、stdout 截断在 check 名、无任何 PASS/FAIL 行**结束。把堆调到 8GB **仍被 SIGKILL**。队长在自己的探针上复现并做了 A/B：故意写坏空态门控 ⇒ 元素写法 exit 137 静默，只把写法改成 `element === null` 对 `true` 就正常报 `FAIL C9: a failed read must NOT claim there are no clips`。

**全树已改 32 处**（`smoke.mjs` 23、`smoke-video-picker.mjs` 4、`smoke-canvas-video.mjs` 5），语义不变、全链仍绿。每个文件都做了反向验证：把某一处重写过的期望翻转 ⇒ 该文件报出**具名 FAIL** 而不是静默 137。**新增断言一律用布尔形式**，不要引入第 33 处。

#### F4（low，非本轮引入，已修）畸形百分号编码让 `resolve()` 抛 URIError

片段 URL 末段含非法转义（`%ZZ`、被截断的 `%E0%A4%A`）时 `decodeURIComponent` 抛 `URIError`，而它原本不在 try 内 ⇒ 引擎原话外泄成 run 的失败消息，而不是 §1.2 那种「这一段读不出来」的具名报告。修法：`decodeURIComponent` 包 try，失败按**不可读片段**处理（返回 `undefined`）。`scripts/verify-b-defect.mjs` 覆盖三种形状。

**写这条守卫时踩到的坑（值得记住）**：最初写成 `check(got === expected, …)`，而抛错时 `got` 就是 `undefined`、恰好等于期望的 `undefined` ⇒ **这个守卫自己被同一个缺陷骗过**，改坏后仍然全绿。必须把 `threw === undefined` 也纳入条件。加上之后，退回旧实现恰好失败那三条。

#### F2（low，已由 t9 补齐）无 compose 描述符的 disabled 分支曾无守卫

契约 §3.0 要求「catalog 加载**成功**但没有 compose 描述符 ⇒ 按钮 `disabled` 且 `title` 写明宿主 reason，绝不静默无反应」。t6 注入 `disabled={false}` 后 **162 条全绿** —— 实现是对的，但没有任何已发布套件守它。只被它自己未发布的 `scripts/verify-acd.mjs` AC1 抓住。t9 把 AC1 并入 `scripts/smoke-canvas-video.mjs`（现已在该文件里，探测脚本本身已归档到 `~/.dsh/patches/verifier-probes-absorbed/`，只留作证据）。

#### F3（low，已由 t9 处理）B1-B3 中止会污染 C6-C7

canvas 套件共用一棵活 jsdom 树：B1-B3 若在 B3 点击前中止，会**约 2/3 概率**（非确定性）连带让 C6-C7 以 `[data-skill-run]` 未渲染失败 —— 只是归因混淆，不影响产物。t9 给 B 检查加 `try/finally` 还原选中态（t3 的 B 检查本就有这个结构，照抄）。t6 自己也说这是非确定性、四组对照都没复现出稳定触发条件。

#### 追加覆盖缺口（队长发现）：picker 加进来的片段**可参与拼接**无人守

套件 E5 断到「picker 落了一个引用型 video 节点」就停了，**从未证明经 picker 加进来的片段真的能参与拼接**。verifier 的 AC2 是唯一覆盖这条的，而它所在文件不进测试链 ⇒ 覆盖等于不存在。t9 一并并入。

> AC2 的关键陷阱（verifier 原文警告）：新节点的身份**只能靠「id 集合差」认定**，不能按 url 或按类型计数 —— 该 check 跑在已被前面 W/E 检查加过节点的同一棵活树上，而夹具本身已有一个 `node-clip-right` 就是 `CLIP_RIGHT_URL`，按 url 或计数查会静默命中旧节点，检查会**因为错误的原因通过**。

#### t6 明确无法验证的（诚实边界）

真实浏览器 hover 触发悬浮条（jsdom 无 hover 态，只证明控件在渲染树里齐全可点）、真实 mp4 解码播放（夹具是 4KB 假 ftyp，只断言属性）、真实文件选择器交互（jsdom `File` + 合成 change，`[...files]` 展开靠喂真数组绕过）、模型菜单的真实 hover 飞出（无 PointerEvent，走的是点频道行）、真 ffmpeg 端到端拼接（仓库既有 E1 覆盖，它的 PART 2 是 wrap 掉 stitch/publish）。

---

### 7.5 t9 落地的三处守卫 + 队长修掉 E5 的「因错误原因通过」

t9（canvas-actions，attempt 1，verdict=pass）只动 `scripts/smoke-canvas-video.mjs`（+284，1865 → 2149 行），把 t6 发现的缺口从未进测试链的探针搬进已发布套件。

- **AC1（F2）**：catalog **加载成功但没有 compose 描述符** ⇒ 条与按钮仍在、`disabled === true`、`title` 精确等于 `拼接功能当前不可用（<宿主 reason>）`、点击不弹确认卡也不发 run。新增可变状态 `probeCatalog` 按需替换 `/canvas/skills/list` 响应。
  - **判据偏离（已接受）**：任务文本要求「在从未打开过技能菜单的状态下测」，但 AC1 必须排在 B1-B3 之后，而 B 就是首次装载目录的检查 ⇒ 计数必然不为 0。改为「先证基线（出厂目录下按钮可用）+ 再证探针生效」——**比原判据更强**：额外排除了「无条件 disabled」这个会因错误原因通过的分支。队长独立反向验证的正是这个方向：把 `disabled={composeSkill === null}` 改成 `disabled={true}` ⇒ `FAIL AC1: with the shipped catalog the button works`（外加 B2，因为自加载也不成立）。
- **AC2**：picker 加进来的片段**真的可参与拼接** —— 身份只靠 **id 集合差**认定（按 url 会静默命中夹具既有的 `node-clip-right`），再断 `type==='video'` / `metadata.video.url` / `metadata.asset === undefined` / 双徽标 + 拼接条出现。
- **F3**：B1-B3 的 `finally` 除还原选中态外，还关掉残留确认卡并断言无卡遗留。诚实边界：任务描述的「自然中止约 2/3 概率污染 C6-C7」**未能复现**（与 t6 一致）；能证明的是「人工中止下 finally 的还原逻辑承重」（守卫改成 no-op 后同一中止额外失败 AC1），污染受害者是 B 之后第一个 check，不是 C6-C7。

#### 队长修掉 E5：它一直在**因为错误的原因通过**

t9 反向验证 AC2 时顺带发现（原文：「E4-E6 仍 PASS —— E5 按 url 找新节点，而夹具既有 `node-clip-right` 就是 `CLIP_RIGHT_URL`，它因为错误的原因通过」）。队长独立确认并修掉：E5 原本用 `nodesOf('video').find(node => node.metadata?.video?.url === CLIP_RIGHT_URL)` 认定「picker 落下的节点」，而夹具 `node-clip-right` 本来就指向同一个 URL ⇒ 即使 picker 一个节点都没落，`find` 也会命中旧节点，后续「引用而非复制」的断言全部照过。

修法：改为**按 id 集合差**认定，并补一条 `addedClips.length === 1`（「恰好一个新节点」）。

**判别性证明（同一破坏、两套断言，结论相反）**：把 `addClipNode` 的 `metadata.video` 换成 `metadata.asset`（正是「引用变复制」的破坏）后——

| 断言版本 | E4-E6 结果 |
|---|---|
| 修前（按 url 找） | **PASS**（死的） |
| 修后（按 id 找） | **FAIL `E5: the new node points at the clip the card offered`** |

两次都逐字节还原（`src/client/CanvasWorkspace.tsx` 回到 `2b0d5c78`、套件回到 `6c599600`），全树标记扫描为空。**教训（第三次同类）**：认一个「刚被创建的实体」必须靠身份差，不能靠属性匹配——夹具里早已存在一个属性相同的实体。同一句话在 AC2 上写对了、在 E5 上写错了，套件照样全绿。

---

## 8. 明确不做（本期）

1. 拖入的视频文件转成 video 节点（§1.9）——file 节点语义变更，另开一轮
2. `upload` 页签的产物能参与拼接（需要视频 append 路由，§5.1）
3. 新增宿主路由
4. 新的 `ToolbarIconName`
5. 新的 `VideoMode`
6. 坞站新增按钮（§5.2）
7. 拼接产物能直接再次拼接之外的任何链路变更（拼接产物已是普通 video 节点，天然可再拼）

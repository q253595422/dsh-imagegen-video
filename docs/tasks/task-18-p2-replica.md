# task-18 — P2 爆款图复刻（新工作区，独立文件）

## 0. 你的工作区

```
/Users/malang/chajian/wt-replica      分支 task/replica    from 21c39d8
```

`node_modules` 已硬链接好，**不要 `pnpm install`**。所有命令在这里跑。

## 1. 要做的东西（对标 designkit 的「爆款图复刻」）

用户粘/传一张「爆款参考图」，我们换个商品把它按同样的风格复刻出来。

表单要素（我已从参考站点核对完，照这个做）：

| 项 | 类型 | 说明 |
|---|---|---|
| 参考图 | 最多 **20 张** | 这就是「爆款」的样子 |
| 产品原图 | 可选，1 张 | 要换成什么商品；没有就纯文生图 |
| 复刻类型 | 单选 | 电商商品图 / 服饰电商图 / 营销海报 / 社媒图文 / 创意海报 / 其他 |
| 复刻程度 | 单选 | `参考风格`（学调性构图） / `高度复刻`（尽量贴近版式） |
| 统一复刻要求 | 多行文本 | 用户附加约束 |
| 分辨率 | 单选 | 1K / 2K |
| 生成张数 | 数字 | 沿用现有 n 的规则 |

## 2. 硬约束：**代码放在新文件里**

`src/client/ImageGenPanel.tsx` 已经 4300+ 行，而且**同时还有 2 个 Bot 在改它**。

所以：

- **主体实现放进新文件** `src/client/ReplicaWorkspace.tsx`（你新建）。
- `ImageGenPanel.tsx` 里只允许改**接线**：`PanelWorkspace` 类型（`:589`）加一个 `'replica'`、`GooeyNav`（`:3068-3084`）加一项、`onSelect` 加一个分支、渲染处加一个 `{workspace === 'replica' ? <ReplicaWorkspace … /> : null}`。
- **接线改动必须精确报告是几行、在哪个行号**（我要按它整合，三个人同时改那个文件）。
- 需要新 i18n 键时改 `src/client/locales.ts`（`zh` 为键源，`en` / `ru` 必须同步，否则类型报错）。**键名统一加 `replica.` 前缀**，避免和别人撞。

## 3. 参考图通道：宿主已支持多图，别再改协议

`src/protocol.ts:1648` 已有 `images?: string[]`（第一张仍在 `image`）。
`src/engine.ts:955-958` 会 `slice(0, 4)` 后逐张 `form.append('image[]', …)`（generic 通道）；Seedream / chat 也是 1+4。

**所以「最多 20 张参考图」这个 UI 上限，实际能到模型的只有 5 张。**

这个落差必须如实处理，二选一（都要能实测）：
- (a) UI 上把上限直接标成实际值，并说明为什么；
- (b) 收 20 张，但提交时明确告知「本次实际使用前 N 张」，并让用户能看到选了哪几张。

**不许在 UI 上写 20 张、实际只传 5 张还不作声。**

## 4. 「参考风格 vs 高度复刻」必须真的不一样

这两档如果只是提示词里换个形容词，那就是假的。要求：**两档产出的 prompt 在结构上不同**，并在报告里贴出两档生成的真实 prompt 全文对比。

「高度复刻」至少要做到：把参考图的构图/版式要素写进提示词（例如主视觉位置、文字区留白、配色关系），而不是只说「高度复刻」。

如果你认为靠纯提示词做不到真正的「高度复刻」，**说出来**，我们降级成实际能兑现的说法 —— 不要做一个名字比能力大的按钮。

## 5. 不许碰

```
src/engine.ts
scripts/**（除你新建的验收脚本）
package.json / pnpm-lock.yaml
src/client/ImageGenPanel.tsx  —— 只许改 §2 列出的接线点
CHANGELOG.md / docs/releases/**
```

可以新建：`src/client/ReplicaWorkspace.tsx`，以及需要的话 `src/client/replica-*.ts`。

## 6. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`（3 分钟+，抢 CPU）。你自己跑：

```bash
cd /Users/malang/chajian/wt-replica
npx tsc --noEmit     # 必须 EXIT=0
npx tsdown           # 必须 EXIT=0
```

渲染验证：仓库里有现成的真浏览器工具链 `scripts/lib/headless-chrome.mjs`（`findChrome` / `launchChrome` / `openPage`），以及 `scripts/studio-preview.config.ts` + `scripts/studio-preview.tsx` 这套「真组件、假宿主」的预览入口 —— 复用它验证 UI，别只靠读代码。验证产物只写 `/tmp/`。

## 7. 必须自己证明的

1. **两档 prompt 结构不同**（贴全文）。
2. **多图真的进了请求**：本地假上游接住请求体，断言张数与顺序（参考 `scripts/smoke-video.mjs:56-130` 的 `createServer` + `listen(0)` 写法）。
3. **负向**：把 `images` 删掉，第 2 条必须 FAIL。
4. UI 在窄窗口（620px）和 1440px 下都不溢出（`scrollWidth === clientWidth`）。

## 8. 报告格式

```
## 1. 我新建了哪些文件
## 2. 我改了 ImageGenPanel.tsx 的哪几行（精确到行号 + 原文）
## 3. 改了 locales.ts 的哪些键
## 4. 两档 prompt 的真实全文对比
## 5. 实测输出（原文）
## 6. 我没做到 / 有疑问的
```

## 9. 一句话

本轮不求把「高度复刻」做成真的像素级重建；要么给出诚实的能力边界，要么别放那个按钮。

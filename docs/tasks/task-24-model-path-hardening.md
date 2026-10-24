# task-24 — 模特库路径加固 + 服装上传校验

## 0. 你的工作区

```
/Users/malang/chajian/dsh-imagegen-video/.worktrees/sec    分支 task/sec    from 6f8f882
```

`node_modules` 已硬链接好，**不要 pnpm install**。`npx tsc --noEmit` 已验证 EXIT=0。

## 1. 背景（我实测过的，不要重新论证）

我拿真代码跑了一遍：把 `models/index.json` 里的 `file` 写成 `../../secret.txt`，再调 `readModel('../../secret.txt')`，**确实读到了 models 目录外的文件**。

所以**代码层面的逃逸是真的**，但**威胁模型要写对**：攻击者必须能写 `index.json`，也就是必须已经拿到这个用户的文件写权限。这不构成越权，属于加固项，不是「远程任意文件读取」。

`imageFileFrom()` 能产出 `"/etc/passwd"` 这种绝对路径，但 `path.join(modelsDir(), '/etc/passwd')` **不会**从根重置（只有 `path.resolve` 会），所以绝对路径这条路出不去。**只有 `..` 能出去**。别把结论写成「任意路径」——写清只有 `..`。

## 2. 要改的

### A. `src/model-store.ts`：文件名白名单

在 `model-store.ts` 里加一个**单一入口**的校验函数，`readModel` / `removeModel` / `saveModel` 全部走它：

```ts
/** Reject anything that is not a single plain file name inside the model dir. */
function safeFileName(value: string): string | undefined
```

规则（缺一不可）：
- 非空、长度 ≤ 200；
- **不许**含 `/`、`\`、NUL；
- **不许**是 `.` 或 `..`，也不许以 `..` 开头；
- 必须等于 `path.basename(value)`；
- 只允许「uuid 形态 + 已知图片扩展名」这一种形状：`^[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$`（`saveModel` 生成的就是这个形状）。

不通过就返回 `undefined`，调用方按「不存在」处理（`readModel` → `undefined`，`removeModel` → `false`）。

- `readIndex()` 里过滤 `valid()` 时**顺带**把 `safeFileName(entry.file)` 不通过的条目剔掉——坏索引直接当不存在，而不是让它在后面炸。
- `valid()` 里 `mime` 只允许 `image/png | image/jpeg | image/webp`（`saveModel` 的 `extension()` 也只认这三种）。

### B. `src/routes.ts`：`imageFileFrom()` 也收一道

`src/routes.ts:631-641` 的 `imageFileFrom()` 在 `decodeURIComponent(...)` 之后**再断言一次**：结果必须是单段纯文件名（同样规则），否则返回 `undefined`。这样即使将来有人绕过 store，路由层也不再是敞开的。

**不要**改路由签名、不要改 `MODEL_API`。

### C. `src/client/OutfitWorkspace.tsx`：服装上传校验

`:23-25` 附近的上传函数：
- 校验 MIME 必须是 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 之一；不合格**明确报错**（用已有错误通道 + i18n 键），不许静默丢；
- 读文件失败（`FileReader` 出错）也要把错误显示出来，不许静默 `catch`；
- 6 张上限保持不变——UI 上已经写清了「最多 6 张，实际发送 4 张」这类说明，**保留原文案**，不要再自己编一个新数字。

## 3. 不许碰

```
src/engine.ts
src/video-engine.ts
package.json / pnpm-lock.yaml
scripts/smoke.mjs
CHANGELOG.md / docs/releases/**
其它 workspace 文件（ReplicaWorkspace / PptWorkspace / AplusWorkspace …）
```

## 4. 禁区（违反即作废）

```bash
git commit / git push / git stash / git reset / git checkout / git add
pnpm test:negative
```

不要跑全量 `pnpm test`。你跑：

```bash
cd /Users/malang/chajian/dsh-imagegen-video/.worktrees/sec
npx tsc --noEmit
npx tsdown --out-dir /tmp/sec-build
node scripts/smoke.mjs
```

## 5. 必须自己证明的（四条，全部要贴真实输出）

1. **逃逸被堵**：构造 `index.json` 含 `file: "../../secret.txt"`，`readModel('../../secret.txt')` 必须返回 `undefined`；`removeModel('../../secret.txt')` 必须返回 `false`，且 `secret.txt` **仍在**。
2. **正常模特还能用**：`saveModel` 存一张图 → `readModel(id)` 能读回、字节一致 → `removeModel(id)` 删掉。
3. **路由层**：`imageFileFrom('/api/dsh-imagegen/models/image/..%2F..%2Fsecret.txt', '/api/dsh-imagegen/models/image')` 必须返回 `undefined`；正常的 `.../abc.png` 仍返回 `abc.png`。
4. **负向**：把 `safeFileName` 改成直接 `return value`，第 1 条必须红、第 3 条必须红。贴红。

验证产物只写 `/tmp/`。

## 6. 报告格式

```
## 1. model-store.ts 改了哪几处（行号 + 原文）
## 2. routes.ts imageFileFrom 改后原文
## 3. OutfitWorkspace 上传校验改后原文 + 新增 i18n 键
## 4. 四条证明的真实输出（含负向）
## 5. 我对「严重程度」的独立判断：是否同意团长把它从"严重"降为"加固项"，理由
## 6. 我没做到 / 有疑问的
```

第 5 条必须写，我要看你自己怎么评级，不要顺着我的话说。

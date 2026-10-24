# task-11 — 发布产物跨目录可重现

## 背景（已由 Lead 实测确认，不要重新论证，直接修）

`tsdown.config.ts:136` 用 `cssModules: { pattern: '[hash]_[local]' }`，`[hash]` 由传给 lightningcss 的
`filename` **字符串**派生，与 CSS 内容无关。当前 `:134` 传的是 `filename: fileId`，`fileId` 来自
`cssRealPath()` → `resolvePath(process.cwd(), ...)`，是**绝对路径**。

Lead 的实测（你自己复跑一遍验证，不要照抄）：

```
/a/b/src/client/x.module.css   ->  uoukpq_wrap
/c/d/src/client/x.module.css   ->  ByV2Ia_wrap
src/client/x.module.css        ->  _1dXeLW_wrap
src/client/x.module.css (again)->  _1dXeLW_wrap      # 同一相对路径跨根稳定
内容 red 改成 blue              ->  _1dXeLW_wrap      # 与内容无关
```

后果：同一个 commit 在 `/Users/x/repo` 和 `/tmp/repo` 构建出**不同的 `lib/client.js`**。
Lead 实测三个目录同一 commit：`58182bf0…` / `3a47aa6a…` / `85d2368c…`。
同一目录连跑 3 次稳定 → 是 path 依赖，不是随机。

**为什么必须修**：`release.yml` 发布 `SHA256SUMS`，并会在重跑时替换 release asset。
如果产物无法从源码在任何机器上重现，那个 checksum 就没有可验证的意义 —— 等于只有「恰好造出它的那次 run」能自证。

## 必须完成的三件事

### 1. 让 hash 与绝对路径无关

改 `tsdown.config.ts` 的 `transform({ filename })`：传**仓库相对路径**，而不是绝对路径。

要求：
- 全仓所有 `.module.css` 文件名在 `src/client/` 下唯一，用相对路径不会碰撞；你**必须自己核对这一点**（`ls src/client/*.module.css | xargs -n1 basename | sort | uniq -d` 应为空）。
- 若发现不唯一，改用「相对路径 + 内容哈希」的自算方案，并在报告里说明为什么。
- **不要**直接删掉 `[hash]_` 前缀改成固定名 —— 两个同名 local class 在不同文件里会撞。保留 hash，只改变它的输入。

### 2. 让 `verify-reproducible.mjs` 真的能抓到这类缺陷

现在它只在 `ROOT` 里 build 两次，测的是「同目录确定性」。跨目录不是。

要求：
- 新增一次**跨目录**构建：把源码树复制到一个临时目录（**排除 `node_modules`、`lib`、`.git`**，用符号链接指回原 `node_modules` 或复用 pnpm store，不要复制 300MB 依赖），在那边 build，比对 `lib/client.js` 的 sha256 与原目录一致。
- 临时目录用完必须清理（`finally` 里 `rm -rf`），失败也要清理。
- 输出必须打印两个目录的路径和各自 digest，不能只说 PASS。
- 这个新检查必须是**承重的**：在报告里贴出「故意把 filename 改回绝对路径 → 该检查 FAIL / EXIT=1」的原文。

### 3. 验证修完真的跨目录一致

自己跑：
```
pnpm build                                  # 原目录
/Users/malang/.local/bin/... 不需要
cp -R src tsdown.config.ts package.json 等必要文件到 /tmp/repro-<随机>
在那边 build
shasum -a 256 lib/client.js                 # 两边必须相同
```
再跑一次原目录 build，确认同目录也还是稳定的。

## 不许碰

- **不许改 `src/` 下任何文件**（这一轮纯构建侧）
- 不许改 `src/client/**` —— 界团正在另一个任务里改 `ImageGenPanel.tsx`，你碰了就冲突
- 不许 commit、不许 push、不许 stash、不许 reset、不许 checkout
- 验证输出只写 `/tmp/`，不要写进仓库
- 不许跑 `pnpm test:negative`（那个会故意注入缺陷，跑完容易留下脏状态）

## 完成标准（报告里必须贴真实命令输出，不接受「通过」两个字）

```
pnpm typecheck                  EXIT=0
pnpm build                      EXIT=0
node scripts/verify-reproducible.mjs      EXIT=0，且输出里能看到跨目录比对的两个 digest
pnpm test                       EXIT=0
```

外加：
- 原目录与临时目录的 `lib/client.js` sha256 相同（贴出两个值）
- 反证：filename 改回绝对路径时 `verify-reproducible.mjs` FAIL（贴出原文 + EXIT）
- `git status --short` 原文（应该只剩你改的两个文件 + 界团的文件）

## 报告格式

1. 改了哪几个文件，每处改动的 diff（`git diff` 原文）
2. 上面三组命令的输出
3. 相对路径是否会碰撞的核对结果
4. 你认为这个修法有什么残余风险（如果有）

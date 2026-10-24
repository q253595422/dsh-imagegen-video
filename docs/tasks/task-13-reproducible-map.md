# task-13 — 让可重现性检查覆盖发布包里的全部构建产物

派给：金团
前置：task-11（`tsdown.config.ts` 的 `filename` 改为仓库相对路径）已验收通过

## 背景：一个被检查漏掉的产物

发布包里 `lib/` 下有 **5 个**构建产物，但 `scripts/verify-reproducible.mjs` 的
`ARTIFACTS` 只断言 4 个：

```
$ tar -tzf q253595422-dsh-imagegen-video-1.16.0.tgz | grep 'package/lib/'
package/lib/client.js
package/lib/client.js.map      <-- 没有断言
package/lib/index.js
package/lib/locale-tables-chunk.js
package/lib/locale-tables.js
```

`package.json` 的 `files` 含 `"lib"`，所以 `.map` 是**会被发布出去**的字节。

## 已经实测到的伪影（不是构建缺陷，是检查自身的缺陷）

用 symlink 方式的 mirror 构建，`.map` 的 digest 与仓库本体不一致：

```
repo 本体           sources[8] = ../node_modules/.pnpm/lucide-react@.../lucide-react.js
symlink mirror     sources[8] = ../../../../Users/malang/chajian/dsh-imagegen-video/node_modules/.pnpm/lucide-react@.../lucide-react.js
```

原因是 rolldown 会穿过 symlink 解析真实路径，map 的 `sources` 于是记录了穿越后的
路径。用硬链接（`cp -al`）拷真 node_modules 重做，两边完全一致：

```
repo            d53a40e9ce5ab9bb0f8128ca22a617ba87731a06f1a28b24f28778a83ec65520
hardlink mirror d53a40e9ce5ab9bb0f8128ca22a617ba87731a06f1a28b24f28778a83ec65520
```

所以当前状态是：**发布包事实上可重现，但检查看不见；谁要是图省事直接把 `.map`
加进 `ARTIFACTS`，会立刻拿到一个假 FAIL。**

## 要求

1. **覆盖发布包里全部构建产物**。确认 `lib/` 下除 `.map` 外还有没有漏的；
   若将来新增产物，检查应该自动跟上而不是靠人记得改列表（怎么做你定，
   但要在报告里说明选这个做法的理由）。

2. **解决 symlink 伪影**。硬链接是一种办法，但 `/tmp` 在 macOS 上可能与仓库不同卷、
   在 Linux CI 上可能是 tmpfs，`cp -al` 会直接失败。需要带降级的方案，
   并说明降级后仍然能断言 `.map`。

3. **承重性证明**（硬要求）：改完后重新引入一个**只影响 `.map`** 的路径依赖，
   贴出 FAIL 原文与退出码；再证明正常态 PASS。两个状态的命令、退出码、原文都要贴。

4. **证明不会假 FAIL**：至少两个不同的绝对路径各建一次，`.map` 必须一致。

5. **代价**：说明新增这一步让 `pnpm test` 多花多少秒。当前整个 `pnpm test` 约 4 秒多，
   不允许涨成分钟级。

## 禁区

- `src/**` 零改动 —— 界团正在 task-12 里改 `src/client/ImageGenPanel.tsx`
- 不碰 `package.json`
- 不 commit / push / stash / reset / checkout
- 不跑 `pnpm test:negative`
- 验证输出只写 `/tmp/`

## 报告要求

真实命令输出 + 退出码，不接受「通过」两个字。任务书里任何一条判断你不同意，
直接说，不要顺着写。

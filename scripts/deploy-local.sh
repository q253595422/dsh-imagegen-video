#!/bin/bash
# 把当前工作树构建并部署到 DSH 的 desktop / uireview profile。
#
# 为什么是「解包 tgz 整目录替换」而不是 pnpm add：
#   desktop profile 由 Electron 独占，pnpm add 与 `dsh --profile desktop` 都会被拒绝。
# 为什么整目录替换而不是挑文件：1.26.0 曾手工只拷 lib/，漏了 cordis.patch.yml
#   与 src/templates/，宿主启动即 ENOENT、插件整体不加载，症状是「入口没了」。
#
# 用法：bash scripts/deploy-local.sh [desktop|uireview|both]   默认 both
set -euo pipefail

REPO="/Users/malang/chajian/dsh-imagegen-video"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null \
  || grep -m1 '"version"' "$REPO/package.json" | sed 's/.*: *"\(.*\)".*/\1/')"
TARGET="${1:-both}"

export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/imagegen-deploy.XXXXXX")"
STAGE="$SCRATCH/stage"
mkdir -p "$STAGE"
trap 'rm -rf "$SCRATCH"' EXIT

echo "== 1/5 构建 =="
cd "$REPO"
./scripts/with-lock.sh pnpm run build >"$SCRATCH/build.log" 2>&1 || {
  echo "构建失败，日志末尾："; tail -20 "$SCRATCH/build.log"; exit 1
}
echo "构建完成"

echo "== 2/5 打包 =="
pnpm pack --pack-destination "$SCRATCH" >"$SCRATCH/pack.log" 2>&1
TGZ="$(ls "$SCRATCH"/*.tgz | head -1)"
echo "包：$(basename "$TGZ") ($(du -h "$TGZ" | cut -f1))"

echo "== 3/5 解包与预检（版本 ${VERSION}）=="
tar -xzf "$TGZ" -C "$STAGE"
PKG="$STAGE/package"

fail=0
check() { if eval "$2"; then echo "  ok  $1"; else echo "  FAIL $1"; fail=1; fi }

check "版本是 $VERSION"          "grep -q '\"version\": \"$VERSION\"' '$PKG/package.json'"
check "cordis.patch.yml 存在"    "test -f '$PKG/cordis.patch.yml'"
check "patch 含本插件行"          "grep -q '@q253595422/dsh-imagegen-video' '$PKG/cordis.patch.yml'"
check "src/templates 有 8 个"     "[ \$(ls '$PKG/src/templates/'*.json 2>/dev/null | wc -l | tr -d ' ') -eq 8 ]"
check "lib 三个入口"              "test -f '$PKG/lib/index.js' && test -f '$PKG/lib/client.js' && test -f '$PKG/lib/components/canvas.js'"
check "icon.png 存在"             "test -f '$PKG/icon.png'"
check "根 index.js 存在"          "test -f '$PKG/index.js'"
check "locale/zh.json 有 meta"    "grep -q 'meta' '$PKG/locale/zh.json'"

# 本次改动的存在性核对：真实功能的字符串必须真的进了构建产物，
# 而不是只在源码里存在、打包时被摇掉。
check "client.js 含导出画布按钮"  "grep -q '导出画布' '$PKG/lib/client.js'"
check "client.js 含工作流开关"    "grep -q 'workflowReuse' '$PKG/lib/client.js'"
check "client.js 含整图导入接口"  "grep -q 'canvas/bundle/import' '$PKG/lib/client.js'"
# 1.30.2：768P 档位与 MiniMax-H3 特化。档位串同时出现在服务端（submitBody 的
# size）与客户端（面板按钮），两处都要有，否则修好一半。
# 用双引号匹配：tsdown 产物里的字符串字面量是双引号，写成单引号会永远不命中。
check "index.js 含 768P 档位"     "grep -q '\"768P\"' '$PKG/lib/index.js'"
check "index.js 含 MiniMax 特化"  "grep -q 'minimax\\[-_.\]' '$PKG/lib/index.js'"
check "client.js 含 768P 档位"    "grep -q '\"768P\"' '$PKG/lib/client.js'"
# 1.30.2：参考图上传腿。少了这条，图生视频会退回「只发 data URL 被上游拒」。
check "index.js 含上传端点"       "grep -q '/media/uploads' '$PKG/lib/index.js'"
check "index.js 含上传失败域"     "grep -q 'video-upload-failed' '$PKG/lib/index.js'"

if [ "$fail" -ne 0 ]; then echo "预检未通过，中止"; exit 1; fi

echo "== 4/5 部署 =="
STAMP="$(date +%Y%m%d-%H%M%S)"
DEPLOYED=""
for profile in $( [ "$TARGET" = both ] && echo "desktop uireview" || echo "$TARGET" ); do
  DEST="$HOME/.dsh/profiles/$profile/node_modules/@q253595422/dsh-imagegen-video"
  if [ ! -d "$(dirname "$DEST")" ]; then echo "  skip $profile（profile 不存在）"; continue; fi
  BACKUP="$DEST.bak-$STAMP"
  if [ -d "$DEST" ]; then mv "$DEST" "$BACKUP"; echo "  旧版备份：$BACKUP"; fi
  mkdir -p "$(dirname "$DEST")"
  cp -R "$PKG" "$DEST"
  if diff -r "$PKG" "$DEST" >/dev/null; then
    echo "  ok  $profile 已部署，字节与包一致"
    DEPLOYED="$DEPLOYED $profile"
  else
    echo "  FAIL $profile 部署后与包不一致"; exit 1
  fi
done

# 导入自检必须在**部署后的位置**跑：lib/index.js 会 import 宿主的
# `@deepseek-ai/dsh-*` 包，只有 profile 的 node_modules 里才有它们。
# 在临时解包目录里跑必然 ERR_MODULE_NOT_FOUND——那不代表包坏了。
echo "== 5/5 导入自检（部署后位置）=="
for profile in $DEPLOYED; do
  DEST="$HOME/.dsh/profiles/$profile/node_modules/@q253595422/dsh-imagegen-video"
  ( cd "$HOME/.dsh/profiles/$profile" && node --input-type=module -e "
const lib = await import('file://$DEST/lib/index.js')
for (const n of ['apply', 'appendGallery', 'listGallery']) {
  if (!(n in lib)) { console.error('lib 缺导出：' + n); process.exit(1) }
}
" ) && echo "  ok  $profile 导入成功" || { echo "  FAIL $profile 导入失败"; exit 1; }
done

echo
echo "部署完成（${VERSION}）。重启客户端后生效。"
echo "备份留在各 profile 的同级目录，文件名带 ${STAMP}。"

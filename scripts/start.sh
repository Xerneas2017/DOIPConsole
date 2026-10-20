#!/usr/bin/env bash
# DoIP 诊断控制台 — 一键启动（单进程、单端口）
#
# 后端直接托管前端产物，所以只需要启动一个进程，浏览器打开一个地址即可。
#
# 用法：
#   bash scripts/start.sh              # 构建前端 + 启动（推荐）
#   bash scripts/start.sh --no-build   # 跳过构建，直接用已有 web/dist
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 node，请先安装 Node.js 20 或更高版本" >&2
  exit 1
fi
echo "Node: $(node -v)"

if [ ! -d node_modules ]; then
  echo "▸ 首次运行，安装依赖…"
  npm install
fi

if [ "$BUILD" = "1" ]; then
  echo "▸ 构建前端…"
  npm run build
fi

if [ ! -f web/dist/index.html ]; then
  echo "✗ 找不到 web/dist/index.html；请去掉 --no-build 重新运行" >&2
  exit 1
fi

echo
echo "════════════════════════════════════════════════════"
echo "  启动后浏览器打开：http://127.0.0.1:8787"
echo "  （端口被占用会自动顺延，以终端里的实际地址为准）"
echo "  按 Ctrl-C 退出"
echo "════════════════════════════════════════════════════"
echo

# 打开浏览器（等后端起来）
(
  sleep 3
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:8787" >/dev/null 2>&1 || true
  fi
) &

# 前台运行，Ctrl-C 即退出
exec node --import tsx server/src/index.ts

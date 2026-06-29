#!/usr/bin/env bash
#
# run.sh - 啟動 SmartSub 開發環境
#
# 用法:
#   ./run.sh           啟動開發模式 (nextron dev)
#   ./run.sh build     打包應用 (nextron build)
#
set -euo pipefail

# 切換到腳本所在目錄 (專案根目錄)
cd "$(dirname "$0")"

# 若設定了 ELECTRON_RUN_AS_NODE, Electron 會以純 Node 模式執行,
# 導致 require('electron').app 為 undefined 而崩潰。啟動前先清除。
unset ELECTRON_RUN_AS_NODE

# 選擇套件管理器: 優先 yarn (nextron 預設), 否則 npm
if command -v yarn >/dev/null 2>&1; then
  PKG="yarn"
  RUN="yarn"
else
  PKG="npm"
  RUN="npm run"
fi

# 若尚未安裝相依套件, 先安裝
if [ ! -d node_modules ]; then
  echo "==> 安裝相依套件 ($PKG install)..."
  $PKG install
fi

MODE="${1:-dev}"

case "$MODE" in
  dev)
    echo "==> 啟動開發模式..."
    $RUN dev
    ;;
  build)
    echo "==> 打包應用..."
    $RUN build
    ;;
  *)
    echo "未知參數: $MODE" >&2
    echo "用法: ./run.sh [dev|build]" >&2
    exit 1
    ;;
esac

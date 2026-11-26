#!/usr/bin/env bash
# 每周汇总一次底稿外发数量，避免每日噪声。
# 由 crontab 每周日 10:00 调；结果写进 ops/leak-weekly.log，不推群。
set -euo pipefail
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
KOI="${KOI_HOME:-$(cd "$(dirname "$SELF")/.." && pwd)}"
cd "$KOI"
mkdir -p ops
STATUS=0
{
  echo "==== $(date '+%Y-%m-%d %H:%M') 周报 ===="
  node tools/leak-check.mjs 7 || STATUS=$?
} >> ops/leak-weekly.log 2>&1
exit "$STATUS"

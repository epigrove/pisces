#!/bin/bash
# 把 tools/pre-commit 装成 git hook
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .git/hooks
cp tools/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "已安装 .git/hooks/pre-commit"

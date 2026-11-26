#!/usr/bin/env bash
#
# install.sh —— 一条命令把仓库装到能跑的状态。
#
#   ./install.sh              # 装依赖 + 自检
#   ./install.sh --check      # 只检查环境，不动任何东西
#
# 它做四件事：
#   1. 检查环境（node 版本、pnpm、dsh 是否可用）
#   2. 装依赖（pnpm install；node_modules 由它生成，**不手改**）
#   3. 语法检查 + 未定义引用检查（这两样 `node --check` 查不出来）
#   4. 跑全部测试
#
# 任何一步失败就停，并说清楚是哪一步、怎么办。
#
# **不碰任何已有数据。** 装依赖只会写 <repo>/node_modules。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

info() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m❌ %s\033[0m\n' "$*"; exit 1; }

# ── 1. 环境 ──────────────────────────────────────────────
info "1/4 检查环境"

command -v node >/dev/null 2>&1 || die "没装 node。需要 Node.js ≥ 22（与 package.json engines 一致）。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node 版本太低（$(node -v)），需要 ≥ 22（package.json engines 与 CI 都按 22+ 测的）。"
fi
ok "node $(node -v)"

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
  HAVE_PNPM=1
else
  warn "没有 pnpm。装它的命令：npm i -g pnpm"
  HAVE_PNPM=0
fi

if command -v dsh >/dev/null 2>&1; then
  ok "dsh $(dsh --version 2>/dev/null || echo '(版本未知)')"
else
  warn "找不到 dsh——本仓库是 DSH 插件集，插件本身装好了也需要宿主才能跑"
fi

[ "$CHECK_ONLY" = "1" ] && { info "只检查，到此为止"; exit 0; }

# ── 2. 依赖 ──────────────────────────────────────────────
info "2/4 安装依赖"
[ "$HAVE_PNPM" = "1" ] || die "没有 pnpm，装不了依赖。先跑：npm i -g pnpm"

cd "$REPO" || die "进不去仓库目录：$REPO"
if pnpm install --silent; then
  ok "依赖已安装（node_modules 由 pnpm 生成，不要手改）"
else
  die "pnpm install 失败。常见原因：网络、node 版本、lockfile 与 package.json 不一致（npm 源不同也可能）"
fi

# ── 3. 静态检查 ──────────────────────────────────────────
info "3/4 静态检查"

SYNTAX_FAIL=0
while IFS= read -r f; do
  node --check "$f" 2>/dev/null || { echo "  ❌ 语法错误：$f"; SYNTAX_FAIL=1; }
done < <(find "$REPO/plugins" "$REPO/ops" "$REPO/tools" "$REPO/examples" \
         \( -name '*.js' -o -name '*.mjs' \) -not -path '*/node_modules/*' 2>/dev/null)
[ "$SYNTAX_FAIL" = "0" ] && ok "语法检查通过" || die "有文件语法错误（见上）"

# node --check 只验语法，验不出「用了没导入的标识符」——那种错一加载就崩，
# 而且症状往往只是"服务异常"。
if node "$REPO/ops/check-undefined-refs.mjs" >/dev/null 2>&1; then
  ok "未定义引用检查通过"
else
  node "$REPO/ops/check-undefined-refs.mjs" | tail -12
  die "有「用了没导入」的引用（见上）"
fi

# ── 4. 测试 ──────────────────────────────────────────────
info "4/4 跑测试"

TOTAL=0
FAILED=0
CRASHED=0
for t in "$REPO"/plugins/*/test-*.mjs "$REPO"/ops/test-*.mjs; do
  [ -f "$t" ] || continue
  # 2026-11-26 修「假绿」：原来只取最后一行文本、不看退出码。
  # 测试在打印汇总**之前**崩掉时，通过/失败两个数都解析不出来，于是被算成"没有失败"，
  # 最后照样打印"全部通过"——所有后续验证都会建立在这个假结论上。
  if ! OUT="$(node "$t" 2>&1)"; then
    echo "  ❌ $(basename "$(dirname "$t")")/$(basename "$t")：测试进程非零退出"
    printf '%s\n' "$OUT" | tail -8 | sed 's/^/     /'
    CRASHED=$((CRASHED + 1))
    continue
  fi
  SUMMARY="$(printf '%s\n' "$OUT" | grep -E '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
  if [ -z "$SUMMARY" ]; then
    echo "  ❌ $(basename "$(dirname "$t")")/$(basename "$t")：没有输出「N 通过 / M 失败」汇总"
    printf '%s\n' "$OUT" | tail -5 | sed 's/^/     /'
    CRASHED=$((CRASHED + 1))
    continue
  fi
  N="$(printf '%s' "$SUMMARY" | grep -oE '[0-9]+ 通过' | grep -oE '[0-9]+')"
  F="$(printf '%s' "$SUMMARY" | grep -oE '[0-9]+ 失败' | grep -oE '[0-9]+')"
  TOTAL=$((TOTAL + ${N:-0}))
  if [ "${F:-0}" != "0" ]; then
    echo "  ❌ $(basename "$(dirname "$t")")/$(basename "$t")：$SUMMARY"
    FAILED=$((FAILED + 1))
  fi
done

if [ "$FAILED" != "0" ] || [ "$CRASHED" != "0" ]; then
  die "$FAILED 个测试有失败、$CRASHED 个没跑完（见上）"
fi
ok "$TOTAL 项断言全部通过"

# ── 完毕 ────────────────────────────────────────────────
info "装好了"
cat <<EOF

接下来：

  node examples/walkthrough.mjs     三十秒看懂这套东西在干什么
  docs/QUICKSTART.md                怎么配一个能跑的 agent
  docs/CHANNEL.md                   怎么接自己的通道（QQ 之外）

注意：本仓库只是插件集，**不含任何真实数据**。
你自己跑起来后，数据会写在 \$KOI_HOME 下（默认当前工作目录）。
EOF

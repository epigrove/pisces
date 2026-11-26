#!/usr/bin/env bash
#
# upgrade-dsh.sh —— 一条命令升级 DSH（v3：显式版本 + 验证失败即非零）
#
#   sudo DSH_VERSION=0.2.2-rc.5 bash ./ops/upgrade-dsh.sh
#
# 卡死原因：npm install -g 本身要把整棵依赖树加载进内存，峰值超 1.6G，swap 抖死。
# 停服务只是减轻，不是解决（v2 停服务后仍卡过）。v3 再限 npm 堆+加大 swap，降低概率，
# 但**不保证不卡**；根治靠加内存。任何一步失败自动恢复服务。
#
# 顺序：1内存/swap 2备份 3停服务 4安装 5拉起 6验证。任何一步失败自动恢复服务。
# 回滚命令写 /tmp/dsh-upgrade-rollback.txt。
#
set -euo pipefail
TARGET_VERSION="${DSH_VERSION:-}"
PKG_ROOT=/usr/local/lib/node_modules/@deepseek-ai
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${PKG_ROOT}.bak-${STAMP}"
ROLLBACK=/tmp/dsh-upgrade-rollback.txt
info(){ echo -e "\n\033[1m==> $*\033[0m"; }
warn(){ echo -e "\033[33m⚠️  $*\033[0m"; }
die(){ echo -e "\033[31m❌ $*\033[0m"; exit 1; }
[ -n "$TARGET_VERSION" ] || die "必须显式设置 DSH_VERSION（例：sudo DSH_VERSION=0.2.2-rc.5 bash $0）"
[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash $0"
KOI_HOME_FOR_UPGRADE="${KOI_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
KOI_USER="${KOI_USER:-admin}"
START_SCRIPT="${KOI_START_SCRIPT:-$KOI_HOME_FOR_UPGRADE/ops/start.sh}"

restore(){ systemctl start dsh-web 2>/dev/null || true; }
trap restore ERR

info "1/6 内存/swap"
awk '/MemAvailable/{printf "  可用 %dMB\n",$2/1024}' /proc/meminfo
# v3：swap 提到 4G（2G 仍 thrash）。已有 2G 的先换掉。
if [ "$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)" -lt 4096 ]; then
  swapoff /swapfile 2>/dev/null || true
  rm -f /swapfile
  fallocate -l 4096M /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null
  swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

info "2/6 备份"
[ -d "$BACKUP" ] && die "备份已存在：$BACKUP"
cp -a "$PKG_ROOT" "$BACKUP"
cat > "$ROLLBACK" <<EOF
sudo rm -rf $PKG_ROOT
sudo mv $BACKUP $PKG_ROOT
sudo systemctl restart dsh-web
EOF
echo "  备份 $BACKUP；回滚见 $ROLLBACK"

info "3/6 停服务+清缓存，造干净内存窗口"
# 经验：唯一一次没卡的升级发生在刚重启后（内存干净）。卡不卡取决于安装那一刻的内存余量。
# 最稳=先重启机器再跑本脚本；这里停服务+drop_caches 尽量逼近干净窗口。
systemctl stop dsh-web
pkill -f "dsh --profile koi" 2>/dev/null || true
sleep 2
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
awk '/MemAvailable/{printf "  停后可用 %dMB\n",$2/1024}' /proc/meminfo
echo "  提示：若仍卡，先 reboot 再跑本脚本（干净内存窗口最稳）。"

info "4/6 安装 @deepseek-ai/dsh@${TARGET_VERSION}"
# v3：限 npm 堆 768M，压低驻留内存防 thrash（更慢但更稳；不保证不卡）
NODE_OPTIONS=--max-old-space-size=768 npm install -g "@deepseek-ai/dsh@${TARGET_VERSION}" --no-audit --no-fund --prefer-offline || die "安装失败，跑 $ROLLBACK 回滚"
NEW_VER=$(dsh --version 2>/dev/null || echo "?")
echo "  安装后：$NEW_VER"
[ "$NEW_VER" = "$TARGET_VERSION" ] || die "安装后版本不符（期望 $TARGET_VERSION，实际 $NEW_VER），跑 $ROLLBACK 回滚"

info "5/6 拉起服务"
systemctl start dsh-web
sleep 8
systemctl is-active --quiet dsh-web || die "dsh-web 没起来，跑 $ROLLBACK"
if [ -x "$START_SCRIPT" ]; then
  runuser -u "$KOI_USER" -- env KOI_HOME="$KOI_HOME_FOR_UPGRADE" bash "$START_SCRIPT" --daemon \
    || die "koi 启动失败，跑 $ROLLBACK 回滚"
else
  die "koi 启动脚本不存在或不可执行：$START_SCRIPT"
fi

info "6/6 验证"
sleep 5
VALIDATION_LOG="$(mktemp /tmp/dsh-upgrade-validate.XXXXXX)"
trap 'rm -f "$VALIDATION_LOG"' EXIT
journalctl -u dsh-web --since "1 min ago" > "$VALIDATION_LOG" \
  || die "读不到 dsh-web 日志，无法验证，跑 $ROLLBACK 回滚"
ERRS=$(grep -cE "Cannot find|ReferenceError|TypeError|did not activate" "$VALIDATION_LOG" || true)
if [ "$ERRS" -gt 0 ]; then
  warn "可疑错误 $ERRS 条："
  grep -E "Cannot find|ReferenceError|TypeError|did not activate" "$VALIDATION_LOG" | tail -5
  warn "插件验证失败，升级不算完成。回滚命令：bash $ROLLBACK"
  exit 1
fi
echo "  无插件加载错误 ✅"
# 插件签名/钩子在跨版本时可能变，所以把「她的体检 + 契约核对」也跑一遍，
# 让升级当场给出结论，而不是等我事后看日志。
info "6/6+ 跑她的体检与契约核对（约 20 秒）"
if [ -d "$KOI_HOME_FOR_UPGRADE" ]; then
  if ! runuser -u "$KOI_USER" -- env KOI_HOME="$KOI_HOME_FOR_UPGRADE" bash -c \
    'cd "$KOI_HOME" && node tools/health.mjs' > "$VALIDATION_LOG" 2>&1; then
    tail -20 "$VALIDATION_LOG"
    warn "体检失败，升级不算完成。回滚命令：bash $ROLLBACK"
    exit 1
  fi
  tail -20 "$VALIDATION_LOG"
  if ! runuser -u "$KOI_USER" -- env KOI_HOME="$KOI_HOME_FOR_UPGRADE" bash -c \
    'cd "$KOI_HOME" && node tools/contract-audit.mjs' > "$VALIDATION_LOG" 2>&1; then
    tail -20 "$VALIDATION_LOG"
    warn "契约核对失败，升级不算完成。回滚命令：bash $ROLLBACK"
    exit 1
  fi
  tail -5 "$VALIDATION_LOG"
fi

echo
echo "升级完成 → $NEW_VER。回滚见 $ROLLBACK。"
echo "把我上面这两段输出贴回给人物戊，她据此判断有没有真的接上。"

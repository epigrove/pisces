#!/usr/bin/env bash
# agent 启动器
#   后台：./ops/start.sh --daemon（宿主侧看护插件 dsh-ashu-guardian 也调这个）
#   前台：./ops/start.sh（调试用）
#
# 所有外部路径都可以用环境变量覆盖；明确配置了却不存在时直接失败，不再静默忽略：
#   KOI_HOME               数据根（默认：本脚本所在包根）
#   KOI_DSH_HOME           DSH home（默认：$KOI_HOME/.dsh-home）
#   KOI_PROFILE_NAME       profile 名（默认：koi）
#   KOI_WORKDIR            DSH 工作目录（默认：$KOI_HOME）
#   PISCES_SHARED_MODEL_ENV  共享模型 env 文件（可选；配置后必须存在）
#   DSH_BIN                dsh 可执行文件（默认：PATH 里的 dsh）
#   KOI_LOG                日志文件（默认：$KOI_HOME/koi.log）
#   KOI_START_TIMEOUT_SECS 后台启动等待秒数（默认：20）
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="${KOI_HOME:-$(cd "$(dirname "$SELF")/.." && pwd)}"
DSH_HOME="${KOI_DSH_HOME:-$ROOT/.dsh-home}"
WORKDIR="${KOI_WORKDIR:-$ROOT}"
PROFILE="${KOI_PROFILE_NAME:-koi}"
DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
LOG="${KOI_LOG:-$ROOT/koi.log}"
START_TIMEOUT="${KOI_START_TIMEOUT_SECS:-20}"

[ -d "$ROOT" ] || { echo "❌ KOI_HOME 不存在：$ROOT" >&2; exit 1; }
[ -d "$DSH_HOME" ] || { echo "❌ KOI_DSH_HOME 不存在：$DSH_HOME" >&2; exit 1; }
[ -d "$WORKDIR" ] || { echo "❌ KOI_WORKDIR 不存在：$WORKDIR" >&2; exit 1; }
[ -n "$DSH_BIN" ] && [ -x "$DSH_BIN" ] || {
  echo "❌ 找不到可执行的 DSH_BIN（当前：${DSH_BIN:-未配置}）" >&2
  exit 1
}
case "$START_TIMEOUT" in
  ''|*[!0-9]*) echo "❌ KOI_START_TIMEOUT_SECS 要正整数，收到：$START_TIMEOUT" >&2; exit 1 ;;
esac
[ "$START_TIMEOUT" -gt 0 ] || { echo "❌ KOI_START_TIMEOUT_SECS 必须大于 0" >&2; exit 1; }

export HOME="$ROOT"
export DSH_HOME
export KOI_HOME="$ROOT"

# 全局默认模型（只改一处）
SHARED="${PISCES_SHARED_MODEL_ENV:-}"
if [ -n "$SHARED" ]; then
  [ -f "$SHARED" ] || { echo "❌ PISCES_SHARED_MODEL_ENV 不存在：$SHARED" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$SHARED"
  set +a
fi
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

PATTERN="dsh --profile ${PROFILE}([[:space:]]|$)"

# 只认 dsh 进程本身，避免 pgrep -f 误匹配命令行里含关键字的 shell。
pids_of() {
  local p cmd
  for p in $(pgrep -f "$PATTERN" 2>/dev/null); do
    [ -r "/proc/$p/cmdline" ] || continue
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
    case "$cmd" in
      *"dsh --profile ${PROFILE}"*) echo "$p" ;;
    esac
  done
}

alive() {
  local p="$1" state
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1
  state="$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null || true)"
  [ "$state" != "Z" ]
}

show_failure() {
  local msg="$1"
  echo "❌ $msg" >&2
  if [ -f "$LOG" ]; then
    echo "---- 日志尾部：$LOG ----" >&2
    tail -n 80 "$LOG" >&2 || true
    echo "---- 日志结束 ----" >&2
  else
    echo "日志文件不存在：$LOG" >&2
  fi
}

stop_all() {
  local pids
  pids="$(pids_of)"
  if [ -z "$pids" ]; then echo "没有在运行的实例"; return 0; fi
  echo "停止旧实例: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do sleep 0.3; [ -z "$(pids_of)" ] && { echo "已停止"; return 0; }; done
  # shellcheck disable=SC2086
  kill -9 $(pids_of) 2>/dev/null || true
  echo "强制停止"
}

case "${1:-}" in
  --stop)
    stop_all ;;
  --status)
    pids="$(pids_of)"
    if [ -z "$pids" ]; then echo "未运行"; else ps -o pid,ppid,etime,rss,cmd -p $pids; fi
    echo "日志: $LOG" ;;
  --daemon)
    stop_all
    cd "$WORKDIR"
    mkdir -p "$(dirname "$LOG")"
    nohup setsid "$DSH_BIN" --profile "$PROFILE" >> "$LOG" 2>&1 < /dev/null &
    LAUNCHED_PID=$!
    started_at=$SECONDS
    deadline=$((started_at + START_TIMEOUT))
    healthy_since=""
    while [ "$SECONDS" -lt "$deadline" ]; do
      pids="$(pids_of)"
      if [ -n "$pids" ]; then
        # 进程被 pgrep 确认后再稳定 1 秒，避免 exec 后立刻崩也报成功。
        if [ -z "$healthy_since" ]; then
          healthy_since=$SECONDS
        elif [ $((SECONDS - healthy_since)) -ge 1 ]; then
          echo "已后台启动，PID: $(printf '%s' "$pids" | tr '\n' ' ')；日志: $LOG"
          exit 0
        fi
      else
        healthy_since=""
        # setsid 在部分 shell 会 fork：父 PID 退出不一定代表 DSH 退出。
        # 先给子进程出现留 1 秒；仍找不到且父 PID 已退出，才判定启动失败。
        if ! alive "$LAUNCHED_PID" && [ $((SECONDS - started_at)) -ge 1 ]; then
          show_failure "后台进程启动后立即退出（PID $LAUNCHED_PID）"
          exit 1
        fi
      fi
      sleep 0.25
    done
    show_failure "等待 ${START_TIMEOUT} 秒仍未检测到健康的 DSH 进程"
    exit 1
    ;;
  *)
    stop_all
    cd "$WORKDIR"
    exec "$DSH_BIN" --profile "$PROFILE" ;;
esac

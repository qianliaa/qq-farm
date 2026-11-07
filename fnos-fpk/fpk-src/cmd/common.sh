#!/bin/bash
# QQ 挂机仓生命周期公共函数。由 cmd/main 等脚本 source，不单独执行。

APP_DIR="${TRIM_APPDEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export QQNAS_DATA_DIR="${TRIM_PKGVAR:-/var/apps/qqnas/var}"
export QQNAS_PORT="${TRIM_SERVICE_PORT:-8787}"
QQNAS_LOG_DIR="${QQNAS_DATA_DIR}/logs"
QQNAS_PID_FILE="${QQNAS_DATA_DIR}/app.pid"
QQNAS_MANAGER_LOG="${QQNAS_LOG_DIR}/manager.log"
QQNAS_SERVER_JS="${APP_DIR}/manager/server.cjs"
QQNAS_INSTALLER="${APP_DIR}/runtime/napcat-install.sh"

qqnas_node_bin() {
  if [ -x /var/apps/nodejs_v22/target/bin/node ]; then
    printf '%s' /var/apps/nodejs_v22/target/bin/node
    return 0
  fi
  if [ -x /var/apps/nodejs_v22/target/bin/nodejs ]; then
    printf '%s' /var/apps/nodejs_v22/target/bin/nodejs
    return 0
  fi
  local candidate
  for candidate in /var/apps/nodejs_*/target/bin/node /usr/local/bin/node /usr/bin/node /usr/trim/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  command -v node 2>/dev/null || true
}

qqnas_log() {
  mkdir -p "$QQNAS_LOG_DIR" 2>/dev/null || true
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$QQNAS_MANAGER_LOG" 2>/dev/null || true
}

qqnas_error() {
  qqnas_log "$1"
  if [ -n "${TRIM_TEMP_LOGFILE:-}" ]; then
    printf '%s\n' "$1" > "$TRIM_TEMP_LOGFILE" 2>/dev/null || true
  fi
  printf '%s\n' "$1" >&2
}

qqnas_pid_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

# 明确保护系统与天禧相关进程，任何情况下都不发送信号。
qqnas_pid_protected() {
  local pid="$1"
  local comm
  comm=$(cat "/proc/${pid}/comm" 2>/dev/null || true)
  case "$comm" in
    tac-server|tac-cli|qodercli|node|XLSmartTray|XLSmartUI|XLSmartService)
      return 0
      ;;
  esac
  case "${comm}" in
    *tianxi*|*Tianxi*|*天禧*) return 0 ;;
  esac
  return 1
}

qqnas_manager_pid() {
  if [ ! -f "$QQNAS_PID_FILE" ]; then
    return 1
  fi
  local pid cmdline
  pid=$(head -n 1 "$QQNAS_PID_FILE" 2>/dev/null | tr -dc '0-9')
  if qqnas_pid_alive "$pid"; then
    # PID 可能被复用：确认命令行确实是本应用的管理端，再视为有效。
    if [ -r "/proc/${pid}/cmdline" ]; then
      cmdline=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)
      case "$cmdline" in
        *"$QQNAS_SERVER_JS"*) ;;
        *)
          rm -f "$QQNAS_PID_FILE" 2>/dev/null || true
          return 1
          ;;
      esac
    fi
    printf '%s' "$pid"
    return 0
  fi
  rm -f "$QQNAS_PID_FILE" 2>/dev/null || true
  return 1
}

qqnas_wait_port() {
  local port="$1"
  local limit="${2:-20}"
  local count=0
  while [ "$count" -lt "$limit" ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      return 0
    fi
    sleep 1
    count=$((count + 1))
  done
  return 1
}

qqnas_start_manager() {
  local pid
  if pid=$(qqnas_manager_pid); then
    return 0
  fi

  local node_bin
  # 应用中心刚装好依赖时文件可能尚未就绪，最多等待 20 秒。
  local wait_node=0
  while [ "$wait_node" -lt 20 ]; do
    node_bin=$(qqnas_node_bin)
    [ -n "$node_bin" ] && break
    sleep 1
    wait_node=$((wait_node + 1))
  done
  if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    qqnas_error "未找到 Node.js 22 运行环境，请在应用中心安装 Node.js v22 后重试"
    return 1
  fi
  if [ ! -f "$QQNAS_SERVER_JS" ]; then
    qqnas_error "管理端文件缺失：$QQNAS_SERVER_JS"
    return 1
  fi

  mkdir -p "$QQNAS_LOG_DIR" "$QQNAS_DATA_DIR/accounts" 2>/dev/null || true

  qqnas_log "启动管理面板，端口 ${QQNAS_PORT}"
  (
    cd "$APP_DIR" || exit 1
    export PORT="$QQNAS_PORT"
    export DATA_DIR="$QQNAS_DATA_DIR"
    export HOST="0.0.0.0"
    export QQNAS_INSTALLER="$QQNAS_INSTALLER"
    export QQNAS_NODE_BIN="$node_bin"
    export MANAGER_INTERNAL_URL="http://127.0.0.1:${QQNAS_PORT}"
    export TZ="${TZ:-Asia/Shanghai}"
    export LANG="${LANG:-C.UTF-8}"
    nohup "$node_bin" "$QQNAS_SERVER_JS" >> "$QQNAS_MANAGER_LOG" 2>&1 < /dev/null &
    printf '%s' "$!" > "$QQNAS_PID_FILE"
  )

  pid=$(cat "$QQNAS_PID_FILE" 2>/dev/null | tr -dc '0-9')
  if [ -z "$pid" ]; then
    qqnas_error "管理面板启动失败：未获得进程号"
    return 1
  fi

  if ! qqnas_wait_port "$QQNAS_PORT" 25; then
    if ! qqnas_pid_alive "$pid"; then
      qqnas_error "管理面板启动失败，请查看日志 ${QQNAS_MANAGER_LOG}"
      rm -f "$QQNAS_PID_FILE" 2>/dev/null || true
      return 1
    fi
    qqnas_log "端口 ${QQNAS_PORT} 在 25 秒内未就绪，但进程仍在运行"
  fi

  qqnas_log "管理面板已启动，pid=${pid}"
  return 0
}

qqnas_stop_manager() {
  local pid
  if ! pid=$(qqnas_manager_pid); then
    return 0
  fi
  qqnas_log "停止管理面板，pid=${pid}"
  kill -TERM "$pid" 2>/dev/null || true
  local count=0
  while qqnas_pid_alive "$pid" && [ "$count" -lt 25 ]; do
    sleep 1
    count=$((count + 1))
  done
  if qqnas_pid_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$QQNAS_PID_FILE" 2>/dev/null || true
  return 0
}

# 只处理本应用账号目录下的进程：先读 pid 文件，再按 HOME 兜底。
qqnas_stop_accounts() {
  local accounts_dir="${QQNAS_DATA_DIR}/accounts"
  [ -d "$accounts_dir" ] || return 0

  local pids="" pid_file pid home environ found p
  for pid_file in "$accounts_dir"/*/napcat.pid; do
    [ -f "$pid_file" ] || continue
    pid=$(head -n 1 "$pid_file" 2>/dev/null | tr -dc '0-9')
    [ -n "$pid" ] || continue
    [ "$pid" = "1" ] && continue
    [ "$pid" = "$$" ] && continue
    qqnas_pid_protected "$pid" && continue
    # PID 可能被系统复用：确认该进程的 HOME 确实指向本账号，才允许停止。
    home="$(dirname "$pid_file")/home"
    [ -r "/proc/${pid}/environ" ] || continue
    grep -a -q -F "HOME=${home}" "/proc/${pid}/environ" 2>/dev/null || continue
    pids="$pids $pid"
  done

  for home in "$accounts_dir"/*/home; do
    [ -d "$home" ] || continue
    for environ in /proc/[0-9]*/environ; do
      [ -r "$environ" ] || continue
      found=$(grep -a -l -F "HOME=${home}" "$environ" 2>/dev/null | head -n 1)
      [ -n "$found" ] || continue
      p=$(basename "$(dirname "$found")")
      [ "$p" = "1" ] && continue
      [ "$p" = "$$" ] && continue
      qqnas_pid_protected "$p" && continue
      pids="$pids $p"
    done
  done

  local unique="" seen
  for pid in $pids; do
    case " $unique " in
      *" $pid "*) continue ;;
    esac
    unique="$unique $pid"
  done

  [ -n "$unique" ] || return 0

  qqnas_log "停止账号进程：${unique}"
  for pid in $unique; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  local count=0 alive
  while [ "$count" -lt 10 ]; do
    alive=""
    for pid in $unique; do
      qqnas_pid_alive "$pid" && alive="$alive $pid"
    done
    [ -z "$alive" ] && break
    sleep 1
    count=$((count + 1))
  done
  for pid in $unique; do
    qqnas_pid_alive "$pid" && kill -KILL "$pid" 2>/dev/null || true
  done

  rm -f "$accounts_dir"/*/napcat.pid 2>/dev/null || true
  return 0
}

qqnas_stop_all() {
  qqnas_stop_manager
  qqnas_stop_accounts
  return 0
}

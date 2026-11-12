#!/bin/sh
# QQ挂机仓 Docker 启动脚本
# - 把镜像内置的 noVNC 种子复制到持久化运行时目录（面板要求 runtime/novnc/core/rfb.js）
# - 如挂载了官方 Linux QQ 的 deb（/qq/*.deb），自动解包到运行时（QQ 客户端不随镜像分发）
# - 面板与账号数据全部落在 /data，容器重建不丢
set -eu

DATA_DIR="${QQFARM_DATA_DIR:-/data}"
RUNTIME_DIR="${QQFARM_RUNTIME_DIR:-$DATA_DIR/runtime}"
export QQFARM_DATA_DIR="$DATA_DIR"
export QQFARM_RUNTIME_DIR="$RUNTIME_DIR"

mkdir -p "$DATA_DIR" "$RUNTIME_DIR/lib" "$RUNTIME_DIR/QQ"

# 1) 内置 noVNC（Debian novnc 包）
if [ ! -f "$RUNTIME_DIR/novnc/core/rfb.js" ]; then
    rm -rf "$RUNTIME_DIR/novnc"
    cp -a /opt/novnc-seed "$RUNTIME_DIR/novnc"
    echo "[qqfarm] 已复制内置 noVNC 到 $RUNTIME_DIR/novnc"
fi

# 2) 让面板的运行库自检直接通过（系统已有 libvncclient/libvncserver）
for soname in libvncclient.so.1 libvncserver.so.1; do
    if [ ! -e "$RUNTIME_DIR/lib/$soname" ]; then
        target="$(ldconfig -p 2>/dev/null | awk -v n="$soname" '$1 == n {print $NF; exit}')"
        if [ -n "$target" ]; then
            ln -sf "$target" "$RUNTIME_DIR/lib/$soname"
        fi
    fi
done

# 3) 可选：解包挂载在 /qq 下的官方 Linux QQ deb
if [ ! -x "$RUNTIME_DIR/QQ/opt/QQ/qq" ]; then
    for deb in /qq/*.deb; do
        [ -f "$deb" ] || continue
        echo "[qqfarm] 解包官方 QQ：$deb"
        rm -rf "$RUNTIME_DIR/QQ"
        mkdir -p "$RUNTIME_DIR/QQ"
        if dpkg-deb -x "$deb" "$RUNTIME_DIR/QQ"; then
            chmod +x "$RUNTIME_DIR/QQ/opt/QQ/qq" 2>/dev/null || true
            find "$RUNTIME_DIR/QQ" -type f \( -name '*.so' -o -name '*.so.*' \) \
                -exec cp -p {} "$RUNTIME_DIR/lib/" \; 2>/dev/null || true
            echo "[qqfarm] 官方 QQ 已就绪：$RUNTIME_DIR/QQ/opt/QQ/qq"
            break
        fi
        echo "[qqfarm] 解包失败：$deb" >&2
    done
fi

if [ ! -x "$RUNTIME_DIR/QQ/opt/QQ/qq" ]; then
    echo "[qqfarm] 未检测到官方 QQ 客户端：可把 deb 放进 ./qq 后重启容器，或在面板「环境准备」里填写下载直链"
fi

exec python3 /app/panel/server.py

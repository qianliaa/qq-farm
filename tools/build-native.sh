#!/usr/bin/env bash
# QQ 多开挂机（原生版）· NAS 侧构建脚本
#
# 在【飞牛 NAS 或任意 Linux】上执行，不要用 Windows 直接跑：
#   bash tools/build-native.sh --qq-deb /path/QQ_x.x.x_amd64_01.deb
#   bash tools/build-native.sh --slim
#
# 作用：把官方 Linux QQ 客户端、Xvfb / x11vnc / 系统依赖库、noVNC 页面
#       解包进 native/app/runtime/，然后用飞牛官方 fnpack 打出可安装的 .fpk。
# 全程不需要 root（apt-get download 与 dpkg-deb -x 都只写当前目录）。

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native"
RUNTIME="$NATIVE/app/runtime"
DIST="$ROOT/dist"
WORK="$ROOT/tools/.native-build"
FNPACK_LINUX="https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64"
FNPACK_ARM="https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-arm64"
NOVNC_URL="https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz"
QQ_URL_DEFAULT_AMD64="https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.15_241210_amd64_01.deb"

MODE="bundle"
QQ_DEB=""
QQ_URL=""
ARCH=""
FNPACK=""
CLEAN=0
EXTRA_DEBS=""

usage() {
    cat <<'EOF'
用法: bash tools/build-native.sh [选项]

  --bundle              默认。下载并捆绑官方 QQ + Xvfb/x11vnc + noVNC + 依赖库
  --online              打「在线补齐包」：纯代码、platform=all、装完由面板一键补齐（推荐）
  --slim                精简包：只打面板代码，运行时使用系统已装的 qq / Xvfb / x11vnc
  --qq-deb <路径>       本地官方 QQ deb 文件（推荐，去 im.qq.com 下载对应架构）
  --qq-url <URL>        直接从 URL 下载官方 QQ deb
  --arch x86|arm        覆盖自动检测的架构（写入 manifest.platform）
  --extra-debs "a b"    额外要一并 apt download + 解包的 Debian 包名
  --fnpack <路径>       指定 fnpack 可执行文件，默认自动下载官方 Linux 版
  --clean               构建前清空 native/app/runtime
  -h, --help            显示帮助

示例（在飞牛 NAS 上；不需要 sudo）：
  bash tools/build-native.sh --qq-deb ~/QQ_3.2.15_amd64_01.deb
  bash tools/build-native.sh --slim
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --bundle) MODE="bundle"; shift ;;
        --online) MODE="online"; shift ;;
        --slim) MODE="slim"; shift ;;
        --qq-deb) QQ_DEB="$2"; shift 2 ;;
        --qq-url) QQ_URL="$2"; shift 2 ;;
        --arch) ARCH="$2"; shift 2 ;;
        --extra-debs) EXTRA_DEBS="$2"; shift 2 ;;
        --fnpack) FNPACK="$2"; shift 2 ;;
        --clean) CLEAN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$1" >&2; usage; exit 1 ;;
    esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[提示] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "本脚本必须在 Linux / 飞牛 NAS 上运行（当前是 $(uname -s)）。"
command -v tar >/dev/null || die "缺少 tar"
command -v python3 >/dev/null || die "缺少 python3（面板与打包后处理需要）"
command -v curl >/dev/null || command -v wget >/dev/null || die "缺少 curl 或 wget"

if [ -z "$ARCH" ]; then
    case "$(uname -m)" in
        x86_64|amd64) ARCH="x86" ;;
        aarch64|arm64) ARCH="arm" ;;
        *) die "无法识别架构 $(uname -m)，请用 --arch 指定 x86 或 arm" ;;
    esac
fi

MACHINE="$(uname -m)"
[ "$ARCH" = "x86" ] && DEB_ARCH="amd64" || DEB_ARCH="arm64"

say "构建模式：$MODE / 架构：$ARCH ($MACHINE) / 输出：$DIST"
mkdir -p "$DIST" "$WORK" "$RUNTIME"

if [ "$CLEAN" -eq 1 ]; then
    say "清空 $RUNTIME"
    find "$RUNTIME" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} + 2>/dev/null || true
fi

# --------------------------------------------------------------------------
# 0. fnpack
# --------------------------------------------------------------------------
if [ -z "$FNPACK" ]; then
    FNPACK="$ROOT/tools/fnpack"
    if [ ! -x "$FNPACK" ]; then
        say "下载飞牛官方 fnpack"
        URL="$FNPACK_LINUX"
        [ "$MACHINE" = "aarch64" ] && URL="$FNPACK_ARM"
        if command -v curl >/dev/null; then curl -fsSL -o "$FNPACK" "$URL" || die "fnpack 下载失败，请手动下载后用 --fnpack 指定";
        else wget -qO "$FNPACK" "$URL" || die "fnpack 下载失败"; fi
        chmod +x "$FNPACK"
    fi
fi
[ -x "$FNPACK" ] || die "fnpack 不可执行：$FNPACK"

# --------------------------------------------------------------------------
# 1. manifest 架构
# --------------------------------------------------------------------------
if [ "$MODE" = "bundle" ]; then
    say "写入 manifest.platform=$ARCH（离线全量包含架构相关二进制）"
    python3 - "$NATIVE/manifest" "$ARCH" <<'PY'
import re, sys
path, arch = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
text = re.sub(r"^platform\s*=.*$", f"platform              = {arch}", text, flags=re.M)
open(path, "w", encoding="utf-8").write(text)
PY
else
    say "保持 manifest.platform=all（在线补齐包为纯代码，x86 / ARM 通用）"
    python3 - "$NATIVE/manifest" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
text = re.sub(r"^platform\s*=.*$", "platform              = all", text, flags=re.M)
open(path, "w", encoding="utf-8").write(text)
PY
fi

# --------------------------------------------------------------------------
# 2. 在线 / 精简包：跳过二进制下载
# --------------------------------------------------------------------------
if [ "$MODE" = "online" ]; then
    warn "在线补齐包：不打包任何二进制。安装后由面板「环境准备」按需下载，x86 / ARM 通用。"
elif [ "$MODE" = "slim" ]; then
    warn "精简包模式：不会捆绑 QQ / Xvfb / x11vnc / noVNC。"
    warn "安装后需要在 SSH 里执行一次："
    warn "  sudo apt update && sudo apt install -y xvfb x11vnc fonts-wqy-microhei \\"
    warn "      libnss3 libgbm1 libasound2 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0"
    warn "  sudo dpkg -i QQ_xxx_${DEB_ARCH}.deb"
    warn "并把 noVNC 的 core/ vendor/ 放到 native/app/runtime/novnc/ 后重新打包。"
else
    # ------------------------------------------------------------------
    # 3. noVNC 静态页
    # ------------------------------------------------------------------
    NOVNC_DIR="$RUNTIME/novnc"
    if [ -f "$NOVNC_DIR/core/rfb.js" ]; then
        say "noVNC 已存在，跳过下载"
    else
        say "下载 noVNC v1.6.0"
        rm -rf "$WORK/novnc-src" && mkdir -p "$WORK/novnc-src"
        TARBALL="$WORK/novnc.tar.gz"
        if command -v curl >/dev/null; then curl -fsSL -o "$TARBALL" "$NOVNC_URL" || die "noVNC 下载失败（可用代理或手动放置）";
        else wget -qO "$TARBALL" "$NOVNC_URL" || die "noVNC 下载失败"; fi
        tar -xzf "$TARBALL" -C "$WORK/novnc-src" --strip-components=1 || die "noVNC 解压失败"
        mkdir -p "$NOVNC_DIR"
        cp -a "$WORK/novnc-src/core" "$NOVNC_DIR/" || die "noVNC core 复制失败"
        cp -a "$WORK/novnc-src/vendor" "$NOVNC_DIR/" || die "noVNC vendor 复制失败"
    fi

    # ------------------------------------------------------------------
    # 4. 官方 Linux QQ deb
    # ------------------------------------------------------------------
    QQ_DIR="$RUNTIME/QQ"
    if [ -f "$QQ_DIR/opt/QQ/qq" ]; then
        say "官方 QQ 已解包，跳过"
    else
        QQLOCAL="$QQ_DEB"
        if [ -z "$QQLOCAL" ]; then
            if [ "$DEB_ARCH" = "arm64" ]; then
                URL="$QQ_URL"
            else
                URL="${QQ_URL:-$QQ_URL_DEFAULT_AMD64}"
            fi
            if [ -z "$URL" ]; then
                die "请提供 --qq-deb <本地文件> 或 --qq-url <直链>（去 https://im.qq.com/linuxqq/ 复制 ${DEB_ARCH} 版链接）"
            fi
            QQLOCAL="$WORK/qq.deb"
            say "下载官方 QQ：$URL"
            if command -v curl >/dev/null; then curl -fL --retry 2 -o "$QQLOCAL" "$URL" || die "QQ deb 下载失败，请用 --qq-deb 指定本地文件";
            else wget -O "$QQLOCAL" "$URL" || die "QQ deb 下载失败"; fi
        fi
        [ -f "$QQLOCAL" ] || die "找不到 QQ deb：$QQLOCAL"
        command -v dpkg-deb >/dev/null || die "缺少 dpkg-deb，无法解包 QQ（飞牛基于 Debian， normally 自带）"
        say "解包官方 QQ → $QQ_DIR"
        rm -rf "$QQ_DIR" && mkdir -p "$QQ_DIR"
        dpkg-deb -x "$QQLOCAL" "$QQ_DIR" || die "QQ deb 解包失败"
        [ -f "$QQ_DIR/opt/QQ/qq" ] || die "解包后没找到 opt/QQ/qq，可能下载的不是 Linux QQ deb"
        chmod +x "$QQ_DIR/opt/QQ/qq"
    fi

    # ------------------------------------------------------------------
    # 5. Xvfb / x11vnc / 依赖库（apt download，不需要 root）
    # ------------------------------------------------------------------
    SYS_DIR="$RUNTIME/sys"
    if [ -f "$SYS_DIR/usr/bin/Xvfb" ] || [ -f "$SYS_DIR/bin/Xvfb" ]; then
        say "图形栈已解包，跳过"
    else
        command -v apt-get >/dev/null || die "缺少 apt-get，无法下载系统依赖；请改用 --slim 或手动放置二进制"
        command -v dpkg-deb >/dev/null || die "缺少 dpkg-deb"
        say "收集 Xvfb / x11vnc 的一阶依赖包"
        DIRECT=$(apt-cache depends --no-recommends --no-suggests --no-conflicts \
                   --no-breaks --no-replaces xvfb x11vnc 2>/dev/null \
                 | awk '/^[[:space:]]+Depends:/{print $2}' | sed 's/[<>]//g' \
                 | grep -v '^libc6$' | sort -u | tr '\n' ' ')
        # Electron 常见运行库 + x11vnc 运行库，尽量一并带上
        PKGS="$DIRECT libnss3 libnspr4 libgbm1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
libatspi2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
libxrandr2 libxshmfence1 libx11-xcb1 libxcb-dri3-0 libpixman-1-0 libxfont2 \
libfontenc1 libxau6 libxdmcp6 libvncserver1 libjpeg62-turbo libssl3 $EXTRA_DEBS xvfb x11vnc"
        PKGS=$(echo "$PKGS" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')
        echo "  待下载包数：$(echo "$PKGS" | wc -w)"
        rm -rf "$WORK/debs" && mkdir -p "$WORK/debs"
        ( cd "$WORK/debs" && apt-get download $PKGS >/dev/null 2>&1 ) || warn "部分包下载失败（常见，虚拟包或版本差异），继续解包已下载的"
        COUNT=$(find "$WORK/debs" -name '*.deb' | wc -l)
        [ "$COUNT" -gt 0 ] || die "一个 deb 都没下载到。请检查 apt 源（apt update 需要 root，或换用 --slim）"
        say "解包 $COUNT 个 deb → $SYS_DIR"
        rm -rf "$SYS_DIR" && mkdir -p "$SYS_DIR"
        for deb in "$WORK/debs"/*.deb; do
            dpkg-deb -x "$deb" "$SYS_DIR" 2>/dev/null || true
        done
        find "$SYS_DIR" -type f \( -name 'Xvfb' -o -name 'x11vnc' \) -exec chmod +x {} + 2>/dev/null || true
        XVFB=$(find "$SYS_DIR" -type f -name Xvfb | head -1)
        VNC=$(find "$SYS_DIR" -type f -name x11vnc | head -1)
        [ -n "$XVFB" ] || die "解包后没找到 Xvfb，请检查 apt 源或改用 --slim"
        [ -n "$VNC" ] || warn "解包后没找到 x11vnc，面板会回退到系统 /usr/bin/x11vnc"
    fi

    # ------------------------------------------------------------------
    # 6. 汇总 .so 到 lib/，供 LD_LIBRARY_PATH 使用
    # ------------------------------------------------------------------
    say "收集动态库到 runtime/lib"
    LIB_DIR="$RUNTIME/lib"
    rm -rf "$LIB_DIR" && mkdir -p "$LIB_DIR"
    find "$SYS_DIR" -type f \( -name '*.so' -o -name '*.so.*' \) -print0 2>/dev/null \
        | while IFS= read -r -d '' f; do
            cp -a "$f" "$LIB_DIR/" 2>/dev/null || true
          done
    # QQ deb 自带的库也带上（相对路径解析更稳）
    find "$QQ_DIR" -type f \( -name '*.so' -o -name '*.so.*' \) -print0 2>/dev/null \
        | while IFS= read -r -d '' f; do
            cp -a "$f" "$LIB_DIR/" 2>/dev/null || true
          done
    echo "  共 $(find "$LIB_DIR" -type f | wc -l) 个库文件"

    # ------------------------------------------------------------------
    # 7. 中文字体（可选，失败不影响构建）
    # ------------------------------------------------------------------
    if [ ! -d "$RUNTIME/fonts" ] || [ -z "$(ls -A "$RUNTIME/fonts" 2>/dev/null)" ]; then
        say "尝试下载中文字体 fonts-wqy-microhei（可选）"
        mkdir -p "$RUNTIME/fonts" "$WORK/fonts"
        ( cd "$WORK/fonts" && apt-get download fonts-wqy-microhei >/dev/null 2>&1 ) || true
        for deb in "$WORK/fonts"/*.deb; do
            [ -f "$deb" ] && dpkg-deb -x "$deb" "$RUNTIME/fonts" 2>/dev/null || true
        done
        FONT_FILE=$(find "$RUNTIME/fonts" -type f \( -name '*.ttf' -o -name '*.ttc' -o -name '*.otf' \) 2>/dev/null | head -1)
        FONT_DIR=$(dirname "${FONT_FILE:-$RUNTIME/fonts}")
        cat > "$RUNTIME/fonts/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>/tmp/qqfarm-fontconfig</cachedir>
</fontconfig>
EOF
    fi

    # ------------------------------------------------------------------
    # 8. 依赖自检（ldd）
    # ------------------------------------------------------------------
    say "检查官方 QQ 二进制的动态库"
    if command -v ldd >/dev/null && [ -f "$QQ_DIR/opt/QQ/qq" ]; then
        MISSING=$(LD_LIBRARY_PATH="$LIB_DIR" ldd "$QQ_DIR/opt/QQ/qq" 2>/dev/null | grep 'not found' || true)
        if [ -n "$MISSING" ]; then
            warn "以下库仍未找到（多半是 fnOS 系统自带的，运行时会自动从系统加载）："
            echo "$MISSING" | sed 's/^/    /' >&2
            warn "若安装后 QQ 起不来，把对应包名追加到 --extra-debs 重新构建。"
        else
            echo "  动态库齐全"
        fi
    fi
fi

# --------------------------------------------------------------------------
# 9. 校验源码 + 打包
# --------------------------------------------------------------------------
say "校验 FPK 源码"
python3 "$ROOT/tools/build-native-check.py" || die "源码校验失败"

# py_compile 会留下 __pycache__，不能打进 fpk
find "$NATIVE" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$NATIVE" -type f -name '*.pyc' -delete 2>/dev/null || true

say "调用 fnpack 打包"
rm -f "$ROOT/qqfarm-native.fpk"
( cd "$ROOT" && "$FNPACK" build --directory "$NATIVE" ) || die "fnpack 打包失败"
RAW="$ROOT/qqfarm-native.fpk"
[ -f "$RAW" ] || RAW=$(find "$ROOT" -maxdepth 1 -name '*.fpk' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
[ -f "$RAW" ] || die "找不到 fnpack 输出的 fpk"

VERSION=$(awk -F= '/^version/{gsub(/ /,"",$2);print $2}' "$NATIVE/manifest")
case "$MODE" in
    online) OUT="$DIST/qqfarm-native-${VERSION}.fpk" ;;
    slim)   OUT="$DIST/qqfarm-native-${VERSION}-${ARCH}-slim.fpk" ;;
    *)      OUT="$DIST/qqfarm-native-${VERSION}-${ARCH}.fpk" ;;
esac

say "修正 cmd/* 执行位并输出到 $OUT"
python3 - "$RAW" "$OUT" <<'PY'
import copy, io, sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
with tarfile.open(src, mode="r:gz") as tin, tarfile.open(dst, mode="w:gz") as tout:
    for m in tin.getmembers():
        data = tin.extractfile(m).read() if m.isfile() else None
        info = copy.copy(m)
        if info.name.startswith("cmd/") and info.isfile():
            info.mode = 0o755
        tout.addfile(info, io.BytesIO(data) if data is not None else None)
with tarfile.open(dst, mode="r:gz") as t:
    assert all(m.mode == 0o755 for m in t.getmembers()
               if m.name.startswith("cmd/") and m.isfile())
PY
[ "$RAW" != "$OUT" ] && rm -f "$RAW"

say "完成：$OUT"
ls -lh "$OUT"
echo
echo "安装：飞牛应用中心 → 手动安装 → 选择上面的 .fpk"
echo "全量包模式会在安装时自动拉取「Python 3.12 运行时」应用。"

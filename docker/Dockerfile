FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8 \
    TZ=Asia/Shanghai \
    QQFARM_PORT=8788 \
    QQFARM_DATA_DIR=/data \
    QQFARM_RUNTIME_DIR=/data/runtime \
    QQFARM_STATIC_DIR=/app/ui \
    QQFARM_MANIFEST=/app/manifest \
    QQFARM_DEPLOY=docker

# 图形栈 + 官方 Linux QQ（Electron）运行库。
# 保留 apt 索引，面板「环境准备」里的 apt-get download 自愈仍可工作。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        novnc \
        dpkg \
        fontconfig \
        fonts-noto-cjk \
        fonts-wqy-microhei \
        ca-certificates \
        tzdata \
        libnss3 \
        libnspr4 \
        libgbm1 \
        libasound2 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxkbcommon-x11-0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libxshmfence1 \
        libx11-xcb1 \
        libxcb1 \
        libxcb-dri3-0 \
        libxcb-icccm4 \
        libxcb-image0 \
        libxcb-keysyms1 \
        libxcb-randr0 \
        libxcb-render-util0 \
        libxcb-shape0 \
        libxcb-xinerama0 \
        libxcb-xkb1 \
        libxext6 \
        libxi6 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        libvncclient1 \
        libvncserver1 \
        libjpeg62-turbo \
        libpixman-1-0 \
    && mkdir -p /opt/novnc-seed \
    && cp -a /usr/share/novnc/. /opt/novnc-seed/

WORKDIR /app
COPY native/app/panel/ /app/panel/
COPY native/app/ui/ /app/ui/
# manifest：面板「检测更新」读当前版本用；QQFARM_DEPLOY：让面板显示 Docker 专属更新指引
COPY native/manifest /app/manifest
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data /qq

VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8788/', timeout=3)"

CMD ["/entrypoint.sh"]

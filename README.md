# QQ挂机仓（qq-farm）

[![Release](https://img.shields.io/github/v/release/qianliaa/qq-farm)](https://github.com/qianliaa/qq-farm/releases)
[![Docker](https://img.shields.io/badge/ghcr.io-qq--farm-blue)](https://github.com/qianliaa/qq-farm/pkgs/container/qq-farm)
[![License](https://img.shields.io/github/license/qianliaa/qq-farm)](LICENSE)

一个可以装进**飞牛私有云 fnOS 应用中心**的第三方原生应用：在 NAS 上同时常驻多个 QQ 账号，
浏览器里扫码登录，关掉页面账号依然在线。使用腾讯官方 Linux QQ 客户端，不用 NapCat 等第三方协议端。

提供两种部署方式：**飞牛 fnOS 原生 FPK**（不依赖 Docker）与 **Docker 镜像**（群晖、Unraid、普通 Linux 均可）。

- 开发者 / 发布者：千里
- 适用系统：飞牛 fnOS（x86_64 / ARM 通用）
- 依赖：飞牛商店「Python 3.12 运行时」（安装时自动部署）

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/native.md](docs/native.md) | 原生版原理、安装向导、环境准备、运行结构、离线全量包、构建参数 |
| [docs/faq.md](docs/faq.md) | 常见问题：图形栈未就绪、网页桌面连不上、白屏、端口占用、数据目录 |
| [Releases](https://github.com/qianliaa/qq-farm/releases) | 发布包与更新说明 |

## 安装

1. 到 [Releases](https://github.com/qianliaa/qq-farm/releases) 下载最新的 `qqfarm-native-<版本>.fpk`；
2. 飞牛「应用中心 → 手动安装」选择该文件；
3. 打开应用面板 →「环境准备」一键下载图形栈与官方 QQ 客户端（需 NAS 能联网，全程普通用户权限，无需 root / SSH）；
4. 创建账号 → 打开网页桌面 → 手机 QQ 扫码。

已安装的用户也可以在面板「设置 → 版本与更新」里**一键检测更新**（默认读取本仓库 Releases）。

## Docker 部署

镜像：`ghcr.io/qianliaa/qq-farm:latest`（`linux/amd64`、`linux/arm64`），与原生版跑同一套面板代码，图形栈由镜像内置。

```bash
mkdir -p qq-farm/data qq-farm/qq && cd qq-farm
curl -O https://raw.githubusercontent.com/qianliaa/qq-farm/main/docker-compose.yml
docker compose up -d
```

1. 把官方 Linux QQ 的 deb 放进 `qq/` 后执行 `docker compose restart`（也可在面板「环境准备 → 方式 A」填下载直链）；
2. 打开 `http://<NAS>:8788/`，首次设置管理密码；
3. 新增账号 → 打开网页桌面 → 手机 QQ 扫码。

- 镜像已内置 Xvfb、x11vnc、noVNC 与 Electron 运行库，**不包含 QQ 客户端**（版权归腾讯，需自行从 [im.qq.com/linuxqq](https://im.qq.com/linuxqq/) 下载对应架构的 deb）
- `./data` 持久化账号、登录态与运行时；`./qq` 只读挂载 deb，容器重建不丢数据
- 只暴露 8788；每个账号的 VNC 仅在容器内回环监听，经带登录校验的 WebSocket 转发
- 单账号建议预留 1GB 以上内存；ARM 设备请选 `arm64` 架构的 QQ deb

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 多账号隔离 | 每个账号独立进程组：Xvfb 虚拟屏 + VNC + 官方 QQ，独立 HOME / DISPLAY / 数据目录 |
| 网页扫码登录 | 内置 noVNC 网页桌面，浏览器扫码，无需任何客户端 |
| 崩溃自愈 | 看门狗指数退避自动重启；卡片直接显示哪个进程退出、退出原因（含 OOM / 缺依赖判断） |
| 检测更新 | 面板内对比 GitHub Releases 版本，展示更新说明与安装包下载地址 |
| 省资源 | 默认 1024x768 虚拟桌面、VNC 空闲降频、日志自动轮转 |
| 中文面板 | 管理密码登录、账号增删改、日志查看、配置导出 |

单账号建议预留 1GB 以上内存（官方 QQ 为 Electron 应用）。

## 目录结构

```
native/     原生 FPK 源码（面板 Python 后端 + 前端 + 生命周期脚本）
docker/     Docker 部署（Dockerfile + 容器启动脚本）
tools/      校验 / 测试 / 构建脚本（fnpack 由脚本自动下载，或自行放进 tools/）
docs/       详细文档与常见问题
dist/       本地产物（不入库，正式包见 Releases）
```

## 从源码构建

```bash
# 1) 校验源码 + 跑回归（纯 Python，跨平台）
python tools/build-native-check.py
python tools/test_native_panel.py    # 面板端到端（56 项断言）
python tools/test_native_diag.py     # 崩溃诊断 / 色深 / 更新检查
python tools/test_native_runtime.py  # 运行时与部署方式

# 2) 打包（Linux / NAS，自动下载 fnpack 并修正 cmd/* 权限）
bash tools/build-native.sh --online   # 在线补齐包，产物 dist/qqfarm-native-<版本>.fpk
```

Windows 上也可以手动打包：从 [飞牛开发者站](https://developer.fnnas.com/) 取 `fnpack.exe` 放到 `tools/`，
执行 `./tools/fnpack.exe build --directory native`，再把包内 `cmd/*` 的权限改成 0755（Windows 默认 0666）。
打包前记得清理 `__pycache__`，避免 `.pyc` 进包。

Docker 镜像：

```bash
docker build -f docker/Dockerfile -t qq-farm .
docker run -d --name qq-farm -p 8788:8788 \
  -v "$PWD/data:/data" -v "$PWD/qq:/qq:ro" --shm-size=1g qq-farm
```

## CI

- 推送到 `main` 或 PR：跑源码校验与三组回归测试
- 推送到 `main`：构建并推送 GHCR 镜像（amd64 / arm64）
- 打 `v*` 标签：构建 FPK 并自动创建 Release

## 声明

- 本应用为第三方工具，与腾讯、飞牛官方无关；QQ 客户端版权归腾讯所有。
- 在服务器环境长期挂机可能触发 QQ 风控（要求重新扫码、限制登录等），请勿使用重要账号，相关后果由使用者自行评估承担。
- 面板仅建议在可信局域网使用，不要把 8788 端口暴露到公网。

## 许可证

[MIT](LICENSE)。

# QQ挂机仓（qq-farm）

一个可以装进**飞牛私有云 fnOS 应用中心**的第三方原生应用：在 NAS 上同时常驻多个 QQ 账号，
浏览器里扫码登录，关掉页面账号依然在线。**不依赖 Docker、不用 NapCat 等第三方协议端，跑的是腾讯官方 Linux QQ 客户端。**

- 开发者 / 发布者：千里
- 适用系统：飞牛 fnOS（x86_64 / ARM 通用）
- 依赖：飞牛商店「Python 3.12 运行时」（安装时自动部署）

## 安装

1. 到 [Releases](https://github.com/qianliaa/qq-farm/releases) 下载最新的 `qqfarm-native-*.fpk`；
2. 飞牛「应用中心 → 手动安装」选择该文件；
3. 打开应用面板 →「环境准备」一键下载图形栈与官方 QQ 客户端（需 NAS 能联网，全程普通用户权限，无需 root / SSH）；
4. 创建账号 → 打开网页桌面 → 手机 QQ 扫码。

已安装的用户也可以在面板「设置 → 版本与更新」里**一键检测更新**（默认读取本仓库 Releases）。

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
native/     原生版 FPK 源码（面板 Python 后端 + 前端 + 生命周期脚本）
fpk/        早期 Docker 版源码（已不推荐，仅留档）
tools/      校验 / 测试 / 打包脚本（fnpack.exe 需自行从飞牛开发者站下载）
dist/       本地产物（不入库，正式包见 Releases）
```

## 从源码构建

```bash
# 1) 下载飞牛官方 fnpack 放到 tools/（https://developer.fnnas.com/）
# 2) 校验源码
python tools/build-native-check.py
# 3) 清缓存并打包（注意：先清 __pycache__ 再打包，避免 .pyc 进包）
./tools/fnpack.exe build --directory native
# 4) cmd/* 脚本改 0755 后输出 fpk（Windows 打包默认 0666，必须修正）
python tools/test_native_panel.py   # 56 项回归
python tools/test_native_diag.py    # 崩溃诊断 / 色深 / 更新检查等专项
```

## 声明

- 本应用为第三方工具，与腾讯、飞牛官方无关；QQ 客户端版权归腾讯所有。
- 在服务器环境长期挂机可能触发 QQ 风控（要求重新扫码、限制登录等），请勿使用重要账号，相关后果由使用者自行评估承担。
- 面板仅建议在可信局域网使用，不要把 8788 端口暴露到公网。

更多实现细节见 [README-native.md](README-native.md)。

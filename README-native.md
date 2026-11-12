# QQ 多开挂机 · 原生版（不依赖 Docker）

**这是解决「安装时提示没有 Docker 权限」的版本。**

`dist/qqfarm-native-1.0.0.fpk` 是一个**可以直接安装**的原生 FPK（x86 / ARM 通用）：
manifest 里没有 `docker-project`、没有 `install_dep_apps`，应用中心安装时
**不会检查 Docker 服务、不会检查 Docker 权限、不会去拉任何依赖应用**。
面板就是一个普通 Python 进程，每个 QQ 账号是一组原生进程。

> 硬约束：不依赖 Docker、不用 NapCat 或任何第三方 QQ 协议端、跑的是**腾讯官方 Linux QQ 客户端**。

---

## 一、和 Docker 版的区别

| | Docker 版 | 原生版（装这个） |
| --- | --- | --- |
| 应用类型 | `docker-project` FPK | 原生 FPK（`config/resource` 只有 `data-share`） |
| 安装门槛 | **需要 Docker 服务与权限**（你可能就是卡在这里） | **零依赖，直接装** |
| 运行时 | `python:3.11-alpine` 容器 | 优先商店 Python 3.12 运行时，没装则用系统 `python3` |
| 账号隔离 | 每号一个容器 + Docker 卷 | 每号独立 DISPLAY / HOME / 端口 + 独立目录 |
| 端口 | 8787 + 每号一个 5801+ | **只有 8788**，所有桌面走 `/desktop/<id>/` |
| 图形栈 | QQ 容器镜像自带 | 装好后由面板「环境准备」一键补齐到应用目录 |
| 成品包 | `dist/qqfarm-1.0.0.fpk` | `dist/qqfarm-native-1.0.0.fpk`（可直接装） |
| 是否需要 root / SSH | 否 | **否** |

**共同点**：官方 Linux QQ 客户端、浏览器扫码登录、常驻在线、独立登录数据、中文管理面板、
应用中心启停联动、卸载默认保留数据。

---

## 二、为什么需要「环境准备」这一步

飞牛商店里的运行时是**语言运行时**（`python312` / `nodejs_v22` / `java-17-openjdk` 等，
路径 `/var/apps/<name>/target/bin`），只提供解释器。而官方 Linux QQ 是 Electron 客户端，
运行还必须要有：

```
Xvfb     虚拟 X server（QQ 要画窗口、显示登录二维码）
x11vnc   把 X display 转成 RFB/VNC 协议
noVNC    浏览器里的 VNC 客户端（网页桌面）
libnss3 / libgbm1 / libasound2 / libatk-* / libX* ...   QQ 与图形栈的动态库
```

飞牛商店**没有**图形栈运行时，第三方 FPK 又是 `run-as: package`，**无 root 权限，
不能 apt install 系统包**。所以采用飞牛官方文档认可的 **Bundled Runtime（捆绑运行时）** 策略：
把这些二进制用 `dpkg-deb -x` 解包到应用自己的 `app/runtime/` 目录，用 `LD_LIBRARY_PATH` 加载，
全程普通用户运行，不改动系统。

区别在于**获取时机**：

- **默认（推荐）**：先装一个不含二进制的小包 → 打开面板 → 首页「环境准备」里一键下载解包。
  不需要你跑脚本、不需要 SSH、不需要 root。
- **可选（离线/内网）**：用 `tools/build-native.sh` 在 Linux 上预先把二进制打进 FPK（见第六节）。

> 和 NapCat 的区别：这里跑的是官方 QQ 客户端本体，不是协议实现，没有逆向协议栈。

---

## 三、安装步骤

1. 飞牛桌面 → **应用中心 → 手动安装** → 选择 `dist/qqfarm-native-1.0.0.fpk`（包内只有 Python 代码，x86 / ARM 通用）。
   **这一步不会再出现 Docker 权限提示。**
2. 安装向导：确认说明 → 选虚拟桌面分辨率（默认 1280×800）→ 勾选风险确认。
3. 桌面点开「QQ 多开挂机（原生）」，首次设置管理密码（≥8 位）。
4. 首页会显示「首次使用：先补齐图形栈与官方 QQ 客户端」，点 **「立即准备」**。

---

## 四、环境准备（只做一次）

在弹窗里提供**官方 Linux QQ 的 deb**，二选一：

| 方式 | 操作 |
| --- | --- |
| A · 下载直链 | 去 `https://im.qq.com/linuxqq/` 复制与 NAS 架构一致（amd64 / arm64）的 deb 链接，粘到「方式 A」 |
| B · 共享目录文件名（推荐） | 把 deb 下载到电脑，用飞牛「文件管理」上传到应用共享目录 `qqfarm/`，然后在「方式 B」填文件名 |

点「开始安装」后，面板会在后台依次完成（进度实时显示，可关闭页面，任务继续跑）：

1. 下载 noVNC v1.6.0，把 `core/` `vendor/` 放进 `app/runtime/novnc/`；
2. 用 `apt-get download` **只下载**（不安装到系统）`xvfb`、`x11vnc` 及常见 Electron 运行库，
   逐个 `dpkg-deb -x` 解包到 `app/runtime/sys/`，把 `.so*` 汇总到 `app/runtime/lib/`；
3. 解包官方 QQ deb 到 `app/runtime/QQ/`，并带上一份中文字体配置；
4. 写 `runtime/setup-status.json`，然后点「重新自检」。

右上角变成**「图形栈就绪」**后，就可以「＋ 新增账号」→「打开网页桌面」→ 手机 QQ 扫码了。
关掉浏览器页面，账号继续在线。

> apt 源不可用的 NAS：环境准备日志会明确提示，此时可以手动把二进制放到 `app/runtime/` 对应目录
> （`sys/usr/bin/Xvfb`、`sys/usr/bin/x11vnc`、`QQ/opt/QQ/qq`、`novnc/core/rfb.js`），或用第六节的离线脚本。

**账号数据**在应用共享目录（飞牛「文件管理 → 应用文件 → qqfarm」）：
`accounts/<ID>/home`、`config`、`cache`、`qqdata`，以及 `logs/<ID>.log`。
卸载默认保留，卸载向导里可选「全部删除」。

---

## 五、运行结构

```
cmd/main (fnOS 生命周期)
   └─ python3 app/panel/server.py        面板，监听 8788
        ├─ /                            管理界面
        ├─ /api/*                       账号 / 设置 / 日志 / 环境准备接口
        ├─ /desktop/<id>/              noVNC 引导页（需登录）
        ├─ /desktop/<id>/ws            WebSocket → 本机 x11vnc RFB 转发
        ├─ /novnc/*                    随包 noVNC 静态文件
        └─ procman：每账号一组进程
             ├─ Xvfb :101  -screen 0 1280x800x24
             ├─ x11vnc -display :101 -rfbport 15901 -listen 127.0.0.1 -nopw
             └─ qq --no-sandbox --user-data-dir=accounts/<id>/qqdata
```

- 进程用 `start_new_session` 独立成组，PID 记录在 `pids.json`；面板收到 TERM 优雅停止全部子进程，
  `cmd/main stop` 还有一层兜底清理。
- 看门狗每 12 秒检查一次，标记为「运行中」的账号进程挂了自动整组重启。
- x11vnc 只监听 `127.0.0.1`，外部访问必须经过面板的 WebSocket 代理，而代理校验登录 Cookie，
  所以**不需要为每个账号设 VNC 密码**，也不会把 VNC 端口暴露到局域网。

---

## 六、可选：离线预置全量包（内网 / 不想在线下载）

在飞牛 NAS 或任意 Linux 上执行（不需要 sudo）：

```bash
cd /vol1/docker/qqfarm
bash tools/build-native.sh --qq-deb ~/QQ_3.2.15_241210_amd64_01.deb
# 产物 dist/qqfarm-native-1.0.0-x86.fpk / -arm.fpk（含全部二进制，装完即就绪）
```

脚本会自动下载 fnpack Linux 版、noVNC、图形栈 deb，解包进 `native/app/runtime/`，
按架构改写 `manifest.platform`，再打包并修正 `cmd/*` 权限位。

| 参数 | 说明 |
| --- | --- |
| `--qq-deb <路径>` | 本地官方 QQ deb（推荐） |
| `--qq-url <URL>` | deb 下载直链 |
| `--slim` | 只打面板代码，运行时用系统命令 |
| `--arch x86\|arm` | 覆盖架构检测 |
| `--extra-debs "a b"` | 追加要解包的 Debian 包 |
| `--fnpack <路径>` | 指定已有 fnpack |
| `--clean` | 构建前清空 `app/runtime/` |

---

## 七、常见问题

**安装时仍提示 Docker 相关错误**
你装的多半是桌面上的 `qqfarm-1.0.0.fpk`（Docker 版）。请改选
`qqfarm-native-1.0.0.fpk`；原生版包名带 `native`，应用名是「QQ 多开挂机（原生版）」。

**右上角显示「图形栈未就绪」**
点「立即准备」看进度日志。常见原因：QQ deb 直链失效（改用方式 B 上传）、GitHub 打不开
（在「noVNC 备用地址」填镜像）、NAS 的 apt 源未初始化（日志会给出手动放置路径）。

**QQ 进程起来了但网页桌面连不上**
看账号日志，多半是 VNC 服务没起来（端口冲突 / 缺库）。可在账号「编辑」里换一个内部 VNC 端口。

**QQ 白屏 / 中文方块**
调小虚拟桌面分辨率、确认 `app/runtime/fonts/` 有中文字体；单账号内存建议 ≥1GB。

**8788 被占用**
同步改 `native/manifest` 的 `service_port` 与 `native/app/ui/config` 的 `port` 后重新打包。

**两版能同时装吗**
可以，appname 与端口都不同（`qqfarm` / 8787、`qqfarm-native` / 8788），但会各跑一份 QQ，注意内存。

---

## 八、风险与边界

- 官方 QQ deb 由你在自己的 NAS 上下载，不随包分发；链接会随版本更新，用「方式 B」上传本地文件最稳。
- 环境准备需要 NAS 能联网（noVNC / apt 包 / QQ deb）。内网环境请用第六节离线预置。
- 若 apt 源不可用，Xvfb 等组件需要手动放置或由系统已装版本提供；面板会明确列出缺失项。
- 二进制不能跨架构，离线全量包要分 x86 / arm；默认的在线补齐包本身是纯代码，架构无关。
- 在 NAS 上长期挂机可能触发 QQ 风控或要求重新验证，重要账号请谨慎。
- 面板有管理密码，网页桌面也需登录；仍建议只在可信局域网使用，不要把 8788 暴露到公网。
- **未在真机 fnOS 上实装验证**，建议先只挂 1 个号试跑。

---

## 九、相关文件

```
native/                          原生 FPK 源码
├── manifest                    零依赖（无 install_dep_apps / 无 docker-project）
├── config/resource             data-share
├── app/runtime/                环境准备时填充的捆绑运行时
├── app/panel/
│   ├── server.py               HTTP + 业务 + noVNC 静态与引导页 + 环境准备 API
│   ├── procman.py              Xvfb / x11vnc / QQ 进程组管理 + 看门狗
│   ├── wsproxy.py              标准库 WebSocket → RFB 转发
│   ├── setup_runtime.py        一键下载解包 noVNC / 图形栈 / 官方 QQ deb
│   └── static/                 管理界面（含环境准备弹窗）
├── cmd/                        生命周期（PID 文件，启停联动）
└── wizard/                     安装 / 配置 / 卸载向导
tools/build-native.sh           可选：离线预置全量包
tools/build-native-check.py      源码校验
tools/test_native_panel.py       端到端自测（mock 进程与下载，56 项断言）
```

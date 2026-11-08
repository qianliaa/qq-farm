# QQ 挂机仓 · 飞牛 NAS 版

在飞牛 NAS（fnOS）上原生托管多个 QQ 账号：每个号拥有独立的 QQ 数据目录、Xvfb 显示、NapCat WebUI 端口与 OneBot 端口，扫码登录后长期在线，配合可独立开关的升级任务保持活跃。

**2.0.0 起不再依赖 Docker。** 应用直接使用飞牛应用中心提供的 Node.js 22 运行时（`nodejs_v22`），Linux QQ 与 NapCat 在首次添加账号时安装到应用数据目录，所有运行文件都在飞牛的应用沙箱内。2.0.1 修复了飞牛窗口内本地存储被禁用时前端脚本中断的问题；2.0.2 修复了内联脚本时内容被替换模式展开、导致页面脚本损坏的问题；2.0.3 增强了安装包下载的断点续传、重试与多线路回退；2.0.4 新增空间说说任务，并把群签到改为官方 `set_group_sign` 接口；2.0.5 支持说说发布后按 tid 自动删除；2.0.6 重做面板排版与手机端适配，更换应用图标，并增加 GitHub 版本检测；2.0.7 将开发者与发布者信息更正为千里；2.0.8 修复飞牛桌面仍显示旧图标的问题；2.0.9 修复账号被踢下线但进程存活时保活误判为在线、掉线后不自动恢复的问题——保活改为以 NapCat 登录态权威复核，确认离线立即标记，并新增启动宽限期与「连续重启 3 次未恢复即暂停自动重启」的退避保护；2.0.10 起，每次停止/重启前自动快照 QQ 登录票据、启动时缺失即恢复，SIGTERM 宽限延长到 10 秒，各类重启（保活自愈、手动重启、面板或 NAS 重启）都保留登录状态，无需重新扫码；2.0.11 二维码秒开——缓存最近二维码毫秒级返回、后台静默刷新，登录弹窗不再长时间转圈等待 NapCat 阻塞生成；2.0.12 修复 NapCat 启动初期取码超时——二维码生成等待放宽到 45 秒，同一账号取码请求单飞去重，轮询不再堆叠报「WebUI 请求超时」；2.0.13 修复已登录账号掉线后重新扫码二维码一直出不来的问题——被踢账号内核卡在旧票据重登循环不进扫码阶段，取码为空时自动强制刷新出码，取码接口全异步不阻塞，扫码窗口内保活不再重启进程、二维码不会被重启作废；2.0.14 新增飞牛用户间隔离——主用户可在「全局设置 → 用户管理」为每个飞牛用户创建独立账号空间（各自用户名+密码登录），每个用户只看到并管理自己的 QQ 账号，账号列表、操作接口、日志全部按用户隔离，升级后已有账号自动归属主用户；2.0.15 新增通知设置——支持企业微信、钉钉、飞书群机器人 Webhook 与 Server酱、Bark，账号掉线与恢复在线即时推送（掉线通知 30 分钟内不重复），每个用户配置自己的通知；未设置访问密码时也支持用户隔离，输入用户名即进入各自账号空间（2.0.16 起改为自动读取飞牛登录身份，无需输入任何信息）。2.0.16 未设置访问密码时按飞牛登录身份自动隔离——自动识别飞牛登录态并建档，打开即用、无登录步骤，每个飞牛用户只看到自己的 QQ 账号；2.0.17 改为账号密码登录并长期记住——只需输入一次，之后打开自动进入，登录状态保持 180 天；主账号（安装向导设置的访问密码）可在「全局设置 → 用户管理」中创建、重置密码、删除普通用户，普通用户只看到并管理自己的 QQ 账号；2.0.18 修复账号被踢下线后二维码一直出不来——旧登录票据会让 QQ 内核反复重登而不进扫码页，现在连续多轮取不到码会自动清除失效票据并重启账号、强制回到扫码登录界面，手动「刷新二维码」同样会触发该自愈；2.0.19 新增自助注册——每个飞牛用户都能在登录页注册自己的用户名密码并自动登录，账号与设置各自隔离，只有飞牛主账号（UID 1000）注册出来的才是主账号、拥有用户管理与全局设置权限，安装主账号（访问密码）保留为兜底入口。

> 本项目基于 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 与 OneBot 11 协议，不是腾讯官方产品。QQ 等级成长取决于官方活跃天数规则，本项目只能帮助账号保持在线与日常互动，不能修改等级数据。请使用本人账号、遵守平台规则，风险自行承担。

## 功能

- **多账号同时在线**：一个 QQ 一套独立 HOME、数据目录、显示号与端口，互不干扰。
- **扫码登录**：管理面板内直接展示二维码，也可跳转账号自己的 NapCat WebUI。
- **独立任务开关**：保活、名片点赞、群签到、空间说说、定时喊话、随机活跃、关键词自动回复，每个任务单独启停。
- **单脚本执行**：每个任务卡片都有「立即执行」按钮，后端对应一个独立脚本（`scripts/*.cjs`），面板调度与 cron 手动跑互不影响。
- **官方能力对接**：群签到调用 NapCat 的 `set_group_sign`，空间说说调用 `send_qzone_msg`，不是简单的群消息模拟。
- **说说自动清理**：空间说说发布后可按 tid 自动删除，默认 60 秒，可自行调整或关闭，避免在空间留下任务痕迹。
- **版本检测**：面板内可直接检查 GitHub Release，发现新版本时给出提示与下载入口。
- **手机端适配**：窄屏自动切换为单列任务卡片、横向账号栏和全宽操作按钮。
- **自动保活**：定时探测在线状态，连续失败自动重启账号进程；NAS 重启后由应用中心拉起管理端，再按需恢复账号。
- **在线统计**：记录累计在线天数、连续在线天数，任务执行结果实时写入日志。
- **零依赖管理端**：纯 Node.js 内置模块，不需要 npm install。
- **数据本地化**：账号配置、登录态、日志全部保存在应用数据目录，可直接打包备份。

## 目录结构

```
qq-nas/
├── manager/               管理端（Node，零依赖）
│   ├── server.cjs         HTTP API + 内联页面
│   ├── lib/               原生 NapCat 进程管理、任务调度
│   └── public/            管理面板前端
├── shared/onebot.cjs      OneBot 11 HTTP 客户端（前后端脚本共用）
├── scripts/               可独立执行的升级任务脚本
├── runtime/napcat-install.sh   官方 NapCat 安装脚本（本地安装模式）
├── fnos-fpk/              飞牛应用中心安装包工程
│   ├── fpk-src/           manifest、生命周期脚本、向导、图标
│   ├── build-fpk.py       fpk 打包脚本（显式写入 Linux 权限）
│   └── dist/              生成的 .fpk 安装包
└── docs/
```

## 安装

### 方式一：飞牛应用中心安装 .fpk（推荐）

1. 打开飞牛桌面「应用中心」→ 右上角「手动安装」。
2. 下载 [`fnos-fpk/dist/qqnas_2.0.10_all.fpk`](fnos-fpk/dist/qqnas_2.0.10_all.fpk)（也可按下方「自行构建 fpk」生成），在应用中心右上角「手动安装」，按向导设置管理面板访问密码（可留空）。
3. 安装时会自动安装依赖应用 **Node.js v22**，无需手动准备运行库。
4. 安装完成后从桌面「QQ 挂机仓」图标打开，或直接访问 `http://NAS-IP:8787`。

应用数据位于 `/var/apps/qqnas/var`（实际落在安装时选择的存储空间 `@appdata/qqnas`），升级和重装默认保留；卸载时只有勾选「同时删除账号数据与 QQ 运行环境」才会清理。

### 方式二：直接跑管理端（调试用）

需要本机已有 Node.js 18+。NapCat 的安装与运行依赖 Linux、Xvfb 和图形库，仅建议在 Linux 上这样调试。

```bash
cd qq-nas
DATA_DIR=./data PORT=8787 node manager/server.cjs
```

## 首次使用

1. 打开面板，点击「添加 QQ」。
2. 首次添加账号时，面板会在后台安装 Linux QQ 与 NapCat，需要下载约 400–700 MB，视网络情况约 5–20 分钟。页面顶部会显示「安装运行环境」的进度，安装日志可在「运行环境」里查看。
3. 安装完成后账号会自动启动，弹出二维码，用手机 QQ 扫码并确认。
4. 登录成功后，账号状态变为「在线」，按需打开升级任务开关。

每个账号的数据在 `/var/apps/qqnas/var/accounts/<账号id>/`，删号不会误删其他账号。

## 运行方式

- 管理端：`cmd/main start` 通过 `nohup` 启动 `manager/server.cjs`，PID 写入应用数据目录的 `app.pid`，端口 8787。
- 账号进程：每个账号用独立的 `HOME` 和 `xvfb-run` 显示启动 `Napcat/opt/QQ/qq`，PID 写入 `accounts/<id>/napcat.pid`。
- 配置：`webui.json` 与 `onebot11.json` 由管理端生成，WebUI 监听 `127.0.0.1:<账号端口>`，OneBot HTTP 监听 `127.0.0.1:<账号端口>`，事件回调指向管理端。
- 端口：WebUI 默认从 6099 起、OneBot 从 3000 起，按账号依次分配，可在面板中查看。

## 任务说明

| 任务 | 作用 | 建议配置 |
| --- | --- | --- |
| 在线保活 | 定时探测登录状态，掉线自动重启账号进程 | 常开，间隔 5 分钟，失败阈值 2 |
| 名片点赞 | 每天给群成员或好友点赞 | 每天 1 次，10 人以内，间隔 3 秒 |
| 群签到 | 每天定时在指定群发送签到消息 | 每天 1 次，内容自定义 |
| 定时喊话 | 在固定时间点向群或好友发消息 | 每天 1–2 次，内容提前准备 |
| 随机活跃 | 活跃时段内随机发一句短句 | 间隔 90 分钟以上，话术自然 |
| 关键词自动回复 | 收到含关键词的消息时自动回复 | 冷却 60 秒以上，避免刷屏 |

注意事项：

- 所有定时任务只在账号在线时执行；保活任务独立运行。
- 任务失败后 5 分钟内不会重复重试，避免异常配置导致刷屏。
- 群签到发送的是普通群消息，不是 QQ 官方群签到接口。
- 点赞人数上限 20，间隔最低 1 秒；过于频繁容易触发风控。
- 建议低频、自然使用。挂机行为本身存在账号风险，重要账号请谨慎。

## 独立任务脚本

脚本读取应用数据目录中的 `config.json`，自动选择账号与 OneBot 端口，不需要手动填写地址。在 NAS 上执行：

```bash
APP=/var/apps/qqnas/target
DATA=/var/apps/qqnas/var
NODE=/var/apps/nodejs_v22/target/bin/node

# 查看账号在线状态
sudo DATA_DIR=$DATA $NODE $APP/scripts/status.cjs --account 大号

# 给群成员点赞
sudo DATA_DIR=$DATA $NODE $APP/scripts/like.cjs --account 大号 --source group --group 123456789 --count 10

# 群签到（调用官方 set_group_sign；带 --text 时签到后再发一条文字）
sudo DATA_DIR=$DATA $NODE $APP/scripts/sign.cjs --account 大号 --groups 123456789,987654321 --text 签到

# 发一条 QQ 空间说说
sudo DATA_DIR=$DATA $NODE $APP/scripts/qzone.cjs --account 大号 --content "今天天气不错" --right 1

# 发布后 60 秒自动删除（不留任务痕迹）
sudo DATA_DIR=$DATA $NODE $APP/scripts/qzone.cjs --account 大号 --content "今天天气不错" --delete-after 60

# 手动删除指定 tid 的说说
sudo DATA_DIR=$DATA $NODE $APP/scripts/qzone.cjs --account 大号 --delete-tid 1234567890abcdef

# 从上一次准备好的话术库里随机发一条
sudo DATA_DIR=$DATA $NODE $APP/scripts/qzone.cjs --account 大号 --file /var/apps/qqnas/var/qzone.txt

# 定时喊话
sudo DATA_DIR=$DATA $NODE $APP/scripts/broadcast.cjs --account 大号 --targets 123456789 --text "晚上好" --scope group
```

`--account` 支持备注、QQ 号或账号 id；只有一个账号时可以省略。脚本也支持 `--url` 与 `--token` 直连任意 OneBot HTTP 服务。

配合系统 cron（`sudo crontab -e`）：

```cron
0 7 * * * DATA_DIR=/var/apps/qqnas/var /var/apps/nodejs_v22/target/bin/node /var/apps/qqnas/target/scripts/sign.cjs --account 大号 --groups 123456789 --text 签到 >> /var/apps/qqnas/var/logs/cron.log 2>&1
30 8 * * * DATA_DIR=/var/apps/qqnas/var /var/apps/nodejs_v22/target/bin/node /var/apps/qqnas/target/scripts/like.cjs --account 大号 --source group --group 123456789 --count 10 >> /var/apps/qqnas/var/logs/cron.log 2>&1
```

面板自带调度器已经覆盖上述任务，cron 更适合临时补跑或对接已有运维体系。

### QQ 等级加速项支持情况

QQ 的「今日加速」里只有一部分能力能通过 OneBot 接口完成，其余依赖手机 QQ 或官方活动页，无法在不违反平台规则的前提下自动完成。

| 加速项 | 是否支持 | 说明 |
| --- | --- | --- |
| 电脑 QQ 在线 / 连续登录 | 支持 | 开启「在线保活」，保持 Linux QQ 在线 |
| 群签到 | 支持 | 调用 `set_group_sign` 官方接口 |
| 名片点赞 | 支持 | 调用 `send_like`，注意频率 |
| 发布一条空间说说 | 支持 | 调用 `send_qzone_msg`，需要较新的 NapCat；可设置发布后自动删除 |
| 定时互动、随机活跃 | 支持 | 群消息 / 私聊消息 |
| 手机 QQ 连续在线 | 不支持 | 这是桌面 Linux QQ，无法模拟手机端 |
| 加一位好友 | 不支持 | OneBot 没有主动加好友接口，批量添加也容易触发风控 |
| 看小说 / 视频 / 漫剧 / 小游戏 / 农场 | 不支持 | 属于手机 QQ 内的内容型任务，无对应接口 |
| 听歌、盲盒签、元宝提问、会员福利社 | 不支持 | 依赖官方活动页与登录态，无法稳定自动化 |
| 超级会员 / 大会员 / SVIP-STAR 特权 | 不支持 | 需要付费开通，不属于脚本可以完成的任务 |

这类「不支持」的项目建议在手机上顺手完成，不要用第三方工具强行模拟，避免账号风控。

## 数据与备份

需要备份的内容只有应用数据目录，默认 `/var/apps/qqnas/var`：

```bash
sudo tar -czf qqnas-backup-$(date +%F).tar.gz /var/apps/qqnas/var
```

- `config.json`：账号、任务、Token。
- `accounts/<id>/home/.config/QQ`：QQ 登录态，迁移后通常可免扫码。
- `accounts/<id>/home/Napcat/.../napcat/config`：NapCat 与 OneBot 配置。
- `runtime/home/Napcat`：QQ 与 NapCat 运行环境模板，新账号从这里复制。
- `logs/`：管理端日志与账号日志。

迁移到新机器时保持目录结构不变，重新安装 fpk 并把数据目录放回原位即可。

## 自行构建 fpk

```bash
cd fnos-fpk
python build-fpk.py
# 产物：dist/qqnas_<版本>_<平台>.fpk
```

构建脚本不依赖 fnpack，会显式写入 `cmd/*` 的可执行权限，避免在 Windows 上打包后飞牛拒绝安装。可选的官方校验：

```bash
fnpack build --directory fpk-src   # 仅校验结构，产物请以上面的 build-fpk.py 为准
```

## 常见问题

**打开后一直显示「连接中」，或弹出一堆日志窗口**

2.0.0 起已把 CSS、JS、二维码库全部内联进 HTML，并改用 `type: url` 直接打开 8787 端口，不再依赖子路径下的静态资源请求。2.0.1 处理了飞牛窗口禁用 `localStorage` 的情况；2.0.2 修正了内联时的字符串替换展开问题（此前页面仍会加载外链 `app.js`，控制台报 `SyntaxError`、按钮无响应）。如果升级后仍是旧页面，请确认安装的是 2.0.10，并在飞牛上执行：

```bash
sudo systemctl restart trim_app_center.service
```

然后重新从桌面图标打开。仍异常时直接访问 `http://NAS-IP:8787/`，并在浏览器控制台查看是否有报错。

如果样式正常、但顶部一直显示「连接中」且所有按钮都没反应，通常是前端脚本在启动阶段被中断。两种已知原因都已修复：2.0.1 解决了 `localStorage` 在跨源 iframe 中抛 `SecurityError` 的问题，2.0.2 解决了内联脚本被 `$` 替换模式破坏、控制台出现 `SyntaxError` 的问题。升级到 2.0.10 后即可恢复。

**提示「运行环境未安装」**

点页面顶部的「安装运行环境」。安装过程会下载 Linux QQ 与 NapCat，耗时取决于 NAS 的网络。日志：

```bash
tail -f /var/apps/qqnas/var/logs/runtime-install.log
```

下载失败通常是加速节点中断。2.0.3 起下载改为 HTTP/1.1，带断点续传、自动重试和多线路回退；已下载的 `NapCat.Shell.zip`、`QQ.deb` 以及 `.part` 残片都会保留，重试时继续下载而不是从头开始。安装进程的 PID 记录在 `runtime/install.pid`，管理端重启后会接管而不是重复安装。

如果所有线路都不通，可以手动离线安装：

1. 在能上网的电脑下载 `NapCat.Shell.zip`（NapNeko/NapCatQQ 的 latest release 资源）。
2. 上传到 `/var/apps/qqnas/var/runtime/home/`，文件名保持 `NapCat.Shell.zip`。
3. 回到面板点「安装运行环境」，脚本会校验并直接使用本地包，然后继续下载 QQ。

也可以把文件放到任意路径，并通过环境变量 `NAPCAT_SHELL_ZIP=/path/to/NapCat.Shell.zip` 指定；如需固定加速线路，可设置 `NAPCAT_GITHUB_PROXY=https://ghfast.top`（`0` 表示直连）。

**二维码一直显示「启动中」**

NapCat 首次启动需要初始化 QQ 客户端，通常 1–3 分钟。可点击登录弹窗里的「查看日志」，或执行：

```bash
tail -f /var/apps/qqnas/var/logs/account-<账号id>.log
```

**登录后提示需要修改 WebUI 密码**

NapCat 新版本会要求首次进入 WebUI 修改密码。面板扫码不依赖 WebUI 登录，不影响任务；如需使用完整 WebUI，按提示修改即可。

**面板打不开 / 接口 502**

```bash
tail -100 /var/apps/qqnas/var/logs/manager.log
curl -i http://127.0.0.1:8787/api/health
```

确认 8787 端口未被占用、应用数据目录可写、`nodejs_v22` 已安装。

**面板里设置了密码，但在飞牛窗口里一直要求重新登录**

浏览器会拦截跨站 iframe 的 Cookie。2.0.0 起登录成功后会把令牌写入当前标签页的 sessionStorage，并通过请求头校验，不依赖 Cookie；存储不可用时也不会中断页面。若仍反复要求登录，请确认升级到了 2.0.10，或直接用浏览器打开 `http://NAS-IP:8787/`。

**重启后要重新扫码吗**

不需要。QQ 登录票据保存在账号独立数据目录中，2.0.10 起每次停止/重启前都会自动快照，启动时若发现票据缺失（误清、损坏、迁移）会用最近快照恢复；同时停止进程会给足 10 秒让 QQ 正常写盘，尽量避免强杀。只有腾讯主动使会话失效（如风控、他地挤号）时才需要重新扫码。

**账号频繁掉线**

先看账号日志与面板日志。保活任务会以 NapCat 登录态为准探测并自动重启；确认离线后面板会立即显示离线。若连续重启 3 次仍未恢复在线，会暂停自动重启并在账号上标注原因——这通常意味着触发 QQ 风控或需要重新扫码，请打开登录弹窗处理。建议降低任务频率，避免短时间大量加群、发消息或点赞；多账号同时挂机时尽量错开各账号的任务时间。

**ARM 设备能用吗**

可以。Linux QQ 与 NapCat 均提供 arm64 版本，安装脚本会自动识别架构。ARM 机型内存建议不低于 2 GB / 账号。

**如何彻底卸载**

在应用中心卸载时勾选「同时删除账号数据与 QQ 运行环境」。未勾选则保留数据，重新安装后可继续使用已登录的 QQ 和任务配置。

## 已验证范围

- 管理端：Node.js 20+（飞牛使用 `nodejs_v22`），Chrome / Edge / Safari 现代浏览器。
- NapCat：官方 Linux 安装脚本的 Shell（Rootless）模式，OneBot 11 HTTP + 事件回调。
- 飞牛 fnOS：fpk 安装、`cmd/main start|stop|status` 生命周期、应用中心 Node.js 22 依赖，x86_64 与 arm64。

## 作者

千里 · [github.com/qianliaa](https://github.com/qianliaa)

## 免责声明

本项目仅用于个人账号的在线保持与日常互动自动化，不提供任何修改 QQ 数据、绕过风控或批量养号的能力。使用前请阅读 QQ 相关服务条款；因使用本项目导致的账号限制、封禁或数据损失，由使用者自行承担。

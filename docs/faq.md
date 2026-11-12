# 常见问题

## 安装时仍提示 Docker 相关错误

你装的多半是早期的「Docker 版 FPK」（`qqfarm-1.0.x.fpk`），该版本已归档不再维护。
现在请装 `qqfarm-native-<版本>.fpk`：原生版包名带 `native`，应用名是「QQ 多开挂机（原生版）」，零依赖、不检查 Docker。
如果确实要用容器部署，请改用根目录的 `docker-compose.yml`。

## 右上角显示「图形栈未就绪」

点「立即准备」看进度日志。常见原因：QQ deb 直链失效（改用方式 B 上传）、GitHub 打不开
（在「noVNC 备用地址」填镜像）、NAS 的 apt 源未初始化（日志会给出手动放置路径）。

## QQ 进程起来了但网页桌面连不上

看账号日志，多半是 VNC 服务没起来（端口冲突 / 缺库）。可在账号「编辑」里换一个内部 VNC 端口。

## QQ 白屏 / 中文方块

调小虚拟桌面分辨率、确认 `app/runtime/fonts/` 有中文字体；单账号内存建议 ≥1GB。

## 8788 被占用

同步改 `native/manifest` 的 `service_port` 与 `native/app/ui/config` 的 `port` 后重新打包；
Docker 部署时改 compose 的端口映射即可。

## Docker 部署时提示找不到 QQ

镜像**不包含** QQ 客户端（版权归腾讯）。把与宿主机架构一致的官方 deb 放进 `qq/` 目录
（`linux/amd64` 对应 amd64、ARM 设备对应 arm64），再 `docker compose restart`。

## 账号数据在哪个目录，重建容器会丢吗

- 原生 FPK：应用共享目录 `qqfarm/`（飞牛「文件管理 → 应用文件 → qqfarm」），`accounts/<ID>/` 下有 `home`、`config`、`cache`、`qqdata`。
- Docker：`./data` 持久化账号与登录态，`./qq` 只读挂载 deb，重建容器不丢数据。

## 升级会丢数据吗

不会。升级走 `upgrade_*` 脚本，只替换程序目录，账号与登录态保留；卸载默认也保留数据，
只有卸载向导里勾选「全部删除」才清理。

## 为什么面板只能在局域网用

面板需要访问本机的进程与图形栈，且网页桌面通过 WebSocket 转发 VNC，没有做公网加固。
请只在可信局域网使用，不要把 8788 暴露到公网；需要远程访问请自行叠加反代与访问控制。

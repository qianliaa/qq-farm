# 捆绑运行时目录（构建时填充）
这个目录在源码包里是空的。请在飞牛 NAS 或任意 Linux 上执行 `tools/build-native.sh`，
脚本会把以下内容下载并解包到这里，然后再打包成可安装的 fpk：
```
app/runtime/
├── QQ/           官方 Linux QQ deb 解包结果（opt/QQ/qq、opt/QQ/resources ...）
├── sys/          apt download 的 xvfb / x11vnc / 系统库 deb 解包结果
├── lib/          从 sys/ 收集出来的 .so*，运行时用 LD_LIBRARY_PATH 加载
├── fonts/        中文字体（可选）
└── novnc/        noVNC 的 core/ 与 vendor/ 静态文件
```
这样安装后完全不需要 root、apt 或 Docker：所有二进制都在应用自己的目录里，
以 `run-as: package` 的普通应用用户身份运行。
`--slim` 模式不会填充本目录，此时面板会去系统里找 `Xvfb` / `x11vnc` / `qq`，
需要在 SSH 中执行一次 `sudo apt install xvfb x11vnc ...` 并装好官方 QQ deb。

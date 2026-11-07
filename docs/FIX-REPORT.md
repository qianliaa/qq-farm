# Fix Report - 飞牛应用打开后停在「连接中」/ 改为原生运行时

## Bug 描述

在飞牛 NAS 应用中心安装 `qqnas_1.0.0_all.fpk` / `qqnas_1.0.1_all.fpk` 后，从桌面图标打开应用，窗口里只显示：

- 顶部固定为「连接中」；
- 页面内容被一层模糊遮罩覆盖；
- 正中弹出「容器日志」和「加载中…」，无法关闭；
- 「添加 QQ」等按钮点击无反应。

直接访问 `http://NAS-IP:8787/` 时页面正常。截图确认 HTML 已经加载，但样式与脚本没有生效。

## 问题根因

不是管理端接口没启动，而是**页面子资源没有加载成功**：

1. 1.0.x 的 `index.html` 通过相对路径引用 `styles.css`、`vendor/qrcode.js`、`app.js`。
2. 飞牛桌面用应用窗口（iframe / 网关）打开应用时，实际请求路径带有应用前缀（例如 `/app/qqnas/styles.css`），而旧版静态资源处理器只匹配根路径 `/styles.css`，请求返回 404 或回退成 HTML。
3. CSS 未加载：`.hidden` 规则不存在，所有 `.modal-mask` 默认可见，于是「容器日志」弹窗和遮罩同时出现。
4. JS 未加载：没有代码去请求 `/api/bootstrap`、更新顶部状态，初始文案「连接中」就永远停在那里。
5. 1.0.1 只修正了接口前缀与部分路径回退，仍然依赖外部 `styles.css` / `app.js` 请求，所以问题没有消失。

另外，1.0.x 依赖 Docker 与镜像拉取，安装链路长、失败点更多，与用户「不使用 Docker，依赖飞牛应用商店运行时」的要求不符。

## 尝试记录

### 尝试 1：Docker 编排 + 相对路径静态资源

- 结果：失败。
- 原因：Docker 可用，但飞牛窗口下的子资源路径不匹配；同时镜像拉取增加不确定性。

### 尝试 2：1.0.1 子路径兼容（接口前缀 + 静态路径回退）

- 结果：失败（用户复测仍是「连接中」）。
- 原因：只解决了 API 与部分静态路径，HTML 仍然外链 CSS/JS；只要网关对子资源处理不一致，页面就退化。

### 尝试 3：内联资源 + 直接端口打开 + 原生运行时（最终方案）

- 结果：通过。
- 原因：
  - 服务端返回 HTML 时，把 `styles.css`、`vendor/qrcode.js`、`app.js` 全部内联，页面不再发起任何子资源请求。
  - `app/ui/config` 使用 `type: url`，端口 8787，飞牛直接打开应用端口；同时服务端保留子路径兼容（`/app/qqnas/`、`/app/qqnas/api/...`）。
  - 去掉 Docker，改用应用中心 `nodejs_v22` 运行时；NapCat 采用官方安装脚本的本地（Rootless）模式。

## 最终方案

### 1. 页面加载

- `manager/server.cjs` 增加 `buildInlineHtml()`：读取 `index.html` 时注入内联 `<style>` 与 `<script>`，并设置 `Cache-Control: no-store`，避免旧页面缓存。
- `resolveStaticPath()` 支持任意前缀回退；`stripProxyPrefix()` 处理 `/app/qqnas/api/...`。
- 前端 `API_BASE` 根据当前 `location.pathname` 推导，兼容根路径与子路径。

### 2. 访问密码与 iframe

- 浏览器会拦截跨站 iframe 的 Cookie。登录接口额外返回令牌，前端写入 `sessionStorage` 并通过 `X-QQNAS-Token` / `Authorization: Bearer` 发送；服务端同时接受 Cookie 与请求头。

### 3. 原生运行

- `manifest` 声明 `install_dep_apps = nodejs_v22`，不再使用 Docker。
- `cmd/main` 通过 `nohup` 启动 `manager/server.cjs`，PID 文件、端口等待、启动日志齐备；`status` 以退出码 0/3 表示运行/停止。
- 管理端 `manager/lib/napcat.cjs` 为每个账号创建独立 `HOME`、XDG 目录、`xvfb-run` 显示、WebUI 端口与 OneBot 端口，使用官方安装脚本安装到 `${DATA_DIR}/runtime/home/Napcat`，新账号用 `cp -a --reflink=auto` 复制模板。
- 安装进程 PID 写入 `runtime/install.pid`：面板重启后接管仍在运行的安装，避免并发重复安装；安装完成或失败后清理 PID 文件。

### 4. 进程安全

- 停止账号前校验 `/proc/<pid>/environ` 中的 `HOME` 是否指向该账号目录，避免 PID 复用误杀。
- 显式排除 `tac-server`、`tac-cli`、`qodercli`、`node`、`XLSmart*` 等受保护进程。
- 管理端 PID 通过 `/proc/<pid>/cmdline` 校验确实是本应用。

## 检查清单

- [x] 对比官方/参考 fpk：`install_dep_apps = nodejs_v22`、`type: url`、`app/ui/config`、`config/privilege`、`config/resource`、`cmd/main start|stop|status` 结构与参考包一致。
- [x] 对比 NapCat-Installer 源码：`--docker n`、`--cli n`、`--proxy auto` 参数有效；安装路径 `${HOME}/Napcat/opt/QQ`、配置目录 `.../app_launcher/napcat/config` 与运行器一致。
- [x] 对比 NapCat WebUI API：`/api/auth/login`（`sha256(token + ".napcat")`）、`CheckLoginStatus`、`GetQQLoginQrcode`、`GetQQLoginInfo`。
- [x] 检查模块：`manager/server.cjs`、`manager/lib/napcat.cjs`、`manager/lib/tasks.cjs`、`manager/public/app.js`、`cmd/common.sh`、`cmd/main`、`build-fpk.py`。
- [x] 性能检查：内联 HTML 按 mtime 缓存；运行环境状态 5 秒轮询；账号模板复制优先 reflink；安装日志只读末尾 40 行；无重复安装进程。

## 验证结果

- `node --check`：管理端、前端、脚本全部通过。
- `bash -n`：`cmd/main`、全部生命周期脚本、`runtime/napcat-install.sh` 通过。
- 源码冒烟：健康检查、登录、页面内联、子路径、账号创建/状态/日志均通过。
- 打包冒烟：从 `.fpk` 解包后启动，页面 154 KB、内联样式生效、无外链 CSS、运行环境状态正确。
- 鉴权冒烟：匿名 401；Cookie 缺失时仅带 `X-QQNAS-Token` 或 `Authorization: Bearer` 均返回 200。
- 安装接管冒烟：已有安装进程时再次触发安装，安装脚本只运行 1 次；完成后状态变为 ready 且清理 PID 文件。
- 包结构：全部 `cmd/*` 为 0755；`runtime/napcat-install.sh` 为 0755；`common.sh` 为 0644；包内不再包含 `manager/lib/docker.cjs`。

## 追加修复（2.0.1）：禁用存储导致脚本中断

2.0.0 安装后页面样式正常，但顶部仍显示「连接中」，点击「添加 QQ」没有任何反应。

根因：`app.js` 在顶层初始化 `state` 时直接调用了 `localStorage.getItem('qqnas.current')`。飞牛应用窗口是跨源 iframe，浏览器禁用第三方存储时，这次访问会抛出 `SecurityError`，整个脚本在注册任何事件之前终止。于是 CSS 正常、交互全失效，顶部停留在 HTML 里的初始文案「连接中」。

修复：新增 `storageGet()` / `storageSet()` 安全包装，所有 `localStorage` 访问都捕获异常；`sessionStorage` 原本已有保护。存储不可用时只失去「记住上次选中的账号」，不影响页面功能。

验证方式：在测试副本的 `index.html` 中注入一个让 `localStorage` 读取抛 `SecurityError` 的脚本，再用 Chromium 无头模式加载。

- 修复前：`engineChip` 保持「连接中」，与用户截图一致。
- 修复后：`engineChip` 更新为运行环境状态，证明脚本完整执行、事件绑定成功。

## 追加修复（2.0.2）：内联脚本被替换模式破坏

2.0.1 安装后页面样式正常，但控制台出现两条错误，按钮仍然无响应：

```
Uncaught SyntaxError: Invalid or unexpected token (at (索引):4116:14)
Uncaught (in promise) TypeError: Cannot read properties of null (reading 'addEventListener')
    at bindEvents (app.js:802:20)
    at HTMLDocument.init (app.js:1035:5)
```

### 根因

`buildInlineHtml()` 使用 `String.prototype.replace(pattern, string)` 把 CSS、二维码库和 `app.js` 内联进 HTML。字符串形式的替换内容会被当作替换模式解析，其中 `$'`、`$&`、`` $` ``、`$$`、`$1` 等序列会被展开：

1. `vendor/qrcode.js` 第 43419 行含有 `$'`。它展开为「匹配内容之后的全部文本」，也就是 `\n  <script src="app.js"></script>\n</body>\n</html>\n`，于是外链 `app.js` 标签被复制进二维码脚本内部。
2. 随后针对 `app.js` 的替换匹配到了这个副本，把应用代码注入到二维码脚本区域；页面末尾真正的 `src="app.js"` 反而保留下来。
3. `app.js` 中的 `$$` 选择器辅助函数（4 处）被展开成 `$`，代码语义被改变。
4. 浏览器先解析被拼接坏的二维码内联脚本，在合并后的第 4116 行抛出 `SyntaxError`，内联应用代码整段失效；随后又加载外链 `app.js`。该请求允许缓存 1 小时，浏览器复用了旧版本，`bindEvents` 访问到不存在的元素，抛出 `TypeError`。

这解释了为什么样式和二维码库看起来正常、却仍然停在「连接中」：出问题的不是接口，而是内联结果本身。

### 修复

- `manager/server.cjs` 的三处 `replace` 全部改为**函数替换器**（`() => 内容`），替换内容按字面量插入，不再解析 `$` 序列。
- 页面不再包含任何外链 CSS/JS，旧 `app.js` 缓存无法再影响页面，从根上消除了版本错配。

### 验证结果

- 源码页面：外链脚本 0 个、外链 CSS 0 个、`<script>` 2 个、`$$` 保留 4 处；用 `new Function()` 解析两段内联脚本均通过。
- 子路径 `/app/qqnas/` 返回同样结果。
- 打包产物（`qqnas_2.0.2_all.fpk`）解包后运行：健康检查版本 2.0.2，页面 155066 字节，内联结构同上；账号创建、状态、日志、请求头鉴权均正常。
- Chromium 无头渲染打包页面：`engineChip` 从「连接中」更新为「演示模式」，`versionText` 为 `v2.0.2`，说明 `bindEvents` 与后续初始化完整执行；控制台无脚本错误。
- 包结构：33 个应用条目，`cmd/*` 与安装脚本 0755，`common.sh` 0644，不含 `docker.cjs`。

## 追加修复（2.0.3）：运行环境下载中断后直接失败

2.0.2 安装后，首次安装运行环境在下载 NapCat 时失败。日志显示自动选中 `https://ghproxy.net`，34.3 MB 的文件下载到约 3.9 MB（11%）后速度归零，最终报错：

```
curl: (92) HTTP/2 stream 3 was not closed cleanly: INTERNAL_ERROR (err 2)
NapCat 下载失败，已有安装和本地文件保持不变。安装运行环境失败
```

### 根因

1. 官方安装脚本的 `curl_download()` 只调用一次 `curl`，没有重试、没有断点续传，也不限制低速连接；代理节点在传输中途断开时整次安装直接失败。
2. 下载使用 HTTP/2，部分 Github 加速节点会返回 `INTERNAL_ERROR` 并中断大文件。
3. 失败后不保留已下载的数据，用户重试只能从 0 开始，34 MB 的包反复下载。
4. 管理端在每次重试前会删除 `NapCat.Shell.zip`、`QQ.deb`、`QQ.rpm`，即使上次已经下载完成也会被丢掉。

### 修复

- `runtime/napcat-install.sh` 的 `curl_download()`：
  - 强制 `--http1.1`，规避代理节点的 HTTP/2 中断；
  - 写入 `<目标文件>.part`，重试时用 `-C -` 断点续传；
  - `--speed-limit 1024 --speed-time 60`，连接挂死 60 秒即中止重试；
  - 外层最多重试 4 次（`NAPCAT_DOWNLOAD_RETRIES` 可调），失败保留 `.part`；
  - 续传不被支持（curl 33/36）时清掉残片，从头下载。
- `download_napcat()` 增加多线路回退：探测线路失败后依次尝试其他加速节点，最后尝试 GitHub 直连；每个线路下载后都用 `unzip -t` 校验，损坏则换线。
- 本地安装包校验：已有 `NapCat.Shell.zip` 校验失败时自动删除并重新下载，不再直接报错。
- 支持离线包：`NAPCAT_SHELL_ZIP` 指定本地 zip，`NAPCAT_GITHUB_PROXY` 固定线路（`0` 为直连）。
- `manager/lib/napcat.cjs` 不再在重试前删除 `NapCat.Shell.zip`、`QQ.deb`、`QQ.rpm`，只清理上次残留的 `NapCat` 解压目录，保留下载成果与 `.part` 残片。

### 验证结果

- `bash -n runtime/napcat-install.sh`、`node --check manager/lib/napcat.cjs` 通过。
- 本地模拟“下载到 200 KB 时断开连接”的服务：第 1 次 curl 退出码 18，第 2 次携带 `Range: bytes=204800-` 续传成功，最终文件大小 1 MB、SHA-256 与源文件一致。
- 模拟服务器不支持 Range：脚本收到退出码 33、清理残片后从头下载成功。
- 本地离线包：设置 `NAPCAT_SHELL_ZIP` 后跳过网络，复制、校验、解压均成功。
- 打包产物：`qqnas_2.0.3_all.fpk`，页面版本 `v2.0.3`，内联结构与 2.0.2 一致。

## 经验教训

1. **飞牛窗口里的页面必须假设子资源会失败**。管理端页面要么内联，要么由自己的服务在任意前缀下正确返回；不要把「浏览器直接打开正常」当成通过标准。
2. **CSS 缺失会暴露所有 `.hidden` 弹窗**，这类现象很容易被误判为「接口卡住」，实际是样式没加载。
3. **判断依据要看请求链路**：HTML 能显示说明服务活着，顶部状态不变说明 JS 没执行，先查静态资源而不是查 API。
4. **依赖声明优先用应用中心运行时**，能显著缩短安装链路；运行时路径要做多级回退并等待依赖就绪。
5. **后台安装必须有锁**，否则面板重启会重复下载、重复解压，最终把磁盘和日志拖垮。
6. **脚本顶层不要直接碰 localStorage / sessionStorage**。跨源 iframe 中它们可能直接抛异常，异常发生在事件绑定之前时，表现为「样式正常、所有按钮无反应」，很容易被误判成后端问题。
7. **`String.replace` 的字符串替换不是字面量插入**。只要被插入的代码里含有 `$` 序列（尤其是压缩库里的 `$'`），结果就会被悄悄改写。内联任意第三方 JS/CSS 时必须使用函数替换器，并断言「外链标签已消失」而不是只看请求有没有返回 200。
8. **静态资源缓存会掩盖版本问题**。外链 `app.js` 缓存的旧代码与新版 HTML 混用，报错行号会对不上当前源码。能内联的资源尽量内联，或至少给资源加版本指纹。
9. **大文件下载必须假设会断**。NAS 的出海网络经常走第三方加速节点，HTTP/2 中断、长时间 0 速度都是常态。至少要同时具备：HTTP/1.1 回退、低速超时、断点续传、多线路切换、下载后完整性校验。
10. **失败重试不要清掉已完成的产物**。清理“临时文件”前先区分「残片」和「已完整下载但后续步骤失败」的文件，否则每次重试都重复消耗带宽和时间。

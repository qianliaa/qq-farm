"""原生进程管理器：每个 QQ 账号 = Xvfb + x11vnc + 官方 QQ 客户端 三个进程。
不使用 Docker、不调用 Docker Socket、不需要 root。所有二进制来自应用自带的
app/runtime/（捆绑运行时），找不到时回退到系统已安装的同名命令（精简包模式）。
"""
from __future__ import annotations
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
DISPLAY_START = 101
VNC_PORT_START = 15901
def log(msg: str) -> None:
    print(f"[qqfarm-native] {msg}", flush=True)
def port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()
def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False
def display_free(display: int) -> bool:
    return not Path(f"/tmp/.X11-unix/X{display}").exists()
def mem_available_mb() -> int:
    """读取 /proc/meminfo 的 MemAvailable（MB）。

    挂多个 QQ 时最常见的一种「进程异常」是内存不足被内核 OOM 杀掉
    （QQ 进程退出码 -9）。面板显示可用内存，用户一眼能看出是不是这个原因。
    """
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except Exception:
        pass
    return -1
def alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False
class ProcessManager:
    def __init__(self, data_dir: Path, runtime_dir: Path, settings_provider,
                 logger=log, settings_writer=None):
        self.data_dir = Path(data_dir)
        self.runtime = Path(runtime_dir)
        self.settings = settings_provider  # callable -> dict
        # 看门狗在检测到「16 位色深导致 QQ 起不来」时需要把设置改回 24，
        # 传入可选的写入回调（server.save_settings_to_disk）。
        self.settings_writer = settings_writer
        self.log = logger
        self.lock = threading.RLock()
        self.groups: dict[str, dict] = {}  # acc_id -> {"procs": {role: Popen}, "started": ts}
        self._lib_dirs_cache: list[str] | None = None
        (self.data_dir / "accounts").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "logs").mkdir(parents=True, exist_ok=True)
        self._load_pids()
    # ---------- 路径 ----------
    def _bundled(self, *parts: str) -> Path:
        return self.runtime.joinpath(*parts)
    def resolve_bin(self, role: str) -> str:
        """优先用随包二进制；精简包模式回退系统命令。"""
        candidates = {
            "xvfb": [
                self._bundled("sys/usr/bin/Xvfb"),
                self._bundled("sys/bin/Xvfb"),
                Path("/usr/bin/Xvfb"),
            ],
            "x11vnc": [
                self._bundled("sys/usr/bin/x11vnc"),
                self._bundled("sys/bin/x11vnc"),
                Path("/usr/bin/x11vnc"),
            ],
            "qq": [
                self._bundled("QQ/opt/QQ/qq"),
                self._bundled("QQ/usr/bin/qq"),
                Path("/opt/QQ/qq"),
                Path("/usr/bin/qq"),
            ],
        }
        for path in candidates.get(role, []):
            if path.is_file() and os.access(str(path), os.X_OK):
                return str(path)
        found = shutil.which({"xvfb": "Xvfb", "x11vnc": "x11vnc", "qq": "qq"}[role])
        return found or ""
    def lib_dirs(self) -> list[str]:
        """收集所有可能含动态库的目录。

        deb 解包后库散落在 sys/usr/lib/<arch>-linux-gnu/ 等目录，只靠
        runtime/lib 汇总会漏掉 libvncclient.so.1，导致 VNC 服务无法启动。
        这里做一次动态扫描并缓存，覆盖 amd64 / arm64 等不同 deb 布局。
        """
        if self._lib_dirs_cache is not None:
            return self._lib_dirs_cache
        dirs: list[str] = []

        def add(p: Path):
            try:
                s = str(p)
                if p.is_dir() and s not in dirs:
                    dirs.append(s)
            except OSError:
                pass

        add(self._bundled("lib"))
        add(self._bundled("sys/usr/lib"))
        add(self._bundled("sys/lib"))
        # 只扫描 deb 解包目录 sys/。不要扫描 QQ/：QQ 自带 libEGL、libGLESv2
        # 等图形库，若塞进 LD_LIBRARY_PATH 会覆盖系统 Mesa，反而让 Electron
        # 的 GPU/EGL 初始化更容易失败（QQ 自身通过 rpath 找自带库）。
        sys_root = self._bundled("sys")
        if sys_root.is_dir():
            try:
                for so in sys_root.rglob("*.so*"):
                    if so.is_file():
                        add(so.parent)
            except (OSError, ValueError):
                pass
        self._lib_dirs_cache = dirs
        return dirs
    def lib_dir(self) -> str:
        return os.pathsep.join(self.lib_dirs())
    def invalidate_lib_cache(self) -> None:
        """运行库自愈补齐后调用，让下次启动重新扫描库目录。"""
        self._lib_dirs_cache = None
    def novnc_dir(self) -> Path:
        return self._bundled("novnc")
    def preflight(self) -> dict:
        """返回图形栈自检结果，供面板首页显示就绪/缺失状态。"""
        bins = {role: self.resolve_bin(role) for role in ("xvfb", "x11vnc", "qq")}
        missing = [role for role, path in bins.items() if not path]
        bundled = all(
            self._bundled(p).exists()
            for p in ("sys", "QQ", "novnc/core/rfb.js")
        )
        return {
            "bins": bins,
            "missing": missing,
            "ready": not missing and (self.novnc_dir() / "core/rfb.js").is_file(),
            "bundled": bundled,
            "mode": "bundled" if bundled else "system",
        }
    # ---------- 分配 ----------
    def allocate(self, accounts: list[dict]) -> tuple[int, int]:
        used_d = {int(a["display"]) for a in accounts}
        used_p = {int(a["vnc_port"]) for a in accounts}
        d, p = DISPLAY_START, VNC_PORT_START
        while d in used_d or not display_free(d):
            d += 1
        while p in used_p or not port_free(p):
            p += 1
        return d, p
    def account_home(self, acc_id: str) -> Path:
        home = self.data_dir / "accounts" / acc_id
        for sub in ("home", "config", "cache", "qqdata"):
            (home / sub).mkdir(parents=True, exist_ok=True)
        return home
    def log_file(self, acc_id: str) -> Path:
        return self.data_dir / "logs" / f"{acc_id}.log"
    def rotate_log(self, acc_id: str, limit: int = 2 * 1024 * 1024) -> None:
        """账号日志轮转：QQ 会持续输出大量内容，长期挂机不能让它无限增长。
        超过 limit 时只保留尾部 512KB，避免磁盘与 IO 被日志拖垮。"""
        path = self.log_file(acc_id)
        try:
            if path.is_file() and path.stat().st_size > limit:
                data = path.read_bytes()
                keep = data[-512 * 1024:]
                marker = f"\n===== 日志已轮转（超过 {limit} 字节，保留最近 512KB）{time.strftime('%F %T')} =====\n".encode()
                path.write_bytes(marker + keep)
        except OSError:
            pass
    # ---------- 进程环境 ----------
    def _env(self, acc: dict, full_libs: bool = True) -> dict:
        home = self.account_home(acc["id"])
        env = os.environ.copy()
        env["DISPLAY"] = f":{acc['display']}"
        env["HOME"] = str(home / "home")
        env["XDG_CONFIG_HOME"] = str(home / "config")
        env["XDG_CACHE_HOME"] = str(home / "cache")
        env["XDG_RUNTIME_DIR"] = str(home)
        env["QT_QPA_PLATFORM"] = "xcb"
        env["LANG"] = env.get("LANG") or "zh_CN.UTF-8"
        env["QQFARM_ACCOUNT"] = acc["id"]
        # QQ 是 Electron 应用，自带图形/libnss 库。若把 sys/ 下所有 deb 库
        # 目录都塞进 LD_LIBRARY_PATH，会覆盖系统版本、反而引发 EGL/GPU 崩溃。
        # 因此只给 Xvfb / VNC 用「全量库路径」，QQ 仅用汇总目录 runtime/lib。
        if full_libs:
            libs = self.lib_dir()
        else:
            plain = self._bundled("lib")
            libs = str(plain) if plain.is_dir() else ""
        if libs:
            env["LD_LIBRARY_PATH"] = libs + os.pathsep + env.get("LD_LIBRARY_PATH", "")
        fonts_conf = self._bundled("fonts/fonts.conf")
        if fonts_conf.is_file():
            env["FONTCONFIG_FILE"] = str(fonts_conf)
        # --- 无 GPU 的 NAS 环境：强制软件渲染，避免 Chromium 因打不开
        #     /dev/dri/* 而判定「GPU process isn't usable」直接 FATAL 退出。
        env["LIBGL_ALWAYS_SOFTWARE"] = "1"
        env["GALLIUM_DRIVER"] = "llvmpipe"
        env["MESA_GL_VERSION_OVERRIDE"] = "3.3"
        env["QT_X11_NO_MITSHM"] = "1"
        env["QT_OPENGL"] = "software"
        # fnOS 注入的 DBUS_SESSION_BUS_ADDRESS 常是非法值，会让 Qt/Electron 反复刷
        # "Could not parse server address: Unknown address type"。直接清掉即可，
        # Chromium/Qt 在没有 session bus 时会走无 D-Bus 的降级路径（非致命）。
        env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        # Chromium 要求 XDG_RUNTIME_DIR 权限 0700
        try:
            os.chmod(str(home), 0o700)
        except OSError:
            pass
        return env
    def _spawn(self, name: str, cmd: list[str], acc: dict, log_handle):
        # name 在 start() 里是 "Xvfb" / "x11vnc" / "QQ"
        kwargs = {"env": self._env(acc, full_libs=(name != "QQ")),
                  "cwd": str(self.account_home(acc["id"])),
                  "stdout": log_handle, "stderr": subprocess.STDOUT,
                  "stdin": subprocess.DEVNULL}
        if os.name == "posix":
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **kwargs)
        self.log(f"启动 {name}: acc={acc['id']} pid={proc.pid} cmd={' '.join(cmd[:4])}")
        return proc
    # ---------- 启停 ----------
    def start(self, acc: dict) -> dict:
        with self.lock:
            acc_id = acc["id"]
            pre = self.preflight()
            if pre["missing"]:
                raise RuntimeError(
                    "图形栈未就绪，缺少：" + ", ".join(pre["missing"])
                    + "。请用 tools/build-native.sh 打全量包，或在 SSH 中安装系统依赖。"
                )
            existing = self.groups.get(acc_id)
            if existing and any(alive(p.pid) for p in existing["procs"].values()):
                return self.status(acc)
            home = self.account_home(acc_id)
            # 清理上次崩溃残留的 Crashpad 锁文件，避免反复刷
            # "Crashpad/pending/*.lock: File exists (17)" 并影响崩溃上报。
            pending = home / "qqdata" / "Crashpad" / "pending"
            if pending.is_dir():
                for lock in pending.glob("*.lock"):
                    try:
                        lock.unlink()
                    except OSError:
                        pass
            resolution = str(self.settings().get("resolution") or "1024x768")
            # 色深沿用设置（16=省资源档 / 24=兼容档）；旧账号若没有该字段，
            # server.init_storage 已做一次性迁移，这里再兜底一次。
            depth = str(self.settings().get("depth") or 16)
            if depth not in ("16", "24"):
                depth = "16"
            display = f":{acc['display']}"
            procs = {}
            starts = {}
            # 内存水位提示：QQ 是 Electron 应用，单实例常驻 300~600MB。
            # 可用内存过低时即使起来也会被内核 OOM 杀掉，先记一条日志便于判断。
            free_mb = mem_available_mb()
            if 0 <= free_mb < 400:
                self.log(f"警告：可用内存仅 {free_mb}MB，QQ 可能因内存不足被系统杀掉"
                         f"（建议减少同时挂机的账号数）")
            self.rotate_log(acc_id)
            with self.log_file(acc_id).open("a", encoding="utf-8") as fh:
                fh.write(f"\n===== 启动 {time.strftime('%F %T')} {acc_id} "
                         f"{resolution}x{depth} =====\n")
                procs["xvfb"] = self._spawn("Xvfb", [
                    self.resolve_bin("xvfb"), display,
                    "-screen", "0", f"{resolution}x{depth}",
                    "-nolisten", "tcp", "-ac",
                ], acc, fh)
                starts["xvfb"] = time.time()
                time.sleep(0.6)
                procs["x11vnc"] = self._spawn("x11vnc", [
                    self.resolve_bin("x11vnc"),
                    "-display", display,
                    "-rfbport", str(acc["vnc_port"]),
                    "-listen", "127.0.0.1",
                    # -defer 40：合并 40ms 内的画面变化再推送，明显降低挂机
                    # （画面长时间静止）时的空轮询与 CPU 占用，不影响扫码交互。
                    "-forever", "-shared", "-nopw", "-noxdamage", "-quiet",
                    "-defer", "40",
                ], acc, fh)
                starts["x11vnc"] = time.time()
                # QQ 是 Electron/Chromium。NAS 上无 /dev/dri 权限时，
                # 只用 --disable-gpu 会连软件光栅化回退一起禁掉，Chromium
                # 的 GPU 进程连崩三次后直接 FATAL「GPU process isn't usable.
                # Goodbye.」（真机日志已复现）。正确做法是保留软件渲染路径：
                #   --use-gl=angle --use-angle=swiftshader --in-process-gpu
                # 且【不要】传 --disable-gpu / --disable-software-rasterizer。
                procs["qq"] = self._spawn("QQ", [
                    self.resolve_bin("qq"),
                    "--no-sandbox", "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--use-gl=angle", "--use-angle=swiftshader",
                    "--in-process-gpu", "--enable-unsafe-swiftshader",
                    "--disable-features=Vulkan",
                    # NAS 无外网/无桌面会话时 Crashpad 会反复尝试上报并超时
                    #（日志里大量 curl_easy_perform: Timeout），纯浪费 CPU/网络/磁盘。
                    "--disable-crash-reporter", "--disable-breakpad",
                    "--ozone-platform=x11",
                    "--ignore-certificate-errors",
                    "--no-first-run", "--no-default-browser-check",
                    f"--user-data-dir={home / 'qqdata'}",
                ], acc, fh)
                starts["qq"] = time.time()
            self.groups[acc_id] = {"procs": procs, "started": time.time(), "starts": starts}
            self._save_pids()
            return self.status(acc)
    def _kill_proc(self, proc) -> None:
        if proc is None:
            return
        try:
            if proc.poll() is None:
                if os.name == "posix":
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    except (OSError, AttributeError):
                        proc.terminate()
                else:
                    proc.terminate()
        except Exception:
            pass
        deadline = time.time() + 4
        while time.time() < deadline:
            try:
                if proc.poll() is not None:
                    break
            except Exception:
                break
            time.sleep(0.15)
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass
    def stop(self, acc: dict) -> None:
        with self.lock:
            group = self.groups.pop(acc["id"], None)
            pids = []
            if group:
                for role in ("qq", "x11vnc", "xvfb"):
                    p = group["procs"].get(role)
                    if p is not None:
                        pids.append(p.pid)
                        self._kill_proc(p)
            # 兜底：按 pids.json 里记录的本账号 PID 清理残留
            for pid in self._saved_pids_for(acc["id"]):
                if pid not in pids and alive(pid):
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except Exception:
                        pass
            self._save_pids()
    def restart(self, acc: dict) -> dict:
        self.stop(acc)
        time.sleep(0.5)
        return self.start(acc)
    def stop_all(self) -> None:
        with self.lock:
            for acc_id in list(self.groups.keys()):
                group = self.groups.pop(acc_id, None)
                if group:
                    for role in ("qq", "x11vnc", "xvfb"):
                        self._kill_proc(group["procs"].get(role))
            self._save_pids()
            self.log("已停止全部 QQ 进程组")
    # ---------- 状态 ----------
    ROLE_NAMES = {"xvfb": "虚拟屏", "x11vnc": "VNC", "qq": "QQ"}

    def _exit_hint(self, role: str, code, uptime: int) -> str:
        """把退出码翻译成用户能看懂的原因（面板卡片直接展示）。"""
        name = self.ROLE_NAMES.get(role, role)
        if code is None:
            return f"{name} 已退出"
        if code < 0:
            sig = -code
            if sig == 9:
                return (f"{name} 被系统强制结束（SIGKILL），最常见原因是内存不足被内核 OOM 杀掉")
            if sig == 6:
                return f"{name} 崩溃退出（SIGABRT，多半是图形/依赖问题，点「日志」看崩溃堆栈）"
            if sig == 15:
                return f"{name} 被终止（SIGTERM）"
            return f"{name} 被信号 {sig} 结束"
        if code == 127:
            return f"{name} 无法执行（找不到程序或缺依赖库，点「日志」看 shared libraries 报错）"
        if code == 126:
            return f"{name} 无执行权限"
        if uptime < 20:
            return f"{name} 启动后 {uptime}s 就退出（退出码 {code}），点「日志」看具体原因"
        return f"{name} 运行 {uptime}s 后退出（退出码 {code}）"

    def _tail_lines(self, acc_id: str, count: int = 3, width: int = 160) -> list[str]:
        """取账号日志最后几行，作为崩溃现场附带在状态里。

        只读文件尾部 8KB，避免 /api/state 轮询时读大文件。
        """
        path = self.log_file(acc_id)
        try:
            size = path.stat().st_size
            with path.open("rb") as fh:
                if size > 8192:
                    fh.seek(size - 8192)
                chunk = fh.read().decode("utf-8", errors="replace")
            lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
            out = []
            for ln in lines[-count:]:
                out.append(ln[:width])
            return out
        except Exception:
            return []

    def status(self, acc: dict) -> dict:
        group = self.groups.get(acc["id"])
        procs = group["procs"] if group else {}
        starts = group.get("starts", {}) if group else {}
        now = time.time()
        state = {}
        exits = {}
        for role in ("xvfb", "x11vnc", "qq"):
            p = procs.get(role)
            state[role] = bool(p and p.poll() is None)
            if p is not None and p.poll() is not None:
                uptime = int(now - starts.get(role, now))
                code = p.returncode
                exits[role] = {
                    "role": role,
                    "name": self.ROLE_NAMES.get(role, role),
                    "code": code,
                    "uptime": max(uptime, 0),
                    "hint": self._exit_hint(role, code, max(uptime, 0)),
                }
        count = sum(state.values())
        if count == 3:
            overall = "running"
        elif count == 0:
            overall = "stopped"
        else:
            overall = "partial"
        # 只报最贴近用户关心的那个：QQ > VNC > 虚拟屏
        last_exit = None
        for role in ("qq", "x11vnc", "xvfb"):
            if role in exits:
                last_exit = dict(exits[role])
                if role == "qq":
                    tail = self._tail_lines(acc["id"], 3)
                    if tail:
                        last_exit["log_tail"] = tail
                break
        return {
            "status": overall,
            "procs": state,
            "display": acc["display"],
            "vnc_port": acc["vnc_port"],
            "vnc_ready": port_open(int(acc["vnc_port"])),
            "pids": {k: (p.pid if p else None) for k, p in procs.items()},
            "last_exit": last_exit,
        }
    def logs(self, acc: dict, tail: int = 200) -> str:
        path = self.log_file(acc["id"])
        if not path.is_file():
            return "（暂无日志）"
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            return "\n".join(lines[-tail:]) or "（暂无日志）"
        except Exception as exc:
            return f"读取日志失败：{exc}"
    # ---------- PID 清单（供 cmd/main 兜底清理） ----------
    def _pids_file(self) -> Path:
        return self.data_dir / "pids.json"
    def _load_pids(self) -> None:
        try:
            self._saved = json.loads(self._pids_file().read_text(encoding="utf-8"))
        except Exception:
            self._saved = {}
    def _saved_pids_for(self, acc_id: str) -> list[int]:
        return list((self._saved.get(acc_id) or []))
    def _save_pids(self) -> None:
        payload = {}
        flat = []
        for acc_id, group in self.groups.items():
            pids = [p.pid for p in group["procs"].values() if p is not None]
            payload[acc_id] = pids
            flat.extend(pids)
        try:
            self._pids_file().write_text(
                json.dumps({"accounts": payload, "pids": flat}, ensure_ascii=False),
                encoding="utf-8",
            )
            self._saved = payload
        except Exception as exc:
            self.log(f"写入 pids.json 失败：{exc}")
    # ---------- 看门狗 ----------
    def revert_depth_if_unsafe(self) -> bool:
        """16 位色深导致 QQ 起不来时，自动回退到 24 位。

        Chromium/Electron 在 X11 上需要 24 位或 32 位 TrueColor visual；Xvfb 用
        -screen 0 WxHx16 时没有这种 visual，Electron 会直接退出（表现为
        「进程异常：QQ 已退出」）。所以省资源档一旦连续失败就自动降级回 24 位，
        且不覆盖用户手动选过的值（depth_user_set）。
        """
        try:
            s = self.settings()
            if int(s.get("depth") or 24) != 16:
                return False
            if s.get("depth_user_set"):
                return False
            if not self.settings_writer:
                return False
            s["depth"] = 24
            s["depth_autoreverted"] = True
            self.settings_writer()
            self.log("看门狗：16 位色深下 QQ 连续启动失败，已自动把色深改回 24 位"
                     "（Chromium 需要 24/32 位 TrueColor visual），即将重试")
            return True
        except Exception as exc:
            self.log(f"看门狗：自动回退色深失败：{exc}")
            return False

    def watchdog(self, accounts_provider, should_run, interval: int = 12):
        """后台线程：账号标记为运行中但进程挂了时自动整组重启。

        带指数退避：QQ 若因环境缺库/GPU 等原因一直起不来，不加限制会每 12 秒
        整组重启一次，刷爆日志并反复重建 Xvfb（真机上出现过这种死循环）。
        """
        fails: dict[str, int] = {}
        next_try: dict[str, float] = {}

        def loop():
            while True:
                time.sleep(interval)
                try:
                    now = time.time()
                    for acc in accounts_provider():
                        acc_id = acc["id"]
                        if not should_run(acc):
                            fails.pop(acc_id, None)
                            next_try.pop(acc_id, None)
                            continue
                        st = self.status(acc)
                        if st["status"] == "running":
                            fails.pop(acc_id, None)
                            next_try.pop(acc_id, None)
                            continue
                        if now < next_try.get(acc_id, 0):
                            continue
                        n = fails.get(acc_id, 0) + 1
                        fails[acc_id] = n
                        # 第 1 次立即重试，之后 30s/60s/120s… 上限 10 分钟
                        delay = 0 if n == 1 else min(30 * (2 ** min(n - 2, 4)), 600)
                        next_try[acc_id] = now + delay
                        # 连续 2 次仍异常且是 16 位色深 → 视为色深不兼容，自动降级
                        if n >= 2 and self.revert_depth_if_unsafe():
                            fails[acc_id] = 0
                            next_try[acc_id] = 0
                            continue
                        detail = ""
                        exit_info = st.get("last_exit") or {}
                        if exit_info.get("hint"):
                            detail = f"（{exit_info['hint']}）"
                        if exit_info.get("code") == -9:
                            detail += f"，当前可用内存 {mem_available_mb()}MB"
                        if n >= 4:
                            self.log(f"看门狗：{acc_id} 已连续 {n} 次启动失败，"
                                     f"暂停自动重启 {delay}s（请查看账号日志排查）{detail}，"
                                     f"修复后可在面板点「重启」")
                        else:
                            self.log(f"看门狗：{acc_id} 进程异常（{st['status']}），"
                                     f"第 {n} 次重启{detail}")
                        try:
                            self.restart(acc)
                        except Exception as exc:
                            self.log(f"看门狗重启失败：{exc}")
                except Exception as exc:
                    self.log(f"看门狗异常：{exc}")
        t = threading.Thread(target=loop, name="qqfarm-watchdog", daemon=True)
        t.start()
        return t

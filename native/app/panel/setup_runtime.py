"""首次运行时的「环境准备」：在应用自己的目录里补齐图形栈与官方 QQ 客户端。
纯 Python 标准库 + 系统自带的 apt-get download / dpkg-deb（都只写当前目录，
不需要 root）。不碰 Docker、不改系统、不装全局包。
"""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path
NOVNC_URLS = [
    "https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v1.6.0",
    "https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz",
]
# apt download 用：前两个是必须的可执行程序，后面是 Electron / VNC 常见运行库
DEB_PACKAGES = [
    "xvfb", "x11vnc",
    "libnss3", "libnspr4", "libgbm1", "libasound2",
    "libatk1.0-0", "libatk-bridge2.0-0", "libatspi2.0-0",
    "libcups2", "libdrm2", "libxkbcommon0", "libxcomposite1",
    "libxdamage1", "libxfixes3", "libxrandr2", "libxshmfence1",
    "libx11-xcb1", "libxcb-dri3-0", "libpixman-1-0", "libxfont2",
    "libfontenc1", "libxau6", "libxdmcp6", "libvncserver1",
    # x11vnc 同时链接 libvncclient.so.1，漏掉它会直接报
    # "error while loading shared libraries: libvncclient.so.1"。
    # 不同发行版包名有 t64 迁移差异，两个名字都试，逐个下载互不影响。
    "libvncclient1", "libvncclient1t64", "libvncserver1t64",
    "libjpeg62-turbo", "libssl3", "libssl3t64", "libasound2t64",
    "fonts-wqy-microhei",
]
UA = {"User-Agent": "Mozilla/5.0 (compatible; QQFarmNative/2.0)"}
# x11vnc 链接这两个 soname。真机日志里报
#   "error while loading shared libraries: libvncclient.so.1"
# 就是因为 DEB_PACKAGES 只列了 libvncserver1，漏了 libvncclient1。
REQUIRED_SONAMES = ("libvncclient.so.1", "libvncserver.so.1")
# 各发行版包名差异（Debian 12 / Ubuntu 24.04 的 t64 迁移等），逐个尝试。
SONAME_PACKAGES = (
    "libvncclient1", "libvncclient1t64", "libvncclient0",
    "libvncserver1", "libvncserver1t64",
)
def missing_runtime_libs(runtime: Path) -> list[str]:
    """检查 runtime/lib、runtime/sys、runtime/QQ 下是否已具备必需的 soname。"""
    present: set[str] = set()
    # 只看 lib/ 与 sys/：这两个目录才会进 LD_LIBRARY_PATH。
    # 不扫描 QQ/ —— 那里即便有同名 .so 也不会被加载，会造成误判。
    for base in (runtime / "lib", runtime / "sys"):
        if not base.is_dir():
            continue
        try:
            for p in base.rglob("*.so*"):
                present.add(p.name)
        except (OSError, ValueError):
            pass
    def has(name: str) -> bool:
        # deb 里常见 libX.so.1 -> libX.so.1.0.0 软链；解包/复制后可能只剩
        # 多级版本号，故同时接受 name 本身与 name.<patch> 形式。
        return name in present or any(p.startswith(name + ".") for p in present)

    return [s for s in REQUIRED_SONAMES if not has(s)]
def repair_missing_libs(runtime: Path, data: Path, emit=None) -> dict:
    """自愈：补齐 x11vnc 缺失的运行库。只下载到应用目录，不改系统。

    逐个包名调用 apt-get download —— 一次性传多个包名时，只要有一个在该
    发行版源里不存在，整条命令就会失败，导致一个 deb 都拿不到。
    """
    say = emit or (lambda msg: None)
    runtime = Path(runtime)
    data = Path(data)
    missing = missing_runtime_libs(runtime)
    result = {"missing_before": list(missing), "downloaded": [], "fixed": False}
    if not missing:
        result["fixed"] = True
        return result
    say(f"[libs] 检测到缺失运行库：{', '.join(missing)}，开始补齐")
    debdir = data / "downloads" / "debs"
    debdir.mkdir(parents=True, exist_ok=True)
    sys_dir = runtime / "sys"
    sys_dir.mkdir(parents=True, exist_ok=True)
    for pkg in SONAME_PACKAGES:
        try:
            r = subprocess.run(["apt-get", "download", pkg], cwd=str(debdir),
                               capture_output=True, text=True, timeout=180)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            say(f"[libs] 无法下载 {pkg}：{exc}")
            break
        if r.returncode == 0:
            result["downloaded"].append(pkg)
            say(f"[libs] 已下载 {pkg}")
        else:
            say(f"[libs] 跳过 {pkg}（此源里没有该包名）")
    debs = sorted(debdir.glob("*.deb"))
    for deb in debs:
        try:
            subprocess.run(["dpkg-deb", "-x", str(deb), str(sys_dir)],
                           capture_output=True, text=True, timeout=180)
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass
    # 汇总到 runtime/lib，并补齐 soname 软链
    libdir = runtime / "lib"
    libdir.mkdir(parents=True, exist_ok=True)
    try:
        for so in list(sys_dir.rglob("*.so")) + list(sys_dir.rglob("*.so.*")):
            try:
                if so.is_file():
                    shutil.copy2(so, libdir / so.name)
            except (OSError, shutil.Error):
                pass
        # 兜底：apt 源不可用时，从系统库目录复制已有的同名库
        need = set(missing)
        for syslib in ("/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu",
                       "/usr/lib64", "/lib/x86_64-linux-gnu", "/usr/lib", "/lib"):
            d = Path(syslib)
            if not need or not d.is_dir():
                continue
            for name in list(need):
                for cand in sorted(d.glob(name + "*")):
                    try:
                        if cand.is_file():
                            shutil.copy2(cand, libdir / cand.name)
                    except (OSError, shutil.Error):
                        pass
                if (libdir / name).exists() or any(
                        p.name.startswith(name + ".") for p in libdir.glob(name + ".*")):
                    need.discard(name)
        for real in sorted(libdir.glob("*.so.*.*")):
            parts = real.name.split(".so.")
            if len(parts) != 2:
                continue
            soname = parts[0] + ".so." + parts[1].split(".")[0]
            link = libdir / soname
            if soname != real.name and not link.exists():
                try:
                    link.symlink_to(real.name)
                except OSError:
                    pass
    except (OSError, ValueError):
        pass
    after = missing_runtime_libs(runtime)
    result["missing_after"] = after
    result["fixed"] = not after
    say(f"[libs] 补齐完成：fixed={result['fixed']} remaining={after}")
    return result
class SetupError(Exception):
    pass
class RuntimeSetup:
    def __init__(self, runtime_dir: Path, data_dir: Path, emit=None):
        self.runtime = Path(runtime_dir)
        self.data = Path(data_dir)
        self.downloads = self.data / "downloads"
        self.emit = emit or (lambda msg: None)
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.downloads.mkdir(parents=True, exist_ok=True)
    def log(self, msg: str):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.emit(line)
        try:
            with (self.data / "runtime-setup.log").open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass
    # ---------- 工具 ----------
    def download(self, url: str, dest: Path, timeout: int = 900) -> Path:
        self.log(f"下载 {url}")
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total and done // (10 * 1024 * 1024) != (done - len(chunk)) // (10 * 1024 * 1024):
                    self.log(f"  已下载 {done // (1024 * 1024)} MB / {total // (1024 * 1024)} MB")
        self.log(f"  完成：{dest.stat().st_size // 1024} KB")
        return dest
    @staticmethod
    def run_cmd(argv: list[str], cwd: Path | None = None, timeout: int = 300):
        try:
            return subprocess.run(argv, cwd=str(cwd) if cwd else None,
                                  capture_output=True, text=True, timeout=timeout)
        except FileNotFoundError:
            return None
        except subprocess.TimeoutExpired:
            return None
    def unpack_deb(self, deb: Path, dest: Path) -> bool:
        r = self.run_cmd(["dpkg-deb", "-x", str(deb), str(dest)], timeout=180)
        if r is None:
            self.log("  缺少 dpkg-deb，无法解包")
            return False
        if r.returncode != 0:
            self.log(f"  解包失败：{(r.stderr or '').strip()[:200]}")
            return False
        return True
    # ---------- 各步骤 ----------
    def step_novnc(self, custom_url: str = "") -> bool:
        target = self.runtime / "novnc"
        if (target / "core/rfb.js").is_file():
            self.log("noVNC 页面已存在，跳过")
            return True
        urls = ([custom_url] if custom_url else []) + NOVNC_URLS
        archive = self.downloads / "novnc.tar.gz"
        last_err = ""
        for url in urls:
            try:
                archive.unlink(missing_ok=True)
                self.download(url, archive, timeout=300)
                break
            except Exception as exc:
                last_err = str(exc)
                self.log(f"  该地址失败：{last_err[:120]}")
        else:
            self.log("noVNC 下载失败。可手动下载 noVNC v1.6.0，把 core/ 与 vendor/ 放到：")
            self.log(f"  {target}")
            return False
        try:
            with tarfile.open(archive, mode="r:gz") as tf:
                members = tf.getmembers()
                roots = {m.name.split("/")[0] for m in members if "/" in m.name}
                prefix = sorted(roots)[0] + "/" if roots else ""
                wanted = [m for m in members
                          if m.name.startswith(prefix + "core/")
                          or m.name.startswith(prefix + "vendor/")]
                target.mkdir(parents=True, exist_ok=True)
                for m in wanted:
                    rel = m.name[len(prefix):]
                    if rel.startswith("/") or ".." in rel.split("/"):
                        continue
                    m.name = rel
                    tf.extract(m, str(target))
            self.log(f"  noVNC 已安装（{len(wanted)} 个文件）")
            return (target / "core/rfb.js").is_file()
        except Exception as exc:
            self.log(f"  noVNC 解压失败：{exc}")
            return False
    def step_system_bins(self) -> bool:
        sys_dir = self.runtime / "sys"
        existing = list(sys_dir.rglob("Xvfb")) if sys_dir.is_dir() else []
        missing = missing_runtime_libs(self.runtime)
        # 以前这里「Xvfb 已存在就直接 return True」，导致用户重跑环境准备
        # 也永远补不上缺失的 libvncclient.so.1。现在改为：只在二进制齐全
        # 且必需 soname 齐全时才跳过。
        if existing and not missing:
            self.log("图形栈与运行库均已就绪，跳过系统组件下载")
            return True
        if missing:
            self.log(f"检测到缺失运行库：{', '.join(missing)}，将尝试补齐")
        debdir = self.downloads / "debs"
        debdir.mkdir(parents=True, exist_ok=True)
        self.log(f"用 apt-get download 逐个下载 {len(DEB_PACKAGES)} 个组件包（只下载到应用目录，不安装到系统）")
        # 必须逐个下载：一次传多个包名时，只要有一个在该发行版源里不存在，
        # apt-get 会整条失败，导致一个 deb 都拿不到。
        ok = 0
        for pkg in DEB_PACKAGES:
            r = self.run_cmd(["apt-get", "download", pkg], cwd=debdir, timeout=180)
            if r is None:
                self.log("  系统没有 apt-get，跳过下载；将依赖 NAS 上已安装的图形栈")
                break
            if r.returncode == 0:
                ok += 1
            else:
                self.log(f"  跳过 {pkg}（此源里没有该包名）")
        debs = sorted(debdir.glob("*.deb"))
        self.log(f"  本次成功下载 {ok} 个包，目录内共 {len(debs)} 个 deb，开始解包")
        if not debs:
            self.log("  没下载到任何 deb。若 NAS 上 apt 源未初始化，页面仍可尝试使用系统自带的 Xvfb / VNC 服务。")
            return False
        sys_dir.mkdir(parents=True, exist_ok=True)
        for deb in debs:
            self.unpack_deb(deb, sys_dir)
        for name in ("Xvfb", "x11vnc"):
            for p in sys_dir.rglob(name):
                try:
                    p.chmod(0o755)
                except Exception:
                    pass
        libdir = self.runtime / "lib"
        libdir.mkdir(parents=True, exist_ok=True)
        count = 0
        for so in list(sys_dir.rglob("*.so")) + list(sys_dir.rglob("*.so.*")):
            try:
                shutil.copy2(so, libdir / so.name)
                count += 1
            except Exception:
                pass
        self.log(f"  汇总 {count} 个动态库到 runtime/lib")
        fonts = self.runtime / "fonts"
        font_file = next((p for p in fonts.rglob("*.ttf") if p.is_file()), None) if fonts.is_dir() else None
        if font_file:
            (fonts / "fonts.conf").write_text(
                '<?xml version="1.0"?>\n<fontconfig>\n'
                f"  <dir>{font_file.parent}</dir>\n"
                "  <cachedir>/tmp/qqfarm-fontconfig</cachedir>\n</fontconfig>\n",
                encoding="utf-8",
            )
            self.log("  已配置中文字体")
        return bool(list(sys_dir.rglob("Xvfb")))
    def step_qq(self, qq_url: str = "", qq_path: str = "") -> bool:
        qq_dir = self.runtime / "QQ"
        if (qq_dir / "opt/QQ/qq").is_file():
            self.log("官方 QQ 已存在，跳过")
            return True
        deb = self.downloads / "qq.deb"
        try:
            if qq_path:
                cand = Path(qq_path)
                if not cand.is_absolute():
                    cand = self.data / qq_path
                if not cand.is_file():
                    raise SetupError(f"找不到 QQ deb：{cand}。请先用飞牛「文件管理」把它放进应用共享目录 qqfarm/ 下。")
                self.log(f"使用共享目录里的 {cand}")
                shutil.copy2(cand, deb)
            elif qq_url:
                self.download(qq_url, deb)
            else:
                self.log("未提供官方 QQ deb。请在页面填入下载直链，或先上传到应用共享目录后填文件名。")
                return False
        except SetupError as exc:
            self.log(str(exc))
            return False
        except Exception as exc:
            self.log(f"QQ deb 获取失败：{exc}")
            return False
        qq_dir.mkdir(parents=True, exist_ok=True)
        if not self.unpack_deb(deb, qq_dir):
            return False
        qq_bin = qq_dir / "opt/QQ/qq"
        if not qq_bin.is_file():
            found = list(qq_dir.rglob("qq"))
            qq_bin = next((p for p in found if p.is_file() and "resources" not in str(p)), None)
        if not qq_bin or not qq_bin.is_file():
            self.log("  解包后没找到 opt/QQ/qq，请确认下载的是官方 Linux QQ deb")
            return False
        try:
            qq_bin.chmod(0o755)
        except Exception:
            pass
        self.log(f"  官方 QQ 已解包：{qq_bin}")
        libdir = self.runtime / "lib"
        libdir.mkdir(parents=True, exist_ok=True)
        for so in list(qq_dir.rglob("*.so")) + list(qq_dir.rglob("*.so.*")):
            try:
                shutil.copy2(so, libdir / so.name)
            except Exception:
                pass
        return True
    # ---------- 入口 ----------
    def run(self, options: dict) -> dict:
        self.log("=== 开始环境准备 ===")
        result = {"novnc": False, "system": False, "qq": False}
        try:
            result["novnc"] = self.step_novnc(options.get("novnc_url", ""))
            result["system"] = self.step_system_bins()
            result["qq"] = self.step_qq(options.get("qq_url", ""), options.get("qq_path", ""))
        except Exception as exc:
            self.log(f"环境准备异常：{exc}")
        status = {
            "done": True,
            "result": result,
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        (self.runtime / "setup-status.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.log("=== 环境准备结束，请点「重新自检」 ===")
        return status

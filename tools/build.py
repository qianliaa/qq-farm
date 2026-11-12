#!/usr/bin/env python3
"""校验 FPK 源码 -> 调用飞牛官方 fnpack 打包 -> 修正脚本执行位 -> 输出到 dist/。

用法：
  python tools/build.py                          # 默认面板端口 8787
  python tools/build.py --panel-port 9878        # 统一改端口（manifest / ui / compose / 向导）
  python tools/build.py --panel-image docker.xuanyuan.run/library/python:3.11-alpine
  python tools/build.py --check-only             # 只做本地校验，不打包
"""

from __future__ import annotations

import argparse
import copy
import io
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
FPK = ROOT / "fpk"
DIST = ROOT / "dist"

REQUIRED = [
    "manifest",
    "config/resource",
    "config/privilege",
    "app/ui/config",
    "app/ui/images/icon_64.png",
    "app/ui/images/icon_256.png",
    "app/docker/docker-compose.yaml",
    "app/docker/panel/server.py",
    "app/docker/panel/dockerapi.py",
    "app/docker/panel/static/index.html",
    "app/docker/panel/static/style.css",
    "app/docker/panel/static/app.js",
    "wizard/install",
    "wizard/config",
    "wizard/uninstall",
    "ICON.PNG",
    "ICON_256.PNG",
    "LICENSE",
]
CMD_SCRIPTS = [
    "main", "install_init", "install_callback", "uninstall_init", "uninstall_callback",
    "upgrade_init", "upgrade_callback", "config_init", "config_callback",
]
JSON_FILES = [
    "config/resource", "config/privilege", "app/ui/config",
    "wizard/install", "wizard/config", "wizard/uninstall",
]


def check(cond, message):
    if not cond:
        raise SystemExit("校验失败：" + message)
    print("  [OK] " + message)


def validate() -> None:
    print("== 校验 FPK 源码 ==")
    for rel in REQUIRED + [f"cmd/{n}" for n in CMD_SCRIPTS]:
        check((FPK / rel).is_file(), f"存在 {rel}")
    for rel in JSON_FILES:
        try:
            json.loads((FPK / rel).read_text(encoding="utf-8"))
        except Exception as exc:
            raise SystemExit(f"校验失败：{rel} 不是合法 JSON：{exc}")
    check(True, "全部 JSON 文件可解析")

    manifest = (FPK / "manifest").read_text(encoding="utf-8")
    for key in ("appname", "version", "display_name", "desc", "source", "platform",
                "desktop_uidir", "desktop_applaunchname", "service_port"):
        check(re.search(rf"^{key}\s*=", manifest, re.M) is not None, f"manifest 含 {key}")
    appname = re.search(r"^appname\s*=\s*(\S+)", manifest, re.M).group(1)
    launch = re.search(r"^desktop_applaunchname\s*=\s*(\S+)", manifest, re.M).group(1)
    check(launch.startswith(appname + "."), "desktop_applaunchname 以 appname 为前缀")
    ui = json.loads((FPK / "app/ui/config").read_text(encoding="utf-8"))
    check(launch in ui.get(".url", {}), "应用入口 key 与 desktop_applaunchname 一致")

    compose = (FPK / "app/docker/docker-compose.yaml").read_text(encoding="utf-8")
    check("services:" in compose and "qqfarm-panel" in compose, "compose 定义了面板服务")
    check("${TRIM_APPDEST}/docker/panel:/app:ro" in compose, "compose 按官方变量挂载面板代码")
    check("/var/run/docker.sock:/var/run/docker.sock" in compose, "compose 挂载 Docker Socket")

    for rel in ("app/docker/panel/server.py", "app/docker/panel/dockerapi.py"):
        py_compile.compile(str(FPK / rel), doraise=True)
    py_compile.compile(str(TOOLS / "make_icons.py"), doraise=True)
    check(True, "Python 源码语法正确")

    if shutil.which("bash"):
        for name in CMD_SCRIPTS:
            r = subprocess.run(["bash", "-n", str(FPK / "cmd" / name)],
                               capture_output=True, text=True)
            check(r.returncode == 0, f"cmd/{name} shell 语法正确" + (r.stderr if r.returncode else ""))
    else:
        print("  [跳过] 未找到 bash，跳过 shell 语法检查")
    print()


def set_panel_port(port: int) -> None:
    print(f"== 同步面板端口为 {port} ==")
    manifest_path = FPK / "manifest"
    text = manifest_path.read_text(encoding="utf-8")
    text = re.sub(r"^service_port\s*=.*$", f"service_port          = {port}", text, flags=re.M)
    manifest_path.write_text(text, encoding="utf-8")

    ui_path = FPK / "app/ui/config"
    ui = json.loads(ui_path.read_text(encoding="utf-8"))
    for entry in ui.get(".url", {}).values():
        entry["port"] = str(port)
    ui_path.write_text(json.dumps(ui, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")

    compose_path = FPK / "app/docker/docker-compose.yaml"
    c = compose_path.read_text(encoding="utf-8")
    c = re.sub(r'- "(\d+):8787"', f'- "{port}:8787"', c)
    compose_path.write_text(c, encoding="utf-8")

    wizard_path = FPK / "wizard/install"
    w = wizard_path.read_text(encoding="utf-8")
    w = re.sub(r"<strong>\d+</strong> 端口", f"<strong>{port}</strong> 端口", w)
    wizard_path.write_text(w, encoding="utf-8")
    print(f"  已更新 manifest / ui/config / compose / wizard/install\n")


def set_panel_image(image: str) -> None:
    """打包时把面板基础镜像换成可访问的加速地址。"""
    compose_path = FPK / "app/docker/docker-compose.yaml"
    c = compose_path.read_text(encoding="utf-8")
    c = re.sub(r"^(\s*)image:\s*python:3\.11-alpine\s*$",
               rf'\1image: {image}', c, count=1, flags=re.M)
    compose_path.write_text(c, encoding="utf-8")
    print(f"== 面板基础镜像改为 {image} ==\n")


def find_fnpack() -> str:
    for name in ("fnpack.exe", "fnpack"):
        candidate = TOOLS / name
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("fnpack")
    if found:
        return found
    raise SystemExit("找不到 fnpack，请把官方工具放到 tools/ 目录")


def fix_modes(src: Path, dst: Path) -> None:
    """fnpack 在 Windows 上打出的 cmd/* 权限是 0666，这里统一改成 0755。"""
    with tarfile.open(src, mode="r:gz") as tin, tarfile.open(dst, mode="w:gz") as tout:
        for member in tin.getmembers():
            data = tin.extractfile(member).read() if member.isfile() else None
            info = copy.copy(member)
            if info.name.startswith("cmd/") and info.isfile():
                info.mode = 0o755
            tout.addfile(info, io.BytesIO(data) if data is not None else None)
    with tarfile.open(dst, mode="r:gz") as verify:
        modes = {m.name: m.mode for m in verify.getmembers() if m.name.startswith("cmd/") and m.isfile()}
    assert modes and all(v == 0o755 for v in modes.values()), modes
    print(f"  cmd/ 脚本执行位已修正（{len(modes)} 个）")


def build() -> Path:
    DIST.mkdir(exist_ok=True)
    # 清掉源码里的缓存文件，避免被打进包
    for junk in FPK.rglob("__pycache__"):
        if junk.is_dir():
            shutil.rmtree(junk)
    for junk in FPK.rglob(".DS_Store"):
        junk.unlink()

    fnpack = find_fnpack()
    before = set(ROOT.glob("*.fpk"))
    print("== 调用 fnpack 打包 ==")
    r = subprocess.run([fnpack, "build", "--directory", str(FPK)],
                       cwd=str(ROOT), capture_output=True, text=True)
    print("  " + (r.stdout or r.stderr).strip().replace("\n", "\n  "))
    if r.returncode != 0:
        raise SystemExit("fnpack 打包失败")
    produced = set(ROOT.glob("*.fpk")) - before
    if not produced:
        # fnpack 可能覆盖已有文件，取最新的那个
        produced = {max(ROOT.glob("*.fpk"), key=lambda p: p.stat().st_mtime)}
    raw = produced.pop()

    manifest = (FPK / "manifest").read_text(encoding="utf-8")
    version = re.search(r"^version\s*=\s*(\S+)", manifest, re.M).group(1)
    appname = re.search(r"^appname\s*=\s*(\S+)", manifest, re.M).group(1)
    target = DIST / f"{appname}-{version}.fpk"
    fix_modes(raw, target)
    if raw != target and raw.is_file():
        raw.unlink()
    print(f"\n完成：{target.relative_to(ROOT)}  ({target.stat().st_size} bytes)")
    return target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel-port", type=int, default=None, help="打包时统一修改管理面板端口")
    ap.add_argument("--panel-image", default=None, help="打包时替换面板基础镜像（例如国内加速地址）")
    ap.add_argument("--check-only", action="store_true", help="只校验不打包")
    args = ap.parse_args()

    if args.panel_port:
        if not (1 <= args.panel_port <= 65535):
            raise SystemExit("端口必须在 1-65535 之间")
        set_panel_port(args.panel_port)
    if args.panel_image:
        set_panel_image(args.panel_image)
    validate()
    if not args.check_only:
        build()


if __name__ == "__main__":
    main()

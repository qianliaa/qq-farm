#!/usr/bin/env python3
"""构建飞牛 fnOS .fpk 应用包。

不依赖 fnpack 二进制：按官方包结构手工打包，并显式写入文件权限，
避免 Windows 上打包导致 cmd 脚本丢失可执行位。
"""

from __future__ import annotations

import gzip
import io
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
SRC = HERE / "fpk-src"
BUILD = HERE / ".build"
APP = BUILD / "app"
DIST = HERE / "dist"

EXCLUDE_DIRS = {"data", "node_modules", "__pycache__", ".git"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}


def fail(message: str) -> None:
    print(f"错误：{message}", file=sys.stderr)
    sys.exit(1)


def copy_tree(src: Path, dst: Path) -> None:
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        rel = Path(root).relative_to(src)
        target_dir = dst / rel
        target_dir.mkdir(parents=True, exist_ok=True)
        for name in sorted(files):
            if name in EXCLUDE_FILES:
                continue
            shutil.copy2(Path(root) / name, target_dir / name)


def read_manifest() -> dict[str, str]:
    path = SRC / "manifest"
    if not path.is_file():
        fail("缺少 manifest")
    data: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def validate() -> dict[str, str]:
    required = [
        "manifest",
        "ICON.PNG",
        "ICON_256.PNG",
        "config/privilege",
        "config/resource",
        "app/ui/config",
        "app/ui/images/icon_64.png",
        "app/ui/images/icon_256.png",
    ]
    for rel in required:
        if not (SRC / rel).exists():
            fail(f"缺少必要文件：{rel}")

    for rel in ["manager/server.cjs", "shared/onebot.cjs", "runtime/napcat-install.sh"]:
        if not (PROJECT / rel).is_file():
            fail(f"缺少运行文件：{rel}")

    for rel in ["config/privilege", "config/resource", "app/ui/config"]:
        try:
            json.loads((SRC / rel).read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            fail(f"{rel} 不是合法 JSON：{exc}")

    for rel in ["wizard/install", "wizard/config", "wizard/uninstall"]:
        path = SRC / rel
        if path.exists():
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                fail(f"{rel} 不是合法 JSON：{exc}")

    cmd_dir = SRC / "cmd"
    for name in [
        "main",
        "common.sh",
        "install_init",
        "install_callback",
        "upgrade_init",
        "upgrade_callback",
        "uninstall_init",
        "uninstall_callback",
        "config_init",
        "config_callback",
    ]:
        path = cmd_dir / name
        if not path.is_file():
            fail(f"缺少生命周期脚本：cmd/{name}")
        raw = path.read_bytes()
        if b"\r\n" in raw:
            fail(f"cmd/{name} 含 CRLF 换行，Linux 无法执行")
        if not raw.startswith(b"#!/bin/bash"):
            fail(f"cmd/{name} 缺少 #!/bin/bash")

    runtime_script = PROJECT / "runtime" / "napcat-install.sh"
    if b"\r\n" in runtime_script.read_bytes():
        fail("runtime/napcat-install.sh 含 CRLF 换行，Linux 无法执行")

    manifest = read_manifest()
    for key in ["appname", "version", "display_name", "platform", "source"]:
        if not manifest.get(key):
            fail(f"manifest 缺少字段：{key}")
    if manifest["platform"] not in {"x86", "arm", "all"}:
        fail("manifest.platform 只能是 x86 / arm / all")
    if manifest.get("install_dep_apps") and "nodejs_v22" not in manifest["install_dep_apps"]:
        fail("本应用需要 Node.js 22 运行时依赖（install_dep_apps = nodejs_v22）")

    for icon in ["ICON.PNG", "ICON_256.PNG", "app/ui/images/icon_64.png", "app/ui/images/icon_256.png"]:
        size = (SRC / icon).stat().st_size
        if size > 1024 * 1024:
            fail(f"{icon} 超过 1024 KB")

    return manifest


def add_path(tar: tarfile.TarFile, path: Path, arcname: str, mode: int) -> None:
    info = tar.gettarinfo(str(path), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.mode = mode
    if path.is_dir():
        tar.addfile(info)
    else:
        with path.open("rb") as handle:
            tar.addfile(info, handle)


def write_tar_gz(output: Path, base: Path, executable: set[str] | None = None) -> None:
    executable = executable or set()
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            for root, dirs, files in os.walk(base):
                dirs[:] = sorted(dirs)
                rel_root = Path(root).relative_to(base)
                if rel_root != Path("."):
                    arc = rel_root.as_posix()
                    if arc not in executable:
                        add_path(tar, Path(root), arc, 0o755)
                for name in sorted(files):
                    path = Path(root) / name
                    arc = (rel_root / name).as_posix() if rel_root != Path(".") else name
                    mode = 0o755 if arc in executable else 0o644
                    add_path(tar, path, arc, mode)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(buffer.getvalue())


OUTER_EXECUTABLES = {
    "cmd/main",
    "cmd/install_init",
    "cmd/install_callback",
    "cmd/upgrade_init",
    "cmd/upgrade_callback",
    "cmd/uninstall_init",
    "cmd/uninstall_callback",
    "cmd/config_init",
    "cmd/config_callback",
}


def read_tar_entries(path: Path) -> dict[str, tarfile.TarInfo]:
    with tarfile.open(str(path), "r:gz") as tar:
        return {info.name: info for info in tar.getmembers()}


def verify_package(output: Path, app_tgz: Path) -> None:
    """复核外层与内层 tar：权限位、uid/gid 与关键文件必须符合 Linux 安装要求。"""
    outer = read_tar_entries(output)
    if "app.tgz" not in outer:
        fail("fpk 缺少 app.tgz")
    for name, info in outer.items():
        if info.uid != 0 or info.gid != 0:
            fail(f"fpk 条目 {name} 的 uid/gid 不是 0")
        expected = 0o755 if (info.isdir() or name in OUTER_EXECUTABLES) else 0o644
        if info.mode != expected:
            fail(f"fpk 条目 {name} 权限为 {oct(info.mode)}，应为 {oct(expected)}")

    inner = read_tar_entries(app_tgz)
    for rel in ["manager/server.cjs", "manager/lib/napcat.cjs", "runtime/napcat-install.sh"]:
        if rel not in inner:
            fail(f"app.tgz 缺少 {rel}")
    for name, info in inner.items():
        if info.uid != 0 or info.gid != 0:
            fail(f"app.tgz 条目 {name} 的 uid/gid 不是 0")
        expected = 0o755 if (info.isdir() or name == "runtime/napcat-install.sh") else 0o644
        if info.mode != expected:
            fail(f"app.tgz 条目 {name} 权限为 {oct(info.mode)}，应为 {oct(expected)}")
    print("打包校验通过：权限 755/644、uid/gid=0，关键文件齐全")


def main() -> None:
    manifest = validate()

    if BUILD.exists():
        shutil.rmtree(BUILD)
    APP.mkdir(parents=True)
    DIST.mkdir(parents=True, exist_ok=True)

    # 应用运行文件：manager / shared / scripts / runtime + ui + config。
    copy_tree(PROJECT / "manager", APP / "manager")
    copy_tree(PROJECT / "shared", APP / "shared")
    copy_tree(PROJECT / "scripts", APP / "scripts")
    copy_tree(PROJECT / "runtime", APP / "runtime")
    copy_tree(SRC / "app" / "ui", APP / "ui")
    copy_tree(SRC / "config", APP / "config")
    # 原生版本不再使用 Docker，避免把遗留模块打进安装包。
    (APP / "manager" / "lib" / "docker.cjs").unlink(missing_ok=True)

    app_tgz = BUILD / "app.tgz"
    write_tar_gz(app_tgz, APP, executable={"runtime/napcat-install.sh"})

    # fpk 根目录。
    fpk_root = BUILD / "fpk"
    fpk_root.mkdir()
    shutil.copy2(app_tgz, fpk_root / "app.tgz")
    for name in ["manifest", "ICON.PNG", "ICON_256.PNG"]:
        shutil.copy2(SRC / name, fpk_root / name)
    for name in ["config", "wizard"]:
        copy_tree(SRC / name, fpk_root / name)
    copy_tree(SRC / "cmd", fpk_root / "cmd")

    version = manifest["version"]
    platform = manifest["platform"]
    output = DIST / f"qqnas_{version}_{platform}.fpk"
    write_tar_gz(output, fpk_root, executable=OUTER_EXECUTABLES)
    verify_package(output, app_tgz)

    size_mb = output.stat().st_size / 1024 / 1024
    print(f"已生成：{output}（{size_mb:.2f} MB）")
    print(f"应用：{manifest['appname']} {version}，平台：{platform}")


if __name__ == "__main__":
    main()

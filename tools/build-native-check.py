#!/usr/bin/env python3
"""原生 FPK 源码校验（跨平台，build-native.sh 与本地方便共用）。"""

from __future__ import annotations

import json
import py_compile
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NATIVE = ROOT / "native"

REQUIRED = [
    "manifest", "config/resource", "config/privilege", "app/ui/config",
    "app/ui/images/icon_64.png", "app/ui/images/icon_256.png",
    "app/panel/server.py", "app/panel/procman.py", "app/panel/wsproxy.py",
    "app/panel/setup_runtime.py",
    "app/panel/static/index.html", "app/panel/static/style.css",
    "app/panel/static/app.js",
    "wizard/install", "wizard/config", "wizard/uninstall",
    "ICON.PNG", "ICON_256.PNG", "LICENSE",
]
CMD = ["main", "install_init", "install_callback", "uninstall_init", "uninstall_callback",
       "upgrade_init", "upgrade_callback", "config_init", "config_callback"]
JSON_FILES = ["config/resource", "config/privilege", "app/ui/config",
              "wizard/install", "wizard/config", "wizard/uninstall"]


def ok(msg):
    print(f"  [OK] {msg}")


def fail(msg):
    print(f"  [FAIL] {msg}")
    raise SystemExit(1)


def main():
    print("== 校验原生 FPK 源码 ==")
    for rel in REQUIRED + [f"cmd/{n}" for n in CMD]:
        if not (NATIVE / rel).is_file():
            fail(f"缺少 {rel}")
    ok("必需文件齐全")

    for rel in JSON_FILES:
        try:
            json.loads((NATIVE / rel).read_text(encoding="utf-8"))
        except Exception as exc:
            fail(f"{rel} 不是合法 JSON：{exc}")
    ok("JSON 文件可解析")

    resource = json.loads((NATIVE / "config/resource").read_text(encoding="utf-8"))
    if "docker-project" in resource:
        fail("原生版不应声明 docker-project")
    if "data-share" not in resource:
        fail("缺少 data-share（账号数据需要用户可见目录）")
    ok("资源声明为原生模式 + data-share")

    manifest = (NATIVE / "manifest").read_text(encoding="utf-8")
    def field(name):
        m = re.search(rf"^{name}\s*=\s*(.*)$", manifest, re.M)
        return m.group(1).strip() if m else ""

    for key in ("appname", "version", "display_name", "source", "platform",
                "desktop_uidir", "desktop_applaunchname"):
        if not field(key):
            fail(f"manifest 缺少 {key}")
    if "docker" in field("install_dep_apps").lower():
        fail("manifest 不应依赖 Docker")
    appname, launch = field("appname"), field("desktop_applaunchname")
    if not launch.startswith(appname + "."):
        fail("desktop_applaunchname 必须以 appname 为前缀")
    ui = json.loads((NATIVE / "app/ui/config").read_text(encoding="utf-8"))
    if launch not in ui.get(".url", {}):
        fail("桌面入口 key 与 desktop_applaunchname 不一致")
    entry = ui[".url"][launch]
    if entry.get("type") == "iframe":
        # 原生应用通过飞牛统一网关 + Unix Socket 提供 Web UI（非 Docker 端口模式）
        for gk in ("gatewayPrefix", "gatewaySocket"):
            if not entry.get(gk):
                fail(f"网关入口缺少 {gk}（原生应用需通过统一网关提供 Web UI）")
        if field("service_port"):
            fail("网关(iframe)入口不应同时声明 service_port")
        ok(f"manifest / 桌面入口为统一网关模式（gatewayPrefix={entry.get('gatewayPrefix')}）")
    else:
        if entry.get("port") != field("service_port"):
            fail("ui/config 的 port 与 manifest.service_port 不一致")
        ok(f"manifest / 桌面入口一致（appname={appname}, port={field('service_port')}）")

    for rel in ("app/panel/server.py", "app/panel/procman.py", "app/panel/wsproxy.py",
                "app/panel/setup_runtime.py"):
        try:
            py_compile.compile(str(NATIVE / rel), doraise=True)
        except Exception as exc:
            fail(f"{rel} Python 语法错误：{exc}")
    ok("Python 源码语法正确")

    if shutil.which("bash"):
        for name in CMD:
            r = subprocess.run(["bash", "-n", str(NATIVE / "cmd" / name)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                fail(f"cmd/{name} shell 语法错误：{r.stderr}")
        ok("cmd/* shell 语法正确")

    main_script = (NATIVE / "cmd/main").read_text(encoding="utf-8")
    if "docker" in main_script.lower():
        fail("cmd/main 不应调用 docker")
    deps = field("install_dep_apps")
    if "install_dep_apps" in manifest and not deps:
        fail("install_dep_apps 留空会导致安装被拒，不需要就整行删除")
    allowed = {p.split(">")[0].strip() for p in deps.split(":") if p.strip()}
    forbidden = {p for p in allowed if "docker" in p.lower()}
    if forbidden:
        fail(f"不应依赖 Docker 相关应用：{forbidden}")
    allowed_names = {"python312", "python311", "python310", "python39"}
    strange = allowed - allowed_names
    if strange:
        fail(f"未预期的依赖应用：{strange}（只允许商店 Python 运行时）")
    main_src = (NATIVE / "cmd/main").read_text(encoding="utf-8")
    if "/var/apps/python312/target/bin" not in main_src or "/usr/bin/python3" not in main_src:
        fail("cmd/main 应同时支持商店运行时与系统 python3 回退")
    ok("商店依赖声明为 Python 运行时 + cmd/main 保留系统 python3 兜底")

    print("原生 FPK 源码校验通过\n")


if __name__ == "__main__":
    main()

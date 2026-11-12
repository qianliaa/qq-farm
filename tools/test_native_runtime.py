#!/usr/bin/env python3
"""1.0.14 专项自测：运行时目录持久化 / 旧目录迁移 / 自动恢复。

    python tools/test_native_runtime.py
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = ROOT / "native" / "app" / "panel"
sys.path.insert(0, str(PANEL_DIR))

PASS = 0


def expect(label, cond, detail=""):
    global PASS
    if not cond:
        raise AssertionError(f"{label}：{detail}")
    PASS += 1
    print(f"  [OK] {label}")


def fresh_server(tmp: Path):
    """在临时数据目录下重新加载 server 模块。"""
    os.environ["QQFARM_DATA_DIR"] = str(tmp / "data")
    os.environ["QQFARM_STATIC_DIR"] = str(tmp / "static")
    os.environ.pop("QQFARM_RUNTIME_DIR", None)
    os.environ.pop("QQFARM_MANIFEST", None)
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    import server

    return importlib.reload(server)


def test_default_runtime_dir():
    print("[1] 运行时默认落在数据目录")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        srv = fresh_server(tmp)
        expect("RUNTIME_DIR = DATA_DIR/runtime", srv.RUNTIME_DIR == srv.DATA_DIR / "runtime", str(srv.RUNTIME_DIR))
        expect("不再指向安装目录",
               srv.RUNTIME_DIR != srv.BASE_DIR.parent / "runtime", str(srv.BASE_DIR.parent / "runtime"))
        expect("旧目录仍被记录用于迁移",
               srv.LEGACY_RUNTIME_DIR == srv.BASE_DIR.parent / "runtime", str(srv.LEGACY_RUNTIME_DIR))


def test_env_override():
    print("[2] 显式指定运行时目录时尊重环境变量")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        os.environ["QQFARM_RUNTIME_DIR"] = str(tmp / "custom-rt")
        import server

        srv = importlib.reload(server)
        expect("环境变量优先", srv.RUNTIME_DIR == tmp / "custom-rt", str(srv.RUNTIME_DIR))
        os.environ.pop("QQFARM_RUNTIME_DIR", None)


def test_migrate_runtime():
    print("[3] 旧安装目录的运行时搬迁")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        srv = fresh_server(tmp)
        legacy = tmp / "legacy-runtime"
        new = tmp / "data" / "runtime"
        srv.LEGACY_RUNTIME_DIR = legacy
        srv.RUNTIME_DIR = new
        logs = []
        srv.log = lambda msg: logs.append(msg)

        # 3.1 旧目录有内容、新目录为空 -> 全部搬过去
        (legacy / "qq").mkdir(parents=True)
        (legacy / "qq" / "qq").write_text("bin", encoding="utf-8")
        (legacy / "novnc" / "core").mkdir(parents=True)
        (legacy / "novnc" / "core" / "rfb.js").write_text("js", encoding="utf-8")
        (legacy / "setup-status.json").write_text("{}", encoding="utf-8")
        srv.migrate_runtime()
        expect("qq 已迁移", (new / "qq" / "qq").is_file())
        expect("noVNC 已迁移", (new / "novnc" / "core" / "rfb.js").is_file())
        expect("setup-status 已迁移", (new / "setup-status.json").is_file())
        expect("旧目录已清空", not any(legacy.iterdir()), str(list(legacy.iterdir())))
        expect("写了迁移日志", any("迁移" in m for m in logs), str(logs))

        # 3.2 新目录已有内容 -> 不覆盖、不搬
        (new / "qq" / "qq").write_text("newer", encoding="utf-8")
        (legacy / "qq").mkdir(parents=True)
        (legacy / "qq" / "qq").write_text("older", encoding="utf-8")
        logs.clear()
        srv.migrate_runtime()
        expect("新位置内容不被覆盖", (new / "qq" / "qq").read_text(encoding="utf-8") == "newer")
        expect("新位置已有内容时不做迁移", not logs, str(logs))

        # 3.3 旧目录不存在 -> 静默返回
        srv.LEGACY_RUNTIME_DIR = tmp / "nope"
        srv.migrate_runtime()
        expect("旧目录不存在时不报错", True)

        # 3.4 新=旧（未改目录结构）-> 直接返回
        srv.LEGACY_RUNTIME_DIR = new
        srv.RUNTIME_DIR = new
        srv.migrate_runtime()
        expect("新旧同路径时跳过", True)


def test_cache_detect():
    print("[4] 下载缓存探测")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        srv = fresh_server(tmp)
        expect("全新数据目录：无缓存", srv.runtime_cache_available() is False)
        (srv.DATA_DIR / "downloads").mkdir(parents=True, exist_ok=True)
        (srv.DATA_DIR / "downloads" / "qq.deb").write_text("x", encoding="utf-8")
        expect("有 qq.deb 缓存：可恢复", srv.runtime_cache_available() is True)
        (srv.DATA_DIR / "downloads" / "qq.deb").unlink()
        (srv.DATA_DIR / "downloads" / "debs").mkdir()
        expect("只有 debs 子目录也算缓存", srv.runtime_cache_available() is True)


def test_auto_restore():
    print("[5] 运行时缺失时自动恢复")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        srv = fresh_server(tmp)

        class PM:
            ready = False

            def preflight(self):
                return {"ready": self.ready, "missing": [] if self.ready else ["qq"]}

        started = []
        srv.PM = PM()
        srv.INSTALL["running"] = False
        srv.start_runtime_install = lambda options: started.append(options)
        srv.log = lambda msg: None

        # 5.1 有缓存 + 未就绪 -> 触发
        (srv.DATA_DIR / "downloads").mkdir(parents=True, exist_ok=True)
        (srv.DATA_DIR / "downloads" / "qq.deb").write_text("x", encoding="utf-8")
        expect("未就绪且有缓存：触发自动恢复", srv.auto_restore_runtime() is True and len(started) == 1, str(started))

        # 5.2 已就绪 -> 不触发
        started.clear()
        srv.PM.ready = True
        expect("已就绪：不触发", srv.auto_restore_runtime() is False and not started)

        # 5.3 未就绪但无缓存 -> 不触发（交给用户手动准备）
        started.clear()
        srv.PM.ready = False
        for p in (srv.DATA_DIR / "downloads").iterdir():
            if p.is_file():
                p.unlink()
            else:
                for q in p.iterdir():
                    q.unlink()
                p.rmdir()
        (srv.DATA_DIR / "downloads").rmdir()
        if (srv.DATA_DIR / "runtime-setup.log").exists():
            (srv.DATA_DIR / "runtime-setup.log").unlink()
        expect("无缓存：不擅自触发", srv.auto_restore_runtime() is False and not started)

        # 5.4 已有任务在跑 -> 不重复触发
        started.clear()
        (srv.DATA_DIR / "downloads").mkdir(parents=True, exist_ok=True)
        (srv.DATA_DIR / "downloads" / "qq.deb").write_text("x", encoding="utf-8")
        srv.INSTALL["running"] = True
        expect("任务进行中：不重复触发", srv.auto_restore_runtime() is False and not started)
        srv.INSTALL["running"] = False


def test_cmd_main():
    print("[6] cmd/main 的运行时目录推导")
    text = (ROOT / "native" / "cmd" / "main").read_text(encoding="utf-8")
    expect("不再把运行时放进安装目录", 'RUNTIME_DIR="${APPDEST}/runtime"' not in text)
    expect("运行时由数据目录推导", 'RUNTIME_DIR="${QQFARM_RUNTIME_DIR:-${DATA_DIR}/runtime}"' in text)
    expect("数据目录取自共享路径", 'DATA_DIR="${QQFARM_DATA_DIR:-${TRIM_DATA_SHARE_PATHS%%:*}}"' in text)
    expect("仍导出 QQFARM_RUNTIME_DIR", 'export QQFARM_RUNTIME_DIR="$RUNTIME_DIR"' in text)
    expect("仍导出 QQFARM_DATA_DIR", 'export QQFARM_DATA_DIR="$DATA_DIR"' in text)


def main():
    test_default_runtime_dir()
    test_env_override()
    test_migrate_runtime()
    test_cache_detect()
    test_auto_restore()
    test_cmd_main()
    print(f"\n全部通过：{PASS} 项断言")


if __name__ == "__main__":
    main()

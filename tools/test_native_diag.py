#!/usr/bin/env python3
"""1.0.11 专项自测：崩溃诊断 / 色深回退 / 内存水位。

    python tools/test_native_diag.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = ROOT / "native" / "app" / "panel"
sys.path.insert(0, str(PANEL_DIR))

import procman  # noqa: E402

PASS = 0


def expect(label, cond, detail=""):
    global PASS
    if not cond:
        raise AssertionError(f"{label}：{detail}")
    PASS += 1
    print(f"  [OK] {label}")


class FakePopen:
    instances = []

    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.pid = 90000 + len(FakePopen.instances)
        self.returncode = None
        FakePopen.instances.append(self)

    def poll(self):
        return self.returncode


def make_pm(tmp: Path, settings: dict, writer=None):
    FakePopen.instances = []
    procman.subprocess.Popen = FakePopen
    procman.port_free = lambda p: True
    procman.port_open = lambda p: True
    procman.display_free = lambda d: True
    procman.ProcessManager.resolve_bin = lambda self, role: f"/fake/{role}"
    procman.ProcessManager.preflight = lambda self: {
        "bins": {"xvfb": "x", "x11vnc": "x", "qq": "x"},
        "missing": [], "ready": True, "bundled": True, "mode": "bundled",
    }
    pm = procman.ProcessManager(tmp, tmp / "runtime", lambda: settings, settings_writer=writer)
    pm.log = lambda msg: None
    return pm


def test_exit_hints():
    print("[1] 退出码 → 人话诊断")
    pm = make_pm(Path(tempfile.mkdtemp()), {"resolution": "1024x768", "depth": 24})
    acc = {"id": "abc", "display": 101, "vnc_port": 15901, "name": "t"}
    pm.start(acc)
    qq = pm.groups["abc"]["procs"]["qq"]
    qq.returncode = -9
    st = pm.status(acc)
    expect("partial 判定", st["status"] == "partial", str(st["status"]))
    expect("定位到 QQ", st["last_exit"]["name"] == "QQ", str(st["last_exit"]))
    expect("SIGKILL 识别为 OOM", "OOM" in st["last_exit"]["hint"] or "内存" in st["last_exit"]["hint"],
           st["last_exit"]["hint"])
    # 附带日志尾部
    logf = pm.log_file("abc")
    logf.write_text("\n".join(["line-a", "FATAL:gpu boom", "bye"]), encoding="utf-8")
    st = pm.status(acc)
    tail = st["last_exit"].get("log_tail") or []
    expect("日志尾部带出", tail and "FATAL:gpu boom" in " | ".join(tail), str(tail))

    qq.returncode = 127
    st = pm.status(acc)
    expect("127 → 缺依赖提示", "依赖" in st["last_exit"]["hint"], st["last_exit"]["hint"])

    xvfb = pm.groups["abc"]["procs"]["xvfb"]
    qq.returncode = None
    xvfb.returncode = -6
    st = pm.status(acc)
    expect("虚拟屏崩溃也能报", st["last_exit"]["name"] == "虚拟屏", str(st["last_exit"]))


def test_depth_revert():
    print("[2] 16 位色深自动回退")
    settings = {"resolution": "1024x768", "depth": 16}
    calls = []
    pm = make_pm(Path(tempfile.mkdtemp()), settings, writer=lambda: calls.append(1))
    expect("16 位且未手动选择 → 回退", pm.revert_depth_if_unsafe() is True, "未回退")
    expect("改回 24 位", settings["depth"] == 24, str(settings))
    expect("落盘被调用", len(calls) == 1, str(calls))
    expect("打回退标记", settings.get("depth_autoreverted") is True, str(settings))

    settings2 = {"depth": 16, "depth_user_set": True}
    pm2 = make_pm(Path(tempfile.mkdtemp()), settings2, writer=lambda: None)
    expect("用户手动选的 16 位不动", pm2.revert_depth_if_unsafe() is False, "被擅自修改")

    settings3 = {"depth": 24}
    pm3 = make_pm(Path(tempfile.mkdtemp()), settings3, writer=lambda: None)
    expect("24 位无需回退", pm3.revert_depth_if_unsafe() is False, "不应触发")

    settings4 = {"depth": 16}
    pm4 = make_pm(Path(tempfile.mkdtemp()), settings4, writer=None)
    expect("无写入回调时不崩", pm4.revert_depth_if_unsafe() is False, "不应触发")


def test_mem():
    print("[3] 内存水位")
    v = procman.mem_available_mb()
    expect("返回整数（读不到为 -1）", isinstance(v, int), str(v))


def test_start_records_depth():
    print("[4] Xvfb 启动参数带色深 + 启动时间戳")
    settings = {"resolution": "1024x768", "depth": 24}
    pm = make_pm(Path(tempfile.mkdtemp()), settings)
    acc = {"id": "x1", "display": 105, "vnc_port": 15905, "name": "t"}
    pm.start(acc)
    cmd = FakePopen.instances[0].cmd
    expect("Xvfb 用 24 位", "1024x768x24" in cmd, str(cmd))
    expect("记录了启动时间", len(pm.groups["x1"]["starts"]) == 3, str(pm.groups["x1"]["starts"]))
    expect("running 状态", pm.status(acc)["status"] == "running", str(pm.status(acc)))


def test_server_settings_migration():
    print("[5] 服务端设置迁移（旧 16 位 → 24 位）")
    tmp = Path(tempfile.mkdtemp())
    os.environ["QQFARM_DATA_DIR"] = str(tmp)
    os.environ["QQFARM_RUNTIME_DIR"] = str(tmp / "runtime")
    import server  # noqa: E402

    # 场景 A：1.0.10 自动迁移来的 16 位
    (tmp / "state.json").write_text(json.dumps({
        "version": 2, "accounts": [],
        "settings": {"resolution": "1024x768", "depth": 16},
    }), encoding="utf-8")
    server.init_storage()
    expect("自动迁移的 16 位回退 24", server.STATE["settings"]["depth"] == 24,
           str(server.STATE["settings"]))

    # 场景 B：用户自己选的 16 位（带 depth_user_set）
    (tmp / "state.json").write_text(json.dumps({
        "version": 2, "accounts": [],
        "settings": {"resolution": "1024x768", "depth": 16, "depth_user_set": True},
    }), encoding="utf-8")
    server.init_storage()
    expect("用户选的 16 位保留", server.STATE["settings"]["depth"] == 16,
           str(server.STATE["settings"]))

    # 场景 C：全新安装
    (tmp / "state.json").unlink()
    server.init_storage()
    expect("全新安装默认 24 位", server.STATE["settings"]["depth"] == 24, str(server.STATE["settings"]))
    expect("全新安装默认 1024x768", server.STATE["settings"]["resolution"] == "1024x768",
           str(server.STATE["settings"]))

    # 场景 D：设置接口写入 16 位 → 打上 user_set 标记
    server.update_settings({"resolution": "1024x768", "depth": 16})
    expect("手动选 16 位被记录", server.STATE["settings"].get("depth_user_set") is True,
           str(server.STATE["settings"]))
    try:
        server.update_settings({"resolution": "1024x768", "depth": 8})
        raise AssertionError("非法色深未被拒绝")
    except ValueError:
        expect("非法色深仍被拒绝", True)


def test_update_check():
    print("[6] 检测更新")
    import server  # noqa: E402
    import tempfile, os as _os

    def fake_urlopen(payload, fail=False):
        class R:
            def __init__(self, data):
                self._data = data
            def read(self):
                return self._data
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        def inner(req, timeout=10):
            if fail:
                raise OSError("network unreachable")
            return R(json.dumps(payload).encode("utf-8"))
        return inner

    # 版本解析
    expect("版本解析 v1.0.13", server.parse_version("v1.0.13") == (1, 0, 13))
    expect("版本解析 1.2", server.parse_version("1.2") == (1, 2))
    expect("空版本安全", server.parse_version("") == (0,))
    expect("比较方向正确", server.parse_version("1.0.13") > server.parse_version("1.0.9"))

    # 当前版本兜底
    _os.environ.pop("QQFARM_MANIFEST", None)
    expect("当前版本有值", server.parse_version(server.app_version()) >= (1, 0, 13),
           server.app_version())

    # 未配置更新源
    r = server.check_update("")
    expect("空源报错不抛异常", bool(r.get("error")), str(r))
    r = server.check_update("ftp://bad")
    expect("非 http(s) 源被拒绝", "http" in r.get("error", ""), str(r))

    # 网络失败
    server.urllib.request.urlopen = fake_urlopen(None, fail=True)
    r = server.check_update("https://example.com/x.json")
    expect("网络失败返回 error", "无法访问" in r.get("error", ""), str(r))

    # 有新版本 + fpk 附件
    server.urllib.request.urlopen = fake_urlopen({
        "tag_name": "v1.0.14", "body": "修复若干问题",
        "html_url": "https://github.com/qianliaa/qq-farm/releases/v1.0.14",
        "assets": [{"name": "qqfarm-native-1.0.14.fpk",
                    "browser_download_url": "https://example.com/qqfarm-native-1.0.14.fpk",
                    "size": 12345}],
    })
    r = server.check_update("https://example.com/x.json")
    expect("识别到新版本", r.get("has_update") is True, str(r))
    expect("拿到最新版本号", r.get("latest") == "1.0.14", str(r))
    expect("拿到 fpk 下载地址", r["download"]["url"].endswith(".fpk"), str(r))
    expect("拿到更新说明", "修复" in r.get("changelog", ""), str(r))

    # 已是最新
    server.urllib.request.urlopen = fake_urlopen({"tag_name": "v1.0.13", "body": "", "html_url": "x", "assets": []})
    r = server.check_update("https://example.com/x.json")
    expect("已是最新版本", r.get("has_update") is False, str(r))
    expect("无附件时退回发布页", r["download"]["url"] == "x", str(r))


def main():
    test_exit_hints()
    test_depth_revert()
    test_mem()
    test_start_records_depth()
    test_server_settings_migration()
    test_update_check()
    print(f"\n全部通过：{PASS} 项断言")


if __name__ == "__main__":
    main()

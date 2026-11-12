#!/usr/bin/env python3
"""原生版端到端自测：mock 掉 Xvfb / x11vnc / QQ 进程，可在任意系统运行。

    python tools/test_native_panel.py
"""

from __future__ import annotations

import io
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = ROOT / "native" / "app" / "panel"
sys.path.insert(0, str(PANEL_DIR))

import procman  # noqa: E402
import wsproxy  # noqa: E402
import setup_runtime  # noqa: E402

FAKE_PROCS = []
PID_SEQ = [40000]


class FakePopen:
    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.kwargs = kwargs
        PID_SEQ[0] += 1
        self.pid = PID_SEQ[0]
        self.returncode = None
        FAKE_PROCS.append(self)

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9


def setup_fakes(runtime: Path):
    procman.subprocess.Popen = FakePopen
    procman.port_free = lambda p: True
    procman.port_open = lambda p: True
    procman.display_free = lambda d: True
    procman.alive = lambda pid: True
    # 直接给出假二进制路径，并让 preflight 认为全部就绪
    procman.ProcessManager.resolve_bin = lambda self, role: f"/fake/{role}"

    def fake_preflight(self):
        return {"bins": {"xvfb": "/fake/xvfb", "x11vnc": "/fake/x11vnc", "qq": "/fake/qq"},
                "missing": [], "ready": True, "bundled": True, "mode": "bundled"}

    procman.ProcessManager.preflight = fake_preflight

    class FakeSetup:
        def __init__(self, *_args, **kwargs):
            self.emit = kwargs.get("emit")

        def run(self, options):
            if self.emit:
                self.emit("mock: 开始环境准备")
                self.emit(f"mock: qq_url={options.get('qq_url', '')}")
                self.emit("mock: 环境准备完成")
            return {"done": True, "result": {"novnc": True, "system": True, "qq": True}}

    setup_runtime.RuntimeSetup = FakeSetup


def write_fake_novnc(runtime: Path):
    novnc = runtime / "novnc"
    (novnc / "core").mkdir(parents=True, exist_ok=True)
    (novnc / "vendor").mkdir(parents=True, exist_ok=True)
    (novnc / "core/rfb.js").write_text("export default class RFB {}", encoding="utf-8")
    (novnc / "vendor/pako.js").write_text("// fake vendor", encoding="utf-8")


def start_panel(data_dir: Path, runtime: Path, static_dir: Path):
    os.environ["QQFARM_DATA_DIR"] = str(data_dir)
    os.environ["QQFARM_RUNTIME_DIR"] = str(runtime)
    os.environ["QQFARM_STATIC_DIR"] = str(static_dir)
    os.environ["QQFARM_PORT"] = "8788"
    import server  # noqa: E402
    server.init_storage()
    server.init_process_manager()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, server


def req(port, method, path, body=None, cookie="", origin="", csrf=True):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    headers = {"X-QQFarm": "1"} if csrf else {}
    if cookie:
        headers["Cookie"] = cookie
    if origin:
        headers["Origin"] = origin
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=payload, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    hdrs = {k.lower(): v for k, v in resp.getheaders()}
    status = resp.status
    conn.close()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        data = raw
    return status, hdrs, data


PASS = 0


def expect(label, cond, detail=""):
    global PASS
    if not cond:
        raise AssertionError(f"{label}：{detail}")
    PASS += 1
    print(f"  [OK] {label}")


def test_ws_frames():
    # 服务端 -> 客户端帧
    frame = wsproxy.build_frame(b"RFB 003.008\n", 0x2)
    expect("WS 帧头为 FIN+binary", frame[0] == 0x82, str(frame[:2]))
    expect("WS 帧长度正确", frame[1] == 12 and frame[2:] == b"RFB 003.008\n", str(frame))
    big = wsproxy.build_frame(b"x" * 300)
    expect("WS 扩展长度(126)正确", big[1] == 126 and struct.unpack(">H", big[2:4])[0] == 300, str(big[:4]))

    # 客户端 -> 服务端帧（必须 masked）
    payload = b"hello vnc"
    mask = b"\x01\x02\x03\x04"
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    client_frame = bytes([0x82, 0x80 | len(payload)]) + mask + masked
    fin, opcode, decoded = wsproxy._read_frame(io.BytesIO(client_frame))
    expect("WS 客户端帧解析（去掩码）", fin and opcode == 0x2 and decoded == payload, str(decoded))
    ping = bytes([0x89, 0x80]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(b"p"))
    expect("WS ping 帧解析", wsproxy._read_frame(io.BytesIO(ping))[1] == 0x9, "opcode")
    expect("WS Sec-WebSocket-Accept 计算",
           wsproxy.accept_key("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
           wsproxy.accept_key("dGhlIHNhbXBsZSBub25jZQ=="))


def main():
    print("== WS 帧单元测试 ==")
    test_ws_frames()

    with tempfile.TemporaryDirectory(prefix="qqfarm-native-test-") as tmp:
        base = Path(tmp)
        data, runtime = base / "data", base / "runtime"
        data.mkdir()
        runtime.mkdir()
        write_fake_novnc(runtime)
        setup_fakes(runtime)
        panel, srv = start_panel(data, runtime, PANEL_DIR / "static")
        port = panel.server_address[1]
        print(f"\n== 面板端到端（端口 {port}） ==")

        st, _, b = req(port, "GET", "/api/bootstrap")
        expect("bootstrap 返回未初始化", st == 200 and b["configured"] is False, str((st, b)))
        expect("bootstrap 报告图形栈就绪", b["runtime_ready"] is True, str(b))

        st, _, b = req(port, "GET", "/api/state")
        expect("未登录 /api/state 返回 401", st == 401, str((st, b)))

        st, _, b = req(port, "POST", "/api/setup", {"password": "short"})
        expect("弱密码被拒绝", st == 400, str((st, b)))
        st, h, b = req(port, "POST", "/api/setup", {"password": "Native123!"})
        expect("初始化管理密码成功", st == 200 and b["ok"], str((st, b)))
        cookie = h.get("set-cookie", "").split(";")[0]
        expect("下发 HttpOnly 会话 Cookie", "qqfarm_sid=" in cookie and "HttpOnly" in h.get("set-cookie", ""), cookie)

        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("读取初始状态", st == 200 and b["summary"]["total"] == 0, str((st, b)))
        expect("状态标记为原生+捆绑模式", b["runtime"]["mode"] == "bundled" and b["runtime"]["ready"], str(b["runtime"]))
        expect("面板版本为原生版", "native" in b["panel_version"], b["panel_version"])

        st, _, b = req(port, "POST", "/api/accounts", {"name": "一号"})
        expect("无 Cookie 创建账号被拒绝", st == 401, str((st, b)))

        FAKE_PROCS.clear()
        st, _, b = req(port, "POST", "/api/accounts", {"name": "一号", "qq": "10001"}, cookie)
        expect("创建账号成功", st == 200 and b["ok"], str((st, b)))
        acc = b["account"]
        expect("自动分配 DISPLAY :101", acc["display"] == 101, str(acc))
        expect("自动分配内部 VNC 端口 15901", acc["vnc_port"] == 15901, str(acc))
        expect("确实拉起了 3 个进程", len(FAKE_PROCS) == 3, str([p.cmd[0] for p in FAKE_PROCS]))
        cmds = [" ".join(p.cmd) for p in FAKE_PROCS]
        expect("Xvfb 参数含 DISPLAY 与分辨率", ":101" in cmds[0] and "1024x768x24" in cmds[0], cmds[0])
        expect("x11vnc 只监听 127.0.0.1 且端口正确", "15901" in cmds[1] and "127.0.0.1" in cmds[1], cmds[1])
        expect("QQ 以 --no-sandbox 启动且数据目录隔离", "--no-sandbox" in cmds[2] and "qqdata" in cmds[2], cmds[2])
        env = FAKE_PROCS[2].kwargs.get("env", {})
        expect("QQ 进程 DISPLAY/HOME 已隔离", env.get("DISPLAY") == ":101" and str(acc["id"]) in env.get("HOME", ""), str({k: env.get(k) for k in ("DISPLAY", "HOME")}))
        acc_id = acc["id"]

        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("账号状态为运行中", b["summary"]["running"] == 1, str(b["summary"]))
        expect("三个子进程状态均为 True", all(b["accounts"][0]["procs"].values()), str(b["accounts"][0]["procs"]))
        expect("桌面入口为同源路径", b["accounts"][0]["desktop_path"] == f"/desktop/{acc_id}/", str(b["accounts"][0]["desktop_path"]))

        st, _, b = req(port, "POST", "/api/accounts", {"name": "二号"}, cookie)
        expect("第二个账号 DISPLAY 递增", st == 200 and b["account"]["display"] == 102, str((st, b)))
        expect("第二个账号 VNC 端口递增", b["account"]["vnc_port"] == 15902, str(b["account"]))

        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/stop", {}, cookie)
        expect("停止账号", st == 200, str((st, b)))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        target = next(a for a in b["accounts"] if a["id"] == acc_id)
        expect("状态变为已停止且 enabled=False", target["status"] == "stopped" and target["enabled"] is False, str(target))

        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/start", {}, cookie)
        expect("启动账号", st == 200, str((st, b)))
        st, _, b = req(port, "GET", f"/api/accounts/{acc_id}/logs?tail=50", cookie=cookie)
        expect("日志接口可用", isinstance(b.get("logs"), str), str(b)[:120])

        FAKE_PROCS.clear()
        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/update",
                       {"name": "改名", "display": 155}, cookie)
        expect("编辑账号并重启进程组", st == 200, str((st, b)))
        cmds2 = [" ".join(p.cmd) for p in FAKE_PROCS]
        expect("重启后使用新 DISPLAY", any(":155" in c for c in cmds2), str(cmds2[:1]))

        st, _, b = req(port, "POST", "/api/settings",
                       {"resolution": "1440x900", "autostart": True,
                        "watchdog": False, "watchdog_interval": 20}, cookie)
        expect("保存全局设置", st == 200 and b["settings"]["resolution"] == "1440x900", str((st, b)))
        st, _, b = req(port, "POST", "/api/settings", {"resolution": "bad-value"}, cookie)
        expect("非法分辨率被拒绝", st == 400, str((st, b)))

        st, _, b = req(port, "GET", f"/desktop/{acc_id}")
        expect("未登录打开桌面跳转登录页", st == 302, str((st, b)))
        st, _, b = req(port, "GET", f"/desktop/{acc_id}", cookie=cookie)
        html = b.decode("utf-8") if isinstance(b, bytes) else str(b)
        expect("已登录可打开 noVNC 引导页", st == 200 and "RFB" in html, str(st))
        expect("引导页 WebSocket 指向本账号", f"/desktop/{acc_id}/ws" in html, html[:200])
        st, _, b = req(port, "GET", "/novnc/core/rfb.js", cookie=cookie)
        expect("noVNC 静态文件可访问", st == 200, str(st))
        st, _, b = req(port, "GET", "/novnc/../../etc/passwd", cookie=cookie)
        expect("noVNC 目录穿越被拒绝", st in (400, 403, 404), str(st))

        # 写操作要求自定义头 X-QQFarm: 1（跨站页面无法私自添加，会触发预检）
        st, _, b = req(port, "POST", "/api/runtime/check", {},
                       cookie, origin="http://evil.example", csrf=False)
        expect("缺少 X-QQFarm 头的写操作被拒绝", st == 403, str((st, b)))

        st, _, b = req(port, "POST", "/api/runtime/check", {}, cookie)
        expect("图形栈自检接口可用", st == 200 and b["runtime"]["ready"], str((st, b)))

        st, _, b = req(port, "GET", "/api/runtime/install/status", cookie=cookie)
        expect("环境准备状态接口可用", st == 200 and b["running"] is False, str((st, b)))
        st, _, b = req(port, "POST", "/api/runtime/install",
                       {"qq_url": "https://example.com/qq.deb", "qq_path": "", "novnc_url": ""}, cookie)
        expect("一键环境准备可启动", st == 200 and b["ok"], str((st, b)))
        for _ in range(30):
            st, _, prog = req(port, "GET", "/api/runtime/install/status", cookie=cookie)
            if prog.get("finished"):
                break
            time.sleep(0.1)
        expect("环境准备任务完成并回传日志",
               prog.get("finished") is True and any("环境准备完成" in x for x in prog.get("lines", [])),
               str(prog)[:300])
        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("状态里标记安装已结束", b["runtime"]["setup_finished"] is True, str(b["runtime"]))

        st, _, b = req(port, "GET", "/api/export", cookie=cookie)
        expect("导出配置可访问", isinstance(b, dict) and "accounts" in b, str(type(b)))

        st, _, b = req(port, "POST", "/api/password",
                       {"old": "Native123!", "new": "Native456!"}, cookie)
        expect("修改管理密码", st == 200, str((st, b)))
        st, h2, b = req(port, "POST", "/api/login", {"password": "Native456!"})
        expect("新密码可登录", st == 200 and b.get("ok") is True, str((st, b)))
        cookie2 = h2.get("set-cookie", "").split(";")[0]

        st, _, b = req(port, "DELETE", f"/api/accounts/{acc_id}?purge=1", cookie=cookie2)
        expect("删除账号成功", st == 200, str((st, b)))
        expect("purge 时删除账号目录", not (data / "accounts" / acc_id).exists(), str(list((data / "accounts").iterdir())))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie2)
        expect("账号数量回落到 1", b["summary"]["total"] == 1, str(b["summary"]))

        st, _, b = req(port, "POST", "/api/logout", {}, cookie2)
        expect("退出登录成功", st == 200, str((st, b)))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie2)
        expect("退出后会话失效", st == 401, str((st, b)))

        print(f"\n全部通过：{PASS} 项断言")
    panel.shutdown()


if __name__ == "__main__":
    main()

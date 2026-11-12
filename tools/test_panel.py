#!/usr/bin/env python3
"""面板端到端自测：用一个假的 Docker Engine HTTP 服务替代 /var/run/docker.sock。

不依赖 Docker、不依赖第三方库，可在 Windows / Linux / NAS 上直接跑：
    python tools/test_panel.py
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = ROOT / "fpk" / "app" / "docker" / "panel"
sys.path.insert(0, str(PANEL_DIR))

IMAGE = "libzonda/linux-qq-release:latest-amd64"
LOCK = threading.Lock()


class FakeDocker:
    def __init__(self):
        self.containers: dict[str, dict] = {}
        self.volumes: set[str] = set()
        self.counter = 0
        self.calls: list[str] = []

    def list_containers(self):
        out = []
        for name, c in self.containers.items():
            port = int(c["spec"]["HostConfig"]["PortBindings"]["5800/tcp"][0]["HostPort"])
            out.append({
                "Id": c["id"],
                "Names": ["/" + name],
                "Image": c["spec"]["Image"],
                "State": c["state"],
                "Status": "Up 1 minute" if c["state"] == "running" else "Exited",
                "Labels": c["spec"].get("Labels", {}),
                "Ports": [{"IP": "0.0.0.0", "PrivatePort": 5800,
                           "PublicPort": port, "Type": "tcp"}],
            })
        return out


FAKE = FakeDocker()


class DockerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _reply(self, status, obj=None, raw: bytes = b"", ctype="application/json"):
        body = raw if raw else (json.dumps(obj).encode("utf-8") if obj is not None else b"")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        with LOCK:
            FAKE.calls.append("GET " + path)
        if path == "/version":
            return self._reply(200, {"Version": "24.0.9", "ApiVersion": "1.43", "Arch": "amd64"})
        if path == "/_ping":
            return self._reply(200, raw=b"OK", ctype="text/plain")
        if path == "/containers/json":
            return self._reply(200, FAKE.list_containers())
        if path == "/images/json":
            return self._reply(200, [{"Id": "sha256:mock", "RepoTags": [IMAGE]}])
        if "/logs" in path:
            payload = b"[NapCat] mock log line\nhello\n"
            frame = b"\x01\x00\x00\x00" + len(payload).to_bytes(4, "big") + payload
            return self._reply(200, raw=frame, ctype="application/vnd.docker.raw-stream")
        if "/stats" in path:
            return self._reply(200, {"memory_stats": {"usage": 512 * 1024 * 1024}})
        if path.startswith("/containers/") and path.endswith("/json"):
            cid = path.split("/")[2]
            for c in FAKE.containers.values():
                if c["id"] == cid:
                    return self._reply(200, {"Id": cid, "State": {"Status": c["state"]}})
            return self._reply(404, {"message": "no such container"})
        return self._reply(404, {"message": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        body = self._read_body()
        with LOCK:
            FAKE.calls.append("POST " + path)
        if path == "/images/create":
            return self._reply(200, raw=(
                b'{"status":"Pulling from libzonda/linux-qq-release"}\n'
                b'{"status":"Download complete"}\n'), ctype="application/json")
        if path == "/volumes/create":
            FAKE.volumes.add(body["Name"])
            return self._reply(201, {"Name": body["Name"]})
        if path == "/containers/create":
            name = (qs.get("name") or ["mock"])[0]
            if name in FAKE.containers:
                return self._reply(409, {"message": "container already exists"})
            FAKE.counter += 1
            cid = f"cid{FAKE.counter:04d}"
            FAKE.containers[name] = {"id": cid, "spec": body, "state": "created"}
            return self._reply(201, {"Id": cid, "Warnings": []})
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "containers":
            ref, action = parts[1], parts[2]
            target = FAKE.containers.get(ref)
            if target is None:
                target = next((c for c in FAKE.containers.values() if c["id"] == ref), None)
            if target is not None:
                if action == "start":
                    target["state"] = "running"
                elif action == "stop":
                    target["state"] = "exited"
                elif action == "restart":
                    target["state"] = "running"
                return self._reply(204)
            return self._reply(404, {"message": "no such container"})
        return self._reply(404, {"message": "not found"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        with LOCK:
            FAKE.calls.append("DELETE " + path)
        if path.startswith("/volumes/"):
            FAKE.volumes.discard(path.split("/")[-1])
            return self._reply(204)
        if path.startswith("/containers/"):
            ref = path.split("/")[2]
            if ref in FAKE.containers:
                del FAKE.containers[ref]
                return self._reply(204)
            for name, c in list(FAKE.containers.items()):
                if c["id"] == ref:
                    del FAKE.containers[name]
                    return self._reply(204)
            return self._reply(404, {"message": "no such container"})
        return self._reply(404, {"message": "not found"})


def start_docker():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), DockerHandler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def start_panel(data_dir: Path, docker_port: int):
    os.environ["DATA_DIR"] = str(data_dir)
    os.environ["DOCKER_TCP"] = f"127.0.0.1:{docker_port}"
    os.environ.setdefault("PANEL_PORT", "8787")
    import server  # noqa: E402
    server.init_storage()
    server.init_docker()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, server


def req(port: int, method: str, path: str, body=None, cookie: str = "", origin: str = ""):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"X-QQFarm": "1"}
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


def main():
    docker = start_docker()
    with tempfile.TemporaryDirectory(prefix="qqfarm-test-") as tmp:
        panel, srv = start_panel(Path(tmp), docker.server_address[1])
        port = panel.server_address[1]
        print(f"面板测试端口 {port} / 假 Docker 端口 {docker.server_address[1]}\n")

        st, _, b = req(port, "GET", "/api/bootstrap")
        expect("bootstrap 返回未初始化", st == 200 and b["configured"] is False, str(b))
        expect("bootstrap 识别 Docker 架构", b["arch"] == "amd64", str(b))

        st, _, b = req(port, "GET", "/api/state")
        expect("未登录时 /api/state 返回 401", st == 401, str((st, b)))

        st, h, b = req(port, "POST", "/api/setup", {"password": "short"})
        expect("弱密码被拒绝", st == 400, str((st, b)))

        st, h, b = req(port, "POST", "/api/setup", {"password": "TestPass123!"})
        expect("初始化管理密码成功", st == 200 and b["ok"], str((st, b)))
        cookie = h.get("set-cookie", "").split(";")[0]
        expect("下发 HttpOnly 会话 Cookie", "qqfarm_sid=" in cookie and "HttpOnly" in h.get("set-cookie", ""), cookie)

        st, _, b = req(port, "POST", "/api/setup", {"password": "Another123!"}, cookie)
        expect("重复初始化被拒绝", st == 409, str((st, b)))

        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("登录后读取状态", st == 200 and b["summary"]["total"] == 0, str((st, b)))
        expect("镜像状态正确", b["image"]["present"] is True, str(b["image"]))
        expect("自动镜像按架构选择", b["docker"]["auto_image"] == IMAGE, str(b["docker"]))

        st, _, b = req(port, "POST", "/api/accounts", {"name": "测试号A"})
        expect("新增账号（无 Cookie）被拒绝", st == 401, str((st, b)))

        st, _, b = req(port, "POST", "/api/accounts", {"name": "测试号A", "qq": "10001"}, cookie)
        expect("创建账号成功", st == 200 and b["ok"], str((st, b)))
        acc = b["account"]
        expect("自动分配端口 5801", acc["port"] == 5801, str(acc))
        expect("自动生成 VNC 密码", len(acc["vnc_password"]) >= 8, str(acc))
        acc_id = acc["id"]

        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("账号状态为运行中", b["summary"]["running"] == 1, str(b["summary"]))
        expect("读取到实际内存占用", b["accounts"][0]["mem_used_mb"] == 512, str(b["accounts"][0]))
        expect("容器 spec 含 /dev/shm 与端口映射",
               len(FAKE.containers) == 1 and
               next(iter(FAKE.containers.values()))["spec"]["HostConfig"]["ShmSize"] == 1024 * 1024 * 1024)

        st, _, b = req(port, "POST", "/api/accounts", {"name": "测试号B"}, cookie)
        expect("第二个账号端口递增", st == 200 and b["account"]["port"] == 5802, str((st, b)))

        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/stop", {}, cookie)
        expect("停止账号", st == 200, str((st, b)))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie)
        expect("状态变为已停止", next(a for a in b["accounts"] if a["id"] == acc_id)["status"] == "exited", str(b["summary"]))

        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/start", {}, cookie)
        expect("启动账号", st == 200, str((st, b)))
        st, _, b = req(port, "GET", f"/api/accounts/{acc_id}/logs?tail=50", cookie=cookie)
        expect("日志解析（8 字节帧头）", "mock log line" in b.get("logs", ""), str(b)[:200])

        st, _, b = req(port, "POST", f"/api/accounts/{acc_id}/update",
                       {"name": "改名后的号", "memory_mb": 2048}, cookie)
        expect("编辑账号并重建容器", st == 200, str((st, b)))
        spec = FAKE.containers[f"qqfarm-{acc_id}"]["spec"]
        expect("重建后内存上限生效", spec["HostConfig"]["Memory"] == 2048 * 1024 * 1024, str(spec["HostConfig"]["Memory"]))

        st, _, b = req(port, "POST", "/api/settings",
                       {"port_start": 6001, "port_end": 6050, "default_memory_mb": 1792,
                        "auto_restart": True}, cookie)
        expect("保存全局设置", st == 200 and b["settings"]["port_start"] == 6001, str((st, b)))

        st, _, b = req(port, "POST", "/api/image/pull", {}, cookie)
        expect("拉取镜像接口可用", st == 200 and b["ok"], str((st, b)))

        st, _, b = req(port, "POST", "/api/accounts", {"name": "越权测试"},
                       cookie, origin="http://evil.example")
        expect("跨站 Origin 被拒绝", st == 403, str((st, b)))

        st, _, b = req(port, "GET", "/static/app.js", cookie=cookie)
        expect("静态资源可访问", isinstance(b, bytes) and len(b) > 1000, str(type(b)))

        st, _, b = req(port, "GET", "/api/export", cookie=cookie)
        expect("导出配置可访问", isinstance(b, dict) and "accounts" in b, str(type(b)))

        st, _, b = req(port, "POST", "/api/password",
                       {"old": "WRONG", "new": "NewPass456!"}, cookie)
        expect("原密码错误被拒绝", st == 400, str((st, b)))
        st, _, b = req(port, "POST", "/api/password",
                       {"old": "TestPass123!", "new": "NewPass456!"}, cookie)
        expect("修改管理密码", st == 200, str((st, b)))
        st, h2, b = req(port, "POST", "/api/login", {"password": "NewPass456!"})
        expect("新密码可登录", st == 200 and b.get("ok") is True, str((st, b)))
        cookie2 = h2.get("set-cookie", "").split(";")[0]

        st, _, b = req(port, "DELETE", f"/api/accounts/{acc_id}?purge=1", cookie=cookie2)
        expect("删除账号成功", st == 200, str((st, b)))
        expect("删除时清理数据卷", f"qqfarm-acc-{acc_id}-config" not in FAKE.volumes, str(FAKE.volumes))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie2)
        expect("账号数量回落到 1", b["summary"]["total"] == 1, str(b["summary"]))

        st, _, b = req(port, "POST", "/api/logout", {}, cookie2)
        expect("退出登录成功", st == 200, str((st, b)))
        st, _, b = req(port, "GET", "/api/state", cookie=cookie2)
        expect("退出后会话失效", st == 401, str((st, b)))

        print(f"\n全部通过：{PASS} 项断言")
    docker.shutdown()
    panel.shutdown()


if __name__ == "__main__":
    main()

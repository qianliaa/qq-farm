"""极简 Docker Engine API 客户端（仅 Python 标准库，通过 Unix Socket 通信）。

面板容器需要挂载 /var/run/docker.sock，才能替用户动态创建/管理 QQ 容器。
不依赖 docker CLI、不依赖第三方库，方便在 python:3.11-alpine 里直接运行。
"""

from __future__ import annotations

import base64
import http.client
import json
import re
import socket
import urllib.parse
from typing import Any

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class DockerError(Exception):
    def __init__(self, status: int, message: str, payload: bytes = b""):
        super().__init__(message)
        self.status = status
        self.message = message
        self.payload = payload

    def __str__(self) -> str:
        return f"Docker API {self.status}: {self.message}"


class UnixHTTPConnection(http.client.HTTPConnection):
    """让 http.client 走 Unix Domain Socket。"""

    def __init__(self, socket_path: str, timeout: float = 30):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def split_image_ref(ref: str) -> tuple[str, str]:
    """把 'ghcr.io/x/y:tag' 拆成 (repository, tag)，兼容带端口的 registry。"""
    ref = ref.strip()
    last_slash = ref.rfind("/")
    colon = ref.rfind(":")
    if colon > last_slash:
        return ref[:colon], ref[colon + 1:]
    return ref, "latest"


def demux_logs(raw: bytes) -> str:
    """解析 Docker 非 TTY 日志的 8 字节帧头；TTY 日志直接解码。"""
    if not raw:
        return ""
    if raw[0] in (1, 2) and len(raw) >= 8:
        chunks: list[bytes] = []
        pos = 0
        ok = True
        while pos + 8 <= len(raw):
            length = int.from_bytes(raw[pos + 4 : pos + 8], "big")
            if length > len(raw) - pos - 8:
                ok = False
                break
            chunks.append(raw[pos + 8 : pos + 8 + length])
            pos += 8 + length
        if ok and pos == len(raw) and chunks:
            raw = b"".join(chunks)
    text = raw.decode("utf-8", "replace")
    return ANSI_RE.sub("", text)


class DockerClient:
    def __init__(
        self,
        socket_path: str = "/var/run/docker.sock",
        tcp_addr: str | None = None,
        timeout: float = 30,
    ):
        self.socket_path = socket_path
        self.tcp_addr = tcp_addr
        self.timeout = timeout

    def _connection(self, timeout: float | None = None) -> http.client.HTTPConnection:
        t = self.timeout if timeout is None else timeout
        if self.tcp_addr:
            if ":" in self.tcp_addr:
                host, port = self.tcp_addr.rsplit(":", 1)
            else:
                host, port = self.tcp_addr, "2375"
            return http.client.HTTPConnection(host, int(port), timeout=t)
        return UnixHTTPConnection(self.socket_path, timeout=t)

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        timeout: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes, dict[str, str]]:
        conn = self._connection(timeout)
        data = None
        hdrs: dict[str, str] = {
            # 公共镜像拉取时 Docker 仍要求该头，空 JSON 的 base64 即可
            "X-Registry-Auth": base64.b64encode(b"{}").decode("ascii"),
        }
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if headers:
            hdrs.update(headers)
        try:
            conn.request(method, path, body=data, headers=hdrs)
            resp = conn.getresponse()
            raw = resp.read()
            status = resp.status
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        except (OSError, http.client.HTTPException) as exc:
            raise DockerError(0, f"无法连接 Docker：{exc}") from exc
        finally:
            conn.close()
        if status >= 400:
            try:
                detail = json.loads(raw.decode("utf-8", "replace")).get("message", "")
            except Exception:
                detail = raw.decode("utf-8", "replace")[:400]
            raise DockerError(status, detail or f"HTTP {status}")
        return status, raw, resp_headers

    def json(
        self, method: str, path: str, body: Any = None, timeout: float | None = None
    ) -> Any:
        _, raw, _ = self.request(method, path, body, timeout)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8", "replace"))

    # ---------- 基础信息 ----------

    def version(self) -> dict:
        return self.json("GET", "/version", timeout=8)

    def ping(self) -> bool:
        try:
            self.request("GET", "/_ping", timeout=5)
            return True
        except DockerError:
            return False

    # ---------- 容器 ----------

    def list_containers(self, all_: bool = True) -> list[dict]:
        path = "/containers/json?all=1" if all_ else "/containers/json"
        return self.json("GET", path, timeout=15)

    def inspect_container(self, ref: str) -> dict:
        return self.json(
            "GET", f"/containers/{urllib.parse.quote(ref, safe='')}/json", timeout=15
        )

    def create_container(self, name: str, spec: dict) -> dict:
        return self.json(
            "POST",
            f"/containers/create?name={urllib.parse.quote(name, safe='')}",
            spec,
            timeout=60,
        )

    def start_container(self, ref: str) -> None:
        self.request(
            "POST", f"/containers/{urllib.parse.quote(ref, safe='')}/start", timeout=60
        )

    def stop_container(self, ref: str, seconds: int = 10) -> None:
        try:
            self.request(
                "POST",
                f"/containers/{urllib.parse.quote(ref, safe='')}/stop?t={seconds}",
                timeout=60,
            )
        except DockerError as exc:
            # 304 = 容器本来就没在运行
            if exc.status not in (304, 404):
                raise

    def restart_container(self, ref: str, seconds: int = 10) -> None:
        self.request(
            "POST",
            f"/containers/{urllib.parse.quote(ref, safe='')}/restart?t={seconds}",
            timeout=60,
        )

    def remove_container(self, ref: str, force: bool = True) -> None:
        try:
            self.request(
                "DELETE",
                f"/containers/{urllib.parse.quote(ref, safe='')}?force={1 if force else 0}&v=0",
                timeout=60,
            )
        except DockerError as exc:
            if exc.status != 404:
                raise

    def logs(self, ref: str, tail: int = 200) -> str:
        path = (
            f"/containers/{urllib.parse.quote(ref, safe='')}/logs"
            f"?stdout=1&stderr=1&tail={int(tail)}&timestamps=0"
        )
        _, raw, _ = self.request("GET", path, timeout=30)
        return demux_logs(raw)

    def stats(self, ref: str) -> dict:
        path = (
            f"/containers/{urllib.parse.quote(ref, safe='')}/stats"
            "?stream=false&one-shot=true"
        )
        return self.json("GET", path, timeout=6)

    def host_ports_in_use(self) -> set[int]:
        """列出所有容器已占用的宿主机端口，用于自动分配端口时避让。"""
        ports: set[int] = set()
        try:
            for c in self.list_containers(all_=True):
                for p in c.get("Ports") or []:
                    v = p.get("PublicPort")
                    if isinstance(v, int):
                        ports.add(v)
        except DockerError:
            pass
        return ports

    # ---------- 镜像 ----------

    def list_images(self) -> list[dict]:
        return self.json("GET", "/images/json", timeout=20)

    def image_exists(self, ref: str) -> bool:
        _, tag = split_image_ref(ref)
        try:
            for img in self.list_images():
                tags = img.get("RepoTags") or []
                if ref in tags or (":" not in ref and any(t.startswith(ref + ":") for t in tags)):
                    return True
        except DockerError:
            return False
        return False

    def pull_image(self, ref: str, timeout: float = 900) -> str:
        repo, tag = split_image_ref(ref)
        path = (
            "/images/create?fromImage=" + urllib.parse.quote(repo, safe="")
            + "&tag=" + urllib.parse.quote(tag, safe="")
        )
        _, raw, _ = self.request("POST", path, timeout=timeout)
        last = "镜像拉取完成"
        for line in raw.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if "error" in obj:
                raise DockerError(500, str(obj["error"]))
            status = obj.get("status")
            progress = obj.get("progress")
            if status:
                last = f"{status} {progress or ''}".strip()
        return last

    # ---------- 数据卷 ----------

    def create_volume(self, name: str, labels: dict[str, str] | None = None) -> None:
        try:
            self.json(
                "POST",
                "/volumes/create",
                {"Name": name, "Labels": labels or {}, "Driver": "local"},
                timeout=30,
            )
        except DockerError as exc:
            # 卷已存在不算错误（Docker 409 / 500 文案在不同版本不一致）
            if exc.status != 409 and "already exists" not in exc.message.lower():
                raise

    def remove_volume(self, name: str) -> None:
        try:
            self.request(
                "DELETE", f"/volumes/{urllib.parse.quote(name, safe='')}", timeout=30
            )
        except DockerError as exc:
            if exc.status not in (404, 409):
                raise

#!/usr/bin/env python3
"""QQ 多开挂机 · 飞牛 NAS 管理面板后端（Python 标准库，无第三方依赖）。

面板本身是一个容器，通过宿主机 Docker Socket 动态创建若干个「官方 Linux QQ
+ noVNC」容器，每个容器对应一个 QQ 账号，配置与登录态各自独立。
"""

from __future__ import annotations

import hashlib
import hmac
import http.cookies
import json
import os
import re
import secrets
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dockerapi import DockerClient, DockerError

PANEL_VERSION = "1.0.0"
LABEL_MANAGED = "qqfarm.managed"
LABEL_ACCOUNT = "qqfarm.account"
CONTAINER_PREFIX = "qqfarm-"
VOLUME_PREFIX = "qqfarm-acc-"

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
STATE_FILE = DATA_DIR / "state.json"
AUTH_FILE = DATA_DIR / "auth.json"
SESSION_FILE = DATA_DIR / "sessions.json"

def env_int(name: str, fallback: int) -> int:
    """向导变量被替换成空串时也要能启动，不能让 int('') 把面板搞崩。"""
    try:
        return int(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return fallback


PANEL_PORT = env_int("PANEL_PORT", 8787)
SESSION_TTL = 7 * 24 * 3600
PBKDF2_ROUNDS = 160_000

LOCK = threading.RLock()
STATE: dict = {}
SESSIONS: dict = {}
AUTH: dict = {}
CLIENT: DockerClient | None = None
HOST_ARCH = "amd64"
DOCKER_ERROR = ""
STATS_CACHE: dict[str, tuple[float, int]] = {}
IMAGE_CACHE: dict[str, tuple[float, bool]] = {}
LOGIN_GUARD = {"fails": 0, "until": 0.0}


# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def log(msg: str) -> None:
    print(f"[qqfarm] {msg}", file=sys.stderr, flush=True)


def atomic_write(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def default_settings() -> dict:
    return {
        "port_start": env_int("PORT_START", 5801),
        "port_end": env_int("PORT_END", 5899),
        "default_image": os.environ.get("DEFAULT_IMAGE", ""),  # 空 = 按架构自动选择
        "default_memory_mb": env_int("DEFAULT_MEMORY_MB", 1536),
        "shm_mb": env_int("SHM_MB", 1024),
        "timezone": os.environ.get("TZ") or "Asia/Shanghai",
        "auto_restart": True,
        "keep_app_running": True,
        "enable_taskbar": False,
    }


def default_state() -> dict:
    return {"version": 1, "accounts": [], "settings": default_settings()}


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def init_storage() -> None:
    global STATE, AUTH, SESSIONS
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_json(STATE_FILE, None)
    if not isinstance(state, dict):
        state = default_state()
    state.setdefault("version", 1)
    state.setdefault("accounts", [])
    settings = default_settings()
    settings.update(state.get("settings") or {})
    state["settings"] = settings
    STATE = state
    AUTH = load_json(AUTH_FILE, {}) or {}
    raw_sessions = load_json(SESSION_FILE, {}) or {}
    cutoff = time.time()
    SESSIONS = {
        k: v for k, v in raw_sessions.items() if isinstance(v, (int, float)) and v > cutoff
    }


def save_state() -> None:
    with LOCK:
        atomic_write(STATE_FILE, STATE)


def save_sessions() -> None:
    with LOCK:
        atomic_write(SESSION_FILE, SESSIONS)


def auto_image() -> str:
    suffix = "arm64" if HOST_ARCH in ("arm64", "aarch64") else "amd64"
    return f"libzonda/linux-qq-release:latest-{suffix}"


def effective_image(account: dict | None = None) -> str:
    if account and account.get("image"):
        return account["image"]
    configured = STATE["settings"].get("default_image") or ""
    return configured.strip() or auto_image()


def new_account_id() -> str:
    existing = {a["id"] for a in STATE["accounts"]}
    while True:
        value = secrets.token_hex(4)
        if value not in existing:
            return value


def clean_int(value, lo: int, hi: int, fallback: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, n))


def clean_str(value, max_len: int = 128) -> str:
    return str(value or "").strip()[:max_len]


def password_hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS
    ).hex()


def set_password(password: str) -> None:
    global AUTH
    salt = secrets.token_hex(16)
    AUTH = {"salt": salt, "hash": password_hash(password, salt), "rounds": PBKDF2_ROUNDS}
    atomic_write(AUTH_FILE, AUTH)


def verify_password(password: str) -> bool:
    if not AUTH.get("salt") or not AUTH.get("hash"):
        return False
    try:
        candidate = password_hash(password, AUTH["salt"])
    except Exception:
        return False
    return hmac.compare_digest(candidate, str(AUTH["hash"]))


def auth_configured() -> bool:
    return bool(AUTH.get("salt") and AUTH.get("hash"))


def issue_session() -> str:
    token = secrets.token_urlsafe(32)
    with LOCK:
        SESSIONS[token] = time.time() + SESSION_TTL
        save_sessions()
    return token


def session_valid(token: str) -> bool:
    if not token:
        return False
    with LOCK:
        expiry = SESSIONS.get(token)
        if not expiry or expiry < time.time():
            SESSIONS.pop(token, None)
            return False
    return True


def drop_session(token: str) -> None:
    with LOCK:
        SESSIONS.pop(token, None)
        save_sessions()


def invalidate_sessions(keep: str | None = None) -> None:
    global SESSIONS
    with LOCK:
        SESSIONS = {keep: SESSIONS[keep]} if keep and keep in SESSIONS else {}
        save_sessions()


# --------------------------------------------------------------------------
# Docker 操作
# --------------------------------------------------------------------------

def init_docker() -> None:
    global CLIENT, HOST_ARCH, DOCKER_ERROR
    tcp = os.environ.get("DOCKER_TCP", "").strip()
    CLIENT = DockerClient(
        socket_path=os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock"),
        tcp_addr=tcp or None,
    )
    try:
        info = CLIENT.version()
        HOST_ARCH = str(info.get("Arch") or info.get("Architecture") or "amd64").lower()
        DOCKER_ERROR = ""
        log(f"Docker {info.get('Version', '?')} / arch={HOST_ARCH} 已连接，镜像={auto_image()}")
    except Exception as exc:
        DOCKER_ERROR = str(exc)
        log(f"Docker 连接失败：{exc}")


def require_docker() -> DockerClient:
    if CLIENT is None:
        raise RuntimeError("Docker 客户端未初始化")
    if DOCKER_ERROR:
        raise RuntimeError(f"Docker 不可用：{DOCKER_ERROR}。请确认已挂载 /var/run/docker.sock")
    return CLIENT


def container_name(acc: dict) -> str:
    return f"{CONTAINER_PREFIX}{acc['id']}"


def volume_name(acc: dict) -> str:
    return f"{VOLUME_PREFIX}{acc['id']}-config"


def build_spec(acc: dict) -> dict:
    settings = STATE["settings"]
    mem = clean_int(acc.get("memory_mb"), 256, 16384, 1536)
    shm = clean_int(settings.get("shm_mb"), 64, 4096, 1024)
    port = int(acc["port"])
    env = [
        f"TZ={settings.get('timezone') or 'Asia/Shanghai'}",
        "QQ_INSTANCE_COUNT=1",
        f"KEEP_APP_RUNNING={1 if settings.get('keep_app_running', True) else 0}",
        f"VNC_PASSWORD={acc['vnc_password']}",
        "ENABLE_CJK_FONT=1",
        f"ENABLE_TASKBAR={1 if settings.get('enable_taskbar') else 0}",
    ]
    return {
        "Image": effective_image(acc),
        "Hostname": container_name(acc),
        "Env": env,
        "ExposedPorts": {"5800/tcp": {}},
        "HostConfig": {
            "PortBindings": {
                "5800/tcp": [{"HostIp": "0.0.0.0", "HostPort": str(port)}]
            },
            "Binds": [f"{volume_name(acc)}:/config"],
            "ShmSize": shm * 1024 * 1024,
            "Memory": mem * 1024 * 1024,
            "RestartPolicy": {
                "Name": "unless-stopped" if settings.get("auto_restart", True) else "no"
            },
            "LogConfig": {
                "Type": "json-file",
                "Config": {"max-size": "10m", "max-file": "3"},
            },
        },
        "Labels": {
            LABEL_MANAGED: "1",
            LABEL_ACCOUNT: acc["id"],
            "qqfarm.role": "qq",
            "qqfarm.name": acc.get("name", ""),
        },
        "Tty": False,
        "OpenStdin": False,
        "AttachStdin": False,
    }


def find_container(client: DockerClient, acc_id: str) -> dict | None:
    for c in client.list_containers(all_=True):
        if (c.get("Labels") or {}).get(LABEL_ACCOUNT) == acc_id:
            return c
    return None


def allocate_port(client: DockerClient, requested=None) -> int:
    settings = STATE["settings"]
    start = clean_int(settings.get("port_start"), 1, 65535, 5801)
    end = clean_int(settings.get("port_end"), start, 65535, 5899)
    used_state = {int(a["port"]) for a in STATE["accounts"]}
    used_docker = client.host_ports_in_use()
    if requested not in (None, "", 0):
        port = clean_int(requested, 1, 65535, 0)
        if not port:
            raise ValueError("端口必须是 1-65535 的数字")
        if port in used_state or port in used_docker:
            raise ValueError(f"端口 {port} 已被占用，请换一个")
        return port
    for port in range(start, end + 1):
        if port not in used_state and port not in used_docker:
            return port
    raise ValueError(f"{start}-{end} 范围内没有可用端口，请到「设置」里扩大端口范围")


def provision(acc: dict, client: DockerClient) -> None:
    """创建数据卷 + 容器 + 启动。失败时回滚容器，数据卷保留以便重试。"""
    client.create_volume(
        volume_name(acc),
        {LABEL_MANAGED: "1", LABEL_ACCOUNT: acc["id"]},
    )
    created = False
    try:
        spec = build_spec(acc)
        try:
            client.create_container(container_name(acc), spec)
        except DockerError as exc:
            # 部分 NAS 内核没开 memory cgroup / swap accounting，去掉内存限制再试一次
            msg = exc.message.lower()
            if "memory" in msg or "cgroup" in msg:
                spec["HostConfig"].pop("Memory", None)
                client.create_container(container_name(acc), spec)
                log(f"内核不支持内存限制，容器 {container_name(acc)} 已降级为不限内存")
            else:
                raise
        created = True
        client.start_container(container_name(acc))
    except Exception:
        if created:
            try:
                client.remove_container(container_name(acc))
            except Exception:
                pass
        raise


def recreate(acc: dict, client: DockerClient) -> None:
    name = container_name(acc)
    try:
        client.remove_container(name)
    except DockerError:
        pass
    provision(acc, client)


def image_present(ref: str) -> bool:
    cached = IMAGE_CACHE.get(ref)
    if cached and time.time() - cached[0] < 30:
        return cached[1]
    try:
        present = require_docker().image_exists(ref)
    except Exception:
        present = False
    IMAGE_CACHE[ref] = (time.time(), present)
    return present


def account_views(client: DockerClient | None) -> list[dict]:
    by_id: dict[str, dict] = {}
    if client:
        try:
            for c in client.list_containers(all_=True):
                aid = (c.get("Labels") or {}).get(LABEL_ACCOUNT)
                if aid:
                    by_id[aid] = c
        except Exception as exc:
            log(f"列出容器失败：{exc}")
    views = []
    for acc in STATE["accounts"]:
        c = by_id.get(acc["id"])
        status = (c or {}).get("State") or "missing"
        item = dict(acc)
        item.update(
            {
                "container": container_name(acc),
                "volume": volume_name(acc),
                "image_resolved": effective_image(acc),
                "status": status,
                "exists": c is not None,
                "docker_status": (c or {}).get("Status", ""),
                "mem_used_mb": None,
            }
        )
        if c and status == "running" and client:
            cid = c.get("Id", "")
            hit = STATS_CACHE.get(cid)
            if hit and time.time() - hit[0] < 20:
                item["mem_used_mb"] = hit[1]
            elif len(STATE["accounts"]) <= 12:
                try:
                    st = client.stats(cid)
                    used = int((st.get("memory_stats") or {}).get("usage") or 0)
                    STATS_CACHE[cid] = (time.time(), used // (1024 * 1024))
                    item["mem_used_mb"] = used // (1024 * 1024)
                except Exception:
                    pass
        views.append(item)
    return views


def make_state_payload() -> dict:
    client = CLIENT if not DOCKER_ERROR else None
    views = account_views(client)
    running = sum(1 for v in views if v["status"] == "running")
    ref = effective_image()
    return {
        "ok": True,
        "panel_version": PANEL_VERSION,
        "accounts": views,
        "settings": STATE["settings"],
        "summary": {
            "total": len(views),
            "running": running,
            "stopped": sum(1 for v in views if v["exists"] and v["status"] != "running"),
            "missing": sum(1 for v in views if not v["exists"]),
        },
        "docker": {
            "ok": not DOCKER_ERROR,
            "error": DOCKER_ERROR,
            "arch": HOST_ARCH,
            "auto_image": auto_image(),
        },
        "image": {"ref": ref, "present": image_present(ref)},
    }


# --------------------------------------------------------------------------
# 业务动作
# --------------------------------------------------------------------------

def create_account(data: dict) -> dict:
    client = require_docker()
    name = clean_str(data.get("name"), 40)
    if not name:
        raise ValueError("请填写账号名称")
    with LOCK:
        port = allocate_port(client, data.get("port"))
        acc = {
            "id": new_account_id(),
            "name": name,
            "qq": clean_str(data.get("qq"), 20),
            "note": clean_str(data.get("note"), 200),
            "port": port,
            "vnc_password": clean_str(data.get("vnc_password"), 64)
            or secrets.token_hex(6),
            "image": clean_str(data.get("image"), 200),
            "memory_mb": clean_int(
                data.get("memory_mb"), 256, 16384,
                STATE["settings"].get("default_memory_mb", 1536),
            ),
            "created": now_iso(),
        }
        if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", acc["vnc_password"]):
            raise ValueError("VNC 密码只能用字母、数字、下划线和短横线，长度 4-64")
        try:
            provision(acc, client)
        except DockerError as exc:
            if exc.status == 404 and not client.image_exists(effective_image(acc)):
                raise RuntimeError(
                    f"镜像 {effective_image(acc)} 不存在，请先在「镜像」处拉取镜像"
                ) from exc
            raise RuntimeError(f"创建容器失败：{exc.message}") from exc
        except Exception as exc:
            raise RuntimeError(f"创建容器失败：{exc}") from exc
        STATE["accounts"].append(acc)
        save_state()
    return acc


def get_account(acc_id: str) -> dict:
    for acc in STATE["accounts"]:
        if acc["id"] == acc_id:
            return acc
    raise KeyError("账号不存在")


def action_account(acc_id: str, action: str, data: dict | None = None) -> str:
    client = require_docker()
    acc = get_account(acc_id)
    name = container_name(acc)
    if action == "start":
        if not find_container(client, acc_id):
            recreate(acc, client)
            return "容器已重建并启动"
        client.start_container(name)
        return "已启动"
    if action == "stop":
        client.stop_container(name)
        return "已停止"
    if action == "restart":
        if not find_container(client, acc_id):
            recreate(acc, client)
            return "容器已重建并启动"
        client.restart_container(name)
        return "已重启"
    if action == "recreate":
        recreate(acc, client)
        return "已重建容器（登录态保留）"
    if action == "update":
        payload = data or {}
        with LOCK:
            if "name" in payload:
                acc["name"] = clean_str(payload["name"], 40) or acc["name"]
            for key in ("qq", "note"):
                if key in payload:
                    acc[key] = clean_str(payload[key], 200 if key == "note" else 20)
            if "vnc_password" in payload and clean_str(payload["vnc_password"]):
                pw = clean_str(payload["vnc_password"], 64)
                if not re.fullmatch(r"[A-Za-z0-9_\-]{4,64}", pw):
                    raise ValueError("VNC 密码只能用字母、数字、下划线和短横线")
                acc["vnc_password"] = pw
            if "image" in payload:
                acc["image"] = clean_str(payload["image"], 200)
            if "memory_mb" in payload:
                acc["memory_mb"] = clean_int(payload["memory_mb"], 256, 16384, acc["memory_mb"])
            if "port" in payload and clean_int(payload["port"], 0, 65535, 0):
                new_port = clean_int(payload["port"], 1, 65535, acc["port"])
                if new_port != acc["port"]:
                    used = {int(a["port"]) for a in STATE["accounts"] if a["id"] != acc_id}
                    if new_port in used or new_port in client.host_ports_in_use():
                        raise ValueError(f"端口 {new_port} 已被占用")
                    acc["port"] = new_port
            save_state()
        recreate(acc, client)
        return "配置已保存并重建容器"
    raise ValueError(f"未知操作：{action}")


def delete_account(acc_id: str, purge: bool) -> str:
    client = require_docker()
    acc = get_account(acc_id)
    try:
        client.remove_container(container_name(acc))
    except DockerError as exc:
        if exc.status != 404:
            raise RuntimeError(f"删除容器失败：{exc.message}") from exc
    if purge:
        try:
            client.remove_volume(volume_name(acc))
        except DockerError as exc:
            log(f"删除数据卷失败（可忽略）：{exc}")
    with LOCK:
        STATE["accounts"] = [a for a in STATE["accounts"] if a["id"] != acc_id]
        save_state()
    return "已删除账号" + ("及登录数据" if purge else "（登录数据已保留）")


def update_settings(data: dict) -> dict:
    s = STATE["settings"]
    with LOCK:
        s["port_start"] = clean_int(data.get("port_start"), 1, 65535, s["port_start"])
        s["port_end"] = clean_int(data.get("port_end"), s["port_start"], 65535, s["port_end"])
        s["default_image"] = clean_str(data.get("default_image"), 200)
        s["default_memory_mb"] = clean_int(
            data.get("default_memory_mb"), 256, 16384, s["default_memory_mb"]
        )
        s["shm_mb"] = clean_int(data.get("shm_mb"), 64, 4096, s["shm_mb"])
        s["timezone"] = clean_str(data.get("timezone"), 64) or s["timezone"]
        for key in ("auto_restart", "keep_app_running", "enable_taskbar"):
            if key in data:
                s[key] = bool(data[key])
        save_state()
    return s


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "QQFarmPanel/1.0"

    def log_message(self, fmt, *args):
        # 只记录非 2xx，避免轮询把日志刷爆
        try:
            code = int(args[1]) if len(args) > 1 else 0
        except Exception:
            code = 0
        if code >= 400:
            log("%s - %s" % (self.address_string(), fmt % args))

    # ---------- 底层响应 ----------

    def _send(self, status: int, body: bytes, ctype: str, headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store" if ctype.startswith("application/json") else "no-cache")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: dict, headers: dict | None = None):
        self._send(
            status,
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
            headers,
        )

    def _ok(self, data: dict | None = None, message: str = ""):
        obj = {"ok": True}
        if message:
            obj["message"] = message
        if data:
            obj.update(data)
        self._json(200, obj)

    def _fail(self, status: int, message: str):
        self._json(status, {"ok": False, "error": message})

    def _body(self) -> dict:
        raw = getattr(self, "_raw_body", b"")
        if not raw:
            return {}
        try:
            obj = json.loads(raw.decode("utf-8"))
            return obj if isinstance(obj, dict) else {}
        except Exception:
            raise ValueError("请求体不是合法的 JSON")

    def _cookie_token(self) -> str:
        raw = self.headers.get("Cookie", "")
        try:
            jar = http.cookies.SimpleCookie()
            jar.load(raw)
            morsel = jar.get("qqfarm_sid")
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def _session_cookie(self, token: str, max_age: int = SESSION_TTL) -> str:
        return (
            f"qqfarm_sid={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        )

    def _csrf_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            o = urllib.parse.urlparse(origin)
            host = (self.headers.get("Host") or "").split(":")[0]
            return not o.hostname or o.hostname == host
        except Exception:
            return False

    def _authed(self) -> bool:
        return auth_configured() and session_valid(self._cookie_token())

    # ---------- 路由 ----------

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)
        # 必须先完整读走请求体，否则 HTTP/1.1 keep-alive 下残留字节会被当成下一条请求
        self._raw_body = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self._raw_body = self.rfile.read(min(length, 1_000_000))
        try:
            if method == "GET" and path in ("/", "/index.html"):
                return self._static("index.html")
            if method == "GET" and path.startswith("/static/"):
                name = path[len("/static/") :]
                if name not in CONTENT_TYPES or "/" in name or ".." in name:
                    return self._fail(404, "资源不存在")
                return self._static(name)
            if method == "GET" and path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")

            if not path.startswith("/api/"):
                return self._fail(404, "资源不存在")
            if method in ("POST", "DELETE") and not self._csrf_ok():
                return self._fail(403, "跨站请求被拒绝")

            return self._api(method, path, query)
        except (ValueError, KeyError) as exc:
            self._fail(400, str(exc))
        except DockerError as exc:
            self._fail(502, exc.message)
        except RuntimeError as exc:
            self._fail(503, str(exc))
        except Exception as exc:
            log("未处理异常：\n" + traceback.format_exc())
            self._fail(500, f"服务器内部错误：{exc}")

    def _static(self, name: str):
        file = STATIC_DIR / name
        if not file.is_file():
            return self._fail(404, "页面文件缺失，请检查 panel/static 是否随应用一起安装")
        self._send(200, file.read_bytes(), CONTENT_TYPES[name])

    def _api(self, method: str, path: str, query: dict):
        # ---- 公开接口 ----
        if method == "GET" and path == "/api/bootstrap":
            return self._ok(
                {
                    "configured": auth_configured(),
                    "docker_ok": not DOCKER_ERROR,
                    "docker_error": DOCKER_ERROR,
                    "arch": HOST_ARCH,
                    "version": PANEL_VERSION,
                }
            )

        if method == "POST" and path == "/api/setup":
            if auth_configured():
                return self._fail(409, "管理密码已设置，请直接登录")
            pw = str(self._body().get("password") or "")
            if len(pw) < 8:
                return self._fail(400, "管理密码至少 8 位")
            set_password(pw)
            token = issue_session()
            return self._json(
                200,
                {"ok": True, "message": "初始化完成"},
                {"Set-Cookie": self._session_cookie(token)},
            )

        if method == "POST" and path == "/api/login":
            if not auth_configured():
                return self._fail(400, "尚未初始化，请先设置管理密码")
            now = time.time()
            if LOGIN_GUARD["until"] > now:
                return self._fail(429, "尝试过于频繁，请稍后再试")
            pw = str(self._body().get("password") or "")
            if not verify_password(pw):
                LOGIN_GUARD["fails"] += 1
                if LOGIN_GUARD["fails"] >= 5:
                    LOGIN_GUARD["until"] = now + 60
                    LOGIN_GUARD["fails"] = 0
                return self._fail(401, "管理密码错误")
            LOGIN_GUARD["fails"] = 0
            token = issue_session()
            return self._json(
                200,
                {"ok": True},
                {"Set-Cookie": self._session_cookie(token)},
            )

        # ---- 以下接口均需登录 ----
        if not self._authed():
            return self._fail(401, "未登录或登录已过期")

        if method == "POST" and path == "/api/logout":
            drop_session(self._cookie_token())
            return self._json(
                200,
                {"ok": True},
                {"Set-Cookie": self._session_cookie("", 0)},
            )

        if method == "POST" and path == "/api/password":
            body = self._body()
            if not verify_password(str(body.get("old") or "")):
                return self._fail(400, "原密码不正确")
            new = str(body.get("new") or "")
            if len(new) < 8:
                return self._fail(400, "新密码至少 8 位")
            set_password(new)
            invalidate_sessions(self._cookie_token())
            return self._ok(message="管理密码已更新")

        if method == "GET" and path == "/api/state":
            return self._ok(make_state_payload())

        if method == "GET" and path == "/api/export":
            payload = json.dumps(STATE, ensure_ascii=False, indent=2).encode("utf-8")
            return self._send(
                200,
                payload,
                "application/json; charset=utf-8",
                {"Content-Disposition": 'attachment; filename="qqfarm-state.json"'},
            )

        if method == "GET" and path == "/api/settings":
            return self._ok({"settings": STATE["settings"]})

        if method == "POST" and path == "/api/settings":
            return self._ok({"settings": update_settings(self._body())}, "设置已保存")

        if method == "POST" and path == "/api/image/pull":
            body = self._body()
            ref = clean_str(body.get("ref"), 200) or effective_image()
            client = require_docker()
            message = client.pull_image(ref)
            IMAGE_CACHE.pop(ref, None)
            return self._ok({"ref": ref}, f"{ref}：{message}")

        if method == "POST" and path == "/api/accounts":
            acc = create_account(self._body())
            return self._ok({"account": acc}, f"账号「{acc['name']}」已创建")

        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)/logs", path)
        if method == "GET" and m:
            client = require_docker()
            acc = get_account(m.group(1))
            if not find_container(client, acc["id"]):
                return self._ok({"logs": "容器不存在，请先「重建容器」"})
            tail = clean_int((query.get("tail") or ["200"])[0], 10, 2000, 200)
            return self._ok({"logs": client.logs(container_name(acc), tail)})

        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)/([a-z]+)", path)
        if method == "POST" and m:
            message = action_account(m.group(1), m.group(2), self._body())
            return self._ok(message=message)

        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)", path)
        if method == "DELETE" and m:
            purge = (query.get("purge") or ["0"])[0] in ("1", "true", "yes")
            return self._ok(message=delete_account(m.group(1), purge))

        return self._fail(404, "接口不存在")


def run(host: str = "0.0.0.0", port: int | None = None):
    init_storage()
    init_docker()
    port = PANEL_PORT if port is None else port
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    log(f"管理面板已监听 {host}:{port}")
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run()

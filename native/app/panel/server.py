#!/usr/bin/env python3
"""QQ 多开挂机（原生版）· 管理面板后端。
纯 Python 标准库，由飞牛商店的 Python 3.12 运行时（或系统 python3）执行。
- 通过 procman 管理每个账号的 Xvfb / x11vnc / 官方 QQ 原生进程组
- 通过 wsproxy 把 noVNC 的 WebSocket 转发到 x11vnc
- 所有账号共用一个面板端口，桌面入口是 /desktop/<id>/
"""
from __future__ import annotations
import hashlib
import hmac
import http.cookies
import json
import os
import re
import secrets
import shutil
import signal
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import procman
import wsproxy
import setup_runtime
PANEL_VERSION = "2.3.0-native"
# 应用包版本（manifest 的 version）：优先读随包 manifest（cmd/main 注入
# QQFARM_MANIFEST），本地开发 / 读不到时用内置兜底值，与 manifest 保持同步。
APP_VERSION_FALLBACK = "1.0.14"
# 默认更新源：GitHub Releases 的 latest 接口（返回 JSON：tag_name/body/html_url/assets）。
# 面板「设置 → 版本与更新」里可改。仓库改名后 GitHub 会对旧地址自动重定向。
DEFAULT_UPDATE_URL = "https://api.github.com/repos/qianliaa/qq-farm/releases/latest"
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = Path(os.environ.get("QQFARM_STATIC_DIR", str(BASE_DIR / "static")))
DATA_DIR = Path(os.environ.get("QQFARM_DATA_DIR", str(BASE_DIR / "data")))
# 运行时目录（QQ 客户端 / Xvfb / VNC / noVNC / deb 依赖库 / setup-status.json）
# 必须落在持久化的数据目录里。1.0.13 及之前放在 ${APPDEST}/runtime（安装目录），
# 每次升级 fpk 覆盖安装目录都会把它整体清空 —— 用户看到的就是「每次更新完都
# 提示图形栈未就绪、缺少 qq」，得重新下载一遍上百 MB 的客户端。
# 数据目录与账号数据同级（@appshare 共享目录），升级不会丢。
LEGACY_RUNTIME_DIR = BASE_DIR.parent / "runtime"
RUNTIME_DIR = Path(os.environ.get("QQFARM_RUNTIME_DIR") or str(DATA_DIR / "runtime"))
PANEL_PORT = 8788
try:
    PANEL_PORT = int(os.environ.get("QQFARM_PORT", "8788"))
except ValueError:
    pass
# 统一网关前缀：安装到飞牛 fnOS 后由 cmd/main 注入（如 /app/qqfarm-native）。
# 本地开发时为空，所有路由直接挂在根路径下。
GATEWAY_PREFIX = (os.environ.get("GATEWAY_PREFIX") or "").rstrip("/")
# Unix Socket 路径：非空时面板监听该 socket（飞牛统一网关经此转发），否则监听 TCP 端口。
SOCKET_PATH = os.environ.get("SOCKET_PATH") or ""
STATE_FILE = DATA_DIR / "state.json"
AUTH_FILE = DATA_DIR / "auth.json"
SESSION_FILE = DATA_DIR / "sessions.json"
SESSION_TTL = 7 * 24 * 3600
PBKDF2_ROUNDS = 160_000
LOCK = threading.RLock()
STATE: dict = {}
AUTH: dict = {}
SESSIONS: dict = {}
PM: procman.ProcessManager | None = None
LOGIN_GUARD = {"fails": 0, "until": 0.0}
BOOT_ERROR = ""
INSTALL = {"running": False, "lines": [], "started": "", "finished": False}
INSTALL_LOCK = threading.Lock()
MIME = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}
PANEL_FILES = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
}
def log(msg: str) -> None:
    # 日志写失败绝不能影响主流程：stderr 管道被关闭/断开时 print 可能抛出，
    # 一旦传播会打断 send_response，进而让整个响应失败。此处全部吞掉。
    try:
        print(f"[qqfarm-native] {msg}", file=sys.stderr, flush=True)
    except Exception:
        pass
def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
# --------------------------------------------------------------------------
# 版本与更新
# --------------------------------------------------------------------------
def app_version() -> str:
    """当前应用包版本：读随包 manifest（cmd/main 注入 QQFARM_MANIFEST），失败用内置值。"""
    path = os.environ.get("QQFARM_MANIFEST") or ""
    if path:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^version\s*=\s*(\S+)", text, re.M)
            if m:
                return m.group(1).strip()
        except OSError:
            pass
    return APP_VERSION_FALLBACK
def parse_version(value) -> tuple:
    """把 'v1.0.13' / '1.0.13-beta' 解析成 (1, 0, 13) 用于比较。"""
    nums = re.findall(r"\d+", str(value or ""))
    try:
        return tuple(int(n) for n in nums[:3]) or (0,)
    except ValueError:
        return (0,)
def check_update(source_url: str) -> dict:
    """拉取更新源（GitHub Releases latest JSON），与当前版本比较。

    返回：current / latest / has_update / changelog / release_url / download / error。
    网络不通或格式不对只返回 error 字段，绝不抛异常——检测更新失败不影响面板。
    """
    result = {"current": app_version(), "checked_at": now_iso()}
    url = (source_url or "").strip()
    if not url:
        return {**result, "error": "未配置更新源地址"}
    if not url.startswith(("http://", "https://")):
        return {**result, "error": "更新源地址必须是 http(s) 链接"}
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "qqfarm-native/" + result["current"],
            "Accept": "application/vnd.github+json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        return {**result, "error": f"无法访问更新源：{exc}"}
    latest = str(data.get("tag_name") or data.get("name") or "").strip().lstrip("vV")
    result["latest"] = latest
    result["has_update"] = parse_version(latest) > parse_version(result["current"])
    result["changelog"] = str(data.get("body") or "")[:4000]
    result["release_url"] = str(data.get("html_url") or "")
    download = None
    for asset in data.get("assets") or []:
        if isinstance(asset, dict) and str(asset.get("name") or "").endswith(".fpk"):
            download = {
                "name": str(asset.get("name") or ""),
                "url": str(asset.get("browser_download_url") or ""),
                "size": int(asset.get("size") or 0),
            }
            break
    if download is None and result["release_url"]:
        # 没挂 fpk 附件时退而求其次给发布页链接
        download = {"name": "", "url": result["release_url"], "size": 0}
    result["download"] = download
    return result
def atomic_write(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback
def default_settings() -> dict:
    return {
        # 分辨率降到 1024x768 是安全的省资源项（像素量比 1280x800 少 23%），
        # QQ 登录窗口与二维码完全放得下，设置里可随时改回。
        "resolution": os.environ.get("QQFARM_RESOLUTION") or "1024x768",
        # 色深必须默认 24：Chromium/Electron 在 X11 上需要 24/32 位 TrueColor
        # visual，Xvfb 用 16 位时 QQ 会直接退出（1.0.10 的教训）。16 位仍可在
        # 设置里手动选，但标签已注明「部分环境 QQ 起不来」。
        "depth": 24,
        "autostart": str(os.environ.get("QQFARM_AUTOSTART", "true")).lower() in ("1", "true", "yes"),
        "watchdog": True,
        # 默认 30s：挂机场景不需要秒级探活，减少无谓轮询与日志写入；
        # 面板「设置」里仍可自行调回 5~120 秒。
        "watchdog_interval": 30,
        # 「检测更新」的更新源：默认指向 GitHub Releases（qianliaa/qq-farm）。
        # 改成任何返回同结构 JSON 的地址均可；留空则禁用检测更新。
        "update_url": DEFAULT_UPDATE_URL,
    }
def default_state() -> dict:
    return {"version": 2, "accounts": [], "settings": default_settings()}
def _dir_has_files(path: Path) -> bool:
    try:
        return path.is_dir() and any(path.iterdir())
    except OSError:
        return False
def migrate_runtime() -> None:
    """把旧位置（安装目录 runtime）的运行时搬进数据目录（一次性）。

    RUNTIME_DIR 从 1.0.14 起改到数据目录；升级时若旧位置侥幸还在（安装器没清），
    直接搬走，用户就不必重新下载 QQ 客户端。搬完旧目录留下空壳也无所谓。
    """
    if RUNTIME_DIR == LEGACY_RUNTIME_DIR:
        return
    if _dir_has_files(RUNTIME_DIR):
        return  # 新位置已有内容，不覆盖
    if not _dir_has_files(LEGACY_RUNTIME_DIR):
        return
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        entries = list(LEGACY_RUNTIME_DIR.iterdir())
    except OSError as exc:
        log(f"读取旧运行时目录失败：{exc}")
        return
    moved = 0
    for item in entries:
        target = RUNTIME_DIR / item.name
        if target.exists():
            continue
        try:
            shutil.move(str(item), str(target))
            moved += 1
        except Exception as exc:
            log(f"迁移运行时 {item.name} 失败：{exc}")
    if moved:
        log(f"已把安装目录里的运行时迁移到数据目录（{moved} 项），以后升级不会再丢")
def runtime_cache_available() -> bool:
    """本地是否留着上次准备运行时的下载缓存。

    升级覆盖安装目录会把 runtime 清空，但 data/downloads（novnc.tar.gz、qq.deb、
    debs/）是持久的，有缓存就能只解包、不重新下载，几秒到几十秒即可恢复。
    """
    cache = DATA_DIR / "downloads"
    try:
        if cache.is_dir() and any(cache.iterdir()):
            return True
    except OSError:
        pass
    return (DATA_DIR / "runtime-setup.log").is_file()
def auto_restore_runtime() -> bool:
    """运行时缺失但本地有缓存时，后台自动重跑环境准备。

    升级后打开面板不再需要手动点「立即准备」；装过的号在准备完成后会自动拉起。
    """
    if PM is None or INSTALL["running"]:
        return False
    try:
        if PM.preflight()["ready"]:
            return False
    except Exception:
        return False
    if not runtime_cache_available():
        return False
    log("运行时缺失但本地有下载缓存，后台自动恢复（无需重新下载）")
    try:
        start_runtime_install({})
    except Exception as exc:
        log(f"自动恢复运行时失败：{exc}")
        return False
    return True
def init_storage() -> None:
    global STATE, AUTH, SESSIONS
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_json(STATE_FILE, None)
    if not isinstance(state, dict):
        state = default_state()
    state.setdefault("version", 2)
    state.setdefault("accounts", [])
    settings = default_settings()
    saved = state.get("settings") or {}
    settings.update(saved)
    # 1.0.10 曾把老配置一次性迁到「1280x800→1024x768 + 16 位色深」，但 16 位
    # 没有 24/32 位 TrueColor visual，Chromium/Electron 会直接退出（真机表现为
    # 账号「进程异常」）。这里把「自动迁移来的 16 位」回退成 24 位；
    # 用户自己在设置里选过 16 位（depth_user_set）则一律尊重，不再改动。
    if "depth" not in saved:
        settings["depth"] = 24
    elif int(saved.get("depth") or 24) == 16 and not saved.get("depth_user_set"):
        settings["depth"] = 24
        settings["depth_autoreverted"] = True
        log("检测到 16 位色深（旧版自动迁移），已回退为 24 位："
            "Chromium 需要 24/32 位 TrueColor visual，16 位会让 QQ 启动即退出")
    state["settings"] = settings
    STATE = state
    AUTH = load_json(AUTH_FILE, {}) or {}
    raw = load_json(SESSION_FILE, {}) or {}
    cutoff = time.time()
    SESSIONS = {k: v for k, v in raw.items() if isinstance(v, (int, float)) and v > cutoff}
def save_state() -> None:
    with LOCK:
        atomic_write(STATE_FILE, STATE)
def save_sessions() -> None:
    with LOCK:
        atomic_write(SESSION_FILE, SESSIONS)
def init_process_manager() -> None:
    global PM, BOOT_ERROR
    try:
        PM = procman.ProcessManager(DATA_DIR, RUNTIME_DIR, lambda: STATE["settings"],
                                    logger=log, settings_writer=save_state)
        pre = PM.preflight()
        log(f"图形栈自检：mode={pre['mode']} ready={pre['ready']} missing={pre['missing']}")
        # 注意：图形栈缺件不是「启动错误」——前端已有 runtime banner 实时展示
        # runtime.ready / runtime.missing，且用户跑完「环境准备」后会变成就绪。
        # 以前这里把它写进 BOOT_ERROR（启动快照），导致补齐后红框仍永久常驻。
        if pre["missing"]:
            log(f"图形栈尚未就绪（{', '.join(pre['missing'])}），等待环境准备；面板其余功能不受影响")
    except Exception as exc:
        BOOT_ERROR = f"进程管理器初始化失败：{exc}"
        log(BOOT_ERROR + "\n" + traceback.format_exc())
# --------------------------------------------------------------------------
# 鉴权（与 Docker 版一致：PBKDF2 + 会话 Cookie）
# --------------------------------------------------------------------------
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
        return hmac.compare_digest(password_hash(password, AUTH["salt"]), str(AUTH["hash"]))
    except Exception:
        return False
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
# 业务
# --------------------------------------------------------------------------
def require_pm() -> procman.ProcessManager:
    if PM is None:
        raise RuntimeError(BOOT_ERROR or "进程管理器未就绪")
    return PM
def get_account(acc_id: str) -> dict:
    for acc in STATE["accounts"]:
        if acc["id"] == acc_id:
            return acc
    raise KeyError("账号不存在")
def new_id() -> str:
    used = {a["id"] for a in STATE["accounts"]}
    while True:
        value = secrets.token_hex(4)
        if value not in used:
            return value
def clean_str(value, max_len: int = 128) -> str:
    return str(value or "").strip()[:max_len]
def clean_int(value, lo: int, hi: int, fallback: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, n))
def account_views() -> list[dict]:
    # PM 未初始化时不要抛异常，否则 /api/state 直接 500，前端连真正的
    # 致命错误（error 字段）都拿不到，只会显示一片空白。
    if PM is None:
        return []
    pm = require_pm()
    views = []
    for acc in STATE["accounts"]:
        st = pm.status(acc)
        item = dict(acc)
        item.update(st)
        item["desktop_path"] = f"/desktop/{acc['id']}/"
        views.append(item)
    return views
def make_state_payload() -> dict:
    views = account_views()
    running = sum(1 for v in views if v["status"] == "running")
    partial = sum(1 for v in views if v["status"] == "partial")
    pre = PM.preflight() if PM else {"ready": False, "missing": ["*"], "mode": "unknown", "bins": {}}
    return {
        "ok": True,
        "panel_version": PANEL_VERSION,
        "app_version": app_version(),
        "accounts": views,
        "settings": STATE["settings"],
        "summary": {
            "total": len(views),
            "running": running,
            "stopped": len(views) - running - partial,
            "missing": partial,
        },
        "runtime": {
            "ready": pre["ready"],
            "mode": pre["mode"],
            "missing": pre["missing"],
            "bins": pre["bins"],
            "novnc": (RUNTIME_DIR / "novnc/core/rfb.js").is_file(),
            "runtime_dir": str(RUNTIME_DIR),
            "share_dir": str(DATA_DIR),
            "setup_running": INSTALL["running"],
            "setup_finished": INSTALL["finished"],
            # 可用内存：QQ 单实例常驻 300~600MB，挂多个号时这里能直接看出
            # 是不是内存吃紧要被 OOM 杀掉（-1 表示读不到）。
            "mem_available_mb": procman.mem_available_mb(),
        },
        # 只上报真正的启动致命错误（如进程管理器初始化异常）。
        # 图形栈状态一律以实时 preflight 的 runtime.ready / runtime.missing 为准，
        # 不再返回启动时的快照，避免出现「右上角显示就绪、红框却说未就绪」。
        "error": BOOT_ERROR if PM is None else "",
    }
def create_account(data: dict) -> tuple[dict, str]:
    pm = require_pm()
    name = clean_str(data.get("name"), 40)
    if not name:
        raise ValueError("请填写账号名称")
    with LOCK:
        display, port = pm.allocate(STATE["accounts"])
        acc = {
            "id": new_id(),
            "name": name,
            "qq": clean_str(data.get("qq"), 20),
            "note": clean_str(data.get("note"), 200),
            "display": display,
            "vnc_port": port,
            "enabled": False,
            "created": now_iso(),
        }
        STATE["accounts"].append(acc)
        save_state()
    pre = pm.preflight()
    if not pre["ready"]:
        return acc, ("账号已创建，但图形栈未就绪，尚未启动。缺少："
                     + ", ".join(pre["missing"]))
    try:
        pm.start(acc)
        with LOCK:
            acc["enabled"] = True
            save_state()
        message = f"账号「{name}」已启动，点「打开网页桌面」扫码登录"
    except Exception as exc:
        message = f"账号已创建，但启动失败：{exc}"
    return acc, message
def action_account(acc_id: str, action: str, data: dict | None = None) -> str:
    pm = require_pm()
    acc = get_account(acc_id)
    if action == "start":
        pm.start(acc)
        with LOCK:
            acc["enabled"] = True
            save_state()
        return "已启动"
    if action == "stop":
        pm.stop(acc)
        with LOCK:
            acc["enabled"] = False
            save_state()
        return "已停止"
    if action in ("restart", "recreate"):
        pm.restart(acc)
        with LOCK:
            acc["enabled"] = True
            save_state()
        return "已重启进程组（登录态保留）"
    if action == "update":
        payload = data or {}
        need_restart = False
        with LOCK:
            if "name" in payload:
                acc["name"] = clean_str(payload["name"], 40) or acc["name"]
            for key in ("qq", "note"):
                if key in payload:
                    acc[key] = clean_str(payload[key], 200 if key == "note" else 20)
            if "display" in payload and clean_int(payload["display"], 0, 9999, 0):
                new = clean_int(payload["display"], 100, 9999, acc["display"])
                if new != acc["display"]:
                    if any(a["display"] == new for a in STATE["accounts"] if a["id"] != acc_id):
                        raise ValueError(f"DISPLAY :{new} 已被占用")
                    acc["display"] = new
                    need_restart = True
            if "vnc_port" in payload and clean_int(payload["vnc_port"], 0, 65535, 0):
                new = clean_int(payload["vnc_port"], 1024, 65535, acc["vnc_port"])
                if new != acc["vnc_port"]:
                    if any(a["vnc_port"] == new for a in STATE["accounts"] if a["id"] != acc_id):
                        raise ValueError(f"端口 {new} 已被占用")
                    acc["vnc_port"] = new
                    need_restart = True
            save_state()
        if need_restart:
            pm.restart(acc)
            return "配置已保存并重启进程组"
        return "配置已保存"
    raise ValueError(f"未知操作：{action}")
def delete_account(acc_id: str, purge: bool) -> str:
    pm = require_pm()
    acc = get_account(acc_id)
    pm.stop(acc)
    if purge:
        target = DATA_DIR / "accounts" / acc_id
        if target.is_dir() and target.parent == (DATA_DIR / "accounts"):
            shutil.rmtree(target, ignore_errors=True)
        logfile = DATA_DIR / "logs" / f"{acc_id}.log"
        try:
            logfile.unlink(missing_ok=True)
        except Exception:
            pass
    with LOCK:
        STATE["accounts"] = [a for a in STATE["accounts"] if a["id"] != acc_id]
        save_state()
    return "已删除账号" + ("及登录数据" if purge else "（登录数据已保留）")
def update_settings(data: dict) -> dict:
    s = STATE["settings"]
    with LOCK:
        res = clean_str(data.get("resolution"), 20) or s["resolution"]
        if not re.fullmatch(r"\d{3,4}x\d{3,4}", res):
            raise ValueError("分辨率格式应为 宽x高，例如 1024x768")
        s["resolution"] = res
        # 色深：16 更省内存/带宽，24 兼容性最好。只接受这两个值，
        # 避免非法值让 Xvfb 启动失败把整个进程组拖垮。
        if "depth" in data:
            # 色深是枚举而非范围值：不能用 clean_int 钳制（会把 8 静默变成 16），
            # 必须明确拒绝非法值，否则前端无法察觉设置没生效。
            try:
                depth = int(data.get("depth"))
            except (TypeError, ValueError):
                raise ValueError("色深只支持 16 或 24")
            if depth not in (16, 24):
                raise ValueError("色深只支持 16 或 24")
            s["depth"] = depth
            # 标记「用户手动选过」：这样看门狗在 16 位下反复失败时不会擅自改回 24
            s["depth_user_set"] = True
            s.pop("depth_autoreverted", None)
        s.setdefault("depth", 24)
        if "autostart" in data:
            s["autostart"] = bool(data["autostart"])
        if "watchdog" in data:
            s["watchdog"] = bool(data["watchdog"])
        s["watchdog_interval"] = clean_int(data.get("watchdog_interval"), 5, 120, s["watchdog_interval"])
        if "update_url" in data:
            url = clean_str(data.get("update_url"), 300)
            if url and not url.startswith(("http://", "https://")):
                raise ValueError("更新源地址必须是 http(s) 链接")
            s["update_url"] = url
        save_state()
    return s
def start_runtime_install(options: dict) -> str:
    """后台线程执行环境准备，避免大文件下载阻塞 HTTP 请求。"""
    with INSTALL_LOCK:
        if INSTALL["running"]:
            raise RuntimeError("已有环境准备任务在运行")
        INSTALL["running"] = True
        INSTALL["finished"] = False
        INSTALL["lines"] = []
        INSTALL["started"] = now_iso()
    def emit(line: str):
        with INSTALL_LOCK:
            INSTALL["lines"].append(line)
            if len(INSTALL["lines"]) > 400:
                INSTALL["lines"] = INSTALL["lines"][-400:]
    def worker():
        try:
            setup_runtime.RuntimeSetup(RUNTIME_DIR, DATA_DIR, emit=emit).run(options)
        except Exception as exc:
            emit(f"任务异常：{exc}")
        finally:
            with INSTALL_LOCK:
                INSTALL["running"] = False
                INSTALL["finished"] = True
            if PM:
                # 让下一次 preflight 反映最新文件状态
                pre = PM.preflight()
                if pre["ready"]:
                    # 运行时补齐后自动把账号重新拉起来：升级后、首次准备后都不必
                    # 再手动逐个点「启动」（账号的 enabled 状态本来就记着）。
                    try:
                        restore_accounts()
                    except Exception as exc:
                        log(f"准备完成后自动启动账号失败：{exc}")
    threading.Thread(target=worker, name="qqfarm-setup", daemon=True).start()
    return "环境准备已开始，请查看下方进度"
def read_setup_log() -> list[str]:
    with INSTALL_LOCK:
        if INSTALL["lines"]:
            return list(INSTALL["lines"][-200:])
    path = DATA_DIR / "runtime-setup.log"
    if not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
    except Exception:
        return []
def restore_accounts() -> None:
    """面板启动时按设置恢复上次运行中的账号进程组。"""
    if PM is None:
        return
    if not STATE["settings"].get("autostart", True):
        return
    pre = PM.preflight()
    if not pre["ready"]:
        log("图形栈未就绪，跳过自动恢复")
        return
    for acc in list(STATE["accounts"]):
        if not acc.get("enabled", False):
            continue
        if PM.status(acc)["status"] == "running":
            continue
        try:
            PM.start(acc)
        except Exception as exc:
            log(f"恢复 {acc['id']} 失败：{exc}")
# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "QQFarmNative/2.0"
    def log_message(self, fmt, *args):
        # 注意：BaseHTTPRequestHandler.send_response() 内部会调用 log_request()
        # → log_message()。这里任何异常都会让 send_response 抛错、响应失败，
        # 因此整个函数体必须绝对安全，异常一律吞掉。
        try:
            code = int(args[1]) if len(args) > 1 else 0
            if code >= 400:
                log("%s - %s" % (self.address_string(), fmt % args))
        except Exception:
            pass
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
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", headers)
    def _ok(self, data: dict | None = None, message: str = ""):
        obj = {"ok": True}
        if message:
            obj["message"] = message
        if data:
            obj.update(data)
        self._json(200, obj)
    def _fail(self, status: int, message: str):
        self._json(status, {"ok": False, "error": message})
    def _dispatch(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        raw_path = parsed.path
        # 统一网关访问 /app/qqfarm-native 时补上结尾斜杠，保证相对路径正确解析
        if GATEWAY_PREFIX and raw_path == GATEWAY_PREFIX:
            self._redirect(GATEWAY_PREFIX + "/")
            return
        path = raw_path.rstrip("/") or "/"
        if GATEWAY_PREFIX and path.startswith(GATEWAY_PREFIX + "/"):
            path = path[len(GATEWAY_PREFIX):]
        query = urllib.parse.parse_qs(parsed.query)
        self._raw_body = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self._raw_body = self.rfile.read(min(length, 1_000_000))
        try:
            return self._route(method, path, query)
        except (ValueError, KeyError) as exc:
            self._fail(400, str(exc))
        except RuntimeError as exc:
            self._fail(503, str(exc))
        except Exception as exc:
            log("未处理异常：\n" + traceback.format_exc())
            self._fail(500, f"服务器内部错误：{exc}")
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
        try:
            jar = http.cookies.SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            morsel = jar.get("qqfarm_sid")
            return morsel.value if morsel else ""
        except Exception:
            return ""
    def _session_cookie(self, token: str, max_age: int = SESSION_TTL) -> str:
        return f"qqfarm_sid={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
    def _authed(self) -> bool:
        return auth_configured() and session_valid(self._cookie_token())
    def _csrf_ok(self) -> bool:
        # 写操作一律要求自定义头 X-QQFarm: 1（前端 api() 每个请求都带）：
        #   1) 跨站页面无法私自加自定义头——会触发 CORS 预检，本服务不放行，
        #      再叠加会话 Cookie 的 SameSite=Lax，可有效阻断 CSRF；
        #   2) 不做 Host/Origin 强同源校验——飞牛桌面经端口转发访问时，浏览器
        #      Origin（fnOS 域名）与后端 Host（127.0.0.1:8788）天然不一致，
        #      强校验会把登录/新增账号等全部写操作误杀（1.0.1~1.0.4 的老坑）。
        return self.headers.get("X-QQFarm") == "1"
    def do_GET(self):
        self._dispatch("GET")
    def do_POST(self):
        self._dispatch("POST")
    def do_DELETE(self):
        self._dispatch("DELETE")
    # ---------- 静态与桌面 ----------
    def _route(self, method: str, path: str, query: dict):
        if method == "GET" and path in ("/", "/index.html"):
            return self._panel_static("index.html")
        if method == "GET" and path.startswith("/static/"):
            name = path[len("/static/"):]
            if name not in PANEL_FILES or "/" in name or ".." in name:
                return self._fail(404, "资源不存在")
            return self._panel_static(name)
        if method == "GET" and path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        m = re.fullmatch(r"/desktop/([A-Za-z0-9_-]+)/ws", path)
        if method == "GET" and m:
            if not self._authed():
                return self._fail(401, "请先登录面板")
            acc = get_account(m.group(1))
            wsproxy.serve_websocket(self, int(acc["vnc_port"]))
            return
        m = re.fullmatch(r"/desktop/([A-Za-z0-9_-]+)", path)
        if method == "GET" and m:
            if not self._authed():
                return self._redirect(GATEWAY_PREFIX + "/")
            return self._desktop_page(m.group(1))
        if method == "GET" and path.startswith("/novnc/"):
            return self._novnc_static(path[len("/novnc/"):])
        if not path.startswith("/api/"):
            return self._fail(404, "资源不存在")
        if method in ("POST", "DELETE") and not self._csrf_ok():
            return self._fail(403, "跨站请求被拒绝")
        return self._api(method, path, query)
    def _redirect(self, location: str):
        self._send(302, b"", "text/plain; charset=utf-8", {"Location": location})
    def _panel_static(self, name: str):
        file = STATIC_DIR / name
        if not file.is_file():
            return self._fail(404, "页面文件缺失，请检查 app/panel/static 是否随应用安装")
        self._send(200, file.read_bytes(), PANEL_FILES[name])
    def _novnc_static(self, rel: str):
        if ".." in rel or rel.startswith("/"):
            return self._fail(404, "资源不存在")
        file = (RUNTIME_DIR / "novnc" / rel).resolve()
        root = (RUNTIME_DIR / "novnc").resolve()
        if root not in file.parents or not file.is_file():
            return self._fail(404, "资源不存在")
        ctype = MIME.get(file.suffix.lower(), "application/octet-stream")
        self._send(200, file.read_bytes(), ctype)
    def _desktop_page(self, acc_id: str):
        try:
            acc = get_account(acc_id)
        except KeyError:
            return self._fail(404, "账号不存在")
        prefix = GATEWAY_PREFIX
        if not (RUNTIME_DIR / "novnc/core/rfb.js").is_file():
            html = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>图形栈未就绪</title><body style="background:#0c111b;color:#e8eef9;font:14px sans-serif;padding:40px">
<h2>网页桌面尚未就绪</h2>
<p>还缺少 noVNC 页面或图形栈组件。请回到面板首页，点「环境准备」一键补齐后再打开。</p>
</body></html>"""
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        status = PM.status(acc) if PM else {"status": "stopped"}
        hint = "" if status["status"] == "running" else \
            '<p class="warn">QQ 进程未运行，请先在面板里点「启动」。</p>'
        html = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__NAME__ · QQ 网页桌面</title>
<base href="__PREFIX__/">
<style>
html,body{margin:0;height:100%;background:#0c111b;color:#e8eef9;font-family:sans-serif;overflow:hidden}
#bar{height:38px;display:flex;align-items:center;gap:12px;padding:0 14px;background:#161e2d;border-bottom:1px solid #26324a;font-size:13px}
#bar a{color:#8b9ab2;text-decoration:none}#bar a:hover{color:#fff}
#screen{height:calc(100% - 38px);display:flex;align-items:center;justify-content:center}
#screen canvas{outline:none}
.warn{color:#fbbf24;margin:0}
#msg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#8b9ab2}
</style></head><body>
<div id="bar"><strong>__NAME__</strong><span>手机 QQ 扫码登录后可直接关闭本页，账号会继续在线</span>
<span style="flex:1"></span><a href="__PREFIX__/">返回面板</a></div>
__HINT__
<div id="screen"><div id="msg">正在连接虚拟桌面…</div></div>
<script type="module">
const box = document.getElementById('screen');
const msg = document.getElementById('msg');
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = proto + '//' + location.host + '__PREFIX__/desktop/__ID__/ws';
// 关键修复：模块说明符必须是 / 或 ./ 开头的 URL 路径。
// 旧代码写的是 'novnc/core/rfb.js'（裸包名），浏览器会抛
// "Failed to resolve module specifier"，且静态 import 的解析错误
// 无法被 try/catch 捕获 → 整个脚本不执行 → 页面永远卡在「正在连接虚拟桌面…」。
// 改用动态 import(绝对路径)，任何失败都能在页面上明确显示。
const moduleUrl = '__PREFIX__/novnc/core/rfb.js';
let connected = false;
function fail(text) {
  if (msg) { msg.textContent = text; msg.style.color = '#fbbf24'; msg.style.maxWidth = '90%'; }
}
setTimeout(function () {
  if (!connected) fail('连接超时：请确认账号状态为「运行中」，然后刷新本页重试');
}, 15000);
import(moduleUrl).then(function (mod) {
  const RFB = mod.default;
  const rfb = new RFB(box, url, { scaleViewport: true, resizeSession: true, showDotCursor: true });
  rfb.addEventListener('connect', function () {
    connected = true;
    const m = document.getElementById('msg'); if (m) m.remove();
  });
  rfb.addEventListener('disconnect', function (e) {
    connected = true;
    box.innerHTML = '<div id="msg">连接已断开：' +
      ((e.detail && e.detail.reason) || '请确认账号进程正在运行') + '</div>';
  });
  rfb.addEventListener('securityfailure', function () {
    connected = true;
    box.innerHTML = '<div id="msg">VNC 安全协商失败，请查看账号日志</div>';
  });
}).catch(function (err) {
  fail('noVNC 加载失败：' + (err && err.message ? err.message : err) +
       '（模块地址 ' + moduleUrl + '）');
});
</script></body></html>"""
        html = (html.replace("__NAME__", _html_escape(acc["name"]))
                    .replace("__ID__", acc_id).replace("__HINT__", hint)
                    .replace("__PREFIX__", prefix))
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
    # ---------- API ----------
    def _api(self, method: str, path: str, query: dict):
        if method == "GET" and path == "/api/bootstrap":
            pre = PM.preflight() if PM else {"ready": False, "missing": ["*"], "mode": "unknown"}
            return self._ok({"configured": auth_configured(),
                             "runtime_ready": pre["ready"], "mode": pre["mode"],
                             "version": PANEL_VERSION, "error": BOOT_ERROR})
        if method == "POST" and path == "/api/setup":
            if auth_configured():
                return self._fail(409, "管理密码已设置，请直接登录")
            pw = str(self._body().get("password") or "")
            if len(pw) < 8:
                return self._fail(400, "管理密码至少 8 位")
            set_password(pw)
            return self._json(200, {"ok": True, "message": "初始化完成"},
                              {"Set-Cookie": self._session_cookie(issue_session())})
        if method == "POST" and path == "/api/login":
            if not auth_configured():
                return self._fail(400, "尚未初始化，请先设置管理密码")
            now = time.time()
            if LOGIN_GUARD["until"] > now:
                return self._fail(429, "尝试过于频繁，请稍后再试")
            if not verify_password(str(self._body().get("password") or "")):
                LOGIN_GUARD["fails"] += 1
                if LOGIN_GUARD["fails"] >= 5:
                    LOGIN_GUARD["until"] = now + 60
                    LOGIN_GUARD["fails"] = 0
                return self._fail(401, "管理密码错误")
            LOGIN_GUARD["fails"] = 0
            return self._json(200, {"ok": True},
                              {"Set-Cookie": self._session_cookie(issue_session())})
        if not self._authed():
            return self._fail(401, "未登录或登录已过期")
        if method == "POST" and path == "/api/logout":
            drop_session(self._cookie_token())
            return self._json(200, {"ok": True}, {"Set-Cookie": self._session_cookie("", 0)})
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
            return self._send(200, json.dumps(STATE, ensure_ascii=False, indent=2).encode("utf-8"),
                              "application/json; charset=utf-8",
                              {"Content-Disposition": 'attachment; filename="qqfarm-native-state.json"'})
        if method == "GET" and path == "/api/settings":
            return self._ok({"settings": STATE["settings"]})
        if method == "POST" and path == "/api/settings":
            return self._ok({"settings": update_settings(self._body())}, "设置已保存")
        if method == "POST" and path == "/api/runtime/check":
            return self._ok({"runtime": PM.preflight() if PM else {}}, "图形栈自检完成")
        if method == "POST" and path == "/api/update/check":
            # 检测更新：默认用设置里的更新源；请求体可临时传 source 覆盖。
            source = clean_str(self._body().get("source") or "", 300) \
                or str(STATE["settings"].get("update_url") or "")
            return self._ok(check_update(source))
        if method == "GET" and path == "/api/runtime/install/status":
            with INSTALL_LOCK:
                running, finished = INSTALL["running"], INSTALL["finished"]
            return self._ok({"running": running, "finished": finished,
                             "lines": read_setup_log()})
        if method == "POST" and path == "/api/runtime/install":
            body = self._body()
            options = {k: clean_str(body.get(k), 1000)
                       for k in ("qq_url", "qq_path", "novnc_url")}
            return self._ok(message=start_runtime_install(options))
        if method == "POST" and path == "/api/accounts":
            acc, message = create_account(self._body())
            return self._ok({"account": acc}, message)
        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)/logs", path)
        if method == "GET" and m:
            acc = get_account(m.group(1))
            tail = clean_int((query.get("tail") or ["200"])[0], 10, 2000, 200)
            return self._ok({"logs": require_pm().logs(acc, tail)})
        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)/([a-z]+)", path)
        if method == "POST" and m:
            return self._ok(message=action_account(m.group(1), m.group(2), self._body()))
        m = re.fullmatch(r"/api/accounts/([A-Za-z0-9_-]+)", path)
        if method == "DELETE" and m:
            purge = (query.get("purge") or ["0"])[0] in ("1", "true", "yes")
            return self._ok(message=delete_account(m.group(1), purge))
        return self._fail(404, "接口不存在")
def _html_escape(value: str) -> str:
    return (str(value).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"))
def run(host: str = "0.0.0.0", port: int | None = None):
    global PM, BOOT_ERROR
    # 1) 先建立并监听 socket —— 飞牛统一网关要求后端在 socket 就绪后才能转发，
    #    否则会出现 502 Bad Gateway。把绑定放在最前，任何后续初始化失败都不影响
    #    网关连上本进程（页面会显示明确的启动错误，而不是 Bad Gateway）。
    port = PANEL_PORT if port is None else port
    # 仅当显式开启 QQFARM_USE_SOCKET 时才走 Unix Socket（飞牛统一网关 iframe 模式）；
    # 否则一律监听 TCP 端口（type:url 经典模式），从根本上绕开「target 只读目录无法写
    # socket」与「第三方应用不能用 root」两大坑。TCP 模式下 fnOS 经端口转发访问本面板。
    socket_path = ""
    if os.environ.get("QQFARM_USE_SOCKET"):
        socket_path = (os.environ.get("FNNAS_GATEWAY_SOCKET")
                       or SOCKET_PATH
                       or os.environ.get("GATEWAY_SOCKET")
                       or "").strip()
    httpd = None
    if socket_path:
        # 统一网关模式：必须监听 Unix Socket，且必须成功。
        # 任何失败都直接退出（不再静默回退 TCP），否则会制造“进程在跑但网关 502”的假象，
        # 让 cmd/main 与用户都无法定位真实原因。
        if not hasattr(socketserver, "UnixStreamServer"):
            log("致命错误：当前 Python 不支持 Unix Domain Socket"
                "（socketserver.UnixStreamServer 不存在），无法对接飞牛统一网关。"
                "请使用标准 CPython：系统 python3 或飞牛商店「Python 3.12 运行时」。")
            sys.exit(2)
        class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
        sock_dir = os.path.dirname(socket_path) or "."
        try:
            os.makedirs(sock_dir, exist_ok=True)
        except OSError as exc:
            log(f"致命错误：无法创建 socket 目录 {sock_dir}：{exc}")
            sys.exit(3)
        try:
            os.unlink(socket_path)
        except OSError:
            pass
        try:
            httpd = ThreadingUnixHTTPServer(socket_path, Handler)
        except OSError as exc:
            log(f"致命错误：Unix Socket 监听失败（{socket_path}）：{exc}")
            sys.exit(4)
        try:
            os.chmod(socket_path, 0o666)
        except OSError:
            pass
        log(f"原生管理面板已监听 Unix Socket {socket_path}（数据目录 {DATA_DIR}）")
    else:
        httpd = ThreadingHTTPServer((host, port), Handler)
        httpd.daemon_threads = True
        log(f"原生管理面板已监听 {host}:{port}（数据目录 {DATA_DIR}）")
    # 2) 再做初始化；任何失败都只记录 BOOT_ERROR，不阻止 socket 已就绪。
    try:
        migrate_runtime()
        init_storage()
        init_process_manager()
        restore_accounts()
        auto_restore_runtime()
        if PM and STATE["settings"].get("watchdog", True):
            try:
                PM.watchdog(
                    accounts_provider=lambda: list(STATE["accounts"]),
                    should_run=lambda a: bool(a.get("enabled", False)),
                    interval=int(STATE["settings"].get("watchdog_interval", 12)),
                )
            except Exception as exc:
                log(f"看门狗启动失败（不影响面板）：{exc}")
    except Exception as exc:
        BOOT_ERROR = f"初始化失败：{exc}"
        log(BOOT_ERROR + "\n" + traceback.format_exc())
    # 2.5) 后台自愈：补齐 VNC 运行库（libvncclient.so.1 等）。
    # 旧版环境准备漏下载这些包，导致 x11vnc 起不来；这里在面板启动后
    # 异步修复，用户无需手动重跑「环境准备」。失败也不影响面板可用性。
    def _selfheal_libs():
        try:
            info = setup_runtime.repair_missing_libs(RUNTIME_DIR, DATA_DIR, emit=log)
            if info.get("downloaded") and PM:
                PM.invalidate_lib_cache()
                PM.preflight()
        except Exception as exc:
            log(f"运行库自愈失败（不影响面板）：{exc}")
    threading.Thread(target=_selfheal_libs, name="qqfarm-libfix", daemon=True).start()
    # 3) 信号处理
    def on_term(_signum, _frame):
        log("收到 TERM，停止所有 QQ 进程")
        try:
            if PM:
                PM.stop_all()
        except Exception:
            pass
        raise SystemExit(0)
    try:
        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGINT, on_term)
    except (ValueError, AttributeError):
        pass
    # 4) 提供服务
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()
        if socket_path:
            try:
                os.unlink(socket_path)
            except OSError:
                pass
if __name__ == "__main__":
    run()

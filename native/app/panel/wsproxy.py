"""极简 WebSocket → TCP 转发（Python 标准库），替代 websockify。
noVNC 前端通过 ws://<面板>/desktop/<id>/ws 连上来，这里把 WebSocket 帧拆成
裸字节转发给本机的 x11vnc RFB 端口，再把 RFB 回包封装成 WebSocket binary 帧。
只依赖 socket / base64 / hashlib / threading，不需要 pip 包。
"""
from __future__ import annotations
import base64
import hashlib
import socket
import struct
import threading
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
def accept_key(key: str) -> str:
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")
def build_frame(payload: bytes, opcode: int = 0x2) -> bytes:
    """服务端 → 客户端：不掩码，单帧 binary。"""
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    return bytes(head) + payload
def _recv_exact(reader, n: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < n:
        part = reader.read(n - len(chunks))
        if not part:
            return b""
        chunks += part
    return bytes(chunks)
def _read_frame(reader):
    """返回 (fin, opcode, payload)；连接关闭返回 None。"""
    head = _recv_exact(reader, 2)
    if len(head) < 2:
        return None
    b0, b1 = head[0], head[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        ext = _recv_exact(reader, 2)
        if len(ext) < 2:
            return None
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext = _recv_exact(reader, 8)
        if len(ext) < 8:
            return None
        length = struct.unpack(">Q", ext)[0]
    if length > 8 * 1024 * 1024:
        return None
    mask = _recv_exact(reader, 4) if masked else b""
    if masked and len(mask) < 4:
        return None
    payload = bytearray(_recv_exact(reader, length))
    if len(payload) < length:
        return None
    if masked:
        for i in range(length):
            payload[i] ^= mask[i % 4]
    return fin, opcode, bytes(payload)
def serve_websocket(handler, upstream_port: int, timeout: float = 300) -> None:
    """把当前 HTTP 连接升级为 WebSocket，并与本机 RFB 端口双向转发。

    timeout 参数保留以兼容旧调用，实际不再用于数据读超时：连接建立后
    改为阻塞读，避免挂机时画面长时间无变化被误判断线（见 settimeout(None)）。
    到 VNC 的连接超时固定 5 秒，与 timeout 无关。
    """
    key = handler.headers.get("Sec-WebSocket-Key", "")
    if not key or "websocket" not in handler.headers.get("Upgrade", "").lower():
        handler.send_response(400)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    try:
        upstream = socket.create_connection(("127.0.0.1", int(upstream_port)), timeout=5)
    except OSError:
        handler.send_response(502)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    # 挂机场景会长时间没有任何 RFB 数据（QQ 画面不变）。若给 upstream.recv
    # 设 300s 超时，socket.timeout 会被下面 except 捕获并 stop.set()，
    # 导致网页桌面每 5 分钟自动断开一次。改为阻塞读：客户端关闭时
    # client_to_upstream 会 shutdown(upstream) 唤醒本线程，能正常收尾。
    upstream.settimeout(None)
    handler.close_connection = True
    try:
        handler.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_key(key)}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        handler.wfile.flush()
    except OSError:
        upstream.close()
        return
    client = handler.connection
    reader, writer = handler.rfile, handler.wfile
    stop = threading.Event()
    def client_to_upstream():
        pending = bytearray()
        try:
            while not stop.is_set():
                frame = _read_frame(reader)
                if frame is None:
                    break
                fin, opcode, payload = frame
                if opcode == 0x8:  # close
                    try:
                        writer.write(build_frame(b"", 0x8))
                        writer.flush()
                    except OSError:
                        pass
                    break
                if opcode == 0x9:  # ping -> pong
                    try:
                        writer.write(build_frame(payload, 0xA))
                        writer.flush()
                    except OSError:
                        pass
                    continue
                if opcode == 0xA:
                    continue
                if opcode in (0x1, 0x2, 0x0):
                    pending += payload
                    if fin and pending:
                        upstream.sendall(bytes(pending))
                        pending.clear()
        except (OSError, ValueError):
            pass
        finally:
            stop.set()
            try:
                upstream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    def upstream_to_client():
        try:
            while not stop.is_set():
                data = upstream.recv(65536)
                if not data:
                    break
                writer.write(build_frame(data, 0x2))
                writer.flush()
        except (OSError, ValueError, socket.timeout):
            pass
        finally:
            stop.set()
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    t1 = threading.Thread(target=client_to_upstream, daemon=True)
    t2 = threading.Thread(target=upstream_to_client, daemon=True)
    t1.start()
    t2.start()
    try:
        while not stop.is_set():
            stop.wait(0.5)
    finally:
        stop.set()
        upstream.close()

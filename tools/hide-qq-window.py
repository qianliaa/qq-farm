#!/usr/bin/env python3
"""临时隐藏 / 恢复 Xvfb 上的 QQ 窗口，用于实测「隐藏窗口能否降低 CPU」。

只调用 XUnmapWindow / XMapWindow：
  - 不改窗口大小、位置，不碰 QQ 进程，不影响登录态与收发消息；
  - 隐藏后网页桌面会变成黑屏，这是正常现象，执行 --map 即可恢复；
  - 找不到窗口或 libX11 时只报错退出，不会做任何修改。

用法（在 NAS 的 SSH 里执行，python3 用系统自带的即可）：
  python3 hide-qq-window.py --display :101 --list          # 只列出窗口，不做修改
  python3 hide-qq-window.py --display :101 --unmap         # 隐藏该屏上所有 QQ 窗口
  python3 hide-qq-window.py --display :101 --map           # 恢复
  python3 hide-qq-window.py --display :101 --unmap --pid 1234 5678

CPU 对比建议（取第二帧才是瞬时值）：
  top -b -n2 -d1 -p "$(pgrep -d, -f '/opt/QQ/qq')" | tail -25
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import os
import sys

Atom = ctypes.c_ulong
Window = ctypes.c_ulong
XA_CARDINAL = 6


class XClassHint(ctypes.Structure):
    _fields_ = [("res_name", ctypes.c_char_p), ("res_class", ctypes.c_char_p)]


def load_x11():
    name = ctypes.util.find_library("X11") or "libX11.so.6"
    try:
        return ctypes.CDLL(name)
    except OSError:
        sys.exit("找不到 libX11（本脚本需要在 NAS 的 Linux 上运行）。")


def setup(x11):
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = Window
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XInternAtom.restype = Atom
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XQueryTree.argtypes = [
        ctypes.c_void_p, Window,
        ctypes.POINTER(Window), ctypes.POINTER(Window),
        ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint),
    ]
    x11.XFetchName.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(ctypes.c_char_p)]
    x11.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XClassHint)]
    x11.XGetWindowProperty.argtypes = [
        ctypes.c_void_p, Window, Atom, ctypes.c_long, ctypes.c_long,
        ctypes.c_int, Atom,
        ctypes.POINTER(Atom), ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
    ]
    x11.XFree.argtypes = [ctypes.c_void_p]
    x11.XUnmapWindow.argtypes = [ctypes.c_void_p, Window]
    x11.XMapWindow.argtypes = [ctypes.c_void_p, Window]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]


def children(x11, dpy, win):
    root = Window()
    parent = Window()
    kids = ctypes.POINTER(Window)()
    n = ctypes.c_uint()
    if not x11.XQueryTree(dpy, win, ctypes.byref(root), ctypes.byref(parent),
                          ctypes.byref(kids), ctypes.byref(n)):
        return []
    out = [kids[i] for i in range(n.value)]
    if kids:
        x11.XFree(kids)
    return out


def wm_pid(x11, dpy, win, atom):
    t = Atom()
    fmt = ctypes.c_int()
    n = ctypes.c_ulong()
    after = ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    st = x11.XGetWindowProperty(dpy, win, atom, 0, 1, 0, XA_CARDINAL,
                                ctypes.byref(t), ctypes.byref(fmt),
                                ctypes.byref(n), ctypes.byref(after),
                                ctypes.byref(data))
    if st != 0 or n.value == 0 or not data:
        return None
    try:
        return int(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0])
    finally:
        x11.XFree(data)


def win_name(x11, dpy, win):
    p = ctypes.c_char_p()
    if x11.XFetchName(dpy, win, ctypes.byref(p)):
        try:
            return p.value.decode("utf-8", "replace") if p.value else ""
        finally:
            if p:
                x11.XFree(p)
    return ""


def win_class(x11, dpy, win):
    h = XClassHint()
    if not x11.XGetClassHint(dpy, win, ctypes.byref(h)):
        return ""
    try:
        rn = h.res_name.decode("utf-8", "replace") if h.res_name else ""
        rc = h.res_class.decode("utf-8", "replace") if h.res_class else ""
        return f"{rn}/{rc}"
    finally:
        if h.res_name:
            x11.XFree(h.res_name)
        if h.res_class:
            x11.XFree(h.res_class)


def qq_pids():
    """主进程（命令行里没有 --type=）且可执行文件是 QQ。"""
    out = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = open(f"/proc/{entry}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        args = [a.decode("utf-8", "replace") for a in raw if a]
        if not args:
            continue
        if any(a.startswith("--type=") for a in args):
            continue
        exe = args[0]
        if exe.endswith("/QQ/qq") or exe.endswith("/qq") and "QQ" in exe:
            out.append(int(entry))
    return sorted(out)


def collect_windows(x11, dpy, depth=1):
    found = []

    def walk(win, d):
        for child in children(x11, dpy, win):
            found.append(child)
            if d > 0:
                walk(child, d - 1)

    walk(x11.XDefaultRootWindow(dpy), depth)
    return found


def main():
    ap = argparse.ArgumentParser(description="隐藏/恢复 Xvfb 上的 QQ 窗口")
    ap.add_argument("--display", required=True, help="例如 :101")
    ap.add_argument("--list", action="store_true", help="只列出窗口")
    ap.add_argument("--unmap", action="store_true", help="隐藏窗口")
    ap.add_argument("--map", action="store_true", help="恢复窗口")
    ap.add_argument("--pid", type=int, nargs="*", default=None,
                    help="只处理指定 PID（默认自动识别 QQ 主进程）")
    args = ap.parse_args()

    if not (args.list or args.unmap or args.map):
        args.list = True

    x11 = load_x11()
    setup(x11)
    dpy = x11.XOpenDisplay(args.display.encode())
    if not dpy:
        sys.exit(f"无法连接显示 {args.display}（确认 Xvfb 已启动，DISPLAY 是否正确）")

    try:
        pid_atom = x11.XInternAtom(dpy, b"_NET_WM_PID", 0)
        targets = set(args.pid) if args.pid else set(qq_pids())
        if args.pid:
            print("按指定 PID 过滤：", sorted(targets))
        else:
            print("自动识别的 QQ 主进程：", sorted(targets) or "（无）")

        rows = []
        for win in collect_windows(x11, dpy):
            pid = wm_pid(x11, dpy, win, pid_atom)
            cls = win_class(x11, dpy, win)
            title = win_name(x11, dpy, win)
            if not cls and not title:
                continue
            match = pid in targets if pid else False
            if not match and pid is None and "qq" in cls.lower():
                match = True  # 有些版本不写 _NET_WM_PID，退回按窗口类名判断
            if match:
                rows.append((win, pid, cls, title))

        if not rows:
            sys.exit("没有找到 QQ 窗口（确认该屏上的 QQ 已启动；也可用 --pid 指定进程）")

        for win, pid, cls, title in rows:
            print(f"  window=0x{win:x}  pid={pid}  class={cls}  title={title[:60]}")

        if args.list and not (args.unmap or args.map):
            print("\n只列出，未做修改。")
            return

        if args.unmap and args.map:
            sys.exit("--unmap 与 --map 不能同时使用")

        ids = [f"0x{win:x}" for win, _, _, _ in rows]
        for win, _, _, _ in rows:
            if args.unmap:
                x11.XUnmapWindow(dpy, win)
            else:
                x11.XMapWindow(dpy, win)
        x11.XSync(dpy, 0)
        action = "隐藏" if args.unmap else "恢复"
        print(f"\n已{action} {len(rows)} 个窗口：{' '.join(ids)}")
        if args.unmap:
            print(f"恢复命令：python3 {os.path.basename(__file__)} "
                  f"--display {args.display} --map")
    finally:
        x11.XCloseDisplay(dpy)


if __name__ == "__main__":
    main()

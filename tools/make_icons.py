#!/usr/bin/env python3
"""生成飞牛应用图标（纯标准库，不依赖 Pillow / cairosvg）。

输出：
  fpk/ICON.PNG                    64x64
  fpk/ICON_256.PNG                256x256
  fpk/app/ui/images/icon_64.png   64x64
  fpk/app/ui/images/icon_256.png  256x256
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FPK = ROOT / "fpk"
S = 512  # 超采样画布，最后降采样得到 256 / 64


def lerp(a, b, t):
    return a + (b - a) * t


class Canvas:
    def __init__(self, size: int):
        self.size = size
        self.buf = bytearray(size * size * 4)

    def blend(self, x: int, y: int, color: tuple[int, int, int, int]):
        if not (0 <= x < self.size and 0 <= y < self.size):
            return
        r, g, b, a = color
        if a <= 0:
            return
        i = (y * self.size + x) * 4
        if a >= 255:
            self.buf[i : i + 4] = bytes((r, g, b, 255))
            return
        alpha = a / 255.0
        for k, v in enumerate((r, g, b)):
            self.buf[i + k] = int(self.buf[i + k] * (1 - alpha) + v * alpha)
        self.buf[i + 3] = min(255, int(self.buf[i + 3] + a * (1 - self.buf[i + 3] / 255.0)))

    def downsample(self, factor: int) -> bytes:
        n = self.size // factor
        out = bytearray(n * n * 4)
        f2 = factor * factor
        for y in range(n):
            for x in range(n):
                acc = [0, 0, 0, 0]
                for dy in range(factor):
                    base = ((y * factor + dy) * self.size + x * factor) * 4
                    for dx in range(factor):
                        j = base + dx * 4
                        for k in range(4):
                            acc[k] += self.buf[j + k]
                o = (y * n + x) * 4
                out[o : o + 4] = bytes(min(255, v // f2) for v in acc)
        return bytes(out)


def rounded_inside(x: int, y: int, size: int, radius: float) -> bool:
    dx = max(radius - x, 0, x - (size - 1 - radius))
    dy = max(radius - y, 0, y - (size - 1 - radius))
    return dx * dx + dy * dy <= radius * radius


def fill_ring(c: Canvas, cx: float, cy: float, ro: float, ri: float,
              color: tuple[int, int, int, int]):
    x0, x1 = int(cx - ro - 1), int(cx + ro + 2)
    y0, y1 = int(cy - ro - 1), int(cy + ro + 2)
    for y in range(y0, y1):
        for x in range(x0, x1):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if ri * ri <= d2 <= ro * ro:
                c.blend(x, y, color)


def fill_disc(c: Canvas, cx: float, cy: float, r: float,
              color: tuple[int, int, int, int]):
    for y in range(int(cy - r - 1), int(cy + r + 2)):
        for x in range(int(cx - r - 1), int(cx + r + 2)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                c.blend(x, y, color)


def thick_line(c: Canvas, x0: float, y0: float, x1: float, y1: float,
               width: float, color: tuple[int, int, int, int]):
    steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 3) + 1
    for i in range(steps + 1):
        t = i / steps
        fill_disc(c, lerp(x0, x1, t), lerp(y0, y1, t), width / 2, color)


def render() -> Canvas:
    c = Canvas(S)
    k = S / 256.0
    radius = 56 * k
    # 蓝色渐变底 + 左上柔光
    for y in range(S):
        t = y / (S - 1)
        base = (
            lerp(70, 22, t),
            lerp(150, 74, t),
            lerp(255, 205, t),
        )
        for x in range(S):
            if not rounded_inside(x, y, S, radius):
                continue
            glow = max(0.0, 1.0 - ((x - 70 * k) ** 2 + (y - 30 * k) ** 2) ** 0.5 / (300 * k))
            rgb = tuple(min(255, int(v + 42 * glow)) for v in base)
            c.blend(x, y, (*rgb, 255))

    white = (255, 255, 255, 255)
    # 两个 Q 形环 + 尾巴，构成 QQ 标记
    for cx in (95, 161):
        cx *= k
        cy = 110 * k
        ro, ri = 38 * k, 23 * k
        fill_ring(c, cx, cy, ro, ri, white)
        thick_line(c, cx + 20 * k, cy + 20 * k, cx + 45 * k, cy + 45 * k, 13 * k, white)

    # 底部三个点：多账号
    for i, cx in enumerate((96, 128, 160)):
        fill_disc(c, cx * k, 197 * k, 8 * k, (255, 255, 255, 245 - i * 25))

    return c


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, pixels: bytes):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type: None
        raw += pixels[y * stride : (y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + png_chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def main():
    canvas = render()
    outputs = [
        (FPK / "ICON.PNG", 64, 8),
        (FPK / "ICON_256.PNG", 256, 2),
        (FPK / "app/ui/images/icon_64.png", 64, 8),
        (FPK / "app/ui/images/icon_256.png", 256, 2),
    ]
    for path, size, factor in outputs:
        write_png(path, size, canvas.downsample(factor))
        print(f"已生成 {path.relative_to(ROOT)}  {size}x{size}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()

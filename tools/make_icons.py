"""ホーム画面用アイコン（PNG）を作る。外部ライブラリ不要。

使い方: python3 tools/make_icons.py
出力:   icons/icon-180.png, icon-192.png, icon-512.png, icon-maskable-512.png
"""
import os
import struct
import zlib

BG = (17, 17, 17)
PAGE = (245, 245, 245)
ACCENT = (74, 158, 255)
SS = 4  # 縁をなめらかにするための縮小前の倍率


def write_png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def color_at(u, v, inset):
    """u, v は 0〜1。inset はマスク用の余白（0〜0.5）。開いた本の形を描く。"""
    # 余白を除いた範囲に正規化
    s = 1 - inset * 2
    x = (u - inset) / s
    y = (v - inset) / s
    if not (0 <= x <= 1 and 0 <= y <= 1):
        return BG
    # 左右のページ（中央に少し隙間）
    top, bottom = 0.22, 0.80
    gap = 0.025
    left_page = 0.14 <= x <= 0.5 - gap and top + (0.5 - x) * 0.10 <= y <= bottom
    right_page = 0.5 + gap <= x <= 0.86 and top + (x - 0.5) * 0.10 <= y <= bottom
    if left_page or right_page:
        # ページ上の「コマ割り」の線
        local_x = (x - 0.14) / (0.5 - gap - 0.14) if left_page else (x - 0.5 - gap) / (0.86 - 0.5 - gap)
        if abs(y - 0.50) < 0.012 or (y > 0.50 and abs(local_x - 0.55) < 0.025) or (y < 0.50 and abs(local_x - 0.40) < 0.025):
            return (60, 60, 60)
        return PAGE
    # 下の青い帯（背表紙）
    if 0.83 <= y <= 0.88 and 0.14 <= x <= 0.86:
        return ACCENT
    return BG


def render(size, inset):
    rows = []
    n = size * SS
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = color_at((px * SS + sx + 0.5) / n, (py * SS + sy + 0.5) / n, inset)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            k = SS * SS
            row.append((acc[0] // k, acc[1] // k, acc[2] // k))
        rows.append(row)
    return rows


root = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(root, exist_ok=True)
for size, inset, name in [
    (180, 0.0, "icon-180.png"),
    (192, 0.0, "icon-192.png"),
    (512, 0.0, "icon-512.png"),
    (512, 0.1, "icon-maskable-512.png"),  # Android の丸型マスク用に余白を広めに
]:
    write_png(os.path.join(root, name), size, render(size, inset))
    print("作成:", name)

"""角丸アイコン（角が透明）の透明部分を背景色で塗りつぶし、四角いアイコンを作る。

iPhone のホーム画面は自分で角を丸めるので、角が透明だと黒く見える。
また Android の maskable アイコンも四角い全面塗りが必要なため、そのために使う。

使い方: python3 tools/fill_icon_corners.py 入力.png 出力.png [#163A7D]
（8bit RGBA・インターレースなしの PNG のみ対応。標準ライブラリだけで動く）
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "PNG ではありません"
    pos, idat = 8, b""
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            w, h, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and color == 6 and interlace == 0, "8bit RGBA のみ対応"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = w * 4
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0
            b = prev[x]
            c = prev[x - 4] if x >= 4 else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows.append(line)
        prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    color = (sys.argv[3] if len(sys.argv) > 3 else "#163A7D").lstrip("#")
    bg = [int(color[i:i + 2], 16) for i in (0, 2, 4)]
    w, h, rows = read_png(src)
    out = []
    for r in rows:
        line = bytearray()
        for x in range(w):
            R, G, B, A = r[x * 4:x * 4 + 4]
            # 背景色の上に重ねた色（透明な角は背景色になる）
            line += bytes(round((v * A + bg[k] * (255 - A)) / 255) for k, v in enumerate((R, G, B)))
        out.append(line)
    write_png(dst, w, h, out)
    print(f"{dst}（{w}x{h}）")


if __name__ == "__main__":
    main()

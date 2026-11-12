"""開発用サーバー：ブラウザにキャッシュさせない（iPhoneで古い版が表示されるのを防ぐ）

使い方: python3 serve.py [ポート番号]   （省略時は 8001）
"""
import http.server
import socket
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 実際には送信しない
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
server = http.server.ThreadingHTTPServer(("0.0.0.0", port), NoCacheHandler)
print(f"iPhoneで開くURL: http://{local_ip()}:{port}")
print("止めるときは Ctrl + C")
server.serve_forever()

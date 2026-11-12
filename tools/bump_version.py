"""版の番号を上げる。CSS / JS を変えたら実行する。

使い方: python3 tools/bump_version.py
  index.html の ?v=N と本棚の版表示 vN、sw.js の VERSION をまとめて N+1 にする
"""
import os
import re

root = os.path.join(os.path.dirname(__file__), "..")
html_path = os.path.join(root, "index.html")
sw_path = os.path.join(root, "sw.js")

with open(sw_path, encoding="utf-8") as f:
    sw = f.read()
current = int(re.search(r"const VERSION = 'v(\d+)';", sw).group(1))
new = current + 1

sw = re.sub(r"const VERSION = 'v\d+';", f"const VERSION = 'v{new}';", sw)
with open(sw_path, "w", encoding="utf-8") as f:
    f.write(sw)

with open(html_path, encoding="utf-8") as f:
    html = f.read()
html = re.sub(r"\?v=\d+", f"?v={new}", html)
html = re.sub(r'<p class="version">v\d+</p>', f'<p class="version">v{new}</p>', html)
with open(html_path, "w", encoding="utf-8") as f:
    f.write(html)

print(f"v{current} → v{new}")

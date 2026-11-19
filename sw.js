// Service Worker：アプリ本体をキャッシュしてオフラインでも起動できるようにする
// 版を上げるときは tools/bump_version.py を使う（この VERSION も書き換わる）
const VERSION = 'v32';
const CACHE = `manga-viewer-${VERSION}`;

const APP_FILES = [
  './',
  './index.html',
  `./style.css?${VERSION.replace('v', 'v=')}`,
  `./app.js?${VERSION.replace('v', 'v=')}`,
  `./db.js?${VERSION.replace('v', 'v=')}`,
  `./config.js?${VERSION.replace('v', 'v=')}`,
  `./drive.js?${VERSION.replace('v', 'v=')}`,
  './manifest.webmanifest',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('manga-viewer-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // ページ本体（index.html）は「ネット優先、つながらなければキャッシュ」
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // それ以外（CSS / JS / PDF.js / アイコン）は「キャッシュ優先」
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});

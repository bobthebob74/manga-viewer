// PDF.js 4.10.38（オフラインでも動くようにフォルダ内に置いている）
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { getBook, listBooks, saveBook, touchBook, setThumbnail, deleteBook, RECENT_LIMIT } from './db.js?v=15';
import { GOOGLE_CLIENT_ID } from './config.js?v=15';
import * as drive from './drive.js?v=15';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------
// 設定（localStorage に保存）
// ---------------------------------------------------------------
const SETTINGS_KEY = 'manga-viewer:settings';
const defaultSettings = {
  binding: 'rtl',      // 'rtl' = 右綴じ, 'ltr' = 左綴じ
  layout: 'single',    // 広い画面での表示モード: 'single' | 'spread'
  coverSingle: true,   // 見開き時に表紙を単独表示する
};

function loadSettings() {
  try {
    const s = { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    if (!['rtl', 'ltr'].includes(s.binding)) s.binding = defaultSettings.binding;
    if (!['single', 'spread'].includes(s.layout)) s.layout = defaultSettings.layout;
    return s;
  } catch {
    return { ...defaultSettings };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動作は続ける */ }
}

const settings = loadSettings();

// ---------------------------------------------------------------
// 画面幅による表示モード判定（UA判定はしない）
// 広い画面 = 幅900px以上・高さ500px以上・マウス等の精密なポインタ
// → iPhone を横向きにしても（高さが低い / pointer: coarse）単ページのまま
// ---------------------------------------------------------------
const wideQuery = window.matchMedia(
  '(min-width: 900px) and (min-height: 500px) and (hover: hover) and (pointer: fine)'
);
const isWideScreen = () => wideQuery.matches;
const isSpread = () => isWideScreen() && settings.layout === 'spread';

// ---------------------------------------------------------------
// 状態
// ---------------------------------------------------------------
let pdfDoc = null;
let numPages = 0;
let currentPage = 1;      // 表示中の先頭ページ（1始まり）
let renderSeq = 0;        // 古い描画を捨てるための通し番号
let activeTasks = [];

// 拡大の状態（s = 倍率、x/y = 画面中央からのずれ px）
const MAX_ZOOM = 5;
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari のcanvas上限（約16.7M px）より少し小さく
let zoom = { s: 1, x: 0, y: 0 };
let renderedQuality = 1;  // 現在のcanvasが何倍の解像度で描かれているか

// ---------------------------------------------------------------
// DOM
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const shelf = $('shelf');
const viewer = $('viewer');
const stage = $('stage');
const pagesEl = $('pages');
const loading = $('loading');
const fileInput = $('file-input');
const shelfError = $('shelf-error');
const bookTitle = $('book-title');
const slider = $('page-slider');
const indicator = $('page-indicator');
const settingsDialog = $('settings');
const settingsForm = settingsDialog.querySelector('form');

// ---------------------------------------------------------------
// ページ割り当て（単ページ / 見開き）
// ---------------------------------------------------------------

// 見開きの組の先頭ページに揃える
function normalizePage(p) {
  p = Math.min(Math.max(1, p), numPages);
  if (!isSpread()) return p;
  if (settings.coverSingle) {
    if (p === 1) return 1;
    return p % 2 === 0 ? p : p - 1;   // [1] [2,3] [4,5] ...
  }
  return p % 2 === 1 ? p : p - 1;     // [1,2] [3,4] ...
}

// 現在表示するページ番号の配列（ページ番号順）
function pagesInView(start) {
  if (!isSpread()) return [start];
  if (settings.coverSingle && start === 1) return [1];
  return start + 1 <= numPages ? [start, start + 1] : [start];
}

function goNext() {
  const view = pagesInView(currentPage);
  const next = view[view.length - 1] + 1;
  if (next <= numPages) showPage(next);
}

function goPrev() {
  if (currentPage <= 1) return;
  showPage(normalizePage(currentPage - 1));
}

function showPage(p) {
  currentPage = normalizePage(p);
  resetZoom();
  updateIndicator();
  savePosition();
  render();
}

// ---------------------------------------------------------------
// 描画
// ---------------------------------------------------------------

// 描き終わった画面（原寸のもの）を覚えておき、前後ページの先読みにも使う
const VIEW_CACHE_LIMIT = 6;
const viewCache = new Map();

function viewKey(start) {
  return [
    start, isSpread() ? 's' : '1', settings.coverSingle ? 'c' : '', settings.binding,
    stage.clientWidth, stage.clientHeight, window.devicePixelRatio,
  ].join('|');
}

function cacheGet(key) {
  const v = viewCache.get(key);
  if (v) { viewCache.delete(key); viewCache.set(key, v); } // 最近使ったものを後ろへ
  return v;
}

function cachePut(key, canvases) {
  viewCache.delete(key);
  viewCache.set(key, canvases);
  while (viewCache.size > VIEW_CACHE_LIMIT) {
    const oldest = viewCache.keys().next().value;
    // 表示中でなければメモリを早めに解放
    viewCache.get(oldest).forEach((c) => { if (!c.isConnected) { c.width = 0; c.height = 0; } });
    viewCache.delete(oldest);
  }
}

function clearViewCache() {
  viewCache.forEach((cs) => cs.forEach((c) => { c.width = 0; c.height = 0; }));
  viewCache.clear();
}

function cancelTasks() {
  activeTasks.forEach((t) => t.cancel());
  activeTasks = [];
}

async function render() {
  if (!pdfDoc) return;
  const seq = ++renderSeq;
  const isStale = () => seq !== renderSeq;
  clearTimeout(hiResTimer);
  cancelTasks();

  // 拡大中は、その倍率に合わせて高解像度で描き直す
  const quality = zoom.s;
  renderedQuality = quality;

  let canvases = null;
  if (quality === 1) canvases = cacheGet(viewKey(currentPage));
  if (!canvases) {
    canvases = await drawView(currentPage, quality, isStale);
    if (!canvases) return;
    if (quality === 1) cachePut(viewKey(currentPage), canvases);
  }
  if (isStale()) return;
  pagesEl.replaceChildren(...canvases);
  applyZoom();

  if (quality === 1) prefetchNeighbors(isStale);
}

// 次・前の画面を裏で描いておく（次を優先）
async function prefetchNeighbors(isStale) {
  const view = pagesInView(currentPage);
  const targets = [];
  const next = view[view.length - 1] + 1;
  if (next <= numPages) targets.push(next);
  if (currentPage > 1) targets.push(normalizePage(currentPage - 1));

  for (const start of targets) {
    if (isStale()) return;
    const key = viewKey(start);
    if (viewCache.has(key)) continue;
    const canvases = await drawView(start, 1, isStale);
    if (!canvases || isStale()) return;
    cachePut(key, canvases);
  }
}

// start から始まる画面（単ページ or 見開き）を canvas に描いて返す。中断されたら null
async function drawView(start, quality, isStale) {
  const pageNums = pagesInView(start);
  // 右綴じの見開きは、若い番号のページを右に置く
  const ordered = settings.binding === 'rtl' ? [...pageNums].reverse() : pageNums;

  let pages;
  try {
    pages = await Promise.all(ordered.map((n) => pdfDoc.getPage(n)));
  } catch (e) {
    console.error(e);
    return null;
  }
  if (isStale()) return null;

  const baseViewports = pages.map((pg) => pg.getViewport({ scale: 1 }));
  // 見開きは高さを揃えて横に並べる
  const maxH = Math.max(...baseViewports.map((v) => v.height));
  const unitScales = baseViewports.map((v) => maxH / v.height);
  const totalW = baseViewports.reduce((sum, v, i) => sum + v.width * unitScales[i], 0);

  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  const fit = Math.min(availW / totalW, availH / maxH);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const canvases = [];
  const tasks = pages.map((pg, i) => {
    const cssScale = fit * unitScales[i];
    const cssW = Math.floor(baseViewports[i].width * cssScale);
    const cssH = Math.floor(baseViewports[i].height * cssScale);
    let pixelScale = cssScale * dpr * quality;
    const area = baseViewports[i].width * baseViewports[i].height * pixelScale * pixelScale;
    if (area > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    const vp = pg.getViewport({ scale: pixelScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvases.push(canvas);
    const task = pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    activeTasks.push(task);
    return task.promise;
  });

  try {
    await Promise.all(tasks);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    return null;
  }
  if (isStale()) return null;
  return canvases;
}

// ---------------------------------------------------------------
// 拡大（ピンチ・トラックパッド）と移動
// ---------------------------------------------------------------
function clampZoom() {
  const maxX = Math.max(0, (pagesEl.offsetWidth * zoom.s - stage.clientWidth) / 2);
  const maxY = Math.max(0, (pagesEl.offsetHeight * zoom.s - stage.clientHeight) / 2);
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x));
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
}

function applyZoom() {
  if (zoom.s <= 1) zoom = { s: 1, x: 0, y: 0 };
  clampZoom();
  pagesEl.style.transform = zoom.s === 1
    ? ''
    : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  scheduleHiResRender();
}

// 画面上の点 (clientX, clientY) を中心に倍率を変える
function zoomAt(newS, clientX, clientY) {
  newS = Math.min(MAX_ZOOM, Math.max(1, newS));
  const r = stage.getBoundingClientRect();
  const fx = clientX - (r.left + r.width / 2);
  const fy = clientY - (r.top + r.height / 2);
  const k = newS / zoom.s;
  zoom.x = fx - (fx - zoom.x) * k;
  zoom.y = fy - (fy - zoom.y) * k;
  zoom.s = newS;
  applyZoom();
}

function panBy(dx, dy) {
  zoom.x += dx;
  zoom.y += dy;
  applyZoom();
}

function resetZoom() {
  zoom = { s: 1, x: 0, y: 0 };
  applyZoom();
}

// 拡大が落ち着いたら、ぼやけないように高解像度で描き直す
let hiResTimer = null;
function scheduleHiResRender() {
  clearTimeout(hiResTimer);
  if (!pdfDoc || Math.abs(zoom.s - renderedQuality) < 0.25) return;
  hiResTimer = setTimeout(render, 300);
}
function updateIndicator() {
  const view = pagesInView(currentPage);
  const label = view.length > 1 ? `${view[0]}-${view[1]}` : `${view[0]}`;
  indicator.textContent = `${label} / ${numPages}`;
  slider.max = String(numPages);
  slider.value = String(currentPage);
  slider.classList.toggle('rtl', settings.binding === 'rtl');
}

// ---------------------------------------------------------------
// 読書位置（localStorage に本ごとに保存）
// 同じ本かどうかは「ファイル名 + サイズ」で判定する
// ---------------------------------------------------------------
const POSITIONS_KEY = 'manga-viewer:positions';
const POSITIONS_LIMIT = 300;
let bookId = null;

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}'); } catch { return {}; }
}

function savePosition() {
  if (!bookId) return;
  const all = loadPositions();
  all[bookId] = { page: currentPage, numPages, updated: Date.now() };
  // 古いものから消して件数を抑える
  const ids = Object.keys(all);
  if (ids.length > POSITIONS_LIMIT) {
    ids.sort((a, b) => all[a].updated - all[b].updated)
      .slice(0, ids.length - POSITIONS_LIMIT)
      .forEach((id) => delete all[id]);
  }
  try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(all)); } catch { /* 保存できなくても続ける */ }
}

function savedPage(id) {
  const p = loadPositions()[id]?.page;
  return Number.isInteger(p) && p >= 1 && p <= numPages ? p : 1;
}

// 画面下に短いメッセージを出す
let toastTimer = null;
function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

// ---------------------------------------------------------------
// ファイルを開く / 閉じる
// ---------------------------------------------------------------
// 端末からファイルを選んで開く。開いた本は「最近読んだ本」として端末に保存する
async function openFile(file) {
  if (!file) return;
  const id = `${file.name}|${file.size}`;
  await openBook(id, file.name, async () => {
    const data = await file.arrayBuffer();
    // PDF.js に渡すとデータが移動して使えなくなるので、先に保存用のコピーを作る
    const blob = new Blob([data], { type: 'application/pdf' });
    saveBook({ id, name: file.name, size: file.size, blob })
      .then(refreshShelf)
      .catch((e) => console.warn('本を端末に保存できませんでした', e));
    return data;
  });
}

// 「最近読んだ本」から開く
async function openRecent(id) {
  let rec;
  try {
    rec = await getBook(id);
  } catch (e) {
    console.error(e);
  }
  if (!rec) {
    refreshShelf();
    return;
  }
  touchBook(id).catch(() => {});
  await openBook(id, rec.name, () => rec.blob.arrayBuffer());
}

async function openBook(id, name, loadData) {
  shelfError.hidden = true;
  shelf.hidden = true;
  viewer.hidden = false;
  viewer.classList.remove('menu-open');
  renderSeq++;
  cancelTasks();
  clearViewCache();
  pagesEl.replaceChildren();
  loading.hidden = false;
  bookTitle.textContent = titleOf(name);
  bookId = null;

  try {
    const data = await loadData();
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    numPages = pdfDoc.numPages;
    loading.hidden = true;
    bookId = id;
    const start = savedPage(bookId);
    showPage(start);
    if (start > 1) showToast(`前回の続き（${start}ページ）から表示しています`);
    makeThumbnailLater(id, pdfDoc);
  } catch (e) {
    console.error(e);
    closeBook();
    shelfError.textContent = `PDFを開けませんでした（${e.message || e}）`;
    shelfError.hidden = false;
  }
}

async function closeBook() {
  renderSeq++;
  cancelTasks();
  clearViewCache();
  bookId = null;
  if (pdfDoc) {
    await pdfDoc.destroy();
    pdfDoc = null;
  }
  pagesEl.replaceChildren();
  resetZoom();
  loading.hidden = true;
  viewer.hidden = true;
  shelf.hidden = false;
  fileInput.value = '';
  refreshShelf();
}

// 閲覧画面から本棚へ。本はメモリに残したままにして、「‹ 戻る」ですぐ再開できるようにする
function goToShelf() {
  renderSeq++;
  cancelTasks();
  resetZoom();
  viewer.classList.remove('menu-open');
  viewer.hidden = true;
  shelf.hidden = false;
  fileInput.value = '';
  window.scrollTo(0, 0);
  refreshShelf();
}

// 本棚の「‹ 戻る」：直前に読んでいた本へ
let lastRecentId = null; // メモリに本が無いとき（アプリ再起動後など）に開く本
async function backToBook() {
  if (pdfDoc && bookId) {
    shelf.hidden = true;
    viewer.hidden = false;
    showPage(currentPage);
  } else if (lastRecentId) {
    await openRecent(lastRecentId);
  }
}

const titleOf = (name) => name.replace(/\.pdf$/i, '');

// 表紙（1ページ目）の小さな画像を作って保存する（まだ無いときだけ）
function makeThumbnailLater(id, doc, tries = 4) {
  setTimeout(async () => {
    try {
      if (doc !== pdfDoc) return;
      const rec = await getBook(id);
      // 端末への保存がまだ終わっていなければ、少し待ってやり直す
      if (!rec) {
        if (tries > 1) makeThumbnailLater(id, doc, tries - 1);
        return;
      }
      if (rec.thumb) return;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      // 画面表示用の描画が中断されたときに巻き込まれないよう、別の intent で描く
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
      if (blob) {
        await setThumbnail(id, blob);
        refreshShelf();
      }
    } catch (e) {
      if (e?.name === 'RenderingCancelledException' && tries > 1) {
        makeThumbnailLater(id, doc, tries - 1);
      } else {
        console.warn('サムネイルを作れませんでした', e);
      }
    }
  }, 1500);
}

// ---------------------------------------------------------------
// 本棚：最近読んだ本 / ダウンロード済みの本
// ---------------------------------------------------------------
const recentSection = $('recent');
const recentList = $('recent-list');
const downloadedSection = $('downloaded');
const downloadedList = $('downloaded-list');
const storageInfo = $('storage-info');
let thumbUrls = [];
let localBooks = [];               // 端末に保存している本（PDF本体なし）
let downloadedByFileId = new Map(); // Google Drive のファイルID → 端末の本

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

function thumbUrl(blob) {
  const url = URL.createObjectURL(blob);
  thumbUrls.push(url);
  return url;
}

// 本の一覧の1行（表紙・題名・情報・右端のボタン）
function bookRow({ title, thumb, meta, metaClass = '', onOpen, action }) {
  const li = document.createElement('li');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'recent-open';
  open.addEventListener('click', onOpen);

  const thumbBox = document.createElement('div');
  thumbBox.className = 'recent-thumb';
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    thumbBox.append(img);
  }

  const info = document.createElement('div');
  info.className = 'recent-info';
  const t = document.createElement('div');
  t.className = 'recent-title';
  t.textContent = title;
  const m = document.createElement('div');
  m.className = `recent-meta ${metaClass}`.trim();
  m.textContent = meta;
  info.append(t, m);
  open.append(thumbBox, info);
  li.append(open);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-delete';
    btn.textContent = action.label;
    btn.setAttribute('aria-label', `${title} を${action.label}`);
    btn.addEventListener('click', action.onClick);
    li.append(btn);
  }
  return { li, meta: m };
}

function progressText(pos) {
  return pos?.numPages ? `${pos.page} / ${pos.numPages}ページ` : '';
}

function savedBookRow(b, positions) {
  const isDrive = b.source === 'drive';
  return bookRow({
    title: titleOf(b.name),
    thumb: b.thumb ? thumbUrl(b.thumb) : '',
    meta: [progressText(positions[b.id]), formatBytes(b.size)].filter(Boolean).join('・'),
    onOpen: () => openRecent(b.id),
    action: {
      label: '削除',
      onClick: async () => {
        const note = isDrive ? 'Google Drive のファイルは消えません' : '元のPDFファイルは消えません';
        if (!confirm(`「${titleOf(b.name)}」を端末から削除しますか？\n（${note}。読書位置は残ります）`)) return;
        await deleteBook(b.id).catch((e) => console.warn(e));
        refreshShelf();
      },
    },
  }).li;
}

async function refreshShelf() {
  try {
    localBooks = await listBooks();
  } catch (e) {
    console.warn('端末の本を読み込めませんでした', e);
    localBooks = [];
  }
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  const positions = loadPositions();
  downloadedByFileId = new Map(localBooks.filter((b) => b.source === 'drive').map((b) => [b.fileId, b]));

  // 最近読んだ本（ダウンロードしただけでまだ開いていない本は出さない）
  const recent = localBooks.filter((b) => b.lastOpened > 0).slice(0, RECENT_LIMIT);
  recentList.replaceChildren(...recent.map((b) => savedBookRow(b, positions)));
  recentSection.hidden = recent.length === 0;
  lastRecentId = recent[0]?.id || null;
  $('btn-back').hidden = !((pdfDoc && bookId) || lastRecentId);

  // Google Drive からダウンロード済みの本（名前順）
  const downloaded = [...downloadedByFileId.values()]
    .sort((a, b) => nameCollator.compare(a.name, b.name));
  const keepOpen = downloadedSection.open;
  downloadedList.replaceChildren(...downloaded.map((b) => savedBookRow(b, positions)));
  downloadedSection.querySelector('summary').textContent =
    `ダウンロード済みの本（${downloaded.length}冊・${formatBytes(downloaded.reduce((n, b) => n + b.size, 0))}）`;
  downloadedSection.hidden = downloaded.length === 0;
  downloadedSection.open = keepOpen;

  renderDrive();

  try {
    const est = await navigator.storage?.estimate?.();
    storageInfo.textContent = est?.usage != null
      ? `端末の使用容量：${formatBytes(est.usage)}${est.quota ? `（上限の目安 ${formatBytes(est.quota)}）` : ''}`
      : '';
  } catch {
    storageInfo.textContent = '';
  }
}

const nameCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------
// 本棚：Google Drive
// ---------------------------------------------------------------
drive.init(GOOGLE_CLIENT_ID);

const DRIVE_PATH_KEY = 'manga-viewer:gdrive-path';
const driveStatus = $('drive-status');
const driveError = $('drive-error');
const driveSignin = $('drive-signin');
const driveSignout = $('drive-signout');
const drivePathEl = $('drive-path');
const driveList = $('drive-list');

let drivePath = loadDrivePath();   // 開いているフォルダまでの道筋 [{ id, name }]
let driveItems = null;             // 開いているフォルダの中身（未取得なら null）
let driveLoading = false;
const downloads = new Map();       // ダウンロード中：ファイルID → { received, total, controller, metaEl }
let driveThumbUrls = [];

function loadDrivePath() {
  try {
    const p = JSON.parse(localStorage.getItem(DRIVE_PATH_KEY) || 'null');
    if (Array.isArray(p) && p.length && p.every((f) => f?.id && f?.name)) return p;
  } catch { /* 読めなければ最初から */ }
  return [drive.ROOT];
}
function saveDrivePath() {
  try { localStorage.setItem(DRIVE_PATH_KEY, JSON.stringify(drivePath)); } catch { /* 続ける */ }
}

function showDriveError(text) {
  driveError.textContent = text;
  driveError.hidden = !text;
}

// ログインし直す（Google の画面へ移動し、戻ってきたら pending の操作を続ける）。
// 直前にログインしたばかりなのに失敗した場合は、行ったり来たりしないようエラーを出して止める
function reSignIn(pending) {
  const last = Number(sessionStorage.getItem('manga-viewer:gdrive-last-signin') || 0);
  if (Date.now() - last < 30_000) {
    showDriveError('Google Drive にログインできませんでした。少し待ってからもう一度お試しください');
    return;
  }
  try { sessionStorage.setItem('manga-viewer:gdrive-last-signin', String(Date.now())); } catch { /* 続ける */ }
  drive.signIn(pending);
}

async function loadDriveFolder() {
  if (!drive.isConfigured() || !drive.hasValidToken()) { renderDrive(); return; }
  const folder = drivePath[drivePath.length - 1];
  driveLoading = true;
  driveItems = null;
  showDriveError('');
  renderDrive();
  try {
    const items = await drive.listFolder(folder.id);
    if (folder !== drivePath[drivePath.length - 1]) return; // 途中で別のフォルダへ移った
    driveItems = items;
  } catch (e) {
    if (folder !== drivePath[drivePath.length - 1]) return;
    if (e instanceof drive.AuthError) {
      reSignIn({ type: 'list' });
    } else if (e instanceof TypeError) {
      showDriveError('Google Drive につながりません（オフラインかもしれません）。ダウンロード済みの本は読めます');
    } else if (drivePath.length > 1 && /\b404\b/.test(e.message)) {
      drivePath = [drive.ROOT]; // 覚えていたフォルダが無くなっていた
      saveDrivePath();
      driveLoading = false;
      loadDriveFolder();
      return;
    } else {
      showDriveError(e.message || String(e));
    }
  } finally {
    if (folder === drivePath[drivePath.length - 1]) {
      driveLoading = false;
      renderDrive();
    }
  }
}

function openDriveFolder(path) {
  drivePath = path;
  saveDrivePath();
  loadDriveFolder();
}

function renderDrive() {
  const configured = drive.isConfigured();
  const signedIn = configured && drive.isSignedIn();
  const tokenOk = signedIn && drive.hasValidToken();

  driveSignout.hidden = !signedIn;
  driveSignin.hidden = !configured || (tokenOk && driveItems !== null) || driveLoading;
  driveSignin.textContent = signedIn ? 'Google Drive の本棚を表示' : 'Google Drive にログイン';

  if (!configured) {
    driveStatus.textContent = '未設定です（config.js に Google のクライアントIDを入れると使えます）';
  } else if (!signedIn) {
    driveStatus.textContent = 'プライベートのアカウントでログインしてください';
  } else {
    driveStatus.textContent = driveLoading ? `${drive.account() || 'ログイン中'}・読み込み中…` : drive.account();
  }

  // フォルダの道筋（マイドライブ › マンガ › …）
  drivePathEl.hidden = !tokenOk;
  drivePathEl.replaceChildren(...drivePath.flatMap((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = f.name;
    b.disabled = i === drivePath.length - 1;
    b.addEventListener('click', () => openDriveFolder(drivePath.slice(0, i + 1)));
    if (i === 0) return [b];
    const sep = document.createElement('span');
    sep.textContent = '›';
    return [sep, b];
  }));

  driveThumbUrls.forEach((u) => URL.revokeObjectURL(u));
  driveThumbUrls = [];
  if (!tokenOk || !driveItems) {
    driveList.replaceChildren();
    return;
  }
  const positions = loadPositions();
  const rows = driveItems.map((item) => (item.isFolder ? folderRow(item) : drivePdfRow(item, positions)));
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'このフォルダにはPDFもフォルダもありません';
    rows.push(li);
  }
  driveList.replaceChildren(...rows);
}

function folderRow(item) {
  const li = document.createElement('li');
  li.className = 'folder';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'recent-open';
  const icon = document.createElement('div');
  icon.className = 'folder-icon';
  icon.textContent = '📁';
  const name = document.createElement('div');
  name.className = 'recent-title';
  name.textContent = item.name;
  open.append(icon, name);
  open.addEventListener('click', () => openDriveFolder([...drivePath, { id: item.id, name: item.name }]));
  li.append(open);
  return li;
}

function drivePdfRow(item, positions) {
  const saved = downloadedByFileId.get(item.id);
  const dl = downloads.get(item.id);
  let meta = formatBytes(item.size);
  let metaClass = '';
  let action;
  if (dl) {
    meta = downloadText(dl);
    action = { label: '中止', onClick: () => dl.controller.abort() };
  } else if (saved) {
    meta = ['端末にあり', progressText(positions[saved.id]), formatBytes(saved.size)].filter(Boolean).join('・');
    metaClass = 'downloaded';
    action = {
      label: '削除',
      onClick: async () => {
        if (!confirm(`「${titleOf(item.name)}」を端末から削除しますか？\n（Google Drive のファイルは消えません。読書位置は残ります）`)) return;
        await deleteBook(saved.id).catch((e) => console.warn(e));
        refreshShelf();
      },
    };
  } else {
    action = { label: 'ダウンロード', onClick: () => downloadDriveBook(item, false) };
  }
  const { li, meta: metaEl } = bookRow({
    title: titleOf(item.name),
    thumb: saved?.thumb ? driveThumbUrl(saved.thumb) : item.thumbnail,
    meta,
    metaClass,
    onOpen: () => (saved ? openRecent(saved.id) : downloadDriveBook(item, true)),
    action,
  });
  if (dl) dl.metaEl = metaEl;
  return li;
}

function driveThumbUrl(blob) {
  const url = URL.createObjectURL(blob);
  driveThumbUrls.push(url);
  return url;
}

function downloadText(dl) {
  if (!dl.total) return `ダウンロード中… ${formatBytes(Math.max(dl.received, 1))}`;
  return `ダウンロード中… ${Math.floor((dl.received / dl.total) * 100)}%（${formatBytes(dl.total)}）`;
}

// Google Drive の本を端末に保存する。openAfter なら終わったらそのまま開く
async function downloadDriveBook(item, openAfter) {
  if (downloads.has(item.id)) return;
  const pending = { type: openAfter ? 'open' : 'download', item };
  if (!drive.hasValidToken()) { reSignIn(pending); return; }

  const dl = { received: 0, total: item.size, controller: new AbortController(), metaEl: null };
  downloads.set(item.id, dl);
  showDriveError('');
  renderDrive();
  try {
    const blob = await drive.download(item.id, {
      size: item.size,
      signal: dl.controller.signal,
      onProgress: (received, total) => {
        dl.received = received;
        dl.total = total;
        if (dl.metaEl) dl.metaEl.textContent = downloadText(dl);
      },
    });
    const id = `gd:${item.id}`;
    await saveBook({
      id, name: item.name, size: blob.size, blob,
      source: 'drive', fileId: item.id, lastOpened: 0,
    });
    downloads.delete(item.id);
    // 本棚を見ているときだけ開く（別の本を読み始めていたら邪魔しない）
    if (openAfter && !shelf.hidden) await openRecent(id);
    else refreshShelf();
  } catch (e) {
    downloads.delete(item.id);
    if (e?.name === 'AbortError') {
      // 中止した
    } else if (e instanceof drive.AuthError) {
      reSignIn(pending);
    } else if (e instanceof TypeError) {
      showDriveError(`「${titleOf(item.name)}」をダウンロードできませんでした（通信が切れたかもしれません）`);
    } else if (e?.name === 'QuotaExceededError') {
      showDriveError('端末の空き容量が足りません。読み終わった本を削除してください');
    } else {
      showDriveError(`「${titleOf(item.name)}」をダウンロードできませんでした（${e.message || e}）`);
    }
    renderDrive();
  }
}

driveSignin.addEventListener('click', () => {
  if (drive.hasValidToken()) loadDriveFolder();
  else drive.signIn({ type: 'list' }, { chooseAccount: !drive.isSignedIn() });
});
driveSignout.addEventListener('click', () => {
  if (downloads.size && !confirm('ダウンロード中の本があります。中止してログアウトしますか？')) return;
  if (!downloads.size && !confirm('Google Drive からログアウトしますか？\n（ダウンロード済みの本は端末に残ります）')) return;
  downloads.forEach((dl) => dl.controller.abort());
  drive.signOut();
  driveItems = null;
  drivePath = [drive.ROOT];
  saveDrivePath();
  showDriveError('');
  renderDrive();
});

// 起動時：Google のログイン画面から戻ってきたなら、その続きをする
async function startDrive() {
  let result = null;
  try {
    result = await drive.takeRedirectResult();
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  }
  if (result && !result.ok) showDriveError(result.error);
  if (drive.hasValidToken()) await loadDriveFolder();
  else renderDrive();

  const p = result?.ok ? result.pending : null;
  if (p?.item && (p.type === 'open' || p.type === 'download')) {
    downloadDriveBook(p.item, p.type === 'open');
  }
}

refreshShelf();
startDrive();

fileInput.addEventListener('change', () => openFile(fileInput.files[0]));

// PC: ドラッグ＆ドロップ
shelf.addEventListener('dragover', (e) => {
  e.preventDefault();
  shelf.classList.add('dragover');
});
shelf.addEventListener('dragleave', () => shelf.classList.remove('dragover'));
shelf.addEventListener('drop', (e) => {
  e.preventDefault();
  shelf.classList.remove('dragover');
  const file = [...e.dataTransfer.files].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (file) openFile(file);
});

// ---------------------------------------------------------------
// 操作（タップ・スワイプ）
// ---------------------------------------------------------------

// 画面の左右どちらが「次へ」か
function goLeft()  { settings.binding === 'rtl' ? goNext() : goPrev(); }
function goRight() { settings.binding === 'rtl' ? goPrev() : goNext(); }

function toggleMenu(force) {
  viewer.classList.toggle('menu-open', force);
}

// 押している指（ポインタ）の位置
const pointers = new Map();
// 現在のジェスチャ
//   single: 1本指（タップ / スワイプ / 拡大中のドラッグ移動）
//   pinch : 2本指（拡大）
let gesture = null;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function startSingle(p, usedMultiTouch) {
  gesture = {
    type: 'single',
    sx: p.x, sy: p.y,   // 開始位置
    lx: p.x, ly: p.y,   // 直前の位置
    t: Date.now(),
    multi: usedMultiTouch, // 途中で2本指を使ったらタップ・スワイプ扱いしない
  };
}

stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { stage.setPointerCapture(e.pointerId); } catch { /* 取得できなくても続ける */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    startSingle({ x: e.clientX, y: e.clientY }, false);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: distance(a, b), s: zoom.s, mid: midpoint(a, b) };
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const m = midpoint(a, b);
    // 2本指の中点の移動に合わせてずらし、指の間隔に合わせて拡大
    panBy(m.x - gesture.mid.x, m.y - gesture.mid.y);
    gesture.mid = m;
    zoomAt(gesture.s * (distance(a, b) / gesture.dist), m.x, m.y);
  } else if (gesture.type === 'single' && zoom.s > 1) {
    // 拡大中の1本指ドラッグ = 移動
    panBy(e.clientX - gesture.lx, e.clientY - gesture.ly);
    gesture.lx = e.clientX;
    gesture.ly = e.clientY;
  }
});

function onPointerEnd(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    // ピンチインで原寸近くまで戻したら、ぴったり原寸に戻す
    if (zoom.s < 1.15) resetZoom();
    if (pointers.size === 1) {
      // 1本指が残ったら、そのまま移動を続けられるようにする
      const [p] = [...pointers.values()];
      startSingle(p, true);
    } else if (pointers.size === 0) {
      gesture = null;
    }
    return;
  }

  if (pointers.size > 0) return;
  const g = gesture;
  gesture = null;
  if (cancelled || g.multi) return;

  const dx = e.clientX - g.sx;
  const dy = e.clientY - g.sy;
  const dt = Date.now() - g.t;
  const isTap = Math.abs(dx) < 10 && Math.abs(dy) < 10;

  if (viewer.classList.contains('menu-open')) {
    if (isTap) toggleMenu(false);
    return;
  }

  // 拡大中：左右のタップ・スワイプではページを送らない（中央タップでメニューのみ）
  if (zoom.s > 1) {
    const w = stage.clientWidth;
    if (isTap && e.clientX >= w / 3 && e.clientX <= (w * 2) / 3) toggleMenu(true);
    return;
  }

  // スワイプ：指を右へ動かす = 左側のページへ進む（右綴じなら次ページ）
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
    if (dx > 0) goLeft(); else goRight();
    return;
  }

  // タップ
  if (isTap) {
    const w = stage.clientWidth;
    const x = e.clientX;
    if (x < w / 3) goLeft();
    else if (x > (w * 2) / 3) goRight();
    else toggleMenu(true);
  }
}

stage.addEventListener('pointerup', (e) => onPointerEnd(e, false));
stage.addEventListener('pointercancel', (e) => onPointerEnd(e, true));

// PC：トラックパッドのピンチ / Ctrl+ホイールで拡大、拡大中のホイールで移動
stage.addEventListener('wheel', (e) => {
  if (!pdfDoc) return;
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAt(zoom.s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  } else if (zoom.s > 1) {
    panBy(-e.deltaX, -e.deltaY);
  }
}, { passive: false });

// iOS Safari の画面全体のズームを止める
document.addEventListener('gesturestart', (e) => e.preventDefault());
viewer.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// PCのキーボード操作
document.addEventListener('keydown', (e) => {
  if (viewer.hidden || settingsDialog.open) return;
  switch (e.key) {
    case 'ArrowLeft': goLeft(); break;
    case 'ArrowRight': goRight(); break;
    case ' ': e.shiftKey ? goPrev() : goNext(); break;
    case 'Escape': toggleMenu(); break;
    case '0': resetZoom(); break;
    default: return;
  }
  e.preventDefault();
});

// メニュー
$('btn-close').addEventListener('click', goToShelf);
$('btn-back').addEventListener('click', backToBook);
$('btn-settings').addEventListener('click', openSettings);
slider.addEventListener('input', () => {
  indicator.textContent = `${slider.value} / ${numPages}`;
});
slider.addEventListener('change', () => showPage(Number(slider.value)));

// ---------------------------------------------------------------
// 設定ダイアログ
// ---------------------------------------------------------------
function openSettings() {
  settingsForm.binding.value = settings.binding;
  settingsForm.layout.value = settings.layout;
  settingsForm.coverSingle.checked = settings.coverSingle;
  syncLayoutSetting();
  settingsDialog.showModal();
}

// 狭い画面では見開きの切り替えUIを出さない
function syncLayoutSetting() {
  const wide = isWideScreen();
  $('layout-setting').hidden = !wide;
  $('layout-note').hidden = wide;
  settingsForm.coverSingle.disabled = settingsForm.layout.value !== 'spread';
}

settingsForm.addEventListener('change', () => {
  settings.binding = settingsForm.binding.value || settings.binding;
  settings.layout = settingsForm.layout.value || settings.layout;
  settings.coverSingle = settingsForm.coverSingle.checked;
  saveSettings();
  syncLayoutSetting();
  if (pdfDoc) showPage(currentPage);
});

// ---------------------------------------------------------------
// 画面サイズの変化で判定し直す
// ---------------------------------------------------------------
let resizeTimer = null;
function onLayoutChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (settingsDialog.open) syncLayoutSetting();
    if (pdfDoc && !viewer.hidden) showPage(currentPage);
  }, 150);
}
window.addEventListener('resize', onLayoutChange);
wideQuery.addEventListener('change', onLayoutChange);

// ---------------------------------------------------------------
// PWA：Service Worker の登録と、保存データの固定の依頼
// ---------------------------------------------------------------
const isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && isLocalDev) {
  // 開発中は古いキャッシュで混乱しないよう、Service Worker を使わない
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
  caches?.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
} else if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service Worker の登録に失敗', e));
  // 新しい版に切り替わったら、本を読んでいないときだけ再読み込みする
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !pdfDoc) location.reload();
  });
}

// ブラウザが容量不足のときに勝手に消さないよう依頼する（読書位置などを守るため）
navigator.storage?.persist?.().catch(() => {});

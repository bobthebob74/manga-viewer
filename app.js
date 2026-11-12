import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

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
async function openFile(file) {
  if (!file) return;
  shelfError.hidden = true;
  shelf.hidden = true;
  viewer.hidden = false;
  viewer.classList.remove('menu-open');
  renderSeq++;
  cancelTasks();
  clearViewCache();
  pagesEl.replaceChildren();
  loading.hidden = false;
  bookTitle.textContent = file.name.replace(/\.pdf$/i, '');
  bookId = null;

  try {
    const data = await file.arrayBuffer();
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    numPages = pdfDoc.numPages;
    loading.hidden = true;
    bookId = `${file.name}|${file.size}`;
    const start = savedPage(bookId);
    showPage(start);
    if (start > 1) showToast(`前回の続き（${start}ページ）から表示しています`);
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
}

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
$('btn-close').addEventListener('click', closeBook);
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
    if (pdfDoc) showPage(currentPage);
  }, 150);
}
window.addEventListener('resize', onLayoutChange);
wideQuery.addEventListener('change', onLayoutChange);

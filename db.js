// 端末内（IndexedDB）に本のPDFと表紙サムネイルを保存する
//   books: { id, name, size, blob(PDF), thumb(画像Blob|null), lastOpened }
//   id は「ファイル名|サイズ」（読書位置の記録と同じ）

const DB_NAME = 'manga-viewer';
const DB_VERSION = 1;
const STORE = 'books';
export const RECENT_LIMIT = 5; // 端末に残す最近の本の冊数

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 新しい版のアプリが DB を作り直すときに邪魔しないよう、接続を閉じる
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getBook(id) {
  return run('readonly', (s) => s.get(id));
}

// 一覧（PDF本体は読み込まず、表示に必要な情報だけ返す）。新しい順
export async function listBooks() {
  const all = await run('readonly', (s) => s.getAll());
  return (all || [])
    .map(({ id, name, size, thumb, lastOpened }) => ({ id, name, size, thumb, lastOpened }))
    .sort((a, b) => b.lastOpened - a.lastOpened);
}

// 本を保存する（既にあればサムネイルは引き継ぐ）。古い本は RECENT_LIMIT 冊を超えたら消す
export async function saveBook({ id, name, size, blob }) {
  const old = await getBook(id);
  await run('readwrite', (s) => s.put({
    id, name, size, blob,
    thumb: old?.thumb || null,
    lastOpened: Date.now(),
  }));
  await pruneBooks();
}

export async function touchBook(id) {
  const rec = await getBook(id);
  if (!rec) return;
  rec.lastOpened = Date.now();
  await run('readwrite', (s) => s.put(rec));
}

export async function setThumbnail(id, thumb) {
  const rec = await getBook(id);
  if (!rec) return;
  rec.thumb = thumb;
  await run('readwrite', (s) => s.put(rec));
}

export function deleteBook(id) {
  return run('readwrite', (s) => s.delete(id));
}

async function pruneBooks() {
  const books = await listBooks();
  for (const b of books.slice(RECENT_LIMIT)) await deleteBook(b.id);
}

// クラウド本棚のアダプタ：Google Drive
// ---------------------------------------------------------------
// 自前のサーバーを使わないため、OAuth の「トークン方式（implicit）」でログインする。
//   ・ログインは Google の画面へ移動して戻ってくる方式（ポップアップを使わない）
//     → iPhone のホーム画面アプリでもポップアップがブロックされない
//   ・トークンの有効期間は約1時間。切れていたら、次に操作したときに自動でログインし直す
//     （一度許可していれば、Google の画面は一瞬表示されて戻ってくるだけ）
//   ・login_hint にプライベートのアカウントを指定して、仕事用のアカウントを選ばないようにする
//
// 別のクラウドに差し替えるときは、同じ形の関数（下の export）を持つファイルを作る。
//   isConfigured / isSignedIn / hasValidToken / signIn / signOut / takeRedirectResult
//   listFolder / download / account / ROOT

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3';

const TOKEN_KEY = 'manga-viewer:gdrive-token';     // { token, expires }
const ACCOUNT_KEY = 'manga-viewer:gdrive-account'; // ログインしたアカウントのメールアドレス
const STATE_KEY = 'manga-viewer:gdrive-state';     // ログイン中の確認用の乱数と、戻ってきたら続ける操作

export const ROOT = { id: 'root', name: 'マイドライブ' };
export const FOLDER = 'application/vnd.google-apps.folder';

let clientId = '';

export class AuthError extends Error {
  constructor(message = 'Google Drive へのログインが必要です') {
    super(message);
    this.name = 'AuthError';
  }
}

export function init(id) { clientId = (id || '').trim(); }
export const isConfigured = () => !!clientId;

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJSON(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できなくても続ける */ }
}

export const account = () => localStorage.getItem(ACCOUNT_KEY) || '';
// 一度でもログインしたか（トークンが切れていても true）
export const isSignedIn = () => !!account() || !!readJSON(TOKEN_KEY);

function token() {
  const t = readJSON(TOKEN_KEY);
  // 期限の1分前からは切れたものとして扱う
  return t && t.expires - 60_000 > Date.now() ? t.token : null;
}
export const hasValidToken = () => !!token();

// アプリのURL（Google Cloud の「承認済みのリダイレクト URI」に登録したものと同じにする）
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

// Google のログイン画面へ移動する。戻ってきたら pending の操作を続けられるよう保存しておく
export function signIn(pending = null, { chooseAccount = false } = {}) {
  if (!clientId) throw new Error('Google のクライアントIDが設定されていません（config.js）');
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  writeJSON(STATE_KEY, { state, pending });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  const hint = account();
  if (hint && !chooseAccount) params.set('login_hint', hint);
  else params.set('prompt', 'select_account');
  location.assign(`${AUTH_URL}?${params}`);
}

export function signOut() {
  const t = readJSON(TOKEN_KEY);
  writeJSON(TOKEN_KEY, null);
  localStorage.removeItem(ACCOUNT_KEY);
  // アプリへの許可を取り消す（失敗しても端末側はログアウト済み）
  if (t?.token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: 'POST' })
      .catch(() => {});
  }
}

// Google のログイン画面から戻ってきたときの処理。
// 戻り値: null（ログインから戻ったのではない） / { ok: true, pending } / { ok: false, error }
export async function takeRedirectResult() {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search); // URLからトークンを消す

  const saved = readJSON(STATE_KEY);
  writeJSON(STATE_KEY, null);
  if (!saved || p.get('state') !== saved.state) {
    return { ok: false, error: 'ログインの確認に失敗しました。もう一度お試しください' };
  }
  if (p.get('error')) {
    const msg = p.get('error') === 'access_denied' ? 'ログインがキャンセルされました' : `ログインできませんでした（${p.get('error')}）`;
    return { ok: false, error: msg };
  }
  if (!p.get('scope')?.split(' ').includes(SCOPE)) {
    return { ok: false, error: 'Google Drive の読み取りが許可されませんでした。ログイン時にチェックを入れてください' };
  }
  writeJSON(TOKEN_KEY, {
    token: p.get('access_token'),
    expires: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
  });

  // 次回からこのアカウントを自動で選ぶ
  try {
    const about = await api('/about?fields=user(emailAddress)');
    if (about.user?.emailAddress) localStorage.setItem(ACCOUNT_KEY, about.user.emailAddress);
  } catch (e) {
    console.warn('アカウント情報を取得できませんでした', e);
  }
  return { ok: true, pending: saved.pending };
}

async function authFetch(url, options = {}) {
  const t = token();
  if (!t) throw new AuthError();
  const res = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    writeJSON(TOKEN_KEY, null);
    throw new AuthError();
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* 本文なし */ }
    throw new Error(`Google Drive のエラー ${res.status}${detail ? `：${detail}` : ''}`);
  }
  return res;
}

async function api(path) {
  return (await authFetch(API + path)).json();
}

// 名前を「2巻 < 10巻」の順に並べる
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// フォルダの中の「フォルダ」と「PDF」を返す（フォルダが先、名前順）
export async function listFolder(folderId) {
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and `
    + `(mimeType = '${FOLDER}' or mimeType = 'application/pdf')`;
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, thumbnailLink)',
      pageSize: '1000',
      spaces: 'drive',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await api(`/files?${params}`);
    items.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items
    .map((f) => ({
      id: f.id,
      name: f.name,
      isFolder: f.mimeType === FOLDER,
      size: Number(f.size || 0),
      modified: f.modifiedTime,
      thumbnail: f.thumbnailLink || '',
    }))
    .sort((a, b) => (b.isFolder - a.isFolder) || collator.compare(a.name, b.name));
}

// PDFをダウンロードして Blob で返す。onProgress(受け取ったバイト数, 全体のバイト数)
export async function download(fileId, { size = 0, onProgress, signal } = {}) {
  const res = await authFetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { signal });
  const total = Number(res.headers.get('Content-Length')) || size;
  if (!res.body?.getReader) return new Blob([await res.arrayBuffer()], { type: 'application/pdf' });

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  return new Blob(chunks, { type: 'application/pdf' });
}

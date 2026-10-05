// Dropbox 연결(PKCE — 비밀키 없이) 과 파일 주고받기. 안드로이드 앱과 같은 Dropbox 앱이라 같은 폴더를 쓴다.
import { kvGet, kvSet, kvDel } from '../db.js';
import { sleep } from '../util.js';

export const APP_KEY = 'poyqgwn2nepq855';
// Dropbox 앱 설정에 이 주소가 '되돌아올 주소'로 등록돼 있으면 코드 복사 없이 바로 연결된다
const REDIRECT_PAGES = [];

export class DbxError extends Error {
  constructor(message, { status = 0, summary = '', auth = false } = {}) {
    super(message);
    this.status = status;
    this.summary = summary;
    this.auth = auth;
    this.conflict = /conflict/.test(summary);
    this.notFound = /not_found/.test(summary);
  }
}

let tok = null;

async function loadTok() {
  if (!tok) tok = await kvGet('dbx', null);
  return tok;
}

export async function isConnected() {
  const t = await loadTok();
  return !!t?.refresh;
}

export async function accountInfo() {
  return (await loadTok())?.account || null;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function redirectUri() {
  const page = location.origin + location.pathname;
  return REDIRECT_PAGES.includes(page) ? page : null;
}

export async function startAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  await kvSet('dbx_pkce', { verifier, state, at: Date.now() });
  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  const redirect = redirectUri();
  if (redirect) { params.set('redirect_uri', redirect); params.set('state', state); }
  return { url: `https://www.dropbox.com/oauth2/authorize?${params}`, redirect: !!redirect };
}

export async function finishAuth(code, { state } = {}) {
  const pkce = await kvGet('dbx_pkce');
  if (!pkce) throw new DbxError('연결을 처음부터 다시 시작해 주세요(인증 정보가 없습니다).');
  if (state && state !== pkce.state) throw new DbxError('연결 요청이 맞지 않습니다. 다시 시도해 주세요.');
  const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: pkce.verifier });
  const redirect = redirectUri();
  if (state && redirect) body.set('redirect_uri', redirect);
  let res;
  try {
    res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
  } catch {
    throw new DbxError('인터넷 연결을 확인해 주세요.');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error_description || ''; } catch { /* 무시 */ }
    throw new DbxError(/expired|invalid/i.test(msg) || res.status === 400 ? '코드가 맞지 않거나 시간이 지났습니다. "Dropbox 열기"부터 다시 해 주세요.' : `연결 실패(${res.status})`);
  }
  const data = await res.json();
  tok = { access: data.access_token, expiresAt: Date.now() + (data.expires_in || 14400) * 1000, refresh: data.refresh_token, uid: data.account_id };
  await kvSet('dbx', tok);
  await kvDel('dbx_pkce');
  try {
    const acc = await rpc('users/get_current_account', null);
    tok.account = { name: acc.name?.display_name || '', email: acc.email || '' };
    await kvSet('dbx', tok);
  } catch { /* 이름은 없어도 된다 */ }
  return tok.account || {};
}

// 되돌아오는 주소 방식으로 연결된 경우 처리
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) return false;
  const st = p.get('state');
  history.replaceState(history.state, '', location.pathname + location.hash);
  await finishAuth(code, { state: st });
  return true;
}

export async function disconnect() {
  const t = await loadTok();
  if (t?.access) {
    try { await fetch('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${t.access}` } }); } catch { /* 무시 */ }
  }
  tok = null;
  await kvDel('dbx');
}

async function refreshToken() {
  const t = await loadTok();
  if (!t?.refresh) throw new DbxError('Dropbox에 연결되어 있지 않습니다.', { auth: true });
  let res;
  try {
    res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: APP_KEY }),
    });
  } catch {
    throw new DbxError('인터넷 연결이 없습니다.', { status: 0 });
  }
  // 400·401만 '연결이 끊긴 것' — 나머지는 잠깐의 문제로 본다
  if (res.status === 400 || res.status === 401) throw new DbxError('Dropbox 연결이 끊겼습니다. 다시 연결해 주세요.', { status: res.status, auth: true });
  if (!res.ok) throw new DbxError(`Dropbox 응답 오류(${res.status})`, { status: res.status });
  const data = await res.json();
  t.access = data.access_token;
  t.expiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  tok = t;
  await kvSet('dbx', t);
  return t.access;
}

async function accessToken() {
  const t = await loadTok();
  if (!t?.refresh) throw new DbxError('Dropbox에 연결되어 있지 않습니다.', { auth: true });
  if (!t.access || Date.now() > (t.expiresAt || 0) - 60000) return refreshToken();
  return t.access;
}

// 머리글에 넣는 JSON은 ASCII만 허용
const headerJson = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function request(url, init, { retries = 3 } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const access = await accessToken();
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${access}` };
    let res;
    try {
      res = await fetch(url, { ...init, headers });
    } catch {
      if (attempt < retries) { await sleep(600 * (attempt + 1)); continue; }
      throw new DbxError('인터넷 연결이 없습니다.', { status: 0 });
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshToken();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
      await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : 700 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      let summary = '';
      try {
        const txt = await res.text();
        try { summary = JSON.parse(txt).error_summary || txt; } catch { summary = txt; }
      } catch { /* 무시 */ }
      if (res.status === 401) throw new DbxError('Dropbox 연결이 끊겼습니다. 다시 연결해 주세요.', { status: 401, summary, auth: true });
      if (res.status === 400 && /missing_scope|scope/.test(summary)) throw new DbxError('Dropbox 앱 권한이 부족합니다.', { status: 400, summary });
      throw new DbxError(`Dropbox 오류(${res.status})`, { status: res.status, summary });
    }
    return res;
  }
}

async function rpc(endpoint, args) {
  const res = await request(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: args == null ? {} : { 'Content-Type': 'application/json' },
    body: args == null ? undefined : JSON.stringify(args),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function meta(path) {
  try {
    return await rpc('files/get_metadata', { path });
  } catch (e) {
    if (e instanceof DbxError && e.status === 409) return null;
    throw e;
  }
}

export async function download(path, { onProgress } = {}) {
  let res;
  try {
    res = await request('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': headerJson({ path }) },
    });
  } catch (e) {
    if (e instanceof DbxError && e.status === 409) return null;
    throw e;
  }
  let info = null;
  try { info = JSON.parse(res.headers.get('dropbox-api-result') || 'null'); } catch { info = null; }
  const total = info?.size || Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !res.body) return { blob: await res.blob(), meta: info };
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(total ? got / total : 0, got, total);
  }
  return { blob: new Blob(chunks), meta: info };
}

const CHUNK = 8 * 1024 * 1024;

export async function upload(path, blob, { mode = 'add', autorename = false } = {}) {
  if (blob.size <= 140 * 1024 * 1024) {
    const res = await request('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path, mode, autorename, mute: true }) },
      body: blob,
    });
    return res.json();
  }
  // 큰 파일은 나눠 올린다
  let offset = 0;
  const start = await request('https://content.dropboxapi.com/2/files/upload_session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ close: false }) },
    body: blob.slice(0, CHUNK),
  });
  const { session_id: sessionId } = await start.json();
  offset = Math.min(CHUNK, blob.size);
  while (blob.size - offset > CHUNK) {
    await request('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ cursor: { session_id: sessionId, offset }, close: false }) },
      body: blob.slice(offset, offset + CHUNK),
    });
    offset += CHUNK;
  }
  const fin = await request('https://content.dropboxapi.com/2/files/upload_session/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ cursor: { session_id: sessionId, offset }, commit: { path, mode, autorename, mute: true } }) },
    body: blob.slice(offset),
  });
  return fin.json();
}

export async function list(path) {
  let data;
  try {
    data = await rpc('files/list_folder', { path, recursive: false, limit: 2000 });
  } catch (e) {
    if (e instanceof DbxError && e.status === 409) return [];
    throw e;
  }
  const entries = [...data.entries];
  while (data.has_more) {
    data = await rpc('files/list_folder/continue', { cursor: data.cursor });
    entries.push(...data.entries);
  }
  return entries;
}

export async function copy(from, to) {
  try {
    return await rpc('files/copy_v2', { from_path: from, to_path: to, autorename: false });
  } catch (e) {
    if (e instanceof DbxError && e.status === 409) return null;
    throw e;
  }
}

export async function account() {
  return rpc('users/get_current_account', null);
}

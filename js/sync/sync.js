// 자동 동기화·백업: 서재 기록(작은 JSON)은 자주, 원본 파일은 한 번만 올린다. 날마다 기록 사본도 남긴다.
// 병합 규칙: 기록마다 updatedAt이 늦은 쪽이 이긴다(지운 것도 '지움 표시'로 남겨 되살아나지 않게).
import { db, kvGet, kvSet } from '../db.js';
import { state, liveDocs, putFile, getFile, localFileHashes, noteFileStored } from '../store.js';
import { emit, on, debounce, dayKey, sha256Hex, uid, now } from '../util.js';
import * as dbx from './dropbox.js';
import { prepareMissing } from '../docs.js';

export const REMOTE = '/web/library.json.gz';
const FILES = '/web/files';
const BACKUPS = '/web/backups';
const SCHEMA = 1;

const status = { state: 'off', label: 'Dropbox 연결 안 됨', lastSync: 0, error: '' };
const listeners = new Set();
export const syncStatus = () => status;
export function onSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) { try { fn(status); } catch { /* 무시 */ } }
  emit('sync-status', status);
}

let remoteFiles = null;
let running = null;
let again = false;
let syncedSeq = 0;
let remoteRev = null;
let lastSyncAt = 0;
let blockedByNewer = false;

export async function initSync() {
  syncedSeq = (await kvGet('syncedSeq', 0)) || 0;
  remoteRev = await kvGet('remoteRev', null);
  lastSyncAt = (await kvGet('lastSyncAt', 0)) || 0;
  try {
    if (await dbx.handleRedirect()) emit('dbx-connected');
  } catch (e) {
    setStatus({ state: 'error', label: e.message, error: e.message });
  }
  if (!(await dbx.isConnected())) {
    setStatus({ state: 'off', label: 'Dropbox 연결 안 됨' });
  } else {
    setStatus({ state: 'idle', label: lastSyncAt ? '동기화됨' : '동기화 대기', lastSync: lastSyncAt });
    setTimeout(() => syncNow({ reason: 'start' }), 1200);
  }
  const soon = debounce(() => syncNow({ reason: 'change' }), 6000);
  // 읽던 위치만 바뀐 것은 몇 분에 한 번(나갈 때는 바로) — 휴대폰 데이터를 아낀다
  const posSoon = debounce(() => syncNow({ reason: 'position' }), 180000);
  let firstDirtyAt = 0;
  on('dirty', (d) => {
    if (!state.app.autoSync) return;
    if (d?.kind === 'pos') { posSoon(); return; }
    if (!firstDirtyAt) firstDirtyAt = Date.now();
    // 계속 고치고 있어도 45초 넘게 미루지 않는다
    if (Date.now() - firstDirtyAt > 45000) { firstDirtyAt = 0; soon.flush?.(); syncNow({ reason: 'max-wait' }); } else soon();
  });
  on('sync-done', () => { firstDirtyAt = 0; });
  on('flush-request', () => { if (isDirty()) syncNow({ reason: 'flush' }); });
  on('dbx-connected', () => { remoteFiles = null; syncNow({ reason: 'connect', force: true }); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isDirty() || state.statsDirty) syncNow({ reason: 'hide' });
    } else if (Date.now() - lastSyncAt > 30000) {
      syncNow({ reason: 'show' });
    }
  });
  addEventListener('online', () => syncNow({ reason: 'online' }));
  setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastSyncAt > 5 * 60000) syncNow({ reason: 'interval' }); }, 60000);
}

const isDirty = () => state.changeSeq > syncedSeq;

export function syncNow(opts = {}) {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do {
        again = false;
        await doSync(opts);
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

// 기록 파일은 gzip으로 줄여 올린다(대개 5~8배 작아진다)
export async function encodePayload(obj) {
  const raw = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  if (typeof CompressionStream === 'undefined') return raw;
  return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function decodePayload(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }
  return JSON.parse(await blob.text());
}

function payload() {
  return {
    app: 'gargantua-web',
    schema: SCHEMA,
    savedAt: Date.now(),
    device: state.deviceId,
    docs: [...state.docs.values()],
    pos: [...state.pos.values()],
    anns: [...state.anns.values()],
    rev: [...state.rev.values()],
    stats: state.stats,
  };
}

async function doSync({ reason = '', force = false } = {}) {
  if (!(await dbx.isConnected())) { setStatus({ state: 'off', label: 'Dropbox 연결 안 됨' }); return; }
  if (!navigator.onLine) { setStatus({ state: 'idle', label: '오프라인 — 연결되면 동기화' }); return; }
  setStatus({ state: 'busy', label: '동기화 중' });
  try {
    let uploaded = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const m = await dbx.meta(REMOTE);
      let needUpload = false;
      if (m && (m.rev !== remoteRev || force)) {
        const got = await dbx.download(REMOTE);
        const data = got ? await decodePayload(got.blob) : null;
        if (data) {
          if (data.app !== 'gargantua-web') throw new Error('Dropbox의 서재 파일 형식을 알 수 없습니다.');
          if ((data.schema || 1) > SCHEMA) {
            blockedByNewer = true;
            throw new Error('더 새 버전의 Gargantua가 쓴 기록입니다. 앱을 새로 고쳐 주세요.');
          }
          const res = await applyRemote(data);
          needUpload = res.needUpload;
        }
        remoteRev = m.rev;
        await kvSet('remoteRev', remoteRev);
        force = false;
      } else if (!m) {
        remoteRev = null;
        needUpload = true;
      }
      if (!needUpload && !isDirty() && !state.statsDirty) break;
      const seq = state.changeSeq;
      const body = await encodePayload(payload());
      try {
        const res = await dbx.upload(REMOTE, body, { mode: m ? { '.tag': 'update', update: m.rev } : 'add' });
        remoteRev = res.rev;
        syncedSeq = Math.max(syncedSeq, seq);
        state.statsDirty = false;
        await kvSet('remoteRev', remoteRev);
        await kvSet('syncedSeq', syncedSeq);
        uploaded = true;
        break;
      } catch (e) {
        if (e instanceof dbx.DbxError && e.conflict) { force = false; continue; }
        throw e;
      }
    }
    await uploadMissingFiles();
    await dailySnapshot();
    lastSyncAt = Date.now();
    await kvSet('lastSyncAt', lastSyncAt);
    setStatus({ state: 'idle', label: '동기화됨', lastSync: lastSyncAt, error: '' });
    emit('sync-done', { uploaded, reason });
    setTimeout(() => prepareMissing({ fetchFile: (d) => fetchRemoteFile(d) }).catch(() => {}), 1500);
  } catch (e) {
    console.warn('동기화 실패', e);
    const msg = e?.message || String(e);
    if (e instanceof dbx.DbxError && e.auth) setStatus({ state: 'error', label: '다시 연결이 필요합니다', error: msg });
    else if (e instanceof dbx.DbxError && e.status === 0) setStatus({ state: 'idle', label: '오프라인 — 연결되면 동기화', error: '' });
    else setStatus({ state: 'error', label: '동기화 실패', error: msg });
  }
}

// 다른 기기의 기록 합치기
export async function applyRemote(data, { source = 'sync' } = {}) {
  let changed = false;
  let needUpload = false;
  const putDocs = [];
  const putPos = [];
  const putAnns = [];
  const putRev = [];
  const removedDocs = [];
  const remoteIds = { docs: new Set(), pos: new Set(), anns: new Set(), rev: new Set() };
  const take = (l, r) => !l || (r.updatedAt || 0) > (l.updatedAt || 0);

  for (const r of data.docs || []) {
    if (!r?.id) continue;
    remoteIds.docs.add(r.id);
    const l = state.docs.get(r.id);
    if (take(l, r)) {
      state.docs.set(r.id, r);
      putDocs.push(r);
      changed = true;
      if (r.deleted && l && !l.deleted) removedDocs.push(l);
    } else if ((l.updatedAt || 0) > (r.updatedAt || 0)) needUpload = true;
  }
  for (const r of data.pos || []) {
    if (!r?.docId) continue;
    remoteIds.pos.add(r.docId);
    const l = state.pos.get(r.docId);
    if (take(l, r)) { state.pos.set(r.docId, r); putPos.push(r); changed = true; } else if ((l.updatedAt || 0) > (r.updatedAt || 0)) needUpload = true;
  }
  const conflictBase = lastSyncAt;
  for (const r of data.anns || []) {
    if (!r?.id) continue;
    remoteIds.anns.add(r.id);
    const l = state.anns.get(r.id);
    // 양쪽에서 같은 메모를 따로 고쳤으면(지난 동기화 뒤 둘 다 바뀜) 진 쪽 메모도 따로 남긴다
    if (l && !l.deleted && !r.deleted && (l.note || r.note) && l.note !== r.note && conflictBase
      && (l.updatedAt || 0) > conflictBase && (r.updatedAt || 0) > conflictBase && source === 'sync') {
      const loser = take(l, r) ? l : r;
      if (loser.note) {
        const copy = { ...loser, id: uid('h'), note: `${loser.note}\n\n(다른 기기에서 같은 메모를 고쳐 따로 남김)`, createdAt: loser.createdAt || now(), updatedAt: now() };
        state.anns.set(copy.id, copy);
        putAnns.push(copy);
        needUpload = true;
      }
    }
    if (take(l, r)) {
      state.anns.set(r.id, r);
      putAnns.push(r);
      changed = true;
    } else if ((l.updatedAt || 0) > (r.updatedAt || 0)) needUpload = true;
  }
  for (const r of data.rev || []) {
    if (!r?.annId) continue;
    remoteIds.rev.add(r.annId);
    const l = state.rev.get(r.annId);
    if (take(l, r)) { state.rev.set(r.annId, r); putRev.push(r); changed = true; } else if ((l.updatedAt || 0) > (r.updatedAt || 0)) needUpload = true;
  }
  // 이쪽에만 있는 기록 → 올려야 한다
  if ([...state.docs.keys()].some((k) => !remoteIds.docs.has(k)) || [...state.anns.keys()].some((k) => !remoteIds.anns.has(k))
    || [...state.pos.keys()].some((k) => !remoteIds.pos.has(k)) || [...state.rev.keys()].some((k) => !remoteIds.rev.has(k))) needUpload = true;

  // 독서 시간: 기기마다 따로 — 남의 기기 기록은 그쪽 것이 정본
  for (const [dev, rec] of Object.entries(data.stats || {})) {
    if (dev === state.deviceId) continue;
    const mine = state.stats[dev];
    if (!mine || (rec?._u || 0) > (mine._u || 0)) { state.stats[dev] = rec; changed = true; }
  }
  if (data.stats && !data.stats[state.deviceId] && state.stats[state.deviceId]) needUpload = true;
  await kvSet('stats', state.stats);

  if (putDocs.length) await db.putMany('docs', putDocs);
  if (putPos.length) await db.putMany('pos', putPos);
  if (putAnns.length) {
    await db.putMany('anns', putAnns);
    for (const a of putAnns) {
      let set = state.annsByDoc.get(a.docId);
      if (!set) state.annsByDoc.set(a.docId, (set = new Set()));
      set.add(a.id);
    }
  }
  if (putRev.length) await db.putMany('rev', putRev);
  for (const d of removedDocs) {
    await db.del('cache', d.id);
    await db.del('info', d.id);
    state.info.delete(d.id);
    if (!liveDocs().some((x) => x.fileHash === d.fileHash)) {
      await db.del('files', d.fileHash);
      (await localFileHashes()).delete(d.fileHash);
    }
  }
  if (changed) {
    emit('remote-applied', {});
    emit('docs', {});
    emit('anns', {});
  }
  return { changed, needUpload };
}

function remoteName(doc) {
  return `${FILES}/${doc.fileHash}.${doc.format}`;
}

async function listRemoteFiles() {
  if (remoteFiles) return remoteFiles;
  const entries = await dbx.list(FILES);
  remoteFiles = new Set(entries.filter((e) => e['.tag'] === 'file').map((e) => e.name));
  return remoteFiles;
}

async function uploadMissingFiles() {
  const local = await localFileHashes();
  const docs = liveDocs().filter((d) => d.fileHash && local.has(d.fileHash));
  if (!docs.length) return;
  const have = await listRemoteFiles();
  const todo = [];
  const seen = new Set();
  for (const d of docs) {
    const name = `${d.fileHash}.${d.format}`;
    if (have.has(name) || seen.has(name)) continue;
    seen.add(name);
    todo.push(d);
  }
  let i = 0;
  for (const d of todo) {
    i++;
    setStatus({ state: 'busy', label: `원본 올리는 중 ${i}/${todo.length}` });
    const blob = await getFile(d.fileHash);
    if (!blob) continue;
    try {
      await dbx.upload(remoteName(d), blob, { mode: 'add' });
    } catch (e) {
      if (!(e instanceof dbx.DbxError && e.conflict)) throw e;
    }
    have.add(`${d.fileHash}.${d.format}`);
  }
}

async function dailySnapshot() {
  const today = dayKey();
  const last = await kvGet('lastSnapshot', '');
  if (last === today || !remoteRev) return;
  await dbx.copy(REMOTE, `${BACKUPS}/library-${today}.json.gz`);
  await kvSet('lastSnapshot', today);
}

// 이 기기에 없는 원본을 Dropbox에서 받아 오기
export async function fetchRemoteFile(doc, onStatus) {
  if (!(await dbx.isConnected())) return null;
  onStatus?.('Dropbox에서 원본 받는 중');
  const got = await dbx.download(remoteName(doc), {
    onProgress: (p, n, total) => onStatus?.(`Dropbox에서 원본 받는 중 ${total ? Math.round(p * 100) : Math.round(n / 1024)}${total ? '%' : 'KB'}`),
  });
  if (!got) return null;
  const hash = await sha256Hex(got.blob);
  if (hash !== doc.fileHash) throw new Error('받은 원본이 기록과 다릅니다(파일 손상).');
  await putFile(got.blob, doc.fileName);
  noteFileStored(hash);
  return got.blob;
}

export async function downloadAll(onProgress) {
  const local = await localFileHashes(true);
  const todo = liveDocs().filter((d) => d.fileHash && !local.has(d.fileHash));
  let i = 0;
  for (const d of todo) {
    i++;
    onProgress?.(i, todo.length, d.title);
    try { await fetchRemoteFile(d); } catch (e) { console.warn(e); }
  }
  return todo.length;
}

export async function connectedAccount() {
  return dbx.accountInfo();
}

export async function disconnectDropbox() {
  await dbx.disconnect();
  remoteRev = null;
  remoteFiles = null;
  await kvSet('remoteRev', null);
  setStatus({ state: 'off', label: 'Dropbox 연결 안 됨' });
}

export function lastSync() {
  return lastSyncAt;
}

export function isBlockedByNewer() {
  return blockedByNewer;
}

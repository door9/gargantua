// 앱 상태(서재·위치·하이라이트·되새기기·독서 시간)와 저장. 바꿀 때마다 updatedAt을 새로 찍어야 동기화가 되돌리지 않는다.
import { db, kvGet, kvSet } from './db.js';
import { now, uid, emit, dayKey, sha256Hex, debounce } from './util.js';

export const READER_DEFAULTS = {
  fontSize: 19,
  lineHeight: 1.72,
  margin: 22,
  maxWidth: 720,
  palette: 'paper',
  typeface: 'serif',
  align: 'justify',
  keepAll: false,
  hyphens: true,
  paraGap: 0.55,
  indent: 0,
  bookStyle: true,
  spread: 'auto',
  pageAnim: true,
  pdfInvert: true,
};

export const APP_DEFAULTS = {
  theme: 'system',
  libraryView: 'list',
  librarySort: 'recent',
  libraryFilter: 'all',
  reviewDaily: 10,
  autoSync: true,
  keepOffline: true, // Dropbox에 있는 원본을 이 기기에 모두 받아 두기(오프라인에서도 모든 문서가 열리게)
  lookupDict: 'naver',
};

export const state = {
  deviceId: '',
  docs: new Map(),
  pos: new Map(),
  anns: new Map(),
  annsByDoc: new Map(),
  rev: new Map(),
  info: new Map(),
  stats: {},
  reader: { ...READER_DEFAULTS },
  // 문서마다 따로 바꾼 읽기 설정(이 기기 안, 문서 id → 바꾼 값만). 없는 값은 reader(설정 화면의 기본값)를 따른다
  docReader: {},
  app: { ...APP_DEFAULTS },
  changeSeq: 0,
  ready: false,
};

export const liveDocs = () => [...state.docs.values()].filter((d) => !d.deleted);
export const liveAnns = (docId) => {
  const ids = state.annsByDoc.get(docId);
  if (!ids) return [];
  const out = [];
  for (const id of ids) {
    const a = state.anns.get(id);
    if (a && !a.deleted) out.push(a);
  }
  return out;
};
export const allLiveAnns = () => [...state.anns.values()].filter((a) => !a.deleted && state.docs.get(a.docId) && !state.docs.get(a.docId).deleted);

function indexAnn(a) {
  let set = state.annsByDoc.get(a.docId);
  if (!set) state.annsByDoc.set(a.docId, (set = new Set()));
  set.add(a.id);
}

export async function initStore() {
  let deviceId = await kvGet('deviceId');
  if (!deviceId) {
    deviceId = uid('dev-');
    await kvSet('deviceId', deviceId);
  }
  state.deviceId = deviceId;
  const [docs, pos, anns, rev, info, reader, app, stats, seq, docReader] = await Promise.all([
    db.getAll('docs'), db.getAll('pos'), db.getAll('anns'), db.getAll('rev'), db.getAll('info'),
    kvGet('readerSettings'), kvGet('appSettings'), kvGet('stats'), kvGet('changeSeq'), kvGet('docReader'),
  ]);
  for (const d of docs) state.docs.set(d.id, d);
  for (const p of pos) state.pos.set(p.docId, p);
  for (const a of anns) { state.anns.set(a.id, a); indexAnn(a); }
  for (const r of rev) state.rev.set(r.annId, r);
  for (const i of info) state.info.set(i.docId, i);
  state.reader = { ...READER_DEFAULTS, ...(reader || {}) };
  state.docReader = docReader || {};
  state.app = { ...APP_DEFAULTS, ...(app || {}) };
  state.stats = stats || {};
  state.changeSeq = seq || 0;
  state.ready = true;
}

// 동기화가 볼 '바뀐 것 있음' 표시
const persistSeq = debounce(() => kvSet('changeSeq', state.changeSeq), 300);
export function markChanged(kind = 'data') {
  state.changeSeq += 1;
  persistSeq();
  emit('dirty', { kind });
}

function stamp(record, prev) {
  const t = now();
  record.updatedAt = prev && prev.updatedAt >= t ? prev.updatedAt + 1 : t;
  return record;
}

// ── 서재 문서 ──
export async function saveDoc(doc, { silent = false } = {}) {
  const prev = state.docs.get(doc.id);
  const rec = stamp({ ...prev, ...doc }, prev);
  state.docs.set(rec.id, rec);
  await db.put('docs', rec);
  markChanged('doc');
  if (!silent) emit('docs', { id: rec.id });
  return rec;
}

export async function saveInfo(info) {
  const prev = state.info.get(info.docId);
  const rec = { ...prev, ...info };
  state.info.set(rec.docId, rec);
  await db.put('info', rec);
  emit('info', { id: rec.docId });
  return rec;
}

export async function removeDoc(id) {
  const doc = state.docs.get(id);
  if (!doc) return;
  const tomb = stamp({ id, deleted: true, title: doc.title, fileHash: doc.fileHash, format: doc.format }, doc);
  state.docs.set(id, tomb);
  const annTombs = [];
  for (const a of liveAnns(id)) {
    const t = stamp({ id: a.id, docId: id, deleted: true, kind: a.kind }, a);
    state.anns.set(a.id, t);
    annTombs.push(t);
  }
  await db.put('docs', tomb);
  await db.putMany('anns', annTombs);
  await db.del('cache', id);
  await db.del('info', id);
  state.info.delete(id);
  await deleteFileIfUnused(doc.fileHash);
  markChanged('doc');
  emit('docs', { id, removed: true });
  emit('anns', { docId: id });
}

// ── 읽던 위치·보기 방식 ──
const posWrites = new Map();
export function savePos(docId, patch, { immediate = false } = {}) {
  const prev = state.pos.get(docId);
  const rec = stamp({ docId, ...prev, ...patch }, prev);
  state.pos.set(docId, rec);
  clearTimeout(posWrites.get(docId));
  const write = () => { posWrites.delete(docId); db.put('pos', state.pos.get(docId)).catch(() => {}); };
  if (immediate) write();
  else posWrites.set(docId, setTimeout(write, 700));
  markChanged('pos');
  return rec;
}
export async function flushPositions() {
  const pending = [...posWrites.keys()];
  for (const id of pending) clearTimeout(posWrites.get(id));
  posWrites.clear();
  await db.putMany('pos', pending.map((id) => state.pos.get(id)).filter(Boolean));
}

// ── 하이라이트·메모·책갈피 ──
export async function saveAnn(ann, { silent = false } = {}) {
  const prev = state.anns.get(ann.id);
  const rec = stamp({ ...prev, ...ann }, prev);
  if (!rec.createdAt) rec.createdAt = rec.updatedAt;
  state.anns.set(rec.id, rec);
  indexAnn(rec);
  await db.put('anns', rec);
  markChanged('ann');
  if (!silent) emit('anns', { docId: rec.docId, id: rec.id });
  return rec;
}

export async function removeAnn(id) {
  const prev = state.anns.get(id);
  if (!prev || prev.deleted) return;
  const rec = stamp({ id, docId: prev.docId, kind: prev.kind, deleted: true }, prev);
  state.anns.set(id, rec);
  await db.put('anns', rec);
  markChanged('ann');
  emit('anns', { docId: prev.docId, id, removed: true });
  return prev;
}

// 지운 것을 되살리기(알림의 '되돌리기')
export async function restoreAnn(snapshot) {
  const prev = state.anns.get(snapshot.id);
  const rec = stamp({ ...snapshot, deleted: undefined }, prev);
  delete rec.deleted;
  state.anns.set(rec.id, rec);
  indexAnn(rec);
  await db.put('anns', rec);
  markChanged('ann');
  emit('anns', { docId: rec.docId, id: rec.id });
  return rec;
}

// ── 되새기기 기록 ──
export async function saveRev(annId, patch) {
  const prev = state.rev.get(annId);
  const rec = stamp({ annId, ...prev, ...patch }, prev);
  state.rev.set(annId, rec);
  await db.put('rev', rec);
  markChanged('rev');
  emit('rev', { annId });
  return rec;
}

// ── 설정 ──
const persistReader = debounce(() => kvSet('readerSettings', state.reader), 250);
export function setReader(patch) {
  Object.assign(state.reader, patch);
  persistReader();
  emit('reader-settings', patch);
}
// 한 문서의 읽기 설정 = 기본값(설정 화면) 위에 그 문서에서 바꾼 값
export function readerFor(docId) {
  return { ...state.reader, ...(state.docReader[docId] || {}) };
}
const persistDocReader = debounce(() => kvSet('docReader', state.docReader), 250);
// 기본값과 같아진 값은 지워 다시 기본값을 따르게 한다
export function setDocReader(docId, patch) {
  const own = { ...(state.docReader[docId] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === state.reader[k]) delete own[k]; else own[k] = v;
  }
  if (Object.keys(own).length) state.docReader[docId] = own; else delete state.docReader[docId];
  persistDocReader();
  emit('reader-settings', { docId, ...patch });
}
export function setApp(patch) {
  Object.assign(state.app, patch);
  kvSet('appSettings', state.app);
  emit('app-settings', patch);
}

// ── 독서 시간(기기마다 따로 적어서 합칠 때 다투지 않게) ──
const persistStats = debounce(() => kvSet('stats', state.stats), 4000);
export function addReadingTime(docId, secs) {
  if (!docId || secs <= 0) return;
  const mine = (state.stats[state.deviceId] ||= {});
  const day = (mine[dayKey()] ||= { s: 0, d: {} });
  day.s += secs;
  day.d[docId] = (day.d[docId] || 0) + secs;
  mine._u = now();
  persistStats();
  state.statsDirty = true;
}
export function flushStats() {
  persistStats.flush();
}

// 읽은 글자 수 — 읽는 속도 추정용(기기 안에서만)
export function addReadingProgress(docId, chars, secs) {
  if (chars <= 0 || secs <= 0) return;
  const info = state.info.get(docId);
  if (!info) return;
  const speed = info.speed || { c: 0, s: 0 };
  speed.c += chars;
  speed.s += secs;
  // 오래된 기록 비중을 줄인다
  if (speed.s > 4 * 3600) { speed.c *= 0.5; speed.s *= 0.5; }
  info.speed = speed;
  db.put('info', info).catch(() => {});
}

export function readingSpeed(docId) {
  // 글자/분. 문서 기록이 충분하면 그 값, 아니면 모든 문서 평균, 그것도 없으면 기본값
  const own = state.info.get(docId)?.speed;
  if (own && own.s > 300) return clampSpeed((own.c / own.s) * 60);
  let c = 0;
  let s = 0;
  for (const i of state.info.values()) if (i.speed) { c += i.speed.c; s += i.speed.s; }
  if (s > 300) return clampSpeed((c / s) * 60);
  const lang = state.info.get(docId)?.lang || 'ko';
  return lang.startsWith('en') ? 1100 : 620;
}
const clampSpeed = (v) => Math.min(3000, Math.max(150, v));

// ── 원본 파일 ──
export async function putFile(blob, name) {
  const hash = await sha256Hex(blob);
  const existing = await db.get('files', hash);
  if (!existing) await db.put('files', { hash, blob, size: blob.size, type: blob.type || '', name: name || '' });
  noteFileStored(hash);
  return hash;
}
export async function getFile(hash) {
  if (!hash) return null;
  const row = await db.get('files', hash);
  return row ? row.blob : null;
}
export async function hasFile(hash) {
  if (!hash) return false;
  const keys = await localFileHashes();
  return keys.has(hash);
}
let fileKeyCache = null;
export async function localFileHashes(refresh = false) {
  if (!fileKeyCache || refresh) fileKeyCache = new Set(await db.getAllKeys('files'));
  return fileKeyCache;
}
export function noteFileStored(hash) {
  if (fileKeyCache) fileKeyCache.add(hash);
}
async function deleteFileIfUnused(hash) {
  if (!hash) return;
  const stillUsed = liveDocs().some((d) => d.fileHash === hash);
  if (stillUsed) return;
  await db.del('files', hash);
  if (fileKeyCache) fileKeyCache.delete(hash);
}

export function docProgress(docId) {
  return state.pos.get(docId)?.progress || 0;
}

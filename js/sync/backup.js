// 백업 파일 만들기·가져오기, 안드로이드 Gargantua 서재 옮겨 오기
import { Zip, ZipPassThrough, ZipDeflate, unzip, strFromU8, strToU8 } from '../../vendor/fflate.mjs';
import { db, kvGet, kvSet } from '../db.js';
import { state, liveDocs, getFile, putFile, saveAnn, savePos, setReader, saveDoc, liveAnns } from '../store.js';
import { importOne } from '../docs.js';
import { applyRemote } from './sync.js';
import { resolveAnchor } from '../text.js';
import { sha256Hex, now, emit, baseName } from '../util.js';
import { fromGlobal } from '../reader/chapters.js';
import * as dbx from './dropbox.js';

export const ANDROID_REMOTE = '/Gargantua-library-backup.gargantua-backup';

// ── 우리 백업(zip): gargantua-web.json + files/해시.형식 ──
export async function exportBackup({ onStatus } = {}) {
  const chunks = [];
  let done;
  const finished = new Promise((resolve, reject) => { done = { resolve, reject }; });
  const zip = new Zip((err, chunk, final) => {
    if (err) { done.reject(err); return; }
    chunks.push(chunk);
    if (final) done.resolve();
  });
  const data = {
    app: 'gargantua-web', schema: 1, kind: 'backup', savedAt: Date.now(), device: state.deviceId,
    docs: [...state.docs.values()], pos: [...state.pos.values()], anns: [...state.anns.values()], rev: [...state.rev.values()], stats: state.stats,
    reader: state.reader,
  };
  const meta = new ZipDeflate('gargantua-web.json', { level: 6 });
  zip.add(meta);
  meta.push(strToU8(JSON.stringify(data)), true);
  const docs = liveDocs();
  let i = 0;
  let missing = 0;
  const added = new Set();
  for (const d of docs) {
    i++;
    onStatus?.(`원본 담는 중 ${i}/${docs.length}`);
    const name = `files/${d.fileHash}.${d.format}`;
    if (added.has(name)) continue;
    const blob = await getFile(d.fileHash);
    if (!blob) { missing++; continue; }
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(new Uint8Array(await blob.arrayBuffer()), true);
    added.add(name);
  }
  zip.end();
  await finished;
  return { blob: new Blob(chunks, { type: 'application/zip' }), docs: docs.length, missing };
}

function unzipAsync(bytes) {
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter: (f) => !f.name.endsWith('/') }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

export async function importBackupBlob(blob, { onStatus } = {}) {
  onStatus?.('백업 파일 여는 중');
  let files;
  try {
    files = await unzipAsync(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    throw new Error('백업 파일을 열 수 없습니다(zip이 아니거나 손상됨).');
  }
  if (files['gargantua-web.json']) return importWebBackup(files, { onStatus });
  if (files['gargantua_data/library.json'] || Object.keys(files).some((k) => k.startsWith('gargantua_data/'))) return importAndroid(files, { onStatus });
  throw new Error('Gargantua 백업 파일이 아닙니다.');
}

async function importWebBackup(files, { onStatus }) {
  const data = JSON.parse(strFromU8(files['gargantua-web.json']));
  if (data.app !== 'gargantua-web') throw new Error('알 수 없는 백업 형식입니다.');
  const names = Object.keys(files).filter((k) => k.startsWith('files/'));
  let i = 0;
  for (const name of names) {
    i++;
    onStatus?.(`원본 넣는 중 ${i}/${names.length}`);
    const blob = new Blob([files[name]]);
    const expect = /files\/([0-9a-f]{64})\./.exec(name)?.[1];
    const hash = await sha256Hex(blob);
    if (expect && expect !== hash) continue;
    await putFile(blob, name.slice(6));
  }
  const res = await applyRemote(data, { source: 'backup' });
  // 백업에서 온 기록도 다음 동기화 때 올라가도록
  state.changeSeq += 1;
  await kvSet('changeSeq', state.changeSeq);
  emit('dirty', { kind: 'backup' });
  return { kind: 'web', docs: (data.docs || []).filter((d) => !d.deleted).length, anns: (data.anns || []).filter((a) => !a.deleted).length, changed: res.changed };
}

// ── 안드로이드 앱 백업(.gargantua-backup) ──
const COLOR = { yellow: 0, mint: 1, rose: 2, blue: 3 };

function readJson(files, path) {
  const bytes = files[path] || files[`${path}.backup`] || files[`${path}.tmp`];
  if (!bytes) return null;
  try { return JSON.parse(strFromU8(bytes)); } catch { return null; }
}

export async function importAndroid(files, { onStatus } = {}) {
  const lib = readJson(files, 'gargantua_data/library.json');
  if (!lib || !Array.isArray(lib.documents)) throw new Error('안드로이드 서재 정보(library.json)를 찾지 못했습니다.');
  const report = { kind: 'android', docs: 0, highlights: 0, notes: 0, bookmarks: 0, skipped: [], orphans: 0 };
  const sources = new Map();
  for (const name of Object.keys(files)) {
    const m = /^gargantua_data\/library\/([^/]+)\.(txt|md|markdown|docx|pdf|epub)$/i.exec(name);
    if (m) sources.set(m[1], name);
  }
  let i = 0;
  for (const d of lib.documents) {
    i++;
    if (!d?.id) continue;
    onStatus?.(`옮기는 중 ${i}/${lib.documents.length} · ${d.title || ''}`);
    try {
      await importAndroidDoc(files, d, sources, report, (m) => onStatus?.(`옮기는 중 ${i}/${lib.documents.length} · ${m}`));
    } catch (e) {
      console.warn(e);
      report.skipped.push(`${d.title || d.id}: ${e.message || e}`);
    }
  }
  // 글자 크기 같은 읽기 설정: 이 기기에서 아직 손대지 않았으면 옮겨 온다
  const rs = lib.readerSettings;
  if (rs && !(await kvGet('readerTouched', false))) {
    const patch = {};
    if (rs.fontSize) patch.fontSize = rs.fontSize;
    if (rs.lineHeight) patch.lineHeight = rs.lineHeight;
    if (rs.horizontalMargin) patch.margin = rs.horizontalMargin;
    if (['paper', 'sepia', 'night'].includes(rs.palette)) patch.palette = rs.palette;
    if (['serif', 'sans'].includes(rs.typeface)) patch.typeface = rs.typeface;
    setReader(patch);
  }
  emit('docs', {});
  emit('anns', {});
  return report;
}

async function importAndroidDoc(files, d, sources, report, onStatus) {
  const srcName = sources.get(d.id) || (d.localPath ? Object.keys(files).find((k) => k.endsWith(`/${d.localPath.split('/').pop()}`) && k.startsWith('gargantua_data/library/')) : null);
  const reader = readJson(files, `gargantua_data/reader/${d.id}/document.gargantua.json`);
  let blob = srcName ? new Blob([files[srcName]]) : null;
  let fileName = d.originalFileName || (srcName ? srcName.split('/').pop() : `${d.title}.md`);
  if (!blob && reader?.content?.blocks?.length) {
    // 원본이 없으면 안드로이드가 만들어 둔 독서 사본으로 Markdown을 다시 만든다
    blob = new Blob([reader.content.blocks.map((b) => b.markdown || b.plainText || '').join('\n\n')], { type: 'text/markdown' });
    fileName = `${baseName(fileName) || d.title}.md`;
  }
  if (!blob) { report.skipped.push(`${d.title}: 원본 파일이 백업에 없음`); return; }
  const hash = await sha256Hex(blob);
  const existing = liveDocs().find((x) => x.fileHash === hash);
  const id = existing?.id || `a-${d.id}`;
  const addedAt = Date.parse(d.addedAt) || now();
  if (!existing) {
    await importOne(blob, fileName, { id, addedAt, title: d.title, onStatus });
  }
  report.docs++;
  const doc = state.docs.get(id);
  const info = state.info.get(id) || {};
  const isPdf = doc.format === 'pdf';
  const cache = isPdf ? null : await db.get('cache', id);
  const book = cache?.book;
  const texts = cache?.texts;

  // 읽던 위치·보기 방식
  const progress = Math.max(0, Math.min(1, Number(d.readingProgress ?? reader?.readingProgress ?? 0)));
  const mode = d.readerMode === 'divided' || d.readerMode === 'random' ? d.readerMode : 'full';
  const opened = Date.parse(d.lastOpenedAt) || 0;
  const prevPos = state.pos.get(id);
  if (!prevPos || (prevPos.openedAt || 0) < opened) {
    const pos = { progress, mode, openedAt: opened, view: isPdf ? 'pdf' : 'flow' };
    if (isPdf && info.pages) { const f = progress * Math.max(0, info.pages - 1); pos.p = Math.floor(f); pos.y = +(f - Math.floor(f)).toFixed(3); }
    if (book && book.chars) Object.assign(pos, fromGlobal(book, Math.floor(progress * Math.max(0, book.chars - 1))));
    if (progress >= 0.995) pos.finishedAt = opened || now();
    savePos(id, pos, { immediate: true });
  }

  // 책갈피(문서의 몇 % 지점)
  const existingAnns = new Set(liveAnns(id).map((a) => a.id));
  (d.bookmarks || []).forEach((f, k) => {
    const annId = `a-${d.id}-bm-${k}`;
    if (existingAnns.has(annId)) return;
    let anchor;
    let snippet = '';
    if (isPdf) {
      const pf = f * Math.max(0, (info.pages || 1) - 1);
      anchor = { p: Math.floor(pf), y: +(pf - Math.floor(pf)).toFixed(3) };
    } else if (book) {
      const loc = fromGlobal(book, Math.floor(f * Math.max(0, book.chars - 1)));
      anchor = { s: loc.s, o: loc.o };
      snippet = (texts?.[loc.s] || '').slice(loc.o, loc.o + 80).replace(/\s+/g, ' ').trim();
    } else return;
    saveAnn({ id: annId, docId: id, kind: 'bm', anchor, snippet, progress: f, createdAt: opened || now() }, { silent: true });
    report.bookmarks++;
  });

  if (!reader || isPdf || !book) return;
  // 하이라이트·메모: 글(인용문)로 지금 본문에서 자리를 찾는다
  const blocks = reader.content?.blocks || [];
  const total = book.chars;
  const findAnchor = (blockIndex, quote) => {
    const frac = blocks.length > 1 ? blockIndex / (blocks.length - 1) : 0;
    const g = Math.floor(frac * total);
    const near = fromGlobal(book, g);
    const tryIn = (s, hint) => {
      const m = resolveAnchor(texts[s] || '', { quote, hint, start: undefined, end: undefined });
      return m ? { s, ...m } : null;
    };
    let hit = tryIn(near.s, near.o);
    for (let r = 1; !hit && r < book.sections.length; r++) {
      if (near.s - r >= 0) hit = tryIn(near.s - r, 0);
      if (!hit && near.s + r < book.sections.length) hit = tryIn(near.s + r, 0);
    }
    if (!hit) return { s: near.s, start: near.o, end: near.o + quote.length, quote, prefix: '', suffix: '', legacy: true };
    const t = texts[hit.s];
    return { s: hit.s, start: hit.start, end: hit.end, quote: t.slice(hit.start, hit.end), prefix: t.slice(Math.max(0, hit.start - 32), hit.start), suffix: t.slice(hit.end, hit.end + 32) };
  };
  const hlByAndroid = new Map();
  for (const hl of reader.highlights || []) {
    const quote = String(hl.quote || '').trim();
    if (!quote) continue;
    const annId = `a-${hl.id}`;
    const anchor = findAnchor(hl.blockIndex || 0, quote);
    if (anchor.legacy) report.orphans++;
    const created = Date.parse(hl.createdAt) || now();
    hlByAndroid.set(hl.id, { annId, blockIndex: hl.blockIndex, start: hl.start, end: hl.end, anchor });
    if (existingAnns.has(annId)) continue;
    await saveAnn({ id: annId, docId: id, kind: 'hl', color: COLOR[hl.color] ?? 0, anchor, note: '', createdAt: created }, { silent: true });
    report.highlights++;
  }
  for (const n of reader.notes || []) {
    const body = String(n.body || '').trim();
    if (!body) continue;
    // 메모를 남길 때 자동으로 생긴 하이라이트(id-highlight) 또는 같은 자리의 하이라이트에 붙인다
    let target = hlByAndroid.get(`${n.id}-highlight`);
    if (!target) {
      for (const t of hlByAndroid.values()) {
        if (t.blockIndex === n.blockIndex && t.start < n.end && n.start < t.end) { target = t; break; }
      }
    }
    const created = Date.parse(n.createdAt) || now();
    if (target) {
      const cur = state.anns.get(target.annId);
      if (cur && !cur.deleted && !(cur.note || '').includes(body)) {
        await saveAnn({ id: target.annId, note: cur.note ? `${cur.note}\n\n${body}` : body }, { silent: true });
        report.notes++;
      }
    } else {
      const annId = `a-${n.id}`;
      if (existingAnns.has(annId)) continue;
      const quote = String(n.quote || '').trim();
      const anchor = findAnchor(n.blockIndex || 0, quote || body.slice(0, 20));
      if (anchor.legacy) report.orphans++;
      await saveAnn({ id: annId, docId: id, kind: 'hl', color: 0, anchor, note: body, createdAt: created }, { silent: true });
      report.notes++;
    }
  }
  void saveDoc;
}

// Dropbox에 있는 안드로이드 백업 정보
export async function androidRemoteInfo() {
  if (!(await dbx.isConnected())) return null;
  return dbx.meta(ANDROID_REMOTE);
}

export async function importAndroidFromDropbox({ onStatus } = {}) {
  const got = await dbx.download(ANDROID_REMOTE, { onProgress: (p) => onStatus?.(`Dropbox에서 받는 중 ${Math.round(p * 100)}%`) });
  if (!got) throw new Error('Dropbox에서 안드로이드 백업을 찾지 못했습니다. 안드로이드 앱에서 먼저 "Dropbox 서재 백업"을 해 주세요.');
  return importBackupBlob(got.blob, { onStatus });
}

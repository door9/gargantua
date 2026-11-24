// 원본 파일 바꾸기(2026-11-24 사용자 "띄어쓰기를 바로잡은 문서를 새로 집어넣은 뒤에 이 기록을 이관받을 수 있어?")
// 서재의 문서(id·이름·카테고리·되새기기·독서 기록)는 그대로 두고 원본 파일만 갈아 끼운다.
//  · 하이라이트·메모: 인용문과 앞뒤 글로 새 원본에서 다시 찾아 위치를 고쳐 적는다(띄어쓰기가 달라도 찾는다). 못 찾은 것은 지우지 않고 그대로 둔다
//  · 책갈피·읽던 자리: 그 자리의 옛 글귀로 찾고, 못 찾으면 같은 진도(%)로
//  · 띄어쓰기 고침: 새 원본에서 같은 글귀(앞뒤 16자)를 찾아 옮기고, 없으면(새 원본이 이미 바로잡혀 있는 등) 지운다
// 새 원본은 기기에서 고르거나, 서재에 이미 넣어 둔 다른 문서의 파일을 쓴다(그 문서는 바꾼 뒤 지울지 묻는다)
import { h, esc, toast, sha256Hex, emit, pickFiles, fmtDate } from './util.js';
import { ico } from './icons.js';
import {
  state, saveDoc, saveAnn, removeAnn, savePos, putFile, getFile, liveAnns, liveDocs, deleteFileIfUnused, removeDoc,
} from './store.js';
import { db, dropDocCache } from './db.js';
import { parseDocument, sniffFormat, PARSER_VERSION, PDF_BOOK_VERSION, ACCEPT } from './parse/index.js';
import { loadBook, bookSummary, MAX_FILE } from './docs.js';
import { pdfInfo } from './pdfdoc.js';
import { fixesOf, planFixes, patchBook, fixAnchor } from './fixes.js';
import { fromGlobal, toGlobal } from './reader/chapters.js';
import { sheet, confirmDialog } from './ui/overlay.js';
import { fetchRemoteFile } from './sync/sync.js';

export class ReplaceError extends Error {}

// ── 고르기 → 확인 → 바꾸기 → 결과 알림 ──
// before: 바꾸기 직전(읽기 화면이 읽던 자리를 써 두고 멈춘다), onStatus: 진행 글, after: 바꾼 뒤 결과를 알리기 전(읽기 화면이 새 원본으로 다시 연다)
export async function pickReplacement(doc, { before, onStatus, after } = {}) {
  const src = await chooseSource(doc);
  if (!src) return null;
  const ok = await confirmDialog({
    title: '원본 파일을 바꿀까요?',
    message: `<p>“${esc(doc.title)}”의 원본을 <b>${esc(src.name)}</b>(으)로 바꿉니다.</p>`
      + '<p>하이라이트·메모·책갈피·읽던 자리는 새 원본의 같은 글귀로 옮깁니다. 문서 이름·카테고리·독서 기록은 그대로입니다.</p>',
    ok: '바꾸기',
  });
  if (!ok) return null;
  await before?.();
  const chip = onStatus ? null : statusChip();
  const status = onStatus || chip.set;
  let res;
  try {
    status('새 원본 준비 중');
    const blob = src.blob || await sourceBlob(src.doc, status);
    res = await replaceDocFile(doc, blob, src.name, { onStatus: status });
  } catch (e) {
    console.warn('원본 바꾸기 실패', e);
    toast(e instanceof ReplaceError ? e.message : `원본을 바꾸지 못했습니다: ${e?.message || e}`, { duration: 6000 });
    return { replaced: false, error: e };
  } finally {
    chip?.remove();
  }
  await after?.(res);
  await reportResult(res);
  return res;
}

// 새 원본 고르기: 기기의 파일, 또는 서재에 넣어 둔 다른 문서
function chooseSource(doc) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const others = liveDocs().filter((d) => d.id !== doc.id && d.fileHash && d.fileHash !== doc.fileHash)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const list = h('div', { class: 'rp-list' });
    const search = h('input', { class: 'gfield', type: 'search', placeholder: '서재에서 찾기' });
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      list.textContent = '';
      const shown = others.filter((d) => !q || `${d.title} ${d.fileName || ''}`.toLowerCase().includes(q)).slice(0, 60);
      if (!shown.length) list.append(h('p', { class: 'rp-empty' }, q ? '맞는 문서가 없습니다.' : '서재에 다른 문서가 없습니다.'));
      for (const d of shown) {
        list.append(h('button', { class: 'rp-row', type: 'button', onclick: () => { finish({ doc: d, name: d.fileName || `${d.title}.${d.format}` }); box.close(); } },
          h('span', { class: 'rp-ico', html: ico('file') }),
          h('span', { class: 'rp-name' }, d.title, h('small', null, `${(d.format || '').toUpperCase()} · ${fmtDate(d.addedAt)} 넣음`))));
      }
    };
    search.addEventListener('input', fill);
    const pickBtn = h('button', { class: 'gbtn primary block', type: 'button', onclick: async () => {
      const files = await pickFiles({ accept: ACCEPT, multiple: false });
      if (!files[0]) return;
      finish({ blob: files[0], name: files[0].name });
      box.close();
    } }, h('span', { html: ico('import') }), '기기에서 파일 고르기');
    const body = h('div', { class: 'rp-body' },
      pickBtn,
      others.length ? h('div', { class: 'rp-label' }, '서재에 넣어 둔 문서의 파일로') : null,
      others.length > 8 ? search : null,
      others.length ? list : null);
    fill();
    const box = sheet({ title: '원본 파일 바꾸기', className: 'rp-sheet', tall: others.length > 4, body, onClose: () => finish(null) });
  });
}

async function sourceBlob(d, onStatus) {
  const local = await getFile(d.fileHash);
  if (local) return local;
  const got = await fetchRemoteFile(d, onStatus).catch(() => null);
  if (!got) throw new ReplaceError('고른 문서의 원본이 이 기기에 없습니다. 그 문서를 한 번 열어 받아 온 뒤 다시 해 주세요.');
  return got;
}

function statusChip() {
  const el = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '원본 바꾸는 중'));
  document.body.append(el);
  return { set: (m) => { el.lastChild.textContent = m; }, remove: () => el.remove() };
}

async function reportResult(res) {
  if (!res) return;
  if (res.same) { toast('지금 원본과 같은 파일입니다.'); return; }
  if (!res.replaced) return;
  const parts = [];
  if (res.hlTotal) parts.push(res.lost.length ? `하이라이트 ${res.hlTotal}개 가운데 ${res.hlTotal - res.lost.length}개를 옮겼습니다.` : `하이라이트 ${res.hlTotal}개를 모두 옮겼습니다.`);
  if (res.fixDropped) parts.push(`새 원본에 이미 반영된 띄어쓰기 고침 ${res.fixDropped}개는 지웠습니다.`);
  if (res.lost.length) {
    const list = h('ul', { class: 'rp-lost' });
    for (const a of res.lost.slice(0, 30)) list.append(h('li', null, `“${(a.anchor?.quote || '').replace(/\s+/g, ' ').slice(0, 70)}”`));
    await new Promise((resolve) => sheet({
      title: '원본을 바꿨습니다',
      className: 'gdialog',
      body: h('div', { class: 'gdialog-msg' },
        h('p', null, parts.join(' ')),
        h('p', null, `새 원본에서 찾지 못한 하이라이트 ${res.lost.length}개는 지우지 않고 그대로 두었습니다. 노트 화면에서 볼 수 있습니다.`),
        list),
      actions: [{ label: '확인', primary: true }],
      onClose: resolve,
    }));
  } else {
    toast(['원본을 바꿨습니다.', ...parts].join(' '), { duration: 4000 });
  }
  // 같은 파일로 따로 넣어 둔 문서(새로 넣어 본 바로잡은 판 등) — 지울지 묻는다
  const dup = res.dup && state.docs.get(res.dup.id);
  if (dup && !dup.deleted) {
    const n = liveAnns(dup.id).filter((a) => a.kind !== 'fix').length;
    const ok = await confirmDialog({
      title: '같은 파일의 문서가 서재에 있습니다',
      message: `<p>“${esc(dup.title)}”은(는) 이제 이 문서와 같은 파일입니다. 서재에서 삭제할까요?</p>${n ? `<p>그 문서의 하이라이트·메모·책갈피 ${n}개도 함께 삭제됩니다.</p>` : ''}`,
      ok: '삭제', cancel: '그대로 두기', danger: true,
    });
    if (ok) { await removeDoc(dup.id); toast('삭제했습니다.', { duration: 1400 }); }
  }
}

// ── 바꾸기 ──
export async function replaceDocFile(doc, blob, name, { onStatus } = {}) {
  if (!blob?.size) throw new ReplaceError('내용이 없는 파일입니다.');
  if (blob.size > MAX_FILE) throw new ReplaceError('파일이 너무 큽니다(400MB 초과).');
  const format = await sniffFormat(blob, name);
  if (!format) throw new ReplaceError('TXT·Markdown·DOCX·PDF·EPUB 파일만 열 수 있습니다.');
  const hash = await sha256Hex(blob);
  if (hash === doc.fileHash) return { replaced: false, same: true };

  // 옛 원본의 글(책갈피·읽던 자리 글귀용, 띄어쓰기 고침을 입힌 글) — 없으면 진도로 옮긴다
  onStatus?.('지금 원본 읽는 중');
  const old = await oldBook(doc).catch(() => null);

  // 새 원본 변환 — 여기서 실패하면 아무것도 바꾸지 않는다
  onStatus?.('새 원본 변환 중');
  const onProgress = (p) => onStatus?.(`새 원본 변환 중 ${Math.round(p * 100)}%`);
  let parsed = null;
  let pi = null;
  if (format === 'pdf') {
    try {
      pi = await pdfInfo(blob);
    } catch (e) {
      throw new ReplaceError(/password/i.test(e?.name || e?.message || '') ? '암호가 걸린 PDF는 열 수 없습니다.' : 'PDF를 열 수 없습니다. 파일이 손상되었을 수 있습니다.');
    }
    try { parsed = await parseDocument(blob, 'pdf', { onProgress }); } catch (e) { console.warn('새 PDF를 전자책으로 정리하지 못했습니다', e); }
  } else {
    parsed = await parseDocument(blob, format, { onProgress });
  }
  const book = parsed?.book && parsed.book.reflow !== false ? parsed.book : null;

  // ── 여기부터 바꾼다 ──
  onStatus?.('기록 옮기는 중');
  const oldHash = doc.fileHash;
  const formatChanged = format !== doc.format;
  await putFile(blob, name);
  await dropDocCache(doc.id);
  if (parsed) await db.put('cache', { docId: doc.id, fileHash: hash, pv: format === 'pdf' ? PDF_BOOK_VERSION : PARSER_VERSION, book: parsed.book, texts: parsed.texts });
  const prevInfo = state.info.get(doc.id) || {};
  let info = { docId: doc.id, format };
  if (prevInfo.speed) info.speed = prevInfo.speed;
  if (format === 'pdf') {
    info = { ...info, pages: pi.pages, cover: pi.cover, chars: 0 };
    if (book) info = { ...info, chars: book.chars, lang: book.lang, sections: book.sections.length, ...bookSummary(book, parsed.texts) };
  } else {
    info = { ...info, chars: book.chars, lang: book.lang, cover: parsed.cover || prevInfo.cover || null, sections: book.sections.length, ...bookSummary(book, parsed.texts) };
  }
  state.info.set(doc.id, info);
  await db.put('info', info);
  emit('info', { id: doc.id });
  await saveDoc({ id: doc.id, format, fileName: name, fileHash: hash, fileSize: blob.size }, { silent: true });

  // 띄어쓰기 고침 옮기기
  let fixKept = 0;
  let fixDropped = 0;
  let next = null; // 고침을 입힌 새 책
  const fixes = fixesOf(doc.id);
  if (book) {
    const { plan, missing } = planFixes(parsed.texts, fixes);
    const byId = new Map(fixes.map((f) => [f.id, f]));
    for (const [s, edits] of plan) {
      for (const e of edits) {
        for (const id of e.ids) {
          fixKept++;
          const f = byId.get(id);
          const anchor = fixAnchor(parsed.texts[s], s, e.o, f.op);
          if (e.moved || anchor.before !== f.anchor.before || anchor.after !== f.anchor.after) await saveAnn({ id, anchor }, { silent: true });
        }
      }
    }
    for (const f of missing) { await removeAnn(f.id, { silent: true }); fixDropped++; }
    next = patchBook(parsed.book, parsed.texts, plan);
  } else {
    // 글이 없는 PDF(스캔본) — 고칠 글이 없다
    for (const f of fixes) { await removeAnn(f.id, { silent: true }); fixDropped++; }
  }

  // 하이라이트·메모
  const finder = next ? new Finder(next.texts, next.book) : null;
  const hls = liveAnns(doc.id).filter((a) => a.kind === 'hl');
  const lost = [];
  for (const ann of hls) {
    const a = ann.anchor || {};
    const was = old && Number.isInteger(a.s) && old.book.sections[a.s] && Number.isInteger(a.start) ? (old.book.sections[a.s].start + a.start) / Math.max(1, old.book.chars) : null;
    const hit = finder && (a.quote || '').trim() ? finder.find(a.quote, a.prefix || '', a.suffix || '', was) : null;
    if (!hit) { lost.push(ann); continue; }
    const t = next.texts[hit.s];
    const anchor = { s: hit.s, start: hit.start, end: hit.end, quote: t.slice(hit.start, hit.end), prefix: t.slice(Math.max(0, hit.start - 32), hit.start), suffix: t.slice(hit.end, hit.end + 32) };
    if (format === 'pdf' && next.book.pageStarts) anchor.p = pageOf(next.book, hit.s, hit.start).p;
    await saveAnn({ id: ann.id, anchor }, { silent: true });
  }

  // 책갈피·읽던 자리
  const place = (rec) => newPlace(old, next, format === 'pdf' ? pi : null, rec, finder);
  for (const b of liveAnns(doc.id).filter((a) => a.kind === 'bm')) {
    const p = place({ ...b.anchor, progress: b.progress });
    if (p) await saveAnn({ id: b.id, anchor: p.anchor, progress: p.progress }, { silent: true });
  }
  const pos = state.pos.get(doc.id);
  if (pos) {
    const p = place(pos);
    const patch = p ? { ...p.anchor, progress: pos.finishedAt || pos.manualDone ? pos.progress : p.progress } : {};
    if (!Number.isInteger(patch.s)) { patch.s = null; patch.o = null; }
    if (formatChanged) Object.assign(patch, { viewPick: false, pdfView: null, view: null });
    savePos(doc.id, patch, { immediate: true });
  }

  await deleteFileIfUnused(oldHash);
  emit('docs', { id: doc.id });
  emit('anns', { docId: doc.id });
  const dup = liveDocs().find((d) => d.id !== doc.id && d.fileHash === hash) || null;
  return { replaced: true, hlTotal: hls.length, lost, fixKept, fixDropped, dup };
}

async function oldBook(doc) {
  const rec = await loadBook(doc, { fetchFile: fetchRemoteFile });
  if (!rec?.book || rec.book.reflow === false || !rec.texts) return null;
  const { plan } = planFixes(rec.texts, fixesOf(doc.id));
  return patchBook(rec.book, rec.texts, plan);
}

// PDF 책 위치 → 원본 쪽(쪽 안 비율) — reader/index.js pageLocOf 와 같은 셈
function pageOf(book, s, o) {
  const st = book.pageStarts;
  const g = toGlobal(book, s, o);
  let lo = 0;
  let hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid] <= g) lo = mid; else hi = mid - 1;
  }
  const nx = lo + 1 < st.length ? st[lo + 1] : book.chars;
  return { p: lo, y: nx > st[lo] ? +Math.min(0.98, Math.max(0, (g - st[lo]) / (nx - st[lo]))).toFixed(3) : 0 };
}

// 옛 자리 기록({s,o} 또는 PDF 쪽 {p,y}, progress) → 새 원본의 자리 {anchor, progress}
function newPlace(old, next, pdf, rec, finder) {
  const prog = Math.min(1, Math.max(0, rec.progress || 0));
  if (!next) {
    // 글이 없는 PDF — 쪽으로만
    if (!pdf) return null;
    return { anchor: { p: Math.round(prog * Math.max(0, pdf.pages - 1)), y: 0 }, progress: prog };
  }
  let s = null;
  let o = null;
  const at = old ? oldLoc(old, rec) : null;
  if (at) {
    const t = old.texts[at.s] || '';
    // 그 자리부터 글귀(앞쪽 빈칸·줄바꿈은 건너뛰고) — 끝이면 앞 글귀로
    let a = at.o;
    while (a < t.length && /\s/.test(t[a])) a++;
    let quote = t.slice(a, a + 60);
    let prefix = t.slice(Math.max(0, a - 40), a);
    let back = 0;
    if (quote.replace(/\s/g, '').length < 6) { back = Math.min(a, 60); quote = t.slice(a - back, a); prefix = t.slice(Math.max(0, a - back - 40), a - back); }
    const suffix = back ? t.slice(a, a + 40) : t.slice(a + quote.length, a + quote.length + 40);
    const was = (old.book.sections[at.s].start + a) / Math.max(1, old.book.chars);
    const hit = finder.find(quote, prefix, suffix, was, { minBare: 6 });
    if (hit) { s = hit.s; o = back ? hit.end : hit.start; }
  }
  if (s == null) ({ s, o } = fromGlobal(next.book, Math.floor(prog * next.book.chars)));
  const anchor = { s, o };
  if (pdf && next.book.pageStarts) Object.assign(anchor, pageOf(next.book, s, o));
  return { anchor, progress: next.book.chars ? toGlobal(next.book, s, o) / next.book.chars : prog };
}

function oldLoc(old, rec) {
  if (Number.isInteger(rec.s) && old.texts[rec.s] != null) return { s: rec.s, o: Math.max(0, Math.min(rec.o || 0, old.texts[rec.s].length)) };
  const st = old.book.pageStarts;
  if (Number.isInteger(rec.p) && st?.length) {
    const i = Math.max(0, Math.min(rec.p, st.length - 1));
    const nx = i + 1 < st.length ? st[i + 1] : old.book.chars;
    return fromGlobal(old.book, Math.round(st[i] + (nx - st[i]) * Math.min(1, Math.max(0, rec.y || 0))));
  }
  return null;
}

// 새 원본의 글에서 글귀 찾기 — 세 단계로, 앞 단계에서 찾으면 거기서 끝:
//  ① 글 그대로 ② 빈칸 여럿·줄바꿈을 빈칸 하나로(보이지 않는 글자 빼고) ③ 빈칸을 모두 빼고(띄어쓰기가 다른 판 — 이 기능의 주된 경우)
// 단계 안에서는 앞뒤 글이 가장 많이 맞는 곳, 같으면 원래 구획의 가까운 곳. 구획마다 바꾼 글은 한 번만 만든다
const INVISIBLE = /[­​-‍⁠﻿]/;
const WS = /[\s 　]/;
const STAGES = [
  null,
  (t) => { let out = ''; const back = []; let sp = true; for (let i = 0; i < t.length; i++) { const c = t[i]; if (INVISIBLE.test(c)) continue; if (WS.test(c)) { if (sp) continue; sp = true; out += ' '; back.push(i); } else { sp = false; out += c; back.push(i); } } return { s: out, back }; },
  (t) => { let out = ''; const back = []; for (let i = 0; i < t.length; i++) { const c = t[i]; if (INVISIBLE.test(c) || WS.test(c)) continue; out += c; back.push(i); } return { s: out, back }; },
];
const MIN = [1, 2, 4];

class Finder {
  // book: 새 원본 책(구획 시작 위치로 '책 전체에서 몇 %'를 센다 — 장이 하나 더 있는 판이면 구획 번호로는 가까운 곳을 못 가린다)
  constructor(texts, book) {
    this.texts = texts;
    this.book = book;
    this.views = STAGES.map(() => new Map());
  }

  frac(s, o) {
    const b = this.book;
    return b?.chars ? (b.sections[s].start + o) / b.chars : 0;
  }

  view(k, s) {
    const t = this.texts[s] || '';
    if (!STAGES[k]) return { s: t, back: null };
    let v = this.views[k].get(s);
    if (!v) { v = STAGES[k](t); this.views[k].set(s, v); }
    return v;
  }

  // near: 옛 원본에서 그 글이 있던 곳(책 전체의 몇 %, 모르면 null) — 앞뒤 글이 똑같이 맞는 후보가 여럿이면 가장 가까운 곳
  find(quote, prefix, suffix, near, { minBare = 4 } = {}) {
    const n = this.texts.length;
    for (let k = 0; k < STAGES.length; k++) {
      const tf = (x) => (STAGES[k] ? STAGES[k](x).s : x);
      const q = k === 1 ? tf(quote).trim() : tf(quote);
      if (q.length < (k === 2 ? minBare : MIN[k]) || !q.trim()) continue;
      const pre = tf(prefix);
      const suf = tf(suffix);
      let best = null;
      for (let s = 0; s < n; s++) {
        const v = this.view(k, s);
        const at = (i) => (v.back ? v.back[i] : i);
        for (let i = v.s.indexOf(q), c = 0; i >= 0 && c < 500; i = v.s.indexOf(q, i + 1), c++) {
          const ctx = tailMatch(v.s.slice(Math.max(0, i - pre.length), i), pre) + headMatch(v.s.slice(i + q.length, i + q.length + suf.length), suf);
          const close = near == null ? 0 : 1.5 * (1 - Math.min(1, Math.abs(this.frac(s, at(i)) - near) * 4));
          const score = ctx * 2 + close;
          if (!best || score > best.score) best = { s, start: at(i), end: at(i + q.length - 1) + 1, score };
        }
      }
      if (best) return { s: best.s, start: best.start, end: best.end };
    }
    return null;
  }
}

const tailMatch = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const headMatch = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

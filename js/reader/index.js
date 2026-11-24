// 읽기 화면 조율: 보기(줄글·전자책·PDF), 위치 저장, 하이라이트·메모·책갈피, 찾기, 링크·각주
import { h, esc, debounce, throttle, sleep, toast, copyText, now, uid, emit, on, fmtMinutes, clamp } from '../util.js';
import { ico } from '../icons.js';
import {
  state, saveAnn, removeAnn, restoreAnn, savePos, liveAnns, setDocReader, setApp, readerFor, addReadingTime, addReadingProgress,
  readingSpeed, flushPositions, flushStats, getFile,
} from '../store.js';
import { loadBook, loadResources, requireFile, loadPdfTexts, cachedBook } from '../docs.js';
import { openPdf, pdfOutline, closePdf } from '../pdfdoc.js';
import { textOf, offsetsFromRange, describe, resolveAnchor, offsetOfBoundary, textIndex, rangeFromOffsets, sentenceBounds } from '../text.js';
import { rootFrom } from '../parse/common.js';
import { FlowView } from './flow.js';
import { PagedView } from './paged.js';
import { PdfView } from './pdfview.js';
import { Painter, HL_SUPPORTED } from './painter.js';
import { TouchSelect } from './touchsel.js';
import { PdfFigures } from './pdffigs.js';
import { buildChapters, chapterAt, randomChapter, toGlobal, fromGlobal } from './chapters.js';
import { sheet, menu, popover, closePopovers, confirmDialog, closeAllOverlays } from '../ui/overlay.js';
import * as panels from './panels.js';
import { lookupMenu, citeText, noteEditor, tagsOf, shareQuoteCard } from './actions.js';
import { fetchRemoteFile, isStale, whenFresh, pullOcr, pushOcrIfBehind } from '../sync/sync.js';
import { startOcr } from './ocrsheet.js';
import { fixesOf, fixSig, fixAnchor, planFixes, patchBook, origToCur, curToOrig } from '../fixes.js';
import { openSpacing, openFixList } from './spacing.js';
import { pickReplacement, bakeFixes } from '../replace.js';

export const COLORS = [
  { name: '노랑', key: 'yellow' },
  { name: '민트', key: 'mint' },
  { name: '분홍', key: 'rose' },
  { name: '파랑', key: 'blue' },
];

let current = null;
export const currentReader = () => current;

export async function openReader(docId, opts = {}) {
  if (current) await current.close({ silent: true });
  const doc = state.docs.get(docId);
  if (!doc || doc.deleted) {
    toast('문서를 찾을 수 없습니다.');
    return null;
  }
  const r = new Reader(doc, opts);
  current = r;
  await r.init();
  return r;
}

export async function closeReader() {
  if (current) await current.close();
}

// ── 책 본문 문단 ──
// EPUB 책 CSS 는 문단마다 'line-height:1.7em; text-indent:1em; margin:0 1em'처럼 박아 두는 일이 많아, '책 원래 서식'을 켜면
// 앱 읽기 설정(줄 간격·들여쓰기·문단 간격·좌우 여백·정렬)이 졌다(2026-11-22 사용자 지적: 『돈을 이기는 법』·코스톨라니, "앞으로 비슷한 책에도").
// 그래서 전자책 보기에서 책 CSS 를 쓸 때, 그려진 문단 가운데 '보통 본문'인 것에 g-bodyp 를 달아 reader.css @layer gbody 가 앱 설정으로 덮는다.
//  · 기준: 책에서 가장 많은 글이 든 문단 종류(태그+class, bodyParaSigs)의 계산된 모양(글자 크기·왼쪽 여백·위 간격)
//  · 그와 같은 모양이면 class 가 달라도 본문(문단 종류가 여럿으로 쪼개진 책), 다르게 꾸민 문단 — 가운데·오른쪽 맞춤, 글자 크기가 다름(판권·각주·제목),
//    더 들여 쓴 것(인용·시), 내어 쓰기(목록), 기울임·굵게 한 문단 전체, 테두리 상자, 위로 크게 띄운 것(장면 바뀜) — 은 책 서식 그대로
//  · 본문 문단의 대부분을 감싼 바깥 상자의 좌우 여백도 앱 여백으로(g-bodywrap)
const PARA_SKIP = 'table, li, figure, aside, nav, header, footer, pre';
const PARA_BLOCKS = 'p, div, table, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6, figure, section, article, pre';
const paraSig = (el) => `${el.tagName}|${(el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).sort().join(' ')}`;
function paraCandidate(el) {
  if (el.tagName === 'DIV' && el.querySelector(PARA_BLOCKS)) return false; // 글을 담은 맨 안쪽 div 만
  if (el.closest(PARA_SKIP)) return false;
  // 앱이 만든 문단은 뺀다. 문단마다 직접 붙인 style 은 따지지 않는다 — 변환기 책은 본문 문단마다 'line-height:1.6'을 붙여 두기도 한다(셀든 책).
  // 가운데 맞춤·깊은 들여쓰기처럼 직접 꾸민 특별한 문단은 그려진 모양으로 가린다(markBodyParas)
  return !/(^|\s)g-/.test(el.getAttribute('class') || '');
}
function bodyParaSigs(book) {
  const tally = new Map();
  let total = 0;
  const tpl = document.createElement('template');
  for (const sec of book.sections) {
    tpl.innerHTML = sec.html;
    for (const el of tpl.content.querySelectorAll('p, div')) {
      if (!paraCandidate(el)) continue;
      const n = el.textContent.replace(/\s+/g, '').length;
      if (!n) continue;
      const sig = paraSig(el);
      tally.set(sig, (tally.get(sig) || 0) + n);
      total += n;
    }
  }
  tpl.innerHTML = '';
  // class 없는 문단은 책의 기본 문단이다 — 늘 본문. 그 밖에는 글의 15% 넘게 든 종류
  const out = new Set();
  for (const [sig, n] of tally) if (sig === 'P|' || n >= total * 0.15) out.add(sig);
  return out;
}

class Reader {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts;
    this.isPdf = doc.format === 'pdf';
    this.resolved = new Map();
    this.unitAnns = new Map();
    this.painter = new Painter();
    this.find = null;
    this.backStack = [];
    // 휴대폰은 안드로이드 앱처럼 접힌 채로 시작하고 읽어 내려가면 접는다. 넓은 화면은 펼쳐 둔다
    this.narrow = innerWidth < 900;
    this.collapsed = this.narrow;
    this.lastActivity = Date.now();
    this.offs = [];
    this.alive = true;
    this.res = { urls: new Map(), revoke() {} };
    this.holdPos = false; // 다른 기기의 변경을 받기 전 — 읽던 자리를 쓰지 않고 모아 둔다(holdUntilFresh)
    this.heldPatch = null;
  }

  // ── 시작 ──
  async init() {
    this.buildChrome();
    const host = document.getElementById('app-reader');
    host.replaceChildren(this.root);
    host.hidden = false;
    document.body.classList.add('reading');
    this.setLoading('여는 중');
    try {
      this.pos = state.pos.get(this.doc.id) || {};
      if (this.doc.format === 'pdf') await this.decidePdfView();
      if (!this.alive) return;
      if (this.isPdf) await this.loadPdf(); else await this.loadText();
      if (!this.alive) return;
      // 켠 뒤·오래 가렸다 돌아온 뒤 다른 기기의 변경을 아직 받지 못했으면(로딩 화면을 건너뛴 때 등) 받기가 끝날 때까지
      // 읽던 자리를 쓰지 않는다 — 옛 자리를 '방금 연 자리'로 찍어 다른 기기에서 더 읽은 자리를 덮지 않게
      this.holdPos = isStale();
      this.pos = state.pos.get(this.doc.id) || {};
      this.openedFrom = this.pos;
      await this.mountView(this.initialView(), { loc: this.initialLoc(), fresh: true });
      // 연 시각은 읽던 위치 기록(pos)에만 남긴다 — 문서 기록에 찍으면 아직 동기화 전인 기기에서 열기만 해도
      // 문서 기록이 '더 최근'이 되어 다른 기기에서 바꾼 이름을 옛 이름으로 되돌렸다
      this.openedPatch = { openedAt: now(), view: this.view.kind === 'paged' ? 'paged' : (this.isPdf ? 'pdf' : 'flow') };
      if (this.holdPos) this.holdUntilFresh();
      else this.writePos(this.openedPatch);
      this.setLoading(null);
      this.startTimers();
      this.bindGlobal();
      if (this.opts.find) this.openFind(this.opts.find);
      if (this.opts.annId) setTimeout(() => this.jumpToAnn(this.opts.annId), 120);
      if (!HL_SUPPORTED && !sessionStorage.getItem('g-hl-warn')) {
        sessionStorage.setItem('g-hl-warn', '1');
        toast('이 브라우저는 하이라이트 색칠을 지원하지 않습니다. 최신 크롬을 권합니다.');
      }
    } catch (e) {
      console.error(e);
      this.setLoading(null);
      this.showError(e?.message || String(e));
    }
  }

  // 읽기 설정 = 설정 화면의 기본값 위에 이 문서에서 바꾼 값
  get settings() {
    return readerFor(this.doc.id);
  }

  // PDF: 전자책처럼 다시 짠 글로 볼지 원본 쪽 그대로 볼지. 직접 고른 적이 있으면 그대로, 아니면 다시 짤 수 있는 문서는 전자책처럼
  async decidePdfView() {
    const pick = this.opts.pdfView || this.pos.pdfView || globalThis.__gTest?.pdfView || null;
    if (pick === 'original') {
      this.isPdf = true;
      // 찾기 결과 등에서 책 위치(구획·글자)로 왔으면 쪽으로 바꾸려고 책을 불러 둔다
      if (Number.isInteger(this.opts.loc?.s)) {
        try { this.bookRec = await loadBook(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile }); this.book = this.bookRec.book.reflow === false ? null : this.bookRec.book; } catch { /* 책이 없으면 첫 쪽으로 */ }
      } else {
        // 메뉴(글자 인식)를 보여 줄지 알려고 — 변환은 하지 않는다
        this.bookRec = await cachedBook(this.doc).catch(() => null);
      }
      return;
    }
    try {
      const status = { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile };
      let rec = await loadBook(this.doc, status);
      // 글자 인식이 필요한 문서: 다른 기기에서 읽어 둔 것이 있으면 받아 책을 다시 엮는다
      const scan = rec.book.scan;
      if (scan?.pages.length && scan.done < scan.pages.length) {
        const added = await pullOcr(this.doc, { onStatus: status.onStatus }).catch(() => 0);
        if (added) rec = await loadBook(this.doc, { ...status, force: true });
      }
      if (rec.book.scan?.done) pushOcrIfBehind(this.doc, rec.book.scan.done).catch(() => {});
      this.bookRec = rec;
      this.isPdf = rec.book.reflow === false || (pick !== 'book' && !!rec.book.preferOriginal);
    } catch (e) {
      console.warn('PDF를 전자책으로 정리하지 못했습니다', e);
      this.isPdf = true;
    }
  }

  initialView() {
    if (this.isPdf) return 'pdf';
    if (this.opts.view) return this.opts.view;
    // 직접 고른 적이 있으면 그 보기, 아니면 EPUB·PDF는 전자책 보기·나머지는 줄글 보기(__gTest: 시험 도구가 옛 기본으로 열 때)
    if (this.pos.viewPick && this.pos.view !== 'pdf') return this.pos.view === 'paged' ? 'paged' : 'flow';
    return globalThis.__gTest?.view || (this.doc.format === 'epub' || this.doc.format === 'pdf' ? 'paged' : 'flow');
  }

  initialLoc() {
    if (this.opts.loc) return this.normalLoc(this.opts.loc);
    return this.locOf(this.pos);
  }

  // PDF: 책 위치 → 원본 쪽(쪽 안 비율)
  pageLocOf(loc) {
    const st = this.book.pageStarts;
    const g = toGlobal(this.book, loc.s, loc.o);
    let lo = 0;
    let hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= g) lo = mid; else hi = mid - 1;
    }
    const next = lo + 1 < st.length ? st[lo + 1] : this.book.chars;
    return { p: lo, y: next > st[lo] ? +clamp((g - st[lo]) / (next - st[lo]), 0, 0.98).toFixed(3) : 0 };
  }

  // PDF: 원본 쪽(쪽 안 비율) → 책 위치
  bookLocOfPage(p, y = 0) {
    const st = this.book.pageStarts;
    const i = clamp(p || 0, 0, st.length - 1);
    const next = i + 1 < st.length ? st[i + 1] : this.book.chars;
    return fromGlobal(this.book, Math.round(st[i] + (next - st[i]) * clamp(y || 0, 0, 1)));
  }

  // 다른 보기에서 적은 위치를 지금 보기의 위치로(PDF 전자책 보기 ↔ 원본 쪽 보기)
  normalLoc(loc) {
    if (!loc || this.doc.format !== 'pdf') return loc;
    if (this.isPdf && !Number.isInteger(loc.p)) return Number.isInteger(loc.s) && this.book?.pageStarts ? this.pageLocOf(loc) : { p: 0, y: 0 };
    if (!this.isPdf && !Number.isInteger(loc.s)) return this.book?.pageStarts ? this.bookLocOfPage(loc.p, loc.y) : { s: 0, o: 0 };
    return loc;
  }

  // 읽던 자리 기록 → 화면 위치
  locOf(p) {
    if (this.isPdf) return { p: p.p || 0, y: p.y || 0 };
    if (Number.isInteger(p.s)) return { s: Math.min(p.s, this.book.sections.length - 1), o: p.o || 0 };
    if (this.doc.format === 'pdf' && Number.isInteger(p.p) && this.book.pageStarts) return this.bookLocOfPage(p.p, p.y);
    if (p.progress) return fromGlobal(this.book, Math.floor(p.progress * this.book.chars));
    return { s: 0, o: 0 };
  }

  // 두 읽던 자리 기록이 눈에 띄게 다른가(같은 구획 300자 안·PDF는 같은 쪽 15% 안이면 같은 곳으로 본다)
  farFrom(a, b) {
    if (!a || !b) return !!a;
    if (this.isPdf) return (a.p || 0) !== (b.p || 0) || Math.abs((a.y || 0) - (b.y || 0)) > 0.15;
    if (Number.isInteger(a.s) && Number.isInteger(b.s)) return a.s !== b.s || Math.abs((a.o || 0) - (b.o || 0)) > 300;
    return Math.abs((a.progress || 0) - (b.progress || 0)) > 0.005;
  }

  // 읽던 자리 쓰기 — 다른 기기의 변경을 받기 전이면 쓰지 않고 모아 둔다(화면 쪽 값만 바꾼다)
  writePos(patch, { immediate = false } = {}) {
    // 원본 파일을 바꾸는 중·바꾼 뒤 — 옛 원본 기준 자리를 쓰지 않는다(새 원본 기준 자리는 replace.js 가 이미 썼다)
    if (this.frozen) return this.pos;
    if (this.holdPos) {
      this.heldPatch = { ...this.heldPatch, ...patch };
      this.pos = { ...this.pos, ...patch };
      return this.pos;
    }
    this.pos = savePos(this.doc.id, patch, { immediate });
    return this.pos;
  }

  // 받기가 끝나면(실패·1분이 지나도) 모아 둔 자리를 쓴다. 그사이 다른 기기에서 더 읽은 자리가 들어왔으면 —
  // 여기서 움직이지 않았으면 그리로 옮기고(되돌리기 가능), 이미 읽어 나갔으면 이 자리를 지키고 그 자리로 갈 단추만 띄운다
  async holdUntilFresh() {
    const ok = await Promise.race([whenFresh(), sleep(60000).then(() => false)]);
    if (!this.alive) return;
    const opened = this.openedPatch;
    const openedFrom = this.openedFrom;
    const held = this.heldPatch || {};
    const before = this.view?.currentLoc();
    this.holdPos = false;
    this.heldPatch = null;
    const remote = state.pos.get(this.doc.id);
    const moved = this.heldMoved(held);
    // 받은 자리(이 기기가 나가며 써 둔 것은 빼고)가 연 자리와 다르면 다른 기기에서 더 읽은 것
    const there = ok && remote && remote !== openedFrom && remote !== this.heldRec && this.farFrom(remote, openedFrom) ? this.locOf(remote) : null;
    if (there && !moved) {
      // 받은 자리를 그대로 두고(모아 둔 자리 칸은 버린다) 연 시각·보기만 더한다
      const meta = Object.fromEntries(Object.entries(held).filter(([k]) => !['s', 'o', 'p', 'y', 'progress'].includes(k)));
      this.pos = remote;
      this.writePos({ ...meta, ...opened });
      await this.followTo(there, before);
      return;
    }
    this.writePos({ ...held, ...opened });
    if (there && this.mode !== 'random') toast('다른 기기에서 더 읽은 자리가 있습니다.', { action: '그 자리로', duration: 8000, onAction: () => this.goToLoc(there) });
  }

  // 연 자리에서 실제로 읽어 나갔나(처음 자리로 가며 난 스크롤 같은 것은 아님)
  heldMoved(held) {
    return ('s' in held || 'p' in held) && this.farFrom({ ...this.openedFrom, ...held }, this.openedFrom);
  }

  // 받기가 끝나기 전에 나가거나 닫을 때 — 연 자리에서 실제로 읽어 나갔으면 그 자리는 써 둔다(이 기기에서 가장 최근에 읽은 곳).
  // 그대로 두면 앱이 닫히며 읽은 만큼이 사라진다
  commitHeld() {
    if (this.frozen || !this.holdPos || !this.heldPatch || !this.heldMoved(this.heldPatch)) return;
    this.heldRec = savePos(this.doc.id, { ...this.heldPatch, ...this.openedPatch }, { immediate: true });
  }

  // 다른 기기에서 이 문서를 더 최근에 읽었다(그 자리가 들어왔다) — 그리로 따라간다
  followRemote() {
    if (this.holdPos || !this.view) return;
    const remote = state.pos.get(this.doc.id);
    const mine = this.pos;
    if (!remote || remote === mine || (remote.updatedAt || 0) <= (mine?.updatedAt || 0)) return;
    const here = this.view.currentLoc();
    this.pos = remote;
    if (this.farFrom(remote, mine)) this.followTo(this.locOf(remote), here);
  }

  async followTo(loc, before) {
    await this.goToLoc(loc, { rest: true });
    toast('다른 기기에서 읽던 자리로 옮겼습니다.', { action: '되돌리기', duration: 6000, onAction: () => { if (before) this.goToLoc(before); } });
  }

  async loadText() {
    const rec = this.bookRec || await loadBook(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
    this.bookRec = rec;
    this.applyFixes();
    this.chapters = buildChapters(this.book, this.texts);
    this.bodySigs = this.doc.format === 'epub' ? bodyParaSigs(this.book) : null;
    if (this.doc.format === 'pdf') {
      if (!this.figures) this.figures = new PdfFigures(this, this.book.figs, { fetchFile: fetchRemoteFile });
    } else if (this.doc.format === 'epub' || this.doc.format === 'docx') {
      const blob = await requireFile(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
      const res = await loadResources(this.doc, blob);
      if (!this.alive) { res.revoke(); return; }
      this.res = res;
    }
  }

  async loadPdf() {
    const blob = await requireFile(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
    this.setLoading('PDF 여는 중');
    const pdf = await openPdf(blob);
    if (!this.alive) { closePdf(pdf); return; }
    this.pdf = pdf;
    this.texts = [];
    this.pdfToc = null;
    this.pdfTextsPromise = loadPdfTexts(this.doc, this.pdf).catch(() => null);
    this.pdfTextsPromise.then((texts) => {
      if (!this.alive || !texts) return;
      this.pageTexts = texts;
      if (!this.isPdf) return;
      this.texts = texts;
      // 글이 늦게 왔으면 그사이 못 찾은 하이라이트를 다시 찾는다
      this.resolved.clear();
      for (const u of this.view?.roots?.keys() || []) this.paintUnit(u);
    });
  }

  // ── 화면 틀 ──
  buildChrome() {
    const d = this.doc;
    this.root = h('div', { class: `rd${this.collapsed ? ' collapsed' : ''}`, 'data-format': d.format });
    this.applyTheme();
    this.top = h('header', { class: 'rd-top' });
    this.mini = h('button', { class: 'rd-mini', 'aria-label': '읽기 메뉴 펼치기', html: ico('down'), onclick: () => this.setCollapsed(false) });
    this.titleBtn = h('button', { class: 'rd-title', onclick: () => this.setCollapsed(true), title: '읽기 메뉴 접기' },
      h('span', { class: 'rd-title-text' }, d.title), h('span', { html: ico('up', 'rd-title-caret') }));
    this.bmBtn = h('button', { class: 'gicon rd-bm', 'aria-label': '책갈피', html: ico('bookmark'), onclick: () => this.toggleBookmark() });
    this.panelBtn = h('button', { class: 'gicon rd-panel-btn', 'aria-label': '옆 창', html: ico('panel'), onclick: () => this.togglePanel() });
    this.bar = h('div', { class: 'rd-bar' },
      h('button', { class: 'gicon', 'aria-label': '서재로', html: ico('back'), onclick: () => history.back() }),
      this.titleBtn,
      h('div', { class: 'rd-actions' },
        h('button', { class: 'gicon', 'aria-label': '찾기', title: '찾기 (Ctrl+F)', html: ico('search'), onclick: () => this.openFind() }),
        h('button', { class: 'gicon', 'aria-label': '목차', title: '목차 (T)', html: ico('toc'), onclick: () => this.showToc() }),
        this.bmBtn,
        this.panelBtn,
        h('button', { class: 'gicon', 'aria-label': '읽기 메뉴', html: ico('more'), onclick: (e) => this.showMenu(e.currentTarget) })));
    this.findBar = h('div', { class: 'rd-find', hidden: true });
    this.chapBar = h('div', { class: 'rd-chap', hidden: true });
    this.progressEl = h('div', { class: 'rd-progress' }, h('i'));
    this.top.append(this.mini, this.bar, this.findBar, this.chapBar, this.progressEl);
    this.host = h('div', { class: 'rd-host' });
    this.side = h('aside', { class: 'rd-side', hidden: true });
    this.main = h('div', { class: 'rd-main' }, this.host, this.side);
    this.foot = h('footer', { class: 'rd-foot' });
    this.pgInfo = h('div', { class: 'rd-pg', 'aria-live': 'off' });
    this.loading = h('div', { class: 'rd-loading', hidden: true }, h('div', { class: 'spinner' }), h('div', { class: 'rd-loading-msg' }));
    this.backChip = h('button', { class: 'rd-backchip', hidden: true, onclick: () => this.goBackLink() }, h('span', { html: ico('undo') }), '원래 자리로');
    this.selTool = h('div', { class: 'seltool', hidden: true, role: 'toolbar', 'aria-label': '선택한 글' });
    this.root.append(this.top, this.main, this.foot, this.pgInfo, this.backChip, this.selTool, this.loading);
    this.host.addEventListener('click', (e) => this.onContentClick(e));
    this.host.addEventListener('contextmenu', (e) => {
      // PC 오른쪽 단추로 선택한 글 메뉴
      const sel = getSelection();
      if (sel && !sel.isCollapsed && this.pending) { e.preventDefault(); this.showSelTool(true); }
    });
    // 휴대폰·태블릿은 기본 선택(복사·번역·웹 검색 메뉴가 같이 뜬다) 대신 앱이 직접 고른다
    this.tsel = new TouchSelect(this);
    if (innerWidth >= 1100 && state.app.readerPanel) this.togglePanel(true);
  }

  applyTheme() {
    const st = this.settings;
    const r = this.root;
    r.classList.remove('pal-paper', 'pal-sepia', 'pal-night');
    r.classList.add(`pal-${st.palette}`);
    r.style.setProperty('--fs', `${st.fontSize}px`);
    r.style.setProperty('--lh', String(st.lineHeight));
    r.style.setProperty('--mx', `${st.margin}px`);
    r.style.setProperty('--maxw', `${st.maxWidth}px`);
    r.style.setProperty('--pgap', `${st.paraGap}em`);
    r.style.setProperty('--indent', `${st.indent}em`);
    r.dataset.font = st.typeface;
    r.dataset.align = st.align;
    r.dataset.keep = st.keepAll ? '1' : '0';
    r.dataset.hyph = st.hyphens ? '1' : '0';
    r.dataset.bookstyle = st.bookStyle ? '1' : '0';
    r.dataset.pdfinvert = st.pdfInvert === false ? '0' : '1';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', st.palette === 'night' ? '#131815' : st.palette === 'sepia' ? '#F2E6CB' : '#FAF9F5');
  }

  setLoading(msg) {
    if (!this.loading) return;
    this.loading.hidden = !msg;
    if (msg) this.loading.querySelector('.rd-loading-msg').textContent = msg;
  }

  showError(message) {
    this.host.replaceChildren(h('div', { class: 'rd-error' },
      h('div', { html: ico('warning', 'big') }),
      h('h2', null, '문서를 열 수 없습니다'),
      h('p', null, message),
      h('button', { class: 'gbtn', onclick: () => history.back() }, '서재로')));
  }

  // ── 보기 만들기 ──
  // fresh: 문서를 처음 열 때(무작위 보기면 새 장을 고른다). 보기만 바꿀 때는 자리를 지킨다
  async mountView(kind, { loc, fresh = false } = {}) {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.root.dataset.view = kind;
    if (kind === 'pdf') this.view = new PdfView(this);
    else if (kind === 'paged') this.view = new PagedView(this);
    else this.view = new FlowView(this);
    await this.view.mount(this.host);
    if (kind === 'flow') {
      this.mode = this.pos.mode || 'full';
      if (fresh && this.opts.mode) this.mode = this.opts.mode;
      await this.renderFlowMode(loc, { fresh });
    } else if (kind === 'paged') {
      this.mode = this.pos.mode || 'full';
      await this.view.showSection(loc.s, { o: loc.o });
    } else {
      this.mode = this.pos.mode === 'random' ? 'random' : 'full';
      await this.view.goTo(loc);
      if (this.mode === 'random') await this.pdfRandom({ quiet: true });
    }
    this.updateChapBar();
    this.updateBookmarkBtn();
    setTimeout(() => {
      const l = this.view?.currentLoc();
      // 연 자리에 맞춘 화면이 멈춘 곳 — 여기서 움직이지 않았으면 읽던 자리를 다시 쓰지 않는다(savePosition)
      this.restLoc = l;
      if (l) this.onLocate(l, { initial: true });
    }, 250);
  }

  async renderFlowMode(loc, { fresh = false } = {}) {
    const g = loc ? toGlobal(this.book, loc.s, loc.o) : 0;
    if (this.mode === 'full') {
      this.chapterIndex = chapterAt(this.chapters, g);
      this.view.render(null);
      await this.view.goTo(loc || { s: 0, o: 0 });
    } else {
      const explicit = this.opts.loc || this.opts.annId;
      if (this.mode === 'random' && !explicit && (fresh || this.chapterIndex == null)) {
        this.chapterIndex = randomChapter(this.chapters, fresh ? -1 : this.chapterIndex);
        loc = fromGlobal(this.book, this.chapters[this.chapterIndex].start);
      } else {
        this.chapterIndex = chapterAt(this.chapters, g);
      }
      const ch = this.chapters[this.chapterIndex];
      this.view.render({ from: ch.start, to: ch.end });
      const target = loc && this.view.contains(loc) ? loc : fromGlobal(this.book, ch.start);
      await this.view.goTo(target);
      if (this.mode === 'random') this.savePosition(target, { force: true });
    }
    this.updateChapBar();
  }

  // 보기 바꾸기: flow ↔ paged
  async setView(kind) {
    if (this.isPdf || this.view?.kind === kind) return;
    const loc = this.view?.currentLoc() || this.initialLoc();
    this.setLoading('보기 바꾸는 중');
    await sleep(10);
    await this.mountView(kind, { loc, fresh: false });
    this.setLoading(null);
    this.writePos({ view: kind, viewPick: true });
    toast(kind === 'paged' ? '전자책 보기' : '줄글 보기', { duration: 1200 });
  }

  // 글자 인식으로 책이 새로 엮였다 — open: 원본 쪽을 보던 중이면 전자책 보기로 넘어간다
  async adoptBook(rec, { open = false } = {}) {
    const wasBook = !this.isPdf;
    const here = this.view?.currentLoc();
    const page = wasBook && here && this.book?.pageStarts ? this.pageLocOf(here) : here;
    this.bookRec = rec;
    this.book = null;
    this.chapters = null;
    this.figures?.destroy();
    this.figures = null;
    if (rec.book.reflow === false) return;
    if (wasBook) {
      this.view?.destroy();
      this.view = null;
      this.resolved.clear();
      this.clearSelection();
      await this.loadText();
      await this.mountView(this.initialView(), { loc: page ? this.bookLocOfPage(page.p, page.y) : { s: 0, o: 0 }, fresh: false });
      this.updateFooter();
    } else if (open) {
      await this.switchPdfView(false);
    }
  }

  // 글자 인식 메뉴: 글자 층이 없는 쪽이 남아 있을 때만. 책으로 잘 읽히는 문서의 그림 쪽 몇 장(표지 등)은 권하지 않는다
  ocrMenuItem() {
    const b = this.bookRec?.book;
    const scan = b?.scan;
    if (this.doc.format !== 'pdf' || !scan?.pages.length || scan.done >= scan.pages.length) return null;
    if (b.reflow !== false && !b.preferOriginal && scan.pages.length < Math.max(3, b.pages * 0.1)) return null;
    return { label: scan.done ? `글자 인식 이어 하기 (${scan.done}/${scan.pages.length}쪽)` : '글자 인식으로 전자책 만들기', icon: 'scanText', onClick: () => startOcr(this) };
  }

  // PDF: 전자책처럼 보기 ↔ 원본 쪽 보기(같은 자리에서 이어서)
  async switchPdfView(original) {
    if (this.doc.format !== 'pdf' || original === this.isPdf) return;
    if (this.find) await this.closeFind();
    const here = this.view?.currentLoc();
    this.setLoading('보기 바꾸는 중');
    await sleep(10);
    try {
      if (!original && !this.bookRec) this.bookRec = await loadBook(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
      if (!original && this.bookRec.book.reflow === false) {
        this.setLoading(null);
        toast('글자가 없는 PDF라 전자책처럼 다시 짤 수 없습니다.');
        return;
      }
      if (!original && !this.book) {
        this.book = this.bookRec.book;
        this.chapters = buildChapters(this.book, this.bookRec.texts);
      }
      // 지금 자리를 바꿀 보기의 위치로
      let loc = here;
      if (here && this.book?.pageStarts) loc = original ? this.pageLocOf(here) : this.bookLocOfPage(here.p, here.y);
      this.view?.destroy();
      this.view = null;
      this.resolved.clear();
      this.clearSelection();
      this.isPdf = original;
      if (original) {
        if (!this.pdf) await this.loadPdf(); else this.texts = this.pageTexts || [];
      } else {
        await this.loadText();
      }
      const kind = original ? 'pdf' : this.initialView();
      await this.mountView(kind, { loc: loc || (original ? { p: 0, y: 0 } : { s: 0, o: 0 }), fresh: false });
      this.writePos({ pdfView: original ? 'original' : 'book', view: kind });
      this.updateFooter();
      this.setLoading(null);
      toast(original ? '원본 PDF 쪽으로 봅니다.' : '전자책처럼 봅니다.', { duration: 1200 });
    } catch (e) {
      console.error(e);
      this.setLoading(null);
      toast('보기를 바꾸지 못했습니다.');
    }
  }

  async setMode(mode) {
    if (this.isPdf) {
      this.mode = mode;
      this.writePos({ mode });
      if (mode === 'random') await this.pdfRandom({});
      this.updateChapBar();
      return;
    }
    if (this.view.kind !== 'flow') await this.setView('flow');
    if (this.mode === mode && mode !== 'random') return;
    const loc = this.view.currentLoc();
    const prevMode = this.mode;
    this.mode = mode;
    this.writePos({ mode });
    await this.renderFlowMode(loc, { fresh: mode === 'random' && prevMode !== 'random' });
    if (mode === 'random' && prevMode === 'random') {
      // 무작위 → 다른 장
    }
  }

  async shuffle() {
    if (this.isPdf) return this.pdfRandom({});
    if (this.view.kind !== 'flow' || this.mode !== 'random') {
      this.mode = 'random';
      this.writePos({ mode: 'random' });
      if (this.view.kind !== 'flow') await this.setView('flow');
    }
    this.chapterIndex = randomChapter(this.chapters, this.chapterIndex ?? -1);
    const ch = this.chapters[this.chapterIndex];
    this.view.render({ from: ch.start, to: ch.end });
    const loc = fromGlobal(this.book, ch.start);
    await this.view.goTo(loc);
    this.savePosition(loc, { force: true });
    this.updateChapBar();
  }

  async selectChapter(i) {
    if (this.isPdf) return;
    i = clamp(i, 0, this.chapters.length - 1);
    this.chapterIndex = i;
    const ch = this.chapters[i];
    const loc = fromGlobal(this.book, ch.start);
    if (this.view.kind === 'flow' && this.mode !== 'full') {
      this.view.render({ from: ch.start, to: ch.end });
      await this.view.goTo(loc);
    } else {
      await this.view.goTo(loc);
    }
    this.savePosition(loc, { force: true });
    this.updateChapBar();
  }

  async pdfRandom({ quiet = false }) {
    if (!this.pdfToc) this.pdfToc = await pdfOutline(this.pdf);
    const front = /^(?:표지|목차|차례|판권|저작권|contents|table of contents|cover|copyright)(?:\s|$)/i;
    const byDepth = new Map();
    for (const e of this.pdfToc) if (!front.test(e.title)) {
      if (!byDepth.has(e.level)) byDepth.set(e.level, []);
      byDepth.get(e.level).push(e);
    }
    let targets = [];
    for (const lvl of [...byDepth.keys()].sort()) if (byDepth.get(lvl).length >= 2) { targets = byDepth.get(lvl); break; }
    if (!targets.length) targets = [...byDepth.values()].flat();
    const cur = this.view.currentLoc()?.p ?? -1;
    if (targets.length) {
      const pool = targets.filter((t) => t.page - 1 !== cur);
      const t = (pool.length ? pool : targets)[Math.floor(Math.random() * (pool.length || targets.length))];
      this.randomTitle = t.title;
      await this.view.goTo({ p: t.page - 1, y: 0 });
    } else {
      let p = Math.floor(Math.random() * this.pdf.numPages);
      if (p === cur && this.pdf.numPages > 1) p = (p + 1) % this.pdf.numPages;
      this.randomTitle = null;
      await this.view.goTo({ p, y: 0 });
      if (!quiet) toast('PDF에 목차 책갈피가 없어 글 대신 임의 쪽을 골랐습니다.');
    }
    this.updateChapBar();
  }

  updateChapBar() {
    const bar = this.chapBar;
    const showable = (this.isPdf && this.mode === 'random') || (!this.isPdf && this.view?.kind === 'flow' && this.mode !== 'full');
    // 넓은 화면은 장 막대 자리도 비워 둔다(본문 위에 겹치지 않게)
    this.root.classList.toggle('chap-on', showable);
    if (!showable) { bar.hidden = true; return; }
    bar.hidden = this.collapsed;
    bar.textContent = '';
    if (this.isPdf) {
      bar.append(
        h('button', { class: 'gicon', 'aria-label': '목차', html: ico('toc'), onclick: () => this.showToc() }),
        h('button', { class: 'rd-chap-mid', onclick: () => this.showToc() },
          h('small', null, `RANDOM · ${this.view.pageInfo().page}/${this.pdf.numPages}`),
          h('span', null, this.randomTitle || '임의 쪽')),
        h('button', { class: 'gicon', 'aria-label': '다른 곳 무작위로', html: ico('shuffle'), onclick: () => this.shuffle() }));
      return;
    }
    const i = this.chapterIndex ?? 0;
    const ch = this.chapters[i];
    const random = this.mode === 'random';
    bar.append(
      random
        ? h('button', { class: 'gicon', 'aria-label': '목차', html: ico('toc'), onclick: () => this.showToc() })
        : h('button', { class: 'gicon', 'aria-label': '이전 장', html: ico('left'), disabled: i <= 0, onclick: () => this.selectChapter(i - 1) }),
      h('button', { class: 'rd-chap-mid', onclick: () => this.showToc() },
        h('small', null, `${random ? 'RANDOM' : 'DIVIDED'} · ${i + 1}/${this.chapters.length}`),
        h('span', null, ch?.title || '')),
      random
        ? h('button', { class: 'gicon', 'aria-label': '다른 글 무작위로', html: ico('shuffle'), onclick: () => this.shuffle() })
        : h('button', { class: 'gicon', 'aria-label': '다음 장', html: ico('right'), disabled: i >= this.chapters.length - 1, onclick: () => this.selectChapter(i + 1) }));
  }

  endMarker(win) {
    const box = h('div', { class: 'flow-end', 'data-gui': '' });
    const divided = this.mode === 'divided' && win;
    const random = this.mode === 'random' && win;
    const i = this.chapterIndex ?? 0;
    const hasNext = divided && i + 1 < this.chapters.length;
    box.append(h('div', { class: 'flow-end-mark' }, hasNext ? '—  챕터 끝  —' : '—  끝  —'));
    if (hasNext) {
      box.append(h('button', { class: 'gbtn ghost', onclick: () => this.selectChapter(i + 1) }, `다음 장 · ${this.chapters[i + 1].title}`, h('span', { html: ico('right') })));
    } else if (random) {
      box.append(h('button', { class: 'gbtn ghost', onclick: () => this.shuffle() }, h('span', { html: ico('shuffle') }), '다른 글 무작위로'));
    }
    return box;
  }

  attachResources(root, onLoad) {
    this.markBodyParas(root);
    for (const img of root.querySelectorAll('img[data-g-src]')) {
      if (this.figures && !this.isPdf) { this.figures.attach(img); continue; }
      const url = this.res.urls.get(img.getAttribute('data-g-src'));
      if (url) {
        if (onLoad) img.addEventListener('load', onLoad, { once: true });
        img.src = url;
      } else {
        img.classList.add('g-img-missing');
      }
    }
    if (this.figures && !this.isPdf) this.figures.watchTables(root);
  }

  // 본문 문단에 g-bodyp(앱 읽기 설정으로 덮기) — 위 '책 본문 문단' 설명. 책 CSS 는 전자책 보기에서만 쓰므로 그때만
  markBodyParas(root) {
    if (!this.bodySigs?.size || this.view?.kind !== 'paged' || !this.settings.bookStyle) return;
    const base = parseFloat(getComputedStyle(root).fontSize) || 16;
    const items = [];
    for (const el of root.querySelectorAll('p, div')) {
      if (el.classList.contains('g-bodyp') || !paraCandidate(el)) continue;
      const n = el.textContent.replace(/\s+/g, '').length;
      if (!n) continue;
      const cs = getComputedStyle(el);
      items.push({
        el, n, body: this.bodySigs.has(paraSig(el)), fs: parseFloat(cs.fontSize) || base, align: cs.textAlign,
        left: (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.paddingLeft) || 0), top: parseFloat(cs.marginTop) || 0, indent: parseFloat(cs.textIndent) || 0,
        italic: cs.fontStyle !== 'normal', bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
        box: ['Top', 'Right', 'Bottom', 'Left'].some((s) => cs[`border${s}Style`] !== 'none' && (parseFloat(cs[`border${s}Width`]) || 0) > 0),
      });
    }
    if (!items.length) return;
    // 기준 모양: 이 구획의 본문 종류 문단(글자 수로 가중한 가운데값). 글이 적은 구획(판권·차례)이면 앞서 본 구획의 값, 그것도 없으면 앱 글자 크기 그대로
    const wmed = (arr, key) => {
      const s = [...arr].sort((a, b) => a[key] - b[key]);
      const half = s.reduce((t, x) => t + x.n, 0) / 2;
      let acc = 0;
      for (const x of s) { acc += x.n; if (acc >= half) return x[key]; }
      return s[s.length - 1][key];
    };
    const ref = items.filter((x) => x.body);
    if (ref.reduce((t, x) => t + x.n, 0) >= 1500) this.bodyRef = { fs: wmed(ref, 'fs') / base, left: wmed(ref, 'left') / base, top: wmed(ref, 'top') / base };
    const R = this.bodyRef || { fs: 1, left: 0, top: 0 };
    const plain = (x) => !/center|right|end/.test(x.align) && Math.abs(x.fs / base / R.fs - 1) <= 0.08
      && x.left - R.left * base <= x.fs && x.indent > -0.1 * x.fs && x.top <= Math.max(1.2 * x.fs, R.top * base + 0.8 * x.fs)
      && !x.italic && !x.bold && !x.box;
    const marked = items.filter(plain);
    for (const x of marked) x.el.classList.add('g-bodyp');
    // 본문 문단 대부분(글자 60% 넘게)을 감싼 바깥 상자 — 그 좌우 여백·폭은 앱 여백을 따른다
    const total = marked.reduce((t, x) => t + x.n, 0);
    if (total < 300) return;
    const wrapChars = new Map();
    for (const x of marked) {
      for (let a = x.el.parentElement; a && a !== root; a = a.parentElement) wrapChars.set(a, (wrapChars.get(a) || 0) + x.n);
    }
    for (const [a, n] of wrapChars) if (n >= total * 0.6 && !a.matches(PARA_SKIP)) a.classList.add('g-bodywrap');
  }

  // PDF 그림·표: 가운데를 누르면 크게(전자책 보기의 좌우 끝은 쪽 넘기기 그대로)
  openFigureAt(e) {
    const t = e.target.closest?.('figure.g-fig, .g-table[data-fig]');
    if (!t) return false;
    if (this.view?.kind === 'paged') {
      const box = this.host.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      if (x < 0.28 || x > 0.72) return false;
    }
    const key = t.dataset.fig || t.querySelector('img')?.getAttribute('data-g-src');
    if (!key) return false;
    this.figures.view(key);
    return true;
  }

  bookCss(keys) {
    const styles = this.book.styles || {};
    const css = keys.map((k) => styles[k] || '').join('\n');
    return css.replace(/garg-res:([^")]+)/g, (m, key) => this.res.urls.get(key) || '');
  }

  // ── 위치 ──
  onLocate(loc, { dir, atEnd, initial } = {}) {
    if (!loc || !this.alive) return;
    this.lastLoc = loc;
    if (!this.isPdf) this.figures?.nudge();
    if (this.tsel?.sel) this.tsel.place();
    this.lastActivity = Date.now();
    let progress;
    if (this.isPdf) {
      const n = this.pdf.numPages;
      progress = n <= 1 ? (atEnd ? 1 : 0) : clamp((loc.p + (loc.y || 0)) / Math.max(1, n - 1 + 0.0001), 0, 1);
      if (atEnd && progress > 0.9) progress = 1;
    } else {
      const g = toGlobal(this.book, loc.s, loc.o);
      progress = this.book.chars ? g / this.book.chars : 0;
      // 맨 끝까지 내렸을 때만 '다 읽음'(화면을 바꾸는 순간의 일시적인 끝 판정은 무시)
      if (atEnd && (this.mode === 'full' || this.view.kind === 'paged') && progress > 0.9) progress = Math.max(progress, 0.999);
      if (this.mode === 'full' || this.view.kind === 'paged') this.chapterIndex = chapterAt(this.chapters, g);
      this.trackSpeed(g);
    }
    this.progress = progress;
    this.progressEl.firstElementChild.style.width = `${(progress * 100).toFixed(2)}%`;
    this.updateFooter();
    this.updateBookmarkBtn();
    if (!initial) this.savePosition(loc, { progress });
    if (dir === 'down' && this.narrow && !this.collapsed && !this.find && this.view.kind !== 'paged') this.setCollapsed(true);
  }

  savePosition(loc, { progress, force = false } = {}) {
    if (!loc) return;
    const patch = this.isPdf ? { p: loc.p, y: loc.y || 0 } : { s: loc.s, o: loc.o };
    // PDF: 두 보기가 서로의 자리를 알 수 있게 — 전자책 보기는 원본 쪽도 함께, 원본 쪽 보기는 책 위치를 지운다(쪽으로 다시 찾는다)
    if (this.doc.format === 'pdf') {
      if (this.isPdf) { patch.s = null; patch.o = null; } else if (this.book.pageStarts) Object.assign(patch, this.pageLocOf(loc));
    }
    patch.progress = progress ?? this.progress ?? 0;
    if (patch.progress >= 0.995 && !this.pos.finishedAt) patch.finishedAt = now();
    patch.mode = this.mode;
    // 자리가 그대로면 쓰지 않는다 — 열어만 둔 휴대폰이 꺼질 때(나갈 때 저장)마다 옛 자리가 '방금 읽은 자리'로 찍혀
    // 다른 기기에서 더 읽은 자리를 덮었다. 기록에 맞춰 놓은 화면이 그대로인 것(restLoc)도 그대로로 본다(한 줄 안 차이)
    if (!patch.finishedAt && patch.mode === this.pos.mode
      && (this.samePlace(patch, this.pos) || (this.restLoc && this.samePlace(patch, this.restLoc)))) return;
    this.restLoc = null;
    this.writePos(patch, { immediate: force });
  }

  samePlace(a, b) {
    if (this.isPdf) return a.p === b.p && Math.abs((a.y || 0) - (b.y || 0)) < 0.01;
    return a.s === b.s && Math.abs((a.o || 0) - (b.o || 0)) < 40;
  }

  trackSpeed(g) {
    const t = Date.now();
    if (this.speedMark && t - this.speedMark.t < 120000) {
      const delta = g - this.speedMark.g;
      const secs = (t - this.speedMark.t) / 1000;
      if (delta > 0 && delta < 4000 && secs > 2) addReadingProgress(this.doc.id, delta, secs);
    }
    this.speedMark = { g, t };
  }

  updateFooter() {
    const pi = this.view?.pageInfo?.();
    const pct = `${Math.round((this.progress || 0) * 100)}%`;
    let left = '';
    if (!this.isPdf && this.chapters?.length > 1) left = this.chapters[this.chapterIndex ?? 0]?.title || '';
    let right = pct;
    if (!this.isPdf && this.book) {
      const remain = this.book.chars * (1 - (this.progress || 0));
      right += ` · 남은 ${fmtMinutes(remain / readingSpeed(this.doc.id))}`;
    } else if (this.isPdf && pi) right = `${pi.page} / ${pi.pages}쪽 · ${pct}`;
    this.foot.innerHTML = `<span class="rd-foot-l">${esc(left)}</span><span class="rd-foot-r">${esc(right)}</span>`;
    if (this.view?.kind === 'paged' && pi) {
      this.pgInfo.textContent = pi.wins > 1 ? `${pi.page} / ${pi.pages} (${pi.win}/${pi.wins})` : `${pi.page} / ${pi.pages}`;
      this.pgInfo.hidden = false;
    } else {
      this.pgInfo.hidden = true;
    }
    this.root.classList.toggle('pg-on', !this.pgInfo.hidden);
    if (this.isPdf && this.mode === 'random') this.updateChapBar();
  }

  setCollapsed(c) {
    if (this.find && c) return;
    this.collapsed = c;
    this.root.classList.toggle('collapsed', c);
    if (this.chapBar.childElementCount) this.chapBar.hidden = c || this.chapBar.dataset.off === '1';
    this.updateChapBar();
  }

  toggleChrome() {
    this.setCollapsed(!this.collapsed);
  }

  // 펼친 위쪽 메뉴·아래 정보 줄이 본문 칸을 덮고 있는 높이(본문 칸은 그대로이고 메뉴가 위에 겹쳐 뜬다)
  overlayInsets() {
    const main = this.main.getBoundingClientRect();
    const top = Math.max(0, this.top.getBoundingClientRect().bottom - main.top);
    const bottom = this.foot.offsetParent ? Math.max(0, main.bottom - this.foot.getBoundingClientRect().top) : 0;
    return { top, bottom };
  }

  // ── 하이라이트 ──
  unitOf(ann) {
    const a = ann.anchor || {};
    return this.isPdf ? a.p : a.s;
  }

  unitsCleared() {
    this.painter.removeWhere(() => true);
    this.unitAnns.clear();
    if (this.tsel?.dropUnit()) this.onTouchSelect(null);
  }

  unitRemoved(u) {
    const ids = this.unitAnns.get(u);
    if (ids) for (const id of ids) this.painter.remove(id);
    this.unitAnns.delete(u);
    this.painter.removeWhere((k) => k.startsWith(`find:${u}:`));
    if (this.tsel?.dropUnit(u)) this.onTouchSelect(null);
  }

  unitsRendered(units) {
    for (const u of units) this.paintUnit(u);
    if (this.find) this.paintFind(units);
  }

  unitText(u) {
    if (this.isPdf) {
      if (this.texts?.[u] != null) return this.texts[u];
      const root = this.view?.roots.get(u);
      return root ? textOf(root) : null;
    }
    return this.texts[u];
  }

  // 저장된 하이라이트 → 지금 글 안의 위치
  resolve(ann) {
    const cached = this.resolved.get(ann.id);
    if (cached && cached.v === ann.updatedAt) return cached.r;
    let r = null;
    let unknown = false;
    const a = ann.anchor;
    if (a) {
      const u0 = this.unitOf(ann);
      const t0 = u0 != null ? this.unitText(u0) : null;
      if (t0 == null && this.isPdf) unknown = true;
      if (t0 != null) {
        const m = resolveAnchor(t0, a);
        if (m) r = { u: u0, ...m };
      }
      if (!r && !this.isPdf) {
        // 다른 구획에서 찾기(문서 변환 방식이 바뀐 경우)
        for (let u = 0; u < this.texts.length && !r; u++) {
          if (u === u0) continue;
          const m = resolveAnchor(this.texts[u], { ...a, start: undefined, end: undefined });
          if (m) r = { u, ...m };
        }
      }
    }
    if (!unknown) this.resolved.set(ann.id, { v: ann.updatedAt, r });
    if (r && a && (a.legacy || a.s !== r.u) && !this.isPdf) {
      // 옛 위치 정보(안드로이드에서 옮겨 온 것 등)를 지금 위치로 고쳐 둔다
      const root = this.view?.roots.get(r.u);
      const text = this.texts[r.u];
      const fixed = { s: r.u, start: r.start, end: r.end, quote: text.slice(r.start, r.end), prefix: text.slice(Math.max(0, r.start - 32), r.start), suffix: text.slice(r.end, r.end + 32) };
      if (a.p != null) fixed.p = a.p;
      void root;
      saveAnn({ id: ann.id, anchor: fixed }, { silent: true }).then((saved) => this.resolved.set(ann.id, { v: saved.updatedAt, r }));
    }
    return r;
  }

  annsOfDoc(kind = 'hl') {
    return liveAnns(this.doc.id).filter((a) => a.kind === kind);
  }

  paintUnit(u) {
    const root = this.view?.roots.get(u);
    if (!root) return;
    const prev = this.unitAnns.get(u);
    if (prev) for (const id of prev) this.painter.remove(id);
    for (const m of root.querySelectorAll('.g-note-mark')) m.remove();
    const ids = new Set();
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (!r || r.u !== u) continue;
      const range = this.view.rangeAt(u, r.start, r.end);
      if (!range) continue;
      this.painter.add(ann.id, `g-hl-${ann.color || 0}`, range);
      ids.add(ann.id);
      if (ann.note) this.addNoteMark(root, range, ann);
    }
    this.unitAnns.set(u, ids);
  }

  addNoteMark(root, range, ann) {
    let el = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    if (this.isPdf) {
      const rect = range.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const mark = h('button', { class: 'g-note-mark pdf', 'data-gui': '', 'data-ann': ann.id, 'aria-label': '메모 보기', html: ico('note') });
      mark.style.left = `${Math.min(box.width - 18, rect.right - box.left + 2)}px`;
      mark.style.top = `${rect.top - box.top - 6}px`;
      root.append(mark);
      return;
    }
    const block = el?.closest?.('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th, figcaption, pre, div') || root;
    const target = root.contains(block) ? block : root;
    target.append(h('button', { class: 'g-note-mark', 'data-gui': '', 'data-ann': ann.id, 'aria-label': '메모 보기', html: ico('note') }));
  }

  refreshAnns() {
    this.resolved.clear();
    for (const u of this.view?.roots?.keys() || []) this.paintUnit(u);
    this.updateBookmarkBtn();
    if (this.side && !this.side.hidden) panels.renderSide(this);
    for (const fn of this.sheetRefreshers || []) { try { fn(); } catch { /* 닫히는 중 */ } }
  }

  flash(range) {
    if (!range) return;
    this.painter.add('flash', 'g-flash', range);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.painter.remove('flash'), 1800);
  }

  // ── 띄어쓰기 고침(fixes.js) ──
  // 변환본(bookRec)은 그대로 두고 고침을 입힌 책·글을 this.book·this.texts 로 쓴다
  applyFixes() {
    const rec = this.bookRec;
    const fixes = fixesOf(this.doc.id);
    const { plan } = planFixes(rec.texts, fixes);
    const { book, texts } = patchBook(rec.book, rec.texts, plan);
    this.book = book;
    this.texts = texts;
    this.fixPlan = plan;
    this.fixSigNow = fixSig(fixes);
  }

  // 고침을 더하거나 되돌린다. changes: [{add: {op, o}} | {remove: [id…]} | {restore: [기록…]}] — u 구획, o 는 원래 글 위치.
  // 그 구획의 하이라이트·책갈피를 고친 글로 옮기고(다른 기기에도 그대로 가게 기록을 고친다) 같은 자리로 다시 그린다
  async applyFixChange(u, changes, { announce = true } = {}) {
    if (this.isPdf || !this.bookRec?.texts || !changes?.length) return null;
    const base = this.bookRec.texts[u];
    const oldPlan = this.fixPlan;
    const here = this.view?.currentLoc();
    // 옮길 것: 지금(고치기 전 글) 위치
    const hl = [];
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (r) hl.push({ ann, r });
    }
    const added = [];
    const removed = [];
    this.fixBusy = true;
    try {
      for (const c of changes) {
        if (c.add) {
          const rec = await saveAnn({ id: uid('x'), docId: this.doc.id, kind: 'fix', op: c.add.op, anchor: fixAnchor(base, u, c.add.o, c.add.op) }, { silent: true });
          added.push(rec.id);
        }
        for (const id of c.remove || []) {
          const prev = await removeAnn(id, { silent: true });
          if (prev) removed.push(prev);
        }
        for (const snap of c.restore || []) {
          await restoreAnn(snap, { silent: true });
          added.push(snap.id);
        }
      }
      await this.refix(oldPlan, here, { hl });
    } finally {
      this.fixBusy = false;
    }
    if (announce) {
      toast('띄어쓰기를 고쳤습니다.', {
        action: '되돌리기',
        duration: 6000,
        onAction: () => this.applyFixChange(u, [{ remove: added, restore: removed }], { announce: false }),
      });
    }
    return { added, removed };
  }

  // 고침 묶음이 바뀐 뒤: 다시 입히고, (이 기기에서 고친 것이면) 하이라이트·책갈피를 옮기고, 같은 글자 자리에서 다시 그린다
  async refix(oldPlan, here, moving = null) {
    this.applyFixes();
    const same = (a = [], b = []) => a.length === b.length && a.every((e, i) => e.o === b[i].o && e.op === b[i].op);
    const changed = new Set();
    for (const s of new Set([...oldPlan.keys(), ...this.fixPlan.keys()])) if (!same(oldPlan.get(s), this.fixPlan.get(s))) changed.add(s);
    const mapper = (s) => {
      const a = oldPlan.get(s) || [];
      const b = this.fixPlan.get(s) || [];
      return (c) => origToCur(b, curToOrig(a, c).o);
    };
    if (moving && changed.size) {
      for (const { ann, r } of moving.hl) {
        if (!changed.has(r.u)) continue;
        const map = mapper(r.u);
        const start = map(r.start);
        const end = Math.max(start + 1, map(r.end - 1) + 1);
        const t = this.texts[r.u];
        const a = ann.anchor || {};
        const anchor = { ...a, s: r.u, start, end, quote: t.slice(start, end), prefix: t.slice(Math.max(0, start - 32), start), suffix: t.slice(end, end + 32) };
        if (anchor.start !== a.start || anchor.end !== a.end || anchor.quote !== a.quote || anchor.prefix !== a.prefix || anchor.suffix !== a.suffix || a.s !== r.u) {
          await saveAnn({ id: ann.id, anchor }, { silent: true });
        }
      }
      for (const b of this.annsOfDoc('bm')) {
        const a = b.anchor || {};
        if (!Number.isInteger(a.s) || !changed.has(a.s) || !Number.isInteger(a.o)) continue;
        const o = mapper(a.s)(a.o);
        if (o !== a.o) await saveAnn({ id: b.id, anchor: { ...a, o } }, { silent: true });
      }
    }
    const loc = here && changed.has(here.s) && Number.isInteger(here.o) ? { s: here.s, o: mapper(here.s)(here.o) } : here;
    this.clearSelection();
    if (this.tts) panels.stopSpeech(this);
    this.chapters = buildChapters(this.book, this.texts);
    this.resolved.clear();
    if (this.view) await this.mountView(this.view.kind, { loc: loc || this.locOf(this.pos), fresh: false });
    if (this.find?.q) await this.runFind(this.find.q);
    this.refreshAnns();
    this.updateFooter();
  }

  // 다른 기기에서 띄어쓰기를 고쳤다(기록이 들어왔다) — 다시 입혀 그린다. 하이라이트는 고친 기기가 이미 옮겨 보냈다
  async syncFixes() {
    if (this.fixBusy || this.isPdf || !this.bookRec?.texts || !this.view || !this.alive) return;
    if (state.docs.get(this.doc.id)?.fileHash !== this.doc.fileHash) return; // 원본이 바뀜 — 새 원본으로 다시 열 때 입힌다
    if (fixSig(fixesOf(this.doc.id)) === this.fixSigNow) return;
    this.fixBusy = true;
    try {
      await this.refix(this.fixPlan, this.view.currentLoc(), null);
    } finally {
      this.fixBusy = false;
    }
  }

  // 선택한 글 → {u, start, end, root}
  selectionInfo() {
    if (this.tsel?.on) return this.tsel.info;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const root = startEl?.closest?.(this.isPdf ? '.textLayer' : '.g-body');
    if (!root || !this.host.contains(root)) return null;
    const u = this.unitForRoot(root);
    if (u == null) return null;
    let { start, end } = offsetsFromRange(root, range);
    const text = textOf(root);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;
    return { u, start, end, root, range };
  }

  unitForRoot(root) {
    for (const [u, r] of this.view.roots) if (r === root) return u;
    return null;
  }

  anchorFor(info) {
    const d = describe(info.root, info.start, info.end);
    if (this.isPdf) return { p: info.u, ...d };
    const a = { s: info.u, ...d };
    if (this.doc.format === 'pdf' && this.book.pageStarts) a.p = this.pageLocOf({ s: info.u, o: info.start }).p;
    return a;
  }

  overlapping(u, start, end) {
    const out = [];
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (r && r.u === u && r.start < end && start < r.end) out.push({ ann, r });
    }
    return out;
  }

  // announce: 칠한 뒤 '하이라이트했습니다' 알림(색 단추로 칠할 때)
  async highlightSelection(color, { info, announce = false } = {}) {
    info = info || this.pending || this.selectionInfo();
    if (!info) return null;
    const overlaps = this.overlapping(info.u, info.start, info.end);
    const joined = overlaps.length ? null : this.pageJoinCandidate(info, color);
    let result;
    if (overlaps.length) {
      // 겹치는 하이라이트는 하나로 합친다(메모는 이어 붙여 보존)
      const start = Math.min(info.start, ...overlaps.map((o) => o.r.start));
      const end = Math.max(info.end, ...overlaps.map((o) => o.r.end));
      const keep = overlaps.find((o) => o.ann.note) || overlaps[0];
      const notes = overlaps.map((o) => o.ann.note).filter(Boolean);
      const anchor = this.anchorFor({ ...info, start, end });
      result = await saveAnn({ id: keep.ann.id, color, anchor, note: notes.join('\n\n') || keep.ann.note || '' });
      for (const o of overlaps) if (o.ann.id !== keep.ann.id) await removeAnn(o.ann.id);
    } else if (joined) {
      // 쪽을 넘겨 이어 칠한 것 — 맞닿은 하이라이트를 늘려 하나로 잇는다('따로 두기'로 되돌림)
      const before = { anchor: joined.ann.anchor, color: joined.ann.color };
      const alone = this.anchorFor(info);
      const anchor = this.anchorFor({ ...info, start: Math.min(info.start, joined.r.start), end: Math.max(info.end, joined.r.end) });
      result = await saveAnn({ id: joined.ann.id, color, anchor });
      toast('쪽을 넘어 하나로 이었습니다.', {
        action: '따로 두기',
        duration: 5000,
        onAction: async () => {
          await saveAnn({ id: joined.ann.id, ...before });
          await saveAnn({ id: uid('h'), docId: this.doc.id, kind: 'hl', color, anchor: alone, note: '' });
          this.refreshAnns();
        },
      });
    } else {
      result = await saveAnn({ id: uid('h'), docId: this.doc.id, kind: 'hl', color, anchor: this.anchorFor(info), note: '' });
    }
    if (announce && !joined) toast('하이라이트했습니다.', { duration: 1000 });
    this.clearSelection();
    this.refreshAnns();
    return result;
  }

  // 쪽을 넘겨 이어 칠하기(전자책 보기): 고른 글과 쪽 경계를 사이에 두고 맞닿은(사이엔 빈칸뿐) 같은 색 하이라이트.
  // 쪽을 넘기며 한 번에 고를 수 없어 쪽 끝·다음 쪽 처음을 따로 칠하면 둘로 끊기던 것(2026-10-30 사용자 요청)
  pageJoinCandidate(info, color) {
    const view = this.view;
    if (view?.kind !== 'paged' || !view.pageOfOffset) return null;
    const text = textOf(info.root);
    const blank = (a, b) => a <= b && !text.slice(a, b).trim();
    // 쪽은 보이는 글자로 잰다 — 쪽 경계가 문단 사이에 걸리면 앞 하이라이트 끝의 줄바꿈 글자는 화면에 없어 다음 쪽으로 세어졌다
    const lastInk = (s, e) => { let i = e - 1; while (i > s && !text[i].trim()) i--; return i; };
    const firstInk = (s, e) => { let i = s; while (i < e - 1 && !text[i].trim()) i++; return i; };
    for (const ann of this.annsOfDoc('hl')) {
      if ((ann.color || 0) !== color) continue;
      const r = this.resolve(ann);
      if (!r || r.u !== info.u) continue;
      // 앞 쪽 끝에 칠해 둔 것 → 이번 것, 또는 이번 것 → 뒤 쪽 처음에 칠해 둔 것
      if (blank(r.end, info.start) && view.pageOfOffset(lastInk(r.start, r.end)) !== view.pageOfOffset(firstInk(info.start, info.end))) return { ann, r };
      if (blank(info.end, r.start) && view.pageOfOffset(lastInk(info.start, info.end)) !== view.pageOfOffset(firstInk(r.start, r.end))) return { ann, r };
    }
    return null;
  }

  async noteForSelection() {
    const info = this.pending || this.selectionInfo();
    if (!info) return;
    const overlaps = this.overlapping(info.u, info.start, info.end);
    const quote = textOf(info.root).slice(info.start, info.end);
    this.clearSelection();
    const existing = overlaps.find((o) => o.ann.note);
    const prefill = overlaps.map((o) => o.ann.note).filter(Boolean).join('\n\n');
    const body = await noteEditor({ quote, value: prefill });
    if (body == null) return;
    const ann = await this.highlightSelection(existing?.ann.color ?? overlaps[0]?.ann.color ?? 0, { info });
    if (ann) {
      await saveAnn({ id: ann.id, note: body.trim() });
      this.refreshAnns();
      toast(body.trim() ? '메모를 남겼습니다.' : '메모를 비웠습니다.', { duration: 1400 });
    }
  }

  async deleteAnn(ann) {
    const snapshot = { ...ann };
    await removeAnn(ann.id);
    this.refreshAnns();
    toast(ann.kind === 'bm' ? '책갈피를 지웠습니다.' : '하이라이트를 지웠습니다.', {
      action: '되돌리기',
      onAction: async () => { await restoreAnn(snapshot); this.refreshAnns(); },
    });
  }

  clearSelection() {
    this.pending = null;
    getSelection()?.removeAllRanges();
    this.tsel?.clear();
    this.hideSelTool();
  }

  // ── 선택 도구 ──
  onSelectionChange() {
    // 손가락으로 고를 때는 기본 선택을 쓰지 않는다(입력 칸 등의 선택 소식이 손가락 선택을 지우지 않게)
    if (!this.alive || this.tsel?.on) return;
    const info = this.selectionInfo();
    if (!info) {
      this.pending = null;
      this.hideSelTool();
      return;
    }
    this.pending = info;
    this.showSelTool();
  }

  // 손가락으로 고른 글(touchsel.js) — 고르는 중엔 도구를 감추고, 손을 떼면 띄운다
  onTouchSelect(info, done = false) {
    this.pending = info;
    if (info && done) this.showSelTool(); else this.hideSelTool();
  }

  showSelTool() {
    const info = this.pending;
    if (!info) return;
    const tool = this.selTool;
    tool.textContent = '';
    const overlaps = this.overlapping(info.u, info.start, info.end);
    const dots = h('div', { class: 'seltool-dots' });
    COLORS.forEach((c, i) => dots.append(h('button', {
      class: `hl-dot c${i}`, 'aria-label': `${c.name} 하이라이트`, title: `${c.name} (${i + 1})`,
      onpointerdown: (e) => e.preventDefault(),
      onclick: () => { this.highlightSelection(i, { announce: true }); },
    })));
    // 고른 글이 이 쪽 끝까지 닿았으면 '다음 쪽까지 이어 칠하기'(전자책 보기, 2026-11-24 사용자 요청) — 본문 가운데를 골랐으면 보이지 않는다
    const cont = this.continueTarget(info);
    const contBtn = cont && selBtn('continue', '다음 쪽까지 이어 칠하기', () => this.continueSelection(info));
    tool.append(dots);
    if (contBtn) tool.append(contBtn);
    tool.append(
      selBtn('note', '메모', () => this.noteForSelection()),
      selBtn('copy', '복사', async () => {
        const text = textOf(info.root).slice(info.start, info.end);
        if (await copyText(text)) toast('복사했습니다.', { duration: 1000 });
        this.clearSelection();
      }),
      selBtn('lookup', '찾아보기', (e) => {
        const text = textOf(info.root).slice(info.start, info.end);
        lookupMenu(e.currentTarget, text);
      }));
    // 자주 쓰지 않는 것은 맨 오른쪽 ⋮ 안에(2026-11-24 사용자 "띄어쓰기 고치기는 웬만하면 잘 사용하지 않을 것 같아").
    // 띄어쓰기 고치기는 줄글·전자책 보기만 — 원본 PDF 쪽은 글이 PDF 그대로라 넣을 것이 없어 ⋮ 도 없다
    const more = [];
    if (cont) more.push({ label: '다음 쪽까지 이어 칠하기', icon: 'continue', onClick: () => this.continueSelection(info) });
    if (!this.isPdf) {
      // 메뉴를 누르는 사이 선택이 풀려도 고른 글은 그대로 쓴다
      const at = { u: info.u, start: info.start, end: info.end };
      more.push({ label: '띄어쓰기 고치기', icon: 'spacing', onClick: () => { this.clearSelection(); openSpacing(this, at); } });
    }
    if (overlaps.length) {
      tool.append(selBtn('trash', '지우기', async () => {
        for (const o of overlaps) await removeAnn(o.ann.id);
        const snaps = overlaps.map((o) => ({ ...o.ann }));
        this.clearSelection();
        this.refreshAnns();
        toast('하이라이트를 지웠습니다.', { action: '되돌리기', onAction: async () => { for (const s of snaps) await restoreAnn(s); this.refreshAnns(); } });
      }));
    }
    if (more.length) tool.append(selBtn('more', '더 보기', (e) => menu(e.currentTarget, more, { align: 'right' })));
    tool.hidden = false;
    // 좁은 화면에서 단추가 한 줄에 다 안 들어가면(칠한 곳 위를 골라 '지우기'까지 붙을 때) 이어 칠하기는 ⋮ 안에만 둔다
    if (contBtn && tool.scrollWidth > tool.clientWidth + 1) contBtn.remove();
    this.placeSelTool(info.range);
  }

  placeSelTool(range) {
    const tool = this.selTool;
    // 여러 쪽에 걸친 선택(이어 칠하기)은 지금 보이는 쪽의 글줄로 자리를 잡는다
    const all = [...range.getClientRects()].filter((r) => r.width || r.height);
    const seen = all.filter((r) => r.right > 0 && r.left < innerWidth);
    const rects = seen.length ? seen : all;
    const first = rects[0] || range.getBoundingClientRect();
    const last = rects[rects.length - 1] || first;
    const tw = tool.offsetWidth;
    const th = tool.offsetHeight;
    const touch = this.tsel?.on || matchMedia('(pointer: coarse)').matches;
    let top;
    let left;
    // 휴대폰은 끝 손잡이 아래에(고른 글을 손가락·도구가 가리지 않게)
    if (touch) {
      top = last.bottom + 34;
      if (top + th > innerHeight - 8) top = first.top - th - 54;
      left = (first.left + last.right) / 2 - tw / 2;
    } else {
      top = first.top - th - 10;
      if (top < 56) top = last.bottom + 10;
      left = (first.left + first.right) / 2 - tw / 2;
    }
    tool.style.left = `${clamp(left, 8, innerWidth - tw - 8)}px`;
    tool.style.top = `${clamp(top, 8, innerHeight - th - 8)}px`;
  }

  hideSelTool() {
    this.selTool.hidden = true;
  }

  // 고른 글이 이 쪽 끝까지 닿았나(전자책 보기): 마지막 글자는 이 쪽에, 바로 뒤 글자는 다음 쪽에 있어야 한다.
  // 닿았으면 다음 쪽으로 넘겨 늘릴 끝 위치 — 끊긴 문장이 끝나는 곳(그 쪽을 넘지 않게). 장(구획)의 끝이면 잇지 않는다(하이라이트는 구획 안에서만)
  continueTarget(info) {
    const view = this.view;
    if (!info || this.isPdf || view?.kind !== 'paged' || info.u !== view.s || !view.pageOfOffset) return null;
    const text = textOf(info.root);
    let last = info.end - 1;
    while (last > info.start && !text[last].trim()) last--;
    let next = info.end;
    while (next < text.length && !text[next].trim()) next++;
    if (next >= text.length) return null;
    const w = view.wins?.[view.wi];
    if (w && next >= w.to) return null;
    const page = view.pageOfOffset(next);
    if (view.pageOfOffset(last) !== view.page || page <= view.page) return null;
    let end = Math.max(next + 1, sentenceBounds(text, next).end);
    while (end > next + 1 && !text[end - 1].trim()) end--;
    if (view.pageOfOffset(end - 1) > page) {
      // 문장이 다음 쪽도 넘으면 그 쪽의 마지막 글자까지(쪽 번호는 글 순서대로 커진다 — 둘로 나눠 찾는다)
      let lo = next, hi = end - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (view.pageOfOffset(mid) <= page) lo = mid; else hi = mid - 1;
      }
      end = lo + 1;
    }
    return { page, end };
  }

  // 다음 쪽으로 넘기며 고른 범위를 늘린다 — 끝 손잡이로 고친 뒤 색을 누르면 두 쪽에 걸친 하이라이트 하나로 칠해진다
  continueSelection(info) {
    const t = this.continueTarget(info);
    if (!t) return;
    const { root, u, start } = info;
    this.hideSelTool();
    this.view.setPage(t.page, { instant: true });
    if (this.tsel?.on) {
      this.tsel.sel = { root, u, a: start, b: t.end };
      this.tsel.paint();
      this.onTouchSelect(this.tsel.info, true);
    } else {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(rangeFromOffsets(root, start, t.end));
      this.onSelectionChange();
    }
  }

  // ── 누르기: 링크·메모 표시·하이라이트·쪽 넘기기 ──
  onContentClick(e) {
    // 손가락 선택: 고르기를 마치며 손을 뗄 때 오는 누르기는 먹고, 고른 글이 있으면 누르기는 풀기만 한다
    if (this.tsel?.eatClick()) { e.preventDefault(); return; }
    if (this.tsel?.sel) { e.preventDefault(); this.clearSelection(); return; }
    const mark = e.target.closest('.g-note-mark');
    if (mark) {
      e.preventDefault();
      const ann = state.anns.get(mark.dataset.ann);
      if (ann) this.openAnnPopover(ann, mark);
      return;
    }
    const a = e.target.closest('a[href]');
    if (a && this.host.contains(a)) {
      e.preventDefault();
      this.handleLink(a);
      return;
    }
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const hit = this.annAtPoint(e.clientX, e.clientY);
    if (hit) {
      this.openAnnPopover(hit, null, { x: e.clientX, y: e.clientY });
      return;
    }
    if (this.figures && !this.isPdf && this.openFigureAt(e)) return;
    if (this.view?.onTap?.(e)) return;
    if (this.view?.kind === 'paged') this.toggleChrome();
  }

  // 누른 곳의 하이라이트 — 칠한 글줄 상자 안(조금 넉넉히)을 눌렀으면 그것(겹치면 짧은 것).
  // 예전엔 누른 점의 글자 사이 위치를 찾아 그 다음 한 글자 상자와만 맞대어, 손가락이 글자 오른쪽 끝·글자 사이에 닿으면
  // 하이라이트를 눌러도 못 알아보고 메뉴 접기·쪽 넘기기로 빠졌다(줄을 3px마다 눌러 16% 빗나감, 2026-10-30)
  annAtPoint(x, y) {
    let best = null;
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (!r || !this.view?.roots?.has(r.u)) continue;
      const range = this.view.rangeAt(r.u, r.start, r.end);
      if (!range) continue;
      const hit = [...range.getClientRects()].some((rc) => rc.width > 0 && x >= rc.left - 4 && x <= rc.right + 4 && y >= rc.top - 5 && y <= rc.bottom + 5);
      if (hit && (!best || (r.end - r.start) < (best.r.end - best.r.start))) best = { ann, r };
    }
    return best?.ann || null;
  }

  openAnnPopover(ann, anchorEl, point) {
    closePopovers();
    const anchor = anchorEl || h('span', { style: `position:fixed;left:${point.x}px;top:${point.y}px;width:1px;height:1px` });
    if (!anchorEl) { document.body.append(anchor); setTimeout(() => anchor.remove(), 50); }
    const box = h('div', { class: 'annpop' });
    const dots = h('div', { class: 'seltool-dots' });
    COLORS.forEach((c, i) => dots.append(h('button', {
      class: `hl-dot c${i}${(ann.color || 0) === i ? ' on' : ''}`, 'aria-label': `${c.name}으로 바꾸기`,
      onclick: async () => { await saveAnn({ id: ann.id, color: i }); this.refreshAnns(); closePopovers(); },
    })));
    box.append(dots);
    if (ann.note) box.append(h('div', { class: 'annpop-note' }, ann.note));
    const related = this.relatedNotes(ann);
    if (related.length) {
      const list = h('div', { class: 'annpop-rel' }, h('div', { class: 'annpop-rel-t' }, '같은 태그의 생각'));
      for (const o of related) {
        const d = state.docs.get(o.docId);
        list.append(h('button', {
          class: 'annpop-rel-i',
          onclick: () => {
            closePopovers();
            if (o.docId === this.doc.id) this.jumpToAnn(o.id);
            else import('../main.js').then((m) => m.openDoc(o.docId, { ann: o.id }));
          },
        }, h('span', null, (o.note || '').replace(/\s+/g, ' ').slice(0, 60)), h('small', null, `${d?.title || ''} · “${(o.anchor?.quote || '').slice(0, 24)}”`)));
      }
      box.append(list);
    }
    const row = h('div', { class: 'annpop-row' },
      selBtn('note', ann.note ? '메모 수정' : '메모', async () => {
        closePopovers();
        const body = await noteEditor({ quote: ann.anchor?.quote || '', value: ann.note || '' });
        if (body == null) return;
        await saveAnn({ id: ann.id, note: body.trim() });
        this.refreshAnns();
      }),
      selBtn('quote', '인용 복사', async () => {
        closePopovers();
        if (await copyText(citeText(this.doc, ann, this.locLabel(ann)))) toast('출처와 함께 복사했습니다.', { duration: 1200 });
      }),
      selBtn('lookup', '찾아보기', (e) => lookupMenu(e.currentTarget, ann.anchor?.quote || '')),
      selBtn('sparkle', '카드', async () => { closePopovers(); await shareQuoteCard(this.doc, ann, this.locLabel(ann)); }),
      selBtn('trash', '삭제', () => { closePopovers(); this.deleteAnn(ann); }));
    box.append(row);
    popover(anchor, box, { className: 'annpop-wrap' });
  }

  relatedNotes(ann) {
    const tags = tagsOf(ann.note);
    if (!tags.length) return [];
    const out = [];
    for (const o of state.anns.values()) {
      if (o.deleted || o.id === ann.id || o.kind !== 'hl' || !o.note) continue;
      if (state.docs.get(o.docId)?.deleted) continue;
      if (tagsOf(o.note).some((t) => tags.includes(t))) out.push(o);
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 4);
  }

  locLabel(ann) {
    const a = ann.anchor || {};
    if (this.doc.format === 'pdf') return a.p != null ? `${a.p + 1}쪽` : '';
    if (a.s == null || !this.book) return '';
    const g = toGlobal(this.book, a.s, a.start || 0);
    const ch = this.chapters?.[chapterAt(this.chapters, g)];
    const pct = Math.round((g / Math.max(1, this.book.chars)) * 100);
    return ch && this.chapters.length > 1 ? `${ch.title} · ${pct}%` : `${pct}%`;
  }

  // ── 링크·각주 ──
  async handleLink(a) {
    const href = a.getAttribute('href') || '';
    if (a.dataset.ext || /^(https?:|mailto:)/i.test(href)) {
      const ok = await confirmDialog({ title: '바깥 링크 열기', message: `<div class="linkline">${esc(href)}</div>`, ok: '열기' });
      if (ok) window.open(href, '_blank', 'noopener');
      return;
    }
    const m = /^#g:(\d+):(.*)$/.exec(href);
    if (!m || this.isPdf) return;
    const s = Number(m[1]);
    const frag = decodeURIComponent(m[2] || '');
    const target = this.findTarget(s, frag);
    if (!target) { toast('링크가 가리키는 곳을 찾지 못했습니다.'); return; }
    if (this.isNoteLink(a, target)) {
      this.showFootnote(a, target);
      return;
    }
    await this.jumpWithBack(target.loc);
  }

  findTarget(s, frag) {
    if (!this.book.sections[s]) return null;
    const live = this.view.roots.get(s);
    const root = live || rootFrom(this.book.sections[s].html);
    let el = null;
    if (frag) {
      try { el = root.querySelector(`[id="${CSS.escape(frag)}"]`) || root.querySelector(`a[name="${CSS.escape(frag)}"]`); } catch { el = null; }
      if (!el) return null;
    }
    const o = el ? offsetOfBoundary(root, el, 0) : 0;
    return { loc: { s, o }, el, root };
  }

  isNoteLink(a, target) {
    if (!target.el) return false;
    const t = (a.textContent || '').trim();
    const type = `${a.dataset.epubType || ''} ${target.el.dataset?.epubType || ''}`;
    if (/noteref|footnote|endnote|rearnote/.test(type)) return true;
    if (a.classList.contains('g-noteref')) return true;
    const inSup = !!a.closest('sup') || a.querySelector('sup');
    const shortLabel = t.length > 0 && t.length <= 4 && /^[\[(]?[\d*†‡§¶a-zA-Zㄱ-ㅎ]{1,3}[\])]?$/.test(t);
    const noteish = /(^|[-_])(fn|note|ftn|endnote|footnote|en)\d*/i.test(target.el.id || '') || target.el.closest?.('aside, .g-footnotes, ol.footnotes, .footnotes, .notes');
    return (inSup || shortLabel) && (noteish || inSup);
  }

  showFootnote(a, target) {
    let el = target.el;
    // 빈 표지(a id)면 다음/부모 블록을 본다
    if (!(el.textContent || '').trim()) el = el.closest('li, p, aside, div') || el.nextElementSibling || el;
    if (el.tagName === 'A' && el.parentElement) el = el.parentElement.closest('li, p, aside, div, dd') || el.parentElement;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-gui], .g-note-back').forEach((x) => x.remove());
    for (const n of clone.querySelectorAll('[id]')) n.removeAttribute('id');
    for (const link of clone.querySelectorAll('a[href]')) link.removeAttribute('href');
    for (const img of clone.querySelectorAll('img')) img.remove();
    const content = h('div', { class: 'fn-body g-text' });
    content.append(...clone.childNodes.length ? [clone] : []);
    const box = h('div', { class: 'fnpop' },
      h('div', { class: 'fnpop-head' }, '주석'),
      content,
      h('div', { class: 'fnpop-foot' },
        h('button', { class: 'gbtn small ghost', onclick: () => { closePopovers(); this.jumpWithBack(target.loc); } }, '주석 자리로 가기')));
    popover(a, box, { className: 'fnpop-wrap' });
  }

  async jumpWithBack(loc) {
    const here = this.view.currentLoc();
    if (here) {
      this.backStack.push({ loc: here, mode: this.mode, view: this.view.kind, chapter: this.chapterIndex });
      this.backChip.hidden = false;
    }
    await this.goToLoc(loc, { flash: true, divided: true });
  }

  async goBackLink() {
    const prev = this.backStack.pop();
    this.backChip.hidden = !this.backStack.length;
    if (!prev) return;
    if (prev.view === 'flow' && this.view.kind === 'flow' && prev.mode !== this.mode) {
      this.mode = prev.mode;
      await this.renderFlowMode(prev.loc);
    } else {
      await this.goToLoc(prev.loc);
    }
  }

  // 위치로 가기. divided:true면 안드로이드처럼 장 단위 보기로 그 장을 연다
  // rest: 받은 읽던 자리로 옮기는 것 — 옮긴 화면이 멈춘 곳을 그 기록의 자리로 보고 다시 쓰지 않는다
  async goToLoc(loc, { flash = false, divided = false, align = 'top', range = null, rest = false } = {}) {
    if (!loc) return;
    // reveal: 옮겨 간 곳이 펼친 메뉴 밑에 가리지 않게(읽던 자리를 되살릴 때는 쓰지 않는다)
    if (this.isPdf) {
      await this.view.goTo(loc, { align, reveal: true });
      if (flash && loc.start != null) {
        await sleep(60);
        this.flash(this.view.rangeAt(loc.p, loc.start, loc.end ?? loc.start + 1));
      }
      const l = this.view.currentLoc();
      if (rest) this.restLoc = l;
      this.onLocate(l, {});
      return;
    }
    if (this.view.kind === 'flow') {
      const g = toGlobal(this.book, loc.s, loc.o);
      if (divided && this.mode === 'full' && this.chapters.length > 1) {
        this.mode = 'divided';
        this.writePos({ mode: 'divided' });
      }
      if (this.mode !== 'full') {
        const ci = chapterAt(this.chapters, g);
        if (ci !== this.chapterIndex || !this.view.contains(loc)) {
          this.chapterIndex = ci;
          const ch = this.chapters[ci];
          this.view.render({ from: ch.start, to: ch.end });
          this.updateChapBar();
        }
      }
    }
    await this.view.goTo(loc, { align, reveal: true });
    if (flash) {
      await sleep(50);
      const r = range || (loc.end != null ? this.view.rangeAt(loc.s, loc.o, loc.end) : null);
      if (r) this.flash(r);
    }
    const l = this.view.currentLoc();
    if (rest) this.restLoc = l;
    if (l) this.onLocate(l, {});
  }

  async jumpToAnn(annId) {
    const ann = state.anns.get(annId);
    if (!ann || ann.deleted) return;
    if (ann.kind === 'bm') {
      const a = ann.anchor || {};
      await this.goToLoc(this.isPdf ? this.normalLoc({ p: a.p, y: a.y || 0, s: a.s, o: a.o }) : this.normalLoc({ s: a.s, o: a.o || 0, p: a.p, y: a.y }));
      return;
    }
    const r = this.resolve(ann);
    if (!r) { toast('이 하이라이트의 위치를 본문에서 찾지 못했습니다.'); return; }
    if (this.isPdf) await this.goToLoc({ p: r.u, start: r.start, end: r.end }, { flash: true, align: 'center' });
    else await this.goToLoc({ s: r.u, o: r.start, end: r.end }, { flash: true, divided: true, align: 'center' });
  }

  // ── 책갈피 ──
  bookmarks() {
    return this.annsOfDoc('bm').sort((x, y) => this.locOrder(x.anchor) - this.locOrder(y.anchor));
  }

  locOrder(a) {
    if (!a) return 0;
    if (this.isPdf) return (a.p || 0) + (a.y || 0);
    if (this.doc.format === 'pdf' && !Number.isInteger(a.s)) { const l = this.normalLoc(a); return toGlobal(this.book, l.s, l.o); }
    return this.book ? toGlobal(this.book, a.s || 0, a.o || 0) : 0;
  }

  bookmarkHere() {
    const loc = this.view?.currentLoc();
    if (!loc) return null;
    const here = this.locOrder(loc);
    const span = this.isPdf ? 0.5 : Math.max(300, (this.book?.chars || 0) * 0.004);
    return this.bookmarks().find((b) => Math.abs(this.locOrder(b.anchor) - here) <= span) || null;
  }

  updateBookmarkBtn() {
    const on = !!this.bookmarkHere();
    this.bmBtn.classList.toggle('on', on);
    this.bmBtn.setAttribute('aria-label', on ? '책갈피 삭제' : '책갈피 추가');
  }

  async toggleBookmark() {
    const existing = this.bookmarkHere();
    if (existing) {
      await this.deleteAnn(existing);
      this.updateBookmarkBtn();
      return;
    }
    const loc = this.view.currentLoc();
    if (!loc) return;
    let snippet = '';
    if (!this.isPdf) {
      const t = this.texts[loc.s] || '';
      snippet = t.slice(loc.o, loc.o + 80).replace(/\s+/g, ' ').trim();
    } else {
      const t = this.unitText(loc.p) || '';
      snippet = t.slice(0, 80).replace(/\s+/g, ' ').trim();
    }
    const anchor = this.isPdf ? { p: loc.p, y: loc.y || 0 } : { s: loc.s, o: loc.o };
    if (this.doc.format === 'pdf' && !this.isPdf && this.book.pageStarts) Object.assign(anchor, this.pageLocOf(loc));
    await saveAnn({ id: uid('b'), docId: this.doc.id, kind: 'bm', anchor, snippet, progress: this.progress || 0 });
    this.updateBookmarkBtn();
    if (this.side && !this.side.hidden) panels.renderSide(this);
    toast('현재 위치에 책갈피를 추가했습니다.', { duration: 1200 });
  }

  // ── 찾기 ──
  openFind(initial = '') {
    this.find = this.find || { q: '', hits: [], i: -1, origin: this.view?.currentLoc(), originMode: this.mode, originChapter: this.chapterIndex };
    this.setCollapsed(false);
    this.root.classList.add('finding');
    const input = h('input', { class: 'gfield rd-find-input', type: 'search', placeholder: this.isPdf ? 'PDF에서 찾기' : '찾을 낱말', enterkeyhint: 'search' });
    input.value = initial || this.find.q;
    const count = h('span', { class: 'rd-find-count' }, '0 / 0');
    this.findBar.replaceChildren(
      h('span', { class: 'rd-find-ico', html: ico('search') }),
      input, count,
      h('button', { class: 'gicon', 'aria-label': '이전 결과', html: ico('up'), onclick: () => this.stepFind(-1) }),
      h('button', { class: 'gicon', 'aria-label': '다음 결과', html: ico('down'), onclick: () => this.stepFind(1) }),
      h('button', { class: 'gicon', 'aria-label': '결과 목록', html: ico('list'), onclick: () => panels.showFindList(this) }),
      h('button', { class: 'gicon', 'aria-label': '읽던 위치로 돌아가기', title: '읽던 위치로', html: ico('undo'), onclick: () => this.closeFind({ restore: true }) }),
      h('button', { class: 'gicon', 'aria-label': '찾기 닫기', html: ico('close'), onclick: () => this.closeFind() }));
    this.findBar.hidden = false;
    this.findCount = count;
    const run = debounce(() => this.runFind(input.value), 260);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run.flush?.(); if (this.find?.q !== input.value.trim()) this.runFind(input.value); else this.stepFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    setTimeout(() => input.focus(), 30);
    if (input.value.trim()) this.runFind(input.value);
  }

  async runFind(q) {
    q = q.trim();
    if (!this.find) return;
    this.find.q = q;
    this.find.hits = [];
    this.find.i = -1;
    this.painter.removeWhere((k) => k.startsWith('find:'));
    if (!q) { this.findCount.textContent = '0 / 0'; return; }
    if (this.isPdf && this.texts.length < this.pdf.numPages) {
      this.findCount.textContent = '쪽 글 읽는 중';
      const texts = await this.pdfTextsPromise;
      if (texts) this.texts = texts;
      if (!this.find || this.find.q !== q) return;
    }
    const needle = q.toLowerCase();
    const hits = [];
    const texts = this.isPdf ? this.texts : this.texts;
    for (let u = 0; u < texts.length && hits.length < 3000; u++) {
      const t = (texts[u] || '').toLowerCase();
      let i = t.indexOf(needle);
      while (i >= 0 && hits.length < 3000) {
        hits.push({ u, start: i, end: i + needle.length });
        i = t.indexOf(needle, i + Math.max(1, needle.length));
      }
    }
    this.find.hits = hits;
    if (!hits.length) { this.findCount.textContent = '0 / 0'; return; }
    // 지금 위치 다음 결과부터
    const here = this.find.origin ? this.locOrderOf(this.find.origin) : 0;
    let first = hits.findIndex((h2) => this.hitOrder(h2) >= here);
    if (first < 0) first = 0;
    this.find.i = first;
    this.paintFind([...this.view.roots.keys()]);
    await this.showHit();
  }

  locOrderOf(loc) {
    if (this.isPdf) return (loc.p || 0) * 1e7;
    return toGlobal(this.book, loc.s, loc.o);
  }

  hitOrder(hit) {
    return this.isPdf ? hit.u * 1e7 + hit.start : toGlobal(this.book, hit.u, hit.start);
  }

  paintFind(units) {
    if (!this.find?.hits.length) return;
    const set = new Set(units);
    let n = 0;
    for (const hit of this.find.hits) {
      if (!set.has(hit.u) || n > 1500) continue;
      const range = this.view.rangeAt(hit.u, hit.start, hit.end);
      if (range) { this.painter.add(`find:${hit.u}:${hit.start}`, 'g-find', range); n++; }
    }
    this.paintCurrentHit();
  }

  paintCurrentHit() {
    this.painter.remove('findcur');
    const hit = this.find?.hits[this.find.i];
    if (!hit) return;
    const range = this.view.rangeAt(hit.u, hit.start, hit.end);
    if (range) this.painter.add('findcur', 'g-find-cur', range);
  }

  async showHit() {
    const hit = this.find?.hits[this.find.i];
    if (!hit) return;
    this.findCount.textContent = `${this.find.i + 1} / ${this.find.hits.length}${this.find.hits.length >= 3000 ? '+' : ''}`;
    if (this.isPdf) await this.goToLoc({ p: hit.u, start: hit.start, end: hit.end }, { align: 'center' });
    else await this.goToLoc({ s: hit.u, o: hit.start }, { align: 'center' });
    this.paintFind([...this.view.roots.keys()]);
  }

  stepFind(d) {
    if (!this.find?.hits.length) return;
    this.find.i = (this.find.i + d + this.find.hits.length) % this.find.hits.length;
    this.showHit();
  }

  async goToHit(i) {
    if (!this.find) return;
    this.find.i = i;
    await this.showHit();
  }

  async closeFind({ restore = false } = {}) {
    const f = this.find;
    this.find = null;
    this.findBar.hidden = true;
    this.root.classList.remove('finding');
    this.painter.removeWhere((k) => k.startsWith('find:') || k === 'findcur');
    if (restore && f?.origin) {
      if (!this.isPdf && this.view.kind === 'flow' && f.originMode !== this.mode) {
        this.mode = f.originMode;
        await this.renderFlowMode(f.origin);
      } else {
        await this.goToLoc(f.origin);
      }
    }
  }

  // ── 목록 창들 ──
  showToc() { panels.showToc(this); }
  showAnnotations() { panels.showAnnotations(this); }
  showBookmarks() { panels.showBookmarks(this); }
  showSettings() { panels.showSettings(this); }
  showInfo() { panels.showInfo(this); }

  togglePanel(force) {
    const open = force ?? this.side.hidden;
    this.side.hidden = !open;
    this.root.classList.toggle('with-side', open);
    this.panelBtn.classList.toggle('on', open);
    if (open) panels.renderSide(this);
    if (!!state.app.readerPanel !== open) setApp({ readerPanel: open });
    setTimeout(() => this.view?.relayout?.(), 50);
  }

  showMenu(anchor) {
    const items = [];
    if (!this.isPdf) {
      items.push({ label: '전자책 보기', checked: this.view.kind === 'paged', onClick: () => this.setView('paged') });
      items.push({ label: '줄글 보기', checked: this.view.kind === 'flow', onClick: () => this.setView('flow') });
      items.push({ divider: true });
      items.push({ label: 'Full · 전체 문서', checked: this.view.kind === 'flow' && this.mode === 'full', onClick: () => this.setMode('full') });
      items.push({ label: 'Random · 무작위', checked: this.view.kind === 'flow' && this.mode === 'random', onClick: () => (this.mode === 'random' ? this.shuffle() : this.setMode('random')) });
      items.push({ label: 'Divided · 챕터별', checked: this.view.kind === 'flow' && this.mode === 'divided', onClick: () => this.setMode('divided') });
    } else {
      items.push({ label: 'Full · 전체 PDF', checked: this.mode === 'full', onClick: () => this.setMode('full') });
      items.push({ label: this.mode === 'random' ? 'Random · 다른 글' : 'Random · 무작위', checked: this.mode === 'random', onClick: () => this.setMode('random') });
      items.push({ divider: true });
      items.push({ label: '확대', icon: 'zoomIn', onClick: () => this.view.setZoom(this.view.zoom * 1.25) });
      items.push({ label: '축소', icon: 'zoomOut', onClick: () => this.view.setZoom(this.view.zoom / 1.25) });
      items.push({ label: '폭에 맞추기', icon: 'fitWidth', onClick: () => this.view.setZoom(1) });
    }
    if (this.doc.format === 'pdf' && this.bookRec?.book?.reflow !== false) {
      items.push({ divider: true });
      items.push({ label: this.isPdf ? '전자책처럼 보기' : '원본 PDF 쪽으로 보기', icon: this.isPdf ? 'pages' : 'file', onClick: () => this.switchPdfView(!this.isPdf) });
    }
    const ocrItem = this.ocrMenuItem();
    if (ocrItem) items.push({ divider: true }, ocrItem);
    items.push({ divider: true });
    items.push({ label: '하이라이트 · 메모', icon: 'highlight', onClick: () => this.showAnnotations() });
    items.push({ label: '책갈피 목록', icon: 'bookmarks', onClick: () => this.showBookmarks() });
    const fixCount = this.isPdf ? 0 : fixesOf(this.doc.id).length;
    if (fixCount) items.push({ label: `띄어쓰기 고친 곳 (${fixCount})`, icon: 'spacing', onClick: () => openFixList(this) });
    items.push({ label: '읽기 설정', icon: 'type', onClick: () => this.showSettings() });
    if ('speechSynthesis' in window && !this.isPdf) items.push({ label: this.tts ? '읽어주기 멈춤' : '읽어주기', icon: 'speaker', onClick: () => panels.toggleSpeech(this) });
    items.push({ label: '문서 정보', icon: 'info', onClick: () => this.showInfo() });
    items.push({ label: '원본 파일 바꾸기', icon: 'replace', onClick: () => this.replaceFile() });
    menu(anchor, items);
  }

  // 원본 파일 바꾸기·띄어쓰기 고침을 원본에 반영(replace.js) — 읽던 자리를 먼저 써 두고, 바꾸는 동안은 옛 원본 기준 자리를 쓰지 않는다.
  // 바꾼 뒤 새 원본으로 다시 연다
  replaceFile() { return this.swapOriginal(pickReplacement, '원본 바꾸는 중'); }
  bakeFixes() { return this.swapOriginal(bakeFixes, '원본에 반영하는 중'); }
  async swapOriginal(run, label) {
    const id = this.doc.id;
    await run(this.doc, {
      before: async () => {
        this.flush();
        await flushPositions();
        this.frozen = true;
        this.setLoading(label);
      },
      onStatus: (m) => this.setLoading(m),
      after: async (res) => { if (res?.replaced && this.alive) await openReader(id); },
    });
    if (!this.alive) return;
    this.frozen = false;
    this.setLoading(null);
  }

  applySettings(patch) {
    // 글자 크기 등이 바뀌기 전에 지금 자리를 잡아 둔다(바뀐 뒤 재면 다른 자리가 된다)
    if (this.view && !this.isPdf && !this.pendingLoc) this.pendingLoc = this.view.kind === 'paged' ? (this.view.anchorLoc || this.view.currentLoc()) : this.view.currentLoc();
    setDocReader(this.doc.id, patch);
    this.applyTheme();
    if (this.view) {
      if ('bookStyle' in patch && this.view.kind === 'paged') {
        const loc = this.pendingLoc || this.view.currentLoc();
        this.pendingLoc = null;
        this.view.showSection(loc.s, { o: loc.o });
      } else {
        clearTimeout(this.relayoutTimer);
        this.relayoutTimer = setTimeout(() => {
          const loc = this.pendingLoc;
          this.pendingLoc = null;
          if (!this.isPdf) this.figures?.refit(this.host);
          this.view?.relayout?.(loc);
        }, 120);
      }
    }
  }

  // PDF 확대는 그 문서에만(예전에는 모든 문서의 기본값에 들어가 다른 PDF까지 크게 열렸다)
  setPdfZoom(z) {
    setDocReader(this.doc.id, { pdfZoom: z });
  }

  // ── 타이머·키보드 ──
  startTimers() {
    this.ticker = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - this.lastActivity > 90000) return;
      addReadingTime(this.doc.id, 5);
    }, 5000);
  }

  bindGlobal() {
    const onSel = debounce(() => this.onSelectionChange(), 160);
    const onKey = (e) => this.onKey(e);
    const onAct = throttle(() => { this.lastActivity = Date.now(); }, 2000);
    const onVis = () => { if (document.visibilityState === 'hidden') this.flush(); };
    const onResize = throttle(() => {
      if (this.pending) this.placeSelTool(this.pending.range);
      this.tsel?.place();
      if (!this.isPdf) this.figures?.refit(this.host);
      // 전자책 보기는 크기가 바뀐 뒤 조금 있다 다시 짠다 — 그 뒤 자리로 한 번 더
      clearTimeout(this.replaceTimer);
      this.replaceTimer = setTimeout(() => {
        if (this.pending && !this.selTool.hidden) this.placeSelTool(this.pending.range);
        this.tsel?.place();
      }, 400);
    }, 200);
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onAct, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    this.host.addEventListener('scroll', () => {
      if (!this.selTool.hidden && this.pending) this.placeSelTool(this.pending.range);
      if (this.tsel?.sel) this.tsel.place();
    }, { capture: true, passive: true });
    this.offs.push(
      () => document.removeEventListener('selectionchange', onSel),
      () => document.removeEventListener('keydown', onKey),
      () => document.removeEventListener('pointerdown', onAct),
      () => document.removeEventListener('visibilitychange', onVis),
      () => window.removeEventListener('resize', onResize),
      on('anns', (d) => {
        if (d && d.docId !== this.doc.id) return;
        this.refreshAnns();
        this.syncFixes();
      }),
      on('remote-applied', (d) => {
        // 다른 기기에서 이 문서를 지웠으면 닫는다
        const now = state.docs.get(this.doc.id);
        if (now?.deleted) { toast('다른 기기에서 이 문서를 서재에서 지웠습니다.'); history.back(); return; }
        // 다른 기기에서 원본 파일을 바꿨다 — 지금 화면은 옛 원본이다
        if (now && now.fileHash !== this.doc.fileHash) {
          if (!this.replacedNotice) {
            this.replacedNotice = true;
            toast('다른 기기에서 이 문서의 원본 파일을 바꿨습니다.', { action: '새 원본으로 열기', duration: 10000, onAction: () => openReader(this.doc.id) });
          }
          this.refreshAnns();
          return;
        }
        this.refreshAnns();
        this.syncFixes();
        if (d?.pos?.includes(this.doc.id)) this.followRemote();
      }),
    );
  }

  onKey(e) {
    if (!this.alive || document.querySelector('.gov-wrap, .gmenu-wrap')) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return; }
    if (typing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.lastActivity = Date.now();
    const k = e.key;
    if (this.pending && /^[1-4]$/.test(k)) { e.preventDefault(); this.highlightSelection(Number(k) - 1); return; }
    if (this.pending && (k === 'h' || k === 'H')) { e.preventDefault(); this.highlightSelection(0); return; }
    if (this.pending && (k === 'm' || k === 'M')) { e.preventDefault(); this.noteForSelection(); return; }
    if (k === 'Escape') {
      if (this.pending) { this.clearSelection(); return; }
      if (this.find) { this.closeFind(); return; }
      if (document.querySelector('.gpop')) { closePopovers(); return; }
      history.back();
      return;
    }
    if (k === '/') { e.preventDefault(); this.openFind(); return; }
    if (k === 't' || k === 'T') { this.showToc(); return; }
    if (k === 'b' || k === 'B') { this.toggleBookmark(); return; }
    if (k === 'n' || k === 'N') { this.showAnnotations(); return; }
    if (k === 'p' || k === 'P') { if (!this.isPdf) this.setView(this.view.kind === 'paged' ? 'flow' : 'paged'); return; }
    if (k === 'r' || k === 'R') { this.shuffle(); return; }
    const paged = this.view?.kind === 'paged';
    if (k === 'ArrowRight' && paged) { e.preventDefault(); this.view.next(); return; }
    if (k === 'ArrowLeft' && paged) { e.preventDefault(); this.view.prev(); return; }
    if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); this.view.scrollByPage(1); return; }
    if (k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); this.view.scrollByPage(-1); return; }
    if (!paged && (k === 'ArrowDown' || k === 'ArrowUp') && document.activeElement === document.body) {
      this.view.el?.focus({ preventScroll: true });
    }
  }

  flush() {
    const loc = this.view?.currentLoc();
    if (loc) this.savePosition(loc, { force: true });
    this.commitHeld();
    flushPositions().catch(() => {});
    flushStats();
    emit('flush-request');
  }

  onReachEnd() {
    toast('마지막 쪽입니다.', { duration: 1200 });
  }

  async close({ silent = false } = {}) {
    if (!this.alive) return;
    this.flush();
    this.alive = false;
    this.ocrStop?.();
    clearInterval(this.ticker);
    for (const off of this.offs) off();
    if (this.tts) panels.stopSpeech(this);
    closePopovers();
    this.hideSelTool();
    clearTimeout(this.replaceTimer);
    this.view?.destroy();
    this.tsel?.destroy();
    this.painter.destroy();
    this.res.revoke();
    this.figures?.destroy();
    if (this.pdf) closePdf(this.pdf);
    const host = document.getElementById('app-reader');
    host.replaceChildren();
    host.hidden = true;
    document.body.classList.remove('reading');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#F7F4EC');
    if (current === this) current = null;
    if (!silent) emit('reader-closed', { docId: this.doc.id });
  }
}

// 선택 도구·하이라이트 창의 단추 — 아이콘만(2026-11-24 사용자 "한글은 지우고 아이콘만, 번잡해 보여"). 이름은 aria-label·마우스를 올리면 뜨는 title 로
function selBtn(icon, label, onClick) {
  return h('button', {
    class: 'seltool-btn', 'aria-label': label, title: label,
    onpointerdown: (e) => e.preventDefault(),
    onclick: onClick,
    html: ico(icon),
  });
}

export { closeAllOverlays };

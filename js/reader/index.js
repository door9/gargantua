// 읽기 화면 조율: 보기(줄글·전자책·PDF), 위치 저장, 하이라이트·메모·책갈피, 찾기, 링크·각주
import { h, esc, debounce, throttle, sleep, toast, copyText, now, uid, emit, on, fmtMinutes, clamp } from '../util.js';
import { ico } from '../icons.js';
import {
  state, saveAnn, removeAnn, restoreAnn, savePos, liveAnns, setReader, addReadingTime, addReadingProgress,
  readingSpeed, flushPositions, getFile, saveDoc,
} from '../store.js';
import { loadBook, loadResources, requireFile, loadPdfTexts } from '../docs.js';
import { kvSet } from '../db.js';
import { openPdf, pdfOutline, closePdf } from '../pdfdoc.js';
import { textOf, offsetsFromRange, describe, resolveAnchor, caretFromPoint, offsetOfBoundary, rangeFromOffsets, textIndex } from '../text.js';
import { rootFrom } from '../parse/common.js';
import { FlowView } from './flow.js';
import { PagedView } from './paged.js';
import { PdfView } from './pdfview.js';
import { Painter, HL_SUPPORTED } from './painter.js';
import { buildChapters, chapterAt, randomChapter, toGlobal, fromGlobal } from './chapters.js';
import { sheet, menu, popover, closePopovers, confirmDialog, closeAllOverlays } from '../ui/overlay.js';
import * as panels from './panels.js';
import { lookupMenu, citeText, noteEditor } from './actions.js';
import { fetchRemoteFile } from '../sync/sync.js';

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

class Reader {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts;
    this.settings = state.reader;
    this.isPdf = doc.format === 'pdf';
    this.resolved = new Map();
    this.unitAnns = new Map();
    this.painter = new Painter();
    this.find = null;
    this.backStack = [];
    this.collapsed = true;
    this.lastActivity = Date.now();
    this.offs = [];
    this.alive = true;
    this.res = { urls: new Map(), revoke() {} };
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
      const pos = state.pos.get(this.doc.id) || {};
      this.pos = pos;
      if (this.isPdf) await this.loadPdf(); else await this.loadText();
      if (!this.alive) return;
      await this.mountView(this.initialView(), { loc: this.initialLoc() });
      savePos(this.doc.id, { openedAt: now(), view: this.view.kind === 'paged' ? 'paged' : (this.isPdf ? 'pdf' : 'flow') });
      saveDoc({ id: this.doc.id, lastOpenedAt: now() }, { silent: true }).catch(() => {});
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

  initialView() {
    if (this.isPdf) return 'pdf';
    if (this.opts.view) return this.opts.view;
    return this.pos.view === 'paged' ? 'paged' : 'flow';
  }

  initialLoc() {
    if (this.opts.loc) return this.opts.loc;
    const p = this.pos;
    if (this.isPdf) return { p: p.p || 0, y: p.y || 0 };
    if (Number.isInteger(p.s)) return { s: Math.min(p.s, this.book.sections.length - 1), o: p.o || 0 };
    if (p.progress) return fromGlobal(this.book, Math.floor(p.progress * this.book.chars));
    return { s: 0, o: 0 };
  }

  async loadText() {
    const rec = await loadBook(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
    this.book = rec.book;
    this.texts = rec.texts;
    this.chapters = buildChapters(this.book, this.texts);
    if (this.doc.format === 'epub' || this.doc.format === 'docx') {
      const blob = await requireFile(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
      this.res = await loadResources(this.doc, blob);
    }
  }

  async loadPdf() {
    const blob = await requireFile(this.doc, { onStatus: (m) => this.setLoading(m), fetchFile: fetchRemoteFile });
    this.setLoading('PDF 여는 중');
    this.pdf = await openPdf(blob);
    this.texts = [];
    this.pdfToc = null;
    this.pdfTextsPromise = loadPdfTexts(this.doc, this.pdf).catch(() => null);
    this.pdfTextsPromise.then((texts) => {
      if (!this.alive || !texts) return;
      this.texts = texts;
      // 글이 늦게 왔으면 그사이 못 찾은 하이라이트를 다시 찾는다
      this.resolved.clear();
      for (const u of this.view?.roots?.keys() || []) this.paintUnit(u);
    });
  }

  // ── 화면 틀 ──
  buildChrome() {
    const d = this.doc;
    this.root = h('div', { class: 'rd collapsed', 'data-format': d.format });
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
  async mountView(kind, { loc } = {}) {
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
      if (this.opts.mode) this.mode = this.opts.mode;
      await this.renderFlowMode(loc, { fresh: true });
    } else if (kind === 'paged') {
      this.mode = 'full';
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
      if (this.mode === 'random' && (fresh || this.chapterIndex == null)) {
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
    await this.mountView(kind, { loc });
    this.setLoading(null);
    savePos(this.doc.id, { view: kind });
    toast(kind === 'paged' ? '전자책 보기' : '줄글 보기', { duration: 1200 });
  }

  async setMode(mode) {
    if (this.isPdf) {
      this.mode = mode;
      savePos(this.doc.id, { mode });
      if (mode === 'random') await this.pdfRandom({});
      this.updateChapBar();
      return;
    }
    if (this.view.kind !== 'flow') await this.setView('flow');
    if (this.mode === mode && mode !== 'random') return;
    const loc = this.view.currentLoc();
    const prevMode = this.mode;
    this.mode = mode;
    savePos(this.doc.id, { mode });
    await this.renderFlowMode(loc, { fresh: mode === 'random' && prevMode !== 'random' });
    if (mode === 'random' && prevMode === 'random') {
      // 무작위 → 다른 장
    }
  }

  async shuffle() {
    if (this.isPdf) return this.pdfRandom({});
    if (this.view.kind !== 'flow' || this.mode !== 'random') {
      this.mode = 'random';
      savePos(this.doc.id, { mode: 'random' });
      if (this.view.kind !== 'flow') { await this.setView('flow'); return; }
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
    for (const img of root.querySelectorAll('img[data-g-src]')) {
      const url = this.res.urls.get(img.getAttribute('data-g-src'));
      if (url) {
        if (onLoad) img.addEventListener('load', onLoad, { once: true });
        img.src = url;
      } else {
        img.classList.add('g-img-missing');
      }
    }
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
    if (dir === 'down' && !this.collapsed && !this.find && this.view.kind !== 'paged') this.setCollapsed(true);
  }

  savePosition(loc, { progress, force = false } = {}) {
    if (!loc) return;
    const patch = this.isPdf ? { p: loc.p, y: loc.y || 0 } : { s: loc.s, o: loc.o };
    patch.progress = progress ?? this.progress ?? 0;
    if (patch.progress >= 0.995 && !this.pos.finishedAt) patch.finishedAt = now();
    patch.mode = this.mode;
    this.pos = savePos(this.doc.id, patch, { immediate: force });
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

  // ── 하이라이트 ──
  unitOf(ann) {
    const a = ann.anchor || {};
    return this.isPdf ? a.p : a.s;
  }

  unitsCleared() {
    this.painter.removeWhere(() => true);
    this.unitAnns.clear();
  }

  unitRemoved(u) {
    const ids = this.unitAnns.get(u);
    if (ids) for (const id of ids) this.painter.remove(id);
    this.unitAnns.delete(u);
    this.painter.removeWhere((k) => k.startsWith(`find:${u}:`));
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
    const a = ann.anchor;
    if (a) {
      const u0 = this.unitOf(ann);
      const t0 = u0 != null ? this.unitText(u0) : null;
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
    this.resolved.set(ann.id, { v: ann.updatedAt, r });
    if (r && a && (a.legacy || a.s !== r.u) && !this.isPdf) {
      // 옛 위치 정보(안드로이드에서 옮겨 온 것 등)를 지금 위치로 고쳐 둔다
      const root = this.view?.roots.get(r.u);
      const text = this.texts[r.u];
      const fixed = { s: r.u, start: r.start, end: r.end, quote: text.slice(r.start, r.end), prefix: text.slice(Math.max(0, r.start - 32), r.start), suffix: text.slice(r.end, r.end + 32) };
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
  }

  flash(range) {
    if (!range) return;
    this.painter.add('flash', 'g-flash', range);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.painter.remove('flash'), 1800);
  }

  // 선택한 글 → {u, start, end, root}
  selectionInfo() {
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
    return this.isPdf ? { p: info.u, ...d } : { s: info.u, ...d };
  }

  overlapping(u, start, end) {
    const out = [];
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (r && r.u === u && r.start < end && start < r.end) out.push({ ann, r });
    }
    return out;
  }

  async highlightSelection(color, { info } = {}) {
    info = info || this.pending || this.selectionInfo();
    if (!info) return null;
    const overlaps = this.overlapping(info.u, info.start, info.end);
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
    } else {
      result = await saveAnn({ id: uid('h'), docId: this.doc.id, kind: 'hl', color, anchor: this.anchorFor(info), note: '' });
    }
    this.clearSelection();
    this.refreshAnns();
    return result;
  }

  async noteForSelection() {
    const info = this.pending || this.selectionInfo();
    if (!info) return;
    const overlaps = this.overlapping(info.u, info.start, info.end);
    const quote = textOf(info.root).slice(info.start, info.end);
    this.clearSelection();
    const existing = overlaps.find((o) => o.ann.note);
    const body = await noteEditor({ quote, value: existing?.ann.note || '' });
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
    this.hideSelTool();
  }

  // ── 선택 도구 ──
  onSelectionChange() {
    if (!this.alive) return;
    const info = this.selectionInfo();
    if (!info) {
      this.pending = null;
      this.hideSelTool();
      return;
    }
    this.pending = info;
    this.showSelTool();
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
      onclick: () => { this.highlightSelection(i).then(() => toast('하이라이트했습니다.', { duration: 1000 })); },
    })));
    tool.append(dots,
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
    if (overlaps.length) {
      tool.append(selBtn('trash', '지우기', async () => {
        for (const o of overlaps) await removeAnn(o.ann.id);
        const snaps = overlaps.map((o) => ({ ...o.ann }));
        this.clearSelection();
        this.refreshAnns();
        toast('하이라이트를 지웠습니다.', { action: '되돌리기', onAction: async () => { for (const s of snaps) await restoreAnn(s); this.refreshAnns(); } });
      }));
    }
    tool.hidden = false;
    this.placeSelTool(info.range);
  }

  placeSelTool(range) {
    const tool = this.selTool;
    const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
    const first = rects[0] || range.getBoundingClientRect();
    const last = rects[rects.length - 1] || first;
    const tw = tool.offsetWidth;
    const th = tool.offsetHeight;
    const touch = matchMedia('(pointer: coarse)').matches;
    let top;
    let left;
    // 휴대폰은 기본 메뉴가 위에 뜨므로 아래에
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

  // ── 누르기: 링크·메모 표시·하이라이트·쪽 넘기기 ──
  onContentClick(e) {
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
    if (this.view?.onTap?.(e)) return;
    if (this.view?.kind === 'paged') this.toggleChrome();
  }

  annAtPoint(x, y) {
    const c = caretFromPoint(x, y);
    if (!c) return null;
    const el = c.node.nodeType === 1 ? c.node : c.node.parentElement;
    const root = el?.closest?.(this.isPdf ? '.textLayer' : '.g-body');
    if (!root) return null;
    const u = this.unitForRoot(root);
    if (u == null) return null;
    const off = offsetOfBoundary(root, c.node, c.offset);
    let best = null;
    for (const ann of this.annsOfDoc('hl')) {
      const r = this.resolve(ann);
      if (!r || r.u !== u || off < r.start || off > r.end) continue;
      // 정말 글자 위를 눌렀는지 확인
      const probe = rangeFromOffsets(root, Math.max(r.start, Math.min(off, r.end - 1)), Math.max(r.start, Math.min(off, r.end - 1)) + 1);
      const rects = probe ? [...probe.getClientRects()] : [];
      const near = rects.some((rc) => x >= rc.left - 6 && x <= rc.right + 6 && y >= rc.top - 6 && y <= rc.bottom + 6);
      if (!near) continue;
      if (!best || (r.end - r.start) < (best.r.end - best.r.start)) best = { ann, r };
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
      selBtn('trash', '삭제', () => { closePopovers(); this.deleteAnn(ann); }));
    box.append(row);
    popover(anchor, box, { className: 'annpop-wrap' });
  }

  locLabel(ann) {
    const a = ann.anchor || {};
    if (this.isPdf) return a.p != null ? `${a.p + 1}쪽` : '';
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
  async goToLoc(loc, { flash = false, divided = false, align = 'top', range = null } = {}) {
    if (!loc) return;
    if (this.isPdf) {
      await this.view.goTo(loc, { align });
      if (flash && loc.start != null) {
        await sleep(60);
        this.flash(this.view.rangeAt(loc.p, loc.start, loc.end ?? loc.start + 1));
      }
      this.onLocate(this.view.currentLoc(), {});
      return;
    }
    if (this.view.kind === 'flow') {
      const g = toGlobal(this.book, loc.s, loc.o);
      if (divided && this.mode === 'full' && this.chapters.length > 1) {
        this.mode = 'divided';
        savePos(this.doc.id, { mode: 'divided' });
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
    await this.view.goTo(loc, { align });
    if (flash) {
      await sleep(50);
      const r = range || (loc.end != null ? this.view.rangeAt(loc.s, loc.o, loc.end) : null);
      if (r) this.flash(r);
    }
    const l = this.view.currentLoc();
    if (l) this.onLocate(l, {});
  }

  async jumpToAnn(annId) {
    const ann = state.anns.get(annId);
    if (!ann || ann.deleted) return;
    if (ann.kind === 'bm') {
      const a = ann.anchor || {};
      await this.goToLoc(this.isPdf ? { p: a.p, y: a.y || 0 } : { s: a.s, o: a.o || 0 });
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
    state.app.readerPanel = open;
    setTimeout(() => this.view?.relayout?.(), 50);
  }

  showMenu(anchor) {
    const items = [];
    if (!this.isPdf) {
      items.push({ label: '줄글 보기', hint: '위아래로 이어 읽기', checked: this.view.kind === 'flow', onClick: () => this.setView('flow') });
      items.push({ label: '전자책 보기', hint: this.doc.format === 'epub' ? '쪽 넘기기 · 책 원래 모양' : '쪽 넘기기', checked: this.view.kind === 'paged', onClick: () => this.setView('paged') });
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
    items.push({ divider: true });
    items.push({ label: '하이라이트 · 메모', icon: 'highlight', onClick: () => this.showAnnotations() });
    items.push({ label: '책갈피 목록', icon: 'bookmarks', onClick: () => this.showBookmarks() });
    items.push({ label: '읽기 설정', icon: 'type', onClick: () => this.showSettings() });
    if ('speechSynthesis' in window && !this.isPdf) items.push({ label: this.tts ? '읽어주기 멈춤' : '읽어주기', icon: 'speaker', onClick: () => panels.toggleSpeech(this) });
    items.push({ label: '문서 정보', icon: 'info', onClick: () => this.showInfo() });
    menu(anchor, items);
  }

  applySettings(patch) {
    setReader(patch);
    kvSet('readerTouched', true).catch(() => {});
    this.settings = state.reader;
    this.applyTheme();
    if (this.view) {
      if ('bookStyle' in patch && this.view.kind === 'paged') {
        const loc = this.view.currentLoc();
        this.view.showSection(loc.s, { o: loc.o });
      } else {
        clearTimeout(this.relayoutTimer);
        this.relayoutTimer = setTimeout(() => this.view?.relayout?.(), 120);
      }
    }
  }

  setPdfZoom(z) {
    setReader({ pdfZoom: z });
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
    const onResize = throttle(() => { if (this.pending) this.placeSelTool(this.pending.range); }, 200);
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onAct, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    this.host.addEventListener('scroll', () => { if (!this.selTool.hidden && this.pending) this.placeSelTool(this.pending.range); }, { capture: true, passive: true });
    this.offs.push(
      () => document.removeEventListener('selectionchange', onSel),
      () => document.removeEventListener('keydown', onKey),
      () => document.removeEventListener('pointerdown', onAct),
      () => document.removeEventListener('visibilitychange', onVis),
      () => window.removeEventListener('resize', onResize),
      on('anns', (d) => { if (!d || d.docId === this.doc.id) this.refreshAnns(); }),
      on('remote-applied', () => {
        // 다른 기기에서 이 문서를 지웠으면 닫는다
        if (state.docs.get(this.doc.id)?.deleted) { toast('다른 기기에서 이 문서를 서재에서 지웠습니다.'); history.back(); return; }
        this.refreshAnns();
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
    flushPositions().catch(() => {});
    emit('flush-request');
  }

  onReachEnd() {
    toast('마지막 쪽입니다.', { duration: 1200 });
  }

  async close({ silent = false } = {}) {
    if (!this.alive) return;
    this.flush();
    this.alive = false;
    clearInterval(this.ticker);
    for (const off of this.offs) off();
    if (this.tts) panels.stopSpeech(this);
    closePopovers();
    this.hideSelTool();
    this.view?.destroy();
    this.painter.destroy();
    this.res.revoke();
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

function selBtn(icon, label, onClick) {
  return h('button', {
    class: 'seltool-btn', 'aria-label': label,
    onpointerdown: (e) => e.preventDefault(),
    onclick: onClick,
    html: `${ico(icon)}<span>${esc(label)}</span>`,
  });
}

export { closeAllOverlays };

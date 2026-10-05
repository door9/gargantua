// 전자책 보기 — 쪽 단위로 넘겨 읽기. 책의 원래 CSS를 살리고, 넓은 화면에서는 두 쪽 펼침.
import { h, debounce, sleep } from '../util.js';
import { rangeFromOffsets, textIndex } from '../text.js';
import { fragmentFrom } from '../parse/common.js';
import { applyWindow, windowsFor } from './window.js';

const WINDOW_LIMIT = 70000;

export class PagedView {
  constructor(reader) {
    this.r = reader;
    this.book = reader.book;
    this.kind = 'paged';
    this.roots = new Map();
    this.s = -1;
    this.page = 0;
    this.views = 1;
    this.wins = [{ from: 0, to: 0 }];
    this.wi = 0;
    this.W = 0;
    this.lastLoc = null;
    this.swipedAt = 0;
  }

  mount(host) {
    this.el = h('div', { class: 'paged' });
    this.styleEl = h('style');
    this.vp = h('div', { class: 'pg-vp' });
    this.content = h('div', { class: 'pg-content g-book g-text' });
    this.vp.append(this.content);
    this.el.append(this.styleEl, this.vp);
    host.append(this.el);
    this.bindGestures();
    this.ro = new ResizeObserver(debounce(() => this.relayout(), 120));
    this.ro.observe(this.el);
    this.onImg = debounce(() => this.relayout(), 160);
  }

  destroy() {
    this.ro?.disconnect();
    this.r.unitsCleared();
    this.el?.remove();
  }

  bindGestures() {
    let ptr = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
    });
    this.el.addEventListener('pointerup', (e) => {
      const p = ptr;
      ptr = null;
      if (!p || p.id !== e.pointerId) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const sel = getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3 && Date.now() - p.t < 900) {
        this.swipedAt = Date.now();
        if (dx < 0) this.next(); else this.prev();
      }
    });
    this.el.addEventListener('pointercancel', () => { ptr = null; });
    let wheelAt = 0;
    this.el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(d) < 4 || Date.now() - wheelAt < 320) return;
      wheelAt = Date.now();
      if (d > 0) this.next(); else this.prev();
    }, { passive: false });
  }

  // 화면 좌우를 누르면 넘기기, 가운데는 메뉴
  onTap(e) {
    if (Date.now() - this.swipedAt < 400) return true;
    const rect = this.el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.28) { this.prev(); return true; }
    if (x > 0.72) { this.next(); return true; }
    return false;
  }

  geometry() {
    const st = this.r.settings;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const spread = st.spread === 'off' ? false : st.spread === 'on' ? W >= 640 : (W >= 900 && W > H * 1.05);
    const m = Math.round(Math.max(14, Math.min(st.margin, W * 0.08)) + (spread ? 18 : 0));
    const mv = Math.round(Math.max(18, Math.min(44, H * 0.045)));
    return { W, H, spread, m, mv };
  }

  async showSection(s, { o = null, atEnd = false, keepWindow = false } = {}) {
    s = Math.max(0, Math.min(this.book.sections.length - 1, s));
    const sec = this.book.sections[s];
    this.r.unitsCleared();
    this.roots.clear();
    const body = h('div', { class: `g-body ${sec.bodyClass || ''}`.trim(), lang: sec.lang || this.book.lang || null });
    body.append(fragmentFrom(sec.html));
    body.append(h('span', { class: 'pg-end', 'data-gui': '' }));
    this.content.replaceChildren(body);
    this.styleEl.textContent = this.r.settings.bookStyle ? this.r.bookCss(sec.styles || []) : '';
    this.s = s;
    this.roots.set(s, body);
    this.r.attachResources(body, () => this.onImg());
    // 아주 긴 장은 몇 덩어리로 나눠 넘긴다
    this.wins = windowsFor(body, WINDOW_LIMIT);
    if (!keepWindow) {
      if (o != null) this.wi = Math.max(0, this.wins.findIndex((w) => o >= w.from && o < w.to));
      else this.wi = atEnd ? this.wins.length - 1 : 0;
      if (this.wi < 0) this.wi = this.wins.length - 1;
    }
    this.applyWin();
    this.r.unitsRendered([s]);
    this.layout();
    if (o != null) this.page = this.pageOfOffset(o);
    else this.page = atEnd ? this.views - 1 : 0;
    this.setPage(this.page, { instant: true });
    // 글꼴·그림이 늦게 오면 다시 잰다
    if (document.fonts?.status !== 'loaded') document.fonts.ready.then(() => this.relayout());
  }

  applyWin() {
    const body = this.roots.get(this.s);
    if (!body) return;
    const w = this.wins[this.wi] || this.wins[0];
    if (this.wins.length > 1) applyWindow(body, w.from, w.to);
  }

  layout() {
    const g = this.geometry();
    this.W = g.W;
    this.geo = g;
    this.el.classList.toggle('spread', g.spread);
    const cs = this.content.style;
    this.vp.style.padding = `${g.mv}px ${g.m}px`;
    cs.height = `${Math.max(120, g.H - g.mv * 2)}px`;
    cs.columnCount = g.spread ? '2' : '1';
    cs.columnGap = `${g.m * 2}px`;
    cs.setProperty('--pg-h', `${Math.max(120, g.H - g.mv * 2)}px`);
    cs.transition = 'none';
    cs.transform = 'translateX(0)';
    const end = this.content.querySelector('.pg-end');
    const base = this.content.getBoundingClientRect().left;
    let extent = this.content.scrollWidth + g.m * 2;
    if (end) {
      const r = end.getBoundingClientRect();
      extent = Math.max(extent, r.right - base + g.m * 2 - 1);
    }
    this.views = Math.max(1, Math.ceil((extent - 2) / g.W));
    if (this.page >= this.views) this.page = this.views - 1;
  }

  relayout() {
    if (this.s < 0) return;
    const loc = this.currentLoc();
    this.layout();
    if (loc && loc.s === this.s) this.page = this.pageOfOffset(loc.o);
    this.setPage(this.page, { instant: true, silent: true });
  }

  setPage(p, { instant = false, silent = false } = {}) {
    this.page = Math.max(0, Math.min(this.views - 1, p));
    const cs = this.content.style;
    cs.transition = !instant && this.r.settings.pageAnim ? 'transform .22s ease' : 'none';
    cs.transform = `translateX(${-this.page * this.W}px)`;
    if (!silent) {
      const after = () => {
        const loc = this.currentLoc();
        if (loc) this.r.onLocate(loc, { atEnd: this.isLastPage() });
      };
      if (!instant && this.r.settings.pageAnim) setTimeout(after, 240); else setTimeout(after, 0);
    }
  }

  isLastPage() {
    return this.s === this.book.sections.length - 1 && this.page >= this.views - 1 && this.wi >= this.wins.length - 1;
  }

  next() {
    if (this.page < this.views - 1) { this.setPage(this.page + 1); return true; }
    if (this.wi < this.wins.length - 1) {
      this.wi++;
      this.applyWin();
      this.layout();
      this.setPage(0, { instant: true });
      return true;
    }
    if (this.s < this.book.sections.length - 1) {
      this.showSection(this.s + 1).then(() => this.r.onLocate(this.currentLoc(), {}));
      return true;
    }
    this.r.onReachEnd?.();
    return false;
  }

  prev() {
    if (this.page > 0) { this.setPage(this.page - 1); return true; }
    if (this.wi > 0) {
      this.wi--;
      this.applyWin();
      this.layout();
      this.setPage(this.views - 1, { instant: true });
      return true;
    }
    if (this.s > 0) {
      this.showSection(this.s - 1, { atEnd: true }).then(() => this.r.onLocate(this.currentLoc(), {}));
      return true;
    }
    return false;
  }

  // 글자 상자가 몇 번째 쪽에 있는지(본문 상자의 왼쪽 끝은 넘긴 만큼 이미 옮겨져 있다)
  pageOfRect(rect) {
    const base = this.content.getBoundingClientRect().left;
    return Math.floor((rect.left - base + 2) / this.W);
  }

  pageOfOffset(o) {
    const body = this.roots.get(this.s);
    if (!body) return 0;
    const idx = textIndex(body);
    if (!idx.length) return 0;
    const at = Math.max(0, Math.min(o, idx.length - 1));
    const range = rangeFromOffsets(body, at, at + 1);
    const rect = range && firstRect(range);
    if (!rect) return 0;
    return Math.max(0, Math.min(this.views - 1, this.pageOfRect(rect)));
  }

  // 지금 쪽의 첫 글자 위치
  currentLoc() {
    const body = this.roots.get(this.s);
    if (!body) return this.lastLoc;
    const idx = textIndex(body);
    const w = this.wins[this.wi] || { from: 0, to: idx.length };
    if (!idx.length) return (this.lastLoc = { s: this.s, o: 0 });
    // 창 안 글자 칸 범위
    let lo = lowerBound(idx.starts, w.from);
    if (lo > 0 && idx.starts[lo] > w.from) lo--;
    let hi = lowerBound(idx.starts, w.to);
    if (hi <= lo) hi = Math.min(idx.nodes.length, lo + 1);
    const pageOfNode = (i) => {
      for (let k = i; k < Math.min(hi, i + 40); k++) {
        const r = firstRect(rangeOfNode(idx.nodes[k]));
        if (r) return { page: this.pageOfRect(r), k };
      }
      return { page: Infinity, k: i };
    };
    let a = lo;
    let b = hi;
    while (a < b) {
      const mid = (a + b) >> 1;
      const { page } = pageOfNode(mid);
      if (page < this.page) a = mid + 1; else b = mid;
    }
    // a: 이 쪽(또는 뒤)에서 시작하는 첫 칸. 바로 앞 칸이 이 쪽까지 이어질 수 있다
    let o;
    const prevIdx = a - 1;
    if (prevIdx >= lo && prevIdx >= 0) {
      const node = idx.nodes[prevIdx];
      const ch = firstCharOnPage(node, this.page, (r) => this.pageOfRect(r));
      if (ch != null) o = idx.starts[prevIdx] + ch;
    }
    if (o == null) o = a < idx.nodes.length ? idx.starts[a] : idx.length;
    o = Math.max(w.from, Math.min(o, w.to));
    return (this.lastLoc = { s: this.s, o });
  }

  rangeAt(s, start, end) {
    const body = this.roots.get(s);
    if (!body) return null;
    return rangeFromOffsets(body, start, end);
  }

  contains(loc) {
    if (loc.s !== this.s) return false;
    const w = this.wins[this.wi];
    return !w || (loc.o >= w.from && loc.o < Math.max(w.to, w.from + 1)) || this.wins.length === 1;
  }

  async goTo(loc) {
    if (loc.s !== this.s || !this.contains(loc)) {
      await this.showSection(loc.s, { o: loc.o });
    } else {
      this.page = this.pageOfOffset(loc.o);
      this.setPage(this.page, { instant: true, silent: true });
    }
    await sleep(0);
    this.lastLoc = { s: loc.s, o: loc.o };
    return true;
  }

  scrollRangeIntoView(range) {
    const rect = firstRect(range);
    if (!rect) return;
    const p = this.pageOfRect(rect);
    if (p !== this.page) this.setPage(p, { instant: true });
  }

  scrollByPage(dir) {
    if (dir > 0) this.next(); else this.prev();
  }

  pageInfo() {
    return { page: this.page + 1, pages: this.views, win: this.wi + 1, wins: this.wins.length };
  }
}

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function rangeOfNode(node) {
  const r = document.createRange();
  r.setStart(node, 0);
  r.setEnd(node, Math.min(node.data.length, 1));
  return r;
}

function firstRect(range) {
  const rects = range.getClientRects();
  for (const r of rects) if (r.width || r.height) return r;
  const b = range.getBoundingClientRect();
  return b.width || b.height ? b : null;
}

// 글자 칸이 쪽을 넘어갈 때, 이 쪽에 처음 나오는 글자
function firstCharOnPage(node, page, pageOf) {
  const len = node.data.length;
  if (!len) return null;
  const r = document.createRange();
  const pageAt = (i) => {
    r.setStart(node, i);
    r.setEnd(node, Math.min(len, i + 1));
    const rect = firstRect(r);
    return rect ? pageOf(rect) : null;
  };
  const last = pageAt(len - 1);
  if (last == null || last < page) return null;
  let lo = 0;
  let hi = len - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = pageAt(mid);
    if (p == null || p < page) lo = mid + 1; else hi = mid;
  }
  return pageAt(lo) === page ? lo : null;
}

// 줄글 보기 — 위아래로 이어 읽기(안드로이드 앱과 같은 방식). 전체·장별·무작위 모두 여기서 그린다.
import { h, throttle, sleep } from '../util.js';
import { rangeFromOffsets, offsetOfBoundary, caretFromPoint, textIndex } from '../text.js';
import { fragmentFrom } from '../parse/common.js';
import { fromGlobal } from './chapters.js';
import { applyWindow } from './window.js';

export class FlowView {
  constructor(reader) {
    this.r = reader;
    this.book = reader.book;
    this.kind = 'flow';
    this.roots = new Map();
    this.win = null;
    this.lastLoc = null;
    this.lastTop = 0;
  }

  mount(host) {
    this.el = h('div', { class: 'flow-scroll', tabindex: '-1' });
    this.article = h('article', { class: 'flow g-text' });
    this.el.append(this.article);
    host.append(this.el);
    this.onScroll = throttle(() => this.handleScroll(), 140);
    this.el.addEventListener('scroll', this.onScroll, { passive: true });
  }

  destroy() {
    this.el?.removeEventListener('scroll', this.onScroll);
    this.r.unitsCleared();
    this.el?.remove();
  }

  // win: {from, to, end: 'chapter'|'doc', next: bool} 또는 null(전체)
  render(win = null) {
    this.r.unitsCleared();
    this.win = win;
    this.roots.clear();
    this.article.textContent = '';
    const book = this.book;
    const from = win ? win.from : 0;
    const to = win ? win.to : book.chars;
    let sFrom = 0;
    let sTo = book.sections.length - 1;
    if (win) {
      sFrom = firstSectionAt(book, from);
      sTo = fromGlobal(book, Math.max(from, to - 1)).s;
      if (to >= book.chars) sTo = book.sections.length - 1;
    }
    const pending = [];
    const frag = document.createDocumentFragment();
    const est = this.estimator();
    for (let s = sFrom; s <= sTo; s++) {
      const sec = book.sections[s];
      const wrap = h('section', { class: 'g-sec', 'data-s': String(s) });
      const body = h('div', { class: 'g-body', lang: sec.lang || book.lang || null });
      body.append(fragmentFrom(sec.html));
      wrap.append(body);
      if (sec.chars > 2000) wrap.style.containIntrinsicSize = `auto ${Math.round(est(sec.chars))}px`;
      frag.append(wrap);
      this.roots.set(s, body);
      if (win) {
        const a = Math.max(0, from - sec.start);
        const b = Math.min(sec.chars, to - sec.start);
        if (a > 0 || b < sec.chars) pending.push([body, a, b]);
      }
    }
    this.article.append(frag);
    for (const [body, a, b] of pending) applyWindow(body, a, b);
    this.r.attachResources(this.article);
    this.article.append(this.r.endMarker(win));
    this.r.unitsRendered([...this.roots.keys()]);
  }

  estimator() {
    const st = this.r.settings;
    const width = Math.min(st.maxWidth, Math.max(240, (this.el.clientWidth || innerWidth) - st.margin * 2));
    const fs = st.fontSize;
    const cjk = !(this.book.lang || 'ko').startsWith('en');
    const cpl = Math.max(10, width / (fs * (cjk ? 1.0 : 0.52)));
    const lineH = fs * st.lineHeight;
    return (chars) => (chars / cpl) * lineH * 1.12;
  }

  handleScroll() {
    const top = this.el.scrollTop;
    const dir = top > this.lastTop + 3 ? 'down' : top < this.lastTop - 3 ? 'up' : null;
    this.lastTop = top;
    const loc = this.currentLoc();
    if (loc) this.r.onLocate(loc, { dir, atEnd: top + this.el.clientHeight >= this.el.scrollHeight - 4 });
  }

  // 화면 맨 위 글자의 위치
  currentLoc() {
    const box = this.el.getBoundingClientRect();
    if (!box.height || !this.roots.size) return this.lastLoc;
    if (this.el.scrollTop <= 2 && this.win) {
      const s = firstSectionAt(this.book, this.win.from);
      return (this.lastLoc = { s, o: Math.max(0, this.win.from - this.book.sections[s].start) });
    }
    if (this.el.scrollTop <= 2 && !this.win) return (this.lastLoc = { s: 0, o: 0 });
    const art = this.article.getBoundingClientRect();
    const xs = [art.left + art.width * 0.5, art.left + Math.min(60, art.width / 4), art.left + art.width * 0.8];
    const ys = [box.top + 8, box.top + 30, box.top + 64, box.top + 120];
    for (const y of ys) {
      for (const x of xs) {
        const c = caretFromPoint(x, y);
        if (!c) continue;
        const el = c.node.nodeType === 1 ? c.node : c.node.parentElement;
        const body = el?.closest?.('.g-body');
        if (!body || !this.article.contains(body)) continue;
        const s = Number(body.parentElement.dataset.s);
        const o = offsetOfBoundary(body, c.node, c.offset);
        return (this.lastLoc = { s, o });
      }
    }
    return (this.lastLoc = this.scanLoc(box.top + 8) || this.lastLoc);
  }

  scanLoc(y) {
    for (const [s, body] of this.roots) {
      const r = body.getBoundingClientRect();
      if (r.bottom < y) continue;
      const idx = textIndex(body);
      let lo = 0;
      let hi = idx.nodes.length - 1;
      if (hi < 0) return { s, o: 0 };
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const rr = nodeRect(idx.nodes[mid]);
        if (!rr || rr.bottom < y) lo = mid + 1; else hi = mid;
      }
      return { s, o: idx.starts[lo] };
    }
    return null;
  }

  rangeAt(s, start, end) {
    const body = this.roots.get(s);
    if (!body) return null;
    return rangeFromOffsets(body, start, end);
  }

  contains(loc) {
    if (!this.roots.has(loc.s)) return false;
    if (!this.win) return true;
    const g = this.book.sections[loc.s].start + loc.o;
    return g >= this.win.from && (g < this.win.to || (g === this.win.to && this.win.to >= this.book.chars));
  }

  async goTo(loc, { align = 'top', smooth = false } = {}) {
    const body = this.roots.get(loc.s);
    if (!body) return false;
    const idx = textIndex(body);
    const o = Math.max(0, Math.min(loc.o, idx.length));
    const range = idx.length ? rangeFromOffsets(body, o >= idx.length ? Math.max(0, o - 1) : o, o >= idx.length ? o : o + 1) : null;
    const place = (behavior) => {
      let rect = range ? range.getBoundingClientRect() : null;
      if (!rect || (!rect.width && !rect.height)) rect = body.parentElement.getBoundingClientRect();
      const box = this.el.getBoundingClientRect();
      const offset = align === 'center' ? box.height * 0.33 : 14;
      const target = this.el.scrollTop + rect.top - box.top - offset;
      this.el.scrollTo({ top: Math.max(0, target), behavior });
    };
    place(smooth ? 'smooth' : 'instant');
    if (!smooth) {
      await sleep(40);
      place('instant');
      await sleep(140);
      place('instant');
    } else {
      await sleep(450);
    }
    this.lastTop = this.el.scrollTop;
    this.lastLoc = { s: loc.s, o };
    return true;
  }

  scrollByPage(dir) {
    this.el.scrollBy({ top: dir * (this.el.clientHeight - 60), behavior: 'smooth' });
  }

  scrollRangeIntoView(range) {
    const rect = range.getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    if (rect.top >= box.top + 40 && rect.bottom <= box.bottom - 40) return;
    this.el.scrollTo({ top: this.el.scrollTop + rect.top - box.top - box.height * 0.3, behavior: 'smooth' });
  }

  relayout() {
    const loc = this.currentLoc();
    const est = this.estimator();
    for (const [s, body] of this.roots) {
      const sec = this.book.sections[s];
      if (sec.chars > 2000) body.parentElement.style.containIntrinsicSize = `auto ${Math.round(est(sec.chars))}px`;
    }
    if (loc) setTimeout(() => this.goTo(loc), 30);
  }

  pageInfo() {
    return null;
  }
}

function nodeRect(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const rect = r.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

// 위치 g에서 시작하는 구획(글자가 없는 그림 장이 앞에 있으면 그 장부터)
function firstSectionAt(book, g) {
  let s = fromGlobal(book, g).s;
  while (s > 0 && book.sections[s - 1].start === g && book.sections[s - 1].chars === 0 && g > 0) s--;
  if (g === 0) s = 0;
  return s;
}

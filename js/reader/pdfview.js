// PDF 보기 — 쪽을 위아래로 이어 보고, 글자 층을 깔아 선택·하이라이트·메모를 할 수 있게 한다.
import { h, throttle, sleep, clamp } from '../util.js';
import { rangeFromOffsets, textIndex } from '../text.js';
import { pdfjs } from '../pdfdoc.js';

const MAX_PIXELS = 12e6;

export class PdfView {
  constructor(reader) {
    this.r = reader;
    this.pdf = reader.pdf;
    this.kind = 'pdf';
    this.roots = new Map();
    this.pages = [];
    this.zoom = clamp(reader.settings.pdfZoom || 1, 0.5, 4);
    this.lastLoc = null;
    this.lastTop = 0;
  }

  async mount(host) {
    this.lib = await pdfjs();
    this.el = h('div', { class: 'pdf-scroll', tabindex: '-1' });
    this.inner = h('div', { class: 'pdf-pages' });
    this.el.append(this.inner);
    host.append(this.el);
    const first = await this.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.base = { w: vp.width, h: vp.height };
    for (let i = 0; i < this.pdf.numPages; i++) {
      const div = h('div', { class: 'pdf-page', 'data-p': String(i) }, h('div', { class: 'pdf-num', 'data-gui': '' }, String(i + 1)));
      this.pages.push({ div, w: vp.width, h: vp.height, state: 'empty', task: null });
      this.inner.append(div);
    }
    this.fit();
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.el, rootMargin: '1400px 0px' });
    for (const p of this.pages) this.io.observe(p.div);
    this.onScroll = throttle(() => this.handleScroll(), 140);
    this.el.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(throttle(() => this.refit(), 250));
    this.ro.observe(this.el);
    this.bindPinch();
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
  }

  destroy() {
    this.io?.disconnect();
    this.ro?.disconnect();
    for (const p of this.pages) p.task?.cancel?.();
    this.r.unitsCleared();
    this.el?.remove();
  }

  fitScale() {
    const avail = Math.max(200, (this.el.clientWidth || innerWidth) - (innerWidth < 700 ? 8 : 40));
    return Math.min(avail, 1000) / this.base.w;
  }

  fit() {
    this.baseScale = this.fitScale();
    this.sizeAll();
  }

  scale() {
    return this.baseScale * this.zoom;
  }

  sizeAll() {
    const s = this.scale();
    for (const p of this.pages) {
      p.div.style.width = `${Math.floor(p.w * s)}px`;
      p.div.style.height = `${Math.floor(p.h * s)}px`;
      p.div.style.setProperty('--total-scale-factor', String(s));
      p.div.style.setProperty('--scale-round-x', '1px');
      p.div.style.setProperty('--scale-round-y', '1px');
    }
  }

  refit() {
    const loc = this.currentLoc();
    const prev = this.baseScale;
    this.baseScale = this.fitScale();
    if (Math.abs(prev - this.baseScale) < 0.01) return;
    this.rerenderAll(loc);
  }

  setZoom(z) {
    z = clamp(z, 0.5, 4);
    if (Math.abs(z - this.zoom) < 0.01) return;
    const loc = this.currentLoc();
    this.zoom = z;
    this.r.setPdfZoom(z);
    this.rerenderAll(loc);
  }

  rerenderAll(loc) {
    for (let i = 0; i < this.pages.length; i++) this.unrender(i);
    this.sizeAll();
    if (loc) this.goTo(loc);
    setTimeout(() => this.renderVisible(), 30);
  }

  onIntersect(entries) {
    for (const e of entries) {
      const i = Number(e.target.dataset.p);
      if (e.isIntersecting) this.renderPage(i);
    }
    // 멀리 벗어난 쪽은 메모리를 위해 지운다
    const cur = this.lastLoc?.p ?? 0;
    for (let i = 0; i < this.pages.length; i++) {
      if (Math.abs(i - cur) > 8 && this.pages[i].state !== 'empty') this.unrender(i);
    }
  }

  renderVisible() {
    const box = this.el.getBoundingClientRect();
    for (let i = 0; i < this.pages.length; i++) {
      const r = this.pages[i].div.getBoundingClientRect();
      if (r.bottom > box.top - 1400 && r.top < box.bottom + 1400) this.renderPage(i);
    }
  }

  async renderPage(i) {
    const p = this.pages[i];
    if (!p || p.state !== 'empty') return p?.ready;
    p.state = 'loading';
    let resolveReady;
    p.ready = new Promise((r) => { resolveReady = r; });
    const gen = (p.gen = (p.gen || 0) + 1);
    try {
      const page = await this.pdf.getPage(i + 1);
      if (p.gen !== gen) return;
      const scale = this.scale();
      const unit = page.getViewport({ scale: 1 });
      if (Math.abs(unit.width - p.w) > 0.5 || Math.abs(unit.height - p.h) > 0.5) {
        p.w = unit.width;
        p.h = unit.height;
        p.div.style.width = `${Math.floor(p.w * scale)}px`;
        p.div.style.height = `${Math.floor(p.h * scale)}px`;
      }
      const vp = page.getViewport({ scale });
      let ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      if (vp.width * vp.height * ratio * ratio > MAX_PIXELS) ratio = Math.sqrt(MAX_PIXELS / (vp.width * vp.height));
      const canvas = h('canvas', { class: 'pdf-canvas' });
      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      const task = page.render({ canvasContext: ctx, canvas, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      p.task = task;
      await task.promise;
      if (p.gen !== gen) return;
      const tl = h('div', { class: 'textLayer' });
      p.div.querySelector('.pdf-canvas')?.remove();
      p.div.querySelector('.textLayer')?.remove();
      p.div.append(canvas, tl);
      const layer = new this.lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await layer.render();
      if (p.gen !== gen) return;
      tl.append(h('div', { class: 'endOfContent', 'data-gui': '' }));
      p.state = 'done';
      this.roots.set(i, tl);
      this.r.unitsRendered([i]);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') {
        p.state = 'empty';
        console.warn('PDF 쪽 그리기 실패', i + 1, e);
      }
    } finally {
      resolveReady();
    }
    return p.ready;
  }

  unrender(i) {
    const p = this.pages[i];
    if (!p || p.state === 'empty') return;
    p.gen = (p.gen || 0) + 1;
    p.task?.cancel?.();
    p.task = null;
    p.div.querySelector('.pdf-canvas')?.remove();
    p.div.querySelector('.textLayer')?.remove();
    p.state = 'empty';
    if (this.roots.has(i)) {
      this.roots.delete(i);
      this.r.unitRemoved(i);
    }
  }

  handleScroll() {
    const top = this.el.scrollTop;
    const dir = top > this.lastTop + 3 ? 'down' : top < this.lastTop - 3 ? 'up' : null;
    this.lastTop = top;
    const loc = this.currentLoc();
    if (loc) this.r.onLocate(loc, { dir, atEnd: top + this.el.clientHeight >= this.el.scrollHeight - 4 });
  }

  currentLoc() {
    if (!this.pages.length) return this.lastLoc;
    const y = this.el.scrollTop + 8;
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pages[mid].div.offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    const div = this.pages[lo].div;
    const frac = clamp((y - div.offsetTop) / Math.max(1, div.offsetHeight), 0, 1);
    return (this.lastLoc = { p: lo, y: +frac.toFixed(4) });
  }

  async goTo(loc, { align = 'top' } = {}) {
    const p = clamp(loc.p ?? 0, 0, this.pages.length - 1);
    const div = this.pages[p].div;
    if (loc.start != null) {
      await this.renderPage(p);
      const tl = this.roots.get(p);
      if (tl) {
        const range = rangeFromOffsets(tl, loc.start, Math.max(loc.start + 1, loc.end || loc.start + 1));
        const rect = range?.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          const box = this.el.getBoundingClientRect();
          this.el.scrollTop += rect.top - box.top - (align === 'center' ? box.height * 0.33 : 40);
          this.lastLoc = { p, y: 0 };
          return true;
        }
      }
    }
    this.el.scrollTop = div.offsetTop + (loc.y || 0) * div.offsetHeight - 8;
    this.lastLoc = { p, y: loc.y || 0 };
    return true;
  }

  rangeAt(p, start, end) {
    const tl = this.roots.get(p);
    if (!tl) return null;
    return rangeFromOffsets(tl, start, end);
  }

  contains(loc) {
    return this.roots.has(loc.p);
  }

  scrollRangeIntoView(range) {
    const rect = range.getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    if (rect.top >= box.top + 40 && rect.bottom <= box.bottom - 40) return;
    this.el.scrollTop += rect.top - box.top - box.height * 0.3;
  }

  scrollByPage(dir) {
    this.el.scrollBy({ top: dir * (this.el.clientHeight - 60), behavior: 'smooth' });
  }

  pageInfo() {
    const p = this.lastLoc?.p ?? 0;
    return { page: p + 1, pages: this.pages.length };
  }

  bindPinch() {
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const box = this.el.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top;
      pinch = { d0: dist(e.touches), cx, cy, ratio: 1, sx: this.el.scrollLeft, sy: this.el.scrollTop };
      this.inner.style.transformOrigin = `${cx + this.el.scrollLeft - this.inner.offsetLeft}px ${cy + this.el.scrollTop}px`;
    }, { passive: true });
    this.el.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.ratio = clamp(dist(e.touches) / pinch.d0, 0.5 / this.zoom, 4 / this.zoom);
      this.inner.style.transform = `scale(${pinch.ratio})`;
    }, { passive: false });
    const end = () => {
      if (!pinch) return;
      const { ratio, cx, cy, sx, sy } = pinch;
      pinch = null;
      this.inner.style.transform = '';
      if (Math.abs(ratio - 1) < 0.04) return;
      const oldScale = this.scale();
      this.zoom = clamp(this.zoom * ratio, 0.5, 4);
      this.r.setPdfZoom(this.zoom);
      const k = this.scale() / oldScale;
      for (let i = 0; i < this.pages.length; i++) this.unrender(i);
      this.sizeAll();
      this.el.scrollLeft = (sx + cx) * k - cx;
      this.el.scrollTop = (sy + cy) * k - cy;
      setTimeout(() => this.renderVisible(), 20);
    };
    this.el.addEventListener('touchend', end);
    this.el.addEventListener('touchcancel', end);
  }
}

export { sleep };

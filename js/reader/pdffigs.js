// 전자책으로 다시 짠 PDF 의 그림 — 책에는 자리(쪽·네모)만 적혀 있고, 읽을 때 원본 쪽에서 오려 그려 기기에 보관한다.
// 처음 열 때 모든 그림을 그리면 오래 걸려서, 지금 읽는 곳 가까운 것부터 하나씩 그린다(자리는 미리 비워 두어 글이 밀리지 않는다).
import { openPdf, closePdf } from '../pdfdoc.js';
import { getFigure, putFigure, requireFile } from '../docs.js';
import { h } from '../util.js';
import { ico } from '../icons.js';
import { sheet } from '../ui/overlay.js';

const LONG_EDGE = 1600; // 그림 긴 변(화소) — 휴대폰 화면 폭의 1.5배쯤
const MAX_SCALE = 3.2;
const MAX_PIXELS = 8e6;
const NEAR = 2; // 줄글 보기: 지금 구획에서 이만큼 앞뒤까지만 미리 그린다
const IDLE_CLOSE_MS = 20000;

const blank = (w, h) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"></svg>`)}`;

export class PdfFigures {
  constructor(reader, figs, { fetchFile } = {}) {
    this.r = reader;
    this.figs = figs || {};
    this.fetchFile = fetchFile;
    this.urls = new Map();
    this.waiting = new Map(); // 그림 이름 → 그 그림을 기다리는 <img> 들
    this.unfit = new Set(); // 아직 화면 폭에 맞추지 않은 표
    this.running = false;
    this.dead = false;
    this.pdfPromise = null;
    this.closeTimer = null;
  }

  // 화면에 붙은 그림: 있으면 바로, 없으면 자리만 잡고 줄을 세운다
  attach(img) {
    const key = img.getAttribute('data-g-src');
    if (!this.figs[key]) { img.classList.add('g-img-missing'); return; }
    const url = this.urls.get(key);
    if (url) { img.src = url; return; }
    img.src = blank(img.getAttribute('width') || 4, img.getAttribute('height') || 3);
    img.classList.add('g-fig-wait');
    if (!this.waiting.has(key)) this.waiting.set(key, new Set());
    this.waiting.get(key).add(img);
    this.pump();
  }

  // 표는 화면 폭에 맞춘다: 글자를 조금씩 줄여 보고, 그래도 넘치면 원본 쪽의 그림으로 바꾼다.
  // 글은 지우지 않는다(글자 위치·찾기가 그대로 되게) — 그림으로 바꾼 표의 글은 보이지 않게 작게 남긴다
  watchTables(root) {
    for (const wrap of root.querySelectorAll('.g-table[data-fig]:not(.g-table-fixed)')) this.unfit.add(wrap);
    this.fitNear();
  }

  fitNear() {
    if (!this.unfit.size) return;
    const here = this.r.view?.currentLoc?.()?.s ?? 0;
    for (const wrap of this.unfit) {
      if (!wrap.isConnected) { this.unfit.delete(wrap); continue; }
      const sec = wrap.closest('.g-sec')?.dataset?.s;
      if (sec != null && Math.abs(Number(sec) - here) > NEAR) continue;
      this.unfit.delete(wrap);
      this.fitTable(wrap);
    }
  }

  fitTable(wrap) {
    const table = wrap.querySelector(':scope > table');
    if (!table) return;
    wrap.classList.remove('g-table-img');
    wrap.querySelector(':scope > img')?.remove();
    table.style.fontSize = '';
    const avail = wrap.clientWidth;
    if (!avail || table.offsetWidth <= avail + 1) return;
    for (const size of [0.78, 0.7, 0.62, 0.56]) {
      table.style.fontSize = `${size}em`;
      if (table.offsetWidth <= avail + 1) return;
    }
    table.style.fontSize = '';
    const key = wrap.dataset.fig;
    const f = this.figs[key];
    if (!f) return;
    wrap.classList.add('g-table-img');
    const img = h('img', { 'data-gui': '', 'data-g-src': key, alt: '', width: String(Math.round((f.x1 - f.x0) * 1.6)), height: String(Math.round((f.y1 - f.y0) * 1.6)) });
    wrap.prepend(img);
    this.attach(img);
  }

  // 글자 크기·화면 폭이 바뀌면 표를 다시 맞춘다
  refit(root) {
    if (root) this.watchTables(root);
  }

  // 읽는 자리가 바뀌면 불린다 — 가까운 그림·표가 생겼을 수 있다
  nudge() {
    this.fitNear();
    if (this.waiting.size) this.pump();
  }

  // 그림·표를 크게 본다(손가락으로 벌려 확대)
  async view(key) {
    if (!this.figs[key]) return;
    let url = this.urls.get(key);
    if (!url) {
      const blob = await getFigure(this.r.doc.id, key) || await this.render(key);
      if (!blob || this.dead) return;
      url = URL.createObjectURL(blob);
      this.urls.set(key, url);
    }
    figureViewer(url);
  }

  nextKey() {
    const here = this.r.view?.currentLoc?.()?.s ?? 0;
    let best = null;
    let bestDist = Infinity;
    for (const [key, imgs] of this.waiting) {
      let dist = Infinity;
      let alive = false;
      for (const img of imgs) {
        if (!img.isConnected) { imgs.delete(img); continue; }
        alive = true;
        const sec = img.closest('.g-sec')?.dataset?.s;
        const d = sec == null ? 0 : Math.abs(Number(sec) - here);
        if (d < dist) dist = d;
      }
      if (!alive) { this.waiting.delete(key); continue; }
      if (dist <= NEAR && dist < bestDist) { best = key; bestDist = dist; }
    }
    return best;
  }

  async pump() {
    if (this.running || this.dead) return;
    this.running = true;
    clearTimeout(this.closeTimer);
    try {
      for (;;) {
        const key = this.nextKey();
        if (!key || this.dead) break;
        let blob = null;
        try {
          blob = await getFigure(this.r.doc.id, key) || await this.render(key);
        } catch (e) {
          console.warn('그림을 그리지 못했습니다', key, e);
        }
        if (this.dead) break;
        const imgs = this.waiting.get(key);
        this.waiting.delete(key);
        if (blob) {
          const url = URL.createObjectURL(blob);
          this.urls.set(key, url);
          for (const img of imgs || []) { img.src = url; img.classList.remove('g-fig-wait'); }
        } else {
          for (const img of imgs || []) { img.classList.remove('g-fig-wait'); img.classList.add('g-img-missing'); }
        }
      }
    } finally {
      this.running = false;
      if (!this.dead) this.closeTimer = setTimeout(() => this.closePdf(), IDLE_CLOSE_MS);
    }
  }

  document() {
    if (!this.pdfPromise) {
      this.pdfPromise = requireFile(this.r.doc, { fetchFile: this.fetchFile }).then((blob) => openPdf(blob));
      this.pdfPromise.catch(() => { this.pdfPromise = null; });
    }
    return this.pdfPromise;
  }

  async render(key) {
    const f = this.figs[key];
    const pdf = await this.document();
    if (this.dead) return null;
    const page = await pdf.getPage(f.p + 1);
    try {
      const w = f.x1 - f.x0;
      const h = f.y1 - f.y0;
      const scale = Math.min(MAX_SCALE, LONG_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const viewport = page.getViewport({ scale, offsetX: -f.x0 * scale, offsetY: -f.y0 * scale });
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      let blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.88));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
      if (blob) await putFigure(this.r.doc.id, key, blob);
      canvas.width = 0;
      return blob;
    } finally {
      page.cleanup();
    }
  }

  async closePdf() {
    const p = this.pdfPromise;
    this.pdfPromise = null;
    if (p) { try { closePdf(await p); } catch { /* 이미 닫힘 */ } }
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.closeTimer);
    this.waiting.clear();
    this.unfit.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.closePdf();
  }
}

// 그림 크게 보기: 두 손가락으로 벌려 확대, 끌어서 옮기기, 두 번 눌러 확대·되돌리기, 그대로 한 번 누르면 닫기
function figureViewer(url) {
  const img = h('img', { class: 'figview-img', src: url, alt: '', draggable: 'false' });
  const stage = h('div', { class: 'figview-stage' }, img);
  const sh = sheet({ body: stage, noHeader: true, className: 'figview' });
  stage.append(h('button', { class: 'gicon figview-close', 'aria-label': '닫기', html: ico('close'), onclick: () => sh.close() }));
  let scale = 1;
  let x = 0;
  let y = 0;
  const pts = new Map();
  let pinch = null;
  let moved = false;
  let lastTap = 0;
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const zoomAt = (cx, cy, next) => {
    next = Math.max(1, Math.min(6, next));
    const box = stage.getBoundingClientRect();
    const ox = cx - box.left - box.width / 2;
    const oy = cy - box.top - box.height / 2;
    x = ox - ((ox - x) * next) / scale;
    y = oy - ((oy - y) * next) / scale;
    scale = next;
    if (scale === 1) { x = 0; y = 0; }
    apply();
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d);
    } else if (pts.size === 1 && scale > 1) {
      x += dx;
      y += dy;
      apply();
    }
  });
  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) pinch = null;
    if (pts.size || moved || e.type === 'pointercancel') return;
    const t = Date.now();
    if (t - lastTap < 300) {
      lastTap = 0;
      clearTimeout(tapTimer);
      zoomAt(e.clientX, e.clientY, scale > 1 ? 1 : 2.6);
      return;
    }
    lastTap = t;
    tapTimer = setTimeout(() => { if (scale === 1) sh.close(); }, 300);
  };
  let tapTimer = null;
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
}

// 손가락으로 글 고르기 — 휴대폰 브라우저의 기본 선택은 고를 때마다 복사·번역·모두 선택·웹 검색 메뉴를 띄우고,
// 웹 쪽에서 그 메뉴만 끌 방법은 없다(2026-10-31 사용자 요청: 앱 기능만 뜨게). 그래서 손가락·펜으로 만질 때는
// 본문의 기본 선택을 끄고(reader.css .touchsel) 앱이 직접 고른다:
//   길게 누르기 → 낱말 · 그대로 끌기 → 낱말 단위로 늘리기 · 양 끝 손잡이 → 글자 단위로 고치기 · 다른 곳 누르기 → 풀기.
// 고른 곳은 하이라이트처럼 CSS Highlight(g-sel)로 칠한다(글이 흔들리지 않음). 마우스는 예전처럼 기본 선택을 쓴다.
import { h, clamp } from '../util.js';
import { caretFromPoint, offsetOfBoundary, rangeFromOffsets, textOf } from '../text.js';
import { HL_SUPPORTED } from './painter.js';

const HOLD_MS = 450; // 길게 누르기. 안드로이드는 제 길게 누르기(기본 0.4초)에 contextmenu를 보내므로 그게 먼저 오면 바로 시작
const SLOP = 10; // 누른 채 이만큼 움직이면 스크롤·쪽 넘기기로 본다
const EDGE = 44; // 끌다가 본문 칸 위아래 끝 이만큼 안에 들면 스크롤(줄글·PDF)

export class TouchSelect {
  constructor(reader) {
    this.r = reader;
    this.on = false;
    this.sel = null; // { root, u, a, b } — a·b: 구획 안 글자 위치(a < b)
    this.press = null; // 길게 누르기를 기다리는 손가락
    this.drag = null; // 끄는 중 { kind: 'word'|'start'|'end', id, x, y, gx, gy, w }
    this.ends = null; // 손잡이 자리(누른 곳이 손잡이인지 가릴 때)
    this.eatUntil = 0;
    this.hl = null;
    this.raf = 0;
    this.handles = [
      h('div', { class: 'tsel-h tsel-s', 'aria-hidden': 'true', hidden: true }),
      h('div', { class: 'tsel-h tsel-e', 'aria-hidden': 'true', hidden: true }),
    ];
    reader.root.append(...this.handles);
    const host = reader.host;
    host.addEventListener('pointerdown', (e) => this.onDown(e));
    host.addEventListener('pointermove', (e) => this.onMove(e));
    host.addEventListener('pointerup', (e) => this.onUp(e));
    host.addEventListener('pointercancel', (e) => this.onUp(e));
    // 고르는 동안은 스크롤하지 않는다(길게 누른 뒤의 첫 움직임부터 막으면 브라우저가 스크롤을 시작하지 않는다)
    host.addEventListener('touchmove', (e) => { if (this.drag && e.cancelable) e.preventDefault(); }, { passive: false });
    // 길게 누르면 뜨는 기본 메뉴(링크·그림 메뉴 포함)와 끌어 옮기기도 막는다
    host.addEventListener('contextmenu', (e) => this.onContext(e));
    host.addEventListener('dragstart', (e) => { if (this.on) e.preventDefault(); });
    if (matchMedia('(pointer: coarse)').matches) this.setOn(true, { quiet: true });
  }

  // 손가락 쓰기(on) ↔ 마우스(off). 바뀔 때 남은 선택은 푼다
  setOn(v, { quiet = false } = {}) {
    if (v && !(HL_SUPPORTED && caretOk())) v = false; // 칠하기·위치 재기가 안 되는 브라우저는 기본 선택 그대로
    if (this.on === v) return;
    this.on = v;
    this.r.root.classList.toggle('touchsel', v);
    if (!quiet) this.r.clearSelection();
  }

  // 고른 글 → {u, start, end, root, range}(앞뒤 빈칸은 뺀다)
  get info() {
    const s = this.sel;
    if (!s || !s.root.isConnected) return null;
    const text = textOf(s.root);
    let start = s.a;
    let end = s.b;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;
    return { u: s.u, start, end, root: s.root, range: rangeFromOffsets(s.root, start, end) };
  }

  // 쪽 넘기기 등이 이 손놀림을 건너뛰어야 하나(고르는 중이거나 고른 글이 있다)
  engaged() {
    return !!(this.drag || this.sel);
  }

  // 고르기를 마치며 손을 뗄 때 오는 누르기(click)는 먹는다 — 고른 것을 바로 풀거나 링크를 열지 않게
  eatClick() {
    return Date.now() < this.eatUntil;
  }

  onDown(e) {
    if (e.pointerType === 'mouse') { this.setOn(false); return; }
    this.setOn(true);
    if (!this.on) return;
    if (!e.isPrimary) { this.cancelPress(); return; } // 두 손가락(확대 등)
    this.eatUntil = 0; // 새 손놀림 — 앞 손놀림을 마칠 때의 누르기만 먹는다
    const grab = this.sel && this.handleAt(e.clientX, e.clientY);
    if (grab) { this.grabHandle(grab, e); return; }
    this.cancelPress();
    if (e.target.closest?.('[data-gui]')) return; // 메모 표시 단추 등
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0 };
    p.timer = setTimeout(() => this.hold(p), HOLD_MS);
    this.press = p;
  }

  onMove(e) {
    const p = this.press;
    if (p && e.pointerId === p.id && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) this.cancelPress();
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX;
    d.y = e.clientY;
    this.follow();
  }

  onUp(e) {
    if (this.press && e.pointerId === this.press.id) this.cancelPress();
    if (this.drag && e.pointerId === this.drag.id) this.endDrag();
  }

  onContext(e) {
    if (!this.on) return;
    e.preventDefault();
    const p = this.press;
    if (p) { clearTimeout(p.timer); this.hold(p); }
  }

  cancelPress() {
    if (!this.press) return;
    clearTimeout(this.press.timer);
    this.press = null;
  }

  // 길게 눌렀다 — 손가락 밑 낱말을 고르고, 떼기 전까지 끌면 낱말 단위로 늘린다
  hold(p) {
    if (this.press !== p) return;
    this.press = null;
    const hit = this.hitAt(p.x, p.y);
    if (!hit) return;
    const w = this.wordAround(hit.root, hit.i);
    if (!w) return;
    this.sel = { root: hit.root, u: hit.u, a: w[0], b: w[1] };
    this.drag = { kind: 'word', id: p.id, x: p.x, y: p.y, gx: 0, gy: 0, w };
    try { navigator.vibrate?.(10); } catch { /* 진동 없는 기기 */ }
    this.paint();
    this.r.onTouchSelect(null);
  }

  // 손잡이를 잡았다 — 손가락은 글줄 아래 손잡이에 있으므로, 누른 곳과 고칠 경계(글줄 가운데)의 차이만큼 옮겨 잰다
  grabHandle(g, e) {
    this.cancelPress();
    const end = this.ends[g.kind];
    this.drag = {
      kind: g.kind, id: e.pointerId, x: e.clientX, y: e.clientY,
      gx: end.x + (g.kind === 'start' ? 1 : -1) - e.clientX,
      gy: end.mid - e.clientY,
    };
    this.r.onTouchSelect(null);
  }

  // 끄는 손가락을 따라 고른 범위를 고친다(fromScroll: 저절로 스크롤된 뒤 다시 잴 때)
  follow(fromScroll = false) {
    const d = this.drag;
    const s = this.sel;
    if (!d || !s) return;
    const o = this.offsetAt(s.root, d.x + d.gx, d.y + d.gy);
    if (o != null) {
      let { a, b } = s;
      if (d.kind === 'word') {
        const [ws, we] = d.w;
        // 경계 o가 처음 고른 낱말 뒤면 그 앞 글자가 든 낱말 끝까지, 앞이면 그 글자가 든 낱말 처음부터
        if (o > we) { a = ws; b = Math.max(we, this.wordEdge(s.root, o - 1, 1)); } else if (o < ws) { a = Math.min(ws, this.wordEdge(s.root, o, -1)); b = we; } else { a = ws; b = we; }
      } else if (d.kind === 'start') {
        a = Math.min(o, b - 1);
      } else {
        b = Math.max(o, a + 1);
      }
      if (a !== s.a || b !== s.b) {
        s.a = a;
        s.b = b;
        this.paint();
      }
    }
    if (!fromScroll) this.autoScroll();
  }

  endDrag() {
    this.drag = null;
    this.stopScroll();
    this.eatUntil = Date.now() + 400;
    const info = this.info;
    if (!info) { this.clear(); this.r.onTouchSelect(null); return; }
    this.paint();
    this.r.onTouchSelect(info, true);
  }

  clear() {
    this.cancelPress();
    this.drag = null;
    this.stopScroll();
    this.sel = null;
    this.ends = null;
    this.hl?.clear();
    for (const el of this.handles) el.hidden = true;
  }

  // 그려 둔 구획이 사라지면(다른 장으로·보기 바꾸기·PDF 쪽 비우기) 그 안의 선택도 푼다. u 없으면 모두
  dropUnit(u = null) {
    if (!this.sel || (u != null && this.sel.u !== u)) return false;
    this.clear();
    return true;
  }

  destroy() {
    this.clear();
    if (this.hl && CSS.highlights.get('g-sel') === this.hl) CSS.highlights.delete('g-sel');
    this.hl = null;
    for (const el of this.handles) el.remove();
  }

  // ── 그리기 ──
  paint() {
    const info = this.info;
    if (!this.hl) {
      this.hl = new Highlight();
      this.hl.priority = 4; // 칠해 둔 하이라이트·찾기 위에
      CSS.highlights.set('g-sel', this.hl);
    }
    this.hl.clear();
    if (info) this.hl.add(info.range);
    this.place(info);
  }

  // 손잡이 자리 — 첫 글자 왼쪽 아래·끝 글자 오른쪽 아래. 본문 칸 밖(스크롤해 지나감·다른 쪽·메뉴 밑)이면 숨긴다
  place(info = this.info) {
    const [hs, he] = this.handles;
    if (!info || !this.on) {
      hs.hidden = true;
      he.hidden = true;
      this.ends = null;
      return;
    }
    const area = this.area();
    const r1 = charRect(info.root, info.start);
    const r2 = charRect(info.root, info.end - 1);
    this.ends = {
      start: r1 && { x: r1.left, y: r1.bottom, mid: (r1.top + r1.bottom) / 2 },
      end: r2 && { x: r2.right, y: r2.bottom, mid: (r2.top + r2.bottom) / 2 },
    };
    const put = (el, p) => {
      const ok = !!p && p.x >= area.left - 2 && p.x <= area.right + 2 && p.y >= area.top && p.y <= area.bottom + 2;
      el.hidden = !ok;
      if (ok) {
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
      }
    };
    put(hs, this.ends.start);
    put(he, this.ends.end);
  }

  // 누른 곳이 손잡이인가(둥근 몸통과 그 둘레 — 손가락으로 잡기 넉넉하게, 위 글줄은 조금만 덮는다)
  handleAt(x, y) {
    let best = null;
    for (const [kind, el] of [['start', this.handles[0]], ['end', this.handles[1]]]) {
      const p = this.ends?.[kind];
      if (el.hidden || !p) continue;
      const cx = kind === 'start' ? p.x - 10 : p.x + 10;
      if (x < cx - 24 || x > cx + 24 || y < p.y - 8 || y > p.y + 40) continue;
      const dist = Math.hypot(x - cx, y - (p.y + 10));
      if (!best || dist < best.dist) best = { kind, dist };
    }
    return best;
  }

  // 본문이 보이는 칸(펼친 메뉴가 덮은 곳은 뺀다)
  area() {
    const box = this.r.host.getBoundingClientRect();
    const ins = this.r.overlayInsets();
    return { left: box.left, right: box.right, top: box.top + ins.top, bottom: box.bottom - ins.bottom };
  }

  // ── 끝에 닿으면 스크롤(줄글·PDF) ──
  scroller() {
    const v = this.r.view;
    return v && v.kind !== 'paged' ? v.el : null;
  }

  autoScroll() {
    const d = this.drag;
    const el = this.scroller();
    if (!d || !el) { this.stopScroll(); return; }
    const a = this.area();
    let v = 0;
    if (d.y < a.top + EDGE) v = -((a.top + EDGE - d.y) / EDGE) * 12;
    else if (d.y > a.bottom - EDGE) v = ((d.y - (a.bottom - EDGE)) / EDGE) * 12;
    d.v = Math.round(clamp(v, -18, 18));
    if (!d.v || this.raf) return;
    const step = () => {
      const dd = this.drag;
      if (!dd || !dd.v) { this.raf = 0; return; }
      const before = el.scrollTop;
      el.scrollTop += dd.v;
      if (el.scrollTop !== before) this.follow(true);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stopScroll() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ── 화면 좌표 → 글자 위치 ──
  // 길게 누른 곳의 글자(그 글자 상자 위를 눌렀을 때만 — 여백·그림을 누르면 고르지 않는다)
  hitAt(x, y) {
    const c = caretFromPoint(x, y);
    if (!c) return null;
    const el = c.node.nodeType === 1 ? c.node : c.node.parentElement;
    const root = el?.closest?.(this.r.isPdf ? '.textLayer' : '.g-body');
    if (!root || !this.r.host.contains(root)) return null;
    const u = this.r.unitForRoot(root);
    if (u == null) return null;
    const o = offsetOfBoundary(root, c.node, c.offset);
    const len = textOf(root).length;
    // 경계 o의 뒤 글자·앞 글자 중 손가락 밑에 있는 것(딱 맞는 것 먼저, 없으면 조금 넉넉히)
    const cands = [o, o - 1].filter((i) => i >= 0 && i < len).map((i) => ({ i, rc: charRect(root, i) })).filter((k) => k.rc);
    const inside = (rc, m) => x >= rc.left - m && x <= rc.right + m && y >= rc.top - m && y <= rc.bottom + m;
    const k = cands.find((q) => inside(q.rc, 0)) || cands.find((q) => inside(q.rc, 6));
    return k ? { root, u, i: k.i } : null;
  }

  // 끄는 곳의 글자 경계(같은 구획 안으로 — 다른 구획·쪽이나 글 밖이면 이 구획의 처음·끝)
  offsetAt(root, x, y) {
    if (!root.isConnected) return null;
    const a = this.area();
    const c = caretFromPoint(clamp(x, a.left + 1, a.right - 1), clamp(y, a.top + 1, a.bottom - 1));
    if (!c) return null;
    if (root.contains(c.node)) return offsetOfBoundary(root, c.node, c.offset);
    const p = document.createRange();
    try {
      p.setStart(c.node, c.offset);
      return p.comparePoint(root, 0) > 0 ? 0 : textOf(root).length;
    } catch {
      return null;
    }
  }

  // 글자 i가 든 낱말 [처음, 끝) — 빈칸을 눌렀으면 바로 앞(없으면 뒤) 낱말
  wordAround(root, i) {
    const text = textOf(root);
    const lang = langOf(root, this.r);
    let p = pieceAt(text, i, lang);
    if (p?.kind === 'space') {
      p = pieceAt(text, p.a - 1, lang) || pieceAt(text, p.b, lang);
      if (p?.kind === 'space') p = null;
    }
    return p ? [p.a, p.b] : null;
  }

  // 글자 i가 든 낱말의 끝(dir > 0)·처음(dir < 0). 빈칸이면 빈칸은 넣지 않는다
  wordEdge(root, i, dir) {
    const text = textOf(root);
    const p = pieceAt(text, clamp(i, 0, text.length - 1), langOf(root, this.r));
    if (!p) return clamp(i, 0, text.length);
    if (p.kind === 'space') return dir > 0 ? p.a : p.b;
    return dir > 0 ? p.b : p.a;
  }
}

function charRect(root, i) {
  const r = rangeFromOffsets(root, i, i + 1);
  if (!r) return null;
  for (const rc of r.getClientRects()) if (rc.width || rc.height) return rc;
  return null;
}

function langOf(root, reader) {
  return root.closest('[lang]')?.getAttribute('lang') || reader.book?.lang || document.documentElement.lang || undefined;
}

// 낱말 나누기 — Intl.Segmenter(한국어는 띄어쓰기 단위 '내년에' 하나), 없으면 글자 종류로
const segmenters = new Map();
function segmenter(lang) {
  const key = lang || '';
  if (!segmenters.has(key)) {
    let s = null;
    try { s = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(lang || undefined, { granularity: 'word' }) : null; } catch { s = null; }
    segmenters.set(key, s);
  }
  return segmenters.get(key);
}

const WORD_CH = /[\p{L}\p{N}\p{M}_'’-]/u;

// 글자 i가 든 토막 {a, b, kind} — kind: word(낱말)·space(빈칸)·mark(문장부호 등)
function pieceAt(text, i, lang) {
  if (i < 0 || i >= text.length) return null;
  if (/\s/.test(text[i])) {
    let a = i;
    let b = i + 1;
    while (a > 0 && /\s/.test(text[a - 1])) a--;
    while (b < text.length && /\s/.test(text[b])) b++;
    return { a, b, kind: 'space' };
  }
  const seg = segmenter(lang);
  if (seg) {
    const from = Math.max(0, i - 64);
    for (const s of seg.segment(text.slice(from, Math.min(text.length, i + 64)))) {
      const a = from + s.index;
      const b = a + s.segment.length;
      if (i >= a && i < b) return { a, b, kind: s.isWordLike ? 'word' : 'mark' };
    }
  }
  if (!WORD_CH.test(text[i])) return { a: i, b: i + 1, kind: 'mark' };
  let a = i;
  let b = i + 1;
  while (a > 0 && WORD_CH.test(text[a - 1])) a--;
  while (b < text.length && WORD_CH.test(text[b])) b++;
  return { a, b, kind: 'word' };
}

// 고를 수 없게(user-select: none) 해 둔 글에서도 화면 좌표로 글자 위치를 잴 수 있나 — 크롬은 되고,
// 안 되는 브라우저는 손가락 고르기를 쓰지 않고 기본 선택으로 둔다(한 번만 재 둔다)
let caretProbe = null;
function caretOk() {
  if (caretProbe != null) return caretProbe;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;opacity:0;font:16px/20px sans-serif;white-space:nowrap;-webkit-user-select:none;user-select:none;pointer-events:auto';
  el.textContent = 'gargantua gargantua';
  document.body.append(el);
  try {
    const box = el.getBoundingClientRect();
    if (!box.width) return true; // 아직 그려지지 않음 — 정하지 않고 다음 손가락 누르기 때 다시 잰다
    const c = caretFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    caretProbe = !!(c && c.node.nodeType === 3 && el.contains(c.node) && c.offset > 0 && c.offset < el.textContent.length);
  } catch {
    caretProbe = false;
  } finally {
    el.remove();
  }
  return caretProbe;
}

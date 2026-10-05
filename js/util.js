// 공용 도구: DOM 만들기, 글자 다듬기, 시각·크기 표시, 해시, 알림
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// h('div', {class: 'x', onclick: fn}, child, '글자')
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => setTimeout(r, 0));

let lastStamp = 0;
// 기기 시각이 같은 밀리초에 두 번 찍혀도 순서가 갈리도록 늘 앞선 값보다 크게
export function now() {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}

export function uid(prefix = '') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rand[0].toString(36).slice(0, 5) + rand[1].toString(36).slice(0, 3);
}

export async function sha256Hex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const t = Date.now();
    const wait = ms - (t - last);
    if (wait <= 0) {
      last = t;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, wait);
    }
  };
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}일 전`;
  return fmtDate(ts);
}
export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
export function fmtMinutes(min) {
  if (!isFinite(min) || min <= 0) return '1분 미만';
  min = Math.round(min);
  if (min < 1) return '1분 미만';
  if (min < 60) return `${min}분`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr}시간 ${rest}분` : `${hr}시간`;
}
export function fmtCount(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}

export function fileExt(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
export function baseName(name) {
  return String(name || '').replace(/\.[A-Za-z0-9]+$/, '').trim();
}

// 공백 정리(검색·조각 표시용)
export const squash = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim();

export function snippetAround(text, start, end, radius = 48) {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  const flat = (s) => String(s).replace(/[\s ]+/g, ' ');
  return {
    before: (a > 0 ? '…' : '') + flat(text.slice(a, start)).replace(/^ /, ''),
    hit: flat(text.slice(start, end)),
    after: flat(text.slice(end, b)).replace(/ $/, '') + (b < text.length ? '…' : ''),
  };
}

// 간단한 이벤트 통로
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
};

// 화면 아래 짧은 알림
let toastEl = null;
let toastTimer = null;
export function toast(message, { action, onAction, duration = 2600 } = {}) {
  if (!toastEl) {
    toastEl = h('div', { class: 'gtoast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = '';
  toastEl.append(h('span', null, message));
  if (action && onAction) {
    toastEl.append(h('button', { class: 'gtoast-action', onclick: () => { hide(); onAction(); } }, action));
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => toastEl.classList.remove('show');
  toastTimer = setTimeout(hide, action ? Math.max(duration, 5000) : duration);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    if (multiple) input.multiple = true;
    let settled = false;
    input.addEventListener('change', () => {
      settled = true;
      resolve([...(input.files || [])]);
      input.remove();
    });
    // 취소하면 change가 오지 않는다 — 창이 다시 보일 때 정리
    window.addEventListener('focus', () => setTimeout(() => {
      if (!settled) { resolve([]); input.remove(); }
    }, 1200), { once: true });
    document.body.append(input);
    input.click();
  });
}

export const isTouch = () => matchMedia('(hover: none)').matches;
export const isWide = () => innerWidth >= 900;

// 사람이 읽는 해시 조각 → 색상(표지 타일용)
export function hueFrom(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

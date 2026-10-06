// 숫자 돌려 맞추기 — 숫자를 누르면 값 목록이 휠처럼 떠서 굴려 고른다(굴리는 대로 바로 적용).
// 숫자 위에서 마우스 휠을 굴리거나, 누른 채 위아래로 끌어도 한 칸씩 바뀐다. 키보드는 ↑↓.
import { h, clamp } from '../util.js';
import { popover, closePopovers } from './overlay.js';

const ITEM = 36; // 휠 한 칸 높이(px, CSS .gwheel-item과 같게)
const DRAG_PX = 10; // 끌 때 이만큼마다 한 칸

export function bindNumberWheel(el, { min, max, step, get, set, fmt }) {
  const snap = (v) => +clamp(min + Math.round((v - min) / step) * step, min, max).toFixed(4);
  const put = (v) => { v = snap(v); if (v !== get()) set(v); };
  el.addEventListener('wheel', (e) => { e.preventDefault(); put(get() + (e.deltaY < 0 ? step : -step)); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); put(get() + step); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); put(get() - step); }
  });
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, v: get(), moved: false };
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = (drag.y - e.clientY) + (e.clientX - drag.x); // 위·오른쪽으로 끌면 커진다
    if (!drag.moved && Math.abs(d) < 6) return;
    if (!drag.moved) { drag.moved = true; closeWheel(); el.classList.add('dragging'); }
    put(drag.v + Math.round(d / DRAG_PX) * step);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tapped = !drag.moved && e.type === 'pointerup';
    drag = null;
    el.classList.remove('dragging');
    if (tapped) toggleWheel(el, { min, max, step, get, put, fmt });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // 키보드로 누른 것(Enter·Space)
  el.addEventListener('click', (e) => { if (e.detail === 0) toggleWheel(el, { min, max, step, get, put, fmt }); });
}

let openFor = null;

function closeWheel() {
  if (!openFor) return;
  openFor = null;
  closePopovers();
}

function toggleWheel(el, { min, max, step, get, put, fmt }) {
  if (openFor === el && document.querySelector('.gwheel-pop')) { closeWheel(); return; }
  const n = Math.round((max - min) / step) + 1;
  const list = h('div', { class: 'gwheel-list', role: 'listbox', tabindex: '-1', 'aria-label': el.getAttribute('aria-label') || '' });
  for (let i = 0; i < n; i++) {
    const item = h('div', { class: 'gwheel-item', role: 'option' }, fmt(+(min + i * step).toFixed(4)));
    item.addEventListener('click', () => list.scrollTo({ top: i * ITEM, behavior: 'smooth' }));
    list.append(item);
  }
  const box = h('div', { class: 'gwheel' }, h('div', { class: 'gwheel-band' }), list);
  popover(el, box, { className: 'gwheel-pop' });
  openFor = el;
  const idxOf = (v) => clamp(Math.round((v - min) / step), 0, n - 1);
  let shown = -1;
  const mark = (i) => {
    if (i === shown) return;
    list.children[shown]?.classList.remove('on');
    list.children[i]?.classList.add('on');
    shown = i;
  };
  list.scrollTop = idxOf(get()) * ITEM;
  mark(idxOf(get()));
  let raf = 0;
  list.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = clamp(Math.round(list.scrollTop / ITEM), 0, n - 1);
      mark(i);
      put(min + i * step);
    });
  }, { passive: true });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeWheel(); el.focus(); }
  });
  list.focus({ preventScroll: true });
  // 휴대폰 '뒤로'로 창이 닫히면 휠도 닫는다
  addEventListener('popstate', closeWheel, { once: true });
}

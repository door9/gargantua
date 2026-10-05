// 아래에서 올라오는 창(휴대폰) / 가운데 창(PC), 작은 메뉴, 확인·입력 창.
// 휴대폰 '뒤로' 동작이 창을 닫도록 방문 기록에 한 칸씩 쌓는다.
import { h, esc } from '../util.js';
import { ico } from '../icons.js';

const stack = [];
let ignorePops = 0;

export function overlayCount() {
  return stack.length;
}

// Esc는 맨 위 창부터 닫는다
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.gpop')) {
    e.preventDefault();
    e.stopPropagation();
    closePopovers();
    return;
  }
  if (!stack.length) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].close();
}, true);

// 창을 닫으며 부른 '뒤로'가 끝날 때까지 기다린다(그 전에 새 주소를 쌓으면 기록이 꼬인다)
let settleWaiters = [];
export function whenHistorySettled() {
  if (ignorePops <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    settleWaiters.push(resolve);
    setTimeout(resolve, 500);
  });
}

export function handlePopState() {
  if (ignorePops > 0) {
    ignorePops--;
    if (ignorePops === 0) {
      const waiters = settleWaiters;
      settleWaiters = [];
      for (const w of waiters) w();
    }
    return true;
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    top.close({ fromHistory: true });
    return true;
  }
  return false;
}

function pushEntry(entry) {
  stack.push(entry);
  history.pushState({ g: 'overlay', n: stack.length }, '');
}

function popEntry(entry, fromHistory) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  if (!fromHistory) {
    ignorePops++;
    history.back();
  }
}

export function closeAllOverlays() {
  for (const entry of [...stack].reverse()) entry.close();
}

// sheet({ title, body, actions, wide, onClose, className, tall })
export function sheet({ title = '', body, actions = [], wide = false, tall = false, onClose, className = '', headerExtra = null, noHeader = false } = {}) {
  const backdrop = h('div', { class: 'gov-backdrop' });
  const panel = h('div', { class: `gsheet${wide ? ' wide' : ''}${tall ? ' tall' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '창' });
  const head = noHeader ? null : h('div', { class: 'gsheet-head' },
    h('div', { class: 'gsheet-grip', 'aria-hidden': 'true' }),
    h('h2', { class: 'gsheet-title' }, title),
    headerExtra,
    h('button', { class: 'gicon gsheet-close', 'aria-label': '닫기', html: ico('close'), onclick: () => close() }));
  const content = h('div', { class: 'gsheet-body' });
  if (body instanceof Node) content.append(body); else if (body != null) content.innerHTML = body;
  const foot = actions.length ? h('div', { class: 'gsheet-foot' }) : null;
  for (const a of actions) {
    foot.append(h('button', {
      class: `gbtn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
      onclick: async () => {
        if (a.onClick) {
          const keep = await a.onClick(close);
          if (keep === true) return;
        }
        close();
      },
      disabled: a.disabled,
    }, a.label));
  }
  if (head) panel.append(head);
  panel.append(content);
  if (foot) panel.append(foot);
  const wrap = h('div', { class: 'gov-wrap' }, backdrop, panel);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  backdrop.addEventListener('click', () => close());
  let closed = false;
  const entry = { close: (opts) => close(opts) };
  function close({ fromHistory = false } = {}) {
    if (closed) return;
    closed = true;
    popEntry(entry, fromHistory);
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 220);
    onClose?.();
  }
  pushEntry(entry);
  // 아래로 끌어서 닫기(휴대폰)
  if (head) enableDragClose(panel, head, close);
  const focusable = panel.querySelector('[autofocus]');
  if (focusable) setTimeout(() => focusable.focus(), 60);
  return { el: panel, body: content, close, isOpen: () => !closed };
}

function enableDragClose(panel, handle, close) {
  let startY = null;
  let dy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button')) return;
    startY = e.clientY;
    dy = 0;
    handle.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 90) close();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// 작은 메뉴: items [{label, icon, onClick, checked, danger, disabled, divider, hint}]
export function menu(anchor, items, { align = 'right', title = '' } = {}) {
  const list = h('div', { class: 'gmenu', role: 'menu' });
  if (title) list.append(h('div', { class: 'gmenu-title' }, title));
  for (const it of items) {
    if (!it) continue;
    if (it.divider) { list.append(h('div', { class: 'gmenu-div' })); continue; }
    const btn = h('button', {
      class: `gmenu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
      role: 'menuitem',
      disabled: it.disabled,
      html: `${it.icon ? ico(it.icon) : (it.checked != null ? `<span class="gmenu-radio${it.checked ? ' on' : ''}"></span>` : '<span class="gmenu-pad"></span>')}<span class="gmenu-label">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span>`,
    });
    btn.addEventListener('click', () => { close(); whenHistorySettled().then(() => it.onClick?.()); });
    list.append(btn);
  }
  const wrap = h('div', { class: 'gmenu-wrap' }, list);
  document.body.append(wrap);
  const r = anchor.getBoundingClientRect();
  const mw = list.offsetWidth;
  const mh = list.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  const entry = { close: (o) => close(o) };
  function close({ fromHistory = false } = {}) {
    if (closed) return;
    closed = true;
    popEntry(entry, fromHistory);
    wrap.remove();
  }
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('keydown', (e) => {
    const btns = [...list.querySelectorAll('.gmenu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  });
  pushEntry(entry);
  list.querySelector('.gmenu-item:not([disabled])')?.focus({ preventScroll: true });
  return { close };
}

export function confirmDialog({ title, message = '', ok = '확인', cancel = '취소', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const body = h('div', { class: 'gdialog-msg' });
    body.innerHTML = message;
    sheet({
      title,
      body,
      className: 'gdialog',
      actions: [
        { label: cancel, onClick: () => { result = false; } },
        { label: ok, primary: !danger, danger, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, value = '', placeholder = '', ok = '저장', multiline = false, maxLength = 2000, hint = '', quote = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline
      ? h('textarea', { class: 'gfield', rows: 5, placeholder, maxlength: maxLength, autofocus: true })
      : h('input', { class: 'gfield', type: 'text', placeholder, maxlength: maxLength, autofocus: true });
    input.value = value;
    const body = h('div', { class: 'gprompt-body' },
      quote ? h('blockquote', { class: 'gprompt-quote' }, quote) : null,
      input,
      hint ? h('div', { class: 'gfield-hint' }, hint) : null);
    const s = sheet({
      title,
      body,
      className: 'gdialog',
      actions: [
        { label: '취소' },
        { label: ok, primary: true, onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        result = input.value;
        s.close();
      }
    });
    setTimeout(() => {
      input.focus();
      if (!multiline) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
    }, 80);
  });
}

// 작은 말풍선(ⓘ 설명 등) — 화면 안으로 끼워 넣는다
export function popover(anchor, content, { className = '' } = {}) {
  closePopovers();
  const box = h('div', { class: `gpop ${className}` });
  if (content instanceof Node) box.append(content); else box.innerHTML = content;
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(box.offsetWidth, innerWidth - 16);
  box.style.maxWidth = `${innerWidth - 16}px`;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + box.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - box.offsetHeight - 6);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  requestAnimationFrame(() => box.classList.add('open'));
  const off = (e) => {
    if (box.contains(e.target) || anchor.contains(e.target)) return;
    closePopovers();
  };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  box._off = off;
  return box;
}

export function closePopovers() {
  for (const p of document.querySelectorAll('.gpop')) {
    if (p._off) document.removeEventListener('pointerdown', p._off, true);
    p.remove();
  }
}

// 설명은 ⓘ 하나 뒤로 접는다
export function infoButton(text) {
  const btn = h('button', { class: 'ginfo', type: 'button', 'aria-label': '설명 보기', html: ico('info') });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.querySelector('.gpop.ginfo-pop');
    if (existing && existing._anchor === btn) { closePopovers(); return; }
    const p = popover(btn, `<div class="ginfo-text">${text}</div>`, { className: 'ginfo-pop' });
    p._anchor = btn;
  });
  return btn;
}

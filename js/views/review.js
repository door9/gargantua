// 되새기기: 남겨 둔 문장을 간격을 늘려 가며 다시 만나기(간격 반복)
import { h, dayKey, toast, shuffle } from '../util.js';
import { ico } from '../icons.js';
import { state, allLiveAnns, saveRev, saveAnn, setApp } from '../store.js';
import { infoButton, menu } from '../ui/overlay.js';
import { openDoc, navigate, updateNav } from '../main.js';
import { noteEditor, noteHtml } from '../reader/actions.js';
import { annWhere } from './notes.js';

const STEPS = [1, 3, 7, 16, 35, 80, 180, 365];
const DAY = 86400000;

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d).getTime() + n * DAY + 3600000);
}

function candidates() {
  return allLiveAnns().filter((a) => a.kind === 'hl' && (a.anchor?.quote || '').trim() && !state.rev.get(a.id)?.retired);
}

function dueKeyOf(a) {
  const r = state.rev.get(a.id);
  if (r?.due) return r.due;
  return addDays(dayKey(a.createdAt || Date.now()), 1);
}

function reviewedToday() {
  const today = dayKey();
  let n = 0;
  for (const r of state.rev.values()) if (r.last === today) n++;
  return n;
}

export function dueList() {
  const today = dayKey();
  const due = candidates().filter((a) => dueKeyOf(a) <= today);
  // 오래 기다린 것부터, 같은 날이면 섞어서
  const byDay = new Map();
  for (const a of due) {
    const k = dueKeyOf(a);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(a);
  }
  const out = [];
  for (const k of [...byDay.keys()].sort()) out.push(...shuffle(byDay.get(k)));
  return out;
}

export function dueCount() {
  if (!state.ready) return 0;
  const left = Math.max(0, (state.app.reviewDaily || 10) - reviewedToday());
  return Math.min(left, dueList().length);
}

let root = null;
let queue = [];
let idx = 0;
let mode = 'due';

export async function render(container) {
  root = container;
  const more = h('button', { class: 'gicon', 'aria-label': '하루 개수', html: ico('more') });
  more.addEventListener('click', () => menu(more, [5, 10, 20, 30, 50].map((n) => ({
    label: `하루 ${n}개`, checked: (state.app.reviewDaily || 10) === n,
    onClick: () => { setApp({ reviewDaily: n }); start(); },
  })), { title: '하루에 되새길 문장 수' }));
  container.append(
    h('header', { class: 'vhead' }, h('h1', null, '되새기기'),
      infoButton('읽으며 남긴 문장을 다시 꺼내 봅니다. <b>기억남</b>을 누르면 다음 만남이 3일·7일·16일…로 멀어지고, <b>다시</b>를 누르면 내일 또 나옵니다. <b>그만</b>은 이 문장을 되새기기에서 뺍니다(하이라이트는 그대로).'),
      more),
    h('div', { class: 'vbody' }, h('div', { class: 'rv-wrap' })));
  start();
}

export function destroy() { root = null; }
export function refresh() { /* 진행 중인 카드를 갑자기 바꾸지 않는다 */ }

function wrap() {
  return root?.querySelector('.rv-wrap');
}

function start(kind = 'due') {
  mode = kind;
  const left = Math.max(0, (state.app.reviewDaily || 10) - reviewedToday());
  queue = kind === 'due' ? dueList().slice(0, left) : shuffle(candidates()).slice(0, 20);
  idx = 0;
  show();
}

function show() {
  const box = wrap();
  if (!box) return;
  box.textContent = '';
  const all = candidates();
  if (!all.length) {
    box.append(h('div', { class: 'rv-done' },
      h('div', { html: ico('sparkle', 'big') }),
      h('h2', null, '되새길 문장이 아직 없습니다'),
      h('p', null, '책을 읽다 마음에 남는 문장에 하이라이트를 남기면, 다음 날부터 여기서 다시 만납니다.'),
      h('button', { class: 'gbtn primary', onclick: () => navigate('#/library') }, '서재로')));
    return;
  }
  if (idx >= queue.length) {
    const learned = all.filter((a) => (state.rev.get(a.id)?.reps || 0) >= 2).length;
    const today = dayKey();
    const upcoming = all.filter((a) => dueKeyOf(a) > today).sort((a, b) => dueKeyOf(a).localeCompare(dueKeyOf(b)))[0];
    box.append(h('div', { class: 'rv-done' },
      h('div', { html: ico('check', 'big') }),
      h('h2', null, mode === 'due' ? '오늘의 되새기기를 마쳤습니다' : '한 바퀴 돌았습니다'),
      h('p', null, upcoming ? `다음 문장은 ${dueKeyOf(upcoming)}에 기다리고 있습니다.` : '새로 남긴 문장은 다음 날부터 나옵니다.'),
      h('div', { class: 'rv-stats' },
        h('div', { class: 'rv-stat' }, h('b', null, String(all.length)), h('small', null, '모은 문장')),
        h('div', { class: 'rv-stat' }, h('b', null, String(learned)), h('small', null, '두 번 이상 기억')),
        h('div', { class: 'rv-stat' }, h('b', null, String(reviewedToday())), h('small', null, '오늘 본 문장'))),
      h('button', { class: 'gbtn', onclick: () => start('shuffle') }, h('span', { html: ico('shuffle') }), '무작위로 더 보기')));
    updateNav();
    return;
  }
  const a = queue[idx];
  const doc = state.docs.get(a.docId);
  const rev = state.rev.get(a.id);
  const track = h('div', { class: 'pbar-track' }, h('div', { class: 'pbar-fill', style: { width: `${(idx / queue.length) * 100}%` } }));
  box.append(h('div', { class: 'rv-progress' }, h('span', null, `${idx + 1} / ${queue.length}`), track, h('span', null, mode === 'due' ? '오늘' : '무작위')));
  const card = h('article', { class: `rv-card c${a.color || 0}` },
    h('p', { class: 'rv-quote' }, a.anchor?.quote || ''),
    a.note ? h('div', { class: 'rv-note', html: noteHtml(a.note) }) : null,
    h('div', { class: 'rv-src' }, h('b', null, doc?.title || ''), annWhere(a) ? h('span', null, annWhere(a)) : null, rev?.reps ? h('span', null, `${rev.reps}번째 만남`) : h('span', null, '첫 만남')));
  const grade = async (kind) => {
    const today = dayKey();
    const r = state.rev.get(a.id) || {};
    let reps = r.reps || 0;
    let lapses = r.lapses || 0;
    let due;
    if (kind === 'again') { reps = 0; lapses++; due = addDays(today, 1); }
    else if (kind === 'good') { due = addDays(today, STEPS[Math.min(reps + 1, STEPS.length - 1)]); reps++; }
    if (kind === 'retire') await saveRev(a.id, { retired: true, last: today });
    else await saveRev(a.id, { reps, lapses, due, last: today });
    idx++;
    show();
    updateNav();
  };
  const actions = h('div', { class: 'rv-actions' },
    h('button', { class: 'gbtn', onclick: () => grade('again') }, '다시', h('small', null, '내일')),
    h('button', { class: 'gbtn primary', onclick: () => grade('good') }, '기억남', h('small', null, `${STEPS[Math.min((rev?.reps || 0) + 1, STEPS.length - 1)]}일 뒤`)),
    h('button', { class: 'gbtn', onclick: () => grade('retire') }, '그만', h('small', null, '빼기')));
  const links = h('div', { class: 'rv-links' },
    h('button', { class: 'gbtn ghost small', onclick: () => openDoc(a.docId, { ann: a.id }) }, h('span', { html: ico('library') }), '원문에서 보기'),
    h('button', { class: 'gbtn ghost small', onclick: async () => {
      const body = await noteEditor({ quote: a.anchor?.quote || '', value: a.note || '' });
      if (body == null) return;
      await saveAnn({ id: a.id, note: body.trim() });
      queue[idx] = state.anns.get(a.id);
      show();
      toast('메모를 저장했습니다.', { duration: 1200 });
    } }, h('span', { html: ico('note') }), a.note ? '메모 고치기' : '생각 덧붙이기'));
  box.append(card, actions, links);
}

// 독서 기록: 오늘·이번 주·연속 일수, 달력 열지도, 문서별 시간
import { h, dayKey, fmtMinutes, fmtCount } from '../util.js';
import { ico } from '../icons.js';
import { state, liveDocs, readingSpeed } from '../store.js';
import { infoButton } from '../ui/overlay.js';
import { openDoc } from '../main.js';

const DAY = 86400000;

// 모든 기기의 기록을 날짜별로 합친다
export function dailyTotals() {
  const days = new Map();
  const perDoc = new Map();
  for (const dev of Object.values(state.stats || {})) {
    for (const [k, v] of Object.entries(dev || {})) {
      if (k === '_u' || !v) continue;
      days.set(k, (days.get(k) || 0) + (v.s || 0));
      for (const [docId, s] of Object.entries(v.d || {})) perDoc.set(docId, (perDoc.get(docId) || 0) + s);
    }
  }
  return { days, perDoc };
}

export function todayStats() {
  const { days } = dailyTotals();
  const today = dayKey();
  let streak = 0;
  let t = Date.now();
  // 오늘 아직 안 읽었으면 어제부터 센다
  if (!(days.get(today) >= 60)) t -= DAY;
  for (;;) {
    const k = dayKey(t);
    if ((days.get(k) || 0) >= 60) { streak++; t -= DAY; } else break;
  }
  return { minutes: Math.round((days.get(today) || 0) / 60), streak };
}

let root = null;
export async function render(container) {
  root = container;
  container.append(h('header', { class: 'vhead' }, h('h1', null, '독서 기록'), infoButton('글을 읽고 있을 때(화면이 켜져 있고 1분 30초 안에 넘기거나 움직였을 때)만 시간을 셉니다. 여러 기기의 기록은 Dropbox 동기화로 합쳐집니다. 하루 1분 이상 읽으면 연속 일수에 들어갑니다.')), h('div', { class: 'vbody' }));
  fill();
}
export function destroy() { root = null; }
export function refresh() { if (root) fill(); }

function fill() {
  const body = root.querySelector('.vbody');
  body.textContent = '';
  const { days, perDoc } = dailyTotals();
  const today = todayStats();
  let week = 0;
  for (let i = 0; i < 7; i++) week += days.get(dayKey(Date.now() - i * DAY)) || 0;
  let total = 0;
  for (const v of days.values()) total += v;
  const finished = liveDocs().filter((d) => state.pos.get(d.id)?.finishedAt || state.pos.get(d.id)?.manualDone).length;
  body.append(h('div', { class: 'st-cards' },
    card('오늘', today.minutes, '분'),
    card('최근 7일', Math.round(week / 60), '분'),
    card('연속', today.streak, '일'),
    card('다 읽은 문서', finished, '권')));

  // 최근 7일 막대
  body.append(h('div', { class: 'st-section', html: `${ico('chart')} 최근 7일` }));
  const wk = h('div', { class: 'week' });
  const max7 = Math.max(60, ...Array.from({ length: 7 }, (_, i) => days.get(dayKey(Date.now() - i * DAY)) || 0));
  for (let i = 6; i >= 0; i--) {
    const t = Date.now() - i * DAY;
    const s = days.get(dayKey(t)) || 0;
    const d = new Date(t);
    wk.append(h('div', { class: i === 0 ? 'today' : '', title: `${dayKey(t)} · ${Math.round(s / 60)}분` },
      h('span', null, s ? `${Math.round(s / 60)}` : ''),
      h('i', { style: { height: `${Math.max(2, (s / max7) * 80)}px` } }),
      h('span', null, '일월화수목금토'[d.getDay()])));
  }
  body.append(wk);

  // 열지도(18주)
  body.append(h('div', { class: 'st-section', html: `${ico('flame')} 읽은 날` }));
  const heat = h('div', { class: 'heat', role: 'img', 'aria-label': '최근 18주 독서 기록' });
  const weeks = 18;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - (weeks - 1) * 7);
  for (let i = 0; i < weeks * 7; i++) {
    const t = start.getTime() + i * DAY + 3600000;
    const k = dayKey(t);
    const m = (days.get(k) || 0) / 60;
    const lvl = t > Date.now() ? 'future' : m <= 0 ? '' : m < 10 ? 'l1' : m < 30 ? 'l2' : m < 60 ? 'l3' : 'l4';
    heat.append(h('i', { class: lvl, title: `${k} · ${Math.round(m)}분` }));
  }
  body.append(heat, h('div', { class: 'heat-legend' }, '적게', ...['', 'l1', 'l2', 'l3', 'l4'].map((c) => h('i', { class: c || null })), '많이'));

  // 문서별
  const rows = [...perDoc.entries()].map(([id, s]) => ({ doc: state.docs.get(id), s })).filter((r) => r.doc && !r.doc.deleted).sort((a, b) => b.s - a.s).slice(0, 12);
  body.append(h('div', { class: 'st-section', html: `${ico('library')} 문서별 읽은 시간` }));
  if (!rows.length) body.append(h('p', { class: 'empty-note' }, '아직 기록이 없습니다. 문서를 읽으면 여기에 쌓입니다.'));
  else {
    const bars = h('div', { class: 'bars' });
    const max = rows[0].s;
    for (const r of rows) {
      bars.append(h('div', { class: 'bar-row', onclick: () => openDoc(r.doc.id) },
        h('span', { class: 't' }, r.doc.title),
        h('span', { class: 'b' }, h('i', { style: { width: `${(r.s / max) * 100}%` } })),
        h('span', { class: 'v' }, fmtMinutes(r.s / 60))));
    }
    body.append(bars);
  }
  body.append(h('p', { class: 'srch-note' }, `모두 ${fmtMinutes(total / 60)} 읽음 · 읽는 속도 분당 약 ${fmtCount(Math.round(readingSpeed('')))}자`));
}

function card(label, value, unit) {
  return h('div', { class: 'st-card' }, h('small', null, label), h('b', null, String(value)), h('span', null, unit));
}

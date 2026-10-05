// 읽기 화면의 목록 창: 목차, 하이라이트·메모, 책갈피, 읽기 설정, 문서 정보, 옆 창, 찾기 결과, 읽어주기
import { h, esc, fmtDateTime, fmtBytes, fmtMinutes, fmtCount, copyText, toast, downloadBlob, snippetAround, clamp, sleep } from '../util.js';
import { ico } from '../icons.js';
import { sheet, menu, promptDialog, infoButton } from '../ui/overlay.js';
import { state, saveAnn, saveDoc, READER_DEFAULTS, readingSpeed, getFile } from '../store.js';
import { toGlobal, fromGlobal, chapterAt } from './chapters.js';
import { pdfOutline } from '../pdfdoc.js';
import { noteEditor, citeText, noteHtml } from './actions.js';
import { exportNotesMarkdown } from '../views/notes-export.js';
import { sentenceBounds } from '../text.js';

const COLOR_NAMES = ['노랑', '민트', '분홍', '파랑'];

// ── 목차 ──
export async function showToc(r) {
  const body = h('div', { class: 'toc' });
  const s = sheet({ title: '목차', body, tall: true });
  await fillToc(r, body, () => s.close());
}

async function fillToc(r, body, done) {
  body.textContent = '';
  if (r.isPdf) {
    const jump = h('div', { class: 'toc-jump' });
    const input = h('input', { class: 'gfield', type: 'number', min: 1, max: r.pdf.numPages, placeholder: `쪽 (1–${r.pdf.numPages})`, inputmode: 'numeric' });
    const go = () => {
      const n = clamp(parseInt(input.value, 10) || 1, 1, r.pdf.numPages);
      done?.();
      r.goToLoc({ p: n - 1, y: 0 });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    jump.append(input, h('button', { class: 'gbtn', onclick: go }, '쪽으로 가기'));
    body.append(jump);
    if (!r.pdfToc) r.pdfToc = await pdfOutline(r.pdf);
    if (!r.pdfToc.length) {
      body.append(h('p', { class: 'empty-note' }, '이 PDF에는 목차(책갈피) 정보가 없습니다.'));
      return;
    }
    const cur = r.view.currentLoc()?.p ?? 0;
    let curIdx = -1;
    r.pdfToc.forEach((e, i) => { if (e.page - 1 <= cur) curIdx = i; });
    const list = h('div', { class: 'toc-list' });
    r.pdfToc.forEach((e, i) => {
      list.append(h('button', {
        class: `toc-item lv${Math.min(e.level, 4)}${i === curIdx ? ' current' : ''}`,
        onclick: () => { done?.(); r.goToLoc({ p: e.page - 1, y: 0 }); },
      }, h('span', { class: 'toc-t' }, e.title), h('span', { class: 'toc-p' }, String(e.page))));
    });
    body.append(list);
    setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);
    return;
  }
  const book = r.book;
  // 위치 이동 막대
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: Math.round((r.progress || 0) * 1000), class: 'toc-range', 'aria-label': '위치로 이동' });
  const label = h('span', { class: 'toc-range-label' }, `${Math.round((r.progress || 0) * 100)}%`);
  slider.addEventListener('input', () => { label.textContent = `${Math.round(slider.value / 10)}%`; });
  slider.addEventListener('change', () => {
    const g = Math.floor((slider.value / 1000) * Math.max(0, book.chars - 1));
    done?.();
    r.goToLoc(fromGlobal(book, g), { divided: false });
  });
  const ticks = h('div', { class: 'toc-ticks', 'aria-hidden': 'true' });
  for (const ann of r.annsOfDoc('hl')) {
    const res = r.resolve(ann);
    if (!res) continue;
    const at = toGlobal(book, res.u, res.start) / Math.max(1, book.chars);
    ticks.append(h('i', { class: `c${ann.color || 0}${ann.note ? ' n' : ''}`, style: { left: `${(at * 100).toFixed(2)}%` } }));
  }
  for (const b of r.annsOfDoc('bm')) {
    const a = b.anchor || {};
    const at = toGlobal(book, a.s || 0, a.o || 0) / Math.max(1, book.chars);
    ticks.append(h('i', { class: 'bm', style: { left: `${(at * 100).toFixed(2)}%` } }));
  }
  body.append(h('div', { class: 'toc-slider' }, h('div', { class: 'toc-track' }, slider, ticks), label));
  const entries = book.toc.length ? book.toc : r.chapters.map((c) => ({ title: c.title, level: 1, ...fromGlobal(book, c.start) }));
  if (!entries.length) {
    body.append(h('p', { class: 'empty-note' }, '이 문서에서 제목이나 목차 정보를 찾지 못했습니다.'));
    return;
  }
  const here = r.lastLoc ? toGlobal(book, r.lastLoc.s, r.lastLoc.o) : 0;
  let curIdx = -1;
  entries.forEach((e, i) => { if (toGlobal(book, e.s, e.o) <= here) curIdx = i; });
  const list = h('div', { class: 'toc-list' });
  const minLevel = Math.min(...entries.map((e) => e.level));
  entries.forEach((e, i) => {
    const g = toGlobal(book, e.s, e.o);
    list.append(h('button', {
      class: `toc-item lv${Math.min(4, e.level - minLevel + 1)}${i === curIdx ? ' current' : ''}`,
      onclick: () => { done?.(); r.goToLoc({ s: e.s, o: e.o }, { divided: true }); },
    }, h('span', { class: 'toc-t' }, e.title), h('span', { class: 'toc-p' }, `${Math.round((g / Math.max(1, book.chars)) * 100)}%`)));
  });
  body.append(list);
  setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);
}

// ── 하이라이트·메모 ──
function annLocText(r, ann) {
  return r.locLabel(ann) || '';
}

function sortAnns(r, anns) {
  return anns.sort((a, b) => {
    const ra = r.resolve(a);
    const rb = r.resolve(b);
    const ka = ra ? (r.isPdf ? ra.u * 1e7 + ra.start : toGlobal(r.book, ra.u, ra.start)) : Infinity;
    const kb = rb ? (r.isPdf ? rb.u * 1e7 + rb.start : toGlobal(r.book, rb.u, rb.start)) : Infinity;
    return ka - kb || a.createdAt - b.createdAt;
  });
}

export function annList(r, { filter = 'all', onPick } = {}) {
  let anns = r.annsOfDoc('hl');
  if (filter === 'notes') anns = anns.filter((a) => a.note);
  else if (/^c\d$/.test(filter)) anns = anns.filter((a) => (a.color || 0) === Number(filter[1]));
  sortAnns(r, anns);
  const list = h('div', { class: 'ann-list' });
  if (!anns.length) {
    list.append(h('p', { class: 'empty-note' }, filter === 'all' ? '글을 길게 눌러(또는 끌어) 선택한 뒤 하이라이트나 메모를 남겨 보세요.' : '해당하는 항목이 없습니다.'));
    return list;
  }
  for (const ann of anns) {
    const resolved = r.resolve(ann);
    const item = h('div', { class: `ann-item c${ann.color || 0}${resolved ? '' : ' orphan'}` });
    const main = h('button', { class: 'ann-main', onclick: () => { onPick?.(); r.jumpToAnn(ann.id); } },
      h('span', { class: 'ann-quote' }, ann.anchor?.quote || ''),
      ann.note ? h('span', { class: 'ann-note', html: noteHtml(ann.note) }) : null,
      h('span', { class: 'ann-meta' }, resolved ? annLocText(r, ann) : '본문에서 위치를 찾지 못함'));
    const more = h('button', { class: 'gicon', 'aria-label': '더보기', html: ico('more') });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      menu(more, [
        { label: ann.note ? '메모 수정' : '메모 쓰기', icon: 'note', onClick: async () => {
          const body = await noteEditor({ quote: ann.anchor?.quote || '', value: ann.note || '' });
          if (body == null) return;
          await saveAnn({ id: ann.id, note: body.trim() });
          r.refreshAnns();
        } },
        ...COLOR_NAMES.map((name, i) => ({ label: `${name}으로`, checked: (ann.color || 0) === i, onClick: async () => { await saveAnn({ id: ann.id, color: i }); r.refreshAnns(); } })),
        { divider: true },
        { label: '인용 복사', icon: 'quote', onClick: async () => { if (await copyText(citeText(r.doc, ann, annLocText(r, ann)))) toast('복사했습니다.', { duration: 1000 }); } },
        { label: '삭제', icon: 'trash', danger: true, onClick: () => r.deleteAnn(ann) },
      ]);
    });
    item.append(main, more);
    list.append(item);
  }
  return list;
}

export function showAnnotations(r) {
  let filter = 'all';
  const holder = h('div');
  const chips = h('div', { class: 'chips' });
  let s;
  const render = () => {
    chips.textContent = '';
    const all = r.annsOfDoc('hl');
    const opts = [['all', `전체 ${all.length}`], ['notes', `메모 ${all.filter((a) => a.note).length}`]];
    for (const [key, label] of opts) chips.append(h('button', { class: `gchip${filter === key ? ' on' : ''}`, onclick: () => { filter = key; render(); } }, label));
    COLOR_NAMES.forEach((name, i) => chips.append(h('button', { class: `gchip dot c${i}${filter === `c${i}` ? ' on' : ''}`, 'aria-label': name, onclick: () => { filter = filter === `c${i}` ? 'all' : `c${i}`; render(); } })));
    holder.replaceChildren(annList(r, { filter, onPick: () => s.close() }));
  };
  const exportBtn = h('button', { class: 'gicon', 'aria-label': '내보내기', title: '이 문서 노트 내보내기', html: ico('upload') });
  exportBtn.addEventListener('click', () => exportDocNotes(r, exportBtn));
  s = sheet({ title: '하이라이트 · 메모', body: h('div', null, chips, holder), tall: true, headerExtra: exportBtn });
  render();
  const off = () => render();
  r.annSheetRefresh = off;
}

function exportDocNotes(r, anchor) {
  const anns = sortAnns(r, r.annsOfDoc('hl'));
  const md = exportNotesMarkdown([{ doc: r.doc, anns, where: (a) => annLocText(r, a) }]);
  menu(anchor, [
    { label: 'Markdown으로 복사', icon: 'copy', onClick: async () => { if (await copyText(md)) toast('복사했습니다.'); } },
    { label: 'Markdown 파일로 저장', icon: 'download', onClick: () => downloadBlob(new Blob([md], { type: 'text/markdown' }), `${r.doc.title} - 노트.md`) },
  ]);
}

// ── 책갈피 ──
export function bookmarkList(r, { onPick } = {}) {
  const list = h('div', { class: 'bm-list' });
  const bms = r.bookmarks();
  if (!bms.length) {
    list.append(h('p', { class: 'empty-note' }, '저장된 책갈피가 없습니다. 위쪽 책갈피 단추로 지금 위치를 표시하세요.'));
    return list;
  }
  bms.forEach((b, i) => {
    const a = b.anchor || {};
    const where = r.isPdf ? `${(a.p || 0) + 1}쪽` : `${Math.round((toGlobal(r.book, a.s || 0, a.o || 0) / Math.max(1, r.book.chars)) * 100)}%`;
    list.append(h('div', { class: 'bm-item' },
      h('button', { class: 'bm-main', onclick: () => { onPick?.(); r.jumpToAnn(b.id); } },
        h('span', { class: 'bm-t' }, `책갈피 ${i + 1} · ${where}`),
        b.snippet ? h('span', { class: 'bm-s' }, b.snippet) : null,
        h('span', { class: 'bm-d' }, fmtDateTime(b.createdAt))),
      h('button', { class: 'gicon', 'aria-label': '책갈피 삭제', html: ico('trash'), onclick: () => r.deleteAnn(b) })));
  });
  return list;
}

export function showBookmarks(r) {
  let s;
  const body = h('div');
  const render = () => body.replaceChildren(bookmarkList(r, { onPick: () => s.close() }));
  s = sheet({ title: '책갈피', body, tall: true });
  render();
}

// ── 옆 창(PC) ──
export function renderSide(r) {
  const side = r.side;
  const tab = r.sideTab || 'toc';
  side.textContent = '';
  const tabs = h('div', { class: 'side-tabs', role: 'tablist' });
  for (const [key, label] of [['toc', '목차'], ['notes', '노트'], ['bm', '책갈피']]) {
    tabs.append(h('button', { class: `side-tab${tab === key ? ' on' : ''}`, role: 'tab', onclick: () => { r.sideTab = key; renderSide(r); } }, label));
  }
  const content = h('div', { class: 'side-body' });
  side.append(tabs, content);
  if (tab === 'toc') {
    const box = h('div', { class: 'toc' });
    content.append(box);
    fillToc(r, box, null);
  } else if (tab === 'notes') {
    content.append(annList(r, {}));
  } else {
    content.append(bookmarkList(r, {}));
  }
}

// ── 찾기 결과 목록 ──
export function showFindList(r) {
  const f = r.find;
  if (!f || !f.hits.length) { toast('찾은 결과가 없습니다.'); return; }
  const list = h('div', { class: 'find-list' });
  let s;
  const max = Math.min(f.hits.length, 400);
  for (let i = 0; i < max; i++) {
    const hit = f.hits[i];
    const text = r.unitText(hit.u) || '';
    const sn = snippetAround(text, hit.start, hit.end, 40);
    const where = r.isPdf ? `${hit.u + 1}쪽` : `${Math.round((toGlobal(r.book, hit.u, hit.start) / Math.max(1, r.book.chars)) * 100)}%`;
    list.append(h('button', { class: `find-item${i === f.i ? ' current' : ''}`, onclick: () => { s.close(); r.goToHit(i); } },
      h('span', { class: 'find-where' }, where),
      h('span', { class: 'find-snip', html: `${esc(sn.before)}<mark>${esc(sn.hit)}</mark>${esc(sn.after)}` })));
  }
  if (f.hits.length > max) list.append(h('p', { class: 'empty-note' }, `처음 ${max}개만 보여 줍니다.`));
  s = sheet({ title: `“${f.q}” ${fmtCount(f.hits.length)}곳`, body: list, tall: true });
  setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);
}

// ── 읽기 설정 ──
export function showSettings(r) {
  const body = h('div', { class: 'rset' });
  const st = () => state.reader;
  const seg = (label, key, options) => {
    const row = h('div', { class: 'rset-row' }, h('span', { class: 'rset-label' }, label));
    const group = h('div', { class: 'seg', role: 'radiogroup' });
    for (const [value, text] of options) {
      group.append(h('button', {
        class: `seg-btn${st()[key] === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(st()[key] === value),
        onclick: () => { r.applySettings({ [key]: value }); render(); },
      }, text));
    }
    row.append(group);
    return row;
  };
  const slider = (label, key, min, max, step, fmt) => {
    const value = st()[key];
    const out = h('span', { class: 'rset-val' }, fmt(value));
    const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    const set = (v) => {
      v = clamp(Math.round(v / step) * step, min, max);
      v = +v.toFixed(3);
      input.value = v;
      out.textContent = fmt(v);
      r.applySettings({ [key]: v });
    };
    input.addEventListener('input', () => set(parseFloat(input.value)));
    return h('div', { class: 'rset-row slider' },
      h('span', { class: 'rset-label' }, label),
      h('button', { class: 'gicon small', 'aria-label': `${label} 줄이기`, html: '−', onclick: () => set(parseFloat(input.value) - step) }),
      input,
      h('button', { class: 'gicon small', 'aria-label': `${label} 늘리기`, html: '+', onclick: () => set(parseFloat(input.value) + step) }),
      out);
  };
  const toggle = (label, key, hint) => {
    const id = `t-${key}`;
    const input = h('input', { type: 'checkbox', id, class: 'switch' });
    input.checked = st()[key] !== false;
    input.addEventListener('change', () => r.applySettings({ [key]: input.checked }));
    return h('div', { class: 'rset-row' }, h('label', { class: 'rset-label', for: id }, label, hint ? h('small', null, hint) : null), input);
  };
  const render = () => {
    body.textContent = '';
    body.append(
      seg('배경', 'palette', [['paper', '종이'], ['sepia', '세피아'], ['night', '야간']]),
      seg('글꼴', 'typeface', [['serif', '명조'], ['sans', '고딕']]),
      slider('글자 크기', 'fontSize', 12, 32, 0.5, (v) => v.toFixed(1)),
      slider('줄 간격', 'lineHeight', 1.2, 2.4, 0.02, (v) => v.toFixed(2)),
      slider('좌우 여백', 'margin', 8, 64, 1, (v) => String(Math.round(v))),
    );
    if (!r.isPdf) {
      body.append(
        slider('문단 간격', 'paraGap', 0, 1.6, 0.05, (v) => v.toFixed(2)),
        slider('들여쓰기', 'indent', 0, 2, 0.5, (v) => v.toFixed(1)),
        slider('본문 폭', 'maxWidth', 420, 1200, 10, (v) => String(Math.round(v))),
        seg('정렬', 'align', [['justify', '양쪽'], ['left', '왼쪽']]),
        seg('한글 줄바꿈', 'keepAll', [[false, '글자 단위'], [true, '낱말 단위']]),
        toggle('영어 낱말 하이픈', 'hyphens'),
        h('div', { class: 'rset-sub' }, '전자책 보기'),
        toggle('책 원래 서식', 'bookStyle'),
        seg('두 쪽 펼침', 'spread', [['auto', '자동'], ['on', '항상'], ['off', '안 함']]),
        toggle('쪽 넘김 움직임', 'pageAnim'),
      );
    } else {
      body.append(toggle('야간에 PDF 색 반전', 'pdfInvert'));
    }
    body.append(h('div', { class: 'rset-foot' }, h('button', {
      class: 'gbtn ghost small',
      onclick: () => {
        const { fontSize, lineHeight, margin, maxWidth, paraGap, indent, align, keepAll, hyphens, bookStyle, spread, pageAnim } = READER_DEFAULTS;
        r.applySettings({ fontSize, lineHeight, margin, maxWidth, paraGap, indent, align, keepAll, hyphens, bookStyle, spread, pageAnim });
        render();
      },
    }, '기본값으로')));
  };
  render();
  sheet({ title: '읽기 설정', body, className: 'rset-sheet' });
}

// ── 문서 정보 ──
export async function showInfo(r) {
  const d = r.doc;
  const info = state.info.get(d.id) || {};
  let secs = 0;
  for (const dev of Object.values(state.stats)) for (const [k, day] of Object.entries(dev)) if (k !== '_u' && day?.d?.[d.id]) secs += day.d[d.id];
  const anns = r.annsOfDoc('hl');
  const rows = [
    ['형식', d.format.toUpperCase()],
    ['파일', d.fileName || '-'],
    ['크기', fmtBytes(d.fileSize)],
    r.isPdf ? ['쪽 수', `${fmtCount(r.pdf.numPages)}쪽`] : ['글자 수', `${fmtCount(r.book.chars)}자`],
    d.author ? ['지은이', d.author] : null,
    ['등록', fmtDateTime(d.addedAt)],
    ['읽은 시간', secs ? fmtMinutes(secs / 60) : '-'],
    !r.isPdf ? ['읽는 속도', `분당 약 ${fmtCount(Math.round(readingSpeed(d.id)))}자${info.speed && info.speed.s > 300 ? '' : ' (추정)'}`] : null,
    !r.isPdf ? ['남은 시간', fmtMinutes((r.book.chars * (1 - (r.progress || 0))) / readingSpeed(d.id))] : null,
    ['하이라이트', `${anns.length}개 (메모 ${anns.filter((a) => a.note).length})`],
    ['책갈피', `${r.annsOfDoc('bm').length}개`],
  ].filter(Boolean);
  const table = h('div', { class: 'info-table' });
  for (const [k, v] of rows) table.append(h('div', { class: 'info-k' }, k), h('div', { class: 'info-v' }, v));
  const body = h('div', null,
    h('div', { class: 'info-title' }, d.title),
    table,
    h('div', { class: 'info-actions' },
      h('button', { class: 'gbtn small', onclick: async () => {
        const name = await promptDialog({ title: '문서 이름 바꾸기', value: d.title, maxLength: 120 });
        if (name == null || !name.trim()) return;
        await saveDoc({ id: d.id, title: name.trim() });
        r.doc = state.docs.get(d.id);
        r.root.querySelector('.rd-title-text').textContent = r.doc.title;
        s.close();
      } }, '이름 바꾸기'),
      h('button', { class: 'gbtn small', onclick: async () => {
        const blob = await getFile(d.fileHash);
        if (blob) downloadBlob(blob, d.fileName || `${d.title}.${d.format}`); else toast('이 기기에 원본이 없습니다.');
      } }, '원본 파일 저장')));
  const s = sheet({ title: '문서 정보', body });
}

// ── 읽어주기 ──
export function toggleSpeech(r) {
  if (r.tts) stopSpeech(r); else startSpeech(r);
}

export function stopSpeech(r) {
  if (!r.tts) return;
  r.tts.stopped = true;
  speechSynthesis.cancel();
  r.painter.remove('tts');
  r.tts.bar?.remove();
  r.tts = null;
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const want = (lang || 'ko').slice(0, 2);
  return voices.find((v) => v.lang?.toLowerCase().startsWith(want) && /google|natural|online/i.test(v.name))
    || voices.find((v) => v.lang?.toLowerCase().startsWith(want)) || null;
}

function startSpeech(r) {
  const loc = r.view.currentLoc();
  if (!loc) return;
  const rate = state.reader.ttsRate || 1;
  r.tts = { u: loc.s, pos: loc.o, rate, paused: false };
  const playBtn = h('button', { class: 'gicon', 'aria-label': '일시정지', html: ico('pause') });
  const rateOut = h('span', { class: 'tts-rate' }, `${rate.toFixed(1)}×`);
  const setRate = (v) => {
    r.tts.rate = clamp(+(v).toFixed(1), 0.6, 2.4);
    rateOut.textContent = `${r.tts.rate.toFixed(1)}×`;
    state.reader.ttsRate = r.tts.rate;
  };
  const bar = h('div', { class: 'tts-bar' },
    h('span', { class: 'tts-label', html: `${ico('speaker')} 읽어주기` }),
    playBtn,
    h('button', { class: 'gicon small', 'aria-label': '느리게', html: '−', onclick: () => setRate(r.tts.rate - 0.1) }),
    rateOut,
    h('button', { class: 'gicon small', 'aria-label': '빠르게', html: '+', onclick: () => setRate(r.tts.rate + 0.1) }),
    h('button', { class: 'gicon', 'aria-label': '멈춤', html: ico('stop'), onclick: () => stopSpeech(r) }));
  playBtn.addEventListener('click', () => {
    if (!r.tts) return;
    if (r.tts.paused) {
      r.tts.paused = false;
      playBtn.innerHTML = ico('pause');
      speakNext(r);
    } else {
      r.tts.paused = true;
      playBtn.innerHTML = ico('play');
      speechSynthesis.cancel();
    }
  });
  r.tts.bar = bar;
  r.root.append(bar);
  speakNext(r);
}

async function speakNext(r) {
  const t = r.tts;
  if (!t || t.paused || t.stopped) return;
  let text = r.texts[t.u] || '';
  while (t.pos >= text.length || !text.slice(t.pos).trim()) {
    t.u++;
    t.pos = 0;
    if (t.u >= r.texts.length) { stopSpeech(r); toast('끝까지 읽었습니다.'); return; }
    text = r.texts[t.u] || '';
  }
  while (t.pos < text.length && /\s/.test(text[t.pos])) t.pos++;
  let { end } = sentenceBounds(text, t.pos);
  if (end - t.pos > 300) {
    const cut = text.slice(t.pos, t.pos + 300).search(/[,，、]\s|\s(?=\S*$)/);
    end = t.pos + (cut > 60 ? cut + 1 : 300);
  }
  const start = t.pos;
  const chunk = text.slice(start, end).trim();
  t.pos = end;
  if (!chunk) { speakNext(r); return; }
  const loc = { s: t.u, o: start };
  if (!r.view.contains(loc)) await r.goToLoc(loc);
  const range = r.view.rangeAt(t.u, start, Math.min(end, text.length));
  if (range) {
    r.painter.add('tts', 'g-tts', range);
    r.view.scrollRangeIntoView(range);
  }
  const u = new SpeechSynthesisUtterance(chunk);
  const lang = r.book.sections[t.u]?.lang || r.book.lang || 'ko';
  u.lang = lang.startsWith('en') ? 'en-US' : lang.startsWith('ko') ? 'ko-KR' : lang;
  const v = pickVoice(u.lang);
  if (v) u.voice = v;
  u.rate = t.rate;
  u.onend = () => { if (r.tts === t && !t.paused) speakNext(r); };
  u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled' && r.tts === t) { stopSpeech(r); toast('읽어주기를 할 수 없습니다.'); } };
  speechSynthesis.speak(u);
}

export { sleep };

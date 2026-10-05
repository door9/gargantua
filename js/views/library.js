// 서재: 이어 읽기, 오늘의 문장, 문서 목록(목록·표지), 가져오기
import { h, esc, fmtDateTime, fmtMinutes, toast, pickFiles, downloadBlob, hueFrom, dayKey } from '../util.js';
import { ico } from '../icons.js';
import { state, liveDocs, liveAnns, allLiveAnns, setApp, removeDoc, saveDoc, savePos, readingSpeed, localFileHashes, getFile } from '../store.js';
import { menu, confirmDialog, promptDialog, sheet, infoButton } from '../ui/overlay.js';
import { navigate, openDoc, runImport } from '../main.js';
import { ACCEPT, FORMATS } from '../parse/index.js';
import { coverUrlCache } from '../docs.js';
import { syncStatus, onSyncStatus } from '../sync/sync.js';
import { todayStats } from './stats.js';
import { showAndroidImport } from './settings.js';

const covers = coverUrlCache();
let root = null;
let listBox = null;
let query = '';
let offStatus = null;

export function coverEl(doc, cls = '') {
  const url = covers.get(doc.id);
  if (url) {
    const el = h('div', { class: `cover ${cls}`, role: 'img', 'aria-label': `${doc.title} 표지` });
    el.style.backgroundImage = `url("${url}")`;
    return el;
  }
  const el = h('div', { class: `cover gen ${cls}`, 'aria-hidden': 'true' },
    h('span', { class: 'cv-t' }, doc.title || ''),
    h('span', { class: 'cv-f' }, FORMATS[doc.format]?.label || ''));
  el.style.setProperty('--h', String(hueFrom(doc.title || doc.id)));
  return el;
}

function progressOf(doc) {
  return state.pos.get(doc.id)?.progress || 0;
}
// 다 읽음: 직접 표시했거나, 지금 위치가 끝에 있을 때(다시 읽기 시작하면 진도가 보인다)
export function isFinished(doc) {
  const p = state.pos.get(doc.id);
  return !!p?.manualDone || (p?.progress || 0) >= 0.985;
}
function lastOpened(doc) {
  return state.pos.get(doc.id)?.openedAt || doc.lastOpenedAt || 0;
}

function pbar(doc) {
  const p = progressOf(doc);
  const done = isFinished(doc);
  return h('div', { class: 'pbar' },
    h('div', { class: 'pbar-track' }, h('div', { class: `pbar-fill${done ? ' done' : ''}`, style: { width: `${Math.round(p * 1000) / 10}%` } })),
    h('span', { class: 'pbar-num' }, done ? '완독' : `${Math.round(p * 100)}%`));
}

function remainText(doc) {
  const info = state.info.get(doc.id);
  if (!info?.chars) return info?.pages ? `${info.pages}쪽` : '';
  const left = info.chars * (1 - progressOf(doc));
  return `남은 약 ${fmtMinutes(left / readingSpeed(doc.id))}`;
}

export async function render(container) {
  root = container;
  const head = h('header', { class: 'vhead' },
    h('div', { class: 'brand' }, h('b', null, 'GARGANTUA'), h('small', null, 'BEYOND THE EVENT HORIZON')),
    h('h1', { class: 'pc-title' }, '서재'),
    syncButton(),
    h('button', { class: 'gbtn primary add-btn', onclick: () => importPicker() }, h('span', { html: ico('import') }), '문서 추가'));
  const body = h('div', { class: 'vbody' });
  listBox = body;
  container.append(head, body);
  if (!document.querySelector('.fab')) {
    document.getElementById('app-view').append(h('button', { class: 'fab', onclick: () => importPicker() }, h('span', { html: ico('import') }), '문서 추가'));
  }
  fill();
}

export function destroy() {
  document.querySelector('.fab')?.remove();
  offStatus?.();
  offStatus = null;
  root = null;
}

export function refresh() {
  if (root) fill();
}

function syncButton() {
  const btn = h('button', { class: 'gicon sync-btn', 'aria-label': 'Dropbox 동기화', onclick: () => navigate('#/settings') });
  const paint = () => {
    const s = syncStatus();
    btn.classList.toggle('busy', s.state === 'busy');
    btn.classList.toggle('err', s.state === 'error');
    btn.classList.toggle('off', s.state === 'off');
    btn.innerHTML = ico(s.state === 'off' ? 'cloudOff' : s.state === 'busy' ? 'sync' : 'cloud');
    btn.title = s.label || '';
  };
  paint();
  offStatus?.();
  offStatus = onSyncStatus(paint);
  return btn;
}

export async function importPicker() {
  const files = await pickFiles({ accept: ACCEPT, multiple: true });
  if (files.length) runImport(files);
}

async function fill() {
  const docs = liveDocs();
  const box = listBox;
  if (!box) return;
  const scrollY = window.scrollY;
  const prevFocus = document.activeElement?.classList?.contains('lib-search') ? document.activeElement.selectionStart : null;
  box.textContent = '';
  if (!docs.length) {
    box.append(emptyState());
    return;
  }
  const local = await localFileHashes();
  const today = todayStats();
  const stats = h('div', { class: 'lib-today' },
    h('button', { class: 'lib-stat', onclick: () => navigate('#/stats') }, h('span', { html: ico('clock') }), `오늘 ${today.minutes}분`),
    today.streak > 0 ? h('button', { class: 'lib-stat', onclick: () => navigate('#/stats') }, h('span', { html: ico('flame') }), `${today.streak}일 연속`) : null,
    h('span', { class: 'lib-stat' }, h('span', { html: ico('library') }), `${docs.length}권`));
  box.append(stats);

  // 이어 읽기
  const recent = docs.filter((d) => lastOpened(d) && !isFinished(d)).sort((a, b) => lastOpened(b) - lastOpened(a))[0];
  if (recent && !query) {
    const hero = h('div', { class: 'hero', role: 'button', tabindex: '0', onclick: () => openDoc(recent.id), onkeydown: (e) => { if (e.key === 'Enter') openDoc(recent.id); } },
      coverEl(recent),
      h('div', { class: 'hero-main' },
        h('div', { class: 'hero-kicker' }, '이어 읽기'),
        h('div', { class: 'hero-title' }, recent.title),
        h('div', { class: 'hero-sub' }, [recent.author, remainText(recent)].filter(Boolean).join(' · ')),
        pbar(recent)));
    box.append(hero);
  }

  // 오늘의 문장(하이라이트 하나를 날마다 바꿔 보여 준다)
  const quote = todaysQuote();
  if (quote && !query) {
    const doc = state.docs.get(quote.docId);
    box.append(h('div', { class: 'quote-card', role: 'button', tabindex: '0', onclick: () => navigate('#/review'), onkeydown: (e) => { if (e.key === 'Enter') navigate('#/review'); } },
      h('div', { class: 'quote-kicker', html: `${ico('sparkle')} 오늘의 문장` }),
      h('div', { class: 'quote-text' }, quote.anchor?.quote || ''),
      h('div', { class: 'quote-src' }, `— ${doc?.title || ''}`)));
  }

  // 도구 줄
  const search = h('input', { class: 'gfield lib-search', type: 'search', placeholder: '제목·지은이로 찾기', value: query });
  search.addEventListener('input', () => { query = search.value; renderList(); });
  const filters = [['all', '전체'], ['reading', '읽는 중'], ['unread', '안 읽음'], ['done', '다 읽음']];
  const chips = h('div', { class: 'chips' });
  for (const [key, label] of filters) {
    chips.append(h('button', { class: `gchip${state.app.libraryFilter === key ? ' on' : ''}`, onclick: () => { setApp({ libraryFilter: key }); fill(); } }, label));
  }
  const sortLabels = { recent: '최근 읽은 순', added: '추가한 순', title: '제목 순', progress: '진도 순' };
  const sortBtn = h('button', { class: 'gicon', 'aria-label': `정렬: ${sortLabels[state.app.librarySort]}`, title: sortLabels[state.app.librarySort], html: ico('sort') });
  sortBtn.addEventListener('click', () => menu(sortBtn, Object.entries(sortLabels).map(([k, label]) => ({ label, checked: state.app.librarySort === k, onClick: () => { setApp({ librarySort: k }); fill(); } }))));
  const viewBtn = h('button', { class: 'gicon', 'aria-label': state.app.libraryView === 'grid' ? '목록으로 보기' : '표지로 보기', html: ico(state.app.libraryView === 'grid' ? 'list' : 'grid'), onclick: () => { setApp({ libraryView: state.app.libraryView === 'grid' ? 'list' : 'grid' }); fill(); } });
  box.append(h('div', { class: 'lib-tools' }, h('div', { class: 'search-box', html: ico('search') }, search), sortBtn, viewBtn), h('div', { class: 'lib-tools' }, chips));
  const list = h('div');
  box.append(list);

  function renderList() {
    list.textContent = '';
    let shown = docs;
    const f = state.app.libraryFilter;
    if (f === 'reading') shown = shown.filter((d) => progressOf(d) > 0 && !isFinished(d));
    else if (f === 'unread') shown = shown.filter((d) => !progressOf(d) && !lastOpened(d));
    else if (f === 'done') shown = shown.filter((d) => isFinished(d));
    const q = query.trim().toLowerCase();
    if (q) shown = shown.filter((d) => `${d.title} ${d.author || ''} ${d.fileName || ''}`.toLowerCase().includes(q));
    const sort = state.app.librarySort;
    shown = [...shown].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'ko');
      if (sort === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
      if (sort === 'progress') return progressOf(b) - progressOf(a);
      return (lastOpened(b) || b.addedAt || 0) - (lastOpened(a) || a.addedAt || 0);
    });
    if (!shown.length) {
      list.append(h('p', { class: 'empty-note' }, '조건에 맞는 문서가 없습니다.'));
      return;
    }
    if (state.app.libraryView === 'grid') {
      const grid = h('div', { class: 'doc-grid' });
      for (const d of shown) grid.append(tile(d, local));
      list.append(grid);
    } else {
      const lst = h('div', { class: 'doc-list' });
      for (const d of shown) lst.append(card(d, local));
      list.append(lst);
    }
  }
  renderList();
  if (prevFocus != null) { search.focus(); search.setSelectionRange(prevFocus, prevFocus); }
  window.scrollTo(0, scrollY);
}

function card(d, local) {
  const hl = liveAnns(d.id).filter((a) => a.kind === 'hl');
  const notes = hl.filter((a) => a.note).length;
  const cv = coverEl(d);
  if (!local.has(d.fileHash)) cv.append(h('span', { class: 'cloud-chip', title: '원본이 아직 이 기기에 없음(열면 받아 옴)', html: ico('cloudDown') }));
  const more = h('button', { class: 'gicon', 'aria-label': '문서 메뉴', html: ico('more') });
  more.addEventListener('click', (e) => { e.stopPropagation(); docMenu(more, d); });
  return h('div', { class: 'doc-card', role: 'button', tabindex: '0', onclick: () => openDoc(d.id), onkeydown: (e) => { if (e.key === 'Enter') openDoc(d.id); } },
    cv,
    h('div', { class: 'doc-main' },
      h('div', { class: 'doc-title' }, d.title),
      d.author ? h('div', { class: 'doc-author' }, d.author) : null,
      h('div', { class: 'doc-meta', html: `등록 <b>${esc(fmtDateTime(d.addedAt))}</b> │ 열람 <b>${esc(lastOpened(d) ? fmtDateTime(lastOpened(d)) : '-')}</b>${hl.length ? `<span class="doc-badges">${ico('highlight')} ${hl.length}${notes ? ` ${ico('note')} ${notes}` : ''}</span>` : ''}` }),
      pbar(d)),
    more);
}

function tile(d, local) {
  const cv = coverEl(d);
  if (!local.has(d.fileHash)) cv.append(h('span', { class: 'cloud-chip', html: ico('cloudDown') }));
  const el = h('div', { class: 'doc-tile', role: 'button', tabindex: '0', onclick: () => openDoc(d.id), onkeydown: (e) => { if (e.key === 'Enter') openDoc(d.id); } },
    cv, h('div', { class: 'doc-title' }, d.title), pbar(d));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); docMenu(el, d); });
  let t = null;
  el.addEventListener('pointerdown', () => { t = setTimeout(() => { t = null; docMenu(el, d); }, 600); });
  el.addEventListener('pointerup', () => clearTimeout(t));
  el.addEventListener('pointerleave', () => clearTimeout(t));
  return el;
}

function docMenu(anchor, d) {
  const finished = isFinished(d);
  menu(anchor, [
    { label: '열기', icon: 'library', onClick: () => openDoc(d.id) },
    { label: '이 문서의 노트', icon: 'notes', onClick: () => navigate(`#/notes?doc=${encodeURIComponent(d.id)}`) },
    { label: '이름 바꾸기', icon: 'edit', onClick: async () => {
      const name = await promptDialog({ title: '문서 이름 바꾸기', value: d.title, maxLength: 120 });
      if (name == null) return;
      if (!name.trim()) { toast('문서 이름은 비워 둘 수 없습니다.'); return; }
      await saveDoc({ id: d.id, title: name.trim() });
      toast('이름을 바꿨습니다.', { duration: 1200 });
    } },
    { label: finished ? '다 읽음 표시 해제' : '다 읽음으로 표시', icon: 'check', onClick: () => {
      savePos(d.id, finished ? { manualDone: false, progress: Math.min(progressOf(d), 0.98) } : { manualDone: true, finishedAt: state.pos.get(d.id)?.finishedAt || Date.now() }, { immediate: true });
      fill();
    } },
    { label: '원본 파일 저장', icon: 'download', onClick: async () => {
      const blob = await getFile(d.fileHash);
      if (!blob) { toast('이 기기에 원본이 없습니다. 먼저 문서를 열어 받아 오세요.'); return; }
      downloadBlob(blob, d.fileName || `${d.title}.${d.format}`);
    } },
    { divider: true },
    { label: '서재에서 삭제', icon: 'trash', danger: true, onClick: async () => {
      const n = liveAnns(d.id).length;
      const ok = await confirmDialog({
        title: '서재에서 삭제할까요?',
        message: `<p>“${esc(d.title)}”의 보관 사본과 읽기 기록${n ? `, 하이라이트·메모·책갈피 ${n}개` : ''}가 삭제됩니다.</p><p>원래 파일(기기·드라이브에 있는 것)은 지워지지 않습니다.</p>`,
        ok: '삭제', danger: true,
      });
      if (!ok) return;
      await removeDoc(d.id);
      toast('삭제했습니다.');
    } },
  ]);
}

function emptyState() {
  return h('div', { class: 'lib-empty' },
    h('div', { class: 'boot-mark' }, h('span', null, 'G')),
    h('h2', null, '첫 문서를 펼쳐보세요'),
    h('p', null, 'TXT, Markdown, DOCX, PDF, EPUB 파일을 읽기 편한 화면으로 보여 드립니다.'),
    h('div', { class: 'actions' },
      h('button', { class: 'gbtn primary block', onclick: () => importPicker() }, h('span', { html: ico('import') }), '문서 가져오기'),
      h('button', { class: 'gbtn block', onclick: () => showAndroidImport() }, h('span', { html: ico('phone') }), '안드로이드 앱 서재 가져오기'),
      h('button', { class: 'gbtn ghost block', onclick: () => navigate('#/settings') }, h('span', { html: ico('cloud') }), 'Dropbox 연결')));
}

export function todaysQuote() {
  const anns = allLiveAnns().filter((a) => a.kind === 'hl' && (a.anchor?.quote || '').trim().length >= 12);
  if (!anns.length) return null;
  anns.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
  let seed = 0;
  for (const ch of dayKey()) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return anns[seed % anns.length];
}

export { infoButton, sheet };

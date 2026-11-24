// 서재: 이어 읽기, 오늘의 문장, 문서 목록(목록·표지), 가져오기, 카테고리(문서 묶음)
import { h, esc, fmtDateTime, fmtMinutes, toast, pickFiles, downloadBlob, hueFrom, dayKey } from '../util.js';
import { ico } from '../icons.js';
import { state, liveDocs, liveAnns, allLiveAnns, setApp, removeDoc, saveDoc, savePos, readingSpeed, localFileHashes, getFile, categoryOf, categoryMap, setCategory, cleanCategoryName } from '../store.js';
import { menu, confirmDialog, promptDialog, sheet, infoButton } from '../ui/overlay.js';
import { navigate, openDoc, runImport } from '../main.js';
import { ACCEPT, FORMATS } from '../parse/index.js';
import { coverUrlCache } from '../docs.js';
import { syncStatus, onSyncStatus } from '../sync/sync.js';
import { pickReplacement } from '../replace.js';
import { todayStats } from './stats.js';

const covers = coverUrlCache();
let root = null;
let listBox = null;
let query = '';
let offStatus = null;
let viewCat = ''; // 지금 보는 카테고리(비면 서재 맨 위)
let enteredCat = ''; // 서재 목록에서 들어온 카테고리 — 그때만 '뒤로'가 방문 기록을 되돌린다

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
// '최근 읽은 순'의 열쇠: 연 적이 없으면 넣은 때
const recentKey = (d) => lastOpened(d) || d.addedAt || 0;
const byRecent = (a, b) => recentKey(b) - recentKey(a);

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

function catFromHash() {
  return cleanCategoryName(new URLSearchParams(location.hash.split('?')[1] || '').get('cat') || '');
}

// 지금 보는 카테고리(끌어다 놓은 파일을 그 카테고리에 넣을 때 main.js 가 묻는다)
export function currentCategory() {
  return root ? viewCat : '';
}

export function openCategory(name) {
  enteredCat = name;
  navigate(`#/library?cat=${encodeURIComponent(name)}`);
}

function leaveCategory() {
  if (enteredCat && enteredCat === viewCat) {
    enteredCat = '';
    history.back();
  } else {
    navigate('#/library', { replace: true });
  }
}

export async function render(container) {
  root = container;
  viewCat = catFromHash();
  // 없는 카테고리(풀었거나 다른 기기에서 비운 것)면 서재 맨 위로
  if (viewCat && !categoryMap().has(viewCat)) {
    viewCat = '';
    history.replaceState(history.state, '', '#/library');
  }
  const head = viewCat ? categoryHead() : h('header', { class: 'vhead' },
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

function categoryHead() {
  const more = h('button', { class: 'gicon', 'aria-label': '카테고리 메뉴', html: ico('more') });
  more.addEventListener('click', () => categoryMenu(more, viewCat, { inside: true }));
  return h('header', { class: 'vhead cat-head' },
    h('button', { class: 'gicon', 'aria-label': '서재로', html: ico('back'), onclick: () => leaveCategory() }),
    h('h1', { class: 'cat-title' }, h('span', { class: 'cat-ico', html: ico('folder') }), h('span', { class: 'cat-name' }, viewCat)),
    syncButton(),
    h('button', { class: 'gbtn primary add-btn', onclick: () => importPicker() }, h('span', { html: ico('import') }), '문서 추가'),
    more);
}

export function destroy() {
  document.querySelector('.fab')?.remove();
  offStatus?.();
  offStatus = null;
  root = null;
  viewCat = '';
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

// 카테고리를 보던 중이면 넣은 문서는 그 카테고리로
export async function importPicker() {
  const cat = currentCategory();
  const files = await pickFiles({ accept: ACCEPT, multiple: true });
  if (files.length) runImport(files, cat ? { category: cat } : {});
}

let fillGen = 0;
async function fill() {
  const gen = ++fillGen;
  const box = listBox;
  if (!box) return;
  // 기기 안 파일 목록을 기다리는 사이 다시 그리기가 겹치면(가져오기·동기화·필터가 잇달 때) 목록이 두 번 붙었다 —
  // 기다린 뒤에 지우고 그리며, 더 늦게 시작한 그리기가 있으면 이번 것은 그만둔다
  const local = await localFileHashes();
  if (gen !== fillGen || box !== listBox) return;
  const all = liveDocs();
  // 카테고리 안: 그 카테고리의 문서만. 마지막 문서를 빼거나 카테고리를 풀었으면 서재 맨 위로
  if (viewCat && !all.some((d) => categoryOf(d) === viewCat)) {
    navigate('#/library', { replace: true });
    return;
  }
  const docs = viewCat ? all.filter((d) => categoryOf(d) === viewCat) : all;
  const scrollY = window.scrollY;
  const prevFocus = document.activeElement?.classList?.contains('lib-search') ? document.activeElement.selectionStart : null;
  box.textContent = '';
  document.querySelector('.fab')?.toggleAttribute('hidden', !docs.length);
  if (!docs.length) {
    box.append(emptyState());
    return;
  }
  if (!viewCat) {
    const today = todayStats();
    const stats = h('div', { class: 'lib-today' },
      h('button', { class: 'lib-stat', onclick: () => navigate('#/stats') }, h('span', { html: ico('clock') }), `오늘 ${today.minutes}분`),
      today.streak > 0 ? h('button', { class: 'lib-stat', onclick: () => navigate('#/stats') }, h('span', { html: ico('flame') }), `${today.streak}일 연속`) : null,
      h('span', { class: 'lib-stat' }, h('span', { html: ico('library') }), `${docs.length}권`));
    box.append(stats);

    // 이어 읽기 — 카테고리가 아니라 문서 하나(카테고리 안 문서도 올라온다)
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
  }

  // 도구 줄
  const search = h('input', { class: 'gfield lib-search', type: 'search', placeholder: viewCat ? '이 카테고리에서 찾기' : '제목·지은이로 찾기', value: query });
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
  const catBtn = viewCat ? null : h('button', { class: 'gicon', 'aria-label': '새 카테고리', title: '새 카테고리', html: ico('folderPlus'), onclick: () => newCategorySheet() });
  box.append(h('div', { class: 'lib-tools' }, h('div', { class: 'search-box', html: ico('search') }, search), catBtn, sortBtn, viewBtn), h('div', { class: 'lib-tools' }, chips));
  const list = h('div');
  box.append(list);

  function renderList() {
    list.textContent = '';
    const f = state.app.libraryFilter;
    const pass = (d) => (f === 'reading' ? progressOf(d) > 0 && !isFinished(d)
      : f === 'unread' ? !progressOf(d) && !lastOpened(d)
        : f === 'done' ? isFinished(d) : true);
    const q = query.trim().toLowerCase();
    const hit = (d) => `${d.title} ${d.author || ''} ${d.fileName || ''}`.toLowerCase().includes(q);
    const shown = docs.filter((d) => pass(d) && (!q || hit(d)));
    // 항목: 문서 또는 카테고리. 서재 맨 위에서는 카테고리 문서를 카테고리 하나로 묶는다(찾을 때는 문서를 그대로 보이고, 이름이 맞는 카테고리도 함께)
    let items;
    if (viewCat) {
      items = shown.map((d) => ({ doc: d }));
    } else {
      const cats = new Map();
      items = [];
      for (const d of q ? docs.filter(pass) : shown) {
        const c = categoryOf(d);
        if (!c) { if (!q || hit(d)) items.push({ doc: d }); continue; }
        if (q && hit(d)) items.push({ doc: d, inCat: c });
        if (q && !c.toLowerCase().includes(q)) continue;
        if (!cats.has(c)) { const g = { cat: c, docs: [] }; cats.set(c, g); items.push(g); }
        cats.get(c).docs.push(d);
      }
      const byCat = categoryMap();
      for (const g of cats.values()) g.all = (byCat.get(g.cat) || g.docs).slice().sort(byRecent);
    }
    // 정렬: 카테고리는 속한 문서(보이는 것) 가운데 가장 앞설 문서의 값으로 — 가장 최근에 연 문서가 카테고리 안이면 카테고리가 맨 위
    const sort = state.app.librarySort;
    const keyOf = (it) => {
      const ds = it.doc ? [it.doc] : it.docs;
      if (sort === 'added') return Math.max(...ds.map((d) => d.addedAt || 0));
      if (sort === 'progress') return ds.reduce((n, d) => n + progressOf(d), 0) / ds.length;
      return Math.max(...ds.map(recentKey));
    };
    const nameOf = (it) => (it.doc ? it.doc.title : it.cat);
    items.sort((a, b) => (sort === 'title' ? nameOf(a).localeCompare(nameOf(b), 'ko') : keyOf(b) - keyOf(a)));
    if (!items.length) {
      list.append(h('p', { class: 'empty-note' }, '조건에 맞는 문서가 없습니다.'));
      return;
    }
    if (state.app.libraryView === 'grid') {
      const grid = h('div', { class: 'doc-grid' });
      for (const it of items) grid.append(it.doc ? tile(it.doc, local) : categoryTile(it));
      list.append(grid);
    } else {
      const lst = h('div', { class: 'doc-list' });
      for (const it of items) lst.append(it.doc ? card(it.doc, local, it.inCat) : categoryCard(it));
      list.append(lst);
    }
  }
  renderList();
  if (prevFocus != null) { search.focus(); search.setSelectionRange(prevFocus, prevFocus); }
  window.scrollTo(0, scrollY);
}

function card(d, local, inCat = '') {
  const hl = liveAnns(d.id).filter((a) => a.kind === 'hl');
  const notes = hl.filter((a) => a.note).length;
  const cv = coverEl(d);
  if (!local.has(d.fileHash)) cv.append(h('span', { class: 'cloud-chip', title: '원본이 아직 이 기기에 없음(열면 받아 옴)', html: ico('cloudDown') }));
  const more = h('button', { class: 'gicon', 'aria-label': '문서 메뉴', html: ico('more') });
  more.addEventListener('click', (e) => { e.stopPropagation(); docMenu(more, d); });
  return h('div', { class: 'doc-card', role: 'button', tabindex: '0', onclick: () => openDoc(d.id), onkeydown: (e) => { if (e.key === 'Enter') openDoc(d.id); } },
    cv,
    h('div', { class: 'doc-main' },
      inCat ? h('div', { class: 'doc-incat' }, h('span', { html: ico('folder') }), inCat) : null,
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
  longPressMenu(el, () => docMenu(el, d));
  return el;
}

// 표지 보기: 길게 누르기·오른쪽 단추로 메뉴
function longPressMenu(el, open) {
  let t = null;
  let menuAt = 0;
  const show = () => { if (Date.now() - menuAt < 800) return; menuAt = Date.now(); open(); };
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(t); show(); });
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; t = setTimeout(() => { t = null; show(); }, 650); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener('click', (e) => { if (Date.now() - menuAt < 800) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

// ── 카테고리 항목 ──
// 최근에 연 문서 표지 셋을 겹쳐 쌓은 모양(맨 앞이 가장 최근)
function categoryStack(docs) {
  const top = docs.slice(0, 3);
  const box = h('div', { class: 'cat-stack', 'aria-hidden': 'true' });
  top.slice().reverse().forEach((d, i, arr) => {
    const cv = coverEl(d);
    const back = arr.length - 1 - i; // 0 = 맨 앞
    cv.style.left = `${back * 5}px`;
    cv.style.top = `${(arr.length - 1 - back) * 2}px`;
    if (back) cv.style.filter = `brightness(${1 - back * 0.09})`;
    box.append(cv);
  });
  return box;
}

function categoryCard(g) {
  const n = g.all.length;
  const done = g.all.filter(isFinished).length;
  const last = Math.max(...g.all.map(lastOpened));
  const more = h('button', { class: 'gicon', 'aria-label': '카테고리 메뉴', html: ico('more') });
  more.addEventListener('click', (e) => { e.stopPropagation(); categoryMenu(more, g.cat); });
  return h('div', { class: 'doc-card cat-card', role: 'button', tabindex: '0', 'data-cat': g.cat, onclick: () => openCategory(g.cat), onkeydown: (e) => { if (e.key === 'Enter') openCategory(g.cat); } },
    categoryStack(g.all),
    h('div', { class: 'doc-main' },
      h('div', { class: 'doc-title' }, h('span', { class: 'cat-ico', html: ico('folder') }), g.cat),
      h('div', { class: 'doc-meta', html: `문서 <b>${n}개</b> │ 열람 <b>${esc(last ? fmtDateTime(last) : '-')}</b>` }),
      h('div', { class: 'pbar', title: `다 읽은 문서 ${done}개 / ${n}개` },
        h('div', { class: 'pbar-track' }, h('div', { class: `pbar-fill${done === n ? ' done' : ''}`, style: { width: `${Math.round((done / n) * 1000) / 10}%` } })),
        h('span', { class: 'pbar-num' }, `${done}/${n}`))),
    more);
}

function categoryTile(g) {
  const mosaic = h('div', { class: 'cat-mosaic', 'aria-hidden': 'true' });
  for (const d of g.all.slice(0, 4)) mosaic.append(coverEl(d));
  const el = h('div', { class: 'doc-tile cat-tile', role: 'button', tabindex: '0', 'data-cat': g.cat, onclick: () => openCategory(g.cat), onkeydown: (e) => { if (e.key === 'Enter') openCategory(g.cat); } },
    mosaic,
    h('div', { class: 'doc-title' }, h('span', { class: 'cat-ico', html: ico('folder') }), g.cat),
    h('div', { class: 'cat-count' }, `문서 ${g.all.length}개`));
  longPressMenu(el, () => categoryMenu(el, g.cat));
  return el;
}

function categoryMenu(anchor, name, { inside = false } = {}) {
  menu(anchor, [
    inside ? null : { label: '열기', icon: 'folder', onClick: () => openCategory(name) },
    { label: '문서 넣기', icon: 'folderPlus', onClick: () => addDocsSheet(name) },
    { label: '이름 바꾸기', icon: 'edit', onClick: () => renameCategory(name) },
    { divider: true },
    { label: '카테고리 풀기', icon: 'folderMinus', onClick: () => dissolveCategory(name) },
  ]);
}

async function renameCategory(name) {
  const value = await promptDialog({ title: '카테고리 이름 바꾸기', value: name, maxLength: 60 });
  if (value == null) return;
  const next = cleanCategoryName(value);
  if (!next) { toast('카테고리 이름은 비워 둘 수 없습니다.'); return; }
  if (next === name) return;
  const merged = categoryMap().has(next);
  await setCategory((categoryMap().get(name) || []).map((d) => d.id), next);
  toast(merged ? `‘${next}’ 카테고리와 합쳤습니다.` : '이름을 바꿨습니다.', { duration: 1600 });
  if (viewCat === name) {
    if (enteredCat === name) enteredCat = next;
    navigate(`#/library?cat=${encodeURIComponent(next)}`, { replace: true });
  }
}

async function dissolveCategory(name) {
  const docs = categoryMap().get(name) || [];
  const ok = await confirmDialog({
    title: '카테고리를 풀까요?',
    message: `<p>‘${esc(name)}’에 든 문서 ${docs.length}개는 서재 목록으로 돌아갑니다.</p><p>문서는 지워지지 않습니다.</p>`,
    ok: '풀기',
  });
  if (!ok) return;
  const inside = viewCat === name;
  await setCategory(docs.map((d) => d.id), '');
  toast('카테고리를 풀었습니다.', { duration: 1600 });
  if (inside) leaveCategory();
}

// 문서 고르기(여러 개): 찾기 칸으로 좁히고 '보이는 문서 모두'로 한꺼번에 고를 수 있다
function docPicker({ exclude = () => false, checked = [] } = {}) {
  const docs = liveDocs().filter((d) => !exclude(d)).sort(byRecent);
  const sel = new Set(checked);
  const search = h('input', { class: 'gfield', type: 'search', placeholder: '제목으로 찾기', enterkeyhint: 'search' });
  const rows = h('div', { class: 'pick-list' });
  const count = h('span', { class: 'pick-count' });
  const allBtn = h('button', { class: 'gbtn ghost small', type: 'button' }, '보이는 문서 모두 고르기');
  let visible = [];
  const paintCount = () => { count.textContent = `${sel.size}개 고름`; };
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    visible = docs.filter((d) => !q || `${d.title} ${d.author || ''} ${d.fileName || ''}`.toLowerCase().includes(q));
    rows.textContent = '';
    for (const d of visible) {
      const box = h('input', { type: 'checkbox' });
      box.checked = sel.has(d.id);
      box.addEventListener('change', () => { if (box.checked) sel.add(d.id); else sel.delete(d.id); paintCount(); });
      const c = categoryOf(d);
      rows.append(h('label', { class: 'pick-row' }, box, h('span', { class: 'pick-title' }, d.title), c ? h('small', null, c) : null));
    }
    if (!visible.length) rows.append(h('p', { class: 'empty-note' }, docs.length ? '맞는 문서가 없습니다.' : '넣을 수 있는 문서가 없습니다.'));
    paintCount();
  };
  search.addEventListener('input', paint);
  allBtn.addEventListener('click', () => { for (const d of visible) sel.add(d.id); paint(); });
  paint();
  const el = h('div', { class: 'pick' }, search, h('div', { class: 'pick-tools' }, allBtn, count), rows);
  return { el, selected: () => docs.filter((d) => sel.has(d.id)).map((d) => d.id) };
}

function newCategorySheet(preselect = []) {
  const name = h('input', { class: 'gfield', type: 'text', placeholder: '카테고리 이름', maxlength: 60, autofocus: true });
  const pick = docPicker({ checked: preselect });
  sheet({
    title: '새 카테고리',
    tall: true,
    className: 'cat-sheet',
    body: h('div', { class: 'cat-make' }, name, h('div', { class: 'cat-make-label' }, '넣을 문서'), pick.el),
    actions: [
      { label: '취소' },
      { label: '만들기', primary: true, onClick: async () => {
        const n = cleanCategoryName(name.value);
        if (!n) { toast('카테고리 이름을 적어 주세요.'); name.focus(); return true; }
        const ids = pick.selected();
        if (!ids.length) { toast('넣을 문서를 하나 이상 골라 주세요.'); return true; }
        const existed = categoryMap().has(n);
        await setCategory(ids, n);
        toast(existed ? `‘${n}’에 문서 ${ids.length}개를 넣었습니다.` : `‘${n}’ 카테고리를 만들었습니다.`);
        return false;
      } },
    ],
  });
}

function addDocsSheet(name) {
  const pick = docPicker({ exclude: (d) => categoryOf(d) === name });
  sheet({
    title: `‘${name}’에 문서 넣기`,
    tall: true,
    className: 'cat-sheet',
    body: pick.el,
    actions: [
      { label: '취소' },
      { label: '넣기', primary: true, onClick: async () => {
        const ids = pick.selected();
        if (!ids.length) { toast('넣을 문서를 골라 주세요.'); return true; }
        await setCategory(ids, name);
        toast(`문서 ${ids.length}개를 넣었습니다.`, { duration: 1600 });
        return false;
      } },
    ],
  });
}

// 문서 하나를 카테고리에 넣기·옮기기: 있는 카테고리를 고르거나 새 이름을 적는다
function moveDocSheet(d) {
  const from = categoryOf(d);
  const cats = [...categoryMap().entries()].filter(([c]) => c !== from)
    .sort((a, b) => Math.max(...b[1].map(recentKey)) - Math.max(...a[1].map(recentKey)));
  const input = h('input', { class: 'gfield', type: 'text', placeholder: '새 카테고리 이름', maxlength: 60 });
  let box = null;
  const put = async (name) => {
    await setCategory([d.id], name);
    box?.close();
    toast(`‘${name}’에 넣었습니다.`, { duration: 1600 });
  };
  const list = h('div', { class: 'cat-pick' });
  for (const [c, ds] of cats) {
    list.append(h('button', { class: 'cat-pick-row', type: 'button', onclick: () => put(c) },
      h('span', { class: 'cat-ico', html: ico('folder') }), h('span', { class: 'cat-pick-name' }, c), h('small', null, `${ds.length}개`)));
  }
  const make = async () => {
    const n = cleanCategoryName(input.value);
    if (!n) { toast('새 카테고리 이름을 적어 주세요.'); input.focus(); return true; }
    await put(n);
    return true;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); make(); } });
  box = sheet({
    title: from ? '다른 카테고리로 옮기기' : '카테고리에 넣기',
    className: 'gdialog cat-sheet',
    body: h('div', { class: 'cat-move' }, cats.length ? list : null, input),
    actions: [{ label: '취소' }, { label: '새 카테고리에 넣기', primary: true, onClick: make }],
  });
}

function docMenu(anchor, d) {
  const finished = isFinished(d);
  const cat = categoryOf(d);
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
    { label: cat ? '다른 카테고리로 옮기기' : '카테고리에 넣기', icon: 'folder', onClick: () => moveDocSheet(d) },
    cat ? { label: '카테고리에서 빼기', icon: 'folderMinus', onClick: async () => {
      await setCategory([d.id], '');
      toast(`‘${cat}’에서 뺐습니다.`, { duration: 1600 });
    } } : null,
    { label: finished ? '다 읽음 표시 해제' : '다 읽음으로 표시', icon: 'check', onClick: () => {
      savePos(d.id, finished ? { manualDone: false, progress: Math.min(progressOf(d), 0.98) } : { manualDone: true, finishedAt: state.pos.get(d.id)?.finishedAt || Date.now() }, { immediate: true });
      fill();
    } },
    { label: '원본 파일 저장', icon: 'download', onClick: async () => {
      const blob = await getFile(d.fileHash);
      if (!blob) { toast('이 기기에 원본이 없습니다. 먼저 문서를 열어 받아 오세요.'); return; }
      downloadBlob(blob, d.fileName || `${d.title}.${d.format}`);
    } },
    { label: '원본 파일 바꾸기', icon: 'replace', onClick: () => pickReplacement(d) },
    { divider: true },
    { label: '서재에서 삭제', icon: 'trash', danger: true, onClick: async () => {
      const n = liveAnns(d.id).filter((a) => a.kind !== 'fix').length;
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

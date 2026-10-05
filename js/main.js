// 앱 시작·화면 전환·설치 앱 기능(공유로 받기, 파일 열기)
import { iconSprite, ico } from './icons.js';
import { openDb, db } from './db.js';
import { initStore, state, setApp } from './store.js';
import { h, toast, on, debounce } from './util.js';
import { handlePopState, closeAllOverlays, whenHistorySettled } from './ui/overlay.js';
import { openReader, closeReader, currentReader } from './reader/index.js';
import { importFiles } from './docs.js';
import { initSync } from './sync/sync.js';
import { dueCount } from './views/review.js';

export const APP_VERSION = '1.0.0';

const VIEWS = {
  library: { label: '서재', icon: 'library', load: () => import('./views/library.js') },
  notes: { label: '노트', icon: 'notes', load: () => import('./views/notes.js') },
  review: { label: '되새기기', icon: 'review', load: () => import('./views/review.js') },
  search: { label: '찾기', icon: 'search', load: () => import('./views/search.js') },
  stats: { label: '기록', icon: 'chart', load: () => import('./views/stats.js'), navPc: true },
  settings: { label: '설정', icon: 'settings', load: () => import('./views/settings.js') },
};

let currentView = null;
let currentModule = null;

function applyTheme() {
  const t = state.app.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (!document.body.classList.contains('reading')) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0F1311' : '#F7F4EC');
  }
}

function buildNav() {
  const nav = document.querySelector('.g-nav');
  nav.textContent = '';
  nav.append(h('div', { class: 'g-nav-brand' }, h('b', null, 'GARGANTUA'), h('small', null, 'BEYOND THE EVENT HORIZON')));
  for (const [key, v] of Object.entries(VIEWS)) {
    if (key === 'settings') nav.append(h('div', { class: 'g-nav-spacer' }));
    const btn = h('button', {
      class: `g-nav-item${v.navPc ? ' pc-only' : ''}`, 'data-view': key, 'aria-label': v.label,
      html: `${ico(v.icon)}<span>${v.label}</span>`,
      onclick: () => navigate(`#/${key}`),
    });
    nav.append(btn);
  }
  updateNav();
}

export function updateNav() {
  for (const b of document.querySelectorAll('.g-nav-item')) {
    b.classList.toggle('on', b.dataset.view === currentView);
    if (b.dataset.view === 'review') {
      b.querySelector('.badge')?.remove();
      const n = dueCount();
      if (n > 0) b.append(h('span', { class: 'badge' }, n > 99 ? '99+' : String(n)));
    }
  }
}

export async function navigate(hash, { replace = false } = {}) {
  await whenHistorySettled();
  if (location.hash === hash && !replace) { route(); return; }
  if (replace) history.replaceState({ g: 'route' }, '', hash);
  else history.pushState({ g: 'route' }, '', hash);
  route();
}

export function openDoc(id, params = {}) {
  const q = new URLSearchParams(params).toString();
  navigate(`#/read/${encodeURIComponent(id)}${q ? `?${q}` : ''}`);
}

function parseReaderOpts(qs) {
  const p = new URLSearchParams(qs || '');
  const opts = {};
  if (p.get('ann')) opts.annId = p.get('ann');
  if (p.get('find')) opts.find = p.get('find');
  if (p.has('s')) opts.loc = { s: Number(p.get('s')), o: Number(p.get('o') || 0) };
  if (p.has('p')) opts.loc = { p: Number(p.get('p')), y: 0 };
  if (p.get('mode')) opts.mode = p.get('mode');
  return opts;
}

let routing = Promise.resolve();
function route() {
  routing = routing.then(doRoute).catch((e) => console.error(e));
  return routing;
}

async function doRoute() {
  const hash = location.hash || '#/library';
  const m = /^#\/read\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const r = currentReader();
    if (r && r.doc.id === id && !m[2]) return;
    await openReader(id, parseReaderOpts(m[2]));
    return;
  }
  if (currentReader()) await closeReader();
  const key = hash.slice(2).split('?')[0].split('/')[0];
  const view = VIEWS[key] ? key : 'library';
  await showView(view);
}

async function showView(view) {
  const main = document.getElementById('app-view');
  if (currentModule?.destroy) currentModule.destroy();
  currentView = view;
  updateNav();
  const mod = await VIEWS[view].load();
  if (currentView !== view) return;
  currentModule = mod;
  main.replaceChildren();
  await mod.render(main);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}

export function refreshView() {
  if (currentModule?.refresh) currentModule.refresh();
}

// 파일 끌어다 놓기(PC)
function bindDrop() {
  let veil = null;
  let depth = 0;
  const show = () => {
    if (veil) return;
    veil = h('div', { class: 'drop-veil' }, '놓으면 서재에 추가합니다');
    document.body.append(veil);
  };
  const hide = () => { veil?.remove(); veil = null; depth = 0; };
  addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    show();
  });
  addEventListener('dragleave', () => { depth--; if (depth <= 0) hide(); });
  addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    hide();
    if (!files.length) return;
    e.preventDefault();
    runImport(files);
  });
}

let importing = false;
export async function runImport(files, { openSingle = true } = {}) {
  if (!files.length) return [];
  if (importing) { toast('가져오기가 진행 중입니다. 잠시 뒤 다시 시도해 주세요.'); return []; }
  importing = true;
  const status = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '가져오는 중'));
  document.body.append(status);
  let results = [];
  try {
    results = await importFiles(files, { onStatus: (m) => { status.lastChild.textContent = m; } });
  } finally {
    status.remove();
    importing = false;
  }
  const ok = results.filter((r) => r.doc && !r.duplicate);
  const dup = results.filter((r) => r.duplicate);
  const bad = results.filter((r) => r.error);
  if (bad.length) toast(`${bad[0].name}: ${bad[0].error}${bad.length > 1 ? ` 외 ${bad.length - 1}개` : ''}`, { duration: 6000 });
  else if (dup.length && !ok.length) toast('이미 서재에 있는 문서입니다.', { action: '열기', onAction: () => openDoc(dup[0].doc.id) });
  else if (ok.length) toast(ok.length === 1 ? '서재에 추가했습니다.' : `문서 ${ok.length}개를 추가했습니다.`);
  requestPersist();
  refreshView();
  if (openSingle && files.length === 1 && (ok[0] || dup[0])) openDoc((ok[0] || dup[0]).doc.id);
  return results;
}

// 기기 저장소를 '지우지 말아 달라'고 요청(설치 앱이면 대개 허락된다)
export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* 무시 */ }
}

// 다른 앱에서 '공유'로 보낸 파일·PC에서 '연결 프로그램'으로 연 파일
async function takeInbox() {
  const rows = await db.getAll('inbox');
  if (!rows.length) return;
  await db.clear('inbox');
  const files = rows.map((r) => new File([r.blob], r.name || 'document', { type: r.blob.type }));
  await runImport(files);
}

function bindLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = [];
    for (const handle of params.files) {
      try { files.push(await handle.getFile()); } catch { /* 권한 없음 */ }
    }
    if (files.length) runImport(files);
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch((e) => console.warn('서비스워커 등록 실패', e));
  let reloading = false;
  // 처음 설치될 때(이전 관리자가 없을 때)는 다시 읽을 필요가 없다
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    // 읽는 중이면 위치를 저장한 뒤 다시 연다
    const r = currentReader();
    const go = () => { reloading = true; location.reload(); };
    if (r) {
      toast('새 버전을 받았습니다. 서재로 나가면 적용됩니다.', { duration: 5000 });
      const off = on('reader-closed', () => { off(); setTimeout(go, 200); });
    } else {
      go();
    }
  });
}

async function boot() {
  document.getElementById('sprite').innerHTML = iconSprite();
  try {
    await openDb();
    await initStore();
  } catch (e) {
    document.getElementById('boot').innerHTML = `<div style="padding:24px;max-width:420px;text-align:center"><h2>저장소를 열 수 없습니다</h2><p>${String(e?.message || e)}</p></div>`;
    return;
  }
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  on('app-settings', (p) => { if ('theme' in p) applyTheme(); });
  buildNav();
  bindDrop();
  bindLaunchQueue();
  addEventListener('popstate', () => {
    if (handlePopState()) return;
    route();
  });
  // 처음 연 주소가 읽기 화면이면 '뒤로'가 서재로 가도록 한 칸을 깐다
  const start = location.hash || '#/library';
  if (start.startsWith('#/read/')) {
    history.replaceState({ g: 'route' }, '', '#/library');
    history.pushState({ g: 'route' }, '', start);
  } else {
    history.replaceState({ g: 'route' }, '', start);
  }
  await route();
  document.getElementById('boot').classList.add('done');
  setTimeout(() => document.getElementById('boot')?.remove(), 400);
  registerSW();
  const refreshSoon = debounce(() => { refreshView(); updateNav(); }, 400);
  on('docs', refreshSoon);
  on('anns', refreshSoon);
  on('info', refreshSoon);
  on('rev', () => updateNav());
  on('remote-applied', refreshSoon);
  initSync().catch((e) => console.warn(e));
  const params = new URLSearchParams(location.search);
  if (params.has('share') || params.has('open')) {
    history.replaceState(history.state, '', location.pathname + location.hash);
  }
  takeInbox().catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'inbox') takeInbox(); });
  window.addEventListener('pagehide', () => { try { currentReader()?.flush(); } catch { /* 무시 */ } });
  void closeAllOverlays;
  void setApp;
}

boot();

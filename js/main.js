// 앱 시작·화면 전환·설치 앱 기능(공유로 받기, 파일 열기)
import { iconSprite, ico } from './icons.js';
import { openDb, db } from './db.js';
import { initStore, state, setApp, flushPositions } from './store.js';
import { h, toast, on, debounce } from './util.js';
import { handlePopState, closeAllOverlays, whenHistorySettled, overlayCount } from './ui/overlay.js';
import { openReader, closeReader, currentReader } from './reader/index.js';
import { importFiles } from './docs.js';
import { initSync } from './sync/sync.js';
import { warm as warmDropbox } from './sync/dropbox.js';
import { runGate, closeGate, resumeGate } from './ui/bootgate.js';
import { dueCount } from './views/review.js';

export const APP_VERSION = '1.0.0';
export const BUILD = 'dbeb6c3cf6';

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
      html: `${ico(v.icon)}<span class="g-nav-label">${v.label}</span>`,
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

// 가져오기는 한 번에 하나씩 줄을 세운다 — 진행 중에 들어온 파일(공유로 받기·끌어다 놓기·다시 고르기)을
// 예전처럼 '잠시 뒤 다시'라며 버리지 않는다
let importChain = Promise.resolve();
export function runImport(files, opts = {}) {
  if (!files.length) return Promise.resolve([]);
  const job = importChain.then(() => importNow(files, opts));
  importChain = job.catch(() => {});
  return job;
}

async function importNow(files, { openSingle = true } = {}) {
  const status = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '가져오는 중'));
  document.body.append(status);
  let results = [];
  try {
    results = await importFiles(files, { onStatus: (m) => { status.lastChild.textContent = m; } });
  } finally {
    status.remove();
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

// 다른 앱에서 '공유'로 보낸 파일·PC에서 '연결 프로그램'으로 연 파일.
// 가져오기를 마친 뒤에 받은 편지함에서 지운다 — 도중에 앱이 꺼져도 다음에 열 때 이어서 가져온다
let inboxChain = Promise.resolve();
function takeInbox() {
  inboxChain = inboxChain.then(async () => {
    const rows = await db.getAll('inbox');
    if (!rows.length) return;
    const files = rows.map((r) => new File([r.blob], r.name || 'document', { type: r.blob.type }));
    await runImport(files);
    await db.delMany('inbox', rows.map((r) => r.id));
  }).catch((e) => console.warn('받은 파일 가져오기 실패', e));
  return inboxChain;
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
  // 옛 주소(/gargantua-web/ → 2026-10-06 /gargantua/로 옮김)에 남은 서비스워커는 내린다
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) if (new URL(r.scope).pathname === '/gargantua-web/') r.unregister();
  }).catch(() => {});
  // PDF 부품을 미리 다 받아 두게 한다(오프라인에서 처음 여는 PDF용) — 인터넷이 돌아올 때도 이어서
  const keepParts = () => navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'keep-parts' })).catch(() => {});
  keepParts();
  addEventListener('online', keepParts);
  // 다시 로그인하고 돌아온 주소(?login=1)는 지운다
  if (new URLSearchParams(location.search).has('login')) history.replaceState(null, '', location.pathname + location.hash);
  // Cloudflare 잠금(Access) 로그인이 만료되면 앱은 저장본으로 열리지만 새 버전을 못 받는다 — 알리고 다시 로그인하게 한다
  const loginExpired = () => fetch('sw.js', { cache: 'no-store', redirect: 'manual' }).then((res) => res.type === 'opaqueredirect').catch(() => false);
  let loginAsked = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = async () => {
      if (await loginExpired()) {
        if (!loginAsked) {
          loginAsked = true;
          toast('로그인이 만료되어 새 버전을 받지 못합니다.', { action: '다시 로그인', onAction: () => location.assign('./?login=1'), duration: 15000 });
        }
        return;
      }
      reg.update().catch(() => {});
    };
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch((e) => console.warn('서비스워커 등록 실패', e));
  let reloading = false;
  // 처음 설치될 때(이전 관리자가 없을 때)는 다시 읽을 필요가 없다
  let hadController = !!navigator.serviceWorker.controller;
  // 새 버전은 앱이 화면 뒤로 갔을 때(다른 앱으로 넘어가거나 화면을 끌 때) 조용히 적용한다.
  // 보고 있는 화면을 바로 다시 열면 켤 때 시작 화면이 두 번 뜨고, 쓰던 메모·이름이 사라질 수 있었다.
  // 그 사이 옛 화면이 새 판 부품을 섞어 쓰지 않도록 화면 부품은 boot에서 미리 모두 불러 둔다.
  const apply = async () => {
    if (reloading) return;
    reloading = true;
    try {
      currentReader()?.flush();
      await flushPositions();
    } catch { /* 무시 */ }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    const onHide = () => {
      // 창(메모 쓰기·Dropbox 연결 등)이 열려 있으면 다음번으로 미룬다 — 다른 앱에서 글이나 코드를 복사해 오는 사이
      // 다시 열려 쓰던 내용이 사라지지 않게
      if (document.visibilityState !== 'hidden' || overlayCount()) return;
      document.removeEventListener('visibilitychange', onHide);
      apply();
    };
    document.addEventListener('visibilitychange', onHide);
    onHide();
  });
}

async function boot() {
  document.getElementById('sprite').innerHTML = iconSprite();
  try {
    await openDb();
    warmDropbox(); // 기기 자료를 읽는 동안 Dropbox 접속 허가를 미리
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
  // Dropbox에 연결돼 있으면 다른 기기의 변경을 받은 뒤에 연다(로딩 화면) — 읽던 문서도 최신 자리로 열린다
  try { await initSync(); } catch (e) { console.warn(e); }
  await runGate('start');
  await route();
  closeGate();
  // 화면 부품을 지금 판으로 모두 불러 둔 뒤에 새 버전을 살핀다(새 서비스워커는 곧바로 새 파일을 내주므로
  // 나중에 처음 여는 화면이 새 판 부품이 되어 옛 부품과 섞이지 않게)
  await Promise.all(Object.values(VIEWS).map((v) => v.load().catch(() => null)));
  registerSW();
  const refreshSoon = debounce(() => { refreshView(); updateNav(); }, 400);
  on('docs', refreshSoon);
  on('anns', refreshSoon);
  on('info', refreshSoon);
  on('rev', () => updateNav());
  on('remote-applied', refreshSoon);
  // 1분 넘게 가려져 있다 돌아오면 받기가 끝날 때까지 덮고, 받은 것으로 화면을 다시 그린 뒤 걷는다
  on('app-resume', ({ away }) => resumeGate(away, () => { refreshSoon.cancel(); refreshView(); updateNav(); }));
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

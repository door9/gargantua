// Gargantua 서비스워커 — 오프라인 열기(앱 파일 + PDF 부품), 공유로 받은 파일 넘기기
// 같은 주소(door9.github.io)의 다른 앱 캐시를 건드리지 않도록 gargantua- 로 시작하는 것만 정리한다.
const VERSION = 'acacd585e0';
const CACHE = `gargantua-shell-${VERSION}`;
const RUNTIME = 'gargantua-runtime-1'; // PDF 부품 — 버전이 바뀌어도 남는다(pdf.js를 바꾸면 이름도 올릴 것)

// 앱 파일 전부(stamp.py가 빠진 파일이 있으면 배포를 막는다)
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'manifest-samsung.webmanifest', 'css/app.css', 'css/reader.css',
  'js/manifest-pick.js', 'js/main.js', 'js/util.js', 'js/icons.js', 'js/db.js', 'js/store.js', 'js/text.js', 'js/docs.js', 'js/pdfdoc.js',
  'js/ui/overlay.js', 'js/ui/numwheel.js', 'js/ui/readerset.js',
  'js/parse/common.js', 'js/parse/epub.js', 'js/parse/docx.js', 'js/parse/plain.js', 'js/parse/index.js',
  'js/reader/index.js', 'js/reader/flow.js', 'js/reader/paged.js', 'js/reader/pdfview.js', 'js/reader/painter.js',
  'js/reader/chapters.js', 'js/reader/window.js', 'js/reader/panels.js', 'js/reader/actions.js',
  'js/views/library.js', 'js/views/notes.js', 'js/views/notes-export.js', 'js/views/review.js', 'js/views/search.js',
  'js/views/stats.js', 'js/views/settings.js',
  'js/sync/dropbox.js', 'js/sync/sync.js', 'js/sync/backup.js',
  'vendor/fflate.mjs', 'vendor/purify.mjs', 'vendor/marked.mjs', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon-64.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gargantua-') && k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)));
    // 옛 주소(/gargantua-web/)에서 받아 둔 PDF 부품은 지운다
    const rt = await caches.open(RUNTIME);
    for (const req of await rt.keys()) if (!req.url.startsWith(self.registration.scope)) await rt.delete(req);
    await self.clients.claim();
    await keepPdfParts();
  })());
});

// PDF 부품(글꼴 대응표·표준 글꼴·wasm 등, 약 4MB)을 미리 모두 받아 둔다 — 처음 여는 PDF도 오프라인에서 열리게.
// 이미 받은 것은 건너뛰므로 앱을 열 때마다 불러도 된다(main.js가 'keep-parts'를 보낸다)
let keeping = null;
function keepPdfParts() {
  keeping ||= (async () => {
    try {
      const list = await (await fetch('vendor/pdfjs/parts.json', { cache: 'no-cache' })).json();
      const cache = await caches.open(RUNTIME);
      const todo = [];
      for (const p of list) {
        const url = new URL(p, self.registration.scope).href;
        if (!(await cache.match(url))) todo.push(url);
      }
      for (let i = 0; i < todo.length; i += 8) {
        await Promise.all(todo.slice(i, i + 8).map(async (url) => {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        }));
      }
    } catch {
      // 오프라인 등 — 다음에 앱을 열 때 이어서 받는다
    } finally {
      keeping = null;
    }
  })();
  return keeping;
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'keep-parts') event.waitUntil(keepPdfParts());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event));
    return;
  }
  if (req.method !== 'GET') return;
  const rel = url.pathname.slice(scope.pathname.length);
  // PDF 부품(글꼴 대응표 등)은 쓸 때 받아 보관
  if (rel.startsWith('vendor/pdfjs/') && !rel.endsWith('.mjs')) {
    event.respondWith(cacheFirst(req, RUNTIME));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('index.html')) || fetch(req);
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(rel || './', { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

// 공유로 받은 파일은 앱 저장소의 '받은 편지함'에 넣고 앱을 연다
const DB_NAME = 'gargantua-reader';
const STORES = { kv: 'k', docs: 'id', pos: 'docId', anns: 'id', rev: 'annId', files: 'hash', cache: 'docId', info: 'docId', inbox: 'id' };

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const s = db.createObjectStore(name, { keyPath, autoIncrement: name === 'inbox' });
        if (name === 'anns') s.createIndex('docId', 'docId');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function receiveShare(event) {
  try {
    const form = await event.request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
    if (files.length) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const t = db.transaction('inbox', 'readwrite');
        for (const f of files) t.objectStore('inbox').put({ blob: f, name: f.name || 'document', at: Date.now() });
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
      db.close();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'inbox' });
    }
  } catch (e) {
    // 받기 실패해도 앱은 연다
  }
  return Response.redirect('./?share=1#/library', 303);
}

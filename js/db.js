// 기기 안 저장소(IndexedDB). 같은 주소(door9.github.io)의 다른 앱과 겹치지 않게 이름에 gargantua를 붙인다.
const DB_NAME = 'gargantua-reader';
const DB_VERSION = 1;

export const STORES = {
  kv: { keyPath: 'k' },
  docs: { keyPath: 'id' },
  pos: { keyPath: 'docId' },
  anns: { keyPath: 'id', indexes: [['docId', 'docId']] },
  rev: { keyPath: 'annId' },
  files: { keyPath: 'hash' },
  cache: { keyPath: 'docId' },
  info: { keyPath: 'docId' },
  inbox: { keyPath: 'id', autoIncrement: true },
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, spec] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: spec.keyPath, autoIncrement: !!spec.autoIncrement });
        for (const [indexName, keyPath] of spec.indexes || []) store.createIndex(indexName, keyPath);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('저장소가 다른 창에서 사용 중입니다. 다른 Gargantua 창을 닫고 다시 열어 주세요.'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장이 취소되었습니다.'));
    Promise.resolve(fn(t)).then((value) => { result = value; }, (err) => { try { t.abort(); } catch { /* 이미 끝남 */ } reject(err); });
  });
}

export const db = {
  async get(store, key) {
    return tx([store], 'readonly', (t) => wrap(t.objectStore(store).get(key)));
  },
  async getAll(store) {
    return tx([store], 'readonly', (t) => wrap(t.objectStore(store).getAll()));
  },
  async getAllKeys(store) {
    return tx([store], 'readonly', (t) => wrap(t.objectStore(store).getAllKeys()));
  },
  async byIndex(store, index, value) {
    return tx([store], 'readonly', (t) => wrap(t.objectStore(store).index(index).getAll(value)));
  },
  async put(store, value) {
    return tx([store], 'readwrite', (t) => wrap(t.objectStore(store).put(value)));
  },
  async putMany(store, values) {
    if (!values.length) return;
    return tx([store], 'readwrite', (t) => {
      const s = t.objectStore(store);
      for (const v of values) s.put(v);
    });
  },
  async del(store, key) {
    return tx([store], 'readwrite', (t) => wrap(t.objectStore(store).delete(key)));
  },
  async delMany(store, keys) {
    if (!keys.length) return;
    return tx([store], 'readwrite', (t) => {
      const s = t.objectStore(store);
      for (const k of keys) s.delete(k);
    });
  },
  async clear(store) {
    return tx([store], 'readwrite', (t) => wrap(t.objectStore(store).clear()));
  },
  async count(store) {
    return tx([store], 'readonly', (t) => wrap(t.objectStore(store).count()));
  },
  // 여러 저장 칸을 한 번에(전부 되거나 전부 안 되거나)
  async batch(storeNames, fn) {
    return tx(storeNames, 'readwrite', (t) => fn((name) => t.objectStore(name)));
  },
};

export async function kvGet(key, fallback = null) {
  const row = await db.get('kv', key);
  return row ? row.v : fallback;
}
export async function kvSet(key, value) {
  return db.put('kv', { k: key, v: value });
}
export async function kvDel(key) {
  return db.del('kv', key);
}

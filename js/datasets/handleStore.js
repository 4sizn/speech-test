/**
 * File System Access API 디렉터리 핸들을 IndexedDB에 영속화한다.
 * (localStorage에는 핸들 객체를 저장할 수 없다 — structured clone은 IDB만 가능)
 * 재방문 시 "최근 데이터셋 다시 열기"로 권한만 재요청하면 폴더를 다시 고를 필요가 없다.
 */
const DB_NAME = 'speech-test';
const STORE = 'dataset-handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export function saveHandle(key, handle) {
  return tx('readwrite', (s) => s.put(handle, key));
}

export function loadHandle(key) {
  return tx('readonly', (s) => s.get(key));
}

/** 저장된 핸들의 읽기 권한을 확보한다(필요 시 사용자 프롬프트). */
export async function ensurePermission(handle) {
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

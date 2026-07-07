const DB = "lattice-browser-log-v1";
const STORE = "logs";

export async function saveLog(replica, payload) {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.put({ replica, payload, saved_at: Date.now() }));
}

export async function loadLog(replica) {
  const db = await openDb();
  const row = await tx(db, "readonly", (store) => store.get(replica));
  return row ? row.payload : null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "replica" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE, mode);
    const req = fn(txn.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

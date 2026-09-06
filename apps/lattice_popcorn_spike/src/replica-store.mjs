// One atomic record contains identity and signed log, never a cached materialization.
export function replicaStore(name, indexedDB = globalThis.indexedDB) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error("invalid_replica_name");
  async function transaction(mode, work) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("lattice-popcorn-durable-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("replicas");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("storage_blocked"));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("replicas", mode, { durability: "strict" });
        const request = work(tx.objectStore("replicas"));
        tx.oncomplete = () => resolve(request.result ?? null);
        tx.onabort = () => reject(tx.error || new Error("storage_aborted"));
        tx.onerror = () => reject(tx.error || new Error("storage_failed"));
      });
    } finally { db.close(); }
  }
  return Object.freeze({
    load: () => transaction("readonly", store => store.get(name)),
    save: capsule => transaction("readwrite", store => store.put(capsule, name))
  });
}

'use strict';

// Thin promise wrapper around IndexedDB.
// Stores: areas, graphs (keyed by areaId), points, routes.
const DB = (() => {
  const NAME = 'hike-route-planner', VERSION = 1;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('areas', { keyPath: 'id' });
          db.createObjectStore('graphs', { keyPath: 'areaId' });
          db.createObjectStore('points', { keyPath: 'id' });
          db.createObjectStore('routes', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(store, mode, op) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = op(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    put: (store, value) => run(store, 'readwrite', s => s.put(value)),
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    all: (store) => run(store, 'readonly', s => s.getAll()),
    del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  };
})();

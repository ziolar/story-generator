// imgcache.js — IndexedDB-backed image cache with synchronous read layer
// Replaces sessionStorage for large base64 images to avoid 5MB quota errors.
// Usage:
//   await ImgCache.init()        — call once at page startup (preloads into memory)
//   ImgCache.getSync(key)        — synchronous read after init()
//   await ImgCache.get(key)      — async read (works before init())
//   ImgCache.set(key, val)       — write (fire-and-forget or await)
(function() {
  const DB_NAME = 'story-img-cache';
  const STORE   = 'images';
  const mem     = new Map();
  let db        = null;
  let initDone  = false;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
    });
  }

  async function init() {
    if (initDone) return;
    initDone = true;
    try {
      db = await openDB();
      await new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = e => {
          const c = e.target.result;
          if (c) { mem.set(c.key, c.value); c.continue(); }
          else   resolve();
        };
        req.onerror = e => reject(e.target.error);
      });
    } catch(e) {
      console.warn('[ImgCache] IndexedDB init failed, falling back to memory only:', e.message);
    }
  }

  function getSync(key) {
    return mem.get(key) || null;
  }

  function get(key) {
    if (mem.has(key)) return Promise.resolve(mem.get(key));
    if (!db) return Promise.resolve(null);
    return new Promise(resolve => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = () => resolve(null);
    });
  }

  function set(key, value) {
    mem.set(key, value);
    if (!db) return Promise.resolve();
    return new Promise(resolve => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => resolve(); // fail silently — image still in memory
    });
  }

  window.ImgCache = { init, get, getSync, set };
})();

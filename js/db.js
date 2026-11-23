/* Exam Grader - IndexedDB storage */
'use strict';

const DB = (() => {
  const NAME = 'examgrader';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('exams')) db.createObjectStore('exams', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('scans')) {
          const s = db.createObjectStore('scans', { keyPath: 'id' });
          s.createIndex('examId', 'examId');
        }
        if (!db.objectStoreNames.contains('students')) {
          const s = db.createObjectStore('students', { keyPath: 'id' });
          s.createIndex('examId', 'examId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  const put = (store, obj) => tx(store, 'readwrite', s => reqP(s.put(obj)));
  const get = (store, key) => tx(store, 'readonly', s => reqP(s.get(key)));
  const del = (store, key) => tx(store, 'readwrite', s => reqP(s.delete(key)));
  const all = (store) => tx(store, 'readonly', s => reqP(s.getAll()));
  const byExam = (store, examId) => tx(store, 'readonly', s => reqP(s.index('examId').getAll(examId)));

  async function putMany(store, arr) {
    return tx(store, 'readwrite', s => Promise.all(arr.map(o => reqP(s.put(o)))));
  }
  async function deleteExam(examId) {
    const scans = await byExam('scans', examId);
    const studs = await byExam('students', examId);
    await tx('scans', 'readwrite', s => Promise.all(scans.map(o => reqP(s.delete(o.id)))));
    await tx('students', 'readwrite', s => Promise.all(studs.map(o => reqP(s.delete(o.id)))));
    await del('exams', examId);
  }
  async function getKV(k, dflt) { const r = await get('kv', k); return r ? r.v : dflt; }
  async function setKV(k, v) { return put('kv', { k, v }); }

  async function estimate() {
    if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
    return null;
  }

  return { open, put, get, del, all, byExam, putMany, deleteExam, getKV, setKV, estimate };
})();

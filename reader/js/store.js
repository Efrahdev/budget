/* The library lives in IndexedDB: a separate, much larger store than localStorage. That matters: the budget app's
   offline cache, unsent entries and notes share localStorage's ~5 MB, so documents must never go there.
   Two stores: "docs" (small facts: title, kind, progress) and "bodies" (the file or text itself, plus Liquid cache). */
const DB = 'budget-reader', VER = 1, MAX_DOCS = 40;
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', {keyPath: 'id'}).createIndex('openedAt', 'openedAt'); if (!d.objectStoreNames.contains('bodies')) d.createObjectStore('bodies'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
  });
  return dbp;
}
const tx = async (stores, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(stores, mode); let out; Promise.resolve(fn(t)).then(v => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); }); };
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function putDoc(meta, body) {
  await tx(['docs', 'bodies'], 'readwrite', t => { t.objectStore('docs').put(meta); if (body !== undefined) t.objectStore('bodies').put(body, meta.id); });
  trim().catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
}
export const getDoc = id => tx(['docs'], 'readonly', t => req(t.objectStore('docs').get(id)));
export const getBody = (id, key = id) => tx(['bodies'], 'readonly', t => req(t.objectStore('bodies').get(key)));
export const putBody = (key, val) => tx(['bodies'], 'readwrite', t => { t.objectStore('bodies').put(val, key); });
export async function patchDoc(id, patch) {
  return tx(['docs'], 'readwrite', async t => { const s = t.objectStore('docs'); const cur = await req(s.get(id)); if (cur) s.put(Object.assign(cur, patch)); });
}
export async function listDocs() { const all = await tx(['docs'], 'readonly', t => req(t.objectStore('docs').getAll())); return (all || []).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)); }
export async function deleteDoc(id) {
  await tx(['docs', 'bodies'], 'readwrite', async t => { t.objectStore('docs').delete(id); const b = t.objectStore('bodies'); b.delete(id); b.delete(id + ':liquid'); });
}
async function trim() { const all = await listDocs(); for (const d of all.slice(MAX_DOCS)) await deleteDoc(d.id); }
export async function usage() { try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch (x) { return 0; } }

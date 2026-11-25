// Budget Tracker service worker: keeps the app itself available offline.
// Money data never passes through here; it goes straight to Google Sheets.
const CACHE = 'budget-tracker-v107';
// The Reader's pinned third-party files (pdf.js, marked) live in their own cache. Their paths carry the version, so
// they never change: fetched once, on first use, and kept across budget app updates (which replace CACHE).
const VENDOR = 'reader-vendor-v1';
// Only the budget app is fetched up front. The Reader (reader/) is fetched the first time it is opened.
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== VENDOR).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Each page is kept under its own address: the budget app as index.html, the Reader as reader/index.html, Contacts as contacts/index.html.
function pageKey(url) {
  const u = new URL(url); u.hash = ''; u.search = '';
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  return u.href;
}
const CONTACTS_OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Contacts</title><body style="font:16px system-ui;padding:24px;color:#555">Contacts need a connection the first time they open. After that they work offline.</body>';
const READER_OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reader</title><body style="font:16px system-ui;padding:24px;color:#555">The Reader needs a connection the first time it opens. After that it works offline.</body>';
/* FRESH FIRST. Pages and the app's own files are always checked with GitHub when online ({cache:'no-cache'} skips the
   browser's 10-minute reuse of old copies; GitHub answers "unchanged" cheaply when nothing is new), so an update is
   there the very next time you open the app. The saved copy is used only when there is no connection. */
const fresh = (req, key) => fetch(req, {cache: 'no-cache'}).then(r => {
  if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key || req, c)); }
  return r;
});
// Pages: a navigation request can't be copied with new options, so fetch its address (a redirect is passed on as one).
const freshPage = (req, key) => fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}).then(r => {
  if (r.redirected) return Response.redirect(r.url, 302);
  if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); }
  return r;
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (/(^|\.)google(usercontent)?\.com$/.test(url.hostname) && !/fonts\./.test(url.hostname)) return; // the sheet: always live
  const mine = url.origin === location.origin;
  if (req.mode === 'navigate') {
    const key = mine ? pageKey(req.url) : null;
    e.respondWith((mine ? freshPage(req, key) : fetch(req)).catch(() => (key ? caches.match(key) : Promise.resolve(null)).then(hit => hit ||
      (key && key.includes('/reader/') ? new Response(READER_OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}})
        : key && key.includes('/contacts/') ? new Response(CONTACTS_OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}}) : caches.match(pageKey(new URL('./', self.registration.scope).href))))));
    return;
  }
  if (mine && url.pathname.includes('/reader/vendor/')) { // pinned, versioned files: saved once, never re-downloaded
    e.respondWith(caches.open(VENDOR).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  if (mine) { e.respondWith(fresh(req).catch(() => caches.match(req))); return; }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { // fonts never change: saved copy first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })));
  }
});

/* ---------- reminders (Nov 2026) ----------
   The script wakes this worker with an empty push at 9 am, 3 pm and 9 pm when something is due. The details come
   from the app's own copy (IndexedDB budget-app / kv / "rem"), written every time the app checks its reminders.
   One notification per reminder: it stays until you act on it, and the app icon shows how many are waiting.
   Pay opens Add entry filled in; Snooze hides it for 6 hours (sent straight to the sheet, or by the app later). */
const REM_WIN = 72 * 36e5, REM_KEEP = 45 * 864e5, REM_SNOOZE = 6 * 36e5;
function kv(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('budget-app', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const db = r.result; let out; const t = db.transaction('kv', mode), q = fn(t.objectStore('kv'));
      if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => { db.close(); res(out); }; t.onerror = t.onabort = () => { db.close(); rej(t.error); }; };
  });
}
const kvGet = k => kv('readonly', s => s.get(k)).catch(() => null);
const kvPut = (k, v) => kv('readwrite', s => s.put(v, k)).catch(() => {});
function remPending(snap, now) {
  const st = (snap && snap.st) || {};
  return ((snap && snap.list) || []).filter(r => { const left = r.dueMs - now, s = st[r.key] || {};
    return left <= REM_WIN && left > -REM_KEEP && !s.done && !s.dis && !(s.snooze > now); }).sort((a, b) => a.dueMs - b.dueMs);
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function remWhen(dueMs, now) {
  const h = (dueMs - now) / 36e5, d = new Date(dueMs);
  const day = d.getDate() + ' ' + MON[d.getMonth()];
  const t = new Date(now), days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
  if (h < 0) return 'Overdue since ' + day;
  if (days === 0) return 'Due today · ' + Math.max(1, Math.round(h)) + ' h left';
  if (days === 1) return 'Due tomorrow, ' + day + ' · in ' + Math.round(h) + ' h';
  return 'Due ' + day + ' · in ' + Math.round(h) + ' h';
}
const rupees = v => '₹' + new Intl.NumberFormat('en-IN', {maximumFractionDigits: 0}).format(Math.round(v));
async function remShow(renotify) {
  const snap = await kvGet('rem'), now = Date.now(), list = remPending(snap, now), reg = self.registration;
  const old = await reg.getNotifications();
  const want = new Set(list.map(r => 'rem:' + r.key));
  old.forEach(n => { if (n.tag && n.tag.startsWith('rem:') && !want.has(n.tag) && n.tag !== 'rem:any') n.close(); });
  if (!list.length) {
    // The sheet says something is due but this phone's copy has nothing: still say so (Chrome needs a notification).
    const test = await kvGet('remtest');
    if (renotify && test && now - test < 10 * 60000) { await kvPut('remtest', 0); await reg.showNotification('Alerts work on this phone', {tag: 'rem:any', body: 'Nothing is due right now. Payment alerts will look like this.', icon: 'icons/icon-192.png', renotify: true}); }
    else if (renotify) await reg.showNotification('Payment reminder', {tag: 'rem:any', body: 'Something is due soon. Open the app to see it.', icon: 'icons/icon-192.png', requireInteraction: true, renotify: true});
  } else {
    old.forEach(n => { if (n.tag === 'rem:any') n.close(); });
    for (const r of list) await reg.showNotification(r.title, {tag: 'rem:' + r.key, renotify: !!renotify, silent: !renotify, requireInteraction: true,
      body: remWhen(r.dueMs, now) + (r.amount > 0 ? ' · ' + rupees(r.amount) : ''), icon: 'icons/icon-192.png', timestamp: r.dueMs, data: {key: r.key},
      actions: [{action: 'pay', title: 'Pay'}, {action: 'snooze', title: 'Snooze 6 h'}]});
  }
  try { if (navigator.setAppBadge) list.length ? navigator.setAppBadge(list.length) : navigator.clearAppBadge(); } catch (e) {}
}
self.addEventListener('push', e => e.waitUntil(remShow(true)));
// A snooze from the notification: kept on the phone at once, sent to the sheet now if possible, else by the app later.
async function remSnooze(key) {
  const v = {snooze: Date.now() + REM_SNOOZE}, snap = (await kvGet('rem')) || {list: [], st: {}};
  snap.st = snap.st || {}; snap.st[key] = v; await kvPut('rem', snap);
  const q = (await kvGet('remq')) || []; q.push({key, v}); await kvPut('remq', q);
  try {
    const c = (await kvGet('conn')) || {};
    if (snap.api && (c.session || c.key)) {
      const r = await fetch(snap.api, {method: 'POST', redirect: 'follow', body: JSON.stringify({session: c.session || undefined, key: c.session ? undefined : c.key, remOnly: true, ops: [{t: 'remst', key, v}]})});
      const j = await r.json();
      if (j && j.ok) { const left = ((await kvGet('remq')) || []).filter(x => !(x.key === key && x.v.snooze === v.snooze)); await kvPut('remq', left); }
    }
  } catch (e) {}
  const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  all.forEach(w => w.postMessage({src: 'budget-sw', type: 'rem-sync'}));
  await remShow(false);
}
async function remOpen(act, key) {
  const scope = self.registration.scope, all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  const w = all.find(x => x.url.startsWith(scope) && !x.url.includes('/reader/') && !x.url.includes('/contacts/'));
  if (w) { w.postMessage({src: 'budget-sw', type: 'rem', act, key}); return w.focus().catch(() => {}); }
  return self.clients.openWindow(scope + '?rem=' + act + '&k=' + encodeURIComponent(key || '') + '#overview');
}
self.addEventListener('notificationclick', e => {
  const n = e.notification, key = (n.data || {}).key || '';
  if (!n.tag || !n.tag.startsWith('rem:')) return;
  n.close();
  if (e.action === 'snooze' && key) e.waitUntil(remSnooze(key));
  else e.waitUntil(remOpen(e.action === 'pay' && key ? 'pay' : 'open', key));
});
// Swiped away: it comes back (quietly) the next time the app or a push checks, so the icon count stays true.
self.addEventListener('message', e => { if (e.data && e.data.type === 'rem-refresh') e.waitUntil(remShow(false)); });

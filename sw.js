// Budget Tracker service worker: keeps the app itself available offline.
// Money data never passes through here; it goes straight to Google Sheets.
const CACHE = 'budget-tracker-v88';
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
// Each page is kept under its own address: the budget app as index.html, the Reader as reader/index.html.
function pageKey(url) {
  const u = new URL(url); u.hash = ''; u.search = '';
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  return u.href;
}
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
      (key && key.includes('/reader/') ? new Response(READER_OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}}) : caches.match(pageKey(new URL('./', self.registration.scope).href))))));
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

// Budget Tracker service worker: keeps the app itself available offline.
// Money data never passes through here; it goes straight to Google Sheets.
const CACHE = 'budget-tracker-v65';
// The Reader's pinned third-party files (pdf.js, marked) live in their own cache. Their paths carry the version, so
// they never change: fetched once, on first use, and kept across budget app updates (which replace CACHE).
const VENDOR = 'reader-vendor-v1';
// Only the budget app is fetched up front. The Reader (reader/) is fetched the first time it is opened.
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== VENDOR).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Each page is kept under its own address: the budget app as index.html, the Reader as reader/index.html.
// (Keeping every page as index.html would let opening the Reader overwrite the saved budget app.)
function pageKey(url) {
  const u = new URL(url); u.hash = ''; u.search = '';
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  return u.href;
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (/(^|\.)google(usercontent)?\.com$/.test(url.hostname) && !/fonts\./.test(url.hostname)) return; // the sheet: always live
  if (req.mode === 'navigate') {
    // Network first for pages, so updates arrive; fall back to the saved copy offline.
    const key = url.origin === location.origin ? pageKey(req.url) : null;
    e.respondWith(fetch(req).then(r => { if (key && r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); } return r; })
      .catch(() => (key ? caches.match(key) : Promise.resolve(null)).then(hit => hit || (key && key.includes('/reader/')
        ? new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reader</title><body style="font:16px system-ui;padding:24px;color:#555">The Reader needs a connection the first time it opens. After that it works offline.</body>', {headers: {'Content-Type': 'text/html; charset=utf-8'}})
        : caches.match(pageKey(new URL('./', self.registration.scope).href))))));
    return;
  }
  if (url.origin === location.origin && url.pathname.includes('/reader/vendor/')) {
    e.respondWith(caches.open(VENDOR).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; });
      return hit || net;
    }));
  }
});

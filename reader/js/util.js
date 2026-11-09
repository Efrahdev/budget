/* Small shared helpers. */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
export function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; }
export function rafThrottle(fn) { let id = 0, last; return (...a) => { last = a; if (!id) id = requestAnimationFrame(() => { id = 0; fn(...last); }); }; }
export function bytes(n) { if (!(n >= 0)) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
export const words = s => (String(s).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || []).length;
export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date(), days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today, ' + d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en-GB', {weekday: 'long'});
  return d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'});
}
export const isTyping = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
export const coarse = () => matchMedia('(pointer: coarse)').matches;
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function safeName(s, fallback = 'document') { const n = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); return n || fallback; }

/* toast: one message at a time, with an optional action button */
let toastT = 0;
export function toast(msg, opts = {}) {
  const t = $('#toast'), a = $('#toastA');
  $('#toastT').textContent = msg;
  t.classList.toggle('bad', opts.kind === 'bad');
  if (opts.action) { a.textContent = opts.action; a.hidden = false; a.onclick = () => { hideToast(); opts.onAction && opts.onAction(); }; } else { a.hidden = true; a.onclick = null; }
  t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastT); toastT = setTimeout(hideToast, opts.ms || (opts.action ? 6000 : 3200));
}
export function hideToast() { clearTimeout(toastT); $('#toast').hidden = true; }

/* a hash for colours: the same title always gets the same cover */
export function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }

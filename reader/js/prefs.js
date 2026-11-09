/* Reading preferences: tiny, kept in localStorage (a few hundred bytes). Documents never go here (see store.js). */
const KEY = 'budgetReader.prefs.v1';
export const DEFAULTS = {theme: 'auto', font: 'literata', scale: 1, leading: 'normal', width: 'normal', justify: false, hyphens: true,
  dim: 0, warmth: 0, recolor: true, awake: true, wpm: 230};
const LEAD = {compact: 1.45, normal: 1.65, airy: 1.9};
const MEASURE = {narrow: '56ch', normal: '68ch', wide: '84ch', full: '100%'};
export const SCALE_MIN = 0.6, SCALE_MAX = 3.2;
export const prefs = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } })());
const subs = new Set();
export const onPrefs = fn => subs.add(fn);
export function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }
export function setPref(k, v) { if (prefs[k] === v) return; prefs[k] = v; savePrefs(); applyPrefs(k); }
export function resolvedTheme() {
  if (prefs.theme !== 'auto') return prefs.theme;
  let b = null; try { b = localStorage.getItem('budgetTracker.theme'); } catch (e) {}
  const dark = b === 'dark' || (b !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? 'night' : 'paper';
}
export function applyPrefs(changed) {
  const h = document.documentElement, st = h.style;
  h.dataset.rtheme = resolvedTheme();
  h.dataset.font = prefs.font;
  st.setProperty('--lead', LEAD[prefs.leading] || 1.65);
  st.setProperty('--measure', MEASURE[prefs.width] || '68ch');
  st.setProperty('--ta', prefs.justify ? 'justify' : 'start');
  st.setProperty('--hy', prefs.hyphens ? 'auto' : 'manual');
  st.setProperty('--rz', prefs.scale);
  h.classList.toggle('recolor', !!prefs.recolor);
  const dim = document.getElementById('tintDim'), warm = document.getElementById('tintWarm');
  if (dim) dim.style.opacity = (prefs.dim / 100).toFixed(3);
  if (warm) warm.style.opacity = (prefs.warmth / 100 * 0.32).toFixed(3);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(h).getPropertyValue('--bg').trim() || '#fbfaf7';
  subs.forEach(fn => fn(changed));
}
// follow the budget app's day/night switch and the system setting while the theme is Auto
window.addEventListener('storage', e => { if (e.key === 'budgetTracker.theme' && prefs.theme === 'auto') applyPrefs('theme'); if (e.key === KEY) { try { Object.assign(prefs, JSON.parse(e.newValue || '{}')); applyPrefs(); } catch (x) {} } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'auto') applyPrefs('theme'); });

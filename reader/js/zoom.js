/* One zoom, every input: two-finger pinch on a phone, trackpad pinch on a laptop (it arrives as ctrl+wheel, or as
   Safari's gesture events), and Ctrl/Cmd + / − / 0 on a keyboard. The browser's own page zoom is stopped here, so
   the reader can turn the gesture into a change of TEXT SIZE (re-wrap) instead of stretching the page (spill). */
export function attachZoom(el, h) {
  let t0 = null, active = false, gest = false, wheelT = 0, wheelOn = false;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  el.addEventListener('touchstart', e => {
    if (e.touches.length === 2) { e.preventDefault(); const [a, b] = e.touches; t0 = {d: dist(a, b) || 1}; active = true; const m = mid(a, b); h.begin(m[0], m[1]); }
  }, {passive: false});
  el.addEventListener('touchmove', e => {
    if (!active) return;
    if (e.touches.length !== 2) return;
    e.preventDefault(); const [a, b] = e.touches, m = mid(a, b); h.update(dist(a, b) / t0.d, m[0], m[1]);
  }, {passive: false});
  const endTouch = e => { if (active && e.touches.length < 2) { active = false; h.end(); } };
  el.addEventListener('touchend', endTouch); el.addEventListener('touchcancel', endTouch);
  // Safari (iPhone, iPad, Mac): gesture events. On touch devices the touch path above already does the work.
  el.addEventListener('gesturestart', e => { e.preventDefault(); if (active) return; gest = true; h.begin(e.clientX || innerWidth / 2, e.clientY || innerHeight / 2); }, {passive: false});
  el.addEventListener('gesturechange', e => { e.preventDefault(); if (gest && !active) h.update(e.scale, e.clientX || innerWidth / 2, e.clientY || innerHeight / 2); }, {passive: false});
  el.addEventListener('gestureend', e => { e.preventDefault(); if (gest && !active) { gest = false; h.end(); } }, {passive: false});
  // trackpad pinch and ctrl + mouse wheel
  let wf = 1, wx = 0, wy = 0;
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!wheelOn) { wheelOn = true; wf = 1; wx = e.clientX; wy = e.clientY; h.begin(wx, wy); }
    const d = Math.max(-20, Math.min(20, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
    wf *= Math.pow(1.0035, -d);
    h.update(wf, wx, wy);
    clearTimeout(wheelT); wheelT = setTimeout(() => { wheelOn = false; h.end(); }, 220);
  }, {passive: false});
}

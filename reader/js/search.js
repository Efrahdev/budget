/* Find in the reflowing column. Matches are painted with the CSS Custom Highlight API: no DOM changes, so nothing
   reflows and the reading anchor is undisturbed. (Older browsers fall back to selecting the current match.) */
const HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
export class FlowSearch {
  constructor(flow) { this.flow = flow; this.ranges = []; this.i = -1; this.q = ''; }
  run(q) {
    this.clear(); this.q = q = (q || '').trim();
    if (q.length < 1) return 0;
    const needle = q.toLocaleLowerCase(), w = document.createTreeWalker(this.flow.doc, NodeFilter.SHOW_TEXT); let t;
    while ((t = w.nextNode())) {
      const hay = t.nodeValue.toLocaleLowerCase(); let i = hay.indexOf(needle);
      while (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + needle.length); this.ranges.push(r); if (this.ranges.length >= 5000) break; i = hay.indexOf(needle, i + needle.length); }
      if (this.ranges.length >= 5000) break;
    }
    if (HL && this.ranges.length) CSS.highlights.set('rd-hit', new Highlight(...this.ranges));
    if (this.ranges.length) { // start at the first match after where you are reading
      const y = this.flow.refY(); let k = this.ranges.findIndex(r => r.getBoundingClientRect().top >= y - 4);
      this.go(k < 0 ? 0 : k);
    }
    return this.ranges.length;
  }
  go(i) {
    if (!this.ranges.length) return;
    this.i = (i + this.ranges.length) % this.ranges.length;
    const r = this.ranges[this.i];
    if (HL) CSS.highlights.set('rd-cur', new Highlight(r)); else { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    const st = this.flow.stage, sr = st.getBoundingClientRect(), rr = r.getBoundingClientRect();
    if (rr.top < sr.top + 120 || rr.bottom > sr.bottom - 120) st.scrollTop += rr.top - (sr.top + st.clientHeight * 0.36);
  }
  next(d = 1) { this.go(this.i + d); }
  clear() { this.ranges = []; this.i = -1; if (HL) { CSS.highlights.delete('rd-hit'); CSS.highlights.delete('rd-cur'); } }
}

/* The reflowing column: HTML, Markdown, text and Liquid-mode PDFs all render here.

   THE READING ANCHOR. Your place is remembered as "block 214, character 380", not as a scroll distance in pixels.
   Pixels change every time the text size, the theme's typeface or the screen width changes; your sentence doesn't.
   Before any re-layout we take the anchor; after it, we put that exact character back on the same line of the screen.

   BIG DOCUMENTS are split into chunks with content-visibility:auto, so the browser only lays out what is on screen.
   That is what keeps pinch-zoom smooth on a 300-page book: re-wrapping costs one screenful, not the whole thing. */
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'DL', 'TABLE', 'FIGURE', 'HR', 'DETAILS', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'ADDRESS', 'CENTER']);
const CHUNK_CHARS = 6000, CHUNK_BLOCKS = 40, BIG = 60000;

export class Flow {
  constructor(stage, doc, topRef) { this.stage = stage; this.doc = doc; this.topRef = topRef; this.blocks = []; this.pre = []; this.total = 1; this.words = 0; this.toc = [];
    this.io = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) this.fitTable(e.target); }), {root: stage, rootMargin: '600px 0px'}) : null; }

  mount(html) {
    this.io && this.io.disconnect();
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    const blocks = []; let loose = null;
    for (const n of [...tpl.content.childNodes]) {
      if (n.nodeType === 3 && !n.nodeValue.trim()) continue;
      if (n.nodeType === 1 && BLOCKS.has(n.tagName)) { loose = null; blocks.push(n); continue; }
      if (n.nodeType !== 1 && n.nodeType !== 3) continue;
      if (!loose) { loose = document.createElement('p'); blocks.push(loose); }
      loose.appendChild(n);
    }
    // enhance
    let hi = 0;
    const final = blocks.map(b => {
      if (b.tagName === 'TABLE') { const w = document.createElement('div'); w.className = 'tw'; w.appendChild(b); labelTable(b); return w; }
      b.querySelectorAll('table').forEach(t => { if (!t.parentElement.classList.contains('tw')) { const w = document.createElement('div'); w.className = 'tw'; t.before(w); w.appendChild(t); labelTable(t); } });
      return b;
    });
    const tocEls = [];
    final.forEach(b => {
      const hs = /^H[1-6]$/.test(b.tagName) ? [b] : [...b.querySelectorAll('h1,h2,h3,h4')];
      hs.forEach(h => { if (!h.id) h.id = 'h-' + (++hi); tocEls.push(h); });
      b.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (!h.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } });
    });
    // chunk and index
    const chars = final.map(b => (b.textContent || '').length), total = chars.reduce((a, b) => a + b, 0);
    const big = total > BIG, chunks = [];
    let ch = null, cc = 0, cb = 0;
    this.blocks = []; this.pre = []; let acc = 0;
    final.forEach((b, i) => {
      if (!ch || cc > CHUNK_CHARS || cb >= CHUNK_BLOCKS) { ch = document.createElement('section'); ch.className = 'chunk' + (big ? ' cv' : ''); chunks.push(ch); cc = 0; cb = 0; }
      b.dataset.b = i; ch.appendChild(b); cc += chars[i]; cb++;
      this.blocks.push(b); this.pre.push(acc); acc += chars[i];
    });
    this.total = Math.max(1, acc);
    this.doc.replaceChildren(...chunks);
    this.words = countWords(this.doc.textContent || '');
    this.chunks = chunks; this.big = big;
    if (big) this.estimate();
    const lv = tocEls.length ? Math.min(...tocEls.map(h => +h.tagName[1])) : 1;
    this.toc = tocEls.map(h => ({id: h.id, level: +h.tagName[1] - lv + 1, text: h.textContent.replace(/\s+/g, ' ').trim()})).filter(t => t.text);
    if (this.io) this.doc.querySelectorAll('.tw').forEach(t => this.io.observe(t)); else this.fitTables();
    return {toc: this.toc, words: this.words};
  }
  clear() { this.io && this.io.disconnect(); this.doc.replaceChildren(); this.blocks = []; this.pre = []; this.toc = []; }

  // a good guess for the height of chunks not yet drawn, so the scrollbar and the jump-to positions are right
  estimate() {
    const cs = getComputedStyle(this.doc), fs = parseFloat(cs.fontSize) || 18, lh = (parseFloat(cs.lineHeight) || fs * 1.6), w = this.doc.clientWidth || 600;
    const cpl = Math.max(20, w / (fs * 0.5));
    this.chunks.forEach(c => { const n = (c.textContent || '').length, b = c.childElementCount; c.style.setProperty('--cis', Math.round(n / cpl * lh + b * fs * 1.1) + 'px'); });
  }

  /* ---------- the anchor ---------- */
  refY() { return this.topRef(); }
  blockAtY(y) {
    const chunks = this.chunks || []; let chunk = null;
    let lo = 0, hi = chunks.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1, r = chunks[mid].getBoundingClientRect(); if (r.bottom <= y) lo = mid + 1; else { chunk = chunks[mid]; hi = mid - 1; } }
    if (!chunk) chunk = chunks[chunks.length - 1];
    if (!chunk) return null;
    for (const b of chunk.children) if (b.getBoundingClientRect().bottom > y) return b;
    return chunk.lastElementChild;
  }
  getAnchor(y = this.refY()) {
    const b = this.blockAtY(y); if (!b) return null;
    const r = b.getBoundingClientRect(), idx = +b.dataset.b;
    let c = -1;
    const yy = Math.max(y, r.top + 2), x = r.left + Math.min(24, r.width / 2);
    const pos = caretAt(x, Math.min(yy, r.bottom - 2));
    if (pos && b.contains(pos.node)) c = charOffset(b, pos.node, pos.offset);
    return {b: idx, c, f: r.height ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0};
  }
  setAnchor(a, y = this.refY()) {
    if (!a) return;
    const b = this.blocks[a.b]; if (!b) return;
    const once = () => {
      let top = null;
      if (a.c >= 0) { const r = rectAt(b, a.c); if (r) top = r.top; }
      if (top == null) { const r = b.getBoundingClientRect(); top = r.top + a.f * r.height; }
      const d = top - y; if (Math.abs(d) > 0.5) this.stage.scrollTop += d;
    };
    once(); if (this.big) { once(); requestAnimationFrame(once); }
  }
  // 0..1 through the text, by characters read (steady, whatever the layout)
  progress() {
    const a = this.getAnchor(); if (!a) return 0;
    const st = this.stage; if (st.scrollTop + st.clientHeight >= st.scrollHeight - 4) return 1;
    const len = (this.pre[a.b + 1] ?? this.total) - this.pre[a.b];
    return Math.min(1, (this.pre[a.b] + (a.c >= 0 ? Math.min(a.c, len) : a.f * len)) / this.total);
  }
  scrollToEl(el, offset = 0) { if (!el) return; const r = el.getBoundingClientRect(); this.stage.scrollTop += r.top - this.refY() - offset; requestAnimationFrame(() => { const r2 = el.getBoundingClientRect(); this.stage.scrollTop += r2.top - this.refY() - offset; }); }
  headingAt() { let cur = null; const y = this.refY() + 8; for (const t of this.toc) { const el = document.getElementById(t.id); if (!el) continue; if (el.getBoundingClientRect().top <= y) cur = t.id; else break; } return cur; }
  pageAt() { let p = 1; const y = this.refY() + 8; for (const el of this.doc.querySelectorAll('[data-page]')) { if (el.getBoundingClientRect().top <= y) p = +el.dataset.page; else break; } return p; }

  /* ---------- tables: fit, or stack into cards ---------- */
  // switching a table between grid and cards changes its height; if it sits above your reading line, keep your line still
  fitTable(tw) {
    const was = tw.classList.contains('stack'), r0 = tw.getBoundingClientRect();
    tw.classList.remove('stack'); const now = tw.scrollWidth > tw.clientWidth + 2; if (now) tw.classList.add('stack');
    if (now !== was && r0.bottom < this.refY()) this.stage.scrollTop += tw.getBoundingClientRect().height - r0.height;
  }
  fitTables(all) {
    const sr = this.stage.getBoundingClientRect();
    this.doc.querySelectorAll('.tw').forEach(t => { if (all) return this.fitTable(t); const r = t.getBoundingClientRect(); if (r.bottom > sr.top - 800 && r.top < sr.bottom + 800) this.fitTable(t); });
  }
}

function labelTable(t) {
  const rows = [...t.rows]; if (!rows.length) return;
  let head = t.tHead && t.tHead.rows[0];
  if (!head && [...rows[0].cells].every(c => c.tagName === 'TH')) head = rows[0];
  if (!head) return;
  const names = []; [...head.cells].forEach(c => { const n = Math.max(1, c.colSpan || 1); for (let i = 0; i < n; i++) names.push(c.textContent.replace(/\s+/g, ' ').trim()); });
  rows.forEach(r => { if (r === head) { if (!t.tHead) r.classList.add('hrow'); return; } let i = 0; [...r.cells].forEach(c => { if (names[i] && !c.dataset.label) c.dataset.label = names[i]; i += Math.max(1, c.colSpan || 1); }); });
  if (!t.tHead && head) { const th = t.createTHead(); th.appendChild(head); }
}
function countWords(s) { const m = s.match(/[\p{L}\p{N}]+/gu); return m ? m.length : 0; }
export function caretAt(x, y) {
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p && p.offsetNode ? {node: p.offsetNode, offset: p.offset} : null; }
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); return r ? {node: r.startContainer, offset: r.startOffset} : null; }
  return null;
}
function charOffset(block, node, offset) {
  if (node.nodeType !== 3) { // an element position: count the text before child #offset
    const kids = node.childNodes; let n = 0; const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let t;
    const stop = kids[offset] || null;
    while ((t = w.nextNode())) { if (stop && (stop === t || stop.contains(t) || (stop.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))) break; n += t.nodeValue.length; }
    return n;
  }
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let n = 0, t;
  while ((t = w.nextNode())) { if (t === node) return n + offset; n += t.nodeValue.length; }
  return -1;
}
function rectAt(block, c) {
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let n = 0, t;
  while ((t = w.nextNode())) {
    const L = t.nodeValue.length;
    if (n + L > c || (n + L === c && L)) {
      const r = document.createRange(), o = Math.max(0, Math.min(L - 1, c - n));
      r.setStart(t, o); r.setEnd(t, Math.min(L, o + 1));
      const rs = r.getClientRects(); return rs.length ? rs[0] : r.getBoundingClientRect();
    }
    n += L;
  }
  return null;
}

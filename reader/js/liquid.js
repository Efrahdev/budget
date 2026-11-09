/* LIQUID MODE: rebuilding a PDF as flowing text, the way Acrobat's Liquid Mode does.

   A PDF is a fixed picture of a page: every letter has hard x/y coordinates. To make it re-wrap we take the letters
   back out and work out what they were: which lines belong together, which are headings, lists, paragraphs.

   Two ways, per page:
   1. TAGGED PDFs (Word's "accessible PDF" export, many reports and statements) carry a hidden map saying "this is a
      heading, this is a paragraph, this is a table". When that map is there and covers the text, we follow it.
   2. Otherwise we read the layout: find the gaps between columns, group letters into lines by their baselines,
      lines into paragraphs by spacing and indentation, headings by size, lists by their bullets; then remove the
      running headers, footers and page numbers that repeat on every page, and re-join words hyphenated across lines.
   Pages with no text at all (scans) are kept as pictures, so no page is ever lost. */

const BULLET = /^\s*([•●○◦▪▫■□►▸‣⁃∙·–—*]|-(?=\s)|\(?\d{1,3}[.)](?=\s)|\(?[a-zA-Z][.)](?=\s)|\((?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\)(?=\s))\s*/;
const GLYPH = /^[•●○◦▪▫■□►▸‣⁃∙·–—*-]$/;
const END = /[.!?:;"”’)\]…]$/;
const BLOCK_ROLES = {P: 'p', Note: 'p', Caption: 'p', BibEntry: 'p', Index: 'p', Formula: 'p', Quote: 'p', TOCI: 'p', Title: 'h1', H: 'h2', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', BlockQuote: 'blockquote', Code: 'pre'};
const CONTAINER = new Set(['Document', 'DocumentFragment', 'Part', 'Sect', 'Div', 'Art', 'NonStruct', 'Private', 'Aside', 'Root', 'TOC', 'Form', 'Index']);
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const clean = s => s.replace(/­/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export async function reconstruct(pdf, {onProgress = () => {}, signal, pageImage} = {}) {
  const n = pdf.numPages, pages = [];
  for (let i = 1; i <= n; i++) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const page = await pdf.getPage(i);
    const vp = page.getViewport({scale: 1});
    const tc = await page.getTextContent({includeMarkedContent: true});
    const pg = {num: i, w: vp.width, h: vp.height};
    pg.items = items(tc, vp);
    pg.chars = pg.items.reduce((a, it) => a + it.str.trim().length, 0);
    let st = null; try { st = await page.getStructTree(); } catch (e) {}
    if (st && pg.chars) { const t = fromStruct(st, tc, vp); if (t && t.blocks.length && t.chars >= pg.chars * 0.6) pg.tagged = t.blocks; }
    if (!pg.tagged) pg.lines = pageLines(pg);
    if (pg.chars < 25 && pageImage) { try { pg.image = await pageImage(page, vp); } catch (e) {} }
    page.cleanup();
    pages.push(pg);
    onProgress(i / n, i, n);
    if (i % 6 === 0) await new Promise(r => setTimeout(r));
  }
  const textPages = pages.filter(p => p.chars >= 25).length;
  if (!textPages) return {scanned: true, pages: n};
  const ctx = stats(pages);
  stripRunning(pages, ctx);
  const html = emit(pages, ctx);
  return {html, pages: n, tagged: pages.filter(p => p.tagged).length, scannedPages: pages.filter(p => p.image).length};
}

/* ---------- text items in top-down page coordinates ---------- */
function items(tc, vp) {
  const out = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const t = mul(vp.transform, it.transform);
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.25 + 0.01 || Math.abs(t[2]) > Math.abs(t[3]) * 0.25 + 0.01) continue; // rotated text: watermarks, margin labels
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    const w = (it.width || 0) * vp.scale;
    out.push({str: clean(it.str), x: t[4], y: t[5], size, w, x2: t[4] + w, font: it.fontName, eol: it.hasEOL});
  }
  return out;
}

/* ---------- layout path ---------- */
function pageLines(pg) {
  const its = pg.items.filter(i => i.str.trim());
  const groups = columns(its, 0, pg.w, 0);
  const lines = [];
  groups.forEach((g, gi) => toLines(g).forEach(L => { L.col = gi; lines.push(L); }));
  // column edges for indentation tests
  const byCol = {}; lines.forEach(L => (byCol[L.col] = byCol[L.col] || []).push(L));
  Object.values(byCol).forEach(ls => { const xs = ls.map(l => l.x).sort((a, b) => a - b), x2 = ls.map(l => l.x2).sort((a, b) => a - b); const left = xs[Math.floor(xs.length * 0.1)], right = x2[Math.floor(x2.length * 0.9)]; ls.forEach(l => { l.left = left; l.right = right; }); });
  return lines;
}
function columns(its, x0, x1, depth) {
  if (depth > 2 || its.length < 14) return [its];
  const W = x1 - x0, B = 120, bw = W / B, cov = new Array(B).fill(0);
  for (const it of its) { const a = Math.max(0, Math.floor((it.x - x0) / bw)), b = Math.min(B - 1, Math.floor((it.x2 - x0) / bw)); for (let k = a; k <= b; k++) cov[k]++; }
  const max = Math.max(...cov); if (max < 6) return [its];
  const thr = Math.max(1, max * 0.06); let best = null;
  for (let k = Math.floor(B * 0.2); k < Math.ceil(B * 0.8); k++) {
    if (cov[k] > thr) continue;
    let e = k; while (e + 1 < B && cov[e + 1] <= thr) e++;
    const width = (e - k + 1) * bw, left = cov.slice(0, k).reduce((a, b) => a + b, 0), right = cov.slice(e + 1).reduce((a, b) => a + b, 0);
    if (width >= Math.max(5, W * 0.012) && left > 0 && right > 0) { const score = Math.min(left, right) * Math.sqrt(width); if (!best || score > best.score) best = {k, e, score}; }
    k = e;
  }
  if (!best) return [its];
  const g = x0 + ((best.k + best.e + 1) / 2) * bw, tol = bw * 0.75;
  const L = [], R = [], S = [];
  for (const it of its) { if (it.x2 <= g + tol) L.push(it); else if (it.x >= g - tol) R.push(it); else S.push(it); }
  if (L.length < 6 || R.length < 6) return [its];
  const span = a => { let lo = Infinity, hi = -Infinity; for (const i of a) { lo = Math.min(lo, i.y); hi = Math.max(hi, i.y); } return [lo, hi]; };
  const [la, lb] = span(L), [ra, rb] = span(R);
  if (Math.min(lb, rb) - Math.max(la, ra) < 0.3 * Math.min(lb - la, rb - ra)) return [its]; // stacked, not side by side
  const top = Math.min(la, ra), bottom = Math.max(lb, rb);
  const above = S.filter(i => i.y < top + 1), below = S.filter(i => i.y > bottom - 1), mid = S.filter(i => i.y >= top + 1 && i.y <= bottom - 1);
  const out = [];
  if (above.length) out.push(above);
  out.push(...columns(L, x0, g, depth + 1), ...columns(R, g, x1, depth + 1));
  if (mid.length) out.push(mid);
  if (below.length) out.push(below);
  return out;
}
function toLines(its) {
  const s = its.slice().sort((a, b) => a.y - b.y || a.x - b.x), lines = [];
  for (const it of s) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.y - L.y) <= Math.max(1.5, 0.45 * Math.max(L.size, it.size))) L.items.push(it);
    else lines.push({y: it.y, size: it.size, items: [it]});
  }
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let text = '', prev = null; const w = {};
    for (const it of L.items) {
      if (prev) { const gap = it.x - prev.x2; if (gap > 0.16 * L.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' '; }
      text += it.str; prev = it; const k = Math.round(it.size * 2) / 2; w[k] = (w[k] || 0) + it.str.trim().length;
    }
    L.text = text.replace(/\s+/g, ' ').trim();
    L.size = +Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
    L.x = L.items[0].x; L.x2 = Math.max(...L.items.map(i => i.x2));
    L.glyph = L.items.length > 1 && GLYPH.test(L.items[0].str.trim());
  }
  return lines;
}

/* ---------- whole-document facts: body text size, normal line spacing, heading sizes ---------- */
function stats(pages) {
  const w = {};
  pages.forEach(p => p.items.forEach(it => { const k = Math.round(it.size * 2) / 2; w[k] = (w[k] || 0) + it.str.trim().length; }));
  const body = +(Object.entries(w).sort((a, b) => b[1] - a[1])[0] || [10])[0] || 10;
  const gaps = [];
  pages.forEach(p => (p.lines || []).forEach((L, i, a) => { const P = a[i - 1]; if (P && P.col === L.col && Math.abs(L.size - body) < 0.6 && Math.abs(P.size - body) < 0.6) { const g = L.y - P.y; if (g > 0 && g < body * 3) gaps.push(g); } }));
  gaps.sort((a, b) => a - b);
  const lead = gaps.length ? gaps[Math.floor(gaps.length / 2)] : body * 1.25;
  const hs = {};
  pages.forEach(p => (p.lines || []).forEach(L => { if (L.size >= body * 1.15 && L.text.length <= 180) { const k = Math.round(L.size); hs[k] = (hs[k] || 0) + 1; } }));
  const sizes = Object.keys(hs).map(Number).sort((a, b) => b - a);
  const shift = sizes.length && hs[sizes[0]] === 1 ? 1 : 2; // a size used once is the document's title
  const level = sz => { const i = sizes.indexOf(Math.round(sz)); return i < 0 ? 3 : Math.min(4, i + shift); };
  return {body, lead, level};
}

/* ---------- running headers, footers and page numbers ---------- */
function stripRunning(pages, ctx) {
  const n = pages.length, PAGENUM = /^\W*(page\s*)?(\d{1,4}|[ivxlcdm]{1,6})(\s*(of|\/)\s*\d{1,4})?\W*$/i;
  const key = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const zone = (p, L) => L.y < p.h * 0.085 || L.y > p.h * 0.93;
  const count = {};
  pages.forEach(p => { const seen = new Set(); (p.lines || []).forEach(L => { if (zone(p, L)) { const k = key(L.text); if (k && !seen.has(k)) { seen.add(k); count[k] = (count[k] || 0) + 1; } } }); });
  const need = Math.max(2, Math.ceil(n * 0.35));
  pages.forEach(p => { if (p.lines) p.lines = p.lines.filter(L => !(zone(p, L) && (PAGENUM.test(L.text) || (n >= 3 && count[key(L.text)] >= need)))); });
}

/* ---------- lines -> blocks ---------- */
function layoutBlocks(p, ctx) {
  const {body, lead} = ctx, out = [];
  let cur = null, prev = null;
  for (const L of p.lines) {
    if (!L.text) continue;
    const head = L.size >= body * 1.15 && L.text.length <= 180; // big type is a heading, even when numbered ("1. Basics")
    const bm = head ? null : L.glyph ? [L.items[0].str] : BULLET.exec(L.text);
    const sameCol = prev && prev.col === L.col, gap = prev ? L.y - prev.y : 0;
    let brk = !cur;
    if (!brk) {
      if (head !== (cur.t === 'h')) brk = true;
      else if (head) brk = Math.abs(L.size - cur.size) > 0.6 || gap > L.size * 2.2 || !sameCol;
      else if (bm && L.text.length > 1) brk = true;
      else if (!sameCol) brk = !(cur.t === 'p' && !END.test(cur.text) && /^[\p{Ll}\d(]/u.test(L.text)); // a paragraph carried into the next column
      else if (gap > lead * 1.5 || gap < -2) brk = true;
      else if (Math.abs(L.size - prev.size) > body * 0.18) brk = true;
      else if (cur.t === 'p' && L.x > L.left + body * 1.1 && prev.x <= prev.left + body * 0.6) brk = true; // first-line indent
      else if (prev.x2 < prev.right - body * 3 && END.test(prev.text)) brk = true;                       // previous line stopped short
      else if (shortIndented(L, body) && shortIndented(prev, body) && Math.abs(L.x - prev.x) < 2 && /^[\p{Lu}\d"“(]/u.test(L.text)) brk = true; // one list item per line
    }
    if (brk) {
      if (head) cur = {t: 'h', level: ctx.level(L.size), size: L.size, text: L.text};
      else if (bm && L.text.length > 1) { const mark = (bm[1] || bm[0]).trim(); const text = L.glyph ? L.text.slice(L.items[0].str.length).trim() : L.text.slice(bm[0].length); cur = {t: 'li', mark, bullet: GLYPH.test(mark), text}; }
      else if (shortIndented(L, body) && L.text.length < 160) cur = {t: 'li', mark: '', bullet: true, text: L.text}; // bullets drawn as shapes, not letters
      else cur = {t: 'p', text: L.text};
      out.push(cur);
    } else cur.text = join(cur.text, L.text);
    prev = L;
  }
  return out;
}
// a line set in from the column's left edge that also stops well short of the right edge: the shape of a list item
const shortIndented = (L, body) => L.x - L.left > body * 0.9 && L.x2 < L.right - body * 2;
const join = (a, b) => (/[\p{L}]-$/u.test(a) && /^[\p{Ll}]/u.test(b)) ? a.slice(0, -1) + b : a + ' ' + b;

/* ---------- tagged path: follow the PDF's own structure map ---------- */
function fromStruct(tree, tc, vp) {
  // 1. the text of every marked-content id, joined by position
  const mc = new Map(), stack = [];
  for (const it of tc.items) {
    if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') { stack.push(it.id || null); continue; }
    if (it.type === 'endMarkedContent') { stack.pop(); continue; }
    if (typeof it.str !== 'string') continue;
    let id = null; for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) { id = stack[k]; break; }
    if (!id) continue;
    const t = mul(vp.transform, it.transform), size = Math.hypot(t[2], t[3]) || 10, x = t[4], y = t[5], x2 = x + (it.width || 0) * vp.scale;
    let m = mc.get(id);
    if (!m) { m = {s: '', first: {x, y, size}, last: null, size: 0}; mc.set(id, m); }
    if (m.last) m.s += sep(m.last, {x, y, size}, m.s, it.str);
    m.s += clean(it.str); m.last = {x2, y, size}; if (it.str.trim()) m.size = Math.max(m.size, size);
  }
  // 2. walk the structure tree
  const blocks = []; let chars = 0, prevLeaf = null;
  const leafText = node => { const m = mc.get(node.id); if (!m) return ''; let s = ''; if (prevLeaf && m.first) s = sep(prevLeaf, m.first, ' ', m.s); prevLeaf = m.last; chars += m.s.replace(/\s/g, '').length; return s + m.s; };
  const textOf = node => { if (!node) return ''; if (node.type === 'content') return leafText(node); if (node.type === 'object' || node.type === 'annotation') return ''; return (node.children || []).map(textOf).join(''); };
  const sizeOf = node => { if (!node) return 0; if (node.type === 'content') { const m = mc.get(node.id); return m ? m.size : 0; } return Math.max(0, ...(node.children || []).map(sizeOf)); };
  const push = (b) => { b.text = tidy(b.text || ''); if (b.text || b.t === 'table') blocks.push(b); };
  const list = (node, depth) => {
    for (const li of node.children || []) {
      if (li.role === 'L') { list(li, depth + 1); continue; }
      if (li.role !== 'LI') { const t = textOf(li); if (t.trim()) push({t: 'p', text: t}); continue; }
      let mark = '', text = '';
      for (const k of li.children || []) {
        if (k.role === 'Lbl') mark = tidy(textOf(k));
        else if (k.role === 'LBody') { for (const kk of k.children || []) { if (kk.role === 'L') { if (text.trim()) { push({t: 'li', depth, mark, bullet: GLYPH.test(mark) || !mark, text}); text = ''; mark = ''; } list(kk, depth + 1); } else text += textOf(kk); } }
        else if (k.role === 'L') list(k, depth + 1);
        else text += textOf(k);
      }
      if (!mark) { const bm = BULLET.exec(text); if (bm) { mark = bm[1].trim(); text = text.slice(bm[0].length); } }
      if (text.trim()) push({t: 'li', depth, mark, bullet: !mark || GLYPH.test(mark), text});
    }
  };
  const table = node => {
    const rows = [];
    const walkRows = n => { for (const k of n.children || []) { if (k.role === 'TR') rows.push((k.children || []).filter(c => c.role === 'TH' || c.role === 'TD').map(c => ({th: c.role === 'TH', text: tidy(textOf(c))}))); else if (/^(THead|TBody|TFoot)$/.test(k.role)) walkRows(k); } };
    walkRows(node);
    if (rows.length) blocks.push({t: 'table', rows, text: ''});
  };
  const walk = node => {
    const kids = node.children || []; let run = '';
    const flush = () => { if (run.trim()) push({t: 'p', text: run}); run = ''; };
    for (const k of kids) {
      if (k.type === 'content') { run += leafText(k); continue; }
      if (k.type) continue;
      const r = k.role;
      if (r === 'Artifact') continue;
      if (BLOCK_ROLES[r]) { flush(); const tag = BLOCK_ROLES[r], text = textOf(k); push(/^h/.test(tag) ? {t: 'h', level: +tag[1], text} : tag === 'pre' ? {t: 'pre', text} : tag === 'blockquote' ? {t: 'quote', text} : {t: 'p', text, size: sizeOf(k)}); continue; }
      if (r === 'L') { flush(); list(k, 0); continue; }
      if (r === 'Table') { flush(); table(k); continue; }
      if (r === 'Figure') { flush(); const t = textOf(k); if (k.alt) push({t: 'p', text: '[Figure: ' + k.alt + ']'}); else if (t.trim().length > 40) push({t: 'p', text: t}); continue; }
      if (CONTAINER.has(r) || !r) { flush(); walk(k); continue; }
      run += textOf(k); // inline roles: Span, Link, Reference, Em, Strong…
    }
    flush();
  };
  walk(tree);
  return {blocks, chars};
}
// what goes between two pieces of text, from where they sit on the page
function sep(a, b, sofar, next) {
  if (Math.abs(b.y - a.y) > 0.5 * Math.max(a.size, b.size)) return '\u0001'; // a new line
  if (/\s$/.test(sofar) || /^\s/.test(next)) return '';
  return (b.x - a.x2) > 0.16 * Math.max(a.size, b.size) ? ' ' : '';
}
const tidy = s => s.replace(/([\p{L}])-\u0001(?=\p{Ll})/gu, '$1').replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- blocks -> HTML, merging paragraphs that run across pages ---------- */
function emit(pages, ctx) {
  const all = [];
  for (const p of pages) {
    let blocks = p.tagged ? p.tagged : layoutBlocks(p, ctx);
    if (p.tagged) blocks = blocks.map(b => (b.t === 'p' && b.size >= ctx.body * 1.2 && b.text.length <= 160 && !END.test(b.text)) ? {t: 'h', level: ctx.level(b.size), text: b.text} : b);
    const last = all[all.length - 1], first = blocks[0];
    const carry = last && first && last.t === 'p' && first.t === 'p' && !END.test(last.text) && (/^[\p{Ll}\d(,;]/u.test(first.text) || /[,\-–]$/.test(last.text));
    if (carry) { last.parts.push({page: p.num}); last.text = join(last.text, first.text); last.parts.push(first.text); blocks = blocks.slice(1); all.push({t: 'mark', page: p.num, silent: true}); }
    else all.push({t: 'mark', page: p.num});
    if (p.image) all.push({t: 'img', page: p.num, src: p.image});
    for (const b of blocks) { if (b.t === 'p') b.parts = [b.text]; all.push(b); }
  }
  let html = '', listOpen = null;
  const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = null; } };
  for (const b of all) {
    if (b.t !== 'li') closeList();
    if (b.t === 'mark') { if (!b.silent) html += `<div class="pgmark" data-page="${b.page}" role="button" tabindex="0" title="Open page ${b.page} in the original layout">Page ${b.page}</div>`; continue; }
    if (b.t === 'img') { html += `<figure class="pgimg"><img src="${b.src}" alt="Page ${b.page} (scanned image)"></figure>`; continue; }
    if (b.t === 'h') { html += `<h${b.level}>${esc(b.text)}</h${b.level}>`; continue; }
    if (b.t === 'li') { const kind = b.bullet ? 'ul' : 'plain'; if (listOpen !== kind) { closeList(); html += kind === 'ul' ? '<ul>' : '<ul class="plain">'; listOpen = kind; }
      html += `<li${b.depth ? ` style="margin-left:${Math.min(4, b.depth) * 1.2}em"` : ''}>${b.bullet ? '' : `<b>${esc(b.mark)}</b> `}${esc(b.text)}</li>`; continue; }
    if (b.t === 'quote') { html += `<blockquote><p>${esc(b.text)}</p></blockquote>`; continue; }
    if (b.t === 'pre') { html += `<pre>${esc(b.text)}</pre>`; continue; }
    if (b.t === 'table') { const [h, ...rest] = b.rows; const head = h && h.some(c => c.th); const row = (r, th) => `<tr>${r.map(c => `<${th || c.th ? 'th' : 'td'}>${esc(c.text)}</${th || c.th ? 'th' : 'td'}>`).join('')}</tr>`;
      html += `<table>${head ? `<thead>${row(h, true)}</thead><tbody>${rest.map(r => row(r)).join('')}` : `<tbody>${b.rows.map(r => row(r)).join('')}`}</tbody></table>`; continue; }
    if (b.t === 'p') {
      const pieces = []; let li = -1;
      for (let x of b.parts || [b.text]) {
        if (typeof x !== 'string') { pieces.push(x); continue; }
        if (li >= 0) { if (/[\p{L}]-$/u.test(pieces[li]) && /^\p{Ll}/u.test(x)) pieces[li] = pieces[li].slice(0, -1); else x = ' ' + x; }
        pieces.push(x); li = pieces.length - 1;
      }
      html += `<p>${pieces.map(x => typeof x === 'string' ? esc(x) : `<span class="pgref" data-page="${x.page}"></span>`).join('')}</p>`;
    }
  }
  closeList();
  return html;
}

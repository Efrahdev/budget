/* Getting text out: to Notes (Markdown / HTML / plain text) and to the device (original, web page, Markdown, text, PDF). */
import {esc, coarse} from './util.js';

/* A clean copy of what is on the page, without the reader's own scaffolding. */
export function cleanClone(docEl) {
  const c = docEl.cloneNode(true);
  c.querySelectorAll('.chunk').forEach(ch => { while (ch.firstChild) ch.before(ch.firstChild); ch.remove(); });
  c.querySelectorAll('.pgmark,.pgref').forEach(e => e.remove());
  c.querySelectorAll('figure.pgimg').forEach(f => { const p = document.createElement('p'); p.innerHTML = '<em>[A scanned page: open the original PDF to see it.]</em>'; f.replaceWith(p); });
  c.querySelectorAll('.tw').forEach(w => { while (w.firstChild) w.before(w.firstChild); w.remove(); });
  c.querySelectorAll('[data-b],[data-label],[data-page]').forEach(e => { e.removeAttribute('data-b'); e.removeAttribute('data-label'); e.removeAttribute('data-page'); });
  c.querySelectorAll('tr.hrow').forEach(e => e.classList.remove('hrow'));
  c.querySelectorAll('[class=""]').forEach(e => e.removeAttribute('class'));
  c.querySelectorAll('a[target]').forEach(a => { a.removeAttribute('target'); a.removeAttribute('rel'); });
  c.querySelectorAll('img[src^="blob:"]').forEach(i => i.remove());
  return c;
}

/* ---------------- Markdown, written for the budget app's Notes renderer ----------------
   Notes understands: # headings, paragraphs (a new line = a line break), - and 1. lists, - [ ] checklists, > quotes,
   ``` code, | tables |, **bold**, *italic*, ~~strike~~, `code`, [links](https://…). Images become links. */
export function toMarkdown(root) {
  const out = []; blocks(root, out, 0);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
const BLOCKISH = /^(P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TFOOT|TR|HR|FIGURE|FIGCAPTION|DIV|SECTION|DL|DT|DD|DETAILS|SUMMARY|ARTICLE|CAPTION)$/;
function inline(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/\s+/g, ' '); continue; }
    if (n.nodeType !== 1) continue;
    const t = n.tagName;
    if (t === 'BR') { s += '\n'; continue; }
    if (t === 'IMG') { const src = n.getAttribute('src') || '', alt = (n.getAttribute('alt') || '').trim(); s += /^https?:/.test(src) ? `[Image${alt ? ': ' + alt : ''}](${src})` : alt ? `[${alt}]` : ''; continue; }
    const inner = inline(n);
    if (t === 'STRONG' || t === 'B') s += wrap(inner, '**');
    else if (t === 'EM' || t === 'I' || t === 'CITE' || t === 'DFN') s += wrap(inner, '*');
    else if (t === 'S' || t === 'DEL' || t === 'STRIKE') s += wrap(inner, '~~');
    else if (t === 'CODE' || t === 'KBD' || t === 'SAMP') { const x = n.textContent.replace(/\s+/g, ' '); s += x.includes('`') ? x : '`' + x + '`'; }
    else if (t === 'A') { const h = n.getAttribute('href') || '', txt = inner.trim(); s += /^(https?:|mailto:)/.test(h) ? (txt && txt !== h ? `[${txt.replace(/[[\]]/g, '')}](${h})` : h) : inner; }
    else if (t === 'Q') s += '“' + inner + '”';
    else s += inner;
  }
  return s;
}
function wrap(inner, m) { const lead = inner.match(/^\s*/)[0], tail = inner.match(/\s*$/)[0], core = inner.trim(); return core ? lead + m + core + m + tail : inner; }
const line = s => s.replace(/\n+/g, ' ').trim();
function blocks(el, out, depth) {
  let run = null;
  const flush = () => { if (run) { const t = inline(run).trim(); if (t) out.push(t + '\n\n'); run = null; } };
  for (const n of el.childNodes) {
    if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCKISH.test(n.tagName))) { if (n.nodeType === 3 && !n.nodeValue.trim() && !run) continue; if (!run) run = document.createElement('span'); run.appendChild(n.cloneNode(true)); continue; }
    if (n.nodeType !== 1) continue;
    flush();
    const t = n.tagName;
    if (/^H[1-6]$/.test(t)) { const x = line(inline(n)); if (x) out.push('#'.repeat(+t[1]) + ' ' + x + '\n\n'); }
    else if (t === 'P' || t === 'SUMMARY' || t === 'CAPTION') { const x = inline(n).trim(); if (x) out.push((t === 'SUMMARY' || t === 'CAPTION' ? '**' + line(x) + '**' : x) + '\n\n'); }
    else if (t === 'UL' || t === 'OL') { list(n, out, depth); if (!depth) out.push('\n'); }
    else if (t === 'BLOCKQUOTE') { const sub = []; blocks(n, sub, 0); const x = sub.join('').trim(); if (x) out.push(x.split('\n').map(l => '> ' + l).join('\n') + '\n\n'); }
    else if (t === 'PRE') out.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n');
    else if (t === 'TABLE') out.push(table(n));
    else if (t === 'HR') out.push('---\n\n');
    else if (t === 'FIGCAPTION') { const x = line(inline(n)); if (x) out.push('*' + x + '*\n\n'); }
    else if (t === 'DT') { const x = line(inline(n)); if (x) out.push('**' + x + '**\n'); }
    else if (t === 'DD') { const x = inline(n).trim(); if (x) out.push(x + '\n\n'); }
    else blocks(n, out, depth);
  }
  flush();
}
function list(ul, out, depth) {
  const ol = ul.tagName === 'OL'; let k = parseInt(ul.getAttribute('start'), 10); if (!Number.isFinite(k)) k = 1;
  for (const li of ul.children) {
    if (li.tagName !== 'LI') continue;
    const copy = li.cloneNode(true); const subs = [...copy.querySelectorAll(':scope > ul, :scope > ol')]; subs.forEach(s => s.remove());
    let x = line(inline(copy));
    const task = x.match(/^([☐☑])\s*/); if (task) x = (task[1] === '☑' ? '[x] ' : '[ ] ') + x.slice(task[0].length);
    out.push('  '.repeat(depth) + (ol ? (k++) + '. ' : '- ') + x + '\n');
    [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL').forEach(s => list(s, out, depth + 1));
  }
}
function table(t) {
  const rows = [...t.rows].map(r => [...r.cells].map(c => line(inline(c)).replace(/\|/g, '/') || ' '));
  if (!rows.length) return '';
  const w = Math.max(...rows.map(r => r.length)); rows.forEach(r => { while (r.length < w) r.push(' '); });
  const fmt = r => '| ' + r.join(' | ') + ' |';
  return [fmt(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(fmt)].join('\n') + '\n\n';
}

/* ---------------- plain text ---------------- */
export function toText(root) {
  const out = []; txtBlocks(root, out, 0);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function txtInline(n) { let s = ''; for (const c of n.childNodes) { if (c.nodeType === 3) s += c.nodeValue.replace(/\s+/g, ' '); else if (c.nodeType === 1) s += c.tagName === 'BR' ? '\n' : c.tagName === 'IMG' ? ((c.alt || '').trim() ? `[${c.alt.trim()}]` : '') : txtInline(c); } return s; }
function txtBlocks(el, out, depth) {
  let run = '';
  const flush = () => { if (run.trim()) out.push(run.trim() + '\n\n'); run = ''; };
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { run += n.nodeValue.replace(/\s+/g, ' '); continue; }
    if (n.nodeType !== 1) continue;
    if (!BLOCKISH.test(n.tagName)) { run += n.tagName === 'BR' ? '\n' : txtInline(n); continue; }
    flush();
    const t = n.tagName;
    if (t === 'UL' || t === 'OL') { let k = 1; for (const li of n.children) { const cp = li.cloneNode(true); cp.querySelectorAll('ul,ol').forEach(x => x.remove()); out.push('  '.repeat(depth) + (t === 'OL' ? (k++) + '. ' : '• ') + line(txtInline(cp)) + '\n'); li.querySelectorAll(':scope > ul, :scope > ol').forEach(s => txtBlocks({childNodes: [s]}, out, depth + 1)); } if (!depth) out.push('\n'); }
    else if (t === 'TABLE') { [...n.rows].forEach(r => out.push([...r.cells].map(c => line(txtInline(c))).join('\t') + '\n')); out.push('\n'); }
    else if (t === 'PRE') out.push(n.textContent.replace(/\n$/, '') + '\n\n');
    else if (t === 'HR') out.push('* * *\n\n');
    else if (/^(P|H[1-6]|LI|DT|DD|FIGCAPTION|SUMMARY|CAPTION)$/.test(t)) { const x = txtInline(n).trim(); if (x) out.push((/^H[12]$/.test(t) ? x.toUpperCase() : x) + '\n\n'); }
    else txtBlocks(n, out, depth);
  }
  flush();
}

/* ---------------- HTML for a note (shown inside the Notes tab's preview) ---------------- */
const NOTE_CSS = 'html{color-scheme:light dark}body{margin:0;padding:18px;font:17px/1.65 Georgia,"Iowan Old Style",serif;color:#1f1e1b;background:#fff;overflow-wrap:anywhere}article{max-width:68ch;margin:0 auto}h1,h2,h3,h4{line-height:1.2;margin:1.4em 0 .5em}h1{font-size:1.7em}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:rgba(127,127,127,.12);padding:12px;border-radius:10px;font-size:.85em}code{font-size:.88em}table{border-collapse:collapse;width:100%;font:14px/1.45 system-ui,sans-serif}td,th{border-bottom:1px solid rgba(127,127,127,.3);padding:6px 8px;text-align:left;vertical-align:top}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #2457d6;color:#555}a{color:#2457d6}@media (prefers-color-scheme:dark){body{background:#111214;color:#d9d5cc}blockquote{color:#aaa}a{color:#7fa6ff}}';
export function noteHtml(title, inner) { return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${NOTE_CSS}</style></head><body><article>${inner}</article></body></html>`; }

/* ---------------- a self-contained web page, in your current reading theme and type ---------------- */
export function standaloneHtml(title, inner) {
  const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
  const css = `:root{color-scheme:${v('color-scheme') || 'light'}}*{box-sizing:border-box}body{margin:0;background:${v('--bg')};color:${v('--ink')};padding:clamp(20px,6vw,64px) clamp(18px,5vw,40px);font-family:${v('--f-read')};font-size:clamp(17px,1rem + .3vw,20px);line-height:${v('--lead') || 1.65};-webkit-text-size-adjust:100%}
article{max-width:min(100%,${v('--measure') || '68ch'});margin:0 auto;overflow-wrap:anywhere;hyphens:auto;text-align:${v('--ta') || 'start'}}
h1,h2,h3,h4{line-height:1.2;letter-spacing:-.01em;margin:1.6em 0 .5em;text-align:start}h1{font-size:1.85em;margin-top:0}h2{font-size:1.42em}h3{font-size:1.18em}p{margin:0 0 .95em}
a{color:${v('--accent')}}img{display:block;max-width:100%;height:auto;margin:1em auto;border-radius:8px}blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid ${v('--accent')};color:${v('--ink-2')};font-style:italic}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${v('--code-bg')};padding:1em;border-radius:12px;font:.8em/1.55 ui-monospace,Menlo,Consolas,monospace}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
table{width:100%;border-collapse:collapse;font:.8em/1.45 system-ui,sans-serif}th,td{padding:.55em .7em;border-bottom:1px solid ${v('--rule')};text-align:left;vertical-align:top}th{background:${v('--bg-2')}}
hr{border:0;text-align:center;margin:2em 0}hr::after{content:"\\2022\\2003\\2022\\2003\\2022";color:${v('--ink-3')}}
@media print{body{background:#fff;color:#000;padding:0}}`;
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300..800;1,7..72,300..800&family=Inter:wght@400..700&family=Atkinson+Hyperlegible+Next:wght@300..800&display=swap">
<style>${css}</style></head><body><article>${title ? `<h1>${esc(title)}</h1>` : ''}${inner}</article></body></html>`;
}

/* ---------------- saving a file: Save As where the browser has it, the share sheet on phones, else a download ---------------- */
export async function saveBlob(blob, name, {ext, mime, desc}) {
  const file = new File([blob], name, {type: mime});
  if (window.showSaveFilePicker && !coarse()) {
    try {
      const h = await window.showSaveFilePicker({suggestedName: name, types: [{description: desc || ext.toUpperCase(), accept: {[mime]: ['.' + ext]}}]});
      const w = await h.createWritable(); await w.write(blob); await w.close(); return 'saved';
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  if (coarse() && navigator.canShare && navigator.share) {
    try { if (navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: name}); return 'shared'; } } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

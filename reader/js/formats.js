/* Turning anything into clean HTML for the reading column. */
import {sanitize} from './sanitize.js';
import {esc} from './util.js';

export const KINDS = {
  pdf: {label: 'PDF', ext: 'pdf', mime: 'application/pdf', grad: ['#e5484d', '#9f1d22']},
  html: {label: 'Web page', short: 'HTML', ext: 'html', mime: 'text/html', grad: ['#4f7dff', '#1d3fc4']},
  rich: {label: 'Rich text', short: 'RICH', ext: 'html', mime: 'text/html', grad: ['#8b5cf6', '#5b2bc4']},
  md: {label: 'Markdown', short: 'MD', ext: 'md', mime: 'text/markdown', grad: ['#14b8a6', '#0b7468']},
  txt: {label: 'Plain text', short: 'TXT', ext: 'txt', mime: 'text/plain', grad: ['#7a8496', '#454c5a']},
};

export function kindOfFile(file, head) {
  const n = (file.name || '').toLowerCase(), t = (file.type || '').toLowerCase();
  if (head && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf'; // "%PDF"
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(x?html?)$/.test(n) || t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (/\.(md|markdown|mdown|mkd|mdx)$/.test(n) || t === 'text/markdown') return 'md';
  if (/\.(txt|text|log|csv|tsv)$/.test(n) || t.startsWith('text/')) return 'txt';
  return '';
}

// Bytes -> text: UTF-8 if valid, otherwise what the file says (HTML <meta charset>), otherwise Windows-1252.
export function decode(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', {fatal: true}).decode(u8); } catch (e) {}
  const head = new TextDecoder('latin1').decode(u8.slice(0, 2048));
  const m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  try { return new TextDecoder(m ? m[1] : 'windows-1252').decode(u8); } catch (e) { return new TextDecoder('windows-1252').decode(u8); }
}

let markedP = null;
async function marked() {
  if (!markedP) markedP = import('../vendor/marked-18.1.3/marked.esm.js').then(m => { const M = new m.Marked({gfm: true, breaks: false}); return M; });
  return markedP;
}

/* kind: 'rich' (clipboard HTML), 'html' (HTML file or source), 'md', 'txt'. Returns {html, title}. */
export async function toHtml(kind, text, opts = {}) {
  if (kind === 'rich' || kind === 'html') return sanitize(text, opts);
  if (kind === 'md') {
    const M = await marked();
    const r = sanitize(M.parse(String(text || '')));
    const h = String(text || '').match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
    if (h) r.title = h[1].replace(/[*_`]/g, '').slice(0, 140);
    return r;
  }
  return plain(text);
}

// Plain text: paragraphs at blank lines; hard-wrapped lines (emails, old text files) are joined back together; lists kept.
export function plain(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const paras = src.split(/\n[ \t]*\n+/);
  const lens = src.split('\n').map(l => l.trim().length).filter(n => n > 0);
  const hard = lens.length > 6 && lens.filter(n => n >= 55 && n <= 82).length / lens.length > 0.55; // looks hard-wrapped
  const link = s => esc(s).replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, a, u) => `${a}<a href="${u}">${u}</a>`);
  const bullet = /^\s*([-*•·–]|\d{1,3}[.)])\s+/;
  let html = '';
  for (const p of paras) {
    const lines = p.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    if (lines.every(l => bullet.test(l))) {
      const ol = /^\s*\d/.test(lines[0]);
      html += `<${ol ? 'ol' : 'ul'}>${lines.map(l => `<li>${link(l.replace(bullet, ''))}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`;
      continue;
    }
    if (/^ {4}/.test(lines[0]) && lines.every(l => /^ {2}/.test(l))) { html += `<pre>${esc(lines.join('\n'))}</pre>`; continue; }
    html += `<p>${hard ? link(lines.map(l => l.trim()).join(' ')) : lines.map(l => link(l.trim())).join('<br>')}</p>`;
  }
  const first = (src.split('\n').find(l => l.trim()) || '').trim();
  return {html: html || '<p></p>', title: first.slice(0, 80)};
}

/* What did they copy? The clipboard can hold several flavours at once. */
export function detectPaste({html, text}) {
  const t = String(text || '');
  if (html && /<(p|div|h[1-6]|ul|ol|li|table|tr|td|strong|b|em|i|a|img|blockquote|pre|span|br)\b/i.test(html)) {
    // a bare wrapper around plain words (some apps do this) is not really rich
    const words = html.replace(/<[^>]+>/g, '').trim();
    if (words || /<img\b/i.test(html)) {
      const looksMd = scoreMd(t) >= 3 && !/<(h[1-6]|ul|ol|table|strong|b|em)\b/i.test(html);
      return looksMd ? 'md' : 'rich';
    }
  }
  if (looksLikeHtml(t)) return 'html';
  if (scoreMd(t) >= 2) return 'md';
  return 'txt';
}
export function looksLikeHtml(t) {
  const s = String(t || '').trim();
  const tags = (s.match(/<\/?(html|head|body|p|div|h[1-6]|ul|ol|li|table|tr|td|th|span|a|strong|em|b|i|br|img|section|article|blockquote|pre)\b[^>]*>/gi) || []).length;
  return tags >= 3 || (/^<(!doctype|html)/i.test(s));
}
function scoreMd(t) {
  const s = String(t || ''); let n = 0;
  if (/^\s{0,3}#{1,6}\s+\S/m.test(s)) n += 2;
  if (/^\s{0,3}([-*+]|\d+\.)\s+\S/m.test(s)) n += 1;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(s)) n += 1;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(s)) n += 1;
  if (/^```/m.test(s)) n += 2;
  if (/^\s*\|.+\|\s*$/m.test(s) && /^\s*\|?\s*:?-{3,}/m.test(s)) n += 2;
  if (/^\s{0,3}>\s+\S/m.test(s)) n += 1;
  return n;
}

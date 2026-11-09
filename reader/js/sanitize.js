/* The cleaner. Any HTML (pasted rich text, an .html file, HTML source, Markdown output) goes through here before it
   reaches the page. It is an ALLOWLIST: only known-safe tags and attributes survive; everything else is unwrapped
   (keep the words) or dropped (keep nothing). Then a strict Content-Security-Policy on this page refuses to run any
   script anyway: belt and braces.

   It also turns STYLING INTO MEANING. Word, Google Docs, Outlook and web pages mark bold as <span style="font-weight:700">.
   We turn that into <strong>, then throw away every style: fixed widths, nowrap, black-on-white colours. That is what lets
   night mode and the no-spill rules work on anything you paste. */

const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'HEAD', 'TITLE',
  'SVG', 'MATH', 'CANVAS', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP', 'DATALIST', 'OUTPUT', 'PROGRESS', 'METER', 'DIALOG', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK',
  'MAP', 'AREA', 'PARAM', 'PORTAL', 'SLOT', 'COLGROUP', 'COL', 'XML', 'O:P', 'W:SDT', 'V:SHAPE', 'V:IMAGEDATA']);
// tag -> tag it becomes
const KEEP = {P: 'P', H1: 'H1', H2: 'H2', H3: 'H3', H4: 'H4', H5: 'H5', H6: 'H6', BLOCKQUOTE: 'BLOCKQUOTE', PRE: 'PRE', UL: 'UL', OL: 'OL', LI: 'LI', DL: 'DL', DT: 'DT', DD: 'DD',
  TABLE: 'TABLE', THEAD: 'THEAD', TBODY: 'TBODY', TFOOT: 'TFOOT', TR: 'TR', TH: 'TH', TD: 'TD', CAPTION: 'CAPTION', FIGURE: 'FIGURE', FIGCAPTION: 'FIGCAPTION', HR: 'HR', BR: 'BR',
  IMG: 'IMG', A: 'A', STRONG: 'STRONG', B: 'STRONG', EM: 'EM', I: 'EM', U: 'U', S: 'S', STRIKE: 'S', DEL: 'DEL', INS: 'INS', MARK: 'MARK', SMALL: 'SMALL', SUB: 'SUB', SUP: 'SUP',
  CODE: 'CODE', TT: 'CODE', KBD: 'KBD', SAMP: 'SAMP', VAR: 'VAR', ABBR: 'ABBR', CITE: 'CITE', Q: 'Q', DFN: 'DFN', TIME: 'TIME', DETAILS: 'DETAILS', SUMMARY: 'SUMMARY',
  RUBY: 'RUBY', RT: 'RT', RP: 'RP', WBR: 'WBR', DIV: 'DIV', CENTER: 'DIV', SECTION: 'DIV', ARTICLE: 'DIV', MAIN: 'DIV', HEADER: 'DIV', FOOTER: 'DIV', ASIDE: 'DIV', NAV: 'DIV',
  ADDRESS: 'P', LISTING: 'PRE', XMP: 'PRE', PLAINTEXT: 'PRE', HGROUP: 'DIV'};
const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'FIGURE', 'HR', 'DIV', 'DETAILS', 'SUMMARY', 'FIGCAPTION', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD']);
const HEAD = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TH', 'STRONG', 'B', 'SUMMARY', 'DT']);
const IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const MAX_INPUT = 25 * 1024 * 1024;

function safeUrl(raw, base, forImg) {
  let v = String(raw || '').replace(/[\u0000- \u007f-\u009f]+/g, '');
  if (!v) return '';
  if (forImg && IMG_DATA.test(v)) return v.replace(/\s+/g, '');
  if (!forImg && v[0] === '#') return '#u-' + v.slice(1).replace(/[^\w\-.:]/g, '');
  let u; try { u = base ? new URL(v, base) : new URL(v); } catch (e) { return ''; }
  if (forImg) return /^https?:$/.test(u.protocol) ? u.href : '';
  return /^(https?:|mailto:|tel:)$/.test(u.protocol) ? u.href : '';
}
const num = (v, max) => { const n = parseInt(v, 10); return n > 0 && n <= max ? String(n) : ''; };
const LANG = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/;

/* Returns {html, title}. Input: an HTML string. Options: base (to resolve relative links of a saved web page). */
export function sanitize(input, opts = {}) {
  let src = String(input || '');
  if (src.length > MAX_INPUT) src = src.slice(0, MAX_INPUT);
  // clipboard HTML from Windows carries a header and <!--StartFragment--> markers; keep just the fragment when present
  const sf = src.indexOf('<!--StartFragment-->'), ef = src.lastIndexOf('<!--EndFragment-->');
  const whole = src;
  if (sf >= 0 && ef > sf) src = src.slice(sf + 20, ef);
  const doc = new DOMParser().parseFromString(src, 'text/html'); // an inert document: nothing runs, nothing loads
  let title = '';
  try { const t = new DOMParser().parseFromString(whole, 'text/html').querySelector('title'); title = (t && t.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
  const out = document.implementation.createHTMLDocument('');
  const root = out.createElement('div');
  walk(doc.body, root, out, opts);
  wordLists(root, out);
  tidy(root);
  if (!title) { const h = root.querySelector('h1,h2'); title = h ? h.textContent.replace(/\s+/g, ' ').trim() : ''; }
  if (!title) title = (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  return {html: root.innerHTML, title: title.slice(0, 140)};
}

function walk(from, to, out, opts) {
  for (const n of [...from.childNodes]) {
    if (n.nodeType === 3) { to.appendChild(out.createTextNode(n.nodeValue)); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (tag.includes(':')) { if (/^(O|V):/.test(tag)) continue; walk(n, to, out, opts); continue; } // Office's own tags: drop shapes and o:p, keep words
    if (tag === 'INPUT') { const ty = (n.getAttribute('type') || '').toLowerCase(); if (ty === 'checkbox' || ty === 'radio') to.appendChild(out.createTextNode(n.hasAttribute('checked') ? '☑ ' : '☐ ')); continue; }
    const style = n.getAttribute('style') || '';
    if (/mso-list:\s*ignore/i.test(style)) continue;                       // Word's fake bullet characters
    if (/display:\s*none|visibility:\s*hidden/i.test(style)) continue;     // hidden text stays hidden
    const cls = (n.getAttribute('class') || '');
    // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid…">: not bold at all
    const fakeBold = tag === 'B' && (/font-weight:\s*(normal|[1-5]00)\b/i.test(style) || /^docs-internal-guid/.test(n.id || ''));
    let target = KEEP[tag];
    if (fakeBold) target = null;
    // build the element (or nothing, to unwrap)
    let el = null;
    if (target) {
      el = out.createElement(target);
      copyAttrs(n, el, tag, opts);
      if (target === 'P' && (/MsoListParagraph/i.test(cls) || /mso-list:\s*l\d/i.test(style))) {
        const m = style.match(/level(\d)/i); el.setAttribute('data-wl', m ? m[1] : '1');
        const ign = n.querySelector('[style*="mso-list"]'); const mark = ign ? ign.textContent.trim() : '';
        el.setAttribute('data-wo', /^(\(?[0-9]+|[a-z]{1,3}|[ivxlc]+)[.)]/i.test(mark) ? '1' : '0');
      }
    }
    // style -> meaning (only when the tag doesn't already say it)
    const wrappers = [];
    if (style) {
      const fw = (style.match(/font-weight:\s*([a-z0-9]+)/i) || [])[1];
      if (fw && (fw === 'bold' || fw === 'bolder' || +fw >= 600) && !HEAD.has(tag)) wrappers.push('STRONG');
      if (/font-style:\s*italic/i.test(style) && tag !== 'I' && tag !== 'EM') wrappers.push('EM');
      const td = (style.match(/text-decoration(?:-line)?:\s*([^;]+)/i) || [])[1] || '';
      if (/underline/i.test(td) && tag !== 'U' && tag !== 'A') wrappers.push('U');
      if (/line-through/i.test(td) && tag !== 'S' && tag !== 'DEL') wrappers.push('S');
      const va = (style.match(/vertical-align:\s*(super|sub)/i) || [])[1];
      if (va && tag !== 'SUP' && tag !== 'SUB') wrappers.push(va.toLowerCase() === 'super' ? 'SUP' : 'SUB');
    }
    let inner = el || out.createDocumentFragment(), host = inner;
    for (const w of wrappers) { const x = out.createElement(w); host.appendChild(x); host = x; }
    if (tag !== 'IMG' && tag !== 'BR' && tag !== 'HR' && tag !== 'WBR') walk(n, host, out, opts);
    if (tag === 'IMG' && !el.getAttribute('src')) { const alt = (n.getAttribute('alt') || '').trim(); if (alt) to.appendChild(out.createTextNode('[' + alt.slice(0, 200) + ']')); continue; } // an image we may not show: keep its words
    to.appendChild(inner);
  }
}

function copyAttrs(n, el, tag, opts) {
  const a = k => n.getAttribute(k);
  const lang = a('lang'); if (lang && LANG.test(lang)) el.setAttribute('lang', lang);
  const dir = (a('dir') || '').toLowerCase(); if (dir === 'rtl' || dir === 'ltr' || dir === 'auto') el.setAttribute('dir', dir);
  const id = a('id') || (tag === 'A' && a('name')); if (id && /^[\w\-.:]{1,80}$/.test(id) && !/^docs-internal/.test(id)) el.setAttribute('id', 'u-' + id);
  switch (tag) {
    case 'A': { const h = safeUrl(a('href'), opts.base, false); if (h) el.setAttribute('href', h); const t = a('title'); if (t) el.setAttribute('title', t.slice(0, 300)); break; }
    case 'IMG': { const s = safeUrl(a('src'), opts.base, true); if (s) el.setAttribute('src', s); const alt = a('alt'); el.setAttribute('alt', alt ? alt.slice(0, 500) : '');
      const w = num(a('width'), 6000), h = num(a('height'), 6000); if (w) el.setAttribute('width', w); if (h) el.setAttribute('height', h);
      const t = a('title'); if (t) el.setAttribute('title', t.slice(0, 300)); el.setAttribute('loading', 'lazy'); el.setAttribute('decoding', 'async'); el.setAttribute('referrerpolicy', 'no-referrer'); break; }
    case 'TD': case 'TH': { const c = num(a('colspan'), 50), r = num(a('rowspan'), 200); if (c && c !== '1') el.setAttribute('colspan', c); if (r && r !== '1') el.setAttribute('rowspan', r); const sc = a('scope'); if (/^(row|col|rowgroup|colgroup)$/.test(sc || '')) el.setAttribute('scope', sc); break; }
    case 'OL': { const s = parseInt(a('start'), 10); if (Number.isFinite(s) && s !== 1) el.setAttribute('start', String(s)); if (n.hasAttribute('reversed')) el.setAttribute('reversed', ''); const ty = a('type'); if (/^[1aAiI]$/.test(ty || '')) el.setAttribute('type', ty); break; }
    case 'LI': { const v = parseInt(a('value'), 10); if (Number.isFinite(v)) el.setAttribute('value', String(v)); break; }
    case 'ABBR': case 'DFN': { const t = a('title'); if (t) el.setAttribute('title', t.slice(0, 300)); break; }
    case 'TIME': { const d = a('datetime'); if (d && d.length < 60) el.setAttribute('datetime', d); break; }
    case 'DETAILS': if (n.hasAttribute('open')) el.setAttribute('open', ''); break;
    case 'CODE': case 'PRE': { const c = (n.getAttribute('class') || '').match(/\blang(?:uage)?-([\w+#-]{1,20})/); if (c) el.setAttribute('data-lang', c[1]); break; }
  }
}

// Word's lists arrive as paragraphs with a hidden bullet; make them real lists again.
function wordLists(root, out) {
  for (const p of [...root.querySelectorAll('p[data-wl]')]) {
    if (!p.parentNode || !p.hasAttribute('data-wl')) continue;
    const ordered = p.getAttribute('data-wo') === '1', list = out.createElement(ordered ? 'ol' : 'ul');
    p.before(list);
    let cur = p;
    while (cur && cur.nodeType === 1 && cur.tagName === 'P' && cur.hasAttribute('data-wl')) {
      const next = cur.nextElementSibling, li = out.createElement('li');
      while (cur.firstChild) li.appendChild(cur.firstChild);
      li.firstChild && li.firstChild.nodeType === 3 && (li.firstChild.nodeValue = li.firstChild.nodeValue.replace(/^[\s ]+/, ''));
      list.appendChild(li); cur.remove(); cur = next;
    }
  }
  root.querySelectorAll('[data-wl],[data-wo]').forEach(e => { e.removeAttribute('data-wl'); e.removeAttribute('data-wo'); });
}

const isBlank = el => !el.textContent.replace(/[\s ​]+/g, '') && !el.querySelector('img,hr,br + br');
function tidy(root) {
  // a DIV holding only inline content is a paragraph; one holding blocks is just a box
  for (const d of [...root.querySelectorAll('div')].reverse()) {
    if (![...d.children].some(c => BLOCK.has(c.tagName))) {
      if (isBlank(d) && !d.querySelector('img')) { d.remove(); continue; }
      const p = d.ownerDocument.createElement('p'); for (const at of [...d.attributes]) p.setAttribute(at.name, at.value); while (d.firstChild) p.appendChild(d.firstChild); d.replaceWith(p);
    } else { while (d.firstChild) d.before(d.firstChild); d.remove(); }
  }
  // empty inline wrappers and empty paragraphs go; runs of <br> shrink to one blank line
  for (const e of [...root.querySelectorAll('strong,em,u,s,del,ins,mark,small,sub,sup,code,span,a:not([id])')].reverse()) if (!e.textContent && !e.querySelector('img')) e.remove();
  for (const p of [...root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote')]) {
    while (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
    while (p.lastChild && p.lastChild.nodeName === 'BR') p.lastChild.remove();
    if (p.tagName !== 'LI' && isBlank(p) && !p.querySelector('img')) p.remove();
  }
  root.querySelectorAll('br + br + br').forEach(b => b.remove());
  // nested paragraphs inside a lone list item read better flat
  root.querySelectorAll('li > p:only-child').forEach(p => { while (p.firstChild) p.before(p.firstChild); p.remove(); });
}

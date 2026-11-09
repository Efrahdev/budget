/* Reader: the conductor. Library → open or paste → read (flow, or PDF Original / Liquid) → save to Notes or device. */
import {$, $$, esc, clamp, uid, debounce, rafThrottle, bytes, when, isTyping, coarse, toast, hideToast, hue, safeName, nextFrame} from './util.js';
import {prefs, setPref, savePrefs, applyPrefs, SCALE_MIN, SCALE_MAX} from './prefs.js';
import * as store from './store.js';
import * as bridge from './bridge.js';
import {KINDS, kindOfFile, decode, toHtml, detectPaste, looksLikeHtml} from './formats.js';
import {Flow} from './flow.js';
import {attachZoom} from './zoom.js';
import {FlowSearch} from './search.js';
import {cleanClone, toMarkdown, toText, noteHtml, standaloneHtml, saveBlob} from './exporter.js';

const LIQ_VER = 1, MAX_PDF = 300 * 1048576, MAX_TEXT = 30 * 1048576;
const H = document.documentElement;
const el = {home: $('#home'), reader: $('#reader'), stage: $('#stage'), doc: $('#doc'), pdfStage: $('#pdfStage'), pdfViewer: $('#pdfViewer'), bar: $('#bar'), barIn: $('.bar-in'),
  foot: $('#foot'), progT: $('#progT'), leftT: $('#leftT'), progBar: $('#progBar'), hud: $('#hud'), title: $('#docTitle'), metaT: $('#docMeta'), modeSeg: $('#modeSeg'),
  searchbar: $('#searchbar'), q: $('#q'), qCount: $('#qCount'), busy: $('#busy'), busyT: $('#busyT'), busyBar: $('#busyBar'), busyCancel: $('#busyCancel'),
  liquidNote: $('#liquidNote'), docEnd: $('#docEnd'), toc: $('#tocDrawer'), tocList: $('#tocList'), scrim: $('#scrim'), menu: $('#exportMenu'), fileIn: $('#fileIn')};
const S = {meta: null, body: null, mode: 'flow', pdf: null, pv: null, liquid: null, outline: null, toc: [], chrome: true, immersive: false, searchOpen: false, lastAnchor: null,
  paste: null, pasteFmt: '', noteFmt: 'md', noteCat: '', fileFmt: '', abort: null, wake: null, pdfLib: null, lastP: 0, lastPT: 0};
let refY = 80;
const flow = new Flow(el.stage, el.doc, () => refY);
const search = new FlowSearch(flow);

/* ================= start ================= */
applyPrefs();
if (!bridge.embedded) $('#toBudget').hidden = false;
bridge.hello();
renderLibrary();
measure();
if (location.hash === '#paste') openPaste();

/* ================= library ================= */
async function renderLibrary() {
  let docs = []; try { docs = await store.listDocs(); } catch (e) {}
  const list = $('#libList');
  if (!docs.length) { list.innerHTML = '<div class="lib-empty">Nothing here yet. Open a file or paste something, and it will be kept here, on this device only, with your place remembered.</div>'; $('#libUse').textContent = ''; return; }
  list.innerHTML = docs.map(d => {
    const k = KINDS[d.kind] || KINDS.txt, h = hue(d.title || d.id);
    const g = `linear-gradient(160deg, color-mix(in oklab, ${k.grad[0]} 78%, hsl(${h} 70% 50%)), ${k.grad[1]})`;
    const pct = Math.round((d.progress || 0) * 100);
    return `<div class="item" role="button" tabindex="0" data-act="lib-open" data-id="${esc(d.id)}" aria-label="${esc(d.title)}">
      <div class="cover" style="background:${g}"><b>${esc(d.title || 'Untitled')}</b><small>${esc(k.short || k.label)}</small></div>
      <div class="item-t"><b>${esc(d.title || 'Untitled')}</b><small>${esc([k.label, d.pages ? d.pages + ' pages' : '', bytes(d.size), when(d.openedAt)].filter(Boolean).join(' · '))}</small>
        <div class="item-p" title="${pct}% read"><i style="width:${pct}%"></i></div></div>
      <button type="button" class="ibtn sm item-x" data-act="lib-del" data-id="${esc(d.id)}" aria-label="Remove from library"><svg class="ic" aria-hidden="true"><use href="#r-trash"/></svg></button></div>`;
  }).join('');
  store.usage().then(u => { $('#libUse').textContent = u ? `${docs.length} item${docs.length === 1 ? '' : 's'} · ${bytes(u)} on this device` : ''; });
}

/* ================= opening ================= */
async function openFile(file) {
  if (!file) return;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const kind = kindOfFile(file, head);
  if (!kind) return toast('That kind of file can’t be read here. Try a PDF, web page, Markdown or text file.', {kind: 'bad'});
  if (file.size > (kind === 'pdf' ? MAX_PDF : MAX_TEXT)) return toast(`That file is too large (${bytes(file.size)}).`, {kind: 'bad'});
  const meta = {id: uid(), title: (file.name || 'Untitled').replace(/\.[^.]+$/, ''), name: file.name, kind, fmt: kind, source: 'file', mime: file.type || KINDS[kind].mime, size: file.size, createdAt: Date.now(), openedAt: Date.now(), progress: 0};
  const blob = file.slice(0, file.size, meta.mime);
  try { await store.putDoc(meta, blob); } catch (e) { toast('Couldn’t keep a copy on this device; opening it anyway.'); }
  openRecord(meta, blob);
}
async function openRecord(meta, body) {
  closeAllPanels(); hideToast();
  S.meta = meta; S.mode = 'flow'; S.liquid = null; S.outline = null; S.toc = []; S.lastAnchor = null;
  el.title.textContent = meta.title || 'Untitled'; document.title = (meta.title || 'Untitled') + ' · Reader';
  el.metaT.textContent = (KINDS[meta.kind] || KINDS.txt).label + (meta.size ? ' · ' + bytes(meta.size) : '');
  el.modeSeg.hidden = meta.kind !== 'pdf';
  el.home.hidden = true; el.reader.hidden = false; setChrome(true);
  if (!bridge.embedded && history.state?.doc !== meta.id) history.pushState({doc: meta.id}, '');
  measure();
  try {
    body = body ?? await store.getBody(meta.id);
    if (body == null) throw new Error('missing');
    S.body = body;
    if (meta.kind === 'pdf') await openPdfDoc(meta, body); else await openFlowDoc(meta, body);
    store.patchDoc(meta.id, {openedAt: Date.now()}).catch(() => {});
    wake(true);
    el.stage.focus({preventScroll: true});
  } catch (e) {
    busy(false);
    if (e && e.name === 'AbortError') return goHome();
    console.error(e);
    toast(e && e.message === 'missing' ? 'This item is no longer on this device.' : 'Couldn’t open this: ' + (e && e.message || 'unknown problem'), {kind: 'bad', ms: 6000});
    goHome();
  }
}
async function openFlowDoc(meta, body) {
  busy('Setting the type…');
  const text = body instanceof Blob ? decode(await body.arrayBuffer()) : body.text;
  const r = await toHtml(meta.fmt, text);
  if (meta.source === 'file' && r.title && meta.kind === 'html' && r.title.length > 3 && r.title !== meta.title) { meta.title = r.title; el.title.textContent = r.title; store.patchDoc(meta.id, {title: r.title}).catch(() => {}); }
  await mountFlow(r.html, meta.anchor);
  busy(false);
}
async function mountFlow(html, anchor, liquid) {
  el.pdfStage.hidden = true; el.stage.hidden = false;
  el.stage.scrollTop = 0;
  const r = flow.mount(html);
  S.toc = r.toc;
  el.docEnd.hidden = false;
  el.liquidNote.hidden = !liquid;
  await nextFrame();
  flow.fitTables();
  if (anchor) { flow.setAnchor(anchor); S.lastAnchor = anchor; }
  progress();
}

/* ================= PDF ================= */
async function pdfLib() { if (!S.pdfLib) S.pdfLib = import('./pdfdoc.js'); return S.pdfLib; }
async function openPdfDoc(meta, blob) {
  busy('Opening the PDF…');
  const P = await pdfLib();
  const buf = await blob.arrayBuffer();
  S.pdf = await P.openPdf(buf, {askPassword: wrong => ask(wrong ? 'Wrong password' : 'This PDF is locked', wrong ? 'That password didn’t work. Try again.' : 'Enter its password to open it. It isn’t stored.', 'Password')});
  if (!S.pdf) throw new DOMException('Cancelled', 'AbortError');
  if (!meta.pages) { meta.pages = S.pdf.numPages; store.patchDoc(meta.id, {pages: meta.pages}).catch(() => {}); }
  P.meta(S.pdf).then(m => { if (m.title && m.title.length > 3 && !/^(untitled|microsoft word|document\d*)/i.test(m.title) && meta.title === (meta.name || '').replace(/\.[^.]+$/, '')) { meta.title = m.title; el.title.textContent = m.title; store.patchDoc(meta.id, {title: m.title}).catch(() => {}); } });
  el.metaT.textContent = `PDF · ${S.pdf.numPages} page${S.pdf.numPages === 1 ? '' : 's'} · ${bytes(meta.size)}`;
  let mode = meta.mode;
  if (!mode) mode = 'page';
  await setPdfMode(mode, true);
  busy(false);
  if (!meta.mode && innerWidth < 700 && !prefs.liquidHint) { prefs.liquidHint = 1; savePrefs(); toast('Small screen? Liquid mode re-flows this PDF to fit it.', {action: 'Try Liquid', onAction: () => setPdfMode('liquid')}); }
}
async function ensureLiquid() {
  if (S.liquid) return S.liquid;
  const key = S.meta.id + ':liquid';
  try { const c = await store.getBody(key); if (c && c.v === LIQ_VER) return (S.liquid = c); } catch (e) {}
  const P = await pdfLib(), {reconstruct} = await import('./liquid.js');
  S.abort = new AbortController();
  busy('Rebuilding the text for Liquid mode…', true);
  try {
    const r = await reconstruct(S.pdf, {signal: S.abort.signal, onProgress: (f, i, n) => { el.busyBar.style.width = (f * 100).toFixed(1) + '%'; el.busyT.textContent = `Rebuilding the text · page ${i} of ${n}`; },
      pageImage: async (page, vp) => { const sc = Math.min(2, 1100 / vp.width), v = page.getViewport({scale: sc}), c = document.createElement('canvas'); c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
        await page.render({canvasContext: c.getContext('2d'), viewport: v}).promise; const u = c.toDataURL('image/jpeg', 0.8); c.width = c.height = 0; return u; }});
    r.v = LIQ_VER; S.liquid = r;
    if (!r.scanned) store.putBody(key, r).catch(() => {});
    return r;
  } finally { S.abort = null; busy(false); }
}
async function setPdfMode(mode, opening) {
  if (!S.pdf) return;
  const from = S.mode, meta = S.meta;
  let page = 1;
  if (!opening) page = from === 'page' && S.pv ? S.pv.page : from === 'liquid' ? flow.pageAt() : 1;
  if (mode === 'liquid') {
    let r; try { r = await ensureLiquid(); } catch (e) { if (e.name === 'AbortError') { toast('Liquid mode cancelled.'); if (opening) mode = 'page'; else return; } else throw e; }
    if (r && r.scanned) { toast('This PDF is scanned pictures of pages, with no text inside to re-flow. Showing the original.', {ms: 6000}); mode = 'page'; }
  }
  S.mode = mode;
  $$('#modeSeg .segb').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
  closeSearch();
  if (mode === 'page') {
    el.stage.hidden = true; el.pdfStage.hidden = false;
    const P = await pdfLib();
    if (!S.pv) {
      S.pv = new P.PageView(el.pdfStage, el.pdfViewer, S.pdf, {onPage: () => progress(), onView: () => savePos(), onFind: (m, st) => pdfFindCount(m, st)});
      await S.pv.init(opening ? meta.pdfState || {} : {page});
    } else if (!opening) S.pv.goPage(page);
    S.toc = [];
    el.pdfStage.focus({preventScroll: true});
  } else {
    const r = S.liquid;
    el.liquidNote.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#r-liquid"/></svg><span><b>Liquid mode.</b> Rebuilt from ${r.pages} page${r.pages === 1 ? '' : 's'}${r.tagged ? (r.tagged === r.pages ? ', following the PDF’s own structure map' : `, ${r.tagged} using the PDF’s structure map`) : ''}${r.scannedPages ? `; ${r.scannedPages} scanned page${r.scannedPages === 1 ? ' is' : 's are'} shown as pictures` : ''}. Tables and forms read best in <button type="button" class="link" data-act="mode" data-v="page" style="padding:0">Original</button>. Tap a page divider to see that page.</span>`;
    await mountFlow(r.html, opening && meta.mode === 'liquid' ? meta.anchor : null, true);
    if (!opening && page > 1) { const m = el.doc.querySelector(`[data-page="${page}"]`); if (m) flow.scrollToEl(m, 8); }
    el.stage.focus({preventScroll: true});
  }
  meta.mode = mode; store.patchDoc(meta.id, {mode}).catch(() => {});
  progress();
}

/* ================= paste ================= */
const pdlg = $('#pasteDlg'), ptarget = $('#pasteTarget');
async function openPaste(pre) {
  S.paste = null; S.pasteFmt = '';
  ptarget.innerHTML = ''; ptarget.hidden = false; $('#pasteFound').hidden = true; $('#fmtSeg').hidden = true; $('#pastePreview').hidden = true; $('#pasteNameF').hidden = true; $('#pasteRead').disabled = true;
  if (!pdlg.open) pdlg.showModal();
  if (pre) return setPaste(pre);
  // one tap: read the clipboard directly where the browser allows it
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read(); let html = '', text = '';
      for (const it of items) { if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text(); if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text(); }
      if (html || text) return setPaste({html, text});
    } catch (e) {}
  } else if (navigator.clipboard && navigator.clipboard.readText) { try { const text = await navigator.clipboard.readText(); if (text) return setPaste({html: '', text}); } catch (e) {} }
  ptarget.focus();
}
ptarget.addEventListener('paste', e => { const d = e.clipboardData; if (!d) return; e.preventDefault(); setPaste({html: d.getData('text/html'), text: d.getData('text/plain')}); });
ptarget.addEventListener('input', debounce(() => { if (S.paste || !ptarget.textContent.trim()) return; setPaste({html: ptarget.innerHTML, text: ptarget.innerText}); }, 500));
function setPaste(d) {
  if (!d.text && d.html) { const t = document.createElement('div'); t.innerHTML = d.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''); d.text = t.textContent; }
  if (!(d.html || '').trim() && !(d.text || '').trim()) return toast('The clipboard is empty. Copy something first.');
  S.paste = d;
  ptarget.hidden = true;
  const found = $('#pasteFound'); found.hidden = false;
  const n = (d.html || d.text).length;
  found.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#r-check"/></svg><span>Found <b>${d.html ? 'formatted text' : 'plain text'}</b> · ${bytes(n)}${d.html && d.text ? ' (with a plain-text copy)' : ''}</span>`;
  $('#fmtSeg').hidden = false;
  $('#fmtSeg [data-v="rich"]').disabled = !d.html;
  setPasteFmt(detectPaste(d));
  $('#pasteNameF').hidden = false; $('#pasteRead').disabled = false;
}
function pasteSource(fmt) { const d = S.paste; if (fmt === 'rich') return d.html; if (fmt === 'html') return looksLikeHtml(d.text) || !d.html ? d.text : d.html; return d.text || ''; }
const previewPaste = debounce(async () => {
  if (!S.paste) return; const fmt = S.pasteFmt, r = await toHtml(fmt, pasteSource(fmt).slice(0, 60000));
  const pv = $('#pastePreview'); pv.hidden = false; pv.innerHTML = r.html; pv.querySelectorAll('a').forEach(a => a.removeAttribute('href'));
  const name = $('#pasteName'); if (!name.dataset.touched) name.value = r.title || 'Pasted text';
}, 120);
function setPasteFmt(f) { S.pasteFmt = f; $$('#fmtSeg .fmtb').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === f))); previewPaste(); }
$('#pasteName').addEventListener('input', e => { e.target.dataset.touched = '1'; });
async function pasteRead() {
  if (!S.paste) return;
  const fmt = S.pasteFmt, text = pasteSource(fmt), title = ($('#pasteName').value || '').trim() || 'Pasted text';
  delete $('#pasteName').dataset.touched;
  const meta = {id: uid(), title, kind: fmt, fmt, source: 'paste', size: new Blob([text]).size, createdAt: Date.now(), openedAt: Date.now(), progress: 0};
  pdlg.close();
  try { await store.putDoc(meta, {text, fmt}); } catch (e) {}
  openRecord(meta, {text, fmt});
}

/* ================= the reading surface: chrome, progress, position ================= */
function measure() { const b = el.barIn; refY = (b.offsetTop || 8) + (b.offsetHeight || 52) + (S.searchOpen ? el.searchbar.offsetHeight + 8 : 0) + 14; H.style.setProperty('--barh', (b.offsetHeight || 52) + 'px'); }
function setChrome(on) {
  if (S.chrome === on && H.classList.contains(on ? 'chrome-on' : 'chrome-off')) return;
  S.chrome = on; H.classList.toggle('chrome-off', !on); H.classList.toggle('chrome-on', on);
  hostBars();
}
// the budget app's bars step aside while you read, and whenever one of our sheets is open (so they never cover its buttons)
function hostBars() { bridge.setBars((!S.chrome && !el.reader.hidden) || !!document.querySelector('dialog[open]')); }
{ const mo = new MutationObserver(hostBars); $$('dialog').forEach(d => mo.observe(d, {attributes: true, attributeFilter: ['open']})); }
const progress = rafThrottle(() => {
  if (el.reader.hidden || !S.meta) return;
  let p = 0, left = '';
  if (S.mode === 'page' && S.pv) { const n = S.pdf.numPages, pg = S.pv.page || 1; p = n > 1 ? (pg - 1) / (n - 1) : 1; el.progT.textContent = `Page ${pg} of ${n}`; left = `${Math.round(p * 100)}%`; }
  else {
    p = flow.progress(); const wl = Math.max(0, Math.round(flow.words * (1 - p))), m = Math.ceil(wl / (prefs.wpm || 230));
    el.progT.textContent = `${Math.round(p * 100)}%`;
    left = p >= 0.995 ? 'Finished' : wl < (prefs.wpm || 230) * 0.75 ? 'Less than a minute left' : m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
    if (S.mode === 'liquid' && S.pdf) left = `Page ${flow.pageAt()} of ${S.pdf.numPages} · ` + left;
    learnPace(p);
  }
  el.leftT.textContent = left;
  el.progBar.style.width = (p * 100).toFixed(2) + '%';
  S.progress = p;
});
// learn your reading speed from your own scrolling, so "time left" becomes yours
function learnPace(p) {
  const now = Date.now();
  if (!S.lastPT) { S.lastPT = now; S.lastP = p; return; }
  const dt = (now - S.lastPT) / 1000; if (dt < 12) return;
  const dw = (p - S.lastP) * flow.words; S.lastPT = now; S.lastP = p;
  if (document.visibilityState !== 'visible' || dt > 90 || dw <= 0) return;
  const wpm = dw / dt * 60;
  if (wpm > 90 && wpm < 600) { prefs.wpm = Math.round(clamp((prefs.wpm || 230) * 0.85 + wpm * 0.15, 120, 500)); savePrefs(); }
}
const savePos = debounce(() => {
  if (!S.meta || el.reader.hidden) return;
  const patch = {progress: S.progress || 0, mode: S.mode};
  if (S.mode === 'page' && S.pv) patch.pdfState = S.pv.state(); else { const a = flow.getAnchor(); if (a) { patch.anchor = a; S.lastAnchor = a; } }
  Object.assign(S.meta, patch);
  store.patchDoc(S.meta.id, patch).catch(() => {});
}, 700);
const keepAnchor = debounce(() => { if (S.mode !== 'page' && !el.reader.hidden) S.lastAnchor = flow.getAnchor(); }, 120);
// scrolling hides the controls; scrolling back up, or a tap, brings them back
{
  let lastY = 0, acc = 0;
  const onScroll = e => {
    const t = e.currentTarget, y = t.scrollTop, d = y - lastY; lastY = y;
    progress(); savePos(); keepAnchor();
    if (S.searchOpen || !el.menu.hidden || Date.now() - userAt > 900) return; // only your own scrolling hides the controls
    if (y < 40) { acc = 0; if (!S.immersive) setChrome(true); return; }
    acc = (d > 0) === (acc > 0) ? acc + d : d;
    if (acc > 36) setChrome(false); else if (acc < -60 && !S.immersive) setChrome(true);
  };
  let userAt = 0; const touched = () => { userAt = Date.now(); };
  ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach(t => { el.stage.addEventListener(t, touched, {passive: true}); el.pdfStage.addEventListener(t, touched, {passive: true}); });
  el.stage.addEventListener('scroll', onScroll, {passive: true});
  el.pdfStage.addEventListener('scroll', onScroll, {passive: true});
  let down = null;
  const tapStart = e => { if (e.isPrimary) down = {x: e.clientX, y: e.clientY, t: Date.now()}; };
  const tapEnd = e => {
    if (!down || !e.isPrimary) return; const d = down; down = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.t > 380) return;
    if (e.target.closest('a,button,input,summary,.pgmark,[role=button],.annotationLayer section')) return;
    if (String(getSelection()).length) return;
    setChrome(!S.chrome);
  };
  [el.stage, el.pdfStage].forEach(s => { s.addEventListener('pointerdown', tapStart); s.addEventListener('pointerup', tapEnd); });
}
window.addEventListener('resize', rafThrottle(() => {
  measure();
  if (el.reader.hidden || S.mode === 'page') return;
  const a = S.lastAnchor; flow.estimate && flow.big && flow.estimate(); if (a) flow.setAnchor(a); flow.fitTables(); progress();
}));
if (document.fonts) document.fonts.addEventListener('loadingdone', () => { if (!el.reader.hidden && S.mode !== 'page' && S.lastAnchor) { flow.setAnchor(S.lastAnchor); flow.fitTables(); } });

/* ================= zoom: pinch, trackpad, keys ================= */
let z = null;
function hud(text) { el.hud.textContent = text; el.hud.classList.add('on'); clearTimeout(hud.t); hud.t = setTimeout(() => el.hud.classList.remove('on'), 650); }
function setScale(s, anchorY) {
  s = Math.round(clamp(s, SCALE_MIN, SCALE_MAX) * 100) / 100;
  const a = anchorY != null && z ? z.a : flow.getAnchor(anchorY ?? refY);
  prefs.scale = s; H.style.setProperty('--rz', s);
  flow.setAnchor(a, anchorY ?? refY);
  $('#zoomVal').textContent = Math.round(s * 100) + '%';
  hud(Math.round(s * 100) + '%');
}
// after a zoom: re-estimate the size of unread sections, THEN put your sentence back (estimates above it move it)
const zoomEnd = debounce(() => { savePrefs(); const za = S.zoomAnchor; S.zoomAnchor = null; const a = za ? za.a : flow.getAnchor(); if (flow.big) flow.estimate(); flow.setAnchor(a, za ? za.y : refY); flow.fitTables(); S.lastAnchor = flow.getAnchor(); progress(); savePos(); }, 200);
const zoomHandlers = {
  begin(x, y) { if (S.mode === 'page' && S.pv) { z = {s0: S.pv.scale(), x, y}; return; } z = {s0: prefs.scale, a: flow.getAnchor(y), y}; },
  update: rafThrottle((r, x, y) => { if (!z) return; if (S.mode === 'page' && S.pv) { S.pv.zoomTo(z.s0 * r, [x, y]); hud(Math.round(S.pv.scale() * 100) + '%'); return; } setScale(z.s0 * r, z.y); }),
  end() { S.zoomAnchor = z && z.a ? {a: z.a, y: z.y} : null; z = null; if (S.mode !== 'page') zoomEnd(); },
};
attachZoom(el.stage, zoomHandlers);
attachZoom(el.pdfStage, zoomHandlers);
function zoomStep(d) {
  if (S.mode === 'page' && S.pv) { if (d === 0) S.pv.fitWidth(); else S.pv.zoomTo(S.pv.scale() * (d > 0 ? 1.15 : 1 / 1.15)); setTimeout(() => hud(Math.round(S.pv.scale() * 100) + '%'), 60); return; }
  const steps = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.3, 2.6, 3, 3.2];
  let s = prefs.scale;
  if (d === 0) s = 1; else if (d > 0) s = steps.find(x => x > s + 0.01) ?? SCALE_MAX; else s = [...steps].reverse().find(x => x < s - 0.01) ?? SCALE_MIN;
  setScale(s); zoomEnd();
}

/* ================= search ================= */
function openSearch() {
  S.searchOpen = true; el.searchbar.hidden = false; el.reader.classList.add('searching'); setChrome(true); measure();
  el.q.focus(); el.q.select(); if (el.q.value) runSearch();
}
function closeSearch() {
  if (!S.searchOpen) return; S.searchOpen = false; el.searchbar.hidden = true; el.reader.classList.remove('searching'); measure();
  search.clear(); if (S.pv) S.pv.clearSearch(); el.qCount.textContent = '';
}
const runSearch = debounce(() => {
  const q = el.q.value;
  if (S.mode === 'page' && S.pv) { if (q.trim()) S.pv.search(q); else { S.pv.clearSearch(); el.qCount.textContent = ''; } return; }
  const n = search.run(q); el.qCount.textContent = q.trim() ? (n ? `${search.i + 1} of ${n}${n >= 5000 ? '+' : ''}` : 'No matches') : '';
}, 180);
function searchStep(d) {
  if (S.mode === 'page' && S.pv) { if (el.q.value.trim()) S.pv.search(el.q.value, d); return; }
  if (!search.ranges.length) return runSearch.flush();
  search.next(d); el.qCount.textContent = `${search.i + 1} of ${search.ranges.length}`;
}
function pdfFindCount(m, st) { if (!m) { if (st === 3) el.qCount.textContent = 'No matches'; return; } el.qCount.textContent = m.total ? `${m.current} of ${m.total}` : (st === 3 ? 'No matches' : ''); }
el.q.addEventListener('input', runSearch);
el.q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });

/* ================= contents ================= */
async function openToc() {
  let items = [];
  if (S.pdf && (S.mode === 'page' || S.mode === 'liquid')) {
    if (!S.outline) { const P = await pdfLib(); S.outline = await P.outline(S.pdf); }
    items = S.outline.map(o => ({text: o.text, level: o.level, page: o.page, dest: o.dest}));
    if (!items.length && S.mode === 'liquid') items = S.toc.map(t => ({text: t.text, level: t.level, id: t.id}));
  } else items = S.toc.map(t => ({text: t.text, level: t.level, id: t.id}));
  let cur = null;
  if (S.mode === 'page' && S.pv) { const pg = S.pv.page; items.forEach((it, i) => { if (it.page && it.page <= pg) cur = i; }); }
  else if (S.mode === 'liquid' && items.length && items[0].page != null) { const pg = flow.pageAt(); items.forEach((it, i) => { if (it.page && it.page <= pg) cur = i; }); }
  else { const id = flow.headingAt(); cur = items.findIndex(it => it.id === id); }
  el.tocList.innerHTML = items.length ? items.map((it, i) => `<button type="button" data-act="toc-go" data-i="${i}" data-l="${it.level}" class="${i === cur ? 'on' : ''}">${esc(it.text)}</button>`).join('')
    : `<div class="toc-empty">${S.pdf ? 'This PDF has no contents list.' : 'No headings in this document.'}</div>`;
  S.tocItems = items;
  el.toc.hidden = false; el.scrim.hidden = false;
  const on = el.tocList.querySelector('.on'); if (on) on.scrollIntoView({block: 'center'});
}
function tocGo(i) {
  const it = S.tocItems[i]; if (!it) return; closeToc();
  if (it.id) { flow.scrollToEl(document.getElementById(it.id), 6); return; }
  if (S.mode === 'page' && S.pv) { if (it.dest) S.pv.goDest(it.dest); else if (it.page) S.pv.goPage(it.page); return; }
  if (S.mode === 'liquid' && it.page) { const m = el.doc.querySelector(`[data-page="${it.page}"]`); if (m) flow.scrollToEl(m, 8); }
}
function closeToc() { el.toc.hidden = true; el.scrim.hidden = true; }

/* ================= appearance ================= */
const ap = $('#appearance');
function syncAppearance() {
  $$('[data-act="pref"]', ap).forEach(b => b.setAttribute('aria-checked', String(String(prefs[b.dataset.k]) === b.dataset.v)));
  $$('input[type=checkbox][data-k]', ap).forEach(i => { i.checked = !!prefs[i.dataset.k]; });
  $('#dimIn').value = prefs.dim; $('#warmIn').value = prefs.warmth;
  $('#zoomVal').textContent = Math.round(prefs.scale * 100) + '%';
}
function withAnchor(fn) {
  const live = !el.reader.hidden && S.mode !== 'page';
  const a = live ? flow.getAnchor() : null; fn();
  if (live) requestAnimationFrame(() => { if (flow.big) flow.estimate(); if (a) flow.setAnchor(a); flow.fitTables(); progress(); });
}
function setP(k, v) { withAnchor(() => setPref(k, v)); syncAppearance(); }
ap.addEventListener('input', e => { const t = e.target; if (t.type === 'range') setPref(t.dataset.k, +t.value); });
ap.addEventListener('change', e => { const t = e.target; if (t.type === 'checkbox') { setP(t.dataset.k, t.checked); if (t.dataset.k === 'awake') wake(t.checked); } });
function openAppearance() { syncAppearance(); if (ap.open) return ap.close(); ap.show(); }

/* ================= immersive / full screen ================= */
async function setImmersive(on) {
  S.immersive = on; H.classList.toggle('immersive', on);
  const use = $('[data-act="immersive"] use'); if (use) use.setAttribute('href', on ? '#r-unfull' : '#r-full');
  if (on) { if (document.fullscreenEnabled && !document.fullscreenElement) { try { await H.requestFullscreen({navigationUI: 'hide'}); } catch (e) {} } setChrome(false); }
  else { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); setChrome(true); }
  bridge.setImmersive(on);
  if (on && !document.fullscreenElement) toast('Full screen. Tap the page to show the controls.', {ms: 2200});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.immersive) setImmersive(false); });
async function wake(on) {
  try {
    if (on && prefs.awake && !el.reader.hidden && document.visibilityState === 'visible' && 'wakeLock' in navigator) { if (!S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } }
    else if (S.wake) { await S.wake.release(); S.wake = null; }
  } catch (e) { S.wake = null; }
}
document.addEventListener('visibilitychange', () => { wake(document.visibilityState === 'visible'); if (document.visibilityState === 'hidden') savePos.flush(); });

/* ================= saving out ================= */
async function exportRoot() {
  if (S.mode !== 'page') return cleanClone(el.doc);
  const r = await ensureLiquid();
  if (r.scanned) return null;
  const tmp = document.createElement('div'); tmp.innerHTML = r.html; return cleanClone(tmp);
}
// Notes
async function openNoteDlg() {
  closeMenu();
  const d = $('#noteDlg');
  $('#noteName').value = S.meta.title || 'Untitled';
  const labels = bridge.labels(); S.noteCat = S.noteCat && labels.some(l => l.k === S.noteCat) ? S.noteCat : bridge.defaultLabel();
  if (!labels.some(l => l.k === S.noteCat)) S.noteCat = labels[0].k;
  $('#noteLabels').innerHTML = labels.map(l => `<button type="button" role="radio" class="chip" data-act="note-cat" data-v="${esc(l.k)}" aria-checked="${l.k === S.noteCat}"><i>${esc(l.name[0].toUpperCase())}</i>${esc(l.name)}</button>`).join('');
  setNoteFmt(S.noteFmt || 'md');
  d.showModal();
  bridge.hello().then(r => { if (r && d.open) { const cur = S.noteCat; $('#noteLabels').innerHTML = bridge.labels().map(l => `<button type="button" role="radio" class="chip" data-act="note-cat" data-v="${esc(l.k)}" aria-checked="${l.k === cur}"><i>${esc(l.name[0].toUpperCase())}</i>${esc(l.name)}</button>`).join(''); } });
}
async function noteContent(fmt) {
  const root = await exportRoot(); if (!root) return null;
  if (fmt === 'md') return toMarkdown(root);
  if (fmt === 'txt') return toText(root);
  return noteHtml($('#noteName').value || S.meta.title, root.innerHTML);
}
async function setNoteFmt(f) {
  S.noteFmt = f; $$('#noteDlg [data-act="note-fmt"]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === f)));
  const hint = $('#noteHint'); hint.className = 'hint'; hint.textContent = 'Working out the size…';
  try {
    const c = await noteContent(f); S.noteCache = {f, c};
    if (c == null) { hint.textContent = 'This PDF has no text to save (it is scanned pictures). Save the original to your device instead.'; hint.classList.add('warn'); return; }
    const big = c.length > bridge.NOTE_LIMIT;
    hint.textContent = big ? `Too long for a note (${bytes(c.length)}; notes hold up to ${bytes(bridge.NOTE_LIMIT)}). Choose Markdown or Plain text, or Save to device.`
      : `${bytes(new Blob([c]).size)} · ${f === 'md' ? 'Headings, lists, tables and links show in Notes.' : f === 'html' ? 'Keeps rich formatting; Notes shows it in its preview.' : 'Just the words.'} It lands in Notes and syncs to Google Drive.`;
    if (big) hint.classList.add('warn');
    $('#noteSaveB').disabled = big;
  } catch (e) { hint.textContent = 'Couldn’t prepare the note: ' + e.message; hint.classList.add('warn'); }
}
async function saveNote() {
  const btn = $('#noteSaveB'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Saving…';
  try {
    const f = S.noteFmt, c = S.noteCache && S.noteCache.f === f && f !== 'html' ? S.noteCache.c : await noteContent(f);
    if (c == null) return;
    const title = ($('#noteName').value || '').trim() || S.meta.title || 'From Reader';
    const r = await bridge.saveNote({title, type: f, content: c, cat: S.noteCat});
    if (r.ok) {
      $('#noteDlg').close();
      if (r.queued) toast('Saved. It will appear in Notes the next time you open the budget app.', {ms: 5000});
      else toast(`Saved to Notes as “${title}”`, bridge.embedded && r.id ? {action: 'View', onAction: () => bridge.openNoteInBudget(r.id)} : {});
    } else toast(r.error === 'too-big' ? 'Too long for a note. Try Markdown or Plain text, or Save to device.' : r.error, {kind: 'bad', ms: 6000});
  } finally { btn.disabled = false; btn.textContent = old; }
}
// Device
function fileOptions() {
  const m = S.meta, k = KINDS[m.kind] || KINDS.txt, o = [];
  if (m.source === 'file') o.push({v: 'orig', ext: (m.name || '').split('.').pop().toLowerCase() || k.ext, t: 'Original file', s: m.name || 'Exactly as you opened it'});
  else o.push({v: 'orig', ext: m.fmt === 'rich' ? 'html' : KINDS[m.fmt]?.ext || 'txt', t: 'As pasted', s: m.fmt === 'rich' ? 'The rich text as HTML' : 'Exactly what you pasted'});
  o.push({v: 'html', ext: 'html', t: 'Web page', s: 'Styled in your reading theme; opens anywhere'});
  o.push({v: 'md', ext: 'md', t: 'Markdown', s: 'Headings, lists, tables and links as plain marks'});
  o.push({v: 'txt', ext: 'txt', t: 'Plain text', s: 'Just the words'});
  if (S.mode !== 'page') o.push({v: 'pdf', ext: 'pdf', t: 'PDF', s: 'Print, then choose “Save as PDF”'});
  return o;
}
function openFileDlg() {
  closeMenu();
  const o = fileOptions(); if (!o.some(x => x.v === S.fileFmt)) S.fileFmt = o[0].v;
  $('#fileOpts').innerHTML = o.map(x => `<button type="button" role="radio" class="opt" data-act="file-fmt" data-v="${x.v}" aria-checked="${x.v === S.fileFmt}"><span class="ext">.${esc(x.ext.toUpperCase())}</span><span><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span></button>`).join('');
  $('#fileName').value = safeName(S.meta.title);
  $('#fileDlg').showModal();
}
async function saveFile() {
  const f = S.fileFmt, o = fileOptions().find(x => x.v === f), base = safeName($('#fileName').value || S.meta.title);
  if (f === 'pdf') { $('#fileDlg').close(); return printDoc(); }
  let blob, mime, ext = o.ext;
  try {
    if (f === 'orig') { if (S.body instanceof Blob) { blob = S.body; mime = S.meta.mime || blob.type; } else { mime = KINDS[S.meta.fmt]?.mime || 'text/plain'; blob = new Blob([S.body.text], {type: mime + ';charset=utf-8'}); } }
    else {
      const root = await exportRoot(); if (!root) return toast('This PDF has no text inside (it is scanned). Save the original instead.', {kind: 'bad'});
      if (f === 'html') { mime = 'text/html'; blob = new Blob([standaloneHtml(S.meta.title, root.innerHTML)], {type: 'text/html;charset=utf-8'}); }
      else if (f === 'md') { mime = 'text/markdown'; blob = new Blob([toMarkdown(root)], {type: 'text/markdown;charset=utf-8'}); }
      else { mime = 'text/plain'; blob = new Blob([toText(root)], {type: 'text/plain;charset=utf-8'}); }
    }
    $('#fileDlg').close();
    const r = await saveBlob(blob, `${base}.${ext}`, {ext, mime: mime.split(';')[0], desc: o.t});
    if (r === 'saved') toast('Saved to your device.'); else if (r === 'downloaded') toast(`Saved “${base}.${ext}” to your downloads.`); else if (r === 'shared') toast('Shared.');
  } catch (e) { toast('Couldn’t save: ' + e.message, {kind: 'bad'}); }
}
function printDoc() { closeMenu(); if (S.mode === 'page') return toast('For the original layout, save the original file instead.'); setTimeout(() => window.print(), 50); }
function openMenu() { el.menu.hidden = false; setChrome(true); $('#miPrint').hidden = S.mode === 'page'; el.menu.querySelector('.mi').focus({preventScroll: true}); }
function closeMenu() { el.menu.hidden = true; }

/* ================= panels and leaving ================= */
function closeAllPanels() { closeMenu(); closeToc(); if (ap.open) ap.close(); closeSearch(); $$('dialog[open]').forEach(d => d.close()); }
function busy(text, cancellable) {
  if (text === false) { el.busy.hidden = true; return; }
  el.busyT.textContent = text; el.busyBar.style.width = '0'; el.busyCancel.hidden = !cancellable; el.busy.hidden = false;
}
async function goHome() {
  savePos.flush();
  closeAllPanels(); if (S.immersive) setImmersive(false);
  if (S.pv) { S.pv.destroy(); S.pv = null; }
  if (S.pdf) { try { S.pdf.destroy(); } catch (e) {} S.pdf = null; }
  flow.clear(); S.meta = null; S.body = null; S.liquid = null;
  el.reader.hidden = true; el.home.hidden = false; setChrome(true); hostBars();
  document.title = 'Reader'; wake(false);
  renderLibrary();
}
window.addEventListener('popstate', () => { if (!el.reader.hidden) goHome(); });

function ask(title, text, label) {
  const d = $('#askDlg'); $('#askH').textContent = title; $('#askP').textContent = text; $('#askL').textContent = label; const i = $('#askIn'); i.value = '';
  return new Promise(res => {
    const done = v => { d.removeEventListener('close', onClose); res(v); };
    const onClose = () => done(d.returnValue === 'ok' ? i.value : null);
    d.addEventListener('close', onClose); d.returnValue = ''; d.showModal(); setTimeout(() => i.focus(), 50);
  });
}

/* ================= talking to the budget app ================= */
bridge.on('inset', m => H.style.setProperty('--host-bottom', Math.max(0, Math.round(m.inset || 0)) + 'px'));
bridge.on('hidden', () => { savePos.flush(); wake(false); });
bridge.on('shown', () => { measure(); if (!el.reader.hidden && S.mode !== 'page' && S.lastAnchor) requestAnimationFrame(() => flow.setAnchor(S.lastAnchor)); wake(true); el.reader.hidden ? null : (S.mode === 'page' ? el.pdfStage : el.stage).focus({preventScroll: true}); });
bridge.on('open-text', async m => {
  const fmt = m.kind === 'md' ? 'md' : m.kind === 'html' ? 'html' : 'txt';
  const text = m.kind === 'json' ? '```json\n' + m.content + '\n```' : m.content;
  const meta = {id: uid(), title: m.title || 'Note', kind: m.kind === 'json' ? 'md' : fmt, fmt: m.kind === 'json' ? 'md' : fmt, source: 'paste', size: new Blob([text]).size, createdAt: Date.now(), openedAt: Date.now(), progress: 0};
  try { await store.putDoc(meta, {text, fmt: meta.fmt}); } catch (e) {}
  openRecord(meta, {text, fmt: meta.fmt});
});

/* ================= one click handler for everything ================= */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!el.menu.hidden && !e.target.closest('#exportMenu,[data-act="export"]')) closeMenu();
  if (ap.open && !e.target.closest('#appearance,[data-act="appearance"]')) ap.close();
  if (!b) {
    const a = e.target.closest('#doc a[href^="#"]');
    if (a) { e.preventDefault(); const t = document.getElementById(a.getAttribute('href').slice(1)); if (t) flow.scrollToEl(t, 6); }
    return;
  }
  const act = b.dataset.act, v = b.dataset.v;
  switch (act) {
    case 'open': el.fileIn.click(); break;
    case 'paste': openPaste(); break;
    case 'lib-open': { if (e.target.closest('[data-act="lib-del"]')) break; const m = await store.getDoc(b.dataset.id); if (m) openRecord(m); break; }
    case 'lib-del': {
      e.stopPropagation();
      if (b.dataset.armed) { await store.deleteDoc(b.dataset.id); toast('Removed from this device.'); renderLibrary(); }
      else { b.dataset.armed = '1'; b.style.color = '#e5484d'; b.title = 'Tap again to remove'; toast('Tap the bin again to remove it from this device.'); setTimeout(() => { delete b.dataset.armed; b.style.color = ''; }, 3000); }
      break; }
    case 'home': goHome(); if (!bridge.embedded && history.state && history.state.doc) history.back(); break;
    case 'mode': setPdfMode(v); break;
    case 'search': S.searchOpen ? closeSearch() : openSearch(); break;
    case 'q-prev': searchStep(-1); break;
    case 'q-next': searchStep(1); break;
    case 'q-close': closeSearch(); break;
    case 'toc': openToc(); break;
    case 'toc-go': tocGo(+b.dataset.i); break;
    case 'toc-close': closeToc(); break;
    case 'appearance': openAppearance(); break;
    case 'pref': setP(b.dataset.k, b.dataset.v); break;
    case 'zoom': zoomStep(+v); break;
    case 'immersive': setImmersive(!S.immersive); break;
    case 'export': el.menu.hidden ? openMenu() : closeMenu(); break;
    case 'to-note': openNoteDlg(); break;
    case 'to-file': openFileDlg(); break;
    case 'print': printDoc(); break;
    case 'note-fmt': setNoteFmt(v); break;
    case 'note-cat': S.noteCat = v; $$('#noteLabels .chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.v === v))); break;
    case 'note-save': saveNote(); break;
    case 'file-fmt': S.fileFmt = v; $$('#fileOpts .opt').forEach(c => c.setAttribute('aria-checked', String(c.dataset.v === v))); break;
    case 'file-save': saveFile(); break;
    case 'fmt': if (!b.disabled) setPasteFmt(v); break;
    case 'paste-read': pasteRead(); break;
    case 'close-dlg': { const d = b.closest('dialog'); if (d) d.close(); break; }
    case 'ask-cancel': $('#askDlg').close(''); break;
    case 'busy-cancel': if (S.abort) S.abort.abort(); break;
  }
});
el.scrim.addEventListener('click', closeToc);
// Liquid mode: tap a page divider to open that page in the original layout
el.doc.addEventListener('click', e => { const m = e.target.closest('.pgmark'); if (m && S.pdf) { S.mode = 'liquid'; setPdfMode('page').then(() => S.pv && S.pv.goPage(+m.dataset.page)); } });
el.doc.addEventListener('keydown', e => { const m = e.target.closest('.pgmark'); if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); m.click(); } });
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('.item') && e.key === 'Enter') { e.target.click(); return; }
  const mod = e.ctrlKey || e.metaKey, reading = !el.reader.hidden;
  if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); el.fileIn.click(); return; }
  if (reading && mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openSearch(); return; }
  if (reading && mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (reading && mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (reading && mod && e.key === '0') { e.preventDefault(); zoomStep(0); return; }
  if (e.key === 'Escape') { if (!el.menu.hidden) return closeMenu(); if (!el.toc.hidden) return closeToc(); if (ap.open) return ap.close(); if (S.searchOpen) return closeSearch(); if (S.immersive) return setImmersive(false); }
  if (!reading || mod || e.altKey || isTyping(document.activeElement) || document.querySelector('dialog[open]:not(#appearance)')) return;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setImmersive(!S.immersive); }
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); el.toc.hidden ? openToc() : closeToc(); }
  else if (e.key === '/') { e.preventDefault(); openSearch(); }
});
// files: picker, drag and drop, and paste anywhere on the library screen
el.fileIn.addEventListener('change', () => { const f = el.fileIn.files[0]; el.fileIn.value = ''; openFile(f); });
{
  let depth = 0; const dz = $('#dropzone'), hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dz.hidden = false; });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
  window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dz.hidden = true; openFile(e.dataTransfer.files[0]); });
}
document.addEventListener('paste', e => {
  if (pdlg.open || el.home.hidden || isTyping(document.activeElement)) return;
  const d = e.clipboardData; if (!d) return;
  if (d.files && d.files.length) { e.preventDefault(); openFile(d.files[0]); return; }
  e.preventDefault(); openPaste({html: d.getData('text/html'), text: d.getData('text/plain')});
});
window.__reader = {S, flow, prefs}; // handy for debugging in the console

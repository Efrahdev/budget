/* PDF: loading pdf.js only when a PDF is opened, and the Original layout mode.
   pdf.js 6.5 is pinned in ../vendor and cached by the service worker on first use, in its own long-lived cache.
   It is 4× the size of the whole budget app, which is exactly why it is never loaded until you open a PDF. */
import {coarse, clamp} from './util.js';
export const V = new URL('../vendor/pdfjs-6.5.438/', import.meta.url).href;
let libP = null;
export function loadLib() {
  if (!libP) libP = (async () => {
    const lib = await import(V + 'build/pdf.min.mjs');
    globalThis.pdfjsLib = lib; // pdf_viewer.mjs looks for it here
    lib.GlobalWorkerOptions.workerSrc = V + 'build/pdf.worker.min.mjs';
    const viewer = await import(V + 'web/pdf_viewer.mjs');
    if (!document.getElementById('pdfcss')) {
      const l = document.createElement('link'); l.id = 'pdfcss'; l.rel = 'stylesheet'; l.href = V + 'web/pdf_viewer.css';
      document.head.insertBefore(l, document.querySelector('link[href="reader.css"]')); // ours wins
      await new Promise(r => { l.onload = l.onerror = r; });
    }
    return {lib, viewer};
  })().catch(e => { libP = null; throw e; });
  return libP;
}

export async function openPdf(buf, {askPassword, onProgress} = {}) {
  const {lib} = await loadLib();
  const task = lib.getDocument({data: new Uint8Array(buf.slice(0)), cMapUrl: V + 'cmaps/', cMapPacked: true, standardFontDataUrl: V + 'standard_fonts/',
    wasmUrl: V + 'wasm/', iccUrl: V + 'iccs/', enableXfa: false, useSystemFonts: true});
  task.onPassword = async (update, reason) => {
    const pw = askPassword ? await askPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD) : null;
    if (pw == null) { task.destroy(); return; }
    update(pw);
  };
  if (onProgress) task.onProgress = p => p.total && onProgress(p.loaded / p.total);
  const pdf = await task.promise;
  pdf._task = task;
  return pdf;
}

export async function meta(pdf) { try { const m = await pdf.getMetadata(); return {title: (m.info && m.info.Title || '').trim(), author: (m.info && m.info.Author || '').trim()}; } catch (e) { return {}; } }

// The PDF's own table of contents, flattened, with page numbers.
export async function outline(pdf) {
  let o = null; try { o = await pdf.getOutline(); } catch (e) {}
  if (!o || !o.length) return [];
  const out = [];
  const walk = async (items, level) => { for (const it of items) { if (out.length > 600) return; const page = await destPage(pdf, it.dest).catch(() => null); out.push({text: (it.title || '').trim(), level: Math.min(level, 4), page, dest: it.dest, url: it.url}); if (it.items && it.items.length) await walk(it.items, level + 1); } };
  await walk(o, 1);
  return out.filter(x => x.text);
}
export async function destPage(pdf, dest) {
  if (typeof dest === 'string') dest = await pdf.getDestination(dest);
  if (!Array.isArray(dest)) return null;
  const ref = dest[0];
  if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref)) + 1;
  if (Number.isInteger(ref)) return ref + 1;
  return null;
}

/* ---------- Original layout: pdf.js's own building blocks (virtualised pages, selectable text, links, find) in our chrome ---------- */
export class PageView {
  constructor(container, viewerEl, pdf, cb) { this.c = container; this.el = viewerEl; this.pdf = pdf; this.cb = cb; this.loc = null; }
  async init(state = {}) {
    const {lib, viewer: Vw} = await loadLib();
    this.bus = new Vw.EventBus();
    this.link = new Vw.PDFLinkService({eventBus: this.bus, externalLinkTarget: Vw.LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow'});
    this.find = new Vw.PDFFindController({eventBus: this.bus, linkService: this.link});
    this.v = new Vw.PDFViewer({container: this.c, viewer: this.el, eventBus: this.bus, linkService: this.link, findController: this.find,
      textLayerMode: 1, annotationMode: lib.AnnotationMode.ENABLE, removePageBorders: true, maxCanvasPixels: coarse() ? 2 ** 24 : 2 ** 25});
    this.link.setViewer(this.v);
    const ready = new Promise(res => this.bus.on('pagesinit', () => {
      this.v.currentScaleValue = state.scale || 'auto'; // auto: fills a phone's width, but caps page size on big screens
      if (state.page > 1 || state.top != null) this.v.scrollPageIntoView({pageNumber: clamp(state.page || 1, 1, this.pdf.numPages), destArray: [null, {name: 'XYZ'}, state.left ?? null, state.top ?? null, null], allowNegativeOffset: true});
      res();
    }));
    this.bus.on('pagechanging', e => this.cb.onPage && this.cb.onPage(e.pageNumber, this.pdf.numPages));
    this.bus.on('updateviewarea', e => { this.loc = e.location; this.cb.onView && this.cb.onView(e.location); });
    this.bus.on('updatefindmatchescount', e => this.cb.onFind && this.cb.onFind(e.matchesCount));
    this.bus.on('updatefindcontrolstate', e => this.cb.onFind && this.cb.onFind(e.matchesCount, e.state));
    this.v.setDocument(this.pdf); this.link.setDocument(this.pdf, null);
    this.ro = new ResizeObserver(() => { if (!this.c.offsetParent) return; const s = this.v.currentScaleValue; if (typeof s === 'string' && /^(page-width|page-fit|auto)$/.test(s)) this.v.currentScaleValue = s; });
    this.ro.observe(this.c);
    await ready;
  }
  state() { const l = this.loc || {}; const sv = this.v.currentScaleValue; return {page: l.pageNumber || this.v.currentPageNumber, top: l.top, left: l.left, scale: typeof sv === 'string' && isNaN(+sv) ? sv : this.v.currentScale}; }
  get page() { return this.v.currentPageNumber; }
  goPage(n) { this.v.currentPageNumber = clamp(n, 1, this.pdf.numPages); }
  goDest(dest) { this.link.goToDestination(dest); }
  scale() { return this.v.currentScale; }
  // pinch: set an absolute target, so tiny steps are not lost to pdf.js's rounding
  zoomTo(target, origin) { target = clamp(target, 0.25, 8); const f = target / this.v.currentScale; if (Math.abs(f - 1) < 0.008) return; this.v.updateScale({scaleFactor: f, origin, drawingDelay: 280}); }
  fitWidth() { this.v.currentScaleValue = 'auto'; }
  search(query, dir = 0) { this.bus.dispatch('find', {source: this, type: dir ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: dir < 0, matchDiacritics: false}); }
  clearSearch() { this.bus.dispatch('findbarclose', {source: this}); }
  destroy() { try { this.ro && this.ro.disconnect(); this.v && this.v.setDocument(null); this.link && this.link.setDocument(null); } catch (e) {} this.el.replaceChildren(); }
}

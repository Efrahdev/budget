/* The corridor to the budget app. Three kinds of message only:
     reader → budget: hello · save-note · bars / immersive (hide the budget's own bars while you read) · open-note
     budget → reader: hello (labels, signed in?) · note-saved · shown / hidden · inset (room taken by its bottom bar) · open-text
   Inside the Budget tab we talk to the parent page directly. Opened on its own (its own icon or tab), we ask any open
   Budget tab over a BroadcastChannel, and if none answers, leave the note in a small mailbox the budget app empties
   the next time it opens. */
const ORIGIN = location.origin, INBOX = 'budgetTracker.readerInbox.v1', MAX_NOTE = 400000;
export const NOTE_LIMIT = MAX_NOTE;
export const embedded = (() => { try { return window.parent !== window && window.parent.location.origin === ORIGIN; } catch (e) { return false; } })();
const chan = !embedded && 'BroadcastChannel' in window ? new BroadcastChannel('budget-reader') : null;
const waiting = new Map(); const handlers = {};
export const host = {labels: null, def: '', signedIn: null};
export const on = (type, fn) => { handlers[type] = fn; };
function send(msg) { msg.src = 'budget-reader'; if (embedded) window.parent.postMessage(msg, ORIGIN); else if (chan) chan.postMessage(msg); }
function receive(m) {
  if (!m || m.src !== 'budget') return;
  if (m.rid && waiting.has(m.rid)) { const w = waiting.get(m.rid); waiting.delete(m.rid); w(m); return; }
  if (m.type === 'hello') { host.labels = m.labels; host.def = m.def; host.signedIn = m.signedIn; }
  handlers[m.type] && handlers[m.type](m);
}
if (embedded) window.addEventListener('message', e => { if (e.origin === ORIGIN && e.source === window.parent) receive(e.data); });
if (chan) chan.onmessage = e => receive(e.data);
function ask(msg, ms) {
  const rid = Math.random().toString(36).slice(2);
  return new Promise(res => { const t = setTimeout(() => { waiting.delete(rid); res(null); }, ms); waiting.set(rid, m => { clearTimeout(t); res(m); }); send(Object.assign({rid}, msg)); });
}
export async function hello() {
  const r = await ask({type: 'hello'}, embedded ? 2500 : 900);
  if (r) { host.labels = r.labels; host.def = r.def; host.signedIn = r.signedIn; if (r.inset != null && handlers.inset) handlers.inset(r); }
  return r;
}
// Labels when no budget app answers: the three built in, plus any person added in the budget app on this device.
export function labels() {
  if (host.labels && host.labels.length) return host.labels;
  const base = [{k: 'arhaan', name: 'Arhaan'}, {k: 'efrah', name: 'Efrah'}, {k: 'other', name: 'Others'}];
  try { const p = JSON.parse(localStorage.getItem('gharKhata.pref.v1') || '{}') || {}; (p.noteLabels || []).forEach(n => { if (typeof n === 'string' && n.length < 25 && !base.some(b => b.k === n)) base.push({k: n, name: n}); }); } catch (e) {}
  return base;
}
export function defaultLabel() {
  if (host.def) return host.def;
  try { const p = JSON.parse(localStorage.getItem('gharKhata.pref.v1') || '{}') || {}; if (p.noteCat) return p.noteCat; } catch (e) {}
  return 'other';
}
/* Returns {ok, id} when the note is in Notes now, {ok, queued} when it waits in the mailbox, {ok:false, error} otherwise. */
export async function saveNote(note) {
  if (!note.content || !note.content.trim()) return {ok: false, error: 'There is nothing to save.'};
  if (note.content.length > MAX_NOTE) return {ok: false, error: 'too-big'};
  const r = await ask({type: 'save-note', note}, embedded ? 5000 : 1500);
  if (r) return r.ok ? {ok: true, id: r.id} : {ok: false, error: r.error === 'signin' ? 'Sign in to the budget app first, then save again.' : (r.error || 'The budget app could not save it.')};
  if (embedded) return {ok: false, error: 'The budget app did not answer. Try again.'};
  try {
    const box = JSON.parse(localStorage.getItem(INBOX) || '[]') || [];
    box.push(Object.assign({at: Date.now()}, note));
    localStorage.setItem(INBOX, JSON.stringify(box));
    return {ok: true, queued: true};
  } catch (e) { return {ok: false, error: 'This device’s storage is full. Save to device instead.'}; }
}
export const setBars = hidden => { if (embedded) send({type: 'bars', hidden: !!hidden}); };
export const setImmersive = on => { if (embedded) send({type: 'immersive', on: !!on}); };
export const openNoteInBudget = id => { if (embedded) send({type: 'open-note', id}); };

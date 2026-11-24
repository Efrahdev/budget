/**
 * Budget Tracker: Google Sheets back end.
 *
 * Paste this whole file into Extensions > Apps Script of the
 * "Budget Tracker data" spreadsheet and deploy it as a Web app
 * (Execute as: Me, Who has access: Anyone).
 *
 * Sign-in: a person types their email; if it is on the Users tab, the script emails
 * them a one-time link. Opening the link gives the phone a session it keeps for good.
 * (Sign in with Google also works once a Client ID is set in the Config tab.)
 * Removing someone from the Users tab locks them out at once.
 *
 * Entry links: the owner makes a link (Setup > Entry-only links) that opens the app with no sign-in.
 * Whoever holds it can add entries, read everyone's entries, fix or delete only the ones they added, and keep
 * their own notes. This script refuses everything else for that link, and sends it no budgets or balances.
 * Removing the link in Setup switches it off at once.
 *
 * Kill switch: the owner sets a kill code in Setup. That code closes the app for everyone, on every
 * phone, until the same code reopens it. Backup: run killApp() or reviveApp() from the script editor.
 *
 * The app sends one POST per sync: {session, ops: [...]}. Each op is an
 * upsert or a delete, so sending the same op twice is harmless.
 * The reply is the full, current data set and its version (rev). A request with no ops and
 * {since: rev} for the current version gets a tiny {same: true} reply instead.
 * A request with no ops and {lite: true} gets the notes only (list, and text for noteIds), without the budget data.
 * A request with {contacts: {...}} is the Contacts page: it gets only contacts (from their own spreadsheet), never
 * budget data, after the same kill-switch and sign-in checks. See "contacts" near the end of this file.
 */

var TABS = {
  Entries: ['ID', 'Date', 'Cycle', 'Type', 'Category', 'Amount', 'Account', 'Card', 'Note', 'For whom', 'Tag', 'Refund',
            'Category ID', 'Account ID', 'Card ID', 'Created at', 'Saved at'],
  Balances: ['Date', 'Account ID', 'Account', 'Balance'],
  CardFix: ['Card ID', 'Card', 'Statement date', 'Your figure'],
  Config: ['Key', 'Value', 'Note'],
  Users: ['Email', 'Name', 'Role', 'Added by', 'Added at'],
  // Encrypted on the phone before it arrives. This script never sees readable vault data.
  Vault: ['ID', 'Encrypted data', 'Saved at'],
  // Notes live as real files in Drive (folder "Budget Tracker notes"); this tab is only the list.
  Notes: ['ID', 'Title', 'Type', 'Owner', 'Drive file ID', 'Updated at', 'Size', 'Preview', 'Label', 'Pinned', 'Pin order', 'Shared'],
  // One row per person per shared note they did not write: that person's own label, pin and "removed from my list".
  NotePrefs: ['Note ID', 'Person', 'Label', 'Pinned', 'Pin order', 'Hidden'],
  // Which entries came from an entry link, so that link can see and change only those.
  EntryLog: ['Entry ID', 'Link ID', 'Link name', 'Added at']
};
var ENTRY_OPS = {txn: 1, deltxn: 1, nput: 1, ndel: 1, ndelall: 1, nmeta: 1};
var E = {id: 0, date: 1, cycle: 2, type: 3, catName: 4, amount: 5, acctName: 6, cardName: 7, note: 8, member: 9, tag: 10,
         refund: 11, cat: 12, acct: 13, card: 14, at: 15, saved: 16};
var CHUNK = 40000; // characters per Config cell
var APP_URL = 'https://efrahdev.github.io/budget/';
var LINK_MINUTES = 30;

function doGet() {
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:16px/1.5 Arial,sans-serif;max-width:560px;margin:24px auto;padding:0 16px">' +
    '<h2>Budget Tracker back end is running</h2><p>Open the app and tap <b>Sign in with Google</b>.</p></div>')
    .setTitle('Budget Tracker');
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ok: false, error: 'bad_json'}); }
  if (!req) return out({ok: false, error: 'bad_json'});
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return out({ok: false, error: 'busy'});
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureTabs(ss);
    var props = PropertiesService.getScriptProperties();
    if (req.kill || req.revive) return out(killSwitch(props, req));
    if (props.getProperty('KILLED')) return out({ok: false, error: 'app_killed'});
    if (req.emailLink) return out(sendLoginLink(ss, req.emailLink));
    var who = authorise(ss, req);
    if (!who.ok) return out(who);
    if (req.contacts) return out(contactsSync(req.contacts, who.user)); // Contacts page: its own spreadsheet, nothing else
    var ops = Array.isArray(req.ops) ? req.ops : [], vaultOps = [], noteErrors = [], role = who.user.role, killErr = '';
    var rev = props.getProperty('REV') || '';
    if (!ops.length && req.since && rev && req.since === rev && !req.vault && !(Array.isArray(req.noteIds) && req.noteIds.length) && !who.session)
      return out({ok: true, same: true, rev: rev, me: who.user, at: Date.now()});
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      if (role === 'Entry') {
        if (!ENTRY_OPS[op.t]) continue; // everything else is refused for an entry link
        if (op.t === 'txn' || op.t === 'deltxn') { entryTxnOp(ss, op, who.user); continue; }
      }
      if (op.t === 'elinkadd' || op.t === 'elinkdel') { if (role === 'Owner') entryLinkOp(props, op); continue; }
      if (op.t === 'killcode') { if (role === 'Owner') killErr = setKillCode(props, op); continue; }
      if (op.t === 'signout') { if (req.session) PropertiesService.getScriptProperties().deleteProperty('sess:' + req.session); return out({ok: true, signedOut: true}); }
      if (op.t === 'adduser' || op.t === 'deluser') { userOp(ss, op, who.user); continue; }
      if (op.t === 'vput' || op.t === 'vdel') { vaultOps.push(op); continue; }
      if (REM_OPS[op.t]) { try { remOp(ss, props, op, who.user); } catch (x) { Logger.log('reminders: ' + x); } continue; }
      if (op.t === 'nput' || op.t === 'ndel' || op.t === 'ndelall' || op.t === 'nmeta') { try { noteOp(ss, op, who.user); } catch (x) { noteErrors.push({id: (op.note || op).id, error: String(x && x.message || x)}); } continue; }
      applyOp(ss, op);
    }
    vaultApply(ss, vaultOps, who.user);
    if (ops.length) { SpreadsheetApp.flush(); rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 7); props.setProperty('REV', rev); }
    if (!rev) { rev = Date.now().toString(36); props.setProperty('REV', rev); }
    // remOnly: the service worker sent a snooze from a notification; it needs nothing back but the reminders.
    if (req.remOnly) return out({ok: true, rev: rev, rem: readRem(ss)});
    // lite: the app only wants notes (their list or text), so the budget data is not read or sent. Much faster.
    var lite = !!req.lite && !ops.length;
    var reply = {ok: true, applied: ops.length, rev: rev, me: who.user, at: Date.now()};
    if (!lite) reply.data = role === 'Entry' ? entryData(ss, who.user) : readAll(ss);
    if (who.session) reply.session = who.session;
    if (role === 'Owner') { reply.users = listUsers(ss); reply.entryLinks = listEntryLinks(props); reply.killCode = !!props.getProperty('KILL_CODE'); if (killErr) reply.killErr = killErr; }
    if (req.vault && who.user.role === 'Owner') reply.vault = readVault(ss);
    if (!lite && role !== 'Entry') { try { reply.rem = readRem(ss); } catch (x) {} }
    if (req.pushKey && role !== 'Entry') { try { reply.vapid = vapidKeys(props).pub; } catch (x) { reply.vapidErr = String(x && x.message || x); } }
    // Notes can never stop the budget from syncing: if anything in them fails, the budget still goes through and the app is told.
    try {
      reply.notes = readNotes(ss, who.user); reply.notesV = 7; // 3: notes can be Shared · 4: anyone can edit a Shared note · 5: shared with chosen people · 6: guests pin, label and remove for themselves · 7: guests change who it is shared with, and delete for everyone
      reply.people = notePeople(ss).map(function (p) { return {id: p.id, name: p.name, me: p.key === noteOwner(who.user)}; });
    } catch (x) { delete reply.notes; delete reply.notesV; noteErrors.push({id: '', error: String(x && x.message || x)}); }
    if (noteErrors.length) reply.noteErrors = noteErrors;
    if (Array.isArray(req.noteIds) && req.noteIds.length) { try { reply.noteBodies = noteBodies(ss, req.noteIds, who.user); } catch (x) { reply.noteErrors = (reply.noteErrors || []).concat([{id: '', error: String(x && x.message || x)}]); } }
    return out(reply);
  } catch (err) {
    return out({ok: false, error: String(err && err.message || err)});
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- sign-in ---------- */
function authorise(ss, req) {
  var props = PropertiesService.getScriptProperties();
  if (req.loginCode) {
    var lk = 'login:' + String(req.loginCode).replace(/[^a-f0-9]/g, ''), lraw = props.getProperty(lk);
    if (!lraw) return {ok: false, error: 'link_used'};
    props.deleteProperty(lk); // each link works once
    var L = JSON.parse(lraw);
    if (L.exp < Date.now()) return {ok: false, error: 'link_expired'};
    var lu = findUser(ss, L.email);
    if (!lu) return {ok: false, error: 'not_allowed'};
    return {ok: true, user: lu, session: newSession(props, lu.email)};
  }
  if (req.idToken) {
    var g = verifyGoogle(ss, req.idToken);
    if (!g.ok) return g;
    return {ok: true, user: g.user, session: newSession(props, g.user.email)};
  }
  if (req.session) {
    var raw = props.getProperty('sess:' + req.session);
    if (!raw) { var el = entryUser(props, req.session); return el ? {ok: true, user: el} : {ok: false, error: 'signed_out'}; }
    var u = findUser(ss, JSON.parse(raw).email);
    if (!u) { props.deleteProperty('sess:' + req.session); return {ok: false, error: 'not_allowed'}; }
    return {ok: true, user: u};
  }
  // Older set-up links. Delete the APP_KEY script property to switch these off.
  var key = props.getProperty('APP_KEY');
  if (key && req.key && req.key === key) return {ok: true, user: {email: '', name: 'Set-up link', role: 'Owner'}};
  return {ok: false, error: req.key ? 'bad_key' : 'signed_out'};
}
function newToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function newSession(props, email) {
  var tok = newToken();
  props.setProperty('sess:' + tok, JSON.stringify({email: email, at: Date.now()}));
  return tok;
}
// Always answers the same way, so nobody can use it to find out who is on the list.
function sendLoginLink(ss, email) {
  var u = findUser(ss, email);
  if (!u) return {ok: true, sent: true};
  var props = PropertiesService.getScriptProperties(), rk = 'rate:' + u.email;
  var r = JSON.parse(props.getProperty(rk) || '{"n":0,"t":0}');
  if (Date.now() - r.t > 3600000) r = {n: 0, t: Date.now()};
  if (r.n >= 5) return {ok: false, error: 'too_many'};
  r.n++; props.setProperty(rk, JSON.stringify(r));
  var code = newToken();
  props.setProperty('login:' + code, JSON.stringify({email: u.email, exp: Date.now() + LINK_MINUTES * 60000}));
  var link = APP_URL + '#login=' + code;
  MailApp.sendEmail({
    to: u.email, name: 'Budget Tracker', subject: 'Your Budget Tracker sign-in link',
    body: 'Open this link on the phone you want to sign in on:\n\n' + link + '\n\nIt works once and expires in ' + LINK_MINUTES + ' minutes. If you did not ask for it, ignore this email.',
    htmlBody: '<div style="font:16px/1.5 Arial,sans-serif;max-width:520px">' +
      '<p>Tap the button on the phone you want to sign in on. That phone then stays signed in.</p>' +
      '<p><a href="' + link + '" style="display:inline-block;background:#2c3a8c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Sign in to Budget Tracker</a></p>' +
      '<p style="color:#666;font-size:13px">The link works once and expires in ' + LINK_MINUTES + ' minutes. If you did not ask for it, ignore this email.</p></div>'
  });
  return {ok: true, sent: true};
}
function verifyGoogle(ss, idToken) {
  var cid = configValue(ss, 'google client id');
  if (!cid) return {ok: false, error: 'no_client_id'};
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {muteHttpExceptions: true});
  if (r.getResponseCode() !== 200) return {ok: false, error: 'bad_token'};
  var p = JSON.parse(r.getContentText());
  var issuerOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  if (p.aud !== cid || !issuerOk || String(p.email_verified) !== 'true' || +p.exp * 1000 < Date.now()) return {ok: false, error: 'bad_token'};
  var u = findUser(ss, p.email);
  if (!u) return {ok: false, error: 'not_allowed', email: p.email};
  if (!u.name && p.name) { ss.getSheetByName('Users').getRange(u.row, 2).setValue(p.name); u.name = p.name; }
  return {ok: true, user: u};
}
function configValue(ss, name) {
  var r = rows(ss.getSheetByName('Config'));
  for (var i = 0; i < r.length; i++) if (String(r[i][0]).trim().toLowerCase() === name) return String(r[i][1]).trim();
  return '';
}
function listUsers(ss) {
  return rows(ss.getSheetByName('Users')).map(function (row, i) {
    return {email: String(row[0]).trim().toLowerCase(), name: txt(row[1]), role: /^owner$/i.test(String(row[2]).trim()) ? 'Owner' : 'Member', row: i + 2};
  }).filter(function (u) { return /@/.test(u.email); });
}
function findUser(ss, email) {
  email = String(email || '').trim().toLowerCase();
  var all = listUsers(ss);
  for (var i = 0; i < all.length; i++) if (all[i].email === email) return all[i];
  return null;
}
function userOp(ss, op, me) {
  if (!me || me.role !== 'Owner') return;
  var sh = ss.getSheetByName('Users'), email = String(op.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  var u = findUser(ss, email);
  if (op.t === 'adduser') {
    if (u) return;
    sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setNumberFormat('@')
      .setValues([[email, txt(op.name), op.role === 'Owner' ? 'Owner' : 'Member', me.email || 'Set-up link', stamp()]]);
  } else if (u) {
    var owners = listUsers(ss).filter(function (x) { return x.role === 'Owner'; });
    if (u.role === 'Owner' && owners.length < 2) return; // never remove the last owner
    sh.deleteRow(u.row);
  }
}

/* ---------- entry links: add entries and keep notes, nothing else ---------- */
function entryUser(props, tok) {
  tok = String(tok || '');
  if (!/^[a-f0-9]{40,80}$/.test(tok)) return null;
  var raw = props.getProperty('elink:' + tok); if (!raw) return null;
  var L = JSON.parse(raw);
  return {email: 'entry-' + L.id, name: L.name || 'Entry link', role: 'Entry', link: L.id};
}
function listEntryLinks(props) {
  var all = props.getProperties(), list = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('elink:') !== 0) return;
    try { var L = JSON.parse(all[k]); list.push({id: L.id, name: L.name, at: L.at, link: APP_URL + '#entry=' + k.slice(6)}); } catch (e) {}
  });
  return list.sort(function (a, b) { return a.at - b.at; });
}
function entryLinkOp(props, op) {
  var id = String(op.id || '');
  if (!/^[a-z0-9]{6,16}$/.test(id)) return;
  var all = props.getProperties(), key = '';
  Object.keys(all).forEach(function (k) { if (k.indexOf('elink:') === 0) { try { if (JSON.parse(all[k]).id === id) key = k; } catch (e) {} } });
  if (op.t === 'elinkdel') { if (key) props.deleteProperty(key); return; }
  if (key) return; // the same request sent twice
  var name = String(op.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Entry link';
  props.setProperty('elink:' + newToken(), JSON.stringify({id: id, name: name, at: Date.now()}));
}
function entryLog(ss) { return rows(ss.getSheetByName('EntryLog')); }
function entryIds(ss, user) {
  var mine = {};
  entryLog(ss).forEach(function (r) { if (String(r[1]) === user.link) mine[String(r[0])] = true; });
  return mine;
}
// An entry link may add new entries, and change or delete only the ones it added.
function entryTxnOp(ss, op, user) {
  var id = String(op.t === 'txn' ? (op.txn || {}).id : op.id || '');
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return;
  var mine = entryIds(ss, user);
  if (op.t === 'deltxn') {
    if (mine[id]) deleteRowsWhere(ss.getSheetByName('Entries'), function (row) { return String(row[0]) === id; });
    return;
  }
  var t = op.txn, cfg = readConfig(ss);
  if (!cfg || !t || !dstr(t.date) || !(+t.amount > 0) || !maps(cfg).cat[t.cat]) return;
  if (!mine[id]) {
    var sh = ss.getSheetByName('Entries'), n = sh.getLastRow() - 1;
    var taken = n > 0 && sh.getRange(2, 1, n, 1).getValues().some(function (r) { return String(r[0]) === id; });
    if (taken) return; // someone else's entry
    var log = ss.getSheetByName('EntryLog');
    log.getRange(log.getLastRow() + 1, 1, 1, 4).setNumberFormat('@').setValues([[id, user.link, user.name, stamp()]]);
  }
  putTxn(ss, t, cfg);
}
// What an entry link gets back: the lists the Add entry form needs, and its own recent entries. No budgets, no
// balances, no card limits, nobody else's entries.
function entryData(ss, user) {
  var cfg = readConfig(ss);
  if (!cfg) return {config: null, txns: [], balances: {}, cardfix: {}};
  var pick = function (o, keys) { var r = {}; keys.forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; }); return r; };
  var c = {
    cycleStartDay: cfg.cycleStartDay, chips: cfg.chips || [], payBanks: cfg.payBanks || [],
    categories: (cfg.categories || []).map(function (x) { return pick(x, ['id', 'name', 'short', 'type', 'group', 'role', 'icon', 'emoji', 'color', 'hidden', 'archived']); }),
    accounts: (cfg.accounts || []).filter(function (a) { return a.cls === 'Bank' || a.cls === 'Cash'; })
      .map(function (a) { return pick(a, ['id', 'name', 'cls', 'pay', 'vault', 'into', 'owner']); }),
    cards: (cfg.cards || []).map(function (k) { return pick(k, ['id', 'name', 'stmtDay', 'dueDay']); }),
    cardsRemoved: (cfg.cardsRemoved || []).map(function (k) { return pick(k, ['id', 'name']); })
  };
  // Everyone's entries, to read; "mine" lists the ones this link added, the only ones it may change.
  return {config: c, txns: readTxns(ss, cfg), mine: Object.keys(entryIds(ss, user)), balances: {}, cardfix: {}};
}

/* ---------- kill switch ---------- */
// The kill code is never stored, only a salted, slow fingerprint of it. Five wrong tries lock it for an hour.
function codeHash(salt, code) {
  var h = salt + '|' + code;
  for (var i = 0; i < 1000; i++) h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  return h;
}
function checkKillCode(props, code) {
  var saved = props.getProperty('KILL_CODE');
  if (!saved) return {ok: false, error: 'no_kill_code'};
  var tr = JSON.parse(props.getProperty('KILL_TRIES') || '{"n":0,"t":0}');
  if (Date.now() - tr.t > 3600000) tr = {n: 0, t: Date.now()};
  if (tr.n >= 5) return {ok: false, error: 'too_many'};
  var s = JSON.parse(saved);
  if (codeHash(s.salt, String(code || '')) !== s.hash) { tr.n++; props.setProperty('KILL_TRIES', JSON.stringify(tr)); return {ok: false, error: 'bad_code'}; }
  props.deleteProperty('KILL_TRIES');
  return {ok: true};
}
function setKillCode(props, op) {
  var code = String(op.code || '');
  if (code.length < 8) return 'short';
  if (props.getProperty('KILL_CODE')) { var c = checkKillCode(props, op.old); if (!c.ok) return c.error; }
  var salt = newToken();
  props.setProperty('KILL_CODE', JSON.stringify({salt: salt, hash: codeHash(salt, code), at: Date.now()}));
  return '';
}
// Needs only the kill code, not a sign-in, so it works from any phone, even one that was never signed in.
function killSwitch(props, req) {
  var kill = !!req.kill, c = checkKillCode(props, kill ? req.kill : req.revive);
  if (!c.ok) return c;
  if (kill) props.setProperty('KILLED', JSON.stringify({at: Date.now()})); else props.deleteProperty('KILLED');
  return {ok: true, killed: kill};
}
/* Backup, from the script editor (Run): close or reopen the app without the kill code. */
function killApp() { PropertiesService.getScriptProperties().setProperty('KILLED', JSON.stringify({at: Date.now()})); Logger.log('App closed for everyone.'); }
function reviveApp() { var p = PropertiesService.getScriptProperties(); p.deleteProperty('KILLED'); p.deleteProperty('KILL_TRIES'); Logger.log('App open again.'); }

/* ---------- vault (owners only; holds only encrypted text) ---------- */
// Applies all vault changes in one read and one write.
function vaultApply(ss, ops, me) {
  if (!ops.length || !me || me.role !== 'Owner') return;
  var sh = ss.getSheetByName('Vault'), old = rows(sh), map = {}, list = [];
  old.forEach(function (r) { if (r[0]) { map[String(r[0])] = list.length; list.push([String(r[0]), String(r[1]), r[2]]); } });
  ops.forEach(function (op) {
    var id = String(op.id || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return;
    if (op.t === 'vdel') { if (id in map) { list[map[id]] = null; delete map[id]; } return; }
    var data = String(op.data || '');
    if (!/^v1\.[A-Za-z0-9+\/=]+\.[A-Za-z0-9+\/=]+$/.test(data) && !/^meta\.[A-Za-z0-9+\/=]+$/.test(data)) return; // only encrypted text
    var row = [id, data, stamp()];
    if (id in map) list[map[id]] = row; else { map[id] = list.length; list.push(row); }
  });
  list = list.filter(Boolean);
  if (list.length) sh.getRange(2, 1, list.length, 3).setNumberFormat('@').setValues(list);
  if (old.length > list.length) sh.getRange(2 + list.length, 1, old.length - list.length, 3).clearContent();
}
function readVault(ss) {
  return rows(ss.getSheetByName('Vault')).filter(function (r) { return r[0] && r[1]; })
    .map(function (r) { return {id: String(r[0]), data: String(r[1])}; });
}


/* ---------- notes: one real file per note in Drive ----------
   Each person sees their own notes, plus every note someone shared with them. A note is shared with everyone
   who can open the app, or with chosen people (Users tab and entry links); anyone it is shared with can change
   its text and title. Anyone it is shared with can edit it, change who it is shared with, delete it for everyone, and pin, label or remove it for themselves only (NotePrefs tab); it stays
   the author's (Owner column) whoever edits it. The Shared column holds Yes (everyone) or the chosen people,
   separated by commas (an email, or entry-<id> for an entry link). Files sit in the owner's Drive, folder "Budget Tracker notes".
   Run setupNotes() once from the editor after pasting this file: Google then asks to allow Drive access. */
var NOTE_TYPES = {md: ['md', 'text/markdown'], html: ['html', 'text/html'], txt: ['txt', 'text/plain'], json: ['json', 'application/json']};
var NOTES_FOLDER = 'Budget Tracker notes';
function setupNotes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(); ensureTabs(ss);
  Logger.log('Notes folder ready: ' + notesFolder().getUrl());
}
function notesFolder() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('notesFolder');
  if (id) { try { var f0 = DriveApp.getFolderById(id); if (!f0.isTrashed()) return f0; } catch (e) {} }
  var it = DriveApp.getFoldersByName(NOTES_FOLDER), f = it.hasNext() ? it.next() : DriveApp.createFolder(NOTES_FOLDER);
  p.setProperty('notesFolder', f.getId());
  return f;
}
function noteOwner(user) { return String((user && user.email) || 'owner').toLowerCase(); }
function noteFileName(title, type) {
  var t = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
  return t + '.' + NOTE_TYPES[type][0];
}
var NOTE_LABELS = {arhaan: 1, efrah: 1, other: 1};
// Built-in labels, or a name the person added (letters, numbers, spaces; up to 24 characters).
function okLabel(v) { v = String(v == null ? '' : v); return NOTE_LABELS[v] || /^[^\u0000-\u001f<>"]{1,24}$/.test(v) && v.trim() === v ? v : ''; }
function notesHead(sh) { // older Notes tabs get the label/pin/shared columns added
  if (sh.getLastColumn() < TABS.Notes.length || String(sh.getRange(1, 9).getValue()) !== 'Label' || String(sh.getRange(1, 12).getValue()) !== 'Shared') sh.getRange(1, 1, 1, TABS.Notes.length).setValues([TABS.Notes]).setFontWeight('bold');
}
function isYes(v) { return /^(yes|true|1)$/i.test(txt(v)); }
// The people a note can be shared with: everyone on the Users tab and every entry link. The app sees a short id
// for each (never the email), the sheet keeps the email / entry-<id>.
function personId(key) { // plain JavaScript (two small string hashes), so it needs no Google service that could fail
  key = String(key); var h1 = 2166136261, h2 = 5381;
  for (var i = 0; i < key.length; i++) {
    var c = key.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}
function notePeople(ss) {
  var list = [];
  listUsers(ss).forEach(function (u) { list.push({key: u.email, name: u.name || u.email.replace(/@.*/, '')}); });
  listEntryLinks(PropertiesService.getScriptProperties()).forEach(function (L) { list.push({key: 'entry-' + L.id, name: L.name || 'Entry link'}); });
  list.forEach(function (p) { p.id = personId(p.key); });
  return list;
}
// What the Shared cell holds: '' (private), 'Yes' (everyone) or "key,key".
function sharedList(v) { return isYes(v) ? 'all' : txt(v).split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean); }
function sharedWith(row, me) { var s = sharedList(row[11]); return s === 'all' || s.indexOf(me) >= 0; }
// n.share: 'all', a list of person ids, or '' (private). An older app sends only n.shared (true = everyone).
// Nothing sent keeps what the sheet has.
function shareCell(n, old, ss, me) {
  if (n.share === 'all') return 'Yes';
  if (Array.isArray(n.share)) {
    var want = {}; n.share.forEach(function (id) { want[String(id)] = 1; });
    return notePeople(ss).filter(function (p) { return want[p.id] && p.key !== me; }).map(function (p) { return p.key; }).join(',');
  }
  if (n.share === '' || n.share === 'none') return '';
  if (n.shared != null) return n.shared ? 'Yes' : '';
  return old ? txt(old[11]) : '';
}
// Label, pin, pin order, shared.
function noteMeta(n, old, ss, me) {
  return [okLabel(n.cat) || (old && okLabel(old[8])) || 'other', n.pinned ? 'Yes' : '', isFinite(+n.order) ? +n.order : 0, shareCell(n, old, ss, me)];
}
// Who wrote a shared note: the name on the Users tab, or the entry link's name.
function noteAuthors(ss) {
  var m = {};
  listUsers(ss).forEach(function (u) { m[u.email] = u.name || u.email; });
  listEntryLinks(PropertiesService.getScriptProperties()).forEach(function (L) { m['entry-' + L.id] = L.name || 'Entry link'; });
  return m;
}
// A person's own label, pin and "removed" mark for notes they did not write. Never changes the author's note.
function prefsMap(ss, me) {
  var m = {};
  rows(ss.getSheetByName('NotePrefs')).forEach(function (r) { if (String(r[1]).toLowerCase() === me) m[String(r[0])] = r; });
  return m;
}
function prefPut(ss, id, me, label, pinned, order, hidden) {
  var sh = ss.getSheetByName('NotePrefs'), r = rows(sh), row = [id, me, label, pinned ? 'Yes' : '', order, hidden ? 'Yes' : ''];
  for (var i = 0; i < r.length; i++) if (String(r[i][0]) === id && String(r[i][1]).toLowerCase() === me) { sh.getRange(i + 2, 1, 1, 6).setNumberFormat('@').setValues([row]); return; }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setNumberFormat('@').setValues([row]);
}
function prefsDrop(ss, id) { deleteRowsWhere(ss.getSheetByName('NotePrefs'), function (row) { return String(row[0]) === id; }); }
function noteOp(ss, op, user) {
  var sh = ss.getSheetByName('Notes'); notesHead(sh);
  var r = rows(sh), me = noteOwner(user);
  var id = String((op.t === 'nput' ? (op.note || {}).id : op.id) || '');
  if (op.t === 'nmeta') { // label, pin and pin order only: the file in Drive is untouched
    for (var k = 0; k < r.length; k++) if (String(r[k][0]) === id && String(r[k][3]).toLowerCase() === me) { sh.getRange(k + 2, 9, 1, 4).setNumberFormat('@').setValues([noteMeta(op, r[k], ss, me)]); return; }
    var g = -1; for (var q = 0; q < r.length; q++) if (String(r[q][0]) === id) { g = q; break; }
    if (g >= 0 && sharedWith(r[g], me)) { // someone else's note, shared with me: my own label and pin, and who else it is shared with
      prefPut(ss, id, me, okLabel(op.cat) || 'other', op.pinned, isFinite(+op.order) ? +op.order : 0, false);
      if (op.share !== undefined) {
        var cell = shareCell(op, r[g], ss, ''); // I never drop myself from the list (that is "remove from my notes"); the author always keeps it
        if (cell !== 'Yes') cell = cell.split(',').filter(function (x) { return x && x !== String(r[g][3]).toLowerCase(); }).concat(me).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(',');
        sh.getRange(g + 2, 12).setNumberFormat('@').setValue(cell);
      }
    }
    return;
  }
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return;
  var at = -1;
  for (var i = 0; i < r.length; i++) if (String(r[i][0]) === id) { at = i; break; }
  var guest = at >= 0 && String(r[at][3]).toLowerCase() !== me;
  if (guest && !sharedWith(r[at], me)) return; // someone else's note: only while it is shared with you
  if (guest && op.t === 'ndel') { prefPut(ss, id, me, '', false, 0, true); return; } // not the author: it leaves my list only, everyone else keeps it
  // ndelall: delete for everyone. The author may, and so may anyone it is shared with (the file goes to the Drive bin).
  var oldFile = at >= 0 ? String(r[at][4] || '') : '';
  if (op.t === 'ndel' || op.t === 'ndelall') {
    if (oldFile) { try { DriveApp.getFileById(oldFile).setTrashed(true); } catch (e) {} }
    if (at >= 0) sh.deleteRow(at + 2);
    prefsDrop(ss, id);
    return;
  }
  var n = op.note, type = NOTE_TYPES[n.type] ? n.type : 'txt', content = String(n.content == null ? '' : n.content), title = String(n.title || '').slice(0, 200);
  var name = noteFileName(title || content.split('\n')[0], type), file = null;
  if (at >= 0 && String(r[at][2]) === type && oldFile) { try { file = DriveApp.getFileById(oldFile); if (file.isTrashed()) file = null; } catch (e) { file = null; } }
  if (file) { file.setContent(content); if (file.getName() !== name) file.setName(name); }
  else {
    file = notesFolder().createFile(name, content, NOTE_TYPES[type][1]);
    if (oldFile) { try { DriveApp.getFileById(oldFile).setTrashed(true); } catch (e) {} } // the type changed: new file, old one to the bin
  }
  var preview = content.replace(/<[^>]*>/g, ' ').replace(/```[^\n]*/g, ' ').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/\[( |x|X)\]\s+/g, '')
    .replace(/(\*\*|__|~~|`)/g, '').replace(/[ \t]*\n+[ \t]*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 140);
  // A guest's edit keeps the author as owner, and the author's label, pin and sharing.
  var meta = guest ? [txt(r[at][8]) || 'other', txt(r[at][9]), +r[at][10] || 0, txt(r[at][11])] : noteMeta(n, at >= 0 ? r[at] : null, ss, me);
  var row = [id, title, type, guest ? String(r[at][3]) : me, file.getId(), stamp(+n.updatedAt || Date.now()), content.length, preview].concat(meta);
  if (at >= 0) sh.getRange(at + 2, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
function readNotes(ss, user) {
  var me = noteOwner(user), names = null, people = null, prefs = prefsMap(ss, me);
  return rows(ss.getSheetByName('Notes')).filter(function (r) { return r[0] && (String(r[3]).toLowerCase() === me || (sharedWith(r, me) && !(prefs[String(r[0])] && isYes(prefs[String(r[0])][5])))); }).map(function (r) {
    var owner = String(r[3]).toLowerCase(), mine = owner === me, sl = sharedList(r[11]), n = {id: String(r[0]), title: txt(r[1]), type: NOTE_TYPES[r[2]] ? String(r[2]) : 'txt', fileId: txt(r[4]),
      updatedAt: Date.parse(txt(r[5])) || 0, size: +r[6] || 0, preview: txt(r[7]), cat: okLabel(txt(r[8])) || 'other', mine: mine,
      pinned: mine && isYes(r[9]), order: mine ? +r[10] || 0 : 0}; // an author's pins are theirs; a guest's come from NotePrefs
    people = people || notePeople(ss);
    n.all = sl === 'all'; n.with = n.all ? [] : people.filter(function (p) { return p.key !== me && sl.indexOf(p.key) >= 0; }).map(function (p) { return p.id; });
    if (mine) n.shared = n.all || n.with.length > 0;
    else {
      n.shared = true; var ow = people.filter(function (p) { return p.key === owner; })[0]; n.ownerId = ow ? ow.id : ''; names = names || noteAuthors(ss); n.by = names[owner] || owner.replace(/@.*/, ''); n.fileId = '';
      var pf = prefs[n.id]; // my own label and pin for someone else's note
      if (pf) { n.cat = okLabel(txt(pf[2])) || n.cat; n.pinned = isYes(pf[3]); n.order = +pf[4] || 0; }
    }
    return n;
  });
}
// Note text from Drive, for your own notes and the ones shared with you only.
function noteBodies(ss, ids, user) {
  var me = noteOwner(user), ok = {}, out = {};
  rows(ss.getSheetByName('Notes')).forEach(function (r) { if (r[0] && r[4] && (String(r[3]).toLowerCase() === me || sharedWith(r, me))) ok[String(r[0])] = String(r[4]); });
  ids.slice(0, 20).forEach(function (id) { var f = ok[String(id)]; if (!f) return;
    try { out[String(id)] = DriveApp.getFileById(f).getBlob().getDataAsString('UTF-8'); } catch (e) {} });
  return out;
}

/* ---------- sheet helpers ---------- */
function ensureTabs(ss) {
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange('A:Z').setNumberFormat('@');
    }
  });
}
function tz() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Kolkata'; }
function rows(sh) {
  var n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
}
function dstr(v) { // any cell value -> 'yyyy-MM-dd' or ''
  if (v instanceof Date) return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  v = String(v == null ? '' : v).trim();
  var m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dd/mm/yyyy as typed in India
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}
function num(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v == null ? '' : v).replace(/[,\s₹]/g, '').replace('−', '-'));
  return isFinite(n) ? n : NaN;
}
function stamp(ms) { return Utilities.formatDate(new Date(ms || Date.now()), tz(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function txt(v) { return v == null ? '' : String(v); }
function deleteRowsWhere(sh, test) {
  var r = rows(sh);
  for (var i = r.length - 1; i >= 0; i--) if (test(r[i])) sh.deleteRow(i + 2);
}

/* ---------- config ---------- */
function readConfig(ss) {
  var sh = ss.getSheetByName('Config'), r = rows(sh), parts = [];
  r.forEach(function (row) { var m = String(row[0]).match(/^config part (\d+)$/); if (m) parts[+m[1] - 1] = String(row[1]); });
  if (!parts.length) return null;
  try { return JSON.parse(parts.join('')); } catch (e) { return null; }
}
function writeConfig(ss, cfg) {
  var sh = ss.getSheetByName('Config');
  deleteRowsWhere(sh, function (row) { return /^config part \d+$/.test(String(row[0])); });
  var s = JSON.stringify(cfg), data = [];
  for (var i = 0, p = 1; i < s.length; i += CHUNK, p++) {
    data.push(['config part ' + p, s.slice(i, i + CHUNK), p === 1 ? 'Categories, budgets, accounts and cards. Change these in the app, not here.' : '']);
  }
  if (data.length) sh.getRange(sh.getLastRow() + 1, 1, data.length, 3).setNumberFormat('@').setValues(data);
  refreshNames(ss, cfg);
}
function maps(cfg) {
  var m = {cat: {}, catByName: {}, acct: {}, card: {}};
  if (!cfg) return m;
  (cfg.categories || []).forEach(function (c) { m.cat[c.id] = c; m.catByName[String(c.name).toLowerCase()] = c; });
  (cfg.accounts || []).forEach(function (a) { m.acct[a.id] = a; });
  (cfg.cards || []).forEach(function (c) { m.card[c.id] = c; });
  return m;
}
function cycleOf(date, cfg) {
  var S = Math.min(28, Math.max(1, +(cfg && cfg.cycleStartDay) || 25));
  var p = date.split('-').map(Number), y = p[0], mo = p[1];
  if (S > 1 && p[2] >= S) { mo++; if (mo > 12) { mo = 1; y++; } }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MON[mo - 1] + '-' + String(y).slice(2);
}
// Keep the human-readable columns in step when names change in Setup.
function refreshNames(ss, cfg) {
  var M = maps(cfg);
  var sh = ss.getSheetByName('Entries'), r = rows(sh);
  if (r.length) {
    var block = r.map(function (row) {
      var c = M.cat[row[E.cat]], d = dstr(row[E.date]);
      return [d ? cycleOf(d, cfg) : row[E.cycle], c ? c.type : row[E.type], c ? c.name : row[E.catName], row[E.amount],
              M.acct[row[E.acct]] ? M.acct[row[E.acct]].name : (row[E.acct] ? row[E.acctName] : ''),
              M.card[row[E.card]] ? M.card[row[E.card]].name : (row[E.card] ? row[E.cardName] : '')];
    });
    sh.getRange(2, E.cycle + 1, block.length, 6).setValues(block);
  }
  var bs = ss.getSheetByName('Balances'), br = rows(bs);
  if (br.length) bs.getRange(2, 3, br.length, 1).setValues(br.map(function (row) { return [M.acct[row[1]] ? M.acct[row[1]].name : row[2]]; }));
  var fs = ss.getSheetByName('CardFix'), fr = rows(fs);
  if (fr.length) fs.getRange(2, 2, fr.length, 1).setValues(fr.map(function (row) { return [M.card[row[0]] ? M.card[row[0]].name : row[1]]; }));
}

/* ---------- entries ---------- */
function txnRow(t, cfg) {
  var M = maps(cfg), c = M.cat[t.cat] || {}, a = M.acct[t.acct], k = M.card[t.card];
  return [txt(t.id), txt(t.date), cycleOf(t.date, cfg), txt(c.type || 'Expense'), txt(c.name || ''), +t.amount || 0,
          a ? a.name : '', k ? k.name : '', txt(t.note), txt(t.member), txt(t.tag), t.refund ? 'Yes' : '',
          txt(t.cat), txt(t.acct), txt(t.card), stamp(t.at), stamp()];
}
function putTxn(ss, t, cfg) {
  if (!t || !t.id || !dstr(t.date) || !isFinite(+t.amount)) return;
  var sh = ss.getSheetByName('Entries'), ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
  var row = txnRow(t, cfg);
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(t.id)) {
      var old = sh.getRange(i + 2, E.at + 1).getValue();
      if (old) row[E.at] = old; // keep the original "Created at"
      sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  sh.getRange(sh.getLastRow(), E.amount + 1).setNumberFormat('#,##0.00');
}
function readTxns(ss, cfg) {
  var sh = ss.getSheetByName('Entries'), r = rows(sh), M = maps(cfg), list = [], fixes = [];
  r.forEach(function (row, i) {
    var date = dstr(row[E.date]), amount = num(row[E.amount]);
    if (!date || !isFinite(amount) || amount === 0) return;
    var id = txt(row[E.id]).trim(), cat = txt(row[E.cat]).trim();
    // Rows typed straight into the sheet: give them an ID and match the category by name.
    if (!cat && row[E.catName]) { var byName = M.catByName[String(row[E.catName]).trim().toLowerCase()]; if (byName) { cat = byName.id; fixes.push([i + 2, E.cat + 1, cat]); } }
    if (!id) { id = 's' + Date.now().toString(36) + i; fixes.push([i + 2, E.id + 1, id]); }
    var at = Date.parse(txt(row[E.at])) || 0;
    list.push({id: id, date: date, amount: Math.abs(amount), cat: cat, acct: txt(row[E.acct]), note: txt(row[E.note]),
               member: txt(row[E.member]), tag: txt(row[E.tag]), at: at, refund: /^(yes|y|true|1)$/i.test(txt(row[E.refund])) || amount < 0,
               card: txt(row[E.card])});
  });
  fixes.forEach(function (f) { sh.getRange(f[0], f[1]).setNumberFormat('@').setValue(f[2]); });
  return list;
}

/* ---------- balances and card figures ---------- */
function putBalance(ss, date, values, cfg) {
  var sh = ss.getSheetByName('Balances'), M = maps(cfg);
  deleteRowsWhere(sh, function (row) { return dstr(row[0]) === date; });
  var data = Object.keys(values || {}).filter(function (id) { return isFinite(+values[id]); })
    .map(function (id) { return [date, id, M.acct[id] ? M.acct[id].name : '', +values[id]]; });
  if (data.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, data.length, 3).setNumberFormat('@');
    sh.getRange(start, 4, data.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(start, 1, data.length, 4).setValues(data);
  }
}
function readBalances(ss) {
  var b = {};
  rows(ss.getSheetByName('Balances')).forEach(function (row) {
    var d = dstr(row[0]), v = num(row[3]); if (!d || !row[1] || !isFinite(v)) return;
    (b[d] = b[d] || {date: d, values: {}}).values[String(row[1])] = v;
  });
  return b;
}
function putFix(ss, card, sd, v, cfg) {
  var sh = ss.getSheetByName('CardFix'), M = maps(cfg);
  deleteRowsWhere(sh, function (row) { return String(row[0]) === String(card) && dstr(row[2]) === sd; });
  if (v === null || v === undefined || !isFinite(+v)) return;
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, 1, 3).setNumberFormat('@');
  sh.getRange(start, 1, 1, 4).setValues([[card, M.card[card] ? M.card[card].name : '', sd, +v]]);
}
function readFixes(ss) {
  var f = {};
  rows(ss.getSheetByName('CardFix')).forEach(function (row) {
    var sd = dstr(row[2]), v = num(row[3]); if (!row[0] || !sd || !isFinite(v)) return;
    (f[row[0]] = f[row[0]] || {card: String(row[0]), fix: {}}).fix[sd] = v;
  });
  return f;
}

/* ---------- ops ---------- */
function applyOp(ss, op) {
  if (!op || !op.t) return;
  var cfg = readConfig(ss);
  switch (op.t) {
    case 'config': if (op.config && Array.isArray(op.config.categories)) writeConfig(ss, op.config); break;
    case 'txn': putTxn(ss, op.txn, cfg); break;
    case 'deltxn': deleteRowsWhere(ss.getSheetByName('Entries'), function (row) { return String(row[0]) === String(op.id); }); break;
    case 'bal': if (dstr(op.date)) putBalance(ss, dstr(op.date), op.values, cfg); break;
    case 'delbal': deleteRowsWhere(ss.getSheetByName('Balances'), function (row) { return dstr(row[0]) === op.date; }); break;
    case 'fix': putFix(ss, op.card, op.sd, op.v, cfg); break;
    case 'replace': replaceAll(ss, op); break;
  }
}
function clearBody(sh) { if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); }
function replaceAll(ss, op) {
  if (!op.config || !Array.isArray(op.config.categories)) return;
  ['Entries', 'Balances', 'CardFix'].forEach(function (n) { clearBody(ss.getSheetByName(n)); });
  writeConfig(ss, op.config);
  var sh = ss.getSheetByName('Entries');
  var data = (op.txns || []).filter(function (t) { return t && t.id && dstr(t.date) && isFinite(+t.amount); })
    .map(function (t) { return txnRow(t, op.config); });
  if (data.length) {
    sh.getRange(2, 1, data.length, data[0].length).setNumberFormat('@');
    sh.getRange(2, E.amount + 1, data.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(2, 1, data.length, data[0].length).setValues(data);
  }
  Object.keys(op.balances || {}).forEach(function (d) { putBalance(ss, d, op.balances[d].values, op.config); });
  Object.keys(op.cardfix || {}).forEach(function (c) {
    var fx = (op.cardfix[c] && op.cardfix[c].fix) || {};
    Object.keys(fx).forEach(function (sd) { putFix(ss, c, sd, fx[sd], op.config); });
  });
}
function readAll(ss) {
  var cfg = readConfig(ss);
  return {config: cfg, txns: readTxns(ss, cfg), balances: readBalances(ss), cardfix: readFixes(ss)};
}

/* Run this once from the editor to check everything is wired up. */
function selfTest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTabs(ss);
  var d = readAll(ss);
  Logger.log('Google client ID set: ' + !!configValue(ss, 'google client id') + ', users: ' + listUsers(ss).length);
  Logger.log('Config found: ' + !!d.config + ', entries: ' + d.txns.length + ', balance dates: ' + Object.keys(d.balances).length);
}

/* ---------- reminders (Nov 2026) ----------
   The app keeps every reminder in one Config row ("reminders"): JSON {items, auto, st, ran, sent}.
   - items: reminders you set (on an entry: "Remind me", or on a Vault row). auto: card bills still unpaid, worked out by the
     app from the same card maths every screen uses. st: what you did with each one (done, dismissed, snoozed until),
     keyed by "<id>@<due date>", so a new bill or a new date starts fresh.
   - remindTick() runs at 9 am, 3 pm and 9 pm (run setupReminders() once to create those). If anything is due within 72
     hours (or overdue), it wakes the phone with a Web Push message. The message is empty: the phone's service worker
     shows the details from its own copy, so nothing about your money travels through the push service.
   - Web Push needs the message signed (VAPID, ES256 on the P-256 curve). Apps Script has no tool for that, so it is done
     below in plain JavaScript. The private key never leaves Script Properties. */
var REM_OPS = {remput: 1, remst: 1, pushsub: 1, pushdel: 1, pushtest: 1};
var REM_WINDOW_H = 72, REM_KEEP_DAYS = 45, REM_HOURS = [9, 15, 21];

function readRem(ss) {
  var r = rows(ss.getSheetByName('Config'));
  for (var i = 0; i < r.length; i++) if (String(r[i][0]) === 'reminders') { try { return remClean(JSON.parse(String(r[i][1] || '{}'))); } catch (e) { break; } }
  return remClean({});
}
function remClean(o) {
  o = o || {};
  return {items: Array.isArray(o.items) ? o.items : [], auto: Array.isArray(o.auto) ? o.auto : [],
    st: o.st && typeof o.st === 'object' && !Array.isArray(o.st) ? o.st : {}, ran: +o.ran || 0, sent: +o.sent || 0, due: +o.due || 0};
}
function writeRem(ss, rem) {
  remPrune(rem);
  var sh = ss.getSheetByName('Config'), r = rows(sh), s = JSON.stringify(rem);
  for (var i = 0; i < r.length; i++) if (String(r[i][0]) === 'reminders') { sh.getRange(i + 2, 2).setNumberFormat('@').setValue(s); return; }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setNumberFormat('@').setValues([['reminders', s, 'Reminders and what you did with them. Set them in the app.']]);
}
// Old states go: anything due more than 90 days ago, so the cell stays small.
function remPrune(rem) {
  var cut = Utilities.formatDate(new Date(Date.now() - 90 * 864e5), tz(), 'yyyy-MM-dd');
  Object.keys(rem.st).forEach(function (k) { var d = k.split('@').pop(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < cut) delete rem.st[k]; });
}
function remStr(v, n) { return String(v == null ? '' : v).slice(0, n); }
function remItem(x) {
  x = x || {};
  var o = {id: remStr(x.id, 120), kind: remStr(x.kind, 12), title: remStr(x.title, 140), due: dstr(x.due)};
  if (isFinite(+x.amount) && x.amount !== null && x.amount !== '') o.amount = +x.amount;
  ['tag', 'card', 'vt', 'note', 'src'].forEach(function (k) { if (x[k]) o[k] = remStr(x[k], 140); });
  if (+x.every > 0) o.every = Math.min(3650, Math.round(+x.every));
  if (x.pay && typeof x.pay === 'object') { var p = {}; Object.keys(x.pay).slice(0, 12).forEach(function (k) { var v = x.pay[k]; p[remStr(k, 20)] = typeof v === 'number' || typeof v === 'boolean' ? v : remStr(v, 200); }); o.pay = p; }
  return o;
}
function remOp(ss, props, op, user) {
  if (op.t === 'remput') {
    var rem = readRem(ss);
    if (Array.isArray(op.items)) rem.items = op.items.slice(0, 400).map(remItem).filter(function (x) { return x.id && x.due; });
    if (Array.isArray(op.auto)) rem.auto = op.auto.slice(0, 100).map(remItem).filter(function (x) { return x.id && x.due; });
    writeRem(ss, rem);
  } else if (op.t === 'remst') {
    var key = remStr(op.key, 200); if (!key) return;
    var rm = readRem(ss);
    if (!op.v) delete rm.st[key];
    else { var v = {}; ['done', 'dis', 'snooze'].forEach(function (k) { if (+op.v[k] > 0) v[k] = +op.v[k]; }); if (op.v.paid) v.paid = remStr(op.v.paid, 60); rm.st[key] = v; }
    writeRem(ss, rm);
  } else if (op.t === 'pushsub') {
    var sub = op.sub || {}; if (!/^https:\/\/[^\s/]+\//.test(String(sub.endpoint || ''))) return;
    var list = pushSubs(props).filter(function (x) { return x.endpoint !== sub.endpoint; });
    list.unshift({endpoint: String(sub.endpoint), who: String((user && user.email) || ''), at: Date.now()});
    props.setProperty('PUSH_SUBS', JSON.stringify(list.slice(0, 8)));
  } else if (op.t === 'pushdel') {
    props.setProperty('PUSH_SUBS', JSON.stringify(pushSubs(props).filter(function (x) { return x.endpoint !== op.endpoint; })));
  } else if (op.t === 'pushtest') {
    pushAll(props);
  }
}
function pushSubs(props) { try { var l = JSON.parse(props.getProperty('PUSH_SUBS') || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
// The end of the due day, in the sheet's time zone: a bill due on the 5th can be paid until midnight.
function remDueMs(due) { return Utilities.parseDate(due + ' 23:59:59', tz(), 'yyyy-MM-dd HH:mm:ss').getTime(); }
function remDue(rem, now) {
  return rem.items.concat(rem.auto).filter(function (r) {
    if (!r || !r.id || !/^\d{4}-\d{2}-\d{2}$/.test(r.due || '')) return false;
    var left = remDueMs(r.due) - now, st = rem.st[r.id + '@' + r.due] || {};
    if (left > REM_WINDOW_H * 36e5 || left < -REM_KEEP_DAYS * 864e5) return false;
    return !st.done && !st.dis && !(+st.snooze > now);
  });
}
// Runs on its own at 9 am, 3 pm and 9 pm.
function remindTick() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('KILLED')) return;
  var lock = LockService.getScriptLock(); if (!lock.tryLock(30000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), rem = readRem(ss), due = remDue(rem, Date.now());
    var res = due.length ? pushAll(props) : {sent: 0, failed: 0};
    rem.ran = Date.now(); rem.sent = res.sent; rem.due = due.length;
    writeRem(ss, rem);
    Logger.log(due.length + ' due; ' + res.sent + ' phone(s) told, ' + res.failed + ' failed.');
  } finally { lock.releaseLock(); }
}
// Run this ONCE from the editor (choose setupReminders, then Run, and allow access). It creates the three daily checks.
function setupReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'remindTick') ScriptApp.deleteTrigger(t); });
  REM_HOURS.forEach(function (h) { ScriptApp.newTrigger('remindTick').timeBased().atHour(h).everyDays(1).inTimezone(tz()).create(); });
  var props = PropertiesService.getScriptProperties(); vapidKeys(props);
  Logger.log('Reminder checks set for ' + REM_HOURS.join(':00, ') + ':00 (' + tz() + '). Phones signed up for alerts: ' + pushSubs(props).length);
}
// Run from the editor to send a test alert to every phone that turned alerts on.
function testReminder() { var r = pushAll(PropertiesService.getScriptProperties()); Logger.log('Sent to ' + r.sent + ', failed ' + r.failed); }

/* Web Push without a payload: POST to each phone's push address with a signed VAPID token. */
function pushAll(props) {
  var list = pushSubs(props), keep = [], sent = 0, failed = 0, keys = vapidKeys(props);
  list.forEach(function (sub) {
    var code = 0;
    try {
      var aud = String(sub.endpoint).match(/^https:\/\/[^\/]+/)[0];
      var jwt = vapidJwt(keys, aud);
      var r = UrlFetchApp.fetch(sub.endpoint, {method: 'post', payload: '', muteHttpExceptions: true,
        headers: {Authorization: 'vapid t=' + jwt + ', k=' + keys.pub, TTL: '43200', Urgency: 'high'}});
      code = r.getResponseCode();
    } catch (e) { code = -1; }
    if (code >= 200 && code < 300) { sent++; keep.push(sub); }
    else { failed++; if (code !== 404 && code !== 410) keep.push(sub); } // 404/410: that phone unsubscribed; forget it
  });
  if (keep.length !== list.length) props.setProperty('PUSH_SUBS', JSON.stringify(keep));
  return {sent: sent, failed: failed};
}
function vapidKeys(props) {
  var raw = props.getProperty('VAPID');
  if (raw) { try { var k = JSON.parse(raw); if (k.d && k.pub) return k; } catch (e) {} }
  var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Date.now(), Math.random()].join('|');
  var d = ecMod(bytesToBig(ecSha256(utf8Bytes(seed))), EC.n - BigInt(1)) + BigInt(1);
  var Q = ecMul(d, EC.G);
  var keys = {d: d.toString(16), pub: b64url([4].concat(bigToBytes(Q[0]), bigToBytes(Q[1])))};
  props.setProperty('VAPID', JSON.stringify(keys));
  return keys;
}
function vapidJwt(keys, aud) {
  var enc = function (o) { return b64url(utf8Bytes(JSON.stringify(o))); };
  var head = enc({typ: 'JWT', alg: 'ES256'}) + '.' + enc({aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL});
  var sig = ecSign(BigInt('0x' + keys.d), utf8Bytes(head));
  return head + '.' + b64url(bigToBytes(sig[0]).concat(bigToBytes(sig[1])));
}

/* P-256 (secp256r1) in plain JavaScript with BigInt. Signing uses RFC 6979 (the random number k is worked out from the
   key and the message), so a weak random source can never leak the key. */
var EC = (function () {
  var h = function (x) { return BigInt('0x' + x); };
  return {p: h('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff'), n: h('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    G: [h('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), h('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')]};
})();
function ecMod(a, m) { var r = a % m; return r < BigInt(0) ? r + m : r; }
function ecInv(a, m) { // extended Euclid
  var t = BigInt(0), nt = BigInt(1), r = m, nr = ecMod(a, m), q, x;
  while (nr !== BigInt(0)) { q = r / nr; x = t - q * nt; t = nt; nt = x; x = r - q * nr; r = nr; nr = x; }
  return ecMod(t, m);
}
function ecAdd(P, Q) { // affine; null is the point at infinity
  if (!P) return Q; if (!Q) return P;
  var p = EC.p, l;
  if (P[0] === Q[0]) {
    if (ecMod(P[1] + Q[1], p) === BigInt(0)) return null;
    l = ecMod(BigInt(3) * P[0] * P[0] - BigInt(3), p) * ecInv(BigInt(2) * P[1], p) % p; // a = -3
  } else l = ecMod(Q[1] - P[1], p) * ecInv(Q[0] - P[0], p) % p;
  var x = ecMod(l * l - P[0] - Q[0], p);
  return [x, ecMod(l * (P[0] - x) - P[1], p)];
}
function ecMul(k, P) { var R = null, A = P; while (k > BigInt(0)) { if (k & BigInt(1)) R = ecAdd(R, A); A = ecAdd(A, A); k >>= BigInt(1); } return R; }
function ecSign(d, msg) {
  var n = EC.n, hb = ecSha256(msg), e = ecMod(bytesToBig(hb), n), x = bigToBytes(d), h1 = bigToBytes(e);
  var V = [], K = [], i; for (i = 0; i < 32; i++) { V.push(1); K.push(0); }
  K = ecHmac(K, V.concat([0], x, h1)); V = ecHmac(K, V);
  K = ecHmac(K, V.concat([1], x, h1)); V = ecHmac(K, V);
  for (var guard = 0; guard < 100; guard++) {
    V = ecHmac(K, V); var k = bytesToBig(V);
    if (k > BigInt(0) && k < n) {
      var R = ecMul(k, EC.G), r = ecMod(R[0], n);
      if (r !== BigInt(0)) { var s = ecMod(ecInv(k, n) * (e + r * d), n); if (s !== BigInt(0)) return [r, s]; }
    }
    K = ecHmac(K, V.concat([0])); V = ecHmac(K, V);
  }
  throw new Error('sign failed');
}
function bytesToBig(b) { var h = '0x'; for (var i = 0; i < b.length; i++) h += ('0' + (b[i] & 255).toString(16)).slice(-2); return BigInt(h === '0x' ? '0' : h); }
function bigToBytes(v) { var h = v.toString(16); while (h.length < 64) h = '0' + h; var o = []; for (var i = 0; i < 64; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o; }
function signedBytes(b) { return b.map(function (x) { x &= 255; return x > 127 ? x - 256 : x; }); }
function unsignedBytes(b) { var o = []; for (var i = 0; i < b.length; i++) o.push(b[i] & 255); return o; }
function utf8Bytes(s) { return unsignedBytes(Utilities.newBlob(s).getBytes()); }
function ecSha256(b) { return unsignedBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signedBytes(b))); }
function ecHmac(key, data) { return unsignedBytes(Utilities.computeHmacSha256Signature(signedBytes(data), signedBytes(key))); }
function b64url(b) { return Utilities.base64EncodeWebSafe(signedBytes(b)).replace(/=+$/, ''); }

/* ---------- contacts (Nov 2026): the Contacts page (contacts/) keeps its people in their own spreadsheet ----------
   Same sign-in and the same kill switch as the budget: a contacts request arrives after both checks in doPost.
   {session, contacts: {cursor, changes, tagLib}} touches only the "Budget Tracker contacts" spreadsheet. No budget
   data is read or sent, and the budget's version (REV) does not change. Everyone who can open the app (Owners,
   Members and entry links) can read and edit contacts.
   Rows: one per person. A delete keeps the row with Deleted = TRUE, so a phone that was offline cannot bring the
   contact back. Rev is a counter: a phone asks for every row with a Rev above the last one it saw (its cursor).
   Two phones changing the same contact: the newer Updated time wins. Rows typed straight into the tab get an ID,
   Created, Updated and Rev the next time any phone does a full sync. */
var CONTACTS_SHEET_ID = '1id_yHFGNqmjM1KZf-epryRAVmXHvEtsKnLN-ppf8pj8';
var CT_TAB = 'Contacts', CT_META = '_contacts_meta';
var CT_HEAD = ['ID', 'Name', 'Phones', 'Emails', 'Tags', 'Notes', 'Favourite', 'Created', 'Updated', 'Deleted', 'Rev'];
var CT = {}; CT_HEAD.forEach(function (h, i) { CT[h] = i; });

function ctBook() { return SpreadsheetApp.openById(CONTACTS_SHEET_ID); }
function ctSheets(book) {
  var sh = book.getSheetByName(CT_TAB);
  if (!sh) sh = book.insertSheet(CT_TAB);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, sh.getMaxRows(), CT_HEAD.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, CT_HEAD.length).setValues([CT_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var meta = book.getSheetByName(CT_META);
  if (!meta) {
    meta = book.insertSheet(CT_META);
    meta.getRange('A1:B2').setValues([['lastRev', 0], ['tagLibrary', '']]);
    meta.hideSheet();
  }
  return {sh: sh, meta: meta};
}
function contactsSync(c, user) {
  var b = ctSheets(ctBook()), sh = b.sh, meta = b.meta;
  var cursor = Number(c.cursor) || 0;
  var changes = Array.isArray(c.changes) ? c.changes.slice(0, 3000) : [];
  var rev = Number(meta.getRange('B1').getValue()) || 0;
  // Tag library: the tags people created (even ones on no contact yet) and their order. The newest copy wins.
  var tagLib = {list: [], updatedAt: 0};
  try { tagLib = JSON.parse(String(meta.getRange('B2').getValue() || '')) || tagLib; } catch (x) {}
  var inLib = c.tagLib;
  if (inLib && Array.isArray(inLib.list) && (Number(inLib.updatedAt) || 0) > (Number(tagLib.updatedAt) || 0)) {
    tagLib = {list: inLib.list.map(function (t) { return ctStr(t, 60); }).filter(String).slice(0, 300), updatedAt: Number(inLib.updatedAt)};
    meta.getRange('B2').setValue(JSON.stringify(tagLib));
  }
  // Nothing to send and nothing new since this phone's cursor: a tiny reply.
  if (!changes.length && cursor > 0 && cursor >= rev) return {ok: true, contacts: {cursor: rev, changes: [], tagLib: tagLib}, me: user};

  var width = CT_HEAD.length, last = sh.getLastRow();
  var values = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  var byId = {}, touched = {}, appended = [], rejected = {}, now = new Date().toISOString();
  values.forEach(function (row, i) { if (row[CT.ID]) byId[String(row[CT.ID])] = i; });
  // Rows typed straight into the tab (no ID yet) join in on a full sync.
  if (cursor === 0) values.forEach(function (row, i) {
    if (row[CT.ID]) return;
    var has = false; for (var k = 1; k <= CT.Notes; k++) if (String(row[k]).trim() !== '') { has = true; break; }
    if (!has) return;
    row[CT.ID] = Utilities.getUuid(); if (!row[CT.Created]) row[CT.Created] = now; row[CT.Updated] = now;
    if (String(row[CT.Deleted]).toUpperCase() !== 'TRUE') row[CT.Deleted] = 'FALSE';
    row[CT.Rev] = ++rev; byId[String(row[CT.ID])] = i; touched[i] = true;
  });
  changes.forEach(function (ch) {
    if (!ch || !ch.id) return;
    var id = String(ch.id).slice(0, 80), at = byId[id];
    if (at !== undefined) {
      if (ctTime(values[at][CT.Updated]) > (Number(ch.updatedAt) || 0)) { rejected[at] = true; return; } // the sheet has a newer copy
      values[at] = ctRow(ch, ++rev); touched[at] = true;
    } else {
      var row = ctRow(ch, ++rev);
      values.push(row); byId[id] = values.length - 1; appended.push(row);
    }
  });
  var nTouched = Object.keys(touched).length;
  if (nTouched > 40) {
    // Many changes (an import, Merge all): one write for the whole block is far faster than one per row.
    var block = values.slice(0, values.length - appended.length);
    if (block.length) sh.getRange(2, 1, block.length, width).setValues(block.map(function (r) { return r.map(ctSafe); }));
  } else {
    Object.keys(touched).forEach(function (k) { var i = Number(k); sh.getRange(i + 2, 1, 1, width).setValues([values[i].map(ctSafe)]); });
  }
  if (appended.length) sh.getRange(Math.max(last, 1) + 1, 1, appended.length, width).setValues(appended.map(function (r) { return r.map(ctSafe); }));
  if (rev !== (Number(meta.getRange('B1').getValue()) || 0)) meta.getRange('B1').setValue(rev);

  var out = [], seen = {};
  values.forEach(function (row, i) {
    if (!row[CT.ID] || seen[row[CT.ID]]) return;
    if ((Number(row[CT.Rev]) || 0) > cursor || rejected[i]) { out.push(ctFrom(row)); seen[row[CT.ID]] = true; }
  });
  return {ok: true, contacts: {cursor: rev, changes: out, tagLib: tagLib, full: cursor === 0}, me: user};
}
// One contact -> one row. Phones and emails are one per line as "Label: value"; tags are comma separated.
function ctRow(c, rev) {
  var lines = function (list, def) {
    return (Array.isArray(list) ? list : []).filter(function (x) { return x && String(x.value || '').trim(); }).slice(0, 20)
      .map(function (x) { return (ctStr(x.label, 40) || def) + ': ' + ctStr(x.value, 200); }).join('\n');
  };
  return [String(c.id).slice(0, 80), ctStr(c.name, 200), lines(c.phones, 'Mobile'), lines(c.emails, 'Personal'),
    (Array.isArray(c.tags) ? c.tags : []).map(function (t) { return ctStr(t, 60); }).filter(String).slice(0, 30).join(', '),
    ctStr(c.notes, 5000), c.fav ? 'TRUE' : 'FALSE',
    new Date(Number(c.createdAt) || Date.now()).toISOString(), new Date(Number(c.updatedAt) || Date.now()).toISOString(),
    c.deleted ? 'TRUE' : 'FALSE', rev]; // escaped once, when written (ctSafe)
}
function ctFrom(row) {
  var parse = function (text, def) {
    return String(text || '').split(/\n|\s\|\s/).map(function (s) { return s.trim(); }).filter(String).map(function (s) {
      var m = s.match(/^([^:]{1,40}):\s*(.+)$/);
      return m && !/^(https?|mailto|tel)$/i.test(m[1]) ? {label: m[1].trim(), value: m[2].trim()} : {label: def, value: s};
    });
  };
  var yes = function (v) { return v === true || /^(true|yes|1)$/i.test(String(v)); };
  return {id: String(row[CT.ID]), name: String(row[CT.Name] || ''), phones: parse(row[CT.Phones], 'Mobile'), emails: parse(row[CT.Emails], 'Personal'),
    tags: String(row[CT.Tags] || '').split(',').map(function (s) { return s.trim(); }).filter(String),
    notes: String(row[CT.Notes] || ''), fav: yes(row[CT.Favourite]),
    createdAt: ctTime(row[CT.Created]), updatedAt: ctTime(row[CT.Updated]), deleted: yes(row[CT.Deleted])};
}
function ctTime(v) { if (v instanceof Date) return v.getTime(); if (typeof v === 'number') return v; var t = Date.parse(String(v || '')); return isNaN(t) ? 0 : t; }
function ctStr(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
// Text that starts with = + - @ would be read as a formula; a leading apostrophe keeps it plain text.
function ctSafe(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }
/* Run once from the editor (optional) to check the contacts spreadsheet can be reached. */
function contactsSelfTest() {
  var b = ctSheets(ctBook());
  Logger.log('Contacts rows: ' + Math.max(0, b.sh.getLastRow() - 1) + ', last rev: ' + b.meta.getRange('B1').getValue());
}

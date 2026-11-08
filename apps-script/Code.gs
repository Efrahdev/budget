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
 * The app sends one POST per sync: {session, ops: [...]}. Each op is an
 * upsert or a delete, so sending the same op twice is harmless.
 * The reply is always the full, current data set.
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
  Notes: ['ID', 'Title', 'Type', 'Owner', 'Drive file ID', 'Updated at', 'Size', 'Preview']
};
var E = {id: 0, date: 1, cycle: 2, type: 3, catName: 4, amount: 5, acctName: 6, cardName: 7, note: 8, member: 9, tag: 10,
         refund: 11, cat: 12, acct: 13, card: 14, at: 15, saved: 16};
var CHUNK = 40000; // characters per Config cell
var APP_URL = 'https://arhaanbeta.github.io/budget-tracker/';
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
    if (req.emailLink) return out(sendLoginLink(ss, req.emailLink));
    var who = authorise(ss, req);
    if (!who.ok) return out(who);
    var ops = Array.isArray(req.ops) ? req.ops : [], vaultOps = [], noteErrors = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      if (op.t === 'signout') { if (req.session) PropertiesService.getScriptProperties().deleteProperty('sess:' + req.session); return out({ok: true, signedOut: true}); }
      if (op.t === 'adduser' || op.t === 'deluser') { userOp(ss, op, who.user); continue; }
      if (op.t === 'vput' || op.t === 'vdel') { vaultOps.push(op); continue; }
      if (op.t === 'nput' || op.t === 'ndel') { try { noteOp(ss, op, who.user); } catch (x) { noteErrors.push({id: (op.note || op).id, error: String(x && x.message || x)}); } continue; }
      applyOp(ss, op);
    }
    vaultApply(ss, vaultOps, who.user);
    if (ops.length) SpreadsheetApp.flush();
    var reply = {ok: true, applied: ops.length, data: readAll(ss), me: who.user, at: Date.now()};
    if (who.session) reply.session = who.session;
    if (who.user.role === 'Owner') reply.users = listUsers(ss);
    if (req.vault && who.user.role === 'Owner') reply.vault = readVault(ss);
    reply.notes = readNotes(ss, who.user);
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
    if (!raw) return {ok: false, error: 'signed_out'};
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
   Each person sees and changes only their own notes. Files sit in the owner's Drive, folder "Budget Tracker notes".
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
function noteOp(ss, op, user) {
  var sh = ss.getSheetByName('Notes'), r = rows(sh), me = noteOwner(user);
  var id = String((op.t === 'nput' ? (op.note || {}).id : op.id) || '');
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return;
  var at = -1;
  for (var i = 0; i < r.length; i++) if (String(r[i][0]) === id) { at = i; break; }
  if (at >= 0 && String(r[at][3]).toLowerCase() !== me) return; // someone else's note
  var oldFile = at >= 0 ? String(r[at][4] || '') : '';
  if (op.t === 'ndel') {
    if (oldFile) { try { DriveApp.getFileById(oldFile).setTrashed(true); } catch (e) {} }
    if (at >= 0) sh.deleteRow(at + 2);
    return;
  }
  var n = op.note, type = NOTE_TYPES[n.type] ? n.type : 'txt', content = String(n.content == null ? '' : n.content), title = String(n.title || '').slice(0, 200);
  var name = noteFileName(title, type), file = null;
  if (at >= 0 && String(r[at][2]) === type && oldFile) { try { file = DriveApp.getFileById(oldFile); if (file.isTrashed()) file = null; } catch (e) { file = null; } }
  if (file) { file.setContent(content); if (file.getName() !== name) file.setName(name); }
  else {
    file = notesFolder().createFile(name, content, NOTE_TYPES[type][1]);
    if (oldFile) { try { DriveApp.getFileById(oldFile).setTrashed(true); } catch (e) {} } // the type changed: new file, old one to the bin
  }
  var preview = content.replace(/<[^>]*>/g, ' ').replace(/```[^\n]*/g, ' ').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/\[( |x|X)\]\s+/g, '')
    .replace(/(\*\*|__|~~|`)/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  var row = [id, title, type, me, file.getId(), stamp(+n.updatedAt || Date.now()), content.length, preview];
  if (at >= 0) sh.getRange(at + 2, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
function readNotes(ss, user) {
  var me = noteOwner(user);
  return rows(ss.getSheetByName('Notes')).filter(function (r) { return r[0] && String(r[3]).toLowerCase() === me; }).map(function (r) {
    return {id: String(r[0]), title: txt(r[1]), type: NOTE_TYPES[r[2]] ? String(r[2]) : 'txt', fileId: txt(r[4]), updatedAt: Date.parse(txt(r[5])) || 0, size: +r[6] || 0, preview: txt(r[7])};
  });
}
function noteBodies(ss, ids, user) {
  var mine = {}, out = {};
  readNotes(ss, user).forEach(function (n) { mine[n.id] = n; });
  ids.slice(0, 20).forEach(function (id) { var n = mine[String(id)]; if (!n || !n.fileId) return;
    try { out[n.id] = DriveApp.getFileById(n.fileId).getBlob().getDataAsString('UTF-8'); } catch (e) {} });
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

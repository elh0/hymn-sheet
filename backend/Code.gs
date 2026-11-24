/*
 * Hymn Sheet backend: a plain pipe between the page and the Sheet.
 * Paste this whole file into the Sheet's Extensions > Apps Script editor
 * (replace everything), then Deploy > Manage deployments > New version.
 *
 * It only checks link keys and keeps each job's rows apart. All the app's
 * features and rules live in the page on GitHub (rules.js, app.js), so new
 * features never need this file changed.
 *
 * Ops (POST JSON, every op carries k = the person's link key):
 *   {a:'state'}
 *   {a:'add', tab, row, log}           appends a row to this job (id made here)
 *   {a:'set', tab, id, fields, log}    changes one row of this job
 *   {a:'del', tab, id, log}            removes one row of this job
 *   {a:'batch', ops:[...]}             several of the above, one lock
 * Special values: '@me' name, '@now' time, '@stamp' "Name · time",
 *   '@toggle' stamp or blank, '@toggle_now' time or blank.
 * Tab 'jobs' (admin only, this job), 'crew' (admin adds; crew may set only
 * their own row with id '@me'), 'log' and 'seen' are written only here.
 * Any other tab is created on first use, and new columns are added as needed.
 */

var VERSION = 'pipe-1';
var TZ = 'Europe/London';
var ONLINE_MS = 2 * 60 * 1000;
var BASE = {
  jobs:  ['job', 'title', 'dates', 'call', 'location', 'prep', 'deck', 'admin_key', 'notes', 'dp_notes'],
  crew:  ['job', 'key', 'name', 'role', 'dept', 'email', 'phone', 'kit_done', 'added'],
  log:   ['time', 'job', 'who', 'what'],
  seen:  ['job', 'key', 'name', 'first', 'last', 'opens']
};
var NO_WRITE = ['log', 'seen'];
var LOCKED_COLS = ['job', 'key', 'admin_key', 'id'];

/* ---------- entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return respond(handle(p));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return respond({ error: 'bad request' }); }
  return respond(handle(body));
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- sheet helpers ---------- */

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name, create) {
  var sh = ss().getSheetByName(name);
  if (!sh && create) {
    sh = ss().insertSheet(name);
    sh.appendRow(BASE[name] || ['id', 'job']);
  }
  return sh;
}

function tabNames() { return ss().getSheets().map(function (s) { return s.getName(); }); }

function headOf(sh) {
  if (sh.getLastColumn() === 0) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
}

function rows(name) {
  var sh = sheet(name);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (!values.length) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = { _row: r + 1 }, empty = true;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = values[r][c];
      if (v instanceof Date) v = fmt(v);
      v = v === null || v === undefined ? '' : String(v);
      if (v !== '') empty = false;
      o[head[c]] = v;
    }
    if (!empty) out.push(o);
  }
  return out;
}

// Adds any missing columns to the header and returns it.
function ensureCols(sh, keys) {
  var head = headOf(sh);
  keys.forEach(function (k) {
    if (head.indexOf(k) < 0 && /^[a-z][a-z0-9_]{0,30}$/.test(k)) {
      sh.getRange(1, head.length + 1).setValue(k);
      head.push(k);
    }
  });
  return head;
}

function append(name, obj) {
  var sh = sheet(name, true);
  var head = ensureCols(sh, Object.keys(obj));
  sh.appendRow(head.map(function (h) { return obj[h] === undefined ? '' : asText(obj[h]); }));
}

function setCells(name, rowNum, obj) {
  var sh = sheet(name);
  var head = ensureCols(sh, Object.keys(obj));
  Object.keys(obj).forEach(function (k) {
    var c = head.indexOf(k);
    if (c >= 0) sh.getRange(rowNum, c + 1).setValue(asText(obj[k]));
  });
}

function fmt(d) { return Utilities.formatDate(d || new Date(), TZ, 'd MMM HH:mm'); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function newKey() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function clean(s, n) { return String(s === undefined || s === null ? '' : s).trim().slice(0, n || 2000); }
// A leading apostrophe keeps "26 Nov" and "+44..." as text. Sheets hides it.
function asText(v) { return typeof v === 'string' && v !== '' ? "'" + v : v; }

/* ---------- who is this ---------- */

function whoIs(key) {
  key = String(key || '').trim();
  if (!key) return null;
  var jobs = rows('jobs');
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].admin_key && jobs[i].admin_key === key) return { job: jobs[i], name: 'Elliot', role: 'DP', admin: true, key: key };
  }
  var crew = rows('crew');
  for (var j = 0; j < crew.length; j++) {
    if (crew[j].key === key) {
      var job = jobs.filter(function (x) { return x.job === crew[j].job; })[0];
      if (!job) return null;
      return { job: job, name: crew[j].name, role: crew[j].role, admin: false, key: key, crewRow: crew[j] };
    }
  }
  return null;
}

/* ---------- presence (cache, so polling costs no sheet writes) ---------- */

function touch(me) {
  var cache = CacheService.getScriptCache();
  var ck = 'seen_' + me.job.job;
  var seen = {};
  try { seen = JSON.parse(cache.get(ck) || '{}'); } catch (e) { seen = {}; }
  var now = Date.now(), prev = seen[me.key];
  seen[me.key] = now;
  cache.put(ck, JSON.stringify(seen), 21600);
  if (!prev || now - prev > 10 * 60 * 1000) {
    var list = rows('seen').filter(function (s) { return s.job === me.job.job && s.key === me.key; });
    if (list.length) setCells('seen', list[0]._row, { last: fmt(), opens: (Number(list[0].opens) || 0) + 1 });
    else append('seen', { job: me.job.job, key: me.key, name: me.name, first: fmt(), last: fmt(), opens: 1 });
  }
  return seen;
}

/* ---------- state: every tab with a job column, this job's rows only ---------- */

function strip(r) { var o = {}; for (var k in r) if (k !== 'job' && k !== '_row') o[k] = r[k]; return o; }

function state(me, live) {
  var j = me.job.job;
  function mine(r) { return r.job === j; }
  var seenRows = rows('seen').filter(mine);
  var job = strip(me.job); job.job = j; delete job.admin_key;
  var out = {
    v: VERSION,
    me: { name: me.name, role: me.role, admin: me.admin },
    job: job,
    crew: rows('crew').filter(mine).map(function (c) {
      var s = seenRows.filter(function (x) { return x.key === c.key; })[0] || {};
      var t = live[c.key];
      var o = strip(c); delete o.key;
      o.first = s.first || ''; o.last = t ? fmt(new Date(t)) : (s.last || '');
      o.online = !!(t && Date.now() - t < ONLINE_MS); o.opens = s.opens || '';
      if (me.admin) o.key = c.key;
      return o;
    }),
    elliotOnline: !!(live[me.job.admin_key] && Date.now() - live[me.job.admin_key] < ONLINE_MS),
    now: fmt()
  };
  tabNames().forEach(function (name) {
    if (name === 'jobs' || name === 'crew' || name === 'seen' || out[name] !== undefined) return;
    if (headOf(sheet(name)).indexOf('job') < 0) return;
    var list = rows(name).filter(mine).map(strip);
    out[name] = name === 'log' ? list.slice(-80).reverse() : list;
  });
  ['items', 'tasks', 'shots', 'flags', 'log'].forEach(function (n) { if (!out[n]) out[n] = []; });
  return out;
}

/* ---------- ops ---------- */

function handle(p) {
  var me = whoIs(p.k);
  if (!me) return { error: 'This link isn\'t on any job. Ask Elliot for your link.' };
  var a = p.a || 'state';
  if (a === 'state') return state(me, touch(me));

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ops = a === 'batch' ? (p.ops || []).slice(0, 50) : [p];
    for (var i = 0; i < ops.length; i++) {
      var res = run(ops[i], me);
      if (res && res.error) return res;
    }
  } finally {
    lock.releaseLock();
  }
  me = whoIs(p.k) || me;
  return state(me, touch(me));
}

function value(v, me, current) {
  var stamp = me.name + ' · ' + fmt();
  if (v === '@me') return me.name;
  if (v === '@now') return fmt();
  if (v === '@stamp') return stamp;
  if (v === '@toggle') return current ? '' : stamp;
  if (v === '@toggle_now') return current ? '' : fmt();
  return clean(v, 20000);
}

function run(op, me) {
  var j = me.job.job, tab = clean(op.tab, 31), a = op.a;
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(tab)) return { error: 'Unknown list.' };
  if (NO_WRITE.indexOf(tab) >= 0) return { error: 'That list is read-only.' };
  var said = clean(op.log, 400);

  if (tab === 'jobs') {
    if (!me.admin) return { error: 'Only Elliot edits the job.' };
    if (a !== 'set') return { error: 'Jobs are added in the Sheet.' };
    var jr = rows('jobs').filter(function (x) { return x.job === j; })[0];
    var jch = fields(op.fields, me, jr);
    if (Object.keys(jch).length) setCells('jobs', jr._row, jch); else said = '';
  } else if (tab === 'crew') {
    if (a === 'add') {
      if (!me.admin) return { error: 'Only Elliot adds crew.' };
      var c = fields(op.row, me, {});
      if (!c.name) return { error: 'Name needed.' };
      c.job = j; c.key = newKey(); if (!c.added) c.added = fmt();
      append('crew', c);
    } else if (a === 'set') {
      var cr = rows('crew').filter(function (x) {
        return x.job === j && (op.id === '@me' ? x.key === me.key : (me.admin && x.key === op.id));
      })[0];
      if (!cr) return { error: 'Only Elliot changes other people\'s details.' };
      var cch = fields(op.fields, me, cr);
      if (Object.keys(cch).length) setCells('crew', cr._row, cch); else said = '';
    } else return { error: 'Only Elliot removes crew, in the Sheet.' };
  } else {
    if (a === 'add') {
      var row = fields(op.row, me, {});
      row.id = newId(); row.job = j;
      append(tab, row);
    } else {
      var hit = rows(tab).filter(function (r) { return r.id && r.id === op.id && r.job === j; })[0];
      if (!hit) return { error: 'That has gone. Pull to refresh.' };
      if (a === 'set') {
        var ch = fields(op.fields, me, hit);
        if (Object.keys(ch).length) setCells(tab, hit._row, ch); else said = '';
      } else if (a === 'del') {
        sheet(tab).deleteRow(hit._row);
      } else return { error: 'Unknown action.' };
    }
  }
  if (said) append('log', { time: fmt(), job: j, who: me.name, what: said });
  return null;
}

// Cleans incoming fields; never touches job, key, admin_key or id.
function fields(obj, me, current) {
  var out = {};
  Object.keys(obj || {}).slice(0, 40).forEach(function (f) {
    if (LOCKED_COLS.indexOf(f) >= 0 || !/^[a-z][a-z0-9_]{0,30}$/.test(f)) return;
    var v = value(obj[f], me, current[f]);
    if (current[f] !== undefined && v === current[f]) return;
    out[f] = v;
  });
  return out;
}

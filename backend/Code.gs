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
 *
 * People (pipe-2): one link per person for good. Tab 'people' (key, name,
 * email, admin). A crew row's 'person' column holds that person's key, so one
 * key opens every job they're on; 'admin' = yes opens every job as Elliot.
 * Pass job = the job to open (else the soonest by jobs.start, YYYY-MM-DD).
 * Only admins see or write 'people'. Old per-job keys keep working.
 */

var VERSION = 'pipe-2';
var TZ = 'Europe/London';
var ONLINE_MS = 2 * 60 * 1000;
var BASE = {
  jobs:  ['job', 'title', 'dates', 'call', 'location', 'prep', 'deck', 'admin_key', 'notes', 'dp_notes'],
  crew:  ['job', 'key', 'name', 'role', 'dept', 'email', 'phone', 'kit_done', 'added'],
  log:   ['time', 'job', 'who', 'what'],
  seen:  ['job', 'key', 'name', 'first', 'last', 'opens'],
  people: ['key', 'name', 'email', 'admin']
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
function slug(s) { return String(s || 'crew').toLowerCase().split(' ')[0].replace(/[^a-z0-9]/g, '').slice(0, 20) || 'crew'; }
function clean(s, n) { return String(s === undefined || s === null ? '' : s).trim().slice(0, n || 2000); }
// A leading apostrophe keeps "26 Nov" and "+44..." as text. Sheets hides it.
function asText(v) { return typeof v === 'string' && v !== '' ? "'" + v : v; }

/* ---------- who is this ---------- */

function whoIs(key, want) {
  key = String(key || '').trim();
  if (!key) return null;
  var jobs = rows('jobs');
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].admin_key && jobs[i].admin_key === key) return withJobs({ job: jobs[i], name: 'Elliot', role: 'DP', admin: true, key: key }, [jobs[i]]);
  }
  var crew = rows('crew');
  for (var j = 0; j < crew.length; j++) {
    if (crew[j].key === key) {
      var job = jobs.filter(function (x) { return x.job === crew[j].job; })[0];
      if (!job) return null;
      return withJobs({ job: job, name: crew[j].name, role: crew[j].role, admin: false, key: key, crewRow: crew[j] }, [job]);
    }
  }
  var person = rows('people').filter(function (x) { return x.key && x.key === key; })[0];
  if (!person) return null;
  var admin = /^(yes|y|true|1)$/i.test(person.admin || '');
  var mine = admin ? jobs : jobs.filter(function (jb) {
    return crew.some(function (c) { return c.job === jb.job && c.person === key; });
  });
  if (!mine.length) return null;
  var pick = mine.filter(function (jb) { return jb.job === want; })[0] || soonest(mine);
  if (admin) return withJobs({ job: pick, name: person.name || 'Elliot', role: 'DP', admin: true, key: pick.admin_key, person: key }, mine);
  var cr = crew.filter(function (c) { return c.job === pick.job && c.person === key; })[0];
  return withJobs({ job: pick, name: cr.name, role: cr.role, admin: false, key: cr.key, crewRow: cr, person: key }, mine);
}

function withJobs(me, list) {
  me.jobs = list.map(function (jb) { return { job: jb.job, title: jb.title, dates: jb.dates, start: jb.start || '' }; });
  return me;
}

// The next job to come (by jobs.start, YYYY-MM-DD), else the latest one.
function soonest(list) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var dated = list.filter(function (jb) { return /^\d{4}-\d\d-\d\d/.test(jb.start || ''); })
    .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  var next = dated.filter(function (jb) { return jb.start >= today; })[0];
  return next || dated[dated.length - 1] || list[list.length - 1];
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
      if (me.admin) o.key = c.key; else delete o.person;
      return o;
    }),
    jobs: me.jobs || [],
    elliotOnline: !!(live[me.job.admin_key] && Date.now() - live[me.job.admin_key] < ONLINE_MS),
    now: fmt()
  };
  tabNames().forEach(function (name) {
    if (name === 'jobs' || name === 'crew' || name === 'seen' || name === 'people' || out[name] !== undefined) return;
    if (headOf(sheet(name)).indexOf('job') < 0) return;
    var list = rows(name).filter(mine).map(strip);
    out[name] = name === 'log' ? list.slice(-80).reverse() : list;
  });
  if (me.admin) out.people = rows('people').map(function (r) { var o = strip(r); return o; });
  ['items', 'tasks', 'shots', 'flags', 'log'].forEach(function (n) { if (!out[n]) out[n] = []; });
  return out;
}

/* ---------- ops ---------- */

function handle(p) {
  var me = whoIs(p.k, p.job);
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
  me = whoIs(p.k, p.job) || me;
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

  if (tab === 'people') {
    if (!me.admin) return { error: 'Only Elliot manages links.' };
    var ppl = rows('people');
    if (a === 'add') {
      var pr = fields(op.row, me, {});
      var pk = clean(op.row && op.row.key, 40);
      if (!/^[a-z0-9]+-[a-z0-9]{8}$/.test(pk) || ppl.some(function (x) { return x.key === pk; })) pk = slug(pr.name) + '-' + newKey().slice(0, 8);
      pr.key = pk; delete pr.admin;
      append('people', pr);
    } else if (a === 'set') {
      var hp = ppl.filter(function (x) { return x.key === op.id; })[0];
      if (!hp) return { error: 'No such person.' };
      var pch = fields(op.fields, me, hp); delete pch.admin;
      if (Object.keys(pch).length) setCells('people', hp._row, pch); else said = '';
    } else return { error: 'People are removed in the Sheet.' };
    if (said) append('log', { time: fmt(), job: j, who: me.name, what: said });
    return null;
  }

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
      if (!me.admin) delete cch.person;
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

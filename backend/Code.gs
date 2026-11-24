/*
 * Hymn Sheet backend. Paste this whole file into the Google Sheet's
 * Extensions > Apps Script editor (replace everything), then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 *
 * The Sheet holds all the data. The page on GitHub Pages only ever talks
 * to this script, and only with a personal link key.
 */

var TABS = {
  jobs:  ['job', 'title', 'dates', 'call', 'location', 'prep', 'deck', 'admin_key', 'notes', 'dp_notes'],
  crew:  ['job', 'key', 'name', 'role', 'dept', 'email', 'phone', 'kit_done', 'added'],
  items: ['id', 'job', 'dept', 'item', 'qty', 'supplier', 'asked_by', 'owner', 'confirmed', 'packed', 'notes', 'source', 'updated'],
  tasks: ['id', 'job', 'who', 'task', 'due', 'done', 'updated'],
  shots: ['job', 'no', 'shot', 'notes'],
  flags: ['id', 'job', 'text', 'status', 'source', 'raised_by', 'time'],
  log:   ['time', 'job', 'who', 'what'],
  seen:  ['job', 'key', 'name', 'first', 'last', 'opens']
};

var TZ = 'Europe/London';
var ONLINE_MS = 2 * 60 * 1000;

/* ---------- entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return respond(handle(p.a || 'state', p));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return respond({ error: 'bad request' }); }
  return respond(handle(body.a || 'state', body));
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor (select setup, press Run) to create the tabs. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(TABS[name]);
  });
}

/* ---------- sheet helpers ---------- */

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(TABS[name]); }
  return sh;
}

function rows(name) {
  var values = sheet(name).getDataRange().getValues();
  if (!values.length) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = { _row: r + 1 };
    var empty = true;
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

function headOf(name) {
  return sheet(name).getRange(1, 1, 1, sheet(name).getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

function append(name, obj) {
  var head = headOf(name);
  sheet(name).appendRow(head.map(function (h) { return obj[h] === undefined ? '' : asText(obj[h]); }));
}

function setCells(name, rowNum, obj) {
  var head = headOf(name);
  var sh = sheet(name);
  Object.keys(obj).forEach(function (k) {
    var c = head.indexOf(k);
    if (c >= 0) sh.getRange(rowNum, c + 1).setValue(asText(obj[k]));
  });
}

function deleteRow(name, rowNum) { sheet(name).deleteRow(rowNum); }

function fmt(d) { return Utilities.formatDate(d || new Date(), TZ, 'd MMM HH:mm'); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function newKey() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function clean(s, n) { return String(s === undefined || s === null ? '' : s).trim().slice(0, n || 300); }
// Store text as text: a leading apostrophe stops Sheets turning "26 Nov" into a date
// or "=..." into a formula. Sheets hides the apostrophe.
function asText(v) { return typeof v === 'string' && v !== '' ? "'" + v : v; }

/* ---------- who is this ---------- */

function whoIs(key) {
  key = String(key || '').trim();
  if (!key) return null;
  var jobs = rows('jobs');
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].admin_key && jobs[i].admin_key === key) {
      return { job: jobs[i], name: 'Elliot', role: 'DP', admin: true, key: key };
    }
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
  var now = Date.now();
  var prev = seen[me.key];
  seen[me.key] = now;
  cache.put(ck, JSON.stringify(seen), 21600);
  // Write to the sheet only on a fresh visit (nothing in the last 10 minutes).
  if (!prev || now - prev > 10 * 60 * 1000) {
    var list = rows('seen').filter(function (s) { return s.job === me.job.job && s.key === me.key; });
    if (list.length) setCells('seen', list[0]._row, { last: fmt(), opens: (Number(list[0].opens) || 0) + 1 });
    else append('seen', { job: me.job.job, key: me.key, name: me.name, first: fmt(), last: fmt(), opens: 1 });
  }
  return seen;
}

/* ---------- state ---------- */

function state(me, live) {
  var j = me.job.job;
  function mine(r) { return r.job === j; }
  var crew = rows('crew').filter(mine);
  var seenRows = rows('seen').filter(mine);
  var out = {
    me: { name: me.name, role: me.role, admin: me.admin },
    job: {
      job: j, title: me.job.title, dates: me.job.dates, call: me.job.call,
      location: me.job.location, prep: me.job.prep, deck: me.job.deck, notes: me.job.notes, dp_notes: me.job.dp_notes || ''
    },
    crew: crew.map(function (c) {
      var s = seenRows.filter(function (x) { return x.key === c.key; })[0] || {};
      var t = live[c.key];
      var o = {
        name: c.name, role: c.role, dept: c.dept, email: c.email, phone: c.phone,
        kit_done: c.kit_done, first: s.first || '', last: t ? fmt(new Date(t)) : (s.last || ''),
        online: !!(t && Date.now() - t < ONLINE_MS), opens: s.opens || ''
      };
      if (me.admin) o.key = c.key;
      return o;
    }),
    items: rows('items').filter(mine).map(strip),
    tasks: rows('tasks').filter(mine).map(strip),
    shots: rows('shots').filter(mine).map(strip),
    flags: rows('flags').filter(mine).map(strip),
    log: rows('log').filter(mine).map(strip).slice(-80).reverse(),
    elliotOnline: !!(live[me.job.admin_key] && Date.now() - live[me.job.admin_key] < ONLINE_MS),
    now: fmt()
  };
  return out;
}

function strip(r) { var o = {}; for (var k in r) if (k !== 'job') o[k] = r[k]; return o; }

/* ---------- actions ---------- */

function handle(a, p) {
  var me = whoIs(p.k);
  if (!me) return { error: 'This link isn\'t on any job. Ask Elliot for your link.' };

  if (a === 'state') return state(me, touch(me));

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var msg = act(a, p, me);
    if (msg && msg.error) return msg;
    if (msg) append('log', { time: fmt(), job: me.job.job, who: me.name, what: clean(msg, 400) });
  } finally {
    lock.releaseLock();
  }
  me = whoIs(p.k) || me;
  return state(me, touch(me));
}

function findBy(name, id, job) {
  return rows(name).filter(function (r) { return r.id === id && r.job === job; })[0];
}

var CREW_ITEM_FIELDS = ['qty', 'supplier', 'owner', 'notes'];
var ADMIN_ITEM_FIELDS = ['dept', 'item', 'qty', 'supplier', 'owner', 'notes', 'asked_by'];

function act(a, p, me) {
  var j = me.job.job;
  var stamp = me.name + ' · ' + fmt();

  if (a === 'add_item') {
    if (!clean(p.item)) return { error: 'Say what the item is.' };
    var item = {
      id: newId(), job: j, dept: clean(p.dept, 40) || 'Camera', item: clean(p.item, 200),
      qty: clean(p.qty, 20), supplier: clean(p.supplier, 60) || 'TBC',
      asked_by: me.name, owner: clean(p.owner, 60) || me.name,
      confirmed: me.admin && p.confirm ? stamp : '', packed: '', notes: clean(p.notes, 300),
      source: 'app', updated: fmt()
    };
    append('items', item);
    return 'added ' + item.item + ' (' + item.dept + ', ' + item.supplier + ')';
  }

  if (a === 'set_item') {
    var it = findBy('items', p.id, j);
    if (!it) return { error: 'That item has gone. Pull to refresh.' };
    var allowed = me.admin ? ADMIN_ITEM_FIELDS : CREW_ITEM_FIELDS;
    var ch = {}, said = [];
    Object.keys(p.fields || {}).forEach(function (f) {
      if (allowed.indexOf(f) < 0) return;
      var v = clean(p.fields[f], 300);
      if (v === it[f]) return;
      ch[f] = v; said.push(f + ' "' + (it[f] || '-') + '" → "' + (v || '-') + '"');
    });
    if (!said.length) return null;
    ch.updated = fmt();
    // A crew change to supplier or qty needs Elliot to confirm again.
    if (!me.admin && (ch.supplier !== undefined || ch.qty !== undefined) && it.confirmed) ch.confirmed = '';
    setCells('items', it._row, ch);
    return 'changed ' + it.item + ': ' + said.join(', ');
  }

  if (a === 'tick_item') {
    var ti = findBy('items', p.id, j);
    if (!ti) return { error: 'That item has gone. Pull to refresh.' };
    var field = p.field === 'confirmed' ? 'confirmed' : 'packed';
    if (field === 'confirmed' && !me.admin) return { error: 'Only Elliot confirms items.' };
    var on = !ti[field];
    var o = {}; o[field] = on ? stamp : ''; o.updated = fmt();
    setCells('items', ti._row, o);
    return (on ? '' : 'un') + (field === 'packed' ? 'packed ' : 'confirmed ') + ti.item;
  }

  if (a === 'delete_item') {
    var di = findBy('items', p.id, j);
    if (!di) return null;
    if (!me.admin && !(same(di.asked_by, me.name) && !di.confirmed)) return { error: 'Only Elliot can remove confirmed kit.' };
    deleteRow('items', di._row);
    return 'removed ' + di.item;
  }

  if (a === 'add_task') {
    if (!clean(p.task)) return { error: 'Say what the task is.' };
    var who = me.admin ? clean(p.who, 60) || me.name : me.name;
    append('tasks', { id: newId(), job: j, who: who, task: clean(p.task, 200), due: clean(p.due, 40), done: '', updated: fmt() });
    return 'task for ' + who + ': ' + clean(p.task, 200);
  }

  if (a === 'tick_task') {
    var t = findBy('tasks', p.id, j);
    if (!t) return { error: 'That task has gone. Pull to refresh.' };
    if (!me.admin && !same(t.who, me.name) && !same(t.who, 'everyone')) return { error: 'That one is ' + t.who + '\'s.' };
    var done = !t.done;
    setCells('tasks', t._row, { done: done ? stamp : '', updated: fmt() });
    return (done ? 'done: ' : 'reopened: ') + t.task;
  }

  if (a === 'delete_task') {
    if (!me.admin) return { error: 'Only Elliot removes tasks.' };
    var dt = findBy('tasks', p.id, j);
    if (!dt) return null;
    deleteRow('tasks', dt._row);
    return 'removed task: ' + dt.task;
  }

  if (a === 'kit_done') {
    if (me.admin) return null;
    var cr = rows('crew').filter(function (c) { return c.key === me.key; })[0];
    var kd = !cr.kit_done;
    setCells('crew', cr._row, { kit_done: kd ? fmt() : '' });
    return kd ? 'my kit is all on the sheet' : 'still adding kit';
  }

  if (a === 'raise_flag') {
    if (!clean(p.text)) return { error: 'Say what the problem is.' };
    append('flags', { id: newId(), job: j, text: clean(p.text, 300), status: 'open', source: 'app', raised_by: me.name, time: fmt() });
    return 'flagged: ' + clean(p.text, 300);
  }

  if (a === 'resolve_flag') {
    if (!me.admin) return { error: 'Only Elliot clears flags.' };
    var fl = findBy('flags', p.id, j);
    if (!fl) return null;
    var open = fl.status === 'sorted';
    setCells('flags', fl._row, { status: open ? 'open' : 'sorted' });
    return (open ? 'reopened: ' : 'sorted: ') + fl.text;
  }

  if (a === 'add_crew') {
    if (!me.admin) return { error: 'Only Elliot adds crew.' };
    if (!clean(p.name)) return { error: 'Name needed.' };
    append('crew', {
      job: j, key: newKey(), name: clean(p.name, 60), role: clean(p.role, 60), dept: clean(p.dept, 40),
      email: clean(p.email, 120), phone: clean(p.phone, 40), kit_done: '', added: fmt()
    });
    return 'added ' + clean(p.name, 60) + ' (' + clean(p.role, 60) + ')';
  }

  if (a === 'set_job') {
    if (!me.admin) return { error: 'Only Elliot edits the job.' };
    var jr = rows('jobs').filter(function (x) { return x.job === j; })[0];
    var jch = {}, js = [];
    ['title', 'dates', 'call', 'location', 'prep', 'deck', 'notes', 'dp_notes'].forEach(function (f) {
      var max = f === 'dp_notes' ? 20000 : 400;
      if (p.fields && p.fields[f] !== undefined && clean(p.fields[f], max) !== (jr[f] || '')) {
        jch[f] = clean(p.fields[f], max);
        js.push(f === 'dp_notes' ? 'DP notes updated' : f + ' → "' + jch[f] + '"');
      }
    });
    if (!js.length) return null;
    setCells('jobs', jr._row, jch);
    return 'job ' + js.join(', ');
  }

  return { error: 'Unknown action.' };
}

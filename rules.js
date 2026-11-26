/* Hymn Sheet rules: turns what someone did on the page into a plain Sheet op
 * for the backend pipe (backend/Code.gs). New features and rule changes go
 * here, so the Apps Script never needs pasting again.
 * translate(op, S) returns a backend op, null (nothing changed) or {error}. */
(function (root) {
  'use strict';

  var CREW_ITEM_FIELDS = ['qty', 'supplier', 'owner', 'notes'];
  var ADMIN_ITEM_FIELDS = ['dept', 'item', 'qty', 'supplier', 'owner', 'notes', 'asked_by'];
  var JOB_FIELDS = ['title', 'dates', 'start', 'call', 'location', 'prep', 'deck', 'notes', 'dp_notes', 'needs'];

  // Forever links: crew.elliot.onl/milo-k7f3x2a9 (first name + 8 random letters/digits).
  function personKey(name) {
    var abc = 'abcdefghijkmnpqrstuvwxyz23456789', out = '', r = [];
    try { var a = new Uint8Array(8); (root.crypto || require('crypto').webcrypto).getRandomValues(a); r = Array.prototype.slice.call(a); }
    catch (e) { for (var i = 0; i < 8; i++) r.push(Math.floor(Math.random() * 256)); }
    r.forEach(function (n) { out += abc.charAt(n % abc.length); });
    var first = String(name || 'crew').toLowerCase().split(' ')[0].replace(/[^a-z0-9]/g, '').slice(0, 20) || 'crew';
    return first + '-' + out;
  }
  // The same person on another job: same email, or same full name.
  function findPerson(S, name, email) {
    return (S.people || []).filter(function (p) {
      return (email && p.email && same(p.email, email)) || (name && p.name && same(p.name, name));
    })[0];
  }

  function isProd(me) { return /production|producer|coordinator|\bpm\b/i.test((me && me.role) || ''); }
  function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  function clean(s, n) { return String(s === undefined || s === null ? '' : s).trim().slice(0, n || 300); }
  function deptFor(role) {
    var r = String(role || '');
    if (/grip/i.test(r)) return 'Grip';
    if (/gaffer|spark|electric|lighting/i.test(r)) return 'Lighting';
    if (/\bdit\b|data/i.test(r)) return 'DIT';
    if (/1st ac|focus/i.test(r)) return 'Focus';
    if (/ac\b|camera|steadicam|operator|clapper|loader/i.test(r)) return 'Camera';
    if (/playback|vtr|video/i.test(r)) return 'Video';
    return 'Other';
  }
  function find(list, id) { return (list || []).filter(function (x) { return x.id === id; })[0]; }

  function translate(op, S) {
    var me = (S && S.me) || {};
    var admin = !!me.admin;
    var a = op.a;

    if (a === 'add_item') {
      if (!clean(op.item)) return { error: 'Say what the item is.' };
      var dept = clean(op.dept, 40) || 'Camera', sup = clean(op.supplier, 60) || 'TBC';
      return { a: 'add', tab: 'items', log: 'added ' + clean(op.item, 200) + ' (' + dept + ', ' + sup + ')', row: {
        dept: dept, item: clean(op.item, 200), qty: clean(op.qty, 20), supplier: sup,
        asked_by: '@me', owner: clean(op.owner, 60) || '@me', confirmed: admin && op.confirm ? '@stamp' : '',
        packed: '', notes: clean(op.notes, 300), source: 'app', updated: '@now' } };
    }

    if (a === 'set_item') {
      var it = find(S.items, op.id);
      if (!it) return { error: 'That item has gone. Pull to refresh.' };
      var allowed = admin ? ADMIN_ITEM_FIELDS : CREW_ITEM_FIELDS;
      var ch = {}, said = [];
      Object.keys(op.fields || {}).forEach(function (f) {
        if (allowed.indexOf(f) < 0) return;
        var v = clean(op.fields[f], 300);
        if (v === (it[f] || '')) return;
        ch[f] = v; said.push(f + ' "' + (it[f] || '-') + '" → "' + (v || '-') + '"');
      });
      if (!said.length) return null;
      // A crew change to supplier or qty needs confirming again.
      if (!admin && (ch.supplier !== undefined || ch.qty !== undefined) && it.confirmed) ch.confirmed = '';
      ch.updated = '@now';
      return { a: 'set', tab: 'items', id: it.id, fields: ch, log: 'changed ' + it.item + ': ' + said.join(', ') };
    }

    if (a === 'tick_item') {
      var ti = find(S.items, op.id);
      if (!ti) return { error: 'That item has gone. Pull to refresh.' };
      var field = op.field === 'confirmed' ? 'confirmed' : 'packed';
      var tf = { updated: '@now' }; tf[field] = '@toggle';
      var tn = clean(op.note, 300);
      if (tn) tf.notes = (ti.notes ? ti.notes + ' · ' : '') + tn;
      return { a: 'set', tab: 'items', id: ti.id, fields: tf, log: (ti[field] ? 'un' : '') + field + ' ' + ti.item + (tn ? ': ' + tn : '') };
    }

    if (a === 'add_note') {
      var nr = op.kind === 'task' ? find(S.tasks, op.id) : find(S.items, op.id), nt = clean(op.note, 300);
      if (!nr || !nt) return null;
      return { a: 'set', tab: op.kind === 'task' ? 'tasks' : 'items', id: nr.id, fields: { notes: (nr.notes ? nr.notes + ' · ' : '') + nt, updated: '@now' },
        log: 'note on ' + (nr.task || nr.item) + ': ' + nt };
    }

    if (a === 'delete_item') {
      var di = find(S.items, op.id);
      if (!di) return null;
      if (!admin && !(same(di.asked_by, me.name) && !di.confirmed)) return { error: 'Only Elliot can remove confirmed kit.' };
      return { a: 'del', tab: 'items', id: di.id, log: 'removed ' + di.item };
    }

    if (a === 'add_task') {
      if (!clean(op.task)) return { error: 'Say what the task is.' };
      var who = clean(op.who, 60) || me.name;
      return { a: 'add', tab: 'tasks', log: 'task for ' + who + ': ' + clean(op.task, 200),
        row: { who: who, task: clean(op.task, 200), due: clean(op.due, 40), done: '', updated: '@now' } };
    }

    if (a === 'tick_task') {
      var t = find(S.tasks, op.id);
      if (!t) return { error: 'That task has gone. Pull to refresh.' };
      var dn = clean(op.note, 300), df = { done: '@toggle', updated: '@now' };
      if (dn) df.notes = (t.notes ? t.notes + ' · ' : '') + dn;
      return { a: 'set', tab: 'tasks', id: t.id, fields: df,
        log: (t.done ? 'reopened: ' : 'done: ') + t.task + (same(t.who, me.name) ? '' : ' (' + t.who + '\'s)') + (dn ? ': ' + dn : '') };
    }

    if (a === 'delete_task') {
      if (!admin) return { error: 'Only Elliot removes tasks.' };
      var dt = find(S.tasks, op.id);
      if (!dt) return null;
      return { a: 'del', tab: 'tasks', id: dt.id, log: 'removed task: ' + dt.task };
    }

    if (a === 'kit_done') {
      if (admin) return null;
      var c = (S.crew || []).filter(function (x) { return same(x.name, me.name); })[0] || {};
      return { a: 'set', tab: 'crew', id: '@me', fields: { kit_done: '@toggle_now' },
        log: c.kit_done ? 'still adding kit' : 'my kit is all on the sheet' };
    }

    if (a === 'raise_flag') {
      if (!clean(op.text)) return { error: 'Say what the problem is.' };
      return { a: 'add', tab: 'flags', log: 'flagged: ' + clean(op.text, 300),
        row: { text: clean(op.text, 300), status: 'open', source: 'app', raised_by: '@me', time: '@now' } };
    }

    if (a === 'resolve_flag') {
      if (!admin) return { error: 'Only Elliot clears flags.' };
      var fl = find(S.flags, op.id);
      if (!fl) return null;
      var reopen = fl.status === 'sorted';
      return { a: 'set', tab: 'flags', id: fl.id, fields: { status: reopen ? 'open' : 'sorted' }, log: (reopen ? 'reopened: ' : 'sorted: ') + fl.text };
    }

    // Questions inside the app: anyone asks anyone, the person asked (or Elliot) answers.
    if (a === 'ask') {
      var q = clean(op.text, 500), to = clean(op.to, 60) || 'Elliot';
      if (!q) return { error: 'Type the question.' };
      if (same(to, me.name)) return { error: 'Pick someone else to ask.' };
      var about = clean(op.about, 200);
      return { a: 'add', tab: 'asks', log: 'asked ' + to + (about ? ' about ' + about : '') + ': ' + q,
        row: { to: to, from: '@me', about: about, text: q, answer: '', answered_by: '', asked: '@now', answered: '' } };
    }

    if (a === 'answer') {
      var qa = find(S.asks, op.id), ans = clean(op.text, 500);
      if (!qa) return { error: 'That question has gone. Pull to refresh.' };
      if (!ans) return { error: 'Type your answer.' };
      if (!admin && !same(qa.to, me.name) && !same(qa.to, 'Everyone')) return { error: 'That one\'s for ' + qa.to + '.' };
      return { a: 'set', tab: 'asks', id: qa.id, fields: { answer: ans, answered_by: '@me', answered: '@now' },
        log: 'answered ' + qa.from + ': ' + ans };
    }

    if (a === 'delete_ask') {
      var qd = find(S.asks, op.id);
      if (!qd) return null;
      if (!admin && !same(qd.from, me.name)) return { error: 'Only whoever asked can remove it.' };
      return { a: 'del', tab: 'asks', id: qd.id, log: 'removed question: ' + qd.text };
    }

    // Kit lists move through five steps; each step belongs to someone (Elliot can do any).
    if (a === 'chain_step') {
      var ch = find(S.chain, op.id), step = clean(op.step, 20);
      if (!ch) return { error: 'That list has gone. Pull to refresh.' };
      var STEP = { listed: ch.lister, ok: 'Elliot', confirmed: '@booker', prepped: ch.preps, onset: ch.preps };
      if (!(step in STEP)) return { error: 'Unknown step.' };
      var owner = STEP[step];
      var mayDo = admin || (owner === '@booker' ? isProd(me) : same(owner, me.name));
      if (!mayDo) return { error: 'That step is ' + (owner === '@booker' ? 'production\'s' : owner + '\'s') + '.' };
      var NAMES = { listed: 'listed', ok: 'OK\'d by Elliot', confirmed: 'confirmed', prepped: 'prepped', onset: 'on set' };
      var sf = {}; sf[step] = '@toggle';
      return { a: 'set', tab: 'chain', id: ch.id, fields: sf, log: (ch[step] ? 'undid: ' : '') + ch.list + ' kit ' + NAMES[step] };
    }
    if (a === 'add_chain') {
      if (!admin) return { error: 'Only Elliot adds kit lists.' };
      var ln = clean(op.list, 40);
      if (!ln) return { error: 'Which list?' };
      return { a: 'add', tab: 'chain', log: 'new kit list: ' + ln,
        row: { list: ln, lister: clean(op.lister, 60), preps: clean(op.preps, 60), due: clean(op.due, 40), listed: '', ok: '', confirmed: '', prepped: '', onset: '' } };
    }

    // Job chat: everyone on the job can post; whoever posted (or Elliot) can remove it. Not logged, it's chat.
    if (a === 'say') {
      var said = clean(op.text, 1000);
      if (!said) return { error: 'Type a message.' };
      return { a: 'add', tab: 'chat', row: { who: '@me', text: said, time: '@now' } };
    }
    if (a === 'unsay') {
      var cm = find(S.chat || [], op.id);
      if (!cm) return null;
      if (!admin && !same(cm.who, me.name)) return { error: 'Only whoever wrote it can remove it.' };
      return { a: 'del', tab: 'chat', id: cm.id };
    }

    if (a === 'add_crew') {
      if (!admin) return { error: 'Only Elliot adds crew.' };
      if (!clean(op.name)) return { error: 'Name needed.' };
      var row = { name: clean(op.name, 60), role: clean(op.role, 60), dept: clean(op.dept, 40),
        email: clean(op.email, 120), phone: clean(op.phone, 40), kit_done: '', added: '@now' };
      var said = 'added ' + row.name + ' (' + row.role + ')';
      if (S.v === 'pipe-1') return { a: 'add', tab: 'crew', row: row, log: said };   // script not updated yet
      var known = findPerson(S, row.name, row.email);
      if (known) { row.person = known.key; return { a: 'add', tab: 'crew', row: row, log: said }; }
      row.person = personKey(row.name);
      return { a: 'batch', ops: [
        { a: 'add', tab: 'people', row: { key: row.person, name: row.name, email: row.email } },
        { a: 'add', tab: 'crew', row: row, log: said }] };
    }

    // Production (or Elliot) puts a name against a role that's missing. Elliot then gives them a link.
    if (a === 'add_booking') {
      if (!admin && !isProd(me)) return { error: 'Only production or Elliot books crew.' };
      var bn = clean(op.name, 60), br = clean(op.role, 60);
      if (!bn || !br) return { error: 'Name & role needed.' };
      return { a: 'add', tab: 'bookings', log: 'booked ' + bn + ' as ' + br,
        row: { name: bn, role: br, email: clean(op.email, 120), phone: clean(op.phone, 40), by: '@me', time: '@now' } };
    }

    if (a === 'give_booking') {
      if (!admin) return { error: 'Only Elliot makes links.' };
      var bk = find(S.bookings, op.id);
      if (!bk) return { error: 'That booking has gone. Pull to refresh.' };
      var made = translate({ a: 'add_crew', name: bk.name, role: bk.role, email: bk.email, phone: bk.phone, dept: deptFor(bk.role) }, S);
      if (!made || made.error) return made;
      var del = { a: 'del', tab: 'bookings', id: bk.id };
      return { a: 'batch', ops: (made.a === 'batch' ? made.ops : [made]).concat([del]) };
    }

    if (a === 'give_link') {
      if (!admin) return { error: 'Only Elliot makes links.' };
      if (S.v === 'pipe-1') return { error: 'Paste the new script first.' };
      var cw = (S.crew || []).filter(function (x) { return x.key === op.key; })[0];
      if (!cw) return { error: 'They\'ve gone. Pull to refresh.' };
      if (cw.person) return null;
      var kn = findPerson(S, cw.name, cw.email);
      if (kn) return { a: 'set', tab: 'crew', id: cw.key, fields: { person: kn.key }, log: 'one link for ' + cw.name };
      var pk = personKey(cw.name);
      return { a: 'batch', ops: [
        { a: 'add', tab: 'people', row: { key: pk, name: cw.name, email: cw.email } },
        { a: 'set', tab: 'crew', id: cw.key, fields: { person: pk }, log: 'one link for ' + cw.name }] };
    }

    if (a === 'set_job') {
      if (!admin) return { error: 'Only Elliot edits the job.' };
      var jch = {}, js = [];
      JOB_FIELDS.forEach(function (f) {
        var max = f === 'dp_notes' ? 20000 : 400;
        if (op.fields && op.fields[f] !== undefined && clean(op.fields[f], max) !== ((S.job || {})[f] || '')) {
          jch[f] = clean(op.fields[f], max);
          js.push(f === 'dp_notes' ? 'DP notes updated' : f + ' → "' + jch[f] + '"');
        }
      });
      if (!js.length) return null;
      return { a: 'set', tab: 'jobs', fields: jch, log: 'job ' + js.join(', ') };
    }

    return { error: 'Unknown action.' };
  }

  var api = { translate: translate, deptFor: deptFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HymnRules = api;
})(this);

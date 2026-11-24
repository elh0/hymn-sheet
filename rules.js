/* Hymn Sheet rules: turns what someone did on the page into a plain Sheet op
 * for the backend pipe (backend/Code.gs). New features and rule changes go
 * here, so the Apps Script never needs pasting again.
 * translate(op, S) returns a backend op, null (nothing changed) or {error}. */
(function (root) {
  'use strict';

  var CREW_ITEM_FIELDS = ['qty', 'supplier', 'owner', 'notes'];
  var ADMIN_ITEM_FIELDS = ['dept', 'item', 'qty', 'supplier', 'owner', 'notes', 'asked_by'];
  var JOB_FIELDS = ['title', 'dates', 'start', 'call', 'location', 'prep', 'deck', 'notes', 'dp_notes'];

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

  function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  function clean(s, n) { return String(s === undefined || s === null ? '' : s).trim().slice(0, n || 300); }
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
      return { a: 'set', tab: 'items', id: ti.id, fields: tf, log: (ti[field] ? 'un' : '') + field + ' ' + ti.item };
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
      return { a: 'set', tab: 'tasks', id: t.id, fields: { done: '@toggle', updated: '@now' },
        log: (t.done ? 'reopened: ' : 'done: ') + t.task + (same(t.who, me.name) ? '' : ' (' + t.who + '\'s)') };
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

  var api = { translate: translate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HymnRules = api;
})(this);
